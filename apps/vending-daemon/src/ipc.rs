use std::{
    collections::HashMap,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};

use axum::{
    extract::{
        ws::{Message, WebSocket},
        Path as AxumPath, Query, State, WebSocketUpgrade,
    },
    http::{
        header::{AUTHORIZATION, CONTENT_DISPOSITION, CONTENT_TYPE},
        HeaderMap, Method, StatusCode,
    },
    response::{IntoResponse, Json},
    routing::{get, post},
    Router,
};
use sha2::Digest;
use tokio::sync::{broadcast, mpsc, Mutex};
use tokio_util::sync::CancellationToken;
use tower_http::cors::{Any, CorsLayer};

use crate::{
    backend::BackendClient,
    device_binding::{self, DeviceRoleRuntimeReadiness, LocalDeviceRole, LocalSerialRoleBinding},
    events::{scanner_runtime_status_contract, DaemonEvent},
    hardware::HardwareSupervisor,
    local_runtime_settings::{
        effective_scanner_protocol, AudioPreferences, LocalRuntimeSettings,
        ScannerProtocolParameters,
    },
    logs,
    natural_context::MachineNaturalContextSnapshot,
    network::{
        NetworkAdapter, NetworkSettingsRequest, NetworkSettingsResponse, NetworkSetupStatus,
        WifiScanResponse,
    },
    provisioning::validate_machine_provisioning_profile,
    runtime_configuration::RuntimeSources,
    scanner::{ScannerRuntimeConfig, ScannerRuntimeController},
    state::{
        store::{
            MachinePlanogramInput, PhysicalStockAttestationInput, StockMaintenanceBatchInput,
            OUTBOX_MAX_EVENTS,
        },
        LocalStateStore,
    },
    transaction::TransactionStateMachine,
};

const SCANNER_READY_STALE_AFTER_SECONDS: i64 = 30;
const PAYMENT_CODE_SCANNER_UNAVAILABLE_CUSTOMER_MESSAGE: &str =
    "扫码器暂不可用，请选择其他支付方式";

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorMessage {
    code: &'static str,
    message: String,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateOrder {
    inventory_id: String,
    quantity: u32,
    planogram_version: String,
    slot_id: String,
    slot_code: String,
    payment_method: String,
    payment_provider_code: Option<String>,
    profile_snapshot: Option<serde_json::Value>,
    idempotency_key: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CancelOrder {
    order_no: String,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeviceBindingTestRequest {
    identity_key: String,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VisionCameraMaintenanceCandidateRequest {
    candidate_id: String,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceBindingTestResponse {
    #[serde(flatten)]
    result: device_binding::DeviceBindingTestResult,
    test_evidence_token: String,
    test_evidence_expires_at: String,
    observation_revision: String,
    config_revision: String,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClearWholeMachineMaintenanceLockRequest {
    operator_note: String,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ManualDispenseDiagnosticRequest {
    idempotency_key: String,
    slot_code: String,
    #[serde(default = "default_manual_dispense_quantity")]
    quantity: u32,
    #[serde(default = "default_manual_dispense_timeout")]
    timeout_seconds: u64,
}

fn default_manual_dispense_quantity() -> u32 {
    1
}

fn default_manual_dispense_timeout() -> u64 {
    30
}

#[derive(Debug, serde::Deserialize)]
struct EventQuery {
    token: Option<String>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ClaimMachineResponse {
    status: &'static str,
    machine_code: String,
    restart_requested: bool,
    config: daemon_ipc_contracts::EffectiveMachineRuntimeConfiguration,
}

#[derive(Debug, Clone)]
struct DeviceBindingTestEvidence {
    role: LocalDeviceRole,
    identity_key: String,
    observation_revision: String,
    config_revision: String,
    expires_at: Instant,
}

#[derive(Debug)]
pub(crate) struct DeviceBindingTestEvidenceStore {
    entries: Mutex<HashMap<String, DeviceBindingTestEvidence>>,
    ttl: Duration,
}

impl Default for DeviceBindingTestEvidenceStore {
    fn default() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            ttl: Duration::from_secs(60),
        }
    }
}

impl DeviceBindingTestEvidenceStore {
    async fn issue(
        &self,
        role: LocalDeviceRole,
        identity_key: String,
        observation_revision: String,
        config_revision: String,
    ) -> (String, String) {
        let token = uuid::Uuid::new_v4().to_string();
        let expires_at = Instant::now() + self.ttl;
        self.entries.lock().await.insert(
            token.clone(),
            DeviceBindingTestEvidence {
                role,
                identity_key,
                observation_revision,
                config_revision,
                expires_at,
            },
        );
        (
            token,
            (chrono::Utc::now() + chrono::Duration::seconds(self.ttl.as_secs() as i64))
                .to_rfc3339(),
        )
    }

    async fn consume(
        &self,
        token: &str,
        role: LocalDeviceRole,
        identity_key: &str,
        observation_revision: &str,
        config_revision: &str,
    ) -> Result<(), String> {
        let mut entries = self.entries.lock().await;
        entries.retain(|_, item| item.expires_at > Instant::now());
        let evidence = entries.remove(token).ok_or_else(|| {
            "device binding test evidence is missing, expired, or already consumed".to_string()
        })?;
        if evidence.role != role
            || evidence.identity_key != identity_key
            || evidence.observation_revision != observation_revision
            || evidence.config_revision != config_revision
        {
            return Err("device binding changed after its successful test".to_string());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisionStatusSnapshot {
    pub enabled: bool,
    pub online: bool,
    pub message: String,
    pub updated_at: String,
    pub latest_diagnostic_payload: Option<serde_json::Value>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogSnapshot {
    pub items: Vec<serde_json::Value>,
    pub cached: bool,
    pub last_updated_at: Option<String>,
    pub source: String,
    pub last_error: Option<String>,
}

#[derive(Clone)]
pub struct RuntimeStatusCache {
    pub sync: Arc<tokio::sync::RwLock<vending_core::domain::SyncStatusSnapshot>>,
    pub hardware: Arc<tokio::sync::RwLock<vending_core::hardware::HardwareStatus>>,
    pub scanner: Arc<tokio::sync::RwLock<vending_core::scanner::ScannerHealthSnapshot>>,
    pub vision: Arc<tokio::sync::RwLock<VisionStatusSnapshot>>,
    pub catalog: Arc<tokio::sync::RwLock<CatalogSnapshot>>,
    pub environment: Arc<tokio::sync::RwLock<vending_core::environment::EnvironmentHeartbeatCache>>,
    pub network: Arc<tokio::sync::RwLock<Option<NetworkSettingsResponse>>>,
    sale_start_generation: String,
    sale_start_state: Arc<Mutex<SaleStartCapabilityState>>,
}

#[derive(Debug, Default)]
struct SaleStartCapabilityState {
    revision: u64,
    fingerprint: Option<Vec<u8>>,
    last_accepted: Option<daemon_ipc_contracts::SaleStartCapabilitySnapshot>,
}

impl RuntimeStatusCache {
    pub async fn new(
        profile: Option<&daemon_ipc_contracts::ProvisioningProfileCache>,
        state: LocalStateStore,
    ) -> Self {
        let outbox_size = state.outbox_size().await.unwrap_or_default() as usize;
        let mqtt_url = profile.map(|profile| profile.profile.mqtt_connection.url.clone());
        let vision_expected = profile
            .map(|profile| {
                profile.profile.hardware_profile.vision.required
                    || profile
                        .profile
                        .hardware_profile
                        .vision
                        .supports_recommendations
            })
            .unwrap_or(false);
        Self {
            sync: Arc::new(tokio::sync::RwLock::new(
                vending_core::domain::SyncStatusSnapshot {
                    mqtt_running: mqtt_url.as_deref().is_some_and(|url| {
                        url.starts_with("mqtt://") || url.starts_with("mqtts://")
                    }),
                    mqtt_connected: false,
                    broker_url_masked: mqtt_url,
                    last_heartbeat_at: None,
                    last_command_no: None,
                    outbox_size,
                    outbox_max: OUTBOX_MAX_EVENTS as usize,
                    outbox_usage: outbox_size as f64 / OUTBOX_MAX_EVENTS.max(1) as f64,
                    next_retry_at: None,
                    last_error: None,
                    tls_auth_status: None,
                },
            )),
            hardware: Arc::new(tokio::sync::RwLock::new(
                vending_core::hardware::HardwareStatus {
                    adapter: "serial".to_string(),
                    online: false,
                    message: "hardware runtime initializing".to_string(),
                    port_path: None,
                    resolution_source: None,
                    bound_usb_identity: None,
                    candidates: vec![],
                    lower_controller_fault: None,
                },
            )),
            scanner: Arc::new(tokio::sync::RwLock::new(scanner_health(
                "SCANNER_INITIALIZING",
                "scanner runtime initializing",
            ))),
            vision: Arc::new(tokio::sync::RwLock::new(VisionStatusSnapshot {
                enabled: vision_expected,
                online: false,
                message: "vision runtime initializing".to_string(),
                updated_at: crate::state::store::now_iso(),
                latest_diagnostic_payload: None,
            })),
            catalog: Arc::new(tokio::sync::RwLock::new(CatalogSnapshot {
                items: vec![],
                cached: false,
                last_updated_at: None,
                source: "uninitialized".to_string(),
                last_error: None,
            })),
            environment: Arc::new(tokio::sync::RwLock::new(
                vending_core::environment::EnvironmentHeartbeatCache::default(),
            )),
            network: Arc::new(tokio::sync::RwLock::new(None)),
            sale_start_generation: uuid::Uuid::new_v4().simple().to_string(),
            sale_start_state: Arc::new(Mutex::new(SaleStartCapabilityState::default())),
        }
    }
}

#[derive(Clone)]
pub struct UiRuntimeServices {
    pub backend: Arc<BackendClient>,
    pub transaction: TransactionStateMachine,
    pub status_cache: RuntimeStatusCache,
}

#[derive(Clone)]
pub struct IpcContext {
    pub data_dir: PathBuf,
    pub token: String,
    pub runtime_sources: Arc<RuntimeSources>,
    pub state: LocalStateStore,
    pub hardware: HardwareSupervisor,
    pub events: broadcast::Sender<DaemonEvent>,
    pub runtime_tx: mpsc::Sender<crate::transaction::ArmedPaymentCode>,
    pub scanner_runtime: ScannerRuntimeController,
    pub serial_device_platform: device_binding::SharedSerialDevicePlatform,
    pub(crate) device_binding_test_evidence: Arc<DeviceBindingTestEvidenceStore>,
    pub(crate) sale_binding_gate: Arc<SaleBindingOperationGate>,
    pub disk_pressure_probe: Arc<dyn crate::health::DiskPressureProbe>,
    pub network_adapter: Arc<dyn NetworkAdapter>,
    pub ui: UiRuntimeServices,
    pub background_shutdown: CancellationToken,
}

const GATE_IDLE: u8 = 0;
const GATE_SALE: u8 = 1;
const GATE_BINDING: u8 = 2;
const GATE_MANUAL_DISPENSE: u8 = 3;

#[derive(Debug, Default)]
pub(crate) struct SaleBindingOperationGate {
    state: std::sync::atomic::AtomicU8,
}
impl SaleBindingOperationGate {
    pub(crate) async fn acquire_sale_start(
        self: &Arc<Self>,
        timeout: Duration,
    ) -> Result<SaleBindingOperationLease, u8> {
        let deadline = Instant::now() + timeout;
        loop {
            match self.try_acquire_sale_start() {
                Ok(lease) => return Ok(lease),
                Err(active) if Instant::now() >= deadline => return Err(active),
                Err(_) => tokio::time::sleep(Duration::from_millis(25)).await,
            }
        }
    }

    pub(crate) fn try_acquire_sale_start(
        self: &Arc<Self>,
    ) -> Result<SaleBindingOperationLease, u8> {
        self.acquire(GATE_SALE)
    }
    pub(crate) fn try_acquire_reconfigure(
        self: &Arc<Self>,
    ) -> Result<SaleBindingOperationLease, u8> {
        self.acquire(GATE_BINDING)
    }
    pub(crate) fn try_acquire_manual_dispense(
        self: &Arc<Self>,
    ) -> Result<SaleBindingOperationLease, u8> {
        self.acquire(GATE_MANUAL_DISPENSE)
    }
    pub(crate) async fn acquire_manual_dispense(
        self: &Arc<Self>,
        timeout: Duration,
    ) -> Result<SaleBindingOperationLease, u8> {
        let deadline = Instant::now() + timeout;
        loop {
            match self.try_acquire_manual_dispense() {
                Ok(lease) => return Ok(lease),
                Err(active) if Instant::now() >= deadline => return Err(active),
                Err(_) => tokio::time::sleep(Duration::from_millis(25)).await,
            }
        }
    }
    fn acquire(self: &Arc<Self>, operation: u8) -> Result<SaleBindingOperationLease, u8> {
        self.state
            .compare_exchange(
                GATE_IDLE,
                operation,
                std::sync::atomic::Ordering::AcqRel,
                std::sync::atomic::Ordering::Acquire,
            )
            .map(|_| SaleBindingOperationLease {
                gate: self.clone(),
                operation,
            })
            .map_err(|active| active)
    }
}
pub(crate) struct SaleBindingOperationLease {
    gate: Arc<SaleBindingOperationGate>,
    operation: u8,
}

#[derive(Debug, PartialEq, Eq)]
enum BindingMutationSafety {
    ActiveSale,
    StateUnavailable(String),
}

fn binding_mutation_safety<T>(
    snapshot: Result<Option<T>, String>,
    is_active: impl FnOnce(&T) -> bool,
) -> Result<(), BindingMutationSafety> {
    match snapshot {
        Ok(Some(snapshot)) if is_active(&snapshot) => Err(BindingMutationSafety::ActiveSale),
        Ok(_) => Ok(()),
        Err(error) => Err(BindingMutationSafety::StateUnavailable(error)),
    }
}

async fn require_binding_mutation_safe(ctx: &IpcContext) -> Result<(), BindingMutationSafety> {
    binding_mutation_safety(
        ctx.state
            .current_transaction_snapshot()
            .await
            .map_err(|error| error.to_string()),
        crate::transaction::is_active_transaction,
    )
}

fn binding_mutation_safety_response(safety: BindingMutationSafety) -> axum::response::Response {
    match safety {
        BindingMutationSafety::ActiveSale => error_response(
            StatusCode::CONFLICT,
            "device_binding_active_sale",
            "hardware binding cannot change during an active sale",
        ),
        BindingMutationSafety::StateUnavailable(error) => error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "device_binding_active_sale_state_unavailable",
            format!("hardware binding cannot change until active-sale state is available: {error}"),
        ),
    }
}
impl Drop for SaleBindingOperationLease {
    fn drop(&mut self) {
        let _ = self.gate.state.compare_exchange(
            self.operation,
            GATE_IDLE,
            std::sync::atomic::Ordering::AcqRel,
            std::sync::atomic::Ordering::Acquire,
        );
    }
}

#[derive(Clone)]
pub struct IpcServerHandle {
    pub addr: SocketAddr,
    pub shutdown: CancellationToken,
}

pub fn build_router(ctx: IpcContext) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
        .route("/v1/runtime-configuration", get(runtime_configuration))
        .route(
            "/v1/runtime-configuration/reset",
            post(reset_runtime_configuration),
        )
        .route(
            "/v1/runtime-configuration/intents/hardware-bindings/:role/confirm",
            post(confirm_runtime_binding),
        )
        .route(
            "/v1/runtime-configuration/intents/hardware-bindings/:role/clear",
            post(clear_runtime_binding),
        )
        .route(
            "/v1/runtime-configuration/intents/scanner-protocol-parameters",
            post(set_scanner_protocol),
        )
        .route(
            "/v1/runtime-configuration/intents/audio-preferences",
            post(set_audio_preferences),
        )
        .route("/v1/provisioning/claim", post(claim_machine))
        .route("/v1/network/settings", post(apply_network_settings))
        .route("/v1/network/available", get(available_networks))
        .route("/v1/catalog", get(catalog_snapshot).post(refresh_catalog))
        .route("/v1/sale-view", get(sale_view))
        .route("/v1/sale-start-capability", get(sale_start_capability))
        .route("/v1/payment-options", get(payment_options))
        .route("/v1/intents/create-order", post(create_order))
        .route("/v1/intents/cancel-order", post(cancel_order))
        .route("/v1/transactions/current", get(current_transaction))
        .route("/v1/transactions/:order_no", get(current_transaction))
        .route("/v1/stock/planogram", post(apply_planogram))
        .route(
            "/v1/stock/maintenance-task",
            get(stock_maintenance_task).post(submit_stock_maintenance_batch),
        )
        .route(
            "/v1/stock/maintenance-tasks/:task_id/projection",
            get(stock_maintenance_task_projection),
        )
        .route(
            "/v1/stock/attestation",
            post(record_physical_stock_attestation),
        )
        .route(
            "/v1/maintenance/whole-machine-lock/clear",
            post(clear_whole_machine_maintenance_lock),
        )
        .route(
            "/v1/maintenance/payment-environment",
            get(payment_environment_diagnostic),
        )
        .route(
            "/v1/maintenance/manual-dispense-diagnostic",
            post(manual_dispense_diagnostic),
        )
        .route("/v1/hardware/self-check", post(hardware_self_check))
        .route("/v1/hardware-bindings", get(device_binding_snapshot))
        .route("/v1/hardware-bindings/:role/test", post(test_binding))
        .route("/v1/sync/status", get(sync_status))
        .route("/v1/scanner/status", get(scanner_status))
        .route("/v1/vision/status", get(vision_status))
        .route(
            "/v1/vision/camera-maintenance",
            get(vision_camera_maintenance_contract),
        )
        .route(
            "/v1/vision/camera-maintenance/refresh",
            post(vision_camera_maintenance_refresh),
        )
        .route(
            "/v1/vision/camera-maintenance/candidates/:candidate_id/preview.jpg",
            get(vision_camera_maintenance_preview),
        )
        .route(
            "/v1/vision/camera-maintenance/roles/:role/test",
            post(vision_camera_maintenance_test),
        )
        .route(
            "/v1/vision/camera-maintenance/roles/:role/confirm",
            post(vision_camera_maintenance_confirm),
        )
        .route("/v1/natural-context", get(natural_context))
        .route("/v1/remote-ops/status", get(remote_ops_status))
        .route("/v1/logs/export", get(export_logs))
        .route("/v1/events", get(events_ws))
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
                .allow_headers([AUTHORIZATION, CONTENT_TYPE])
                .allow_private_network(true),
        )
        .with_state(ctx)
}

pub fn assert_loopback(addr: SocketAddr) -> Result<(), String> {
    if addr.ip().is_loopback() {
        Ok(())
    } else {
        Err(format!(
            "IPC bind address must be loopback, got {}",
            addr.ip()
        ))
    }
}

pub async fn run_server(
    bind: SocketAddr,
    mut context: IpcContext,
) -> Result<(IpcServerHandle, tokio::task::JoinHandle<Result<(), String>>), String> {
    assert_loopback(bind)?;
    let listener = tokio::net::TcpListener::bind(bind)
        .await
        .map_err(|error| format!("bind IPC failed: {error}"))?;
    let addr = listener.local_addr().map_err(|error| error.to_string())?;
    let shutdown = CancellationToken::new();
    context.background_shutdown = shutdown.clone();
    let graceful = shutdown.clone();
    let task = tokio::spawn(async move {
        axum::serve(listener, build_router(context))
            .with_graceful_shutdown(async move { graceful.cancelled().await })
            .await
            .map_err(|error| format!("serve IPC failed: {error}"))
    });
    Ok((IpcServerHandle { addr, shutdown }, task))
}

pub async fn load_or_create_ipc_token(data_dir: &Path) -> Result<String, String> {
    let path = data_dir.join("ipc-token");
    if let Ok(value) = tokio::fs::read_to_string(&path).await {
        let value = value.trim().to_string();
        if !value.is_empty() {
            return Ok(value);
        }
    }
    let token = uuid::Uuid::new_v4().to_string();
    tokio::fs::write(&path, format!("{token}\n"))
        .await
        .map_err(|error| format!("write IPC token failed: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
            .await
            .map_err(|error| error.to_string())?;
    }
    Ok(token)
}

async fn require_token(
    headers: &HeaderMap,
    token: &str,
) -> Result<(), (StatusCode, Json<ErrorMessage>)> {
    let value = headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));
    if value == Some(token) {
        Ok(())
    } else {
        Err((
            StatusCode::UNAUTHORIZED,
            Json(ErrorMessage {
                code: "unauthorized",
                message: "missing or invalid IPC token".to_string(),
            }),
        ))
    }
}

async fn healthz(State(ctx): State<IpcContext>) -> impl IntoResponse {
    let aggregate = crate::health::HealthAggregator::new(ctx.state.clone());
    let mut snapshot = aggregate.health_snapshot().await;
    let hardware = ctx.ui.status_cache.hardware.read().await.clone();
    snapshot.hardware_online = hardware.online;
    snapshot.components.push(component(
        "hardware",
        hardware.online,
        if hardware.online {
            "HARDWARE_READY"
        } else {
            "LOWER_CONTROLLER_UNAVAILABLE"
        },
        hardware.message,
    ));
    let scanner = ctx.ui.status_cache.scanner.read().await.clone();
    snapshot.scanner_online = scanner.online;
    snapshot
        .components
        .push(vending_core::health::ComponentHealth {
            component: "scanner".to_string(),
            level: scanner.level,
            code: scanner.code,
            message: scanner.message,
            updated_at: scanner.updated_at,
        });
    if !hardware.online {
        snapshot.status = vending_core::health::DaemonUiStatus::Degraded;
        snapshot.operator_reason = "LOWER_CONTROLLER_UNAVAILABLE".to_string();
    }
    Json(snapshot)
}

async fn readyz(State(ctx): State<IpcContext>) -> impl IntoResponse {
    let aggregate = crate::health::HealthAggregator::new(ctx.state.clone());
    Json(aggregate.ready_snapshot().await)
}

fn component(
    component: &str,
    online: bool,
    code: &str,
    message: String,
) -> vending_core::health::ComponentHealth {
    vending_core::health::ComponentHealth {
        component: component.to_string(),
        level: if online {
            vending_core::health::HealthLevel::Ok
        } else {
            vending_core::health::HealthLevel::Offline
        },
        code: code.to_string(),
        message,
        updated_at: crate::state::store::now_iso(),
    }
}

async fn runtime_configuration(
    State(ctx): State<IpcContext>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if let Err(error) = require_token(&headers, &ctx.token).await {
        return error.into_response();
    }
    match ctx
        .runtime_sources
        .clean_runtime_configuration()
        .effective_projection()
        .await
    {
        Ok(value) => Json(value).into_response(),
        Err(message) => error_response(
            StatusCode::CONFLICT,
            "runtime_configuration_unavailable",
            message,
        ),
    }
}

async fn reset_runtime_configuration(
    State(ctx): State<IpcContext>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if let Err(error) = require_token(&headers, &ctx.token).await {
        return error.into_response();
    }
    if let Err(message) = ctx
        .runtime_sources
        .clean_runtime_configuration()
        .reset_local_runtime()
        .await
    {
        return error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "runtime_configuration_reset_failed",
            message,
        );
    }
    let _ = ctx.events.send(DaemonEvent::RuntimeReconfigureRequested {
        event_id: uuid::Uuid::new_v4().simple().to_string(),
        updated_at: crate::state::store::now_iso(),
        reason: "local_runtime_reset".to_string(),
        machine_code: None,
    });
    Json(serde_json::json!({ "reset": true, "restartRequested": true })).into_response()
}

async fn claim_machine(
    State(ctx): State<IpcContext>,
    headers: HeaderMap,
    Json(input): Json<daemon_ipc_contracts::MachineClaimRequest>,
) -> impl IntoResponse {
    if let Err(error) = require_token(&headers, &ctx.token).await {
        return error.into_response();
    }
    let claim_code = input.claim_code.trim().to_ascii_uppercase();
    if claim_code.is_empty() {
        return error_response(
            StatusCode::BAD_REQUEST,
            "machine_claim_invalid",
            "machine claim code is required",
        );
    }
    let clean = ctx.runtime_sources.clean_runtime_configuration();
    let bootstrap = match clean.load_bootstrap().await {
        Ok(value) => value,
        Err(error) => {
            return error_response(StatusCode::CONFLICT, "runtime_bootstrap_invalid", error);
        }
    };
    let profile = match BackendClient::new(bootstrap.provisioning_api_base_url.to_string())
        .claim_machine_from_bootstrap(&claim_code)
        .await
    {
        Ok(value) => value,
        Err(error) => {
            return error_response(StatusCode::BAD_GATEWAY, "machine_claim_failed", error);
        }
    };
    if let Err(error) = validate_machine_provisioning_profile(&profile) {
        return error_response(StatusCode::BAD_REQUEST, "machine_profile_invalid", error);
    }
    let machine_code = profile.machine.code.to_string();
    if let Err(error) = clean.accept_profile(&profile).await {
        return error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "machine_profile_persistence_failed",
            error,
        );
    }
    let config = match clean.effective_projection().await {
        Ok(value) => value,
        Err(error) => {
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "machine_profile_projection_failed",
                error,
            );
        }
    };
    let _ = ctx.events.send(DaemonEvent::RuntimeReconfigureRequested {
        event_id: uuid::Uuid::new_v4().simple().to_string(),
        updated_at: crate::state::store::now_iso(),
        reason: "machine_claimed".to_string(),
        machine_code: Some(machine_code.clone()),
    });
    (
        StatusCode::OK,
        Json(ClaimMachineResponse {
            status: "provisioned",
            machine_code,
            restart_requested: true,
            config,
        }),
    )
        .into_response()
}

async fn apply_network_settings(
    State(ctx): State<IpcContext>,
    headers: HeaderMap,
    Json(input): Json<NetworkSettingsRequest>,
) -> impl IntoResponse {
    if let Err(error) = require_token(&headers, &ctx.token).await {
        return error.into_response();
    }
    let response = ctx.network_adapter.apply_wifi_settings(input).await;
    let status = match response.status {
        NetworkSetupStatus::Connected => StatusCode::OK,
        NetworkSetupStatus::Failed => StatusCode::BAD_REQUEST,
        NetworkSetupStatus::Unsupported => StatusCode::UNPROCESSABLE_ENTITY,
    };
    *ctx.ui.status_cache.network.write().await = Some(response.clone());
    (status, Json(response)).into_response()
}

async fn available_networks(
    State(ctx): State<IpcContext>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if let Err(error) = require_token(&headers, &ctx.token).await {
        return error.into_response();
    }
    Json(ctx.network_adapter.scan_wifi_networks().await as WifiScanResponse).into_response()
}

async fn catalog_snapshot(State(ctx): State<IpcContext>, headers: HeaderMap) -> impl IntoResponse {
    if let Err(error) = require_token(&headers, &ctx.token).await {
        return error.into_response();
    }
    Json(ctx.ui.status_cache.catalog.read().await.clone()).into_response()
}

async fn refresh_catalog(State(ctx): State<IpcContext>, headers: HeaderMap) -> impl IntoResponse {
    if let Err(error) = require_token(&headers, &ctx.token).await {
        return error.into_response();
    }
    let profile = match ctx.runtime_sources.require_profile().await {
        Ok(value) => value,
        Err(error) => return error_response(StatusCode::CONFLICT, "machine_not_claimed", error),
    };
    match ctx
        .ui
        .backend
        .get_catalog(&profile.profile.machine.code.to_string())
        .await
    {
        Ok(payload) => {
            let items = payload
                .get("items")
                .and_then(|value| value.as_array())
                .cloned()
                .unwrap_or_else(|| payload.as_array().cloned().unwrap_or_default());
            let value = CatalogSnapshot {
                items,
                cached: true,
                last_updated_at: Some(crate::state::store::now_iso()),
                source: "backend".to_string(),
                last_error: None,
            };
            *ctx.ui.status_cache.catalog.write().await = value.clone();
            Json(value).into_response()
        }
        Err(error) => error_response(StatusCode::BAD_GATEWAY, "catalog_refresh_failed", error),
    }
}

async fn sale_view(State(ctx): State<IpcContext>, headers: HeaderMap) -> impl IntoResponse {
    if let Err(error) = require_token(&headers, &ctx.token).await {
        return error.into_response();
    }
    let machine_code = ctx
        .runtime_sources
        .require_profile()
        .await
        .ok()
        .map(|profile| profile.profile.machine.code.to_string());
    match ctx.state.sale_view(machine_code).await {
        Ok(value) => Json(value).into_response(),
        Err(error) => error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "sale_view_failed",
            error.to_string(),
        ),
    }
}

async fn sale_start_capability(
    State(ctx): State<IpcContext>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if let Err(error) = require_token(&headers, &ctx.token).await {
        return error.into_response();
    }
    match sale_start_capability_snapshot(&ctx, false).await {
        Ok(value) => Json(value).into_response(),
        Err(error) => error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "sale_start_capability_unavailable",
            error,
        ),
    }
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackendPaymentOption {
    option_key: String,
    provider_code: String,
    method: String,
    display_name: String,
    description: String,
    icon: String,
    #[serde(default)]
    recommended: bool,
    #[serde(default)]
    disabled: bool,
    #[serde(default)]
    disabled_reason: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackendPaymentOptions {
    options: Vec<BackendPaymentOption>,
    default_option_key: Option<String>,
    default_provider_code: Option<String>,
}

struct SaleStartCapabilityObservation {
    profile: daemon_ipc_contracts::ProvisioningProfileCache,
    topology: crate::runtime_configuration::HardwareTopologyReadiness,
    hardware: vending_core::hardware::HardwareStatus,
    whole_machine_locked: bool,
    has_saleable_slot: bool,
    mqtt_connected: bool,
    scanner_ready: bool,
    scanner_code: String,
    scanner_message: String,
    platform_default_option_key: Option<String>,
    platform_default_provider_code: Option<String>,
    payment_options: Vec<BackendPaymentOption>,
}

fn capability_reason(
    code: impl Into<String>,
    component: impl Into<String>,
    message: impl Into<String>,
) -> daemon_ipc_contracts::SaleStartCapabilityReason {
    daemon_ipc_contracts::SaleStartCapabilityReason {
        code: code.into(),
        component: component.into(),
        message: message.into(),
    }
}

fn capability_degradation(
    code: impl Into<String>,
    component: impl Into<String>,
    message: impl Into<String>,
) -> daemon_ipc_contracts::SaleStartCapabilityDegradation {
    daemon_ipc_contracts::SaleStartCapabilityDegradation {
        code: code.into(),
        component: component.into(),
        message: message.into(),
    }
}

fn payment_method_allowed_by_profile(
    method: &str,
    profile: &daemon_ipc_contracts::ProvisioningProfileCache,
) -> bool {
    match method {
        "qr_code" => profile.profile.payment_capability.qr_code_enabled,
        "payment_code" => profile.profile.payment_capability.payment_code_enabled,
        "mock" => true,
        _ => false,
    }
}

fn evaluate_sale_start_capability(
    observation: &SaleStartCapabilityObservation,
    generation: String,
    revision: std::num::NonZeroU64,
    observed_at: String,
) -> daemon_ipc_contracts::SaleStartCapabilitySnapshot {
    let options = observation
        .payment_options
        .iter()
        .filter(|option| payment_method_allowed_by_profile(&option.method, &observation.profile))
        .map(|option| {
            let scanner_blocked = option.method == "payment_code" && !observation.scanner_ready;
            daemon_ipc_contracts::SaleStartCapabilityPaymentOption {
                option_key: option.option_key.clone(),
                provider_code: option.provider_code.clone(),
                method: option.method.clone(),
                display_name: option.display_name.clone(),
                description: option.description.clone(),
                icon: option.icon.clone(),
                recommended: option.recommended,
                ready: !option.disabled && !scanner_blocked,
                disabled_reason: if scanner_blocked {
                    Some(observation.scanner_message.clone())
                } else {
                    option.disabled_reason.clone()
                },
            }
        })
        .collect::<Vec<_>>();
    let payment_ready = options.iter().any(|option| option.ready);
    let default = observation
        .platform_default_option_key
        .as_deref()
        .and_then(|key| {
            options
                .iter()
                .find(|option| option.option_key == key && option.ready)
        })
        .or_else(|| options.iter().find(|option| option.ready));

    let mut blockers = Vec::new();
    if !observation.topology.ready {
        blockers.push(capability_reason(
            observation.topology.code.clone(),
            "hardware_slot_topology",
            observation.topology.message.clone(),
        ));
    }
    if !observation.hardware.online {
        blockers.push(capability_reason(
            "LOWER_CONTROLLER_UNAVAILABLE",
            "hardware",
            observation.hardware.message.clone(),
        ));
    }
    if observation.whole_machine_locked {
        blockers.push(capability_reason(
            "WHOLE_MACHINE_LOCKED",
            "hardware",
            "lower controller recovery is required",
        ));
    }
    if !observation.has_saleable_slot {
        blockers.push(capability_reason(
            "NO_SALEABLE_SLOTS",
            "stock",
            "no active planogram slot has saleable stock",
        ));
    }
    if !observation.mqtt_connected {
        blockers.push(capability_reason(
            "MQTT_UNAVAILABLE",
            "sync",
            "network-authorized sale synchronization is unavailable",
        ));
    }
    if !payment_ready {
        blockers.push(capability_reason(
            "NO_PAYMENT_OPTIONS",
            "payment_options",
            "no profile-supported payment option is ready",
        ));
    }

    let mut degradations = Vec::new();
    if options.iter().any(|option| option.method == "payment_code")
        && !observation.scanner_ready
        && payment_ready
    {
        degradations.push(capability_degradation(
            observation.scanner_code.clone(),
            "scanner",
            observation.scanner_message.clone(),
        ));
    }
    daemon_ipc_contracts::SaleStartCapabilitySnapshot {
        generation: daemon_ipc_contracts::SaleStartCapabilityGeneration::try_from(generation)
            .expect("capability generation is non-empty"),
        revision,
        observed_at,
        can_start_sale: blockers.is_empty(),
        blockers,
        degradations,
        payment_options: daemon_ipc_contracts::SaleStartCapabilityPaymentOptions {
            ready: payment_ready,
            default_option_key: default.map(|option| option.option_key.clone()),
            default_provider_code: default
                .map(|option| option.provider_code.clone())
                .or_else(|| observation.platform_default_provider_code.clone()),
            options,
        },
    }
}

async fn observe_sale_start_capability(
    ctx: &IpcContext,
) -> Result<SaleStartCapabilityObservation, String> {
    let profile = ctx.runtime_sources.require_profile().await?;
    let topology = ctx.runtime_sources.hardware_topology_readiness().await?;
    let hardware = ctx.ui.status_cache.hardware.read().await.clone();
    let whole_machine_locked = ctx
        .state
        .whole_machine_maintenance_lock()
        .await
        .map_err(|error| error.to_string())?
        .is_some();
    let sale_view = ctx
        .state
        .sale_view(Some(profile.profile.machine.code.to_string()))
        .await
        .map_err(|error| error.to_string())?;
    let has_saleable_slot = sale_view
        .items
        .iter()
        .any(|item| item.slot_sales_state == "sale_ready" && item.saleable_stock > 0);
    let sync = ctx.ui.status_cache.sync.read().await.clone();
    let scanner = ctx.ui.status_cache.scanner.read().await.clone();
    let (scanner_ready, scanner_message) = scanner_payment_readiness(&scanner);
    let payment_value = ctx.ui.backend.get_payment_options().await?;
    let payment: BackendPaymentOptions = serde_json::from_value(payment_value)
        .map_err(|error| format!("payment options contract invalid: {error}"))?;
    Ok(SaleStartCapabilityObservation {
        profile,
        topology,
        hardware,
        whole_machine_locked,
        has_saleable_slot,
        mqtt_connected: sync.mqtt_connected,
        scanner_ready,
        scanner_code: scanner.code,
        scanner_message,
        platform_default_option_key: payment.default_option_key,
        platform_default_provider_code: payment.default_provider_code,
        payment_options: payment.options,
    })
}

fn capability_fingerprint(snapshot: &daemon_ipc_contracts::SaleStartCapabilitySnapshot) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "canStartSale": snapshot.can_start_sale,
        "blockers": snapshot.blockers,
        "degradations": snapshot.degradations,
        "paymentOptions": snapshot.payment_options,
    }))
    .expect("capability snapshot is serializable")
}

async fn apply_fail_closed_cached_facts(
    ctx: &IpcContext,
    mut snapshot: daemon_ipc_contracts::SaleStartCapabilitySnapshot,
) -> daemon_ipc_contracts::SaleStartCapabilitySnapshot {
    let mqtt_connected = ctx.ui.status_cache.sync.read().await.mqtt_connected;
    if !mqtt_connected
        && !snapshot
            .blockers
            .iter()
            .any(|reason| reason.code == "MQTT_UNAVAILABLE")
    {
        snapshot.blockers.push(capability_reason(
            "MQTT_UNAVAILABLE",
            "sync",
            "network-authorized sale synchronization is unavailable",
        ));
    }

    let scanner = ctx.ui.status_cache.scanner.read().await.clone();
    let (scanner_ready, scanner_message) = scanner_payment_readiness(&scanner);
    if !scanner_ready {
        for option in &mut snapshot.payment_options.options {
            if option.method == "payment_code" {
                option.ready = false;
                option.disabled_reason = Some(scanner_message.clone());
            }
        }
        snapshot
            .degradations
            .retain(|reason| reason.component != "scanner");
        if snapshot
            .payment_options
            .options
            .iter()
            .any(|option| option.method == "payment_code")
        {
            snapshot.degradations.push(capability_degradation(
                scanner.code,
                "scanner",
                scanner_message,
            ));
        }
    }

    let payment_ready = snapshot
        .payment_options
        .options
        .iter()
        .any(|option| option.ready);
    snapshot.payment_options.ready = payment_ready;
    snapshot.payment_options.default_option_key = snapshot
        .payment_options
        .default_option_key
        .as_deref()
        .and_then(|key| {
            snapshot
                .payment_options
                .options
                .iter()
                .find(|option| option.option_key == key && option.ready)
        })
        .or_else(|| {
            snapshot
                .payment_options
                .options
                .iter()
                .find(|option| option.ready)
        })
        .map(|option| option.option_key.clone());
    if !payment_ready
        && !snapshot
            .blockers
            .iter()
            .any(|reason| reason.code == "NO_PAYMENT_OPTIONS")
    {
        snapshot.blockers.push(capability_reason(
            "NO_PAYMENT_OPTIONS",
            "payment_options",
            "no profile-supported payment option is ready",
        ));
    }
    snapshot.can_start_sale = snapshot.blockers.is_empty();
    snapshot
}

async fn sale_start_capability_snapshot(
    ctx: &IpcContext,
    require_fresh_observation: bool,
) -> Result<daemon_ipc_contracts::SaleStartCapabilitySnapshot, String> {
    let mut state = ctx.ui.status_cache.sale_start_state.lock().await;
    let observation = observe_sale_start_capability(ctx).await;
    let provisional = match observation {
        Ok(observation) => evaluate_sale_start_capability(
            &observation,
            ctx.ui.status_cache.sale_start_generation.clone(),
            std::num::NonZeroU64::new(1).expect("one"),
            crate::state::store::now_iso(),
        ),
        Err(error) => {
            if require_fresh_observation {
                return Err(error);
            }
            let Some(mut stale) = state.last_accepted.clone() else {
                return Err(error);
            };
            stale
                .degradations
                .retain(|reason| reason.code != "CAPABILITY_STALE");
            stale.degradations.push(capability_degradation(
                "CAPABILITY_STALE",
                "sale_start_capability",
                error,
            ));
            apply_fail_closed_cached_facts(ctx, stale).await
        }
    };
    let fingerprint = capability_fingerprint(&provisional);
    let fingerprint_changed = state.fingerprint.as_ref() != Some(&fingerprint);
    if fingerprint_changed {
        state.fingerprint = Some(fingerprint);
    }
    let changed = fingerprint_changed;
    if changed {
        state.revision = state.revision.saturating_add(1).max(1);
    } else if state.revision == 0 {
        state.revision = 1;
    }
    let mut snapshot = provisional;
    snapshot.revision = std::num::NonZeroU64::new(state.revision).expect("revision");
    if !snapshot
        .degradations
        .iter()
        .any(|reason| reason.code == "CAPABILITY_STALE")
    {
        state.last_accepted = Some(snapshot.clone());
    }
    if changed {
        let _ = ctx.events.send(DaemonEvent::SaleStartCapabilityChanged {
            event_id: uuid::Uuid::new_v4().simple().to_string(),
            updated_at: crate::state::store::now_iso(),
            generation: snapshot.generation.to_string(),
            revision: snapshot.revision.get(),
        });
    }
    Ok(snapshot)
}

pub(crate) async fn refresh_sale_start_capability(ctx: &IpcContext) {
    let _ = sale_start_capability_snapshot(ctx, false).await;
}

pub(crate) async fn invalidate_sale_start_capability(ctx: &IpcContext) {
    let _ = sale_start_capability_snapshot(ctx, false).await;
}

fn scanner_payment_readiness(
    scanner: &vending_core::scanner::ScannerHealthSnapshot,
) -> (bool, String) {
    if !scanner.online
        || scanner.adapter != vending_core::scanner::PAYMENT_CODE_SOURCE_SERIAL_TEXT
        || scanner.code != "SCANNER_READY"
    {
        return (
            false,
            PAYMENT_CODE_SCANNER_UNAVAILABLE_CUSTOMER_MESSAGE.to_string(),
        );
    }
    let Ok(updated_at) = chrono::DateTime::parse_from_rfc3339(&scanner.updated_at) else {
        return (
            false,
            PAYMENT_CODE_SCANNER_UNAVAILABLE_CUSTOMER_MESSAGE.to_string(),
        );
    };
    if chrono::Utc::now().signed_duration_since(updated_at.with_timezone(&chrono::Utc))
        > chrono::Duration::seconds(SCANNER_READY_STALE_AFTER_SECONDS)
    {
        return (
            false,
            PAYMENT_CODE_SCANNER_UNAVAILABLE_CUSTOMER_MESSAGE.to_string(),
        );
    }
    (true, scanner.message.clone())
}

pub(crate) fn local_payment_code_submit_guard(
    cache: RuntimeStatusCache,
    state: LocalStateStore,
) -> crate::transaction::PaymentCodeSubmitGuard {
    Arc::new(move |scanner_evidence| {
        let cache = cache.clone();
        let state = state.clone();
        Box::pin(async move {
            let hardware = cache.hardware.read().await.clone();
            if !hardware.online {
                return Err(format!(
                    "MACHINE_NOT_READY_FOR_PAYMENT_CODE: {}",
                    hardware.message
                ));
            }
            if state
                .whole_machine_maintenance_lock()
                .await
                .map_err(|error| error.to_string())?
                .is_some()
            {
                return Err(
                    "MACHINE_NOT_READY_FOR_PAYMENT_CODE: lower controller requires recovery"
                        .to_string(),
                );
            }
            // A completed serial frame carries readiness captured at its final
            // byte. Direct submissions have no such evidence and must use the
            // current cache instead.
            let scanner = match scanner_evidence {
                Some(scanner) => scanner,
                None => cache.scanner.read().await.clone(),
            };
            let (ready, message) = scanner_payment_readiness(&scanner);
            if ready {
                Ok(())
            } else {
                Err(message)
            }
        })
    })
}

async fn payment_options(State(ctx): State<IpcContext>, headers: HeaderMap) -> impl IntoResponse {
    if let Err(error) = require_token(&headers, &ctx.token).await {
        return error.into_response();
    }
    match sale_start_capability_snapshot(&ctx, false).await {
        Ok(capability) => Json(serde_json::json!({
            "options": capability.payment_options.options.into_iter().map(|option| serde_json::json!({
                "optionKey": option.option_key,
                "providerCode": option.provider_code,
                "method": option.method,
                "displayName": option.display_name,
                "description": option.description,
                "icon": option.icon,
                "recommended": option.recommended,
                "disabled": !option.ready,
                "disabledReason": option.disabled_reason,
            })).collect::<Vec<_>>(),
            "defaultOptionKey": capability.payment_options.default_option_key,
            "defaultProviderCode": capability.payment_options.default_provider_code,
            "serverTime": crate::state::store::now_iso(),
        })).into_response(),
        Err(error) => error_response(
            StatusCode::BAD_GATEWAY,
            "payment_options_unavailable",
            error,
        ),
    }
}

async fn create_order(
    State(ctx): State<IpcContext>,
    headers: HeaderMap,
    Json(input): Json<CreateOrder>,
) -> impl IntoResponse {
    if let Err(error) = require_token(&headers, &ctx.token).await {
        return error.into_response();
    }
    let _sale = match ctx
        .sale_binding_gate
        .acquire_sale_start(Duration::from_secs(10))
        .await
    {
        Ok(value) => value,
        Err(_) => {
            return error_response(
                StatusCode::CONFLICT,
                "create_order_hardware_reconfiguring",
                "local hardware binding is changing",
            );
        }
    };
    let profile = match ctx.runtime_sources.require_profile().await {
        Ok(value) => value,
        Err(error) => return error_response(StatusCode::CONFLICT, "machine_not_claimed", error),
    };
    if input.quantity != 1 {
        return error_response(
            StatusCode::BAD_REQUEST,
            "create_order_blocked",
            "quantity must be exactly 1 for lower controller protocol v1",
        );
    }
    // A display read may retain the last accepted snapshot while it updates,
    // but creating an order must observe every authoritative input now.
    let capability = match sale_start_capability_snapshot(&ctx, true).await {
        Ok(value) => value,
        Err(error) => {
            return error_response(
                StatusCode::SERVICE_UNAVAILABLE,
                "create_order_blocked",
                error,
            );
        }
    };
    if !capability.can_start_sale {
        return error_response(
            StatusCode::BAD_REQUEST,
            "create_order_blocked",
            "machine is not ready for sale",
        );
    }
    if !matches!(
        input.payment_method.as_str(),
        "qr_code" | "payment_code" | "mock"
    ) {
        return error_response(
            StatusCode::BAD_REQUEST,
            "create_order_blocked",
            "unsupported payment method",
        );
    }
    if matches!(input.payment_method.as_str(), "qr_code" | "payment_code")
        && input
            .payment_provider_code
            .as_deref()
            .is_none_or(str::is_empty)
    {
        return error_response(
            StatusCode::BAD_REQUEST,
            "create_order_blocked",
            "selected payment provider is required",
        );
    }
    let selected_provider = input
        .payment_provider_code
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let payment_option_ready = capability.payment_options.options.iter().any(|option| {
        option.method == input.payment_method
            && selected_provider.is_none_or(|provider| option.provider_code == provider)
            && option.ready
    });
    if !payment_option_ready {
        return error_response(
            StatusCode::BAD_REQUEST,
            "create_order_blocked",
            "selected payment option is unavailable",
        );
    }
    let sale_view = match ctx
        .state
        .sale_view(Some(profile.profile.machine.code.to_string()))
        .await
    {
        Ok(value) => value,
        Err(error) => {
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "create_order_blocked",
                error.to_string(),
            );
        }
    };
    if sale_view.planogram_version.as_deref() != Some(input.planogram_version.as_str()) {
        return error_response(
            StatusCode::BAD_REQUEST,
            "create_order_blocked",
            "selected planogram is not active",
        );
    }
    let selected = sale_view.items.iter().any(|item| {
        item.inventory_id == input.inventory_id
            && item.slot_id == input.slot_id
            && item.slot_code == input.slot_code
            && item.slot_sales_state == "sale_ready"
            && item.saleable_stock >= 1
    });
    if !selected {
        return error_response(
            StatusCode::BAD_REQUEST,
            "create_order_blocked",
            "selected slot is not saleable",
        );
    }
    let item = serde_json::json!({ "inventoryId": input.inventory_id, "quantity": 1, "planogramVersion": input.planogram_version, "slotId": input.slot_id, "slotCode": input.slot_code });
    match ctx
        .ui
        .transaction
        .create_order_with_idempotency(
            &input.payment_method,
            input
                .payment_provider_code
                .filter(|value| !value.trim().is_empty()),
            item,
            sanitize_profile_snapshot(input.profile_snapshot),
            input.idempotency_key.as_deref(),
        )
        .await
    {
        Ok(value) => transaction_response(value),
        Err(error) => error_response(StatusCode::BAD_GATEWAY, "create_order_failed", error),
    }
}

async fn cancel_order(
    State(ctx): State<IpcContext>,
    headers: HeaderMap,
    Json(input): Json<CancelOrder>,
) -> impl IntoResponse {
    if let Err(error) = require_token(&headers, &ctx.token).await {
        return error.into_response();
    }
    match ctx.ui.transaction.cancel_order(input.order_no.trim()).await {
        Ok(value) => transaction_response(value),
        Err(error) => error_response(StatusCode::BAD_GATEWAY, "cancel_order_failed", error),
    }
}

async fn current_transaction(
    State(ctx): State<IpcContext>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if let Err(error) = require_token(&headers, &ctx.token).await {
        return error.into_response();
    }
    match ctx.ui.transaction.restore_current().await {
        Ok(Some(value)) => transaction_response(value),
        Ok(None) => transaction_response(empty_transaction()),
        Err(error) => error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "transaction_read_failed",
            error,
        ),
    }
}

fn empty_transaction() -> vending_core::domain::InternalCurrentTransactionSnapshot {
    vending_core::domain::InternalCurrentTransactionSnapshot {
        order_id: None,
        order_no: None,
        product_summary: None,
        payment_id: None,
        payment_no: None,
        payment_method: None,
        payment_provider: None,
        payment_url: None,
        payment_status: None,
        order_status: None,
        total_amount_cents: None,
        vending: None,
        next_action: None,
        masked_auth_code: None,
        payment_code_attempt: None,
        expires_at: None,
        error_code: None,
        error_message: None,
        operator_hint: None,
        updated_at: crate::state::store::now_iso(),
    }
}

fn transaction_response(
    snapshot: vending_core::domain::InternalCurrentTransactionSnapshot,
) -> axum::response::Response {
    let mut value = match serde_json::to_value(snapshot) {
        Ok(value) => value,
        Err(error) => {
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "transaction_contract_invalid",
                error.to_string(),
            );
        }
    };
    if let Some(status) = value.pointer_mut("/vending/status") {
        if matches!(status.as_str(), Some("received")) {
            *status = serde_json::Value::String("pending".to_string());
        }
    }
    match serde_json::from_value::<daemon_ipc_contracts::CurrentTransactionSnapshot>(value) {
        Ok(value) => Json(value).into_response(),
        Err(error) => error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "transaction_contract_invalid",
            error.to_string(),
        ),
    }
}

fn sanitize_profile_snapshot(value: Option<serde_json::Value>) -> Option<serde_json::Value> {
    value.and_then(|value| value.as_object().map(|object| serde_json::json!({ "personPresent": object.get("personPresent").and_then(|value| value.as_bool()).unwrap_or(false) })))
}

async fn apply_planogram(
    State(ctx): State<IpcContext>,
    headers: HeaderMap,
    Json(input): Json<MachinePlanogramInput>,
) -> impl IntoResponse {
    if let Err(error) = require_token(&headers, &ctx.token).await {
        return error.into_response();
    }
    let topology = match ctx.runtime_sources.hardware_topology_readiness().await {
        Ok(value) => value,
        Err(error) => {
            return error_response(StatusCode::CONFLICT, "hardware_topology_unavailable", error);
        }
    };
    if !topology.ready {
        return error_response(
            StatusCode::CONFLICT,
            "hardware_topology_mismatch",
            topology.message,
        );
    }
    match ctx.state.apply_planogram(input).await {
        Ok(value) => {
            invalidate_sale_start_capability(&ctx).await;
            Json(value).into_response()
        }
        Err(error) => error_response(
            StatusCode::BAD_REQUEST,
            "planogram_apply_failed",
            error.to_string(),
        ),
    }
}

async fn stock_maintenance_task(
    State(ctx): State<IpcContext>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if let Err(error) = require_token(&headers, &ctx.token).await {
        return error.into_response();
    }
    match ctx.state.stock_maintenance_task().await {
        Ok(value) => Json(value).into_response(),
        Err(error) => error_response(
            StatusCode::BAD_REQUEST,
            "stock_maintenance_task_unavailable",
            error.to_string(),
        ),
    }
}

async fn stock_maintenance_task_projection(
    State(ctx): State<IpcContext>,
    headers: HeaderMap,
    AxumPath(task_id): AxumPath<String>,
) -> impl IntoResponse {
    if let Err(error) = require_token(&headers, &ctx.token).await {
        return error.into_response();
    }
    match ctx.state.stock_maintenance_task_projection(&task_id).await {
        Ok(value) => Json(value).into_response(),
        Err(error) => error_response(
            StatusCode::NOT_FOUND,
            "stock_maintenance_task_projection_unavailable",
            error.to_string(),
        ),
    }
}

async fn submit_stock_maintenance_batch(
    State(ctx): State<IpcContext>,
    headers: HeaderMap,
    Json(input): Json<StockMaintenanceBatchInput>,
) -> impl IntoResponse {
    if let Err(error) = require_token(&headers, &ctx.token).await {
        return error.into_response();
    }
    let profile = match ctx.runtime_sources.require_profile().await {
        Ok(value) => value,
        Err(error) => return error_response(StatusCode::CONFLICT, "machine_not_claimed", error),
    };
    match ctx
        .state
        .submit_stock_maintenance_batch(
            input,
            "local_operations",
            &profile.profile.machine.code.to_string(),
            &profile.profile.api_base_url,
        )
        .await
    {
        Ok(value) => {
            invalidate_sale_start_capability(&ctx).await;
            (StatusCode::CREATED, Json(value)).into_response()
        }
        Err(error) => error_response(
            StatusCode::BAD_REQUEST,
            "stock_maintenance_batch_failed",
            error.to_string(),
        ),
    }
}

async fn record_physical_stock_attestation(
    State(ctx): State<IpcContext>,
    headers: HeaderMap,
    Json(input): Json<PhysicalStockAttestationInput>,
) -> impl IntoResponse {
    if let Err(error) = require_token(&headers, &ctx.token).await {
        return error.into_response();
    }
    let profile = match ctx.runtime_sources.require_profile().await {
        Ok(value) => value,
        Err(error) => return error_response(StatusCode::CONFLICT, "machine_not_claimed", error),
    };
    match ctx
        .state
        .record_physical_stock_attestation_with_upload(
            input,
            Some(&profile.profile.machine.code.to_string()),
            Some(&profile.profile.api_base_url),
        )
        .await
    {
        Ok(value) => {
            invalidate_sale_start_capability(&ctx).await;
            (StatusCode::CREATED, Json(value)).into_response()
        }
        Err(error) => error_response(
            StatusCode::BAD_REQUEST,
            "physical_stock_attestation_failed",
            error.to_string(),
        ),
    }
}

async fn hardware_self_check(
    State(ctx): State<IpcContext>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if let Err(error) = require_token(&headers, &ctx.token).await {
        return error.into_response();
    }
    let status = ctx.hardware.self_check().await;
    *ctx.ui.status_cache.hardware.write().await = status.clone();
    if status.online {
        let production_dispense_path_ready = status.adapter == "serial"
            && status
                .port_path
                .as_deref()
                .is_some_and(|path| !path.trim_start().starts_with("tcp://"));
        let evidence = crate::state::store::WholeMachineMaintenanceLockClearEvidence {
            adapter: status.adapter.clone(),
            online: status.online,
            message: status.message.clone(),
            port_path: status.port_path.clone(),
            checked_at: crate::state::store::now_iso(),
            production_dispense_path_ready,
            production_dispense_path_code: if production_dispense_path_ready {
                "PRODUCTION_DISPENSE_PATH_READY".to_string()
            } else {
                "PRODUCTION_DISPENSE_PATH_REQUIRED".to_string()
            },
            production_dispense_path_message: if production_dispense_path_ready {
                "lower-controller self-check confirmed a production serial path".to_string()
            } else {
                "lower-controller self-check did not confirm a production serial path".to_string()
            },
        };
        if let Err(error) = ctx
            .state
            .record_whole_machine_lock_recovery_evidence(&evidence)
            .await
        {
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "whole_machine_lock_evidence_write_failed",
                error.to_string(),
            );
        }
    }
    invalidate_sale_start_capability(&ctx).await;
    Json(status).into_response()
}

async fn clear_whole_machine_maintenance_lock(
    State(ctx): State<IpcContext>,
    headers: HeaderMap,
    Json(input): Json<ClearWholeMachineMaintenanceLockRequest>,
) -> impl IntoResponse {
    if let Err(error) = require_token(&headers, &ctx.token).await {
        return error.into_response();
    }
    let operator_note = input.operator_note.trim();
    if operator_note.is_empty() {
        return error_response(
            StatusCode::BAD_REQUEST,
            "operator_note_required",
            "operator note is required to clear whole-machine lock",
        );
    }
    let previous = match ctx.state.whole_machine_maintenance_lock().await {
        Ok(value) => value,
        Err(error) => {
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "whole_machine_lock_read_failed",
                error.to_string(),
            );
        }
    };
    let Some(previous_lock) = previous else {
        return Json(serde_json::json!({ "cleared": false })).into_response();
    };
    let evidence = match ctx.state.whole_machine_lock_recovery_evidence().await {
        Ok(Some(value)) => value,
        Ok(None) => {
            return error_response(
                StatusCode::CONFLICT,
                "self_check_evidence_required",
                "run lower-controller self-check before clearing whole-machine lock",
            );
        }
        Err(error) => {
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "whole_machine_lock_evidence_read_failed",
                error.to_string(),
            );
        }
    };
    if !evidence.online
        || evidence.checked_at < previous_lock.created_at
        || !evidence.production_dispense_path_ready
        || evidence.adapter == "mock"
        || evidence
            .port_path
            .as_deref()
            .is_some_and(|path| path.trim_start().starts_with("tcp://"))
    {
        return error_response(
            StatusCode::CONFLICT,
            "production_dispense_path_required",
            "fresh production lower-controller recovery evidence is required",
        );
    }
    let audit = crate::state::store::WholeMachineMaintenanceLockClearAudit {
        id: uuid::Uuid::new_v4().to_string(),
        operator_note: operator_note.to_string(),
        cleared_at: crate::state::store::now_iso(),
        previous: previous_lock.clone(),
        recovery_evidence: evidence,
    };
    if let Err(error) = ctx
        .state
        .clear_whole_machine_maintenance_lock_with_audit(&audit)
        .await
    {
        return error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "whole_machine_lock_clear_failed",
            error.to_string(),
        );
    }
    invalidate_sale_start_capability(&ctx).await;
    Json(serde_json::json!({ "cleared": true, "previous": previous_lock })).into_response()
}

async fn payment_environment_diagnostic(
    State(ctx): State<IpcContext>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if let Err(error) = require_token(&headers, &ctx.token).await {
        return error.into_response();
    }
    match ctx.ui.backend.get_payment_environment_diagnostic().await {
        Ok(value) if value.is_object() => Json(value).into_response(),
        Ok(_) => error_response(
            StatusCode::BAD_GATEWAY,
            "payment_environment_diagnostic_invalid",
            "payment provider environment diagnostic is invalid",
        ),
        Err(error) => error_response(
            StatusCode::BAD_GATEWAY,
            "payment_environment_diagnostic_failed",
            error,
        ),
    }
}

async fn manual_dispense_diagnostic(
    State(ctx): State<IpcContext>,
    headers: HeaderMap,
    Json(request): Json<ManualDispenseDiagnosticRequest>,
) -> impl IntoResponse {
    if let Err(error) = require_token(&headers, &ctx.token).await {
        return error.into_response();
    }
    let key = request.idempotency_key.trim();
    if key.is_empty()
        || key.len() > 96
        || !key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        || request.slot_code.trim().is_empty()
        || request.slot_code.len() > 32
        || request.quantity != 1
        || !(1..=120).contains(&request.timeout_seconds)
    {
        return error_response(
            StatusCode::BAD_REQUEST,
            "invalid_manual_dispense_diagnostic_request",
            "bounded idempotencyKey, slotCode, quantity=1 and timeoutSeconds 1..120 are required",
        );
    }
    let slot = match ctx
        .state
        .active_planogram_slot_by_code(request.slot_code.trim())
        .await
    {
        Ok(Some(slot)) if slot.layer_no <= 255 && slot.cell_no <= 255 => slot,
        Ok(Some(_)) => {
            return error_response(
                StatusCode::CONFLICT,
                "manual_dispense_slot_out_of_protocol_range",
                "the selected active slot is outside the lower-controller protocol range",
            );
        }
        Ok(None) => {
            return error_response(
                StatusCode::CONFLICT,
                "manual_dispense_slot_not_active",
                "the selected slot is not present in the active planogram",
            );
        }
        Err(error) => {
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "manual_dispense_slot_lookup_failed",
                error.to_string(),
            );
        }
    };
    let _lease = match ctx
        .sale_binding_gate
        .acquire_manual_dispense(Duration::from_secs(10))
        .await
    {
        Ok(value) => value,
        Err(_) => {
            return error_response(
                StatusCode::CONFLICT,
                "manual_dispense_controller_busy",
                "sale or hardware reconfiguration is active",
            );
        }
    };
    match ctx.state.current_transaction_snapshot().await {
        Ok(Some(value)) if crate::transaction::is_active_transaction(&value) => {
            return error_response(
                StatusCode::CONFLICT,
                "manual_dispense_active_sale",
                "manual dispense is unavailable during an active sale",
            );
        }
        Err(error) => {
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "manual_dispense_sale_state_unavailable",
                error.to_string(),
            );
        }
        _ => {}
    }
    let (binding, binding_revision) = match ctx
        .runtime_sources
        .local_device_binding_snapshot(LocalDeviceRole::LowerController)
        .await
    {
        Ok(value) => value,
        Err(error) => {
            return error_response(
                StatusCode::SERVICE_UNAVAILABLE,
                "manual_dispense_binding_unavailable",
                error,
            );
        }
    };
    let Some(binding) = binding else {
        return error_response(
            StatusCode::CONFLICT,
            "manual_dispense_controller_unbound",
            "stable lower-controller binding is required",
        );
    };
    let observed = match ctx.serial_device_platform.discover().await {
        Ok(value) => value,
        Err(error) => {
            return error_response(
                StatusCode::SERVICE_UNAVAILABLE,
                "manual_dispense_controller_discovery_unavailable",
                error,
            );
        }
    };
    let resolved_port = match device_binding::resolve_bound_port(&binding.identity, &observed) {
        device_binding::BindingResolution::Resolved(value) => value,
        device_binding::BindingResolution::Missing => {
            return error_response(
                StatusCode::CONFLICT,
                "manual_dispense_controller_binding_missing",
                "the bound lower controller is not currently attached",
            );
        }
        device_binding::BindingResolution::Ambiguous(_) => {
            return error_response(
                StatusCode::CONFLICT,
                "manual_dispense_controller_binding_ambiguous",
                "the bound lower controller does not resolve to one current port",
            );
        }
    };
    let controller = ctx.hardware.self_check().await;
    if !controller.online
        || controller.adapter == "mock"
        || controller.port_path.as_deref() != Some(resolved_port.as_str())
    {
        return error_response(
            StatusCode::CONFLICT,
            "manual_dispense_controller_unresolved",
            "manual dispense requires the online production runtime to match the bound controller",
        );
    }
    let diagnostic_id = format!("manual-dispense-{}", uuid::Uuid::new_v4().simple());
    let command = vending_core::hardware::DispenseCommandPayload {
        command_no: diagnostic_id.clone(),
        order_no: "MANUAL-DIAGNOSTIC".to_string(),
        slot: vending_core::hardware::SlotPayload {
            layer_no: slot.layer_no,
            cell_no: slot.cell_no,
            slot_code: slot.slot_code.clone(),
        },
        quantity: request.quantity,
        timeout_seconds: request.timeout_seconds,
    };
    let pending = crate::state::store::ManualDispenseDiagnostic {
        diagnostic_id: diagnostic_id.clone(),
        idempotency_key: key.to_string(),
        request_fingerprint: crate::state::store::manual_dispense_request_fingerprint(
            &slot.slot_code,
            u64::from(slot.layer_no),
            u64::from(slot.cell_no),
            u64::from(request.quantity),
            request.timeout_seconds,
        ),
        status: "pending".to_string(),
        operator_id: "local_operations".to_string(),
        session_correlation_id: diagnostic_id.clone(),
        controller: serde_json::json!({
            "stableIdentity": binding.identity,
            "adapter": controller.adapter,
            "portPath": controller.port_path,
            "bindingRevision": binding_revision,
        }),
        command: serde_json::to_value(&command).unwrap_or_default(),
        started_at: crate::state::store::now_iso(),
        completed_at: None,
        raw_result: None,
        normalized_result: None,
        reconciliation_status: "open".to_string(),
        expires_at: (chrono::Utc::now() + chrono::Duration::days(90)).to_rfc3339(),
    };
    match ctx.state.reserve_manual_dispense_diagnostic(&pending).await {
        Ok(crate::state::store::ManualDispenseReservation::Existing(existing)) => {
            let existing = if existing.status == "pending" {
                match ctx
                    .state
                    .mark_pending_manual_dispense_result_unknown(&existing.diagnostic_id)
                    .await
                {
                    Ok(value) => value,
                    Err(error) => {
                        return error_response(
                            StatusCode::INTERNAL_SERVER_ERROR,
                            "manual_dispense_unknown_evidence_write_failed",
                            error.to_string(),
                        );
                    }
                }
            } else {
                existing
            };
            return Json(serde_json::json!({
                "diagnosticId": existing.diagnostic_id,
                "outcome": existing.status,
                "stockReconciliationRequired": true,
                "reconciliationStatus": existing.reconciliation_status,
                "replayed": true,
            }))
            .into_response();
        }
        Ok(crate::state::store::ManualDispenseReservation::Reserved(_)) => {}
        Err(error) => {
            return error_response(
                StatusCode::CONFLICT,
                "manual_dispense_pending_evidence_write_failed",
                error.to_string(),
            );
        }
    }
    let result = match tokio::time::timeout(
        Duration::from_secs(request.timeout_seconds.saturating_add(10)),
        ctx.hardware.dispense(command.clone()),
    )
    .await
    {
        Ok(value) => value,
        Err(_) => vending_core::hardware::DispenseResultPayload {
            command_no: command.command_no,
            success: false,
            error_code: Some("RESULT_UNKNOWN".to_string()),
            message: "manual dispense result unknown after local timeout".to_string(),
            reported_at: crate::state::store::now_iso(),
            lower_controller_fault: None,
        },
    };
    let outcome = if result.success {
        "completed"
    } else if result.error_code.as_deref() == Some("RESULT_UNKNOWN") {
        "result_unknown"
    } else {
        "failed"
    };
    let normalized = serde_json::json!({
        "outcome": outcome,
        "errorCode": result.error_code,
        "reportedAt": result.reported_at,
    });
    let record = match ctx
        .state
        .finish_manual_dispense_diagnostic(
            &diagnostic_id,
            outcome,
            serde_json::to_value(&result).unwrap_or_default(),
            normalized.clone(),
        )
        .await
    {
        Ok(value) => value,
        Err(error) => {
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "manual_dispense_terminal_evidence_write_failed",
                error.to_string(),
            );
        }
    };
    Json(serde_json::json!({
        "diagnosticId": record.diagnostic_id,
        "outcome": outcome,
        "errorCode": normalized["errorCode"],
        "reportedAt": normalized["reportedAt"],
        "stockReconciliationRequired": true,
        "reconciliationStatus": "open",
        "replayed": false,
    }))
    .into_response()
}

async fn device_binding_snapshot(
    State(ctx): State<IpcContext>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if let Err(error) = require_token(&headers, &ctx.token).await {
        return error.into_response();
    }
    let observed = ctx
        .serial_device_platform
        .discover()
        .await
        .unwrap_or_default();
    let settings = match ctx.runtime_sources.load_local_runtime_settings().await {
        Ok(value) => value,
        Err(error) => {
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "local_settings_read_failed",
                error,
            );
        }
    };
    let hardware = ctx.ui.status_cache.hardware.read().await.clone();
    let scanner = ctx.ui.status_cache.scanner.read().await.clone();
    let lower = device_binding::project_role_binding(
        LocalDeviceRole::LowerController,
        settings.lower_controller_binding,
        hardware.port_path.clone(),
        &observed,
        Some(DeviceRoleRuntimeReadiness {
            online: hardware.online,
            current_port: hardware.port_path,
            code: if hardware.online {
                "HARDWARE_READY".to_string()
            } else {
                "LOWER_CONTROLLER_UNAVAILABLE".to_string()
            },
            message: hardware.message,
        }),
    );
    let scan = device_binding::project_role_binding(
        LocalDeviceRole::Scanner,
        settings.scanner_binding,
        scanner.port.clone(),
        &observed,
        Some(DeviceRoleRuntimeReadiness {
            online: scanner.online,
            current_port: scanner.port,
            code: scanner.code,
            message: scanner.message,
        }),
    );
    match serde_json::from_value::<daemon_ipc_contracts::DeviceBindingSnapshot>(
        serde_json::json!({ "roles": [lower, scan] }),
    ) {
        Ok(snapshot) => Json(snapshot).into_response(),
        Err(error) => error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "device_binding_contract_invalid",
            error.to_string(),
        ),
    }
}

fn parse_role(value: &str) -> Option<LocalDeviceRole> {
    match value {
        "lower_controller" => Some(LocalDeviceRole::LowerController),
        "scanner" => Some(LocalDeviceRole::Scanner),
        _ => None,
    }
}

async fn test_binding(
    State(ctx): State<IpcContext>,
    AxumPath(role): AxumPath<String>,
    headers: HeaderMap,
    Json(input): Json<DeviceBindingTestRequest>,
) -> impl IntoResponse {
    if let Err(error) = require_token(&headers, &ctx.token).await {
        return error.into_response();
    }
    let Some(role) = parse_role(&role) else {
        return error_response(
            StatusCode::NOT_FOUND,
            "device_binding_role_unknown",
            "unknown local hardware role",
        );
    };
    let observed = match ctx.serial_device_platform.discover().await {
        Ok(value) => value,
        Err(error) => {
            return error_response(
                StatusCode::SERVICE_UNAVAILABLE,
                "device_discovery_failed",
                error,
            );
        }
    };
    let candidate =
        match device_binding::select_observed_candidate_by_identity(&observed, &input.identity_key)
        {
            device_binding::ObservedCandidateSelection::Selected(candidate) => candidate,
            device_binding::ObservedCandidateSelection::Missing => {
                return error_response(
                    StatusCode::NOT_FOUND,
                    "device_binding_candidate_missing",
                    "stable USB device identity is not currently observed",
                );
            }
            device_binding::ObservedCandidateSelection::Ambiguous(_) => {
                return error_response(
                    StatusCode::CONFLICT,
                    "device_binding_candidate_ambiguous",
                    "stable USB device identity has duplicate current observations",
                );
            }
        };
    let settings = match ctx.runtime_sources.load_local_runtime_settings().await {
        Ok(value) => value,
        Err(error) => {
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "local_settings_read_failed",
                error,
            );
        }
    };
    let bootstrap = match ctx
        .runtime_sources
        .clean_runtime_configuration()
        .load_bootstrap()
        .await
    {
        Ok(value) => value,
        Err(error) => {
            return error_response(StatusCode::CONFLICT, "runtime_bootstrap_invalid", error);
        }
    };
    let scanner_protocol = match effective_scanner_protocol(
        &settings,
        bootstrap.hardware_model.as_str(),
        bootstrap.topology.identity.as_str(),
    ) {
        Ok(protocol) => protocol,
        Err(error) => {
            return error_response(
                StatusCode::CONFLICT,
                "hardware_model_unsupported",
                format!("{}: {error}", error.code()),
            );
        }
    };
    let result = ctx
        .serial_device_platform
        .test_candidate(
            role,
            candidate,
            &device_binding::SerialDeviceRoleProbeConfig::from(&scanner_protocol),
        )
        .await;
    if !result.success {
        return error_response(
            StatusCode::UNPROCESSABLE_ENTITY,
            "device_binding_test_failed",
            result.message,
        );
    }
    let (_, config_revision) = match ctx
        .runtime_sources
        .local_device_binding_snapshot(role)
        .await
    {
        Ok(value) => value,
        Err(error) => {
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "local_settings_read_failed",
                error,
            );
        }
    };
    let observation_revision = observation_revision(&observed);
    let (token, expires_at) = ctx
        .device_binding_test_evidence
        .issue(
            role,
            input.identity_key,
            observation_revision.clone(),
            config_revision.clone(),
        )
        .await;
    Json(DeviceBindingTestResponse {
        result,
        test_evidence_token: token,
        test_evidence_expires_at: expires_at,
        observation_revision,
        config_revision,
    })
    .into_response()
}

async fn confirm_runtime_binding(
    State(ctx): State<IpcContext>,
    AxumPath(role): AxumPath<String>,
    headers: HeaderMap,
    Json(input): Json<daemon_ipc_contracts::ConfirmHardwareBindingRequest>,
) -> impl IntoResponse {
    if let Err(error) = require_token(&headers, &ctx.token).await {
        return error.into_response();
    }
    let Some(role) = parse_role(&role) else {
        return error_response(
            StatusCode::NOT_FOUND,
            "device_binding_role_unknown",
            "unknown local hardware role",
        );
    };
    let _lease = match ctx.sale_binding_gate.try_acquire_reconfigure() {
        Ok(value) => value,
        Err(_) => {
            return error_response(
                StatusCode::CONFLICT,
                "device_binding_sale_start_in_progress",
                "a sale is starting",
            );
        }
    };
    if let Err(safety) = require_binding_mutation_safe(&ctx).await {
        return binding_mutation_safety_response(safety);
    }
    let observed = match ctx.serial_device_platform.discover().await {
        Ok(value) => value,
        Err(error) => {
            return error_response(
                StatusCode::SERVICE_UNAVAILABLE,
                "device_discovery_failed",
                error,
            );
        }
    };
    let observation_revision = observation_revision(&observed);
    let candidate = match device_binding::select_observed_candidate_by_identity(
        &observed,
        &input.identity_key.to_string(),
    ) {
        device_binding::ObservedCandidateSelection::Selected(candidate) => candidate,
        device_binding::ObservedCandidateSelection::Missing => {
            return error_response(
                StatusCode::NOT_FOUND,
                "device_binding_candidate_missing",
                "stable USB device identity is not currently observed",
            );
        }
        device_binding::ObservedCandidateSelection::Ambiguous(_) => {
            return error_response(
                StatusCode::CONFLICT,
                "device_binding_candidate_ambiguous",
                "stable USB device identity has duplicate current observations",
            );
        }
    };
    let (previous, revision) = match ctx
        .runtime_sources
        .local_device_binding_snapshot(role)
        .await
    {
        Ok(value) => value,
        Err(error) => {
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "local_settings_read_failed",
                error,
            );
        }
    };
    let token = input.test_evidence_token.to_string();
    if let Err(error) = ctx
        .device_binding_test_evidence
        .consume(
            &token,
            role,
            &input.identity_key.to_string(),
            &observation_revision,
            &revision,
        )
        .await
    {
        return error_response(
            StatusCode::CONFLICT,
            "device_binding_test_evidence_invalid",
            error,
        );
    }
    let identity = match device_binding::StableSerialDeviceIdentity::try_from_observation(candidate)
    {
        Ok(value) => value,
        Err(error) => {
            return error_response(StatusCode::BAD_REQUEST, "device_identity_invalid", error);
        }
    };
    let binding = LocalSerialRoleBinding {
        identity,
        confirmed_at: crate::state::store::now_iso(),
        confirmed_by: "local_operator".to_string(),
        test_evidence_code: "DEVICE_TEST_PASSED".to_string(),
    };
    let new_revision = match ctx
        .runtime_sources
        .save_local_device_binding_if_revision(role, binding.clone(), &revision)
        .await
    {
        Ok(value) => value,
        Err(error) => {
            return error_response(
                StatusCode::CONFLICT,
                "device_binding_persist_conflict",
                error,
            );
        }
    };
    let activation = activate_binding(&ctx, role, &binding, candidate.current_port.clone()).await;
    if let Err(error) = activation {
        let _ = ctx
            .runtime_sources
            .restore_local_device_binding_if_revision(role, previous, &new_revision)
            .await;
        return error_response(
            StatusCode::UNPROCESSABLE_ENTITY,
            "device_binding_activation_failed",
            error,
        );
    }
    invalidate_sale_start_capability(&ctx).await;
    match serde_json::from_value::<daemon_ipc_contracts::DeviceBindingActivation>(
        serde_json::json!({
            "binding": binding,
            "currentPort": candidate.current_port,
            "ready": true,
            "code": "DEVICE_BINDING_ACTIVATED",
            "message": format!("{} binding activated", role.as_str()),
            "unrelatedRuntimeRestarted": false,
        }),
    ) {
        Ok(activation) => Json(activation).into_response(),
        Err(error) => error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "device_binding_activation_contract_invalid",
            error.to_string(),
        ),
    }
}

async fn activate_binding(
    ctx: &IpcContext,
    role: LocalDeviceRole,
    binding: &LocalSerialRoleBinding,
    port: String,
) -> Result<(), String> {
    match role {
        LocalDeviceRole::LowerController => {
            let status = ctx
                .hardware
                .reconfigure_from_serial_port(
                    Some(port),
                    Some(ctx.data_dir.join("logs").join("serial-protocol.jsonl")),
                )
                .await?;
            *ctx.ui.status_cache.hardware.write().await = status;
        }
        LocalDeviceRole::Scanner => {
            let settings = ctx.runtime_sources.load_local_runtime_settings().await?;
            let bootstrap = ctx
                .runtime_sources
                .clean_runtime_configuration()
                .load_bootstrap()
                .await?;
            ctx.scanner_runtime
                .reconfigure(scanner_config(
                    &settings,
                    bootstrap.hardware_model.as_str(),
                    bootstrap.topology.identity.as_str(),
                    Some(port),
                )?)
                .await?;
        }
    }
    let _ = binding;
    Ok(())
}

async fn clear_runtime_binding(
    State(ctx): State<IpcContext>,
    AxumPath(role): AxumPath<String>,
    headers: HeaderMap,
    Json(_input): Json<daemon_ipc_contracts::ClearHardwareBindingRequest>,
) -> impl IntoResponse {
    if let Err(error) = require_token(&headers, &ctx.token).await {
        return error.into_response();
    }
    let Some(role) = parse_role(&role) else {
        return error_response(
            StatusCode::NOT_FOUND,
            "device_binding_role_unknown",
            "unknown local hardware role",
        );
    };
    let _lease = match ctx.sale_binding_gate.try_acquire_reconfigure() {
        Ok(value) => value,
        Err(_) => {
            return error_response(
                StatusCode::CONFLICT,
                "device_binding_sale_start_in_progress",
                "a sale is starting",
            );
        }
    };
    if let Err(safety) = require_binding_mutation_safe(&ctx).await {
        return binding_mutation_safety_response(safety);
    }
    let (_previous, revision) = match ctx
        .runtime_sources
        .local_device_binding_snapshot(role)
        .await
    {
        Ok(value) => value,
        Err(error) => {
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "local_settings_read_failed",
                error,
            );
        }
    };
    if role == LocalDeviceRole::Scanner {
        *ctx.ui.status_cache.scanner.write().await = scanner_health(
            "SCANNER_BINDING_CLEARING",
            "scanner binding is being cleared",
        );
        invalidate_sale_start_capability(&ctx).await;
        if let Err(error) = ctx.scanner_runtime.stop().await {
            *ctx.ui.status_cache.scanner.write().await = scanner_health(
                "SCANNER_STOP_FAILED",
                &format!("scanner binding was not cleared because stop failed: {error}"),
            );
            invalidate_sale_start_capability(&ctx).await;
            return error_response(
                StatusCode::SERVICE_UNAVAILABLE,
                "scanner_binding_stop_failed",
                error,
            );
        }
    }
    if let Err(error) = ctx
        .runtime_sources
        .restore_local_device_binding_if_revision(role, None, &revision)
        .await
    {
        if role == LocalDeviceRole::Scanner {
            *ctx.ui.status_cache.scanner.write().await = scanner_health(
                "SCANNER_BINDING_CLEAR_PERSIST_FAILED",
                "scanner binding remains configured but its runtime is stopped",
            );
            invalidate_sale_start_capability(&ctx).await;
        }
        return error_response(
            StatusCode::CONFLICT,
            "device_binding_persist_conflict",
            error,
        );
    }
    match role {
        LocalDeviceRole::LowerController => {
            let _ = ctx
                .hardware
                .deactivate_bound_adapter("lower controller binding was cleared");
            *ctx.ui.status_cache.hardware.write().await = ctx.hardware.self_check().await;
        }
        LocalDeviceRole::Scanner => {
            *ctx.ui.status_cache.scanner.write().await =
                scanner_health("SCANNER_BINDING_CLEARED", "scanner binding cleared");
        }
    }
    invalidate_sale_start_capability(&ctx).await;
    runtime_configuration(State(ctx), headers)
        .await
        .into_response()
}

async fn set_scanner_protocol(
    State(ctx): State<IpcContext>,
    headers: HeaderMap,
    Json(request): Json<daemon_ipc_contracts::SetScannerProtocolParametersRequest>,
) -> impl IntoResponse {
    if let Err(error) = require_token(&headers, &ctx.token).await {
        return error.into_response();
    }
    let protocol = match request {
        Some(request) => {
            let baud_rate = match u32::try_from(request.baud_rate) {
                Ok(value) => value,
                Err(_) => {
                    return error_response(
                        StatusCode::BAD_REQUEST,
                        "scanner_protocol_parameters_invalid",
                        "scanner baud rate is outside the supported range",
                    );
                }
            };
            let frame_suffix = match request.frame_suffix {
                daemon_ipc_contracts::ScannerProtocolFrameSuffix::Crlf => {
                    vending_core::scanner::ScannerFrameSuffix::Crlf
                }
                daemon_ipc_contracts::ScannerProtocolFrameSuffix::Lf => {
                    vending_core::scanner::ScannerFrameSuffix::Lf
                }
                daemon_ipc_contracts::ScannerProtocolFrameSuffix::Cr => {
                    vending_core::scanner::ScannerFrameSuffix::Cr
                }
                daemon_ipc_contracts::ScannerProtocolFrameSuffix::None => {
                    vending_core::scanner::ScannerFrameSuffix::None
                }
            };
            Some(ScannerProtocolParameters {
                baud_rate,
                frame_suffix,
            })
        }
        None => None,
    };
    let previous = match ctx.runtime_sources.load_local_runtime_settings().await {
        Ok(value) => value.scanner_protocol,
        Err(error) => {
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "local_settings_read_failed",
                error,
            );
        }
    };
    if let Err(error) = ctx
        .runtime_sources
        .set_local_scanner_protocol(protocol)
        .await
    {
        return error_response(
            StatusCode::BAD_REQUEST,
            "scanner_protocol_parameters_invalid",
            error,
        );
    }
    let settings = match ctx.runtime_sources.load_local_runtime_settings().await {
        Ok(value) => value,
        Err(error) => {
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "local_settings_read_failed",
                error,
            );
        }
    };
    let bootstrap = match ctx
        .runtime_sources
        .clean_runtime_configuration()
        .load_bootstrap()
        .await
    {
        Ok(value) => value,
        Err(error) => {
            return error_response(StatusCode::CONFLICT, "runtime_bootstrap_invalid", error);
        }
    };
    let observed = ctx
        .serial_device_platform
        .discover()
        .await
        .unwrap_or_default();
    if let Some(binding) = settings.scanner_binding.as_ref() {
        if let Ok(port) =
            device_binding::resolve_runtime_port(LocalDeviceRole::Scanner, binding, &observed)
        {
            let config = match scanner_config(
                &settings,
                bootstrap.hardware_model.as_str(),
                bootstrap.topology.identity.as_str(),
                Some(port),
            ) {
                Ok(config) => config,
                Err(error) => {
                    let _ = ctx
                        .runtime_sources
                        .set_local_scanner_protocol(previous)
                        .await;
                    return error_response(
                        StatusCode::CONFLICT,
                        "hardware_model_unsupported",
                        error,
                    );
                }
            };
            if let Err(error) = ctx.scanner_runtime.reconfigure(config).await {
                let _ = ctx
                    .runtime_sources
                    .set_local_scanner_protocol(previous)
                    .await;
                return error_response(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "scanner_protocol_activation_failed",
                    error,
                );
            }
        }
    }
    invalidate_sale_start_capability(&ctx).await;
    runtime_configuration(State(ctx), headers)
        .await
        .into_response()
}

async fn set_audio_preferences(
    State(ctx): State<IpcContext>,
    headers: HeaderMap,
    Json(request): Json<daemon_ipc_contracts::SetAudioPreferencesRequest>,
) -> impl IntoResponse {
    if let Err(error) = require_token(&headers, &ctx.token).await {
        return error.into_response();
    }
    let value = AudioPreferences {
        volume: request.volume,
        cues_enabled: request.cues_enabled,
        presence_cues_enabled: request.presence_cues_enabled,
        transaction_cues_enabled: request.transaction_cues_enabled,
    };
    if let Err(error) = ctx.runtime_sources.set_local_audio_preferences(value).await {
        return error_response(StatusCode::BAD_REQUEST, "audio_preferences_invalid", error);
    }
    invalidate_sale_start_capability(&ctx).await;
    runtime_configuration(State(ctx), headers)
        .await
        .into_response()
}

async fn sync_status(State(ctx): State<IpcContext>, headers: HeaderMap) -> impl IntoResponse {
    if let Err(error) = require_token(&headers, &ctx.token).await {
        return error.into_response();
    }
    Json(ctx.ui.status_cache.sync.read().await.clone()).into_response()
}
async fn scanner_status(State(ctx): State<IpcContext>, headers: HeaderMap) -> impl IntoResponse {
    if let Err(error) = require_token(&headers, &ctx.token).await {
        return error.into_response();
    }
    let snapshot = ctx.ui.status_cache.scanner.read().await.clone();
    Json(scanner_runtime_status_contract(&snapshot)).into_response()
}
async fn vision_status(State(ctx): State<IpcContext>, headers: HeaderMap) -> impl IntoResponse {
    if let Err(error) = require_token(&headers, &ctx.token).await {
        return error.into_response();
    }
    Json(ctx.ui.status_cache.vision.read().await.clone()).into_response()
}

fn parse_vision_camera_role(
    value: &str,
) -> Option<crate::vision_camera_maintenance::VisionCameraRole> {
    match value {
        "top" => Some(crate::vision_camera_maintenance::VisionCameraRole::Top),
        "front" => Some(crate::vision_camera_maintenance::VisionCameraRole::Front),
        _ => None,
    }
}

fn vision_camera_maintenance_gateway_error(
    error: crate::vision_camera_maintenance::VisionCameraMaintenanceError,
) -> axum::response::Response {
    error_response(
        StatusCode::BAD_GATEWAY,
        "vision_camera_maintenance_failed",
        error.to_string(),
    )
}

async fn vision_camera_maintenance_contract(
    State(ctx): State<IpcContext>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if let Err(error) = require_token(&headers, &ctx.token).await {
        return error.into_response();
    }
    match crate::vision_camera_maintenance::get_contract(&reqwest::Client::new()).await {
        Ok(contract) => Json(contract).into_response(),
        Err(error) => vision_camera_maintenance_gateway_error(error),
    }
}

async fn vision_camera_maintenance_refresh(
    State(ctx): State<IpcContext>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if let Err(error) = require_token(&headers, &ctx.token).await {
        return error.into_response();
    }
    match crate::vision_camera_maintenance::refresh_contract(&reqwest::Client::new()).await {
        Ok(contract) => Json(contract).into_response(),
        Err(error) => vision_camera_maintenance_gateway_error(error),
    }
}

async fn vision_camera_maintenance_preview(
    State(ctx): State<IpcContext>,
    AxumPath(candidate_id): AxumPath<String>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if let Err(error) = require_token(&headers, &ctx.token).await {
        return error.into_response();
    }
    match crate::vision_camera_maintenance::preview_candidate(
        &reqwest::Client::new(),
        &candidate_id,
    )
    .await
    {
        Ok(bytes) => ([(CONTENT_TYPE, "image/jpeg")], bytes).into_response(),
        Err(error) => vision_camera_maintenance_gateway_error(error),
    }
}

async fn vision_camera_maintenance_test(
    State(ctx): State<IpcContext>,
    AxumPath(role): AxumPath<String>,
    headers: HeaderMap,
    Json(request): Json<VisionCameraMaintenanceCandidateRequest>,
) -> impl IntoResponse {
    if let Err(error) = require_token(&headers, &ctx.token).await {
        return error.into_response();
    }
    let Some(role) = parse_vision_camera_role(&role) else {
        return error_response(
            StatusCode::NOT_FOUND,
            "vision_camera_role_unknown",
            "unknown vision camera role",
        );
    };
    match crate::vision_camera_maintenance::test_role(
        &reqwest::Client::new(),
        role,
        &request.candidate_id,
    )
    .await
    {
        Ok(result) => Json(result).into_response(),
        Err(error) => vision_camera_maintenance_gateway_error(error),
    }
}

async fn vision_camera_maintenance_confirm(
    State(ctx): State<IpcContext>,
    AxumPath(role): AxumPath<String>,
    headers: HeaderMap,
    Json(request): Json<crate::vision_camera_maintenance::VisionCameraMaintenanceConfirmRequest>,
) -> impl IntoResponse {
    if let Err(error) = require_token(&headers, &ctx.token).await {
        return error.into_response();
    }
    let Some(role) = parse_vision_camera_role(&role) else {
        return error_response(
            StatusCode::NOT_FOUND,
            "vision_camera_role_unknown",
            "unknown vision camera role",
        );
    };
    match crate::vision_camera_maintenance::confirm_role(&reqwest::Client::new(), role, &request)
        .await
    {
        Ok(result) => Json(result).into_response(),
        Err(error) => vision_camera_maintenance_gateway_error(error),
    }
}

async fn natural_context(State(ctx): State<IpcContext>, headers: HeaderMap) -> impl IntoResponse {
    if let Err(error) = require_token(&headers, &ctx.token).await {
        return error.into_response();
    }
    let profile = match ctx.runtime_sources.require_profile().await {
        Ok(value) => value,
        Err(_) => {
            return Json(MachineNaturalContextSnapshot::unconfigured(
                None,
                "Machine is not provisioned for Natural Context",
            ))
            .into_response();
        }
    };
    let machine_code = profile.profile.machine.code.to_string();
    match ctx
        .ui
        .backend
        .get_external_natural_environment(&machine_code)
        .await
    {
        Ok(value) => Json(MachineNaturalContextSnapshot::from_external_environment(
            Some(machine_code),
            value,
            None,
        ))
        .into_response(),
        Err(_) => Json(MachineNaturalContextSnapshot::unavailable(
            Some(machine_code),
            "External Natural Environment is unavailable",
        ))
        .into_response(),
    }
}

async fn remote_ops_status(State(ctx): State<IpcContext>, headers: HeaderMap) -> impl IntoResponse {
    if let Err(error) = require_token(&headers, &ctx.token).await {
        return error.into_response();
    }
    Json(serde_json::json!({ "lastPolledAt": crate::state::store::now_iso(), "pending": 0, "lastError": null, "processing": null })).into_response()
}

async fn export_logs(State(ctx): State<IpcContext>, headers: HeaderMap) -> impl IntoResponse {
    if let Err(error) = require_token(&headers, &ctx.token).await {
        return error.into_response();
    }
    match logs::export_local_logs_zip(&ctx.data_dir).await {
        Ok(bytes) => (
            [
                (CONTENT_TYPE, "application/zip"),
                (
                    CONTENT_DISPOSITION,
                    "attachment; filename=machine-events.zip",
                ),
            ],
            bytes,
        )
            .into_response(),
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, "export_failed", error),
    }
}

async fn events_ws(
    State(ctx): State<IpcContext>,
    Query(query): Query<EventQuery>,
    ws: Option<WebSocketUpgrade>,
) -> impl IntoResponse {
    if query.token.as_deref() != Some(&ctx.token) {
        return error_response(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "missing or invalid event token",
        );
    }
    match ws {
        Some(ws) => ws
            .on_upgrade(move |socket| events_ws_inner(socket, ctx.events))
            .into_response(),
        None => error_response(
            StatusCode::BAD_REQUEST,
            "websocket_required",
            "websocket upgrade required",
        ),
    }
}

async fn events_ws_inner(mut socket: WebSocket, events: broadcast::Sender<DaemonEvent>) {
    let mut receiver = events.subscribe();
    loop {
        tokio::select! { event = receiver.recv() => match event { Ok(event) => if let Ok(payload) = serde_json::to_string(&event) { if socket.send(Message::Text(payload)).await.is_err() { break; } }, Err(_) => break }, _ = socket.recv() => break }
    }
}

fn observation_revision(observed: &[device_binding::ObservedSerialDevice]) -> String {
    let bytes = serde_json::to_vec(observed).unwrap_or_default();
    format!("sha256:{:x}", sha2::Sha256::digest(bytes))
}

fn scanner_config(
    settings: &LocalRuntimeSettings,
    hardware_model: &str,
    topology_identity: &str,
    port_path: Option<String>,
) -> Result<ScannerRuntimeConfig, String> {
    let protocol = effective_scanner_protocol(settings, hardware_model, topology_identity)
        .map_err(|error| format!("{}: {error}", error.code()))?;
    Ok(ScannerRuntimeConfig {
        port_path,
        baud_rate: protocol.baud_rate,
        frame_suffix: protocol.frame_suffix,
        source: vending_core::scanner::PAYMENT_CODE_SOURCE_SERIAL_TEXT.to_string(),
    })
}
fn scanner_health(code: &str, message: &str) -> vending_core::scanner::ScannerHealthSnapshot {
    vending_core::scanner::ScannerHealthSnapshot {
        online: false,
        adapter: vending_core::scanner::PAYMENT_CODE_SOURCE_SERIAL_TEXT.to_string(),
        port: None,
        level: vending_core::health::HealthLevel::Offline,
        code: code.to_string(),
        message: message.to_string(),
        updated_at: crate::state::store::now_iso(),
    }
}
fn error_response(
    status: StatusCode,
    code: &'static str,
    message: impl Into<String>,
) -> axum::response::Response {
    (
        status,
        Json(ErrorMessage {
            code,
            message: message.into(),
        }),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use crate::state::store::StockMovementInput;
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use tower::ServiceExt;
    use wiremock::{
        matchers::{body_json, method, path},
        Mock, MockServer, ResponseTemplate,
    };

    use super::*;

    #[tokio::test]
    async fn sale_start_waits_for_an_in_flight_binding_refresh() {
        let gate = Arc::new(SaleBindingOperationGate::default());
        let binding = gate
            .try_acquire_reconfigure()
            .expect("binding refresh lease");
        let release = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            drop(binding);
        });

        let sale = gate
            .acquire_sale_start(Duration::from_secs(1))
            .await
            .expect("sale lease after binding refresh");
        drop(sale);
        release.await.expect("binding release task");
    }

    #[tokio::test]
    async fn manual_dispense_waits_for_an_in_flight_binding_refresh() {
        let gate = Arc::new(SaleBindingOperationGate::default());
        let binding = gate
            .try_acquire_reconfigure()
            .expect("binding refresh lease");
        let release = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            drop(binding);
        });

        let manual_dispense = gate
            .acquire_manual_dispense(Duration::from_secs(1))
            .await
            .expect("manual dispense lease after binding refresh");
        drop(manual_dispense);
        release.await.expect("binding release task");
    }

    async fn test_context(
        data_dir: PathBuf,
        api_base_url: String,
    ) -> (IpcContext, Arc<crate::secret::InMemorySecretStore>) {
        let state = LocalStateStore::open(&data_dir.join("state.db"))
            .await
            .expect("state");
        let secrets = Arc::new(crate::secret::InMemorySecretStore::default());
        let sources = Arc::new(RuntimeSources::new(data_dir.clone(), secrets.clone()));
        let backend = Arc::new(BackendClient::new(api_base_url));
        let (events, _) = broadcast::channel(8);
        let (raw_tx, _) = mpsc::channel::<crate::transaction::ArmedPaymentCode>(2);
        let payment_code_scan_armer = crate::transaction::PaymentCodeScanArmer::default();
        let cache = RuntimeStatusCache::new(None, state.clone()).await;
        let transaction =
            TransactionStateMachine::new(state.clone(), backend.clone(), None, events.clone());
        (
            IpcContext {
                data_dir: data_dir.clone(),
                token: "test-token".to_string(),
                runtime_sources: sources,
                state,
                hardware: HardwareSupervisor::from_adapter(Arc::new(
                    vending_core::hardware::MockHardwareAdapter,
                )),
                events: events.clone(),
                runtime_tx: raw_tx.clone(),
                scanner_runtime: ScannerRuntimeController::new(
                    raw_tx,
                    events,
                    payment_code_scan_armer,
                ),
                serial_device_platform: Arc::new(device_binding::WindowsSerialDevicePlatform),
                device_binding_test_evidence: Arc::new(DeviceBindingTestEvidenceStore::default()),
                sale_binding_gate: Arc::new(SaleBindingOperationGate::default()),
                disk_pressure_probe: Arc::new(crate::health::DataDirDiskPressureProbe::new(0)),
                network_adapter: crate::network::adapter_from_env(),
                ui: UiRuntimeServices {
                    backend,
                    transaction,
                    status_cache: cache,
                },
                background_shutdown: CancellationToken::new(),
            },
            secrets,
        )
    }

    fn claim_profile(api_base_url: &str) -> serde_json::Value {
        serde_json::json!({
            "machine": { "id": "550e8400-e29b-41d4-a716-446655440001", "code": "VEM-CLAIM-01", "name": "Claimed machine", "status": "offline", "locationLabel": null },
            "credentials": { "machineSecret": "m".repeat(32), "machineSecretVersion": 1, "mqttSigningSecret": "s".repeat(32), "mqttConnection": { "url": "mqtt://broker.example:1883", "clientId": "vem-VEM-CLAIM-01", "username": "machine", "password": "mqtt-password" } },
            "apiBaseUrl": api_base_url,
            "runtimeEndpoints": { "apiBasePath": "/api", "machineAuthTokenPath": "/api/machine-auth/token", "machineApiBasePath": "/api/machines/VEM-CLAIM-01", "mqttTopicPrefix": "vem/machines/VEM-CLAIM-01" },
            "hardwareProfile": { "profile": "production", "controller": { "required": true, "protocol": "vem-vending-controller" }, "paymentScanner": { "required": true, "supportsPaymentCode": true }, "vision": { "required": false, "supportsRecommendations": false } },
            "hardwareModel": "vem-prod-24",
            "hardwareSlotTopology": { "identity": "vem-prod-24", "version": "v1" },
            "paymentCapability": { "profile": "production", "qrCodeEnabled": true, "paymentCodeEnabled": true, "serverTime": "2026-07-17T00:00:00Z" },
            "metadata": { "profileVersion": 1, "profileRevision": 1, "claimCodeId": "550e8400-e29b-41d4-a716-446655440002", "claimedAt": "2026-07-17T00:00:00Z", "serverTime": "2026-07-17T00:00:00Z" }
        })
    }

    fn scanner_test_binding() -> LocalSerialRoleBinding {
        LocalSerialRoleBinding {
            identity: device_binding::StableSerialDeviceIdentity {
                identity_key: "container:scanner-01".to_string(),
                instance_id: Some("USB\\SCANNER-01".to_string()),
                container_id: Some("11111111-2222-3333-4444-555555555555".to_string()),
                hardware_ids: vec!["USB\\VID_1A86&PID_55D4".to_string()],
                serial_number: Some("SCANNER-01".to_string()),
            },
            confirmed_at: "2026-07-17T00:00:00Z".to_string(),
            confirmed_by: "field-operator".to_string(),
            test_evidence_code: "SCANNER_READY".to_string(),
        }
    }

    #[cfg(unix)]
    fn open_scanner_test_pty() -> (nix::pty::PtyMaster, String) {
        use nix::{
            fcntl::OFlag,
            pty::{grantpt, posix_openpt, ptsname_r, unlockpt},
        };

        let master = posix_openpt(OFlag::O_RDWR | OFlag::O_NOCTTY).expect("open scanner pty");
        grantpt(&master).expect("grant scanner pty");
        unlockpt(&master).expect("unlock scanner pty");
        let port = ptsname_r(&master).expect("scanner pty slave path");
        (master, port)
    }

    #[tokio::test]
    async fn clean_start_claim_persists_only_profile_cache_and_extracted_credentials() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/machines/claim"))
            .and(body_json(serde_json::json!({ "claimCode": "CLAI-0001" })))
            .respond_with(ResponseTemplate::new(200).set_body_json(claim_profile(&server.uri())))
            .expect(1)
            .mount(&server)
            .await;
        let temp = tempfile::tempdir().expect("temp");
        let data_dir = temp.path().join("vending-daemon");
        tokio::fs::create_dir_all(&data_dir)
            .await
            .expect("data dir");
        tokio::fs::write(
            temp.path().join("runtime-bootstrap.json"),
            serde_json::json!({ "schemaVersion": 1, "provisioningApiBaseUrl": server.uri(), "hardwareModel": "vem-prod-24", "topology": { "identity": "vem-prod-24", "version": "v1" } }).to_string(),
        ).await.expect("bootstrap");
        let (context, secrets) = test_context(data_dir.clone(), server.uri()).await;
        let response = build_router(context)
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/provisioning/claim")
                    .header("authorization", "Bearer test-token")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"claimCode":"CLAI-0001"}"#))
                    .expect("request"),
            )
            .await
            .expect("response");
        let response_status = response.status();
        let response_body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("claim response body");
        assert_eq!(
            response_status,
            StatusCode::OK,
            "{}",
            String::from_utf8_lossy(&response_body)
        );
        let cache = tokio::fs::read_to_string(data_dir.join("config/profile-cache.json"))
            .await
            .expect("profile cache");
        assert!(cache.contains("VEM-CLAIM-01"));
        assert!(!cache.contains(&"m".repeat(32)));
        assert_eq!(
            crate::secret::SecretStore::read_secret(
                secrets.as_ref(),
                crate::secret::MACHINE_SECRET_ACCOUNT
            )
            .await
            .expect("secret"),
            Some("m".repeat(32))
        );
        assert!(
            !tokio::fs::try_exists(data_dir.join("config/local-settings.json"))
                .await
                .expect("settings path")
        );
    }

    #[tokio::test]
    async fn scanner_protocol_override_clear_preserves_json_null_as_no_local_override() {
        let server = MockServer::start().await;
        let temp = tempfile::tempdir().expect("temp");
        let data_dir = temp.path().join("vending-daemon");
        tokio::fs::create_dir_all(&data_dir)
            .await
            .expect("data dir");
        tokio::fs::write(
            temp.path().join("runtime-bootstrap.json"),
            serde_json::json!({ "schemaVersion": 1, "provisioningApiBaseUrl": server.uri(), "hardwareModel": "vem-prod-24", "topology": { "identity": "vem-prod-24", "version": "v1" } }).to_string(),
        )
        .await
        .expect("bootstrap");
        let (ctx, _) = test_context(data_dir, server.uri()).await;

        let configured = build_router(ctx.clone())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/runtime-configuration/intents/scanner-protocol-parameters")
                    .header("authorization", "Bearer test-token")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"baudRate":115200,"frameSuffix":"lf"}"#))
                    .expect("configure request"),
            )
            .await
            .expect("configure response");
        assert_eq!(configured.status(), StatusCode::OK);

        let cleared = build_router(ctx.clone())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/runtime-configuration/intents/scanner-protocol-parameters")
                    .header("authorization", "Bearer test-token")
                    .header("content-type", "application/json")
                    .body(Body::from("null"))
                    .expect("clear request"),
            )
            .await
            .expect("clear response");
        assert_eq!(cleared.status(), StatusCode::OK);
        assert!(ctx
            .runtime_sources
            .load_local_runtime_settings()
            .await
            .expect("settings")
            .scanner_protocol
            .is_none());
    }

    #[tokio::test]
    async fn clearing_scanner_binding_immediately_replaces_scanner_ready_status() {
        let server = MockServer::start().await;
        let temp = tempfile::tempdir().expect("temp");
        let data_dir = temp.path().join("vending-daemon");
        tokio::fs::create_dir_all(&data_dir)
            .await
            .expect("data dir");
        tokio::fs::write(
            temp.path().join("runtime-bootstrap.json"),
            serde_json::json!({ "schemaVersion": 1, "provisioningApiBaseUrl": server.uri(), "hardwareModel": "vem-prod-24", "topology": { "identity": "vem-prod-24", "version": "v1" } }).to_string(),
        )
        .await
        .expect("bootstrap");
        let (ctx, _) = test_context(data_dir, server.uri()).await;
        let (_, revision) = ctx
            .runtime_sources
            .local_device_binding_snapshot(LocalDeviceRole::Scanner)
            .await
            .expect("binding snapshot");
        ctx.runtime_sources
            .save_local_device_binding_if_revision(
                LocalDeviceRole::Scanner,
                scanner_test_binding(),
                &revision,
            )
            .await
            .expect("save scanner binding");
        *ctx.ui.status_cache.scanner.write().await = vending_core::scanner::ScannerHealthSnapshot {
            online: true,
            adapter: vending_core::scanner::PAYMENT_CODE_SOURCE_SERIAL_TEXT.to_string(),
            port: Some("COM6".to_string()),
            level: vending_core::health::HealthLevel::Ok,
            code: "SCANNER_READY".to_string(),
            message: "scanner ready".to_string(),
            updated_at: crate::state::store::now_iso(),
        };

        let response = build_router(ctx.clone())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/runtime-configuration/intents/hardware-bindings/scanner/clear")
                    .header("authorization", "Bearer test-token")
                    .header("content-type", "application/json")
                    .body(Body::from("{}"))
                    .expect("clear request"),
            )
            .await
            .expect("clear response");
        assert_eq!(response.status(), StatusCode::OK);
        let scanner = ctx.ui.status_cache.scanner.read().await;
        assert!(!scanner.online);
        assert_eq!(scanner.code, "SCANNER_BINDING_CLEARED");
        drop(scanner);
        assert!(ctx
            .runtime_sources
            .load_local_runtime_settings()
            .await
            .expect("settings")
            .scanner_binding
            .is_none());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn queued_old_scanner_ready_cannot_cross_clear_and_new_generation_ready_is_accepted() {
        let server = MockServer::start().await;
        let temp = tempfile::tempdir().expect("temp");
        let data_dir = temp.path().join("vending-daemon");
        tokio::fs::create_dir_all(&data_dir)
            .await
            .expect("data dir");
        tokio::fs::write(
            temp.path().join("runtime-bootstrap.json"),
            serde_json::json!({ "schemaVersion": 1, "provisioningApiBaseUrl": server.uri(), "hardwareModel": "vem-prod-24", "topology": { "identity": "vem-prod-24", "version": "v1" } }).to_string(),
        )
        .await
        .expect("bootstrap");
        let (ctx, _) = test_context(data_dir, server.uri()).await;
        let (_, revision) = ctx
            .runtime_sources
            .local_device_binding_snapshot(LocalDeviceRole::Scanner)
            .await
            .expect("initial binding snapshot");
        ctx.runtime_sources
            .save_local_device_binding_if_revision(
                LocalDeviceRole::Scanner,
                scanner_test_binding(),
                &revision,
            )
            .await
            .expect("save initial scanner binding");

        let (_old_master, old_port) = open_scanner_test_pty();
        let queued_old_events = ctx.events.subscribe();
        ctx.scanner_runtime
            .reconfigure(ScannerRuntimeConfig {
                port_path: Some(old_port),
                baud_rate: 9_600,
                source: vending_core::scanner::PAYMENT_CODE_SOURCE_SERIAL_TEXT.to_string(),
                frame_suffix: vending_core::scanner::ScannerFrameSuffix::Crlf,
            })
            .await
            .expect("start old scanner runtime");

        let response = build_router(ctx.clone())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/runtime-configuration/intents/hardware-bindings/scanner/clear")
                    .header("authorization", "Bearer test-token")
                    .header("content-type", "application/json")
                    .body(Body::from("{}"))
                    .expect("clear request"),
            )
            .await
            .expect("clear response");
        assert_eq!(response.status(), StatusCode::OK);

        let old_events_processed = CancellationToken::new();
        let old_worker = tokio::spawn(crate::shutdown::cache_daemon_events(
            queued_old_events,
            ctx.ui.status_cache.clone(),
            Some(old_events_processed.clone()),
            Some(ctx.clone()),
        ));
        ctx.events
            .send(DaemonEvent::RuntimeReconfigureRequested {
                event_id: "old-generation-drained".to_string(),
                updated_at: crate::state::store::now_iso(),
                reason: "test_barrier".to_string(),
                machine_code: None,
            })
            .expect("send old generation barrier");
        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            old_events_processed.cancelled(),
        )
        .await
        .expect("old scanner events processed");

        let scanner = ctx.ui.status_cache.scanner.read().await.clone();
        assert!(!scanner.online);
        assert_eq!(scanner.code, "SCANNER_BINDING_CLEARED");
        let (scanner_ready, scanner_message) = scanner_payment_readiness(&scanner);
        assert!(!scanner_ready);
        *ctx.ui.status_cache.hardware.write().await = vending_core::hardware::HardwareStatus {
            adapter: "serial".to_string(),
            online: true,
            message: "controller ready".to_string(),
            port_path: Some("COM5".to_string()),
            resolution_source: Some("stable_usb_binding".to_string()),
            bound_usb_identity: None,
            candidates: vec![],
            lower_controller_fault: None,
        };
        let profile: daemon_ipc_contracts::MachineProvisioningProfile =
            serde_json::from_value(claim_profile(&server.uri())).expect("profile");
        let capability = evaluate_sale_start_capability(
            &SaleStartCapabilityObservation {
                profile: profile_cache(&profile),
                topology: crate::runtime_configuration::HardwareTopologyReadiness {
                    ready: true,
                    code: "HARDWARE_TOPOLOGY_READY".to_string(),
                    message: "hardware topology ready".to_string(),
                },
                hardware: ctx.ui.status_cache.hardware.read().await.clone(),
                whole_machine_locked: false,
                has_saleable_slot: true,
                mqtt_connected: true,
                scanner_ready,
                scanner_code: scanner.code.clone(),
                scanner_message,
                platform_default_option_key: Some("payment_code:alipay".to_string()),
                platform_default_provider_code: Some("alipay".to_string()),
                payment_options: vec![BackendPaymentOption {
                    option_key: "payment_code:alipay".to_string(),
                    provider_code: "alipay".to_string(),
                    method: "payment_code".to_string(),
                    display_name: "Payment code".to_string(),
                    description: "Scan payment code".to_string(),
                    icon: "scan".to_string(),
                    recommended: true,
                    disabled: false,
                    disabled_reason: None,
                }],
            },
            "scanner-generation-test".to_string(),
            std::num::NonZeroU64::new(1).expect("non-zero revision"),
            crate::state::store::now_iso(),
        );
        assert!(!capability.can_start_sale);
        assert!(!capability.payment_options.ready);
        assert_eq!(capability.payment_options.options.len(), 1);
        assert!(!capability.payment_options.options[0].ready);
        assert!(
            local_payment_code_submit_guard(ctx.ui.status_cache.clone(), ctx.state.clone())(None)
                .await
                .is_err()
        );
        old_worker.abort();
        let _ = old_worker.await;

        let (_, revision) = ctx
            .runtime_sources
            .local_device_binding_snapshot(LocalDeviceRole::Scanner)
            .await
            .expect("cleared binding snapshot");
        ctx.runtime_sources
            .save_local_device_binding_if_revision(
                LocalDeviceRole::Scanner,
                scanner_test_binding(),
                &revision,
            )
            .await
            .expect("save rebound scanner binding");
        let (_new_master, new_port) = open_scanner_test_pty();
        let queued_new_events = ctx.events.subscribe();
        ctx.scanner_runtime
            .reconfigure(ScannerRuntimeConfig {
                port_path: Some(new_port),
                baud_rate: 9_600,
                source: vending_core::scanner::PAYMENT_CODE_SOURCE_SERIAL_TEXT.to_string(),
                frame_suffix: vending_core::scanner::ScannerFrameSuffix::Crlf,
            })
            .await
            .expect("start rebound scanner runtime");

        let new_events_processed = CancellationToken::new();
        let new_worker = tokio::spawn(crate::shutdown::cache_daemon_events(
            queued_new_events,
            ctx.ui.status_cache.clone(),
            Some(new_events_processed.clone()),
            Some(ctx.clone()),
        ));
        ctx.events
            .send(DaemonEvent::RuntimeReconfigureRequested {
                event_id: "new-generation-drained".to_string(),
                updated_at: crate::state::store::now_iso(),
                reason: "test_barrier".to_string(),
                machine_code: None,
            })
            .expect("send new generation barrier");
        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            new_events_processed.cancelled(),
        )
        .await
        .expect("new scanner events processed");
        let scanner = ctx.ui.status_cache.scanner.read().await.clone();
        assert!(scanner.online);
        assert_eq!(scanner.code, "SCANNER_READY");

        ctx.scanner_runtime
            .stop()
            .await
            .expect("stop scanner runtime");
        new_worker.abort();
        let _ = new_worker.await;
    }

    #[test]
    fn binding_mutation_rejects_unavailable_active_sale_state() {
        assert_eq!(
            binding_mutation_safety::<()>(Err("sqlite read failed".to_string()), |_| false),
            Err(BindingMutationSafety::StateUnavailable(
                "sqlite read failed".to_string()
            ))
        );
    }

    #[tokio::test]
    async fn sale_start_capability_route_tracks_real_dependencies_and_filters_profile_payments() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/machine-orders/payment-options"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "options": [
                    { "optionKey": "qr_code:alipay", "providerCode": "alipay", "method": "qr_code", "displayName": "QR", "description": "QR payment", "icon": "qr", "recommended": true, "disabled": false, "disabledReason": null },
                    { "optionKey": "payment_code:alipay", "providerCode": "alipay", "method": "payment_code", "displayName": "Payment code", "description": "Scan payment code", "icon": "scan", "recommended": false, "disabled": false, "disabledReason": null }
                ],
                "defaultOptionKey": "qr_code:alipay",
                "defaultProviderCode": "alipay"
            })))
            .mount(&server)
            .await;
        let temp = tempfile::tempdir().expect("temp");
        let data_dir = temp.path().join("vending-daemon");
        tokio::fs::create_dir_all(&data_dir)
            .await
            .expect("data dir");
        tokio::fs::write(
            temp.path().join("runtime-bootstrap.json"),
            serde_json::json!({ "schemaVersion": 1, "provisioningApiBaseUrl": server.uri(), "hardwareModel": "vem-prod-24", "topology": { "identity": "vem-prod-24", "version": "v1" } }).to_string(),
        ).await.expect("bootstrap");
        let (ctx, _) = test_context(data_dir, server.uri()).await;
        let mut profile_value = claim_profile(&server.uri());
        profile_value["paymentCapability"]["qrCodeEnabled"] = serde_json::json!(false);
        let profile: daemon_ipc_contracts::MachineProvisioningProfile =
            serde_json::from_value(profile_value).expect("profile");
        ctx.runtime_sources
            .clean_runtime_configuration()
            .accept_profile(&profile)
            .await
            .expect("accepted profile");
        ctx.ui
            .backend
            .set_access_token_for_tests("payment-options-token")
            .await;
        ctx.state
            .apply_planogram(MachinePlanogramInput {
                planogram_version: "PLAN-CAPABILITY".to_string(),
                source: "test".to_string(),
                applied_by: None,
                slots: vec![crate::state::store::MachinePlanogramSlotInput {
                    slot_id: "550e8400-e29b-41d4-a716-446655440011".to_string(),
                    slot_code: "A1".to_string(),
                    layer_no: 1,
                    cell_no: 1,
                    capacity: 8,
                    par_level: 6,
                    inventory_id: "550e8400-e29b-41d4-a716-446655440012".to_string(),
                    variant_id: "550e8400-e29b-41d4-a716-446655440013".to_string(),
                    product_id: "550e8400-e29b-41d4-a716-446655440014".to_string(),
                    product_name: "Water".to_string(),
                    product_description: None,
                    cover_image_url: None,
                    try_on_silhouette_url: None,
                    category_id: None,
                    category_name: None,
                    sku: "WATER-001".to_string(),
                    size: None,
                    color: None,
                    price_cents: 200,
                    product_sort_order: 1,
                    target_gender: None,
                }],
            })
            .await
            .expect("planogram");
        ctx.state
            .record_stock_movement(StockMovementInput {
                movement_id: "MOVE-CAPABILITY".to_string(),
                planogram_version: "PLAN-CAPABILITY".to_string(),
                slot_id: "550e8400-e29b-41d4-a716-446655440011".to_string(),
                movement_type: "stock_count_correction".to_string(),
                quantity: 5,
                source: "test".to_string(),
                attributed_to: None,
            })
            .await
            .expect("stock");
        *ctx.ui.status_cache.hardware.write().await = vending_core::hardware::HardwareStatus {
            adapter: "serial".to_string(),
            online: true,
            message: "controller ready".to_string(),
            port_path: Some("COM5".to_string()),
            resolution_source: Some("stable_usb_binding".to_string()),
            bound_usb_identity: None,
            candidates: vec![],
            lower_controller_fault: None,
        };
        ctx.ui.status_cache.sync.write().await.mqtt_connected = true;
        *ctx.ui.status_cache.scanner.write().await = vending_core::scanner::ScannerHealthSnapshot {
            online: true,
            adapter: vending_core::scanner::PAYMENT_CODE_SOURCE_SERIAL_TEXT.to_string(),
            port: Some("COM6".to_string()),
            level: vending_core::health::HealthLevel::Ok,
            code: "SCANNER_READY".to_string(),
            message: "scanner ready".to_string(),
            updated_at: crate::state::store::now_iso(),
        };
        let mut events = ctx.events.subscribe();

        let payment_response = build_router(ctx.clone())
            .oneshot(
                Request::builder()
                    .uri("/v1/payment-options")
                    .header("authorization", "Bearer test-token")
                    .body(Body::empty())
                    .expect("payment request"),
            )
            .await
            .expect("payment response");
        assert_eq!(payment_response.status(), StatusCode::OK);
        let payment_json: serde_json::Value = serde_json::from_slice(
            &axum::body::to_bytes(payment_response.into_body(), usize::MAX)
                .await
                .expect("payment body"),
        )
        .expect("payment json");
        assert_eq!(
            payment_json["options"].as_array().expect("options").len(),
            1
        );
        assert_eq!(payment_json["options"][0]["method"], "payment_code");

        let rejected_qr_order = build_router(ctx.clone())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/intents/create-order")
                    .header("authorization", "Bearer test-token")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({
                            "inventoryId": "550e8400-e29b-41d4-a716-446655440012",
                            "quantity": 1,
                            "planogramVersion": "PLAN-CAPABILITY",
                            "slotId": "550e8400-e29b-41d4-a716-446655440011",
                            "slotCode": "A1",
                            "paymentMethod": "qr_code",
                            "paymentProviderCode": "alipay",
                            "profileSnapshot": null,
                            "idempotencyKey": "CAPABILITY-QR-REJECTED"
                        })
                        .to_string(),
                    ))
                    .expect("create order request"),
            )
            .await
            .expect("create order response");
        let rejected_qr_status = rejected_qr_order.status();
        let rejected_qr_body = axum::body::to_bytes(rejected_qr_order.into_body(), usize::MAX)
            .await
            .expect("rejected QR body");
        assert_eq!(
            rejected_qr_status,
            StatusCode::BAD_REQUEST,
            "{}",
            String::from_utf8_lossy(&rejected_qr_body)
        );

        let ready = sale_start_capability_snapshot(&ctx, false)
            .await
            .expect("ready capability");
        assert!(ready.can_start_sale);
        assert_eq!(ready.payment_options.options.len(), 1);
        let initial_revision = ready.revision.get();
        let generation = ready.generation.to_string();
        assert!(matches!(
            events.recv().await.expect("initial capability event"),
            DaemonEvent::SaleStartCapabilityChanged { revision, .. } if revision == initial_revision
        ));

        invalidate_sale_start_capability(&ctx).await;
        let invalidated = sale_start_capability_snapshot(&ctx, false)
            .await
            .expect("invalidated capability");
        assert_eq!(invalidated.can_start_sale, ready.can_start_sale);
        assert_eq!(invalidated.revision.get(), initial_revision);
        assert!(matches!(
            events.try_recv(),
            Err(broadcast::error::TryRecvError::Empty)
        ));

        ctx.ui.status_cache.scanner.write().await.online = false;
        let blocked_response = build_router(ctx.clone())
            .oneshot(
                Request::builder()
                    .uri("/v1/sale-start-capability")
                    .header("authorization", "Bearer test-token")
                    .body(Body::empty())
                    .expect("capability request"),
            )
            .await
            .expect("capability response");
        assert_eq!(blocked_response.status(), StatusCode::OK);
        let blocked: daemon_ipc_contracts::SaleStartCapabilitySnapshot = serde_json::from_slice(
            &axum::body::to_bytes(blocked_response.into_body(), usize::MAX)
                .await
                .expect("capability body"),
        )
        .expect("generated capability");
        assert!(!blocked.can_start_sale);
        assert!(blocked.revision.get() > invalidated.revision.get());
        assert_eq!(blocked.generation.to_string(), generation);
        assert!(matches!(
            events.recv().await.expect("capability change event"),
            DaemonEvent::SaleStartCapabilityChanged { revision, .. } if revision == blocked.revision.get()
        ));

        let mut scanner = ctx.ui.status_cache.scanner.write().await;
        scanner.online = true;
        scanner.code = "SCANNER_READY".to_string();
        scanner.message = "scanner ready".to_string();
        scanner.updated_at = crate::state::store::now_iso();
        drop(scanner);
        let restored = sale_start_capability_snapshot(&ctx, false)
            .await
            .expect("restored capability");
        assert!(restored.can_start_sale);

        Mock::given(method("GET"))
            .and(path("/machine-orders/payment-options"))
            .respond_with(ResponseTemplate::new(503))
            .with_priority(1)
            .mount(&server)
            .await;
        ctx.ui.status_cache.scanner.write().await.online = false;
        let stale = sale_start_capability_snapshot(&ctx, false)
            .await
            .expect("last accepted stale capability");
        assert_eq!(stale.generation.to_string(), generation);
        assert!(stale.revision.get() > restored.revision.get());
        assert!(!stale.can_start_sale);
        assert!(stale
            .payment_options
            .options
            .iter()
            .all(|option| option.method != "payment_code" || !option.ready));
        assert!(stale
            .degradations
            .iter()
            .any(|reason| reason.code == "CAPABILITY_STALE"));

        let stale_order = build_router(ctx.clone())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/intents/create-order")
                    .header("authorization", "Bearer test-token")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({
                            "inventoryId": "550e8400-e29b-41d4-a716-446655440012",
                            "quantity": 1,
                            "planogramVersion": "PLAN-CAPABILITY",
                            "slotId": "550e8400-e29b-41d4-a716-446655440011",
                            "slotCode": "A1",
                            "paymentMethod": "payment_code",
                            "paymentProviderCode": "alipay",
                            "profileSnapshot": null,
                            "idempotencyKey": "CAPABILITY-STALE-REJECTED"
                        })
                        .to_string(),
                    ))
                    .expect("stale create order request"),
            )
            .await
            .expect("stale create order response");
        let stale_order_status = stale_order.status();
        let stale_order_body = axum::body::to_bytes(stale_order.into_body(), usize::MAX)
            .await
            .expect("stale create order body");
        assert_eq!(
            stale_order_status,
            StatusCode::SERVICE_UNAVAILABLE,
            "{}",
            String::from_utf8_lossy(&stale_order_body)
        );
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&stale_order_body)
                .expect("stale create order json")["code"],
            "create_order_blocked"
        );

        let restarted_cache =
            RuntimeStatusCache::new(Some(&profile_cache(&profile)), ctx.state).await;
        assert_ne!(restarted_cache.sale_start_generation, generation);
        assert_eq!(restarted_cache.sale_start_state.lock().await.revision, 0);
    }

    #[tokio::test]
    async fn local_operations_routes_use_narrow_token_only_boundaries() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/machine-orders/payment-environment-diagnostic"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "environment": "production",
                "providers": []
            })))
            .mount(&server)
            .await;
        let temp = tempfile::tempdir().expect("temp");
        let data_dir = temp.path().join("vending-daemon");
        tokio::fs::create_dir_all(&data_dir)
            .await
            .expect("data dir");
        tokio::fs::write(
            temp.path().join("runtime-bootstrap.json"),
            serde_json::json!({ "schemaVersion": 1, "provisioningApiBaseUrl": server.uri(), "hardwareModel": "vem-prod-24", "topology": { "identity": "vem-prod-24", "version": "v1" } }).to_string(),
        ).await.expect("bootstrap");
        let (ctx, _) = test_context(data_dir, server.uri()).await;
        let profile: daemon_ipc_contracts::MachineProvisioningProfile =
            serde_json::from_value(claim_profile(&server.uri())).expect("profile");
        ctx.runtime_sources
            .clean_runtime_configuration()
            .accept_profile(&profile)
            .await
            .expect("accepted profile");
        ctx.ui
            .backend
            .set_access_token_for_tests("operations-token")
            .await;
        let planogram: MachinePlanogramInput = serde_json::from_value(serde_json::json!({
            "planogramVersion": "PLAN-OPERATIONS",
            "source": "test",
            "appliedBy": null,
            "slots": [{
                "slotId": "550e8400-e29b-41d4-a716-446655440021",
                "slotCode": "A1",
                "layerNo": 1,
                "cellNo": 1,
                "capacity": 8,
                "parLevel": 6,
                "inventoryId": "550e8400-e29b-41d4-a716-446655440022",
                "variantId": "550e8400-e29b-41d4-a716-446655440023",
                "productId": "550e8400-e29b-41d4-a716-446655440024",
                "productName": "Water",
                "productDescription": null,
                "coverImageUrl": null,
                "categoryId": null,
                "categoryName": null,
                "sku": "WATER-OPS",
                "size": null,
                "color": null,
                "priceCents": 200,
                "productSortOrder": 1,
                "targetGender": null
            }]
        }))
        .expect("planogram");
        ctx.state
            .apply_planogram(planogram)
            .await
            .expect("planogram");

        let retired_movement_response = build_router(ctx.clone())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/stock/movements")
                    .header("authorization", "Bearer test-token")
                    .header("content-type", "application/json")
                    .body(Body::from("{}"))
                    .expect("retired movement request"),
            )
            .await
            .expect("retired movement response");
        assert_eq!(retired_movement_response.status(), StatusCode::NOT_FOUND);

        let task_response = build_router(ctx.clone())
            .oneshot(
                Request::builder()
                    .uri("/v1/stock/maintenance-task")
                    .header("authorization", "Bearer test-token")
                    .body(Body::empty())
                    .expect("task request"),
            )
            .await
            .expect("task response");
        assert_eq!(task_response.status(), StatusCode::OK);
        let task: serde_json::Value = serde_json::from_slice(
            &axum::body::to_bytes(task_response.into_body(), usize::MAX)
                .await
                .expect("task body"),
        )
        .expect("task json");
        let mode = task["mode"].as_str().expect("task mode");
        let slot_input = if mode == "refill" {
            serde_json::json!({ "slotCode": "A1", "addition": 3 })
        } else {
            serde_json::json!({ "slotCode": "A1", "quantity": 3 })
        };
        let submit_response = build_router(ctx.clone())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/stock/maintenance-task")
                    .header("authorization", "Bearer test-token")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({
                            "taskId": task["taskId"],
                            "mode": mode,
                            "slots": [slot_input]
                        })
                        .to_string(),
                    ))
                    .expect("submit request"),
            )
            .await
            .expect("submit response");
        assert_eq!(submit_response.status(), StatusCode::CREATED);

        let diagnostic_response = build_router(ctx.clone())
            .oneshot(
                Request::builder()
                    .uri("/v1/maintenance/payment-environment")
                    .header("authorization", "Bearer test-token")
                    .body(Body::empty())
                    .expect("diagnostic request"),
            )
            .await
            .expect("diagnostic response");
        assert_eq!(diagnostic_response.status(), StatusCode::OK);

        let lock_response = build_router(ctx.clone())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/maintenance/whole-machine-lock/clear")
                    .header("authorization", "Bearer test-token")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"operatorNote":"verified recovery"}"#))
                    .expect("lock request"),
            )
            .await
            .expect("lock response");
        assert_eq!(lock_response.status(), StatusCode::OK);

        let manual_response = build_router(ctx.clone())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/maintenance/manual-dispense-diagnostic")
                    .header("authorization", "Bearer test-token")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"idempotencyKey":"manual-ops-1","slotCode":"A1","quantity":1,"timeoutSeconds":5}"#,
                    ))
                    .expect("manual request"),
            )
            .await
            .expect("manual response");
        assert_eq!(manual_response.status(), StatusCode::CONFLICT);

        let retired_shape_response = build_router(ctx)
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/maintenance/manual-dispense-diagnostic")
                    .header("authorization", "Bearer test-token")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"idempotencyKey":"manual-ops-old","slotCode":"A1","layerNo":1,"cellNo":1,"quantity":1,"timeoutSeconds":5}"#,
                    ))
                    .expect("retired manual request"),
            )
            .await
            .expect("retired manual response");
        assert_eq!(
            retired_shape_response.status(),
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }

    fn profile_cache(
        profile: &daemon_ipc_contracts::MachineProvisioningProfile,
    ) -> daemon_ipc_contracts::ProvisioningProfileCache {
        let mut snapshot = serde_json::to_value(profile).expect("profile value");
        snapshot
            .as_object_mut()
            .expect("profile object")
            .remove("credentials");
        snapshot["mqttConnection"] = serde_json::json!({
            "url": profile.credentials.mqtt_connection.url,
            "clientId": profile.credentials.mqtt_connection.client_id,
            "username": profile.credentials.mqtt_connection.username,
        });
        serde_json::from_value(serde_json::json!({
            "schemaVersion": 1,
            "generation": 1,
            "acceptedAt": "2026-07-17T00:00:00Z",
            "profile": snapshot,
        }))
        .expect("profile cache")
    }
}
