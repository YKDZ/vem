import { describe, expect, it, vi } from "vitest";

import { REQUIRED_PERMISSIONS_KEY } from "../access/permissions.decorator";
import { PaymentDrillsController } from "./payment-drills.controller";

describe("PaymentDrillsController", () => {
  it("requires payments.configure to create protected payment drills", async () => {
    const result = { orderId: "order-1", isDrill: true };
    const service = {
      createDrill: vi.fn().mockResolvedValue(result),
      applyRecoveryAction: vi.fn(),
    };
    const controller = new PaymentDrillsController(service as never);

    const permissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      PaymentDrillsController.prototype.createDrill,
    );

    expect(permissions).toEqual(["payments.configure"]);
    await expect(
      controller.createDrill(
        {
          id: "admin-1",
          username: "operator",
          displayName: "Operator",
          roles: [],
          permissions: ["payments.configure"],
        },
        {
          machineId: "550e8400-e29b-41d4-a716-446655440000",
          scenario: "payment_code_unknown",
          reason: "pre-launch drill",
        },
      ),
    ).resolves.toBe(result);
    expect(service.createDrill).toHaveBeenCalledWith("admin-1", {
      machineId: "550e8400-e29b-41d4-a716-446655440000",
      scenario: "payment_code_unknown",
      reason: "pre-launch drill",
    });
  });

  it("requires payments.configure for drill recovery actions", async () => {
    const result = { orderId: "order-1", latestRecovery: {} };
    const service = {
      createDrill: vi.fn(),
      applyRecoveryAction: vi.fn().mockResolvedValue(result),
    };
    const controller = new PaymentDrillsController(service as never);

    const permissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      PaymentDrillsController.prototype.createRecoveryAction,
    );

    expect(permissions).toEqual(["payments.configure"]);
    await expect(
      controller.createRecoveryAction(
        {
          id: "admin-1",
          username: "operator",
          displayName: "Operator",
          roles: [],
          permissions: ["payments.configure"],
        },
        "550e8400-e29b-41d4-a716-446655440001",
        {
          action: "reverse_payment_code",
          reason: "operator rehearsed payment-code reversal",
        },
      ),
    ).resolves.toBe(result);
    expect(service.applyRecoveryAction).toHaveBeenCalledWith(
      "550e8400-e29b-41d4-a716-446655440001",
      "admin-1",
      {
        action: "reverse_payment_code",
        reason: "operator rehearsed payment-code reversal",
      },
    );
  });
});
