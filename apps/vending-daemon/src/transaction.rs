use serde::{Deserialize, Serialize};
use std::{
    future::Future,
    ops::Deref,
    pin::Pin,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
};
use uuid::Uuid;
use vending_core::domain::InternalCheckoutFlowAction;

use tokio::sync::{broadcast, Mutex, Notify};
use tokio::time::{Duration, Instant};

use crate::backend::BackendClient;
use crate::events::DaemonEvent;
use crate::ipc::SaleBindingOperationGate;
use crate::state::{LocalStateStore, OrderSessionUpsert, StoreError};

#[cfg(test)]
const PAYMENT_CODE_STATUS_POLL_INTERVAL: Duration = Duration::from_millis(20);
#[cfg(not(test))]
const PAYMENT_CODE_STATUS_POLL_INTERVAL: Duration = Duration::from_secs(3);
#[cfg(test)]
const PAYMENT_CODE_STATUS_POLL_MAX: Duration = Duration::from_millis(250);
#[cfg(not(test))]
const PAYMENT_CODE_STATUS_POLL_MAX: Duration = Duration::from_secs(45);

const CHECKOUT_CREATION_RECOVERY_KEY: &str = "checkout_creation_recovery";

#[derive(Clone, Debug, Deserialize, Serialize)]
struct CheckoutCreationRecovery {
    payment_method: String,
    payment_provider_code: Option<String>,
    items: serde_json::Value,
    profile_snapshot: Option<serde_json::Value>,
    idempotency_key: String,
    #[serde(default)]
    generation: String,
    #[serde(default)]
    planogram_version: Option<String>,
}

#[derive(Clone)]
struct CheckoutCreationFlight {
    idempotency_key: String,
    generation: String,
    request: CheckoutCreationRequest,
    completed: Arc<Notify>,
    participants: Arc<AtomicUsize>,
    participants_drained: Arc<Notify>,
}

#[derive(Clone, Debug, PartialEq)]
struct CheckoutCreationRequest {
    payment_method: String,
    payment_provider_code: Option<String>,
    items: serde_json::Value,
    profile_snapshot: Option<serde_json::Value>,
}

struct CheckoutCreationParticipant {
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
    fn join(&self) -> CheckoutCreationParticipant {
        self.participants.fetch_add(1, Ordering::AcqRel);
        CheckoutCreationParticipant {
            flight: self.clone(),
        }
    }

    fn leave(&self) {
        if self.participants.fetch_sub(1, Ordering::AcqRel) == 1 {
            self.participants_drained.notify_waiters();
        }
    }

    async fn wait_for_other_participants(&self) {
        loop {
            let drained = self.participants_drained.notified();
            if self.participants.load(Ordering::Acquire) == 0 {
                return;
            }
            drained.await;
        }
    }
}

enum CheckoutCreationRole {
    Owner(CheckoutCreationFlight),
    Join(CheckoutCreationParticipant),
    Existing(vending_core::domain::InternalCurrentTransactionSnapshot),
}

pub type PaymentCodeSubmitGuard = Arc<
    dyn Fn(
            Option<vending_core::scanner::ScannerHealthSnapshot>,
        ) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send>>
        + Send
        + Sync,
>;

/// A scanner arm belongs to one current payment-code checkout attempt. The
/// scanner supplies its capture timestamp, so queued bytes from before a new
/// order was armed cannot be attached to that new order by a delayed watcher.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaymentCodeScanArm {
    order_no: String,
    attempt_id: String,
    armed_at_ms: u128,
    epoch: u64,
}

#[derive(Clone, Debug)]
pub struct ArmedPaymentCode {
    pub raw: vending_core::scanner::RawPaymentCode,
    pub arm: PaymentCodeScanArm,
    pub scanner_health: vending_core::scanner::ScannerHealthSnapshot,
    pub scanner_event_id: String,
}

#[derive(Clone, Debug)]
enum PaymentCodeScanArmState {
    Armed(PaymentCodeScanArm),
    Consumed(PaymentCodeScanArm),
}

#[derive(Clone, Debug, Default)]
pub struct PaymentCodeScanArmer {
    state: Arc<Mutex<PaymentCodeScanArmEpochState>>,
}

#[derive(Clone, Debug, Default)]
struct PaymentCodeScanArmEpochState {
    epoch: u64,
    arm: Option<PaymentCodeScanArmState>,
}

/// The serial loop compares this value before every byte. An absent arm means
/// raw serial input belongs to no customer transaction and must be discarded.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct PaymentCodeScanEpoch {
    pub epoch: u64,
    pub accepting: bool,
}

impl PaymentCodeScanArmer {
    pub async fn arm_for_order(&self, order_no: &str) {
        self.arm(order_no).await;
    }

    async fn arm(&self, order_no: &str) {
        self.arm_at(order_no, crate::state::store::now_millis())
            .await;
    }

    async fn arm_at(&self, order_no: &str, armed_at_ms: u128) {
        let mut state = self.state.lock().await;
        if matches!(
            state.arm.as_ref(),
            Some(PaymentCodeScanArmState::Armed(arm) | PaymentCodeScanArmState::Consumed(arm))
                if arm.order_no == order_no
        ) {
            return;
        }
        state.epoch = state.epoch.wrapping_add(1);
        let epoch = state.epoch;
        state.arm = Some(PaymentCodeScanArmState::Armed(PaymentCodeScanArm {
            order_no: order_no.to_string(),
            attempt_id: Uuid::new_v4().simple().to_string(),
            armed_at_ms,
            epoch,
        }));
    }

    pub async fn clear(&self) {
        let mut state = self.state.lock().await;
        state.epoch = state.epoch.wrapping_add(1);
        state.arm = None;
    }

    async fn clear_matching(&self, expected: &PaymentCodeScanArm) {
        let mut state = self.state.lock().await;
        let matches_expected = matches!(
            state.arm.as_ref(),
            Some(PaymentCodeScanArmState::Armed(arm) | PaymentCodeScanArmState::Consumed(arm))
                if arm == expected
        );
        if matches_expected {
            state.epoch = state.epoch.wrapping_add(1);
            state.arm = None;
        }
    }

    /// Consumes an arm only when the scanner decoded the complete frame after
    /// that exact order/attempt was armed. A consumed arm remains observable
    /// until the transaction starts or rejects submission, preventing a
    /// refresh from re-arming a duplicate frame in the intervening window.
    #[cfg(test)]
    pub(crate) async fn consume_at(&self, scanned_at_ms: u128) -> Option<PaymentCodeScanArm> {
        let expected_epoch = {
            let state = self.state.lock().await;
            matches!(state.arm.as_ref(), Some(PaymentCodeScanArmState::Armed(_)))
                .then_some(state.epoch)
        }?;
        self.consume_at_epoch(expected_epoch, scanned_at_ms).await
    }

    /// Consumes only when the arm epoch is still the epoch that accepted the
    /// serial bytes. This closes the replacement race between framing and
    /// completing the scanner handoff.
    pub(crate) async fn consume_at_epoch(
        &self,
        expected_epoch: u64,
        scanned_at_ms: u128,
    ) -> Option<PaymentCodeScanArm> {
        let mut state = self.state.lock().await;
        if state.epoch != expected_epoch {
            return None;
        }
        let Some(PaymentCodeScanArmState::Armed(arm)) = state.arm.as_ref() else {
            return None;
        };
        if scanned_at_ms < arm.armed_at_ms {
            return None;
        }
        let arm = arm.clone();
        state.epoch = state.epoch.wrapping_add(1);
        state.arm = Some(PaymentCodeScanArmState::Consumed(arm.clone()));
        Some(arm)
    }

    async fn is_consumed(&self, expected: &PaymentCodeScanArm) -> bool {
        matches!(
            self.state.lock().await.arm.as_ref(),
            Some(PaymentCodeScanArmState::Consumed(arm)) if arm == expected
        )
    }

    pub(crate) async fn scanner_epoch(&self) -> PaymentCodeScanEpoch {
        let state = self.state.lock().await;
        PaymentCodeScanEpoch {
            epoch: state.epoch,
            accepting: matches!(state.arm.as_ref(), Some(PaymentCodeScanArmState::Armed(_))),
        }
    }
}

#[derive(Clone)]
pub struct TransactionStateMachine {
    state: LocalStateStore,
    backend: Arc<BackendClient>,
    events: broadcast::Sender<DaemonEvent>,
    machine_code: Option<String>,
    payment_code_submit_guard: Option<PaymentCodeSubmitGuard>,
    payment_code_scan_armer: PaymentCodeScanArmer,
    /// Owns the complete checkout creation critical section.  The local
    /// session is durable, but two IPC requests can both observe it as empty
    /// before either has received the platform's order response.
    checkout_creation_lock: Arc<Mutex<()>>,
    /// A process-local flight is paired with the persistent recovery marker.
    /// It lets duplicate IPC requests await the owner instead of replaying the
    /// machine-order request while the marker is already durable.
    checkout_creation_flight: Arc<Mutex<Option<CheckoutCreationFlight>>>,
    /// Shares the hardware-reconfiguration exclusion boundary with planogram
    /// and device-binding mutations. Recovery can create a checkout too.
    sale_binding_gate: Arc<SaleBindingOperationGate>,
}

impl TransactionStateMachine {
    pub fn new(
        state: LocalStateStore,
        backend: Arc<BackendClient>,
        machine_code: Option<String>,
        events: broadcast::Sender<DaemonEvent>,
    ) -> Self {
        Self {
            state,
            backend,
            events,
            machine_code,
            payment_code_submit_guard: None,
            payment_code_scan_armer: PaymentCodeScanArmer::default(),
            checkout_creation_lock: Arc::new(Mutex::new(())),
            checkout_creation_flight: Arc::new(Mutex::new(None)),
            sale_binding_gate: Arc::new(SaleBindingOperationGate::default()),
        }
    }

    pub fn with_payment_code_submit_guard(mut self, guard: PaymentCodeSubmitGuard) -> Self {
        self.payment_code_submit_guard = Some(guard);
        self
    }

    pub fn with_payment_code_scan_armer(mut self, armer: PaymentCodeScanArmer) -> Self {
        self.payment_code_scan_armer = armer;
        self
    }

    pub(crate) fn with_sale_binding_gate(mut self, gate: Arc<SaleBindingOperationGate>) -> Self {
        self.sale_binding_gate = gate;
        self
    }

    pub async fn restore_current(
        &self,
    ) -> Result<Option<vending_core::domain::InternalCurrentTransactionSnapshot>, String> {
        self.restore_current_under_sale_lease().await
    }

    async fn restore_current_under_sale_lease(
        &self,
    ) -> Result<Option<vending_core::domain::InternalCurrentTransactionSnapshot>, String> {
        let current = if let Some(current) = self.refresh_current_from_backend().await? {
            Some(current)
        } else {
            let Some(recovery) = self
                .state
                .get_metadata::<CheckoutCreationRecovery>(CHECKOUT_CREATION_RECOVERY_KEY)
                .await
                .map_err(|error| error.to_string())?
            else {
                self.sync_payment_code_scan_arm(None).await;
                return Ok(None);
            };

            // The platform's machine-order idempotency key is the durable source
            // of truth across a daemon restart. Replaying it either returns the
            // already-created order or creates the order exactly once.
            Some(
                self.create_order_with_idempotency_under_sale_lease(
                    &recovery.payment_method,
                    recovery.payment_provider_code,
                    recovery.items,
                    recovery.profile_snapshot,
                    Some(&recovery.idempotency_key),
                )
                .await?,
            )
        };
        self.sync_payment_code_scan_arm(current.as_ref()).await;
        Ok(current)
    }

    pub(crate) async fn submit_armed_payment_code(
        &self,
        scan: ArmedPaymentCode,
    ) -> Result<vending_core::domain::InternalCurrentTransactionSnapshot, String> {
        if !self.payment_code_scan_armer.is_consumed(&scan.arm).await {
            return Err("IGNORED_PAYMENT_CODE_ARM_MISMATCH".to_string());
        }
        let result = self
            .submit_payment_code_scoped(
                scan.raw,
                vending_core::scanner::PAYMENT_CODE_SOURCE_SERIAL_TEXT,
                Some(scan.scanner_health),
                Some(scan.scanner_event_id.as_str()),
                Some(&scan.arm),
            )
            .await;
        self.clear_payment_code_scan_arm_matching(&scan.arm).await;
        result
    }

    async fn sync_payment_code_scan_arm(
        &self,
        current: Option<&vending_core::domain::InternalCurrentTransactionSnapshot>,
    ) {
        let _mutation = self.state.lock_transaction_mutation().await;
        let Some(order_no) = current.and_then(payment_code_waiting_order_no) else {
            self.payment_code_scan_armer.clear().await;
            return;
        };
        self.payment_code_scan_armer.arm(order_no).await;
    }

    async fn clear_payment_code_scan_arm(&self) {
        let _mutation = self.state.lock_transaction_mutation().await;
        self.payment_code_scan_armer.clear().await;
    }

    async fn clear_payment_code_scan_arm_matching(&self, arm: &PaymentCodeScanArm) {
        let _mutation = self.state.lock_transaction_mutation().await;
        self.payment_code_scan_armer.clear_matching(arm).await;
    }

    async fn refresh_current_from_backend(
        &self,
    ) -> Result<Option<vending_core::domain::InternalCurrentTransactionSnapshot>, String> {
        let Some(current) = self
            .state
            .current_transaction_snapshot()
            .await
            .map_err(|error| error.to_string())?
        else {
            return Ok(None);
        };
        if is_terminal_transaction(&current) {
            return Ok(Some(current));
        }

        let Some(machine_code) = self.machine_code.as_deref() else {
            return Ok(Some(current));
        };
        let Some(order_no) = current.order_no.clone() else {
            return Ok(Some(current));
        };
        let before_status = current
            .next_action
            .map(InternalCheckoutFlowAction::as_str)
            .map(ToString::to_string)
            .or_else(|| current.order_status.clone())
            .unwrap_or_default();

        if let Ok(status_json) = self.backend.get_order_status(machine_code, &order_no).await {
            {
                let _mutation = self.state.lock_transaction_mutation().await;
                self.state
                    .apply_backend_order_status(&order_no, status_json)
                    .await
                    .map_err(|error| error.to_string())?;
            }
            let refreshed = self
                .state
                .current_transaction_snapshot()
                .await
                .map_err(|error| error.to_string())?;
            if let Some(refreshed) = refreshed.as_ref() {
                let after_status = refreshed
                    .next_action
                    .map(InternalCheckoutFlowAction::as_str)
                    .map(ToString::to_string)
                    .or_else(|| refreshed.order_status.clone())
                    .unwrap_or_default();
                if after_status != before_status {
                    self.emit_transaction_changed(&order_no, refreshed);
                }
            }
            return Ok(refreshed);
        }

        Ok(Some(current))
    }

    pub async fn create_order(
        &self,
        payment_method: &str,
        payment_provider_code: Option<String>,
        items: serde_json::Value,
        profile_snapshot: Option<serde_json::Value>,
    ) -> Result<vending_core::domain::InternalCurrentTransactionSnapshot, String> {
        self.create_order_with_idempotency(
            payment_method,
            payment_provider_code,
            items,
            profile_snapshot,
            None,
        )
        .await
    }

    pub async fn create_order_with_idempotency(
        &self,
        payment_method: &str,
        payment_provider_code: Option<String>,
        items: serde_json::Value,
        profile_snapshot: Option<serde_json::Value>,
        idempotency_key: Option<&str>,
    ) -> Result<vending_core::domain::InternalCurrentTransactionSnapshot, String> {
        self.create_order_with_idempotency_under_sale_lease(
            payment_method,
            payment_provider_code,
            items,
            profile_snapshot,
            idempotency_key,
        )
        .await
    }

    async fn create_order_with_idempotency_under_sale_lease(
        &self,
        payment_method: &str,
        payment_provider_code: Option<String>,
        items: serde_json::Value,
        profile_snapshot: Option<serde_json::Value>,
        idempotency_key: Option<&str>,
    ) -> Result<vending_core::domain::InternalCurrentTransactionSnapshot, String> {
        // Backend calls may take the full payment reconciliation window. The
        // sale lease only protects local admission and commit; the durable
        // recovery marker is what keeps planogram reconfiguration out while
        // that network work is in flight.
        if let Some(current) = self.refresh_current_from_backend().await? {
            if is_active_transaction(&current) {
                self.sync_payment_code_scan_arm(Some(&current)).await;
                return Ok(current);
            }
        }

        let machine_code = self
            .machine_code
            .clone()
            .ok_or_else(|| "machine code is required".to_string())?;
        let idempotency_key = idempotency_key
            .filter(|value| !value.trim().is_empty())
            .map(ToString::to_string)
            .unwrap_or_else(|| format!("checkout:{}", Uuid::new_v4()));

        let role = self
            .reserve_checkout_creation(
                payment_method,
                payment_provider_code.clone(),
                items.clone(),
                profile_snapshot.clone(),
                idempotency_key.clone(),
            )
            .await?;
        let flight = match role {
            CheckoutCreationRole::Owner(flight) => flight,
            CheckoutCreationRole::Join(participant) => {
                return self.wait_for_joined_checkout(&participant).await;
            }
            CheckoutCreationRole::Existing(current) => return Ok(current),
        };
        // A new order must never inherit a scanner frame or arm from a
        // terminal/replaced transaction.
        self.clear_payment_code_scan_arm().await;

        let (result, clear_marker_after_flight) = match self
            .backend
            .create_order(
                &machine_code,
                vec![items.clone()],
                payment_method,
                payment_provider_code.as_deref(),
                profile_snapshot,
                &idempotency_key,
            )
            .await
        {
            Ok(response) => {
                let result = self
                    .commit_created_order_under_sale_lease(
                        payment_method,
                        payment_provider_code,
                        items,
                        machine_code,
                        response,
                        &flight,
                    )
                    .await;
                let clear_marker_after_flight = result.is_ok();
                (result, clear_marker_after_flight)
            }
            Err(error) => {
                self.refresh_platform_stock_after_order_refusal(&machine_code)
                    .await;
                let clear_marker_after_flight = is_deterministic_checkout_creation_error(&error);
                (Err(error), clear_marker_after_flight)
            }
        };
        self.finish_checkout_creation_flight(&flight).await;
        flight.leave();
        flight.wait_for_other_participants().await;
        if clear_marker_after_flight {
            self.clear_checkout_recovery_if_owner(&flight).await?;
        }
        result
    }

    async fn commit_created_order_under_sale_lease(
        &self,
        payment_method: &str,
        payment_provider_code: Option<String>,
        items: serde_json::Value,
        machine_code: String,
        response: serde_json::Value,
        flight: &CheckoutCreationFlight,
    ) -> Result<vending_core::domain::InternalCurrentTransactionSnapshot, String> {
        let order_no = response
            .get("orderNo")
            .and_then(|value| value.as_str())
            .ok_or_else(|| "backend create order response missing orderNo".to_string())?
            .to_string();

        let backend_status = self
            .backend
            .get_order_status(&machine_code, &order_no)
            .await
            .unwrap_or_else(|_| response.clone());
        let next_action = backend_status
            .get("nextAction")
            .and_then(|value| value.as_str())
            .unwrap_or("wait_payment")
            .to_string();
        let order_status = backend_status
            .get("orderStatus")
            .and_then(|value| value.as_str())
            .unwrap_or("pending_payment")
            .to_string();

        let _checkout_creation = self.checkout_creation_lock.lock().await;
        let _sale = self.acquire_checkout_sale_lease().await?;
        self.verify_checkout_recovery_owner(flight).await?;
        let current = {
            let _mutation = self.state.lock_transaction_mutation().await;
            self.state
                .upsert_order_session(OrderSessionUpsert {
                    order_no: &order_no,
                    payment_method,
                    payment_provider: payment_provider_code.as_deref(),
                    items_json: items,
                    status: &order_status,
                    next_action: &next_action,
                    payment_attempt_json: None,
                    recovery_strategy: "local",
                    last_backend_status_json: Some(backend_status),
                    last_error: None,
                })
                .await
                .map_err(|error| error.to_string())?;

            self.state
                .current_transaction_snapshot()
                .await
                .map_err(|error| error.to_string())?
                .ok_or_else(|| "current transaction missing after create order".to_string())?
        };
        self.sync_payment_code_scan_arm(Some(&current)).await;
        self.emit_transaction_changed(&order_no, &current);
        Ok(current)
    }

    async fn reserve_checkout_creation(
        &self,
        payment_method: &str,
        payment_provider_code: Option<String>,
        items: serde_json::Value,
        profile_snapshot: Option<serde_json::Value>,
        idempotency_key: String,
    ) -> Result<CheckoutCreationRole, String> {
        let request = CheckoutCreationRequest {
            payment_method: payment_method.to_string(),
            payment_provider_code: payment_provider_code.clone(),
            items: items.clone(),
            profile_snapshot: profile_snapshot.clone(),
        };
        if let Some(flight) = self.checkout_creation_flight.lock().await.clone() {
            if flight.idempotency_key != idempotency_key || flight.request != request {
                return Err("CHECKOUT_CREATION_RECOVERY_PENDING".to_string());
            }
            return Ok(CheckoutCreationRole::Join(flight.join()));
        }

        let _checkout_creation = self.checkout_creation_lock.lock().await;
        if let Some(flight) = self.checkout_creation_flight.lock().await.clone() {
            if flight.idempotency_key != idempotency_key || flight.request != request {
                return Err("CHECKOUT_CREATION_RECOVERY_PENDING".to_string());
            }
            return Ok(CheckoutCreationRole::Join(flight.join()));
        }
        let _sale = self.acquire_checkout_sale_lease().await?;
        if let Some(current) = self
            .state
            .current_transaction_snapshot()
            .await
            .map_err(|error| error.to_string())?
        {
            if is_active_transaction(&current) {
                self.sync_payment_code_scan_arm(Some(&current)).await;
                return Ok(CheckoutCreationRole::Existing(current));
            }
        }

        let planogram_version = self
            .state
            .active_planogram_version()
            .await
            .map_err(|error| error.to_string())?;
        let recovery = self
            .state
            .get_metadata::<CheckoutCreationRecovery>(CHECKOUT_CREATION_RECOVERY_KEY)
            .await
            .map_err(|error| error.to_string())?;
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
                self.state
                    .put_metadata(CHECKOUT_CREATION_RECOVERY_KEY, &recovery)
                    .await
                    .map_err(|error| error.to_string())?;
                recovery
            }
            None => {
                let recovery = CheckoutCreationRecovery {
                    payment_method: payment_method.to_string(),
                    payment_provider_code,
                    items,
                    profile_snapshot,
                    idempotency_key,
                    generation: Uuid::new_v4().to_string(),
                    planogram_version,
                };
                self.state
                    .put_metadata(CHECKOUT_CREATION_RECOVERY_KEY, &recovery)
                    .await
                    .map_err(|error| error.to_string())?;
                recovery
            }
        };
        let flight = CheckoutCreationFlight {
            idempotency_key: recovery.idempotency_key,
            generation: recovery.generation,
            request,
            completed: Arc::new(Notify::new()),
            participants: Arc::new(AtomicUsize::new(1)),
            participants_drained: Arc::new(Notify::new()),
        };
        *self.checkout_creation_flight.lock().await = Some(flight.clone());
        Ok(CheckoutCreationRole::Owner(flight))
    }

    async fn verify_checkout_recovery_owner(
        &self,
        flight: &CheckoutCreationFlight,
    ) -> Result<(), String> {
        let recovery = self
            .state
            .get_metadata::<CheckoutCreationRecovery>(CHECKOUT_CREATION_RECOVERY_KEY)
            .await
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "CHECKOUT_CREATION_RECOVERY_REPLACED".to_string())?;
        let planogram_version = self
            .state
            .active_planogram_version()
            .await
            .map_err(|error| error.to_string())?;
        if recovery.idempotency_key != flight.idempotency_key
            || recovery.generation != flight.generation
            || recovery.planogram_version != planogram_version
        {
            return Err("CHECKOUT_CREATION_RECOVERY_REPLACED".to_string());
        }
        Ok(())
    }

    async fn delete_checkout_recovery_if_owner(
        &self,
        flight: &CheckoutCreationFlight,
    ) -> Result<(), String> {
        let recovery = self
            .state
            .get_metadata::<CheckoutCreationRecovery>(CHECKOUT_CREATION_RECOVERY_KEY)
            .await
            .map_err(|error| error.to_string())?;
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

    async fn clear_checkout_recovery_if_owner(
        &self,
        flight: &CheckoutCreationFlight,
    ) -> Result<(), String> {
        let _checkout_creation = self.checkout_creation_lock.lock().await;
        let _sale = self.acquire_checkout_sale_lease().await?;
        self.delete_checkout_recovery_if_owner(flight).await
    }

    async fn finish_checkout_creation_flight(&self, flight: &CheckoutCreationFlight) {
        let mut active = self.checkout_creation_flight.lock().await;
        if active
            .as_ref()
            .is_some_and(|current| current.generation == flight.generation)
        {
            *active = None;
            flight.completed.notify_waiters();
        }
    }

    async fn checkout_creation_flight_is_active(&self, flight: &CheckoutCreationFlight) -> bool {
        self.checkout_creation_flight
            .lock()
            .await
            .as_ref()
            .is_some_and(|current| current.generation == flight.generation)
    }

    async fn wait_for_joined_checkout(
        &self,
        flight: &CheckoutCreationFlight,
    ) -> Result<vending_core::domain::InternalCurrentTransactionSnapshot, String> {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let completed = flight.completed.notified();
            if let Some(current) = self
                .state
                .current_transaction_snapshot()
                .await
                .map_err(|error| error.to_string())?
            {
                if is_active_transaction(&current) {
                    self.sync_payment_code_scan_arm(Some(&current)).await;
                    return Ok(current);
                }
            }
            if !self.checkout_creation_flight_is_active(flight).await {
                return Err("CHECKOUT_CREATION_RECOVERY_PENDING".to_string());
            }
            if Instant::now() >= deadline {
                return Err("CHECKOUT_CREATION_RECOVERY_PENDING".to_string());
            }
            tokio::select! {
                _ = completed => {},
                _ = tokio::time::sleep(Duration::from_millis(25)) => {},
            }
        }
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

    async fn acquire_checkout_sale_lease(
        &self,
    ) -> Result<crate::ipc::SaleBindingOperationLease, String> {
        self.sale_binding_gate
            .acquire_sale_start(Duration::from_secs(10))
            .await
            .map_err(|_| "SALE_BINDING_RECONFIGURING".to_string())
    }

    pub async fn cancel_order(
        &self,
        order_no: &str,
    ) -> Result<vending_core::domain::InternalCurrentTransactionSnapshot, String> {
        // Cancel starts by invalidating a captured frame, rather than waiting
        // for the backend response to make the session terminal.
        self.clear_payment_code_scan_arm().await;
        let machine_code = self
            .machine_code
            .as_deref()
            .ok_or_else(|| "machine code is required".to_string())?;

        let status_json = self.backend.cancel_order(machine_code, order_no).await?;
        {
            let _mutation = self.state.lock_transaction_mutation().await;
            self.state
                .apply_backend_order_status(order_no, status_json)
                .await
                .map_err(|error| error.to_string())?;
        }

        let current = self
            .state
            .current_transaction_snapshot()
            .await
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "current transaction missing after cancel order".to_string())?;

        self.sync_payment_code_scan_arm(Some(&current)).await;
        self.emit_transaction_changed(order_no, &current);
        Ok(current)
    }

    async fn refresh_platform_stock_after_order_refusal(&self, machine_code: &str) {
        let Ok(snapshot) = self.backend.get_stock_snapshot(machine_code).await else {
            return;
        };
        let _ = self.state.apply_platform_stock_snapshot(&snapshot).await;
    }

    pub async fn submit_payment_code(
        &self,
        raw: vending_core::scanner::RawPaymentCode,
        source: &str,
        scanner_health: Option<vending_core::scanner::ScannerHealthSnapshot>,
    ) -> Result<vending_core::domain::InternalCurrentTransactionSnapshot, String> {
        self.submit_payment_code_scoped(raw, source, scanner_health, None, None)
            .await
    }

    async fn submit_payment_code_scoped(
        &self,
        raw: vending_core::scanner::RawPaymentCode,
        source: &str,
        scanner_health: Option<vending_core::scanner::ScannerHealthSnapshot>,
        scanner_event_id: Option<&str>,
        expected_arm: Option<&PaymentCodeScanArm>,
    ) -> Result<vending_core::domain::InternalCurrentTransactionSnapshot, String> {
        let machine_code = self
            .machine_code
            .as_deref()
            .ok_or_else(|| "machine code is required".to_string())?;
        // The legacy development intent still reaches the normal transaction
        // and Service API path, but it cannot leave the physical scanner arm
        // live beside a direct submission.
        if expected_arm.is_none() {
            self.clear_payment_code_scan_arm().await;
        }
        if let Some(guard) = &self.payment_code_submit_guard {
            guard(scanner_health.clone()).await?;
        }

        // The guard may await local readiness while cancel/replacement wins in
        // another state-machine instance. Re-read both the consumed arm and
        // exact current order under the store-owned mutation boundary before
        // the durable compare-and-set begins an attempt.
        let (snapshot, order_no, idempotency_key) = {
            let _mutation = self.state.lock_transaction_mutation().await;
            let snapshot = self
                .state
                .current_transaction_snapshot()
                .await
                .map_err(|error| error.to_string())?
                .ok_or_else(|| "NO_ACTIVE_TRANSACTION".to_string())?;
            let order_no = snapshot
                .order_no
                .clone()
                .ok_or_else(|| "ORDER_NO_MISSING".to_string())?;
            if let Some(arm) = expected_arm {
                if arm.order_no != order_no || !self.payment_code_scan_armer.is_consumed(arm).await
                {
                    return Err("IGNORED_PAYMENT_CODE_ARM_MISMATCH".to_string());
                }
            }
            if payment_code_waiting_order_no(&snapshot) != Some(order_no.as_str()) {
                return Err("IGNORED_TRANSACTION_NOT_WAITING_PAYMENT".to_string());
            }
            let idempotency_key = self
                .state
                .begin_payment_code_attempt(
                    &order_no,
                    &raw.masked_code,
                    source,
                    raw.scanned_at_ms,
                    scanner_event_id,
                    scanner_health.as_ref(),
                )
                .await
                .map_err(|error| match error {
                    StoreError::ActivePaymentCodeAttempt => {
                        "ACTIVE_PAYMENT_CODE_ATTEMPT".to_string()
                    }
                    StoreError::PaymentCodeOrderNotPayable => {
                        "IGNORED_TRANSACTION_NOT_WAITING_PAYMENT".to_string()
                    }
                    _ => error.to_string(),
                })?;
            if let Some(arm) = expected_arm {
                self.payment_code_scan_armer.clear_matching(arm).await;
            }
            (snapshot, order_no, idempotency_key)
        };

        // A terminal update may have landed after the durable begin but before
        // any network request. It is safe to stop here; the local attempt is
        // evidence of the rejected scan and the provider has not seen it.
        if !self
            .state
            .payment_code_attempt_is_current(&order_no, &idempotency_key)
            .await
            .map_err(|error| error.to_string())?
        {
            return Err("IGNORED_TRANSACTION_NOT_WAITING_PAYMENT".to_string());
        }

        if let Some(current) = self
            .state
            .current_transaction_snapshot()
            .await
            .map_err(|error| error.to_string())?
        {
            self.sync_payment_code_scan_arm(Some(&current)).await;
            self.emit_transaction_changed(&order_no, &current);
        }

        let mut submit_error = None;
        let mut submit_response = None;
        for _ in 0..3 {
            // Keep the final local check directly adjacent to the network
            // call. The Service API has its own durable admission CAS for the
            // remaining cross-process race, but a terminal transition already
            // visible locally must not even reach that boundary.
            if !self
                .state
                .payment_code_attempt_is_current(&order_no, &idempotency_key)
                .await
                .map_err(|error| error.to_string())?
            {
                return Err("IGNORED_TRANSACTION_NOT_WAITING_PAYMENT".to_string());
            }
            match self
                .backend
                .submit_payment_code(
                    machine_code,
                    &order_no,
                    &raw.auth_code,
                    &idempotency_key,
                    source,
                    scanner_event_id,
                    scanner_health.as_ref(),
                )
                .await
            {
                Ok(response) => {
                    submit_response = Some(response);
                    break;
                }
                Err(error) => submit_error = Some(error),
            }
        }

        let response = match submit_response {
            Some(response) => response,
            None => {
                self.state
                    .finish_payment_code_attempt(
                        &order_no,
                        "unknown",
                        true,
                        Some("网络异常，请刷新付款码后重试"),
                    )
                    .await
                    .map_err(|error| error.to_string())?;
                if let Some(current) = self
                    .state
                    .current_transaction_snapshot()
                    .await
                    .map_err(|error| error.to_string())?
                {
                    self.sync_payment_code_scan_arm(Some(&current)).await;
                    self.emit_transaction_changed(&order_no, &current);
                }
                return Err(submit_error.unwrap_or_else(|| "BACKEND_SUBMIT_FAILED".to_string()));
            }
        };

        let status = response
            .get("status")
            .and_then(|value| value.as_str())
            .unwrap_or("unknown");
        let can_retry = response
            .get("canRetry")
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
        let message = response.get("message").and_then(|value| value.as_str());
        self.state
            .finish_payment_code_attempt(&order_no, status, can_retry, message)
            .await
            .map_err(|error| error.to_string())?;

        match self.backend.get_order_status(machine_code, &order_no).await {
            Ok(status_json) => {
                self.state
                    .apply_backend_order_status(&order_no, status_json)
                    .await
                    .map_err(|error| error.to_string())?;
            }
            Err(error) => {
                let payment_attempt_json = self
                    .state
                    .load_attempt_json(&order_no)
                    .await
                    .map_err(|store_error| store_error.to_string())?
                    .map(serde_json::Value::Object);
                self.state
                    .upsert_order_session(OrderSessionUpsert {
                        order_no: &order_no,
                        payment_method: snapshot
                            .payment_method
                            .as_deref()
                            .unwrap_or("payment_code"),
                        payment_provider: snapshot.payment_provider.as_deref(),
                        items_json: snapshot
                            .product_summary
                            .clone()
                            .unwrap_or_else(|| serde_json::json!([])),
                        status: snapshot
                            .order_status
                            .as_deref()
                            .unwrap_or("pending_payment"),
                        next_action: snapshot
                            .next_action
                            .map(InternalCheckoutFlowAction::as_str)
                            .unwrap_or("wait_payment"),
                        payment_attempt_json,
                        recovery_strategy: "local",
                        last_backend_status_json: None,
                        last_error: Some(&error),
                    })
                    .await
                    .map_err(|store_error| store_error.to_string())?;
            }
        }

        let current = self
            .state
            .current_transaction_snapshot()
            .await
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "CURRENT_TRANSACTION_MISSING".to_string())?;

        self.sync_payment_code_scan_arm(Some(&current)).await;
        self.emit_transaction_changed(&order_no, &current);
        if should_follow_payment_code_attempt(&current) {
            self.spawn_payment_code_status_refresh(order_no);
        }
        Ok(current)
    }

    fn spawn_payment_code_status_refresh(&self, order_no: String) {
        let machine = self.clone();
        tokio::spawn(async move {
            let _ = machine
                .refresh_payment_code_status_until_stable(order_no)
                .await;
        });
    }

    async fn refresh_payment_code_status_until_stable(
        &self,
        order_no: String,
    ) -> Result<(), String> {
        let machine_code = self
            .machine_code
            .as_deref()
            .ok_or_else(|| "machine code is required".to_string())?;
        let deadline = Instant::now() + PAYMENT_CODE_STATUS_POLL_MAX;
        while Instant::now() < deadline {
            tokio::time::sleep(PAYMENT_CODE_STATUS_POLL_INTERVAL).await;
            let status_json = self
                .backend
                .get_order_status(machine_code, &order_no)
                .await?;
            {
                let _mutation = self.state.lock_transaction_mutation().await;
                self.state
                    .apply_backend_order_status(&order_no, status_json)
                    .await
                    .map_err(|error| error.to_string())?;
            }
            let Some(current) = self
                .state
                .current_transaction_snapshot()
                .await
                .map_err(|error| error.to_string())?
            else {
                self.clear_payment_code_scan_arm().await;
                return Ok(());
            };
            self.sync_payment_code_scan_arm(Some(&current)).await;
            self.emit_transaction_changed(&order_no, &current);
            if !should_follow_payment_code_attempt(&current) {
                return Ok(());
            }
        }
        // The local poll deadline is terminal for the scanner arm even when
        // provider reconciliation continues on the Service API side.
        self.clear_payment_code_scan_arm().await;
        Ok(())
    }

    fn emit_transaction_changed(
        &self,
        order_no: &str,
        current: &vending_core::domain::InternalCurrentTransactionSnapshot,
    ) {
        let _ = self.events.send(DaemonEvent::TransactionChanged {
            event_id: Uuid::new_v4().simple().to_string(),
            updated_at: crate::state::store::now_iso(),
            order_no: order_no.to_string(),
            status: current
                .next_action
                .map(InternalCheckoutFlowAction::as_str)
                .map(ToString::to_string)
                .unwrap_or_else(|| current.order_status.clone().unwrap_or_default()),
        });
    }
}

fn is_deterministic_checkout_creation_error(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    !(lower.contains("timeout")
        || lower.contains("offline")
        || lower.contains("network")
        || lower.contains("connection")
        || lower.contains("status: 5")
        || lower.contains("status: 504"))
}

fn should_follow_payment_code_attempt(
    current: &vending_core::domain::InternalCurrentTransactionSnapshot,
) -> bool {
    current
        .payment_code_attempt
        .as_ref()
        .and_then(|attempt| attempt.status.as_deref())
        .is_some_and(|status| {
            matches!(
                status,
                "submitting" | "user_confirming" | "querying" | "processing"
            )
        })
}

fn payment_code_waiting_order_no(
    current: &vending_core::domain::InternalCurrentTransactionSnapshot,
) -> Option<&str> {
    if current.payment_method.as_deref() != Some("payment_code")
        || !matches!(
            current.next_action,
            Some(InternalCheckoutFlowAction::WaitPayment)
        )
        || current.payment_code_attempt.is_some()
    {
        return None;
    }
    current.order_no.as_deref()
}

pub fn is_active_transaction(
    current: &vending_core::domain::InternalCurrentTransactionSnapshot,
) -> bool {
    if is_terminal_transaction(current) {
        return false;
    }
    current.next_action.is_some_and(|status| {
        matches!(
            status,
            InternalCheckoutFlowAction::WaitPayment | InternalCheckoutFlowAction::Dispensing
        )
    }) || current.order_status.as_deref().is_some_and(|status| {
        matches!(
            status,
            "waiting_payment" | "pending_payment" | "paid" | "dispensing"
        )
    })
}

fn is_terminal_transaction(
    current: &vending_core::domain::InternalCurrentTransactionSnapshot,
) -> bool {
    current.next_action.is_some_and(|status| {
        matches!(
            status,
            InternalCheckoutFlowAction::Success
                | InternalCheckoutFlowAction::PaymentExpired
                | InternalCheckoutFlowAction::PaymentFailed
                | InternalCheckoutFlowAction::DispenseFailed
                | InternalCheckoutFlowAction::RefundPending
                | InternalCheckoutFlowAction::Refunded
                | InternalCheckoutFlowAction::ManualHandling
                | InternalCheckoutFlowAction::Closed
        )
    }) || current.order_status.as_deref().is_some_and(|status| {
        matches!(
            status,
            "fulfilled"
                | "succeeded"
                | "failed"
                | "payment_expired"
                | "payment_failed"
                | "canceled"
                | "cancelled"
                | "expired"
                | "dispense_failed"
                | "refunded"
                | "partial_refunded"
                | "manual_handling"
                | "closed"
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, Request, ResponseTemplate};

    fn transaction_snapshot_with_status(
        order_status: &str,
        next_action: &str,
    ) -> vending_core::domain::InternalCurrentTransactionSnapshot {
        vending_core::domain::InternalCurrentTransactionSnapshot {
            order_id: None,
            order_no: Some("ORDER-STATUS".to_string()),
            product_summary: None,
            payment_id: None,
            payment_no: None,
            payment_method: Some("payment_code".to_string()),
            payment_provider: Some("alipay".to_string()),
            payment_url: None,
            payment_status: None,
            order_status: Some(order_status.to_string()),
            total_amount_cents: None,
            vending: None,
            next_action: InternalCheckoutFlowAction::from_current_contract(next_action),
            masked_auth_code: None,
            payment_code_attempt: None,
            expires_at: None,
            error_code: None,
            error_message: None,
            operator_hint: None,
            updated_at: "2026-06-10T00:00:00.000Z".to_string(),
        }
    }

    fn scanner_health() -> vending_core::scanner::ScannerHealthSnapshot {
        vending_core::scanner::ScannerHealthSnapshot {
            online: true,
            adapter: vending_core::scanner::PAYMENT_CODE_SOURCE_SERIAL_TEXT.to_string(),
            port: Some("/dev/pts/test".to_string()),
            level: vending_core::health::HealthLevel::Ok,
            code: "SCANNER_READY".to_string(),
            message: "scanner ready".to_string(),
            updated_at: crate::state::store::now_iso(),
        }
    }

    async fn seed_waiting_payment(state: &crate::state::LocalStateStore, order_no: &str) {
        state
            .upsert_order_session(OrderSessionUpsert {
                order_no,
                payment_method: "payment_code",
                payment_provider: Some("alipay"),
                items_json: json!([]),
                status: "waiting_payment",
                next_action: "wait_payment",
                payment_attempt_json: None,
                recovery_strategy: "local",
                last_backend_status_json: None,
                last_error: None,
            })
            .await
            .expect("seed waiting payment");
    }

    #[test]
    fn expired_next_action_is_not_active_transaction() {
        let snapshot = transaction_snapshot_with_status("waiting_payment", "payment_expired");

        assert!(!is_active_transaction(&snapshot));
    }

    #[tokio::test]
    async fn restore_current_refreshes_active_order_from_backend() {
        let temp = tempfile::tempdir().expect("temp");
        let state = crate::state::LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("state");
        state
            .upsert_order_session(OrderSessionUpsert {
                order_no: "ORDER-DISPENSED",
                payment_method: "payment_code",
                payment_provider: Some("alipay"),
                items_json: json!([{ "slotId": "A1", "quantity": 1 }]),
                status: "dispensing",
                next_action: "dispensing",
                payment_attempt_json: Some(json!({
                    "attemptNo": 1,
                    "status": "succeeded",
                    "maskedAuthCode": "2840****3066",
                    "source": "serial_text",
                    "idempotencyKey": "ORDER-DISPENSED:attempt-1",
                    "submittedAt": "2026-06-10T04:10:17.000Z",
                    "lastCheckedAt": "2026-06-10T04:10:20.000Z",
                    "canRetry": false
                })),
                recovery_strategy: "local",
                last_backend_status_json: Some(json!({
                    "orderNo": "ORDER-DISPENSED",
                    "machineCode": "M-1",
                    "orderStatus": "dispensing",
                    "nextAction": "dispensing",
                    "payment": {
                        "paymentNo": "PAY-DISPENSED",
                        "method": "payment_code",
                        "providerCode": "alipay",
                        "status": "succeeded",
                        "paymentUrl": null,
                        "expiresAt": "2026-06-10T04:16:26.596Z"
                    },
                    "vending": {
                        "commandNo": "CMD-DISPENSED",
                        "status": "sent",
                        "lastError": null
                    }
                })),
                last_error: None,
            })
            .await
            .expect("seed");

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/machine-auth/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "accessToken": "token-123"
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/machine-orders/ORDER-DISPENSED/status"))
            .and(header("authorization", "Bearer token-123"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "orderNo": "ORDER-DISPENSED",
                "machineCode": "M-1",
                "orderStatus": "fulfilled",
                "fulfillmentState": "dispensed",
                "totalAmountCents": 1,
                "nextAction": "success",
                "payment": {
                    "paymentNo": "PAY-DISPENSED",
                    "method": "payment_code",
                    "providerCode": "alipay",
                    "status": "succeeded",
                    "paymentUrl": null,
                    "expiresAt": "2026-06-10T04:16:26.596Z"
                },
                "paymentCodeAttempt": {
                    "attemptNo": 1,
                    "status": "succeeded",
                    "maskedAuthCode": "2840****3066",
                    "source": "serial_text",
                    "idempotencyKey": "ORDER-DISPENSED:attempt-1",
                    "submittedAt": "2026-06-10T04:10:17.000Z",
                    "lastCheckedAt": "2026-06-10T04:10:20.000Z",
                    "canRetry": false
                },
                "vending": {
                    "commandNo": "CMD-DISPENSED",
                    "status": "succeeded",
                    "lastError": "serial: dispense completed"
                }
            })))
            .mount(&server)
            .await;

        let backend = Arc::new(BackendClient::new(server.uri()));
        backend.authenticate("M-1", "S-1").await.expect("auth");
        let (events_tx, mut events_rx) = broadcast::channel(8);
        let machine = TransactionStateMachine::new(
            state.clone(),
            backend,
            Some("M-1".to_string()),
            events_tx,
        );

        let current = machine
            .restore_current()
            .await
            .expect("restore")
            .expect("current");
        assert_eq!(current.order_status.as_deref(), Some("fulfilled"));
        assert_eq!(
            current.next_action,
            Some(InternalCheckoutFlowAction::Success)
        );
        assert_eq!(
            current
                .vending
                .as_ref()
                .and_then(|vending| vending.status.as_deref()),
            Some("succeeded")
        );

        let summary = state
            .current_order_session_snapshot()
            .await
            .expect("summary")
            .expect("current summary");
        assert_eq!(
            summary.status,
            Some(vending_core::domain::OrderSessionStatus::Succeeded)
        );
        let event = events_rx.recv().await.expect("event");
        match event {
            DaemonEvent::TransactionChanged {
                order_no, status, ..
            } => {
                assert_eq!(order_no, "ORDER-DISPENSED");
                assert_eq!(status, "success");
            }
            other => panic!("unexpected event: {other:?}"),
        }
    }

    #[tokio::test]
    async fn create_order_resumes_existing_active_transaction() {
        let temp = tempfile::tempdir().expect("temp");
        let state = crate::state::LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("state");
        state
            .upsert_order_session(OrderSessionUpsert {
                order_no: "ORDER-ACTIVE",
                payment_method: "payment_code",
                payment_provider: Some("alipay"),
                items_json: json!([{ "slotId": "A1", "quantity": 1 }]),
                status: "waiting_payment",
                next_action: "wait_payment",
                payment_attempt_json: None,
                recovery_strategy: "local",
                last_backend_status_json: Some(json!({
                    "orderNo": "ORDER-ACTIVE",
                    "machineCode": "M-1",
                    "orderStatus": "pending_payment",
                    "nextAction": "wait_payment",
                    "payment": {
                        "paymentNo": "PAY-ACTIVE",
                        "method": "payment_code",
                        "providerCode": "alipay",
                        "status": "pending",
                        "paymentUrl": null,
                        "expiresAt": "2026-06-10T00:05:00.000Z"
                    }
                })),
                last_error: None,
            })
            .await
            .expect("seed");

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/machine-auth/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "accessToken": "token-123"
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/machine-orders/ORDER-ACTIVE/status"))
            .and(header("authorization", "Bearer token-123"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "orderNo": "ORDER-ACTIVE",
                "machineCode": "M-1",
                "orderStatus": "pending_payment",
                "nextAction": "wait_payment",
                "payment": {
                    "paymentNo": "PAY-ACTIVE",
                    "method": "payment_code",
                    "providerCode": "alipay",
                    "status": "pending",
                    "paymentUrl": null,
                    "expiresAt": "2026-06-10T00:05:00.000Z"
                }
            })))
            .mount(&server)
            .await;

        let backend = Arc::new(BackendClient::new(server.uri()));
        backend.authenticate("M-1", "S-1").await.expect("auth");
        let (events_tx, _) = broadcast::channel(8);
        let machine = TransactionStateMachine::new(
            state.clone(),
            backend,
            Some("M-1".to_string()),
            events_tx,
        );

        let current = machine
            .create_order(
                "payment_code",
                Some("alipay".to_string()),
                json!([{ "slotId": "A2", "quantity": 1 }]),
                None,
            )
            .await
            .expect("current");
        assert_eq!(current.order_no.as_deref(), Some("ORDER-ACTIVE"));

        let order_count: (i64,) = sqlx::query_as("SELECT COUNT(1) FROM order_sessions")
            .fetch_one(state.pool())
            .await
            .expect("count");
        assert_eq!(order_count.0, 1);
    }

    #[tokio::test]
    async fn create_order_keeps_create_response_payment_id_when_initial_status_refresh_fails() {
        let temp = tempfile::tempdir().expect("temp");
        let state = crate::state::LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("state");
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/machine-auth/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "accessToken": "token-123"
            })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/machine-orders"))
            .and(header("authorization", "Bearer token-123"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "orderId": "550e8400-e29b-41d4-a716-446655440010",
                "orderNo": "ORDER-CREATE-RESPONSE",
                "paymentId": "550e8400-e29b-41d4-a716-446655440011",
                "paymentNo": "PAY-CREATE-RESPONSE",
                "paymentUrl": null,
                "expiresAt": "2026-06-10T00:05:00.000Z",
                "totalAmountCents": 300,
                "paymentProviderCode": "mock"
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/machine-orders/ORDER-CREATE-RESPONSE/status"))
            .and(header("authorization", "Bearer token-123"))
            .respond_with(ResponseTemplate::new(503))
            .mount(&server)
            .await;

        let backend = Arc::new(BackendClient::new(server.uri()));
        backend.authenticate("M-1", "S-1").await.expect("auth");
        let (events_tx, _) = broadcast::channel(8);
        let machine =
            TransactionStateMachine::new(state, backend, Some("M-1".to_string()), events_tx);

        let current = machine
            .create_order_with_idempotency(
                "mock",
                Some("mock".to_string()),
                json!([{ "slotId": "A1", "quantity": 1 }]),
                None,
                Some("checkout:stable-daemon-retry"),
            )
            .await
            .expect("create response remains usable");

        assert_eq!(
            current.payment_id.as_deref(),
            Some("550e8400-e29b-41d4-a716-446655440011")
        );
        let requests = server.received_requests().await.expect("requests");
        let create_request = requests
            .iter()
            .find(|request| request.url.path() == "/machine-orders")
            .expect("create order request");
        let body: serde_json::Value =
            serde_json::from_slice(&create_request.body).expect("create body");
        assert_eq!(
            body["idempotencyKey"],
            serde_json::Value::String("checkout:stable-daemon-retry".to_string())
        );
    }

    #[tokio::test]
    async fn concurrent_checkout_creation_with_the_same_key_joins_one_durable_order() {
        let temp = tempfile::tempdir().expect("temp");
        let state = crate::state::LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("state");
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/machine-auth/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "accessToken": "token-123"
            })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/machine-orders"))
            .and(header("authorization", "Bearer token-123"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_delay(Duration::from_millis(50))
                    .set_body_json(json!({
                        "orderId": "550e8400-e29b-41d4-a716-446655440100",
                        "orderNo": "ORDER-SINGLEFLIGHT",
                        "paymentId": "550e8400-e29b-41d4-a716-446655440101",
                        "paymentNo": "PAY-SINGLEFLIGHT",
                        "paymentUrl": null,
                        "expiresAt": "2026-06-10T00:05:00.000Z",
                        "totalAmountCents": 300,
                        "paymentProviderCode": "mock"
                    })),
            )
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/machine-orders/ORDER-SINGLEFLIGHT/status"))
            .and(header("authorization", "Bearer token-123"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "orderNo": "ORDER-SINGLEFLIGHT",
                "machineCode": "M-1",
                "orderStatus": "pending_payment",
                "nextAction": "wait_payment",
                "payment": {
                    "paymentNo": "PAY-SINGLEFLIGHT",
                    "method": "mock",
                    "providerCode": "mock",
                    "status": "pending",
                    "paymentUrl": null,
                    "expiresAt": "2026-06-10T00:05:00.000Z"
                }
            })))
            .mount(&server)
            .await;

        let backend = Arc::new(BackendClient::new(server.uri()));
        backend.authenticate("M-1", "S-1").await.expect("auth");
        let (events_tx, _) = broadcast::channel(8);
        let machine =
            TransactionStateMachine::new(state, backend, Some("M-1".to_string()), events_tx);

        let first_machine = machine.clone();
        let second_machine = machine.clone();
        let (first, second) = tokio::join!(
            first_machine.create_order_with_idempotency(
                "mock",
                Some("mock".to_string()),
                json!([{ "slotId": "A1", "quantity": 1 }]),
                None,
                Some("checkout:first"),
            ),
            second_machine.create_order_with_idempotency(
                "mock",
                Some("mock".to_string()),
                json!([{ "slotId": "A1", "quantity": 1 }]),
                None,
                Some("checkout:first"),
            ),
        );

        let first = first.expect("first checkout");
        let second = second.expect("same idempotency key joins active checkout");
        assert_eq!(first.order_no.as_deref(), Some("ORDER-SINGLEFLIGHT"));
        assert_eq!(second.order_no.as_deref(), Some("ORDER-SINGLEFLIGHT"));
        let creates = server
            .received_requests()
            .await
            .expect("requests")
            .into_iter()
            .filter(|request| request.url.path() == "/machine-orders")
            .count();
        assert_eq!(creates, 1, "only one provider checkout may be active");
    }

    #[tokio::test]
    async fn checkout_owner_keeps_its_marker_until_joined_request_has_left() {
        let temp = tempfile::tempdir().expect("temp");
        let state = crate::state::LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("state");
        let (events_tx, _) = broadcast::channel(8);
        let machine = TransactionStateMachine::new(
            state.clone(),
            Arc::new(BackendClient::new("http://127.0.0.1:9")),
            Some("M-1".to_string()),
            events_tx,
        );

        let owner = match machine
            .reserve_checkout_creation(
                "mock",
                Some("mock".to_string()),
                json!([{ "slotId": "A1", "quantity": 1 }]),
                None,
                "checkout:single-flight".to_string(),
            )
            .await
            .expect("owner flight")
        {
            CheckoutCreationRole::Owner(flight) => flight,
            _ => panic!("first request must own the flight"),
        };
        let joined = match machine
            .reserve_checkout_creation(
                "mock",
                Some("mock".to_string()),
                json!([{ "slotId": "A1", "quantity": 1 }]),
                None,
                "checkout:single-flight".to_string(),
            )
            .await
            .expect("joined flight")
        {
            CheckoutCreationRole::Join(flight) => flight,
            _ => panic!("same idempotency key must join the owner"),
        };
        assert!(matches!(
            machine
                .reserve_checkout_creation(
                    "mock",
                    Some("mock".to_string()),
                    json!([{ "slotId": "B1", "quantity": 1 }]),
                    None,
                    "checkout:single-flight".to_string(),
                )
                .await,
            Err(error) if error == "CHECKOUT_CREATION_RECOVERY_PENDING"
        ));
        assert!(matches!(
            machine
                .reserve_checkout_creation(
                    "mock",
                    Some("mock".to_string()),
                    json!([{ "slotId": "A1", "quantity": 1 }]),
                    None,
                    "checkout:different".to_string(),
                )
                .await,
            Err(error) if error == "CHECKOUT_CREATION_RECOVERY_PENDING"
        ));

        machine.finish_checkout_creation_flight(&owner).await;
        owner.leave();
        assert!(
            TransactionStateMachine::checkout_creation_in_flight(&state)
                .await
                .expect("marker state"),
            "the owner must not clear a marker while a joined request is still in flight"
        );

        drop(joined);
        owner.wait_for_other_participants().await;
        machine
            .clear_checkout_recovery_if_owner(&owner)
            .await
            .expect("owner clears marker after all joiners leave");
        assert!(
            !TransactionStateMachine::checkout_creation_in_flight(&state)
                .await
                .expect("marker state"),
        );
    }

    #[tokio::test]
    async fn checkout_commit_rejects_a_replaced_marker_or_planogram_generation() {
        let temp = tempfile::tempdir().expect("temp");
        let state = crate::state::LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("state");
        sqlx::query(
            "INSERT INTO machine_planogram_versions(planogram_version,active,source,applied_by,applied_at)
             VALUES ('PLAN-A',1,'test',NULL,'2026-07-22T00:00:00Z')",
        )
        .execute(state.pool())
        .await
        .expect("seed planogram");
        let (events_tx, _) = broadcast::channel(8);
        let machine = TransactionStateMachine::new(
            state.clone(),
            Arc::new(BackendClient::new("http://127.0.0.1:9")),
            Some("M-1".to_string()),
            events_tx,
        );
        let owner = match machine
            .reserve_checkout_creation(
                "mock",
                Some("mock".to_string()),
                json!([{ "slotId": "A1", "quantity": 1 }]),
                None,
                "checkout:fenced".to_string(),
            )
            .await
            .expect("owner flight")
        {
            CheckoutCreationRole::Owner(flight) => flight,
            _ => panic!("first request must own the flight"),
        };

        sqlx::query("UPDATE machine_planogram_versions SET active = 0")
            .execute(state.pool())
            .await
            .expect("deactivate old planogram");
        sqlx::query(
            "INSERT INTO machine_planogram_versions(planogram_version,active,source,applied_by,applied_at)
             VALUES ('PLAN-B',1,'test',NULL,'2026-07-22T00:00:01Z')",
        )
        .execute(state.pool())
        .await
        .expect("activate replacement planogram");

        assert_eq!(
            machine.verify_checkout_recovery_owner(&owner).await,
            Err("CHECKOUT_CREATION_RECOVERY_REPLACED".to_string())
        );
        assert!(
            state
                .current_transaction_snapshot()
                .await
                .expect("current state")
                .is_none(),
            "a response created under PLAN-A must not commit after PLAN-B activates"
        );
    }

    #[tokio::test]
    async fn restore_current_replays_the_durable_platform_checkout_key_after_restart() {
        let temp = tempfile::tempdir().expect("temp");
        let state = crate::state::LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("state");
        state
            .put_metadata(
                CHECKOUT_CREATION_RECOVERY_KEY,
                &CheckoutCreationRecovery {
                    payment_method: "mock".to_string(),
                    payment_provider_code: Some("mock".to_string()),
                    items: json!([{ "slotId": "A1", "quantity": 1 }]),
                    profile_snapshot: None,
                    idempotency_key: "checkout:restart-durable".to_string(),
                    generation: String::new(),
                    planogram_version: None,
                },
            )
            .await
            .expect("persist crash recovery marker");

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/machine-auth/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "accessToken": "token-123"
            })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/machine-orders"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "orderId": "550e8400-e29b-41d4-a716-446655440110",
                "orderNo": "ORDER-RESTART-RECOVERY",
                "paymentId": "550e8400-e29b-41d4-a716-446655440111",
                "paymentNo": "PAY-RESTART-RECOVERY",
                "paymentUrl": null,
                "expiresAt": "2026-06-10T00:05:00.000Z",
                "totalAmountCents": 300,
                "paymentProviderCode": "mock"
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/machine-orders/ORDER-RESTART-RECOVERY/status"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "orderNo": "ORDER-RESTART-RECOVERY",
                "machineCode": "M-1",
                "orderStatus": "pending_payment",
                "nextAction": "wait_payment",
                "payment": {
                    "paymentNo": "PAY-RESTART-RECOVERY",
                    "method": "mock",
                    "providerCode": "mock",
                    "status": "pending",
                    "paymentUrl": null,
                    "expiresAt": "2026-06-10T00:05:00.000Z"
                }
            })))
            .mount(&server)
            .await;

        let backend = Arc::new(BackendClient::new(server.uri()));
        backend.authenticate("M-1", "S-1").await.expect("auth");
        let (events_tx, _) = broadcast::channel(8);
        let restarted = TransactionStateMachine::new(
            state.clone(),
            backend,
            Some("M-1".to_string()),
            events_tx,
        );

        let current = restarted
            .restore_current()
            .await
            .expect("restore")
            .expect("recovered current transaction");
        assert_eq!(current.order_no.as_deref(), Some("ORDER-RESTART-RECOVERY"));
        assert!(state
            .get_metadata::<CheckoutCreationRecovery>(CHECKOUT_CREATION_RECOVERY_KEY)
            .await
            .expect("marker read")
            .is_none());

        let requests = server.received_requests().await.expect("requests");
        let create_request = requests
            .into_iter()
            .find(|request| request.url.path() == "/machine-orders")
            .expect("replay API request");
        let body: serde_json::Value =
            serde_json::from_slice(&create_request.body).expect("create body");
        assert_eq!(body["idempotencyKey"], "checkout:restart-durable");
    }

    #[tokio::test]
    async fn pending_checkout_recovery_releases_the_sale_gate_while_network_replay_is_in_flight() {
        let temp = tempfile::tempdir().expect("temp");
        let state = crate::state::LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("state");
        state
            .put_metadata(
                CHECKOUT_CREATION_RECOVERY_KEY,
                &CheckoutCreationRecovery {
                    payment_method: "mock".to_string(),
                    payment_provider_code: Some("mock".to_string()),
                    items: json!([{ "slotId": "A1", "quantity": 1 }]),
                    profile_snapshot: None,
                    idempotency_key: "checkout:recovery-gate".to_string(),
                    generation: String::new(),
                    planogram_version: None,
                },
            )
            .await
            .expect("persist recovery marker");

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/machine-auth/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "accessToken": "token-123"
            })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/machine-orders"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_delay(Duration::from_millis(100))
                    .set_body_json(json!({
                        "orderId": "550e8400-e29b-41d4-a716-446655440210",
                        "orderNo": "ORDER-RECOVERY-GATE",
                        "paymentId": "550e8400-e29b-41d4-a716-446655440211",
                        "paymentNo": "PAY-RECOVERY-GATE",
                        "paymentUrl": null,
                        "expiresAt": "2026-06-10T00:05:00.000Z",
                        "totalAmountCents": 300,
                        "paymentProviderCode": "mock"
                    })),
            )
            .mount(&server)
            .await;

        let backend = Arc::new(BackendClient::new(server.uri()));
        backend.authenticate("M-1", "S-1").await.expect("auth");
        let gate = Arc::new(crate::ipc::SaleBindingOperationGate::default());
        let (events_tx, _) = broadcast::channel(8);
        let machine =
            TransactionStateMachine::new(state, backend, Some("M-1".to_string()), events_tx)
                .with_sale_binding_gate(gate.clone());

        let recovery = tokio::spawn(async move { machine.restore_current().await });
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let received = server.received_requests().await.expect("requests");
                if received
                    .iter()
                    .any(|request| request.url.path() == "/machine-orders")
                {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("recovery create-order request");

        let reconfigure = gate
            .try_acquire_reconfigure()
            .expect("network replay must not hold the local sale lease");
        drop(reconfigure);
        recovery
            .await
            .expect("recovery task")
            .expect("recovery result");
        assert!(gate.try_acquire_reconfigure().is_ok());
    }

    #[tokio::test]
    async fn payment_code_plaintext_not_stored() {
        let temp = tempfile::tempdir().expect("temp");
        let state = crate::state::LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("state");
        state
            .upsert_order_session(OrderSessionUpsert {
                order_no: "ORDER-1",
                payment_method: "payment_code",
                payment_provider: Some("wechat_pay"),
                items_json: serde_json::json!([]),
                status: "waiting_payment",
                next_action: "wait_payment",
                payment_attempt_json: None,
                recovery_strategy: "local",
                last_backend_status_json: None,
                last_error: None,
            })
            .await
            .expect("seed");

        let backend = Arc::new(BackendClient::new("http://127.0.0.1:0/api"));
        let (events_tx, _) = broadcast::channel(8);
        let machine = TransactionStateMachine::new(
            state.clone(),
            backend,
            Some("MACHINE-1".to_string()),
            events_tx,
        );

        machine
            .state
            .begin_payment_code_attempt("ORDER-1", "6212****3456", "serial_text", 1_000, None, None)
            .await
            .expect("seed payment attempt");

        let rows: String = sqlx::query_scalar(
            "SELECT payment_attempt_json FROM order_sessions WHERE order_no='ORDER-1'",
        )
        .fetch_one(state.pool())
        .await
        .expect("row");
        assert!(!rows.contains("621234567890123456"));
        assert!(rows.contains("6212****3456"));
    }

    #[tokio::test]
    async fn payment_code_submit_guard_blocks_backend_charge_when_machine_not_ready() {
        let temp = tempfile::tempdir().expect("temp");
        let state = crate::state::LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("state");
        state
            .upsert_order_session(OrderSessionUpsert {
                order_no: "ORDER-HW-OFFLINE",
                payment_method: "payment_code",
                payment_provider: Some("alipay"),
                items_json: serde_json::json!([]),
                status: "waiting_payment",
                next_action: "wait_payment",
                payment_attempt_json: None,
                recovery_strategy: "local",
                last_backend_status_json: None,
                last_error: None,
            })
            .await
            .expect("seed");

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/machine-auth/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "accessToken": "token-123"
            })))
            .mount(&server)
            .await;
        let submit_mock = Mock::given(method("POST"))
            .and(path("/machine-orders/ORDER-HW-OFFLINE/payment-code/submit"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "status": "succeeded",
                "canRetry": false
            })))
            .expect(0)
            .mount_as_scoped(&server)
            .await;

        let backend = Arc::new(BackendClient::new(server.uri()));
        backend.authenticate("M-1", "S-1").await.expect("auth");
        let (events_tx, _) = broadcast::channel(8);
        let machine = TransactionStateMachine::new(
            state.clone(),
            backend,
            Some("M-1".to_string()),
            events_tx,
        )
        .with_payment_code_submit_guard(Arc::new(|_| {
            Box::pin(async {
                Err("MACHINE_NOT_READY_FOR_PAYMENT_CODE: lower controller unavailable".to_string())
            })
        }));
        let code = vending_core::scanner::RawPaymentCode {
            auth_code: "2829123456784955".to_string(),
            masked_code: "2829****4955".to_string(),
            scanned_at_ms: 1_000,
        };

        let error = machine
            .submit_payment_code(
                code,
                vending_core::scanner::PAYMENT_CODE_SOURCE_SERIAL_TEXT,
                None,
            )
            .await
            .expect_err("guard should reject payment code submit");
        assert!(error.contains("MACHINE_NOT_READY_FOR_PAYMENT_CODE"));

        let current = state
            .current_transaction_snapshot()
            .await
            .expect("snapshot")
            .expect("current");
        assert!(current.payment_code_attempt.is_none());
        drop(submit_mock);
    }

    #[tokio::test]
    async fn payment_code_querying_attempt_refreshes_to_reversed_and_retryable() {
        let temp = tempfile::tempdir().expect("temp");
        let state = crate::state::LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("state");
        state
            .upsert_order_session(OrderSessionUpsert {
                order_no: "ORDER-REV",
                payment_method: "payment_code",
                payment_provider: Some("alipay"),
                items_json: serde_json::json!({
                    "slotId": "A1",
                    "quantity": 1
                }),
                status: "waiting_payment",
                next_action: "wait_payment",
                payment_attempt_json: None,
                recovery_strategy: "local",
                last_backend_status_json: Some(json!({
                    "orderNo": "ORDER-REV",
                    "machineCode": "M-1",
                    "orderStatus": "pending_payment",
                    "nextAction": "wait_payment",
                    "payment": {
                        "paymentNo": "PAY-REV",
                        "method": "payment_code",
                        "providerCode": "alipay",
                        "status": "pending",
                        "paymentUrl": null,
                        "expiresAt": "2026-06-10T00:05:00.000Z"
                    }
                })),
                last_error: None,
            })
            .await
            .expect("seed");

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/machine-auth/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "accessToken": "token-123"
            })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/machine-orders/ORDER-REV/payment-code/submit"))
            .and(header("authorization", "Bearer token-123"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "orderNo": "ORDER-REV",
                "paymentNo": "PAY-REV",
                "attemptNo": 1,
                "status": "querying",
                "nextAction": "wait_payment",
                "message": "正在确认支付结果",
                "canRetry": false,
                "serverTime": "2026-06-10T00:00:00.000Z"
            })))
            .mount(&server)
            .await;

        let status_calls = Arc::new(AtomicUsize::new(0));
        let status_calls_for_mock = status_calls.clone();
        Mock::given(method("GET"))
            .and(path("/machine-orders/ORDER-REV/status"))
            .and(header("authorization", "Bearer token-123"))
            .respond_with(move |_request: &Request| {
                let call = status_calls_for_mock.fetch_add(1, Ordering::SeqCst);
                let attempt_status = if call == 0 { "querying" } else { "reversed" };
                ResponseTemplate::new(200).set_body_json(json!({
                    "orderNo": "ORDER-REV",
                    "machineCode": "M-1",
                    "orderStatus": "pending_payment",
                    "nextAction": "wait_payment",
                    "payment": {
                        "paymentNo": "PAY-REV",
                        "method": "payment_code",
                        "providerCode": "alipay",
                        "status": "pending",
                        "paymentUrl": null,
                        "expiresAt": "2026-06-10T00:05:00.000Z"
                    },
                    "paymentCodeAttempt": {
                        "attemptNo": 1,
                        "status": attempt_status,
                        "maskedAuthCode": "2829****4955",
                        "source": "serial_text",
                        "idempotencyKey": "ORDER-REV:attempt-1",
                        "submittedAt": "2026-06-10T00:00:01.000Z",
                        "lastCheckedAt": "2026-06-10T00:00:02.000Z",
                        "canRetry": attempt_status == "reversed",
                        "message": null
                    }
                }))
            })
            .mount(&server)
            .await;

        let backend = Arc::new(BackendClient::new(server.uri()));
        backend.authenticate("M-1", "S-1").await.expect("auth");
        let (events_tx, _) = broadcast::channel(8);
        let machine = TransactionStateMachine::new(
            state.clone(),
            backend,
            Some("M-1".to_string()),
            events_tx,
        );
        let code = vending_core::scanner::RawPaymentCode {
            auth_code: "2829123456784955".to_string(),
            masked_code: "2829****4955".to_string(),
            scanned_at_ms: 1_000,
        };

        let current = machine
            .submit_payment_code(
                code,
                vending_core::scanner::PAYMENT_CODE_SOURCE_SERIAL_TEXT,
                None,
            )
            .await
            .expect("submit");
        assert_eq!(
            current
                .payment_code_attempt
                .as_ref()
                .and_then(|attempt| attempt.status.as_deref()),
            Some("querying")
        );

        let deadline = Instant::now() + Duration::from_secs(1);
        loop {
            let current = state
                .current_transaction_snapshot()
                .await
                .expect("snapshot")
                .expect("current");
            if current
                .payment_code_attempt
                .as_ref()
                .and_then(|attempt| attempt.status.as_deref())
                == Some("reversed")
            {
                let attempt = current.payment_code_attempt.as_ref().expect("attempt");
                assert_eq!(attempt.attempt_no, Some(1));
                assert_eq!(attempt.masked_auth_code.as_deref(), Some("2829****4955"));
                assert!(attempt.can_retry);
                assert!(!format!("{current:?}").contains("2829123456784955"));
                break;
            }
            if Instant::now() > deadline {
                panic!("payment code attempt did not refresh to reversed");
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(status_calls.load(Ordering::SeqCst) >= 2);
    }

    #[tokio::test]
    async fn payment_code_attempt_emits_transaction_event_before_backend_submit_returns() {
        let temp = tempfile::tempdir().expect("temp");
        let state = crate::state::LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("state");
        state
            .upsert_order_session(OrderSessionUpsert {
                order_no: "ORDER-DELAY",
                payment_method: "payment_code",
                payment_provider: Some("alipay"),
                items_json: serde_json::json!({
                    "slotId": "A1",
                    "quantity": 1
                }),
                status: "waiting_payment",
                next_action: "wait_payment",
                payment_attempt_json: None,
                recovery_strategy: "local",
                last_backend_status_json: Some(json!({
                    "orderNo": "ORDER-DELAY",
                    "machineCode": "M-1",
                    "orderStatus": "pending_payment",
                    "nextAction": "wait_payment",
                    "payment": {
                        "paymentNo": "PAY-DELAY",
                        "method": "payment_code",
                        "providerCode": "alipay",
                        "status": "pending",
                        "paymentUrl": null,
                        "expiresAt": "2026-06-10T00:05:00.000Z"
                    }
                })),
                last_error: None,
            })
            .await
            .expect("seed");

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/machine-auth/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "accessToken": "token-123"
            })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/machine-orders/ORDER-DELAY/payment-code/submit"))
            .and(header("authorization", "Bearer token-123"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_delay(Duration::from_millis(150))
                    .set_body_json(json!({
                        "orderNo": "ORDER-DELAY",
                        "paymentNo": "PAY-DELAY",
                        "attemptNo": 1,
                        "status": "querying",
                        "nextAction": "wait_payment",
                        "message": "正在确认支付结果",
                        "canRetry": false,
                        "serverTime": "2026-06-10T00:00:00.000Z"
                    })),
            )
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/machine-orders/ORDER-DELAY/status"))
            .and(header("authorization", "Bearer token-123"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "orderNo": "ORDER-DELAY",
                "machineCode": "M-1",
                "orderStatus": "pending_payment",
                "nextAction": "wait_payment",
                "payment": {
                    "paymentNo": "PAY-DELAY",
                    "method": "payment_code",
                    "providerCode": "alipay",
                    "status": "pending",
                    "paymentUrl": null,
                    "expiresAt": "2026-06-10T00:05:00.000Z"
                },
                "paymentCodeAttempt": {
                    "attemptNo": 1,
                    "status": "querying",
                    "maskedAuthCode": "2829****4955",
                    "source": "serial_text",
                    "idempotencyKey": "ORDER-DELAY:attempt-1",
                    "submittedAt": "2026-06-10T00:00:01.000Z",
                    "lastCheckedAt": null,
                    "canRetry": false,
                    "message": "正在确认支付结果"
                }
            })))
            .mount(&server)
            .await;

        let backend = Arc::new(BackendClient::new(server.uri()));
        backend.authenticate("M-1", "S-1").await.expect("auth");
        let (events_tx, mut events_rx) = broadcast::channel(8);
        let machine = TransactionStateMachine::new(
            state.clone(),
            backend,
            Some("M-1".to_string()),
            events_tx,
        );
        let task_machine = machine.clone();
        let code = vending_core::scanner::RawPaymentCode {
            auth_code: "2829123456784955".to_string(),
            masked_code: "2829****4955".to_string(),
            scanned_at_ms: 1_000,
        };
        let submit = tokio::spawn(async move {
            task_machine
                .submit_payment_code(
                    code,
                    vending_core::scanner::PAYMENT_CODE_SOURCE_SERIAL_TEXT,
                    None,
                )
                .await
        });

        let event = tokio::time::timeout(Duration::from_millis(80), events_rx.recv())
            .await
            .expect("transaction event before backend submit returns")
            .expect("event");
        match event {
            DaemonEvent::TransactionChanged { order_no, .. } => {
                assert_eq!(order_no, "ORDER-DELAY");
            }
            other => panic!("unexpected event: {other:?}"),
        }

        let current = submit.await.expect("join").expect("submit");
        assert_eq!(
            current
                .payment_code_attempt
                .as_ref()
                .and_then(|attempt| attempt.status.as_deref()),
            Some("querying")
        );
    }

    #[tokio::test]
    async fn armed_serial_scan_creates_one_attempt_and_projects_success_once() {
        let temp = tempfile::tempdir().expect("temp");
        let state = crate::state::LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("state");
        state
            .upsert_order_session(OrderSessionUpsert {
                order_no: "ORDER-ARMED-SUCCESS",
                payment_method: "payment_code",
                payment_provider: Some("mock"),
                items_json: json!([]),
                status: "waiting_payment",
                next_action: "wait_payment",
                payment_attempt_json: None,
                recovery_strategy: "local",
                last_backend_status_json: None,
                last_error: None,
            })
            .await
            .expect("seed");

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/machine-auth/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "accessToken": "token-123"
            })))
            .mount(&server)
            .await;
        let submit = Mock::given(method("POST"))
            .and(path(
                "/machine-orders/ORDER-ARMED-SUCCESS/payment-code/submit",
            ))
            .and(header("authorization", "Bearer token-123"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "orderNo": "ORDER-ARMED-SUCCESS",
                "paymentNo": "PAY-ARMED-SUCCESS",
                "attemptNo": 1,
                "status": "succeeded",
                "nextAction": "dispensing",
                "message": "支付成功，正在出货",
                "canRetry": false,
                "serverTime": "2026-06-10T00:00:00.000Z"
            })))
            .expect(1)
            .mount_as_scoped(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/machine-orders/ORDER-ARMED-SUCCESS/status"))
            .and(header("authorization", "Bearer token-123"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "orderNo": "ORDER-ARMED-SUCCESS",
                "machineCode": "M-1",
                "orderStatus": "paid",
                "nextAction": "dispensing",
                "payment": {
                    "paymentNo": "PAY-ARMED-SUCCESS",
                    "method": "payment_code",
                    "providerCode": "mock",
                    "status": "succeeded",
                    "paymentUrl": null
                },
                "paymentCodeAttempt": {
                    "attemptNo": 1,
                    "status": "succeeded",
                    "maskedAuthCode": "2829****4955",
                    "source": "serial_text",
                    "idempotencyKey": "ORDER-ARMED-SUCCESS:attempt-1",
                    "submittedAt": "2026-06-10T00:00:01.000Z",
                    "lastCheckedAt": "2026-06-10T00:00:01.000Z",
                    "canRetry": false,
                    "message": "支付成功，正在出货"
                }
            })))
            .mount(&server)
            .await;

        let backend = Arc::new(BackendClient::new(server.uri()));
        backend.authenticate("M-1", "S-1").await.expect("auth");
        let (events_tx, _) = broadcast::channel(8);
        let machine = TransactionStateMachine::new(
            state.clone(),
            backend,
            Some("M-1".to_string()),
            events_tx,
        );
        machine
            .payment_code_scan_armer
            .arm_at("ORDER-ARMED-SUCCESS", 1_000)
            .await;
        let arm = machine
            .payment_code_scan_armer
            .consume_at(1_001)
            .await
            .expect("consume armed scanner frame");
        assert!(machine
            .payment_code_scan_armer
            .consume_at(1_001)
            .await
            .is_none());

        let current = machine
            .submit_armed_payment_code(ArmedPaymentCode {
                arm,
                raw: vending_core::scanner::RawPaymentCode {
                    auth_code: "2829123456784955".to_string(),
                    masked_code: "2829****4955".to_string(),
                    scanned_at_ms: 1_001,
                },
                scanner_event_id: "evt-scanner-armed-success".to_string(),
                scanner_health: vending_core::scanner::ScannerHealthSnapshot {
                    online: true,
                    adapter: vending_core::scanner::PAYMENT_CODE_SOURCE_SERIAL_TEXT.to_string(),
                    port: Some("/dev/pts/test".to_string()),
                    level: vending_core::health::HealthLevel::Ok,
                    code: "SCANNER_READY".to_string(),
                    message: "scanner ready".to_string(),
                    updated_at: crate::state::store::now_iso(),
                },
            })
            .await
            .expect("submit one armed payment-code attempt");

        assert_eq!(
            current.next_action,
            Some(InternalCheckoutFlowAction::Dispensing)
        );
        assert_eq!(
            current
                .payment_code_attempt
                .as_ref()
                .and_then(|attempt| attempt.status.as_deref()),
            Some("succeeded")
        );
        drop(submit);
    }

    #[tokio::test]
    async fn payment_code_begin_is_single_flight_across_state_machine_instances() {
        let temp = tempfile::tempdir().expect("temp");
        let state = crate::state::LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("state");
        seed_waiting_payment(&state, "ORDER-SHARED-BEGIN").await;
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/machine-auth/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "accessToken": "token-123"
            })))
            .mount(&server)
            .await;
        let submit = Mock::given(method("POST"))
            .and(path(
                "/machine-orders/ORDER-SHARED-BEGIN/payment-code/submit",
            ))
            .and(header("authorization", "Bearer token-123"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_delay(Duration::from_millis(100))
                    .set_body_json(json!({
                        "orderNo": "ORDER-SHARED-BEGIN",
                        "paymentNo": "PAY-SHARED-BEGIN",
                        "attemptNo": 1,
                        "status": "failed",
                        "nextAction": "wait_payment",
                        "message": "付款码无效",
                        "canRetry": true,
                        "serverTime": "2026-06-10T00:00:00.000Z"
                    })),
            )
            .expect(1)
            .mount_as_scoped(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/machine-orders/ORDER-SHARED-BEGIN/status"))
            .and(header("authorization", "Bearer token-123"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "orderNo": "ORDER-SHARED-BEGIN",
                "machineCode": "M-1",
                "orderStatus": "pending_payment",
                "nextAction": "wait_payment",
                "payment": {
                    "paymentNo": "PAY-SHARED-BEGIN",
                    "method": "payment_code",
                    "providerCode": "alipay",
                    "status": "pending",
                    "paymentUrl": null
                }
            })))
            .mount(&server)
            .await;
        let backend = Arc::new(BackendClient::new(server.uri()));
        backend.authenticate("M-1", "S-1").await.expect("auth");
        let first = TransactionStateMachine::new(
            state.clone(),
            backend.clone(),
            Some("M-1".to_string()),
            broadcast::channel(8).0,
        );
        let second = TransactionStateMachine::new(
            state,
            backend,
            Some("M-1".to_string()),
            broadcast::channel(8).0,
        );
        let raw = vending_core::scanner::RawPaymentCode {
            auth_code: "621234567890123456".to_string(),
            masked_code: "6212****3456".to_string(),
            scanned_at_ms: 1_001,
        };
        let (first_result, second_result) = tokio::join!(
            first.submit_payment_code(
                raw.clone(),
                vending_core::scanner::PAYMENT_CODE_SOURCE_SERIAL_TEXT,
                Some(scanner_health()),
            ),
            second.submit_payment_code(
                raw,
                vending_core::scanner::PAYMENT_CODE_SOURCE_SERIAL_TEXT,
                Some(scanner_health()),
            )
        );
        assert_eq!(
            usize::from(first_result.is_ok()) + usize::from(second_result.is_ok()),
            1,
            "only one state machine may begin the durable attempt"
        );
        assert!(
            matches!(first_result, Err(ref error) if error == "IGNORED_TRANSACTION_NOT_WAITING_PAYMENT")
                || matches!(second_result, Err(ref error) if error == "IGNORED_TRANSACTION_NOT_WAITING_PAYMENT"),
            "the losing state machine must observe the durable winner"
        );
        drop(submit);
    }

    #[tokio::test]
    async fn payment_code_scan_arm_rejects_pre_arm_and_duplicate_frames() {
        let armer = PaymentCodeScanArmer::default();
        armer.arm_at("ORDER-ARM-A", 1_000).await;

        assert!(armer.consume_at(999).await.is_none());

        let consumed = armer
            .consume_at(1_000)
            .await
            .expect("frame observed after arm");
        assert_eq!(consumed.order_no, "ORDER-ARM-A");
        assert!(armer.is_consumed(&consumed).await);
        assert!(armer.consume_at(1_001).await.is_none());

        armer.clear_matching(&consumed).await;
        assert!(!armer.is_consumed(&consumed).await);
    }

    #[tokio::test]
    async fn payment_code_scan_arm_rejects_a_frame_when_its_observed_epoch_was_replaced() {
        let armer = PaymentCodeScanArmer::default();
        armer.arm_at("ORDER-ARM-A", 1_000).await;
        let observed_a = armer.scanner_epoch().await;

        armer.arm_at("ORDER-ARM-B", 1_001).await;
        assert!(
            armer
                .consume_at_epoch(observed_a.epoch, 1_002)
                .await
                .is_none(),
            "a scanner frame may only consume the epoch that accepted its bytes"
        );

        let observed_b = armer.scanner_epoch().await;
        let arm_b = armer
            .consume_at_epoch(observed_b.epoch, 1_002)
            .await
            .expect("current epoch accepts its own frame");
        assert_eq!(arm_b.order_no, "ORDER-ARM-B");
    }

    #[tokio::test]
    async fn payment_code_scan_arm_rejects_delayed_order_a_frame_after_order_b_is_armed() {
        let armer = PaymentCodeScanArmer::default();
        armer.arm_at("ORDER-ARM-A", 1_000).await;

        // The scanner decoded this code for order A, but the watcher has not
        // received its scoped event yet when order B replaces A.
        let delayed_order_a = armer
            .consume_at(1_001)
            .await
            .expect("order A frame is scoped at scanner receipt");
        armer.arm_at("ORDER-ARM-B", 2_000).await;
        assert!(!armer.is_consumed(&delayed_order_a).await);

        let order_b = armer
            .consume_at(2_000)
            .await
            .expect("order B frame observed after its arm");
        assert_eq!(order_b.order_no, "ORDER-ARM-B");
        assert!(armer.consume_at(2_001).await.is_none());
    }

    #[tokio::test]
    async fn payment_code_scan_arm_clear_removes_terminal_failure_cancel_and_next_order_state() {
        let armer = PaymentCodeScanArmer::default();
        armer.arm_at("ORDER-ARM-A", 1_000).await;
        armer.clear().await;
        assert!(armer.consume_at(1_001).await.is_none());

        armer.arm_at("ORDER-ARM-B", 2_000).await;
        let order_b = armer
            .consume_at(2_001)
            .await
            .expect("new order is independently armed");
        assert_eq!(order_b.order_no, "ORDER-ARM-B");
    }
}
