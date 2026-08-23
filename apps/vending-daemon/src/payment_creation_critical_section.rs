//! The vending daemon's single Payment Creation Critical Section authority.
//!
//! One invariant — a checkout creation or recovery replay must never span a
//! planogram switch or hardware reconfiguration — was previously held by four
//! separate mechanisms across transaction, ipc, shutdown, and state. This
//! module owns the operation fence, the process-local checkout flight, and the
//! durable recovery-marker policy, so that invariant has exactly one owner.

use serde::{Deserialize, Serialize};
use std::{
    ops::Deref,
    sync::{
        atomic::{AtomicU8, AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::sync::{Mutex, Notify};
use tokio::time::Instant;
use uuid::Uuid;
use vending_core::domain::InternalCurrentTransactionSnapshot;

use crate::state::LocalStateStore;

pub(crate) const CHECKOUT_CREATION_RECOVERY_KEY: &str = "checkout_creation_recovery";

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct CheckoutCreationRecovery {
    pub(crate) payment_method: String,
    pub(crate) payment_provider_code: Option<String>,
    pub(crate) items: serde_json::Value,
    pub(crate) profile_snapshot: Option<serde_json::Value>,
    pub(crate) idempotency_key: String,
    #[serde(default)]
    pub(crate) generation: String,
    #[serde(default)]
    pub(crate) planogram_version: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct CheckoutCreationRequest {
    pub(crate) payment_method: String,
    pub(crate) payment_provider_code: Option<String>,
    pub(crate) items: serde_json::Value,
    pub(crate) profile_snapshot: Option<serde_json::Value>,
}

#[derive(Clone)]
pub(crate) struct CheckoutCreationFlight {
    pub(crate) idempotency_key: String,
    pub(crate) generation: String,
    pub(crate) request: CheckoutCreationRequest,
    pub(crate) completed: Arc<Notify>,
    pub(crate) participants: Arc<AtomicUsize>,
    pub(crate) participants_drained: Arc<Notify>,
}

pub(crate) struct CheckoutCreationParticipant {
    flight: CheckoutCreationFlight,
}

impl Deref for CheckoutCreationParticipant {
    type Target = CheckoutCreationFlight;

    fn deref(&self) -> &Self::Target {
        &self.flight
    }
}

impl Drop for CheckoutCreationParticipant {
    fn drop(&mut self) {
        self.flight.leave();
    }
}

impl CheckoutCreationFlight {
    pub(crate) fn join(&self) -> CheckoutCreationParticipant {
        self.participants.fetch_add(1, Ordering::AcqRel);
        CheckoutCreationParticipant {
            flight: self.clone(),
        }
    }

    pub(crate) fn leave(&self) {
        if self.participants.fetch_sub(1, Ordering::AcqRel) == 1 {
            self.participants_drained.notify_waiters();
        }
    }

    pub(crate) async fn wait_for_other_participants(&self) {
        loop {
            let drained = self.participants_drained.notified();
            if self.participants.load(Ordering::Acquire) == 0 {
                return;
            }
            drained.await;
        }
    }
}

pub(crate) enum CheckoutCreationRole {
    Owner(CheckoutCreationFlight),
    Join(CheckoutCreationParticipant),
    Existing(InternalCurrentTransactionSnapshot),
}

const GATE_IDLE: u8 = 0;
const GATE_SALE: u8 = 1;
const GATE_BINDING: u8 = 2;
const GATE_MANUAL_DISPENSE: u8 = 3;

/// The single atomic exclusion between sale-start, device binding, and manual
/// dispense operations. Private to this module: callers receive leases through
/// the Payment Creation Critical Section interface and never touch gate state.
#[derive(Debug, Default)]
struct OperationFence {
    state: AtomicU8,
}

impl OperationFence {
    async fn acquire_sale_start(self: &Arc<Self>, timeout: Duration) -> Result<OperationLease, u8> {
        let deadline = Instant::now() + timeout;
        loop {
            match self.try_acquire_sale_start() {
                Ok(lease) => return Ok(lease),
                Err(active) if Instant::now() >= deadline => return Err(active),
                Err(_) => tokio::time::sleep(Duration::from_millis(25)).await,
            }
        }
    }

    fn try_acquire_sale_start(self: &Arc<Self>) -> Result<OperationLease, u8> {
        self.acquire(GATE_SALE)
    }

    fn try_acquire_reconfigure(self: &Arc<Self>) -> Result<OperationLease, u8> {
        self.acquire(GATE_BINDING)
    }

    async fn acquire_manual_dispense(
        self: &Arc<Self>,
        timeout: Duration,
    ) -> Result<OperationLease, u8> {
        let deadline = Instant::now() + timeout;
        loop {
            match self.acquire(GATE_MANUAL_DISPENSE) {
                Ok(lease) => return Ok(lease),
                Err(active) if Instant::now() >= deadline => return Err(active),
                Err(_) => tokio::time::sleep(Duration::from_millis(25)).await,
            }
        }
    }

    fn acquire(self: &Arc<Self>, operation: u8) -> Result<OperationLease, u8> {
        self.state
            .compare_exchange(GATE_IDLE, operation, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| OperationLease {
                gate: self.clone(),
                operation,
            })
            .map_err(|active| active)
    }
}

pub(crate) struct OperationLease {
    gate: Arc<OperationFence>,
    operation: u8,
}

impl Drop for OperationLease {
    fn drop(&mut self) {
        let _ = self.gate.state.compare_exchange(
            self.operation,
            GATE_IDLE,
            Ordering::AcqRel,
            Ordering::Acquire,
        );
    }
}

#[derive(Clone)]
pub(crate) struct PaymentCreationCriticalSection {
    fence: Arc<OperationFence>,
    creation_lock: Arc<Mutex<()>>,
    flight: Arc<Mutex<Option<CheckoutCreationFlight>>>,
    state: LocalStateStore,
}

impl PaymentCreationCriticalSection {
    pub(crate) fn new(state: LocalStateStore) -> Self {
        Self {
            fence: Arc::new(OperationFence::default()),
            creation_lock: Arc::new(Mutex::new(())),
            flight: Arc::new(Mutex::new(None)),
            state,
        }
    }

    pub(crate) async fn acquire_sale_start(&self, timeout: Duration) -> Result<OperationLease, u8> {
        self.fence.acquire_sale_start(timeout).await
    }

    #[cfg(test)]
    pub(crate) fn try_acquire_sale_start(&self) -> Result<OperationLease, u8> {
        self.fence.try_acquire_sale_start()
    }

    pub(crate) fn try_acquire_reconfigure(&self) -> Result<OperationLease, u8> {
        self.fence.try_acquire_reconfigure()
    }

    pub(crate) async fn acquire_manual_dispense(
        &self,
        timeout: Duration,
    ) -> Result<OperationLease, u8> {
        self.fence.acquire_manual_dispense(timeout).await
    }

    pub(crate) async fn lock_creation(&self) -> tokio::sync::OwnedMutexGuard<()> {
        self.creation_lock.clone().lock_owned().await
    }

    pub(crate) async fn active_flight(&self) -> Option<CheckoutCreationFlight> {
        self.flight.lock().await.clone()
    }

    pub(crate) async fn set_active_flight(&self, flight: Option<CheckoutCreationFlight>) {
        *self.flight.lock().await = flight;
    }

    pub(crate) async fn flight_is_active(&self, flight: &CheckoutCreationFlight) -> bool {
        self.flight
            .lock()
            .await
            .as_ref()
            .is_some_and(|current| current.generation == flight.generation)
    }

    pub(crate) async fn finish_flight(&self, flight: &CheckoutCreationFlight) {
        let mut active = self.flight.lock().await;
        if active
            .as_ref()
            .is_some_and(|current| current.generation == flight.generation)
        {
            *active = None;
            flight.completed.notify_waiters();
        }
    }

    pub(crate) fn join_flight(
        &self,
        flight: &CheckoutCreationFlight,
    ) -> CheckoutCreationParticipant {
        flight.join()
    }

    pub(crate) fn new_flight(
        &self,
        recovery: CheckoutCreationRecovery,
        request: CheckoutCreationRequest,
    ) -> CheckoutCreationFlight {
        CheckoutCreationFlight {
            idempotency_key: recovery.idempotency_key,
            generation: recovery.generation,
            request,
            completed: Arc::new(Notify::new()),
            participants: Arc::new(AtomicUsize::new(1)),
            participants_drained: Arc::new(Notify::new()),
        }
    }

    /// Runs the owner side of a reserved checkout creation. The platform and
    /// order-session I/O is injected as an action; this module owns the flight
    /// completion and the recovery-marker cleanup decision.
    pub(crate) async fn run_owner_flight<F, Fut>(
        &self,
        flight: &CheckoutCreationFlight,
        action: F,
    ) -> Result<InternalCurrentTransactionSnapshot, String>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<
            Output = (Result<InternalCurrentTransactionSnapshot, String>, bool),
        >,
    {
        let (result, clear_marker_after_flight) = action().await;
        self.finish_flight(flight).await;
        flight.leave();
        flight.wait_for_other_participants().await;
        if clear_marker_after_flight {
            self.clear_recovery_if_owner(flight).await?;
        }
        result
    }

    /// The durable recovery marker is retained across an indeterminate
    /// platform failure and cleared only for deterministic pre-order failures.
    pub(crate) fn should_clear_recovery_marker_after_failure(error: &str) -> bool {
        let lower = error.to_ascii_lowercase();
        !(lower.contains("timeout")
            || lower.contains("offline")
            || lower.contains("network")
            || lower.contains("connection")
            || lower.contains("backend_http_error: 5")
            || lower.contains("status: 5")
            || lower.contains("status: 504"))
    }

    pub(crate) async fn read_recovery_marker(
        &self,
    ) -> Result<Option<CheckoutCreationRecovery>, String> {
        self.state
            .get_metadata::<CheckoutCreationRecovery>(CHECKOUT_CREATION_RECOVERY_KEY)
            .await
            .map_err(|error| error.to_string())
    }

    pub(crate) async fn write_recovery_marker(
        &self,
        recovery: &CheckoutCreationRecovery,
    ) -> Result<(), String> {
        self.state
            .put_metadata(CHECKOUT_CREATION_RECOVERY_KEY, recovery)
            .await
            .map_err(|error| error.to_string())
    }

    /// Reserves the durable recovery marker for a checkout request, upgrading
    /// legacy markers with a generation and planogram fence exactly once.
    pub(crate) async fn reserve_recovery_marker(
        &self,
        request: &CheckoutCreationRequest,
        idempotency_key: &str,
        planogram_version: Option<String>,
    ) -> Result<CheckoutCreationRecovery, String> {
        let recovery = self.read_recovery_marker().await?;
        let recovery = match recovery {
            Some(recovery) if recovery.idempotency_key != idempotency_key => {
                return Err("CHECKOUT_CREATION_RECOVERY_PENDING".to_string());
            }
            Some(recovery)
                if recovery.payment_method != request.payment_method
                    || recovery.payment_provider_code != request.payment_provider_code
                    || recovery.items != request.items
                    || recovery.profile_snapshot != request.profile_snapshot =>
            {
                return Err("CHECKOUT_CREATION_RECOVERY_PENDING".to_string());
            }
            Some(mut recovery) => {
                // Legacy markers did not fence a planogram generation. A local
                // replay owns the upgrade only while no flight exists.
                recovery.generation = Uuid::new_v4().to_string();
                recovery.planogram_version = planogram_version;
                self.write_recovery_marker(&recovery).await?;
                recovery
            }
            None => {
                let recovery = CheckoutCreationRecovery {
                    payment_method: request.payment_method.clone(),
                    payment_provider_code: request.payment_provider_code.clone(),
                    items: request.items.clone(),
                    profile_snapshot: request.profile_snapshot.clone(),
                    idempotency_key: idempotency_key.to_string(),
                    generation: Uuid::new_v4().to_string(),
                    planogram_version,
                };
                self.write_recovery_marker(&recovery).await?;
                recovery
            }
        };
        Ok(recovery)
    }

    pub(crate) async fn verify_recovery_owner(
        &self,
        flight: &CheckoutCreationFlight,
        planogram_version: Option<String>,
    ) -> Result<(), String> {
        let recovery = self
            .read_recovery_marker()
            .await?
            .ok_or_else(|| "CHECKOUT_CREATION_RECOVERY_REPLACED".to_string())?;
        if recovery.idempotency_key != flight.idempotency_key
            || recovery.generation != flight.generation
            || recovery.planogram_version != planogram_version
        {
            return Err("CHECKOUT_CREATION_RECOVERY_REPLACED".to_string());
        }
        Ok(())
    }

    pub(crate) async fn delete_recovery_if_owner(
        &self,
        flight: &CheckoutCreationFlight,
    ) -> Result<(), String> {
        let recovery = self.read_recovery_marker().await?;
        if recovery.is_some_and(|recovery| {
            recovery.idempotency_key == flight.idempotency_key
                && recovery.generation == flight.generation
        }) {
            self.state
                .delete_metadata(CHECKOUT_CREATION_RECOVERY_KEY)
                .await
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    pub(crate) async fn clear_recovery_if_owner(
        &self,
        flight: &CheckoutCreationFlight,
    ) -> Result<(), String> {
        let _checkout_creation = self.lock_creation().await;
        let _sale = self
            .acquire_sale_start(Duration::from_secs(10))
            .await
            .map_err(|_| "SALE_BINDING_RECONFIGURING".to_string())?;
        self.delete_recovery_if_owner(flight).await
    }

    pub(crate) async fn clear_recovery_marker_after_terminal(
        &self,
        is_terminal: bool,
    ) -> Result<(), String> {
        if !is_terminal {
            return Ok(());
        }
        self.state
            .delete_metadata(CHECKOUT_CREATION_RECOVERY_KEY)
            .await
            .map_err(|error| error.to_string())
    }

    pub(crate) async fn checkout_creation_in_flight(
        state: &LocalStateStore,
    ) -> Result<bool, String> {
        state
            .get_metadata::<CheckoutCreationRecovery>(CHECKOUT_CREATION_RECOVERY_KEY)
            .await
            .map(|recovery| recovery.is_some())
            .map_err(|error| error.to_string())
    }
}
