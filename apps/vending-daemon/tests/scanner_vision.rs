mod support;

use std::process::Stdio;

use portpicker::pick_unused_port;
use support::{process::DaemonHarness, pty::PtyHarness, sensitive, sqlite};
use tokio::process::{Child, Command};

fn scanner_config(scanner_path: String) -> serde_json::Value {
    serde_json::json!({
        "machineCode": "MACHINE-SCAN",
        "apiBaseUrl": "http://127.0.0.1:9/api",
        "mqttUrl": "mqtt://127.0.0.1:1883",
        "mqttUsername": null,
        "hardwareAdapter": "mock",
        "serialPortPath": null,
        "scannerAdapter": "serial_text",
        "scannerSerialPortPath": scanner_path,
        "scannerBaudRate": 9600,
        "scannerFrameSuffix": "crlf",
        "visionEnabled": false,
        "visionWsUrl": "ws://127.0.0.1:7892/ws",
        "visionAutoStart": false,
        "visionProcessCommand": null,
        "visionProcessArgs": null,
        "visionRequestTimeoutMs": 8000,
        "kioskMode": false
    })
}

#[tokio::test]
async fn scanner_code_is_masked_in_events_and_not_persisted_plaintext() {
    let pty = PtyHarness::open();
    let scanner_path = pty.slave_path.to_string_lossy().to_string();
    pty.spawn_scanner_writer(b"621234567890123456\r\n621234567890123456\r\n");
    let mut daemon = DaemonHarness::start(
        scanner_config(scanner_path),
        &[("VEM_MACHINE_SECRET", sensitive::TEST_MACHINE_SECRET)],
    )
    .await
    .expect("start daemon");

    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    let scanner = daemon.get_json("/v1/scanner/status").await;
    assert!(scanner.to_string().contains("6212****3456"));

    daemon.terminate().await;
    let pool = sqlite::open_readonly(&daemon.state_db_path()).await;
    let db_dump = sqlite::table_text_dump(&pool).await;
    sensitive::assert_absent(
        "sqlite",
        &db_dump,
        &[
            sensitive::TEST_AUTH_CODE,
            sensitive::TEST_MACHINE_SECRET,
            sensitive::TEST_MQTT_SIGNING_SECRET,
            sensitive::TEST_MQTT_PASSWORD,
        ],
    );
    let logs = sensitive::read_text_files_under(&daemon.data_dir).await;
    sensitive::assert_absent("logs", &logs, &[sensitive::TEST_AUTH_CODE]);
}

#[tokio::test]
async fn vision_disabled_reports_disabled_status() {
    let pty = PtyHarness::open();
    let mut config = scanner_config(pty.slave_path.to_string_lossy().to_string());
    config["scannerAdapter"] = serde_json::json!("disabled");
    config["scannerSerialPortPath"] = serde_json::Value::Null;
    config["visionEnabled"] = serde_json::json!(false);
    let mut daemon = DaemonHarness::start(config, &[]).await.expect("start");
    let vision = daemon.get_json("/v1/vision/status").await;
    assert_eq!(vision["enabled"], false);
    assert_eq!(vision["online"], false);
    assert_eq!(vision["message"], "disabled");
    daemon.terminate().await;
}

#[tokio::test]
async fn vision_mock_process_updates_ready_status() {
    let port = pick_unused_port().expect("vision mock port");
    let mut vision = spawn_vision_mock(port).await;
    let pty = PtyHarness::open();
    let mut config = scanner_config(pty.slave_path.to_string_lossy().to_string());
    config["scannerAdapter"] = serde_json::json!("disabled");
    config["scannerSerialPortPath"] = serde_json::Value::Null;
    config["visionEnabled"] = serde_json::json!(true);
    config["visionWsUrl"] = serde_json::json!(format!("ws://127.0.0.1:{port}/ws"));

    let mut daemon = DaemonHarness::start(config, &[])
        .await
        .expect("start daemon");
    let vision_status = wait_for_vision_ready(&daemon).await;
    assert_eq!(vision_status["enabled"], true);
    assert_eq!(vision_status["online"], true);

    daemon.terminate().await;
    let _ = vision.start_kill();
    let _ = tokio::time::timeout(std::time::Duration::from_secs(3), vision.wait()).await;
}

async fn spawn_vision_mock(port: u16) -> Child {
    let mut command = Command::new("pnpm");
    command
        .arg("-F")
        .arg("vision-mock")
        .arg("dev")
        .env("VISION_MOCK_PORT", port.to_string())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let child = command.spawn().expect("spawn vision-mock");
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    child
}

async fn wait_for_vision_ready(daemon: &DaemonHarness) -> serde_json::Value {
    for _ in 0..40 {
        let status = daemon.get_json("/v1/vision/status").await;
        if status["enabled"] == true && status["online"] == true {
            return status;
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
    daemon.get_json("/v1/vision/status").await
}
