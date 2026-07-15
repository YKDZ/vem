import {
  DrizzleDB,
  eq,
  inventories,
  inventoryReservations,
  machineSlots,
  machines,
  orderItems,
  orders,
  orderStatusEvents,
  paymentEvents,
  paymentProviders,
  payments,
  products,
  productVariants,
  sql,
  vendingCommands,
} from "@vem/db";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { InventoryService } from "../inventory/inventory.service";
import { VendingService } from "../vending/vending.service";
import { PaymentsService } from "./payments.service";

const databaseUrl = process.env.VEM_TEST_POSTGRES_URL;
const postgresDescribe = databaseUrl ? describe : describe.skip;

postgresDescribe("payment terminal transition PostgreSQL serialization", () => {
  let database: DrizzleDB;

  beforeAll(async () => {
    database = new DrizzleDB(databaseUrl);
    await database.connect();
    await database.client.execute(
      sql.raw(`
      create or replace function vem_test_delay_payment_success() returns trigger as $$
      begin
        if new.provider_event_id like 'terminal-race-success:%' then
          perform pg_sleep(0.5);
        end if;
        return new;
      end;
      $$ language plpgsql;
      create trigger vem_test_delay_payment_success_trigger
      before insert on payment_events
      for each row execute function vem_test_delay_payment_success();
    `),
    );
  });

  afterAll(async () => {
    await database?.client.execute(
      sql.raw(`
        drop trigger if exists vem_test_delay_payment_success_trigger on payment_events;
        drop function if exists vem_test_delay_payment_success();
      `),
    );
    await database?.disconnect();
  });

  it("applies only the successful winner when success and failure race", async () => {
    const suffix = Date.now().toString();
    const machineId = randomUUID();
    const providerId = randomUUID();
    const productId = randomUUID();
    const variantId = randomUUID();
    const slotId = randomUUID();
    const inventoryId = randomUUID();
    const orderId = randomUUID();
    const paymentId = randomUUID();
    const orderItemId = randomUUID();

    await database.client.insert(machines).values({
      id: machineId,
      code: `PG-TERMINAL-RACE-${suffix}`,
      name: "Terminal payment race",
      status: "online",
    });
    await database.client.insert(paymentProviders).values({
      id: providerId,
      code: `terminal-race-provider-${suffix}`,
      name: "Terminal race provider",
      type: "mock",
      capabilities: {},
    });
    await database.client.insert(products).values({
      id: productId,
      name: "Race product",
      status: "active",
    });
    await database.client.insert(productVariants).values({
      id: variantId,
      productId,
      sku: `PG-TERMINAL-RACE-SKU-${suffix}`,
      priceCents: 100,
      status: "active",
    });
    await database.client.insert(machineSlots).values({
      id: slotId,
      machineId,
      layerNo: 1,
      cellNo: 1,
      slotCode: "A1",
      capacity: 10,
      status: "enabled",
    });
    await database.client.insert(inventories).values({
      id: inventoryId,
      machineId,
      slotId,
      variantId,
      onHandQty: 10,
      reservedQty: 1,
    });
    await database.client.insert(orders).values({
      id: orderId,
      orderNo: `ORD-PG-TERMINAL-RACE-${suffix}`,
      machineId,
      totalAmountCents: 100,
    });
    await database.client.insert(orderItems).values({
      id: orderItemId,
      orderId,
      variantId,
      inventoryId,
      slotId,
      quantity: 1,
      unitPriceCents: 100,
      productSnapshot: {},
    });
    await database.client.insert(payments).values({
      id: paymentId,
      paymentNo: `PAY-PG-TERMINAL-RACE-${suffix}`,
      orderId,
      providerId,
      method: "qr_code",
      status: "pending",
      amountCents: 100,
    });
    await database.client
      .update(orders)
      .set({ paymentId })
      .where(eq(orders.id, orderId));
    await database.client.insert(inventoryReservations).values({
      orderId,
      orderItemId,
      inventoryId,
      quantity: 1,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const inventoryService = new InventoryService(
      database.client,
      {} as never,
      {} as never,
    );
    const durableVendingService = new VendingService(
      database.client,
      {} as never,
      {} as never,
      {} as never,
      inventoryService,
      {} as never,
      {} as never,
      {} as never,
    );
    const vendingService = {
      createPendingDispatchCommands:
        durableVendingService.createPendingDispatchCommands.bind(
          durableVendingService,
        ),
      dispatchPendingCommandsForOrder: async () => [],
    };
    const service = new PaymentsService(
      database.client,
      inventoryService,
      vendingService as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    const success = service.applyProviderPaymentResult({
      paymentId,
      providerTradeNo: "TRADE-PG-TERMINAL-RACE-01",
      status: "succeeded",
      eventType: "terminal-race.succeeded",
      providerEventId: "terminal-race-success:01",
      rawPayload: { status: "succeeded" },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const failure = service.applyProviderPaymentResult({
      paymentId,
      providerTradeNo: null,
      status: "failed",
      failedReason: "racing_failure",
      eventType: "terminal-race.failed",
      providerEventId: "terminal-race-failed:01",
      rawPayload: { status: "failed" },
    });

    const applied = await Promise.all([success, failure]);
    expect(applied).toEqual([true, false]);

    const [payment] = await database.client
      .select({ status: payments.status })
      .from(payments)
      .where(eq(payments.id, paymentId));
    const [order] = await database.client
      .select({
        status: orders.status,
        paymentState: orders.paymentState,
        fulfillmentState: orders.fulfillmentState,
      })
      .from(orders)
      .where(eq(orders.id, orderId));
    const [reservation] = await database.client
      .select({ status: inventoryReservations.status })
      .from(inventoryReservations)
      .where(eq(inventoryReservations.orderId, orderId));
    const events = await database.client
      .select({ eventType: paymentEvents.eventType })
      .from(paymentEvents)
      .where(eq(paymentEvents.paymentId, paymentId));
    const orderEvents = await database.client
      .select({ reason: orderStatusEvents.reason })
      .from(orderStatusEvents)
      .where(eq(orderStatusEvents.orderId, orderId));
    const commands = await database.client
      .select({ status: vendingCommands.status })
      .from(vendingCommands)
      .where(eq(vendingCommands.orderId, orderId));

    expect(payment.status).toBe("succeeded");
    expect(order).toEqual({
      status: "paid",
      paymentState: "paid",
      fulfillmentState: "awaiting_fulfillment",
    });
    expect(reservation.status).toBe("active");
    expect(events).toEqual([{ eventType: "terminal-race.succeeded" }]);
    expect(orderEvents).toEqual([{ reason: "reconcile_succeeded" }]);
    expect(commands).toEqual([{ status: "pending" }]);
  });
});
