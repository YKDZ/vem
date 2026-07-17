use std::{
    path::Path,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
};

use async_trait::async_trait;
use vending_daemon::{
    runtime_configuration::{CleanRuntimeConfigurationStore, RuntimeConfigurationFileWriter},
    secret::InMemorySecretStore,
};

struct FailOnWrite {
    failing_write: usize,
    writes: AtomicUsize,
}

#[async_trait]
impl RuntimeConfigurationFileWriter for FailOnWrite {
    async fn write(&self, path: &Path, payload: &[u8]) -> Result<(), String> {
        let write = self.writes.fetch_add(1, Ordering::SeqCst) + 1;
        if write == self.failing_write {
            return Err("injected profile cache disk write failure".to_string());
        }
        let parent = path
            .parent()
            .ok_or_else(|| "profile cache path has no parent".to_string())?;
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| format!("create profile cache dir failed: {error}"))?;
        tokio::fs::write(path, payload)
            .await
            .map_err(|error| format!("write profile cache failed: {error}"))
    }
}

#[tokio::test]
async fn clean_runtime_bootstrap_rejects_any_legacy_or_environment_field() {
    let temp = tempfile::tempdir().expect("temp");
    let data_dir = temp.path().join("VEM").join("vending-daemon");
    let bootstrap_path = temp.path().join("VEM").join("runtime-bootstrap.json");
    tokio::fs::create_dir_all(bootstrap_path.parent().expect("parent"))
        .await
        .expect("bootstrap directory");
    tokio::fs::write(
        &bootstrap_path,
        r#"{"schemaVersion":1,"provisioningApiBaseUrl":"https://service.example/api","hardwareModel":"vem-prod-24","topology":{"identity":"vem-prod-24","version":"v1"},"environment":"testbed"}"#,
    )
    .await
    .expect("bootstrap");

    let store =
        CleanRuntimeConfigurationStore::new(data_dir, Arc::new(InMemorySecretStore::default()));

    assert!(store.load_bootstrap().await.is_err());
}

#[tokio::test]
async fn rejected_profile_acceptance_retains_the_last_accepted_profile_and_reset_preserves_bootstrap(
) {
    let temp = tempfile::tempdir().expect("temp");
    let data_dir = temp.path().join("VEM").join("vending-daemon");
    let bootstrap_path = temp.path().join("VEM").join("runtime-bootstrap.json");
    tokio::fs::create_dir_all(bootstrap_path.parent().expect("parent"))
        .await
        .expect("bootstrap directory");
    tokio::fs::write(
        &bootstrap_path,
        r#"{"schemaVersion":1,"provisioningApiBaseUrl":"https://service.example/api","hardwareModel":"vem-prod-24","topology":{"identity":"vem-prod-24","version":"v1"}}"#,
    )
    .await
    .expect("bootstrap");

    let secrets = Arc::new(InMemorySecretStore::default());
    let store = CleanRuntimeConfigurationStore::new(data_dir, secrets.clone());
    let accepted = valid_profile();
    store
        .accept_profile(&accepted)
        .await
        .expect("accepted profile");

    let persisted = tokio::fs::read_to_string(store.profile_cache_path())
        .await
        .expect("profile cache");
    let accepted_machine_secret = accepted.credentials.machine_secret.to_string();
    assert!(!persisted.contains(&accepted_machine_secret));
    assert_eq!(
        vending_daemon::secret::SecretStore::read_secret(
            secrets.as_ref(),
            vending_daemon::secret::MACHINE_SECRET_ACCOUNT,
        )
        .await
        .expect("machine secret"),
        Some(accepted.credentials.machine_secret.to_string())
    );

    let mut invalid = accepted.clone();
    invalid.hardware_profile.controller.required = false;
    assert!(store.accept_profile(&invalid).await.is_err());
    let retained = store.load_profile_cache().await.expect("profile cache");
    assert_eq!(
        retained
            .expect("accepted cache")
            .profile
            .machine
            .code
            .to_string(),
        "VEM-TEST-01"
    );
    let projection = store.effective_projection().await.expect("projection");
    assert_eq!(projection.profile_refresh.status.to_string(), "degraded");
    assert_eq!(
        projection.profile_refresh.last_error.as_deref(),
        Some("profile contract was rejected")
    );

    let restarted = CleanRuntimeConfigurationStore::new(
        store
            .profile_cache_path()
            .parent()
            .expect("config dir")
            .parent()
            .expect("data dir")
            .to_path_buf(),
        secrets.clone(),
    );
    assert_eq!(
        restarted
            .effective_projection()
            .await
            .expect("projection after restart")
            .profile_refresh
            .status
            .to_string(),
        "degraded"
    );

    tokio::fs::create_dir_all(
        store
            .profile_cache_path()
            .parent()
            .expect("settings parent"),
    )
    .await
    .expect("settings parent");
    tokio::fs::write(
        store
            .profile_cache_path()
            .parent()
            .expect("settings parent")
            .join("local-settings.json"),
        r#"{"schemaVersion":1,"revision":1,"lowerControllerBinding":null,"scannerBinding":null,"scannerProtocol":null,"audio":{"volume":0.7,"cuesEnabled":false,"presenceCuesEnabled":false,"transactionCuesEnabled":false}}"#,
    )
    .await
    .expect("local settings");

    store.reset_local_runtime().await.expect("local reset");
    assert!(store
        .load_profile_cache()
        .await
        .expect("profile cache")
        .is_none());
    assert!(tokio::fs::try_exists(bootstrap_path)
        .await
        .expect("bootstrap exists"));
    assert!(!tokio::fs::try_exists(
        store
            .profile_cache_path()
            .parent()
            .expect("settings parent")
            .join("local-settings.json"),
    )
    .await
    .expect("local settings removed"));
    assert!(vending_daemon::secret::SecretStore::read_secret(
        secrets.as_ref(),
        vending_daemon::secret::MACHINE_SECRET_ACCOUNT,
    )
    .await
    .expect("machine secret cleared")
    .is_none());
}

#[tokio::test]
async fn profile_cache_write_failure_retains_last_known_good_and_records_degraded_refresh() {
    let temp = tempfile::tempdir().expect("temp");
    let data_dir = temp.path().join("VEM").join("vending-daemon");
    let bootstrap_path = temp.path().join("VEM").join("runtime-bootstrap.json");
    tokio::fs::create_dir_all(bootstrap_path.parent().expect("parent"))
        .await
        .expect("bootstrap directory");
    tokio::fs::write(
        &bootstrap_path,
        r#"{"schemaVersion":1,"provisioningApiBaseUrl":"https://service.example/api","hardwareModel":"vem-prod-24","topology":{"identity":"vem-prod-24","version":"v1"}}"#,
    )
    .await
    .expect("bootstrap");

    let secrets = Arc::new(InMemorySecretStore::default());
    let store = CleanRuntimeConfigurationStore::with_file_writer(
        data_dir,
        secrets.clone(),
        Arc::new(FailOnWrite {
            failing_write: 4,
            writes: AtomicUsize::new(0),
        }),
    );
    let accepted = valid_profile();
    store
        .accept_profile(&accepted)
        .await
        .expect("initial accepted profile");

    let mut replacement = accepted.clone();
    replacement.metadata.profile_revision = std::num::NonZeroU64::new(2).expect("revision");
    assert!(store.accept_profile(&replacement).await.is_err());

    assert_eq!(
        store
            .load_profile_cache()
            .await
            .expect("profile cache")
            .expect("last known good cache")
            .profile
            .metadata
            .profile_revision,
        std::num::NonZeroU64::new(1).expect("revision")
    );
    assert_eq!(
        vending_daemon::secret::SecretStore::read_secret(
            secrets.as_ref(),
            vending_daemon::secret::MACHINE_SECRET_ACCOUNT,
        )
        .await
        .expect("machine secret"),
        Some(accepted.credentials.machine_secret.to_string())
    );
    let projection = store.effective_projection().await.expect("projection");
    assert_eq!(projection.profile_refresh.status.to_string(), "degraded");
    assert_eq!(
        projection.profile_refresh.last_error.as_deref(),
        Some("profile cache was not accepted")
    );
}

#[tokio::test]
async fn profile_acceptance_recovers_an_interrupted_generation_without_mixing_credentials() {
    let temp = tempfile::tempdir().expect("temp");
    let data_dir = temp.path().join("VEM").join("vending-daemon");
    let bootstrap_path = temp.path().join("VEM").join("runtime-bootstrap.json");
    tokio::fs::create_dir_all(bootstrap_path.parent().expect("parent"))
        .await
        .expect("bootstrap directory");
    tokio::fs::write(
        &bootstrap_path,
        r#"{"schemaVersion":1,"provisioningApiBaseUrl":"https://service.example/api","hardwareModel":"vem-prod-24","topology":{"identity":"vem-prod-24","version":"v1"}}"#,
    )
    .await
    .expect("bootstrap");

    let secrets = Arc::new(InMemorySecretStore::default());
    let store = CleanRuntimeConfigurationStore::new(data_dir.clone(), secrets.clone());
    store
        .accept_profile(&valid_profile())
        .await
        .expect("accepted");

    tokio::fs::write(
        store.claim_journal_path(),
        r#"{"schemaVersion":1,"operation":"accept","generation":2,"profileGeneration":2}"#,
    )
    .await
    .expect("interrupted journal");
    vending_daemon::secret::SecretStore::write_secret(
        secrets.as_ref(),
        vending_daemon::secret::MACHINE_SECRET_ACCOUNT,
        "new-secret-without-a-matching-profile",
    )
    .await
    .expect("interrupted credential");

    let restarted = CleanRuntimeConfigurationStore::new(data_dir, secrets.clone());
    restarted
        .recover_claim_transaction()
        .await
        .expect("recover");

    assert!(restarted
        .load_profile_cache()
        .await
        .expect("cache")
        .is_none());
    assert!(vending_daemon::secret::SecretStore::read_secret(
        secrets.as_ref(),
        vending_daemon::secret::MACHINE_SECRET_ACCOUNT,
    )
    .await
    .expect("secret")
    .is_none());
    assert!(!tokio::fs::try_exists(restarted.claim_journal_path())
        .await
        .expect("journal exists"));
}

#[tokio::test]
async fn interrupted_profile_replacement_restores_the_last_known_good_claim() {
    let temp = tempfile::tempdir().expect("temp");
    let data_dir = temp.path().join("VEM").join("vending-daemon");
    let bootstrap_path = temp.path().join("VEM").join("runtime-bootstrap.json");
    tokio::fs::create_dir_all(bootstrap_path.parent().expect("parent"))
        .await
        .expect("bootstrap directory");
    tokio::fs::write(
        &bootstrap_path,
        r#"{"schemaVersion":1,"provisioningApiBaseUrl":"https://service.example/api","hardwareModel":"vem-prod-24","topology":{"identity":"vem-prod-24","version":"v1"}}"#,
    )
    .await
    .expect("bootstrap");

    let secrets = Arc::new(InMemorySecretStore::default());
    let store = CleanRuntimeConfigurationStore::new(data_dir.clone(), secrets.clone());
    let accepted = valid_profile();
    store.accept_profile(&accepted).await.expect("accepted");

    vending_daemon::secret::SecretStore::write_secret(
        secrets.as_ref(),
        vending_daemon::secret::MACHINE_SECRET_ROLLBACK_ACCOUNT,
        &accepted.credentials.machine_secret,
    )
    .await
    .expect("rollback machine secret");
    vending_daemon::secret::SecretStore::write_secret(
        secrets.as_ref(),
        vending_daemon::secret::MQTT_SIGNING_SECRET_ROLLBACK_ACCOUNT,
        &accepted.credentials.mqtt_signing_secret,
    )
    .await
    .expect("rollback signing secret");
    vending_daemon::secret::SecretStore::write_secret(
        secrets.as_ref(),
        vending_daemon::secret::MQTT_PASSWORD_ROLLBACK_ACCOUNT,
        accepted
            .credentials
            .mqtt_connection
            .password
            .as_deref()
            .expect("mqtt password"),
    )
    .await
    .expect("rollback mqtt password");
    vending_daemon::secret::SecretStore::write_secret(
        secrets.as_ref(),
        vending_daemon::secret::CREDENTIAL_ROLLBACK_READY_ACCOUNT,
        "ready",
    )
    .await
    .expect("rollback marker");
    vending_daemon::secret::SecretStore::write_secret(
        secrets.as_ref(),
        vending_daemon::secret::MACHINE_SECRET_ACCOUNT,
        "replacement-secret-without-new-cache",
    )
    .await
    .expect("replacement machine secret");
    tokio::fs::write(
        store.claim_journal_path(),
        r#"{"schemaVersion":1,"operation":"accept","generation":2,"profileGeneration":2,"phase":"credentials_replacing"}"#,
    )
    .await
    .expect("interrupted journal");

    let restarted = CleanRuntimeConfigurationStore::new(data_dir, secrets.clone());
    restarted
        .recover_claim_transaction()
        .await
        .expect("recover replacement");

    assert_eq!(
        restarted
            .load_profile_cache()
            .await
            .expect("profile cache")
            .expect("last known good cache")
            .profile
            .machine
            .code
            .to_string(),
        "VEM-TEST-01"
    );
    assert_eq!(
        vending_daemon::secret::SecretStore::read_secret(
            secrets.as_ref(),
            vending_daemon::secret::MACHINE_SECRET_ACCOUNT,
        )
        .await
        .expect("machine secret"),
        Some(accepted.credentials.machine_secret.to_string())
    );
}

#[tokio::test]
async fn replacement_journal_without_durable_backups_preserves_current_claim_and_credentials() {
    let temp = tempfile::tempdir().expect("temp");
    let data_dir = temp.path().join("VEM").join("vending-daemon");
    let bootstrap_path = temp.path().join("VEM").join("runtime-bootstrap.json");
    tokio::fs::create_dir_all(bootstrap_path.parent().expect("parent"))
        .await
        .expect("bootstrap directory");
    tokio::fs::write(
        &bootstrap_path,
        r#"{"schemaVersion":1,"provisioningApiBaseUrl":"https://service.example/api","hardwareModel":"vem-prod-24","topology":{"identity":"vem-prod-24","version":"v1"}}"#,
    )
    .await
    .expect("bootstrap");

    let secrets = Arc::new(InMemorySecretStore::default());
    let store = CleanRuntimeConfigurationStore::new(data_dir.clone(), secrets.clone());
    store
        .accept_profile(&valid_profile())
        .await
        .expect("accepted");
    vending_daemon::secret::SecretStore::write_secret(
        secrets.as_ref(),
        vending_daemon::secret::MACHINE_SECRET_ACCOUNT,
        "replacement-secret-without-durable-backups",
    )
    .await
    .expect("replacement secret");
    tokio::fs::write(
        store.claim_journal_path(),
        r#"{"schemaVersion":1,"operation":"accept","generation":2,"profileGeneration":2,"phase":"credentials_replacing"}"#,
    )
    .await
    .expect("journal");

    let restarted = CleanRuntimeConfigurationStore::new(data_dir, secrets.clone());
    restarted
        .recover_claim_transaction()
        .await
        .expect("recover without backups");

    assert!(restarted
        .load_profile_cache()
        .await
        .expect("cache")
        .is_some());
    assert_eq!(
        vending_daemon::secret::SecretStore::read_secret(
            secrets.as_ref(),
            vending_daemon::secret::MACHINE_SECRET_ACCOUNT,
        )
        .await
        .expect("secret"),
        Some("replacement-secret-without-durable-backups".to_string())
    );
    assert_eq!(
        restarted
            .effective_projection()
            .await
            .expect("projection")
            .profile_refresh
            .status
            .to_string(),
        "degraded"
    );
}

#[tokio::test]
async fn profile_refresh_accepts_a_changed_content_revision_regardless_of_numeric_order() {
    let temp = tempfile::tempdir().expect("temp");
    let data_dir = temp.path().join("VEM").join("vending-daemon");
    let bootstrap_path = temp.path().join("VEM").join("runtime-bootstrap.json");
    tokio::fs::create_dir_all(bootstrap_path.parent().expect("parent"))
        .await
        .expect("bootstrap directory");
    tokio::fs::write(
        &bootstrap_path,
        r#"{"schemaVersion":1,"provisioningApiBaseUrl":"https://service.example/api","hardwareModel":"vem-prod-24","topology":{"identity":"vem-prod-24","version":"v1"}}"#,
    )
    .await
    .expect("bootstrap");
    let store =
        CleanRuntimeConfigurationStore::new(data_dir, Arc::new(InMemorySecretStore::default()));
    let mut newest = valid_profile();
    newest.metadata.profile_revision = std::num::NonZeroU64::new(2).expect("revision");
    store.accept_profile(&newest).await.expect("newest profile");

    let mut refreshed = serde_json::to_value(valid_profile()).expect("profile json");
    let credentials = refreshed
        .as_object_mut()
        .expect("profile object")
        .remove("credentials")
        .expect("credentials");
    refreshed.as_object_mut().expect("profile object").insert(
        "mqttConnection".to_string(),
        serde_json::json!({
            "url": credentials["mqttConnection"]["url"],
            "clientId": credentials["mqttConnection"]["clientId"],
            "username": credentials["mqttConnection"]["username"],
        }),
    );
    refreshed["machine"]["name"] = serde_json::json!("Reconfigured machine");
    refreshed["metadata"]["profileRevision"] = serde_json::json!(1);
    let refreshed: daemon_ipc_contracts::MachineProvisioningProfileSnapshot =
        serde_json::from_value(refreshed).expect("refresh snapshot");

    let applied = store
        .accept_refreshed_profile(&refreshed)
        .await
        .expect("changed profile accepted")
        .expect("new cache");
    assert_eq!(
        applied.profile.machine.name.to_string(),
        "Reconfigured machine"
    );
    let mut stale_facts = serde_json::to_value(&refreshed).expect("refresh snapshot json");
    stale_facts["apiBaseUrl"] = serde_json::json!("https://platform-next.example/api");
    stale_facts["hardwareSlotTopology"]["version"] = serde_json::json!("v2");
    let stale_facts: daemon_ipc_contracts::MachineProvisioningProfileSnapshot =
        serde_json::from_value(stale_facts).expect("changed snapshot");
    let error = store
        .accept_refreshed_profile(&stale_facts)
        .await
        .expect_err("changed endpoint and hardware require a new revision");
    assert!(error.contains("changed without a newer revision"));
    assert_eq!(
        store
            .load_profile_cache()
            .await
            .expect("cache")
            .expect("accepted cache")
            .profile
            .metadata
            .profile_revision,
        std::num::NonZeroU64::new(1).expect("revision")
    );
}

fn valid_profile() -> vending_daemon::provisioning::MachineProvisioningProfile {
    serde_json::from_value(serde_json::json!({
        "machine": {
            "id": "550e8400-e29b-41d4-a716-446655440001",
            "code": "VEM-TEST-01",
            "name": "Test machine",
            "status": "offline",
            "locationLabel": "Lab"
        },
        "credentials": {
            "machineSecret": "m".repeat(32),
            "machineSecretVersion": 1,
            "mqttSigningSecret": "s".repeat(32),
            "mqttConnection": {
                "url": "mqtt://service.example:1883",
                "clientId": "vem-machine-VEM-TEST-01",
                "username": "machine",
                "password": "mqtt-password"
            }
        },
        "apiBaseUrl": "https://service.example/api",
        "runtimeEndpoints": {
            "apiBasePath": "/api",
            "machineAuthTokenPath": "/api/machine-auth/token",
            "machineApiBasePath": "/api/machines/VEM-TEST-01",
            "mqttTopicPrefix": "vem/machines/VEM-TEST-01"
        },
        "hardwareProfile": {
            "profile": "production",
            "controller": { "required": true, "protocol": "vem-vending-controller" },
            "paymentScanner": { "required": true, "supportsPaymentCode": true },
            "vision": { "required": false, "supportsRecommendations": true }
        },
        "hardwareModel": "vem-prod-24",
        "hardwareSlotTopology": { "identity": "vem-prod-24", "version": "v1" },
        "paymentCapability": {
            "profile": "production",
            "qrCodeEnabled": true,
            "paymentCodeEnabled": true,
            "serverTime": "2026-07-17T00:00:00.000Z"
        },
        "metadata": {
            "profileVersion": 1,
            "profileRevision": 1,
            "claimCodeId": "550e8400-e29b-41d4-a716-446655440002",
            "claimedAt": "2026-07-17T00:00:00.000Z",
            "serverTime": "2026-07-17T00:00:00.000Z"
        }
    }))
    .expect("valid profile")
}
