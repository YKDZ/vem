import { ConflictException, NotFoundException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { encryptJson } from "../crypto/encrypted-json.util";
import { PaymentConfigSecretService } from "./payment-config-secret.service";
import { PaymentProviderConfigService } from "./payment-provider-config.service";

const ENCRYPTION_KEY = "test-key-for-payment-config-0001";

function makeSecrets(): PaymentConfigSecretService {
  return new PaymentConfigSecretService({
    paymentConfigEncryptionKey: ENCRYPTION_KEY,
  } as never);
}

function makeAppConfig(
  baseUrl = "http://localhost:3000/api/payments/webhooks",
) {
  return {
    paymentMockEnabled: false,
    buildPaymentNotifyUrl: (providerCode: string) => {
      const rawBase = baseUrl.replace(/\/+$/, "");
      if (rawBase.endsWith("/api/payments/webhooks")) {
        return `${rawBase}/${encodeURIComponent(providerCode)}`;
      }
      return `${rawBase}/api/payments/webhooks/${encodeURIComponent(providerCode)}`;
    },
  };
}

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "cfg-1",
    providerId: "prov-1",
    providerCode: "wechat_pay",
    machineId: null,
    merchantNo: "MCH001",
    appId: "APP001",
    publicConfigJson: {},
    configEncryptedJson: encryptJson(
      { apiV3Key: "secret-key" },
      ENCRYPTION_KEY,
    ),
    status: "enabled",
    ...overrides,
  };
}

function makeCompleteAlipayRow(overrides: Record<string, unknown> = {}) {
  return makeRow({
    providerCode: "alipay",
    merchantNo: "ALI-MERCHANT-001",
    appId: "ALI-APP-001",
    publicConfigJson: {
      gatewayUrl: "https://openapi.alipay.com/gateway.do",
      keyType: "PKCS8",
    },
    configEncryptedJson: encryptJson(
      {
        privateKeyPem: "alipay-private-key",
        appCertPem: "alipay-app-cert",
        alipayPublicCertPem: "alipay-public-cert",
        alipayRootCertPem: "alipay-root-cert",
      },
      ENCRYPTION_KEY,
    ),
    ...overrides,
  });
}

function makeCompleteWechatRow(overrides: Record<string, unknown> = {}) {
  return makeRow({
    providerCode: "wechat_pay",
    merchantNo: "WX-MCH-001",
    appId: "WX-APP-001",
    publicConfigJson: {
      merchantCertificateSerialNo: "WX-MERCHANT-SERIAL",
      platformCertificateSerialNo: "WX-PLATFORM-SERIAL",
    },
    configEncryptedJson: encryptJson(
      {
        apiV3Key: "12345678901234567890123456789012",
        privateKeyPem: "wechat-private-key",
        platformPublicKeyPem: "wechat-platform-public-key",
      },
      ENCRYPTION_KEY,
    ),
    ...overrides,
  });
}

function makeCompleteWechatPaymentCodeRow(
  overrides: Record<string, unknown> = {},
) {
  const sensitive = {
    apiV3Key: "12345678901234567890123456789012",
    privateKeyPem: "wechat-private-key",
    platformPublicKeyPem: "wechat-platform-public-key",
    apiV2Key: "wechat-v2-key",
    merchantApiCertPem: "wechat-api-cert",
    merchantApiKeyPem: "wechat-api-key",
  };
  return makeCompleteWechatRow({
    configEncryptedJson: encryptJson(sensitive, ENCRYPTION_KEY),
    ...overrides,
  });
}

function makeService(rows: unknown[]) {
  const mockDb = {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: async () => rows,
        }),
      }),
    }),
  };
  return new PaymentProviderConfigService(
    mockDb as never,
    makeSecrets(),
    makeAppConfig() as never,
  );
}

function makeListOptionsService(
  rowsQueue: unknown[],
  overrides: { paymentMockEnabled?: boolean; policyRows?: unknown[] } = {},
) {
  const queue = [...rowsQueue];
  const policyRows = overrides.policyRows ?? [];
  const mockDb = {
    select: vi.fn(() => ({
      from: () => ({
        orderBy: async () => policyRows,
        innerJoin: () => ({
          where: async () => queue.shift() ?? [],
        }),
        where: () => ({
          limit: async () => queue.shift() ?? [],
        }),
      }),
    })),
  };

  const appConfig = makeAppConfig();
  return new PaymentProviderConfigService(mockDb as never, makeSecrets(), {
    paymentMockEnabled: overrides.paymentMockEnabled ?? false,
    buildPaymentNotifyUrl: appConfig.buildPaymentNotifyUrl,
  } as never);
}

function makePolicyRows(
  entries: Array<{
    channelKey:
      | "qr_code:alipay"
      | "payment_code:alipay"
      | "qr_code:wechat_pay"
      | "payment_code:wechat_pay";
    enabled: boolean;
    isDefault?: boolean;
  }>,
) {
  const updatedAt = new Date("2026-07-08T00:00:00.000Z");
  return entries.map((entry, index) => ({
    channelKey: entry.channelKey,
    enabled: entry.enabled,
    rank: index + 1,
    isDefault: entry.isDefault ?? false,
    updatedByAdminUserId: null,
    updatedAt,
  }));
}

describe("PaymentProviderConfigService", () => {
  describe("resolveForPayment", () => {
    it("resolves existing payments from immutable payment-time config binding snapshots", async () => {
      const service = makeService([]);
      const snapshot = service.createBindingSnapshot({
        id: "cfg-old",
        providerId: "prov-alipay",
        providerCode: "alipay",
        machineId: "machine-1",
        merchantNo: "ALI-MERCHANT-OLD",
        appId: "ALI-APP-OLD",
        publicConfigJson: {
          notifyUrl: "https://old.example.com/api/payments/webhooks/alipay",
        },
        sensitiveConfigJson: {
          privateKeyPem: "old-private-key",
          appCertPem: "old-app-cert",
        },
      });

      const result = await service.resolveForExistingPayment({
        providerCode: "alipay",
        providerConfigId: "cfg-old",
        machineId: "machine-1",
        providerConfigSnapshotJson: snapshot,
      });

      expect(result).toMatchObject({
        id: "cfg-old",
        providerCode: "alipay",
        merchantNo: "ALI-MERCHANT-OLD",
        appId: "ALI-APP-OLD",
        sensitiveConfigJson: {
          privateKeyPem: "old-private-key",
          appCertPem: "old-app-cert",
        },
      });
    });

    it("hydrates migrated Alipay binding snapshots with runtime notifyUrl", async () => {
      const service = makeService([]);
      const snapshot = {
        version: 1,
        id: "cfg-migrated",
        providerId: "prov-alipay",
        providerCode: "alipay",
        machineId: null,
        merchantNo: "ALI-MERCHANT-MIGRATED",
        appId: "ALI-APP-MIGRATED",
        publicConfigJson: {
          gatewayUrl: "https://openapi.alipay.com/gateway.do",
          keyType: "PKCS8",
        },
        sensitiveConfigEncryptedJson: encryptJson(
          {
            privateKeyPem: "migrated-private-key",
            appCertPem: "migrated-app-cert",
            alipayPublicCertPem: "migrated-public-cert",
            alipayRootCertPem: "migrated-root-cert",
          },
          ENCRYPTION_KEY,
        ),
        boundAt: "2026-07-08T00:00:00.000Z",
      };

      const result = await service.resolveForExistingPayment({
        providerCode: "alipay",
        providerConfigId: "cfg-migrated",
        machineId: "machine-1",
        providerConfigSnapshotJson: snapshot,
      });

      expect(result.publicConfigJson["notifyUrl"]).toBe(
        "http://localhost:3000/api/payments/webhooks/alipay",
      );
      expect(result.sensitiveConfigJson).toMatchObject({
        privateKeyPem: "migrated-private-key",
      });
    });

    it("returns global config when no machine-level config", async () => {
      const rows = [makeRow({ machineId: null })];
      const service = makeService(rows);
      const result = await service.resolveForPayment({
        providerCode: "wechat_pay",
        machineId: "machine-1",
      });
      expect(result.providerCode).toBe("wechat_pay");
      expect(result.machineId).toBeNull();
    });

    it("prefers machine-level config over global", async () => {
      const rows = [
        makeRow({ id: "cfg-global", machineId: null }),
        makeRow({
          id: "cfg-machine",
          machineId: "machine-1",
          merchantNo: "MCH-MACHINE",
        }),
      ];
      const service = makeService(rows);
      const result = await service.resolveForPayment({
        providerCode: "wechat_pay",
        machineId: "machine-1",
      });
      expect(result.id).toBe("cfg-machine");
      expect(result.merchantNo).toBe("MCH-MACHINE");
    });

    it("throws ConflictException if machine config is disabled", async () => {
      const rows = [
        makeRow({ machineId: "machine-1", status: "disabled" }),
        makeRow({ machineId: null }),
      ];
      const service = makeService(rows);
      await expect(
        service.resolveForPayment({
          providerCode: "wechat_pay",
          machineId: "machine-1",
        }),
      ).rejects.toThrow(ConflictException);
    });

    it("throws NotFoundException when no config found", async () => {
      const service = makeService([]);
      await expect(
        service.resolveForPayment({
          providerCode: "wechat_pay",
          machineId: "machine-1",
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it("decrypts sensitive config from configEncryptedJson", async () => {
      const sensitive = { apiV3Key: "my-secret-api-key" };
      const rows = [
        makeRow({
          configEncryptedJson: encryptJson(sensitive, ENCRYPTION_KEY),
        }),
      ];
      const service = makeService(rows);
      const result = await service.resolveForPayment({
        providerCode: "wechat_pay",
        machineId: "machine-1",
      });
      expect(result.sensitiveConfigJson).toEqual(sensitive);
    });

    it("returns empty sensitiveConfigJson when configEncryptedJson is not valid", async () => {
      const rows = [makeRow({ configEncryptedJson: {} })];
      const service = makeService(rows);
      const result = await service.resolveForPayment({
        providerCode: "wechat_pay",
        machineId: "machine-1",
      });
      expect(result.sensitiveConfigJson).toEqual({});
    });

    it("injects derived notifyUrl into publicConfigJson at runtime", async () => {
      const rows = [makeRow({ machineId: null })];
      const service = makeService(rows);
      const result = await service.resolveForPayment({
        providerCode: "wechat_pay",
        machineId: "machine-1",
      });
      expect(result.publicConfigJson["notifyUrl"]).toBe(
        "http://localhost:3000/api/payments/webhooks/wechat_pay",
      );
    });

    it("machine-level disabled still throws even when global config exists", async () => {
      const rows = [
        makeRow({ machineId: "machine-1", status: "disabled" }),
        makeRow({ machineId: null, status: "enabled" }),
      ];
      const service = makeService(rows);
      await expect(
        service.resolveForPayment({
          providerCode: "wechat_pay",
          machineId: "machine-1",
        }),
      ).rejects.toThrow("Payment provider is disabled for this machine");
    });

    it("ignores legacy paymentCodeEnabled when resolving merchant config", async () => {
      const rows = [
        makeRow({
          publicConfigJson: { paymentCodeEnabled: true },
          configEncryptedJson: encryptJson(
            { apiV3Key: "my-secret-api-key" },
            ENCRYPTION_KEY,
          ),
        }),
      ];
      const service = makeService(rows);

      await expect(
        service.resolveForPayment({
          providerCode: "wechat_pay",
          machineId: "machine-1",
        }),
      ).resolves.toMatchObject({ providerCode: "wechat_pay" });
    });
  });

  describe("listCandidateConfigsForProvider", () => {
    it("returns all enabled configs for provider", async () => {
      const rows = [
        makeRow(),
        makeRow({ id: "cfg-2", machineId: "machine-2" }),
      ];
      const service = makeService(rows);
      const results =
        await service.listCandidateConfigsForProvider("wechat_pay");
      expect(results).toHaveLength(2);
    });

    it("decrypts sensitive config for each row", async () => {
      const sensitive = { privateKeyPem: "-----BEGIN RSA PRIVATE KEY-----" };
      const rows = [
        makeRow({
          configEncryptedJson: encryptJson(sensitive, ENCRYPTION_KEY),
        }),
      ];
      const service = makeService(rows);
      const results =
        await service.listCandidateConfigsForProvider("wechat_pay");
      expect(results[0]?.sensitiveConfigJson).toEqual(sensitive);
    });

    it("injects derived notifyUrl for each config row", async () => {
      const rows = [makeRow({ providerCode: "alipay" })];
      const service = makeService(rows);
      const results = await service.listCandidateConfigsForProvider("alipay");
      expect(results[0]?.publicConfigJson["notifyUrl"]).toBe(
        "http://localhost:3000/api/payments/webhooks/alipay",
      );
    });

    it("skips malformed historical webhook snapshots while keeping valid candidates", async () => {
      const currentRows = [makeCompleteAlipayRow({ id: "cfg-current" })];
      const validSnapshot = {
        version: 1,
        id: "cfg-old",
        providerId: "prov-alipay",
        providerCode: "alipay",
        machineId: null,
        merchantNo: "ALI-MERCHANT-OLD",
        appId: "ALI-APP-OLD",
        publicConfigJson: {
          gatewayUrl: "https://openapi.alipay.com/gateway.do",
          keyType: "PKCS8",
        },
        sensitiveConfigEncryptedJson: encryptJson(
          { privateKeyPem: "old-private-key" },
          ENCRYPTION_KEY,
        ),
        boundAt: "2026-07-08T00:00:00.000Z",
      };
      const malformedSnapshot = {
        ...validSnapshot,
        id: "cfg-bad",
        sensitiveConfigEncryptedJson: encryptJson(
          { privateKeyPem: "bad-private-key" },
          "different-key",
        ),
      };
      let selectCall = 0;
      const mockDb = {
        select: vi.fn(() => {
          selectCall += 1;
          if (selectCall === 1) {
            return {
              from: () => ({
                innerJoin: () => ({
                  where: async () => currentRows,
                }),
              }),
            };
          }
          return {
            from: () => ({
              innerJoin: () => ({
                where: () => ({
                  orderBy: () => ({
                    limit: async () => [
                      { snapshot: malformedSnapshot },
                      { snapshot: validSnapshot },
                    ],
                  }),
                }),
              }),
            }),
          };
        }),
      };
      const service = new PaymentProviderConfigService(
        mockDb as never,
        makeSecrets(),
        makeAppConfig() as never,
      );

      const results =
        await service.listWebhookCandidateConfigsForProvider("alipay");

      expect(results.map((result) => result.id)).toEqual([
        "cfg-current",
        "cfg-old",
      ]);
      expect(results[1]?.publicConfigJson["notifyUrl"]).toBe(
        "http://localhost:3000/api/payments/webhooks/alipay",
      );
    });

    it("keeps an immutable payment snapshot when the current row has the same config id", async () => {
      const currentRows = [
        makeCompleteAlipayRow({
          id: "cfg-rotated-in-place",
          configEncryptedJson: encryptJson(
            { privateKeyPem: "current-private-key" },
            ENCRYPTION_KEY,
          ),
        }),
      ];
      const oldSnapshot = {
        version: 1,
        id: "cfg-rotated-in-place",
        providerId: "prov-alipay",
        providerCode: "alipay",
        machineId: null,
        merchantNo: "ALI-MERCHANT-OLD",
        appId: "ALI-APP-SHARED",
        publicConfigJson: {},
        sensitiveConfigEncryptedJson: encryptJson(
          { privateKeyPem: "old-private-key" },
          ENCRYPTION_KEY,
        ),
        boundAt: "2026-07-01T00:00:00.000Z",
      };
      let selectCall = 0;
      const mockDb = {
        select: vi.fn(() => {
          selectCall += 1;
          if (selectCall === 1) {
            return {
              from: () => ({
                innerJoin: () => ({ where: async () => currentRows }),
              }),
            };
          }
          return {
            from: () => ({
              innerJoin: () => ({
                where: () => ({
                  orderBy: () => ({
                    limit: async () => [{ snapshot: oldSnapshot }],
                  }),
                }),
              }),
            }),
          };
        }),
      };
      const service = new PaymentProviderConfigService(
        mockDb as never,
        makeSecrets(),
        makeAppConfig() as never,
      );

      const results =
        await service.listWebhookCandidateConfigsForProvider("alipay");

      expect(results).toHaveLength(2);
      expect(results.map((result) => result.id)).toEqual([
        "cfg-rotated-in-place",
        "cfg-rotated-in-place",
      ]);
      expect(results[1]?.sensitiveConfigJson).toMatchObject({
        privateKeyPem: "old-private-key",
      });
    });
  });

  describe("listMachinePaymentOptionsForMachine", () => {
    it("reports sandbox to protected diagnostics without changing customer copy or using mock", async () => {
      const sandbox = makeListOptionsService(
        [
          [
            makeCompleteAlipayRow({
              publicConfigJson: {
                mode: "sandbox",
                gatewayUrl:
                  "https://openapi-sandbox.dl.alipaydev.com/gateway.do",
                keyType: "PKCS8",
                notifyUrl:
                  "https://platform.example/api/payments/webhooks/alipay",
              },
            }),
          ],
          [],
        ],
        {
          policyRows: makePolicyRows([
            { channelKey: "qr_code:alipay", enabled: true, isDefault: true },
            { channelKey: "payment_code:alipay", enabled: false },
            { channelKey: "qr_code:wechat_pay", enabled: false },
            { channelKey: "payment_code:wechat_pay", enabled: false },
          ]),
        },
      );
      const production = makeListOptionsService(
        [
          [
            makeCompleteAlipayRow({
              publicConfigJson: {
                mode: "production",
                gatewayUrl: "https://openapi.alipay.com/gateway.do",
                keyType: "PKCS8",
                notifyUrl:
                  "https://platform.example/api/payments/webhooks/alipay",
              },
            }),
          ],
          [],
        ],
        {
          policyRows: makePolicyRows([
            { channelKey: "qr_code:alipay", enabled: true, isDefault: true },
            { channelKey: "payment_code:alipay", enabled: false },
            { channelKey: "qr_code:wechat_pay", enabled: false },
            { channelKey: "payment_code:wechat_pay", enabled: false },
          ]),
        },
      );

      const sandboxResult =
        await sandbox.listMachinePaymentOptionsForMachine("machine-1");
      const productionResult =
        await production.listMachinePaymentOptionsForMachine("machine-1");

      expect(sandboxResult.providerEnvironment).toEqual({
        environment: "sandbox",
        readiness: "ready",
        errorCategory: "none",
      });
      expect(sandboxResult.options).toEqual(productionResult.options);
      expect(JSON.stringify(sandboxResult.options)).not.toMatch(
        /sandbox|沙箱/i,
      );
      expect(sandboxResult.options[0]?.providerCode).toBe("alipay");
    });

    it("projects ready machine options from global channel policy order and default", async () => {
      const service = makeListOptionsService(
        [[makeCompleteAlipayRow()], [makeCompleteWechatRow()]],
        {
          policyRows: makePolicyRows([
            {
              channelKey: "payment_code:wechat_pay",
              enabled: true,
              isDefault: true,
            },
            { channelKey: "payment_code:alipay", enabled: true },
            { channelKey: "qr_code:alipay", enabled: true },
            { channelKey: "qr_code:wechat_pay", enabled: false },
          ]),
        },
      );

      const result =
        await service.listMachinePaymentOptionsForMachine("machine-1");

      expect(result.options.map((option) => option.optionKey)).toEqual([
        "payment_code:alipay",
        "qr_code:alipay",
      ]);
      expect(result.defaultOptionKey).toBe("payment_code:alipay");
      expect(result.defaultProviderCode).toBe("alipay");
      expect(result.options.map((option) => option.recommended)).toEqual([
        true,
        false,
      ]);
    });

    it("keeps all four real channels independently controlled by policy", async () => {
      const service = makeListOptionsService(
        [[makeCompleteAlipayRow()], [makeCompleteWechatPaymentCodeRow()]],
        {
          policyRows: makePolicyRows([
            { channelKey: "qr_code:wechat_pay", enabled: true },
            { channelKey: "payment_code:wechat_pay", enabled: true },
            { channelKey: "payment_code:alipay", enabled: false },
            { channelKey: "qr_code:alipay", enabled: true, isDefault: true },
          ]),
        },
      );

      const result =
        await service.listMachinePaymentOptionsForMachine("machine-1");

      expect(result.options.map((option) => option.optionKey)).toEqual([
        "qr_code:wechat_pay",
        "payment_code:wechat_pay",
        "qr_code:alipay",
      ]);
      expect(result.defaultOptionKey).toBe("qr_code:alipay");
      expect(result.options.map((option) => option.recommended)).toEqual([
        false,
        false,
        true,
      ]);
    });

    it("does not derive payment_code options from legacy provider config switches", async () => {
      const service = makeListOptionsService(
        [
          [
            makeCompleteAlipayRow({
              publicConfigJson: {
                gatewayUrl: "https://openapi.alipay.com/gateway.do",
                keyType: "PKCS8",
                paymentCodeEnabled: true,
              },
            }),
          ],
          [],
        ],
        {
          policyRows: makePolicyRows([
            { channelKey: "qr_code:alipay", enabled: true, isDefault: true },
            { channelKey: "payment_code:alipay", enabled: false },
            { channelKey: "qr_code:wechat_pay", enabled: false },
            { channelKey: "payment_code:wechat_pay", enabled: false },
          ]),
        },
      );

      const result =
        await service.listMachinePaymentOptionsForMachine("machine-1");

      expect(result.options.map((option) => option.optionKey)).toEqual([
        "qr_code:alipay",
      ]);
      expect(result.defaultOptionKey).toBe("qr_code:alipay");
    });

    it("returns only qr_code option when paymentCodeEnabled is false", async () => {
      const service = makeListOptionsService(
        [
          [
            makeCompleteAlipayRow({
              publicConfigJson: {
                gatewayUrl: "https://openapi.alipay.com/gateway.do",
                keyType: "PKCS8",
                paymentCodeEnabled: false,
              },
            }),
          ],
          [],
        ],
        {
          policyRows: makePolicyRows([
            { channelKey: "qr_code:alipay", enabled: true, isDefault: true },
            { channelKey: "payment_code:alipay", enabled: false },
            { channelKey: "qr_code:wechat_pay", enabled: false },
            { channelKey: "payment_code:wechat_pay", enabled: false },
          ]),
        },
      );

      const result =
        await service.listMachinePaymentOptionsForMachine("machine-1");

      expect(result.options.map((option) => option.optionKey)).toEqual([
        "qr_code:alipay",
      ]);
    });

    it("blocks incomplete Alipay config instead of treating config existence as ready", async () => {
      const service = makeListOptionsService(
        [
          [
            makeRow({
              providerCode: "alipay",
              merchantNo: null,
              appId: "ALI-APP-001",
              publicConfigJson: {
                gatewayUrl: "https://openapi.alipay.com/gateway.do",
              },
              configEncryptedJson: encryptJson(
                { privateKeyPem: "alipay-private-key" },
                ENCRYPTION_KEY,
              ),
            }),
          ],
          [],
        ],
        {
          policyRows: makePolicyRows([
            { channelKey: "qr_code:alipay", enabled: true, isDefault: true },
            { channelKey: "payment_code:alipay", enabled: true },
            { channelKey: "qr_code:wechat_pay", enabled: false },
            { channelKey: "payment_code:wechat_pay", enabled: false },
          ]),
        },
      );

      const result =
        await service.listMachinePaymentOptionsForMachine("machine-1");

      expect(result.options.map((option) => option.optionKey)).toEqual([]);
      expect(result.defaultOptionKey).toBeNull();
      await expect(
        service.assertMachinePaymentChannelAvailable({
          machineId: "machine-1",
          providerCode: "alipay",
          method: "qr_code",
        }),
      ).rejects.toThrow(ConflictException);
    });

    it("keeps WeChat QR while hiding WeChat payment_code when V2 credentials are missing", async () => {
      const service = makeListOptionsService([[], [makeCompleteWechatRow()]], {
        policyRows: makePolicyRows([
          { channelKey: "qr_code:wechat_pay", enabled: true, isDefault: true },
          { channelKey: "payment_code:wechat_pay", enabled: true },
          { channelKey: "qr_code:alipay", enabled: false },
          { channelKey: "payment_code:alipay", enabled: false },
        ]),
      });

      const result =
        await service.listMachinePaymentOptionsForMachine("machine-1");

      expect(result.options.map((option) => option.optionKey)).toEqual([
        "qr_code:wechat_pay",
      ]);
      expect(result.defaultOptionKey).toBe("qr_code:wechat_pay");
    });

    it("rejects policy-disabled channels through the machine channel assertion", async () => {
      const service = makeListOptionsService([[makeCompleteAlipayRow()], []], {
        policyRows: makePolicyRows([
          { channelKey: "qr_code:alipay", enabled: false, isDefault: true },
          { channelKey: "payment_code:alipay", enabled: true },
          { channelKey: "qr_code:wechat_pay", enabled: false },
          { channelKey: "payment_code:wechat_pay", enabled: false },
        ]),
      });

      await expect(
        service.assertMachinePaymentChannelAvailable({
          machineId: "machine-1",
          providerCode: "alipay",
          method: "qr_code",
        }),
      ).rejects.toThrow(ConflictException);
    });

    it("keeps mock and mock payment-code options governed by test configuration", async () => {
      const service = makeListOptionsService(
        [[], [], [{ status: "enabled" }]],
        { paymentMockEnabled: true },
      );

      const result =
        await service.listMachinePaymentOptionsForMachine("machine-1");

      expect(result.options.map((option) => option.optionKey)).toEqual([
        "payment_code:mock",
        "mock:mock",
      ]);
      expect(result.defaultProviderCode).toBe("mock");
    });
  });

  describe("listProductionPilotPaymentEvidenceForMachine", () => {
    it("returns production mode evidence for provider readiness without legacy channel switches", async () => {
      const service = makeListOptionsService([
        [
          makeRow({
            providerCode: "alipay",
            publicConfigJson: {
              mode: "production",
              paymentCodeEnabled: true,
            },
          }),
        ],
        [],
      ]);

      const result =
        await service.listProductionPilotPaymentEvidenceForMachine("machine-1");

      expect(result).toEqual([
        { providerCode: "alipay", method: "qr_code", mode: "production" },
      ]);
    });

    it("preserves Alipay sandbox mode as non-production evidence", async () => {
      const service = makeListOptionsService([
        [
          makeRow({
            providerCode: "alipay",
            publicConfigJson: { mode: "sandbox" },
          }),
        ],
        [],
      ]);

      const result =
        await service.listProductionPilotPaymentEvidenceForMachine("machine-1");

      expect(result).toEqual([
        { providerCode: "alipay", method: "qr_code", mode: "sandbox" },
      ]);
    });
  });

  describe("listPaymentChannelProviderReadinessForMachine", () => {
    it("reports missing WeChat V2 payment-code credentials independently from legacy enablement", async () => {
      const service = makeListOptionsService([
        [],
        [
          makeRow({
            providerCode: "wechat_pay",
            configEncryptedJson: encryptJson(
              {
                apiV3Key: "12345678901234567890123456789012",
                privateKeyPem: "wechat-private-key",
                platformPublicKeyPem: "wechat-platform-public-key",
              },
              ENCRYPTION_KEY,
            ),
            merchantNo: "WX-MCH-001",
            appId: "WX-APP-001",
            publicConfigJson: {
              paymentCodeEnabled: true,
              merchantCertificateSerialNo: "WX-MERCHANT-SERIAL",
              platformCertificateSerialNo: "WX-PLATFORM-SERIAL",
            },
          }),
        ],
      ]);

      const result =
        await service.listPaymentChannelProviderReadinessForMachine(
          "machine-1",
        );

      expect(result).toContainEqual({
        channelKey: "payment_code:wechat_pay",
        providerCode: "wechat_pay",
        method: "payment_code",
        ready: false,
        environment: "production",
        missingCredentialKeys: [
          "apiV2Key",
          "merchantApiCertPem",
          "merchantApiKeyPem",
        ],
      });
      expect(result).toContainEqual({
        channelKey: "qr_code:wechat_pay",
        providerCode: "wechat_pay",
        method: "qr_code",
        ready: true,
        environment: "production",
        missingCredentialKeys: [],
      });
    });
  });
});

describe("PaymentProviderConfigService", () => {
  describe("resolveForPayment", () => {
    it("returns global config when no machine-level config", async () => {
      const rows = [makeRow({ machineId: null })];
      const service = makeService(rows);
      const result = await service.resolveForPayment({
        providerCode: "wechat_pay",
        machineId: "machine-1",
      });
      expect(result.providerCode).toBe("wechat_pay");
      expect(result.machineId).toBeNull();
    });

    it("prefers machine-level config over global", async () => {
      const rows = [
        makeRow({ id: "cfg-global", machineId: null }),
        makeRow({
          id: "cfg-machine",
          machineId: "machine-1",
          merchantNo: "MCH-MACHINE",
        }),
      ];
      const service = makeService(rows);
      const result = await service.resolveForPayment({
        providerCode: "wechat_pay",
        machineId: "machine-1",
      });
      expect(result.id).toBe("cfg-machine");
      expect(result.merchantNo).toBe("MCH-MACHINE");
    });

    it("throws ConflictException if machine config is disabled", async () => {
      const rows = [
        makeRow({ machineId: "machine-1", status: "disabled" }),
        makeRow({ machineId: null }),
      ];
      const service = makeService(rows);
      await expect(
        service.resolveForPayment({
          providerCode: "wechat_pay",
          machineId: "machine-1",
        }),
      ).rejects.toThrow(ConflictException);
    });

    it("throws NotFoundException when no config found", async () => {
      const service = makeService([]);
      await expect(
        service.resolveForPayment({
          providerCode: "wechat_pay",
          machineId: "machine-1",
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it("decrypts sensitive config from configEncryptedJson", async () => {
      const sensitive = { apiV3Key: "my-secret-api-key" };
      const rows = [
        makeRow({
          configEncryptedJson: encryptJson(sensitive, ENCRYPTION_KEY),
        }),
      ];
      const service = makeService(rows);
      const result = await service.resolveForPayment({
        providerCode: "wechat_pay",
        machineId: "machine-1",
      });
      expect(result.sensitiveConfigJson).toEqual(sensitive);
    });

    it("returns empty sensitiveConfigJson when configEncryptedJson is not valid", async () => {
      const rows = [makeRow({ configEncryptedJson: {} })];
      const service = makeService(rows);
      const result = await service.resolveForPayment({
        providerCode: "wechat_pay",
        machineId: "machine-1",
      });
      expect(result.sensitiveConfigJson).toEqual({});
    });
  });

  describe("listCandidateConfigsForProvider", () => {
    it("returns all enabled configs for provider", async () => {
      const rows = [
        makeRow(),
        makeRow({ id: "cfg-2", machineId: "machine-2" }),
      ];
      const service = makeService(rows);
      const results =
        await service.listCandidateConfigsForProvider("wechat_pay");
      expect(results).toHaveLength(2);
    });

    it("decrypts sensitive config for each row", async () => {
      const sensitive = { privateKeyPem: "-----BEGIN RSA PRIVATE KEY-----" };
      const rows = [
        makeRow({
          configEncryptedJson: encryptJson(sensitive, ENCRYPTION_KEY),
        }),
      ];
      const service = makeService(rows);
      const results =
        await service.listCandidateConfigsForProvider("wechat_pay");
      expect(results[0]?.sensitiveConfigJson).toEqual(sensitive);
    });
  });
});
