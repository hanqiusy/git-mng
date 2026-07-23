use crate::error::{AppError, AppResult};
use crate::http::{build_client, send_with_retry};
use crate::store::Settings;
use serde::Serialize;
use std::collections::HashMap;
use std::time::{Duration, Instant};
use uuid::Uuid;

const DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
pub const OAUTH_SCOPES: &str = "repo delete_repo read:org";
pub const DEFAULT_CLIENT_ID: &str = "Ov23liZ0dlqDmUz74G6L";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceStartResult {
    pub session_id: String,
    pub user_code: String,
    pub verification_uri: String,
    pub verification_uri_complete: String,
    pub interval: u64,
    pub expires_in: u64,
}

#[derive(Debug)]
struct DeviceSession {
    device_code: String,
    interval: u64,
    expires_at: Instant,
}

#[derive(Default)]
pub struct OAuthSessions {
    map: HashMap<String, DeviceSession>,
}

impl OAuthSessions {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn clear(&mut self) {
        self.map.clear();
    }
}

pub fn client_id() -> String {
    std::env::var("GIT_MNG_GITHUB_CLIENT_ID")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_CLIENT_ID.to_string())
}

async fn post_form(
    client: &reqwest::Client,
    url: &str,
    form: &[(&str, &str)],
) -> AppResult<serde_json::Value> {
    let form_owned: Vec<(String, String)> = form
        .iter()
        .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
        .collect();
    let client = client.clone();
    let url = url.to_string();
    let res = send_with_retry(|| {
        let form = form_owned.clone();
        client
            .post(&url)
            .header("Accept", "application/json")
            .header("Content-Type", "application/x-www-form-urlencoded")
            .form(&form)
            .send()
    })
    .await
    .map_err(|e| {
        AppError::with_detail(
            "OAUTH_NETWORK",
            "无法连接 GitHub 授权服务，请检查网络或代理。可在登录页展开「网络设置」调整代理。",
            e.to_string(),
        )
    })?;
    let status = res.status();
    let text = res.text().await.unwrap_or_default();
    let data: serde_json::Value = serde_json::from_str(&text).unwrap_or(serde_json::json!({}));
    if !status.is_success() {
        let desc = data
            .get("error_description")
            .and_then(|x| x.as_str())
            .unwrap_or(&text);
        return Err(AppError::with_detail(
            "OAUTH_HTTP",
            format!("GitHub 授权请求失败（HTTP {}）。", status.as_u16()),
            desc.chars().take(200).collect::<String>(),
        ));
    }
    Ok(data)
}

pub async fn start_device_flow(
    sessions: &mut OAuthSessions,
    settings: &Settings,
) -> AppResult<DeviceStartResult> {
    let cid = client_id();
    if cid.is_empty() {
        return Err(AppError::new(
            "OAUTH_CONFIG",
            "未配置 GitHub OAuth Client ID（GIT_MNG_GITHUB_CLIENT_ID）。",
        ));
    }
    let client = build_client(settings)?;
    let data = post_form(
        &client,
        DEVICE_CODE_URL,
        &[("client_id", cid.as_str()), ("scope", OAUTH_SCOPES)],
    )
    .await?;

    let device_code = data
        .get("device_code")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let user_code = data
        .get("user_code")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let verification_uri = data
        .get("verification_uri")
        .and_then(|x| x.as_str())
        .unwrap_or("https://github.com/login/device")
        .to_string();
    let expires_in = data
        .get("expires_in")
        .and_then(|x| x.as_u64())
        .unwrap_or(900);
    let interval = data
        .get("interval")
        .and_then(|x| x.as_u64())
        .unwrap_or(5)
        .max(5);

    if device_code.is_empty() || user_code.is_empty() {
        return Err(AppError::new(
            "OAUTH_HTTP",
            "GitHub 未返回有效的设备授权码，请确认 OAuth App 已启用 Device Flow。",
        ));
    }

    let verification_uri_complete = data
        .get("verification_uri_complete")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| {
            format!(
                "{verification_uri}?user_code={}",
                url::form_urlencoded::byte_serialize(user_code.as_bytes()).collect::<String>()
            )
        });

    let session_id = Uuid::new_v4().to_string();
    sessions.map.insert(
        session_id.clone(),
        DeviceSession {
            device_code,
            interval,
            expires_at: Instant::now() + Duration::from_secs(expires_in),
        },
    );

    Ok(DeviceStartResult {
        session_id,
        user_code,
        verification_uri,
        verification_uri_complete,
        interval,
        expires_in,
    })
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum DevicePollOutcome {
    #[serde(rename = "pending")]
    Pending { interval: u64 },
    #[serde(rename = "slow_down")]
    SlowDown { interval: u64 },
    #[serde(rename = "ok")]
    Ok { access_token: String },
}

pub async fn poll_device_flow(
    sessions: &mut OAuthSessions,
    settings: &Settings,
    session_id: &str,
) -> AppResult<DevicePollOutcome> {
    let Some(session) = sessions.map.get_mut(session_id) else {
        return Err(AppError::new(
            "OAUTH_SESSION",
            "授权会话不存在或已过期，请重新发起登录。",
        ));
    };
    if Instant::now() > session.expires_at {
        sessions.map.remove(session_id);
        return Err(AppError::new(
            "OAUTH_EXPIRED",
            "授权已超时，请重新发起登录。",
        ));
    }

    let cid = client_id();
    let device_code = session.device_code.clone();
    let client = build_client(settings)?;
    let data = post_form(
        &client,
        ACCESS_TOKEN_URL,
        &[
            ("client_id", &cid),
            ("device_code", &device_code),
            (
                "grant_type",
                "urn:ietf:params:oauth:grant-type:device_code",
            ),
        ],
    )
    .await?;

    if let Some(err) = data.get("error").and_then(|x| x.as_str()) {
        match err {
            "authorization_pending" => {
                let interval = session.interval;
                return Ok(DevicePollOutcome::Pending { interval });
            }
            "slow_down" => {
                session.interval += 5;
                let interval = session.interval;
                return Ok(DevicePollOutcome::SlowDown { interval });
            }
            "expired_token" => {
                sessions.map.remove(session_id);
                return Err(AppError::new(
                    "OAUTH_EXPIRED",
                    "授权已超时，请重新发起登录。",
                ));
            }
            "access_denied" => {
                sessions.map.remove(session_id);
                return Err(AppError::new("OAUTH_DENIED", "你已取消 GitHub 授权。"));
            }
            other => {
                sessions.map.remove(session_id);
                let desc = data
                    .get("error_description")
                    .and_then(|x| x.as_str())
                    .unwrap_or(other);
                return Err(AppError::new(
                    "OAUTH_FAILED",
                    format!("GitHub 授权失败：{desc}"),
                ));
            }
        }
    }

    let access_token = data
        .get("access_token")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    if access_token.is_empty() {
        return Err(AppError::new("OAUTH_HTTP", "GitHub 未返回 access_token。"));
    }
    sessions.map.remove(session_id);
    Ok(DevicePollOutcome::Ok { access_token })
}
