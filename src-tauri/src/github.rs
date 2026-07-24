use crate::error::{AppError, AppResult};
use crate::http::{build_client, send_with_retry};
use crate::store::Settings;
use crate::util::redact_token;
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, USER_AGENT};
use serde::Deserialize;
use serde_json::{json, Value};

const API_BASE: &str = "https://api.github.com";
const API_VERSION: &str = "2022-11-28";

#[derive(Debug, Clone, Deserialize, serde::Serialize)]
pub struct GhUser {
    pub login: String,
    pub avatar_url: String,
    pub name: Option<String>,
    pub html_url: String,
}

#[derive(Debug, Deserialize)]
struct GhRepo {
    name: String,
    full_name: String,
    private: bool,
    description: Option<String>,
    language: Option<String>,
    stargazers_count: u64,
    forks_count: u64,
    default_branch: String,
    updated_at: String,
    html_url: String,
    owner: GhOwner,
}

#[derive(Debug, Deserialize)]
struct GhOwner {
    login: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoItem {
    pub name: String,
    pub full_name: String,
    pub owner: String,
    pub private: bool,
    pub description: Option<String>,
    pub language: Option<String>,
    pub stars: u64,
    pub forks: u64,
    pub default_branch: String,
    pub updated_at: String,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cloned: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_paths: Option<usize>,
}

impl From<GhRepo> for RepoItem {
    fn from(r: GhRepo) -> Self {
        Self {
            name: r.name,
            full_name: r.full_name,
            owner: r.owner.login,
            private: r.private,
            description: r.description,
            language: r.language,
            stars: r.stargazers_count,
            forks: r.forks_count,
            default_branch: r.default_branch,
            updated_at: r.updated_at,
            url: r.html_url,
            cloned: None,
            local_paths: None,
        }
    }
}

pub struct GitHubClient {
    token: String,
    client: reqwest::Client,
}

impl GitHubClient {
    pub fn new(token: &str, settings: &Settings) -> AppResult<Self> {
        Ok(Self {
            token: token.to_string(),
            client: build_client(settings)?,
        })
    }

    fn headers(&self) -> AppResult<HeaderMap> {
        let mut h = HeaderMap::new();
        h.insert(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {}", self.token))
                .map_err(|_| AppError::new("BAD_REQUEST", "token 含非法字符"))?,
        );
        h.insert(USER_AGENT, HeaderValue::from_static("git-mng"));
        h.insert(
            "Accept",
            HeaderValue::from_static("application/vnd.github+json"),
        );
        h.insert(
            "X-GitHub-Api-Version",
            HeaderValue::from_static(API_VERSION),
        );
        Ok(h)
    }

    async fn request(
        &self,
        method: reqwest::Method,
        url: &str,
        body: Option<Value>,
    ) -> AppResult<Value> {
        let headers = self.headers()?;
        let body_clone = body.clone();
        let client = self.client.clone();
        let method2 = method.clone();
        let url2 = url.to_string();
        let res = send_with_retry(|| {
            let mut req = client
                .request(method2.clone(), &url2)
                .headers(headers.clone());
            if let Some(b) = body_clone.clone() {
                req = req.json(&b);
            }
            req.send()
        })
        .await
        .map_err(|e| map_fetch_error(e, &self.token))?;
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(map_http_error(status.as_u16(), &text, &self.token));
        }
        if text.is_empty() || status.as_u16() == 204 {
            return Ok(Value::Null);
        }
        serde_json::from_str(&text)
            .map_err(|e| AppError::with_detail("GH_HTTP", "解析 GitHub 响应失败", e.to_string()))
    }

    pub async fn get_user(&self) -> AppResult<GhUser> {
        let v = self
            .request(reqwest::Method::GET, &format!("{API_BASE}/user"), None)
            .await?;
        serde_json::from_value(v)
            .map_err(|e| AppError::with_detail("GH_HTTP", "解析用户信息失败", e.to_string()))
    }

    pub async fn list_my_repos(&self) -> AppResult<Vec<RepoItem>> {
        let mut page = 1u32;
        let mut all = Vec::new();
        loop {
            let url = format!(
                "{API_BASE}/user/repos?affiliation=owner&per_page=100&sort=updated&page={page}"
            );
            let v = self.request(reqwest::Method::GET, &url, None).await?;
            let batch: Vec<GhRepo> = serde_json::from_value(v).unwrap_or_default();
            let n = batch.len();
            all.extend(batch.into_iter().map(RepoItem::from));
            if n < 100 {
                break;
            }
            page += 1;
        }
        Ok(all)
    }

    pub async fn get_repo(&self, owner: &str, repo: &str) -> AppResult<RepoItem> {
        let value = self
            .request(
                reqwest::Method::GET,
                &format!("{API_BASE}/repos/{owner}/{repo}"),
                None,
            )
            .await?;
        let repo: GhRepo = serde_json::from_value(value).map_err(|error| {
            AppError::with_detail("GH_HTTP", "解析仓库信息失败", error.to_string())
        })?;
        Ok(RepoItem::from(repo))
    }

    pub async fn search_repos(
        &self,
        q: &str,
        sort: &str,
        page: u32,
    ) -> AppResult<(u64, Vec<RepoItem>)> {
        let url = format!(
            "{API_BASE}/search/repositories?q={}&sort={}&order=desc&per_page=30&page={}",
            urlencoding(q),
            urlencoding(sort),
            page.max(1)
        );
        let v = self.request(reqwest::Method::GET, &url, None).await?;
        let total = v.get("total_count").and_then(|x| x.as_u64()).unwrap_or(0);
        let items: Vec<GhRepo> =
            serde_json::from_value(v.get("items").cloned().unwrap_or(Value::Array(vec![])))
                .unwrap_or_default();
        Ok((total, items.into_iter().map(RepoItem::from).collect()))
    }

    pub async fn list_branches(&self, owner: &str, repo: &str) -> AppResult<Vec<String>> {
        self.list_names(&format!("{API_BASE}/repos/{owner}/{repo}/branches"))
            .await
    }

    pub async fn list_tags(&self, owner: &str, repo: &str) -> AppResult<Vec<String>> {
        self.list_names(&format!("{API_BASE}/repos/{owner}/{repo}/tags"))
            .await
    }

    async fn list_names(&self, base: &str) -> AppResult<Vec<String>> {
        let mut page = 1u32;
        let mut names = Vec::new();
        loop {
            let url = format!("{base}?per_page=100&page={page}");
            let v = self.request(reqwest::Method::GET, &url, None).await?;
            let arr = v.as_array().cloned().unwrap_or_default();
            let n = arr.len();
            for item in arr {
                if let Some(name) = item.get("name").and_then(|x| x.as_str()) {
                    names.push(name.to_string());
                }
            }
            if n < 100 {
                break;
            }
            page += 1;
        }
        Ok(names)
    }

    pub async fn create_repo(
        &self,
        name: &str,
        description: &str,
        private: bool,
    ) -> AppResult<RepoItem> {
        let v = self
            .request(
                reqwest::Method::POST,
                &format!("{API_BASE}/user/repos"),
                Some(json!({
                    "name": name,
                    "description": description,
                    "private": private,
                })),
            )
            .await?;
        let repo: GhRepo = serde_json::from_value(v)
            .map_err(|e| AppError::with_detail("GH_HTTP", "解析新建仓库失败", e.to_string()))?;
        Ok(RepoItem::from(repo))
    }

    pub async fn delete_repo(&self, owner: &str, repo: &str) -> AppResult<()> {
        self.request(
            reqwest::Method::DELETE,
            &format!("{API_BASE}/repos/{owner}/{repo}"),
            None,
        )
        .await?;
        Ok(())
    }

    pub async fn star(&self, owner: &str, repo: &str) -> AppResult<()> {
        self.request(
            reqwest::Method::PUT,
            &format!("{API_BASE}/user/starred/{owner}/{repo}"),
            None,
        )
        .await?;
        Ok(())
    }

    pub async fn unstar(&self, owner: &str, repo: &str) -> AppResult<()> {
        self.request(
            reqwest::Method::DELETE,
            &format!("{API_BASE}/user/starred/{owner}/{repo}"),
            None,
        )
        .await?;
        Ok(())
    }
}

fn urlencoding(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
}

fn map_fetch_error(err: reqwest::Error, token: &str) -> AppError {
    let msg = err.to_string();
    let detail = redact_token(&msg, Some(token));
    if msg.to_ascii_lowercase().contains("certificate")
        || msg.contains("SSL")
        || msg.contains("tls")
    {
        return AppError::with_detail(
            "GH_SSL",
            "SSL 证书校验失败：可能是企业代理/杀软拦截了证书。可在设置中开启「跳过 SSL 校验」（有风险），或配置正确代理。",
            detail,
        );
    }
    AppError::with_detail(
        "GH_NETWORK",
        "网络错误：无法连接 GitHub API。请检查网络，或在设置/登录页调整代理与 SSL。",
        detail,
    )
}

fn map_http_error(status: u16, body: &str, token: &str) -> AppError {
    let detail = redact_token(&body.chars().take(500).collect::<String>(), Some(token));
    let message = match status {
        401 => "GitHub 返回 401：token 无效或已过期，请重新登录。".to_string(),
        403 => "GitHub 返回 403：权限不足或触发速率限制。".to_string(),
        404 => "GitHub 返回 404：资源不存在或无访问权限。".to_string(),
        422 => "GitHub 返回 422：请求参数不合法（如仓库名已存在）。".to_string(),
        _ => format!("GitHub API 请求失败（HTTP {status}）。"),
    };
    AppError::with_detail("GH_HTTP", message, detail)
}
