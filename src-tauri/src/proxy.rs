use crate::error::AppResult;
use crate::store::Settings;
use crate::util::hide_console;
use std::process::Command;

/// 解析当前应使用的代理 URL；无代理返回 None。
pub fn resolve_proxy(settings: &Settings) -> AppResult<Option<String>> {
    match settings.proxy_mode.as_str() {
        "none" => Ok(None),
        "custom" => {
            let p = settings.custom_proxy.trim();
            if p.is_empty() {
                Ok(None)
            } else {
                Ok(Some(normalize_proxy(p)))
            }
        }
        _ => Ok(detect_system_proxy()),
    }
}

fn normalize_proxy(raw: &str) -> String {
    let t = raw.trim();
    if t.contains("://") {
        t.to_string()
    } else {
        format!("http://{t}")
    }
}

fn detect_system_proxy() -> Option<String> {
    #[cfg(windows)]
    {
        if let Some(p) = detect_windows_proxy() {
            return Some(p);
        }
    }
    for key in ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"] {
        if let Ok(v) = std::env::var(key) {
            let t = v.trim();
            if !t.is_empty() {
                return Some(normalize_proxy(t));
            }
        }
    }
    None
}

#[cfg(windows)]
fn detect_windows_proxy() -> Option<String> {
    let mut cmd = Command::new("reg");
    hide_console(&mut cmd);
    let output = cmd
        .args([
            "query",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut enable = false;
    let mut server = String::new();
    for line in text.lines() {
        let line = line.trim();
        if line.contains("ProxyEnable") {
            enable = line.contains("0x1") || line.ends_with("1");
        }
        if line.contains("ProxyServer") {
            if let Some(idx) = line.rfind("REG_SZ") {
                server = line[idx + 6..].trim().to_string();
            }
        }
    }
    if !enable || server.is_empty() {
        return None;
    }
    // 协议分写：https=host:port;http=...
    if server.contains('=') {
        let mut https = None;
        let mut http = None;
        let mut socks = None;
        for part in server.split(';') {
            let part = part.trim();
            if let Some((k, v)) = part.split_once('=') {
                match k.trim().to_ascii_lowercase().as_str() {
                    "https" => https = Some(v.trim().to_string()),
                    "http" => http = Some(v.trim().to_string()),
                    "socks" => socks = Some(v.trim().to_string()),
                    _ => {}
                }
            }
        }
        let chosen = https.or(http).or(socks)?;
        return Some(normalize_proxy(&chosen));
    }
    Some(normalize_proxy(&server))
}
