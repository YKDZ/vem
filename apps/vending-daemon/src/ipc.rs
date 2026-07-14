use std::{net::SocketAddr, path::Path, path::PathBuf, sync::Arc};

use async_trait::async_trait;
use axum::extract::ws::{Message, WebSocket};
use axum::{
    extract::{Path as AxumPath, Query, State, WebSocketUpgrade},
    http::{
        header::{HeaderName, AUTHORIZATION, CONTENT_DISPOSITION, CONTENT_TYPE},
        HeaderMap, Method, StatusCode,
    },
    response::{IntoResponse, Json},
    routing::{get, post},
    Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use tokio::sync::{broadcast, mpsc, Mutex};
use tokio_util::sync::CancellationToken;
use tower_http::cors::{Any, CorsLayer};

use crate::{
    backend::BackendClient,
    config::{
        ConfigStore, MachineConfigUpdateRequest, MachinePublicConfig,
        ProductionMachinePaymentCapability,
    },
    events::{scanner_runtime_status_contract, DaemonEvent},
    hardware::HardwareSupervisor,
    logs,
    natural_context::MachineNaturalContextSnapshot,
    network::{
        NetworkAdapter, NetworkSettingsRequest, NetworkSettingsResponse, NetworkSetupStatus,
        WifiScanResponse,
    },
    state::{
        store::{
            MachinePlanogramInput, MachinePlanogramSlotInput, PhysicalStockAttestationInput,
            SlotSalesStateInput, StockMovementInput, OUTBOX_MAX_EVENTS,
        },
        LocalStateStore, StoreError,
    },
    transaction::TransactionStateMachine,
};

const SCANNER_READY_STALE_AFTER_SECONDS: i64 = 30;
const PAYMENT_CODE_SCANNER_UNAVAILABLE_CUSTOMER_MESSAGE: &str =
    "扫码器暂不可用，请选择其他支付方式";

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClearWholeMachineMaintenanceLockRequest {
    operator_note: String,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClaimMachineRequest {
    claim_code: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ClaimMachineExecution {
    FirstClaim,
    Reclaim,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct BringUpTaskExecutionRequest {
    contract_version: u8,
    task_id: String,
    task_version: u64,
    kind: crate::bring_up::BringUpTaskKind,
    intent: crate::bring_up::BringUpTaskIntent,
    mutation: BringUpTaskMutation,
}

/// The only mutating payload accepted by the ordered Bring-Up cursor.  This
/// deliberately keeps the machine UI from validating a task in one request
/// and changing the machine through a second, unrelated endpoint.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum BringUpTaskMutation {
    ConfigureNetwork {
        ssid: String,
        password: String,
        hidden: bool,
    },
    ClaimMachine {
        #[serde(rename = "claimCode")]
        claim_code: String,
        #[serde(default, rename = "maintenanceAuthorization")]
        maintenance_authorization: Option<MaintenanceAuthorizationContext>,
    },
    RecordStock {
        attestation: PhysicalStockAttestationInput,
    },
    RefreshProfile,
}

/// Opaque context issued by the Protected Local Maintenance Session boundary.
/// Issue03 owns PIN verification, session issuance and expiry; Bring-Up only
/// receives this explicit capability and fails closed until that boundary
/// verifies it.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaintenanceAuthorizationContext {
    pub session_id: String,
}

#[async_trait]
pub trait MaintenanceAuthorization: Send + Sync {
    async fn authorize_reclaim(
        &self,
        context: &MaintenanceAuthorizationContext,
    ) -> Result<(), String>;

    async fn authorize_non_bring_up_mutation(
        &self,
        _context: &MaintenanceAuthorizationContext,
    ) -> Result<(), String> {
        Err("protected maintenance authorization is unavailable".to_string())
    }
}

pub struct UnavailableMaintenanceAuthorization;

#[async_trait]
impl MaintenanceAuthorization for UnavailableMaintenanceAuthorization {
    async fn authorize_reclaim(
        &self,
        _context: &MaintenanceAuthorizationContext,
    ) -> Result<(), String> {
        Err("protected maintenance authorization is unavailable".to_string())
    }
}

async fn require_non_bring_up_maintenance_authorization(
    ctx: &IpcContext,
    headers: &HeaderMap,
) -> Result<(), axum::response::Response> {
    let Some(session_id) = headers
        .get("x-vem-maintenance-session")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Err((
            StatusCode::FORBIDDEN,
            Json(ErrorMessage {
                code: "protected_maintenance_authorization_required",
                message: "legacy mutation requires protected maintenance authorization".to_string(),
            }),
        )
            .into_response());
    };
    ctx.maintenance_authorization
        .authorize_non_bring_up_mutation(&MaintenanceAuthorizationContext {
            session_id: session_id.to_string(),
        })
        .await
        .map_err(|message| {
            (
                StatusCode::FORBIDDEN,
                Json(ErrorMessage {
                    code: "protected_maintenance_authorization_denied",
                    message,
                }),
            )
                .into_response()
        })
}

async fn require_reclaim_maintenance_authorization(
    ctx: &IpcContext,
    headers: &HeaderMap,
) -> Result<(), axum::response::Response> {
    let Some(session_id) = headers
        .get("x-vem-maintenance-session")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Err((
            StatusCode::FORBIDDEN,
            Json(ErrorMessage {
                code: "protected_maintenance_authorization_required",
                message: "machine reclaim requires a protected maintenance authorization"
                    .to_string(),
            }),
        )
            .into_response());
    };
    ctx.maintenance_authorization
        .authorize_reclaim(&MaintenanceAuthorizationContext {
            session_id: session_id.to_string(),
        })
        .await
        .map_err(|message| {
            (
                StatusCode::FORBIDDEN,
                Json(ErrorMessage {
                    code: "protected_maintenance_authorization_denied",
                    message,
                }),
            )
                .into_response()
        })
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalEnvironmentControlRequest {
    air_conditioner_on: Option<bool>,
    target_temperature_celsius: Option<i8>,
    vent_speed: Option<u8>,
    timeout_seconds: Option<u64>,
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
    pub async fn new(public: &MachinePublicConfig, state: LocalStateStore) -> Self {
        let outbox_size = state.outbox_size().await.unwrap_or_default() as usize;
        Self {
            sync: Arc::new(tokio::sync::RwLock::new(
                vending_core::domain::SyncStatusSnapshot {
                    mqtt_running: public.mqtt_url.starts_with("mqtt://")
                        || public.mqtt_url.starts_with("mqtts://"),
                    mqtt_connected: false,
                    broker_url_masked: Some(public.mqtt_url.clone()),
                    last_heartbeat_at: None,
                    last_command_no: None,
                    outbox_size,
                    outbox_max: OUTBOX_MAX_EVENTS as usize,
                    outbox_usage: if outbox_size == 0 {
                        0.0
                    } else {
                        outbox_size as f64 / OUTBOX_MAX_EVENTS as f64
                    },
                    next_retry_at: None,
                    last_error: None,
                    tls_auth_status: None,
                },
            )),
            hardware: Arc::new(tokio::sync::RwLock::new(
                vending_core::hardware::HardwareStatus {
                    adapter: serde_json::to_value(&public.hardware_adapter)
                        .ok()
                        .and_then(|value| value.as_str().map(ToString::to_string))
                        .unwrap_or_else(|| "unknown".to_string()),
                    online: matches!(
                        public.hardware_adapter,
                        crate::config::HardwareAdapterKind::Mock
                    ),
                    message: "hardware runtime initializing".to_string(),
                    port_path: None,
                    resolution_source: None,
                    bound_usb_identity: None,
                    candidates: vec![],
                },
            )),
            scanner: Arc::new(tokio::sync::RwLock::new(
                vending_core::scanner::ScannerHealthSnapshot {
                    online: false,
                    adapter: serde_json::to_value(&public.scanner_adapter)
                        .ok()
                        .and_then(|value| value.as_str().map(ToString::to_string))
                        .unwrap_or_else(|| "unknown".to_string()),
                    port: public.scanner_serial_port_path.clone(),
                    level: vending_core::health::HealthLevel::Offline,
                    code: "SCANNER_INITIALIZING".to_string(),
                    message: "scanner runtime initializing".to_string(),
                    updated_at: crate::state::store::now_iso(),
                },
            )),
            vision: Arc::new(tokio::sync::RwLock::new(VisionStatusSnapshot {
                enabled: public.vision_enabled,
                online: false,
                message: "unknown".to_string(),
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
    pub config_store: Arc<ConfigStore>,
    pub state: LocalStateStore,
    pub hardware: HardwareSupervisor,
    pub events: broadcast::Sender<DaemonEvent>,
    pub runtime_tx: mpsc::Sender<vending_core::scanner::RawPaymentCode>,
    pub disk_pressure_probe: Arc<dyn crate::health::DiskPressureProbe>,
    pub network_adapter: Arc<dyn NetworkAdapter>,
    pub ui: UiRuntimeServices,
    pub background_shutdown: CancellationToken,
    /// Serializes task validation and the following local mutation.  The
    /// cursor is derived from durable daemon state, so checking it outside
    /// this critical section would reintroduce the UI-side TOCTOU.
    pub bring_up_execution_lock: Arc<Mutex<()>>,
    pub maintenance_authorization: Arc<dyn MaintenanceAuthorization>,
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
        .route("/v1/bring-up", get(bring_up_snapshot))
        .route("/v1/bring-up/tasks/execute", post(execute_bring_up_task))
        .route(
            "/v1/bring-up/reclaim/request",
            post(request_machine_reclaim),
        )
        .route("/v1/network/settings", post(apply_network_settings))
        .route("/v1/network/available", get(available_wifi_networks))
        .route("/v1/config", get(get_config).put(put_config))
        .route("/v1/config/summary", get(get_config_summary))
        .route("/v1/provisioning/claim", post(claim_machine))
        .route("/v1/maintenance/status", get(maintenance_status))
        .route("/v1/catalog", get(catalog_snapshot).post(refresh_catalog))
        .route("/v1/sale-view", get(sale_view))
        .route("/v1/sale-readiness", get(sale_readiness))
        .route("/v1/stock/planogram", post(apply_planogram))
        .route("/v1/stock/planogram/sync", post(sync_planogram))
        .route(
            "/v1/stock/attestation",
            post(record_physical_stock_attestation),
        )
        .route("/v1/stock/movements", post(record_stock_movement))
        .route(
            "/v1/stock/movements/dispense-confirmation",
            get(dispense_confirmation),
        )
        .route("/v1/stock/slot-sales-state", post(update_slot_sales_state))
        .route(
            "/v1/maintenance/whole-machine-lock/clear",
            post(clear_whole_machine_maintenance_lock),
        )
        .route("/v1/payment-options", get(payment_options))
        .route("/v1/intents/create-order", post(create_order_intent))
        .route("/v1/intents/cancel-order", post(cancel_order_intent))
        .route("/v1/intents/mock-payment", post(mock_payment_intent))
        .route(
            "/v1/intents/dev-submit-payment-code",
            post(dev_submit_payment_code_intent),
        )
        .route("/v1/transactions/current", get(current_transaction))
        .route("/v1/transactions/:order_no", get(transaction_by_order_no))
        .route("/v1/hardware/self-check", post(hardware_self_check))
        .route("/v1/environment/control", post(control_environment))
        .route(
            "/v1/hardware/fault-injection/next-dispense",
            post(schedule_next_dispense_fault_injection),
        )
        .route("/v1/sync/status", get(sync_status))
        .route("/v1/scanner/status", get(scanner_status))
        .route("/v1/vision/status", get(vision_status))
        .route("/v1/natural-context", get(natural_context))
        .route("/v1/remote-ops/status", get(remote_ops_status))
        .route("/v1/logs/export", get(export_logs))
        .route("/v1/events", get(events_ws))
        .layer(ipc_cors_layer())
        .with_state(ctx)
}

fn ipc_cors_layer() -> CorsLayer {
    CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET, Method::POST, Method::PUT, Method::OPTIONS])
        .allow_headers([
            AUTHORIZATION,
            CONTENT_TYPE,
            HeaderName::from_static("x-vem-maintenance-session"),
        ])
        .allow_private_network(true)
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
    mut state: IpcContext,
) -> Result<(IpcServerHandle, tokio::task::JoinHandle<Result<(), String>>), String> {
    assert_loopback(bind)?;

    let listener = tokio::net::TcpListener::bind(bind)
        .await
        .map_err(|error| format!("bind IPC failed: {error}"))?;
    let addr = listener
        .local_addr()
        .map_err(|error| format!("read IPC addr failed: {error}"))?;

    let shutdown = CancellationToken::new();
    let graceful = shutdown.clone();
    state.background_shutdown = shutdown.clone();
    let router = build_router(state);
    let task = tokio::spawn(async move {
        axum::serve(listener, router)
            .with_graceful_shutdown(async move {
                graceful.cancelled().await;
            })
            .await
            .map_err(|error| format!("serve IPC failed: {error}"))
    });

    Ok((IpcServerHandle { addr, shutdown }, task))
}

impl IpcServerHandle {
    pub fn shutdown(&self) {
        self.shutdown.cancel();
    }
}

pub async fn load_or_create_ipc_token(data_dir: &Path) -> Result<String, String> {
    let path = data_dir.join("ipc-token");
    if path.exists() {
        return Ok(tokio::fs::read_to_string(&path)
            .await
            .map_err(|error| format!("read IPC token failed: {error}"))?
            .trim()
            .to_string());
    }

    tokio::fs::create_dir_all(data_dir)
        .await
        .map_err(|error| format!("create IPC data dir failed: {error}"))?;

    let mut random = [0_u8; 32];
    getrandom::getrandom(&mut random)
        .map_err(|error| format!("generate IPC token failed: {error}"))?;
    let token = URL_SAFE_NO_PAD.encode(random);
    tokio::fs::write(&path, token.as_bytes())
        .await
        .map_err(|error| format!("write IPC token failed: {error}"))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = tokio::fs::metadata(&path)
            .await
            .map_err(|error| format!("read IPC token mode failed: {error}"))?
            .permissions();
        permissions.set_mode(0o600);
        tokio::fs::set_permissions(&path, permissions)
            .await
            .map_err(|error| format!("chmod IPC token failed: {error}"))?;
    }

    Ok(token)
}

#[derive(serde::Serialize)]
struct ErrorMessage {
    code: &'static str,
    message: String,
}

async fn require_token(
    headers: &HeaderMap,
    token: &str,
) -> Result<(), (StatusCode, Json<ErrorMessage>)> {
    let header = headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    let mut parts = header.split_whitespace();
    let scheme = parts.next();
    let value = parts.next();
    if matches!((scheme, value), (Some("Bearer"), Some(v)) if !v.is_empty() && v == token) {
        Ok(())
    } else {
        Err((
            StatusCode::UNAUTHORIZED,
            Json(ErrorMessage {
                code: "unauthorized",
                message: "missing or invalid bearer token".to_string(),
            }),
        ))
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateOrder {
    inventory_id: String,
    quantity: u32,
    planogram_version: String,
    slot_id: String,
    slot_code: String,
    payment_method: String,
    payment_provider_code: Option<String>,
    profile_snapshot: Option<serde_json::Value>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CancelOrder {
    order_no: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct MockPayment {
    order_no: String,
    succeed: bool,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct DispenseConfirmationQuery {
    order_id: String,
    vending_command_id: String,
}

struct VerifiedCreateOrderLine {
    inventory_id: String,
    quantity: u32,
    planogram_version: String,
    slot_id: String,
    slot_code: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubmitPayment {
    order_no: String,
    auth_code: String,
    source: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ClaimMachineResponse {
    status: &'static str,
    machine_code: String,
    restart_requested: bool,
    config: crate::config::MachinePublicRuntimeConfig,
}

fn backend_error_json(error: &str) -> Option<serde_json::Value> {
    let start = error.find('{')?;
    serde_json::from_str(&error[start..]).ok()
}

fn backend_http_status(error: &str) -> Option<u16> {
    let rest = error.strip_prefix("BACKEND_HTTP_ERROR: ")?;
    rest.split_whitespace().next()?.parse().ok()
}

fn backend_api_error(error: &str) -> Option<(u16, &str)> {
    let rest = error.strip_prefix("BACKEND_API_ERROR: ")?;
    let (code, message) = rest.split_once(' ')?;
    Some((code.parse().ok()?, message))
}

fn create_order_error_response(error: &str) -> (StatusCode, Json<ErrorMessage>) {
    if error.starts_with("backend request failed:")
        || error.starts_with("backend read response failed:")
        || error == "BACKEND_OFFLINE"
        || error == "BACKEND_AUTH_FAILED"
    {
        return (
            StatusCode::BAD_GATEWAY,
            Json(ErrorMessage {
                code: "backend_unavailable",
                message: "后端服务暂不可用，请稍后重试".to_string(),
            }),
        );
    }

    if let Some((status, message)) = backend_api_error(error) {
        if status >= 500
            && (message.contains("支付宝")
                || message.contains("支付通道")
                || message.to_ascii_lowercase().contains("alipay"))
        {
            return (
                StatusCode::BAD_GATEWAY,
                Json(ErrorMessage {
                    code: "payment_provider_unavailable",
                    message: "支付宝支付通道暂不可用，请稍后重试".to_string(),
                }),
            );
        }

        return (
            if status >= 500 {
                StatusCode::BAD_GATEWAY
            } else {
                StatusCode::BAD_REQUEST
            },
            Json(ErrorMessage {
                code: "create_order_failed",
                message: message.to_string(),
            }),
        );
    }

    (
        StatusCode::BAD_REQUEST,
        Json(ErrorMessage {
            code: "create_order_failed",
            message: error.to_string(),
        }),
    )
}

fn cancel_order_error_response(error: &str) -> (StatusCode, Json<ErrorMessage>) {
    if error.starts_with("backend request failed:")
        || error.starts_with("backend read response failed:")
        || error == "BACKEND_OFFLINE"
        || error == "BACKEND_AUTH_FAILED"
    {
        return (
            StatusCode::BAD_GATEWAY,
            Json(ErrorMessage {
                code: "backend_unavailable",
                message: "后端服务暂不可用，请稍后重试".to_string(),
            }),
        );
    }

    if let Some((status, message)) = backend_api_error(error) {
        return (
            match status {
                404 => StatusCode::NOT_FOUND,
                409 => StatusCode::CONFLICT,
                500..=599 => StatusCode::BAD_GATEWAY,
                _ => StatusCode::BAD_REQUEST,
            },
            Json(ErrorMessage {
                code: "cancel_order_failed",
                message: message.to_string(),
            }),
        );
    }

    (
        StatusCode::BAD_REQUEST,
        Json(ErrorMessage {
            code: "cancel_order_failed",
            message: error.to_string(),
        }),
    )
}

fn safe_machine_claim_code(code: &str) -> Option<&'static str> {
    match code {
        "machine_claim_invalid" => Some("machine_claim_invalid"),
        "machine_claim_invalid_or_expired" => Some("machine_claim_invalid_or_expired"),
        "machine_claim_expired" => Some("machine_claim_expired"),
        "machine_claim_used" | "machine_claim_consumed" => Some("machine_claim_used"),
        "machine_claim_revoked" => Some("machine_claim_revoked"),
        "machine_claim_locked" => Some("machine_claim_locked"),
        "machine_claim_backend_unavailable" => Some("machine_claim_backend_unavailable"),
        _ => None,
    }
}

fn machine_claim_message(code: &str) -> &'static str {
    match code {
        "machine_claim_backend_unavailable" => {
            "machine claim backend unavailable; check network connectivity"
        }
        "machine_claim_locked" => "machine claim code cannot be used; contact an administrator",
        "machine_claim_revoked" => "machine claim code cannot be used; contact an administrator",
        "machine_claim_used" => "machine claim code cannot be used; contact an administrator",
        "machine_claim_expired" => "machine claim code expired; contact an administrator",
        "machine_claim_invalid" | "machine_claim_invalid_or_expired" => {
            "machine claim code invalid or expired; verify the code with an administrator"
        }
        _ => "machine claim code invalid or expired; verify the code with an administrator",
    }
}

fn machine_claim_error_response(error: &str) -> (StatusCode, Json<ErrorMessage>) {
    if error.starts_with("backend response parse failed:") {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorMessage {
                code: "machine_profile_invalid",
                message: "provisioning profile invalid".to_string(),
            }),
        );
    }

    if error.starts_with("backend request failed:")
        || error.starts_with("backend read response failed:")
        || error == "BACKEND_OFFLINE"
        || error == "BACKEND_AUTH_FAILED"
    {
        return (
            StatusCode::BAD_GATEWAY,
            Json(ErrorMessage {
                code: "machine_claim_backend_unavailable",
                message: machine_claim_message("machine_claim_backend_unavailable").to_string(),
            }),
        );
    }

    let backend_payload = backend_error_json(error);
    let code = backend_payload
        .as_ref()
        .and_then(|value| {
            value
                .get("code")
                .and_then(|value| value.as_str())
                .and_then(safe_machine_claim_code)
        })
        .unwrap_or_else(|| {
            let backend_message = backend_payload
                .as_ref()
                .and_then(|value| value.get("message"))
                .and_then(|value| value.as_str())
                .unwrap_or_default();
            if backend_message.contains("Invalid or expired machine claim code") {
                return "machine_claim_invalid_or_expired";
            }
            if backend_http_status(error).is_some_and(|status| {
                status == 401 || status == 403 || status == 404 || status >= 500
            }) {
                "machine_claim_backend_unavailable"
            } else {
                "machine_claim_invalid_or_expired"
            }
        });
    let status = if code == "machine_claim_backend_unavailable" {
        StatusCode::BAD_GATEWAY
    } else {
        StatusCode::BAD_REQUEST
    };

    (
        status,
        Json(ErrorMessage {
            code,
            message: machine_claim_message(code).to_string(),
        }),
    )
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackendPaymentOptionsResponse {
    options: Vec<BackendPaymentOption>,
    default_option_key: Option<String>,
    default_provider_code: Option<String>,
    server_time: String,
}

#[derive(serde::Deserialize)]
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

#[derive(serde::Deserialize)]
struct EventQuery {
    token: Option<String>,
}

fn disk_pressure_snapshot(ctx: &IpcContext) -> crate::health::DiskPressureSnapshot {
    ctx.disk_pressure_probe.snapshot(&ctx.data_dir)
}

fn disk_pressure_component(
    snapshot: &crate::health::DiskPressureSnapshot,
) -> vending_core::health::ComponentHealth {
    vending_core::health::ComponentHealth {
        component: "disk".to_string(),
        level: if snapshot.pressured {
            vending_core::health::HealthLevel::Error
        } else {
            vending_core::health::HealthLevel::Ok
        },
        code: if snapshot.pressured {
            crate::health::DISK_PRESSURE_CODE.to_string()
        } else {
            "DISK_CAPACITY_OK".to_string()
        },
        message: snapshot.message.clone(),
        updated_at: crate::state::store::now_iso(),
    }
}

async fn healthz(State(ctx): State<IpcContext>) -> impl IntoResponse {
    let agg = crate::health::HealthAggregator::new(ctx.state.clone());
    let mut snapshot = agg.health_snapshot().await;
    let hardware = ctx.ui.status_cache.hardware.read().await.clone();
    snapshot.hardware_online = hardware.online;
    let hardware_code = if hardware.online {
        "HARDWARE_READY"
    } else {
        "LOWER_CONTROLLER_UNAVAILABLE"
    };
    snapshot
        .components
        .push(vending_core::health::ComponentHealth {
            component: "hardware".to_string(),
            level: if hardware.online {
                vending_core::health::HealthLevel::Ok
            } else {
                vending_core::health::HealthLevel::Offline
            },
            code: hardware_code.to_string(),
            message: hardware.message.clone(),
            updated_at: crate::state::store::now_iso(),
        });
    if !hardware.online {
        snapshot.status = vending_core::health::DaemonUiStatus::Degraded;
        snapshot.operator_reason = hardware_code.to_string();
    }

    let scanner = ctx.ui.status_cache.scanner.read().await.clone();
    snapshot.scanner_online = scanner.online;
    snapshot
        .components
        .push(vending_core::health::ComponentHealth {
            component: "scanner".to_string(),
            level: scanner.level.clone(),
            code: scanner.code.clone(),
            message: scanner.message.clone(),
            updated_at: scanner.updated_at.clone(),
        });
    if !scanner.online && snapshot.operator_reason.is_empty() {
        snapshot.status = vending_core::health::DaemonUiStatus::Degraded;
        snapshot.operator_reason = scanner.code.clone();
    }
    let outbox_max = snapshot.outbox_max.max(1);
    if snapshot.outbox_size as f64 / outbox_max as f64 >= 0.9 {
        snapshot.status = vending_core::health::DaemonUiStatus::Degraded;
        if snapshot.operator_reason.is_empty() {
            snapshot.operator_reason = "SYNC_OUTBOX_CAPACITY".to_string();
        }
        snapshot
            .components
            .push(vending_core::health::ComponentHealth {
                component: "sync_outbox".to_string(),
                level: vending_core::health::HealthLevel::Degraded,
                code: "SYNC_OUTBOX_CAPACITY".to_string(),
                message: format!(
                    "sync outbox capacity pressure: {}/{} pending events",
                    snapshot.outbox_size, outbox_max
                ),
                updated_at: crate::state::store::now_iso(),
            });
    }
    let disk_pressure = disk_pressure_snapshot(&ctx);
    if disk_pressure.pressured {
        snapshot.status = vending_core::health::DaemonUiStatus::Degraded;
        if snapshot.operator_reason.is_empty() {
            snapshot.operator_reason = crate::health::DISK_PRESSURE_CODE.to_string();
        }
        snapshot
            .components
            .push(disk_pressure_component(&disk_pressure));
    }
    Json(snapshot)
}

async fn readyz(State(ctx): State<IpcContext>) -> impl IntoResponse {
    let agg = crate::health::HealthAggregator::new(ctx.state.clone());
    let mut ready = agg.ready_snapshot().await;
    let hardware = ctx.ui.status_cache.hardware.read().await.clone();
    if !hardware.online {
        block_ready_snapshot(
            &mut ready,
            "LOWER_CONTROLLER_UNAVAILABLE",
            "hardware",
            hardware.message,
        );
    }
    if let Ok(Some(lock)) = ctx.state.whole_machine_maintenance_lock().await {
        block_ready_snapshot(&mut ready, &lock.code, "hardware", lock.message);
    }
    match ctx.config_store.hardware_slot_topology_readiness().await {
        Ok(topology) if !topology.ready => {
            block_ready_snapshot(
                &mut ready,
                &topology.code,
                "hardware_slot_topology",
                topology.message,
            );
        }
        Ok(_) => {}
        Err(error) => block_ready_snapshot(
            &mut ready,
            "HARDWARE_SLOT_TOPOLOGY_CHECK_FAILED",
            "hardware_slot_topology",
            error,
        ),
    }
    let outbox_size = ctx.state.outbox_size().await.unwrap_or_default() as usize;
    let outbox_max = OUTBOX_MAX_EVENTS.max(1) as usize;
    if outbox_size as f64 / outbox_max as f64 >= 0.9 {
        block_ready_snapshot(
            &mut ready,
            "SYNC_OUTBOX_CAPACITY",
            "sync_outbox",
            format!("sync outbox capacity pressure: {outbox_size}/{outbox_max} pending events"),
        );
    }
    let disk_pressure = disk_pressure_snapshot(&ctx);
    if disk_pressure.pressured {
        block_ready_snapshot(
            &mut ready,
            crate::health::DISK_PRESSURE_CODE,
            "disk",
            disk_pressure.message,
        );
    }
    Json(ready)
}

fn block_ready_snapshot(
    ready: &mut vending_core::health::ReadySnapshot,
    code: &str,
    component: &str,
    message: impl Into<String>,
) {
    ready.ready = false;
    ready.can_sell = false;
    ready.mode = "maintenance".to_string();
    if !ready.blocking_codes.iter().any(|value| value == code) {
        ready.blocking_codes.push(code.to_string());
    }
    ready
        .blocking_reasons
        .push(vending_core::health::ReadyReason {
            code: code.to_string(),
            component: component.to_string(),
            message: message.into(),
        });
    ready.suggested_route = vending_core::health::SuggestedRoute::Maintenance;
}

async fn get_config(State(ctx): State<IpcContext>, headers: HeaderMap) -> impl IntoResponse {
    if let Err((status, error)) = require_token(&headers, &ctx.token).await {
        return (status, error).into_response();
    }

    match ctx.config_store.load_runtime_config().await {
        Ok(config) => (StatusCode::OK, Json(config.to_public())).into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorMessage {
                code: "config_load_failed",
                message: error,
            }),
        )
            .into_response(),
    }
}

async fn get_config_summary(
    State(ctx): State<IpcContext>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if let Err((status, error)) = require_token(&headers, &ctx.token).await {
        return (status, error).into_response();
    }

    match ctx.config_store.load_runtime_configuration_summary().await {
        Ok(summary) => (StatusCode::OK, Json(summary)).into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorMessage {
                code: "config_load_failed",
                message: error,
            }),
        )
            .into_response(),
    }
}

async fn bring_up_snapshot(State(ctx): State<IpcContext>, headers: HeaderMap) -> impl IntoResponse {
    if let Err((status, error)) = require_token(&headers, &ctx.token).await {
        return (status, error).into_response();
    }

    (StatusCode::OK, Json(bring_up_snapshot_for(&ctx).await)).into_response()
}

async fn bring_up_snapshot_for(ctx: &IpcContext) -> crate::bring_up::BringUpSnapshot {
    let (config, config_error, hardware_mode, reclaim_required, reclaim_requested) =
        match ctx.config_store.load_runtime_configuration_summary().await {
            Ok(summary) => {
                let hardware_mode = summary
                    .factory_manifest
                    .as_ref()
                    .map(|manifest| {
                        crate::bring_up::BringUpHardwareMode::from(manifest.hardware_mode.clone())
                    })
                    .unwrap_or_default();
                let config = bring_up_runtime_config_from_summary(summary.clone());
                let reclaim_requested = ctx
                    .config_store
                    .machine_reclaim_requested()
                    .await
                    .unwrap_or(false);
                // A cache is expected on every provisioned machine.  Only a
                // daemon-owned protected-maintenance request may expose the
                // destructive reclaim cursor.
                (
                    Some(config),
                    None,
                    hardware_mode,
                    reclaim_requested,
                    reclaim_requested,
                )
            }
            Err(error) => (
                None,
                Some(error),
                crate::bring_up::BringUpHardwareMode::default(),
                false,
                false,
            ),
        };
    let topology = match ctx.config_store.hardware_slot_topology_readiness().await {
        Ok(topology) => Some(topology),
        Err(error) => Some(crate::config::HardwareSlotTopologyReadiness {
            ready: false,
            code: "HARDWARE_SLOT_TOPOLOGY_CHECK_FAILED".to_string(),
            message: error,
            local: None,
            platform: None,
        }),
    };
    let topology_ready = topology.as_ref().map(|topology| topology.ready);
    let topology_code = topology.as_ref().map(|topology| topology.code.clone());
    let topology_message = topology.as_ref().map(|topology| topology.message.clone());
    let sale_readiness = machine_sale_readiness_snapshot(&ctx).await.ok();
    let hardware = ctx.ui.status_cache.hardware.read().await.clone();
    let network_status = ctx.ui.status_cache.network.read().await.clone();
    let network_bootstrap_reached_platform = network_status
        .as_ref()
        .is_some_and(network_reached_platform);
    let snapshot = crate::bring_up::evaluate_bring_up(crate::bring_up::BringUpEvaluationInput {
        config,
        config_error,
        hardware_mode,
        platform_reachable: sale_component_ready(sale_readiness.as_ref(), "platformReachability")
            || network_bootstrap_reached_platform,
        topology_ready,
        topology_code,
        topology_message,
        active_planogram_ready: sale_component_ready(sale_readiness.as_ref(), "activePlanogram"),
        production_dispense_path_ready: sale_component_ready(
            sale_readiness.as_ref(),
            "productionDispensePath",
        ),
        production_dispense_path_code: sale_component_string(
            sale_readiness.as_ref(),
            "productionDispensePath",
            "code",
        ),
        production_dispense_path_message: sale_component_string(
            sale_readiness.as_ref(),
            "productionDispensePath",
            "message",
        ),
        hardware_online: hardware.online,
        stock_attestation_required: sale_component_bool(
            sale_readiness.as_ref(),
            "physicalStockAttestation",
            "required",
        ),
        stock_attestation_ready: sale_component_ready(
            sale_readiness.as_ref(),
            "physicalStockAttestation",
        ),
        sale_ready: sale_readiness
            .as_ref()
            .and_then(|snapshot| snapshot.get("canStartNetworkAuthorizedSale"))
            .and_then(|value| value.as_bool())
            .unwrap_or(false),
        reclaim_required,
        reclaim_requested,
        updated_at: crate::state::store::now_iso(),
    });
    let mut snapshot = snapshot;
    if let Some(network) = network_status {
        snapshot
            .diagnostics
            .extend(
                network
                    .diagnostics
                    .into_iter()
                    .map(|item| crate::bring_up::BringUpReason {
                        code: item.code,
                        component: item.component,
                        message: item.message,
                    }),
            );
    }

    snapshot
}

async fn execute_bring_up_task(
    State(ctx): State<IpcContext>,
    headers: HeaderMap,
    Json(payload): Json<BringUpTaskExecutionRequest>,
) -> impl IntoResponse {
    if let Err((status, error)) = require_token(&headers, &ctx.token).await {
        return (status, error).into_response();
    }
    let _execution_guard = ctx.bring_up_execution_lock.lock().await;
    let snapshot = bring_up_snapshot_for(&ctx).await;
    let Some(task) = snapshot.current_task.as_ref() else {
        return (
            StatusCode::CONFLICT,
            Json(ErrorMessage {
                code: "bring_up_task_not_available",
                message: "no daemon bring-up task is currently executable".to_string(),
            }),
        )
            .into_response();
    };
    if task.contract_version != payload.contract_version
        || task.task_id != payload.task_id
        || task.task_version != payload.task_version
        || task.kind != payload.kind
        || task.intent != payload.intent
    {
        return (
            StatusCode::CONFLICT,
            Json(ErrorMessage {
                code: "bring_up_task_stale",
                message: "daemon bring-up task changed; refresh the current task".to_string(),
            }),
        )
            .into_response();
    }

    // Validate the typed payload against the task selected while this lock is
    // held, then execute it before releasing the cursor.  No UI follow-up
    // request may race this validation.
    match (task.kind.clone(), payload.mutation) {
        (
            crate::bring_up::BringUpTaskKind::ConfigureNetwork,
            BringUpTaskMutation::ConfigureNetwork {
                ssid,
                password,
                hidden,
            },
        ) => apply_network_settings_mutation(
            State(ctx.clone()),
            headers,
            Json(serde_json::json!({
                "ssid": ssid,
                "password": password,
                "hidden": hidden,
            })),
        )
        .await
        .into_response(),
        (
            crate::bring_up::BringUpTaskKind::ClaimMachine
            | crate::bring_up::BringUpTaskKind::ReclaimMachine,
            BringUpTaskMutation::ClaimMachine {
                claim_code,
                maintenance_authorization,
            },
        ) => {
            let execution = if task.kind == crate::bring_up::BringUpTaskKind::ReclaimMachine {
                let Some(maintenance_authorization) = maintenance_authorization.as_ref() else {
                    return (
                        StatusCode::FORBIDDEN,
                        Json(ErrorMessage {
                            code: "protected_maintenance_authorization_required",
                            message:
                                "machine reclaim requires a protected maintenance authorization"
                                    .to_string(),
                        }),
                    )
                        .into_response();
                };
                if let Err(message) = ctx
                    .maintenance_authorization
                    .authorize_reclaim(maintenance_authorization)
                    .await
                {
                    return (
                        StatusCode::FORBIDDEN,
                        Json(ErrorMessage {
                            code: "protected_maintenance_authorization_denied",
                            message,
                        }),
                    )
                        .into_response();
                }
                ClaimMachineExecution::Reclaim
            } else {
                ClaimMachineExecution::FirstClaim
            };
            // Reclaim rotation is an invariant of the daemon-projected task;
            // the client never chooses it.
            claim_machine_mutation(
                State(ctx.clone()),
                headers,
                Json(ClaimMachineRequest { claim_code }),
                execution,
            )
            .await
            .into_response()
        }
        (
            crate::bring_up::BringUpTaskKind::AttestStock,
            BringUpTaskMutation::RecordStock { attestation },
        ) => record_physical_stock_attestation_mutation(
            State(ctx.clone()),
            headers,
            Json(attestation),
        )
        .await
        .into_response(),
        (crate::bring_up::BringUpTaskKind::SyncProfile, BringUpTaskMutation::RefreshProfile) => {
            (StatusCode::OK, Json(snapshot)).into_response()
        }
        _ => (
            StatusCode::CONFLICT,
            Json(ErrorMessage {
                code: "bring_up_task_mutation_mismatch",
                message: "mutation does not match the daemon current bring-up task".to_string(),
            }),
        )
            .into_response(),
    }
}

async fn request_machine_reclaim(
    State(ctx): State<IpcContext>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if let Err((status, error)) = require_token(&headers, &ctx.token).await {
        return (status, error).into_response();
    }
    if let Err(response) = require_reclaim_maintenance_authorization(&ctx, &headers).await {
        return response;
    }
    let _execution_guard = ctx.bring_up_execution_lock.lock().await;
    match ctx.config_store.request_machine_reclaim().await {
        Ok(()) => (StatusCode::OK, Json(bring_up_snapshot_for(&ctx).await)).into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorMessage {
                code: "machine_reclaim_request_persist_failed",
                message: error,
            }),
        )
            .into_response(),
    }
}

async fn require_legacy_bring_up_task(
    ctx: &IpcContext,
    expected_kind: crate::bring_up::BringUpTaskKind,
) -> Result<(), axum::response::Response> {
    let snapshot = bring_up_snapshot_for(ctx).await;
    match snapshot.current_task.as_ref() {
        // The legacy endpoint is also used by protected routine maintenance
        // after Bring-Up completed. There is no cursor to race in that state.
        None => Ok(()),
        Some(task) if task.kind == expected_kind => Ok(()),
        Some(_) => Err((
            StatusCode::CONFLICT,
            Json(ErrorMessage {
                code: "bring_up_task_stale",
                message: "daemon bring-up task changed; refresh the current task".to_string(),
            }),
        )
            .into_response()),
    }
}

async fn apply_network_settings(
    State(ctx): State<IpcContext>,
    headers: HeaderMap,
    Json(_payload): Json<serde_json::Value>,
) -> impl IntoResponse {
    if let Err((status, error)) = require_token(&headers, &ctx.token).await {
        return (status, error).into_response();
    }
    if let Err(response) = require_non_bring_up_maintenance_authorization(&ctx, &headers).await {
        return response;
    }
    let _execution_guard = ctx.bring_up_execution_lock.lock().await;
    if let Err(response) =
        require_legacy_bring_up_task(&ctx, crate::bring_up::BringUpTaskKind::ConfigureNetwork).await
    {
        return response;
    }
    apply_network_settings_mutation(State(ctx.clone()), headers, Json(_payload))
        .await
        .into_response()
}

async fn apply_network_settings_mutation(
    State(ctx): State<IpcContext>,
    headers: HeaderMap,
    Json(payload): Json<serde_json::Value>,
) -> impl IntoResponse {
    if let Err((status, error)) = require_token(&headers, &ctx.token).await {
        return (status, error).into_response();
    }

    let payload = match validate_network_settings_payload(payload) {
        Ok(payload) => payload,
        Err(response) => {
            *ctx.ui.status_cache.network.write().await = Some(response.clone());
            return (StatusCode::BAD_REQUEST, Json(response)).into_response();
        }
    };

    let response = ctx.network_adapter.apply_wifi_settings(payload).await;
    let status = match response.status {
        NetworkSetupStatus::Connected => StatusCode::OK,
        NetworkSetupStatus::Failed => StatusCode::BAD_REQUEST,
        NetworkSetupStatus::Unsupported => StatusCode::UNPROCESSABLE_ENTITY,
    };
    if matches!(response.status, NetworkSetupStatus::Connected) {
        if let Err(error) = ctx
            .config_store
            .save_local_bring_up_network_profile(response.ssid.clone())
            .await
        {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorMessage {
                    code: "local_bring_up_settings_persist_failed",
                    message: error,
                }),
            )
                .into_response();
        }
    }
    *ctx.ui.status_cache.network.write().await = Some(response.clone());
    (status, Json(response)).into_response()
}

async fn available_wifi_networks(
    State(ctx): State<IpcContext>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if let Err((status, error)) = require_token(&headers, &ctx.token).await {
        return (status, error).into_response();
    }
    let response: WifiScanResponse = ctx.network_adapter.scan_wifi_networks().await;
    (StatusCode::OK, Json(response)).into_response()
}

fn validate_network_settings_payload(
    payload: serde_json::Value,
) -> Result<NetworkSettingsRequest, NetworkSettingsResponse> {
    let Some(object) = payload.as_object() else {
        return Err(invalid_network_settings_response(
            "",
            false,
            "request body must be a JSON object",
        ));
    };
    let allowed = ["ssid", "password", "hidden"];
    if let Some(field) = object
        .keys()
        .find(|key| !allowed.contains(&key.as_str()))
        .cloned()
    {
        return Err(invalid_network_settings_response(
            string_field(object, "ssid")
                .map(str::trim)
                .unwrap_or_default(),
            bool_field(object, "hidden").unwrap_or(false),
            format!("unsupported network settings field: {field}"),
        ));
    }

    let Some(ssid) = string_field(object, "ssid") else {
        return Err(invalid_network_settings_response(
            "",
            bool_field(object, "hidden").unwrap_or(false),
            "SSID is required",
        ));
    };
    let Some(password) = string_field(object, "password") else {
        return Err(invalid_network_settings_response(
            ssid.trim(),
            bool_field(object, "hidden").unwrap_or(false),
            "Wi-Fi password is required",
        ));
    };
    let hidden = bool_field(object, "hidden").unwrap_or(false);
    let ssid = ssid.trim();

    let error = if ssid.is_empty() {
        Some("SSID is required")
    } else if password.is_empty() {
        Some("Wi-Fi password is required")
    } else if ssid.len() > 32 {
        Some("SSID must be at most 32 bytes")
    } else if password.chars().count() < 8 || password.chars().count() > 63 {
        Some("WPA passphrase must be between 8 and 63 characters")
    } else if contains_control_character(ssid) || contains_control_character(password) {
        Some("SSID and password must not contain XML-invalid control characters")
    } else {
        None
    };

    if let Some(message) = error {
        return Err(invalid_network_settings_response(ssid, hidden, message));
    }

    Ok(NetworkSettingsRequest {
        ssid: ssid.to_string(),
        password: password.to_string(),
        hidden,
    })
}

fn string_field<'a>(
    object: &'a serde_json::Map<String, serde_json::Value>,
    field: &str,
) -> Option<&'a str> {
    object.get(field).and_then(|value| value.as_str())
}

fn bool_field(object: &serde_json::Map<String, serde_json::Value>, field: &str) -> Option<bool> {
    object.get(field).and_then(|value| value.as_bool())
}

fn contains_control_character(value: &str) -> bool {
    value.chars().any(char::is_control)
}

fn invalid_network_settings_response(
    ssid: impl Into<String>,
    hidden: bool,
    message: impl Into<String>,
) -> NetworkSettingsResponse {
    NetworkSettingsResponse {
        status: NetworkSetupStatus::Failed,
        ssid: ssid.into(),
        hidden,
        diagnostics: vec![crate::network::NetworkDiagnostic {
            component: "local_network".to_string(),
            level: "error".to_string(),
            code: "NETWORK_SETTINGS_INVALID_PAYLOAD".to_string(),
            message: message.into(),
        }],
        operator_guidance:
            "Wi-Fi 信息格式无效。请重新输入 1-32 字节 SSID 和 8-63 位 WPA/WPA2 密码。".to_string(),
        updated_at: crate::state::store::now_iso(),
    }
}

fn bring_up_runtime_config_from_summary(
    summary: crate::config::RuntimeConfigurationSummary,
) -> crate::config::MachinePublicRuntimeConfig {
    let provisioned = summary.provisioning_profile_cache.is_some()
        && summary.effective_public.machine_code.is_some();
    let mut provisioning_issues = Vec::new();
    if !provisioned {
        provisioning_issues.push("provisioning_profile_cache_missing".to_string());
    }
    crate::config::MachinePublicRuntimeConfig {
        public: summary.effective_public,
        machine_secret_configured: summary.configured_state.machine_secret_configured,
        mqtt_signing_secret_configured: summary.configured_state.mqtt_signing_secret_configured,
        mqtt_password_configured: summary.configured_state.mqtt_password_configured,
        provisioned,
        provisioning_issues,
    }
}

fn sale_component<'a>(
    snapshot: Option<&'a serde_json::Value>,
    component: &str,
) -> Option<&'a serde_json::Value> {
    snapshot?
        .get("components")
        .and_then(|value| value.get(component))
}

fn sale_component_ready(snapshot: Option<&serde_json::Value>, component: &str) -> bool {
    sale_component_bool(snapshot, component, "ready")
}

fn network_reached_platform(network: &NetworkSettingsResponse) -> bool {
    matches!(network.status, NetworkSetupStatus::Connected)
        && network.diagnostics.iter().any(|item| {
            item.component == "provisioning_endpoint"
                && item.code == "PROVISIONING_ENDPOINT_REACHABLE"
        })
}

fn sale_component_bool(snapshot: Option<&serde_json::Value>, component: &str, field: &str) -> bool {
    sale_component(snapshot, component)
        .and_then(|value| value.get(field))
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
}

fn sale_component_string(
    snapshot: Option<&serde_json::Value>,
    component: &str,
    field: &str,
) -> Option<String> {
    sale_component(snapshot, component)
        .and_then(|value| value.get(field))
        .and_then(|value| value.as_str())
        .map(ToString::to_string)
}

async fn put_config(
    State(ctx): State<IpcContext>,
    headers: HeaderMap,
    Json(payload): Json<MachineConfigUpdateRequest>,
) -> impl IntoResponse {
    if let Err((status, error)) = require_token(&headers, &ctx.token).await {
        return (status, error).into_response();
    }

    match ctx.config_store.save_config_update(payload).await {
        Ok(config) => (StatusCode::OK, Json(config)).into_response(),
        Err(error) => (
            StatusCode::BAD_REQUEST,
            Json(ErrorMessage {
                code: "config_invalid",
                message: error,
            }),
        )
            .into_response(),
    }
}

async fn claim_machine(
    State(ctx): State<IpcContext>,
    headers: HeaderMap,
    Json(_payload): Json<ClaimMachineRequest>,
) -> impl IntoResponse {
    if let Err((status, error)) = require_token(&headers, &ctx.token).await {
        return (status, error).into_response();
    }
    if let Err(response) = require_non_bring_up_maintenance_authorization(&ctx, &headers).await {
        return response;
    }
    let _execution_guard = ctx.bring_up_execution_lock.lock().await;
    if let Err(response) =
        require_legacy_bring_up_task(&ctx, crate::bring_up::BringUpTaskKind::ClaimMachine).await
    {
        return response;
    }
    claim_machine_mutation(
        State(ctx.clone()),
        headers,
        Json(_payload),
        ClaimMachineExecution::FirstClaim,
    )
    .await
    .into_response()
}

async fn claim_machine_mutation(
    State(ctx): State<IpcContext>,
    headers: HeaderMap,
    Json(payload): Json<ClaimMachineRequest>,
    execution: ClaimMachineExecution,
) -> impl IntoResponse {
    if let Err((status, error)) = require_token(&headers, &ctx.token).await {
        return (status, error).into_response();
    }

    let claim_code = payload.claim_code.trim().to_ascii_uppercase();
    // Only the daemon-projected reclaim task can rotate the maintenance
    // identity. Legacy callers cannot choose this lifecycle transition.
    let rotate_maintenance_identity = execution == ClaimMachineExecution::Reclaim;
    let maintenance_public_key = match if rotate_maintenance_identity {
        ctx.config_store
            .ensure_reclaim_maintenance_public_key(&claim_code)
            .await
    } else {
        ctx.config_store.ensure_maintenance_public_key().await
    } {
        Ok(public_key) => public_key,
        Err(_) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorMessage {
                    code: "maintenance_identity_generation_failed",
                    message: "machine maintenance identity could not be generated".to_string(),
                }),
            )
                .into_response();
        }
    };
    let provisioning_profile = match ctx.config_store.provisioning_profile_name().await {
        Ok(profile) => profile,
        Err(_) => {
            return (
                StatusCode::CONFLICT,
                Json(ErrorMessage {
                    code: "provisioning_profile_invalid",
                    message: "machine provisioning profile is invalid".to_string(),
                }),
            )
                .into_response();
        }
    };
    let public = match ctx.config_store.load_effective_public_config().await {
        Ok(public) => public,
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorMessage {
                    code: "config_load_failed",
                    message: error,
                }),
            )
                .into_response();
        }
    };
    let client = BackendClient::new(public.api_base_url);
    let profile = match client
        .claim_machine(
            &claim_code,
            &maintenance_public_key,
            &provisioning_profile,
            rotate_maintenance_identity,
        )
        .await
    {
        Ok(profile) => profile,
        Err(error) => {
            return machine_claim_error_response(&error).into_response();
        }
    };
    if profile.provisioning_profile != provisioning_profile {
        return (
            StatusCode::CONFLICT,
            Json(ErrorMessage {
                code: "provisioning_profile_mismatch",
                message: "machine provisioning profile does not match the factory profile"
                    .to_string(),
            }),
        )
            .into_response();
    }
    let machine_code = profile.machine.code.clone();
    let maintenance_identity = profile.maintenance.clone();
    match ctx.config_store.apply_provisioning_profile(profile).await {
        Ok(config) => {
            if ctx
                .config_store
                .apply_maintenance_profile(&maintenance_identity, rotate_maintenance_identity)
                .await
                .is_err()
            {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ErrorMessage {
                        code: "maintenance_tunnel_apply_failed",
                        message: "machine maintenance tunnel configuration failed".to_string(),
                    }),
                )
                    .into_response();
            }
            if rotate_maintenance_identity {
                let reconcile_context = ctx.clone();
                let background_shutdown = ctx.background_shutdown.clone();
                tokio::spawn(async move {
                    reconcile_maintenance_until_terminal(
                        &reconcile_context,
                        &background_shutdown,
                        120,
                        std::time::Duration::from_secs(5),
                    )
                    .await;
                });
            }
            let _ = ctx.events.send(DaemonEvent::RuntimeReconfigureRequested {
                event_id: uuid::Uuid::new_v4().simple().to_string(),
                updated_at: crate::state::store::now_iso(),
                reason: "machine_provisioned".to_string(),
                machine_code: Some(machine_code.clone()),
            });
            let _ = ctx.config_store.clear_machine_reclaim_request().await;
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
        Err(error) if error.starts_with("provisioning persistence failed:") => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorMessage {
                code: "machine_profile_persistence_failed",
                message: "machine profile persistence failed; retry provisioning".to_string(),
            }),
        )
            .into_response(),
        Err(error) => (
            StatusCode::BAD_REQUEST,
            Json(ErrorMessage {
                code: "machine_profile_invalid",
                message: error,
            }),
        )
            .into_response(),
    }
}

async fn maintenance_status(
    State(ctx): State<IpcContext>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if let Err((status, error)) = require_token(&headers, &ctx.token).await {
        return (status, error).into_response();
    }
    let status = reconcile_maintenance_status(&ctx).await;
    (StatusCode::OK, Json(status)).into_response()
}

async fn reconcile_maintenance_status(
    ctx: &IpcContext,
) -> crate::maintenance::MaintenanceEnrollmentStatus {
    let mut status = ctx.config_store.maintenance_status().await;
    if status.handshake_verified {
        if let Some(pending_public_key) = status.pending_public_key.clone() {
            let platform_status = async {
                let public = ctx.config_store.load_effective_public_config().await?;
                let machine_code = public
                    .machine_code
                    .ok_or_else(|| "machine code is unavailable".to_string())?;
                let machine_secret = ctx
                    .config_store
                    .runtime_secrets()
                    .await?
                    .machine_secret
                    .ok_or_else(|| "machine credential is unavailable".to_string())?;
                let client = BackendClient::new(public.api_base_url);
                client.authenticate(&machine_code, &machine_secret).await?;
                client.get_maintenance_identity_status(&machine_code).await
            }
            .await;
            match platform_status {
                Ok(platform) => {
                    if platform.identities.iter().any(|identity| {
                        identity.public_key == pending_public_key && identity.status == "active"
                    }) {
                        match ctx
                            .config_store
                            .promote_maintenance_reclaim(&pending_public_key)
                            .await
                        {
                            Ok(promoted) => status = promoted,
                            Err(error) => status.last_error = Some(error),
                        }
                    } else if let Some(failed) = platform.identities.iter().find(|identity| {
                        identity.public_key == pending_public_key
                            && identity.status == "reclaim_failed"
                    }) {
                        match ctx
                            .config_store
                            .reject_maintenance_reclaim(
                                &pending_public_key,
                                failed
                                    .reclaim_failure_reason
                                    .as_deref()
                                    .unwrap_or("platform rejected pending maintenance identity"),
                            )
                            .await
                        {
                            Ok(recovered) => status = recovered,
                            Err(error) => status.last_error = Some(error),
                        }
                    }
                }
                Err(error) => {
                    status.last_error = Some(format!(
                        "platform maintenance promotion status unavailable: {error}"
                    ));
                }
            }
        }
    }
    status
}

async fn reconcile_maintenance_until_terminal(
    ctx: &IpcContext,
    shutdown: &CancellationToken,
    max_attempts: usize,
    retry_delay: std::time::Duration,
) {
    for _ in 0..max_attempts {
        if shutdown.is_cancelled() {
            break;
        }
        let status = reconcile_maintenance_status(ctx).await;
        if status.pending_public_key.is_none() {
            break;
        }
        tokio::select! {
            _ = shutdown.cancelled() => break,
            _ = tokio::time::sleep(retry_delay) => {}
        }
    }
}

async fn create_order_intent(
    State(ctx): State<IpcContext>,
    headers: HeaderMap,
    Json(input): Json<CreateOrder>,
) -> impl IntoResponse {
    if let Err((status, error)) = require_token(&headers, &ctx.token).await {
        return (status, error).into_response();
    }

    let request_log_data = create_order_request_log_data(&input);
    append_local_diagnostic_log(
        &ctx,
        "info",
        "checkout",
        "create_order_intent_received",
        Some(request_log_data.clone()),
    )
    .await;

    match ctx.ui.transaction.restore_current().await {
        Ok(Some(snapshot)) if crate::transaction::is_active_transaction(&snapshot) => {
            append_local_diagnostic_log(
                &ctx,
                "info",
                "checkout",
                "create_order_intent_resumed_active",
                Some(serde_json::json!({
                    "request": request_log_data.clone(),
                    "orderNo": snapshot.order_no.as_deref(),
                    "nextAction": snapshot.next_action,
                })),
            )
            .await;
            return current_transaction_snapshot_response(&ctx, snapshot).await;
        }
        Ok(_) => {}
        Err(error) => {
            append_local_diagnostic_log(
                &ctx,
                "warn",
                "checkout",
                "create_order_intent_current_transaction_check_failed",
                Some(serde_json::json!({
                    "request": request_log_data.clone(),
                    "message": error,
                })),
            )
            .await;
        }
    }

    let verified_line = match validate_create_order_intent(&ctx, &input).await {
        Ok(line) => line,
        Err(error) => {
            append_local_diagnostic_log(
                &ctx,
                "warn",
                "checkout",
                "create_order_intent_blocked",
                Some(serde_json::json!({
                    "request": request_log_data,
                    "code": "create_order_blocked",
                    "message": error,
                })),
            )
            .await;
            return (
                StatusCode::BAD_REQUEST,
                Json(ErrorMessage {
                    code: "create_order_blocked",
                    message: error,
                }),
            )
                .into_response();
        }
    };

    let items = serde_json::json!({
        "inventoryId": verified_line.inventory_id,
        "quantity": verified_line.quantity,
        "planogramVersion": verified_line.planogram_version,
        "slotId": verified_line.slot_id,
        "slotCode": verified_line.slot_code,
    });

    let payment_provider_code = input
        .payment_provider_code
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);

    match ctx
        .ui
        .transaction
        .create_order(
            &input.payment_method,
            payment_provider_code,
            items,
            sanitize_profile_snapshot(input.profile_snapshot),
        )
        .await
    {
        Ok(snapshot) => {
            append_local_diagnostic_log(
                &ctx,
                "info",
                "checkout",
                "create_order_intent_succeeded",
                Some(serde_json::json!({
                    "request": request_log_data,
                    "orderNo": snapshot.order_no.as_deref(),
                    "paymentMethod": snapshot.payment_method.as_deref(),
                    "paymentProvider": snapshot.payment_provider.as_deref(),
                    "nextAction": snapshot.next_action,
                })),
            )
            .await;
            current_transaction_snapshot_response(&ctx, snapshot).await
        }
        Err(error) => {
            append_local_diagnostic_log(
                &ctx,
                "warn",
                "checkout",
                "create_order_intent_failed",
                Some(serde_json::json!({
                    "request": request_log_data,
                    "code": "create_order_failed",
                    "message": error,
                })),
            )
            .await;
            create_order_error_response(&error).into_response()
        }
    }
}

async fn cancel_order_intent(
    State(ctx): State<IpcContext>,
    headers: HeaderMap,
    Json(input): Json<CancelOrder>,
) -> impl IntoResponse {
    if let Err((status, error)) = require_token(&headers, &ctx.token).await {
        return (status, error).into_response();
    }

    let order_no = input.order_no.trim();
    if order_no.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorMessage {
                code: "cancel_order_failed",
                message: "orderNo is required".to_string(),
            }),
        )
            .into_response();
    }

    append_local_diagnostic_log(
        &ctx,
        "info",
        "checkout",
        "cancel_order_intent_received",
        Some(serde_json::json!({ "orderNo": order_no })),
    )
    .await;

    match ctx.ui.transaction.cancel_order(order_no).await {
        Ok(snapshot) => {
            append_local_diagnostic_log(
                &ctx,
                "info",
                "checkout",
                "cancel_order_intent_succeeded",
                Some(serde_json::json!({
                    "orderNo": snapshot.order_no.as_deref(),
                    "orderStatus": snapshot.order_status.as_deref(),
                    "nextAction": snapshot.next_action,
                })),
            )
            .await;
            current_transaction_snapshot_response(&ctx, snapshot).await
        }
        Err(error) => {
            append_local_diagnostic_log(
                &ctx,
                "warn",
                "checkout",
                "cancel_order_intent_failed",
                Some(serde_json::json!({
                    "orderNo": order_no,
                    "code": "cancel_order_failed",
                    "message": error,
                })),
            )
            .await;
            cancel_order_error_response(&error).into_response()
        }
    }
}

async fn mock_payment_intent(
    State(ctx): State<IpcContext>,
    headers: HeaderMap,
    Json(input): Json<MockPayment>,
) -> impl IntoResponse {
    if let Err((status, error)) = require_token(&headers, &ctx.token).await {
        return (status, error).into_response();
    }

    let order_no = input.order_no.trim();
    if order_no.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorMessage {
                code: "mock_payment_failed",
                message: "orderNo is required".to_string(),
            }),
        )
            .into_response();
    }

    append_local_diagnostic_log(
        &ctx,
        "info",
        "checkout",
        "mock_payment_intent_received",
        Some(serde_json::json!({
            "orderNo": order_no,
            "succeed": input.succeed,
        })),
    )
    .await;

    match ctx
        .ui
        .transaction
        .mark_mock_payment(order_no, input.succeed)
        .await
    {
        Ok(snapshot) => {
            append_local_diagnostic_log(
                &ctx,
                "info",
                "checkout",
                "mock_payment_intent_succeeded",
                Some(serde_json::json!({
                    "orderNo": snapshot.order_no.as_deref(),
                    "orderStatus": snapshot.order_status.as_deref(),
                    "nextAction": snapshot.next_action,
                })),
            )
            .await;
            current_transaction_snapshot_response(&ctx, snapshot).await
        }
        Err(error) => {
            append_local_diagnostic_log(
                &ctx,
                "warn",
                "checkout",
                "mock_payment_intent_failed",
                Some(serde_json::json!({
                    "orderNo": order_no,
                    "succeed": input.succeed,
                    "code": "mock_payment_failed",
                    "message": error,
                })),
            )
            .await;
            (
                StatusCode::BAD_GATEWAY,
                Json(ErrorMessage {
                    code: "mock_payment_failed",
                    message: error,
                }),
            )
                .into_response()
        }
    }
}

fn create_order_request_log_data(input: &CreateOrder) -> serde_json::Value {
    let provider = input
        .payment_provider_code
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    serde_json::json!({
        "inventoryId": input.inventory_id,
        "quantity": input.quantity,
        "planogramVersion": input.planogram_version,
        "slotId": input.slot_id,
        "slotCode": input.slot_code,
        "paymentMethod": input.payment_method,
        "paymentProviderCode": provider,
        "hasPaymentProviderCode": provider.is_some(),
        "hasProfileSnapshot": input.profile_snapshot.is_some(),
    })
}

fn sanitize_profile_snapshot(input: Option<serde_json::Value>) -> Option<serde_json::Value> {
    let value = input?;
    let object = value.as_object()?;
    let mut sanitized = serde_json::Map::new();
    let person_present = object.get("personPresent")?.as_bool()?;
    sanitized.insert(
        "personPresent".to_string(),
        serde_json::Value::Bool(person_present),
    );
    if let Some(value) = object.get("heightCm") {
        if value.is_null()
            || value
                .as_f64()
                .is_some_and(|number| (80.0..=240.0).contains(&number))
        {
            sanitized.insert("heightCm".to_string(), value.clone());
        }
    }
    if let Some(value) = object.get("bodyType").and_then(|value| value.as_str()) {
        if !value.is_empty() && value.len() <= 32 {
            sanitized.insert(
                "bodyType".to_string(),
                serde_json::Value::String(value.to_string()),
            );
        }
    }
    if let Some(value) = object.get("upperColor").and_then(|value| value.as_str()) {
        if !value.is_empty() && value.len() <= 32 {
            sanitized.insert(
                "upperColor".to_string(),
                serde_json::Value::String(value.to_string()),
            );
        }
    }
    if let Some(value) = object.get("confidence") {
        if value
            .as_f64()
            .is_some_and(|number| (0.0..=1.0).contains(&number))
        {
            sanitized.insert("confidence".to_string(), value.clone());
        }
    }
    Some(serde_json::Value::Object(sanitized))
}

async fn append_local_diagnostic_log(
    ctx: &IpcContext,
    level: &str,
    category: &str,
    message: &str,
    data: Option<serde_json::Value>,
) {
    let entry = logs::LocalLogEntry {
        ts: crate::state::store::now_iso(),
        level: level.to_string(),
        category: category.to_string(),
        message: message.to_string(),
        data,
    };
    let path = ctx.data_dir.join("logs").join("machine-events.jsonl");
    if let Err(error) = logs::append_local_log(&path, &entry).await {
        eprintln!("append local diagnostic log failed: {error}");
    }
}

async fn dev_submit_payment_code_intent(
    State(ctx): State<IpcContext>,
    headers: HeaderMap,
    Json(input): Json<SubmitPayment>,
) -> impl IntoResponse {
    if let Err((status, error)) = require_token(&headers, &ctx.token).await {
        return (status, error).into_response();
    }

    if !matches!(input.source.as_str(), "manual_dev" | "browser_test") {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorMessage {
                code: "invalid_source",
                message: "source must be manual_dev or browser_test".to_string(),
            }),
        )
            .into_response();
    }

    let current = match ctx.ui.transaction.restore_current().await {
        Ok(Some(snapshot)) => snapshot,
        Ok(None) => {
            return (
                StatusCode::CONFLICT,
                Json(ErrorMessage {
                    code: "transaction_missing",
                    message: "no active transaction".to_string(),
                }),
            )
                .into_response();
        }
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorMessage {
                    code: "transaction_read_failed",
                    message: error,
                }),
            )
                .into_response();
        }
    };
    if current.order_no.as_deref() != Some(input.order_no.as_str()) {
        return (
            StatusCode::CONFLICT,
            Json(ErrorMessage {
                code: "transaction_mismatch",
                message: "input order does not match current transaction".to_string(),
            }),
        )
            .into_response();
    }

    let auth_code = input.auth_code;
    let code = vending_core::scanner::RawPaymentCode {
        auth_code: auth_code.clone(),
        masked_code: vending_core::scanner::mask_code(&auth_code),
        scanned_at_ms: crate::state::store::now_millis(),
    };

    if let Err(error) = ctx
        .ui
        .transaction
        .submit_payment_code(code, &input.source, None)
        .await
    {
        append_local_diagnostic_log(
            &ctx,
            "warn",
            "checkout",
            "submit_payment_code_intent_failed",
            Some(serde_json::json!({
                "orderNo": input.order_no,
                "source": input.source,
                "code": "submit_payment_code_failed",
                "message": error,
            })),
        )
        .await;
        let message = if error.starts_with("MACHINE_NOT_READY_FOR_PAYMENT_CODE:")
            || error.to_ascii_lowercase().contains("scanner")
            || error.contains("扫码器")
        {
            PAYMENT_CODE_SCANNER_UNAVAILABLE_CUSTOMER_MESSAGE.to_string()
        } else {
            error.to_string()
        };
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorMessage {
                code: "submit_payment_code_failed",
                message,
            }),
        )
            .into_response();
    }

    match ctx.ui.transaction.restore_current().await {
        Ok(Some(snapshot)) => current_transaction_snapshot_response(&ctx, snapshot).await,
        Ok(None) => {
            current_transaction_snapshot_response(&ctx, empty_current_transaction_snapshot()).await
        }
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorMessage {
                code: "transaction_read_failed",
                message: error,
            }),
        )
            .into_response(),
    }
}

async fn current_transaction(
    State(ctx): State<IpcContext>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if let Err((status, error)) = require_token(&headers, &ctx.token).await {
        return (status, error).into_response();
    }
    match ctx.ui.transaction.restore_current().await {
        Ok(Some(snapshot)) => current_transaction_snapshot_response(&ctx, snapshot).await,
        Ok(None) => {
            current_transaction_snapshot_response(&ctx, empty_current_transaction_snapshot()).await
        }
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorMessage {
                code: "transaction_read_failed",
                message: error.to_string(),
            }),
        )
            .into_response(),
    }
}

async fn transaction_by_order_no(
    State(ctx): State<IpcContext>,
    headers: HeaderMap,
    AxumPath(_order_no): AxumPath<String>,
) -> impl IntoResponse {
    current_transaction(State(ctx), headers).await
}

async fn catalog_snapshot(State(ctx): State<IpcContext>, headers: HeaderMap) -> impl IntoResponse {
    if let Err((status, error)) = require_token(&headers, &ctx.token).await {
        return (status, error).into_response();
    }

    let snapshot = ctx.ui.status_cache.catalog.read().await.clone();
    (StatusCode::OK, Json(snapshot)).into_response()
}

async fn refresh_catalog(State(ctx): State<IpcContext>, headers: HeaderMap) -> impl IntoResponse {
    if let Err((status, error)) = require_token(&headers, &ctx.token).await {
        return (status, error).into_response();
    }

    let config = match ctx.config_store.load_effective_public_config().await {
        Ok(config) => config,
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorMessage {
                    code: "config_load_failed",
                    message: error,
                }),
            )
                .into_response();
        }
    };
    let machine_code = match config.machine_code {
        Some(machine_code) => machine_code,
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(ErrorMessage {
                    code: "machine_code_missing",
                    message: "machine code required for catalog refresh".to_string(),
                }),
            )
                .into_response();
        }
    };

    let now = crate::state::store::now_iso();
    let response = match ctx.ui.backend.get_catalog(&machine_code).await {
        Ok(catalog) => {
            let source = catalog
                .get("source")
                .and_then(|value| value.as_str())
                .unwrap_or("backend")
                .to_string();
            let items = catalog
                .get("items")
                .and_then(|value| value.as_array())
                .cloned()
                .unwrap_or_else(|| {
                    if let Some(items) = catalog.as_array() {
                        items.to_vec()
                    } else {
                        Vec::new()
                    }
                });

            let mut catalog = ctx.ui.status_cache.catalog.write().await;
            catalog.items = items;
            catalog.cached = true;
            catalog.last_updated_at = Some(now);
            catalog.source = source;
            catalog.last_error = None;
            (StatusCode::OK, Json(catalog.clone())).into_response()
        }
        Err(error) => {
            let mut catalog = ctx.ui.status_cache.catalog.write().await;
            catalog.last_error = Some(error);
            (StatusCode::OK, Json(catalog.clone())).into_response()
        }
    };

    response
}

async fn sale_view(State(ctx): State<IpcContext>, headers: HeaderMap) -> impl IntoResponse {
    if let Err((status, error)) = require_token(&headers, &ctx.token).await {
        return (status, error).into_response();
    }

    let machine_code = ctx
        .config_store
        .load_effective_public_config()
        .await
        .ok()
        .and_then(|config| config.machine_code);
    match ctx.state.sale_view(machine_code).await {
        Ok(snapshot) => (StatusCode::OK, Json(snapshot)).into_response(),
        Err(error) => store_error_response("sale_view_read_failed", error),
    }
}

async fn sale_readiness(State(ctx): State<IpcContext>, headers: HeaderMap) -> impl IntoResponse {
    if let Err((status, error)) = require_token(&headers, &ctx.token).await {
        return (status, error).into_response();
    }

    match machine_sale_readiness_snapshot(&ctx).await {
        Ok(snapshot) => (StatusCode::OK, Json(snapshot)).into_response(),
        Err(error) => store_error_response("sale_readiness_read_failed", error),
    }
}

async fn require_hardware_slot_topology_for_planogram(
    ctx: &IpcContext,
) -> Result<(), axum::response::Response> {
    let readiness = ctx
        .config_store
        .hardware_slot_topology_readiness()
        .await
        .map_err(|error| {
            (
                StatusCode::CONFLICT,
                Json(ErrorMessage {
                    code: "hardware_slot_topology_check_failed",
                    message: error,
                }),
            )
                .into_response()
        })?;
    if readiness.ready {
        return Ok(());
    }
    Err((
        StatusCode::CONFLICT,
        Json(ErrorMessage {
            code: "hardware_slot_topology_mismatch",
            message: readiness.message,
        }),
    )
        .into_response())
}

pub(crate) async fn machine_sale_readiness_snapshot(
    ctx: &IpcContext,
) -> Result<serde_json::Value, StoreError> {
    let public = ctx.config_store.load_effective_public_config().await.ok();
    let machine_code = public
        .as_ref()
        .and_then(|config| config.machine_code.clone())
        .filter(|code| !code.trim().is_empty());
    let machine_auth_ready = machine_code.is_some();

    let sale_view = ctx.state.sale_view(machine_code).await?;
    let active_planogram_ready = sale_view.planogram_version.is_some();
    let saleable_slot_available = sale_view
        .items
        .iter()
        .any(|item| item.slot_sales_state == "sale_ready" && item.saleable_stock > 0);
    let slot_sale_blocked_slots: Vec<serde_json::Value> = sale_view
        .items
        .iter()
        .filter(|item| is_slot_sale_safety_blocker(&item.slot_sales_state))
        .map(|item| {
            serde_json::json!({
                "slotId": item.slot_id,
                "slotCode": item.slot_code,
                "slotSalesState": item.slot_sales_state,
            })
        })
        .collect();
    let slot_sale_safety_ready = !active_planogram_ready || saleable_slot_available;

    let outbox_size = ctx.state.outbox_size().await.unwrap_or_default() as usize;
    let sync = ctx.ui.status_cache.sync.read().await.clone();
    let outbox_max = sync.outbox_max.max(1);
    let outbox_usage = outbox_size as f64 / outbox_max as f64;
    let disk_pressure = disk_pressure_snapshot(ctx);
    let sync_ready =
        sync.mqtt_running && sync.mqtt_connected && outbox_usage < 0.9 && !disk_pressure.pressured;

    let hardware = ctx.ui.status_cache.hardware.read().await.clone();
    let production_dispense_path = production_dispense_path_readiness(public.as_ref());
    let hardware_slot_topology = ctx
        .config_store
        .hardware_slot_topology_readiness()
        .await
        .unwrap_or_else(|error| crate::config::HardwareSlotTopologyReadiness {
            ready: false,
            code: "HARDWARE_SLOT_TOPOLOGY_CHECK_FAILED".to_string(),
            message: error,
            local: None,
            platform: None,
        });
    let physical_stock_attestation = ctx.state.physical_stock_attestation_status().await?;
    let physical_stock_attestation_ready = physical_stock_attestation.status == "ready";
    let physical_stock_attestation_required = production_dispense_path.ready;
    let whole_machine_lock = ctx.state.whole_machine_maintenance_lock().await?;
    let whole_machine_ready = hardware.online && whole_machine_lock.is_none();
    let whole_machine_code = if !hardware.online {
        "LOWER_CONTROLLER_UNAVAILABLE".to_string()
    } else if let Some(lock) = whole_machine_lock.as_ref() {
        lock.code.clone()
    } else {
        "WHOLE_MACHINE_READY".to_string()
    };
    let whole_machine_message = if !hardware.online {
        hardware.message.clone()
    } else if let Some(lock) = whole_machine_lock.as_ref() {
        format!(
            "{}；订单 {}，货道 {}",
            lock.message, lock.order_no, lock.slot_code
        )
    } else {
        hardware.message.clone()
    };

    let scanner = ctx.ui.status_cache.scanner.read().await.clone();
    let scanner_readiness = scanner_payment_code_readiness(&scanner);
    let scanner_ready = scanner_readiness.ready;

    let payment_capability = load_machine_payment_capability(ctx).await;
    let payment_probe = ctx.ui.backend.get_payment_options().await;
    let platform_ready = payment_probe.is_ok();
    let mut payment_methods = Vec::new();
    let mut payment_options_error = None;
    if let Ok(payload) = payment_probe.as_ref() {
        match strict_payment_options(payload) {
            Ok(options) => {
                for option in options {
                    if !payment_method_allowed_by_capability(&option.method, &payment_capability) {
                        continue;
                    }
                    let mut ready = !option.disabled;
                    let mut disabled_reason = option.disabled_reason;
                    if option.method == "payment_code" && !scanner_ready {
                        ready = false;
                        disabled_reason = Some(scanner_readiness.message.clone());
                    }
                    payment_methods.push(serde_json::json!({
                        "method": option.method,
                        "optionKey": option.option_key,
                        "providerCode": option.provider_code,
                        "ready": ready,
                        "disabledReason": disabled_reason,
                    }));
                }
            }
            Err(error) => {
                payment_options_error = Some(error);
            }
        }
    }
    let payment_options_ready = payment_methods.iter().any(|method| {
        method
            .get("ready")
            .and_then(|value| value.as_bool())
            .unwrap_or(false)
    });

    let mut blocking_codes = Vec::new();
    if !platform_ready {
        blocking_codes.push("PLATFORM_UNREACHABLE");
    }
    if !machine_auth_ready {
        blocking_codes.push("MACHINE_AUTH_MISSING");
    }
    if !active_planogram_ready {
        blocking_codes.push("ACTIVE_PLANOGRAM_MISSING");
    }
    if !payment_options_ready {
        blocking_codes.push("NO_PAYMENT_OPTIONS");
    }
    if !sync_ready {
        blocking_codes.push("SYNC_UNHEALTHY");
    }
    if !hardware.online {
        blocking_codes.push("LOWER_CONTROLLER_UNAVAILABLE");
    }
    if !production_dispense_path.ready {
        blocking_codes.push(production_dispense_path.code);
    }
    if !hardware_slot_topology.ready {
        blocking_codes.push(hardware_slot_topology.code.as_str());
    }
    if physical_stock_attestation_required && !physical_stock_attestation_ready {
        blocking_codes.push(physical_stock_attestation.code.as_str());
    }
    if let Some(lock) = whole_machine_lock.as_ref() {
        blocking_codes.push(lock.code.as_str());
    }
    if !slot_sale_safety_ready {
        blocking_codes.push("NO_SALEABLE_SLOTS");
    }
    let can_start_network_authorized_sale = platform_ready
        && machine_auth_ready
        && active_planogram_ready
        && payment_options_ready
        && sync_ready
        && whole_machine_ready
        && production_dispense_path.ready
        && hardware_slot_topology.ready
        && (!physical_stock_attestation_required || physical_stock_attestation_ready)
        && slot_sale_safety_ready;

    Ok(serde_json::json!({
        "canStartNetworkAuthorizedSale": can_start_network_authorized_sale,
        "blockingCodes": blocking_codes,
        "components": {
            "platformReachability": readiness_component(
                platform_ready,
                if platform_ready { "PLATFORM_REACHABLE" } else { "PLATFORM_UNREACHABLE" },
                payment_probe.err().unwrap_or_else(|| "platform reachable".to_string()),
            ),
            "machineAuthentication": readiness_component(
                machine_auth_ready,
                if machine_auth_ready { "MACHINE_AUTH_READY" } else { "MACHINE_AUTH_MISSING" },
                if machine_auth_ready { "machine code configured" } else { "machine code missing" },
            ),
            "activePlanogram": readiness_component(
                active_planogram_ready,
                if active_planogram_ready { "ACTIVE_PLANOGRAM_READY" } else { "ACTIVE_PLANOGRAM_MISSING" },
                sale_view
                    .planogram_version
                    .clone()
                    .unwrap_or_else(|| "active planogram missing".to_string()),
            ),
            "paymentOptions": serde_json::json!({
                "ready": payment_options_ready,
                "code": if payment_options_ready { "PAYMENT_OPTIONS_READY" } else { "NO_PAYMENT_OPTIONS" },
                "message": if payment_options_ready { "payment option available".to_string() } else { payment_options_error.unwrap_or_else(|| "no ready payment option".to_string()) },
                "methods": payment_methods,
            }),
            "scannerCapability": readiness_component(
                scanner_ready,
                scanner_readiness.code.as_str(),
                scanner_readiness.message,
            ),
            "syncHealth": readiness_component(
                sync_ready,
                if sync_ready { "SYNC_READY" } else { "SYNC_UNHEALTHY" },
                sync.last_error.unwrap_or_else(|| {
                    if outbox_usage >= 0.9 {
                        format!(
                            "sync outbox capacity pressure: {outbox_size}/{outbox_max} pending events"
                        )
                    } else if disk_pressure.pressured {
                        disk_pressure.message
                    } else if sync.mqtt_connected {
                        "sync connected".to_string()
                    } else {
                        "sync transport is not connected".to_string()
                    }
                }),
            ),
            "wholeMachineBlockers": readiness_component(
                whole_machine_ready,
                whole_machine_code.as_str(),
                whole_machine_message,
            ),
            "productionDispensePath": readiness_component(
                production_dispense_path.ready,
                production_dispense_path.code,
                production_dispense_path.message,
            ),
            "hardwareSlotTopology": serde_json::json!({
                "ready": hardware_slot_topology.ready,
                "code": hardware_slot_topology.code,
                "message": hardware_slot_topology.message,
                "local": hardware_slot_topology.local,
                "platform": hardware_slot_topology.platform,
            }),
            "physicalStockAttestation": serde_json::json!({
                "ready": physical_stock_attestation_ready,
                "required": physical_stock_attestation_required,
                "status": physical_stock_attestation.status,
                "code": physical_stock_attestation.code,
                "message": physical_stock_attestation.message,
                "attestationId": physical_stock_attestation.attestation_id,
                "planogramVersion": physical_stock_attestation.planogram_version,
                "attestedAt": physical_stock_attestation.attested_at,
                "inconsistentSlots": physical_stock_attestation.inconsistent_slots,
            }),
            "slotSaleSafety": serde_json::json!({
                "ready": slot_sale_safety_ready,
                "code": if slot_sale_safety_ready { "SLOT_SALE_SAFETY_READY" } else { "NO_SALEABLE_SLOTS" },
                "message": if slot_sale_safety_ready {
                    if slot_sale_blocked_slots.is_empty() {
                        "slot sale safety ready".to_string()
                    } else {
                        format!("{} slot(s) locked; other slots available", slot_sale_blocked_slots.len())
                    }
                } else if slot_sale_blocked_slots.is_empty() {
                    "no saleable slots".to_string()
                } else {
                    format!("{} slot(s) blocked by sale safety", slot_sale_blocked_slots.len())
                },
                "blockedSlots": slot_sale_blocked_slots,
            }),
        },
    }))
}

struct ProductionDispensePathReadiness {
    ready: bool,
    code: &'static str,
    message: &'static str,
}

fn production_dispense_path_readiness(
    public: Option<&crate::config::MachinePublicConfig>,
) -> ProductionDispensePathReadiness {
    let Some(public) = public else {
        return ProductionDispensePathReadiness {
            ready: false,
            code: "PRODUCTION_DISPENSE_PATH_EVIDENCE_MISSING",
            message: "生产出货路径缺少 production hardwareProfile 证据",
        };
    };
    let Some(hardware_profile) = public.hardware_profile.as_ref() else {
        return ProductionDispensePathReadiness {
            ready: false,
            code: "PRODUCTION_DISPENSE_PATH_EVIDENCE_MISSING",
            message: "生产出货路径缺少 production hardwareProfile 证据",
        };
    };
    if hardware_profile.profile != "production" {
        return ProductionDispensePathReadiness {
            ready: false,
            code: "PRODUCTION_DISPENSE_PATH_EVIDENCE_MISSING",
            message: "生产出货路径 hardwareProfile 不是 production",
        };
    }
    if matches!(
        public.hardware_adapter,
        crate::config::HardwareAdapterKind::Mock
    ) {
        return ProductionDispensePathReadiness {
            ready: false,
            code: "PRODUCTION_DISPENSE_PATH_MOCK",
            message: "生产出货路径不能使用 mock hardwareAdapter",
        };
    }
    if public
        .serial_port_path
        .as_deref()
        .map(|path| path.trim_start().starts_with("tcp://"))
        .unwrap_or(false)
    {
        return ProductionDispensePathReadiness {
            ready: false,
            code: "PRODUCTION_DISPENSE_PATH_TCP_SIMULATOR",
            message: "生产出货路径不能使用 tcp:// lower-controller simulator",
        };
    }
    ProductionDispensePathReadiness {
        ready: true,
        code: "PRODUCTION_DISPENSE_PATH_READY",
        message: "production dispense path ready",
    }
}

fn is_slot_sale_safety_blocker(slot_sales_state: &str) -> bool {
    matches!(
        slot_sales_state,
        "suspect"
            | "frozen"
            | "needs_count"
            | "blocked_for_planogram_change"
            | "movement_rejected"
            | "needs_platform_review"
    )
}

fn readiness_component(ready: bool, code: &str, message: impl Into<String>) -> serde_json::Value {
    serde_json::json!({
        "ready": ready,
        "code": code,
        "message": message.into(),
    })
}

struct ScannerPaymentCodeReadiness {
    ready: bool,
    code: String,
    message: String,
}

fn scanner_payment_code_readiness(
    scanner: &vending_core::scanner::ScannerHealthSnapshot,
) -> ScannerPaymentCodeReadiness {
    let base_ready = scanner.online
        && scanner.adapter == vending_core::scanner::PAYMENT_CODE_SOURCE_SERIAL_TEXT
        && scanner.code == "SCANNER_READY";
    if !base_ready {
        return ScannerPaymentCodeReadiness {
            ready: false,
            code: "SCANNER_UNAVAILABLE".to_string(),
            message: PAYMENT_CODE_SCANNER_UNAVAILABLE_CUSTOMER_MESSAGE.to_string(),
        };
    }

    let parsed = chrono::DateTime::parse_from_rfc3339(&scanner.updated_at);
    let Ok(updated_at) = parsed else {
        return ScannerPaymentCodeReadiness {
            ready: false,
            code: "SCANNER_STATUS_STALE".to_string(),
            message: "扫码器状态异常，请选择其他支付方式".to_string(),
        };
    };
    let age = chrono::Utc::now().signed_duration_since(updated_at.with_timezone(&chrono::Utc));
    if age > chrono::Duration::seconds(SCANNER_READY_STALE_AFTER_SECONDS) {
        return ScannerPaymentCodeReadiness {
            ready: false,
            code: "SCANNER_STATUS_STALE".to_string(),
            message: "扫码器状态已过期，请选择其他支付方式".to_string(),
        };
    }

    ScannerPaymentCodeReadiness {
        ready: true,
        code: "SCANNER_READY".to_string(),
        message: scanner.message.clone(),
    }
}

pub(crate) fn local_payment_code_submit_guard(
    status_cache: RuntimeStatusCache,
    state: LocalStateStore,
) -> crate::transaction::PaymentCodeSubmitGuard {
    Arc::new(move || {
        let status_cache = status_cache.clone();
        let state = state.clone();
        Box::pin(async move {
            let hardware = status_cache.hardware.read().await.clone();
            if !hardware.online {
                return Err(format!(
                    "MACHINE_NOT_READY_FOR_PAYMENT_CODE: {}",
                    hardware.message
                ));
            }
            if let Some(lock) = state
                .whole_machine_maintenance_lock()
                .await
                .map_err(|error| error.to_string())?
            {
                return Err(format!(
                    "MACHINE_NOT_READY_FOR_PAYMENT_CODE: {}",
                    lock.message
                ));
            }

            let scanner = status_cache.scanner.read().await.clone();
            let scanner_readiness = scanner_payment_code_readiness(&scanner);
            if !scanner_readiness.ready {
                return Err(scanner_readiness.message);
            }

            Ok(())
        })
    })
}

fn is_supported_payment_method(value: &str) -> bool {
    matches!(value, "mock" | "qr_code" | "payment_code")
}

fn is_supported_payment_provider(value: &str) -> bool {
    matches!(value, "mock" | "wechat_pay" | "alipay")
}

fn default_production_payment_capability() -> ProductionMachinePaymentCapability {
    ProductionMachinePaymentCapability {
        profile: "production".to_string(),
        qr_code_enabled: true,
        payment_code_enabled: true,
        server_time: crate::state::store::now_iso(),
        options: vec![],
        default_option_key: None,
        default_provider_code: None,
    }
}

async fn load_machine_payment_capability(ctx: &IpcContext) -> ProductionMachinePaymentCapability {
    ctx.config_store
        .load_effective_public_config()
        .await
        .ok()
        .and_then(|config| config.payment_capability)
        .unwrap_or_else(default_production_payment_capability)
}

fn payment_method_allowed_by_capability(
    method: &str,
    capability: &ProductionMachinePaymentCapability,
) -> bool {
    match method {
        "qr_code" => capability.qr_code_enabled,
        "payment_code" => capability.payment_code_enabled,
        // Mock remains backend/test-environment governed; production capability never enables it.
        "mock" => true,
        _ => false,
    }
}

fn strict_payment_options(
    payload: &serde_json::Value,
) -> Result<Vec<BackendPaymentOption>, String> {
    let response: BackendPaymentOptionsResponse = serde_json::from_value(payload.clone())
        .map_err(|error| format!("payment options schema invalid: {error}"))?;
    if response.server_time.trim().is_empty() {
        return Err("payment options serverTime is required".to_string());
    }
    if let Some(default_option_key) = response.default_option_key.as_deref() {
        if default_option_key.trim().is_empty() {
            return Err("payment options defaultOptionKey must be non-empty or null".to_string());
        }
    }
    if let Some(default_provider_code) = response.default_provider_code.as_deref() {
        if !is_supported_payment_provider(default_provider_code) {
            return Err("payment options defaultProviderCode is unsupported".to_string());
        }
    }
    for option in &response.options {
        if option.option_key.trim().is_empty()
            || option.provider_code.trim().is_empty()
            || option.method.trim().is_empty()
            || option.display_name.trim().is_empty()
            || option.description.trim().is_empty()
        {
            return Err("payment option required fields must be non-empty".to_string());
        }
        if !is_supported_payment_method(&option.method) {
            return Err(format!("unsupported payment method {}", option.method));
        }
        if !is_supported_payment_provider(&option.provider_code) {
            return Err(format!(
                "unsupported payment provider {}",
                option.provider_code
            ));
        }
        if !matches!(option.icon.as_str(), "mock" | "wechat" | "alipay") {
            return Err(format!("unsupported payment icon {}", option.icon));
        }
        if option.recommended && option.disabled {
            // Recommended but disabled is legal in shared schema; keep the read so this field stays
            // part of strict parsing without changing readiness semantics.
        }
    }
    Ok(response.options)
}

fn validate_selected_payment_option(
    readiness: &serde_json::Value,
    input: &CreateOrder,
) -> Result<(), String> {
    let selected_provider = input
        .payment_provider_code
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());

    if matches!(input.payment_method.as_str(), "qr_code" | "payment_code")
        && selected_provider.is_none()
    {
        return Err(format!(
            "selected payment provider is required for {}",
            input.payment_method
        ));
    }

    let methods = readiness
        .get("components")
        .and_then(|value| value.get("paymentOptions"))
        .and_then(|value| value.get("methods"))
        .and_then(|value| value.as_array())
        .ok_or_else(|| "payment options are unavailable".to_string())?;

    let mut method_seen = false;
    let mut provider_seen = false;
    let mut not_ready_reason = None;

    for method in methods {
        if method.get("method").and_then(|value| value.as_str())
            != Some(input.payment_method.as_str())
        {
            continue;
        }
        method_seen = true;

        if let Some(provider) = selected_provider {
            if method.get("providerCode").and_then(|value| value.as_str()) != Some(provider) {
                continue;
            }
            provider_seen = true;
        }

        if method
            .get("ready")
            .and_then(|value| value.as_bool())
            .unwrap_or(false)
        {
            return Ok(());
        }

        if not_ready_reason.is_none() {
            not_ready_reason = method
                .get("disabledReason")
                .and_then(|value| value.as_str())
                .filter(|value| !value.trim().is_empty())
                .map(ToString::to_string);
        }
    }

    if !method_seen {
        if input.payment_method == "payment_code" {
            return Err(PAYMENT_CODE_SCANNER_UNAVAILABLE_CUSTOMER_MESSAGE.to_string());
        }
        return Err(format!(
            "selected payment method {} is unavailable",
            input.payment_method
        ));
    }
    if let Some(provider) = selected_provider {
        if !provider_seen {
            if input.payment_method == "payment_code" {
                return Err(PAYMENT_CODE_SCANNER_UNAVAILABLE_CUSTOMER_MESSAGE.to_string());
            }
            return Err(format!(
                "selected payment provider {provider} is unavailable for {}",
                input.payment_method
            ));
        }
    }

    if input.payment_method == "payment_code" {
        return Err(PAYMENT_CODE_SCANNER_UNAVAILABLE_CUSTOMER_MESSAGE.to_string());
    }

    Err(not_ready_reason.unwrap_or_else(|| "selected payment option is not ready".to_string()))
}

async fn validate_create_order_intent(
    ctx: &IpcContext,
    input: &CreateOrder,
) -> Result<VerifiedCreateOrderLine, String> {
    if input.quantity != 1 {
        return Err("quantity must be exactly 1 for lower controller protocol v1".to_string());
    }

    let readiness = machine_sale_readiness_snapshot(ctx)
        .await
        .map_err(|error| error.to_string())?;
    let can_start = readiness
        .get("canStartNetworkAuthorizedSale")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    if !can_start {
        let blocking_codes = readiness
            .get("blockingCodes")
            .and_then(|value| value.as_array())
            .map(|codes| {
                codes
                    .iter()
                    .filter_map(|code| code.as_str())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let only_slot_saleability_blocked = blocking_codes == vec!["NO_SALEABLE_SLOTS"];
        if !only_slot_saleability_blocked {
            let codes = if blocking_codes.is_empty() {
                "UNKNOWN_READINESS_BLOCKER".to_string()
            } else {
                blocking_codes.join(",")
            };
            return Err(format!("machine is not ready for network sale: {codes}"));
        }
    }
    validate_selected_payment_option(&readiness, input)?;

    let machine_code = ctx
        .config_store
        .load_effective_public_config()
        .await
        .ok()
        .and_then(|config| config.machine_code);
    let sale_view = ctx
        .state
        .sale_view(machine_code)
        .await
        .map_err(|error| error.to_string())?;
    let active_planogram = sale_view
        .planogram_version
        .as_deref()
        .ok_or_else(|| "active planogram is required".to_string())?;
    if active_planogram != input.planogram_version {
        return Err(format!(
            "selected planogram {} does not match active planogram {}",
            input.planogram_version, active_planogram
        ));
    }

    let item = sale_view
        .items
        .iter()
        .find(|item| {
            item.inventory_id == input.inventory_id
                && item.slot_id == input.slot_id
                && item.slot_code == input.slot_code
        })
        .ok_or_else(|| "selected order line is not in the active sale view".to_string())?;
    if item.slot_sales_state != "sale_ready" {
        return Err(format!(
            "selected slot {} is {}",
            item.slot_code, item.slot_sales_state
        ));
    }
    if item.saleable_stock < i64::from(input.quantity) {
        return Err(format!(
            "selected slot {} has insufficient saleable stock",
            item.slot_code
        ));
    }

    Ok(VerifiedCreateOrderLine {
        inventory_id: item.inventory_id.clone(),
        quantity: input.quantity,
        planogram_version: active_planogram.to_string(),
        slot_id: item.slot_id.clone(),
        slot_code: item.slot_code.clone(),
    })
}

async fn sync_planogram(State(ctx): State<IpcContext>, headers: HeaderMap) -> impl IntoResponse {
    if let Err((status, error)) = require_token(&headers, &ctx.token).await {
        return (status, error).into_response();
    }

    let config = match ctx.config_store.load_effective_public_config().await {
        Ok(config) => config,
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorMessage {
                    code: "config_load_failed",
                    message: error,
                }),
            )
                .into_response();
        }
    };
    let Some(machine_code) = config.machine_code else {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorMessage {
                code: "machine_code_missing",
                message: "machine code required for planogram sync".to_string(),
            }),
        )
            .into_response();
    };

    let published = match ctx.ui.backend.get_published_planogram(&machine_code).await {
        Ok(value) => value,
        Err(error) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(ErrorMessage {
                    code: "planogram_fetch_failed",
                    message: error,
                }),
            )
                .into_response();
        }
    };
    if published.is_null() {
        return match ctx.state.sale_view(Some(machine_code)).await {
            Ok(snapshot) => (StatusCode::OK, Json(snapshot)).into_response(),
            Err(error) => store_error_response("sale_view_read_failed", error),
        };
    }

    let Some(planogram_version) = published
        .get("planogramVersion")
        .and_then(|value| value.as_str())
        .map(str::to_string)
    else {
        return (
            StatusCode::BAD_GATEWAY,
            Json(ErrorMessage {
                code: "planogram_payload_invalid",
                message: "published planogram response missing planogramVersion".to_string(),
            }),
        )
            .into_response();
    };
    let slots = match published.get("slots").cloned() {
        Some(value) => match serde_json::from_value::<Vec<MachinePlanogramSlotInput>>(value) {
            Ok(slots) => slots,
            Err(error) => {
                return (
                    StatusCode::BAD_GATEWAY,
                    Json(ErrorMessage {
                        code: "planogram_payload_invalid",
                        message: error.to_string(),
                    }),
                )
                    .into_response();
            }
        },
        None => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(ErrorMessage {
                    code: "planogram_payload_invalid",
                    message: "published planogram response missing slots".to_string(),
                }),
            )
                .into_response();
        }
    };

    let input = MachinePlanogramInput {
        planogram_version: planogram_version.clone(),
        source: "platform".to_string(),
        applied_by: None,
        slots,
    };
    if let Err(response) = require_hardware_slot_topology_for_planogram(&ctx).await {
        return response;
    }
    let snapshot = match ctx.state.apply_planogram(input).await {
        Ok(snapshot) => snapshot,
        Err(error) => return store_error_response("planogram_apply_failed", error),
    };

    if let Err(error) = ctx
        .ui
        .backend
        .acknowledge_planogram(&machine_code, &planogram_version)
        .await
    {
        return (
            StatusCode::BAD_GATEWAY,
            Json(ErrorMessage {
                code: "planogram_ack_failed",
                message: error,
            }),
        )
            .into_response();
    }

    (StatusCode::OK, Json(snapshot)).into_response()
}

async fn apply_planogram(
    State(ctx): State<IpcContext>,
    headers: HeaderMap,
    Json(input): Json<MachinePlanogramInput>,
) -> impl IntoResponse {
    if let Err((status, error)) = require_token(&headers, &ctx.token).await {
        return (status, error).into_response();
    }

    if let Err(response) = require_hardware_slot_topology_for_planogram(&ctx).await {
        return response;
    }

    match ctx.state.apply_planogram(input).await {
        Ok(snapshot) => (StatusCode::OK, Json(snapshot)).into_response(),
        Err(error) => store_error_response("planogram_apply_failed", error),
    }
}

async fn record_physical_stock_attestation(
    State(ctx): State<IpcContext>,
    headers: HeaderMap,
    Json(_input): Json<PhysicalStockAttestationInput>,
) -> impl IntoResponse {
    if let Err((status, error)) = require_token(&headers, &ctx.token).await {
        return (status, error).into_response();
    }
    if let Err(response) = require_non_bring_up_maintenance_authorization(&ctx, &headers).await {
        return response;
    }
    let _execution_guard = ctx.bring_up_execution_lock.lock().await;
    if let Err(response) =
        require_legacy_bring_up_task(&ctx, crate::bring_up::BringUpTaskKind::AttestStock).await
    {
        return response;
    }
    record_physical_stock_attestation_mutation(State(ctx.clone()), headers, Json(_input))
        .await
        .into_response()
}

async fn record_physical_stock_attestation_mutation(
    State(ctx): State<IpcContext>,
    headers: HeaderMap,
    Json(input): Json<PhysicalStockAttestationInput>,
) -> impl IntoResponse {
    if let Err((status, error)) = require_token(&headers, &ctx.token).await {
        return (status, error).into_response();
    }

    let config = match ctx.config_store.load_effective_public_config().await {
        Ok(config) => config,
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorMessage {
                    code: "config_load_failed",
                    message: error,
                }),
            )
                .into_response();
        }
    };
    let Some(machine_code) = config.machine_code.as_deref() else {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorMessage {
                code: "machine_code_missing",
                message: "machine code required for physical stock attestation upload".to_string(),
            }),
        )
            .into_response();
    };

    match ctx
        .state
        .record_physical_stock_attestation_with_upload(
            input,
            Some(machine_code),
            Some(&config.api_base_url),
        )
        .await
    {
        Ok(snapshot) => (StatusCode::CREATED, Json(snapshot)).into_response(),
        Err(error) => store_error_response("physical_stock_attestation_failed", error),
    }
}

async fn record_stock_movement(
    State(ctx): State<IpcContext>,
    headers: HeaderMap,
    Json(input): Json<StockMovementInput>,
) -> impl IntoResponse {
    if let Err((status, error)) = require_token(&headers, &ctx.token).await {
        return (status, error).into_response();
    }

    let config = match ctx.config_store.load_effective_public_config().await {
        Ok(config) => config,
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorMessage {
                    code: "config_load_failed",
                    message: error,
                }),
            )
                .into_response();
        }
    };
    let Some(machine_code) = config.machine_code.as_deref() else {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorMessage {
                code: "machine_code_missing",
                message: "machine code required for stock movement upload".to_string(),
            }),
        )
            .into_response();
    };

    match ctx
        .state
        .record_stock_movement_with_upload(input, Some(machine_code), Some(&config.api_base_url))
        .await
    {
        Ok(snapshot) => (StatusCode::CREATED, Json(snapshot)).into_response(),
        Err(error) => store_error_response("stock_movement_record_failed", error),
    }
}

async fn dispense_confirmation(
    State(ctx): State<IpcContext>,
    headers: HeaderMap,
    Query(query): Query<DispenseConfirmationQuery>,
) -> impl IntoResponse {
    if let Err((status, error)) = require_token(&headers, &ctx.token).await {
        return (status, error).into_response();
    }
    if query.order_id.trim().is_empty() || query.vending_command_id.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorMessage {
                code: "dispense_confirmation_query_invalid",
                message: "orderId and vendingCommandId are required".to_string(),
            }),
        )
            .into_response();
    }

    match ctx
        .ui
        .backend
        .get_dispense_confirmation(&query.order_id, &query.vending_command_id)
        .await
    {
        Ok(confirmation) => (StatusCode::OK, Json(confirmation)).into_response(),
        Err(_) => (
            StatusCode::BAD_GATEWAY,
            Json(ErrorMessage {
                code: "dispense_confirmation_unavailable",
                message: "dispense confirmation is unavailable".to_string(),
            }),
        )
            .into_response(),
    }
}

async fn update_slot_sales_state(
    State(ctx): State<IpcContext>,
    headers: HeaderMap,
    Json(input): Json<SlotSalesStateInput>,
) -> impl IntoResponse {
    if let Err((status, error)) = require_token(&headers, &ctx.token).await {
        return (status, error).into_response();
    }

    let machine_code = ctx
        .config_store
        .load_effective_public_config()
        .await
        .ok()
        .and_then(|config| config.machine_code);

    match ctx.state.update_slot_sales_state(input).await {
        Ok(_) => match ctx.state.sale_view(machine_code).await {
            Ok(snapshot) => (StatusCode::OK, Json(snapshot)).into_response(),
            Err(error) => store_error_response("slot_sales_state_view_read_failed", error),
        },
        Err(error) => store_error_response("slot_sales_state_update_failed", error),
    }
}

async fn clear_whole_machine_maintenance_lock(
    State(ctx): State<IpcContext>,
    headers: HeaderMap,
    Json(input): Json<ClearWholeMachineMaintenanceLockRequest>,
) -> impl IntoResponse {
    if let Err((status, error)) = require_token(&headers, &ctx.token).await {
        return (status, error).into_response();
    }

    let operator_note = input.operator_note.trim();
    if operator_note.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorMessage {
                code: "operator_note_required",
                message: "operator note is required to clear whole-machine lock".to_string(),
            }),
        )
            .into_response();
    }

    let previous = match ctx.state.whole_machine_maintenance_lock().await {
        Ok(lock) => lock,
        Err(error) => {
            return store_error_response("whole_machine_lock_read_failed", error);
        }
    };

    if let Some(previous_lock) = previous.as_ref() {
        let evidence = match ctx.state.whole_machine_lock_recovery_evidence().await {
            Ok(Some(evidence)) if evidence.online => evidence,
            Ok(Some(evidence)) => {
                return (
                    StatusCode::CONFLICT,
                    Json(ErrorMessage {
                        code: "hardware_still_unavailable",
                        message: format!(
                            "lower controller must have recovered self-check evidence before clearing whole-machine lock: {}",
                            evidence.message
                        ),
                    }),
                )
                    .into_response();
            }
            Ok(None) => {
                return (
                    StatusCode::CONFLICT,
                    Json(ErrorMessage {
                        code: "self_check_evidence_required",
                        message:
                            "run lower-controller self-check before clearing whole-machine lock"
                                .to_string(),
                    }),
                )
                    .into_response();
            }
            Err(error) => {
                return store_error_response("whole_machine_lock_evidence_read_failed", error);
            }
        };
        if evidence.checked_at.as_str() < previous_lock.created_at.as_str() {
            return (
                StatusCode::CONFLICT,
                Json(ErrorMessage {
                    code: "stale_self_check_evidence",
                    message:
                        "lower-controller self-check evidence must be newer than the active whole-machine lock"
                            .to_string(),
                }),
            )
                .into_response();
        }
        if !evidence.production_dispense_path_ready {
            return (
                StatusCode::CONFLICT,
                Json(ErrorMessage {
                    code: "production_dispense_path_required",
                    message: format!(
                        "production dispense path evidence is required before clearing whole-machine lock: {} ({})",
                        evidence.production_dispense_path_message,
                        evidence.production_dispense_path_code
                    ),
                }),
            )
                .into_response();
        }
        if evidence.adapter == "mock"
            || evidence
                .port_path
                .as_deref()
                .map(|path| path.trim_start().starts_with("tcp://"))
                .unwrap_or(false)
        {
            return (
                StatusCode::CONFLICT,
                Json(ErrorMessage {
                    code: "production_dispense_path_required",
                    message:
                        "mock adapter and tcp:// lower-controller simulator evidence cannot clear a whole-machine lock"
                            .to_string(),
                }),
            )
                .into_response();
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
            return store_error_response("whole_machine_lock_clear_failed", error);
        }
        return (
            StatusCode::OK,
            Json(serde_json::json!({
                "cleared": true,
                "previous": previous,
            })),
        )
            .into_response();
    }

    (StatusCode::OK, Json(serde_json::json!({"cleared": false}))).into_response()
}

fn store_error_response(code: &'static str, error: StoreError) -> axum::response::Response {
    let status = if matches!(error, StoreError::InvalidStockInput(_)) {
        StatusCode::BAD_REQUEST
    } else {
        StatusCode::INTERNAL_SERVER_ERROR
    };
    (
        status,
        Json(ErrorMessage {
            code,
            message: error.to_string(),
        }),
    )
        .into_response()
}

async fn payment_options(State(ctx): State<IpcContext>, headers: HeaderMap) -> impl IntoResponse {
    if let Err((status, error)) = require_token(&headers, &ctx.token).await {
        return (status, error).into_response();
    }

    match ctx.ui.backend.get_payment_options().await {
        Ok(mut payload) => {
            let platform_default_option_key = payload
                .get("defaultOptionKey")
                .and_then(|value| value.as_str())
                .map(ToString::to_string);
            let payment_capability = load_machine_payment_capability(&ctx).await;
            let scanner = ctx.ui.status_cache.scanner.read().await.clone();
            let scanner_readiness = scanner_payment_code_readiness(&scanner);
            let mut default_option_key = serde_json::Value::Null;
            let mut default_provider_code = serde_json::Value::Null;
            if let Some(options) = payload
                .get_mut("options")
                .and_then(|value| value.as_array_mut())
            {
                options.retain(|option| {
                    option
                        .get("method")
                        .and_then(|value| value.as_str())
                        .is_some_and(|method| {
                            payment_method_allowed_by_capability(method, &payment_capability)
                        })
                });
                for option in options.iter_mut() {
                    let is_payment_code = option.get("method").and_then(|value| value.as_str())
                        == Some("payment_code");
                    if is_payment_code && !scanner_readiness.ready {
                        if let Some(map) = option.as_object_mut() {
                            map.insert("disabled".to_string(), serde_json::Value::Bool(true));
                            map.insert(
                                "disabledReason".to_string(),
                                serde_json::Value::String(scanner_readiness.message.clone()),
                            );
                        }
                    }
                }
                let selected_default = platform_default_option_key
                    .as_deref()
                    .and_then(|default_key| {
                        options.iter().find(|option| {
                            option.get("optionKey").and_then(|value| value.as_str())
                                == Some(default_key)
                                && !option
                                    .get("disabled")
                                    .and_then(|value| value.as_bool())
                                    .unwrap_or(false)
                        })
                    })
                    .or_else(|| {
                        options.iter().find(|option| {
                            !option
                                .get("disabled")
                                .and_then(|value| value.as_bool())
                                .unwrap_or(false)
                        })
                    });
                default_option_key = selected_default
                    .and_then(|option| option.get("optionKey"))
                    .cloned()
                    .unwrap_or(serde_json::Value::Null);
                default_provider_code = selected_default
                    .and_then(|option| option.get("providerCode"))
                    .cloned()
                    .unwrap_or(serde_json::Value::Null);
            }
            payload["defaultOptionKey"] = default_option_key;
            payload["defaultProviderCode"] = default_provider_code;
            (StatusCode::OK, Json(payload)).into_response()
        }
        Err(error) => (
            StatusCode::BAD_REQUEST,
            Json(ErrorMessage {
                code: "payment_options_failed",
                message: error,
            }),
        )
            .into_response(),
    }
}

async fn sync_status(State(ctx): State<IpcContext>, headers: HeaderMap) -> impl IntoResponse {
    if let Err((status, error)) = require_token(&headers, &ctx.token).await {
        return (status, error).into_response();
    }

    let outbox_size = ctx.state.outbox_size().await.unwrap_or_default() as usize;
    let mut cache = ctx.ui.status_cache.sync.write().await;
    cache.outbox_size = outbox_size;
    cache.outbox_usage = if cache.outbox_max > 0 {
        cache.outbox_size as f64 / cache.outbox_max as f64
    } else {
        0.0
    };
    (StatusCode::OK, Json(cache.clone())).into_response()
}

async fn scanner_status(State(ctx): State<IpcContext>, headers: HeaderMap) -> impl IntoResponse {
    if let Err((status, error)) = require_token(&headers, &ctx.token).await {
        return (status, error).into_response();
    }

    let snapshot = ctx.ui.status_cache.scanner.read().await;
    (
        StatusCode::OK,
        Json(scanner_runtime_status_contract(&snapshot)),
    )
        .into_response()
}

fn empty_current_transaction_snapshot() -> vending_core::domain::InternalCurrentTransactionSnapshot
{
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

async fn current_transaction_snapshot_response(
    ctx: &IpcContext,
    snapshot: vending_core::domain::InternalCurrentTransactionSnapshot,
) -> axum::response::Response {
    let order_no = snapshot.order_no.clone();
    let order_status = snapshot.order_status.clone();
    let next_action = snapshot.next_action.map(|action| action.as_str());
    match current_transaction_snapshot_contract(snapshot) {
        Ok(snapshot) => Json(snapshot).into_response(),
        Err(error) => {
            append_local_diagnostic_log(
                ctx,
                "error",
                "checkout",
                "current_transaction_contract_invalid",
                Some(serde_json::json!({
                    "orderNo": order_no,
                    "orderStatus": order_status,
                    "nextAction": next_action,
                    "message": error,
                })),
            )
            .await;
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorMessage {
                    code: "transaction_contract_invalid",
                    message: error,
                }),
            )
                .into_response()
        }
    }
}

fn current_transaction_snapshot_contract(
    snapshot: vending_core::domain::InternalCurrentTransactionSnapshot,
) -> Result<daemon_ipc_contracts::CurrentTransactionSnapshot, String> {
    let mut value = serde_json::to_value(snapshot)
        .map_err(|error| format!("serialize current transaction snapshot: {error}"))?;
    normalize_current_transaction_ipc_value(&mut value);
    let snapshot =
        serde_json::from_value::<daemon_ipc_contracts::CurrentTransactionSnapshot>(value)
            .map_err(|error| format!("decode generated current transaction snapshot: {error}"))?;
    daemon_ipc_contracts::validate_current_transaction_snapshot_boundary(&snapshot)
        .map_err(|error| format!("validate current transaction boundary: {error}"))?;
    Ok(snapshot)
}

fn normalize_current_transaction_ipc_value(value: &mut serde_json::Value) {
    let Some(vending_status) = value.pointer_mut("/vending/status") else {
        return;
    };
    let Some(status) = vending_status.as_str() else {
        return;
    };
    let normalized = match status {
        "received" => "pending",
        "dispensing" => "acknowledged",
        _ => return,
    };
    *vending_status = serde_json::Value::String(normalized.to_string());
}

async fn hardware_self_check(
    State(ctx): State<IpcContext>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if let Err((status, error)) = require_token(&headers, &ctx.token).await {
        return (status, error).into_response();
    }

    let (status, config_updated) = match run_hardware_self_check(&ctx).await {
        Ok(result) => result,
        Err(response) => return response,
    };

    Json(serde_json::json!({
        "adapter": status.adapter,
        "online": status.online,
        "message": status.message,
        "portPath": status.port_path,
        "resolutionSource": status.resolution_source,
        "boundUsbIdentity": status.bound_usb_identity,
        "candidates": status.candidates,
        "configUpdated": config_updated,
    }))
    .into_response()
}

async fn run_hardware_self_check(
    ctx: &IpcContext,
) -> Result<(vending_core::hardware::HardwareStatus, bool), axum::response::Response> {
    let public = match ctx.config_store.load_effective_public_config().await {
        Ok(public) => public,
        Err(error) => {
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorMessage {
                    code: "config_missing",
                    message: error,
                }),
            )
                .into_response());
        }
    };

    let mut config_updated = false;
    let status = match crate::hardware::HardwareSupervisor::from_config(&public) {
        Ok(supervisor) => supervisor.self_check().await,
        Err(error) => vending_core::hardware::HardwareStatus {
            adapter: serde_json::to_value(&public.hardware_adapter)
                .ok()
                .and_then(|value| value.as_str().map(ToString::to_string))
                .unwrap_or_else(|| "unknown".to_string()),
            online: false,
            message: error,
            port_path: None,
            resolution_source: Some("unresolved".to_string()),
            bound_usb_identity: None,
            candidates: vec![],
        },
    };

    if let Some(bound_identity) = status.bound_usb_identity.clone() {
        let should_update = public
            .lower_controller_usb_identity
            .as_ref()
            .is_some_and(|identity| identity.serial_number.is_none());
        if should_update {
            let mut updated = public.clone();
            updated.lower_controller_usb_identity = Some(bound_identity);
            if ctx.config_store.save_public_config(updated).await.is_ok() {
                config_updated = true;
            }
        }
    }

    if let Some(error_code) =
        crate::state::store::classify_whole_machine_hardware_status_fault(&status)
    {
        if let Err(error) = ctx
            .state
            .record_whole_machine_hardware_fault_lock(
                "hardware_self_check",
                &status.message,
                Some(error_code),
            )
            .await
        {
            return Err(store_error_response(
                "whole_machine_lock_record_failed",
                error,
            ));
        }
    }

    {
        let production_dispense_path = production_dispense_path_readiness(Some(&public));
        let evidence = crate::state::store::WholeMachineMaintenanceLockClearEvidence {
            adapter: status.adapter.clone(),
            online: status.online,
            message: status.message.clone(),
            port_path: status.port_path.clone(),
            checked_at: crate::state::store::now_iso(),
            production_dispense_path_ready: production_dispense_path.ready,
            production_dispense_path_code: production_dispense_path.code.to_string(),
            production_dispense_path_message: production_dispense_path.message.to_string(),
        };
        if let Err(error) = ctx
            .state
            .record_whole_machine_lock_recovery_evidence(&evidence)
            .await
        {
            return Err(store_error_response(
                "whole_machine_lock_evidence_write_failed",
                error,
            ));
        }
    }

    *ctx.ui.status_cache.hardware.write().await = status.clone();
    Ok((status, config_updated))
}

async fn control_environment(
    State(ctx): State<IpcContext>,
    headers: HeaderMap,
    Json(request): Json<LocalEnvironmentControlRequest>,
) -> impl IntoResponse {
    if let Err((status, error)) = require_token(&headers, &ctx.token).await {
        return (status, error).into_response();
    }

    if request.air_conditioner_on.is_none()
        && request.target_temperature_celsius.is_none()
        && request.vent_speed.is_none()
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorMessage {
                code: "invalid_environment_control_request",
                message:
                    "At least one of airConditionerOn, targetTemperatureCelsius or ventSpeed is required"
                        .to_string(),
            }),
        )
            .into_response();
    }

    if let Some(timeout_seconds) = request.timeout_seconds {
        if timeout_seconds == 0 {
            return (
                StatusCode::BAD_REQUEST,
                Json(ErrorMessage {
                    code: "invalid_environment_control_request",
                    message: "timeoutSeconds must be positive".to_string(),
                }),
            )
                .into_response();
        }
    }

    if let Some(target) = request.target_temperature_celsius {
        if !(18..=30).contains(&target) {
            return (
                StatusCode::BAD_REQUEST,
                Json(ErrorMessage {
                    code: "invalid_environment_control_request",
                    message: "targetTemperatureCelsius must be between 18 and 30".to_string(),
                }),
            )
                .into_response();
        }
    }

    if let Some(speed) = request.vent_speed {
        if speed > 4 {
            return (
                StatusCode::BAD_REQUEST,
                Json(ErrorMessage {
                    code: "invalid_environment_control_request",
                    message: "ventSpeed must be between 0 and 4".to_string(),
                }),
            )
                .into_response();
        }
    }

    let command_no = format!("local-env-{}", uuid::Uuid::new_v4());
    let mut confirmed_target = None;
    let mut confirmed_switch = None;
    let mut confirmed_vent_speed = None;
    let mut failure = None;

    if let Some(target) = request.target_temperature_celsius {
        match ctx.hardware.set_target_temperature(target).await {
            Ok(()) => confirmed_target = Some(target),
            Err(error) => failure = Some(("target_temperature_failed".to_string(), error)),
        }
    }

    if failure.is_none() {
        if let Some(enabled) = request.air_conditioner_on {
            match ctx.hardware.set_air_conditioner_enabled(enabled).await {
                Ok(()) => confirmed_switch = Some(enabled),
                Err(error) => failure = Some(("air_conditioner_switch_failed".to_string(), error)),
            }
        }
    }

    if failure.is_none() {
        if let Some(speed) = request.vent_speed {
            match ctx.hardware.set_vent_speed(speed).await {
                Ok(()) => confirmed_vent_speed = Some(speed),
                Err(error) => failure = Some(("vent_speed_failed".to_string(), error)),
            }
        }
    }

    let result = match failure {
        Some((error_code, message)) => vending_core::hardware::EnvironmentControlResultPayload {
            command_no,
            success: false,
            error_code: Some(error_code),
            message: Some(message),
            air_conditioner_on: confirmed_switch,
            target_temperature_celsius: confirmed_target,
            vent_speed: confirmed_vent_speed,
            reported_at: crate::state::store::now_iso(),
        },
        None => vending_core::hardware::EnvironmentControlResultPayload {
            command_no,
            success: true,
            error_code: None,
            message: Some("environment control completed".to_string()),
            air_conditioner_on: confirmed_switch,
            target_temperature_celsius: confirmed_target,
            vent_speed: confirmed_vent_speed,
            reported_at: crate::state::store::now_iso(),
        },
    };

    Json(result).into_response()
}

fn hardware_fault_injection_enabled() -> bool {
    std::env::var("VEM_ENABLE_HARDWARE_FAULT_INJECTION")
        .map(|value| matches!(value.as_str(), "1" | "true" | "TRUE" | "yes" | "YES"))
        .unwrap_or(false)
}

async fn schedule_next_dispense_fault_injection(
    State(ctx): State<IpcContext>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if let Err((status, error)) = require_token(&headers, &ctx.token).await {
        return (status, error).into_response();
    }
    if !hardware_fault_injection_enabled() {
        return (
            StatusCode::FORBIDDEN,
            Json(ErrorMessage {
                code: "fault_injection_disabled",
                message:
                    "set VEM_ENABLE_HARDWARE_FAULT_INJECTION=1 and restart daemon before using this endpoint"
                        .to_string(),
            }),
        )
            .into_response();
    }

    match ctx.hardware.schedule_next_dispense_fault_injection() {
        Ok(()) => Json(serde_json::json!({
            "scheduled": true,
            "mode": "next_dispense_debug_fault_frame",
            "frameHex": "55 FF FF FF",
            "message": "the next serial dispense will send the lower-controller debug fault frame after ACK"
        }))
        .into_response(),
        Err(error) => (
            StatusCode::CONFLICT,
            Json(ErrorMessage {
                code: "fault_injection_unsupported",
                message: error,
            }),
        )
            .into_response(),
    }
}

async fn vision_status(State(ctx): State<IpcContext>, headers: HeaderMap) -> impl IntoResponse {
    if let Err((status, error)) = require_token(&headers, &ctx.token).await {
        return (status, error).into_response();
    }

    let snapshot = ctx.ui.status_cache.vision.read().await;

    Json(serde_json::json!({
        "enabled": snapshot.enabled,
        "online": snapshot.online,
        "message": snapshot.message,
        "updatedAt": snapshot.updated_at,
        "latestDiagnosticPayload": snapshot.latest_diagnostic_payload,
    }))
    .into_response()
}

async fn natural_context(State(ctx): State<IpcContext>, headers: HeaderMap) -> impl IntoResponse {
    if let Err((status, error)) = require_token(&headers, &ctx.token).await {
        return (status, error).into_response();
    }

    let public = match ctx.config_store.load_effective_public_config().await {
        Ok(public) => public,
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorMessage {
                    code: "config_load_failed",
                    message: error,
                }),
            )
                .into_response();
        }
    };
    let Some(machine_code) = public.machine_code.clone() else {
        return Json(MachineNaturalContextSnapshot::unconfigured(
            None,
            "Machine is not provisioned for Natural Context",
        ))
        .into_response();
    };

    let local_site_signals = local_site_signals_snapshot(&ctx).await;

    match ctx
        .ui
        .backend
        .get_external_natural_environment(&machine_code)
        .await
    {
        Ok(external) => Json(MachineNaturalContextSnapshot::from_external_environment(
            Some(machine_code),
            external,
            Some(local_site_signals),
        ))
        .into_response(),
        Err(error) => Json(MachineNaturalContextSnapshot::unavailable(
            Some(machine_code),
            backend_natural_context_message(&error),
        ))
        .into_response(),
    }
}

async fn local_site_signals_snapshot(
    ctx: &IpcContext,
) -> vending_core::environment::EnvironmentHeartbeatPayload {
    let cached = ctx
        .ui
        .status_cache
        .environment
        .read()
        .await
        .heartbeat_payload();
    if cached.sensor_status != vending_core::environment::EnvironmentSensorStatus::Unknown {
        return cached;
    }

    match ctx.hardware.query_environment_sample().await {
        Ok(sample) => {
            let sampled_at = crate::state::store::now_iso();
            let mut cache = ctx.ui.status_cache.environment.write().await;
            cache.record_query_result(sample, sampled_at);
            cache.heartbeat_payload()
        }
        Err(error) => {
            let mut cache = ctx.ui.status_cache.environment.write().await;
            if crate::mqtt::is_lower_controller_sensor_fault(&error) {
                cache.record_sensor_fault();
            } else {
                cache.record_query_result(None, crate::state::store::now_iso());
            }
            cache.heartbeat_payload()
        }
    }
}

fn backend_natural_context_message(error: &str) -> String {
    match error {
        "BACKEND_AUTH_NOT_CONFIGURED" => {
            "Machine credentials are not configured for Natural Context".to_string()
        }
        "BACKEND_AUTH_FAILED" => {
            "Machine authentication failed while refreshing Natural Context".to_string()
        }
        "BACKEND_OFFLINE" => {
            "Service API is unavailable while refreshing Natural Context".to_string()
        }
        _ => "External Natural Environment is unavailable".to_string(),
    }
}

async fn remote_ops_status(State(ctx): State<IpcContext>, headers: HeaderMap) -> impl IntoResponse {
    if let Err((status, error)) = require_token(&headers, &ctx.token).await {
        return (status, error).into_response();
    }

    (
        StatusCode::OK,
        Json(serde_json::json!({
            "lastPolledAt": crate::state::store::now_iso(),
            "pending": 0,
            "lastError": None::<String>,
            "processing": None::<String>,
        })),
    )
        .into_response()
}

async fn export_logs(State(ctx): State<IpcContext>, headers: HeaderMap) -> impl IntoResponse {
    if let Err((status, error)) = require_token(&headers, &ctx.token).await {
        return (status, error).into_response();
    }

    let bytes = match logs::export_local_logs_zip(&ctx.data_dir).await {
        Ok(bytes) => bytes,
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorMessage {
                    code: "export_failed",
                    message: error,
                }),
            )
                .into_response();
        }
    };

    (
        [
            (CONTENT_TYPE, "application/zip"),
            (
                CONTENT_DISPOSITION,
                "attachment; filename=machine-events.zip",
            ),
        ],
        bytes,
    )
        .into_response()
}

async fn require_query_token(
    query: &EventQuery,
    token: &str,
) -> Result<(), (StatusCode, Json<ErrorMessage>)> {
    if query.token.as_deref() == Some(token) {
        Ok(())
    } else {
        Err((
            StatusCode::UNAUTHORIZED,
            Json(ErrorMessage {
                code: "unauthorized",
                message: "missing or invalid event token".to_string(),
            }),
        ))
    }
}

async fn events_ws(
    State(ctx): State<IpcContext>,
    axum::extract::Query(query): axum::extract::Query<EventQuery>,
    ws: Option<WebSocketUpgrade>,
) -> impl IntoResponse {
    if let Err((status, error)) = require_query_token(&query, &ctx.token).await {
        return (status, error).into_response();
    }
    let Some(ws) = ws else {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorMessage {
                code: "websocket_required",
                message: "websocket upgrade required".to_string(),
            }),
        )
            .into_response();
    };

    ws.on_upgrade(move |socket| events_ws_inner(socket, ctx.events))
}

async fn events_ws_inner(mut socket: WebSocket, events: broadcast::Sender<DaemonEvent>) {
    let mut receiver = events.subscribe();
    loop {
        tokio::select! {
            msg = receiver.recv() => match msg {
                Ok(event) => {
                    if let Ok(json) = serde_json::to_string(&event) {
                        if socket.send(Message::Text(json)).await.is_err() {
                            break;
                        }
                    }
                }
                Err(_) => break,
            },
            _ = socket.recv() => {
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        config::default_public_config,
        secret::{InMemorySecretStore, SecretStore},
        state::store::OutboxInput,
        transaction::TransactionStateMachine,
    };
    use axum::{
        body,
        http::{Method, Request, StatusCode},
    };
    use serde_json::json;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    use tempfile::tempdir;
    use tower::util::ServiceExt;
    use vending_core::hardware::{DispenseProgressEvent, DispenseProgressStage};

    static FAULT_INJECTION_ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    struct EnvGuard {
        name: &'static str,
        previous: Option<String>,
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            match &self.previous {
                Some(value) => std::env::set_var(self.name, value),
                None => std::env::remove_var(self.name),
            }
        }
    }

    fn set_env_var(name: &'static str, value: &str) -> EnvGuard {
        let previous = std::env::var(name).ok();
        std::env::set_var(name, value);
        EnvGuard { name, previous }
    }

    fn remove_env_var(name: &'static str) -> EnvGuard {
        let previous = std::env::var(name).ok();
        std::env::remove_var(name);
        EnvGuard { name, previous }
    }
    use wiremock::{
        matchers::{body_partial_json, method, path},
        Mock, MockServer, ResponseTemplate,
    };

    #[test]
    fn sanitize_profile_snapshot_drops_raw_images_and_sensitive_inference() {
        let sanitized = sanitize_profile_snapshot(Some(json!({
            "personPresent": true,
            "heightCm": 172,
            "bodyType": "regular",
            "upperColor": "blue",
            "confidence": 0.91,
            "rawImageBase64": "data:image/jpeg;base64,raw",
            "identity": { "id": "customer-1" },
            "faceEmbedding": [0.1, 0.2],
            "ageRange": "25-34",
            "gender": "male"
        })))
        .expect("sanitized profile");

        assert_eq!(
            sanitized,
            json!({
                "personPresent": true,
                "heightCm": 172,
                "bodyType": "regular",
                "upperColor": "blue",
                "confidence": 0.91
            })
        );
    }

    #[test]
    fn sanitize_profile_snapshot_falls_back_null_without_required_fields() {
        assert_eq!(
            sanitize_profile_snapshot(Some(json!({
                "heightCm": 172,
                "bodyType": "regular",
                "confidence": 0.9
            }))),
            None
        );
        assert_eq!(
            sanitize_profile_snapshot(Some(json!({
                "personPresent": "yes",
                "heightCm": 172
            }))),
            None
        );
        assert_eq!(sanitize_profile_snapshot(Some(json!("legacy"))), None);
    }

    #[test]
    fn sanitize_profile_snapshot_drops_invalid_optional_metadata() {
        let sanitized = sanitize_profile_snapshot(Some(json!({
            "personPresent": true,
            "heightCm": 300,
            "bodyType": "x".repeat(64),
            "upperColor": "",
            "confidence": 2
        })))
        .expect("sanitized profile");

        assert_eq!(sanitized, json!({ "personPresent": true }));
    }

    #[tokio::test]
    async fn ipc_token_is_reused_and_base64_decode_is_32_bytes() {
        let dir = tempfile::tempdir().expect("tmp");
        let token1 = load_or_create_ipc_token(dir.path()).await.expect("token");
        let token2 = load_or_create_ipc_token(dir.path()).await.expect("token");
        assert_eq!(token1, token2);
        let raw = URL_SAFE_NO_PAD
            .decode(token1.as_bytes())
            .expect("decode token");
        assert_eq!(raw.len(), 32);
    }

    #[tokio::test]
    async fn assert_loopback_rejects_non_loopback_bind() {
        let err = assert_loopback("0.0.0.0:0".parse().expect("addr"));
        assert!(err.is_err());
    }

    async fn test_ipc_context(
        data_dir: &std::path::Path,
        token: impl Into<String>,
        machine_code: Option<String>,
        backend_base_url: &str,
    ) -> IpcContext {
        let data_dir =
            if data_dir.file_name().and_then(|name| name.to_str()) == Some("vending-daemon") {
                data_dir.to_path_buf()
            } else {
                data_dir.join("vending-daemon")
            };
        let state = crate::state::LocalStateStore::open(&data_dir.join("state.db"))
            .await
            .expect("state");
        let secrets = Arc::new(InMemorySecretStore::default());
        secrets
            .write_secret(
                crate::secret::MACHINE_WIREGUARD_PRIVATE_KEY_ACCOUNT,
                "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            )
            .await
            .expect("seed machine WireGuard key");
        let secrets: Arc<dyn crate::secret::SecretStore> = secrets;
        let config_store = Arc::new(crate::config::ConfigStore::new(
            data_dir.clone(),
            state.clone(),
            secrets,
        ));

        let mut public = default_public_config();
        public.machine_code = machine_code;
        public.api_base_url = backend_base_url.to_string();
        config_store
            .save_public_config(public.clone())
            .await
            .expect("save public config");
        if public.machine_code.as_deref() == Some("MACHINE-1") {
            write_platform_profile_cache_for_store(&config_store, None)
                .await
                .expect("write default profile cache");
        }
        let public = config_store
            .load_public_config()
            .await
            .expect("load public config");

        let (events_tx, _) = broadcast::channel(8);
        let (runtime_tx, _rx_raw) = mpsc::channel(8);
        let backend = Arc::new(BackendClient::new(backend_base_url));
        backend
            .set_access_token_for_tests("test-backend-token")
            .await;
        let status_cache = RuntimeStatusCache::new(&public, state.clone()).await;
        // The IPC unit harness represents a daemon that has completed its
        // Local Network/Platform probe. Individual tests that exercise a
        // fresh, offline runtime clear this volatile evidence explicitly.
        *status_cache.network.write().await = Some(NetworkSettingsResponse {
            status: NetworkSetupStatus::Connected,
            ssid: "test-network".to_string(),
            hidden: false,
            diagnostics: vec![crate::network::NetworkDiagnostic {
                component: "provisioning_endpoint".to_string(),
                level: "info".to_string(),
                code: "PROVISIONING_ENDPOINT_REACHABLE".to_string(),
                message: "reachable".to_string(),
            }],
            operator_guidance: "reachable".to_string(),
            updated_at: crate::state::store::now_iso(),
        });
        let transaction = TransactionStateMachine::new(
            state.clone(),
            backend.clone(),
            public.machine_code.clone(),
            events_tx.clone(),
        )
        .with_payment_code_submit_guard(local_payment_code_submit_guard(
            status_cache.clone(),
            state.clone(),
        ));

        IpcContext {
            data_dir,
            token: token.into(),
            config_store,
            state,
            hardware: crate::hardware::HardwareSupervisor::from_config(&public)
                .expect("hardware supervisor"),
            events: events_tx,
            runtime_tx,
            disk_pressure_probe: Arc::new(FixedDiskPressureProbe {
                available_bytes: crate::health::DISK_PRESSURE_MIN_AVAILABLE_BYTES + 1,
                threshold_bytes: crate::health::DISK_PRESSURE_MIN_AVAILABLE_BYTES,
            }),
            network_adapter: crate::network::adapter_from_env(),
            ui: UiRuntimeServices {
                backend,
                transaction,
                status_cache,
            },
            background_shutdown: CancellationToken::new(),
            bring_up_execution_lock: Arc::new(Mutex::new(())),
            maintenance_authorization: Arc::new(TestMaintenanceAuthorization { allow: false }),
        }
    }

    async fn call_status_request(
        method: Method,
        uri: &str,
        token: Option<&str>,
        app: &Router,
    ) -> StatusCode {
        let mut builder = Request::builder().method(method).uri(uri);
        if let Some(token) = token {
            builder = builder.header(AUTHORIZATION, format!("Bearer {token}"));
        }
        let request = builder.body(axum::body::Body::empty()).expect("request");
        app.clone()
            .oneshot(request)
            .await
            .expect("response")
            .status()
    }

    #[tokio::test]
    async fn dispense_confirmation_requires_ipc_token() {
        let temp_dir = tempdir().expect("tmp");
        let app = build_router(
            test_ipc_context(
                temp_dir.path(),
                "token-1",
                Some("MACHINE-1".to_string()),
                "http://127.0.0.1:9",
            )
            .await,
        );

        let status = call_status_request(
            Method::GET,
            "/v1/stock/movements/dispense-confirmation?orderId=order-1&vendingCommandId=command-1",
            None,
            &app,
        )
        .await;

        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn dispense_confirmation_rejects_blank_query_values() {
        let temp_dir = tempdir().expect("tmp");
        let app = build_router(
            test_ipc_context(
                temp_dir.path(),
                "token-1",
                Some("MACHINE-1".to_string()),
                "http://127.0.0.1:9",
            )
            .await,
        );

        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/v1/stock/movements/dispense-confirmation?orderId=%20%20&vendingCommandId=command-1")
                    .header(AUTHORIZATION, "Bearer token-1")
                    .body(axum::body::Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        let payload: serde_json::Value = serde_json::from_slice(&body).expect("json");
        assert_eq!(payload["code"], "dispense_confirmation_query_invalid");
    }

    #[tokio::test]
    async fn dispense_confirmation_proxies_authenticated_backend_response() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(wiremock::matchers::path(
                "/machine-stock-movements/dispense-confirmation",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "movementId": "MOVE-1",
                "orderId": "order /?&=1",
                "vendingCommandId": "command /?&=2",
                "quantity": 1,
                "beforeQuantity": 3,
                "afterQuantity": 2,
                "deltaQuantity": -1,
                "status": "accepted",
            })))
            .mount(&server)
            .await;

        let temp_dir = tempdir().expect("tmp");
        let mut ctx = test_ipc_context(
            temp_dir.path(),
            "token-1",
            Some("MACHINE-1".to_string()),
            &server.uri(),
        )
        .await;
        mark_claim_task_available(&ctx).await;
        ctx.config_store
            .request_machine_reclaim()
            .await
            .expect("persist reclaim request");
        ctx.maintenance_authorization = Arc::new(TestMaintenanceAuthorization { allow: true });
        let app = build_router(ctx);
        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/v1/stock/movements/dispense-confirmation?orderId=order%20%2F%3F%26%3D1&vendingCommandId=command%20%2F%3F%26%3D2")
                    .header(AUTHORIZATION, "Bearer token-1")
                    .body(axum::body::Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::OK);
        let body = body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        let payload: serde_json::Value = serde_json::from_slice(&body).expect("json");
        assert_eq!(payload["movementId"], "MOVE-1");
        assert_eq!(payload["status"], "accepted");
        assert!(!serde_json::to_string(&payload)
            .expect("payload text")
            .contains("test-backend-token"));

        let requests = server.received_requests().await.expect("requests");
        let request = requests
            .iter()
            .find(|request| {
                request.method.as_str() == "GET"
                    && request.url.path() == "/machine-stock-movements/dispense-confirmation"
            })
            .expect("backend dispense confirmation request");
        assert_eq!(
            request
                .headers
                .get("authorization")
                .and_then(|value| value.to_str().ok()),
            Some("Bearer test-backend-token")
        );
        let query = request.url.query_pairs().collect::<Vec<_>>();
        assert!(query
            .iter()
            .any(|(key, value)| key == "orderId" && value == "order /?&=1"));
        assert!(query
            .iter()
            .any(|(key, value)| key == "vendingCommandId" && value == "command /?&=2"));
    }

    #[tokio::test]
    async fn dispense_confirmation_failure_does_not_expose_backend_credential() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(wiremock::matchers::path(
                "/machine-stock-movements/dispense-confirmation",
            ))
            .respond_with(ResponseTemplate::new(500).set_body_json(json!({
                "message": "machine secret vms_local-machine-shared-secret-change-before-prod",
            })))
            .mount(&server)
            .await;

        let temp_dir = tempdir().expect("tmp");
        let app = build_router(
            test_ipc_context(
                temp_dir.path(),
                "token-1",
                Some("MACHINE-1".to_string()),
                &server.uri(),
            )
            .await,
        );
        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/v1/stock/movements/dispense-confirmation?orderId=order-1&vendingCommandId=command-1")
                    .header(AUTHORIZATION, "Bearer token-1")
                    .body(axum::body::Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        let body = body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        let payload: serde_json::Value = serde_json::from_slice(&body).expect("json");
        assert_eq!(payload["code"], "dispense_confirmation_unavailable");
        let text = serde_json::to_string(&payload).expect("payload text");
        assert!(!text.contains("test-backend-token"));
        assert!(!text.contains("vms_local-machine"));
    }

    #[tokio::test]
    async fn hardware_fault_injection_endpoint_is_disabled_by_default() {
        let _guard = FAULT_INJECTION_ENV_LOCK.lock().await;
        let _env = remove_env_var("VEM_ENABLE_HARDWARE_FAULT_INJECTION");
        let temp = tempdir().expect("temp");
        let ctx =
            test_ipc_context(temp.path(), "token-1", Some("M1".to_string()), "http://api").await;
        let app = build_router(ctx);

        let status = call_status_request(
            Method::POST,
            "/v1/hardware/fault-injection/next-dispense",
            Some("token-1"),
            &app,
        )
        .await;

        assert_eq!(status, StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn hardware_fault_injection_endpoint_requires_serial_adapter_support() {
        let _guard = FAULT_INJECTION_ENV_LOCK.lock().await;
        let _env = set_env_var("VEM_ENABLE_HARDWARE_FAULT_INJECTION", "1");
        let temp = tempdir().expect("temp");
        let ctx =
            test_ipc_context(temp.path(), "token-1", Some("M1".to_string()), "http://api").await;
        let app = build_router(ctx);

        let status = call_status_request(
            Method::POST,
            "/v1/hardware/fault-injection/next-dispense",
            Some("token-1"),
            &app,
        )
        .await;

        assert_eq!(status, StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn local_environment_control_endpoint_controls_air_conditioner() {
        let temp = tempdir().expect("temp");
        let ctx =
            test_ipc_context(temp.path(), "token-1", Some("M1".to_string()), "http://api").await;
        let app = build_router(ctx);

        let response = post_json(
            &app,
            "/v1/environment/control",
            "token-1",
            json!({
                "airConditionerOn": true,
                "targetTemperatureCelsius": 24,
                "ventSpeed": 2,
                "timeoutSeconds": 5
            }),
        )
        .await;

        assert_eq!(response.status(), StatusCode::OK);
        let body = body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        let payload: serde_json::Value = serde_json::from_slice(&body).expect("json");
        assert_eq!(payload["success"], true);
        assert_eq!(payload["airConditionerOn"], true);
        assert_eq!(payload["targetTemperatureCelsius"], 24);
        assert_eq!(payload["ventSpeed"], 2);
        assert_eq!(payload["message"], "environment control completed");
    }

    #[tokio::test]
    async fn local_environment_control_endpoint_rejects_empty_request() {
        let temp = tempdir().expect("temp");
        let ctx =
            test_ipc_context(temp.path(), "token-1", Some("M1".to_string()), "http://api").await;
        let app = build_router(ctx);

        let response = post_json(&app, "/v1/environment/control", "token-1", json!({})).await;

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    struct CountingNetworkAdapter {
        calls: Arc<AtomicUsize>,
    }

    #[async_trait::async_trait]
    impl crate::network::NetworkAdapter for CountingNetworkAdapter {
        async fn apply_wifi_settings(
            &self,
            request: crate::network::NetworkSettingsRequest,
        ) -> crate::network::NetworkSettingsResponse {
            self.calls.fetch_add(1, Ordering::SeqCst);
            crate::network::NetworkSettingsResponse {
                status: crate::network::NetworkSetupStatus::Connected,
                ssid: request.ssid,
                hidden: request.hidden,
                diagnostics: vec![],
                operator_guidance: "ok".to_string(),
                updated_at: crate::state::store::now_iso(),
            }
        }
    }

    #[tokio::test]
    async fn network_settings_rejects_invalid_payload_before_adapter_call() {
        let temp = tempdir().expect("temp");
        let mut ctx = test_ipc_context(temp.path(), "token-1", None, "").await;
        let calls = Arc::new(AtomicUsize::new(0));
        ctx.network_adapter = Arc::new(CountingNetworkAdapter {
            calls: calls.clone(),
        });
        let app = build_router(ctx);
        let valid_password = ["valid", "network", "credential"].join("-");
        let short_password = ["short"].join("");
        let long_password = "x".repeat(64);
        let control_password = format!("valid{}credential", '\u{0007}');

        for payload in [
            json!({ "ssid": "", "password": valid_password.clone(), "hidden": false }),
            json!({ "ssid": "VEM-Lab", "password": "", "hidden": false }),
            json!({ "ssid": "VEM-Lab", "password": short_password.clone(), "hidden": false }),
            json!({ "ssid": "VEM-Lab", "password": long_password.clone(), "hidden": false }),
            json!({ "ssid": "123456789012345678901234567890123", "password": valid_password.clone(), "hidden": false }),
            json!({ "ssid": "VEM\u{0007}Lab", "password": valid_password.clone(), "hidden": false }),
            json!({ "ssid": "VEM-Lab", "password": control_password.clone(), "hidden": false }),
            json!({ "ssid": "VEM-Lab", "password": valid_password.clone(), "hidden": false, "extra": true }),
        ] {
            let response = post_json(&app, "/v1/network/settings", "token-1", payload).await;
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
            let body = body::to_bytes(response.into_body(), usize::MAX)
                .await
                .expect("body");
            let result: serde_json::Value = serde_json::from_slice(&body).expect("json");
            assert_eq!(result["status"], "failed");
            assert!(result["diagnostics"]
                .as_array()
                .expect("diagnostics")
                .iter()
                .any(|item| item["component"] == "local_network"
                    && item["code"] == "NETWORK_SETTINGS_INVALID_PAYLOAD"));
            let text = result.to_string();
            for submitted in [
                &valid_password,
                &short_password,
                &long_password,
                &control_password,
            ] {
                assert!(
                    !text.contains(submitted),
                    "validation response leaked submitted Wi-Fi password"
                );
            }
        }

        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    struct FixedDiskPressureProbe {
        available_bytes: u64,
        threshold_bytes: u64,
    }

    impl crate::health::DiskPressureProbe for FixedDiskPressureProbe {
        fn snapshot(&self, _data_dir: &std::path::Path) -> crate::health::DiskPressureSnapshot {
            crate::health::DiskPressureSnapshot {
                pressured: self.available_bytes < self.threshold_bytes,
                available_bytes: Some(self.available_bytes),
                threshold_bytes: self.threshold_bytes,
                message: format!(
                    "disk capacity pressure: {} bytes available below {} byte threshold",
                    self.available_bytes, self.threshold_bytes
                ),
            }
        }
    }

    async fn mark_runtime_sale_ready(ctx: &IpcContext) {
        {
            let mut sync = ctx.ui.status_cache.sync.write().await;
            sync.mqtt_running = true;
            sync.mqtt_connected = true;
            sync.outbox_size = 0;
            sync.outbox_usage = 0.0;
            sync.last_error = None;
        }
        {
            let mut hardware = ctx.ui.status_cache.hardware.write().await;
            hardware.online = true;
            hardware.message = "hardware ready".to_string();
        }
        {
            let mut scanner = ctx.ui.status_cache.scanner.write().await;
            scanner.online = true;
            scanner.adapter = vending_core::scanner::PAYMENT_CODE_SOURCE_SERIAL_TEXT.to_string();
            scanner.code = "SCANNER_READY".to_string();
            scanner.message = "scanner ready".to_string();
        }
        {
            let profile = valid_provisioning_profile();
            let mut public = ctx.config_store.load_public_config().await.expect("config");
            public.hardware_adapter = crate::config::HardwareAdapterKind::Serial;
            public.serial_port_path = Some("/dev/ttyUSB0".to_string());
            public.lower_controller_usb_identity = None;
            public.hardware_profile = Some(
                serde_json::from_value(profile["hardwareProfile"].clone())
                    .expect("hardware profile"),
            );
            public.payment_capability = Some(
                serde_json::from_value(profile["paymentCapability"].clone())
                    .expect("payment capability"),
            );
            ctx.config_store
                .save_public_config(public)
                .await
                .expect("save production config");
        }
        ensure_platform_profile(ctx).await;
    }

    async fn ready_payment_options_server() -> MockServer {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/machine-orders/payment-options"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "options": [{
                    "optionKey": "qr_code:alipay",
                    "providerCode": "alipay",
                    "method": "qr_code",
                    "displayName": "支付宝",
                    "description": "请使用支付宝扫码支付",
                    "icon": "alipay",
                    "disabled": false,
                    "disabledReason": null,
                    "recommended": true
                }],
                "defaultOptionKey": "qr_code:alipay",
                "defaultProviderCode": "alipay",
                "serverTime": "2026-06-08T16:30:00.000Z"
            })))
            .mount(&server)
            .await;
        server
    }

    async fn write_factory_manifest(temp_root: &std::path::Path, identity: &str, version: &str) {
        let manifest_dir = temp_root.join("factory");
        tokio::fs::create_dir_all(&manifest_dir)
            .await
            .expect("factory dir");
        tokio::fs::write(
            manifest_dir.join("factory-manifest.json"),
            serde_json::to_string_pretty(&json!({
                "layoutVersion": 1,
                "environment": "test",
                "provisioningEndpoint": "http://127.0.0.1:0/api",
                "hardwareMode": "production",
                "hardwareModel": "VEM-PROD-24",
                "hardwareSlotTopology": {
                    "identity": identity,
                    "version": version
                }
            }))
            .expect("manifest json"),
        )
        .await
        .expect("write factory manifest");
    }

    async fn write_platform_profile_cache_for_store(
        config_store: &ConfigStore,
        topology: Option<(&str, &str)>,
    ) -> Result<(), String> {
        let api_base_url = config_store
            .load_effective_public_config()
            .await
            .map(|config| config.api_base_url)
            .unwrap_or_else(|_| "http://127.0.0.1:0/api".to_string());
        let mut profile = json!({
            "profileVersion": 1,
            "machineId": "550e8400-e29b-41d4-a716-446655440000",
            "machineCode": "MACHINE-1",
            "machineName": "Lobby Machine",
            "machineStatus": "online",
            "claimedAt": "2026-06-08T16:30:00.000Z",
            "apiBaseUrl": api_base_url,
            "mqttUrl": "mqtt://broker.example:1883",
            "mqttClientId": "vem-machine-MACHINE-1",
            "runtimeEndpoints": {
                "apiBasePath": "/api",
                "machineAuthTokenPath": "/api/machine-auth/token",
                "machineApiBasePath": "/api/machines/MACHINE-1",
                "mqttTopicPrefix": "vem/machines/MACHINE-1"
            },
            "hardwareProfile": {
                "profile": "production",
                "controller": { "required": true, "protocol": "vem-vending-controller" },
                "paymentScanner": { "required": true, "supportsPaymentCode": true },
                "vision": { "required": false, "supportsRecommendations": true }
            },
            "paymentCapability": {
                "profile": "production",
                "qrCodeEnabled": true,
                "paymentCodeEnabled": true,
                "serverTime": "2026-06-08T16:30:00.000Z"
            },
            "provisioningMetadata": {
                "profileVersion": 1,
                "claimCodeId": "550e8400-e29b-41d4-a716-446655440111",
                "claimedAt": "2026-06-08T16:30:00.000Z",
                "serverTime": "2026-06-08T16:30:00.000Z"
            }
        });
        if let Some((identity, version)) = topology {
            profile["hardwareSlotTopology"] = json!({
                "identity": identity,
                "version": version
            });
        }
        let path = config_store.provisioning_profile_cache_summary_path();
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|error| format!("create profile cache dir failed: {error}"))?;
        }
        tokio::fs::write(
            path,
            serde_json::to_string_pretty(&profile)
                .map_err(|error| format!("serialize profile cache failed: {error}"))?,
        )
        .await
        .map_err(|error| format!("write profile cache failed: {error}"))?;
        Ok(())
    }

    async fn write_platform_profile_cache(ctx: &IpcContext, topology: Option<(&str, &str)>) {
        write_platform_profile_cache_for_store(ctx.config_store.as_ref(), topology)
            .await
            .expect("write profile cache");
    }

    async fn apply_platform_topology(ctx: &IpcContext, identity: &str, version: &str) {
        write_platform_profile_cache(ctx, Some((identity, version))).await;
    }

    async fn ensure_platform_profile(ctx: &IpcContext) {
        if ctx
            .config_store
            .load_provisioning_profile_cache_summary()
            .await
            .expect("load profile cache")
            .is_none()
        {
            write_platform_profile_cache(ctx, None).await;
        }
    }

    async fn update_profile_payment_capability(ctx: &IpcContext, payment_code_enabled: bool) {
        ensure_platform_profile(ctx).await;
        let path = ctx.config_store.provisioning_profile_cache_summary_path();
        let content = tokio::fs::read_to_string(&path)
            .await
            .expect("read profile cache");
        let mut profile: serde_json::Value =
            serde_json::from_str(&content).expect("profile cache json");
        profile["paymentCapability"] = json!({
            "profile": "production",
            "qrCodeEnabled": true,
            "paymentCodeEnabled": payment_code_enabled,
            "serverTime": "2026-06-08T16:30:00.000Z"
        });
        tokio::fs::write(
            path,
            serde_json::to_string_pretty(&profile).expect("profile cache json"),
        )
        .await
        .expect("write profile cache");
    }

    async fn remove_platform_profile_cache(ctx: &IpcContext) {
        match tokio::fs::remove_file(ctx.config_store.provisioning_profile_cache_summary_path())
            .await
        {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => panic!("remove profile cache failed: {error}"),
        }
    }

    async fn update_profile_hardware_profile_kind(ctx: &IpcContext, kind: &str) {
        ensure_platform_profile(ctx).await;
        let path = ctx.config_store.provisioning_profile_cache_summary_path();
        let content = tokio::fs::read_to_string(&path)
            .await
            .expect("read profile cache");
        let mut profile: serde_json::Value =
            serde_json::from_str(&content).expect("profile cache json");
        profile["hardwareProfile"]["profile"] = json!(kind);
        tokio::fs::write(
            path,
            serde_json::to_string_pretty(&profile).expect("profile cache json"),
        )
        .await
        .expect("write profile cache");
    }

    fn one_slot_planogram(
        planogram_version: &str,
        slot_id: &str,
        inventory_id: &str,
    ) -> serde_json::Value {
        json!({
            "planogramVersion": planogram_version,
            "source": "local_seed",
            "appliedBy": "operator-1",
            "slots": [{
                "slotId": slot_id,
                "slotCode": "A1",
                "layerNo": 1,
                "cellNo": 1,
                "capacity": 8,
                "parLevel": 6,
                "inventoryId": inventory_id,
                "variantId": "550e8400-e29b-41d4-a716-446655440003",
                "productId": "550e8400-e29b-41d4-a716-446655440004",
                "productName": "矿泉水",
                "productDescription": null,
                "coverImageUrl": null,
                "categoryId": null,
                "categoryName": null,
                "sku": "WATER-001",
                "size": "550ml",
                "color": null,
                "priceCents": 200,
                "productSortOrder": 1,
                "targetGender": null
            }]
        })
    }

    async fn record_attested_stock(
        app: &Router,
        planogram_version: &str,
        slot_id: &str,
        quantity: i64,
    ) {
        let response = post_json(
            app,
            "/v1/stock/attestation",
            "token-1",
            json!({
                "attestationId": format!("ATT-{planogram_version}"),
                "planogramVersion": planogram_version,
                "operatorId": "operator-1",
                "slots": [{
                    "slotId": slot_id,
                    "slotCode": "A1",
                    "sku": "WATER-001",
                    "quantity": quantity,
                    "enabled": true
                }]
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::CREATED);
    }

    async fn get_ipc_json(app: &Router, uri: &str, token: Option<&str>) -> serde_json::Value {
        let mut builder = Request::builder().method(Method::GET).uri(uri);
        if let Some(token) = token {
            builder = builder.header(AUTHORIZATION, format!("Bearer {token}"));
        }
        let response = app
            .clone()
            .oneshot(builder.body(axum::body::Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&body).unwrap()
    }

    fn valid_provisioning_profile() -> serde_json::Value {
        let public_key = crate::maintenance::public_key_from_private_key(
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        )
        .expect("fixture public key");
        json!({
            "machine": {
                "id": "550e8400-e29b-41d4-a716-446655440000",
                "code": "M001",
                "name": "Lobby",
                "status": "offline",
                "locationLabel": "1F"
            },
            "credentials": {
                "machineSecret": "vms_local-machine-shared-secret-change-before-prod",
                "machineSecretVersion": 2,
                "mqttSigningSecret": "vms_local-mqtt-shared-secret-change-before-prod",
                "mqttConnection": {
                    "url": "mqtt://broker.example:1883",
                    "clientId": "vem-machine-M001",
                    "username": "machine-client",
                    "password": "mqtt-password"
                }
            },
            "apiBaseUrl": "http://127.0.0.1:3000/api",
            "runtimeEndpoints": {
                "apiBasePath": "/api",
                "machineAuthTokenPath": "/api/machine-auth/token",
                "machineApiBasePath": "/api/machines/M001",
                "mqttTopicPrefix": "vem/machines/M001"
            },
            "hardwareProfile": {
                "profile": "production",
                "controller": { "required": true, "protocol": "vem-vending-controller" },
                "paymentScanner": { "required": true, "supportsPaymentCode": true },
                "vision": { "required": false, "supportsRecommendations": true }
            },
            "hardwareSlotTopology": {
                "identity": "vem-prod-24",
                "version": "2026-06-adr0026"
            },
            "paymentCapability": {
                "profile": "production",
                "qrCodeEnabled": true,
                "paymentCodeEnabled": true,
                "serverTime": "2026-06-08T16:30:00.000Z"
            },
            "provisioningProfile": "production",
            "maintenance": {
                "publicKey": public_key,
                "tunnelAddress": "10.91.16.10",
                "address": "10.91.16.10/32",
                "endpoint": "relay.example:51820",
                "relay": {
                    "publicKey": "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=",
                    "tunnelAddress": "10.91.0.1",
                    "address": "10.91.0.1/32"
                },
                "roleRoutes": {
                    "relay": "10.91.0.1/32",
                    "runner": "10.91.1.0/24",
                    "maintainer": "10.91.3.0/24"
                }
            },
            "metadata": {
                "profileVersion": 1,
                "claimCodeId": "550e8400-e29b-41d4-a716-446655440111",
                "claimedAt": "2026-06-08T16:30:00.000Z",
                "serverTime": "2026-06-08T16:30:00.000Z"
            }
        })
    }

    async fn post_json(
        app: &Router,
        uri: &str,
        token: &str,
        payload: serde_json::Value,
    ) -> axum::response::Response {
        app.clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri(uri)
                    .header(AUTHORIZATION, format!("Bearer {token}"))
                    .header("x-vem-maintenance-session", "test-maintenance-session")
                    .header(CONTENT_TYPE, "application/json")
                    .body(axum::body::Body::from(payload.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap()
    }

    async fn put_json(
        app: &Router,
        uri: &str,
        token: &str,
        payload: serde_json::Value,
    ) -> axum::response::Response {
        app.clone()
            .oneshot(
                Request::builder()
                    .method(Method::PUT)
                    .uri(uri)
                    .header(AUTHORIZATION, format!("Bearer {token}"))
                    .header(CONTENT_TYPE, "application/json")
                    .body(axum::body::Body::from(payload.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap()
    }

    async fn claim_with_profile(profile: serde_json::Value) -> (StatusCode, serde_json::Value) {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/machines/claim"))
            .respond_with(ResponseTemplate::new(200).set_body_json(profile))
            .mount(&server)
            .await;

        let temp_dir = tempdir().expect("tmp");
        let app =
            build_router(test_ipc_context(temp_dir.path(), "token-1", None, &server.uri()).await);

        let response = post_json(
            &app,
            "/v1/provisioning/claim",
            "token-1",
            json!({ "claimCode": "ABCD-2345" }),
        )
        .await;
        let status = response.status();
        let body = body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        (status, serde_json::from_slice(&body).unwrap())
    }

    #[tokio::test]
    async fn events_without_query_token_is_unauthorized() {
        let temp_dir = tempdir().expect("tmp");
        let app = build_router(
            test_ipc_context(temp_dir.path(), "test-token", None, "http://127.0.0.1:0").await,
        );

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/v1/events")
                    .header("Upgrade", "websocket")
                    .header("Connection", "Upgrade")
                    .header("Sec-WebSocket-Version", "13")
                    .header("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/v1/events?token=test-token")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .expect("response");
        assert_ne!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn provisioning_claim_applies_profile_to_public_config_without_returning_secrets() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/machines/claim"))
            .and(body_partial_json(json!({
                "claimCode": "ABCD-2345",
                "maintenancePublicKey": crate::maintenance::public_key_from_private_key(
                    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
                ).expect("fixture public key"),
                "provisioningProfile": "production"
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(valid_provisioning_profile()))
            .mount(&server)
            .await;

        let temp_dir = tempdir().expect("tmp");
        let app =
            build_router(test_ipc_context(temp_dir.path(), "token-1", None, &server.uri()).await);

        let response = post_json(
            &app,
            "/v1/provisioning/claim",
            "token-1",
            json!({ "claimCode": "ABCD-2345" }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let body = body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(payload["status"], "provisioned");
        let serialized = serde_json::to_string(&payload).unwrap();
        assert!(!serialized.contains("vms_local-machine"));
        assert!(!serialized.contains("vms_local-mqtt"));
        assert!(!serialized.contains("mqtt-password"));

        let config_response = app
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/v1/config")
                    .header(AUTHORIZATION, "Bearer token-1")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(config_response.status(), StatusCode::OK);
        let body = body::to_bytes(config_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let config: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(config["public"]["machineCode"], "M001");
        assert_eq!(config["public"]["mqttUrl"], "mqtt://broker.example:1883");
        assert_eq!(config["public"]["mqttUsername"], "machine-client");
        assert_eq!(config["machineSecretConfigured"], true);
        assert_eq!(config["mqttSigningSecretConfigured"], true);
        assert_eq!(config["mqttPasswordConfigured"], true);
        let config_text = serde_json::to_string(&config).unwrap();
        assert!(!config_text.contains("vms_local-machine"));
        assert!(!config_text.contains("vms_local-mqtt"));
        assert!(!config_text.contains("mqtt-password"));
    }

    #[tokio::test]
    async fn provisioning_claim_uses_factory_manifest_endpoint_when_legacy_config_is_stale() {
        let stale_legacy_server = MockServer::start().await;
        let factory_server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/machines/claim"))
            .and(body_partial_json(json!({
                "claimCode": "ABCD-2345"
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(valid_provisioning_profile()))
            .mount(&factory_server)
            .await;

        let temp_dir = tempdir().expect("tmp");
        let root = temp_dir.path();
        let data_dir = root.join("vending-daemon");
        tokio::fs::create_dir_all(root.join("factory"))
            .await
            .expect("factory dir");
        tokio::fs::write(
            root.join("factory").join("factory-manifest.json"),
            json!({
                "layoutVersion": 1,
                "environment": "production",
                "provisioningEndpoint": factory_server.uri(),
                "hardwareMode": "production",
                "hardwareModel": "VEM-PROD-24",
                "hardwareSlotTopology": {
                    "identity": "vem-prod-24",
                    "version": "2026-07-01"
                }
            })
            .to_string(),
        )
        .await
        .expect("write factory manifest");
        let app = build_router(
            test_ipc_context(&data_dir, "token-1", None, &stale_legacy_server.uri()).await,
        );
        let _ = tokio::fs::remove_file(root.join("bringup").join("local-settings.json")).await;

        let response = post_json(
            &app,
            "/v1/provisioning/claim",
            "token-1",
            json!({ "claimCode": "ABCD-2345" }),
        )
        .await;

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            factory_server
                .received_requests()
                .await
                .unwrap()
                .into_iter()
                .filter(|request| request.url.path() == "/machines/claim")
                .count(),
            1
        );
        assert_eq!(
            stale_legacy_server
                .received_requests()
                .await
                .unwrap()
                .into_iter()
                .filter(|request| request.url.path() == "/machines/claim")
                .count(),
            0
        );
    }

    #[tokio::test]
    async fn provisioning_claim_writes_profile_cache_layer_for_effective_runtime_config() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/machines/claim"))
            .respond_with(ResponseTemplate::new(200).set_body_json(valid_provisioning_profile()))
            .mount(&server)
            .await;

        let temp_dir = tempdir().expect("tmp");
        let data_dir = temp_dir.path().join("vending-daemon");
        let app = build_router(test_ipc_context(&data_dir, "token-1", None, &server.uri()).await);

        let response = post_json(
            &app,
            "/v1/provisioning/claim",
            "token-1",
            json!({ "claimCode": "ABCD-2345" }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);

        let summary_response = app
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/v1/config/summary")
                    .header(AUTHORIZATION, "Bearer token-1")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(summary_response.status(), StatusCode::OK);
        let body = body::to_bytes(summary_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let summary: serde_json::Value = serde_json::from_slice(&body).unwrap();

        assert_eq!(summary["configuredState"]["provisioningProfileCache"], true);
        assert_eq!(summary["provisioningProfileCache"]["machineCode"], "M001");
        assert_eq!(
            summary["provisioningProfileCache"]["runtimeEndpoints"]["machineApiBasePath"],
            "/api/machines/M001"
        );
        assert_eq!(
            summary["provisioningProfileCache"]["paymentCapability"]["paymentCodeEnabled"],
            true
        );
        assert_eq!(
            summary["effectivePublic"]["provisioningMetadata"]["claimCodeId"],
            "550e8400-e29b-41d4-a716-446655440111"
        );
    }

    #[tokio::test]
    async fn config_put_rejects_legacy_machine_location_text() {
        let temp_dir = tempdir().expect("tmp");
        let app = build_router(
            test_ipc_context(temp_dir.path(), "token-1", None, "http://127.0.0.1:0").await,
        );

        let response = put_json(
            &app,
            "/v1/config",
            "token-1",
            json!({
                "public": {
                    "machineCode": "M001",
                    "machineLocationText": "Legacy lobby",
                    "apiBaseUrl": "http://127.0.0.1:3000/api",
                    "mqttUrl": "mqtt://127.0.0.1:1883",
                    "mqttUsername": null,
                    "hardwareAdapter": "mock",
                    "serialPortPath": null,
                    "lowerControllerUsbIdentity": null,
                    "scannerAdapter": "disabled",
                    "scannerSerialPortPath": null,
                    "scannerBaudRate": 9600,
                    "scannerFrameSuffix": "crlf",
                    "visionEnabled": false,
                    "visionWsUrl": "ws://127.0.0.1:7892/ws",
                    "visionRequestTimeoutMs": 8000,
                    "kioskMode": false
                },
                "secrets": null
            }),
        )
        .await;

        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    }

    #[tokio::test]
    async fn provisioning_claim_does_not_apply_planogram_and_keeps_readiness_blocked() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/machines/claim"))
            .respond_with(ResponseTemplate::new(200).set_body_json(valid_provisioning_profile()))
            .mount(&server)
            .await;

        let temp_dir = tempdir().expect("tmp");
        let ctx = test_ipc_context(temp_dir.path(), "token-1", None, &server.uri()).await;
        let app = build_router(ctx.clone());

        let response = post_json(
            &app,
            "/v1/provisioning/claim",
            "token-1",
            json!({ "claimCode": "ABCD-2345" }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let body = body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let claim: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(claim["status"], "provisioned");
        assert!(!serde_json::to_string(&claim).unwrap().contains("planogram"));

        mark_runtime_sale_ready(&ctx).await;

        let sale_view = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/v1/sale-view")
                    .header(AUTHORIZATION, "Bearer token-1")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(sale_view.status(), StatusCode::OK);
        let body = body::to_bytes(sale_view.into_body(), usize::MAX)
            .await
            .unwrap();
        let sale_view: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(sale_view["planogramVersion"], serde_json::Value::Null);
        assert_eq!(sale_view["items"].as_array().unwrap().len(), 0);

        let readiness = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/v1/sale-readiness")
                    .header(AUTHORIZATION, "Bearer token-1")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(readiness.status(), StatusCode::OK);
        let body = body::to_bytes(readiness.into_body(), usize::MAX)
            .await
            .unwrap();
        let readiness: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(readiness["canStartNetworkAuthorizedSale"], false);
        assert_eq!(readiness["components"]["activePlanogram"]["ready"], false);
        assert!(readiness["blockingCodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|code| code == "ACTIVE_PLANOGRAM_MISSING"));
        assert!(readiness["blockingCodes"]
            .as_array()
            .unwrap()
            .iter()
            .all(|code| !code
                .as_str()
                .unwrap_or_default()
                .contains("MAINTENANCE_HANDSHAKE")));

        let maintenance = get_ipc_json(&app, "/v1/maintenance/status", Some("token-1")).await;
        assert_eq!(maintenance["state"], "handshake_pending");

        let requests = server.received_requests().await.expect("requests");
        assert_eq!(
            requests
                .iter()
                .filter(|request| request.url.path() == "/machines/claim")
                .count(),
            1
        );
        assert!(requests
            .iter()
            .all(|request| !request.url.path().contains("planogram-versions")));
    }

    #[tokio::test]
    async fn same_device_reclaim_keeps_intact_local_stock_ledger_trusted() {
        let server = MockServer::start().await;

        let temp_dir = tempdir().expect("tmp");
        write_factory_manifest(temp_dir.path(), "vem-prod-24", "2026-06-adr0026").await;
        let factory_manifest_path = temp_dir.path().join("factory/factory-manifest.json");
        let mut factory_manifest: serde_json::Value = serde_json::from_slice(
            &tokio::fs::read(&factory_manifest_path)
                .await
                .expect("read factory manifest"),
        )
        .expect("decode factory manifest");
        factory_manifest["environment"] = json!("production");
        tokio::fs::write(
            factory_manifest_path,
            serde_json::to_vec(&factory_manifest).expect("encode factory manifest"),
        )
        .await
        .expect("write production factory manifest");
        let mut ctx = test_ipc_context(
            temp_dir.path(),
            "token-1",
            Some("MACHINE-1".to_string()),
            &server.uri(),
        )
        .await;
        let mut active_profile: crate::config::MachineProvisioningProfile =
            serde_json::from_value(valid_provisioning_profile()).expect("active profile");
        active_profile.api_base_url = server.uri();
        let active_maintenance = active_profile.maintenance.clone();
        ctx.config_store
            .apply_provisioning_profile(active_profile)
            .await
            .expect("apply active profile");
        ctx.config_store
            .apply_maintenance_profile(&active_maintenance, false)
            .await
            .expect("apply active maintenance identity");
        mark_runtime_sale_ready(&ctx).await;
        mark_claim_task_available(&ctx).await;
        ctx.maintenance_authorization = Arc::new(TestMaintenanceAuthorization { allow: true });
        let app = build_router(ctx.clone());
        let slot_id = "550e8400-e29b-41d4-a716-4466554400d1";
        let inventory_id = "550e8400-e29b-41d4-a716-4466554400d2";
        assert_eq!(
            post_json(
                &app,
                "/v1/stock/planogram",
                "token-1",
                one_slot_planogram("PLAN-RECLAIM-INTACT", slot_id, inventory_id),
            )
            .await
            .status(),
            StatusCode::OK
        );
        assert_eq!(
            post_json(
                &app,
                "/v1/stock/movements",
                "token-1",
                json!({
                    "movementId": "MOVE-RECLAIM-INTACT",
                    "planogramVersion": "PLAN-RECLAIM-INTACT",
                    "slotId": slot_id,
                    "movementType": "planned_refill",
                    "quantity": 4,
                    "source": "field_service",
                    "attributedTo": "operator-1"
                }),
            )
            .await
            .status(),
            StatusCode::CREATED
        );

        mark_claim_task_available(&ctx).await;
        ctx.config_store
            .request_machine_reclaim()
            .await
            .expect("persist reclaim request");
        let next_public_key = ctx
            .config_store
            .ensure_reclaim_maintenance_public_key("ABCD-2345")
            .await
            .expect("prepare reclaim key");
        let mut reclaimed_profile = valid_provisioning_profile();
        reclaimed_profile["maintenance"]["publicKey"] = json!(next_public_key);
        reclaimed_profile["maintenance"]["reclaimExpiresAt"] = json!("2030-01-01T00:00:00Z");
        Mock::given(method("POST"))
            .and(path("/machines/claim"))
            .respond_with(ResponseTemplate::new(200).set_body_json(reclaimed_profile))
            .mount(&server)
            .await;
        let app = build_router(ctx);
        let snapshot = get_ipc_json(&app, "/v1/bring-up", Some("token-1")).await;
        assert_eq!(snapshot["currentTask"]["kind"], "reclaim_machine");

        assert_eq!(
            post_json(
                &app,
                "/v1/bring-up/tasks/execute",
                "token-1",
                json!({
                    "contractVersion": 1,
                    "taskId": "bring_up.reclaim_machine",
                    "taskVersion": 1,
                    "kind": "reclaim_machine",
                    "intent": "reclaim_machine",
                    "mutation": {
                        "type": "claim_machine",
                        "claimCode": "ABCD-2345",
                        "maintenanceAuthorization": { "sessionId": "protected-session-1" }
                    }
                }),
            )
            .await
            .status(),
            StatusCode::OK
        );

        let sale_view = app
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/v1/sale-view")
                    .header(AUTHORIZATION, "Bearer token-1")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(sale_view.status(), StatusCode::OK);
        let body = body::to_bytes(sale_view.into_body(), usize::MAX)
            .await
            .unwrap();
        let sale_view: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(sale_view["planogramVersion"], "PLAN-RECLAIM-INTACT");
        assert_eq!(sale_view["items"][0]["physicalStock"], 4);
        assert_eq!(sale_view["items"][0]["saleableStock"], 4);
        assert_eq!(sale_view["items"][0]["slotSalesState"], "sale_ready");
    }

    #[tokio::test]
    async fn ledger_missing_reclaim_keeps_newly_applied_slots_blocked_until_counted() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/machines/claim"))
            .respond_with(ResponseTemplate::new(200).set_body_json(valid_provisioning_profile()))
            .mount(&server)
            .await;

        let temp_dir = tempdir().expect("tmp");
        let ctx = test_ipc_context(temp_dir.path(), "token-1", None, &server.uri()).await;
        ctx.state
            .put_metadata("stock_ledger_rebuilt_after_quarantine", &true)
            .await
            .expect("ledger loss marker");
        let app = build_router(ctx);

        assert_eq!(
            post_json(
                &app,
                "/v1/provisioning/claim",
                "token-1",
                json!({ "claimCode": "ABCD-2345" }),
            )
            .await
            .status(),
            StatusCode::OK
        );
        write_factory_manifest(temp_dir.path(), "vem-prod-24", "2026-06-adr0026").await;

        let slot_id = "550e8400-e29b-41d4-a716-4466554400f1";
        let inventory_id = "550e8400-e29b-41d4-a716-4466554400f2";
        assert_eq!(
            post_json(
                &app,
                "/v1/stock/planogram",
                "token-1",
                one_slot_planogram("PLAN-RECLAIM-MISSING-LEDGER", slot_id, inventory_id),
            )
            .await
            .status(),
            StatusCode::OK
        );

        let sale_view = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/v1/sale-view")
                    .header(AUTHORIZATION, "Bearer token-1")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(sale_view.status(), StatusCode::OK);
        let body = body::to_bytes(sale_view.into_body(), usize::MAX)
            .await
            .unwrap();
        let sale_view: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(sale_view["items"][0]["physicalStock"], 0);
        assert_eq!(sale_view["items"][0]["saleableStock"], 0);
        assert_eq!(sale_view["items"][0]["slotSalesState"], "needs_count");

        assert_eq!(
            post_json(
                &app,
                "/v1/stock/movements",
                "token-1",
                json!({
                    "movementId": "MOVE-RECLAIM-MISSING-LEDGER-COUNT",
                    "planogramVersion": "PLAN-RECLAIM-MISSING-LEDGER",
                    "slotId": slot_id,
                    "movementType": "stock_count_correction",
                    "quantity": 3,
                    "source": "field_service",
                    "attributedTo": "operator-1"
                }),
            )
            .await
            .status(),
            StatusCode::CREATED
        );

        let sale_view = app
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/v1/sale-view")
                    .header(AUTHORIZATION, "Bearer token-1")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = body::to_bytes(sale_view.into_body(), usize::MAX)
            .await
            .unwrap();
        let sale_view: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(sale_view["items"][0]["physicalStock"], 3);
        assert_eq!(sale_view["items"][0]["saleableStock"], 3);
        assert_eq!(sale_view["items"][0]["slotSalesState"], "sale_ready");
    }

    #[tokio::test]
    async fn config_does_not_treat_machine_code_alone_as_provisioned() {
        let temp_dir = tempdir().expect("tmp");
        let app = build_router(
            test_ipc_context(
                temp_dir.path(),
                "token-1",
                Some("MACHINE-CODE-ONLY".to_string()),
                "http://127.0.0.1:0",
            )
            .await,
        );

        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/v1/config")
                    .header(AUTHORIZATION, "Bearer token-1")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let config: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(config["provisioned"], false);
        assert!(config["provisioningIssues"]
            .as_array()
            .unwrap()
            .iter()
            .any(|issue| issue == "machine_secret_missing"));
    }

    #[tokio::test]
    async fn failed_claim_returns_safe_diagnostic_without_echoing_sensitive_inputs() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/machines/claim"))
            .respond_with(ResponseTemplate::new(400).set_body_json(json!({
                "message": "claim ABCD-2345 rejected with vms_local-machine-shared-secret-change-before-prod"
            })))
            .mount(&server)
            .await;

        let temp_dir = tempdir().expect("tmp");
        let app =
            build_router(test_ipc_context(temp_dir.path(), "token-1", None, &server.uri()).await);

        let response = post_json(
            &app,
            "/v1/provisioning/claim",
            "token-1",
            json!({ "claimCode": "ABCD-2345" }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(payload["code"], "machine_claim_invalid_or_expired");
        let text = serde_json::to_string(&payload).unwrap();
        assert!(!text.contains("ABCD-2345"));
        assert!(!text.contains("vms_local-machine"));
        assert!(payload["message"]
            .as_str()
            .unwrap()
            .contains("invalid or expired"));
    }

    #[tokio::test]
    async fn failed_claim_treats_service_unauthorized_as_invalid_claim() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/machines/claim"))
            .respond_with(ResponseTemplate::new(401).set_body_json(json!({
                "code": 401,
                "message": "Invalid or expired machine claim code",
                "data": null
            })))
            .mount(&server)
            .await;

        let temp_dir = tempdir().expect("tmp");
        let app =
            build_router(test_ipc_context(temp_dir.path(), "token-1", None, &server.uri()).await);

        let response = post_json(
            &app,
            "/v1/provisioning/claim",
            "token-1",
            json!({ "claimCode": "WXYZ-2345" }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(payload["code"], "machine_claim_invalid_or_expired");
        assert!(payload["message"]
            .as_str()
            .unwrap()
            .contains("invalid or expired"));
    }

    #[tokio::test]
    async fn failed_claim_treats_missing_claim_endpoint_as_backend_unavailable() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/machines/claim"))
            .respond_with(ResponseTemplate::new(404).set_body_json(json!({
                "message": "not found"
            })))
            .mount(&server)
            .await;

        let temp_dir = tempdir().expect("tmp");
        let app =
            build_router(test_ipc_context(temp_dir.path(), "token-1", None, &server.uri()).await);

        let response = post_json(
            &app,
            "/v1/provisioning/claim",
            "token-1",
            json!({ "claimCode": "WXYZ-2345" }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        let body = body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(payload["code"], "machine_claim_backend_unavailable");
    }

    #[tokio::test]
    async fn failed_claim_preserves_safe_backend_claim_code_without_echoing_payload() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/machines/claim"))
            .respond_with(ResponseTemplate::new(409).set_body_json(json!({
                "code": "machine_claim_locked",
                "message": "claim ABCD-2345 locked with vms_local-machine-shared-secret-change-before-prod"
            })))
            .mount(&server)
            .await;

        let temp_dir = tempdir().expect("tmp");
        let app =
            build_router(test_ipc_context(temp_dir.path(), "token-1", None, &server.uri()).await);

        let response = post_json(
            &app,
            "/v1/provisioning/claim",
            "token-1",
            json!({ "claimCode": "ABCD-2345" }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(payload["code"], "machine_claim_locked");
        let text = serde_json::to_string(&payload).unwrap();
        assert!(!text.contains("ABCD-2345"));
        assert!(!text.contains("vms_local-machine"));
        assert!(payload["message"]
            .as_str()
            .unwrap()
            .contains("claim code cannot be used"));
    }

    #[tokio::test]
    async fn failed_claim_reports_backend_unavailable_separately_from_rejected_code() {
        let temp_dir = tempdir().expect("tmp");
        let app = build_router(
            test_ipc_context(temp_dir.path(), "token-1", None, "http://127.0.0.1:9").await,
        );

        let response = post_json(
            &app,
            "/v1/provisioning/claim",
            "token-1",
            json!({ "claimCode": "ABCD-2345" }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        let body = body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(payload["code"], "machine_claim_backend_unavailable");
        let text = serde_json::to_string(&payload).unwrap();
        assert!(!text.contains("ABCD-2345"));
    }

    #[tokio::test]
    async fn failed_claim_without_default_api_base_url_fails_closed_before_backend_claim() {
        let temp_dir = tempdir().expect("tmp");
        let app = build_router(test_ipc_context(temp_dir.path(), "token-1", None, "").await);

        let response = post_json(
            &app,
            "/v1/provisioning/claim",
            "token-1",
            json!({ "claimCode": "ABCD-2345" }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::CONFLICT);
        let body = body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(payload["code"], "bring_up_task_stale");
        let text = serde_json::to_string(&payload).unwrap();
        assert!(!text.contains("ABCD-2345"));
        assert!(!text.contains("apiBaseUrl"));
    }

    #[tokio::test]
    async fn successful_claim_requests_runtime_reconfiguration() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/machines/claim"))
            .respond_with(ResponseTemplate::new(200).set_body_json(valid_provisioning_profile()))
            .mount(&server)
            .await;

        let temp_dir = tempdir().expect("tmp");
        let ctx = test_ipc_context(temp_dir.path(), "token-1", None, &server.uri()).await;
        let mut events = ctx.events.subscribe();
        let app = build_router(ctx);

        let response = post_json(
            &app,
            "/v1/provisioning/claim",
            "token-1",
            json!({ "claimCode": "ABCD-2345" }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let body = body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(payload["restartRequested"], true);

        let event = tokio::time::timeout(std::time::Duration::from_secs(1), events.recv())
            .await
            .expect("runtime reconfigure event")
            .expect("event");
        let event = serde_json::to_value(event).unwrap();
        assert_eq!(event["type"], "runtime_reconfigure_requested");
        assert_eq!(event["reason"], "machine_provisioned");
        assert_eq!(event["machineCode"], "M001");
    }

    #[tokio::test]
    async fn claim_rejects_a_response_for_a_different_factory_profile() {
        let server = MockServer::start().await;
        let mut profile = valid_provisioning_profile();
        profile["provisioningProfile"] = json!("testbed");
        Mock::given(method("POST"))
            .and(path("/machines/claim"))
            .respond_with(ResponseTemplate::new(200).set_body_json(profile))
            .mount(&server)
            .await;

        let temp_dir = tempdir().expect("tmp");
        let app =
            build_router(test_ipc_context(temp_dir.path(), "token-1", None, &server.uri()).await);

        let response = post_json(
            &app,
            "/v1/provisioning/claim",
            "token-1",
            json!({ "claimCode": "ABCD-2345" }),
        )
        .await;

        assert_eq!(response.status(), StatusCode::CONFLICT);
        let body = body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("response body");
        let payload: serde_json::Value = serde_json::from_slice(&body).expect("response json");
        assert_eq!(payload["code"], "provisioning_profile_mismatch");
    }

    #[tokio::test]
    async fn provisioning_claim_records_metadata_and_public_profile_diagnostics() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/machines/claim"))
            .respond_with(ResponseTemplate::new(200).set_body_json(valid_provisioning_profile()))
            .mount(&server)
            .await;

        let temp_dir = tempdir().expect("tmp");
        let app =
            build_router(test_ipc_context(temp_dir.path(), "token-1", None, &server.uri()).await);

        assert_eq!(
            post_json(
                &app,
                "/v1/provisioning/claim",
                "token-1",
                json!({ "claimCode": "ABCD-2345" }),
            )
            .await
            .status(),
            StatusCode::OK
        );

        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/v1/config")
                    .header(AUTHORIZATION, "Bearer token-1")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let config: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(config["provisioned"], true);
        assert_eq!(
            config["public"]["machineId"],
            "550e8400-e29b-41d4-a716-446655440000"
        );
        assert_eq!(
            config["public"]["provisioningMetadata"]["claimCodeId"],
            "550e8400-e29b-41d4-a716-446655440111"
        );
        assert_eq!(
            config["public"]["provisioningMetadata"]["profileVersion"],
            1
        );
        assert_eq!(
            config["public"]["provisioningMetadata"]["claimedAt"],
            "2026-06-08T16:30:00.000Z"
        );
        assert_eq!(
            config["public"]["runtimeEndpoints"]["machineApiBasePath"],
            "/api/machines/M001"
        );
        assert_eq!(
            config["public"]["paymentCapability"]["paymentCodeEnabled"],
            true
        );
        assert_eq!(
            config["public"]["hardwareProfile"]["paymentScanner"]["supportsPaymentCode"],
            true
        );
    }

    #[tokio::test]
    async fn invalid_provisioning_profile_is_rejected_before_persistence() {
        let server = MockServer::start().await;
        let mut profile = valid_provisioning_profile();
        profile["metadata"]["profileVersion"] = json!(2);
        Mock::given(method("POST"))
            .and(path("/machines/claim"))
            .respond_with(ResponseTemplate::new(200).set_body_json(profile))
            .mount(&server)
            .await;

        let temp_dir = tempdir().expect("tmp");
        let app =
            build_router(test_ipc_context(temp_dir.path(), "token-1", None, &server.uri()).await);

        let response = post_json(
            &app,
            "/v1/provisioning/claim",
            "token-1",
            json!({ "claimCode": "ABCD-2345" }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(payload["code"], "machine_profile_invalid");
        assert_eq!(
            payload["message"],
            "unsupported provisioning profile version"
        );

        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/v1/config")
                    .header(AUTHORIZATION, "Bearer token-1")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let config: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(config["public"]["machineCode"], serde_json::Value::Null);
        assert_eq!(config["provisioned"], false);
    }

    #[tokio::test]
    async fn provisioning_profile_with_mock_payment_capability_is_rejected() {
        let server = MockServer::start().await;
        let mut profile = valid_provisioning_profile();
        profile["paymentCapability"]["mockEnabled"] = json!(true);
        Mock::given(method("POST"))
            .and(path("/machines/claim"))
            .respond_with(ResponseTemplate::new(200).set_body_json(profile))
            .mount(&server)
            .await;

        let temp_dir = tempdir().expect("tmp");
        let app =
            build_router(test_ipc_context(temp_dir.path(), "token-1", None, &server.uri()).await);

        let response = post_json(
            &app,
            "/v1/provisioning/claim",
            "token-1",
            json!({ "claimCode": "ABCD-2345" }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(payload["code"], "machine_profile_invalid");
    }

    #[tokio::test]
    async fn provisioning_profile_rejects_face_payment_capability() {
        let mut profile = valid_provisioning_profile();
        profile["paymentCapability"]["facePayEnabled"] = json!(true);
        let (status, payload) = claim_with_profile(profile).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(payload["code"], "machine_profile_invalid");
    }

    #[tokio::test]
    async fn provisioning_profile_rejects_secret_shaped_payment_capability_fields() {
        let mut profile = valid_provisioning_profile();
        profile["paymentCapability"]["merchantPrivateKey"] =
            json!("should-not-be-in-machine-profile");
        let (status, payload) = claim_with_profile(profile).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(payload["code"], "machine_profile_invalid");
        assert!(!serde_json::to_string(&payload)
            .unwrap()
            .contains("merchantPrivateKey"));
    }

    #[tokio::test]
    async fn provisioning_profile_rejects_unknown_profile_fields() {
        let mut profile = valid_provisioning_profile();
        profile["hardwareProfile"]["controller"]["diagnostics"] = json!({"enabled": true});

        let (status, payload) = claim_with_profile(profile).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(payload["code"], "machine_profile_invalid");
    }

    #[tokio::test]
    async fn provisioning_profile_rejects_local_discovery_fields() {
        let mut profile = valid_provisioning_profile();
        profile["hardwareProfile"]["controller"]["serialPortPath"] = json!("/dev/ttyUSB0");
        profile["hardwareProfile"]["controller"]["usbVendorId"] = json!("1A86");

        let (status, payload) = claim_with_profile(profile).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(payload["code"], "machine_profile_invalid");
    }

    #[tokio::test]
    async fn provisioning_profile_rejects_stock_and_catalog_fields() {
        let mut profile = valid_provisioning_profile();
        profile["hardwareProfile"]["stock"] = json!({"slots": []});
        profile["paymentCapability"]["catalogSnapshot"] = json!({"items": []});

        let (status, payload) = claim_with_profile(profile).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(payload["code"], "machine_profile_invalid");
    }

    #[tokio::test]
    async fn provisioning_profile_rejects_payment_secret_fields() {
        let mut profile = valid_provisioning_profile();
        profile["paymentCapability"]["wechatPayMchPrivateKey"] =
            json!("-----BEGIN PRIVATE KEY-----");
        profile["paymentCapability"]["alipayAppPrivateKey"] = json!("secret");

        let (status, payload) = claim_with_profile(profile).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(payload["code"], "machine_profile_invalid");
        let text = serde_json::to_string(&payload).unwrap();
        assert!(!text.contains("PRIVATE KEY"));
        assert!(!text.contains("alipayAppPrivateKey"));
    }

    #[tokio::test]
    async fn provisioning_persistence_failure_is_not_reported_as_invalid_profile_or_partial_secrets(
    ) {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/machines/claim"))
            .respond_with(ResponseTemplate::new(200).set_body_json(valid_provisioning_profile()))
            .mount(&server)
            .await;

        let temp_dir = tempdir().expect("tmp");
        let ctx = test_ipc_context(temp_dir.path(), "token-1", None, &server.uri()).await;
        let logs_path = ctx.data_dir.join("logs");
        let app = build_router(ctx);
        tokio::fs::remove_dir_all(&logs_path)
            .await
            .expect("remove logs dir");
        tokio::fs::write(&logs_path, b"not-a-directory")
            .await
            .expect("replace logs dir with file");

        let response = post_json(
            &app,
            "/v1/provisioning/claim",
            "token-1",
            json!({ "claimCode": "ABCD-2345" }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        let body = body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(payload["code"], "machine_profile_persistence_failed");
        let text = serde_json::to_string(&payload).unwrap();
        assert!(!text.contains("vms_local-machine"));
        assert!(!text.contains("vms_local-mqtt"));
        assert!(!text.contains("mqtt-password"));

        let config_response = app
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/v1/config")
                    .header(AUTHORIZATION, "Bearer token-1")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(config_response.status(), StatusCode::OK);
        let body = body::to_bytes(config_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let config: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(config["machineSecretConfigured"], false);
        assert_eq!(config["mqttSigningSecretConfigured"], false);
        assert_eq!(config["mqttPasswordConfigured"], false);
        let config_text = serde_json::to_string(&config).unwrap();
        assert!(!config_text.contains("vms_local-machine"));
        assert!(!config_text.contains("vms_local-mqtt"));
        assert!(!config_text.contains("mqtt-password"));
    }

    #[tokio::test]
    async fn api_endpoints_require_bearer_token() {
        let temp_dir = tempdir().expect("tmp");
        let app = build_router(
            test_ipc_context(
                temp_dir.path(),
                "token-1",
                Some("MACHINE-1".to_string()),
                "http://127.0.0.1:0",
            )
            .await,
        );
        assert_eq!(
            call_status_request(Method::GET, "/v1/catalog", None, &app).await,
            StatusCode::UNAUTHORIZED,
        );
        assert_eq!(
            call_status_request(Method::GET, "/v1/payment-options", None, &app).await,
            StatusCode::UNAUTHORIZED,
        );
        assert_eq!(
            call_status_request(Method::GET, "/v1/transactions/current", None, &app).await,
            StatusCode::UNAUTHORIZED,
        );
        assert_eq!(
            call_status_request(Method::GET, "/v1/sync/status", None, &app).await,
            StatusCode::UNAUTHORIZED,
        );

        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(wiremock::matchers::path("/machine-orders/payment-options"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "options": [],
            })))
            .mount(&server)
            .await;

        let app = build_router(
            test_ipc_context(
                temp_dir.path(),
                "token-1",
                Some("MACHINE-1".to_string()),
                &server.uri(),
            )
            .await,
        );
        assert_eq!(
            call_status_request(Method::GET, "/v1/catalog", Some("token-1"), &app).await,
            StatusCode::OK,
        );
        assert_eq!(
            call_status_request(Method::GET, "/v1/payment-options", Some("token-1"), &app).await,
            StatusCode::OK,
        );
        assert_eq!(
            call_status_request(
                Method::GET,
                "/v1/transactions/current",
                Some("token-1"),
                &app
            )
            .await,
            StatusCode::OK,
        );
        assert_eq!(
            call_status_request(Method::GET, "/v1/sync/status", Some("token-1"), &app).await,
            StatusCode::OK,
        );
    }

    #[tokio::test]
    async fn current_transaction_ipc_output_does_not_emit_legacy_checkout_actions() {
        let temp_dir = tempdir().expect("tmp");
        let ctx = test_ipc_context(temp_dir.path(), "token-1", None, "http://127.0.0.1:0").await;
        sqlx::query(
            "INSERT INTO order_sessions(
                order_no,payment_method,payment_provider,payment_attempt_json,items_json,status,
                next_action,expires_at,last_backend_status_json,last_error,recovery_strategy,updated_at
             ) VALUES (?1,'payment_code','alipay',NULL,'[]','waiting_payment',?2,NULL,?3,NULL,'local',?4)",
        )
        .bind("ORDER-IPC-LEGACY")
        .bind("submit_payment")
        .bind(json!({
            "orderStatus": "pending_payment",
            "nextAction": "submit_payment",
            "totalAmountCents": 300,
            "payment": {
                "method": "payment_code",
                "providerCode": "alipay"
            }
        }).to_string())
        .bind(crate::state::store::now_iso())
        .execute(ctx.state.pool())
        .await
        .expect("seed legacy transaction");
        let app = build_router(ctx);

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/v1/transactions/current")
                    .header(AUTHORIZATION, "Bearer token-1")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();

        assert_eq!(payload["nextAction"], "wait_payment");
        let text = serde_json::to_string(&payload).unwrap();
        assert!(!text.contains("submit_payment"));
        assert!(!text.contains("collect_goods"));
    }

    #[tokio::test]
    async fn current_transaction_ipc_output_matches_generated_contract_boundary() {
        let temp_dir = tempdir().expect("tmp");
        let ctx = test_ipc_context(temp_dir.path(), "token-1", None, "http://127.0.0.1:0").await;
        ctx.state
            .upsert_order_session(crate::state::store::OrderSessionUpsert {
                order_no: "ORDER-IPC-CONTRACT",
                payment_method: "payment_code",
                payment_provider: Some("alipay"),
                items_json: json!([{"sku":"SKU-1","name":"Water","quantity":1}]),
                status: "waiting_payment",
                next_action: "wait_payment",
                payment_attempt_json: None,
                recovery_strategy: "local",
                last_backend_status_json: Some(json!({
                    "orderStatus": "pending_payment",
                    "nextAction": "wait_payment",
                    "totalAmountCents": 300,
                    "payment": {
                        "method": "payment_code",
                        "providerCode": "alipay"
                    }
                })),
                last_error: None,
            })
            .await
            .expect("seed current transaction");
        let app = build_router(ctx);

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/v1/transactions/current")
                    .header(AUTHORIZATION, "Bearer token-1")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let snapshot: daemon_ipc_contracts::CurrentTransactionSnapshot =
            serde_json::from_slice(&body).expect("response uses generated transaction DTO");
        daemon_ipc_contracts::validate_current_transaction_snapshot_boundary(&snapshot)
            .expect("response passes generated contract boundary validation");
        assert_eq!(
            snapshot.next_action,
            Some(daemon_ipc_contracts::CheckoutFlowAction::WaitPayment)
        );
    }

    #[tokio::test]
    async fn current_transaction_ipc_output_accepts_pickup_reminder_progress() {
        let temp_dir = tempdir().expect("tmp");
        let ctx = test_ipc_context(temp_dir.path(), "token-1", None, "http://127.0.0.1:0").await;
        ctx.state
            .upsert_order_session(crate::state::store::OrderSessionUpsert {
                order_no: "ORDER-IPC-PICKUP",
                payment_method: "payment_code",
                payment_provider: Some("alipay"),
                items_json: json!([{"sku":"SKU-1","name":"Water","quantity":1}]),
                status: "dispensing",
                next_action: "dispensing",
                payment_attempt_json: None,
                recovery_strategy: "local",
                last_backend_status_json: Some(json!({
                    "orderStatus": "dispensing",
                    "nextAction": "dispensing",
                    "totalAmountCents": 300,
                    "payment": {
                        "method": "payment_code",
                        "providerCode": "alipay",
                        "status": "succeeded"
                    },
                    "vending": {
                        "commandNo": "CMD-IPC-PICKUP",
                        "status": "sent",
                        "lastError": null
                    }
                })),
                last_error: None,
            })
            .await
            .expect("seed pickup transaction");
        ctx.state
            .record_dispense_progress(&DispenseProgressEvent {
                command_no: "CMD-IPC-PICKUP".to_string(),
                order_no: "ORDER-IPC-PICKUP".to_string(),
                stage: DispenseProgressStage::PickupTimeoutWarning,
                warning_no: Some(2),
                message: "Please collect the item now".to_string(),
                reported_at: "2026-06-13T09:00:00.000Z".to_string(),
            })
            .await
            .expect("record progress");
        let app = build_router(ctx);

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/v1/transactions/current")
                    .header(AUTHORIZATION, "Bearer token-1")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(payload["nextAction"], "dispensing");
        assert_eq!(payload["orderStatus"], "dispensing");
        assert_eq!(payload["vending"]["status"], "acknowledged");
        assert_eq!(
            payload["vending"]["pickupReminder"]["stage"],
            "pickup_timeout_warning"
        );
        let snapshot: daemon_ipc_contracts::CurrentTransactionSnapshot =
            serde_json::from_slice(&body).expect("response uses generated transaction DTO");
        daemon_ipc_contracts::validate_current_transaction_snapshot_boundary(&snapshot)
            .expect("pickup reminder response passes contract validation");
    }

    #[tokio::test]
    async fn current_transaction_ipc_output_rejects_legacy_minimal_row_with_diagnostic() {
        let temp_dir = tempdir().expect("tmp");
        let ctx = test_ipc_context(temp_dir.path(), "token-1", None, "http://127.0.0.1:0").await;
        let data_dir = ctx.data_dir.clone();
        sqlx::query(
            "INSERT INTO order_sessions(
                order_no,payment_method,payment_provider,payment_attempt_json,items_json,status,
                next_action,expires_at,last_backend_status_json,last_error,recovery_strategy,updated_at
             ) VALUES (?1,'payment_code','alipay',NULL,'[]','waiting_payment',?2,NULL,NULL,NULL,'local',?3)",
        )
        .bind("ORDER-IPC-LEGACY-MINIMAL")
        .bind("submit_payment")
        .bind(crate::state::store::now_iso())
        .execute(ctx.state.pool())
        .await
        .expect("seed legacy minimal transaction");
        let app = build_router(ctx);

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/v1/transactions/current")
                    .header(AUTHORIZATION, "Bearer token-1")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        let body = body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(payload["code"], "transaction_contract_invalid");
        let text = serde_json::to_string(&payload).unwrap();
        assert!(!text.contains("submit_payment"));
        assert!(text.contains("totalAmountCents"));

        let logs = tokio::fs::read_to_string(data_dir.join("logs").join("machine-events.jsonl"))
            .await
            .expect("diagnostic log");
        assert!(logs.contains("current_transaction_contract_invalid"));
        assert!(logs.contains("ORDER-IPC-LEGACY-MINIMAL"));
        assert!(logs.contains("totalAmountCents"));
        assert!(!logs.contains("submit_payment"));
    }

    #[tokio::test]
    async fn current_transaction_ipc_output_rejects_invalid_contract_boundary() {
        let temp_dir = tempdir().expect("tmp");
        let ctx = test_ipc_context(temp_dir.path(), "token-1", None, "http://127.0.0.1:0").await;
        let data_dir = ctx.data_dir.clone();
        ctx.state
            .upsert_order_session(crate::state::store::OrderSessionUpsert {
                order_no: "ORDER-IPC-INVALID",
                payment_method: "payment_code",
                payment_provider: Some("alipay"),
                items_json: json!([{"sku":"SKU-1","name":"Water","quantity":1}]),
                status: "waiting_payment",
                next_action: "wait_payment",
                payment_attempt_json: None,
                recovery_strategy: "local",
                last_backend_status_json: Some(json!({
                    "orderStatus": "pending_payment",
                    "nextAction": "wait_payment",
                    "totalAmountCents": -1,
                    "payment": {
                        "method": "payment_code",
                        "providerCode": "alipay"
                    }
                })),
                last_error: None,
            })
            .await
            .expect("seed invalid current transaction");
        let app = build_router(ctx);

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/v1/transactions/current")
                    .header(AUTHORIZATION, "Bearer token-1")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        let body = body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(payload["code"], "transaction_contract_invalid");
        assert!(payload["message"]
            .as_str()
            .unwrap()
            .contains("negative totalAmountCents"));
        let logs = tokio::fs::read_to_string(data_dir.join("logs").join("machine-events.jsonl"))
            .await
            .expect("diagnostic log");
        assert!(logs.contains("current_transaction_contract_invalid"));
        assert!(logs.contains("ORDER-IPC-INVALID"));
        assert!(logs.contains("negative totalAmountCents"));
    }

    #[tokio::test]
    async fn ipc_cors_allows_tauri_preflight_and_private_network() {
        let temp_dir = tempdir().expect("tmp");
        let app = build_router(
            test_ipc_context(
                temp_dir.path(),
                "token-1",
                Some("MACHINE-1".to_string()),
                "http://127.0.0.1:0",
            )
            .await,
        );

        let preflight = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::OPTIONS)
                    .uri("/v1/sale-readiness")
                    .header("Origin", "http://tauri.localhost")
                    .header("Access-Control-Request-Method", "GET")
                    .header(
                        "Access-Control-Request-Headers",
                        "authorization,content-type",
                    )
                    .header("Access-Control-Request-Private-Network", "true")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert!(
            preflight.status().is_success(),
            "preflight failed with {}",
            preflight.status()
        );
        let headers = preflight.headers();
        assert_eq!(
            headers
                .get("access-control-allow-origin")
                .and_then(|value| value.to_str().ok()),
            Some("*")
        );
        assert_eq!(
            headers
                .get("access-control-allow-private-network")
                .and_then(|value| value.to_str().ok()),
            Some("true")
        );
        let allow_methods = headers
            .get("access-control-allow-methods")
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default();
        assert!(allow_methods.contains("GET"));
        let allow_headers = headers
            .get("access-control-allow-headers")
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_ascii_lowercase();
        assert!(allow_headers.contains("authorization"));
        assert!(allow_headers.contains("content-type"));

        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/healthz")
                    .header("Origin", "http://tauri.localhost")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response
                .headers()
                .get("access-control-allow-origin")
                .and_then(|value| value.to_str().ok()),
            Some("*")
        );
    }

    #[tokio::test]
    async fn dev_submit_payment_code_rejects_non_dev_source() {
        let temp_dir = tempdir().expect("tmp");
        let app = build_router(
            test_ipc_context(
                temp_dir.path(),
                "token-1",
                Some("MACHINE-1".to_string()),
                "http://127.0.0.1:0",
            )
            .await,
        );
        let request = Request::builder()
            .method(Method::POST)
            .uri("/v1/intents/dev-submit-payment-code")
            .header(AUTHORIZATION, "Bearer token-1")
            .header(CONTENT_TYPE, "application/json")
            .body(axum::body::Body::from(
                json!({
                    "orderNo": "ORDER-1",
                    "authCode": "6212345678901234",
                    "source": "production",
                })
                .to_string(),
            ))
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn refresh_catalog_keeps_cached_items_when_backend_fails() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(wiremock::matchers::path("/machines/MACHINE-1/catalog"))
            .respond_with(ResponseTemplate::new(500).set_body_string("boom"))
            .mount(&server)
            .await;

        let temp_dir = tempdir().expect("tmp");
        let ctx = test_ipc_context(
            temp_dir.path(),
            "token-1",
            Some("MACHINE-1".to_string()),
            &server.uri(),
        )
        .await;
        let mut snapshot = ctx.ui.status_cache.catalog.write().await;
        snapshot.items = vec![json!({ "id": "item-1" })];
        snapshot.cached = true;
        snapshot.source = "legacy".to_string();
        drop(snapshot);

        let app = build_router(ctx);
        let request = Request::builder()
            .method(Method::POST)
            .uri("/v1/catalog")
            .header(AUTHORIZATION, "Bearer token-1")
            .body(axum::body::Body::empty())
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        let body = body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let payload: CatalogSnapshot = serde_json::from_slice(&body).unwrap();
        assert_eq!(payload.source, "legacy");
        assert_eq!(payload.items.len(), 1);
        assert!(payload.last_error.is_some());
    }

    #[tokio::test]
    async fn refresh_catalog_updates_source_on_success() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(wiremock::matchers::path("/machines/MACHINE-1/catalog"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "source": "backend",
                "items": [json!({"sku": "A"})],
            })))
            .mount(&server)
            .await;

        let temp_dir = tempdir().expect("tmp");
        let app = build_router(
            test_ipc_context(
                temp_dir.path(),
                "token-1",
                Some("MACHINE-1".to_string()),
                &server.uri(),
            )
            .await,
        );
        let request = Request::builder()
            .method(Method::POST)
            .uri("/v1/catalog")
            .header(AUTHORIZATION, "Bearer token-1")
            .body(axum::body::Body::empty())
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        let body = body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let payload: CatalogSnapshot = serde_json::from_slice(&body).unwrap();
        assert_eq!(payload.source, "backend");
        assert_eq!(payload.items.len(), 1);
    }

    #[tokio::test]
    async fn sync_planogram_applies_published_version_and_acknowledges_platform() {
        let server = MockServer::start().await;
        let slot_id = "550e8400-e29b-41d4-a716-446655440091";
        let inventory_id = "550e8400-e29b-41d4-a716-446655440092";
        let planogram = one_slot_planogram("PLAN-SYNC-ACK", slot_id, inventory_id);
        Mock::given(method("GET"))
            .and(wiremock::matchers::path(
                "/machines/MACHINE-1/planogram-versions/published",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "machineId": "550e8400-e29b-41d4-a716-446655440090",
                "machineCode": "MACHINE-1",
                "planogramVersion": "PLAN-SYNC-ACK",
                "status": "published",
                "publishedAt": "2026-06-04T12:00:00.000Z",
                "acknowledgedAt": null,
                "activeAt": null,
                "slots": planogram["slots"].clone(),
            })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(wiremock::matchers::path(
                "/machines/MACHINE-1/planogram-versions/PLAN-SYNC-ACK/ack",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "planogramVersion": "PLAN-SYNC-ACK",
                "status": "active",
            })))
            .mount(&server)
            .await;

        let temp_dir = tempdir().expect("tmp");
        let app = build_router(
            test_ipc_context(
                temp_dir.path(),
                "token-1",
                Some("MACHINE-1".to_string()),
                &server.uri(),
            )
            .await,
        );

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/v1/stock/planogram/sync")
                    .header(AUTHORIZATION, "Bearer token-1")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(payload["planogramVersion"], "PLAN-SYNC-ACK");
        assert_eq!(payload["items"][0]["inventoryId"], inventory_id);

        let requests = server.received_requests().await.expect("requests");
        assert_eq!(
            requests
                .iter()
                .filter(|request| {
                    request.method.as_str() == "POST"
                        && request.url.path()
                            == "/machines/MACHINE-1/planogram-versions/PLAN-SYNC-ACK/ack"
                })
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn sale_readiness_rejects_malformed_payment_options() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(wiremock::matchers::path("/machine-orders/payment-options"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "options": [{
                    "displayName": "损坏支付配置",
                    "description": "missing required fields",
                    "icon": "mock",
                    "recommended": true,
                    "disabled": false,
                    "disabledReason": null
                }],
                "defaultOptionKey": null,
                "defaultProviderCode": null,
                "serverTime": "2026-06-04T00:00:00Z"
            })))
            .mount(&server)
            .await;

        let temp_dir = tempdir().expect("tmp");
        let ctx = test_ipc_context(
            temp_dir.path(),
            "token-1",
            Some("MACHINE-1".to_string()),
            &server.uri(),
        )
        .await;
        mark_runtime_sale_ready(&ctx).await;
        let app = build_router(ctx);
        assert_eq!(
            post_json(
                &app,
                "/v1/stock/planogram",
                "token-1",
                one_slot_planogram(
                    "PLAN-MALFORMED-PAYMENT",
                    "550e8400-e29b-41d4-a716-446655440101",
                    "550e8400-e29b-41d4-a716-446655440102",
                ),
            )
            .await
            .status(),
            StatusCode::OK
        );

        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/v1/sale-readiness")
                    .header(AUTHORIZATION, "Bearer token-1")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let readiness: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(readiness["canStartNetworkAuthorizedSale"], false);
        assert_eq!(readiness["components"]["paymentOptions"]["ready"], false);
        assert!(readiness["blockingCodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|code| code == "NO_PAYMENT_OPTIONS"));
    }

    #[tokio::test]
    async fn payment_options_are_filtered_by_persisted_machine_payment_capability() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(wiremock::matchers::path("/machine-orders/payment-options"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "options": [
                    {
                        "optionKey": "qr_code:alipay",
                        "providerCode": "alipay",
                        "method": "qr_code",
                        "displayName": "支付宝扫码",
                        "description": "请使用支付宝扫描屏幕二维码",
                        "icon": "alipay",
                        "recommended": true,
                        "disabled": false,
                        "disabledReason": null
                    },
                    {
                        "optionKey": "payment_code:alipay",
                        "providerCode": "alipay",
                        "method": "payment_code",
                        "displayName": "支付宝付款码",
                        "description": "请出示支付宝付款码并靠近扫码窗口",
                        "icon": "alipay",
                        "recommended": false,
                        "disabled": false,
                        "disabledReason": null
                    },
                    {
                        "optionKey": "mock:mock",
                        "providerCode": "mock",
                        "method": "mock",
                        "displayName": "模拟支付",
                        "description": "测试环境专用",
                        "icon": "mock",
                        "recommended": false,
                        "disabled": false,
                        "disabledReason": null
                    }
                ],
                "defaultOptionKey": "payment_code:alipay",
                "defaultProviderCode": "alipay",
                "serverTime": "2026-06-04T00:00:00Z"
            })))
            .mount(&server)
            .await;

        let temp_dir = tempdir().expect("tmp");
        let ctx = test_ipc_context(
            temp_dir.path(),
            "token-1",
            Some("MACHINE-1".to_string()),
            &server.uri(),
        )
        .await;
        update_profile_payment_capability(&ctx, false).await;
        let app = build_router(ctx);

        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/v1/payment-options")
                    .header(AUTHORIZATION, "Bearer token-1")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let options: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let option_keys: Vec<&str> = options["options"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|option| option["optionKey"].as_str())
            .collect();
        assert_eq!(option_keys, vec!["qr_code:alipay", "mock:mock"]);
        assert_eq!(options["defaultOptionKey"], "qr_code:alipay");
        assert_eq!(options["defaultProviderCode"], "alipay");
    }

    #[tokio::test]
    async fn payment_options_use_profile_cache_capability_when_legacy_config_is_stale() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/machines/claim"))
            .respond_with({
                let mut profile = valid_provisioning_profile();
                profile["paymentCapability"]["paymentCodeEnabled"] = json!(false);
                ResponseTemplate::new(200).set_body_json(profile)
            })
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(wiremock::matchers::path("/machine-orders/payment-options"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "options": [
                    {
                        "optionKey": "qr_code:alipay",
                        "providerCode": "alipay",
                        "method": "qr_code",
                        "displayName": "支付宝扫码",
                        "description": "请使用支付宝扫描屏幕二维码",
                        "icon": "alipay",
                        "recommended": true,
                        "disabled": false,
                        "disabledReason": null
                    },
                    {
                        "optionKey": "payment_code:alipay",
                        "providerCode": "alipay",
                        "method": "payment_code",
                        "displayName": "支付宝付款码",
                        "description": "请出示支付宝付款码并靠近扫码窗口",
                        "icon": "alipay",
                        "recommended": false,
                        "disabled": false,
                        "disabledReason": null
                    }
                ],
                "defaultOptionKey": "payment_code:alipay",
                "defaultProviderCode": "alipay",
                "serverTime": "2026-06-04T00:00:00Z"
            })))
            .mount(&server)
            .await;

        let temp_dir = tempdir().expect("tmp");
        let data_dir = temp_dir.path().join("vending-daemon");
        let ctx = test_ipc_context(&data_dir, "token-1", None, &server.uri()).await;
        let app = build_router(ctx.clone());
        assert_eq!(
            post_json(
                &app,
                "/v1/provisioning/claim",
                "token-1",
                json!({ "claimCode": "ABCD-2345" }),
            )
            .await
            .status(),
            StatusCode::OK
        );

        let mut stale_legacy = ctx.config_store.load_public_config().await.expect("config");
        stale_legacy.payment_capability = Some(crate::config::ProductionMachinePaymentCapability {
            profile: "production".to_string(),
            qr_code_enabled: true,
            payment_code_enabled: true,
            server_time: "2026-06-08T16:30:00.000Z".to_string(),
            options: vec![],
            default_option_key: None,
            default_provider_code: None,
        });
        ctx.config_store
            .save_public_config(stale_legacy)
            .await
            .expect("save stale legacy bridge");

        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/v1/payment-options")
                    .header(AUTHORIZATION, "Bearer token-1")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let options: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let option_keys: Vec<&str> = options["options"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|option| option["optionKey"].as_str())
            .collect();

        assert_eq!(option_keys, vec!["qr_code:alipay"]);
        assert_eq!(options["defaultOptionKey"], "qr_code:alipay");
        assert_eq!(options["defaultProviderCode"], "alipay");
    }

    #[tokio::test]
    async fn sale_readiness_uses_machine_payment_capability_before_scanner_readiness() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(wiremock::matchers::path("/machine-orders/payment-options"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "options": [
                    {
                        "optionKey": "payment_code:alipay",
                        "providerCode": "alipay",
                        "method": "payment_code",
                        "displayName": "支付宝付款码",
                        "description": "请出示支付宝付款码并靠近扫码窗口",
                        "icon": "alipay",
                        "recommended": true,
                        "disabled": false,
                        "disabledReason": null
                    },
                    {
                        "optionKey": "qr_code:alipay",
                        "providerCode": "alipay",
                        "method": "qr_code",
                        "displayName": "支付宝扫码",
                        "description": "请使用支付宝扫描屏幕二维码",
                        "icon": "alipay",
                        "recommended": false,
                        "disabled": false,
                        "disabledReason": null
                    }
                ],
                "defaultOptionKey": "payment_code:alipay",
                "defaultProviderCode": "alipay",
                "serverTime": "2026-06-04T00:00:00Z"
            })))
            .mount(&server)
            .await;

        let temp_dir = tempdir().expect("tmp");
        let ctx = test_ipc_context(
            temp_dir.path(),
            "token-1",
            Some("MACHINE-1".to_string()),
            &server.uri(),
        )
        .await;
        mark_runtime_sale_ready(&ctx).await;
        update_profile_payment_capability(&ctx, false).await;
        let app = build_router(ctx);

        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/v1/sale-readiness")
                    .header(AUTHORIZATION, "Bearer token-1")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let readiness: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let methods: Vec<&str> = readiness["components"]["paymentOptions"]["methods"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|method| method["optionKey"].as_str())
            .collect();
        assert_eq!(methods, vec!["qr_code:alipay"]);
        assert_eq!(readiness["components"]["paymentOptions"]["ready"], true);
    }

    #[tokio::test]
    async fn unavailable_vision_does_not_block_sale_readiness_or_payment_options() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(wiremock::matchers::path("/machine-orders/payment-options"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "options": [
                    {
                        "optionKey": "payment_code:alipay",
                        "providerCode": "alipay",
                        "method": "payment_code",
                        "displayName": "支付宝付款码",
                        "description": "请出示支付宝付款码并靠近扫码窗口",
                        "icon": "alipay",
                        "recommended": true,
                        "disabled": false,
                        "disabledReason": null
                    },
                    {
                        "optionKey": "qr_code:alipay",
                        "providerCode": "alipay",
                        "method": "qr_code",
                        "displayName": "支付宝扫码",
                        "description": "请使用支付宝扫描屏幕二维码",
                        "icon": "alipay",
                        "recommended": false,
                        "disabled": false,
                        "disabledReason": null
                    }
                ],
                "defaultOptionKey": "payment_code:alipay",
                "defaultProviderCode": "alipay",
                "serverTime": "2026-06-04T00:00:00Z"
            })))
            .mount(&server)
            .await;

        for (case_name, vision_enabled, slot_suffix) in [
            ("unavailable_vision", true, "1101"),
            ("disabled_vision", false, "1201"),
        ] {
            let temp_dir = tempdir().expect("tmp");
            let ctx = test_ipc_context(
                temp_dir.path(),
                "token-1",
                Some("MACHINE-1".to_string()),
                &server.uri(),
            )
            .await;
            mark_runtime_sale_ready(&ctx).await;
            {
                let mut public = ctx.config_store.load_public_config().await.expect("config");
                public.vision_enabled = vision_enabled;
                ctx.config_store
                    .save_public_config(public)
                    .await
                    .expect("save vision config");
            }
            {
                let mut vision = ctx.ui.status_cache.vision.write().await;
                vision.enabled = vision_enabled;
                vision.online = false;
                vision.message = format!("{case_name}: camera unavailable");
                vision.latest_diagnostic_payload = Some(json!({
                    "frameImageBase64": "raw-frame-must-remain-diagnostic-only"
                }));
            }
            let app = build_router(ctx);
            let slot_id = format!("550e8400-e29b-41d4-a716-44665544{slot_suffix}");
            let inventory_id = format!("550e8400-e29b-41d4-a716-44665545{slot_suffix}");
            let planogram_version = format!("PLAN-TRY-ON-{slot_suffix}");
            assert_eq!(
                post_json(
                    &app,
                    "/v1/stock/planogram",
                    "token-1",
                    one_slot_planogram(&planogram_version, &slot_id, &inventory_id),
                )
                .await
                .status(),
                StatusCode::OK,
                "{case_name}: planogram should apply"
            );
            assert_eq!(
                post_json(
                    &app,
                    "/v1/stock/movements",
                    "token-1",
                    json!({
                        "movementId": format!("MOVE-{slot_suffix}"),
                        "planogramVersion": planogram_version,
                        "slotId": slot_id,
                        "movementType": "planned_refill",
                        "quantity": 2,
                        "source": "field_service",
                        "attributedTo": "operator-1"
                    }),
                )
                .await
                .status(),
                StatusCode::CREATED,
                "{case_name}: stock movement should apply"
            );
            record_attested_stock(&app, &planogram_version, &slot_id, 2).await;

            let readyz = get_ipc_json(&app, "/readyz", None).await;
            assert_eq!(readyz["canSell"], true, "{case_name}: readyz can sell");
            assert_eq!(readyz["suggestedRoute"], "catalog");
            assert!(
                readyz["blockingCodes"].as_array().unwrap().is_empty(),
                "{case_name}: readyz blockers should stay empty"
            );

            let readiness = get_ipc_json(&app, "/v1/sale-readiness", Some("token-1")).await;
            assert_eq!(
                readiness["canStartNetworkAuthorizedSale"], true,
                "{case_name}: sale readiness should remain ready"
            );
            assert!(
                readiness["blockingCodes"].as_array().unwrap().is_empty(),
                "{case_name}: sale readiness blockers should stay empty"
            );
            assert_eq!(
                readiness["components"]["paymentOptions"]["ready"], true,
                "{case_name}: payment options component should remain ready"
            );
            assert!(readiness["components"].get("vision").is_none());
            let readiness_text = readiness.to_string();
            assert!(!readiness_text.contains("frameImageBase64"));
            assert!(!readiness_text.contains("missing-camera"));

            let payment_options = get_ipc_json(&app, "/v1/payment-options", Some("token-1")).await;
            assert_eq!(
                payment_options["defaultOptionKey"], "payment_code:alipay",
                "{case_name}: default payment option should be unchanged"
            );
            let option_keys: Vec<&str> = payment_options["options"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|option| option["optionKey"].as_str())
                .collect();
            assert_eq!(
                option_keys,
                vec!["payment_code:alipay", "qr_code:alipay"],
                "{case_name}: payment option list should be unchanged"
            );
            let payment_options_text = payment_options.to_string();
            assert!(!payment_options_text.contains("frameImageBase64"));
            assert!(!payment_options_text.contains("missing-camera"));
        }
    }

    #[tokio::test]
    async fn payment_options_disable_stale_ready_payment_code_and_default_to_qr() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(wiremock::matchers::path("/machine-orders/payment-options"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "options": [
                    {
                        "optionKey": "payment_code:alipay",
                        "providerCode": "alipay",
                        "method": "payment_code",
                        "displayName": "支付宝付款码",
                        "description": "请出示支付宝付款码并靠近扫码窗口",
                        "icon": "alipay",
                        "recommended": true,
                        "disabled": false,
                        "disabledReason": null
                    },
                    {
                        "optionKey": "qr_code:alipay",
                        "providerCode": "alipay",
                        "method": "qr_code",
                        "displayName": "支付宝扫码",
                        "description": "请使用支付宝扫描屏幕二维码",
                        "icon": "alipay",
                        "recommended": false,
                        "disabled": false,
                        "disabledReason": null
                    }
                ],
                "defaultOptionKey": "payment_code:alipay",
                "defaultProviderCode": "alipay",
                "serverTime": "2026-06-04T00:00:00Z"
            })))
            .mount(&server)
            .await;

        let temp_dir = tempdir().expect("tmp");
        let ctx = test_ipc_context(
            temp_dir.path(),
            "token-1",
            Some("MACHINE-1".to_string()),
            &server.uri(),
        )
        .await;
        mark_runtime_sale_ready(&ctx).await;
        {
            let mut scanner = ctx.ui.status_cache.scanner.write().await;
            scanner.updated_at = (chrono::Utc::now() - chrono::Duration::seconds(120))
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        }
        let app = build_router(ctx);

        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/v1/payment-options")
                    .header(AUTHORIZATION, "Bearer token-1")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let options: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let payment_code = options["options"]
            .as_array()
            .unwrap()
            .iter()
            .find(|option| option["optionKey"] == "payment_code:alipay")
            .expect("payment code option");
        assert_eq!(payment_code["disabled"], true);
        assert!(payment_code["disabledReason"]
            .as_str()
            .unwrap()
            .contains("过期"));
        assert_eq!(options["defaultOptionKey"], "qr_code:alipay");
        assert_eq!(options["defaultProviderCode"], "alipay");
    }

    #[tokio::test]
    async fn payment_options_preserve_available_platform_default_and_safe_scanner_reason() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(wiremock::matchers::path("/machine-orders/payment-options"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "options": [
                    {
                        "optionKey": "payment_code:alipay",
                        "providerCode": "alipay",
                        "method": "payment_code",
                        "displayName": "支付宝付款码",
                        "description": "请出示支付宝付款码并靠近扫码窗口",
                        "icon": "alipay",
                        "recommended": false,
                        "disabled": false,
                        "disabledReason": null
                    },
                    {
                        "optionKey": "qr_code:alipay",
                        "providerCode": "alipay",
                        "method": "qr_code",
                        "displayName": "支付宝扫码",
                        "description": "请使用支付宝扫描屏幕二维码",
                        "icon": "alipay",
                        "recommended": true,
                        "disabled": false,
                        "disabledReason": null
                    }
                ],
                "defaultOptionKey": "qr_code:alipay",
                "defaultProviderCode": "alipay",
                "serverTime": "2026-06-04T00:00:00Z"
            })))
            .mount(&server)
            .await;

        let temp_dir = tempdir().expect("tmp");
        let ctx = test_ipc_context(
            temp_dir.path(),
            "token-1",
            Some("MACHINE-1".to_string()),
            &server.uri(),
        )
        .await;
        mark_runtime_sale_ready(&ctx).await;
        {
            let mut scanner = ctx.ui.status_cache.scanner.write().await;
            scanner.online = false;
            scanner.code = "SCANNER_OPEN_FAILED".to_string();
            scanner.message = "open serial port /dev/vem-secret-scanner failed".to_string();
        }
        let app = build_router(ctx);

        let options = get_ipc_json(&app, "/v1/payment-options", Some("token-1")).await;
        let option_keys: Vec<&str> = options["options"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|option| option["optionKey"].as_str())
            .collect();
        assert_eq!(option_keys, vec!["payment_code:alipay", "qr_code:alipay"]);
        assert_eq!(options["defaultOptionKey"], "qr_code:alipay");
        assert_eq!(options["defaultProviderCode"], "alipay");

        let payment_code = options["options"]
            .as_array()
            .unwrap()
            .iter()
            .find(|option| option["optionKey"] == "payment_code:alipay")
            .expect("payment code option");
        assert_eq!(payment_code["disabled"], true);
        assert_eq!(
            payment_code["disabledReason"],
            "扫码器暂不可用，请选择其他支付方式"
        );
        let customer_text = payment_code["disabledReason"].as_str().unwrap();
        assert!(!customer_text.contains("/dev/"));
        assert!(!customer_text.contains("SCANNER_OPEN_FAILED"));
        assert!(!customer_text.contains("serial"));
    }

    #[tokio::test]
    async fn payment_options_disable_unhealthy_scanner_payment_code_without_hiding_qr() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(wiremock::matchers::path("/machine-orders/payment-options"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "options": [
                    {
                        "optionKey": "payment_code:alipay",
                        "providerCode": "alipay",
                        "method": "payment_code",
                        "displayName": "支付宝付款码",
                        "description": "请出示支付宝付款码并靠近扫码窗口",
                        "icon": "alipay",
                        "recommended": true,
                        "disabled": false,
                        "disabledReason": null
                    },
                    {
                        "optionKey": "qr_code:alipay",
                        "providerCode": "alipay",
                        "method": "qr_code",
                        "displayName": "支付宝扫码",
                        "description": "请使用支付宝扫描屏幕二维码",
                        "icon": "alipay",
                        "recommended": false,
                        "disabled": false,
                        "disabledReason": null
                    }
                ],
                "defaultOptionKey": "payment_code:alipay",
                "defaultProviderCode": "alipay",
                "serverTime": "2026-06-04T00:00:00Z"
            })))
            .mount(&server)
            .await;

        let temp_dir = tempdir().expect("tmp");
        let ctx = test_ipc_context(
            temp_dir.path(),
            "token-1",
            Some("MACHINE-1".to_string()),
            &server.uri(),
        )
        .await;
        mark_runtime_sale_ready(&ctx).await;
        {
            let mut scanner = ctx.ui.status_cache.scanner.write().await;
            scanner.online = true;
            scanner.code = "SCANNER_READ_ERROR".to_string();
            scanner.message = "scanner read error on COM3".to_string();
        }
        let app = build_router(ctx);

        let options = get_ipc_json(&app, "/v1/payment-options", Some("token-1")).await;
        let payment_code = options["options"]
            .as_array()
            .unwrap()
            .iter()
            .find(|option| option["optionKey"] == "payment_code:alipay")
            .expect("payment code option");
        let qr = options["options"]
            .as_array()
            .unwrap()
            .iter()
            .find(|option| option["optionKey"] == "qr_code:alipay")
            .expect("qr option");
        assert_eq!(payment_code["disabled"], true);
        assert_eq!(
            payment_code["disabledReason"],
            "扫码器暂不可用，请选择其他支付方式"
        );
        assert_eq!(qr["disabled"], false);
        assert_eq!(options["defaultOptionKey"], "qr_code:alipay");
    }

    #[tokio::test]
    async fn sale_readiness_treats_stale_ready_scanner_as_payment_code_unavailable_only() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(wiremock::matchers::path("/machine-orders/payment-options"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "options": [
                    {
                        "optionKey": "payment_code:alipay",
                        "providerCode": "alipay",
                        "method": "payment_code",
                        "displayName": "支付宝付款码",
                        "description": "请出示支付宝付款码并靠近扫码窗口",
                        "icon": "alipay",
                        "recommended": true,
                        "disabled": false,
                        "disabledReason": null
                    },
                    {
                        "optionKey": "qr_code:alipay",
                        "providerCode": "alipay",
                        "method": "qr_code",
                        "displayName": "支付宝扫码",
                        "description": "请使用支付宝扫描屏幕二维码",
                        "icon": "alipay",
                        "recommended": false,
                        "disabled": false,
                        "disabledReason": null
                    }
                ],
                "defaultOptionKey": "payment_code:alipay",
                "defaultProviderCode": "alipay",
                "serverTime": "2026-06-04T00:00:00Z"
            })))
            .mount(&server)
            .await;

        let temp_dir = tempdir().expect("tmp");
        let ctx = test_ipc_context(
            temp_dir.path(),
            "token-1",
            Some("MACHINE-1".to_string()),
            &server.uri(),
        )
        .await;
        mark_runtime_sale_ready(&ctx).await;
        {
            let mut scanner = ctx.ui.status_cache.scanner.write().await;
            scanner.updated_at = (chrono::Utc::now() - chrono::Duration::seconds(120))
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        }
        let app = build_router(ctx);
        let slot_id = "550e8400-e29b-41d4-a716-446655440901";
        let inventory_id = "550e8400-e29b-41d4-a716-446655440902";
        assert_eq!(
            post_json(
                &app,
                "/v1/stock/planogram",
                "token-1",
                one_slot_planogram("PLAN-SCANNER-STALE", slot_id, inventory_id),
            )
            .await
            .status(),
            StatusCode::OK
        );
        assert_eq!(
            post_json(
                &app,
                "/v1/stock/movements",
                "token-1",
                json!({
                    "movementId": "MOVE-SCANNER-STALE-1",
                    "planogramVersion": "PLAN-SCANNER-STALE",
                    "slotId": slot_id,
                    "movementType": "planned_refill",
                    "quantity": 2,
                    "source": "field_service",
                    "attributedTo": "operator-1"
                }),
            )
            .await
            .status(),
            StatusCode::CREATED
        );
        record_attested_stock(&app, "PLAN-SCANNER-STALE", slot_id, 2).await;

        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/v1/sale-readiness")
                    .header(AUTHORIZATION, "Bearer token-1")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let readiness: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(readiness["canStartNetworkAuthorizedSale"], true);
        assert_eq!(readiness["components"]["paymentOptions"]["ready"], true);
        assert_eq!(readiness["components"]["scannerCapability"]["ready"], false);
        assert_eq!(
            readiness["components"]["scannerCapability"]["code"],
            "SCANNER_STATUS_STALE"
        );
        let methods = readiness["components"]["paymentOptions"]["methods"]
            .as_array()
            .unwrap();
        let payment_code = methods
            .iter()
            .find(|method| method["optionKey"] == "payment_code:alipay")
            .expect("payment code option");
        let qr_code = methods
            .iter()
            .find(|method| method["optionKey"] == "qr_code:alipay")
            .expect("qr code option");
        assert_eq!(payment_code["ready"], false);
        assert!(payment_code["disabledReason"]
            .as_str()
            .unwrap()
            .contains("过期"));
        assert_eq!(qr_code["ready"], true);
    }

    #[tokio::test]
    async fn create_order_intent_rechecks_readiness_before_backend_call() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(wiremock::matchers::path("/machine-orders/payment-options"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "options": [{
                    "optionKey": "mock:mock",
                    "providerCode": "mock",
                    "method": "mock",
                    "displayName": "模拟支付",
                    "description": "本地模拟",
                    "icon": "mock",
                    "recommended": true,
                    "disabled": false,
                    "disabledReason": null
                }],
                "defaultOptionKey": "mock:mock",
                "defaultProviderCode": "mock",
                "serverTime": "2026-06-04T00:00:00Z"
            })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(wiremock::matchers::path("/machine-orders"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "orderNo": "ORD-BYPASS-1",
                "nextAction": "wait_payment",
                "orderStatus": "pending_payment"
            })))
            .mount(&server)
            .await;

        let temp_dir = tempdir().expect("tmp");
        let ctx = test_ipc_context(
            temp_dir.path(),
            "token-1",
            Some("MACHINE-1".to_string()),
            &server.uri(),
        )
        .await;
        mark_runtime_sale_ready(&ctx).await;
        let app = build_router(ctx);

        let response = post_json(
            &app,
            "/v1/intents/create-order",
            "token-1",
            json!({
                "inventoryId": "550e8400-e29b-41d4-a716-446655440202",
                "quantity": 1,
                "planogramVersion": "PLAN-MISSING",
                "slotId": "550e8400-e29b-41d4-a716-446655440201",
                "slotCode": "A1",
                "paymentMethod": "mock",
                "paymentProviderCode": "mock",
                "profileSnapshot": null
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(payload["code"], "create_order_blocked");
        assert!(payload["message"]
            .as_str()
            .unwrap()
            .contains("ACTIVE_PLANOGRAM_MISSING"));

        let backend_create_order_requests = server
            .received_requests()
            .await
            .expect("recorded requests")
            .into_iter()
            .filter(|request| request.url.path() == "/machine-orders")
            .count();
        assert_eq!(backend_create_order_requests, 0);
    }

    #[tokio::test]
    async fn create_order_intent_rejects_multi_quantity_for_v1_lower_controller_protocol() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(wiremock::matchers::path("/machine-orders/payment-options"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "options": [{
                    "optionKey": "mock:mock",
                    "providerCode": "mock",
                    "method": "mock",
                    "displayName": "模拟支付",
                    "description": "本地模拟",
                    "icon": "mock",
                    "recommended": true,
                    "disabled": false,
                    "disabledReason": null
                }],
                "defaultOptionKey": "mock:mock",
                "defaultProviderCode": "mock",
                "serverTime": "2026-06-04T00:00:00Z"
            })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(wiremock::matchers::path("/machine-orders"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "orderNo": "ORD-MULTI-UNEXPECTED",
                "nextAction": "wait_payment",
                "orderStatus": "pending_payment"
            })))
            .mount(&server)
            .await;

        let temp_dir = tempdir().expect("tmp");
        let ctx = test_ipc_context(
            temp_dir.path(),
            "token-1",
            Some("MACHINE-1".to_string()),
            &server.uri(),
        )
        .await;
        mark_runtime_sale_ready(&ctx).await;
        let app = build_router(ctx);
        let slot_id = "550e8400-e29b-41d4-a716-446655440701";
        let inventory_id = "550e8400-e29b-41d4-a716-446655440702";
        assert_eq!(
            post_json(
                &app,
                "/v1/stock/planogram",
                "token-1",
                one_slot_planogram("PLAN-SINGLE-ITEM-ONLY", slot_id, inventory_id),
            )
            .await
            .status(),
            StatusCode::OK
        );
        assert_eq!(
            post_json(
                &app,
                "/v1/stock/movements",
                "token-1",
                json!({
                    "movementId": "MOVE-SINGLE-ITEM-ONLY-1",
                    "planogramVersion": "PLAN-SINGLE-ITEM-ONLY",
                    "slotId": slot_id,
                    "movementType": "planned_refill",
                    "quantity": 3,
                    "source": "field_service",
                    "attributedTo": "operator-1"
                }),
            )
            .await
            .status(),
            StatusCode::CREATED
        );
        record_attested_stock(&app, "PLAN-SINGLE-ITEM-ONLY", slot_id, 3).await;

        let response = post_json(
            &app,
            "/v1/intents/create-order",
            "token-1",
            json!({
                "inventoryId": inventory_id,
                "quantity": 2,
                "planogramVersion": "PLAN-SINGLE-ITEM-ONLY",
                "slotId": slot_id,
                "slotCode": "A1",
                "paymentMethod": "mock",
                "paymentProviderCode": "mock",
                "profileSnapshot": null
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(payload["code"], "create_order_blocked");
        assert!(payload["message"]
            .as_str()
            .unwrap()
            .contains("quantity must be exactly 1"));

        let backend_create_order_requests = server
            .received_requests()
            .await
            .expect("recorded requests")
            .into_iter()
            .filter(|request| request.url.path() == "/machine-orders")
            .count();
        assert_eq!(backend_create_order_requests, 0);
    }

    #[tokio::test]
    async fn sale_readiness_enforces_production_dispense_path_for_production_machine() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(wiremock::matchers::path("/machine-orders/payment-options"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "options": [{
                    "optionKey": "qr_code:alipay",
                    "providerCode": "alipay",
                    "method": "qr_code",
                    "displayName": "支付宝",
                    "description": "请使用支付宝扫码支付",
                    "icon": "alipay",
                    "disabled": false,
                    "disabledReason": null,
                    "recommended": true
                }],
                "defaultOptionKey": "qr_code:alipay",
                "defaultProviderCode": "alipay",
                "serverTime": "2026-06-08T16:30:00.000Z"
            })))
            .mount(&server)
            .await;

        let temp_dir = tempdir().expect("tmp");
        let ctx = test_ipc_context(
            temp_dir.path(),
            "token-1",
            Some("MACHINE-1".to_string()),
            &server.uri(),
        )
        .await;
        mark_runtime_sale_ready(&ctx).await;
        {
            let profile = valid_provisioning_profile();
            let mut public = ctx.config_store.load_public_config().await.expect("config");
            public.hardware_adapter = crate::config::HardwareAdapterKind::Mock;
            public.serial_port_path = None;
            public.hardware_profile = Some(
                serde_json::from_value(profile["hardwareProfile"].clone())
                    .expect("hardware profile"),
            );
            public.payment_capability = Some(
                serde_json::from_value(profile["paymentCapability"].clone())
                    .expect("payment capability"),
            );
            ctx.config_store
                .save_public_config(public)
                .await
                .expect("save production config");
        }
        let app = build_router(ctx.clone());
        let slot_id = "550e8400-e29b-41d4-a716-446655440301";
        let inventory_id = "550e8400-e29b-41d4-a716-446655440302";
        assert_eq!(
            post_json(
                &app,
                "/v1/stock/planogram",
                "token-1",
                one_slot_planogram("PLAN-PRODUCTION-PATH", slot_id, inventory_id),
            )
            .await
            .status(),
            StatusCode::OK
        );
        assert_eq!(
            post_json(
                &app,
                "/v1/stock/movements",
                "token-1",
                json!({
                    "movementId": "MOVE-PRODUCTION-PATH-1",
                    "planogramVersion": "PLAN-PRODUCTION-PATH",
                    "slotId": slot_id,
                    "movementType": "planned_refill",
                    "quantity": 2,
                    "source": "field_service",
                    "attributedTo": "operator-1"
                }),
            )
            .await
            .status(),
            StatusCode::CREATED
        );
        record_attested_stock(&app, "PLAN-PRODUCTION-PATH", slot_id, 2).await;

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/v1/sale-readiness")
                    .header(AUTHORIZATION, "Bearer token-1")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let readiness: serde_json::Value = serde_json::from_slice(&body).unwrap();

        assert_eq!(readiness["canStartNetworkAuthorizedSale"], false);
        assert!(readiness["blockingCodes"]
            .as_array()
            .unwrap()
            .contains(&json!("PRODUCTION_DISPENSE_PATH_MOCK")));
        assert_eq!(
            readiness["components"]["productionDispensePath"]["ready"],
            false
        );
        assert_eq!(
            readiness["components"]["productionDispensePath"]["code"],
            "PRODUCTION_DISPENSE_PATH_MOCK"
        );
        assert_eq!(
            readiness["components"]["productionDispensePath"]["message"],
            "生产出货路径不能使用 mock hardwareAdapter"
        );

        {
            let mut public = ctx.config_store.load_public_config().await.expect("config");
            public.hardware_adapter = crate::config::HardwareAdapterKind::Serial;
            public.serial_port_path = Some("/dev/ttyUSB0".to_string());
            ctx.config_store
                .save_public_config(public)
                .await
                .expect("save missing profile config");
            remove_platform_profile_cache(&ctx).await;
        }
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/v1/sale-readiness")
                    .header(AUTHORIZATION, "Bearer token-1")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let readiness: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(readiness["canStartNetworkAuthorizedSale"], false);
        assert!(readiness["blockingCodes"]
            .as_array()
            .unwrap()
            .contains(&json!("PRODUCTION_DISPENSE_PATH_EVIDENCE_MISSING")));
        assert_eq!(
            readiness["components"]["productionDispensePath"]["code"],
            "PRODUCTION_DISPENSE_PATH_EVIDENCE_MISSING"
        );

        {
            write_platform_profile_cache(&ctx, None).await;
            update_profile_hardware_profile_kind(&ctx, "development").await;
        }
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/v1/sale-readiness")
                    .header(AUTHORIZATION, "Bearer token-1")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let readiness: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(readiness["canStartNetworkAuthorizedSale"], false);
        assert!(readiness["blockingCodes"]
            .as_array()
            .unwrap()
            .contains(&json!("PRODUCTION_DISPENSE_PATH_EVIDENCE_MISSING")));
        assert_eq!(
            readiness["components"]["productionDispensePath"]["message"],
            "生产出货路径缺少 production hardwareProfile 证据"
        );

        {
            let mut public = ctx.config_store.load_public_config().await.expect("config");
            public.hardware_adapter = crate::config::HardwareAdapterKind::Serial;
            public.serial_port_path = Some("tcp://127.0.0.1:17991".to_string());
            public.lower_controller_usb_identity = None;
            ctx.config_store
                .save_public_config(public)
                .await
                .expect("save tcp simulator config");
            write_platform_profile_cache(&ctx, None).await;
        }
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/v1/sale-readiness")
                    .header(AUTHORIZATION, "Bearer token-1")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let readiness: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(readiness["canStartNetworkAuthorizedSale"], false);
        assert!(readiness["blockingCodes"]
            .as_array()
            .unwrap()
            .contains(&json!("PRODUCTION_DISPENSE_PATH_TCP_SIMULATOR")));
        assert_eq!(
            readiness["components"]["productionDispensePath"]["message"],
            "生产出货路径不能使用 tcp:// lower-controller simulator"
        );

        {
            let mut public = ctx.config_store.load_public_config().await.expect("config");
            public.serial_port_path = Some("/dev/ttyUSB0".to_string());
            ctx.config_store
                .save_public_config(public)
                .await
                .expect("save serial config");
        }
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/v1/sale-readiness")
                    .header(AUTHORIZATION, "Bearer token-1")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let readiness: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            readiness["canStartNetworkAuthorizedSale"], true,
            "readiness payload: {readiness}"
        );
        assert!(!readiness["blockingCodes"]
            .as_array()
            .unwrap()
            .contains(&json!("PRODUCTION_DISPENSE_PATH_MOCK")));
        assert!(!readiness["blockingCodes"]
            .as_array()
            .unwrap()
            .contains(&json!("PRODUCTION_DISPENSE_PATH_TCP_SIMULATOR")));
        assert_eq!(
            readiness["components"]["productionDispensePath"]["ready"],
            true
        );
    }

    #[tokio::test]
    async fn matching_hardware_slot_topology_allows_planogram_and_sale_readiness() {
        let server = ready_payment_options_server().await;
        let temp_dir = tempdir().expect("tmp");
        let ctx = test_ipc_context(
            temp_dir.path(),
            "token-1",
            Some("MACHINE-1".to_string()),
            &server.uri(),
        )
        .await;
        write_factory_manifest(temp_dir.path(), "vem-prod-24", "2026-06-adr0026").await;
        apply_platform_topology(&ctx, "vem-prod-24", "2026-06-adr0026").await;
        mark_runtime_sale_ready(&ctx).await;
        let app = build_router(ctx);
        let slot_id = "550e8400-e29b-41d4-a716-446655440901";
        let inventory_id = "550e8400-e29b-41d4-a716-446655440902";

        assert_eq!(
            post_json(
                &app,
                "/v1/stock/planogram",
                "token-1",
                one_slot_planogram("PLAN-TOPOLOGY-MATCH", slot_id, inventory_id),
            )
            .await
            .status(),
            StatusCode::OK
        );
        assert_eq!(
            post_json(
                &app,
                "/v1/stock/movements",
                "token-1",
                json!({
                    "movementId": "MOVE-TOPOLOGY-MATCH",
                    "planogramVersion": "PLAN-TOPOLOGY-MATCH",
                    "slotId": slot_id,
                    "movementType": "planned_refill",
                    "quantity": 2,
                    "source": "field_service",
                    "attributedTo": "operator-1"
                }),
            )
            .await
            .status(),
            StatusCode::CREATED
        );
        record_attested_stock(&app, "PLAN-TOPOLOGY-MATCH", slot_id, 2).await;

        let readiness = get_ipc_json(&app, "/v1/sale-readiness", Some("token-1")).await;
        assert_eq!(readiness["canStartNetworkAuthorizedSale"], true);
        assert_eq!(
            readiness["components"]["hardwareSlotTopology"]["code"],
            "HARDWARE_SLOT_TOPOLOGY_MATCH"
        );
    }

    #[tokio::test]
    async fn mismatched_hardware_slot_topology_blocks_readiness_and_planogram_activation() {
        let server = ready_payment_options_server().await;
        let temp_dir = tempdir().expect("tmp");
        let ctx = test_ipc_context(
            temp_dir.path(),
            "token-1",
            Some("MACHINE-1".to_string()),
            &server.uri(),
        )
        .await;
        write_factory_manifest(temp_dir.path(), "vem-prod-24", "factory-v1").await;
        apply_platform_topology(&ctx, "vem-prod-24", "platform-v2").await;
        mark_runtime_sale_ready(&ctx).await;
        let app = build_router(ctx);

        let response = post_json(
            &app,
            "/v1/stock/planogram",
            "token-1",
            one_slot_planogram(
                "PLAN-TOPOLOGY-MISMATCH",
                "550e8400-e29b-41d4-a716-446655440911",
                "550e8400-e29b-41d4-a716-446655440912",
            ),
        )
        .await;
        assert_eq!(response.status(), StatusCode::CONFLICT);
        let body = body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let error: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(error["code"], "hardware_slot_topology_mismatch");
        assert!(!error["message"].as_str().unwrap().contains("550e8400"));

        let readiness = get_ipc_json(&app, "/v1/sale-readiness", Some("token-1")).await;
        assert_eq!(readiness["canStartNetworkAuthorizedSale"], false);
        assert!(readiness["blockingCodes"]
            .as_array()
            .unwrap()
            .contains(&json!("HARDWARE_SLOT_TOPOLOGY_MISMATCH")));
        assert_eq!(
            readiness["components"]["hardwareSlotTopology"]["code"],
            "HARDWARE_SLOT_TOPOLOGY_MISMATCH"
        );
    }

    #[tokio::test]
    async fn bring_up_snapshot_reports_topology_mismatch_from_factory_and_profile_cache() {
        let server = ready_payment_options_server().await;
        let temp_dir = tempdir().expect("tmp");
        let ctx = test_ipc_context(
            temp_dir.path(),
            "token-1",
            Some("MACHINE-1".to_string()),
            &server.uri(),
        )
        .await;
        write_factory_manifest(temp_dir.path(), "vem-prod-24", "factory-v1").await;
        apply_platform_topology(&ctx, "vem-prod-24", "platform-v2").await;
        mark_runtime_sale_ready(&ctx).await;
        let app = build_router(ctx);

        let snapshot = get_ipc_json(&app, "/v1/bring-up", Some("token-1")).await;

        assert_eq!(snapshot["state"], "topology_mismatch");
        assert_eq!(snapshot["currentTask"]["kind"], "resolve_topology");
        assert_eq!(snapshot["currentTask"]["intent"], "open_maintenance");
        assert_eq!(snapshot["allowedActions"]["resolveTopology"], true);
        assert!(snapshot["progress"]
            .as_array()
            .unwrap()
            .iter()
            .any(|step| step["kind"] == "topology" && step["status"] == "current"));
        assert!(snapshot["blockingReasons"]
            .as_array()
            .unwrap()
            .iter()
            .any(|reason| reason["code"] == "HARDWARE_SLOT_TOPOLOGY_MISMATCH"));
    }

    #[tokio::test]
    async fn bring_up_task_execution_rechecks_the_daemon_cursor_before_accepting_an_intent() {
        let temp_dir = tempdir().expect("tmp");
        let ctx = test_ipc_context(
            temp_dir.path(),
            "token-1",
            Some("MACHINE-1".to_string()),
            "http://127.0.0.1:0",
        )
        .await;
        let app = build_router(ctx);

        let response = post_json(
            &app,
            "/v1/bring-up/tasks/execute",
            "token-1",
            json!({
                "contractVersion": 1,
                "taskId": "bring_up.claim_machine",
                "taskVersion": 1,
                "kind": "claim_machine",
                "intent": "claim_machine",
                "mutation": {
                    "type": "claim_machine",
                    "claimCode": "ABCD-2345"
                }
            }),
        )
        .await;

        assert_eq!(response.status(), StatusCode::CONFLICT);
        let body = body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&body).unwrap()["code"],
            "bring_up_task_stale"
        );
    }

    #[tokio::test]
    async fn fresh_preclaim_endpoint_requires_network_evidence_before_factory_claim() {
        let temp_dir = tempdir().expect("tmp");
        let ctx = test_ipc_context(temp_dir.path(), "token-1", None, "http://127.0.0.1:0").await;
        *ctx.ui.status_cache.network.write().await = None;
        let app = build_router(ctx);

        let snapshot = get_ipc_json(&app, "/v1/bring-up", Some("token-1")).await;
        assert_eq!(snapshot["state"], "network_required");
        assert_eq!(
            snapshot["currentTask"]["taskId"],
            "bring_up.configure_network"
        );
        assert_eq!(snapshot["currentTask"]["taskVersion"], 1);
    }

    #[tokio::test]
    async fn legacy_bring_up_mutation_endpoints_do_not_bypass_the_cursor_with_only_ipc_token() {
        let temp_dir = tempdir().expect("tmp");
        let app = build_router(
            test_ipc_context(temp_dir.path(), "token-1", None, "http://127.0.0.1:0").await,
        );
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/v1/network/settings")
                    .header(AUTHORIZATION, "Bearer token-1")
                    .header(CONTENT_TYPE, "application/json")
                    .body(axum::body::Body::from(
                        json!({
                            "ssid": "field-network",
                            "password": "correct-horse-battery-staple",
                            "hidden": false,
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    struct TestMaintenanceAuthorization {
        allow: bool,
    }

    #[async_trait]
    impl MaintenanceAuthorization for TestMaintenanceAuthorization {
        async fn authorize_reclaim(
            &self,
            context: &MaintenanceAuthorizationContext,
        ) -> Result<(), String> {
            if self.allow && context.session_id == "protected-session-1" {
                Ok(())
            } else {
                Err("protected maintenance session is not authorized for reclaim".to_string())
            }
        }

        async fn authorize_non_bring_up_mutation(
            &self,
            context: &MaintenanceAuthorizationContext,
        ) -> Result<(), String> {
            if context.session_id == "test-maintenance-session" {
                Ok(())
            } else {
                Err("protected maintenance session is not authorized for mutation".to_string())
            }
        }
    }

    async fn mark_claim_task_available(ctx: &IpcContext) {
        *ctx.ui.status_cache.network.write().await = Some(NetworkSettingsResponse {
            status: NetworkSetupStatus::Connected,
            ssid: "field-network".to_string(),
            hidden: false,
            diagnostics: vec![crate::network::NetworkDiagnostic {
                component: "provisioning_endpoint".to_string(),
                level: "info".to_string(),
                code: "PROVISIONING_ENDPOINT_REACHABLE".to_string(),
                message: "reachable".to_string(),
            }],
            operator_guidance: "reachable".to_string(),
            updated_at: crate::state::store::now_iso(),
        });
    }

    #[tokio::test]
    async fn protected_daemon_reclaim_request_persists_the_intent_before_projecting_reclaim() {
        let temp_dir = tempdir().expect("tmp");
        let mut ctx = test_ipc_context(
            temp_dir.path(),
            "token-1",
            Some("MACHINE-1".to_string()),
            "http://127.0.0.1:0",
        )
        .await;
        mark_claim_task_available(&ctx).await;
        ctx.maintenance_authorization = Arc::new(TestMaintenanceAuthorization { allow: true });
        let config_store = ctx.config_store.clone();
        let app = build_router(ctx);

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/v1/bring-up/reclaim/request")
                    .header(AUTHORIZATION, "Bearer token-1")
                    .header("x-vem-maintenance-session", "protected-session-1")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(config_store
            .machine_reclaim_requested()
            .await
            .expect("reclaim intent"));

        let snapshot = get_ipc_json(&app, "/v1/bring-up", Some("token-1")).await;
        assert_eq!(snapshot["currentTask"]["kind"], "reclaim_machine");
        assert_eq!(snapshot["currentTask"]["rotateMaintenanceIdentity"], true);
    }

    #[tokio::test]
    async fn legacy_claim_rejects_client_selected_identity_rotation() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/machines/claim"))
            .respond_with(ResponseTemplate::new(200).set_body_json(valid_provisioning_profile()))
            .mount(&server)
            .await;
        let temp_dir = tempdir().expect("tmp");
        let ctx = test_ipc_context(temp_dir.path(), "token-1", None, &server.uri()).await;
        mark_claim_task_available(&ctx).await;
        let app = build_router(ctx);

        let response = post_json(
            &app,
            "/v1/provisioning/claim",
            "token-1",
            json!({
                "claimCode": "RECL-2345",
                "rotateMaintenanceIdentity": true,
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(
            server.received_requests().await.expect("requests").len(),
            0,
            "untrusted legacy input must not reach platform claim",
        );
    }

    #[tokio::test]
    async fn concurrent_legacy_and_typed_claims_share_one_cursor_mutation() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/machines/claim"))
            .respond_with(ResponseTemplate::new(200).set_body_json(valid_provisioning_profile()))
            .mount(&server)
            .await;
        let temp_dir = tempdir().expect("tmp");
        let ctx = test_ipc_context(temp_dir.path(), "token-1", None, &server.uri()).await;
        mark_claim_task_available(&ctx).await;
        let app = build_router(ctx);

        let (legacy, typed) = tokio::join!(
            post_json(
                &app,
                "/v1/provisioning/claim",
                "token-1",
                json!({ "claimCode": "ABCD-2345" }),
            ),
            post_json(
                &app,
                "/v1/bring-up/tasks/execute",
                "token-1",
                json!({
                    "contractVersion": 1,
                    "taskId": "bring_up.claim_machine",
                    "taskVersion": 1,
                    "kind": "claim_machine",
                    "intent": "claim_machine",
                    "mutation": {
                        "type": "claim_machine",
                        "claimCode": "ABCD-2345",
                    },
                }),
            ),
        );
        let statuses = [legacy.status(), typed.status()];
        assert_eq!(
            statuses
                .iter()
                .filter(|status| **status == StatusCode::OK)
                .count(),
            1
        );
        assert_eq!(
            statuses
                .iter()
                .filter(|status| **status == StatusCode::CONFLICT)
                .count(),
            1,
        );
        assert_eq!(
            server
                .received_requests()
                .await
                .expect("requests")
                .into_iter()
                .filter(|request| request.url.path() == "/machines/claim")
                .count(),
            1,
            "only the winning cursor mutation may reach the platform",
        );
    }

    #[tokio::test]
    async fn reclaim_task_is_projected_from_durable_daemon_intent_and_requires_authorization() {
        let temp_dir = tempdir().expect("tmp");
        let ctx = test_ipc_context(
            temp_dir.path(),
            "token-1",
            Some("MACHINE-1".to_string()),
            "http://127.0.0.1:0",
        )
        .await;
        ctx.config_store
            .request_machine_reclaim()
            .await
            .expect("persist reclaim request");
        *ctx.ui.status_cache.network.write().await = Some(NetworkSettingsResponse {
            status: NetworkSetupStatus::Connected,
            ssid: "field-network".to_string(),
            hidden: false,
            diagnostics: vec![crate::network::NetworkDiagnostic {
                component: "provisioning_endpoint".to_string(),
                level: "info".to_string(),
                code: "PROVISIONING_ENDPOINT_REACHABLE".to_string(),
                message: "reachable".to_string(),
            }],
            operator_guidance: "reachable".to_string(),
            updated_at: crate::state::store::now_iso(),
        });
        let app = build_router(ctx);

        let snapshot = get_ipc_json(&app, "/v1/bring-up", Some("token-1")).await;
        assert_eq!(snapshot["state"], "reclaim_required");
        assert_eq!(snapshot["currentTask"]["kind"], "reclaim_machine");
        assert_eq!(snapshot["currentTask"]["rotateMaintenanceIdentity"], true);

        let response = post_json(
            &app,
            "/v1/bring-up/tasks/execute",
            "token-1",
            json!({
                "contractVersion": 1,
                "taskId": "bring_up.reclaim_machine",
                "taskVersion": 1,
                "kind": "reclaim_machine",
                "intent": "reclaim_machine",
                "mutation": {
                    "type": "claim_machine",
                    "claimCode": "RECL-2345"
                }
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let body = body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&body).unwrap()["code"],
            "protected_maintenance_authorization_required"
        );
    }

    #[tokio::test]
    async fn reclaim_task_uses_injected_maintenance_authorization_allow_and_deny_boundaries() {
        for allow in [false, true] {
            let temp_dir = tempdir().expect("tmp");
            let mut ctx = test_ipc_context(
                temp_dir.path(),
                "token-1",
                Some("MACHINE-1".to_string()),
                "http://127.0.0.1:0",
            )
            .await;
            ctx.config_store
                .request_machine_reclaim()
                .await
                .expect("persist reclaim request");
            *ctx.ui.status_cache.network.write().await = Some(NetworkSettingsResponse {
                status: NetworkSetupStatus::Connected,
                ssid: "field-network".to_string(),
                hidden: false,
                diagnostics: vec![crate::network::NetworkDiagnostic {
                    component: "provisioning_endpoint".to_string(),
                    level: "info".to_string(),
                    code: "PROVISIONING_ENDPOINT_REACHABLE".to_string(),
                    message: "reachable".to_string(),
                }],
                operator_guidance: "reachable".to_string(),
                updated_at: crate::state::store::now_iso(),
            });
            ctx.maintenance_authorization = Arc::new(TestMaintenanceAuthorization { allow });
            let app = build_router(ctx);
            let response = post_json(
                &app,
                "/v1/bring-up/tasks/execute",
                "token-1",
                json!({
                    "contractVersion": 1,
                    "taskId": "bring_up.reclaim_machine",
                    "taskVersion": 1,
                    "kind": "reclaim_machine",
                    "intent": "reclaim_machine",
                    "mutation": {
                        "type": "claim_machine",
                        "claimCode": "RECL-2345",
                        "maintenanceAuthorization": { "sessionId": "protected-session-1" }
                    }
                }),
            )
            .await;
            if allow {
                assert_ne!(response.status(), StatusCode::FORBIDDEN);
            } else {
                assert_eq!(response.status(), StatusCode::FORBIDDEN);
            }
        }
    }

    #[tokio::test]
    async fn stock_progress_stays_pending_after_real_daemon_store_reopen_without_attestation_evidence(
    ) {
        let temp_dir = tempdir().expect("tmp");
        let ctx = test_ipc_context(
            temp_dir.path(),
            "token-1",
            Some("MACHINE-1".to_string()),
            "http://127.0.0.1:0",
        )
        .await;
        *ctx.ui.status_cache.network.write().await = Some(NetworkSettingsResponse {
            status: NetworkSetupStatus::Connected,
            ssid: "field-network".to_string(),
            hidden: false,
            diagnostics: vec![crate::network::NetworkDiagnostic {
                component: "provisioning_endpoint".to_string(),
                level: "info".to_string(),
                code: "PROVISIONING_ENDPOINT_REACHABLE".to_string(),
                message: "reachable".to_string(),
            }],
            operator_guidance: "reachable".to_string(),
            updated_at: crate::state::store::now_iso(),
        });
        let before =
            get_ipc_json(&build_router(ctx.clone()), "/v1/bring-up", Some("token-1")).await;
        assert!(before["progress"]
            .as_array()
            .unwrap()
            .iter()
            .any(|step| step["kind"] == "stock" && step["status"] == "upcoming"));
        drop(ctx);

        let restarted = test_ipc_context(
            temp_dir.path(),
            "token-1",
            Some("MACHINE-1".to_string()),
            "http://127.0.0.1:0",
        )
        .await;
        *restarted.ui.status_cache.network.write().await = Some(NetworkSettingsResponse {
            status: NetworkSetupStatus::Connected,
            ssid: "field-network".to_string(),
            hidden: false,
            diagnostics: vec![crate::network::NetworkDiagnostic {
                component: "provisioning_endpoint".to_string(),
                level: "info".to_string(),
                code: "PROVISIONING_ENDPOINT_REACHABLE".to_string(),
                message: "reachable".to_string(),
            }],
            operator_guidance: "reachable".to_string(),
            updated_at: crate::state::store::now_iso(),
        });
        let after = get_ipc_json(&build_router(restarted), "/v1/bring-up", Some("token-1")).await;
        assert!(after["progress"]
            .as_array()
            .unwrap()
            .iter()
            .any(|step| step["kind"] == "stock" && step["status"] == "upcoming"));
    }

    #[tokio::test]
    async fn bring_up_snapshot_uses_factory_manifest_hardware_mode_instead_of_adapter_inference() {
        let temp_dir = tempdir().expect("tmp");
        let ctx = test_ipc_context(
            temp_dir.path(),
            "token-1",
            Some("MACHINE-1".to_string()),
            "http://127.0.0.1:0",
        )
        .await;
        write_factory_manifest(temp_dir.path(), "vem-prod-24", "2026-06-adr0026").await;
        let mut public = ctx.config_store.load_public_config().await.expect("config");
        public.hardware_adapter = crate::config::HardwareAdapterKind::Mock;
        public.serial_port_path = None;
        ctx.config_store
            .save_public_config(public)
            .await
            .expect("save mock public config");
        let app = build_router(ctx);

        let snapshot = get_ipc_json(&app, "/v1/bring-up", Some("token-1")).await;

        assert_eq!(snapshot["hardwareMode"], "production");
    }

    #[tokio::test]
    async fn bring_up_snapshot_does_not_leak_configured_secret_sentinels() {
        let temp_dir = tempdir().expect("tmp");
        let ctx = test_ipc_context(
            temp_dir.path(),
            "token-1",
            Some("MACHINE-1".to_string()),
            "http://127.0.0.1:0",
        )
        .await;
        let public = ctx.config_store.load_public_config().await.expect("config");
        let app = build_router(ctx);
        let response = put_json(
            &app,
            "/v1/config",
            "token-1",
            json!({
                "public": public,
                "secrets": {
                    "machineSecret": "SENTINEL_MACHINE_SECRET_DO_NOT_LEAK_174",
                    "mqttSigningSecret": "SENTINEL_MQTT_SIGNING_SECRET_DO_NOT_LEAK_174",
                    "mqttPassword": "SENTINEL_MQTT_PASSWORD_DO_NOT_LEAK_174"
                }
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);

        let snapshot = get_ipc_json(&app, "/v1/bring-up", Some("token-1")).await;
        let serialized = serde_json::to_string(&snapshot).expect("snapshot json");

        assert!(!serialized.contains("SENTINEL_MACHINE_SECRET_DO_NOT_LEAK_174"));
        assert!(!serialized.contains("SENTINEL_MQTT_SIGNING_SECRET_DO_NOT_LEAK_174"));
        assert!(!serialized.contains("SENTINEL_MQTT_PASSWORD_DO_NOT_LEAK_174"));
    }

    #[tokio::test]
    async fn missing_local_hardware_slot_topology_blocks_sales() {
        let server = ready_payment_options_server().await;
        let temp_dir = tempdir().expect("tmp");
        let ctx = test_ipc_context(
            temp_dir.path(),
            "token-1",
            Some("MACHINE-1".to_string()),
            &server.uri(),
        )
        .await;
        apply_platform_topology(&ctx, "vem-prod-24", "2026-06-adr0026").await;
        mark_runtime_sale_ready(&ctx).await;
        let app = build_router(ctx);

        let response = post_json(
            &app,
            "/v1/stock/planogram",
            "token-1",
            one_slot_planogram(
                "PLAN-TOPOLOGY-NO-LOCAL",
                "550e8400-e29b-41d4-a716-446655440921",
                "550e8400-e29b-41d4-a716-446655440922",
            ),
        )
        .await;
        assert_eq!(response.status(), StatusCode::CONFLICT);
        let readiness = get_ipc_json(&app, "/v1/sale-readiness", Some("token-1")).await;
        assert!(readiness["blockingCodes"]
            .as_array()
            .unwrap()
            .contains(&json!("HARDWARE_SLOT_TOPOLOGY_LOCAL_MISSING")));
    }

    #[tokio::test]
    async fn missing_platform_hardware_slot_topology_blocks_sales() {
        let server = ready_payment_options_server().await;
        let temp_dir = tempdir().expect("tmp");
        let ctx = test_ipc_context(
            temp_dir.path(),
            "token-1",
            Some("MACHINE-1".to_string()),
            &server.uri(),
        )
        .await;
        write_factory_manifest(temp_dir.path(), "vem-prod-24", "2026-06-adr0026").await;
        mark_runtime_sale_ready(&ctx).await;
        let app = build_router(ctx);

        let response = post_json(
            &app,
            "/v1/stock/planogram",
            "token-1",
            one_slot_planogram(
                "PLAN-TOPOLOGY-NO-PLATFORM",
                "550e8400-e29b-41d4-a716-446655440931",
                "550e8400-e29b-41d4-a716-446655440932",
            ),
        )
        .await;
        assert_eq!(response.status(), StatusCode::CONFLICT);
        let readiness = get_ipc_json(&app, "/v1/sale-readiness", Some("token-1")).await;
        assert!(readiness["blockingCodes"]
            .as_array()
            .unwrap()
            .contains(&json!("HARDWARE_SLOT_TOPOLOGY_PLATFORM_MISSING")));
    }

    #[tokio::test]
    async fn local_config_edits_cannot_bypass_topology_mismatch_for_sales() {
        let server = ready_payment_options_server().await;
        let temp_dir = tempdir().expect("tmp");
        let ctx = test_ipc_context(
            temp_dir.path(),
            "token-1",
            Some("MACHINE-1".to_string()),
            &server.uri(),
        )
        .await;
        write_factory_manifest(temp_dir.path(), "vem-prod-24", "factory-v1").await;
        apply_platform_topology(&ctx, "vem-prod-24", "platform-v2").await;
        mark_runtime_sale_ready(&ctx).await;
        let mut public = ctx.config_store.load_public_config().await.expect("config");
        public.machine_code = Some("MACHINE-1".to_string());
        ctx.config_store
            .save_public_config(public)
            .await
            .expect("local config edit");
        let app = build_router(ctx);

        let readiness = get_ipc_json(&app, "/v1/sale-readiness", Some("token-1")).await;
        assert_eq!(readiness["canStartNetworkAuthorizedSale"], false);
        assert!(readiness["blockingCodes"]
            .as_array()
            .unwrap()
            .contains(&json!("HARDWARE_SLOT_TOPOLOGY_MISMATCH")));
    }

    #[tokio::test]
    async fn create_order_intent_rechecks_local_slot_saleability() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(wiremock::matchers::path("/machine-orders/payment-options"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "options": [{
                    "optionKey": "mock:mock",
                    "providerCode": "mock",
                    "method": "mock",
                    "displayName": "模拟支付",
                    "description": "本地模拟",
                    "icon": "mock",
                    "recommended": true,
                    "disabled": false,
                    "disabledReason": null
                }],
                "defaultOptionKey": "mock:mock",
                "defaultProviderCode": "mock",
                "serverTime": "2026-06-04T00:00:00Z"
            })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(wiremock::matchers::path("/machine-orders"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "orderNo": "ORD-BYPASS-2",
                "nextAction": "wait_payment",
                "orderStatus": "pending_payment"
            })))
            .mount(&server)
            .await;

        let temp_dir = tempdir().expect("tmp");
        let ctx = test_ipc_context(
            temp_dir.path(),
            "token-1",
            Some("MACHINE-1".to_string()),
            &server.uri(),
        )
        .await;
        mark_runtime_sale_ready(&ctx).await;
        let app = build_router(ctx);
        let slot_id = "550e8400-e29b-41d4-a716-446655440201";
        let inventory_id = "550e8400-e29b-41d4-a716-446655440202";
        assert_eq!(
            post_json(
                &app,
                "/v1/stock/planogram",
                "token-1",
                one_slot_planogram("PLAN-FROZEN-CREATE", slot_id, inventory_id),
            )
            .await
            .status(),
            StatusCode::OK
        );
        assert_eq!(
            post_json(
                &app,
                "/v1/stock/movements",
                "token-1",
                json!({
                    "movementId": "MOVE-CREATE-FROZEN-1",
                    "planogramVersion": "PLAN-FROZEN-CREATE",
                    "slotId": slot_id,
                    "movementType": "planned_refill",
                    "quantity": 2,
                    "source": "field_service",
                    "attributedTo": "operator-1"
                }),
            )
            .await
            .status(),
            StatusCode::CREATED
        );
        record_attested_stock(&app, "PLAN-FROZEN-CREATE", slot_id, 2).await;
        assert_eq!(
            post_json(
                &app,
                "/v1/stock/slot-sales-state",
                "token-1",
                json!({
                    "planogramVersion": "PLAN-FROZEN-CREATE",
                    "slotId": slot_id,
                    "slotSalesState": "frozen",
                    "source": "operator_hold"
                }),
            )
            .await
            .status(),
            StatusCode::OK
        );

        let response = post_json(
            &app,
            "/v1/intents/create-order",
            "token-1",
            json!({
                "inventoryId": inventory_id,
                "quantity": 1,
                "planogramVersion": "PLAN-FROZEN-CREATE",
                "slotId": slot_id,
                "slotCode": "A1",
                "paymentMethod": "mock",
                "paymentProviderCode": "mock",
                "profileSnapshot": null
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(payload["code"], "create_order_blocked");
        assert!(payload["message"].as_str().unwrap().contains("frozen"));

        let backend_create_order_requests = server
            .received_requests()
            .await
            .expect("recorded requests")
            .into_iter()
            .filter(|request| request.url.path() == "/machine-orders")
            .count();
        assert_eq!(backend_create_order_requests, 0);
    }

    #[tokio::test]
    async fn create_order_intent_rejects_unready_selected_payment_code_when_scanner_unavailable() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(wiremock::matchers::path("/machine-orders/payment-options"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "options": [
                    {
                        "optionKey": "payment_code:alipay",
                        "providerCode": "alipay",
                        "method": "payment_code",
                        "displayName": "支付宝付款码",
                        "description": "请出示付款码",
                        "icon": "alipay",
                        "recommended": true,
                        "disabled": false,
                        "disabledReason": null
                    },
                    {
                        "optionKey": "mock:mock",
                        "providerCode": "mock",
                        "method": "mock",
                        "displayName": "模拟支付",
                        "description": "本地模拟",
                        "icon": "mock",
                        "recommended": false,
                        "disabled": false,
                        "disabledReason": null
                    }
                ],
                "defaultOptionKey": "mock:mock",
                "defaultProviderCode": "mock",
                "serverTime": "2026-06-04T00:00:00Z"
            })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(wiremock::matchers::path("/machine-orders"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "orderNo": "ORD-SCANNER-BYPASS",
                "nextAction": "wait_payment",
                "orderStatus": "pending_payment"
            })))
            .mount(&server)
            .await;

        let temp_dir = tempdir().expect("tmp");
        let ctx = test_ipc_context(
            temp_dir.path(),
            "token-1",
            Some("MACHINE-1".to_string()),
            &server.uri(),
        )
        .await;
        mark_runtime_sale_ready(&ctx).await;
        {
            let mut scanner = ctx.ui.status_cache.scanner.write().await;
            scanner.online = false;
            scanner.code = "SCANNER_OPEN_FAILED".to_string();
            scanner.message = "scanner open failed".to_string();
        }
        let app = build_router(ctx);
        let slot_id = "550e8400-e29b-41d4-a716-446655440301";
        let inventory_id = "550e8400-e29b-41d4-a716-446655440302";
        assert_eq!(
            post_json(
                &app,
                "/v1/stock/planogram",
                "token-1",
                one_slot_planogram("PLAN-SCANNER-PAYMENT-CODE", slot_id, inventory_id),
            )
            .await
            .status(),
            StatusCode::OK
        );
        assert_eq!(
            post_json(
                &app,
                "/v1/stock/movements",
                "token-1",
                json!({
                    "movementId": "MOVE-SCANNER-PAYMENT-CODE-1",
                    "planogramVersion": "PLAN-SCANNER-PAYMENT-CODE",
                    "slotId": slot_id,
                    "movementType": "planned_refill",
                    "quantity": 2,
                    "source": "field_service",
                    "attributedTo": "operator-1"
                }),
            )
            .await
            .status(),
            StatusCode::CREATED
        );
        record_attested_stock(&app, "PLAN-SCANNER-PAYMENT-CODE", slot_id, 2).await;

        let readiness_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/v1/sale-readiness")
                    .header(AUTHORIZATION, "Bearer token-1")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(readiness_response.status(), StatusCode::OK);
        let readiness_body = body::to_bytes(readiness_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let readiness: serde_json::Value = serde_json::from_slice(&readiness_body).unwrap();
        assert_eq!(readiness["canStartNetworkAuthorizedSale"], true);
        assert_eq!(readiness["components"]["paymentOptions"]["ready"], true);
        let payment_code_method = readiness["components"]["paymentOptions"]["methods"]
            .as_array()
            .unwrap()
            .iter()
            .find(|method| method["optionKey"] == "payment_code:alipay")
            .expect("payment_code option");
        assert_eq!(payment_code_method["ready"], false);

        let response = post_json(
            &app,
            "/v1/intents/create-order",
            "token-1",
            json!({
                "inventoryId": inventory_id,
                "quantity": 1,
                "planogramVersion": "PLAN-SCANNER-PAYMENT-CODE",
                "slotId": slot_id,
                "slotCode": "A1",
                "paymentMethod": "payment_code",
                "paymentProviderCode": "alipay",
                "profileSnapshot": null
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(payload["code"], "create_order_blocked");
        assert_eq!(
            payload["message"],
            PAYMENT_CODE_SCANNER_UNAVAILABLE_CUSTOMER_MESSAGE
        );
        let customer_message = payload["message"].as_str().unwrap();
        assert!(!customer_message.contains("selected payment option"));
        assert!(!customer_message.contains("/v1/intents/create-order"));
        assert!(!customer_message.contains("SCANNER_OPEN_FAILED"));
        assert!(!customer_message.contains("serial"));

        let backend_create_order_requests = server
            .received_requests()
            .await
            .expect("recorded requests")
            .into_iter()
            .filter(|request| request.url.path() == "/machine-orders")
            .count();
        assert_eq!(backend_create_order_requests, 0);
    }

    #[tokio::test]
    async fn create_order_intent_allows_ready_qr_code_when_scanner_unavailable() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(wiremock::matchers::path("/machine-orders/payment-options"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "options": [
                    {
                        "optionKey": "payment_code:alipay",
                        "providerCode": "alipay",
                        "method": "payment_code",
                        "displayName": "支付宝付款码",
                        "description": "请出示付款码",
                        "icon": "alipay",
                        "recommended": true,
                        "disabled": false,
                        "disabledReason": null
                    },
                    {
                        "optionKey": "qr_code:alipay",
                        "providerCode": "alipay",
                        "method": "qr_code",
                        "displayName": "支付宝扫码支付",
                        "description": "请扫码支付",
                        "icon": "alipay",
                        "recommended": false,
                        "disabled": false,
                        "disabledReason": null
                    }
                ],
                "defaultOptionKey": "qr_code:alipay",
                "defaultProviderCode": "alipay",
                "serverTime": "2026-06-04T00:00:00Z"
            })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(wiremock::matchers::path("/machine-orders"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "orderNo": "ORD-QR-SCANNER-OFFLINE",
                "nextAction": "wait_payment",
                "orderStatus": "pending_payment",
                "totalAmountCents": 300
            })))
            .mount(&server)
            .await;

        let temp_dir = tempdir().expect("tmp");
        let ctx = test_ipc_context(
            temp_dir.path(),
            "token-1",
            Some("MACHINE-1".to_string()),
            &server.uri(),
        )
        .await;
        mark_runtime_sale_ready(&ctx).await;
        {
            let mut scanner = ctx.ui.status_cache.scanner.write().await;
            scanner.online = false;
            scanner.code = "SCANNER_OPEN_FAILED".to_string();
            scanner.message = "scanner open failed".to_string();
        }
        let app = build_router(ctx);
        let slot_id = "550e8400-e29b-41d4-a716-446655440401";
        let inventory_id = "550e8400-e29b-41d4-a716-446655440402";
        assert_eq!(
            post_json(
                &app,
                "/v1/stock/planogram",
                "token-1",
                one_slot_planogram("PLAN-SCANNER-QR", slot_id, inventory_id),
            )
            .await
            .status(),
            StatusCode::OK
        );
        assert_eq!(
            post_json(
                &app,
                "/v1/stock/movements",
                "token-1",
                json!({
                    "movementId": "MOVE-SCANNER-QR-1",
                    "planogramVersion": "PLAN-SCANNER-QR",
                    "slotId": slot_id,
                    "movementType": "planned_refill",
                    "quantity": 2,
                    "source": "field_service",
                    "attributedTo": "operator-1"
                }),
            )
            .await
            .status(),
            StatusCode::CREATED
        );
        record_attested_stock(&app, "PLAN-SCANNER-QR", slot_id, 2).await;

        let response = post_json(
            &app,
            "/v1/intents/create-order",
            "token-1",
            json!({
                "inventoryId": inventory_id,
                "quantity": 1,
                "planogramVersion": "PLAN-SCANNER-QR",
                "slotId": slot_id,
                "slotCode": "A1",
                "paymentMethod": "qr_code",
                "paymentProviderCode": "alipay",
                "profileSnapshot": null
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);

        let backend_create_order_requests = server
            .received_requests()
            .await
            .expect("recorded requests")
            .into_iter()
            .filter(|request| request.url.path() == "/machine-orders")
            .count();
        assert_eq!(backend_create_order_requests, 1);
    }

    #[tokio::test]
    async fn dev_submit_payment_code_rechecks_scanner_before_backend_submit() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(wiremock::matchers::path("/machine-orders/payment-options"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "options": [{
                    "optionKey": "payment_code:alipay",
                    "providerCode": "alipay",
                    "method": "payment_code",
                    "displayName": "支付宝付款码",
                    "description": "请出示付款码",
                    "icon": "alipay",
                    "recommended": true,
                    "disabled": false,
                    "disabledReason": null
                }],
                "defaultOptionKey": "payment_code:alipay",
                "defaultProviderCode": "alipay",
                "serverTime": "2026-06-04T00:00:00Z"
            })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(wiremock::matchers::path("/machine-orders"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "orderNo": "ORD-SCANNER-RACE",
                "nextAction": "wait_payment",
                "orderStatus": "waiting_payment",
                "totalAmountCents": 300
            })))
            .mount(&server)
            .await;
        let submit_mock = Mock::given(method("POST"))
            .and(wiremock::matchers::path(
                "/machine-orders/ORD-SCANNER-RACE/payment-code/submit",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "status": "succeeded",
                "canRetry": false
            })))
            .expect(0)
            .mount_as_scoped(&server)
            .await;

        let temp_dir = tempdir().expect("tmp");
        let ctx = test_ipc_context(
            temp_dir.path(),
            "token-1",
            Some("MACHINE-1".to_string()),
            &server.uri(),
        )
        .await;
        mark_runtime_sale_ready(&ctx).await;
        let app = build_router(ctx.clone());
        let slot_id = "550e8400-e29b-41d4-a716-446655440601";
        let inventory_id = "550e8400-e29b-41d4-a716-446655440602";
        assert_eq!(
            post_json(
                &app,
                "/v1/stock/planogram",
                "token-1",
                one_slot_planogram("PLAN-SCANNER-RACE", slot_id, inventory_id),
            )
            .await
            .status(),
            StatusCode::OK
        );
        assert_eq!(
            post_json(
                &app,
                "/v1/stock/movements",
                "token-1",
                json!({
                    "movementId": "MOVE-SCANNER-RACE-1",
                    "planogramVersion": "PLAN-SCANNER-RACE",
                    "slotId": slot_id,
                    "movementType": "planned_refill",
                    "quantity": 2,
                    "source": "field_service",
                    "attributedTo": "operator-1"
                }),
            )
            .await
            .status(),
            StatusCode::CREATED
        );
        record_attested_stock(&app, "PLAN-SCANNER-RACE", slot_id, 2).await;

        let create_response = post_json(
            &app,
            "/v1/intents/create-order",
            "token-1",
            json!({
                "inventoryId": inventory_id,
                "quantity": 1,
                "planogramVersion": "PLAN-SCANNER-RACE",
                "slotId": slot_id,
                "slotCode": "A1",
                "paymentMethod": "payment_code",
                "paymentProviderCode": "alipay",
                "profileSnapshot": null
            }),
        )
        .await;
        assert_eq!(create_response.status(), StatusCode::OK);

        {
            let mut scanner = ctx.ui.status_cache.scanner.write().await;
            scanner.online = false;
            scanner.code = "SCANNER_OPEN_FAILED".to_string();
            scanner.message = "open serial port /dev/vem-secret-scanner failed".to_string();
        }

        let submit_response = post_json(
            &app,
            "/v1/intents/dev-submit-payment-code",
            "token-1",
            json!({
                "orderNo": "ORD-SCANNER-RACE",
                "authCode": "2829123456784955",
                "source": "browser_test"
            }),
        )
        .await;
        assert_eq!(submit_response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        let body = body::to_bytes(submit_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(payload["code"], "submit_payment_code_failed");
        assert_eq!(payload["message"], "扫码器暂不可用，请选择其他支付方式");

        let tx = get_ipc_json(&app, "/v1/transactions/current", Some("token-1")).await;
        assert!(tx
            .get("paymentCodeAttempt")
            .map(|value| value.is_null())
            .unwrap_or(true));
        drop(submit_mock);
    }

    #[tokio::test]
    async fn create_order_intent_allows_ready_mock_when_scanner_unavailable() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(wiremock::matchers::path("/machine-orders/payment-options"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "options": [{
                    "optionKey": "mock:mock",
                    "providerCode": "mock",
                    "method": "mock",
                    "displayName": "模拟支付",
                    "description": "本地模拟",
                    "icon": "mock",
                    "recommended": true,
                    "disabled": false,
                    "disabledReason": null
                }],
                "defaultOptionKey": "mock:mock",
                "defaultProviderCode": "mock",
                "serverTime": "2026-06-04T00:00:00Z"
            })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(wiremock::matchers::path("/machine-orders"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "orderNo": "ORD-MOCK-SCANNER-OFFLINE",
                "nextAction": "wait_payment",
                "orderStatus": "pending_payment",
                "totalAmountCents": 300
            })))
            .mount(&server)
            .await;

        let temp_dir = tempdir().expect("tmp");
        let ctx = test_ipc_context(
            temp_dir.path(),
            "token-1",
            Some("MACHINE-1".to_string()),
            &server.uri(),
        )
        .await;
        mark_runtime_sale_ready(&ctx).await;
        {
            let mut scanner = ctx.ui.status_cache.scanner.write().await;
            scanner.online = false;
            scanner.code = "SCANNER_OPEN_FAILED".to_string();
            scanner.message = "scanner open failed".to_string();
        }
        let app = build_router(ctx);
        let slot_id = "550e8400-e29b-41d4-a716-446655440501";
        let inventory_id = "550e8400-e29b-41d4-a716-446655440502";
        assert_eq!(
            post_json(
                &app,
                "/v1/stock/planogram",
                "token-1",
                one_slot_planogram("PLAN-SCANNER-MOCK", slot_id, inventory_id),
            )
            .await
            .status(),
            StatusCode::OK
        );
        assert_eq!(
            post_json(
                &app,
                "/v1/stock/movements",
                "token-1",
                json!({
                    "movementId": "MOVE-SCANNER-MOCK-1",
                    "planogramVersion": "PLAN-SCANNER-MOCK",
                    "slotId": slot_id,
                    "movementType": "planned_refill",
                    "quantity": 2,
                    "source": "field_service",
                    "attributedTo": "operator-1"
                }),
            )
            .await
            .status(),
            StatusCode::CREATED
        );
        record_attested_stock(&app, "PLAN-SCANNER-MOCK", slot_id, 2).await;

        let response = post_json(
            &app,
            "/v1/intents/create-order",
            "token-1",
            json!({
                "inventoryId": inventory_id,
                "quantity": 1,
                "planogramVersion": "PLAN-SCANNER-MOCK",
                "slotId": slot_id,
                "slotCode": "A1",
                "paymentMethod": "mock",
                "profileSnapshot": null
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);

        let backend_create_order_requests = server
            .received_requests()
            .await
            .expect("recorded requests")
            .into_iter()
            .filter(|request| request.url.path() == "/machine-orders")
            .count();
        assert_eq!(backend_create_order_requests, 1);
    }

    #[tokio::test]
    async fn create_order_intent_sends_verified_planogram_slot_context_to_platform() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/machine-orders/payment-options"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "options": [{
                    "optionKey": "mock:mock",
                    "providerCode": "mock",
                    "method": "mock",
                    "displayName": "模拟支付",
                    "description": "本地模拟",
                    "icon": "mock",
                    "recommended": true,
                    "disabled": false,
                    "disabledReason": null
                }],
                "defaultOptionKey": "mock:mock",
                "defaultProviderCode": "mock",
                "serverTime": "2026-06-04T00:00:00Z"
            })))
            .mount(&server)
            .await;

        let slot_id = "550e8400-e29b-41d4-a716-446655440601";
        let inventory_id = "550e8400-e29b-41d4-a716-446655440602";
        Mock::given(method("POST"))
            .and(path("/machine-orders"))
            .and(body_partial_json(json!({
                "machineCode": "MACHINE-1",
                "items": [{
                    "inventoryId": inventory_id,
                    "quantity": 1,
                    "planogramVersion": "PLAN-NETWORK-AUTH",
                    "slotId": slot_id,
                    "slotCode": "A1"
                }]
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "orderNo": "ORD-NETWORK-AUTH",
                "nextAction": "wait_payment",
                "orderStatus": "pending_payment",
                "totalAmountCents": 300
            })))
            .mount(&server)
            .await;

        let temp_dir = tempdir().expect("tmp");
        let ctx = test_ipc_context(
            temp_dir.path(),
            "token-1",
            Some("MACHINE-1".to_string()),
            &server.uri(),
        )
        .await;
        mark_runtime_sale_ready(&ctx).await;
        let app = build_router(ctx);
        assert_eq!(
            post_json(
                &app,
                "/v1/stock/planogram",
                "token-1",
                one_slot_planogram("PLAN-NETWORK-AUTH", slot_id, inventory_id),
            )
            .await
            .status(),
            StatusCode::OK
        );
        assert_eq!(
            post_json(
                &app,
                "/v1/stock/movements",
                "token-1",
                json!({
                    "movementId": "MOVE-NETWORK-AUTH-1",
                    "planogramVersion": "PLAN-NETWORK-AUTH",
                    "slotId": slot_id,
                    "movementType": "planned_refill",
                    "quantity": 2,
                    "source": "field_service",
                    "attributedTo": "operator-1"
                }),
            )
            .await
            .status(),
            StatusCode::CREATED
        );
        record_attested_stock(&app, "PLAN-NETWORK-AUTH", slot_id, 2).await;

        let response = post_json(
            &app,
            "/v1/intents/create-order",
            "token-1",
            json!({
                "inventoryId": inventory_id,
                "quantity": 1,
                "planogramVersion": "PLAN-NETWORK-AUTH",
                "slotId": slot_id,
                "slotCode": "A1",
                "paymentMethod": "mock",
                "paymentProviderCode": "mock",
                "profileSnapshot": null
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn create_order_intent_surfaces_platform_refusal_without_mutating_local_stock() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/machine-orders/payment-options"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "options": [{
                    "optionKey": "mock:mock",
                    "providerCode": "mock",
                    "method": "mock",
                    "displayName": "模拟支付",
                    "description": "本地模拟",
                    "icon": "mock",
                    "recommended": true,
                    "disabled": false,
                    "disabledReason": null
                }],
                "defaultOptionKey": "mock:mock",
                "defaultProviderCode": "mock",
                "serverTime": "2026-06-04T00:00:00Z"
            })))
            .mount(&server)
            .await;

        Mock::given(method("POST"))
            .and(path("/machine-orders"))
            .respond_with(ResponseTemplate::new(409).set_body_json(json!({
                "message": "Inventory is not available"
            })))
            .mount(&server)
            .await;

        let slot_id = "550e8400-e29b-41d4-a716-446655440701";
        let inventory_id = "550e8400-e29b-41d4-a716-446655440702";
        let temp_dir = tempdir().expect("tmp");
        let ctx = test_ipc_context(
            temp_dir.path(),
            "token-1",
            Some("MACHINE-1".to_string()),
            &server.uri(),
        )
        .await;
        mark_runtime_sale_ready(&ctx).await;
        let app = build_router(ctx);
        assert_eq!(
            post_json(
                &app,
                "/v1/stock/planogram",
                "token-1",
                one_slot_planogram("PLAN-PLATFORM-REFUSAL", slot_id, inventory_id),
            )
            .await
            .status(),
            StatusCode::OK
        );
        assert_eq!(
            post_json(
                &app,
                "/v1/stock/movements",
                "token-1",
                json!({
                    "movementId": "MOVE-PLATFORM-REFUSAL-1",
                    "planogramVersion": "PLAN-PLATFORM-REFUSAL",
                    "slotId": slot_id,
                    "movementType": "planned_refill",
                    "quantity": 2,
                    "source": "field_service",
                    "attributedTo": "operator-1"
                }),
            )
            .await
            .status(),
            StatusCode::CREATED
        );
        record_attested_stock(&app, "PLAN-PLATFORM-REFUSAL", slot_id, 2).await;

        let response = post_json(
            &app,
            "/v1/intents/create-order",
            "token-1",
            json!({
                "inventoryId": inventory_id,
                "quantity": 1,
                "planogramVersion": "PLAN-PLATFORM-REFUSAL",
                "slotId": slot_id,
                "slotCode": "A1",
                "paymentMethod": "mock",
                "paymentProviderCode": "mock",
                "profileSnapshot": null
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(payload["code"], "create_order_failed");
        assert!(payload["message"]
            .as_str()
            .unwrap()
            .contains("Inventory is not available"));

        let sale_view = app
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/v1/sale-view")
                    .header(AUTHORIZATION, "Bearer token-1")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(sale_view.status(), StatusCode::OK);
        let body = body::to_bytes(sale_view.into_body(), usize::MAX)
            .await
            .unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let item = &payload["items"][0];
        assert_eq!(item["physicalStock"], 2);
        assert_eq!(item["saleableStock"], 2);
        assert_eq!(item["slotSalesState"], "sale_ready");
    }

    #[tokio::test]
    async fn sale_view_projects_local_planogram_and_refill_without_available_qty() {
        let temp_dir = tempdir().expect("tmp");
        let app = build_router(
            test_ipc_context(
                temp_dir.path(),
                "token-1",
                Some("MACHINE-1".to_string()),
                "http://127.0.0.1:0",
            )
            .await,
        );

        let apply_planogram = Request::builder()
            .method(Method::POST)
            .uri("/v1/stock/planogram")
            .header(AUTHORIZATION, "Bearer token-1")
            .header(CONTENT_TYPE, "application/json")
            .body(axum::body::Body::from(
                json!({
                    "planogramVersion": "PLAN-2026-06-04",
                    "source": "local_seed",
                    "appliedBy": "operator-1",
                    "slots": [{
                        "slotId": "550e8400-e29b-41d4-a716-446655440001",
                        "slotCode": "A1",
                        "layerNo": 1,
                        "cellNo": 1,
                        "capacity": 8,
                        "parLevel": 6,
                        "inventoryId": "550e8400-e29b-41d4-a716-446655440002",
                        "variantId": "550e8400-e29b-41d4-a716-446655440003",
                        "productId": "550e8400-e29b-41d4-a716-446655440004",
                        "productName": "矿泉水",
                        "productDescription": null,
                        "coverImageUrl": null,
                        "categoryId": null,
                        "categoryName": null,
                        "sku": "WATER-001",
                        "size": "550ml",
                        "color": null,
                        "priceCents": 200,
                        "productSortOrder": 1,
                        "targetGender": null
                    }]
                })
                .to_string(),
            ))
            .unwrap();
        assert_eq!(
            app.clone().oneshot(apply_planogram).await.unwrap().status(),
            StatusCode::OK
        );

        let refill = Request::builder()
            .method(Method::POST)
            .uri("/v1/stock/movements")
            .header(AUTHORIZATION, "Bearer token-1")
            .header(CONTENT_TYPE, "application/json")
            .body(axum::body::Body::from(
                json!({
                    "movementId": "MOVE-1",
                    "planogramVersion": "PLAN-2026-06-04",
                    "slotId": "550e8400-e29b-41d4-a716-446655440001",
                    "movementType": "planned_refill",
                    "quantity": 3,
                    "source": "field_service",
                    "attributedTo": "operator-1"
                })
                .to_string(),
            ))
            .unwrap();
        assert_eq!(
            app.clone().oneshot(refill).await.unwrap().status(),
            StatusCode::CREATED
        );

        let sale_view = Request::builder()
            .method(Method::GET)
            .uri("/v1/sale-view")
            .header(AUTHORIZATION, "Bearer token-1")
            .body(axum::body::Body::empty())
            .unwrap();
        let response = app.oneshot(sale_view).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let item = &payload["items"][0];
        assert_eq!(item["productName"], "矿泉水");
        assert_eq!(item["slotCode"], "A1");
        assert_eq!(item["physicalStock"], 3);
        assert_eq!(item["saleableStock"], 3);
        assert_eq!(item["slotSalesState"], "sale_ready");
        assert!(item.get("availableQty").is_none());
    }

    #[tokio::test]
    async fn first_planogram_application_requires_stock_count_before_slot_is_sale_ready() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(wiremock::matchers::path("/machine-orders/payment-options"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "options": [{
                    "optionKey": "mock:mock",
                    "providerCode": "mock",
                    "method": "mock",
                    "displayName": "模拟支付",
                    "description": "本地模拟",
                    "icon": "mock",
                    "recommended": true,
                    "disabled": false,
                    "disabledReason": null
                }],
                "defaultOptionKey": "mock:mock",
                "defaultProviderCode": "mock",
                "serverTime": "2026-06-04T00:00:00Z"
            })))
            .mount(&server)
            .await;

        let temp_dir = tempdir().expect("tmp");
        let ctx = test_ipc_context(
            temp_dir.path(),
            "token-1",
            Some("MACHINE-1".to_string()),
            &server.uri(),
        )
        .await;
        mark_runtime_sale_ready(&ctx).await;
        let app = build_router(ctx);
        let slot_id = "550e8400-e29b-41d4-a716-4466554400b1";
        let inventory_id = "550e8400-e29b-41d4-a716-4466554400b2";

        assert_eq!(
            post_json(
                &app,
                "/v1/stock/planogram",
                "token-1",
                one_slot_planogram("PLAN-FIRST-COUNT", slot_id, inventory_id),
            )
            .await
            .status(),
            StatusCode::OK
        );

        let sale_view = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/v1/sale-view")
                    .header(AUTHORIZATION, "Bearer token-1")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(sale_view.status(), StatusCode::OK);
        let body = body::to_bytes(sale_view.into_body(), usize::MAX)
            .await
            .unwrap();
        let sale_view: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(sale_view["items"][0]["physicalStock"], 0);
        assert_eq!(sale_view["items"][0]["saleableStock"], 0);
        assert_eq!(sale_view["items"][0]["slotSalesState"], "needs_count");

        let readiness = app
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/v1/sale-readiness")
                    .header(AUTHORIZATION, "Bearer token-1")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(readiness.status(), StatusCode::OK);
        let body = body::to_bytes(readiness.into_body(), usize::MAX)
            .await
            .unwrap();
        let readiness: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(readiness["canStartNetworkAuthorizedSale"], false);
        assert!(readiness["blockingCodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|code| code == "NO_SALEABLE_SLOTS"));
        assert_eq!(readiness["components"]["slotSaleSafety"]["ready"], false);
        assert_eq!(
            readiness["components"]["slotSaleSafety"]["blockedSlots"][0]["slotSalesState"],
            "needs_count"
        );
    }

    #[tokio::test]
    async fn sale_readiness_reports_frozen_slots_while_other_slots_remain_saleable() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(wiremock::matchers::path("/machine-orders/payment-options"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "options": [{
                    "optionKey": "mock:mock",
                    "providerCode": "mock",
                    "method": "mock",
                    "displayName": "模拟支付",
                    "description": "本地模拟",
                    "icon": "mock",
                    "recommended": true,
                    "disabled": false,
                    "disabledReason": null
                }],
                "defaultOptionKey": "mock:mock",
                "defaultProviderCode": "mock",
                "serverTime": "2026-06-04T00:00:00Z"
            })))
            .mount(&server)
            .await;

        let temp_dir = tempdir().expect("tmp");
        let ctx = test_ipc_context(
            temp_dir.path(),
            "token-1",
            Some("MACHINE-1".to_string()),
            &server.uri(),
        )
        .await;
        mark_runtime_sale_ready(&ctx).await;
        let app = build_router(ctx);
        let frozen_slot_id = "550e8400-e29b-41d4-a716-4466554400d1";
        let saleable_slot_id = "550e8400-e29b-41d4-a716-4466554400e1";

        assert_eq!(
            post_json(
                &app,
                "/v1/stock/planogram",
                "token-1",
                json!({
                    "planogramVersion": "PLAN-FROZEN-PARTIAL",
                    "source": "local_seed",
                    "appliedBy": "operator-1",
                    "slots": [
                        {
                            "slotId": frozen_slot_id,
                            "slotCode": "A1",
                            "layerNo": 1,
                            "cellNo": 1,
                            "capacity": 8,
                            "parLevel": 6,
                            "inventoryId": "550e8400-e29b-41d4-a716-4466554400d2",
                            "variantId": "550e8400-e29b-41d4-a716-4466554400d3",
                            "productId": "550e8400-e29b-41d4-a716-4466554400d4",
                            "productName": "故障货道商品",
                            "productDescription": null,
                            "coverImageUrl": null,
                            "categoryId": null,
                            "categoryName": null,
                            "sku": "FROZEN-001",
                            "size": null,
                            "color": null,
                            "priceCents": 200,
                            "productSortOrder": 1,
                            "targetGender": null
                        },
                        {
                            "slotId": saleable_slot_id,
                            "slotCode": "A2",
                            "layerNo": 1,
                            "cellNo": 2,
                            "capacity": 8,
                            "parLevel": 6,
                            "inventoryId": "550e8400-e29b-41d4-a716-4466554400e2",
                            "variantId": "550e8400-e29b-41d4-a716-4466554400e3",
                            "productId": "550e8400-e29b-41d4-a716-4466554400e4",
                            "productName": "正常货道商品",
                            "productDescription": null,
                            "coverImageUrl": null,
                            "categoryId": null,
                            "categoryName": null,
                            "sku": "READY-001",
                            "size": null,
                            "color": null,
                            "priceCents": 200,
                            "productSortOrder": 2,
                            "targetGender": null
                        }
                    ]
                }),
            )
            .await
            .status(),
            StatusCode::OK
        );
        for (movement_id, slot_id) in [
            ("MOVE-FROZEN-PARTIAL-1", frozen_slot_id),
            ("MOVE-FROZEN-PARTIAL-2", saleable_slot_id),
        ] {
            assert_eq!(
                post_json(
                    &app,
                    "/v1/stock/movements",
                    "token-1",
                    json!({
                        "movementId": movement_id,
                        "planogramVersion": "PLAN-FROZEN-PARTIAL",
                        "slotId": slot_id,
                        "movementType": "planned_refill",
                        "quantity": 2,
                        "source": "field_service",
                        "attributedTo": "operator-1"
                    }),
                )
                .await
                .status(),
                StatusCode::CREATED
            );
        }
        assert_eq!(
            post_json(
                &app,
                "/v1/stock/slot-sales-state",
                "token-1",
                json!({
                    "planogramVersion": "PLAN-FROZEN-PARTIAL",
                    "slotId": frozen_slot_id,
                    "slotSalesState": "frozen",
                    "source": "dispense_failure"
                }),
            )
            .await
            .status(),
            StatusCode::OK
        );

        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/v1/sale-readiness")
                    .header(AUTHORIZATION, "Bearer token-1")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let readiness: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(readiness["components"]["slotSaleSafety"]["ready"], true);
        assert!(!readiness["blockingCodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|code| code == "NO_SALEABLE_SLOTS"));
        assert_eq!(
            readiness["components"]["slotSaleSafety"]["blockedSlots"][0]["slotCode"],
            "A1"
        );
        assert_eq!(
            readiness["components"]["slotSaleSafety"]["blockedSlots"][0]["slotSalesState"],
            "frozen"
        );
        assert!(readiness["components"]["slotSaleSafety"]["message"]
            .as_str()
            .unwrap()
            .contains("locked"));
    }

    #[tokio::test]
    async fn sale_readiness_is_exposed_separately_from_sale_view_stock() {
        let temp_dir = tempdir().expect("tmp");
        let app = build_router(
            test_ipc_context(
                temp_dir.path(),
                "token-1",
                Some("MACHINE-1".to_string()),
                "http://127.0.0.1:0",
            )
            .await,
        );

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/v1/sale-readiness")
                    .header(AUTHORIZATION, "Bearer token-1")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let readiness: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(readiness["canStartNetworkAuthorizedSale"], false);
        assert_eq!(
            readiness["components"]["platformReachability"]["ready"],
            false
        );
        assert_eq!(
            readiness["components"]["machineAuthentication"]["ready"],
            true
        );
        assert_eq!(readiness["components"]["activePlanogram"]["ready"], false);
        assert_eq!(readiness["components"]["paymentOptions"]["ready"], false);
        assert_eq!(readiness["components"]["scannerCapability"]["ready"], false);
        assert_eq!(readiness["components"]["syncHealth"]["ready"], false);
        assert!(readiness["blockingCodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|code| code == "ACTIVE_PLANOGRAM_MISSING"));

        let sale_view_response = app
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/v1/sale-view")
                    .header(AUTHORIZATION, "Bearer token-1")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(sale_view_response.status(), StatusCode::OK);
        let body = body::to_bytes(sale_view_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let sale_view: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(sale_view["source"], "local_stock");
        assert!(sale_view.get("canStartNetworkAuthorizedSale").is_none());
    }

    #[tokio::test]
    async fn whole_machine_hardware_fault_blocks_readiness_until_maintenance_clear() {
        let temp_dir = tempdir().expect("tmp");
        let ctx = test_ipc_context(
            temp_dir.path(),
            "token-1",
            Some("MACHINE-1".to_string()),
            "http://127.0.0.1:0",
        )
        .await;
        mark_runtime_sale_ready(&ctx).await;
        let app = build_router(ctx.clone());
        let slot_id = "550e8400-e29b-41d4-a716-446655441001";
        let inventory_id = "550e8400-e29b-41d4-a716-446655441002";

        assert_eq!(
            post_json(
                &app,
                "/v1/stock/planogram",
                "token-1",
                one_slot_planogram("PLAN-WHOLE-MACHINE-LOCK", slot_id, inventory_id),
            )
            .await
            .status(),
            StatusCode::OK
        );

        ctx.state
            .block_slot_for_dispense_failure(
                &vending_core::hardware::DispenseCommandPayload {
                    command_no: "CMD-WHOLE-MACHINE-LOCK".to_string(),
                    order_no: "ORD-WHOLE-MACHINE-LOCK".to_string(),
                    slot: vending_core::hardware::SlotPayload {
                        layer_no: 1,
                        cell_no: 1,
                        slot_code: "A1".to_string(),
                    },
                    quantity: 1,
                    timeout_seconds: 30,
                },
                Some("JAMMED"),
                Some("lower controller reported pickup platform blocked"),
            )
            .await
            .expect("block")
            .expect("slot found");

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/v1/sale-readiness")
                    .header(AUTHORIZATION, "Bearer token-1")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let readiness: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            readiness["components"]["wholeMachineBlockers"]["code"],
            "WHOLE_MACHINE_HARDWARE_FAULT"
        );
        assert!(readiness["blockingCodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|code| code == "WHOLE_MACHINE_HARDWARE_FAULT"));

        let readyz_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/readyz")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(readyz_response.status(), StatusCode::OK);
        let body = body::to_bytes(readyz_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let readyz: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(readyz["canSell"], false);
        assert_eq!(readyz["suggestedRoute"], "maintenance");
        assert!(readyz["blockingCodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|code| code == "WHOLE_MACHINE_HARDWARE_FAULT"));

        let restarted_ctx = test_ipc_context(
            temp_dir.path(),
            "token-1",
            Some("MACHINE-1".to_string()),
            "http://127.0.0.1:0",
        )
        .await;
        mark_runtime_sale_ready(&restarted_ctx).await;
        let restarted_app = build_router(restarted_ctx);
        let restarted_response = restarted_app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/v1/sale-readiness")
                    .header(AUTHORIZATION, "Bearer token-1")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = body::to_bytes(restarted_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let restarted_readiness: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert!(restarted_readiness["blockingCodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|code| code == "WHOLE_MACHINE_HARDWARE_FAULT"));

        ctx.state
            .record_whole_machine_lock_recovery_evidence(
                &crate::state::store::WholeMachineMaintenanceLockClearEvidence {
                    adapter: "serial".to_string(),
                    online: true,
                    message: "production lower controller self-check passed".to_string(),
                    port_path: Some("/dev/ttyUSB0".to_string()),
                    checked_at: crate::state::store::now_iso(),
                    production_dispense_path_ready: true,
                    production_dispense_path_code: "PRODUCTION_DISPENSE_PATH_READY".to_string(),
                    production_dispense_path_message: "production dispense path ready".to_string(),
                },
            )
            .await
            .expect("production recovery evidence");
        let clear_response = post_json(
            &app,
            "/v1/maintenance/whole-machine-lock/clear",
            "token-1",
            json!({ "operatorNote": "现场按复位键后自检通过，恢复销售" }),
        )
        .await;
        assert_eq!(clear_response.status(), StatusCode::OK);

        let audit = ctx
            .state
            .whole_machine_lock_clear_audit()
            .await
            .expect("read clear audit")
            .expect("clear audit");
        assert_eq!(audit.operator_note, "现场按复位键后自检通过，恢复销售");
        assert!(audit.recovery_evidence.online);
        assert_eq!(audit.previous.code.as_str(), "WHOLE_MACHINE_HARDWARE_FAULT");

        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/v1/sale-readiness")
                    .header(AUTHORIZATION, "Bearer token-1")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let readiness: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert!(!readiness["blockingCodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|code| code == "WHOLE_MACHINE_HARDWARE_FAULT"));
    }

    #[tokio::test]
    async fn whole_machine_lock_clear_requires_healthy_lower_controller() {
        let temp_dir = tempdir().expect("tmp");
        let ctx = test_ipc_context(
            temp_dir.path(),
            "token-1",
            Some("MACHINE-1".to_string()),
            "http://127.0.0.1:0",
        )
        .await;
        let mut public = ctx
            .config_store
            .load_public_config()
            .await
            .expect("public config");
        public.hardware_adapter = crate::config::HardwareAdapterKind::Serial;
        public.serial_port_path = Some("__vem_missing_lower_controller__".to_string());
        public.lower_controller_usb_identity = None;
        ctx.config_store
            .save_public_config(public)
            .await
            .expect("save serial config");

        ctx.state
            .put_metadata(
                crate::state::store::WHOLE_MACHINE_MAINTENANCE_LOCK_KEY,
                &crate::state::store::WholeMachineMaintenanceLock {
                    code: "WHOLE_MACHINE_HARDWARE_FAULT".to_string(),
                    message: "lower controller reported mechanical fault during dispense"
                        .to_string(),
                    source: "dispense_failure".to_string(),
                    order_no: "ORD-LOCKED".to_string(),
                    command_no: "CMD-LOCKED".to_string(),
                    slot_code: "A1".to_string(),
                    error_code: Some("JAMMED".to_string()),
                    created_at: crate::state::store::now_iso(),
                },
            )
            .await
            .expect("lock");

        let app = build_router(ctx.clone());
        let clear_response = post_json(
            &app,
            "/v1/maintenance/whole-machine-lock/clear",
            "token-1",
            json!({ "operatorNote": "attempted clear before lower controller recovered" }),
        )
        .await;
        assert_eq!(clear_response.status(), StatusCode::CONFLICT);

        let lock = ctx
            .state
            .whole_machine_maintenance_lock()
            .await
            .expect("read lock");
        assert!(lock.is_some());
    }

    #[tokio::test]
    async fn whole_machine_lock_clear_rejects_stale_self_check_evidence() {
        let temp_dir = tempdir().expect("tmp");
        let ctx = test_ipc_context(
            temp_dir.path(),
            "token-1",
            Some("MACHINE-1".to_string()),
            "http://127.0.0.1:0",
        )
        .await;
        ctx.state
            .record_whole_machine_lock_recovery_evidence(
                &crate::state::store::WholeMachineMaintenanceLockClearEvidence {
                    adapter: "mock".to_string(),
                    online: true,
                    message: "hardware ready before fault".to_string(),
                    port_path: None,
                    checked_at: "2026-06-26T07:00:00.000Z".to_string(),
                    production_dispense_path_ready: false,
                    production_dispense_path_code: "PRODUCTION_DISPENSE_PATH_MOCK".to_string(),
                    production_dispense_path_message: "生产出货路径不能使用 mock hardwareAdapter"
                        .to_string(),
                },
            )
            .await
            .expect("evidence");
        ctx.state
            .put_metadata(
                crate::state::store::WHOLE_MACHINE_MAINTENANCE_LOCK_KEY,
                &crate::state::store::WholeMachineMaintenanceLock {
                    code: "WHOLE_MACHINE_HARDWARE_FAULT".to_string(),
                    message: "lower controller reported mechanical fault during dispense"
                        .to_string(),
                    source: "dispense_failure".to_string(),
                    order_no: "ORD-LOCKED".to_string(),
                    command_no: "CMD-LOCKED".to_string(),
                    slot_code: "A1".to_string(),
                    error_code: Some("JAMMED".to_string()),
                    created_at: "2026-06-26T08:00:00.000Z".to_string(),
                },
            )
            .await
            .expect("lock");

        let app = build_router(ctx.clone());
        let clear_response = post_json(
            &app,
            "/v1/maintenance/whole-machine-lock/clear",
            "token-1",
            json!({ "operatorNote": "stale evidence should not clear" }),
        )
        .await;
        assert_eq!(clear_response.status(), StatusCode::CONFLICT);

        let lock = ctx
            .state
            .whole_machine_maintenance_lock()
            .await
            .expect("read lock");
        assert!(lock.is_some());
    }

    #[tokio::test]
    async fn whole_machine_lock_clear_rejects_mock_and_tcp_recovery_evidence() {
        for (adapter, port_path, code, message) in [
            (
                "mock",
                None,
                "PRODUCTION_DISPENSE_PATH_MOCK",
                "生产出货路径不能使用 mock hardwareAdapter",
            ),
            (
                "serial",
                Some("tcp://127.0.0.1:17991"),
                "PRODUCTION_DISPENSE_PATH_TCP_SIMULATOR",
                "生产出货路径不能使用 tcp:// lower-controller simulator",
            ),
        ] {
            let temp_dir = tempdir().expect("tmp");
            let ctx = test_ipc_context(
                temp_dir.path(),
                "token-1",
                Some("MACHINE-1".to_string()),
                "http://127.0.0.1:0",
            )
            .await;
            ctx.state
                .put_metadata(
                    crate::state::store::WHOLE_MACHINE_MAINTENANCE_LOCK_KEY,
                    &crate::state::store::WholeMachineMaintenanceLock {
                        code: "WHOLE_MACHINE_HARDWARE_FAULT".to_string(),
                        message: "lower controller reported mechanical fault during dispense"
                            .to_string(),
                        source: "dispense_failure".to_string(),
                        order_no: "ORD-LOCKED".to_string(),
                        command_no: "CMD-LOCKED".to_string(),
                        slot_code: "A1".to_string(),
                        error_code: Some("JAMMED".to_string()),
                        created_at: "2026-06-26T08:00:00.000Z".to_string(),
                    },
                )
                .await
                .expect("lock");
            ctx.state
                .record_whole_machine_lock_recovery_evidence(
                    &crate::state::store::WholeMachineMaintenanceLockClearEvidence {
                        adapter: adapter.to_string(),
                        online: true,
                        message: "simulated lower controller self-check passed".to_string(),
                        port_path: port_path.map(ToString::to_string),
                        checked_at: "2026-06-26T08:01:00.000Z".to_string(),
                        production_dispense_path_ready: false,
                        production_dispense_path_code: code.to_string(),
                        production_dispense_path_message: message.to_string(),
                    },
                )
                .await
                .expect("evidence");

            let app = build_router(ctx.clone());
            let clear_response = post_json(
                &app,
                "/v1/maintenance/whole-machine-lock/clear",
                "token-1",
                json!({ "operatorNote": "simulator evidence must not clear" }),
            )
            .await;
            assert_eq!(clear_response.status(), StatusCode::CONFLICT);
            assert!(ctx
                .state
                .whole_machine_maintenance_lock()
                .await
                .expect("lock")
                .is_some());
            assert!(ctx
                .state
                .whole_machine_lock_clear_audits()
                .await
                .expect("audits")
                .is_empty());
        }
    }

    #[tokio::test]
    async fn whole_machine_lock_clear_audit_appends_without_overwriting_history() {
        let temp_dir = tempdir().expect("tmp");
        let ctx = test_ipc_context(
            temp_dir.path(),
            "token-1",
            Some("MACHINE-1".to_string()),
            "http://127.0.0.1:0",
        )
        .await;
        let app = build_router(ctx.clone());

        for (index, note) in [
            "第一次现场复位并确认生产路径",
            "第二次现场复位并确认生产路径",
        ]
        .iter()
        .enumerate()
        {
            ctx.state
                .put_metadata(
                    crate::state::store::WHOLE_MACHINE_MAINTENANCE_LOCK_KEY,
                    &crate::state::store::WholeMachineMaintenanceLock {
                        code: "WHOLE_MACHINE_HARDWARE_FAULT".to_string(),
                        message: format!("whole-machine hardware fault #{index}"),
                        source: "dispense_failure".to_string(),
                        order_no: format!("ORD-LOCKED-{index}"),
                        command_no: format!("CMD-LOCKED-{index}"),
                        slot_code: "A1".to_string(),
                        error_code: Some("JAMMED".to_string()),
                        created_at: format!("2026-06-26T08:0{index}:00.000Z"),
                    },
                )
                .await
                .expect("lock");
            ctx.state
                .record_whole_machine_lock_recovery_evidence(
                    &crate::state::store::WholeMachineMaintenanceLockClearEvidence {
                        adapter: "serial".to_string(),
                        online: true,
                        message: "production lower controller self-check passed".to_string(),
                        port_path: Some("/dev/ttyUSB0".to_string()),
                        checked_at: format!("2026-06-26T08:0{index}:30.000Z"),
                        production_dispense_path_ready: true,
                        production_dispense_path_code: "PRODUCTION_DISPENSE_PATH_READY".to_string(),
                        production_dispense_path_message: "production dispense path ready"
                            .to_string(),
                    },
                )
                .await
                .expect("evidence");

            let clear_response = post_json(
                &app,
                "/v1/maintenance/whole-machine-lock/clear",
                "token-1",
                json!({ "operatorNote": note }),
            )
            .await;
            assert_eq!(clear_response.status(), StatusCode::OK);
        }

        let audits = ctx
            .state
            .whole_machine_lock_clear_audits()
            .await
            .expect("audits");
        assert_eq!(audits.len(), 2);
        assert!(audits.iter().any(|audit| {
            audit.operator_note == "第一次现场复位并确认生产路径"
                && audit.previous.order_no == "ORD-LOCKED-0"
        }));
        assert!(audits.iter().any(|audit| {
            audit.operator_note == "第二次现场复位并确认生产路径"
                && audit.previous.order_no == "ORD-LOCKED-1"
        }));
    }

    #[tokio::test]
    async fn heartbeat_reports_blocked_after_lock_clear_when_production_path_is_blocked() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(wiremock::matchers::path("/machine-orders/payment-options"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "options": [{
                    "optionKey": "qr_code:alipay",
                    "providerCode": "alipay",
                    "method": "qr_code",
                    "displayName": "支付宝",
                    "description": "请使用支付宝扫码支付",
                    "icon": "alipay",
                    "disabled": false,
                    "disabledReason": null,
                    "recommended": true
                }],
                "defaultOptionKey": "qr_code:alipay",
                "defaultProviderCode": "alipay",
                "serverTime": "2026-06-26T08:00:00.000Z"
            })))
            .mount(&server)
            .await;

        let temp_dir = tempdir().expect("tmp");
        let ctx = test_ipc_context(
            temp_dir.path(),
            "token-1",
            Some("MACHINE-1".to_string()),
            &server.uri(),
        )
        .await;
        mark_runtime_sale_ready(&ctx).await;
        let app = build_router(ctx.clone());
        let slot_id = "550e8400-e29b-41d4-a716-446655441101";
        let inventory_id = "550e8400-e29b-41d4-a716-446655441102";
        assert_eq!(
            post_json(
                &app,
                "/v1/stock/planogram",
                "token-1",
                one_slot_planogram("PLAN-HEARTBEAT-BLOCKED", slot_id, inventory_id),
            )
            .await
            .status(),
            StatusCode::OK
        );
        assert_eq!(
            post_json(
                &app,
                "/v1/stock/movements",
                "token-1",
                json!({
                    "movementId": "MOVE-HEARTBEAT-BLOCKED",
                    "planogramVersion": "PLAN-HEARTBEAT-BLOCKED",
                    "slotId": slot_id,
                    "movementType": "planned_refill",
                    "quantity": 2,
                    "source": "field_service",
                    "attributedTo": "operator-1"
                }),
            )
            .await
            .status(),
            StatusCode::CREATED
        );

        ctx.state
            .put_metadata(
                crate::state::store::WHOLE_MACHINE_MAINTENANCE_LOCK_KEY,
                &crate::state::store::WholeMachineMaintenanceLock {
                    code: "WHOLE_MACHINE_HARDWARE_FAULT".to_string(),
                    message: "pickup platform blocked".to_string(),
                    source: "dispense_failure".to_string(),
                    order_no: "ORD-HEARTBEAT-BLOCKED".to_string(),
                    command_no: "CMD-HEARTBEAT-BLOCKED".to_string(),
                    slot_code: "A1".to_string(),
                    error_code: Some("JAMMED".to_string()),
                    created_at: "2026-06-26T08:00:00.000Z".to_string(),
                },
            )
            .await
            .expect("lock");
        ctx.state
            .record_whole_machine_lock_recovery_evidence(
                &crate::state::store::WholeMachineMaintenanceLockClearEvidence {
                    adapter: "serial".to_string(),
                    online: true,
                    message: "production lower controller self-check passed".to_string(),
                    port_path: Some("/dev/ttyUSB0".to_string()),
                    checked_at: "2026-06-26T08:01:00.000Z".to_string(),
                    production_dispense_path_ready: true,
                    production_dispense_path_code: "PRODUCTION_DISPENSE_PATH_READY".to_string(),
                    production_dispense_path_message: "production dispense path ready".to_string(),
                },
            )
            .await
            .expect("evidence");
        let clear_response = post_json(
            &app,
            "/v1/maintenance/whole-machine-lock/clear",
            "token-1",
            json!({ "operatorNote": "cleared after production path check" }),
        )
        .await;
        assert_eq!(clear_response.status(), StatusCode::OK);

        let mut public = ctx.config_store.load_public_config().await.expect("config");
        public.hardware_adapter = crate::config::HardwareAdapterKind::Mock;
        public.serial_port_path = None;
        ctx.config_store
            .save_public_config(public.clone())
            .await
            .expect("save mock config");
        let hardware = crate::hardware::HardwareSupervisor::from_config(&public).expect("hardware");
        let (event_tx, _rx) = tokio::sync::broadcast::channel(4);
        let runtime = crate::mqtt::MqttSyncRuntime::new(
            "MACHINE-1".to_string(),
            "secret".to_string(),
            ctx.state.clone(),
            hardware,
            event_tx,
            CancellationToken::new(),
        )
        .with_readiness_context(ctx.clone());

        runtime.enqueue_heartbeat().await.expect("heartbeat");

        let due = ctx
            .state
            .list_due_outbox(chrono::Utc::now() + chrono::Duration::seconds(1))
            .await
            .expect("outbox");
        let heartbeat = due
            .iter()
            .rev()
            .find(|event| event.topic.as_deref() == Some("vem/machines/MACHINE-1/events/heartbeat"))
            .expect("heartbeat");
        let envelope: vending_core::mqtt::MqttEnvelope =
            serde_json::from_value(heartbeat.payload_json.clone()).expect("envelope");
        let sale_readiness = &envelope.payload["statusPayload"]["saleReadiness"];
        assert_eq!(sale_readiness["state"], "blocked");
        assert!(sale_readiness["blockingCodes"]
            .as_array()
            .unwrap()
            .contains(&json!("PRODUCTION_DISPENSE_PATH_MOCK")));
    }

    #[tokio::test]
    async fn slot_sales_state_update_freezes_only_the_target_slot() {
        let temp_dir = tempdir().expect("tmp");
        let app = build_router(
            test_ipc_context(
                temp_dir.path(),
                "token-1",
                Some("MACHINE-1".to_string()),
                "http://127.0.0.1:0",
            )
            .await,
        );

        let planogram = json!({
            "planogramVersion": "PLAN-SLOT-STATE",
            "source": "local_seed",
            "appliedBy": "operator-1",
            "slots": [
                {
                    "slotId": "550e8400-e29b-41d4-a716-446655440051",
                    "slotCode": "E1",
                    "layerNo": 1,
                    "cellNo": 1,
                    "capacity": 8,
                    "parLevel": 6,
                    "inventoryId": "550e8400-e29b-41d4-a716-446655440052",
                    "variantId": "550e8400-e29b-41d4-a716-446655440053",
                    "productId": "550e8400-e29b-41d4-a716-446655440054",
                    "productName": "可乐",
                    "productDescription": null,
                    "coverImageUrl": null,
                    "categoryId": null,
                    "categoryName": null,
                    "sku": "COKE-001",
                    "size": null,
                    "color": null,
                    "priceCents": 500,
                    "productSortOrder": 1,
                    "targetGender": null
                },
                {
                    "slotId": "550e8400-e29b-41d4-a716-446655440061",
                    "slotCode": "E2",
                    "layerNo": 1,
                    "cellNo": 2,
                    "capacity": 8,
                    "parLevel": 6,
                    "inventoryId": "550e8400-e29b-41d4-a716-446655440062",
                    "variantId": "550e8400-e29b-41d4-a716-446655440063",
                    "productId": "550e8400-e29b-41d4-a716-446655440064",
                    "productName": "雪碧",
                    "productDescription": null,
                    "coverImageUrl": null,
                    "categoryId": null,
                    "categoryName": null,
                    "sku": "SPRITE-001",
                    "size": null,
                    "color": null,
                    "priceCents": 500,
                    "productSortOrder": 2,
                    "targetGender": null
                }
            ]
        });
        assert_eq!(
            app.clone()
                .oneshot(
                    Request::builder()
                        .method(Method::POST)
                        .uri("/v1/stock/planogram")
                        .header(AUTHORIZATION, "Bearer token-1")
                        .header(CONTENT_TYPE, "application/json")
                        .body(axum::body::Body::from(planogram.to_string()))
                        .unwrap(),
                )
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        for (movement_id, slot_id) in [
            ("MOVE-FROZEN-1", "550e8400-e29b-41d4-a716-446655440051"),
            ("MOVE-FROZEN-2", "550e8400-e29b-41d4-a716-446655440061"),
        ] {
            assert_eq!(
                app.clone()
                    .oneshot(
                        Request::builder()
                            .method(Method::POST)
                            .uri("/v1/stock/movements")
                            .header(AUTHORIZATION, "Bearer token-1")
                            .header(CONTENT_TYPE, "application/json")
                            .body(axum::body::Body::from(
                                json!({
                                    "movementId": movement_id,
                                    "planogramVersion": "PLAN-SLOT-STATE",
                                    "slotId": slot_id,
                                    "movementType": "planned_refill",
                                    "quantity": 2,
                                    "source": "field_service",
                                    "attributedTo": "operator-1"
                                })
                                .to_string(),
                            ))
                            .unwrap(),
                    )
                    .await
                    .unwrap()
                    .status(),
                StatusCode::CREATED
            );
        }

        let freeze = Request::builder()
            .method(Method::POST)
            .uri("/v1/stock/slot-sales-state")
            .header(AUTHORIZATION, "Bearer token-1")
            .header(CONTENT_TYPE, "application/json")
            .body(axum::body::Body::from(
                json!({
                    "planogramVersion": "PLAN-SLOT-STATE",
                    "slotId": "550e8400-e29b-41d4-a716-446655440051",
                    "slotSalesState": "frozen",
                    "source": "operator_hold"
                })
                .to_string(),
            ))
            .unwrap();
        let response = app.clone().oneshot(freeze).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(payload["items"][0]["slotSalesState"], "frozen");
        assert_eq!(payload["items"][0]["saleableStock"], 2);
        assert_eq!(payload["items"][1]["slotSalesState"], "sale_ready");
        assert_eq!(payload["items"][1]["saleableStock"], 2);

        let recount = Request::builder()
            .method(Method::POST)
            .uri("/v1/stock/movements")
            .header(AUTHORIZATION, "Bearer token-1")
            .header(CONTENT_TYPE, "application/json")
            .body(axum::body::Body::from(
                json!({
                    "movementId": "MOVE-FROZEN-RECOUNT",
                    "planogramVersion": "PLAN-SLOT-STATE",
                    "slotId": "550e8400-e29b-41d4-a716-446655440051",
                    "movementType": "stock_count_correction",
                    "quantity": 4,
                    "source": "field_service",
                    "attributedTo": "operator-1"
                })
                .to_string(),
            ))
            .unwrap();
        let response = app.clone().oneshot(recount).await.unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
        let body = body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(payload["items"][0]["slotSalesState"], "frozen");
        assert_eq!(payload["items"][0]["physicalStock"], 4);
        assert_eq!(payload["items"][0]["saleableStock"], 4);
    }

    #[tokio::test]
    async fn sale_view_and_readiness_report_stock_ledger_loss_blocker() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(wiremock::matchers::path("/machine-orders/payment-options"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "options": [{
                    "optionKey": "mock:mock",
                    "providerCode": "mock",
                    "method": "mock",
                    "displayName": "模拟支付",
                    "description": "本地模拟",
                    "icon": "mock",
                    "recommended": true,
                    "disabled": false,
                    "disabledReason": null
                }],
                "defaultOptionKey": "mock:mock",
                "defaultProviderCode": "mock",
                "serverTime": "2026-06-04T00:00:00Z"
            })))
            .mount(&server)
            .await;

        let temp_dir = tempdir().expect("tmp");
        let ctx = test_ipc_context(
            temp_dir.path(),
            "token-1",
            Some("MACHINE-1".to_string()),
            &server.uri(),
        )
        .await;
        mark_runtime_sale_ready(&ctx).await;
        ctx.state
            .put_metadata("stock_ledger_rebuilt_after_quarantine", &true)
            .await
            .expect("ledger loss marker");
        let app = build_router(ctx);
        let slot_id = "550e8400-e29b-41d4-a716-4466554400c1";
        let inventory_id = "550e8400-e29b-41d4-a716-4466554400c2";

        assert_eq!(
            post_json(
                &app,
                "/v1/stock/planogram",
                "token-1",
                one_slot_planogram("PLAN-LEDGER-LOSS", slot_id, inventory_id),
            )
            .await
            .status(),
            StatusCode::OK
        );

        let sale_view = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/v1/sale-view")
                    .header(AUTHORIZATION, "Bearer token-1")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(sale_view.status(), StatusCode::OK);
        let body = body::to_bytes(sale_view.into_body(), usize::MAX)
            .await
            .unwrap();
        let sale_view: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(sale_view["items"][0]["slotSalesState"], "needs_count");
        assert_eq!(sale_view["items"][0]["saleableStock"], 0);

        let readiness = app
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/v1/sale-readiness")
                    .header(AUTHORIZATION, "Bearer token-1")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(readiness.status(), StatusCode::OK);
        let body = body::to_bytes(readiness.into_body(), usize::MAX)
            .await
            .unwrap();
        let readiness: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(readiness["components"]["slotSaleSafety"]["ready"], false);
        assert_eq!(
            readiness["components"]["slotSaleSafety"]["blockedSlots"][0]["slotSalesState"],
            "needs_count"
        );
    }

    #[tokio::test]
    async fn physical_stock_attestation_endpoint_unblocks_production_sale_readiness() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(wiremock::matchers::path("/machine-orders/payment-options"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "options": [{
                    "optionKey": "qr_code:wechat_pay",
                    "providerCode": "wechat_pay",
                    "method": "qr_code",
                    "displayName": "微信支付",
                    "description": "生产二维码支付",
                    "icon": "wechat",
                    "recommended": true,
                    "disabled": false,
                    "disabledReason": null
                }],
                "defaultOptionKey": "qr_code:wechat_pay",
                "defaultProviderCode": "wechat_pay",
                "serverTime": "2026-06-04T00:00:00Z"
            })))
            .mount(&server)
            .await;

        let temp_dir = tempdir().expect("tmp");
        let ctx = test_ipc_context(
            temp_dir.path(),
            "token-1",
            Some("MACHINE-1".to_string()),
            &server.uri(),
        )
        .await;
        mark_runtime_sale_ready(&ctx).await;
        let app = build_router(ctx);
        let slot_id = "550e8400-e29b-41d4-a716-4466554400d1";
        let inventory_id = "550e8400-e29b-41d4-a716-4466554400d2";

        assert_eq!(
            post_json(
                &app,
                "/v1/stock/planogram",
                "token-1",
                one_slot_planogram("PLAN-PHYSICAL-ATTEST", slot_id, inventory_id),
            )
            .await
            .status(),
            StatusCode::OK
        );

        let readiness = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/v1/sale-readiness")
                    .header(AUTHORIZATION, "Bearer token-1")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(readiness.status(), StatusCode::OK);
        let body = body::to_bytes(readiness.into_body(), usize::MAX)
            .await
            .unwrap();
        let readiness: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            readiness["components"]["physicalStockAttestation"]["status"],
            "missing"
        );
        assert!(readiness["blockingCodes"]
            .as_array()
            .unwrap()
            .contains(&json!("PHYSICAL_STOCK_ATTESTATION_MISSING")));

        let attestation = post_json(
            &app,
            "/v1/stock/attestation",
            "token-1",
            json!({
                "attestationId": "ATT-PROD-001",
                "planogramVersion": "PLAN-PHYSICAL-ATTEST",
                "operatorId": "operator-1",
                "slots": [{
                    "slotId": slot_id,
                    "slotCode": "A1",
                    "sku": "WATER-001",
                    "quantity": 5,
                    "enabled": true
                }]
            }),
        )
        .await;
        assert_eq!(attestation.status(), StatusCode::CREATED);

        let readiness = app
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/v1/sale-readiness")
                    .header(AUTHORIZATION, "Bearer token-1")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(readiness.status(), StatusCode::OK);
        let body = body::to_bytes(readiness.into_body(), usize::MAX)
            .await
            .unwrap();
        let readiness: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            readiness["components"]["physicalStockAttestation"]["status"],
            "ready"
        );
        assert!(!readiness["blockingCodes"]
            .as_array()
            .unwrap()
            .contains(&json!("PHYSICAL_STOCK_ATTESTATION_MISSING")));
        assert_eq!(readiness["canStartNetworkAuthorizedSale"], true);
    }

    #[tokio::test]
    async fn planned_refill_recovers_local_stock_facts_after_ledger_loss() {
        let temp_dir = tempdir().expect("tmp");
        let ctx = test_ipc_context(
            temp_dir.path(),
            "token-1",
            Some("MACHINE-1".to_string()),
            "http://127.0.0.1:0",
        )
        .await;
        let state = ctx.state.clone();
        state
            .put_metadata("stock_ledger_rebuilt_after_quarantine", &true)
            .await
            .expect("ledger loss marker");
        let app = build_router(ctx);

        let slot_id = "550e8400-e29b-41d4-a716-4466554400e1";
        let inventory_id = "550e8400-e29b-41d4-a716-4466554400e2";
        assert_eq!(
            post_json(
                &app,
                "/v1/stock/planogram",
                "token-1",
                one_slot_planogram("PLAN-LEDGER-REFILL", slot_id, inventory_id),
            )
            .await
            .status(),
            StatusCode::OK
        );

        assert_eq!(
            post_json(
                &app,
                "/v1/stock/movements",
                "token-1",
                json!({
                    "movementId": "MOVE-LEDGER-REFILL",
                    "planogramVersion": "PLAN-LEDGER-REFILL",
                    "slotId": slot_id,
                    "movementType": "planned_refill",
                    "quantity": 5,
                    "source": "field_service",
                    "attributedTo": "operator-1"
                }),
            )
            .await
            .status(),
            StatusCode::CREATED
        );

        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/v1/sale-view")
                    .header(AUTHORIZATION, "Bearer token-1")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(payload["items"][0]["physicalStock"], 5);
        assert_eq!(payload["items"][0]["saleableStock"], 5);
        assert_eq!(payload["items"][0]["slotSalesState"], "sale_ready");

        let movement_count: (i64,) =
            sqlx::query_as("SELECT COUNT(1) FROM stock_movements WHERE movement_id = ?1")
                .bind("MOVE-LEDGER-REFILL")
                .fetch_one(state.pool())
                .await
                .expect("movement count");
        assert_eq!(movement_count.0, 1);
        let sync = state
            .stock_movement_sync_record("MOVE-LEDGER-REFILL")
            .await
            .expect("sync")
            .expect("sync exists");
        assert_eq!(sync.status, "pending");
        assert!(state
            .outbox_record("stock-movement:MOVE-LEDGER-REFILL")
            .await
            .expect("outbox")
            .is_some());
    }

    #[tokio::test]
    async fn readyz_and_healthz_report_outbox_capacity_pressure() {
        let temp_dir = tempdir().expect("tmp");
        let ctx = test_ipc_context(
            temp_dir.path(),
            "token-1",
            Some("MACHINE-1".to_string()),
            "http://127.0.0.1:0",
        )
        .await;
        mark_runtime_sale_ready(&ctx).await;
        for index in 0..500 {
            let event = OutboxInput::stock_movement_upload(
                &format!("MOVE-READYZ-CAPACITY-{index}"),
                "https://platform.example/api/machine-stock-movements".to_string(),
                json!({"movementId": format!("MOVE-READYZ-CAPACITY-{index}")}),
            );
            ctx.state
                .enqueue_outbox(&event)
                .await
                .expect("seed stock movement upload");
        }
        let app = build_router(ctx);

        let ready = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/readyz")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(ready.status(), StatusCode::OK);
        let body = body::to_bytes(ready.into_body(), usize::MAX).await.unwrap();
        let ready: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(ready["ready"], false);
        assert_eq!(ready["canSell"], false);
        assert_eq!(ready["mode"], "maintenance");
        assert!(ready["blockingCodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|code| code == "SYNC_OUTBOX_CAPACITY"));

        let health = app
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/healthz")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(health.status(), StatusCode::OK);
        let body = body::to_bytes(health.into_body(), usize::MAX)
            .await
            .unwrap();
        let health: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(health["status"], "degraded");
        assert_eq!(health["outboxSize"], 500);
        assert_eq!(health["outboxMax"], 500);
        assert!(health["components"]
            .as_array()
            .unwrap()
            .iter()
            .any(|component| component["code"] == "SYNC_OUTBOX_CAPACITY"));
    }

    #[tokio::test]
    async fn sale_readiness_reports_outbox_capacity_pressure_without_losing_stock_facts() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(wiremock::matchers::path("/machine-orders/payment-options"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "options": [{
                    "optionKey": "mock:mock",
                    "providerCode": "mock",
                    "method": "mock",
                    "displayName": "模拟支付",
                    "description": "本地模拟",
                    "icon": "mock",
                    "recommended": true,
                    "disabled": false,
                    "disabledReason": null
                }],
                "defaultOptionKey": "mock:mock",
                "defaultProviderCode": "mock",
                "serverTime": "2026-06-04T00:00:00Z"
            })))
            .mount(&server)
            .await;

        let temp_dir = tempdir().expect("tmp");
        let ctx = test_ipc_context(
            temp_dir.path(),
            "token-1",
            Some("MACHINE-1".to_string()),
            &server.uri(),
        )
        .await;
        mark_runtime_sale_ready(&ctx).await;
        let app = build_router(ctx.clone());
        let slot_id = "550e8400-e29b-41d4-a716-4466554400d1";
        let inventory_id = "550e8400-e29b-41d4-a716-4466554400d2";

        assert_eq!(
            post_json(
                &app,
                "/v1/stock/planogram",
                "token-1",
                one_slot_planogram("PLAN-OUTBOX-CAPACITY", slot_id, inventory_id),
            )
            .await
            .status(),
            StatusCode::OK
        );
        assert_eq!(
            post_json(
                &app,
                "/v1/stock/movements",
                "token-1",
                json!({
                    "movementId": "MOVE-CAPACITY-FACT",
                    "planogramVersion": "PLAN-OUTBOX-CAPACITY",
                    "slotId": slot_id,
                    "movementType": "planned_refill",
                    "quantity": 2,
                    "source": "field_service",
                    "attributedTo": "operator-1"
                }),
            )
            .await
            .status(),
            StatusCode::CREATED
        );

        for index in 1..500 {
            let event = OutboxInput::stock_movement_upload(
                &format!("MOVE-CAPACITY-PRESSURE-{index}"),
                format!("{}/machine-stock-movements", server.uri()),
                json!({"movementId": format!("MOVE-CAPACITY-PRESSURE-{index}")}),
            );
            ctx.state
                .enqueue_outbox(&event)
                .await
                .expect("seed stock movement upload");
        }

        let readiness = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/v1/sale-readiness")
                    .header(AUTHORIZATION, "Bearer token-1")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(readiness.status(), StatusCode::OK);
        let body = body::to_bytes(readiness.into_body(), usize::MAX)
            .await
            .unwrap();
        let readiness: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(readiness["components"]["syncHealth"]["ready"], false);
        assert!(readiness["blockingCodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|code| code == "SYNC_UNHEALTHY"));
        assert_eq!(readiness["canStartNetworkAuthorizedSale"], false);

        assert_eq!(ctx.state.outbox_size().await.expect("size"), 500);
        assert!(ctx
            .state
            .outbox_record("stock-movement:MOVE-CAPACITY-FACT")
            .await
            .expect("outbox")
            .is_some());
        let sync = ctx
            .state
            .stock_movement_sync_record("MOVE-CAPACITY-FACT")
            .await
            .expect("sync")
            .expect("sync exists");
        assert_eq!(sync.status, "pending");
    }

    #[tokio::test]
    async fn disk_pressure_blocks_readiness_without_losing_stock_facts() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(wiremock::matchers::path("/machine-orders/payment-options"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "options": [{
                    "optionKey": "mock:mock",
                    "providerCode": "mock",
                    "method": "mock",
                    "displayName": "模拟支付",
                    "description": "本地模拟",
                    "icon": "mock",
                    "recommended": true,
                    "disabled": false,
                    "disabledReason": null
                }],
                "defaultOptionKey": "mock:mock",
                "defaultProviderCode": "mock",
                "serverTime": "2026-06-04T00:00:00Z"
            })))
            .mount(&server)
            .await;

        let temp_dir = tempdir().expect("tmp");
        let mut ctx = test_ipc_context(
            temp_dir.path(),
            "token-1",
            Some("MACHINE-1".to_string()),
            &server.uri(),
        )
        .await;
        mark_runtime_sale_ready(&ctx).await;
        ctx.disk_pressure_probe = Arc::new(FixedDiskPressureProbe {
            available_bytes: 1024,
            threshold_bytes: 128 * 1024 * 1024,
        });
        let app = build_router(ctx.clone());
        let slot_id = "550e8400-e29b-41d4-a716-4466554400f1";
        let inventory_id = "550e8400-e29b-41d4-a716-4466554400f2";

        assert_eq!(
            post_json(
                &app,
                "/v1/stock/planogram",
                "token-1",
                one_slot_planogram("PLAN-DISK-PRESSURE", slot_id, inventory_id),
            )
            .await
            .status(),
            StatusCode::OK
        );
        assert_eq!(
            post_json(
                &app,
                "/v1/stock/movements",
                "token-1",
                json!({
                    "movementId": "MOVE-DISK-PRESSURE-FACT",
                    "planogramVersion": "PLAN-DISK-PRESSURE",
                    "slotId": slot_id,
                    "movementType": "planned_refill",
                    "quantity": 2,
                    "source": "field_service",
                    "attributedTo": "operator-1"
                }),
            )
            .await
            .status(),
            StatusCode::CREATED
        );

        let ready = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/readyz")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(ready.status(), StatusCode::OK);
        let body = body::to_bytes(ready.into_body(), usize::MAX).await.unwrap();
        let ready: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(ready["ready"], false);
        assert_eq!(ready["mode"], "maintenance");
        assert!(ready["blockingCodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|code| code == "DISK_CAPACITY_PRESSURE"));

        let health = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/healthz")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(health.status(), StatusCode::OK);
        let body = body::to_bytes(health.into_body(), usize::MAX)
            .await
            .unwrap();
        let health: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(health["status"], "degraded");
        assert!(health["components"]
            .as_array()
            .unwrap()
            .iter()
            .any(|component| component["code"] == "DISK_CAPACITY_PRESSURE"));

        let readiness = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/v1/sale-readiness")
                    .header(AUTHORIZATION, "Bearer token-1")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(readiness.status(), StatusCode::OK);
        let body = body::to_bytes(readiness.into_body(), usize::MAX)
            .await
            .unwrap();
        let readiness: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(readiness["components"]["syncHealth"]["ready"], false);
        assert!(readiness["components"]["syncHealth"]["message"]
            .as_str()
            .unwrap()
            .contains("disk capacity pressure"));
        assert!(readiness["blockingCodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|code| code == "SYNC_UNHEALTHY"));

        assert!(ctx
            .state
            .outbox_record("stock-movement:MOVE-DISK-PRESSURE-FACT")
            .await
            .expect("outbox")
            .is_some());
        let sync = ctx
            .state
            .stock_movement_sync_record("MOVE-DISK-PRESSURE-FACT")
            .await
            .expect("sync")
            .expect("sync exists");
        assert_eq!(sync.status, "pending");
    }

    #[tokio::test]
    async fn sale_readiness_reports_reconciliation_slot_blockers() {
        let temp_dir = tempdir().expect("tmp");
        let app = build_router(
            test_ipc_context(
                temp_dir.path(),
                "token-1",
                Some("MACHINE-1".to_string()),
                "http://127.0.0.1:0",
            )
            .await,
        );
        let slot_id = "550e8400-e29b-41d4-a716-446655440091";
        let inventory_id = "550e8400-e29b-41d4-a716-446655440092";

        assert_eq!(
            post_json(
                &app,
                "/v1/stock/planogram",
                "token-1",
                one_slot_planogram("PLAN-RECONCILE-READY", slot_id, inventory_id),
            )
            .await
            .status(),
            StatusCode::OK
        );
        assert_eq!(
            post_json(
                &app,
                "/v1/stock/movements",
                "token-1",
                json!({
                    "movementId": "MOVE-RECONCILE-READY",
                    "planogramVersion": "PLAN-RECONCILE-READY",
                    "slotId": slot_id,
                    "movementType": "planned_refill",
                    "quantity": 2,
                    "source": "field_service",
                    "attributedTo": "operator-1"
                }),
            )
            .await
            .status(),
            StatusCode::CREATED
        );
        assert_eq!(
            post_json(
                &app,
                "/v1/stock/slot-sales-state",
                "token-1",
                json!({
                    "planogramVersion": "PLAN-RECONCILE-READY",
                    "slotId": slot_id,
                    "slotSalesState": "needs_platform_review",
                    "source": "platform_reconciliation"
                }),
            )
            .await
            .status(),
            StatusCode::OK
        );

        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/v1/sale-readiness")
                    .header(AUTHORIZATION, "Bearer token-1")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let readiness: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(readiness["components"]["slotSaleSafety"]["ready"], false);
        assert_eq!(
            readiness["components"]["slotSaleSafety"]["blockedSlots"][0]["slotSalesState"],
            "needs_platform_review"
        );
    }

    #[tokio::test]
    async fn reconciliation_sale_safety_blocker_survives_later_stock_movements() {
        let temp_dir = tempdir().expect("tmp");
        let ctx = test_ipc_context(
            temp_dir.path(),
            "token-1",
            Some("MACHINE-1".to_string()),
            "http://127.0.0.1:0",
        )
        .await;
        let state = ctx.state.clone();
        let app = build_router(ctx);
        let slot_id = "550e8400-e29b-41d4-a716-4466554400b1";
        let inventory_id = "550e8400-e29b-41d4-a716-4466554400b2";

        assert_eq!(
            post_json(
                &app,
                "/v1/stock/planogram",
                "token-1",
                one_slot_planogram("PLAN-RECONCILE-BLOCK", slot_id, inventory_id),
            )
            .await
            .status(),
            StatusCode::OK
        );
        assert_eq!(
            post_json(
                &app,
                "/v1/stock/movements",
                "token-1",
                json!({
                    "movementId": "MOVE-RECONCILE-BLOCK-INITIAL",
                    "planogramVersion": "PLAN-RECONCILE-BLOCK",
                    "slotId": slot_id,
                    "movementType": "planned_refill",
                    "quantity": 2,
                    "source": "field_service",
                    "attributedTo": "operator-1"
                }),
            )
            .await
            .status(),
            StatusCode::CREATED
        );

        let events = state
            .list_due_stock_movement_uploads(chrono::Utc::now())
            .await
            .expect("stock movement upload events");
        state
            .record_stock_movement_upload_response(
                &events[0],
                &crate::backend::StockMovementUploadResponse {
                    movement_id: "MOVE-RECONCILE-BLOCK-INITIAL".to_string(),
                    status: "reconciliation".to_string(),
                    accepted_at: None,
                    receipt: None,
                    rejection: Some(json!({
                        "reason": "movement_id_payload_conflict"
                    })),
                    reconciliation: Some(crate::backend::StockMovementReconciliation {
                        reason: "movement_id_payload_conflict".to_string(),
                        platform_review: Some(json!({ "status": "open" })),
                        sale_safety_blocker: Some(crate::backend::StockMovementSaleSafetyBlocker {
                            slot_id: slot_id.to_string(),
                            slot_sales_state: "movement_rejected".to_string(),
                            reason: "movement_id_payload_conflict".to_string(),
                        }),
                    }),
                },
            )
            .await
            .expect("record reconciliation response");

        for movement in [
            json!({
                "movementId": "MOVE-RECONCILE-BLOCK-COUNT",
                "planogramVersion": "PLAN-RECONCILE-BLOCK",
                "slotId": slot_id,
                "movementType": "stock_count_correction",
                "quantity": 4,
                "source": "field_count",
                "attributedTo": "operator-2"
            }),
            json!({
                "movementId": "MOVE-RECONCILE-BLOCK-REFILL",
                "planogramVersion": "PLAN-RECONCILE-BLOCK",
                "slotId": slot_id,
                "movementType": "planned_refill",
                "quantity": 1,
                "source": "field_service",
                "attributedTo": "operator-3"
            }),
        ] {
            assert_eq!(
                post_json(&app, "/v1/stock/movements", "token-1", movement)
                    .await
                    .status(),
                StatusCode::CREATED
            );
        }

        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/v1/sale-view")
                    .header(AUTHORIZATION, "Bearer token-1")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(payload["items"][0]["physicalStock"], 5);
        assert_eq!(payload["items"][0]["saleableStock"], 5);
        assert_eq!(payload["items"][0]["slotSalesState"], "movement_rejected");
    }

    #[tokio::test]
    async fn planogram_activation_preserves_reconciliation_blocker_states() {
        let temp_dir = tempdir().expect("tmp");
        let app = build_router(
            test_ipc_context(
                temp_dir.path(),
                "token-1",
                Some("MACHINE-1".to_string()),
                "http://127.0.0.1:0",
            )
            .await,
        );
        let movement_rejected_slot = "550e8400-e29b-41d4-a716-4466554400c1";
        let platform_review_slot = "550e8400-e29b-41d4-a716-4466554400d1";
        let mut planogram = one_slot_planogram(
            "PLAN-BLOCKER-OLD",
            movement_rejected_slot,
            "550e8400-e29b-41d4-a716-4466554400c2",
        );
        let mut second_slot = planogram["slots"][0].clone();
        second_slot["slotId"] = json!(platform_review_slot);
        second_slot["slotCode"] = json!("A2");
        second_slot["cellNo"] = json!(2);
        second_slot["inventoryId"] = json!("550e8400-e29b-41d4-a716-4466554400d2");
        second_slot["productSortOrder"] = json!(2);
        planogram["slots"].as_array_mut().unwrap().push(second_slot);

        assert_eq!(
            post_json(&app, "/v1/stock/planogram", "token-1", planogram.clone())
                .await
                .status(),
            StatusCode::OK
        );
        for (slot_id, state) in [
            (movement_rejected_slot, "movement_rejected"),
            (platform_review_slot, "needs_platform_review"),
        ] {
            assert_eq!(
                post_json(
                    &app,
                    "/v1/stock/slot-sales-state",
                    "token-1",
                    json!({
                        "planogramVersion": "PLAN-BLOCKER-OLD",
                        "slotId": slot_id,
                        "slotSalesState": state,
                        "source": "platform_reconciliation"
                    }),
                )
                .await
                .status(),
                StatusCode::OK
            );
        }

        planogram["planogramVersion"] = json!("PLAN-BLOCKER-NEW");
        assert_eq!(
            post_json(&app, "/v1/stock/planogram", "token-1", planogram)
                .await
                .status(),
            StatusCode::OK
        );

        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/v1/sale-view")
                    .header(AUTHORIZATION, "Bearer token-1")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(payload["planogramVersion"], "PLAN-BLOCKER-NEW");
        assert_eq!(payload["items"][0]["slotSalesState"], "movement_rejected");
        assert_eq!(
            payload["items"][1]["slotSalesState"],
            "needs_platform_review"
        );
    }

    #[tokio::test]
    async fn sale_view_preserves_stock_when_identical_planogram_version_is_replayed() {
        let temp_dir = tempdir().expect("tmp");
        let app = build_router(
            test_ipc_context(
                temp_dir.path(),
                "token-1",
                Some("MACHINE-1".to_string()),
                "http://127.0.0.1:0",
            )
            .await,
        );

        let planogram = json!({
            "planogramVersion": "PLAN-IDEMPOTENT",
            "source": "local_seed",
            "appliedBy": "operator-1",
            "slots": [{
                "slotId": "550e8400-e29b-41d4-a716-446655440021",
                "slotCode": "C1",
                "layerNo": 1,
                "cellNo": 3,
                "capacity": 8,
                "parLevel": 6,
                "inventoryId": "550e8400-e29b-41d4-a716-446655440022",
                "variantId": "550e8400-e29b-41d4-a716-446655440023",
                "productId": "550e8400-e29b-41d4-a716-446655440024",
                "productName": "无糖茶",
                "productDescription": null,
                "coverImageUrl": null,
                "categoryId": null,
                "categoryName": null,
                "sku": "TEA-001",
                "size": null,
                "color": null,
                "priceCents": 500,
                "productSortOrder": 1,
                "targetGender": null
            }]
        });

        let request = Request::builder()
            .method(Method::POST)
            .uri("/v1/stock/planogram")
            .header(AUTHORIZATION, "Bearer token-1")
            .header(CONTENT_TYPE, "application/json")
            .body(axum::body::Body::from(planogram.to_string()))
            .unwrap();
        assert_eq!(
            app.clone().oneshot(request).await.unwrap().status(),
            StatusCode::OK
        );

        let refill = Request::builder()
            .method(Method::POST)
            .uri("/v1/stock/movements")
            .header(AUTHORIZATION, "Bearer token-1")
            .header(CONTENT_TYPE, "application/json")
            .body(axum::body::Body::from(
                json!({
                    "movementId": "MOVE-IDEMPOTENT-REFILL",
                    "planogramVersion": "PLAN-IDEMPOTENT",
                    "slotId": "550e8400-e29b-41d4-a716-446655440021",
                    "movementType": "planned_refill",
                    "quantity": 4,
                    "source": "field_service",
                    "attributedTo": "operator-1"
                })
                .to_string(),
            ))
            .unwrap();
        assert_eq!(
            app.clone().oneshot(refill).await.unwrap().status(),
            StatusCode::CREATED
        );

        let replay = Request::builder()
            .method(Method::POST)
            .uri("/v1/stock/planogram")
            .header(AUTHORIZATION, "Bearer token-1")
            .header(CONTENT_TYPE, "application/json")
            .body(axum::body::Body::from(planogram.to_string()))
            .unwrap();
        assert_eq!(
            app.clone().oneshot(replay).await.unwrap().status(),
            StatusCode::OK
        );

        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/v1/sale-view")
                    .header(AUTHORIZATION, "Bearer token-1")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(payload["items"][0]["physicalStock"], 4);
        assert_eq!(payload["items"][0]["saleableStock"], 4);
        assert_eq!(payload["items"][0]["slotSalesState"], "sale_ready");
    }

    #[tokio::test]
    async fn conflicting_planogram_replay_rejects_and_keeps_sale_view_unchanged() {
        let temp_dir = tempdir().expect("tmp");
        let app = build_router(
            test_ipc_context(
                temp_dir.path(),
                "token-1",
                Some("MACHINE-1".to_string()),
                "http://127.0.0.1:0",
            )
            .await,
        );

        let base_planogram = json!({
            "planogramVersion": "PLAN-IMMUTABLE",
            "source": "local_seed",
            "appliedBy": "operator-1",
            "slots": [
                {
                    "slotId": "550e8400-e29b-41d4-a716-446655440031",
                    "slotCode": "D1",
                    "layerNo": 1,
                    "cellNo": 1,
                    "capacity": 8,
                    "parLevel": 6,
                    "inventoryId": "550e8400-e29b-41d4-a716-446655440032",
                    "variantId": "550e8400-e29b-41d4-a716-446655440033",
                    "productId": "550e8400-e29b-41d4-a716-446655440034",
                    "productName": "橙汁",
                    "productDescription": null,
                    "coverImageUrl": null,
                    "categoryId": null,
                    "categoryName": null,
                    "sku": "JUICE-001",
                    "size": null,
                    "color": null,
                    "priceCents": 600,
                    "productSortOrder": 1,
                    "targetGender": null
                },
                {
                    "slotId": "550e8400-e29b-41d4-a716-446655440041",
                    "slotCode": "D2",
                    "layerNo": 1,
                    "cellNo": 2,
                    "capacity": 5,
                    "parLevel": 4,
                    "inventoryId": "550e8400-e29b-41d4-a716-446655440042",
                    "variantId": "550e8400-e29b-41d4-a716-446655440043",
                    "productId": "550e8400-e29b-41d4-a716-446655440044",
                    "productName": "咖啡",
                    "productDescription": null,
                    "coverImageUrl": null,
                    "categoryId": null,
                    "categoryName": null,
                    "sku": "COFFEE-001",
                    "size": null,
                    "color": null,
                    "priceCents": 700,
                    "productSortOrder": 2,
                    "targetGender": null
                }
            ]
        });

        let request = Request::builder()
            .method(Method::POST)
            .uri("/v1/stock/planogram")
            .header(AUTHORIZATION, "Bearer token-1")
            .header(CONTENT_TYPE, "application/json")
            .body(axum::body::Body::from(base_planogram.to_string()))
            .unwrap();
        assert_eq!(
            app.clone().oneshot(request).await.unwrap().status(),
            StatusCode::OK
        );

        let refill = Request::builder()
            .method(Method::POST)
            .uri("/v1/stock/movements")
            .header(AUTHORIZATION, "Bearer token-1")
            .header(CONTENT_TYPE, "application/json")
            .body(axum::body::Body::from(
                json!({
                    "movementId": "MOVE-IMMUTABLE-REFILL",
                    "planogramVersion": "PLAN-IMMUTABLE",
                    "slotId": "550e8400-e29b-41d4-a716-446655440041",
                    "movementType": "planned_refill",
                    "quantity": 3,
                    "source": "field_service",
                    "attributedTo": "operator-1"
                })
                .to_string(),
            ))
            .unwrap();
        assert_eq!(
            app.clone().oneshot(refill).await.unwrap().status(),
            StatusCode::CREATED
        );

        let mut smaller_slot_set = base_planogram.clone();
        smaller_slot_set["slots"].as_array_mut().unwrap().pop();
        let mut capacity_changed = base_planogram.clone();
        capacity_changed["slots"][0]["capacity"] = json!(9);
        let mut par_changed = base_planogram.clone();
        par_changed["slots"][0]["parLevel"] = json!(7);
        let mut mapping_changed = base_planogram.clone();
        mapping_changed["slots"][1]["inventoryId"] = json!("550e8400-e29b-41d4-a716-446655440099");

        for conflict in [
            smaller_slot_set,
            capacity_changed,
            par_changed,
            mapping_changed,
        ] {
            let request = Request::builder()
                .method(Method::POST)
                .uri("/v1/stock/planogram")
                .header(AUTHORIZATION, "Bearer token-1")
                .header(CONTENT_TYPE, "application/json")
                .body(axum::body::Body::from(conflict.to_string()))
                .unwrap();
            assert_eq!(
                app.clone().oneshot(request).await.unwrap().status(),
                StatusCode::BAD_REQUEST
            );
        }

        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/v1/sale-view")
                    .header(AUTHORIZATION, "Bearer token-1")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(payload["items"].as_array().unwrap().len(), 2);
        assert_eq!(payload["items"][0]["productName"], "橙汁");
        assert_eq!(payload["items"][1]["productName"], "咖啡");
        assert_eq!(payload["items"][1]["physicalStock"], 3);
        assert_eq!(payload["items"][1]["saleableStock"], 3);
    }

    #[tokio::test]
    async fn stock_movement_rejects_inactive_planogram_version() {
        let temp_dir = tempdir().expect("tmp");
        let app = build_router(
            test_ipc_context(
                temp_dir.path(),
                "token-1",
                Some("MACHINE-1".to_string()),
                "http://127.0.0.1:0",
            )
            .await,
        );

        for planogram in [
            json!({
                "planogramVersion": "PLAN-INACTIVE-OLD",
                "source": "local_seed",
                "appliedBy": "operator-1",
                "slots": [{
                    "slotId": "550e8400-e29b-41d4-a716-446655440051",
                    "slotCode": "E1",
                    "layerNo": 1,
                    "cellNo": 1,
                    "capacity": 8,
                    "parLevel": 6,
                    "inventoryId": "550e8400-e29b-41d4-a716-446655440052",
                    "variantId": "550e8400-e29b-41d4-a716-446655440053",
                    "productId": "550e8400-e29b-41d4-a716-446655440054",
                    "productName": "旧版本水",
                    "productDescription": null,
                    "coverImageUrl": null,
                    "categoryId": null,
                    "categoryName": null,
                    "sku": "OLD-001",
                    "size": null,
                    "color": null,
                    "priceCents": 200,
                    "productSortOrder": 1,
                    "targetGender": null
                }]
            }),
            json!({
                "planogramVersion": "PLAN-INACTIVE-NEW",
                "source": "local_seed",
                "appliedBy": "operator-1",
                "slots": [{
                    "slotId": "550e8400-e29b-41d4-a716-446655440061",
                    "slotCode": "E2",
                    "layerNo": 1,
                    "cellNo": 2,
                    "capacity": 5,
                    "parLevel": 4,
                    "inventoryId": "550e8400-e29b-41d4-a716-446655440062",
                    "variantId": "550e8400-e29b-41d4-a716-446655440063",
                    "productId": "550e8400-e29b-41d4-a716-446655440064",
                    "productName": "新版本茶",
                    "productDescription": null,
                    "coverImageUrl": null,
                    "categoryId": null,
                    "categoryName": null,
                    "sku": "NEW-001",
                    "size": null,
                    "color": null,
                    "priceCents": 300,
                    "productSortOrder": 1,
                    "targetGender": null
                }]
            }),
        ] {
            let request = Request::builder()
                .method(Method::POST)
                .uri("/v1/stock/planogram")
                .header(AUTHORIZATION, "Bearer token-1")
                .header(CONTENT_TYPE, "application/json")
                .body(axum::body::Body::from(planogram.to_string()))
                .unwrap();
            assert_eq!(
                app.clone().oneshot(request).await.unwrap().status(),
                StatusCode::OK
            );
        }

        let inactive_refill = Request::builder()
            .method(Method::POST)
            .uri("/v1/stock/movements")
            .header(AUTHORIZATION, "Bearer token-1")
            .header(CONTENT_TYPE, "application/json")
            .body(axum::body::Body::from(
                json!({
                    "movementId": "MOVE-INACTIVE-REFILL",
                    "planogramVersion": "PLAN-INACTIVE-OLD",
                    "slotId": "550e8400-e29b-41d4-a716-446655440051",
                    "movementType": "planned_refill",
                    "quantity": 3,
                    "source": "field_service",
                    "attributedTo": "operator-1"
                })
                .to_string(),
            ))
            .unwrap();
        assert_eq!(
            app.clone().oneshot(inactive_refill).await.unwrap().status(),
            StatusCode::BAD_REQUEST
        );

        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/v1/sale-view")
                    .header(AUTHORIZATION, "Bearer token-1")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(payload["planogramVersion"], "PLAN-INACTIVE-NEW");
        assert_eq!(payload["items"].as_array().unwrap().len(), 1);
        assert_eq!(payload["items"][0]["productName"], "新版本茶");
        assert_eq!(payload["items"][0]["physicalStock"], 0);
    }

    #[tokio::test]
    async fn stock_count_correction_appends_fact_and_later_refill_projects_from_correction() {
        let temp_dir = tempdir().expect("tmp");
        let ctx = test_ipc_context(
            temp_dir.path(),
            "token-1",
            Some("MACHINE-1".to_string()),
            "http://127.0.0.1:0",
        )
        .await;
        let state = ctx.state.clone();
        let app = build_router(ctx);

        let planogram = json!({
            "planogramVersion": "PLAN-CORRECTION",
            "source": "local_seed",
            "appliedBy": "operator-1",
            "slots": [{
                "slotId": "550e8400-e29b-41d4-a716-446655440011",
                "slotCode": "B1",
                "layerNo": 1,
                "cellNo": 2,
                "capacity": 5,
                "parLevel": 5,
                "inventoryId": "550e8400-e29b-41d4-a716-446655440012",
                "variantId": "550e8400-e29b-41d4-a716-446655440013",
                "productId": "550e8400-e29b-41d4-a716-446655440014",
                "productName": "苏打水",
                "productDescription": null,
                "coverImageUrl": null,
                "categoryId": null,
                "categoryName": null,
                "sku": "SODA-001",
                "size": null,
                "color": null,
                "priceCents": 300,
                "productSortOrder": 1,
                "targetGender": null
            }]
        });
        let request = Request::builder()
            .method(Method::POST)
            .uri("/v1/stock/planogram")
            .header(AUTHORIZATION, "Bearer token-1")
            .header(CONTENT_TYPE, "application/json")
            .body(axum::body::Body::from(planogram.to_string()))
            .unwrap();
        assert_eq!(
            app.clone().oneshot(request).await.unwrap().status(),
            StatusCode::OK
        );

        for movement in [
            json!({
                "movementId": "MOVE-REFILL",
                "planogramVersion": "PLAN-CORRECTION",
                "slotId": "550e8400-e29b-41d4-a716-446655440011",
                "movementType": "planned_refill",
                "quantity": 4,
                "source": "field_service",
                "attributedTo": "operator-1"
            }),
            json!({
                "movementId": "MOVE-CORRECTION",
                "planogramVersion": "PLAN-CORRECTION",
                "slotId": "550e8400-e29b-41d4-a716-446655440011",
                "movementType": "stock_count_correction",
                "quantity": 0,
                "source": "field_count",
                "attributedTo": "operator-2"
            }),
        ] {
            let request = Request::builder()
                .method(Method::POST)
                .uri("/v1/stock/movements")
                .header(AUTHORIZATION, "Bearer token-1")
                .header(CONTENT_TYPE, "application/json")
                .body(axum::body::Body::from(movement.to_string()))
                .unwrap();
            assert_eq!(
                app.clone().oneshot(request).await.unwrap().status(),
                StatusCode::CREATED
            );
        }

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/v1/sale-view")
                    .header(AUTHORIZATION, "Bearer token-1")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let item = &payload["items"][0];
        assert_eq!(item["physicalStock"], 0);
        assert_eq!(item["saleableStock"], 0);
        assert_eq!(item["slotSalesState"], "sold_out");

        let request = Request::builder()
            .method(Method::POST)
            .uri("/v1/stock/movements")
            .header(AUTHORIZATION, "Bearer token-1")
            .header(CONTENT_TYPE, "application/json")
            .body(axum::body::Body::from(
                json!({
                    "movementId": "MOVE-REFILL-AFTER-CORRECTION",
                    "planogramVersion": "PLAN-CORRECTION",
                    "slotId": "550e8400-e29b-41d4-a716-446655440011",
                    "movementType": "planned_refill",
                    "quantity": 2,
                    "source": "field_service",
                    "attributedTo": "operator-3"
                })
                .to_string(),
            ))
            .unwrap();
        assert_eq!(
            app.clone().oneshot(request).await.unwrap().status(),
            StatusCode::CREATED
        );

        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/v1/sale-view")
                    .header(AUTHORIZATION, "Bearer token-1")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let item = &payload["items"][0];
        assert_eq!(item["physicalStock"], 2);
        assert_eq!(item["saleableStock"], 2);
        assert_eq!(item["slotSalesState"], "sale_ready");

        let movement_count: (i64,) =
            sqlx::query_as("SELECT COUNT(1) FROM stock_movements WHERE slot_id = ?1")
                .bind("550e8400-e29b-41d4-a716-446655440011")
                .fetch_one(state.pool())
                .await
                .expect("movement count");
        assert_eq!(movement_count.0, 3);
    }

    #[tokio::test]
    async fn planned_refill_unblocks_remapped_planogram_slot_through_public_api() {
        let temp_dir = tempdir().expect("tmp");
        let app = build_router(
            test_ipc_context(
                temp_dir.path(),
                "token-1",
                Some("MACHINE-1".to_string()),
                "http://127.0.0.1:0",
            )
            .await,
        );

        let slot_id = "550e8400-e29b-41d4-a716-446655440091";
        let old_inventory_id = "550e8400-e29b-41d4-a716-446655440092";
        let new_inventory_id = "550e8400-e29b-41d4-a716-4466554400a2";
        assert_eq!(
            post_json(
                &app,
                "/v1/stock/planogram",
                "token-1",
                one_slot_planogram("PLAN-REFILL-OLD", slot_id, old_inventory_id),
            )
            .await
            .status(),
            StatusCode::OK
        );
        assert_eq!(
            post_json(
                &app,
                "/v1/stock/movements",
                "token-1",
                json!({
                    "movementId": "MOVE-REFILL-OLD-STOCK",
                    "planogramVersion": "PLAN-REFILL-OLD",
                    "slotId": slot_id,
                    "movementType": "planned_refill",
                    "quantity": 3,
                    "source": "field_service",
                    "attributedTo": "operator-1"
                }),
            )
            .await
            .status(),
            StatusCode::CREATED
        );

        let mut remapped = one_slot_planogram("PLAN-REFILL-NEW", slot_id, new_inventory_id);
        remapped["slots"][0]["variantId"] = json!("550e8400-e29b-41d4-a716-4466554400a3");
        remapped["slots"][0]["productId"] = json!("550e8400-e29b-41d4-a716-4466554400a4");
        remapped["slots"][0]["productName"] = json!("苏打水");
        remapped["slots"][0]["sku"] = json!("SODA-REFILL");
        assert_eq!(
            post_json(&app, "/v1/stock/planogram", "token-1", remapped)
                .await
                .status(),
            StatusCode::OK
        );

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/v1/sale-view")
                    .header(AUTHORIZATION, "Bearer token-1")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            payload["items"][0]["slotSalesState"],
            "blocked_for_planogram_change"
        );
        assert_eq!(payload["items"][0]["saleableStock"], 0);

        assert_eq!(
            post_json(
                &app,
                "/v1/stock/movements",
                "token-1",
                json!({
                    "movementId": "MOVE-REFILL-NEW-TARGET",
                    "planogramVersion": "PLAN-REFILL-NEW",
                    "slotId": slot_id,
                    "movementType": "planned_refill",
                    "quantity": 4,
                    "source": "field_service",
                    "attributedTo": "operator-2"
                }),
            )
            .await
            .status(),
            StatusCode::CREATED
        );

        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/v1/sale-view")
                    .header(AUTHORIZATION, "Bearer token-1")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(payload["items"][0]["physicalStock"], 4);
        assert_eq!(payload["items"][0]["saleableStock"], 4);
        assert_eq!(payload["items"][0]["slotSalesState"], "sale_ready");
    }

    #[tokio::test]
    async fn local_maintenance_refill_clears_platform_review_and_returns_machine_code() {
        let temp_dir = tempdir().expect("tmp");
        let app = build_router(
            test_ipc_context(
                temp_dir.path(),
                "token-1",
                Some("MACHINE-1".to_string()),
                "http://127.0.0.1:0",
            )
            .await,
        );

        let slot_id = "550e8400-e29b-41d4-a716-4466554400b1";
        let inventory_id = "550e8400-e29b-41d4-a716-4466554400b2";
        assert_eq!(
            post_json(
                &app,
                "/v1/stock/planogram",
                "token-1",
                one_slot_planogram("PLAN-LOCAL-MAINTENANCE-REFILL", slot_id, inventory_id),
            )
            .await
            .status(),
            StatusCode::OK
        );
        let blocked_response = post_json(
            &app,
            "/v1/stock/slot-sales-state",
            "token-1",
            json!({
                "planogramVersion": "PLAN-LOCAL-MAINTENANCE-REFILL",
                "slotId": slot_id,
                "slotSalesState": "needs_platform_review",
                "source": "platform_reconciliation"
            }),
        )
        .await;
        assert_eq!(blocked_response.status(), StatusCode::OK);
        let body = body::to_bytes(blocked_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(payload["items"][0]["machineCode"], "MACHINE-1");
        assert_eq!(
            payload["items"][0]["slotSalesState"],
            "needs_platform_review"
        );

        let response = post_json(
            &app,
            "/v1/stock/movements",
            "token-1",
            json!({
                "movementId": "MOVE-LOCAL-MAINTENANCE-REFILL",
                "planogramVersion": "PLAN-LOCAL-MAINTENANCE-REFILL",
                "slotId": slot_id,
                "movementType": "planned_refill",
                "quantity": 6,
                "source": "local_maintenance",
                "attributedTo": "front-panel"
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::CREATED);
        let body = body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(payload["items"][0]["machineCode"], "MACHINE-1");
        assert_eq!(payload["items"][0]["physicalStock"], 6);
        assert_eq!(payload["items"][0]["saleableStock"], 6);
        assert_eq!(payload["items"][0]["slotSalesState"], "sale_ready");
    }

    #[tokio::test]
    async fn planogram_remap_with_remaining_stock_blocks_slot_until_target_count() {
        let temp_dir = tempdir().expect("tmp");
        let app = build_router(
            test_ipc_context(
                temp_dir.path(),
                "token-1",
                Some("MACHINE-1".to_string()),
                "http://127.0.0.1:0",
            )
            .await,
        );

        let slot_id = "550e8400-e29b-41d4-a716-446655440071";
        let old_inventory_id = "550e8400-e29b-41d4-a716-446655440072";
        let new_inventory_id = "550e8400-e29b-41d4-a716-446655440082";
        assert_eq!(
            post_json(
                &app,
                "/v1/stock/planogram",
                "token-1",
                one_slot_planogram("PLAN-REMAP-OLD", slot_id, old_inventory_id),
            )
            .await
            .status(),
            StatusCode::OK
        );
        assert_eq!(
            post_json(
                &app,
                "/v1/stock/movements",
                "token-1",
                json!({
                    "movementId": "MOVE-REMAP-OLD-REFILL",
                    "planogramVersion": "PLAN-REMAP-OLD",
                    "slotId": slot_id,
                    "movementType": "planned_refill",
                    "quantity": 3,
                    "source": "field_service",
                    "attributedTo": "operator-1"
                }),
            )
            .await
            .status(),
            StatusCode::CREATED
        );

        let mut remapped = one_slot_planogram("PLAN-REMAP-NEW", slot_id, new_inventory_id);
        remapped["slots"][0]["variantId"] = json!("550e8400-e29b-41d4-a716-446655440083");
        remapped["slots"][0]["productId"] = json!("550e8400-e29b-41d4-a716-446655440084");
        remapped["slots"][0]["productName"] = json!("苏打水");
        remapped["slots"][0]["sku"] = json!("SODA-REMAP");
        assert_eq!(
            post_json(&app, "/v1/stock/planogram", "token-1", remapped)
                .await
                .status(),
            StatusCode::OK
        );

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/v1/sale-view")
                    .header(AUTHORIZATION, "Bearer token-1")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(payload["planogramVersion"], "PLAN-REMAP-NEW");
        assert_eq!(payload["items"][0]["inventoryId"], new_inventory_id);
        assert_eq!(payload["items"][0]["physicalStock"], 3);
        assert_eq!(payload["items"][0]["saleableStock"], 0);
        assert_eq!(
            payload["items"][0]["slotSalesState"],
            "blocked_for_planogram_change"
        );

        assert_eq!(
            post_json(
                &app,
                "/v1/stock/movements",
                "token-1",
                json!({
                    "movementId": "MOVE-REMAP-COUNT",
                    "planogramVersion": "PLAN-REMAP-NEW",
                    "slotId": slot_id,
                    "movementType": "stock_count_correction",
                    "quantity": 4,
                    "source": "field_count",
                    "attributedTo": "operator-2"
                }),
            )
            .await
            .status(),
            StatusCode::CREATED
        );

        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/v1/sale-view")
                    .header(AUTHORIZATION, "Bearer token-1")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(payload["items"][0]["physicalStock"], 4);
        assert_eq!(payload["items"][0]["saleableStock"], 4);
        assert_eq!(payload["items"][0]["slotSalesState"], "sale_ready");
    }
}
