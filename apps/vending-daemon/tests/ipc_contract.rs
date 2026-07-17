mod support;

use reqwest::StatusCode;
use support::process::DaemonHarness;
use tokio_tungstenite::connect_async;
use wiremock::{
    matchers::{body_json, method, path},
    Mock, MockServer, ResponseTemplate,
};

fn claimed_fixture() -> serde_json::Value {
    serde_json::json!({
        "machineCode": "MACHINE-IPC",
        "apiBaseUrl": "http://127.0.0.1:9/api",
        "mqttUrl": "mqtt://127.0.0.1:1883",
        "hardwareModel": "vem-test-24",
        "hardwareSlotTopology": { "identity": "vem-test-24", "version": "2026-07-test" },
        "hardwareProfile": {
            "profile": "production",
            "controller": { "required": true, "protocol": "vem-vending-controller" },
            "paymentScanner": { "required": true, "supportsPaymentCode": true },
            "vision": { "required": false, "supportsRecommendations": false }
        },
        "paymentCapability": {
            "profile": "production",
            "qrCodeEnabled": true,
            "paymentCodeEnabled": true,
            "serverTime": "2026-07-17T00:00:00Z"
        }
    })
}

#[tokio::test]
async fn ipc_exposes_runtime_boundaries_without_legacy_summary_or_maintenance_gate() {
    let mut daemon = DaemonHarness::start(claimed_fixture(), &[], &[])
        .await
        .expect("start daemon");
    let base = daemon.ready.healthz_url.trim_end_matches("/healthz");
    let client = reqwest::Client::new();

    let unauthorized = client
        .get(format!("{base}/v1/runtime-configuration"))
        .send()
        .await
        .expect("unauthorized response");
    assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

    let runtime = daemon.get_json("/v1/runtime-configuration").await;
    assert_eq!(runtime["profileRefresh"]["status"], "accepted");
    assert_eq!(runtime["machine"]["code"], "MACHINE-IPC");
    let runtime_text = runtime.to_string();
    assert!(!runtime_text.contains("machine-secret-for-integration-tests-0001"));
    assert!(!runtime_text.contains("mqtt-signing-secret-for-integration-tests-0001"));

    let summary = client
        .get(format!("{base}/v1/config/summary"))
        .header("Authorization", daemon.bearer())
        .send()
        .await
        .expect("summary response");
    assert_eq!(summary.status(), StatusCode::NOT_FOUND);
    let maintenance = client
        .post(format!("{base}/v1/maintenance/sessions"))
        .header("Authorization", daemon.bearer())
        .send()
        .await
        .expect("maintenance response");
    assert_eq!(maintenance.status(), StatusCode::NOT_FOUND);

    let scanner = client
        .get(format!("{base}/v1/scanner/status"))
        .header("Authorization", daemon.bearer())
        .send()
        .await
        .expect("scanner response");
    assert_eq!(scanner.status(), StatusCode::OK);
    let scanner_contract: daemon_ipc_contracts::ScannerRuntimeStatus =
        scanner.json().await.expect("scanner contract");
    assert_eq!(scanner_contract.adapter, "serial_text");

    let update_audio = client
        .post(format!(
            "{base}/v1/runtime-configuration/intents/audio-preferences"
        ))
        .header("Authorization", daemon.bearer())
        .json(&serde_json::json!({
            "volume": 0.4,
            "cuesEnabled": true,
            "presenceCuesEnabled": true,
            "transactionCuesEnabled": false
        }))
        .send()
        .await
        .expect("audio intent response");
    assert_eq!(update_audio.status(), StatusCode::OK);
    let updated: serde_json::Value = update_audio.json().await.expect("updated runtime");
    assert_eq!(updated["experience"]["audio"]["volume"], 0.4);

    let bad_ws = connect_async(format!(
        "{}/v1/events?token=bad",
        base.replace("http", "ws")
    ))
    .await;
    assert!(bad_ws.is_err());
    daemon.terminate().await;
}

#[tokio::test]
async fn clean_start_claim_uses_bootstrap_and_persists_only_claim_sources() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/machines/claim"))
        .and(body_json(
            serde_json::json!({ "claimCode": "CLAIM-IPC-01" }),
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(claim_profile(&server.uri())))
        .expect(1)
        .mount(&server)
        .await;
    let fixture = serde_json::json!({
        "machineCode": null,
        "apiBaseUrl": server.uri(),
        "hardwareModel": "vem-test-24",
        "hardwareSlotTopology": { "identity": "vem-test-24", "version": "2026-07-test" }
    });
    let mut daemon = DaemonHarness::start(fixture, &[], &[])
        .await
        .expect("start clean daemon");
    let base = daemon.ready.healthz_url.trim_end_matches("/healthz");
    let client = reqwest::Client::new();
    let smuggled_secret = client
        .post(format!("{base}/v1/provisioning/claim"))
        .header("Authorization", daemon.bearer())
        .json(&serde_json::json!({
            "claimCode": "claim-ipc-01",
            "machineSecret": "must-not-be-an-ipc-input"
        }))
        .send()
        .await
        .expect("smuggled claim response");
    assert_eq!(smuggled_secret.status(), StatusCode::UNPROCESSABLE_ENTITY);

    let response = client
        .post(format!("{base}/v1/provisioning/claim"))
        .header("Authorization", daemon.bearer())
        .json(&serde_json::json!({ "claimCode": "claim-ipc-01" }))
        .send()
        .await
        .expect("claim response");
    assert_eq!(response.status(), StatusCode::OK);
    let claim: serde_json::Value = response.json().await.expect("claim payload");
    assert_eq!(claim["machineCode"], "MACHINE-CLAIM-IPC");
    assert_eq!(claim["restartRequested"], true);

    let profile_cache =
        tokio::fs::read_to_string(daemon.data_dir.join("config/profile-cache.json"))
            .await
            .expect("profile cache");
    assert!(profile_cache.contains("MACHINE-CLAIM-IPC"));
    assert!(!profile_cache.contains("machine-secret-claim-000000000000000"));
    assert!(tokio::fs::try_exists(
        daemon
            .data_dir
            .parent()
            .expect("runtime root")
            .join("secrets/machine_secret.dpapi"),
    )
    .await
    .expect("secret path"));
    assert!(
        !tokio::fs::try_exists(daemon.data_dir.join("config/local-settings.json"))
            .await
            .expect("local settings path")
    );
    daemon.terminate().await;
}

fn claim_profile(api_base_url: &str) -> serde_json::Value {
    serde_json::json!({
        "machine": { "id": "550e8400-e29b-41d4-a716-446655440001", "code": "MACHINE-CLAIM-IPC", "name": "Claimed machine", "status": "offline", "locationLabel": null },
        "credentials": {
            "machineSecret": "machine-secret-claim-000000000000000",
            "mqttSigningSecret": "mqtt-signing-secret-claim-000000000000",
            "mqttConnection": { "url": "mqtt://broker.example:1883", "clientId": "vem-MACHINE-CLAIM-IPC", "username": "machine", "password": "mqtt-password" }
        },
        "apiBaseUrl": api_base_url,
        "runtimeEndpoints": { "apiBasePath": "/api", "machineAuthTokenPath": "/api/machine-auth/token", "machineApiBasePath": "/api/machines/MACHINE-CLAIM-IPC", "mqttTopicPrefix": "vem/machines/MACHINE-CLAIM-IPC" },
        "hardwareProfile": {
            "profile": "production",
            "controller": { "required": true, "protocol": "vem-vending-controller" },
            "paymentScanner": { "required": true, "supportsPaymentCode": true },
            "vision": { "required": false, "supportsRecommendations": false }
        },
        "hardwareModel": "vem-test-24",
        "hardwareSlotTopology": { "identity": "vem-test-24", "version": "2026-07-test" },
        "paymentCapability": { "profile": "production", "qrCodeEnabled": true, "paymentCodeEnabled": true, "serverTime": "2026-07-17T00:00:00Z" },
        "metadata": { "profileVersion": 1, "profileRevision": 1, "claimCodeId": "550e8400-e29b-41d4-a716-446655440002", "claimedAt": "2026-07-17T00:00:00Z", "serverTime": "2026-07-17T00:00:00Z" }
    })
}
