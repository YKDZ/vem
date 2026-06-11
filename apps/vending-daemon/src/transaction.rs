use std::sync::Arc;
use uuid::Uuid;

use tokio::sync::broadcast;
use tokio::time::{Duration, Instant};

use crate::backend::BackendClient;
use crate::events::DaemonEvent;
use crate::state::{LocalStateStore, OrderSessionUpsert, StoreError};

#[cfg(test)]
const PAYMENT_CODE_STATUS_POLL_INTERVAL: Duration = Duration::from_millis(20);
#[cfg(not(test))]
const PAYMENT_CODE_STATUS_POLL_INTERVAL: Duration = Duration::from_secs(3);
#[cfg(test)]
const PAYMENT_CODE_STATUS_POLL_MAX: Duration = Duration::from_millis(250);
#[cfg(not(test))]
const PAYMENT_CODE_STATUS_POLL_MAX: Duration = Duration::from_secs(45);

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
        self.refresh_current_from_backend().await
    }

    async fn refresh_current_from_backend(
        &self,
    ) -> Result<Option<vending_core::domain::CurrentTransactionSnapshot>, String> {
        let Some(current) = self
            .state
            .current_transaction_snapshot()
            .await
            .map_err(|error| error.to_string())?
        else {
            return Ok(None);
        };
        if is_terminal_transaction(&current) {
            return Ok(Some(current));
        }

        let Some(machine_code) = self.machine_code.as_deref() else {
            return Ok(Some(current));
        };
        let Some(order_no) = current.order_no.clone() else {
            return Ok(Some(current));
        };
        let before_status = current
            .next_action
            .clone()
            .or_else(|| current.order_status.clone())
            .unwrap_or_default();

        if let Ok(status_json) = self.backend.get_order_status(machine_code, &order_no).await {
            self.state
                .apply_backend_order_status(&order_no, status_json)
                .await
                .map_err(|error| error.to_string())?;
            let refreshed = self
                .state
                .current_transaction_snapshot()
                .await
                .map_err(|error| error.to_string())?;
            if let Some(refreshed) = refreshed.as_ref() {
                let after_status = refreshed
                    .next_action
                    .clone()
                    .or_else(|| refreshed.order_status.clone())
                    .unwrap_or_default();
                if after_status != before_status {
                    self.emit_transaction_changed(&order_no, refreshed);
                }
            }
            return Ok(refreshed);
        }

        Ok(Some(current))
    }

    pub async fn create_order(
        &self,
        payment_method: &str,
        payment_provider_code: Option<String>,
        items: serde_json::Value,
        profile_snapshot: Option<serde_json::Value>,
    ) -> Result<vending_core::domain::CurrentTransactionSnapshot, String> {
        if let Some(current) = self.refresh_current_from_backend().await? {
            if is_active_transaction(&current) {
                return Ok(current);
            }
        }

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

        if let Some(current) = self
            .state
            .current_transaction_snapshot()
            .await
            .map_err(|error| error.to_string())?
        {
            self.emit_transaction_changed(&order_no, &current);
        }

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
                if let Some(current) = self
                    .state
                    .current_transaction_snapshot()
                    .await
                    .map_err(|error| error.to_string())?
                {
                    self.emit_transaction_changed(&order_no, &current);
                }
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

        match self.backend.get_order_status(machine_code, &order_no).await {
            Ok(status_json) => {
                self.state
                    .apply_backend_order_status(&order_no, status_json)
                    .await
                    .map_err(|error| error.to_string())?;
            }
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
            }
        }

        let current = self
            .state
            .current_transaction_snapshot()
            .await
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "CURRENT_TRANSACTION_MISSING".to_string())?;

        self.emit_transaction_changed(&order_no, &current);
        if should_follow_payment_code_attempt(&current) {
            self.spawn_payment_code_status_refresh(order_no);
        }
        Ok(current)
    }

    fn spawn_payment_code_status_refresh(&self, order_no: String) {
        let machine = self.clone();
        tokio::spawn(async move {
            let _ = machine
                .refresh_payment_code_status_until_stable(order_no)
                .await;
        });
    }

    async fn refresh_payment_code_status_until_stable(
        &self,
        order_no: String,
    ) -> Result<(), String> {
        let machine_code = self
            .machine_code
            .as_deref()
            .ok_or_else(|| "machine code is required".to_string())?;
        let deadline = Instant::now() + PAYMENT_CODE_STATUS_POLL_MAX;
        while Instant::now() < deadline {
            tokio::time::sleep(PAYMENT_CODE_STATUS_POLL_INTERVAL).await;
            let status_json = self
                .backend
                .get_order_status(machine_code, &order_no)
                .await?;
            self.state
                .apply_backend_order_status(&order_no, status_json)
                .await
                .map_err(|error| error.to_string())?;
            let Some(current) = self
                .state
                .current_transaction_snapshot()
                .await
                .map_err(|error| error.to_string())?
            else {
                return Ok(());
            };
            self.emit_transaction_changed(&order_no, &current);
            if !should_follow_payment_code_attempt(&current) {
                return Ok(());
            }
        }
        Ok(())
    }

    fn emit_transaction_changed(
        &self,
        order_no: &str,
        current: &vending_core::domain::CurrentTransactionSnapshot,
    ) {
        let _ = self.events.send(DaemonEvent::TransactionChanged {
            event_id: Uuid::new_v4().simple().to_string(),
            updated_at: crate::state::store::now_iso(),
            order_no: order_no.to_string(),
            status: current
                .next_action
                .clone()
                .unwrap_or_else(|| current.order_status.clone().unwrap_or_default()),
        });
    }
}

fn should_follow_payment_code_attempt(
    current: &vending_core::domain::CurrentTransactionSnapshot,
) -> bool {
    current
        .payment_code_attempt
        .as_ref()
        .and_then(|attempt| attempt.status.as_deref())
        .is_some_and(|status| {
            matches!(
                status,
                "submitting" | "user_confirming" | "querying" | "processing"
            )
        })
}

pub fn is_active_transaction(current: &vending_core::domain::CurrentTransactionSnapshot) -> bool {
    if is_terminal_transaction(current) {
        return false;
    }
    current
        .next_action
        .as_deref()
        .is_some_and(|status| matches!(status, "wait_payment" | "submit_payment" | "dispensing"))
        || current.order_status.as_deref().is_some_and(|status| {
            matches!(
                status,
                "waiting_payment" | "pending_payment" | "paid" | "dispensing"
            )
        })
}

fn is_terminal_transaction(current: &vending_core::domain::CurrentTransactionSnapshot) -> bool {
    current.next_action.as_deref().is_some_and(|status| {
        matches!(
            status,
            "success"
                | "payment_expired"
                | "payment_failed"
                | "dispense_failed"
                | "refund_pending"
                | "refunded"
                | "manual_handling"
                | "closed"
        )
    }) || current.order_status.as_deref().is_some_and(|status| {
        matches!(
            status,
            "fulfilled"
                | "succeeded"
                | "failed"
                | "payment_expired"
                | "payment_failed"
                | "canceled"
                | "cancelled"
                | "expired"
                | "dispense_failed"
                | "refunded"
                | "partial_refunded"
                | "manual_handling"
                | "closed"
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, Request, ResponseTemplate};

    fn transaction_snapshot_with_status(
        order_status: &str,
        next_action: &str,
    ) -> vending_core::domain::CurrentTransactionSnapshot {
        vending_core::domain::CurrentTransactionSnapshot {
            order_id: None,
            order_no: Some("ORDER-STATUS".to_string()),
            product_summary: None,
            payment_no: None,
            payment_method: Some("payment_code".to_string()),
            payment_provider: Some("alipay".to_string()),
            payment_url: None,
            payment_status: None,
            order_status: Some(order_status.to_string()),
            total_amount_cents: None,
            vending: None,
            next_action: Some(next_action.to_string()),
            masked_auth_code: None,
            payment_code_attempt: None,
            expires_at: None,
            error_code: None,
            error_message: None,
            operator_hint: None,
            updated_at: "2026-06-10T00:00:00.000Z".to_string(),
        }
    }

    #[test]
    fn expired_next_action_is_not_active_transaction() {
        let snapshot = transaction_snapshot_with_status("waiting_payment", "payment_expired");

        assert!(!is_active_transaction(&snapshot));
    }

    #[tokio::test]
    async fn restore_current_refreshes_active_order_from_backend() {
        let temp = tempfile::tempdir().expect("temp");
        let state = crate::state::LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("state");
        state
            .upsert_order_session(OrderSessionUpsert {
                order_no: "ORDER-DISPENSED",
                payment_method: "payment_code",
                payment_provider: Some("alipay"),
                items_json: json!([{ "slotCode": "A1", "quantity": 1 }]),
                status: "dispensing",
                next_action: "dispensing",
                payment_attempt_json: Some(json!({
                    "attemptNo": 1,
                    "status": "succeeded",
                    "maskedAuthCode": "2840****3066",
                    "source": "serial_text",
                    "idempotencyKey": "ORDER-DISPENSED:attempt-1",
                    "submittedAt": "2026-06-10T04:10:17.000Z",
                    "lastCheckedAt": "2026-06-10T04:10:20.000Z",
                    "canRetry": false
                })),
                recovery_strategy: "local",
                last_backend_status_json: Some(json!({
                    "orderNo": "ORDER-DISPENSED",
                    "machineCode": "M-1",
                    "orderStatus": "dispensing",
                    "nextAction": "dispensing",
                    "payment": {
                        "paymentNo": "PAY-DISPENSED",
                        "method": "payment_code",
                        "providerCode": "alipay",
                        "status": "succeeded",
                        "paymentUrl": null,
                        "expiresAt": "2026-06-10T04:16:26.596Z"
                    },
                    "vending": {
                        "commandNo": "CMD-DISPENSED",
                        "status": "sent",
                        "lastError": null
                    }
                })),
                last_error: None,
            })
            .await
            .expect("seed");

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/machine-auth/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "accessToken": "token-123"
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/machine-orders/ORDER-DISPENSED/status"))
            .and(header("authorization", "Bearer token-123"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "orderNo": "ORDER-DISPENSED",
                "machineCode": "M-1",
                "orderStatus": "fulfilled",
                "fulfillmentState": "dispensed",
                "totalAmountCents": 1,
                "nextAction": "success",
                "payment": {
                    "paymentNo": "PAY-DISPENSED",
                    "method": "payment_code",
                    "providerCode": "alipay",
                    "status": "succeeded",
                    "paymentUrl": null,
                    "expiresAt": "2026-06-10T04:16:26.596Z"
                },
                "paymentCodeAttempt": {
                    "attemptNo": 1,
                    "status": "succeeded",
                    "maskedAuthCode": "2840****3066",
                    "source": "serial_text",
                    "idempotencyKey": "ORDER-DISPENSED:attempt-1",
                    "submittedAt": "2026-06-10T04:10:17.000Z",
                    "lastCheckedAt": "2026-06-10T04:10:20.000Z",
                    "canRetry": false
                },
                "vending": {
                    "commandNo": "CMD-DISPENSED",
                    "status": "succeeded",
                    "lastError": "serial: dispense completed"
                }
            })))
            .mount(&server)
            .await;

        let backend = Arc::new(BackendClient::new(server.uri()));
        backend.authenticate("M-1", "S-1").await.expect("auth");
        let (events_tx, mut events_rx) = broadcast::channel(8);
        let machine = TransactionStateMachine::new(
            state.clone(),
            backend,
            Some("M-1".to_string()),
            events_tx,
        );

        let current = machine
            .restore_current()
            .await
            .expect("restore")
            .expect("current");
        assert_eq!(current.order_status.as_deref(), Some("fulfilled"));
        assert_eq!(current.next_action.as_deref(), Some("success"));
        assert_eq!(
            current
                .vending
                .as_ref()
                .and_then(|vending| vending.status.as_deref()),
            Some("succeeded")
        );

        let summary = state
            .current_order_session_snapshot()
            .await
            .expect("summary")
            .expect("current summary");
        assert_eq!(
            summary.status,
            Some(vending_core::domain::OrderSessionStatus::Succeeded)
        );
        let event = events_rx.recv().await.expect("event");
        match event {
            DaemonEvent::TransactionChanged {
                order_no, status, ..
            } => {
                assert_eq!(order_no, "ORDER-DISPENSED");
                assert_eq!(status, "success");
            }
            other => panic!("unexpected event: {other:?}"),
        }
    }

    #[tokio::test]
    async fn create_order_resumes_existing_active_transaction() {
        let temp = tempfile::tempdir().expect("temp");
        let state = crate::state::LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("state");
        state
            .upsert_order_session(OrderSessionUpsert {
                order_no: "ORDER-ACTIVE",
                payment_method: "payment_code",
                payment_provider: Some("alipay"),
                items_json: json!([{ "slotCode": "A1", "quantity": 1 }]),
                status: "waiting_payment",
                next_action: "wait_payment",
                payment_attempt_json: None,
                recovery_strategy: "local",
                last_backend_status_json: Some(json!({
                    "orderNo": "ORDER-ACTIVE",
                    "machineCode": "M-1",
                    "orderStatus": "pending_payment",
                    "nextAction": "wait_payment",
                    "payment": {
                        "paymentNo": "PAY-ACTIVE",
                        "method": "payment_code",
                        "providerCode": "alipay",
                        "status": "pending",
                        "paymentUrl": null,
                        "expiresAt": "2026-06-10T00:05:00.000Z"
                    }
                })),
                last_error: None,
            })
            .await
            .expect("seed");

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/machine-auth/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "accessToken": "token-123"
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/machine-orders/ORDER-ACTIVE/status"))
            .and(header("authorization", "Bearer token-123"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "orderNo": "ORDER-ACTIVE",
                "machineCode": "M-1",
                "orderStatus": "pending_payment",
                "nextAction": "wait_payment",
                "payment": {
                    "paymentNo": "PAY-ACTIVE",
                    "method": "payment_code",
                    "providerCode": "alipay",
                    "status": "pending",
                    "paymentUrl": null,
                    "expiresAt": "2026-06-10T00:05:00.000Z"
                }
            })))
            .mount(&server)
            .await;

        let backend = Arc::new(BackendClient::new(server.uri()));
        backend.authenticate("M-1", "S-1").await.expect("auth");
        let (events_tx, _) = broadcast::channel(8);
        let machine = TransactionStateMachine::new(
            state.clone(),
            backend,
            Some("M-1".to_string()),
            events_tx,
        );

        let current = machine
            .create_order(
                "payment_code",
                Some("alipay".to_string()),
                json!([{ "slotCode": "A2", "quantity": 1 }]),
                None,
            )
            .await
            .expect("current");
        assert_eq!(current.order_no.as_deref(), Some("ORDER-ACTIVE"));

        let order_count: (i64,) = sqlx::query_as("SELECT COUNT(1) FROM order_sessions")
            .fetch_one(state.pool())
            .await
            .expect("count");
        assert_eq!(order_count.0, 1);
    }

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

    #[tokio::test]
    async fn payment_code_querying_attempt_refreshes_to_reversed_and_retryable() {
        let temp = tempfile::tempdir().expect("temp");
        let state = crate::state::LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("state");
        state
            .upsert_order_session(OrderSessionUpsert {
                order_no: "ORDER-REV",
                payment_method: "payment_code",
                payment_provider: Some("alipay"),
                items_json: serde_json::json!({
                    "slotCode": "A1",
                    "quantity": 1
                }),
                status: "waiting_payment",
                next_action: "wait_payment",
                payment_attempt_json: None,
                recovery_strategy: "local",
                last_backend_status_json: Some(json!({
                    "orderNo": "ORDER-REV",
                    "machineCode": "M-1",
                    "orderStatus": "pending_payment",
                    "nextAction": "wait_payment",
                    "payment": {
                        "paymentNo": "PAY-REV",
                        "method": "payment_code",
                        "providerCode": "alipay",
                        "status": "pending",
                        "paymentUrl": null,
                        "expiresAt": "2026-06-10T00:05:00.000Z"
                    }
                })),
                last_error: None,
            })
            .await
            .expect("seed");

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/machine-auth/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "accessToken": "token-123"
            })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/machine-orders/ORDER-REV/payment-code/submit"))
            .and(header("authorization", "Bearer token-123"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "orderNo": "ORDER-REV",
                "paymentNo": "PAY-REV",
                "attemptNo": 1,
                "status": "querying",
                "nextAction": "wait_payment",
                "message": "正在确认支付结果",
                "canRetry": false,
                "serverTime": "2026-06-10T00:00:00.000Z"
            })))
            .mount(&server)
            .await;

        let status_calls = Arc::new(AtomicUsize::new(0));
        let status_calls_for_mock = status_calls.clone();
        Mock::given(method("GET"))
            .and(path("/machine-orders/ORDER-REV/status"))
            .and(header("authorization", "Bearer token-123"))
            .respond_with(move |_request: &Request| {
                let call = status_calls_for_mock.fetch_add(1, Ordering::SeqCst);
                let attempt_status = if call == 0 { "querying" } else { "reversed" };
                ResponseTemplate::new(200).set_body_json(json!({
                    "orderNo": "ORDER-REV",
                    "machineCode": "M-1",
                    "orderStatus": "pending_payment",
                    "nextAction": "wait_payment",
                    "payment": {
                        "paymentNo": "PAY-REV",
                        "method": "payment_code",
                        "providerCode": "alipay",
                        "status": "pending",
                        "paymentUrl": null,
                        "expiresAt": "2026-06-10T00:05:00.000Z"
                    },
                    "paymentCodeAttempt": {
                        "attemptNo": 1,
                        "status": attempt_status,
                        "maskedAuthCode": "2829****4955",
                        "source": "serial_text",
                        "idempotencyKey": "ORDER-REV:attempt-1",
                        "submittedAt": "2026-06-10T00:00:01.000Z",
                        "lastCheckedAt": "2026-06-10T00:00:02.000Z",
                        "canRetry": attempt_status == "reversed",
                        "message": null
                    }
                }))
            })
            .mount(&server)
            .await;

        let backend = Arc::new(BackendClient::new(server.uri()));
        backend.authenticate("M-1", "S-1").await.expect("auth");
        let (events_tx, _) = broadcast::channel(8);
        let machine = TransactionStateMachine::new(
            state.clone(),
            backend,
            Some("M-1".to_string()),
            events_tx,
        );
        let code = vending_core::scanner::RawPaymentCode {
            auth_code: "2829123456784955".to_string(),
            masked_code: "2829****4955".to_string(),
            scanned_at_ms: 1_000,
        };

        let current = machine
            .submit_payment_code(
                code,
                vending_core::scanner::PAYMENT_CODE_SOURCE_SERIAL_TEXT,
                None,
            )
            .await
            .expect("submit");
        assert_eq!(
            current
                .payment_code_attempt
                .as_ref()
                .and_then(|attempt| attempt.status.as_deref()),
            Some("querying")
        );

        let deadline = Instant::now() + Duration::from_secs(1);
        loop {
            let current = state
                .current_transaction_snapshot()
                .await
                .expect("snapshot")
                .expect("current");
            if current
                .payment_code_attempt
                .as_ref()
                .and_then(|attempt| attempt.status.as_deref())
                == Some("reversed")
            {
                let attempt = current.payment_code_attempt.as_ref().expect("attempt");
                assert_eq!(attempt.attempt_no, Some(1));
                assert_eq!(attempt.masked_auth_code.as_deref(), Some("2829****4955"));
                assert!(attempt.can_retry);
                assert!(!format!("{current:?}").contains("2829123456784955"));
                break;
            }
            if Instant::now() > deadline {
                panic!("payment code attempt did not refresh to reversed");
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(status_calls.load(Ordering::SeqCst) >= 2);
    }

    #[tokio::test]
    async fn payment_code_attempt_emits_transaction_event_before_backend_submit_returns() {
        let temp = tempfile::tempdir().expect("temp");
        let state = crate::state::LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("state");
        state
            .upsert_order_session(OrderSessionUpsert {
                order_no: "ORDER-DELAY",
                payment_method: "payment_code",
                payment_provider: Some("alipay"),
                items_json: serde_json::json!({
                    "slotCode": "A1",
                    "quantity": 1
                }),
                status: "waiting_payment",
                next_action: "wait_payment",
                payment_attempt_json: None,
                recovery_strategy: "local",
                last_backend_status_json: Some(json!({
                    "orderNo": "ORDER-DELAY",
                    "machineCode": "M-1",
                    "orderStatus": "pending_payment",
                    "nextAction": "wait_payment",
                    "payment": {
                        "paymentNo": "PAY-DELAY",
                        "method": "payment_code",
                        "providerCode": "alipay",
                        "status": "pending",
                        "paymentUrl": null,
                        "expiresAt": "2026-06-10T00:05:00.000Z"
                    }
                })),
                last_error: None,
            })
            .await
            .expect("seed");

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/machine-auth/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "accessToken": "token-123"
            })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/machine-orders/ORDER-DELAY/payment-code/submit"))
            .and(header("authorization", "Bearer token-123"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_delay(Duration::from_millis(150))
                    .set_body_json(json!({
                        "orderNo": "ORDER-DELAY",
                        "paymentNo": "PAY-DELAY",
                        "attemptNo": 1,
                        "status": "querying",
                        "nextAction": "wait_payment",
                        "message": "正在确认支付结果",
                        "canRetry": false,
                        "serverTime": "2026-06-10T00:00:00.000Z"
                    })),
            )
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/machine-orders/ORDER-DELAY/status"))
            .and(header("authorization", "Bearer token-123"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "orderNo": "ORDER-DELAY",
                "machineCode": "M-1",
                "orderStatus": "pending_payment",
                "nextAction": "wait_payment",
                "payment": {
                    "paymentNo": "PAY-DELAY",
                    "method": "payment_code",
                    "providerCode": "alipay",
                    "status": "pending",
                    "paymentUrl": null,
                    "expiresAt": "2026-06-10T00:05:00.000Z"
                },
                "paymentCodeAttempt": {
                    "attemptNo": 1,
                    "status": "querying",
                    "maskedAuthCode": "2829****4955",
                    "source": "serial_text",
                    "idempotencyKey": "ORDER-DELAY:attempt-1",
                    "submittedAt": "2026-06-10T00:00:01.000Z",
                    "lastCheckedAt": null,
                    "canRetry": false,
                    "message": "正在确认支付结果"
                }
            })))
            .mount(&server)
            .await;

        let backend = Arc::new(BackendClient::new(server.uri()));
        backend.authenticate("M-1", "S-1").await.expect("auth");
        let (events_tx, mut events_rx) = broadcast::channel(8);
        let machine = TransactionStateMachine::new(
            state.clone(),
            backend,
            Some("M-1".to_string()),
            events_tx,
        );
        let task_machine = machine.clone();
        let code = vending_core::scanner::RawPaymentCode {
            auth_code: "2829123456784955".to_string(),
            masked_code: "2829****4955".to_string(),
            scanned_at_ms: 1_000,
        };
        let submit = tokio::spawn(async move {
            task_machine
                .submit_payment_code(
                    code,
                    vending_core::scanner::PAYMENT_CODE_SOURCE_SERIAL_TEXT,
                    None,
                )
                .await
        });

        let event = tokio::time::timeout(Duration::from_millis(80), events_rx.recv())
            .await
            .expect("transaction event before backend submit returns")
            .expect("event");
        match event {
            DaemonEvent::TransactionChanged { order_no, .. } => {
                assert_eq!(order_no, "ORDER-DELAY");
            }
            other => panic!("unexpected event: {other:?}"),
        }

        let current = submit.await.expect("join").expect("submit");
        assert_eq!(
            current
                .payment_code_attempt
                .as_ref()
                .and_then(|attempt| attempt.status.as_deref()),
            Some("querying")
        );
    }
}
