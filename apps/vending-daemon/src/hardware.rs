use std::sync::Arc;

use vending_core::{
    hardware::DispenseCommandPayload, hardware::HardwareAdapter, serial::EnvironmentSample,
};

use crate::config::{HardwareAdapterKind, MachinePublicConfig};

#[derive(Clone)]
pub struct HardwareSupervisor {
    adapter: Arc<dyn HardwareAdapter>,
}

impl HardwareSupervisor {
    pub fn from_adapter(adapter: Arc<dyn HardwareAdapter>) -> Self {
        Self { adapter }
    }

    pub fn from_config(config: &MachinePublicConfig) -> Result<Self, String> {
        let adapter: Arc<dyn HardwareAdapter> = match config.hardware_adapter {
            HardwareAdapterKind::Mock => Arc::new(vending_core::hardware::MockHardwareAdapter),
            HardwareAdapterKind::Serial => {
                Arc::new(vending_core::serial::SerialHardwareAdapter::new_resolving(
                    config.serial_port_path.clone(),
                    config.lower_controller_usb_identity.clone(),
                ))
            }
            HardwareAdapterKind::Bluetooth => {
                return Err("bluetooth hardware adapter is not implemented".to_string());
            }
            HardwareAdapterKind::VendorSdk => {
                return Err("vendor_sdk hardware adapter is not implemented".to_string());
            }
        };

        Ok(Self { adapter })
    }

    pub async fn self_check(&self) -> vending_core::hardware::HardwareStatus {
        self.adapter.self_check().await
    }

    pub async fn dispense(
        &self,
        command: DispenseCommandPayload,
    ) -> vending_core::hardware::DispenseResultPayload {
        self.adapter.dispense(command).await
    }

    pub async fn query_environment_sample(&self) -> Result<Option<EnvironmentSample>, String> {
        self.adapter.query_environment_sample().await
    }

    pub async fn set_target_temperature(&self, temperature_celsius: i8) -> Result<(), String> {
        self.adapter
            .set_target_temperature(temperature_celsius)
            .await
    }

    pub async fn set_air_conditioner_enabled(&self, enabled: bool) -> Result<(), String> {
        self.adapter.set_air_conditioner_enabled(enabled).await
    }

    pub fn adapter_name(&self) -> &str {
        self.adapter.adapter_name()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn hardware_supervisor_uses_mock_by_default() {
        let config = crate::config::default_public_config();
        let supervisor = HardwareSupervisor::from_config(&config).expect("supervisor");
        let status = supervisor.self_check().await;
        assert_eq!(status.adapter, "mock");
        assert!(status.online);

        let cmd = vending_core::hardware::DispenseCommandPayload {
            command_no: "cmd-1".to_string(),
            order_no: "ord-1".to_string(),
            slot: vending_core::hardware::SlotPayload {
                layer_no: 1,
                cell_no: 1,
                slot_code: "A1".to_string(),
            },
            quantity: 1,
            timeout_seconds: 10,
        };
        let result = supervisor.dispense(cmd).await;
        assert!(result.success);
    }
}
