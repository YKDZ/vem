import type { INestApplication } from "@nestjs/common";

import { GUARDS_METADATA } from "@nestjs/common/constants";
import { APP_GUARD } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AccessService } from "../access/access.service";
import { REQUIRED_PERMISSIONS_KEY } from "../access/permissions.decorator";
import { PermissionsGuard } from "../access/permissions.guard";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { IS_PUBLIC_KEY } from "../auth/public.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { AppConfigService } from "../config/app-config.service";
import { MachineAuthGuard } from "../machine-auth/machine-auth.guard";
import { MachineAuthService } from "../machine-auth/machine-auth.service";
import { MachinesController } from "./machines.controller";
import { MachinesService } from "./machines.service";

describe("MachinesController environment commands", () => {
  it("requires machines.command and forwards the requester", async () => {
    const commandEnvironment = vi.fn().mockResolvedValue({ id: "command-1" });
    const controller = new MachinesController({ commandEnvironment } as never);

    const permissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      MachinesController.prototype.commandEnvironment,
    );

    expect(permissions).toEqual(["machines.command"]);
    await expect(
      controller.commandEnvironment(
        { id: "admin-1" } as never,
        "550e8400-e29b-41d4-a716-446655440000",
        { airConditionerOn: true },
      ),
    ).resolves.toEqual({ id: "command-1" });
    expect(commandEnvironment).toHaveBeenCalledWith(
      "550e8400-e29b-41d4-a716-446655440000",
      { airConditionerOn: true },
      "admin-1",
    );
  });
});

describe("MachinesController claim code lifecycle", () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("exposes public machine claim without machine or admin auth guards", async () => {
    const claimMachine = vi.fn().mockResolvedValue({
      machine: { id: "machine-1", code: "M001" },
    });
    const controller = new MachinesController({ claimMachine } as never);

    const permissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      MachinesController.prototype.claimMachine,
    );
    const isPublic = Reflect.getMetadata(
      IS_PUBLIC_KEY,
      MachinesController.prototype.claimMachine,
    );
    const guards =
      Reflect.getMetadata(
        GUARDS_METADATA,
        MachinesController.prototype.claimMachine,
      ) ?? [];

    expect(permissions).toBeUndefined();
    expect(isPublic).toBe(true);
    expect(guards).not.toContain(MachineAuthGuard);
    await expect(
      controller.claimMachine({ claimCode: "ABCD-2345" }),
    ).resolves.toEqual({
      machine: { id: "machine-1", code: "M001" },
    });
    expect(claimMachine).toHaveBeenCalledWith({ claimCode: "ABCD-2345" });
  });

  it("accepts unauthenticated HTTP claim requests while global admin auth guards are active", async () => {
    const transform = vi
      .spyOn(ZodValidationPipe.prototype, "transform")
      .mockImplementation((value) => value);
    const claimMachine = vi.fn().mockResolvedValue({
      machine: { id: "machine-1", code: "M001" },
      credentials: { machineSecret: "response-only-secret" },
    });
    const module = await Test.createTestingModule({
      controllers: [MachinesController],
      providers: [
        { provide: MachinesService, useValue: { claimMachine } },
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: PermissionsGuard },
        {
          provide: JwtService,
          useValue: { verifyAsync: vi.fn() },
        },
        {
          provide: AppConfigService,
          useValue: { jwtSecret: "test-jwt-secret-change-before-production" },
        },
        {
          provide: AccessService,
          useValue: { getAuthenticatedAdmin: vi.fn() },
        },
        {
          provide: MachineAuthService,
          useValue: { verifyToken: vi.fn() },
        },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();

    await request(app.getHttpServer()).post("/machines").send({}).expect(401);
    await request(app.getHttpServer())
      .post("/machines/claim")
      .send({ claimCode: "ABCD-2345" })
      .expect(201);

    expect(claimMachine).toHaveBeenCalledWith({ claimCode: "ABCD-2345" });
    transform.mockRestore();
  });

  it("requires machine credential permission and forwards the requester when generating a claim code", async () => {
    const generateMachineClaimCode = vi.fn().mockResolvedValue({
      id: "claim-code-1",
      claimCode: "ABCD-2345",
      state: "pending",
    });
    const controller = new MachinesController({
      generateMachineClaimCode,
    } as never);

    const permissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      MachinesController.prototype.generateClaimCode,
    );

    expect(permissions).toEqual(["machines.manage-credentials"]);
    await expect(
      controller.generateClaimCode(
        { id: "admin-1" } as never,
        "550e8400-e29b-41d4-a716-446655440000",
      ),
    ).resolves.toEqual({
      id: "claim-code-1",
      claimCode: "ABCD-2345",
      state: "pending",
    });
    expect(generateMachineClaimCode).toHaveBeenCalledWith(
      "550e8400-e29b-41d4-a716-446655440000",
      "admin-1",
    );
  });

  it("requires machine credential permission when listing claim code states", async () => {
    const listMachineClaimCodes = vi.fn().mockResolvedValue({
      items: [{ id: "claim-code-1", state: "pending" }],
    });
    const controller = new MachinesController({
      listMachineClaimCodes,
    } as never);

    const permissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      MachinesController.prototype.listClaimCodes,
    );

    expect(permissions).toEqual(["machines.manage-credentials"]);
    await expect(
      controller.listClaimCodes("550e8400-e29b-41d4-a716-446655440000"),
    ).resolves.toEqual({ items: [{ id: "claim-code-1", state: "pending" }] });
    expect(listMachineClaimCodes).toHaveBeenCalledWith(
      "550e8400-e29b-41d4-a716-446655440000",
    );
  });

  it("requires machine credential permission when reading a claim code detail", async () => {
    const getMachineClaimCode = vi.fn().mockResolvedValue({
      id: "550e8400-e29b-41d4-a716-446655440111",
      state: "locked",
    });
    const controller = new MachinesController({
      getMachineClaimCode,
    } as never);

    const permissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      MachinesController.prototype.getClaimCode,
    );

    expect(permissions).toEqual(["machines.manage-credentials"]);
    await expect(
      controller.getClaimCode(
        "550e8400-e29b-41d4-a716-446655440000",
        "550e8400-e29b-41d4-a716-446655440111",
      ),
    ).resolves.toEqual({
      id: "550e8400-e29b-41d4-a716-446655440111",
      state: "locked",
    });
    expect(getMachineClaimCode).toHaveBeenCalledWith(
      "550e8400-e29b-41d4-a716-446655440000",
      "550e8400-e29b-41d4-a716-446655440111",
    );
  });

  it("requires machine credential permission and forwards the requester when revoking a claim code", async () => {
    const revokeMachineClaimCode = vi.fn().mockResolvedValue({
      id: "550e8400-e29b-41d4-a716-446655440111",
      state: "revoked",
    });
    const controller = new MachinesController({
      revokeMachineClaimCode,
    } as never);

    const permissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      MachinesController.prototype.revokeClaimCode,
    );

    expect(permissions).toEqual(["machines.manage-credentials"]);
    await expect(
      controller.revokeClaimCode(
        { id: "admin-1" } as never,
        "550e8400-e29b-41d4-a716-446655440000",
        "550e8400-e29b-41d4-a716-446655440111",
      ),
    ).resolves.toEqual({
      id: "550e8400-e29b-41d4-a716-446655440111",
      state: "revoked",
    });
    expect(revokeMachineClaimCode).toHaveBeenCalledWith(
      "550e8400-e29b-41d4-a716-446655440000",
      "550e8400-e29b-41d4-a716-446655440111",
      "admin-1",
    );
  });
});

describe("MachinesController planogram lifecycle", () => {
  it("requires machines.write when publishing a planogram version", async () => {
    const publishMachinePlanogramVersion = vi
      .fn()
      .mockResolvedValue({ planogramVersion: "PLAN-1" });
    const controller = new MachinesController({
      publishMachinePlanogramVersion,
    } as never);

    const permissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      MachinesController.prototype.publishPlanogramVersion,
    );

    const body = { planogramVersion: "PLAN-1", slots: [] };
    expect(permissions).toEqual(["machines.write"]);
    await expect(
      controller.publishPlanogramVersion(
        { id: "admin-1" } as never,
        "550e8400-e29b-41d4-a716-446655440000",
        body as never,
      ),
    ).resolves.toEqual({ planogramVersion: "PLAN-1" });
    expect(publishMachinePlanogramVersion).toHaveBeenCalledWith(
      "550e8400-e29b-41d4-a716-446655440000",
      body,
      "admin-1",
    );
  });

  it("uses machine identity for published planogram fetch and ack", async () => {
    const getPublishedPlanogramByMachineCode = vi
      .fn()
      .mockResolvedValue({ planogramVersion: "PLAN-1" });
    const acknowledgeMachinePlanogramVersion = vi
      .fn()
      .mockResolvedValue({ status: "active" });
    const controller = new MachinesController({
      getPublishedPlanogramByMachineCode,
      acknowledgeMachinePlanogramVersion,
    } as never);

    await expect(
      controller.getPublishedPlanogramVersion(
        { code: "M001" } as never,
        "M001",
      ),
    ).resolves.toEqual({ planogramVersion: "PLAN-1" });
    await expect(
      controller.acknowledgePlanogramVersion(
        { code: "M001" } as never,
        "M001",
        "PLAN-1",
      ),
    ).resolves.toEqual({ status: "active" });

    expect(getPublishedPlanogramByMachineCode).toHaveBeenCalledWith("M001");
    expect(acknowledgeMachinePlanogramVersion).toHaveBeenCalledWith(
      "M001",
      "PLAN-1",
    );
  });
});
