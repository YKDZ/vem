use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::secret::{
    ProtectedLocalSecretStore, SecretStore, MACHINE_MAINTENANCE_LIFECYCLE_ACCOUNT,
    MACHINE_WIREGUARD_PENDING_PRIVATE_KEY_ACCOUNT, MACHINE_WIREGUARD_PRIVATE_KEY_ACCOUNT,
};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FactoryPreparationMode {
    CheckCleanHost,
    ResetLocalRuntime,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LocalRuntimeEvidenceStatus {
    Clean,
    Dirty,
    Reset,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalRuntimeEvidenceItem {
    pub category: String,
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalRuntimeResetEvidence {
    pub status: LocalRuntimeEvidenceStatus,
    pub data_dir: String,
    pub runtime_root: String,
    pub found: Vec<LocalRuntimeEvidenceItem>,
    pub cleared: Vec<LocalRuntimeEvidenceItem>,
    pub preserved: Vec<LocalRuntimeEvidenceItem>,
    pub skipped: Vec<LocalRuntimeEvidenceItem>,
}

#[derive(Debug, thiserror::Error)]
pub enum FactoryPreparationError {
    #[error("old local VEM runtime state detected")]
    DirtyHost {
        evidence: Box<LocalRuntimeResetEvidence>,
    },
    #[error("{0}")]
    Io(String),
}

struct RuntimeLayout {
    runtime_root: PathBuf,
    data_dir: PathBuf,
    factory_dir: PathBuf,
    bringup_dir: PathBuf,
    provisioning_dir: PathBuf,
    runtime_secrets_dir: PathBuf,
    file_secrets_dir: PathBuf,
    evidence_dir: PathBuf,
    runtime_bootstrap_path: PathBuf,
}

impl RuntimeLayout {
    fn from_data_dir(data_dir: &Path) -> Self {
        let data_dir = data_dir.to_path_buf();
        let runtime_root = data_dir
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| data_dir.clone());
        Self {
            factory_dir: runtime_root.join("factory"),
            bringup_dir: runtime_root.join("bringup"),
            provisioning_dir: runtime_root.join("provisioning"),
            runtime_secrets_dir: runtime_root.join("secrets"),
            file_secrets_dir: data_dir.join("secrets"),
            evidence_dir: runtime_root.join("evidence"),
            runtime_bootstrap_path: runtime_root.join("runtime-bootstrap.json"),
            runtime_root,
            data_dir,
        }
    }
}

pub async fn prepare_factory_runtime(
    data_dir: &Path,
    mode: FactoryPreparationMode,
) -> Result<LocalRuntimeResetEvidence, FactoryPreparationError> {
    let layout = RuntimeLayout::from_data_dir(data_dir);
    let mut evidence = inspect_local_runtime(&layout).await?;
    if mode == FactoryPreparationMode::CheckCleanHost && !evidence.found.is_empty() {
        return Err(FactoryPreparationError::DirtyHost {
            evidence: Box::new(evidence),
        });
    }
    if mode == FactoryPreparationMode::ResetLocalRuntime {
        clear_local_runtime(&layout).await?;
        evidence.status = LocalRuntimeEvidenceStatus::Reset;
        evidence.cleared = evidence.found.clone();
    }
    Ok(evidence)
}

async fn inspect_local_runtime(
    layout: &RuntimeLayout,
) -> Result<LocalRuntimeResetEvidence, FactoryPreparationError> {
    let mut found = Vec::new();
    detect_local_machine_identity(layout, &mut found).await?;
    detect_file(
        &layout.provisioning_dir.join("profile-cache-summary.json"),
        "provisioning_profile_cache",
        "provisioning profile cache exists",
        &mut found,
    )
    .await?;
    detect_file(
        &layout.data_dir.join("config").join("profile-cache.json"),
        "provisioning_profile_cache",
        "accepted provisioning profile cache exists",
        &mut found,
    )
    .await?;
    detect_non_empty_dir(
        &layout.runtime_secrets_dir,
        "protected_secret_material",
        "protected local secret material exists",
        &mut found,
    )
    .await?;
    detect_non_empty_dir(
        &layout.file_secrets_dir,
        "protected_secret_material",
        "protected local secret material exists",
        &mut found,
    )
    .await?;
    detect_daemon_state(layout, &mut found).await?;
    detect_non_empty_dir(
        &layout.evidence_dir,
        "prior_evidence",
        "prior local runtime evidence exists",
        &mut found,
    )
    .await?;
    detect_non_empty_dir(
        &layout.bringup_dir,
        "local_bring_up_settings",
        "local bring-up settings exist",
        &mut found,
    )
    .await?;

    let status = if found.is_empty() {
        LocalRuntimeEvidenceStatus::Clean
    } else {
        LocalRuntimeEvidenceStatus::Dirty
    };
    Ok(LocalRuntimeResetEvidence {
        status,
        data_dir: path_string(&layout.data_dir),
        runtime_root: path_string(&layout.runtime_root),
        found,
        cleared: Vec::new(),
        preserved: vec![
        item(
            "runtime_bootstrap",
            &layout.runtime_bootstrap_path,
            "deployment-written Runtime Bootstrap is preserved across local runtime reset",
        ),
        item(
            "factory_manifest",
            &layout.factory_dir,
            "factory manifest directory is not local machine state",
        ),
        item(
            "machine_maintenance_identity",
            &layout.runtime_secrets_dir.join("machine_wireguard_private_key.dpapi"),
            "the DPAPI-protected Machine Maintenance Identity key is preserved across local runtime reset",
        ),
        text_item(
            "machine_maintenance_tunnel",
            r"C:/Program Files/WireGuard/Data/Configurations/VEM-Maintenance.conf.dpapi",
            "the stable VEM-Maintenance tunnel configuration is outside local runtime reset",
        )],
        skipped: vec![
            item(
                "platform_business_data",
                &layout.runtime_root,
                "platform machines, orders, inventory, payments, planograms, and audit records are outside local runtime reset",
            ),
            text_item(
                "keyring_secret_material",
                &format!("keyring://{}", crate::secret::KEYRING_SERVICE),
                "keyring-backed secret status is unknown and is not cleared by local filesystem reset",
            ),
        ],
    })
}

async fn detect_local_machine_identity(
    layout: &RuntimeLayout,
    found: &mut Vec<LocalRuntimeEvidenceItem>,
) -> Result<(), FactoryPreparationError> {
    let path = layout.data_dir.join("machine-config.json");
    if !path_exists(&path).await? {
        return Ok(());
    }
    let content = tokio::fs::read_to_string(&path).await.map_err(|error| {
        FactoryPreparationError::Io(format!("read machine config failed: {error}"))
    })?;
    let value: serde_json::Value =
        serde_json::from_str(&content).unwrap_or(serde_json::Value::Null);
    let has_identity = ["machineCode", "machineId"].iter().any(|field| {
        value
            .get(field)
            .and_then(serde_json::Value::as_str)
            .is_some_and(|value| !value.trim().is_empty())
    });
    if has_identity {
        found.push(item(
            "local_machine_identity",
            &path,
            "daemon machine config contains local machine identity",
        ));
    }
    Ok(())
}

async fn detect_daemon_state(
    layout: &RuntimeLayout,
    found: &mut Vec<LocalRuntimeEvidenceItem>,
) -> Result<(), FactoryPreparationError> {
    for relative in [
        "state.db",
        "state.db-shm",
        "state.db-wal",
        "ipc-token",
        "daemon-ready.json",
        "logs",
    ] {
        let path = layout.data_dir.join(relative);
        if path_exists(&path).await? {
            found.push(item(
                "daemon_state",
                &path,
                "daemon-owned runtime state exists",
            ));
            return Ok(());
        }
    }
    Ok(())
}

async fn detect_file(
    path: &Path,
    category: &str,
    reason: &str,
    found: &mut Vec<LocalRuntimeEvidenceItem>,
) -> Result<(), FactoryPreparationError> {
    if path_exists(path).await? {
        found.push(item(category, path, reason));
    }
    Ok(())
}

async fn detect_non_empty_dir(
    path: &Path,
    category: &str,
    reason: &str,
    found: &mut Vec<LocalRuntimeEvidenceItem>,
) -> Result<(), FactoryPreparationError> {
    if !path_exists(path).await? {
        return Ok(());
    }
    let mut entries = tokio::fs::read_dir(path)
        .await
        .map_err(|error| FactoryPreparationError::Io(format!("read dir failed: {error}")))?;
    if entries
        .next_entry()
        .await
        .map_err(|error| FactoryPreparationError::Io(format!("read dir entry failed: {error}")))?
        .is_some()
    {
        found.push(item(category, path, reason));
    }
    Ok(())
}

async fn path_exists(path: &Path) -> Result<bool, FactoryPreparationError> {
    tokio::fs::try_exists(path)
        .await
        .map_err(|error| FactoryPreparationError::Io(format!("inspect path failed: {error}")))
}

async fn clear_local_runtime(layout: &RuntimeLayout) -> Result<(), FactoryPreparationError> {
    let protected_secrets = ProtectedLocalSecretStore::new(layout.data_dir.clone());
    let preserved_secrets = read_maintenance_secrets(&protected_secrets).await?;
    for path in [
        &layout.data_dir,
        &layout.provisioning_dir,
        &layout.runtime_secrets_dir,
        &layout.evidence_dir,
        &layout.bringup_dir,
    ] {
        remove_path_if_exists(path).await?;
    }
    for (account, value) in preserved_secrets {
        protected_secrets
            .write_secret(account, &value)
            .await
            .map_err(|error| {
                FactoryPreparationError::Io(format!(
                    "restore preserved maintenance identity failed: {error}"
                ))
            })?;
    }
    Ok(())
}

async fn read_maintenance_secrets(
    secrets: &ProtectedLocalSecretStore,
) -> Result<Vec<(&'static str, String)>, FactoryPreparationError> {
    let mut preserved = Vec::new();
    for account in [
        MACHINE_WIREGUARD_PRIVATE_KEY_ACCOUNT,
        MACHINE_WIREGUARD_PENDING_PRIVATE_KEY_ACCOUNT,
        MACHINE_MAINTENANCE_LIFECYCLE_ACCOUNT,
    ] {
        if let Some(value) = secrets.read_secret(account).await.map_err(|error| {
            FactoryPreparationError::Io(format!(
                "read preserved maintenance identity failed: {error}"
            ))
        })? {
            preserved.push((account, value));
        }
    }
    Ok(preserved)
}

async fn remove_path_if_exists(path: &Path) -> Result<(), FactoryPreparationError> {
    let metadata = match tokio::fs::metadata(path).await {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(FactoryPreparationError::Io(format!(
                "inspect reset path failed: {error}"
            )))
        }
    };
    if metadata.is_dir() {
        tokio::fs::remove_dir_all(path)
            .await
            .map_err(|error| FactoryPreparationError::Io(format!("remove dir failed: {error}")))?;
    } else {
        tokio::fs::remove_file(path)
            .await
            .map_err(|error| FactoryPreparationError::Io(format!("remove file failed: {error}")))?;
    }
    Ok(())
}

fn item(category: &str, path: &Path, reason: &str) -> LocalRuntimeEvidenceItem {
    LocalRuntimeEvidenceItem {
        category: category.to_string(),
        path: path_string(path),
        reason: reason.to_string(),
    }
}

fn text_item(category: &str, path: &str, reason: &str) -> LocalRuntimeEvidenceItem {
    LocalRuntimeEvidenceItem {
        category: category.to_string(),
        path: path.to_string(),
        reason: reason.to_string(),
    }
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}
