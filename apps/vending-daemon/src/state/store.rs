use std::path::Path;

use chrono::{SecondsFormat, Utc};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sqlx::{sqlite::SqlitePoolOptions, Row, SqlitePool, Transaction};
use thiserror::Error;
use uuid::Uuid;

use vending_core::domain::{CommandLogStatus, OutboxKind, OutboxTransport};

use super::schema::{
    MIGRATION_V1, MIGRATION_V2, MIGRATION_V3, MIGRATION_V4, MIGRATION_V5, MIGRATION_V6,
    MIGRATION_V7, SCHEMA_VERSION,
};
use vending_core::hardware::{
    DispenseCommandPayload, DispenseResultPayload, EnvironmentControlResultPayload,
};

const COMMAND_LOG_TTL_DAYS: i64 = 30;
const COMMAND_LOG_MAX_ENTRIES: i64 = 2000;
const OUTBOX_TTL_DAYS: i64 = 7;
pub const OUTBOX_MAX_EVENTS: i64 = 500;
const STOCK_LEDGER_REBUILT_AFTER_QUARANTINE_KEY: &str = "stock_ledger_rebuilt_after_quarantine";
const STOCK_MOVEMENT_RETENTION_DAYS: i64 = 30;

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
        self.put_metadata("schema_version", &SCHEMA_VERSION).await?;
        Ok(())
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

    pub async fn record_command_result_and_enqueue_tx(
        &self,
        command: &DispenseCommandPayload,
        result: &DispenseResultPayload,
        result_event: &OutboxInput,
    ) -> Result<(), StoreError> {
        let existing = self.get_command(&command.command_no).await?;
        if let Some(existing) = existing.as_ref() {
            if matches!(
                existing.status,
                CommandLogStatus::Succeeded | CommandLogStatus::Failed
            ) && existing.result_payload.is_some()
            {
                return Ok(());
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
        let mut tx = self.pool.begin().await?;

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
        sqlx::query(
            "INSERT INTO order_sessions(order_no,payment_method,payment_provider,payment_attempt_json,items_json,status,next_action,expires_at,last_backend_status_json,last_error,recovery_strategy,updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
             ON CONFLICT(order_no) DO UPDATE SET
               payment_method = excluded.payment_method,
               payment_provider = excluded.payment_provider,
               payment_attempt_json = excluded.payment_attempt_json,
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
        .bind(input.next_action)
        .bind(now_iso_days(COMMAND_LOG_TTL_DAYS))
        .bind(
            input
                .last_backend_status_json
                .as_ref()
                .map(|value| value.to_string()),
        )
        .bind(input.last_error)
        .bind(input.recovery_strategy)
        .bind(now_iso())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn current_order_session_snapshot(
        &self,
    ) -> Result<Option<vending_core::domain::TransactionSnapshot>, StoreError> {
        let row: Option<CurrentOrderSessionRow> = sqlx::query_as(
            "SELECT order_no, status, next_action, updated_at
                 FROM order_sessions
                 WHERE status != 'closed'
                 ORDER BY updated_at DESC
                 LIMIT 1",
        )
        .fetch_optional(&self.pool)
        .await?;

        Ok(row.map(|(order_no, status, next_action, updated_at)| {
            let status = status.and_then(|value| parse_order_status(&value)).or(Some(
                vending_core::domain::OrderSessionStatus::WaitingPayment,
            ));
            vending_core::domain::TransactionSnapshot {
                order_no,
                status,
                next_action: next_action.filter(|value| !value.is_empty()),
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
             ORDER BY updated_at DESC
             LIMIT 1",
        )
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(to_order_session_record))
    }

    pub async fn current_transaction_snapshot(
        &self,
    ) -> Result<Option<vending_core::domain::CurrentTransactionSnapshot>, StoreError> {
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
        sqlx::query(
            "UPDATE order_sessions
             SET payment_attempt_json = ?2, updated_at = ?3
             WHERE order_no = ?1",
        )
        .bind(order_no)
        .bind(serde_json::Value::Object(payload.clone()).to_string())
        .bind(now_iso())
        .execute(&self.pool)
        .await?;
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
             ) VALUES (?1,'unknown',NULL,?2,'[]','waiting_payment','submit_payment',?3,'local','')",
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
                   category_id,category_name,sku,size,color,price_cents,product_sort_order,target_gender
                 ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21)",
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
                upsert_stock_projection_in_tx(
                    &mut tx,
                    &input.planogram_version,
                    &slot.slot_id,
                    0,
                    slot.capacity,
                )
                .await?;
            }
            upsert_sale_view_projection_in_tx(&mut tx, &input.planogram_version, &slot.slot_id)
                .await?;
        }
        tx.commit().await?;
        self.sale_view(None).await
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

        clear_stock_ledger_loss_blocker_in_tx(&mut tx, &input.planogram_version, &input.slot_id)
            .await?;
        upsert_stock_projection_in_tx(
            &mut tx,
            &input.planogram_version,
            &input.slot_id,
            after_quantity,
            capacity,
        )
        .await?;
        upsert_sale_view_projection_in_tx(&mut tx, &input.planogram_version, &input.slot_id)
            .await?;
        tx.commit().await?;
        self.sale_view(None).await
    }

    pub async fn block_slot_for_dispense_failure(
        &self,
        command: &DispenseCommandPayload,
        error_code: Option<&str>,
    ) -> Result<Option<SaleViewSnapshot>, StoreError> {
        let slot_sales_state = match error_code {
            Some("NO_DROP") => "suspect",
            _ => "frozen",
        };
        self.block_command_slot(command, slot_sales_state, "dispense_failure")
            .await
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
             ORDER BY json_extract(item_json, '$.productSortOrder') ASC,
                      json_extract(item_json, '$.slotCode') ASC",
        )
        .bind(&planogram_version)
        .fetch_all(&self.pool)
        .await?;

        let mut items = Vec::with_capacity(rows.len());
        let mut last_updated_at = None;
        for (json, updated_at) in rows {
            let mut item: SaleViewItem = serde_json::from_str(&json)?;
            item.machine_code = machine_code.clone();
            last_updated_at = Some(updated_at);
            items.push(item);
        }

        Ok(SaleViewSnapshot {
            items,
            source: "local_stock".to_string(),
            planogram_version: Some(planogram_version),
            last_updated_at,
        })
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
        let mut tx = self.pool.begin().await?;
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
            "DELETE FROM outbox_events WHERE expires_at < ?1 AND kind != 'stock_movement_upload'",
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
           category_id,category_name,sku,size,color,price_cents,product_sort_order,target_gender
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
             WHEN current_stock_projection.slot_sales_state IN ('frozen','suspect') THEN current_stock_projection.slot_sales_state
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
         SET slot_sales_state = ?3, updated_at = ?4
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
) -> Result<vending_core::domain::CurrentTransactionSnapshot, StoreError> {
    let backend = row
        .last_backend_status_json
        .as_deref()
        .and_then(|value| serde_json::from_str::<serde_json::Value>(value).ok());
    let attempt = row
        .payment_attempt_json
        .as_deref()
        .and_then(|value| serde_json::from_str::<serde_json::Value>(value).ok());

    Ok(vending_core::domain::CurrentTransactionSnapshot {
        order_id: backend
            .as_ref()
            .and_then(|v| v.get("orderId"))
            .and_then(|v| v.as_str())
            .map(ToString::to_string),
        order_no: Some(row.order_no),
        product_summary: serde_json::from_str::<serde_json::Value>(&row.items_json).ok(),
        payment_no: backend
            .as_ref()
            .and_then(|v| v.pointer("/payment/paymentNo"))
            .and_then(|v| v.as_str())
            .map(ToString::to_string),
        payment_method: backend
            .as_ref()
            .and_then(|v| v.pointer("/payment/method"))
            .and_then(|v| v.as_str())
            .map(ToString::to_string)
            .or(Some(row.payment_method)),
        payment_provider: backend
            .as_ref()
            .and_then(|v| v.pointer("/payment/providerCode"))
            .and_then(|v| v.as_str())
            .map(ToString::to_string)
            .or(row.payment_provider),
        payment_url: backend
            .as_ref()
            .and_then(|v| v.pointer("/payment/paymentUrl"))
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
            .map(ToString::to_string)
            .or(Some(row.status)),
        total_amount_cents: backend
            .as_ref()
            .and_then(|v| v.get("totalAmountCents"))
            .and_then(|v| v.as_i64()),
        vending: backend.as_ref().and_then(map_vending_summary),
        next_action: backend
            .as_ref()
            .and_then(|v| v.get("nextAction"))
            .and_then(|v| v.as_str())
            .map(ToString::to_string)
            .or(Some(row.next_action)),
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
) -> Option<vending_core::domain::VendingCommandSummary> {
    let vending = value.get("vending")?;
    Some(vending_core::domain::VendingCommandSummary {
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
    })
}

fn map_payment_code_attempt_summary(
    value: &serde_json::Value,
) -> Result<vending_core::domain::PaymentCodeAttemptSummary, StoreError> {
    Ok(vending_core::domain::PaymentCodeAttemptSummary {
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

fn parse_order_status(status: &str) -> Option<vending_core::domain::OrderSessionStatus> {
    match status {
        "waiting_payment" => Some(vending_core::domain::OrderSessionStatus::WaitingPayment),
        "payment_submitted" => Some(vending_core::domain::OrderSessionStatus::PaymentSubmitted),
        "dispensing" => Some(vending_core::domain::OrderSessionStatus::Dispensing),
        "succeeded" => Some(vending_core::domain::OrderSessionStatus::Succeeded),
        "failed" => Some(vending_core::domain::OrderSessionStatus::Failed),
        "manual_handling" => Some(vending_core::domain::OrderSessionStatus::ManualHandling),
        "closed" => Some(vending_core::domain::OrderSessionStatus::Closed),
        _ => None,
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

fn now_iso_days(days: i64) -> String {
    (Utc::now() + chrono::Duration::days(days)).to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use tempfile::TempDir;

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

        let schema_version: Option<i64> = store
            .get_metadata("schema_version")
            .await
            .expect("schema version")
            .unwrap();
        assert_eq!(schema_version, Some(SCHEMA_VERSION));
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
            )
            .await
            .expect("block")
            .expect("slot found");

        assert_eq!(snapshot.items[0].slot_sales_state, "suspect");
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
            )
            .await
            .expect("block")
            .expect("slot found");

        assert_eq!(snapshot.items[0].slot_sales_state, "frozen");
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
        assert!(value.contains("\"source\":\"serial_text\""));
        assert!(value.contains("\"maskedAuthCode\":\"6212****3456\""));
        assert!(!value.contains("621234567890123456"));
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
