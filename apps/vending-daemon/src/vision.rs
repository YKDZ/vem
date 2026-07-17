#[derive(Debug, Clone)]
pub struct VisionRuntimeSnapshot {
    pub enabled: bool,
    pub online: bool,
    pub message: String,
    pub latest_diagnostic_payload: Option<serde_json::Value>,
}

impl VisionRuntimeSnapshot {
    pub fn disabled() -> Self {
        Self {
            enabled: false,
            online: false,
            message: "disabled".to_string(),
            latest_diagnostic_payload: Some(serde_json::json!({
                "type": "vision.disabled",
                "payload": {
                    "message": "disabled"
                }
            })),
        }
    }

    pub fn from_ready(payload: vending_core::vision::VisionReadyPayload) -> Self {
        let latest_diagnostic_payload = serde_json::to_value(&payload).ok().map(|payload| {
            serde_json::json!({
                "type": "vision.ready",
                "payload": payload
            })
        });
        Self {
            enabled: true,
            online: true,
            message: format!(
                "{} {}",
                if payload.camera_ready {
                    "camera_ready"
                } else {
                    "camera_not_ready"
                },
                if payload.model_ready {
                    "model_ready"
                } else {
                    "model_not_ready"
                },
            )
            .trim_end()
            .to_string(),
            latest_diagnostic_payload,
        }
    }

    pub fn failed(message: impl Into<String>) -> Self {
        let message = message.into();
        Self {
            enabled: true,
            online: false,
            message: message.clone(),
            latest_diagnostic_payload: Some(serde_json::json!({
                "type": "vision.error",
                "payload": {
                    "message": message
                }
            })),
        }
    }
}

pub struct VisionSupervisor {
    machine_code: Option<String>,
    endpoint: String,
    timeout_ms: u64,
}

impl VisionSupervisor {
    pub fn new(machine_code: Option<String>) -> Self {
        Self {
            machine_code,
            endpoint: vending_core::vision::DEFAULT_VISION_WS_URL.to_string(),
            timeout_ms: 8_000,
        }
    }

    #[cfg(test)]
    fn with_endpoint(machine_code: Option<String>, endpoint: String) -> Self {
        Self {
            machine_code,
            endpoint,
            timeout_ms: 8_000,
        }
    }

    pub async fn start(&self) -> Result<VisionRuntimeSnapshot, String> {
        self.check_ready().await
    }

    pub async fn check_ready(&self) -> Result<VisionRuntimeSnapshot, String> {
        let result = vending_core::vision::check_ready(
            &self.endpoint,
            self.machine_code.clone(),
            self.timeout_ms,
        )
        .await;

        match result {
            Ok(payload) => Ok(VisionRuntimeSnapshot::from_ready(payload)),
            Err(error) => Err(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn vision_connect_fails_when_no_server_is_running() {
        let vision = VisionSupervisor::with_endpoint(None, "ws://127.0.0.1:0/ws".to_string());
        assert!(vision.start().await.is_err());
    }
}
