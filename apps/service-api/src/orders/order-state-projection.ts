import type {
  OrderFulfillmentState,
  OrderPaymentState,
  OrderStatus,
} from "@vem/shared";

export function projectOrderStatus(input: {
  paymentState: OrderPaymentState;
  fulfillmentState: OrderFulfillmentState;
}): OrderStatus {
  if (input.paymentState === "payment_unknown") return "manual_handling";
  if (input.paymentState === "payment_expired") return "payment_expired";
  if (
    input.paymentState === "payment_failed" ||
    input.paymentState === "canceled"
  ) {
    return "canceled";
  }
  if (
    input.paymentState === "refund_pending" ||
    input.paymentState === "partial_refund_pending"
  ) {
    return "refund_pending";
  }
  if (input.paymentState === "manual_handling") return "manual_handling";
  if (
    input.paymentState === "refunded" ||
    input.paymentState === "partial_refunded"
  ) {
    return "refunded";
  }

  if (input.fulfillmentState === "manual_handling") {
    return "manual_handling";
  }
  if (
    input.fulfillmentState === "dispense_failed" ||
    input.fulfillmentState === "partial_dispensed"
  ) {
    return "dispense_failed";
  }
  if (input.fulfillmentState === "dispensed") return "fulfilled";
  if (input.fulfillmentState === "dispensing") return "dispensing";

  if (input.paymentState === "paid") return "paid";
  return "pending_payment";
}
