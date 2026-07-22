import { describe, expect, it } from "vitest";

import {
  mapAdjustInventoryDtoToMovementInsert,
  mapCreateInventoryDtoToInsert,
  mapCreateInventoryDtoToMovementInsert,
  toAdminInventoryMovementResponse,
  toAdminInventoryResponse,
} from "./inventory.contract-mappers";

describe("inventory contract mappers", () => {
  it("maps inventory binding DTOs to supported database writes", () => {
    const insert = mapCreateInventoryDtoToInsert({
      machineId: "550e8400-e29b-41d4-a716-446655440000",
      slotId: "550e8400-e29b-41d4-a716-446655440001",
      variantId: "550e8400-e29b-41d4-a716-446655440002",
      onHandQty: 8,
      reservedQty: 1,
      lowStockThreshold: 2,
      note: "ignored by inventory row",
    });

    expect(insert).toEqual({
      machineId: "550e8400-e29b-41d4-a716-446655440000",
      slotId: "550e8400-e29b-41d4-a716-446655440001",
      variantId: "550e8400-e29b-41d4-a716-446655440002",
      onHandQty: 8,
      reservedQty: 1,
      lowStockThreshold: 2,
    });
    expect(insert).not.toHaveProperty("note");
  });

  it("maps inventory intervention movement notes and nullable relationships", () => {
    expect(
      mapCreateInventoryDtoToMovementInsert(
        "admin-1",
        "550e8400-e29b-41d4-a716-446655440003",
        {
          machineId: "550e8400-e29b-41d4-a716-446655440000",
          slotId: "550e8400-e29b-41d4-a716-446655440001",
          variantId: "550e8400-e29b-41d4-a716-446655440002",
          onHandQty: 8,
          reservedQty: 0,
          lowStockThreshold: 1,
        },
      ),
    ).toMatchObject({
      inventoryId: "550e8400-e29b-41d4-a716-446655440003",
      deltaQty: 8,
      reason: "adjust",
      operatorAdminUserId: "admin-1",
      note: "initial inventory binding",
    });
    expect(
      mapAdjustInventoryDtoToMovementInsert("admin-1", {
        inventoryId: "550e8400-e29b-41d4-a716-446655440003",
        deltaQty: -2,
        note: "counted stock",
      }),
    ).toMatchObject({
      deltaQty: -2,
      reason: "adjust",
      note: "counted stock",
    });
  });

  it("assembles inventory and movement Admin API responses", () => {
    const inventory = toAdminInventoryResponse({
      id: "550e8400-e29b-41d4-a716-446655440003",
      machineId: "550e8400-e29b-41d4-a716-446655440000",
      machineCode: "M001",
      slotId: "550e8400-e29b-41d4-a716-446655440001",
      slotCode: "A1",
      variantId: "550e8400-e29b-41d4-a716-446655440002",
      productId: "550e8400-e29b-41d4-a716-446655440004",
      sku: "SKU-1",
      productName: "Tea",
      onHandQty: 8,
      reservedQty: 1,
      availableQty: 7,
      lowStockThreshold: 2,
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
      updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    });
    expect(inventory.createdAt).toBe("2026-06-01T00:00:00.000Z");
    expect(inventory.availableQty).toBe(7);

    const movement = toAdminInventoryMovementResponse({
      id: "550e8400-e29b-41d4-a716-446655440005",
      inventoryId: inventory.id,
      deltaQty: 5,
      reason: "refill",
      orderId: null,
      orderNo: null,
      operatorAdminUserId: null,
      note: null,
      createdAt: new Date("2026-06-01T00:01:00.000Z"),
    });
    expect(movement.note).toBeNull();
    expect(movement.createdAt).toBe("2026-06-01T00:01:00.000Z");
  });
});
