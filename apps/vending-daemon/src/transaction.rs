use std::sync::Arc;
use uuid::Uuid;

use tokio::sync::broadcast;

use crate::backend::BackendClient;
use crate::events::DaemonEvent;
use crate::state::{LocalStateStore, OrderSessionUpsert};

#[derive(Debug, Clone)]
pub struct TransactionStateMachine {
    state: LocalStateStore,
    backend: Arc<BackendClient>,
    events: broadcast::Sender<DaemonEvent>,
    machine_code: Option<String>,
}

impl TransactionStateMachine {
    pub fn new(
        state: LocalStateStore,
        backend: Arc<BackendClient>,
        machine_code: Option<String>,
        events: broadcast::Sender<DaemonEvent>,
    ) -> Self {
        Self {
            state,
            backend,
            events,
            machine_code,
        }
    }

    pub async fn restore_current(
        &self,
    ) -> Result<Option<vending_core::domain::TransactionSnapshot>, String> {
        self.state
            .current_order_session_snapshot()
            .await
            .map_err(|error| error.to_string())
    }

    pub async fn create_order(
        &self,
        payment_method: &str,
        payment_provider_code: Option<String>,
        items: serde_json::Value,
        profile_snapshot: Option<serde_json::Value>,
    ) -> Result<vending_core::domain::TransactionSnapshot, String> {
        let machine_code = self
            .machine_code
            .clone()
            .ok_or_else(|| "machine code is required".to_string())?;

        let response = self
            .backend
            .create_order(
                &machine_code,
                vec![items.clone()],
                payment_method,
                payment_provider_code.as_deref(),
                profile_snapshot,
            )
            .await
            .map_err(|error| error.to_string())?;
        let order_no = response
            .get("orderNo")
            .and_then(|value| value.as_str())
            .ok_or_else(|| "backend create order response missing orderNo".to_string())?;
        let order_no = order_no.to_string();

        self.state
            .upsert_order_session(OrderSessionUpsert {
                order_no: &order_no,
                payment_method,
                payment_provider: payment_provider_code.as_deref(),
                items_json: items,
                status: "waiting_payment",
                next_action: "submit_payment",
                payment_attempt_json: None,
                recovery_strategy: "local",
                last_backend_status_json: None,
                last_error: None,
            })
            .await
            .map_err(|error| error.to_string())?;

        Ok(vending_core::domain::TransactionSnapshot {
            order_no: Some(order_no),
            status: Some(vending_core::domain::OrderSessionStatus::WaitingPayment),
            next_action: Some("submit_payment".to_string()),
            updated_at: crate::state::store::now_iso(),
        })
    }

    pub async fn submit_payment_code(
        &self,
        order_no: &str,
        raw: vending_core::scanner::RawPaymentCode,
        source: &str,
    ) -> Result<(), String> {
        let machine_code = self
            .machine_code
            .as_deref()
            .ok_or_else(|| "machine code is required".to_string())?;
        let idempotency_key = self
            .state
            .get_or_create_payment_attempt_key(order_no)
            .await
            .map_err(|error| error.to_string())?;
        self.backend
            .submit_payment_code(
                machine_code,
                order_no,
                &raw.auth_code,
                &idempotency_key,
                source,
            )
            .await?;

        self.state
            .record_payment_attempt_summary(order_no, &raw.masked_code, source, &idempotency_key)
            .await
            .map_err(|error| error.to_string())?;

        let _ = self.events.send(DaemonEvent::TransactionChanged {
            event_id: Uuid::new_v4().simple().to_string(),
            updated_at: crate::state::store::now_iso(),
            order_no: order_no.to_string(),
            status: "payment_code_submitted".to_string(),
        });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn payment_code_plaintext_not_stored() {
        let temp = tempfile::tempdir().expect("temp");
        let state = crate::state::LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("state");
        state
            .upsert_order_session(OrderSessionUpsert {
                order_no: "ORDER-1",
                payment_method: "payment_code",
                payment_provider: Some("wechat_pay"),
                items_json: serde_json::json!([]),
                status: "waiting_payment",
                next_action: "submit_payment",
                payment_attempt_json: None,
                recovery_strategy: "local",
                last_backend_status_json: None,
                last_error: None,
            })
            .await
            .expect("seed");

        let backend = Arc::new(BackendClient::new("http://127.0.0.1:0/api"));
        let (events_tx, _) = broadcast::channel(8);
        let machine = TransactionStateMachine::new(
            state.clone(),
            backend,
            Some("MACHINE-1".to_string()),
            events_tx,
        );

        machine
            .state
            .record_payment_attempt_summary("ORDER-1", "6212****3456", "serial", "key1")
            .await
            .expect("seed payment attempt");

        let rows: String = sqlx::query_scalar(
            "SELECT payment_attempt_json FROM order_sessions WHERE order_no='ORDER-1'",
        )
        .fetch_one(state.pool())
        .await
        .expect("row");
        assert!(!rows.contains("621234567890123456"));
        assert!(rows.contains("6212****3456"));
    }
}
