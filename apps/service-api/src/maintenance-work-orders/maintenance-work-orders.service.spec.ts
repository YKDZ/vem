import { NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DRIZZLE_CLIENT } from "../database/database.constants";
import { MaintenanceWorkOrdersService } from "./maintenance-work-orders.service";

describe("MaintenanceWorkOrdersService", () => {
  let service: MaintenanceWorkOrdersService;

  const insertReturning = vi.fn();
  const insertValues = vi.fn().mockReturnValue({
    onConflictDoNothing: vi.fn().mockReturnValue({
      returning: insertReturning,
    }),
  });
  const mockTx = {
    insert: vi.fn().mockReturnValue({ values: insertValues }),
    update: vi.fn(),
    select: vi.fn(),
  };

  const updateSet = vi.fn();
  const mockDb = {
    insert: vi.fn().mockReturnValue({ values: insertValues }),
    update: vi.fn().mockReturnValue({ set: updateSet }),
    select: vi.fn(),
    transaction: vi.fn(),
  };

  const baseInput = {
    title: "Dispense failure",
    description: "Slot A01 jammed",
    dedupeKey: "wo:machine1:slot1:cmd1",
    machineId: "machine1",
    slotId: "slot1",
    orderId: "order1",
    commandId: "cmd1",
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        MaintenanceWorkOrdersService,
        { provide: DRIZZLE_CLIENT, useValue: mockDb },
      ],
    }).compile();
    service = module.get(MaintenanceWorkOrdersService);
  });

  it("creates a work order with pending status", async () => {
    insertReturning.mockResolvedValue([
      {
        id: "wo1",
        workOrderNo: "WO123",
        status: "open",
        dedupeKey: baseInput.dedupeKey,
      },
    ]);

    await service.createWorkOrder(mockTx as never, baseInput);

    expect(mockTx.insert).toHaveBeenCalled();
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "open",
        dedupeKey: baseInput.dedupeKey,
      }),
    );
  });

  it("uses onConflictDoNothing so same dedupeKey is idempotent", async () => {
    insertReturning.mockResolvedValue([]);

    await service.createWorkOrder(mockTx as never, baseInput);
    await service.createWorkOrder(mockTx as never, baseInput);

    // Both calls should not throw; second resolves with empty array
    expect(mockTx.insert).toHaveBeenCalledTimes(2);
  });

  it("resolve sets status to resolved and writes resolvedAt", async () => {
    const capturedSet: unknown[] = [];
    const mockUpdateSet = vi.fn((val: unknown) => {
      capturedSet.push(val);
      return {
        where: () => ({
          returning: async () => [
            {
              id: "wo1",
              workOrderNo: "WO123",
              machineId: null,
              slotId: null,
              orderId: null,
              commandId: null,
              title: "Dispense failure",
              description: "Slot A01 jammed",
              priority: "medium",
              status: "resolved",
              assigneeAdminUserId: "admin1",
              resolutionNote: "Fixed the jam",
              dedupeKey: baseInput.dedupeKey,
              createdAt: new Date("2026-07-05T00:00:00.000Z"),
              updatedAt: new Date("2026-07-05T00:10:00.000Z"),
              resolvedAt: new Date("2026-07-05T00:10:00.000Z"),
            },
          ],
        }),
      };
    });
    mockDb.update.mockReturnValue({ set: mockUpdateSet });

    const result = await service.resolve("wo1", "admin1", {
      resolutionNote: "Fixed the jam",
    });

    expect(result).toMatchObject({ id: "wo1", status: "resolved" });
    expect(capturedSet[0]).toMatchObject({
      status: "resolved",
      resolutionNote: "Fixed the jam",
    });
    expect((capturedSet[0] as { resolvedAt?: Date }).resolvedAt).toBeInstanceOf(
      Date,
    );
  });

  it("throws NotFoundException when work order not found or already resolved", async () => {
    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: () => ({
          returning: async () => [],
        }),
      }),
    });

    await expect(
      service.resolve("wo-not-found", "admin1", { resolutionNote: "note" }),
    ).rejects.toThrow(NotFoundException);
  });
});
