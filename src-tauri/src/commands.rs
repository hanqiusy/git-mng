use crate::error::{AppError, AppResult};
use crate::github::{GhUser, GitHubClient};
use crate::gitops::{self, GitRunner};
use crate::oauth::{self, DevicePollOutcome, DeviceStartResult};
use crate::proxy::resolve_proxy;
use crate::state::AppState;
use crate::store::{ClonePath, Settings, SettingsPatch};
use crate::util::{normalize_clone_path, redact_token, require_non_empty};
use regex::Regex;
use serde::Deserialize;
use serde_json::json;
use std::path::PathBuf;
use tauri::State;

async fn require_token(state: &AppState) -> AppResult<String> {
    state
        .store
        .lock()
        .await
        .get_token()
        .ok_or_else(|| AppError::new("UNAUTHORIZED", "未登录或 token 已失效，请先登录。"))
}

async fn make_client(state: &AppState) -> AppResult<(GitHubClient, Settings)> {
    let (token, settings) = {
        let store = state.store.lock().await;
        let token = store
            .get_token()
            .ok_or_else(|| AppError::new("UNAUTHORIZED", "未登录或 token 已失效，请先登录。"))?;
        (token, store.get_settings())
    };
    let client = GitHubClient::new(&token, &settings)?;
    Ok((client, settings))
}

async fn make_runner(state: &AppState) -> AppResult<GitRunner> {
    let store = state.store.lock().await;
    let settings = store.get_settings();
    let token = store.get_token();
    let proxy = resolve_proxy(&settings)?;
    Ok(GitRunner::new(proxy, settings.ssl_verify, token))
}

async fn finish_login(state: &AppState, token: String) -> AppResult<GhUser> {
    let settings = state.store.lock().await.get_settings();
    let client = GitHubClient::new(&token, &settings)?;
    let user = match client.get_user().await {
        Ok(u) => u,
        Err(mut e) => {
            e.message = redact_token(&e.message, Some(&token));
            if let Some(d) = e.detail.take() {
                e.detail = Some(redact_token(&d, Some(&token)));
            }
            return Err(e);
        }
    };
    state.store.lock().await.upsert_account(
        &user.login,
        &user.avatar_url,
        user.name.clone(),
        &user.html_url,
        token,
    )?;
    state.log("login", &user.login, true, None).await;
    Ok(user)
}

#[tauri::command]
pub async fn auth_device_start(state: State<'_, AppState>) -> AppResult<DeviceStartResult> {
    let settings = state.store.lock().await.get_settings();
    let mut oauth = state.oauth.lock().await;
    oauth::start_device_flow(&mut oauth, &settings).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionArg {
    session_id: String,
}

#[tauri::command]
pub async fn auth_device_poll(
    state: State<'_, AppState>,
    args: SessionArg,
) -> AppResult<serde_json::Value> {
    let session_id = require_non_empty(&args.session_id, "sessionId")?;
    let settings = state.store.lock().await.get_settings();
    let outcome = {
        let mut oauth = state.oauth.lock().await;
        oauth::poll_device_flow(&mut oauth, &settings, &session_id).await?
    };
    match outcome {
        DevicePollOutcome::Pending { interval } => Ok(json!({
            "status": "pending",
            "interval": interval,
        })),
        DevicePollOutcome::SlowDown { interval } => Ok(json!({
            "status": "slow_down",
            "interval": interval,
        })),
        DevicePollOutcome::Ok { access_token } => {
            let user = finish_login(&state, access_token).await?;
            Ok(json!({ "status": "ok", "user": user }))
        }
    }
}

#[derive(Deserialize)]
pub struct LoginArg {
    token: String,
}

#[tauri::command]
pub async fn auth_login(
    state: State<'_, AppState>,
    args: LoginArg,
) -> AppResult<serde_json::Value> {
    let token = require_non_empty(&args.token, "token")?;
    let user = finish_login(&state, token).await?;
    Ok(json!({ "user": user }))
}

#[tauri::command]
pub async fn auth_logout(state: State<'_, AppState>) -> AppResult<serde_json::Value> {
    // 仅结束会话：保留用户数据目录中的 token，供一键/自动登录
    state.oauth.lock().await.clear();
    state.log("logout", "-", true, None).await;
    Ok(json!({ "ok": true }))
}

/// 清除全部已保存账号凭证。
#[tauri::command]
pub async fn auth_clear_credentials(state: State<'_, AppState>) -> AppResult<serde_json::Value> {
    state.oauth.lock().await.clear();
    state.store.lock().await.clear_all_accounts()?;
    state.log("clear_credentials", "-", true, None).await;
    Ok(json!({ "ok": true }))
}

/// 已保存账号列表（不含 token）。
#[tauri::command]
pub async fn auth_list_accounts(state: State<'_, AppState>) -> AppResult<serde_json::Value> {
    let store = state.store.lock().await;
    Ok(json!({
        "accounts": store.list_accounts_public(),
        "activeAccountId": store.active_account_id(),
        "autoLogin": store.get_settings().auto_login,
        "hasToken": store.get_token().is_some(),
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountIdArg {
    account_id: String,
}

/// 使用已保存账号建立会话（一键登录）。
#[tauri::command]
pub async fn auth_quick_login(
    state: State<'_, AppState>,
    args: AccountIdArg,
) -> AppResult<serde_json::Value> {
    let account_id = require_non_empty(&args.account_id, "accountId")?;
    let token = {
        let mut store = state.store.lock().await;
        store.switch_account(&account_id)?;
        store
            .token_for_account(&account_id)
            .ok_or_else(|| AppError::new("UNAUTHORIZED", "没有已保存的登录凭证。"))?
    };
    let user = finish_login(&state, token).await?;
    Ok(json!({ "user": user }))
}

/// 登录后切换已保存账号。
#[tauri::command]
pub async fn auth_switch_account(
    state: State<'_, AppState>,
    args: AccountIdArg,
) -> AppResult<serde_json::Value> {
    let account_id = require_non_empty(&args.account_id, "accountId")?;
    let token = {
        let mut store = state.store.lock().await;
        store.switch_account(&account_id)?;
        store
            .get_token()
            .ok_or_else(|| AppError::new("UNAUTHORIZED", "账号凭证无效。"))?
    };
    let settings = state.store.lock().await.get_settings();
    let client = GitHubClient::new(&token, &settings)?;
    let user = client.get_user().await?;
    state.store.lock().await.upsert_account(
        &user.login,
        &user.avatar_url,
        user.name.clone(),
        &user.html_url,
        token,
    )?;
    state.log("switch_account", &user.login, true, None).await;
    Ok(json!({ "user": user }))
}

#[tauri::command]
pub async fn auth_remove_account(
    state: State<'_, AppState>,
    args: AccountIdArg,
) -> AppResult<serde_json::Value> {
    let account_id = require_non_empty(&args.account_id, "accountId")?;
    state.store.lock().await.remove_account(&account_id)?;
    state.log("remove_account", &account_id, true, None).await;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn auth_me(state: State<'_, AppState>) -> AppResult<serde_json::Value> {
    let (client, _) = make_client(&state).await?;
    let user = client.get_user().await?;
    let token = require_token(&state).await?;
    state.store.lock().await.upsert_account(
        &user.login,
        &user.avatar_url,
        user.name.clone(),
        &user.html_url,
        token,
    )?;
    Ok(json!({ "user": user }))
}

#[derive(Deserialize)]
pub struct ListReposArg {
    visibility: Option<String>,
    q: Option<String>,
}

#[tauri::command]
pub async fn list_repos(
    state: State<'_, AppState>,
    args: ListReposArg,
) -> AppResult<serde_json::Value> {
    let (client, _) = make_client(&state).await?;
    let mut repos = client.list_my_repos().await?;
    let vis = args.visibility.unwrap_or_else(|| "all".into());
    repos.retain(|r| match vis.as_str() {
        "public" => !r.private,
        "private" => r.private,
        _ => true,
    });
    if let Some(q) = args.q.filter(|s| !s.trim().is_empty()) {
        let q = q.to_ascii_lowercase();
        repos.retain(|r| {
            r.name.to_ascii_lowercase().contains(&q)
                || r.full_name.to_ascii_lowercase().contains(&q)
                || r.description
                    .as_ref()
                    .map(|d| d.to_ascii_lowercase().contains(&q))
                    .unwrap_or(false)
        });
    }
    let store = state.store.lock().await;
    for r in &mut repos {
        let (cloned, n) = store.is_cloned(&r.full_name);
        r.cloned = Some(cloned);
        r.local_paths = Some(n);
    }
    Ok(json!({ "items": repos }))
}

#[derive(Deserialize)]
pub struct SearchArg {
    q: String,
    sort: Option<String>,
    page: Option<u32>,
}

#[tauri::command]
pub async fn search_repos(
    state: State<'_, AppState>,
    args: SearchArg,
) -> AppResult<serde_json::Value> {
    let q = require_non_empty(&args.q, "q")?;
    let (client, _) = make_client(&state).await?;
    let sort = args.sort.unwrap_or_else(|| "stars".into());
    let page = args.page.unwrap_or(1).max(1);
    let (total, items) = client.search_repos(&q, &sort, page).await?;
    Ok(json!({ "total": total, "page": page, "items": items }))
}

#[derive(Deserialize)]
pub struct OwnerRepo {
    owner: String,
    repo: String,
}

#[tauri::command]
pub async fn list_branches(
    state: State<'_, AppState>,
    args: OwnerRepo,
) -> AppResult<serde_json::Value> {
    let (client, _) = make_client(&state).await?;
    let names = client.list_branches(&args.owner, &args.repo).await?;
    let items: Vec<_> = names
        .into_iter()
        .map(|name| json!({ "name": name }))
        .collect();
    Ok(json!({ "items": items }))
}

#[tauri::command]
pub async fn list_tags(
    state: State<'_, AppState>,
    args: OwnerRepo,
) -> AppResult<serde_json::Value> {
    let (client, _) = make_client(&state).await?;
    let names = client.list_tags(&args.owner, &args.repo).await?;
    let items: Vec<_> = names
        .into_iter()
        .map(|name| json!({ "name": name }))
        .collect();
    Ok(json!({ "items": items }))
}

#[derive(Deserialize)]
pub struct CreateRepoArg {
    name: String,
    description: Option<String>,
    private: bool,
}

#[tauri::command]
pub async fn create_repo(
    state: State<'_, AppState>,
    args: CreateRepoArg,
) -> AppResult<serde_json::Value> {
    let name = require_non_empty(&args.name, "name")?;
    if !Regex::new(r"^[\w.-]+$").unwrap().is_match(&name) || name.trim_matches('.').is_empty() {
        return Err(AppError::new("BAD_REQUEST", "仓库名不合法"));
    }
    let (client, _) = make_client(&state).await?;
    let repo = client
        .create_repo(
            &name,
            args.description.as_deref().unwrap_or(""),
            args.private,
        )
        .await?;
    state.log("create_repo", &repo.full_name, true, None).await;
    Ok(json!({ "repo": repo }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateLinkedRepoArg {
    name: String,
    description: Option<String>,
    private: bool,
}

/// 在默认目录创建同名文件夹和 GitHub 空仓库，初始化 Git 并连接 origin。
#[tauri::command]
pub async fn create_linked_repo(
    state: State<'_, AppState>,
    args: CreateLinkedRepoArg,
) -> AppResult<serde_json::Value> {
    let name = require_non_empty(&args.name, "name")?;
    if !Regex::new(r"^[\w.-]+$").unwrap().is_match(&name) || name.trim_matches('.').is_empty() {
        return Err(AppError::new("BAD_REQUEST", "仓库名不合法"));
    }

    let (client, settings) = make_client(&state).await?;
    let path = normalize_clone_path(
        &PathBuf::from(&settings.default_clone_root)
            .join(&name)
            .to_string_lossy(),
    )?;
    let path_str = path.to_string_lossy().into_owned();
    if path.exists() {
        return Err(AppError::new(
            "PATH_EXISTS",
            "默认目录下已存在同名文件夹，请更换名称，或使用“链接本地文件夹”。",
        ));
    }
    if state.store.lock().await.path_registered(&path_str) {
        return Err(AppError::new("PATH_EXISTS", "该路径已在本地管理中登记。"));
    }

    let runner = make_runner(&state).await?;
    if let Err(error) = runner.initialize_repository(&path) {
        let _ = gitops::remove_dir(&path);
        return Err(error);
    }
    let repo = match client
        .create_repo(
            &name,
            args.description.as_deref().unwrap_or(""),
            args.private,
        )
        .await
    {
        Ok(repo) => repo,
        Err(error) => {
            let _ = gitops::remove_dir(&path);
            return Err(error);
        }
    };
    runner.connect_existing_folder(&path, &repo.full_name, false)?;

    let entry = ClonePath {
        path: path_str,
        git_ref: if repo.default_branch.trim().is_empty() {
            "main".into()
        } else {
            repo.default_branch.clone()
        },
        ref_type: "branch".into(),
        added_at: chrono::Utc::now().to_rfc3339(),
        status: None,
    };
    let record = state.store.lock().await.add_clone_path(
        &repo.owner,
        &repo.name,
        &repo.full_name,
        repo.private,
        entry,
    )?;
    state
        .log("create_linked_repo", &repo.full_name, true, None)
        .await;
    Ok(json!({ "repo": repo, "record": record }))
}

#[tauri::command]
pub async fn delete_repo(
    state: State<'_, AppState>,
    args: OwnerRepo,
) -> AppResult<serde_json::Value> {
    let (client, _) = make_client(&state).await?;
    let me = client.get_user().await?;
    if !me.login.eq_ignore_ascii_case(&args.owner) {
        return Err(AppError::new(
            "FORBIDDEN",
            "只能删除当前登录用户自己的远程仓库。",
        ));
    }
    client.delete_repo(&args.owner, &args.repo).await?;
    state
        .log(
            "delete_repo",
            &format!("{}/{}", args.owner, args.repo),
            true,
            None,
        )
        .await;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn star_repo(
    state: State<'_, AppState>,
    args: OwnerRepo,
) -> AppResult<serde_json::Value> {
    let (client, _) = make_client(&state).await?;
    client.star(&args.owner, &args.repo).await?;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn unstar_repo(
    state: State<'_, AppState>,
    args: OwnerRepo,
) -> AppResult<serde_json::Value> {
    let (client, _) = make_client(&state).await?;
    client.unstar(&args.owner, &args.repo).await?;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn list_clones(state: State<'_, AppState>) -> AppResult<serde_json::Value> {
    let runner = make_runner(&state).await?;
    let mut items = state.store.lock().await.list_clones();
    for entry in &mut items {
        for p in &mut entry.paths {
            let status = runner.get_clone_status(&PathBuf::from(&p.path), false);
            p.status = Some(serde_json::to_value(status).unwrap_or(json!({})));
        }
    }
    Ok(json!({ "items": items }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneArg {
    owner: String,
    repo: String,
    path: String,
    #[serde(rename = "ref")]
    git_ref: String,
    ref_type: String,
    shallow: bool,
    private: Option<bool>,
}

#[tauri::command]
pub async fn clone_repo(
    state: State<'_, AppState>,
    args: CloneArg,
) -> AppResult<serde_json::Value> {
    let _ = require_token(&state).await?;
    let owner = require_non_empty(&args.owner, "owner")?;
    let repo = require_non_empty(&args.repo, "repo")?;
    let path = normalize_clone_path(&args.path)?;
    let path_str = path.to_string_lossy().into_owned();
    let full_name = format!("{owner}/{repo}");

    {
        let store = state.store.lock().await;
        if store.path_registered(&path_str) {
            return Err(AppError::new(
                "PATH_EXISTS",
                "该路径已在克隆记录中，同一路径不能重复克隆。",
            ));
        }
    }
    if gitops::is_non_empty_dir(&path) {
        return Err(AppError::new(
            "PATH_NOT_EMPTY",
            "目标目录已存在且非空，请更换目标路径；如需使用已有文件夹，请使用“链接本地文件夹”。",
        ));
    }

    let runner = make_runner(&state).await?;
    runner.clone_repo(
        &full_name,
        &path,
        Some(args.git_ref.as_str()).filter(|s| !s.is_empty()),
        args.shallow,
    )?;

    let entry = ClonePath {
        path: path_str,
        git_ref: args.git_ref,
        ref_type: args.ref_type,
        added_at: chrono::Utc::now().to_rfc3339(),
        status: None,
    };
    let record = state.store.lock().await.add_clone_path(
        &owner,
        &repo,
        &full_name,
        args.private.unwrap_or(false),
        entry,
    )?;
    state.log("clone", &full_name, true, None).await;
    Ok(json!({ "record": record }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkFolderArg {
    owner: String,
    repo: String,
    path: String,
    initialize: bool,
}

/// 仅链接已有文件夹；未初始化 Git 时由前端二次确认后传 initialize=true。
#[tauri::command]
pub async fn link_local_folder(
    state: State<'_, AppState>,
    args: LinkFolderArg,
) -> AppResult<serde_json::Value> {
    let owner = require_non_empty(&args.owner, "owner")?;
    let repo = require_non_empty(&args.repo, "repo")?;
    let path = normalize_clone_path(&args.path)?;
    let path_str = path.to_string_lossy().into_owned();
    let (client, _) = make_client(&state).await?;
    let remote_repo = client.get_repo(&owner, &repo).await?;
    let full_name = remote_repo.full_name.clone();

    if state.store.lock().await.path_registered(&path_str) {
        return Err(AppError::new(
            "PATH_EXISTS",
            "该路径已在本地管理中登记，无需重复链接。",
        ));
    }

    let runner = make_runner(&state).await?;
    runner.connect_existing_folder(&path, &full_name, args.initialize)?;
    let git_ref = gitops::current_branch(&path).unwrap_or_else(|| "main".into());
    let entry = ClonePath {
        path: path_str,
        git_ref,
        ref_type: "branch".into(),
        added_at: chrono::Utc::now().to_rfc3339(),
        status: None,
    };
    let record = state.store.lock().await.add_clone_path(
        &remote_repo.owner,
        &remote_repo.name,
        &full_name,
        remote_repo.private,
        entry,
    )?;
    state.log("link_local_folder", &full_name, true, None).await;
    Ok(json!({ "record": record }))
}

#[derive(Deserialize)]
pub struct PathArg {
    path: String,
}

#[tauri::command]
pub async fn refresh_clone_status(
    state: State<'_, AppState>,
    args: PathArg,
) -> AppResult<serde_json::Value> {
    let path = normalize_clone_path(&args.path)?;
    let path_str = path.to_string_lossy().into_owned();
    let _ = state.store.lock().await.get_clone_path_entry(&path_str)?;
    let runner = make_runner(&state).await?;
    let status = tokio::task::spawn_blocking(move || runner.get_clone_status(&path, true))
        .await
        .map_err(|error| {
            AppError::with_detail(
                "INTERNAL_ERROR",
                "刷新远端分支状态失败。",
                error.to_string(),
            )
        })?;
    Ok(json!({ "status": status }))
}

#[tauri::command]
pub async fn delete_clone(
    state: State<'_, AppState>,
    args: PathArg,
) -> AppResult<serde_json::Value> {
    let path = normalize_clone_path(&args.path)?;
    let path_str = path.to_string_lossy().into_owned();
    {
        let store = state.store.lock().await;
        let _ = store.get_clone_path_entry(&path_str)?;
    }
    gitops::remove_dir(&path)?;
    state.store.lock().await.remove_clone_path(&path_str)?;
    state.log("delete_clone", &path_str, true, None).await;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn reclone(state: State<'_, AppState>, args: PathArg) -> AppResult<serde_json::Value> {
    let path = normalize_clone_path(&args.path)?;
    let path_str = path.to_string_lossy().into_owned();
    let (entry, cp) = state.store.lock().await.get_clone_path_entry(&path_str)?;

    gitops::remove_dir(&path)?;
    let runner = make_runner(&state).await?;
    runner.clone_repo(
        &entry.full_name,
        &path,
        Some(cp.git_ref.as_str()).filter(|s| !s.is_empty()),
        false,
    )?;
    state.log("reclone", &entry.full_name, true, None).await;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn push_repo(state: State<'_, AppState>, args: PathArg) -> AppResult<serde_json::Value> {
    let path = normalize_clone_path(&args.path)?;
    let path_str = path.to_string_lossy().into_owned();
    let _ = state.store.lock().await.get_clone_path_entry(&path_str)?;
    make_runner(&state).await?.push(&path)?;
    state.log("push", &path_str, true, None).await;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn pull_repo(state: State<'_, AppState>, args: PathArg) -> AppResult<serde_json::Value> {
    let path = normalize_clone_path(&args.path)?;
    let path_str = path.to_string_lossy().into_owned();
    let _ = state.store.lock().await.get_clone_path_entry(&path_str)?;
    make_runner(&state).await?.pull(&path)?;
    state.log("pull", &path_str, true, None).await;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn open_dir(args: PathArg) -> AppResult<serde_json::Value> {
    let path = normalize_clone_path(&args.path)?;
    gitops::open_in_explorer(&path)?;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn get_settings(state: State<'_, AppState>) -> AppResult<serde_json::Value> {
    let settings = state.store.lock().await.get_settings();
    Ok(json!({ "settings": settings }))
}

#[tauri::command]
pub async fn update_settings(
    state: State<'_, AppState>,
    patch: SettingsPatch,
) -> AppResult<serde_json::Value> {
    if let Some(ref p) = patch.custom_proxy {
        let t = p.trim();
        if !t.is_empty() && !Regex::new(r"^https?://\S+$").unwrap().is_match(t) {
            return Err(AppError::new(
                "BAD_REQUEST",
                "customProxy 需形如 http://host:port。",
            ));
        }
    }
    let settings = state.store.lock().await.update_settings(patch)?;
    Ok(json!({ "settings": settings }))
}

#[tauri::command]
pub async fn get_logs(state: State<'_, AppState>) -> AppResult<serde_json::Value> {
    let logs = state.logs.lock().await.list();
    Ok(json!({ "logs": logs }))
}
