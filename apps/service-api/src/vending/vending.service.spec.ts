import { describe, expect, it, vi } from "vitest";

import { VendingService } from "./vending.service";

describe("VendingService heartbeat ingestion", () => {
  it("persists nested environment heartbeat data", async () => {
    const statusPayload = {
      network: "online",
      mqttConnected: true,
      hardwareStatus: "ok",
      environment: {
        temperatureCelsius: 24,
        humidityRh: 53,
        sampledAt: "2026-05-05T12:00:00.000Z",
        sensorStatus: "ok",
        airConditionerOn: false,
        targetTemperatureCelsius: null,
      },
    };
    const payload = {
      machineCode: "M001",
      reportedAt: "2026-05-05T12:00:01.000Z",
      statusPayload,
    };

    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: () => ({
          where: async () => [{ id: "machine-1", code: "M001" }],
        }),
      }),
      transaction: vi.fn(),
    };
    const machineEventValues = vi.fn().mockReturnValue({
      onConflictDoNothing: () => ({
        returning: async () => [{ id: "event-1" }],
      }),
    });
    const heartbeatValues = vi.fn();
    const tx = {
      insert: vi
        .fn()
        .mockReturnValueOnce({ values: machineEventValues })
        .mockReturnValueOnce({ values: heartbeatValues }),
      update: vi.fn().mockReturnValue({
        set: () => ({
          where: async () => undefined,
        }),
      }),
    };
    mockDb.transaction.mockImplementation(
      async (cb: (txArg: unknown) => Promise<void>) => {
        await cb(tx);
      },
    );

    const service = new VendingService(
      mockDb as never,
      { bindVendingService: vi.fn() } as never,
      {
        verifyFromTopic: vi.fn().mockResolvedValue({
          payload,
          messageId: "heartbeat-1",
        }),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await service.handleMachineMessage(
      "vem/machines/M001/events/heartbeat",
      JSON.stringify({}),
    );

    expect(heartbeatValues).toHaveBeenCalledWith({
      machineId: "machine-1",
      statusPayloadJson: statusPayload,
      reportedAt: new Date("2026-05-05T12:00:01.000Z"),
    });
  });
});

describe("VendingService environment control isolation", () => {
  it("ignores environment control results without fulfillment or compensation side effects", async () => {
    const verifyFromTopic = vi.fn();
    const mockDb = {
      select: vi.fn(),
      transaction: vi.fn(),
      update: vi.fn(),
      insert: vi.fn(),
    };
    const inventoryService = { compensateDispenseFailure: vi.fn() };
    const refundsService = { requestFullRefund: vi.fn() };
    const notificationsService = {
      createDispenseFailedNotification: vi.fn(),
    };
    const maintenanceWorkOrdersService = { createWorkOrder: vi.fn() };
    const service = new VendingService(
      mockDb as never,
      { bindVendingService: vi.fn() } as never,
      { verifyFromTopic } as never,
      notificationsService as never,
      inventoryService as never,
      {} as never,
      refundsService as never,
      maintenanceWorkOrdersService as never,
    );

    await service.handleMachineMessage(
      "vem/machines/M001/events/environment-control-result",
      JSON.stringify({ payload: { commandNo: "MCMD-1", success: true } }),
    );

    expect(verifyFromTopic).not.toHaveBeenCalled();
    expect(mockDb.transaction).not.toHaveBeenCalled();
    expect(inventoryService.compensateDispenseFailure).not.toHaveBeenCalled();
    expect(refundsService.requestFullRefund).not.toHaveBeenCalled();
    expect(
      notificationsService.createDispenseFailedNotification,
    ).not.toHaveBeenCalled();
    expect(maintenanceWorkOrdersService.createWorkOrder).not.toHaveBeenCalled();
  });
});
