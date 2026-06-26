import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { Test } from "@nestjs/testing";
import { mqttSigningInput } from "@vem/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { AuditService } from "../audit/audit.service";
import { AppConfigService } from "../config/app-config.service";
import { DRIZZLE_CLIENT } from "../database/database.constants";
import { MachineAuthService } from "../machine-auth/machine-auth.service";
import { MachineCredentialService } from "../machine-auth/machine-credential.service";
import {
  encryptCredentialSecret,
  generateMachineSecret,
  hashMachineSecret,
  hmacSha256Base64Url,
  type EncryptedCredentialJson,
} from "../machine-auth/machine-credentials.util";
import { MqttSignatureService } from "../mqtt/mqtt-signature.service";
import { MqttService } from "../mqtt/mqtt.service";
import { NotificationsService } from "../notifications/notifications.service";
import { PaymentProviderConfigService } from "../payments/payment-provider-config.service";
import { hashMachineClaimCodeVerifier } from "./machine-claim-code.util";
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
  const listMachinePaymentOptionsForMachine = vi.fn();
  const createMachineOfflineNotification = vi.fn();

  beforeEach(async () => {
    vi.resetAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        MachinesService,
        { provide: DRIZZLE_CLIENT, useValue: mockDb },
        { provide: MachineCredentialService, useValue: {} },
        {
          provide: PaymentProviderConfigService,
          useValue: { listMachinePaymentOptionsForMachine },
        },
        { provide: AuditService, useValue: { record: auditRecord } },
        { provide: MqttService, useValue: { publish } },
        {
          provide: MqttSignatureService,
          useValue: { signForMachine, verifyFromTopic },
        },
        {
          provide: NotificationsService,
          useValue: { createMachineOfflineNotification },
        },
        {
          provide: AppConfigService,
          useValue: {
            machineCommandTimeoutSeconds: 5,
            machineHeartbeatTimeoutSeconds: 120,
          },
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
                  reportedAt: new Date("2026-05-05T12:00:05.000Z"),
                  statusPayloadJson: {
                    network: "online",
                    mqttConnected: true,
                    hardwareStatus: "faulted",
                    wholeMachineMaintenanceLock: {
                      code: "WHOLE_MACHINE_HARDWARE_FAULT",
                      message: "pickup platform blocked",
                      source: "dispense_failure",
                      orderNo: "ORD-1",
                      commandNo: "CMD-1",
                      slotCode: "A1",
                      errorCode: "JAMMED",
                      createdAt: "2026-05-05T12:00:01.000Z",
                    },
                    saleReadiness: {
                      state: "locked",
                      blockingCodes: ["WHOLE_MACHINE_HARDWARE_FAULT"],
                    },
                    localQueueSize: 0,
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
        latestHeartbeatReportedAt: new Date("2026-05-05T12:00:05.000Z"),
        latestHeartbeatStatus: expect.objectContaining({
          network: "online",
          mqttConnected: true,
          hardwareStatus: "faulted",
          saleReadiness: {
            state: "locked",
            blockingCodes: ["WHOLE_MACHINE_HARDWARE_FAULT"],
          },
          wholeMachineMaintenanceLock: expect.objectContaining({
            code: "WHOLE_MACHINE_HARDWARE_FAULT",
            slotCode: "A1",
          }),
        }),
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
                  reportedAt: new Date("2026-05-05T12:00:05.000Z"),
                  statusPayloadJson: {
                    network: "online",
                    mqttConnected: true,
                    hardwareStatus: "faulted",
                    wholeMachineMaintenanceLock: {
                      code: "WHOLE_MACHINE_HARDWARE_FAULT",
                      message: "pickup platform blocked",
                      source: "dispense_failure",
                      orderNo: "ORD-1",
                      commandNo: "CMD-1",
                      slotCode: "A1",
                      errorCode: "JAMMED",
                      createdAt: "2026-05-05T12:00:01.000Z",
                    },
                    saleReadiness: {
                      state: "locked",
                      blockingCodes: ["WHOLE_MACHINE_HARDWARE_FAULT"],
                    },
                    localQueueSize: 0,
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

    expect(result.latestHeartbeatReportedAt).toEqual(
      new Date("2026-05-05T12:00:05.000Z"),
    );
    expect(result.latestHeartbeatStatus).toEqual(
      expect.objectContaining({
        network: "online",
        mqttConnected: true,
        hardwareStatus: "faulted",
        saleReadiness: {
          state: "locked",
          blockingCodes: ["WHOLE_MACHINE_HARDWARE_FAULT"],
        },
        wholeMachineMaintenanceLock: expect.objectContaining({
          code: "WHOLE_MACHINE_HARDWARE_FAULT",
          slotCode: "A1",
        }),
      }),
    );
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

  it("marks stale online machines offline and creates an operator notification", async () => {
    const now = new Date("2026-06-26T04:05:00.000Z");
    const staleMachine = {
      id: "machine-1",
      code: "M001",
      status: "online",
      lastSeenAt: new Date("2026-06-26T04:02:30.000Z"),
    };
    const tx = {
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: staleMachine.id }]),
          }),
        }),
      }),
    };
    mockDb.select.mockReturnValueOnce({
      from: () => ({
        where: async () => [staleMachine],
      }),
    });
    mockDb.transaction.mockImplementation(
      async (cb: (txArg: unknown) => Promise<void>) => {
        await cb(tx);
      },
    );

    const result = await service.markTimedOutMachineHeartbeats(now);

    expect(result).toEqual({ processed: 1 });
    expect(createMachineOfflineNotification).toHaveBeenCalledWith(tx, {
      machineId: "machine-1",
      machineCode: "M001",
      lastSeenAt: new Date("2026-06-26T04:02:30.000Z"),
      timeoutSeconds: 120,
      detectedAt: now,
    });
  });

  it("marks online machines with null lastSeenAt offline and creates an operator notification", async () => {
    const now = new Date("2026-06-26T04:05:00.000Z");
    const staleMachine = {
      id: "machine-1",
      code: "M001",
      status: "online",
      lastSeenAt: null,
    };
    const tx = {
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: staleMachine.id }]),
          }),
        }),
      }),
    };
    mockDb.select.mockReturnValueOnce({
      from: () => ({
        where: async () => [staleMachine],
      }),
    });
    mockDb.transaction.mockImplementation(
      async (cb: (txArg: unknown) => Promise<void>) => {
        await cb(tx);
      },
    );

    const result = await service.markTimedOutMachineHeartbeats(now);

    expect(result).toEqual({ processed: 1 });
    expect(createMachineOfflineNotification).toHaveBeenCalledWith(tx, {
      machineId: "machine-1",
      machineCode: "M001",
      lastSeenAt: null,
      timeoutSeconds: 120,
      detectedAt: now,
    });
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
  const createBundle = vi.fn();
  const listMachinePaymentOptionsForMachine = vi.fn();

  beforeEach(async () => {
    vi.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        MachinesService,
        { provide: DRIZZLE_CLIENT, useValue: mockDb },
        { provide: MachineCredentialService, useValue: { createBundle } },
        {
          provide: PaymentProviderConfigService,
          useValue: { listMachinePaymentOptionsForMachine },
        },
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
        {
          provide: NotificationsService,
          useValue: { createMachineOfflineNotification: vi.fn() },
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

  it("returns all active planogram slots in the machine stock snapshot", async () => {
    mockDb.select.mockReturnValueOnce({
      from: () => ({
        innerJoin: () => ({
          innerJoin: () => ({
            innerJoin: () => ({
              innerJoin: () => ({
                where: () => ({
                  orderBy: async () => [
                    {
                      machineCode: "M001",
                      planogramVersion: "PLAN-1",
                      slotId: "slot-1",
                      slotCode: "A1",
                      inventoryId: "inv-1",
                      capacity: 10,
                      slotStatus: "enabled",
                      onHandQty: 10,
                      reservedQty: 0,
                      availableQty: 10,
                    },
                    {
                      machineCode: "M001",
                      planogramVersion: "PLAN-1",
                      slotId: "slot-2",
                      slotCode: "A2",
                      inventoryId: "inv-2",
                      capacity: 10,
                      slotStatus: "faulted",
                      onHandQty: 5,
                      reservedQty: 0,
                      availableQty: 0,
                    },
                  ],
                }),
              }),
            }),
          }),
        }),
      }),
    });

    const result = await service.getStockSnapshotByMachineCode("M001");

    expect(result).toMatchObject({
      machineCode: "M001",
      planogramVersion: "PLAN-1",
      slots: [
        {
          slotId: "slot-1",
          slotCode: "A1",
          inventoryId: "inv-1",
          onHandQty: 10,
          availableQty: 10,
          slotSalesState: "sale_ready",
        },
        {
          slotId: "slot-2",
          slotCode: "A2",
          inventoryId: "inv-2",
          onHandQty: 5,
          availableQty: 0,
          slotSalesState: "frozen",
        },
      ],
      serverTime: expect.any(String),
    });
  });

  it("projects open stock reconciliation blockers into machine stock snapshot sale eligibility", async () => {
    mockDb.select.mockReturnValueOnce({
      from: () => ({
        innerJoin: () => ({
          innerJoin: () => ({
            innerJoin: () => ({
              innerJoin: () => ({
                where: () => ({
                  orderBy: async () => [
                    {
                      machineCode: "M001",
                      planogramVersion: "PLAN-1",
                      slotId: "slot-1",
                      slotCode: "A1",
                      inventoryId: "inv-1",
                      capacity: 10,
                      slotStatus: "enabled",
                      openSaleSafetyBlockerState: "needs_platform_review",
                      onHandQty: 10,
                      reservedQty: 0,
                      availableQty: 0,
                    },
                    {
                      machineCode: "M001",
                      planogramVersion: "PLAN-1",
                      slotId: "slot-2",
                      slotCode: "A2",
                      inventoryId: "inv-2",
                      capacity: 10,
                      slotStatus: "enabled",
                      openSaleSafetyBlockerState: null,
                      onHandQty: 5,
                      reservedQty: 0,
                      availableQty: 5,
                    },
                  ],
                }),
              }),
            }),
          }),
        }),
      }),
    });

    const result = await service.getStockSnapshotByMachineCode("M001");

    expect(result.slots).toEqual([
      expect.objectContaining({
        slotId: "slot-1",
        availableQty: 0,
        slotSalesState: "needs_platform_review",
      }),
      expect.objectContaining({
        slotId: "slot-2",
        availableQty: 5,
        slotSalesState: "sale_ready",
      }),
    ]);
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

describe("MachinesService claim code lifecycle", () => {
  let service: MachinesService;
  const claimCodeNow = new Date("2026-06-08T16:30:00.000Z");

  const mockDb = {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn(),
  };
  const auditRecord = vi.fn();
  const createBundle = vi.fn();
  const listMachinePaymentOptionsForMachine = vi.fn();

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(claimCodeNow);
    const module = await Test.createTestingModule({
      providers: [
        MachinesService,
        { provide: DRIZZLE_CLIENT, useValue: mockDb },
        { provide: MachineCredentialService, useValue: { createBundle } },
        {
          provide: PaymentProviderConfigService,
          useValue: { listMachinePaymentOptionsForMachine },
        },
        { provide: AuditService, useValue: { record: auditRecord } },
        { provide: MqttService, useValue: { publish: vi.fn() } },
        {
          provide: MqttSignatureService,
          useValue: { signForMachine: vi.fn(), verifyFromTopic: vi.fn() },
        },
        {
          provide: AppConfigService,
          useValue: {
            machineCommandTimeoutSeconds: 5,
            machineHeartbeatTimeoutSeconds: 120,
            machineClaimCodeTtlSeconds: 600,
            machineClaimLookupHmacKey:
              "test-machine-claim-lookup-hmac-key-change-me",
            mqttUrl: "mqtt://localhost:1883",
            mqttUsername: "machine-client",
            mqttPassword: "mqtt-password",
          },
        },
        {
          provide: NotificationsService,
          useValue: { createMachineOfflineNotification: vi.fn() },
        },
      ],
    }).compile();
    service = module.get(MachinesService);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function claimCandidate(
    overrides: Partial<{
      id: string;
      verifierHash: string;
      state: "pending" | "consumed" | "expired" | "revoked" | "locked";
      failedAttemptCount: number;
      maxFailedAttempts: number;
      expiresAt: Date;
      consumedAt: Date | null;
      revokedAt: Date | null;
      lockedAt: Date | null;
    }> = {},
  ) {
    return {
      id: "550e8400-e29b-41d4-a716-446655440111",
      machineId: "550e8400-e29b-41d4-a716-446655440000",
      verifierHash: hashMachineClaimCodeVerifier("ABCD-2345"),
      state: "pending" as const,
      failedAttemptCount: 0,
      maxFailedAttempts: 5,
      expiresAt: new Date("2026-06-08T16:40:00.000Z"),
      consumedAt: null,
      revokedAt: null,
      lockedAt: null,
      machineCode: "M001",
      machineName: "Lobby",
      machineLocationText: "1F",
      machineStatus: "offline" as const,
      machineMqttClientId: null,
      machineSecretVersion: 1,
      ...overrides,
    };
  }

  it("consumes a valid pending claim code once and returns a provisioning profile with rotated credentials", async () => {
    const machine = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      code: "M001",
      name: "Lobby",
      locationText: "1F",
      status: "offline",
      mqttClientId: null,
      secretVersion: 1,
      deletedAt: null,
    };
    const pending = {
      id: "550e8400-e29b-41d4-a716-446655440111",
      machineId: machine.id,
      verifierHash: hashMachineClaimCodeVerifier("ABCD-2345"),
      state: "pending",
      failedAttemptCount: 0,
      maxFailedAttempts: 5,
      expiresAt: new Date("2026-06-08T16:40:00.000Z"),
      consumedAt: null,
      revokedAt: null,
      lockedAt: null,
      createdByAdminUserId: "admin-1",
      revokedByAdminUserId: null,
      createdAt: new Date("2026-06-08T16:00:00.000Z"),
      updatedAt: new Date("2026-06-08T16:00:00.000Z"),
      machineCode: machine.code,
      machineName: machine.name,
      machineLocationText: machine.locationText,
      machineStatus: machine.status,
      machineMqttClientId: machine.mqttClientId,
      machineSecretVersion: machine.secretVersion,
    };
    const rotatedSecretVersion = 2;
    const consumed = {
      ...pending,
      state: "consumed",
      consumedAt: claimCodeNow,
      updatedAt: claimCodeNow,
    };
    createBundle.mockReturnValueOnce({
      machineSecret: "vms_rotated-machine-secret-change-before-production",
      mqttSigningSecret: "vms_rotated-mqtt-secret-change-before-production",
      secretHash: "scrypt:rotated-machine-secret-hash",
      mqttSigningSecretEncryptedJson: { v: 1, alg: "aes-256-gcm" },
    });
    const consumeSet = vi.fn().mockReturnValue({
      where: () => ({ returning: async () => [consumed] }),
    });
    const rotateSet = vi.fn().mockReturnValue({
      where: () => ({
        returning: async () => [
          { id: machine.id, secretVersion: rotatedSecretVersion },
        ],
      }),
    });
    const tx = {
      update: vi
        .fn()
        .mockReturnValueOnce({ set: consumeSet })
        .mockReturnValueOnce({ set: rotateSet }),
    };
    mockDb.select.mockReturnValueOnce({
      from: () => ({
        innerJoin: () => ({
          where: () => ({
            limit: async () => [pending],
          }),
        }),
      }),
    });
    mockDb.transaction.mockImplementationOnce(
      async (cb: (txArg: typeof tx) => Promise<unknown>) => await cb(tx),
    );

    const result = await service.claimMachine({ claimCode: "ABCD-2345" });

    expect(result).toEqual(
      expect.objectContaining({
        machine: expect.objectContaining({
          id: machine.id,
          code: "M001",
          name: "Lobby",
        }),
        credentials: expect.objectContaining({
          machineSecret: "vms_rotated-machine-secret-change-before-production",
          machineSecretVersion: rotatedSecretVersion,
          mqttSigningSecret: "vms_rotated-mqtt-secret-change-before-production",
          mqttConnection: expect.objectContaining({
            url: "mqtt://localhost:1883",
            clientId: "vem-machine-M001",
          }),
        }),
        runtimeEndpoints: expect.objectContaining({
          machineAuthTokenPath: "/api/machine-auth/token",
          mqttTopicPrefix: "vem/machines/M001",
        }),
        hardwareProfile: expect.objectContaining({ profile: "production" }),
        paymentCapability: expect.objectContaining({
          profile: "production",
          qrCodeEnabled: true,
          paymentCodeEnabled: true,
          serverTime: "2026-06-08T16:30:00.000Z",
        }),
        metadata: expect.objectContaining({
          profileVersion: 1,
          claimCodeId: pending.id,
          claimedAt: "2026-06-08T16:30:00.000Z",
        }),
      }),
    );
    expect(consumeSet).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "consumed",
        consumedAt: claimCodeNow,
      }),
    );
    expect(rotateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        secretHash: "scrypt:rotated-machine-secret-hash",
        secretVersion: expect.anything(),
        credentialRevokedAt: null,
      }),
    );
    expect(rotateSet.mock.calls[0]?.[0].secretVersion).not.toBe(
      pending.machineSecretVersion + 1,
    );
    expect(mockDb.insert).not.toHaveBeenCalled();
    expect(auditRecord).toHaveBeenCalledWith({
      adminUserId: null,
      action: "machines.claimCode.consume",
      resourceType: "machine",
      resourceId: machine.id,
      afterJson: {
        claimCodeId: pending.id,
        machineCode: "M001",
        state: "consumed",
        secretVersion: rotatedSecretVersion,
        claimedAt: "2026-06-08T16:30:00.000Z",
      },
    });
    const serializedProfile = JSON.stringify(result);
    expect(serializedProfile).not.toContain("planogram");
    expect(serializedProfile).not.toContain("catalog");
    expect(serializedProfile).not.toContain("stock");
    expect(serializedProfile).not.toContain("inventory");
    expect(serializedProfile).not.toContain("merchant");
    expect(serializedProfile).not.toContain("mock:mock");
    expect(serializedProfile).not.toContain("face_pay");
    expect(serializedProfile).not.toContain("defaultProviderCode");
    expect(serializedProfile).not.toContain("optionKey");
    expect(listMachinePaymentOptionsForMachine).not.toHaveBeenCalled();
  });

  it("consumes a reclaim code with credential rotation and distinct audit", async () => {
    const pending = {
      ...claimCandidate({ id: "550e8400-e29b-41d4-a716-446655440222" }),
      purpose: "reclaim",
    };
    const rotatedSecretVersion = 8;
    const consumed = {
      ...pending,
      state: "consumed",
      consumedAt: claimCodeNow,
      updatedAt: claimCodeNow,
    };
    createBundle.mockReturnValueOnce({
      machineSecret: "vms_reclaim-machine-secret-change-before-production",
      mqttSigningSecret: "vms_reclaim-mqtt-secret-change-before-production",
      secretHash: "scrypt:reclaim-machine-secret-hash",
      mqttSigningSecretEncryptedJson: { v: 1, alg: "aes-256-gcm" },
    });
    listMachinePaymentOptionsForMachine.mockResolvedValueOnce({
      options: [],
      defaultOptionKey: null,
      defaultProviderCode: null,
      serverTime: "2026-06-08T16:30:00.000Z",
    });

    const consumeSet = vi.fn().mockReturnValue({
      where: () => ({ returning: async () => [consumed] }),
    });
    const rotateSet = vi.fn().mockReturnValue({
      where: () => ({
        returning: async () => [
          { id: pending.machineId, secretVersion: rotatedSecretVersion },
        ],
      }),
    });
    const tx = {
      update: vi
        .fn()
        .mockReturnValueOnce({ set: consumeSet })
        .mockReturnValueOnce({ set: rotateSet }),
    };
    mockDb.select.mockReturnValueOnce({
      from: () => ({
        innerJoin: () => ({
          where: () => ({
            limit: async () => [pending],
          }),
        }),
      }),
    });
    mockDb.transaction.mockImplementationOnce(
      async (cb: (txArg: typeof tx) => Promise<unknown>) => await cb(tx),
    );

    const result = await service.claimMachine({ claimCode: "ABCD-2345" });

    expect(result.credentials).toEqual(
      expect.objectContaining({
        machineSecret: "vms_reclaim-machine-secret-change-before-production",
        machineSecretVersion: rotatedSecretVersion,
      }),
    );
    expect(rotateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        secretHash: "scrypt:reclaim-machine-secret-hash",
        secretVersion: expect.anything(),
        credentialRevokedAt: null,
      }),
    );
    expect(auditRecord).toHaveBeenCalledWith({
      adminUserId: null,
      action: "machines.claimCode.reclaim.consume",
      resourceType: "machine",
      resourceId: pending.machineId,
      afterJson: {
        claimCodeId: pending.id,
        machineCode: "M001",
        purpose: "reclaim",
        state: "consumed",
        secretVersion: rotatedSecretVersion,
        claimedAt: "2026-06-08T16:30:00.000Z",
      },
    });
    const serializedProfile = JSON.stringify(result);
    expect(serializedProfile).not.toContain("stock");
    expect(serializedProfile).not.toContain("inventory");
    expect(serializedProfile).not.toContain("planogram");
  });

  it("makes pre-reclaim credentials unusable through machine auth and MQTT verification", async () => {
    const encryptionKey = "local-cred-enc-key-change-before-production!";
    const oldMachineSecret = generateMachineSecret();
    const newMachineSecret = generateMachineSecret();
    const oldMqttSigningSecret = generateMachineSecret();
    const newMqttSigningSecret = generateMachineSecret();
    const machineState = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      code: "M001",
      status: "online" as const,
      secretHash: hashMachineSecret(oldMachineSecret) as string | null,
      secretVersion: 1,
      credentialRevokedAt: null as Date | null,
      mqttSigningSecretEncryptedJson: encryptCredentialSecret(
        oldMqttSigningSecret,
        encryptionKey,
      ) as EncryptedCredentialJson | null,
    };
    const config = {
      machineJwtSecret: "local-machine-jwt-secret-change-before-production",
      machineCredentialEncryptionKey: encryptionKey,
      machineAccessTtlSeconds: 900,
      mqttSignatureToleranceSeconds: 300,
    } as AppConfigService;
    const authAndMqttDb = {
      select: () => ({
        from: () => ({
          where: () => {
            const rows = [machineState];
            return Object.assign(Promise.resolve(rows), {
              limit: async () => rows,
            });
          },
        }),
      }),
    };
    const credentialService = new MachineCredentialService(config);
    const machineAuthService = new MachineAuthService(
      authAndMqttDb as never,
      new JwtService({}),
      config,
      credentialService,
    );
    const mqttSignatureService = new MqttSignatureService(
      authAndMqttDb as never,
      config,
      credentialService,
    );
    const { accessToken: oldAccessToken } = await machineAuthService.issueToken(
      {
        machineCode: "M001",
        machineSecret: oldMachineSecret,
      },
    );
    const pending = {
      ...claimCandidate({ id: "550e8400-e29b-41d4-a716-446655440333" }),
      purpose: "reclaim",
      machineStatus: "online" as const,
      machineSecretVersion: machineState.secretVersion,
    };
    const newBundle = {
      machineSecret: newMachineSecret,
      mqttSigningSecret: newMqttSigningSecret,
      secretHash: hashMachineSecret(newMachineSecret),
      mqttSigningSecretEncryptedJson: encryptCredentialSecret(
        newMqttSigningSecret,
        encryptionKey,
      ),
    };
    createBundle.mockReturnValueOnce(newBundle);
    listMachinePaymentOptionsForMachine.mockResolvedValueOnce({
      options: [],
      defaultOptionKey: null,
      defaultProviderCode: null,
      serverTime: "2026-06-08T16:30:00.000Z",
    });

    const consumeSet = vi.fn().mockReturnValue({
      where: () => ({ returning: async () => [{ id: pending.id }] }),
    });
    const rotateSet = vi.fn().mockReturnValue({
      where: () => ({
        returning: async () => {
          machineState.secretHash = newBundle.secretHash;
          machineState.secretVersion = 2;
          machineState.credentialRevokedAt = null;
          machineState.mqttSigningSecretEncryptedJson =
            newBundle.mqttSigningSecretEncryptedJson;
          return [{ id: pending.machineId, secretVersion: 2 }];
        },
      }),
    });
    const tx = {
      update: vi
        .fn()
        .mockReturnValueOnce({ set: consumeSet })
        .mockReturnValueOnce({ set: rotateSet }),
    };
    mockDb.select.mockReturnValueOnce({
      from: () => ({
        innerJoin: () => ({
          where: () => ({
            limit: async () => [pending],
          }),
        }),
      }),
    });
    mockDb.transaction.mockImplementationOnce(
      async (cb: (txArg: typeof tx) => Promise<unknown>) => await cb(tx),
    );

    const profile = await service.claimMachine({ claimCode: "ABCD-2345" });

    expect(profile.credentials.machineSecret).toBe(newMachineSecret);
    expect(profile.credentials.mqttSigningSecret).toBe(newMqttSigningSecret);
    await expect(
      machineAuthService.verifyToken(oldAccessToken),
    ).rejects.toThrow("Invalid machine token");
    await expect(
      machineAuthService.issueToken({
        machineCode: "M001",
        machineSecret: oldMachineSecret,
      }),
    ).rejects.toThrow("Invalid machine credentials");
    await expect(
      machineAuthService.issueToken({
        machineCode: "M001",
        machineSecret: newMachineSecret,
      }),
    ).resolves.toEqual(expect.objectContaining({ tokenType: "Bearer" }));

    const oldEnvelopeBase = {
      messageId: "msg-old-reclaim-credential",
      machineCode: "M001",
      issuedAt: claimCodeNow.toISOString(),
      nonce: "nonce-old-reclaim-credential",
      payload: { commandNo: "CMD1" },
    };
    const oldEnvelope = {
      ...oldEnvelopeBase,
      signature: hmacSha256Base64Url(
        oldMqttSigningSecret,
        mqttSigningInput(oldEnvelopeBase),
      ),
    };
    await expect(
      mqttSignatureService.verifyFromTopic({
        topicMachineCode: "M001",
        rawPayload: oldEnvelope,
        payloadSchema: z.object({ commandNo: z.string() }),
      }),
    ).rejects.toThrow("Invalid MQTT signature");
  });

  it("returns a safe non-enumerating error for an unknown claim code", async () => {
    mockDb.select.mockReturnValueOnce({
      from: () => ({
        innerJoin: () => ({
          where: () => ({
            limit: async () => [],
          }),
        }),
      }),
    });

    let error: unknown;
    try {
      await service.claimMachine({ claimCode: "WXYZ-2345" });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(UnauthorizedException);
    expect(error).toMatchObject({
      message: "Invalid or expired machine claim code",
    });
    expect(mockDb.update).not.toHaveBeenCalled();
    expect(auditRecord).not.toHaveBeenCalled();
  });

  it("looks up only one claim-code candidate before verifying the salted hash", async () => {
    const pending = claimCandidate();
    const limit = vi.fn().mockResolvedValue([pending]);
    const where = vi.fn().mockReturnValue({ limit });
    mockDb.select.mockReturnValueOnce({
      from: () => ({
        innerJoin: () => ({
          where,
        }),
      }),
    });
    createBundle.mockReturnValueOnce({
      machineSecret: "vms_rotated-machine-secret-change-before-production",
      mqttSigningSecret: "vms_rotated-mqtt-secret-change-before-production",
      secretHash: "scrypt:rotated-machine-secret-hash",
      mqttSigningSecretEncryptedJson: { v: 1, alg: "aes-256-gcm" },
    });
    mockDb.transaction.mockRejectedValueOnce(new Error("stop after lookup"));

    await expect(
      service.claimMachine({ claimCode: "ABCD-2345" }),
    ).rejects.toThrow("stop after lookup");

    expect(where).toHaveBeenCalledTimes(1);
    expect(limit).toHaveBeenCalledWith(1);
    expect(listMachinePaymentOptionsForMachine).not.toHaveBeenCalled();
  });

  it.each([
    {
      state: "consumed" as const,
      expectedState: "consumed",
      dateField: "consumedAt",
    },
    {
      state: "revoked" as const,
      expectedState: "revoked",
      dateField: "revokedAt",
    },
    {
      state: "locked" as const,
      expectedState: "locked",
      dateField: "lockedAt",
    },
    {
      state: "pending" as const,
      expectedState: "expired",
      expiresAt: new Date("2026-06-08T16:00:00.000Z"),
    },
  ])(
    "returns the same safe error and updates failed-attempt state for $expectedState claim codes",
    async ({ state, expectedState, dateField, expiresAt }) => {
      const existingDate = new Date("2026-06-08T16:10:00.000Z");
      const failed = claimCandidate({
        state,
        failedAttemptCount: 2,
        expiresAt: expiresAt ?? new Date("2026-06-08T16:40:00.000Z"),
        consumedAt: dateField === "consumedAt" ? existingDate : null,
        revokedAt: dateField === "revokedAt" ? existingDate : null,
        lockedAt: dateField === "lockedAt" ? existingDate : null,
      });
      const updateSet = vi.fn().mockReturnValue({ where: async () => [] });
      mockDb.select.mockReturnValueOnce({
        from: () => ({
          innerJoin: () => ({
            where: () => ({
              limit: async () => [failed],
            }),
          }),
        }),
      });
      mockDb.update.mockReturnValueOnce({ set: updateSet });

      await expect(
        service.claimMachine({ claimCode: "ABCD-2345" }),
      ).rejects.toMatchObject({
        message: "Invalid or expired machine claim code",
      });

      expect(updateSet).toHaveBeenCalledWith(
        expect.objectContaining({
          failedAttemptCount: expect.anything(),
          state: expectedState,
          updatedAt: claimCodeNow,
        }),
      );
      expect(updateSet.mock.calls[0]?.[0].failedAttemptCount).not.toBe(3);
      expect(updateSet.mock.calls[0]?.[0]).not.toHaveProperty("machineCode");
      expect(auditRecord).not.toHaveBeenCalled();
    },
  );

  it("atomically increments and locks a digest-matched claim when verifier validation fails at the threshold", async () => {
    const failed = claimCandidate({
      verifierHash: hashMachineClaimCodeVerifier("ZZZZ-9999"),
      failedAttemptCount: 4,
      maxFailedAttempts: 5,
    });
    const updateSet = vi.fn().mockReturnValue({ where: async () => [] });
    mockDb.select.mockReturnValueOnce({
      from: () => ({
        innerJoin: () => ({
          where: () => ({
            limit: async () => [failed],
          }),
        }),
      }),
    });
    mockDb.update.mockReturnValueOnce({ set: updateSet });

    await expect(
      service.claimMachine({ claimCode: "ABCD-2345" }),
    ).rejects.toMatchObject({
      message: "Invalid or expired machine claim code",
    });

    const updatePayload = updateSet.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(updatePayload).toEqual(
      expect.objectContaining({
        failedAttemptCount: expect.anything(),
        state: expect.anything(),
        lockedAt: expect.anything(),
        updatedAt: claimCodeNow,
      }),
    );
    expect(updatePayload.failedAttemptCount).not.toBe(5);
    expect(updatePayload.state).not.toBe("locked");
    const stateSqlChunks =
      (updatePayload.state as { queryChunks?: Array<{ value?: string[] }> })
        .queryChunks ?? [];
    expect(
      stateSqlChunks.some((chunk) => chunk.value?.join("").includes("locked")),
    ).toBe(true);
    expect(auditRecord).not.toHaveBeenCalled();
  });

  it("does not return a profile when the claim code was consumed by a concurrent request", async () => {
    const pending = claimCandidate();
    const consumeSet = vi.fn().mockReturnValue({
      where: () => ({ returning: async () => [] }),
    });
    const tx = {
      update: vi.fn().mockReturnValueOnce({ set: consumeSet }),
    };
    mockDb.select.mockReturnValueOnce({
      from: () => ({
        innerJoin: () => ({
          where: () => ({
            limit: async () => [pending],
          }),
        }),
      }),
    });
    createBundle.mockReturnValueOnce({
      machineSecret: "vms_rotated-machine-secret-change-before-production",
      mqttSigningSecret: "vms_rotated-mqtt-secret-change-before-production",
      secretHash: "scrypt:rotated-machine-secret-hash",
      mqttSigningSecretEncryptedJson: { v: 1, alg: "aes-256-gcm" },
    });
    mockDb.transaction.mockImplementationOnce(
      async (cb: (txArg: typeof tx) => Promise<unknown>) => await cb(tx),
    );

    await expect(
      service.claimMachine({ claimCode: "ABCD-2345" }),
    ).rejects.toMatchObject({
      message: "Invalid or expired machine claim code",
    });
    expect(listMachinePaymentOptionsForMachine).not.toHaveBeenCalled();
    expect(auditRecord).not.toHaveBeenCalled();
  });

  it("uses the database-returned secret version when rotating machine credentials", async () => {
    const machine = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      code: "M001",
      secretVersion: 1,
    };
    const updateSet = vi.fn().mockReturnValue({
      where: () => ({
        returning: async () => [
          { id: machine.id, code: machine.code, secretVersion: 7 },
        ],
      }),
    });
    mockDb.select.mockReturnValueOnce({
      from: () => ({
        where: async () => [machine],
      }),
    });
    mockDb.update.mockReturnValueOnce({ set: updateSet });
    createBundle.mockReturnValueOnce({
      machineSecret: "vms_rotated-machine-secret-change-before-production",
      mqttSigningSecret: "vms_rotated-mqtt-secret-change-before-production",
      secretHash: "scrypt:rotated-machine-secret-hash",
      mqttSigningSecretEncryptedJson: { v: 1, alg: "aes-256-gcm" },
    });

    const result = await service.rotateMachineCredentials(
      machine.id,
      "admin-1",
    );

    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        secretHash: "scrypt:rotated-machine-secret-hash",
        secretVersion: expect.anything(),
      }),
    );
    expect(updateSet.mock.calls[0]?.[0].secretVersion).not.toBe(2);
    expect(result).toEqual(
      expect.objectContaining({
        machineId: machine.id,
        machineCode: "M001",
        secretVersion: 7,
      }),
    );
    expect(auditRecord).toHaveBeenCalledWith({
      adminUserId: "admin-1",
      action: "machines.credentials.rotate",
      resourceType: "machine",
      resourceId: machine.id,
      afterJson: { machineCode: "M001", secretVersion: 7 },
    });
  });

  it("generates a short-lived claim code and stores only a verifier hash", async () => {
    const machine = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      code: "M001",
    };
    const createdAt = new Date("2026-06-08T16:30:00.000Z");
    const inserted = {
      id: "550e8400-e29b-41d4-a716-446655440111",
      machineId: machine.id,
      verifierHash: "scrypt:test-salt:test-digest",
      state: "pending",
      failedAttemptCount: 0,
      maxFailedAttempts: 5,
      expiresAt: new Date("2026-06-08T16:40:00.000Z"),
      consumedAt: null,
      revokedAt: null,
      lockedAt: null,
      createdByAdminUserId: "admin-1",
      revokedByAdminUserId: null,
      createdAt,
      updatedAt: createdAt,
    };
    const insertValues = vi.fn().mockReturnValue({
      returning: async () => [inserted],
    });

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
          where: async () => [],
        }),
      });
    mockDb.insert.mockReturnValueOnce({ values: insertValues });

    const result = await service.generateMachineClaimCode(
      machine.id,
      "admin-1",
    );

    expect(result).toEqual(
      expect.objectContaining({
        id: inserted.id,
        machineId: machine.id,
        machineCode: "M001",
        claimCode: expect.stringMatching(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/),
        state: "pending",
        expiresAt: "2026-06-08T16:40:00.000Z",
        failedAttemptCount: 0,
        maxFailedAttempts: 5,
        createdAt: "2026-06-08T16:30:00.000Z",
      }),
    );
    const stored = insertValues.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(stored.machineId).toBe(machine.id);
    expect(stored.lookupDigest).toEqual(
      expect.stringMatching(/^[a-f0-9]{64}$/),
    );
    expect(stored.lookupDigest).not.toBe(result.claimCode);
    expect(stored.verifierHash).toEqual(expect.stringMatching(/^scrypt:/));
    expect(stored.verifierHash).not.toBe(result.claimCode);
    expect(stored).not.toHaveProperty("claimCode");
    expect(stored.failedAttemptCount).toBe(0);
    expect(stored.maxFailedAttempts).toBe(5);
    expect(stored.expiresAt).toBeInstanceOf(Date);
    expect(auditRecord).toHaveBeenCalledWith({
      adminUserId: "admin-1",
      action: "machines.claimCode.generate",
      resourceType: "machine",
      resourceId: machine.id,
      afterJson: {
        claimCodeId: inserted.id,
        machineCode: "M001",
        state: "pending",
        expiresAt: "2026-06-08T16:40:00.000Z",
      },
    });
  });

  it("rejects default first-claim generation for an already claimed machine", async () => {
    const machine = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      code: "M001",
      secretHash: null,
      secretVersion: 3,
      credentialRevokedAt: null,
    };

    mockDb.select.mockReturnValueOnce({
      from: () => ({
        where: () => ({
          limit: async () => [machine],
        }),
      }),
    });

    await expect(
      service.generateMachineClaimCode(machine.id, "admin-1"),
    ).rejects.toThrow(ConflictException);

    expect(mockDb.insert).not.toHaveBeenCalled();
    expect(auditRecord).not.toHaveBeenCalled();
  });

  it("rejects reclaim generation for a machine that has never been claimed", async () => {
    const machine = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      code: "M001",
      secretHash: null,
      secretVersion: 1,
      credentialRevokedAt: null,
    };

    mockDb.select.mockReturnValueOnce({
      from: () => ({
        where: () => ({
          limit: async () => [machine],
        }),
      }),
    });

    await expect(
      service.generateMachineClaimCode(machine.id, "admin-1", {
        purpose: "reclaim",
      }),
    ).rejects.toThrow(ConflictException);

    expect(mockDb.insert).not.toHaveBeenCalled();
    expect(auditRecord).not.toHaveBeenCalled();
  });

  it("generates a reclaim code for an already claimed machine with distinct audit intent", async () => {
    const machine = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      code: "M001",
      secretHash: "scrypt:existing-machine-secret-hash",
    };
    const inserted = {
      id: "550e8400-e29b-41d4-a716-446655440111",
      machineId: machine.id,
      verifierHash: "scrypt:test-salt:test-digest",
      purpose: "reclaim",
      state: "pending",
      failedAttemptCount: 0,
      maxFailedAttempts: 5,
      expiresAt: new Date("2026-06-08T16:40:00.000Z"),
      consumedAt: null,
      revokedAt: null,
      lockedAt: null,
      createdByAdminUserId: "admin-1",
      revokedByAdminUserId: null,
      createdAt: claimCodeNow,
      updatedAt: claimCodeNow,
    };
    const insertValues = vi.fn().mockReturnValue({
      returning: async () => [inserted],
    });

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
          where: async () => [],
        }),
      });
    mockDb.insert.mockReturnValueOnce({ values: insertValues });

    const result = await service.generateMachineClaimCode(
      machine.id,
      "admin-1",
      { purpose: "reclaim" },
    );

    expect(result).toEqual(
      expect.objectContaining({
        id: inserted.id,
        machineId: machine.id,
        machineCode: "M001",
        purpose: "reclaim",
        state: "pending",
        claimCode: expect.stringMatching(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/),
      }),
    );
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ machineId: machine.id, purpose: "reclaim" }),
    );
    expect(auditRecord).toHaveBeenCalledWith({
      adminUserId: "admin-1",
      action: "machines.claimCode.reclaim.generate",
      resourceType: "machine",
      resourceId: machine.id,
      afterJson: {
        claimCodeId: inserted.id,
        machineCode: "M001",
        purpose: "reclaim",
        state: "pending",
        expiresAt: "2026-06-08T16:40:00.000Z",
      },
    });
    expect(JSON.stringify(auditRecord.mock.calls)).not.toContain(
      result.claimCode,
    );
  });

  it("does not generate a second active claim code for the same machine", async () => {
    const machine = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      code: "M001",
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
          where: async () => [
            {
              id: "550e8400-e29b-41d4-a716-446655440111",
              state: "pending",
              expiresAt: new Date("2026-06-08T16:40:00.000Z"),
            },
          ],
        }),
      });

    await expect(
      service.generateMachineClaimCode(machine.id, "admin-1"),
    ).rejects.toThrow(ConflictException);
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it("returns conflict when a concurrent active claim code insert wins the race", async () => {
    const machine = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      code: "M001",
    };
    const uniqueViolation = Object.assign(
      new Error("duplicate key value violates unique constraint"),
      {
        code: "23505",
        constraint: "machine_claim_codes_machine_open_unique",
      },
    );
    const insertValues = vi.fn().mockReturnValue({
      returning: async () => {
        throw uniqueViolation;
      },
    });

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
          where: async () => [],
        }),
      });
    mockDb.insert.mockReturnValueOnce({ values: insertValues });

    await expect(
      service.generateMachineClaimCode(machine.id, "admin-1"),
    ).rejects.toThrow(ConflictException);

    expect(insertValues).toHaveBeenCalled();
    expect(auditRecord).not.toHaveBeenCalled();
  });

  it("marks expired pending claim codes before generating a replacement", async () => {
    const machine = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      code: "M001",
    };
    const createdAt = new Date("2026-06-08T16:30:00.000Z");
    const expiredPending = {
      id: "550e8400-e29b-41d4-a716-446655440110",
      state: "pending",
      expiresAt: new Date("2026-06-08T16:00:00.000Z"),
    };
    const inserted = {
      id: "550e8400-e29b-41d4-a716-446655440111",
      machineId: machine.id,
      verifierHash: "scrypt:test-salt:test-digest",
      state: "pending",
      failedAttemptCount: 0,
      maxFailedAttempts: 5,
      expiresAt: new Date("2026-06-08T16:40:00.000Z"),
      consumedAt: null,
      revokedAt: null,
      lockedAt: null,
      createdByAdminUserId: "admin-1",
      revokedByAdminUserId: null,
      createdAt,
      updatedAt: createdAt,
    };
    const expireSet = vi.fn().mockReturnValue({ where: async () => undefined });
    const insertValues = vi.fn().mockReturnValue({
      returning: async () => [inserted],
    });

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
          where: async () => [expiredPending],
        }),
      });
    mockDb.update.mockReturnValueOnce({ set: expireSet });
    mockDb.insert.mockReturnValueOnce({ values: insertValues });

    await expect(
      service.generateMachineClaimCode(machine.id, "admin-1"),
    ).resolves.toEqual(expect.objectContaining({ state: "pending" }));

    expect(expireSet).toHaveBeenCalledWith(
      expect.objectContaining({ state: "expired" }),
    );
    expect(insertValues).toHaveBeenCalled();
  });

  it("lists claim code lifecycle state without reusable claim secrets", async () => {
    const machine = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      code: "M001",
    };
    const createdAt = new Date("2026-06-08T16:00:00.000Z");
    const expiredPending = {
      id: "550e8400-e29b-41d4-a716-446655440111",
      machineId: machine.id,
      verifierHash: "scrypt:test-salt:test-digest",
      state: "pending",
      failedAttemptCount: 2,
      maxFailedAttempts: 5,
      expiresAt: new Date("2026-06-08T16:01:00.000Z"),
      consumedAt: null,
      revokedAt: null,
      lockedAt: null,
      createdByAdminUserId: "admin-1",
      revokedByAdminUserId: null,
      createdAt,
      updatedAt: createdAt,
    };
    const revoked = {
      ...expiredPending,
      id: "550e8400-e29b-41d4-a716-446655440112",
      state: "revoked",
      failedAttemptCount: 0,
      expiresAt: new Date("2026-06-08T16:40:00.000Z"),
      revokedAt: new Date("2026-06-08T16:10:00.000Z"),
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
            orderBy: async () => [revoked, expiredPending],
          }),
        }),
      });

    const result = await service.listMachineClaimCodes(
      machine.id,
      new Date("2026-06-08T16:30:00.000Z"),
    );

    expect(result.items).toEqual([
      expect.objectContaining({
        id: revoked.id,
        machineCode: "M001",
        state: "revoked",
        revokedAt: "2026-06-08T16:10:00.000Z",
      }),
      expect.objectContaining({
        id: expiredPending.id,
        state: "expired",
        failedAttemptCount: 2,
        expiresAt: "2026-06-08T16:01:00.000Z",
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain("scrypt:test-salt");
    expect(JSON.stringify(result)).not.toContain("claimCode");
  });

  it("returns a claim code detail without the raw code or verifier hash", async () => {
    const machine = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      code: "M001",
    };
    const createdAt = new Date("2026-06-08T16:00:00.000Z");
    const locked = {
      id: "550e8400-e29b-41d4-a716-446655440111",
      machineId: machine.id,
      verifierHash: "scrypt:test-salt:test-digest",
      state: "locked",
      failedAttemptCount: 5,
      maxFailedAttempts: 5,
      expiresAt: new Date("2026-06-08T16:40:00.000Z"),
      consumedAt: null,
      revokedAt: null,
      lockedAt: new Date("2026-06-08T16:20:00.000Z"),
      createdByAdminUserId: "admin-1",
      revokedByAdminUserId: null,
      createdAt,
      updatedAt: createdAt,
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
            limit: async () => [locked],
          }),
        }),
      });

    const result = await service.getMachineClaimCode(machine.id, locked.id);

    expect(result).toEqual(
      expect.objectContaining({
        id: locked.id,
        machineId: machine.id,
        machineCode: "M001",
        state: "locked",
        failedAttemptCount: 5,
        maxFailedAttempts: 5,
        lockedAt: "2026-06-08T16:20:00.000Z",
      }),
    );
    expect(JSON.stringify(result)).not.toContain("scrypt:test-salt");
    expect(JSON.stringify(result)).not.toContain("claimCode");
  });

  it("revokes a pending claim code and records a redacted audit entry", async () => {
    const machine = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      code: "M001",
    };
    const createdAt = new Date("2026-06-08T16:00:00.000Z");
    const pending = {
      id: "550e8400-e29b-41d4-a716-446655440111",
      machineId: machine.id,
      verifierHash: "scrypt:test-salt:test-digest",
      state: "pending",
      failedAttemptCount: 1,
      maxFailedAttempts: 5,
      expiresAt: new Date("2026-06-08T16:40:00.000Z"),
      consumedAt: null,
      revokedAt: null,
      lockedAt: null,
      createdByAdminUserId: "admin-1",
      revokedByAdminUserId: null,
      createdAt,
      updatedAt: createdAt,
    };
    const revoked = {
      ...pending,
      state: "revoked",
      revokedAt: new Date("2026-06-08T16:20:00.000Z"),
      revokedByAdminUserId: "admin-2",
    };
    const updateSet = vi.fn().mockReturnValue({
      where: () => ({ returning: async () => [revoked] }),
    });

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
            limit: async () => [pending],
          }),
        }),
      });
    mockDb.update.mockReturnValueOnce({ set: updateSet });

    const result = await service.revokeMachineClaimCode(
      machine.id,
      pending.id,
      "admin-2",
      new Date("2026-06-08T16:20:00.000Z"),
    );

    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "revoked",
        revokedByAdminUserId: "admin-2",
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        id: pending.id,
        state: "revoked",
        revokedAt: "2026-06-08T16:20:00.000Z",
      }),
    );
    expect(auditRecord).toHaveBeenCalledWith({
      adminUserId: "admin-2",
      action: "machines.claimCode.revoke",
      resourceType: "machine",
      resourceId: machine.id,
      beforeJson: {
        claimCodeId: pending.id,
        machineCode: "M001",
        state: "pending",
      },
      afterJson: {
        claimCodeId: pending.id,
        machineCode: "M001",
        state: "revoked",
      },
    });
    expect(JSON.stringify(auditRecord.mock.calls)).not.toContain(
      "scrypt:test-salt",
    );
  });

  it("revokes a pending reclaim code and records reclaim intent without raw code exposure", async () => {
    const machine = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      code: "M001",
    };
    const pending = {
      id: "550e8400-e29b-41d4-a716-446655440333",
      machineId: machine.id,
      verifierHash: "scrypt:reclaim-salt:test-digest",
      purpose: "reclaim",
      state: "pending",
      failedAttemptCount: 0,
      maxFailedAttempts: 5,
      expiresAt: new Date("2026-06-08T16:40:00.000Z"),
      consumedAt: null,
      revokedAt: null,
      lockedAt: null,
      createdByAdminUserId: "admin-1",
      revokedByAdminUserId: null,
      createdAt: new Date("2026-06-08T16:00:00.000Z"),
      updatedAt: new Date("2026-06-08T16:00:00.000Z"),
    };
    const revoked = {
      ...pending,
      state: "revoked",
      revokedAt: new Date("2026-06-08T16:20:00.000Z"),
      revokedByAdminUserId: "admin-2",
    };
    const updateSet = vi.fn().mockReturnValue({
      where: () => ({ returning: async () => [revoked] }),
    });

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
            limit: async () => [pending],
          }),
        }),
      });
    mockDb.update.mockReturnValueOnce({ set: updateSet });

    const result = await service.revokeMachineClaimCode(
      machine.id,
      pending.id,
      "admin-2",
      new Date("2026-06-08T16:20:00.000Z"),
    );

    expect(result).toEqual(
      expect.objectContaining({
        id: pending.id,
        purpose: "reclaim",
        state: "revoked",
        revokedAt: "2026-06-08T16:20:00.000Z",
      }),
    );
    expect(auditRecord).toHaveBeenCalledWith({
      adminUserId: "admin-2",
      action: "machines.claimCode.reclaim.revoke",
      resourceType: "machine",
      resourceId: machine.id,
      beforeJson: {
        claimCodeId: pending.id,
        machineCode: "M001",
        purpose: "reclaim",
        state: "pending",
      },
      afterJson: {
        claimCodeId: pending.id,
        machineCode: "M001",
        purpose: "reclaim",
        state: "revoked",
      },
    });
    expect(JSON.stringify(result)).not.toContain("scrypt:reclaim-salt");
    expect(JSON.stringify(auditRecord.mock.calls)).not.toContain(
      "scrypt:reclaim-salt",
    );
  });
});
