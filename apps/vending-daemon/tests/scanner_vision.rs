#![cfg(unix)]

mod support;

use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use portpicker::pick_unused_port;
use reqwest::Client;
use serde_json::json;
use support::{
    mqtt::MqttBrokerHarness, process::DaemonHarness, pty::PtyHarness, sensitive, sqlite,
};
use tokio::{net::TcpListener, task::JoinHandle};
use tokio_tungstenite::{accept_async, tungstenite::Message};
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, MockServer, Request, ResponseTemplate};

static SCANNER_VISION_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

const TEST_MAINTENANCE_PIN: &str = "2468";
const TEST_MAINTENANCE_PIN_VERIFIER: &str = r#"{"version":1,"algorithm":"pbkdf2_hmac_sha256","iterations":120000,"salt":"ABEiM0RVZneImaq7zN3u/w==","digest":"jEOlq6tvHWcnp7Q9bZdfXkpFrllYswV3vYr250nTqJ0="}"#;

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
        "visionRequestTimeoutMs": 8000,
        "kioskMode": false
    })
}

fn production_scanner_config(
    scanner_path: String,
    lower_controller_path: String,
) -> serde_json::Value {
    let mut config = scanner_config(scanner_path);
    config["hardwareAdapter"] = json!("serial");
    config["serialPortPath"] = json!(lower_controller_path);
    config["hardwareProfile"] = json!({
        "profile": "production",
        "controller": { "required": true, "protocol": "vem-vending-controller" },
        "paymentScanner": { "required": true, "supportsPaymentCode": true },
        "vision": { "required": false, "supportsRecommendations": true }
    });
    config["paymentCapability"] = json!({
        "profile": "production",
        "qrCodeEnabled": true,
        "paymentCodeEnabled": true,
        "serverTime": "2026-06-08T16:30:00.000Z"
    });
    config["hardwareSlotTopology"] = json!({
        "identity": "vem-test-24",
        "version": "2026-07-test"
    });
    config
}

#[tokio::test]
async fn scanner_code_is_masked_in_events_and_not_persisted_plaintext() {
    let _guard = SCANNER_VISION_TEST_LOCK.lock().await;
    let pty = PtyHarness::open();
    let scanner_path = pty.slave_path.to_string_lossy().to_string();
    pty.spawn_scanner_writer(b"621234567890123456\r\n621234567890123456\r\n");
    let mut daemon = DaemonHarness::start(
        scanner_config(scanner_path),
        &[
            ("machine_maintenance_pin", TEST_MAINTENANCE_PIN_VERIFIER),
            ("machine_secret", sensitive::TEST_MACHINE_SECRET),
        ],
        &[],
    )
    .await
    .expect("start daemon");

    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    let base = daemon.ready.healthz_url.trim_end_matches("/healthz");
    let client = Client::new();
    let without_session = client
        .get(format!("{base}/v1/scanner/status"))
        .header("Authorization", daemon.bearer())
        .send()
        .await
        .expect("scanner status without maintenance session");
    assert_eq!(without_session.status(), reqwest::StatusCode::FORBIDDEN);
    let session_id = daemon
        .create_maintenance_session(TEST_MAINTENANCE_PIN)
        .await;
    let scanner = client
        .get(format!("{base}/v1/scanner/status"))
        .header("Authorization", daemon.bearer())
        .header("x-vem-maintenance-session", session_id)
        .send()
        .await
        .expect("scanner status with maintenance session")
        .json::<serde_json::Value>()
        .await
        .expect("scanner status JSON");
    assert_eq!(scanner["adapter"], "serial_text");
    assert_eq!(scanner["online"], true);
    assert_eq!(scanner["code"], "SCANNER_READY");
    assert!(scanner.to_string().contains("6212****3456"));
    assert!(!scanner.to_string().contains("621234567890123456"));

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
async fn scanner_open_failure_reports_offline() {
    let _guard = SCANNER_VISION_TEST_LOCK.lock().await;
    let mut daemon = DaemonHarness::start(
        scanner_config("/dev/vem-missing-scanner".to_string()),
        &[
            ("machine_maintenance_pin", TEST_MAINTENANCE_PIN_VERIFIER),
            ("machine_secret", sensitive::TEST_MACHINE_SECRET),
        ],
        &[],
    )
    .await
    .expect("start daemon");

    let base = daemon.ready.healthz_url.trim_end_matches("/healthz");
    let client = Client::new();
    let session_id = daemon
        .create_maintenance_session(TEST_MAINTENANCE_PIN)
        .await;
    for _ in 0..40 {
        let scanner = client
            .get(format!("{base}/v1/scanner/status"))
            .header("Authorization", daemon.bearer())
            .header("x-vem-maintenance-session", &session_id)
            .send()
            .await
            .expect("scanner status with maintenance session")
            .json::<serde_json::Value>()
            .await
            .expect("scanner status JSON");
        if scanner["code"] == "SCANNER_OPEN_FAILED" {
            assert_eq!(scanner["online"], false);
            assert_eq!(scanner["adapter"], "serial_text");
            assert_eq!(scanner["level"], "offline");
            assert!(!scanner["message"].as_str().unwrap_or_default().is_empty());
            daemon.terminate().await;
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }

    let scanner = client
        .get(format!("{base}/v1/scanner/status"))
        .header("Authorization", daemon.bearer())
        .header("x-vem-maintenance-session", session_id)
        .send()
        .await
        .expect("scanner status with maintenance session")
        .json::<serde_json::Value>()
        .await
        .expect("scanner status JSON");
    daemon.terminate().await;
    panic!("scanner did not report open failure: {scanner}");
}

#[tokio::test]
async fn serial_text_scanner_rejects_invalid_frame_then_submits_the_next_payment_code() {
    let _guard = SCANNER_VISION_TEST_LOCK.lock().await;
    let server = MockServer::start().await;
    let status_calls = Arc::new(AtomicUsize::new(0));
    let submit_calls = Arc::new(AtomicUsize::new(0));

    Mock::given(method("POST"))
        .and(path("/machine-auth/token"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "accessToken": "token-123"
        })))
        .mount(&server)
        .await;

    Mock::given(method("POST"))
        .and(path("/machine-orders"))
        .and(header("authorization", "Bearer token-123"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "orderNo": "ORD-SCAN"
        })))
        .mount(&server)
        .await;

    let status_calls_clone = status_calls.clone();
    let submit_calls_for_status = submit_calls.clone();
    Mock::given(method("GET"))
        .and(path("/machine-orders/ORD-SCAN/status"))
        .and(header("authorization", "Bearer token-123"))
        .respond_with(move |_request: &Request| {
            let attempt = status_calls_clone.fetch_add(1, Ordering::SeqCst);
            let submit_seen = submit_calls_for_status.load(Ordering::SeqCst) > 0;
            if attempt == 0 || !submit_seen {
                ResponseTemplate::new(200).set_body_json(json!({
                    "orderId": "order-scan-id",
                    "orderNo": "ORD-SCAN",
                    "machineCode": "MACHINE-SCAN",
                    "orderStatus": "waiting_payment",
                    "totalAmountCents": 300,
                    "nextAction": "wait_payment",
                    "payment": {
                        "paymentNo": "PAY-SCAN",
                        "method": "payment_code",
                        "providerCode": "alipay",
                        "paymentUrl": null,
                        "status": "pending",
                        "expiresAt": "2026-05-30T00:05:00.000Z"
                    }
                }))
            } else {
                ResponseTemplate::new(200).set_body_json(json!({
                    "orderId": "order-scan-id",
                    "orderNo": "ORD-SCAN",
                    "machineCode": "MACHINE-SCAN",
                    "orderStatus": "paid",
                    "totalAmountCents": 300,
                    "nextAction": "dispensing",
                    "payment": {
                        "paymentNo": "PAY-SCAN",
                        "method": "payment_code",
                        "providerCode": "alipay",
                        "paymentUrl": null,
                        "status": "succeeded",
                        "expiresAt": "2026-05-30T00:05:00.000Z"
                    },
                    "vending": {
                        "commandNo": "CMD-SCAN",
                        "status": "pending",
                        "lastError": null
                    }
                }))
            }
        })
        .mount(&server)
        .await;

    let submit_calls_for_mock = submit_calls.clone();
    Mock::given(method("POST"))
        .and(path("/machine-orders/ORD-SCAN/payment-code/submit"))
        .and(header("authorization", "Bearer token-123"))
        .respond_with(move |_request: &Request| {
            submit_calls_for_mock.fetch_add(1, Ordering::SeqCst);
            ResponseTemplate::new(200).set_body_json(json!({
                "orderNo": "ORD-SCAN",
                "paymentNo": "PAY-SCAN",
                "attemptNo": 1,
                "status": "succeeded",
                "nextAction": "dispensing",
                "message": "支付成功，正在出货",
                "canRetry": false,
                "serverTime": "2026-05-30T00:00:00.000Z"
            }))
        })
        .mount(&server)
        .await;

    mock_payment_code_options(&server).await;
    mock_stock_movement_acceptance(&server).await;
    let mqtt = MqttBrokerHarness::start().await;
    let lower_controller = PtyHarness::open();
    let lower_controller_path = lower_controller.slave_path.to_string_lossy().to_string();
    lower_controller.spawn_lower_controller_heartbeat();
    let mut pty = PtyHarness::open();
    let scanner_path = pty.slave_path.to_string_lossy().to_string();
    let mut config = production_scanner_config(scanner_path, lower_controller_path);
    config["apiBaseUrl"] = json!(server.uri());
    config["mqttUrl"] = json!(mqtt.url());
    let mut daemon = DaemonHarness::start(
        config,
        &[
            ("machine_secret", sensitive::TEST_MACHINE_SECRET),
            ("mqtt_signing_secret", sensitive::TEST_MQTT_SIGNING_SECRET),
            ("machine_maintenance_pin", TEST_MAINTENANCE_PIN_VERIFIER),
        ],
        &[],
    )
    .await
    .expect("start daemon");

    create_payment_code_order(&daemon).await;
    wait_for_scanner_code(&daemon, "SCANNER_READY").await;
    pty.write(b"\xff12\r\n621234567890123456\r\n").await;

    let tx = wait_for_transaction(&daemon, |tx| {
        tx["nextAction"] == "dispensing" && tx["paymentCodeAttempt"]["source"] == "serial_text"
    })
    .await;
    assert_eq!(tx["paymentMethod"], "payment_code");
    assert_eq!(tx["nextAction"], "dispensing");
    assert_eq!(tx["paymentCodeAttempt"]["source"], "serial_text");
    assert_eq!(tx["paymentCodeAttempt"]["maskedAuthCode"], "6212****3456");
    assert!(!tx.to_string().contains("621234567890123456"));
    assert_eq!(submit_calls.load(Ordering::SeqCst), 1);

    let platform_requests = server
        .received_requests()
        .await
        .expect("recorded Platform requests");
    let stock_ack_position = platform_requests
        .iter()
        .position(|request| request.url.path() == "/machine-stock-movements")
        .expect("physical stock upload before sale");
    let create_order_position = platform_requests
        .iter()
        .position(|request| request.url.path() == "/machine-orders")
        .expect("create order after stock acceptance");
    assert!(
        stock_ack_position < create_order_position,
        "scanner sale must wait for Platform stock acceptance before creating an order"
    );

    daemon.terminate().await;
}

#[tokio::test]
async fn serial_text_scanner_retry_scan_uses_new_idempotency_key() {
    let _guard = SCANNER_VISION_TEST_LOCK.lock().await;
    let server = MockServer::start().await;
    let status_calls = Arc::new(AtomicUsize::new(0));
    let submit_calls = Arc::new(AtomicUsize::new(0));

    Mock::given(method("POST"))
        .and(path("/machine-auth/token"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "accessToken": "token-123"
        })))
        .mount(&server)
        .await;

    Mock::given(method("POST"))
        .and(path("/machine-orders"))
        .and(header("authorization", "Bearer token-123"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "orderNo": "ORD-SCAN"
        })))
        .mount(&server)
        .await;

    let status_calls_clone = status_calls.clone();
    let submit_calls_for_status = submit_calls.clone();
    Mock::given(method("GET"))
        .and(path("/machine-orders/ORD-SCAN/status"))
        .and(header("authorization", "Bearer token-123"))
        .respond_with(move |_request: &Request| {
            let _attempt = status_calls_clone.fetch_add(1, Ordering::SeqCst);
            if submit_calls_for_status.load(Ordering::SeqCst) < 2 {
                ResponseTemplate::new(200).set_body_json(json!({
                    "orderId": "order-scan-id",
                    "orderNo": "ORD-SCAN",
                    "machineCode": "MACHINE-SCAN",
                    "orderStatus": "waiting_payment",
                    "totalAmountCents": 300,
                    "nextAction": "wait_payment",
                    "payment": {
                        "paymentNo": "PAY-SCAN",
                        "method": "payment_code",
                        "providerCode": "alipay",
                        "paymentUrl": null,
                        "status": "pending",
                        "expiresAt": "2026-05-30T00:05:00.000Z"
                    }
                }))
            } else {
                ResponseTemplate::new(200).set_body_json(json!({
                    "orderId": "order-scan-id",
                    "orderNo": "ORD-SCAN",
                    "machineCode": "MACHINE-SCAN",
                    "orderStatus": "paid",
                    "totalAmountCents": 300,
                    "nextAction": "dispensing",
                    "payment": {
                        "paymentNo": "PAY-SCAN",
                        "method": "payment_code",
                        "providerCode": "alipay",
                        "paymentUrl": null,
                        "status": "succeeded",
                        "expiresAt": "2026-05-30T00:05:00.000Z"
                    },
                    "vending": {
                        "commandNo": "CMD-SCAN",
                        "status": "pending",
                        "lastError": null
                    }
                }))
            }
        })
        .mount(&server)
        .await;

    let submit_calls_clone = submit_calls.clone();
    Mock::given(method("POST"))
        .and(path("/machine-orders/ORD-SCAN/payment-code/submit"))
        .and(header("authorization", "Bearer token-123"))
        .respond_with(move |_request: &Request| {
            let attempt = submit_calls_clone.fetch_add(1, Ordering::SeqCst);
            if attempt == 0 {
                ResponseTemplate::new(200).set_body_json(json!({
                    "orderNo": "ORD-SCAN",
                    "paymentNo": "PAY-SCAN",
                    "attemptNo": 1,
                    "status": "failed",
                    "nextAction": "wait_payment",
                    "message": "付款码无效或支付失败，请刷新付款码后重试",
                    "canRetry": true,
                    "serverTime": "2026-05-30T00:00:00.000Z"
                }))
            } else {
                ResponseTemplate::new(200).set_body_json(json!({
                    "orderNo": "ORD-SCAN",
                    "paymentNo": "PAY-SCAN",
                    "attemptNo": 2,
                    "status": "succeeded",
                    "nextAction": "dispensing",
                    "message": "支付成功，正在出货",
                    "canRetry": false,
                    "serverTime": "2026-05-30T00:00:01.000Z"
                }))
            }
        })
        .mount(&server)
        .await;

    let first_raw_code = "621234567890123456";
    let second_raw_code = "621234567890129999";
    mock_payment_code_options(&server).await;
    mock_stock_movement_acceptance(&server).await;
    let mqtt = MqttBrokerHarness::start().await;
    let lower_controller = PtyHarness::open();
    let lower_controller_path = lower_controller.slave_path.to_string_lossy().to_string();
    lower_controller.spawn_lower_controller_heartbeat();
    let mut pty = PtyHarness::open();
    let scanner_path = pty.slave_path.to_string_lossy().to_string();
    let mut config = production_scanner_config(scanner_path, lower_controller_path);
    config["apiBaseUrl"] = json!(server.uri());
    config["mqttUrl"] = json!(mqtt.url());
    let mut daemon = DaemonHarness::start(
        config,
        &[
            ("machine_secret", sensitive::TEST_MACHINE_SECRET),
            ("mqtt_signing_secret", sensitive::TEST_MQTT_SIGNING_SECRET),
            ("machine_maintenance_pin", TEST_MAINTENANCE_PIN_VERIFIER),
        ],
        &[],
    )
    .await
    .expect("start daemon");

    create_payment_code_order(&daemon).await;
    wait_for_scanner_code(&daemon, "SCANNER_READY").await;
    pty.write(b"621234567890123456\r\n").await;
    let failed = wait_for_transaction(&daemon, |tx| {
        tx["paymentCodeAttempt"]["status"] == "failed"
            && tx["paymentCodeAttempt"]["canRetry"] == true
    })
    .await;
    assert_eq!(failed["paymentCodeAttempt"]["source"], "serial_text");

    pty.write(b"621234567890129999\r\n").await;
    let succeeded = wait_for_transaction(&daemon, |tx| {
        tx["nextAction"] == "dispensing"
            && tx["paymentCodeAttempt"]["maskedAuthCode"] == "6212****9999"
    })
    .await;
    assert_eq!(
        succeeded["paymentCodeAttempt"]["maskedAuthCode"],
        "6212****9999"
    );

    daemon.terminate().await;

    let requests = server
        .received_requests()
        .await
        .expect("recorded requests")
        .into_iter()
        .filter(|request| request.url.path() == "/machine-orders/ORD-SCAN/payment-code/submit")
        .collect::<Vec<_>>();
    assert_eq!(requests.len(), 2);
    let first_body: serde_json::Value = requests[0].body_json().expect("first body");
    let second_body: serde_json::Value = requests[1].body_json().expect("second body");
    assert_ne!(first_body["idempotencyKey"], second_body["idempotencyKey"]);
    assert_eq!(first_body["source"], "serial_text");
    assert_eq!(second_body["source"], "serial_text");
    assert_eq!(first_body["scannerHealth"]["online"], true);
    assert_eq!(second_body["scannerHealth"]["online"], true);

    let pool = sqlite::open_readonly(&daemon.state_db_path()).await;
    let db_dump = sqlite::table_text_dump(&pool).await;
    sensitive::assert_absent("sqlite", &db_dump, &[first_raw_code, second_raw_code]);
    assert!(db_dump.contains("6212****3456"));
    assert!(db_dump.contains("6212****9999"));
}

#[tokio::test]
async fn vision_disabled_reports_disabled_status() {
    let _guard = SCANNER_VISION_TEST_LOCK.lock().await;
    let pty = PtyHarness::open();
    let mut config = scanner_config(pty.slave_path.to_string_lossy().to_string());
    config["scannerAdapter"] = serde_json::json!("disabled");
    config["scannerSerialPortPath"] = serde_json::Value::Null;
    config["visionEnabled"] = serde_json::json!(false);
    let mut daemon = DaemonHarness::start(config, &[], &[]).await.expect("start");
    let vision = wait_for_vision_message(&daemon, "disabled").await;
    assert_eq!(vision["enabled"], false);
    assert_eq!(vision["online"], false);
    assert_eq!(vision["message"], "disabled");
    daemon.terminate().await;
}

#[tokio::test]
async fn vision_mock_process_updates_ready_status() {
    let _guard = SCANNER_VISION_TEST_LOCK.lock().await;
    let port = pick_unused_port().expect("vision mock port");
    let vision = spawn_vision_ready_server(port).await;
    let pty = PtyHarness::open();
    let mut config = scanner_config(pty.slave_path.to_string_lossy().to_string());
    config["scannerAdapter"] = serde_json::json!("disabled");
    config["scannerSerialPortPath"] = serde_json::Value::Null;
    config["visionEnabled"] = serde_json::json!(true);
    config["visionWsUrl"] = serde_json::json!(format!("ws://127.0.0.1:{port}/ws"));

    let mut daemon = DaemonHarness::start(config, &[], &[])
        .await
        .expect("start daemon");
    let vision_status = wait_for_vision_ready(&daemon).await;
    assert_eq!(vision_status["enabled"], true);
    assert_eq!(vision_status["online"], true);
    assert_eq!(
        vision_status["latestDiagnosticPayload"]["type"],
        "vision.ready"
    );
    assert_eq!(
        vision_status["latestDiagnosticPayload"]["payload"]["serverName"],
        "test-vision"
    );

    daemon.terminate().await;
    vision.abort();
    let _ = vision.await;
}

async fn spawn_vision_ready_server(port: u16) -> JoinHandle<()> {
    let listener = TcpListener::bind(("127.0.0.1", port))
        .await
        .expect("bind vision test server");
    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.expect("accept vision client");
        let mut socket = accept_async(stream).await.expect("accept vision websocket");
        let _ = socket.next().await;
        let ready = serde_json::json!({
            "protocol": "vem.vision.v1",
            "type": "vision.ready",
            "messageId": "ready-test",
            "timestamp": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            "payload": {
                "serverName": "test-vision",
                "serverVersion": "test",
                "cameraReady": true,
                "modelReady": true,
                "capabilities": ["profile_push"]
            }
        });
        socket
            .send(Message::Text(ready.to_string()))
            .await
            .expect("send vision ready");
        tokio::time::sleep(Duration::from_secs(5)).await;
    })
}

async fn wait_for_vision_message(daemon: &DaemonHarness, expected: &str) -> serde_json::Value {
    for _ in 0..40 {
        let status = daemon.get_json("/v1/vision/status").await;
        if status["message"] == expected {
            return status;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    daemon.get_json("/v1/vision/status").await
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

async fn mock_payment_code_options(server: &MockServer) {
    Mock::given(method("GET"))
        .and(path("/machine-orders/payment-options"))
        .and(header("authorization", "Bearer token-123"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "options": [{
                "optionKey": "payment_code:alipay",
                "providerCode": "alipay",
                "method": "payment_code",
                "displayName": "支付宝付款码",
                "description": "请出示付款码",
                "icon": "alipay",
                "recommended": true,
                "disabled": false,
                "disabledReason": null
            }],
            "defaultOptionKey": "payment_code:alipay",
            "defaultProviderCode": "alipay",
            "serverTime": "2026-05-30T00:00:00.000Z"
        })))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path("/machine-orders/payment-environment-diagnostic"))
        .and(header("authorization", "Bearer token-123"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "environment": "production",
            "readiness": "ready",
            "errorCategory": "none"
        })))
        .mount(server)
        .await;
}

async fn mock_stock_movement_acceptance(server: &MockServer) {
    Mock::given(method("POST"))
        .and(path("/machine-stock-movements"))
        .and(header("authorization", "Bearer token-123"))
        .respond_with(|request: &Request| {
            let payload: serde_json::Value =
                serde_json::from_slice(&request.body).expect("stock movement upload JSON");
            ResponseTemplate::new(200).set_body_json(json!({
                "movementId": payload["movementId"],
                "status": "accepted",
                "acceptedAt": "2026-07-14T00:00:00.000Z"
            }))
        })
        .mount(server)
        .await;
}

async fn prepare_local_sale_view(daemon: &DaemonHarness) {
    let base = daemon.ready.healthz_url.trim_end_matches("/healthz");
    let client = Client::new();
    let session_id = daemon
        .create_maintenance_session(TEST_MAINTENANCE_PIN)
        .await;
    let planogram = client
        .post(format!("{base}/v1/stock/planogram"))
        .header("Authorization", daemon.bearer())
        .header("x-vem-maintenance-session", &session_id)
        .json(&json!({
            "planogramVersion": "PLAN-SCAN",
            "source": "local_seed",
            "appliedBy": "test",
            "slots": [{
                "slotId": "550e8400-e29b-41d4-a716-446655440001",
                "slotCode": "A1",
                "layerNo": 1,
                "cellNo": 1,
                "capacity": 8,
                "parLevel": 6,
                "inventoryId": "550e8400-e29b-41d4-a716-446655440002",
                "variantId": "550e8400-e29b-41d4-a716-446655440003",
                "productId": "550e8400-e29b-41d4-a716-446655440004",
                "productName": "矿泉水",
                "productDescription": null,
                "coverImageUrl": null,
                "categoryId": null,
                "categoryName": null,
                "sku": "WATER-001",
                "size": "550ml",
                "color": null,
                "priceCents": 200,
                "productSortOrder": 1,
                "targetGender": null
            }]
        }))
        .send()
        .await
        .expect("planogram request");
    let planogram_status = planogram.status();
    let planogram_body = planogram.text().await.expect("planogram response body");
    assert_eq!(
        planogram_status,
        reqwest::StatusCode::OK,
        "planogram response: {planogram_body}"
    );

    let attestation = client
        .post(format!("{base}/v1/bring-up/tasks/execute"))
        .header("Authorization", daemon.bearer())
        .header("x-vem-maintenance-session", session_id)
        .json(&json!({
            "contractVersion": 1,
            "taskId": "bring_up.attest_stock",
            "taskVersion": 1,
            "kind": "attest_stock",
            "intent": "record_stock",
            "mutation": {
                "type": "record_stock",
                "attestation": {
                    "attestationId": "ATT-SCAN-READY",
                    "planogramVersion": "PLAN-SCAN",
                    "operatorId": "test",
                    "slots": [{
                        "slotId": "550e8400-e29b-41d4-a716-446655440001",
                        "slotCode": "A1",
                        "sku": "WATER-001",
                        "quantity": 3,
                        "enabled": true
                    }]
                }
            }
        }))
        .send()
        .await
        .expect("attestation request");
    let attestation_status = attestation.status();
    let attestation_body = attestation.text().await.expect("attestation body");
    assert_eq!(
        attestation_status,
        reqwest::StatusCode::CREATED,
        "attestation body: {attestation_body}"
    );
    let sale_view = wait_for_platform_accepted_stock(daemon).await;
    assert_eq!(sale_view["items"][0]["slotSalesState"], "sale_ready");
    assert!(sale_view["items"][0]["saleableStock"].as_i64().unwrap_or(0) > 0);
}

async fn wait_for_platform_accepted_stock(daemon: &DaemonHarness) -> serde_json::Value {
    for _ in 0..60 {
        let sale_view = daemon.get_json("/v1/sale-view").await;
        let sale_ready = sale_view["items"].as_array().is_some_and(|items| {
            items.iter().any(|item| {
                item["slotSalesState"] == "sale_ready"
                    && item["saleableStock"].as_i64().unwrap_or(0) > 0
            })
        });
        if sale_ready {
            // The stock uploader and Bring-Up snapshot are refreshed through
            // separate async paths, so only return when both customer sale
            // stock and the operator cursor agree that Platform accepted it.
            let bring_up = daemon.get_json("/v1/bring-up").await;
            if bring_up["currentTask"]["kind"] != "attest_stock" {
                return sale_view;
            }
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    let bring_up = daemon.get_json("/v1/bring-up").await;
    let sale_view = daemon.get_json("/v1/sale-view").await;
    panic!(
        "Platform did not accept physical stock before scanner sale: bring_up={bring_up}, sale_view={sale_view}"
    );
}

async fn wait_for_sync_connected(daemon: &DaemonHarness) -> serde_json::Value {
    for _ in 0..40 {
        let sync = daemon.get_json("/v1/sync/status").await;
        if sync["mqttConnected"] == true {
            return sync;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    daemon.get_json("/v1/sync/status").await
}

async fn wait_for_hardware_online(daemon: &DaemonHarness) -> serde_json::Value {
    for _ in 0..40 {
        let health = daemon.get_json("/healthz").await;
        if health["hardwareOnline"] == true {
            return health;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    daemon.get_json("/healthz").await
}

async fn create_payment_code_order(daemon: &DaemonHarness) -> serde_json::Value {
    let health = wait_for_hardware_online(daemon).await;
    assert_eq!(health["hardwareOnline"], true, "health: {health}");
    prepare_local_sale_view(daemon).await;
    let sync = wait_for_sync_connected(daemon).await;
    assert_eq!(sync["mqttConnected"], true);
    let base = daemon.ready.healthz_url.trim_end_matches("/healthz");
    let response = Client::new()
        .post(format!("{base}/v1/intents/create-order"))
        .header("Authorization", daemon.bearer())
        .json(&json!({
            "inventoryId": "550e8400-e29b-41d4-a716-446655440002",
            "quantity": 1,
            "planogramVersion": "PLAN-SCAN",
            "slotId": "550e8400-e29b-41d4-a716-446655440001",
            "slotCode": "A1",
            "paymentMethod": "payment_code",
            "paymentProviderCode": "alipay",
            "profileSnapshot": null
        }))
        .send()
        .await
        .expect("create order request");
    let status = response.status();
    let body = response.text().await.expect("create order body");
    assert_eq!(status, reqwest::StatusCode::OK, "create order body: {body}");
    serde_json::from_str(&body).expect("create order json")
}

async fn wait_for_transaction(
    daemon: &DaemonHarness,
    predicate: impl Fn(&serde_json::Value) -> bool,
) -> serde_json::Value {
    for _ in 0..40 {
        let tx = daemon.get_json("/v1/transactions/current").await;
        if predicate(&tx) {
            return tx;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    daemon.get_json("/v1/transactions/current").await
}

async fn wait_for_scanner_code(daemon: &DaemonHarness, code: &str) -> serde_json::Value {
    let base = daemon.ready.healthz_url.trim_end_matches("/healthz");
    let client = Client::new();
    let session_id = daemon
        .create_maintenance_session(TEST_MAINTENANCE_PIN)
        .await;
    for _ in 0..40 {
        let scanner = client
            .get(format!("{base}/v1/scanner/status"))
            .header("Authorization", daemon.bearer())
            .header("x-vem-maintenance-session", &session_id)
            .send()
            .await
            .expect("scanner status with maintenance session")
            .json::<serde_json::Value>()
            .await
            .expect("scanner status JSON");
        if scanner["code"] == code {
            return scanner;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    client
        .get(format!("{base}/v1/scanner/status"))
        .header("Authorization", daemon.bearer())
        .header("x-vem-maintenance-session", session_id)
        .send()
        .await
        .expect("scanner status with maintenance session")
        .json::<serde_json::Value>()
        .await
        .expect("scanner status JSON")
}
