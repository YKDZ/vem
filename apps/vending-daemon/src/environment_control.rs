use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, Mutex, Notify};
use tokio_util::sync::CancellationToken;

use crate::{events::DaemonEvent, hardware::HardwareSupervisor, state::LocalStateStore};

pub const ENVIRONMENT_CONTROL_SCHEMA_VERSION: &str = "vem-environment-control/v1";

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EnvironmentControlSource {
    LocalOperator,
    RemoteOperator,
    StablePresence,
    AutomaticPolicy,
    SystemLifecycle,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum EnvironmentControlActionKind {
    SetAirConditioner { enabled: bool },
    SetTargetTemperature { temperature_celsius: i8 },
    SetBaseVentSpeed { vent_speed: u8 },
    TemporarilyStopVent,
    RestoreBaseVentSpeed,
    RetryCurrentDesired,
}

impl EnvironmentControlActionKind {
    pub fn name(&self) -> &'static str {
        match self {
            Self::SetAirConditioner { .. } => "set_air_conditioner",
            Self::SetTargetTemperature { .. } => "set_target_temperature",
            Self::SetBaseVentSpeed { .. } => "set_base_vent_speed",
            Self::TemporarilyStopVent => "temporarily_stop_vent",
            Self::RestoreBaseVentSpeed => "restore_base_vent_speed",
            Self::RetryCurrentDesired => "retry_current_desired",
        }
    }

    pub fn validate(&self) -> Result<(), String> {
        match self {
            Self::SetTargetTemperature {
                temperature_celsius,
            } if !(18..=30).contains(temperature_celsius) => {
                Err("target temperature must be between 18 and 30 Celsius".to_string())
            }
            Self::SetBaseVentSpeed { vent_speed } if *vent_speed > 4 => {
                Err("base vent speed must be between 0 and 4".to_string())
            }
            _ => Ok(()),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EnvironmentControlAction {
    pub action_id: String,
    pub source: EnvironmentControlSource,
    #[serde(rename = "action")]
    pub kind: EnvironmentControlActionKind,
}

impl EnvironmentControlAction {
    pub fn validate(&self) -> Result<(), String> {
        if self.action_id.trim().is_empty() {
            return Err("environment control action id is required".to_string());
        }
        self.kind.validate()
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EnvironmentControlSettings {
    pub air_conditioner_enabled: bool,
    pub target_temperature_celsius: i8,
    pub base_vent_speed: u8,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesiredEnvironmentControl {
    pub air_conditioner_enabled: bool,
    pub target_temperature_celsius: i8,
    pub vent_speed: u8,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfirmedEnvironmentControl {
    pub air_conditioner_enabled: Option<bool>,
    pub target_temperature_celsius: Option<i8>,
    pub vent_speed: Option<u8>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EnvironmentControlConfirmation {
    pub air_conditioner_enabled: bool,
    pub target_temperature_celsius: i8,
    pub vent_speed: u8,
}

impl EnvironmentControlConfirmation {
    fn validate(&self) -> bool {
        (18..=30).contains(&self.target_temperature_celsius) && self.vent_speed <= 4
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EnvironmentControlConvergence {
    Pending,
    Applied,
    Offline,
    Failed,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EnvironmentControlAdmissionOutcome {
    Accepted,
    Deduplicated,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EnvironmentControlAdmission {
    pub outcome: EnvironmentControlAdmissionOutcome,
    pub accepted_revision: u64,
    pub snapshot: EnvironmentControlSnapshot,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EnvironmentControlActionAudit {
    pub action_id: String,
    pub source: EnvironmentControlSource,
    pub action: String,
    pub accepted_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EnvironmentControlSnapshot {
    pub schema_version: String,
    pub revision: u64,
    pub settings: EnvironmentControlSettings,
    pub desired: DesiredEnvironmentControl,
    pub confirmed: ConfirmedEnvironmentControl,
    pub convergence: EnvironmentControlConvergence,
    pub reason_code: String,
    pub message: Option<String>,
    pub last_action: Option<EnvironmentControlActionAudit>,
    pub updated_at: String,
    pub last_attempt_at: Option<String>,
    pub confirmed_at: Option<String>,
}

impl EnvironmentControlSnapshot {
    pub fn initial(now: &str) -> Self {
        Self {
            schema_version: ENVIRONMENT_CONTROL_SCHEMA_VERSION.to_string(),
            revision: 0,
            settings: EnvironmentControlSettings {
                air_conditioner_enabled: false,
                target_temperature_celsius: 26,
                base_vent_speed: 3,
            },
            desired: DesiredEnvironmentControl {
                air_conditioner_enabled: false,
                target_temperature_celsius: 26,
                vent_speed: 0,
            },
            confirmed: ConfirmedEnvironmentControl {
                air_conditioner_enabled: None,
                target_temperature_celsius: None,
                vent_speed: None,
            },
            convergence: EnvironmentControlConvergence::Pending,
            reason_code: "initial_configuration".to_string(),
            message: None,
            last_action: None,
            updated_at: now.to_string(),
            last_attempt_at: None,
            confirmed_at: None,
        }
    }

    pub fn transition(
        &self,
        action: &EnvironmentControlAction,
        accepted_at: &str,
    ) -> Result<Self, String> {
        action.validate()?;
        let mut next = self.clone();
        match action.kind {
            EnvironmentControlActionKind::SetAirConditioner { enabled } => {
                next.settings.air_conditioner_enabled = enabled;
                next.desired.air_conditioner_enabled = enabled;
            }
            EnvironmentControlActionKind::SetTargetTemperature {
                temperature_celsius,
            } => {
                next.settings.target_temperature_celsius = temperature_celsius;
                next.desired.target_temperature_celsius = temperature_celsius;
            }
            EnvironmentControlActionKind::SetBaseVentSpeed { vent_speed } => {
                next.settings.base_vent_speed = vent_speed;
                next.desired.vent_speed = vent_speed;
            }
            EnvironmentControlActionKind::TemporarilyStopVent => {
                next.desired.vent_speed = 0;
            }
            EnvironmentControlActionKind::RestoreBaseVentSpeed => {
                next.desired.vent_speed = next.settings.base_vent_speed;
            }
            EnvironmentControlActionKind::RetryCurrentDesired => {}
        }
        if !matches!(
            action.kind,
            EnvironmentControlActionKind::RetryCurrentDesired
        ) {
            next.revision = next
                .revision
                .checked_add(1)
                .ok_or_else(|| "environment control revision exhausted".to_string())?;
        }
        next.convergence = EnvironmentControlConvergence::Pending;
        next.reason_code = if matches!(
            action.kind,
            EnvironmentControlActionKind::RetryCurrentDesired
        ) {
            "explicit_retry_requested"
        } else {
            "action_accepted"
        }
        .to_string();
        next.message = None;
        next.last_action = Some(EnvironmentControlActionAudit {
            action_id: action.action_id.clone(),
            source: action.source,
            action: action.kind.name().to_string(),
            accepted_at: accepted_at.to_string(),
        });
        next.updated_at = accepted_at.to_string();
        Ok(next)
    }

    pub fn record_applied(
        &mut self,
        revision: u64,
        confirmation: EnvironmentControlConfirmation,
        confirmed_at: &str,
    ) -> bool {
        if revision != self.revision || !confirmation.validate() {
            return false;
        }
        self.confirmed = ConfirmedEnvironmentControl {
            air_conditioner_enabled: Some(confirmation.air_conditioner_enabled),
            target_temperature_celsius: Some(confirmation.target_temperature_celsius),
            vent_speed: Some(confirmation.vent_speed),
        };
        self.convergence = EnvironmentControlConvergence::Applied;
        self.reason_code = "hardware_confirmed".to_string();
        self.message = None;
        self.updated_at = confirmed_at.to_string();
        self.last_attempt_at = Some(confirmed_at.to_string());
        self.confirmed_at = Some(confirmed_at.to_string());
        true
    }

    pub fn record_unapplied(
        &mut self,
        revision: u64,
        convergence: EnvironmentControlConvergence,
        reason_code: &str,
        message: Option<String>,
        attempted_at: &str,
    ) -> bool {
        if revision != self.revision
            || !matches!(
                convergence,
                EnvironmentControlConvergence::Pending
                    | EnvironmentControlConvergence::Offline
                    | EnvironmentControlConvergence::Failed
            )
            || reason_code.trim().is_empty()
        {
            return false;
        }
        self.convergence = convergence;
        self.reason_code = reason_code.to_string();
        self.message = message;
        self.updated_at = attempted_at.to_string();
        self.last_attempt_at = Some(attempted_at.to_string());
        true
    }

    pub fn reset_confirmation_for_runtime_start(&mut self, now: &str) {
        self.confirmed = ConfirmedEnvironmentControl {
            air_conditioner_enabled: None,
            target_temperature_celsius: None,
            vent_speed: None,
        };
        self.convergence = EnvironmentControlConvergence::Pending;
        self.reason_code = "runtime_started".to_string();
        self.message = None;
        self.updated_at = now.to_string();
        self.last_attempt_at = None;
        self.confirmed_at = None;
    }
}

const ENVIRONMENT_CONTROL_OPERATION_TIMEOUT: Duration = Duration::from_secs(5);
const ENVIRONMENT_CONTROL_RETRY_INTERVAL: Duration = Duration::from_secs(1);

#[derive(Clone)]
pub struct EnvironmentControlRuntime {
    inner: Arc<EnvironmentControlRuntimeInner>,
}

struct EnvironmentControlRuntimeInner {
    state: LocalStateStore,
    hardware: HardwareSupervisor,
    shutdown: CancellationToken,
    wake: Notify,
    reconcile_guard: Mutex<()>,
    closed: AtomicBool,
    operation_timeout: Duration,
    retry_interval: Duration,
    _events: broadcast::Sender<DaemonEvent>,
}

enum EnvironmentControlAttempt {
    Applied(EnvironmentControlConfirmation),
    Unapplied {
        convergence: EnvironmentControlConvergence,
        reason_code: &'static str,
        message: String,
    },
}

impl EnvironmentControlRuntime {
    pub async fn start(
        state: LocalStateStore,
        hardware: HardwareSupervisor,
        shutdown: CancellationToken,
        events: broadcast::Sender<DaemonEvent>,
    ) -> Result<Self, String> {
        Self::start_with_timing(
            state,
            hardware,
            shutdown,
            events,
            ENVIRONMENT_CONTROL_OPERATION_TIMEOUT,
            ENVIRONMENT_CONTROL_RETRY_INTERVAL,
        )
        .await
    }

    async fn start_with_timing(
        state: LocalStateStore,
        hardware: HardwareSupervisor,
        shutdown: CancellationToken,
        events: broadcast::Sender<DaemonEvent>,
        operation_timeout: Duration,
        retry_interval: Duration,
    ) -> Result<Self, String> {
        if operation_timeout.is_zero() || retry_interval.is_zero() {
            return Err("environment control timing must be positive".to_string());
        }
        state
            .reset_environment_control_confirmation_for_runtime_start(
                crate::state::store::now_iso().as_str(),
            )
            .await
            .map_err(|error| error.to_string())?;
        let runtime = Self {
            inner: Arc::new(EnvironmentControlRuntimeInner {
                state,
                hardware,
                shutdown,
                wake: Notify::new(),
                reconcile_guard: Mutex::new(()),
                closed: AtomicBool::new(false),
                operation_timeout,
                retry_interval,
                _events: events,
            }),
        };
        let worker = runtime.clone();
        tokio::spawn(async move { worker.run().await });
        runtime.inner.wake.notify_one();
        Ok(runtime)
    }

    pub async fn submit(
        &self,
        action: EnvironmentControlAction,
    ) -> Result<EnvironmentControlAdmission, String> {
        if self.inner.closed.load(Ordering::Acquire) || self.inner.shutdown.is_cancelled() {
            return Err("environment control runtime is closed".to_string());
        }
        let admission = self
            .inner
            .state
            .admit_environment_control_action(&action, crate::state::store::now_iso().as_str())
            .await
            .map_err(|error| error.to_string())?;
        if admission.outcome == EnvironmentControlAdmissionOutcome::Accepted {
            self.inner.wake.notify_one();
        }
        Ok(admission)
    }

    pub async fn snapshot(&self) -> Result<EnvironmentControlSnapshot, String> {
        self.inner
            .state
            .environment_control_snapshot()
            .await
            .map_err(|error| error.to_string())
    }

    pub fn request_reconcile(&self) {
        self.inner.wake.notify_one();
    }

    pub async fn wait_for_convergence(
        &self,
        revision: u64,
        convergence: EnvironmentControlConvergence,
        timeout: Duration,
    ) -> Result<EnvironmentControlSnapshot, String> {
        let deadline = Instant::now()
            .checked_add(timeout)
            .ok_or_else(|| "environment control wait timeout is out of range".to_string())?;
        loop {
            let snapshot = self.snapshot().await?;
            if snapshot.revision == revision && snapshot.convergence == convergence {
                return Ok(snapshot);
            }
            if snapshot.revision > revision {
                return Err(format!(
                    "environment control revision {revision} was superseded by {}",
                    snapshot.revision
                ));
            }
            if Instant::now() >= deadline {
                return Err(format!(
                    "environment control revision {revision} did not reach {convergence:?}"
                ));
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    pub async fn stop_hardware_for_shutdown(&self) -> Result<(), String> {
        self.inner.closed.store(true, Ordering::Release);
        self.inner.wake.notify_waiters();
        let _reconcile = self.inner.reconcile_guard.lock().await;
        let hardware = tokio::time::timeout(
            self.inner.operation_timeout,
            self.inner.hardware.acquire_environment_hardware(),
        )
        .await
        .map_err(|_| "environment control shutdown hardware ownership timed out".to_string())?;
        tokio::time::timeout(self.inner.operation_timeout, hardware.set_vent_speed(0))
            .await
            .map_err(|_| "environment control shutdown vent stop timed out".to_string())?
    }

    async fn run(self) {
        let mut retry = tokio::time::interval(self.inner.retry_interval);
        retry.tick().await;
        loop {
            tokio::select! {
                _ = self.inner.shutdown.cancelled() => return,
                _ = self.inner.wake.notified() => {},
                _ = retry.tick() => {},
            }
            if self.inner.closed.load(Ordering::Acquire) {
                return;
            }
            let snapshot = match self.snapshot().await {
                Ok(snapshot) => snapshot,
                Err(_) => continue,
            };
            if !matches!(
                snapshot.convergence,
                EnvironmentControlConvergence::Pending | EnvironmentControlConvergence::Offline
            ) {
                continue;
            }
            self.reconcile(snapshot).await;
        }
    }

    async fn reconcile(&self, candidate: EnvironmentControlSnapshot) {
        let _reconcile = self.inner.reconcile_guard.lock().await;
        if self.inner.closed.load(Ordering::Acquire) || self.inner.shutdown.is_cancelled() {
            return;
        }
        let snapshot = match self.snapshot().await {
            Ok(snapshot)
                if snapshot.revision == candidate.revision
                    && matches!(
                        snapshot.convergence,
                        EnvironmentControlConvergence::Pending
                            | EnvironmentControlConvergence::Offline
                    ) =>
            {
                snapshot
            }
            _ => return,
        };
        let revision = snapshot.revision;
        let attempted_at = crate::state::store::now_iso();
        match self.attempt_snapshot(&snapshot).await {
            EnvironmentControlAttempt::Applied(confirmation) => {
                let _ = self
                    .inner
                    .state
                    .record_environment_control_applied(
                        revision,
                        &confirmation,
                        attempted_at.as_str(),
                    )
                    .await;
            }
            EnvironmentControlAttempt::Unapplied {
                convergence,
                reason_code,
                message,
            } => {
                let _ = self
                    .inner
                    .state
                    .record_environment_control_unapplied(
                        revision,
                        convergence,
                        reason_code,
                        Some(message),
                        attempted_at.as_str(),
                    )
                    .await;
            }
        }
    }

    async fn attempt_snapshot(
        &self,
        snapshot: &EnvironmentControlSnapshot,
    ) -> EnvironmentControlAttempt {
        let hardware = match tokio::time::timeout(
            self.inner.operation_timeout,
            self.inner.hardware.acquire_environment_hardware(),
        )
        .await
        {
            Ok(hardware) => hardware,
            Err(_) => {
                return EnvironmentControlAttempt::Unapplied {
                    convergence: EnvironmentControlConvergence::Pending,
                    reason_code: "lower_controller_busy",
                    message: "lower controller is busy with another operation".to_string(),
                }
            }
        };

        let force_all = snapshot.reason_code == "explicit_retry_requested";
        if force_all
            || snapshot.confirmed.target_temperature_celsius
                != Some(snapshot.desired.target_temperature_celsius)
        {
            if let Err(error) = tokio::time::timeout(
                self.inner.operation_timeout,
                hardware.set_target_temperature(snapshot.desired.target_temperature_celsius),
            )
            .await
            .unwrap_or_else(|_| Err("target temperature operation timed out".to_string()))
            {
                drop(hardware);
                return self.classify_hardware_error(error).await;
            }
        }
        if force_all
            || snapshot.confirmed.air_conditioner_enabled
                != Some(snapshot.desired.air_conditioner_enabled)
        {
            if let Err(error) = tokio::time::timeout(
                self.inner.operation_timeout,
                hardware.set_air_conditioner_enabled(snapshot.desired.air_conditioner_enabled),
            )
            .await
            .unwrap_or_else(|_| Err("air conditioner operation timed out".to_string()))
            {
                drop(hardware);
                return self.classify_hardware_error(error).await;
            }
        }
        if force_all || snapshot.confirmed.vent_speed != Some(snapshot.desired.vent_speed) {
            if let Err(error) = tokio::time::timeout(
                self.inner.operation_timeout,
                hardware.set_vent_speed(snapshot.desired.vent_speed),
            )
            .await
            .unwrap_or_else(|_| Err("vent speed operation timed out".to_string()))
            {
                drop(hardware);
                return self.classify_hardware_error(error).await;
            }
        }
        EnvironmentControlAttempt::Applied(EnvironmentControlConfirmation {
            air_conditioner_enabled: snapshot.desired.air_conditioner_enabled,
            target_temperature_celsius: snapshot.desired.target_temperature_celsius,
            vent_speed: snapshot.desired.vent_speed,
        })
    }

    async fn classify_hardware_error(&self, error: String) -> EnvironmentControlAttempt {
        let status = tokio::time::timeout(
            self.inner.operation_timeout,
            self.inner.hardware.self_check(),
        )
        .await
        .ok();
        if status.as_ref().is_some_and(|status| !status.online) {
            return EnvironmentControlAttempt::Unapplied {
                convergence: EnvironmentControlConvergence::Offline,
                reason_code: "lower_controller_offline",
                message: error,
            };
        }
        let normalized = error.to_ascii_lowercase();
        if normalized.contains("controller busy") {
            return EnvironmentControlAttempt::Unapplied {
                convergence: EnvironmentControlConvergence::Pending,
                reason_code: "lower_controller_busy",
                message: error,
            };
        }
        if normalized.contains("rejected")
            || normalized.contains("not supported")
            || normalized.contains("invalid")
        {
            EnvironmentControlAttempt::Unapplied {
                convergence: EnvironmentControlConvergence::Failed,
                reason_code: "lower_controller_rejected",
                message: error,
            }
        } else {
            EnvironmentControlAttempt::Unapplied {
                convergence: EnvironmentControlConvergence::Pending,
                reason_code: "lower_controller_retryable_failure",
                message: error,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{
        sync::{
            atomic::{AtomicBool, AtomicU64, Ordering},
            Arc, Mutex,
        },
        time::Duration,
    };

    use async_trait::async_trait;
    use tempfile::TempDir;
    use tokio::sync::broadcast;
    use tokio_util::sync::CancellationToken;
    use vending_core::hardware::{
        DispenseCommandPayload, DispenseResultPayload, HardwareAdapter, HardwareStatus,
    };

    use super::*;
    use crate::{events::DaemonEvent, hardware::HardwareSupervisor, state::LocalStateStore};

    #[derive(Default)]
    struct TrackingEnvironmentAdapter {
        calls: Mutex<Vec<String>>,
        reject_vent: AtomicBool,
        busy_vent: AtomicBool,
        online: AtomicBool,
        vent_delay_ms: AtomicU64,
    }

    impl TrackingEnvironmentAdapter {
        fn online() -> Arc<Self> {
            Arc::new(Self {
                online: AtomicBool::new(true),
                ..Self::default()
            })
        }

        fn calls(&self) -> Vec<String> {
            self.calls.lock().expect("calls").clone()
        }

        fn clear_calls(&self) {
            self.calls.lock().expect("calls").clear();
        }
    }

    #[async_trait]
    impl HardwareAdapter for TrackingEnvironmentAdapter {
        fn adapter_name(&self) -> &str {
            "tracking"
        }

        async fn self_check(&self) -> HardwareStatus {
            let online = self.online.load(Ordering::SeqCst);
            HardwareStatus {
                adapter: "tracking".to_string(),
                online,
                message: if online { "online" } else { "offline" }.to_string(),
                port_path: None,
                resolution_source: None,
                bound_usb_identity: None,
                candidates: vec![],
                lower_controller_fault: None,
            }
        }

        async fn set_target_temperature(&self, value: i8) -> Result<(), String> {
            self.calls
                .lock()
                .expect("calls")
                .push(format!("temperature:{value}"));
            Ok(())
        }

        async fn set_air_conditioner_enabled(&self, value: bool) -> Result<(), String> {
            self.calls
                .lock()
                .expect("calls")
                .push(format!("air:{value}"));
            Ok(())
        }

        async fn set_vent_speed(&self, value: u8) -> Result<(), String> {
            self.calls
                .lock()
                .expect("calls")
                .push(format!("vent:{value}"));
            let delay = self.vent_delay_ms.load(Ordering::SeqCst);
            if delay > 0 {
                tokio::time::sleep(Duration::from_millis(delay)).await;
            }
            if self.reject_vent.load(Ordering::SeqCst) {
                Err("controller rejected B3".to_string())
            } else if self.busy_vent.load(Ordering::SeqCst) {
                Err("lower controller rejected command: controller busy".to_string())
            } else {
                Ok(())
            }
        }

        async fn dispense(&self, command: DispenseCommandPayload) -> DispenseResultPayload {
            DispenseResultPayload {
                command_no: command.command_no,
                success: false,
                error_code: Some("TEST_ONLY".to_string()),
                message: "not used".to_string(),
                reported_at: crate::state::store::now_iso(),
                lower_controller_fault: None,
            }
        }
    }

    async fn test_runtime(
        adapter: Arc<TrackingEnvironmentAdapter>,
    ) -> (
        TempDir,
        EnvironmentControlRuntime,
        CancellationToken,
        broadcast::Receiver<DaemonEvent>,
    ) {
        let directory = tempfile::tempdir().expect("temp");
        let state = LocalStateStore::open(&directory.path().join("state.db"))
            .await
            .expect("store");
        let shutdown = CancellationToken::new();
        let (events, receiver) = broadcast::channel(16);
        let runtime = EnvironmentControlRuntime::start_with_timing(
            state,
            HardwareSupervisor::from_adapter(adapter),
            shutdown.clone(),
            events,
            Duration::from_millis(100),
            Duration::from_millis(10),
        )
        .await
        .expect("runtime");
        (directory, runtime, shutdown, receiver)
    }

    fn local_action(id: &str, kind: EnvironmentControlActionKind) -> EnvironmentControlAction {
        EnvironmentControlAction {
            action_id: id.to_string(),
            source: EnvironmentControlSource::LocalOperator,
            kind,
        }
    }

    #[tokio::test]
    async fn startup_replays_all_unknown_axes_then_actions_only_reconcile_drift() {
        let adapter = TrackingEnvironmentAdapter::online();
        let (_directory, runtime, shutdown, _events) = test_runtime(adapter.clone()).await;
        runtime
            .wait_for_convergence(
                0,
                EnvironmentControlConvergence::Applied,
                Duration::from_secs(1),
            )
            .await
            .expect("initial convergence");
        assert_eq!(
            adapter.calls(),
            vec!["temperature:26", "air:false", "vent:0"]
        );
        adapter.clear_calls();

        let accepted = runtime
            .submit(local_action(
                "speed-4",
                EnvironmentControlActionKind::SetBaseVentSpeed { vent_speed: 4 },
            ))
            .await
            .expect("accept action");
        runtime
            .wait_for_convergence(
                accepted.accepted_revision,
                EnvironmentControlConvergence::Applied,
                Duration::from_secs(1),
            )
            .await
            .expect("action convergence");

        assert_eq!(adapter.calls(), vec!["vent:4"]);
        shutdown.cancel();
    }

    #[tokio::test]
    async fn deterministic_failure_keeps_desire_and_requires_explicit_retry() {
        let adapter = TrackingEnvironmentAdapter::online();
        let (_directory, runtime, shutdown, _events) = test_runtime(adapter.clone()).await;
        runtime
            .wait_for_convergence(
                0,
                EnvironmentControlConvergence::Applied,
                Duration::from_secs(1),
            )
            .await
            .expect("initial convergence");
        adapter.clear_calls();
        adapter.reject_vent.store(true, Ordering::SeqCst);

        let failed = runtime
            .submit(local_action(
                "speed-2",
                EnvironmentControlActionKind::SetBaseVentSpeed { vent_speed: 2 },
            ))
            .await
            .expect("accept failed action");
        let failed_snapshot = runtime
            .wait_for_convergence(
                failed.accepted_revision,
                EnvironmentControlConvergence::Failed,
                Duration::from_secs(1),
            )
            .await
            .expect("failure");
        tokio::time::sleep(Duration::from_millis(40)).await;
        assert_eq!(adapter.calls(), vec!["vent:2"]);
        assert_eq!(failed_snapshot.settings.base_vent_speed, 2);
        assert_eq!(failed_snapshot.desired.vent_speed, 2);

        adapter.reject_vent.store(false, Ordering::SeqCst);
        let retried = runtime
            .submit(local_action(
                "retry-speed-2",
                EnvironmentControlActionKind::RetryCurrentDesired,
            ))
            .await
            .expect("accept retry");
        assert_eq!(retried.accepted_revision, failed.accepted_revision);
        runtime
            .wait_for_convergence(
                retried.accepted_revision,
                EnvironmentControlConvergence::Applied,
                Duration::from_secs(1),
            )
            .await
            .expect("retry convergence");
        assert_eq!(
            adapter.calls(),
            vec!["vent:2", "temperature:26", "air:false", "vent:2"]
        );
        shutdown.cancel();
    }

    #[tokio::test]
    async fn controller_busy_is_pending_and_retries_the_latest_desire() {
        let adapter = TrackingEnvironmentAdapter::online();
        let (_directory, runtime, shutdown, _events) = test_runtime(adapter.clone()).await;
        runtime
            .wait_for_convergence(
                0,
                EnvironmentControlConvergence::Applied,
                Duration::from_secs(1),
            )
            .await
            .expect("initial convergence");
        adapter.clear_calls();
        adapter.busy_vent.store(true, Ordering::SeqCst);
        let accepted = runtime
            .submit(local_action(
                "busy-speed",
                EnvironmentControlActionKind::SetBaseVentSpeed { vent_speed: 3 },
            ))
            .await
            .expect("accept while controller is busy");
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let snapshot = runtime.snapshot().await.expect("snapshot");
                if snapshot.revision == accepted.accepted_revision
                    && snapshot.reason_code == "lower_controller_busy"
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("busy state");

        adapter.busy_vent.store(false, Ordering::SeqCst);
        runtime.request_reconcile();
        runtime
            .wait_for_convergence(
                accepted.accepted_revision,
                EnvironmentControlConvergence::Applied,
                Duration::from_secs(1),
            )
            .await
            .expect("converged after busy cleared");
        assert_eq!(adapter.calls(), vec!["vent:3", "vent:3"]);
        shutdown.cancel();
    }

    #[tokio::test]
    async fn a_new_action_can_be_accepted_while_an_old_revision_is_in_flight() {
        let adapter = TrackingEnvironmentAdapter::online();
        let (_directory, runtime, shutdown, _events) = test_runtime(adapter.clone()).await;
        runtime
            .wait_for_convergence(
                0,
                EnvironmentControlConvergence::Applied,
                Duration::from_secs(1),
            )
            .await
            .expect("initial convergence");
        adapter.clear_calls();
        adapter.vent_delay_ms.store(100, Ordering::SeqCst);

        runtime
            .submit(local_action(
                "speed-1",
                EnvironmentControlActionKind::SetBaseVentSpeed { vent_speed: 1 },
            ))
            .await
            .expect("first action");
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if adapter.calls() == vec!["vent:1"] {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("first hardware write started");
        let latest = runtime
            .submit(local_action(
                "speed-4",
                EnvironmentControlActionKind::SetBaseVentSpeed { vent_speed: 4 },
            ))
            .await
            .expect("latest action is admitted without waiting for hardware");
        runtime
            .wait_for_convergence(
                latest.accepted_revision,
                EnvironmentControlConvergence::Applied,
                Duration::from_secs(1),
            )
            .await
            .expect("latest convergence");

        assert_eq!(adapter.calls(), vec!["vent:1", "vent:4"]);
        assert_eq!(
            runtime
                .snapshot()
                .await
                .expect("snapshot")
                .confirmed
                .vent_speed,
            Some(4)
        );
        shutdown.cancel();
    }

    #[tokio::test]
    async fn shutdown_stop_is_hardware_only_and_preserves_persisted_desire() {
        let adapter = TrackingEnvironmentAdapter::online();
        let (_directory, runtime, shutdown, _events) = test_runtime(adapter.clone()).await;
        runtime
            .wait_for_convergence(
                0,
                EnvironmentControlConvergence::Applied,
                Duration::from_secs(1),
            )
            .await
            .expect("initial convergence");
        let accepted = runtime
            .submit(local_action(
                "speed-2",
                EnvironmentControlActionKind::SetBaseVentSpeed { vent_speed: 2 },
            ))
            .await
            .expect("speed action");
        runtime
            .wait_for_convergence(
                accepted.accepted_revision,
                EnvironmentControlConvergence::Applied,
                Duration::from_secs(1),
            )
            .await
            .expect("speed convergence");
        adapter.clear_calls();

        runtime
            .stop_hardware_for_shutdown()
            .await
            .expect("shutdown stop");
        let persisted = runtime.snapshot().await.expect("snapshot");

        assert_eq!(adapter.calls(), vec!["vent:0"]);
        assert_eq!(persisted.settings.base_vent_speed, 2);
        assert_eq!(persisted.desired.vent_speed, 2);
        shutdown.cancel();
    }
}
