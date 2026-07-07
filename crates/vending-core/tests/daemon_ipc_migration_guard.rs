use std::fs;
use std::path::{Path, PathBuf};

const MIGRATED_DAEMON_IPC_DTO_NAMES: &[&str] = &[
    "CheckoutFlowAction",
    "CurrentTransactionSnapshot",
    "CurrentTransactionSnapshotPaymentCodeAttempt",
    "CurrentTransactionSnapshotVending",
    "CurrentTransactionSnapshotVendingPickupReminder",
    "DispenseProgressObservationStage",
    "PaymentCodeAttemptSummary",
    "PickupReminder",
    "ScannerRuntimeStatus",
    "TransactionSnapshot",
    "TransactionSnapshotPaymentCodeAttempt",
    "TransactionSnapshotPickupReminder",
    "TransactionSnapshotVendingSummary",
    "VendingSummary",
];

fn daemon_ipc_dto_name_offenders(path: &str, source: &str) -> Vec<String> {
    MIGRATED_DAEMON_IPC_DTO_NAMES
        .iter()
        .filter(|name| declares_public_type(source, name))
        .map(|name| format!("{path}:{name}"))
        .collect()
}

fn declares_public_type(source: &str, name: &str) -> bool {
    ["struct", "enum", "type"].into_iter().any(|kind| {
        [
            format!("pub {kind} {name}"),
            format!("pub(crate) {kind} {name}"),
        ]
        .into_iter()
        .any(|declaration| source.contains(&declaration))
    })
}

fn rust_source_files(dir: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    for entry in fs::read_dir(dir).expect("read source directory") {
        let path = entry.expect("read source entry").path();
        if path.is_dir() {
            files.extend(rust_source_files(&path));
        } else if path.extension().is_some_and(|extension| extension == "rs") {
            files.push(path);
        }
    }
    files
}

#[test]
fn vending_core_keeps_migrated_daemon_ipc_boundary_dtos_out_of_core_runtime() {
    let crate_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let source_root = crate_root.join("src");
    let offenders: Vec<String> = rust_source_files(&source_root)
        .into_iter()
        .flat_map(|path| {
            let source = fs::read_to_string(&path).expect("read Rust source");
            let relative = path
                .strip_prefix(&crate_root)
                .expect("source path is under crate root")
                .to_string_lossy()
                .replace('\\', "/");
            daemon_ipc_dto_name_offenders(&relative, &source)
        })
        .collect();

    assert_eq!(offenders, Vec::<String>::new());
}

#[test]
fn detects_manual_daemon_ipc_dto_names_for_migrated_surfaces() {
    let offenders = daemon_ipc_dto_name_offenders(
        "src/domain.rs",
        r#"
        pub enum CheckoutFlowAction {}
        pub struct CurrentTransactionSnapshot;
        pub struct CurrentTransactionSnapshotVending;
        pub struct PaymentCodeAttemptSummary;
        pub struct ScannerRuntimeStatus;
        pub struct TransactionSnapshot;
        pub(crate) struct PickupReminder;
        pub struct InternalCurrentTransactionSnapshot;
        "#,
    );

    assert_eq!(
        offenders,
        [
            "src/domain.rs:CheckoutFlowAction",
            "src/domain.rs:CurrentTransactionSnapshot",
            "src/domain.rs:CurrentTransactionSnapshotVending",
            "src/domain.rs:PaymentCodeAttemptSummary",
            "src/domain.rs:PickupReminder",
            "src/domain.rs:ScannerRuntimeStatus",
            "src/domain.rs:TransactionSnapshot",
        ]
    );
}
