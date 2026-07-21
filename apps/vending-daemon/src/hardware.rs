use std::{
    path::PathBuf,
    sync::{Arc, RwLock},
};

use vending_core::{
    hardware::DispenseCommandPayload, hardware::DispenseProgressObserver,
    hardware::HardwareAdapter, serial::EnvironmentSample,
};

#[derive(Clone)]
pub struct HardwareSupervisor {
    adapter: Arc<RwLock<Arc<dyn HardwareAdapter>>>,
    lower_controller: Arc<tokio::sync::Mutex<()>>,
}

pub(crate) struct EnvironmentHardwareOwnership {
    adapter: Arc<dyn HardwareAdapter>,
    _guard: tokio::sync::OwnedMutexGuard<()>,
}

impl EnvironmentHardwareOwnership {
    pub async fn set_target_temperature(&self, value: i8) -> Result<(), String> {
        self.adapter.set_target_temperature(value).await
    }

    pub async fn set_air_conditioner_enabled(&self, value: bool) -> Result<(), String> {
        self.adapter.set_air_conditioner_enabled(value).await
    }

    pub async fn set_vent_speed(&self, value: u8) -> Result<(), String> {
        self.adapter.set_vent_speed(value).await
    }
}

impl HardwareSupervisor {
    pub fn from_adapter(adapter: Arc<dyn HardwareAdapter>) -> Self {
        Self {
            adapter: Arc::new(RwLock::new(adapter)),
            lower_controller: Arc::new(tokio::sync::Mutex::new(())),
        }
    }

    /// A controller receives its current Windows address only after its
    /// persisted stable binding has been resolved from live discovery.
    pub fn from_serial_port(
        port_path: Option<String>,
        protocol_log_path: Option<PathBuf>,
    ) -> Result<Self, String> {
        Ok(Self::from_adapter(Self::build_serial_adapter(
            port_path,
            protocol_log_path,
        )))
    }

    fn build_serial_adapter(
        port_path: Option<String>,
        protocol_log_path: Option<PathBuf>,
    ) -> Arc<dyn HardwareAdapter> {
        Arc::new(
            vending_core::serial::SerialHardwareAdapter::new_resolving_with_protocol_log(
                port_path,
                None,
                protocol_log_path,
            ),
        )
    }

    pub async fn reconfigure_from_serial_port(
        &self,
        port_path: Option<String>,
        protocol_log_path: Option<PathBuf>,
    ) -> Result<vending_core::hardware::HardwareStatus, String> {
        let _operation = self.lower_controller.lock().await;
        let replacement = Self::build_serial_adapter(port_path, protocol_log_path);
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
        let _operation = self.lower_controller.lock().await;
        let adapter = self.adapter.read().expect("hardware adapter lock").clone();
        adapter.self_check().await
    }

    pub async fn dispense(
        &self,
        command: DispenseCommandPayload,
    ) -> vending_core::hardware::DispenseResultPayload {
        let _operation = self.lower_controller.lock().await;
        let adapter = self.adapter.read().expect("hardware adapter lock").clone();
        adapter.dispense(command).await
    }

    pub async fn dispense_with_progress(
        &self,
        command: DispenseCommandPayload,
        progress: Option<DispenseProgressObserver>,
    ) -> vending_core::hardware::DispenseResultPayload {
        let _operation = self.lower_controller.lock().await;
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
        let _operation = self.lower_controller.lock().await;
        let adapter = self.adapter.read().expect("hardware adapter lock").clone();
        adapter.query_environment_sample().await
    }

    pub(crate) async fn acquire_environment_hardware(&self) -> EnvironmentHardwareOwnership {
        let guard = self.lower_controller.clone().lock_owned().await;
        let adapter = self.adapter.read().expect("hardware adapter lock").clone();
        EnvironmentHardwareOwnership {
            adapter,
            _guard: guard,
        }
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
            lower_controller_fault: None,
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
            lower_controller_fault: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn hardware_supervisor_reports_an_unresolved_serial_binding() {
        let supervisor = HardwareSupervisor::from_serial_port(None, None).expect("supervisor");
        let status = supervisor.self_check().await;
        assert_eq!(status.adapter, "serial");
        assert!(!status.online);
    }

    #[tokio::test]
    async fn role_reconfigure_replaces_the_shared_adapter_without_restarting_its_owner() {
        let supervisor =
            HardwareSupervisor::from_adapter(Arc::new(vending_core::hardware::MockHardwareAdapter));
        let observer = supervisor.clone();

        let error = supervisor
            .reconfigure_from_serial_port(Some("/dev/vem-missing-controller".to_string()), None)
            .await
            .expect_err("failed self-check must not replace the active adapter");

        assert!(error.contains("self-check failed"));
        assert_eq!(observer.adapter_name(), "mock");
    }
}
