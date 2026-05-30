use crate::config::MachinePublicConfig;
use std::process::Stdio;

#[derive(Debug, Clone)]
pub struct VisionRuntimeSnapshot {
    pub enabled: bool,
    pub online: bool,
    pub message: String,
}

impl VisionRuntimeSnapshot {
    pub fn disabled() -> Self {
        Self {
            enabled: false,
            online: false,
            message: "disabled".to_string(),
        }
    }

    pub fn from_ready(payload: vending_core::vision::VisionReadyPayload) -> Self {
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
        }
    }

    pub fn failed(message: impl Into<String>) -> Self {
        Self {
            enabled: true,
            online: false,
            message: message.into(),
        }
    }
}

pub struct VisionSupervisor {
    config: MachinePublicConfig,
    child: tokio::sync::Mutex<Option<tokio::process::Child>>,
}

impl VisionSupervisor {
    pub fn new(config: MachinePublicConfig) -> Self {
        Self {
            config,
            child: tokio::sync::Mutex::new(None),
        }
    }

    pub async fn start(&self) -> Result<VisionRuntimeSnapshot, String> {
        if !self.config.vision_enabled {
            return Ok(VisionRuntimeSnapshot::disabled());
        }

        if self.config.vision_auto_start {
            self.start_process_if_needed().await?;
        }
        self.check_ready().await
    }

    async fn start_process_if_needed(&self) -> Result<(), String> {
        let mut lock = self.child.lock().await;
        if lock.is_some() {
            return Ok(());
        }

        let cmd = self.config.vision_process_command.as_ref().ok_or_else(|| {
            "visionProcessCommand is required when visionAutoStart=true".to_string()
        })?;
        let mut parts = cmd.split_whitespace();
        let program = parts
            .next()
            .ok_or_else(|| "empty vision command".to_string())?;
        let args: Vec<&str> = parts.collect();

        let mut command = tokio::process::Command::new(program);
        if !args.is_empty() {
            command.args(args);
        }
        if let Some(extra) = self.config.vision_process_args.as_deref() {
            if !extra.trim().is_empty() {
                command.args(extra.split_whitespace());
            }
        }
        command
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::null());
        let child = command
            .spawn()
            .map_err(|error| format!("start vision process failed: {error}"))?;
        *lock = Some(child);
        Ok(())
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

    pub async fn stop_process(&self) -> Result<(), String> {
        let mut lock = self.child.lock().await;
        if let Some(mut child) = lock.take() {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn vision_disabled_does_not_block_ready() {
        let config = crate::config::MachinePublicConfig {
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
    async fn vision_process_exit_is_reported() {
        let config = crate::config::MachinePublicConfig {
            vision_enabled: true,
            vision_auto_start: false,
            vision_ws_url: "ws://127.0.0.1:0/ws".to_string(),
            ..crate::config::default_public_config()
        };
        let vision = VisionSupervisor::new(config);
        let _ = &vision;
        assert!(vision.start().await.is_err());
    }
}
