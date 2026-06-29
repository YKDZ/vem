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
  overrides: { paymentMockEnabled?: boolean } = {},
) {
  const queue = [...rowsQueue];
  const mockDb = {
    select: vi.fn(() => ({
      from: () => ({
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

    it("requires WeChat V2 key and merchant API certs when paymentCodeEnabled is true", async () => {
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
      ).rejects.toThrow(/wechat_pay payment_code requires apiV2Key/);
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
  });

  describe("listMachinePaymentOptionsForMachine", () => {
    it("returns both qr_code and payment_code options when paymentCodeEnabled is true", async () => {
      const service = makeListOptionsService([
        [
          makeRow({
            providerCode: "alipay",
            publicConfigJson: { paymentCodeEnabled: true },
          }),
        ],
        [],
      ]);

      const result =
        await service.listMachinePaymentOptionsForMachine("machine-1");

      expect(result.options.map((option) => option.optionKey)).toEqual([
        "qr_code:alipay",
        "payment_code:alipay",
      ]);
      expect(result.defaultOptionKey).toBe("qr_code:alipay");
    });

    it("returns only qr_code option when paymentCodeEnabled is false", async () => {
      const service = makeListOptionsService([
        [
          makeRow({
            providerCode: "alipay",
            publicConfigJson: { paymentCodeEnabled: false },
          }),
        ],
        [],
      ]);

      const result =
        await service.listMachinePaymentOptionsForMachine("machine-1");

      expect(result.options.map((option) => option.optionKey)).toEqual([
        "qr_code:alipay",
      ]);
    });

    it("keeps mock option governed by test environment configuration", async () => {
      const service = makeListOptionsService(
        [[], [], [{ status: "enabled" }]],
        { paymentMockEnabled: true },
      );

      const result =
        await service.listMachinePaymentOptionsForMachine("machine-1");

      expect(result.options.map((option) => option.optionKey)).toEqual([
        "mock:mock",
      ]);
      expect(result.defaultProviderCode).toBe("mock");
    });
  });

  describe("listProductionPilotPaymentEvidenceForMachine", () => {
    it("returns explicit production mode evidence for enabled Alipay methods", async () => {
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
        {
          providerCode: "alipay",
          method: "payment_code",
          mode: "production",
        },
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
