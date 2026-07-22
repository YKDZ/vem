use std::{
    collections::HashSet,
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
    seen_edge_ids: HashSet<String>,
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
    b3_protocol_guard: Arc<Mutex<()>>,
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
            b3_protocol_guard: Arc::new(Mutex::new(())),
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
        if !force && state.seen_edge_ids.contains(edge_id) {
            return Ok(AutomaticVentRequestOutcome::Deduplicated);
        }
        state.seen_edge_ids.insert(edge_id.to_string());
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

    pub async fn execute_admin_one_shot(&self, speed: u8) -> Result<(), String> {
        if speed > 4 {
            return Err("Admin vent speed must be between 0 and 4".to_string());
        }
        self.supersede_by_admin().await;
        let _protocol_guard = self.b3_protocol_guard.lock().await;
        if !self.wait_for_protocol_guard().await {
            return Err("automatic vent controller is closed".to_string());
        }
        let hardware = tokio::select! {
            _ = self.shutdown.cancelled() => return Err("automatic vent controller is closed".to_string()),
            hardware = self.hardware.acquire_environment_hardware() => hardware,
        };
        {
            let mut state = self.state.lock().await;
            if state.closed || self.shutdown.is_cancelled() {
                return Err("automatic vent controller is closed".to_string());
            }
            state.last_attempt_at = Some(Instant::now());
        }
        hardware.set_vent_speed(speed).await?;
        self.state.lock().await.confirmed_speed = Some(speed);
        Ok(())
    }

    pub async fn close(&self) {
        let mut state = self.state.lock().await;
        state.closed = true;
        state.pending = None;
    }

    async fn run(self) {
        loop {
            let should_continue = {
                let mut state = self.state.lock().await;
                if state.closed || self.shutdown.is_cancelled() {
                    false
                } else if state.pending.is_none()
                    || (state.admin_superseded
                        && state.pending.as_ref().is_some_and(|intent| !intent.force))
                {
                    state.worker_running = false;
                    false
                } else {
                    true
                }
            };
            if !should_continue {
                self.finish_worker().await;
                return;
            }

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
                continue;
            };
            let Some(result) = self.execute_automatic_intent(&intent).await else {
                self.state.lock().await.executing = None;
                continue;
            };
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

    async fn execute_automatic_intent(
        &self,
        intent: &AutomaticVentIntent,
    ) -> Option<Result<(), String>> {
        let _protocol_guard = self.b3_protocol_guard.lock().await;
        if !self.automatic_intent_is_current(intent).await || !self.wait_for_protocol_guard().await
        {
            return None;
        }
        let hardware = tokio::select! {
            _ = self.shutdown.cancelled() => return None,
            hardware = self.hardware.acquire_environment_hardware() => hardware,
        };
        if !self.automatic_intent_is_current(intent).await {
            return None;
        }
        self.state.lock().await.last_attempt_at = Some(Instant::now());
        Some(hardware.set_vent_speed(intent.speed).await)
    }

    async fn automatic_intent_is_current(&self, intent: &AutomaticVentIntent) -> bool {
        let state = self.state.lock().await;
        !state.closed && !self.shutdown.is_cancelled() && !(state.admin_superseded && !intent.force)
    }

    async fn wait_for_protocol_guard(&self) -> bool {
        let guard_wait = {
            let state = self.state.lock().await;
            state
                .last_attempt_at
                .map(|last| self.guard.saturating_sub(last.elapsed()))
                .unwrap_or(Duration::ZERO)
        };
        if guard_wait.is_zero() {
            return !self.shutdown.is_cancelled();
        }
        tokio::select! {
            _ = self.shutdown.cancelled() => false,
            _ = tokio::time::sleep(guard_wait) => true,
        }
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

    use super::{AutomaticVentController, AutomaticVentRequestOutcome};

    #[derive(Default)]
    struct RecordingHardware {
        vent_speeds: Mutex<Vec<u8>>,
        vent_attempts: Mutex<Vec<(u8, std::time::Instant)>>,
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
            self.vent_attempts
                .lock()
                .expect("attempts")
                .push((speed, std::time::Instant::now()));
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
    async fn admin_b3_waits_for_the_same_protocol_guard_as_automatic_b3() {
        let adapter = Arc::new(RecordingHardware::default());
        let controller = AutomaticVentController::new_with_guard(
            HardwareSupervisor::from_adapter(adapter.clone()),
            CancellationToken::new(),
            std::time::Duration::from_millis(50),
        );

        controller
            .request("presence-1:arrival", 2)
            .await
            .expect("automatic arrival");
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        controller
            .execute_admin_one_shot(3)
            .await
            .expect("Admin B3");

        let attempts = adapter.vent_attempts.lock().expect("attempts").clone();
        assert_eq!(
            attempts.iter().map(|(speed, _)| *speed).collect::<Vec<_>>(),
            vec![2, 3]
        );
        assert!(
            attempts[1].1.duration_since(attempts[0].1) >= std::time::Duration::from_millis(50)
        );
    }

    #[tokio::test]
    async fn fresh_automatic_edge_reapplies_speed_after_successful_admin_b3() {
        let adapter = Arc::new(RecordingHardware::default());
        let controller = AutomaticVentController::new_with_guard(
            HardwareSupervisor::from_adapter(adapter.clone()),
            CancellationToken::new(),
            std::time::Duration::from_millis(1),
        );

        controller
            .request("presence-1:arrival", 2)
            .await
            .expect("initial automatic edge");
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        controller
            .execute_admin_one_shot(3)
            .await
            .expect("successful Admin B3");
        controller
            .request("presence-2:arrival", 2)
            .await
            .expect("fresh automatic edge");
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;

        assert_eq!(*adapter.vent_speeds.lock().expect("speeds"), vec![2, 3, 2]);
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
    async fn old_edge_remains_deduplicated_after_more_than_sixty_four_new_edges() {
        let adapter = Arc::new(RecordingHardware::default());
        let controller = AutomaticVentController::new_with_guard(
            HardwareSupervisor::from_adapter(adapter.clone()),
            CancellationToken::new(),
            std::time::Duration::from_secs(1),
        );

        controller
            .request("presence-0:arrival", 2)
            .await
            .expect("initial arrival");
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        for index in 1..=65 {
            controller
                .request(&format!("presence-{index}:arrival"), 2)
                .await
                .expect("new edge");
        }
        controller.supersede_by_admin().await;

        assert_eq!(
            controller
                .request("presence-0:arrival", 2)
                .await
                .expect("old edge retry"),
            AutomaticVentRequestOutcome::Deduplicated,
        );
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        assert_eq!(*adapter.vent_speeds.lock().expect("speeds"), vec![2]);
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
