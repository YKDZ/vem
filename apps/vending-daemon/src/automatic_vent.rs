use std::{
    sync::Arc,
    time::{Duration, Instant},
};

use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use crate::hardware::HardwareSupervisor;

const AUTOMATIC_VENT_GUARD: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AutomaticVentRequestOutcome {
    Accepted,
    Deduplicated,
    Closed,
}

#[derive(Default)]
struct AutomaticVentState {
    closed: bool,
    worker_running: bool,
    admin_superseded: bool,
    pending_speed: Option<u8>,
    executing_speed: Option<u8>,
    confirmed_speed: Option<u8>,
    last_attempt_at: Option<Instant>,
    last_error: Option<String>,
}

#[derive(Clone)]
pub struct AutomaticVentController {
    hardware: HardwareSupervisor,
    shutdown: CancellationToken,
    guard: Duration,
    state: Arc<Mutex<AutomaticVentState>>,
}

impl AutomaticVentController {
    pub fn new(hardware: HardwareSupervisor, shutdown: CancellationToken) -> Self {
        Self::new_with_guard(hardware, shutdown, AUTOMATIC_VENT_GUARD)
    }

    pub(crate) fn new_with_guard(
        hardware: HardwareSupervisor,
        shutdown: CancellationToken,
        guard: Duration,
    ) -> Self {
        Self {
            hardware,
            shutdown,
            guard,
            state: Arc::new(Mutex::new(AutomaticVentState::default())),
        }
    }

    pub async fn request(&self, speed: u8) -> Result<AutomaticVentRequestOutcome, String> {
        if speed > 4 {
            return Err("automatic vent speed must be between 0 and 4".to_string());
        }
        let mut state = self.state.lock().await;
        if state.closed || self.shutdown.is_cancelled() {
            state.closed = true;
            return Ok(AutomaticVentRequestOutcome::Closed);
        }
        // An arrival/departure edge is the only event that can re-arm automatic
        // control after Admin has issued a one-shot B3 command.
        state.admin_superseded = false;
        if state.confirmed_speed == Some(speed)
            && state.pending_speed.is_none()
            && state.executing_speed.is_none()
        {
            return Ok(AutomaticVentRequestOutcome::Deduplicated);
        }
        state.pending_speed = Some(speed);
        if !state.worker_running {
            state.worker_running = true;
            let controller = self.clone();
            tokio::spawn(async move { controller.run().await });
        }
        Ok(AutomaticVentRequestOutcome::Accepted)
    }

    pub async fn supersede_by_admin(&self) {
        let mut state = self.state.lock().await;
        state.pending_speed = None;
        state.admin_superseded = true;
    }

    pub async fn close(&self) {
        let mut state = self.state.lock().await;
        state.closed = true;
        state.pending_speed = None;
    }

    async fn run(self) {
        loop {
            let guard_wait = {
                let mut state = self.state.lock().await;
                if state.closed || self.shutdown.is_cancelled() {
                    None
                } else if state.pending_speed.is_none() || state.admin_superseded {
                    state.worker_running = false;
                    None
                } else {
                    Some(
                        state
                            .last_attempt_at
                            .map(|last| self.guard.saturating_sub(last.elapsed()))
                            .unwrap_or(Duration::ZERO),
                    )
                }
            };
            let Some(guard_wait) = guard_wait else {
                self.finish_worker().await;
                return;
            };
            if guard_wait > Duration::ZERO {
                tokio::select! {
                    _ = self.shutdown.cancelled() => { self.close().await; self.finish_worker().await; return; }
                    _ = tokio::time::sleep(guard_wait) => {}
                }
            }

            // Taking lower-controller ownership before claiming the pending
            // speed makes dispense exclusion explicit while still allowing a
            // newer edge to replace the intent during the wait.
            let hardware = tokio::select! {
                _ = self.shutdown.cancelled() => { self.close().await; self.finish_worker().await; return; }
                hardware = self.hardware.acquire_environment_hardware() => hardware,
            };
            let speed = {
                let mut state = self.state.lock().await;
                if state.closed || state.admin_superseded || self.shutdown.is_cancelled() {
                    None
                } else {
                    let pending = state.pending_speed.take();
                    if pending == state.confirmed_speed {
                        None
                    } else {
                        state.executing_speed = pending;
                        pending
                    }
                }
            };
            let Some(speed) = speed else {
                drop(hardware);
                continue;
            };

            {
                let mut state = self.state.lock().await;
                state.last_attempt_at = Some(Instant::now());
            }
            let result = hardware.set_vent_speed(speed).await;
            drop(hardware);
            let mut state = self.state.lock().await;
            state.executing_speed = None;
            match result {
                Ok(()) => {
                    state.confirmed_speed = Some(speed);
                    state.last_error = None;
                }
                Err(error) => state.last_error = Some(error),
            }
        }
    }

    async fn finish_worker(&self) {
        self.state.lock().await.worker_running = false;
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use async_trait::async_trait;
    use tokio_util::sync::CancellationToken;
    use vending_core::hardware::{
        DispenseCommandPayload, DispenseResultPayload, HardwareAdapter, HardwareStatus,
    };

    use crate::hardware::HardwareSupervisor;

    use super::AutomaticVentController;

    #[derive(Default)]
    struct RecordingHardware {
        vent_speeds: Mutex<Vec<u8>>,
    }

    #[async_trait]
    impl HardwareAdapter for RecordingHardware {
        fn adapter_name(&self) -> &str {
            "recording"
        }

        async fn self_check(&self) -> HardwareStatus {
            HardwareStatus {
                adapter: "recording".to_string(),
                online: true,
                message: "ready".to_string(),
                port_path: None,
                resolution_source: None,
                bound_usb_identity: None,
                candidates: vec![],
                lower_controller_fault: None,
            }
        }

        async fn set_vent_speed(&self, speed: u8) -> Result<(), String> {
            self.vent_speeds.lock().expect("speeds").push(speed);
            Ok(())
        }

        async fn dispense(&self, command: DispenseCommandPayload) -> DispenseResultPayload {
            DispenseResultPayload {
                command_no: command.command_no,
                success: true,
                error_code: None,
                message: "unused".to_string(),
                reported_at: "now".to_string(),
                lower_controller_fault: None,
            }
        }
    }

    #[tokio::test]
    async fn keeps_only_the_latest_pending_speed_and_deduplicates_the_confirmed_speed() {
        let adapter = Arc::new(RecordingHardware::default());
        let controller = AutomaticVentController::new_with_guard(
            HardwareSupervisor::from_adapter(adapter.clone()),
            CancellationToken::new(),
            std::time::Duration::from_millis(25),
        );

        controller.request(2).await.expect("arrival request");
        controller.request(0).await.expect("departure request");
        tokio::time::sleep(std::time::Duration::from_millis(80)).await;
        controller
            .request(0)
            .await
            .expect("duplicate departure request");
        tokio::time::sleep(std::time::Duration::from_millis(40)).await;

        assert_eq!(*adapter.vent_speeds.lock().expect("speeds"), vec![0]);
    }

    #[tokio::test]
    async fn admin_supersession_drops_the_current_automatic_intent_until_the_next_edge() {
        let adapter = Arc::new(RecordingHardware::default());
        let controller = AutomaticVentController::new_with_guard(
            HardwareSupervisor::from_adapter(adapter.clone()),
            CancellationToken::new(),
            std::time::Duration::from_millis(1),
        );

        controller.request(2).await.expect("arrival request");
        controller.supersede_by_admin().await;
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        assert!(adapter.vent_speeds.lock().expect("speeds").is_empty());

        controller.request(0).await.expect("next stable edge");
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        assert_eq!(*adapter.vent_speeds.lock().expect("speeds"), vec![0]);
    }
}
