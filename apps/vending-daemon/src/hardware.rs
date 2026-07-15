use std::{
    path::PathBuf,
    sync::{Arc, RwLock},
};

use vending_core::{
    hardware::DispenseCommandPayload, hardware::DispenseProgressObserver,
    hardware::HardwareAdapter, serial::EnvironmentSample,
};

use crate::config::{HardwareAdapterKind, MachinePublicConfig};

#[derive(Clone)]
pub struct HardwareSupervisor {
    adapter: Arc<RwLock<Arc<dyn HardwareAdapter>>>,
}

impl HardwareSupervisor {
    pub fn from_adapter(adapter: Arc<dyn HardwareAdapter>) -> Self {
        Self {
            adapter: Arc::new(RwLock::new(adapter)),
        }
    }

    pub fn from_config(config: &MachinePublicConfig) -> Result<Self, String> {
        Self::from_config_with_protocol_log(config, None)
    }

    pub fn from_config_with_protocol_log(
        config: &MachinePublicConfig,
        protocol_log_path: Option<PathBuf>,
    ) -> Result<Self, String> {
        let adapter = Self::build_adapter(config, protocol_log_path)?;

        Ok(Self::from_adapter(adapter))
    }

    fn build_adapter(
        config: &MachinePublicConfig,
        protocol_log_path: Option<PathBuf>,
    ) -> Result<Arc<dyn HardwareAdapter>, String> {
        let adapter: Arc<dyn HardwareAdapter> = match config.hardware_adapter {
            HardwareAdapterKind::Mock => Arc::new(vending_core::hardware::MockHardwareAdapter),
            HardwareAdapterKind::Serial => Arc::new(
                vending_core::serial::SerialHardwareAdapter::new_resolving_with_protocol_log(
                    config.serial_port_path.clone(),
                    config.lower_controller_usb_identity.clone(),
                    protocol_log_path,
                ),
            ),
            HardwareAdapterKind::Bluetooth => {
                return Err("bluetooth hardware adapter is not implemented".to_string());
            }
            HardwareAdapterKind::VendorSdk => {
                return Err("vendor_sdk hardware adapter is not implemented".to_string());
            }
        };

        Ok(adapter)
    }

    pub async fn reconfigure_from_config(
        &self,
        config: &MachinePublicConfig,
        protocol_log_path: Option<PathBuf>,
    ) -> Result<vending_core::hardware::HardwareStatus, String> {
        let replacement = Self::build_adapter(config, protocol_log_path)?;
        let status = replacement.self_check().await;
        if !status.online {
            return Err(format!(
                "replacement hardware adapter self-check failed: {}",
                status.message
            ));
        }
        *self
            .adapter
            .write()
            .map_err(|_| "hardware adapter lock poisoned".to_string())? = replacement;
        Ok(status)
    }

    pub fn deactivate_bound_adapter(&self, message: impl Into<String>) -> Result<(), String> {
        *self
            .adapter
            .write()
            .map_err(|_| "hardware adapter lock poisoned".to_string())? =
            Arc::new(UnavailableHardwareAdapter {
                message: message.into(),
            });
        Ok(())
    }

    pub async fn self_check(&self) -> vending_core::hardware::HardwareStatus {
        let adapter = self.adapter.read().expect("hardware adapter lock").clone();
        adapter.self_check().await
    }

    pub async fn dispense(
        &self,
        command: DispenseCommandPayload,
    ) -> vending_core::hardware::DispenseResultPayload {
        let adapter = self.adapter.read().expect("hardware adapter lock").clone();
        adapter.dispense(command).await
    }

    pub async fn dispense_with_progress(
        &self,
        command: DispenseCommandPayload,
        progress: Option<DispenseProgressObserver>,
    ) -> vending_core::hardware::DispenseResultPayload {
        let adapter = self.adapter.read().expect("hardware adapter lock").clone();
        adapter.dispense_with_progress(command, progress).await
    }

    pub fn schedule_next_dispense_fault_injection(&self) -> Result<(), String> {
        self.adapter
            .read()
            .expect("hardware adapter lock")
            .schedule_next_dispense_fault_injection()
    }

    pub async fn query_environment_sample(&self) -> Result<Option<EnvironmentSample>, String> {
        let adapter = self.adapter.read().expect("hardware adapter lock").clone();
        adapter.query_environment_sample().await
    }

    pub async fn set_target_temperature(&self, temperature_celsius: i8) -> Result<(), String> {
        let adapter = self.adapter.read().expect("hardware adapter lock").clone();
        adapter.set_target_temperature(temperature_celsius).await
    }

    pub async fn set_air_conditioner_enabled(&self, enabled: bool) -> Result<(), String> {
        let adapter = self.adapter.read().expect("hardware adapter lock").clone();
        adapter.set_air_conditioner_enabled(enabled).await
    }

    pub async fn set_vent_speed(&self, speed: u8) -> Result<(), String> {
        let adapter = self.adapter.read().expect("hardware adapter lock").clone();
        adapter.set_vent_speed(speed).await
    }

    pub fn adapter_name(&self) -> String {
        self.adapter
            .read()
            .expect("hardware adapter lock")
            .adapter_name()
            .to_string()
    }
}

struct UnavailableHardwareAdapter {
    message: String,
}

#[async_trait::async_trait]
impl HardwareAdapter for UnavailableHardwareAdapter {
    fn adapter_name(&self) -> &str {
        "serial"
    }

    async fn self_check(&self) -> vending_core::hardware::HardwareStatus {
        vending_core::hardware::HardwareStatus {
            adapter: "serial".to_string(),
            online: false,
            message: self.message.clone(),
            port_path: None,
            resolution_source: Some("stable_device_binding".to_string()),
            bound_usb_identity: None,
            candidates: vec![],
        }
    }

    async fn dispense(
        &self,
        command: vending_core::hardware::DispenseCommandPayload,
    ) -> vending_core::hardware::DispenseResultPayload {
        vending_core::hardware::DispenseResultPayload {
            command_no: command.command_no,
            success: false,
            error_code: Some("LOWER_CONTROLLER_BINDING_UNAVAILABLE".to_string()),
            message: self.message.clone(),
            reported_at: crate::state::store::now_iso(),
        }
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

    #[tokio::test]
    async fn role_reconfigure_replaces_the_shared_adapter_without_restarting_its_owner() {
        let supervisor = HardwareSupervisor::from_config(&crate::config::default_public_config())
            .expect("supervisor");
        let observer = supervisor.clone();
        let mut replacement = crate::config::default_public_config();
        replacement.hardware_adapter = HardwareAdapterKind::Serial;
        replacement.serial_port_path = Some("/dev/vem-missing-controller".to_string());
        replacement.lower_controller_usb_identity = None;

        let error = supervisor
            .reconfigure_from_config(&replacement, None)
            .await
            .expect_err("failed self-check must not replace the active adapter");

        assert!(error.contains("self-check failed"));
        assert_eq!(observer.adapter_name(), "mock");
    }
}
