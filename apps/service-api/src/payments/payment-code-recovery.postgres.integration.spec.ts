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
  paymentProviders,
  payments,
  productVariants,
  products,
} from "@vem/db";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";

import { InventoryService } from "../inventory/inventory.service";
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

function makeRecoveryWorker(
  database: DrizzleDB,
  provider: {
    queryPaymentCode: ReturnType<typeof vi.fn>;
    reversePaymentCode: ReturnType<typeof vi.fn>;
  },
) {
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
  const paymentsService = new PaymentsService(
    database.client,
    inventoryService,
    {
      createPendingDispatchCommands: async () => undefined,
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
  );
}

postgresDescribe(
  "payment-code PostgreSQL recovery",
  { concurrent: false },
  () => {
    const databases: DrizzleDB[] = [];

    afterAll(async () => {
      await Promise.all(
        databases.map(async (database) => {
          await database.disconnect();
        }),
      );
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

    it("turns exhausted recovery into terminal manual handling without leaving inventory reserved", async () => {
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
        isActive: false,
        recoveryAttemptCount: 8,
        recoveryLeaseOwnerToken: null,
      });
      expect(payment.status).toBe("manual_handling");
      expect(order).toEqual({
        status: "manual_handling",
        paymentState: "manual_handling",
        fulfillmentState: "manual_handling",
      });
      expect(reservation.status).toBe("released");
      expect(inventory.reservedQty).toBe(0);
    });
  },
);
