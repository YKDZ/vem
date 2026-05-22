export type RealPaymentProviderCode = "wechat_pay" | "alipay";

export type ProviderConfigForm = {
  providerCode: RealPaymentProviderCode;
  machineId: string | null;
  status: "enabled" | "disabled";
  merchantNo: string;
  appId: string;
  qrExpiresMinutes: number;
  timeoutCompensationSeconds: number;
  certificateSerialNo: string;
  merchantCertificateSerialNo: string;
  platformCertificateSerialNo: string;
  platformCertificatePem: string;
  gatewayUrl: string;
  keyType: "PKCS8" | "PKCS1";
  mode: "direct_merchant" | "sandbox" | "production";
  apiV3Key: string;
  privateKeyPem: string;
  platformPublicKeyPem: string;
  appCertPem: string;
  alipayPublicCertPem: string;
  alipayRootCertPem: string;
};

export function createDefaultProviderConfigForm(
  providerCode: RealPaymentProviderCode = "alipay",
): ProviderConfigForm {
  return {
    providerCode,
    machineId: null,
    status: "enabled",
    merchantNo: "",
    appId: "",
    qrExpiresMinutes: 15,
    timeoutCompensationSeconds: 120,
    certificateSerialNo: "",
    merchantCertificateSerialNo: "",
    platformCertificateSerialNo: "",
    platformCertificatePem: "",
    gatewayUrl:
      providerCode === "alipay"
        ? "https://openapi-sandbox.dl.alipaydev.com/gateway.do"
        : "",
    keyType: "PKCS8",
    mode: providerCode === "wechat_pay" ? "direct_merchant" : "sandbox",
    apiV3Key: "",
    privateKeyPem: "",
    platformPublicKeyPem: "",
    appCertPem: "",
    alipayPublicCertPem: "",
    alipayRootCertPem: "",
  };
}

function addIfFilled(
  target: Record<string, string | number | boolean | null>,
  key: string,
  value: string,
): void {
  if (value.trim().length > 0) target[key] = value;
}

export function buildProviderConfigPayload(form: ProviderConfigForm): {
  providerCode: RealPaymentProviderCode;
  machineId: string | null;
  merchantNo: string | null;
  appId: string | null;
  publicConfigJson: Record<string, unknown>;
  sensitiveConfigJson:
    | Record<string, string | number | boolean | null>
    | undefined;
  status: "enabled" | "disabled";
} {
  const publicConfigJson: Record<string, unknown> = {
    qrExpiresMinutes: form.qrExpiresMinutes,
    timeoutCompensationSeconds: form.timeoutCompensationSeconds,
  };
  const sensitiveConfigJson: Record<string, string | number | boolean | null> =
    {};

  if (form.providerCode === "wechat_pay") {
    publicConfigJson["mode"] = "direct_merchant";
    publicConfigJson["merchantCertificateSerialNo"] =
      form.merchantCertificateSerialNo || form.certificateSerialNo;
    publicConfigJson["platformCertificateSerialNo"] =
      form.platformCertificateSerialNo;
    addIfFilled(sensitiveConfigJson, "apiV3Key", form.apiV3Key);
    addIfFilled(sensitiveConfigJson, "privateKeyPem", form.privateKeyPem);
    addIfFilled(
      sensitiveConfigJson,
      "platformCertificatePem",
      form.platformCertificatePem,
    );
    addIfFilled(
      sensitiveConfigJson,
      "platformPublicKeyPem",
      form.platformPublicKeyPem,
    );
  } else {
    publicConfigJson["mode"] = form.mode;
    publicConfigJson["gatewayUrl"] = form.gatewayUrl;
    publicConfigJson["keyType"] = form.keyType;
    addIfFilled(sensitiveConfigJson, "privateKeyPem", form.privateKeyPem);
    addIfFilled(sensitiveConfigJson, "appCertPem", form.appCertPem);
    addIfFilled(
      sensitiveConfigJson,
      "alipayPublicCertPem",
      form.alipayPublicCertPem,
    );
    addIfFilled(
      sensitiveConfigJson,
      "alipayRootCertPem",
      form.alipayRootCertPem,
    );
  }

  return {
    providerCode: form.providerCode,
    machineId: form.machineId,
    merchantNo: form.merchantNo || null,
    appId: form.appId || null,
    publicConfigJson,
    sensitiveConfigJson:
      Object.keys(sensitiveConfigJson).length > 0
        ? sensitiveConfigJson
        : undefined,
    status: form.status,
  };
}
