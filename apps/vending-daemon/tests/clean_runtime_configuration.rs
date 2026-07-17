use std::sync::Arc;

use vending_daemon::{
    runtime_configuration::CleanRuntimeConfigurationStore, secret::InMemorySecretStore,
};

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
async fn invalid_refresh_retains_the_last_accepted_profile_and_reset_preserves_bootstrap() {
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
    assert!(!persisted.contains(&accepted.credentials.machine_secret));
    assert_eq!(
        vending_daemon::secret::SecretStore::read_secret(
            secrets.as_ref(),
            vending_daemon::secret::MACHINE_SECRET_ACCOUNT,
        )
        .await
        .expect("machine secret"),
        Some(accepted.credentials.machine_secret.clone())
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
    assert_eq!(
        store
            .effective_projection()
            .await
            .expect("projection")
            .profile_refresh
            .status
            .to_string(),
        "degraded"
    );

    store.clear_claim().await.expect("local reset");
    assert!(store
        .load_profile_cache()
        .await
        .expect("profile cache")
        .is_none());
    assert!(tokio::fs::try_exists(bootstrap_path)
        .await
        .expect("bootstrap exists"));
    assert!(vending_daemon::secret::SecretStore::read_secret(
        secrets.as_ref(),
        vending_daemon::secret::MACHINE_SECRET_ACCOUNT,
    )
    .await
    .expect("machine secret cleared")
    .is_none());
}

fn valid_profile() -> vending_daemon::config::MachineProvisioningProfile {
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
        "hardwareSlotTopology": { "identity": "vem-prod-24", "version": "v1" },
        "paymentCapability": {
            "profile": "production",
            "qrCodeEnabled": true,
            "paymentCodeEnabled": true,
            "serverTime": "2026-07-17T00:00:00.000Z"
        },
        "provisioningProfile": "testbed",
        "maintenance": {
            "publicKey": "key",
            "tunnelAddress": "10.91.16.10",
            "address": "10.91.16.10/32",
            "endpoint": "relay.example:51820",
            "relay": { "publicKey": "relay", "tunnelAddress": "10.91.0.1", "address": "10.91.0.1/32" },
            "roleRoutes": { "relay": "10.91.0.1/32", "runner": "10.91.1.0/24", "maintainer": "10.91.3.0/24" }
        },
        "metadata": {
            "profileVersion": 1,
            "claimCodeId": "550e8400-e29b-41d4-a716-446655440002",
            "claimedAt": "2026-07-17T00:00:00.000Z",
            "serverTime": "2026-07-17T00:00:00.000Z"
        }
    }))
    .expect("valid profile")
}
