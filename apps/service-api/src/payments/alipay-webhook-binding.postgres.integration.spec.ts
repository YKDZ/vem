import { UnauthorizedException } from "@nestjs/common";
import {
  DrizzleDB,
  eq,
  inArray,
  machines,
  orders,
  orderStatusEvents,
  paymentEvents,
  paymentProviderConfigs,
  paymentProviders,
  payments,
} from "@vem/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type {
  AlipaySdkClientFactory,
  AlipaySdkLike,
} from "./alipay-sdk.client";
import type { RuntimePaymentProviderConfig } from "./payment-provider-config.service";

import { AlipayProvider } from "./alipay.provider";
import { PaymentConfigSecretService } from "./payment-config-secret.service";
import { PaymentProviderConfigService } from "./payment-provider-config.service";
import { PaymentsService } from "./payments.service";

const databaseUrl = process.env.VEM_TEST_POSTGRES_URL;
const postgresDescribe = databaseUrl ? describe : describe.skip;
const ENCRYPTION_KEY = "pg-alipay-binding-encryption-key";

postgresDescribe("Alipay immutable webhook binding PostgreSQL", () => {
  let database: DrizzleDB;

  beforeAll(async () => {
    database = new DrizzleDB(databaseUrl);
    await database.connect();
  });

  afterAll(async () => {
    await database?.disconnect();
  });

  it("accepts the old in-flight snapshot after same-row rotation and rejects it for a new payment", async () => {
    const machineId = "550e8400-e29b-41d4-a716-446655449701";
    const providerId = "550e8400-e29b-41d4-a716-446655449702";
    const configId = "550e8400-e29b-41d4-a716-446655449703";
    const oldOrderId = "550e8400-e29b-41d4-a716-446655449704";
    const oldPaymentId = "550e8400-e29b-41d4-a716-446655449705";
    const newOrderId = "550e8400-e29b-41d4-a716-446655449706";
    const newPaymentId = "550e8400-e29b-41d4-a716-446655449707";
    const paymentIds = [oldPaymentId, newPaymentId];
    const orderIds = [oldOrderId, newOrderId];

    await database.client
      .update(orders)
      .set({ paymentId: null })
      .where(inArray(orders.id, orderIds));
    await database.client
      .delete(paymentEvents)
      .where(inArray(paymentEvents.paymentId, paymentIds));
    await database.client
      .delete(orderStatusEvents)
      .where(inArray(orderStatusEvents.orderId, orderIds));
    await database.client
      .delete(payments)
      .where(inArray(payments.id, paymentIds));
    await database.client.delete(orders).where(inArray(orders.id, orderIds));
    await database.client
      .delete(paymentProviderConfigs)
      .where(eq(paymentProviderConfigs.id, configId));
    await database.client
      .delete(paymentProviders)
      .where(eq(paymentProviders.id, providerId));
    await database.client.delete(machines).where(eq(machines.id, machineId));

    const appConfig = {
      paymentConfigEncryptionKey: ENCRYPTION_KEY,
      paymentMockEnabled: false,
      buildPaymentNotifyUrl: () =>
        "https://pay.example.test/api/payments/webhooks/alipay",
    };
    const secrets = new PaymentConfigSecretService(appConfig as never);
    const configService = new PaymentProviderConfigService(
      database.client,
      secrets,
      appConfig as never,
    );
    const sharedPublicConfig = {
      gatewayUrl: "https://openapi.alipay.com/gateway.do",
      keyType: "PKCS8",
    };
    const oldSecrets = {
      privateKeyPem: "OLD PRIVATE KEY",
      appCertPem: "OLD APP CERT",
      alipayPublicCertPem: "OLD ALIPAY PUBLIC CERT",
      alipayRootCertPem: "OLD ROOT CERT",
    };
    const currentSecrets = {
      privateKeyPem: "CURRENT PRIVATE KEY",
      appCertPem: "CURRENT APP CERT",
      alipayPublicCertPem: "CURRENT ALIPAY PUBLIC CERT",
      alipayRootCertPem: "CURRENT ROOT CERT",
    };
    const runtimeConfig = (
      sensitiveConfigJson: Record<string, unknown>,
    ): RuntimePaymentProviderConfig => ({
      id: configId,
      providerId,
      providerCode: "alipay",
      machineId: null,
      merchantNo: "ALI-SELLER-SHARED",
      appId: "ALI-APP-SHARED",
      publicConfigJson: sharedPublicConfig,
      sensitiveConfigJson,
    });

    await database.client.insert(machines).values({
      id: machineId,
      code: "PG-ALIPAY-BINDING-97",
      name: "Alipay binding rotation",
      status: "online",
    });
    await database.client.insert(paymentProviders).values({
      id: providerId,
      code: "alipay",
      name: "Alipay",
      type: "alipay",
      capabilities: {},
    });
    await database.client.insert(paymentProviderConfigs).values({
      id: configId,
      providerId,
      machineId: null,
      merchantNo: "ALI-SELLER-SHARED",
      appId: "ALI-APP-SHARED",
      configEncryptedJson: secrets.encrypt(oldSecrets),
      publicConfigJson: sharedPublicConfig,
      status: "enabled",
    });
    const oldSnapshot = configService.createBindingSnapshot(
      runtimeConfig(oldSecrets),
      new Date("2026-07-01T00:00:00.000Z"),
    );
    await database.client.insert(orders).values({
      id: oldOrderId,
      orderNo: "ORD-PG-ALI-OLD",
      machineId,
      totalAmountCents: 100,
    });
    await database.client.insert(payments).values({
      id: oldPaymentId,
      paymentNo: "PAY-PG-ALI-OLD",
      orderId: oldOrderId,
      providerId,
      paymentProviderConfigId: configId,
      providerConfigSnapshotJson: oldSnapshot,
      method: "qr_code",
      status: "pending",
      amountCents: 100,
    });
    await database.client
      .update(orders)
      .set({ paymentId: oldPaymentId })
      .where(eq(orders.id, oldOrderId));

    await database.client
      .update(paymentProviderConfigs)
      .set({ configEncryptedJson: secrets.encrypt(currentSecrets) })
      .where(eq(paymentProviderConfigs.id, configId));
    const currentSnapshot = configService.createBindingSnapshot(
      runtimeConfig(currentSecrets),
      new Date("2026-07-02T00:00:00.000Z"),
    );
    await database.client.insert(orders).values({
      id: newOrderId,
      orderNo: "ORD-PG-ALI-NEW",
      machineId,
      totalAmountCents: 100,
    });
    await database.client.insert(payments).values({
      id: newPaymentId,
      paymentNo: "PAY-PG-ALI-NEW",
      orderId: newOrderId,
      providerId,
      paymentProviderConfigId: configId,
      providerConfigSnapshotJson: currentSnapshot,
      method: "qr_code",
      status: "pending",
      amountCents: 100,
    });
    await database.client
      .update(orders)
      .set({ paymentId: newPaymentId })
      .where(eq(orders.id, newOrderId));

    let oldVerifyCount = 0;
    let currentVerifyCount = 0;
    const sdk = (kind: "old" | "current"): AlipaySdkLike => ({
      curl: async () => {
        throw new Error("not used");
      },
      exec: async () => {
        throw new Error("not used");
      },
      checkNotifySignV2: () => {
        if (kind === "old") oldVerifyCount += 1;
        else currentVerifyCount += 1;
        return kind === "old";
      },
    });
    const factory = {
      create: (options: { privateKey: string }) =>
        sdk(options.privateKey.includes("OLD") ? "old" : "current"),
    } as AlipaySdkClientFactory;
    const provider = new AlipayProvider(factory);
    const registry = { get: () => provider, has: () => true };
    const service = new PaymentsService(
      database.client,
      {} as never,
      {
        createPendingDispatchCommands: async () => [],
        dispatchPendingCommandsForOrder: async () => [],
      } as never,
      appConfig as never,
      registry as never,
      {} as never,
      secrets,
      configService,
      {
        start: async () => "attempt-pg-binding",
        finish: async () => undefined,
      } as never,
      {} as never,
    );
    const webhookBody = (paymentNo: string) => ({
      notify_id: `notify-${paymentNo}`,
      app_id: "ALI-APP-SHARED",
      seller_id: "ALI-SELLER-SHARED",
      out_trade_no: paymentNo,
      trade_no: `trade-${paymentNo}`,
      total_amount: "1.00",
      trade_status: "TRADE_SUCCESS",
      sign_type: "RSA2",
      sign: "signed-with-old-binding",
    });

    await expect(
      service.handleProviderWebhook(
        "alipay",
        {},
        webhookBody("PAY-PG-ALI-OLD"),
      ),
    ).resolves.toMatchObject({ handled: true, duplicate: false });
    await expect(
      service.handleProviderWebhook(
        "alipay",
        {},
        webhookBody("PAY-PG-ALI-NEW"),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(oldVerifyCount).toBe(1);
    expect(currentVerifyCount).toBe(1);
  });
});
