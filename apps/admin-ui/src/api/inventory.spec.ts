import {
  adminAdjustInventoryContract,
  adminCreateInventoryContract,
  adminListInventoryMovementsContract,
  adminListInventoriesContract,
  adminListStockReconciliationCasesContract,
  adminResolveStockReconciliationCaseContract,
} from "@vem/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { callAdminEndpointContract } from "@/api/request";

import {
  adjustInventory,
  createInventory,
  listInventories,
  listInventoryMovements,
  listStockReconciliationCases,
  resolveStockReconciliationCase,
} from "./inventory";

vi.mock("@/api/request", () => ({
  callAdminEndpointContract: vi.fn().mockResolvedValue({}),
}));

describe("inventory api", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(callAdminEndpointContract).mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    });
  });

  it("uses complete shared endpoint contracts for inventory writes", async () => {
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

    expect(callAdminEndpointContract).toHaveBeenCalledWith(
      adminCreateInventoryContract,
      { body: expect.objectContaining({ onHandQty: 10 }) },
    );
    expect(callAdminEndpointContract).toHaveBeenCalledWith(
      adminAdjustInventoryContract,
      { body: expect.objectContaining({ deltaQty: -1 }) },
    );
    expect(callAdminEndpointContract).toHaveBeenCalledWith(
      adminResolveStockReconciliationCaseContract,
      {
        pathParams: { id: "550e8400-e29b-41d4-a716-446655440004" },
        body: expect.objectContaining({ action: "manual_correct" }),
      },
    );
  });

  it("rejects invalid stock reconciliation resolution bodies through the shared contract", () => {
    expect(() =>
      adminResolveStockReconciliationCaseContract.bodySchema.parse({
        action: "accept_machine_stock",
        note: "counted by machine",
      }),
    ).toThrow();
    expect(() =>
      adminResolveStockReconciliationCaseContract.bodySchema.parse({
        action: "manual_correct",
        note: "   ",
        correctedOnHandQty: 4,
      }),
    ).toThrow();
  });

  it("parses key inventory queries and responses through shared contracts", async () => {
    await listInventories({ page: 1, pageSize: 200 });
    await listInventoryMovements({ page: 1, pageSize: 20 });
    await listStockReconciliationCases({ page: 1, machineId: undefined });

    expect(callAdminEndpointContract).toHaveBeenCalledWith(
      adminListInventoriesContract,
      { query: { page: 1, pageSize: 200 } },
    );
    expect(callAdminEndpointContract).toHaveBeenCalledWith(
      adminListInventoryMovementsContract,
      { query: { page: 1, pageSize: 20 } },
    );
    expect(callAdminEndpointContract).toHaveBeenCalledWith(
      adminListStockReconciliationCasesContract,
      { query: { page: 1, machineId: undefined } },
    );
  });
});
