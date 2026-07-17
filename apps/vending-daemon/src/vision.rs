use crate::config::EffectiveRuntimeConfig;

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
    config: EffectiveRuntimeConfig,
}

impl VisionSupervisor {
    pub fn new(config: EffectiveRuntimeConfig) -> Self {
        Self { config }
    }

    pub async fn start(&self) -> Result<VisionRuntimeSnapshot, String> {
        if !self.config.vision_enabled {
            return Ok(VisionRuntimeSnapshot::disabled());
        }
        self.check_ready().await
    }

    pub async fn check_ready(&self) -> Result<VisionRuntimeSnapshot, String> {
        let machine_code = self.config.machine_code.clone();
        let result = vending_core::vision::check_ready(
            &self.config.vision_ws_url,
            machine_code,
            self.config.vision_request_timeout_ms,
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
    async fn vision_disabled_does_not_block_ready() {
        let config = crate::config::EffectiveRuntimeConfig {
            vision_enabled: false,
            ..crate::config::default_public_config()
        };
        let vision = VisionSupervisor::new(config);
        let snapshot = vision.start().await.expect("start");
        assert!(!snapshot.enabled);
        assert!(!snapshot.online);
        assert_eq!(snapshot.message, "disabled");
    }

    #[tokio::test]
    async fn vision_connect_fails_when_no_server_is_running() {
        let config = crate::config::EffectiveRuntimeConfig {
            vision_enabled: true,
            vision_ws_url: "ws://127.0.0.1:0/ws".to_string(),
            ..crate::config::default_public_config()
        };
        let vision = VisionSupervisor::new(config);
        assert!(vision.start().await.is_err());
    }
}
