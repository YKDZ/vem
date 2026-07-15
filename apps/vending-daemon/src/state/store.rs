use std::{
    collections::{HashMap, HashSet},
    path::Path,
};

use chrono::{SecondsFormat, Utc};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{sqlite::SqlitePoolOptions, Row, Sqlite, SqlitePool, Transaction};
use thiserror::Error;
use uuid::Uuid;

use vending_core::domain::{
    CommandLogStatus, InternalCheckoutFlowAction, OutboxKind, OutboxTransport,
};

use super::schema::{
    MIGRATION_V1, MIGRATION_V10, MIGRATION_V11, MIGRATION_V12, MIGRATION_V13, MIGRATION_V14,
    MIGRATION_V15, MIGRATION_V16, MIGRATION_V2, MIGRATION_V3, MIGRATION_V4, MIGRATION_V5,
    MIGRATION_V6, MIGRATION_V7, MIGRATION_V8, MIGRATION_V9, SCHEMA_VERSION,
};
use vending_core::hardware::{
    DispenseCommandPayload, DispenseProgressEvent, DispenseProgressStage, DispenseResultPayload,
    EnvironmentControlResultPayload, HardwareStatus,
};

const COMMAND_LOG_TTL_DAYS: i64 = 30;
const COMMAND_LOG_MAX_ENTRIES: i64 = 2000;
const MANUAL_DISPENSE_DIAGNOSTIC_MAX_ENTRIES: i64 = 2000;
const OUTBOX_TTL_DAYS: i64 = 7;
pub const OUTBOX_MAX_EVENTS: i64 = 500;
const STOCK_LEDGER_REBUILT_AFTER_QUARANTINE_KEY: &str = "stock_ledger_rebuilt_after_quarantine";
const STOCK_MOVEMENT_RETENTION_DAYS: i64 = 30;
const PHYSICAL_STOCK_ATTESTATION_KEY: &str = "physical_stock_attestation";
const PENDING_PHYSICAL_STOCK_ATTESTATION_KEY: &str = "pending_physical_stock_attestation";
const FAILED_PHYSICAL_STOCK_ATTESTATION_KEY: &str = "failed_physical_stock_attestation";
const STOCK_MAINTENANCE_REFILL_TASK_KEY: &str = "stock_maintenance_refill_task";
const STOCK_MAINTENANCE_COUNT_TASK_KEY: &str = "stock_maintenance_count_task";
pub(crate) const WHOLE_MACHINE_MAINTENANCE_LOCK_KEY: &str = "whole_machine_maintenance_lock";
pub(crate) const WHOLE_MACHINE_LOCK_RECOVERY_EVIDENCE_KEY: &str =
    "whole_machine_lock_recovery_evidence";

type CommandRecordRow = (
    String,
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    String,
    String,
);

type OutboxRecordRow = (
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    String,
    i64,
    String,
    String,
    i64,
    Option<String>,
    String,
);

type CurrentOrderSessionRow = (Option<String>, Option<String>, Option<String>, String);
type StockMovementSyncRecordRow = (
    String,
    String,
    String,
    i64,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    String,
    String,
);
type PreviousSlotProjectionRow = (String, i64, String, String, String, String, Option<String>);
type OrderSessionRecordRow = (
    String,
    String,
    Option<String>,
    Option<String>,
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    String,
    String,
);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WholeMachineMaintenanceLock {
    pub code: String,
    pub message: String,
    pub source: String,
    pub order_no: String,
    pub command_no: String,
    pub slot_code: String,
    pub error_code: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WholeMachineMaintenanceLockClearEvidence {
    pub adapter: String,
    pub online: bool,
    pub message: String,
    pub port_path: Option<String>,
    pub checked_at: String,
    pub production_dispense_path_ready: bool,
    pub production_dispense_path_code: String,
    pub production_dispense_path_message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WholeMachineMaintenanceLockClearAudit {
    pub id: String,
    pub operator_note: String,
    pub cleared_at: String,
    pub previous: WholeMachineMaintenanceLock,
    pub recovery_evidence: WholeMachineMaintenanceLockClearEvidence,
}

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("sqlite error: {0}")]
    Sqlx(#[from] sqlx::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("integrity check failed: {0}")]
    IntegrityCheckFailed(String),
    #[error("corrupt sqlite database, quarantined at {path}")]
    CorruptDatabase { path: String },
    #[error("runtime lock is already held")]
    RuntimeLockHeld,
    #[error("outbox event capacity limit reached")]
    OutboxCapacity,
    #[error("payment code attempt is already active")]
    ActivePaymentCodeAttempt,
    #[error("invalid stock input: {0}")]
    InvalidStockInput(String),
    #[error("invalid checkout flow action for new write: {0}")]
    InvalidCheckoutFlowAction(String),
    #[error("manual dispense diagnostic capacity limit reached")]
    ManualDispenseDiagnosticCapacity,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandLogRecord {
    pub command_no: String,
    pub order_no: String,
    pub status: CommandLogStatus,
    pub command_payload: DispenseCommandPayload,
    pub result_payload: Option<DispenseResultPayload>,
    pub updated_at: String,
    pub expires_at: String,
    pub ack_at: Option<String>,
    pub dispensing_started_at: Option<String>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DestructiveCommandRecord {
    pub message_id: String,
    pub command_type: String,
    pub payload_json: serde_json::Value,
    pub issued_at: String,
    pub status: String,
    pub error_message: Option<String>,
    pub updated_at: String,
    pub expires_at: String,
}

/// Binds the local finalization marker to one accepted destructive command.
/// A command message id is the command generation for the MQTT control plane:
/// retries reuse it, while a new secure-decommission command must not inherit
/// acknowledgement from an earlier generation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SecureDecommissionFinalizeMarker {
    pub message_id: String,
    pub command_no: String,
    pub generation: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutboxRecord {
    pub id: String,
    pub kind: OutboxKind,
    pub transport: OutboxTransport,
    pub topic: Option<String>,
    pub target_url: Option<String>,
    pub method: Option<String>,
    pub payload_json: serde_json::Value,
    pub priority: i64,
    pub created_at: String,
    pub next_attempt_at: String,
    pub attempt_count: i64,
    pub last_error: Option<String>,
    pub expires_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StockMovementSyncRecord {
    pub movement_id: String,
    pub status: String,
    pub outbox_event_id: String,
    pub attempt_count: i64,
    pub last_error: Option<String>,
    pub accepted_at: Option<String>,
    pub platform_receipt_json: Option<serde_json::Value>,
    pub rejection_json: Option<serde_json::Value>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderSessionRecord {
    pub order_no: String,
    pub payment_method: String,
    pub payment_provider: Option<String>,
    pub payment_attempt_json: Option<String>,
    pub items_json: String,
    pub status: String,
    pub next_action: String,
    pub expires_at: Option<String>,
    pub last_backend_status_json: Option<String>,
    pub last_error: Option<String>,
    pub recovery_strategy: String,
    pub updated_at: String,
}

pub struct OrderSessionUpsert<'a> {
    pub order_no: &'a str,
    pub payment_method: &'a str,
    pub payment_provider: Option<&'a str>,
    pub items_json: serde_json::Value,
    pub status: &'a str,
    pub next_action: &'a str,
    pub payment_attempt_json: Option<serde_json::Value>,
    pub recovery_strategy: &'a str,
    pub last_backend_status_json: Option<serde_json::Value>,
    pub last_error: Option<&'a str>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ManualDispenseDiagnostic {
    pub diagnostic_id: String,
    pub idempotency_key: String,
    pub status: String,
    pub operator_id: String,
    pub session_correlation_id: String,
    pub controller: serde_json::Value,
    pub command: serde_json::Value,
    pub started_at: String,
    pub completed_at: Option<String>,
    pub raw_result: Option<serde_json::Value>,
    pub normalized_result: Option<serde_json::Value>,
    pub reconciliation_status: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ManualDispenseReservation {
    Reserved(ManualDispenseDiagnostic),
    Existing(ManualDispenseDiagnostic),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MachinePlanogramInput {
    pub planogram_version: String,
    pub source: String,
    pub applied_by: Option<String>,
    pub slots: Vec<MachinePlanogramSlotInput>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MachinePlanogramSlotInput {
    pub slot_id: String,
    pub slot_code: String,
    pub layer_no: i64,
    pub cell_no: i64,
    pub capacity: i64,
    pub par_level: i64,
    pub inventory_id: String,
    pub variant_id: String,
    pub product_id: String,
    pub product_name: String,
    pub product_description: Option<String>,
    pub cover_image_url: Option<String>,
    #[serde(default)]
    pub try_on_silhouette_url: Option<String>,
    pub category_id: Option<String>,
    pub category_name: Option<String>,
    pub sku: String,
    pub size: Option<String>,
    pub color: Option<String>,
    pub price_cents: i64,
    pub product_sort_order: i64,
    pub target_gender: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StockMovementInput {
    pub movement_id: String,
    pub planogram_version: String,
    pub slot_id: String,
    pub movement_type: String,
    pub quantity: i64,
    pub source: String,
    pub attributed_to: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhysicalStockAttestationInput {
    pub attestation_id: String,
    pub planogram_version: String,
    pub operator_id: String,
    pub slots: Vec<PhysicalStockAttestationSlotInput>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhysicalStockAttestationSlotInput {
    pub slot_id: String,
    pub slot_code: String,
    pub sku: String,
    pub quantity: i64,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhysicalStockAttestationStatus {
    pub status: String,
    pub code: String,
    pub message: String,
    pub attestation_id: Option<String>,
    pub planogram_version: Option<String>,
    pub attested_at: Option<String>,
    pub inconsistent_slots: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredPhysicalStockAttestation {
    attestation_id: String,
    planogram_version: String,
    operator_id: String,
    attested_at: String,
    slots: Vec<PhysicalStockAttestationSlotInput>,
}

/// The submitted observation is durable before it is sale evidence, but it
/// remains intentionally outside stock_movements/current_stock_projection
/// until Platform has acknowledged every resulting correction.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingPhysicalStockAttestation {
    input: PhysicalStockAttestationInput,
    attested_at: String,
    movement_ids: Vec<String>,
    #[serde(default)]
    slot_generations: Vec<PendingPhysicalStockAttestationSlotGeneration>,
}

/// Binds one slot observation to the exact Platform idempotency generation
/// and quantity transition that was submitted.  The corresponding durable
/// receipt remains in `stock_movement_sync`, keyed by `movement_id`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingPhysicalStockAttestationSlotGeneration {
    slot_id: String,
    movement_id: String,
    generation: String,
    before_quantity: i64,
    after_quantity: i64,
    occurred_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlotSalesStateInput {
    pub planogram_version: String,
    pub slot_id: String,
    pub slot_sales_state: String,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaleViewSnapshot {
    pub items: Vec<SaleViewItem>,
    pub source: String,
    pub planogram_version: Option<String>,
    pub last_updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaleViewItem {
    pub machine_code: Option<String>,
    pub slot_id: String,
    pub slot_code: String,
    pub layer_no: i64,
    pub cell_no: i64,
    pub inventory_id: String,
    pub variant_id: String,
    pub product_id: String,
    pub product_name: String,
    pub product_description: Option<String>,
    pub cover_image_url: Option<String>,
    #[serde(default)]
    pub try_on_silhouette_url: Option<String>,
    pub category_id: Option<String>,
    pub category_name: Option<String>,
    pub sku: String,
    pub size: Option<String>,
    pub color: Option<String>,
    pub price_cents: i64,
    pub product_sort_order: i64,
    pub target_gender: Option<String>,
    pub capacity: i64,
    pub par_level: i64,
    pub physical_stock: i64,
    pub saleable_stock: i64,
    pub slot_sales_state: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StockMaintenanceTask {
    pub task_id: String,
    pub mode: String,
    pub status: String,
    pub slots: Vec<StockMaintenanceTaskSlot>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StockMaintenanceTaskSlot {
    pub slot_code: String,
    pub layer_no: i64,
    pub cell_no: i64,
    pub product_name: String,
    pub sku: String,
    pub capacity: i64,
    pub current_quantity: i64,
    pub submitted_quantity: Option<i64>,
    pub submitted_addition: Option<i64>,
    pub preview_quantity: Option<i64>,
    pub sync_status: String,
    pub sales_state: String,
    pub reconciliation_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StockMaintenanceBatchInput {
    pub task_id: String,
    pub mode: String,
    pub slots: Vec<StockMaintenanceBatchSlotInput>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StockMaintenanceBatchSlotInput {
    pub slot_code: String,
    #[serde(default)]
    pub quantity: Option<i64>,
    #[serde(default)]
    pub addition: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StockMaintenanceBatchResponse {
    pub task: StockMaintenanceTask,
    pub duplicate: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StockMaintenanceTaskIdentity {
    planogram_version: String,
    planogram_revision: String,
    mode: String,
    slots: Vec<StockMaintenanceTaskIdentitySlot>,
    task_id: String,
    #[serde(default)]
    predecessor_task_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StockMaintenanceTaskIdentitySlot {
    slot_id: String,
    slot_code: String,
    sku: String,
    capacity: i64,
    inventory_id: String,
    variant_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StockMaintenanceSlotDifference {
    slot_code: String,
    changes: Vec<String>,
    old_slots: Vec<StockMaintenanceTaskIdentitySlot>,
    current_slots: Vec<StockMaintenanceTaskIdentitySlot>,
    current_planogram_version: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NormalizedStockMaintenanceRefillBatch {
    task_id: String,
    mode: String,
    slots: Vec<NormalizedStockMaintenanceRefillSlot>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NormalizedStockMaintenanceRefillSlot {
    slot_code: String,
    addition: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StockMaintenanceRefillCapacitySnapshot {
    slot_id: String,
    slot_code: String,
    capacity: i64,
    before_quantity: i64,
    after_quantity: i64,
}

#[derive(Debug, Clone)]
pub struct OutboxInput {
    pub id: String,
    pub kind: OutboxKind,
    pub transport: OutboxTransport,
    pub topic: Option<String>,
    pub target_url: Option<String>,
    pub method: Option<String>,
    pub payload_json: serde_json::Value,
    pub priority: i64,
}

impl OutboxInput {
    pub fn command_ack(machine_code: &str, command_no: &str) -> Self {
        Self {
            id: format!("{machine_code}:ack:{command_no}"),
            kind: OutboxKind::CommandAck,
            transport: OutboxTransport::Mqtt,
            topic: Some(format!(
                "vem/machines/{machine_code}/commands/{command_no}/ack"
            )),
            target_url: None,
            method: None,
            payload_json: serde_json::json!({ "messageId": format!("{command_no}:ack") }),
            priority: 100,
        }
    }

    pub fn dispense_result(machine_code: &str, result: &DispenseResultPayload) -> Self {
        Self {
            id: format!("{machine_code}:result:{}", result.command_no),
            kind: OutboxKind::DispenseResult,
            transport: OutboxTransport::Mqtt,
            topic: Some(format!(
                "vem/machines/{machine_code}/events/dispense-result"
            )),
            target_url: None,
            method: None,
            payload_json: serde_json::to_value(result).expect("serialize result"),
            priority: 150,
        }
    }

    pub fn environment_control_result(
        machine_code: &str,
        result: &EnvironmentControlResultPayload,
    ) -> Self {
        Self {
            id: format!(
                "{machine_code}:environment-control-result:{}",
                result.command_no
            ),
            kind: OutboxKind::DispenseResult,
            transport: OutboxTransport::Mqtt,
            topic: Some(format!(
                "vem/machines/{machine_code}/events/environment-control-result"
            )),
            target_url: None,
            method: None,
            payload_json: serde_json::to_value(result).expect("serialize environment result"),
            priority: 150,
        }
    }

    pub fn secure_decommission_result(
        machine_code: &str,
        command_no: &str,
        payload_json: serde_json::Value,
    ) -> Self {
        Self {
            id: format!("{machine_code}:secure-decommission-result:{command_no}"),
            kind: OutboxKind::RemoteOpResult,
            transport: OutboxTransport::Mqtt,
            topic: Some(format!(
                "vem/machines/{machine_code}/events/secure-decommission-result"
            )),
            target_url: None,
            method: None,
            payload_json,
            priority: 200,
        }
    }

    pub fn heartbeat(machine_code: &str, payload: serde_json::Value) -> Self {
        Self {
            id: format!("{machine_code}:heartbeat:{}", Uuid::new_v4()),
            kind: OutboxKind::Heartbeat,
            transport: OutboxTransport::Mqtt,
            topic: Some(format!("vem/machines/{machine_code}/events/heartbeat")),
            target_url: None,
            method: None,
            payload_json: payload,
            priority: 900,
        }
    }

    pub fn remote_op_result(target_url: String, payload: serde_json::Value) -> Self {
        Self {
            id: format!("remote-op:{}", Uuid::new_v4()),
            kind: OutboxKind::RemoteOpResult,
            transport: OutboxTransport::Http,
            topic: None,
            target_url: Some(target_url),
            method: Some("POST".to_string()),
            payload_json: payload,
            priority: 300,
        }
    }

    pub fn log_export(target_url: String, payload: serde_json::Value) -> Self {
        Self {
            id: format!("log-export:{}", Uuid::new_v4()),
            kind: OutboxKind::LogExport,
            transport: OutboxTransport::Http,
            topic: None,
            target_url: Some(target_url),
            method: Some("POST".to_string()),
            payload_json: payload,
            priority: 700,
        }
    }

    pub fn stock_movement_upload(
        movement_id: &str,
        target_url: String,
        payload: serde_json::Value,
    ) -> Self {
        Self {
            id: format!("stock-movement:{movement_id}"),
            kind: OutboxKind::StockMovementUpload,
            transport: OutboxTransport::Http,
            topic: None,
            target_url: Some(target_url),
            method: Some("POST".to_string()),
            payload_json: payload,
            priority: 250,
        }
    }
}

#[derive(Debug, Clone)]
pub struct LocalStateStore {
    pool: SqlitePool,
}

impl LocalStateStore {
    #[cfg(test)]
    pub async fn close_for_tests(&self) {
        self.pool.close().await;
    }

    async fn begin_immediate_write_transaction(
        &self,
    ) -> Result<Transaction<'static, Sqlite>, StoreError> {
        Ok(self.pool.begin_with("BEGIN IMMEDIATE").await?)
    }

    pub async fn open(path: &Path) -> Result<Self, StoreError> {
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(sqlx::Error::Io)?;
        }

        let (pool, quarantine) = match open_sqlite_pool(path).await {
            Ok(pool) => (pool, None),
            Err(error) if path.exists() => {
                let reason = error.to_string();
                let quarantine = quarantine_sqlite_file(path).await?;
                let pool = open_sqlite_pool(path).await.map_err(StoreError::Sqlx)?;
                (pool, Some((quarantine, Some(reason))))
            }
            Err(error) => return Err(StoreError::Sqlx(error)),
        };

        match run_integrity_check(&pool).await {
            Ok(()) => {}
            Err(error) => {
                pool.close().await;
                let quarantine = quarantine_sqlite_file(path).await?;
                let pool = open_sqlite_pool(path).await.map_err(StoreError::Sqlx)?;
                let store = Self { pool };
                store.run_migrations().await?;
                store
                    .record_stock_ledger_quarantine(quarantine, Some(error))
                    .await?;
                store.put_metadata("last_started_at", &now_iso()).await?;
                return Ok(store);
            }
        }

        let store = Self { pool };
        store.run_migrations().await?;
        if let Some((quarantine, reason)) = quarantine {
            store
                .record_stock_ledger_quarantine(quarantine, reason)
                .await?;
        }
        store.put_metadata("last_started_at", &now_iso()).await?;
        Ok(store)
    }

    async fn run_migrations(&self) -> Result<(), StoreError> {
        sqlx::query(MIGRATION_V1)
            .execute(&self.pool)
            .await
            .map_err(StoreError::Sqlx)?;

        let current_version = self
            .get_metadata::<i64>("schema_version")
            .await?
            .unwrap_or_default();
        if current_version < 2 {
            sqlx::query(MIGRATION_V2)
                .execute(&self.pool)
                .await
                .map_err(StoreError::Sqlx)?;
        }
        if current_version < 3 {
            sqlx::query(MIGRATION_V3)
                .execute(&self.pool)
                .await
                .map_err(StoreError::Sqlx)?;
        }
        if current_version < 4 {
            sqlx::query(MIGRATION_V4)
                .execute(&self.pool)
                .await
                .map_err(StoreError::Sqlx)?;
        }
        if current_version < 5 {
            sqlx::query(MIGRATION_V5)
                .execute(&self.pool)
                .await
                .map_err(StoreError::Sqlx)?;
        }
        if current_version < 6 {
            sqlx::query(MIGRATION_V6)
                .execute(&self.pool)
                .await
                .map_err(StoreError::Sqlx)?;
        }
        if current_version < 7 {
            sqlx::query(MIGRATION_V7)
                .execute(&self.pool)
                .await
                .map_err(StoreError::Sqlx)?;
        }
        if current_version < 8 {
            sqlx::query(MIGRATION_V8)
                .execute(&self.pool)
                .await
                .map_err(StoreError::Sqlx)?;
        }
        if current_version < 9 {
            sqlx::query(MIGRATION_V9)
                .execute(&self.pool)
                .await
                .map_err(StoreError::Sqlx)?;
        }
        if current_version < 10 {
            sqlx::query(MIGRATION_V10)
                .execute(&self.pool)
                .await
                .map_err(StoreError::Sqlx)?;
        }
        if current_version < 11 {
            sqlx::query(MIGRATION_V11)
                .execute(&self.pool)
                .await
                .map_err(StoreError::Sqlx)?;
        }
        if current_version < 12 {
            sqlx::query(MIGRATION_V12)
                .execute(&self.pool)
                .await
                .map_err(StoreError::Sqlx)?;
        }
        if current_version < 13 {
            sqlx::query(MIGRATION_V13)
                .execute(&self.pool)
                .await
                .map_err(StoreError::Sqlx)?;
        }
        if current_version < 14 {
            sqlx::query(MIGRATION_V14)
                .execute(&self.pool)
                .await
                .map_err(StoreError::Sqlx)?;
        }
        if current_version < 15 {
            sqlx::query(MIGRATION_V15)
                .execute(&self.pool)
                .await
                .map_err(StoreError::Sqlx)?;
        }
        self.backfill_current_stock_maintenance_task_identities()
            .await?;
        if current_version < 16 {
            sqlx::query(MIGRATION_V16)
                .execute(&self.pool)
                .await
                .map_err(StoreError::Sqlx)?;
        }
        self.put_metadata("schema_version", &SCHEMA_VERSION).await?;
        Ok(())
    }

    async fn backfill_current_stock_maintenance_task_identities(&self) -> Result<(), StoreError> {
        for key in [
            STOCK_MAINTENANCE_COUNT_TASK_KEY,
            STOCK_MAINTENANCE_REFILL_TASK_KEY,
        ] {
            if let Some(identity) = self
                .get_metadata::<StockMaintenanceTaskIdentity>(key)
                .await?
            {
                self.remember_stock_maintenance_task_identity(&identity)
                    .await?;
            }
        }
        Ok(())
    }

    pub async fn record_manual_dispense_diagnostic(
        &self,
        record: &ManualDispenseDiagnostic,
    ) -> Result<(), StoreError> {
        sqlx::query(
            "INSERT INTO manual_dispense_diagnostics(
                diagnostic_id,idempotency_key,status,operator_id,session_correlation_id,
                controller_json,command_json,started_at,completed_at,raw_result_json,
                normalized_result_json,reconciliation_status,expires_at
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
        )
        .bind(&record.diagnostic_id)
        .bind(&record.idempotency_key)
        .bind(&record.status)
        .bind(&record.operator_id)
        .bind(&record.session_correlation_id)
        .bind(record.controller.to_string())
        .bind(record.command.to_string())
        .bind(&record.started_at)
        .bind(&record.completed_at)
        .bind(record.raw_result.as_ref().map(ToString::to_string))
        .bind(record.normalized_result.as_ref().map(ToString::to_string))
        .bind(&record.reconciliation_status)
        .bind(&record.expires_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn reserve_manual_dispense_diagnostic(
        &self,
        record: &ManualDispenseDiagnostic,
    ) -> Result<ManualDispenseReservation, StoreError> {
        let mut tx = self.begin_immediate_write_transaction().await?;
        let existing =
            manual_dispense_by_idempotency_in_tx(&mut tx, &record.idempotency_key).await?;
        if let Some(existing) = existing {
            tx.commit().await?;
            return Ok(ManualDispenseReservation::Existing(existing));
        }
        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM manual_dispense_diagnostics")
            .fetch_one(tx.as_mut())
            .await?;
        if count.0 >= MANUAL_DISPENSE_DIAGNOSTIC_MAX_ENTRIES {
            tx.rollback().await?;
            return Err(StoreError::ManualDispenseDiagnosticCapacity);
        }
        sqlx::query(
            "INSERT INTO manual_dispense_diagnostics(
              diagnostic_id,idempotency_key,status,operator_id,session_correlation_id,
              controller_json,command_json,started_at,reconciliation_status,expires_at
             ) VALUES (?1,?2,'pending',?3,?4,?5,?6,?7,'open',?8)",
        )
        .bind(&record.diagnostic_id)
        .bind(&record.idempotency_key)
        .bind(&record.operator_id)
        .bind(&record.session_correlation_id)
        .bind(record.controller.to_string())
        .bind(record.command.to_string())
        .bind(&record.started_at)
        .bind(&record.expires_at)
        .execute(tx.as_mut())
        .await?;
        tx.commit().await?;
        Ok(ManualDispenseReservation::Reserved(record.clone()))
    }

    pub async fn finish_manual_dispense_diagnostic(
        &self,
        id: &str,
        status: &str,
        raw: serde_json::Value,
        normalized: serde_json::Value,
    ) -> Result<ManualDispenseDiagnostic, StoreError> {
        let completed_at = now_iso();
        let result = sqlx::query(
            "UPDATE manual_dispense_diagnostics SET status=?2,completed_at=?3,
             raw_result_json=?4,normalized_result_json=?5
             WHERE diagnostic_id=?1 AND status='pending'",
        )
        .bind(id)
        .bind(status)
        .bind(&completed_at)
        .bind(raw.to_string())
        .bind(normalized.to_string())
        .execute(&self.pool)
        .await?;
        if result.rows_affected() != 1 {
            return Err(StoreError::Sqlx(sqlx::Error::RowNotFound));
        }
        self.manual_dispense_diagnostic(id)
            .await?
            .ok_or(StoreError::Sqlx(sqlx::Error::RowNotFound))
    }

    pub async fn manual_dispense_diagnostic(
        &self,
        id: &str,
    ) -> Result<Option<ManualDispenseDiagnostic>, StoreError> {
        let mut tx = self.pool.begin().await?;
        let row = manual_dispense_by_id_in_tx(&mut tx, id).await?;
        tx.commit().await?;
        Ok(row)
    }

    pub async fn prune_manual_dispense_diagnostics(&self) -> Result<u64, StoreError> {
        Ok(sqlx::query("DELETE FROM manual_dispense_diagnostics WHERE expires_at < ?1 AND reconciliation_status='reconciled'")
            .bind(now_iso()).execute(&self.pool).await?.rows_affected())
    }

    async fn record_stock_ledger_quarantine(
        &self,
        quarantine: std::path::PathBuf,
        reason: Option<String>,
    ) -> Result<(), StoreError> {
        self.put_metadata(STOCK_LEDGER_REBUILT_AFTER_QUARANTINE_KEY, &true)
            .await?;
        self.put_metadata(
            "stock_ledger_quarantine",
            &serde_json::json!({
                "path": quarantine.to_string_lossy(),
                "reason": reason,
                "quarantinedAt": now_iso(),
            }),
        )
        .await
    }

    pub fn pool(&self) -> &SqlitePool {
        &self.pool
    }

    pub async fn put_metadata<T: Serialize + Sync>(
        &self,
        key: &str,
        value: &T,
    ) -> Result<(), StoreError> {
        let json = serde_json::to_string(value)?;
        sqlx::query(
            "INSERT INTO runtime_metadata(key,value_json,updated_at)
             VALUES (?1,?2,?3)
             ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at",
        )
        .bind(key)
        .bind(json)
        .bind(now_iso())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn get_metadata<T: DeserializeOwned>(
        &self,
        key: &str,
    ) -> Result<Option<T>, StoreError> {
        let row: Option<(String,)> =
            sqlx::query_as("SELECT value_json FROM runtime_metadata WHERE key = ?1")
                .bind(key)
                .fetch_optional(&self.pool)
                .await?;
        Ok(row.and_then(|(json,)| serde_json::from_str(&json).ok()))
    }

    pub async fn delete_metadata(&self, key: &str) -> Result<(), StoreError> {
        sqlx::query("DELETE FROM runtime_metadata WHERE key = ?1")
            .bind(key)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn whole_machine_maintenance_lock(
        &self,
    ) -> Result<Option<WholeMachineMaintenanceLock>, StoreError> {
        self.get_metadata(WHOLE_MACHINE_MAINTENANCE_LOCK_KEY).await
    }

    pub async fn record_whole_machine_lock_recovery_evidence(
        &self,
        evidence: &WholeMachineMaintenanceLockClearEvidence,
    ) -> Result<(), StoreError> {
        self.put_metadata(WHOLE_MACHINE_LOCK_RECOVERY_EVIDENCE_KEY, evidence)
            .await
    }

    pub async fn whole_machine_lock_recovery_evidence(
        &self,
    ) -> Result<Option<WholeMachineMaintenanceLockClearEvidence>, StoreError> {
        self.get_metadata(WHOLE_MACHINE_LOCK_RECOVERY_EVIDENCE_KEY)
            .await
    }

    pub async fn clear_whole_machine_maintenance_lock_with_audit(
        &self,
        audit: &WholeMachineMaintenanceLockClearAudit,
    ) -> Result<(), StoreError> {
        let recovery_evidence_json = serde_json::to_string(&audit.recovery_evidence)?;
        let previous_lock_json = serde_json::to_string(&audit.previous)?;
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            "INSERT INTO whole_machine_lock_clear_audit_events(
               id,operator_note,previous_lock_json,recovery_evidence_json,created_at
             )
             VALUES (?1,?2,?3,?4,?5)",
        )
        .bind(&audit.id)
        .bind(&audit.operator_note)
        .bind(previous_lock_json)
        .bind(recovery_evidence_json)
        .bind(&audit.cleared_at)
        .execute(tx.as_mut())
        .await?;
        sqlx::query("DELETE FROM runtime_metadata WHERE key = ?1")
            .bind(WHOLE_MACHINE_MAINTENANCE_LOCK_KEY)
            .execute(tx.as_mut())
            .await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn whole_machine_lock_clear_audit(
        &self,
    ) -> Result<Option<WholeMachineMaintenanceLockClearAudit>, StoreError> {
        let mut records = self.whole_machine_lock_clear_audits().await?;
        Ok(records.pop())
    }

    pub async fn whole_machine_lock_clear_audits(
        &self,
    ) -> Result<Vec<WholeMachineMaintenanceLockClearAudit>, StoreError> {
        let rows: Vec<(String, String, String, String, String)> = sqlx::query_as(
            "SELECT id,operator_note,previous_lock_json,recovery_evidence_json,created_at
             FROM whole_machine_lock_clear_audit_events
             ORDER BY created_at ASC, id ASC",
        )
        .fetch_all(&self.pool)
        .await?;

        let mut audits = Vec::with_capacity(rows.len());
        for (id, operator_note, previous_lock_json, recovery_evidence_json, cleared_at) in rows {
            audits.push(WholeMachineMaintenanceLockClearAudit {
                id,
                operator_note,
                cleared_at,
                previous: serde_json::from_str(&previous_lock_json)?,
                recovery_evidence: serde_json::from_str(&recovery_evidence_json)?,
            });
        }
        Ok(audits)
    }

    pub async fn record_whole_machine_hardware_fault_lock(
        &self,
        source: &str,
        message: &str,
        error_code: Option<&str>,
    ) -> Result<(), StoreError> {
        self.put_metadata(
            WHOLE_MACHINE_MAINTENANCE_LOCK_KEY,
            &WholeMachineMaintenanceLock {
                code: "WHOLE_MACHINE_HARDWARE_FAULT".to_string(),
                message: if message.trim().is_empty() {
                    "lower controller hardware fault requires operator reset".to_string()
                } else {
                    message.to_string()
                },
                source: source.to_string(),
                order_no: String::new(),
                command_no: String::new(),
                slot_code: String::new(),
                error_code: error_code.map(ToString::to_string),
                created_at: now_iso(),
            },
        )
        .await
    }

    pub async fn acquire_runtime_lock(&self, owner_pid: u32) -> Result<(), StoreError> {
        match sqlx::query(
            "INSERT INTO runtime_locks(lock_name,owner_pid,acquired_at,heartbeat_at)
             VALUES ('daemon',?1,?2,?3)",
        )
        .bind(i64::from(owner_pid))
        .bind(now_iso())
        .bind(now_iso())
        .execute(&self.pool)
        .await
        {
            Ok(_) => Ok(()),
            Err(error) => {
                if is_unique_constraint_violation(&error) {
                    Err(StoreError::RuntimeLockHeld)
                } else {
                    Err(StoreError::Sqlx(error))
                }
            }
        }
    }

    pub async fn upsert_command_received(
        &self,
        command: &DispenseCommandPayload,
    ) -> Result<CommandLogRecord, StoreError> {
        let command_json = serde_json::to_string(command)?;
        let expires_at = now_iso_days(COMMAND_LOG_TTL_DAYS);
        sqlx::query(
            "INSERT INTO command_log(command_no,order_no,command_payload_json,status,updated_at,expires_at)
             VALUES (?1,?2,?3,'received',?4,?5)
             ON CONFLICT(command_no) DO NOTHING",
        )
        .bind(&command.command_no)
        .bind(&command.order_no)
        .bind(command_json)
        .bind(now_iso())
        .bind(expires_at)
        .execute(&self.pool)
        .await?;

        self.get_command(&command.command_no)
            .await?
            .ok_or_else(|| StoreError::Sqlx(sqlx::Error::RowNotFound))
    }

    pub async fn get_command(
        &self,
        command_no: &str,
    ) -> Result<Option<CommandLogRecord>, StoreError> {
        let row: Option<CommandRecordRow> = sqlx::query_as(
            "SELECT command_no, order_no, command_payload_json, status, ack_at, dispensing_started_at, result_payload_json, error_code, error_message, updated_at, expires_at
             FROM command_log WHERE command_no = ?1",
        )
        .bind(command_no)
        .fetch_optional(&self.pool)
        .await?;

        row.map(to_command_record).transpose()
    }

    pub async fn record_destructive_command_received(
        &self,
        message_id: &str,
        command_type: &str,
        payload_json: &serde_json::Value,
        issued_at: &str,
    ) -> Result<DestructiveCommandRecord, StoreError> {
        let payload_text = serde_json::to_string(payload_json)?;
        sqlx::query(
            "INSERT INTO destructive_command_log(message_id,command_type,payload_json,issued_at,status,updated_at,expires_at)
             VALUES (?1,?2,?3,?4,'received',?5,?6)
             ON CONFLICT(message_id) DO NOTHING",
        )
        .bind(message_id)
        .bind(command_type)
        .bind(&payload_text)
        .bind(issued_at)
        .bind(now_iso())
        .bind(now_iso_days(COMMAND_LOG_TTL_DAYS))
        .execute(&self.pool)
        .await?;
        let record = self
            .destructive_command(message_id)
            .await?
            .ok_or_else(|| StoreError::Sqlx(sqlx::Error::RowNotFound))?;
        if record.command_type != command_type || record.payload_json != *payload_json {
            return Err(StoreError::IntegrityCheckFailed(
                "destructive command message id was reused with different payload".to_string(),
            ));
        }
        Ok(record)
    }

    pub async fn destructive_command(
        &self,
        message_id: &str,
    ) -> Result<Option<DestructiveCommandRecord>, StoreError> {
        let row: Option<(String, String, String, String, String, Option<String>, String, String)> =
            sqlx::query_as(
                "SELECT message_id,command_type,payload_json,issued_at,status,error_message,updated_at,expires_at
                 FROM destructive_command_log WHERE message_id=?1",
            )
            .bind(message_id)
            .fetch_optional(&self.pool)
            .await?;
        row.map(|row| {
            Ok(DestructiveCommandRecord {
                message_id: row.0,
                command_type: row.1,
                payload_json: serde_json::from_str(&row.2)?,
                issued_at: row.3,
                status: row.4,
                error_message: row.5,
                updated_at: row.6,
                expires_at: row.7,
            })
        })
        .transpose()
    }

    pub async fn record_destructive_command_result_tx(
        &self,
        message_id: &str,
        success: bool,
        error_message: Option<&str>,
        result_event: &OutboxInput,
    ) -> Result<(), StoreError> {
        let mut tx = self.pool.begin().await?;
        insert_outbox_in_tx(&mut tx, result_event).await?;
        sqlx::query(
            "UPDATE destructive_command_log
             SET status=?2,error_message=?3,updated_at=?4
             WHERE message_id=?1",
        )
        .bind(message_id)
        .bind(if success { "succeeded" } else { "failed" })
        .bind(error_message)
        .bind(now_iso())
        .execute(tx.as_mut())
        .await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn list_active_unfinished_commands(
        &self,
    ) -> Result<Vec<CommandLogRecord>, StoreError> {
        let rows: Vec<CommandRecordRow> = sqlx::query_as(
            "SELECT command_no, order_no, command_payload_json, status, ack_at, dispensing_started_at, result_payload_json, error_code, error_message, updated_at, expires_at
             FROM command_log
             WHERE status IN ('acknowledged','dispensing') AND result_payload_json IS NULL
             ORDER BY updated_at ASC",
        )
        .fetch_all(&self.pool)
        .await?;

        rows.into_iter().map(to_command_record).collect()
    }

    pub async fn prune_command_log(&self) -> Result<(u64, u64), StoreError> {
        let deleted_expired = sqlx::query("DELETE FROM command_log WHERE expires_at < ?1")
            .bind(now_iso())
            .execute(&self.pool)
            .await?
            .rows_affected();

        let deleted_oversize = sqlx::query(
            "DELETE FROM command_log
             WHERE command_no IN (
               SELECT command_no FROM command_log
               ORDER BY updated_at DESC
               LIMIT -1 OFFSET ?1
             )",
        )
        .bind(COMMAND_LOG_MAX_ENTRIES)
        .execute(&self.pool)
        .await?
        .rows_affected();

        Ok((deleted_expired, deleted_oversize))
    }

    pub async fn record_command_ack_tx(
        &self,
        command: &DispenseCommandPayload,
        ack_event: &OutboxInput,
    ) -> Result<(), StoreError> {
        let mut tx = self.pool.begin().await?;
        upsert_command_received_in_tx(&mut tx, command).await?;
        insert_outbox_in_tx(&mut tx, ack_event).await?;

        sqlx::query(
            "UPDATE command_log
             SET status = 'acknowledged', ack_at=?2, updated_at=?2
             WHERE command_no=?1 AND status IN ('received','acknowledged')",
        )
        .bind(&command.command_no)
        .bind(now_iso())
        .execute(tx.as_mut())
        .await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn mark_command_dispensing(&self, command_no: &str) -> Result<(), StoreError> {
        sqlx::query(
            "UPDATE command_log
             SET status='dispensing', dispensing_started_at=?2, updated_at=?2
             WHERE command_no=?1 AND status='acknowledged'",
        )
        .bind(command_no)
        .bind(now_iso())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn record_dispense_progress(
        &self,
        event: &DispenseProgressEvent,
    ) -> Result<(), StoreError> {
        let row: Option<(Option<String>, String)> = sqlx::query_as(
            "SELECT last_backend_status_json,next_action FROM order_sessions WHERE order_no=?1",
        )
        .bind(&event.order_no)
        .fetch_optional(&self.pool)
        .await?;
        let Some((last_backend_status_json, next_action)) = row else {
            return Ok(());
        };
        if next_action != "dispensing" {
            return Ok(());
        }

        let mut backend_status = last_backend_status_json
            .as_deref()
            .and_then(|value| serde_json::from_str::<serde_json::Value>(value).ok())
            .unwrap_or_else(|| serde_json::json!({}));
        patch_backend_status_for_dispense_progress(&mut backend_status, event);

        sqlx::query(
            "UPDATE order_sessions
             SET last_backend_status_json=?2, updated_at=?3
             WHERE order_no=?1",
        )
        .bind(&event.order_no)
        .bind(backend_status.to_string())
        .bind(now_iso())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn record_command_result_and_enqueue_tx(
        &self,
        command: &DispenseCommandPayload,
        result: &DispenseResultPayload,
        result_event: &OutboxInput,
    ) -> Result<bool, StoreError> {
        let existing = self.get_command(&command.command_no).await?;
        if let Some(existing) = existing.as_ref() {
            if matches!(
                existing.status,
                CommandLogStatus::Succeeded | CommandLogStatus::Failed
            ) && existing.result_payload.is_some()
            {
                return Ok(false);
            }
        }

        let mut tx = self.pool.begin().await?;
        upsert_command_received_in_tx(&mut tx, command).await?;
        insert_outbox_in_tx(&mut tx, result_event).await?;

        let final_status = if result.success {
            CommandLogStatus::Succeeded
        } else {
            CommandLogStatus::Failed
        };
        let result_json = serde_json::to_string(result)?;

        let updated_at = now_iso();
        sqlx::query(
            "UPDATE command_log
             SET status=?2, result_payload_json=?3, error_code=?4, error_message=?5, updated_at=?6
             WHERE command_no=?1",
        )
        .bind(&command.command_no)
        .bind(to_status_string(final_status))
        .bind(result_json)
        .bind(&result.error_code)
        .bind(&result.message)
        .bind(&updated_at)
        .execute(tx.as_mut())
        .await?;

        tx.commit().await?;
        Ok(true)
    }

    pub async fn apply_dispense_result_to_order_session(
        &self,
        command: &DispenseCommandPayload,
        result: &DispenseResultPayload,
    ) -> Result<(), StoreError> {
        let row: Option<(Option<String>,)> =
            sqlx::query_as("SELECT last_backend_status_json FROM order_sessions WHERE order_no=?1")
                .bind(&command.order_no)
                .fetch_optional(&self.pool)
                .await?;
        let Some((last_backend_status_json,)) = row else {
            return Ok(());
        };

        let mut backend_status = last_backend_status_json
            .as_deref()
            .and_then(|value| serde_json::from_str::<serde_json::Value>(value).ok())
            .unwrap_or_else(|| serde_json::json!({}));
        patch_backend_status_for_dispense_result(&mut backend_status, command, result);

        let (status, next_action) = if result.success {
            ("succeeded", "success")
        } else {
            ("failed", "dispense_failed")
        };
        let now = now_iso();
        sqlx::query(
            "UPDATE order_sessions
             SET status=?2, next_action=?3, last_backend_status_json=?4, updated_at=?5
             WHERE order_no=?1",
        )
        .bind(&command.order_no)
        .bind(status)
        .bind(next_action)
        .bind(backend_status.to_string())
        .bind(now)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn save_machine_config_snapshot(
        &self,
        config_json: &serde_json::Value,
        machine_secret_configured: bool,
        mqtt_signing_secret_configured: bool,
        mqtt_password_configured: bool,
    ) -> Result<(), StoreError> {
        sqlx::query(
            "INSERT INTO machine_config(id,config_json,machine_secret_configured,mqtt_signing_secret_configured,mqtt_password_configured,updated_at)
             VALUES (1,?1,?2,?3,?4,?5)
             ON CONFLICT(id) DO UPDATE SET
               config_json=excluded.config_json,
               machine_secret_configured=excluded.machine_secret_configured,
               mqtt_signing_secret_configured=excluded.mqtt_signing_secret_configured,
               mqtt_password_configured=excluded.mqtt_password_configured,
               updated_at=excluded.updated_at",
        )
        .bind(config_json.to_string())
        .bind(i64::from(machine_secret_configured))
        .bind(i64::from(mqtt_signing_secret_configured))
        .bind(i64::from(mqtt_password_configured))
        .bind(now_iso())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn list_due_outbox(
        &self,
        at: chrono::DateTime<Utc>,
    ) -> Result<Vec<OutboxRecord>, StoreError> {
        let rows: Vec<OutboxRecordRow> = sqlx::query_as(
            "SELECT id, kind, transport, topic, target_url, method, payload_json,
                    priority, created_at, next_attempt_at, attempt_count, last_error, expires_at
             FROM outbox_events WHERE next_attempt_at <= ?1 ORDER BY priority ASC, created_at ASC",
        )
        .bind(at.to_rfc3339_opts(SecondsFormat::Millis, true))
        .fetch_all(&self.pool)
        .await?;

        rows.into_iter().map(to_outbox_record).collect()
    }

    pub async fn list_due_stock_movement_uploads(
        &self,
        at: chrono::DateTime<Utc>,
    ) -> Result<Vec<OutboxRecord>, StoreError> {
        let rows: Vec<OutboxRecordRow> = sqlx::query_as(
            "SELECT id, kind, transport, topic, target_url, method, payload_json,
                    priority, created_at, next_attempt_at, attempt_count, last_error, expires_at
             FROM outbox_events
             WHERE kind = 'stock_movement_upload' AND next_attempt_at <= ?1
             ORDER BY priority ASC, created_at ASC",
        )
        .bind(at.to_rfc3339_opts(SecondsFormat::Millis, true))
        .fetch_all(&self.pool)
        .await?;

        rows.into_iter().map(to_outbox_record).collect()
    }

    pub async fn enqueue_outbox(&self, input: &OutboxInput) -> Result<(), StoreError> {
        let mut tx = self.begin_immediate_write_transaction().await?;

        let existing: Option<(i64,)> = sqlx::query_as("SELECT 1 FROM outbox_events WHERE id = ?1")
            .bind(&input.id)
            .fetch_optional(tx.as_mut())
            .await?;
        if existing.is_some() {
            tx.commit().await?;
            return Ok(());
        }

        let total = self.outbox_size_tx(&mut tx).await?;
        if total >= OUTBOX_MAX_EVENTS as u64 {
            let worst: Option<(String, i64)> = sqlx::query_as(
                "SELECT id, priority FROM outbox_events
                     WHERE kind != 'stock_movement_upload'
                       AND (topic IS NULL OR topic NOT LIKE '%/events/secure-decommission-result')
                     ORDER BY priority DESC, created_at ASC LIMIT 1",
            )
            .fetch_optional(tx.as_mut())
            .await?;
            if let Some((worst_id, worst_priority)) = worst {
                if input.priority < worst_priority {
                    sqlx::query("DELETE FROM outbox_events WHERE id = ?1")
                        .bind(worst_id)
                        .execute(tx.as_mut())
                        .await?;
                } else {
                    tx.commit().await?;
                    return Err(StoreError::OutboxCapacity);
                }
            } else {
                tx.commit().await?;
                return Err(StoreError::OutboxCapacity);
            }
        }

        insert_outbox_in_tx(&mut tx, input).await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn replace_outbox_event(&self, input: &OutboxInput) -> Result<(), StoreError> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("DELETE FROM outbox_events WHERE id=?1")
            .bind(&input.id)
            .execute(tx.as_mut())
            .await?;
        insert_outbox_in_tx(&mut tx, input).await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn outbox_size(&self) -> Result<u64, StoreError> {
        let total: (i64,) = sqlx::query_as("SELECT COUNT(1) FROM outbox_events")
            .fetch_one(&self.pool)
            .await?;
        Ok(total.0.max(0) as u64)
    }

    async fn outbox_size_tx(
        &self,
        tx: &mut Transaction<'_, sqlx::Sqlite>,
    ) -> Result<u64, StoreError> {
        let total: (i64,) = sqlx::query_as("SELECT COUNT(1) FROM outbox_events")
            .fetch_one(tx.as_mut())
            .await?;
        Ok(total.0.max(0) as u64)
    }

    pub async fn remove_outbox_event(&self, id: &str) -> Result<(), StoreError> {
        sqlx::query("DELETE FROM outbox_events WHERE id = ?1")
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Persist the platform acknowledgement before touching external secrets
    /// or configuration. The result outbox deletion and recovery marker share
    /// one SQLite commit, so a crash can only leave the result retryable or
    /// leave a marker that startup recovery can finalize.
    pub async fn acknowledge_secure_decommission_result_tx(
        &self,
        message_id: &str,
        result_outbox_id: &str,
        marker: &SecureDecommissionFinalizeMarker,
    ) -> Result<bool, StoreError> {
        let mut tx = self.begin_immediate_write_transaction().await?;
        let command: Option<(String, String)> = sqlx::query_as(
            "SELECT command_type,status FROM destructive_command_log WHERE message_id=?1",
        )
        .bind(message_id)
        .fetch_optional(tx.as_mut())
        .await?;
        match command {
            Some((command_type, status))
                if command_type == "secure-decommission" && status == "succeeded" => {}
            _ => {
                return Err(StoreError::IntegrityCheckFailed(
                    "secure decommission command is not ready for acknowledgement".to_string(),
                ));
            }
        }
        if marker.message_id != message_id || marker.generation != message_id {
            return Err(StoreError::IntegrityCheckFailed(
                "secure decommission acknowledgement marker does not bind the active command generation".to_string(),
            ));
        }
        let existing: Option<(String,)> =
            sqlx::query_as("SELECT value_json FROM runtime_metadata WHERE key=?1")
                .bind("secure_decommission_platform_acknowledged_command_no")
                .fetch_optional(tx.as_mut())
                .await?;
        if let Some((value_json,)) = existing {
            let recorded: SecureDecommissionFinalizeMarker = serde_json::from_str(&value_json)?;
            if recorded != *marker {
                return Err(StoreError::IntegrityCheckFailed(
                    "secure decommission acknowledgement conflicts with durable marker".to_string(),
                ));
            }
            tx.commit().await?;
            return Ok(false);
        }
        sqlx::query("DELETE FROM outbox_events WHERE id=?1")
            .bind(result_outbox_id)
            .execute(tx.as_mut())
            .await?;
        sqlx::query("INSERT INTO runtime_metadata(key,value_json,updated_at) VALUES (?1,?2,?3)")
            .bind("secure_decommission_platform_acknowledged_command_no")
            .bind(serde_json::to_string(marker)?)
            .bind(now_iso())
            .execute(tx.as_mut())
            .await?;
        tx.commit().await?;
        Ok(true)
    }

    /// Remove the matched finalization generation as one SQLite commit. External
    /// secret/profile cleanup happens before this point; a crash can therefore
    /// only leave both markers for idempotent recovery or neither marker.
    pub async fn clear_secure_decommission_finalization_markers_tx(
        &self,
        marker: &SecureDecommissionFinalizeMarker,
    ) -> Result<(), StoreError> {
        let mut tx = self.begin_immediate_write_transaction().await?;
        for key in [
            "secure_decommission_pending_finalize",
            "secure_decommission_platform_acknowledged_command_no",
        ] {
            let value: Option<(String,)> =
                sqlx::query_as("SELECT value_json FROM runtime_metadata WHERE key=?1")
                    .bind(key)
                    .fetch_optional(tx.as_mut())
                    .await?;
            let Some((value_json,)) = value else {
                return Err(StoreError::IntegrityCheckFailed(format!(
                    "secure decommission finalization marker is missing: {key}"
                )));
            };
            let recorded: SecureDecommissionFinalizeMarker = serde_json::from_str(&value_json)?;
            if recorded != *marker {
                return Err(StoreError::IntegrityCheckFailed(format!(
                    "secure decommission finalization marker does not match active generation: {key}"
                )));
            }
        }
        sqlx::query(
            "DELETE FROM runtime_metadata WHERE key IN ('secure_decommission_pending_finalize','secure_decommission_platform_acknowledged_command_no')",
        )
        .execute(tx.as_mut())
        .await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn mark_outbox_failed(&self, id: &str, error: &str) -> Result<(), StoreError> {
        let mut tx = self.pool.begin().await?;
        mark_outbox_failed_in_tx(&mut tx, id, error).await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn mark_stock_movement_upload_failed(
        &self,
        event_id: &str,
        movement_id: &str,
        error: &str,
    ) -> Result<(), StoreError> {
        let mut tx = self.pool.begin().await?;
        let attempt_count = mark_outbox_failed_in_tx(&mut tx, event_id, error).await?;
        let sync_result = sqlx::query(
            "UPDATE stock_movement_sync
             SET status = 'failed', attempt_count = ?2, last_error = ?3, updated_at = ?4
             WHERE movement_id = ?1",
        )
        .bind(movement_id)
        .bind(attempt_count)
        .bind(error)
        .bind(now_iso())
        .execute(tx.as_mut())
        .await?;
        if sync_result.rows_affected() != 1 {
            return Err(StoreError::Sqlx(sqlx::Error::RowNotFound));
        }
        tx.commit().await?;
        Ok(())
    }

    pub async fn outbox_record(&self, id: &str) -> Result<Option<OutboxRecord>, StoreError> {
        let row: Option<OutboxRecordRow> = sqlx::query_as(
            "SELECT id, kind, transport, topic, target_url, method, payload_json,
                    priority, created_at, next_attempt_at, attempt_count, last_error, expires_at
             FROM outbox_events WHERE id = ?1",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;

        row.map(to_outbox_record).transpose()
    }

    pub async fn upsert_order_session(
        &self,
        input: OrderSessionUpsert<'_>,
    ) -> Result<(), StoreError> {
        let expires_at = order_session_expires_at(&input);
        let next_action = parse_new_checkout_flow_action(input.next_action)?;
        let last_backend_status_json = input
            .last_backend_status_json
            .as_ref()
            .map(|value| validate_new_backend_status_checkout_flow_action(value.clone()))
            .transpose()?;
        sqlx::query(
            "INSERT INTO order_sessions(order_no,payment_method,payment_provider,payment_attempt_json,items_json,status,next_action,expires_at,last_backend_status_json,last_error,recovery_strategy,updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
             ON CONFLICT(order_no) DO UPDATE SET
               payment_method = excluded.payment_method,
               payment_provider = excluded.payment_provider,
               payment_attempt_json = COALESCE(excluded.payment_attempt_json, order_sessions.payment_attempt_json),
               items_json = excluded.items_json,
               status = excluded.status,
               next_action = excluded.next_action,
               expires_at = excluded.expires_at,
               last_backend_status_json = excluded.last_backend_status_json,
               last_error = excluded.last_error,
               recovery_strategy = excluded.recovery_strategy,
               updated_at = excluded.updated_at",
        )
        .bind(input.order_no)
        .bind(input.payment_method)
        .bind(input.payment_provider)
        .bind(input.payment_attempt_json.as_ref().map(|value| value.to_string()))
        .bind(input.items_json.to_string())
        .bind(input.status)
        .bind(next_action)
        .bind(expires_at)
        .bind(last_backend_status_json.as_ref().map(|value| value.to_string()))
        .bind(input.last_error)
        .bind(input.recovery_strategy)
        .bind(now_iso())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn apply_backend_order_status(
        &self,
        order_no: &str,
        backend_status_json: serde_json::Value,
    ) -> Result<(), StoreError> {
        let row: Option<OrderSessionRecordRow> = sqlx::query_as(
            "SELECT order_no,payment_method,payment_provider,payment_attempt_json,items_json,status,next_action,expires_at,last_backend_status_json,last_error,recovery_strategy,updated_at
             FROM order_sessions
             WHERE order_no = ?1",
        )
        .bind(order_no)
        .fetch_optional(&self.pool)
        .await?;
        let Some(row) = row else {
            return Ok(());
        };
        let record = to_order_session_record(row);
        let items_json = serde_json::from_str::<serde_json::Value>(&record.items_json)?;
        let payment_method = backend_status_json
            .pointer("/payment/method")
            .and_then(|value| value.as_str())
            .unwrap_or(record.payment_method.as_str())
            .to_string();
        let payment_provider = backend_status_json
            .pointer("/payment/providerCode")
            .and_then(|value| value.as_str())
            .map(ToString::to_string)
            .or(record.payment_provider);
        let status = backend_status_json
            .get("orderStatus")
            .and_then(|value| value.as_str())
            .unwrap_or(record.status.as_str())
            .to_string();
        let next_action = backend_status_json
            .get("nextAction")
            .and_then(|value| value.as_str())
            .unwrap_or(record.next_action.as_str())
            .to_string();
        let payment_attempt_json = merge_backend_payment_code_attempt(
            record.payment_attempt_json.as_deref(),
            backend_status_json.get("paymentCodeAttempt"),
        )?;

        let merged_backend_status = merge_local_dispense_progress(
            record.last_backend_status_json.as_deref(),
            backend_status_json,
        );

        self.upsert_order_session(OrderSessionUpsert {
            order_no,
            payment_method: &payment_method,
            payment_provider: payment_provider.as_deref(),
            items_json,
            status: &status,
            next_action: &next_action,
            payment_attempt_json,
            recovery_strategy: record.recovery_strategy.as_str(),
            last_backend_status_json: Some(merged_backend_status),
            last_error: None,
        })
        .await
    }

    pub async fn current_order_session_snapshot(
        &self,
    ) -> Result<Option<vending_core::domain::InternalTransactionSnapshot>, StoreError> {
        let row: Option<CurrentOrderSessionRow> = sqlx::query_as(
            "SELECT order_no, status, next_action, updated_at
                 FROM order_sessions
                 WHERE status != 'closed'
                 ORDER BY updated_at DESC, rowid DESC
                 LIMIT 1",
        )
        .fetch_optional(&self.pool)
        .await?;

        Ok(row.map(|(order_no, status, next_action, updated_at)| {
            let status = status.and_then(|value| parse_order_status(&value)).or(Some(
                vending_core::domain::OrderSessionStatus::WaitingPayment,
            ));
            vending_core::domain::InternalTransactionSnapshot {
                order_no,
                status,
                next_action: next_action
                    .filter(|value| !value.is_empty())
                    .and_then(|value| InternalCheckoutFlowAction::normalize_recovered(&value)),
                updated_at,
            }
        }))
    }

    pub async fn current_order_session_record(
        &self,
    ) -> Result<Option<OrderSessionRecord>, StoreError> {
        let row: Option<OrderSessionRecordRow> = sqlx::query_as(
            "SELECT order_no,payment_method,payment_provider,payment_attempt_json,items_json,status,next_action,expires_at,last_backend_status_json,last_error,recovery_strategy,updated_at
             FROM order_sessions
             WHERE status != 'closed'
             ORDER BY updated_at DESC, rowid DESC
             LIMIT 1",
        )
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(to_order_session_record))
    }

    pub async fn current_transaction_snapshot(
        &self,
    ) -> Result<Option<vending_core::domain::InternalCurrentTransactionSnapshot>, StoreError> {
        let Some(row) = self.current_order_session_record().await? else {
            return Ok(None);
        };
        Ok(Some(to_current_transaction_snapshot(row)?))
    }

    pub async fn begin_payment_code_attempt(
        &self,
        order_no: &str,
        masked_auth_code: &str,
        source: &str,
        scanned_at_ms: u128,
        scanner_health: Option<&vending_core::scanner::ScannerHealthSnapshot>,
    ) -> Result<String, StoreError> {
        let mut history = Vec::new();
        if let Some(existing) = self.load_attempt_json(order_no).await? {
            let status = existing.get("status").and_then(|value| value.as_str());
            let can_retry = existing
                .get("canRetry")
                .and_then(|value| value.as_bool())
                .unwrap_or(false);
            if matches!(
                status,
                Some("submitting" | "user_confirming" | "querying" | "processing")
            ) {
                return Err(StoreError::ActivePaymentCodeAttempt);
            }
            if matches!(status, Some("failed" | "manual_handling" | "unknown")) && !can_retry {
                return Err(StoreError::ActivePaymentCodeAttempt);
            }

            if let Some(existing_history) =
                existing.get("history").and_then(|value| value.as_array())
            {
                history.extend(existing_history.iter().cloned());
            }
            if existing.get("maskedAuthCode").is_some() {
                history.push(serde_json::Value::Object(existing));
            }
        }

        let idempotency_key = format!("{}:{}", order_no, Uuid::new_v4().simple());
        let mut payload = serde_json::Map::new();
        payload.insert("attemptNo".to_string(), serde_json::Value::Null);
        payload.insert(
            "idempotencyKey".to_string(),
            serde_json::Value::String(idempotency_key),
        );
        payload.insert(
            "maskedAuthCode".to_string(),
            serde_json::Value::String(masked_auth_code.to_string()),
        );
        payload.insert(
            "source".to_string(),
            serde_json::Value::String(source.to_string()),
        );
        payload.insert(
            "status".to_string(),
            serde_json::Value::String("submitting".to_string()),
        );
        payload.insert("canRetry".to_string(), serde_json::Value::Bool(false));
        payload.insert("message".to_string(), serde_json::Value::Null);
        payload.insert(
            "scannedAtMs".to_string(),
            serde_json::Value::from(scanned_at_ms as u64),
        );
        payload.insert(
            "submittedAt".to_string(),
            serde_json::Value::String(now_iso()),
        );
        payload.insert("lastCheckedAt".to_string(), serde_json::Value::Null);
        payload.insert(
            "scannerHealth".to_string(),
            serde_json::to_value(scanner_health)?,
        );
        if !history.is_empty() {
            payload.insert("history".to_string(), serde_json::Value::Array(history));
        }
        let updated = sqlx::query(
            "UPDATE order_sessions
             SET payment_attempt_json = ?2, updated_at = ?3
             WHERE order_no = ?1
               AND (
                 payment_attempt_json IS NULL
                 OR COALESCE(json_extract(payment_attempt_json, '$.status'), '') NOT IN ('submitting', 'user_confirming', 'querying', 'processing')
               )
               AND NOT (
                 COALESCE(json_extract(payment_attempt_json, '$.status'), '') IN ('failed', 'manual_handling', 'unknown')
                 AND COALESCE(json_extract(payment_attempt_json, '$.canRetry'), 0) = 0
               )",
        )
        .bind(order_no)
        .bind(serde_json::Value::Object(payload.clone()).to_string())
        .bind(now_iso())
        .execute(&self.pool)
        .await?
        .rows_affected();
        if updated != 1 {
            return Err(StoreError::ActivePaymentCodeAttempt);
        }
        Ok(payload
            .get("idempotencyKey")
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .to_string())
    }

    pub async fn finish_payment_code_attempt(
        &self,
        order_no: &str,
        status: &str,
        can_retry: bool,
        message: Option<&str>,
    ) -> Result<(), StoreError> {
        let mut data = self.load_attempt_json(order_no).await?.unwrap_or_default();
        data.insert(
            "status".to_string(),
            serde_json::Value::String(status.to_string()),
        );
        data.insert("canRetry".to_string(), serde_json::Value::Bool(can_retry));
        data.insert(
            "message".to_string(),
            message.map_or(serde_json::Value::Null, |value| {
                serde_json::Value::String(value.to_string())
            }),
        );
        data.insert(
            "lastCheckedAt".to_string(),
            serde_json::Value::String(now_iso()),
        );
        sqlx::query("UPDATE order_sessions SET payment_attempt_json = ?2, updated_at = ?3 WHERE order_no = ?1")
            .bind(order_no)
            .bind(serde_json::Value::Object(data).to_string())
            .bind(now_iso())
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn get_or_create_payment_attempt_key(
        &self,
        order_no: &str,
    ) -> Result<String, StoreError> {
        let existing = sqlx::query_as::<_, (Option<String>,)>(
            "SELECT payment_attempt_json FROM order_sessions WHERE order_no = ?1",
        )
        .bind(order_no)
        .fetch_optional(&self.pool)
        .await?;

        if let Some((json,)) = existing {
            if let Some(json) = json {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&json) {
                    if let Some(value) = value.get("idempotencyKey").and_then(|v| v.as_str()) {
                        return Ok(value.to_string());
                    }
                }
            }
            let mut value = self
                .load_attempt_json(order_no)
                .await?
                .unwrap_or_else(serde_json::Map::new);
            if let Some(key) = value.get("idempotencyKey").and_then(|v| v.as_str()) {
                return Ok(key.to_string());
            }
            let idempotency_key = format!("{}:{}", order_no, Uuid::new_v4().simple());
            value.insert(
                "idempotencyKey".to_string(),
                serde_json::Value::String(idempotency_key.clone()),
            );
            sqlx::query("UPDATE order_sessions SET payment_attempt_json=?2, updated_at=?3 WHERE order_no=?1")
                .bind(order_no)
                .bind(serde_json::Value::Object(value).to_string())
                .bind(now_iso())
                .execute(&self.pool)
                .await?;
            return Ok(idempotency_key);
        }

        let idempotency_key = format!("{}:{}", order_no, Uuid::new_v4().simple());
        let payload = serde_json::json!({
            "idempotencyKey": idempotency_key.clone(),
            "maskedAuthCode": null,
            "source": "daemon",
        });

        sqlx::query(
            "INSERT INTO order_sessions(
                order_no,payment_method,payment_provider,payment_attempt_json,items_json,status,next_action,expires_at,recovery_strategy,updated_at
             ) VALUES (?1,'unknown',NULL,?2,'[]','waiting_payment','wait_payment',?3,'local','')",
        )
        .bind(order_no)
        .bind(payload.to_string())
        .bind(now_iso_days(COMMAND_LOG_TTL_DAYS))
        .bind(now_iso())
        .execute(&self.pool)
        .await?;
        Ok(idempotency_key)
    }

    pub async fn record_payment_attempt_summary(
        &self,
        order_no: &str,
        masked_auth_code: &str,
        source: &str,
        idempotency_key: &str,
    ) -> Result<(), StoreError> {
        let mut data = self.load_attempt_json(order_no).await?.unwrap_or_default();
        data.insert("attemptNo".to_string(), serde_json::Value::Null);
        data.insert(
            "status".to_string(),
            serde_json::Value::String("submitting".to_string()),
        );
        data.insert(
            "maskedAuthCode".to_string(),
            serde_json::Value::String(masked_auth_code.to_string()),
        );
        data.insert(
            "source".to_string(),
            serde_json::Value::String(source.to_string()),
        );
        data.insert(
            "idempotencyKey".to_string(),
            serde_json::Value::String(idempotency_key.to_string()),
        );
        data.insert("canRetry".to_string(), serde_json::Value::Bool(false));
        data.insert("message".to_string(), serde_json::Value::Null);
        data.insert(
            "submittedAt".to_string(),
            serde_json::Value::String(now_iso()),
        );
        data.insert("lastCheckedAt".to_string(), serde_json::Value::Null);

        sqlx::query("UPDATE order_sessions SET payment_attempt_json = ?2, updated_at = ?3 WHERE order_no = ?1")
            .bind(order_no)
            .bind(serde_json::Value::Object(data).to_string())
            .bind(now_iso())
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn apply_planogram(
        &self,
        input: MachinePlanogramInput,
    ) -> Result<SaleViewSnapshot, StoreError> {
        if input.planogram_version.trim().is_empty() || input.slots.is_empty() {
            return Err(StoreError::InvalidStockInput(
                "planogram version and at least one slot are required".to_string(),
            ));
        }
        for slot in &input.slots {
            if slot.capacity < 0 || slot.par_level < 0 || slot.price_cents < 0 {
                return Err(StoreError::InvalidStockInput(
                    "capacity, par level, and price must be nonnegative".to_string(),
                ));
            }
        }

        let rebuilt_after_quarantine = self
            .get_metadata::<bool>(STOCK_LEDGER_REBUILT_AFTER_QUARANTINE_KEY)
            .await?
            .unwrap_or(false);

        let mut tx = self.pool.begin().await?;
        let applied_at = now_iso();
        let previous_slots = current_slot_projections_in_tx(&mut tx).await?;
        let existing: Option<(i64,)> = sqlx::query_as(
            "SELECT active FROM machine_planogram_versions WHERE planogram_version = ?1",
        )
        .bind(&input.planogram_version)
        .fetch_optional(tx.as_mut())
        .await?;

        if let Some((active,)) = existing {
            if !planogram_slots_match_in_tx(&mut tx, &input.planogram_version, &input.slots).await?
            {
                return Err(StoreError::InvalidStockInput(
                    "planogram version already exists with different slot payload".to_string(),
                ));
            }
            if active != 1 {
                return Err(StoreError::InvalidStockInput(
                    "planogram version already exists but is not active".to_string(),
                ));
            }

            sqlx::query(
                "UPDATE machine_planogram_versions
                 SET source = ?2, applied_by = ?3, applied_at = ?4
                 WHERE planogram_version = ?1",
            )
            .bind(&input.planogram_version)
            .bind(&input.source)
            .bind(&input.applied_by)
            .bind(&applied_at)
            .execute(tx.as_mut())
            .await?;
            for slot in &input.slots {
                upsert_sale_view_projection_in_tx(&mut tx, &input.planogram_version, &slot.slot_id)
                    .await?;
            }
            tx.commit().await?;
            return self.sale_view(None).await;
        }

        sqlx::query("UPDATE machine_planogram_versions SET active = 0 WHERE active = 1")
            .execute(tx.as_mut())
            .await?;
        sqlx::query(
            "INSERT INTO machine_planogram_versions(planogram_version,active,source,applied_by,applied_at)
             VALUES (?1,1,?2,?3,?4)",
        )
        .bind(&input.planogram_version)
        .bind(&input.source)
        .bind(&input.applied_by)
        .bind(&applied_at)
        .execute(tx.as_mut())
        .await?;

        for slot in &input.slots {
            sqlx::query(
                "INSERT INTO machine_planogram_slots(
                   planogram_version,slot_id,slot_code,layer_no,cell_no,capacity,par_level,
                   inventory_id,variant_id,product_id,product_name,product_description,cover_image_url,
                   try_on_silhouette_url,category_id,category_name,sku,size,color,price_cents,
                   product_sort_order,target_gender
                 ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22)",
            )
            .bind(&input.planogram_version)
            .bind(&slot.slot_id)
            .bind(&slot.slot_code)
            .bind(slot.layer_no)
            .bind(slot.cell_no)
            .bind(slot.capacity)
            .bind(slot.par_level)
            .bind(&slot.inventory_id)
            .bind(&slot.variant_id)
            .bind(&slot.product_id)
            .bind(&slot.product_name)
            .bind(&slot.product_description)
            .bind(&slot.cover_image_url)
            .bind(&slot.try_on_silhouette_url)
            .bind(&slot.category_id)
            .bind(&slot.category_name)
            .bind(&slot.sku)
            .bind(&slot.size)
            .bind(&slot.color)
            .bind(slot.price_cents)
            .bind(slot.product_sort_order)
            .bind(&slot.target_gender)
            .execute(tx.as_mut())
            .await?;

            if let Some(previous) = previous_slots
                .iter()
                .find(|previous| previous.slot_id == slot.slot_id)
            {
                let saleable_stock = previous.physical_stock.min(slot.capacity).max(0);
                if previous.has_sale_safety_blocker()
                    && is_reconciliation_sale_safety_blocker(&previous.slot_sales_state)
                {
                    upsert_stock_projection_with_state_in_tx(
                        &mut tx,
                        &input.planogram_version,
                        &slot.slot_id,
                        previous.physical_stock,
                        saleable_stock,
                        &previous.slot_sales_state,
                        false,
                    )
                    .await?;
                    upsert_sale_safety_blocker_marker_in_tx(
                        &mut tx,
                        &input.planogram_version,
                        &slot.slot_id,
                        &previous.slot_sales_state,
                        "planogram_activation_replay",
                        &input.source,
                    )
                    .await?;
                } else if previous.physical_stock > 0 && !previous.has_same_mapping(slot) {
                    upsert_stock_projection_with_state_in_tx(
                        &mut tx,
                        &input.planogram_version,
                        &slot.slot_id,
                        previous.physical_stock,
                        0,
                        "blocked_for_planogram_change",
                        false,
                    )
                    .await?;
                } else {
                    let slot_sales_state =
                        if matches!(previous.slot_sales_state.as_str(), "frozen" | "suspect") {
                            previous.slot_sales_state.as_str()
                        } else if saleable_stock > 0 {
                            "sale_ready"
                        } else {
                            "sold_out"
                        };
                    upsert_stock_projection_with_state_in_tx(
                        &mut tx,
                        &input.planogram_version,
                        &slot.slot_id,
                        previous.physical_stock,
                        saleable_stock,
                        slot_sales_state,
                        false,
                    )
                    .await?;
                }
            } else if rebuilt_after_quarantine {
                upsert_stock_projection_with_state_in_tx(
                    &mut tx,
                    &input.planogram_version,
                    &slot.slot_id,
                    0,
                    0,
                    "needs_count",
                    false,
                )
                .await?;
                upsert_sale_safety_blocker_marker_in_tx(
                    &mut tx,
                    &input.planogram_version,
                    &slot.slot_id,
                    "needs_count",
                    "stock_ledger_loss",
                    &input.source,
                )
                .await?;
            } else {
                upsert_stock_projection_with_state_in_tx(
                    &mut tx,
                    &input.planogram_version,
                    &slot.slot_id,
                    0,
                    0,
                    "needs_count",
                    false,
                )
                .await?;
            }
            upsert_sale_view_projection_in_tx(&mut tx, &input.planogram_version, &slot.slot_id)
                .await?;
        }
        tx.commit().await?;
        self.sale_view(None).await
    }

    pub async fn stock_maintenance_task(&self) -> Result<StockMaintenanceTask, StoreError> {
        let active: Option<(String,)> = sqlx::query_as(
            "SELECT planogram_version FROM machine_planogram_versions WHERE active = 1 LIMIT 1",
        )
        .fetch_optional(&self.pool)
        .await?;
        let Some((planogram_version,)) = active else {
            return Err(StoreError::InvalidStockInput(
                "active acknowledged planogram is required for stock maintenance".to_string(),
            ));
        };
        self.finalize_pending_physical_stock_attestation_if_accepted()
            .await?;
        let pending_attestation = self
            .get_metadata::<PendingPhysicalStockAttestation>(PENDING_PHYSICAL_STOCK_ATTESTATION_KEY)
            .await?;
        let established_attestation = self
            .get_metadata::<StoredPhysicalStockAttestation>(PHYSICAL_STOCK_ATTESTATION_KEY)
            .await?;
        let (mode, task_id) = if established_attestation
            .as_ref()
            .is_some_and(|stored| stored.planogram_version == planogram_version)
        {
            (
                "routine_refill".to_string(),
                self.current_refill_task_id(&planogram_version).await?,
            )
        } else {
            let rebuilt = self
                .get_metadata::<bool>(STOCK_LEDGER_REBUILT_AFTER_QUARANTINE_KEY)
                .await?
                .unwrap_or(false);
            (
                if rebuilt {
                    "recovery_count".to_string()
                } else {
                    "initial_count".to_string()
                },
                self.current_count_task_id(&planogram_version, pending_attestation.as_ref())
                    .await?,
            )
        };

        let rows = sqlx::query(
            "SELECT s.slot_id,s.slot_code,s.layer_no,s.cell_no,s.product_name,s.sku,s.capacity,
                    COALESCE(c.physical_stock,0) AS current_quantity,
                    COALESCE(c.slot_sales_state,'needs_count') AS sales_state
             FROM machine_planogram_slots s
             JOIN machine_planogram_versions v
               ON v.planogram_version=s.planogram_version AND v.active=1
             LEFT JOIN current_stock_projection c
               ON c.planogram_version=s.planogram_version AND c.slot_id=s.slot_id
             WHERE s.planogram_version=?1
             ORDER BY s.layer_no,s.cell_no",
        )
        .bind(&planogram_version)
        .fetch_all(&self.pool)
        .await?;
        let refill_batch = if mode == "routine_refill" {
            let stored: Option<(String, String)> = sqlx::query_as(
                "SELECT payload_json,capacity_snapshot_json FROM stock_maintenance_batches
                 WHERE task_id=?1",
            )
            .bind(&task_id)
            .fetch_optional(&self.pool)
            .await?;
            stored
                .map(|(payload, capacity)| {
                    Ok::<_, StoreError>((
                        serde_json::from_str::<NormalizedStockMaintenanceRefillBatch>(&payload)?,
                        serde_json::from_str::<Vec<StockMaintenanceRefillCapacitySnapshot>>(
                            &capacity,
                        )?,
                    ))
                })
                .transpose()?
        } else {
            None
        };
        let mut slots = Vec::with_capacity(rows.len());
        for row in rows {
            let slot_id: String = row.try_get("slot_id")?;
            let slot_code: String = row.try_get("slot_code")?;
            let submitted_quantity = pending_attestation.as_ref().and_then(|pending| {
                pending
                    .input
                    .slots
                    .iter()
                    .find(|slot| slot.slot_id == slot_id)
                    .map(|slot| slot.quantity)
            });
            let movement_id = pending_attestation
                .as_ref()
                .and_then(|pending| {
                    pending
                        .slot_generations
                        .iter()
                        .find(|generation| generation.slot_id == slot_id)
                        .map(|generation| generation.movement_id.clone())
                })
                .unwrap_or_else(|| format!("{task_id}:{slot_id}"));
            let sync: Option<(String, Option<String>)> = sqlx::query_as(
                "SELECT status,rejection_json FROM stock_movement_sync WHERE movement_id=?1",
            )
            .bind(&movement_id)
            .fetch_optional(&self.pool)
            .await?;
            let (sync_status, reconciliation_reason) = match sync {
                Some((status, rejection)) => {
                    let reason = rejection.as_deref().and_then(stock_reconciliation_reason);
                    (status, reason)
                }
                None => ("not_submitted".to_string(), None),
            };
            let submitted_addition = refill_batch.as_ref().and_then(|(batch, _)| {
                batch
                    .slots
                    .iter()
                    .find(|slot| slot.slot_code == slot_code)
                    .map(|slot| slot.addition)
            });
            let preview_quantity = refill_batch.as_ref().and_then(|(_, snapshots)| {
                snapshots
                    .iter()
                    .find(|snapshot| snapshot.slot_id == slot_id)
                    .map(|snapshot| snapshot.after_quantity)
            });
            slots.push(StockMaintenanceTaskSlot {
                slot_code,
                layer_no: row.try_get("layer_no")?,
                cell_no: row.try_get("cell_no")?,
                product_name: row.try_get("product_name")?,
                sku: row.try_get("sku")?,
                capacity: row.try_get("capacity")?,
                current_quantity: row.try_get("current_quantity")?,
                submitted_quantity,
                submitted_addition,
                preview_quantity,
                sync_status,
                sales_state: row.try_get("sales_state")?,
                reconciliation_reason,
            });
        }
        let status = if slots
            .iter()
            .any(|slot| matches!(slot.sync_status.as_str(), "rejected" | "reconciliation"))
        {
            "reconciliation"
        } else if slots
            .iter()
            .any(|slot| matches!(slot.sync_status.as_str(), "pending" | "failed"))
        {
            "pending"
        } else if !slots.is_empty() && slots.iter().all(|slot| slot.sync_status == "accepted") {
            "complete"
        } else {
            "ready"
        };
        Ok(StockMaintenanceTask {
            task_id,
            mode,
            status: status.to_string(),
            slots,
        })
    }

    async fn stock_maintenance_task_identity_snapshot(
        &self,
        planogram_version: &str,
        mode: &str,
    ) -> Result<(String, Vec<StockMaintenanceTaskIdentitySlot>), StoreError> {
        let rows: Vec<(String, String, String, i64, String, String)> = sqlx::query_as(
            "SELECT slot_id,slot_code,sku,capacity,inventory_id,variant_id
             FROM machine_planogram_slots WHERE planogram_version=?1
             ORDER BY layer_no,cell_no,slot_id",
        )
        .bind(planogram_version)
        .fetch_all(&self.pool)
        .await?;
        let slots = rows
            .into_iter()
            .map(
                |(slot_id, slot_code, sku, capacity, inventory_id, variant_id)| {
                    StockMaintenanceTaskIdentitySlot {
                        slot_id,
                        slot_code,
                        sku,
                        capacity,
                        inventory_id,
                        variant_id,
                    }
                },
            )
            .collect::<Vec<_>>();
        let revision = stock_maintenance_planogram_revision(planogram_version, mode, &slots)?;
        Ok((revision, slots))
    }

    async fn stock_maintenance_task_identity(
        &self,
        task: &StockMaintenanceTask,
    ) -> Result<StockMaintenanceTaskIdentity, StoreError> {
        let key = if task.mode == "routine_refill" {
            STOCK_MAINTENANCE_REFILL_TASK_KEY
        } else {
            STOCK_MAINTENANCE_COUNT_TASK_KEY
        };
        self.get_metadata::<StockMaintenanceTaskIdentity>(key)
            .await?
            .filter(|identity| identity.task_id == task.task_id && identity.mode == task.mode)
            .ok_or_else(|| {
                StoreError::InvalidStockInput(
                    "stock maintenance task identity is stale; refresh the task".to_string(),
                )
            })
    }

    async fn remember_stock_maintenance_task_identity(
        &self,
        identity: &StockMaintenanceTaskIdentity,
    ) -> Result<(), StoreError> {
        sqlx::query(
            "INSERT INTO stock_maintenance_task_identities(task_id,identity_json,created_at)
             VALUES (?1,?2,?3) ON CONFLICT(task_id) DO NOTHING",
        )
        .bind(&identity.task_id)
        .bind(serde_json::to_string(identity)?)
        .bind(now_iso())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn stock_maintenance_task_identity_by_id(
        &self,
        task_id: &str,
    ) -> Result<Option<StockMaintenanceTaskIdentity>, StoreError> {
        let stored: Option<(String,)> = sqlx::query_as(
            "SELECT identity_json FROM stock_maintenance_task_identities WHERE task_id=?1",
        )
        .bind(task_id)
        .fetch_optional(&self.pool)
        .await?;
        stored
            .map(|(value,)| serde_json::from_str(&value).map_err(StoreError::Json))
            .transpose()
    }

    async fn stock_maintenance_identity_differences_in_tx(
        tx: &mut Transaction<'static, Sqlite>,
        identity: &StockMaintenanceTaskIdentity,
    ) -> Result<Vec<StockMaintenanceSlotDifference>, StoreError> {
        let active: Option<(String,)> = sqlx::query_as(
            "SELECT planogram_version FROM machine_planogram_versions WHERE active=1 LIMIT 1",
        )
        .fetch_optional(tx.as_mut())
        .await?;
        let active_version = active.map(|(version,)| version);
        let rows: Vec<(String, String, String, i64, String, String)> = sqlx::query_as(
            "SELECT slot_id,slot_code,sku,capacity,inventory_id,variant_id
             FROM machine_planogram_slots WHERE planogram_version=?1
             ORDER BY layer_no,cell_no,slot_id",
        )
        .bind(active_version.as_deref().unwrap_or_default())
        .fetch_all(tx.as_mut())
        .await?;
        let current_slots = rows
            .into_iter()
            .map(
                |(slot_id, slot_code, sku, capacity, inventory_id, variant_id)| {
                    StockMaintenanceTaskIdentitySlot {
                        slot_id,
                        slot_code,
                        sku,
                        capacity,
                        inventory_id,
                        variant_id,
                    }
                },
            )
            .collect::<Vec<_>>();

        let mut slot_codes = identity
            .slots
            .iter()
            .chain(&current_slots)
            .map(|slot| slot.slot_code.clone())
            .collect::<HashSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        slot_codes.sort();
        let mut differences = Vec::new();
        for slot_code in slot_codes {
            let old_slots = identity
                .slots
                .iter()
                .filter(|slot| slot.slot_code == slot_code)
                .cloned()
                .collect::<Vec<_>>();
            let matching_current_slots = current_slots
                .iter()
                .filter(|slot| slot.slot_code == slot_code)
                .cloned()
                .collect::<Vec<_>>();
            let mut changes = Vec::new();
            if old_slots.len() > 1 || matching_current_slots.len() > 1 {
                changes.push("mapping_ambiguity".to_string());
            } else {
                match (old_slots.first(), matching_current_slots.first()) {
                    (None, Some(_)) => changes.push("slot_added".to_string()),
                    (Some(_), None) => changes.push("slot_removed".to_string()),
                    (Some(old), Some(current)) => {
                        if old.slot_id != current.slot_id {
                            changes.push("slot_removed".to_string());
                            changes.push("slot_added".to_string());
                        }
                        if old.inventory_id != current.inventory_id
                            || old.variant_id != current.variant_id
                        {
                            changes.push("mapping_changed".to_string());
                        }
                        if old.sku != current.sku {
                            changes.push("sku_changed".to_string());
                        }
                        if old.capacity != current.capacity {
                            changes.push("capacity_changed".to_string());
                        }
                    }
                    (None, None) => {}
                }
            }
            if !changes.is_empty() {
                differences.push(StockMaintenanceSlotDifference {
                    slot_code,
                    changes,
                    old_slots,
                    current_slots: matching_current_slots,
                    current_planogram_version: active_version.clone(),
                });
            }
        }

        let current_revision = active_version
            .as_deref()
            .map(|version| {
                stock_maintenance_planogram_revision(version, &identity.mode, &current_slots)
            })
            .transpose()?;
        if differences.is_empty()
            && (active_version.as_deref() != Some(identity.planogram_version.as_str())
                || current_revision.as_deref() != Some(identity.planogram_revision.as_str()))
        {
            differences.push(StockMaintenanceSlotDifference {
                slot_code: "*".to_string(),
                changes: vec![if active_version.as_deref()
                    != Some(identity.planogram_version.as_str())
                {
                    "planogram_version_changed".to_string()
                } else {
                    "revision_mismatch".to_string()
                }],
                old_slots: Vec::new(),
                current_slots: Vec::new(),
                current_planogram_version: active_version,
            });
        }
        Ok(differences)
    }

    async fn freeze_stock_identity_differences_in_tx(
        tx: &mut Transaction<'static, Sqlite>,
        identity: &StockMaintenanceTaskIdentity,
        differences: &[StockMaintenanceSlotDifference],
    ) -> Result<(), StoreError> {
        let mut frozen = HashSet::new();
        for difference in differences {
            sqlx::query(
                "INSERT INTO health_events(
                   id,component,level,code,message,context_json,occurred_at,recovered_at
                 ) VALUES (?1,'inventory','error','stale_stock_maintenance_task_slot_diff',?2,?3,?4,NULL)",
            )
            .bind(Uuid::new_v4().to_string())
            .bind(format!(
                "stock maintenance task {} changed at slot {}: {}",
                identity.task_id,
                difference.slot_code,
                difference.changes.join(",")
            ))
            .bind(
                serde_json::json!({
                    "taskId": identity.task_id,
                    "mode": identity.mode,
                    "planogramVersion": identity.planogram_version,
                    "planogramRevision": identity.planogram_revision,
                    "difference": difference,
                })
                .to_string(),
            )
            .bind(now_iso())
            .execute(tx.as_mut())
            .await?;
            let Some(planogram_version) = difference.current_planogram_version.as_deref() else {
                continue;
            };
            for slot in &difference.current_slots {
                if !frozen.insert((planogram_version.to_string(), slot.slot_id.clone())) {
                    continue;
                }
                upsert_sale_safety_blocker_marker_in_tx(
                    tx,
                    planogram_version,
                    &slot.slot_id,
                    "needs_platform_review",
                    &difference.changes.join(","),
                    "stock_maintenance_task",
                )
                .await?;
                sqlx::query(
                    "UPDATE current_stock_projection
                     SET saleable_stock=0,slot_sales_state='needs_platform_review',updated_at=?3
                     WHERE planogram_version=?1 AND slot_id=?2",
                )
                .bind(planogram_version)
                .bind(&slot.slot_id)
                .bind(now_iso())
                .execute(tx.as_mut())
                .await?;
                upsert_sale_view_projection_in_tx(tx, planogram_version, &slot.slot_id).await?;
            }
        }
        Ok(())
    }

    async fn current_refill_task_id(&self, planogram_version: &str) -> Result<String, StoreError> {
        let snapshot = self
            .stock_maintenance_task_identity_snapshot(planogram_version, "routine_refill")
            .await?;
        let existing = self
            .get_metadata::<StockMaintenanceTaskIdentity>(STOCK_MAINTENANCE_REFILL_TASK_KEY)
            .await?;
        if let Some(existing) = existing.as_ref() {
            self.remember_stock_maintenance_task_identity(existing)
                .await?;
        }
        if let Some(existing) = existing.filter(|value| {
            value.planogram_version == planogram_version
                && value.planogram_revision == snapshot.0
                && value.slots == snapshot.1
                && value.mode == "routine_refill"
        }) {
            let counts: (i64, i64) = sqlx::query_as(
                "SELECT COUNT(1), SUM(CASE WHEN s.status != 'accepted' THEN 1 ELSE 0 END)
                 FROM stock_movements m
                 JOIN stock_movement_sync s ON s.movement_id=m.movement_id
                 WHERE m.movement_id LIKE ?1",
            )
            .bind(format!("{}:%", existing.task_id))
            .fetch_one(&self.pool)
            .await?;
            if counts.0 == 0 || counts.1 > 0 {
                return Ok(existing.task_id);
            }
        }
        let identity = StockMaintenanceTaskIdentity {
            planogram_version: planogram_version.to_string(),
            planogram_revision: snapshot.0,
            mode: "routine_refill".to_string(),
            slots: snapshot.1,
            task_id: format!("stock-refill:{}", Uuid::new_v4()),
            predecessor_task_id: None,
        };
        self.put_metadata(STOCK_MAINTENANCE_REFILL_TASK_KEY, &identity)
            .await?;
        self.remember_stock_maintenance_task_identity(&identity)
            .await?;
        Ok(identity.task_id)
    }

    async fn current_count_task_id(
        &self,
        planogram_version: &str,
        pending: Option<&PendingPhysicalStockAttestation>,
    ) -> Result<String, StoreError> {
        let mode = if self
            .get_metadata::<bool>(STOCK_LEDGER_REBUILT_AFTER_QUARANTINE_KEY)
            .await?
            .unwrap_or(false)
        {
            "recovery_count"
        } else {
            "initial_count"
        };
        let snapshot = self
            .stock_maintenance_task_identity_snapshot(planogram_version, mode)
            .await?;
        let Some(pending) =
            pending.filter(|value| value.input.planogram_version == planogram_version)
        else {
            let existing = self
                .get_metadata::<StockMaintenanceTaskIdentity>(STOCK_MAINTENANCE_COUNT_TASK_KEY)
                .await?;
            if let Some(existing) = existing.as_ref() {
                self.remember_stock_maintenance_task_identity(existing)
                    .await?;
            }
            if let Some(existing) = existing.filter(|value| {
                value.planogram_version == planogram_version
                    && value.planogram_revision == snapshot.0
                    && value.slots == snapshot.1
                    && value.mode == mode
                    && value.predecessor_task_id.is_none()
            }) {
                return Ok(existing.task_id);
            }
            let identity = StockMaintenanceTaskIdentity {
                planogram_version: planogram_version.to_string(),
                planogram_revision: snapshot.0,
                mode: mode.to_string(),
                slots: snapshot.1,
                task_id: format!("stock-count:{}", Uuid::new_v4()),
                predecessor_task_id: None,
            };
            self.put_metadata(STOCK_MAINTENANCE_COUNT_TASK_KEY, &identity)
                .await?;
            self.remember_stock_maintenance_task_identity(&identity)
                .await?;
            return Ok(identity.task_id);
        };
        let terminal: (i64,) = sqlx::query_as(
            "SELECT COUNT(1) FROM stock_movement_sync
             WHERE movement_id IN (SELECT value FROM json_each(?1))
               AND status IN ('rejected','reconciliation')",
        )
        .bind(serde_json::to_string(&pending.movement_ids)?)
        .fetch_one(&self.pool)
        .await?;
        if terminal.0 == 0 {
            return Ok(pending.input.attestation_id.clone());
        }
        let existing = self
            .get_metadata::<StockMaintenanceTaskIdentity>(STOCK_MAINTENANCE_COUNT_TASK_KEY)
            .await?;
        if let Some(existing) = existing.as_ref() {
            self.remember_stock_maintenance_task_identity(existing)
                .await?;
        }
        if let Some(existing) = existing.filter(|value| {
            value.planogram_version == planogram_version
                && value.planogram_revision == snapshot.0
                && value.slots == snapshot.1
                && value.mode == mode
                && value.predecessor_task_id.as_deref()
                    == Some(pending.input.attestation_id.as_str())
        }) {
            return Ok(existing.task_id);
        }
        let identity = StockMaintenanceTaskIdentity {
            planogram_version: planogram_version.to_string(),
            planogram_revision: snapshot.0,
            mode: mode.to_string(),
            slots: snapshot.1,
            task_id: format!("stock-count:{}", Uuid::new_v4()),
            predecessor_task_id: Some(pending.input.attestation_id.clone()),
        };
        self.put_metadata(STOCK_MAINTENANCE_COUNT_TASK_KEY, &identity)
            .await?;
        self.remember_stock_maintenance_task_identity(&identity)
            .await?;
        Ok(identity.task_id)
    }

    pub async fn submit_stock_maintenance_batch(
        &self,
        input: StockMaintenanceBatchInput,
        operator_id: &str,
        machine_code: &str,
        api_base_url: &str,
    ) -> Result<StockMaintenanceBatchResponse, StoreError> {
        if operator_id.trim().is_empty() || input.slots.is_empty() {
            return Err(StoreError::InvalidStockInput(
                "maintenance session operator and stock task slots are required".to_string(),
            ));
        }
        let task = self.stock_maintenance_task().await?;
        if task.task_id != input.task_id || task.mode != input.mode {
            if self
                .historical_stock_maintenance_batch_matches(&input)
                .await?
            {
                return Ok(StockMaintenanceBatchResponse {
                    task,
                    duplicate: true,
                });
            }
            if self
                .stock_maintenance_task_was_pruned(&input.task_id)
                .await?
            {
                return Err(StoreError::InvalidStockInput(
                    "stock maintenance task expired from retained history; refresh the current task"
                        .to_string(),
                ));
            }
            if let Some(identity) = self
                .stock_maintenance_task_identity_by_id(&input.task_id)
                .await?
            {
                self.freeze_stale_stock_task_identity(&identity).await?;
            } else {
                self.freeze_stale_stock_task_slots(&input.slots).await?;
            }
            return Err(StoreError::InvalidStockInput(
                "stock maintenance task is stale; affected slots require reconciliation"
                    .to_string(),
            ));
        }
        let task_identity = self.stock_maintenance_task_identity(&task).await?;
        let active: (String,) = sqlx::query_as(
            "SELECT planogram_version FROM machine_planogram_versions WHERE active=1 LIMIT 1",
        )
        .fetch_one(&self.pool)
        .await?;
        let planogram_version = active.0;
        let rows: Vec<(String, String, String, i64)> = sqlx::query_as(
            "SELECT slot_id,slot_code,sku,capacity FROM machine_planogram_slots
             WHERE planogram_version=?1 ORDER BY layer_no,cell_no",
        )
        .bind(&planogram_version)
        .fetch_all(&self.pool)
        .await?;
        let by_code: HashMap<&str, &(String, String, String, i64)> =
            rows.iter().map(|row| (row.1.as_str(), row)).collect();
        let mut seen = HashSet::new();
        for slot in &input.slots {
            if !seen.insert(slot.slot_code.as_str())
                || !by_code.contains_key(slot.slot_code.as_str())
            {
                return Err(StoreError::InvalidStockInput(format!(
                    "stock task slot {} is duplicate or not in the active planogram",
                    slot.slot_code
                )));
            }
        }

        if input.mode == "initial_count" || input.mode == "recovery_count" {
            if input.slots.len() != rows.len()
                || input
                    .slots
                    .iter()
                    .any(|slot| slot.quantity.is_none() || slot.addition.is_some())
            {
                return Err(StoreError::InvalidStockInput(
                    "count task must submit one final quantity for every active slot".to_string(),
                ));
            }
            let requested_attestation = PhysicalStockAttestationInput {
                attestation_id: input.task_id,
                planogram_version,
                operator_id: operator_id.to_string(),
                slots: input
                    .slots
                    .iter()
                    .map(|slot| {
                        let row = by_code[slot.slot_code.as_str()];
                        PhysicalStockAttestationSlotInput {
                            slot_id: row.0.clone(),
                            slot_code: row.1.clone(),
                            sku: row.2.clone(),
                            quantity: slot.quantity.unwrap_or_default(),
                            enabled: true,
                        }
                    })
                    .collect(),
            };
            let pending = self
                .get_metadata::<PendingPhysicalStockAttestation>(
                    PENDING_PHYSICAL_STOCK_ATTESTATION_KEY,
                )
                .await?;
            let duplicate = pending.as_ref().is_some_and(|pending| {
                pending.input.attestation_id == requested_attestation.attestation_id
                    && pending.input.planogram_version == requested_attestation.planogram_version
                    && pending.input.slots == requested_attestation.slots
            });
            // A maintenance session may expire between the original response and
            // a retry. Keep the original operator attribution while replaying the
            // daemon-owned task payload idempotently.
            let attestation = pending
                .filter(|_| duplicate)
                .map(|pending| pending.input)
                .unwrap_or(requested_attestation);
            self.stage_physical_stock_attestation_for_platform(
                attestation,
                machine_code,
                api_base_url,
                Some(&task_identity),
            )
            .await?;
            return Ok(StockMaintenanceBatchResponse {
                task: self.stock_maintenance_task().await?,
                duplicate,
            });
        }
        let duplicate = self
            .submit_refill_batch_in_tx(
                &input,
                operator_id,
                machine_code,
                api_base_url,
                &task_identity,
            )
            .await?;
        Ok(StockMaintenanceBatchResponse {
            task: self.stock_maintenance_task().await?,
            duplicate,
        })
    }

    async fn submit_refill_batch_in_tx(
        &self,
        input: &StockMaintenanceBatchInput,
        operator_id: &str,
        machine_code: &str,
        api_base_url: &str,
        identity: &StockMaintenanceTaskIdentity,
    ) -> Result<bool, StoreError> {
        let normalized = normalize_refill_batch(input)?;
        let payload_json = serde_json::to_string(&normalized)?;
        let fingerprint = stock_maintenance_batch_fingerprint(&normalized)?;
        let mut tx = self.begin_immediate_write_transaction().await?;
        let differences =
            Self::stock_maintenance_identity_differences_in_tx(&mut tx, identity).await?;
        if !differences.is_empty() {
            Self::freeze_stock_identity_differences_in_tx(&mut tx, identity, &differences).await?;
            tx.commit().await?;
            return Err(StoreError::InvalidStockInput(
                "stock maintenance task is stale; affected slots require reconciliation"
                    .to_string(),
            ));
        }

        let existing: Option<(String, String)> = sqlx::query_as(
            "SELECT payload_json,payload_fingerprint FROM stock_maintenance_batches
             WHERE task_id=?1",
        )
        .bind(&normalized.task_id)
        .fetch_optional(tx.as_mut())
        .await?;
        if let Some((stored_payload, stored_fingerprint)) = existing {
            if stored_fingerprint == fingerprint && stored_payload == payload_json {
                tx.rollback().await?;
                return Ok(true);
            }
            return Err(StoreError::InvalidStockInput(
                "stock maintenance refill batch is immutable; refresh and use a new task or reconcile the original batch"
                    .to_string(),
            ));
        }

        let rows: Vec<(String, String, String, i64, String, String)> = sqlx::query_as(
            "SELECT slot_id,slot_code,sku,capacity,inventory_id,variant_id
             FROM machine_planogram_slots WHERE planogram_version=?1
             ORDER BY layer_no,cell_no,slot_id",
        )
        .bind(&identity.planogram_version)
        .fetch_all(tx.as_mut())
        .await?;
        let by_code: HashMap<&str, &(String, String, String, i64, String, String)> =
            rows.iter().map(|row| (row.1.as_str(), row)).collect();
        let mut capacity_snapshots = Vec::with_capacity(normalized.slots.len());
        for slot in &normalized.slots {
            let Some(row) = by_code.get(slot.slot_code.as_str()).copied() else {
                return Err(StoreError::InvalidStockInput(format!(
                    "stock task slot {} is not in the active planogram",
                    slot.slot_code
                )));
            };
            let before: Option<(i64,)> = sqlx::query_as(
                "SELECT physical_stock FROM current_stock_projection
                 WHERE planogram_version=?1 AND slot_id=?2",
            )
            .bind(&identity.planogram_version)
            .bind(&row.0)
            .fetch_optional(tx.as_mut())
            .await?;
            let before_quantity = before.map_or(0, |(quantity,)| quantity);
            let after_quantity = before_quantity.checked_add(slot.addition).ok_or_else(|| {
                StoreError::InvalidStockInput("refill quantity overflow".to_string())
            })?;
            if after_quantity > row.3 {
                return Err(StoreError::InvalidStockInput(format!(
                    "refill slot {} exceeds capacity",
                    slot.slot_code
                )));
            }
            capacity_snapshots.push(StockMaintenanceRefillCapacitySnapshot {
                slot_id: row.0.clone(),
                slot_code: row.1.clone(),
                capacity: row.3,
                before_quantity,
                after_quantity,
            });
        }

        sqlx::query(
            "INSERT INTO stock_maintenance_batches(
               task_id,mode,planogram_version,planogram_revision,slot_set_json,
               payload_json,payload_fingerprint,operator_id,capacity_snapshot_json,created_at
             ) VALUES (?1,'routine_refill',?2,?3,?4,?5,?6,?7,?8,?9)",
        )
        .bind(&normalized.task_id)
        .bind(&identity.planogram_version)
        .bind(&identity.planogram_revision)
        .bind(serde_json::to_string(&identity.slots)?)
        .bind(&payload_json)
        .bind(&fingerprint)
        .bind(operator_id)
        .bind(serde_json::to_string(&capacity_snapshots)?)
        .bind(now_iso())
        .execute(tx.as_mut())
        .await?;

        let target_url = format!(
            "{}/machine-stock-movements",
            api_base_url.trim_end_matches('/')
        );
        for (slot, snapshot) in normalized.slots.iter().zip(&capacity_snapshots) {
            let row = by_code[slot.slot_code.as_str()];
            let movement_id = format!("{}:{}", normalized.task_id, row.0);
            let occurred_at = now_iso();
            let slot_mapping_snapshot = serde_json::json!({
                "slotCode": row.1,
                "capacity": snapshot.capacity,
                "inventoryId": row.4,
                "variantId": row.5,
            });
            sqlx::query(
                "INSERT INTO stock_movements(
                   movement_id,planogram_version,slot_id,movement_type,quantity,
                   before_quantity,after_quantity,slot_mapping_snapshot_json,
                   source,attributed_to,occurred_at
                 ) VALUES (?1,?2,?3,'planned_refill',?4,?5,?6,?7,'local_maintenance',?8,?9)",
            )
            .bind(&movement_id)
            .bind(&identity.planogram_version)
            .bind(&row.0)
            .bind(slot.addition)
            .bind(snapshot.before_quantity)
            .bind(snapshot.after_quantity)
            .bind(slot_mapping_snapshot.to_string())
            .bind(operator_id)
            .bind(&occurred_at)
            .execute(tx.as_mut())
            .await?;

            let event = OutboxInput::stock_movement_upload(
                &movement_id,
                target_url.clone(),
                serde_json::json!({
                    "machineCode": machine_code,
                    "movementId": movement_id,
                    "planogramVersion": identity.planogram_version,
                    "slotId": row.0,
                    "movementType": "planned_refill",
                    "quantity": slot.addition,
                    "beforeQuantity": snapshot.before_quantity,
                    "afterQuantity": snapshot.after_quantity,
                    "slotMappingSnapshot": slot_mapping_snapshot,
                    "source": "local_maintenance",
                    "attributedTo": operator_id,
                    "occurredAt": occurred_at,
                }),
            );
            let now = now_iso();
            sqlx::query(
                "INSERT INTO stock_movement_sync(
                   movement_id,status,outbox_event_id,attempt_count,created_at,updated_at
                 ) VALUES (?1,'pending',?2,0,?3,?3)",
            )
            .bind(&movement_id)
            .bind(&event.id)
            .bind(&now)
            .execute(tx.as_mut())
            .await?;
            insert_outbox_in_tx(&mut tx, &event).await?;
            clear_sale_safety_blocker_marker_in_tx(&mut tx, &identity.planogram_version, &row.0)
                .await?;
            upsert_stock_projection_in_tx(
                &mut tx,
                &identity.planogram_version,
                &row.0,
                snapshot.after_quantity,
                snapshot.capacity,
                true,
            )
            .await?;
            upsert_sale_view_projection_in_tx(&mut tx, &identity.planogram_version, &row.0).await?;
        }
        tx.commit().await?;
        Ok(false)
    }

    async fn historical_stock_maintenance_batch_matches(
        &self,
        input: &StockMaintenanceBatchInput,
    ) -> Result<bool, StoreError> {
        if matches!(input.mode.as_str(), "initial_count" | "recovery_count") {
            let stored = self
                .get_metadata::<StoredPhysicalStockAttestation>(PHYSICAL_STOCK_ATTESTATION_KEY)
                .await?;
            let Some(stored) = stored.filter(|stored| stored.attestation_id == input.task_id)
            else {
                return Ok(false);
            };
            if stored.slots.len() != input.slots.len() {
                return Ok(false);
            }
            return Ok(input.slots.iter().all(|slot| {
                slot.addition.is_none()
                    && stored.slots.iter().any(|stored_slot| {
                        stored_slot.slot_code == slot.slot_code
                            && Some(stored_slot.quantity) == slot.quantity
                    })
            }));
        }
        let Ok(normalized) = normalize_refill_batch(input) else {
            return Ok(false);
        };
        let stored: Option<(String, String)> = sqlx::query_as(
            "SELECT payload_json,payload_fingerprint FROM stock_maintenance_batches
             WHERE task_id=?1",
        )
        .bind(&input.task_id)
        .fetch_optional(&self.pool)
        .await?;
        let Some((payload_json, fingerprint)) = stored else {
            return Ok(false);
        };
        Ok(payload_json == serde_json::to_string(&normalized)?
            && fingerprint == stock_maintenance_batch_fingerprint(&normalized)?)
    }

    async fn stock_maintenance_task_was_pruned(&self, task_id: &str) -> Result<bool, StoreError> {
        let tombstone: Option<(i64,)> = sqlx::query_as(
            "SELECT 1 FROM stock_maintenance_task_tombstones
             WHERE task_id=?1 AND expires_at >= ?2",
        )
        .bind(task_id)
        .bind(now_iso())
        .fetch_optional(&self.pool)
        .await?;
        Ok(tombstone.is_some())
    }

    async fn freeze_stale_stock_task_slots(
        &self,
        slots: &[StockMaintenanceBatchSlotInput],
    ) -> Result<(), StoreError> {
        let mut tx = self.begin_immediate_write_transaction().await?;
        for slot in slots {
            let active: Option<(String, String)> = sqlx::query_as(
                "SELECT s.planogram_version,s.slot_id FROM machine_planogram_slots s
                 JOIN machine_planogram_versions v ON v.planogram_version=s.planogram_version AND v.active=1
                 WHERE s.slot_code=?1",
            )
            .bind(&slot.slot_code)
            .fetch_optional(tx.as_mut())
            .await?;
            let Some((planogram_version, slot_id)) = active else {
                continue;
            };
            upsert_sale_safety_blocker_marker_in_tx(
                &mut tx,
                &planogram_version,
                &slot_id,
                "needs_platform_review",
                "stale_stock_maintenance_task",
                "stock_maintenance_task",
            )
            .await?;
            sqlx::query(
                "UPDATE current_stock_projection SET saleable_stock=0,slot_sales_state='needs_platform_review',updated_at=?3
                 WHERE planogram_version=?1 AND slot_id=?2",
            )
            .bind(&planogram_version)
            .bind(&slot_id)
            .bind(now_iso())
            .execute(tx.as_mut())
            .await?;
            upsert_sale_view_projection_in_tx(&mut tx, &planogram_version, &slot_id).await?;
        }
        tx.commit().await?;
        Ok(())
    }

    async fn freeze_stale_stock_task_identity(
        &self,
        identity: &StockMaintenanceTaskIdentity,
    ) -> Result<(), StoreError> {
        let mut tx = self.begin_immediate_write_transaction().await?;
        let differences =
            Self::stock_maintenance_identity_differences_in_tx(&mut tx, identity).await?;
        Self::freeze_stock_identity_differences_in_tx(&mut tx, identity, &differences).await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn record_stock_movement(
        &self,
        input: StockMovementInput,
    ) -> Result<SaleViewSnapshot, StoreError> {
        self.record_stock_movement_with_upload(input, None, None)
            .await
    }

    pub async fn record_stock_movement_with_upload(
        &self,
        input: StockMovementInput,
        machine_code: Option<&str>,
        api_base_url: Option<&str>,
    ) -> Result<SaleViewSnapshot, StoreError> {
        if input.movement_id.trim().is_empty() {
            return Err(StoreError::InvalidStockInput(
                "movement idempotency key is required".to_string(),
            ));
        }
        if input.quantity < 0 {
            return Err(StoreError::InvalidStockInput(
                "movement quantity must be nonnegative".to_string(),
            ));
        }
        if input.movement_type != "planned_refill"
            && input.movement_type != "stock_count_correction"
        {
            return Err(StoreError::InvalidStockInput(format!(
                "unsupported movement type {}",
                input.movement_type
            )));
        }

        let mut tx = self.pool.begin().await?;
        let existing: Option<(String, String, String, i64, String, Option<String>)> =
            sqlx::query_as(
                "SELECT planogram_version,slot_id,movement_type,quantity,source,attributed_to
             FROM stock_movements WHERE movement_id = ?1",
            )
            .bind(&input.movement_id)
            .fetch_optional(tx.as_mut())
            .await?;
        if let Some((planogram_version, slot_id, movement_type, quantity, source, attributed_to)) =
            existing
        {
            tx.rollback().await?;
            if planogram_version == input.planogram_version
                && slot_id == input.slot_id
                && movement_type == input.movement_type
                && quantity == input.quantity
                && source == input.source
                && attributed_to == input.attributed_to
            {
                // The browser may not receive the HTTP response after this
                // transaction commits.  A replay with the stored key is a
                // read of the original result, never a second refill.
                return self.sale_view(machine_code.map(ToString::to_string)).await;
            }
            return Err(StoreError::InvalidStockInput(
                "movement idempotency key was already used with different stock data".to_string(),
            ));
        }
        let slot: Option<(i64, String, String, String)> = sqlx::query_as(
            "SELECT s.capacity, s.slot_code, s.inventory_id, s.variant_id
             FROM machine_planogram_slots s
             JOIN machine_planogram_versions v
               ON v.planogram_version = s.planogram_version AND v.active = 1
             WHERE s.planogram_version = ?1 AND s.slot_id = ?2",
        )
        .bind(&input.planogram_version)
        .bind(&input.slot_id)
        .fetch_optional(tx.as_mut())
        .await?;
        let Some((capacity, slot_code, inventory_id, variant_id)) = slot else {
            return Err(StoreError::InvalidStockInput(
                "movement slot is not in the active planogram version".to_string(),
            ));
        };
        let current_stock: Option<(i64, String)> = sqlx::query_as(
            "SELECT physical_stock, slot_sales_state
             FROM current_stock_projection
             WHERE planogram_version = ?1 AND slot_id = ?2",
        )
        .bind(&input.planogram_version)
        .bind(&input.slot_id)
        .fetch_optional(tx.as_mut())
        .await?;
        let before_quantity = current_stock
            .as_ref()
            .map_or(0, |(physical_stock, _)| *physical_stock);
        let current_slot_sales_state = current_stock
            .as_ref()
            .map(|(_, slot_sales_state)| slot_sales_state.as_str());
        let replaces_local_fact = input.movement_type == "stock_count_correction"
            || matches!(
                current_slot_sales_state,
                Some("blocked_for_planogram_change")
            );
        let after_quantity = if replaces_local_fact {
            input.quantity
        } else {
            before_quantity + input.quantity
        };
        if after_quantity > capacity {
            // An over-capacity entry is not a local fact.  Preserve the last
            // observed physical quantity, but freeze sales explicitly until a
            // real count/reconciliation is completed.
            upsert_sale_safety_blocker_marker_in_tx(
                &mut tx,
                &input.planogram_version,
                &input.slot_id,
                "needs_platform_review",
                "local_capacity_exceeded",
                "local_maintenance",
            )
            .await?;
            sqlx::query(
                "UPDATE current_stock_projection
                 SET saleable_stock = 0,
                     slot_sales_state = 'needs_platform_review',
                     updated_at = ?3
                 WHERE planogram_version = ?1 AND slot_id = ?2",
            )
            .bind(&input.planogram_version)
            .bind(&input.slot_id)
            .bind(now_iso())
            .execute(tx.as_mut())
            .await?;
            upsert_sale_view_projection_in_tx(&mut tx, &input.planogram_version, &input.slot_id)
                .await?;
            tx.commit().await?;
            return Err(StoreError::InvalidStockInput(format!(
                "movement exceeds capacity: before {before_quantity} + quantity {} > capacity {capacity}; slot frozen for reconciliation",
                input.quantity
            )));
        }
        let slot_mapping_snapshot = serde_json::json!({
            "slotCode": slot_code,
            "capacity": capacity,
            "inventoryId": inventory_id,
            "variantId": variant_id,
        });
        let slot_mapping_snapshot_json = slot_mapping_snapshot.to_string();

        let occurred_at = now_iso();
        sqlx::query(
            "INSERT INTO stock_movements(
               movement_id,planogram_version,slot_id,movement_type,quantity,
               before_quantity,after_quantity,slot_mapping_snapshot_json,
               source,attributed_to,occurred_at
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
        )
        .bind(&input.movement_id)
        .bind(&input.planogram_version)
        .bind(&input.slot_id)
        .bind(&input.movement_type)
        .bind(input.quantity)
        .bind(before_quantity)
        .bind(after_quantity)
        .bind(&slot_mapping_snapshot_json)
        .bind(&input.source)
        .bind(&input.attributed_to)
        .bind(&occurred_at)
        .execute(tx.as_mut())
        .await?;

        if let (Some(machine_code), Some(api_base_url)) = (machine_code, api_base_url) {
            let payload = serde_json::json!({
                "machineCode": machine_code,
                "movementId": input.movement_id,
                "planogramVersion": input.planogram_version,
                "slotId": input.slot_id,
                "movementType": input.movement_type,
                "quantity": input.quantity,
                "beforeQuantity": before_quantity,
                "afterQuantity": after_quantity,
                "slotMappingSnapshot": slot_mapping_snapshot,
                "source": input.source,
                "attributedTo": input.attributed_to,
                "occurredAt": occurred_at,
            });
            let target_url = format!(
                "{}/machine-stock-movements",
                api_base_url.trim_end_matches('/')
            );
            let event = OutboxInput::stock_movement_upload(&input.movement_id, target_url, payload);
            let now = now_iso();
            sqlx::query(
                "INSERT INTO stock_movement_sync(
                   movement_id,status,outbox_event_id,attempt_count,created_at,updated_at
                 ) VALUES (?1,'pending',?2,0,?3,?3)
                 ON CONFLICT(movement_id) DO NOTHING",
            )
            .bind(&input.movement_id)
            .bind(&event.id)
            .bind(&now)
            .execute(tx.as_mut())
            .await?;
            insert_outbox_in_tx(&mut tx, &event).await?;
        }

        let reset_local_slot_hold = input.source == "local_maintenance";
        if reset_local_slot_hold {
            clear_sale_safety_blocker_marker_in_tx(
                &mut tx,
                &input.planogram_version,
                &input.slot_id,
            )
            .await?;
        } else {
            clear_stock_ledger_loss_blocker_in_tx(
                &mut tx,
                &input.planogram_version,
                &input.slot_id,
            )
            .await?;
        }
        upsert_stock_projection_in_tx(
            &mut tx,
            &input.planogram_version,
            &input.slot_id,
            after_quantity,
            capacity,
            reset_local_slot_hold,
        )
        .await?;
        upsert_sale_view_projection_in_tx(&mut tx, &input.planogram_version, &input.slot_id)
            .await?;
        tx.commit().await?;
        self.sale_view(machine_code.map(ToString::to_string)).await
    }

    pub async fn record_physical_stock_attestation(
        &self,
        input: PhysicalStockAttestationInput,
    ) -> Result<SaleViewSnapshot, StoreError> {
        self.record_physical_stock_attestation_with_upload(input, None, None)
            .await
    }

    pub async fn record_physical_stock_attestation_with_upload(
        &self,
        input: PhysicalStockAttestationInput,
        machine_code: Option<&str>,
        api_base_url: Option<&str>,
    ) -> Result<SaleViewSnapshot, StoreError> {
        // Production/typed Bring-Up must not let a locally persisted outbox
        // event masquerade as a Platform-accepted physical count.  Stage the
        // observation and its uploads first; the upload acknowledgement path
        // atomically commits the local facts later.
        if let (Some(machine_code), Some(api_base_url)) = (machine_code, api_base_url) {
            return self
                .stage_physical_stock_attestation_for_platform(
                    input,
                    machine_code,
                    api_base_url,
                    None,
                )
                .await;
        }
        if input.attestation_id.trim().is_empty()
            || input.planogram_version.trim().is_empty()
            || input.operator_id.trim().is_empty()
            || input.slots.is_empty()
        {
            return Err(StoreError::InvalidStockInput(
                "attestation id, planogram version, operator id, and slots are required"
                    .to_string(),
            ));
        }

        let mut tx = self.begin_immediate_write_transaction().await?;
        let planogram: Option<(i64,)> = sqlx::query_as(
            "SELECT active FROM machine_planogram_versions WHERE planogram_version = ?1",
        )
        .bind(&input.planogram_version)
        .fetch_optional(tx.as_mut())
        .await?;
        if planogram != Some((1,)) {
            return Err(StoreError::InvalidStockInput(
                "attestation planogram version is not active".to_string(),
            ));
        }

        let rows = sqlx::query(
            "SELECT slot_id, slot_code, sku, capacity, inventory_id, variant_id
             FROM machine_planogram_slots
             WHERE planogram_version = ?1
             ORDER BY layer_no ASC, cell_no ASC",
        )
        .bind(&input.planogram_version)
        .fetch_all(tx.as_mut())
        .await?;
        if rows.len() != input.slots.len() {
            return Err(StoreError::InvalidStockInput(
                "attestation must include every active planogram slot exactly once".to_string(),
            ));
        }

        let mut attested_slots = HashMap::with_capacity(input.slots.len());
        for slot in &input.slots {
            if slot.quantity < 0 {
                return Err(StoreError::InvalidStockInput(
                    "attested quantity must be nonnegative".to_string(),
                ));
            }
            if attested_slots.insert(slot.slot_id.as_str(), slot).is_some() {
                return Err(StoreError::InvalidStockInput(format!(
                    "duplicate attested slot {}",
                    slot.slot_code
                )));
            }
        }

        let attested_at = now_iso();
        for row in rows {
            let slot_id: String = row.try_get("slot_id")?;
            let slot_code: String = row.try_get("slot_code")?;
            let sku: String = row.try_get("sku")?;
            let capacity: i64 = row.try_get("capacity")?;
            let inventory_id: String = row.try_get("inventory_id")?;
            let variant_id: String = row.try_get("variant_id")?;
            let Some(slot) = attested_slots.get(slot_id.as_str()) else {
                return Err(StoreError::InvalidStockInput(format!(
                    "missing attested slot {}",
                    slot_code
                )));
            };
            if slot.slot_code != slot_code || slot.sku != sku {
                return Err(StoreError::InvalidStockInput(format!(
                    "attested slot {} does not match active planogram mapping",
                    slot.slot_code
                )));
            }
            if slot.quantity > capacity {
                return Err(StoreError::InvalidStockInput(format!(
                    "attested slot {} exceeds capacity",
                    slot.slot_code
                )));
            }

            let before_quantity: Option<(i64,)> = sqlx::query_as(
                "SELECT physical_stock
                 FROM current_stock_projection
                 WHERE planogram_version = ?1 AND slot_id = ?2",
            )
            .bind(&input.planogram_version)
            .bind(&slot_id)
            .fetch_optional(tx.as_mut())
            .await?;
            let before_quantity = before_quantity.map_or(0, |(quantity,)| quantity);
            let slot_mapping_snapshot = serde_json::json!({
                "slotCode": slot_code,
                "capacity": capacity,
                "inventoryId": inventory_id,
                "variantId": variant_id,
            });
            let movement_id = format!("{}:{}", input.attestation_id, slot_id);
            sqlx::query(
                "INSERT INTO stock_movements(
                   movement_id,planogram_version,slot_id,movement_type,quantity,
                   before_quantity,after_quantity,slot_mapping_snapshot_json,
                   source,attributed_to,occurred_at
                 ) VALUES (?1,?2,?3,'stock_count_correction',?4,?5,?4,?6,'physical_stock_attestation',?7,?8)",
            )
            .bind(&movement_id)
            .bind(&input.planogram_version)
            .bind(&slot_id)
            .bind(slot.quantity)
            .bind(before_quantity)
            .bind(slot_mapping_snapshot.to_string())
            .bind(&input.operator_id)
            .bind(&attested_at)
            .execute(tx.as_mut())
            .await?;

            if let (Some(machine_code), Some(api_base_url)) = (machine_code, api_base_url) {
                let payload = serde_json::json!({
                    "machineCode": machine_code,
                    "movementId": movement_id,
                    "planogramVersion": input.planogram_version,
                    "slotId": slot_id,
                    "movementType": "stock_count_correction",
                    "quantity": slot.quantity,
                    "beforeQuantity": before_quantity,
                    "afterQuantity": slot.quantity,
                    "slotMappingSnapshot": slot_mapping_snapshot,
                    "source": "physical_stock_attestation",
                    "attributedTo": input.operator_id,
                    "occurredAt": attested_at,
                });
                let target_url = format!(
                    "{}/machine-stock-movements",
                    api_base_url.trim_end_matches('/')
                );
                let event = OutboxInput::stock_movement_upload(&movement_id, target_url, payload);
                let now = now_iso();
                sqlx::query(
                    "INSERT INTO stock_movement_sync(
                       movement_id,status,outbox_event_id,attempt_count,created_at,updated_at
                     ) VALUES (?1,'pending',?2,0,?3,?3)
                     ON CONFLICT(movement_id) DO NOTHING",
                )
                .bind(&movement_id)
                .bind(&event.id)
                .bind(&now)
                .execute(tx.as_mut())
                .await?;
                insert_outbox_in_tx(&mut tx, &event).await?;
            }

            clear_sale_safety_blocker_marker_in_tx(&mut tx, &input.planogram_version, &slot_id)
                .await?;
            let slot_sales_state = if !slot.enabled {
                "frozen"
            } else if slot.quantity > 0 {
                "sale_ready"
            } else {
                "sold_out"
            };
            let saleable_stock = if slot_sales_state == "sale_ready" {
                slot.quantity
            } else {
                0
            };
            upsert_stock_projection_with_state_in_tx(
                &mut tx,
                &input.planogram_version,
                &slot_id,
                slot.quantity,
                saleable_stock,
                slot_sales_state,
                true,
            )
            .await?;
            upsert_sale_view_projection_in_tx(&mut tx, &input.planogram_version, &slot_id).await?;
        }

        let stored = StoredPhysicalStockAttestation {
            attestation_id: input.attestation_id,
            planogram_version: input.planogram_version.clone(),
            operator_id: input.operator_id,
            attested_at,
            slots: input.slots,
        };
        sqlx::query(
            "INSERT INTO runtime_metadata(key,value_json,updated_at)
             VALUES (?1,?2,?3)
             ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at",
        )
        .bind(PHYSICAL_STOCK_ATTESTATION_KEY)
        .bind(serde_json::to_string(&stored)?)
        .bind(now_iso())
        .execute(tx.as_mut())
        .await?;

        tx.commit().await?;
        self.sale_view(machine_code.map(ToString::to_string)).await
    }

    async fn stage_physical_stock_attestation_for_platform(
        &self,
        input: PhysicalStockAttestationInput,
        machine_code: &str,
        api_base_url: &str,
        expected_task_identity: Option<&StockMaintenanceTaskIdentity>,
    ) -> Result<SaleViewSnapshot, StoreError> {
        if input.attestation_id.trim().is_empty()
            || input.planogram_version.trim().is_empty()
            || input.operator_id.trim().is_empty()
            || input.slots.is_empty()
        {
            return Err(StoreError::InvalidStockInput(
                "attestation id, planogram version, operator id, and slots are required"
                    .to_string(),
            ));
        }

        let mut carried_slot_generations =
            HashMap::<String, PendingPhysicalStockAttestationSlotGeneration>::new();
        if let Some(pending) = self
            .get_metadata::<PendingPhysicalStockAttestation>(PENDING_PHYSICAL_STOCK_ATTESTATION_KEY)
            .await?
        {
            if pending.input == input {
                // This is the response-loss retry path.  Do not manufacture a
                // second correction set; the durable outbox owns retransmit.
                return self.sale_view(Some(machine_code.to_string())).await;
            }
            let sync_rows: Vec<(String, String, Option<String>)> = sqlx::query_as(
                "SELECT movement_id,status,platform_receipt_json
                 FROM stock_movement_sync
                 WHERE movement_id IN (SELECT value FROM json_each(?1))",
            )
            .bind(serde_json::to_string(&pending.movement_ids)?)
            .fetch_all(&self.pool)
            .await?;
            let statuses: HashMap<&str, (&str, Option<&str>)> = sync_rows
                .iter()
                .map(|(movement_id, status, receipt)| {
                    (movement_id.as_str(), (status.as_str(), receipt.as_deref()))
                })
                .collect();
            let has_terminal_rejection = statuses
                .values()
                .any(|(status, _)| matches!(*status, "rejected" | "reconciliation"));
            if !has_terminal_rejection
                || statuses
                    .values()
                    .any(|(status, _)| matches!(*status, "pending" | "failed"))
            {
                return Err(StoreError::InvalidStockInput(
                    "a physical stock attestation is awaiting platform acknowledgement; refresh its status before submitting another"
                        .to_string(),
                ));
            }

            for previous_slot in &pending.input.slots {
                let movement_id = pending
                    .slot_generations
                    .iter()
                    .find(|generation| generation.slot_id == previous_slot.slot_id)
                    .map(|generation| generation.movement_id.clone())
                    .unwrap_or_else(|| {
                        format!("{}:{}", pending.input.attestation_id, previous_slot.slot_id)
                    });
                let Some((status, receipt)) = statuses.get(movement_id.as_str()).copied() else {
                    return Err(StoreError::IntegrityCheckFailed(format!(
                        "physical stock attestation slot generation is missing sync state: {}",
                        previous_slot.slot_code
                    )));
                };
                if status != "accepted" {
                    continue;
                }
                if receipt.is_none() {
                    return Err(StoreError::IntegrityCheckFailed(format!(
                        "accepted physical stock attestation slot is missing Platform receipt: {}",
                        previous_slot.slot_code
                    )));
                }
                if pending.input.planogram_version != input.planogram_version
                    || input
                        .slots
                        .iter()
                        .find(|slot| slot.slot_id == previous_slot.slot_id)
                        != Some(previous_slot)
                {
                    return Err(StoreError::InvalidStockInput(format!(
                        "Platform-accepted attested slot {} cannot be changed; retry only rejected slots",
                        previous_slot.slot_code
                    )));
                }
                let generation = if let Some(generation) = pending
                    .slot_generations
                    .iter()
                    .find(|generation| generation.slot_id == previous_slot.slot_id)
                {
                    generation.clone()
                } else {
                    let before: Option<(i64,)> = sqlx::query_as(
                        "SELECT physical_stock FROM current_stock_projection
                         WHERE planogram_version = ?1 AND slot_id = ?2",
                    )
                    .bind(&pending.input.planogram_version)
                    .bind(&previous_slot.slot_id)
                    .fetch_optional(&self.pool)
                    .await?;
                    PendingPhysicalStockAttestationSlotGeneration {
                        slot_id: previous_slot.slot_id.clone(),
                        movement_id,
                        generation: pending.input.attestation_id.clone(),
                        before_quantity: before.map_or(0, |(quantity,)| quantity),
                        after_quantity: previous_slot.quantity,
                        occurred_at: pending.attested_at.clone(),
                    }
                };
                carried_slot_generations.insert(previous_slot.slot_id.clone(), generation);
            }
        }

        let mut tx = self.begin_immediate_write_transaction().await?;
        if let Some(identity) = expected_task_identity {
            let differences =
                Self::stock_maintenance_identity_differences_in_tx(&mut tx, identity).await?;
            if !differences.is_empty() {
                Self::freeze_stock_identity_differences_in_tx(&mut tx, identity, &differences)
                    .await?;
                tx.commit().await?;
                return Err(StoreError::InvalidStockInput(
                    "stock maintenance task is stale; affected slots require reconciliation"
                        .to_string(),
                ));
            }
        }
        let planogram: Option<(i64,)> = sqlx::query_as(
            "SELECT active FROM machine_planogram_versions WHERE planogram_version = ?1",
        )
        .bind(&input.planogram_version)
        .fetch_optional(tx.as_mut())
        .await?;
        if planogram != Some((1,)) {
            return Err(StoreError::InvalidStockInput(
                "attestation planogram version is not active".to_string(),
            ));
        }

        let rows = sqlx::query(
            "SELECT slot_id, slot_code, sku, capacity, inventory_id, variant_id
             FROM machine_planogram_slots
             WHERE planogram_version = ?1
             ORDER BY layer_no ASC, cell_no ASC",
        )
        .bind(&input.planogram_version)
        .fetch_all(tx.as_mut())
        .await?;
        if rows.len() != input.slots.len() {
            return Err(StoreError::InvalidStockInput(
                "attestation must include every active planogram slot exactly once".to_string(),
            ));
        }

        let mut attested_slots = HashMap::with_capacity(input.slots.len());
        for slot in &input.slots {
            if slot.quantity < 0 {
                return Err(StoreError::InvalidStockInput(
                    "attested quantity must be nonnegative".to_string(),
                ));
            }
            if attested_slots.insert(slot.slot_id.as_str(), slot).is_some() {
                return Err(StoreError::InvalidStockInput(format!(
                    "duplicate attested slot {}",
                    slot.slot_code
                )));
            }
        }

        let attested_at = now_iso();
        let target_url = format!(
            "{}/machine-stock-movements",
            api_base_url.trim_end_matches('/')
        );
        let mut movement_ids = Vec::with_capacity(rows.len());
        let mut slot_generations = Vec::with_capacity(rows.len());
        for row in rows {
            let slot_id: String = row.try_get("slot_id")?;
            let slot_code: String = row.try_get("slot_code")?;
            let sku: String = row.try_get("sku")?;
            let capacity: i64 = row.try_get("capacity")?;
            let inventory_id: String = row.try_get("inventory_id")?;
            let variant_id: String = row.try_get("variant_id")?;
            let Some(slot) = attested_slots.get(slot_id.as_str()) else {
                return Err(StoreError::InvalidStockInput(format!(
                    "missing attested slot {slot_code}"
                )));
            };
            if slot.slot_code != slot_code || slot.sku != sku {
                return Err(StoreError::InvalidStockInput(format!(
                    "attested slot {} does not match active planogram mapping",
                    slot.slot_code
                )));
            }
            if slot.quantity > capacity {
                return Err(StoreError::InvalidStockInput(format!(
                    "attested slot {} exceeds capacity",
                    slot.slot_code
                )));
            }

            let before_quantity: Option<(i64,)> = sqlx::query_as(
                "SELECT physical_stock
                 FROM current_stock_projection
                 WHERE planogram_version = ?1 AND slot_id = ?2",
            )
            .bind(&input.planogram_version)
            .bind(&slot_id)
            .fetch_optional(tx.as_mut())
            .await?;
            let before_quantity = before_quantity.map_or(0, |(quantity,)| quantity);
            if let Some(generation) = carried_slot_generations.remove(&slot_id) {
                movement_ids.push(generation.movement_id.clone());
                slot_generations.push(generation);
                continue;
            }
            let movement_id = format!("{}:{slot_id}", input.attestation_id);
            let slot_mapping_snapshot = serde_json::json!({
                "slotCode": slot_code,
                "capacity": capacity,
                "inventoryId": inventory_id,
                "variantId": variant_id,
            });
            let event = OutboxInput::stock_movement_upload(
                &movement_id,
                target_url.clone(),
                serde_json::json!({
                    "machineCode": machine_code,
                    "movementId": movement_id,
                    "planogramVersion": input.planogram_version,
                    "slotId": slot_id,
                    "movementType": "stock_count_correction",
                    "quantity": slot.quantity,
                    "beforeQuantity": before_quantity,
                    "afterQuantity": slot.quantity,
                    "slotMappingSnapshot": slot_mapping_snapshot,
                    "source": "physical_stock_attestation",
                    "attributedTo": input.operator_id,
                    "occurredAt": attested_at,
                }),
            );
            let now = now_iso();
            sqlx::query(
                "INSERT INTO stock_movement_sync(
                   movement_id,status,outbox_event_id,attempt_count,created_at,updated_at
                 ) VALUES (?1,'pending',?2,0,?3,?3)",
            )
            .bind(&movement_id)
            .bind(&event.id)
            .bind(&now)
            .execute(tx.as_mut())
            .await?;
            insert_outbox_in_tx(&mut tx, &event).await?;
            movement_ids.push(movement_id.clone());
            slot_generations.push(PendingPhysicalStockAttestationSlotGeneration {
                slot_id,
                movement_id,
                generation: input.attestation_id.clone(),
                before_quantity,
                after_quantity: slot.quantity,
                occurred_at: attested_at.clone(),
            });
        }

        let pending = PendingPhysicalStockAttestation {
            input,
            attested_at,
            movement_ids,
            slot_generations,
        };
        sqlx::query(
            "INSERT INTO runtime_metadata(key,value_json,updated_at)
             VALUES (?1,?2,?3)
             ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at",
        )
        .bind(PENDING_PHYSICAL_STOCK_ATTESTATION_KEY)
        .bind(serde_json::to_string(&pending)?)
        .bind(now_iso())
        .execute(tx.as_mut())
        .await?;
        sqlx::query("DELETE FROM runtime_metadata WHERE key = ?1")
            .bind(FAILED_PHYSICAL_STOCK_ATTESTATION_KEY)
            .execute(tx.as_mut())
            .await?;
        tx.commit().await?;
        self.sale_view(Some(machine_code.to_string())).await
    }

    /// Completes the two-phase attestation only after every staged correction
    /// has a durable Platform acceptance receipt.  It is intentionally safe to
    /// call during startup/readiness refresh: a crash after the final receipt
    /// but before local commit must recover the real cursor rather than leave
    /// the UI permanently stale.
    async fn finalize_pending_physical_stock_attestation_if_accepted(
        &self,
    ) -> Result<bool, StoreError> {
        let mut tx = self.begin_immediate_write_transaction().await?;
        let pending_json: Option<(String,)> =
            sqlx::query_as("SELECT value_json FROM runtime_metadata WHERE key = ?1")
                .bind(PENDING_PHYSICAL_STOCK_ATTESTATION_KEY)
                .fetch_optional(tx.as_mut())
                .await?;
        let Some((pending_json,)) = pending_json else {
            tx.rollback().await?;
            return Ok(false);
        };
        let pending: PendingPhysicalStockAttestation = serde_json::from_str(&pending_json)?;
        let sync_rows: Vec<(String, String)> = sqlx::query_as(
            "SELECT movement_id,status FROM stock_movement_sync WHERE movement_id IN (SELECT value FROM json_each(?1))",
        )
        .bind(serde_json::to_string(&pending.movement_ids)?)
        .fetch_all(tx.as_mut())
        .await?;
        let statuses: HashMap<&str, &str> = sync_rows
            .iter()
            .map(|(movement_id, status)| (movement_id.as_str(), status.as_str()))
            .collect();
        if pending.movement_ids.len() != statuses.len()
            || pending
                .movement_ids
                .iter()
                .any(|movement_id| statuses.get(movement_id.as_str()) != Some(&"accepted"))
        {
            tx.rollback().await?;
            return Ok(false);
        }

        let active: Option<(String,)> = sqlx::query_as(
            "SELECT planogram_version FROM machine_planogram_versions WHERE active = 1 LIMIT 1",
        )
        .fetch_optional(tx.as_mut())
        .await?;
        if active.as_ref().map(|(version,)| version.as_str())
            != Some(pending.input.planogram_version.as_str())
        {
            tx.rollback().await?;
            return Ok(false);
        }

        for slot in &pending.input.slots {
            let row: Option<(String, i64, String, String)> = sqlx::query_as(
                "SELECT slot_code, capacity, inventory_id, variant_id
                 FROM machine_planogram_slots
                 WHERE planogram_version = ?1 AND slot_id = ?2",
            )
            .bind(&pending.input.planogram_version)
            .bind(&slot.slot_id)
            .fetch_optional(tx.as_mut())
            .await?;
            let Some((slot_code, capacity, inventory_id, variant_id)) = row else {
                tx.rollback().await?;
                return Ok(false);
            };
            if slot.slot_code != slot_code || slot.quantity > capacity {
                tx.rollback().await?;
                return Ok(false);
            }
            let slot_generation = pending
                .slot_generations
                .iter()
                .find(|generation| generation.slot_id == slot.slot_id);
            let (movement_id, before_quantity, occurred_at) =
                if let Some(generation) = slot_generation {
                    if generation.after_quantity != slot.quantity
                        || generation.movement_id
                            != format!("{}:{}", generation.generation, slot.slot_id)
                    {
                        tx.rollback().await?;
                        return Ok(false);
                    }
                    (
                        generation.movement_id.clone(),
                        generation.before_quantity,
                        generation.occurred_at.as_str(),
                    )
                } else {
                    let before: Option<(i64,)> = sqlx::query_as(
                        "SELECT physical_stock FROM current_stock_projection
                         WHERE planogram_version = ?1 AND slot_id = ?2",
                    )
                    .bind(&pending.input.planogram_version)
                    .bind(&slot.slot_id)
                    .fetch_optional(tx.as_mut())
                    .await?;
                    (
                        format!("{}:{}", pending.input.attestation_id, slot.slot_id),
                        before.map_or(0, |(quantity,)| quantity),
                        pending.attested_at.as_str(),
                    )
                };
            let slot_mapping_snapshot = serde_json::json!({
                "slotCode": slot_code,
                "capacity": capacity,
                "inventoryId": inventory_id,
                "variantId": variant_id,
            });
            sqlx::query(
                "INSERT INTO stock_movements(
                   movement_id,planogram_version,slot_id,movement_type,quantity,
                   before_quantity,after_quantity,slot_mapping_snapshot_json,
                   source,attributed_to,occurred_at
                 ) VALUES (?1,?2,?3,'stock_count_correction',?4,?5,?4,?6,'physical_stock_attestation',?7,?8)",
            )
            .bind(movement_id)
            .bind(&pending.input.planogram_version)
            .bind(&slot.slot_id)
            .bind(slot.quantity)
            .bind(before_quantity)
            .bind(slot_mapping_snapshot.to_string())
            .bind(&pending.input.operator_id)
            .bind(occurred_at)
            .execute(tx.as_mut())
            .await?;
            clear_sale_safety_blocker_marker_in_tx(
                &mut tx,
                &pending.input.planogram_version,
                &slot.slot_id,
            )
            .await?;
            let (saleable_stock, slot_sales_state) = if slot.enabled && slot.quantity > 0 {
                (slot.quantity, "sale_ready")
            } else if slot.enabled {
                (0, "sold_out")
            } else {
                (0, "frozen")
            };
            upsert_stock_projection_with_state_in_tx(
                &mut tx,
                &pending.input.planogram_version,
                &slot.slot_id,
                slot.quantity,
                saleable_stock,
                slot_sales_state,
                true,
            )
            .await?;
            upsert_sale_view_projection_in_tx(
                &mut tx,
                &pending.input.planogram_version,
                &slot.slot_id,
            )
            .await?;
        }

        let stored = StoredPhysicalStockAttestation {
            attestation_id: pending.input.attestation_id,
            planogram_version: pending.input.planogram_version,
            operator_id: pending.input.operator_id,
            attested_at: pending.attested_at,
            slots: pending.input.slots,
        };
        sqlx::query(
            "INSERT INTO runtime_metadata(key,value_json,updated_at)
             VALUES (?1,?2,?3)
             ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at",
        )
        .bind(PHYSICAL_STOCK_ATTESTATION_KEY)
        .bind(serde_json::to_string(&stored)?)
        .bind(now_iso())
        .execute(tx.as_mut())
        .await?;
        sqlx::query("DELETE FROM runtime_metadata WHERE key = ?1")
            .bind(PENDING_PHYSICAL_STOCK_ATTESTATION_KEY)
            .execute(tx.as_mut())
            .await?;
        sqlx::query("DELETE FROM runtime_metadata WHERE key = ?1")
            .bind(FAILED_PHYSICAL_STOCK_ATTESTATION_KEY)
            .execute(tx.as_mut())
            .await?;
        tx.commit().await?;
        Ok(true)
    }

    pub async fn physical_stock_attestation_status(
        &self,
    ) -> Result<PhysicalStockAttestationStatus, StoreError> {
        self.finalize_pending_physical_stock_attestation_if_accepted()
            .await?;
        if let Some(pending) = self
            .get_metadata::<PendingPhysicalStockAttestation>(PENDING_PHYSICAL_STOCK_ATTESTATION_KEY)
            .await?
        {
            let sync_rows: Vec<(String, String, Option<String>)> = sqlx::query_as(
                "SELECT movement_id,status,last_error FROM stock_movement_sync
                 WHERE movement_id IN (SELECT value FROM json_each(?1))",
            )
            .bind(serde_json::to_string(&pending.movement_ids)?)
            .fetch_all(&self.pool)
            .await?;
            let failed = sync_rows.iter().find(|(_, status, _)| {
                matches!(status.as_str(), "failed" | "rejected" | "reconciliation")
            });
            let (status, code, message) = if let Some((_, status, error)) = failed {
                let detail = error
                    .as_deref()
                    .unwrap_or("platform rejected the stock correction");
                (
                    "failed",
                    if status == "failed" {
                        "PHYSICAL_STOCK_ATTESTATION_UPLOAD_FAILED"
                    } else {
                        "PHYSICAL_STOCK_ATTESTATION_REJECTED"
                    },
                    format!(
                        "physical stock attestation was not accepted by Platform; correct the count and submit again ({detail})"
                    ),
                )
            } else {
                (
                    "pending",
                    "PHYSICAL_STOCK_ATTESTATION_PENDING",
                    "physical stock attestation is awaiting Platform acknowledgement; keep the record-stock cursor open and refresh status"
                        .to_string(),
                )
            };
            return Ok(PhysicalStockAttestationStatus {
                status: status.to_string(),
                code: code.to_string(),
                message,
                attestation_id: Some(pending.input.attestation_id),
                planogram_version: Some(pending.input.planogram_version),
                attested_at: Some(pending.attested_at),
                inconsistent_slots: vec![],
            });
        }
        if let Some(failed) = self
            .get_metadata::<PendingPhysicalStockAttestation>(FAILED_PHYSICAL_STOCK_ATTESTATION_KEY)
            .await?
        {
            return Ok(PhysicalStockAttestationStatus {
                status: "failed".to_string(),
                code: "PHYSICAL_STOCK_ATTESTATION_REJECTED".to_string(),
                message: "physical stock attestation was rejected by Platform; correct the count and submit a new attestation".to_string(),
                attestation_id: Some(failed.input.attestation_id),
                planogram_version: Some(failed.input.planogram_version),
                attested_at: Some(failed.attested_at),
                inconsistent_slots: vec![],
            });
        }
        let stored = self
            .get_metadata::<StoredPhysicalStockAttestation>(PHYSICAL_STOCK_ATTESTATION_KEY)
            .await?;
        let Some(stored) = stored else {
            return Ok(PhysicalStockAttestationStatus {
                status: "missing".to_string(),
                code: "PHYSICAL_STOCK_ATTESTATION_MISSING".to_string(),
                message: "physical stock attestation is missing".to_string(),
                attestation_id: None,
                planogram_version: None,
                attested_at: None,
                inconsistent_slots: vec![],
            });
        };

        let active: Option<(String,)> = sqlx::query_as(
            "SELECT planogram_version FROM machine_planogram_versions WHERE active = 1 LIMIT 1",
        )
        .fetch_optional(&self.pool)
        .await?;
        if active.as_ref().map(|(version,)| version.as_str())
            != Some(stored.planogram_version.as_str())
        {
            return Ok(PhysicalStockAttestationStatus {
                status: "stale".to_string(),
                code: "PHYSICAL_STOCK_ATTESTATION_STALE".to_string(),
                message: "physical stock attestation is for a stale planogram".to_string(),
                attestation_id: Some(stored.attestation_id),
                planogram_version: Some(stored.planogram_version),
                attested_at: Some(stored.attested_at),
                inconsistent_slots: vec![],
            });
        }

        let mut inconsistent_slots = Vec::new();
        let rows = sqlx::query(
            "SELECT s.slot_id, s.slot_code, s.sku, s.capacity, c.physical_stock, c.slot_sales_state
             FROM machine_planogram_slots s
             LEFT JOIN current_stock_projection c
               ON c.planogram_version = s.planogram_version AND c.slot_id = s.slot_id
             WHERE s.planogram_version = ?1
             ORDER BY s.layer_no ASC, s.cell_no ASC",
        )
        .bind(&stored.planogram_version)
        .fetch_all(&self.pool)
        .await?;
        let attested_slots: HashMap<&str, &PhysicalStockAttestationSlotInput> = stored
            .slots
            .iter()
            .map(|slot| (slot.slot_id.as_str(), slot))
            .collect();
        for row in rows {
            let slot_id: String = row.try_get("slot_id")?;
            let slot_code: String = row.try_get("slot_code")?;
            let sku: String = row.try_get("sku")?;
            let capacity: i64 = row.try_get("capacity")?;
            let physical_stock: Option<i64> = row.try_get("physical_stock")?;
            let replayed_stock: Option<(i64,)> = sqlx::query_as(
                "SELECT after_quantity
                 FROM stock_movements
                 WHERE planogram_version = ?1 AND slot_id = ?2
                 ORDER BY occurred_at DESC, movement_id DESC
                 LIMIT 1",
            )
            .bind(&stored.planogram_version)
            .bind(&slot_id)
            .fetch_optional(&self.pool)
            .await?;
            let Some(attested) = attested_slots.get(slot_id.as_str()) else {
                inconsistent_slots.push(slot_code);
                continue;
            };
            if attested.slot_code != slot_code
                || attested.sku != sku
                || attested.quantity > capacity
                || physical_stock.is_none()
                || physical_stock.is_some_and(|quantity| quantity > capacity)
                || replayed_stock.is_none()
                || physical_stock != replayed_stock.map(|(quantity,)| quantity)
            {
                inconsistent_slots.push(slot_code);
            }
        }

        let status = if inconsistent_slots.is_empty() {
            (
                "ready",
                "PHYSICAL_STOCK_ATTESTATION_READY",
                "physical stock attestation is ready",
            )
        } else {
            (
                "inconsistent",
                "PHYSICAL_STOCK_ATTESTATION_INCONSISTENT",
                "physical stock attestation is inconsistent with local stock state",
            )
        };
        Ok(PhysicalStockAttestationStatus {
            status: status.0.to_string(),
            code: status.1.to_string(),
            message: status.2.to_string(),
            attestation_id: Some(stored.attestation_id),
            planogram_version: Some(stored.planogram_version),
            attested_at: Some(stored.attested_at),
            inconsistent_slots,
        })
    }

    pub async fn apply_platform_stock_snapshot(
        &self,
        snapshot: &crate::backend::MachineStockSnapshot,
    ) -> Result<SaleViewSnapshot, StoreError> {
        if snapshot.planogram_version.trim().is_empty() {
            return Err(StoreError::InvalidStockInput(
                "stock snapshot planogram version is required".to_string(),
            ));
        }

        let mut tx = self.pool.begin().await?;
        let pending_uploads: (i64,) = sqlx::query_as(
            "SELECT COUNT(1) FROM outbox_events WHERE kind = 'stock_movement_upload'",
        )
        .fetch_one(tx.as_mut())
        .await?;
        if pending_uploads.0 > 0 {
            return Err(StoreError::InvalidStockInput(
                "stock snapshot deferred while local stock movements are pending upload"
                    .to_string(),
            ));
        }

        let now = now_iso();
        let latest_order_session: Option<(String, String, Option<String>)> = sqlx::query_as(
            "SELECT status, next_action, expires_at
             FROM order_sessions
             WHERE status != 'closed'
             ORDER BY updated_at DESC, rowid DESC
             LIMIT 1",
        )
        .fetch_optional(tx.as_mut())
        .await?;
        if latest_order_session
            .as_ref()
            .is_some_and(|(status, next_action, expires_at)| {
                order_session_reserves_local_stock(status, next_action, expires_at.as_deref(), &now)
            })
        {
            return Err(StoreError::InvalidStockInput(
                "stock snapshot deferred while a local order is active".to_string(),
            ));
        }

        let active: Option<(String,)> = sqlx::query_as(
            "SELECT planogram_version FROM machine_planogram_versions WHERE active = 1 LIMIT 1",
        )
        .fetch_optional(tx.as_mut())
        .await?;
        if active.as_ref().map(|(version,)| version.as_str())
            != Some(snapshot.planogram_version.as_str())
        {
            return Err(StoreError::InvalidStockInput(format!(
                "stock snapshot planogram {} is not active locally",
                snapshot.planogram_version
            )));
        }

        let local_slots: Vec<(String, String, String, i64)> = sqlx::query_as(
            "SELECT slot_id, slot_code, inventory_id, capacity
             FROM machine_planogram_slots
             WHERE planogram_version = ?1
             ORDER BY layer_no ASC, cell_no ASC",
        )
        .bind(&snapshot.planogram_version)
        .fetch_all(tx.as_mut())
        .await?;
        if local_slots.len() != snapshot.slots.len() {
            return Err(StoreError::InvalidStockInput(format!(
                "stock snapshot slot count mismatch: local={}, platform={}",
                local_slots.len(),
                snapshot.slots.len()
            )));
        }

        let mut seen_slot_ids = HashSet::with_capacity(snapshot.slots.len());
        for slot in &snapshot.slots {
            if !seen_slot_ids.insert(slot.slot_id.clone()) {
                return Err(StoreError::InvalidStockInput(format!(
                    "stock snapshot duplicate slot {}",
                    slot.slot_code
                )));
            }
            if slot.capacity < 0
                || slot.on_hand_qty < 0
                || slot.reserved_qty < 0
                || slot.available_qty < 0
            {
                return Err(StoreError::InvalidStockInput(
                    "stock snapshot quantities must be nonnegative".to_string(),
                ));
            }

            let Some((_, local_slot_code, inventory_id, capacity)) = local_slots
                .iter()
                .find(|(slot_id, _, _, _)| slot_id == &slot.slot_id)
            else {
                return Err(StoreError::InvalidStockInput(format!(
                    "stock snapshot contains unknown slot {}",
                    slot.slot_code
                )));
            };
            if local_slot_code != &slot.slot_code {
                return Err(StoreError::InvalidStockInput(format!(
                    "stock snapshot slot code mismatch for slot {}",
                    slot.slot_id
                )));
            }
            if inventory_id != &slot.inventory_id {
                return Err(StoreError::InvalidStockInput(format!(
                    "stock snapshot inventory mismatch for slot {}",
                    slot.slot_code
                )));
            }
            if *capacity != slot.capacity {
                return Err(StoreError::InvalidStockInput(format!(
                    "stock snapshot capacity mismatch for slot {}",
                    slot.slot_code
                )));
            }

            let raw_saleable_stock = slot.available_qty.min(*capacity).max(0);
            let slot_sales_state = match slot.slot_sales_state.as_deref() {
                Some(state) if !is_supported_slot_sales_state(state) => {
                    return Err(StoreError::InvalidStockInput(format!(
                        "stock snapshot unsupported slot sales state {} for slot {}",
                        state, slot.slot_code
                    )));
                }
                Some("sale_ready") if raw_saleable_stock <= 0 => "sold_out",
                Some(state) => state,
                None if raw_saleable_stock > 0 => "sale_ready",
                None => "sold_out",
            };
            let saleable_stock = if slot_sales_state == "sale_ready" {
                raw_saleable_stock
            } else {
                0
            };
            upsert_stock_projection_with_state_in_tx(
                &mut tx,
                &snapshot.planogram_version,
                &slot.slot_id,
                slot.on_hand_qty,
                saleable_stock,
                slot_sales_state,
                false,
            )
            .await?;
            upsert_sale_view_projection_in_tx(&mut tx, &snapshot.planogram_version, &slot.slot_id)
                .await?;
        }

        tx.commit().await?;
        self.sale_view(Some(snapshot.machine_code.clone())).await
    }

    pub async fn block_slot_for_dispense_failure(
        &self,
        command: &DispenseCommandPayload,
        error_code: Option<&str>,
        message: Option<&str>,
    ) -> Result<Option<SaleViewSnapshot>, StoreError> {
        let slot_sales_state = match error_code {
            Some("NO_DROP") => "suspect",
            _ => "frozen",
        };
        if is_whole_machine_dispense_failure(error_code, message) {
            self.put_metadata(
                WHOLE_MACHINE_MAINTENANCE_LOCK_KEY,
                &WholeMachineMaintenanceLock {
                    code: "WHOLE_MACHINE_HARDWARE_FAULT".to_string(),
                    message: message
                        .filter(|value| !value.trim().is_empty())
                        .unwrap_or("dispense hardware fault requires operator reset")
                        .to_string(),
                    source: "dispense_failure".to_string(),
                    order_no: command.order_no.clone(),
                    command_no: command.command_no.clone(),
                    slot_code: command.slot.slot_code.clone(),
                    error_code: error_code.map(ToString::to_string),
                    created_at: now_iso(),
                },
            )
            .await?;
        }
        self.block_command_slot(command, slot_sales_state, "dispense_failure")
            .await
    }

    pub async fn apply_dispense_success_to_local_stock(
        &self,
        command: &DispenseCommandPayload,
    ) -> Result<Option<SaleViewSnapshot>, StoreError> {
        if command.quantity == 0 {
            return Ok(None);
        }

        let mut tx = self.pool.begin().await?;
        let row: Option<(String, String, String, i64, String, String, i64)> = sqlx::query_as(
            "SELECT s.planogram_version, s.slot_id, s.slot_code, s.capacity, s.inventory_id, s.variant_id, c.physical_stock
             FROM machine_planogram_slots s
             JOIN machine_planogram_versions v
               ON v.planogram_version = s.planogram_version AND v.active = 1
             JOIN current_stock_projection c
               ON c.planogram_version = s.planogram_version AND c.slot_id = s.slot_id
             WHERE s.slot_code = ?1 AND s.layer_no = ?2 AND s.cell_no = ?3
             LIMIT 1",
        )
        .bind(&command.slot.slot_code)
        .bind(command.slot.layer_no)
        .bind(command.slot.cell_no)
        .fetch_optional(tx.as_mut())
        .await?;

        let Some((
            planogram_version,
            slot_id,
            slot_code,
            capacity,
            inventory_id,
            variant_id,
            physical_stock,
        )) = row
        else {
            return Ok(None);
        };

        let dispense_quantity = i64::from(command.quantity);
        let after_quantity = physical_stock - dispense_quantity;
        let occurred_at = now_iso();
        let slot_mapping_snapshot = serde_json::json!({
            "slotCode": slot_code,
            "capacity": capacity,
            "inventoryId": inventory_id,
            "variantId": variant_id,
        });
        sqlx::query(
            "INSERT INTO stock_movements(
               movement_id,planogram_version,slot_id,movement_type,quantity,
               before_quantity,after_quantity,slot_mapping_snapshot_json,
               source,attributed_to,occurred_at
             ) VALUES (?1,?2,?3,'dispense_succeeded',?4,?5,?6,?7,'vending_command',?8,?9)",
        )
        .bind(format!("dispense:{}", command.command_no))
        .bind(&planogram_version)
        .bind(&slot_id)
        .bind(dispense_quantity)
        .bind(physical_stock)
        .bind(after_quantity)
        .bind(slot_mapping_snapshot.to_string())
        .bind(&command.order_no)
        .bind(&occurred_at)
        .execute(tx.as_mut())
        .await?;
        upsert_stock_projection_in_tx(
            &mut tx,
            &planogram_version,
            &slot_id,
            after_quantity,
            capacity,
            false,
        )
        .await?;
        upsert_sale_view_projection_in_tx(&mut tx, &planogram_version, &slot_id).await?;
        tx.commit().await?;
        Ok(Some(self.sale_view(None).await?))
    }

    pub async fn block_slot_for_dispense_result_unknown(
        &self,
        command: &DispenseCommandPayload,
    ) -> Result<Option<SaleViewSnapshot>, StoreError> {
        self.block_command_slot(command, "frozen", "dispense_result_unknown")
            .await
    }

    async fn block_command_slot(
        &self,
        command: &DispenseCommandPayload,
        slot_sales_state: &str,
        source: &str,
    ) -> Result<Option<SaleViewSnapshot>, StoreError> {
        let row: Option<(String, String)> = sqlx::query_as(
            "SELECT v.planogram_version, s.slot_id
             FROM machine_planogram_slots s
             JOIN machine_planogram_versions v
               ON v.planogram_version = s.planogram_version AND v.active = 1
             WHERE s.slot_code = ?1 AND s.layer_no = ?2 AND s.cell_no = ?3
             LIMIT 1",
        )
        .bind(&command.slot.slot_code)
        .bind(command.slot.layer_no)
        .bind(command.slot.cell_no)
        .fetch_optional(&self.pool)
        .await?;

        let Some((planogram_version, slot_id)) = row else {
            return Ok(None);
        };

        let snapshot = self
            .update_slot_sales_state(SlotSalesStateInput {
                planogram_version,
                slot_id,
                slot_sales_state: slot_sales_state.to_string(),
                source: source.to_string(),
            })
            .await?;
        Ok(Some(snapshot))
    }

    pub async fn update_slot_sales_state(
        &self,
        input: SlotSalesStateInput,
    ) -> Result<SaleViewSnapshot, StoreError> {
        if !is_supported_slot_sales_state(&input.slot_sales_state) {
            return Err(StoreError::InvalidStockInput(format!(
                "unsupported slot sales state {}",
                input.slot_sales_state
            )));
        }

        let mut tx = self.pool.begin().await?;
        let slot_exists: Option<(i64,)> = sqlx::query_as(
            "SELECT 1
             FROM machine_planogram_slots s
             JOIN machine_planogram_versions v
               ON v.planogram_version = s.planogram_version AND v.active = 1
             WHERE s.planogram_version = ?1 AND s.slot_id = ?2",
        )
        .bind(&input.planogram_version)
        .bind(&input.slot_id)
        .fetch_optional(tx.as_mut())
        .await?;
        if slot_exists.is_none() {
            return Err(StoreError::InvalidStockInput(
                "slot is not in the active planogram version".to_string(),
            ));
        }

        if is_reconciliation_sale_safety_blocker(&input.slot_sales_state) {
            upsert_sale_safety_blocker_marker_in_tx(
                &mut tx,
                &input.planogram_version,
                &input.slot_id,
                &input.slot_sales_state,
                "field_action",
                &input.source,
            )
            .await?;
        } else {
            clear_sale_safety_blocker_marker_in_tx(
                &mut tx,
                &input.planogram_version,
                &input.slot_id,
            )
            .await?;
        }

        let updated = sqlx::query(
            "UPDATE current_stock_projection
             SET slot_sales_state = ?3, updated_at = ?4
             WHERE planogram_version = ?1 AND slot_id = ?2",
        )
        .bind(&input.planogram_version)
        .bind(&input.slot_id)
        .bind(&input.slot_sales_state)
        .bind(now_iso())
        .execute(tx.as_mut())
        .await?
        .rows_affected();
        if updated == 0 {
            return Err(StoreError::InvalidStockInput(
                "slot stock projection is missing".to_string(),
            ));
        }

        upsert_sale_view_projection_in_tx(&mut tx, &input.planogram_version, &input.slot_id)
            .await?;
        tx.commit().await?;
        self.sale_view(None).await
    }

    pub async fn sale_view(
        &self,
        machine_code: Option<String>,
    ) -> Result<SaleViewSnapshot, StoreError> {
        let active: Option<(String,)> = sqlx::query_as(
            "SELECT planogram_version FROM machine_planogram_versions WHERE active = 1 LIMIT 1",
        )
        .fetch_optional(&self.pool)
        .await?;
        let Some((planogram_version,)) = active else {
            return Ok(SaleViewSnapshot {
                items: vec![],
                source: "local_stock".to_string(),
                planogram_version: None,
                last_updated_at: None,
            });
        };

        let rows: Vec<(String, String)> = sqlx::query_as(
            "SELECT item_json, updated_at
             FROM sale_view_projection
             WHERE planogram_version = ?1
             ORDER BY slot_id ASC",
        )
        .bind(&planogram_version)
        .fetch_all(&self.pool)
        .await?;

        let mut items = Vec::with_capacity(rows.len());
        let mut last_updated_at = None;
        for (json, updated_at) in rows {
            let mut item: SaleViewItem = match serde_json::from_str(&json) {
                Ok(item) => item,
                Err(error) => {
                    eprintln!("sale view projection was malformed and has been omitted: {error}");
                    continue;
                }
            };
            item.machine_code = machine_code.clone();
            last_updated_at = Some(updated_at);
            items.push(item);
        }
        items.sort_by(|left, right| {
            left.product_sort_order
                .cmp(&right.product_sort_order)
                .then_with(|| left.slot_code.cmp(&right.slot_code))
        });
        let reservations = self.active_order_reservations().await?;
        apply_active_order_reservations(&mut items, &reservations);

        Ok(SaleViewSnapshot {
            items,
            source: "local_stock".to_string(),
            planogram_version: Some(planogram_version),
            last_updated_at,
        })
    }

    async fn active_order_reservations(&self) -> Result<Vec<LocalStockReservation>, StoreError> {
        let now = now_iso();
        let rows: Vec<(String, String, String, Option<String>)> = sqlx::query_as(
            "SELECT items_json, status, next_action, expires_at
             FROM order_sessions
             WHERE status != 'closed'
             ORDER BY updated_at DESC, rowid DESC
             LIMIT 1",
        )
        .fetch_all(&self.pool)
        .await?;

        let mut reservations = Vec::new();
        for (items_json, status, next_action, expires_at) in rows {
            if !order_session_reserves_local_stock(
                &status,
                &next_action,
                expires_at.as_deref(),
                &now,
            ) {
                continue;
            }
            let value = serde_json::from_str::<serde_json::Value>(&items_json)?;
            collect_local_stock_reservations(&value, &mut reservations);
        }
        Ok(reservations)
    }

    pub async fn record_stock_movement_upload_response(
        &self,
        event: &OutboxRecord,
        response: &crate::backend::StockMovementUploadResponse,
    ) -> Result<(), StoreError> {
        let movement_id = response.movement_id.as_str();
        let attempts = event.attempt_count + 1;
        let status = match response.status.as_str() {
            "accepted" | "already_accepted" => "accepted",
            "rejected" => "rejected",
            "reconciliation" => "reconciliation",
            _ => "reconciliation",
        };
        let accepted_at = if status == "accepted" {
            response.accepted_at.clone().or_else(|| Some(now_iso()))
        } else {
            None
        };
        let receipt_json = serde_json::to_string(response)?;
        let rejection_json = if status == "accepted" {
            None
        } else {
            Some(receipt_json.clone())
        };

        let mut tx = self.pool.begin().await?;
        let sync_result = sqlx::query(
            "UPDATE stock_movement_sync
             SET status = ?2,
                 attempt_count = ?3,
                 last_error = NULL,
                 accepted_at = ?4,
                 platform_receipt_json = ?5,
                 rejection_json = ?6,
                 updated_at = ?7
             WHERE movement_id = ?1",
        )
        .bind(movement_id)
        .bind(status)
        .bind(attempts)
        .bind(accepted_at)
        .bind(&receipt_json)
        .bind(rejection_json)
        .bind(now_iso())
        .execute(tx.as_mut())
        .await?;
        if sync_result.rows_affected() != 1 {
            return Err(StoreError::Sqlx(sqlx::Error::RowNotFound));
        }
        if let Some(blocker) = response
            .reconciliation
            .as_ref()
            .and_then(|reconciliation| reconciliation.sale_safety_blocker.as_ref())
        {
            apply_sale_safety_blocker_in_tx(&mut tx, blocker).await?;
        }
        sqlx::query("DELETE FROM outbox_events WHERE id = ?1")
            .bind(&event.id)
            .execute(tx.as_mut())
            .await?;
        tx.commit().await?;
        self.finalize_pending_physical_stock_attestation_if_accepted()
            .await?;
        Ok(())
    }

    pub async fn stock_movement_sync_record(
        &self,
        movement_id: &str,
    ) -> Result<Option<StockMovementSyncRecord>, StoreError> {
        let row: Option<StockMovementSyncRecordRow> = sqlx::query_as(
            "SELECT movement_id,status,outbox_event_id,attempt_count,last_error,accepted_at,platform_receipt_json,rejection_json,created_at,updated_at
             FROM stock_movement_sync WHERE movement_id = ?1",
        )
        .bind(movement_id)
        .fetch_optional(&self.pool)
        .await?;

        row.map(to_stock_movement_sync_record).transpose()
    }

    pub async fn prune_stock_movement_history(&self) -> Result<u64, StoreError> {
        self.prune_accepted_stock_movement_history(STOCK_MOVEMENT_RETENTION_DAYS)
            .await
    }

    pub async fn prune_accepted_stock_movement_history(
        &self,
        retention_days: i64,
    ) -> Result<u64, StoreError> {
        let retention_days = retention_days.clamp(
            crate::config::STOCK_MOVEMENT_RETENTION_MIN_DAYS,
            crate::config::STOCK_MOVEMENT_RETENTION_MAX_DAYS,
        );
        let cutoff = (Utc::now() - chrono::Duration::days(retention_days))
            .to_rfc3339_opts(SecondsFormat::Millis, true);
        let mut tx = self.begin_immediate_write_transaction().await?;
        let pending_attestation: Option<(String,)> =
            sqlx::query_as("SELECT value_json FROM runtime_metadata WHERE key = ?1")
                .bind(PENDING_PHYSICAL_STOCK_ATTESTATION_KEY)
                .fetch_optional(tx.as_mut())
                .await?;
        let pending_attestation = pending_attestation
            .map(|(value_json,)| {
                serde_json::from_str::<PendingPhysicalStockAttestation>(&value_json)
            })
            .transpose()?;
        let protected_movement_ids: HashSet<String> = pending_attestation
            .as_ref()
            .map(|pending| pending.movement_ids.iter().cloned().collect())
            .unwrap_or_default();
        let mut protected_task_ids = HashSet::new();
        for key in [
            STOCK_MAINTENANCE_COUNT_TASK_KEY,
            STOCK_MAINTENANCE_REFILL_TASK_KEY,
        ] {
            let current: Option<(String,)> =
                sqlx::query_as("SELECT value_json FROM runtime_metadata WHERE key=?1")
                    .bind(key)
                    .fetch_optional(tx.as_mut())
                    .await?;
            if let Some((value,)) = current {
                protected_task_ids
                    .insert(serde_json::from_str::<StockMaintenanceTaskIdentity>(&value)?.task_id);
            }
        }
        let mut pending_generations = HashSet::new();
        if let Some(pending) = pending_attestation.as_ref() {
            protected_task_ids.insert(pending.input.attestation_id.clone());
            pending_generations.insert(pending.input.attestation_id.clone());
            for generation in &pending.slot_generations {
                protected_task_ids.insert(generation.generation.clone());
                pending_generations.insert(generation.generation.clone());
            }
        }
        let old_identities: Vec<(String, String, String)> = sqlx::query_as(
            "SELECT task_id,identity_json,created_at
             FROM stock_maintenance_task_identities WHERE created_at < ?1",
        )
        .bind(&cutoff)
        .fetch_all(tx.as_mut())
        .await?;
        let mut task_ids_to_prune = Vec::new();
        for (task_id, identity_json, _) in old_identities {
            let identity: StockMaintenanceTaskIdentity = serde_json::from_str(&identity_json)?;
            if protected_task_ids.contains(&task_id)
                || identity
                    .predecessor_task_id
                    .as_ref()
                    .is_some_and(|predecessor| pending_generations.contains(predecessor))
            {
                continue;
            }
            let recent_batch: Option<(i64,)> = sqlx::query_as(
                "SELECT 1 FROM stock_maintenance_batches
                 WHERE task_id=?1 AND created_at >= ?2",
            )
            .bind(&task_id)
            .bind(&cutoff)
            .fetch_optional(tx.as_mut())
            .await?;
            if recent_batch.is_some() {
                continue;
            }
            let sync_counts: (i64, i64) = sqlx::query_as(
                "SELECT COUNT(1),
                        COALESCE(SUM(CASE WHEN status != 'accepted' THEN 1 ELSE 0 END),0)
                 FROM stock_movement_sync WHERE movement_id LIKE ?1",
            )
            .bind(format!("{}:%", task_id))
            .fetch_one(tx.as_mut())
            .await?;
            let upload_outbox: Option<(i64,)> = sqlx::query_as(
                "SELECT 1 FROM outbox_events
                 WHERE kind='stock_movement_upload' AND id LIKE ?1 LIMIT 1",
            )
            .bind(format!("stock-movement:{}:%", task_id))
            .fetch_optional(tx.as_mut())
            .await?;
            if sync_counts.0 == 0 {
                if upload_outbox.is_some() {
                    continue;
                }
                task_ids_to_prune.push(task_id);
                continue;
            }
            if sync_counts.1 != 0 {
                continue;
            }
            if upload_outbox.is_some() {
                continue;
            }
            task_ids_to_prune.push(task_id);
        }

        let pruned_at = now_iso();
        let tombstone_expires_at = (Utc::now() + chrono::Duration::days(retention_days))
            .to_rfc3339_opts(SecondsFormat::Millis, true);
        sqlx::query("DELETE FROM stock_maintenance_task_tombstones WHERE expires_at < ?1")
            .bind(&pruned_at)
            .execute(tx.as_mut())
            .await?;
        for task_id in task_ids_to_prune {
            sqlx::query(
                "INSERT INTO stock_maintenance_task_tombstones(task_id,pruned_at,expires_at)
                 VALUES (?1,?2,?3)
                 ON CONFLICT(task_id) DO UPDATE SET pruned_at=excluded.pruned_at,expires_at=excluded.expires_at",
            )
            .bind(&task_id)
            .bind(&pruned_at)
            .bind(&tombstone_expires_at)
            .execute(tx.as_mut())
            .await?;
            // The v15 FK is RESTRICT: delete the dependent immutable batch
            // first so an interrupted or reordered cleanup cannot orphan it.
            sqlx::query("DELETE FROM stock_maintenance_batches WHERE task_id=?1")
                .bind(&task_id)
                .execute(tx.as_mut())
                .await?;
            sqlx::query("DELETE FROM stock_maintenance_task_identities WHERE task_id=?1")
                .bind(&task_id)
                .execute(tx.as_mut())
                .await?;
        }
        let movement_ids: Vec<(String,)> = sqlx::query_as(
            "SELECT movement_id
             FROM stock_movement_sync
             WHERE status = 'accepted' AND COALESCE(accepted_at, updated_at) < ?1",
        )
        .bind(&cutoff)
        .fetch_all(tx.as_mut())
        .await?;

        let mut pruned = 0_u64;
        for (movement_id,) in movement_ids {
            if protected_movement_ids.contains(&movement_id) {
                continue;
            }
            sqlx::query("DELETE FROM stock_movement_sync WHERE movement_id = ?1")
                .bind(&movement_id)
                .execute(tx.as_mut())
                .await?;
            let deleted = sqlx::query("DELETE FROM stock_movements WHERE movement_id = ?1")
                .bind(&movement_id)
                .execute(tx.as_mut())
                .await?
                .rows_affected();
            pruned += deleted;
        }
        tx.commit().await?;
        Ok(pruned)
    }

    pub async fn append_health_event(
        &self,
        event: &vending_core::health::ComponentHealth,
    ) -> Result<(), StoreError> {
        sqlx::query(
            "INSERT INTO health_events(id,component,level,code,message,context_json,occurred_at,recovered_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,NULL)",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(&event.component)
        .bind(to_health_level_string(event.level.clone()))
        .bind(&event.code)
        .bind(&event.message)
        .bind(serde_json::json!({}).to_string())
        .bind(&event.updated_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn prune_outbox(&self) -> Result<(u64, u64), StoreError> {
        let deleted_expired = sqlx::query(
            "DELETE FROM outbox_events
             WHERE expires_at < ?1
               AND kind != 'stock_movement_upload'
               AND (topic IS NULL OR topic NOT LIKE '%/events/secure-decommission-result')",
        )
        .bind(now_iso())
        .execute(&self.pool)
        .await?
        .rows_affected();

        let deleted_oversize = sqlx::query(
            "DELETE FROM outbox_events
             WHERE id IN (
               SELECT id FROM outbox_events
               WHERE kind != 'stock_movement_upload'
                 AND (topic IS NULL OR topic NOT LIKE '%/events/secure-decommission-result')
               ORDER BY priority ASC, created_at DESC
               LIMIT -1 OFFSET ?1
             )",
        )
        .bind(OUTBOX_MAX_EVENTS)
        .execute(&self.pool)
        .await?
        .rows_affected();

        Ok((deleted_expired, deleted_oversize))
    }

    pub async fn load_attempt_json(
        &self,
        order_no: &str,
    ) -> Result<Option<serde_json::Map<String, serde_json::Value>>, StoreError> {
        let value: Option<(Option<String>,)> =
            sqlx::query_as("SELECT payment_attempt_json FROM order_sessions WHERE order_no = ?1")
                .bind(order_no)
                .fetch_optional(&self.pool)
                .await?;

        let Some((json,)) = value else {
            return Ok(None);
        };
        let Some(json) = json else {
            return Ok(None);
        };
        let value = serde_json::from_str::<serde_json::Value>(&json)?;
        Ok(value.as_object().cloned())
    }
}

async fn open_sqlite_pool(path: &Path) -> Result<SqlitePool, sqlx::Error> {
    let url = format!("sqlite://{}?mode=rwc", path.display());
    SqlitePoolOptions::new()
        .max_connections(5)
        .connect(&url)
        .await
}

async fn quarantine_sqlite_file(path: &Path) -> Result<std::path::PathBuf, StoreError> {
    let quarantine = path.with_extension(format!("corrupt-{}.db", Utc::now().timestamp_millis()));
    tokio::fs::rename(path, &quarantine)
        .await
        .map_err(sqlx::Error::Io)?;

    for suffix in ["-wal", "-shm"] {
        let sidecar = std::path::PathBuf::from(format!("{}{}", path.display(), suffix));
        if sidecar.try_exists().map_err(sqlx::Error::Io)? {
            let quarantine_sidecar =
                std::path::PathBuf::from(format!("{}{}", quarantine.display(), suffix));
            tokio::fs::rename(sidecar, quarantine_sidecar)
                .await
                .map_err(sqlx::Error::Io)?;
        }
    }
    Ok(quarantine)
}

async fn run_integrity_check(pool: &SqlitePool) -> Result<(), String> {
    let row: (String,) = sqlx::query_as("PRAGMA integrity_check")
        .fetch_one(pool)
        .await
        .map_err(|error| error.to_string())?;
    if row.0 == "ok" {
        Ok(())
    } else {
        Err(row.0)
    }
}

fn is_unique_constraint_violation(error: &sqlx::Error) -> bool {
    match error {
        sqlx::Error::Database(err) => {
            let msg = err.message().to_lowercase();
            msg.contains("constraint") && msg.contains("unique")
        }
        _ => false,
    }
}

fn normalize_planogram_slots(
    slots: &[MachinePlanogramSlotInput],
) -> Vec<MachinePlanogramSlotInput> {
    let mut slots = slots.to_vec();
    slots.sort_by(|left, right| left.slot_id.cmp(&right.slot_id));
    slots
}

async fn planogram_slots_match_in_tx(
    tx: &mut Transaction<'_, sqlx::Sqlite>,
    planogram_version: &str,
    input_slots: &[MachinePlanogramSlotInput],
) -> Result<bool, StoreError> {
    let rows = sqlx::query(
        "SELECT
           slot_id,slot_code,layer_no,cell_no,capacity,par_level,
           inventory_id,variant_id,product_id,product_name,product_description,cover_image_url,
           try_on_silhouette_url,category_id,category_name,sku,size,color,price_cents,
           product_sort_order,target_gender
         FROM machine_planogram_slots
         WHERE planogram_version = ?1
         ORDER BY slot_id ASC",
    )
    .bind(planogram_version)
    .fetch_all(tx.as_mut())
    .await?;

    let mut existing = Vec::with_capacity(rows.len());
    for row in rows {
        existing.push(MachinePlanogramSlotInput {
            slot_id: row.try_get("slot_id")?,
            slot_code: row.try_get("slot_code")?,
            layer_no: row.try_get("layer_no")?,
            cell_no: row.try_get("cell_no")?,
            capacity: row.try_get("capacity")?,
            par_level: row.try_get("par_level")?,
            inventory_id: row.try_get("inventory_id")?,
            variant_id: row.try_get("variant_id")?,
            product_id: row.try_get("product_id")?,
            product_name: row.try_get("product_name")?,
            product_description: row.try_get("product_description")?,
            cover_image_url: row.try_get("cover_image_url")?,
            try_on_silhouette_url: row.try_get("try_on_silhouette_url")?,
            category_id: row.try_get("category_id")?,
            category_name: row.try_get("category_name")?,
            sku: row.try_get("sku")?,
            size: row.try_get("size")?,
            color: row.try_get("color")?,
            price_cents: row.try_get("price_cents")?,
            product_sort_order: row.try_get("product_sort_order")?,
            target_gender: row.try_get("target_gender")?,
        });
    }

    Ok(existing == normalize_planogram_slots(input_slots))
}

fn is_supported_slot_sales_state(value: &str) -> bool {
    matches!(
        value,
        "sale_ready"
            | "sold_out"
            | "suspect"
            | "frozen"
            | "needs_count"
            | "blocked_for_planogram_change"
            | "movement_rejected"
            | "needs_platform_review"
    )
}

fn is_whole_machine_dispense_failure(error_code: Option<&str>, message: Option<&str>) -> bool {
    match error_code {
        Some("JAMMED" | "MOTOR_TIMEOUT") => true,
        _ => {
            let message = message.unwrap_or_default().to_ascii_lowercase();
            message.contains("mechanical fault")
                || message.contains("pickup platform blocked")
                || message.contains("heartbeat missing")
                || message.contains("timed out before completion")
        }
    }
}

pub fn classify_whole_machine_hardware_status_fault(
    status: &HardwareStatus,
) -> Option<&'static str> {
    if status.online {
        return None;
    }
    let message = status.message.to_ascii_lowercase();
    if message.contains("mechanical fault") || message.contains("pickup platform blocked") {
        Some("JAMMED")
    } else {
        None
    }
}

struct PreviousSlotProjection {
    slot_id: String,
    physical_stock: i64,
    slot_sales_state: String,
    inventory_id: String,
    variant_id: String,
    product_id: String,
    sale_safety_blocker_state: Option<String>,
}

impl PreviousSlotProjection {
    fn has_same_mapping(&self, slot: &MachinePlanogramSlotInput) -> bool {
        self.inventory_id == slot.inventory_id
            && self.variant_id == slot.variant_id
            && self.product_id == slot.product_id
    }

    fn has_sale_safety_blocker(&self) -> bool {
        self.sale_safety_blocker_state.is_some()
    }
}

async fn current_slot_projections_in_tx(
    tx: &mut Transaction<'_, sqlx::Sqlite>,
) -> Result<Vec<PreviousSlotProjection>, StoreError> {
    let rows: Vec<PreviousSlotProjectionRow> = sqlx::query_as(
        "SELECT
           c.slot_id,
           c.physical_stock,
           c.slot_sales_state,
           s.inventory_id,
           s.variant_id,
           s.product_id,
           b.slot_sales_state AS sale_safety_blocker_state
         FROM current_stock_projection c
         JOIN machine_planogram_slots s
           ON s.planogram_version = c.planogram_version AND s.slot_id = c.slot_id
         JOIN machine_planogram_versions v
           ON v.planogram_version = c.planogram_version AND v.active = 1
         LEFT JOIN sale_safety_blockers b
           ON b.planogram_version = c.planogram_version AND b.slot_id = c.slot_id",
    )
    .fetch_all(tx.as_mut())
    .await?;

    Ok(rows
        .into_iter()
        .map(
            |(
                slot_id,
                physical_stock,
                slot_sales_state,
                inventory_id,
                variant_id,
                product_id,
                sale_safety_blocker_state,
            )| {
                PreviousSlotProjection {
                    slot_id,
                    physical_stock,
                    slot_sales_state,
                    inventory_id,
                    variant_id,
                    product_id,
                    sale_safety_blocker_state,
                }
            },
        )
        .collect())
}

fn is_reconciliation_sale_safety_blocker(value: &str) -> bool {
    matches!(
        value,
        "needs_count"
            | "blocked_for_planogram_change"
            | "movement_rejected"
            | "needs_platform_review"
    )
}

fn stock_reconciliation_reason(value: &str) -> Option<String> {
    let value = serde_json::from_str::<serde_json::Value>(value).ok()?;
    value
        .pointer("/reconciliation/reason")
        .or_else(|| value.pointer("/rejection/reason"))
        .or_else(|| value.get("reason"))
        .and_then(serde_json::Value::as_str)
        .map(ToString::to_string)
}

async fn upsert_sale_safety_blocker_marker_in_tx(
    tx: &mut Transaction<'_, sqlx::Sqlite>,
    planogram_version: &str,
    slot_id: &str,
    slot_sales_state: &str,
    reason: &str,
    source: &str,
) -> Result<(), StoreError> {
    sqlx::query(
        "INSERT INTO sale_safety_blockers(
           planogram_version,slot_id,slot_sales_state,reason,source,updated_at
         ) VALUES (?1,?2,?3,?4,?5,?6)
         ON CONFLICT(planogram_version, slot_id) DO UPDATE SET
           slot_sales_state=excluded.slot_sales_state,
           reason=excluded.reason,
           source=excluded.source,
           updated_at=excluded.updated_at",
    )
    .bind(planogram_version)
    .bind(slot_id)
    .bind(slot_sales_state)
    .bind(reason)
    .bind(source)
    .bind(now_iso())
    .execute(tx.as_mut())
    .await?;
    Ok(())
}

async fn clear_sale_safety_blocker_marker_in_tx(
    tx: &mut Transaction<'_, sqlx::Sqlite>,
    planogram_version: &str,
    slot_id: &str,
) -> Result<(), StoreError> {
    sqlx::query("DELETE FROM sale_safety_blockers WHERE planogram_version = ?1 AND slot_id = ?2")
        .bind(planogram_version)
        .bind(slot_id)
        .execute(tx.as_mut())
        .await?;
    Ok(())
}

async fn clear_stock_ledger_loss_blocker_in_tx(
    tx: &mut Transaction<'_, sqlx::Sqlite>,
    planogram_version: &str,
    slot_id: &str,
) -> Result<(), StoreError> {
    sqlx::query(
        "DELETE FROM sale_safety_blockers
         WHERE planogram_version = ?1 AND slot_id = ?2 AND reason = 'stock_ledger_loss'",
    )
    .bind(planogram_version)
    .bind(slot_id)
    .execute(tx.as_mut())
    .await?;
    Ok(())
}

async fn upsert_stock_projection_in_tx(
    tx: &mut Transaction<'_, sqlx::Sqlite>,
    planogram_version: &str,
    slot_id: &str,
    physical_stock: i64,
    capacity: i64,
    reset_local_slot_hold: bool,
) -> Result<(), StoreError> {
    let physical_stock = physical_stock.max(0);
    let saleable_stock = physical_stock.min(capacity).max(0);
    let slot_sales_state = if saleable_stock > 0 {
        "sale_ready"
    } else {
        "sold_out"
    };
    upsert_stock_projection_with_state_in_tx(
        tx,
        planogram_version,
        slot_id,
        physical_stock,
        saleable_stock,
        slot_sales_state,
        reset_local_slot_hold,
    )
    .await
}

async fn upsert_stock_projection_with_state_in_tx(
    tx: &mut Transaction<'_, sqlx::Sqlite>,
    planogram_version: &str,
    slot_id: &str,
    physical_stock: i64,
    saleable_stock: i64,
    slot_sales_state: &str,
    reset_local_slot_hold: bool,
) -> Result<(), StoreError> {
    let updated_at = now_iso();
    sqlx::query(
        "INSERT INTO current_stock_projection(
           planogram_version,slot_id,physical_stock,saleable_stock,slot_sales_state,updated_at
         ) VALUES (?1,?2,?3,?4,?5,?6)
         ON CONFLICT(slot_id) DO UPDATE SET
           planogram_version=excluded.planogram_version,
           physical_stock=excluded.physical_stock,
           saleable_stock=excluded.saleable_stock,
           slot_sales_state=CASE
             WHEN EXISTS (
               SELECT 1 FROM sale_safety_blockers b
               WHERE b.planogram_version = current_stock_projection.planogram_version
                 AND b.slot_id = current_stock_projection.slot_id
             ) THEN current_stock_projection.slot_sales_state
             WHEN ?7 = 0 AND current_stock_projection.slot_sales_state IN ('frozen','suspect') THEN current_stock_projection.slot_sales_state
             ELSE excluded.slot_sales_state
           END,
           updated_at=excluded.updated_at",
    )
    .bind(planogram_version)
    .bind(slot_id)
    .bind(physical_stock.max(0))
    .bind(saleable_stock.max(0))
    .bind(slot_sales_state)
    .bind(updated_at)
    .bind(if reset_local_slot_hold { 1_i64 } else { 0_i64 })
    .execute(tx.as_mut())
    .await?;
    Ok(())
}

async fn apply_sale_safety_blocker_in_tx(
    tx: &mut Transaction<'_, sqlx::Sqlite>,
    blocker: &crate::backend::StockMovementSaleSafetyBlocker,
) -> Result<(), StoreError> {
    if !is_supported_slot_sales_state(&blocker.slot_sales_state) {
        return Err(StoreError::InvalidStockInput(format!(
            "unsupported slot sales state {}",
            blocker.slot_sales_state
        )));
    }

    let active_projection: Option<(String,)> = sqlx::query_as(
        "SELECT c.planogram_version
         FROM current_stock_projection c
         JOIN machine_planogram_versions v
           ON v.planogram_version = c.planogram_version AND v.active = 1
         WHERE c.slot_id = ?1",
    )
    .bind(&blocker.slot_id)
    .fetch_optional(tx.as_mut())
    .await?;

    let Some((planogram_version,)) = active_projection else {
        return Ok(());
    };

    upsert_sale_safety_blocker_marker_in_tx(
        tx,
        &planogram_version,
        &blocker.slot_id,
        &blocker.slot_sales_state,
        &blocker.reason,
        "platform_reconciliation",
    )
    .await?;

    sqlx::query(
        "UPDATE current_stock_projection
         SET saleable_stock = 0, slot_sales_state = ?3, updated_at = ?4
         WHERE planogram_version = ?1 AND slot_id = ?2",
    )
    .bind(&planogram_version)
    .bind(&blocker.slot_id)
    .bind(&blocker.slot_sales_state)
    .bind(now_iso())
    .execute(tx.as_mut())
    .await?;
    upsert_sale_view_projection_in_tx(tx, &planogram_version, &blocker.slot_id).await
}

async fn upsert_sale_view_projection_in_tx(
    tx: &mut Transaction<'_, sqlx::Sqlite>,
    planogram_version: &str,
    slot_id: &str,
) -> Result<(), StoreError> {
    let row = sqlx::query(
        "SELECT
           s.slot_id,
           s.slot_code,
           s.layer_no,
           s.cell_no,
           s.inventory_id,
           s.variant_id,
           s.product_id,
           s.product_name,
           s.product_description,
           s.cover_image_url,
           s.try_on_silhouette_url,
           s.category_id,
           s.category_name,
           s.sku,
           s.size,
           s.color,
           s.price_cents,
           s.product_sort_order,
           s.target_gender,
           s.capacity,
           s.par_level,
           c.physical_stock,
           c.saleable_stock,
           c.slot_sales_state
         FROM machine_planogram_slots s
         JOIN current_stock_projection c
           ON c.planogram_version = s.planogram_version AND c.slot_id = s.slot_id
         WHERE s.planogram_version = ?1 AND s.slot_id = ?2",
    )
    .bind(planogram_version)
    .bind(slot_id)
    .fetch_one(tx.as_mut())
    .await?;

    let item = SaleViewItem {
        machine_code: None,
        slot_id: row.try_get("slot_id")?,
        slot_code: row.try_get("slot_code")?,
        layer_no: row.try_get("layer_no")?,
        cell_no: row.try_get("cell_no")?,
        inventory_id: row.try_get("inventory_id")?,
        variant_id: row.try_get("variant_id")?,
        product_id: row.try_get("product_id")?,
        product_name: row.try_get("product_name")?,
        product_description: row.try_get("product_description")?,
        cover_image_url: row.try_get("cover_image_url")?,
        try_on_silhouette_url: row.try_get("try_on_silhouette_url")?,
        category_id: row.try_get("category_id")?,
        category_name: row.try_get("category_name")?,
        sku: row.try_get("sku")?,
        size: row.try_get("size")?,
        color: row.try_get("color")?,
        price_cents: row.try_get("price_cents")?,
        product_sort_order: row.try_get("product_sort_order")?,
        target_gender: row.try_get("target_gender")?,
        capacity: row.try_get("capacity")?,
        par_level: row.try_get("par_level")?,
        physical_stock: row.try_get("physical_stock")?,
        saleable_stock: row.try_get("saleable_stock")?,
        slot_sales_state: row.try_get("slot_sales_state")?,
    };
    let updated_at = now_iso();
    sqlx::query(
        "INSERT INTO sale_view_projection(planogram_version,slot_id,item_json,slot_sales_state,updated_at)
         VALUES (?1,?2,?3,?4,?5)
         ON CONFLICT(slot_id) DO UPDATE SET
           planogram_version=excluded.planogram_version,
           item_json=excluded.item_json,
           slot_sales_state=excluded.slot_sales_state,
           updated_at=excluded.updated_at",
    )
    .bind(planogram_version)
    .bind(slot_id)
    .bind(serde_json::to_string(&item)?)
    .bind(&item.slot_sales_state)
    .bind(updated_at)
    .execute(tx.as_mut())
    .await?;
    Ok(())
}

async fn insert_outbox_in_tx(
    tx: &mut Transaction<'_, sqlx::Sqlite>,
    input: &OutboxInput,
) -> Result<(), StoreError> {
    let expires_at = now_iso_days(OUTBOX_TTL_DAYS);
    let created_at = now_iso();

    sqlx::query(
        "INSERT INTO outbox_events(id,kind,transport,topic,target_url,method,payload_json,priority,created_at,next_attempt_at,attempt_count,expires_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?9,0,?10)
         ON CONFLICT(id) DO UPDATE SET
             kind = excluded.kind,
             transport = excluded.transport,
             topic = excluded.topic,
             target_url = excluded.target_url,
             method = excluded.method,
             payload_json = excluded.payload_json,
             priority = excluded.priority,
             created_at = excluded.created_at,
             next_attempt_at = excluded.next_attempt_at",
    )
    .bind(&input.id)
    .bind(to_kind_string(input.kind))
    .bind(to_transport_string(input.transport))
    .bind(&input.topic)
    .bind(&input.target_url)
    .bind(&input.method)
    .bind(input.payload_json.to_string())
    .bind(input.priority)
    .bind(created_at)
    .bind(expires_at)
    .execute(tx.as_mut())
    .await?;

    Ok(())
}

async fn upsert_command_received_in_tx(
    tx: &mut Transaction<'_, sqlx::Sqlite>,
    command: &DispenseCommandPayload,
) -> Result<(), StoreError> {
    let command_json = serde_json::to_string(command)?;
    let expires_at = now_iso_days(COMMAND_LOG_TTL_DAYS);
    sqlx::query(
        "INSERT INTO command_log(command_no,order_no,command_payload_json,status,updated_at,expires_at)
         VALUES (?1,?2,?3,'received',?4,?5)
         ON CONFLICT(command_no) DO NOTHING",
    )
    .bind(&command.command_no)
    .bind(&command.order_no)
    .bind(command_json)
    .bind(now_iso())
    .bind(expires_at)
    .execute(tx.as_mut())
    .await?;
    Ok(())
}

fn to_status_string(status: CommandLogStatus) -> &'static str {
    match status {
        CommandLogStatus::Received => "received",
        CommandLogStatus::Acknowledged => "acknowledged",
        CommandLogStatus::Dispensing => "dispensing",
        CommandLogStatus::Succeeded => "succeeded",
        CommandLogStatus::Failed => "failed",
    }
}

fn to_kind_string(kind: OutboxKind) -> &'static str {
    match kind {
        OutboxKind::CommandAck => "command_ack",
        OutboxKind::DispenseResult => "dispense_result",
        OutboxKind::Heartbeat => "heartbeat",
        OutboxKind::RemoteOpResult => "remote_op_result",
        OutboxKind::LogExport => "log_export",
        OutboxKind::StockMovementUpload => "stock_movement_upload",
    }
}

fn to_transport_string(transport: OutboxTransport) -> &'static str {
    match transport {
        OutboxTransport::Mqtt => "mqtt",
        OutboxTransport::Http => "http",
    }
}

fn to_health_level_string(level: vending_core::health::HealthLevel) -> &'static str {
    match level {
        vending_core::health::HealthLevel::Ok => "ok",
        vending_core::health::HealthLevel::Degraded => "degraded",
        vending_core::health::HealthLevel::Offline => "offline",
        vending_core::health::HealthLevel::Error => "error",
    }
}

#[derive(Debug, Clone)]
struct LocalStockReservation {
    inventory_id: Option<String>,
    slot_id: Option<String>,
    slot_code: Option<String>,
    quantity: i64,
}

fn order_session_reserves_local_stock(
    status: &str,
    next_action: &str,
    expires_at: Option<&str>,
    now: &str,
) -> bool {
    if order_session_terminal_status(status) || order_session_terminal_next_action(next_action) {
        return false;
    }
    if matches!(status, "paid" | "dispensing") || matches!(next_action, "dispensing") {
        return true;
    }
    if expires_at.is_some_and(|value| !value.trim().is_empty() && value <= now) {
        return false;
    }
    matches!(
        status,
        "waiting_payment" | "pending_payment" | "payment_submitted" | "paid" | "dispensing"
    ) || matches!(
        next_action,
        "wait_payment" | "submit_payment" | "dispensing"
    )
}

fn order_session_expires_at(input: &OrderSessionUpsert<'_>) -> String {
    input
        .last_backend_status_json
        .as_ref()
        .and_then(|value| {
            value
                .pointer("/payment/expiresAt")
                .or_else(|| value.get("expiresAt"))
        })
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| now_iso_days(COMMAND_LOG_TTL_DAYS))
}

fn order_session_terminal_status(status: &str) -> bool {
    if matches!(
        status,
        "payment_expired"
            | "payment_failed"
            | "canceled"
            | "cancelled"
            | "failed"
            | "dispense_failed"
            | "fulfilled"
            | "succeeded"
            | "manual_handling"
            | "closed"
    ) {
        return true;
    }
    false
}

fn order_session_terminal_next_action(next_action: &str) -> bool {
    matches!(
        next_action,
        "success"
            | "payment_expired"
            | "payment_failed"
            | "dispense_failed"
            | "refund_pending"
            | "refunded"
            | "manual_handling"
            | "closed"
    )
}

fn collect_local_stock_reservations(
    value: &serde_json::Value,
    reservations: &mut Vec<LocalStockReservation>,
) {
    match value {
        serde_json::Value::Array(items) => {
            for item in items {
                collect_local_stock_reservations(item, reservations);
            }
        }
        serde_json::Value::Object(object) => {
            let quantity = object
                .get("quantity")
                .and_then(|value| value.as_i64())
                .unwrap_or(1);
            if quantity <= 0 {
                return;
            }
            let inventory_id = object
                .get("inventoryId")
                .and_then(|value| value.as_str())
                .map(ToString::to_string);
            let slot_id = object
                .get("slotId")
                .and_then(|value| value.as_str())
                .map(ToString::to_string);
            let slot_code = object
                .get("slotCode")
                .and_then(|value| value.as_str())
                .map(ToString::to_string);
            if inventory_id.is_some() || slot_id.is_some() || slot_code.is_some() {
                reservations.push(LocalStockReservation {
                    inventory_id,
                    slot_id,
                    slot_code,
                    quantity,
                });
            }
        }
        _ => {}
    }
}

fn apply_active_order_reservations(
    items: &mut [SaleViewItem],
    reservations: &[LocalStockReservation],
) {
    for item in items {
        let reserved_quantity: i64 = reservations
            .iter()
            .filter(|reservation| local_stock_reservation_matches_item(reservation, item))
            .map(|reservation| reservation.quantity)
            .sum();
        if reserved_quantity > 0 {
            item.saleable_stock = (item.saleable_stock - reserved_quantity).max(0);
        }
    }
}

fn local_stock_reservation_matches_item(
    reservation: &LocalStockReservation,
    item: &SaleViewItem,
) -> bool {
    if reservation
        .inventory_id
        .as_deref()
        .is_some_and(|inventory_id| inventory_id == item.inventory_id.as_str())
    {
        return true;
    }
    if reservation
        .slot_id
        .as_deref()
        .is_some_and(|slot_id| slot_id == item.slot_id.as_str())
    {
        return true;
    }
    reservation
        .slot_code
        .as_deref()
        .is_some_and(|slot_code| slot_code == item.slot_code.as_str())
}

fn to_order_session_record(row: OrderSessionRecordRow) -> OrderSessionRecord {
    let (
        order_no,
        payment_method,
        payment_provider,
        payment_attempt_json,
        items_json,
        status,
        next_action,
        expires_at,
        last_backend_status_json,
        last_error,
        recovery_strategy,
        updated_at,
    ) = row;
    OrderSessionRecord {
        order_no,
        payment_method,
        payment_provider,
        payment_attempt_json,
        items_json,
        status,
        next_action,
        expires_at,
        last_backend_status_json,
        last_error,
        recovery_strategy,
        updated_at,
    }
}

fn to_current_transaction_snapshot(
    row: OrderSessionRecord,
) -> Result<vending_core::domain::InternalCurrentTransactionSnapshot, StoreError> {
    let backend = row
        .last_backend_status_json
        .as_deref()
        .and_then(|value| serde_json::from_str::<serde_json::Value>(value).ok());
    let attempt = row
        .payment_attempt_json
        .as_deref()
        .and_then(|value| serde_json::from_str::<serde_json::Value>(value).ok());

    Ok(vending_core::domain::InternalCurrentTransactionSnapshot {
        order_id: backend
            .as_ref()
            .and_then(|v| v.get("orderId"))
            .and_then(|v| v.as_str())
            .map(ToString::to_string),
        order_no: Some(row.order_no),
        product_summary: serde_json::from_str::<serde_json::Value>(&row.items_json).ok(),
        payment_id: backend
            .as_ref()
            .and_then(|v| v.pointer("/payment/paymentId"))
            .or_else(|| backend.as_ref().and_then(|v| v.get("paymentId")))
            .and_then(|v| v.as_str())
            .map(ToString::to_string),
        payment_no: backend
            .as_ref()
            .and_then(|v| v.pointer("/payment/paymentNo"))
            .or_else(|| backend.as_ref().and_then(|v| v.get("paymentNo")))
            .and_then(|v| v.as_str())
            .map(ToString::to_string),
        payment_method: backend
            .as_ref()
            .and_then(|v| v.pointer("/payment/method"))
            .or_else(|| backend.as_ref().and_then(|v| v.get("paymentMethod")))
            .and_then(|v| v.as_str())
            .map(ToString::to_string)
            .or(Some(row.payment_method)),
        payment_provider: backend
            .as_ref()
            .and_then(|v| v.pointer("/payment/providerCode"))
            .or_else(|| backend.as_ref().and_then(|v| v.get("paymentProviderCode")))
            .and_then(|v| v.as_str())
            .map(ToString::to_string)
            .or(row.payment_provider),
        payment_url: backend
            .as_ref()
            .and_then(|v| v.pointer("/payment/paymentUrl"))
            .or_else(|| backend.as_ref().and_then(|v| v.get("paymentUrl")))
            .and_then(|v| v.as_str())
            .map(ToString::to_string),
        payment_status: backend
            .as_ref()
            .and_then(|v| v.pointer("/payment/status"))
            .and_then(|v| v.as_str())
            .map(ToString::to_string),
        order_status: backend
            .as_ref()
            .and_then(|v| v.get("orderStatus"))
            .and_then(|v| v.as_str())
            .or(Some(row.status.as_str()))
            .map(public_order_status),
        total_amount_cents: backend
            .as_ref()
            .and_then(|v| v.get("totalAmountCents"))
            .and_then(|v| v.as_i64()),
        vending: backend.as_ref().and_then(map_vending_summary),
        next_action: backend
            .as_ref()
            .and_then(|v| v.get("nextAction"))
            .and_then(|v| v.as_str())
            .or(Some(row.next_action.as_str()))
            .and_then(InternalCheckoutFlowAction::normalize_recovered),
        masked_auth_code: attempt
            .as_ref()
            .and_then(|v| v.get("maskedAuthCode"))
            .and_then(|v| v.as_str())
            .map(ToString::to_string),
        payment_code_attempt: attempt
            .as_ref()
            .map(map_payment_code_attempt_summary)
            .transpose()?,
        expires_at: backend
            .as_ref()
            .and_then(|v| v.pointer("/payment/expiresAt"))
            .or_else(|| backend.as_ref().and_then(|v| v.get("expiresAt")))
            .and_then(|v| v.as_str())
            .map(ToString::to_string)
            .or(row.expires_at),
        error_code: row
            .last_error
            .as_ref()
            .map(|_| "TRANSACTION_ERROR".to_string()),
        error_message: row.last_error,
        operator_hint: attempt
            .as_ref()
            .and_then(|v| v.get("message"))
            .and_then(|v| v.as_str())
            .map(ToString::to_string),
        updated_at: row.updated_at,
    })
}

fn map_vending_summary(
    value: &serde_json::Value,
) -> Option<vending_core::domain::InternalVendingCommandSummary> {
    let vending = value.get("vending")?;
    Some(vending_core::domain::InternalVendingCommandSummary {
        command_id: vending
            .get("commandId")
            .and_then(|v| v.as_str())
            .map(ToString::to_string),
        command_no: vending
            .get("commandNo")
            .and_then(|v| v.as_str())
            .map(ToString::to_string),
        status: vending
            .get("status")
            .and_then(|v| v.as_str())
            .map(ToString::to_string),
        last_error: vending
            .get("lastError")
            .and_then(|v| v.as_str())
            .map(ToString::to_string),
        pickup_reminder: vending.get("pickupReminder").and_then(|value| {
            Some(vending_core::domain::InternalPickupReminderSummary {
                stage: value
                    .get("stage")
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                level: value.get("level")?.as_str()?.to_string(),
                message: value.get("message")?.as_str()?.to_string(),
                warning_no: value
                    .get("warningNo")
                    .and_then(|v| v.as_u64())
                    .and_then(|v| u8::try_from(v).ok()),
                reported_at: value.get("reportedAt")?.as_str()?.to_string(),
            })
        }),
    })
}

fn map_payment_code_attempt_summary(
    value: &serde_json::Value,
) -> Result<vending_core::domain::InternalPaymentCodeAttemptSummary, StoreError> {
    Ok(vending_core::domain::InternalPaymentCodeAttemptSummary {
        attempt_no: value.get("attemptNo").and_then(|v| v.as_i64()),
        status: value
            .get("status")
            .and_then(|v| v.as_str())
            .map(ToString::to_string),
        masked_auth_code: value
            .get("maskedAuthCode")
            .and_then(|v| v.as_str())
            .map(ToString::to_string),
        source: value
            .get("source")
            .and_then(|v| v.as_str())
            .map(ToString::to_string),
        idempotency_key: value
            .get("idempotencyKey")
            .and_then(|v| v.as_str())
            .map(ToString::to_string),
        submitted_at: value
            .get("submittedAt")
            .and_then(|v| v.as_str())
            .map(ToString::to_string),
        last_checked_at: value
            .get("lastCheckedAt")
            .and_then(|v| v.as_str())
            .map(ToString::to_string),
        can_retry: value
            .get("canRetry")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        message: value
            .get("message")
            .and_then(|v| v.as_str())
            .map(ToString::to_string),
    })
}

fn parse_new_checkout_flow_action(action: &str) -> Result<&'static str, StoreError> {
    InternalCheckoutFlowAction::from_current_contract(action)
        .map(InternalCheckoutFlowAction::as_str)
        .ok_or_else(|| StoreError::InvalidCheckoutFlowAction(action.to_string()))
}

fn validate_new_backend_status_checkout_flow_action(
    mut status: serde_json::Value,
) -> Result<serde_json::Value, StoreError> {
    let Some(object) = status.as_object_mut() else {
        return Ok(status);
    };
    let Some(next_action) = object.get("nextAction").and_then(|value| value.as_str()) else {
        return Ok(status);
    };
    let action = parse_new_checkout_flow_action(next_action)?;
    object.insert(
        "nextAction".to_string(),
        serde_json::Value::String(action.to_string()),
    );
    Ok(status)
}

fn merge_backend_payment_code_attempt(
    existing_json: Option<&str>,
    backend_attempt: Option<&serde_json::Value>,
) -> Result<Option<serde_json::Value>, StoreError> {
    let mut merged = match existing_json {
        Some(json) => match serde_json::from_str::<serde_json::Value>(json)? {
            serde_json::Value::Object(map) => map,
            _ => serde_json::Map::new(),
        },
        None => serde_json::Map::new(),
    };

    let Some(backend_attempt) = backend_attempt else {
        return Ok(None);
    };
    let Some(backend_attempt) = backend_attempt.as_object() else {
        return Ok(None);
    };

    for (key, value) in backend_attempt {
        merged.insert(key.clone(), value.clone());
    }

    Ok(Some(serde_json::Value::Object(merged)))
}

fn patch_backend_status_for_dispense_result(
    backend_status: &mut serde_json::Value,
    command: &DispenseCommandPayload,
    result: &DispenseResultPayload,
) {
    if !backend_status.is_object() {
        *backend_status = serde_json::json!({});
    }
    let Some(object) = backend_status.as_object_mut() else {
        return;
    };

    if result.success {
        object.insert(
            "orderStatus".to_string(),
            serde_json::Value::String("fulfilled".to_string()),
        );
        object.insert(
            "fulfillmentState".to_string(),
            serde_json::Value::String("dispensed".to_string()),
        );
        object.insert(
            "nextAction".to_string(),
            serde_json::Value::String("success".to_string()),
        );
    } else {
        object.insert(
            "orderStatus".to_string(),
            serde_json::Value::String("dispense_failed".to_string()),
        );
        object.insert(
            "fulfillmentState".to_string(),
            serde_json::Value::String("dispense_failed".to_string()),
        );
        object.insert(
            "nextAction".to_string(),
            serde_json::Value::String("dispense_failed".to_string()),
        );
    }

    let vending = object
        .entry("vending".to_string())
        .or_insert_with(|| serde_json::json!({}));
    if !vending.is_object() {
        *vending = serde_json::json!({});
    }
    if let Some(vending) = vending.as_object_mut() {
        vending.insert(
            "commandNo".to_string(),
            serde_json::Value::String(command.command_no.clone()),
        );
        vending.insert(
            "status".to_string(),
            serde_json::Value::String(if result.success {
                "succeeded".to_string()
            } else {
                "failed".to_string()
            }),
        );
        vending.insert(
            "resultAt".to_string(),
            serde_json::Value::String(result.reported_at.clone()),
        );
        let last_error = if result.success {
            serde_json::Value::Null
        } else {
            serde_json::Value::String(result.message.clone())
        };
        vending.insert("lastError".to_string(), last_error);
        vending.insert("pickupReminder".to_string(), serde_json::Value::Null);
    }
}

fn merge_local_dispense_progress(
    local_backend_status_json: Option<&str>,
    mut backend_status: serde_json::Value,
) -> serde_json::Value {
    let backend_next_action = backend_status
        .get("nextAction")
        .and_then(|value| value.as_str());
    if backend_next_action != Some("dispensing") {
        return backend_status;
    }

    let local = local_backend_status_json
        .and_then(|value| serde_json::from_str::<serde_json::Value>(value).ok());
    let local_reminder = local
        .as_ref()
        .and_then(|value| value.pointer("/vending/pickupReminder"))
        .filter(|value| value.is_object())
        .cloned();
    let Some(local_reminder) = local_reminder else {
        return backend_status;
    };

    if !backend_status.is_object() {
        return backend_status;
    }
    let Some(object) = backend_status.as_object_mut() else {
        return backend_status;
    };
    let vending = object
        .entry("vending".to_string())
        .or_insert_with(|| serde_json::json!({}));
    if !vending.is_object() {
        *vending = serde_json::json!({});
    }
    if let Some(vending) = vending.as_object_mut() {
        let backend_command_no = vending
            .get("commandNo")
            .and_then(|value| value.as_str())
            .map(ToString::to_string);
        let local_command_no = local
            .as_ref()
            .and_then(|value| value.pointer("/vending/commandNo"))
            .and_then(|value| value.as_str())
            .map(ToString::to_string);
        if backend_command_no.is_none() || backend_command_no == local_command_no {
            vending.insert("pickupReminder".to_string(), local_reminder);
        }
    }
    backend_status
}

fn patch_backend_status_for_dispense_progress(
    backend_status: &mut serde_json::Value,
    event: &DispenseProgressEvent,
) {
    if !backend_status.is_object() {
        *backend_status = serde_json::json!({});
    }
    let Some(object) = backend_status.as_object_mut() else {
        return;
    };
    let reset_completed = matches!(event.stage, DispenseProgressStage::ResetCompleted);
    if !reset_completed {
        object.insert(
            "nextAction".to_string(),
            serde_json::Value::String("dispensing".to_string()),
        );
    }

    let vending = object
        .entry("vending".to_string())
        .or_insert_with(|| serde_json::json!({}));
    if !vending.is_object() {
        *vending = serde_json::json!({});
    }
    if let Some(vending) = vending.as_object_mut() {
        let incoming_rank = dispense_progress_rank(&event.stage);
        let current_rank = vending
            .get("fulfillmentProgressStage")
            .and_then(|value| value.as_str())
            .map(dispense_progress_name_rank)
            .unwrap_or(0);
        if incoming_rank < current_rank {
            return;
        }
        vending.insert(
            "fulfillmentProgressStage".to_string(),
            serde_json::Value::String(dispense_progress_stage_name(&event.stage).to_string()),
        );
        vending.insert(
            "commandNo".to_string(),
            serde_json::Value::String(event.command_no.clone()),
        );
        if reset_completed {
            vending.insert("pickupReminder".to_string(), serde_json::Value::Null);
            return;
        }
        vending.insert(
            "status".to_string(),
            serde_json::Value::String("dispensing".to_string()),
        );
        let Some((level, stage)) =
            pickup_reminder_contract_for_dispense_progress(&event.stage, event.warning_no)
        else {
            vending.insert("pickupReminder".to_string(), serde_json::Value::Null);
            return;
        };
        vending.insert(
            "pickupReminder".to_string(),
            serde_json::json!({
                "stage": stage,
                "level": level,
                "message": event.message,
                "warningNo": event.warning_no,
                "reportedAt": event.reported_at,
            }),
        );
    }
}

fn dispense_progress_rank(stage: &DispenseProgressStage) -> u8 {
    match stage {
        DispenseProgressStage::OutletOpened => 1,
        DispenseProgressStage::PickupWaiting => 2,
        DispenseProgressStage::PickupTimeoutWarning => 3,
        DispenseProgressStage::PickupCompleted => 4,
        DispenseProgressStage::ResetCompleted => 5,
    }
}

fn dispense_progress_stage_name(stage: &DispenseProgressStage) -> &'static str {
    match stage {
        DispenseProgressStage::OutletOpened => "outlet_opened",
        DispenseProgressStage::PickupWaiting => "pickup_waiting",
        DispenseProgressStage::PickupTimeoutWarning => "pickup_timeout_warning",
        DispenseProgressStage::PickupCompleted => "pickup_completed",
        DispenseProgressStage::ResetCompleted => "reset_completed",
    }
}

fn dispense_progress_name_rank(stage: &str) -> u8 {
    match stage {
        "outlet_opened" => 1,
        "pickup_waiting" => 2,
        "pickup_timeout_warning" => 3,
        "pickup_completed" => 4,
        "reset_completed" => 5,
        _ => 0,
    }
}

fn pickup_reminder_contract_for_dispense_progress(
    stage: &DispenseProgressStage,
    warning_no: Option<u8>,
) -> Option<(&'static str, &'static str)> {
    match stage {
        DispenseProgressStage::OutletOpened => Some(("info", "outlet_opened")),
        DispenseProgressStage::PickupWaiting => Some(("info", "pickup_waiting")),
        DispenseProgressStage::PickupCompleted => Some(("info", "pickup_completed")),
        DispenseProgressStage::PickupTimeoutWarning if warning_no.unwrap_or(1) >= 2 => {
            Some(("urgent", "pickup_timeout_warning"))
        }
        DispenseProgressStage::PickupTimeoutWarning => Some(("warning", "pickup_timeout_warning")),
        DispenseProgressStage::ResetCompleted => None,
    }
}

fn parse_order_status(status: &str) -> Option<vending_core::domain::OrderSessionStatus> {
    match status {
        "waiting_payment" | "pending_payment" => {
            Some(vending_core::domain::OrderSessionStatus::WaitingPayment)
        }
        "payment_submitted" => Some(vending_core::domain::OrderSessionStatus::PaymentSubmitted),
        "dispensing" => Some(vending_core::domain::OrderSessionStatus::Dispensing),
        "succeeded" | "fulfilled" => Some(vending_core::domain::OrderSessionStatus::Succeeded),
        "failed" | "payment_failed" | "dispense_failed" => {
            Some(vending_core::domain::OrderSessionStatus::Failed)
        }
        "manual_handling" => Some(vending_core::domain::OrderSessionStatus::ManualHandling),
        "payment_expired" | "canceled" | "cancelled" | "expired" | "refunded"
        | "partial_refunded" | "closed" => Some(vending_core::domain::OrderSessionStatus::Closed),
        _ => None,
    }
}

fn public_order_status(status: &str) -> String {
    match status {
        "waiting_payment" => "pending_payment".to_string(),
        _ => status.to_string(),
    }
}

async fn mark_outbox_failed_in_tx(
    tx: &mut Transaction<'_, sqlx::Sqlite>,
    id: &str,
    error: &str,
) -> Result<i64, StoreError> {
    let next_delay = backoff_delay_tx(id, tx).await?;
    let result = sqlx::query(
        "UPDATE outbox_events
         SET attempt_count = attempt_count + 1,
             last_error = ?2,
             next_attempt_at = ?3
         WHERE id = ?1",
    )
    .bind(id)
    .bind(error)
    .bind(next_delay)
    .execute(tx.as_mut())
    .await?;
    if result.rows_affected() != 1 {
        return Err(StoreError::Sqlx(sqlx::Error::RowNotFound));
    }
    let attempt: (i64,) = sqlx::query_as("SELECT attempt_count FROM outbox_events WHERE id = ?1")
        .bind(id)
        .fetch_one(tx.as_mut())
        .await?;
    Ok(attempt.0)
}

async fn backoff_delay_tx(
    id: &str,
    tx: &mut Transaction<'_, sqlx::Sqlite>,
) -> Result<String, StoreError> {
    let attempt: (i64,) =
        sqlx::query_as("SELECT attempt_count + 1 FROM outbox_events WHERE id = ?1")
            .bind(id)
            .fetch_one(tx.as_mut())
            .await?;
    let exp = 2_f64.powi(attempt.0 as i32 - 1).max(1.0) * 5.0;
    let base = Utc::now() + chrono::Duration::seconds(exp as i64);
    Ok(base.to_rfc3339_opts(SecondsFormat::Millis, true))
}

fn to_command_record(row: CommandRecordRow) -> Result<CommandLogRecord, StoreError> {
    Ok(CommandLogRecord {
        command_no: row.0,
        order_no: row.1,
        command_payload: serde_json::from_str(&row.2)?,
        status: parse_command_status(&row.3),
        ack_at: row.4,
        dispensing_started_at: row.5,
        result_payload: row.6.and_then(|value| serde_json::from_str(&value).ok()),
        error_code: row.7,
        error_message: row.8,
        updated_at: row.9,
        expires_at: row.10,
    })
}

type ManualDispenseRow = (
    String,
    String,
    String,
    String,
    String,
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    String,
    String,
);

async fn manual_dispense_by_idempotency_in_tx(
    tx: &mut Transaction<'_, Sqlite>,
    key: &str,
) -> Result<Option<ManualDispenseDiagnostic>, StoreError> {
    let row: Option<ManualDispenseRow> = sqlx::query_as(
        "SELECT diagnostic_id,idempotency_key,status,operator_id,session_correlation_id,
         controller_json,command_json,started_at,completed_at,raw_result_json,
         normalized_result_json,reconciliation_status,expires_at
         FROM manual_dispense_diagnostics WHERE idempotency_key=?1",
    )
    .bind(key)
    .fetch_optional(tx.as_mut())
    .await?;
    row.map(to_manual_dispense_diagnostic).transpose()
}

async fn manual_dispense_by_id_in_tx(
    tx: &mut Transaction<'_, Sqlite>,
    id: &str,
) -> Result<Option<ManualDispenseDiagnostic>, StoreError> {
    let row: Option<ManualDispenseRow> = sqlx::query_as(
        "SELECT diagnostic_id,idempotency_key,status,operator_id,session_correlation_id,
         controller_json,command_json,started_at,completed_at,raw_result_json,
         normalized_result_json,reconciliation_status,expires_at
         FROM manual_dispense_diagnostics WHERE diagnostic_id=?1",
    )
    .bind(id)
    .fetch_optional(tx.as_mut())
    .await?;
    row.map(to_manual_dispense_diagnostic).transpose()
}

fn to_manual_dispense_diagnostic(
    row: ManualDispenseRow,
) -> Result<ManualDispenseDiagnostic, StoreError> {
    Ok(ManualDispenseDiagnostic {
        diagnostic_id: row.0,
        idempotency_key: row.1,
        status: row.2,
        operator_id: row.3,
        session_correlation_id: row.4,
        controller: serde_json::from_str(&row.5)?,
        command: serde_json::from_str(&row.6)?,
        started_at: row.7,
        completed_at: row.8,
        raw_result: row.9.map(|v| serde_json::from_str(&v)).transpose()?,
        normalized_result: row.10.map(|v| serde_json::from_str(&v)).transpose()?,
        reconciliation_status: row.11,
        expires_at: row.12,
    })
}

fn to_stock_movement_sync_record(
    row: StockMovementSyncRecordRow,
) -> Result<StockMovementSyncRecord, StoreError> {
    Ok(StockMovementSyncRecord {
        movement_id: row.0,
        status: row.1,
        outbox_event_id: row.2,
        attempt_count: row.3,
        last_error: row.4,
        accepted_at: row.5,
        platform_receipt_json: row
            .6
            .map(|value| serde_json::from_str(&value))
            .transpose()?,
        rejection_json: row
            .7
            .map(|value| serde_json::from_str(&value))
            .transpose()?,
        created_at: row.8,
        updated_at: row.9,
    })
}

fn parse_command_status(value: &str) -> CommandLogStatus {
    match value {
        "acknowledged" => CommandLogStatus::Acknowledged,
        "dispensing" => CommandLogStatus::Dispensing,
        "succeeded" => CommandLogStatus::Succeeded,
        "failed" => CommandLogStatus::Failed,
        _ => CommandLogStatus::Received,
    }
}

fn to_outbox_record(row: OutboxRecordRow) -> Result<OutboxRecord, StoreError> {
    let payload: serde_json::Value = serde_json::from_str(&row.6)?;
    Ok(OutboxRecord {
        id: row.0,
        kind: parse_outbox_kind(&row.1),
        transport: parse_outbox_transport(&row.2),
        topic: row.3,
        target_url: row.4,
        method: row.5,
        payload_json: payload,
        priority: row.7,
        created_at: row.8,
        next_attempt_at: row.9,
        attempt_count: row.10,
        last_error: row.11,
        expires_at: row.12,
    })
}

fn parse_outbox_kind(value: &str) -> OutboxKind {
    match value {
        "dispense_result" => OutboxKind::DispenseResult,
        "heartbeat" => OutboxKind::Heartbeat,
        "remote_op_result" => OutboxKind::RemoteOpResult,
        "log_export" => OutboxKind::LogExport,
        "stock_movement_upload" => OutboxKind::StockMovementUpload,
        _ => OutboxKind::CommandAck,
    }
}

fn parse_outbox_transport(value: &str) -> OutboxTransport {
    if value == "http" {
        OutboxTransport::Http
    } else {
        OutboxTransport::Mqtt
    }
}

pub fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub fn now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_else(|_| std::time::Duration::from_secs(0))
        .as_millis()
}

fn stock_maintenance_planogram_revision(
    planogram_version: &str,
    mode: &str,
    slots: &[StockMaintenanceTaskIdentitySlot],
) -> Result<String, StoreError> {
    let revision_payload = serde_json::json!({
        "planogramVersion": planogram_version,
        "mode": mode,
        "slots": slots,
    });
    Ok(format!(
        "sha256:{:x}",
        Sha256::digest(serde_json::to_vec(&revision_payload)?)
    ))
}

fn normalize_refill_batch(
    input: &StockMaintenanceBatchInput,
) -> Result<NormalizedStockMaintenanceRefillBatch, StoreError> {
    if input.mode != "routine_refill" || input.slots.is_empty() {
        return Err(StoreError::InvalidStockInput(
            "refill task must submit positive additions".to_string(),
        ));
    }
    let mut slots = input
        .slots
        .iter()
        .map(|slot| {
            if slot.quantity.is_some() || slot.addition.is_none_or(|addition| addition <= 0) {
                return Err(StoreError::InvalidStockInput(
                    "refill task must submit positive additions".to_string(),
                ));
            }
            Ok(NormalizedStockMaintenanceRefillSlot {
                slot_code: slot.slot_code.clone(),
                addition: slot.addition.unwrap_or_default(),
            })
        })
        .collect::<Result<Vec<_>, StoreError>>()?;
    slots.sort_by(|left, right| left.slot_code.cmp(&right.slot_code));
    if slots
        .windows(2)
        .any(|pair| pair[0].slot_code == pair[1].slot_code)
    {
        return Err(StoreError::InvalidStockInput(
            "refill task contains duplicate slots".to_string(),
        ));
    }
    Ok(NormalizedStockMaintenanceRefillBatch {
        task_id: input.task_id.clone(),
        mode: input.mode.clone(),
        slots,
    })
}

fn stock_maintenance_batch_fingerprint<T: Serialize>(value: &T) -> Result<String, StoreError> {
    Ok(format!(
        "sha256:{:x}",
        Sha256::digest(serde_json::to_vec(value)?)
    ))
}

fn now_iso_days(days: i64) -> String {
    (Utc::now() + chrono::Duration::days(days)).to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use std::{sync::Arc, time::Duration};

    use serde_json::json;
    use tempfile::TempDir;
    use tokio::sync::Barrier;

    use super::*;

    async fn seed_single_slot_planogram(store: &LocalStateStore) {
        store
            .apply_planogram(MachinePlanogramInput {
                planogram_version: "PLAN-FAILURE".to_string(),
                source: "test".to_string(),
                applied_by: None,
                slots: vec![MachinePlanogramSlotInput {
                    slot_id: "550e8400-e29b-41d4-a716-446655440001".to_string(),
                    slot_code: "A1".to_string(),
                    layer_no: 1,
                    cell_no: 1,
                    capacity: 8,
                    par_level: 6,
                    inventory_id: "550e8400-e29b-41d4-a716-446655440002".to_string(),
                    variant_id: "550e8400-e29b-41d4-a716-446655440003".to_string(),
                    product_id: "550e8400-e29b-41d4-a716-446655440004".to_string(),
                    product_name: "water".to_string(),
                    product_description: None,
                    cover_image_url: None,
                    try_on_silhouette_url: None,
                    category_id: None,
                    category_name: None,
                    sku: "WATER-001".to_string(),
                    size: Some("550ml".to_string()),
                    color: None,
                    price_cents: 200,
                    product_sort_order: 1,
                    target_gender: None,
                }],
            })
            .await
            .expect("planogram");
    }

    async fn seed_two_slot_planogram(store: &LocalStateStore) {
        store
            .apply_planogram(MachinePlanogramInput {
                planogram_version: "PLAN-PARTIAL-ACK".to_string(),
                source: "test".to_string(),
                applied_by: None,
                slots: vec![
                    MachinePlanogramSlotInput {
                        slot_id: "550e8400-e29b-41d4-a716-446655440001".to_string(),
                        slot_code: "A1".to_string(),
                        layer_no: 1,
                        cell_no: 1,
                        capacity: 8,
                        par_level: 6,
                        inventory_id: "550e8400-e29b-41d4-a716-446655440002".to_string(),
                        variant_id: "550e8400-e29b-41d4-a716-446655440003".to_string(),
                        product_id: "550e8400-e29b-41d4-a716-446655440004".to_string(),
                        product_name: "water".to_string(),
                        product_description: None,
                        cover_image_url: None,
                        try_on_silhouette_url: None,
                        category_id: None,
                        category_name: None,
                        sku: "WATER-001".to_string(),
                        size: Some("550ml".to_string()),
                        color: None,
                        price_cents: 200,
                        product_sort_order: 1,
                        target_gender: None,
                    },
                    MachinePlanogramSlotInput {
                        slot_id: "550e8400-e29b-41d4-a716-446655440011".to_string(),
                        slot_code: "A2".to_string(),
                        layer_no: 1,
                        cell_no: 2,
                        capacity: 8,
                        par_level: 6,
                        inventory_id: "550e8400-e29b-41d4-a716-446655440012".to_string(),
                        variant_id: "550e8400-e29b-41d4-a716-446655440013".to_string(),
                        product_id: "550e8400-e29b-41d4-a716-446655440014".to_string(),
                        product_name: "tea".to_string(),
                        product_description: None,
                        cover_image_url: None,
                        try_on_silhouette_url: None,
                        category_id: None,
                        category_name: None,
                        sku: "TEA-001".to_string(),
                        size: Some("500ml".to_string()),
                        color: None,
                        price_cents: 300,
                        product_sort_order: 2,
                        target_gender: None,
                    },
                ],
            })
            .await
            .expect("two-slot planogram");
    }

    fn two_slot_attestation(
        attestation_id: &str,
        second_quantity: i64,
    ) -> PhysicalStockAttestationInput {
        PhysicalStockAttestationInput {
            attestation_id: attestation_id.to_string(),
            planogram_version: "PLAN-PARTIAL-ACK".to_string(),
            operator_id: "operator-1".to_string(),
            slots: vec![
                PhysicalStockAttestationSlotInput {
                    slot_id: "550e8400-e29b-41d4-a716-446655440001".to_string(),
                    slot_code: "A1".to_string(),
                    sku: "WATER-001".to_string(),
                    quantity: 3,
                    enabled: true,
                },
                PhysicalStockAttestationSlotInput {
                    slot_id: "550e8400-e29b-41d4-a716-446655440011".to_string(),
                    slot_code: "A2".to_string(),
                    sku: "TEA-001".to_string(),
                    quantity: second_quantity,
                    enabled: true,
                },
            ],
        }
    }

    async fn seed_old_maintenance_history(
        store: &LocalStateStore,
        base: &StockMaintenanceTaskIdentity,
        task_id: &str,
        status: &str,
        predecessor_task_id: Option<&str>,
        with_upload_outbox: bool,
    ) {
        let mut identity = base.clone();
        identity.task_id = task_id.to_string();
        identity.predecessor_task_id = predecessor_task_id.map(ToString::to_string);
        store
            .remember_stock_maintenance_task_identity(&identity)
            .await
            .expect("remember synthetic identity");
        sqlx::query(
            "UPDATE stock_maintenance_task_identities
             SET created_at='2026-05-01T00:00:00.000Z' WHERE task_id=?1",
        )
        .bind(task_id)
        .execute(store.pool())
        .await
        .expect("age synthetic identity");
        sqlx::query(
            "INSERT INTO stock_maintenance_batches(
               task_id,mode,planogram_version,planogram_revision,slot_set_json,payload_json,
               payload_fingerprint,operator_id,capacity_snapshot_json,created_at
             ) VALUES (?1,'routine_refill',?2,?3,?4,'{}','sha256:test','operator','[]','2026-05-01T00:00:00.000Z')",
        )
        .bind(task_id)
        .bind(&identity.planogram_version)
        .bind(&identity.planogram_revision)
        .bind(serde_json::to_string(&identity.slots).expect("slot set"))
        .execute(store.pool())
        .await
        .expect("synthetic batch");
        let movement_id = format!("{}:{}", task_id, "550e8400-e29b-41d4-a716-446655440001");
        let outbox_event_id = format!("stock-movement:{movement_id}");
        sqlx::query(
            "INSERT INTO stock_movement_sync(
               movement_id,status,outbox_event_id,attempt_count,accepted_at,created_at,updated_at
             ) VALUES (?1,?2,?3,0,?4,'2026-05-01T00:00:00.000Z','2026-05-01T00:00:00.000Z')",
        )
        .bind(&movement_id)
        .bind(status)
        .bind(&outbox_event_id)
        .bind((status == "accepted").then_some("2026-05-01T00:00:00.000Z"))
        .execute(store.pool())
        .await
        .expect("synthetic sync");
        if with_upload_outbox {
            store
                .enqueue_outbox(&OutboxInput::stock_movement_upload(
                    &movement_id,
                    "https://platform.example/api/machine-stock-movements".to_string(),
                    json!({"movementId":movement_id}),
                ))
                .await
                .expect("synthetic upload outbox");
        }
    }

    #[tokio::test]
    async fn stock_maintenance_task_hides_internal_ids_and_submits_one_idempotent_count_batch() {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");
        seed_two_slot_planogram(&store).await;

        let task = store.stock_maintenance_task().await.expect("task");
        assert_eq!(task.mode, "initial_count");
        assert_eq!(task.slots[0].slot_code, "A1");
        assert_eq!(task.slots[0].product_name, "water");
        assert_eq!(task.slots[0].current_quantity, 0);
        assert_eq!(task.slots[0].sync_status, "not_submitted");

        let input = StockMaintenanceBatchInput {
            task_id: task.task_id.clone(),
            mode: "initial_count".to_string(),
            slots: vec![
                StockMaintenanceBatchSlotInput {
                    slot_code: "A1".to_string(),
                    quantity: Some(3),
                    addition: None,
                },
                StockMaintenanceBatchSlotInput {
                    slot_code: "A2".to_string(),
                    quantity: Some(4),
                    addition: None,
                },
            ],
        };
        let first = store
            .submit_stock_maintenance_batch(
                input.clone(),
                "maintenance-session-operator",
                "MACHINE-1",
                "https://platform.example/api",
            )
            .await
            .expect("first submission");
        assert!(!first.duplicate);
        assert_eq!(first.task.status, "pending");

        let replay = store
            .submit_stock_maintenance_batch(
                input.clone(),
                "renewed-maintenance-session-operator",
                "MACHINE-1",
                "https://platform.example/api",
            )
            .await
            .expect("idempotent replay");
        assert!(replay.duplicate);
        for slot_id in [
            "550e8400-e29b-41d4-a716-446655440001",
            "550e8400-e29b-41d4-a716-446655440011",
        ] {
            let movement_id = format!("{}:{slot_id}", task.task_id);
            let event = store
                .outbox_record(&format!("stock-movement:{movement_id}"))
                .await
                .expect("outbox")
                .expect("event");
            store
                .record_stock_movement_upload_response(
                    &event,
                    &crate::backend::StockMovementUploadResponse {
                        movement_id,
                        status: "accepted".to_string(),
                        accepted_at: Some("2026-07-15T00:00:00.000Z".to_string()),
                        receipt: Some(json!({"rawMovementId":format!("raw-{slot_id}")})),
                        rejection: None,
                        reconciliation: None,
                    },
                )
                .await
                .expect("accept movement");
        }
        let lost_response_retry = store
            .submit_stock_maintenance_batch(
                input,
                "another-renewed-session-operator",
                "MACHINE-1",
                "https://platform.example/api",
            )
            .await
            .expect("retry completed batch");
        assert!(lost_response_retry.duplicate);
        assert_eq!(lost_response_retry.task.mode, "routine_refill");
        let movements: Vec<(Option<String>,)> =
            sqlx::query_as("SELECT attributed_to FROM stock_movements ORDER BY movement_id")
                .fetch_all(store.pool())
                .await
                .expect("movement audit");
        assert_eq!(movements.len(), 2);
        assert!(movements
            .iter()
            .all(|(operator,)| operator.as_deref() == Some("maintenance-session-operator")));
    }

    #[tokio::test]
    async fn stock_maintenance_rejects_same_version_slot_revision_change_without_any_batch_write() {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");
        seed_two_slot_planogram(&store).await;
        store
            .record_physical_stock_attestation(two_slot_attestation("ATT-READY", 2))
            .await
            .expect("sale-ready stock");
        let task = store.stock_maintenance_task().await.expect("old task");
        assert_eq!(task.mode, "routine_refill");

        sqlx::query(
            "UPDATE machine_planogram_slots
             SET sku='WATER-REBOUND', capacity=9
             WHERE planogram_version='PLAN-PARTIAL-ACK' AND slot_code='A1'",
        )
        .execute(store.pool())
        .await
        .expect("simulate same-version slot mapping replacement");

        let error = store
            .submit_stock_maintenance_batch(
                StockMaintenanceBatchInput {
                    task_id: task.task_id.clone(),
                    mode: task.mode,
                    slots: vec![
                        StockMaintenanceBatchSlotInput {
                            slot_code: "A1".to_string(),
                            quantity: None,
                            addition: Some(1),
                        },
                        StockMaintenanceBatchSlotInput {
                            slot_code: "A2".to_string(),
                            quantity: None,
                            addition: Some(1),
                        },
                    ],
                },
                "operator",
                "MACHINE-1",
                "https://platform.example/api",
            )
            .await
            .expect_err("old slot revision must be stale");
        assert!(error.to_string().contains("stale"));
        let movement_count: (i64,) =
            sqlx::query_as("SELECT COUNT(1) FROM stock_movement_sync WHERE movement_id LIKE ?1")
                .bind(format!("{}:%", task.task_id))
                .fetch_one(store.pool())
                .await
                .expect("movement count");
        let outbox_count: (i64,) =
            sqlx::query_as("SELECT COUNT(1) FROM outbox_events WHERE id LIKE ?1")
                .bind(format!("stock-movement:{}:%", task.task_id))
                .fetch_one(store.pool())
                .await
                .expect("outbox count");
        assert_eq!((movement_count.0, outbox_count.0), (0, 0));
        let sale_view = store.sale_view(None).await.expect("targeted freeze");
        assert_eq!(sale_view.items[0].slot_code, "A1");
        assert_eq!(sale_view.items[0].saleable_stock, 0);
        assert_eq!(sale_view.items[0].slot_sales_state, "needs_platform_review");
        assert_eq!(sale_view.items[1].slot_code, "A2");
        assert_eq!(sale_view.items[1].saleable_stock, 2);
        assert_eq!(sale_view.items[1].slot_sales_state, "sale_ready");
        let audit: (String,) = sqlx::query_as(
            "SELECT context_json FROM health_events
             WHERE code='stale_stock_maintenance_task_slot_diff'
             ORDER BY occurred_at DESC LIMIT 1",
        )
        .fetch_one(store.pool())
        .await
        .expect("slot diff audit");
        assert!(audit.0.contains("sku_changed"));
        assert!(audit.0.contains("capacity_changed"));
    }

    #[tokio::test]
    async fn concurrent_active_slot_revision_switch_rejects_the_whole_old_task_without_movements() {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");
        seed_two_slot_planogram(&store).await;
        let task = store.stock_maintenance_task().await.expect("old task");
        let mut switch_tx = store
            .begin_immediate_write_transaction()
            .await
            .expect("planogram switch lock");
        sqlx::query(
            "UPDATE machine_planogram_slots
             SET sku='WATER-CONCURRENT-REBOUND', capacity=9
             WHERE planogram_version='PLAN-PARTIAL-ACK' AND slot_code='A1'",
        )
        .execute(switch_tx.as_mut())
        .await
        .expect("stage concurrent slot revision");

        let contender_store = store.clone();
        let contender_task_id = task.task_id.clone();
        let contender = tokio::spawn(async move {
            contender_store
                .submit_stock_maintenance_batch(
                    StockMaintenanceBatchInput {
                        task_id: contender_task_id,
                        mode: "initial_count".to_string(),
                        slots: vec![
                            StockMaintenanceBatchSlotInput {
                                slot_code: "A1".to_string(),
                                quantity: Some(3),
                                addition: None,
                            },
                            StockMaintenanceBatchSlotInput {
                                slot_code: "A2".to_string(),
                                quantity: Some(4),
                                addition: None,
                            },
                        ],
                    },
                    "operator",
                    "MACHINE-1",
                    "https://platform.example/api",
                )
                .await
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(
            !contender.is_finished(),
            "submission must wait behind the active planogram writer"
        );
        switch_tx.commit().await.expect("commit slot revision");

        let error = contender
            .await
            .expect("join contender")
            .expect_err("old task must be rejected after concurrent switch");
        assert!(error.to_string().contains("stale"));
        let writes: (i64, i64) = sqlx::query_as(
            "SELECT
               (SELECT COUNT(1) FROM stock_movement_sync WHERE movement_id LIKE ?1),
               (SELECT COUNT(1) FROM outbox_events WHERE id LIKE ?2)",
        )
        .bind(format!("{}:%", task.task_id))
        .bind(format!("stock-movement:{}:%", task.task_id))
        .fetch_one(store.pool())
        .await
        .expect("batch writes");
        assert_eq!(writes, (0, 0));
    }

    #[tokio::test]
    async fn refill_task_is_idempotent_and_platform_conflict_freezes_only_its_slot() {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");
        seed_two_slot_planogram(&store).await;
        store
            .record_physical_stock_attestation(two_slot_attestation("ATT-READY", 2))
            .await
            .expect("initial stock");
        let task = store.stock_maintenance_task().await.expect("refill task");
        assert_eq!(task.mode, "routine_refill");
        let input = StockMaintenanceBatchInput {
            task_id: task.task_id.clone(),
            mode: task.mode.clone(),
            slots: vec![
                StockMaintenanceBatchSlotInput {
                    slot_code: "A1".to_string(),
                    quantity: None,
                    addition: Some(2),
                },
                StockMaintenanceBatchSlotInput {
                    slot_code: "A2".to_string(),
                    quantity: None,
                    addition: Some(1),
                },
            ],
        };
        let submitted = store
            .submit_stock_maintenance_batch(
                input.clone(),
                "operator-from-session",
                "MACHINE-1",
                "https://platform.example/api",
            )
            .await
            .expect("submit refill");
        assert!(!submitted.duplicate);
        assert_eq!(submitted.task.slots[0].submitted_addition, Some(2));
        assert_eq!(submitted.task.slots[0].preview_quantity, Some(5));
        assert_eq!(submitted.task.slots[1].submitted_addition, Some(1));
        assert_eq!(submitted.task.slots[1].preview_quantity, Some(3));
        let recovered = store.stock_maintenance_task().await.expect("recover batch");
        assert_eq!(recovered.slots[0].submitted_addition, Some(2));
        assert_eq!(recovered.slots[0].preview_quantity, Some(5));
        let replay = store
            .submit_stock_maintenance_batch(
                input.clone(),
                "operator-from-renewed-session",
                "MACHINE-1",
                "https://platform.example/api",
            )
            .await
            .expect("replay refill");
        assert!(replay.duplicate);
        let sale_view = store.sale_view(None).await.expect("refilled sale view");
        assert_eq!(sale_view.items[0].physical_stock, 5);
        assert_eq!(sale_view.items[1].physical_stock, 3);

        let conflicted_id = format!(
            "{}:{}",
            task.task_id, "550e8400-e29b-41d4-a716-446655440001"
        );
        let accepted_id = format!(
            "{}:{}",
            task.task_id, "550e8400-e29b-41d4-a716-446655440011"
        );
        for (movement_id, response) in [
            (
                conflicted_id.clone(),
                crate::backend::StockMovementUploadResponse {
                    movement_id: conflicted_id.clone(),
                    status: "reconciliation".to_string(),
                    accepted_at: None,
                    receipt: None,
                    rejection: None,
                    reconciliation: Some(crate::backend::StockMovementReconciliation {
                        reason: "mapping_mismatch".to_string(),
                        platform_review: Some(json!({"required":true,"status":"open"})),
                        sale_safety_blocker: Some(crate::backend::StockMovementSaleSafetyBlocker {
                            slot_id: "550e8400-e29b-41d4-a716-446655440001".to_string(),
                            slot_sales_state: "needs_platform_review".to_string(),
                            reason: "mapping_mismatch".to_string(),
                        }),
                    }),
                },
            ),
            (
                accepted_id.clone(),
                crate::backend::StockMovementUploadResponse {
                    movement_id: accepted_id.clone(),
                    status: "accepted".to_string(),
                    accepted_at: Some("2026-07-15T00:00:00.000Z".to_string()),
                    receipt: Some(json!({"rawMovementId":"raw-a2"})),
                    rejection: None,
                    reconciliation: None,
                },
            ),
        ] {
            let event = store
                .outbox_record(&format!("stock-movement:{movement_id}"))
                .await
                .expect("outbox lookup")
                .expect("outbox event");
            store
                .record_stock_movement_upload_response(&event, &response)
                .await
                .expect("record response");
        }
        let partial_ack_replay = store
            .submit_stock_maintenance_batch(
                input,
                "operator-from-another-renewed-session",
                "MACHINE-1",
                "https://platform.example/api",
            )
            .await
            .expect("partial ack exact replay");
        assert!(partial_ack_replay.duplicate);
        assert_eq!(partial_ack_replay.task.status, "reconciliation");
        assert_eq!(partial_ack_replay.task.slots[0].submitted_addition, Some(2));
        assert_eq!(partial_ack_replay.task.slots[0].preview_quantity, Some(5));
        let task = store.stock_maintenance_task().await.expect("task status");
        assert_eq!(task.status, "reconciliation");
        assert_eq!(task.slots[0].sync_status, "reconciliation");
        assert_eq!(
            task.slots[0].reconciliation_reason.as_deref(),
            Some("mapping_mismatch")
        );
        let sale_view = store.sale_view(None).await.expect("safe sale view");
        assert_eq!(sale_view.items[0].saleable_stock, 0);
        assert_eq!(sale_view.items[0].slot_sales_state, "needs_platform_review");
        assert_eq!(sale_view.items[1].saleable_stock, 3);
        assert_eq!(sale_view.items[1].slot_sales_state, "sale_ready");
    }

    #[tokio::test]
    async fn completed_refill_retry_survives_maintenance_session_renewal() {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");
        seed_two_slot_planogram(&store).await;
        store
            .record_physical_stock_attestation(two_slot_attestation("ATT-READY", 2))
            .await
            .expect("initial stock");
        let task = store.stock_maintenance_task().await.expect("refill task");
        let input = StockMaintenanceBatchInput {
            task_id: task.task_id.clone(),
            mode: task.mode,
            slots: vec![StockMaintenanceBatchSlotInput {
                slot_code: "A1".to_string(),
                quantity: None,
                addition: Some(2),
            }],
        };
        store
            .submit_stock_maintenance_batch(
                input.clone(),
                "original-session-operator",
                "MACHINE-1",
                "https://platform.example/api",
            )
            .await
            .expect("submit refill");

        let movement_id = format!(
            "{}:{}",
            task.task_id, "550e8400-e29b-41d4-a716-446655440001"
        );
        let event = store
            .outbox_record(&format!("stock-movement:{movement_id}"))
            .await
            .expect("outbox lookup")
            .expect("outbox event");
        store
            .record_stock_movement_upload_response(
                &event,
                &crate::backend::StockMovementUploadResponse {
                    movement_id,
                    status: "accepted".to_string(),
                    accepted_at: Some("2026-07-15T00:00:00.000Z".to_string()),
                    receipt: Some(json!({"rawMovementId":"raw-refill-a1"})),
                    rejection: None,
                    reconciliation: None,
                },
            )
            .await
            .expect("accept movement");

        let retry = store
            .submit_stock_maintenance_batch(
                input,
                "renewed-session-operator",
                "MACHINE-1",
                "https://platform.example/api",
            )
            .await
            .expect("retry completed refill");
        assert!(retry.duplicate);
        assert_ne!(retry.task.task_id, task.task_id);
        let movements: Vec<(Option<String>,)> = sqlx::query_as(
            "SELECT attributed_to FROM stock_movements WHERE source='local_maintenance'",
        )
        .fetch_all(store.pool())
        .await
        .expect("movement audit");
        assert_eq!(
            movements,
            vec![(Some("original-session-operator".to_string()),)]
        );
    }

    #[tokio::test]
    async fn refill_task_rejects_a_different_payload_after_its_first_immutable_batch() {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");
        seed_two_slot_planogram(&store).await;
        store
            .record_physical_stock_attestation(two_slot_attestation("ATT-READY", 2))
            .await
            .expect("initial stock");
        let task = store.stock_maintenance_task().await.expect("refill task");
        store
            .submit_stock_maintenance_batch(
                StockMaintenanceBatchInput {
                    task_id: task.task_id.clone(),
                    mode: task.mode.clone(),
                    slots: vec![StockMaintenanceBatchSlotInput {
                        slot_code: "A1".to_string(),
                        quantity: None,
                        addition: Some(2),
                    }],
                },
                "first-session-operator",
                "MACHINE-1",
                "https://platform.example/api",
            )
            .await
            .expect("first immutable batch");

        let error = store
            .submit_stock_maintenance_batch(
                StockMaintenanceBatchInput {
                    task_id: task.task_id.clone(),
                    mode: task.mode,
                    slots: vec![StockMaintenanceBatchSlotInput {
                        slot_code: "A2".to_string(),
                        quantity: None,
                        addition: Some(1),
                    }],
                },
                "renewed-session-operator",
                "MACHINE-1",
                "https://platform.example/api",
            )
            .await
            .expect_err("same task id cannot define another batch");
        assert!(error.to_string().contains("immutable"));
        let movements: Vec<(String, i64, Option<String>)> = sqlx::query_as(
            "SELECT json_extract(slot_mapping_snapshot_json,'$.slotCode'),quantity,attributed_to
             FROM stock_movements WHERE source='local_maintenance' ORDER BY movement_id",
        )
        .fetch_all(store.pool())
        .await
        .expect("immutable movement audit");
        assert_eq!(
            movements,
            vec![(
                "A1".to_string(),
                2,
                Some("first-session-operator".to_string())
            )]
        );
        let batch: (String, String, String) = sqlx::query_as(
            "SELECT operator_id,payload_fingerprint,capacity_snapshot_json
             FROM stock_maintenance_batches WHERE task_id=?1",
        )
        .bind(&task.task_id)
        .fetch_one(store.pool())
        .await
        .expect("immutable batch audit");
        assert_eq!(batch.0, "first-session-operator");
        assert!(batch.1.starts_with("sha256:"));
        assert!(batch.2.contains("beforeQuantity"));
    }

    #[tokio::test]
    async fn count_task_recovers_partial_platform_reconciliation_with_a_new_batch_generation() {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");
        seed_two_slot_planogram(&store).await;
        let first = store.stock_maintenance_task().await.expect("first task");
        let first_input = StockMaintenanceBatchInput {
            task_id: first.task_id.clone(),
            mode: first.mode.clone(),
            slots: vec![
                StockMaintenanceBatchSlotInput {
                    slot_code: "A1".to_string(),
                    quantity: Some(3),
                    addition: None,
                },
                StockMaintenanceBatchSlotInput {
                    slot_code: "A2".to_string(),
                    quantity: Some(4),
                    addition: None,
                },
            ],
        };
        store
            .submit_stock_maintenance_batch(
                first_input,
                "operator",
                "MACHINE-1",
                "https://platform.example/api",
            )
            .await
            .expect("stage first batch");
        let accepted_id = format!(
            "{}:{}",
            first.task_id, "550e8400-e29b-41d4-a716-446655440001"
        );
        let reconciled_id = format!(
            "{}:{}",
            first.task_id, "550e8400-e29b-41d4-a716-446655440011"
        );
        for (movement_id, response) in [
            (
                accepted_id.clone(),
                crate::backend::StockMovementUploadResponse {
                    movement_id: accepted_id.clone(),
                    status: "accepted".to_string(),
                    accepted_at: Some("2026-07-15T00:00:00.000Z".to_string()),
                    receipt: Some(json!({"rawMovementId":"raw-a1"})),
                    rejection: None,
                    reconciliation: None,
                },
            ),
            (
                reconciled_id.clone(),
                crate::backend::StockMovementUploadResponse {
                    movement_id: reconciled_id.clone(),
                    status: "reconciliation".to_string(),
                    accepted_at: None,
                    receipt: None,
                    rejection: None,
                    reconciliation: Some(crate::backend::StockMovementReconciliation {
                        reason: "abnormal_variance".to_string(),
                        platform_review: Some(json!({"required":true,"status":"open"})),
                        sale_safety_blocker: None,
                    }),
                },
            ),
        ] {
            let event = store
                .outbox_record(&format!("stock-movement:{movement_id}"))
                .await
                .expect("outbox")
                .expect("event");
            store
                .record_stock_movement_upload_response(&event, &response)
                .await
                .expect("receipt");
        }

        let retry = store.stock_maintenance_task().await.expect("retry task");
        assert_eq!(retry.status, "reconciliation");
        assert_ne!(retry.task_id, first.task_id);
        assert_eq!(retry.slots[0].submitted_quantity, Some(3));
        assert_eq!(retry.slots[1].submitted_quantity, Some(4));
        store
            .submit_stock_maintenance_batch(
                StockMaintenanceBatchInput {
                    task_id: retry.task_id.clone(),
                    mode: retry.mode,
                    slots: vec![
                        StockMaintenanceBatchSlotInput {
                            slot_code: "A1".to_string(),
                            quantity: Some(3),
                            addition: None,
                        },
                        StockMaintenanceBatchSlotInput {
                            slot_code: "A2".to_string(),
                            quantity: Some(6),
                            addition: None,
                        },
                    ],
                },
                "operator",
                "MACHINE-1",
                "https://platform.example/api",
            )
            .await
            .expect("retry rejected slot");
        assert!(store
            .outbox_record(&format!(
                "stock-movement:{}:{}",
                retry.task_id, "550e8400-e29b-41d4-a716-446655440001"
            ))
            .await
            .expect("accepted duplicate lookup")
            .is_none());
        assert!(store
            .outbox_record(&format!(
                "stock-movement:{}:{}",
                retry.task_id, "550e8400-e29b-41d4-a716-446655440011"
            ))
            .await
            .expect("retry lookup")
            .is_some());
    }

    #[tokio::test]
    async fn stale_stock_task_freezes_only_named_current_slots() {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");
        seed_two_slot_planogram(&store).await;
        store
            .record_physical_stock_attestation(two_slot_attestation("ATT-READY", 2))
            .await
            .expect("initial stock");
        let stale = StockMaintenanceBatchInput {
            task_id: "stale-task".to_string(),
            mode: "routine_refill".to_string(),
            slots: vec![StockMaintenanceBatchSlotInput {
                slot_code: "A1".to_string(),
                quantity: None,
                addition: Some(1),
            }],
        };
        assert!(store
            .submit_stock_maintenance_batch(
                stale,
                "operator",
                "MACHINE-1",
                "https://platform.example/api",
            )
            .await
            .is_err());
        let sale_view = store.sale_view(None).await.expect("sale view");
        assert_eq!(sale_view.items[0].slot_sales_state, "needs_platform_review");
        assert_eq!(sale_view.items[0].saleable_stock, 0);
        assert_eq!(sale_view.items[1].slot_sales_state, "sale_ready");
        assert_eq!(sale_view.items[1].saleable_stock, 2);
    }

    #[tokio::test]
    async fn physical_stock_attestation_waits_for_conflicting_writer_before_reading_snapshot() {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");
        seed_single_slot_planogram(&store).await;
        store
            .put_metadata("write-race", &"before")
            .await
            .expect("seed metadata");

        let mut blocker = store
            .pool()
            .begin_with("BEGIN IMMEDIATE")
            .await
            .expect("hold write lock");
        sqlx::query("UPDATE runtime_metadata SET value_json = ?2, updated_at = ?3 WHERE key = ?1")
            .bind("write-race")
            .bind("\"after\"")
            .bind(now_iso())
            .execute(&mut *blocker)
            .await
            .expect("change metadata while lock is held");

        let contender = store.record_physical_stock_attestation(PhysicalStockAttestationInput {
            attestation_id: "ATT-WRITE-RACE".to_string(),
            planogram_version: "PLAN-FAILURE".to_string(),
            operator_id: "operator-1".to_string(),
            slots: vec![PhysicalStockAttestationSlotInput {
                slot_id: "550e8400-e29b-41d4-a716-446655440001".to_string(),
                slot_code: "A1".to_string(),
                sku: "WATER-001".to_string(),
                quantity: 3,
                enabled: true,
            }],
        });
        tokio::pin!(contender);
        assert!(
            tokio::time::timeout(Duration::from_millis(50), contender.as_mut())
                .await
                .is_err(),
            "the contender must wait instead of reading a stale snapshot"
        );

        blocker.commit().await.expect("release write lock");
        let sale_view = tokio::time::timeout(Duration::from_secs(1), contender)
            .await
            .expect("contender should acquire lock after release")
            .expect("record physical stock attestation");
        assert_eq!(sale_view.items[0].physical_stock, 3);
    }

    fn dispense_command_for_slot(command_no: &str) -> DispenseCommandPayload {
        DispenseCommandPayload {
            command_no: command_no.to_string(),
            order_no: "ORD-FAILURE".to_string(),
            slot: vending_core::hardware::SlotPayload {
                layer_no: 1,
                cell_no: 1,
                slot_code: "A1".to_string(),
            },
            quantity: 1,
            timeout_seconds: 10,
        }
    }

    #[tokio::test]
    async fn sale_view_preserves_product_display_image_asset_url() {
        let temp = TempDir::new().expect("tempdir");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");

        let sale_view = store
            .apply_planogram(MachinePlanogramInput {
                planogram_version: "PLAN-MEDIA".to_string(),
                source: "test".to_string(),
                applied_by: None,
                slots: vec![MachinePlanogramSlotInput {
                    slot_id: "550e8400-e29b-41d4-a716-446655440001".to_string(),
                    slot_code: "A1".to_string(),
                    layer_no: 1,
                    cell_no: 1,
                    capacity: 8,
                    par_level: 6,
                    inventory_id: "550e8400-e29b-41d4-a716-446655440002".to_string(),
                    variant_id: "550e8400-e29b-41d4-a716-446655440003".to_string(),
                    product_id: "550e8400-e29b-41d4-a716-446655440004".to_string(),
                    product_name: "shirt".to_string(),
                    product_description: None,
                    cover_image_url: Some(
                        "/api/media-assets/550e8400-e29b-41d4-a716-446655440124/content"
                            .to_string(),
                    ),
                    try_on_silhouette_url: Some(
                        "/api/media-assets/550e8400-e29b-41d4-a716-446655440125/content"
                            .to_string(),
                    ),
                    category_id: None,
                    category_name: None,
                    sku: "TEE-001".to_string(),
                    size: Some("M".to_string()),
                    color: Some("white".to_string()),
                    price_cents: 3900,
                    product_sort_order: 1,
                    target_gender: None,
                }],
            })
            .await
            .expect("planogram");

        assert_eq!(
            sale_view.items[0].cover_image_url.as_deref(),
            Some("/api/media-assets/550e8400-e29b-41d4-a716-446655440124/content")
        );
        assert_eq!(
            sale_view.items[0].try_on_silhouette_url.as_deref(),
            Some("/api/media-assets/550e8400-e29b-41d4-a716-446655440125/content")
        );

        let reopened = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("reopen");
        let persisted = reopened.sale_view(None).await.expect("sale view");
        assert_eq!(
            persisted.items[0].cover_image_url.as_deref(),
            Some("/api/media-assets/550e8400-e29b-41d4-a716-446655440124/content")
        );
        assert_eq!(
            persisted.items[0].try_on_silhouette_url.as_deref(),
            Some("/api/media-assets/550e8400-e29b-41d4-a716-446655440125/content")
        );
    }

    #[tokio::test]
    async fn sale_view_keeps_saleable_items_when_one_persisted_projection_is_malformed() {
        let temp = TempDir::new().expect("tempdir");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");
        seed_single_slot_planogram(&store).await;

        let mut tx = store
            .pool()
            .begin()
            .await
            .expect("begin fixture transaction");
        sqlx::query(
            "UPDATE current_stock_projection
             SET physical_stock = 1, saleable_stock = 1, slot_sales_state = 'sale_ready'
             WHERE planogram_version = ?1 AND slot_id = ?2",
        )
        .bind("PLAN-FAILURE")
        .bind("550e8400-e29b-41d4-a716-446655440001")
        .execute(tx.as_mut())
        .await
        .expect("make valid item saleable");
        upsert_sale_view_projection_in_tx(
            &mut tx,
            "PLAN-FAILURE",
            "550e8400-e29b-41d4-a716-446655440001",
        )
        .await
        .expect("refresh valid projection");
        sqlx::query(
            "INSERT INTO machine_planogram_slots(
               planogram_version,slot_id,slot_code,layer_no,cell_no,capacity,par_level,
               inventory_id,variant_id,product_id,product_name,product_description,cover_image_url,
               try_on_silhouette_url,category_id,category_name,sku,size,color,price_cents,
               product_sort_order,target_gender
             ) SELECT
               planogram_version,?2,'A2',layer_no,2,capacity,par_level,
               inventory_id,variant_id,product_id,'malformed media item',product_description,cover_image_url,
               try_on_silhouette_url,category_id,category_name,sku,size,color,price_cents,
               product_sort_order + 1,target_gender
             FROM machine_planogram_slots
             WHERE planogram_version = ?1 AND slot_id = ?3",
        )
        .bind("PLAN-FAILURE")
        .bind("550e8400-e29b-41d4-a716-446655440099")
        .bind("550e8400-e29b-41d4-a716-446655440001")
        .execute(tx.as_mut())
        .await
        .expect("seed malformed slot metadata");
        sqlx::query(
            "INSERT INTO sale_view_projection(planogram_version,slot_id,item_json,slot_sales_state,updated_at)
             VALUES (?1,?2,?3,?4,?5)",
        )
        .bind("PLAN-FAILURE")
        .bind("550e8400-e29b-41d4-a716-446655440099")
        .bind("{malformed")
        .bind("sale_ready")
        .bind(now_iso())
        .execute(tx.as_mut())
        .await
        .expect("seed malformed projection");
        tx.commit().await.expect("commit fixture transaction");

        let sale_view = store
            .sale_view(Some("M001".to_string()))
            .await
            .expect("sale view");

        assert_eq!(sale_view.items.len(), 1);
        assert_eq!(sale_view.items[0].product_name, "water");
        assert_eq!(sale_view.items[0].saleable_stock, 1);
    }

    fn single_slot_stock_snapshot(
        on_hand_qty: i64,
        reserved_qty: i64,
        available_qty: i64,
    ) -> crate::backend::MachineStockSnapshot {
        crate::backend::MachineStockSnapshot {
            machine_code: "M001".to_string(),
            planogram_version: "PLAN-FAILURE".to_string(),
            slots: vec![crate::backend::MachineStockSnapshotSlot {
                slot_id: "550e8400-e29b-41d4-a716-446655440001".to_string(),
                slot_code: "A1".to_string(),
                inventory_id: "550e8400-e29b-41d4-a716-446655440002".to_string(),
                capacity: 8,
                on_hand_qty,
                reserved_qty,
                available_qty,
                slot_sales_state: None,
            }],
            server_time: "2026-06-12T00:00:00.000Z".to_string(),
        }
    }

    #[tokio::test]
    async fn platform_stock_snapshot_updates_local_sale_view_without_upload_outbox() {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");
        seed_single_slot_planogram(&store).await;
        store
            .record_stock_movement(StockMovementInput {
                movement_id: "MOVE-SEED".to_string(),
                planogram_version: "PLAN-FAILURE".to_string(),
                slot_id: "550e8400-e29b-41d4-a716-446655440001".to_string(),
                movement_type: "stock_count_correction".to_string(),
                quantity: 5,
                source: "local_maintenance".to_string(),
                attributed_to: None,
            })
            .await
            .expect("seed stock");

        let snapshot = crate::backend::MachineStockSnapshot {
            machine_code: "M001".to_string(),
            planogram_version: "PLAN-FAILURE".to_string(),
            slots: vec![crate::backend::MachineStockSnapshotSlot {
                slot_id: "550e8400-e29b-41d4-a716-446655440001".to_string(),
                slot_code: "A1".to_string(),
                inventory_id: "550e8400-e29b-41d4-a716-446655440002".to_string(),
                capacity: 8,
                on_hand_qty: 10,
                reserved_qty: 0,
                available_qty: 10,
                slot_sales_state: None,
            }],
            server_time: "2026-06-12T00:00:00.000Z".to_string(),
        };

        let sale_view = store
            .apply_platform_stock_snapshot(&snapshot)
            .await
            .expect("apply snapshot");

        assert_eq!(sale_view.items[0].physical_stock, 10);
        assert_eq!(sale_view.items[0].saleable_stock, 8);
        assert_eq!(sale_view.items[0].slot_sales_state, "sale_ready");
        assert_eq!(store.outbox_size().await.expect("outbox"), 0);
    }

    #[tokio::test]
    async fn platform_stock_snapshot_preserves_platform_slot_sale_blocker() {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");
        seed_single_slot_planogram(&store).await;
        store
            .record_stock_movement(StockMovementInput {
                movement_id: "MOVE-SEED-PLATFORM-BLOCKER".to_string(),
                planogram_version: "PLAN-FAILURE".to_string(),
                slot_id: "550e8400-e29b-41d4-a716-446655440001".to_string(),
                movement_type: "stock_count_correction".to_string(),
                quantity: 5,
                source: "local_maintenance".to_string(),
                attributed_to: None,
            })
            .await
            .expect("seed stock");

        let snapshot = crate::backend::MachineStockSnapshot {
            machine_code: "M001".to_string(),
            planogram_version: "PLAN-FAILURE".to_string(),
            slots: vec![crate::backend::MachineStockSnapshotSlot {
                slot_id: "550e8400-e29b-41d4-a716-446655440001".to_string(),
                slot_code: "A1".to_string(),
                inventory_id: "550e8400-e29b-41d4-a716-446655440002".to_string(),
                capacity: 8,
                on_hand_qty: 5,
                reserved_qty: 0,
                available_qty: 5,
                slot_sales_state: Some("frozen".to_string()),
            }],
            server_time: "2026-06-12T00:00:00.000Z".to_string(),
        };

        let sale_view = store
            .apply_platform_stock_snapshot(&snapshot)
            .await
            .expect("apply snapshot");

        assert_eq!(sale_view.items[0].physical_stock, 5);
        assert_eq!(sale_view.items[0].saleable_stock, 0);
        assert_eq!(sale_view.items[0].slot_sales_state, "frozen");
    }

    #[tokio::test]
    async fn platform_stock_snapshot_ignores_historical_terminal_orders() {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");
        seed_single_slot_planogram(&store).await;
        store
            .record_stock_movement(StockMovementInput {
                movement_id: "MOVE-SEED-BEFORE-TERMINAL-ORDERS".to_string(),
                planogram_version: "PLAN-FAILURE".to_string(),
                slot_id: "550e8400-e29b-41d4-a716-446655440001".to_string(),
                movement_type: "stock_count_correction".to_string(),
                quantity: 5,
                source: "local_maintenance".to_string(),
                attributed_to: None,
            })
            .await
            .expect("seed stock");

        store
            .upsert_order_session(OrderSessionUpsert {
                order_no: "ORDER-HISTORICAL-PENDING",
                payment_method: "payment_code",
                payment_provider: Some("alipay"),
                items_json: json!({
                    "inventoryId": "550e8400-e29b-41d4-a716-446655440002",
                    "slotId": "550e8400-e29b-41d4-a716-446655440001",
                    "slotCode": "A1",
                    "quantity": 1
                }),
                status: "pending_payment",
                next_action: "wait_payment",
                payment_attempt_json: None,
                recovery_strategy: "local",
                last_backend_status_json: None,
                last_error: None,
            })
            .await
            .expect("historical active order");
        tokio::time::sleep(std::time::Duration::from_millis(2)).await;

        for (order_no, status, next_action) in [
            ("ORDER-SUCCEEDED", "succeeded", "success"),
            ("ORDER-FAILED", "failed", "dispense_failed"),
            ("ORDER-EXPIRED", "payment_expired", "payment_expired"),
            ("ORDER-REFUND-PENDING", "refund_pending", "refund_pending"),
        ] {
            store
                .upsert_order_session(OrderSessionUpsert {
                    order_no,
                    payment_method: "payment_code",
                    payment_provider: Some("alipay"),
                    items_json: json!({
                        "inventoryId": "550e8400-e29b-41d4-a716-446655440002",
                        "slotId": "550e8400-e29b-41d4-a716-446655440001",
                        "slotCode": "A1",
                        "quantity": 1
                    }),
                    status,
                    next_action,
                    payment_attempt_json: None,
                    recovery_strategy: "local",
                    last_backend_status_json: None,
                    last_error: None,
                })
                .await
                .expect("historical terminal order");
        }

        let sale_view = store
            .apply_platform_stock_snapshot(&single_slot_stock_snapshot(10, 0, 10))
            .await
            .expect("terminal orders must not defer snapshot");

        assert_eq!(sale_view.items[0].physical_stock, 10);
        assert_eq!(sale_view.items[0].saleable_stock, 8);
        assert_eq!(sale_view.items[0].slot_sales_state, "sale_ready");
    }

    #[tokio::test]
    async fn platform_stock_snapshot_defers_while_local_order_is_active() {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");
        seed_single_slot_planogram(&store).await;
        store
            .record_stock_movement(StockMovementInput {
                movement_id: "MOVE-SEED-BEFORE-ACTIVE-ORDER".to_string(),
                planogram_version: "PLAN-FAILURE".to_string(),
                slot_id: "550e8400-e29b-41d4-a716-446655440001".to_string(),
                movement_type: "stock_count_correction".to_string(),
                quantity: 5,
                source: "local_maintenance".to_string(),
                attributed_to: None,
            })
            .await
            .expect("seed stock");
        store
            .upsert_order_session(OrderSessionUpsert {
                order_no: "ORDER-ACTIVE",
                payment_method: "payment_code",
                payment_provider: Some("alipay"),
                items_json: json!({
                    "inventoryId": "550e8400-e29b-41d4-a716-446655440002",
                    "slotId": "550e8400-e29b-41d4-a716-446655440001",
                    "slotCode": "A1",
                    "quantity": 1
                }),
                status: "pending_payment",
                next_action: "wait_payment",
                payment_attempt_json: None,
                recovery_strategy: "local",
                last_backend_status_json: None,
                last_error: None,
            })
            .await
            .expect("active order");

        let error = store
            .apply_platform_stock_snapshot(&single_slot_stock_snapshot(10, 0, 10))
            .await
            .expect_err("active local order defers snapshot");

        assert!(error.to_string().contains("local order is active"));
        let sale_view = store
            .sale_view(Some("M001".to_string()))
            .await
            .expect("view");
        assert_eq!(sale_view.items[0].physical_stock, 5);
        assert_eq!(sale_view.items[0].saleable_stock, 4);
    }

    #[tokio::test]
    async fn platform_stock_snapshot_does_not_override_pending_local_stock_upload() {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");
        seed_single_slot_planogram(&store).await;
        store
            .record_stock_movement(StockMovementInput {
                movement_id: "MOVE-SEED-BEFORE-PENDING".to_string(),
                planogram_version: "PLAN-FAILURE".to_string(),
                slot_id: "550e8400-e29b-41d4-a716-446655440001".to_string(),
                movement_type: "stock_count_correction".to_string(),
                quantity: 5,
                source: "local_maintenance".to_string(),
                attributed_to: None,
            })
            .await
            .expect("seed stock");
        let local_refill = store
            .record_stock_movement_with_upload(
                StockMovementInput {
                    movement_id: "MOVE-PENDING-REFILL".to_string(),
                    planogram_version: "PLAN-FAILURE".to_string(),
                    slot_id: "550e8400-e29b-41d4-a716-446655440001".to_string(),
                    movement_type: "planned_refill".to_string(),
                    quantity: 1,
                    source: "local_maintenance".to_string(),
                    attributed_to: None,
                },
                Some("M001"),
                Some("https://platform.example/api"),
            )
            .await
            .expect("pending refill");
        assert_eq!(local_refill.items[0].physical_stock, 6);

        let snapshot = crate::backend::MachineStockSnapshot {
            machine_code: "M001".to_string(),
            planogram_version: "PLAN-FAILURE".to_string(),
            slots: vec![crate::backend::MachineStockSnapshotSlot {
                slot_id: "550e8400-e29b-41d4-a716-446655440001".to_string(),
                slot_code: "A1".to_string(),
                inventory_id: "550e8400-e29b-41d4-a716-446655440002".to_string(),
                capacity: 8,
                on_hand_qty: 5,
                reserved_qty: 0,
                available_qty: 5,
                slot_sales_state: None,
            }],
            server_time: "2026-06-12T00:00:00.000Z".to_string(),
        };

        let error = store
            .apply_platform_stock_snapshot(&snapshot)
            .await
            .expect_err("pending local upload defers snapshot");
        assert!(error
            .to_string()
            .contains("local stock movements are pending upload"));
        let sale_view = store
            .sale_view(Some("M001".to_string()))
            .await
            .expect("view");
        assert_eq!(sale_view.items[0].physical_stock, 6);
        assert_eq!(sale_view.items[0].saleable_stock, 6);
    }

    #[tokio::test]
    async fn platform_stock_snapshot_rejects_capacity_mismatch() {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");
        seed_single_slot_planogram(&store).await;
        store
            .record_stock_movement(StockMovementInput {
                movement_id: "MOVE-SEED-CAPACITY".to_string(),
                planogram_version: "PLAN-FAILURE".to_string(),
                slot_id: "550e8400-e29b-41d4-a716-446655440001".to_string(),
                movement_type: "stock_count_correction".to_string(),
                quantity: 5,
                source: "local_maintenance".to_string(),
                attributed_to: None,
            })
            .await
            .expect("seed stock");

        let snapshot = crate::backend::MachineStockSnapshot {
            machine_code: "M001".to_string(),
            planogram_version: "PLAN-FAILURE".to_string(),
            slots: vec![crate::backend::MachineStockSnapshotSlot {
                slot_id: "550e8400-e29b-41d4-a716-446655440001".to_string(),
                slot_code: "A1".to_string(),
                inventory_id: "550e8400-e29b-41d4-a716-446655440002".to_string(),
                capacity: 10,
                on_hand_qty: 10,
                reserved_qty: 0,
                available_qty: 10,
                slot_sales_state: None,
            }],
            server_time: "2026-06-12T00:00:00.000Z".to_string(),
        };

        let error = store
            .apply_platform_stock_snapshot(&snapshot)
            .await
            .expect_err("capacity mismatch is rejected");
        assert!(error.to_string().contains("capacity mismatch"));
    }

    #[tokio::test]
    async fn open_runs_migration_and_writes_schema_version() {
        let temp = TempDir::new().expect("temp");
        let path = temp.path().join("state.db");
        let store = LocalStateStore::open(&path).await.expect("open");

        let tables: Vec<(String,)> =
            sqlx::query_as("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
                .fetch_all(store.pool())
                .await
                .expect("tables");
        let names: Vec<_> = tables.iter().map(|item| item.0.as_str()).collect();
        assert!(names.contains(&"runtime_metadata"));
        assert!(names.contains(&"machine_config"));
        assert!(names.contains(&"runtime_locks"));
        assert!(names.contains(&"command_log"));
        assert!(names.contains(&"outbox_events"));
        assert!(names.contains(&"order_sessions"));
        assert!(names.contains(&"health_events"));
        assert!(names.contains(&"machine_planogram_versions"));
        assert!(names.contains(&"machine_planogram_slots"));
        assert!(names.contains(&"stock_movements"));
        assert!(names.contains(&"stock_movement_sync"));
        assert!(names.contains(&"current_stock_projection"));
        assert!(names.contains(&"sale_view_projection"));
        assert!(names.contains(&"whole_machine_lock_clear_audit_events"));

        let schema_version: Option<i64> = store
            .get_metadata("schema_version")
            .await
            .expect("schema version")
            .unwrap();
        assert_eq!(schema_version, Some(SCHEMA_VERSION));
    }

    #[tokio::test]
    async fn manual_dispense_migration_upgrades_both_v12_and_issue15_v15_databases() {
        for prior_version in [12_i64, 15_i64] {
            let temp = TempDir::new().expect("temp");
            let path = temp.path().join(format!("state-v{prior_version}.db"));
            let store = LocalStateStore::open(&path)
                .await
                .expect("seed current database");
            sqlx::query("DROP TABLE manual_dispense_diagnostics")
                .execute(store.pool())
                .await
                .unwrap();
            if prior_version == 12 {
                sqlx::query("PRAGMA foreign_keys=OFF")
                    .execute(store.pool())
                    .await
                    .unwrap();
                for table in [
                    "stock_maintenance_task_tombstones",
                    "stock_maintenance_batches",
                    "stock_maintenance_task_identities",
                ] {
                    sqlx::query(&format!("DROP TABLE {table}"))
                        .execute(store.pool())
                        .await
                        .unwrap();
                }
                sqlx::query("PRAGMA foreign_keys=ON")
                    .execute(store.pool())
                    .await
                    .unwrap();
            }
            store
                .put_metadata("schema_version", &prior_version)
                .await
                .unwrap();
            drop(store);

            let upgraded = LocalStateStore::open(&path)
                .await
                .expect("upgrade database");
            let tables: Vec<(String,)> = sqlx::query_as(
                "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('manual_dispense_diagnostics','stock_maintenance_batches','stock_maintenance_task_identities','stock_maintenance_task_tombstones') ORDER BY name",
            ).fetch_all(upgraded.pool()).await.unwrap();
            assert_eq!(tables.len(), 4, "upgrade from v{prior_version}");
            assert_eq!(
                upgraded
                    .get_metadata::<i64>("schema_version")
                    .await
                    .unwrap(),
                Some(16)
            );
        }
    }

    #[tokio::test]
    async fn manual_dispense_diagnostic_is_a_separate_audit_ledger() {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");
        let record = ManualDispenseDiagnostic {
            diagnostic_id: "manual-1".to_string(),
            idempotency_key: "operator-request-1".to_string(),
            status: "completed".to_string(),
            operator_id: "operator-1".to_string(),
            session_correlation_id: "session-hash".to_string(),
            controller: json!({"adapter":"serial","portPath":"COM5"}),
            command: json!({"slotCode":"A1","quantity":1}),
            started_at: "2026-07-15T00:00:00.000Z".to_string(),
            completed_at: Some("2026-07-15T00:00:01.000Z".to_string()),
            raw_result: Some(json!({"success":true,"message":"controller completed"})),
            normalized_result: Some(json!({"outcome":"completed"})),
            reconciliation_status: "open".to_string(),
            expires_at: "2026-10-15T00:00:00.000Z".to_string(),
        };
        store
            .record_manual_dispense_diagnostic(&record)
            .await
            .expect("record diagnostic");

        let audit_count: (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM manual_dispense_diagnostics WHERE diagnostic_id='manual-1'",
        )
        .fetch_one(store.pool())
        .await
        .expect("audit row");
        let order_count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM order_sessions")
            .fetch_one(store.pool())
            .await
            .expect("no order");
        let movement_count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM stock_movements")
            .fetch_one(store.pool())
            .await
            .expect("no stock movement");
        assert_eq!(audit_count.0, 1);
        assert_eq!(order_count.0, 0);
        assert_eq!(movement_count.0, 0);
    }

    #[tokio::test]
    async fn manual_dispense_idempotency_reserves_once_before_hardware_and_survives_restart() {
        let temp = TempDir::new().expect("temp");
        let path = temp.path().join("state.db");
        let store = LocalStateStore::open(&path).await.expect("open");
        let pending = ManualDispenseDiagnostic {
            diagnostic_id: "manual-pending-1".to_string(),
            idempotency_key: "key-1".to_string(),
            status: "pending".to_string(),
            operator_id: "operator".to_string(),
            session_correlation_id: "correlation".to_string(),
            controller: json!({"stableIdentity":{"containerId":"controller-1"}}),
            command: json!({"namespace":"manual_diagnostic","quantity":1}),
            started_at: now_iso(),
            completed_at: None,
            raw_result: None,
            normalized_result: None,
            reconciliation_status: "open".to_string(),
            expires_at: (Utc::now() + chrono::Duration::days(90)).to_rfc3339(),
        };
        assert!(matches!(
            store
                .reserve_manual_dispense_diagnostic(&pending)
                .await
                .unwrap(),
            ManualDispenseReservation::Reserved(_)
        ));
        drop(store);
        let reopened = LocalStateStore::open(&path).await.expect("reopen");
        let duplicate = reopened
            .reserve_manual_dispense_diagnostic(&ManualDispenseDiagnostic {
                diagnostic_id: "manual-pending-2".to_string(),
                ..pending
            })
            .await
            .unwrap();
        let ManualDispenseReservation::Existing(existing) = duplicate else {
            panic!("must replay existing reservation")
        };
        assert_eq!(existing.diagnostic_id, "manual-pending-1");
        assert_eq!(existing.status, "pending");
        assert_eq!(existing.reconciliation_status, "open");
        let business_outbox: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM outbox_events")
            .fetch_one(reopened.pool())
            .await
            .unwrap();
        assert_eq!(business_outbox.0, 0);
    }

    #[tokio::test]
    async fn corrupt_database_is_quarantined_and_rebuilt_empty() {
        let temp = TempDir::new().expect("temp");
        let path = temp.path().join("state.db");
        std::fs::write(&path, b"not-a-sqlite-db").expect("write");

        let store = LocalStateStore::open(&path).await.expect("rebuild store");
        let sale_view = store.sale_view(None).await.expect("sale view");
        assert!(sale_view.items.is_empty());
        assert_eq!(sale_view.planogram_version, None);

        let rebuilt: Option<bool> = store
            .get_metadata(STOCK_LEDGER_REBUILT_AFTER_QUARANTINE_KEY)
            .await
            .expect("rebuilt marker");
        assert_eq!(rebuilt, Some(true));

        let mut quarantined = false;
        for item in std::fs::read_dir(temp.path()).expect("dir") {
            let item = item.expect("item");
            let name = item.file_name().to_string_lossy().to_string();
            if name.starts_with("state.corrupt-") {
                quarantined = true;
                let contents = std::fs::read(item.path()).expect("quarantine contents");
                assert_eq!(contents, b"not-a-sqlite-db");
                break;
            }
        }
        assert!(quarantined);
    }

    #[tokio::test]
    async fn rebuilt_ledger_planogram_requires_count_until_field_movement() {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");
        store
            .put_metadata(STOCK_LEDGER_REBUILT_AFTER_QUARANTINE_KEY, &true)
            .await
            .expect("ledger loss marker");

        let rebuilt = store
            .apply_planogram(MachinePlanogramInput {
                planogram_version: "PLAN-REBUILT".to_string(),
                source: "platform_sync_after_rebuild".to_string(),
                applied_by: None,
                slots: vec![MachinePlanogramSlotInput {
                    slot_id: "550e8400-e29b-41d4-a716-446655440001".to_string(),
                    slot_code: "A1".to_string(),
                    layer_no: 1,
                    cell_no: 1,
                    capacity: 8,
                    par_level: 6,
                    inventory_id: "550e8400-e29b-41d4-a716-446655440002".to_string(),
                    variant_id: "550e8400-e29b-41d4-a716-446655440003".to_string(),
                    product_id: "550e8400-e29b-41d4-a716-446655440004".to_string(),
                    product_name: "water".to_string(),
                    product_description: None,
                    cover_image_url: None,
                    try_on_silhouette_url: None,
                    category_id: None,
                    category_name: None,
                    sku: "WATER-001".to_string(),
                    size: Some("550ml".to_string()),
                    color: None,
                    price_cents: 200,
                    product_sort_order: 1,
                    target_gender: None,
                }],
            })
            .await
            .expect("planogram");

        assert_eq!(rebuilt.items[0].physical_stock, 0);
        assert_eq!(rebuilt.items[0].saleable_stock, 0);
        assert_eq!(rebuilt.items[0].slot_sales_state, "needs_count");

        let counted = store
            .record_stock_movement(StockMovementInput {
                movement_id: "MOVE-COUNT-AFTER-REBUILD".to_string(),
                planogram_version: "PLAN-REBUILT".to_string(),
                slot_id: "550e8400-e29b-41d4-a716-446655440001".to_string(),
                movement_type: "stock_count_correction".to_string(),
                quantity: 3,
                source: "field_count".to_string(),
                attributed_to: Some("operator-1".to_string()),
            })
            .await
            .expect("count correction");

        assert_eq!(counted.items[0].physical_stock, 3);
        assert_eq!(counted.items[0].saleable_stock, 3);
        assert_eq!(counted.items[0].slot_sales_state, "sale_ready");
    }

    #[tokio::test]
    async fn runtime_lock_blocks_second_instance() {
        let temp = TempDir::new().expect("temp");
        let path = temp.path().join("state.db");
        let store = LocalStateStore::open(&path).await.expect("open");
        store.acquire_runtime_lock(1).await.expect("lock");
        let store2 = LocalStateStore::open(&path).await.expect("open2");
        assert!(matches!(
            store2.acquire_runtime_lock(2).await,
            Err(StoreError::RuntimeLockHeld)
        ));
    }

    #[tokio::test]
    async fn no_drop_dispense_failure_marks_local_slot_suspect() {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");
        seed_single_slot_planogram(&store).await;

        let snapshot = store
            .block_slot_for_dispense_failure(
                &dispense_command_for_slot("CMD-NO-DROP"),
                Some("NO_DROP"),
                Some("drop sensor did not confirm item movement"),
            )
            .await
            .expect("block")
            .expect("slot found");

        assert_eq!(snapshot.items[0].slot_sales_state, "suspect");
        assert!(store
            .whole_machine_maintenance_lock()
            .await
            .expect("lock lookup")
            .is_none());
    }

    #[tokio::test]
    async fn successful_dispense_decrements_local_sale_view_once() {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");
        seed_single_slot_planogram(&store).await;
        store
            .record_stock_movement(StockMovementInput {
                movement_id: "MOVE-COUNT-BEFORE-DISPENSE".to_string(),
                planogram_version: "PLAN-FAILURE".to_string(),
                slot_id: "550e8400-e29b-41d4-a716-446655440001".to_string(),
                movement_type: "stock_count_correction".to_string(),
                quantity: 4,
                source: "field_count".to_string(),
                attributed_to: Some("operator-1".to_string()),
            })
            .await
            .expect("count");

        let command = dispense_command_for_slot("CMD-SUCCESS");
        let result = DispenseResultPayload {
            command_no: command.command_no.clone(),
            success: true,
            error_code: None,
            message: "serial: dispense completed".to_string(),
            reported_at: now_iso(),
        };
        let event = OutboxInput::dispense_result("MACHINE-1", &result);

        let first_recorded = store
            .record_command_result_and_enqueue_tx(&command, &result, &event)
            .await
            .expect("record result");
        assert!(first_recorded);
        let snapshot = store
            .apply_dispense_success_to_local_stock(&command)
            .await
            .expect("apply stock")
            .expect("slot found");
        assert_eq!(snapshot.items[0].physical_stock, 3);
        assert_eq!(snapshot.items[0].saleable_stock, 3);
        let movement: (String, i64, i64, i64) = sqlx::query_as(
            "SELECT movement_type, quantity, before_quantity, after_quantity
             FROM stock_movements
             WHERE movement_id = 'dispense:CMD-SUCCESS'",
        )
        .fetch_one(store.pool())
        .await
        .expect("dispense stock movement");
        assert_eq!(movement, ("dispense_succeeded".to_string(), 1, 4, 3));

        let duplicate_recorded = store
            .record_command_result_and_enqueue_tx(&command, &result, &event)
            .await
            .expect("record duplicate");
        assert!(!duplicate_recorded);
        let persisted = store.sale_view(None).await.expect("sale view");
        assert_eq!(persisted.items[0].physical_stock, 3);
        assert_eq!(persisted.items[0].saleable_stock, 3);
    }

    #[tokio::test]
    async fn physical_stock_attestation_aligns_ledger_and_keeps_disabled_or_empty_slots_unsaleable()
    {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");
        store
            .apply_planogram(MachinePlanogramInput {
                planogram_version: "PLAN-ATTEST".to_string(),
                source: "test".to_string(),
                applied_by: None,
                slots: vec![
                    MachinePlanogramSlotInput {
                        slot_id: "550e8400-e29b-41d4-a716-4466554400a1".to_string(),
                        slot_code: "A1".to_string(),
                        layer_no: 1,
                        cell_no: 1,
                        capacity: 8,
                        par_level: 6,
                        inventory_id: "550e8400-e29b-41d4-a716-4466554400b1".to_string(),
                        variant_id: "550e8400-e29b-41d4-a716-446655440003".to_string(),
                        product_id: "550e8400-e29b-41d4-a716-446655440004".to_string(),
                        product_name: "water".to_string(),
                        product_description: None,
                        cover_image_url: None,
                        try_on_silhouette_url: None,
                        category_id: None,
                        category_name: None,
                        sku: "WATER-001".to_string(),
                        size: Some("550ml".to_string()),
                        color: None,
                        price_cents: 200,
                        product_sort_order: 1,
                        target_gender: None,
                    },
                    MachinePlanogramSlotInput {
                        slot_id: "550e8400-e29b-41d4-a716-4466554400a2".to_string(),
                        slot_code: "A2".to_string(),
                        layer_no: 1,
                        cell_no: 2,
                        capacity: 8,
                        par_level: 6,
                        inventory_id: "550e8400-e29b-41d4-a716-4466554400b2".to_string(),
                        variant_id: "550e8400-e29b-41d4-a716-446655440013".to_string(),
                        product_id: "550e8400-e29b-41d4-a716-446655440014".to_string(),
                        product_name: "tea".to_string(),
                        product_description: None,
                        cover_image_url: None,
                        try_on_silhouette_url: None,
                        category_id: None,
                        category_name: None,
                        sku: "TEA-001".to_string(),
                        size: Some("500ml".to_string()),
                        color: None,
                        price_cents: 300,
                        product_sort_order: 2,
                        target_gender: None,
                    },
                    MachinePlanogramSlotInput {
                        slot_id: "550e8400-e29b-41d4-a716-4466554400a3".to_string(),
                        slot_code: "A3".to_string(),
                        layer_no: 1,
                        cell_no: 3,
                        capacity: 8,
                        par_level: 6,
                        inventory_id: "550e8400-e29b-41d4-a716-4466554400b3".to_string(),
                        variant_id: "550e8400-e29b-41d4-a716-446655440023".to_string(),
                        product_id: "550e8400-e29b-41d4-a716-446655440024".to_string(),
                        product_name: "juice".to_string(),
                        product_description: None,
                        cover_image_url: None,
                        try_on_silhouette_url: None,
                        category_id: None,
                        category_name: None,
                        sku: "JUICE-001".to_string(),
                        size: Some("450ml".to_string()),
                        color: None,
                        price_cents: 400,
                        product_sort_order: 3,
                        target_gender: None,
                    },
                ],
            })
            .await
            .expect("planogram");

        let sale_view = store
            .record_physical_stock_attestation(PhysicalStockAttestationInput {
                attestation_id: "ATT-001".to_string(),
                planogram_version: "PLAN-ATTEST".to_string(),
                operator_id: "operator-1".to_string(),
                slots: vec![
                    PhysicalStockAttestationSlotInput {
                        slot_id: "550e8400-e29b-41d4-a716-4466554400a1".to_string(),
                        slot_code: "A1".to_string(),
                        sku: "WATER-001".to_string(),
                        quantity: 5,
                        enabled: true,
                    },
                    PhysicalStockAttestationSlotInput {
                        slot_id: "550e8400-e29b-41d4-a716-4466554400a2".to_string(),
                        slot_code: "A2".to_string(),
                        sku: "TEA-001".to_string(),
                        quantity: 0,
                        enabled: true,
                    },
                    PhysicalStockAttestationSlotInput {
                        slot_id: "550e8400-e29b-41d4-a716-4466554400a3".to_string(),
                        slot_code: "A3".to_string(),
                        sku: "JUICE-001".to_string(),
                        quantity: 4,
                        enabled: false,
                    },
                ],
            })
            .await
            .expect("attestation");

        assert_eq!(sale_view.items[0].physical_stock, 5);
        assert_eq!(sale_view.items[0].saleable_stock, 5);
        assert_eq!(sale_view.items[0].slot_sales_state, "sale_ready");
        assert_eq!(sale_view.items[1].physical_stock, 0);
        assert_eq!(sale_view.items[1].saleable_stock, 0);
        assert_eq!(sale_view.items[1].slot_sales_state, "sold_out");
        assert_eq!(sale_view.items[2].physical_stock, 4);
        assert_eq!(sale_view.items[2].saleable_stock, 0);
        assert_eq!(sale_view.items[2].slot_sales_state, "frozen");

        let status = store
            .physical_stock_attestation_status()
            .await
            .expect("attestation status");
        assert_eq!(status.status, "ready");
        assert_eq!(status.attestation_id.as_deref(), Some("ATT-001"));
        assert_eq!(status.inconsistent_slots, Vec::<String>::new());
    }

    #[tokio::test]
    async fn physical_stock_attestation_creates_uploadable_stock_count_corrections() {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");
        seed_single_slot_planogram(&store).await;

        store
            .record_physical_stock_attestation_with_upload(
                PhysicalStockAttestationInput {
                    attestation_id: "ATT-UPLOAD".to_string(),
                    planogram_version: "PLAN-FAILURE".to_string(),
                    operator_id: "operator-1".to_string(),
                    slots: vec![PhysicalStockAttestationSlotInput {
                        slot_id: "550e8400-e29b-41d4-a716-446655440001".to_string(),
                        slot_code: "A1".to_string(),
                        sku: "WATER-001".to_string(),
                        quantity: 3,
                        enabled: true,
                    }],
                },
                Some("MACHINE-1"),
                Some("https://platform.example/api"),
            )
            .await
            .expect("attestation");

        let movement_id = "ATT-UPLOAD:550e8400-e29b-41d4-a716-446655440001";
        let sync = store
            .stock_movement_sync_record(movement_id)
            .await
            .expect("sync")
            .expect("sync exists");
        assert_eq!(sync.status, "pending");
        assert_eq!(
            sync.outbox_event_id,
            format!("stock-movement:{movement_id}")
        );

        let outbox = store
            .outbox_record(&format!("stock-movement:{movement_id}"))
            .await
            .expect("outbox")
            .expect("outbox exists");
        assert_eq!(outbox.kind, OutboxKind::StockMovementUpload);
        assert_eq!(outbox.payload_json["machineCode"], "MACHINE-1");
        assert_eq!(
            outbox.payload_json["movementType"],
            "stock_count_correction"
        );
        assert_eq!(outbox.payload_json["source"], "physical_stock_attestation");
        assert_eq!(outbox.payload_json["attributedTo"], "operator-1");
        assert_eq!(outbox.payload_json["beforeQuantity"], 0);
        assert_eq!(outbox.payload_json["afterQuantity"], 3);
        assert_eq!(
            outbox.payload_json["slotMappingSnapshot"]["inventoryId"],
            "550e8400-e29b-41d4-a716-446655440002"
        );
    }

    #[tokio::test]
    async fn uploaded_physical_stock_attestation_stays_pending_until_platform_accepts_then_commits()
    {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");
        seed_single_slot_planogram(&store).await;

        store
            .record_physical_stock_attestation_with_upload(
                PhysicalStockAttestationInput {
                    attestation_id: "ATT-ACK".to_string(),
                    planogram_version: "PLAN-FAILURE".to_string(),
                    operator_id: "operator-1".to_string(),
                    slots: vec![PhysicalStockAttestationSlotInput {
                        slot_id: "550e8400-e29b-41d4-a716-446655440001".to_string(),
                        slot_code: "A1".to_string(),
                        sku: "WATER-001".to_string(),
                        quantity: 3,
                        enabled: true,
                    }],
                },
                Some("MACHINE-1"),
                Some("https://platform.example/api"),
            )
            .await
            .expect("stage attestation");

        let pending = store
            .physical_stock_attestation_status()
            .await
            .expect("pending status");
        assert_eq!(pending.status, "pending");
        assert_eq!(pending.code, "PHYSICAL_STOCK_ATTESTATION_PENDING");
        let before_ack = store.sale_view(None).await.expect("sale view");
        assert_eq!(before_ack.items[0].physical_stock, 0);
        assert_eq!(before_ack.items[0].slot_sales_state, "needs_count");

        let movement_id = "ATT-ACK:550e8400-e29b-41d4-a716-446655440001";
        let event = store
            .outbox_record(&format!("stock-movement:{movement_id}"))
            .await
            .expect("outbox")
            .expect("event");
        store
            .record_stock_movement_upload_response(
                &event,
                &crate::backend::StockMovementUploadResponse {
                    movement_id: movement_id.to_string(),
                    status: "accepted".to_string(),
                    accepted_at: Some("2026-07-14T00:00:00.000Z".to_string()),
                    receipt: Some(json!({"rawMovementId":"raw-att-ack"})),
                    rejection: None,
                    reconciliation: None,
                },
            )
            .await
            .expect("accept");

        let accepted = store
            .physical_stock_attestation_status()
            .await
            .expect("accepted status");
        assert_eq!(accepted.status, "ready");
        let after_ack = store.sale_view(None).await.expect("sale view");
        assert_eq!(after_ack.items[0].physical_stock, 3);
        assert_eq!(after_ack.items[0].slot_sales_state, "sale_ready");
    }

    #[tokio::test]
    async fn partial_attestation_receipts_survive_restart_and_retry_only_rejected_slots() {
        let temp = TempDir::new().expect("temp");
        let database = temp.path().join("state.db");
        let store = LocalStateStore::open(&database).await.expect("open");
        seed_two_slot_planogram(&store).await;
        store
            .record_physical_stock_attestation_with_upload(
                two_slot_attestation("ATT-PARTIAL-1", 4),
                Some("MACHINE-1"),
                Some("https://platform.example/api"),
            )
            .await
            .expect("stage first generation");

        let accepted_id = "ATT-PARTIAL-1:550e8400-e29b-41d4-a716-446655440001";
        let rejected_id = "ATT-PARTIAL-1:550e8400-e29b-41d4-a716-446655440011";
        let accepted_event = store
            .outbox_record(&format!("stock-movement:{accepted_id}"))
            .await
            .expect("accepted outbox lookup")
            .expect("accepted event");
        store
            .record_stock_movement_upload_response(
                &accepted_event,
                &crate::backend::StockMovementUploadResponse {
                    movement_id: accepted_id.to_string(),
                    status: "accepted".to_string(),
                    accepted_at: Some("2026-07-15T00:00:00.000Z".to_string()),
                    receipt: Some(json!({"rawMovementId":"raw-a1-generation-1"})),
                    rejection: None,
                    reconciliation: None,
                },
            )
            .await
            .expect("accept A1");
        let rejected_event = store
            .outbox_record(&format!("stock-movement:{rejected_id}"))
            .await
            .expect("rejected outbox lookup")
            .expect("rejected event");
        store
            .record_stock_movement_upload_response(
                &rejected_event,
                &crate::backend::StockMovementUploadResponse {
                    movement_id: rejected_id.to_string(),
                    status: "rejected".to_string(),
                    accepted_at: None,
                    receipt: None,
                    rejection: Some(json!({"reason":"abnormal_variance"})),
                    reconciliation: None,
                },
            )
            .await
            .expect("reject A2");
        assert_eq!(
            store
                .physical_stock_attestation_status()
                .await
                .expect("partial status")
                .status,
            "failed"
        );
        assert!(store
            .sale_view(None)
            .await
            .expect("uncommitted sale view")
            .items
            .iter()
            .all(|item| item.physical_stock == 0));
        sqlx::query(
            "UPDATE stock_movement_sync
             SET accepted_at = '2026-05-01T00:00:00.000Z', updated_at = '2026-05-01T00:00:00.000Z'
             WHERE movement_id = ?1",
        )
        .bind(accepted_id)
        .execute(store.pool())
        .await
        .expect("age carried receipt");
        store
            .prune_accepted_stock_movement_history(1)
            .await
            .expect("prune unrelated accepted history");
        assert!(store
            .stock_movement_sync_record(accepted_id)
            .await
            .expect("pending receipt after pruning")
            .is_some());
        drop(store);

        let restarted = LocalStateStore::open(&database).await.expect("restart");
        let mut conflicting_retry = two_slot_attestation("ATT-PARTIAL-CONFLICT", 5);
        conflicting_retry.slots[0].quantity = 2;
        assert!(matches!(
            restarted
                .record_physical_stock_attestation_with_upload(
                    conflicting_retry,
                    Some("MACHINE-1"),
                    Some("https://platform.example/api"),
                )
                .await,
            Err(StoreError::InvalidStockInput(message))
                if message.contains("Platform-accepted attested slot A1 cannot be changed")
        ));
        restarted
            .record_physical_stock_attestation_with_upload(
                two_slot_attestation("ATT-PARTIAL-2", 5),
                Some("MACHINE-1"),
                Some("https://platform.example/api"),
            )
            .await
            .expect("retry rejected slot");

        let duplicate_accepted_id = "ATT-PARTIAL-2:550e8400-e29b-41d4-a716-446655440001";
        assert!(restarted
            .stock_movement_sync_record(duplicate_accepted_id)
            .await
            .expect("duplicate accepted generation lookup")
            .is_none());
        assert!(restarted
            .stock_movement_sync_record(accepted_id)
            .await
            .expect("carried receipt lookup")
            .is_some_and(|sync| sync.status == "accepted"));
        let retried_id = "ATT-PARTIAL-2:550e8400-e29b-41d4-a716-446655440011";
        let retried_event = restarted
            .outbox_record(&format!("stock-movement:{retried_id}"))
            .await
            .expect("retried outbox lookup")
            .expect("retried event");
        assert_eq!(retried_event.payload_json["beforeQuantity"], 0);
        assert_eq!(retried_event.payload_json["afterQuantity"], 5);
        restarted
            .record_stock_movement_upload_response(
                &retried_event,
                &crate::backend::StockMovementUploadResponse {
                    movement_id: retried_id.to_string(),
                    status: "accepted".to_string(),
                    accepted_at: Some("2026-07-15T00:01:00.000Z".to_string()),
                    receipt: Some(json!({"rawMovementId":"raw-a2-generation-2"})),
                    rejection: None,
                    reconciliation: None,
                },
            )
            .await
            .expect("accept retried A2");

        let ready = restarted
            .physical_stock_attestation_status()
            .await
            .expect("ready status");
        assert_eq!(ready.status, "ready");
        let sale_view = restarted.sale_view(None).await.expect("sale view");
        assert_eq!(sale_view.items[0].physical_stock, 3);
        assert_eq!(sale_view.items[1].physical_stock, 5);
        let movement_ids: Vec<(String,)> = sqlx::query_as(
            "SELECT movement_id FROM stock_movements WHERE source = 'physical_stock_attestation' ORDER BY movement_id",
        )
        .fetch_all(restarted.pool())
        .await
        .expect("committed movement ids");
        assert_eq!(
            movement_ids,
            vec![(accepted_id.to_string(),), (retried_id.to_string(),)]
        );
        drop(restarted);
        let finalized_restart = LocalStateStore::open(&database)
            .await
            .expect("restart finalized state");
        assert_eq!(
            finalized_restart
                .physical_stock_attestation_status()
                .await
                .expect("idempotent finalized status")
                .status,
            "ready"
        );
        let movement_count: (i64,) = sqlx::query_as(
            "SELECT COUNT(1) FROM stock_movements WHERE source = 'physical_stock_attestation'",
        )
        .fetch_one(finalized_restart.pool())
        .await
        .expect("movement count after finalized restart");
        assert_eq!(movement_count.0, 2);
    }

    #[tokio::test]
    async fn partial_reconciliation_retries_only_the_unaccepted_slot_generation() {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");
        seed_two_slot_planogram(&store).await;
        store
            .record_physical_stock_attestation_with_upload(
                two_slot_attestation("ATT-RECONCILE-1", 4),
                Some("MACHINE-1"),
                Some("https://platform.example/api"),
            )
            .await
            .expect("stage first generation");
        let accepted_id = "ATT-RECONCILE-1:550e8400-e29b-41d4-a716-446655440001";
        let reconciled_id = "ATT-RECONCILE-1:550e8400-e29b-41d4-a716-446655440011";
        for (movement_id, response) in [
            (
                accepted_id,
                crate::backend::StockMovementUploadResponse {
                    movement_id: accepted_id.to_string(),
                    status: "accepted".to_string(),
                    accepted_at: Some("2026-07-15T00:00:00.000Z".to_string()),
                    receipt: Some(json!({"rawMovementId":"raw-reconcile-a1"})),
                    rejection: None,
                    reconciliation: None,
                },
            ),
            (
                reconciled_id,
                crate::backend::StockMovementUploadResponse {
                    movement_id: reconciled_id.to_string(),
                    status: "reconciliation".to_string(),
                    accepted_at: None,
                    receipt: None,
                    rejection: None,
                    reconciliation: Some(crate::backend::StockMovementReconciliation {
                        reason: "abnormal_variance".to_string(),
                        platform_review: Some(json!({"required":true,"status":"open"})),
                        sale_safety_blocker: None,
                    }),
                },
            ),
        ] {
            let event = store
                .outbox_record(&format!("stock-movement:{movement_id}"))
                .await
                .expect("outbox lookup")
                .expect("event");
            store
                .record_stock_movement_upload_response(&event, &response)
                .await
                .expect("record Platform response");
        }

        store
            .record_physical_stock_attestation_with_upload(
                two_slot_attestation("ATT-RECONCILE-2", 6),
                Some("MACHINE-1"),
                Some("https://platform.example/api"),
            )
            .await
            .expect("retry reconciled slot");
        assert!(store
            .stock_movement_sync_record("ATT-RECONCILE-2:550e8400-e29b-41d4-a716-446655440001",)
            .await
            .expect("duplicate accepted lookup")
            .is_none());
        assert!(store
            .outbox_record("stock-movement:ATT-RECONCILE-2:550e8400-e29b-41d4-a716-446655440011",)
            .await
            .expect("retry outbox lookup")
            .is_some());
        let retried_id = "ATT-RECONCILE-2:550e8400-e29b-41d4-a716-446655440011";
        let retried_event = store
            .outbox_record(&format!("stock-movement:{retried_id}"))
            .await
            .expect("retried outbox lookup")
            .expect("retried event");
        store
            .record_stock_movement_upload_response(
                &retried_event,
                &crate::backend::StockMovementUploadResponse {
                    movement_id: retried_id.to_string(),
                    status: "accepted".to_string(),
                    accepted_at: Some("2026-07-15T00:02:00.000Z".to_string()),
                    receipt: Some(json!({"rawMovementId":"raw-reconcile-a2-generation-2"})),
                    rejection: None,
                    reconciliation: None,
                },
            )
            .await
            .expect("accept reconciled retry");
        assert_eq!(
            store
                .physical_stock_attestation_status()
                .await
                .expect("ready status")
                .status,
            "ready"
        );
        let sale_view = store.sale_view(None).await.expect("sale view");
        assert_eq!(sale_view.items[0].physical_stock, 3);
        assert_eq!(sale_view.items[1].physical_stock, 6);
    }

    #[tokio::test]
    async fn rejected_uploaded_physical_stock_attestation_keeps_the_cursor_pending_without_fake_stock(
    ) {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");
        seed_single_slot_planogram(&store).await;

        store
            .record_physical_stock_attestation_with_upload(
                PhysicalStockAttestationInput {
                    attestation_id: "ATT-REJECT".to_string(),
                    planogram_version: "PLAN-FAILURE".to_string(),
                    operator_id: "operator-1".to_string(),
                    slots: vec![PhysicalStockAttestationSlotInput {
                        slot_id: "550e8400-e29b-41d4-a716-446655440001".to_string(),
                        slot_code: "A1".to_string(),
                        sku: "WATER-001".to_string(),
                        quantity: 3,
                        enabled: true,
                    }],
                },
                Some("MACHINE-1"),
                Some("https://platform.example/api"),
            )
            .await
            .expect("stage attestation");
        let movement_id = "ATT-REJECT:550e8400-e29b-41d4-a716-446655440001";
        let event = store
            .outbox_record(&format!("stock-movement:{movement_id}"))
            .await
            .expect("outbox")
            .expect("event");
        store
            .record_stock_movement_upload_response(
                &event,
                &crate::backend::StockMovementUploadResponse {
                    movement_id: movement_id.to_string(),
                    status: "rejected".to_string(),
                    accepted_at: None,
                    receipt: None,
                    rejection: Some(json!({"reason":"capacity"})),
                    reconciliation: None,
                },
            )
            .await
            .expect("reject");

        let rejected = store
            .physical_stock_attestation_status()
            .await
            .expect("rejected status");
        assert_eq!(rejected.status, "failed");
        assert_eq!(rejected.code, "PHYSICAL_STOCK_ATTESTATION_REJECTED");
        let sale_view = store.sale_view(None).await.expect("sale view");
        assert_eq!(sale_view.items[0].physical_stock, 0);
        assert_eq!(sale_view.items[0].slot_sales_state, "needs_count");
    }

    #[tokio::test]
    async fn physical_stock_attestation_status_detects_projection_that_does_not_replay_from_facts()
    {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");
        seed_single_slot_planogram(&store).await;
        store
            .record_physical_stock_attestation(PhysicalStockAttestationInput {
                attestation_id: "ATT-REPLAY".to_string(),
                planogram_version: "PLAN-FAILURE".to_string(),
                operator_id: "operator-1".to_string(),
                slots: vec![PhysicalStockAttestationSlotInput {
                    slot_id: "550e8400-e29b-41d4-a716-446655440001".to_string(),
                    slot_code: "A1".to_string(),
                    sku: "WATER-001".to_string(),
                    quantity: 3,
                    enabled: true,
                }],
            })
            .await
            .expect("attestation");

        sqlx::query(
            "UPDATE current_stock_projection
             SET physical_stock = 2
             WHERE planogram_version = 'PLAN-FAILURE'
               AND slot_id = '550e8400-e29b-41d4-a716-446655440001'",
        )
        .execute(store.pool())
        .await
        .expect("corrupt projection");

        let status = store
            .physical_stock_attestation_status()
            .await
            .expect("attestation status");

        assert_eq!(status.status, "inconsistent");
        assert_eq!(status.inconsistent_slots, vec!["A1".to_string()]);
    }

    #[tokio::test]
    async fn physical_stock_attestation_becomes_stale_when_active_planogram_changes() {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");
        seed_single_slot_planogram(&store).await;
        store
            .record_physical_stock_attestation(PhysicalStockAttestationInput {
                attestation_id: "ATT-STALE".to_string(),
                planogram_version: "PLAN-FAILURE".to_string(),
                operator_id: "operator-1".to_string(),
                slots: vec![PhysicalStockAttestationSlotInput {
                    slot_id: "550e8400-e29b-41d4-a716-446655440001".to_string(),
                    slot_code: "A1".to_string(),
                    sku: "WATER-001".to_string(),
                    quantity: 3,
                    enabled: true,
                }],
            })
            .await
            .expect("attestation");

        store
            .apply_planogram(MachinePlanogramInput {
                planogram_version: "PLAN-AFTER-ATTEST".to_string(),
                source: "test".to_string(),
                applied_by: None,
                slots: vec![MachinePlanogramSlotInput {
                    slot_id: "550e8400-e29b-41d4-a716-446655440001".to_string(),
                    slot_code: "A1".to_string(),
                    layer_no: 1,
                    cell_no: 1,
                    capacity: 8,
                    par_level: 6,
                    inventory_id: "550e8400-e29b-41d4-a716-446655440002".to_string(),
                    variant_id: "550e8400-e29b-41d4-a716-446655440003".to_string(),
                    product_id: "550e8400-e29b-41d4-a716-446655440004".to_string(),
                    product_name: "water".to_string(),
                    product_description: None,
                    cover_image_url: None,
                    try_on_silhouette_url: None,
                    category_id: None,
                    category_name: None,
                    sku: "WATER-001".to_string(),
                    size: Some("550ml".to_string()),
                    color: None,
                    price_cents: 200,
                    product_sort_order: 1,
                    target_gender: None,
                }],
            })
            .await
            .expect("new planogram");

        let status = store
            .physical_stock_attestation_status()
            .await
            .expect("attestation status");

        assert_eq!(status.status, "stale");
        assert_eq!(status.code, "PHYSICAL_STOCK_ATTESTATION_STALE");
    }

    #[tokio::test]
    async fn sale_view_subtracts_active_order_reservation_from_saleable_stock() {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");
        seed_single_slot_planogram(&store).await;
        store
            .record_stock_movement(StockMovementInput {
                movement_id: "MOVE-COUNT-BEFORE-ORDER".to_string(),
                planogram_version: "PLAN-FAILURE".to_string(),
                slot_id: "550e8400-e29b-41d4-a716-446655440001".to_string(),
                movement_type: "stock_count_correction".to_string(),
                quantity: 1,
                source: "field_count".to_string(),
                attributed_to: Some("operator-1".to_string()),
            })
            .await
            .expect("count");
        store
            .upsert_order_session(OrderSessionUpsert {
                order_no: "ORDER-RESERVED",
                payment_method: "payment_code",
                payment_provider: Some("alipay"),
                items_json: json!({
                    "inventoryId": "550e8400-e29b-41d4-a716-446655440002",
                    "slotId": "550e8400-e29b-41d4-a716-446655440001",
                    "slotCode": "A1",
                    "quantity": 1
                }),
                status: "pending_payment",
                next_action: "wait_payment",
                payment_attempt_json: None,
                recovery_strategy: "local",
                last_backend_status_json: None,
                last_error: None,
            })
            .await
            .expect("order");

        let sale_view = store.sale_view(None).await.expect("sale view");

        assert_eq!(sale_view.items[0].physical_stock, 1);
        assert_eq!(sale_view.items[0].saleable_stock, 0);
        assert_eq!(sale_view.items[0].slot_sales_state, "sale_ready");
    }

    #[tokio::test]
    async fn sale_view_ignores_expired_order_reservation() {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");
        seed_single_slot_planogram(&store).await;
        store
            .record_stock_movement(StockMovementInput {
                movement_id: "MOVE-COUNT-AFTER-EXPIRED-ORDER".to_string(),
                planogram_version: "PLAN-FAILURE".to_string(),
                slot_id: "550e8400-e29b-41d4-a716-446655440001".to_string(),
                movement_type: "stock_count_correction".to_string(),
                quantity: 1,
                source: "field_count".to_string(),
                attributed_to: Some("operator-1".to_string()),
            })
            .await
            .expect("count");
        store
            .upsert_order_session(OrderSessionUpsert {
                order_no: "ORDER-EXPIRED",
                payment_method: "payment_code",
                payment_provider: Some("alipay"),
                items_json: json!({
                    "inventoryId": "550e8400-e29b-41d4-a716-446655440002",
                    "slotId": "550e8400-e29b-41d4-a716-446655440001",
                    "slotCode": "A1",
                    "quantity": 1
                }),
                status: "payment_expired",
                next_action: "payment_expired",
                payment_attempt_json: None,
                recovery_strategy: "local",
                last_backend_status_json: None,
                last_error: None,
            })
            .await
            .expect("order");

        let sale_view = store.sale_view(None).await.expect("sale view");

        assert_eq!(sale_view.items[0].physical_stock, 1);
        assert_eq!(sale_view.items[0].saleable_stock, 1);
    }

    #[tokio::test]
    async fn sale_view_ignores_pending_order_after_payment_expires_at() {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");
        seed_single_slot_planogram(&store).await;
        store
            .record_stock_movement(StockMovementInput {
                movement_id: "MOVE-COUNT-AFTER-PAYMENT-EXPIRES".to_string(),
                planogram_version: "PLAN-FAILURE".to_string(),
                slot_id: "550e8400-e29b-41d4-a716-446655440001".to_string(),
                movement_type: "stock_count_correction".to_string(),
                quantity: 1,
                source: "field_count".to_string(),
                attributed_to: Some("operator-1".to_string()),
            })
            .await
            .expect("count");
        store
            .upsert_order_session(OrderSessionUpsert {
                order_no: "ORDER-PENDING-EXPIRED-PAYMENT",
                payment_method: "qr_code",
                payment_provider: Some("alipay"),
                items_json: json!({
                    "inventoryId": "550e8400-e29b-41d4-a716-446655440002",
                    "slotId": "550e8400-e29b-41d4-a716-446655440001",
                    "slotCode": "A1",
                    "quantity": 1
                }),
                status: "pending_payment",
                next_action: "wait_payment",
                payment_attempt_json: None,
                recovery_strategy: "local",
                last_backend_status_json: Some(json!({
                    "payment": {
                        "expiresAt": "2000-01-01T00:00:00.000Z"
                    }
                })),
                last_error: None,
            })
            .await
            .expect("order");

        let sale_view = store.sale_view(None).await.expect("sale view");

        assert_eq!(sale_view.items[0].physical_stock, 1);
        assert_eq!(sale_view.items[0].saleable_stock, 1);
    }

    #[tokio::test]
    async fn sale_view_ignores_terminal_next_action_even_when_status_is_stale() {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");
        seed_single_slot_planogram(&store).await;
        store
            .record_stock_movement(StockMovementInput {
                movement_id: "MOVE-COUNT-STALE-EXPIRED-ORDER".to_string(),
                planogram_version: "PLAN-FAILURE".to_string(),
                slot_id: "550e8400-e29b-41d4-a716-446655440001".to_string(),
                movement_type: "stock_count_correction".to_string(),
                quantity: 1,
                source: "field_count".to_string(),
                attributed_to: Some("operator-1".to_string()),
            })
            .await
            .expect("count");
        store
            .upsert_order_session(OrderSessionUpsert {
                order_no: "ORDER-STALE-EXPIRED",
                payment_method: "payment_code",
                payment_provider: Some("alipay"),
                items_json: json!({
                    "inventoryId": "550e8400-e29b-41d4-a716-446655440002",
                    "slotId": "550e8400-e29b-41d4-a716-446655440001",
                    "slotCode": "A1",
                    "quantity": 1
                }),
                status: "waiting_payment",
                next_action: "payment_expired",
                payment_attempt_json: None,
                recovery_strategy: "local",
                last_backend_status_json: None,
                last_error: None,
            })
            .await
            .expect("order");

        let sale_view = store.sale_view(None).await.expect("sale view");

        assert_eq!(sale_view.items[0].physical_stock, 1);
        assert_eq!(sale_view.items[0].saleable_stock, 1);
    }

    #[tokio::test]
    async fn sale_view_ignores_stale_historical_pending_orders_when_latest_is_terminal() {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");
        seed_single_slot_planogram(&store).await;
        store
            .record_stock_movement(StockMovementInput {
                movement_id: "MOVE-COUNT-HISTORICAL-PENDING".to_string(),
                planogram_version: "PLAN-FAILURE".to_string(),
                slot_id: "550e8400-e29b-41d4-a716-446655440001".to_string(),
                movement_type: "stock_count_correction".to_string(),
                quantity: 1,
                source: "field_count".to_string(),
                attributed_to: Some("operator-1".to_string()),
            })
            .await
            .expect("count");
        store
            .upsert_order_session(OrderSessionUpsert {
                order_no: "ORDER-HISTORICAL-PENDING",
                payment_method: "payment_code",
                payment_provider: Some("alipay"),
                items_json: json!({
                    "inventoryId": "550e8400-e29b-41d4-a716-446655440002",
                    "slotId": "550e8400-e29b-41d4-a716-446655440001",
                    "slotCode": "A1",
                    "quantity": 1
                }),
                status: "pending_payment",
                next_action: "wait_payment",
                payment_attempt_json: None,
                recovery_strategy: "local",
                last_backend_status_json: None,
                last_error: None,
            })
            .await
            .expect("historical order");
        store
            .upsert_order_session(OrderSessionUpsert {
                order_no: "ORDER-LATEST-EXPIRED",
                payment_method: "payment_code",
                payment_provider: Some("alipay"),
                items_json: json!({
                    "inventoryId": "550e8400-e29b-41d4-a716-446655440002",
                    "slotId": "550e8400-e29b-41d4-a716-446655440001",
                    "slotCode": "A1",
                    "quantity": 1
                }),
                status: "payment_expired",
                next_action: "payment_expired",
                payment_attempt_json: None,
                recovery_strategy: "local",
                last_backend_status_json: None,
                last_error: None,
            })
            .await
            .expect("latest order");

        let sale_view = store.sale_view(None).await.expect("sale view");

        assert_eq!(sale_view.items[0].physical_stock, 1);
        assert_eq!(sale_view.items[0].saleable_stock, 1);
    }

    #[tokio::test]
    async fn current_order_session_summary_maps_payment_expired_to_closed() {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");
        store
            .upsert_order_session(OrderSessionUpsert {
                order_no: "ORDER-EXPIRED-SUMMARY",
                payment_method: "payment_code",
                payment_provider: Some("alipay"),
                items_json: json!([]),
                status: "payment_expired",
                next_action: "payment_expired",
                payment_attempt_json: None,
                recovery_strategy: "local",
                last_backend_status_json: None,
                last_error: None,
            })
            .await
            .expect("order");

        let summary = store
            .current_order_session_snapshot()
            .await
            .expect("summary")
            .expect("current");

        assert_eq!(
            summary.status,
            Some(vending_core::domain::OrderSessionStatus::Closed)
        );
        assert_eq!(
            summary.next_action,
            Some(InternalCheckoutFlowAction::PaymentExpired)
        );
    }

    #[tokio::test]
    async fn jammed_dispense_failure_freezes_local_slot() {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");
        seed_single_slot_planogram(&store).await;

        let snapshot = store
            .block_slot_for_dispense_failure(
                &dispense_command_for_slot("CMD-JAMMED"),
                Some("JAMMED"),
                Some("lower controller reported mechanical fault during dispense"),
            )
            .await
            .expect("block")
            .expect("slot found");

        assert_eq!(snapshot.items[0].slot_sales_state, "frozen");
        let lock = store
            .whole_machine_maintenance_lock()
            .await
            .expect("lock lookup")
            .expect("whole machine lock");
        assert_eq!(lock.code, "WHOLE_MACHINE_HARDWARE_FAULT");
        assert_eq!(lock.command_no, "CMD-JAMMED");
        assert_eq!(lock.slot_code, "A1");
    }

    #[tokio::test]
    async fn unknown_dispense_result_freezes_local_slot_until_manual_clear() {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");
        seed_single_slot_planogram(&store).await;

        let snapshot = store
            .block_slot_for_dispense_result_unknown(&dispense_command_for_slot("CMD-UNKNOWN"))
            .await
            .expect("block")
            .expect("slot found");
        assert_eq!(snapshot.items[0].slot_sales_state, "frozen");

        let persisted = store.sale_view(None).await.expect("sale view");
        assert_eq!(persisted.items[0].slot_sales_state, "frozen");

        let cleared = store
            .update_slot_sales_state(SlotSalesStateInput {
                planogram_version: "PLAN-FAILURE".to_string(),
                slot_id: "550e8400-e29b-41d4-a716-446655440001".to_string(),
                slot_sales_state: "sale_ready".to_string(),
                source: "manual_resolution".to_string(),
            })
            .await
            .expect("clear");
        assert_eq!(cleared.items[0].slot_sales_state, "sale_ready");
    }

    #[tokio::test]
    async fn local_maintenance_refill_unfreezes_target_slot_after_dispense_failure() {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");
        seed_single_slot_planogram(&store).await;
        store
            .record_stock_movement(StockMovementInput {
                movement_id: "MOVE-COUNT-BEFORE-JAM".to_string(),
                planogram_version: "PLAN-FAILURE".to_string(),
                slot_id: "550e8400-e29b-41d4-a716-446655440001".to_string(),
                movement_type: "stock_count_correction".to_string(),
                quantity: 4,
                source: "field_count".to_string(),
                attributed_to: Some("operator-1".to_string()),
            })
            .await
            .expect("count");

        let frozen = store
            .block_slot_for_dispense_failure(
                &dispense_command_for_slot("CMD-JAM-BEFORE-REFILL"),
                Some("JAMMED"),
                Some("lower controller reported pickup platform blocked"),
            )
            .await
            .expect("block")
            .expect("slot found");
        assert_eq!(frozen.items[0].physical_stock, 4);
        assert_eq!(frozen.items[0].saleable_stock, 4);
        assert_eq!(frozen.items[0].slot_sales_state, "frozen");

        let refilled = store
            .record_stock_movement(StockMovementInput {
                movement_id: "MOVE-LOCAL-REFILL-AFTER-JAM".to_string(),
                planogram_version: "PLAN-FAILURE".to_string(),
                slot_id: "550e8400-e29b-41d4-a716-446655440001".to_string(),
                movement_type: "planned_refill".to_string(),
                quantity: 1,
                source: "local_maintenance".to_string(),
                attributed_to: Some("front-panel".to_string()),
            })
            .await
            .expect("local maintenance refill");

        assert_eq!(refilled.items[0].physical_stock, 5);
        assert_eq!(refilled.items[0].saleable_stock, 5);
        assert_eq!(refilled.items[0].slot_sales_state, "sale_ready");
    }

    #[tokio::test]
    async fn command_log_dedupes_final_result() {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");

        let command = DispenseCommandPayload {
            command_no: "CMD-1".to_string(),
            order_no: "ORD-1".to_string(),
            slot: vending_core::hardware::SlotPayload {
                layer_no: 1,
                cell_no: 1,
                slot_code: "A1".to_string(),
            },
            quantity: 1,
            timeout_seconds: 10,
        };

        let result = DispenseResultPayload {
            command_no: command.command_no.clone(),
            success: true,
            error_code: None,
            message: "ok".to_string(),
            reported_at: now_iso(),
        };

        let event = OutboxInput::dispense_result("MACHINE-1", &result);
        store
            .record_command_result_and_enqueue_tx(&command, &result, &event)
            .await
            .expect("first");
        let before = store
            .list_due_outbox(Utc::now() + chrono::Duration::days(1))
            .await
            .expect("outbox");
        assert_eq!(before.len(), 1);

        store
            .record_command_result_and_enqueue_tx(&command, &result, &event)
            .await
            .expect("second");
        let after = store
            .list_due_outbox(Utc::now() + chrono::Duration::days(1))
            .await
            .expect("outbox");
        assert_eq!(after.len(), 1);
        let command_record = store
            .get_command(&command.command_no)
            .await
            .expect("command")
            .expect("command record");
        assert_eq!(command_record.status, CommandLogStatus::Succeeded);
    }

    #[tokio::test]
    async fn stock_movement_upload_metadata_is_durable_with_local_movement() {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");

        store
            .apply_planogram(MachinePlanogramInput {
                planogram_version: "PLAN-1".to_string(),
                source: "test".to_string(),
                applied_by: Some("operator-1".to_string()),
                slots: vec![MachinePlanogramSlotInput {
                    slot_id: "550e8400-e29b-41d4-a716-446655440001".to_string(),
                    slot_code: "A1".to_string(),
                    layer_no: 1,
                    cell_no: 1,
                    capacity: 8,
                    par_level: 6,
                    inventory_id: "550e8400-e29b-41d4-a716-446655440002".to_string(),
                    variant_id: "550e8400-e29b-41d4-a716-446655440003".to_string(),
                    product_id: "550e8400-e29b-41d4-a716-446655440004".to_string(),
                    product_name: "water".to_string(),
                    product_description: None,
                    cover_image_url: None,
                    try_on_silhouette_url: None,
                    category_id: None,
                    category_name: None,
                    sku: "WATER-001".to_string(),
                    size: Some("550ml".to_string()),
                    color: None,
                    price_cents: 200,
                    product_sort_order: 1,
                    target_gender: None,
                }],
            })
            .await
            .expect("planogram");

        store
            .record_stock_movement_with_upload(
                StockMovementInput {
                    movement_id: "MOVE-1".to_string(),
                    planogram_version: "PLAN-1".to_string(),
                    slot_id: "550e8400-e29b-41d4-a716-446655440001".to_string(),
                    movement_type: "planned_refill".to_string(),
                    quantity: 3,
                    source: "field_service".to_string(),
                    attributed_to: Some("operator-1".to_string()),
                },
                Some("MACHINE-1"),
                Some("https://platform.example/api"),
            )
            .await
            .expect("movement");

        let movement_record: (i64, i64, String) = sqlx::query_as(
            "SELECT before_quantity, after_quantity, slot_mapping_snapshot_json
             FROM stock_movements WHERE movement_id = 'MOVE-1'",
        )
        .fetch_one(store.pool())
        .await
        .expect("movement record");
        assert_eq!(movement_record.0, 0);
        assert_eq!(movement_record.1, 3);
        let slot_mapping_snapshot: serde_json::Value =
            serde_json::from_str(&movement_record.2).expect("slot mapping snapshot");
        assert_eq!(slot_mapping_snapshot["slotCode"], "A1");
        assert_eq!(slot_mapping_snapshot["capacity"], 8);
        assert_eq!(
            slot_mapping_snapshot["inventoryId"],
            "550e8400-e29b-41d4-a716-446655440002"
        );

        let sync = store
            .stock_movement_sync_record("MOVE-1")
            .await
            .expect("sync")
            .expect("sync exists");
        assert_eq!(sync.status, "pending");
        assert_eq!(sync.attempt_count, 0);
        assert_eq!(sync.outbox_event_id, "stock-movement:MOVE-1");

        let outbox = store
            .outbox_record("stock-movement:MOVE-1")
            .await
            .expect("outbox")
            .expect("outbox exists");
        assert_eq!(outbox.kind, OutboxKind::StockMovementUpload);
        assert_eq!(outbox.transport, OutboxTransport::Http);
        assert_eq!(
            outbox.target_url.as_deref(),
            Some("https://platform.example/api/machine-stock-movements")
        );
        assert_eq!(outbox.payload_json["movementId"], "MOVE-1");
        assert_eq!(outbox.payload_json["machineCode"], "MACHINE-1");
        assert_eq!(outbox.payload_json["beforeQuantity"], 0);
        assert_eq!(outbox.payload_json["afterQuantity"], 3);
        assert_eq!(outbox.payload_json["slotMappingSnapshot"]["slotCode"], "A1");
        assert_eq!(outbox.payload_json["slotMappingSnapshot"]["capacity"], 8);
    }

    #[tokio::test]
    async fn planned_refill_over_capacity_freezes_the_slot_without_recording_fake_physical_stock() {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");
        seed_single_slot_planogram(&store).await;
        store
            .record_stock_movement(StockMovementInput {
                movement_id: "MOVE-BASE".to_string(),
                planogram_version: "PLAN-FAILURE".to_string(),
                slot_id: "550e8400-e29b-41d4-a716-446655440001".to_string(),
                movement_type: "stock_count_correction".to_string(),
                quantity: 7,
                source: "local_maintenance".to_string(),
                attributed_to: Some("operator-1".to_string()),
            })
            .await
            .expect("base count");

        let error = store
            .record_stock_movement(StockMovementInput {
                movement_id: "MOVE-OVER-CAPACITY".to_string(),
                planogram_version: "PLAN-FAILURE".to_string(),
                slot_id: "550e8400-e29b-41d4-a716-446655440001".to_string(),
                movement_type: "planned_refill".to_string(),
                quantity: 2,
                source: "local_maintenance".to_string(),
                attributed_to: Some("operator-1".to_string()),
            })
            .await
            .expect_err("capacity must reject");
        assert!(error.to_string().contains("exceeds capacity"));

        let snapshot = store.sale_view(None).await.expect("sale view");
        assert_eq!(snapshot.items[0].physical_stock, 7);
        assert_eq!(snapshot.items[0].saleable_stock, 0);
        assert_eq!(snapshot.items[0].slot_sales_state, "needs_platform_review");
        let count: (i64,) = sqlx::query_as(
            "SELECT COUNT(1) FROM stock_movements WHERE movement_id = 'MOVE-OVER-CAPACITY'",
        )
        .fetch_one(store.pool())
        .await
        .expect("movement count");
        assert_eq!(count.0, 0);
    }

    #[tokio::test]
    async fn stock_movement_replay_with_the_same_idempotency_key_is_applied_once() {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");
        seed_single_slot_planogram(&store).await;
        let movement = StockMovementInput {
            movement_id: "MOVE-RETRY-SAME-KEY".to_string(),
            planogram_version: "PLAN-FAILURE".to_string(),
            slot_id: "550e8400-e29b-41d4-a716-446655440001".to_string(),
            movement_type: "planned_refill".to_string(),
            quantity: 2,
            source: "local_maintenance".to_string(),
            attributed_to: Some("operator-1".to_string()),
        };
        store
            .record_stock_movement(movement.clone())
            .await
            .expect("first request");
        let retry = store
            .record_stock_movement(movement)
            .await
            .expect("response-loss retry");

        assert_eq!(retry.items[0].physical_stock, 2);
        let count: (i64,) = sqlx::query_as(
            "SELECT COUNT(1) FROM stock_movements WHERE movement_id = 'MOVE-RETRY-SAME-KEY'",
        )
        .fetch_one(store.pool())
        .await
        .expect("movement count");
        assert_eq!(count.0, 1);
    }

    async fn seed_stock_movement_upload(store: &LocalStateStore, movement_id: &str) {
        store
            .apply_planogram(MachinePlanogramInput {
                planogram_version: "PLAN-1".to_string(),
                source: "test".to_string(),
                applied_by: None,
                slots: vec![MachinePlanogramSlotInput {
                    slot_id: "550e8400-e29b-41d4-a716-446655440001".to_string(),
                    slot_code: "A1".to_string(),
                    layer_no: 1,
                    cell_no: 1,
                    capacity: 8,
                    par_level: 6,
                    inventory_id: "550e8400-e29b-41d4-a716-446655440002".to_string(),
                    variant_id: "550e8400-e29b-41d4-a716-446655440003".to_string(),
                    product_id: "550e8400-e29b-41d4-a716-446655440004".to_string(),
                    product_name: "water".to_string(),
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
        store
            .record_stock_movement_with_upload(
                StockMovementInput {
                    movement_id: movement_id.to_string(),
                    planogram_version: "PLAN-1".to_string(),
                    slot_id: "550e8400-e29b-41d4-a716-446655440001".to_string(),
                    movement_type: "planned_refill".to_string(),
                    quantity: 3,
                    source: "field_service".to_string(),
                    attributed_to: None,
                },
                Some("MACHINE-1"),
                Some("https://platform.example/api"),
            )
            .await
            .expect("movement");
    }

    #[tokio::test]
    async fn stock_movement_upload_failure_keeps_outbox_and_records_retry_state() {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");
        seed_stock_movement_upload(&store, "MOVE-RETRY").await;

        store
            .mark_stock_movement_upload_failed(
                "stock-movement:MOVE-RETRY",
                "MOVE-RETRY",
                "backend offline",
            )
            .await
            .expect("failed");

        let sync = store
            .stock_movement_sync_record("MOVE-RETRY")
            .await
            .expect("sync")
            .expect("sync exists");
        assert_eq!(sync.status, "failed");
        assert_eq!(sync.attempt_count, 1);
        assert_eq!(sync.last_error.as_deref(), Some("backend offline"));
        assert!(store
            .outbox_record("stock-movement:MOVE-RETRY")
            .await
            .expect("outbox")
            .is_some());
    }

    #[tokio::test]
    async fn stock_movement_upload_failure_rolls_back_outbox_when_sync_update_fails() {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");
        seed_stock_movement_upload(&store, "MOVE-TX-FAIL").await;
        sqlx::query(
            "CREATE TRIGGER fail_stock_movement_sync_update BEFORE UPDATE ON stock_movement_sync
             BEGIN SELECT RAISE(ABORT, 'forced sync update failure'); END;",
        )
        .execute(store.pool())
        .await
        .expect("trigger");

        let result = store
            .mark_stock_movement_upload_failed(
                "stock-movement:MOVE-TX-FAIL",
                "MOVE-TX-FAIL",
                "backend offline",
            )
            .await;

        assert!(result.is_err());
        let outbox = store
            .outbox_record("stock-movement:MOVE-TX-FAIL")
            .await
            .expect("outbox")
            .expect("outbox exists");
        assert_eq!(outbox.attempt_count, 0);
        assert_eq!(outbox.last_error, None);
    }

    #[tokio::test]
    async fn stock_movement_upload_response_keeps_outbox_when_sync_row_is_missing() {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");
        seed_stock_movement_upload(&store, "MOVE-MISSING-SYNC").await;
        let event = store
            .outbox_record("stock-movement:MOVE-MISSING-SYNC")
            .await
            .expect("outbox")
            .expect("event");
        sqlx::query("DELETE FROM stock_movement_sync WHERE movement_id = ?1")
            .bind("MOVE-MISSING-SYNC")
            .execute(store.pool())
            .await
            .expect("delete sync");
        let response = crate::backend::StockMovementUploadResponse {
            movement_id: "MOVE-MISSING-SYNC".to_string(),
            status: "accepted".to_string(),
            accepted_at: Some("2026-06-04T00:00:00.000Z".to_string()),
            receipt: Some(json!({"rawMovementId":"raw-1"})),
            rejection: None,
            reconciliation: None,
        };

        let result = store
            .record_stock_movement_upload_response(&event, &response)
            .await;

        assert!(result.is_err());
        assert!(store
            .outbox_record("stock-movement:MOVE-MISSING-SYNC")
            .await
            .expect("outbox")
            .is_some());
    }

    #[tokio::test]
    async fn stock_movement_upload_response_stores_receipt_and_removes_outbox() {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");
        seed_stock_movement_upload(&store, "MOVE-ACCEPT").await;
        let event = store
            .outbox_record("stock-movement:MOVE-ACCEPT")
            .await
            .expect("outbox")
            .expect("event");

        let response = crate::backend::StockMovementUploadResponse {
            movement_id: "MOVE-ACCEPT".to_string(),
            status: "accepted".to_string(),
            accepted_at: Some("2026-06-04T00:00:00.000Z".to_string()),
            receipt: Some(json!({"rawMovementId":"raw-1"})),
            rejection: None,
            reconciliation: None,
        };
        store
            .record_stock_movement_upload_response(&event, &response)
            .await
            .expect("receipt");

        let sync = store
            .stock_movement_sync_record("MOVE-ACCEPT")
            .await
            .expect("sync")
            .expect("sync exists");
        assert_eq!(sync.status, "accepted");
        assert_eq!(sync.attempt_count, 1);
        assert_eq!(
            sync.accepted_at.as_deref(),
            Some("2026-06-04T00:00:00.000Z")
        );
        assert_eq!(
            sync.platform_receipt_json.expect("receipt")["status"],
            "accepted"
        );
        assert!(store
            .outbox_record("stock-movement:MOVE-ACCEPT")
            .await
            .expect("outbox")
            .is_none());
    }

    #[tokio::test]
    async fn stock_movement_rejection_is_terminal_receipt() {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");
        seed_stock_movement_upload(&store, "MOVE-REJECT").await;
        let event = store
            .outbox_record("stock-movement:MOVE-REJECT")
            .await
            .expect("outbox")
            .expect("event");

        let response = crate::backend::StockMovementUploadResponse {
            movement_id: "MOVE-REJECT".to_string(),
            status: "reconciliation".to_string(),
            accepted_at: None,
            receipt: None,
            rejection: Some(json!({"reason":"movement_id_payload_conflict"})),
            reconciliation: None,
        };
        store
            .record_stock_movement_upload_response(&event, &response)
            .await
            .expect("rejection");

        let sync = store
            .stock_movement_sync_record("MOVE-REJECT")
            .await
            .expect("sync")
            .expect("sync exists");
        assert_eq!(sync.status, "reconciliation");
        assert!(sync.rejection_json.is_some());
        assert!(store
            .outbox_record("stock-movement:MOVE-REJECT")
            .await
            .expect("outbox")
            .is_none());
    }

    #[tokio::test]
    async fn accepted_stock_movement_history_prunes_after_retention_without_losing_projection() {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");
        seed_stock_movement_upload(&store, "MOVE-OLD-ACCEPTED").await;
        let event = store
            .outbox_record("stock-movement:MOVE-OLD-ACCEPTED")
            .await
            .expect("outbox")
            .expect("event");
        let response = crate::backend::StockMovementUploadResponse {
            movement_id: "MOVE-OLD-ACCEPTED".to_string(),
            status: "accepted".to_string(),
            accepted_at: Some("2026-05-01T00:00:00.000Z".to_string()),
            receipt: Some(json!({"rawMovementId":"raw-old"})),
            rejection: None,
            reconciliation: None,
        };
        store
            .record_stock_movement_upload_response(&event, &response)
            .await
            .expect("accepted");
        sqlx::query(
            "UPDATE stock_movements SET occurred_at = '2026-05-01T00:00:00.000Z' WHERE movement_id = ?1",
        )
        .bind("MOVE-OLD-ACCEPTED")
        .execute(store.pool())
        .await
        .expect("age movement");
        sqlx::query(
            "UPDATE stock_movement_sync SET accepted_at = '2026-05-01T00:00:00.000Z', updated_at = '2026-05-01T00:00:00.000Z' WHERE movement_id = ?1",
        )
        .bind("MOVE-OLD-ACCEPTED")
        .execute(store.pool())
        .await
        .expect("age sync");

        let pruned = store
            .prune_accepted_stock_movement_history(1)
            .await
            .expect("prune");
        assert_eq!(pruned, 1);

        let movement_count: (i64,) =
            sqlx::query_as("SELECT COUNT(1) FROM stock_movements WHERE movement_id = ?1")
                .bind("MOVE-OLD-ACCEPTED")
                .fetch_one(store.pool())
                .await
                .expect("movement count");
        assert_eq!(movement_count.0, 0);
        assert!(store
            .stock_movement_sync_record("MOVE-OLD-ACCEPTED")
            .await
            .expect("sync")
            .is_none());

        let sale_view = store.sale_view(None).await.expect("sale view");
        assert_eq!(sale_view.items[0].physical_stock, 3);
        assert_eq!(sale_view.items[0].saleable_stock, 3);
        assert_eq!(sale_view.items[0].slot_sales_state, "sale_ready");

        let refilled = store
            .record_stock_movement(StockMovementInput {
                movement_id: "MOVE-REFILL-AFTER-PRUNE".to_string(),
                planogram_version: "PLAN-1".to_string(),
                slot_id: "550e8400-e29b-41d4-a716-446655440001".to_string(),
                movement_type: "planned_refill".to_string(),
                quantity: 2,
                source: "field_service".to_string(),
                attributed_to: Some("operator-2".to_string()),
            })
            .await
            .expect("refill after prune");
        assert_eq!(refilled.items[0].physical_stock, 5);
        assert_eq!(refilled.items[0].saleable_stock, 5);
    }

    #[tokio::test]
    async fn maintenance_task_history_prunes_only_old_unreferenced_terminal_rounds_after_restart() {
        let temp = TempDir::new().expect("temp");
        let database = temp.path().join("state.db");
        let store = LocalStateStore::open(&database).await.expect("open");
        seed_two_slot_planogram(&store).await;
        store
            .record_physical_stock_attestation(two_slot_attestation("ATT-READY", 2))
            .await
            .expect("initial stock");

        let mut rounds = Vec::new();
        for addition in [1_i64, 1_i64] {
            let task = store.stock_maintenance_task().await.expect("refill task");
            let input = StockMaintenanceBatchInput {
                task_id: task.task_id.clone(),
                mode: task.mode,
                slots: vec![StockMaintenanceBatchSlotInput {
                    slot_code: "A1".to_string(),
                    quantity: None,
                    addition: Some(addition),
                }],
            };
            store
                .submit_stock_maintenance_batch(
                    input.clone(),
                    "operator",
                    "MACHINE-1",
                    "https://platform.example/api",
                )
                .await
                .expect("submit round");
            let movement_id = format!(
                "{}:{}",
                task.task_id, "550e8400-e29b-41d4-a716-446655440001"
            );
            let event = store
                .outbox_record(&format!("stock-movement:{movement_id}"))
                .await
                .expect("outbox lookup")
                .expect("outbox event");
            store
                .record_stock_movement_upload_response(
                    &event,
                    &crate::backend::StockMovementUploadResponse {
                        movement_id,
                        status: "accepted".to_string(),
                        accepted_at: Some(now_iso()),
                        receipt: Some(json!({"rawMovementId":format!("raw-{addition}")})),
                        rejection: None,
                        reconciliation: None,
                    },
                )
                .await
                .expect("accept round");
            rounds.push((task.task_id, input));
        }
        let current = store.stock_maintenance_task().await.expect("current task");
        let (old_task_id, old_input) = rounds[0].clone();
        let (recent_task_id, recent_input) = rounds[1].clone();
        sqlx::query(
            "UPDATE stock_maintenance_task_identities SET created_at='2026-05-01T00:00:00.000Z'
             WHERE task_id IN (?1,?2)",
        )
        .bind(&old_task_id)
        .bind(&recent_task_id)
        .execute(store.pool())
        .await
        .expect("age terminal identities");
        sqlx::query(
            "UPDATE stock_maintenance_batches SET created_at='2026-05-01T00:00:00.000Z'
             WHERE task_id=?1",
        )
        .bind(&old_task_id)
        .execute(store.pool())
        .await
        .expect("age old batch");
        sqlx::query(
            "UPDATE stock_movement_sync
             SET accepted_at='2026-05-01T00:00:00.000Z',updated_at='2026-05-01T00:00:00.000Z'
             WHERE movement_id LIKE ?1",
        )
        .bind(format!("{}:%", old_task_id))
        .execute(store.pool())
        .await
        .expect("age old terminal receipt");
        drop(store);

        let restarted = LocalStateStore::open(&database).await.expect("restart");
        restarted
            .prune_accepted_stock_movement_history(1)
            .await
            .expect("prune maintenance task history");
        for (task_id, expected_identity, expected_batch) in [
            (old_task_id.as_str(), 0_i64, 0_i64),
            (recent_task_id.as_str(), 1_i64, 1_i64),
            (current.task_id.as_str(), 1_i64, 0_i64),
        ] {
            let counts: (i64, i64) = sqlx::query_as(
                "SELECT
                   (SELECT COUNT(1) FROM stock_maintenance_task_identities WHERE task_id=?1),
                   (SELECT COUNT(1) FROM stock_maintenance_batches WHERE task_id=?1)",
            )
            .bind(task_id)
            .fetch_one(restarted.pool())
            .await
            .expect("history counts");
            assert_eq!(counts, (expected_identity, expected_batch), "{task_id}");
        }
        let replay = restarted
            .submit_stock_maintenance_batch(
                recent_input,
                "renewed-operator",
                "MACHINE-1",
                "https://platform.example/api",
            )
            .await
            .expect("retained exact lost-response replay");
        assert!(replay.duplicate);

        let before = restarted
            .sale_view(None)
            .await
            .expect("before late request");
        let late = restarted
            .submit_stock_maintenance_batch(
                old_input,
                "late-operator",
                "MACHINE-1",
                "https://platform.example/api",
            )
            .await
            .expect_err("pruned task must fail closed");
        assert!(late.to_string().contains("expired"));
        let after = restarted.sale_view(None).await.expect("after late request");
        let stock_state = |snapshot: &SaleViewSnapshot| {
            snapshot
                .items
                .iter()
                .map(|item| {
                    (
                        item.slot_code.clone(),
                        item.physical_stock,
                        item.saleable_stock,
                        item.slot_sales_state.clone(),
                    )
                })
                .collect::<Vec<_>>()
        };
        assert_eq!(stock_state(&after), stock_state(&before));
        let late_writes: (i64, i64) = sqlx::query_as(
            "SELECT
               (SELECT COUNT(1) FROM stock_movement_sync WHERE movement_id LIKE ?1),
               (SELECT COUNT(1) FROM outbox_events WHERE id LIKE ?2)",
        )
        .bind(format!("{}:%", old_task_id))
        .bind(format!("stock-movement:{}:%", old_task_id))
        .fetch_one(restarted.pool())
        .await
        .expect("late write count");
        assert_eq!(late_writes, (0, 0));
    }

    #[tokio::test]
    async fn maintenance_task_prune_protects_every_live_reference() {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");
        seed_two_slot_planogram(&store).await;
        let current = store.stock_maintenance_task().await.expect("current task");
        let base = store
            .stock_maintenance_task_identity_by_id(&current.task_id)
            .await
            .expect("load identity")
            .expect("identity");

        for (task_id, status, predecessor, with_outbox) in [
            ("protected-by-metadata", "accepted", None, false),
            ("protected-by-attestation", "accepted", None, false),
            (
                "protected-by-predecessor-generation",
                "accepted",
                Some("pending-generation"),
                false,
            ),
            ("protected-pending", "pending", None, false),
            ("protected-failed", "failed", None, false),
            ("protected-rejected", "rejected", None, false),
            ("protected-reconciliation", "reconciliation", None, false),
            ("protected-outbox", "accepted", None, true),
            ("protected-zero-sync-outbox", "accepted", None, true),
            ("prune-terminal", "accepted", None, false),
        ] {
            seed_old_maintenance_history(&store, &base, task_id, status, predecessor, with_outbox)
                .await;
        }
        sqlx::query(
            "DELETE FROM stock_movement_sync WHERE movement_id LIKE 'protected-zero-sync-outbox:%'",
        )
        .execute(store.pool())
        .await
        .expect("simulate legacy zero-sync outbox");

        let mut metadata_identity = base.clone();
        metadata_identity.task_id = "protected-by-metadata".to_string();
        store
            .put_metadata(STOCK_MAINTENANCE_COUNT_TASK_KEY, &metadata_identity)
            .await
            .expect("protect current metadata identity");
        let attestation = two_slot_attestation("protected-by-attestation", 2);
        let pending = PendingPhysicalStockAttestation {
            input: attestation.clone(),
            attested_at: now_iso(),
            movement_ids: vec![format!(
                "{}:{}",
                attestation.attestation_id, attestation.slots[0].slot_id
            )],
            slot_generations: vec![PendingPhysicalStockAttestationSlotGeneration {
                slot_id: attestation.slots[0].slot_id.clone(),
                movement_id: format!(
                    "{}:{}",
                    attestation.attestation_id, attestation.slots[0].slot_id
                ),
                generation: "pending-generation".to_string(),
                before_quantity: 0,
                after_quantity: attestation.slots[0].quantity,
                occurred_at: now_iso(),
            }],
        };
        store
            .put_metadata(PENDING_PHYSICAL_STOCK_ATTESTATION_KEY, &pending)
            .await
            .expect("protect pending generations");

        store
            .prune_accepted_stock_movement_history(1)
            .await
            .expect("prune");

        for task_id in [
            "protected-by-metadata",
            "protected-by-attestation",
            "protected-by-predecessor-generation",
            "protected-pending",
            "protected-failed",
            "protected-rejected",
            "protected-reconciliation",
            "protected-outbox",
            "protected-zero-sync-outbox",
        ] {
            let counts: (i64, i64) = sqlx::query_as(
                "SELECT
                   (SELECT COUNT(1) FROM stock_maintenance_task_identities WHERE task_id=?1),
                   (SELECT COUNT(1) FROM stock_maintenance_batches WHERE task_id=?1)",
            )
            .bind(task_id)
            .fetch_one(store.pool())
            .await
            .expect("protected history counts");
            assert_eq!(counts, (1, 1), "{task_id}");
        }
        let pruned: (i64, i64) = sqlx::query_as(
            "SELECT
               (SELECT COUNT(1) FROM stock_maintenance_task_identities WHERE task_id='prune-terminal'),
               (SELECT COUNT(1) FROM stock_maintenance_batches WHERE task_id='prune-terminal')",
        )
        .fetch_one(store.pool())
        .await
        .expect("pruned history counts");
        assert_eq!(pruned, (0, 0));
    }

    #[tokio::test]
    async fn maintenance_task_prune_reaps_legacy_zero_sync_history_without_outbox() {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");
        seed_two_slot_planogram(&store).await;
        let current = store.stock_maintenance_task().await.expect("current task");
        let base = store
            .stock_maintenance_task_identity_by_id(&current.task_id)
            .await
            .expect("load identity")
            .expect("identity");
        seed_old_maintenance_history(&store, &base, "legacy-zero-sync", "accepted", None, false)
            .await;
        sqlx::query("DELETE FROM stock_movement_sync WHERE movement_id LIKE 'legacy-zero-sync:%'")
            .execute(store.pool())
            .await
            .expect("simulate legacy cleared sync");

        store
            .prune_accepted_stock_movement_history(1)
            .await
            .expect("prune");

        let counts: (i64, i64, i64) = sqlx::query_as(
            "SELECT
               (SELECT COUNT(1) FROM stock_maintenance_task_identities WHERE task_id='legacy-zero-sync'),
               (SELECT COUNT(1) FROM stock_maintenance_batches WHERE task_id='legacy-zero-sync'),
               (SELECT COUNT(1) FROM stock_maintenance_task_tombstones WHERE task_id='legacy-zero-sync')",
        )
        .fetch_one(store.pool())
        .await
        .expect("legacy zero-sync counts");
        assert_eq!(counts, (0, 0, 1));

        let retry = StockMaintenanceBatchInput {
            task_id: "legacy-zero-sync".to_string(),
            mode: current.mode.clone(),
            slots: current
                .slots
                .iter()
                .map(|slot| StockMaintenanceBatchSlotInput {
                    slot_code: slot.slot_code.clone(),
                    quantity: Some(slot.current_quantity),
                    addition: None,
                })
                .collect(),
        };
        let error = store
            .submit_stock_maintenance_batch(
                retry,
                "late-operator",
                "MACHINE-1",
                "https://platform.example/api",
            )
            .await
            .expect_err("pruned zero-sync history must fail closed");
        assert!(error.to_string().contains("expired"));
    }

    #[tokio::test]
    async fn maintenance_task_prune_reaps_abandoned_identity_without_batch_or_sync() {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");
        seed_two_slot_planogram(&store).await;
        let current = store.stock_maintenance_task().await.expect("current task");
        let base = store
            .stock_maintenance_task_identity_by_id(&current.task_id)
            .await
            .expect("load identity")
            .expect("identity");
        let mut abandoned = base.clone();
        abandoned.task_id = "abandoned-zero-sync".to_string();
        store
            .remember_stock_maintenance_task_identity(&abandoned)
            .await
            .expect("remember abandoned identity");
        sqlx::query(
            "UPDATE stock_maintenance_task_identities
             SET created_at='2026-05-01T00:00:00.000Z' WHERE task_id='abandoned-zero-sync'",
        )
        .execute(store.pool())
        .await
        .expect("age abandoned identity");

        store
            .prune_accepted_stock_movement_history(1)
            .await
            .expect("prune");

        let counts: (i64, i64) = sqlx::query_as(
            "SELECT
               (SELECT COUNT(1) FROM stock_maintenance_task_identities WHERE task_id='abandoned-zero-sync'),
               (SELECT COUNT(1) FROM stock_maintenance_task_tombstones WHERE task_id='abandoned-zero-sync')",
        )
        .fetch_one(store.pool())
        .await
        .expect("abandoned counts");
        assert_eq!(counts, (0, 1));
    }

    #[tokio::test]
    async fn maintenance_task_prune_rolls_back_all_history_on_delete_failure() {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");
        seed_two_slot_planogram(&store).await;
        let current = store.stock_maintenance_task().await.expect("current task");
        let base = store
            .stock_maintenance_task_identity_by_id(&current.task_id)
            .await
            .expect("load identity")
            .expect("identity");
        seed_old_maintenance_history(&store, &base, "atomic-terminal", "accepted", None, false)
            .await;
        sqlx::query(
            "CREATE TRIGGER fail_maintenance_identity_delete
             BEFORE DELETE ON stock_maintenance_task_identities
             WHEN OLD.task_id='atomic-terminal'
             BEGIN SELECT RAISE(ABORT,'injected identity delete failure'); END",
        )
        .execute(store.pool())
        .await
        .expect("failure trigger");

        store
            .prune_accepted_stock_movement_history(1)
            .await
            .expect_err("delete failure must abort prune transaction");

        let counts: (i64, i64, i64, i64) = sqlx::query_as(
            "SELECT
               (SELECT COUNT(1) FROM stock_maintenance_task_identities WHERE task_id='atomic-terminal'),
               (SELECT COUNT(1) FROM stock_maintenance_batches WHERE task_id='atomic-terminal'),
               (SELECT COUNT(1) FROM stock_movement_sync WHERE movement_id LIKE 'atomic-terminal:%'),
               (SELECT COUNT(1) FROM stock_maintenance_task_tombstones WHERE task_id='atomic-terminal')",
        )
        .fetch_one(store.pool())
        .await
        .expect("atomic history counts");
        assert_eq!(counts, (1, 1, 1, 0));
    }

    #[tokio::test]
    async fn maintenance_task_prune_clamps_retention_to_supported_bounds() {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");
        seed_two_slot_planogram(&store).await;
        let current = store.stock_maintenance_task().await.expect("current task");
        let base = store
            .stock_maintenance_task_identity_by_id(&current.task_id)
            .await
            .expect("load identity")
            .expect("identity");
        seed_old_maintenance_history(&store, &base, "minimum-clamp", "accepted", None, false).await;
        let half_day_ago =
            (Utc::now() - chrono::Duration::hours(12)).to_rfc3339_opts(SecondsFormat::Millis, true);
        for table in [
            "stock_maintenance_task_identities",
            "stock_maintenance_batches",
        ] {
            sqlx::query(&format!(
                "UPDATE {table} SET created_at=?1 WHERE task_id=?2"
            ))
            .bind(&half_day_ago)
            .bind("minimum-clamp")
            .execute(store.pool())
            .await
            .expect("age minimum-clamp history");
        }
        sqlx::query(
            "UPDATE stock_movement_sync SET accepted_at=?1,updated_at=?1
             WHERE movement_id LIKE 'minimum-clamp:%'",
        )
        .bind(&half_day_ago)
        .execute(store.pool())
        .await
        .expect("age minimum-clamp sync");
        store
            .prune_accepted_stock_movement_history(0)
            .await
            .expect("minimum clamp prune");
        let minimum_retained: (i64,) = sqlx::query_as(
            "SELECT COUNT(1) FROM stock_maintenance_task_identities WHERE task_id='minimum-clamp'",
        )
        .fetch_one(store.pool())
        .await
        .expect("minimum retained");
        assert_eq!(minimum_retained.0, 1);

        seed_old_maintenance_history(&store, &base, "maximum-clamp", "accepted", None, false).await;
        let four_hundred_days_ago =
            (Utc::now() - chrono::Duration::days(400)).to_rfc3339_opts(SecondsFormat::Millis, true);
        for table in [
            "stock_maintenance_task_identities",
            "stock_maintenance_batches",
        ] {
            sqlx::query(&format!(
                "UPDATE {table} SET created_at=?1 WHERE task_id=?2"
            ))
            .bind(&four_hundred_days_ago)
            .bind("maximum-clamp")
            .execute(store.pool())
            .await
            .expect("age maximum-clamp history");
        }
        sqlx::query(
            "UPDATE stock_movement_sync SET accepted_at=?1,updated_at=?1
             WHERE movement_id LIKE 'maximum-clamp:%'",
        )
        .bind(&four_hundred_days_ago)
        .execute(store.pool())
        .await
        .expect("age maximum-clamp sync");
        store
            .prune_accepted_stock_movement_history(i64::MAX)
            .await
            .expect("maximum clamp prune");
        let maximum_pruned: (i64,) = sqlx::query_as(
            "SELECT COUNT(1) FROM stock_maintenance_task_identities WHERE task_id='maximum-clamp'",
        )
        .fetch_one(store.pool())
        .await
        .expect("maximum pruned");
        assert_eq!(maximum_pruned.0, 0);
    }

    #[tokio::test]
    async fn v13_upgrade_backfills_current_maintenance_identity_and_enforces_batch_fk() {
        let temp = TempDir::new().expect("temp");
        let database = temp.path().join("state.db");
        let store = LocalStateStore::open(&database).await.expect("open");
        seed_two_slot_planogram(&store).await;
        let current = store.stock_maintenance_task().await.expect("current task");
        let base = store
            .stock_maintenance_task_identity_by_id(&current.task_id)
            .await
            .expect("load identity")
            .expect("identity");
        seed_old_maintenance_history(&store, &base, "legacy-v13-batch", "accepted", None, false)
            .await;
        store
            .put_metadata("schema_version", &13_i64)
            .await
            .expect("simulate v13 schema cursor");
        let mut connection = store
            .pool()
            .acquire()
            .await
            .expect("migration fixture connection");
        sqlx::query("PRAGMA foreign_keys=OFF")
            .execute(&mut *connection)
            .await
            .expect("simulate v13 without identity FK");
        sqlx::query(
            "DELETE FROM stock_maintenance_task_identities
             WHERE task_id IN (?1,'legacy-v13-batch')",
        )
        .bind(&current.task_id)
        .execute(&mut *connection)
        .await
        .expect("simulate v13 missing identity history");
        drop(connection);
        drop(store);

        let upgraded = LocalStateStore::open(&database).await.expect("upgrade");
        let restored: (i64, i64) = sqlx::query_as(
            "SELECT
               (SELECT COUNT(1) FROM stock_maintenance_task_identities WHERE task_id=?1),
               (SELECT COUNT(1) FROM stock_maintenance_task_identities WHERE task_id='legacy-v13-batch')",
        )
        .bind(&current.task_id)
        .fetch_one(upgraded.pool())
        .await
        .expect("restored migration identities");
        assert_eq!(restored, (1, 1));
        let fk: Vec<(i64, i64, String, String, String, String, String, String)> =
            sqlx::query_as("PRAGMA foreign_key_list(stock_maintenance_batches)")
                .fetch_all(upgraded.pool())
                .await
                .expect("batch foreign keys");
        assert!(fk.iter().any(|row| {
            row.2 == "stock_maintenance_task_identities"
                && row.3 == "task_id"
                && row.4 == "task_id"
                && row.6 == "RESTRICT"
        }));
        sqlx::query(
            "INSERT INTO stock_maintenance_batches(
               task_id,mode,planogram_version,planogram_revision,slot_set_json,payload_json,
               payload_fingerprint,operator_id,capacity_snapshot_json,created_at
             ) VALUES (
               'missing-parent','routine_refill','PLAN-PARTIAL-ACK','revision','[]','{}',
               'sha256:test','operator','[]',?1
             )",
        )
        .bind(now_iso())
        .execute(upgraded.pool())
        .await
        .expect_err("batch FK must reject a missing task identity");
    }

    #[tokio::test]
    async fn pending_and_rejected_stock_movements_are_not_pruned() {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");
        seed_stock_movement_upload(&store, "MOVE-OLD-PENDING").await;
        seed_stock_movement_upload(&store, "MOVE-OLD-REJECTED").await;
        let rejected_event = store
            .outbox_record("stock-movement:MOVE-OLD-REJECTED")
            .await
            .expect("outbox")
            .expect("event");
        let response = crate::backend::StockMovementUploadResponse {
            movement_id: "MOVE-OLD-REJECTED".to_string(),
            status: "rejected".to_string(),
            accepted_at: None,
            receipt: None,
            rejection: Some(json!({"reason":"invalid_quantity"})),
            reconciliation: None,
        };
        store
            .record_stock_movement_upload_response(&rejected_event, &response)
            .await
            .expect("rejected");
        sqlx::query(
            "UPDATE stock_movements SET occurred_at = '2026-05-01T00:00:00.000Z' WHERE movement_id IN (?1, ?2)",
        )
        .bind("MOVE-OLD-PENDING")
        .bind("MOVE-OLD-REJECTED")
        .execute(store.pool())
        .await
        .expect("age movements");
        sqlx::query(
            "UPDATE stock_movement_sync SET updated_at = '2026-05-01T00:00:00.000Z' WHERE movement_id IN (?1, ?2)",
        )
        .bind("MOVE-OLD-PENDING")
        .bind("MOVE-OLD-REJECTED")
        .execute(store.pool())
        .await
        .expect("age sync");

        let pruned = store
            .prune_accepted_stock_movement_history(1)
            .await
            .expect("prune");
        assert_eq!(pruned, 0);

        for movement_id in ["MOVE-OLD-PENDING", "MOVE-OLD-REJECTED"] {
            let movement_count: (i64,) =
                sqlx::query_as("SELECT COUNT(1) FROM stock_movements WHERE movement_id = ?1")
                    .bind(movement_id)
                    .fetch_one(store.pool())
                    .await
                    .expect("movement count");
            assert_eq!(movement_count.0, 1, "{movement_id} movement retained");
            assert!(store
                .stock_movement_sync_record(movement_id)
                .await
                .expect("sync")
                .is_some());
        }
    }

    #[tokio::test]
    async fn outbox_cleanup_does_not_delete_pending_stock_movement_uploads() {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");
        seed_stock_movement_upload(&store, "MOVE-EXPIRED-PENDING").await;
        sqlx::query(
            "UPDATE outbox_events SET expires_at = '2026-05-01T00:00:00.000Z' WHERE id = ?1",
        )
        .bind("stock-movement:MOVE-EXPIRED-PENDING")
        .execute(store.pool())
        .await
        .expect("expire outbox");

        let (deleted_expired, _) = store.prune_outbox().await.expect("prune outbox");
        assert_eq!(deleted_expired, 0);
        assert!(store
            .outbox_record("stock-movement:MOVE-EXPIRED-PENDING")
            .await
            .expect("outbox")
            .is_some());
    }

    #[tokio::test]
    async fn outbox_cleanup_does_not_delete_unacknowledged_secure_decommission_result() {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");
        let event = OutboxInput::secure_decommission_result(
            "MACHINE-1",
            "DCOM-DURABLE",
            json!({"commandNo":"DCOM-DURABLE","success":true}),
        );
        store.enqueue_outbox(&event).await.expect("seed result");
        sqlx::query(
            "UPDATE outbox_events SET expires_at = '2026-05-01T00:00:00.000Z' WHERE id = ?1",
        )
        .bind(&event.id)
        .execute(store.pool())
        .await
        .expect("expire outbox");

        let (deleted_expired, _) = store.prune_outbox().await.expect("prune outbox");

        assert_eq!(deleted_expired, 0);
        assert!(store
            .outbox_record(&event.id)
            .await
            .expect("outbox")
            .is_some());
    }

    #[tokio::test]
    async fn secure_decommission_ack_marker_and_result_removal_are_atomic_across_restart() {
        let temp = TempDir::new().expect("temp");
        let path = temp.path().join("state.db");
        let store = LocalStateStore::open(&path).await.expect("open");
        let message_id = "secure-decommission:DCOM-ATOMIC";
        let command_payload = json!({
            "commandNo": "DCOM-ATOMIC",
            "operation": "secure-decommission"
        });
        store
            .record_destructive_command_received(
                message_id,
                "secure-decommission",
                &command_payload,
                "2026-07-11T00:00:00.000Z",
            )
            .await
            .expect("record command");
        let event = OutboxInput::secure_decommission_result(
            "MACHINE-1",
            "DCOM-ATOMIC",
            json!({"commandNo":"DCOM-ATOMIC","success":true}),
        );
        let marker = SecureDecommissionFinalizeMarker {
            message_id: message_id.to_string(),
            command_no: "DCOM-ATOMIC".to_string(),
            generation: message_id.to_string(),
        };
        store
            .record_destructive_command_result_tx(message_id, true, None, &event)
            .await
            .expect("record successful result");

        let trigger = "fail_secure_decommission_ack_marker";
        sqlx::query(&format!(
            "CREATE TRIGGER {trigger} BEFORE INSERT ON runtime_metadata
             WHEN NEW.key = 'secure_decommission_platform_acknowledged_command_no'
             BEGIN SELECT RAISE(ABORT, 'injected durable marker failure'); END;"
        ))
        .execute(store.pool())
        .await
        .expect("install fault injection");
        assert!(store
            .acknowledge_secure_decommission_result_tx(message_id, &event.id, &marker)
            .await
            .is_err());
        assert!(store
            .outbox_record(&event.id)
            .await
            .expect("outbox")
            .is_some());
        assert_eq!(
            store
                .get_metadata::<SecureDecommissionFinalizeMarker>(
                    "secure_decommission_platform_acknowledged_command_no",
                )
                .await
                .expect("marker"),
            None
        );
        sqlx::query(&format!("DROP TRIGGER {trigger}"))
            .execute(store.pool())
            .await
            .expect("remove fault injection");
        assert!(store
            .acknowledge_secure_decommission_result_tx(message_id, &event.id, &marker)
            .await
            .expect("atomic acknowledgement"));
        drop(store);

        let reopened = LocalStateStore::open(&path).await.expect("restart state");
        assert!(reopened
            .outbox_record(&event.id)
            .await
            .expect("outbox")
            .is_none());
        assert_eq!(
            reopened
                .get_metadata::<SecureDecommissionFinalizeMarker>(
                    "secure_decommission_platform_acknowledged_command_no",
                )
                .await
                .expect("marker"),
            Some(marker)
        );
    }

    #[tokio::test]
    async fn secure_decommission_finalization_marker_deletion_is_atomic() {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");
        let marker = SecureDecommissionFinalizeMarker {
            message_id: "secure-decommission:DCOM-FINALIZE-ATOMIC".to_string(),
            command_no: "DCOM-FINALIZE-ATOMIC".to_string(),
            generation: "secure-decommission:DCOM-FINALIZE-ATOMIC".to_string(),
        };
        for key in [
            "secure_decommission_pending_finalize",
            "secure_decommission_platform_acknowledged_command_no",
        ] {
            store.put_metadata(key, &marker).await.expect("seed marker");
        }
        sqlx::query(
            "CREATE TRIGGER fail_secure_decommission_finalization_delete BEFORE DELETE ON runtime_metadata
             WHEN OLD.key = 'secure_decommission_platform_acknowledged_command_no'
             BEGIN SELECT RAISE(ABORT, 'injected finalization delete failure'); END;",
        )
        .execute(store.pool())
        .await
        .expect("install fault injection");
        assert!(store
            .clear_secure_decommission_finalization_markers_tx(&marker)
            .await
            .is_err());
        for key in [
            "secure_decommission_pending_finalize",
            "secure_decommission_platform_acknowledged_command_no",
        ] {
            assert_eq!(
                store
                    .get_metadata::<SecureDecommissionFinalizeMarker>(key)
                    .await
                    .expect("marker"),
                Some(marker.clone()),
            );
        }
        sqlx::query("DROP TRIGGER fail_secure_decommission_finalization_delete")
            .execute(store.pool())
            .await
            .expect("remove fault injection");
        store
            .clear_secure_decommission_finalization_markers_tx(&marker)
            .await
            .expect("atomic marker deletion");
    }

    #[tokio::test]
    async fn outbox_capacity_does_not_evict_stock_movement_uploads() {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");
        for index in 0..OUTBOX_MAX_EVENTS {
            let event = OutboxInput::stock_movement_upload(
                &format!("MOVE-CAPACITY-{index}"),
                "https://platform.example/api/machine-stock-movements".to_string(),
                json!({"movementId": format!("MOVE-CAPACITY-{index}")}),
            );
            store.enqueue_outbox(&event).await.expect("seed upload");
        }

        let heartbeat = OutboxInput::heartbeat("MACHINE-1", json!({"status":"ok"}));
        assert!(matches!(
            store.enqueue_outbox(&heartbeat).await,
            Err(StoreError::OutboxCapacity)
        ));
        assert_eq!(
            store.outbox_size().await.expect("size"),
            OUTBOX_MAX_EVENTS as u64
        );
        let upload_count: (i64,) = sqlx::query_as(
            "SELECT COUNT(1) FROM outbox_events WHERE kind = 'stock_movement_upload'",
        )
        .fetch_one(store.pool())
        .await
        .expect("upload count");
        assert_eq!(upload_count.0, OUTBOX_MAX_EVENTS);
    }

    #[tokio::test]
    async fn outbox_dedupes_by_id_and_backs_off() {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");
        let event = OutboxInput {
            id: "dedupe-1".to_string(),
            kind: OutboxKind::RemoteOpResult,
            transport: OutboxTransport::Http,
            topic: None,
            target_url: Some("/remote".to_string()),
            method: Some("POST".to_string()),
            payload_json: json!({"x":1}),
            priority: 300,
        };
        store.enqueue_outbox(&event).await.expect("first");
        store.enqueue_outbox(&event).await.expect("dup");
        assert_eq!(store.outbox_size().await.expect("size"), 1);

        let before = store
            .outbox_record("dedupe-1")
            .await
            .expect("record")
            .expect("exists");
        assert_eq!(before.attempt_count, 0);

        store
            .mark_outbox_failed("dedupe-1", "temporary failure")
            .await
            .expect("backoff");
        let after = store
            .outbox_record("dedupe-1")
            .await
            .expect("record")
            .expect("exists");
        assert_eq!(after.attempt_count, 1);
        assert!(after.last_error.is_some());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn outbox_enqueue_waits_for_immediate_writer_then_dedupes_and_enforces_capacity() {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");
        let duplicate = OutboxInput::stock_movement_upload(
            "MOVE-CONTENTION-DUPLICATE",
            "https://platform.example/api/machine-stock-movements".to_string(),
            json!({"movementId":"MOVE-CONTENTION-DUPLICATE"}),
        );
        store
            .enqueue_outbox(&duplicate)
            .await
            .expect("seed duplicate");
        for index in 1..OUTBOX_MAX_EVENTS {
            let event = OutboxInput::stock_movement_upload(
                &format!("MOVE-CONTENTION-{index}"),
                "https://platform.example/api/machine-stock-movements".to_string(),
                json!({"movementId": format!("MOVE-CONTENTION-{index}")}),
            );
            store.enqueue_outbox(&event).await.expect("fill outbox");
        }
        assert_eq!(
            store.outbox_size().await.expect("full outbox size"),
            OUTBOX_MAX_EVENTS as u64
        );

        let blocker = store
            .pool()
            .begin_with("BEGIN IMMEDIATE")
            .await
            .expect("hold immediate write lock");
        let barrier = Arc::new(Barrier::new(3));

        let duplicate_store = store.clone();
        let duplicate_input = duplicate.clone();
        let duplicate_barrier = Arc::clone(&barrier);
        let duplicate_contender = tokio::spawn(async move {
            duplicate_barrier.wait().await;
            duplicate_store.enqueue_outbox(&duplicate_input).await
        });

        let capacity_store = store.clone();
        let capacity_barrier = Arc::clone(&barrier);
        let capacity_contender = tokio::spawn(async move {
            capacity_barrier.wait().await;
            capacity_store
                .enqueue_outbox(&OutboxInput::heartbeat(
                    "MACHINE-1",
                    json!({"status":"contended"}),
                ))
                .await
        });

        barrier.wait().await;
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(
            !duplicate_contender.is_finished() && !capacity_contender.is_finished(),
            "concurrent enqueue contenders must wait for the immediate writer"
        );

        blocker
            .commit()
            .await
            .expect("release immediate write lock");
        duplicate_contender
            .await
            .expect("join duplicate contender")
            .expect("duplicate enqueue");
        assert!(matches!(
            capacity_contender.await.expect("join capacity contender"),
            Err(StoreError::OutboxCapacity)
        ));

        assert_eq!(
            store.outbox_size().await.expect("outbox size"),
            OUTBOX_MAX_EVENTS as u64
        );
        assert!(store
            .outbox_record(&duplicate.id)
            .await
            .expect("duplicate record")
            .is_some());
    }

    #[tokio::test]
    async fn outbox_rejects_low_priority_when_full() {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");

        for i in 0..OUTBOX_MAX_EVENTS {
            let payload = OutboxInput {
                id: format!("heartbeat-{i}"),
                kind: OutboxKind::Heartbeat,
                transport: OutboxTransport::Mqtt,
                topic: Some("vem/machine/heartbeat".to_string()),
                target_url: None,
                method: None,
                payload_json: json!({"i":i}),
                priority: 900,
            };
            store.enqueue_outbox(&payload).await.expect("seed");
        }
        assert_eq!(
            store.outbox_size().await.expect("size"),
            OUTBOX_MAX_EVENTS as u64
        );

        let too_many = OutboxInput {
            id: "discarded".to_string(),
            kind: OutboxKind::Heartbeat,
            transport: OutboxTransport::Mqtt,
            topic: Some("vem/machine/heartbeat".to_string()),
            target_url: None,
            method: None,
            payload_json: json!({"extra":true}),
            priority: 900,
        };
        assert!(matches!(
            store.enqueue_outbox(&too_many).await,
            Err(StoreError::OutboxCapacity)
        ));

        let critical = OutboxInput {
            id: "critical".to_string(),
            kind: OutboxKind::CommandAck,
            transport: OutboxTransport::Mqtt,
            topic: Some("vem/machine/ack".to_string()),
            target_url: None,
            method: None,
            payload_json: json!({"messageId":"ok"}),
            priority: 100,
        };
        assert!(store.enqueue_outbox(&critical).await.is_ok());
        assert_eq!(
            store.outbox_size().await.expect("size"),
            OUTBOX_MAX_EVENTS as u64
        );
    }

    #[tokio::test]
    async fn order_session_does_not_store_auth_code() {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");

        store
            .upsert_order_session(OrderSessionUpsert {
                order_no: "ORDER-SECRET",
                payment_method: "payment_code",
                payment_provider: Some("alipay"),
                items_json: json!([]),
                status: "waiting_payment",
                next_action: "wait_payment",
                payment_attempt_json: None,
                recovery_strategy: "local",
                last_backend_status_json: None,
                last_error: None,
            })
            .await
            .expect("seed");

        let key = store
            .begin_payment_code_attempt("ORDER-SECRET", "6212****3456", "serial_text", 1_000, None)
            .await
            .expect("id");
        assert!(key.starts_with("ORDER-SECRET:"));

        let row: Option<(Option<String>,)> =
            sqlx::query_as("SELECT payment_attempt_json FROM order_sessions WHERE order_no = ?1")
                .bind("ORDER-SECRET")
                .fetch_optional(store.pool())
                .await
                .expect("query");
        let json = row.expect("exists").0.expect("json");
        assert!(!json.contains("621234567890123456"));
        assert!(json.contains("6212****3456"));
    }

    #[tokio::test]
    async fn backend_status_without_payment_attempt_preserves_local_scan_attempt() {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");
        store
            .upsert_order_session(OrderSessionUpsert {
                order_no: "ORDER-PRESERVE-ATTEMPT",
                payment_method: "payment_code",
                payment_provider: Some("alipay"),
                items_json: json!([]),
                status: "waiting_payment",
                next_action: "wait_payment",
                payment_attempt_json: None,
                recovery_strategy: "local",
                last_backend_status_json: None,
                last_error: None,
            })
            .await
            .expect("seed");

        store
            .begin_payment_code_attempt(
                "ORDER-PRESERVE-ATTEMPT",
                "6212****3456",
                "serial_text",
                1_000,
                None,
            )
            .await
            .expect("begin attempt");
        store
            .apply_backend_order_status(
                "ORDER-PRESERVE-ATTEMPT",
                json!({
                    "orderId": "order-preserve-attempt-id",
                    "orderNo": "ORDER-PRESERVE-ATTEMPT",
                    "machineCode": "MACHINE-SCAN",
                    "orderStatus": "paid",
                    "totalAmountCents": 300,
                    "nextAction": "dispensing",
                    "payment": {
                        "paymentNo": "PAY-SCAN",
                        "method": "payment_code",
                        "providerCode": "alipay",
                        "paymentUrl": null,
                        "status": "succeeded",
                        "expiresAt": "2026-05-30T00:05:00.000Z"
                    }
                }),
            )
            .await
            .expect("apply status");

        let attempt = store
            .load_attempt_json("ORDER-PRESERVE-ATTEMPT")
            .await
            .expect("load")
            .expect("attempt");
        assert_eq!(attempt["source"], "serial_text");
        assert_eq!(attempt["maskedAuthCode"], "6212****3456");
    }

    #[tokio::test]
    async fn payment_code_retry_scan_creates_new_idempotency_key() {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");
        store
            .upsert_order_session(OrderSessionUpsert {
                order_no: "ORDER-RETRY",
                payment_method: "payment_code",
                payment_provider: Some("alipay"),
                items_json: json!([]),
                status: "waiting_payment",
                next_action: "wait_payment",
                payment_attempt_json: None,
                recovery_strategy: "local",
                last_backend_status_json: None,
                last_error: None,
            })
            .await
            .expect("seed");

        let first = store
            .begin_payment_code_attempt("ORDER-RETRY", "6212****3456", "serial_text", 1_000, None)
            .await
            .expect("first");
        store
            .finish_payment_code_attempt(
                "ORDER-RETRY",
                "failed",
                true,
                Some("付款码无效或支付失败，请刷新付款码后重试"),
            )
            .await
            .expect("finish");
        let second = store
            .begin_payment_code_attempt("ORDER-RETRY", "6212****9999", "serial_text", 2_000, None)
            .await
            .expect("second");

        assert_ne!(first, second);
        let data = store
            .load_attempt_json("ORDER-RETRY")
            .await
            .expect("json")
            .expect("attempt");
        assert_eq!(data["maskedAuthCode"], "6212****9999");
        assert_eq!(data["source"], "serial_text");
    }

    #[tokio::test]
    async fn payment_code_active_attempt_blocks_new_scan() {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");
        store
            .upsert_order_session(OrderSessionUpsert {
                order_no: "ORDER-ACTIVE",
                payment_method: "payment_code",
                payment_provider: Some("alipay"),
                items_json: json!([]),
                status: "waiting_payment",
                next_action: "wait_payment",
                payment_attempt_json: Some(json!({
                    "idempotencyKey": "ORDER-ACTIVE:one",
                    "status": "submitting",
                    "canRetry": false,
                })),
                recovery_strategy: "local",
                last_backend_status_json: None,
                last_error: None,
            })
            .await
            .expect("seed");

        let error = store
            .begin_payment_code_attempt("ORDER-ACTIVE", "6212****9999", "serial_text", 2_000, None)
            .await
            .expect_err("active attempt should block");
        assert!(matches!(error, StoreError::ActivePaymentCodeAttempt));
    }

    #[tokio::test]
    async fn current_transaction_snapshot_maps_backend_status_and_attempt_without_plaintext() {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");
        store
            .upsert_order_session(OrderSessionUpsert {
                order_no: "ORDER-SNAPSHOT",
                payment_method: "payment_code",
                payment_provider: Some("alipay"),
                items_json: json!([{ "name": "cola" }]),
                status: "waiting_payment",
                next_action: "wait_payment",
                payment_attempt_json: Some(json!({
                    "attemptNo": 1,
                    "status": "failed",
                    "maskedAuthCode": "6212****3456",
                    "source": "serial_text",
                    "idempotencyKey": "ORDER-SNAPSHOT:one",
                    "submittedAt": null,
                    "lastCheckedAt": null,
                    "canRetry": true,
                    "message": "请刷新付款码后重试",
                })),
                recovery_strategy: "local",
                last_backend_status_json: Some(json!({
                    "orderId": "order-id",
                    "orderNo": "ORDER-SNAPSHOT",
                    "orderStatus": "waiting_payment",
                    "totalAmountCents": 500,
                    "nextAction": "wait_payment",
                    "payment": {
                        "paymentNo": "PAY-1",
                        "method": "payment_code",
                        "providerCode": "alipay",
                        "paymentUrl": null,
                        "status": "pending",
                        "expiresAt": "2026-05-30T00:00:00.000Z"
                    }
                })),
                last_error: None,
            })
            .await
            .expect("seed");

        let snapshot = store
            .current_transaction_snapshot()
            .await
            .expect("snapshot")
            .expect("current");
        let value = serde_json::to_string(&snapshot).expect("serialize");
        assert!(value.contains("\"paymentMethod\":\"payment_code\""));
        assert!(value.contains("\"orderStatus\":\"pending_payment\""));
        assert!(!value.contains("\"orderStatus\":\"waiting_payment\""));
        assert!(value.contains("\"source\":\"serial_text\""));
        assert!(value.contains("\"maskedAuthCode\":\"6212****3456\""));
        assert!(!value.contains("621234567890123456"));
    }

    #[tokio::test]
    async fn current_transaction_snapshot_normalizes_legacy_submit_payment_on_recovery() {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");

        sqlx::query(
            "INSERT INTO order_sessions(
                order_no,payment_method,payment_provider,payment_attempt_json,items_json,status,
                next_action,expires_at,last_backend_status_json,last_error,recovery_strategy,updated_at
             ) VALUES (?1,'payment_code','alipay',NULL,'[]','waiting_payment',?2,NULL,NULL,NULL,'local',?3)",
        )
        .bind("ORDER-LEGACY-SUBMIT")
        .bind("submit_payment")
        .bind(now_iso())
        .execute(store.pool())
        .await
        .expect("seed legacy row");

        let snapshot = store
            .current_transaction_snapshot()
            .await
            .expect("snapshot")
            .expect("current transaction");

        assert_eq!(
            snapshot.next_action,
            Some(InternalCheckoutFlowAction::WaitPayment)
        );
        let value = serde_json::to_string(&snapshot).expect("serialize snapshot");
        assert!(!value.contains("submit_payment"));
    }

    #[tokio::test]
    async fn current_transaction_snapshot_normalizes_legacy_collect_goods_on_recovery() {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");

        sqlx::query(
            "INSERT INTO order_sessions(
                order_no,payment_method,payment_provider,payment_attempt_json,items_json,status,
                next_action,expires_at,last_backend_status_json,last_error,recovery_strategy,updated_at
             ) VALUES (?1,'payment_code','alipay',NULL,'[]','dispensing',?2,NULL,NULL,NULL,'local',?3)",
        )
        .bind("ORDER-LEGACY-COLLECT")
        .bind("collect_goods")
        .bind(now_iso())
        .execute(store.pool())
        .await
        .expect("seed legacy row");

        let snapshot = store
            .current_transaction_snapshot()
            .await
            .expect("snapshot")
            .expect("current transaction");

        assert_eq!(
            snapshot.next_action,
            Some(InternalCheckoutFlowAction::Dispensing)
        );
        let value = serde_json::to_string(&snapshot).expect("serialize snapshot");
        assert!(!value.contains("collect_goods"));
    }

    #[tokio::test]
    async fn upsert_order_session_rejects_legacy_checkout_flow_action_on_new_write() {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");

        let result = store
            .upsert_order_session(OrderSessionUpsert {
                order_no: "ORDER-NEW-WRITE",
                payment_method: "payment_code",
                payment_provider: Some("alipay"),
                items_json: json!([]),
                status: "waiting_payment",
                next_action: "submit_payment",
                payment_attempt_json: None,
                recovery_strategy: "local",
                last_backend_status_json: None,
                last_error: None,
            })
            .await;

        assert!(result.is_err());

        let row: Option<(String,)> =
            sqlx::query_as("SELECT next_action FROM order_sessions WHERE order_no = ?1")
                .bind("ORDER-NEW-WRITE")
                .fetch_optional(store.pool())
                .await
                .expect("query row");
        assert!(row.is_none());
    }

    #[tokio::test]
    async fn current_transaction_snapshot_normalizes_cached_backend_legacy_next_action() {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");

        for (order_no, row_next_action, cached_next_action, expected) in [
            (
                "ORDER-CACHED-SUBMIT",
                "wait_payment",
                "submit_payment",
                InternalCheckoutFlowAction::WaitPayment,
            ),
            (
                "ORDER-CACHED-COLLECT",
                "dispensing",
                "collect_goods",
                InternalCheckoutFlowAction::Dispensing,
            ),
        ] {
            sqlx::query(
                "INSERT INTO order_sessions(
                    order_no,payment_method,payment_provider,payment_attempt_json,items_json,status,
                    next_action,expires_at,last_backend_status_json,last_error,recovery_strategy,updated_at
                 ) VALUES (?1,'payment_code','alipay',NULL,'[]','waiting_payment',?2,NULL,?3,NULL,'local',?4)",
            )
            .bind(order_no)
            .bind(row_next_action)
            .bind(
                json!({
                    "orderNo": order_no,
                    "orderStatus": "waiting_payment",
                    "nextAction": cached_next_action
                })
                .to_string(),
            )
            .bind(now_iso())
            .execute(store.pool())
            .await
            .expect("seed cached backend legacy row");

            let snapshot = store
                .current_transaction_snapshot()
                .await
                .expect("snapshot")
                .expect("current transaction");
            assert_eq!(snapshot.next_action, Some(expected));
            let value = serde_json::to_string(&snapshot).expect("serialize snapshot");
            assert!(!value.contains("submit_payment"));
            assert!(!value.contains("collect_goods"));

            sqlx::query("UPDATE order_sessions SET status = 'closed' WHERE order_no = ?1")
                .bind(order_no)
                .execute(store.pool())
                .await
                .expect("close row");
        }
    }

    #[tokio::test]
    async fn apply_backend_order_status_rejects_legacy_checkout_flow_action_on_new_write() {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");

        store
            .upsert_order_session(OrderSessionUpsert {
                order_no: "ORDER-BACKEND-WRITE",
                payment_method: "payment_code",
                payment_provider: Some("alipay"),
                items_json: json!([]),
                status: "dispensing",
                next_action: "dispensing",
                payment_attempt_json: None,
                recovery_strategy: "local",
                last_backend_status_json: None,
                last_error: None,
            })
            .await
            .expect("seed");

        let result = store
            .apply_backend_order_status(
                "ORDER-BACKEND-WRITE",
                json!({
                    "orderNo": "ORDER-BACKEND-WRITE",
                    "orderStatus": "dispensing",
                    "nextAction": "collect_goods"
                }),
            )
            .await;

        assert!(matches!(
            result,
            Err(StoreError::InvalidCheckoutFlowAction(action)) if action == "collect_goods"
        ));

        let row: (String, Option<String>) = sqlx::query_as(
            "SELECT next_action, last_backend_status_json FROM order_sessions WHERE order_no = ?1",
        )
        .bind("ORDER-BACKEND-WRITE")
        .fetch_one(store.pool())
        .await
        .expect("query row");
        assert_eq!(row.0, "dispensing");
        assert!(row.1.is_none());
    }

    #[tokio::test]
    async fn dispense_progress_updates_current_transaction_pickup_reminder() {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");
        store
            .upsert_order_session(OrderSessionUpsert {
                order_no: "ORDER-PICKUP-REMINDER",
                payment_method: "payment_code",
                payment_provider: Some("alipay"),
                items_json: json!([{ "name": "cola" }]),
                status: "dispensing",
                next_action: "dispensing",
                payment_attempt_json: None,
                recovery_strategy: "local",
                last_backend_status_json: Some(json!({
                    "orderNo": "ORDER-PICKUP-REMINDER",
                    "orderStatus": "dispensing",
                    "nextAction": "dispensing",
                    "vending": {
                        "commandNo": "CMD-PICKUP-REMINDER",
                        "status": "dispensing",
                        "lastError": null
                    }
                })),
                last_error: None,
            })
            .await
            .expect("seed");

        store
            .record_dispense_progress(&DispenseProgressEvent {
                command_no: "CMD-PICKUP-REMINDER".to_string(),
                order_no: "ORDER-PICKUP-REMINDER".to_string(),
                stage: DispenseProgressStage::PickupTimeoutWarning,
                warning_no: Some(2),
                message: "请立即取走商品，设备即将自动关闭取货口".to_string(),
                reported_at: "2026-06-13T09:00:00.000Z".to_string(),
            })
            .await
            .expect("record progress");

        let snapshot = store
            .current_transaction_snapshot()
            .await
            .expect("snapshot")
            .expect("current");
        let reminder = snapshot
            .vending
            .expect("vending")
            .pickup_reminder
            .expect("pickup reminder");
        assert_eq!(reminder.level, "urgent");
        assert_eq!(reminder.stage.as_deref(), Some("pickup_timeout_warning"));
        assert_eq!(reminder.warning_no, Some(2));
        assert!(reminder.message.contains("立即取走"));
        assert_eq!(
            snapshot.next_action,
            Some(InternalCheckoutFlowAction::Dispensing)
        );
    }

    #[tokio::test]
    async fn reset_completed_progress_does_not_become_pickup_reminder() {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");
        store
            .upsert_order_session(OrderSessionUpsert {
                order_no: "ORDER-RESET-COMPLETED",
                payment_method: "payment_code",
                payment_provider: Some("alipay"),
                items_json: json!([{ "name": "cola" }]),
                status: "dispensing",
                next_action: "dispensing",
                payment_attempt_json: None,
                recovery_strategy: "local",
                last_backend_status_json: Some(json!({
                    "orderNo": "ORDER-RESET-COMPLETED",
                    "orderStatus": "dispensing",
                    "nextAction": "dispensing",
                    "vending": {
                        "commandNo": "CMD-RESET-COMPLETED",
                        "status": "dispensing",
                        "lastError": null
                    }
                })),
                last_error: None,
            })
            .await
            .expect("seed");

        store
            .record_dispense_progress(&DispenseProgressEvent {
                command_no: "CMD-RESET-COMPLETED".to_string(),
                order_no: "ORDER-RESET-COMPLETED".to_string(),
                stage: DispenseProgressStage::ResetCompleted,
                warning_no: None,
                message: "设备已复位完成".to_string(),
                reported_at: "2026-06-13T09:00:00.000Z".to_string(),
            })
            .await
            .expect("record reset completed");

        let snapshot = store
            .current_transaction_snapshot()
            .await
            .expect("snapshot")
            .expect("current");
        let vending = snapshot.vending.expect("vending");
        assert_eq!(vending.command_no.as_deref(), Some("CMD-RESET-COMPLETED"));
        assert_eq!(vending.status.as_deref(), Some("dispensing"));
        assert!(vending.pickup_reminder.is_none());
        assert_eq!(
            snapshot.next_action,
            Some(InternalCheckoutFlowAction::Dispensing)
        );
    }

    #[tokio::test]
    async fn late_reset_completed_progress_does_not_revert_successful_dispense_result() {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");
        store
            .upsert_order_session(OrderSessionUpsert {
                order_no: "ORDER-LATE-RESET",
                payment_method: "payment_code",
                payment_provider: Some("alipay"),
                items_json: json!([{ "name": "cola" }]),
                status: "dispensing",
                next_action: "dispensing",
                payment_attempt_json: None,
                recovery_strategy: "local",
                last_backend_status_json: Some(json!({
                    "orderNo": "ORDER-LATE-RESET",
                    "orderStatus": "dispensing",
                    "nextAction": "dispensing",
                    "vending": {
                        "commandNo": "CMD-LATE-RESET",
                        "status": "dispensing",
                        "lastError": null,
                        "pickupReminder": {
                            "stage": "pickup_waiting",
                            "level": "info",
                            "message": "请取走商品",
                            "warningNo": null,
                            "reportedAt": "2026-06-13T09:00:00.000Z"
                        }
                    }
                })),
                last_error: None,
            })
            .await
            .expect("seed");

        let command = DispenseCommandPayload {
            command_no: "CMD-LATE-RESET".to_string(),
            order_no: "ORDER-LATE-RESET".to_string(),
            slot: vending_core::hardware::SlotPayload {
                layer_no: 1,
                cell_no: 1,
                slot_code: "A1".to_string(),
            },
            quantity: 1,
            timeout_seconds: 10,
        };
        let result = DispenseResultPayload {
            command_no: command.command_no.clone(),
            success: true,
            error_code: None,
            message: "serial: dispense completed".to_string(),
            reported_at: "2026-06-13T09:00:01.000Z".to_string(),
        };
        store
            .apply_dispense_result_to_order_session(&command, &result)
            .await
            .expect("apply success result");

        store
            .record_dispense_progress(&DispenseProgressEvent {
                command_no: "CMD-LATE-RESET".to_string(),
                order_no: "ORDER-LATE-RESET".to_string(),
                stage: DispenseProgressStage::ResetCompleted,
                warning_no: None,
                message: "设备已复位完成".to_string(),
                reported_at: "2026-06-13T09:00:02.000Z".to_string(),
            })
            .await
            .expect("record late reset completed");

        store
            .record_dispense_progress(&DispenseProgressEvent {
                command_no: "CMD-LATE-RESET".to_string(),
                order_no: "ORDER-LATE-RESET".to_string(),
                stage: DispenseProgressStage::PickupTimeoutWarning,
                warning_no: Some(2),
                message: "delayed E5".to_string(),
                reported_at: "2026-06-13T09:00:03.000Z".to_string(),
            })
            .await
            .expect("ignore delayed nonterminal progress");

        let snapshot = store
            .current_transaction_snapshot()
            .await
            .expect("snapshot")
            .expect("current");
        let vending = snapshot.vending.expect("vending");
        assert_eq!(
            snapshot.next_action,
            Some(InternalCheckoutFlowAction::Success)
        );
        assert_eq!(snapshot.order_status.as_deref(), Some("fulfilled"));
        assert_eq!(vending.command_no.as_deref(), Some("CMD-LATE-RESET"));
        assert_eq!(vending.status.as_deref(), Some("succeeded"));
        assert!(vending.pickup_reminder.is_none());
    }

    #[tokio::test]
    async fn f1_is_nonterminal_and_delayed_e5_cannot_regress_closure_progress() {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");
        store.upsert_order_session(OrderSessionUpsert {
            order_no: "ORDER-F1", payment_method: "payment_code", payment_provider: Some("alipay"),
            items_json: json!([]), status: "dispensing", next_action: "dispensing",
            payment_attempt_json: None, recovery_strategy: "local",
            last_backend_status_json: Some(json!({"orderNo":"ORDER-F1","orderStatus":"dispensing","nextAction":"dispensing","vending":{"commandNo":"CMD-F1","status":"dispensing"}})),
            last_error: None,
        }).await.unwrap();
        store
            .record_dispense_progress(&DispenseProgressEvent {
                command_no: "CMD-F1".to_string(),
                order_no: "ORDER-F1".to_string(),
                stage: DispenseProgressStage::PickupCompleted,
                warning_no: None,
                message: "pickup closed, resetting".to_string(),
                reported_at: now_iso(),
            })
            .await
            .unwrap();
        store
            .record_dispense_progress(&DispenseProgressEvent {
                command_no: "CMD-F1".to_string(),
                order_no: "ORDER-F1".to_string(),
                stage: DispenseProgressStage::PickupTimeoutWarning,
                warning_no: Some(2),
                message: "delayed timeout".to_string(),
                reported_at: now_iso(),
            })
            .await
            .unwrap();
        let snapshot = store.current_transaction_snapshot().await.unwrap().unwrap();
        assert_eq!(
            snapshot.next_action,
            Some(InternalCheckoutFlowAction::Dispensing)
        );
        assert_eq!(
            snapshot
                .vending
                .unwrap()
                .pickup_reminder
                .unwrap()
                .stage
                .as_deref(),
            Some("pickup_completed")
        );
    }

    #[tokio::test]
    async fn backend_status_refresh_preserves_local_pickup_reminder_while_dispensing() {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");
        store
            .upsert_order_session(OrderSessionUpsert {
                order_no: "ORDER-PICKUP-REFRESH",
                payment_method: "payment_code",
                payment_provider: Some("alipay"),
                items_json: json!([{ "name": "cola" }]),
                status: "dispensing",
                next_action: "dispensing",
                payment_attempt_json: None,
                recovery_strategy: "local",
                last_backend_status_json: Some(json!({
                    "orderNo": "ORDER-PICKUP-REFRESH",
                    "orderStatus": "dispensing",
                    "nextAction": "dispensing",
                    "vending": {
                        "commandNo": "CMD-PICKUP-REFRESH",
                        "status": "dispensing",
                        "lastError": null,
                        "pickupReminder": {
                            "stage": "pickup_timeout_warning",
                            "level": "warning",
                            "message": "请尽快取走商品",
                            "warningNo": 1,
                            "reportedAt": "2026-06-13T09:00:00.000Z"
                        }
                    }
                })),
                last_error: None,
            })
            .await
            .expect("seed");

        store
            .apply_backend_order_status(
                "ORDER-PICKUP-REFRESH",
                json!({
                    "orderNo": "ORDER-PICKUP-REFRESH",
                    "orderStatus": "dispensing",
                    "nextAction": "dispensing",
                    "payment": {
                        "method": "payment_code",
                        "providerCode": "alipay",
                        "status": "succeeded"
                    },
                    "vending": {
                        "commandNo": "CMD-PICKUP-REFRESH",
                        "status": "sent",
                        "lastError": null
                    }
                }),
            )
            .await
            .expect("refresh");

        let snapshot = store
            .current_transaction_snapshot()
            .await
            .expect("snapshot")
            .expect("current");
        let reminder = snapshot
            .vending
            .expect("vending")
            .pickup_reminder
            .expect("pickup reminder");
        assert_eq!(reminder.message, "请尽快取走商品");
        assert_eq!(reminder.stage.as_deref(), Some("pickup_timeout_warning"));
        assert_eq!(reminder.warning_no, Some(1));
    }

    #[tokio::test]
    async fn successful_dispense_result_clears_vending_last_error() {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");
        let command = DispenseCommandPayload {
            command_no: "CMD-SUCCESS-LAST-ERROR".to_string(),
            order_no: "ORDER-SUCCESS-LAST-ERROR".to_string(),
            slot: vending_core::hardware::SlotPayload {
                layer_no: 1,
                cell_no: 1,
                slot_code: "A1".to_string(),
            },
            quantity: 1,
            timeout_seconds: 10,
        };
        store
            .upsert_order_session(OrderSessionUpsert {
                order_no: &command.order_no,
                payment_method: "payment_code",
                payment_provider: Some("alipay"),
                items_json: json!([{ "name": "cola" }]),
                status: "dispensing",
                next_action: "dispensing",
                payment_attempt_json: None,
                recovery_strategy: "local",
                last_backend_status_json: Some(json!({
                    "orderNo": command.order_no,
                    "orderStatus": "paid",
                    "fulfillmentState": "awaiting_fulfillment",
                    "totalAmountCents": 1,
                    "nextAction": "dispensing",
                    "payment": {
                        "paymentNo": "PAY-SUCCESS-LAST-ERROR",
                        "method": "payment_code",
                        "providerCode": "alipay",
                        "status": "succeeded",
                        "paymentUrl": null,
                        "expiresAt": null
                    },
                    "vending": {
                        "commandNo": command.command_no,
                        "status": "running",
                        "lastError": "previous warning"
                    }
                })),
                last_error: None,
            })
            .await
            .expect("seed order session");

        store
            .apply_dispense_result_to_order_session(
                &command,
                &DispenseResultPayload {
                    command_no: command.command_no.clone(),
                    success: true,
                    error_code: None,
                    message: "serial: dispense completed".to_string(),
                    reported_at: now_iso(),
                },
            )
            .await
            .expect("apply result");

        let snapshot = store
            .current_transaction_snapshot()
            .await
            .expect("snapshot")
            .expect("current");

        assert_eq!(
            snapshot
                .vending
                .as_ref()
                .and_then(|vending| vending.status.as_deref()),
            Some("succeeded")
        );
        assert_eq!(
            snapshot
                .vending
                .as_ref()
                .and_then(|vending| vending.last_error.as_deref()),
            None
        );
    }

    #[tokio::test]
    async fn command_ack_tx_rolls_back_outbox_on_state_failure() {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");

        let command = DispenseCommandPayload {
            command_no: "CMD-ROLLBACK-ACK".to_string(),
            order_no: "ORD-ROLLBACK".to_string(),
            slot: vending_core::hardware::SlotPayload {
                layer_no: 1,
                cell_no: 1,
                slot_code: "A1".to_string(),
            },
            quantity: 1,
            timeout_seconds: 10,
        };
        store
            .upsert_command_received(&command)
            .await
            .expect("seed command");

        let trigger_name = format!("fail_ack_update_{}", Uuid::new_v4().simple());
        sqlx::query(&format!(
            "CREATE TRIGGER {trigger_name} BEFORE UPDATE ON command_log
             WHEN NEW.command_no = '{}'
             BEGIN SELECT RAISE(ABORT, 'forced update failure'); END;",
            command.command_no.replace('\'', "''")
        ))
        .execute(store.pool())
        .await
        .expect("install trigger");

        let ack = OutboxInput::command_ack("MACHINE-1", &command.command_no);
        assert!(store.record_command_ack_tx(&command, &ack).await.is_err());

        let maybe = store.outbox_record(&ack.id).await.expect("query outbox");
        assert!(maybe.is_none(), "outbox entry should be rolled back");

        let record = store
            .get_command(&command.command_no)
            .await
            .expect("fetch command")
            .expect("command record");
        assert_eq!(record.status, CommandLogStatus::Received);
        assert!(record.ack_at.is_none());
    }

    #[tokio::test]
    async fn command_result_tx_never_leaves_result_without_outbox() {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");

        let command = DispenseCommandPayload {
            command_no: "CMD-ROLLBACK-RESULT".to_string(),
            order_no: "ORD-ROLLBACK-2".to_string(),
            slot: vending_core::hardware::SlotPayload {
                layer_no: 1,
                cell_no: 1,
                slot_code: "A1".to_string(),
            },
            quantity: 1,
            timeout_seconds: 10,
        };
        store
            .upsert_command_received(&command)
            .await
            .expect("seed command");

        let result = DispenseResultPayload {
            command_no: command.command_no.clone(),
            success: true,
            error_code: None,
            message: "ok".to_string(),
            reported_at: now_iso(),
        };
        let event = OutboxInput::dispense_result("MACHINE-1", &result);

        let trigger_name = format!("fail_outbox_insert_{}", Uuid::new_v4().simple());
        sqlx::query(&format!(
            "CREATE TRIGGER {trigger_name} BEFORE INSERT ON outbox_events
             WHEN NEW.id = '{}'
             BEGIN SELECT RAISE(ABORT, 'forced outbox failure'); END;",
            event.id.replace('\'', "''")
        ))
        .execute(store.pool())
        .await
        .expect("install trigger");

        assert!(store
            .record_command_result_and_enqueue_tx(&command, &result, &event)
            .await
            .is_err());

        let record = store
            .get_command(&command.command_no)
            .await
            .expect("fetch command")
            .expect("command record");
        assert_eq!(record.status, CommandLogStatus::Received);
        assert!(record.result_payload.is_none());

        let maybe = store.outbox_record(&event.id).await.expect("query outbox");
        assert!(maybe.is_none(), "outbox entry should be rolled back");
    }
}
