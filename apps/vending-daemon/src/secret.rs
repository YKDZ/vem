use std::{collections::HashMap, sync::Arc};

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

pub fn default_secret_store() -> Arc<dyn SecretStore> {
    if std::env::var("VEM_DAEMON_SECRET_STORE").ok().as_deref() == Some("env") {
        Arc::new(EnvSecretStore)
    } else {
        Arc::new(KeyringSecretStore)
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
}
