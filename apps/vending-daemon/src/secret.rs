use std::{collections::HashMap, path::PathBuf, sync::Arc};

use async_trait::async_trait;
use tokio::sync::RwLock;

pub const KEYRING_SERVICE: &str = "com.vem.machine";
pub const MACHINE_SECRET_ACCOUNT: &str = "machine_secret";
pub const MQTT_SIGNING_SECRET_ACCOUNT: &str = "mqtt_signing_secret";
pub const MQTT_PASSWORD_ACCOUNT: &str = "mqtt_password";

#[async_trait]
pub trait SecretStore: Send + Sync {
    async fn read_secret(&self, account: &str) -> Result<Option<String>, String>;
    async fn write_secret(&self, account: &str, value: &str) -> Result<(), String>;
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
                return Ok(());
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
}

pub fn default_secret_store(data_dir: PathBuf) -> Arc<dyn SecretStore> {
    match std::env::var("VEM_DAEMON_SECRET_STORE").ok().as_deref() {
        Some("env") => Arc::new(EnvSecretStore),
        Some("file") => Arc::new(FileSecretStore::new(data_dir)),
        _ => Arc::new(KeyringSecretStore),
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
}
