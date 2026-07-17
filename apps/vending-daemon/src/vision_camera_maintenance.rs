use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{Duration, Utc};
use ed25519_dalek::{Signer as _, SigningKey};
use reqwest::{Method, Url};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MaintenancePrivateKeyRecord {
    version: u8,
    key_id: String,
    seed: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MaintenanceKeyring {
    version: u8,
    issuer: String,
    keys: Vec<MaintenanceKeyringEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MaintenanceKeyringEntry {
    id: String,
    public_key: String,
    not_before: i64,
    not_after: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MaintenanceSessionRecord {
    version: u8,
    machine_code: String,
    session_id: String,
    key_id: String,
    expires_at: i64,
}

#[derive(Debug, thiserror::Error)]
pub enum VisionCameraMaintenanceError {
    #[error("{0}")]
    InvalidConfig(String),
    #[error("{0}")]
    Http(String),
    #[error("{0}")]
    Contract(String),
    #[error("{0}")]
    Io(String),
}

fn issuer_root(data_dir: &Path) -> PathBuf {
    data_dir.join("vision")
}

fn private_key_path(data_dir: &Path) -> PathBuf {
    issuer_root(data_dir).join("daemon-maintenance-private-key.json")
}

fn keyring_path(data_dir: &Path) -> PathBuf {
    issuer_root(data_dir).join("daemon-maintenance-keys.json")
}

fn session_path(data_dir: &Path) -> PathBuf {
    issuer_root(data_dir).join("daemon-maintenance-session.json")
}

async fn load_or_create_signing_key(
    data_dir: &Path,
) -> Result<(String, SigningKey), VisionCameraMaintenanceError> {
    let private_path = private_key_path(data_dir);
    if let Ok(existing) = tokio::fs::read_to_string(&private_path).await {
        let record: MaintenancePrivateKeyRecord =
            serde_json::from_str(&existing).map_err(|error| {
                VisionCameraMaintenanceError::Io(format!(
                    "parse maintenance signing key failed: {error}"
                ))
            })?;
        let seed = URL_SAFE_NO_PAD
            .decode(record.seed.as_bytes())
            .map_err(|error| {
                VisionCameraMaintenanceError::Io(format!(
                    "decode maintenance signing key failed: {error}"
                ))
            })?;
        let signing_key = SigningKey::from_bytes(seed.as_slice().try_into().map_err(|_| {
            VisionCameraMaintenanceError::Io("maintenance signing key seed invalid".to_string())
        })?);
        return Ok((record.key_id, signing_key));
    }

    tokio::fs::create_dir_all(issuer_root(data_dir))
        .await
        .map_err(|error| {
            VisionCameraMaintenanceError::Io(format!("create vision issuer dir failed: {error}"))
        })?;
    let mut seed = [0_u8; 32];
    getrandom::getrandom(&mut seed).map_err(|_| {
        VisionCameraMaintenanceError::Io("generate maintenance signing key failed".to_string())
    })?;
    let key_id = format!("daemon-ed25519-{}", Utc::now().format("%Y%m%d%H%M%S"));
    let record = MaintenancePrivateKeyRecord {
        version: 1,
        key_id: key_id.clone(),
        seed: URL_SAFE_NO_PAD.encode(seed),
    };
    let payload = serde_json::to_vec_pretty(&record).map_err(|error| {
        VisionCameraMaintenanceError::Io(format!(
            "serialize maintenance signing key failed: {error}"
        ))
    })?;
    tokio::fs::write(&private_path, payload)
        .await
        .map_err(|error| {
            VisionCameraMaintenanceError::Io(format!(
                "write maintenance signing key failed: {error}"
            ))
        })?;
    Ok((key_id, SigningKey::from_bytes(&seed)))
}

async fn ensure_vision_verifier_files(
    data_dir: &Path,
    machine_code: &str,
    session_id: &str,
) -> Result<(String, SigningKey), VisionCameraMaintenanceError> {
    let (key_id, signing_key) = load_or_create_signing_key(data_dir).await?;
    let now = Utc::now().timestamp();
    let public_key = URL_SAFE_NO_PAD.encode(signing_key.verifying_key().to_bytes());
    let keyring = MaintenanceKeyring {
        version: 1,
        issuer: "vem.vending-daemon".to_string(),
        keys: vec![MaintenanceKeyringEntry {
            id: key_id.clone(),
            public_key,
            not_before: now - 60,
            not_after: now + 365 * 24 * 60 * 60,
        }],
    };
    let session = MaintenanceSessionRecord {
        version: 1,
        machine_code: machine_code.to_string(),
        session_id: session_id.to_string(),
        key_id: key_id.clone(),
        expires_at: (Utc::now() + Duration::minutes(15)).timestamp(),
    };
    tokio::fs::write(
        keyring_path(data_dir),
        serde_json::to_vec_pretty(&keyring).map_err(|error| {
            VisionCameraMaintenanceError::Io(format!("serialize vision keyring failed: {error}"))
        })?,
    )
    .await
    .map_err(|error| {
        VisionCameraMaintenanceError::Io(format!("write vision keyring failed: {error}"))
    })?;
    tokio::fs::write(
        session_path(data_dir),
        serde_json::to_vec_pretty(&session).map_err(|error| {
            VisionCameraMaintenanceError::Io(format!(
                "serialize vision maintenance session failed: {error}"
            ))
        })?,
    )
    .await
    .map_err(|error| {
        VisionCameraMaintenanceError::Io(format!(
            "write vision maintenance session failed: {error}"
        ))
    })?;
    Ok((key_id, signing_key))
}

fn capability_token(
    signing_key: &SigningKey,
    key_id: &str,
    machine_code: &str,
    session_id: &str,
    scope: &str,
) -> Result<String, VisionCameraMaintenanceError> {
    let now = Utc::now().timestamp();
    let header = serde_json::json!({
        "alg": "EdDSA",
        "kid": key_id,
        "typ": "JWT",
    });
    let claims = serde_json::json!({
        "iss": "vem.vending-daemon",
        "aud": "vem.vision.camera-maintenance",
        "machine": machine_code,
        "session": session_id,
        "purpose": "vision.camera-maintenance",
        "scope": scope,
        "iat": now,
        "exp": now + 300,
        "jti": uuid::Uuid::new_v4().to_string(),
    });
    let encoded_header = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&header).map_err(|error| {
        VisionCameraMaintenanceError::Io(format!(
            "serialize vision capability header failed: {error}"
        ))
    })?);
    let encoded_claims = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).map_err(|error| {
        VisionCameraMaintenanceError::Io(format!(
            "serialize vision capability claims failed: {error}"
        ))
    })?);
    let signing_input = format!("{encoded_header}.{encoded_claims}");
    let signature = signing_key.sign(signing_input.as_bytes());
    Ok(format!(
        "{signing_input}.{}",
        URL_SAFE_NO_PAD.encode(signature.to_bytes())
    ))
}

fn vision_http_base_url(ws_url: &str) -> Result<Url, VisionCameraMaintenanceError> {
    let mut url = Url::parse(ws_url).map_err(|error| {
        VisionCameraMaintenanceError::InvalidConfig(format!("visionWsUrl invalid: {error}"))
    })?;
    let scheme = match url.scheme() {
        "ws" => "http",
        "wss" => "https",
        value => {
            return Err(VisionCameraMaintenanceError::InvalidConfig(format!(
                "visionWsUrl must use ws or wss, got {value}"
            )))
        }
    };
    url.set_scheme(scheme).map_err(|_| {
        VisionCameraMaintenanceError::InvalidConfig(
            "visionWsUrl scheme conversion failed".to_string(),
        )
    })?;
    url.set_path("/");
    url.set_query(None);
    Ok(url)
}

fn maintenance_url(
    public: &crate::config::EffectiveRuntimeConfig,
    segments: &[&str],
) -> Result<Url, VisionCameraMaintenanceError> {
    let mut url = vision_http_base_url(&public.vision_ws_url)?;
    {
        let mut path = url.path_segments_mut().map_err(|_| {
            VisionCameraMaintenanceError::InvalidConfig(
                "vision camera maintenance base URL cannot accept path segments".to_string(),
            )
        })?;
        path.clear();
        path.extend(segments);
    }
    Ok(url)
}

async fn invoke_json<T: for<'de> Deserialize<'de>>(
    client: &reqwest::Client,
    method: Method,
    url: Url,
    token: String,
    body: Option<serde_json::Value>,
) -> Result<T, VisionCameraMaintenanceError> {
    let request = client
        .request(method, url)
        .header("X-Vision-Maintenance-Capability", token);
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
        let message = String::from_utf8_lossy(&bytes).to_string();
        return Err(VisionCameraMaintenanceError::Http(format!(
            "vision maintenance returned HTTP {status}: {message}"
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
    token: String,
) -> Result<Vec<u8>, VisionCameraMaintenanceError> {
    let response = client
        .get(url)
        .header("X-Vision-Maintenance-Capability", token)
        .send()
        .await
        .map_err(|error| {
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
    data_dir: &Path,
    public: &crate::config::EffectiveRuntimeConfig,
    session_id: &str,
) -> Result<VisionCameraMaintenanceContract, VisionCameraMaintenanceError> {
    let machine_code = public
        .machine_code
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            VisionCameraMaintenanceError::InvalidConfig(
                "machineCode is required for vision maintenance".to_string(),
            )
        })?;
    let (key_id, signing_key) =
        ensure_vision_verifier_files(data_dir, machine_code, session_id).await?;
    let token = capability_token(
        &signing_key,
        &key_id,
        machine_code,
        session_id,
        "camera.read",
    )?;
    let contract: VisionCameraMaintenanceContract = invoke_json(
        http_client,
        Method::GET,
        maintenance_url(public, &["maintenance", "cameras"])?,
        token,
        None,
    )
    .await?;
    validate_contract(contract)
}

pub async fn refresh_contract(
    http_client: &reqwest::Client,
    data_dir: &Path,
    public: &crate::config::EffectiveRuntimeConfig,
    session_id: &str,
) -> Result<VisionCameraMaintenanceContract, VisionCameraMaintenanceError> {
    let machine_code = public
        .machine_code
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            VisionCameraMaintenanceError::InvalidConfig(
                "machineCode is required for vision maintenance".to_string(),
            )
        })?;
    let (key_id, signing_key) =
        ensure_vision_verifier_files(data_dir, machine_code, session_id).await?;
    let token = capability_token(
        &signing_key,
        &key_id,
        machine_code,
        session_id,
        "camera.refresh",
    )?;
    let contract: VisionCameraMaintenanceContract = invoke_json(
        http_client,
        Method::POST,
        maintenance_url(public, &["maintenance", "cameras", "refresh"])?,
        token,
        None,
    )
    .await?;
    validate_contract(contract)
}

pub async fn preview_candidate(
    http_client: &reqwest::Client,
    data_dir: &Path,
    public: &crate::config::EffectiveRuntimeConfig,
    session_id: &str,
    candidate_id: &str,
) -> Result<Vec<u8>, VisionCameraMaintenanceError> {
    let machine_code = public
        .machine_code
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            VisionCameraMaintenanceError::InvalidConfig(
                "machineCode is required for vision maintenance".to_string(),
            )
        })?;
    let (key_id, signing_key) =
        ensure_vision_verifier_files(data_dir, machine_code, session_id).await?;
    let token = capability_token(
        &signing_key,
        &key_id,
        machine_code,
        session_id,
        "camera.preview",
    )?;
    let url = maintenance_url(
        public,
        &["maintenance", "cameras", candidate_id, "preview.jpg"],
    )?;
    invoke_bytes(http_client, url, token).await
}

pub async fn test_role(
    http_client: &reqwest::Client,
    data_dir: &Path,
    public: &crate::config::EffectiveRuntimeConfig,
    session_id: &str,
    role: VisionCameraRole,
    candidate_id: &str,
) -> Result<VisionCameraMaintenanceTestResponse, VisionCameraMaintenanceError> {
    let machine_code = public
        .machine_code
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            VisionCameraMaintenanceError::InvalidConfig(
                "machineCode is required for vision maintenance".to_string(),
            )
        })?;
    let (key_id, signing_key) =
        ensure_vision_verifier_files(data_dir, machine_code, session_id).await?;
    let token = capability_token(
        &signing_key,
        &key_id,
        machine_code,
        session_id,
        "camera.test",
    )?;
    invoke_json(
        http_client,
        Method::POST,
        maintenance_url(public, &["maintenance", "cameras", role.as_str(), "test"])?,
        token,
        Some(serde_json::json!({ "candidateId": candidate_id })),
    )
    .await
}

pub async fn confirm_role(
    http_client: &reqwest::Client,
    data_dir: &Path,
    public: &crate::config::EffectiveRuntimeConfig,
    session_id: &str,
    role: VisionCameraRole,
    request: &VisionCameraMaintenanceConfirmRequest,
) -> Result<VisionCameraRoleStatus, VisionCameraMaintenanceError> {
    let machine_code = public
        .machine_code
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            VisionCameraMaintenanceError::InvalidConfig(
                "machineCode is required for vision maintenance".to_string(),
            )
        })?;
    let (key_id, signing_key) =
        ensure_vision_verifier_files(data_dir, machine_code, session_id).await?;
    let token = capability_token(
        &signing_key,
        &key_id,
        machine_code,
        session_id,
        "camera.confirm",
    )?;
    invoke_json(
        http_client,
        Method::POST,
        maintenance_url(
            public,
            &["maintenance", "cameras", role.as_str(), "confirm"],
        )?,
        token,
        Some(serde_json::to_value(request).map_err(|error| {
            VisionCameraMaintenanceError::Io(format!(
                "serialize vision camera maintenance confirm request failed: {error}"
            ))
        })?),
    )
    .await
}

pub fn contract_revision(contract: &VisionCameraMaintenanceContract) -> Result<String, String> {
    let payload = serde_json::to_vec(contract)
        .map_err(|error| format!("serialize vision camera maintenance contract failed: {error}"))?;
    Ok(format!("sha256:{:x}", Sha256::digest(payload)))
}
