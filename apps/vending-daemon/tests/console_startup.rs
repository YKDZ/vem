mod support;

use support::{process::DaemonHarness, sqlite};

fn unclaimed_bootstrap_fixture() -> serde_json::Value {
    serde_json::json!({
        "machineCode": null,
        "apiBaseUrl": "http://127.0.0.1:9/api",
        "hardwareModel": "vem-prod-24",
        "hardwareSlotTopology": { "identity": "vem-prod-24", "version": "2026-07-test" }
    })
}

#[tokio::test]
async fn console_startup_writes_ready_file_and_starts_an_unclaimed_runtime() {
    let mut daemon = DaemonHarness::start(unclaimed_bootstrap_fixture(), &[], &[])
        .await
        .expect("start daemon");
    assert!(daemon.ready.healthz_url.starts_with("http://127.0.0.1:"));
    assert!(daemon.ready.readyz_url.starts_with("http://127.0.0.1:"));
    assert!(!daemon.ready.ipc_token.is_empty());

    let runtime = daemon.get_json("/v1/runtime-configuration").await;
    assert_eq!(runtime["profileRefresh"]["status"], "unclaimed");
    assert!(runtime["sourceDocuments"]["profileCache"].is_null());

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
