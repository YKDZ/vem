import { describe, expect, it } from "vitest";

import {
  buildProviderConfigPayload,
  createDefaultProviderConfigForm,
} from "./payment-config-model";

describe("payment-config-model", () => {
  describe("buildProviderConfigPayload (wechat_pay)", () => {
    it("writes merchantCertificateSerialNo to publicConfigJson (not certificateSerialNo)", () => {
      const form = createDefaultProviderConfigForm("wechat_pay");
      form.merchantCertificateSerialNo = "CERT_SERIAL_001";
      form.platformCertificateSerialNo = "PLAT_SERIAL_002";
      form.platformCertificatePem =
        "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----";

      const payload = buildProviderConfigPayload(form);

      expect(payload.publicConfigJson["merchantCertificateSerialNo"]).toBe(
        "CERT_SERIAL_001",
      );
      expect(payload.publicConfigJson["platformCertificateSerialNo"]).toBe(
        "PLAT_SERIAL_002",
      );
      expect(payload.publicConfigJson).not.toHaveProperty(
        "certificateSerialNo",
      );
    });

    it("writes platformCertificatePem to sensitiveConfigJson (not publicConfigJson)", () => {
      const form = createDefaultProviderConfigForm("wechat_pay");
      form.platformCertificatePem =
        "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----";

      const payload = buildProviderConfigPayload(form);

      expect(payload.sensitiveConfigJson).toHaveProperty(
        "platformCertificatePem",
      );
      expect(payload.publicConfigJson).not.toHaveProperty(
        "platformCertificatePem",
      );
    });

    it("falls back to certificateSerialNo when merchantCertificateSerialNo is empty", () => {
      const form = createDefaultProviderConfigForm("wechat_pay");
      form.certificateSerialNo = "OLD_SERIAL";
      form.merchantCertificateSerialNo = "";

      const payload = buildProviderConfigPayload(form);

      expect(payload.publicConfigJson["merchantCertificateSerialNo"]).toBe(
        "OLD_SERIAL",
      );
    });

    it("does not include platformPublicKeyPem in sensitiveConfigJson when empty", () => {
      const form = createDefaultProviderConfigForm("wechat_pay");
      form.platformPublicKeyPem = "";
      form.platformCertificatePem = "";
      form.apiV3Key = "";
      form.privateKeyPem = "";

      const payload = buildProviderConfigPayload(form);

      expect(payload.sensitiveConfigJson).toBeUndefined();
    });
  });

  describe("buildProviderConfigPayload (alipay)", () => {
    it("includes mode and gatewayUrl in publicConfigJson", () => {
      const form = createDefaultProviderConfigForm("alipay");
      form.mode = "production";
      form.gatewayUrl = "https://openapi.alipay.com/gateway.do";

      const payload = buildProviderConfigPayload(form);

      expect(payload.publicConfigJson["mode"]).toBe("production");
      expect(payload.publicConfigJson["gatewayUrl"]).toBe(
        "https://openapi.alipay.com/gateway.do",
      );
    });
  });
});
