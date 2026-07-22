use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::serial::{EnvironmentSample, LowerControllerDiscoveryCandidate, SerialPortUsbIdentity};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SlotPayload {
    pub row_no: u32,
    pub cell_no: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
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
    /// Internal protocol classification. The externally published error code stays stable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lower_controller_fault: Option<LowerControllerFault>,
}

/// A lower-controller fault that explicitly identifies shared hardware.
///
/// Transport failures and command timeouts deliberately do not appear here: they
/// are current readiness evidence rather than a persistent maintenance lock.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LowerControllerFault {
    SharedMechanical,
    PickupPlatformBlocked,
}

impl LowerControllerFault {
    pub const fn requires_whole_machine_lock(self) -> bool {
        true
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DispenseProgressStage {
    OutletOpened,
    PickupWaiting,
    PickupCompleted,
    PickupTimeoutWarning,
    ResetCompleted,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DispenseProgressEvent {
    pub command_no: String,
    pub order_no: String,
    pub stage: DispenseProgressStage,
    pub warning_no: Option<u8>,
    pub message: String,
    pub reported_at: String,
}

pub type DispenseProgressObserver = Arc<dyn Fn(DispenseProgressEvent) + Send + Sync>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentControlCommandPayload {
    pub command_no: String,
    pub air_conditioner_on: Option<bool>,
    pub target_temperature_celsius: Option<i8>,
    pub vent_speed: Option<u8>,
    pub timeout_seconds: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentControlResultPayload {
    pub command_no: String,
    pub success: bool,
    pub error_code: Option<String>,
    pub message: Option<String>,
    pub air_conditioner_on: Option<bool>,
    pub target_temperature_celsius: Option<i8>,
    pub vent_speed: Option<u8>,
    pub reported_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HardwareStatus {
    pub adapter: String,
    pub online: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolution_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bound_usb_identity: Option<SerialPortUsbIdentity>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub candidates: Vec<LowerControllerDiscoveryCandidate>,
    /// Internal classification of an explicit lower-controller status fault.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lower_controller_fault: Option<LowerControllerFault>,
}

#[async_trait]
pub trait HardwareAdapter: Send + Sync {
    fn adapter_name(&self) -> &str;
    fn schedule_next_dispense_fault_injection(&self) -> Result<(), String> {
        Err(format!(
            "{} hardware adapter does not support lower-controller fault injection",
            self.adapter_name()
        ))
    }
    async fn self_check(&self) -> HardwareStatus;
    async fn query_environment_sample(&self) -> Result<Option<EnvironmentSample>, String> {
        Ok(None)
    }
    async fn set_target_temperature(&self, _temperature_celsius: i8) -> Result<(), String> {
        Err("target temperature control is not supported by this hardware adapter".to_string())
    }
    async fn set_air_conditioner_enabled(&self, _enabled: bool) -> Result<(), String> {
        Err("air conditioner control is not supported by this hardware adapter".to_string())
    }
    async fn set_vent_speed(&self, _speed: u8) -> Result<(), String> {
        Err("vent speed control is not supported by this hardware adapter".to_string())
    }
    async fn dispense(&self, cmd: DispenseCommandPayload) -> DispenseResultPayload;
    async fn dispense_with_progress(
        &self,
        cmd: DispenseCommandPayload,
        _progress: Option<DispenseProgressObserver>,
    ) -> DispenseResultPayload {
        self.dispense(cmd).await
    }
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
            port_path: None,
            resolution_source: Some("mock".to_string()),
            bound_usb_identity: None,
            candidates: vec![],
            lower_controller_fault: None,
        }
    }

    async fn query_environment_sample(&self) -> Result<Option<EnvironmentSample>, String> {
        Ok(Some(EnvironmentSample {
            temperature_celsius: 24,
            relative_humidity_percent: 50,
        }))
    }

    async fn set_target_temperature(&self, _temperature_celsius: i8) -> Result<(), String> {
        Ok(())
    }

    async fn set_air_conditioner_enabled(&self, _enabled: bool) -> Result<(), String> {
        Ok(())
    }

    async fn set_vent_speed(&self, _speed: u8) -> Result<(), String> {
        Ok(())
    }

    async fn dispense(&self, cmd: DispenseCommandPayload) -> DispenseResultPayload {
        DispenseResultPayload {
            command_no: cmd.command_no,
            success: true,
            error_code: None,
            message: "mock: dispense succeeded".to_string(),
            reported_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            lower_controller_fault: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dispense_payload_uses_coordinate_only_json() {
        let payload = DispenseCommandPayload {
            command_no: "cmd-1".to_string(),
            order_no: "ord-1".to_string(),
            slot: SlotPayload {
                row_no: 1,
                cell_no: 2,
            },
            quantity: 1,
            timeout_seconds: 30,
        };
        let value = serde_json::to_value(&payload).expect("serialize payload");
        assert_eq!(value["commandNo"], "cmd-1");
        assert_eq!(value["orderNo"], "ord-1");
        assert_eq!(value["timeoutSeconds"], 30);
        assert_eq!(
            value["slot"],
            serde_json::json!({ "rowNo": 1, "cellNo": 2 })
        );
    }

    #[test]
    fn legacy_slot_id_is_rejected_from_dispense_payload() {
        let error = serde_json::from_value::<DispenseCommandPayload>(serde_json::json!({
            "commandNo": "cmd-1",
            "orderNo": "ord-1",
            "slot": { "rowNo": 1, "cellNo": 2, "slotId": "legacy-business-id" },
            "quantity": 1,
            "timeoutSeconds": 30,
        }))
        .expect_err("strict command contract rejects legacy slotId");

        assert!(error.to_string().contains("slotId"));
    }

    #[tokio::test]
    async fn mock_hardware_always_succeeds() {
        let adapter = MockHardwareAdapter;
        let payload = DispenseCommandPayload {
            command_no: "cmd-1".to_string(),
            order_no: "ord-1".to_string(),
            slot: SlotPayload {
                row_no: 1,
                cell_no: 1,
            },
            quantity: 1,
            timeout_seconds: 30,
        };
        let result = adapter.dispense(payload).await;
        assert!(result.success);
        assert!(result.error_code.is_none());
    }

    #[tokio::test]
    async fn mock_hardware_reports_stable_environment_sample() {
        let adapter = MockHardwareAdapter;

        let sample = adapter
            .query_environment_sample()
            .await
            .expect("mock environment query")
            .expect("mock sample");

        assert_eq!(sample.temperature_celsius, 24);
        assert_eq!(sample.relative_humidity_percent, 50);
    }
}
