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

export type CustomerCheckoutView =
  | {
      stage: "none";
      routeTarget: CustomerCheckoutRouteTarget;
      orderCredential: null;
      payment: null;
      restored: boolean;
    }
  | {
      stage: "payment";
      routeTarget: CustomerCheckoutRouteTarget;
      orderCredential: string;
      payment: CustomerCheckoutPaymentView;
      restored: boolean;
    }
  | {
      stage: "dispensing" | "result";
      routeTarget: CustomerCheckoutRouteTarget;
      orderCredential: string;
      payment: null;
      restored: boolean;
    };

export type ProjectCustomerCheckoutViewInput = {
  transaction: TransactionSnapshot | null;
  nowMs: number;
  dismissedTerminalOrderNos: readonly string[];
  restored: boolean;
  loading?: boolean;
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

  return {
    stage: transaction.nextAction === "dispensing" ? "dispensing" : "result",
    routeTarget: projectRouteTarget(transaction.nextAction),
    orderCredential: transaction.orderNo,
    payment: null,
    restored: input.restored,
  };
}
