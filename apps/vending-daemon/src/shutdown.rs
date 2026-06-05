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
    state::LocalStateStore,
    stock_upload::StockMovementUploadRuntime,
    transaction::TransactionStateMachine,
    vision::VisionSupervisor,
};

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
    let data_dir = config::resolve_data_dir(config.data_dir)?;
    tokio::fs::create_dir_all(&data_dir)
        .await
        .map_err(|error| format!("create data dir failed: {error}"))?;

    let state = LocalStateStore::open(&data_dir.join("state.db"))
        .await
        .map_err(|error| error.to_string())?;
    let secret_store = secret::default_secret_store();
    let config_store = std::sync::Arc::new(ConfigStore::new(
        data_dir.clone(),
        state.clone(),
        secret_store,
    ));

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

    let hardware = HardwareSupervisor::from_config(&runtime_config.public)
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
    let transaction = TransactionStateMachine::new(
        state.clone(),
        backend.clone(),
        runtime_config.public.machine_code.clone(),
        events_tx.clone(),
    );
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
        events: events_tx.clone(),
        runtime_tx: tx_raw.clone(),
        disk_pressure_probe: Arc::new(crate::health::DataDirDiskPressureProbe::default()),
        ui,
    };
    let (ipc_handle, ipc_task) = ipc::run_server(config.bind, ipc_ctx.clone())
        .await
        .map_err(|error| format!("ipc failed: {error}"))?;

    write_ready_file(&print_ready_file, ipc_handle.addr, &ipc_token).await?;

    let cache_updates = tokio::spawn(cache_daemon_events(
        events_tx.subscribe(),
        ipc_ctx.ui.status_cache.clone(),
    ));
    let scanner_runtime = ScannerRuntime::from_config(
        &runtime_config.public,
        tx_raw.clone(),
        events_tx.clone(),
        runtime.shutdown_token(),
    );
    let scanner = tokio::spawn(scanner_runtime.run());
    let stop_token = runtime.shutdown_token();
    let payment_watcher = tokio::spawn(run_payment_code_watcher(PaymentCodeWatcherInput {
        rx_raw,
        state: state.clone(),
        events: events_tx.clone(),
        scanner_status: ipc_ctx.ui.status_cache.scanner.clone(),
        machine_code: runtime_config.public.machine_code.clone(),
        api_base_url: runtime_config.public.api_base_url.clone(),
        machine_secret: runtime_secrets.machine_secret.clone(),
        shutdown: stop_token.clone(),
    }));
    let hardware_health = tokio::spawn(run_hardware_health_watcher(
        hardware.clone(),
        ipc_ctx.ui.status_cache.clone(),
        stop_token.clone(),
    ));
    let stock_upload = tokio::spawn(
        StockMovementUploadRuntime::new(state.clone(), backend.clone(), stop_token.clone()).run(),
    );

    let vision = VisionSupervisor::new(runtime_config.public.clone());
    let vision_events = events_tx.clone();
    tokio::spawn(async move {
        let snapshot = match vision.start().await {
            Ok(snapshot) => snapshot,
            Err(error) => crate::vision::VisionRuntimeSnapshot::failed(error),
        };
        let _ = vision_events.send(DaemonEvent::VisionChanged {
            event_id: uuid::Uuid::new_v4().simple().to_string(),
            updated_at: crate::state::store::now_iso(),
            enabled: snapshot.enabled,
            online: snapshot.online,
            message: snapshot.message,
        });
    });

    let mut tasks = vec![
        cache_updates,
        scanner,
        payment_watcher,
        hardware_health,
        stock_upload,
        ipc_task,
    ];
    if let Some(runtime_mqtt) = maybe_spawn_mqtt_task(
        &runtime_config.public,
        &runtime_secrets,
        &hardware,
        events_tx.clone(),
        state.clone(),
        stop_token.clone(),
    )? {
        tasks.push(runtime_mqtt);
    }

    tokio::select! {
        signal = wait_for_local_signal() => signal?,
        _ = external_shutdown.cancelled() => {}
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
    Ok(())
}

fn maybe_spawn_mqtt_task(
    runtime_config: &crate::config::MachinePublicConfig,
    runtime_secrets: &crate::config::MachineRuntimeSecrets,
    hardware: &HardwareSupervisor,
    events: broadcast::Sender<DaemonEvent>,
    state: LocalStateStore,
    shutdown: CancellationToken,
) -> Result<Option<tokio::task::JoinHandle<Result<(), String>>>, String> {
    let machine_code = match &runtime_config.machine_code {
        Some(code) => code.clone(),
        None => return Ok(None),
    };
    let signing_secret = match &runtime_secrets.mqtt_signing_secret {
        Some(secret) => secret.clone(),
        None => return Ok(None),
    };

    let mut options =
        MqttSyncRuntime::mqtt_options_from_config(&machine_code, &runtime_config.mqtt_url)?;
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
    .with_client(client);
    Ok(Some(tokio::spawn(Arc::new(mqtt).run(event_loop))))
}

struct PaymentCodeWatcherInput {
    rx_raw: mpsc::Receiver<vending_core::scanner::RawPaymentCode>,
    state: LocalStateStore,
    events: broadcast::Sender<DaemonEvent>,
    scanner_status: Arc<tokio::sync::RwLock<vending_core::scanner::ScannerHealthSnapshot>>,
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
        scanner_status,
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
        state,
        std::sync::Arc::new(backend),
        Some(machine_code.clone()),
        events,
    );

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
                let scanner_health = scanner_status.read().await.clone();
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

async fn write_ready_file(path: &Path, bind: SocketAddr, token: &str) -> Result<(), String> {
    let parent = path.parent().unwrap_or(Path::new("."));
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|error| format!("create ready file parent failed: {error}"))?;
    let payload = serde_json::json!({
        "healthzUrl": format!("http://{}/healthz", bind),
        "readyzUrl": format!("http://{}/readyz", bind),
        "ipcToken": token,
    });
    tokio::fs::write(
        path,
        serde_json::to_vec_pretty(&payload)
            .map_err(|error| format!("serialize ready file failed: {error}"))?,
    )
    .await
    .map_err(|error| format!("write ready file failed: {error}"))
}

async fn run_hardware_health_watcher(
    hardware: HardwareSupervisor,
    status_cache: ipc::RuntimeStatusCache,
    shutdown: CancellationToken,
) -> Result<(), String> {
    loop {
        let status = hardware.self_check().await;
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
) -> Result<(), String> {
    while let Ok(event) = events.recv().await {
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
                ..
            } => {
                let mut cache = status_cache.vision.write().await;
                cache.enabled = enabled;
                cache.online = online;
                cache.message = message;
                cache.updated_at = updated_at;
            }
            DaemonEvent::ScannerHealthChanged { snapshot, .. } => {
                let mut cache = status_cache.scanner.write().await;
                *cache = snapshot;
            }
            DaemonEvent::ScannerCode { masked_code, .. } => {
                let mut cache = status_cache.scanner.write().await;
                cache.message = format!("last code {masked_code}");
                cache.updated_at = updated_at;
            }
            DaemonEvent::TransactionChanged { .. } => {}
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
    use std::net::{IpAddr, Ipv4Addr};

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
}
