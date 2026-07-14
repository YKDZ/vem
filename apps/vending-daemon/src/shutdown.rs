use std::future::Future;
use std::net::{IpAddr, SocketAddr};
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use tokio::{
    sync::{broadcast, mpsc},
    time,
};
use tokio_util::sync::CancellationToken;

use crate::{
    backend::BackendClient,
    config::{self, ConfigStore},
    events::DaemonEvent,
    hardware::HardwareSupervisor,
    ipc::{self, IpcContext},
    mqtt::MqttSyncRuntime,
    runtime::{DaemonRuntime, RuntimeStartInput},
    scanner::ScannerRuntime,
    secret,
    state::store::{MachinePlanogramInput, MachinePlanogramSlotInput},
    state::LocalStateStore,
    stock_upload::StockMovementUploadRuntime,
    transaction::{is_active_transaction, TransactionStateMachine},
    vision::VisionSupervisor,
};

const PLATFORM_STOCK_SYNC_INTERVAL: std::time::Duration = std::time::Duration::from_secs(15);

#[derive(Debug, Clone)]
pub struct ConsoleRunConfig {
    pub data_dir: Option<PathBuf>,
    pub bind: SocketAddr,
    pub print_ready_file: Option<PathBuf>,
}

impl Default for ConsoleRunConfig {
    fn default() -> Self {
        Self {
            data_dir: None,
            bind: SocketAddr::new(IpAddr::V4(std::net::Ipv4Addr::LOCALHOST), 7891),
            print_ready_file: None,
        }
    }
}

pub fn default_ready_file_path(data_dir: &Path) -> PathBuf {
    data_dir.join("daemon-ready.json")
}

pub async fn run_console(config: ConsoleRunConfig) -> Result<(), String> {
    run_console_with_token(config, CancellationToken::new()).await
}

pub async fn run_console_with_token(
    config: ConsoleRunConfig,
    external_shutdown: CancellationToken,
) -> Result<(), String> {
    supervise_runtime_cycles(&external_shutdown, || {
        run_console_cycle(config.clone(), external_shutdown.clone())
    })
    .await
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ConsoleCycleExit {
    Stop,
    Reconfigure,
}

async fn supervise_runtime_cycles<F, Fut>(
    external_shutdown: &CancellationToken,
    mut run_cycle: F,
) -> Result<(), String>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<ConsoleCycleExit, String>>,
{
    loop {
        match run_cycle().await? {
            ConsoleCycleExit::Stop => return Ok(()),
            ConsoleCycleExit::Reconfigure if external_shutdown.is_cancelled() => return Ok(()),
            ConsoleCycleExit::Reconfigure => {}
        }
    }
}

async fn run_console_cycle(
    config: ConsoleRunConfig,
    external_shutdown: CancellationToken,
) -> Result<ConsoleCycleExit, String> {
    let data_dir = config::resolve_data_dir(config.data_dir)?;
    tokio::fs::create_dir_all(&data_dir)
        .await
        .map_err(|error| format!("create data dir failed: {error}"))?;

    let state = LocalStateStore::open(&data_dir.join("state.db"))
        .await
        .map_err(|error| error.to_string())?;
    let secret_store = secret::default_secret_store(data_dir.clone());
    let config_store = std::sync::Arc::new(ConfigStore::new(
        data_dir.clone(),
        state.clone(),
        secret_store,
    ));
    config_store
        .import_factory_maintenance_pin_verifier()
        .await
        .map_err(|error| format!("factory maintenance PIN verifier import failed: {error}"))?;
    config_store
        .import_factory_bootstrap_capability_verifier()
        .await
        .map_err(|error| format!("factory bootstrap capability verifier import failed: {error}"))?;
    config_store
        .migrate_legacy_raw_maintenance_pin()
        .await
        .map_err(|error| format!("legacy maintenance PIN migration failed: {error}"))?;
    config_store
        .recover_maintenance_from_cache()
        .await
        .map_err(|error| format!("secure decommission startup recovery failed: {error}"))?;

    let runtime = DaemonRuntime::start(RuntimeStartInput {
        state: state.clone(),
        config_store: config_store.clone(),
        data_dir: data_dir.clone(),
    })
    .await
    .map_err(|error| format!("runtime start failed: {error}"))?;
    let runtime_config = runtime.config.clone();
    let runtime_secrets = config_store
        .runtime_secrets()
        .await
        .map_err(|error| format!("runtime secrets load failed: {error}"))?;

    let hardware = HardwareSupervisor::from_config_with_protocol_log(
        &runtime_config.public,
        Some(data_dir.join("logs").join("serial-protocol.jsonl")),
    )
    .map_err(|error| format!("hardware config invalid: {error}"))?;

    let (tx_raw, rx_raw) = mpsc::channel(16);
    let (events_tx, _) = broadcast::channel(64);
    let backend = Arc::new(BackendClient::new(
        runtime_config.public.api_base_url.clone(),
    ));
    if let (Some(machine_code), Some(secret)) = (
        runtime_config.public.machine_code.as_deref(),
        runtime_secrets.machine_secret.as_deref(),
    ) {
        let _ = backend.authenticate(machine_code, secret).await;
    }
    let ui_status_cache = ipc::RuntimeStatusCache::new(&runtime_config.public, state.clone()).await;
    let payment_code_submit_guard =
        ipc::local_payment_code_submit_guard(ui_status_cache.clone(), state.clone());
    let transaction = TransactionStateMachine::new(
        state.clone(),
        backend.clone(),
        runtime_config.public.machine_code.clone(),
        events_tx.clone(),
    )
    .with_payment_code_submit_guard(payment_code_submit_guard);
    let ui = ipc::UiRuntimeServices {
        backend: backend.clone(),
        transaction,
        status_cache: ui_status_cache,
    };
    let ipc_token = ipc::load_or_create_ipc_token(&data_dir)
        .await
        .map_err(|error| format!("ipc token init failed: {error}"))?;

    let print_ready_file = config
        .print_ready_file
        .as_ref()
        .cloned()
        .unwrap_or_else(|| default_ready_file_path(&data_dir));

    let ipc_ctx = IpcContext {
        data_dir: data_dir.clone(),
        token: ipc_token.clone(),
        config_store: config_store.clone(),
        state: state.clone(),
        hardware: hardware.clone(),
        events: events_tx.clone(),
        runtime_tx: tx_raw.clone(),
        disk_pressure_probe: Arc::new(crate::health::DataDirDiskPressureProbe::from_env()),
        network_adapter: crate::network::adapter_from_env(),
        ui,
        background_shutdown: CancellationToken::new(),
        bring_up_execution_lock: Arc::new(tokio::sync::Mutex::new(())),
        maintenance_authorization: Arc::new(ipc::DaemonMaintenanceAuthorization::new(
            config_store.clone(),
        )),
    };
    let (ipc_handle, ipc_task) = ipc::run_server(config.bind, ipc_ctx.clone())
        .await
        .map_err(|error| format!("ipc failed: {error}"))?;

    write_ready_file(&print_ready_file, ipc_handle.addr, &ipc_token).await?;

    let stop_token = runtime.shutdown_token();
    let cache_updates = tokio::spawn(cache_daemon_events(
        events_tx.subscribe(),
        ipc_ctx.ui.status_cache.clone(),
        Some(stop_token.clone()),
    ));
    let scanner_runtime = ScannerRuntime::from_config(
        &runtime_config.public,
        tx_raw.clone(),
        events_tx.clone(),
        stop_token.clone(),
    );
    let scanner = tokio::spawn(scanner_runtime.run());
    let payment_watcher = tokio::spawn(run_payment_code_watcher(PaymentCodeWatcherInput {
        rx_raw,
        state: state.clone(),
        events: events_tx.clone(),
        status_cache: ipc_ctx.ui.status_cache.clone(),
        machine_code: runtime_config.public.machine_code.clone(),
        api_base_url: runtime_config.public.api_base_url.clone(),
        machine_secret: runtime_secrets.machine_secret.clone(),
        shutdown: stop_token.clone(),
    }));
    let hardware_health = tokio::spawn(run_hardware_health_watcher(
        hardware.clone(),
        state.clone(),
        ipc_ctx.ui.status_cache.clone(),
        stop_token.clone(),
    ));
    let stock_upload = tokio::spawn(
        StockMovementUploadRuntime::new(state.clone(), backend.clone(), stop_token.clone()).run(),
    );
    let platform_stock_sync = tokio::spawn(run_platform_stock_sync_watcher(
        config_store.clone(),
        state.clone(),
        backend.clone(),
        runtime_config.public.machine_code.clone(),
        stop_token.clone(),
    ));

    let vision = VisionSupervisor::new(runtime_config.public.clone());
    let vision_events = events_tx.clone();
    let vision_stop = stop_token.clone();
    tokio::spawn(async move {
        // 视觉服务由任务计划程序在用户登录后才启动，daemon 作为系统服务先行启动，
        // 所以需要带退避重试，直到视觉服务就绪或 daemon 停止。
        let mut backoff_ms = 2_000_u64;
        loop {
            let snapshot = match vision.start().await {
                Ok(snapshot) if snapshot.online || !snapshot.enabled => {
                    // 成功或已禁用，发布状态后退出循环
                    let _ = vision_events.send(DaemonEvent::VisionChanged {
                        event_id: uuid::Uuid::new_v4().simple().to_string(),
                        updated_at: crate::state::store::now_iso(),
                        enabled: snapshot.enabled,
                        online: snapshot.online,
                        message: snapshot.message,
                        latest_diagnostic_payload: snapshot.latest_diagnostic_payload,
                    });
                    return;
                }
                Ok(snapshot) => snapshot,
                Err(error) => crate::vision::VisionRuntimeSnapshot::failed(error),
            };
            // 发布当前（离线）状态
            let _ = vision_events.send(DaemonEvent::VisionChanged {
                event_id: uuid::Uuid::new_v4().simple().to_string(),
                updated_at: crate::state::store::now_iso(),
                enabled: snapshot.enabled,
                online: snapshot.online,
                message: snapshot.message,
                latest_diagnostic_payload: snapshot.latest_diagnostic_payload,
            });
            // 退避等待，最长 30 秒
            tokio::select! {
                _ = vision_stop.cancelled() => return,
                _ = tokio::time::sleep(std::time::Duration::from_millis(backoff_ms)) => {
                    backoff_ms = (backoff_ms * 2).min(30_000);
                }
            }
        }
    });

    let mut tasks = vec![
        cache_updates,
        scanner,
        payment_watcher,
        hardware_health,
        stock_upload,
        platform_stock_sync,
        ipc_task,
    ];
    if let Some(runtime_mqtt) = maybe_spawn_mqtt_task(
        &runtime_config.public,
        &runtime_secrets,
        &hardware,
        events_tx.clone(),
        state.clone(),
        stop_token.clone(),
        ipc_ctx.clone(),
    )? {
        tasks.push(runtime_mqtt);
    }

    let cycle_exit = tokio::select! {
        signal = wait_for_local_signal() => {
            signal?;
            ConsoleCycleExit::Stop
        },
        _ = external_shutdown.cancelled() => ConsoleCycleExit::Stop,
        _ = stop_token.cancelled() => {
            if external_shutdown.is_cancelled() {
                ConsoleCycleExit::Stop
            } else {
                ConsoleCycleExit::Reconfigure
            }
        },
    };

    runtime
        .stop()
        .await
        .map_err(|error| format!("runtime shutdown failed: {error}"))?;
    for task in tasks {
        task.abort();
        let _ = task.await;
    }
    ipc_handle.shutdown();
    Ok(cycle_exit)
}

fn maybe_spawn_mqtt_task(
    runtime_config: &crate::config::MachinePublicConfig,
    runtime_secrets: &crate::config::MachineRuntimeSecrets,
    hardware: &HardwareSupervisor,
    events: broadcast::Sender<DaemonEvent>,
    state: LocalStateStore,
    shutdown: CancellationToken,
    ipc_context: ipc::IpcContext,
) -> Result<Option<tokio::task::JoinHandle<Result<(), String>>>, String> {
    let machine_code = match &runtime_config.machine_code {
        Some(code) => code.clone(),
        None => return Ok(None),
    };
    let signing_secret = match &runtime_secrets.mqtt_signing_secret {
        Some(secret) => secret.clone(),
        None => return Ok(None),
    };

    let mut options = MqttSyncRuntime::mqtt_options_from_config(
        &machine_code,
        &runtime_config.mqtt_url,
        runtime_config.mqtt_client_id.as_deref(),
    )?;
    if let Some(username) = &runtime_config.mqtt_username {
        options.set_credentials(
            username,
            runtime_secrets.mqtt_password.as_deref().unwrap_or(""),
        );
    }
    let (client, event_loop) = rumqttc::AsyncClient::new(options, 16);
    let mqtt = MqttSyncRuntime::new(
        machine_code,
        signing_secret,
        state,
        hardware.clone(),
        events,
        shutdown,
    )
    .with_readiness_context(ipc_context)
    .with_client(client);
    Ok(Some(tokio::spawn(Arc::new(mqtt).run(event_loop))))
}

struct PaymentCodeWatcherInput {
    rx_raw: mpsc::Receiver<vending_core::scanner::RawPaymentCode>,
    state: LocalStateStore,
    events: broadcast::Sender<DaemonEvent>,
    status_cache: ipc::RuntimeStatusCache,
    machine_code: Option<String>,
    api_base_url: String,
    machine_secret: Option<String>,
    shutdown: CancellationToken,
}

async fn run_payment_code_watcher(input: PaymentCodeWatcherInput) -> Result<(), String> {
    let PaymentCodeWatcherInput {
        mut rx_raw,
        state,
        events,
        status_cache,
        machine_code,
        api_base_url,
        machine_secret,
        shutdown,
    } = input;
    let Some(machine_code) = machine_code else {
        return Ok(());
    };

    let backend = BackendClient::new(api_base_url);
    if let Some(secret) = machine_secret.as_deref() {
        let _ = backend.authenticate(&machine_code, secret).await;
    }
    let machine_state = TransactionStateMachine::new(
        state.clone(),
        std::sync::Arc::new(backend),
        Some(machine_code.clone()),
        events,
    )
    .with_payment_code_submit_guard(ipc::local_payment_code_submit_guard(
        status_cache.clone(),
        state,
    ));

    loop {
        tokio::select! {
            _ = shutdown.cancelled() => return Ok(()),
            code = rx_raw.recv() => {
                let code = match code {
                    Some(code) => code,
                    None => return Ok(()),
                };
                let snapshot = match machine_state.restore_current().await {
                    Ok(Some(snapshot)) => snapshot,
                    _ => continue,
                };
                let Some(_order_no) = snapshot.order_no else {
                    continue;
                };
                let scanner_health = status_cache.scanner.read().await.clone();
                if !scanner_health.online
                    || scanner_health.adapter
                        != vending_core::scanner::PAYMENT_CODE_SOURCE_SERIAL_TEXT
                {
                    continue;
                }
                let _ = machine_state
                    .submit_payment_code(
                        code,
                        vending_core::scanner::PAYMENT_CODE_SOURCE_SERIAL_TEXT,
                        Some(scanner_health),
                    )
                    .await;
            }
        }
    }
}

async fn run_platform_stock_sync_watcher(
    config_store: Arc<crate::config::ConfigStore>,
    state: LocalStateStore,
    backend: Arc<BackendClient>,
    machine_code: Option<String>,
    shutdown: CancellationToken,
) -> Result<(), String> {
    let Some(machine_code) = machine_code else {
        return Ok(());
    };

    loop {
        match sync_platform_planogram_and_stock(&config_store, &state, &backend, &machine_code)
            .await
        {
            Ok(()) => {}
            Err(error) if error.contains("stock snapshot deferred") => {}
            Err(error) => eprintln!("platform stock sync failed: {error}"),
        }
        tokio::select! {
            _ = shutdown.cancelled() => return Ok(()),
            _ = time::sleep(PLATFORM_STOCK_SYNC_INTERVAL) => {}
        }
    }
}

async fn sync_platform_planogram_and_stock(
    config_store: &crate::config::ConfigStore,
    state: &LocalStateStore,
    backend: &BackendClient,
    machine_code: &str,
) -> Result<(), String> {
    if let Some(current) = state
        .current_transaction_snapshot()
        .await
        .map_err(|error| error.to_string())?
    {
        if is_active_transaction(&current) {
            return Ok(());
        }
    }

    let published = backend.get_published_planogram(machine_code).await?;
    if !published.is_null() {
        let planogram_version = published
            .get("planogramVersion")
            .and_then(|value| value.as_str())
            .ok_or_else(|| "published planogram response missing planogramVersion".to_string())?
            .to_string();
        let slots = published
            .get("slots")
            .cloned()
            .ok_or_else(|| "published planogram response missing slots".to_string())
            .and_then(|value| {
                serde_json::from_value::<Vec<MachinePlanogramSlotInput>>(value)
                    .map_err(|error| error.to_string())
            })?;
        let topology = config_store.hardware_slot_topology_readiness().await?;
        if !topology.ready {
            return Err(format!(
                "hardware slot topology blocks planogram activation: {}",
                topology.code
            ));
        }
        state
            .apply_planogram(MachinePlanogramInput {
                planogram_version: planogram_version.clone(),
                source: "platform_stock_sync".to_string(),
                applied_by: None,
                slots,
            })
            .await
            .map_err(|error| error.to_string())?;
        backend
            .acknowledge_planogram(machine_code, &planogram_version)
            .await?;
    }

    let snapshot = backend.get_stock_snapshot(machine_code).await?;
    state
        .apply_platform_stock_snapshot(&snapshot)
        .await
        .map_err(|error| error.to_string())?;
    Ok(())
}

async fn write_ready_file(path: &Path, bind: SocketAddr, token: &str) -> Result<(), String> {
    let parent = path.parent().unwrap_or(Path::new("."));
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|error| format!("create ready file parent failed: {error}"))?;
    let advanced_maintenance_config = std::env::var("VEM_ENABLE_ADVANCED_MAINTENANCE_CONFIG")
        .map(|value| value == "true")
        .unwrap_or(false);
    let payload = serde_json::json!({
        "healthzUrl": format!("http://{}/healthz", bind),
        "readyzUrl": format!("http://{}/readyz", bind),
        "ipcToken": token,
        "runtimeFlags": {
            "advancedMaintenanceConfig": advanced_maintenance_config,
        },
    });
    tokio::fs::write(
        path,
        serde_json::to_vec_pretty(&payload)
            .map_err(|error| format!("serialize ready file failed: {error}"))?,
    )
    .await
    .map_err(|error| format!("write ready file failed: {error}"))?;
    harden_sensitive_file_permissions(path).await?;
    Ok(())
}

async fn harden_sensitive_file_permissions(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let permissions = std::fs::Permissions::from_mode(0o600);
        tokio::fs::set_permissions(path, permissions)
            .await
            .map_err(|error| format!("harden ready file permissions failed: {error}"))?;
    }

    #[cfg(windows)]
    {
        use crate::secret::WINDOWS_MACHINE_PROTECTED_FILE_ACL_ARGS;

        let mut command = tokio::process::Command::new("icacls");
        command
            .arg(path)
            .args(WINDOWS_MACHINE_PROTECTED_FILE_ACL_ARGS);
        for principal in ready_file_reader_principals() {
            command.arg(format!("{principal}:R"));
        }
        let status = command
            .status()
            .await
            .map_err(|error| format!("run icacls for ready file failed: {error}"))?;
        if !status.success() {
            return Err(format!("icacls for ready file failed with status {status}"));
        }
    }

    Ok(())
}

#[cfg_attr(not(windows), allow(dead_code))]
fn ready_file_reader_principals() -> Vec<String> {
    std::env::var("VEM_DAEMON_READY_FILE_READERS")
        .unwrap_or_default()
        .split([',', ';'])
        .map(str::trim)
        .filter(|principal| !principal.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

async fn run_hardware_health_watcher(
    hardware: HardwareSupervisor,
    state: LocalStateStore,
    status_cache: ipc::RuntimeStatusCache,
    shutdown: CancellationToken,
) -> Result<(), String> {
    loop {
        let status = hardware.self_check().await;
        if let Some(error_code) =
            crate::state::store::classify_whole_machine_hardware_status_fault(&status)
        {
            if let Err(error) = state
                .record_whole_machine_hardware_fault_lock(
                    "hardware_health_watcher",
                    &status.message,
                    Some(error_code),
                )
                .await
            {
                eprintln!("record whole-machine hardware fault lock failed: {error}");
            }
        }
        *status_cache.hardware.write().await = status;
        tokio::select! {
            _ = time::sleep(std::time::Duration::from_secs(10)) => {}
            _ = shutdown.cancelled() => break,
        }
    }
    Ok(())
}

async fn cache_daemon_events(
    mut events: broadcast::Receiver<DaemonEvent>,
    status_cache: ipc::RuntimeStatusCache,
    runtime_shutdown: Option<CancellationToken>,
) -> Result<(), String> {
    loop {
        let event = match events.recv().await {
            Ok(event) => event,
            Err(broadcast::error::RecvError::Lagged(_missed)) => {
                continue;
            }
            Err(broadcast::error::RecvError::Closed) => break,
        };
        let updated_at = crate::state::store::now_iso();
        match event {
            DaemonEvent::MqttChanged {
                connected,
                last_error,
                ..
            } => {
                let mut cache = status_cache.sync.write().await;
                cache.mqtt_connected = connected;
                cache.last_error = last_error;
                cache.last_heartbeat_at = Some(updated_at);
            }
            DaemonEvent::VisionChanged {
                enabled,
                online,
                message,
                latest_diagnostic_payload,
                ..
            } => {
                let mut cache = status_cache.vision.write().await;
                cache.enabled = enabled;
                cache.online = online;
                cache.message = message;
                cache.latest_diagnostic_payload = latest_diagnostic_payload;
                cache.updated_at = updated_at;
            }
            DaemonEvent::ScannerHealthChanged { snapshot, .. } => {
                let mut cache = status_cache.scanner.write().await;
                *cache = crate::events::scanner_health_snapshot_from_contract(snapshot);
            }
            DaemonEvent::ScannerCode { masked_code, .. } => {
                let mut cache = status_cache.scanner.write().await;
                cache.message = format!("last code {masked_code}");
                cache.updated_at = updated_at;
            }
            DaemonEvent::TransactionChanged { .. } => {}
            DaemonEvent::RuntimeReconfigureRequested { .. } => {
                if let Some(shutdown) = &runtime_shutdown {
                    shutdown.cancel();
                }
            }
            DaemonEvent::ReadyChanged { .. }
            | DaemonEvent::HealthChanged { .. }
            | DaemonEvent::RemoteOpResult { .. } => {}
        }
    }
    Ok(())
}

#[cfg(unix)]
async fn wait_for_local_signal() -> Result<(), String> {
    use tokio::signal::unix::{self, SignalKind};

    let mut terminate = unix::signal(SignalKind::terminate())
        .map_err(|error| format!("register SIGTERM failed: {error}"))?;
    tokio::select! {
        _ = tokio::signal::ctrl_c() => Ok(()),
        _ = terminate.recv() => Ok(()),
    }
}

#[cfg(not(unix))]
async fn wait_for_local_signal() -> Result<(), String> {
    tokio::signal::ctrl_c()
        .await
        .map_err(|error| format!("wait for ctrl-c failed: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::default_public_config;
    use async_trait::async_trait;
    use std::{
        net::{IpAddr, Ipv4Addr},
        sync::atomic::{AtomicUsize, Ordering},
    };

    #[derive(Debug)]
    struct FaultySelfCheckAdapter;

    #[async_trait]
    impl vending_core::hardware::HardwareAdapter for FaultySelfCheckAdapter {
        fn adapter_name(&self) -> &str {
            "faulty-self-check"
        }

        async fn self_check(&self) -> vending_core::hardware::HardwareStatus {
            vending_core::hardware::HardwareStatus {
                adapter: "serial".to_string(),
                online: false,
                message: "lower controller responded with fault on COM3 (mechanical fault)"
                    .to_string(),
                port_path: Some("COM3".to_string()),
                resolution_source: Some("configured".to_string()),
                bound_usb_identity: None,
                candidates: vec![],
            }
        }

        async fn dispense(
            &self,
            command: vending_core::hardware::DispenseCommandPayload,
        ) -> vending_core::hardware::DispenseResultPayload {
            vending_core::hardware::DispenseResultPayload {
                command_no: command.command_no,
                success: false,
                error_code: Some("JAMMED".to_string()),
                message: "faulty self-check adapter does not dispense".to_string(),
                reported_at: crate::state::store::now_iso(),
            }
        }
    }

    #[test]
    fn default_console_config_uses_loopback_and_port() {
        assert_eq!(
            ConsoleRunConfig::default().bind,
            SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 7891)
        );
    }

    #[test]
    fn default_ready_file_path_is_within_data_dir() {
        let data_dir = std::path::Path::new("/tmp/vem-daemon-data");
        let path = default_ready_file_path(data_dir);
        assert_eq!(path, data_dir.join("daemon-ready.json"));
    }

    #[test]
    fn ready_file_reader_principals_parse_env_list() {
        std::env::set_var(
            "VEM_DAEMON_READY_FILE_READERS",
            "VEMKiosk; DESKTOP-2IDRN2K\\VEMKiosk,  ",
        );

        assert_eq!(
            ready_file_reader_principals(),
            vec!["VEMKiosk", "DESKTOP-2IDRN2K\\VEMKiosk"]
        );

        std::env::remove_var("VEM_DAEMON_READY_FILE_READERS");
    }

    #[tokio::test]
    async fn runtime_reconfigure_event_cancels_runtime_shutdown_token() {
        let temp = tempfile::tempdir().expect("temp");
        let state = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("state");
        let status_cache = ipc::RuntimeStatusCache::new(&default_public_config(), state).await;
        let (events_tx, _) = broadcast::channel(8);
        let runtime_shutdown = CancellationToken::new();
        let task = tokio::spawn(cache_daemon_events(
            events_tx.subscribe(),
            status_cache,
            Some(runtime_shutdown.clone()),
        ));

        events_tx
            .send(DaemonEvent::RuntimeReconfigureRequested {
                event_id: "evt-reconfigure".to_string(),
                updated_at: crate::state::store::now_iso(),
                reason: "machine_provisioned".to_string(),
                machine_code: Some("M001".to_string()),
            })
            .expect("send event");

        tokio::time::timeout(
            std::time::Duration::from_secs(1),
            runtime_shutdown.cancelled(),
        )
        .await
        .expect("runtime shutdown requested");

        task.abort();
        let _ = task.await;
    }

    #[tokio::test]
    async fn runtime_supervisor_restarts_an_internal_reconfigure_without_stopping_process() {
        let external_shutdown = CancellationToken::new();
        let cycles = Arc::new(AtomicUsize::new(0));
        let cycles_for_run = cycles.clone();
        let external_for_run = external_shutdown.clone();

        supervise_runtime_cycles(&external_shutdown, move || {
            let cycle = cycles_for_run.fetch_add(1, Ordering::SeqCst);
            let external_for_cycle = external_for_run.clone();
            async move {
                if cycle == 0 {
                    Ok(ConsoleCycleExit::Reconfigure)
                } else {
                    external_for_cycle.cancel();
                    Ok(ConsoleCycleExit::Stop)
                }
            }
        })
        .await
        .expect("supervise runtime");

        assert_eq!(cycles.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn cache_daemon_events_survives_lagged_broadcast_events() {
        let temp = tempfile::tempdir().expect("temp");
        let state = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("state");
        let status_cache = ipc::RuntimeStatusCache::new(&default_public_config(), state).await;
        let (events_tx, events_rx) = broadcast::channel(1);

        events_tx
            .send(DaemonEvent::MqttChanged {
                event_id: "evt-missed".to_string(),
                updated_at: crate::state::store::now_iso(),
                connected: true,
                last_error: None,
            })
            .expect("send missed event");
        events_tx
            .send(DaemonEvent::ScannerHealthChanged {
                event_id: "evt-scanner-ready".to_string(),
                updated_at: crate::state::store::now_iso(),
                snapshot: crate::events::scanner_runtime_status_contract(
                    &vending_core::scanner::ScannerHealthSnapshot {
                        online: true,
                        adapter: vending_core::scanner::PAYMENT_CODE_SOURCE_SERIAL_TEXT.to_string(),
                        port: Some("COM3".to_string()),
                        level: vending_core::health::HealthLevel::Ok,
                        code: "SCANNER_READY".to_string(),
                        message: "scanner ready".to_string(),
                        updated_at: crate::state::store::now_iso(),
                    },
                ),
            })
            .expect("send scanner event");

        let task = tokio::spawn(cache_daemon_events(events_rx, status_cache.clone(), None));

        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            loop {
                let scanner = status_cache.scanner.read().await.clone();
                if scanner.code == "SCANNER_READY" {
                    assert!(scanner.online);
                    assert_eq!(scanner.port.as_deref(), Some("COM3"));
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("scanner cache updated after lag");

        task.abort();
        let _ = task.await;
    }

    #[tokio::test]
    async fn hardware_health_watcher_records_whole_machine_lock_for_controller_fault() {
        let temp = tempfile::tempdir().expect("temp");
        let state = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("state");
        let status_cache =
            ipc::RuntimeStatusCache::new(&default_public_config(), state.clone()).await;
        let shutdown = CancellationToken::new();
        let task = tokio::spawn(run_hardware_health_watcher(
            HardwareSupervisor::from_adapter(Arc::new(FaultySelfCheckAdapter)),
            state.clone(),
            status_cache,
            shutdown.clone(),
        ));

        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            loop {
                if let Some(lock) = state
                    .whole_machine_maintenance_lock()
                    .await
                    .expect("read lock")
                {
                    assert_eq!(lock.code, "WHOLE_MACHINE_HARDWARE_FAULT");
                    assert_eq!(lock.source, "hardware_health_watcher");
                    assert_eq!(lock.error_code.as_deref(), Some("JAMMED"));
                    assert!(lock.message.contains("mechanical fault"));
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("whole-machine lock recorded");

        shutdown.cancel();
        task.await.expect("watcher task").expect("watcher result");
    }
}
