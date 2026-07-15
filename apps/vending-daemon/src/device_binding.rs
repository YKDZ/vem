use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObservedSerialDevice {
    pub current_port: String,
    pub instance_id: Option<String>,
    pub container_id: Option<String>,
    #[serde(default)]
    pub hardware_ids: Vec<String>,
    pub serial_number: Option<String>,
    pub friendly_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StableSerialDeviceIdentity {
    pub identity_key: String,
    pub instance_id: Option<String>,
    pub container_id: Option<String>,
    #[serde(default)]
    pub hardware_ids: Vec<String>,
    pub serial_number: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum LocalDeviceRole {
    LowerController,
    Scanner,
}

impl LocalDeviceRole {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::LowerController => "lower_controller",
            Self::Scanner => "scanner",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalSerialRoleBinding {
    pub identity: StableSerialDeviceIdentity,
    pub confirmed_at: String,
    pub confirmed_by: String,
    pub test_evidence_code: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DeviceCandidateReadiness {
    Candidate,
    Ready,
    Blocked,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DeviceBindingAmbiguityKind {
    CandidateSelection,
    DuplicateObservation,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceBindingCandidate {
    pub identity: StableSerialDeviceIdentity,
    pub current_port: String,
    pub friendly_name: Option<String>,
    pub readiness: DeviceCandidateReadiness,
    pub readiness_code: String,
    pub readiness_message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceDiscoveryDiagnostic {
    pub current_port: String,
    pub friendly_name: Option<String>,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceRoleRuntimeReadiness {
    pub online: bool,
    pub current_port: Option<String>,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceRoleBindingSnapshot {
    pub role: LocalDeviceRole,
    pub binding: Option<LocalSerialRoleBinding>,
    pub current_port: Option<String>,
    pub ready: bool,
    pub code: String,
    pub message: String,
    pub ambiguous: bool,
    pub ambiguity_kind: Option<DeviceBindingAmbiguityKind>,
    pub ambiguity_ports: Vec<String>,
    pub legacy_port_hint: Option<String>,
    pub candidates: Vec<DeviceBindingCandidate>,
    pub discovery_diagnostics: Vec<DeviceDiscoveryDiagnostic>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceBindingTestResult {
    pub role: LocalDeviceRole,
    pub identity_key: String,
    pub current_port: String,
    pub success: bool,
    pub code: String,
    pub message: String,
    pub tested_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SerialDeviceRoleProbeConfig {
    pub scanner_baud_rate: u32,
    pub scanner_frame_suffix: vending_core::scanner::ScannerFrameSuffix,
}

impl Default for SerialDeviceRoleProbeConfig {
    fn default() -> Self {
        Self {
            scanner_baud_rate: 9_600,
            scanner_frame_suffix: vending_core::scanner::ScannerFrameSuffix::Crlf,
        }
    }
}

impl From<&crate::config::MachinePublicConfig> for SerialDeviceRoleProbeConfig {
    fn from(config: &crate::config::MachinePublicConfig) -> Self {
        Self {
            scanner_baud_rate: config.scanner_baud_rate,
            scanner_frame_suffix: config.scanner_frame_suffix,
        }
    }
}

#[async_trait]
pub trait SerialDevicePlatform: Send + Sync {
    async fn discover(&self) -> Result<Vec<ObservedSerialDevice>, String>;

    async fn test_candidate(
        &self,
        role: LocalDeviceRole,
        candidate: &ObservedSerialDevice,
        probe_config: &SerialDeviceRoleProbeConfig,
    ) -> DeviceBindingTestResult;
}

pub type SharedSerialDevicePlatform = Arc<dyn SerialDevicePlatform>;

#[derive(Default)]
pub struct WindowsSerialDevicePlatform;

#[async_trait]
impl SerialDevicePlatform for WindowsSerialDevicePlatform {
    async fn discover(&self) -> Result<Vec<ObservedSerialDevice>, String> {
        if !cfg!(windows) {
            return Err("Windows serial discovery is available only on Windows".to_string());
        }
        let output = tokio::process::Command::new("powershell.exe")
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                WINDOWS_SERIAL_DISCOVERY_SCRIPT,
            ])
            .output()
            .await
            .map_err(|error| format!("start Windows serial discovery failed: {error}"))?;
        if !output.status.success() {
            return Err(format!(
                "Windows serial discovery failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        parse_windows_serial_discovery(&output.stdout)
    }

    async fn test_candidate(
        &self,
        role: LocalDeviceRole,
        candidate: &ObservedSerialDevice,
        probe_config: &SerialDeviceRoleProbeConfig,
    ) -> DeviceBindingTestResult {
        let tested_at = crate::state::store::now_iso();
        let stable_identity = StableSerialDeviceIdentity::try_from_observation(candidate);
        let result = if let Err(error) = &stable_identity {
            (false, "DEVICE_PHYSICAL_IDENTITY_INVALID", error.to_string())
        } else {
            match role {
                LocalDeviceRole::LowerController => {
                    let mut config = crate::config::default_public_config();
                    config.hardware_adapter = crate::config::HardwareAdapterKind::Serial;
                    config.serial_port_path = Some(candidate.current_port.clone());
                    config.lower_controller_usb_identity = None;
                    match crate::hardware::HardwareSupervisor::from_config(&config) {
                        Ok(supervisor) => {
                            let status = supervisor.self_check().await;
                            (
                                status.online,
                                if status.online {
                                    "LOWER_CONTROLLER_HANDSHAKE_READY"
                                } else {
                                    "LOWER_CONTROLLER_HANDSHAKE_FAILED"
                                },
                                status.message,
                            )
                        }
                        Err(error) => (false, "LOWER_CONTROLLER_TEST_CONFIG_INVALID", error),
                    }
                }
                LocalDeviceRole::Scanner => {
                    use tokio::io::AsyncReadExt as _;
                    use tokio_serial::SerialPortBuilderExt as _;
                    match tokio_serial::new(&candidate.current_port, probe_config.scanner_baud_rate)
                        .open_native_async()
                    {
                        Ok(mut port) => {
                            let probe =
                                tokio::time::timeout(std::time::Duration::from_secs(2), async {
                                    let mut framer = vending_core::scanner::ScannerFramer::new(
                                        probe_config.scanner_frame_suffix,
                                    );
                                    let mut chunk = [0_u8; 64];
                                    loop {
                                        let read =
                                            port.read(&mut chunk).await.map_err(|error| {
                                                format!(
                                                    "read scanner protocol frame failed: {error}"
                                                )
                                            })?;
                                        if read == 0 {
                                            tokio::task::yield_now().await;
                                            continue;
                                        }
                                        if !framer
                                            .push_bytes(
                                                &chunk[..read],
                                                crate::state::store::now_millis(),
                                            )
                                            .is_empty()
                                        {
                                            return Ok(());
                                        }
                                    }
                                })
                                .await;
                            match probe {
                                Ok(Ok(())) => (
                                    true,
                                    "SCANNER_PROTOCOL_FRAME_READY",
                                    "scanner emitted a valid delimited protocol frame".to_string(),
                                ),
                                Ok(Err(error)) => {
                                    (false, "SCANNER_PROTOCOL_READ_FAILED", error)
                                }
                                Err(_) => (
                                    false,
                                    "SCANNER_PROTOCOL_FRAME_TIMEOUT",
                                    "scanner port opened but emitted no valid protocol frame within 2 seconds"
                                        .to_string(),
                                ),
                            }
                        }
                        Err(error) => (
                            false,
                            "SCANNER_PORT_OPEN_FAILED",
                            format!("open scanner serial failed: {error}"),
                        ),
                    }
                }
            }
        };
        DeviceBindingTestResult {
            role,
            identity_key: stable_identity
                .map(|identity| identity.identity_key)
                .unwrap_or_default(),
            current_port: candidate.current_port.clone(),
            success: result.0,
            code: result.1.to_string(),
            message: result.2,
            tested_at,
        }
    }
}

const WINDOWS_SERIAL_DISCOVERY_SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
$devices = @(Get-CimInstance Win32_SerialPort | ForEach-Object {
  $instanceId = [string]$_.PNPDeviceID
  $containerId = $null
  $hardwareIds = @()
  try { $containerId = [string](Get-PnpDeviceProperty -InstanceId $instanceId -KeyName 'DEVPKEY_Device_ContainerId').Data } catch {}
  try { $hardwareIds = @((Get-PnpDeviceProperty -InstanceId $instanceId -KeyName 'DEVPKEY_Device_HardwareIds').Data) } catch {}
  $serialNumber = $null
  if ($instanceId -match '\\([^\\]+)$' -and $Matches[1] -notmatch '&') { $serialNumber = $Matches[1] }
  [pscustomobject]@{
    currentPort = [string]$_.DeviceID
    instanceId = $instanceId
    containerId = $containerId
    hardwareIds = @($hardwareIds | ForEach-Object { [string]$_ })
    serialNumber = $serialNumber
    friendlyName = [string]$_.Name
  }
})
ConvertTo-Json -Compress -Depth 4 -InputObject $devices
"#;

pub fn parse_windows_serial_discovery(payload: &[u8]) -> Result<Vec<ObservedSerialDevice>, String> {
    let value: serde_json::Value = serde_json::from_slice(payload)
        .map_err(|error| format!("parse Windows serial discovery failed: {error}"))?;
    let mut devices: Vec<ObservedSerialDevice> = if value.is_array() {
        serde_json::from_value(value)
    } else if value.is_object() {
        serde_json::from_value(serde_json::Value::Array(vec![value]))
    } else {
        return Err("Windows serial discovery returned an invalid payload".to_string());
    }
    .map_err(|error| format!("parse Windows serial discovery devices failed: {error}"))?;
    for device in &mut devices {
        let Some(current_port) = normalize_windows_com_port(&device.current_port) else {
            return Err(format!(
                "Windows serial discovery currentPort must be a canonical COMn value, got {:?}",
                device.current_port
            ));
        };
        device.current_port = current_port;
    }
    Ok(devices)
}

fn normalize_windows_com_port(value: &str) -> Option<String> {
    let value = value.trim().to_ascii_uppercase();
    let number = value.strip_prefix("COM")?;
    if number.is_empty() || !number.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let number = number.parse::<u16>().ok()?;
    (number > 0).then(|| format!("COM{number}"))
}

impl StableSerialDeviceIdentity {
    pub fn try_from_observation(observed: &ObservedSerialDevice) -> Result<Self, String> {
        let hardware_ids = canonical_usb_hardware_ids(&observed.hardware_ids);
        if !has_physical_usb_evidence(observed, &hardware_ids) {
            return Err(
                "serial device has no supported physical USB VID/PID evidence; virtual, ROOT, ACPI, software and pseudo ports cannot be bound"
                    .to_string(),
            );
        }
        let container_id = observed
            .container_id
            .as_deref()
            .and_then(normalize_container_id);
        let instance_id = normalize_optional_identity(observed.instance_id.as_deref());
        let serial_number = observed
            .serial_number
            .as_deref()
            .and_then(normalize_stable_usb_serial);
        let identity_key = if let Some(container_id) = container_id.as_deref() {
            format!("container:{container_id}")
        } else if let (Some(serial), Some(hardware_id)) =
            (serial_number.as_deref(), hardware_ids.first())
        {
            format!(
                "usb:{}:{}",
                hardware_id.to_ascii_lowercase(),
                serial.to_ascii_lowercase()
            )
        } else {
            return Err(
                "serial device has no stable USB identity; use a valid ContainerId or USB VID/PID with a manufacturer serial number"
                    .to_string(),
            );
        };
        Ok(Self {
            identity_key,
            instance_id,
            container_id,
            hardware_ids,
            serial_number,
        })
    }

    pub fn matches(&self, observed: &ObservedSerialDevice) -> bool {
        Self::try_from_observation(observed)
            .is_ok_and(|candidate| candidate.identity_key == self.identity_key)
    }
}

fn normalize_optional_identity(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn normalize_container_id(value: &str) -> Option<String> {
    let normalized = value.trim().trim_start_matches('{').trim_end_matches('}');
    uuid::Uuid::parse_str(normalized)
        .ok()
        .filter(|value| !value.is_nil())
        .map(|value| value.hyphenated().to_string())
}

fn normalize_stable_usb_serial(value: &str) -> Option<String> {
    let value = value.trim();
    let upper = value.to_ascii_uppercase();
    if value.is_empty()
        || value.len() > 128
        || value.contains('&')
        || upper.contains("PSEUDO")
        || upper.contains("LOCATION")
        || upper.contains("PORT")
        || upper.starts_with("MI_")
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return None;
    }
    Some(value.to_string())
}

fn has_physical_usb_evidence(observed: &ObservedSerialDevice, hardware_ids: &[String]) -> bool {
    let Some(instance_id) = observed.instance_id.as_deref() else {
        return false;
    };
    let instance_id = instance_id.trim().to_ascii_uppercase();
    if !instance_id.starts_with("USB\\") || hardware_ids.is_empty() {
        return false;
    }
    if observed.friendly_name.as_deref().is_some_and(|name| {
        let name = name.to_ascii_uppercase();
        ["VIRTUAL", "PSEUDO", "EMULATED"]
            .iter()
            .any(|marker| name.contains(marker))
    }) {
        return false;
    }
    hardware_ids
        .iter()
        .any(|hardware_id| instance_id.contains(hardware_id))
}

fn canonical_usb_hardware_ids(values: &[String]) -> Vec<String> {
    let mut canonical = values
        .iter()
        .filter_map(|value| {
            let upper = value.trim().to_ascii_uppercase();
            if !upper.starts_with("USB\\") {
                return None;
            }
            let vid_start = upper.find("VID_")? + 4;
            let pid_start = upper.find("PID_")? + 4;
            let vid = upper.get(vid_start..vid_start + 4)?;
            let pid = upper.get(pid_start..pid_start + 4)?;
            if !vid.bytes().all(|byte| byte.is_ascii_hexdigit())
                || !pid.bytes().all(|byte| byte.is_ascii_hexdigit())
            {
                return None;
            }
            Some(format!("USB\\VID_{vid}&PID_{pid}"))
        })
        .collect::<Vec<_>>();
    canonical.sort();
    canonical.dedup();
    canonical
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BindingResolution {
    Missing,
    Ambiguous(Vec<String>),
    Resolved(String),
}

pub fn resolve_bound_port(
    binding: &StableSerialDeviceIdentity,
    observed: &[ObservedSerialDevice],
) -> BindingResolution {
    let mut ports = observed
        .iter()
        .filter(|candidate| binding.matches(candidate))
        .map(|candidate| candidate.current_port.clone())
        .collect::<Vec<_>>();
    ports.sort();
    match ports.as_slice() {
        [] => BindingResolution::Missing,
        [port] => BindingResolution::Resolved(port.clone()),
        _ => BindingResolution::Ambiguous(ports),
    }
}

pub fn project_role_binding(
    role: LocalDeviceRole,
    binding: Option<LocalSerialRoleBinding>,
    legacy_port_hint: Option<String>,
    observed: &[ObservedSerialDevice],
    runtime_readiness: Option<DeviceRoleRuntimeReadiness>,
) -> DeviceRoleBindingSnapshot {
    let mut candidates = Vec::new();
    let mut discovery_diagnostics = Vec::new();
    for candidate in observed {
        match StableSerialDeviceIdentity::try_from_observation(candidate) {
            Ok(identity) => candidates.push(DeviceBindingCandidate {
                identity,
                current_port: candidate.current_port.clone(),
                friendly_name: candidate.friendly_name.clone(),
                readiness: DeviceCandidateReadiness::Candidate,
                readiness_code: "ROLE_TEST_REQUIRED".to_string(),
                readiness_message: "candidate requires role-specific protected test".to_string(),
            }),
            Err(message) => discovery_diagnostics.push(DeviceDiscoveryDiagnostic {
                current_port: candidate.current_port.clone(),
                friendly_name: candidate.friendly_name.clone(),
                code: "DEVICE_IDENTITY_NOT_BINDABLE".to_string(),
                message,
            }),
        }
    }
    let mut identity_observation_counts = std::collections::HashMap::new();
    for candidate in &candidates {
        *identity_observation_counts
            .entry(candidate.identity.identity_key.as_str())
            .or_insert(0_usize) += 1;
    }
    let duplicate_observation_ports = candidates
        .iter()
        .filter(|candidate| {
            identity_observation_counts
                .get(candidate.identity.identity_key.as_str())
                .is_some_and(|count| *count > 1)
        })
        .map(|candidate| candidate.current_port.clone())
        .collect::<Vec<_>>();

    let (current_port, ready, code, message, ambiguous, ambiguity_ports) =
        match binding.as_ref() {
            Some(binding) => match resolve_bound_port(&binding.identity, observed) {
                BindingResolution::Resolved(port) => match runtime_readiness.as_ref() {
                    Some(runtime)
                        if runtime.online
                            && runtime.current_port.as_deref() == Some(port.as_str()) =>
                    {
                        (
                            Some(port),
                            true,
                            "DEVICE_BINDING_RESOLVED".to_string(),
                            "bound device resolved and its role runtime self-check is ready"
                                .to_string(),
                            false,
                            vec![],
                        )
                    }
                    Some(runtime) => (
                        Some(port),
                        false,
                        "DEVICE_BINDING_RUNTIME_NOT_READY".to_string(),
                        format!(
                            "bound device is attached but its role runtime is not ready ({}): {}",
                            runtime.code, runtime.message
                        ),
                        false,
                        vec![],
                    ),
                    None => (
                        Some(port),
                        false,
                        "DEVICE_BINDING_RUNTIME_STATUS_UNKNOWN".to_string(),
                        "bound device is attached but no role runtime self-check evidence is available"
                            .to_string(),
                        false,
                        vec![],
                    ),
                },
                BindingResolution::Missing => (
                    None,
                    false,
                    "DEVICE_BINDING_MISSING".to_string(),
                    format!(
                        "{} binding is not currently attached; replug or replace it in protected maintenance",
                        role.as_str()
                    ),
                    false,
                    vec![],
                ),
                BindingResolution::Ambiguous(ports) => (
                    None,
                    false,
                    "DEVICE_BINDING_AMBIGUOUS".to_string(),
                    format!(
                        "{} binding resolved to multiple Windows ports; select and test the intended device",
                        role.as_str()
                    ),
                    true,
                    ports,
                ),
            },
            None if !duplicate_observation_ports.is_empty() => (
                None,
                false,
                "DEVICE_BINDING_AMBIGUOUS".to_string(),
                format!(
                    "{} discovery returned duplicate observations for the same stable identity",
                    role.as_str()
                ),
                true,
                duplicate_observation_ports,
            ),
            None if candidates.len() > 1 => (
                None,
                false,
                "DEVICE_BINDING_SELECTION_REQUIRED".to_string(),
                format!(
                    "multiple {} candidates require protected operator selection",
                    role.as_str()
                ),
                true,
                candidates.iter().map(|item| item.current_port.clone()).collect(),
            ),
            None => (
                None,
                false,
                "DEVICE_BINDING_REQUIRED".to_string(),
                format!(
                    "{} requires a tested stable device binding",
                    role.as_str()
                ),
                false,
                vec![],
            ),
        };

    let ambiguity_kind = match code.as_str() {
        "DEVICE_BINDING_SELECTION_REQUIRED" => Some(DeviceBindingAmbiguityKind::CandidateSelection),
        "DEVICE_BINDING_AMBIGUOUS" => Some(DeviceBindingAmbiguityKind::DuplicateObservation),
        _ => None,
    };

    DeviceRoleBindingSnapshot {
        role,
        binding,
        current_port,
        ready,
        code,
        message,
        ambiguous,
        ambiguity_kind,
        ambiguity_ports,
        legacy_port_hint,
        candidates,
        discovery_diagnostics,
    }
}

pub fn apply_resolved_binding_to_runtime_config(
    config: &mut crate::config::MachinePublicConfig,
    role: LocalDeviceRole,
    binding: &LocalSerialRoleBinding,
    observed: &[ObservedSerialDevice],
) -> Result<String, String> {
    let port = match resolve_bound_port(&binding.identity, observed) {
        BindingResolution::Resolved(port) => port,
        BindingResolution::Missing => {
            return Err(format!("{}_binding_missing", role.as_str()));
        }
        BindingResolution::Ambiguous(_) => {
            return Err(format!("{}_binding_ambiguous", role.as_str()));
        }
    };
    match role {
        LocalDeviceRole::LowerController => {
            config.hardware_adapter = crate::config::HardwareAdapterKind::Serial;
            config.serial_port_path = Some(port.clone());
            config.lower_controller_usb_identity = None;
        }
        LocalDeviceRole::Scanner => {
            config.scanner_adapter = crate::config::ScannerAdapterKind::SerialText;
            config.scanner_serial_port_path = Some(port.clone());
            config.scanner_usb_identity = None;
        }
    }
    Ok(port)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    #[cfg(unix)]
    async fn scanner_candidate_rejects_an_oversized_protocol_frame() {
        use std::os::fd::{FromRawFd, IntoRawFd};

        use nix::fcntl::OFlag;
        use nix::pty::{grantpt, posix_openpt, ptsname_r, unlockpt};
        use tokio::io::AsyncWriteExt as _;

        let master = posix_openpt(OFlag::O_RDWR | OFlag::O_NOCTTY).expect("open pty");
        grantpt(&master).expect("grant pty");
        unlockpt(&master).expect("unlock pty");
        let candidate = ObservedSerialDevice {
            current_port: ptsname_r(&master).expect("slave path"),
            instance_id: Some("USB\\VID_1234&PID_5678\\SCANNER-1".to_string()),
            container_id: Some("{aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee}".to_string()),
            hardware_ids: vec!["USB\\VID_1234&PID_5678".to_string()],
            serial_number: Some("SCANNER-1".to_string()),
            friendly_name: Some("USB scanner".to_string()),
        };
        let fd = master.into_raw_fd();
        // SAFETY: ownership of the freshly extracted PTY file descriptor is transferred once.
        let mut master = tokio::fs::File::from_std(unsafe { std::fs::File::from_raw_fd(fd) });
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            let mut oversized = vec![b'1'; vending_core::scanner::SCANNER_MAX_FRAME_BYTES + 1];
            oversized.extend_from_slice(b"\r\n");
            master
                .write_all(&oversized)
                .await
                .expect("write oversized scanner frame");
            master.flush().await.expect("flush scanner frame");
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        });

        let result = WindowsSerialDevicePlatform
            .test_candidate(
                LocalDeviceRole::Scanner,
                &candidate,
                &SerialDeviceRoleProbeConfig::default(),
            )
            .await;

        assert!(!result.success);
        assert_eq!(result.code, "SCANNER_PROTOCOL_FRAME_TIMEOUT");
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn scanner_candidate_rejects_invalid_bytes_then_accepts_the_next_frame() {
        use std::os::fd::{FromRawFd, IntoRawFd};

        use nix::fcntl::OFlag;
        use nix::pty::{grantpt, posix_openpt, ptsname_r, unlockpt};
        use tokio::io::AsyncWriteExt as _;

        let master = posix_openpt(OFlag::O_RDWR | OFlag::O_NOCTTY).expect("open pty");
        grantpt(&master).expect("grant pty");
        unlockpt(&master).expect("unlock pty");
        let candidate = ObservedSerialDevice {
            current_port: ptsname_r(&master).expect("slave path"),
            instance_id: Some("USB\\VID_1234&PID_5678\\SCANNER-2".to_string()),
            container_id: Some("{bbbbbbbb-cccc-dddd-eeee-ffffffffffff}".to_string()),
            hardware_ids: vec!["USB\\VID_1234&PID_5678".to_string()],
            serial_number: Some("SCANNER-2".to_string()),
            friendly_name: Some("USB scanner".to_string()),
        };
        let fd = master.into_raw_fd();
        // SAFETY: ownership of the freshly extracted PTY file descriptor is transferred once.
        let mut master = tokio::fs::File::from_std(unsafe { std::fs::File::from_raw_fd(fd) });
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            master
                .write_all(b"\xff12\r\n6901234567892\r\n")
                .await
                .expect("write invalid and valid scanner frames");
            master.flush().await.expect("flush scanner frame");
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        });

        let result = WindowsSerialDevicePlatform
            .test_candidate(
                LocalDeviceRole::Scanner,
                &candidate,
                &SerialDeviceRoleProbeConfig::default(),
            )
            .await;

        assert!(result.success, "unexpected probe failure: {result:?}");
        assert_eq!(result.code, "SCANNER_PROTOCOL_FRAME_READY");
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn scanner_candidate_probe_supports_lf_and_cr_production_suffixes() {
        use std::os::fd::{FromRawFd, IntoRawFd};

        use nix::fcntl::OFlag;
        use nix::pty::{grantpt, posix_openpt, ptsname_r, unlockpt};
        use tokio::io::AsyncWriteExt as _;

        for (suffix, bytes) in [
            (
                vending_core::scanner::ScannerFrameSuffix::Lf,
                b"6901234567892\n".as_slice(),
            ),
            (
                vending_core::scanner::ScannerFrameSuffix::Cr,
                b"6901234567892\r".as_slice(),
            ),
        ] {
            let master = posix_openpt(OFlag::O_RDWR | OFlag::O_NOCTTY).expect("open pty");
            grantpt(&master).expect("grant pty");
            unlockpt(&master).expect("unlock pty");
            let candidate = ObservedSerialDevice {
                current_port: ptsname_r(&master).expect("slave path"),
                instance_id: Some("USB\\VID_1234&PID_5678\\SCANNER-SUFFIX".to_string()),
                container_id: Some("{dddddddd-eeee-ffff-1111-222222222222}".to_string()),
                hardware_ids: vec!["USB\\VID_1234&PID_5678".to_string()],
                serial_number: Some("SCANNER-SUFFIX".to_string()),
                friendly_name: Some("USB scanner".to_string()),
            };
            let fd = master.into_raw_fd();
            // SAFETY: ownership of the freshly extracted PTY file descriptor is transferred once.
            let mut master = tokio::fs::File::from_std(unsafe { std::fs::File::from_raw_fd(fd) });
            let bytes = bytes.to_vec();
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                master.write_all(&bytes).await.expect("write scanner frame");
                master.flush().await.expect("flush scanner frame");
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            });
            let result = WindowsSerialDevicePlatform
                .test_candidate(
                    LocalDeviceRole::Scanner,
                    &candidate,
                    &SerialDeviceRoleProbeConfig {
                        scanner_baud_rate: 115_200,
                        scanner_frame_suffix: suffix,
                    },
                )
                .await;

            assert!(result.success, "suffix {suffix:?}: {result:?}");
        }
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn scanner_candidate_none_suffix_completes_at_the_production_read_boundary() {
        use std::os::fd::{FromRawFd, IntoRawFd};

        use nix::fcntl::OFlag;
        use nix::pty::{grantpt, posix_openpt, ptsname_r, unlockpt};
        use tokio::io::AsyncWriteExt as _;

        let master = posix_openpt(OFlag::O_RDWR | OFlag::O_NOCTTY).expect("open pty");
        grantpt(&master).expect("grant pty");
        unlockpt(&master).expect("unlock pty");
        let candidate = ObservedSerialDevice {
            current_port: ptsname_r(&master).expect("slave path"),
            instance_id: Some("USB\\VID_1234&PID_5678\\SCANNER-NONE".to_string()),
            container_id: Some("{cccccccc-dddd-eeee-ffff-111111111111}".to_string()),
            hardware_ids: vec!["USB\\VID_1234&PID_5678".to_string()],
            serial_number: Some("SCANNER-NONE".to_string()),
            friendly_name: Some("USB scanner".to_string()),
        };
        let fd = master.into_raw_fd();
        // SAFETY: ownership of the freshly extracted PTY file descriptor is transferred once.
        let mut master = tokio::fs::File::from_std(unsafe { std::fs::File::from_raw_fd(fd) });
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            master
                .write_all(b"6901234567892")
                .await
                .expect("write scanner frame without delimiter");
            master.flush().await.expect("flush scanner frame");
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        });
        let probe_config = SerialDeviceRoleProbeConfig {
            scanner_baud_rate: 115_200,
            scanner_frame_suffix: vending_core::scanner::ScannerFrameSuffix::None,
        };

        let result = WindowsSerialDevicePlatform
            .test_candidate(LocalDeviceRole::Scanner, &candidate, &probe_config)
            .await;

        assert!(result.success, "unexpected probe failure: {result:?}");
        assert_eq!(result.code, "SCANNER_PROTOCOL_FRAME_READY");
    }

    #[test]
    fn stable_identity_follows_container_across_com_reenumeration() {
        let before = ObservedSerialDevice {
            current_port: "COM3".to_string(),
            instance_id: Some("USB\\VID_1234&PID_5678\\A".to_string()),
            container_id: Some("{7B20B37E-55D4-4D13-9A72-C62C0F981A88}".to_string()),
            hardware_ids: vec!["USB\\VID_1234&PID_5678".to_string()],
            serial_number: None,
            friendly_name: Some("USB Serial Port".to_string()),
        };
        let after = ObservedSerialDevice {
            current_port: "COM11".to_string(),
            instance_id: Some("USB\\VID_1234&PID_5678\\B".to_string()),
            container_id: Some("{7b20b37e-55d4-4d13-9a72-c62c0f981a88}".to_string()),
            hardware_ids: before.hardware_ids.clone(),
            serial_number: None,
            friendly_name: before.friendly_name.clone(),
        };

        let binding = StableSerialDeviceIdentity::try_from_observation(&before)
            .expect("container identity is stable");

        assert!(binding.matches(&after));
        assert_eq!(
            binding.identity_key,
            "container:7b20b37e-55d4-4d13-9a72-c62c0f981a88"
        );
        assert_eq!(
            resolve_bound_port(&binding, &[after]),
            BindingResolution::Resolved("COM11".to_string())
        );
    }

    #[test]
    fn bound_role_reports_ambiguity_instead_of_selecting_the_first_com_port() {
        let identity = StableSerialDeviceIdentity {
            identity_key: "container:11111111-2222-3333-4444-555555555555".to_string(),
            instance_id: None,
            container_id: Some("11111111-2222-3333-4444-555555555555".to_string()),
            hardware_ids: vec![],
            serial_number: None,
        };
        let binding = LocalSerialRoleBinding {
            identity,
            confirmed_at: "2026-07-15T00:00:00Z".to_string(),
            confirmed_by: "operator-1".to_string(),
            test_evidence_code: "LOWER_CONTROLLER_HANDSHAKE_READY".to_string(),
        };
        let observed = ["COM4", "COM9"].map(|port| ObservedSerialDevice {
            current_port: port.to_string(),
            instance_id: Some("USB\\VID_1234&PID_5678\\AMBIGUOUS-1".to_string()),
            container_id: Some("{11111111-2222-3333-4444-555555555555}".to_string()),
            hardware_ids: vec!["USB\\VID_1234&PID_5678".to_string()],
            serial_number: None,
            friendly_name: None,
        });

        let snapshot = project_role_binding(
            LocalDeviceRole::LowerController,
            Some(binding),
            Some("COM5".to_string()),
            &observed,
            None,
        );

        assert!(!snapshot.ready);
        assert!(snapshot.ambiguous);
        assert_eq!(snapshot.code, "DEVICE_BINDING_AMBIGUOUS");
        assert_eq!(snapshot.ambiguity_ports, vec!["COM4", "COM9"]);
        assert_eq!(snapshot.legacy_port_hint.as_deref(), Some("COM5"));
    }

    #[test]
    fn duplicate_observations_are_ambiguous_even_when_they_report_the_same_com_port() {
        let observed = ObservedSerialDevice {
            current_port: "COM4".to_string(),
            instance_id: Some("USB\\VID_1234&PID_5678\\SERIAL-1".to_string()),
            container_id: Some("{11111111-2222-3333-4444-555555555555}".to_string()),
            hardware_ids: vec!["USB\\VID_1234&PID_5678".to_string()],
            serial_number: Some("SERIAL-1".to_string()),
            friendly_name: None,
        };
        let binding =
            StableSerialDeviceIdentity::try_from_observation(&observed).expect("stable fixture");

        assert_eq!(
            resolve_bound_port(&binding, &[observed.clone(), observed]),
            BindingResolution::Ambiguous(vec!["COM4".to_string(), "COM4".to_string()])
        );
    }

    #[test]
    fn windows_contract_fixture_preserves_pnp_identity_and_current_com_observation() {
        let payload = br#"[{"currentPort":"COM12","instanceId":"USB\\VID_1A86&PID_55D3\\CTRL-01","containerId":"{11111111-2222-3333-4444-555555555555}","hardwareIds":["USB\\VID_1A86&PID_55D3"],"serialNumber":"CTRL-01","friendlyName":"USB-Enhanced-SERIAL CH343"}]"#;

        let devices = parse_windows_serial_discovery(payload).expect("fixture");

        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].current_port, "COM12");
        assert_eq!(devices[0].serial_number.as_deref(), Some("CTRL-01"));
        assert_eq!(
            StableSerialDeviceIdentity::try_from_observation(&devices[0])
                .expect("stable")
                .identity_key,
            "container:11111111-2222-3333-4444-555555555555"
        );
    }

    #[test]
    fn arbitrary_or_location_dependent_instance_id_is_not_a_stable_binding_identity() {
        let observed = ObservedSerialDevice {
            current_port: "COM8".to_string(),
            instance_id: Some("ACPI\\PNP0501\\1".to_string()),
            container_id: Some("{not-a-guid}".to_string()),
            hardware_ids: vec!["ROOT\\PORTS\\0000".to_string()],
            serial_number: Some("LOCATION-1".to_string()),
            friendly_name: Some("Communications Port".to_string()),
        };

        let error = StableSerialDeviceIdentity::try_from_observation(&observed)
            .expect_err("location-dependent identity must not be bindable");

        assert!(error.contains("physical USB"));
    }

    #[test]
    fn valid_guid_does_not_make_a_virtual_or_root_port_bindable() {
        for observed in [
            ObservedSerialDevice {
                current_port: "COM8".to_string(),
                instance_id: Some("ROOT\\VIRTUALCOM\\0000".to_string()),
                container_id: Some("{11111111-2222-3333-4444-555555555555}".to_string()),
                hardware_ids: vec!["ROOT\\PORTS\\0000".to_string()],
                serial_number: Some("PSEUDO-PORT-1".to_string()),
                friendly_name: Some("Virtual Serial Port".to_string()),
            },
            ObservedSerialDevice {
                current_port: "COM9".to_string(),
                instance_id: Some("ACPI\\PNP0501\\1".to_string()),
                container_id: Some("{22222222-3333-4444-5555-666666666666}".to_string()),
                hardware_ids: vec!["ROOT\\PORTS\\0000".to_string()],
                serial_number: Some("LOCATION-1".to_string()),
                friendly_name: Some("Communications Port".to_string()),
            },
        ] {
            let error = StableSerialDeviceIdentity::try_from_observation(&observed)
                .expect_err("a valid GUID is not physical USB evidence");

            assert!(error.contains("physical USB"), "unexpected error: {error}");
        }
    }

    #[test]
    fn nil_container_guid_is_not_a_stable_identity() {
        let observed = ObservedSerialDevice {
            current_port: "COM10".to_string(),
            instance_id: Some("USB\\VID_1234&PID_5678\\LOCATION-1".to_string()),
            container_id: Some("{00000000-0000-0000-0000-000000000000}".to_string()),
            hardware_ids: vec!["USB\\VID_1234&PID_5678".to_string()],
            serial_number: Some("PSEUDO".to_string()),
            friendly_name: Some("USB Serial Port".to_string()),
        };

        let error = StableSerialDeviceIdentity::try_from_observation(&observed)
            .expect_err("nil GUID and pseudo serial are not stable identity evidence");

        assert!(error.contains("stable USB identity"));
    }

    #[test]
    fn usb_serial_fallback_canonicalizes_only_stable_vid_pid_hardware_tuple() {
        let observed = ObservedSerialDevice {
            current_port: "COM14".to_string(),
            instance_id: Some("USB\\VID_1a86&PID_55d3\\CTRL-01".to_string()),
            container_id: None,
            hardware_ids: vec![
                " USB\\VID_1a86&PID_55d3&REV_0444 ".to_string(),
                "ROOT\\PORTS\\0000".to_string(),
                "USB\\VID_1A86&PID_55D3".to_string(),
            ],
            serial_number: Some("CTRL-01".to_string()),
            friendly_name: None,
        };

        let identity = StableSerialDeviceIdentity::try_from_observation(&observed)
            .expect("manufacturer USB serial fallback");

        assert_eq!(identity.identity_key, "usb:usb\\vid_1a86&pid_55d3:ctrl-01");
        assert_eq!(identity.hardware_ids, vec!["USB\\VID_1A86&PID_55D3"]);
    }

    #[test]
    fn windows_discovery_rejects_non_com_port_observations() {
        let payload = br#"[{"currentPort":"LPT1","instanceId":"USB\\VID_1A86&PID_55D3\\CTRL-01","containerId":"{11111111-2222-3333-4444-555555555555}","hardwareIds":["USB\\VID_1A86&PID_55D3"],"serialNumber":"CTRL-01","friendlyName":"forged serial"}]"#;

        let error = parse_windows_serial_discovery(payload)
            .expect_err("Windows serial discovery must accept only COMn observations");

        assert!(error.contains("currentPort"));
        assert!(error.contains("COMn"));
    }

    #[test]
    fn unbindable_observation_is_exposed_as_actionable_discovery_evidence() {
        let observed = ObservedSerialDevice {
            current_port: "COM8".to_string(),
            instance_id: Some("ACPI\\PNP0501\\1".to_string()),
            container_id: None,
            hardware_ids: vec!["ROOT\\PORTS\\0000".to_string()],
            serial_number: None,
            friendly_name: Some("Communications Port".to_string()),
        };

        let snapshot = project_role_binding(
            LocalDeviceRole::Scanner,
            None,
            Some("COM3".to_string()),
            &[observed],
            None,
        );

        assert_eq!(snapshot.candidates.len(), 0);
        assert_eq!(snapshot.discovery_diagnostics.len(), 1);
        assert_eq!(
            snapshot.discovery_diagnostics[0].code,
            "DEVICE_IDENTITY_NOT_BINDABLE"
        );
        assert_eq!(snapshot.discovery_diagnostics[0].current_port, "COM8");
        assert!(snapshot.discovery_diagnostics[0]
            .message
            .contains("physical USB"));
    }

    #[test]
    fn resolved_port_is_not_ready_when_the_role_runtime_self_check_is_offline() {
        let observed = ObservedSerialDevice {
            current_port: "COM5".to_string(),
            instance_id: Some("USB\\VID_1234&PID_5678\\CTRL-1".to_string()),
            container_id: Some("{11111111-2222-3333-4444-555555555555}".to_string()),
            hardware_ids: vec!["USB\\VID_1234&PID_5678".to_string()],
            serial_number: None,
            friendly_name: None,
        };
        let binding = LocalSerialRoleBinding {
            identity: StableSerialDeviceIdentity::try_from_observation(&observed)
                .expect("stable fixture"),
            confirmed_at: "2026-07-15T00:00:00Z".to_string(),
            confirmed_by: "operator-1".to_string(),
            test_evidence_code: "LOWER_CONTROLLER_HANDSHAKE_READY".to_string(),
        };

        let snapshot = project_role_binding(
            LocalDeviceRole::LowerController,
            Some(binding),
            Some("COM5".to_string()),
            &[observed],
            Some(DeviceRoleRuntimeReadiness {
                online: false,
                current_port: Some("COM5".to_string()),
                code: "LOWER_CONTROLLER_HANDSHAKE_FAILED".to_string(),
                message: "controller handshake failed".to_string(),
            }),
        );

        assert!(!snapshot.ready);
        assert_eq!(snapshot.code, "DEVICE_BINDING_RUNTIME_NOT_READY");
        assert!(snapshot.message.contains("controller handshake failed"));
    }
}
