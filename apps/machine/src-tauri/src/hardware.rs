use async_trait::async_trait;
use serde::{Deserialize, Serialize};

/// Input payload sent from the cloud to trigger a dispense.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DispenseCommandPayload {
    pub command_id: String,
    pub order_id: String,
    pub order_no: String,
    pub layer_no: u32,
    pub cell_no: u32,
    pub motor_timeout_ms: u64,
    pub issued_at: String,
}

/// Result reported back to the cloud after a dispense attempt.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DispenseResultPayload {
    pub command_id: String,
    pub order_id: String,
    pub success: bool,
    pub error_code: Option<String>,
    pub completed_at: String,
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
        let completed_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        // Mock always succeeds
        DispenseResultPayload {
            command_id: cmd.command_id,
            order_id: cmd.order_id,
            success: true,
            error_code: None,
            completed_at,
        }
    }
}
