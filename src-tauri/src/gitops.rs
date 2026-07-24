use crate::error::{AppError, AppResult};
use crate::util::{hide_console, redact_token};
use regex::Regex;
use serde::Serialize;
use std::fs;
use std::path::Path;
use std::process::Command;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    pub name: String,
    pub current: bool,
    pub upstream: Option<String>,
    pub ahead: Option<u64>,
    pub behind: Option<u64>,
    pub commit: String,
    pub subject: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphCommit {
    pub id: String,
    pub short_id: String,
    pub parents: Vec<String>,
    pub date: String,
    pub subject: String,
    pub refs: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoStatus {
    pub state: String,
    pub branch: Option<String>,
    pub dirty: Option<u64>,
    pub ahead: Option<u64>,
    pub behind: Option<u64>,
    pub last_commit: Option<String>,
    pub local_branches: Vec<BranchInfo>,
    pub remote_branches: Vec<BranchInfo>,
    pub graph: Vec<GraphCommit>,
    pub remote_refreshed: bool,
    pub remote_refresh_error: Option<String>,
}

#[derive(Clone)]
pub struct GitRunner {
    proxy: Option<String>,
    ssl_verify: bool,
    token: Option<String>,
}

impl GitRunner {
    pub fn new(proxy: Option<String>, ssl_verify: bool, token: Option<String>) -> Self {
        Self {
            proxy,
            ssl_verify,
            token,
        }
    }

    fn config_args(&self) -> Vec<String> {
        let mut args = Vec::new();
        if let Some(p) = &self.proxy {
            args.push("-c".into());
            args.push(format!("http.proxy={p}"));
        } else {
            args.push("-c".into());
            args.push("http.proxy=".into());
        }
        if !self.ssl_verify {
            args.push("-c".into());
            args.push("http.sslVerify=false".into());
        } else if cfg!(windows) {
            args.push("-c".into());
            args.push("http.sslBackend=schannel".into());
        }
        args
    }

    fn run(&self, cwd: Option<&Path>, args: &[&str]) -> AppResult<(String, String)> {
        let mut cmd = Command::new("git");
        hide_console(&mut cmd);
        for c in self.config_args() {
            cmd.arg(c);
        }
        for a in args {
            cmd.arg(a);
        }
        if let Some(dir) = cwd {
            cmd.current_dir(dir);
        }
        cmd.env("GIT_TERMINAL_PROMPT", "0");
        let output = cmd.output().map_err(|e| {
            AppError::with_detail(
                "GIT_SPAWN_FAILED",
                "无法启动 git，请确认已安装并加入 PATH。",
                e.to_string(),
            )
        })?;
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        let token = self.token.as_deref();
        if !output.status.success() {
            return Err(AppError::with_detail(
                "GIT_FAILED",
                "git 命令执行失败。",
                redact_token(&format!("{stderr}\n{stdout}"), token),
            ));
        }
        Ok((redact_token(&stdout, token), redact_token(&stderr, token)))
    }

    pub fn build_clone_url(full_name: &str, token: Option<&str>) -> String {
        let auth = token
            .filter(|t| !t.is_empty())
            .map(|t| format!("x-access-token:{t}@"))
            .unwrap_or_default();
        format!("https://{auth}github.com/{full_name}.git")
    }

    pub fn clone_repo(
        &self,
        full_name: &str,
        target: &Path,
        git_ref: Option<&str>,
        shallow: bool,
    ) -> AppResult<()> {
        if is_non_empty_dir(target) {
            return Err(AppError::new(
                "PATH_NOT_EMPTY",
                "目标目录已存在且非空，请更换目标路径；如需使用已有文件夹，请使用“链接本地文件夹”。",
            ));
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).ok();
        }
        let url = Self::build_clone_url(full_name, self.token.as_deref());
        let path_owned = target.to_string_lossy().into_owned();
        let mut owned: Vec<String> = vec!["clone".into()];
        if shallow {
            owned.push("--depth".into());
            owned.push("1".into());
        }
        if let Some(r) = git_ref.filter(|s| !s.is_empty()) {
            owned.push("--branch".into());
            owned.push(r.to_string());
        }
        owned.push(url);
        owned.push(path_owned);
        let arg_refs: Vec<&str> = owned.iter().map(|s| s.as_str()).collect();
        match self.run(None, &arg_refs) {
            Ok(_) => Ok(()),
            Err(e) => {
                // 清理半成品
                if target.exists() {
                    let _ = fs::remove_dir_all(target);
                }
                Err(e)
            }
        }
    }

    fn list_local_branches(&self, path: &Path) -> Vec<BranchInfo> {
        let Ok((output, _)) = self.run(
            Some(path),
            &[
                "for-each-ref",
                "--format=%(refname)\t%(refname:short)\t%(HEAD)\t%(upstream)\t%(upstream:short)\t%(objectname:short)\t%(subject)",
                "refs/heads",
            ],
        ) else {
            return vec![];
        };

        output
            .lines()
            .filter_map(|line| {
                let fields: Vec<_> = line.splitn(7, '\t').collect();
                if fields.len() != 7 {
                    return None;
                }
                let (ahead, behind) = if fields[3].is_empty() {
                    (None, None)
                } else {
                    let range = format!("{}...{}", fields[0], fields[3]);
                    self.run(Some(path), &["rev-list", "--left-right", "--count", &range])
                        .ok()
                        .and_then(|(counts, _)| {
                            let values: Vec<_> = counts.split_whitespace().collect();
                            (values.len() >= 2).then(|| {
                                (values[0].parse::<u64>().ok(), values[1].parse::<u64>().ok())
                            })
                        })
                        .unwrap_or((None, None))
                };
                Some(BranchInfo {
                    name: fields[1].to_string(),
                    current: fields[2] == "*",
                    upstream: (!fields[4].is_empty()).then(|| fields[4].to_string()),
                    ahead,
                    behind,
                    commit: fields[5].to_string(),
                    subject: fields[6].to_string(),
                })
            })
            .collect()
    }

    fn list_remote_branches(&self, path: &Path) -> Vec<BranchInfo> {
        let Ok((output, _)) = self.run(
            Some(path),
            &[
                "for-each-ref",
                "--format=%(refname:short)\t%(symref)\t%(objectname:short)\t%(subject)",
                "refs/remotes",
            ],
        ) else {
            return vec![];
        };

        output
            .lines()
            .filter_map(|line| {
                let fields: Vec<_> = line.splitn(4, '\t').collect();
                if fields.len() != 4 || !fields[1].is_empty() || fields[0].ends_with("/HEAD") {
                    return None;
                }
                Some(BranchInfo {
                    name: fields[0].to_string(),
                    current: false,
                    upstream: None,
                    ahead: None,
                    behind: None,
                    commit: fields[2].to_string(),
                    subject: fields[3].to_string(),
                })
            })
            .collect()
    }

    fn get_graph(&self, path: &Path) -> Vec<GraphCommit> {
        self.run(
            Some(path),
            &[
                "log",
                "--topo-order",
                "--decorate=short",
                "--date=short",
                "--pretty=format:%H%x1f%h%x1f%P%x1f%ad%x1f%s%x1f%D",
                "--all",
                "--max-count=80",
            ],
        )
        .ok()
        .map(|(output, _)| {
            output
                .lines()
                .filter_map(|line| {
                    let fields: Vec<_> = line.splitn(6, '\u{1f}').collect();
                    if fields.len() != 6 {
                        return None;
                    }
                    Some(GraphCommit {
                        id: fields[0].to_string(),
                        short_id: fields[1].to_string(),
                        parents: fields[2].split_whitespace().map(str::to_string).collect(),
                        date: fields[3].to_string(),
                        subject: fields[4].to_string(),
                        refs: fields[5]
                            .split(',')
                            .map(str::trim)
                            .filter(|value| !value.is_empty())
                            .map(str::to_string)
                            .collect(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
    }

    fn refresh_remote_refs(&self, path: &Path) -> AppResult<()> {
        self.run(
            Some(path),
            &[
                "-c",
                "http.lowSpeedLimit=1",
                "-c",
                "http.lowSpeedTime=12",
                "-c",
                "credential.interactive=never",
                "fetch",
                "--prune",
                "--no-tags",
                "origin",
            ],
        )?;
        Ok(())
    }

    pub fn get_clone_status(&self, path: &Path, refresh_remote: bool) -> RepoStatus {
        let unknown = RepoStatus {
            state: "unknown".into(),
            branch: None,
            dirty: None,
            ahead: None,
            behind: None,
            last_commit: None,
            local_branches: vec![],
            remote_branches: vec![],
            graph: vec![],
            remote_refreshed: false,
            remote_refresh_error: None,
        };
        if !path.exists() {
            return unknown;
        }
        let (remote_refreshed, remote_refresh_error) = if refresh_remote {
            match self.refresh_remote_refs(path) {
                Ok(()) => (true, None),
                Err(error) => (false, Some(error.detail.unwrap_or(error.message))),
            }
        } else {
            (false, None)
        };
        let branch = self
            .run(Some(path), &["rev-parse", "--abbrev-ref", "HEAD"])
            .ok()
            .map(|(o, _)| o.trim().to_string())
            .filter(|s| !s.is_empty() && s != "HEAD");
        let dirty = self
            .run(Some(path), &["status", "--porcelain"])
            .ok()
            .map(|(o, _)| o.lines().filter(|l| !l.trim().is_empty()).count() as u64);
        let (ahead, behind) = self
            .run(
                Some(path),
                &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
            )
            .ok()
            .and_then(|(o, _)| {
                let parts: Vec<_> = o.trim().split_whitespace().collect();
                if parts.len() >= 2 {
                    Some((parts[0].parse().ok(), parts[1].parse().ok()))
                } else {
                    None
                }
            })
            .unwrap_or((None, None));
        let last_commit = self
            .run(Some(path), &["log", "-1", "--pretty=%h %s"])
            .ok()
            .map(|(o, _)| o.trim().to_string())
            .filter(|s| !s.is_empty());
        let local_branches = self.list_local_branches(path);
        let remote_branches = self.list_remote_branches(path);
        let graph = self.get_graph(path);

        let dirty_n = dirty.unwrap_or(0);
        let state = if dirty_n > 0 {
            "dirty"
        } else if ahead.unwrap_or(0) > 0 {
            "ahead"
        } else if behind.unwrap_or(0) > 0 {
            "behind"
        } else if branch.is_some() {
            "clean"
        } else {
            "unknown"
        }
        .to_string();

        RepoStatus {
            state,
            branch,
            dirty,
            ahead,
            behind,
            last_commit,
            local_branches,
            remote_branches,
            graph,
            remote_refreshed,
            remote_refresh_error,
        }
    }

    pub fn push(&self, path: &Path) -> AppResult<()> {
        let has_upstream = self
            .run(
                Some(path),
                &[
                    "rev-parse",
                    "--abbrev-ref",
                    "--symbolic-full-name",
                    "@{upstream}",
                ],
            )
            .is_ok();
        if has_upstream {
            self.run(Some(path), &["push"])?;
        } else {
            let branch = self
                .run(Some(path), &["rev-parse", "--abbrev-ref", "HEAD"])?
                .0
                .trim()
                .to_string();
            self.run(Some(path), &["push", "-u", "origin", &branch])?;
        }
        Ok(())
    }

    pub fn pull(&self, path: &Path) -> AppResult<()> {
        self.run(Some(path), &["pull", "--ff-only"])?;
        Ok(())
    }

    /// 在目录中初始化 Git 仓库，并将未出生分支统一设为 main。
    pub fn initialize_repository(&self, path: &Path) -> AppResult<()> {
        if !path.exists() {
            fs::create_dir_all(path).map_err(|e| {
                AppError::with_detail("INTERNAL_ERROR", "创建本地目录失败。", e.to_string())
            })?;
        }
        if !path.is_dir() {
            return Err(AppError::new("BAD_REQUEST", "目标路径不是文件夹。"));
        }
        if !is_git_repo(path) {
            self.run(Some(path), &["init"])?;
            self.run(Some(path), &["symbolic-ref", "HEAD", "refs/heads/main"])?;
        }
        Ok(())
    }

    /// 将已有文件夹连接到指定 GitHub 仓库。不会下载、移动或覆盖文件。
    pub fn connect_existing_folder(
        &self,
        path: &Path,
        expected_full_name: &str,
        initialize: bool,
    ) -> AppResult<()> {
        if !path.exists() {
            return Err(AppError::new(
                "NOT_FOUND",
                "目标文件夹不存在；链接功能只支持已有文件夹。",
            ));
        }
        if !path.is_dir() {
            return Err(AppError::new("BAD_REQUEST", "目标路径不是文件夹。"));
        }
        if !is_git_repo(path) {
            if !initialize {
                return Err(AppError::new(
                    "LINK_NOT_GIT",
                    "该文件夹尚未初始化 Git 仓库。",
                ));
            }
            self.initialize_repository(path)?;
        }

        let (remotes, _) = self.run(Some(path), &["remote"])?;
        if remotes.lines().any(|remote| remote.trim() == "origin") {
            let (origin, _) = self.run(Some(path), &["remote", "get-url", "origin"])?;
            match parse_github_full_name(&origin) {
                Some(name) if name.eq_ignore_ascii_case(expected_full_name) => return Ok(()),
                Some(name) => {
                    return Err(AppError::with_detail(
                        "LINK_MISMATCH",
                        format!(
                            "该文件夹已连接到 {name}，与目标仓库 {expected_full_name} 不一致。"
                        ),
                        name,
                    ));
                }
                None => {
                    return Err(AppError::with_detail(
                        "LINK_NON_GITHUB_REMOTE",
                        "该文件夹的 origin 不是可识别的 GitHub 地址，请先确认远端配置。",
                        origin.trim(),
                    ));
                }
            }
        }

        let url = Self::build_clone_url(expected_full_name, self.token.as_deref());
        self.run(Some(path), &["remote", "add", "origin", &url])?;
        Ok(())
    }
}

pub fn is_non_empty_dir(path: &Path) -> bool {
    match fs::read_dir(path) {
        Ok(mut it) => it.next().is_some(),
        Err(_) => false,
    }
}

pub fn is_git_repo(path: &Path) -> bool {
    path.join(".git").exists()
}

/// 从 origin URL 解析 owner/repo；失败返回 None。
pub fn parse_github_full_name(url: &str) -> Option<String> {
    let u = url.trim();
    let re = Regex::new(
        r"(?i)(?:github\.com[:/]|github\.com/)(?P<owner>[^/\s]+)/(?P<repo>[^/\s]+?)(?:\.git)?/?$",
    )
    .ok()?;
    let caps = re.captures(u)?;
    let owner = caps.name("owner")?.as_str();
    let repo = caps.name("repo")?.as_str().trim_end_matches(".git");
    if owner.is_empty() || repo.is_empty() {
        return None;
    }
    Some(format!("{owner}/{repo}"))
}

/// 读取本地仓库 origin 对应的 full_name。
#[cfg(test)]
pub fn remote_full_name(path: &Path) -> AppResult<Option<String>> {
    if !is_git_repo(path) {
        return Ok(None);
    }
    let mut cmd = Command::new("git");
    hide_console(&mut cmd);
    let output = cmd
        .args(["-C"])
        .arg(path.as_os_str())
        .args(["remote", "get-url", "origin"])
        .output()
        .map_err(|e| {
            AppError::with_detail(
                "GIT_SPAWN_FAILED",
                "无法启动 git，请确认已安装并加入 PATH。",
                e.to_string(),
            )
        })?;
    if !output.status.success() {
        return Ok(None);
    }
    let url = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok(parse_github_full_name(&url))
}

pub fn current_branch(path: &Path) -> Option<String> {
    let mut cmd = Command::new("git");
    hide_console(&mut cmd);
    let output = cmd
        .args(["-C"])
        .arg(path.as_os_str())
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let b = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if b.is_empty() || b == "HEAD" {
        None
    } else {
        Some(b)
    }
}

pub fn remove_dir(path: &Path) -> AppResult<()> {
    if path.exists() {
        fs::remove_dir_all(path).map_err(|e| {
            AppError::with_detail("INTERNAL_ERROR", "删除本地目录失败", e.to_string())
        })?;
    }
    Ok(())
}

pub fn open_in_explorer(path: &Path) -> AppResult<()> {
    #[cfg(windows)]
    {
        Command::new("explorer.exe")
            .arg(path.as_os_str())
            .spawn()
            .map_err(|e| AppError::with_detail("INTERNAL_ERROR", "打开目录失败", e.to_string()))?;
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(path.as_os_str())
            .spawn()
            .map_err(|e| AppError::with_detail("INTERNAL_ERROR", "打开目录失败", e.to_string()))?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(path.as_os_str())
            .spawn()
            .map_err(|e| AppError::with_detail("INTERNAL_ERROR", "打开目录失败", e.to_string()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::GitRunner;
    use std::fs;
    use std::path::Path;
    use std::process::Command;

    fn git(path: &Path, args: &[&str]) {
        let output = Command::new("git")
            .args(args)
            .current_dir(path)
            .output()
            .expect("git should be available");
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn clone_status_contains_local_and_remote_branch_tips() {
        let root = std::env::temp_dir().join(format!("git-mng-status-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create test repository");
        git(&root, &["init"]);
        git(&root, &["config", "user.name", "git-mng test"]);
        git(&root, &["config", "user.email", "git-mng@example.invalid"]);
        fs::write(root.join("README.md"), "branch status test\n").expect("write fixture");
        git(&root, &["add", "README.md"]);
        git(&root, &["commit", "-m", "initial commit"]);
        git(&root, &["branch", "-M", "main"]);
        git(&root, &["branch", "feature"]);
        git(&root, &["update-ref", "refs/remotes/origin/main", "HEAD"]);

        let status = GitRunner::new(None, true, None).get_clone_status(&root, false);
        assert_eq!(status.branch.as_deref(), Some("main"));
        assert!(status
            .local_branches
            .iter()
            .any(|branch| branch.name == "main" && branch.current));
        assert!(status
            .local_branches
            .iter()
            .any(|branch| branch.name == "feature"));
        assert!(status
            .remote_branches
            .iter()
            .any(|branch| branch.name == "origin/main"));
        assert!(status
            .graph
            .iter()
            .any(|commit| commit.subject == "initial commit"));

        fs::remove_dir_all(root).expect("remove test repository");
    }

    #[test]
    fn link_folder_can_initialize_git_and_add_origin() {
        let root = std::env::temp_dir().join(format!("git-mng-link-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create link folder");
        fs::write(root.join("notes.txt"), "keep me\n").expect("write existing file");
        let runner = GitRunner::new(None, true, None);

        let error = runner
            .connect_existing_folder(&root, "octocat/hello-world", false)
            .expect_err("uninitialized folder should require confirmation");
        assert_eq!(error.code, "LINK_NOT_GIT");

        runner
            .connect_existing_folder(&root, "octocat/hello-world", true)
            .expect("initialize and link folder");
        assert!(root.join(".git").exists());
        assert_eq!(
            super::remote_full_name(&root).expect("read origin"),
            Some("octocat/hello-world".into())
        );
        assert!(
            root.join("notes.txt").exists(),
            "existing files must be kept"
        );

        let symbolic_head = Command::new("git")
            .args(["symbolic-ref", "--short", "HEAD"])
            .current_dir(&root)
            .output()
            .expect("read symbolic head");
        assert_eq!(
            String::from_utf8_lossy(&symbolic_head.stdout).trim(),
            "main"
        );
        fs::remove_dir_all(root).expect("remove link folder");
    }
}
