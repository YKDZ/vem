use std::{
    collections::VecDeque,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use crate::{
    hardware::HardwareSupervisor,
    logs::{append_local_log, LocalLogEntry},
    state::LocalStateStore,
};

const AUTOMATIC_VENT_GUARD: Duration = Duration::from_secs(5);
const AUTOMATIC_VENT_EDGE_HISTORY_LIMIT: usize = 64;

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
    pending: Option<AutomaticVentIntent>,
    executing: Option<AutomaticVentIntent>,
    confirmed_speed: Option<u8>,
    last_attempt_at: Option<Instant>,
    last_error: Option<String>,
    seen_edge_ids: VecDeque<String>,
}

#[derive(Debug, Clone)]
struct AutomaticVentIntent {
    edge_id: String,
    speed: u8,
    force: bool,
}

#[derive(Clone)]
struct AutomaticVentEvidence {
    state: LocalStateStore,
    log_path: PathBuf,
}

#[derive(Clone)]
pub struct AutomaticVentController {
    hardware: HardwareSupervisor,
    shutdown: CancellationToken,
    guard: Duration,
    state: Arc<Mutex<AutomaticVentState>>,
    evidence: Option<AutomaticVentEvidence>,
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
            evidence: None,
        }
    }

    pub fn with_evidence(mut self, state: LocalStateStore, log_path: PathBuf) -> Self {
        self.evidence = Some(AutomaticVentEvidence { state, log_path });
        self
    }

    pub async fn request(
        &self,
        edge_id: &str,
        speed: u8,
    ) -> Result<AutomaticVentRequestOutcome, String> {
        self.enqueue(edge_id, speed, false).await
    }

    pub async fn close_for_lifecycle(
        &self,
        lifecycle_id: &str,
    ) -> Result<AutomaticVentRequestOutcome, String> {
        let outcome = self.enqueue(lifecycle_id, 0, true).await?;
        if outcome == AutomaticVentRequestOutcome::Accepted {
            self.wait_until_idle().await;
        }
        Ok(outcome)
    }

    pub async fn health_component(&self) -> vending_core::health::ComponentHealth {
        let state = self.state.lock().await;
        let (level, code, message) = match &state.last_error {
            Some(error) => (
                vending_core::health::HealthLevel::Degraded,
                "AUTOMATIC_VENT_COMMAND_FAILED",
                format!("automatic B3 control failed: {error}"),
            ),
            None => (
                vending_core::health::HealthLevel::Ok,
                "AUTOMATIC_VENT_READY",
                "automatic B3 control has no active error".to_string(),
            ),
        };
        vending_core::health::ComponentHealth {
            component: "automatic_vent".to_string(),
            level,
            code: code.to_string(),
            message,
            updated_at: crate::state::store::now_iso(),
        }
    }

    async fn enqueue(
        &self,
        edge_id: &str,
        speed: u8,
        force: bool,
    ) -> Result<AutomaticVentRequestOutcome, String> {
        if edge_id.trim().is_empty() {
            return Err("automatic vent edge id is required".to_string());
        }
        if !matches!(speed, 0 | 2) {
            return Err("automatic vent speed must be either 0 or 2".to_string());
        }
        let mut state = self.state.lock().await;
        if state.closed || self.shutdown.is_cancelled() {
            state.closed = true;
            return Ok(AutomaticVentRequestOutcome::Closed);
        }
        if !force && state.seen_edge_ids.iter().any(|seen| seen == edge_id) {
            return Ok(AutomaticVentRequestOutcome::Deduplicated);
        }
        state.seen_edge_ids.push_back(edge_id.to_string());
        if state.seen_edge_ids.len() > AUTOMATIC_VENT_EDGE_HISTORY_LIMIT {
            state.seen_edge_ids.pop_front();
        }
        // Only a newly observed stable edge can re-arm automatic control after
        // a one-shot Admin B3 command. A transport retry of the same edge does
        // not get to countermand the operator.
        if !force {
            state.admin_superseded = false;
        }
        state.pending = Some(AutomaticVentIntent {
            edge_id: edge_id.to_string(),
            speed,
            force,
        });
        if !state.worker_running {
            state.worker_running = true;
            let controller = self.clone();
            tokio::spawn(async move { controller.run().await });
        }
        Ok(AutomaticVentRequestOutcome::Accepted)
    }

    pub async fn supersede_by_admin(&self) {
        let mut state = self.state.lock().await;
        state.pending = None;
        state.admin_superseded = true;
    }

    pub async fn close(&self) {
        let mut state = self.state.lock().await;
        state.closed = true;
        state.pending = None;
    }

    async fn run(self) {
        loop {
            let guard_wait = {
                let mut state = self.state.lock().await;
                if state.closed || self.shutdown.is_cancelled() {
                    None
                } else if state.pending.is_none()
                    || (state.admin_superseded
                        && state.pending.as_ref().is_some_and(|intent| !intent.force))
                {
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
            let intent = {
                let mut state = self.state.lock().await;
                if state.closed
                    || self.shutdown.is_cancelled()
                    || (state.admin_superseded
                        && state.pending.as_ref().is_some_and(|pending| !pending.force))
                {
                    None
                } else {
                    let pending = state.pending.take();
                    if pending.as_ref().is_some_and(|pending| {
                        !pending.force && Some(pending.speed) == state.confirmed_speed
                    }) {
                        None
                    } else {
                        state.executing = pending.clone();
                        pending
                    }
                }
            };
            let Some(intent) = intent else {
                drop(hardware);
                continue;
            };

            {
                let mut state = self.state.lock().await;
                state.last_attempt_at = Some(Instant::now());
            }
            let result = hardware.set_vent_speed(intent.speed).await;
            drop(hardware);
            let mut state = self.state.lock().await;
            state.executing = None;
            match result {
                Ok(()) => {
                    state.confirmed_speed = Some(intent.speed);
                    state.last_error = None;
                }
                Err(error) => state.last_error = Some(error),
            }
            let outcome = state.last_error.clone();
            drop(state);
            self.record_outcome(&intent, outcome).await;
        }
    }

    async fn finish_worker(&self) {
        self.state.lock().await.worker_running = false;
    }

    async fn wait_until_idle(&self) {
        loop {
            let idle = {
                let state = self.state.lock().await;
                !state.worker_running && state.pending.is_none() && state.executing.is_none()
            };
            if idle {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    async fn record_outcome(&self, intent: &AutomaticVentIntent, error: Option<String>) {
        let Some(evidence) = self.evidence.as_ref() else {
            return;
        };
        let (level, code, message) = match error.as_deref() {
            Some(error) => (
                "error",
                "AUTOMATIC_VENT_COMMAND_FAILED",
                format!("automatic B3={} failed: {error}", intent.speed),
            ),
            None => (
                "info",
                "AUTOMATIC_VENT_COMMAND_SUCCEEDED",
                format!("automatic B3={} succeeded", intent.speed),
            ),
        };
        let _ = append_local_log(
            &evidence.log_path,
            &LocalLogEntry {
                ts: crate::state::store::now_iso(),
                level: level.to_string(),
                category: "automatic_vent".to_string(),
                message: message.clone(),
                data: Some(serde_json::json!({
                    "edgeId": intent.edge_id,
                    "speed": intent.speed,
                    "force": intent.force,
                    "code": code,
                })),
            },
        )
        .await;
        if error.is_some() {
            let _ = evidence
                .state
                .append_health_event(&vending_core::health::ComponentHealth {
                    component: "automatic_vent".to_string(),
                    level: vending_core::health::HealthLevel::Degraded,
                    code: code.to_string(),
                    message,
                    updated_at: crate::state::store::now_iso(),
                })
                .await;
        }
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

    use crate::{hardware::HardwareSupervisor, state::LocalStateStore};

    use super::AutomaticVentController;

    #[derive(Default)]
    struct RecordingHardware {
        vent_speeds: Mutex<Vec<u8>>,
        fail_vent: bool,
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
            if self.fail_vent {
                return Err("simulated B3 transport failure".to_string());
            }
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

        controller
            .request("presence-1:arrival", 2)
            .await
            .expect("arrival request");
        controller
            .request("presence-2:departure", 0)
            .await
            .expect("departure request");
        tokio::time::sleep(std::time::Duration::from_millis(80)).await;
        controller
            .request("presence-2:departure", 0)
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

        controller
            .request("presence-1:arrival", 2)
            .await
            .expect("arrival request");
        controller.supersede_by_admin().await;
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        assert!(adapter.vent_speeds.lock().expect("speeds").is_empty());

        controller
            .request("presence-2:departure", 0)
            .await
            .expect("next stable edge");
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        assert_eq!(*adapter.vent_speeds.lock().expect("speeds"), vec![0]);
    }

    #[tokio::test]
    async fn duplicate_edge_is_idempotent_and_cannot_release_an_admin_override() {
        let adapter = Arc::new(RecordingHardware::default());
        let controller = AutomaticVentController::new_with_guard(
            HardwareSupervisor::from_adapter(adapter.clone()),
            CancellationToken::new(),
            std::time::Duration::from_millis(1),
        );

        controller
            .request("presence-1:arrival", 2)
            .await
            .expect("initial arrival");
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        controller.supersede_by_admin().await;
        controller
            .request("presence-1:arrival", 2)
            .await
            .expect("duplicate arrival");
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;

        assert_eq!(*adapter.vent_speeds.lock().expect("speeds"), vec![2]);

        controller
            .request("presence-2:departure", 0)
            .await
            .expect("next stable edge");
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;

        assert_eq!(*adapter.vent_speeds.lock().expect("speeds"), vec![2, 0]);
    }

    #[tokio::test]
    async fn lifecycle_close_forces_one_closed_b3_command_after_an_open_intent() {
        let adapter = Arc::new(RecordingHardware::default());
        let controller = AutomaticVentController::new_with_guard(
            HardwareSupervisor::from_adapter(adapter.clone()),
            CancellationToken::new(),
            std::time::Duration::from_millis(1),
        );

        controller
            .request("presence-1:arrival", 2)
            .await
            .expect("arrival request");
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        controller
            .close_for_lifecycle("runtime-shutdown")
            .await
            .expect("lifecycle close");

        assert_eq!(*adapter.vent_speeds.lock().expect("speeds"), vec![2, 0]);
    }

    #[tokio::test]
    async fn automatic_transport_failure_is_logged_and_exposed_as_degraded_health() {
        let temp = tempfile::tempdir().expect("temp");
        let state = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("state");
        let adapter = Arc::new(RecordingHardware {
            fail_vent: true,
            ..Default::default()
        });
        let controller = AutomaticVentController::new_with_guard(
            HardwareSupervisor::from_adapter(adapter),
            CancellationToken::new(),
            std::time::Duration::from_millis(1),
        )
        .with_evidence(state, temp.path().join("logs").join("machine-events.jsonl"));

        controller
            .request("presence-1:arrival", 2)
            .await
            .expect("intent accepted even when B3 later fails");
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;

        let health = controller.health_component().await;
        assert_eq!(health.component, "automatic_vent");
        assert_eq!(health.code, "AUTOMATIC_VENT_COMMAND_FAILED");
        assert!(matches!(
            health.level,
            vending_core::health::HealthLevel::Degraded
        ));
        let log = tokio::fs::read_to_string(temp.path().join("logs").join("machine-events.jsonl"))
            .await
            .expect("automatic vent log");
        assert!(log.contains("presence-1:arrival"));
        assert!(log.contains("AUTOMATIC_VENT_COMMAND_FAILED"));
    }
}
