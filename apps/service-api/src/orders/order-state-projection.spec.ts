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
});
