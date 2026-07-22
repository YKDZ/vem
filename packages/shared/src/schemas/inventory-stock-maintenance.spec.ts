import { describe, expect, it } from "vitest";

import {
  stockMaintenanceBatchRequestSchema,
  stockMaintenanceTaskSchema,
} from "./inventory";

const slot = {
  slotCode: "A1",
  layerNo: 1,
  cellNo: 1,
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
  it("projects recognizable slots without internal planogram or slot ids", () => {
    const task = stockMaintenanceTaskSchema.parse({
      taskId: "stock-task-01",
      mode: "initial_count",
      status: "ready",
      slots: [slot],
    });

    expect(task.slots[0]).toMatchObject({
      slotCode: "A1",
      productName: "矿泉水",
      currentQuantity: 3,
      submittedAddition: 2,
      previewQuantity: 5,
      movementId: "stock-task-01:550e8400-e29b-41d4-a716-446655440001",
      syncStatus: "accepted",
    });
    expect(task).not.toHaveProperty("planogramVersion");
    expect(task.slots[0]).not.toHaveProperty("slotId");
  });

  it("accepts final counts or refill additions under one daemon task id", () => {
    expect(
      stockMaintenanceBatchRequestSchema.parse({
        taskId: "stock-task-01",
        mode: "initial_count",
        slots: [{ slotCode: "A1", quantity: 6 }],
      }),
    ).toEqual({
      taskId: "stock-task-01",
      mode: "initial_count",
      slots: [{ slotCode: "A1", quantity: 6 }],
    });
    expect(
      stockMaintenanceBatchRequestSchema.parse({
        taskId: "stock-task-02",
        mode: "routine_refill",
        slots: [{ slotCode: "A1", addition: 2 }],
      }),
    ).toMatchObject({ mode: "routine_refill" });
    expect(() =>
      stockMaintenanceBatchRequestSchema.parse({
        taskId: "stock-task-02",
        mode: "routine_refill",
        operatorId: "typed-by-ui",
        slots: [{ slotCode: "A1", addition: 2 }],
      }),
    ).toThrow();
  });
});
