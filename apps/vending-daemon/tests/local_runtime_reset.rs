use vending_daemon::local_runtime_reset::{
    prepare_factory_runtime, FactoryPreparationError, FactoryPreparationMode,
    LocalRuntimeEvidenceStatus,
};

#[tokio::test]
async fn factory_preparation_accepts_a_clean_local_runtime_host() {
    let temp = tempfile::tempdir().expect("temp");
    let data_dir = temp.path().join("VEM").join("vending-daemon");

    let evidence = prepare_factory_runtime(&data_dir, FactoryPreparationMode::CheckCleanHost)
        .await
        .expect("clean host evidence");

    assert_eq!(evidence.status, LocalRuntimeEvidenceStatus::Clean);
    assert!(evidence.found.is_empty());
    assert!(evidence.cleared.is_empty());
    assert!(evidence
        .skipped
        .iter()
        .any(|item| item.category == "platform_business_data"));
    assert!(evidence
        .skipped
        .iter()
        .any(|item| item.category == "keyring_secret_material"));
    assert!(evidence
        .preserved
        .iter()
        .any(|item| item.category == "factory_manifest"));
}

#[tokio::test]
async fn factory_preparation_fails_fast_when_old_local_runtime_state_exists() {
    let temp = tempfile::tempdir().expect("temp");
    let runtime_root = temp.path().join("VEM");
    let data_dir = runtime_root.join("vending-daemon");
    seed_dirty_runtime(&runtime_root, &data_dir).await;

    let err = prepare_factory_runtime(&data_dir, FactoryPreparationMode::CheckCleanHost)
        .await
        .expect_err("dirty host should fail");

    let FactoryPreparationError::DirtyHost { evidence } = err else {
        panic!("expected dirty host error");
    };
    assert_eq!(evidence.status, LocalRuntimeEvidenceStatus::Dirty);

    for category in [
        "local_machine_identity",
        "provisioning_profile_cache",
        "protected_secret_material",
        "daemon_state",
        "prior_evidence",
        "local_bring_up_settings",
    ] {
        assert!(
            evidence.found.iter().any(|item| item.category == category),
            "missing {category} in {:#?}",
            evidence.found
        );
    }
}

#[tokio::test]
async fn factory_preparation_detects_file_secret_material_in_data_dir() {
    let temp = tempfile::tempdir().expect("temp");
    let runtime_root = temp.path().join("VEM");
    let data_dir = runtime_root.join("vending-daemon");
    let secret_value = "do-not-print-this-machine-secret";
    tokio::fs::create_dir_all(data_dir.join("secrets"))
        .await
        .expect("file secret dir");
    tokio::fs::write(
        data_dir.join("secrets").join("machine_secret"),
        secret_value,
    )
    .await
    .expect("file secret");

    let err = prepare_factory_runtime(&data_dir, FactoryPreparationMode::CheckCleanHost)
        .await
        .expect_err("file secret should make host dirty");

    let FactoryPreparationError::DirtyHost { evidence } = err else {
        panic!("expected dirty host error");
    };
    assert_eq!(evidence.status, LocalRuntimeEvidenceStatus::Dirty);
    assert!(evidence
        .found
        .iter()
        .any(|item| item.category == "protected_secret_material"));
    let evidence_text = serde_json::to_string(&evidence).expect("evidence json");
    assert!(!evidence_text.contains(secret_value));

    let evidence = prepare_factory_runtime(&data_dir, FactoryPreparationMode::ResetLocalRuntime)
        .await
        .expect("reset evidence");

    assert_eq!(evidence.status, LocalRuntimeEvidenceStatus::Reset);
    assert!(evidence
        .cleared
        .iter()
        .any(|item| item.category == "protected_secret_material"));
    assert!(
        tokio::fs::try_exists(data_dir.join("secrets").join("machine_secret"))
            .await
            .is_ok_and(|exists| !exists)
    );
}

#[tokio::test]
async fn explicit_reset_clears_local_runtime_state_and_keeps_factory_manifest() {
    let temp = tempfile::tempdir().expect("temp");
    let runtime_root = temp.path().join("VEM");
    let data_dir = runtime_root.join("vending-daemon");
    seed_dirty_runtime(&runtime_root, &data_dir).await;
    tokio::fs::create_dir_all(runtime_root.join("factory"))
        .await
        .expect("factory");
    tokio::fs::write(
        runtime_root.join("factory").join("factory-manifest.json"),
        r#"{"layoutVersion":1}"#,
    )
    .await
    .expect("manifest");

    let evidence = prepare_factory_runtime(&data_dir, FactoryPreparationMode::ResetLocalRuntime)
        .await
        .expect("reset evidence");

    assert_eq!(evidence.status, LocalRuntimeEvidenceStatus::Reset);
    for category in [
        "local_machine_identity",
        "provisioning_profile_cache",
        "protected_secret_material",
        "daemon_state",
        "prior_evidence",
        "local_bring_up_settings",
    ] {
        assert!(
            evidence
                .cleared
                .iter()
                .any(|item| item.category == category),
            "missing cleared {category} in {:#?}",
            evidence.cleared
        );
    }
    assert!(tokio::fs::try_exists(&data_dir)
        .await
        .is_ok_and(|exists| !exists));
    assert!(tokio::fs::try_exists(runtime_root.join("provisioning"))
        .await
        .is_ok_and(|exists| !exists));
    assert!(tokio::fs::try_exists(runtime_root.join("secrets"))
        .await
        .is_ok_and(|exists| !exists));
    assert!(tokio::fs::try_exists(runtime_root.join("evidence"))
        .await
        .is_ok_and(|exists| !exists));
    assert!(tokio::fs::try_exists(runtime_root.join("bringup"))
        .await
        .is_ok_and(|exists| !exists));
    assert!(
        tokio::fs::try_exists(runtime_root.join("factory").join("factory-manifest.json"))
            .await
            .is_ok_and(|exists| exists)
    );
}

#[tokio::test]
async fn reset_does_not_touch_platform_business_data() {
    let temp = tempfile::tempdir().expect("temp");
    let runtime_root = temp.path().join("VEM");
    let data_dir = runtime_root.join("vending-daemon");
    seed_dirty_runtime(&runtime_root, &data_dir).await;
    let platform_records = runtime_root.join("platform-business-records");
    tokio::fs::create_dir_all(&platform_records)
        .await
        .expect("platform records");
    tokio::fs::write(
        platform_records.join("orders-inventory-payments-audit.json"),
        r#"{"must":"remain"}"#,
    )
    .await
    .expect("platform data");

    let evidence = prepare_factory_runtime(&data_dir, FactoryPreparationMode::ResetLocalRuntime)
        .await
        .expect("reset evidence");

    assert!(
        tokio::fs::try_exists(platform_records.join("orders-inventory-payments-audit.json"))
            .await
            .is_ok_and(|exists| exists)
    );
    assert!(!evidence
        .cleared
        .iter()
        .any(|item| item.category == "platform_business_data"));
    assert!(evidence
        .skipped
        .iter()
        .any(|item| item.category == "platform_business_data"));
}

#[tokio::test]
async fn factory_preparation_cli_resets_and_prints_structured_evidence() {
    let temp = tempfile::tempdir().expect("temp");
    let runtime_root = temp.path().join("VEM");
    let data_dir = runtime_root.join("vending-daemon");
    seed_dirty_runtime(&runtime_root, &data_dir).await;

    let output = assert_cmd::Command::cargo_bin("vending-daemon")
        .expect("binary")
        .arg("prepare-factory-runtime")
        .arg("--data-dir")
        .arg(&data_dir)
        .arg("--reset-local-runtime")
        .output()
        .expect("run cli");

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let evidence: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("structured evidence");
    assert_eq!(evidence["status"], "reset");
    assert!(evidence["cleared"]
        .as_array()
        .expect("cleared")
        .iter()
        .any(|item| item["category"] == "daemon_state"));
    assert!(tokio::fs::try_exists(&data_dir)
        .await
        .is_ok_and(|exists| !exists));
}

#[tokio::test]
async fn factory_preparation_cli_top_level_data_dir_checks_that_dir() {
    let temp = tempfile::tempdir().expect("temp");
    let runtime_root = temp.path().join("VEM");
    let data_dir = runtime_root.join("vending-daemon");
    seed_dirty_runtime(&runtime_root, &data_dir).await;
    let default_data_home = temp.path().join("default-data-home");

    let output = assert_cmd::Command::cargo_bin("vending-daemon")
        .expect("binary")
        .env_remove("VEM_DAEMON_DATA_DIR")
        .env("XDG_DATA_HOME", &default_data_home)
        .arg("--data-dir")
        .arg(&data_dir)
        .arg("prepare-factory-runtime")
        .output()
        .expect("run cli");

    assert_eq!(
        output.status.code(),
        Some(2),
        "stdout: {}\nstderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let evidence: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("structured evidence");
    assert_eq!(evidence["status"], "dirty");
    assert_eq!(evidence["dataDir"], path_string(&data_dir));
    assert!(evidence["found"]
        .as_array()
        .expect("found")
        .iter()
        .any(|item| item["category"] == "local_machine_identity"));
}

#[tokio::test]
async fn factory_preparation_cli_rejects_ambiguous_data_dirs() {
    let temp = tempfile::tempdir().expect("temp");
    let top_level_data_dir = temp.path().join("top").join("vending-daemon");
    let command_data_dir = temp.path().join("command").join("vending-daemon");

    let output = assert_cmd::Command::cargo_bin("vending-daemon")
        .expect("binary")
        .env_remove("VEM_DAEMON_DATA_DIR")
        .arg("--data-dir")
        .arg(&top_level_data_dir)
        .arg("prepare-factory-runtime")
        .arg("--data-dir")
        .arg(&command_data_dir)
        .output()
        .expect("run cli");

    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("ambiguous data dir"),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

async fn seed_dirty_runtime(runtime_root: &std::path::Path, data_dir: &std::path::Path) {
    tokio::fs::create_dir_all(data_dir.join("logs"))
        .await
        .expect("daemon dir");
    tokio::fs::write(
        data_dir.join("machine-config.json"),
        r#"{"machineCode":"VEM-OLD-01"}"#,
    )
    .await
    .expect("machine config");
    tokio::fs::write(data_dir.join("state.db"), "old daemon state")
        .await
        .expect("state");
    tokio::fs::write(data_dir.join("logs").join("machine-events.jsonl"), "{}\n")
        .await
        .expect("logs");

    tokio::fs::create_dir_all(runtime_root.join("provisioning"))
        .await
        .expect("provisioning");
    tokio::fs::write(
        runtime_root
            .join("provisioning")
            .join("profile-cache-summary.json"),
        "{}",
    )
    .await
    .expect("profile cache");

    tokio::fs::create_dir_all(runtime_root.join("secrets"))
        .await
        .expect("secrets");
    tokio::fs::write(
        runtime_root.join("secrets").join("machine_secret.dpapi"),
        "blob",
    )
    .await
    .expect("secret");

    tokio::fs::create_dir_all(runtime_root.join("evidence"))
        .await
        .expect("evidence");
    tokio::fs::write(runtime_root.join("evidence").join("acceptance.json"), "{}")
        .await
        .expect("evidence file");

    tokio::fs::create_dir_all(runtime_root.join("bringup"))
        .await
        .expect("bringup");
    tokio::fs::write(
        runtime_root.join("bringup").join("local-settings.json"),
        "{}",
    )
    .await
    .expect("settings");
}

fn path_string(path: &std::path::Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}
