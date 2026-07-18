import {
  DrizzleDB,
  eq,
  inventories,
  inventoryReservations,
  machineSlots,
  machines,
  orderItems,
  orders,
  paymentCodeAttempts,
  paymentEvents,
  paymentProviders,
  payments,
  productVariants,
  products,
  sql,
  vendingCommands,
} from "@vem/db";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { InventoryService } from "../inventory/inventory.service";
import { VendingService } from "../vending/vending.service";
import { PaymentCodeAttemptsService } from "./payment-code-attempts.service";
import { PaymentCodeRecoveryService } from "./payment-code-recovery.service";
import { PaymentConfigSecretService } from "./payment-config-secret.service";
import { PaymentProviderConfigService } from "./payment-provider-config.service";
import { PaymentWebhookAttemptRecorderService } from "./payment-webhook-attempt-recorder.service";
import { PaymentsService } from "./payments.service";

const databaseUrl = process.env.VEM_TEST_POSTGRES_URL;
const postgresDescribe = databaseUrl ? describe : describe.skip;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

async function seedAdmittedAttempt(
  instanceA: DrizzleDB,
  options: {
    attemptStatus?: "submitting" | "querying";
    expiresAt?: Date;
  } = {},
) {
  const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const machineId = randomUUID();
  const [existingMockProvider] = await instanceA.client
    .select({ id: paymentProviders.id })
    .from(paymentProviders)
    .where(eq(paymentProviders.code, "mock"))
    .limit(1);
  const providerId = existingMockProvider?.id ?? randomUUID();
  const productId = randomUUID();
  const variantId = randomUUID();
  const slotId = randomUUID();
  const inventoryId = randomUUID();
  const orderId = randomUUID();
  const paymentId = randomUUID();
  const orderItemId = randomUUID();
  const attemptId = randomUUID();
  const paymentNo = `PAY-PG-PC-RECOVERY-${suffix}`;
  const providerPaymentNo = `PCA-PG-RECOVERY-${suffix}`;

  await instanceA.client.insert(machines).values({
    id: machineId,
    code: `PG-PC-RECOVERY-${suffix}`,
    name: "Payment code recovery",
    status: "online",
  });
  if (!existingMockProvider) {
    await instanceA.client.insert(paymentProviders).values({
      id: providerId,
      code: "mock",
      name: "Mock payment provider",
      type: "mock",
      capabilities: {},
    });
  }
  await instanceA.client.insert(products).values({
    id: productId,
    name: "Payment code recovery product",
    status: "active",
  });
  await instanceA.client.insert(productVariants).values({
    id: variantId,
    productId,
    sku: `PG-PC-RECOVERY-SKU-${suffix}`,
    priceCents: 100,
    status: "active",
  });
  await instanceA.client.insert(machineSlots).values({
    id: slotId,
    machineId,
    layerNo: 1,
    cellNo: 1,
    slotCode: "A1",
    capacity: 10,
    status: "enabled",
  });
  await instanceA.client.insert(inventories).values({
    id: inventoryId,
    machineId,
    slotId,
    variantId,
    onHandQty: 10,
    reservedQty: 1,
  });
  await instanceA.client.insert(orders).values({
    id: orderId,
    orderNo: `ORD-PG-PC-RECOVERY-${suffix}`,
    machineId,
    totalAmountCents: 100,
  });
  await instanceA.client.insert(orderItems).values({
    id: orderItemId,
    orderId,
    variantId,
    inventoryId,
    slotId,
    quantity: 1,
    unitPriceCents: 100,
    productSnapshot: {},
  });
  await instanceA.client.insert(payments).values({
    id: paymentId,
    paymentNo,
    orderId,
    providerId,
    method: "payment_code",
    status: "pending",
    amountCents: 100,
    expiresAt: options.expiresAt ?? new Date(Date.now() + 60_000),
  });
  await instanceA.client
    .update(orders)
    .set({ paymentId })
    .where(eq(orders.id, orderId));
  await instanceA.client.insert(inventoryReservations).values({
    orderId,
    orderItemId,
    inventoryId,
    quantity: 1,
    expiresAt: new Date(Date.now() + 60_000),
  });

  // Instance A committed the provider-admission boundary, then died before it
  // could schedule its in-memory confirmation task.
  await instanceA.client.insert(paymentCodeAttempts).values({
    id: attemptId,
    paymentId,
    orderId,
    providerId,
    attemptNo: 1,
    providerPaymentNo,
    idempotencyKey: `recovery:${suffix}`,
    status: options.attemptStatus ?? "submitting",
    isActive: true,
    amountCents: 100,
    currency: "CNY",
    authCodeHash: "a".repeat(64),
    authCodeMasked: "2876****4394",
    source: "serial_text",
    submittedAt: new Date(),
  });

  return {
    attemptId,
    inventoryId,
    orderId,
    paymentId,
    paymentNo,
    providerPaymentNo,
  };
}

type PaymentCodeProviderStub = Partial<{
  chargePaymentCode: ReturnType<typeof vi.fn>;
  queryPaymentCode: ReturnType<typeof vi.fn>;
  reversePaymentCode: ReturnType<typeof vi.fn>;
}>;

type WorkerFaults = {
  beforeProviderCall?: (input: {
    operation: "charge" | "query" | "reverse";
    attemptId: string;
  }) => Promise<void>;
  afterProviderResponse?: (input: {
    operation: "charge" | "query" | "reverse";
    attemptId: string;
  }) => Promise<void>;
};

function makeDurableWorker(
  database: DrizzleDB,
  provider: PaymentCodeProviderStub,
  faults: WorkerFaults = {},
  options: {
    recoveryLeaseMs?: number;
    providerCallTimeoutMs?: number;
    recoveryBatchSize?: number;
    recoveryMaxAttempts?: number;
  } = {},
): PaymentCodeRecoveryService {
  const appConfig = {
    paymentConfigEncryptionKey: "payment-code-recovery-test-key-000000000001",
    paymentMockEnabled: true,
    paymentReconcileIntervalSeconds: 120,
  };
  const inventoryService = new InventoryService(
    database.client,
    {} as never,
    {} as never,
  );
  const paymentConfigSecrets = new PaymentConfigSecretService(
    appConfig as never,
  );
  const paymentProviderConfigService = new PaymentProviderConfigService(
    database.client,
    paymentConfigSecrets,
    appConfig as never,
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
  const paymentsService = new PaymentsService(
    database.client,
    inventoryService,
    {
      createPendingDispatchCommands:
        durableVendingService.createPendingDispatchCommands.bind(
          durableVendingService,
        ),
      dispatchPendingCommandsForOrder: async () => undefined,
    } as never,
    appConfig as never,
    {} as never,
    {} as never,
    paymentConfigSecrets,
    paymentProviderConfigService,
    new PaymentWebhookAttemptRecorderService(database.client),
    {} as never,
  );
  return new PaymentCodeRecoveryService(
    new PaymentCodeAttemptsService(database.client),
    {
      getPaymentCodeProvider: () => ({ code: "mock", ...provider }),
    } as never,
    paymentProviderConfigService,
    paymentsService,
    appConfig as never,
    faults,
    options,
  );
}

function makeRecoveryWorker(
  database: DrizzleDB,
  provider: Pick<
    Required<PaymentCodeProviderStub>,
    "queryPaymentCode" | "reversePaymentCode"
  >,
): PaymentCodeRecoveryService {
  return makeDurableWorker(database, provider);
}

async function seedPayablePaymentCodeOrder(instance: DrizzleDB) {
  const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const machineId = randomUUID();
  const [existingMockProvider] = await instance.client
    .select({ id: paymentProviders.id })
    .from(paymentProviders)
    .where(eq(paymentProviders.code, "mock"))
    .limit(1);
  const providerId = existingMockProvider?.id ?? randomUUID();
  const productId = randomUUID();
  const variantId = randomUUID();
  const slotId = randomUUID();
  const inventoryId = randomUUID();
  const orderId = randomUUID();
  const paymentId = randomUUID();
  const orderItemId = randomUUID();
  const orderNo = `ORD-PG-PC-DURABLE-${suffix}`;

  await instance.client.insert(machines).values({
    id: machineId,
    code: `PG-PC-DURABLE-${suffix}`,
    name: "Payment code durable worker",
    status: "online",
  });
  if (!existingMockProvider) {
    await instance.client.insert(paymentProviders).values({
      id: providerId,
      code: "mock",
      name: "Mock payment provider",
      type: "mock",
      capabilities: {},
    });
  }
  await instance.client.insert(products).values({
    id: productId,
    name: "Payment code durable product",
    status: "active",
  });
  await instance.client.insert(productVariants).values({
    id: variantId,
    productId,
    sku: `PG-PC-DURABLE-SKU-${suffix}`,
    priceCents: 100,
    status: "active",
  });
  await instance.client.insert(machineSlots).values({
    id: slotId,
    machineId,
    layerNo: 1,
    cellNo: 1,
    slotCode: "A1",
    capacity: 10,
    status: "enabled",
  });
  await instance.client.insert(inventories).values({
    id: inventoryId,
    machineId,
    slotId,
    variantId,
    onHandQty: 10,
    reservedQty: 1,
  });
  await instance.client.insert(orders).values({
    id: orderId,
    orderNo,
    machineId,
    totalAmountCents: 100,
  });
  await instance.client.insert(orderItems).values({
    id: orderItemId,
    orderId,
    variantId,
    inventoryId,
    slotId,
    quantity: 1,
    unitPriceCents: 100,
    productSnapshot: {},
  });
  await instance.client.insert(payments).values({
    id: paymentId,
    paymentNo: `PAY-PG-PC-DURABLE-${suffix}`,
    orderId,
    providerId,
    method: "payment_code",
    status: "pending",
    amountCents: 100,
    expiresAt: new Date(Date.now() + 60_000),
  });
  await instance.client
    .update(orders)
    .set({ paymentId })
    .where(eq(orders.id, orderId));
  await instance.client.insert(inventoryReservations).values({
    orderId,
    orderItemId,
    inventoryId,
    quantity: 1,
    expiresAt: new Date(Date.now() + 60_000),
  });

  return {
    inventoryId,
    orderId,
    paymentId,
    orderNo,
    machineCode: `PG-PC-DURABLE-${suffix}`,
  };
}

async function createDurableAttempt(
  database: DrizzleDB,
  seeded: Awaited<ReturnType<typeof seedPayablePaymentCodeOrder>>,
  idempotencyKey: string,
) {
  return await new PaymentCodeAttemptsService(database.client).createOrReplay({
    orderNo: seeded.orderNo,
    machineCode: seeded.machineCode,
    authCode: "28763443825664394",
    idempotencyKey,
    source: "serial_text",
    mockPaymentEnabled: true,
  });
}

async function makeAttemptRecoverableNow(
  database: DrizzleDB,
  attemptId: string,
) {
  await database.client
    .update(paymentCodeAttempts)
    .set({
      recoveryLeaseExpiresAt: new Date(Date.now() - 1),
      recoveryNextAt: new Date(Date.now() - 1),
      updatedAt: new Date(),
    })
    .where(eq(paymentCodeAttempts.id, attemptId));
}

postgresDescribe(
  "payment-code PostgreSQL recovery",
  { concurrent: false },
  () => {
    const databases: DrizzleDB[] = [];

    beforeAll(async () => {
      const database = new DrizzleDB(databaseUrl);
      databases.push(database);
      await database.connect();
      await database.client.execute(
        sql.raw(`
        create or replace function vem_test_assert_payment_code_terminal_order()
        returns trigger as $$
        begin
          if new.status = 'succeeded' and new.is_active = false and not exists (
            select 1
            from payments p
            inner join orders o on o.id = p.order_id
            where p.id = new.payment_id
              and p.status = 'succeeded'
              and o.status = 'paid'
              and o.payment_state = 'paid'
          ) then
            raise exception 'payment-code attempt succeeded before payment/order success';
          end if;
          if new.status = 'reversed' and new.is_active = false and not exists (
            select 1
            from payments p
            inner join orders o on o.id = p.order_id
            where p.id = new.payment_id
              and p.status = 'failed'
              and o.status = 'canceled'
              and o.payment_state = 'payment_failed'
          ) then
            raise exception 'payment-code attempt reversed before payment/order failure';
          end if;
          if new.status = 'failed'
            and new.is_active = false
            and new.provider_status = 'TRADE_NOT_FOUND'
            and not exists (
              select 1
              from payments p
              inner join orders o on o.id = p.order_id
              where p.id = new.payment_id
                and p.status = 'failed'
                and o.status = 'canceled'
                and o.payment_state = 'payment_failed'
            ) then
            raise exception 'payment-code attempt failed before payment/order failure';
          end if;
          if new.status = 'manual_handling'
            and new.is_active = true
            and new.recovery_next_at is null
            and not exists (
              select 1
              from payments p
              inner join orders o on o.id = p.order_id
              where p.id = new.payment_id
                and p.status = 'unknown'
                and o.status = 'manual_handling'
                and o.payment_state = 'payment_unknown'
                and o.fulfillment_state = 'manual_handling'
            ) then
            raise exception 'payment-code manual handling before payment/order incident state';
          end if;
          return new;
        end;
        $$ language plpgsql;
        drop trigger if exists vem_test_assert_payment_code_terminal_order_trigger
          on payment_code_attempts;
        create trigger vem_test_assert_payment_code_terminal_order_trigger
        before update of status, is_active on payment_code_attempts
        for each row execute function vem_test_assert_payment_code_terminal_order();
      `),
      );
    });

    afterAll(async () => {
      const database = databases[0];
      if (database) {
        await database.client.execute(
          sql.raw(`
            drop trigger if exists vem_test_assert_payment_code_terminal_order_trigger
              on payment_code_attempts;
            drop function if exists vem_test_assert_payment_code_terminal_order();
          `),
        );
      }
      await Promise.all(
        databases.map(async (database) => {
          await database.disconnect();
        }),
      );
    });

    it("recovers a real crash after provider charge acceptance without a second charge", async () => {
      const instanceA = new DrizzleDB(databaseUrl);
      databases.push(instanceA);
      await instanceA.connect();
      const seeded = await seedPayablePaymentCodeOrder(instanceA);
      const attempts = new PaymentCodeAttemptsService(instanceA.client);
      const created = await attempts.createOrReplay({
        orderNo: seeded.orderNo,
        machineCode: seeded.machineCode,
        authCode: "28763443825664394",
        idempotencyKey: `durable-crash:${seeded.paymentId}`,
        source: "serial_text",
        mockPaymentEnabled: true,
      });
      const chargedByProvider = new Map<string, string>();
      const provider = {
        chargePaymentCode: vi.fn(
          async (input: { paymentNo: string; idempotencyKey?: string }) => {
            const providerTradeNo =
              chargedByProvider.get(input.paymentNo) ??
              `MOCK-${input.paymentNo}`;
            chargedByProvider.set(input.paymentNo, providerTradeNo);
            return {
              status: "succeeded" as const,
              providerTradeNo,
              providerStatus: "TRADE_SUCCESS",
              rawPayload: { trade_status: "TRADE_SUCCESS" },
            };
          },
        ),
        queryPaymentCode: vi.fn(async (input: { paymentNo: string }) => ({
          status: "succeeded" as const,
          providerTradeNo: chargedByProvider.get(input.paymentNo) ?? null,
          providerStatus: "TRADE_SUCCESS",
          rawPayload: { trade_status: "TRADE_SUCCESS" },
        })),
        reversePaymentCode: vi.fn(),
      };
      const workerA = makeDurableWorker(instanceA, provider, {
        afterProviderResponse: async ({ operation }) => {
          if (operation === "charge") throw new Error("injected worker crash");
        },
      });

      await expect(
        workerA.submitAttempt({
          attemptId: created.attempt.id,
          authCode: "28763443825664394",
          clientIp: "127.0.0.1",
        }),
      ).rejects.toThrow("injected worker crash");
      expect(provider.chargePaymentCode).toHaveBeenCalledTimes(1);
      expect(provider.chargePaymentCode).toHaveBeenCalledWith(
        expect.objectContaining({
          paymentNo: created.attempt.providerPaymentNo,
          idempotencyKey: created.attempt.providerPaymentNo,
        }),
      );

      const [afterCrash] = await instanceA.client
        .select({
          status: paymentCodeAttempts.status,
          isActive: paymentCodeAttempts.isActive,
          recoveryLeaseOwnerToken: paymentCodeAttempts.recoveryLeaseOwnerToken,
          recoveryLeaseFence: paymentCodeAttempts.recoveryLeaseFence,
        })
        .from(paymentCodeAttempts)
        .where(eq(paymentCodeAttempts.id, created.attempt.id));
      expect(afterCrash).toMatchObject({
        status: "submitting",
        isActive: true,
        recoveryLeaseOwnerToken: expect.any(String),
        recoveryLeaseFence: expect.any(Number),
      });
      await instanceA.disconnect();
      databases.pop();

      const instanceB = new DrizzleDB(databaseUrl);
      databases.push(instanceB);
      await instanceB.connect();
      await instanceB.client
        .update(paymentCodeAttempts)
        .set({ recoveryLeaseExpiresAt: new Date(Date.now() - 1) })
        .where(eq(paymentCodeAttempts.id, created.attempt.id));

      const recovered = await makeDurableWorker(
        instanceB,
        provider,
      ).reconcileDueAttempts();
      expect(recovered.claimed).toBeGreaterThanOrEqual(1);

      expect(provider.chargePaymentCode).toHaveBeenCalledTimes(1);
      expect(
        provider.queryPaymentCode.mock.calls.filter(
          ([input]) =>
            (input as { paymentNo: string }).paymentNo ===
            created.attempt.providerPaymentNo,
        ),
      ).toHaveLength(1);
      const [attempt] = await instanceB.client
        .select({
          status: paymentCodeAttempts.status,
          isActive: paymentCodeAttempts.isActive,
        })
        .from(paymentCodeAttempts)
        .where(eq(paymentCodeAttempts.id, created.attempt.id));
      const [payment] = await instanceB.client
        .select({ status: payments.status })
        .from(payments)
        .where(eq(payments.id, seeded.paymentId));
      const [order] = await instanceB.client
        .select({
          status: orders.status,
          paymentState: orders.paymentState,
          fulfillmentState: orders.fulfillmentState,
        })
        .from(orders)
        .where(eq(orders.id, seeded.orderId));
      const [reservation] = await instanceB.client
        .select({ status: inventoryReservations.status })
        .from(inventoryReservations)
        .where(eq(inventoryReservations.orderId, seeded.orderId));
      const [inventory] = await instanceB.client
        .select({ reservedQty: inventories.reservedQty })
        .from(inventories)
        .where(eq(inventories.id, seeded.inventoryId));
      const events = await instanceB.client
        .select({ id: paymentEvents.id })
        .from(paymentEvents)
        .where(eq(paymentEvents.paymentId, seeded.paymentId));
      const commands = await instanceB.client
        .select({ id: vendingCommands.id })
        .from(vendingCommands)
        .where(eq(vendingCommands.orderId, seeded.orderId));

      expect(attempt).toEqual({ status: "succeeded", isActive: false });
      expect(payment.status).toBe("succeeded");
      expect(order).toEqual({
        status: "paid",
        paymentState: "paid",
        fulfillmentState: "awaiting_fulfillment",
      });
      expect(reservation.status).toBe("active");
      expect(inventory.reservedQty).toBe(1);
      expect(events).toHaveLength(1);
      expect(commands).toHaveLength(1);
    });

    it("lets exactly one restarted instance recover provider admission using the attempt payment number", async () => {
      const instanceA = new DrizzleDB(databaseUrl);
      databases.push(instanceA);
      await instanceA.connect();
      const seeded = await seedAdmittedAttempt(instanceA);
      await instanceA.disconnect();
      databases.pop();

      const instanceB = new DrizzleDB(databaseUrl);
      const competingInstanceB = new DrizzleDB(databaseUrl);
      databases.push(instanceB, competingInstanceB);
      await Promise.all([instanceB.connect(), competingInstanceB.connect()]);

      const queryStarted = deferred<void>();
      const releaseQuery = deferred<void>();
      const provider = {
        queryPaymentCode: vi.fn(async () => {
          queryStarted.resolve();
          await releaseQuery.promise;
          return {
            status: "succeeded" as const,
            providerTradeNo: "MOCK-CODE-RECOVERY-01",
            providerStatus: "TRADE_SUCCESS",
            rawPayload: { trade_status: "TRADE_SUCCESS" },
          };
        }),
        reversePaymentCode: vi.fn(),
      };
      const worker = makeRecoveryWorker(instanceB, provider);
      const competingWorker = makeRecoveryWorker(competingInstanceB, provider);

      const recovery = worker.reconcileDueAttempts();
      await queryStarted.promise;
      await expect(competingWorker.reconcileDueAttempts()).resolves.toEqual({
        claimed: 0,
      });
      releaseQuery.resolve();
      await expect(recovery).resolves.toEqual({ claimed: 1 });

      expect(provider.queryPaymentCode).toHaveBeenCalledTimes(1);
      expect(provider.queryPaymentCode).toHaveBeenCalledWith(
        expect.objectContaining({
          paymentNo: seeded.providerPaymentNo,
          providerTradeNo: null,
        }),
      );
      expect(provider.queryPaymentCode).not.toHaveBeenCalledWith(
        expect.objectContaining({ paymentNo: seeded.paymentNo }),
      );

      const [attempt] = await instanceB.client
        .select({
          status: paymentCodeAttempts.status,
          isActive: paymentCodeAttempts.isActive,
          recoveryLeaseOwnerToken: paymentCodeAttempts.recoveryLeaseOwnerToken,
          recoveryLeaseExpiresAt: paymentCodeAttempts.recoveryLeaseExpiresAt,
          recoveryAttemptCount: paymentCodeAttempts.recoveryAttemptCount,
        })
        .from(paymentCodeAttempts)
        .where(eq(paymentCodeAttempts.id, seeded.attemptId));
      const [payment] = await instanceB.client
        .select({ status: payments.status })
        .from(payments)
        .where(eq(payments.id, seeded.paymentId));
      const [order] = await instanceB.client
        .select({
          status: orders.status,
          paymentState: orders.paymentState,
          fulfillmentState: orders.fulfillmentState,
        })
        .from(orders)
        .where(eq(orders.id, seeded.orderId));
      const [reservation] = await instanceB.client
        .select({ status: inventoryReservations.status })
        .from(inventoryReservations)
        .where(eq(inventoryReservations.orderId, seeded.orderId));
      const [inventory] = await instanceB.client
        .select({ reservedQty: inventories.reservedQty })
        .from(inventories)
        .where(eq(inventories.id, seeded.inventoryId));

      expect(attempt).toMatchObject({
        status: "succeeded",
        isActive: false,
        recoveryLeaseOwnerToken: null,
        recoveryLeaseExpiresAt: null,
        recoveryAttemptCount: 1,
      });
      expect(payment.status).toBe("succeeded");
      expect(order).toEqual({
        status: "paid",
        paymentState: "paid",
        fulfillmentState: "awaiting_fulfillment",
      });
      expect(reservation.status).toBe("active");
      expect(inventory.reservedQty).toBe(1);
    });

    it("reverses an expired querying attempt and releases its reservation after restart", async () => {
      const instanceA = new DrizzleDB(databaseUrl);
      databases.push(instanceA);
      await instanceA.connect();
      const seeded = await seedAdmittedAttempt(instanceA, {
        attemptStatus: "querying",
        expiresAt: new Date(Date.now() - 1_000),
      });
      await instanceA.disconnect();
      databases.pop();

      const instanceB = new DrizzleDB(databaseUrl);
      databases.push(instanceB);
      await instanceB.connect();
      const provider = {
        queryPaymentCode: vi.fn().mockResolvedValue({
          status: "processing",
          providerTradeNo: "MOCK-CODE-RECOVERY-EXPIRED",
          providerStatus: "WAIT_BUYER_PAY",
          rawPayload: { trade_status: "WAIT_BUYER_PAY" },
        }),
        reversePaymentCode: vi.fn().mockResolvedValue({
          status: "reversed",
          providerStatus: "TRADE_CLOSED",
          rawPayload: { action: "reverse" },
        }),
      };

      await expect(
        makeRecoveryWorker(instanceB, provider).reconcileDueAttempts(),
      ).resolves.toEqual({ claimed: 1 });

      expect(provider.queryPaymentCode).toHaveBeenCalledWith(
        expect.objectContaining({ paymentNo: seeded.providerPaymentNo }),
      );
      expect(provider.reversePaymentCode).toHaveBeenCalledWith(
        expect.objectContaining({ paymentNo: seeded.providerPaymentNo }),
      );
      const [attempt] = await instanceB.client
        .select({
          status: paymentCodeAttempts.status,
          isActive: paymentCodeAttempts.isActive,
        })
        .from(paymentCodeAttempts)
        .where(eq(paymentCodeAttempts.id, seeded.attemptId));
      const [payment] = await instanceB.client
        .select({ status: payments.status })
        .from(payments)
        .where(eq(payments.id, seeded.paymentId));
      const [order] = await instanceB.client
        .select({
          status: orders.status,
          paymentState: orders.paymentState,
          fulfillmentState: orders.fulfillmentState,
        })
        .from(orders)
        .where(eq(orders.id, seeded.orderId));
      const [reservation] = await instanceB.client
        .select({ status: inventoryReservations.status })
        .from(inventoryReservations)
        .where(eq(inventoryReservations.orderId, seeded.orderId));
      const [inventory] = await instanceB.client
        .select({ reservedQty: inventories.reservedQty })
        .from(inventories)
        .where(eq(inventories.id, seeded.inventoryId));

      expect(attempt).toEqual({ status: "reversed", isActive: false });
      expect(payment.status).toBe("failed");
      expect(order).toEqual({
        status: "canceled",
        paymentState: "payment_failed",
        fulfillmentState: "canceled",
      });
      expect(reservation.status).toBe("released");
      expect(inventory.reservedQty).toBe(0);
    });

    it("turns exhausted recovery into manual handling while preserving charged uncertainty", async () => {
      const instanceA = new DrizzleDB(databaseUrl);
      databases.push(instanceA);
      await instanceA.connect();
      const seeded = await seedAdmittedAttempt(instanceA, {
        attemptStatus: "querying",
      });
      await instanceA.client
        .update(paymentCodeAttempts)
        .set({ recoveryAttemptCount: 7 })
        .where(eq(paymentCodeAttempts.id, seeded.attemptId));
      await instanceA.disconnect();
      databases.pop();

      const instanceB = new DrizzleDB(databaseUrl);
      databases.push(instanceB);
      await instanceB.connect();
      const provider = {
        queryPaymentCode: vi.fn(),
        reversePaymentCode: vi.fn(),
      };

      await expect(
        makeRecoveryWorker(instanceB, provider).reconcileDueAttempts(),
      ).resolves.toEqual({ claimed: 1 });

      expect(provider.queryPaymentCode).not.toHaveBeenCalled();
      expect(provider.reversePaymentCode).not.toHaveBeenCalled();
      const [attempt] = await instanceB.client
        .select({
          status: paymentCodeAttempts.status,
          isActive: paymentCodeAttempts.isActive,
          recoveryAttemptCount: paymentCodeAttempts.recoveryAttemptCount,
          recoveryLeaseOwnerToken: paymentCodeAttempts.recoveryLeaseOwnerToken,
        })
        .from(paymentCodeAttempts)
        .where(eq(paymentCodeAttempts.id, seeded.attemptId));
      const [payment] = await instanceB.client
        .select({ status: payments.status })
        .from(payments)
        .where(eq(payments.id, seeded.paymentId));
      const [order] = await instanceB.client
        .select({
          status: orders.status,
          paymentState: orders.paymentState,
          fulfillmentState: orders.fulfillmentState,
        })
        .from(orders)
        .where(eq(orders.id, seeded.orderId));
      const [reservation] = await instanceB.client
        .select({ status: inventoryReservations.status })
        .from(inventoryReservations)
        .where(eq(inventoryReservations.orderId, seeded.orderId));
      const [inventory] = await instanceB.client
        .select({ reservedQty: inventories.reservedQty })
        .from(inventories)
        .where(eq(inventories.id, seeded.inventoryId));

      expect(attempt).toEqual({
        status: "manual_handling",
        isActive: true,
        recoveryAttemptCount: 8,
        recoveryLeaseOwnerToken: null,
      });
      expect(payment.status).toBe("unknown");
      expect(order).toEqual({
        status: "manual_handling",
        paymentState: "payment_unknown",
        fulfillmentState: "manual_handling",
      });
      expect(reservation.status).toBe("active");
      expect(inventory.reservedQty).toBe(1);
    });

    it("recovers a pre-charge worker kill by querying without issuing a charge", async () => {
      const instanceA = new DrizzleDB(databaseUrl);
      databases.push(instanceA);
      await instanceA.connect();
      const seeded = await seedPayablePaymentCodeOrder(instanceA);
      const created = await createDurableAttempt(
        instanceA,
        seeded,
        `before-charge-kill:${seeded.paymentId}`,
      );
      const provider = {
        chargePaymentCode: vi.fn(),
        queryPaymentCode: vi.fn().mockResolvedValue({
          status: "failed",
          providerTradeNo: null,
          providerStatus: "TRADE_NOT_FOUND",
          failureCode: "TRADE_NOT_FOUND",
          rawPayload: { trade_status: "TRADE_NOT_FOUND" },
        }),
        reversePaymentCode: vi.fn(),
      };
      const workerA = makeDurableWorker(instanceA, provider, {
        beforeProviderCall: async ({ operation }) => {
          if (operation === "charge") throw new Error("injected before charge");
        },
      });

      await expect(
        workerA.submitAttempt({
          attemptId: created.attempt.id,
          authCode: "28763443825664394",
          clientIp: null,
        }),
      ).rejects.toThrow("injected before charge");
      expect(provider.chargePaymentCode).not.toHaveBeenCalled();

      const [afterKill] = await instanceA.client
        .select({
          status: paymentCodeAttempts.status,
          isActive: paymentCodeAttempts.isActive,
        })
        .from(paymentCodeAttempts)
        .where(eq(paymentCodeAttempts.id, created.attempt.id));
      expect(afterKill).toEqual({ status: "submitting", isActive: true });

      await instanceA.disconnect();
      databases.pop();
      const instanceB = new DrizzleDB(databaseUrl);
      databases.push(instanceB);
      await instanceB.connect();
      await makeAttemptRecoverableNow(instanceB, created.attempt.id);

      await expect(
        makeDurableWorker(instanceB, provider).reconcileDueAttempts(),
      ).resolves.toEqual({ claimed: 1 });

      const [attempt] = await instanceB.client
        .select({
          status: paymentCodeAttempts.status,
          isActive: paymentCodeAttempts.isActive,
        })
        .from(paymentCodeAttempts)
        .where(eq(paymentCodeAttempts.id, created.attempt.id));
      const [payment] = await instanceB.client
        .select({ status: payments.status })
        .from(payments)
        .where(eq(payments.id, seeded.paymentId));
      const [order] = await instanceB.client
        .select({ status: orders.status, paymentState: orders.paymentState })
        .from(orders)
        .where(eq(orders.id, seeded.orderId));
      const [reservation] = await instanceB.client
        .select({ status: inventoryReservations.status })
        .from(inventoryReservations)
        .where(eq(inventoryReservations.orderId, seeded.orderId));

      expect(provider.chargePaymentCode).not.toHaveBeenCalled();
      expect(provider.queryPaymentCode).toHaveBeenCalledTimes(1);
      expect(attempt).toEqual({ status: "failed", isActive: false });
      expect(payment.status).toBe("failed");
      expect(order).toEqual({
        status: "canceled",
        paymentState: "payment_failed",
      });
      expect(reservation.status).toBe("released");
    });

    it("keeps a definite scan rejection retryable without releasing inventory", async () => {
      const instance = new DrizzleDB(databaseUrl);
      databases.push(instance);
      await instance.connect();
      const seeded = await seedPayablePaymentCodeOrder(instance);
      const created = await createDurableAttempt(
        instance,
        seeded,
        `retryable-rejection:${seeded.paymentId}`,
      );
      const provider = {
        chargePaymentCode: vi.fn().mockResolvedValue({
          status: "failed",
          providerTradeNo: null,
          providerStatus: "AUTH_CODE_INVALID",
          failureCode: "AUTH_CODE_INVALID",
          failureMessage: "付款码已失效",
          rawPayload: { code: "AUTH_CODE_INVALID" },
        }),
        queryPaymentCode: vi.fn(),
        reversePaymentCode: vi.fn(),
      };

      await makeDurableWorker(instance, provider).submitAttempt({
        attemptId: created.attempt.id,
        authCode: "28763443825664394",
        clientIp: null,
      });

      const [attempt] = await instance.client
        .select({
          status: paymentCodeAttempts.status,
          isActive: paymentCodeAttempts.isActive,
          failureCode: paymentCodeAttempts.failureCode,
        })
        .from(paymentCodeAttempts)
        .where(eq(paymentCodeAttempts.id, created.attempt.id));
      const [payment] = await instance.client
        .select({ status: payments.status })
        .from(payments)
        .where(eq(payments.id, seeded.paymentId));
      const [order] = await instance.client
        .select({
          status: orders.status,
          paymentState: orders.paymentState,
          fulfillmentState: orders.fulfillmentState,
        })
        .from(orders)
        .where(eq(orders.id, seeded.orderId));
      const [reservation] = await instance.client
        .select({ status: inventoryReservations.status })
        .from(inventoryReservations)
        .where(eq(inventoryReservations.orderId, seeded.orderId));
      const [inventory] = await instance.client
        .select({ reservedQty: inventories.reservedQty })
        .from(inventories)
        .where(eq(inventories.id, seeded.inventoryId));

      expect(attempt).toEqual({
        status: "failed",
        isActive: false,
        failureCode: "AUTH_CODE_INVALID",
      });
      expect(payment.status).toBe("pending");
      expect(order).toEqual({
        status: "pending_payment",
        paymentState: "awaiting_payment",
        fulfillmentState: "awaiting_fulfillment",
      });
      expect(reservation.status).toBe("active");
      expect(inventory.reservedQty).toBe(1);

      const retry = await createDurableAttempt(
        instance,
        seeded,
        `retryable-rejection-retry:${seeded.paymentId}`,
      );
      expect(retry.attempt.attemptNo).toBe(2);
      expect(retry.attempt.isActive).toBe(true);
    });

    it("keeps query success recoverable when killed before the atomic terminal apply", async () => {
      const instanceA = new DrizzleDB(databaseUrl);
      databases.push(instanceA);
      await instanceA.connect();
      const seeded = await seedPayablePaymentCodeOrder(instanceA);
      const created = await createDurableAttempt(
        instanceA,
        seeded,
        `query-apply-kill:${seeded.paymentId}`,
      );
      const provider = {
        chargePaymentCode: vi.fn().mockResolvedValue({
          status: "processing",
          providerTradeNo: "MOCK-QUERY-KILL",
          providerStatus: "WAIT_BUYER_PAY",
          rawPayload: { trade_status: "WAIT_BUYER_PAY" },
        }),
        queryPaymentCode: vi.fn().mockResolvedValue({
          status: "succeeded",
          providerTradeNo: "MOCK-QUERY-KILL",
          providerStatus: "TRADE_SUCCESS",
          rawPayload: { trade_status: "TRADE_SUCCESS" },
        }),
        reversePaymentCode: vi.fn(),
      };
      const workerA = makeDurableWorker(instanceA, provider, {
        afterProviderResponse: async ({ operation }) => {
          if (operation === "query") {
            throw new Error("injected after query response");
          }
        },
      });

      await workerA.submitAttempt({
        attemptId: created.attempt.id,
        authCode: "28763443825664394",
        clientIp: null,
      });
      await makeAttemptRecoverableNow(instanceA, created.attempt.id);

      await expect(workerA.reconcileDueAttempts()).rejects.toThrow(
        "injected after query response",
      );
      const [afterKillAttempt] = await instanceA.client
        .select({
          status: paymentCodeAttempts.status,
          isActive: paymentCodeAttempts.isActive,
        })
        .from(paymentCodeAttempts)
        .where(eq(paymentCodeAttempts.id, created.attempt.id));
      const [afterKillPayment] = await instanceA.client
        .select({ status: payments.status })
        .from(payments)
        .where(eq(payments.id, seeded.paymentId));
      const [afterKillOrder] = await instanceA.client
        .select({ status: orders.status })
        .from(orders)
        .where(eq(orders.id, seeded.orderId));
      const [afterKillReservation] = await instanceA.client
        .select({ status: inventoryReservations.status })
        .from(inventoryReservations)
        .where(eq(inventoryReservations.orderId, seeded.orderId));

      expect(afterKillAttempt).toEqual({ status: "querying", isActive: true });
      expect(afterKillPayment.status).toBe("pending");
      expect(afterKillOrder.status).toBe("pending_payment");
      expect(afterKillReservation.status).toBe("active");

      await instanceA.disconnect();
      databases.pop();
      const instanceB = new DrizzleDB(databaseUrl);
      databases.push(instanceB);
      await instanceB.connect();
      await makeAttemptRecoverableNow(instanceB, created.attempt.id);
      await expect(
        makeDurableWorker(instanceB, provider).reconcileDueAttempts(),
      ).resolves.toEqual({ claimed: 1 });

      const [attempt] = await instanceB.client
        .select({
          status: paymentCodeAttempts.status,
          isActive: paymentCodeAttempts.isActive,
        })
        .from(paymentCodeAttempts)
        .where(eq(paymentCodeAttempts.id, created.attempt.id));
      const [payment] = await instanceB.client
        .select({ status: payments.status })
        .from(payments)
        .where(eq(payments.id, seeded.paymentId));
      const [order] = await instanceB.client
        .select({
          status: orders.status,
          paymentState: orders.paymentState,
        })
        .from(orders)
        .where(eq(orders.id, seeded.orderId));
      const [reservation] = await instanceB.client
        .select({ status: inventoryReservations.status })
        .from(inventoryReservations)
        .where(eq(inventoryReservations.orderId, seeded.orderId));
      const events = await instanceB.client
        .select({ id: paymentEvents.id })
        .from(paymentEvents)
        .where(eq(paymentEvents.paymentId, seeded.paymentId));
      const commands = await instanceB.client
        .select({ id: vendingCommands.id })
        .from(vendingCommands)
        .where(eq(vendingCommands.orderId, seeded.orderId));

      expect(provider.chargePaymentCode).toHaveBeenCalledTimes(1);
      expect(provider.queryPaymentCode).toHaveBeenCalledTimes(2);
      expect(attempt).toEqual({ status: "succeeded", isActive: false });
      expect(payment.status).toBe("succeeded");
      expect(order).toEqual({ status: "paid", paymentState: "paid" });
      expect(reservation.status).toBe("active");
      expect(events).toHaveLength(1);
      expect(commands).toHaveLength(1);
    });

    it("fences a slow provider query after lease expiry so only the replacement worker applies success", async () => {
      const instanceA = new DrizzleDB(databaseUrl);
      const instanceB = new DrizzleDB(databaseUrl);
      databases.push(instanceA, instanceB);
      await Promise.all([instanceA.connect(), instanceB.connect()]);
      const seeded = await seedPayablePaymentCodeOrder(instanceA);
      const created = await createDurableAttempt(
        instanceA,
        seeded,
        `slow-query-fence:${seeded.paymentId}`,
      );
      const firstQueryStarted = deferred<void>();
      const releaseFirstQuery = deferred<{
        status: "succeeded";
        providerTradeNo: string;
        providerStatus: string;
        rawPayload: Record<string, string>;
      }>();
      const success = {
        status: "succeeded" as const,
        providerTradeNo: "MOCK-SLOW-QUERY",
        providerStatus: "TRADE_SUCCESS",
        rawPayload: { trade_status: "TRADE_SUCCESS" },
      };
      let queryCalls = 0;
      const provider = {
        chargePaymentCode: vi.fn().mockResolvedValue({
          status: "processing",
          providerTradeNo: success.providerTradeNo,
          providerStatus: "WAIT_BUYER_PAY",
          rawPayload: { trade_status: "WAIT_BUYER_PAY" },
        }),
        queryPaymentCode: vi.fn(async () => {
          queryCalls += 1;
          if (queryCalls === 1) {
            firstQueryStarted.resolve();
            return await releaseFirstQuery.promise;
          }
          return success;
        }),
        reversePaymentCode: vi.fn(),
      };
      const workerA = makeDurableWorker(instanceA, provider);
      const workerB = makeDurableWorker(instanceB, provider);

      await workerA.submitAttempt({
        attemptId: created.attempt.id,
        authCode: "28763443825664394",
        clientIp: null,
      });
      await makeAttemptRecoverableNow(instanceA, created.attempt.id);
      const slowRecovery = workerA.reconcileDueAttempts();
      await firstQueryStarted.promise;

      await makeAttemptRecoverableNow(instanceA, created.attempt.id);
      await expect(workerB.reconcileDueAttempts()).resolves.toEqual({
        claimed: 1,
      });
      releaseFirstQuery.resolve(success);
      await expect(slowRecovery).resolves.toEqual({ claimed: 1 });

      const [attempt] = await instanceA.client
        .select({
          status: paymentCodeAttempts.status,
          isActive: paymentCodeAttempts.isActive,
        })
        .from(paymentCodeAttempts)
        .where(eq(paymentCodeAttempts.id, created.attempt.id));
      const [payment] = await instanceA.client
        .select({ status: payments.status })
        .from(payments)
        .where(eq(payments.id, seeded.paymentId));
      const [order] = await instanceA.client
        .select({ status: orders.status, paymentState: orders.paymentState })
        .from(orders)
        .where(eq(orders.id, seeded.orderId));
      const events = await instanceA.client
        .select({ id: paymentEvents.id })
        .from(paymentEvents)
        .where(eq(paymentEvents.paymentId, seeded.paymentId));
      const commands = await instanceA.client
        .select({ id: vendingCommands.id })
        .from(vendingCommands)
        .where(eq(vendingCommands.orderId, seeded.orderId));

      expect(provider.chargePaymentCode).toHaveBeenCalledTimes(1);
      expect(provider.queryPaymentCode).toHaveBeenCalledTimes(2);
      expect(provider.queryPaymentCode).toHaveBeenCalledWith(
        expect.objectContaining({
          paymentNo: created.attempt.providerPaymentNo,
        }),
      );
      expect(attempt).toEqual({ status: "succeeded", isActive: false });
      expect(payment.status).toBe("succeeded");
      expect(order).toEqual({ status: "paid", paymentState: "paid" });
      expect(events).toHaveLength(1);
      expect(commands).toHaveLength(1);
    });

    it.each([
      ["returns false", false],
      ["throws", new Error("renewal database unavailable")],
    ])(
      "does not call the provider when the required lease renewal %s",
      async (_description, renewalResult) => {
        const instance = new DrizzleDB(databaseUrl);
        databases.push(instance);
        await instance.connect();
        const seeded = await seedPayablePaymentCodeOrder(instance);
        const created = await createDurableAttempt(
          instance,
          seeded,
          `lease-renewal-rejected:${seeded.paymentId}`,
        );
        const provider = {
          chargePaymentCode: vi.fn(),
          queryPaymentCode: vi.fn(),
          reversePaymentCode: vi.fn(),
        };
        const worker = makeDurableWorker(instance, provider);
        const attempts = (
          worker as unknown as { attempts: PaymentCodeAttemptsService }
        ).attempts;
        const renewal = vi.spyOn(attempts, "renewRecoveryClaim");
        if (renewalResult instanceof Error) {
          renewal.mockRejectedValue(renewalResult);
        } else {
          renewal.mockResolvedValue(renewalResult);
        }

        await expect(
          worker.submitAttempt({
            attemptId: created.attempt.id,
            authCode: "28763443825664394",
            clientIp: null,
          }),
        ).resolves.toBeDefined();

        expect(provider.chargePaymentCode).not.toHaveBeenCalled();
        expect(provider.queryPaymentCode).not.toHaveBeenCalled();
        expect(provider.reversePaymentCode).not.toHaveBeenCalled();
      },
    );

    it.each([
      ["returns false", false],
      ["throws", new Error("heartbeat database unavailable")],
    ])(
      "stops a stale worker when an in-flight lease heartbeat %s and recovers one accepted charge",
      async (_description, heartbeatResult) => {
        const instanceA = new DrizzleDB(databaseUrl);
        const instanceB = new DrizzleDB(databaseUrl);
        databases.push(instanceA, instanceB);
        await Promise.all([instanceA.connect(), instanceB.connect()]);
        const seeded = await seedPayablePaymentCodeOrder(instanceA);
        const created = await createDurableAttempt(
          instanceA,
          seeded,
          `lease-heartbeat-lost:${seeded.paymentId}`,
        );
        const chargeStarted = deferred<void>();
        const releaseCharge = deferred<{
          status: "succeeded";
          providerTradeNo: string;
          providerStatus: string;
          rawPayload: Record<string, string>;
        }>();
        const acceptedChargeKeys = new Set<string>();
        let effectiveCharges = 0;
        const success = {
          status: "succeeded" as const,
          providerTradeNo: `MOCK-${created.attempt.providerPaymentNo}`,
          providerStatus: "TRADE_SUCCESS",
          rawPayload: { trade_status: "TRADE_SUCCESS" },
        };
        const provider = {
          chargePaymentCode: vi.fn(
            async (input: { idempotencyKey?: string }) => {
              const operationKey = input.idempotencyKey;
              if (!operationKey)
                throw new Error("missing charge operation key");
              if (!acceptedChargeKeys.has(operationKey)) {
                acceptedChargeKeys.add(operationKey);
                effectiveCharges += 1;
              }
              chargeStarted.resolve();
              return await releaseCharge.promise;
            },
          ),
          queryPaymentCode: vi.fn().mockResolvedValue(success),
          reversePaymentCode: vi.fn(),
        };
        const workerA = makeDurableWorker(
          instanceA,
          provider,
          {},
          { recoveryLeaseMs: 90, providerCallTimeoutMs: 1_500 },
        );
        const attempts = (
          workerA as unknown as { attempts: PaymentCodeAttemptsService }
        ).attempts;
        const renewal = vi
          .spyOn(attempts, "renewRecoveryClaim")
          .mockResolvedValueOnce(true);
        if (heartbeatResult instanceof Error) {
          renewal.mockRejectedValueOnce(heartbeatResult);
        } else {
          renewal.mockResolvedValueOnce(heartbeatResult);
        }

        const staleSubmission = workerA.submitAttempt({
          attemptId: created.attempt.id,
          authCode: "28763443825664394",
          clientIp: null,
        });
        await chargeStarted.promise;
        await expect(staleSubmission).resolves.toMatchObject({
          status: "querying",
          isActive: true,
        });

        await makeAttemptRecoverableNow(instanceA, created.attempt.id);
        await expect(
          makeDurableWorker(instanceB, provider).reconcileDueAttempts(),
        ).resolves.toEqual({ claimed: 1 });
        releaseCharge.resolve(success);

        expect(provider.chargePaymentCode).toHaveBeenCalledTimes(1);
        expect(effectiveCharges).toBe(1);
        expect(acceptedChargeKeys).toEqual(
          new Set([created.attempt.providerPaymentNo]),
        );
        const [state] = await instanceB.client
          .select({
            attemptStatus: paymentCodeAttempts.status,
            attemptActive: paymentCodeAttempts.isActive,
            paymentStatus: payments.status,
            orderStatus: orders.status,
          })
          .from(paymentCodeAttempts)
          .innerJoin(payments, eq(payments.id, paymentCodeAttempts.paymentId))
          .innerJoin(orders, eq(orders.id, paymentCodeAttempts.orderId))
          .where(eq(paymentCodeAttempts.id, created.attempt.id));
        expect(state).toEqual({
          attemptStatus: "succeeded",
          attemptActive: false,
          paymentStatus: "succeeded",
          orderStatus: "paid",
        });
      },
    );

    it("renews a bounded slow query lease so a competing worker cannot take it", async () => {
      const instanceA = new DrizzleDB(databaseUrl);
      const instanceB = new DrizzleDB(databaseUrl);
      databases.push(instanceA, instanceB);
      await Promise.all([instanceA.connect(), instanceB.connect()]);
      const seeded = await seedPayablePaymentCodeOrder(instanceA);
      const created = await createDurableAttempt(
        instanceA,
        seeded,
        `slow-query-renew:${seeded.paymentId}`,
      );
      const queryStarted = deferred<void>();
      const releaseQuery = deferred<{
        status: "succeeded";
        providerTradeNo: string;
        providerStatus: string;
        rawPayload: Record<string, string>;
      }>();
      const provider = {
        chargePaymentCode: vi.fn().mockResolvedValue({
          status: "processing",
          providerTradeNo: "MOCK-RENEW-QUERY",
          providerStatus: "WAIT_BUYER_PAY",
          rawPayload: { trade_status: "WAIT_BUYER_PAY" },
        }),
        queryPaymentCode: vi.fn(async () => {
          queryStarted.resolve();
          return await releaseQuery.promise;
        }),
        reversePaymentCode: vi.fn(),
      };
      const workerA = makeDurableWorker(
        instanceA,
        provider,
        {},
        { recoveryLeaseMs: 120, providerCallTimeoutMs: 1_500 },
      );
      const workerB = makeDurableWorker(instanceB, provider);

      await workerA.submitAttempt({
        attemptId: created.attempt.id,
        authCode: "28763443825664394",
        clientIp: null,
      });
      await makeAttemptRecoverableNow(instanceA, created.attempt.id);
      const recovery = workerA.reconcileDueAttempts();
      await queryStarted.promise;
      await new Promise<void>((resolve) => setTimeout(resolve, 250));

      await expect(workerB.reconcileDueAttempts()).resolves.toEqual({
        claimed: 0,
      });
      releaseQuery.resolve({
        status: "succeeded",
        providerTradeNo: "MOCK-RENEW-QUERY",
        providerStatus: "TRADE_SUCCESS",
        rawPayload: { trade_status: "TRADE_SUCCESS" },
      });
      await expect(recovery).resolves.toEqual({ claimed: 1 });

      expect(provider.queryPaymentCode).toHaveBeenCalledTimes(1);
      const [attempt] = await instanceA.client
        .select({
          status: paymentCodeAttempts.status,
          isActive: paymentCodeAttempts.isActive,
        })
        .from(paymentCodeAttempts)
        .where(eq(paymentCodeAttempts.id, created.attempt.id));
      expect(attempt).toEqual({ status: "succeeded", isActive: false });
    });

    it("fences a slow reversal after lease expiry and keeps duplicate reversals idempotent", async () => {
      const instanceA = new DrizzleDB(databaseUrl);
      const instanceB = new DrizzleDB(databaseUrl);
      databases.push(instanceA, instanceB);
      await Promise.all([instanceA.connect(), instanceB.connect()]);
      const seeded = await seedPayablePaymentCodeOrder(instanceA);
      const created = await createDurableAttempt(
        instanceA,
        seeded,
        `slow-reverse-fence:${seeded.paymentId}`,
      );
      const firstReverseStarted = deferred<void>();
      const releaseFirstReverse = deferred<{
        status: "reversed";
        providerStatus: string;
        rawPayload: Record<string, string>;
      }>();
      const reversed = {
        status: "reversed" as const,
        providerStatus: "TRADE_CLOSED",
        rawPayload: { action: "reverse" },
      };
      let reverseCalls = 0;
      let effectiveReversals = 0;
      const admittedReversalKeys = new Set<string>();
      const provider = {
        chargePaymentCode: vi.fn().mockResolvedValue({
          status: "processing",
          providerTradeNo: "MOCK-SLOW-REVERSE",
          providerStatus: "WAIT_BUYER_PAY",
          rawPayload: { trade_status: "WAIT_BUYER_PAY" },
        }),
        queryPaymentCode: vi.fn().mockResolvedValue({
          status: "processing",
          providerTradeNo: "MOCK-SLOW-REVERSE",
          providerStatus: "WAIT_BUYER_PAY",
          rawPayload: { trade_status: "WAIT_BUYER_PAY" },
        }),
        reversePaymentCode: vi.fn(
          async (input: { idempotencyKey?: string }) => {
            const operationKey = input.idempotencyKey;
            if (!operationKey)
              throw new Error("missing reversal operation key");
            if (!admittedReversalKeys.has(operationKey)) {
              admittedReversalKeys.add(operationKey);
              effectiveReversals += 1;
            }
            reverseCalls += 1;
            if (reverseCalls === 1) {
              firstReverseStarted.resolve();
              return await releaseFirstReverse.promise;
            }
            return reversed;
          },
        ),
      };
      const workerA = makeDurableWorker(instanceA, provider);
      const workerB = makeDurableWorker(instanceB, provider);

      await workerA.submitAttempt({
        attemptId: created.attempt.id,
        authCode: "28763443825664394",
        clientIp: null,
      });
      await instanceA.client
        .update(payments)
        .set({ expiresAt: new Date(Date.now() - 1), updatedAt: new Date() })
        .where(eq(payments.id, seeded.paymentId));
      await makeAttemptRecoverableNow(instanceA, created.attempt.id);

      const slowRecovery = workerA.reconcileDueAttempts();
      await firstReverseStarted.promise;
      await makeAttemptRecoverableNow(instanceA, created.attempt.id);
      await expect(workerB.reconcileDueAttempts()).resolves.toEqual({
        claimed: 1,
      });
      releaseFirstReverse.resolve(reversed);
      await expect(slowRecovery).resolves.toEqual({ claimed: 1 });

      const [attempt] = await instanceA.client
        .select({
          status: paymentCodeAttempts.status,
          isActive: paymentCodeAttempts.isActive,
        })
        .from(paymentCodeAttempts)
        .where(eq(paymentCodeAttempts.id, created.attempt.id));
      const [payment] = await instanceA.client
        .select({ status: payments.status })
        .from(payments)
        .where(eq(payments.id, seeded.paymentId));
      const [order] = await instanceA.client
        .select({
          status: orders.status,
          paymentState: orders.paymentState,
          fulfillmentState: orders.fulfillmentState,
        })
        .from(orders)
        .where(eq(orders.id, seeded.orderId));
      const [reservation] = await instanceA.client
        .select({ status: inventoryReservations.status })
        .from(inventoryReservations)
        .where(eq(inventoryReservations.orderId, seeded.orderId));
      const [inventory] = await instanceA.client
        .select({ reservedQty: inventories.reservedQty })
        .from(inventories)
        .where(eq(inventories.id, seeded.inventoryId));
      const events = await instanceA.client
        .select({ id: paymentEvents.id })
        .from(paymentEvents)
        .where(eq(paymentEvents.paymentId, seeded.paymentId));

      expect(provider.queryPaymentCode).toHaveBeenCalledTimes(2);
      expect(provider.reversePaymentCode).toHaveBeenCalledTimes(2);
      expect(effectiveReversals).toBe(1);
      expect(admittedReversalKeys).toEqual(
        new Set([created.attempt.providerPaymentNo]),
      );
      expect(provider.reversePaymentCode).toHaveBeenCalledWith(
        expect.objectContaining({
          paymentNo: created.attempt.providerPaymentNo,
          idempotencyKey: created.attempt.providerPaymentNo,
        }),
      );
      expect(attempt).toEqual({ status: "reversed", isActive: false });
      expect(payment.status).toBe("failed");
      expect(order).toEqual({
        status: "canceled",
        paymentState: "payment_failed",
        fulfillmentState: "canceled",
      });
      expect(reservation.status).toBe("released");
      expect(inventory.reservedQty).toBe(0);
      expect(events).toHaveLength(1);
    });

    it("keeps the original payment and reservation live when reversal is rejected", async () => {
      const instance = new DrizzleDB(databaseUrl);
      databases.push(instance);
      await instance.connect();
      const seeded = await seedPayablePaymentCodeOrder(instance);
      const created = await createDurableAttempt(
        instance,
        seeded,
        `reverse-failure:${seeded.paymentId}`,
      );
      const provider = {
        chargePaymentCode: vi.fn().mockResolvedValue({
          status: "processing",
          providerTradeNo: "MOCK-REVERSE-FAILED",
          providerStatus: "WAIT_BUYER_PAY",
          rawPayload: { trade_status: "WAIT_BUYER_PAY" },
        }),
        queryPaymentCode: vi.fn().mockResolvedValue({
          status: "processing",
          providerTradeNo: "MOCK-REVERSE-FAILED",
          providerStatus: "WAIT_BUYER_PAY",
          rawPayload: { trade_status: "WAIT_BUYER_PAY" },
        }),
        reversePaymentCode: vi.fn().mockResolvedValue({
          status: "failed",
          providerStatus: "SYSTEM_ERROR",
          failureCode: "SYSTEM_ERROR",
          failureMessage: "支付机构未确认撤销",
          rawPayload: { code: "SYSTEM_ERROR" },
        }),
      };
      const worker = makeDurableWorker(instance, provider);

      await worker.submitAttempt({
        attemptId: created.attempt.id,
        authCode: "28763443825664394",
        clientIp: null,
      });
      await instance.client
        .update(payments)
        .set({ expiresAt: new Date(Date.now() - 1), updatedAt: new Date() })
        .where(eq(payments.id, seeded.paymentId));
      await makeAttemptRecoverableNow(instance, created.attempt.id);
      await expect(worker.reconcileDueAttempts()).resolves.toEqual({
        claimed: 1,
      });

      const [attempt] = await instance.client
        .select({
          status: paymentCodeAttempts.status,
          isActive: paymentCodeAttempts.isActive,
          recoveryNextAt: paymentCodeAttempts.recoveryNextAt,
        })
        .from(paymentCodeAttempts)
        .where(eq(paymentCodeAttempts.id, created.attempt.id));
      const [payment] = await instance.client
        .select({ status: payments.status })
        .from(payments)
        .where(eq(payments.id, seeded.paymentId));
      const [order] = await instance.client
        .select({
          status: orders.status,
          paymentState: orders.paymentState,
          fulfillmentState: orders.fulfillmentState,
        })
        .from(orders)
        .where(eq(orders.id, seeded.orderId));
      const [reservation] = await instance.client
        .select({ status: inventoryReservations.status })
        .from(inventoryReservations)
        .where(eq(inventoryReservations.orderId, seeded.orderId));
      const [inventory] = await instance.client
        .select({ reservedQty: inventories.reservedQty })
        .from(inventories)
        .where(eq(inventories.id, seeded.inventoryId));

      expect(provider.reversePaymentCode).toHaveBeenCalledWith(
        expect.objectContaining({
          paymentNo: created.attempt.providerPaymentNo,
          idempotencyKey: created.attempt.providerPaymentNo,
        }),
      );
      expect(attempt).toMatchObject({ status: "querying", isActive: true });
      expect(attempt.recoveryNextAt).toBeInstanceOf(Date);
      expect(payment.status).toBe("pending");
      expect(order).toEqual({
        status: "pending_payment",
        paymentState: "awaiting_payment",
        fulfillmentState: "awaiting_fulfillment",
      });
      expect(reservation.status).toBe("active");
      expect(inventory.reservedQty).toBe(1);
    });

    it("atomically applies a queued payment-code manual-handling intent", async () => {
      const instance = new DrizzleDB(databaseUrl);
      databases.push(instance);
      await instance.connect();
      const seeded = await seedPayablePaymentCodeOrder(instance);
      const created = await createDurableAttempt(
        instance,
        seeded,
        `manual-intent:${seeded.paymentId}`,
      );
      const attempts = new PaymentCodeAttemptsService(instance.client);

      await attempts.requestManualHandlingForPayment({
        paymentId: seeded.paymentId,
        reason: "operator requires manual verification",
      });
      const worker = makeDurableWorker(instance, {});
      await expect(worker.reconcileDueAttempts()).resolves.toEqual({
        claimed: 1,
      });

      const [attempt] = await instance.client
        .select({
          status: paymentCodeAttempts.status,
          isActive: paymentCodeAttempts.isActive,
          recoveryNextAt: paymentCodeAttempts.recoveryNextAt,
          manualReason: paymentCodeAttempts.manualReason,
        })
        .from(paymentCodeAttempts)
        .where(eq(paymentCodeAttempts.id, created.attempt.id));
      const [payment] = await instance.client
        .select({ status: payments.status })
        .from(payments)
        .where(eq(payments.id, seeded.paymentId));
      const [order] = await instance.client
        .select({
          status: orders.status,
          paymentState: orders.paymentState,
          fulfillmentState: orders.fulfillmentState,
        })
        .from(orders)
        .where(eq(orders.id, seeded.orderId));
      const [reservation] = await instance.client
        .select({ status: inventoryReservations.status })
        .from(inventoryReservations)
        .where(eq(inventoryReservations.orderId, seeded.orderId));
      const [inventory] = await instance.client
        .select({ reservedQty: inventories.reservedQty })
        .from(inventories)
        .where(eq(inventories.id, seeded.inventoryId));

      expect(attempt).toEqual({
        status: "manual_handling",
        isActive: true,
        recoveryNextAt: null,
        manualReason: "operator requires manual verification",
      });
      expect(payment.status).toBe("unknown");
      expect(order).toEqual({
        status: "manual_handling",
        paymentState: "payment_unknown",
        fulfillmentState: "manual_handling",
      });
      expect(reservation.status).toBe("active");
      expect(inventory.reservedQty).toBe(1);
      await expect(worker.reconcileDueAttempts()).resolves.toEqual({
        claimed: 0,
      });
    });

    it("recovers a crash after reverse acceptance by querying before release", async () => {
      const instanceA = new DrizzleDB(databaseUrl);
      databases.push(instanceA);
      await instanceA.connect();
      const seeded = await seedPayablePaymentCodeOrder(instanceA);
      const created = await createDurableAttempt(
        instanceA,
        seeded,
        `reverse-response-kill:${seeded.paymentId}`,
      );
      let queryCalls = 0;
      const provider = {
        chargePaymentCode: vi.fn().mockResolvedValue({
          status: "processing",
          providerTradeNo: "MOCK-REVERSE-KILL",
          providerStatus: "WAIT_BUYER_PAY",
          rawPayload: { trade_status: "WAIT_BUYER_PAY" },
        }),
        queryPaymentCode: vi.fn(async () => {
          queryCalls += 1;
          return queryCalls === 1
            ? {
                status: "processing" as const,
                providerTradeNo: "MOCK-REVERSE-KILL",
                providerStatus: "WAIT_BUYER_PAY",
                rawPayload: { trade_status: "WAIT_BUYER_PAY" },
              }
            : {
                status: "reversed" as const,
                providerTradeNo: "MOCK-REVERSE-KILL",
                providerStatus: "TRADE_CLOSED",
                rawPayload: { trade_status: "TRADE_CLOSED" },
              };
        }),
        reversePaymentCode: vi.fn().mockResolvedValue({
          status: "reversed",
          providerStatus: "TRADE_CLOSED",
          rawPayload: { action: "reverse" },
        }),
      };
      const workerA = makeDurableWorker(instanceA, provider, {
        afterProviderResponse: async ({ operation }) => {
          if (operation === "reverse") {
            throw new Error("injected after reverse response");
          }
        },
      });

      await workerA.submitAttempt({
        attemptId: created.attempt.id,
        authCode: "28763443825664394",
        clientIp: null,
      });
      await instanceA.client
        .update(payments)
        .set({ expiresAt: new Date(Date.now() - 1), updatedAt: new Date() })
        .where(eq(payments.id, seeded.paymentId));
      await makeAttemptRecoverableNow(instanceA, created.attempt.id);

      await expect(workerA.reconcileDueAttempts()).rejects.toThrow(
        "injected after reverse response",
      );
      const [afterCrashAttempt] = await instanceA.client
        .select({
          status: paymentCodeAttempts.status,
          isActive: paymentCodeAttempts.isActive,
        })
        .from(paymentCodeAttempts)
        .where(eq(paymentCodeAttempts.id, created.attempt.id));
      const [afterCrashPayment] = await instanceA.client
        .select({ status: payments.status })
        .from(payments)
        .where(eq(payments.id, seeded.paymentId));
      const [afterCrashReservation] = await instanceA.client
        .select({ status: inventoryReservations.status })
        .from(inventoryReservations)
        .where(eq(inventoryReservations.orderId, seeded.orderId));
      expect(afterCrashAttempt).toEqual({
        status: "reversing",
        isActive: true,
      });
      expect(afterCrashPayment.status).toBe("pending");
      expect(afterCrashReservation.status).toBe("active");

      await instanceA.disconnect();
      databases.pop();
      const instanceB = new DrizzleDB(databaseUrl);
      databases.push(instanceB);
      await instanceB.connect();
      await makeAttemptRecoverableNow(instanceB, created.attempt.id);
      await expect(
        makeDurableWorker(instanceB, provider).reconcileDueAttempts(),
      ).resolves.toEqual({ claimed: 1 });

      const [attempt] = await instanceB.client
        .select({
          status: paymentCodeAttempts.status,
          isActive: paymentCodeAttempts.isActive,
        })
        .from(paymentCodeAttempts)
        .where(eq(paymentCodeAttempts.id, created.attempt.id));
      const [payment] = await instanceB.client
        .select({ status: payments.status })
        .from(payments)
        .where(eq(payments.id, seeded.paymentId));
      const [reservation] = await instanceB.client
        .select({ status: inventoryReservations.status })
        .from(inventoryReservations)
        .where(eq(inventoryReservations.orderId, seeded.orderId));
      const [inventory] = await instanceB.client
        .select({ reservedQty: inventories.reservedQty })
        .from(inventories)
        .where(eq(inventories.id, seeded.inventoryId));

      expect(provider.reversePaymentCode).toHaveBeenCalledTimes(1);
      expect(provider.queryPaymentCode).toHaveBeenCalledTimes(2);
      expect(attempt).toEqual({ status: "reversed", isActive: false });
      expect(payment.status).toBe("failed");
      expect(reservation.status).toBe("released");
      expect(inventory.reservedQty).toBe(0);
    });
  },
);
