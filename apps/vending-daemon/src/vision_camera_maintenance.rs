use reqwest::{Method, Url};
use serde::{Deserialize, Serialize};

pub const CONTRACT_VERSION: &str = "vem.vision.camera-maintenance/v2";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum VisionCameraRole {
    Top,
    Front,
}

impl VisionCameraRole {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Top => "top",
            Self::Front => "front",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VisionCameraBackendObservation {
    pub backend: String,
    pub index: Option<u32>,
    pub available: bool,
    pub mapping_state: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VisionCameraCandidate {
    pub id: String,
    pub label: String,
    pub backend_observation: VisionCameraBackendObservation,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VisionCameraRoleStatus {
    pub role: VisionCameraRole,
    pub state: String,
    pub ready: bool,
    #[serde(default)]
    pub candidate_id: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub backend_observation: Option<VisionCameraBackendObservation>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VisionCameraRoles {
    pub top: VisionCameraRoleStatus,
    pub front: VisionCameraRoleStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VisionCameraMaintenanceContract {
    pub contract_version: String,
    pub generation: String,
    pub candidates: Vec<VisionCameraCandidate>,
    pub roles: VisionCameraRoles,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VisionCameraMaintenanceEvidence {
    pub id: String,
    pub role: VisionCameraRole,
    pub candidate_id: String,
    pub generation: String,
    pub expires_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VisionCameraMaintenanceTestResponse {
    pub role: VisionCameraRole,
    pub candidate_id: String,
    pub generation: String,
    pub ok: bool,
    #[serde(default)]
    pub frame: Option<serde_json::Value>,
    #[serde(default)]
    pub backend_observation: Option<VisionCameraBackendObservation>,
    pub evidence: VisionCameraMaintenanceEvidence,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VisionCameraMaintenanceConfirmRequest {
    pub candidate_id: String,
    pub test_evidence_id: String,
    pub operator_visual_confirmation: bool,
    pub expected_generation: String,
}

#[derive(Debug, thiserror::Error)]
pub enum VisionCameraMaintenanceError {
    #[error("{0}")]
    InvalidConfig(String),
    #[error("{0}")]
    Http(String),
    #[error("{0}")]
    Contract(String),
}

/// The Vision sidecar is a local loopback service. The daemon proxies its v2
/// camera-maintenance contract unchanged; this transport deliberately has no
/// maintenance session, capability token, or request signing layer.
fn maintenance_base_url() -> Result<Url, VisionCameraMaintenanceError> {
    let mut url = Url::parse(vending_core::vision::DEFAULT_VISION_WS_URL).map_err(|error| {
        VisionCameraMaintenanceError::InvalidConfig(format!("vision loopback URL invalid: {error}"))
    })?;
    url.set_scheme("http").map_err(|_| {
        VisionCameraMaintenanceError::InvalidConfig("vision loopback scheme invalid".to_string())
    })?;
    if !matches!(
        url.host_str(),
        Some("127.0.0.1") | Some("localhost") | Some("::1")
    ) {
        return Err(VisionCameraMaintenanceError::InvalidConfig(
            "vision camera maintenance must use a loopback endpoint".to_string(),
        ));
    }
    url.set_path("/");
    url.set_query(None);
    Ok(url)
}

fn maintenance_url_at(
    mut url: Url,
    segments: &[&str],
) -> Result<Url, VisionCameraMaintenanceError> {
    let mut path = url.path_segments_mut().map_err(|_| {
        VisionCameraMaintenanceError::InvalidConfig(
            "vision camera maintenance base URL cannot accept path segments".to_string(),
        )
    })?;
    path.clear();
    path.extend(segments);
    drop(path);
    Ok(url)
}

async fn invoke_json<T: for<'de> Deserialize<'de>>(
    client: &reqwest::Client,
    method: Method,
    url: Url,
    body: Option<serde_json::Value>,
) -> Result<T, VisionCameraMaintenanceError> {
    let request = client.request(method, url);
    let request = if let Some(body) = body {
        request.json(&body)
    } else {
        request
    };
    let response = request.send().await.map_err(|error| {
        VisionCameraMaintenanceError::Http(format!("vision maintenance request failed: {error}"))
    })?;
    let status = response.status();
    let bytes = response.bytes().await.map_err(|error| {
        VisionCameraMaintenanceError::Http(format!(
            "read vision maintenance response failed: {error}"
        ))
    })?;
    if !status.is_success() {
        return Err(VisionCameraMaintenanceError::Http(format!(
            "vision maintenance returned HTTP {status}: {}",
            String::from_utf8_lossy(&bytes)
        )));
    }
    serde_json::from_slice(&bytes).map_err(|error| {
        VisionCameraMaintenanceError::Contract(format!(
            "parse vision maintenance response failed: {error}"
        ))
    })
}

async fn invoke_bytes(
    client: &reqwest::Client,
    url: Url,
) -> Result<Vec<u8>, VisionCameraMaintenanceError> {
    let response = client.get(url).send().await.map_err(|error| {
        VisionCameraMaintenanceError::Http(format!(
            "vision maintenance preview request failed: {error}"
        ))
    })?;
    let status = response.status();
    let bytes = response.bytes().await.map_err(|error| {
        VisionCameraMaintenanceError::Http(format!(
            "read vision maintenance preview failed: {error}"
        ))
    })?;
    if !status.is_success() {
        return Err(VisionCameraMaintenanceError::Http(format!(
            "vision maintenance preview returned HTTP {status}: {}",
            String::from_utf8_lossy(&bytes)
        )));
    }
    Ok(bytes.to_vec())
}

fn validate_contract(
    contract: VisionCameraMaintenanceContract,
) -> Result<VisionCameraMaintenanceContract, VisionCameraMaintenanceError> {
    if contract.contract_version != CONTRACT_VERSION {
        return Err(VisionCameraMaintenanceError::Contract(format!(
            "unsupported vision camera maintenance contract version: {}",
            contract.contract_version
        )));
    }
    if contract.generation.trim().is_empty() {
        return Err(VisionCameraMaintenanceError::Contract(
            "vision camera maintenance generation is required".to_string(),
        ));
    }
    Ok(contract)
}

pub async fn get_contract(
    http_client: &reqwest::Client,
) -> Result<VisionCameraMaintenanceContract, VisionCameraMaintenanceError> {
    get_contract_at(http_client, maintenance_base_url()?).await
}

async fn get_contract_at(
    http_client: &reqwest::Client,
    base_url: Url,
) -> Result<VisionCameraMaintenanceContract, VisionCameraMaintenanceError> {
    let contract = invoke_json(
        http_client,
        Method::GET,
        maintenance_url_at(base_url, &["maintenance", "cameras"])?,
        None,
    )
    .await?;
    validate_contract(contract)
}

pub async fn refresh_contract(
    http_client: &reqwest::Client,
) -> Result<VisionCameraMaintenanceContract, VisionCameraMaintenanceError> {
    refresh_contract_at(http_client, maintenance_base_url()?).await
}

async fn refresh_contract_at(
    http_client: &reqwest::Client,
    base_url: Url,
) -> Result<VisionCameraMaintenanceContract, VisionCameraMaintenanceError> {
    let contract = invoke_json(
        http_client,
        Method::POST,
        maintenance_url_at(base_url, &["maintenance", "cameras", "refresh"])?,
        None,
    )
    .await?;
    validate_contract(contract)
}

pub async fn preview_candidate(
    http_client: &reqwest::Client,
    candidate_id: &str,
) -> Result<Vec<u8>, VisionCameraMaintenanceError> {
    preview_candidate_at(http_client, maintenance_base_url()?, candidate_id).await
}

async fn preview_candidate_at(
    http_client: &reqwest::Client,
    base_url: Url,
    candidate_id: &str,
) -> Result<Vec<u8>, VisionCameraMaintenanceError> {
    invoke_bytes(
        http_client,
        maintenance_url_at(
            base_url,
            &["maintenance", "cameras", candidate_id, "preview.jpg"],
        )?,
    )
    .await
}

pub async fn test_role(
    http_client: &reqwest::Client,
    role: VisionCameraRole,
    candidate_id: &str,
) -> Result<VisionCameraMaintenanceTestResponse, VisionCameraMaintenanceError> {
    test_role_at(http_client, maintenance_base_url()?, role, candidate_id).await
}

async fn test_role_at(
    http_client: &reqwest::Client,
    base_url: Url,
    role: VisionCameraRole,
    candidate_id: &str,
) -> Result<VisionCameraMaintenanceTestResponse, VisionCameraMaintenanceError> {
    invoke_json(
        http_client,
        Method::POST,
        maintenance_url_at(base_url, &["maintenance", "cameras", role.as_str(), "test"])?,
        Some(serde_json::json!({ "candidateId": candidate_id })),
    )
    .await
}

pub async fn confirm_role(
    http_client: &reqwest::Client,
    role: VisionCameraRole,
    request: &VisionCameraMaintenanceConfirmRequest,
) -> Result<VisionCameraRoleStatus, VisionCameraMaintenanceError> {
    confirm_role_at(http_client, maintenance_base_url()?, role, request).await
}

async fn confirm_role_at(
    http_client: &reqwest::Client,
    base_url: Url,
    role: VisionCameraRole,
    request: &VisionCameraMaintenanceConfirmRequest,
) -> Result<VisionCameraRoleStatus, VisionCameraMaintenanceError> {
    invoke_json(
        http_client,
        Method::POST,
        maintenance_url_at(
            base_url,
            &["maintenance", "cameras", role.as_str(), "confirm"],
        )?,
        Some(serde_json::to_value(request).map_err(|error| {
            VisionCameraMaintenanceError::Contract(format!(
                "serialize vision maintenance confirm request failed: {error}"
            ))
        })?),
    )
    .await
}

#[cfg(test)]
mod tests {
    use wiremock::{
        matchers::{method, path},
        Mock, MockServer, ResponseTemplate,
    };

    use super::*;

    #[tokio::test]
    async fn plain_loopback_proxy_preserves_v2_contract_without_capability_headers() {
        let server = MockServer::start().await;
        let contract = serde_json::json!({
            "contractVersion": CONTRACT_VERSION,
            "generation": "test-generation",
            "candidates": [{
                "id": "top-001",
                "label": "Top camera",
                "backendObservation": {
                    "backend": "opencv",
                    "index": 0,
                    "available": true,
                    "mappingState": "proven"
                }
            }],
            "roles": {
                "top": { "role": "top", "state": "unbound", "ready": false, "reason": "camera_not_confirmed" },
                "front": { "role": "front", "state": "unbound", "ready": false, "reason": "camera_not_confirmed" }
            }
        });
        Mock::given(method("GET"))
            .and(path("/maintenance/cameras"))
            .respond_with(ResponseTemplate::new(200).set_body_json(contract))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/maintenance/cameras/refresh"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "contractVersion": CONTRACT_VERSION,
                "generation": "refreshed-generation",
                "candidates": [],
                "roles": {
                    "top": { "role": "top", "state": "unbound", "ready": false, "reason": "camera_not_confirmed" },
                    "front": { "role": "front", "state": "unbound", "ready": false, "reason": "camera_not_confirmed" }
                }
            })))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/maintenance/cameras/top-001/preview.jpg"))
            .respond_with(
                ResponseTemplate::new(200).set_body_raw(b"jpeg-preview".to_vec(), "image/jpeg"),
            )
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/maintenance/cameras/top/test"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "role": "top",
                "candidateId": "top-001",
                "generation": "test-generation",
                "ok": true,
                "frame": { "width": 1280, "height": 720 },
                "backendObservation": {
                    "backend": "opencv",
                    "index": 0,
                    "available": true,
                    "mappingState": "proven"
                },
                "evidence": {
                    "id": "evidence-1",
                    "role": "top",
                    "candidateId": "top-001",
                    "generation": "test-generation",
                    "expiresAt": 1_800_000_000
                }
            })))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/maintenance/cameras/top/confirm"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "role": "top",
                "state": "ready",
                "ready": true,
                "candidateId": "top-001",
                "backendObservation": {
                    "backend": "opencv",
                    "index": 0,
                    "available": true,
                    "mappingState": "proven"
                }
            })))
            .expect(1)
            .mount(&server)
            .await;

        let client = reqwest::Client::new();
        let base_url = Url::parse(&server.uri()).expect("loopback URL");
        let listed = get_contract_at(&client, base_url.clone())
            .await
            .expect("plain proxy contract");
        let refreshed = refresh_contract_at(&client, base_url.clone())
            .await
            .expect("refresh contract");
        let preview = preview_candidate_at(&client, base_url.clone(), "top-001")
            .await
            .expect("preview bytes");
        let tested = test_role_at(&client, base_url.clone(), VisionCameraRole::Top, "top-001")
            .await
            .expect("role test");
        let confirmed = confirm_role_at(
            &client,
            base_url,
            VisionCameraRole::Top,
            &VisionCameraMaintenanceConfirmRequest {
                candidate_id: "top-001".to_string(),
                test_evidence_id: "evidence-1".to_string(),
                operator_visual_confirmation: true,
                expected_generation: "test-generation".to_string(),
            },
        )
        .await
        .expect("role confirm");

        assert_eq!(listed.generation, "test-generation");
        assert_eq!(refreshed.generation, "refreshed-generation");
        assert_eq!(preview, b"jpeg-preview");
        assert_eq!(tested.evidence.id, "evidence-1");
        assert!(confirmed.ready);
        let requests = server.received_requests().await.expect("requests");
        assert_eq!(requests.len(), 5);
        assert!(requests.iter().all(|request| {
            !request
                .headers
                .contains_key("x-vision-maintenance-capability")
        }));
    }
}
