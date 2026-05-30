use std::{
    env,
    path::{Path, PathBuf},
    sync::Arc,
};

use serde::{Deserialize, Serialize};
use tokio::fs;

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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MachinePublicConfig {
    pub machine_code: Option<String>,
    pub api_base_url: String,
    pub mqtt_url: String,
    pub mqtt_username: Option<String>,
    pub hardware_adapter: HardwareAdapterKind,
    pub serial_port_path: Option<String>,
    pub scanner_adapter: ScannerAdapterKind,
    pub scanner_serial_port_path: Option<String>,
    pub scanner_baud_rate: u32,
    pub scanner_frame_suffix: vending_core::scanner::ScannerFrameSuffix,
    pub vision_enabled: bool,
    pub vision_ws_url: String,
    pub vision_auto_start: bool,
    pub vision_process_command: Option<String>,
    pub vision_process_args: Option<String>,
    pub vision_request_timeout_ms: u64,
    pub kiosk_mode: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineConfigSecretsUpdate {
    pub machine_secret: Option<String>,
    pub mqtt_signing_secret: Option<String>,
    pub mqtt_password: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineConfigUpdateRequest {
    pub public: MachinePublicConfig,
    pub secrets: Option<MachineConfigSecretsUpdate>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
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
        MachinePublicRuntimeConfig {
            public: self.public.clone(),
            machine_secret_configured: self.machine_secret_configured,
            mqtt_signing_secret_configured: self.mqtt_signing_secret_configured,
            mqtt_password_configured: self.mqtt_password_configured,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MachinePublicRuntimeConfig {
    pub public: MachinePublicConfig,
    pub machine_secret_configured: bool,
    pub mqtt_signing_secret_configured: bool,
    pub mqtt_password_configured: bool,
}

pub fn default_public_config() -> MachinePublicConfig {
    MachinePublicConfig {
        machine_code: None,
        api_base_url: "http://localhost:3000/api".to_string(),
        mqtt_url: "mqtt://localhost:1883".to_string(),
        mqtt_username: None,
        hardware_adapter: HardwareAdapterKind::Mock,
        serial_port_path: None,
        scanner_adapter: ScannerAdapterKind::Disabled,
        scanner_serial_port_path: None,
        scanner_baud_rate: 9600,
        scanner_frame_suffix: vending_core::scanner::ScannerFrameSuffix::Crlf,
        vision_enabled: true,
        vision_ws_url: vending_core::vision::DEFAULT_VISION_WS_URL.to_string(),
        vision_auto_start: false,
        vision_process_command: None,
        vision_process_args: None,
        vision_request_timeout_ms: 8_000,
        kiosk_mode: false,
    }
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

    let mqtt_username = config.mqtt_username.take().and_then(|value| {
        let value = value.trim().to_string();
        if value.is_empty() {
            None
        } else {
            Some(value)
        }
    });
    config.mqtt_username = mqtt_username;

    let serial_port_path = config.serial_port_path.take().and_then(|value| {
        let value = value.trim().to_string();
        if value.is_empty() {
            None
        } else {
            Some(value)
        }
    });
    config.serial_port_path = serial_port_path;

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

    let vision_process_command = config.vision_process_command.take().and_then(|value| {
        let value = value.trim().to_string();
        if value.is_empty() {
            None
        } else {
            Some(value)
        }
    });
    config.vision_process_command = vision_process_command;

    let vision_process_args = config.vision_process_args.take().and_then(|value| {
        let value = value.trim().to_string();
        if value.is_empty() {
            None
        } else {
            Some(value)
        }
    });
    config.vision_process_args = vision_process_args;

    config.api_base_url = config.api_base_url.trim().trim_end_matches('/').to_string();
    config.mqtt_url = config.mqtt_url.trim().to_string();

    if config.api_base_url.is_empty() {
        return Err("apiBaseUrl is required".to_string());
    }
    if config.mqtt_url.is_empty() {
        return Err("mqttUrl is required".to_string());
    }
    if matches!(&config.hardware_adapter, HardwareAdapterKind::Serial)
        && config.serial_port_path.is_none()
    {
        return Err("serialPortPath is required when hardwareAdapter=serial".to_string());
    }
    if matches!(&config.scanner_adapter, ScannerAdapterKind::SerialText)
        && config.scanner_serial_port_path.is_none()
    {
        return Err(
            "scannerSerialPortPath is required when scannerAdapter=serial_text".to_string(),
        );
    }
    if config.vision_enabled && config.vision_auto_start && config.vision_process_command.is_none()
    {
        return Err("visionProcessCommand is required when visionAutoStart=true".to_string());
    }
    if !(1000..=30000).contains(&config.vision_request_timeout_ms) {
        return Err("visionRequestTimeoutMs must be between 1000 and 30000".to_string());
    }
    if vision_ws_url.is_empty() {
        return Err("visionWsUrl is required".to_string());
    }
    config.vision_ws_url = vision_ws_url;

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

fn legacy_config_path() -> Result<PathBuf, String> {
    #[cfg(unix)]
    {
        if let Ok(value) = env::var("XDG_CONFIG_HOME") {
            return Ok(Path::new(&value)
                .join("com.vem.machine")
                .join("machine-config.json"));
        }
        let home = env::var("HOME").map_err(|error| format!("resolve HOME failed: {error}"))?;
        Ok(Path::new(&home)
            .join(".config")
            .join("com.vem.machine")
            .join("machine-config.json"))
    }
    #[cfg(windows)]
    {
        if let Ok(value) = env::var("APPDATA") {
            return Ok(Path::new(&value)
                .join("com.vem.machine")
                .join("machine-config.json"));
        }
        Err("resolve APPDATA failed".to_string())
    }
}

fn legacy_config_paths() -> Result<Vec<PathBuf>, String> {
    Ok(vec![legacy_config_path()?, {
        #[cfg(unix)]
        {
            if let Ok(value) = env::var("XDG_CONFIG_HOME") {
                Path::new(&value).join("machine-config.json")
            } else if let Ok(value) = env::var("HOME") {
                Path::new(&value)
                    .join(".config")
                    .join("machine-config.json")
            } else {
                return Err("resolve HOME failed".to_string());
            }
        }
        #[cfg(windows)]
        {
            if let Ok(value) = env::var("APPDATA") {
                Path::new(&value).join("machine-config.json")
            } else {
                return Err("resolve APPDATA failed".to_string());
            }
        }
    }])
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

    async fn migrate_legacy_if_needed(&self) -> Result<(), String> {
        let daemon_path = daemon_config_path(&self.data_dir);
        if daemon_path.exists() {
            return Ok(());
        }

        let Some(legacy_path) = legacy_config_paths()?
            .into_iter()
            .find(|path| path.exists())
        else {
            return Ok(());
        };

        let content = fs::read_to_string(&legacy_path)
            .await
            .map_err(|error| format!("read legacy config failed: {error}"))?;
        let public: MachinePublicConfig = serde_json::from_str(&content)
            .map_err(|error| format!("parse legacy config failed: {error}"))?;
        let public = normalize_public_config(public)?;

        if let Some(parent) = daemon_path.parent() {
            fs::create_dir_all(parent)
                .await
                .map_err(|error| format!("create daemon data dir failed: {error}"))?;
        }
        let payload = serde_json::to_string_pretty(&public)
            .map_err(|error| format!("serialize daemon config failed: {error}"))?;
        fs::write(&daemon_path, payload)
            .await
            .map_err(|error| format!("write daemon config failed: {error}"))?;

        self.state
            .put_metadata("last_migration_source", &legacy_path.to_string_lossy())
            .await
            .map_err(|error| error.to_string())?;
        self.persist_snapshot(&public).await
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
        self.migrate_legacy_if_needed().await?;
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
        let public: MachinePublicConfig = serde_json::from_str(&content)
            .map_err(|error| format!("parse daemon config failed: {error}"))?;
        let public = normalize_public_config(public)?;
        self.persist_snapshot(&public).await?;
        Ok(public)
    }

    pub async fn save_public_config(
        &self,
        config: MachinePublicConfig,
    ) -> Result<MachinePublicRuntimeConfig, String> {
        let normalized = normalize_public_config(config)?;
        fs::create_dir_all(&self.data_dir)
            .await
            .map_err(|error| format!("create daemon data dir failed: {error}"))?;
        fs::create_dir_all(self.data_dir.join("logs"))
            .await
            .map_err(|error| format!("create daemon log dir failed: {error}"))?;
        let payload = serde_json::to_string_pretty(&normalized)
            .map_err(|error| format!("serialize daemon config failed: {error}"))?;
        fs::write(daemon_config_path(&self.data_dir), payload)
            .await
            .map_err(|error| format!("write daemon config failed: {error}"))?;
        self.persist_snapshot(&normalized).await?;
        Ok(MachinePublicRuntimeConfig {
            public: normalized,
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
        })
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secret::InMemorySecretStore;
    use std::sync::OnceLock;
    use tempfile::TempDir;
    use tokio::sync::Mutex;

    static LEGACY_ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

    struct LegacyEnvGuard {
        name: &'static str,
        previous: Option<String>,
    }

    impl Drop for LegacyEnvGuard {
        fn drop(&mut self) {
            match &self.previous {
                Some(value) => env::set_var(self.name, value),
                None => env::remove_var(self.name),
            }
        }
    }

    fn set_legacy_home(base: &std::path::Path) -> LegacyEnvGuard {
        #[cfg(unix)]
        let name = "XDG_CONFIG_HOME";
        #[cfg(windows)]
        let name = "APPDATA";

        let previous = env::var(name).ok();
        env::set_var(name, base);

        LegacyEnvGuard { name, previous }
    }

    async fn with_legacy_env_lock() -> tokio::sync::MutexGuard<'static, ()> {
        LEGACY_ENV_LOCK.get_or_init(|| Mutex::new(())).lock().await
    }

    #[tokio::test]
    async fn normalize_public_config_validates_required_fields() {
        let serial_missing = MachinePublicConfig {
            serial_port_path: None,
            hardware_adapter: HardwareAdapterKind::Serial,
            ..default_public_config()
        };
        let err = normalize_public_config(serial_missing).unwrap_err();
        assert_eq!(
            err,
            "serialPortPath is required when hardwareAdapter=serial"
        );

        let scanner_missing = MachinePublicConfig {
            scanner_adapter: ScannerAdapterKind::SerialText,
            scanner_serial_port_path: None,
            ..default_public_config()
        };
        let err = normalize_public_config(scanner_missing).unwrap_err();
        assert_eq!(
            err,
            "scannerSerialPortPath is required when scannerAdapter=serial_text"
        );

        let vision_auto = MachinePublicConfig {
            vision_enabled: true,
            vision_auto_start: true,
            vision_process_command: None,
            ..default_public_config()
        };
        let err = normalize_public_config(vision_auto).unwrap_err();
        assert_eq!(
            err,
            "visionProcessCommand is required when visionAutoStart=true"
        );
    }

    #[tokio::test]
    async fn config_migrates_legacy_tauri_file_once() {
        let _env_guard = with_legacy_env_lock().await;
        let temp = TempDir::new().expect("temp");
        let data_dir = temp.path().join("daemon");
        let legacy_dir = temp.path().join("legacy");
        let _legacy_home = set_legacy_home(&legacy_dir);
        tokio::fs::create_dir_all(&legacy_dir).await.expect("mkdir");
        let legacy_path = legacy_dir.join("machine-config.json");

        let legacy_public = MachinePublicConfig {
            api_base_url: "https://legacy.example/api".to_string(),
            mqtt_url: "mqtt://legacy:1883".to_string(),
            ..default_public_config()
        };
        let legacy_json =
            serde_json::to_string_pretty(&legacy_public).expect("serialize legacy config");
        tokio::fs::write(&legacy_path, legacy_json)
            .await
            .expect("write legacy");

        let state = crate::state::LocalStateStore::open(&data_dir.join("state.db"))
            .await
            .expect("state");
        let secrets: Arc<dyn SecretStore> = Arc::new(InMemorySecretStore::default());
        let store = ConfigStore::new(data_dir.clone(), state.clone(), secrets);

        let loaded = store.load_runtime_config().await.expect("load once");
        assert_eq!(
            loaded.public.api_base_url,
            "https://legacy.example/api".trim_end_matches('/')
        );

        let migration: Option<String> = state
            .get_metadata("last_migration_source")
            .await
            .expect("metadata")
            .expect("metadata exists");
        assert_eq!(migration.unwrap(), legacy_path.to_string_lossy());

        let altered = MachinePublicConfig {
            api_base_url: "https://changed.local/api".to_string(),
            mqtt_url: "mqtt://changed:1883".to_string(),
            ..default_public_config()
        };
        let altered_json = serde_json::to_string_pretty(&altered).expect("serialize altered");
        tokio::fs::write(&legacy_path, altered_json)
            .await
            .expect("write changed legacy");

        let second = store.load_runtime_config().await.expect("load twice");
        assert_eq!(second.public.api_base_url, "https://legacy.example/api");
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
    async fn config_migration_records_once_only_when_daemon_config_absent() {
        let _env_guard = with_legacy_env_lock().await;
        let temp = TempDir::new().expect("temp");
        let data_dir = temp.path().join("daemon");
        let legacy_dir = temp.path().join("legacy");
        tokio::fs::create_dir_all(&legacy_dir).await.expect("mkdir");
        let _legacy_home = set_legacy_home(&legacy_dir);

        let state = crate::state::LocalStateStore::open(&data_dir.join("state.db"))
            .await
            .expect("state");
        let store = ConfigStore::new(
            data_dir.clone(),
            state,
            std::sync::Arc::new(InMemorySecretStore::default()),
        );

        let first = store.load_public_config().await.expect("first load");
        let second = store.load_public_config().await.expect("second load");
        assert_eq!(first, second);
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
}
