import { describe, expect, it } from "vitest";

import {
  stockMaintenanceBatchRequestSchema,
  stockMaintenanceTaskSchema,
} from "./inventory";

const slot = {
  slotId: "550e8400-e29b-41d4-a716-446655440001",
  rowNo: 1,
  cellNo: 1,
  slotDisplayLabel: "R1C1",
  productName: "矿泉水",
  sku: "WATER-01",
  capacity: 8,
  currentQuantity: 3,
  submittedQuantity: null,
  submittedAddition: 2,
  previewQuantity: 5,
  movementId: "stock-task-01:550e8400-e29b-41d4-a716-446655440001",
  syncStatus: "accepted",
  salesState: "sale_ready",
  reconciliationReason: null,
};

describe("planogram-driven stock maintenance contract", () => {
  it("projects one slot identity with a derived display label", () => {
    const task = stockMaintenanceTaskSchema.parse({
      taskId: "stock-task-01",
      mode: "initial_count",
      status: "ready",
      slots: [slot],
    });

    expect(task.slots[0]).toMatchObject({
      slotId: "550e8400-e29b-41d4-a716-446655440001",
      slotDisplayLabel: "R1C1",
      productName: "矿泉水",
      currentQuantity: 3,
      submittedAddition: 2,
      previewQuantity: 5,
      movementId: "stock-task-01:550e8400-e29b-41d4-a716-446655440001",
      syncStatus: "accepted",
    });
    expect(task).not.toHaveProperty("planogramVersion");
    expect(task.slots[0]).toHaveProperty("slotId");
  });

  it("accepts final counts or refill additions under one daemon task id", () => {
    expect(
      stockMaintenanceBatchRequestSchema.parse({
        taskId: "stock-task-01",
        mode: "initial_count",
        slots: [
          { slotId: "550e8400-e29b-41d4-a716-446655440001", quantity: 6 },
        ],
      }),
    ).toEqual({
      taskId: "stock-task-01",
      mode: "initial_count",
      slots: [{ slotId: "550e8400-e29b-41d4-a716-446655440001", quantity: 6 }],
    });
    expect(
      stockMaintenanceBatchRequestSchema.parse({
        taskId: "stock-task-02",
        mode: "routine_refill",
        slots: [
          { slotId: "550e8400-e29b-41d4-a716-446655440001", addition: 2 },
        ],
      }),
    ).toMatchObject({ mode: "routine_refill" });
    expect(() =>
      stockMaintenanceBatchRequestSchema.parse({
        taskId: "stock-task-02",
        mode: "routine_refill",
        operatorId: "typed-by-ui",
        slots: [
          { slotId: "550e8400-e29b-41d4-a716-446655440001", addition: 2 },
        ],
      }),
    ).toThrow();
  });
});
