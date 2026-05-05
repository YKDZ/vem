import { describe, expect, it } from "vitest";

import {
  adminUserStatuses,
  heartbeatPayloadSchema,
  machineSlotStatuses,
  orderStatuses,
  paymentProviderStatuses,
  roleStatuses,
} from "./index";

describe("shared API contract", () => {
  it("uses backend order status values", () => {
    expect(orderStatuses).toContain("pending_payment");
    expect(orderStatuses).toContain("fulfilled");
    expect(orderStatuses).not.toContain("pending");
    expect(orderStatuses).not.toContain("completed");
  });

  it("uses backend status enums for management forms", () => {
    expect(machineSlotStatuses).toEqual(["enabled", "disabled", "faulted"]);
    expect(paymentProviderStatuses).toEqual(["enabled", "disabled"]);
    expect(adminUserStatuses).toEqual(["active", "disabled"]);
    expect(roleStatuses).toEqual(["active", "disabled"]);
  });

  it("accepts structured machine heartbeat payload", () => {
    expect(
      heartbeatPayloadSchema.parse({
        machineCode: "M001",
        reportedAt: "2026-05-05T12:00:00.000Z",
        statusPayload: {
          appVersion: "0.1.0",
          network: "online",
          mqttConnected: true,
          hardwareStatus: "ok",
          localQueueSize: 0,
        },
      }).statusPayload.mqttConnected,
    ).toBe(true);
  });
});
