use std::{
    future::Future,
    net::{IpAddr, SocketAddr},
    path::{Path, PathBuf},
    sync::Arc,
};

use tokio::{
    sync::{broadcast, mpsc},
    time,
};
use tokio_util::sync::CancellationToken;

use crate::{
    backend::BackendClient,
    device_binding::{self, LocalDeviceRole, LocalSerialRoleBinding, SerialDeviceRoleProbeConfig},
    events::DaemonEvent,
    hardware::HardwareSupervisor,
    ipc::{self, IpcContext},
    local_runtime_settings::{LocalRuntimeSettings, ScannerProtocolParameters},
    mqtt::MqttSyncRuntime,
    provisioning,
    runtime::{DaemonRuntime, RuntimeStartInput},
    runtime_configuration::{ClaimedMachineCredentials, RuntimeSources},
    scanner::{ScannerRuntimeConfig, ScannerRuntimeController},
    secret,
    state::{
        store::{MachinePlanogramInput, MachinePlanogramSlotInput},
        LocalStateStore,
    },
    stock_upload::StockMovementUploadRuntime,
    transaction::{is_active_transaction, TransactionStateMachine},
    vision::VisionSupervisor,
};

const PLATFORM_STOCK_SYNC_INTERVAL: std::time::Duration = std::time::Duration::from_secs(15);
const PROFILE_REFRESH_INTERVAL: std::time::Duration = std::time::Duration::from_secs(60);
const SALE_START_CAPABILITY_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(15);

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
    let data_dir = provisioning::resolve_data_dir(config.data_dir)?;
    tokio::fs::create_dir_all(&data_dir)
        .await
        .map_err(|error| format!("create data dir failed: {error}"))?;

    let state = LocalStateStore::open(&data_dir.join("state.db"))
        .await
        .map_err(|error| error.to_string())?;
    let secret_store = secret::default_secret_store(data_dir.clone());
    let runtime_sources = Arc::new(RuntimeSources::new(data_dir.clone(), secret_store));
    let clean = runtime_sources.clean_runtime_configuration();
    clean.recover_claim_transaction().await?;
    // Bootstrap is deployment input and must exist even before the first claim.
    let bootstrap = clean.load_bootstrap().await?;
    let profile = clean.load_profile_cache().await?;
    let credentials = match profile.as_ref() {
        Some(_) => Some(runtime_sources.claimed_credentials().await?),
        None => None,
    };

    let runtime = DaemonRuntime::start(RuntimeStartInput {
        state: state.clone(),
        runtime_sources: runtime_sources.clone(),
        data_dir: data_dir.clone(),
    })
    .await
    .map_err(|error| format!("runtime start failed: {error}"))?;

    let serial_device_platform: device_binding::SharedSerialDevicePlatform =
        Arc::new(device_binding::WindowsSerialDevicePlatform);
    let settings = runtime_sources.load_local_runtime_settings().await?;
    let observed = serial_device_platform.discover().await.unwrap_or_default();
    let lower_port = resolve_bound_port(
        LocalDeviceRole::LowerController,
        settings.lower_controller_binding.as_ref(),
        &observed,
    );
    let scanner_port = resolve_bound_port(
        LocalDeviceRole::Scanner,
        settings.scanner_binding.as_ref(),
        &observed,
    );
    let hardware = HardwareSupervisor::from_serial_port(
        lower_port,
        Some(data_dir.join("logs").join("serial-protocol.jsonl")),
    )?;

    let (tx_raw, rx_raw) = mpsc::channel(16);
    let (events_tx, _) = broadcast::channel(64);
    let scanner_runtime = ScannerRuntimeController::new(tx_raw.clone(), events_tx.clone());
    scanner_runtime
        .start(scanner_runtime_config(&settings, scanner_port))
        .await?;

    let backend_url = profile
        .as_ref()
        .map(|value| value.profile.api_base_url.to_string())
        .unwrap_or_else(|| bootstrap.provisioning_api_base_url.to_string());
    let backend = Arc::new(BackendClient::new(backend_url));
    if let (Some(profile), Some(credentials)) = (profile.as_ref(), credentials.as_ref()) {
        // Accepted profile and credentials are the local runtime boundary. A
        // network outage must not prevent the last-known-good runtime from
        // continuing to serve local sales.
        let _ = backend
            .authenticate(
                &profile.profile.machine.code.to_string(),
                &credentials.machine_secret,
            )
            .await;
    }

    let status_cache = ipc::RuntimeStatusCache::new(profile.as_ref(), state.clone()).await;
    let transaction = TransactionStateMachine::new(
        state.clone(),
        backend.clone(),
        profile
            .as_ref()
            .map(|value| value.profile.machine.code.to_string()),
        events_tx.clone(),
    )
    .with_payment_code_submit_guard(ipc::local_payment_code_submit_guard(
        status_cache.clone(),
        state.clone(),
    ));
    let ui = ipc::UiRuntimeServices {
        backend: backend.clone(),
        transaction,
        status_cache,
    };
    let ipc_token = ipc::load_or_create_ipc_token(&data_dir).await?;
    let ipc_ctx = IpcContext {
        data_dir: data_dir.clone(),
        token: ipc_token.clone(),
        runtime_sources: runtime_sources.clone(),
        state: state.clone(),
        hardware: hardware.clone(),
        events: events_tx.clone(),
        runtime_tx: tx_raw,
        scanner_runtime: scanner_runtime.clone(),
        serial_device_platform: serial_device_platform.clone(),
        device_binding_test_evidence: Arc::new(ipc::DeviceBindingTestEvidenceStore::default()),
        sale_binding_gate: Arc::new(ipc::SaleBindingOperationGate::default()),
        disk_pressure_probe: Arc::new(crate::health::DataDirDiskPressureProbe::from_env()),
        network_adapter: crate::network::adapter_from_env(),
        ui,
        background_shutdown: CancellationToken::new(),
    };
    let (ipc_handle, ipc_task) = ipc::run_server(config.bind, ipc_ctx.clone()).await?;
    let ready_file = config
        .print_ready_file
        .unwrap_or_else(|| default_ready_file_path(&data_dir));
    let ready_generation = uuid::Uuid::new_v4().simple().to_string();
    write_ready_file(&ready_file, ipc_handle.addr, &ipc_token, &ready_generation).await?;

    let stop_token = runtime.shutdown_token();
    let cache_updates = tokio::spawn(cache_daemon_events(
        events_tx.subscribe(),
        ipc_ctx.ui.status_cache.clone(),
        Some(stop_token.clone()),
        Some(ipc_ctx.clone()),
    ));
    let payment_watcher = tokio::spawn(run_payment_code_watcher(
        rx_raw,
        state.clone(),
        events_tx.clone(),
        ipc_ctx.ui.status_cache.clone(),
        profile
            .as_ref()
            .map(|value| value.profile.machine.code.to_string()),
        credentials
            .as_ref()
            .map(|value| value.machine_secret.clone()),
        backend.clone(),
        stop_token.clone(),
    ));
    let hardware_health = tokio::spawn(run_hardware_health_watcher(
        hardware.clone(),
        state.clone(),
        ipc_ctx.ui.status_cache.clone(),
        Some(ipc_ctx.clone()),
        stop_token.clone(),
    ));
    let sale_start_capability = tokio::spawn(run_sale_start_capability_polling(
        ipc_ctx.clone(),
        stop_token.clone(),
    ));
    let binding_watch = tokio::spawn(run_device_binding_watch(
        serial_device_platform,
        runtime_sources.clone(),
        state.clone(),
        hardware.clone(),
        scanner_runtime.clone(),
        ipc_ctx.ui.status_cache.clone(),
        ipc_ctx.sale_binding_gate.clone(),
        data_dir.clone(),
        ipc_ctx.clone(),
        stop_token.clone(),
    ));
    let stock_upload = tokio::spawn(
        StockMovementUploadRuntime::new(
            state.clone(),
            ipc_ctx.ui.backend.clone(),
            stop_token.clone(),
        )
        .with_events(events_tx.clone())
        .run(),
    );
    let stock_sync = tokio::spawn(run_platform_stock_sync_watcher(
        runtime_sources.clone(),
        state.clone(),
        ipc_ctx.ui.backend.clone(),
        ipc_ctx.clone(),
        profile
            .as_ref()
            .map(|value| value.profile.machine.code.to_string()),
        stop_token.clone(),
    ));
    let profile_refresh = tokio::spawn(run_provisioning_profile_refresh_watcher(
        runtime_sources.clone(),
        backend.clone(),
        profile
            .as_ref()
            .map(|value| value.profile.machine.code.to_string()),
        events_tx.clone(),
        stop_token.clone(),
    ));
    let vision_task = if profile.as_ref().is_some_and(vision_profile_enabled) {
        let vision = VisionSupervisor::new(
            profile
                .as_ref()
                .map(|value| value.profile.machine.code.to_string()),
        );
        tokio::spawn(run_vision_watch(
            vision,
            events_tx.clone(),
            stop_token.clone(),
        ))
    } else {
        *ipc_ctx.ui.status_cache.vision.write().await = ipc::VisionStatusSnapshot {
            enabled: false,
            online: false,
            message: "disabled".to_string(),
            updated_at: crate::state::store::now_iso(),
            latest_diagnostic_payload: Some(serde_json::json!({
                "type": "vision.disabled",
                "payload": { "message": "disabled" },
            })),
        };
        tokio::spawn(async { Ok(()) })
    };

    let mut tasks = vec![
        cache_updates,
        payment_watcher,
        hardware_health,
        sale_start_capability,
        binding_watch,
        stock_upload,
        stock_sync,
        profile_refresh,
        vision_task,
        ipc_task,
    ];
    if let Some(task) = maybe_spawn_mqtt_task(
        profile.as_ref(),
        credentials.as_ref(),
        &hardware,
        events_tx,
        state,
        stop_token.clone(),
        ipc_ctx,
    )? {
        tasks.push(task);
    }

    let exit = tokio::select! {
        signal = wait_for_local_signal() => { signal?; ConsoleCycleExit::Stop }
        _ = external_shutdown.cancelled() => ConsoleCycleExit::Stop,
        _ = stop_token.cancelled() => {
            if external_shutdown.is_cancelled() { ConsoleCycleExit::Stop } else { ConsoleCycleExit::Reconfigure }
        }
    };
    runtime.stop().await?;
    scanner_runtime.stop().await?;
    ipc_handle.shutdown.cancel();
    for task in tasks {
        task.abort();
        let _ = task.await;
    }
    Ok(exit)
}

fn vision_profile_enabled(profile: &daemon_ipc_contracts::ProvisioningProfileCache) -> bool {
    let vision = &profile.profile.hardware_profile.vision;
    vision.required || vision.supports_recommendations
}

pub(crate) async fn refresh_provisioning_profile_once(
    runtime_sources: &RuntimeSources,
    backend: &BackendClient,
    machine_code: &str,
) -> Result<bool, String> {
    let profile = match backend.get_provisioning_profile(machine_code).await {
        Ok(profile) => profile,
        Err(error) => {
            runtime_sources
                .clean_runtime_configuration()
                .mark_profile_refresh_degraded(&error)
                .await;
            return Err(error);
        }
    };
    runtime_sources
        .clean_runtime_configuration()
        .accept_refreshed_profile(&profile)
        .await
        .map(|accepted| accepted.is_some())
}

async fn run_provisioning_profile_refresh_watcher(
    runtime_sources: Arc<RuntimeSources>,
    backend: Arc<BackendClient>,
    machine_code: Option<String>,
    events: broadcast::Sender<DaemonEvent>,
    shutdown: CancellationToken,
) -> Result<(), String> {
    let Some(machine_code) = machine_code else {
        shutdown.cancelled().await;
        return Ok(());
    };
    let mut interval = time::interval(PROFILE_REFRESH_INTERVAL);
    interval.set_missed_tick_behavior(time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            _ = shutdown.cancelled() => return Ok(()),
            _ = interval.tick() => {}
        }
        match refresh_provisioning_profile_once(&runtime_sources, &backend, &machine_code).await {
            Ok(true) => {
                let _ = events.send(DaemonEvent::RuntimeReconfigureRequested {
                    event_id: uuid::Uuid::new_v4().simple().to_string(),
                    updated_at: crate::state::store::now_iso(),
                    reason: "provisioning_profile_refreshed".to_string(),
                    machine_code: Some(machine_code.clone()),
                });
            }
            Ok(false) => {}
            Err(error) => eprintln!("provisioning profile refresh degraded: {error}"),
        }
    }
}

fn resolve_bound_port(
    role: LocalDeviceRole,
    binding: Option<&LocalSerialRoleBinding>,
    observed: &[device_binding::ObservedSerialDevice],
) -> Option<String> {
    binding.and_then(|binding| device_binding::resolve_runtime_port(role, binding, observed).ok())
}

fn scanner_protocol(settings: &LocalRuntimeSettings) -> ScannerProtocolParameters {
    settings
        .scanner_protocol
        .clone()
        .unwrap_or(ScannerProtocolParameters {
            baud_rate: 9_600,
            frame_suffix: vending_core::scanner::ScannerFrameSuffix::Crlf,
        })
}

fn scanner_runtime_config(
    settings: &LocalRuntimeSettings,
    port_path: Option<String>,
) -> ScannerRuntimeConfig {
    let protocol = scanner_protocol(settings);
    ScannerRuntimeConfig {
        port_path,
        baud_rate: protocol.baud_rate,
        frame_suffix: protocol.frame_suffix,
        source: vending_core::scanner::PAYMENT_CODE_SOURCE_SERIAL_TEXT.to_string(),
    }
}

async fn run_device_binding_watch(
    platform: device_binding::SharedSerialDevicePlatform,
    runtime_sources: Arc<RuntimeSources>,
    state: LocalStateStore,
    hardware: HardwareSupervisor,
    scanner_runtime: ScannerRuntimeController,
    status_cache: ipc::RuntimeStatusCache,
    sale_gate: Arc<ipc::SaleBindingOperationGate>,
    data_dir: PathBuf,
    sale_start_context: IpcContext,
    shutdown: CancellationToken,
) -> Result<(), String> {
    let mut interval = time::interval(std::time::Duration::from_secs(2));
    interval.set_missed_tick_behavior(time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            _ = shutdown.cancelled() => return Ok(()),
            _ = interval.tick() => {}
        }
        let previous_hardware = status_cache.hardware.read().await.clone();
        let previous_scanner = status_cache.scanner.read().await.clone();
        let mut settings = match runtime_sources.load_local_runtime_settings().await {
            Ok(settings) => settings,
            Err(error) => {
                set_binding_retry(&status_cache, &error).await;
                if sale_capability_inputs_changed(
                    &status_cache,
                    &previous_hardware,
                    &previous_scanner,
                )
                .await
                {
                    ipc::invalidate_sale_start_capability(&sale_start_context).await;
                }
                continue;
            }
        };
        let observed = match platform.discover().await {
            Ok(observed) => observed,
            Err(error) => {
                set_binding_retry(&status_cache, &error).await;
                if sale_capability_inputs_changed(
                    &status_cache,
                    &previous_hardware,
                    &previous_scanner,
                )
                .await
                {
                    ipc::invalidate_sale_start_capability(&sale_start_context).await;
                }
                continue;
            }
        };
        let mut binding_changed = false;
        let active_sale = state
            .current_transaction_snapshot()
            .await
            .map(|snapshot| snapshot.as_ref().is_some_and(is_active_transaction))
            .unwrap_or(true);
        if !active_sale {
            let probe = SerialDeviceRoleProbeConfig::from(&scanner_protocol(&settings));
            for role in [LocalDeviceRole::LowerController, LocalDeviceRole::Scanner] {
                if binding_for_role(&settings, role).is_some() {
                    continue;
                }
                let mut ready = Vec::new();
                for candidate in &observed {
                    let result = platform.test_candidate(role, candidate, &probe).await;
                    if result.success {
                        ready.push((candidate, result));
                    }
                }
                if ready.len() != 1 {
                    continue;
                }
                let (candidate, result) = ready.pop().expect("one verified serial candidate");
                let Ok(identity) =
                    device_binding::StableSerialDeviceIdentity::try_from_observation(candidate)
                else {
                    continue;
                };
                let binding = LocalSerialRoleBinding {
                    identity,
                    confirmed_at: crate::state::store::now_iso(),
                    confirmed_by: "daemon_auto_bind".to_string(),
                    test_evidence_code: result.code,
                };
                let Ok((_, revision)) = runtime_sources.local_device_binding_snapshot(role).await
                else {
                    continue;
                };
                if runtime_sources
                    .save_local_device_binding_if_revision(role, binding.clone(), &revision)
                    .await
                    .is_ok()
                {
                    set_binding_for_role(&mut settings, role, Some(binding));
                    binding_changed = true;
                }
            }
        }
        let lease = match sale_gate.try_acquire_reconfigure() {
            Ok(lease) => lease,
            Err(_) => continue,
        };
        if state
            .current_transaction_snapshot()
            .await
            .map(|snapshot| snapshot.as_ref().is_some_and(is_active_transaction))
            .unwrap_or(true)
        {
            drop(lease);
            continue;
        }
        if let Some(binding) = settings.lower_controller_binding.as_ref() {
            match device_binding::resolve_runtime_port(
                LocalDeviceRole::LowerController,
                binding,
                &observed,
            ) {
                Ok(port)
                    if status_cache.hardware.read().await.port_path.as_deref()
                        != Some(port.as_str()) =>
                {
                    match hardware
                        .reconfigure_from_serial_port(
                            Some(port),
                            Some(data_dir.join("logs").join("serial-protocol.jsonl")),
                        )
                        .await
                    {
                        Ok(status) => *status_cache.hardware.write().await = status,
                        Err(error) => set_lower_unavailable(&status_cache, error).await,
                    }
                }
                Err(error) => {
                    hardware.deactivate_bound_adapter(format!(
                        "lower controller stable binding unresolved: {error}"
                    ))?;
                    *status_cache.hardware.write().await = hardware.self_check().await;
                }
                _ => {}
            }
        }
        if let Some(binding) = settings.scanner_binding.as_ref() {
            match device_binding::resolve_runtime_port(LocalDeviceRole::Scanner, binding, &observed)
            {
                Ok(port)
                    if status_cache.scanner.read().await.port.as_deref() != Some(port.as_str()) =>
                {
                    if let Err(error) = scanner_runtime
                        .reconfigure(scanner_runtime_config(&settings, Some(port)))
                        .await
                    {
                        *status_cache.scanner.write().await =
                            scanner_unavailable("SCANNER_RECONFIGURE_RETRY", error);
                    }
                }
                Err(error) => {
                    let _ = scanner_runtime.stop().await;
                    *status_cache.scanner.write().await =
                        scanner_unavailable("SCANNER_BINDING_UNAVAILABLE", error);
                }
                _ => {}
            }
        }
        drop(lease);
        if binding_changed
            || sale_capability_inputs_changed(&status_cache, &previous_hardware, &previous_scanner)
                .await
        {
            ipc::invalidate_sale_start_capability(&sale_start_context).await;
        }
    }
}

async fn sale_capability_inputs_changed(
    cache: &ipc::RuntimeStatusCache,
    previous_hardware: &vending_core::hardware::HardwareStatus,
    previous_scanner: &vending_core::scanner::ScannerHealthSnapshot,
) -> bool {
    let hardware = cache.hardware.read().await;
    let scanner = cache.scanner.read().await;
    hardware.online != previous_hardware.online
        || hardware.port_path != previous_hardware.port_path
        || hardware.adapter != previous_hardware.adapter
        || hardware.message != previous_hardware.message
        || scanner.online != previous_scanner.online
        || scanner.port != previous_scanner.port
        || scanner.adapter != previous_scanner.adapter
        || scanner.code != previous_scanner.code
}

fn binding_for_role(
    settings: &LocalRuntimeSettings,
    role: LocalDeviceRole,
) -> Option<&LocalSerialRoleBinding> {
    match role {
        LocalDeviceRole::LowerController => settings.lower_controller_binding.as_ref(),
        LocalDeviceRole::Scanner => settings.scanner_binding.as_ref(),
    }
}

fn set_binding_for_role(
    settings: &mut LocalRuntimeSettings,
    role: LocalDeviceRole,
    binding: Option<LocalSerialRoleBinding>,
) {
    match role {
        LocalDeviceRole::LowerController => settings.lower_controller_binding = binding,
        LocalDeviceRole::Scanner => settings.scanner_binding = binding,
    }
}

async fn set_binding_retry(cache: &ipc::RuntimeStatusCache, error: &str) {
    set_lower_unavailable(cache, format!("serial device discovery retry: {error}")).await;
    *cache.scanner.write().await =
        scanner_unavailable("SCANNER_DISCOVERY_RETRY", error.to_string());
}

async fn set_lower_unavailable(cache: &ipc::RuntimeStatusCache, message: impl Into<String>) {
    let mut status = cache.hardware.read().await.clone();
    status.online = false;
    status.port_path = None;
    status.message = message.into();
    *cache.hardware.write().await = status;
}

fn scanner_unavailable(
    code: &str,
    message: impl Into<String>,
) -> vending_core::scanner::ScannerHealthSnapshot {
    vending_core::scanner::ScannerHealthSnapshot {
        online: false,
        adapter: vending_core::scanner::PAYMENT_CODE_SOURCE_SERIAL_TEXT.to_string(),
        port: None,
        level: vending_core::health::HealthLevel::Offline,
        code: code.to_string(),
        message: message.into(),
        updated_at: crate::state::store::now_iso(),
    }
}

async fn run_payment_code_watcher(
    mut rx: mpsc::Receiver<vending_core::scanner::RawPaymentCode>,
    state: LocalStateStore,
    events: broadcast::Sender<DaemonEvent>,
    status_cache: ipc::RuntimeStatusCache,
    machine_code: Option<String>,
    machine_secret: Option<String>,
    backend: Arc<BackendClient>,
    shutdown: CancellationToken,
) -> Result<(), String> {
    let Some(machine_code) = machine_code else {
        return Ok(());
    };
    if machine_secret.is_none() {
        return Ok(());
    }
    let machine = TransactionStateMachine::new(state.clone(), backend, Some(machine_code), events)
        .with_payment_code_submit_guard(ipc::local_payment_code_submit_guard(
            status_cache.clone(),
            state,
        ));
    loop {
        tokio::select! {
            _ = shutdown.cancelled() => return Ok(()),
            code = rx.recv() => {
                let Some(code) = code else { return Ok(()); };
                let Ok(Some(snapshot)) = machine.restore_current().await else { continue; };
                if snapshot.order_no.is_none() { continue; }
                let health = status_cache.scanner.read().await.clone();
                if health.online && health.adapter == vending_core::scanner::PAYMENT_CODE_SOURCE_SERIAL_TEXT {
                    let _ = machine.submit_payment_code(code, vending_core::scanner::PAYMENT_CODE_SOURCE_SERIAL_TEXT, Some(health)).await;
                }
            }
        }
    }
}

fn maybe_spawn_mqtt_task(
    profile: Option<&daemon_ipc_contracts::ProvisioningProfileCache>,
    credentials: Option<&ClaimedMachineCredentials>,
    hardware: &HardwareSupervisor,
    events: broadcast::Sender<DaemonEvent>,
    state: LocalStateStore,
    shutdown: CancellationToken,
    ipc_context: ipc::IpcContext,
) -> Result<Option<tokio::task::JoinHandle<Result<(), String>>>, String> {
    let (Some(profile), Some(credentials)) = (profile, credentials) else {
        return Ok(None);
    };
    let machine_code = profile.profile.machine.code.to_string();
    let mqtt = &profile.profile.mqtt_connection;
    let mut options = MqttSyncRuntime::mqtt_options_from_config(
        &machine_code,
        &mqtt.url.to_string(),
        Some(&mqtt.client_id.to_string()),
    )?;
    if let Some(username) = mqtt.username.as_ref() {
        options.set_credentials(
            username.to_string(),
            credentials.mqtt_password.as_deref().unwrap_or(""),
        );
    }
    let (client, event_loop) = rumqttc::AsyncClient::new(options, 16);
    let runtime = MqttSyncRuntime::new(
        machine_code,
        credentials.mqtt_signing_secret.clone(),
        state,
        hardware.clone(),
        events,
        shutdown,
    )
    .with_readiness_context(ipc_context)
    .with_client(client);
    Ok(Some(tokio::spawn(Arc::new(runtime).run(event_loop))))
}

async fn run_platform_stock_sync_watcher(
    runtime_sources: Arc<RuntimeSources>,
    state: LocalStateStore,
    backend: Arc<BackendClient>,
    ipc_context: IpcContext,
    machine_code: Option<String>,
    shutdown: CancellationToken,
) -> Result<(), String> {
    let Some(machine_code) = machine_code else {
        return Ok(());
    };
    loop {
        match sync_platform_planogram_and_stock(&runtime_sources, &state, &backend, &machine_code)
            .await
        {
            Ok(()) => ipc::refresh_sale_start_capability(&ipc_context).await,
            Err(error) => eprintln!("platform stock sync failed: {error}"),
        }
        tokio::select! {
            _ = shutdown.cancelled() => return Ok(()),
            _ = time::sleep(PLATFORM_STOCK_SYNC_INTERVAL) => {}
        }
    }
}

async fn sync_platform_planogram_and_stock(
    runtime_sources: &RuntimeSources,
    state: &LocalStateStore,
    backend: &BackendClient,
    machine_code: &str,
) -> Result<(), String> {
    if state
        .current_transaction_snapshot()
        .await
        .map_err(|error| error.to_string())?
        .as_ref()
        .is_some_and(is_active_transaction)
    {
        return Ok(());
    }
    let published = backend.get_published_planogram(machine_code).await?;
    if !published.is_null() {
        let topology = runtime_sources.hardware_topology_readiness().await?;
        if !topology.ready {
            return Err(topology.message);
        }
        let planogram_version = published
            .get("planogramVersion")
            .and_then(|value| value.as_str())
            .ok_or_else(|| "published planogram response missing planogramVersion".to_string())?
            .to_string();
        let slots = serde_json::from_value::<Vec<MachinePlanogramSlotInput>>(
            published
                .get("slots")
                .cloned()
                .ok_or_else(|| "published planogram response missing slots".to_string())?,
        )
        .map_err(|error| error.to_string())?;
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
    let stock = backend.get_stock_snapshot(machine_code).await?;
    state
        .apply_platform_stock_snapshot(&stock)
        .await
        .map_err(|error| error.to_string())?;
    Ok(())
}

async fn run_vision_watch(
    vision: VisionSupervisor,
    events: broadcast::Sender<DaemonEvent>,
    shutdown: CancellationToken,
) -> Result<(), String> {
    let mut backoff = 2_000_u64;
    loop {
        let snapshot = vision
            .start()
            .await
            .unwrap_or_else(crate::vision::VisionRuntimeSnapshot::failed);
        let _ = events.send(DaemonEvent::VisionChanged {
            event_id: uuid::Uuid::new_v4().simple().to_string(),
            updated_at: crate::state::store::now_iso(),
            enabled: snapshot.enabled,
            online: snapshot.online,
            message: snapshot.message,
            latest_diagnostic_payload: snapshot.latest_diagnostic_payload,
        });
        tokio::select! {
            _ = shutdown.cancelled() => return Ok(()),
            _ = time::sleep(std::time::Duration::from_millis(backoff)) => { backoff = (backoff * 2).min(30_000); }
        }
    }
}

async fn run_hardware_health_watcher(
    hardware: HardwareSupervisor,
    state: LocalStateStore,
    status_cache: ipc::RuntimeStatusCache,
    sale_start_context: Option<IpcContext>,
    shutdown: CancellationToken,
) -> Result<(), String> {
    loop {
        let status = hardware.self_check().await;
        let lock_changed = if let Some(code) =
            crate::state::store::classify_whole_machine_hardware_status_fault(&status)
        {
            state
                .record_whole_machine_hardware_fault_lock(
                    "hardware_health_watcher",
                    &status.message,
                    Some(code),
                )
                .await
                .is_ok()
        } else {
            false
        };
        let changed = {
            let mut cached = status_cache.hardware.write().await;
            let changed = cached.online != status.online || cached.message != status.message;
            *cached = status;
            changed
        };
        if (changed || lock_changed) && sale_start_context.is_some() {
            ipc::invalidate_sale_start_capability(sale_start_context.as_ref().expect("context"))
                .await;
        }
        tokio::select! { _ = shutdown.cancelled() => return Ok(()), _ = time::sleep(std::time::Duration::from_secs(10)) => {} }
    }
}

async fn run_sale_start_capability_polling(
    ctx: IpcContext,
    shutdown: CancellationToken,
) -> Result<(), String> {
    let mut interval = time::interval(SALE_START_CAPABILITY_POLL_INTERVAL);
    interval.set_missed_tick_behavior(time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            _ = shutdown.cancelled() => return Ok(()),
            _ = interval.tick() => ipc::refresh_sale_start_capability(&ctx).await,
        }
    }
}

async fn cache_daemon_events(
    mut events: broadcast::Receiver<DaemonEvent>,
    status_cache: ipc::RuntimeStatusCache,
    runtime_shutdown: Option<CancellationToken>,
    sale_start_context: Option<IpcContext>,
) -> Result<(), String> {
    while let Ok(event) = events.recv().await {
        let capability_input_changed = sale_start_capability_input_changed(&event);
        match event {
            DaemonEvent::MqttChanged {
                connected,
                last_error,
                ..
            } => {
                let mut cache = status_cache.sync.write().await;
                cache.mqtt_connected = connected;
                cache.last_error = last_error;
                cache.last_heartbeat_at = Some(crate::state::store::now_iso());
            }
            DaemonEvent::VisionChanged {
                enabled,
                online,
                message,
                latest_diagnostic_payload,
                ..
            } => {
                *status_cache.vision.write().await = ipc::VisionStatusSnapshot {
                    enabled,
                    online,
                    message,
                    updated_at: crate::state::store::now_iso(),
                    latest_diagnostic_payload,
                };
            }
            DaemonEvent::ScannerHealthChanged { snapshot, .. } => {
                *status_cache.scanner.write().await =
                    crate::events::scanner_health_snapshot_from_contract(snapshot)
            }
            DaemonEvent::RuntimeReconfigureRequested { .. } => {
                if let Some(shutdown) = runtime_shutdown.as_ref() {
                    shutdown.cancel();
                }
            }
            _ => {}
        }
        if capability_input_changed {
            if let Some(context) = sale_start_context.as_ref() {
                ipc::invalidate_sale_start_capability(context).await;
            }
        }
    }
    Ok(())
}

fn sale_start_capability_input_changed(event: &DaemonEvent) -> bool {
    matches!(
        event,
        DaemonEvent::MqttChanged { .. }
            | DaemonEvent::ScannerHealthChanged { .. }
            | DaemonEvent::TransactionChanged { .. }
            | DaemonEvent::SaleStartCapabilityInvalidated { .. }
            | DaemonEvent::RuntimeReconfigureRequested { .. }
    )
}

async fn write_ready_file(
    path: &Path,
    bind: SocketAddr,
    token: &str,
    generation: &str,
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| error.to_string())?;
    }
    let payload = serde_json::json!({
        "healthzUrl": format!("http://{bind}/healthz"),
        "readyzUrl": format!("http://{bind}/readyz"),
        "ipcToken": token,
        "generation": generation,
    });
    tokio::fs::write(
        path,
        serde_json::to_vec_pretty(&payload).map_err(|error| error.to_string())?,
    )
    .await
    .map_err(|error| format!("write ready file failed: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .await
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(unix)]
async fn wait_for_local_signal() -> Result<(), String> {
    use tokio::signal::unix::{self, SignalKind};
    let mut terminate = unix::signal(SignalKind::terminate()).map_err(|error| error.to_string())?;
    tokio::select! { _ = tokio::signal::ctrl_c() => Ok(()), _ = terminate.recv() => Ok(()) }
}

#[cfg(test)]
mod tests {
    use std::{num::NonZeroU64, sync::Arc};

    use wiremock::{
        matchers::{header, method, path},
        Mock, MockServer, ResponseTemplate,
    };

    use super::{refresh_provisioning_profile_once, sale_start_capability_input_changed};
    use crate::{
        backend::BackendClient, events::DaemonEvent, runtime_configuration::RuntimeSources,
        secret::InMemorySecretStore,
    };

    #[test]
    fn sale_capability_reacts_to_transaction_and_durable_stock_signals() {
        let transaction = DaemonEvent::TransactionChanged {
            event_id: "event".to_string(),
            updated_at: "2026-07-17T00:00:00Z".to_string(),
            order_no: "ORDER-1".to_string(),
            status: "success".to_string(),
        };
        let stock_upload = DaemonEvent::SaleStartCapabilityInvalidated {
            event_id: "event".to_string(),
            updated_at: "2026-07-17T00:00:00Z".to_string(),
            reason: "stock_movement_upload_applied".to_string(),
        };

        assert!(sale_start_capability_input_changed(&transaction));
        assert!(sale_start_capability_input_changed(&stock_upload));
    }

    #[tokio::test]
    async fn production_refresh_changes_only_for_new_profile_content_and_retains_it_when_refresh_degrades(
    ) {
        let temp = tempfile::tempdir().expect("temp");
        let data_dir = temp.path().join("VEM").join("vending-daemon");
        tokio::fs::create_dir_all(temp.path().join("VEM"))
            .await
            .expect("runtime root");
        tokio::fs::write(
            temp.path().join("VEM").join("runtime-bootstrap.json"),
            r#"{"schemaVersion":1,"provisioningApiBaseUrl":"https://service.example/api","hardwareModel":"vem-prod-24","topology":{"identity":"vem-prod-24","version":"v1"}}"#,
        )
        .await
        .expect("bootstrap");
        let sources = RuntimeSources::new(data_dir, Arc::new(InMemorySecretStore::default()));
        let accepted: daemon_ipc_contracts::MachineProvisioningProfile =
            serde_json::from_value(test_profile()).expect("accepted profile");
        let cache = sources
            .clean_runtime_configuration()
            .accept_profile(&accepted)
            .await
            .expect("accept profile");

        let mut refreshed_value = serde_json::to_value(&cache.profile).expect("profile snapshot");
        refreshed_value["machine"]["name"] = serde_json::json!("Refreshed machine");
        refreshed_value["metadata"]["profileRevision"] = serde_json::json!(2);
        let refreshed: daemon_ipc_contracts::MachineProvisioningProfileSnapshot =
            serde_json::from_value(refreshed_value).expect("refreshed profile");
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/machines/VEM-REFRESH-01/provisioning-profile"))
            .and(header("authorization", "Bearer refresh-token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&refreshed))
            .expect(2)
            .mount(&server)
            .await;
        let backend = BackendClient::new(server.uri());
        backend.set_access_token_for_tests("refresh-token").await;

        assert!(
            refresh_provisioning_profile_once(&sources, &backend, "VEM-REFRESH-01")
                .await
                .expect("valid refresh")
        );
        assert_eq!(
            sources
                .require_profile()
                .await
                .expect("new profile")
                .profile
                .metadata
                .profile_revision,
            NonZeroU64::new(2).expect("revision")
        );
        assert!(
            !refresh_provisioning_profile_once(&sources, &backend, "VEM-REFRESH-01")
                .await
                .expect("identical refresh")
        );

        let unavailable = BackendClient::new(MockServer::start().await.uri());
        unavailable
            .set_access_token_for_tests("refresh-token")
            .await;
        assert!(
            refresh_provisioning_profile_once(&sources, &unavailable, "VEM-REFRESH-01")
                .await
                .is_err()
        );

        let mut invalid_value = serde_json::to_value(&refreshed).expect("invalid profile source");
        invalid_value["metadata"]["profileRevision"] = serde_json::json!(3);
        invalid_value["hardwareModel"] = serde_json::json!("different-hardware");
        let invalid: daemon_ipc_contracts::MachineProvisioningProfileSnapshot =
            serde_json::from_value(invalid_value).expect("contract-valid invalid hardware");
        let invalid_server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/machines/VEM-REFRESH-01/provisioning-profile"))
            .respond_with(ResponseTemplate::new(200).set_body_json(invalid))
            .mount(&invalid_server)
            .await;
        let invalid_backend = BackendClient::new(invalid_server.uri());
        invalid_backend
            .set_access_token_for_tests("refresh-token")
            .await;
        assert!(
            refresh_provisioning_profile_once(&sources, &invalid_backend, "VEM-REFRESH-01")
                .await
                .is_err()
        );

        let retained = sources.require_profile().await.expect("last known good");
        assert_eq!(retained.profile.metadata.profile_revision.get(), 2);
        assert_eq!(
            retained.profile.machine.name.to_string(),
            "Refreshed machine"
        );
        assert_eq!(
            sources
                .clean_runtime_configuration()
                .effective_projection()
                .await
                .expect("projection")
                .profile_refresh
                .status
                .to_string(),
            "degraded"
        );
    }

    fn test_profile() -> serde_json::Value {
        serde_json::json!({
            "machine": { "id": "550e8400-e29b-41d4-a716-446655440001", "code": "VEM-REFRESH-01", "name": "Machine", "status": "offline", "locationLabel": null },
            "credentials": { "machineSecret": "m".repeat(32), "machineSecretVersion": 1, "mqttSigningSecret": "s".repeat(32), "mqttConnection": { "url": "mqtt://service.example:1883", "clientId": "vem-machine-VEM-REFRESH-01", "username": "machine", "password": "mqtt-password" } },
            "apiBaseUrl": "https://service.example/api",
            "runtimeEndpoints": { "apiBasePath": "/api", "machineAuthTokenPath": "/api/machine-auth/token", "machineApiBasePath": "/api/machines/VEM-REFRESH-01", "mqttTopicPrefix": "vem/machines/VEM-REFRESH-01" },
            "hardwareProfile": { "profile": "production", "controller": { "required": true, "protocol": "vem-vending-controller" }, "paymentScanner": { "required": true, "supportsPaymentCode": true }, "vision": { "required": false, "supportsRecommendations": true } },
            "hardwareModel": "vem-prod-24",
            "hardwareSlotTopology": { "identity": "vem-prod-24", "version": "v1" },
            "paymentCapability": { "profile": "production", "qrCodeEnabled": true, "paymentCodeEnabled": true, "serverTime": "2026-07-17T00:00:00Z" },
            "metadata": { "profileVersion": 1, "profileRevision": 1, "claimCodeId": "550e8400-e29b-41d4-a716-446655440002", "claimedAt": "2026-07-17T00:00:00Z", "serverTime": "2026-07-17T00:00:00Z" }
        })
    }
}

#[cfg(not(unix))]
async fn wait_for_local_signal() -> Result<(), String> {
    tokio::signal::ctrl_c()
        .await
        .map_err(|error| error.to_string())
}
