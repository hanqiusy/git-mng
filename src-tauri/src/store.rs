use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub proxy_mode: String,
    pub custom_proxy: String,
    pub ssl_verify: bool,
    pub default_clone_root: String,
    #[serde(default)]
    pub auto_login: bool,
}

impl Default for Settings {
    fn default() -> Self {
        let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
        Self {
            proxy_mode: "system".into(),
            custom_proxy: String::new(),
            ssl_verify: true,
            default_clone_root: home.join("github-clones").to_string_lossy().into_owned(),
            auto_login: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub login: String,
    pub avatar_url: String,
    pub name: Option<String>,
    pub html_url: String,
    pub token: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountPublic {
    pub id: String,
    pub login: String,
    pub avatar_url: String,
    pub name: Option<String>,
    pub html_url: String,
}

impl From<&Account> for AccountPublic {
    fn from(a: &Account) -> Self {
        Self {
            id: a.id.clone(),
            login: a.login.clone(),
            avatar_url: a.avatar_url.clone(),
            name: a.name.clone(),
            html_url: a.html_url.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClonePath {
    pub path: String,
    #[serde(rename = "ref")]
    pub git_ref: String,
    pub ref_type: String,
    pub added_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneEntry {
    pub owner: String,
    pub repo: String,
    pub full_name: String,
    pub private: bool,
    pub paths: Vec<ClonePath>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct LegacyProfile {
    login: Option<String>,
    avatar_url: Option<String>,
    name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Db {
    #[serde(default)]
    accounts: Vec<Account>,
    #[serde(default)]
    active_account_id: Option<String>,
    /// 旧版单 token，打开时迁移后清空
    #[serde(default)]
    token: Option<String>,
    #[serde(default)]
    saved_profile: LegacyProfile,
    settings: Settings,
    clones: Vec<CloneEntry>,
}

impl Default for Db {
    fn default() -> Self {
        Self {
            accounts: vec![],
            active_account_id: None,
            token: None,
            saved_profile: LegacyProfile::default(),
            settings: Settings::default(),
            clones: vec![],
        }
    }
}

pub struct Store {
    path: PathBuf,
    db: Db,
}

impl Store {
    pub fn open(data_dir: &Path) -> AppResult<Self> {
        fs::create_dir_all(data_dir).map_err(|e| {
            AppError::with_detail("INTERNAL_ERROR", "无法创建数据目录", e.to_string())
        })?;
        let path = data_dir.join("db.json");
        let mut db = if path.exists() {
            let text = fs::read_to_string(&path).map_err(|e| {
                AppError::with_detail("INTERNAL_ERROR", "读取 db.json 失败", e.to_string())
            })?;
            serde_json::from_str(&text).unwrap_or_default()
        } else {
            Db::default()
        };
        migrate_legacy(&mut db);
        let store = Self { path, db };
        store.persist()?;
        Ok(store)
    }

    fn persist(&self) -> AppResult<()> {
        let tmp = self.path.with_extension("json.tmp");
        let text = serde_json::to_string_pretty(&self.db).map_err(|e| {
            AppError::with_detail("INTERNAL_ERROR", "序列化 db 失败", e.to_string())
        })?;
        fs::write(&tmp, text)
            .map_err(|e| AppError::with_detail("INTERNAL_ERROR", "写入 db 失败", e.to_string()))?;
        fs::rename(&tmp, &self.path)
            .map_err(|e| AppError::with_detail("INTERNAL_ERROR", "提交 db 失败", e.to_string()))?;
        Ok(())
    }

    pub fn get_token(&self) -> Option<String> {
        let id = self.db.active_account_id.as_deref()?;
        self.db
            .accounts
            .iter()
            .find(|a| a.id == id)
            .map(|a| a.token.clone())
            .or_else(|| self.db.accounts.first().map(|a| a.token.clone()))
    }

    pub fn list_accounts_public(&self) -> Vec<AccountPublic> {
        self.db.accounts.iter().map(AccountPublic::from).collect()
    }

    pub fn active_account_id(&self) -> Option<String> {
        self.db
            .active_account_id
            .clone()
            .or_else(|| self.db.accounts.first().map(|a| a.id.clone()))
    }

    pub fn upsert_account(
        &mut self,
        login: &str,
        avatar_url: &str,
        name: Option<String>,
        html_url: &str,
        token: String,
    ) -> AppResult<AccountPublic> {
        if let Some(acc) = self
            .db
            .accounts
            .iter_mut()
            .find(|a| a.login.eq_ignore_ascii_case(login))
        {
            acc.avatar_url = avatar_url.to_string();
            acc.name = name;
            acc.html_url = html_url.to_string();
            acc.token = token;
            let id = acc.id.clone();
            self.db.active_account_id = Some(id);
            let out = AccountPublic::from(&*acc);
            self.persist()?;
            return Ok(out);
        }
        let account = Account {
            id: Uuid::new_v4().to_string(),
            login: login.to_string(),
            avatar_url: avatar_url.to_string(),
            name,
            html_url: html_url.to_string(),
            token,
        };
        self.db.active_account_id = Some(account.id.clone());
        let out = AccountPublic::from(&account);
        self.db.accounts.push(account);
        self.persist()?;
        Ok(out)
    }

    pub fn switch_account(&mut self, account_id: &str) -> AppResult<AccountPublic> {
        let acc = self
            .db
            .accounts
            .iter()
            .find(|a| a.id == account_id)
            .ok_or_else(|| AppError::new("NOT_FOUND", "账号不存在"))?;
        let out = AccountPublic::from(acc);
        self.db.active_account_id = Some(account_id.to_string());
        self.persist()?;
        Ok(out)
    }

    pub fn token_for_account(&self, account_id: &str) -> Option<String> {
        self.db
            .accounts
            .iter()
            .find(|a| a.id == account_id)
            .map(|a| a.token.clone())
    }

    pub fn remove_account(&mut self, account_id: &str) -> AppResult<()> {
        let before = self.db.accounts.len();
        self.db.accounts.retain(|a| a.id != account_id);
        if self.db.accounts.len() == before {
            return Err(AppError::new("NOT_FOUND", "账号不存在"));
        }
        if self.db.active_account_id.as_deref() == Some(account_id) {
            self.db.active_account_id = self.db.accounts.first().map(|a| a.id.clone());
        }
        self.persist()
    }

    pub fn clear_all_accounts(&mut self) -> AppResult<()> {
        self.db.accounts.clear();
        self.db.active_account_id = None;
        self.db.token = None;
        self.db.saved_profile = LegacyProfile::default();
        self.persist()
    }

    pub fn get_settings(&self) -> Settings {
        self.db.settings.clone()
    }

    pub fn update_settings(&mut self, patch: SettingsPatch) -> AppResult<Settings> {
        if let Some(m) = patch.proxy_mode {
            if !matches!(m.as_str(), "system" | "custom" | "none") {
                return Err(AppError::new("BAD_REQUEST", "proxyMode 无效"));
            }
            self.db.settings.proxy_mode = m;
        }
        if let Some(p) = patch.custom_proxy {
            self.db.settings.custom_proxy = p;
        }
        if let Some(v) = patch.ssl_verify {
            self.db.settings.ssl_verify = v;
        }
        if let Some(r) = patch.default_clone_root {
            self.db.settings.default_clone_root = r;
        }
        if let Some(a) = patch.auto_login {
            self.db.settings.auto_login = a;
        }
        self.persist()?;
        Ok(self.db.settings.clone())
    }

    pub fn list_clones(&self) -> Vec<CloneEntry> {
        self.db.clones.clone()
    }

    pub fn find_clone_by_path(&self, path: &str) -> Option<(usize, usize)> {
        for (i, entry) in self.db.clones.iter().enumerate() {
            for (j, p) in entry.paths.iter().enumerate() {
                if paths_equal(&p.path, path) {
                    return Some((i, j));
                }
            }
        }
        None
    }

    pub fn path_registered(&self, path: &str) -> bool {
        self.find_clone_by_path(path).is_some()
    }

    pub fn add_clone_path(
        &mut self,
        owner: &str,
        repo: &str,
        full_name: &str,
        private: bool,
        path: ClonePath,
    ) -> AppResult<CloneEntry> {
        if self.path_registered(&path.path) {
            return Err(AppError::new(
                "PATH_EXISTS",
                "该路径已在克隆记录中，同一路径不能重复克隆。",
            ));
        }
        if let Some(entry) = self
            .db
            .clones
            .iter_mut()
            .find(|c| c.full_name.eq_ignore_ascii_case(full_name))
        {
            entry.paths.push(path);
            let out = entry.clone();
            self.persist()?;
            return Ok(out);
        }
        let entry = CloneEntry {
            owner: owner.to_string(),
            repo: repo.to_string(),
            full_name: full_name.to_string(),
            private,
            paths: vec![path],
        };
        self.db.clones.push(entry.clone());
        self.persist()?;
        Ok(entry)
    }

    pub fn remove_clone_path(&mut self, path: &str) -> AppResult<()> {
        let Some((i, j)) = self.find_clone_by_path(path) else {
            return Err(AppError::new("NOT_FOUND", "该路径不在克隆记录中。"));
        };
        self.db.clones[i].paths.remove(j);
        if self.db.clones[i].paths.is_empty() {
            self.db.clones.remove(i);
        }
        self.persist()
    }

    pub fn get_clone_path_entry(&self, path: &str) -> AppResult<(CloneEntry, ClonePath)> {
        let Some((i, j)) = self.find_clone_by_path(path) else {
            return Err(AppError::new("NOT_FOUND", "该路径不在克隆记录中。"));
        };
        Ok((
            self.db.clones[i].clone(),
            self.db.clones[i].paths[j].clone(),
        ))
    }

    pub fn is_cloned(&self, full_name: &str) -> (bool, usize) {
        if let Some(e) = self
            .db
            .clones
            .iter()
            .find(|c| c.full_name.eq_ignore_ascii_case(full_name))
        {
            (true, e.paths.len())
        } else {
            (false, 0)
        }
    }
}

fn migrate_legacy(db: &mut Db) {
    if !db.accounts.is_empty() {
        db.token = None;
        return;
    }
    if let Some(token) = db.token.take() {
        if token.trim().is_empty() {
            return;
        }
        let login = db
            .saved_profile
            .login
            .clone()
            .unwrap_or_else(|| "github-user".into());
        let id = Uuid::new_v4().to_string();
        db.accounts.push(Account {
            id: id.clone(),
            login,
            avatar_url: db.saved_profile.avatar_url.clone().unwrap_or_default(),
            name: db.saved_profile.name.clone(),
            html_url: String::new(),
            token,
        });
        db.active_account_id = Some(id);
        db.saved_profile = LegacyProfile::default();
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPatch {
    pub proxy_mode: Option<String>,
    pub custom_proxy: Option<String>,
    pub ssl_verify: Option<bool>,
    pub default_clone_root: Option<String>,
    pub auto_login: Option<bool>,
}

fn paths_equal(a: &str, b: &str) -> bool {
    #[cfg(windows)]
    {
        a.replace('/', "\\")
            .eq_ignore_ascii_case(&b.replace('/', "\\"))
    }
    #[cfg(not(windows))]
    {
        a == b
    }
}
