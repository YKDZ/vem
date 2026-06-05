import { BadRequestException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AuditService } from "../audit/audit.service";
import { AppConfigService } from "../config/app-config.service";
import { DRIZZLE_CLIENT } from "../database/database.constants";
import { MachineCredentialService } from "../machine-auth/machine-credential.service";
import { MqttSignatureService } from "../mqtt/mqtt-signature.service";
import { MqttService } from "../mqtt/mqtt.service";
import { MachinesService } from "./machines.service";

describe("MachinesService", () => {
  let service: MachinesService;

  const mockDb = {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn(),
  };
  const auditRecord = vi.fn();
  const publish = vi.fn();
  const signForMachine = vi.fn();
  const verifyFromTopic = vi.fn();

  beforeEach(async () => {
    vi.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        MachinesService,
        { provide: DRIZZLE_CLIENT, useValue: mockDb },
        { provide: MachineCredentialService, useValue: {} },
        { provide: AuditService, useValue: { record: auditRecord } },
        { provide: MqttService, useValue: { publish } },
        {
          provide: MqttSignatureService,
          useValue: { signForMachine, verifyFromTopic },
        },
        {
          provide: AppConfigService,
          useValue: { machineCommandTimeoutSeconds: 5 },
        },
      ],
    }).compile();
    service = module.get(MachinesService);
  });

  it("returns latest environment and command state in the machine list", async () => {
    const machine = {
      id: "machine-1",
      code: "M001",
      name: "Lobby",
      status: "online",
      deletedAt: null,
    };
    const latestCommand = {
      id: "command-1",
      machineId: "machine-1",
      commandNo: "MCMD-1",
      type: "environment-control",
      status: "acknowledged",
    };
    mockDb.select
      .mockReturnValueOnce({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: () => ({ offset: async () => [machine] }),
            }),
          }),
        }),
      })
      .mockReturnValueOnce({
        from: () => ({
          where: async () => [{ total: 1 }],
        }),
      })
      .mockReturnValueOnce({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: async () => [
                {
                  statusPayloadJson: {
                    environment: {
                      temperatureCelsius: 24,
                      humidityRh: 53,
                      sampledAt: "2026-05-05T12:00:00.000Z",
                      sensorStatus: "ok",
                      airConditionerOn: false,
                      targetTemperatureCelsius: null,
                    },
                  },
                },
              ],
            }),
          }),
        }),
      })
      .mockReturnValueOnce({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: async () => [latestCommand],
            }),
          }),
        }),
      });

    const result = await service.listMachines({ page: 1, pageSize: 20 });

    expect(result.items[0]).toEqual(
      expect.objectContaining({
        latestEnvironment: expect.objectContaining({
          temperatureCelsius: 24,
          sensorStatus: "ok",
        }),
        latestEnvironmentCommand: latestCommand,
      }),
    );
  });

  it("returns latest environment state from the most recent heartbeat", async () => {
    const machine = {
      id: "machine-1",
      code: "M001",
      name: "Lobby",
      status: "online",
      deletedAt: null,
    };
    mockDb.select
      .mockReturnValueOnce({
        from: () => ({
          where: () => ({
            limit: async () => [machine],
          }),
        }),
      })
      .mockReturnValueOnce({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: async () => [
                {
                  statusPayloadJson: {
                    environment: {
                      temperatureCelsius: 24,
                      humidityRh: 53,
                      sampledAt: "2026-05-05T12:00:00.000Z",
                      sensorStatus: "ok",
                      airConditionerOn: false,
                      targetTemperatureCelsius: null,
                    },
                  },
                },
              ],
            }),
          }),
        }),
      })
      .mockReturnValueOnce({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: async () => [
                {
                  id: "command-1",
                  machineId: "machine-1",
                  commandNo: "MCMD-1",
                  type: "environment-control",
                  status: "succeeded",
                },
              ],
            }),
          }),
        }),
      });

    const result = await service.getMachine("machine-1");

    expect(result.latestEnvironment).toEqual({
      temperatureCelsius: 24,
      humidityRh: 53,
      sampledAt: "2026-05-05T12:00:00.000Z",
      sensorStatus: "ok",
      airConditionerOn: false,
      targetTemperatureCelsius: null,
    });
    expect(result.latestEnvironmentCommand).toEqual(
      expect.objectContaining({ status: "succeeded" }),
    );
  });

  it("throws NotFoundException when machine does not exist", async () => {
    mockDb.select.mockReturnValueOnce({
      from: () => ({
        where: () => ({
          limit: async () => [],
        }),
      }),
    });

    await expect(service.getMachine("missing")).rejects.toThrow(
      NotFoundException,
    );
  });

  it("persists and publishes an environment control command", async () => {
    const machine = { id: "machine-1", code: "M001", deletedAt: null };
    const createdCommand = {
      id: "command-1",
      commandNo: "MCMD-1",
      machineId: "machine-1",
      type: "environment-control",
      status: "pending",
      payloadJson: {
        commandNo: "MCMD-1",
        airConditionerOn: true,
        timeoutSeconds: 5,
      },
    };
    const sentCommand = { ...createdCommand, status: "sent" };
    const insertValues = vi.fn().mockReturnValue({
      returning: async () => [createdCommand],
    });
    const updateSet = vi.fn().mockReturnValue({
      where: () => ({ returning: async () => [sentCommand] }),
    });

    mockDb.select.mockReturnValueOnce({
      from: () => ({
        where: () => ({
          limit: async () => [machine],
        }),
      }),
    });
    mockDb.insert.mockReturnValueOnce({ values: insertValues });
    mockDb.update.mockReturnValueOnce({ set: updateSet });
    signForMachine.mockResolvedValueOnce({ signed: true });
    publish.mockResolvedValueOnce(undefined);

    const result = await service.commandEnvironment(
      "machine-1",
      { airConditionerOn: true },
      "admin-1",
    );

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        commandNo: expect.stringMatching(/^MCMD/),
        machineId: "machine-1",
        type: "environment-control",
        status: "pending",
        payloadJson: expect.objectContaining({
          airConditionerOn: true,
          timeoutSeconds: 5,
        }),
        requestedByAdminUserId: "admin-1",
      }),
    );
    expect(signForMachine).toHaveBeenCalledWith({
      machineCode: "M001",
      messageId: "command:MCMD-1",
      payload: {
        commandNo: "MCMD-1",
        airConditionerOn: true,
        timeoutSeconds: 5,
      },
    });
    expect(publish).toHaveBeenCalledWith(
      "vem/machines/M001/commands/environment-control",
      { signed: true },
    );
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: "sent" }),
    );
    expect(auditRecord).toHaveBeenCalledWith({
      adminUserId: "admin-1",
      action: "machines.environmentControl.command",
      resourceType: "machine",
      resourceId: "machine-1",
      afterJson: expect.objectContaining({
        commandId: "command-1",
        commandNo: "MCMD-1",
        payload: expect.objectContaining({ airConditionerOn: true }),
      }),
    });
    expect(result).toEqual(sentCommand);
  });

  it("acknowledges an environment control machine command from MQTT ACK", async () => {
    const eventValues = vi.fn().mockReturnValue({
      onConflictDoNothing: () => ({
        returning: async () => [{ id: "event-1" }],
      }),
    });
    const commandSet = vi
      .fn()
      .mockReturnValue({ where: async () => undefined });
    const tx = {
      insert: vi.fn().mockReturnValue({ values: eventValues }),
      update: vi.fn().mockReturnValue({ set: commandSet }),
    };
    mockDb.transaction.mockImplementationOnce(
      async (cb: (txArg: typeof tx) => Promise<void>) => {
        await cb(tx);
      },
    );
    verifyFromTopic.mockResolvedValueOnce({
      machineId: "machine-1",
      machineCode: "M001",
      messageId: "ack:MCMD-1",
      payload: { messageId: "ack:MCMD-1" },
    });

    await service.handleMachineMessage(
      "vem/machines/M001/commands/MCMD-1/ack",
      JSON.stringify({}),
    );

    expect(eventValues).toHaveBeenCalledWith({
      machineId: "machine-1",
      eventType: "command_ack",
      payloadJson: { messageId: "ack:MCMD-1" },
      mqttTopic: "vem/machines/M001/commands/MCMD-1/ack",
      messageId: "ack:MCMD-1",
    });
    expect(commandSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: "acknowledged" }),
    );
  });

  it("marks an environment control command succeeded from MQTT result", async () => {
    const resultPayload = {
      commandNo: "MCMD-1",
      success: true,
      reportedAt: "2026-05-05T12:00:00.000Z",
      airConditionerOn: true,
      targetTemperatureCelsius: 24,
    };
    const eventValues = vi.fn().mockReturnValue({
      onConflictDoNothing: () => ({
        returning: async () => [{ id: "event-1" }],
      }),
    });
    const commandSet = vi
      .fn()
      .mockReturnValue({ where: async () => undefined });
    const tx = {
      insert: vi.fn().mockReturnValue({ values: eventValues }),
      update: vi.fn().mockReturnValue({ set: commandSet }),
    };
    mockDb.transaction.mockImplementationOnce(
      async (cb: (txArg: typeof tx) => Promise<void>) => {
        await cb(tx);
      },
    );
    verifyFromTopic.mockResolvedValueOnce({
      machineId: "machine-1",
      machineCode: "M001",
      messageId: "result:MCMD-1",
      payload: resultPayload,
    });

    await service.handleMachineMessage(
      "vem/machines/M001/events/environment-control-result",
      JSON.stringify({}),
    );

    expect(eventValues).toHaveBeenCalledWith({
      machineId: "machine-1",
      eventType: "environment_control_result",
      payloadJson: resultPayload,
      mqttTopic: "vem/machines/M001/events/environment-control-result",
      messageId: "result:MCMD-1",
    });
    expect(commandSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "succeeded",
        resultJson: resultPayload,
        lastError: null,
      }),
    );
  });

  it("marks overdue environment control machine commands timed out", async () => {
    const now = new Date("2026-05-05T12:00:06.000Z");
    const updateSet = vi.fn().mockReturnValue({
      where: () => ({ returning: async () => [{ id: "command-1" }] }),
    });
    mockDb.select.mockReturnValueOnce({
      from: () => ({
        where: async () => [
          {
            id: "command-1",
            commandNo: "MCMD-1",
            timeoutAt: new Date("2026-05-05T12:00:05.000Z"),
          },
          {
            id: "command-2",
            commandNo: "MCMD-2",
            timeoutAt: new Date("2026-05-05T12:00:07.000Z"),
          },
        ],
      }),
    });
    mockDb.update.mockReturnValueOnce({ set: updateSet });

    const result = await service.markTimedOutMachineCommands(now);

    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "timeout",
        resultAt: now,
        lastError: "machine command timeout",
      }),
    );
    expect(result).toEqual({ processed: 1 });
  });

  it("marks an environment control command failed from MQTT result", async () => {
    const resultPayload = {
      commandNo: "MCMD-2",
      success: false,
      reportedAt: "2026-05-05T12:00:00.000Z",
      errorCode: "E1",
      message: "hardware rejected command",
    };
    const eventValues = vi.fn().mockReturnValue({
      onConflictDoNothing: () => ({
        returning: async () => [{ id: "event-2" }],
      }),
    });
    const commandSet = vi
      .fn()
      .mockReturnValue({ where: async () => undefined });
    const tx = {
      insert: vi.fn().mockReturnValue({ values: eventValues }),
      update: vi.fn().mockReturnValue({ set: commandSet }),
    };
    mockDb.transaction.mockImplementationOnce(
      async (cb: (txArg: typeof tx) => Promise<void>) => {
        await cb(tx);
      },
    );
    verifyFromTopic.mockResolvedValueOnce({
      machineId: "machine-1",
      machineCode: "M001",
      messageId: "result:MCMD-2",
      payload: resultPayload,
    });

    await service.handleMachineMessage(
      "vem/machines/M001/events/environment-control-result",
      JSON.stringify({}),
    );

    expect(commandSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        resultJson: resultPayload,
        lastError: "hardware rejected command",
      }),
    );
  });
});

describe("MachinesService planogram lifecycle", () => {
  let service: MachinesService;

  const mockDb = {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn(),
  };
  const auditRecord = vi.fn();

  beforeEach(async () => {
    vi.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        MachinesService,
        { provide: DRIZZLE_CLIENT, useValue: mockDb },
        { provide: MachineCredentialService, useValue: {} },
        { provide: AuditService, useValue: { record: auditRecord } },
        { provide: MqttService, useValue: { publish: vi.fn() } },
        {
          provide: MqttSignatureService,
          useValue: { signForMachine: vi.fn(), verifyFromTopic: vi.fn() },
        },
        {
          provide: AppConfigService,
          useValue: { machineCommandTimeoutSeconds: 5 },
        },
      ],
    }).compile();
    service = module.get(MachinesService);
  });

  const slot = {
    slotId: "550e8400-e29b-41d4-a716-446655440001",
    slotCode: "A1",
    layerNo: 1,
    cellNo: 1,
    inventoryId: "550e8400-e29b-41d4-a716-446655440002",
    variantId: "550e8400-e29b-41d4-a716-446655440003",
    productId: "550e8400-e29b-41d4-a716-446655440004",
    productName: "矿泉水",
    productDescription: null,
    coverImageUrl: null,
    categoryId: null,
    categoryName: null,
    sku: "WATER-001",
    size: "550ml",
    color: null,
    priceCents: 200,
    productSortOrder: 1,
    targetGender: null,
    capacity: 8,
    parLevel: 6,
  };

  it("publishes a machine planogram version without making it active", async () => {
    const machine = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      code: "M001",
    };
    const publishedAt = new Date("2026-06-04T12:00:00.000Z");
    const version = {
      id: "550e8400-e29b-41d4-a716-446655440010",
      machineId: machine.id,
      planogramVersion: "PLAN-1",
      status: "published",
      publishedAt,
      acknowledgedAt: null,
      activeAt: null,
      createdAt: publishedAt,
      updatedAt: publishedAt,
    };
    const insertVersionValues = vi
      .fn()
      .mockReturnValue({ returning: async () => [version] });
    const insertSlotsValues = vi.fn().mockReturnValue({
      returning: async () => [{ id: "550e8400-e29b-41d4-a716-446655440011" }],
    });
    const tx = {
      insert: vi
        .fn()
        .mockReturnValueOnce({ values: insertVersionValues })
        .mockReturnValueOnce({ values: insertSlotsValues }),
    };
    mockDb.select
      .mockReturnValueOnce({
        from: () => ({ where: () => ({ limit: async () => [machine] }) }),
      })
      .mockReturnValueOnce({
        from: () => ({ where: async () => [{ id: slot.slotId }] }),
      });
    mockDb.transaction.mockImplementationOnce(
      async (cb: (txArg: typeof tx) => Promise<unknown>) => await cb(tx),
    );

    const result = await service.publishMachinePlanogramVersion(
      machine.id,
      { planogramVersion: "PLAN-1", slots: [slot] },
      "admin-1",
    );

    expect(result).toMatchObject({
      machineId: machine.id,
      machineCode: "M001",
      planogramVersion: "PLAN-1",
      status: "published",
      acknowledgedAt: null,
      activeAt: null,
    });
    expect(insertVersionValues).toHaveBeenCalledWith(
      expect.objectContaining({
        machineId: machine.id,
        planogramVersion: "PLAN-1",
        status: "published",
      }),
    );
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "machines.planogram.publish",
        resourceId: machine.id,
      }),
    );
  });

  it("rejects a planogram slot that does not belong to the target machine", async () => {
    const machine = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      code: "M001",
    };
    mockDb.select
      .mockReturnValueOnce({
        from: () => ({ where: () => ({ limit: async () => [machine] }) }),
      })
      .mockReturnValueOnce({
        from: () => ({ where: async () => [] }),
      });
    await expect(
      service.publishMachinePlanogramVersion(
        machine.id,
        { planogramVersion: "PLAN-1", slots: [slot] },
        "admin-1",
      ),
    ).rejects.toThrow(BadRequestException);
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it("reports no active planogram until an acknowledged version is active", async () => {
    const machine = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      code: "M001",
    };
    mockDb.select
      .mockReturnValueOnce({
        from: () => ({ where: () => ({ limit: async () => [machine] }) }),
      })
      .mockReturnValueOnce({
        from: () => ({
          where: () => ({
            orderBy: async () => [
              {
                id: "550e8400-e29b-41d4-a716-446655440010",
                machineId: machine.id,
                planogramVersion: "PLAN-1",
                status: "published",
                publishedAt: new Date("2026-06-04T12:00:00.000Z"),
                acknowledgedAt: null,
                activeAt: null,
              },
            ],
          }),
        }),
      })
      .mockReturnValueOnce({
        from: () => ({ where: () => ({ limit: async () => [machine] }) }),
      })
      .mockReturnValueOnce({
        from: () => ({
          where: () => ({
            orderBy: async () => [
              {
                id: "550e8400-e29b-41d4-a716-446655440010",
                machineId: machine.id,
                planogramVersion: "PLAN-1",
                status: "active",
                publishedAt: new Date("2026-06-04T12:00:00.000Z"),
                acknowledgedAt: new Date("2026-06-04T12:05:00.000Z"),
                activeAt: new Date("2026-06-04T12:05:00.000Z"),
              },
            ],
          }),
        }),
      });

    await expect(
      service.getMachinePlanogramVersions(machine.id),
    ).resolves.toEqual(
      expect.objectContaining({ activePlanogramVersion: null }),
    );
    await expect(
      service.getMachinePlanogramVersions(machine.id),
    ).resolves.toEqual(
      expect.objectContaining({ activePlanogramVersion: "PLAN-1" }),
    );
  });

  it("acknowledges a published planogram version as active", async () => {
    const machine = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      code: "M001",
    };
    const published = {
      id: "550e8400-e29b-41d4-a716-446655440010",
      machineId: machine.id,
      planogramVersion: "PLAN-1",
      status: "published",
      publishedAt: new Date("2026-06-04T12:00:00.000Z"),
      acknowledgedAt: null,
      activeAt: null,
      createdAt: new Date("2026-06-04T12:00:00.000Z"),
      updatedAt: new Date("2026-06-04T12:00:00.000Z"),
    };
    const activated = {
      ...published,
      status: "active",
      acknowledgedAt: new Date("2026-06-04T12:05:00.000Z"),
      activeAt: new Date("2026-06-04T12:05:00.000Z"),
      updatedAt: new Date("2026-06-04T12:05:00.000Z"),
    };
    const retireSet = vi.fn().mockReturnValue({ where: async () => undefined });
    const activateSet = vi.fn().mockReturnValue({
      where: () => ({ returning: async () => [activated] }),
    });
    const tx = {
      select: vi.fn().mockReturnValue({
        from: () => ({ where: () => ({ limit: async () => [published] }) }),
      }),
      update: vi
        .fn()
        .mockReturnValueOnce({ set: retireSet })
        .mockReturnValueOnce({ set: activateSet }),
    };
    mockDb.select.mockReturnValueOnce({
      from: () => ({ where: () => ({ limit: async () => [machine] }) }),
    });
    mockDb.transaction.mockImplementationOnce(
      async (cb: (txArg: typeof tx) => Promise<unknown>) => await cb(tx),
    );

    const result = await service.acknowledgeMachinePlanogramVersion(
      "M001",
      "PLAN-1",
    );

    expect(retireSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: "retired" }),
    );
    expect(activateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: "active" }),
    );
    expect(result).toMatchObject({
      machineCode: "M001",
      planogramVersion: "PLAN-1",
      status: "active",
      activeAt: expect.any(String),
    });
  });

  it("treats repeated ack for the active planogram version as idempotent", async () => {
    const machine = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      code: "M001",
    };
    const active = {
      id: "550e8400-e29b-41d4-a716-446655440010",
      machineId: machine.id,
      planogramVersion: "PLAN-1",
      status: "active",
      publishedAt: new Date("2026-06-04T12:00:00.000Z"),
      acknowledgedAt: new Date("2026-06-04T12:05:00.000Z"),
      activeAt: new Date("2026-06-04T12:05:00.000Z"),
      createdAt: new Date("2026-06-04T12:00:00.000Z"),
      updatedAt: new Date("2026-06-04T12:05:00.000Z"),
    };
    const tx = {
      select: vi.fn().mockReturnValue({
        from: () => ({ where: () => ({ limit: async () => [active] }) }),
      }),
      update: vi.fn(),
    };
    mockDb.select.mockReturnValueOnce({
      from: () => ({ where: () => ({ limit: async () => [machine] }) }),
    });
    mockDb.transaction.mockImplementationOnce(
      async (cb: (txArg: typeof tx) => Promise<unknown>) => await cb(tx),
    );

    await expect(
      service.acknowledgeMachinePlanogramVersion("M001", "PLAN-1"),
    ).resolves.toMatchObject({
      machineCode: "M001",
      planogramVersion: "PLAN-1",
      status: "active",
    });
    expect(tx.update).not.toHaveBeenCalled();
  });

  it("rejects ack for a machine planogram version that is not published or active", async () => {
    const machine = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      code: "M001",
    };
    const tx = {
      select: vi.fn().mockReturnValue({
        from: () => ({ where: () => ({ limit: async () => [] }) }),
      }),
      update: vi.fn(),
    };
    mockDb.select.mockReturnValueOnce({
      from: () => ({ where: () => ({ limit: async () => [machine] }) }),
    });
    mockDb.transaction.mockImplementationOnce(
      async (cb: (txArg: typeof tx) => Promise<unknown>) => await cb(tx),
    );

    await expect(
      service.acknowledgeMachinePlanogramVersion("M001", "PLAN-MISSING"),
    ).rejects.toThrow(NotFoundException);
    expect(tx.update).not.toHaveBeenCalled();
  });
});
