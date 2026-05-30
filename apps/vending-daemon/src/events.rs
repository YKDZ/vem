#[derive(Debug, Clone, serde::Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum DaemonEvent {
    HealthChanged {
        event_id: String,
        updated_at: String,
        snapshot: vending_core::health::HealthSnapshot,
    },
    ReadyChanged {
        event_id: String,
        updated_at: String,
        snapshot: vending_core::health::ReadySnapshot,
    },
    ScannerCode {
        event_id: String,
        updated_at: String,
        masked_code: String,
        scanned_at_ms: u128,
    },
    TransactionChanged {
        event_id: String,
        updated_at: String,
        order_no: String,
        status: String,
    },
    MqttChanged {
        event_id: String,
        updated_at: String,
        connected: bool,
        last_error: Option<String>,
    },
    VisionChanged {
        event_id: String,
        updated_at: String,
        enabled: bool,
        online: bool,
        message: String,
    },
    RemoteOpResult {
        event_id: String,
        updated_at: String,
        op_id: String,
        status: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scanner_code_event_does_not_include_auth_code() {
        let event = DaemonEvent::ScannerCode {
            event_id: "evt-1".to_string(),
            updated_at: "2025-01-01T00:00:00.000Z".to_string(),
            masked_code: "6212****3456".to_string(),
            scanned_at_ms: 123,
        };
        let value = serde_json::to_string(&event).expect("serialize");
        assert!(!value.contains("authCode"));
        assert!(value.contains("maskedCode"));
        assert!(value.contains("scannedAtMs"));
    }
}
