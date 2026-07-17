#![cfg(unix)]

mod support;

use std::time::Duration;

use support::{process::DaemonHarness, pty::PtyHarness};
use tokio::sync::{broadcast, mpsc};
use tokio_util::sync::CancellationToken;
use vending_daemon::{
    events::DaemonEvent,
    scanner::{ScannerRuntime, ScannerRuntimeConfig},
};

#[tokio::test]
async fn serial_text_scanner_pty_rejects_invalid_frame_and_emits_only_masked_event_data() {
    let mut scanner_pty = PtyHarness::open();
    let (raw_tx, mut raw_rx) = mpsc::channel(4);
    let (events_tx, mut events_rx) = broadcast::channel(8);
    let shutdown = CancellationToken::new();
    let runtime = ScannerRuntime::new(
        ScannerRuntimeConfig {
            port_path: Some(scanner_pty.slave_path.to_string_lossy().to_string()),
            baud_rate: 9_600,
            source: vending_core::scanner::PAYMENT_CODE_SOURCE_SERIAL_TEXT.to_string(),
            frame_suffix: vending_core::scanner::ScannerFrameSuffix::Crlf,
        },
        raw_tx,
        events_tx,
        shutdown.clone(),
    );
    let task = tokio::spawn(runtime.run());

    loop {
        let event = tokio::time::timeout(Duration::from_secs(2), events_rx.recv())
            .await
            .expect("scanner readiness timeout")
            .expect("scanner event channel closed");
        if matches!(event, DaemonEvent::ScannerHealthChanged { ref snapshot, .. } if snapshot.code == "SCANNER_READY")
        {
            break;
        }
    }

    scanner_pty
        .write(b"\xffinvalid\r\n621234567890123456\r\n")
        .await;
    let raw = tokio::time::timeout(Duration::from_secs(2), raw_rx.recv())
        .await
        .expect("valid scanner frame timeout")
        .expect("scanner raw channel closed");
    assert_eq!(raw.auth_code, "621234567890123456");
    assert_eq!(raw.masked_code, "6212****3456");

    let event = loop {
        let event = tokio::time::timeout(Duration::from_secs(2), events_rx.recv())
            .await
            .expect("scanner event timeout")
            .expect("scanner event channel closed");
        if matches!(event, DaemonEvent::ScannerCode { .. }) {
            break event;
        }
    };
    let public_event = serde_json::to_string(&event).expect("serialize public event");
    assert!(public_event.contains("6212****3456"));
    assert!(!public_event.contains("621234567890123456"));
    assert!(!public_event.contains("authCode"));

    shutdown.cancel();
    assert!(task.await.expect("scanner task join").is_ok());
}

#[tokio::test]
async fn daemon_reports_vision_disabled_from_the_accepted_profile_without_a_pin_gate() {
    let fixture = serde_json::json!({
        "machineCode": "MACHINE-VISION",
        "apiBaseUrl": "http://127.0.0.1:9/api",
        "mqttUrl": "mqtt://127.0.0.1:1883",
        "hardwareModel": "vem-test-24",
        "hardwareSlotTopology": { "identity": "vem-test-24", "version": "2026-07-test" },
        "hardwareProfile": {
            "profile": "production",
            "controller": { "required": true, "protocol": "vem-vending-controller" },
            "paymentScanner": { "required": true, "supportsPaymentCode": true },
            "vision": { "required": false, "supportsRecommendations": false }
        }
    });
    let mut daemon = DaemonHarness::start(fixture, &[], &[])
        .await
        .expect("start daemon");
    let vision = daemon.get_json("/v1/vision/status").await;
    assert_eq!(vision["enabled"], false);
    assert_eq!(vision["online"], false);
    assert_eq!(vision["message"], "disabled");

    let scanner = daemon.get_json("/v1/scanner/status").await;
    assert!(
        scanner.is_object(),
        "scanner status needs no maintenance session"
    );
    daemon.terminate().await;
}

#[tokio::test]
async fn daemon_starts_vision_when_recommendations_are_supported_but_vision_is_not_required() {
    let fixture = serde_json::json!({
        "machineCode": "MACHINE-VISION-RECOMMENDATIONS",
        "apiBaseUrl": "http://127.0.0.1:9/api",
        "mqttUrl": "mqtt://127.0.0.1:1883",
        "hardwareModel": "vem-test-24",
        "hardwareSlotTopology": { "identity": "vem-test-24", "version": "2026-07-test" },
        "hardwareProfile": {
            "profile": "production",
            "controller": { "required": true, "protocol": "vem-vending-controller" },
            "paymentScanner": { "required": true, "supportsPaymentCode": true },
            "vision": { "required": false, "supportsRecommendations": true }
        }
    });
    let mut daemon = DaemonHarness::start(fixture, &[], &[])
        .await
        .expect("start daemon");

    let vision = daemon.get_json("/v1/vision/status").await;
    assert_eq!(vision["enabled"], true);
    assert_ne!(vision["message"], "disabled");

    daemon.terminate().await;
}
