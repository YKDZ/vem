mod support;

use support::{process::DaemonHarness, sqlite};

fn minimal_config() -> serde_json::Value {
    serde_json::json!({
        "machineCode": null,
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
        "kioskMode": false
    })
}

#[tokio::test]
async fn console_startup_writes_ready_file_and_sqlite_schema() {
    let mut daemon = DaemonHarness::start(minimal_config(), &[])
        .await
        .expect("start daemon");
    assert!(daemon.ready.healthz_url.starts_with("http://127.0.0.1:"));
    assert!(daemon.ready.readyz_url.starts_with("http://127.0.0.1:"));
    assert!(!daemon.ready.ipc_token.is_empty());
    assert!(!daemon.ready.runtime_flags.advanced_maintenance_config);

    let pool = sqlite::open_readonly(&daemon.state_db_path()).await;
    let tables = sqlite::scalar_i64(
        &pool,
        "SELECT COUNT(1) FROM sqlite_master WHERE type='table' AND name IN \
         ('runtime_metadata','machine_config','command_log','outbox_events','order_sessions','health_events')",
    )
    .await;
    assert_eq!(tables, 6);

    daemon.terminate().await;
}

#[tokio::test]
async fn console_startup_writes_local_runtime_flags_to_ready_file() {
    let mut daemon = DaemonHarness::start(
        minimal_config(),
        &[("VEM_ENABLE_ADVANCED_MAINTENANCE_CONFIG", "true")],
    )
    .await
    .expect("start daemon");

    assert!(daemon.ready.runtime_flags.advanced_maintenance_config);

    daemon.terminate().await;
}
