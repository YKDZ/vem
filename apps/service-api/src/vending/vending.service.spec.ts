import { describe, expect, it, vi } from "vitest";

import { VendingService } from "./vending.service";

describe("VendingService durable command dispatcher", () => {
  it("keeps an unpublished command pending and retries the same commandNo", async () => {
    const command = {
      id: "cmd-pending-1",
      commandNo: "CMD-PENDING-1",
      machineCode: "M001",
      payloadJson: {
        commandNo: "CMD-PENDING-1",
        orderNo: "ORD-1",
        slot: { rowNo: 1, cellNo: 1, slotDisplayLabel: "A1" },
        quantity: 1,
        timeoutSeconds: 120,
      },
    };
    const persistedSets: Array<Record<string, unknown>> = [];
    const db = {
      select: vi.fn().mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockResolvedValue([command]),
            }),
          }),
        }),
      })),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockImplementation((set: Record<string, unknown>) => {
          persistedSets.push(set);
          return {
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ ...command, ...set }]),
            }),
          };
        }),
      }),
    };
    const publish = vi
      .fn()
      .mockRejectedValueOnce(new Error("MQTT unavailable"))
      .mockResolvedValueOnce(undefined);
    const signForMachine = vi.fn().mockResolvedValue({ payload: {} });
    const service = new VendingService(
      db as never,
      { bindVendingService: vi.fn(), publish } as never,
      { signForMachine } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await service.dispatchPendingCommandsForOrder("order-1");
    expect(persistedSets[0]).not.toHaveProperty("status", "failed");

    await service.dispatchPendingCommandsForOrder("order-1");
    expect(publish).toHaveBeenCalledTimes(2);
    expect(signForMachine).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ messageId: "command:CMD-PENDING-1" }),
    );
    expect(persistedSets[1]).toEqual(
      expect.objectContaining({ status: "sent" }),
    );
  });
});

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
      execute: vi.fn().mockResolvedValue({ rowCount: 1 }),
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
      { resolveMachineOfflineNotification: vi.fn() } as never,
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

  it.each([
    {
      reportedAt: "2026-05-05T13:00:00.000Z",
      caseName: "future",
    },
    {
      reportedAt: "2026-05-05T11:00:00.000Z",
      caseName: "backdated",
    },
  ])(
    "valid heartbeat marks the platform machine online using server receive time for $caseName reportedAt",
    async ({ reportedAt }) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-05-05T12:00:00.000Z"));
      try {
        const payload = {
          machineCode: "M001",
          reportedAt,
          statusPayload: {
            network: "online",
            mqttConnected: true,
            hardwareStatus: "ok",
          },
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
        const machineSet = vi.fn().mockReturnValue({
          where: async () => undefined,
        });
        const resolveMachineOfflineNotification = vi.fn();
        const tx = {
          insert: vi
            .fn()
            .mockReturnValueOnce({ values: machineEventValues })
            .mockReturnValueOnce({ values: vi.fn() }),
          update: vi.fn().mockReturnValue({ set: machineSet }),
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
          { resolveMachineOfflineNotification } as never,
          {} as never,
          {} as never,
          {} as never,
          {} as never,
        );

        await service.handleMachineMessage(
          "vem/machines/M001/events/heartbeat",
          JSON.stringify({}),
        );

        expect(machineSet).toHaveBeenCalledWith(
          expect.objectContaining({
            status: "online",
            lastSeenAt: new Date("2026-05-05T12:00:00.000Z"),
          }),
        );
        expect(resolveMachineOfflineNotification).toHaveBeenCalledWith(tx, {
          machineId: "machine-1",
          machineCode: "M001",
          recoveredAt: new Date("2026-05-05T12:00:00.000Z"),
          lastSeenAt: new Date("2026-05-05T12:00:00.000Z"),
        });
      } finally {
        vi.useRealTimers();
      }
    },
  );
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
    mqttService?: Record<string, unknown>;
    mqttSignatureService?: Record<string, unknown>;
    notificationsService?: Record<string, unknown>;
    inventoryService?: Record<string, unknown>;
    refundsService?: Record<string, unknown>;
    machineStockMovementsService?: Record<string, unknown>;
  }) {
    return new VendingService(
      options.db as never,
      (options.mqttService ?? { bindVendingService: vi.fn() }) as never,
      (options.mqttSignatureService ?? {}) as never,
      (options.notificationsService ?? {
        createDispenseFailedNotification: vi.fn(),
      }) as never,
      (options.inventoryService ?? {}) as never,
      (options.machineStockMovementsService ?? {}) as never,
      {
        stageAutomaticFullRefund: vi.fn(),
        stageAutomaticPartialRefund: vi.fn(),
        dispatchPendingRefunds: vi.fn(),
        ...options.refundsService,
      } as never,
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

  it("repairs a missing stock movement when a succeeded command is replayed", async () => {
    const receiveRawMovement = vi.fn().mockResolvedValue({
      status: "accepted",
    });
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
            status: "succeeded",
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
        ),
    };
    const service = makeService({
      db,
      machineStockMovementsService: { receiveRawMovement },
    });

    const result = await service.resolveCommand("cmd-1", {
      result: "dispensed",
    });

    expect(result).toEqual({
      commandId: "cmd-1",
      status: "succeeded",
      stockMovementStatus: "accepted",
    });
    expect(receiveRawMovement).toHaveBeenCalledWith(
      { id: "machine1", code: "M001", status: "online" },
      expect.objectContaining({
        movementId: "manual-dispense:CMD-1",
        movementType: "dispense_succeeded",
        orderContext: expect.objectContaining({
          orderNo: "ORD-1",
          vendingCommandNo: "CMD-1",
        }),
      }),
    );
  });

  it("releases active reservations without restoring on-hand stock when MQTT dispatch fully fails", async () => {
    const order = {
      id: "order1",
      orderNo: "ORD-1",
      status: "paid",
      machineId: "machine1",
      machineCode: "M001",
    };
    const items = [
      {
        orderItemId: "line-1",
        slotId: "slot1",
        quantity: 1,
        rowNo: 1,
        cellNo: 1,
      },
      {
        orderItemId: "line-2",
        slotId: "slot2",
        quantity: 1,
        rowNo: 1,
        cellNo: 2,
      },
    ];
    const selectResponses = [
      {
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([order]),
          }),
        }),
      },
      {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue([]),
          }),
        }),
      },
      {
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(items),
          }),
        }),
      },
    ];
    const db = {
      select: vi.fn().mockImplementation(() => selectResponses.shift()),
      insert: vi
        .fn()
        .mockReturnValueOnce({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([
              {
                id: "cmd-1",
                commandNo: "CMD-1",
                orderId: "order1",
                machineId: "machine1",
                slotId: "slot1",
                orderItemId: "line-1",
                status: "pending",
              },
            ]),
          }),
        })
        .mockReturnValueOnce({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([
              {
                id: "cmd-2",
                commandNo: "CMD-2",
                orderId: "order1",
                machineId: "machine1",
                slotId: "slot2",
                orderItemId: "line-2",
                status: "pending",
              },
            ]),
          }),
        }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi
              .fn()
              .mockResolvedValueOnce([
                {
                  id: "cmd-1",
                  commandNo: "CMD-1",
                  orderId: "order1",
                  slotId: "slot1",
                  orderItemId: "line-1",
                  status: "failed",
                  lastError: "MQTT offline",
                },
              ])
              .mockResolvedValueOnce([
                {
                  id: "cmd-2",
                  commandNo: "CMD-2",
                  orderId: "order1",
                  slotId: "slot2",
                  orderItemId: "line-2",
                  status: "failed",
                  lastError: "MQTT offline",
                },
              ]),
          }),
        }),
      }),
      transaction: vi
        .fn()
        .mockImplementation(async (fn: (tx: unknown) => unknown) => {
          const tx = {
            execute: vi.fn().mockResolvedValue({ rowCount: 1 }),
            update: vi.fn().mockReturnValue({
              set: vi.fn().mockReturnValue({
                where: vi.fn().mockResolvedValue(undefined),
              }),
            }),
            insert: vi.fn().mockReturnValue({
              values: vi.fn().mockResolvedValue(undefined),
            }),
            select: vi
              .fn()
              .mockReturnValueOnce({
                from: vi.fn().mockReturnValue({
                  where: vi.fn().mockResolvedValue([{ id: "line-1" }]),
                }),
              })
              .mockReturnValueOnce({
                from: vi.fn().mockReturnValue({
                  where: vi
                    .fn()
                    .mockResolvedValue([
                      { fulfillmentStatus: "dispense_failed" },
                      { fulfillmentStatus: "pending" },
                    ]),
                }),
              })
              .mockReturnValueOnce({
                from: vi.fn().mockReturnValue({
                  where: vi.fn().mockResolvedValue([
                    {
                      status: "paid",
                      paymentState: "paid",
                      fulfillmentState: "awaiting_fulfillment",
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
                      fulfillmentStatus: "pending",
                      quantity: 1,
                      unitPriceCents: 300,
                    },
                  ]),
                }),
              })
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
    const releaseAffectedReservationForDispenseFailure = vi
      .fn()
      .mockResolvedValue({
        releasedQuantity: 1,
        slotFaulted: false,
        slotSalesState: "suspect",
      });
    const restoreConfirmedOrderItemsForDispatchFailure = vi
      .fn()
      .mockResolvedValue({ restoredQuantity: 2 });
    const requestFullRefund = vi.fn().mockResolvedValue(undefined);
    const service = makeService({
      db,
      mqttService: {
        bindVendingService: vi.fn(),
        publish: vi.fn().mockRejectedValue(new Error("MQTT offline")),
      },
      mqttSignatureService: {
        signForMachine: vi.fn().mockResolvedValue({ payload: {} }),
      },
      inventoryService: {
        releaseAffectedReservationForDispenseFailure,
        restoreConfirmedOrderItemsForDispatchFailure,
      },
      refundsService: { stageAutomaticFullRefund: requestFullRefund },
    });

    await service.createAndDispatchCommands("order1");

    expect(restoreConfirmedOrderItemsForDispatchFailure).not.toHaveBeenCalled();
    expect(releaseAffectedReservationForDispenseFailure).toHaveBeenCalledTimes(
      2,
    );
    expect(releaseAffectedReservationForDispenseFailure).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ orderItemId: "line-1", slotId: "slot1" }),
    );
    expect(releaseAffectedReservationForDispenseFailure).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ orderItemId: "line-2", slotId: "slot2" }),
    );
    expect(requestFullRefund).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orderId: "order1",
      }),
    );
  });

  it("releases only the failed line reservation when MQTT dispatch partially fails", async () => {
    const order = {
      id: "order1",
      orderNo: "ORD-1",
      status: "paid",
      machineId: "machine1",
      machineCode: "M001",
    };
    const items = [
      {
        orderItemId: "line-1",
        slotId: "slot1",
        quantity: 1,
        rowNo: 1,
        cellNo: 1,
      },
      {
        orderItemId: "line-2",
        slotId: "slot2",
        quantity: 1,
        rowNo: 1,
        cellNo: 2,
      },
    ];
    const selectResponses = [
      {
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([order]),
          }),
        }),
      },
      {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue([]),
          }),
        }),
      },
      {
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(items),
          }),
        }),
      },
    ];
    const db = {
      select: vi.fn().mockImplementation(() => selectResponses.shift()),
      insert: vi
        .fn()
        .mockReturnValueOnce({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([
              {
                id: "cmd-1",
                commandNo: "CMD-1",
                orderId: "order1",
                machineId: "machine1",
                slotId: "slot1",
                orderItemId: "line-1",
                status: "pending",
              },
            ]),
          }),
        })
        .mockReturnValueOnce({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([
              {
                id: "cmd-2",
                commandNo: "CMD-2",
                orderId: "order1",
                machineId: "machine1",
                slotId: "slot2",
                orderItemId: "line-2",
                status: "pending",
              },
            ]),
          }),
        }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi
              .fn()
              .mockResolvedValueOnce([
                {
                  id: "cmd-1",
                  commandNo: "CMD-1",
                  orderId: "order1",
                  slotId: "slot1",
                  orderItemId: "line-1",
                  status: "sent",
                  lastError: null,
                },
              ])
              .mockResolvedValueOnce([
                {
                  id: "cmd-2",
                  commandNo: "CMD-2",
                  orderId: "order1",
                  slotId: "slot2",
                  orderItemId: "line-2",
                  status: "failed",
                  lastError: "MQTT offline",
                },
              ]),
          }),
        }),
      }),
      transaction: vi
        .fn()
        .mockImplementation(async (fn: (tx: unknown) => unknown) => {
          const tx = {
            execute: vi.fn().mockResolvedValue({ rowCount: 1 }),
            update: vi.fn().mockReturnValue({
              set: vi.fn().mockReturnValue({
                where: vi.fn().mockResolvedValue(undefined),
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
                      { fulfillmentStatus: "dispensing" },
                      { fulfillmentStatus: "dispense_failed" },
                    ]),
                }),
              })
              .mockReturnValueOnce({
                from: vi.fn().mockReturnValue({
                  where: vi.fn().mockResolvedValue([
                    {
                      status: "paid",
                      paymentState: "paid",
                      fulfillmentState: "awaiting_fulfillment",
                    },
                  ]),
                }),
              })
              .mockReturnValueOnce({
                from: vi.fn().mockReturnValue({
                  where: vi.fn().mockResolvedValue([
                    {
                      id: "line-1",
                      fulfillmentStatus: "dispensing",
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
    const publish = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("MQTT offline"));
    const releaseAffectedReservationForDispenseFailure = vi
      .fn()
      .mockResolvedValue({
        releasedQuantity: 1,
        slotFaulted: false,
        slotSalesState: "suspect",
      });
    const restoreConfirmedOrderItemsForDispatchFailure = vi
      .fn()
      .mockResolvedValue({ restoredQuantity: 1 });
    const requestFullRefund = vi.fn().mockResolvedValue(undefined);
    const requestPartialRefund = vi.fn().mockResolvedValue(undefined);
    const service = makeService({
      db,
      mqttService: { bindVendingService: vi.fn(), publish },
      mqttSignatureService: {
        signForMachine: vi.fn().mockResolvedValue({ payload: {} }),
      },
      inventoryService: {
        releaseAffectedReservationForDispenseFailure,
        restoreConfirmedOrderItemsForDispatchFailure,
      },
      refundsService: { requestFullRefund, requestPartialRefund },
    });

    await service.createAndDispatchCommands("order1");

    expect(restoreConfirmedOrderItemsForDispatchFailure).not.toHaveBeenCalled();
    expect(releaseAffectedReservationForDispenseFailure).toHaveBeenCalledOnce();
    expect(releaseAffectedReservationForDispenseFailure).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ orderItemId: "line-2", slotId: "slot2" }),
    );
    expect(requestFullRefund).not.toHaveBeenCalled();
    expect(requestPartialRefund).not.toHaveBeenCalled();
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
            execute: vi.fn().mockResolvedValue({ rowCount: 1 }),
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
      refundsService: { stageAutomaticPartialRefund: requestPartialRefund },
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
      expect.anything(),
      expect.objectContaining({
        orderId: "order1",
        orderItemIds: ["line-2"],
        amountCents: 300,
      }),
    );
  });

  it("marks timed out commands result_unknown and freezes the slot pending physical confirmation", async () => {
    const now = new Date("2026-06-26T07:00:00.000Z");
    const updateSets: unknown[] = [];
    const insertedValues: unknown[] = [];
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            {
              id: "cmd-timeout",
              commandNo: "CMD-TIMEOUT",
              orderId: "order1",
              slotId: "slot1",
              payloadJson: {
                commandNo: "CMD-TIMEOUT",
                orderNo: "ORD-1",
                slot: { rowNo: 1, cellNo: 1, slotDisplayLabel: "A1" },
                quantity: 1,
                timeoutSeconds: 1,
              },
              sentAt: new Date("2026-06-26T06:55:00.000Z"),
              ackAt: null,
            },
          ]),
        }),
      }),
      transaction: vi
        .fn()
        .mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
          const tx = {
            execute: vi.fn().mockResolvedValue({ rowCount: 1 }),
            select: vi.fn().mockReturnValue({
              from: vi.fn().mockReturnValue({
                where: vi
                  .fn()
                  .mockResolvedValue([
                    { status: "dispensing", paymentState: "paid" },
                  ]),
              }),
            }),
            update: vi.fn().mockReturnValue({
              set: vi.fn((value: unknown) => {
                updateSets.push(value);
                return {
                  where: vi.fn().mockReturnValue({
                    returning: vi.fn().mockResolvedValue([{ id: "updated" }]),
                  }),
                };
              }),
            }),
            insert: vi.fn().mockReturnValue({
              values: vi.fn((value: unknown) => {
                insertedValues.push(value);
                return Promise.resolve();
              }),
            }),
          };
          return await fn(tx);
        }),
    };
    const notificationsService = {
      createDispenseFailedNotification: vi.fn().mockResolvedValue(undefined),
    };
    const service = makeService({ db, notificationsService });

    const result = await service.markTimedOutCommands(now);

    expect(result.processed).toBe(1);
    expect(updateSets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "result_unknown",
          lastError: "dispense result unknown after command timeout",
        }),
        expect.objectContaining({
          fulfillmentState: "manual_handling",
        }),
        expect.objectContaining({
          status: "faulted",
        }),
      ]),
    );
    expect(insertedValues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: "dispense_result_unknown",
          metadata: expect.objectContaining({
            commandNo: "CMD-TIMEOUT",
            requiresPhysicalOutcomeConfirmation: true,
            slotSalesState: "frozen",
          }),
        }),
      ]),
    );
    expect(
      notificationsService.createDispenseFailedNotification,
    ).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ commandId: "cmd-timeout" }),
    );
  });

  it("treats daemon-reported UNKNOWN dispense result as manual handling without refunding", async () => {
    const payload = {
      commandNo: "CMD-UNKNOWN",
      success: false,
      errorCode: "UNKNOWN",
      message: "dispense result unknown after daemon restart",
      reportedAt: "2026-06-26T07:00:00.000Z",
    };
    const updateSets: unknown[] = [];
    const insertedValues: unknown[] = [];
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ id: "machine1", code: "M001" }]),
        }),
      }),
      transaction: vi
        .fn()
        .mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
          const tx = {
            execute: vi.fn().mockResolvedValue({ rowCount: 1 }),
            insert: vi.fn().mockReturnValue({
              values: vi.fn((value: unknown) => {
                insertedValues.push(value);
                return {
                  onConflictDoNothing: vi.fn().mockReturnValue({
                    returning: vi.fn().mockResolvedValue([{ id: "event1" }]),
                  }),
                };
              }),
            }),
            select: vi
              .fn()
              .mockReturnValueOnce({
                from: vi.fn().mockReturnValue({
                  innerJoin: vi.fn().mockReturnValue({
                    where: vi.fn().mockResolvedValue([
                      {
                        id: "cmd-unknown",
                        commandNo: "CMD-UNKNOWN",
                        orderId: "order1",
                        machineId: "machine1",
                        slotId: "slot1",
                        orderItemId: "line1",
                        status: "acknowledged",
                        payloadJson: {},
                        orderNo: "ORD-UNKNOWN",
                      },
                    ]),
                  }),
                }),
              })
              .mockReturnValueOnce({
                from: vi.fn().mockReturnValue({
                  where: vi
                    .fn()
                    .mockResolvedValue([
                      { status: "dispensing", paymentState: "paid" },
                    ]),
                }),
              }),
            update: vi.fn().mockReturnValue({
              set: vi.fn((value: unknown) => {
                updateSets.push(value);
                return {
                  where: vi.fn().mockReturnValue({
                    returning: vi.fn().mockResolvedValue([{ id: "updated" }]),
                  }),
                };
              }),
            }),
          };
          return await fn(tx);
        }),
    };
    const releaseAffectedReservationForDispenseFailure = vi.fn();
    const requestFullRefund = vi.fn();
    const requestPartialRefund = vi.fn();
    const notificationsService = {
      createDispenseFailedNotification: vi.fn().mockResolvedValue(undefined),
    };
    const service = makeService({
      db,
      mqttSignatureService: {
        verifyFromTopic: vi.fn().mockResolvedValue({
          payload,
          messageId: "result:CMD-UNKNOWN",
        }),
      },
      notificationsService,
      inventoryService: { releaseAffectedReservationForDispenseFailure },
      refundsService: { requestFullRefund, requestPartialRefund },
    });

    await service.handleMachineMessage(
      "vem/machines/M001/events/dispense-result",
      JSON.stringify({}),
    );

    expect(updateSets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "result_unknown",
          lastError: "dispense result unknown after daemon restart",
        }),
        expect.objectContaining({
          fulfillmentState: "manual_handling",
        }),
        expect.objectContaining({
          status: "faulted",
        }),
      ]),
    );
    expect(insertedValues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: "dispense_result_unknown",
          metadata: expect.objectContaining({
            commandNo: "CMD-UNKNOWN",
            requiresPhysicalOutcomeConfirmation: true,
            slotSalesState: "frozen",
          }),
        }),
      ]),
    );
    expect(releaseAffectedReservationForDispenseFailure).not.toHaveBeenCalled();
    expect(requestFullRefund).not.toHaveBeenCalled();
    expect(requestPartialRefund).not.toHaveBeenCalled();
    expect(
      notificationsService.createDispenseFailedNotification,
    ).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ commandId: "cmd-unknown" }),
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
            execute: vi.fn().mockResolvedValue({ rowCount: 1 }),
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
      refundsService: {
        stageAutomaticPartialRefund: requestPartialRefund,
        stageAutomaticFullRefund: requestFullRefund,
      },
    });

    await service.resolveCommand("cmd-2", {
      result: "not_dispensed",
      note: "no drop",
    });

    expect(requestFullRefund).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orderId: "order1",
      }),
    );
    expect(requestPartialRefund).not.toHaveBeenCalled();
  });
});
