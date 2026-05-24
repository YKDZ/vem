use async_trait::async_trait;
use serde::{Deserialize, Serialize};

/// Input payload sent from the cloud to trigger a dispense.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlotPayload {
    pub layer_no: u32,
    pub cell_no: u32,
    pub slot_code: String,
}

/// Input payload sent from the cloud to trigger a dispense.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DispenseCommandPayload {
    pub command_no: String,
    pub order_no: String,
    pub slot: SlotPayload,
    pub quantity: u32,
    pub timeout_seconds: u64,
}

/// Result reported back to the cloud after a dispense attempt.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DispenseResultPayload {
    pub command_no: String,
    pub success: bool,
    pub error_code: Option<String>,
    pub message: String,
    pub reported_at: String,
}

#[derive(Debug, Clone, Serialize)]
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

// ─── Mock adapter ────────────────────────────────────────────────────────────

pub struct MockHardwareAdapter;

#[async_trait]
impl HardwareAdapter for MockHardwareAdapter {
    fn adapter_name(&self) -> &str {
        "mock"
    }

    async fn self_check(&self) -> HardwareStatus {
        HardwareStatus {
            adapter: "mock".into(),
            online: true,
            message: "mock adapter ready".into(),
        }
    }

    async fn dispense(&self, cmd: DispenseCommandPayload) -> DispenseResultPayload {
        let reported_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        // Mock always succeeds
        DispenseResultPayload {
            command_no: cmd.command_no,
            success: true,
            error_code: None,
            message: "mock: dispense succeeded".to_string(),
            reported_at,
        }
    }
}
