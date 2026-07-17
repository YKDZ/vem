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
    local_runtime_settings::{AudioPreferences, LocalRuntimeSettings, ScannerProtocolParameters},
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
        store::{MachinePlanogramInput, StockMovementInput, OUTBOX_MAX_EVENTS},
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
struct ClaimMachineRequest {
    claim_code: String,
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
struct MockPayment {
    order_no: String,
    succeed: bool,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SubmitPayment {
    order_no: String,
    auth_code: String,
    source: String,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeviceBindingCandidateRequest {
    identity_key: String,
    test_evidence_token: Option<String>,
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
struct LocalEnvironmentControlRequest {
    air_conditioner_on: Option<bool>,
    target_temperature_celsius: Option<i8>,
    vent_speed: Option<u8>,
    timeout_seconds: Option<u64>,
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
}

impl RuntimeStatusCache {
    pub async fn new(
        profile: Option<&daemon_ipc_contracts::ProvisioningProfileCache>,
        state: LocalStateStore,
    ) -> Self {
        let outbox_size = state.outbox_size().await.unwrap_or_default() as usize;
        let mqtt_url = profile.map(|profile| profile.profile.mqtt_connection.url.clone());
        let vision_expected = profile
            .map(|profile| profile.profile.hardware_profile.vision.required)
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
    pub runtime_tx: mpsc::Sender<vending_core::scanner::RawPaymentCode>,
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

#[derive(Debug, Default)]
pub(crate) struct SaleBindingOperationGate {
    state: std::sync::atomic::AtomicU8,
}
impl SaleBindingOperationGate {
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
        .route("/v1/sale-readiness", get(sale_readiness))
        .route("/v1/payment-options", get(payment_options))
        .route("/v1/intents/create-order", post(create_order))
        .route("/v1/intents/cancel-order", post(cancel_order))
        .route("/v1/intents/mock-payment", post(mock_payment))
        .route(
            "/v1/intents/dev-submit-payment-code",
            post(submit_payment_code),
        )
        .route("/v1/transactions/current", get(current_transaction))
        .route("/v1/transactions/:order_no", get(current_transaction))
        .route("/v1/stock/planogram", post(apply_planogram))
        .route("/v1/stock/movements", post(record_stock_movement))
        .route("/v1/hardware/self-check", post(hardware_self_check))
        .route("/v1/hardware-bindings", get(device_binding_snapshot))
        .route("/v1/hardware-bindings/:role/test", post(test_binding))
        .route("/v1/hardware-bindings/:role/confirm", post(confirm_binding))
        .route("/v1/environment/control", post(control_environment))
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
    let mut snapshot = aggregate.ready_snapshot().await;
    let readiness = machine_sale_readiness_snapshot(&ctx).await.unwrap_or_else(|error| serde_json::json!({ "canStartNetworkAuthorizedSale": false, "blockingCodes": [error] }));
    if !readiness
        .get("canStartNetworkAuthorizedSale")
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
    {
        snapshot.ready = false;
        snapshot.can_sell = false;
        snapshot.mode = "maintenance".to_string();
        snapshot.blocking_codes = readiness
            .get("blockingCodes")
            .and_then(|value| value.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_str().map(ToString::to_string))
                    .collect()
            })
            .unwrap_or_else(|| vec!["MACHINE_NOT_READY".to_string()]);
    }
    Json(snapshot)
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
    Json(input): Json<ClaimMachineRequest>,
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
            return error_response(StatusCode::CONFLICT, "runtime_bootstrap_invalid", error)
        }
    };
    let profile = match BackendClient::new(bootstrap.provisioning_api_base_url.to_string())
        .claim_machine_from_bootstrap(&claim_code)
        .await
    {
        Ok(value) => value,
        Err(error) => {
            return error_response(StatusCode::BAD_GATEWAY, "machine_claim_failed", error)
        }
    };
    if let Err(error) = validate_machine_provisioning_profile(&profile) {
        return error_response(StatusCode::BAD_REQUEST, "machine_profile_invalid", error);
    }
    let machine_code = profile.machine.code.clone();
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
            )
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

async fn sale_readiness(State(ctx): State<IpcContext>, headers: HeaderMap) -> impl IntoResponse {
    if let Err(error) = require_token(&headers, &ctx.token).await {
        return error.into_response();
    }
    match machine_sale_readiness_snapshot(&ctx).await {
        Ok(value) => Json(value).into_response(),
        Err(error) => error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "sale_readiness_failed",
            error,
        ),
    }
}

pub(crate) async fn machine_sale_readiness_snapshot(
    ctx: &IpcContext,
) -> Result<serde_json::Value, String> {
    let mut blocking = Vec::<String>::new();
    let profile = match ctx.runtime_sources.require_profile().await {
        Ok(value) => Some(value),
        Err(_) => {
            blocking.push("MACHINE_NOT_CLAIMED".to_string());
            None
        }
    };
    let topology = ctx.runtime_sources.hardware_topology_readiness().await?;
    if !topology.ready {
        blocking.push(topology.code.clone());
    }
    let hardware = ctx.ui.status_cache.hardware.read().await.clone();
    if !hardware.online {
        blocking.push("LOWER_CONTROLLER_UNAVAILABLE".to_string());
    }
    if ctx
        .state
        .whole_machine_maintenance_lock()
        .await
        .map_err(|error| error.to_string())?
        .is_some()
    {
        blocking.push("WHOLE_MACHINE_LOCKED".to_string());
    }
    let machine_code = profile
        .as_ref()
        .map(|value| value.profile.machine.code.to_string());
    let sale_view = ctx
        .state
        .sale_view(machine_code)
        .await
        .map_err(|error| error.to_string())?;
    if !sale_view
        .items
        .iter()
        .any(|item| item.slot_sales_state == "sale_ready" && item.saleable_stock > 0)
    {
        blocking.push("NO_SALEABLE_SLOTS".to_string());
    }
    let scanner = ctx.ui.status_cache.scanner.read().await.clone();
    let payment_code = scanner_payment_readiness(&scanner);
    let capability = profile
        .as_ref()
        .map(|value| &value.profile.payment_capability);
    let methods = serde_json::json!([
        { "method": "qr_code", "providerCode": "wechat_pay", "ready": capability.is_some_and(|value| value.qr_code_enabled), "disabledReason": if capability.is_some_and(|value| value.qr_code_enabled) { serde_json::Value::Null } else { serde_json::Value::String("payment capability unavailable".to_string()) } },
        { "method": "payment_code", "providerCode": "wechat_pay", "ready": capability.is_some_and(|value| value.payment_code_enabled) && payment_code.0, "disabledReason": if payment_code.0 { serde_json::Value::Null } else { serde_json::Value::String(payment_code.1.clone()) } }
    ]);
    Ok(serde_json::json!({
        "canStartNetworkAuthorizedSale": blocking.is_empty(),
        "blockingCodes": blocking,
        "components": {
            "hardware": { "ready": hardware.online, "code": if hardware.online { "HARDWARE_READY" } else { "LOWER_CONTROLLER_UNAVAILABLE" }, "message": hardware.message },
            "topology": { "ready": topology.ready, "code": topology.code, "message": topology.message },
            "paymentOptions": { "methods": methods },
        }
    }))
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
    Arc::new(move || {
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
            let scanner = cache.scanner.read().await.clone();
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
    if ctx.runtime_sources.require_profile().await.is_err() {
        return error_response(
            StatusCode::CONFLICT,
            "machine_not_claimed",
            "machine provisioning profile has not been claimed",
        );
    }
    match ctx.ui.backend.get_payment_options().await {
        Ok(value) => Json(value).into_response(),
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
    let _sale = match ctx.sale_binding_gate.try_acquire_sale_start() {
        Ok(value) => value,
        Err(_) => {
            return error_response(
                StatusCode::CONFLICT,
                "create_order_hardware_reconfiguring",
                "local hardware binding is changing",
            )
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
    let readiness = match machine_sale_readiness_snapshot(&ctx).await {
        Ok(value) => value,
        Err(error) => {
            return error_response(
                StatusCode::SERVICE_UNAVAILABLE,
                "create_order_blocked",
                error,
            )
        }
    };
    if !readiness
        .get("canStartNetworkAuthorizedSale")
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
    {
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
    let capability = &profile.profile.payment_capability;
    if (input.payment_method == "qr_code" && !capability.qr_code_enabled)
        || (input.payment_method == "payment_code" && !capability.payment_code_enabled)
    {
        return error_response(
            StatusCode::BAD_REQUEST,
            "create_order_blocked",
            "selected payment method is unavailable",
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
            )
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

async fn mock_payment(
    State(ctx): State<IpcContext>,
    headers: HeaderMap,
    Json(input): Json<MockPayment>,
) -> impl IntoResponse {
    if let Err(error) = require_token(&headers, &ctx.token).await {
        return error.into_response();
    }
    match ctx
        .ui
        .transaction
        .mark_mock_payment(input.order_no.trim(), input.succeed)
        .await
    {
        Ok(value) => transaction_response(value),
        Err(error) => error_response(StatusCode::BAD_GATEWAY, "mock_payment_failed", error),
    }
}

async fn submit_payment_code(
    State(ctx): State<IpcContext>,
    headers: HeaderMap,
    Json(input): Json<SubmitPayment>,
) -> impl IntoResponse {
    if let Err(error) = require_token(&headers, &ctx.token).await {
        return error.into_response();
    }
    if !matches!(input.source.as_str(), "manual_dev" | "browser_test") {
        return error_response(
            StatusCode::BAD_REQUEST,
            "invalid_source",
            "source must be manual_dev or browser_test",
        );
    }
    match ctx.ui.transaction.restore_current().await {
        Ok(Some(snapshot)) if snapshot.order_no.as_deref() == Some(input.order_no.as_str()) => {}
        Ok(Some(_)) => {
            return error_response(
                StatusCode::CONFLICT,
                "transaction_mismatch",
                "input order does not match current transaction",
            )
        }
        Ok(None) => {
            return error_response(
                StatusCode::CONFLICT,
                "transaction_missing",
                "no active transaction",
            )
        }
        Err(error) => {
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "transaction_read_failed",
                error,
            )
        }
    }
    let raw = vending_core::scanner::RawPaymentCode {
        auth_code: input.auth_code,
        masked_code: "manual".to_string(),
        scanned_at_ms: crate::state::store::now_millis(),
    };
    if let Err(error) = ctx
        .ui
        .transaction
        .submit_payment_code(raw, &input.source, None)
        .await
    {
        return error_response(StatusCode::BAD_REQUEST, "submit_payment_code_failed", error);
    }
    current_transaction(State(ctx), headers)
        .await
        .into_response()
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
            )
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
            return error_response(StatusCode::CONFLICT, "hardware_topology_unavailable", error)
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
        Ok(value) => Json(value).into_response(),
        Err(error) => error_response(
            StatusCode::BAD_REQUEST,
            "planogram_apply_failed",
            error.to_string(),
        ),
    }
}

async fn record_stock_movement(
    State(ctx): State<IpcContext>,
    headers: HeaderMap,
    Json(input): Json<StockMovementInput>,
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
        .record_stock_movement_with_upload(
            input,
            Some(&profile.profile.machine.code.to_string()),
            Some(&profile.profile.api_base_url),
        )
        .await
    {
        Ok(value) => Json(value).into_response(),
        Err(error) => error_response(
            StatusCode::BAD_REQUEST,
            "stock_movement_failed",
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
    Json(status).into_response()
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
            )
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
    Json(serde_json::json!({ "bindings": [lower, scan] })).into_response()
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
    Json(input): Json<DeviceBindingCandidateRequest>,
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
            )
        }
    };
    let Some(candidate) = observed.iter().find(|candidate| {
        device_binding::StableSerialDeviceIdentity::try_from_observation(candidate)
            .ok()
            .as_ref()
            .is_some_and(|identity| identity.identity_key == input.identity_key)
    }) else {
        return error_response(
            StatusCode::NOT_FOUND,
            "device_binding_candidate_missing",
            "stable USB device identity is not currently observed",
        );
    };
    let settings = match ctx.runtime_sources.load_local_runtime_settings().await {
        Ok(value) => value,
        Err(error) => {
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "local_settings_read_failed",
                error,
            )
        }
    };
    let result = ctx
        .serial_device_platform
        .test_candidate(
            role,
            candidate,
            &device_binding::SerialDeviceRoleProbeConfig::from(&scanner_protocol(&settings)),
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
            )
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

async fn confirm_binding(
    State(ctx): State<IpcContext>,
    AxumPath(role): AxumPath<String>,
    headers: HeaderMap,
    Json(input): Json<DeviceBindingCandidateRequest>,
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
            )
        }
    };
    if ctx
        .state
        .current_transaction_snapshot()
        .await
        .ok()
        .flatten()
        .as_ref()
        .is_some_and(crate::transaction::is_active_transaction)
    {
        return error_response(
            StatusCode::CONFLICT,
            "device_binding_active_sale",
            "hardware binding cannot change during an active sale",
        );
    }
    let observed = match ctx.serial_device_platform.discover().await {
        Ok(value) => value,
        Err(error) => {
            return error_response(
                StatusCode::SERVICE_UNAVAILABLE,
                "device_discovery_failed",
                error,
            )
        }
    };
    let observation_revision = observation_revision(&observed);
    let Some(candidate) = observed.iter().find(|candidate| {
        device_binding::StableSerialDeviceIdentity::try_from_observation(candidate)
            .ok()
            .as_ref()
            .is_some_and(|identity| identity.identity_key == input.identity_key)
    }) else {
        return error_response(
            StatusCode::NOT_FOUND,
            "device_binding_candidate_missing",
            "stable USB device identity is not currently observed",
        );
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
            )
        }
    };
    let Some(token) = input.test_evidence_token.as_deref() else {
        return error_response(
            StatusCode::BAD_REQUEST,
            "device_binding_test_required",
            "test the stable device before confirming it",
        );
    };
    if let Err(error) = ctx
        .device_binding_test_evidence
        .consume(
            token,
            role,
            &input.identity_key,
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
            return error_response(StatusCode::BAD_REQUEST, "device_identity_invalid", error)
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
            )
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
    Json(serde_json::json!({ "binding": binding, "currentPort": candidate.current_port, "ready": true, "code": "DEVICE_BINDING_ACTIVATED" })).into_response()
}

async fn confirm_runtime_binding(
    State(ctx): State<IpcContext>,
    AxumPath(role): AxumPath<String>,
    headers: HeaderMap,
    Json(input): Json<daemon_ipc_contracts::ConfirmHardwareBindingRequest>,
) -> impl IntoResponse {
    confirm_binding(
        State(ctx),
        AxumPath(role),
        headers,
        Json(DeviceBindingCandidateRequest {
            identity_key: input.identity_key.to_string(),
            test_evidence_token: Some(input.test_evidence_token.to_string()),
        }),
    )
    .await
    .into_response()
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
            ctx.scanner_runtime
                .reconfigure(scanner_config(&settings, Some(port)))
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
            )
        }
    };
    if ctx
        .state
        .current_transaction_snapshot()
        .await
        .ok()
        .flatten()
        .as_ref()
        .is_some_and(crate::transaction::is_active_transaction)
    {
        return error_response(
            StatusCode::CONFLICT,
            "device_binding_active_sale",
            "hardware binding cannot change during an active sale",
        );
    }
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
            )
        }
    };
    let _ = previous;
    if let Err(error) = ctx
        .runtime_sources
        .restore_local_device_binding_if_revision(role, None, &revision)
        .await
    {
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
            let _ = ctx.scanner_runtime.stop().await;
        }
    }
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
    let baud_rate = match u32::try_from(request.baud_rate) {
        Ok(value) => value,
        Err(_) => {
            return error_response(
                StatusCode::BAD_REQUEST,
                "scanner_protocol_parameters_invalid",
                "scanner baud rate is outside the supported range",
            )
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
    let previous = match ctx.runtime_sources.load_local_runtime_settings().await {
        Ok(value) => value.scanner_protocol,
        Err(error) => {
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "local_settings_read_failed",
                error,
            )
        }
    };
    if let Err(error) = ctx
        .runtime_sources
        .set_local_scanner_protocol(Some(ScannerProtocolParameters {
            baud_rate,
            frame_suffix,
        }))
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
            )
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
            if let Err(error) = ctx
                .scanner_runtime
                .reconfigure(scanner_config(&settings, Some(port)))
                .await
            {
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
    runtime_configuration(State(ctx), headers)
        .await
        .into_response()
}

async fn control_environment(
    State(ctx): State<IpcContext>,
    headers: HeaderMap,
    Json(request): Json<LocalEnvironmentControlRequest>,
) -> impl IntoResponse {
    if let Err(error) = require_token(&headers, &ctx.token).await {
        return error.into_response();
    }
    if let Some(value) = request.air_conditioner_on {
        if let Err(error) = ctx.hardware.set_air_conditioner_enabled(value).await {
            return error_response(StatusCode::BAD_GATEWAY, "environment_control_failed", error);
        }
    }
    if let Some(value) = request.target_temperature_celsius {
        if let Err(error) = ctx.hardware.set_target_temperature(value).await {
            return error_response(StatusCode::BAD_GATEWAY, "environment_control_failed", error);
        }
    }
    if let Some(value) = request.vent_speed {
        if let Err(error) = ctx.hardware.set_vent_speed(value).await {
            return error_response(StatusCode::BAD_GATEWAY, "environment_control_failed", error);
        }
    }
    let _ = request.timeout_seconds;
    Json(serde_json::json!({ "accepted": true })).into_response()
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
            .into_response()
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

fn scanner_protocol(settings: &LocalRuntimeSettings) -> ScannerProtocolParameters {
    settings
        .scanner_protocol
        .clone()
        .unwrap_or(ScannerProtocolParameters {
            baud_rate: 9_600,
            frame_suffix: vending_core::scanner::ScannerFrameSuffix::Crlf,
        })
}
fn scanner_config(
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
        let (raw_tx, _) = mpsc::channel(2);
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
                scanner_runtime: ScannerRuntimeController::new(raw_tx, events),
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
            "credentials": { "machineSecret": "m".repeat(32), "mqttSigningSecret": "s".repeat(32), "mqttConnection": { "url": "mqtt://broker.example:1883", "clientId": "vem-VEM-CLAIM-01", "username": "machine", "password": "mqtt-password" } },
            "apiBaseUrl": api_base_url,
            "runtimeEndpoints": { "apiBasePath": "/api", "machineAuthTokenPath": "/api/machine-auth/token", "machineApiBasePath": "/api/machines/VEM-CLAIM-01", "mqttTopicPrefix": "vem/machines/VEM-CLAIM-01" },
            "hardwareProfile": { "profile": "production", "controller": { "required": true, "protocol": "vem-vending-controller" }, "paymentScanner": { "required": true, "supportsPaymentCode": true }, "vision": { "required": false, "supportsRecommendations": false } },
            "hardwareModel": "vem-prod-24",
            "hardwareSlotTopology": { "identity": "vem-prod-24", "version": "v1" },
            "paymentCapability": { "profile": "production", "qrCodeEnabled": true, "paymentCodeEnabled": true, "serverTime": "2026-07-17T00:00:00Z" },
            "metadata": { "profileVersion": 1, "profileRevision": 1, "claimCodeId": "550e8400-e29b-41d4-a716-446655440002", "claimedAt": "2026-07-17T00:00:00Z", "serverTime": "2026-07-17T00:00:00Z" }
        })
    }

    #[tokio::test]
    async fn clean_start_claim_persists_only_profile_cache_and_extracted_credentials() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/machines/claim"))
            .and(body_json(serde_json::json!({ "claimCode": "CLAIM-01" })))
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
                    .body(Body::from(r#"{"claimCode":"claim-01"}"#))
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::OK);
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
}
