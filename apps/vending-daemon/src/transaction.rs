use std::sync::Arc;
use uuid::Uuid;

use tokio::sync::broadcast;

use crate::backend::BackendClient;
use crate::events::DaemonEvent;
use crate::state::{LocalStateStore, OrderSessionUpsert, StoreError};

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
    ) -> Result<Option<vending_core::domain::CurrentTransactionSnapshot>, String> {
        self.state
            .current_transaction_snapshot()
            .await
            .map_err(|error| error.to_string())
    }

    pub async fn create_order(
        &self,
        payment_method: &str,
        payment_provider_code: Option<String>,
        items: serde_json::Value,
        profile_snapshot: Option<serde_json::Value>,
    ) -> Result<vending_core::domain::CurrentTransactionSnapshot, String> {
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
            .await?;
        let order_no = response
            .get("orderNo")
            .and_then(|value| value.as_str())
            .ok_or_else(|| "backend create order response missing orderNo".to_string())?
            .to_string();

        let backend_status = self
            .backend
            .get_order_status(&machine_code, &order_no)
            .await
            .unwrap_or_else(|_| response.clone());
        let next_action = backend_status
            .get("nextAction")
            .and_then(|value| value.as_str())
            .unwrap_or("wait_payment")
            .to_string();
        let order_status = backend_status
            .get("orderStatus")
            .and_then(|value| value.as_str())
            .unwrap_or("waiting_payment")
            .to_string();

        self.state
            .upsert_order_session(OrderSessionUpsert {
                order_no: &order_no,
                payment_method,
                payment_provider: payment_provider_code.as_deref(),
                items_json: items,
                status: &order_status,
                next_action: &next_action,
                payment_attempt_json: None,
                recovery_strategy: "local",
                last_backend_status_json: Some(backend_status),
                last_error: None,
            })
            .await
            .map_err(|error| error.to_string())?;

        self.state
            .current_transaction_snapshot()
            .await
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "current transaction missing after create order".to_string())
    }

    pub async fn submit_payment_code(
        &self,
        raw: vending_core::scanner::RawPaymentCode,
        source: &str,
        scanner_health: Option<vending_core::scanner::ScannerHealthSnapshot>,
    ) -> Result<vending_core::domain::CurrentTransactionSnapshot, String> {
        let machine_code = self
            .machine_code
            .as_deref()
            .ok_or_else(|| "machine code is required".to_string())?;
        let snapshot = self
            .state
            .current_transaction_snapshot()
            .await
            .map_err(|error| error.to_string())?;
        let Some(snapshot) = snapshot else {
            return Err("NO_ACTIVE_TRANSACTION".to_string());
        };
        if snapshot.payment_method.as_deref() != Some("payment_code") {
            return Err("IGNORED_NON_PAYMENT_CODE_TRANSACTION".to_string());
        }
        if !matches!(
            snapshot.next_action.as_deref(),
            Some("wait_payment" | "submit_payment")
        ) {
            return Err("IGNORED_TRANSACTION_NOT_WAITING_PAYMENT".to_string());
        }
        if let Some(attempt) = snapshot.payment_code_attempt.as_ref() {
            if matches!(
                attempt.status.as_deref(),
                Some("submitting" | "user_confirming" | "querying" | "processing")
            ) {
                return Err("ACTIVE_PAYMENT_CODE_ATTEMPT".to_string());
            }
        }
        let order_no = snapshot
            .order_no
            .clone()
            .ok_or_else(|| "ORDER_NO_MISSING".to_string())?;
        let idempotency_key = self
            .state
            .begin_payment_code_attempt(
                &order_no,
                &raw.masked_code,
                source,
                raw.scanned_at_ms,
                scanner_health.as_ref(),
            )
            .await
            .map_err(|error| match error {
                StoreError::ActivePaymentCodeAttempt => "ACTIVE_PAYMENT_CODE_ATTEMPT".to_string(),
                _ => error.to_string(),
            })?;

        let mut submit_error = None;
        let mut submit_response = None;
        for _ in 0..3 {
            match self
                .backend
                .submit_payment_code(
                    machine_code,
                    &order_no,
                    &raw.auth_code,
                    &idempotency_key,
                    source,
                    scanner_health.as_ref(),
                )
                .await
            {
                Ok(response) => {
                    submit_response = Some(response);
                    break;
                }
                Err(error) => submit_error = Some(error),
            }
        }

        let response = match submit_response {
            Some(response) => response,
            None => {
                self.state
                    .finish_payment_code_attempt(
                        &order_no,
                        "unknown",
                        true,
                        Some("网络异常，请刷新付款码后重试"),
                    )
                    .await
                    .map_err(|error| error.to_string())?;
                return Err(submit_error.unwrap_or_else(|| "BACKEND_SUBMIT_FAILED".to_string()));
            }
        };

        let status = response
            .get("status")
            .and_then(|value| value.as_str())
            .unwrap_or("unknown");
        let can_retry = response
            .get("canRetry")
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
        let message = response.get("message").and_then(|value| value.as_str());
        self.state
            .finish_payment_code_attempt(&order_no, status, can_retry, message)
            .await
            .map_err(|error| error.to_string())?;

        let last_backend_status_json =
            match self.backend.get_order_status(machine_code, &order_no).await {
                Ok(status_json) => Some(status_json),
                Err(error) => {
                    let payment_attempt_json = self
                        .state
                        .load_attempt_json(&order_no)
                        .await
                        .map_err(|store_error| store_error.to_string())?
                        .map(serde_json::Value::Object);
                    self.state
                        .upsert_order_session(OrderSessionUpsert {
                            order_no: &order_no,
                            payment_method: snapshot
                                .payment_method
                                .as_deref()
                                .unwrap_or("payment_code"),
                            payment_provider: snapshot.payment_provider.as_deref(),
                            items_json: snapshot
                                .product_summary
                                .clone()
                                .unwrap_or_else(|| serde_json::json!([])),
                            status: snapshot
                                .order_status
                                .as_deref()
                                .unwrap_or("waiting_payment"),
                            next_action: snapshot.next_action.as_deref().unwrap_or("wait_payment"),
                            payment_attempt_json,
                            recovery_strategy: "local",
                            last_backend_status_json: None,
                            last_error: Some(&error),
                        })
                        .await
                        .map_err(|store_error| store_error.to_string())?;
                    None
                }
            };

        if let Some(status_json) = last_backend_status_json {
            let payment_attempt_json = self
                .state
                .load_attempt_json(&order_no)
                .await
                .map_err(|error| error.to_string())?
                .map(serde_json::Value::Object);
            let order_status = status_json
                .get("orderStatus")
                .and_then(|value| value.as_str())
                .unwrap_or(
                    snapshot
                        .order_status
                        .as_deref()
                        .unwrap_or("waiting_payment"),
                )
                .to_string();
            let next_action = status_json
                .get("nextAction")
                .and_then(|value| value.as_str())
                .unwrap_or(snapshot.next_action.as_deref().unwrap_or("wait_payment"))
                .to_string();
            self.state
                .upsert_order_session(OrderSessionUpsert {
                    order_no: &order_no,
                    payment_method: snapshot.payment_method.as_deref().unwrap_or("payment_code"),
                    payment_provider: snapshot.payment_provider.as_deref(),
                    items_json: snapshot
                        .product_summary
                        .clone()
                        .unwrap_or_else(|| serde_json::json!([])),
                    status: &order_status,
                    next_action: &next_action,
                    payment_attempt_json,
                    recovery_strategy: "local",
                    last_backend_status_json: Some(status_json),
                    last_error: None,
                })
                .await
                .map_err(|error| error.to_string())?;
        }

        let current = self
            .state
            .current_transaction_snapshot()
            .await
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "CURRENT_TRANSACTION_MISSING".to_string())?;

        let _ = self.events.send(DaemonEvent::TransactionChanged {
            event_id: Uuid::new_v4().simple().to_string(),
            updated_at: crate::state::store::now_iso(),
            order_no: order_no.to_string(),
            status: current
                .next_action
                .clone()
                .unwrap_or_else(|| current.order_status.clone().unwrap_or_default()),
        });
        Ok(current)
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
            .begin_payment_code_attempt("ORDER-1", "6212****3456", "serial_text", 1_000, None)
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
