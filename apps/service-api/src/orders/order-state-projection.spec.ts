import { describe, expect, it } from "vitest";

import { projectOrderStatus } from "./order-state-projection";

describe("projectOrderStatus", () => {
  it("projects migrated legacy closed axes as canceled instead of preserving closed", () => {
    expect(
      projectOrderStatus({
        paymentState: "canceled",
        fulfillmentState: "canceled",
      }),
    ).toBe("canceled");
  });

  it("keeps a paid partially dispensed order on the failure path until refund state takes over", () => {
    expect(
      projectOrderStatus({
        paymentState: "paid",
        fulfillmentState: "partial_dispensed",
      }),
    ).toBe("dispense_failed");
  });
});
