import type { INestApplication } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";

import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MachineAuthService } from "../machine-auth/machine-auth.service";
import { MachineOpsController } from "./machine-ops.controller";
import { MachineOpsService } from "./machine-ops.service";

describe("MachineOpsController admin contracts", () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("uses the authenticated admin id when requesting a machine log export", async () => {
    const requestLogExport = vi.fn().mockResolvedValue({ id: "op-1" });
    const controller = new MachineOpsController({ requestLogExport } as never);

    await expect(
      controller.requestLogExport(
        "550e8400-e29b-41d4-a716-446655440000",
        {
          id: "550e8400-e29b-41d4-a716-446655440010",
          userId: "550e8400-e29b-41d4-a716-446655440099",
        } as never,
        {},
      ),
    ).resolves.toEqual({ id: "op-1" });

    expect(requestLogExport).toHaveBeenCalledWith(
      "550e8400-e29b-41d4-a716-446655440000",
      "550e8400-e29b-41d4-a716-446655440010",
    );
  });

  it("validates machine operation list query parameters with the shared schema", async () => {
    const listAllOps = vi.fn().mockResolvedValue([]);
    const module = await Test.createTestingModule({
      controllers: [MachineOpsController],
      providers: [
        { provide: MachineOpsService, useValue: { listAllOps } },
        { provide: MachineAuthService, useValue: { verifyToken: vi.fn() } },
      ],
    }).compile();
    app = module.createNestApplication();
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as Request & { user: { id: string } }).user = {
        id: "550e8400-e29b-41d4-a716-446655440010",
      };
      next();
    });
    await app.init();

    await request(app.getHttpServer())
      .get("/machine-ops?unexpected=true")
      .expect(400);

    expect(listAllOps).not.toHaveBeenCalled();
  });
});
