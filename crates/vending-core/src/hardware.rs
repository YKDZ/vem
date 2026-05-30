use async_trait::async_trait;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SlotPayload {
    pub layer_no: u32,
    pub cell_no: u32,
    pub slot_code: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DispenseCommandPayload {
    pub command_no: String,
    pub order_no: String,
    pub slot: SlotPayload,
    pub quantity: u32,
    pub timeout_seconds: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DispenseResultPayload {
    pub command_no: String,
    pub success: bool,
    pub error_code: Option<String>,
    pub message: String,
    pub reported_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HardwareStatus {
    pub adapter: String,
    pub online: bool,
    pub message: String,
}

#[async_trait]
pub trait HardwareAdapter: Send + Sync {
    fn adapter_name(&self) -> &str;
    async fn self_check(&self) -> HardwareStatus;
    async fn dispense(&self, cmd: DispenseCommandPayload) -> DispenseResultPayload;
}

#[derive(Debug, Default)]
pub struct MockHardwareAdapter;

#[async_trait]
impl HardwareAdapter for MockHardwareAdapter {
    fn adapter_name(&self) -> &str {
        "mock"
    }

    async fn self_check(&self) -> HardwareStatus {
        HardwareStatus {
            adapter: "mock".to_string(),
            online: true,
            message: "mock adapter ready".to_string(),
        }
    }

    async fn dispense(&self, cmd: DispenseCommandPayload) -> DispenseResultPayload {
        DispenseResultPayload {
            command_no: cmd.command_no,
            success: true,
            error_code: None,
            message: "mock: dispense succeeded".to_string(),
            reported_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dispense_payload_is_snake_case_json() {
        let payload = DispenseCommandPayload {
            command_no: "cmd-1".to_string(),
            order_no: "ord-1".to_string(),
            slot: SlotPayload {
                layer_no: 1,
                cell_no: 2,
                slot_code: "A1".to_string(),
            },
            quantity: 1,
            timeout_seconds: 30,
        };
        let value = serde_json::to_value(&payload).expect("serialize payload");
        assert_eq!(value["commandNo"], "cmd-1");
        assert_eq!(value["orderNo"], "ord-1");
        assert_eq!(value["timeoutSeconds"], 30);
    }

    #[tokio::test]
    async fn mock_hardware_always_succeeds() {
        let adapter = MockHardwareAdapter;
        let payload = DispenseCommandPayload {
            command_no: "cmd-1".to_string(),
            order_no: "ord-1".to_string(),
            slot: SlotPayload {
                layer_no: 1,
                cell_no: 1,
                slot_code: "A1".to_string(),
            },
            quantity: 1,
            timeout_seconds: 30,
        };
        let result = adapter.dispense(payload).await;
        assert!(result.success);
        assert!(result.error_code.is_none());
    }
}
