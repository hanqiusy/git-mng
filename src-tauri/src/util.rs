use crate::error::{AppError, AppResult};
use regex::Regex;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

/// Windows 下隐藏子进程控制台，避免 git/reg 等频繁闪窗。
pub fn hide_console(_cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        _cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

pub fn redact_token(text: &str, token: Option<&str>) -> String {
    let mut out = text.to_string();
    if let Some(t) = token {
        if !t.is_empty() {
            out = out.replace(t, "***");
        }
    }
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"(?i)x-access-token:[^@\s]+@").unwrap());
    re.replace_all(&out, "x-access-token:***@").into_owned()
}

/// 规范化克隆路径（不必已存在）；拒绝空路径与磁盘根。
pub fn normalize_clone_path(raw: &str) -> AppResult<PathBuf> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(AppError::new("INVALID_PATH", "克隆路径不能为空"));
    }
    let path = if Path::new(trimmed).is_absolute() {
        PathBuf::from(trimmed)
    } else {
        std::env::current_dir()
            .map_err(|e| AppError::with_detail("INVALID_PATH", "无法解析当前目录", e.to_string()))?
            .join(trimmed)
    };
    let resolved = normalize_path(&path);

    if is_disk_root(&resolved) {
        return Err(AppError::new(
            "INVALID_PATH",
            "不允许把磁盘根路径作为克隆目录",
        ));
    }
    Ok(resolved)
}

fn normalize_path(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn is_disk_root(path: &Path) -> bool {
    #[cfg(windows)]
    {
        let s = path.to_string_lossy();
        Regex::new(r"^[A-Za-z]:[\\/]?$")
            .unwrap()
            .is_match(s.trim_end_matches(['\\', '/']))
            || Regex::new(r"^[A-Za-z]:[\\/]$").unwrap().is_match(&s)
    }
    #[cfg(not(windows))]
    {
        path == Path::new("/")
    }
}

pub fn require_non_empty(value: &str, field: &str) -> AppResult<String> {
    let t = value.trim();
    if t.is_empty() {
        return Err(AppError::new(
            "BAD_REQUEST",
            format!("参数 {field} 不能为空"),
        ));
    }
    Ok(t.to_string())
}
