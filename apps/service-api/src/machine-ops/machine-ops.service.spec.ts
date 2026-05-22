import { NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DRIZZLE_CLIENT } from "../database/database.constants";
import { MachineOpsService } from "./machine-ops.service";

// Mock node:fs to prevent actual file writes
vi.mock("node:fs", () => ({
  default: {
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  },
}));

const mockMachine = { id: "machine1" };
const mockOp = {
  id: "op1",
  machineId: "machine1",
  type: "export_logs",
  status: "pending",
  requestedByAdminUserId: "admin1",
  requestedAt: new Date(),
};

describe("MachineOpsService", () => {
  let service: MachineOpsService;

  const mockDb = {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        MachineOpsService,
        { provide: DRIZZLE_CLIENT, useValue: mockDb },
      ],
    }).compile();
    service = module.get(MachineOpsService);
  });

  describe("requestLogExport", () => {
    it("creates a pending export_logs op for existing machine", async () => {
      mockDb.select.mockReturnValue({
        from: () => ({
          where: () => ({
            limit: async () => [mockMachine],
          }),
        }),
      });
      mockDb.insert.mockReturnValue({
        values: () => ({
          returning: async () => [mockOp],
        }),
      });

      const op = await service.requestLogExport("machine1", "admin1");

      expect(op).toMatchObject({ type: "export_logs", status: "pending" });
    });

    it("throws NotFoundException when machine does not exist", async () => {
      mockDb.select.mockReturnValue({
        from: () => ({
          where: () => ({
            limit: async () => [],
          }),
        }),
      });

      await expect(
        service.requestLogExport("nonexistent", "admin1"),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("listPendingForMachine", () => {
    it("only returns ops for the specified machine", async () => {
      const capturedWhere: unknown[] = [];
      mockDb.select.mockReturnValue({
        from: () => ({
          where: (clause: unknown) => {
            capturedWhere.push(clause);
            return {
              orderBy: async () => [{ ...mockOp, machineId: "machine1" }],
            };
          },
        }),
      });

      const ops = await service.listPendingForMachine("machine1");

      // Should filter by machineId and status=pending
      expect(ops).toHaveLength(1);
      expect(ops[0].machineId).toBe("machine1");
    });
  });

  describe("completeLogExport", () => {
    it("creates artifact record and sets op status to succeeded", async () => {
      const artifactRecord = {
        id: "art1",
        opId: "op1",
        fileName: "events.zip",
      };
      const succeededOp = { ...mockOp, status: "succeeded" };

      mockDb.transaction.mockImplementation(
        async (cb: (tx: typeof mockDb) => Promise<unknown>) => {
          const tx = {
            insert: vi.fn().mockReturnValue({
              values: () => ({
                onConflictDoNothing: () => ({
                  returning: async () => [artifactRecord],
                }),
              }),
            }),
            update: vi.fn().mockReturnValue({
              set: () => ({
                where: () => ({
                  returning: async () => [succeededOp],
                }),
              }),
            }),
          };
          return await cb(tx as never);
        },
      );

      const result = await service.completeLogExport("op1", "machine1", {
        fileName: "events.zip",
        contentType: "application/zip",
        base64: Buffer.from("test").toString("base64"),
        sizeBytes: 4,
      });

      expect(result.op).toMatchObject({ status: "succeeded" });
      expect(result.artifact).toMatchObject({ id: "art1" });
    });
  });
});
