use crate::error::{AppError, AppResult};
use crate::util::{hide_console, redact_token};
use regex::Regex;
use serde::Serialize;
use std::fs;
use std::path::Path;
use std::process::Command;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoStatus {
    pub state: String,
    pub branch: Option<String>,
    pub dirty: Option<u64>,
    pub ahead: Option<u64>,
    pub behind: Option<u64>,
    pub last_commit: Option<String>,
}

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
        Ok((
            redact_token(&stdout, token),
            redact_token(&stderr, token),
        ))
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
                "目标目录已存在。可选择关联该目录，或更换其他路径。",
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

    pub fn get_clone_status(&self, path: &Path) -> RepoStatus {
        let unknown = RepoStatus {
            state: "unknown".into(),
            branch: None,
            dirty: None,
            ahead: None,
            behind: None,
            last_commit: None,
        };
        if !path.exists() {
            return unknown;
        }
        let branch = self
            .run(Some(path), &["rev-parse", "--abbrev-ref", "HEAD"])
            .ok()
            .map(|(o, _)| o.trim().to_string())
            .filter(|s| !s.is_empty() && s != "HEAD");
        let dirty = self
            .run(Some(path), &["status", "--porcelain"])
            .ok()
            .map(|(o, _)| {
                o.lines()
                    .filter(|l| !l.trim().is_empty())
                    .count() as u64
            });
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
        }
    }

    pub fn push(&self, path: &Path) -> AppResult<()> {
        let has_upstream = self
            .run(
                Some(path),
                &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
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

/// 校验目录可关联到指定仓库。
pub fn assert_linkable(path: &Path, expected_full_name: &str) -> AppResult<()> {
    if !path.exists() {
        return Err(AppError::new("NOT_FOUND", "目标路径不存在，无法关联。"));
    }
    if !is_git_repo(path) {
        return Err(AppError::new(
            "LINK_NOT_GIT",
            "目标目录不是 git 仓库，无法关联。请更换路径或先清空后重新克隆。",
        ));
    }
    match remote_full_name(path)? {
        Some(name) if name.eq_ignore_ascii_case(expected_full_name) => Ok(()),
        Some(name) => Err(AppError::with_detail(
            "LINK_MISMATCH",
            format!("目录已存在，但远程仓库是 {name}，与当前要克隆的 {expected_full_name} 不一致。"),
            name,
        )),
        None => Err(AppError::new(
            "LINK_NO_REMOTE",
            "无法识别该目录的 GitHub 远程地址，请确认 origin 指向正确仓库后再关联。",
        )),
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
            .map_err(|e| {
                AppError::with_detail("INTERNAL_ERROR", "打开目录失败", e.to_string())
            })?;
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(path.as_os_str())
            .spawn()
            .map_err(|e| {
                AppError::with_detail("INTERNAL_ERROR", "打开目录失败", e.to_string())
            })?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(path.as_os_str())
            .spawn()
            .map_err(|e| {
                AppError::with_detail("INTERNAL_ERROR", "打开目录失败", e.to_string())
            })?;
    }
    Ok(())
}
