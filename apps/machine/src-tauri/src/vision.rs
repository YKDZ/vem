use serde::Serialize;

pub use vending_core::vision::{check_ready, VisionReadyPayload, DEFAULT_VISION_WS_URL};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VisionSelfCheckResult {
    pub enabled: bool,
    pub online: bool,
    pub message: String,
    pub checked_at_ms: u128,
    pub ready: Option<VisionReadyPayload>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VisionRuntimeStatus {
    pub running: bool,
    pub pid: Option<u32>,
    pub message: String,
}
