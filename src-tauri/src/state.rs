use crate::error::AppResult;
use crate::oauth::OAuthSessions;
use crate::store::Store;
use crate::util::redact_token;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub time: String,
    pub action: String,
    pub target: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

pub struct OpLog {
    entries: Vec<LogEntry>,
    max: usize,
}

impl OpLog {
    pub fn new(max: usize) -> Self {
        Self {
            entries: Vec::new(),
            max,
        }
    }

    pub fn add(&mut self, action: &str, target: &str, ok: bool, detail: Option<String>) {
        self.entries.insert(
            0,
            LogEntry {
                time: chrono::Utc::now().to_rfc3339(),
                action: action.to_string(),
                target: target.to_string(),
                ok,
                detail,
            },
        );
        if self.entries.len() > self.max {
            self.entries.truncate(self.max);
        }
    }

    pub fn list(&self) -> Vec<LogEntry> {
        self.entries.clone()
    }
}

pub struct AppState {
    pub store: Mutex<Store>,
    pub oauth: Mutex<OAuthSessions>,
    pub logs: Mutex<OpLog>,
}

impl AppState {
    pub fn new(data_dir: PathBuf) -> AppResult<Self> {
        let store = Store::open(&data_dir)?;
        Ok(Self {
            store: Mutex::new(store),
            oauth: Mutex::new(OAuthSessions::new()),
            logs: Mutex::new(OpLog::new(100)),
        })
    }

    pub async fn log(&self, action: &str, target: &str, ok: bool, detail: Option<&str>) {
        let token = self.store.lock().await.get_token();
        let target = redact_token(target, token.as_deref());
        let detail = detail.map(|d| redact_token(d, token.as_deref()));
        self.logs.lock().await.add(action, &target, ok, detail);
    }
}

/// 数据目录：系统用户应用数据目录（Windows `%APPDATA%\com.gitmng.desktop`）。
/// 可用 `GIT_MNG_DATA_DIR` 强制指定。
pub fn resolve_data_dir(app: &AppHandle) -> PathBuf {
    if let Ok(v) = std::env::var("GIT_MNG_DATA_DIR") {
        let t = v.trim();
        if !t.is_empty() {
            return PathBuf::from(t);
        }
    }

    let data = app.path().app_data_dir().unwrap_or_else(|_| {
        dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("com.gitmng.desktop")
    });

    // 若曾把 db.json 放在 exe 旁，迁回用户数据目录一次
    if let Some(exe_dir) = current_exe_dir() {
        migrate_db_if_needed(&exe_dir, &data);
    }

    data
}

fn current_exe_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
}

fn migrate_db_if_needed(from: &Path, to: &Path) {
    let src = from.join("db.json");
    let dst = to.join("db.json");
    if !src.exists() || dst.exists() {
        return;
    }
    if fs::create_dir_all(to).is_ok() {
        let _ = fs::copy(src, dst);
    }
}
