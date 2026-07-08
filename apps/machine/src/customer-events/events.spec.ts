import { describe, expect, it } from "vitest";

import {
  categoryForCustomerExperienceEvent,
  describeCustomerExperienceEvent,
  type CustomerExperienceEvent,
} from "./events";

describe("customer experience events", () => {
  it.each([
    "presence.detected",
    "presence.welcome.day",
    "presence.welcome.night",
    "interaction.awakened",
    "privacy.crowd_detected",
    "idle.assistance_prompt",
    "idle.sleep",
  ] as const)("maps %s to the presence audio category", (type) => {
    expect(categoryForCustomerExperienceEvent(type)).toBe("presence");
  });

  it.each([
    "product.selected",
    "payment.prompt",
    "payment.succeeded",
    "dispensing.started",
    "dispense.outlet_opened",
    "dispense.succeeded",
    "dispense.failed",
    "pickup.waiting",
    "pickup.warning",
    "pickup.urgent",
    "pickup.completed",
    "refund.pending",
    "refund.completed",
    "manual_handling.required",
    "system.hardware_fault",
  ] as const)("maps %s to the transaction audio category", (type) => {
    expect(categoryForCustomerExperienceEvent(type)).toBe("transaction");
  });

  it("describes an order-scoped customer event without requiring audio-specific names", () => {
    const event: CustomerExperienceEvent = {
      type: "product.selected",
      orderKey: "ORDER-1",
      requestedAt: "2026-07-02T13:00:00.000Z",
      nowMs: 1000,
    };

    expect(describeCustomerExperienceEvent(event)).toMatchObject({
      category: "transaction",
      eventKey: "product.selected",
      orderKey: "ORDER-1",
      requestedAt: "2026-07-02T13:00:00.000Z",
      nowMs: 1000,
    });
  });
});
