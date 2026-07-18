#![cfg(unix)]

mod support;

use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

use support::pty::PtyHarness;
use tokio::sync::{broadcast, mpsc, Barrier};
use tokio_util::sync::CancellationToken;
use vending_daemon::{
    backend::BackendClient,
    events::DaemonEvent,
    scanner::{ScannerRuntime, ScannerRuntimeConfig},
    shutdown::run_payment_code_watcher,
    state::{LocalStateStore, OrderSessionUpsert},
    transaction::{PaymentCodeScanArmer, TransactionStateMachine},
};

struct RuntimeFixture {
    api_base_url: String,
    machine_code: String,
    machine_secret: String,
    order_b: String,
    order_c: String,
    order_d: String,
}

impl RuntimeFixture {
    fn from_env() -> Option<Self> {
        Some(Self {
            api_base_url: std::env::var("VEM_PAYMENT_CODE_RUNTIME_API_BASE_URL").ok()?,
            machine_code: std::env::var("VEM_PAYMENT_CODE_RUNTIME_MACHINE_CODE").ok()?,
            machine_secret: std::env::var("VEM_PAYMENT_CODE_RUNTIME_MACHINE_SECRET").ok()?,
            order_b: std::env::var("VEM_PAYMENT_CODE_RUNTIME_ORDER_B").ok()?,
            order_c: std::env::var("VEM_PAYMENT_CODE_RUNTIME_ORDER_C").ok()?,
            order_d: std::env::var("VEM_PAYMENT_CODE_RUNTIME_ORDER_D").ok()?,
        })
    }
}

async fn seed_waiting_payment(state: &LocalStateStore, order_no: &str) {
    state
        .upsert_order_session(OrderSessionUpsert {
            order_no,
            payment_method: "payment_code",
            payment_provider: Some("mock"),
            items_json: serde_json::json!([]),
            status: "waiting_payment",
            next_action: "wait_payment",
            payment_attempt_json: None,
            recovery_strategy: "local",
            last_backend_status_json: None,
            last_error: None,
        })
        .await
        .expect("seed waiting payment");
}

async fn wait_for_attempt_status(state: &LocalStateStore, order_no: &str, expected: &str) {
    for _ in 0..80 {
        if state
            .load_attempt_json(order_no)
            .await
            .expect("load local payment-code attempt")
            .is_some_and(|attempt| {
                attempt.get("status").and_then(|value| value.as_str()) == Some(expected)
            })
        {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let attempt = state
        .load_attempt_json(order_no)
        .await
        .expect("load local payment-code attempt after timeout");
    panic!("payment-code attempt for {order_no} did not reach {expected}: {attempt:?}");
}

#[tokio::test]
async fn pty_scanner_watcher_submits_only_current_frames_to_the_real_service_api() {
    let Some(fixture) = RuntimeFixture::from_env() else {
        return;
    };

    let temp = tempfile::tempdir().expect("temp");
    let state = LocalStateStore::open(&temp.path().join("state.db"))
        .await
        .expect("state");
    let mut scanner_pty = PtyHarness::open();
    seed_waiting_payment(&state, &fixture.order_b).await;

    let backend = Arc::new(BackendClient::new(fixture.api_base_url));
    backend
        .authenticate(&fixture.machine_code, &fixture.machine_secret)
        .await
        .expect("authenticate real Service API machine client");
    let (events_tx, mut events_rx) = broadcast::channel(32);
    let (raw_tx, raw_rx) = mpsc::channel(8);
    let shutdown = CancellationToken::new();
    let armer = PaymentCodeScanArmer::default();
    let guard_entered = Arc::new(Barrier::new(2));
    let guard_release = Arc::new(Barrier::new(2));
    let guard_blocks_once = Arc::new(AtomicBool::new(true));
    let guard: vending_daemon::transaction::PaymentCodeSubmitGuard = {
        let guard_entered = guard_entered.clone();
        let guard_release = guard_release.clone();
        let guard_blocks_once = guard_blocks_once.clone();
        Arc::new(move |_| {
            let guard_entered = guard_entered.clone();
            let guard_release = guard_release.clone();
            let should_block = guard_blocks_once.swap(false, Ordering::SeqCst);
            Box::pin(async move {
                if should_block {
                    guard_entered.wait().await;
                    guard_release.wait().await;
                }
                Ok(())
            })
        })
    };
    let machine = TransactionStateMachine::new(
        state.clone(),
        backend,
        Some(fixture.machine_code.clone()),
        events_tx.clone(),
    )
    .with_payment_code_scan_armer(armer.clone())
    .with_payment_code_submit_guard(guard);
    let watcher = tokio::spawn(run_payment_code_watcher(raw_rx, machine, shutdown.clone()));
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
        armer.clone(),
    );
    let scanner = tokio::spawn(runtime.run());

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

    let code = b"621234567890123456";
    armer.arm_for_order("replaced-arm").await;
    scanner_pty.write(&code[..10]).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    armer.arm_for_order(&fixture.order_b).await;
    scanner_pty.write(b"\r\n").await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(
        guard_blocks_once.load(Ordering::SeqCst),
        "partial bytes from a replaced arm must not enter the watcher"
    );

    scanner_pty
        .write(&[code.as_slice(), b"\r\n"].concat())
        .await;
    tokio::time::timeout(Duration::from_secs(2), guard_entered.wait())
        .await
        .expect("B scanner frame did not reach the production submit guard");
    state
        .upsert_order_session(OrderSessionUpsert {
            order_no: &fixture.order_b,
            payment_method: "payment_code",
            payment_provider: Some("mock"),
            items_json: serde_json::json!([]),
            status: "canceled",
            next_action: "closed",
            payment_attempt_json: None,
            recovery_strategy: "local",
            last_backend_status_json: None,
            last_error: None,
        })
        .await
        .expect("cancel B while the watcher is submitting");
    tokio::time::timeout(Duration::from_secs(2), guard_release.wait())
        .await
        .expect("canceled B submission did not leave the submit guard");

    seed_waiting_payment(&state, &fixture.order_c).await;
    armer.arm_for_order(&fixture.order_c).await;
    scanner_pty.write(b"\xffunhealthy-frame\r\n").await;
    scanner_pty
        .write(&[code.as_slice(), b"\r\n"].concat())
        .await;
    wait_for_attempt_status(&state, &fixture.order_c, "succeeded").await;
    scanner_pty
        .write(&[code.as_slice(), b"\r\n"].concat())
        .await;
    tokio::time::sleep(Duration::from_millis(100)).await;

    seed_waiting_payment(&state, &fixture.order_d).await;
    armer.arm_for_order(&fixture.order_d).await;
    scanner_pty
        .write(&[code.as_slice(), b"\r\n"].concat())
        .await;
    wait_for_attempt_status(&state, &fixture.order_d, "submitting").await;
    drop(scanner_pty);
    wait_for_attempt_status(&state, &fixture.order_d, "succeeded").await;

    shutdown.cancel();
    assert!(scanner.await.expect("scanner task join").is_ok());
    assert!(watcher.await.expect("watcher task join").is_ok());
}
