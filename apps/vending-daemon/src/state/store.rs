use std::path::Path;

use chrono::{SecondsFormat, Utc};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sqlx::{sqlite::SqlitePoolOptions, SqlitePool, Transaction};
use thiserror::Error;
use uuid::Uuid;

use vending_core::domain::{CommandLogStatus, OutboxKind, OutboxTransport};

use super::schema::{MIGRATION_V1, SCHEMA_VERSION};
use vending_core::hardware::{DispenseCommandPayload, DispenseResultPayload};

const COMMAND_LOG_TTL_DAYS: i64 = 30;
const COMMAND_LOG_MAX_ENTRIES: i64 = 2000;
const OUTBOX_TTL_DAYS: i64 = 7;
const OUTBOX_MAX_EVENTS: i64 = 500;

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

        let url = format!("sqlite://{}?mode=rwc", path.display());
        let pool = SqlitePoolOptions::new()
            .max_connections(5)
            .connect(&url)
            .await
            .map_err(|error| {
                if path.exists() {
                    let quarantine = path.with_extension(format!(
                        "corrupt-{}.db",
                        Utc::now().format("%Y%m%d%H%M%S")
                    ));
                    let _ = std::fs::rename(path, &quarantine);
                    return StoreError::CorruptDatabase {
                        path: quarantine.to_string_lossy().to_string(),
                    };
                }
                StoreError::Sqlx(error)
            })?;

        match run_integrity_check(&pool).await {
            Ok(()) => {}
            Err(error) => {
                let quarantine = path
                    .with_extension(format!("corrupt-{}.db", Utc::now().format("%Y%m%d%H%M%S")));
                if path.exists() {
                    let _ = tokio::fs::rename(path, &quarantine).await;
                }
                return Err(StoreError::IntegrityCheckFailed(format!(
                    "{error}; quarantined to {}",
                    quarantine.display()
                )));
            }
        }

        sqlx::query(MIGRATION_V1)
            .execute(&pool)
            .await
            .map_err(StoreError::Sqlx)?;

        let store = Self { pool };
        store
            .put_metadata("schema_version", &SCHEMA_VERSION)
            .await?;
        store.put_metadata("last_started_at", &now_iso()).await?;
        Ok(store)
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

        let mut out = Vec::with_capacity(rows.len());
        for row in rows {
            out.push(to_outbox_record(row)?);
        }
        Ok(out)
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
            let worst: Option<(String, i64)> =
                sqlx::query_as("SELECT id, priority FROM outbox_events ORDER BY priority DESC, created_at ASC LIMIT 1")
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
        let next_delay = backoff_delay(id, &self.pool).await?;
        sqlx::query(
            "UPDATE outbox_events
             SET attempt_count = attempt_count + 1,
                 last_error = ?2,
                 next_attempt_at = ?3
             WHERE id = ?1",
        )
        .bind(id)
        .bind(error)
        .bind(next_delay)
        .execute(&self.pool)
        .await?;
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

        sqlx::query("UPDATE order_sessions SET payment_attempt_json = ?2, updated_at = ?3 WHERE order_no = ?1")
            .bind(order_no)
            .bind(serde_json::Value::Object(data).to_string())
            .bind(now_iso())
            .execute(&self.pool)
            .await?;
        Ok(())
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
        let deleted_expired = sqlx::query("DELETE FROM outbox_events WHERE expires_at < ?1")
            .bind(now_iso())
            .execute(&self.pool)
            .await?
            .rows_affected();

        let deleted_oversize = sqlx::query(
            "DELETE FROM outbox_events
             WHERE id IN (
               SELECT id FROM outbox_events
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

async fn backoff_delay(id: &str, pool: &SqlitePool) -> Result<String, StoreError> {
    let attempt: (i64,) =
        sqlx::query_as("SELECT attempt_count + 1 FROM outbox_events WHERE id = ?1")
            .bind(id)
            .fetch_one(pool)
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

        let schema_version: Option<i64> = store
            .get_metadata("schema_version")
            .await
            .expect("schema version")
            .unwrap();
        assert_eq!(schema_version, Some(SCHEMA_VERSION));
    }

    #[tokio::test]
    async fn corrupt_database_is_quarantined() {
        let temp = TempDir::new().expect("temp");
        let path = temp.path().join("state.db");
        std::fs::write(&path, b"not-a-sqlite-db").expect("write");

        let result = LocalStateStore::open(&path).await;
        assert!(result.is_err());
        let mut quarantined = false;
        for item in std::fs::read_dir(temp.path()).expect("dir") {
            let item = item.expect("item");
            let name = item.file_name().to_string_lossy().to_string();
            if name.starts_with("state.corrupt-") {
                quarantined = true;
                break;
            }
        }
        assert!(quarantined);
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

        let key = store
            .get_or_create_payment_attempt_key("ORDER-SECRET")
            .await
            .expect("id");
        store
            .record_payment_attempt_summary("ORDER-SECRET", "6212****3456", "tauri_scanner", &key)
            .await
            .expect("summary");

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
