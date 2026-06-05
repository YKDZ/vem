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

describe("VendingService line-level fulfillment", () => {
  function makeService(options: {
    db: Record<string, unknown>;
    inventoryService?: Record<string, unknown>;
    refundsService?: Record<string, unknown>;
    machineStockMovementsService?: Record<string, unknown>;
  }) {
    return new VendingService(
      options.db as never,
      { bindVendingService: vi.fn() } as never,
      {} as never,
      { createDispenseFailedNotification: vi.fn() } as never,
      (options.inventoryService ?? {}) as never,
      (options.machineStockMovementsService ?? {}) as never,
      (options.refundsService ?? {}) as never,
      { createWorkOrder: vi.fn() } as never,
    );
  }

  function commandLookup(command: Record<string, unknown>) {
    return {
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([command]),
          }),
        }),
      }),
    };
  }

  function orderItemLookup(item: Record<string, unknown>) {
    return {
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([item]),
        }),
      }),
    };
  }

  it("resolves successful commands with independent order-line stock movement context", async () => {
    const movements: unknown[] = [];
    const db = {
      select: vi
        .fn()
        .mockReturnValueOnce(
          commandLookup({
            id: "cmd-1",
            commandNo: "CMD-1",
            orderId: "order1",
            machineId: "machine1",
            machineCode: "M001",
            slotId: "slot1",
            orderItemId: "line-1",
            status: "acknowledged",
            payloadJson: {},
            orderNo: "ORD-1",
          }),
        )
        .mockReturnValueOnce(
          orderItemLookup({
            id: "line-1",
            inventoryId: "inv1",
            quantity: 1,
            productSnapshot: { planogramVersion: "PLAN-A" },
          }),
        )
        .mockReturnValueOnce(
          commandLookup({
            id: "cmd-2",
            commandNo: "CMD-2",
            orderId: "order1",
            machineId: "machine1",
            machineCode: "M001",
            slotId: "slot2",
            orderItemId: "line-2",
            status: "acknowledged",
            payloadJson: {},
            orderNo: "ORD-1",
          }),
        )
        .mockReturnValueOnce(
          orderItemLookup({
            id: "line-2",
            inventoryId: "inv2",
            quantity: 1,
            productSnapshot: { planogramVersion: "PLAN-A" },
          }),
        ),
      update: vi.fn().mockReturnValue({
        set: vi
          .fn()
          .mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      }),
    };
    const service = makeService({
      db,
      machineStockMovementsService: {
        receiveRawMovement: vi
          .fn()
          .mockImplementation(async (_machine, movement) => {
            movements.push(movement);
            return { status: "accepted" };
          }),
      },
    });

    await service.resolveCommand("cmd-1", { result: "dispensed" });
    await service.resolveCommand("cmd-2", { result: "dispensed" });

    expect(movements).toEqual([
      expect.objectContaining({
        attributedTo: "CMD-1",
        orderContext: expect.objectContaining({
          orderItemId: "line-1",
          inventoryId: "inv1",
          vendingCommandNo: "CMD-1",
        }),
      }),
      expect.objectContaining({
        attributedTo: "CMD-2",
        orderContext: expect.objectContaining({
          orderItemId: "line-2",
          inventoryId: "inv2",
          vendingCommandNo: "CMD-2",
        }),
      }),
    ]);
  });

  it("partial failure refunds only the failed line after delivered line remains dispensed", async () => {
    const db = {
      select: vi.fn().mockReturnValueOnce(
        commandLookup({
          id: "cmd-2",
          commandNo: "CMD-2",
          orderId: "order1",
          machineId: "machine1",
          machineCode: "M001",
          slotId: "slot2",
          orderItemId: "line-2",
          status: "acknowledged",
          payloadJson: {},
          orderNo: "ORD-1",
        }),
      ),
      transaction: vi
        .fn()
        .mockImplementation(async (fn: (tx: unknown) => unknown) => {
          const tx = {
            update: vi.fn().mockReturnValue({
              set: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                  returning: vi.fn().mockResolvedValue([{ id: "cmd-2" }]),
                }),
              }),
            }),
            insert: vi.fn().mockReturnValue({
              values: vi.fn().mockResolvedValue(undefined),
            }),
            select: vi
              .fn()
              .mockReturnValueOnce({
                from: vi.fn().mockReturnValue({
                  where: vi.fn().mockResolvedValue([{ id: "line-2" }]),
                }),
              })
              .mockReturnValueOnce({
                from: vi.fn().mockReturnValue({
                  where: vi
                    .fn()
                    .mockResolvedValue([
                      { fulfillmentStatus: "dispensed" },
                      { fulfillmentStatus: "dispense_failed" },
                    ]),
                }),
              })
              .mockReturnValueOnce({
                from: vi.fn().mockReturnValue({
                  where: vi.fn().mockResolvedValue([
                    {
                      status: "dispensing",
                      paymentState: "paid",
                      fulfillmentState: "dispensing",
                    },
                  ]),
                }),
              })
              .mockReturnValueOnce({
                from: vi.fn().mockReturnValue({
                  where: vi.fn().mockResolvedValue([
                    {
                      id: "line-1",
                      fulfillmentStatus: "dispensed",
                      quantity: 1,
                      unitPriceCents: 500,
                    },
                    {
                      id: "line-2",
                      fulfillmentStatus: "dispense_failed",
                      quantity: 1,
                      unitPriceCents: 300,
                    },
                  ]),
                }),
              }),
          };
          return await fn(tx);
        }),
    };
    const requestPartialRefund = vi.fn().mockResolvedValue(undefined);
    const releaseAffectedReservationForDispenseFailure = vi
      .fn()
      .mockResolvedValue({
        releasedQuantity: 1,
        slotFaulted: false,
        slotSalesState: "suspect",
      });
    const service = makeService({
      db,
      inventoryService: { releaseAffectedReservationForDispenseFailure },
      refundsService: { requestPartialRefund, requestFullRefund: vi.fn() },
    });

    await service.resolveCommand("cmd-2", {
      result: "not_dispensed",
      note: "no drop",
    });

    expect(releaseAffectedReservationForDispenseFailure).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ orderItemId: "line-2", slotId: "slot2" }),
    );
    expect(requestPartialRefund).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: "order1",
        orderItemIds: ["line-2"],
        amountCents: 300,
      }),
    );
  });

  it("all failed lines trigger a full refund decision after releasing the failed line", async () => {
    const db = {
      select: vi.fn().mockReturnValueOnce(
        commandLookup({
          id: "cmd-2",
          commandNo: "CMD-2",
          orderId: "order1",
          machineId: "machine1",
          machineCode: "M001",
          slotId: "slot2",
          orderItemId: "line-2",
          status: "acknowledged",
          payloadJson: {},
          orderNo: "ORD-1",
        }),
      ),
      transaction: vi
        .fn()
        .mockImplementation(async (fn: (tx: unknown) => unknown) => {
          const tx = {
            update: vi.fn().mockReturnValue({
              set: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                  returning: vi.fn().mockResolvedValue([{ id: "cmd-2" }]),
                }),
              }),
            }),
            insert: vi.fn().mockReturnValue({
              values: vi.fn().mockResolvedValue(undefined),
            }),
            select: vi
              .fn()
              .mockReturnValueOnce({
                from: vi.fn().mockReturnValue({
                  where: vi.fn().mockResolvedValue([{ id: "line-2" }]),
                }),
              })
              .mockReturnValueOnce({
                from: vi.fn().mockReturnValue({
                  where: vi
                    .fn()
                    .mockResolvedValue([
                      { fulfillmentStatus: "dispense_failed" },
                      { fulfillmentStatus: "dispense_failed" },
                    ]),
                }),
              })
              .mockReturnValueOnce({
                from: vi.fn().mockReturnValue({
                  where: vi.fn().mockResolvedValue([
                    {
                      status: "dispensing",
                      paymentState: "paid",
                      fulfillmentState: "dispensing",
                    },
                  ]),
                }),
              })
              .mockReturnValueOnce({
                from: vi.fn().mockReturnValue({
                  where: vi.fn().mockResolvedValue([
                    {
                      id: "line-1",
                      fulfillmentStatus: "dispense_failed",
                      quantity: 1,
                      unitPriceCents: 500,
                    },
                    {
                      id: "line-2",
                      fulfillmentStatus: "dispense_failed",
                      quantity: 1,
                      unitPriceCents: 300,
                    },
                  ]),
                }),
              }),
          };
          return await fn(tx);
        }),
    };
    const requestFullRefund = vi.fn().mockResolvedValue(undefined);
    const requestPartialRefund = vi.fn().mockResolvedValue(undefined);
    const releaseAffectedReservationForDispenseFailure = vi
      .fn()
      .mockResolvedValue({
        releasedQuantity: 1,
        slotFaulted: false,
        slotSalesState: "suspect",
      });
    const service = makeService({
      db,
      inventoryService: { releaseAffectedReservationForDispenseFailure },
      refundsService: { requestPartialRefund, requestFullRefund },
    });

    await service.resolveCommand("cmd-2", {
      result: "not_dispensed",
      note: "no drop",
    });

    expect(requestFullRefund).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: "order1",
        reason: "auto_dispense_failed",
      }),
    );
    expect(requestPartialRefund).not.toHaveBeenCalled();
  });
});
