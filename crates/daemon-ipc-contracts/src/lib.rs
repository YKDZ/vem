//! Daemon IPC Contract Generation boundary types.

use std::fmt;

#[doc(hidden)]
mod generated {
    pub mod scanner_status;
    pub mod transaction_checkout;
}

pub type CheckoutFlowAction = generated::transaction_checkout::CurrentTransactionSnapshotNextAction;
pub type CurrentTransactionSnapshot = generated::transaction_checkout::CurrentTransactionSnapshot;
pub type DispenseProgressObservationStage =
    generated::transaction_checkout::DispenseProgressObservationStage;
pub type PaymentCodeAttemptSummary =
    generated::transaction_checkout::CurrentTransactionSnapshotPaymentCodeAttempt;
pub type PickupReminder =
    generated::transaction_checkout::CurrentTransactionSnapshotVendingPickupReminder;
pub type ScannerRuntimeStatus = generated::scanner_status::ScannerRuntimeStatus;
pub type VendingSummary = generated::transaction_checkout::CurrentTransactionSnapshotVending;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoundaryValidationError {
    issues: Vec<&'static str>,
}

impl BoundaryValidationError {
    pub fn issues(&self) -> &[&'static str] {
        &self.issues
    }
}

impl fmt::Display for BoundaryValidationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.issues.join("; "))
    }
}

impl std::error::Error for BoundaryValidationError {}

pub fn validate_current_transaction_snapshot_boundary(
    snapshot: &CurrentTransactionSnapshot,
) -> Result<(), BoundaryValidationError> {
    let mut issues = Vec::new();
    let has_order_no = snapshot
        .order_no
        .as_deref()
        .is_some_and(|order_no| !order_no.is_empty());

    if has_order_no && snapshot.next_action.is_none() {
        issues.push("current transaction snapshots must include nextAction");
    }

    if let Some(total_amount_cents) = snapshot.total_amount_cents {
        if total_amount_cents < 0 {
            issues.push("transaction snapshots must not include negative totalAmountCents");
        }
    }

    if let Some(vending) = &snapshot.vending {
        if let Some(pickup_reminder) = &vending.pickup_reminder {
            if let Some(remaining_seconds) = pickup_reminder.remaining_seconds {
                if remaining_seconds < 0 {
                    issues.push(
                        "pickup reminder snapshots must not include negative remainingSeconds",
                    );
                }
            }
        }
    }

    if has_order_no && snapshot.next_action == Some(CheckoutFlowAction::WaitPayment) {
        if snapshot.payment_method.is_none() {
            issues.push("awaiting-payment transaction snapshots must include paymentMethod");
        }
        if snapshot.total_amount_cents.is_none() {
            issues.push("awaiting-payment transaction snapshots must include totalAmountCents");
        }
    }

    if issues.is_empty() {
        Ok(())
    } else {
        Err(BoundaryValidationError { issues })
    }
}
