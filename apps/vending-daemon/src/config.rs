use std::{
    env,
    path::{Path, PathBuf},
    sync::Arc,
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use hmac::{Hmac, Mac};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::fs;
use vending_core::serial::SerialPortUsbIdentity;

use crate::{secret::SecretStore, state::LocalStateStore};

const MAINTENANCE_PIN_KDF_ALGORITHM: &str = "pbkdf2_hmac_sha256";
const MAINTENANCE_PIN_KDF_MIN_ITERATIONS: u32 = 120_000;
const MAINTENANCE_PIN_KDF_MAX_ITERATIONS: u32 = 1_000_000;
const MAINTENANCE_PIN_KDF_SALT_BYTES: usize = 16;
const MAINTENANCE_PIN_KDF_DIGEST_BYTES: usize = 32;
const LEGACY_MAINTENANCE_PIN_MIN_DIGITS: usize = 4;
const LEGACY_MAINTENANCE_PIN_MAX_DIGITS: usize = 12;

/// A Factory-provisioned verifier. The protected secret store holds this
/// salted derivation record, never the operator's original maintenance PIN.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MaintenancePinVerifier {
    version: u8,
    algorithm: String,
    iterations: u32,
    salt: String,
    digest: String,
}

/// The Factory bootstrap capability is random high-entropy material rather
/// than an operator PIN. Only its SHA-256 verifier enters the daemon secret
/// store; the raw value is readable solely by the designated local
/// maintenance account and is deleted once exchanged for an in-memory
/// maintenance session.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FactoryBootstrapCapabilityVerifier {
    version: u8,
    algorithm: String,
    digest: String,
}

impl FactoryBootstrapCapabilityVerifier {
    fn valid(&self) -> bool {
        self.version == 1
            && self.algorithm == "sha256"
            && self.digest.len() == 64
            && self.digest.bytes().all(|byte| byte.is_ascii_hexdigit())
            && self.digest.bytes().all(|byte| !byte.is_ascii_uppercase())
    }

    fn verifies(&self, capability: &str) -> bool {
        if !self.valid()
            || capability.len() != 43
            || !capability
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return false;
        }
        let digest = Sha256::digest(capability.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        constant_time_bytes_equal(digest.as_bytes(), self.digest.as_bytes())
    }
}

impl MaintenancePinVerifier {
    fn decode(&self) -> Option<(Vec<u8>, Vec<u8>)> {
        if self.version != 1
            || self.algorithm != MAINTENANCE_PIN_KDF_ALGORITHM
            || !(MAINTENANCE_PIN_KDF_MIN_ITERATIONS..=MAINTENANCE_PIN_KDF_MAX_ITERATIONS)
                .contains(&self.iterations)
        {
            return None;
        }
        let salt = STANDARD.decode(self.salt.as_bytes()).ok()?;
        let digest = STANDARD.decode(self.digest.as_bytes()).ok()?;
        if STANDARD.encode(&salt) != self.salt || STANDARD.encode(&digest) != self.digest {
            return None;
        }
        if salt.len() != MAINTENANCE_PIN_KDF_SALT_BYTES
            || digest.len() != MAINTENANCE_PIN_KDF_DIGEST_BYTES
        {
            return None;
        }
        Some((salt, digest))
    }

    fn verify(&self, supplied: &str) -> bool {
        if supplied.is_empty() || supplied.len() > 128 {
            return false;
        }
        let Some((salt, expected)) = self.decode() else {
            return false;
        };
        let actual = pbkdf2_hmac_sha256(supplied.as_bytes(), &salt, self.iterations);
        constant_time_bytes_equal(&actual, &expected)
    }
}

fn legacy_raw_maintenance_pin(value: &str) -> bool {
    let length = value.len();
    (LEGACY_MAINTENANCE_PIN_MIN_DIGITS..=LEGACY_MAINTENANCE_PIN_MAX_DIGITS).contains(&length)
        && value.as_bytes().iter().all(u8::is_ascii_digit)
}

fn new_maintenance_pin_verifier(pin: &str) -> Result<MaintenancePinVerifier, String> {
    let mut salt = [0u8; MAINTENANCE_PIN_KDF_SALT_BYTES];
    getrandom::getrandom(&mut salt)
        .map_err(|_| "generate maintenance PIN verifier randomness failed".to_string())?;
    let digest = pbkdf2_hmac_sha256(pin.as_bytes(), &salt, MAINTENANCE_PIN_KDF_MIN_ITERATIONS);
    Ok(MaintenancePinVerifier {
        version: 1,
        algorithm: MAINTENANCE_PIN_KDF_ALGORITHM.to_string(),
        iterations: MAINTENANCE_PIN_KDF_MIN_ITERATIONS,
        salt: STANDARD.encode(salt),
        digest: STANDARD.encode(digest),
    })
}

fn pbkdf2_hmac_sha256(password: &[u8], salt: &[u8], iterations: u32) -> [u8; 32] {
    // PBKDF2 block 1 is sufficient for the fixed 256-bit verifier digest.
    let mut initial = Vec::with_capacity(salt.len() + 4);
    initial.extend_from_slice(salt);
    initial.extend_from_slice(&1u32.to_be_bytes());
    let mut mac =
        Hmac::<Sha256>::new_from_slice(password).expect("HMAC-SHA-256 accepts any key length");
    mac.update(&initial);
    let mut previous = mac.finalize().into_bytes().to_vec();
    let mut derived = previous.clone();
    for _ in 1..iterations {
        let mut mac =
            Hmac::<Sha256>::new_from_slice(password).expect("HMAC-SHA-256 accepts any key length");
        mac.update(&previous);
        previous = mac.finalize().into_bytes().to_vec();
        for (left, right) in derived.iter_mut().zip(&previous) {
            *left ^= *right;
        }
    }
    let mut output = [0u8; MAINTENANCE_PIN_KDF_DIGEST_BYTES];
    output.copy_from_slice(&derived);
    output
}

fn constant_time_bytes_equal(left: &[u8], right: &[u8]) -> bool {
    let mut difference = (left.len() ^ right.len()) as u8;
    for index in 0..left.len().min(right.len()) {
        difference |= left[index] ^ right[index];
    }
    difference == 0
}

fn deserialize_present_option<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AudioCueCategorySettings {
    #[serde(default = "default_audio_cue_enabled")]
    pub presence: bool,
    #[serde(default = "default_audio_cue_enabled")]
    pub transaction: bool,
}

impl Default for AudioCueCategorySettings {
    fn default() -> Self {
        Self {
            presence: default_audio_cue_enabled(),
            transaction: default_audio_cue_enabled(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AudioCueSettings {
    #[serde(default = "default_audio_cue_enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub categories: AudioCueCategorySettings,
}

impl Default for AudioCueSettings {
    fn default() -> Self {
        Self {
            enabled: default_audio_cue_enabled(),
            categories: AudioCueCategorySettings::default(),
        }
    }
}

fn default_audio_cue_enabled() -> bool {
    false
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
    pub api_base_url: String,
    pub runtime_endpoints: ProvisioningRuntimeEndpoints,
    pub hardware_profile: ProductionMachineHardwareProfile,
    pub hardware_slot_topology: HardwareSlotTopologyIdentity,
    pub payment_capability: ProductionMachinePaymentCapability,
    pub provisioning_profile: String,
    pub maintenance: ProvisioningMaintenanceIdentity,
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
pub struct ProvisioningMaintenancePeer {
    pub public_key: String,
    pub tunnel_address: String,
    pub address: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct MaintenanceRoleRoutes {
    pub relay: String,
    pub runner: String,
    pub maintainer: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct ProvisioningMaintenanceIdentity {
    pub public_key: String,
    pub tunnel_address: String,
    pub address: String,
    pub endpoint: String,
    pub relay: ProvisioningMaintenancePeer,
    pub role_routes: MaintenanceRoleRoutes,
    #[serde(default)]
    pub reclaim_expires_at: Option<String>,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeHardwareMode {
    Production,
    Simulated,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct HardwareSlotTopologyIdentity {
    pub identity: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct FactoryRuntimeManifest {
    pub layout_version: u32,
    pub environment: String,
    pub provisioning_endpoint: String,
    pub hardware_mode: RuntimeHardwareMode,
    pub hardware_model: String,
    pub hardware_slot_topology: HardwareSlotTopologyIdentity,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct LocalBringUpSettings {
    #[serde(default)]
    pub environment: Option<String>,
    #[serde(default)]
    pub provisioning_endpoint_override: Option<String>,
    #[serde(default)]
    pub network_profile: Option<String>,
    #[serde(default)]
    pub hardware_adapter: Option<HardwareAdapterKind>,
    #[serde(default)]
    pub serial_port_path: Option<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_present_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub lower_controller_usb_identity: Option<Option<SerialPortUsbIdentity>>,
    #[serde(default)]
    pub scanner_adapter: Option<ScannerAdapterKind>,
    #[serde(default)]
    pub scanner_serial_port_path: Option<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_present_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub scanner_usb_identity: Option<Option<SerialPortUsbIdentity>>,
    #[serde(default)]
    pub scanner_baud_rate: Option<u32>,
    #[serde(default)]
    pub scanner_frame_suffix: Option<vending_core::scanner::ScannerFrameSuffix>,
    #[serde(default)]
    pub vision_enabled: Option<bool>,
    #[serde(default)]
    pub vision_ws_url: Option<String>,
    #[serde(default)]
    pub vision_request_timeout_ms: Option<u64>,
    #[serde(default)]
    pub machine_audio_volume: Option<f64>,
    #[serde(default)]
    pub try_on_camera_device_id: Option<String>,
    #[serde(default)]
    pub audio_cue_settings: Option<AudioCueSettings>,
    #[serde(default)]
    pub kiosk_mode: Option<bool>,
    #[serde(default)]
    pub stock_movement_retention_days: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct ProvisioningProfileCacheSummary {
    pub profile_version: i64,
    pub machine_id: String,
    pub machine_code: String,
    pub machine_name: String,
    pub machine_status: String,
    #[serde(default)]
    pub machine_location_label: Option<String>,
    pub claimed_at: String,
    pub api_base_url: String,
    pub mqtt_url: String,
    pub mqtt_client_id: String,
    #[serde(default)]
    pub mqtt_username: Option<String>,
    pub runtime_endpoints: ProvisioningRuntimeEndpoints,
    pub hardware_profile: ProductionMachineHardwareProfile,
    #[serde(default)]
    pub hardware_slot_topology: Option<HardwareSlotTopologyIdentity>,
    pub payment_capability: ProductionMachinePaymentCapability,
    pub provisioning_metadata: ProvisioningMetadata,
    #[serde(default)]
    pub provisioning_profile: Option<String>,
    #[serde(default)]
    pub maintenance: Option<ProvisioningMaintenanceIdentity>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HardwareSlotTopologyReadiness {
    pub ready: bool,
    pub code: String,
    pub message: String,
    pub local: Option<HardwareSlotTopologyIdentity>,
    pub platform: Option<HardwareSlotTopologyIdentity>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeConfigurationState {
    pub factory_manifest: bool,
    pub local_bring_up_settings: bool,
    pub provisioning_profile_cache: bool,
    pub machine_secret_configured: bool,
    pub mqtt_signing_secret_configured: bool,
    pub mqtt_password_configured: bool,
    pub maintenance_pin_configured: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeConfigurationSummary {
    pub configured_state: RuntimeConfigurationState,
    pub secret_store: crate::secret::SecretStoreStatus,
    pub factory_manifest: Option<FactoryRuntimeManifest>,
    pub local_bring_up_settings: Option<LocalBringUpSettings>,
    pub provisioning_profile_cache: Option<ProvisioningProfileCacheSummary>,
    pub effective_public: MachinePublicConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MachineRuntimeConfig {
    pub public: MachinePublicConfig,
    pub machine_secret_configured: bool,
    pub mqtt_signing_secret_configured: bool,
    pub mqtt_password_configured: bool,
    pub maintenance_pin_configured: bool,
    pub machine_secret: Option<String>,
    pub mqtt_signing_secret: Option<String>,
    pub mqtt_password: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MachineReportedRuntimeConfiguration {
    pub audio_cues: MachineReportedAudioCueConfiguration,
    pub audio_volume: u8,
    pub vision_recommendations_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MachineReportedAudioCueConfiguration {
    pub enabled: bool,
    pub presence_enabled: bool,
    pub transaction_enabled: bool,
}

pub fn project_reported_runtime_configuration(
    public: &MachinePublicConfig,
) -> MachineReportedRuntimeConfiguration {
    MachineReportedRuntimeConfiguration {
        audio_cues: MachineReportedAudioCueConfiguration {
            enabled: public.audio_cue_settings.enabled,
            presence_enabled: public.audio_cue_settings.categories.presence,
            transaction_enabled: public.audio_cue_settings.categories.transaction,
        },
        audio_volume: (public.machine_audio_volume.clamp(0.0, 1.0) * 100.0).round() as u8,
        vision_recommendations_enabled: public.vision_enabled,
    }
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
            self.maintenance_pin_configured,
        );
        MachinePublicRuntimeConfig {
            public: self.public.clone(),
            machine_secret_configured: self.machine_secret_configured,
            mqtt_signing_secret_configured: self.mqtt_signing_secret_configured,
            mqtt_password_configured: self.mqtt_password_configured,
            maintenance_pin_configured: self.maintenance_pin_configured,
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
    pub maintenance_pin_configured: bool,
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
            self.maintenance_pin_configured,
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
    maintenance_pin_configured: bool,
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
    if !maintenance_pin_configured {
        issues.push("maintenance_pin_not_configured".to_string());
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

fn normalize_optional_string(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn normalize_required_string(value: String, field: &str) -> Result<String, String> {
    let value = value.trim().to_string();
    if value.is_empty() {
        return Err(format!("{field} is required"));
    }
    Ok(value)
}

fn normalize_http_endpoint(value: String, field: &str) -> Result<String, String> {
    let value = normalize_required_string(value, field)?
        .trim_end_matches('/')
        .to_string();
    let parsed = reqwest::Url::parse(&value).map_err(|_| format!("{field} must be a URL"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!("{field} must be an http(s) URL"));
    }
    Ok(value)
}

fn normalize_factory_manifest(
    mut manifest: FactoryRuntimeManifest,
) -> Result<FactoryRuntimeManifest, String> {
    if manifest.layout_version != 1 {
        return Err("unsupported factory manifest layout version".to_string());
    }
    manifest.environment = normalize_required_string(manifest.environment, "environment")?;
    manifest.provisioning_endpoint =
        normalize_http_endpoint(manifest.provisioning_endpoint, "provisioningEndpoint")?;
    manifest.hardware_model = normalize_required_string(manifest.hardware_model, "hardwareModel")?;
    manifest.hardware_slot_topology.identity = normalize_required_string(
        manifest.hardware_slot_topology.identity,
        "hardwareSlotTopology.identity",
    )?;
    manifest.hardware_slot_topology.version = normalize_required_string(
        manifest.hardware_slot_topology.version,
        "hardwareSlotTopology.version",
    )?;
    Ok(manifest)
}

fn normalize_hardware_slot_topology(
    mut topology: HardwareSlotTopologyIdentity,
    field: &str,
) -> Result<HardwareSlotTopologyIdentity, String> {
    topology.identity = normalize_required_string(topology.identity, &format!("{field}.identity"))?;
    topology.version = normalize_required_string(topology.version, &format!("{field}.version"))?;
    Ok(topology)
}

fn normalize_local_bring_up_settings(
    mut settings: LocalBringUpSettings,
) -> Result<LocalBringUpSettings, String> {
    settings.environment = normalize_optional_string(settings.environment);
    settings.network_profile = normalize_optional_string(settings.network_profile);
    settings.provisioning_endpoint_override = settings
        .provisioning_endpoint_override
        .map(|value| normalize_http_endpoint(value, "provisioningEndpointOverride"))
        .transpose()?;
    Ok(settings)
}

fn apply_local_bring_up_settings_to_public(
    public: &mut MachinePublicConfig,
    settings: &LocalBringUpSettings,
) {
    if let Some(endpoint) = settings.provisioning_endpoint_override.as_ref() {
        public.api_base_url = endpoint.clone();
    }
    if let Some(value) = settings.hardware_adapter.clone() {
        public.hardware_adapter = value;
    }
    if settings.serial_port_path.is_some() {
        public.serial_port_path = settings.serial_port_path.clone();
    }
    if let Some(value) = settings.lower_controller_usb_identity.as_ref() {
        public.lower_controller_usb_identity = value.clone();
    }
    if let Some(value) = settings.scanner_adapter.clone() {
        public.scanner_adapter = value;
    }
    if settings.scanner_serial_port_path.is_some() {
        public.scanner_serial_port_path = settings.scanner_serial_port_path.clone();
    }
    if let Some(value) = settings.scanner_usb_identity.as_ref() {
        public.scanner_usb_identity = value.clone();
    }
    if let Some(value) = settings.scanner_baud_rate {
        public.scanner_baud_rate = value;
    }
    if let Some(value) = settings.scanner_frame_suffix {
        public.scanner_frame_suffix = value;
    }
    if let Some(value) = settings.vision_enabled {
        public.vision_enabled = value;
    }
    if let Some(value) = settings.vision_ws_url.as_ref() {
        public.vision_ws_url = value.clone();
    }
    if let Some(value) = settings.vision_request_timeout_ms {
        public.vision_request_timeout_ms = value;
    }
    if let Some(value) = settings.machine_audio_volume {
        public.machine_audio_volume = value;
    }
    if settings.try_on_camera_device_id.is_some() {
        public.try_on_camera_device_id = settings.try_on_camera_device_id.clone();
    }
    if let Some(value) = settings.audio_cue_settings.clone() {
        public.audio_cue_settings = value;
    }
    if let Some(value) = settings.kiosk_mode {
        public.kiosk_mode = value;
    }
    if let Some(value) = settings.stock_movement_retention_days {
        public.stock_movement_retention_days = value;
    }
}

fn normalize_provisioning_profile_cache_summary(
    mut summary: ProvisioningProfileCacheSummary,
) -> Result<ProvisioningProfileCacheSummary, String> {
    if summary.profile_version < 1 {
        return Err("provisioning profile cache summary version invalid".to_string());
    }
    uuid::Uuid::parse_str(summary.machine_id.trim())
        .map_err(|_| "provisioning profile cache machine identity invalid".to_string())?;
    summary.machine_id = summary.machine_id.trim().to_string();
    summary.machine_code = normalize_required_string(summary.machine_code, "machineCode")?;
    summary.machine_name = normalize_required_string(summary.machine_name, "machineName")?;
    summary.machine_status = normalize_required_string(summary.machine_status, "machineStatus")?;
    summary.machine_location_label = normalize_optional_string(summary.machine_location_label);
    validate_machine_status(&summary.machine_status)?;
    ConfigStore::validate_iso_datetime(&summary.claimed_at, "claimedAt invalid")?;
    summary.api_base_url = normalize_http_endpoint(summary.api_base_url, "apiBaseUrl")?;
    summary.mqtt_url = normalize_required_string(summary.mqtt_url, "mqttUrl")?;
    reqwest::Url::parse(&summary.mqtt_url).map_err(|_| "mqttUrl must be a URL".to_string())?;
    summary.mqtt_client_id = normalize_required_string(summary.mqtt_client_id, "mqttClientId")?;
    summary.mqtt_username = normalize_optional_string(summary.mqtt_username);
    if summary.runtime_endpoints.api_base_path != "/api"
        || summary.runtime_endpoints.machine_auth_token_path != "/api/machine-auth/token"
    {
        return Err("provisioning profile cache runtime endpoints invalid".to_string());
    }
    let expected_machine_path = format!("/api/machines/{}", summary.machine_code);
    let expected_topic_prefix = format!("vem/machines/{}", summary.machine_code);
    if summary.runtime_endpoints.machine_api_base_path != expected_machine_path
        || summary.runtime_endpoints.mqtt_topic_prefix != expected_topic_prefix
    {
        return Err(
            "provisioning profile cache runtime endpoints do not match machine identity"
                .to_string(),
        );
    }
    if summary.hardware_profile.profile != "production"
        || !summary.hardware_profile.controller.required
        || summary.hardware_profile.controller.protocol != "vem-vending-controller"
        || !summary.hardware_profile.payment_scanner.required
    {
        return Err("provisioning profile cache hardware profile invalid".to_string());
    }
    summary.hardware_slot_topology = summary
        .hardware_slot_topology
        .map(|topology| {
            normalize_hardware_slot_topology(
                topology,
                "provisioning profile cache hardware slot topology",
            )
        })
        .transpose()?;
    if summary.payment_capability.profile != "production" {
        return Err("provisioning profile cache payment capability invalid".to_string());
    }
    ConfigStore::validate_iso_datetime(
        &summary.payment_capability.server_time,
        "provisioning profile cache payment capability invalid",
    )?;
    if summary.provisioning_metadata.profile_version != summary.profile_version
        || summary.provisioning_metadata.claimed_at != summary.claimed_at
    {
        return Err("provisioning profile cache metadata invalid".to_string());
    }
    uuid::Uuid::parse_str(&summary.provisioning_metadata.claim_code_id)
        .map_err(|_| "provisioning profile cache metadata invalid".to_string())?;
    ConfigStore::validate_iso_datetime(
        &summary.provisioning_metadata.server_time,
        "provisioning profile cache metadata invalid",
    )?;
    Ok(summary)
}

fn validate_machine_status(value: &str) -> Result<(), String> {
    if !matches!(value, "online" | "offline" | "maintenance" | "disabled") {
        return Err("machineStatus invalid".to_string());
    }
    Ok(())
}

fn validate_maintenance_identity(identity: &ProvisioningMaintenanceIdentity) -> Result<(), String> {
    for (label, key) in [
        ("maintenance public key", &identity.public_key),
        ("maintenance relay public key", &identity.relay.public_key),
    ] {
        let decoded = STANDARD
            .decode(key)
            .map_err(|_| format!("{label} invalid"))?;
        if decoded.len() != 32 {
            return Err(format!("{label} invalid"));
        }
    }
    let machine_address = identity
        .tunnel_address
        .parse::<std::net::Ipv4Addr>()
        .map_err(|_| "maintenance address invalid".to_string())?;
    let relay_address = identity
        .relay
        .tunnel_address
        .parse::<std::net::Ipv4Addr>()
        .map_err(|_| "maintenance address invalid".to_string())?;
    if identity.address != format!("{machine_address}/32")
        || identity.relay.address != format!("{relay_address}/32")
        || identity.role_routes.relay != identity.relay.address
    {
        return Err("maintenance address invalid".to_string());
    }
    if !valid_wireguard_endpoint(&identity.endpoint) {
        return Err("maintenance endpoint invalid".to_string());
    }
    let machine_route = parse_canonical_ipv4_cidr(&identity.address, 32)
        .ok_or_else(|| "maintenance role routes invalid".to_string())?;
    let relay_route = parse_canonical_ipv4_cidr(&identity.relay.address, 32)
        .ok_or_else(|| "maintenance role routes invalid".to_string())?;
    let runner_route = parse_canonical_ipv4_cidr(&identity.role_routes.runner, 24)
        .ok_or_else(|| "maintenance role routes invalid".to_string())?;
    let maintainer_route = parse_canonical_ipv4_cidr(&identity.role_routes.maintainer, 24)
        .ok_or_else(|| "maintenance role routes invalid".to_string())?;
    if ipv4_cidrs_overlap(runner_route, maintainer_route)
        || ipv4_cidrs_overlap(runner_route, machine_route)
        || ipv4_cidrs_overlap(maintainer_route, machine_route)
        || ipv4_cidrs_overlap(runner_route, relay_route)
        || ipv4_cidrs_overlap(maintainer_route, relay_route)
    {
        return Err("maintenance role routes invalid".to_string());
    }
    Ok(())
}

#[derive(Clone, Copy)]
struct ParsedIpv4Cidr {
    network: u32,
    broadcast: u32,
}

fn parse_canonical_ipv4_cidr(value: &str, minimum_prefix: u32) -> Option<ParsedIpv4Cidr> {
    let (address, prefix) = value.split_once('/')?;
    let address = address.parse::<std::net::Ipv4Addr>().ok()?;
    let prefix = prefix.parse::<u32>().ok()?;
    if prefix < minimum_prefix || prefix > 32 {
        return None;
    }
    let address_number = u32::from(address);
    let mask = if prefix == 0 {
        0
    } else {
        u32::MAX << (32 - prefix)
    };
    let network = address_number & mask;
    if network != address_number || value != format!("{address}/{prefix}") {
        return None;
    }
    Some(ParsedIpv4Cidr {
        network,
        broadcast: network | !mask,
    })
}

fn ipv4_cidrs_overlap(a: ParsedIpv4Cidr, b: ParsedIpv4Cidr) -> bool {
    a.network <= b.broadcast && b.network <= a.broadcast
}

fn valid_wireguard_endpoint(value: &str) -> bool {
    let (host, port) = if let Some(rest) = value.strip_prefix('[') {
        let Some((host, port)) = rest.split_once("]:") else {
            return false;
        };
        if host.parse::<std::net::Ipv6Addr>().is_err() {
            return false;
        }
        (host, port)
    } else {
        let Some((host, port)) = value.rsplit_once(':') else {
            return false;
        };
        if host.contains(':')
            || (host.parse::<std::net::Ipv4Addr>().is_err()
                && !host.split('.').all(|label| {
                    !label.is_empty()
                        && label.len() <= 63
                        && label
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
                        && !label.starts_with('-')
                        && !label.ends_with('-')
                }))
        {
            return false;
        }
        (host, port)
    };
    !host.is_empty() && port.parse::<u16>().is_ok_and(|port| port > 0)
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

    if let Some(presence_audio_enabled) = config.presence_audio_enabled {
        if config.audio_cue_settings == AudioCueSettings::default() {
            config.audio_cue_settings = AudioCueSettings {
                enabled: presence_audio_enabled,
                categories: AudioCueCategorySettings {
                    presence: presence_audio_enabled,
                    transaction: false,
                },
            };
        }
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

fn runtime_root_dir(data_dir: &Path) -> PathBuf {
    data_dir
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| data_dir.to_path_buf())
}

fn factory_manifest_path(data_dir: &Path) -> PathBuf {
    runtime_root_dir(data_dir)
        .join("factory")
        .join("factory-manifest.json")
}

fn local_bring_up_settings_path(data_dir: &Path) -> PathBuf {
    runtime_root_dir(data_dir)
        .join("bringup")
        .join("local-settings.json")
}

fn provisioning_profile_cache_summary_path(data_dir: &Path) -> PathBuf {
    runtime_root_dir(data_dir)
        .join("provisioning")
        .join("profile-cache-summary.json")
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
    maintenance: Arc<crate::maintenance::MaintenanceEnrollment>,
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
        normalize_http_endpoint(profile.api_base_url.clone(), "apiBaseUrl")
            .map_err(|_| "apiBaseUrl invalid".to_string())?;
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
        normalize_hardware_slot_topology(
            profile.hardware_slot_topology.clone(),
            "hardwareSlotTopology",
        )
        .map_err(|_| "hardware slot topology invalid".to_string())?;
        if profile.payment_capability.profile != "production" {
            return Err("payment capability invalid".to_string());
        }
        if !matches!(
            profile.provisioning_profile.as_str(),
            "production" | "testbed"
        ) {
            return Err("provisioning profile invalid".to_string());
        }
        validate_maintenance_identity(&profile.maintenance)?;
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
        Self::new_with_tunnel(
            data_dir,
            state,
            secrets,
            Arc::new(crate::maintenance::WindowsWireGuardTunnel::default()),
        )
    }

    pub fn new_with_tunnel(
        data_dir: PathBuf,
        state: LocalStateStore,
        secrets: Arc<dyn SecretStore>,
        tunnel: Arc<dyn crate::maintenance::WindowsTunnelBackend>,
    ) -> Self {
        let maintenance = Arc::new(crate::maintenance::MaintenanceEnrollment::new(
            secrets.clone(),
            tunnel,
        ));
        Self {
            data_dir,
            state,
            secrets,
            maintenance,
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

    pub fn factory_manifest_path(&self) -> PathBuf {
        factory_manifest_path(&self.data_dir)
    }

    pub fn local_bring_up_settings_path(&self) -> PathBuf {
        local_bring_up_settings_path(&self.data_dir)
    }

    pub fn provisioning_profile_cache_summary_path(&self) -> PathBuf {
        provisioning_profile_cache_summary_path(&self.data_dir)
    }

    /// Factory writes only a salted PIN verifier to this one-shot protected
    /// staging location. The daemon validates and imports it into the selected
    /// SecretStore before any Bring-Up or claim work observes configuration.
    pub fn factory_maintenance_pin_verifier_path(&self) -> PathBuf {
        self.data_dir
            .join("factory")
            .join("maintenance-pin-verifier.json")
    }

    pub fn factory_bootstrap_capability_path(&self) -> PathBuf {
        self.data_dir
            .join("factory")
            .join("bootstrap-provisioning-capability")
    }

    pub fn factory_bootstrap_capability_verifier_path(&self) -> PathBuf {
        self.data_dir
            .join("factory")
            .join("bootstrap-provisioning-capability-verifier.json")
    }

    /// Import the Factory-produced verifier without ever reading or retaining
    /// its raw companion capability. The latter remains ACL-protected for the
    /// local maintenance account until it is exchanged exactly once.
    pub async fn import_factory_bootstrap_capability_verifier(&self) -> Result<bool, String> {
        let path = self.factory_bootstrap_capability_verifier_path();
        let serialized = match fs::read_to_string(&path).await {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(error) => {
                return Err(format!(
                    "read factory bootstrap verifier staging failed: {error}"
                ))
            }
        };
        let verifier = serde_json::from_str::<FactoryBootstrapCapabilityVerifier>(&serialized)
            .map_err(|_| "factory bootstrap verifier is invalid".to_string())?;
        if !verifier.valid() {
            return Err("factory bootstrap verifier is invalid".to_string());
        }
        if let Some(existing) = self
            .secrets
            .read_secret(crate::secret::MACHINE_FACTORY_BOOTSTRAP_CAPABILITY_ACCOUNT)
            .await?
        {
            if existing != serialized {
                return Err(
                    "factory bootstrap verifier conflicts with the protected verifier".to_string(),
                );
            }
        } else {
            self.secrets
                .write_secret(
                    crate::secret::MACHINE_FACTORY_BOOTSTRAP_CAPABILITY_ACCOUNT,
                    &serialized,
                )
                .await?;
        }
        fs::remove_file(path).await.map_err(|error| {
            format!("remove factory bootstrap verifier staging failed: {error}")
        })?;
        Ok(true)
    }

    /// Consume a Factory-only capability atomically enough for the daemon
    /// boundary: remove the protected verifier before the caller receives a
    /// session, and best-effort erase its local-account delivery file.
    pub async fn consume_factory_bootstrap_capability(
        &self,
        capability: &str,
    ) -> Result<bool, String> {
        if self
            .load_provisioning_profile_cache_summary()
            .await?
            .is_some()
        {
            return Ok(false);
        }
        let Some(serialized) = self
            .secrets
            .read_secret(crate::secret::MACHINE_FACTORY_BOOTSTRAP_CAPABILITY_ACCOUNT)
            .await?
        else {
            return Ok(false);
        };
        let Ok(verifier) = serde_json::from_str::<FactoryBootstrapCapabilityVerifier>(&serialized)
        else {
            return Ok(false);
        };
        if !verifier.verifies(capability) {
            return Ok(false);
        }
        self.secrets
            .write_secret(
                crate::secret::MACHINE_FACTORY_BOOTSTRAP_CAPABILITY_ACCOUNT,
                "",
            )
            .await?;
        match fs::remove_file(self.factory_bootstrap_capability_path()).await {
            Ok(()) => Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(true),
            Err(error) => Err(format!(
                "remove consumed factory bootstrap capability failed: {error}"
            )),
        }
    }

    pub async fn import_factory_maintenance_pin_verifier(&self) -> Result<bool, String> {
        let path = self.factory_maintenance_pin_verifier_path();
        let serialized = match fs::read_to_string(&path).await {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(error) => {
                return Err(format!(
                    "read factory maintenance PIN verifier staging failed: {error}"
                ));
            }
        };
        let verifier = serde_json::from_str::<MaintenancePinVerifier>(&serialized)
            .map_err(|_| "factory maintenance PIN verifier is invalid".to_string())?;
        if verifier.decode().is_none() {
            return Err("factory maintenance PIN verifier is invalid".to_string());
        }
        if let Some(existing) = self
            .secrets
            .read_secret(crate::secret::MACHINE_MAINTENANCE_PIN_ACCOUNT)
            .await?
        {
            if existing != serialized {
                return Err(
                    "factory maintenance PIN verifier conflicts with the protected verifier"
                        .to_string(),
                );
            }
        } else {
            self.secrets
                .write_secret(crate::secret::MACHINE_MAINTENANCE_PIN_ACCOUNT, &serialized)
                .await?;
        }
        fs::remove_file(&path).await.map_err(|error| {
            format!("remove factory maintenance PIN verifier staging failed: {error}")
        })?;
        Ok(true)
    }

    /// Earlier daemon builds stored only a numeric field PIN in the protected
    /// machine store. This is the sole migration path: it accepts that narrow
    /// legacy shape, replaces it atomically with a freshly salted verifier,
    /// and never exposes the source PIN outside this process.
    pub async fn migrate_legacy_raw_maintenance_pin(&self) -> Result<bool, String> {
        let Some(raw_pin) = self
            .secrets
            .read_secret(crate::secret::MACHINE_MAINTENANCE_PIN_ACCOUNT)
            .await?
        else {
            return Ok(false);
        };
        if serde_json::from_str::<MaintenancePinVerifier>(&raw_pin)
            .ok()
            .is_some_and(|verifier| verifier.decode().is_some())
        {
            return Ok(false);
        }
        if !legacy_raw_maintenance_pin(&raw_pin) {
            return Ok(false);
        }

        let verifier = new_maintenance_pin_verifier(&raw_pin)?;
        let serialized = serde_json::to_string(&verifier)
            .map_err(|_| "serialize maintenance PIN verifier failed".to_string())?;
        self.secrets
            .write_secret(crate::secret::MACHINE_MAINTENANCE_PIN_ACCOUNT, &serialized)
            .await?;
        Ok(true)
    }

    async fn maintenance_pin_verifier_configured(&self) -> Result<bool, String> {
        let Some(serialized) = self
            .secrets
            .read_secret(crate::secret::MACHINE_MAINTENANCE_PIN_ACCOUNT)
            .await?
        else {
            return Ok(false);
        };
        Ok(serde_json::from_str::<MaintenancePinVerifier>(&serialized)
            .ok()
            .is_some_and(|verifier| verifier.decode().is_some()))
    }

    /// Verifies a supplied field PIN inside the daemon boundary. The protected
    /// secret is a salted KDF verifier, never the PIN itself, and malformed
    /// or missing records deliberately look identical to a wrong PIN.
    pub async fn verify_maintenance_pin(&self, supplied: &str) -> Result<bool, String> {
        let Some(serialized) = self
            .secrets
            .read_secret(crate::secret::MACHINE_MAINTENANCE_PIN_ACCOUNT)
            .await?
        else {
            return Ok(false);
        };
        let Ok(verifier) = serde_json::from_str::<MaintenancePinVerifier>(&serialized) else {
            return Ok(false);
        };
        Ok(verifier.verify(supplied))
    }

    pub async fn ensure_maintenance_public_key(&self) -> Result<String, String> {
        self.maintenance.ensure_public_key().await
    }

    pub async fn ensure_reclaim_maintenance_public_key(
        &self,
        claim_code: &str,
    ) -> Result<String, String> {
        let active_identity = self
            .load_provisioning_profile_cache_summary()
            .await?
            .and_then(|summary| summary.maintenance);
        self.maintenance
            .ensure_reclaim_public_key(claim_code, active_identity.as_ref())
            .await
    }

    pub async fn provisioning_profile_name(&self) -> Result<String, String> {
        let factory = self.load_factory_manifest().await?;
        let local = self.load_local_bring_up_settings().await?;
        let value = local
            .and_then(|settings| settings.environment)
            .or_else(|| factory.map(|manifest| manifest.environment))
            .unwrap_or_else(|| "production".to_string())
            .trim()
            .to_ascii_lowercase();
        if matches!(value.as_str(), "production" | "testbed") {
            Ok(value)
        } else {
            Err("unsupported machine provisioning profile".to_string())
        }
    }

    pub async fn apply_maintenance_profile(
        &self,
        identity: &ProvisioningMaintenanceIdentity,
        reclaim: bool,
    ) -> Result<crate::maintenance::MaintenanceEnrollmentStatus, String> {
        if reclaim {
            self.maintenance.apply_reclaim_profile(identity).await
        } else {
            self.maintenance.apply_profile(identity).await
        }
    }

    pub async fn recover_maintenance_from_cache(
        &self,
    ) -> Result<Option<crate::maintenance::MaintenanceEnrollmentStatus>, String> {
        let pending_finalize = self
            .state
            .get_metadata::<crate::state::store::SecureDecommissionFinalizeMarker>(
                "secure_decommission_pending_finalize",
            )
            .await
            .map_err(|error| error.to_string())?;
        if let Some(pending_finalize) = pending_finalize {
            let acknowledged = self
                .state
                .get_metadata::<crate::state::store::SecureDecommissionFinalizeMarker>(
                    "secure_decommission_platform_acknowledged_command_no",
                )
                .await
                .map_err(|error| error.to_string())?;
            match acknowledged {
                Some(marker) if marker == pending_finalize => {
                    self.finalize_secure_decommission(&pending_finalize).await?;
                }
                Some(_) => {
                    return Err(
                        "secure decommission acknowledgement does not match the active command generation"
                            .to_string(),
                    );
                }
                None => {
                    return Err(
                        "secure decommission is pending platform acknowledgement; daemon startup is refused until finalization can be proven"
                            .to_string(),
                    );
                }
            }
            return Ok(None);
        }
        let identity = self
            .load_provisioning_profile_cache_summary()
            .await?
            .and_then(|summary| summary.maintenance);
        if let Some(identity) = identity.as_ref() {
            validate_maintenance_identity(identity)?;
        }
        self.maintenance.recover(identity.as_ref()).await
    }

    pub async fn maintenance_status(&self) -> crate::maintenance::MaintenanceEnrollmentStatus {
        self.maintenance.status().await
    }

    /// Records a reclaim authorization issued by protected maintenance.  The
    /// durable flag is the source of the Bring-Up cursor; a provisioning
    /// profile cache is only historical profile evidence and is never used as
    /// an implicit reclaim request.
    pub async fn request_machine_reclaim(&self) -> Result<(), String> {
        self.state
            .put_metadata("bring_up_reclaim_requested", &true)
            .await
            .map_err(|error| error.to_string())
    }

    pub async fn machine_reclaim_requested(&self) -> Result<bool, String> {
        Ok(self
            .state
            .get_metadata::<bool>("bring_up_reclaim_requested")
            .await
            .map_err(|error| error.to_string())?
            .unwrap_or(false))
    }

    pub async fn clear_machine_reclaim_request(&self) -> Result<(), String> {
        self.state
            .delete_metadata("bring_up_reclaim_requested")
            .await
            .map_err(|error| error.to_string())
    }

    pub async fn promote_maintenance_reclaim(
        &self,
        public_key: &str,
    ) -> Result<crate::maintenance::MaintenanceEnrollmentStatus, String> {
        self.maintenance.promote_reclaim(public_key).await
    }

    pub async fn reject_maintenance_reclaim(
        &self,
        public_key: &str,
        reason: &str,
    ) -> Result<crate::maintenance::MaintenanceEnrollmentStatus, String> {
        self.maintenance.reject_reclaim(public_key, reason).await
    }

    pub async fn secure_decommission(
        &self,
        marker: &crate::state::store::SecureDecommissionFinalizeMarker,
    ) -> Result<(), String> {
        self.state
            .put_metadata("secure_decommission_pending_finalize", marker)
            .await
            .map_err(|error| error.to_string())?;
        self.maintenance.decommission().await?;
        self.secrets
            .write_secret(crate::secret::MACHINE_SECRET_ACCOUNT, "")
            .await
            .map_err(|error| format!("clear decommissioned machine credential failed: {error}"))
    }

    pub async fn pending_secure_decommission_marker(
        &self,
    ) -> Result<Option<crate::state::store::SecureDecommissionFinalizeMarker>, String> {
        self.state
            .get_metadata("secure_decommission_pending_finalize")
            .await
            .map_err(|error| error.to_string())
    }

    pub async fn finalize_secure_decommission(
        &self,
        marker: &crate::state::store::SecureDecommissionFinalizeMarker,
    ) -> Result<(), String> {
        let pending = self
            .pending_secure_decommission_marker()
            .await?
            .ok_or_else(|| {
                "secure decommission finalization has no active command marker".to_string()
            })?;
        if pending != *marker {
            return Err("secure decommission finalization marker does not match the active command generation".to_string());
        }
        self.secrets
            .clear_all()
            .await
            .map_err(|error| format!("clear decommissioned machine secrets failed: {error}"))?;
        match fs::remove_file(self.provisioning_profile_cache_summary_path()).await {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("remove provisioning profile failed: {error}")),
        }
        self.save_public_config(default_public_config()).await?;
        self.state
            .clear_secure_decommission_finalization_markers_tx(marker)
            .await
            .map_err(|error| error.to_string())
    }

    pub async fn acknowledge_secure_decommission(&self, command_no: &str) -> Result<(), String> {
        let marker = self
            .state
            .get_metadata::<crate::state::store::SecureDecommissionFinalizeMarker>(
                "secure_decommission_pending_finalize",
            )
            .await
            .map_err(|error| error.to_string())?
            .ok_or_else(|| {
                "secure decommission acknowledgement has no active command marker".to_string()
            })?;
        if marker.command_no != command_no {
            return Err(
                "secure decommission acknowledgement does not match the active command".to_string(),
            );
        }
        self.state
            .put_metadata(
                "secure_decommission_platform_acknowledged_command_no",
                &marker,
            )
            .await
            .map_err(|error| error.to_string())?;
        self.finalize_secure_decommission(&marker).await
    }

    async fn read_optional_json<T>(path: PathBuf, label: &str) -> Result<Option<T>, String>
    where
        T: DeserializeOwned,
    {
        let content = match fs::read_to_string(&path).await {
            Ok(content) => content,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(format!("read {label} failed: {error}")),
        };
        serde_json::from_str(&content).map(Some).map_err(|error| {
            format!(
                "parse {label} failed at {}: {error}",
                path.to_string_lossy()
            )
        })
    }

    pub async fn load_factory_manifest(&self) -> Result<Option<FactoryRuntimeManifest>, String> {
        Self::read_optional_json(self.factory_manifest_path(), "factory manifest")
            .await?
            .map(normalize_factory_manifest)
            .transpose()
    }

    pub async fn load_local_bring_up_settings(
        &self,
    ) -> Result<Option<LocalBringUpSettings>, String> {
        Self::read_optional_json(
            self.local_bring_up_settings_path(),
            "local bring-up settings",
        )
        .await?
        .map(normalize_local_bring_up_settings)
        .transpose()
    }

    pub async fn load_provisioning_profile_cache_summary(
        &self,
    ) -> Result<Option<ProvisioningProfileCacheSummary>, String> {
        Self::read_optional_json(
            self.provisioning_profile_cache_summary_path(),
            "provisioning profile cache summary",
        )
        .await?
        .map(normalize_provisioning_profile_cache_summary)
        .transpose()
    }

    fn apply_layered_public_config(
        mut public: MachinePublicConfig,
        factory_manifest: Option<&FactoryRuntimeManifest>,
        local_bring_up_settings: Option<&LocalBringUpSettings>,
        provisioning_profile_cache: Option<&ProvisioningProfileCacheSummary>,
    ) -> Result<MachinePublicConfig, String> {
        if let Some(manifest) = factory_manifest {
            public.api_base_url = manifest.provisioning_endpoint.clone();
        }
        if let Some(settings) = local_bring_up_settings {
            apply_local_bring_up_settings_to_public(&mut public, settings);
        }
        if let Some(profile) = provisioning_profile_cache {
            public.machine_id = Some(profile.machine_id.clone());
            public.machine_code = Some(profile.machine_code.clone());
            public.machine_name = Some(profile.machine_name.clone());
            public.machine_status = Some(profile.machine_status.clone());
            public.machine_location_label = profile.machine_location_label.clone();
            public.api_base_url = profile.api_base_url.clone();
            public.mqtt_url = profile.mqtt_url.clone();
            public.mqtt_client_id = Some(profile.mqtt_client_id.clone());
            public.mqtt_username = profile.mqtt_username.clone();
            public.runtime_endpoints = Some(profile.runtime_endpoints.clone());
            public.hardware_profile = Some(profile.hardware_profile.clone());
            public.payment_capability = Some(profile.payment_capability.clone());
            public.provisioning_metadata = Some(profile.provisioning_metadata.clone());
        }
        normalize_public_config(public)
    }

    async fn load_layered_runtime_config_parts(
        &self,
    ) -> Result<
        (
            MachinePublicConfig,
            Option<FactoryRuntimeManifest>,
            Option<LocalBringUpSettings>,
            Option<ProvisioningProfileCacheSummary>,
        ),
        String,
    > {
        let factory_manifest = self.load_factory_manifest().await?;
        let local_bring_up_settings = self.load_local_bring_up_settings().await?;
        let provisioning_profile_cache = self.load_provisioning_profile_cache_summary().await?;
        let effective_public = Self::apply_layered_public_config(
            default_public_config(),
            factory_manifest.as_ref(),
            local_bring_up_settings.as_ref(),
            provisioning_profile_cache.as_ref(),
        )?;
        Ok((
            effective_public,
            factory_manifest,
            local_bring_up_settings,
            provisioning_profile_cache,
        ))
    }

    pub async fn load_effective_public_config(&self) -> Result<MachinePublicConfig, String> {
        let (public, _, _, _) = self.load_layered_runtime_config_parts().await?;
        Ok(public)
    }

    async fn persist_snapshot(&self, public: &MachinePublicConfig) -> Result<(), String> {
        let secret_status = self.secrets.status().await?;

        let value = serde_json::to_value(public)
            .map_err(|error| format!("serialize machine config snapshot failed: {error}"))?;
        self.state
            .save_machine_config_snapshot(
                &value,
                secret_status.machine_secret_configured,
                secret_status.mqtt_signing_secret_configured,
                secret_status.mqtt_password_configured,
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
        self.write_local_runtime_settings_from_public_config(&normalized)
            .await?;
        self.write_public_config_file(&normalized).await?;
        self.persist_snapshot(&normalized).await?;
        self.public_runtime_config(normalized).await
    }

    async fn write_local_runtime_settings_from_public_config(
        &self,
        public: &MachinePublicConfig,
    ) -> Result<(), String> {
        let mut settings = self
            .load_local_bring_up_settings()
            .await?
            .unwrap_or_default();
        settings.provisioning_endpoint_override =
            normalize_optional_string(Some(public.api_base_url.clone()));
        settings.hardware_adapter = Some(public.hardware_adapter.clone());
        settings.serial_port_path = public.serial_port_path.clone();
        settings.lower_controller_usb_identity = Some(public.lower_controller_usb_identity.clone());
        settings.scanner_adapter = Some(public.scanner_adapter.clone());
        settings.scanner_serial_port_path = public.scanner_serial_port_path.clone();
        settings.scanner_usb_identity = Some(public.scanner_usb_identity.clone());
        settings.scanner_baud_rate = Some(public.scanner_baud_rate);
        settings.scanner_frame_suffix = Some(public.scanner_frame_suffix);
        settings.vision_enabled = Some(public.vision_enabled);
        settings.vision_ws_url = Some(public.vision_ws_url.clone());
        settings.vision_request_timeout_ms = Some(public.vision_request_timeout_ms);
        settings.machine_audio_volume = Some(public.machine_audio_volume);
        settings.try_on_camera_device_id = public.try_on_camera_device_id.clone();
        settings.audio_cue_settings = Some(public.audio_cue_settings.clone());
        settings.kiosk_mode = Some(public.kiosk_mode);
        settings.stock_movement_retention_days = Some(public.stock_movement_retention_days);
        self.write_local_bring_up_settings(&settings).await
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

    async fn write_provisioning_profile_cache_summary(
        &self,
        summary: &ProvisioningProfileCacheSummary,
    ) -> Result<(), String> {
        let summary = normalize_provisioning_profile_cache_summary(summary.clone())?;
        let path = self.provisioning_profile_cache_summary_path();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).await.map_err(|error| {
                format!("create provisioning profile cache dir failed: {error}")
            })?;
        }
        let payload = serde_json::to_string_pretty(&summary)
            .map_err(|error| format!("serialize provisioning profile cache failed: {error}"))?;
        fs::write(path, payload)
            .await
            .map_err(|error| format!("write provisioning profile cache failed: {error}"))?;
        Ok(())
    }

    pub async fn save_local_bring_up_network_profile(
        &self,
        network_profile: impl Into<String>,
    ) -> Result<LocalBringUpSettings, String> {
        let mut settings = self
            .load_local_bring_up_settings()
            .await?
            .unwrap_or_default();
        settings.network_profile = normalize_optional_string(Some(network_profile.into()));
        let settings = normalize_local_bring_up_settings(settings)?;
        self.write_local_bring_up_settings(&settings).await?;
        Ok(settings)
    }

    async fn write_local_bring_up_settings(
        &self,
        settings: &LocalBringUpSettings,
    ) -> Result<(), String> {
        let settings = normalize_local_bring_up_settings(settings.clone())?;
        let path = self.local_bring_up_settings_path();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .await
                .map_err(|error| format!("create local bring-up settings dir failed: {error}"))?;
        }
        let payload = serde_json::to_string_pretty(&settings)
            .map_err(|error| format!("serialize local bring-up settings failed: {error}"))?;
        fs::write(path, payload)
            .await
            .map_err(|error| format!("write local bring-up settings failed: {error}"))
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
            maintenance_pin_configured: self.maintenance_pin_verifier_configured().await?,
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
        let factory_manifest = self.load_factory_manifest().await?;
        let local_bring_up_settings = self.load_local_bring_up_settings().await?;
        let mut public = default_public_config();
        if let Some(manifest) = factory_manifest.as_ref() {
            public.api_base_url = manifest.provisioning_endpoint.clone();
        }
        if let Some(settings) = local_bring_up_settings.as_ref() {
            apply_local_bring_up_settings_to_public(&mut public, settings);
        }

        let mut retained_maintenance_secrets = Vec::new();
        for account in [
            crate::secret::MACHINE_WIREGUARD_PRIVATE_KEY_ACCOUNT,
            crate::secret::MACHINE_WIREGUARD_PENDING_PRIVATE_KEY_ACCOUNT,
            crate::secret::MACHINE_MAINTENANCE_LIFECYCLE_ACCOUNT,
            // Factory imports this verifier into the protected local secret
            // store before first claim. Claim and reclaim rotate platform
            // credentials but must never remove the field-maintenance path.
            crate::secret::MACHINE_MAINTENANCE_PIN_ACCOUNT,
        ] {
            if let Some(value) = self
                .secrets
                .read_secret(account)
                .await
                .map_err(Self::provisioning_persistence_error)?
            {
                retained_maintenance_secrets.push((account, value));
            }
        }
        self.secrets
            .clear_all()
            .await
            .map_err(Self::provisioning_persistence_error)?;
        for (account, value) in retained_maintenance_secrets {
            self.secrets
                .write_secret(account, &value)
                .await
                .map_err(Self::provisioning_persistence_error)?;
        }

        public.machine_id = Some(profile.machine.id.clone());
        public.machine_code = Some(profile.machine.code.clone());
        public.machine_name = Some(profile.machine.name.clone());
        public.machine_status = Some(profile.machine.status.clone());
        public.machine_location_label = profile.machine.location_label.clone();
        public.api_base_url = profile.api_base_url.clone();
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

        let profile_cache = ProvisioningProfileCacheSummary {
            profile_version: profile.metadata.profile_version,
            machine_id: profile.machine.id.clone(),
            machine_code: profile.machine.code.clone(),
            machine_name: profile.machine.name.clone(),
            machine_status: profile.machine.status.clone(),
            machine_location_label: profile.machine.location_label.clone(),
            claimed_at: profile.metadata.claimed_at.clone(),
            api_base_url: profile.api_base_url.clone(),
            mqtt_url: profile.credentials.mqtt_connection.url.clone(),
            mqtt_client_id: profile.credentials.mqtt_connection.client_id.clone(),
            mqtt_username: profile.credentials.mqtt_connection.username.clone(),
            runtime_endpoints: profile.runtime_endpoints.clone(),
            hardware_profile: profile.hardware_profile.clone(),
            hardware_slot_topology: Some(profile.hardware_slot_topology.clone()),
            payment_capability: profile.payment_capability.clone(),
            provisioning_metadata: profile.metadata.clone(),
            provisioning_profile: Some(profile.provisioning_profile.clone()),
            maintenance: Some(profile.maintenance.clone()),
        };
        self.write_provisioning_profile_cache_summary(&profile_cache)
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

    pub async fn hardware_slot_topology_readiness(
        &self,
    ) -> Result<HardwareSlotTopologyReadiness, String> {
        let local = self
            .load_factory_manifest()
            .await?
            .map(|manifest| manifest.hardware_slot_topology);
        let platform = self
            .load_provisioning_profile_cache_summary()
            .await?
            .and_then(|summary| summary.hardware_slot_topology)
            .map(|topology| {
                normalize_hardware_slot_topology(topology, "platform hardware slot topology")
            })
            .transpose()?;

        let (ready, code, message) = match (local.as_ref(), platform.as_ref()) {
            (None, None) => (
                true,
                "HARDWARE_SLOT_TOPOLOGY_NOT_CONFIGURED",
                "hardware slot topology verification is not configured",
            ),
            (None, _) => (
                false,
                "HARDWARE_SLOT_TOPOLOGY_LOCAL_MISSING",
                "factory hardware slot topology manifest is missing; sales are blocked",
            ),
            (_, None) => (
                false,
                "HARDWARE_SLOT_TOPOLOGY_PLATFORM_MISSING",
                "platform provisioning profile is missing expected hardware slot topology; sales are blocked",
            ),
            (Some(local), Some(platform)) if local == platform => (
                true,
                "HARDWARE_SLOT_TOPOLOGY_MATCH",
                "hardware slot topology matches platform expectation",
            ),
            (Some(_), Some(_)) => (
                false,
                "HARDWARE_SLOT_TOPOLOGY_MISMATCH",
                "factory hardware slot topology does not match platform expectation; sales are blocked",
            ),
        };

        Ok(HardwareSlotTopologyReadiness {
            ready,
            code: code.to_string(),
            message: message.to_string(),
            local,
            platform,
        })
    }

    pub async fn load_runtime_configuration_summary(
        &self,
    ) -> Result<RuntimeConfigurationSummary, String> {
        let factory_manifest = self.load_factory_manifest().await?;
        let local_bring_up_settings = self.load_local_bring_up_settings().await?;
        let provisioning_profile_cache = self.load_provisioning_profile_cache_summary().await?;
        let effective_public = Self::apply_layered_public_config(
            default_public_config(),
            factory_manifest.as_ref(),
            local_bring_up_settings.as_ref(),
            provisioning_profile_cache.as_ref(),
        )?;
        let secret_store = self.secrets.status().await?;
        Ok(RuntimeConfigurationSummary {
            configured_state: RuntimeConfigurationState {
                factory_manifest: factory_manifest.is_some(),
                local_bring_up_settings: local_bring_up_settings.is_some(),
                provisioning_profile_cache: provisioning_profile_cache.is_some(),
                machine_secret_configured: secret_store.machine_secret_configured,
                mqtt_signing_secret_configured: secret_store.mqtt_signing_secret_configured,
                mqtt_password_configured: secret_store.mqtt_password_configured,
                maintenance_pin_configured: self.maintenance_pin_verifier_configured().await?,
            },
            secret_store,
            factory_manifest,
            local_bring_up_settings,
            provisioning_profile_cache,
            effective_public,
        })
    }

    pub async fn load_runtime_config(&self) -> Result<MachineRuntimeConfig, String> {
        let (public, _, _, _) = self.load_layered_runtime_config_parts().await?;
        let secrets = self.runtime_secrets().await?;

        let runtime = MachineRuntimeConfig {
            public: public.clone(),
            machine_secret_configured: secrets.machine_secret.as_deref().is_some(),
            mqtt_signing_secret_configured: secrets.mqtt_signing_secret.as_deref().is_some(),
            mqtt_password_configured: secrets.mqtt_password.as_deref().is_some(),
            maintenance_pin_configured: self.maintenance_pin_verifier_configured().await?,
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
    use crate::secret::{
        InMemorySecretStore, ProtectedLocalSecretStore, SecretStore, SecretStoreStatus,
        MACHINE_SECRET_ACCOUNT, MACHINE_WIREGUARD_PRIVATE_KEY_ACCOUNT, MQTT_PASSWORD_ACCOUNT,
        MQTT_SIGNING_SECRET_ACCOUNT,
    };
    use async_trait::async_trait;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        OnceLock,
    };
    use tempfile::TempDir;
    use tokio::sync::Mutex;

    static ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

    #[derive(Default)]
    struct RecoveryTunnel {
        applies: AtomicUsize,
    }

    #[derive(Default)]
    struct RemovalFailingTunnel;

    #[async_trait]
    impl crate::maintenance::WindowsTunnelBackend for RecoveryTunnel {
        async fn apply(
            &self,
            _identity: crate::maintenance::MaintenanceTunnelIdentity,
            _config: crate::maintenance::WindowsTunnelConfig,
        ) -> Result<(), String> {
            self.applies.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }

        async fn observe_handshake(
            &self,
            _identity: crate::maintenance::MaintenanceTunnelIdentity,
            _relay_public_key: &str,
        ) -> Result<crate::maintenance::HandshakeObservation, String> {
            Ok(crate::maintenance::HandshakeObservation {
                verified: false,
                last_handshake_at: None,
                message: "first WireGuard handshake has not been observed".to_string(),
            })
        }
    }

    #[async_trait]
    impl crate::maintenance::WindowsTunnelBackend for RemovalFailingTunnel {
        async fn apply(
            &self,
            _identity: crate::maintenance::MaintenanceTunnelIdentity,
            _config: crate::maintenance::WindowsTunnelConfig,
        ) -> Result<(), String> {
            Ok(())
        }

        async fn observe_handshake(
            &self,
            _identity: crate::maintenance::MaintenanceTunnelIdentity,
            _relay_public_key: &str,
        ) -> Result<crate::maintenance::HandshakeObservation, String> {
            unreachable!("handshake is not observed during decommission")
        }

        async fn remove(
            &self,
            _identity: crate::maintenance::MaintenanceTunnelIdentity,
        ) -> Result<(), String> {
            Err("injected tunnel removal failure".to_string())
        }
    }

    #[derive(Debug, Default)]
    struct ClearFailingSecretStore {
        inner: InMemorySecretStore,
    }

    impl ClearFailingSecretStore {
        async fn seed_old_secrets(&self) {
            self.inner
                .write_secret(MACHINE_SECRET_ACCOUNT, "old-machine-secret")
                .await
                .expect("seed old machine secret");
            self.inner
                .write_secret(MQTT_SIGNING_SECRET_ACCOUNT, "old-signing-secret")
                .await
                .expect("seed old signing secret");
            self.inner
                .write_secret(MQTT_PASSWORD_ACCOUNT, "old-mqtt-password")
                .await
                .expect("seed old mqtt password");
        }
    }

    #[async_trait]
    impl SecretStore for ClearFailingSecretStore {
        async fn read_secret(&self, account: &str) -> Result<Option<String>, String> {
            self.inner.read_secret(account).await
        }

        async fn write_secret(&self, account: &str, value: &str) -> Result<(), String> {
            self.inner.write_secret(account, value).await
        }

        async fn clear_all(&self) -> Result<(), String> {
            Err("injected clear failure".to_string())
        }

        async fn status(&self) -> Result<SecretStoreStatus, String> {
            let mut status = self.inner.status().await?;
            status.kind = "clear_failing_test".to_string();
            status.protection = "test_only_clear_failure".to_string();
            Ok(status)
        }
    }

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

    fn decommission_marker(
        command_no: &str,
    ) -> crate::state::store::SecureDecommissionFinalizeMarker {
        let message_id = format!("secure-decommission:{command_no}");
        crate::state::store::SecureDecommissionFinalizeMarker {
            generation: message_id.clone(),
            message_id,
            command_no: command_no.to_string(),
        }
    }

    fn valid_provisioning_profile_for_test() -> MachineProvisioningProfile {
        MachineProvisioningProfile {
            machine: ProvisioningMachine {
                id: "550e8400-e29b-41d4-a716-446655440000".to_string(),
                code: "M001".to_string(),
                name: "Lobby".to_string(),
                status: "offline".to_string(),
                location_label: Some("1F".to_string()),
            },
            credentials: ProvisioningCredentials {
                machine_secret: "vms_local-machine-shared-secret-change-before-prod".to_string(),
                machine_secret_version: 2,
                mqtt_signing_secret: "vms_local-mqtt-shared-secret-change-before-prod".to_string(),
                mqtt_connection: ProvisioningMqttConnection {
                    url: "mqtt://broker.example:1883".to_string(),
                    client_id: "vem-machine-M001".to_string(),
                    username: Some("machine-client".to_string()),
                    password: Some("mqtt-password".to_string()),
                },
            },
            api_base_url: "http://127.0.0.1:3000/api".to_string(),
            runtime_endpoints: ProvisioningRuntimeEndpoints {
                api_base_path: "/api".to_string(),
                machine_auth_token_path: "/api/machine-auth/token".to_string(),
                machine_api_base_path: "/api/machines/M001".to_string(),
                mqtt_topic_prefix: "vem/machines/M001".to_string(),
            },
            hardware_profile: ProductionMachineHardwareProfile {
                profile: "production".to_string(),
                controller: ProductionControllerProfile {
                    required: true,
                    protocol: "vem-vending-controller".to_string(),
                },
                payment_scanner: ProductionPaymentScannerProfile {
                    required: true,
                    supports_payment_code: true,
                },
                vision: ProductionVisionProfile {
                    required: false,
                    supports_recommendations: true,
                },
            },
            hardware_slot_topology: HardwareSlotTopologyIdentity {
                identity: "vem-prod-24".to_string(),
                version: "2026-06-adr0026".to_string(),
            },
            payment_capability: ProductionMachinePaymentCapability {
                profile: "production".to_string(),
                qr_code_enabled: true,
                payment_code_enabled: true,
                server_time: "2026-06-08T16:30:00.000Z".to_string(),
                options: Vec::new(),
                default_option_key: None,
                default_provider_code: None,
            },
            provisioning_profile: "production".to_string(),
            maintenance: ProvisioningMaintenanceIdentity {
                public_key: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=".to_string(),
                tunnel_address: "10.91.16.10".to_string(),
                address: "10.91.16.10/32".to_string(),
                endpoint: "relay.example:51820".to_string(),
                relay: ProvisioningMaintenancePeer {
                    public_key: "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=".to_string(),
                    tunnel_address: "10.91.0.1".to_string(),
                    address: "10.91.0.1/32".to_string(),
                },
                role_routes: MaintenanceRoleRoutes {
                    relay: "10.91.0.1/32".to_string(),
                    runner: "10.91.1.0/24".to_string(),
                    maintainer: "10.91.3.0/24".to_string(),
                },
                reclaim_expires_at: None,
            },
            metadata: ProvisioningMetadata {
                profile_version: 1,
                claim_code_id: "550e8400-e29b-41d4-a716-446655440111".to_string(),
                claimed_at: "2026-06-08T16:30:00.000Z".to_string(),
                server_time: "2026-06-08T16:30:00.000Z".to_string(),
            },
        }
    }

    async fn write_factory_manifest_for_test(
        data_dir: &std::path::Path,
        identity: &str,
        version: &str,
    ) {
        let path = factory_manifest_path(data_dir);
        tokio::fs::create_dir_all(path.parent().expect("manifest parent"))
            .await
            .expect("factory dir");
        tokio::fs::write(
            path,
            serde_json::json!({
                "layoutVersion": 1,
                "environment": "production",
                "provisioningEndpoint": "https://factory.example.com/api",
                "hardwareMode": "production",
                "hardwareModel": "VEM-PROD-24",
                "hardwareSlotTopology": {
                    "identity": identity,
                    "version": version
                }
            })
            .to_string(),
        )
        .await
        .expect("write factory manifest");
    }

    fn profile_cache_summary_for_test(
        profile: &MachineProvisioningProfile,
    ) -> ProvisioningProfileCacheSummary {
        ProvisioningProfileCacheSummary {
            profile_version: profile.metadata.profile_version,
            machine_id: profile.machine.id.clone(),
            machine_code: profile.machine.code.clone(),
            machine_name: profile.machine.name.clone(),
            machine_status: profile.machine.status.clone(),
            machine_location_label: profile.machine.location_label.clone(),
            claimed_at: profile.metadata.claimed_at.clone(),
            api_base_url: "https://profile.example.com/api".to_string(),
            mqtt_url: profile.credentials.mqtt_connection.url.clone(),
            mqtt_client_id: profile.credentials.mqtt_connection.client_id.clone(),
            mqtt_username: profile.credentials.mqtt_connection.username.clone(),
            runtime_endpoints: profile.runtime_endpoints.clone(),
            hardware_profile: profile.hardware_profile.clone(),
            hardware_slot_topology: Some(profile.hardware_slot_topology.clone()),
            payment_capability: profile.payment_capability.clone(),
            provisioning_metadata: profile.metadata.clone(),
            provisioning_profile: Some(profile.provisioning_profile.clone()),
            maintenance: Some(profile.maintenance.clone()),
        }
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

    #[test]
    fn default_public_config_keeps_audio_cues_opt_in() {
        let config = default_public_config();

        assert_eq!(
            config.audio_cue_settings,
            AudioCueSettings {
                enabled: false,
                categories: AudioCueCategorySettings {
                    presence: false,
                    transaction: false,
                },
            }
        );
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
    async fn saved_config_api_base_url_updates_local_bring_up_override() {
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
    async fn local_bring_up_explicit_null_disables_default_usb_identities() {
        let temp = TempDir::new().expect("temp");
        let root = temp.path();
        let data_dir = root.join("vending-daemon");
        tokio::fs::create_dir_all(root.join("bringup"))
            .await
            .expect("bringup dir");
        tokio::fs::write(
            local_bring_up_settings_path(&data_dir),
            serde_json::json!({
                "hardwareAdapter": "serial",
                "serialPortPath": "COM1",
                "lowerControllerUsbIdentity": null,
                "scannerAdapter": "serial_text",
                "scannerSerialPortPath": "COM2",
                "scannerUsbIdentity": null,
                "scannerBaudRate": 9600,
                "scannerFrameSuffix": "crlf"
            })
            .to_string(),
        )
        .await
        .expect("write bring-up settings");
        let state = crate::state::LocalStateStore::open(&data_dir.join("state.db"))
            .await
            .expect("state");
        let store = ConfigStore::new(data_dir, state, Arc::new(InMemorySecretStore::default()));

        let runtime = store.load_runtime_config().await.expect("load config");

        assert_eq!(runtime.public.hardware_adapter, HardwareAdapterKind::Serial);
        assert_eq!(runtime.public.serial_port_path.as_deref(), Some("COM1"));
        assert_eq!(runtime.public.lower_controller_usb_identity, None);
        assert_eq!(
            runtime.public.scanner_adapter,
            ScannerAdapterKind::SerialText
        );
        assert_eq!(
            runtime.public.scanner_serial_port_path.as_deref(),
            Some("COM2")
        );
        assert_eq!(runtime.public.scanner_usb_identity, None);
    }

    #[test]
    fn local_bring_up_omission_and_explicit_null_have_distinct_usb_semantics() {
        let omitted: LocalBringUpSettings =
            serde_json::from_value(serde_json::json!({})).expect("omitted settings");
        let disabled: LocalBringUpSettings = serde_json::from_value(serde_json::json!({
            "lowerControllerUsbIdentity": null,
            "scannerUsbIdentity": null
        }))
        .expect("disabled settings");

        assert_eq!(omitted.lower_controller_usb_identity, None);
        assert_eq!(omitted.scanner_usb_identity, None);
        assert_eq!(disabled.lower_controller_usb_identity, Some(None));
        assert_eq!(disabled.scanner_usb_identity, Some(None));
        let serialized = serde_json::to_value(omitted).expect("serialize omitted");
        let object = serialized.as_object().expect("settings object");
        assert!(!object.contains_key("lowerControllerUsbIdentity"));
        assert!(!object.contains_key("scannerUsbIdentity"));
    }

    #[tokio::test]
    async fn layered_runtime_summary_reads_owned_layers_and_excludes_machine_config_bridge() {
        let temp = TempDir::new().expect("temp");
        let root = temp.path();
        let data_dir = root.join("vending-daemon");
        tokio::fs::create_dir_all(root.join("factory"))
            .await
            .expect("factory dir");
        tokio::fs::create_dir_all(root.join("bringup"))
            .await
            .expect("bringup dir");
        tokio::fs::create_dir_all(root.join("provisioning"))
            .await
            .expect("provisioning dir");
        tokio::fs::create_dir_all(&data_dir)
            .await
            .expect("daemon dir");

        tokio::fs::write(
            factory_manifest_path(&data_dir),
            serde_json::json!({
                "layoutVersion": 1,
                "environment": "production",
                "provisioningEndpoint": "https://factory.example.com/api",
                "hardwareMode": "production",
                "hardwareModel": "VEM-PROD-24",
                "hardwareSlotTopology": {
                    "identity": "vem-prod-24",
                    "version": "2026-07-01"
                }
            })
            .to_string(),
        )
        .await
        .expect("write factory manifest");
        tokio::fs::write(
            local_bring_up_settings_path(&data_dir),
            serde_json::json!({
                "environment": "production",
                "provisioningEndpointOverride": "https://bringup.example.com/api",
                "networkProfile": "field-wifi"
            })
            .to_string(),
        )
        .await
        .expect("write bring-up settings");
        tokio::fs::write(
            provisioning_profile_cache_summary_path(&data_dir),
            serde_json::json!({
                "profileVersion": 1,
                "machineId": "550e8400-e29b-41d4-a716-446655440000",
                "machineCode": "M001",
                "machineName": "Lobby Machine",
                "machineStatus": "online",
                "claimedAt": "2026-07-04T16:00:00Z",
                "apiBaseUrl": "https://profile.example.com/api",
                "mqttUrl": "mqtt://broker.example:1883",
                "mqttClientId": "vem-M001",
                "runtimeEndpoints": {
                    "apiBasePath": "/api",
                    "machineAuthTokenPath": "/api/machine-auth/token",
                    "machineApiBasePath": "/api/machines/M001",
                    "mqttTopicPrefix": "vem/machines/M001"
                },
                "hardwareProfile": {
                    "profile": "production",
                    "controller": { "required": true, "protocol": "vem-vending-controller" },
                    "paymentScanner": { "required": true, "supportsPaymentCode": true },
                    "vision": { "required": false, "supportsRecommendations": true }
                },
                "hardwareSlotTopology": {
                    "identity": "vem-prod-24",
                    "version": "2026-06-adr0026"
                },
                "paymentCapability": {
                    "profile": "production",
                    "qrCodeEnabled": true,
                    "paymentCodeEnabled": true,
                    "serverTime": "2026-07-04T16:00:00Z"
                },
                "provisioningMetadata": {
                    "profileVersion": 1,
                    "claimCodeId": "550e8400-e29b-41d4-a716-446655440111",
                    "claimedAt": "2026-07-04T16:00:00Z",
                    "serverTime": "2026-07-04T16:00:00Z"
                }
            })
            .to_string(),
        )
        .await
        .expect("write profile summary");
        tokio::fs::write(
            daemon_config_path(&data_dir),
            serde_json::json!({
                "machineCode": "LEGACY-MACHINE",
                "machineId": "550e8400-e29b-41d4-a716-446655440999",
                "apiBaseUrl": "https://legacy.example.com/api",
                "mqttUrl": "mqtt://legacy-broker.example:1883",
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
        .expect("write bridge config");

        let state = crate::state::LocalStateStore::open(&data_dir.join("state.db"))
            .await
            .expect("state");
        let store = ConfigStore::new(data_dir, state, Arc::new(InMemorySecretStore::default()));

        let summary = store
            .load_runtime_configuration_summary()
            .await
            .expect("summary");

        assert!(summary.configured_state.factory_manifest);
        assert!(summary.configured_state.local_bring_up_settings);
        assert!(summary.configured_state.provisioning_profile_cache);
        assert_eq!(
            summary
                .factory_manifest
                .as_ref()
                .expect("manifest")
                .hardware_slot_topology
                .identity,
            "vem-prod-24"
        );
        assert_eq!(
            summary
                .local_bring_up_settings
                .as_ref()
                .expect("bring-up")
                .network_profile
                .as_deref(),
            Some("field-wifi")
        );
        assert_eq!(
            summary
                .provisioning_profile_cache
                .as_ref()
                .expect("profile")
                .machine_code,
            "M001"
        );
        assert_eq!(
            summary.effective_public.api_base_url,
            "https://profile.example.com/api"
        );
        assert_eq!(
            summary.effective_public.machine_code.as_deref(),
            Some("M001")
        );

        let serialized = serde_json::to_string(&summary).expect("serialize summary");
        assert!(!serialized.contains("SECRET"));
        assert!(!serialized.contains("machineConfigBridge"));
        assert!(!serialized.contains("LEGACY-MACHINE"));
    }

    #[tokio::test]
    async fn layered_runtime_summary_treats_missing_layer_files_as_unconfigured() {
        let temp = TempDir::new().expect("temp");
        let data_dir = temp.path().join("vending-daemon");
        let state = crate::state::LocalStateStore::open(&data_dir.join("state.db"))
            .await
            .expect("state");
        let store = ConfigStore::new(data_dir, state, Arc::new(InMemorySecretStore::default()));

        let summary = store
            .load_runtime_configuration_summary()
            .await
            .expect("summary");

        assert!(!summary.configured_state.factory_manifest);
        assert!(!summary.configured_state.local_bring_up_settings);
        assert!(!summary.configured_state.provisioning_profile_cache);
        assert!(summary.factory_manifest.is_none());
        assert!(summary.local_bring_up_settings.is_none());
        assert!(summary.provisioning_profile_cache.is_none());
    }

    #[tokio::test]
    async fn invalid_factory_manifest_fails_runtime_summary_loading() {
        let temp = TempDir::new().expect("temp");
        let data_dir = temp.path().join("vending-daemon");
        tokio::fs::create_dir_all(temp.path().join("factory"))
            .await
            .expect("factory dir");
        tokio::fs::write(
            factory_manifest_path(&data_dir),
            serde_json::json!({
                "layoutVersion": 1,
                "environment": "production",
                "provisioningEndpoint": "not-a-url",
                "hardwareMode": "production",
                "hardwareModel": "VEM-PROD-24",
                "hardwareSlotTopology": {
                    "identity": "vem-prod-24",
                    "version": "2026-07-01"
                }
            })
            .to_string(),
        )
        .await
        .expect("write manifest");
        let state = crate::state::LocalStateStore::open(&data_dir.join("state.db"))
            .await
            .expect("state");
        let store = ConfigStore::new(data_dir, state, Arc::new(InMemorySecretStore::default()));

        let err = store
            .load_runtime_configuration_summary()
            .await
            .expect_err("invalid manifest");

        assert_eq!(err, "provisioningEndpoint must be a URL");
    }

    #[tokio::test]
    async fn local_bring_up_settings_reject_production_owned_fields() {
        let temp = TempDir::new().expect("temp");
        let data_dir = temp.path().join("vending-daemon");
        tokio::fs::create_dir_all(temp.path().join("bringup"))
            .await
            .expect("bringup dir");
        tokio::fs::write(
            local_bring_up_settings_path(&data_dir),
            serde_json::json!({
                "environment": "production",
                "provisioningEndpointOverride": "https://bringup.example.com/api",
                "networkProfile": "field-wifi",
                "machineCode": "M001",
                "machineSecret": "SECRET-MACHINE",
                "planogram": {},
                "inventory": {},
                "paymentCapability": {}
            })
            .to_string(),
        )
        .await
        .expect("write settings");
        let state = crate::state::LocalStateStore::open(&data_dir.join("state.db"))
            .await
            .expect("state");
        let store = ConfigStore::new(data_dir, state, Arc::new(InMemorySecretStore::default()));

        let err = store
            .load_runtime_configuration_summary()
            .await
            .expect_err("forbidden fields");

        assert!(err.contains("parse local bring-up settings failed"));
        assert!(err.contains("unknown field"));
    }

    #[tokio::test]
    async fn load_runtime_config_uses_only_owned_layers_even_when_machine_config_bridge_exists() {
        let temp = TempDir::new().expect("temp");
        let root = temp.path();
        let data_dir = root.join("vending-daemon");
        tokio::fs::create_dir_all(root.join("factory"))
            .await
            .expect("factory dir");
        tokio::fs::create_dir_all(root.join("provisioning"))
            .await
            .expect("provisioning dir");
        tokio::fs::create_dir_all(&data_dir)
            .await
            .expect("daemon dir");
        tokio::fs::write(
            factory_manifest_path(&data_dir),
            serde_json::json!({
                "layoutVersion": 1,
                "environment": "production",
                "provisioningEndpoint": "https://factory.example.com/api",
                "hardwareMode": "production",
                "hardwareModel": "VEM-PROD-24",
                "hardwareSlotTopology": {
                    "identity": "vem-prod-24",
                    "version": "2026-07-01"
                }
            })
            .to_string(),
        )
        .await
        .expect("write factory manifest");
        tokio::fs::write(
            provisioning_profile_cache_summary_path(&data_dir),
            serde_json::json!({
                "profileVersion": 1,
                "machineId": "550e8400-e29b-41d4-a716-446655440000",
                "machineCode": "M001",
                "machineName": "Lobby Machine",
                "machineStatus": "online",
                "claimedAt": "2026-07-04T16:00:00Z",
                "apiBaseUrl": "https://profile.example.com/api",
                "mqttUrl": "mqtt://broker.example:1883",
                "mqttClientId": "vem-M001",
                "runtimeEndpoints": {
                    "apiBasePath": "/api",
                    "machineAuthTokenPath": "/api/machine-auth/token",
                    "machineApiBasePath": "/api/machines/M001",
                    "mqttTopicPrefix": "vem/machines/M001"
                },
                "hardwareProfile": {
                    "profile": "production",
                    "controller": { "required": true, "protocol": "vem-vending-controller" },
                    "paymentScanner": { "required": true, "supportsPaymentCode": true },
                    "vision": { "required": false, "supportsRecommendations": true }
                },
                "hardwareSlotTopology": {
                    "identity": "vem-prod-24",
                    "version": "2026-06-adr0026"
                },
                "paymentCapability": {
                    "profile": "production",
                    "qrCodeEnabled": true,
                    "paymentCodeEnabled": true,
                    "serverTime": "2026-07-04T16:00:00Z"
                },
                "provisioningMetadata": {
                    "profileVersion": 1,
                    "claimCodeId": "550e8400-e29b-41d4-a716-446655440111",
                    "claimedAt": "2026-07-04T16:00:00Z",
                    "serverTime": "2026-07-04T16:00:00Z"
                }
            })
            .to_string(),
        )
        .await
        .expect("write profile cache");
        tokio::fs::write(
            daemon_config_path(&data_dir),
            serde_json::json!({
                "machineCode": "LEGACY-MACHINE",
                "machineId": "550e8400-e29b-41d4-a716-446655440999",
                "apiBaseUrl": "https://legacy.example.com/api",
                "mqttUrl": "mqtt://legacy-broker.example:1883",
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
        .expect("write bridge config");
        let state = crate::state::LocalStateStore::open(&data_dir.join("state.db"))
            .await
            .expect("state");
        let store = ConfigStore::new(data_dir, state, Arc::new(InMemorySecretStore::default()));

        let runtime = store.load_runtime_config().await.expect("runtime config");

        assert_eq!(runtime.public.machine_code.as_deref(), Some("M001"));
        assert_eq!(
            runtime.public.api_base_url,
            "https://profile.example.com/api"
        );
        assert_eq!(runtime.public.mqtt_url, "mqtt://broker.example:1883");
        assert_eq!(runtime.public.mqtt_client_id.as_deref(), Some("vem-M001"));
    }

    #[test]
    fn reported_runtime_configuration_projects_only_safe_machine_owned_facts() {
        let public = MachinePublicConfig {
            machine_audio_volume: 0.72,
            vision_enabled: false,
            vision_ws_url: "ws://127.0.0.1:7892/ws".to_string(),
            serial_port_path: Some("COM5".to_string()),
            audio_cue_settings: AudioCueSettings {
                enabled: true,
                categories: AudioCueCategorySettings {
                    presence: false,
                    transaction: true,
                },
            },
            ..default_public_config()
        };

        let summary = project_reported_runtime_configuration(&public);

        assert!(summary.audio_cues.enabled);
        assert!(!summary.audio_cues.presence_enabled);
        assert!(summary.audio_cues.transaction_enabled);
        assert_eq!(summary.audio_volume, 72);
        assert!(!summary.vision_recommendations_enabled);
        let serialized = serde_json::to_string(&summary).expect("serialize");
        assert!(!serialized.contains("visionWsUrl"));
        assert!(!serialized.contains("serialPortPath"));
        assert!(!serialized.contains("apiBaseUrl"));
        assert!(!serialized.contains("mqtt"));
    }

    #[tokio::test]
    async fn runtime_configuration_summary_does_not_leak_secret_values() {
        let temp = TempDir::new().expect("temp");
        let data_dir = temp.path().join("vending-daemon");
        let state = crate::state::LocalStateStore::open(&data_dir.join("state.db"))
            .await
            .expect("state");
        let secrets = InMemorySecretStore::default();
        secrets
            .write_secret("machine_secret", "SECRET-MACHINE-VALUE")
            .await
            .expect("machine secret");
        secrets
            .write_secret("mqtt_signing_secret", "SECRET-SIGNING-VALUE")
            .await
            .expect("signing secret");
        secrets
            .write_secret("mqtt_password", "SECRET-MQTT-PASSWORD")
            .await
            .expect("mqtt password");
        let store = ConfigStore::new(data_dir, state, Arc::new(secrets));

        let summary = store
            .load_runtime_configuration_summary()
            .await
            .expect("summary");
        let serialized = serde_json::to_string(&summary).expect("serialize");

        assert!(summary.configured_state.machine_secret_configured);
        assert!(summary.configured_state.mqtt_signing_secret_configured);
        assert!(summary.configured_state.mqtt_password_configured);
        assert!(!serialized.contains("SECRET-MACHINE-VALUE"));
        assert!(!serialized.contains("SECRET-SIGNING-VALUE"));
        assert!(!serialized.contains("SECRET-MQTT-PASSWORD"));
    }

    #[tokio::test]
    async fn runtime_configuration_summary_reports_secret_store_failures_without_secret_values() {
        let temp = TempDir::new().expect("temp");
        let data_dir = temp.path().join("vending-daemon");
        let state = crate::state::LocalStateStore::open(&data_dir.join("state.db"))
            .await
            .expect("state");
        let secrets = Arc::new(ProtectedLocalSecretStore::new(data_dir.clone()));
        let store = ConfigStore::new(data_dir.clone(), state, secrets);
        let invalid_blob = "SECRET-MACHINE-VALUE";
        tokio::fs::create_dir_all(&data_dir)
            .await
            .expect("daemon dir");
        tokio::fs::write(
            daemon_config_path(&data_dir),
            serde_json::to_string(&MachinePublicConfig {
                api_base_url: "https://factory.example.com/api".to_string(),
                ..default_public_config()
            })
            .expect("config json"),
        )
        .await
        .expect("public config");
        tokio::fs::create_dir_all(temp.path().join("secrets"))
            .await
            .expect("secrets dir");
        tokio::fs::write(
            temp.path().join("secrets").join("machine_secret.dpapi"),
            invalid_blob,
        )
        .await
        .expect("invalid secret blob");

        let summary = store
            .load_runtime_configuration_summary()
            .await
            .expect("summary");
        assert_eq!(summary.secret_store.kind, "protected_local_file");
        assert_eq!(summary.secret_store.protection, "deterministic_test_blob");
        assert!(summary.secret_store.last_error.is_some());
        assert!(!summary.configured_state.machine_secret_configured);
        let text = serde_json::to_string(&summary).expect("summary json");
        assert!(!text.contains(invalid_blob));
    }

    #[tokio::test]
    async fn topology_readiness_uses_profile_cache_when_sqlite_metadata_is_missing() {
        let temp = TempDir::new().expect("temp");
        let data_dir = temp.path().join("vending-daemon");
        let state = crate::state::LocalStateStore::open(&data_dir.join("state.db"))
            .await
            .expect("state");
        let store = ConfigStore::new(
            data_dir.clone(),
            state,
            Arc::new(InMemorySecretStore::default()),
        );
        write_factory_manifest_for_test(&data_dir, "vem-prod-24", "2026-06-adr0026").await;
        let profile = valid_provisioning_profile_for_test();
        store
            .write_provisioning_profile_cache_summary(&profile_cache_summary_for_test(&profile))
            .await
            .expect("profile cache");

        let readiness = store
            .hardware_slot_topology_readiness()
            .await
            .expect("readiness");

        assert!(readiness.ready);
        assert_eq!(readiness.code, "HARDWARE_SLOT_TOPOLOGY_MATCH");
        assert_eq!(readiness.platform, Some(profile.hardware_slot_topology));
    }

    #[tokio::test]
    async fn topology_readiness_ignores_stale_sqlite_metadata_when_profile_cache_differs() {
        let temp = TempDir::new().expect("temp");
        let data_dir = temp.path().join("vending-daemon");
        let state = crate::state::LocalStateStore::open(&data_dir.join("state.db"))
            .await
            .expect("state");
        state
            .put_metadata(
                "machine_provisioning_hardware_slot_topology",
                &HardwareSlotTopologyIdentity {
                    identity: "vem-prod-24".to_string(),
                    version: "stale-sqlite-version".to_string(),
                },
            )
            .await
            .expect("stale topology metadata");
        let store = ConfigStore::new(
            data_dir.clone(),
            state,
            Arc::new(InMemorySecretStore::default()),
        );
        write_factory_manifest_for_test(&data_dir, "vem-prod-24", "2026-06-adr0026").await;
        let profile = valid_provisioning_profile_for_test();
        store
            .write_provisioning_profile_cache_summary(&profile_cache_summary_for_test(&profile))
            .await
            .expect("profile cache");

        let readiness = store
            .hardware_slot_topology_readiness()
            .await
            .expect("readiness");

        assert!(readiness.ready);
        assert_eq!(readiness.code, "HARDWARE_SLOT_TOPOLOGY_MATCH");
        assert_eq!(readiness.platform, Some(profile.hardware_slot_topology));
    }

    #[tokio::test]
    async fn topology_readiness_allows_legacy_runtime_when_neither_side_declares_topology() {
        let temp = TempDir::new().expect("temp");
        let data_dir = temp.path().join("vending-daemon");
        let state = crate::state::LocalStateStore::open(&data_dir.join("state.db"))
            .await
            .expect("state");
        let store = ConfigStore::new(data_dir, state, Arc::new(InMemorySecretStore::default()));

        let readiness = store
            .hardware_slot_topology_readiness()
            .await
            .expect("readiness");

        assert!(readiness.ready);
        assert_eq!(readiness.code, "HARDWARE_SLOT_TOPOLOGY_NOT_CONFIGURED");
        assert!(readiness.local.is_none());
        assert!(readiness.platform.is_none());
    }

    #[tokio::test]
    async fn provisioning_profile_writes_protected_secret_blobs_and_reclaim_clears_stale_password()
    {
        let temp = TempDir::new().expect("temp");
        let data_dir = temp.path().join("vending-daemon");
        let state = crate::state::LocalStateStore::open(&data_dir.join("state.db"))
            .await
            .expect("state");
        let secrets = Arc::new(ProtectedLocalSecretStore::new(data_dir.clone()));
        let store = ConfigStore::new(data_dir.clone(), state, secrets.clone());
        store
            .save_public_config(MachinePublicConfig {
                api_base_url: "https://factory.example.com/api".to_string(),
                ..default_public_config()
            })
            .await
            .expect("seed public config");
        let first_profile = valid_provisioning_profile_for_test();
        let machine_secret = first_profile.credentials.machine_secret.clone();
        let signing_secret = first_profile.credentials.mqtt_signing_secret.clone();
        let mqtt_password = first_profile
            .credentials
            .mqtt_connection
            .password
            .clone()
            .expect("password");

        store
            .apply_provisioning_profile(first_profile)
            .await
            .expect("apply profile");

        let runtime_secrets = store.runtime_secrets().await.expect("runtime secrets");
        assert_eq!(
            runtime_secrets.machine_secret.as_deref(),
            Some(machine_secret.as_str())
        );
        assert_eq!(
            runtime_secrets.mqtt_signing_secret.as_deref(),
            Some(signing_secret.as_str())
        );
        assert_eq!(
            runtime_secrets.mqtt_password.as_deref(),
            Some(mqtt_password.as_str())
        );
        let status = secrets.status().await.expect("secret status");
        assert!(status.machine_secret_configured);
        assert!(status.mqtt_signing_secret_configured);
        assert!(status.mqtt_password_configured);

        let protected_dir = temp.path().join("secrets");
        for file_name in [
            "machine_secret.dpapi",
            "mqtt_signing_secret.dpapi",
            "mqtt_password.dpapi",
        ] {
            let blob = tokio::fs::read(protected_dir.join(file_name))
                .await
                .expect("protected blob");
            let blob_text = String::from_utf8_lossy(&blob);
            assert!(!blob_text.contains(&machine_secret));
            assert!(!blob_text.contains(&signing_secret));
            assert!(!blob_text.contains(&mqtt_password));
        }

        let summary = store
            .load_runtime_configuration_summary()
            .await
            .expect("summary");
        let summary_text = serde_json::to_string(&summary).expect("summary json");
        assert!(!summary_text.contains(&machine_secret));
        assert!(!summary_text.contains(&signing_secret));
        assert!(!summary_text.contains(&mqtt_password));

        let mut reclaim_profile = valid_provisioning_profile_for_test();
        reclaim_profile.credentials.machine_secret =
            "vms_reclaimed-machine-secret-123456789012345".to_string();
        reclaim_profile.credentials.mqtt_signing_secret =
            "vms_reclaimed-mqtt-signing-secret-1234567890".to_string();
        reclaim_profile.credentials.mqtt_connection.password = None;
        store
            .apply_provisioning_profile(reclaim_profile)
            .await
            .expect("apply reclaim profile");

        let runtime_secrets = store.runtime_secrets().await.expect("runtime secrets");
        assert_eq!(
            runtime_secrets.machine_secret.as_deref(),
            Some("vms_reclaimed-machine-secret-123456789012345")
        );
        assert_eq!(
            runtime_secrets.mqtt_signing_secret.as_deref(),
            Some("vms_reclaimed-mqtt-signing-secret-1234567890")
        );
        assert!(runtime_secrets.mqtt_password.is_none());
        assert!(secrets
            .read_secret(MQTT_PASSWORD_ACCOUNT)
            .await
            .expect("read password")
            .is_none());
        assert!(secrets
            .read_secret(MACHINE_SECRET_ACCOUNT)
            .await
            .expect("read machine")
            .is_some());
        assert!(secrets
            .read_secret(MQTT_SIGNING_SECRET_ACCOUNT)
            .await
            .expect("read signing")
            .is_some());
    }

    #[tokio::test]
    async fn provisioning_profile_preserves_the_salted_maintenance_pin_verifier_across_claim_and_reclaim(
    ) {
        let temp = TempDir::new().expect("temp");
        let data_dir = temp.path().join("vending-daemon");
        let state = crate::state::LocalStateStore::open(&data_dir.join("state.db"))
            .await
            .expect("state");
        let secrets = Arc::new(InMemorySecretStore::default());
        // PBKDF2-HMAC-SHA-256(2468, 00112233445566778899aabbccddeeff, 120000).
        // Factory delivery carries this verifier, never the PIN itself.
        let verifier = r#"{"version":1,"algorithm":"pbkdf2_hmac_sha256","iterations":120000,"salt":"ABEiM0RVZneImaq7zN3u/w==","digest":"jEOlq6tvHWcnp7Q9bZdfXkpFrllYswV3vYr250nTqJ0="}"#;
        secrets
            .write_secret(crate::secret::MACHINE_MAINTENANCE_PIN_ACCOUNT, verifier)
            .await
            .expect("seed protected verifier");
        let store = ConfigStore::new(data_dir, state, secrets.clone());

        store
            .apply_provisioning_profile(valid_provisioning_profile_for_test())
            .await
            .expect("claim profile");
        assert!(store.verify_maintenance_pin("2468").await.expect("verify"));
        assert!(!store
            .verify_maintenance_pin("9999")
            .await
            .expect("reject wrong pin"));

        let mut reclaim_profile = valid_provisioning_profile_for_test();
        reclaim_profile.credentials.mqtt_connection.password = None;
        store
            .apply_provisioning_profile(reclaim_profile)
            .await
            .expect("reclaim profile");

        let stored = secrets
            .read_secret(crate::secret::MACHINE_MAINTENANCE_PIN_ACCOUNT)
            .await
            .expect("read verifier")
            .expect("verifier retained");
        assert_eq!(stored, verifier);
        assert!(!stored.contains("2468"));
    }

    #[tokio::test]
    async fn factory_maintenance_pin_verifier_is_imported_once_into_the_secret_store() {
        let temp = TempDir::new().expect("temp");
        let data_dir = temp.path().join("vending-daemon");
        let state = crate::state::LocalStateStore::open(&data_dir.join("state.db"))
            .await
            .expect("state");
        let secrets = Arc::new(InMemorySecretStore::default());
        let store = ConfigStore::new(data_dir.clone(), state, secrets.clone());
        let verifier = r#"{"version":1,"algorithm":"pbkdf2_hmac_sha256","iterations":120000,"salt":"ABEiM0RVZneImaq7zN3u/w==","digest":"jEOlq6tvHWcnp7Q9bZdfXkpFrllYswV3vYr250nTqJ0="}"#;
        let staging_path = store.factory_maintenance_pin_verifier_path();
        tokio::fs::create_dir_all(staging_path.parent().expect("parent"))
            .await
            .expect("staging dir");
        tokio::fs::write(&staging_path, verifier)
            .await
            .expect("stage verifier");

        assert!(store
            .import_factory_maintenance_pin_verifier()
            .await
            .expect("import verifier"));
        assert!(!staging_path.exists());
        assert_eq!(
            secrets
                .read_secret(crate::secret::MACHINE_MAINTENANCE_PIN_ACCOUNT)
                .await
                .expect("read verifier"),
            Some(verifier.to_string())
        );
        assert!(store.verify_maintenance_pin("2468").await.expect("verify"));
        assert!(!store
            .import_factory_maintenance_pin_verifier()
            .await
            .expect("one shot"));
    }

    #[tokio::test]
    async fn factory_bootstrap_capability_is_imported_and_consumed_once_without_storing_raw_value()
    {
        let temp = TempDir::new().expect("temp");
        let data_dir = temp.path().join("vending-daemon");
        let state = crate::state::LocalStateStore::open(&data_dir.join("state.db"))
            .await
            .expect("state");
        let secrets = Arc::new(InMemorySecretStore::default());
        let store = ConfigStore::new(data_dir, state, secrets.clone());
        let capability = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde";
        assert_eq!(capability.len(), 43);
        let digest = Sha256::digest(capability.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let verifier = serde_json::json!({
            "version": 1,
            "algorithm": "sha256",
            "digest": digest,
        })
        .to_string();
        let verifier_path = store.factory_bootstrap_capability_verifier_path();
        let capability_path = store.factory_bootstrap_capability_path();
        tokio::fs::create_dir_all(verifier_path.parent().expect("parent"))
            .await
            .expect("factory dir");
        tokio::fs::write(&verifier_path, &verifier)
            .await
            .expect("stage verifier");
        tokio::fs::write(&capability_path, capability)
            .await
            .expect("stage capability");

        assert!(store
            .import_factory_bootstrap_capability_verifier()
            .await
            .expect("import verifier"));
        assert!(!verifier_path.exists());
        let stored = secrets
            .read_secret(crate::secret::MACHINE_FACTORY_BOOTSTRAP_CAPABILITY_ACCOUNT)
            .await
            .expect("read verifier")
            .expect("verifier present");
        assert_eq!(stored, verifier);
        assert!(!stored.contains(capability));
        assert!(!store
            .consume_factory_bootstrap_capability("wrong-capability")
            .await
            .expect("wrong capability"));
        assert!(store
            .consume_factory_bootstrap_capability(capability)
            .await
            .expect("consume capability"));
        assert!(!capability_path.exists());
        assert!(secrets
            .read_secret(crate::secret::MACHINE_FACTORY_BOOTSTRAP_CAPABILITY_ACCOUNT)
            .await
            .expect("read consumed verifier")
            .is_none());
        assert!(!store
            .consume_factory_bootstrap_capability(capability)
            .await
            .expect("cannot replay capability"));
    }

    #[tokio::test]
    async fn raw_or_malformed_maintenance_pin_is_a_provisioning_blocker() {
        let temp = TempDir::new().expect("temp");
        let data_dir = temp.path().join("vending-daemon");
        let state = crate::state::LocalStateStore::open(&data_dir.join("state.db"))
            .await
            .expect("state");
        let secrets = Arc::new(InMemorySecretStore::default());
        secrets
            .write_secret(crate::secret::MACHINE_MAINTENANCE_PIN_ACCOUNT, "2468")
            .await
            .expect("seed legacy raw PIN");
        let store = ConfigStore::new(data_dir, state, secrets);

        let summary = store
            .load_runtime_configuration_summary()
            .await
            .expect("summary");

        assert!(summary.secret_store.maintenance_pin_configured);
        assert!(!summary.configured_state.maintenance_pin_configured);
    }

    #[tokio::test]
    async fn migrates_a_legacy_raw_maintenance_pin_once_to_a_random_salted_verifier() {
        let temp = TempDir::new().expect("temp");
        let data_dir = temp.path().join("vending-daemon");
        let state = crate::state::LocalStateStore::open(&data_dir.join("state.db"))
            .await
            .expect("state");
        let secrets = Arc::new(InMemorySecretStore::default());
        secrets
            .write_secret(crate::secret::MACHINE_MAINTENANCE_PIN_ACCOUNT, "2468")
            .await
            .expect("seed legacy PIN");
        let store = ConfigStore::new(data_dir, state, secrets.clone());

        assert!(store
            .migrate_legacy_raw_maintenance_pin()
            .await
            .expect("migrate legacy PIN"));
        let stored = secrets
            .read_secret(crate::secret::MACHINE_MAINTENANCE_PIN_ACCOUNT)
            .await
            .expect("read verifier")
            .expect("verifier stored");
        assert!(!stored.contains("2468"));
        assert!(store.verify_maintenance_pin("2468").await.expect("verify"));
        assert!(!store
            .migrate_legacy_raw_maintenance_pin()
            .await
            .expect("migration is one shot"));
    }

    #[tokio::test]
    async fn rejects_noncanonical_padded_base64_in_a_maintenance_pin_verifier() {
        let temp = TempDir::new().expect("temp");
        let data_dir = temp.path().join("vending-daemon");
        let state = crate::state::LocalStateStore::open(&data_dir.join("state.db"))
            .await
            .expect("state");
        let secrets = Arc::new(InMemorySecretStore::default());
        secrets
            .write_secret(
                crate::secret::MACHINE_MAINTENANCE_PIN_ACCOUNT,
                r#"{"version":1,"algorithm":"pbkdf2_hmac_sha256","iterations":120000,"salt":"ABEiM0RVZneImaq7zN3u/x==","digest":"jEOlq6tvHWcnp7Q9bZdfXkpFrllYswV3vYr250nTqJ0="}"#,
            )
            .await
            .expect("seed ambiguous verifier");
        let store = ConfigStore::new(data_dir, state, secrets);

        assert!(!store.verify_maintenance_pin("2468").await.expect("verify"));
        let summary = store
            .load_runtime_configuration_summary()
            .await
            .expect("summary");
        assert!(!summary.configured_state.maintenance_pin_configured);
    }

    #[tokio::test]
    async fn apply_provisioning_profile_does_not_persist_public_profile_when_secret_clear_fails() {
        let temp = TempDir::new().expect("temp");
        let data_dir = temp.path().join("vending-daemon");
        let state = crate::state::LocalStateStore::open(&data_dir.join("state.db"))
            .await
            .expect("state");
        let metadata_state = state.clone();
        let secrets = Arc::new(ClearFailingSecretStore::default());
        secrets.seed_old_secrets().await;
        let store = ConfigStore::new(data_dir, state, secrets.clone());
        let mut old_profile = valid_provisioning_profile_for_test();
        old_profile.machine.id = "550e8400-e29b-41d4-a716-446655440999".to_string();
        old_profile.machine.code = "OLD-MACHINE".to_string();
        old_profile.machine.name = "Old Lobby".to_string();
        old_profile.machine.location_label = Some("Old 1F".to_string());
        old_profile.credentials.mqtt_connection.url = "mqtt://old-broker.example:1883".to_string();
        old_profile.credentials.mqtt_connection.client_id = "vem-machine-OLD".to_string();
        old_profile.credentials.mqtt_connection.username = Some("old-machine-client".to_string());
        old_profile.runtime_endpoints.machine_api_base_path =
            "/api/machines/OLD-MACHINE".to_string();
        old_profile.runtime_endpoints.mqtt_topic_prefix = "vem/machines/OLD-MACHINE".to_string();
        old_profile.metadata.claim_code_id = "550e8400-e29b-41d4-a716-446655440888".to_string();
        old_profile.metadata.claimed_at = "2026-06-07T16:30:00.000Z".to_string();
        old_profile.metadata.server_time = "2026-06-07T16:30:00.000Z".to_string();
        let old_claim_code_id = old_profile.metadata.claim_code_id.clone();
        store
            .save_public_config(MachinePublicConfig {
                machine_id: Some(old_profile.machine.id.clone()),
                machine_code: Some(old_profile.machine.code.clone()),
                machine_name: Some(old_profile.machine.name.clone()),
                machine_status: Some("offline".to_string()),
                machine_location_label: old_profile.machine.location_label.clone(),
                api_base_url: "https://old.example.com/api".to_string(),
                mqtt_url: old_profile.credentials.mqtt_connection.url.clone(),
                mqtt_username: old_profile.credentials.mqtt_connection.username.clone(),
                mqtt_client_id: Some(old_profile.credentials.mqtt_connection.client_id.clone()),
                ..default_public_config()
            })
            .await
            .expect("seed old public config");
        store
            .write_provisioning_profile_cache_summary(&ProvisioningProfileCacheSummary {
                profile_version: old_profile.metadata.profile_version,
                machine_id: old_profile.machine.id.clone(),
                machine_code: old_profile.machine.code.clone(),
                machine_name: old_profile.machine.name.clone(),
                machine_status: old_profile.machine.status.clone(),
                machine_location_label: old_profile.machine.location_label.clone(),
                claimed_at: old_profile.metadata.claimed_at.clone(),
                api_base_url: "https://old.example.com/api".to_string(),
                mqtt_url: old_profile.credentials.mqtt_connection.url.clone(),
                mqtt_client_id: old_profile.credentials.mqtt_connection.client_id.clone(),
                mqtt_username: old_profile.credentials.mqtt_connection.username.clone(),
                runtime_endpoints: old_profile.runtime_endpoints.clone(),
                hardware_profile: old_profile.hardware_profile.clone(),
                hardware_slot_topology: Some(old_profile.hardware_slot_topology.clone()),
                payment_capability: old_profile.payment_capability.clone(),
                provisioning_metadata: old_profile.metadata.clone(),
                provisioning_profile: Some(old_profile.provisioning_profile.clone()),
                maintenance: Some(old_profile.maintenance.clone()),
            })
            .await
            .expect("seed old profile cache");
        metadata_state
            .put_metadata(
                "machine_provisioning_claim_code_id",
                &old_profile.metadata.claim_code_id,
            )
            .await
            .expect("seed claim code metadata");

        let err = store
            .apply_provisioning_profile(valid_provisioning_profile_for_test())
            .await
            .expect_err("clear failure aborts provisioning persistence");

        assert!(err.contains("injected clear failure"));
        let public = store.load_public_config().await.expect("public config");
        assert_eq!(public.machine_code.as_deref(), Some("OLD-MACHINE"));
        assert_eq!(
            public.machine_id.as_deref(),
            Some("550e8400-e29b-41d4-a716-446655440999")
        );
        assert_eq!(public.machine_name.as_deref(), Some("Old Lobby"));
        assert_eq!(public.mqtt_url, "mqtt://old-broker.example:1883");
        let profile_cache = store
            .load_provisioning_profile_cache_summary()
            .await
            .expect("profile cache")
            .expect("old profile cache remains");
        assert_eq!(profile_cache.machine_code, "OLD-MACHINE");
        assert_eq!(
            profile_cache.machine_id,
            "550e8400-e29b-41d4-a716-446655440999"
        );
        assert_eq!(profile_cache.mqtt_url, "mqtt://old-broker.example:1883");
        assert_eq!(
            metadata_state
                .get_metadata::<String>("machine_provisioning_claim_code_id")
                .await
                .expect("claim code metadata")
                .as_deref(),
            Some(old_claim_code_id.as_str())
        );
        assert_eq!(
            secrets
                .read_secret(MACHINE_SECRET_ACCOUNT)
                .await
                .expect("machine secret")
                .as_deref(),
            Some("old-machine-secret")
        );
        assert_eq!(
            secrets
                .read_secret(MQTT_SIGNING_SECRET_ACCOUNT)
                .await
                .expect("signing secret")
                .as_deref(),
            Some("old-signing-secret")
        );
        assert_eq!(
            secrets
                .read_secret(MQTT_PASSWORD_ACCOUNT)
                .await
                .expect("mqtt password")
                .as_deref(),
            Some("old-mqtt-password")
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

    #[test]
    fn provisioning_profile_accepts_current_claim_response_shape() {
        let profile: MachineProvisioningProfile = serde_json::from_value(serde_json::json!({
            "machine": {
                "id": "6ad6fb24-2146-44e8-9321-b3706a4609a4",
                "code": "VEM-TESTBED-WINVM-01",
                "name": "Machine Runtime Testbed WINVM 01",
                "status": "offline",
                "locationLabel": null
            },
            "credentials": {
                "machineSecret": "vms_B1ct4uXCKJBiGOwdj04sCWUyU43zGnPXSY2XhdLs7V4",
                "machineSecretVersion": 2,
                "mqttSigningSecret": "vms_ALUqDzT6GuJnrG-sAUF8b1jHVfhqbvdfQvLet-01ac8",
                "mqttConnection": {
                    "url": "mqtt://118.25.104.160:1883",
                    "clientId": "vem-machine-VEM-TESTBED-WINVM-01"
                }
            },
            "apiBaseUrl": "http://127.0.0.1:3000/api",
            "runtimeEndpoints": {
                "apiBasePath": "/api",
                "machineAuthTokenPath": "/api/machine-auth/token",
                "machineApiBasePath": "/api/machines/VEM-TESTBED-WINVM-01",
                "mqttTopicPrefix": "vem/machines/VEM-TESTBED-WINVM-01"
            },
            "hardwareProfile": {
                "profile": "production",
                "controller": { "required": true, "protocol": "vem-vending-controller" },
                "paymentScanner": { "required": true, "supportsPaymentCode": true },
                "vision": { "required": false, "supportsRecommendations": true }
            },
            "hardwareSlotTopology": {
                "identity": "vem-prod-24",
                "version": "2026-06-adr0026"
            },
            "paymentCapability": {
                "profile": "production",
                "qrCodeEnabled": true,
                "paymentCodeEnabled": true,
                "serverTime": "2026-07-05T02:06:21.966Z"
            },
            "provisioningProfile": "testbed",
            "maintenance": {
                "publicKey": "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
                "tunnelAddress": "10.91.16.10",
                "address": "10.91.16.10/32",
                "endpoint": "relay.example:51820",
                "relay": {
                    "publicKey": "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=",
                    "tunnelAddress": "10.91.0.1",
                    "address": "10.91.0.1/32"
                },
                "roleRoutes": {
                    "relay": "10.91.0.1/32",
                    "runner": "10.91.1.0/24",
                    "maintainer": "10.91.3.0/24"
                }
            },
            "metadata": {
                "profileVersion": 1,
                "claimCodeId": "79713f63-db82-4bcd-b530-b8b85180f2a0",
                "claimedAt": "2026-07-05T02:06:21.966Z",
                "serverTime": "2026-07-05T02:06:21.966Z"
            }
        }))
        .expect("current claim response profile");

        ConfigStore::validate_provisioning_profile(&profile).expect("valid profile");
        assert!(profile.payment_capability.options.is_empty());
        assert_eq!(profile.payment_capability.default_option_key, None);
    }

    #[test]
    fn provisioning_profile_rejects_mismatched_or_unsafe_maintenance_routes() {
        let mut mismatched_machine = valid_provisioning_profile_for_test();
        mismatched_machine.maintenance.address = "10.91.16.11/32".to_string();

        let mut mismatched_relay = valid_provisioning_profile_for_test();
        mismatched_relay.maintenance.relay.address = "10.91.0.2/32".to_string();

        let mut default_route = valid_provisioning_profile_for_test();
        default_route.maintenance.role_routes.runner = "0.0.0.0/0".to_string();

        let mut broad_route = valid_provisioning_profile_for_test();
        broad_route.maintenance.role_routes.maintainer = "10.0.0.0/8".to_string();

        let mut host_bits = valid_provisioning_profile_for_test();
        host_bits.maintenance.role_routes.runner = "10.91.1.7/24".to_string();

        let mut overlapping_roles = valid_provisioning_profile_for_test();
        overlapping_roles.maintenance.role_routes.maintainer = "10.91.1.0/24".to_string();

        let mut machine_overlap = valid_provisioning_profile_for_test();
        machine_overlap.maintenance.role_routes.runner = "10.91.16.0/24".to_string();

        let mut wrong_relay_route = valid_provisioning_profile_for_test();
        wrong_relay_route.maintenance.role_routes.relay = "10.91.0.2/32".to_string();

        for profile in [
            mismatched_machine,
            mismatched_relay,
            default_route,
            broad_route,
            host_bits,
            overlapping_roles,
            machine_overlap,
            wrong_relay_route,
        ] {
            assert!(ConfigStore::validate_provisioning_profile(&profile).is_err());
        }
    }

    #[tokio::test]
    async fn restart_recovers_maintenance_status_from_cached_profile_and_persistent_key() {
        let temp = tempfile::tempdir().expect("tempdir");
        let data_dir = temp.path().to_path_buf();
        let state = LocalStateStore::open(&data_dir.join("state.db"))
            .await
            .expect("state");
        let secrets = Arc::new(InMemorySecretStore::default());
        let private_key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
        secrets
            .write_secret(MACHINE_WIREGUARD_PRIVATE_KEY_ACCOUNT, private_key)
            .await
            .expect("seed maintenance key");
        let public_key = crate::maintenance::public_key_from_private_key(private_key)
            .expect("derive public key");
        let store = ConfigStore::new(data_dir.clone(), state.clone(), secrets.clone());
        let mut profile = valid_provisioning_profile_for_test();
        profile.maintenance.public_key = public_key.clone();
        store
            .apply_provisioning_profile(profile)
            .await
            .expect("persist provisioning profile");

        let tunnel = Arc::new(RecoveryTunnel::default());
        let restarted = ConfigStore::new_with_tunnel(data_dir, state, secrets, tunnel.clone());
        assert_eq!(restarted.maintenance_status().await.state, "not_enrolled");

        let recovered = restarted
            .recover_maintenance_from_cache()
            .await
            .expect("recover maintenance")
            .expect("cached maintenance identity");

        assert_eq!(recovered.state, "handshake_pending");
        assert_eq!(recovered.public_key.as_deref(), Some(public_key.as_str()));
        assert_eq!(tunnel.applies.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn secure_decommission_marks_pending_before_destructive_cleanup() {
        let temp = tempfile::tempdir().expect("tempdir");
        let data_dir = temp.path().to_path_buf();
        let state = LocalStateStore::open(&data_dir.join("state.db"))
            .await
            .expect("state");
        let secrets = Arc::new(InMemorySecretStore::default());
        secrets
            .write_secret(
                MACHINE_WIREGUARD_PRIVATE_KEY_ACCOUNT,
                "maintenance-key-present",
            )
            .await
            .expect("seed maintenance key");
        let store = ConfigStore::new_with_tunnel(
            data_dir,
            state.clone(),
            secrets.clone(),
            Arc::new(RemovalFailingTunnel),
        );

        let error = store
            .secure_decommission(&decommission_marker("DCOM-PENDING"))
            .await
            .expect_err("injected cleanup failure");

        assert!(error.contains("injected tunnel removal failure"));
        assert_eq!(
            state
                .get_metadata::<crate::state::store::SecureDecommissionFinalizeMarker>(
                    "secure_decommission_pending_finalize",
                )
                .await
                .expect("pending marker"),
            Some(decommission_marker("DCOM-PENDING"))
        );
        assert!(secrets
            .read_secret(MACHINE_WIREGUARD_PRIVATE_KEY_ACCOUNT)
            .await
            .expect("retained key")
            .is_some());
        let restarted = ConfigStore::new_with_tunnel(
            temp.path().to_path_buf(),
            state,
            secrets,
            Arc::new(RemovalFailingTunnel),
        );
        let restart_error = restarted
            .recover_maintenance_from_cache()
            .await
            .expect_err("a failed pre-ack tunnel cleanup must not start the daemon");
        assert!(restart_error.contains("pending platform acknowledgement"));
    }

    #[tokio::test]
    async fn restart_finishes_decommission_after_persisted_platform_ack() {
        let temp = tempfile::tempdir().expect("tempdir");
        let data_dir = temp.path().join("vending-daemon");
        let state = LocalStateStore::open(&data_dir.join("state.db"))
            .await
            .expect("state");
        let secrets = Arc::new(InMemorySecretStore::default());
        secrets
            .write_secret(MQTT_SIGNING_SECRET_ACCOUNT, "cleanup-signing-secret")
            .await
            .expect("seed signing secret");
        let store = ConfigStore::new(data_dir.clone(), state.clone(), secrets.clone());
        let mut public = default_public_config();
        public.machine_code = Some("M1".to_string());
        store
            .save_public_config(public)
            .await
            .expect("save public config");
        let message_id = "secure-decommission:DCOM-RECOVER";
        let marker = decommission_marker("DCOM-RECOVER");
        store
            .secure_decommission(&marker)
            .await
            .expect("local cleanup");
        let payload = serde_json::json!({
            "commandNo": "DCOM-RECOVER",
            "operation": "secure-decommission"
        });
        state
            .record_destructive_command_received(
                message_id,
                "secure-decommission",
                &payload,
                "2026-07-11T00:00:00.000Z",
            )
            .await
            .expect("record command");
        let result = crate::state::store::OutboxInput::secure_decommission_result(
            "M1",
            "DCOM-RECOVER",
            serde_json::json!({"commandNo":"DCOM-RECOVER","success":true}),
        );
        state
            .record_destructive_command_result_tx(message_id, true, None, &result)
            .await
            .expect("persist result");
        state
            .acknowledge_secure_decommission_result_tx(message_id, &result.id, &marker)
            .await
            .expect("persist atomic platform acknowledgement");

        let restarted = ConfigStore::new(data_dir, state.clone(), secrets.clone());
        assert!(restarted
            .recover_maintenance_from_cache()
            .await
            .expect("recover finalization")
            .is_none());

        assert!(secrets
            .read_secret(MQTT_SIGNING_SECRET_ACCOUNT)
            .await
            .expect("signing secret")
            .is_none());
        assert!(restarted
            .load_public_config()
            .await
            .expect("public config")
            .machine_code
            .is_none());
        assert_eq!(
            state
                .get_metadata::<crate::state::store::SecureDecommissionFinalizeMarker>(
                    "secure_decommission_pending_finalize",
                )
                .await
                .expect("pending marker"),
            None,
        );
    }

    #[tokio::test]
    async fn a_second_decommission_generation_cannot_finalize_from_the_first_ack_marker_after_restart(
    ) {
        let temp = tempfile::tempdir().expect("tempdir");
        let data_dir = temp.path().join("vending-daemon");
        let state = LocalStateStore::open(&data_dir.join("state.db"))
            .await
            .expect("state");
        let secrets = Arc::new(InMemorySecretStore::default());
        let store = ConfigStore::new(data_dir.clone(), state.clone(), secrets.clone());
        let first = decommission_marker("DCOM-FIRST");
        store
            .secure_decommission(&first)
            .await
            .expect("first cleanup");
        state
            .put_metadata(
                "secure_decommission_platform_acknowledged_command_no",
                &first,
            )
            .await
            .expect("first ack marker");
        store
            .finalize_secure_decommission(&first)
            .await
            .expect("first finalization");
        assert_eq!(
            state
                .get_metadata::<crate::state::store::SecureDecommissionFinalizeMarker>(
                    "secure_decommission_platform_acknowledged_command_no",
                )
                .await
                .expect("ack marker"),
            None,
        );

        let mut public = default_public_config();
        public.machine_code = Some("M1".to_string());
        store
            .save_public_config(public)
            .await
            .expect("reprovision config");
        let second = decommission_marker("DCOM-SECOND");
        store
            .secure_decommission(&second)
            .await
            .expect("second cleanup");

        // Simulate a crash between accepting the second result and receiving
        // its platform acknowledgement. A stale first-generation marker must
        // neither finalize nor clear the active second-generation state.
        let restarted = ConfigStore::new(data_dir, state.clone(), secrets);
        let error = restarted
            .recover_maintenance_from_cache()
            .await
            .expect_err("startup refuses an unacknowledged decommission generation");
        assert!(error.contains("pending platform acknowledgement"));
        assert_eq!(
            state
                .get_metadata::<crate::state::store::SecureDecommissionFinalizeMarker>(
                    "secure_decommission_pending_finalize",
                )
                .await
                .expect("pending marker"),
            Some(second.clone()),
        );

        state
            .put_metadata(
                "secure_decommission_platform_acknowledged_command_no",
                &second,
            )
            .await
            .expect("second ack marker");
        assert!(restarted
            .recover_maintenance_from_cache()
            .await
            .expect("second finalization")
            .is_none());
        assert_eq!(
            state
                .get_metadata::<crate::state::store::SecureDecommissionFinalizeMarker>(
                    "secure_decommission_pending_finalize",
                )
                .await
                .expect("pending marker"),
            None,
        );
    }

    #[tokio::test]
    async fn startup_recovery_fails_closed_when_finalization_cannot_clear_secrets() {
        let temp = tempfile::tempdir().expect("tempdir");
        let data_dir = temp.path().join("vending-daemon");
        let state = LocalStateStore::open(&data_dir.join("state.db"))
            .await
            .expect("state");
        let secrets = Arc::new(ClearFailingSecretStore::default());
        secrets.seed_old_secrets().await;
        let store = ConfigStore::new(data_dir, state.clone(), secrets.clone());
        let marker = decommission_marker("DCOM-CLEAR-FAIL");
        state
            .put_metadata("secure_decommission_pending_finalize", &marker)
            .await
            .expect("pending marker");
        state
            .put_metadata(
                "secure_decommission_platform_acknowledged_command_no",
                &marker,
            )
            .await
            .expect("ack marker");

        let error = store
            .recover_maintenance_from_cache()
            .await
            .expect_err("startup must fail closed");
        assert!(error.contains("injected clear failure"));
        assert_eq!(
            store
                .runtime_secrets()
                .await
                .expect("secrets remain unread by failed startup")
                .machine_secret
                .as_deref(),
            Some("old-machine-secret"),
        );
    }

    #[tokio::test]
    async fn startup_recovery_fails_closed_when_profile_or_default_config_cleanup_fails() {
        for failure in ["profile", "default-config"] {
            let temp = tempfile::tempdir().expect("tempdir");
            let data_dir = temp.path().join("vending-daemon");
            let state = LocalStateStore::open(&data_dir.join("state.db"))
                .await
                .expect("state");
            let secrets = Arc::new(InMemorySecretStore::default());
            secrets
                .write_secret(MACHINE_SECRET_ACCOUNT, "old-machine-secret")
                .await
                .expect("seed machine secret");
            let store = ConfigStore::new(data_dir.clone(), state.clone(), secrets.clone());
            let mut old = default_public_config();
            old.machine_code = Some("OLD-MACHINE".to_string());
            store.save_public_config(old).await.expect("old config");
            let marker = decommission_marker(&format!("DCOM-{failure}"));
            state
                .put_metadata("secure_decommission_pending_finalize", &marker)
                .await
                .expect("pending marker");
            state
                .put_metadata(
                    "secure_decommission_platform_acknowledged_command_no",
                    &marker,
                )
                .await
                .expect("ack marker");
            match failure {
                "profile" => {
                    fs::create_dir_all(store.provisioning_profile_cache_summary_path())
                        .await
                        .expect("block profile deletion");
                }
                "default-config" => {
                    fs::remove_file(daemon_config_path(&data_dir))
                        .await
                        .expect("remove old config");
                    fs::create_dir(daemon_config_path(&data_dir))
                        .await
                        .expect("block config rewrite");
                }
                _ => unreachable!(),
            }

            let error = store
                .recover_maintenance_from_cache()
                .await
                .expect_err("startup must fail closed");
            assert!(
                error.contains(if failure == "profile" {
                    "remove provisioning profile"
                } else {
                    "write daemon config"
                }),
                "{failure}: {error}",
            );
            assert!(store
                .runtime_secrets()
                .await
                .expect("secrets")
                .machine_secret
                .is_none());
        }
    }
}
