use daemon_ipc_contracts::ScannerRuntimeStatus;

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
    SaleStartCapabilityChanged {
        event_id: String,
        updated_at: String,
        generation: String,
        revision: u64,
    },
    /// A durable state transition changed one of the inputs to sale-start
    /// capability. The cache worker is the sole coordinator that recomputes
    /// and publishes the resulting snapshot.
    SaleStartCapabilityInvalidated {
        event_id: String,
        updated_at: String,
        reason: String,
    },
    ScannerHealthChanged {
        event_id: String,
        updated_at: String,
        snapshot: ScannerRuntimeStatus,
    },
    ScannerCode {
        event_id: String,
        updated_at: String,
        masked_code: String,
        source: String,
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
        latest_diagnostic_payload: Option<serde_json::Value>,
    },
    RuntimeReconfigureRequested {
        event_id: String,
        updated_at: String,
        reason: String,
        machine_code: Option<String>,
    },
    RemoteOpResult {
        event_id: String,
        updated_at: String,
        op_id: String,
        status: String,
    },
}

pub fn scanner_runtime_status_contract(
    snapshot: &vending_core::scanner::ScannerHealthSnapshot,
) -> ScannerRuntimeStatus {
    ScannerRuntimeStatus {
        adapter: snapshot.adapter.clone(),
        code: snapshot.code.clone(),
        level: match &snapshot.level {
            vending_core::health::HealthLevel::Ok => "ok",
            vending_core::health::HealthLevel::Degraded => "degraded",
            vending_core::health::HealthLevel::Offline => "offline",
            vending_core::health::HealthLevel::Error => "error",
        }
        .to_string(),
        message: snapshot.message.clone(),
        online: snapshot.online,
        port: snapshot.port.clone(),
        updated_at: snapshot.updated_at.clone(),
    }
}

pub fn scanner_health_snapshot_from_contract(
    snapshot: ScannerRuntimeStatus,
) -> vending_core::scanner::ScannerHealthSnapshot {
    vending_core::scanner::ScannerHealthSnapshot {
        online: snapshot.online,
        adapter: snapshot.adapter,
        port: snapshot.port,
        level: match snapshot.level.as_str() {
            "ok" => vending_core::health::HealthLevel::Ok,
            "degraded" => vending_core::health::HealthLevel::Degraded,
            "offline" => vending_core::health::HealthLevel::Offline,
            _ => vending_core::health::HealthLevel::Error,
        },
        code: snapshot.code,
        message: snapshot.message,
        updated_at: snapshot.updated_at,
    }
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
            source: "serial_text".to_string(),
            scanned_at_ms: 123,
        };
        let value = serde_json::to_string(&event).expect("serialize");
        assert!(!value.contains("authCode"));
        assert!(value.contains("maskedCode"));
        assert!(value.contains("serial_text"));
        assert!(value.contains("scannedAtMs"));
    }

    #[test]
    fn scanner_health_changed_event_uses_generated_scanner_contract_payload() {
        let internal = vending_core::scanner::ScannerHealthSnapshot {
            online: true,
            adapter: vending_core::scanner::PAYMENT_CODE_SOURCE_SERIAL_TEXT.to_string(),
            port: Some("COM3".to_string()),
            level: vending_core::health::HealthLevel::Ok,
            code: "SCANNER_READY".to_string(),
            message: "scanner ready".to_string(),
            updated_at: "2026-01-01T00:00:00.000Z".to_string(),
        };
        let event = DaemonEvent::ScannerHealthChanged {
            event_id: "evt-scanner".to_string(),
            updated_at: internal.updated_at.clone(),
            snapshot: scanner_runtime_status_contract(&internal),
        };

        let value = serde_json::to_value(event).expect("event json");
        assert_eq!(value["type"], "scanner_health_changed");
        let snapshot: ScannerRuntimeStatus =
            serde_json::from_value(value["snapshot"].clone()).expect("generated scanner contract");
        assert_eq!(snapshot.code, "SCANNER_READY");
        assert_eq!(snapshot.level, "ok");
    }
}
