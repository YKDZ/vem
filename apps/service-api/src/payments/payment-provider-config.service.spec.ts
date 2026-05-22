import { ConflictException, NotFoundException } from "@nestjs/common";
import { describe, expect, it } from "vitest";

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
    buildPaymentNotifyUrl: (providerCode: string) => {
      const rawBase = baseUrl.replace(/\/+$/, "");
      if (rawBase.endsWith("/api/payments/webhooks")) {
        return `${rawBase}/${encodeURIComponent(providerCode)}`;
      }
      return `${rawBase}/api/payments/webhooks/${encodeURIComponent(providerCode)}`;
    },
  } as never;
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
    makeAppConfig(),
  );
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
