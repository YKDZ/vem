import { NotFoundException } from "@nestjs/common";
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
