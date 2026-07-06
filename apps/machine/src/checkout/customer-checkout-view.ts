import type { MachineOrderStatusNextAction } from "@vem/shared";

import type { TransactionSnapshot } from "@/daemon/schemas";
import type { CheckoutResultKind } from "@/types/checkout";

import { getRemainingSeconds } from "@/utils/format";

export type CustomerCheckoutRouteTarget =
  | { name: "catalog" }
  | { name: "payment" }
  | { path: "/dispensing" }
  | { name: "result"; params: { kind: CheckoutResultKind } };

export type CustomerPaymentDisplay =
  | {
      kind: "qr";
      state: "pending" | "preparing" | "expired_confirming";
    }
  | {
      kind: "payment_code";
      state: "ready" | "in_flight" | "retryable" | "blocked";
      attemptStatus: NonNullable<
        TransactionSnapshot["paymentCodeAttempt"]
      >["status"];
      maskedAuthCode: string | null;
    };

export type CustomerCheckoutPaymentView = {
  method: NonNullable<TransactionSnapshot["paymentMethod"]>;
  provider: TransactionSnapshot["paymentProvider"];
  paymentUrl: string | null;
  expiresAt: string | null;
  totalAmountCents: number;
  remainingSeconds: number;
  canCancel: boolean;
  cancelDisabledReason:
    | null
    | "loading"
    | "expired_confirming"
    | "payment_code_in_flight"
    | "not_awaiting_payment"
    | "order_not_pending_payment"
    | "payment_not_cancelable";
  display: CustomerPaymentDisplay;
};

export type CustomerCheckoutDispensingView = {
  customerVisibleError: null | {
    kind: "failed" | "timeout" | "result_unknown";
  };
  pickupReminder: null | {
    stage:
      | "outlet_opened"
      | "pickup_waiting"
      | "pickup_completed"
      | "pickup_timeout_warning"
      | null;
    urgency: "info" | "warning" | "urgent";
    remainingSeconds: number | null;
    warningNo: number | null;
    reportedAt: string;
  };
};

export type CustomerCheckoutReturnRoute = "catalog" | "maintenance" | "offline";

export type CustomerCheckoutReturnPolicy = {
  canAutoReturn: boolean;
  canManualReturn: boolean;
  targetRoute: CustomerCheckoutReturnRoute;
  requiresMaintenanceReview: boolean;
};

export type CustomerCheckoutResultDisplayIntent =
  | "success"
  | "payment_failed"
  | "payment_expired"
  | "dispense_failure"
  | "refund_pending"
  | "refunded"
  | "manual_handling"
  | "closed";

export type CustomerCheckoutResultDetailIntent =
  | "dispense_failure"
  | "dispense_result_unknown"
  | "manual_handling";

export type CustomerCheckoutResultView = {
  kind: CheckoutResultKind;
  displayIntent: CustomerCheckoutResultDisplayIntent;
  detailIntent: CustomerCheckoutResultDetailIntent | null;
  orderCredentialBehavior: "hidden" | "shown";
  returnPolicy: CustomerCheckoutReturnPolicy;
};

export type CustomerCheckoutView =
  | {
      stage: "none";
      routeTarget: CustomerCheckoutRouteTarget;
      orderCredential: null;
      payment: null;
      dispensing: null;
      result: null;
      restored: boolean;
    }
  | {
      stage: "payment";
      routeTarget: CustomerCheckoutRouteTarget;
      orderCredential: string;
      payment: CustomerCheckoutPaymentView;
      dispensing: null;
      result: null;
      restored: boolean;
    }
  | {
      stage: "dispensing";
      routeTarget: CustomerCheckoutRouteTarget;
      orderCredential: string;
      payment: null;
      dispensing: CustomerCheckoutDispensingView;
      result: null;
      restored: boolean;
    }
  | {
      stage: "result";
      routeTarget: CustomerCheckoutRouteTarget;
      orderCredential: string;
      payment: null;
      dispensing: null;
      result: CustomerCheckoutResultView;
      restored: boolean;
    };

export type CustomerCheckoutReadinessContext = {
  saleReady: boolean;
  suggestedRoute: CustomerCheckoutReturnRoute;
  requiresMaintenanceReview: boolean;
};

export type ProjectCustomerCheckoutViewInput = {
  transaction: TransactionSnapshot | null;
  nowMs: number;
  dismissedTerminalOrderNos: readonly string[];
  restored: boolean;
  loading?: boolean;
  readiness?: CustomerCheckoutReadinessContext;
};

const terminalResultActions = new Set<MachineOrderStatusNextAction>([
  "success",
  "payment_failed",
  "payment_expired",
  "dispense_failed",
  "refund_pending",
  "refunded",
  "manual_handling",
  "closed",
]);

const paymentCodeInFlightStatuses = new Set([
  "submitting",
  "user_confirming",
  "querying",
  "reversing",
  "unknown",
  "manual_handling",
  "succeeded",
]);

function isTerminalResultAction(
  nextAction: string | null,
): nextAction is CheckoutResultKind {
  return Boolean(
    nextAction &&
    terminalResultActions.has(nextAction as MachineOrderStatusNextAction),
  );
}

function projectRouteTarget(
  nextAction: string | null,
): CustomerCheckoutRouteTarget {
  if (nextAction === "wait_payment") return { name: "payment" };
  if (nextAction === "dispensing") return { path: "/dispensing" };
  if (isTerminalResultAction(nextAction)) {
    return { name: "result", params: { kind: nextAction } };
  }
  return { name: "catalog" };
}

function returnRouteFromReadiness(
  readiness: CustomerCheckoutReadinessContext | undefined,
): CustomerCheckoutReturnRoute {
  if (readiness?.saleReady) return "catalog";
  return readiness?.suggestedRoute ?? "offline";
}

function successReturnPolicy(
  readiness: CustomerCheckoutReadinessContext | undefined,
): CustomerCheckoutReturnPolicy {
  const targetRoute = returnRouteFromReadiness(readiness);
  return {
    canAutoReturn: targetRoute === "catalog",
    canManualReturn: true,
    targetRoute,
    requiresMaintenanceReview: readiness?.requiresMaintenanceReview === true,
  };
}

function resultDisplayIntent(
  resultKind: CheckoutResultKind,
): CustomerCheckoutResultDisplayIntent {
  if (resultKind === "dispense_failed") return "dispense_failure";
  return resultKind;
}

function resultDetailIntent(
  transaction: TransactionSnapshot,
  resultKind: CheckoutResultKind,
): CustomerCheckoutResultDetailIntent | null {
  if (resultKind === "dispense_failed") return "dispense_failure";
  if (resultKind !== "manual_handling") return null;
  if (transaction.vending?.status === "result_unknown") {
    return "dispense_result_unknown";
  }
  return "manual_handling";
}

function exceptionalReturnPolicy(
  resultKind: CheckoutResultKind,
  readiness: CustomerCheckoutReadinessContext | undefined,
): CustomerCheckoutReturnPolicy {
  const targetRoute = returnRouteFromReadiness(readiness);
  const requiresMaintenanceReview =
    readiness?.requiresMaintenanceReview === true;
  const saleReady = readiness?.saleReady === true;
  const canDismissWhenReady =
    resultKind === "payment_failed" ||
    resultKind === "payment_expired" ||
    resultKind === "dispense_failed" ||
    resultKind === "refunded" ||
    resultKind === "closed";
  const highRiskResult =
    resultKind === "dispense_failed" ||
    resultKind === "refund_pending" ||
    resultKind === "manual_handling";

  return {
    canAutoReturn: false,
    canManualReturn: canDismissWhenReady
      ? saleReady && targetRoute === "catalog"
        ? !requiresMaintenanceReview
        : targetRoute === "maintenance" && !highRiskResult
      : false,
    targetRoute,
    requiresMaintenanceReview,
  };
}

function paymentDisplay(
  transaction: TransactionSnapshot,
  remainingSeconds: number,
): CustomerPaymentDisplay {
  if (transaction.paymentMethod === "payment_code") {
    const attempt = transaction.paymentCodeAttempt;
    if (!attempt) {
      return {
        kind: "payment_code",
        state: "ready",
        attemptStatus: null,
        maskedAuthCode: transaction.maskedAuthCode,
      };
    }
    return {
      kind: "payment_code",
      state: paymentCodeInFlightStatuses.has(attempt.status ?? "")
        ? "in_flight"
        : attempt.canRetry
          ? "retryable"
          : "blocked",
      attemptStatus: attempt.status,
      maskedAuthCode: attempt.maskedAuthCode ?? transaction.maskedAuthCode,
    };
  }

  if (remainingSeconds <= 0) {
    return { kind: "qr", state: "expired_confirming" };
  }
  if (transaction.paymentStatus === "processing" && !transaction.paymentUrl) {
    return { kind: "qr", state: "preparing" };
  }
  return { kind: "qr", state: "pending" };
}

function paymentMethodForTransaction(
  transaction: TransactionSnapshot,
): NonNullable<TransactionSnapshot["paymentMethod"]> {
  if (!transaction.paymentMethod) {
    throw new Error("payment transaction snapshot missing payment method");
  }
  return transaction.paymentMethod;
}

function totalAmountForTransaction(transaction: TransactionSnapshot): number {
  if (transaction.totalAmountCents === null) {
    throw new Error("payment transaction snapshot missing total amount");
  }
  return transaction.totalAmountCents;
}

function cancelDisabledReason(input: {
  transaction: TransactionSnapshot;
  display: CustomerPaymentDisplay;
  remainingSeconds: number;
  loading: boolean;
}): CustomerCheckoutPaymentView["cancelDisabledReason"] {
  const { transaction, display, loading, remainingSeconds } = input;
  if (loading) return "loading";
  if (transaction.nextAction !== "wait_payment") return "not_awaiting_payment";
  if (transaction.orderStatus !== "pending_payment")
    return "order_not_pending_payment";
  if (
    !["created", "pending", "processing"].includes(
      transaction.paymentStatus ?? "",
    )
  ) {
    return "payment_not_cancelable";
  }
  if (display.kind === "qr" && remainingSeconds <= 0) {
    return "expired_confirming";
  }
  if (
    display.kind === "payment_code" &&
    paymentCodeInFlightStatuses.has(display.attemptStatus ?? "")
  ) {
    return "payment_code_in_flight";
  }
  return null;
}

function customerVisibleDispensingError(
  transaction: TransactionSnapshot,
): CustomerCheckoutDispensingView["customerVisibleError"] {
  switch (transaction.vending?.status) {
    case "failed":
    case "timeout":
    case "result_unknown":
      return { kind: transaction.vending.status };
    default:
      return null;
  }
}

function dispensingPickupStage(
  stage: string | null | undefined,
): NonNullable<CustomerCheckoutDispensingView["pickupReminder"]>["stage"] {
  switch (stage) {
    case "outlet_opened":
    case "pickup_waiting":
    case "pickup_completed":
    case "pickup_timeout_warning":
      return stage;
    default:
      return null;
  }
}

function dispensingPickupReminder(
  transaction: TransactionSnapshot,
): CustomerCheckoutDispensingView["pickupReminder"] {
  const reminder = transaction.vending?.pickupReminder;
  if (!reminder) return null;
  return {
    stage: dispensingPickupStage(reminder.stage),
    urgency: reminder.level,
    remainingSeconds:
      typeof reminder.remainingSeconds === "number"
        ? reminder.remainingSeconds
        : null,
    warningNo: reminder.warningNo,
    reportedAt: reminder.reportedAt,
  };
}

export function projectCustomerCheckoutView(
  input: ProjectCustomerCheckoutViewInput,
): CustomerCheckoutView {
  const transaction = input.transaction;
  if (
    !transaction?.orderNo ||
    (isTerminalResultAction(transaction.nextAction) &&
      input.dismissedTerminalOrderNos.includes(transaction.orderNo))
  ) {
    return {
      stage: "none",
      routeTarget: { name: "catalog" },
      orderCredential: null,
      payment: null,
      dispensing: null,
      result: null,
      restored: input.restored,
    };
  }

  if (transaction.nextAction === "wait_payment") {
    const remainingSeconds = getRemainingSeconds(
      transaction.expiresAt,
      input.nowMs,
    );
    const display = paymentDisplay(transaction, remainingSeconds);
    const disabledReason = cancelDisabledReason({
      transaction,
      display,
      remainingSeconds,
      loading: input.loading === true,
    });
    return {
      stage: "payment",
      routeTarget: projectRouteTarget(transaction.nextAction),
      orderCredential: transaction.orderNo,
      restored: input.restored,
      dispensing: null,
      result: null,
      payment: {
        method: paymentMethodForTransaction(transaction),
        provider: transaction.paymentProvider,
        paymentUrl: transaction.paymentUrl,
        expiresAt: transaction.expiresAt,
        totalAmountCents: totalAmountForTransaction(transaction),
        remainingSeconds,
        canCancel: disabledReason === null,
        cancelDisabledReason: disabledReason,
        display,
      },
    };
  }

  if (transaction.nextAction === "dispensing") {
    return {
      stage: "dispensing",
      routeTarget: projectRouteTarget(transaction.nextAction),
      orderCredential: transaction.orderNo,
      payment: null,
      dispensing: {
        customerVisibleError: customerVisibleDispensingError(transaction),
        pickupReminder: dispensingPickupReminder(transaction),
      },
      result: null,
      restored: input.restored,
    };
  }

  const resultKind = isTerminalResultAction(transaction.nextAction)
    ? transaction.nextAction
    : "manual_handling";
  return {
    stage: "result",
    routeTarget: projectRouteTarget(transaction.nextAction),
    orderCredential: transaction.orderNo,
    payment: null,
    dispensing: null,
    result: {
      kind: resultKind,
      displayIntent: resultDisplayIntent(resultKind),
      detailIntent: resultDetailIntent(transaction, resultKind),
      orderCredentialBehavior: resultKind === "success" ? "hidden" : "shown",
      returnPolicy:
        resultKind === "success"
          ? successReturnPolicy(input.readiness)
          : exceptionalReturnPolicy(resultKind, input.readiness),
    },
    restored: input.restored,
  };
}
