import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import {
  X509Certificate,
  createDecipheriv,
  createSign,
  createVerify,
  randomUUID,
} from "node:crypto";

import type {
  PaymentIntentInput,
  PaymentIntentResult,
  PaymentProvider,
  PaymentProviderRuntimeConfig,
  ProviderCancelPaymentInput,
  ProviderCancelPaymentResult,
  ProviderPaymentQueryInput,
  ProviderPaymentQueryResult,
  ProviderRefundPaymentInput,
  ProviderRefundPaymentResult,
  ProviderRefundQueryInput,
  ProviderRefundQueryResult,
  ProviderRefundWebhookResult,
  ProviderWebhookInput,
  ProviderWebhookResult,
} from "./payment-provider.interface";

type WeChatPayConfig = {
  mchId: string;
  appId: string;
  apiV3Key: string;
  privateKeyPem: string;
  /** 商户 API 证书序列号，用于 Authorization serial_no 请求签名 */
  merchantCertificateSerialNo: string;
  /** 微信支付平台证书/公钥序列号，用于匹配 wechatpay-serial 响应/回调头 */
  platformCertificateSerialNo: string;
  /** 微信支付平台公钥 PEM，用于验签（可从 platformCertificatePem 提取） */
  platformPublicKeyPem: string;
  notifyUrl: string;
};

function readRequiredString(
  source: Record<string, unknown>,
  key: string,
  providerName: string,
): string {
  const value = source[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConflictException(`${providerName} config is incomplete: ${key}`);
  }
  return value;
}

/**
 * 从证书 PEM 中提取 SPKI 格式公钥 PEM，供 RSA 验签使用。
 */
function extractPublicKeyFromCertificatePem(certPem: string): string {
  const cert = new X509Certificate(certPem);
  return cert.publicKey.export({ type: "spki", format: "pem" }) as string;
}

function parseWeChatPayConfig(
  input: PaymentProviderRuntimeConfig,
): WeChatPayConfig {
  const source: Record<string, unknown> = {
    ...input.publicConfigJson,
    ...input.sensitiveConfigJson,
  };
  // merchantNo and appId may come from top-level fields
  if (input.merchantNo) source["mchId"] ??= input.merchantNo;
  if (input.appId) source["appId"] ??= input.appId;

  // merchantCertificateSerialNo: new field, fall back to deprecated certificateSerialNo
  const merchantCertificateSerialNo =
    typeof source["merchantCertificateSerialNo"] === "string" &&
    source["merchantCertificateSerialNo"].length > 0
      ? source["merchantCertificateSerialNo"]
      : readRequiredString(source, "certificateSerialNo", "WeChat Pay");

  // platformCertificateSerialNo: must come from new field; no fallback to merchantCertificateSerialNo
  const platformCertificateSerialNo = readRequiredString(
    source,
    "platformCertificateSerialNo",
    "WeChat Pay",
  );

  // Prefer extracting public key from platformCertificatePem (has expiry info),
  // fall back to raw platformPublicKeyPem.
  let platformPublicKeyPem: string;
  if (
    typeof source["platformCertificatePem"] === "string" &&
    source["platformCertificatePem"].length > 0
  ) {
    platformPublicKeyPem = extractPublicKeyFromCertificatePem(
      source["platformCertificatePem"],
    );
  } else {
    platformPublicKeyPem = readRequiredString(
      source,
      "platformPublicKeyPem",
      "WeChat Pay",
    );
  }

  // apiV3Key must be exactly 32 bytes (UTF-8)
  const apiV3Key = readRequiredString(source, "apiV3Key", "WeChat Pay");
  if (Buffer.from(apiV3Key, "utf8").length !== 32) {
    throw new ConflictException(
      "WeChat Pay config is incomplete: apiV3Key must be exactly 32 bytes (UTF-8)",
    );
  }

  return {
    mchId: readRequiredString(source, "mchId", "WeChat Pay"),
    appId: readRequiredString(source, "appId", "WeChat Pay"),
    apiV3Key,
    privateKeyPem: readRequiredString(source, "privateKeyPem", "WeChat Pay"),
    merchantCertificateSerialNo,
    platformCertificateSerialNo,
    platformPublicKeyPem,
    notifyUrl: readRequiredString(source, "notifyUrl", "WeChat Pay"),
  };
}

async function requestWechat(
  config: WeChatPayConfig,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const bodyText = body === undefined ? "" : JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomUUID().replaceAll("-", "");
  const signText = `${method}\n${path}\n${timestamp}\n${nonce}\n${bodyText}\n`;
  const signature = createSign("RSA-SHA256")
    .update(signText)
    .sign(config.privateKeyPem, "base64");
  // serial_no in Authorization must be merchantCertificateSerialNo
  const authorization = [
    `mchid="${config.mchId}"`,
    `nonce_str="${nonce}"`,
    `timestamp="${timestamp}"`,
    `serial_no="${config.merchantCertificateSerialNo}"`,
    `signature="${signature}"`,
  ].join(",");
  const response = await fetch(`https://api.mch.weixin.qq.com${path}`, {
    method,
    headers: {
      Accept: "application/json",
      Authorization: `WECHATPAY2-SHA256-RSA2048 ${authorization}`,
      "Content-Type": "application/json",
    },
    body: bodyText.length > 0 ? bodyText : undefined,
  });
  const rawBodyText = await response.text();
  if (!response.ok) {
    // Only expose non-sensitive error snippet; do not leak keys/credentials
    throw new BadGatewayException(
      `WeChat Pay request failed: ${response.status} ${rawBodyText.slice(0, 200)}`,
    );
  }

  // Empty body (e.g. 204 No Content for close endpoint) — no signature to verify
  if (rawBodyText.trim().length === 0) {
    return {};
  }

  // Verify response signature before parsing
  const respTimestamp = response.headers.get("Wechatpay-Timestamp") ?? "";
  const respNonce = response.headers.get("Wechatpay-Nonce") ?? "";
  const respSignature = response.headers.get("Wechatpay-Signature") ?? "";
  const respSerial = response.headers.get("Wechatpay-Serial") ?? "";

  if (!respTimestamp || !respNonce || !respSignature || !respSerial) {
    throw new BadGatewayException(
      "WeChat Pay response missing signature headers",
    );
  }
  if (respSerial !== config.platformCertificateSerialNo) {
    throw new BadGatewayException("WeChat Pay response serial mismatch");
  }
  const respSignMessage = `${respTimestamp}\n${respNonce}\n${rawBodyText}\n`;
  const respValid = createVerify("RSA-SHA256")
    .update(respSignMessage, "utf8")
    .verify(config.platformPublicKeyPem, respSignature, "base64");
  if (!respValid) {
    throw new BadGatewayException("WeChat Pay response signature invalid");
  }

  return assertRecord(JSON.parse(rawBodyText) as unknown);
}

function mapWeChatTradeState(
  data: Record<string, unknown>,
): ProviderPaymentQueryResult {
  const tradeState =
    typeof data["trade_state"] === "string" ? data["trade_state"] : "NOTPAY";
  const statusByState: Record<string, ProviderPaymentQueryResult["status"]> = {
    SUCCESS: "succeeded",
    USERPAYING: "processing", // user is in process of paying (e.g. face-pay prompt)
    NOTPAY: "pending",
    CLOSED: "canceled",
    REVOKED: "canceled",
    PAYERROR: "failed",
    REFUND: "succeeded", // payment succeeded; refund lifecycle managed by refunds table
  };
  const paidAt =
    tradeState === "SUCCESS" && typeof data["success_time"] === "string"
      ? new Date(data["success_time"])
      : undefined;
  return {
    status: statusByState[tradeState] ?? "pending",
    providerTradeNo:
      typeof data["transaction_id"] === "string"
        ? data["transaction_id"]
        : null,
    paidAt,
    rawPayload: data,
  };
}

function assertRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BadRequestException("Webhook body must be an object");
  }
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    result[key] = val;
  }
  return result;
}

function headerString(
  headers: Record<string, string | string[] | undefined>,
  key: string,
): string {
  const value = headers[key] ?? headers[key.toLowerCase()];
  const normalized = Array.isArray(value) ? value[0] : value;
  if (typeof normalized !== "string" || normalized.length === 0) {
    throw new UnauthorizedException(`Missing webhook header ${key}`);
  }
  return normalized;
}

function verifyWeChatHeaders(
  headers: Record<string, string | string[] | undefined>,
  rawBodyText: string,
  config: WeChatPayConfig,
): void {
  const timestamp = headerString(headers, "wechatpay-timestamp");
  const nonce = headerString(headers, "wechatpay-nonce");
  const signature = headerString(headers, "wechatpay-signature");
  const serial = headerString(headers, "wechatpay-serial");
  // wechatpay-serial must match platform certificate serial, NOT merchant serial
  if (serial !== config.platformCertificateSerialNo) {
    throw new UnauthorizedException("WeChat Pay certificate serial mismatch");
  }
  const message = `${timestamp}\n${nonce}\n${rawBodyText}\n`;
  const valid = createVerify("RSA-SHA256")
    .update(message, "utf8")
    .verify(config.platformPublicKeyPem, signature, "base64");
  if (!valid) {
    throw new UnauthorizedException("WeChat Pay signature invalid");
  }
}

function decryptWeChatResource(
  body: Record<string, unknown>,
  apiV3Key: string,
): Record<string, unknown> {
  const resourceRecord = assertRecord(body["resource"]);
  const ciphertextWithTag = Buffer.from(
    readRequiredString(resourceRecord, "ciphertext", "WeChat Pay resource"),
    "base64",
  );
  const nonce = Buffer.from(
    readRequiredString(resourceRecord, "nonce", "WeChat Pay resource"),
    "utf8",
  );
  const associatedData = Buffer.from(
    typeof resourceRecord["associated_data"] === "string"
      ? resourceRecord["associated_data"]
      : "",
    "utf8",
  );
  const authTag = ciphertextWithTag.subarray(ciphertextWithTag.length - 16);
  const ciphertext = ciphertextWithTag.subarray(
    0,
    ciphertextWithTag.length - 16,
  );
  const decipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(apiV3Key, "utf8"),
    nonce,
  );
  decipher.setAAD(associatedData);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
  return assertRecord(JSON.parse(plaintext) as unknown);
}

function mapWeChatRefundWebhook(
  decrypted: Record<string, unknown>,
  originalBody: Record<string, unknown>,
  matchedConfigId: string | undefined,
): ProviderRefundWebhookResult {
  const refundNo =
    typeof decrypted["out_refund_no"] === "string"
      ? decrypted["out_refund_no"]
      : null;
  const providerRefundNo =
    typeof decrypted["refund_id"] === "string" ? decrypted["refund_id"] : null;
  const paymentNo =
    typeof decrypted["out_trade_no"] === "string"
      ? decrypted["out_trade_no"]
      : null;
  const rawStatus =
    typeof decrypted["refund_status"] === "string"
      ? decrypted["refund_status"]
      : typeof decrypted["status"] === "string"
        ? decrypted["status"]
        : "PROCESSING";
  const refundStatus =
    rawStatus === "SUCCESS"
      ? "succeeded"
      : rawStatus === "ABNORMAL" || rawStatus === "CLOSED"
        ? "failed"
        : "processing";

  return {
    eventKind: "refund",
    providerEventId:
      typeof originalBody["id"] === "string"
        ? originalBody["id"]
        : `${refundNo ?? providerRefundNo}:${rawStatus}`,
    eventType:
      typeof originalBody["event_type"] === "string"
        ? originalBody["event_type"]
        : "wechat_pay.refund",
    refundNo,
    paymentNo,
    providerRefundNo,
    refundStatus,
    signatureValid: true,
    rawPayload: { body: originalBody, decrypted },
    normalizedPayload: {
      refundNo,
      paymentNo,
      providerRefundNo,
      refundStatus: rawStatus,
    },
    matchedConfigId: matchedConfigId ?? null,
  };
}

function mapWeChatWebhook(
  decrypted: Record<string, unknown>,
  originalBody: Record<string, unknown>,
  matchedConfigId: string | undefined,
): ProviderWebhookResult {
  // Detect refund webhooks by event_type or resource.original_type
  const resource =
    typeof originalBody["resource"] === "object" &&
    originalBody["resource"] !== null &&
    !Array.isArray(originalBody["resource"])
      ? (originalBody["resource"] as Record<string, unknown>)
      : {};
  const originalType =
    typeof resource["original_type"] === "string"
      ? resource["original_type"]
      : "";
  const eventType =
    typeof originalBody["event_type"] === "string"
      ? originalBody["event_type"]
      : "";
  if (originalType === "refund" || eventType.startsWith("REFUND.")) {
    return mapWeChatRefundWebhook(decrypted, originalBody, matchedConfigId);
  }

  const paymentNo = readRequiredString(
    decrypted,
    "out_trade_no",
    "WeChat Pay webhook",
  );
  const providerTradeNo =
    typeof decrypted["transaction_id"] === "string"
      ? decrypted["transaction_id"]
      : null;
  const queryResult = mapWeChatTradeState(decrypted);
  const amountRecord =
    typeof decrypted["amount"] === "object" &&
    decrypted["amount"] !== null &&
    !Array.isArray(decrypted["amount"])
      ? (decrypted["amount"] as Record<string, unknown>)
      : {};
  // Normalized payload for service-layer business field validation
  const normalizedPayload: Record<string, unknown> = {
    appId: typeof decrypted["appid"] === "string" ? decrypted["appid"] : null,
    mchId: typeof decrypted["mchid"] === "string" ? decrypted["mchid"] : null,
    outTradeNo: paymentNo,
    transactionId: providerTradeNo,
    tradeState:
      typeof decrypted["trade_state"] === "string"
        ? decrypted["trade_state"]
        : null,
    amountTotal:
      typeof amountRecord["total"] === "number" ? amountRecord["total"] : null,
    amountCurrency:
      typeof amountRecord["currency"] === "string"
        ? amountRecord["currency"]
        : null,
    successTime:
      typeof decrypted["success_time"] === "string"
        ? decrypted["success_time"]
        : null,
  };
  return {
    eventKind: "payment",
    providerEventId:
      typeof originalBody["id"] === "string"
        ? originalBody["id"]
        : `${paymentNo}:${queryResult.status}`,
    eventType: "wechat_pay.webhook",
    paymentNo,
    providerTradeNo,
    paymentStatus: queryResult.status,
    signatureValid: true,
    rawPayload: { body: originalBody, decrypted },
    normalizedPayload,
    matchedConfigId: matchedConfigId ?? null,
  };
}

function mapWeChatRefund(
  data: Record<string, unknown>,
  fallbackRefundNo: string,
): ProviderRefundPaymentResult {
  const status =
    typeof data["status"] === "string" ? data["status"] : "PROCESSING";
  return {
    providerRefundNo:
      typeof data["refund_id"] === "string"
        ? data["refund_id"]
        : typeof data["out_refund_no"] === "string"
          ? data["out_refund_no"]
          : fallbackRefundNo,
    status:
      status === "SUCCESS"
        ? "succeeded"
        : status === "ABNORMAL"
          ? "failed"
          : "processing",
    refundedAt: status === "SUCCESS" ? new Date() : null,
    rawPayload: data,
  };
}

@Injectable()
export class WeChatPayProvider implements PaymentProvider {
  readonly code = "wechat_pay";

  async createPaymentIntent(
    input: PaymentIntentInput,
  ): Promise<PaymentIntentResult> {
    const config = parseWeChatPayConfig(input.config);
    const body = {
      appid: config.appId,
      mchid: config.mchId,
      description: `VEM order ${input.orderNo}`,
      out_trade_no: input.paymentNo,
      notify_url: config.notifyUrl,
      amount: { total: input.amountCents, currency: "CNY" },
      time_expire: input.expiresAt.toISOString(),
    };
    const response = await requestWechat(
      config,
      "POST",
      "/v3/pay/transactions/native",
      body,
    );
    const codeUrl = readRequiredString(response, "code_url", "WeChat Pay");
    // Native pay only returns code_url; transaction_id is received via webhook/query
    return { providerTradeNo: null, paymentUrl: codeUrl };
  }

  async queryPayment(
    input: ProviderPaymentQueryInput,
  ): Promise<ProviderPaymentQueryResult> {
    const config = parseWeChatPayConfig(input.config);
    const data = await requestWechat(
      config,
      "GET",
      `/v3/pay/transactions/out-trade-no/${input.paymentNo}?mchid=${config.mchId}`,
    );
    return mapWeChatTradeState(data);
  }

  async cancelPayment(
    input: ProviderCancelPaymentInput,
  ): Promise<ProviderCancelPaymentResult> {
    const config = parseWeChatPayConfig(input.config);
    await requestWechat(
      config,
      "POST",
      `/v3/pay/transactions/out-trade-no/${input.paymentNo}/close`,
      { mchid: config.mchId },
    );
    return {
      status: "canceled",
      rawPayload: { provider: this.code, paymentNo: input.paymentNo },
    };
  }

  async refundPayment(
    input: ProviderRefundPaymentInput,
  ): Promise<ProviderRefundPaymentResult> {
    const config = parseWeChatPayConfig(input.config);
    const data = await requestWechat(
      config,
      "POST",
      "/v3/refund/domestic/refunds",
      {
        out_trade_no: input.paymentNo,
        out_refund_no: input.refundNo,
        reason: input.reason,
        amount: {
          refund: input.amountCents,
          total: input.amountCents,
          currency: "CNY",
        },
      },
    );
    return mapWeChatRefund(data, input.refundNo);
  }

  async queryRefund(
    input: ProviderRefundQueryInput,
  ): Promise<ProviderRefundQueryResult> {
    const config = parseWeChatPayConfig(input.config);
    const data = await requestWechat(
      config,
      "GET",
      `/v3/refund/domestic/refunds/${input.refundNo}`,
    );
    const status =
      typeof data["status"] === "string" ? data["status"] : "PROCESSING";
    const providerRefundNo =
      typeof data["refund_id"] === "string"
        ? data["refund_id"]
        : input.providerRefundNo;
    return {
      providerRefundNo,
      status:
        status === "SUCCESS"
          ? "succeeded"
          : status === "ABNORMAL" || status === "CLOSED"
            ? "failed"
            : "processing",
      refundedAt:
        status === "SUCCESS"
          ? typeof data["success_time"] === "string"
            ? new Date(data["success_time"])
            : new Date()
          : null,
      rawPayload: data,
    };
  }

  async handleWebhook(
    input: ProviderWebhookInput,
  ): Promise<ProviderWebhookResult> {
    let lastError: unknown;
    const configs =
      input.candidateConfigs.length > 0
        ? input.candidateConfigs
        : [
            {
              providerCode: this.code,
              merchantNo: null,
              appId: null,
              publicConfigJson: {},
              sensitiveConfigJson: {},
            },
          ];
    for (const candidateConfig of configs) {
      try {
        const config = parseWeChatPayConfig(candidateConfig);
        verifyWeChatHeaders(input.headers, input.rawBodyText, config);
        const decrypted = decryptWeChatResource(
          input.body as Record<string, unknown>,
          config.apiV3Key,
        );
        return mapWeChatWebhook(
          decrypted,
          input.body as Record<string, unknown>,
          candidateConfig.id,
        );
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error &&
      lastError.constructor.name !== "Error" &&
      lastError.constructor.name.includes("Exception")
      ? lastError
      : new UnauthorizedException(
          lastError instanceof Error
            ? lastError.message
            : "WeChat Pay webhook signature invalid",
        );
  }
}
