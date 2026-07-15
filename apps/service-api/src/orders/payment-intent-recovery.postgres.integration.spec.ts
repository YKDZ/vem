import {
  DrizzleDB,
  eq,
  machines,
  orders,
  paymentReconciliationAttempts,
  paymentProviders,
  payments,
} from "@vem/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PaymentsService } from "../payments/payments.service";
import { claimReconciledPaymentForIntentCreation } from "./orders.service";
import { OrdersService } from "./orders.service";

const databaseUrl = process.env.VEM_TEST_POSTGRES_URL;
const postgresDescribe = databaseUrl ? describe : describe.skip;

postgresDescribe("payment intent recovery PostgreSQL CAS", () => {
  let database: DrizzleDB;

  beforeAll(async () => {
    database = new DrizzleDB(databaseUrl);
    await database.connect();
  });

  afterAll(async () => {
    await database?.disconnect();
  });

  async function seedPayment(input: { suffix: string; failedReason: string }) {
    const machineId = `550e8400-e29b-41d4-a716-44665544${input.suffix}01`;
    const providerId = `550e8400-e29b-41d4-a716-44665544${input.suffix}02`;
    const orderId = `550e8400-e29b-41d4-a716-44665544${input.suffix}03`;
    const paymentId = `550e8400-e29b-41d4-a716-44665544${input.suffix}04`;

    await database.client
      .update(orders)
      .set({ paymentId: null })
      .where(eq(orders.id, orderId));
    await database.client
      .delete(paymentReconciliationAttempts)
      .where(eq(paymentReconciliationAttempts.paymentId, paymentId));
    await database.client.delete(payments).where(eq(payments.id, paymentId));
    await database.client.delete(orders).where(eq(orders.id, orderId));
    await database.client
      .delete(paymentProviders)
      .where(eq(paymentProviders.id, providerId));
    await database.client.delete(machines).where(eq(machines.id, machineId));

    await database.client.insert(machines).values({
      id: machineId,
      code: `PG-PAYMENT-RECOVERY-${input.suffix}`,
      name: "Payment recovery CAS",
      status: "online",
    });
    await database.client.insert(paymentProviders).values({
      id: providerId,
      code: `alipay-pg-recovery-${input.suffix}`,
      name: "Alipay recovery test",
      type: "alipay",
      capabilities: {},
    });
    await database.client.insert(orders).values({
      id: orderId,
      orderNo: `ORD-PG-RECOVERY-${input.suffix}`,
      machineId,
      totalAmountCents: 100,
      paymentCreationIdempotencyKey: `checkout-${input.suffix}`,
    });
    await database.client.insert(payments).values({
      id: paymentId,
      paymentNo: `PAY-PG-RECOVERY-${input.suffix}`,
      orderId,
      providerId,
      method: "qr_code",
      status: "pending",
      amountCents: 100,
      failedReason: input.failedReason,
    });
    await database.client
      .update(orders)
      .set({ paymentId })
      .where(eq(orders.id, orderId));
    return {
      paymentId,
      machineCode: `PG-PAYMENT-RECOVERY-${input.suffix}`,
      idempotencyKey: `checkout-${input.suffix}`,
    };
  }

  function makeOrdersService(
    provider: {
      createPaymentIntent(input: unknown): Promise<{
        providerTradeNo: string | null;
        paymentUrl: string;
        initialStatus: "pending";
      }>;
      queryPayment?(input: unknown): Promise<unknown>;
    },
    paymentsService?: PaymentsService,
  ) {
    return new OrdersService(
      database.client,
      {} as never,
      { get: () => provider } as never,
      {
        resolveForExistingPayment: async () => ({
          providerCode: "alipay",
          merchantNo: "seller-pg",
          appId: "app-pg",
          publicConfigJson: {},
          sensitiveConfigJson: {},
        }),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      paymentsService,
    );
  }

  function makePaymentsService(provider: {
    createPaymentIntent(input: unknown): Promise<unknown>;
    queryPayment(input: unknown): Promise<unknown>;
  }) {
    const registry = {
      has: () => true,
      get: () => provider,
    };
    const configService = {
      resolveForExistingPayment: async () => ({
        providerCode: "alipay",
        merchantNo: "seller-pg",
        appId: "app-pg",
        publicConfigJson: {},
        sensitiveConfigJson: {},
      }),
    };
    return new PaymentsService(
      database.client,
      {} as never,
      {} as never,
      {} as never,
      registry as never,
      {} as never,
      {} as never,
      configService as never,
      {} as never,
      {} as never,
    );
  }

  it("allows exactly one TRADE_NOT_EXIST recovery owner to re-enter processing", async () => {
    const { paymentId } = await seedPayment({
      suffix: "91",
      failedReason: "provider_trade_not_exist",
    });

    const results = await Promise.all([
      claimReconciledPaymentForIntentCreation(database.client, paymentId),
      claimReconciledPaymentForIntentCreation(database.client, paymentId),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);

    const [row] = await database.client
      .select({ status: payments.status, failedReason: payments.failedReason })
      .from(payments)
      .where(eq(payments.id, paymentId));
    expect(row).toEqual({
      status: "processing",
      failedReason: "provider_trade_retry_claimed",
    });
  });

  it("never treats WAIT_BUYER_PAY as permission to precreate", async () => {
    const { paymentId } = await seedPayment({
      suffix: "92",
      failedReason: "wait_buyer_pay",
    });

    await expect(
      claimReconciledPaymentForIntentCreation(database.client, paymentId),
    ).resolves.toBe(false);

    const [row] = await database.client
      .select({ status: payments.status, failedReason: payments.failedReason })
      .from(payments)
      .where(eq(payments.id, paymentId));
    expect(row).toEqual({
      status: "pending",
      failedReason: "wait_buyer_pay",
    });
  });

  it("re-enters processing and precreates exactly once through the public order API", async () => {
    const seeded = await seedPayment({
      suffix: "93",
      failedReason: "provider_trade_not_exist",
    });
    let precreateCount = 0;
    const provider = {
      async createPaymentIntent() {
        precreateCount += 1;
        return {
          providerTradeNo: null,
          paymentUrl: "https://qr.alipay.test/recovered",
          initialStatus: "pending" as const,
        };
      },
    };
    const firstProcess = makeOrdersService(provider);
    const secondProcess = makeOrdersService(provider);
    const input = {
      machineCode: seeded.machineCode,
      idempotencyKey: seeded.idempotencyKey,
      paymentMethod: "qr_code",
      paymentProviderCode: "alipay",
      items: [],
    };

    const responses = await Promise.all([
      firstProcess.createMachineOrder(input as never),
      secondProcess.createMachineOrder(input as never),
    ]);

    expect(precreateCount).toBe(1);
    expect(
      responses.filter(
        (response) =>
          response.paymentUrl === "https://qr.alipay.test/recovered",
      ),
    ).toHaveLength(1);
    const [payment] = await database.client
      .select({ status: payments.status, paymentUrl: payments.paymentUrl })
      .from(payments)
      .where(eq(payments.id, seeded.paymentId));
    expect(payment).toEqual({
      status: "pending",
      paymentUrl: "https://qr.alipay.test/recovered",
    });
  });

  it("does not precreate WAIT_BUYER_PAY through the public order API", async () => {
    const seeded = await seedPayment({
      suffix: "94",
      failedReason: "wait_buyer_pay",
    });
    let precreateCount = 0;
    const service = makeOrdersService({
      async createPaymentIntent() {
        precreateCount += 1;
        return {
          providerTradeNo: null,
          paymentUrl: "https://qr.alipay.test/must-not-exist",
          initialStatus: "pending",
        };
      },
    });

    const response = await service.createMachineOrder({
      machineCode: seeded.machineCode,
      idempotencyKey: seeded.idempotencyKey,
      paymentMethod: "qr_code",
      paymentProviderCode: "alipay",
      items: [],
    } as never);

    expect(precreateCount).toBe(0);
    expect(response.paymentUrl).toBeNull();
  });

  it("does not let a read-side reconciliation steal a slow active precreate lease", async () => {
    const seeded = await seedPayment({
      suffix: "95",
      failedReason: "provider_trade_not_exist",
    });
    let precreateCount = 0;
    let queryCount = 0;
    let signalFirstPrecreateStarted: (() => void) | undefined;
    const firstPrecreateStarted = new Promise<void>((resolve) => {
      signalFirstPrecreateStarted = resolve;
    });
    const provider = {
      async createPaymentIntent() {
        precreateCount += 1;
        if (precreateCount === 1) signalFirstPrecreateStarted?.();
        // Provider clients are capped at 20s; stay just inside that bound so
        // the 5s competing-read window overlaps a genuinely slow precreate.
        await new Promise((resolve) => setTimeout(resolve, 19_500));
        return {
          providerTradeNo: null,
          paymentUrl: "https://qr.alipay.test/slow-owner",
          initialStatus: "pending" as const,
        };
      },
      async queryPayment() {
        queryCount += 1;
        return {
          status: "pending" as const,
          failedReason: "ACQ.TRADE_NOT_EXIST",
          reconciliationState: "provider_trade_not_exist" as const,
        };
      },
    };
    const paymentsService = makePaymentsService(provider);
    const firstProcess = makeOrdersService(provider, paymentsService);
    const secondProcess = makeOrdersService(provider, paymentsService);
    const input = {
      machineCode: seeded.machineCode,
      idempotencyKey: seeded.idempotencyKey,
      paymentMethod: "qr_code",
      paymentProviderCode: "alipay",
      items: [],
    };

    const first = firstProcess.createMachineOrder(input as never);
    await firstPrecreateStarted;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    const second = secondProcess.createMachineOrder(input as never);
    const responses = await Promise.all([first, second]);

    expect(precreateCount).toBe(1);
    expect(queryCount).toBe(0);
    expect(
      responses.filter(
        (response) =>
          response.paymentUrl === "https://qr.alipay.test/slow-owner",
      ),
    ).toHaveLength(1);
  }, 35_000);

  it("allows only one read-side reconciliation owner after the creation lease is absent", async () => {
    const seeded = await seedPayment({
      suffix: "96",
      failedReason: "provider_create_uncertain",
    });
    await database.client
      .update(payments)
      .set({ status: "processing" })
      .where(eq(payments.id, seeded.paymentId));
    let queryCount = 0;
    let signalFirstQueryStarted: (() => void) | undefined;
    const firstQueryStarted = new Promise<void>((resolve) => {
      signalFirstQueryStarted = resolve;
    });
    const provider = {
      async createPaymentIntent() {
        throw new Error("not used");
      },
      async queryPayment() {
        queryCount += 1;
        if (queryCount === 1) signalFirstQueryStarted?.();
        await new Promise((resolve) => setTimeout(resolve, 7_000));
        return {
          status: "pending" as const,
          reconciliationState: "wait_buyer_pay" as const,
        };
      },
    };
    const readers = Array.from({ length: 2 }, () =>
      makePaymentsService(provider),
    );

    const first = readers[0].reconcilePendingPaymentOnRead(seeded.paymentId);
    await firstQueryStarted;
    // The normal 5s polling throttle has elapsed while the first provider
    // query is deliberately still in flight.
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    const second = readers[1].reconcilePendingPaymentOnRead(seeded.paymentId);
    await Promise.all([first, second]);

    expect(queryCount).toBe(1);
  }, 20_000);
});
