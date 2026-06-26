import { describe, expect, it, vi } from "vitest";

import type { OrdersService } from "./orders.service";

import { REQUIRED_PERMISSIONS_KEY } from "../access/permissions.decorator";
import { OrdersController } from "./orders.controller";

describe("OrdersController", () => {
  it("requires orders.read for order investigation and forwards the order id", async () => {
    const investigation = { order: { id: "order-1" } };
    const ordersService = {
      getOrderInvestigation: vi.fn().mockResolvedValue(investigation),
    } as unknown as OrdersService;
    const controller = new OrdersController(ordersService);

    const permissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      OrdersController.prototype.getOrderInvestigation,
    );

    expect(permissions).toEqual(["orders.read"]);
    await expect(
      controller.getOrderInvestigation("550e8400-e29b-41d4-a716-446655440000", {
        id: "admin-1",
        username: "admin",
        displayName: "Admin",
        roles: [],
        permissions: ["orders.read", "payments.read"],
      }),
    ).resolves.toBe(investigation);
    expect(ordersService.getOrderInvestigation).toHaveBeenCalledWith(
      "550e8400-e29b-41d4-a716-446655440000",
      ["orders.read", "payments.read"],
    );
  });

  it("requires orders.recover for recovery actions and forwards admin note", async () => {
    const result = { action: "confirm_dispensed" };
    const ordersService = {
      createRecoveryAction: vi.fn().mockResolvedValue(result),
    } as unknown as OrdersService;
    const controller = new OrdersController(ordersService);

    const permissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      OrdersController.prototype.createRecoveryAction,
    );

    expect(permissions).toEqual(["orders.recover"]);
    await expect(
      controller.createRecoveryAction(
        "550e8400-e29b-41d4-a716-446655440000",
        {
          id: "admin-1",
          username: "admin",
          displayName: "Admin",
          roles: [],
          permissions: ["orders.read", "orders.recover"],
        },
        {
          action: "confirm_dispensed",
          note: "operator confirmed customer received item",
        },
      ),
    ).resolves.toBe(result);
    expect(ordersService.createRecoveryAction).toHaveBeenCalledWith(
      "550e8400-e29b-41d4-a716-446655440000",
      "admin-1",
      {
        action: "confirm_dispensed",
        note: "operator confirmed customer received item",
      },
    );
  });
});
