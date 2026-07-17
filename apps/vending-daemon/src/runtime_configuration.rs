use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};

use daemon_ipc_contracts::{
    EffectiveMachineRuntimeConfiguration, ProvisioningProfileCache, RuntimeBootstrap,
};
use serde_json::json;
use tokio::{fs, sync::Mutex};

use crate::{
    config::MachineProvisioningProfile,
    secret::{
        SecretStore, MACHINE_SECRET_ACCOUNT, MQTT_PASSWORD_ACCOUNT, MQTT_SIGNING_SECRET_ACCOUNT,
    },
};

const SCHEMA_VERSION: f64 = 1.0;

/// The clean configuration boundary. Deployment owns Runtime Bootstrap while
/// the daemon owns the accepted profile cache and credential extraction.
pub struct CleanRuntimeConfigurationStore {
    data_dir: PathBuf,
    secrets: Arc<dyn SecretStore>,
    mutation_lock: Mutex<()>,
    generation: AtomicU64,
    refresh_error: Mutex<Option<String>>,
}

impl CleanRuntimeConfigurationStore {
    pub fn new(data_dir: PathBuf, secrets: Arc<dyn SecretStore>) -> Self {
        Self {
            data_dir,
            secrets,
            mutation_lock: Mutex::new(()),
            generation: AtomicU64::new(0),
            refresh_error: Mutex::new(None),
        }
    }

    pub fn runtime_bootstrap_path(&self) -> PathBuf {
        runtime_root(&self.data_dir).join("runtime-bootstrap.json")
    }

    pub fn profile_cache_path(&self) -> PathBuf {
        self.data_dir.join("config").join("profile-cache.json")
    }

    pub async fn load_bootstrap(&self) -> Result<RuntimeBootstrap, String> {
        let value = read_required_json(self.runtime_bootstrap_path(), "runtime bootstrap").await?;
        let bootstrap: RuntimeBootstrap = serde_json::from_value(value)
            .map_err(|error| format!("runtime bootstrap contract invalid: {error}"))?;
        if bootstrap.schema_version != SCHEMA_VERSION {
            return Err("runtime bootstrap schema version unsupported".to_string());
        }
        Ok(bootstrap)
    }

    pub async fn load_profile_cache(&self) -> Result<Option<ProvisioningProfileCache>, String> {
        let Some(value) =
            read_optional_json(self.profile_cache_path(), "provisioning profile cache").await?
        else {
            return Ok(None);
        };
        let cache: ProvisioningProfileCache = serde_json::from_value(value)
            .map_err(|error| format!("provisioning profile cache contract invalid: {error}"))?;
        if cache.schema_version != SCHEMA_VERSION {
            return Err("provisioning profile cache schema version unsupported".to_string());
        }
        Ok(Some(cache))
    }

    /// Accepting a profile is intentionally ordered: validate first, make all
    /// machine credentials durable, then atomically publish the new cache.
    pub async fn accept_profile(
        &self,
        profile: &MachineProvisioningProfile,
    ) -> Result<ProvisioningProfileCache, String> {
        let _mutation = self.mutation_lock.lock().await;
        let cache = match profile_cache_from_claim(profile) {
            Ok(cache) => cache,
            Err(error) => {
                self.record_refresh_error("profile contract was rejected")
                    .await;
                return Err(error);
            }
        };
        if self.runtime_bootstrap_path().exists() {
            let bootstrap = self.load_bootstrap().await?;
            if bootstrap.topology.identity.to_string() != profile.hardware_slot_topology.identity
                || bootstrap.topology.version.to_string() != profile.hardware_slot_topology.version
            {
                self.record_refresh_error("profile topology does not match Runtime Bootstrap")
                    .await;
                return Err(
                    "provisioning profile topology does not match Runtime Bootstrap".to_string(),
                );
            }
        }
        let previous = credential_snapshot(self.secrets.as_ref()).await?;
        let replacements = [
            (
                MACHINE_SECRET_ACCOUNT,
                profile.credentials.machine_secret.as_str(),
            ),
            (
                MQTT_SIGNING_SECRET_ACCOUNT,
                profile.credentials.mqtt_signing_secret.as_str(),
            ),
            (
                MQTT_PASSWORD_ACCOUNT,
                profile
                    .credentials
                    .mqtt_connection
                    .password
                    .as_deref()
                    .unwrap_or(""),
            ),
        ];

        for (account, value) in replacements {
            if let Err(error) = self.secrets.write_secret(account, value).await {
                restore_credentials(self.secrets.as_ref(), &previous).await?;
                self.record_refresh_error("profile credentials were not accepted")
                    .await;
                return Err(format!("persist profile credentials failed: {error}"));
            }
        }

        if let Err(error) = write_atomic_json(&self.profile_cache_path(), &cache).await {
            restore_credentials(self.secrets.as_ref(), &previous).await?;
            self.record_refresh_error("profile cache was not accepted")
                .await;
            return Err(error);
        }

        *self.refresh_error.lock().await = None;
        self.generation.fetch_add(1, Ordering::AcqRel);
        Ok(cache)
    }

    /// Reclaim and local reset remove only the daemon-owned claim state. The
    /// deployment-owned bootstrap remains at the runtime root.
    pub async fn clear_claim(&self) -> Result<(), String> {
        let _mutation = self.mutation_lock.lock().await;
        match fs::remove_file(self.profile_cache_path()).await {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("remove provisioning profile cache failed: {error}")),
        }
        for account in [
            MACHINE_SECRET_ACCOUNT,
            MQTT_SIGNING_SECRET_ACCOUNT,
            MQTT_PASSWORD_ACCOUNT,
        ] {
            self.secrets.write_secret(account, "").await?;
        }
        *self.refresh_error.lock().await = None;
        self.generation.fetch_add(1, Ordering::AcqRel);
        Ok(())
    }

    pub async fn effective_projection(
        &self,
    ) -> Result<EffectiveMachineRuntimeConfiguration, String> {
        let bootstrap = self.load_bootstrap().await?;
        let cache = self.load_profile_cache().await?;
        let secrets = self.secrets.status().await?;
        let refresh_error = self.refresh_error.lock().await.clone();
        let status = if cache.is_none() {
            "unclaimed"
        } else if refresh_error.is_some() {
            "degraded"
        } else {
            "accepted"
        };
        serde_json::from_value(json!({
            "schemaVersion": 1,
            "generation": self.generation.load(Ordering::Acquire),
            "bootstrap": bootstrap,
            "profileCache": cache,
            "profileRefresh": { "status": status, "lastError": refresh_error },
            "configuredSecrets": {
                "machineSecretConfigured": secrets.machine_secret_configured,
                "mqttSigningSecretConfigured": secrets.mqtt_signing_secret_configured,
                "mqttPasswordConfigured": secrets.mqtt_password_configured,
            },
        }))
        .map_err(|error| format!("effective runtime configuration contract invalid: {error}"))
    }

    async fn record_refresh_error(&self, error: &str) {
        *self.refresh_error.lock().await = Some(error.to_string());
    }
}

fn runtime_root(data_dir: &Path) -> PathBuf {
    data_dir
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| data_dir.to_path_buf())
}

async fn read_required_json(path: PathBuf, label: &str) -> Result<serde_json::Value, String> {
    let content = fs::read_to_string(&path)
        .await
        .map_err(|error| format!("read {label} failed at {}: {error}", path.display()))?;
    serde_json::from_str(&content).map_err(|error| format!("parse {label} failed: {error}"))
}

async fn read_optional_json(
    path: PathBuf,
    label: &str,
) -> Result<Option<serde_json::Value>, String> {
    match fs::read_to_string(&path).await {
        Ok(content) => serde_json::from_str(&content)
            .map(Some)
            .map_err(|error| format!("parse {label} failed: {error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!(
            "read {label} failed at {}: {error}",
            path.display()
        )),
    }
}

async fn write_atomic_json<T: serde::Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "profile cache path has no parent".to_string())?;
    fs::create_dir_all(parent)
        .await
        .map_err(|error| format!("create profile cache dir failed: {error}"))?;
    let payload = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("serialize provisioning profile cache failed: {error}"))?;
    let staged = path.with_extension("json.tmp");
    fs::write(&staged, payload)
        .await
        .map_err(|error| format!("stage provisioning profile cache failed: {error}"))?;
    fs::rename(&staged, path)
        .await
        .map_err(|error| format!("accept provisioning profile cache failed: {error}"))
}

async fn credential_snapshot(
    store: &dyn SecretStore,
) -> Result<Vec<(&'static str, Option<String>)>, String> {
    let mut values = Vec::new();
    for account in [
        MACHINE_SECRET_ACCOUNT,
        MQTT_SIGNING_SECRET_ACCOUNT,
        MQTT_PASSWORD_ACCOUNT,
    ] {
        values.push((account, store.read_secret(account).await?));
    }
    Ok(values)
}

async fn restore_credentials(
    store: &dyn SecretStore,
    values: &[(&str, Option<String>)],
) -> Result<(), String> {
    for (account, value) in values {
        store
            .write_secret(account, value.as_deref().unwrap_or(""))
            .await?;
    }
    Ok(())
}

fn profile_cache_from_claim(
    profile: &MachineProvisioningProfile,
) -> Result<ProvisioningProfileCache, String> {
    if profile.metadata.profile_version != 1
        || profile.hardware_profile.profile != "production"
        || !profile.hardware_profile.controller.required
        || profile.hardware_profile.controller.protocol != "vem-vending-controller"
        || !profile.hardware_profile.payment_scanner.required
        || profile.payment_capability.profile != "production"
    {
        return Err("provisioning profile cache contract invalid".to_string());
    }
    let cache = json!({
        "schemaVersion": 1,
        "acceptedAt": chrono::Utc::now().to_rfc3339(),
        "profile": {
            "machine": {
                "id": profile.machine.id,
                "code": profile.machine.code,
                "name": profile.machine.name,
                "status": profile.machine.status,
                "locationLabel": profile.machine.location_label,
            },
            "apiBaseUrl": profile.api_base_url,
            "runtimeEndpoints": profile.runtime_endpoints,
            "mqttConnection": {
                "url": profile.credentials.mqtt_connection.url,
                "clientId": profile.credentials.mqtt_connection.client_id,
                "username": profile.credentials.mqtt_connection.username,
            },
            "hardwareProfile": profile.hardware_profile,
            "hardwareSlotTopology": profile.hardware_slot_topology,
            "paymentCapability": {
                "profile": profile.payment_capability.profile,
                "qrCodeEnabled": profile.payment_capability.qr_code_enabled,
                "paymentCodeEnabled": profile.payment_capability.payment_code_enabled,
                "serverTime": profile.payment_capability.server_time,
            },
            "metadata": profile.metadata,
        },
    });
    serde_json::from_value(cache)
        .map_err(|error| format!("provisioning profile cache contract invalid: {error}"))
}
