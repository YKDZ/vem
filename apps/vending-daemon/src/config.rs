use std::{
    env,
    path::{Path, PathBuf},
    sync::Arc,
};

use serde::{Deserialize, Serialize};
use tokio::fs;
use vending_core::serial::SerialPortUsbIdentity;

use crate::{secret::SecretStore, state::LocalStateStore};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HardwareAdapterKind {
    Mock,
    Serial,
    Bluetooth,
    VendorSdk,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ScannerAdapterKind {
    Disabled,
    SerialText,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AudioCueCategorySettings {
    #[serde(default)]
    pub presence: bool,
    #[serde(default)]
    pub transaction: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AudioCueSettings {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub categories: AudioCueCategorySettings,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct MachinePublicConfig {
    pub machine_code: Option<String>,
    #[serde(default)]
    pub machine_id: Option<String>,
    #[serde(default)]
    pub machine_name: Option<String>,
    #[serde(default)]
    pub machine_status: Option<String>,
    #[serde(default)]
    pub machine_location_label: Option<String>,
    pub api_base_url: String,
    pub mqtt_url: String,
    pub mqtt_username: Option<String>,
    #[serde(default)]
    pub mqtt_client_id: Option<String>,
    pub hardware_adapter: HardwareAdapterKind,
    pub serial_port_path: Option<String>,
    pub lower_controller_usb_identity: Option<SerialPortUsbIdentity>,
    pub scanner_adapter: ScannerAdapterKind,
    pub scanner_serial_port_path: Option<String>,
    #[serde(default)]
    pub scanner_usb_identity: Option<SerialPortUsbIdentity>,
    pub scanner_baud_rate: u32,
    pub scanner_frame_suffix: vending_core::scanner::ScannerFrameSuffix,
    pub vision_enabled: bool,
    pub vision_ws_url: String,
    pub vision_request_timeout_ms: u64,
    #[serde(default = "default_machine_audio_volume")]
    pub machine_audio_volume: f64,
    #[serde(default, skip_serializing)]
    pub try_on_camera_device_id: Option<String>,
    #[serde(default)]
    pub audio_cue_settings: AudioCueSettings,
    #[serde(default, skip_serializing)]
    pub presence_audio_enabled: Option<bool>,
    pub kiosk_mode: bool,
    #[serde(default = "default_stock_movement_retention_days")]
    pub stock_movement_retention_days: i64,
    #[serde(default)]
    pub runtime_endpoints: Option<ProvisioningRuntimeEndpoints>,
    #[serde(default)]
    pub hardware_profile: Option<ProductionMachineHardwareProfile>,
    #[serde(default)]
    pub payment_capability: Option<ProductionMachinePaymentCapability>,
    #[serde(default)]
    pub provisioning_metadata: Option<ProvisioningMetadata>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineConfigSecretsUpdate {
    #[serde(alias = "machine_secret")]
    pub machine_secret: Option<String>,
    #[serde(alias = "mqtt_signing_secret")]
    pub mqtt_signing_secret: Option<String>,
    #[serde(alias = "mqtt_password")]
    pub mqtt_password: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineConfigUpdateRequest {
    pub public: MachinePublicConfig,
    pub secrets: Option<MachineConfigSecretsUpdate>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct MachineProvisioningProfile {
    pub machine: ProvisioningMachine,
    pub credentials: ProvisioningCredentials,
    pub runtime_endpoints: ProvisioningRuntimeEndpoints,
    pub hardware_profile: ProductionMachineHardwareProfile,
    pub payment_capability: ProductionMachinePaymentCapability,
    pub metadata: ProvisioningMetadata,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct ProvisioningMachine {
    pub id: String,
    pub code: String,
    pub name: String,
    pub status: String,
    pub location_label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct ProvisioningCredentials {
    pub machine_secret: String,
    pub machine_secret_version: i64,
    pub mqtt_signing_secret: String,
    pub mqtt_connection: ProvisioningMqttConnection,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct ProvisioningMqttConnection {
    pub url: String,
    pub client_id: String,
    pub username: Option<String>,
    pub password: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct ProvisioningRuntimeEndpoints {
    pub api_base_path: String,
    pub machine_auth_token_path: String,
    pub machine_api_base_path: String,
    pub mqtt_topic_prefix: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct ProvisioningMetadata {
    pub profile_version: i64,
    pub claim_code_id: String,
    pub claimed_at: String,
    pub server_time: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct ProductionMachineHardwareProfile {
    pub profile: String,
    pub controller: ProductionControllerProfile,
    pub payment_scanner: ProductionPaymentScannerProfile,
    pub vision: ProductionVisionProfile,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct ProductionControllerProfile {
    pub required: bool,
    pub protocol: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct ProductionPaymentScannerProfile {
    pub required: bool,
    pub supports_payment_code: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct ProductionVisionProfile {
    pub required: bool,
    pub supports_recommendations: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
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
#[serde(deny_unknown_fields)]
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MachineRuntimeConfig {
    pub public: MachinePublicConfig,
    pub machine_secret_configured: bool,
    pub mqtt_signing_secret_configured: bool,
    pub mqtt_password_configured: bool,
    pub machine_secret: Option<String>,
    pub mqtt_signing_secret: Option<String>,
    pub mqtt_password: Option<String>,
}

#[derive(Debug, Clone)]
pub struct MachineRuntimeSecrets {
    pub machine_secret: Option<String>,
    pub mqtt_signing_secret: Option<String>,
    pub mqtt_password: Option<String>,
}

impl MachineRuntimeConfig {
    pub fn to_public(&self) -> MachinePublicRuntimeConfig {
        let provisioning_issues = provisioning_issues(
            &self.public,
            self.machine_secret_configured,
            self.mqtt_signing_secret_configured,
            self.mqtt_password_configured,
        );
        MachinePublicRuntimeConfig {
            public: self.public.clone(),
            machine_secret_configured: self.machine_secret_configured,
            mqtt_signing_secret_configured: self.mqtt_signing_secret_configured,
            mqtt_password_configured: self.mqtt_password_configured,
            provisioned: provisioning_issues.is_empty(),
            provisioning_issues,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MachinePublicRuntimeConfig {
    pub public: MachinePublicConfig,
    pub machine_secret_configured: bool,
    pub mqtt_signing_secret_configured: bool,
    pub mqtt_password_configured: bool,
    pub provisioned: bool,
    pub provisioning_issues: Vec<String>,
}

impl MachinePublicRuntimeConfig {
    fn with_provisioning_state(mut self) -> Self {
        self.provisioning_issues = provisioning_issues(
            &self.public,
            self.machine_secret_configured,
            self.mqtt_signing_secret_configured,
            self.mqtt_password_configured,
        );
        self.provisioned = self.provisioning_issues.is_empty();
        self
    }
}

pub const STOCK_MOVEMENT_RETENTION_MIN_DAYS: i64 = 1;
pub const STOCK_MOVEMENT_RETENTION_MAX_DAYS: i64 = 366;

pub fn default_stock_movement_retention_days() -> i64 {
    30
}

pub fn default_machine_audio_volume() -> f64 {
    0.7
}

fn provisioning_issues(
    public: &MachinePublicConfig,
    machine_secret_configured: bool,
    mqtt_signing_secret_configured: bool,
    mqtt_password_configured: bool,
) -> Vec<String> {
    let mut issues = Vec::new();
    if public
        .machine_code
        .as_deref()
        .unwrap_or("")
        .trim()
        .is_empty()
    {
        issues.push("machine_code_missing".to_string());
    }
    if public.machine_id.as_deref().unwrap_or("").trim().is_empty() {
        issues.push("machine_id_missing".to_string());
    }
    if public.api_base_url.trim().is_empty() {
        issues.push("api_base_url_missing".to_string());
    }
    if public.mqtt_url.trim().is_empty() {
        issues.push("mqtt_url_missing".to_string());
    }
    if public
        .mqtt_client_id
        .as_deref()
        .unwrap_or("")
        .trim()
        .is_empty()
    {
        issues.push("mqtt_client_id_missing".to_string());
    }
    if public.runtime_endpoints.is_none() {
        issues.push("runtime_endpoints_missing".to_string());
    }
    if !machine_secret_configured {
        issues.push("machine_secret_missing".to_string());
    }
    if !mqtt_signing_secret_configured {
        issues.push("mqtt_signing_secret_missing".to_string());
    }
    if public.mqtt_username.is_some() && !mqtt_password_configured {
        issues.push("mqtt_password_missing".to_string());
    }
    issues
}

pub fn default_public_config() -> MachinePublicConfig {
    MachinePublicConfig {
        machine_code: None,
        machine_id: None,
        machine_name: None,
        machine_status: None,
        machine_location_label: None,
        api_base_url: env_var("VEM_DEFAULT_API_BASE_URL").unwrap_or_default(),
        mqtt_url: "mqtt://localhost:1883".to_string(),
        mqtt_username: None,
        mqtt_client_id: None,
        hardware_adapter: HardwareAdapterKind::Mock,
        serial_port_path: None,
        lower_controller_usb_identity: Some(SerialPortUsbIdentity {
            vendor_id: "1A86".to_string(),
            product_id: "55D3".to_string(),
            serial_number: None,
        }),
        scanner_adapter: ScannerAdapterKind::Disabled,
        scanner_serial_port_path: None,
        scanner_usb_identity: None,
        scanner_baud_rate: 9600,
        scanner_frame_suffix: vending_core::scanner::ScannerFrameSuffix::Crlf,
        vision_enabled: true,
        vision_ws_url: vending_core::vision::DEFAULT_VISION_WS_URL.to_string(),
        vision_request_timeout_ms: 8_000,
        machine_audio_volume: default_machine_audio_volume(),
        try_on_camera_device_id: None,
        audio_cue_settings: AudioCueSettings::default(),
        presence_audio_enabled: None,
        kiosk_mode: false,
        stock_movement_retention_days: default_stock_movement_retention_days(),
        runtime_endpoints: None,
        hardware_profile: None,
        payment_capability: None,
        provisioning_metadata: None,
    }
}

fn normalize_hex_usb_id(value: String, field: &str) -> Result<String, String> {
    let normalized = value.trim().to_ascii_uppercase();
    if normalized.len() != 4 || !normalized.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return Err(format!("{field} must be a 4-character hexadecimal USB id"));
    }
    Ok(normalized)
}

fn normalize_lower_controller_usb_identity(
    identity: Option<SerialPortUsbIdentity>,
) -> Result<Option<SerialPortUsbIdentity>, String> {
    let Some(mut identity) = identity else {
        return Ok(None);
    };
    identity.vendor_id =
        normalize_hex_usb_id(identity.vendor_id, "lowerControllerUsbIdentity.vendorId")?;
    identity.product_id =
        normalize_hex_usb_id(identity.product_id, "lowerControllerUsbIdentity.productId")?;
    identity.serial_number = identity.serial_number.take().and_then(|value| {
        let value = value.trim().to_string();
        if value.is_empty() {
            None
        } else {
            Some(value)
        }
    });
    Ok(Some(identity))
}

pub fn normalize_public_config(
    mut config: MachinePublicConfig,
) -> Result<MachinePublicConfig, String> {
    let machine_code = config.machine_code.take().and_then(|value| {
        let value = value.trim().to_string();
        if value.is_empty() {
            None
        } else {
            Some(value)
        }
    });
    config.machine_code = machine_code;

    let machine_id = config.machine_id.take().and_then(|value| {
        let value = value.trim().to_string();
        if value.is_empty() {
            None
        } else {
            Some(value)
        }
    });
    config.machine_id = machine_id;

    let machine_name = config.machine_name.take().and_then(|value| {
        let value = value.trim().to_string();
        if value.is_empty() {
            None
        } else {
            Some(value)
        }
    });
    config.machine_name = machine_name;

    let machine_status = config.machine_status.take().and_then(|value| {
        let value = value.trim().to_string();
        if value.is_empty() {
            None
        } else {
            Some(value)
        }
    });
    config.machine_status = machine_status;

    let machine_location_label = config.machine_location_label.take().and_then(|value| {
        let value = value.trim().to_string();
        if value.is_empty() {
            None
        } else {
            Some(value)
        }
    });
    config.machine_location_label = machine_location_label;

    let mqtt_username = config.mqtt_username.take().and_then(|value| {
        let value = value.trim().to_string();
        if value.is_empty() {
            None
        } else {
            Some(value)
        }
    });
    config.mqtt_username = mqtt_username;

    let mqtt_client_id = config.mqtt_client_id.take().and_then(|value| {
        let value = value.trim().to_string();
        if value.is_empty() {
            None
        } else {
            Some(value)
        }
    });
    config.mqtt_client_id = mqtt_client_id;

    let serial_port_path = config.serial_port_path.take().and_then(|value| {
        let value = value.trim().to_string();
        if value.is_empty() {
            None
        } else {
            Some(value)
        }
    });
    config.serial_port_path = serial_port_path;

    config.lower_controller_usb_identity =
        normalize_lower_controller_usb_identity(config.lower_controller_usb_identity.take())?;

    let scanner_serial_port_path = config.scanner_serial_port_path.take().and_then(|value| {
        let value = value.trim().to_string();
        if value.is_empty() {
            None
        } else {
            Some(value)
        }
    });
    config.scanner_serial_port_path = scanner_serial_port_path;

    let vision_ws_url = config.vision_ws_url.trim().to_string();
    config.try_on_camera_device_id = None;

    if config.audio_cue_settings == AudioCueSettings::default()
        && config.presence_audio_enabled == Some(true)
    {
        config.audio_cue_settings = AudioCueSettings {
            enabled: true,
            categories: AudioCueCategorySettings {
                presence: true,
                transaction: false,
            },
        };
    }
    config.presence_audio_enabled = None;

    config.api_base_url = config.api_base_url.trim().trim_end_matches('/').to_string();
    config.mqtt_url = config.mqtt_url.trim().to_string();

    if config.mqtt_url.is_empty() {
        return Err("mqttUrl is required".to_string());
    }
    if matches!(
        &config.hardware_adapter,
        HardwareAdapterKind::Bluetooth | HardwareAdapterKind::VendorSdk
    ) {
        return Err(
            "hardwareAdapter must be mock or serial; bluetooth/vendor_sdk are not planned or implemented"
                .to_string(),
        );
    }
    if matches!(&config.hardware_adapter, HardwareAdapterKind::Serial)
        && config.serial_port_path.is_none()
        && config.lower_controller_usb_identity.is_none()
    {
        return Err(
            "lowerControllerUsbIdentity or serialPortPath is required when hardwareAdapter=serial"
                .to_string(),
        );
    }
    if matches!(&config.scanner_adapter, ScannerAdapterKind::SerialText)
        && config.scanner_serial_port_path.is_none()
        && config.scanner_usb_identity.is_none()
    {
        return Err(
            "scannerSerialPortPath or scannerUsbIdentity is required when scannerAdapter=serial_text".to_string(),
        );
    }
    if !(1000..=30000).contains(&config.vision_request_timeout_ms) {
        return Err("visionRequestTimeoutMs must be between 1000 and 30000".to_string());
    }
    if !config.machine_audio_volume.is_finite() {
        config.machine_audio_volume = default_machine_audio_volume();
    }
    config.machine_audio_volume = config.machine_audio_volume.clamp(0.0, 1.0);
    if vision_ws_url.is_empty() {
        return Err("visionWsUrl is required".to_string());
    }
    config.vision_ws_url = vision_ws_url;
    config.stock_movement_retention_days = config.stock_movement_retention_days.clamp(
        STOCK_MOVEMENT_RETENTION_MIN_DAYS,
        STOCK_MOVEMENT_RETENTION_MAX_DAYS,
    );

    Ok(config)
}

fn default_data_base_dir() -> Result<PathBuf, String> {
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
        if let Ok(value) = env::var("ProgramData") {
            Ok(Path::new(&value).join("VEM").join("vending-daemon"))
        } else {
            Err("resolve ProgramData failed".to_string())
        }
    }
}

fn daemon_config_path(data_dir: &Path) -> PathBuf {
    data_dir.join("machine-config.json")
}

fn env_var(name: &str) -> Option<String> {
    env::var(name).ok().filter(|value| !value.trim().is_empty())
}

pub fn resolve_data_dir(cli_value: Option<PathBuf>) -> Result<PathBuf, String> {
    if let Some(value) = cli_value {
        return Ok(value);
    }
    if let Some(value) = env_var("VEM_DAEMON_DATA_DIR") {
        return Ok(PathBuf::from(value));
    }
    default_data_base_dir()
}

pub struct ConfigStore {
    data_dir: PathBuf,
    state: LocalStateStore,
    secrets: Arc<dyn SecretStore>,
}

impl ConfigStore {
    fn provisioning_persistence_error(error: String) -> String {
        format!("provisioning persistence failed: {error}")
    }

    fn validate_len(value: &str, min: usize, max: usize, message: &str) -> Result<(), String> {
        let len = value.trim().len();
        if len < min || len > max {
            return Err(message.to_string());
        }
        Ok(())
    }

    fn validate_iso_datetime(value: &str, message: &str) -> Result<(), String> {
        chrono::DateTime::parse_from_rfc3339(value).map_err(|_| message.to_string())?;
        Ok(())
    }

    fn validate_payment_option_key(value: &str) -> bool {
        matches!(
            value,
            "qr_code:wechat_pay"
                | "qr_code:alipay"
                | "payment_code:wechat_pay"
                | "payment_code:alipay"
        )
    }

    fn validate_provisioning_profile(profile: &MachineProvisioningProfile) -> Result<(), String> {
        if profile.metadata.profile_version != 1 {
            return Err("unsupported provisioning profile version".to_string());
        }
        uuid::Uuid::parse_str(&profile.machine.id)
            .map_err(|_| "machine identity invalid".to_string())?;
        uuid::Uuid::parse_str(&profile.metadata.claim_code_id)
            .map_err(|_| "claim metadata invalid".to_string())?;
        Self::validate_iso_datetime(&profile.metadata.claimed_at, "claim metadata invalid")?;
        Self::validate_iso_datetime(&profile.metadata.server_time, "claim metadata invalid")?;
        Self::validate_len(
            &profile.machine.code,
            1,
            64,
            "machine code missing from provisioning profile",
        )?;
        Self::validate_len(&profile.machine.name, 1, 128, "machine identity invalid")?;
        if !matches!(
            profile.machine.status.as_str(),
            "online" | "offline" | "maintenance" | "disabled"
        ) {
            return Err("machine identity invalid".to_string());
        }
        if profile.credentials.machine_secret.trim().len() < 32 {
            return Err("machine credential missing from provisioning profile".to_string());
        }
        if profile.credentials.machine_secret.trim().len() > 256 {
            return Err("machine credential missing from provisioning profile".to_string());
        }
        if profile.credentials.machine_secret_version < 1 {
            return Err("machine credential missing from provisioning profile".to_string());
        }
        if profile.credentials.mqtt_signing_secret.trim().len() < 32 {
            return Err("mqtt signing credential missing from provisioning profile".to_string());
        }
        if profile.credentials.mqtt_signing_secret.trim().len() > 256 {
            return Err("mqtt signing credential missing from provisioning profile".to_string());
        }
        if profile.credentials.mqtt_connection.url.trim().is_empty() {
            return Err("mqtt connection url missing from provisioning profile".to_string());
        }
        reqwest::Url::parse(&profile.credentials.mqtt_connection.url)
            .map_err(|_| "mqtt connection url missing from provisioning profile".to_string())?;
        if profile
            .credentials
            .mqtt_connection
            .client_id
            .trim()
            .is_empty()
        {
            return Err("mqtt client id missing from provisioning profile".to_string());
        }
        if profile.credentials.mqtt_connection.client_id.trim().len() > 128 {
            return Err("mqtt client id missing from provisioning profile".to_string());
        }
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
        {
            return Err("runtime endpoints invalid".to_string());
        }
        let expected_machine_path = format!("/api/machines/{}", profile.machine.code);
        let expected_topic_prefix = format!("vem/machines/{}", profile.machine.code);
        if profile.runtime_endpoints.machine_api_base_path != expected_machine_path
            || profile.runtime_endpoints.mqtt_topic_prefix != expected_topic_prefix
        {
            return Err("runtime endpoints do not match machine identity".to_string());
        }
        if profile.hardware_profile.profile != "production"
            || !profile.hardware_profile.controller.required
            || profile.hardware_profile.controller.protocol != "vem-vending-controller"
            || !profile.hardware_profile.payment_scanner.required
        {
            return Err("hardware profile invalid".to_string());
        }
        if profile.payment_capability.profile != "production" {
            return Err("payment capability invalid".to_string());
        }
        Self::validate_iso_datetime(
            &profile.payment_capability.server_time,
            "payment capability invalid",
        )?;
        if profile.payment_capability.options.iter().any(|option| {
            !Self::validate_payment_option_key(&option.option_key)
                || !matches!(option.provider_code.as_str(), "wechat_pay" | "alipay")
                || !matches!(option.method.as_str(), "qr_code" | "payment_code")
                || !matches!(option.icon.as_str(), "wechat" | "alipay")
                || option.provider_code == "mock"
                || option.method == "mock"
                || option.display_name.trim().is_empty()
                || option.display_name.trim().len() > 32
                || option.description.trim().is_empty()
                || option.description.trim().len() > 128
                || option
                    .disabled_reason
                    .as_deref()
                    .is_some_and(|reason| reason.len() > 128)
        }) {
            return Err("payment capability invalid".to_string());
        }
        if profile
            .payment_capability
            .default_option_key
            .as_deref()
            .is_some_and(|key| !Self::validate_payment_option_key(key))
        {
            return Err("payment capability invalid".to_string());
        }
        if profile
            .payment_capability
            .default_provider_code
            .as_deref()
            .is_some_and(|provider| !matches!(provider, "wechat_pay" | "alipay"))
        {
            return Err("payment capability invalid".to_string());
        }
        Ok(())
    }

    pub fn new(data_dir: PathBuf, state: LocalStateStore, secrets: Arc<dyn SecretStore>) -> Self {
        Self {
            data_dir,
            state,
            secrets,
        }
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    pub fn token_path(&self) -> PathBuf {
        self.data_dir.join("ipc-token")
    }

    pub fn logs_path(&self) -> PathBuf {
        self.data_dir.join("logs").join("machine-events.jsonl")
    }

    async fn persist_snapshot(&self, public: &MachinePublicConfig) -> Result<(), String> {
        let machine_secret_configured = self
            .secrets
            .read_secret(crate::secret::MACHINE_SECRET_ACCOUNT)
            .await?
            .is_some();
        let mqtt_signing_secret_configured = self
            .secrets
            .read_secret(crate::secret::MQTT_SIGNING_SECRET_ACCOUNT)
            .await?
            .is_some();
        let mqtt_password_configured = self
            .secrets
            .read_secret(crate::secret::MQTT_PASSWORD_ACCOUNT)
            .await?
            .is_some();

        let value = serde_json::to_value(public)
            .map_err(|error| format!("serialize machine config snapshot failed: {error}"))?;
        self.state
            .save_machine_config_snapshot(
                &value,
                machine_secret_configured,
                mqtt_signing_secret_configured,
                mqtt_password_configured,
            )
            .await
            .map_err(|error| error.to_string())
    }

    pub async fn runtime_secrets(&self) -> Result<MachineRuntimeSecrets, String> {
        let machine_secret = self
            .secrets
            .read_secret(crate::secret::MACHINE_SECRET_ACCOUNT)
            .await?;
        let mqtt_signing_secret = self
            .secrets
            .read_secret(crate::secret::MQTT_SIGNING_SECRET_ACCOUNT)
            .await?;
        let mqtt_password = self
            .secrets
            .read_secret(crate::secret::MQTT_PASSWORD_ACCOUNT)
            .await?;

        Ok(MachineRuntimeSecrets {
            machine_secret,
            mqtt_signing_secret,
            mqtt_password,
        })
    }

    pub async fn load_public_config(&self) -> Result<MachinePublicConfig, String> {
        let path = daemon_config_path(&self.data_dir);
        if !path.exists() {
            let default = default_public_config();
            let normalized = normalize_public_config(default)?;
            self.save_public_config(normalized.clone()).await?;
            return Ok(normalized);
        }
        let content = fs::read_to_string(&path)
            .await
            .map_err(|error| format!("read daemon config failed: {error}"))?;
        let (public, migrated) = parse_persisted_public_config(&content)?;
        let parsed_public = public.clone();
        let public = normalize_public_config(public)?;
        if migrated || public != parsed_public {
            self.write_public_config_file(&public).await?;
        }
        self.persist_snapshot(&public).await?;
        Ok(public)
    }

    pub async fn save_public_config(
        &self,
        config: MachinePublicConfig,
    ) -> Result<MachinePublicRuntimeConfig, String> {
        let normalized = normalize_public_config(config)?;
        self.write_public_config_file(&normalized).await?;
        self.persist_snapshot(&normalized).await?;
        self.public_runtime_config(normalized).await
    }

    async fn write_public_config_file(&self, public: &MachinePublicConfig) -> Result<(), String> {
        fs::create_dir_all(&self.data_dir)
            .await
            .map_err(|error| format!("create daemon data dir failed: {error}"))?;
        fs::create_dir_all(self.data_dir.join("logs"))
            .await
            .map_err(|error| format!("create daemon log dir failed: {error}"))?;
        let payload = serde_json::to_string_pretty(public)
            .map_err(|error| format!("serialize daemon config failed: {error}"))?;
        fs::write(daemon_config_path(&self.data_dir), payload)
            .await
            .map_err(|error| format!("write daemon config failed: {error}"))?;
        Ok(())
    }

    async fn public_runtime_config(
        &self,
        public: MachinePublicConfig,
    ) -> Result<MachinePublicRuntimeConfig, String> {
        Ok(MachinePublicRuntimeConfig {
            public,
            machine_secret_configured: self
                .secrets
                .read_secret(crate::secret::MACHINE_SECRET_ACCOUNT)
                .await?
                .is_some(),
            mqtt_signing_secret_configured: self
                .secrets
                .read_secret(crate::secret::MQTT_SIGNING_SECRET_ACCOUNT)
                .await?
                .is_some(),
            mqtt_password_configured: self
                .secrets
                .read_secret(crate::secret::MQTT_PASSWORD_ACCOUNT)
                .await?
                .is_some(),
            provisioned: false,
            provisioning_issues: Vec::new(),
        }
        .with_provisioning_state())
    }

    pub async fn save_config_update(
        &self,
        request: MachineConfigUpdateRequest,
    ) -> Result<MachinePublicRuntimeConfig, String> {
        if let Some(secrets) = request.secrets {
            if let Some(value) = secrets
                .machine_secret
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty())
            {
                self.secrets
                    .write_secret(crate::secret::MACHINE_SECRET_ACCOUNT, value)
                    .await?;
            }
            if let Some(value) = secrets
                .mqtt_signing_secret
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty())
            {
                self.secrets
                    .write_secret(crate::secret::MQTT_SIGNING_SECRET_ACCOUNT, value)
                    .await?;
            }
            if let Some(value) = secrets
                .mqtt_password
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty())
            {
                self.secrets
                    .write_secret(crate::secret::MQTT_PASSWORD_ACCOUNT, value)
                    .await?;
            }
        }

        self.save_public_config(request.public).await
    }

    pub async fn apply_provisioning_profile(
        &self,
        profile: MachineProvisioningProfile,
    ) -> Result<MachinePublicRuntimeConfig, String> {
        Self::validate_provisioning_profile(&profile)?;
        let mut public = self.load_public_config().await?;
        public.machine_id = Some(profile.machine.id.clone());
        public.machine_code = Some(profile.machine.code.clone());
        public.machine_name = Some(profile.machine.name.clone());
        public.machine_status = Some(profile.machine.status.clone());
        public.machine_location_label = profile.machine.location_label.clone();
        public.mqtt_url = profile.credentials.mqtt_connection.url.clone();
        public.mqtt_username = profile.credentials.mqtt_connection.username.clone();
        public.mqtt_client_id = Some(profile.credentials.mqtt_connection.client_id.clone());
        public.runtime_endpoints = Some(profile.runtime_endpoints.clone());
        public.hardware_profile = Some(profile.hardware_profile.clone());
        public.payment_capability = Some(profile.payment_capability.clone());
        public.provisioning_metadata = Some(profile.metadata.clone());

        self.save_public_config(public.clone())
            .await
            .map_err(Self::provisioning_persistence_error)?;

        self.state
            .put_metadata(
                "machine_provisioning_claim_code_id",
                &profile.metadata.claim_code_id,
            )
            .await
            .map_err(|error| Self::provisioning_persistence_error(error.to_string()))?;
        self.state
            .put_metadata(
                "machine_provisioning_profile_version",
                &profile.metadata.profile_version.to_string(),
            )
            .await
            .map_err(|error| Self::provisioning_persistence_error(error.to_string()))?;
        self.state
            .put_metadata(
                "machine_provisioning_claimed_at",
                &profile.metadata.claimed_at,
            )
            .await
            .map_err(|error| Self::provisioning_persistence_error(error.to_string()))?;

        self.secrets
            .write_secret(
                crate::secret::MACHINE_SECRET_ACCOUNT,
                &profile.credentials.machine_secret,
            )
            .await
            .map_err(Self::provisioning_persistence_error)?;
        self.secrets
            .write_secret(
                crate::secret::MQTT_SIGNING_SECRET_ACCOUNT,
                &profile.credentials.mqtt_signing_secret,
            )
            .await
            .map_err(Self::provisioning_persistence_error)?;
        if let Some(password) = profile.credentials.mqtt_connection.password.as_deref() {
            self.secrets
                .write_secret(crate::secret::MQTT_PASSWORD_ACCOUNT, password)
                .await
                .map_err(Self::provisioning_persistence_error)?;
        }

        self.public_runtime_config(public)
            .await
            .map_err(Self::provisioning_persistence_error)
    }

    pub async fn load_runtime_config(&self) -> Result<MachineRuntimeConfig, String> {
        let public = self.load_public_config().await?;
        let secrets = self.runtime_secrets().await?;

        let runtime = MachineRuntimeConfig {
            public: public.clone(),
            machine_secret_configured: secrets.machine_secret.as_deref().is_some(),
            mqtt_signing_secret_configured: secrets.mqtt_signing_secret.as_deref().is_some(),
            mqtt_password_configured: secrets.mqtt_password.as_deref().is_some(),
            machine_secret: None,
            mqtt_signing_secret: None,
            mqtt_password: None,
        };
        let value = serde_json::to_value(&public)
            .map_err(|error| format!("serialize machine config snapshot failed: {error}"))?;
        self.state
            .save_machine_config_snapshot(
                &value,
                runtime.machine_secret_configured,
                runtime.mqtt_signing_secret_configured,
                runtime.mqtt_password_configured,
            )
            .await
            .map_err(|error| error.to_string())?;
        Ok(runtime)
    }
}

fn parse_persisted_public_config(content: &str) -> Result<(MachinePublicConfig, bool), String> {
    let mut value: serde_json::Value = serde_json::from_str(content)
        .map_err(|error| format!("parse daemon config failed: {error}"))?;
    let mut migrated = false;
    if let serde_json::Value::Object(ref mut object) = value {
        if !object.contains_key("machineAudioVolume") {
            migrated = true;
        }
        if !object.contains_key("machineLocationLabel") {
            if let Some(legacy) = object.remove("machineLocationText") {
                object.insert("machineLocationLabel".to_string(), legacy);
                migrated = true;
            }
        } else {
            migrated = object.remove("machineLocationText").is_some() || migrated;
        }
    }
    serde_json::from_value(value)
        .map(|public| (public, migrated))
        .map_err(|error| format!("parse daemon config failed: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secret::InMemorySecretStore;
    use std::sync::OnceLock;
    use tempfile::TempDir;
    use tokio::sync::Mutex;

    static ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

    struct EnvGuard {
        name: &'static str,
        previous: Option<String>,
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            match &self.previous {
                Some(value) => env::set_var(self.name, value),
                None => env::remove_var(self.name),
            }
        }
    }

    fn set_env_var(name: &'static str, value: &str) -> EnvGuard {
        let previous = env::var(name).ok();
        env::set_var(name, value);
        EnvGuard { name, previous }
    }

    fn remove_env_var(name: &'static str) -> EnvGuard {
        let previous = env::var(name).ok();
        env::remove_var(name);
        EnvGuard { name, previous }
    }

    async fn with_env_lock() -> tokio::sync::MutexGuard<'static, ()> {
        ENV_LOCK.get_or_init(|| Mutex::new(())).lock().await
    }

    #[tokio::test]
    async fn normalize_public_config_validates_required_fields() {
        let serial_missing = MachinePublicConfig {
            serial_port_path: None,
            lower_controller_usb_identity: None,
            hardware_adapter: HardwareAdapterKind::Serial,
            ..default_public_config()
        };
        let err = normalize_public_config(serial_missing).unwrap_err();
        assert_eq!(
            err,
            "lowerControllerUsbIdentity or serialPortPath is required when hardwareAdapter=serial"
        );

        let unsupported_hardware = MachinePublicConfig {
            hardware_adapter: HardwareAdapterKind::Bluetooth,
            ..default_public_config()
        };
        let err = normalize_public_config(unsupported_hardware).unwrap_err();
        assert_eq!(
            err,
            "hardwareAdapter must be mock or serial; bluetooth/vendor_sdk are not planned or implemented"
        );

        let scanner_missing = MachinePublicConfig {
            scanner_adapter: ScannerAdapterKind::SerialText,
            scanner_serial_port_path: None,
            scanner_usb_identity: None,
            ..default_public_config()
        };
        let err = normalize_public_config(scanner_missing).unwrap_err();
        assert_eq!(
            err,
            "scannerSerialPortPath or scannerUsbIdentity is required when scannerAdapter=serial_text"
        );
    }

    #[tokio::test]
    async fn normalize_public_config_clamps_stock_movement_retention_to_at_least_one_day() {
        let config = MachinePublicConfig {
            stock_movement_retention_days: 0,
            ..default_public_config()
        };
        let normalized = normalize_public_config(config).expect("normalize");
        assert_eq!(normalized.stock_movement_retention_days, 1);
    }

    #[tokio::test]
    async fn normalize_public_config_clamps_stock_movement_retention_to_safe_upper_bound() {
        let config = MachinePublicConfig {
            stock_movement_retention_days: i64::MAX,
            ..default_public_config()
        };
        let normalized = normalize_public_config(config).expect("normalize");
        assert_eq!(normalized.stock_movement_retention_days, 366);
    }

    #[test]
    fn machine_config_parses_without_process_management_fields() {
        // After removing visionAutoStart/visionProcessCommand/visionProcessArgs,
        // existing configs on disk (and bringup examples) that omit these fields
        // must still parse correctly.
        let json = serde_json::json!({
            "machineCode": null,
            "apiBaseUrl": "http://127.0.0.1:3000/api",
            "mqttUrl": "mqtt://127.0.0.1:1883",
            "mqttUsername": null,
            "hardwareAdapter": "mock",
            "serialPortPath": null,
            "lowerControllerUsbIdentity": null,
            "scannerAdapter": "disabled",
            "scannerSerialPortPath": null,
            "scannerBaudRate": 9600,
            "scannerFrameSuffix": "crlf",
            "visionEnabled": false,
            "visionWsUrl": "ws://127.0.0.1:7892/ws",
            "visionRequestTimeoutMs": 8000,
            "kioskMode": false
        });
        let config: MachinePublicConfig = serde_json::from_value(json).expect("parse");
        assert!(!config.vision_enabled);
    }

    #[test]
    fn legacy_presence_audio_config_migrates_to_audio_cue_settings() {
        let json = serde_json::json!({
            "machineCode": null,
            "apiBaseUrl": "http://127.0.0.1:3000/api",
            "mqttUrl": "mqtt://127.0.0.1:1883",
            "mqttUsername": null,
            "hardwareAdapter": "mock",
            "serialPortPath": null,
            "lowerControllerUsbIdentity": null,
            "scannerAdapter": "disabled",
            "scannerSerialPortPath": null,
            "scannerBaudRate": 9600,
            "scannerFrameSuffix": "crlf",
            "visionEnabled": false,
            "visionWsUrl": "ws://127.0.0.1:7892/ws",
            "visionRequestTimeoutMs": 8000,
            "presenceAudioEnabled": true,
            "kioskMode": false
        });

        let config: MachinePublicConfig = serde_json::from_value(json).expect("parse");
        let normalized = normalize_public_config(config).expect("normalize");

        assert_eq!(
            normalized.audio_cue_settings,
            AudioCueSettings {
                enabled: true,
                categories: AudioCueCategorySettings {
                    presence: true,
                    transaction: false,
                },
            }
        );
        let serialized = serde_json::to_value(&normalized).expect("serialize");
        assert!(serialized.get("audioCueSettings").is_some());
        assert!(serialized.get("presenceAudioEnabled").is_none());
    }

    #[tokio::test]
    async fn normalize_public_config_preserves_custom_stock_movement_retention_days() {
        let config = MachinePublicConfig {
            stock_movement_retention_days: 90,
            ..default_public_config()
        };
        let normalized = normalize_public_config(config).expect("normalize");
        assert_eq!(normalized.stock_movement_retention_days, 90);
    }

    #[tokio::test]
    async fn save_config_update_accepts_but_drops_legacy_try_on_camera_device_id() {
        let temp = TempDir::new().expect("temp");
        let data_dir = temp.path().join("daemon");
        let state = crate::state::LocalStateStore::open(&data_dir.join("state.db"))
            .await
            .expect("state");
        let store = ConfigStore::new(
            data_dir.clone(),
            state,
            std::sync::Arc::new(InMemorySecretStore::default()),
        );
        let request = MachineConfigUpdateRequest {
            public: MachinePublicConfig {
                try_on_camera_device_id: Some(" try-on-camera-1 ".to_string()),
                ..default_public_config()
            },
            secrets: None,
        };

        let runtime = store
            .save_config_update(request)
            .await
            .expect("save config update");
        let reloaded = store.load_runtime_config().await.expect("reload config");

        assert!(runtime.public.try_on_camera_device_id.is_none());
        assert!(reloaded.public.try_on_camera_device_id.is_none());

        let saved = tokio::fs::read_to_string(daemon_config_path(&data_dir))
            .await
            .expect("read config");
        let saved: serde_json::Value = serde_json::from_str(&saved).expect("json");
        assert!(saved.get("tryOnCameraDeviceId").is_none());
        assert!(saved.get("tryOnCameraLabel").is_none());
    }

    #[tokio::test]
    async fn config_snapshot_is_written_without_secret_plaintext() {
        let temp = TempDir::new().expect("temp");
        let data_dir = temp.path().join("daemon");
        let state = crate::state::LocalStateStore::open(&data_dir.join("state.db"))
            .await
            .expect("state");

        let secrets = InMemorySecretStore::default();
        secrets
            .write_secret("machine_secret", "MACHINE-PLAIN")
            .await
            .expect("write secret");
        secrets
            .write_secret("mqtt_signing_secret", "SIGNING-PLAIN")
            .await
            .expect("write secret");
        secrets
            .write_secret("mqtt_password", "PASSWD-PLAIN")
            .await
            .expect("write secret");
        let store = ConfigStore::new(data_dir.clone(), state.clone(), Arc::new(secrets));
        let runtime = store.load_runtime_config().await.expect("load");
        assert!(runtime.machine_secret.as_deref().is_none());

        let row: String = sqlx::query_scalar(
            "SELECT config_json FROM machine_config ORDER BY rowid DESC LIMIT 1",
        )
        .fetch_one(state.pool())
        .await
        .expect("snapshot");
        let value: serde_json::Value = serde_json::from_str(&row).expect("json");
        let serialized = serde_json::to_string(&value).expect("serialize");
        assert!(!serialized.contains("machineSecret"));
        assert!(!serialized.contains("mqttSigningSecret"));
        assert!(!serialized.contains("mqttPassword"));
        assert_eq!(value["hardwareAdapter"], "mock");
    }

    #[tokio::test]
    async fn first_boot_config_requires_installer_api_base_url_before_claiming() {
        let _env_lock = with_env_lock().await;
        let _default_api = remove_env_var("VEM_DEFAULT_API_BASE_URL");
        let temp = TempDir::new().expect("temp");
        let data_dir = temp.path().join("daemon");
        let state = crate::state::LocalStateStore::open(&data_dir.join("state.db"))
            .await
            .expect("state");
        let store = ConfigStore::new(
            data_dir.clone(),
            state,
            std::sync::Arc::new(InMemorySecretStore::default()),
        );

        let runtime = store.load_runtime_config().await.expect("load config");

        assert!(runtime.public.api_base_url.is_empty());
        assert!(runtime
            .to_public()
            .provisioning_issues
            .contains(&"api_base_url_missing".to_string()));
    }

    #[tokio::test]
    async fn installer_default_api_base_url_seeds_first_boot_config() {
        let _env_lock = with_env_lock().await;
        let _default_api = set_env_var(
            "VEM_DEFAULT_API_BASE_URL",
            " https://staging-api.example.com/api/ ",
        );
        let temp = TempDir::new().expect("temp");
        let data_dir = temp.path().join("daemon");
        let state = crate::state::LocalStateStore::open(&data_dir.join("state.db"))
            .await
            .expect("state");
        let store = ConfigStore::new(
            data_dir.clone(),
            state,
            std::sync::Arc::new(InMemorySecretStore::default()),
        );

        let runtime = store.load_runtime_config().await.expect("load config");

        assert_eq!(
            runtime.public.api_base_url,
            "https://staging-api.example.com/api"
        );
        assert!(!runtime
            .to_public()
            .provisioning_issues
            .contains(&"api_base_url_missing".to_string()));
    }

    #[tokio::test]
    async fn saved_config_api_base_url_overrides_installer_default() {
        let _env_lock = with_env_lock().await;
        let _default_api = set_env_var(
            "VEM_DEFAULT_API_BASE_URL",
            "https://staging-api.example.com/api",
        );
        let temp = TempDir::new().expect("temp");
        let data_dir = temp.path().join("daemon");
        let state = crate::state::LocalStateStore::open(&data_dir.join("state.db"))
            .await
            .expect("state");
        let store = ConfigStore::new(
            data_dir.clone(),
            state,
            std::sync::Arc::new(InMemorySecretStore::default()),
        );
        let saved = MachinePublicConfig {
            api_base_url: " https://production-api.example.com/api/ ".to_string(),
            ..default_public_config()
        };

        store
            .save_public_config(saved)
            .await
            .expect("save override");
        let runtime = store.load_runtime_config().await.expect("load config");

        assert_eq!(
            runtime.public.api_base_url,
            "https://production-api.example.com/api"
        );
    }

    #[tokio::test]
    async fn load_public_config_migrates_legacy_disk_machine_location_text() {
        let temp = TempDir::new().expect("temp");
        let data_dir = temp.path().join("daemon");
        tokio::fs::create_dir_all(&data_dir)
            .await
            .expect("create config dir");
        tokio::fs::write(
            daemon_config_path(&data_dir),
            serde_json::json!({
                "machineCode": "M001",
                "machineLocationText": "Legacy lobby",
                "apiBaseUrl": "http://127.0.0.1:3000/api",
                "mqttUrl": "mqtt://127.0.0.1:1883",
                "mqttUsername": null,
                "hardwareAdapter": "mock",
                "serialPortPath": null,
                "lowerControllerUsbIdentity": null,
                "scannerAdapter": "disabled",
                "scannerSerialPortPath": null,
                "scannerBaudRate": 9600,
                "scannerFrameSuffix": "crlf",
                "visionEnabled": false,
                "visionWsUrl": "ws://127.0.0.1:7892/ws",
                "visionRequestTimeoutMs": 8000,
                "kioskMode": false
            })
            .to_string(),
        )
        .await
        .expect("write legacy config");
        let state = crate::state::LocalStateStore::open(&data_dir.join("state.db"))
            .await
            .expect("state");
        let store = ConfigStore::new(
            data_dir.clone(),
            state,
            std::sync::Arc::new(InMemorySecretStore::default()),
        );

        let public = store.load_public_config().await.expect("load config");

        assert_eq!(
            public.machine_location_label.as_deref(),
            Some("Legacy lobby")
        );
        let saved = tokio::fs::read_to_string(daemon_config_path(&data_dir))
            .await
            .expect("read migrated config");
        assert!(saved.contains("\"machineLocationLabel\""));
        assert!(!saved.contains("machineLocationText"));
    }

    #[tokio::test]
    async fn load_public_config_backfills_default_machine_audio_volume() {
        let temp = TempDir::new().expect("temp");
        let data_dir = temp.path().join("daemon");
        tokio::fs::create_dir_all(&data_dir)
            .await
            .expect("create config dir");
        tokio::fs::write(
            daemon_config_path(&data_dir),
            serde_json::json!({
                "machineCode": "M001",
                "machineLocationLabel": "Lobby",
                "apiBaseUrl": "http://127.0.0.1:3000/api",
                "mqttUrl": "mqtt://127.0.0.1:1883",
                "mqttUsername": null,
                "hardwareAdapter": "mock",
                "serialPortPath": null,
                "lowerControllerUsbIdentity": null,
                "scannerAdapter": "disabled",
                "scannerSerialPortPath": null,
                "scannerBaudRate": 9600,
                "scannerFrameSuffix": "crlf",
                "visionEnabled": false,
                "visionWsUrl": "ws://127.0.0.1:7892/ws",
                "visionRequestTimeoutMs": 8000,
                "audioCueSettings": {
                    "enabled": false,
                    "categories": {
                        "presence": false,
                        "transaction": false
                    }
                },
                "kioskMode": false,
                "stockMovementRetentionDays": 30
            })
            .to_string(),
        )
        .await
        .expect("write config");
        let state = crate::state::LocalStateStore::open(&data_dir.join("state.db"))
            .await
            .expect("state");
        let store = ConfigStore::new(
            data_dir.clone(),
            state,
            std::sync::Arc::new(InMemorySecretStore::default()),
        );

        let public = store.load_public_config().await.expect("load config");

        assert_eq!(public.machine_audio_volume, default_machine_audio_volume());
        let saved = tokio::fs::read_to_string(daemon_config_path(&data_dir))
            .await
            .expect("read backfilled config");
        let saved: serde_json::Value = serde_json::from_str(&saved).expect("json");
        assert_eq!(saved["machineAudioVolume"], default_machine_audio_volume());
    }

    #[tokio::test]
    async fn load_public_config_backfills_clamped_machine_audio_volume() {
        let temp = TempDir::new().expect("temp");
        let data_dir = temp.path().join("daemon");
        tokio::fs::create_dir_all(&data_dir)
            .await
            .expect("create config dir");
        tokio::fs::write(
            daemon_config_path(&data_dir),
            serde_json::json!({
                "machineCode": "M001",
                "machineLocationLabel": "Lobby",
                "apiBaseUrl": "http://127.0.0.1:3000/api",
                "mqttUrl": "mqtt://127.0.0.1:1883",
                "mqttUsername": null,
                "hardwareAdapter": "mock",
                "serialPortPath": null,
                "lowerControllerUsbIdentity": null,
                "scannerAdapter": "disabled",
                "scannerSerialPortPath": null,
                "scannerBaudRate": 9600,
                "scannerFrameSuffix": "crlf",
                "visionEnabled": false,
                "visionWsUrl": "ws://127.0.0.1:7892/ws",
                "visionRequestTimeoutMs": 8000,
                "machineAudioVolume": 1.25,
                "audioCueSettings": {
                    "enabled": false,
                    "categories": {
                        "presence": false,
                        "transaction": false
                    }
                },
                "kioskMode": false,
                "stockMovementRetentionDays": 30
            })
            .to_string(),
        )
        .await
        .expect("write config");
        let state = crate::state::LocalStateStore::open(&data_dir.join("state.db"))
            .await
            .expect("state");
        let store = ConfigStore::new(
            data_dir.clone(),
            state,
            std::sync::Arc::new(InMemorySecretStore::default()),
        );

        let public = store.load_public_config().await.expect("load config");

        assert_eq!(public.machine_audio_volume, 1.0);
        let saved = tokio::fs::read_to_string(daemon_config_path(&data_dir))
            .await
            .expect("read backfilled config");
        let saved: serde_json::Value = serde_json::from_str(&saved).expect("json");
        assert_eq!(saved["machineAudioVolume"], 1.0);
    }

    #[tokio::test]
    async fn save_config_update_saves_secrets_flags_and_redacts_runtime_response() {
        let temp = TempDir::new().expect("temp");
        let data_dir = temp.path().join("daemon");
        let state = crate::state::LocalStateStore::open(&data_dir.join("state.db"))
            .await
            .expect("state");
        let secrets = InMemorySecretStore::default();
        let store = ConfigStore::new(
            data_dir.clone(),
            state.clone(),
            std::sync::Arc::new(secrets),
        );
        let request = MachineConfigUpdateRequest {
            public: default_public_config(),
            secrets: Some(MachineConfigSecretsUpdate {
                machine_secret: Some("machine-secret".to_string()),
                mqtt_signing_secret: Some("signing-secret".to_string()),
                mqtt_password: Some("password".to_string()),
            }),
        };
        let runtime = store
            .save_config_update(request)
            .await
            .expect("save config update");
        assert!(runtime.machine_secret_configured);
        assert!(runtime.mqtt_signing_secret_configured);
        assert!(runtime.mqtt_password_configured);

        let summary: String = sqlx::query_scalar(
            "SELECT config_json FROM machine_config ORDER BY rowid DESC LIMIT 1",
        )
        .fetch_one(state.pool())
        .await
        .expect("snapshot");
        let value: serde_json::Value = serde_json::from_str(&summary).expect("json");
        let serialized = serde_json::to_string(&value).expect("serialize snapshot");
        assert!(!serialized.contains("\"machineSecret\""));
        assert!(!serialized.contains("\"mqttSigningSecret\""));
        assert!(!serialized.contains("\"mqttPassword\""));

        let response = serde_json::to_string(&runtime).expect("serialize response");
        assert!(!response.contains("\"machineSecret\""));
        assert!(!response.contains("\"mqttSigningSecret\""));
        assert!(!response.contains("\"mqttPassword\""));
    }

    #[tokio::test]
    async fn save_config_update_round_trips_audio_cue_settings() {
        let temp = TempDir::new().expect("temp");
        let data_dir = temp.path().join("daemon");
        let state = crate::state::LocalStateStore::open(&data_dir.join("state.db"))
            .await
            .expect("state");
        let store = ConfigStore::new(
            data_dir.clone(),
            state,
            std::sync::Arc::new(InMemorySecretStore::default()),
        );
        let request = MachineConfigUpdateRequest {
            public: MachinePublicConfig {
                audio_cue_settings: AudioCueSettings {
                    enabled: true,
                    categories: AudioCueCategorySettings {
                        presence: false,
                        transaction: true,
                    },
                },
                ..default_public_config()
            },
            secrets: None,
        };

        let runtime = store
            .save_config_update(request)
            .await
            .expect("save config update");
        let reloaded = store.load_runtime_config().await.expect("reload config");

        assert_eq!(
            runtime.public.audio_cue_settings,
            AudioCueSettings {
                enabled: true,
                categories: AudioCueCategorySettings {
                    presence: false,
                    transaction: true,
                },
            }
        );
        assert_eq!(
            reloaded.public.audio_cue_settings,
            runtime.public.audio_cue_settings
        );

        let saved = tokio::fs::read_to_string(daemon_config_path(&data_dir))
            .await
            .expect("read config");
        let saved: serde_json::Value = serde_json::from_str(&saved).expect("json");
        assert_eq!(saved["audioCueSettings"]["enabled"], true);
        assert_eq!(saved["audioCueSettings"]["categories"]["presence"], false);
        assert_eq!(saved["audioCueSettings"]["categories"]["transaction"], true);
        assert!(saved.get("presenceAudioEnabled").is_none());
    }

    #[tokio::test]
    async fn save_config_update_round_trips_machine_audio_volume() {
        let temp = TempDir::new().expect("temp");
        let data_dir = temp.path().join("daemon");
        let state = crate::state::LocalStateStore::open(&data_dir.join("state.db"))
            .await
            .expect("state");
        let store = ConfigStore::new(
            data_dir.clone(),
            state,
            std::sync::Arc::new(InMemorySecretStore::default()),
        );
        let request = MachineConfigUpdateRequest {
            public: MachinePublicConfig {
                machine_audio_volume: 0.35,
                ..default_public_config()
            },
            secrets: None,
        };

        let runtime = store
            .save_config_update(request)
            .await
            .expect("save config update");
        let reloaded = store.load_runtime_config().await.expect("reload config");

        assert_eq!(runtime.public.machine_audio_volume, 0.35);
        assert_eq!(reloaded.public.machine_audio_volume, 0.35);

        let saved = tokio::fs::read_to_string(daemon_config_path(&data_dir))
            .await
            .expect("read config");
        let saved: serde_json::Value = serde_json::from_str(&saved).expect("json");
        assert_eq!(saved["machineAudioVolume"], 0.35);
    }

    #[test]
    fn config_update_accepts_snake_case_secret_aliases() {
        let request: MachineConfigUpdateRequest = serde_json::from_value(serde_json::json!({
            "public": default_public_config(),
            "secrets": {
                "machine_secret": "machine-secret",
                "mqtt_signing_secret": "signing-secret",
                "mqtt_password": "password"
            }
        }))
        .expect("request");

        let secrets = request.secrets.expect("secrets");
        assert_eq!(secrets.machine_secret.as_deref(), Some("machine-secret"));
        assert_eq!(
            secrets.mqtt_signing_secret.as_deref(),
            Some("signing-secret")
        );
        assert_eq!(secrets.mqtt_password.as_deref(), Some("password"));
    }
}
