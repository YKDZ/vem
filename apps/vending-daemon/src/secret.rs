use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

pub const KEYRING_SERVICE: &str = "com.vem.machine";
pub const MACHINE_SECRET_ACCOUNT: &str = "machine_secret";
pub const MQTT_SIGNING_SECRET_ACCOUNT: &str = "mqtt_signing_secret";
pub const MQTT_PASSWORD_ACCOUNT: &str = "mqtt_password";

const SECRET_ACCOUNTS: [&str; 3] = [
    MACHINE_SECRET_ACCOUNT,
    MQTT_SIGNING_SECRET_ACCOUNT,
    MQTT_PASSWORD_ACCOUNT,
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SecretStoreStatus {
    pub kind: String,
    pub location: String,
    pub protection: String,
    pub machine_scope: bool,
    pub machine_secret_configured: bool,
    pub mqtt_signing_secret_configured: bool,
    pub mqtt_password_configured: bool,
    pub last_error: Option<String>,
}

#[async_trait]
pub trait SecretStore: Send + Sync {
    async fn read_secret(&self, account: &str) -> Result<Option<String>, String>;
    async fn write_secret(&self, account: &str, value: &str) -> Result<(), String>;
    async fn clear_all(&self) -> Result<(), String>;
    async fn status(&self) -> Result<SecretStoreStatus, String>;
}

#[derive(Debug, Default, Clone)]
pub struct KeyringSecretStore;

#[derive(Debug, Default)]
pub struct InMemorySecretStore {
    values: Arc<RwLock<HashMap<String, String>>>,
}

#[derive(Debug, Default, Clone)]
pub struct EnvSecretStore;

#[derive(Debug, Clone)]
pub struct FileSecretStore {
    dir: PathBuf,
}

#[derive(Debug, Clone)]
pub struct ProtectedLocalSecretStore {
    dir: PathBuf,
}

impl FileSecretStore {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            dir: data_dir.join("secrets"),
        }
    }

    fn account_path(&self, account: &str) -> Result<PathBuf, String> {
        let file_name = match account {
            MACHINE_SECRET_ACCOUNT => "machine_secret",
            MQTT_SIGNING_SECRET_ACCOUNT => "mqtt_signing_secret",
            MQTT_PASSWORD_ACCOUNT => "mqtt_password",
            _ => return Err("unknown secret account".to_string()),
        };
        Ok(self.dir.join(file_name))
    }
}

impl ProtectedLocalSecretStore {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            dir: runtime_root_dir(&data_dir).join("secrets"),
        }
    }

    fn account_path(&self, account: &str) -> Result<PathBuf, String> {
        let file_name = match account {
            MACHINE_SECRET_ACCOUNT => "machine_secret.dpapi",
            MQTT_SIGNING_SECRET_ACCOUNT => "mqtt_signing_secret.dpapi",
            MQTT_PASSWORD_ACCOUNT => "mqtt_password.dpapi",
            _ => return Err("unknown secret account".to_string()),
        };
        Ok(self.dir.join(file_name))
    }

    async fn configured_for_status(&self, account: &str) -> (bool, Option<String>) {
        match self.read_secret(account).await {
            Ok(value) => (value.is_some(), None),
            Err(error) => (false, Some(error)),
        }
    }
}

fn runtime_root_dir(data_dir: &Path) -> PathBuf {
    if data_dir.file_name().and_then(|name| name.to_str()) == Some("vending-daemon") {
        data_dir
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| data_dir.to_path_buf())
    } else {
        data_dir.to_path_buf()
    }
}

#[async_trait]
impl SecretStore for InMemorySecretStore {
    async fn read_secret(&self, account: &str) -> Result<Option<String>, String> {
        let values = self.values.read().await;
        Ok(values.get(account).cloned())
    }

    async fn write_secret(&self, account: &str, value: &str) -> Result<(), String> {
        let value = value.trim().to_string();
        let mut values = self.values.write().await;
        if value.is_empty() {
            values.remove(account);
            return Ok(());
        }
        values.insert(account.to_string(), value);
        Ok(())
    }

    async fn clear_all(&self) -> Result<(), String> {
        self.values.write().await.clear();
        Ok(())
    }

    async fn status(&self) -> Result<SecretStoreStatus, String> {
        let values = self.values.read().await;
        Ok(SecretStoreStatus {
            kind: "in_memory".to_string(),
            location: "memory://vending-daemon".to_string(),
            protection: "test_only".to_string(),
            machine_scope: false,
            machine_secret_configured: values.contains_key(MACHINE_SECRET_ACCOUNT),
            mqtt_signing_secret_configured: values.contains_key(MQTT_SIGNING_SECRET_ACCOUNT),
            mqtt_password_configured: values.contains_key(MQTT_PASSWORD_ACCOUNT),
            last_error: None,
        })
    }
}

fn env_account_name(account: &str) -> Option<&'static str> {
    match account {
        MACHINE_SECRET_ACCOUNT => Some("VEM_MACHINE_SECRET"),
        MQTT_SIGNING_SECRET_ACCOUNT => Some("VEM_MQTT_SIGNING_SECRET"),
        MQTT_PASSWORD_ACCOUNT => Some("VEM_MQTT_PASSWORD"),
        _ => None,
    }
}

#[async_trait]
impl SecretStore for EnvSecretStore {
    async fn read_secret(&self, account: &str) -> Result<Option<String>, String> {
        let Some(name) = env_account_name(account) else {
            return Ok(None);
        };

        Ok(std::env::var(name)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()))
    }

    async fn write_secret(&self, _account: &str, _value: &str) -> Result<(), String> {
        Err("env secret store is read-only".to_string())
    }

    async fn clear_all(&self) -> Result<(), String> {
        Err("env secret store is read-only".to_string())
    }

    async fn status(&self) -> Result<SecretStoreStatus, String> {
        Ok(SecretStoreStatus {
            kind: "env".to_string(),
            location: "env://process".to_string(),
            protection: "process_environment".to_string(),
            machine_scope: false,
            machine_secret_configured: self.read_secret(MACHINE_SECRET_ACCOUNT).await?.is_some(),
            mqtt_signing_secret_configured: self
                .read_secret(MQTT_SIGNING_SECRET_ACCOUNT)
                .await?
                .is_some(),
            mqtt_password_configured: self.read_secret(MQTT_PASSWORD_ACCOUNT).await?.is_some(),
            last_error: None,
        })
    }
}

#[async_trait]
impl SecretStore for FileSecretStore {
    async fn read_secret(&self, account: &str) -> Result<Option<String>, String> {
        let path = self.account_path(account)?;
        match tokio::fs::read_to_string(path).await {
            Ok(value) => Ok(Some(value.trim().to_string()).filter(|value| !value.is_empty())),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(format!("read file secret failed: {error}")),
        }
    }

    async fn write_secret(&self, account: &str, value: &str) -> Result<(), String> {
        let path = self.account_path(account)?;
        let value = value.trim();
        tokio::fs::create_dir_all(&self.dir)
            .await
            .map_err(|error| format!("create file secret dir failed: {error}"))?;
        if value.is_empty() {
            match tokio::fs::remove_file(path).await {
                Ok(()) => return Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
                Err(error) => return Err(format!("remove file secret failed: {error}")),
            }
        }
        let temp_path = path.with_extension("tmp");
        tokio::fs::write(&temp_path, value)
            .await
            .map_err(|error| format!("write file secret failed: {error}"))?;
        harden_secret_file_permissions(&temp_path).await?;
        tokio::fs::rename(&temp_path, &path)
            .await
            .map_err(|error| format!("replace file secret failed: {error}"))?;
        harden_secret_file_permissions(&path).await?;
        Ok(())
    }

    async fn clear_all(&self) -> Result<(), String> {
        match tokio::fs::remove_dir_all(&self.dir).await {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("clear file secrets failed: {error}")),
        }
    }

    async fn status(&self) -> Result<SecretStoreStatus, String> {
        Ok(SecretStoreStatus {
            kind: "file".to_string(),
            location: self.dir.to_string_lossy().replace('\\', "/"),
            protection: "plaintext_file".to_string(),
            machine_scope: false,
            machine_secret_configured: self.read_secret(MACHINE_SECRET_ACCOUNT).await?.is_some(),
            mqtt_signing_secret_configured: self
                .read_secret(MQTT_SIGNING_SECRET_ACCOUNT)
                .await?
                .is_some(),
            mqtt_password_configured: self.read_secret(MQTT_PASSWORD_ACCOUNT).await?.is_some(),
            last_error: None,
        })
    }
}

#[async_trait]
impl SecretStore for ProtectedLocalSecretStore {
    async fn read_secret(&self, account: &str) -> Result<Option<String>, String> {
        let path = self.account_path(account)?;
        let blob = match tokio::fs::read(&path).await {
            Ok(blob) => blob,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(format!("read protected local secret failed: {error}")),
        };
        let value = unprotect_secret_blob(blob)
            .await
            .map_err(|error| format!("unprotect protected local secret failed: {error}"))?;
        Ok(Some(value.trim().to_string()).filter(|value| !value.is_empty()))
    }

    async fn write_secret(&self, account: &str, value: &str) -> Result<(), String> {
        let path = self.account_path(account)?;
        let value = value.trim();
        tokio::fs::create_dir_all(&self.dir)
            .await
            .map_err(|error| format!("create protected local secret dir failed: {error}"))?;
        if value.is_empty() {
            match tokio::fs::remove_file(path).await {
                Ok(()) => return Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
                Err(error) => return Err(format!("remove protected local secret failed: {error}")),
            }
        }
        let blob = protect_secret_blob(value)
            .await
            .map_err(|error| format!("protect local secret failed: {error}"))?;
        let temp_path = path.with_extension("tmp");
        tokio::fs::write(&temp_path, blob)
            .await
            .map_err(|error| format!("write protected local secret failed: {error}"))?;
        harden_secret_file_permissions(&temp_path).await?;
        tokio::fs::rename(&temp_path, &path)
            .await
            .map_err(|error| format!("replace protected local secret failed: {error}"))?;
        harden_secret_file_permissions(&path).await?;
        Ok(())
    }

    async fn clear_all(&self) -> Result<(), String> {
        match tokio::fs::remove_dir_all(&self.dir).await {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("clear protected local secrets failed: {error}")),
        }
    }

    async fn status(&self) -> Result<SecretStoreStatus, String> {
        let (machine_secret_configured, machine_secret_error) =
            self.configured_for_status(MACHINE_SECRET_ACCOUNT).await;
        let (mqtt_signing_secret_configured, mqtt_signing_secret_error) = self
            .configured_for_status(MQTT_SIGNING_SECRET_ACCOUNT)
            .await;
        let (mqtt_password_configured, mqtt_password_error) =
            self.configured_for_status(MQTT_PASSWORD_ACCOUNT).await;
        let last_error = [
            machine_secret_error,
            mqtt_signing_secret_error,
            mqtt_password_error,
        ]
        .into_iter()
        .flatten()
        .next();
        Ok(SecretStoreStatus {
            kind: "protected_local_file".to_string(),
            location: self.dir.to_string_lossy().replace('\\', "/"),
            protection: protected_secret_protection_name().to_string(),
            machine_scope: cfg!(windows),
            machine_secret_configured,
            mqtt_signing_secret_configured,
            mqtt_password_configured,
            last_error,
        })
    }
}

async fn harden_secret_file_permissions(path: &std::path::Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let permissions = std::fs::Permissions::from_mode(0o600);
        tokio::fs::set_permissions(path, permissions)
            .await
            .map_err(|error| format!("harden file secret permissions failed: {error}"))?;
    }

    #[cfg(windows)]
    {
        let status = tokio::process::Command::new("icacls")
            .arg(path)
            .arg("/inheritance:r")
            .arg("/grant:r")
            .arg("Administrators:F")
            .arg("SYSTEM:F")
            .status()
            .await
            .map_err(|error| format!("run icacls for file secret failed: {error}"))?;
        if !status.success() {
            return Err(format!(
                "icacls for file secret failed with status {status}"
            ));
        }
    }

    Ok(())
}

fn protected_secret_protection_name() -> &'static str {
    if cfg!(windows) {
        "windows_dpapi_local_machine"
    } else {
        "deterministic_test_blob"
    }
}

#[cfg(not(windows))]
async fn protect_secret_blob(value: &str) -> Result<Vec<u8>, String> {
    use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine as _};

    let encoded: Vec<u8> = value.as_bytes().iter().map(|byte| byte ^ 0xA5).collect();
    Ok(format!(
        "VEM-TEST-PROTECTED-SECRET-v1:{}",
        STANDARD_NO_PAD.encode(encoded)
    )
    .into_bytes())
}

#[cfg(not(windows))]
async fn unprotect_secret_blob(blob: Vec<u8>) -> Result<String, String> {
    use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine as _};

    let text =
        String::from_utf8(blob).map_err(|error| format!("decode test blob failed: {error}"))?;
    let encoded = text
        .strip_prefix("VEM-TEST-PROTECTED-SECRET-v1:")
        .ok_or_else(|| "unsupported protected local secret blob".to_string())?;
    let protected = STANDARD_NO_PAD
        .decode(encoded.as_bytes())
        .map_err(|error| format!("decode test protected local secret failed: {error}"))?;
    let plain: Vec<u8> = protected.into_iter().map(|byte| byte ^ 0xA5).collect();
    String::from_utf8(plain).map_err(|error| format!("decode test secret failed: {error}"))
}

#[cfg(windows)]
async fn protect_secret_blob(value: &str) -> Result<Vec<u8>, String> {
    let value = value.as_bytes().to_vec();
    tokio::task::spawn_blocking(move || protect_secret_blob_blocking(&value))
        .await
        .map_err(|error| format!("join DPAPI protect failed: {error}"))?
}

#[cfg(windows)]
async fn unprotect_secret_blob(blob: Vec<u8>) -> Result<String, String> {
    let plain = tokio::task::spawn_blocking(move || unprotect_secret_blob_blocking(&blob))
        .await
        .map_err(|error| format!("join DPAPI unprotect failed: {error}"))??;
    String::from_utf8(plain).map_err(|error| format!("decode DPAPI secret failed: {error}"))
}

#[cfg(windows)]
fn protect_secret_blob_blocking(value: &[u8]) -> Result<Vec<u8>, String> {
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::{
        Foundation::{GetLastError, LocalFree},
        Security::Cryptography::{
            CryptProtectData, CRYPTPROTECT_LOCAL_MACHINE, CRYPTPROTECT_UI_FORBIDDEN,
            CRYPT_INTEGER_BLOB,
        },
    };

    let input = CRYPT_INTEGER_BLOB {
        cbData: value.len() as u32,
        pbData: value.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: null_mut(),
    };
    let ok = unsafe {
        CryptProtectData(
            &input,
            null(),
            null(),
            null(),
            null(),
            CRYPTPROTECT_LOCAL_MACHINE | CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if ok == 0 {
        return Err(format!("CryptProtectData failed: {}", unsafe {
            GetLastError()
        }));
    }
    let bytes = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) };
    let result = bytes.to_vec();
    unsafe {
        LocalFree(output.pbData as *mut std::ffi::c_void);
    }
    Ok(result)
}

#[cfg(windows)]
fn unprotect_secret_blob_blocking(blob: &[u8]) -> Result<Vec<u8>, String> {
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::{
        Foundation::{GetLastError, LocalFree},
        Security::Cryptography::{
            CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
        },
    };

    let input = CRYPT_INTEGER_BLOB {
        cbData: blob.len() as u32,
        pbData: blob.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: null_mut(),
    };
    let ok = unsafe {
        CryptUnprotectData(
            &input,
            null_mut(),
            null(),
            null(),
            null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if ok == 0 {
        return Err(format!("CryptUnprotectData failed: {}", unsafe {
            GetLastError()
        }));
    }
    let bytes = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) };
    let result = bytes.to_vec();
    unsafe {
        LocalFree(output.pbData as *mut std::ffi::c_void);
    }
    Ok(result)
}

#[async_trait]
impl SecretStore for KeyringSecretStore {
    async fn read_secret(&self, account: &str) -> Result<Option<String>, String> {
        let account = account.to_string();
        tokio::task::spawn_blocking(move || {
            let entry = keyring::Entry::new(KEYRING_SERVICE, &account)
                .map_err(|error| format!("create keyring entry failed: {error}"))?;
            match entry.get_password() {
                Ok(secret) => Ok(Some(secret)),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(error) => Err(format!("read keyring secret failed: {error}")),
            }
        })
        .await
        .map_err(|error| format!("join keyring read failed: {error}"))?
    }

    async fn write_secret(&self, account: &str, value: &str) -> Result<(), String> {
        let account = account.to_string();
        let value = value.trim().to_string();
        tokio::task::spawn_blocking(move || {
            if value.is_empty() {
                let entry = keyring::Entry::new(KEYRING_SERVICE, &account)
                    .map_err(|error| format!("create keyring entry failed: {error}"))?;
                return match entry.delete_credential() {
                    Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                    Err(error) => Err(format!("delete keyring secret failed: {error}")),
                };
            }
            let entry = keyring::Entry::new(KEYRING_SERVICE, &account)
                .map_err(|error| format!("create keyring entry failed: {error}"))?;
            entry
                .set_password(&value)
                .map_err(|error| format!("write keyring secret failed: {error}"))
        })
        .await
        .map_err(|error| format!("join keyring write failed: {error}"))?
    }

    async fn clear_all(&self) -> Result<(), String> {
        for account in SECRET_ACCOUNTS {
            self.write_secret(account, "").await?;
        }
        Ok(())
    }

    async fn status(&self) -> Result<SecretStoreStatus, String> {
        Ok(SecretStoreStatus {
            kind: "keyring".to_string(),
            location: format!("keyring://{KEYRING_SERVICE}"),
            protection: "os_keyring".to_string(),
            machine_scope: false,
            machine_secret_configured: self.read_secret(MACHINE_SECRET_ACCOUNT).await?.is_some(),
            mqtt_signing_secret_configured: self
                .read_secret(MQTT_SIGNING_SECRET_ACCOUNT)
                .await?
                .is_some(),
            mqtt_password_configured: self.read_secret(MQTT_PASSWORD_ACCOUNT).await?.is_some(),
            last_error: None,
        })
    }
}

pub fn default_secret_store(data_dir: PathBuf) -> Arc<dyn SecretStore> {
    match std::env::var("VEM_DAEMON_SECRET_STORE").ok().as_deref() {
        Some("env") => Arc::new(EnvSecretStore),
        Some("file") => Arc::new(FileSecretStore::new(data_dir)),
        Some("keyring") => Arc::new(KeyringSecretStore),
        _ => Arc::new(ProtectedLocalSecretStore::new(data_dir)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn in_memory_secret_store_round_trips_and_ignores_empty_set() {
        let store = InMemorySecretStore::default();
        store.write_secret("account", "").await.unwrap();
        assert!(store.read_secret("account").await.unwrap().is_none());

        store.write_secret("account", "value").await.unwrap();
        assert_eq!(
            store.read_secret("account").await.unwrap().as_deref(),
            Some("value")
        );

        store.write_secret("account", "").await.unwrap();
        assert!(store.read_secret("account").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn env_secret_store_reads_only_mapped_test_env_vars() {
        // SAFETY: tests mutate process env in a scoped way.
        unsafe {
            std::env::set_var("VEM_MQTT_SIGNING_SECRET", " test-signing ");
        }
        let store = EnvSecretStore;
        assert_eq!(
            store
                .read_secret(MQTT_SIGNING_SECRET_ACCOUNT)
                .await
                .unwrap()
                .as_deref(),
            Some("test-signing")
        );
        assert!(store
            .write_secret(MQTT_SIGNING_SECRET_ACCOUNT, "x")
            .await
            .is_err());
        // SAFETY: tests mutate process env in a scoped way.
        unsafe {
            std::env::remove_var("VEM_MQTT_SIGNING_SECRET");
        }
    }

    #[tokio::test]
    async fn file_secret_store_round_trips_known_accounts() {
        let temp = tempfile::tempdir().unwrap();
        let store = FileSecretStore::new(temp.path().to_path_buf());
        store
            .write_secret(MACHINE_SECRET_ACCOUNT, " machine-secret ")
            .await
            .unwrap();
        assert_eq!(
            store
                .read_secret(MACHINE_SECRET_ACCOUNT)
                .await
                .unwrap()
                .as_deref(),
            Some("machine-secret")
        );
        store
            .write_secret(MACHINE_SECRET_ACCOUNT, "")
            .await
            .unwrap();
        assert!(store
            .read_secret(MACHINE_SECRET_ACCOUNT)
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn protected_local_secret_store_round_trips_status_and_clear_without_exposing_values() {
        let temp = tempfile::tempdir().unwrap();
        let store = ProtectedLocalSecretStore::new(temp.path().to_path_buf());
        let machine_secret = "vms_machine_secret_12345678901234567890";
        let signing_secret = "vms_mqtt_signing_secret_123456789012345";
        let mqtt_password = "mqtt-password-secret";

        store
            .write_secret(MACHINE_SECRET_ACCOUNT, machine_secret)
            .await
            .unwrap();
        store
            .write_secret(MQTT_SIGNING_SECRET_ACCOUNT, signing_secret)
            .await
            .unwrap();
        store
            .write_secret(MQTT_PASSWORD_ACCOUNT, mqtt_password)
            .await
            .unwrap();

        assert_eq!(
            store
                .read_secret(MACHINE_SECRET_ACCOUNT)
                .await
                .unwrap()
                .as_deref(),
            Some(machine_secret)
        );
        assert_eq!(
            store
                .read_secret(MQTT_SIGNING_SECRET_ACCOUNT)
                .await
                .unwrap()
                .as_deref(),
            Some(signing_secret)
        );
        assert_eq!(
            store
                .read_secret(MQTT_PASSWORD_ACCOUNT)
                .await
                .unwrap()
                .as_deref(),
            Some(mqtt_password)
        );

        let status = store.status().await.unwrap();
        assert_eq!(status.kind, "protected_local_file");
        assert_eq!(status.protection, protected_secret_protection_name());
        assert!(status.machine_secret_configured);
        assert!(status.mqtt_signing_secret_configured);
        assert!(status.mqtt_password_configured);
        let serialized = serde_json::to_string(&status).unwrap();
        assert!(!serialized.contains(machine_secret));
        assert!(!serialized.contains(signing_secret));
        assert!(!serialized.contains(mqtt_password));

        store.clear_all().await.unwrap();
        let status = store.status().await.unwrap();
        assert!(!status.machine_secret_configured);
        assert!(!status.mqtt_signing_secret_configured);
        assert!(!status.mqtt_password_configured);
        assert!(store
            .read_secret(MACHINE_SECRET_ACCOUNT)
            .await
            .unwrap()
            .is_none());
    }
}
