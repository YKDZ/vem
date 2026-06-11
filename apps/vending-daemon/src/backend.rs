use std::sync::Arc;

use crate::config::MachineProvisioningProfile;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, RwLock};

#[derive(Debug, Clone)]
pub struct BackendClient {
    base_url: String,
    client: reqwest::Client,
    token: Arc<RwLock<Option<String>>>,
    credentials: Arc<RwLock<Option<MachineCredentials>>>,
    auth_lock: Arc<Mutex<()>>,
}

#[derive(Debug, Clone)]
struct MachineCredentials {
    machine_code: String,
    machine_secret: String,
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
    pub reconciliation: Option<StockMovementReconciliation>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StockMovementReconciliation {
    pub reason: String,
    pub platform_review: Option<serde_json::Value>,
    pub sale_safety_blocker: Option<StockMovementSaleSafetyBlocker>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StockMovementSaleSafetyBlocker {
    pub slot_id: String,
    pub slot_sales_state: String,
    pub reason: String,
}

impl BackendClient {
    pub fn new(base_url: impl Into<String>) -> Self {
        let base_url = base_url.into().trim_end_matches('/').to_string();
        Self {
            base_url,
            client: reqwest::Client::new(),
            token: Arc::new(RwLock::new(None)),
            credentials: Arc::new(RwLock::new(None)),
            auth_lock: Arc::new(Mutex::new(())),
        }
    }

    fn endpoint(&self, path: &str) -> String {
        let trimmed = path.trim_start_matches('/');
        format!("{}/{}", self.base_url, trimmed)
    }

    fn unwrap_api_response(value: serde_json::Value) -> Result<serde_json::Value, String> {
        let Some(object) = value.as_object() else {
            return Ok(value);
        };
        if !(object.contains_key("code")
            && object.contains_key("message")
            && object.contains_key("data"))
        {
            return Ok(value);
        }

        let code = object
            .get("code")
            .and_then(|value| {
                value
                    .as_i64()
                    .or_else(|| value.as_u64().and_then(|value| i64::try_from(value).ok()))
            })
            .ok_or_else(|| "backend response envelope code invalid".to_string())?;
        if code == 0 {
            return Ok(object
                .get("data")
                .cloned()
                .unwrap_or(serde_json::Value::Null));
        }

        let message = object
            .get("message")
            .and_then(|value| value.as_str())
            .unwrap_or("backend returned non-zero code");
        Err(format!("BACKEND_API_ERROR: {code} {message}"))
    }

    fn api_error_from_payload(payload: &str) -> Option<String> {
        let value: serde_json::Value = serde_json::from_str(payload).ok()?;
        let object = value.as_object()?;
        if !(object.contains_key("code")
            && object.contains_key("message")
            && object.contains_key("data"))
        {
            return None;
        }
        let code = object.get("code").and_then(|value| {
            value
                .as_i64()
                .map(|value| value.to_string())
                .or_else(|| value.as_u64().map(|value| value.to_string()))
                .or_else(|| value.as_str().map(ToString::to_string))
        })?;
        if code == "0" {
            return None;
        }
        let message = object
            .get("message")
            .and_then(|value| value.as_str())
            .unwrap_or("backend returned non-zero code");
        Some(format!("BACKEND_API_ERROR: {code} {message}"))
    }

    fn http_error(
        status: reqwest::StatusCode,
        payload: &str,
        with_auth: bool,
    ) -> BackendRequestError {
        if with_auth && matches!(status.as_u16(), 401 | 403) {
            return BackendRequestError::AuthFailed;
        }
        if let Some(message) = Self::api_error_from_payload(payload) {
            return BackendRequestError::Other(message);
        }
        match status.as_u16() {
            401 | 403 => BackendRequestError::AuthFailed,
            502..=504 => BackendRequestError::Other("BACKEND_OFFLINE".to_string()),
            _ => BackendRequestError::Other(format!("BACKEND_HTTP_ERROR: {status} {payload}")),
        }
    }

    async fn request_json_once(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<serde_json::Value>,
        with_auth: bool,
    ) -> Result<serde_json::Value, BackendRequestError> {
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
        let response = request.send().await.map_err(|error| {
            BackendRequestError::Other(format!("backend request failed: {error}"))
        })?;
        let status = response.status();
        let payload = response.text().await.map_err(|error| {
            BackendRequestError::Other(format!("backend read response failed: {error}"))
        })?;

        if !status.is_success() {
            return Err(Self::http_error(status, &payload, with_auth));
        }
        if payload.is_empty() {
            return Ok(serde_json::Value::Null);
        }
        let value = serde_json::from_str(&payload).map_err(|error| {
            BackendRequestError::Other(format!("backend json parse failed: {error}"))
        })?;
        Self::unwrap_api_response(value).map_err(BackendRequestError::Other)
    }

    async fn request_json(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<serde_json::Value>,
        with_auth: bool,
    ) -> Result<serde_json::Value, String> {
        if with_auth {
            self.ensure_authenticated().await?;
        }

        match self
            .request_json_once(method.clone(), path, body.clone(), with_auth)
            .await
        {
            Ok(value) => Ok(value),
            Err(BackendRequestError::AuthFailed) if with_auth => {
                self.clear_token().await;
                self.refresh_auth_token().await?;
                self.request_json_once(method, path, body, with_auth)
                    .await
                    .map_err(BackendRequestError::into_string)
            }
            Err(error) => Err(error.into_string()),
        }
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
        *self.credentials.write().await = Some(MachineCredentials {
            machine_code: machine_code.to_string(),
            machine_secret: machine_secret.to_string(),
        });
        self.refresh_auth_token().await
    }

    async fn clear_token(&self) {
        *self.token.write().await = None;
    }

    async fn ensure_authenticated(&self) -> Result<(), String> {
        if self.token.read().await.is_some() {
            return Ok(());
        }
        self.refresh_auth_token().await
    }

    async fn refresh_auth_token(&self) -> Result<(), String> {
        let _guard = self.auth_lock.lock().await;
        let Some(credentials) = self.credentials.read().await.clone() else {
            return Err("BACKEND_AUTH_NOT_CONFIGURED".to_string());
        };
        let body = serde_json::json!({
            "machineCode": credentials.machine_code,
            "machineSecret": credentials.machine_secret,
        });
        let value = self
            .request_json_once(
                reqwest::Method::POST,
                "/machine-auth/token",
                Some(body),
                false,
            )
            .await
            .map_err(BackendRequestError::into_string)?;
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

    pub async fn claim_machine(
        &self,
        claim_code: &str,
    ) -> Result<MachineProvisioningProfile, String> {
        let response = self
            .client
            .post(self.endpoint("/machines/claim"))
            .json(&serde_json::json!({ "claimCode": claim_code }))
            .send()
            .await
            .map_err(|error| format!("backend request failed: {error}"))?;
        let status = response.status();
        let payload = response
            .text()
            .await
            .map_err(|error| format!("backend read response failed: {error}"))?;

        if !status.is_success() {
            if let Some(message) = Self::api_error_from_payload(&payload) {
                return Err(message);
            }
            return Err(match status.as_u16() {
                502..=504 => "BACKEND_OFFLINE".to_string(),
                _ => format!("BACKEND_HTTP_ERROR: {status} {payload}"),
            });
        }
        if payload.is_empty() {
            return Err("backend response parse failed: empty claim profile".to_string());
        }
        let value = serde_json::from_str(&payload)
            .map_err(|error| format!("backend json parse failed: {error}"))?;
        let value = Self::unwrap_api_response(value)?;
        serde_json::from_value(value)
            .map_err(|error| format!("backend response parse failed: {error}"))
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
        let url = reqwest::Url::parse("http://localhost")
            .map(|mut url| {
                url.set_path(&format!("/machine-orders/{order_no}/status"));
                url.query_pairs_mut()
                    .append_pair("machineCode", machine_code);
                url
            })
            .map(|url| {
                let path = url.path();
                match url.query() {
                    Some(query) => format!("{path}?{query}"),
                    None => path.to_string(),
                }
            })
            .map_err(|error| format!("build status url failed: {error}"))?;
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

enum BackendRequestError {
    AuthFailed,
    Other(String),
}

impl BackendRequestError {
    fn into_string(self) -> String {
        match self {
            Self::AuthFailed => "BACKEND_AUTH_FAILED".to_string(),
            Self::Other(message) => message,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    use wiremock::matchers::{body_partial_json, header, method, path, query_param};
    use wiremock::Request;
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
    async fn backend_unwraps_service_api_envelope() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/machine-auth/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "code": 0,
                "message": "ok",
                "data": {
                    "accessToken": "token-123"
                }
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/machines/M-1/catalog"))
            .and(header("authorization", "Bearer token-123"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "code": 0,
                "message": "ok",
                "data": [
                    {
                        "slotCode": "A1",
                        "productName": "Test Product"
                    }
                ]
            })))
            .mount(&server)
            .await;

        let client = BackendClient::new(server.uri());
        client.authenticate("M-1", "S-1").await.expect("auth");
        let response = client.get_catalog("M-1").await.expect("catalog");
        assert_eq!(response[0]["slotCode"], "A1");
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
    async fn backend_preserves_service_api_error_envelope_on_502() {
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
            .respond_with(ResponseTemplate::new(502).set_body_json(serde_json::json!({
                "code": 502,
                "message": "支付宝支付通道暂不可用，请稍后重试",
                "data": null
            })))
            .mount(&server)
            .await;

        let client = BackendClient::new(server.uri());
        client.authenticate("M-1", "S-1").await.expect("auth");
        let error = client
            .get_payment_options()
            .await
            .expect_err("service api error envelope should be preserved");

        assert_eq!(
            error,
            "BACKEND_API_ERROR: 502 支付宝支付通道暂不可用，请稍后重试"
        );
    }

    #[tokio::test]
    async fn backend_reauthenticates_and_retries_when_machine_token_expires() {
        let server = MockServer::start().await;
        let auth_calls = Arc::new(AtomicUsize::new(0));
        let auth_calls_for_mock = auth_calls.clone();
        Mock::given(method("POST"))
            .and(path("/machine-auth/token"))
            .and(body_partial_json(serde_json::json!({
                "machineCode": "M-1",
                "machineSecret": "S-1",
            })))
            .respond_with(move |_request: &Request| {
                let call = auth_calls_for_mock.fetch_add(1, Ordering::SeqCst);
                let token = if call == 0 {
                    "expired-token"
                } else {
                    "fresh-token"
                };
                ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "accessToken": token,
                }))
            })
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/machine-orders/payment-options"))
            .and(header("authorization", "Bearer expired-token"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/machine-orders/payment-options"))
            .and(header("authorization", "Bearer fresh-token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "options": [{"optionKey": "payment_code:alipay"}],
            })))
            .mount(&server)
            .await;

        let client = BackendClient::new(server.uri());
        client
            .authenticate("M-1", "S-1")
            .await
            .expect("initial auth");

        let response = client.get_payment_options().await.expect("payment options");

        assert_eq!(response["options"][0]["optionKey"], "payment_code:alipay");
        assert_eq!(auth_calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn backend_reauthenticates_when_service_api_wraps_invalid_token_in_error_envelope() {
        let server = MockServer::start().await;
        let auth_calls = Arc::new(AtomicUsize::new(0));
        let auth_calls_for_mock = auth_calls.clone();
        Mock::given(method("POST"))
            .and(path("/machine-auth/token"))
            .and(body_partial_json(serde_json::json!({
                "machineCode": "M-1",
                "machineSecret": "S-1",
            })))
            .respond_with(move |_request: &Request| {
                let call = auth_calls_for_mock.fetch_add(1, Ordering::SeqCst);
                let token = if call == 0 {
                    "expired-token"
                } else {
                    "fresh-token"
                };
                ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "accessToken": token,
                }))
            })
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/machine-orders/payment-options"))
            .and(header("authorization", "Bearer expired-token"))
            .respond_with(ResponseTemplate::new(401).set_body_json(serde_json::json!({
                "code": 401,
                "message": "Invalid machine token",
                "data": null
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/machine-orders/payment-options"))
            .and(header("authorization", "Bearer fresh-token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "options": [{"optionKey": "payment_code:alipay"}],
            })))
            .mount(&server)
            .await;

        let client = BackendClient::new(server.uri());
        client
            .authenticate("M-1", "S-1")
            .await
            .expect("initial auth");

        let response = client.get_payment_options().await.expect("payment options");

        assert_eq!(response["options"][0]["optionKey"], "payment_code:alipay");
        assert_eq!(auth_calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn backend_uses_stored_machine_credentials_after_initial_auth_failure() {
        let server = MockServer::start().await;
        let auth_calls = Arc::new(AtomicUsize::new(0));
        let auth_calls_for_mock = auth_calls.clone();
        Mock::given(method("POST"))
            .and(path("/machine-auth/token"))
            .and(body_partial_json(serde_json::json!({
                "machineCode": "M-1",
                "machineSecret": "S-1",
            })))
            .respond_with(move |_request: &Request| {
                let call = auth_calls_for_mock.fetch_add(1, Ordering::SeqCst);
                if call == 0 {
                    ResponseTemplate::new(503)
                } else {
                    ResponseTemplate::new(200).set_body_json(serde_json::json!({
                        "accessToken": "token-after-recovery",
                    }))
                }
            })
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/machine-orders/payment-options"))
            .and(header("authorization", "Bearer token-after-recovery"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "options": [{"optionKey": "payment_code:alipay"}],
            })))
            .mount(&server)
            .await;

        let client = BackendClient::new(server.uri());
        let initial_error = client
            .authenticate("M-1", "S-1")
            .await
            .expect_err("initial auth should surface outage");
        assert_eq!(initial_error, "BACKEND_OFFLINE");

        let response = client.get_payment_options().await.expect("payment options");

        assert_eq!(response["options"][0]["optionKey"], "payment_code:alipay");
        assert_eq!(auth_calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn backend_get_order_status_sends_machine_code_query() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/machine-auth/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "accessToken": "token-123",
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/machine-orders/ORDER-1/status"))
            .and(query_param("machineCode", "M-1"))
            .and(header("authorization", "Bearer token-123"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "orderNo": "ORDER-1",
                "machineCode": "M-1",
                "orderStatus": "fulfilled",
                "nextAction": "complete"
            })))
            .mount(&server)
            .await;

        let client = BackendClient::new(server.uri());
        client.authenticate("M-1", "S-1").await.expect("auth");
        let response = client
            .get_order_status("M-1", "ORDER-1")
            .await
            .expect("status");
        assert_eq!(response["orderStatus"], "fulfilled");
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
