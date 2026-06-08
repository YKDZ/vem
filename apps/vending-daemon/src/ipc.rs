use std::{net::SocketAddr, path::Path, path::PathBuf, sync::Arc};

use axum::extract::ws::{Message, WebSocket};
use axum::{
    extract::{Path as AxumPath, State, WebSocketUpgrade},
    http::{
        header::{AUTHORIZATION, CONTENT_DISPOSITION, CONTENT_TYPE},
        HeaderMap, Method, StatusCode,
    },
    response::{IntoResponse, Json},
    routing::{get, post},
    Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use tokio::sync::{broadcast, mpsc};
use tokio_util::sync::CancellationToken;
use tower_http::cors::{Any, CorsLayer};

use crate::{
    backend::BackendClient,
    config::{ConfigStore, MachineConfigUpdateRequest, MachinePublicConfig},
    events::DaemonEvent,
    logs,
    state::{
        store::{
            MachinePlanogramInput, MachinePlanogramSlotInput, SlotSalesStateInput,
            StockMovementInput, OUTBOX_MAX_EVENTS,
        },
        LocalStateStore, StoreError,
    },
    transaction::TransactionStateMachine,
};

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisionStatusSnapshot {
    pub enabled: bool,
    pub online: bool,
    pub message: String,
    pub updated_at: String,
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
            })),
            catalog: Arc::new(tokio::sync::RwLock::new(CatalogSnapshot {
                items: vec![],
                cached: false,
                last_updated_at: None,
                source: "uninitialized".to_string(),
                last_error: None,
            })),
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
    pub events: broadcast::Sender<DaemonEvent>,
    pub runtime_tx: mpsc::Sender<vending_core::scanner::RawPaymentCode>,
    pub disk_pressure_probe: Arc<dyn crate::health::DiskPressureProbe>,
    pub ui: UiRuntimeServices,
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
        .route("/v1/config", get(get_config).put(put_config))
        .route("/v1/provisioning/claim", post(claim_machine))
        .route("/v1/catalog", get(catalog_snapshot).post(refresh_catalog))
        .route("/v1/sale-view", get(sale_view))
        .route("/v1/sale-readiness", get(sale_readiness))
        .route("/v1/stock/planogram", post(apply_planogram))
        .route("/v1/stock/planogram/sync", post(sync_planogram))
        .route("/v1/stock/movements", post(record_stock_movement))
        .route("/v1/stock/slot-sales-state", post(update_slot_sales_state))
        .route("/v1/payment-options", get(payment_options))
        .route("/v1/intents/create-order", post(create_order_intent))
        .route(
            "/v1/intents/dev-submit-payment-code",
            post(dev_submit_payment_code_intent),
        )
        .route("/v1/transactions/current", get(current_transaction))
        .route("/v1/transactions/:order_no", get(transaction_by_order_no))
        .route("/v1/hardware/self-check", post(hardware_self_check))
        .route("/v1/sync/status", get(sync_status))
        .route("/v1/scanner/status", get(scanner_status))
        .route("/v1/vision/status", get(vision_status))
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
        .allow_headers([AUTHORIZATION, CONTENT_TYPE])
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
    state: IpcContext,
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

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaimMachineRequest {
    claim_code: String,
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

    let code = backend_error_json(error)
        .and_then(|value| {
            value
                .get("code")
                .and_then(|value| value.as_str())
                .and_then(safe_machine_claim_code)
        })
        .unwrap_or_else(|| {
            if backend_http_status(error).is_some_and(|status| status >= 500) {
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
        ready.ready = false;
        ready.can_sell = false;
        ready.mode = "maintenance".to_string();
        if !ready
            .blocking_codes
            .iter()
            .any(|code| code == "LOWER_CONTROLLER_UNAVAILABLE")
        {
            ready
                .blocking_codes
                .push("LOWER_CONTROLLER_UNAVAILABLE".to_string());
        }
        ready
            .blocking_reasons
            .push(vending_core::health::ReadyReason {
                code: "LOWER_CONTROLLER_UNAVAILABLE".to_string(),
                component: "hardware".to_string(),
                message: hardware.message,
            });
        ready.suggested_route = vending_core::health::SuggestedRoute::Maintenance;
    }
    let outbox_size = ctx.state.outbox_size().await.unwrap_or_default() as usize;
    let outbox_max = OUTBOX_MAX_EVENTS.max(1) as usize;
    if outbox_size as f64 / outbox_max as f64 >= 0.9 {
        ready.ready = false;
        ready.can_sell = false;
        ready.mode = "maintenance".to_string();
        if !ready
            .blocking_codes
            .iter()
            .any(|code| code == "SYNC_OUTBOX_CAPACITY")
        {
            ready
                .blocking_codes
                .push("SYNC_OUTBOX_CAPACITY".to_string());
        }
        ready
            .blocking_reasons
            .push(vending_core::health::ReadyReason {
                code: "SYNC_OUTBOX_CAPACITY".to_string(),
                component: "sync_outbox".to_string(),
                message: format!(
                    "sync outbox capacity pressure: {outbox_size}/{outbox_max} pending events"
                ),
            });
        ready.suggested_route = vending_core::health::SuggestedRoute::Maintenance;
    }
    let disk_pressure = disk_pressure_snapshot(&ctx);
    if disk_pressure.pressured {
        ready.ready = false;
        ready.can_sell = false;
        ready.mode = "maintenance".to_string();
        if !ready
            .blocking_codes
            .iter()
            .any(|code| code == crate::health::DISK_PRESSURE_CODE)
        {
            ready
                .blocking_codes
                .push(crate::health::DISK_PRESSURE_CODE.to_string());
        }
        ready
            .blocking_reasons
            .push(vending_core::health::ReadyReason {
                code: crate::health::DISK_PRESSURE_CODE.to_string(),
                component: "disk".to_string(),
                message: disk_pressure.message,
            });
        ready.suggested_route = vending_core::health::SuggestedRoute::Maintenance;
    }
    Json(ready)
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
    Json(payload): Json<ClaimMachineRequest>,
) -> impl IntoResponse {
    if let Err((status, error)) = require_token(&headers, &ctx.token).await {
        return (status, error).into_response();
    }

    let claim_code = payload.claim_code.trim().to_ascii_uppercase();
    let public = match ctx.config_store.load_public_config().await {
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
    let profile = match client.claim_machine(&claim_code).await {
        Ok(profile) => profile,
        Err(error) => {
            return machine_claim_error_response(&error).into_response();
        }
    };
    let machine_code = profile.machine.code.clone();
    match ctx.config_store.apply_provisioning_profile(profile).await {
        Ok(config) => {
            let _ = ctx.events.send(DaemonEvent::RuntimeReconfigureRequested {
                event_id: uuid::Uuid::new_v4().simple().to_string(),
                updated_at: crate::state::store::now_iso(),
                reason: "machine_provisioned".to_string(),
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

async fn create_order_intent(
    State(ctx): State<IpcContext>,
    headers: HeaderMap,
    Json(input): Json<CreateOrder>,
) -> impl IntoResponse {
    if let Err((status, error)) = require_token(&headers, &ctx.token).await {
        return (status, error).into_response();
    }

    let verified_line = match validate_create_order_intent(&ctx, &input).await {
        Ok(line) => line,
        Err(error) => {
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
        .filter(|value| !value.trim().is_empty());

    match ctx
        .ui
        .transaction
        .create_order(
            &input.payment_method,
            payment_provider_code,
            items,
            input.profile_snapshot,
        )
        .await
    {
        Ok(snapshot) => (StatusCode::OK, Json(snapshot)).into_response(),
        Err(error) => (
            StatusCode::BAD_REQUEST,
            Json(ErrorMessage {
                code: "create_order_failed",
                message: error,
            }),
        )
            .into_response(),
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
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorMessage {
                code: "submit_payment_code_failed",
                message: error.to_string(),
            }),
        )
            .into_response();
    }

    match ctx.ui.transaction.restore_current().await {
        Ok(Some(snapshot)) => (StatusCode::OK, Json(snapshot)).into_response(),
        Ok(None) => (StatusCode::OK, Json(empty_current_transaction_snapshot())).into_response(),
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
    match ctx.state.current_transaction_snapshot().await {
        Ok(Some(snapshot)) => Json(snapshot).into_response(),
        Ok(None) => Json(empty_current_transaction_snapshot()).into_response(),
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

    let config = match ctx.config_store.load_public_config().await {
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
        .load_public_config()
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

async fn machine_sale_readiness_snapshot(
    ctx: &IpcContext,
) -> Result<serde_json::Value, StoreError> {
    let public = ctx.config_store.load_public_config().await.ok();
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
    let reconciliation_blocked_slots: Vec<serde_json::Value> = sale_view
        .items
        .iter()
        .filter(|item| is_reconciliation_slot_blocker(&item.slot_sales_state))
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
    let whole_machine_ready = hardware.online;

    let scanner = ctx.ui.status_cache.scanner.read().await.clone();
    let scanner_ready = scanner.online
        && scanner.adapter == vending_core::scanner::PAYMENT_CODE_SOURCE_SERIAL_TEXT
        && scanner.code == "SCANNER_READY";

    let payment_probe = ctx.ui.backend.get_payment_options().await;
    let platform_ready = payment_probe.is_ok();
    let mut payment_methods = Vec::new();
    let mut payment_options_error = None;
    if let Ok(payload) = payment_probe.as_ref() {
        match strict_payment_options(payload) {
            Ok(options) => {
                for option in options {
                    let mut ready = !option.disabled;
                    let mut disabled_reason = option.disabled_reason;
                    if option.method == "payment_code" && !scanner_ready {
                        ready = false;
                        disabled_reason = Some(format!("扫码器不可用：{}", scanner.message));
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
    if !whole_machine_ready {
        blocking_codes.push("LOWER_CONTROLLER_UNAVAILABLE");
    }
    let can_start_network_authorized_sale = platform_ready
        && machine_auth_ready
        && active_planogram_ready
        && payment_options_ready
        && sync_ready
        && whole_machine_ready;

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
                if scanner_ready { "SCANNER_READY" } else { "SCANNER_UNAVAILABLE" },
                scanner.message,
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
                if whole_machine_ready { "WHOLE_MACHINE_READY" } else { "LOWER_CONTROLLER_UNAVAILABLE" },
                hardware.message,
            ),
            "slotSaleSafety": serde_json::json!({
                "ready": slot_sale_safety_ready,
                "code": if slot_sale_safety_ready { "SLOT_SALE_SAFETY_READY" } else { "NO_SALEABLE_SLOTS" },
                "message": if slot_sale_safety_ready {
                    "slot sale safety ready".to_string()
                } else if reconciliation_blocked_slots.is_empty() {
                    "no saleable slots".to_string()
                } else {
                    format!("{} slot(s) blocked by reconciliation", reconciliation_blocked_slots.len())
                },
                "blockedSlots": reconciliation_blocked_slots,
            }),
        },
    }))
}

fn is_reconciliation_slot_blocker(slot_sales_state: &str) -> bool {
    matches!(
        slot_sales_state,
        "needs_count"
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

fn is_supported_payment_method(value: &str) -> bool {
    matches!(value, "mock" | "qr_code" | "payment_code")
}

fn is_supported_payment_provider(value: &str) -> bool {
    matches!(value, "mock" | "wechat_pay" | "alipay")
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
        return Err(format!(
            "selected payment method {} is unavailable",
            input.payment_method
        ));
    }
    if let Some(provider) = selected_provider {
        if !provider_seen {
            return Err(format!(
                "selected payment provider {provider} is unavailable for {}",
                input.payment_method
            ));
        }
    }

    Err(not_ready_reason
        .map(|reason| format!("selected payment option is not ready: {reason}"))
        .unwrap_or_else(|| "selected payment option is not ready".to_string()))
}

async fn validate_create_order_intent(
    ctx: &IpcContext,
    input: &CreateOrder,
) -> Result<VerifiedCreateOrderLine, String> {
    if input.quantity == 0 {
        return Err("quantity must be positive".to_string());
    }

    let readiness = machine_sale_readiness_snapshot(ctx)
        .await
        .map_err(|error| error.to_string())?;
    let can_start = readiness
        .get("canStartNetworkAuthorizedSale")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    if !can_start {
        let codes = readiness
            .get("blockingCodes")
            .and_then(|value| value.as_array())
            .map(|codes| {
                codes
                    .iter()
                    .filter_map(|code| code.as_str())
                    .collect::<Vec<_>>()
                    .join(",")
            })
            .filter(|codes| !codes.is_empty())
            .unwrap_or_else(|| "UNKNOWN_READINESS_BLOCKER".to_string());
        return Err(format!("machine is not ready for network sale: {codes}"));
    }
    validate_selected_payment_option(&readiness, input)?;

    let machine_code = ctx
        .config_store
        .load_public_config()
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

    let config = match ctx.config_store.load_public_config().await {
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

    match ctx.state.apply_planogram(input).await {
        Ok(snapshot) => (StatusCode::OK, Json(snapshot)).into_response(),
        Err(error) => store_error_response("planogram_apply_failed", error),
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

    let config = match ctx.config_store.load_public_config().await {
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

async fn update_slot_sales_state(
    State(ctx): State<IpcContext>,
    headers: HeaderMap,
    Json(input): Json<SlotSalesStateInput>,
) -> impl IntoResponse {
    if let Err((status, error)) = require_token(&headers, &ctx.token).await {
        return (status, error).into_response();
    }

    match ctx.state.update_slot_sales_state(input).await {
        Ok(snapshot) => (StatusCode::OK, Json(snapshot)).into_response(),
        Err(error) => store_error_response("slot_sales_state_update_failed", error),
    }
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
            let scanner = ctx.ui.status_cache.scanner.read().await.clone();
            let mut default_option_key = serde_json::Value::Null;
            let mut default_provider_code = serde_json::Value::Null;
            if let Some(options) = payload
                .get_mut("options")
                .and_then(|value| value.as_array_mut())
            {
                for option in options.iter_mut() {
                    let is_payment_code = option.get("method").and_then(|value| value.as_str())
                        == Some("payment_code");
                    if is_payment_code
                        && (!scanner.online
                            || scanner.adapter
                                != vending_core::scanner::PAYMENT_CODE_SOURCE_SERIAL_TEXT
                            || scanner.code != "SCANNER_READY")
                    {
                        if let Some(map) = option.as_object_mut() {
                            map.insert("disabled".to_string(), serde_json::Value::Bool(true));
                            map.insert(
                                "disabledReason".to_string(),
                                serde_json::Value::String(format!(
                                    "扫码器不可用：{}",
                                    scanner.message
                                )),
                            );
                        }
                    }
                }
                let first_enabled = options.iter().find(|option| {
                    !option
                        .get("disabled")
                        .and_then(|value| value.as_bool())
                        .unwrap_or(false)
                });
                default_option_key = first_enabled
                    .and_then(|option| option.get("optionKey"))
                    .cloned()
                    .unwrap_or(serde_json::Value::Null);
                default_provider_code = first_enabled
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

    let snapshot = ctx.ui.status_cache.scanner.read().await.clone();
    (StatusCode::OK, Json(snapshot)).into_response()
}

fn empty_current_transaction_snapshot() -> vending_core::domain::CurrentTransactionSnapshot {
    vending_core::domain::CurrentTransactionSnapshot {
        order_id: None,
        order_no: None,
        product_summary: None,
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

async fn hardware_self_check(
    State(ctx): State<IpcContext>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if let Err((status, error)) = require_token(&headers, &ctx.token).await {
        return (status, error).into_response();
    }
    let public = match ctx.config_store.load_public_config().await {
        Ok(public) => public,
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorMessage {
                    code: "config_missing",
                    message: error,
                }),
            )
                .into_response();
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

    *ctx.ui.status_cache.hardware.write().await = status.clone();
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

async fn vision_status(State(ctx): State<IpcContext>, headers: HeaderMap) -> impl IntoResponse {
    if let Err((status, error)) = require_token(&headers, &ctx.token).await {
        return (status, error).into_response();
    }

    let snapshot = ctx.ui.status_cache.vision.read().await;

    Json(serde_json::json!({
        "enabled": snapshot.enabled,
        "online": snapshot.online,
        "message": snapshot.message,
    }))
    .into_response()
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
        config::default_public_config, secret::InMemorySecretStore, state::store::OutboxInput,
        transaction::TransactionStateMachine,
    };
    use axum::{
        body,
        http::{Method, Request, StatusCode},
    };
    use serde_json::json;
    use std::sync::Arc;
    use tempfile::tempdir;
    use tower::util::ServiceExt;
    use wiremock::{
        matchers::{body_partial_json, method, path},
        Mock, MockServer, ResponseTemplate,
    };

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
        let data_dir = data_dir.to_path_buf();
        let state = crate::state::LocalStateStore::open(&data_dir.join("state.db"))
            .await
            .expect("state");
        let secrets: Arc<dyn crate::secret::SecretStore> = Arc::new(InMemorySecretStore::default());
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
        let public = config_store
            .load_public_config()
            .await
            .expect("load public config");

        let (events_tx, _) = broadcast::channel(8);
        let (runtime_tx, _rx_raw) = mpsc::channel(8);
        let backend = Arc::new(BackendClient::new(backend_base_url));
        let status_cache = RuntimeStatusCache::new(&public, state.clone()).await;
        let transaction = TransactionStateMachine::new(
            state.clone(),
            backend.clone(),
            public.machine_code.clone(),
            events_tx.clone(),
        );

        IpcContext {
            data_dir,
            token: token.into(),
            config_store,
            state,
            events: events_tx,
            runtime_tx,
            disk_pressure_probe: Arc::new(crate::health::DataDirDiskPressureProbe::default()),
            ui: UiRuntimeServices {
                backend,
                transaction,
                status_cache,
            },
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

    fn valid_provisioning_profile() -> serde_json::Value {
        json!({
            "machine": {
                "id": "550e8400-e29b-41d4-a716-446655440000",
                "code": "M001",
                "name": "Lobby",
                "status": "offline",
                "locationText": "1F"
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
            "paymentCapability": {
                "profile": "production",
                "options": [{
                    "optionKey": "qr_code:alipay",
                    "providerCode": "alipay",
                    "method": "qr_code",
                    "displayName": "支付宝扫码",
                    "description": "请使用支付宝扫描屏幕二维码",
                    "icon": "alipay",
                    "recommended": true,
                    "disabled": false,
                    "disabledReason": null
                }],
                "defaultOptionKey": "qr_code:alipay",
                "defaultProviderCode": "alipay",
                "serverTime": "2026-06-08T16:30:00.000Z"
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
                "claimCode": "ABCD-2345"
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
            config["public"]["paymentCapability"]["defaultProviderCode"],
            "alipay"
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
        profile["paymentCapability"]["options"] = json!([{
            "optionKey": "mock:mock",
            "providerCode": "mock",
            "method": "mock",
            "displayName": "模拟支付",
            "description": "测试环境专用",
            "icon": "mock",
            "recommended": true,
            "disabled": false,
            "disabledReason": null
        }]);
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
        assert_eq!(payload["message"], "payment capability invalid");
    }

    #[tokio::test]
    async fn provisioning_profile_rejects_secret_shaped_payment_option_fields() {
        let mut profile = valid_provisioning_profile();
        profile["paymentCapability"]["options"][0]["merchantPrivateKey"] =
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
        let app =
            build_router(test_ipc_context(temp_dir.path(), "token-1", None, &server.uri()).await);
        tokio::fs::remove_dir_all(temp_dir.path().join("logs"))
            .await
            .expect("remove logs dir");
        tokio::fs::write(temp_dir.path().join("logs"), b"not-a-directory")
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
        assert!(payload["message"]
            .as_str()
            .unwrap()
            .contains("payment option is not ready"));

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
