use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use sha2::{Digest, Sha256};
use tokio::{fs, sync::Mutex};

use crate::device_binding::{HardwareModelRoleError, LocalDeviceRole, LocalSerialRoleBinding};
use crate::runtime_configuration::{remove_optional_file, write_atomic_bytes};

/// Daemon-owned settings that may survive a Windows re-enumeration. Device
/// addresses are observations and intentionally have no field in this file.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalRuntimeSettings {
    pub schema_version: u8,
    pub revision: u64,
    pub lower_controller_binding: Option<LocalSerialRoleBinding>,
    pub scanner_binding: Option<LocalSerialRoleBinding>,
    pub scanner_protocol: Option<ScannerProtocolParameters>,
    pub audio: AudioPreferences,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScannerProtocolParameters {
    pub baud_rate: u32,
    pub frame_suffix: vending_core::scanner::ScannerFrameSuffix,
}

pub fn effective_scanner_protocol(
    settings: &LocalRuntimeSettings,
    hardware_model: &str,
    topology_identity: &str,
) -> Result<ScannerProtocolParameters, HardwareModelRoleError> {
    match (hardware_model, topology_identity) {
        ("vem-prod-24", "vem-prod-24") => {
            Ok(settings
                .scanner_protocol
                .clone()
                .unwrap_or(ScannerProtocolParameters {
                    baud_rate: 9_600,
                    frame_suffix: vending_core::scanner::ScannerFrameSuffix::Crlf,
                }))
        }
        _ => Err(HardwareModelRoleError::unsupported(
            hardware_model,
            topology_identity,
        )),
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AudioPreferences {
    pub volume: f64,
    pub cues_enabled: bool,
    pub presence_cues_enabled: bool,
    pub transaction_cues_enabled: bool,
}

impl Default for AudioPreferences {
    fn default() -> Self {
        Self {
            volume: 0.7,
            cues_enabled: true,
            presence_cues_enabled: true,
            transaction_cues_enabled: true,
        }
    }
}

pub struct LocalRuntimeSettingsStore {
    path: PathBuf,
    lock: Mutex<()>,
}

impl LocalRuntimeSettingsStore {
    pub fn new(data_dir: PathBuf) -> Arc<Self> {
        Arc::new(Self {
            path: data_dir.join("config").join("local-settings.json"),
            lock: Mutex::new(()),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub async fn load(&self) -> Result<LocalRuntimeSettings, String> {
        let _guard = self.lock.lock().await;
        self.load_unlocked().await
    }

    pub async fn binding_snapshot(
        &self,
        role: LocalDeviceRole,
    ) -> Result<(Option<LocalSerialRoleBinding>, String), String> {
        let _guard = self.lock.lock().await;
        let settings = self.load_unlocked().await?;
        let binding = binding_for(&settings, role);
        Ok((binding.clone(), binding_revision(role, binding.as_ref())?))
    }

    pub async fn replace_binding_if_revision(
        &self,
        role: LocalDeviceRole,
        binding: Option<LocalSerialRoleBinding>,
        expected_revision: &str,
    ) -> Result<String, String> {
        let _guard = self.lock.lock().await;
        let mut settings = self.load_unlocked().await?;
        let current = binding_for(&settings, role);
        if binding_revision(role, current.as_ref())? != expected_revision {
            return Err(format!("{} binding revision changed", role.as_str()));
        }
        match role {
            LocalDeviceRole::LowerController => settings.lower_controller_binding = binding.clone(),
            LocalDeviceRole::Scanner => settings.scanner_binding = binding.clone(),
        }
        settings.revision = settings.revision.saturating_add(1);
        self.write_unlocked(&settings).await?;
        binding_revision(role, binding.as_ref())
    }

    pub async fn save_binding(
        &self,
        role: LocalDeviceRole,
        binding: LocalSerialRoleBinding,
    ) -> Result<(), String> {
        let (_, revision) = self.binding_snapshot(role).await?;
        self.replace_binding_if_revision(role, Some(binding), &revision)
            .await
            .map(|_| ())
    }

    pub async fn set_scanner_protocol(
        &self,
        protocol: Option<ScannerProtocolParameters>,
    ) -> Result<u64, String> {
        if let Some(protocol) = protocol.as_ref() {
            if !(1_200..=230_400).contains(&protocol.baud_rate) {
                return Err("scanner baud rate is outside the supported range".to_string());
            }
        }
        let _guard = self.lock.lock().await;
        let mut settings = self.load_unlocked().await?;
        settings.scanner_protocol = protocol;
        settings.revision = settings.revision.saturating_add(1);
        self.write_unlocked(&settings).await?;
        Ok(settings.revision)
    }

    pub async fn set_audio_preferences(&self, audio: AudioPreferences) -> Result<u64, String> {
        if !(0.0..=1.0).contains(&audio.volume) {
            return Err("audio volume must be between zero and one".to_string());
        }
        let _guard = self.lock.lock().await;
        let mut settings = self.load_unlocked().await?;
        settings.audio = audio;
        settings.revision = settings.revision.saturating_add(1);
        self.write_unlocked(&settings).await?;
        Ok(settings.revision)
    }

    pub async fn clear(&self) -> Result<(), String> {
        let _guard = self.lock.lock().await;
        remove_optional_file(&self.path)
            .await
            .map_err(|error| format!("clear local runtime settings failed: {error}"))
    }

    async fn load_unlocked(&self) -> Result<LocalRuntimeSettings, String> {
        let content = match fs::read_to_string(&self.path).await {
            Ok(content) => content,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(LocalRuntimeSettings {
                    schema_version: 1,
                    ..Default::default()
                });
            }
            Err(error) => return Err(format!("read local runtime settings failed: {error}")),
        };
        let settings: LocalRuntimeSettings = serde_json::from_str(&content)
            .map_err(|error| format!("local runtime settings contract invalid: {error}"))?;
        if settings.schema_version != 1 {
            return Err("local runtime settings schema version unsupported".to_string());
        }
        Ok(settings)
    }

    async fn write_unlocked(&self, settings: &LocalRuntimeSettings) -> Result<(), String> {
        let payload = serde_json::to_vec_pretty(settings)
            .map_err(|error| format!("serialize local settings failed: {error}"))?;
        write_atomic_bytes(&self.path, &payload)
            .await
            .map_err(|error| format!("persist local settings failed: {error}"))
    }
}

fn binding_for(
    settings: &LocalRuntimeSettings,
    role: LocalDeviceRole,
) -> Option<LocalSerialRoleBinding> {
    match role {
        LocalDeviceRole::LowerController => settings.lower_controller_binding.clone(),
        LocalDeviceRole::Scanner => settings.scanner_binding.clone(),
    }
}

fn binding_revision(
    role: LocalDeviceRole,
    binding: Option<&LocalSerialRoleBinding>,
) -> Result<String, String> {
    let bytes = serde_json::to_vec(&serde_json::json!({ "role": role, "binding": binding }))
        .map_err(|error| format!("serialize local binding revision failed: {error}"))?;
    Ok(format!("sha256:{:x}", Sha256::digest(bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::device_binding::StableSerialDeviceIdentity;

    #[test]
    fn enables_core_behavior_audio_by_default() {
        let audio = AudioPreferences::default();

        assert!(audio.cues_enabled);
        assert!(audio.presence_cues_enabled);
        assert!(audio.transaction_cues_enabled);
        assert_eq!(audio.volume, 0.7);
    }

    fn binding(identity_key: &str) -> LocalSerialRoleBinding {
        LocalSerialRoleBinding {
            identity: StableSerialDeviceIdentity {
                identity_key: identity_key.to_string(),
                instance_id: Some("USB\\LOWER-01".to_string()),
                container_id: Some("11111111-2222-3333-4444-555555555555".to_string()),
                hardware_ids: vec!["USB\\VID_1A86&PID_55D3".to_string()],
                serial_number: Some("LOWER-01".to_string()),
            },
            confirmed_at: "2026-07-17T00:00:00Z".to_string(),
            confirmed_by: "field-operator".to_string(),
            test_evidence_code: "LOWER_CONTROLLER_READY".to_string(),
        }
    }

    #[tokio::test]
    async fn replugged_lower_controller_keeps_its_stable_binding_without_a_com_path() {
        let temp = tempfile::tempdir().expect("temp");
        let store = LocalRuntimeSettingsStore::new(temp.path().join("vending-daemon"));
        store
            .save_binding(
                LocalDeviceRole::LowerController,
                binding("container:lower-01"),
            )
            .await
            .expect("save binding");

        let restarted = LocalRuntimeSettingsStore::new(temp.path().join("vending-daemon"));
        let (persisted, _) = restarted
            .binding_snapshot(LocalDeviceRole::LowerController)
            .await
            .expect("load binding after replug");
        assert_eq!(
            persisted.expect("binding").identity.identity_key,
            "container:lower-01"
        );
        let persisted_json = fs::read_to_string(restarted.path())
            .await
            .expect("settings file");
        assert!(!persisted_json.contains("COM"));
    }

    #[tokio::test]
    async fn replugged_scanner_keeps_its_stable_binding_without_a_com_path() {
        let temp = tempfile::tempdir().expect("temp");
        let store = LocalRuntimeSettingsStore::new(temp.path().join("vending-daemon"));
        store
            .save_binding(LocalDeviceRole::Scanner, binding("container:scanner-01"))
            .await
            .expect("save scanner binding");

        let restarted = LocalRuntimeSettingsStore::new(temp.path().join("vending-daemon"));
        let (persisted, _) = restarted
            .binding_snapshot(LocalDeviceRole::Scanner)
            .await
            .expect("load scanner binding after replug");
        assert_eq!(
            persisted.expect("binding").identity.identity_key,
            "container:scanner-01"
        );
        let persisted_json = fs::read_to_string(restarted.path())
            .await
            .expect("settings file");
        assert!(!persisted_json.contains("COM"));
    }

    #[tokio::test]
    async fn persists_only_scanner_protocol_and_audio_preferences_as_local_settings() {
        let temp = tempfile::tempdir().expect("temp");
        let store = LocalRuntimeSettingsStore::new(temp.path().join("vending-daemon"));

        store
            .set_scanner_protocol(Some(ScannerProtocolParameters {
                baud_rate: 115_200,
                frame_suffix: vending_core::scanner::ScannerFrameSuffix::Lf,
            }))
            .await
            .expect("save scanner protocol");
        store
            .set_audio_preferences(AudioPreferences {
                volume: 0.45,
                cues_enabled: true,
                presence_cues_enabled: true,
                transaction_cues_enabled: false,
            })
            .await
            .expect("save audio preferences");

        let settings = store.load().await.expect("load settings");
        assert_eq!(
            settings.scanner_protocol.expect("protocol").baud_rate,
            115_200
        );
        assert_eq!(settings.audio.volume, 0.45);
        let persisted = fs::read_to_string(store.path())
            .await
            .expect("settings file");
        assert!(!persisted.contains("endpointId"));
        assert!(!persisted.contains("COM"));
    }

    #[tokio::test]
    async fn cleared_settings_do_not_reappear_after_a_restart() {
        let temp = tempfile::tempdir().expect("temp");
        let data_dir = temp.path().join("vending-daemon");
        let store = LocalRuntimeSettingsStore::new(data_dir.clone());
        store
            .save_binding(LocalDeviceRole::Scanner, binding("container:scanner-01"))
            .await
            .expect("save scanner binding");

        store.clear().await.expect("clear settings");

        let restarted = LocalRuntimeSettingsStore::new(data_dir);
        let settings = restarted.load().await.expect("restart load");
        assert!(settings.scanner_binding.is_none());
        assert!(!fs::try_exists(restarted.path())
            .await
            .expect("settings path state"));
    }

    #[test]
    fn scanner_protocol_is_fixed_by_the_supported_production_model() {
        let settings = LocalRuntimeSettings::default();
        let production = effective_scanner_protocol(&settings, "vem-prod-24", "vem-prod-24")
            .expect("known production model");
        let unsupported =
            effective_scanner_protocol(&settings, "unknown-model", "unknown-topology")
                .expect_err("unknown model must not inherit scanner transport");

        assert_eq!(production.baud_rate, 9_600);
        assert_eq!(
            production.frame_suffix,
            vending_core::scanner::ScannerFrameSuffix::Crlf
        );
        assert_eq!(unsupported.code(), "HARDWARE_MODEL_UNSUPPORTED");
    }

    #[test]
    fn scanner_protocol_local_override_changes_the_effective_transport() {
        let settings = LocalRuntimeSettings {
            scanner_protocol: Some(ScannerProtocolParameters {
                baud_rate: 115_200,
                frame_suffix: vending_core::scanner::ScannerFrameSuffix::Lf,
            }),
            ..Default::default()
        };

        assert_eq!(
            effective_scanner_protocol(&settings, "vem-prod-24", "vem-prod-24")
                .expect("known production model"),
            ScannerProtocolParameters {
                baud_rate: 115_200,
                frame_suffix: vending_core::scanner::ScannerFrameSuffix::Lf,
            }
        );
    }
}
