mod support;

use reqwest::StatusCode;
use support::process::DaemonHarness;
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
        "visionAutoStart": false,
        "visionProcessCommand": null,
        "visionProcessArgs": null,
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

    let health = daemon.get_json("/healthz").await;
    assert!(health.get("scannerOnline").is_some());
    assert!(health
        .get("components")
        .and_then(|value| value.as_array())
        .is_some());

    let scanner = daemon.get_json("/v1/scanner/status").await;
    assert!(scanner.get("port").is_some());
    assert!(scanner.get("level").is_some());
    assert!(scanner.get("code").is_some());

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
