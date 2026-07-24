use crate::error::{AppError, AppResult};
use crate::proxy::resolve_proxy;
use crate::store::Settings;
use std::time::Duration;

/// 统一构建带超时/代理的 HTTP 客户端，降低偶发连接失败。
pub fn build_client(settings: &Settings) -> AppResult<reqwest::Client> {
    let proxy = resolve_proxy(settings)?;
    let mut builder = reqwest::Client::builder()
        .user_agent("git-mng")
        .timeout(Duration::from_secs(45))
        .connect_timeout(Duration::from_secs(20))
        .pool_idle_timeout(Duration::from_secs(30))
        .tcp_keepalive(Duration::from_secs(30));

    if !settings.ssl_verify {
        builder = builder.danger_accept_invalid_certs(true);
    }
    if let Some(p) = proxy {
        let proxy = reqwest::Proxy::all(&p)
            .map_err(|e| AppError::with_detail("BAD_REQUEST", "代理地址无效", e.to_string()))?;
        builder = builder.proxy(proxy);
    } else {
        builder = builder.no_proxy();
    }
    builder
        .build()
        .map_err(|e| AppError::with_detail("INTERNAL_ERROR", "创建 HTTP 客户端失败", e.to_string()))
}

pub async fn send_with_retry<F, Fut>(mut attempt: F) -> Result<reqwest::Response, reqwest::Error>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<reqwest::Response, reqwest::Error>>,
{
    let mut last = None;
    for i in 0..3 {
        match attempt().await {
            Ok(res) => return Ok(res),
            Err(e) => {
                let retryable =
                    e.is_timeout() || e.is_connect() || e.is_request() || e.status().is_none();
                last = Some(e);
                if !retryable || i == 2 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(400 * (i as u64 + 1))).await;
            }
        }
    }
    Err(last.expect("retry loop"))
}
