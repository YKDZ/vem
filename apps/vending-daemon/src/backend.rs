use std::sync::Arc;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

#[derive(Debug, Clone)]
pub struct BackendClient {
    base_url: String,
    client: reqwest::Client,
    token: Arc<RwLock<Option<String>>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteOp {
    pub id: String,
    #[serde(rename = "type")]
    pub op_type: String,
    pub status: String,
    pub requested_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaymentCodeSubmitBody {
    pub machine_code: String,
    pub auth_code: String,
    pub idempotency_key: String,
    pub source: String,
    pub scanner_health: Option<vending_core::scanner::ScannerHealthSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogExportResultPayload {
    pub file_name: String,
    pub content_type: String,
    pub base64: String,
    pub size_bytes: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StockMovementUploadResponse {
    pub movement_id: String,
    pub status: String,
    pub accepted_at: Option<String>,
    pub receipt: Option<serde_json::Value>,
    pub rejection: Option<serde_json::Value>,
}

impl BackendClient {
    pub fn new(base_url: impl Into<String>) -> Self {
        let base_url = base_url.into().trim_end_matches('/').to_string();
        Self {
            base_url,
            client: reqwest::Client::new(),
            token: Arc::new(RwLock::new(None)),
        }
    }

    fn endpoint(&self, path: &str) -> String {
        let trimmed = path.trim_start_matches('/');
        format!("{}/{}", self.base_url, trimmed)
    }

    async fn request_json(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<serde_json::Value>,
        with_auth: bool,
    ) -> Result<serde_json::Value, String> {
        let mut request = self.client.request(method, self.endpoint(path));
        if with_auth {
            let token = self.token.read().await.clone();
            if let Some(token) = token {
                request = request.bearer_auth(token);
            }
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request
            .send()
            .await
            .map_err(|error| format!("backend request failed: {error}"))?;
        let status = response.status();
        let payload = response
            .text()
            .await
            .map_err(|error| format!("backend read response failed: {error}"))?;

        if !status.is_success() {
            return Err(match status.as_u16() {
                401 | 403 => "BACKEND_AUTH_FAILED".to_string(),
                502..=504 => "BACKEND_OFFLINE".to_string(),
                _ => format!("BACKEND_HTTP_ERROR: {status} {payload}"),
            });
        }
        if payload.is_empty() {
            return Ok(serde_json::Value::Null);
        }
        serde_json::from_str(&payload)
            .map_err(|error| format!("backend json parse failed: {error}"))
    }

    pub async fn request_json_typed<T>(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<serde_json::Value>,
        with_auth: bool,
    ) -> Result<T, String>
    where
        T: DeserializeOwned,
    {
        let value = self.request_json(method, path, body, with_auth).await?;
        serde_json::from_value(value)
            .map_err(|error| format!("backend response parse failed: {error}"))
    }

    pub async fn authenticate(
        &self,
        machine_code: &str,
        machine_secret: &str,
    ) -> Result<(), String> {
        let body = serde_json::json!({
            "machineCode": machine_code,
            "machineSecret": machine_secret,
        });
        let value = self
            .request_json(
                reqwest::Method::POST,
                "/machine-auth/token",
                Some(body),
                false,
            )
            .await?;
        let access_token = value
            .get("accessToken")
            .or_else(|| value.get("access_token"))
            .and_then(|value| value.as_str());
        let token = match access_token {
            Some(value) => value.to_string(),
            None => {
                return Err("machine auth response missing access token".to_string());
            }
        };

        *self.token.write().await = Some(token);
        Ok(())
    }

    pub async fn create_order(
        &self,
        machine_code: &str,
        items: Vec<serde_json::Value>,
        payment_method: &str,
        payment_provider_code: Option<&str>,
        profile_snapshot: Option<serde_json::Value>,
    ) -> Result<serde_json::Value, String> {
        let body = serde_json::json!({
            "machineCode": machine_code,
            "items": items,
            "paymentMethod": payment_method,
            "paymentProviderCode": payment_provider_code,
            "profileSnapshot": profile_snapshot,
        });
        self.request_json(reqwest::Method::POST, "/machine-orders", Some(body), true)
            .await
    }

    pub async fn get_order_status(
        &self,
        machine_code: &str,
        order_no: &str,
    ) -> Result<serde_json::Value, String> {
        let url = format!("/machine-orders/{order_no}/status");
        let value: serde_json::Value = self
            .request_json(reqwest::Method::GET, &url, None, true)
            .await?;
        if value.get("machineCode").is_none() {
            return Ok(value);
        }
        if let Some(machine) = value.get("machineCode").and_then(|value| value.as_str()) {
            if machine != machine_code {
                return Err("BACKEND_CONTRACT_INVALID".to_string());
            }
        }
        Ok(value)
    }

    pub async fn submit_payment_code(
        &self,
        machine_code: &str,
        order_no: &str,
        auth_code: &str,
        idempotency_key: &str,
        source: &str,
        scanner_health: Option<&vending_core::scanner::ScannerHealthSnapshot>,
    ) -> Result<serde_json::Value, String> {
        let url = format!("/machine-orders/{order_no}/payment-code/submit");
        let body = serde_json::json!({
            "machineCode": machine_code,
            "authCode": auth_code,
            "idempotencyKey": idempotency_key,
            "source": source,
            "scannerHealth": scanner_health,
        });
        self.request_json(reqwest::Method::POST, &url, Some(body), true)
            .await
    }

    pub async fn list_pending_remote_ops(&self) -> Result<Vec<RemoteOp>, String> {
        let value = self
            .request_json(reqwest::Method::GET, "/machine-ops/pending", None, true)
            .await?;
        serde_json::from_value(value)
            .map_err(|error| format!("remote ops response invalid: {error}"))
    }

    pub async fn complete_log_export(
        &self,
        op_id: &str,
        payload: &LogExportResultPayload,
    ) -> Result<(), String> {
        let url = format!("/machine-ops/{op_id}/complete-log-export");
        self.request_json(
            reqwest::Method::POST,
            &url,
            Some(serde_json::to_value(payload).map_err(|error| {
                format!("serialize complete log export payload failed: {error}")
            })?),
            true,
        )
        .await?;
        Ok(())
    }

    pub async fn fail_remote_op(&self, op_id: &str, reason: &str) -> Result<(), String> {
        let url = format!("/machine-ops/{op_id}/fail");
        self.request_json(
            reqwest::Method::POST,
            &url,
            Some(serde_json::json!({ "reason": reason })),
            true,
        )
        .await?;
        Ok(())
    }

    pub async fn get_catalog(&self, machine_code: &str) -> Result<serde_json::Value, String> {
        let url = format!("/machines/{machine_code}/catalog");
        self.request_json(reqwest::Method::GET, &url, None, true)
            .await
    }

    pub async fn get_published_planogram(
        &self,
        machine_code: &str,
    ) -> Result<serde_json::Value, String> {
        let url = format!("/machines/{machine_code}/planogram-versions/published");
        self.request_json(reqwest::Method::GET, &url, None, true)
            .await
    }

    pub async fn acknowledge_planogram(
        &self,
        machine_code: &str,
        planogram_version: &str,
    ) -> Result<serde_json::Value, String> {
        let url = format!("/machines/{machine_code}/planogram-versions/{planogram_version}/ack");
        self.request_json(reqwest::Method::POST, &url, None, true)
            .await
    }

    pub async fn get_payment_options(&self) -> Result<serde_json::Value, String> {
        self.request_json(
            reqwest::Method::GET,
            "/machine-orders/payment-options",
            None,
            true,
        )
        .await
    }

    pub async fn submit_stock_movement_upload(
        &self,
        payload: &serde_json::Value,
    ) -> Result<StockMovementUploadResponse, String> {
        self.request_json_typed(
            reqwest::Method::POST,
            "/machine-stock-movements",
            Some(payload.clone()),
            true,
        )
        .await
    }

    pub async fn mark_mock_payment(
        &self,
        order_no: &str,
        succeed: bool,
    ) -> Result<serde_json::Value, String> {
        let suffix = if succeed { "succeed" } else { "fail" };
        let url = format!("/machine-orders/{order_no}/mock-payment/{suffix}");
        self.request_json(reqwest::Method::POST, &url, None, true)
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{body_partial_json, header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn backend_auth_sets_bearer_token() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/machine-auth/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "accessToken": "token-123",
            })))
            .mount(&server)
            .await;

        let _protected = Mock::given(method("GET"))
            .and(path("/machine-orders"))
            .and(header("authorization", "Bearer token-123"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"ok":true})))
            .mount(&server)
            .await;

        let client = BackendClient::new(server.uri());
        client.authenticate("M-1", "S-1").await.expect("auth");

        let response = client
            .request_json(reqwest::Method::GET, "/machine-orders", None, true)
            .await
            .expect("request");
        assert_eq!(response["ok"], true);
    }

    #[tokio::test]
    async fn backend_get_catalog_uses_bearer_auth() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/machine-auth/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "accessToken": "token-123",
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/machines/M-1/catalog"))
            .and(header("authorization", "Bearer token-123"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "items": [],
                "source": "backend",
            })))
            .mount(&server)
            .await;

        let client = BackendClient::new(server.uri());
        client.authenticate("M-1", "S-1").await.expect("auth");
        let response = client.get_catalog("M-1").await.expect("catalog");
        assert_eq!(response["source"], "backend");
    }

    #[tokio::test]
    async fn backend_get_payment_options_uses_bearer_auth() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/machine-auth/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "accessToken": "token-123",
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/machine-orders/payment-options"))
            .and(header("authorization", "Bearer token-123"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "options": [],
            })))
            .mount(&server)
            .await;

        let client = BackendClient::new(server.uri());
        client.authenticate("M-1", "S-1").await.expect("auth");
        let response = client.get_payment_options().await.expect("payment options");
        assert_eq!(response["options"].as_array().expect("array").len(), 0);
    }

    #[tokio::test]
    async fn backend_mark_mock_payment_uses_bearer_auth() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/machine-auth/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "accessToken": "token-123",
            })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/machine-orders/ORDER-1/mock-payment/succeed"))
            .and(header("authorization", "Bearer token-123"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "ok": true,
            })))
            .mount(&server)
            .await;

        let client = BackendClient::new(server.uri());
        client.authenticate("M-1", "S-1").await.expect("auth");
        let response = client
            .mark_mock_payment("ORDER-1", true)
            .await
            .expect("mark mock");
        assert_eq!(response["ok"], true);
    }

    #[tokio::test]
    async fn backend_submit_payment_code_sends_serial_text_health() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/machine-auth/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "accessToken": "token-123",
            })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/machine-orders/ORDER-1/payment-code/submit"))
            .and(header("authorization", "Bearer token-123"))
            .and(body_partial_json(serde_json::json!({
                "machineCode": "M-1",
                "source": "serial_text",
                "scannerHealth": {
                    "online": true,
                    "adapter": "serial_text",
                }
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "status": "succeeded",
                "canRetry": false,
            })))
            .mount(&server)
            .await;

        let client = BackendClient::new(server.uri());
        client.authenticate("M-1", "S-1").await.expect("auth");
        let health = vending_core::scanner::ScannerHealthSnapshot {
            online: true,
            adapter: "serial_text".to_string(),
            port: Some("/dev/ttyUSB1".to_string()),
            level: vending_core::health::HealthLevel::Ok,
            code: "SCANNER_READY".to_string(),
            message: "scanner ready".to_string(),
            updated_at: "2026-05-30T00:00:00.000Z".to_string(),
        };
        let response = client
            .submit_payment_code(
                "M-1",
                "ORDER-1",
                "621234567890123456",
                "ORDER-1:attempt-1",
                "serial_text",
                Some(&health),
            )
            .await
            .expect("submit payment code");
        assert_eq!(response["status"], "succeeded");
    }
}
