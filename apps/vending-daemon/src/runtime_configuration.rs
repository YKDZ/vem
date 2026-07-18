use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};

use async_trait::async_trait;
use daemon_ipc_contracts::{
    EffectiveMachineRuntimeConfiguration, ProvisioningProfileCache, RuntimeBootstrap,
};
use serde_json::json;
use tokio::{fs, io::AsyncWriteExt, sync::Mutex};

use crate::{
    device_binding::{LocalDeviceRole, LocalSerialRoleBinding},
    local_runtime_settings::LocalRuntimeSettingsStore,
    provisioning::{validate_machine_provisioning_profile, MachineProvisioningProfile},
    secret::{
        SecretStore, MACHINE_SECRET_ACCOUNT, MACHINE_SECRET_ROLLBACK_ACCOUNT,
        MQTT_PASSWORD_ACCOUNT, MQTT_PASSWORD_ROLLBACK_ACCOUNT, MQTT_SIGNING_SECRET_ACCOUNT,
        MQTT_SIGNING_SECRET_ROLLBACK_ACCOUNT,
    },
};

const SCHEMA_VERSION: f64 = 1.0;

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClaimTransactionJournal {
    schema_version: u8,
    operation: String,
    generation: u64,
    profile_generation: u64,
    #[serde(default)]
    phase: String,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProfileRefreshState {
    schema_version: u8,
    last_error: String,
}

#[async_trait]
pub trait RuntimeConfigurationFileWriter: Send + Sync {
    async fn write(&self, path: &Path, payload: &[u8]) -> Result<(), String>;
}

struct DurableRuntimeConfigurationFileWriter;

#[async_trait]
impl RuntimeConfigurationFileWriter for DurableRuntimeConfigurationFileWriter {
    async fn write(&self, path: &Path, payload: &[u8]) -> Result<(), String> {
        write_atomic_bytes(path, payload).await
    }
}

/// The clean configuration boundary. Deployment owns Runtime Bootstrap while
/// the daemon owns the accepted profile cache and credential extraction.
pub struct CleanRuntimeConfigurationStore {
    data_dir: PathBuf,
    secrets: Arc<dyn SecretStore>,
    local_settings: Arc<LocalRuntimeSettingsStore>,
    mutation_lock: Mutex<()>,
    generation: AtomicU64,
    refresh_error: Mutex<Option<String>>,
    file_writer: Arc<dyn RuntimeConfigurationFileWriter>,
}

/// The daemon's only mutable runtime sources. Runtime Bootstrap remains
/// deployment-owned; profile cache, extracted credentials and local settings
/// have independent ownership and are never materialized as a legacy document.
pub struct RuntimeSources {
    data_dir: PathBuf,
    clean: Arc<CleanRuntimeConfigurationStore>,
    secrets: Arc<dyn SecretStore>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaimedMachineCredentials {
    pub machine_secret: String,
    pub mqtt_signing_secret: String,
    pub mqtt_password: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HardwareTopologyReadiness {
    pub ready: bool,
    pub code: String,
    pub message: String,
}

impl RuntimeSources {
    pub fn new(data_dir: PathBuf, secrets: Arc<dyn SecretStore>) -> Self {
        Self {
            clean: Arc::new(CleanRuntimeConfigurationStore::new(
                data_dir.clone(),
                secrets.clone(),
            )),
            data_dir,
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

    pub fn clean_runtime_configuration(&self) -> Arc<CleanRuntimeConfigurationStore> {
        self.clean.clone()
    }

    pub async fn load_local_runtime_settings(
        &self,
    ) -> Result<crate::local_runtime_settings::LocalRuntimeSettings, String> {
        self.clean.load_local_runtime_settings().await
    }

    pub async fn set_local_scanner_protocol(
        &self,
        protocol: Option<crate::local_runtime_settings::ScannerProtocolParameters>,
    ) -> Result<u64, String> {
        self.clean.set_local_scanner_protocol(protocol).await
    }

    pub async fn set_local_audio_preferences(
        &self,
        preferences: crate::local_runtime_settings::AudioPreferences,
    ) -> Result<u64, String> {
        self.clean.set_local_audio_preferences(preferences).await
    }

    pub async fn local_device_binding_snapshot(
        &self,
        role: LocalDeviceRole,
    ) -> Result<(Option<LocalSerialRoleBinding>, String), String> {
        self.clean.local_device_binding_snapshot(role).await
    }

    pub async fn save_local_device_binding_if_revision(
        &self,
        role: LocalDeviceRole,
        binding: LocalSerialRoleBinding,
        revision: &str,
    ) -> Result<String, String> {
        self.clean
            .save_local_device_binding_if_revision(role, binding, revision)
            .await
    }

    pub async fn restore_local_device_binding_if_revision(
        &self,
        role: LocalDeviceRole,
        binding: Option<LocalSerialRoleBinding>,
        revision: &str,
    ) -> Result<String, String> {
        self.clean
            .restore_local_device_binding_if_revision(role, binding, revision)
            .await
    }

    pub async fn require_profile(&self) -> Result<ProvisioningProfileCache, String> {
        self.clean
            .load_profile_cache()
            .await?
            .ok_or_else(|| "machine provisioning profile has not been claimed".to_string())
    }

    /// Topology is deliberately checked from the two documents that own it:
    /// deployment bootstrap and the accepted profile cache. No reconstructed
    /// runtime configuration is involved in this safety decision.
    pub async fn hardware_topology_readiness(&self) -> Result<HardwareTopologyReadiness, String> {
        let bootstrap = self.clean.load_bootstrap().await?;
        let Some(profile) = self.clean.load_profile_cache().await? else {
            return Ok(HardwareTopologyReadiness {
                ready: false,
                code: "MACHINE_NOT_CLAIMED".to_string(),
                message: "machine provisioning profile has not been claimed".to_string(),
            });
        };
        let model_matches =
            profile.profile.hardware_model.to_string() == bootstrap.hardware_model.to_string();
        let topology_matches = profile.profile.hardware_slot_topology.identity.to_string()
            == bootstrap.topology.identity.to_string()
            && profile.profile.hardware_slot_topology.version.to_string()
                == bootstrap.topology.version.to_string();
        if model_matches && topology_matches {
            Ok(HardwareTopologyReadiness {
                ready: true,
                code: "HARDWARE_SLOT_TOPOLOGY_READY".to_string(),
                message: "accepted provisioning profile matches the deployment topology"
                    .to_string(),
            })
        } else {
            Ok(HardwareTopologyReadiness {
                ready: false,
                code: "HARDWARE_SLOT_TOPOLOGY_MISMATCH".to_string(),
                message: "accepted provisioning profile does not match the deployment topology"
                    .to_string(),
            })
        }
    }

    pub async fn claimed_credentials(&self) -> Result<ClaimedMachineCredentials, String> {
        let machine_secret = self
            .secrets
            .read_secret(MACHINE_SECRET_ACCOUNT)
            .await?
            .ok_or_else(|| "machine credential is unavailable".to_string())?;
        let mqtt_signing_secret = self
            .secrets
            .read_secret(MQTT_SIGNING_SECRET_ACCOUNT)
            .await?
            .ok_or_else(|| "mqtt signing credential is unavailable".to_string())?;
        let mqtt_password = self.secrets.read_secret(MQTT_PASSWORD_ACCOUNT).await?;
        Ok(ClaimedMachineCredentials {
            machine_secret,
            mqtt_signing_secret,
            mqtt_password,
        })
    }
}

impl CleanRuntimeConfigurationStore {
    pub fn new(data_dir: PathBuf, secrets: Arc<dyn SecretStore>) -> Self {
        Self::with_file_writer(
            data_dir,
            secrets,
            Arc::new(DurableRuntimeConfigurationFileWriter),
        )
    }

    pub fn with_file_writer(
        data_dir: PathBuf,
        secrets: Arc<dyn SecretStore>,
        file_writer: Arc<dyn RuntimeConfigurationFileWriter>,
    ) -> Self {
        let local_settings = LocalRuntimeSettingsStore::new(data_dir.clone());
        Self {
            data_dir,
            secrets,
            local_settings,
            mutation_lock: Mutex::new(()),
            generation: AtomicU64::new(0),
            refresh_error: Mutex::new(None),
            file_writer,
        }
    }

    pub fn runtime_bootstrap_path(&self) -> PathBuf {
        runtime_root(&self.data_dir).join("runtime-bootstrap.json")
    }

    pub fn profile_cache_path(&self) -> PathBuf {
        self.data_dir.join("config").join("profile-cache.json")
    }

    pub fn claim_journal_path(&self) -> PathBuf {
        self.data_dir.join("config").join("claim-transaction.json")
    }

    pub fn profile_refresh_state_path(&self) -> PathBuf {
        self.data_dir.join("config").join("profile-refresh.json")
    }

    /// Finishes a committed transaction or removes every claim artifact from
    /// an interrupted one. This prevents a restarted daemon from consuming a
    /// profile cache and credentials that came from different claims.
    pub async fn recover_claim_transaction(&self) -> Result<(), String> {
        let _mutation = self.mutation_lock.lock().await;
        self.recover_claim_transaction_locked().await
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

    pub async fn load_local_runtime_settings(
        &self,
    ) -> Result<crate::local_runtime_settings::LocalRuntimeSettings, String> {
        self.local_settings.load().await
    }

    pub async fn set_local_scanner_protocol(
        &self,
        protocol: Option<crate::local_runtime_settings::ScannerProtocolParameters>,
    ) -> Result<u64, String> {
        self.local_settings.set_scanner_protocol(protocol).await
    }

    pub async fn set_local_audio_preferences(
        &self,
        preferences: crate::local_runtime_settings::AudioPreferences,
    ) -> Result<u64, String> {
        self.local_settings.set_audio_preferences(preferences).await
    }

    pub async fn local_device_binding_snapshot(
        &self,
        role: LocalDeviceRole,
    ) -> Result<(Option<LocalSerialRoleBinding>, String), String> {
        self.local_settings.binding_snapshot(role).await
    }

    pub async fn save_local_device_binding_if_revision(
        &self,
        role: LocalDeviceRole,
        binding: LocalSerialRoleBinding,
        revision: &str,
    ) -> Result<String, String> {
        self.local_settings
            .replace_binding_if_revision(role, Some(binding), revision)
            .await
    }

    pub async fn restore_local_device_binding_if_revision(
        &self,
        role: LocalDeviceRole,
        binding: Option<LocalSerialRoleBinding>,
        revision: &str,
    ) -> Result<String, String> {
        self.local_settings
            .replace_binding_if_revision(role, binding, revision)
            .await
    }

    /// Accepting a profile never removes the accepted profile first. The
    /// previous credentials are held in protected rollback slots until the
    /// replacement cache is atomically published, so an interruption can
    /// restore the last known-good pair instead of leaving an unclaimed box.
    pub async fn accept_profile(
        &self,
        profile: &MachineProvisioningProfile,
    ) -> Result<ProvisioningProfileCache, String> {
        let _mutation = self.mutation_lock.lock().await;
        if let Err(error) = self.recover_claim_transaction_locked().await {
            self.record_refresh_error("profile acceptance recovery failed")
                .await;
            return Err(error);
        }
        let accepted_cache = match self.load_profile_cache().await {
            Ok(cache) => cache,
            Err(error) => {
                self.record_refresh_error("accepted profile cache is unreadable")
                    .await;
                return Err(error);
            }
        };
        let generation = self
            .generation
            .load(Ordering::Acquire)
            .max(
                accepted_cache
                    .as_ref()
                    .map(|cache| cache.generation.get())
                    .unwrap_or_default(),
            )
            .saturating_add(1);
        if let Err(error) = validate_machine_provisioning_profile(profile) {
            self.record_refresh_error("profile contract was rejected")
                .await;
            return Err(error);
        }
        let cache = match profile_cache_from_claim(profile, generation) {
            Ok(cache) => cache,
            Err(error) => {
                self.record_refresh_error("profile contract was rejected")
                    .await;
                return Err(error);
            }
        };
        if self.runtime_bootstrap_path().exists() {
            let bootstrap = match self.load_bootstrap().await {
                Ok(bootstrap) => bootstrap,
                Err(error) => {
                    self.record_refresh_error("runtime bootstrap is unreadable")
                        .await;
                    return Err(error);
                }
            };
            if bootstrap.hardware_model.to_string() != profile.hardware_model.as_str()
                || bootstrap.topology.identity.to_string()
                    != profile.hardware_slot_topology.identity.as_str()
                || bootstrap.topology.version.to_string()
                    != profile.hardware_slot_topology.version.as_str()
            {
                self.record_refresh_error("profile hardware does not match Runtime Bootstrap")
                    .await;
                return Err(
                    "provisioning profile hardware does not match Runtime Bootstrap".to_string(),
                );
            }
        }
        let previous = match credential_snapshot(self.secrets.as_ref()).await {
            Ok(previous) => previous,
            Err(error) => {
                self.record_refresh_error("profile credential snapshot failed")
                    .await;
                return Err(error);
            }
        };
        if let Err(error) = write_credential_backups(self.secrets.as_ref(), &previous).await {
            let _ = clear_credential_backups(self.secrets.as_ref()).await;
            self.record_refresh_error("profile credential rollback preparation failed")
                .await;
            return Err(error);
        }
        let journal = ClaimTransactionJournal {
            schema_version: 1,
            operation: "accept".to_string(),
            generation,
            profile_generation: generation,
            phase: "credentials_replacing".to_string(),
        };
        if let Err(error) = self
            .write_atomic_json(&self.claim_journal_path(), &journal)
            .await
        {
            self.record_refresh_error("profile acceptance journal was not persisted")
                .await;
            let _ = clear_credential_backups(self.secrets.as_ref()).await;
            return Err(error);
        }
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
                    .as_ref()
                    .map(|value| value.as_str())
                    .unwrap_or(""),
            ),
        ];

        for (account, value) in replacements {
            if let Err(error) = self.secrets.write_secret(account, value).await {
                let _ = restore_credentials(self.secrets.as_ref(), &previous).await;
                let _ = clear_credential_backups(self.secrets.as_ref()).await;
                let _ = remove_optional_file(&self.claim_journal_path()).await;
                self.record_refresh_error("profile credentials were not accepted")
                    .await;
                return Err(format!("persist profile credentials failed: {error}"));
            }
        }

        if let Err(error) = self
            .write_atomic_json(&self.profile_cache_path(), &cache)
            .await
        {
            self.record_refresh_error("profile cache was not accepted")
                .await;
            let _ = restore_credentials(self.secrets.as_ref(), &previous).await;
            let _ = clear_credential_backups(self.secrets.as_ref()).await;
            let _ = remove_optional_file(&self.claim_journal_path()).await;
            return Err(error);
        }

        if let Err(error) = clear_credential_backups(self.secrets.as_ref()).await {
            self.record_refresh_error("profile credential rollback cleanup failed")
                .await;
            return Err(error);
        }
        if let Err(error) = remove_optional_file(&self.claim_journal_path()).await {
            self.record_refresh_error("profile acceptance journal cleanup failed")
                .await;
            return Err(error);
        }
        self.clear_refresh_error().await;
        self.generation.store(generation, Ordering::Release);
        Ok(cache)
    }

    pub async fn accept_refreshed_profile(
        &self,
        profile: &daemon_ipc_contracts::MachineProvisioningProfileSnapshot,
    ) -> Result<Option<ProvisioningProfileCache>, String> {
        let _mutation = self.mutation_lock.lock().await;
        if let Err(error) = self.recover_claim_transaction_locked().await {
            self.record_refresh_error("profile refresh recovery failed")
                .await;
            return Err(error);
        }
        let accepted_cache = match self.load_profile_cache().await {
            Ok(cache) => cache,
            Err(error) => {
                self.record_refresh_error("accepted profile cache is unreadable")
                    .await;
                return Err(error);
            }
        };
        let Some(accepted) = accepted_cache else {
            self.record_refresh_error("profile refresh requires an accepted claim")
                .await;
            return Err("profile refresh requires an accepted claim".to_string());
        };
        if accepted.profile.machine.id != profile.machine.id
            || accepted.profile.machine.code.as_str() != profile.machine.code.as_str()
        {
            self.record_refresh_error("profile refresh machine identity changed")
                .await;
            return Err("profile refresh machine identity changed".to_string());
        }
        let accepted_revision = accepted.profile.metadata.profile_revision.get();
        let refresh_revision = profile.metadata.profile_revision.get();
        if refresh_revision == accepted_revision {
            if serde_json::to_value(&accepted.profile).ok() == serde_json::to_value(profile).ok() {
                self.clear_refresh_error().await;
                return Ok(None);
            }
            self.record_refresh_error("profile changed without a newer revision")
                .await;
            return Err("provisioning profile changed without a newer revision".to_string());
        }

        let bootstrap = match self.load_bootstrap().await {
            Ok(bootstrap) => bootstrap,
            Err(error) => {
                self.record_refresh_error("runtime bootstrap is unreadable")
                    .await;
                return Err(error);
            }
        };
        if bootstrap.hardware_model.as_str() != profile.hardware_model.as_str()
            || bootstrap.topology.identity.as_str()
                != profile.hardware_slot_topology.identity.as_str()
            || bootstrap.topology.version.as_str()
                != profile.hardware_slot_topology.version.as_str()
        {
            self.record_refresh_error("profile hardware does not match Runtime Bootstrap")
                .await;
            return Err(
                "provisioning profile hardware does not match Runtime Bootstrap".to_string(),
            );
        }

        let generation = self
            .generation
            .load(Ordering::Acquire)
            .max(accepted.generation.get())
            .saturating_add(1);
        let cache = match profile_cache_from_snapshot(profile, generation) {
            Ok(cache) => cache,
            Err(error) => {
                self.record_refresh_error("profile refresh contract was rejected")
                    .await;
                return Err(error);
            }
        };
        if let Err(error) = self
            .write_atomic_json(&self.profile_cache_path(), &cache)
            .await
        {
            self.record_refresh_error("profile refresh cache was not accepted")
                .await;
            return Err(error);
        }
        self.clear_refresh_error().await;
        self.generation.store(generation, Ordering::Release);
        Ok(Some(cache))
    }

    pub async fn mark_profile_refresh_degraded(&self, error: &str) {
        self.record_refresh_error(error).await;
    }

    /// Reclaim and local reset remove only the daemon-owned claim state. The
    /// deployment-owned bootstrap remains at the runtime root.
    pub async fn clear_claim(&self) -> Result<(), String> {
        let _mutation = self.mutation_lock.lock().await;
        let generation = self.generation.load(Ordering::Acquire).saturating_add(1);
        self.write_atomic_json(
            &self.claim_journal_path(),
            &ClaimTransactionJournal {
                schema_version: 1,
                operation: "clear".to_string(),
                generation,
                profile_generation: generation,
                phase: "clearing".to_string(),
            },
        )
        .await?;
        remove_optional_file(&self.profile_cache_path()).await?;
        for account in [
            MACHINE_SECRET_ACCOUNT,
            MQTT_SIGNING_SECRET_ACCOUNT,
            MQTT_PASSWORD_ACCOUNT,
        ] {
            self.secrets.write_secret(account, "").await?;
        }
        clear_credential_backups(self.secrets.as_ref()).await?;
        remove_optional_file(&self.claim_journal_path()).await?;
        self.clear_refresh_error().await;
        self.generation.store(generation, Ordering::Release);
        Ok(())
    }

    /// A local reset removes every daemon-owned configuration document and
    /// claim credential. The deployment-owned Runtime Bootstrap is never a
    /// reset target.
    pub async fn reset_local_runtime(&self) -> Result<(), String> {
        self.clear_claim().await?;
        self.local_settings.clear().await?;
        remove_optional_file(&self.profile_refresh_state_path()).await?;
        self.clear_refresh_error().await;
        self.generation.fetch_add(1, Ordering::AcqRel);
        Ok(())
    }

    pub async fn effective_projection(
        &self,
    ) -> Result<EffectiveMachineRuntimeConfiguration, String> {
        let bootstrap = self.load_bootstrap().await?;
        let cache = self.load_profile_cache().await?;
        let settings = self.local_settings.load().await?;
        let secrets = self.secrets.status().await?;
        let refresh_error = self.load_refresh_error().await?;
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
            "sourceRevisions": {
                "bootstrapSchemaVersion": bootstrap.schema_version,
                "profile": cache.as_ref().map(|cache| json!({
                    "generation": cache.generation,
                    "profileRevision": cache.profile.metadata.profile_revision,
                    "acceptedAt": cache.accepted_at,
                })),
                "localSettingsRevision": settings.revision,
            },
            "sourceDocuments": {
                "bootstrap": bootstrap,
                "profileCache": cache,
            },
            "machine": cache.as_ref().map(|cache| &cache.profile.machine),
            "platform": cache.as_ref().map(|cache| json!({
                "apiBaseUrl": cache.profile.api_base_url,
                "runtimeEndpoints": cache.profile.runtime_endpoints,
                "mqttConnection": cache.profile.mqtt_connection,
                "paymentCapability": cache.profile.payment_capability,
            })),
            "hardware": {
                "model": bootstrap.hardware_model,
                "topology": bootstrap.topology,
                "expectedProfile": cache.as_ref().map(|cache| &cache.profile.hardware_profile),
                "lowerControllerBinding": settings.lower_controller_binding,
                "scannerBinding": settings.scanner_binding,
                "scannerProtocol": settings.scanner_protocol,
            },
            "experience": { "audio": settings.audio },
            "profileRefresh": { "status": status, "lastError": refresh_error },
            "secretStatus": {
                "machineSecretConfigured": secrets.machine_secret_configured,
                "mqttSigningSecretConfigured": secrets.mqtt_signing_secret_configured,
                "mqttPasswordConfigured": secrets.mqtt_password_configured,
            },
        }))
        .map_err(|error| format!("effective runtime configuration contract invalid: {error}"))
    }

    async fn record_refresh_error(&self, error: &str) {
        *self.refresh_error.lock().await = Some(error.to_string());
        let _ = self
            .write_atomic_json(
                &self.profile_refresh_state_path(),
                &ProfileRefreshState {
                    schema_version: 1,
                    last_error: error.to_string(),
                },
            )
            .await;
    }

    async fn load_refresh_error(&self) -> Result<Option<String>, String> {
        if let Some(error) = self.refresh_error.lock().await.clone() {
            return Ok(Some(error));
        }
        let Some(value) = read_optional_json(
            self.profile_refresh_state_path(),
            "provisioning profile refresh state",
        )
        .await?
        else {
            return Ok(None);
        };
        let state: ProfileRefreshState = serde_json::from_value(value)
            .map_err(|error| format!("provisioning profile refresh state invalid: {error}"))?;
        if state.schema_version != 1 || state.last_error.trim().is_empty() {
            return Err("provisioning profile refresh state invalid".to_string());
        }
        *self.refresh_error.lock().await = Some(state.last_error.clone());
        Ok(Some(state.last_error))
    }

    async fn clear_refresh_error(&self) {
        *self.refresh_error.lock().await = None;
        let _ = remove_optional_file(&self.profile_refresh_state_path()).await;
    }

    async fn write_atomic_json<T: serde::Serialize>(
        &self,
        path: &Path,
        value: &T,
    ) -> Result<(), String> {
        let payload = serde_json::to_vec_pretty(value)
            .map_err(|error| format!("serialize provisioning profile cache failed: {error}"))?;
        self.file_writer.write(path, &payload).await
    }

    async fn recover_claim_transaction_locked(&self) -> Result<(), String> {
        let Some(value) =
            read_optional_json(self.claim_journal_path(), "claim transaction").await?
        else {
            return Ok(());
        };
        let journal: ClaimTransactionJournal = serde_json::from_value(value)
            .map_err(|error| format!("claim transaction journal invalid: {error}"))?;
        if journal.schema_version != 1 || !matches!(journal.operation.as_str(), "accept" | "clear")
        {
            return Err("claim transaction journal invalid".to_string());
        }
        if journal.operation == "accept" {
            let complete = self
                .load_profile_cache()
                .await?
                .is_some_and(|cache| cache.generation.get() == journal.profile_generation)
                && self.secrets.status().await?.machine_secret_configured
                && self.secrets.status().await?.mqtt_signing_secret_configured;
            if complete {
                clear_credential_backups(self.secrets.as_ref()).await?;
                remove_optional_file(&self.claim_journal_path()).await?;
                self.generation.store(journal.generation, Ordering::Release);
                return Ok(());
            }
            if journal.phase == "credentials_replacing" {
                if !credential_backups_ready(self.secrets.as_ref()).await? {
                    remove_optional_file(&self.claim_journal_path()).await?;
                    self.record_refresh_error(
                        "profile replacement journal had no durable credential backups; retained current credentials",
                    )
                    .await;
                    self.generation.store(journal.generation, Ordering::Release);
                    return Ok(());
                }
                restore_credentials_from_backups(self.secrets.as_ref()).await?;
                clear_credential_backups(self.secrets.as_ref()).await?;
                remove_optional_file(&self.claim_journal_path()).await?;
                self.record_refresh_error("profile replacement recovered after interruption")
                    .await;
                self.generation.store(journal.generation, Ordering::Release);
                return Ok(());
            }
        }
        remove_optional_file(&self.profile_cache_path()).await?;
        for account in [
            MACHINE_SECRET_ACCOUNT,
            MQTT_SIGNING_SECRET_ACCOUNT,
            MQTT_PASSWORD_ACCOUNT,
        ] {
            self.secrets.write_secret(account, "").await?;
        }
        clear_credential_backups(self.secrets.as_ref()).await?;
        remove_optional_file(&self.claim_journal_path()).await?;
        self.record_refresh_error("claim transaction recovered after interruption")
            .await;
        self.generation.store(journal.generation, Ordering::Release);
        Ok(())
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

pub(crate) async fn remove_optional_file(path: &Path) -> Result<(), String> {
    if !fs::try_exists(path)
        .await
        .map_err(|error| format!("inspect {} failed: {error}", path.display()))?
    {
        return Ok(());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "runtime configuration path has no parent".to_string())?;
    let directory_sync = crate::platform_fs::prepare_directory_sync(parent)
        .await
        .map_err(|error| format!("prepare runtime configuration directory sync failed: {error}"))?;
    match fs::remove_file(path).await {
        Ok(()) => directory_sync.sync().await.map_err(|error| {
            format!(
                "removed {} but could not durably sync its parent directory: {error}",
                path.display()
            )
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("remove {} failed: {error}", path.display())),
    }
}

pub(crate) async fn write_atomic_bytes(path: &Path, payload: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "runtime configuration path has no parent".to_string())?;
    fs::create_dir_all(parent)
        .await
        .map_err(|error| format!("create runtime configuration dir failed: {error}"))?;
    let directory_sync = crate::platform_fs::prepare_directory_sync(parent)
        .await
        .map_err(|error| format!("prepare runtime configuration directory sync failed: {error}"))?;
    let staged = path.with_extension("json.tmp");
    let mut file = fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&staged)
        .await
        .map_err(|error| format!("stage runtime configuration failed: {error}"))?;
    file.write_all(&payload)
        .await
        .map_err(|error| format!("stage runtime configuration failed: {error}"))?;
    file.sync_all()
        .await
        .map_err(|error| format!("sync runtime configuration failed: {error}"))?;
    drop(file);
    fs::rename(&staged, path)
        .await
        .map_err(|error| format!("commit runtime configuration failed: {error}"))?;
    directory_sync.sync().await.map_err(|error| {
        format!(
            "committed runtime configuration at {} but could not durably sync its parent directory: {error}",
            path.display()
        )
    })
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

const CREDENTIAL_ROLLBACK_ACCOUNTS: [(&str, &str); 3] = [
    (MACHINE_SECRET_ACCOUNT, MACHINE_SECRET_ROLLBACK_ACCOUNT),
    (
        MQTT_SIGNING_SECRET_ACCOUNT,
        MQTT_SIGNING_SECRET_ROLLBACK_ACCOUNT,
    ),
    (MQTT_PASSWORD_ACCOUNT, MQTT_PASSWORD_ROLLBACK_ACCOUNT),
];

async fn write_credential_backups(
    store: &dyn SecretStore,
    values: &[(&str, Option<String>)],
) -> Result<(), String> {
    for (account, backup) in CREDENTIAL_ROLLBACK_ACCOUNTS {
        let value = values
            .iter()
            .find(|(name, _)| *name == account)
            .map(|(_, value)| value)
            .ok_or_else(|| "credential rollback source missing".to_string())?;
        store
            .write_secret(backup, value.as_deref().unwrap_or(""))
            .await
            .map_err(|error| format!("persist credential rollback copy failed: {error}"))?;
    }
    store
        .write_secret(crate::secret::CREDENTIAL_ROLLBACK_READY_ACCOUNT, "ready")
        .await
        .map_err(|error| format!("persist credential rollback marker failed: {error}"))?;
    Ok(())
}

async fn credential_backups_ready(store: &dyn SecretStore) -> Result<bool, String> {
    Ok(store
        .read_secret(crate::secret::CREDENTIAL_ROLLBACK_READY_ACCOUNT)
        .await?
        .as_deref()
        == Some("ready"))
}

async fn restore_credentials_from_backups(store: &dyn SecretStore) -> Result<(), String> {
    for (account, backup) in CREDENTIAL_ROLLBACK_ACCOUNTS {
        let value = store
            .read_secret(backup)
            .await
            .map_err(|error| format!("read credential rollback copy failed: {error}"))?;
        store
            .write_secret(account, value.as_deref().unwrap_or(""))
            .await
            .map_err(|error| format!("restore credential rollback copy failed: {error}"))?;
    }
    Ok(())
}

async fn clear_credential_backups(store: &dyn SecretStore) -> Result<(), String> {
    for (_, backup) in CREDENTIAL_ROLLBACK_ACCOUNTS {
        store
            .write_secret(backup, "")
            .await
            .map_err(|error| format!("clear credential rollback copy failed: {error}"))?;
    }
    store
        .write_secret(crate::secret::CREDENTIAL_ROLLBACK_READY_ACCOUNT, "")
        .await
        .map_err(|error| format!("clear credential rollback marker failed: {error}"))?;
    Ok(())
}

fn profile_cache_from_claim(
    profile: &MachineProvisioningProfile,
    generation: u64,
) -> Result<ProvisioningProfileCache, String> {
    if profile.metadata.profile_version != 1.0
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
        "generation": generation,
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
            "hardwareModel": profile.hardware_model,
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

fn profile_cache_from_snapshot(
    profile: &daemon_ipc_contracts::MachineProvisioningProfileSnapshot,
    generation: u64,
) -> Result<ProvisioningProfileCache, String> {
    serde_json::from_value(json!({
        "schemaVersion": 1,
        "generation": generation,
        "acceptedAt": chrono::Utc::now().to_rfc3339(),
        "profile": profile,
    }))
    .map_err(|error| format!("provisioning profile refresh contract invalid: {error}"))
}
