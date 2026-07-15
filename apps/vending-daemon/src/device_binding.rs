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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
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
pub struct DeviceRoleBindingSnapshot {
    pub role: LocalDeviceRole,
    pub binding: Option<LocalSerialRoleBinding>,
    pub current_port: Option<String>,
    pub ready: bool,
    pub code: String,
    pub message: String,
    pub ambiguous: bool,
    pub ambiguity_ports: Vec<String>,
    pub legacy_port_hint: Option<String>,
    pub candidates: Vec<DeviceBindingCandidate>,
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

#[async_trait]
pub trait SerialDevicePlatform: Send + Sync {
    async fn discover(&self) -> Result<Vec<ObservedSerialDevice>, String>;

    async fn test_candidate(
        &self,
        role: LocalDeviceRole,
        candidate: &ObservedSerialDevice,
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
    ) -> DeviceBindingTestResult {
        let tested_at = crate::state::store::now_iso();
        let result = match role {
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
                use tokio_serial::SerialPortBuilderExt as _;
                match tokio_serial::new(&candidate.current_port, 9_600).open_native_async() {
                    Ok(_) => (
                        true,
                        "SCANNER_PORT_OPEN_READY",
                        "scanner serial port opened successfully".to_string(),
                    ),
                    Err(error) => (
                        false,
                        "SCANNER_PORT_OPEN_FAILED",
                        format!("open scanner serial failed: {error}"),
                    ),
                }
            }
        };
        DeviceBindingTestResult {
            role,
            identity_key: StableSerialDeviceIdentity::try_from_observation(candidate)
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
    let devices = if value.is_array() {
        serde_json::from_value(value)
    } else if value.is_object() {
        serde_json::from_value(serde_json::Value::Array(vec![value]))
    } else {
        return Err("Windows serial discovery returned an invalid payload".to_string());
    }
    .map_err(|error| format!("parse Windows serial discovery devices failed: {error}"))?;
    Ok(devices)
}

impl StableSerialDeviceIdentity {
    pub fn try_from_observation(observed: &ObservedSerialDevice) -> Result<Self, String> {
        let container_id = observed
            .container_id
            .as_deref()
            .and_then(normalize_container_id);
        let instance_id = normalize_optional_identity(observed.instance_id.as_deref());
        let serial_number = normalize_optional_identity(observed.serial_number.as_deref());
        let identity_key = if let Some(container_id) = container_id.as_deref() {
            format!("container:{container_id}")
        } else if let (Some(serial), Some(hardware_id)) =
            (serial_number.as_deref(), observed.hardware_ids.first())
        {
            format!(
                "usb:{}:{}",
                hardware_id.trim().to_ascii_lowercase(),
                serial.to_ascii_lowercase()
            )
        } else if let Some(instance_id) = instance_id.as_deref() {
            format!("instance:{}", instance_id.to_ascii_lowercase())
        } else {
            return Err("serial device has no stable Windows identity".to_string());
        };
        Ok(Self {
            identity_key,
            instance_id,
            container_id,
            hardware_ids: observed
                .hardware_ids
                .iter()
                .map(|value| value.trim().to_ascii_uppercase())
                .filter(|value| !value.is_empty())
                .collect(),
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
    let normalized = value
        .trim()
        .trim_start_matches('{')
        .trim_end_matches('}')
        .to_ascii_lowercase();
    (!normalized.is_empty()).then_some(normalized)
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
    ports.dedup();
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
) -> DeviceRoleBindingSnapshot {
    let candidates = observed
        .iter()
        .filter_map(|candidate| {
            StableSerialDeviceIdentity::try_from_observation(candidate)
                .ok()
                .map(|identity| DeviceBindingCandidate {
                    identity,
                    current_port: candidate.current_port.clone(),
                    friendly_name: candidate.friendly_name.clone(),
                    readiness: DeviceCandidateReadiness::Candidate,
                    readiness_code: "ROLE_TEST_REQUIRED".to_string(),
                    readiness_message: "candidate requires role-specific protected test"
                        .to_string(),
                })
        })
        .collect::<Vec<_>>();

    let (current_port, ready, code, message, ambiguous, ambiguity_ports) =
        match binding.as_ref() {
            Some(binding) => match resolve_bound_port(&binding.identity, observed) {
                BindingResolution::Resolved(port) => (
                    Some(port),
                    true,
                    "DEVICE_BINDING_RESOLVED".to_string(),
                    "bound device resolved to its current Windows port".to_string(),
                    false,
                    vec![],
                ),
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

    DeviceRoleBindingSnapshot {
        role,
        binding,
        current_port,
        ready,
        code,
        message,
        ambiguous,
        ambiguity_ports,
        legacy_port_hint,
        candidates,
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
            identity_key: "container:shared".to_string(),
            instance_id: None,
            container_id: Some("shared".to_string()),
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
            instance_id: None,
            container_id: Some("{SHARED}".to_string()),
            hardware_ids: vec![],
            serial_number: None,
            friendly_name: None,
        });

        let snapshot = project_role_binding(
            LocalDeviceRole::LowerController,
            Some(binding),
            Some("COM5".to_string()),
            &observed,
        );

        assert!(!snapshot.ready);
        assert!(snapshot.ambiguous);
        assert_eq!(snapshot.code, "DEVICE_BINDING_AMBIGUOUS");
        assert_eq!(snapshot.ambiguity_ports, vec!["COM4", "COM9"]);
        assert_eq!(snapshot.legacy_port_hint.as_deref(), Some("COM5"));
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
}
