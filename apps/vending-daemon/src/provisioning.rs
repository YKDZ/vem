use std::{
    env,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

/// The platform response accepted during a machine claim. Credentials are
/// extracted by `CleanRuntimeConfigurationStore` and never written here.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MachineProvisioningProfile {
    pub machine: ProvisioningMachine,
    pub credentials: ProvisioningCredentials,
    pub api_base_url: String,
    pub runtime_endpoints: ProvisioningRuntimeEndpoints,
    pub hardware_profile: ProductionMachineHardwareProfile,
    pub hardware_model: String,
    pub hardware_slot_topology: HardwareSlotTopologyIdentity,
    pub payment_capability: ProductionMachinePaymentCapability,
    pub metadata: ProvisioningMetadata,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProvisioningMachine {
    pub id: String,
    pub code: String,
    pub name: String,
    pub status: String,
    pub location_label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProvisioningCredentials {
    pub machine_secret: String,
    pub mqtt_signing_secret: String,
    pub mqtt_connection: ProvisioningMqttConnection,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProvisioningMqttConnection {
    pub url: String,
    pub client_id: String,
    pub username: Option<String>,
    pub password: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProvisioningRuntimeEndpoints {
    pub api_base_path: String,
    pub machine_auth_token_path: String,
    pub machine_api_base_path: String,
    pub mqtt_topic_prefix: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProvisioningMetadata {
    pub profile_version: i64,
    pub profile_revision: i64,
    pub claim_code_id: String,
    pub claimed_at: String,
    pub server_time: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProductionMachineHardwareProfile {
    pub profile: String,
    pub controller: ProductionControllerProfile,
    pub payment_scanner: ProductionPaymentScannerProfile,
    pub vision: ProductionVisionProfile,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProductionControllerProfile {
    pub required: bool,
    pub protocol: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProductionPaymentScannerProfile {
    pub required: bool,
    pub supports_payment_code: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProductionVisionProfile {
    pub required: bool,
    pub supports_recommendations: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HardwareSlotTopologyIdentity {
    pub identity: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProductionMachinePaymentCapability {
    pub profile: String,
    #[serde(default = "default_payment_capability_enabled")]
    pub qr_code_enabled: bool,
    #[serde(default = "default_payment_capability_enabled")]
    pub payment_code_enabled: bool,
    pub server_time: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<ProductionMachinePaymentOption>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_option_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_provider_code: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProductionMachinePaymentOption {
    pub option_key: String,
    pub provider_code: String,
    pub method: String,
    pub display_name: String,
    pub description: String,
    pub icon: String,
    #[serde(default)]
    pub recommended: bool,
    #[serde(default)]
    pub disabled: bool,
    #[serde(default)]
    pub disabled_reason: Option<String>,
}

fn default_payment_capability_enabled() -> bool {
    true
}

pub fn validate_machine_provisioning_profile(
    profile: &MachineProvisioningProfile,
) -> Result<(), String> {
    validate_len(&profile.machine.id, 1, 128, "machine id missing")?;
    validate_len(&profile.machine.code, 1, 64, "machine code missing")?;
    validate_len(&profile.machine.name, 1, 128, "machine name missing")?;
    validate_len(&profile.machine.status, 1, 64, "machine status missing")?;
    validate_len(
        &profile.credentials.machine_secret,
        32,
        512,
        "machine credential missing from provisioning profile",
    )?;
    validate_len(
        &profile.credentials.mqtt_signing_secret,
        32,
        512,
        "mqtt signing credential missing from provisioning profile",
    )?;
    validate_url(&profile.api_base_url, "apiBaseUrl invalid")?;
    validate_url(
        &profile.credentials.mqtt_connection.url,
        "mqtt connection url missing from provisioning profile",
    )?;
    validate_len(
        &profile.credentials.mqtt_connection.client_id,
        1,
        128,
        "mqtt client id missing from provisioning profile",
    )?;
    if profile
        .credentials
        .mqtt_connection
        .username
        .as_deref()
        .is_some_and(|value| value.trim().is_empty())
        || profile
            .credentials
            .mqtt_connection
            .password
            .as_deref()
            .is_some_and(|value| value.trim().is_empty())
    {
        return Err("mqtt connection invalid".to_string());
    }
    if profile.runtime_endpoints.api_base_path != "/api"
        || profile.runtime_endpoints.machine_auth_token_path != "/api/machine-auth/token"
        || profile.runtime_endpoints.machine_api_base_path
            != format!("/api/machines/{}", profile.machine.code)
        || profile.runtime_endpoints.mqtt_topic_prefix
            != format!("vem/machines/{}", profile.machine.code)
    {
        return Err("runtime endpoints do not match machine identity".to_string());
    }
    if profile.metadata.profile_version != 1 || profile.metadata.profile_revision < 1 {
        return Err("provisioning metadata invalid".to_string());
    }
    validate_datetime(
        &profile.metadata.claimed_at,
        "provisioning metadata invalid",
    )?;
    validate_datetime(
        &profile.metadata.server_time,
        "provisioning metadata invalid",
    )?;
    validate_datetime(
        &profile.payment_capability.server_time,
        "payment capability invalid",
    )?;
    validate_len(&profile.hardware_model, 1, 128, "hardware model invalid")?;
    validate_len(
        &profile.hardware_slot_topology.identity,
        1,
        128,
        "hardware slot topology invalid",
    )?;
    validate_len(
        &profile.hardware_slot_topology.version,
        1,
        128,
        "hardware slot topology invalid",
    )?;
    if profile.hardware_profile.profile != "production"
        || !profile.hardware_profile.controller.required
        || profile.hardware_profile.controller.protocol != "vem-vending-controller"
        || !profile.hardware_profile.payment_scanner.required
        || profile.payment_capability.profile != "production"
    {
        return Err("hardware or payment profile invalid".to_string());
    }
    Ok(())
}

fn validate_len(value: &str, min: usize, max: usize, message: &str) -> Result<(), String> {
    let len = value.trim().chars().count();
    if len < min || len > max {
        return Err(message.to_string());
    }
    Ok(())
}

fn validate_url(value: &str, message: &str) -> Result<(), String> {
    reqwest::Url::parse(value.trim())
        .map(|_| ())
        .map_err(|_| message.to_string())
}

fn validate_datetime(value: &str, message: &str) -> Result<(), String> {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|_| ())
        .map_err(|_| message.to_string())
}

pub fn resolve_data_dir(cli_value: Option<PathBuf>) -> Result<PathBuf, String> {
    if let Some(value) = cli_value {
        return Ok(value);
    }
    if let Ok(value) = env::var("VEM_DAEMON_DATA_DIR") {
        if !value.trim().is_empty() {
            return Ok(PathBuf::from(value));
        }
    }
    default_data_dir()
}

fn default_data_dir() -> Result<PathBuf, String> {
    #[cfg(unix)]
    {
        if let Ok(value) = env::var("XDG_DATA_HOME") {
            return Ok(PathBuf::from(value).join("vem").join("vending-daemon"));
        }
        let home = env::var("HOME").map_err(|error| format!("resolve HOME failed: {error}"))?;
        Ok(Path::new(&home)
            .join(".local")
            .join("share")
            .join("vem")
            .join("vending-daemon"))
    }
    #[cfg(windows)]
    {
        let program_data = env::var("ProgramData")
            .map_err(|error| format!("resolve ProgramData failed: {error}"))?;
        Ok(Path::new(&program_data).join("VEM").join("vending-daemon"))
    }
}
