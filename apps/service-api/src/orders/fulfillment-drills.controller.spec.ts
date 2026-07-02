import { describe, expect, it, vi } from "vitest";

import { REQUIRED_PERMISSIONS_KEY } from "../access/permissions.decorator";
import { FulfillmentDrillsController } from "./fulfillment-drills.controller";

describe("FulfillmentDrillsController", () => {
  it("requires orders.recover to create protected fulfillment drills", async () => {
    const result = { orderId: "order-1", isDrill: true };
    const service = {
      createDrill: vi.fn().mockResolvedValue(result),
      applyRecoveryAction: vi.fn(),
    };
    const controller = new FulfillmentDrillsController(service as never);

    const permissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      FulfillmentDrillsController.prototype.createDrill,
    );

    expect(permissions).toEqual(["orders.recover"]);
    await expect(
      controller.createDrill(
        {
          id: "admin-1",
          username: "operator",
          displayName: "Operator",
          roles: [],
          permissions: ["orders.recover"],
        },
        {
          machineId: "550e8400-e29b-41d4-a716-446655440000",
          scenario: "dispense_failed",
          reason: "pre-launch fulfillment drill",
        },
      ),
    ).resolves.toBe(result);
    expect(service.createDrill).toHaveBeenCalledWith("admin-1", {
      machineId: "550e8400-e29b-41d4-a716-446655440000",
      scenario: "dispense_failed",
      reason: "pre-launch fulfillment drill",
    });
  });

  it("requires orders.recover for fulfillment drill recovery actions", async () => {
    const result = { orderId: "order-1", latestRecovery: {} };
    const service = {
      createDrill: vi.fn(),
      applyRecoveryAction: vi.fn().mockResolvedValue(result),
    };
    const controller = new FulfillmentDrillsController(service as never);

    const permissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      FulfillmentDrillsController.prototype.createRecoveryAction,
    );

    expect(permissions).toEqual(["orders.recover"]);
    await expect(
      controller.createRecoveryAction(
        {
          id: "admin-1",
          username: "operator",
          displayName: "Operator",
          roles: [],
          permissions: ["orders.recover"],
        },
        "550e8400-e29b-41d4-a716-446655440001",
        {
          action: "confirm_not_dispensed",
          reason: "operator confirmed no item dispensed",
        },
      ),
    ).resolves.toBe(result);
    expect(service.applyRecoveryAction).toHaveBeenCalledWith(
      "550e8400-e29b-41d4-a716-446655440001",
      "admin-1",
      {
        action: "confirm_not_dispensed",
        reason: "operator confirmed no item dispensed",
      },
    );
  });
});
