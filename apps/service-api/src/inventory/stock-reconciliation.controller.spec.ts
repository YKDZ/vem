import { BadRequestException } from "@nestjs/common";
import { adminStockReconciliationResolveRequestSchema } from "@vem/shared";
import { describe, expect, it, vi } from "vitest";

import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { StockReconciliationController } from "./stock-reconciliation.controller";

describe("StockReconciliationController", () => {
  it("lists stock reconciliation cases requiring review", async () => {
    const service = {
      listCases: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    };
    const controller = new StockReconciliationController(service as never);

    await controller.listCases({
      page: 1,
      pageSize: 20,
      machineId: "machine-1",
    });

    expect(service.listCases).toHaveBeenCalledWith({
      page: 1,
      pageSize: 20,
      machineId: "machine-1",
    });
  });

  it("opens stock reconciliation case detail evidence", async () => {
    const service = {
      getCase: vi.fn().mockResolvedValue({ id: "raw-1" }),
    };
    const controller = new StockReconciliationController(service as never);

    await controller.getCase("raw-1");

    expect(service.getCase).toHaveBeenCalledWith("raw-1");
  });

  it("resolves a stock reconciliation case as the current admin", async () => {
    const service = {
      resolveCase: vi.fn().mockResolvedValue({ id: "raw-1" }),
    };
    const controller = new StockReconciliationController(service as never);

    await controller.resolveCase({ id: "admin-1" } as never, "raw-1", {
      action: "manual_correct",
      correctedOnHandQty: 3,
      note: "现场复核为 3 件",
      clearBlocker: true,
    });

    expect(service.resolveCase).toHaveBeenCalledWith("admin-1", "raw-1", {
      action: "manual_correct",
      correctedOnHandQty: 3,
      note: "现场复核为 3 件",
      clearBlocker: true,
    });
  });

  it("rejects unsupported resolution fields at the Admin API contract boundary", () => {
    const pipe = new ZodValidationPipe(
      adminStockReconciliationResolveRequestSchema,
    );

    expect(() =>
      pipe.transform({
        action: "accept_machine_stock",
        note: "counted by machine",
        correctedOnHandQty: 3,
      } as never),
    ).toThrow(BadRequestException);
    expect(() =>
      pipe.transform({
        action: "manual_correct",
        note: "   ",
        correctedOnHandQty: 3,
      }),
    ).toThrow(BadRequestException);
  });
});
