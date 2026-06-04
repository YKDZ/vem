use std::{net::SocketAddr, path::Path, path::PathBuf, sync::Arc};

use axum::extract::ws::{Message, WebSocket};
use axum::{
    extract::{Path as AxumPath, State, WebSocketUpgrade},
    http::{
        header::{AUTHORIZATION, CONTENT_DISPOSITION, CONTENT_TYPE},
        HeaderMap, StatusCode,
    },
    response::{IntoResponse, Json},
    routing::{get, post},
    Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use tokio::sync::{broadcast, mpsc};
use tokio_util::sync::CancellationToken;

use crate::{
    backend::BackendClient,
    config::{ConfigStore, MachineConfigUpdateRequest, MachinePublicConfig},
    events::DaemonEvent,
    logs,
    state::{
        store::{MachinePlanogramInput, StockMovementInput},
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
                    outbox_max: 1000,
                    outbox_usage: if outbox_size == 0 {
                        0.0
                    } else {
                        outbox_size as f64 / 1000_f64
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
        .route("/v1/catalog", get(catalog_snapshot).post(refresh_catalog))
        .route("/v1/sale-view", get(sale_view))
        .route("/v1/stock/planogram", post(apply_planogram))
        .route("/v1/stock/movements", post(record_stock_movement))
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
    payment_method: String,
    payment_provider_code: Option<String>,
    profile_snapshot: Option<serde_json::Value>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubmitPayment {
    order_no: String,
    auth_code: String,
    source: String,
}

#[derive(serde::Deserialize)]
struct EventQuery {
    token: Option<String>,
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

async fn create_order_intent(
    State(ctx): State<IpcContext>,
    headers: HeaderMap,
    Json(input): Json<CreateOrder>,
) -> impl IntoResponse {
    if let Err((status, error)) = require_token(&headers, &ctx.token).await {
        return (status, error).into_response();
    }

    let items = serde_json::json!({
        "inventoryId": input.inventory_id,
        "quantity": input.quantity,
        "profileSnapshot": input.profile_snapshot,
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

    match ctx.state.record_stock_movement(input).await {
        Ok(snapshot) => (StatusCode::CREATED, Json(snapshot)).into_response(),
        Err(error) => store_error_response("stock_movement_record_failed", error),
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
        config::default_public_config, secret::InMemorySecretStore,
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
    use wiremock::{matchers::method, Mock, MockServer, ResponseTemplate};

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
        assert_eq!(item["slotSalesState"], "saleable");
        assert!(item.get("availableQty").is_none());
    }

    #[tokio::test]
    async fn stock_count_correction_appends_fact_and_projects_sold_out() {
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

        let movement_count: (i64,) =
            sqlx::query_as("SELECT COUNT(1) FROM stock_movements WHERE slot_id = ?1")
                .bind("550e8400-e29b-41d4-a716-446655440011")
                .fetch_one(state.pool())
                .await
                .expect("movement count");
        assert_eq!(movement_count.0, 2);
    }
}
