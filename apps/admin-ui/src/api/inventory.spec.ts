import { beforeEach, describe, expect, it, vi } from "vitest";

import { getContract, postContract } from "@/api/request";

import {
  adjustInventory,
  createInventory,
  listInventories,
  listInventoryMovements,
  listStockReconciliationCases,
  resolveStockReconciliationCase,
} from "./inventory";

vi.mock("@/api/request", () => ({
  get: vi.fn().mockResolvedValue({}),
  getContract: vi.fn().mockResolvedValue({ items: [], total: 0 }),
  post: vi.fn(),
  postContract: vi.fn().mockResolvedValue({}),
}));

describe("inventory api", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getContract).mockResolvedValue({ items: [], total: 0 });
    vi.mocked(postContract).mockResolvedValue({});
  });

  it("uses schema-bound helpers for inventory writes", async () => {
    const inventoryId = "550e8400-e29b-41d4-a716-446655440000";

    await createInventory({
      machineId: "550e8400-e29b-41d4-a716-446655440001",
      slotId: "550e8400-e29b-41d4-a716-446655440002",
      variantId: "550e8400-e29b-41d4-a716-446655440003",
      onHandQty: 10,
      note: "initial binding",
    });
    await adjustInventory({
      inventoryId,
      deltaQty: -1,
      note: "counted shelf",
    });
    await resolveStockReconciliationCase(
      "550e8400-e29b-41d4-a716-446655440004",
      {
        action: "manual_correct",
        note: "现场复核为 4 件",
        correctedOnHandQty: 4,
        clearBlocker: true,
      },
    );

    expect(postContract).toHaveBeenCalledWith(
      "/inventories",
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({ onHandQty: 10 }),
    );
    expect(postContract).toHaveBeenCalledWith(
      "/inventories/adjust",
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({ deltaQty: -1 }),
    );
    expect(postContract).toHaveBeenCalledWith(
      "/stock-reconciliation-cases/550e8400-e29b-41d4-a716-446655440004/resolve",
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({ action: "manual_correct" }),
    );
  });

  it("rejects invalid stock reconciliation resolution bodies through the schema-bound helper", async () => {
    vi.mocked(postContract).mockImplementation(
      async (_url, bodySchema, _responseSchema, body) => {
        (bodySchema as { parse(value: unknown): unknown }).parse(body);
        throw new Error("expected invalid stock reconciliation body");
      },
    );

    const acceptMachineStockWithCorrection = {
      action: "accept_machine_stock" as const,
      note: "counted by machine",
      correctedOnHandQty: 4,
    };
    await expect(
      resolveStockReconciliationCase(
        "550e8400-e29b-41d4-a716-446655440004",
        acceptMachineStockWithCorrection,
      ),
    ).rejects.toThrow();
    await expect(
      resolveStockReconciliationCase("550e8400-e29b-41d4-a716-446655440004", {
        action: "manual_correct",
        note: "   ",
        correctedOnHandQty: 4,
      }),
    ).rejects.toThrow();
  });

  it("parses key inventory queries and responses through shared contracts", async () => {
    await listInventories({ page: 1, pageSize: 200 });
    await listInventoryMovements({ page: 1, pageSize: 20 });
    await listStockReconciliationCases({ page: 1, machineId: undefined });

    expect(getContract).toHaveBeenCalledWith(
      "/inventories",
      expect.any(Object),
      expect.any(Object),
      { page: 1, pageSize: 200 },
    );
    expect(getContract).toHaveBeenCalledWith(
      "/inventory-movements",
      expect.any(Object),
      expect.any(Object),
      { page: 1, pageSize: 20 },
    );
    expect(getContract).toHaveBeenCalledWith(
      "/stock-reconciliation-cases",
      expect.any(Object),
      expect.any(Object),
      { page: 1, machineId: undefined },
    );
  });
});
