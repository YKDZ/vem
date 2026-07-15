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
  paymentProviderConfigs,
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
import { PaymentConfigSecretService } from "./payment-config-secret.service";
import { PaymentProviderConfigService } from "./payment-provider-config.service";
import { PaymentWebhookAttemptRecorderService } from "./payment-webhook-attempt-recorder.service";
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

  it("applies only the successful webhook winner when success and failure race", async () => {
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
    const providerConfigId = randomUUID();
    const providerCode = `terminal-race-provider-${suffix}`;

    await database.client.insert(machines).values({
      id: machineId,
      code: `PG-TERMINAL-RACE-${suffix}`,
      name: "Terminal payment race",
      status: "online",
    });
    await database.client.insert(paymentProviders).values({
      id: providerId,
      code: providerCode,
      name: "Terminal race provider",
      type: "mock",
      capabilities: {},
    });
    const appConfig = {
      paymentConfigEncryptionKey: `terminal-race-key-${suffix}`,
      paymentMockEnabled: false,
      buildPaymentNotifyUrl: () =>
        "https://pay.example.test/api/payments/webhooks/terminal-race",
    };
    const paymentConfigSecrets = new PaymentConfigSecretService(
      appConfig as never,
    );
    const paymentProviderConfigService = new PaymentProviderConfigService(
      database.client,
      paymentConfigSecrets,
      appConfig as never,
    );
    await database.client.insert(paymentProviderConfigs).values({
      id: providerConfigId,
      providerId,
      publicConfigJson: {},
      configEncryptedJson: paymentConfigSecrets.encrypt({ token: "test" }),
      status: "enabled",
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
      paymentProviderConfigId: providerConfigId,
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
    const provider = {
      async handleWebhook(input: { body: unknown }) {
        const status = Reflect.get(input.body as object, "status") as
          | "succeeded"
          | "failed";
        return {
          eventKind: "payment" as const,
          eventType: `terminal-race.${status}`,
          providerEventId:
            status === "succeeded"
              ? `terminal-race-success:${suffix}`
              : `terminal-race-failed:${suffix}`,
          paymentNo: `PAY-PG-TERMINAL-RACE-${suffix}`,
          providerTradeNo:
            status === "succeeded" ? "TRADE-PG-TERMINAL-RACE-01" : null,
          paymentStatus: status,
          signatureValid: true,
          rawPayload: { status },
          matchedConfigId: providerConfigId,
        };
      },
    };
    const service = new PaymentsService(
      database.client,
      inventoryService,
      vendingService as never,
      appConfig as never,
      { get: () => provider, has: () => true } as never,
      {} as never,
      paymentConfigSecrets,
      paymentProviderConfigService,
      new PaymentWebhookAttemptRecorderService(database.client),
      {} as never,
    );

    const success = service.handleProviderWebhook(
      providerCode,
      {},
      { status: "succeeded" },
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    const failure = service.handleProviderWebhook(
      providerCode,
      {},
      { status: "failed" },
    );

    const handled = await Promise.all([success, failure]);
    expect(handled).toEqual([
      { handled: true, duplicate: false },
      {
        handled: true,
        duplicate: false,
        stale: true,
        reason: "stale_terminal_status",
      },
    ]);

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
    const [inventory] = await database.client
      .select({ reservedQty: inventories.reservedQty })
      .from(inventories)
      .where(eq(inventories.id, inventoryId));
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
    expect(inventory.reservedQty).toBe(1);
    expect(events).toEqual([{ eventType: "terminal-race.succeeded" }]);
    expect(orderEvents).toEqual([{ reason: "webhook_payment_succeeded" }]);
    expect(commands).toEqual([{ status: "pending" }]);
  });
});
