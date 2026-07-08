mod support;

use reqwest::StatusCode;
use support::{process::DaemonHarness, sensitive, sqlite};
use tokio_tungstenite::connect_async;

fn configured_daemon() -> serde_json::Value {
    serde_json::json!({
        "machineCode": "MACHINE-IPC",
        "apiBaseUrl": "http://127.0.0.1:9/api",
        "mqttUrl": "mqtt://127.0.0.1:1883",
        "mqttUsername": null,
        "hardwareAdapter": "mock",
        "serialPortPath": null,
        "scannerAdapter": "disabled",
        "scannerSerialPortPath": null,
        "scannerBaudRate": 9600,
        "scannerFrameSuffix": "crlf",
        "visionEnabled": false,
        "visionWsUrl": "ws://127.0.0.1:7892/ws",
        "visionRequestTimeoutMs": 8000,
        "kioskMode": true
    })
}

#[tokio::test]
async fn ipc_contract_requires_token_and_returns_stable_snapshots() {
    let mut daemon = DaemonHarness::start(configured_daemon(), &[])
        .await
        .expect("start");
    let base = daemon
        .ready
        .healthz_url
        .trim_end_matches("/healthz")
        .to_string();
    let client = reqwest::Client::new();

    let no_token = client
        .get(format!("{base}/v1/config"))
        .send()
        .await
        .expect("no token response");
    assert_eq!(no_token.status(), StatusCode::UNAUTHORIZED);

    for path in [
        "/v1/config",
        "/v1/config/summary",
        "/v1/transactions/current",
        "/v1/sync/status",
        "/v1/scanner/status",
        "/v1/vision/status",
        "/v1/remote-ops/status",
    ] {
        let value = daemon.get_json(path).await;
        assert!(
            value.is_object(),
            "{path} should return a JSON object, got {value}"
        );
        let text = value.to_string();
        assert!(!text.contains("\"machineSecret\":"));
        assert!(!text.contains("\"mqttSigningSecret\":"));
        assert!(!text.contains("\"mqttPassword\":"));
    }

    let config_summary = daemon.get_json("/v1/config/summary").await;
    assert!(config_summary["configuredState"]
        .get("machineConfigBridge")
        .is_none());
    assert_eq!(
        config_summary["effectivePublic"]["machineCode"],
        "MACHINE-IPC"
    );

    let health = daemon.get_json("/healthz").await;
    assert!(health.get("scannerOnline").is_some());
    assert!(health
        .get("components")
        .and_then(|value| value.as_array())
        .is_some());

    let scanner = daemon.get_json("/v1/scanner/status").await;
    let scanner_contract: daemon_ipc_contracts::ScannerRuntimeStatus =
        serde_json::from_value(scanner.clone()).expect("scanner status matches contract crate");
    assert!(scanner.get("port").is_some());
    assert!(scanner.get("level").is_some());
    assert!(scanner.get("code").is_some());
    assert_eq!(scanner_contract.adapter, "disabled");

    let missing_submit = client
        .post(format!("{base}/v1/intents/submit-payment-code"))
        .header("Authorization", daemon.bearer())
        .json(&serde_json::json!({}))
        .send()
        .await
        .expect("missing submit route");
    assert_eq!(missing_submit.status(), StatusCode::NOT_FOUND);

    let bad_ws = connect_async(format!(
        "{}/v1/events?token=bad",
        base.replace("http", "ws")
    ))
    .await;
    assert!(bad_ws.is_err());
    daemon.terminate().await;
}

#[tokio::test]
async fn bring_up_snapshot_exposes_safe_network_required_state() {
    let mut config = configured_daemon();
    config["machineCode"] = serde_json::Value::Null;
    config["apiBaseUrl"] = serde_json::Value::String(String::new());
    let mut daemon = DaemonHarness::start(config, &[]).await.expect("start");

    let snapshot = daemon.get_json("/v1/bring-up").await;

    assert_eq!(snapshot["state"], "network_required");
    assert_eq!(snapshot["readinessLevel"], "not_ready");
    assert_eq!(snapshot["hardwareMode"], "simulated");
    assert_eq!(snapshot["allowedActions"]["configureNetwork"], true);
    assert_eq!(snapshot["allowedActions"]["claimMachine"], false);
    assert_eq!(snapshot["allowedActions"]["startSales"], false);
    assert!(snapshot["blockingReasons"]
        .as_array()
        .expect("blocking reasons")
        .iter()
        .any(|reason| reason["code"] == "NETWORK_REQUIRED"));
    assert!(snapshot["diagnostics"]
        .as_array()
        .expect("diagnostics")
        .iter()
        .any(|item| item["code"] == "PUBLIC_CONFIG_UNCLAIMED"));

    let text = snapshot.to_string();
    assert!(!text.contains("machineSecret"));
    assert!(!text.contains("mqttSigningSecret"));
    assert!(!text.contains("mqttPassword"));

    daemon.terminate().await;
}

#[tokio::test]
async fn protected_network_settings_connects_password_wifi_without_persisting_secret() {
    let wifi_password = ["correct", "horse", "battery", "staple"].join(" ");
    let mut config = configured_daemon();
    config["machineCode"] = serde_json::Value::Null;
    config["apiBaseUrl"] = serde_json::Value::String(String::new());
    let mut daemon = DaemonHarness::start(
        config,
        &[
            ("VEM_NETWORK_ADAPTER", "fake"),
            ("VEM_FAKE_NETWORK_OUTCOME", "success"),
        ],
    )
    .await
    .expect("start");

    let base = daemon.ready.healthz_url.trim_end_matches("/healthz");
    let response = reqwest::Client::new()
        .post(format!("{base}/v1/network/settings"))
        .header("Authorization", daemon.bearer())
        .json(&serde_json::json!({
            "ssid": "VEM-Lab",
            "password": wifi_password,
            "hidden": false
        }))
        .send()
        .await
        .expect("network settings response");
    assert_eq!(response.status(), StatusCode::OK);
    let result: serde_json::Value = response.json().await.expect("network json");

    assert_eq!(result["status"], "connected");
    assert_eq!(result["ssid"], "VEM-Lab");
    assert_eq!(result["hidden"], false);
    assert!(result["diagnostics"]
        .as_array()
        .expect("diagnostics")
        .iter()
        .any(|item| item["component"] == "local_network"
            && item["code"] == "LOCAL_NETWORK_CONNECTED"));
    assert!(result["diagnostics"]
        .as_array()
        .expect("diagnostics")
        .iter()
        .any(|item| item["component"] == "dhcp_ip" && item["code"] == "DHCP_IP_READY"));
    assert!(result["diagnostics"]
        .as_array()
        .expect("diagnostics")
        .iter()
        .any(|item| item["component"] == "dns" && item["code"] == "DNS_READY"));
    assert!(result["diagnostics"]
        .as_array()
        .expect("diagnostics")
        .iter()
        .any(|item| item["component"] == "provisioning_endpoint"
            && item["code"] == "PROVISIONING_ENDPOINT_REACHABLE"));
    assert!(result["diagnostics"]
        .as_array()
        .expect("diagnostics")
        .iter()
        .any(|item| item["component"] == "mqtt" && item["code"] == "MQTT_REACHABLE"));
    assert!(!result.to_string().contains(&wifi_password));

    let bring_up = daemon.get_json("/v1/bring-up").await;
    assert!(bring_up["diagnostics"]
        .as_array()
        .expect("bring-up diagnostics")
        .iter()
        .any(|item| item["component"] == "provisioning_endpoint"
            && item["code"] == "PROVISIONING_ENDPOINT_REACHABLE"));

    let logs = sensitive::read_text_files_under(&daemon.data_dir).await;
    assert!(
        !logs.contains(&wifi_password),
        "network setup local files leaked submitted Wi-Fi password"
    );

    daemon.terminate().await;
}

#[tokio::test]
async fn network_bootstrap_persists_only_local_bring_up_settings_for_unclaimed_runtime() {
    let wifi_password = ["local", "bringup", "only", "secret"].join("-");
    let mut config = configured_daemon();
    config["machineCode"] = serde_json::Value::Null;
    config["apiBaseUrl"] = serde_json::Value::String(String::new());
    let mut daemon = DaemonHarness::start(
        config,
        &[
            ("VEM_NETWORK_ADAPTER", "fake"),
            ("VEM_FAKE_NETWORK_OUTCOME", "success"),
        ],
    )
    .await
    .expect("start");

    let before = daemon.get_json("/v1/bring-up").await;
    assert_eq!(before["state"], "network_required");
    assert_eq!(before["readinessLevel"], "not_ready");
    assert_eq!(before["allowedActions"]["configureNetwork"], true);
    assert_eq!(before["allowedActions"]["claimMachine"], false);

    let base = daemon.ready.healthz_url.trim_end_matches("/healthz");
    let response = reqwest::Client::new()
        .post(format!("{base}/v1/network/settings"))
        .header("Authorization", daemon.bearer())
        .json(&serde_json::json!({
            "ssid": "VEM-Field-WPA2",
            "password": wifi_password,
            "hidden": false
        }))
        .send()
        .await
        .expect("network settings response");
    assert_eq!(response.status(), StatusCode::OK);

    let summary = daemon.get_json("/v1/config/summary").await;
    assert_eq!(summary["configuredState"]["localBringUpSettings"], true);
    assert_eq!(
        summary["localBringUpSettings"]["networkProfile"],
        "VEM-Field-WPA2"
    );
    assert_eq!(
        summary["configuredState"]["provisioningProfileCache"],
        false
    );
    assert_eq!(summary["configuredState"]["machineSecretConfigured"], false);
    assert_eq!(
        summary["configuredState"]["mqttSigningSecretConfigured"],
        false
    );
    assert_eq!(summary["configuredState"]["mqttPasswordConfigured"], false);
    assert_eq!(
        summary["effectivePublic"]["machineCode"],
        serde_json::Value::Null
    );
    assert_eq!(
        summary["effectivePublic"]["machineId"],
        serde_json::Value::Null
    );
    assert_eq!(
        summary["effectivePublic"]["paymentCapability"],
        serde_json::Value::Null
    );
    assert_eq!(summary["provisioningProfileCache"], serde_json::Value::Null);

    let after = daemon.get_json("/v1/bring-up").await;
    assert!(after["diagnostics"]
        .as_array()
        .expect("bring-up diagnostics")
        .iter()
        .any(|item| item["component"] == "provisioning_endpoint"
            && item["code"] == "PROVISIONING_ENDPOINT_REACHABLE"));
    assert_eq!(after["allowedActions"]["startSales"], false);

    let root = daemon.data_dir.parent().expect("runtime root");
    assert!(
        tokio::fs::try_exists(root.join("bringup").join("local-settings.json"))
            .await
            .expect("settings exists check")
    );
    assert!(
        !tokio::fs::try_exists(root.join("provisioning").join("profile-cache-summary.json"))
            .await
            .expect("profile cache exists check")
    );
    assert!(!tokio::fs::try_exists(root.join("secrets"))
        .await
        .expect("secrets exists check"));

    let pool = sqlite::open_readonly(&daemon.state_db_path()).await;
    assert_eq!(
        sqlite::scalar_i64(&pool, "SELECT COUNT(1) FROM order_sessions").await,
        0
    );
    assert_eq!(
        sqlite::scalar_i64(&pool, "SELECT COUNT(1) FROM command_log").await,
        0
    );
    assert_eq!(
        sqlite::scalar_i64(&pool, "SELECT COUNT(1) FROM outbox_events").await,
        0
    );

    let persisted = sensitive::read_text_files_under(&daemon.data_dir).await;
    let local_settings =
        tokio::fs::read_to_string(root.join("bringup").join("local-settings.json"))
            .await
            .expect("read local settings");
    assert!(!persisted.contains(&wifi_password));
    assert!(!local_settings.contains(&wifi_password));
    assert!(!local_settings.contains("machineCode"));
    assert!(!local_settings.contains("machineSecret"));
    assert!(!local_settings.contains("provisioningProfile"));
    assert!(!local_settings.contains("inventory"));
    assert!(!local_settings.contains("product"));
    assert!(!local_settings.contains("order"));
    assert!(!local_settings.contains("payment"));

    daemon.terminate().await;
}

#[tokio::test]
async fn network_bootstrap_moves_unclaimed_runtime_from_offline_to_claim_ready() {
    let wifi_password = ["claim", "ready", "network", "secret"].join("-");
    let mut config = configured_daemon();
    config["machineCode"] = serde_json::Value::Null;
    config["apiBaseUrl"] =
        serde_json::Value::String("https://provisioning.example.test/api".to_string());
    let mut daemon = DaemonHarness::start(
        config,
        &[
            ("VEM_NETWORK_ADAPTER", "fake"),
            ("VEM_FAKE_NETWORK_OUTCOME", "success"),
        ],
    )
    .await
    .expect("start");

    let before = daemon.get_json("/v1/bring-up").await;
    assert_eq!(before["state"], "network_required");
    assert_eq!(before["readinessLevel"], "not_ready");
    assert_eq!(before["allowedActions"]["configureNetwork"], true);
    assert_eq!(before["allowedActions"]["claimMachine"], false);

    let base = daemon.ready.healthz_url.trim_end_matches("/healthz");
    let response = reqwest::Client::new()
        .post(format!("{base}/v1/network/settings"))
        .header("Authorization", daemon.bearer())
        .json(&serde_json::json!({
            "ssid": "VEM-Field-WPA2",
            "password": wifi_password,
            "hidden": false
        }))
        .send()
        .await
        .expect("network settings response");
    assert_eq!(response.status(), StatusCode::OK);

    let after = daemon.get_json("/v1/bring-up").await;
    assert_eq!(after["state"], "claim_required");
    assert_eq!(after["readinessLevel"], "not_ready");
    assert_eq!(after["allowedActions"]["configureNetwork"], false);
    assert_eq!(after["allowedActions"]["claimMachine"], true);
    assert_eq!(after["allowedActions"]["retryClaim"], true);
    assert_eq!(after["allowedActions"]["startSales"], false);
    assert!(after["blockingReasons"]
        .as_array()
        .expect("blocking reasons")
        .iter()
        .any(|reason| reason["code"] == "CLAIM_REQUIRED"));
    assert!(after["diagnostics"]
        .as_array()
        .expect("diagnostics")
        .iter()
        .any(|item| item["component"] == "provisioning_endpoint"
            && item["code"] == "PROVISIONING_ENDPOINT_REACHABLE"));
    assert!(!after.to_string().contains(&wifi_password));

    daemon.terminate().await;
}

#[tokio::test]
async fn network_bootstrap_connected_pending_persists_without_claim_ready() {
    let wifi_password = ["pending", "network", "secret"].join("-");
    let mut config = configured_daemon();
    config["machineCode"] = serde_json::Value::Null;
    config["apiBaseUrl"] =
        serde_json::Value::String("https://provisioning.example.test/api".to_string());
    let mut daemon = DaemonHarness::start(
        config,
        &[
            ("VEM_NETWORK_ADAPTER", "fake"),
            ("VEM_FAKE_NETWORK_OUTCOME", "pending_success"),
        ],
    )
    .await
    .expect("start");

    let base = daemon.ready.healthz_url.trim_end_matches("/healthz");
    let response = reqwest::Client::new()
        .post(format!("{base}/v1/network/settings"))
        .header("Authorization", daemon.bearer())
        .json(&serde_json::json!({
            "ssid": "VEM-Field-WPA2",
            "password": wifi_password,
            "hidden": false
        }))
        .send()
        .await
        .expect("network settings response");
    assert_eq!(response.status(), StatusCode::OK);
    let result: serde_json::Value = response.json().await.expect("network json");
    assert_eq!(result["status"], "connected");
    assert!(result["diagnostics"]
        .as_array()
        .expect("network diagnostics")
        .iter()
        .any(|item| item["component"] == "provisioning_endpoint"
            && item["code"] == "PROVISIONING_ENDPOINT_PENDING"));

    let summary = daemon.get_json("/v1/config/summary").await;
    assert_eq!(summary["configuredState"]["localBringUpSettings"], true);
    assert_eq!(
        summary["localBringUpSettings"]["networkProfile"],
        "VEM-Field-WPA2"
    );

    let after = daemon.get_json("/v1/bring-up").await;
    assert_eq!(after["state"], "network_required");
    assert_eq!(after["allowedActions"]["configureNetwork"], true);
    assert_eq!(after["allowedActions"]["claimMachine"], false);
    assert!(!after["diagnostics"]
        .as_array()
        .expect("diagnostics")
        .iter()
        .any(|item| item["component"] == "provisioning_endpoint"
            && item["code"] == "PROVISIONING_ENDPOINT_REACHABLE"));
    assert!(!after.to_string().contains(&wifi_password));

    daemon.terminate().await;
}

#[tokio::test]
async fn protected_network_settings_does_not_report_reachability_until_diagnostics_pass() {
    let wifi_password = ["diagnostics", "network", "pass"].join("-");
    let mut daemon = DaemonHarness::start(
        configured_daemon(),
        &[
            ("VEM_NETWORK_ADAPTER", "fake"),
            ("VEM_FAKE_NETWORK_OUTCOME", "associated_only"),
        ],
    )
    .await
    .expect("start");

    let base = daemon.ready.healthz_url.trim_end_matches("/healthz");
    let response = reqwest::Client::new()
        .post(format!("{base}/v1/network/settings"))
        .header("Authorization", daemon.bearer())
        .json(&serde_json::json!({
            "ssid": "VEM-Lab",
            "password": wifi_password,
            "hidden": false
        }))
        .send()
        .await
        .expect("network settings response");
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let result: serde_json::Value = response.json().await.expect("network json");

    assert_ne!(result["status"], "connected");
    for ready_code in [
        "DHCP_IP_READY",
        "DNS_READY",
        "PROVISIONING_ENDPOINT_REACHABLE",
        "MQTT_REACHABLE",
    ] {
        assert!(
            !result["diagnostics"]
                .as_array()
                .expect("diagnostics")
                .iter()
                .any(|item| item["code"] == ready_code),
            "{ready_code} must not be reported before diagnostics pass"
        );
    }
    assert!(result["diagnostics"]
        .as_array()
        .expect("diagnostics")
        .iter()
        .any(|item| item["component"] == "dhcp_ip" && item["code"] == "DHCP_IP_PENDING"));
    assert!(!result.to_string().contains(&wifi_password));

    let bring_up = daemon.get_json("/v1/bring-up").await;
    assert!(!bring_up["diagnostics"]
        .as_array()
        .expect("bring-up diagnostics")
        .iter()
        .any(|item| item["code"] == "PROVISIONING_ENDPOINT_REACHABLE"));
    assert!(!bring_up.to_string().contains(&wifi_password));

    daemon.terminate().await;
}

#[tokio::test]
async fn protected_network_settings_reports_invalid_password_without_echoing_secret() {
    let wifi_password = ["wrong", "network", "credential"].join("-");
    let mut daemon = DaemonHarness::start(
        configured_daemon(),
        &[
            ("VEM_NETWORK_ADAPTER", "fake"),
            ("VEM_FAKE_NETWORK_OUTCOME", "invalid_password"),
        ],
    )
    .await
    .expect("start");

    let base = daemon.ready.healthz_url.trim_end_matches("/healthz");
    let response = reqwest::Client::new()
        .post(format!("{base}/v1/network/settings"))
        .header("Authorization", daemon.bearer())
        .json(&serde_json::json!({
            "ssid": "VEM-Lab",
            "password": wifi_password,
            "hidden": false
        }))
        .send()
        .await
        .expect("network settings response");
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let result: serde_json::Value = response.json().await.expect("network json");

    assert_eq!(result["status"], "failed");
    assert!(result["operatorGuidance"]
        .as_str()
        .expect("guidance")
        .contains("密码"));
    assert!(result["diagnostics"]
        .as_array()
        .expect("diagnostics")
        .iter()
        .any(|item| item["component"] == "local_network" && item["code"] == "WIFI_AUTH_FAILED"));
    assert!(result["diagnostics"]
        .as_array()
        .expect("diagnostics")
        .iter()
        .any(|item| item["component"] == "dhcp_ip" && item["code"] == "DHCP_IP_NOT_CHECKED"));
    assert!(!result.to_string().contains(&wifi_password));

    let logs = sensitive::read_text_files_under(&daemon.data_dir).await;
    assert!(
        !logs.contains(&wifi_password),
        "invalid password local files leaked submitted Wi-Fi password"
    );

    daemon.terminate().await;
}

#[tokio::test]
async fn protected_network_settings_accepts_hidden_ssid_manual_entry() {
    let wifi_password = ["hidden", "network", "credential"].join("-");
    let mut daemon = DaemonHarness::start(
        configured_daemon(),
        &[
            ("VEM_NETWORK_ADAPTER", "fake"),
            ("VEM_FAKE_NETWORK_OUTCOME", "success"),
        ],
    )
    .await
    .expect("start");

    let base = daemon.ready.healthz_url.trim_end_matches("/healthz");
    let response = reqwest::Client::new()
        .post(format!("{base}/v1/network/settings"))
        .header("Authorization", daemon.bearer())
        .json(&serde_json::json!({
            "ssid": "Hidden-VEM-Lab",
            "password": wifi_password,
            "hidden": true
        }))
        .send()
        .await
        .expect("network settings response");
    assert_eq!(response.status(), StatusCode::OK);
    let result: serde_json::Value = response.json().await.expect("network json");

    assert_eq!(result["status"], "connected");
    assert_eq!(result["ssid"], "Hidden-VEM-Lab");
    assert_eq!(result["hidden"], true);
    assert!(result["diagnostics"]
        .as_array()
        .expect("diagnostics")
        .iter()
        .any(|item| item["component"] == "local_network"
            && item["code"] == "LOCAL_NETWORK_CONNECTED"));

    daemon.terminate().await;
}

#[tokio::test]
async fn protected_network_settings_rejects_captive_portal_with_operator_guidance() {
    let wifi_password = ["guest", "network", "credential"].join("-");
    let mut daemon = DaemonHarness::start(
        configured_daemon(),
        &[
            ("VEM_NETWORK_ADAPTER", "fake"),
            ("VEM_FAKE_NETWORK_OUTCOME", "captive_portal"),
        ],
    )
    .await
    .expect("start");

    let base = daemon.ready.healthz_url.trim_end_matches("/healthz");
    let response = reqwest::Client::new()
        .post(format!("{base}/v1/network/settings"))
        .header("Authorization", daemon.bearer())
        .json(&serde_json::json!({
            "ssid": "Venue-Guest",
            "password": wifi_password,
            "hidden": false
        }))
        .send()
        .await
        .expect("network settings response");
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let result: serde_json::Value = response.json().await.expect("network json");

    assert_eq!(result["status"], "unsupported");
    let guidance = result["operatorGuidance"].as_str().expect("guidance");
    assert!(guidance.contains("网页登录"));
    assert!(guidance.contains("普通 WPA/WPA2"));
    assert!(!guidance.contains("Windows 桌面"));
    assert!(!guidance.contains("退出桌面"));
    assert!(!guidance.contains("桌面"));
    assert!(result["diagnostics"]
        .as_array()
        .expect("diagnostics")
        .iter()
        .any(|item| item["component"] == "local_network"
            && item["code"] == "INTERACTIVE_LOGIN_NETWORK_UNSUPPORTED"));

    daemon.terminate().await;
}
