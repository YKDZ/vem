use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CommandLogStatus {
    Received,
    Acknowledged,
    Dispensing,
    Succeeded,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OutboxKind {
    CommandAck,
    DispenseResult,
    Heartbeat,
    RemoteOpResult,
    LogExport,
    StockMovementUpload,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OutboxTransport {
    Mqtt,
    Http,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OrderSessionStatus {
    WaitingPayment,
    PaymentSubmitted,
    Dispensing,
    Succeeded,
    Failed,
    ManualHandling,
    Closed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransactionSnapshot {
    pub order_no: Option<String>,
    pub status: Option<OrderSessionStatus>,
    pub next_action: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentTransactionSummary {
    pub order_no: String,
    pub status: OrderSessionStatus,
    pub next_action: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VendingCommandSummary {
    pub command_no: Option<String>,
    pub status: Option<String>,
    pub last_error: Option<String>,
    pub pickup_reminder: Option<PickupReminderSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PickupReminderSummary {
    pub level: String,
    pub message: String,
    pub warning_no: Option<u8>,
    pub reported_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaymentCodeAttemptSummary {
    pub attempt_no: Option<i64>,
    pub status: Option<String>,
    pub masked_auth_code: Option<String>,
    pub source: Option<String>,
    pub idempotency_key: Option<String>,
    pub submitted_at: Option<String>,
    pub last_checked_at: Option<String>,
    pub can_retry: bool,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentTransactionSnapshot {
    pub order_id: Option<String>,
    pub order_no: Option<String>,
    pub product_summary: Option<serde_json::Value>,
    pub payment_no: Option<String>,
    pub payment_method: Option<String>,
    pub payment_provider: Option<String>,
    pub payment_url: Option<String>,
    pub payment_status: Option<String>,
    pub order_status: Option<String>,
    pub total_amount_cents: Option<i64>,
    pub vending: Option<VendingCommandSummary>,
    pub next_action: Option<String>,
    pub masked_auth_code: Option<String>,
    pub payment_code_attempt: Option<PaymentCodeAttemptSummary>,
    pub expires_at: Option<String>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub operator_hint: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatusSnapshot {
    pub mqtt_running: bool,
    pub mqtt_connected: bool,
    pub broker_url_masked: Option<String>,
    pub last_heartbeat_at: Option<String>,
    pub last_command_no: Option<String>,
    pub outbox_size: usize,
    pub outbox_max: usize,
    pub outbox_usage: f64,
    pub next_retry_at: Option<String>,
    pub last_error: Option<String>,
    pub tls_auth_status: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn outbox_kind_uses_snake_case() {
        let value = serde_json::to_string(&OutboxKind::CommandAck).expect("serialize outbox kind");
        assert_eq!(value, "\"command_ack\"");
    }

    #[test]
    fn transaction_snapshot_uses_camel_case_fields() {
        let snapshot = TransactionSnapshot {
            order_no: Some("ORD-001".to_string()),
            status: Some(OrderSessionStatus::WaitingPayment),
            next_action: Some("submit_payment".to_string()),
            updated_at: "2025-01-01T00:00:00.000Z".to_string(),
        };
        let value = serde_json::to_string(&snapshot).expect("serialize snapshot");
        assert_eq!(
            value,
            r#"{"orderNo":"ORD-001","status":"waiting_payment","nextAction":"submit_payment","updatedAt":"2025-01-01T00:00:00.000Z"}"#
        );
    }

    #[test]
    fn current_transaction_snapshot_uses_payment_url_and_hides_sensitive_fields() {
        let snapshot = CurrentTransactionSnapshot {
            order_id: Some("ORDER-ID".to_string()),
            order_no: Some("ORDER-001".to_string()),
            product_summary: Some(serde_json::json!({"name":"cola"})),
            payment_no: Some("PAY-1".to_string()),
            payment_method: Some("payment_code".to_string()),
            payment_provider: Some("mock".to_string()),
            payment_url: Some("https://pay.example/order/ORDER-001".to_string()),
            payment_status: Some("pending".to_string()),
            order_status: Some("waiting_payment".to_string()),
            total_amount_cents: Some(1000),
            vending: Some(VendingCommandSummary {
                command_no: Some("CMD-1".to_string()),
                status: Some("created".to_string()),
                last_error: None,
                pickup_reminder: None,
            }),
            next_action: Some("submit_payment".to_string()),
            masked_auth_code: Some("6212****3456".to_string()),
            payment_code_attempt: Some(PaymentCodeAttemptSummary {
                attempt_no: Some(1),
                status: Some("failed".to_string()),
                masked_auth_code: Some("6212****3456".to_string()),
                source: Some("serial_text".to_string()),
                idempotency_key: Some("ORDER-001:attempt-1".to_string()),
                submitted_at: None,
                last_checked_at: None,
                can_retry: true,
                message: Some("请刷新付款码后重试".to_string()),
            }),
            expires_at: Some("2025-01-01T00:00:00.000Z".to_string()),
            error_code: None,
            error_message: None,
            operator_hint: None,
            updated_at: "2025-01-01T00:00:00.000Z".to_string(),
        };
        let value = serde_json::to_string(&snapshot).expect("serialize snapshot");
        assert!(value.contains("\"paymentUrl\""));
        assert!(value.contains("\"paymentStatus\""));
        assert!(value.contains("\"paymentCodeAttempt\""));
        assert!(value.contains("\"maskedAuthCode\":\"6212****3456\""));
        assert!(!value.contains("\"authCode\""));
        assert!(!value.contains("machineSecret"));
        assert!(!value.contains("mqttSigningSecret"));
        assert!(!value.contains("mqttPassword"));
    }
}
