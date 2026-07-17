import type { INestApplication } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";

import { ConflictException, ForbiddenException } from "@nestjs/common";
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
  it("exposes only the authenticated machine's provisioning refresh snapshot", async () => {
    const snapshot = { machine: { id: "machine-1", code: "M001" } };
    const getOwnProvisioningProfile = vi.fn().mockResolvedValue(snapshot);
    const controller = new MachinesController({
      getOwnProvisioningProfile,
    } as never);
    const guards =
      Reflect.getMetadata(
        GUARDS_METADATA,
        MachinesController.prototype.getOwnProvisioningProfile,
      ) ?? [];

    expect(guards).toContain(MachineAuthGuard);
    await expect(
      controller.getOwnProvisioningProfile(
        { id: "machine-1", code: "M001" } as never,
        "M001",
      ),
    ).resolves.toEqual(snapshot);
    expect(getOwnProvisioningProfile).toHaveBeenCalledWith("machine-1");
    await expect(
      controller.getOwnProvisioningProfile(
        { id: "machine-1", code: "M001" } as never,
        "M002",
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it("requires machines.write and forwards the requester when updating machine location", async () => {
    const updateMachine = vi.fn().mockResolvedValue({ id: "machine-1" });
    const controller = new MachinesController({ updateMachine } as never);

    const permissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      MachinesController.prototype.updateMachine,
    );

    expect(permissions).toEqual(["machines.write"]);
    await expect(
      controller.updateMachine(
        { id: "admin-1" } as never,
        "550e8400-e29b-41d4-a716-446655440000",
        {
          geoLocation: {
            latitude: 31.2304,
            longitude: 121.4737,
            timezone: "Asia/Shanghai",
          },
        },
      ),
    ).resolves.toEqual({ id: "machine-1" });
    expect(updateMachine).toHaveBeenCalledWith(
      "550e8400-e29b-41d4-a716-446655440000",
      {
        geoLocation: {
          latitude: 31.2304,
          longitude: 121.4737,
          timezone: "Asia/Shanghai",
        },
      },
      "admin-1",
    );
  });

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

describe("MachinesController slot contract validation", () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("rejects unknown admin slot creation fields at the HTTP boundary", async () => {
    const createSlot = vi.fn().mockResolvedValue({
      id: "550e8400-e29b-41d4-a716-446655440111",
      machineId: "550e8400-e29b-41d4-a716-446655440000",
      layerNo: 1,
      cellNo: 1,
      slotCode: "A1",
      capacity: 10,
      status: "enabled",
    });
    const module = await Test.createTestingModule({
      controllers: [MachinesController],
      providers: [
        {
          provide: MachinesService,
          useValue: { createSlot },
        },
        {
          provide: MachineAuthService,
          useValue: { verifyToken: vi.fn() },
        },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();

    await request(app.getHttpServer())
      .post("/machines/550e8400-e29b-41d4-a716-446655440000/slots")
      .send({
        layerNo: 1,
        cellNo: 1,
        slotCode: "A1",
        capacity: 10,
        status: "enabled",
        inventoryShortcut: true,
      })
      .expect(400);

    expect(createSlot).not.toHaveBeenCalled();
  });
});

describe("MachinesController External Natural Environment", () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("requires machines.read for admin machine environment diagnostics", async () => {
    const getExternalNaturalEnvironmentForMachine = vi.fn().mockResolvedValue({
      status: "unconfigured",
      machineId: "550e8400-e29b-41d4-a716-446655440000",
      machineCode: "M001",
      checkedAt: "2026-06-30T14:00:00.000Z",
      diagnostic: {
        reason: "machine_geo_location_missing",
        message: "Machine Geo Location is not configured",
      },
    });
    const controller = new MachinesController({
      getExternalNaturalEnvironmentForMachine,
    } as never);

    const permissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      MachinesController.prototype.getExternalNaturalEnvironment,
    );

    expect(permissions).toEqual(["machines.read"]);
    await expect(
      controller.getExternalNaturalEnvironment(
        "550e8400-e29b-41d4-a716-446655440000",
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        status: "unconfigured",
        diagnostic: expect.objectContaining({
          reason: "machine_geo_location_missing",
        }),
      }),
    );
    expect(getExternalNaturalEnvironmentForMachine).toHaveBeenCalledWith(
      "550e8400-e29b-41d4-a716-446655440000",
    );
  });

  it("allows a machine to read only its own External Natural Environment", async () => {
    const getExternalNaturalEnvironmentForMachineCode = vi
      .fn()
      .mockResolvedValue({
        status: "unconfigured",
        machineId: "550e8400-e29b-41d4-a716-446655440000",
        machineCode: "M001",
        checkedAt: "2026-06-30T14:00:00.000Z",
        diagnostic: {
          reason: "machine_geo_location_missing",
          message: "Machine Geo Location is not configured",
        },
      });
    const controller = new MachinesController({
      getExternalNaturalEnvironmentForMachineCode,
    } as never);

    const isPublic = Reflect.getMetadata(
      IS_PUBLIC_KEY,
      MachinesController.prototype.getOwnExternalNaturalEnvironment,
    );
    const guards =
      Reflect.getMetadata(
        GUARDS_METADATA,
        MachinesController.prototype.getOwnExternalNaturalEnvironment,
      ) ?? [];

    expect(isPublic).toBe(true);
    expect(guards).toContain(MachineAuthGuard);
    await expect(
      controller.getOwnExternalNaturalEnvironment(
        { code: "M001" } as never,
        "M001",
      ),
    ).resolves.toEqual(expect.objectContaining({ status: "unconfigured" }));
    await expect(
      controller.getOwnExternalNaturalEnvironment(
        { code: "M001" } as never,
        "M002",
      ),
    ).rejects.toThrow(ForbiddenException);

    expect(getExternalNaturalEnvironmentForMachineCode).toHaveBeenCalledTimes(
      1,
    );
    expect(getExternalNaturalEnvironmentForMachineCode).toHaveBeenCalledWith(
      "M001",
    );
  });

  it("routes machine-authenticated External Natural Environment reads through the machine API route", async () => {
    const getExternalNaturalEnvironmentForMachine = vi.fn();
    const getExternalNaturalEnvironmentForMachineCode = vi
      .fn()
      .mockResolvedValue({
        status: "unconfigured",
        machineId: "550e8400-e29b-41d4-a716-446655440000",
        machineCode: "M001",
        checkedAt: "2026-06-30T14:00:00.000Z",
        diagnostic: {
          reason: "machine_geo_location_missing",
          message: "Machine Geo Location is not configured",
        },
      });
    const verifyToken = vi.fn().mockResolvedValue({
      id: "550e8400-e29b-41d4-a716-446655440000",
      code: "M001",
      status: "online",
    });
    const module = await Test.createTestingModule({
      controllers: [MachinesController],
      providers: [
        {
          provide: MachinesService,
          useValue: {
            getExternalNaturalEnvironmentForMachine,
            getExternalNaturalEnvironmentForMachineCode,
          },
        },
        {
          provide: MachineAuthService,
          useValue: { verifyToken },
        },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();

    await request(app.getHttpServer())
      .get("/machines/by-code/M001/external-natural-environment")
      .set("Authorization", "Bearer machine-token")
      .expect(200)
      .expect((response) => {
        expect(response.body).toEqual(
          expect.objectContaining({
            status: "unconfigured",
            machineCode: "M001",
          }),
        );
      });

    expect(verifyToken).toHaveBeenCalledWith("machine-token");
    expect(getExternalNaturalEnvironmentForMachine).not.toHaveBeenCalled();
    expect(getExternalNaturalEnvironmentForMachineCode).toHaveBeenCalledWith(
      "M001",
    );
  });

  it("rejects machine-authenticated External Natural Environment reads for another machine code through HTTP", async () => {
    const getExternalNaturalEnvironmentForMachineCode = vi.fn();
    const verifyToken = vi.fn().mockResolvedValue({
      id: "550e8400-e29b-41d4-a716-446655440000",
      code: "M001",
      status: "online",
    });
    const module = await Test.createTestingModule({
      controllers: [MachinesController],
      providers: [
        {
          provide: MachinesService,
          useValue: { getExternalNaturalEnvironmentForMachineCode },
        },
        {
          provide: MachineAuthService,
          useValue: { verifyToken },
        },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();

    await request(app.getHttpServer())
      .get("/machines/by-code/M002/external-natural-environment")
      .set("Authorization", "Bearer machine-token")
      .expect(403);

    expect(verifyToken).toHaveBeenCalledWith("machine-token");
    expect(getExternalNaturalEnvironmentForMachineCode).not.toHaveBeenCalled();
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
      controller.claimMachine({
        claimCode: "ABCD-2345",
      }),
    ).resolves.toEqual({
      machine: { id: "machine-1", code: "M001" },
    });
    expect(claimMachine).toHaveBeenCalledWith({
      claimCode: "ABCD-2345",
    });
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
      .send({
        claimCode: "ABCD-2345",
      })
      .expect(201);

    expect(claimMachine).toHaveBeenCalledWith({
      claimCode: "ABCD-2345",
    });
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
      { purpose: "first_claim" },
    );
  });

  it("forwards explicit reclaim intent when generating a claim code", async () => {
    const generateMachineClaimCode = vi.fn().mockResolvedValue({
      id: "claim-code-1",
      claimCode: "ABCD-2345",
      purpose: "reclaim",
      state: "pending",
    });
    const controller = new MachinesController({
      generateMachineClaimCode,
    } as never);

    await expect(
      controller.generateClaimCode(
        { id: "admin-1" } as never,
        "550e8400-e29b-41d4-a716-446655440000",
        { purpose: "reclaim" },
      ),
    ).resolves.toEqual({
      id: "claim-code-1",
      claimCode: "ABCD-2345",
      purpose: "reclaim",
      state: "pending",
    });
    expect(generateMachineClaimCode).toHaveBeenCalledWith(
      "550e8400-e29b-41d4-a716-446655440000",
      "admin-1",
      { purpose: "reclaim" },
    );
  });

  it("returns conflict when reclaim generation is rejected for an unclaimed machine", async () => {
    const generateMachineClaimCode = vi
      .fn()
      .mockRejectedValue(
        new ConflictException("Machine has not been claimed yet"),
      );
    const module = await Test.createTestingModule({
      controllers: [MachinesController],
      providers: [
        { provide: MachinesService, useValue: { generateMachineClaimCode } },
        {
          provide: MachineAuthService,
          useValue: { verifyToken: vi.fn() },
        },
      ],
    }).compile();
    app = module.createNestApplication();
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as Request & { user: { id: string } }).user = { id: "admin-1" };
      next();
    });
    await app.init();

    await request(app.getHttpServer())
      .post("/machines/550e8400-e29b-41d4-a716-446655440000/claim-codes")
      .send({ purpose: "reclaim" })
      .expect(409);

    expect(generateMachineClaimCode).toHaveBeenCalledWith(
      "550e8400-e29b-41d4-a716-446655440000",
      "admin-1",
      { purpose: "reclaim" },
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
        {},
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

  it("uses machine identity for stock snapshot fetch", async () => {
    const getStockSnapshotByMachineCode = vi.fn().mockResolvedValue({
      machineCode: "M001",
      planogramVersion: "PLAN-1",
      slots: [],
    });
    const controller = new MachinesController({
      getStockSnapshotByMachineCode,
    } as never);

    await expect(
      controller.getMachineStockSnapshot({ code: "M001" } as never, "M001"),
    ).resolves.toEqual({
      machineCode: "M001",
      planogramVersion: "PLAN-1",
      slots: [],
    });
    await expect(
      controller.getMachineStockSnapshot({ code: "M001" } as never, "M002"),
    ).resolves.toEqual({
      machineCode: "M001",
      planogramVersion: "PLAN-1",
      slots: [],
    });

    expect(getStockSnapshotByMachineCode).toHaveBeenNthCalledWith(1, "M001");
    expect(getStockSnapshotByMachineCode).toHaveBeenNthCalledWith(
      2,
      "__forbidden__",
    );
  });
});
