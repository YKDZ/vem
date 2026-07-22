import { afterEach, describe, expect, it } from "vitest";

import {
  installCustomerErrorEvidenceTrace,
  recordCustomerErrorEvidence,
} from "./customer-error-evidence";
import { createMachineRuntimeTrace } from "./machine-runtime-trace";

describe("customer error evidence", () => {
  afterEach(() => {
    installCustomerErrorEvidenceTrace(null);
  });

  it("retains correlated technical detail in the local runtime trace", () => {
    const trace = createMachineRuntimeTrace();
    installCustomerErrorEvidenceTrace(trace);

    recordCustomerErrorEvidence({
      stage: "payment_creation",
      customerMessage: "支付订单创建失败，请稍后重试",
      technicalMessage: "HTTP 502 provider MQTT IPC serial COM3 schema failed",
      operation: "checkout.create_order",
      checkoutAttemptIdempotencyKey: "checkout:attempt-error-001",
      orderId: "order-error-001",
      paymentId: "payment-error-001",
      orderNo: "ORD-ERROR-001",
    });

    expect(trace.entries()).toContainEqual(
      expect.objectContaining({
        type: "customer_error",
        stage: "payment_creation",
        customerMessage: "支付订单创建失败，请稍后重试",
        technicalMessage:
          "HTTP 502 provider MQTT IPC serial COM3 schema failed",
        operation: "checkout.create_order",
        checkoutAttemptIdempotencyKey: "checkout:attempt-error-001",
        orderId: "order-error-001",
        paymentId: "payment-error-001",
        orderNo: "ORD-ERROR-001",
      }),
    );
  });
});
