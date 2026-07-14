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
import { Agent, request as httpsRequest } from "node:https";

import type {
  PaymentCodeCapableProvider,
  PaymentIntentInput,
  PaymentIntentResult,
  PaymentProviderRuntimeConfig,
  ProviderCancelPaymentInput,
  ProviderCancelPaymentResult,
  ProviderPaymentCodeChargeInput,
  ProviderPaymentCodeChargeResult,
  ProviderPaymentCodeQueryInput,
  ProviderPaymentCodeQueryResult,
  ProviderPaymentQueryInput,
  ProviderPaymentQueryResult,
  ProviderPaymentCodeReverseInput,
  ProviderPaymentCodeReverseResult,
  ProviderRefundPaymentInput,
  ProviderRefundPaymentResult,
  ProviderRefundQueryInput,
  ProviderRefundQueryResult,
  ProviderRefundWebhookResult,
  ProviderWebhookInput,
  ProviderWebhookResult,
} from "./payment-provider.interface";

import {
  buildWechatV2ClientAgent,
  createNonceStr,
  parseWechatXml,
  signWechatV2,
  toWechatXml,
  verifyWechatV2Sign,
  type WeChatV2Payload,
} from "./wechat-pay-v2.util";

type WeChatPayConfig = {
  mchId: string;
  appId: string;
  apiV3Key: string;
  apiV2Key: string | null;
  privateKeyPem: string;
  /** 商户 API 证书序列号，用于 Authorization serial_no 请求签名 */
  merchantCertificateSerialNo: string;
  /** 微信支付平台证书/公钥序列号，用于匹配 wechatpay-serial 响应/回调头 */
  platformCertificateSerialNo: string;
  /** 微信支付平台公钥 PEM，用于验签（可从 platformCertificatePem 提取） */
  platformPublicKeyPem: string;
  merchantApiCertPem: string | null;
  merchantApiKeyPem: string | null;
  paymentCodeSignType: "MD5" | "HMAC-SHA256";
  paymentCodeDeviceInfo: string | null;
  notifyUrl: string;
  /** Bounded below the payment-creation lease heartbeat (30 seconds). */
  requestTimeoutMs: number;
};

const DEFAULT_WECHAT_REQUEST_TIMEOUT_MS = 15_000;
const MAX_WECHAT_REQUEST_TIMEOUT_MS = 20_000;

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

function readRequestTimeoutMs(source: Record<string, unknown>): number {
  const value = source["requestTimeoutMs"];
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return DEFAULT_WECHAT_REQUEST_TIMEOUT_MS;
  }
  return Math.min(value, MAX_WECHAT_REQUEST_TIMEOUT_MS);
}

/**
 * 从证书 PEM 中提取 SPKI 格式公钥 PEM，供 RSA 验签使用。
 */
function extractPublicKeyFromCertificatePem(certPem: string): string {
  const cert = new X509Certificate(certPem);
  return cert.publicKey.export({ type: "spki", format: "pem" });
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
    apiV2Key:
      typeof source["apiV2Key"] === "string" &&
      source["apiV2Key"].trim().length > 0
        ? source["apiV2Key"].trim()
        : null,
    privateKeyPem: readRequiredString(source, "privateKeyPem", "WeChat Pay"),
    merchantCertificateSerialNo,
    platformCertificateSerialNo,
    platformPublicKeyPem,
    merchantApiCertPem:
      typeof source["merchantApiCertPem"] === "string" &&
      source["merchantApiCertPem"].trim().length > 0
        ? source["merchantApiCertPem"].trim()
        : null,
    merchantApiKeyPem:
      typeof source["merchantApiKeyPem"] === "string" &&
      source["merchantApiKeyPem"].trim().length > 0
        ? source["merchantApiKeyPem"].trim()
        : null,
    paymentCodeSignType:
      source["paymentCodeSignType"] === "MD5" ? "MD5" : "HMAC-SHA256",
    paymentCodeDeviceInfo:
      typeof source["paymentCodeDeviceInfo"] === "string" &&
      source["paymentCodeDeviceInfo"].trim().length > 0
        ? source["paymentCodeDeviceInfo"].trim()
        : null,
    notifyUrl: readRequiredString(source, "notifyUrl", "WeChat Pay"),
    requestTimeoutMs: readRequestTimeoutMs(source),
  };
}

function parseWechatPayTime(value: string): Date | null {
  if (!/^\d{14}$/.test(value)) return null;
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(8, 10)}:${value.slice(10, 12)}:${value.slice(12, 14)}+08:00`;
  return new Date(iso);
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
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, config.requestTimeoutMs);
  let response: Response;
  try {
    response = await fetch(`https://api.mch.weixin.qq.com${path}`, {
      method,
      headers: {
        Accept: "application/json",
        Authorization: `WECHATPAY2-SHA256-RSA2048 ${authorization}`,
        "Content-Type": "application/json",
      },
      body: bodyText.length > 0 ? bodyText : undefined,
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new BadGatewayException(
        `WeChat Pay request timed out after ${config.requestTimeoutMs}ms`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
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

async function postWechatV2Xml(
  url: string,
  body: string,
  agent: Agent | undefined,
  timeoutMs: number,
): Promise<{ statusCode: number; text: string }> {
  return await new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = httpsRequest(
      target,
      {
        method: "POST",
        headers: {
          "content-type": "text/xml; charset=utf-8",
          "content-length": Buffer.byteLength(body),
        },
        agent,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer | string) =>
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
        );
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            text: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("timeout", () => {
      req.destroy(
        new Error(`WeChat Pay V2 request timed out after ${timeoutMs}ms`),
      );
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function requestWechatV2(
  url: string,
  payload: WeChatV2Payload,
  config: WeChatPayConfig,
  options: { certificate: boolean },
): Promise<Record<string, string>> {
  if (!config.apiV2Key) {
    throw new ConflictException(
      "wechat_pay apiV2Key is required for payment_code",
    );
  }
  const signedPayload = {
    ...payload,
    nonce_str: payload.nonce_str ?? createNonceStr(),
    sign_type: config.paymentCodeSignType,
  };
  const sign = signWechatV2(
    signedPayload,
    config.apiV2Key,
    config.paymentCodeSignType,
  );
  const body = toWechatXml({ ...signedPayload, sign });
  const agent = options.certificate
    ? buildWechatV2ClientAgent(
        config.merchantApiCertPem ?? "",
        config.merchantApiKeyPem ?? "",
      )
    : undefined;
  const response = await postWechatV2Xml(
    url,
    body,
    agent,
    config.requestTimeoutMs,
  );
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new BadGatewayException(
      `WeChat Pay V2 request failed: ${response.statusCode}`,
    );
  }
  const data = parseWechatXml(response.text);
  const hasSign = typeof data.sign === "string" && data.sign.length > 0;
  if (
    hasSign &&
    !verifyWechatV2Sign(data, config.apiV2Key, config.paymentCodeSignType)
  ) {
    throw new BadGatewayException("WeChat Pay V2 response signature invalid");
  }
  if (!hasSign && data.return_code === "SUCCESS") {
    throw new BadGatewayException("WeChat Pay V2 response signature missing");
  }
  return data;
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
      ? // oxlint-disable-next-line no-unsafe-type-assertion -- narrowed by typeof+null+isArray checks above
        (originalBody["resource"] as Record<string, unknown>)
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
      ? // oxlint-disable-next-line no-unsafe-type-assertion -- narrowed by typeof+null+isArray checks above
        (decrypted["amount"] as Record<string, unknown>)
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
export class WeChatPayProvider implements PaymentCodeCapableProvider {
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

  async chargePaymentCode(
    input: ProviderPaymentCodeChargeInput,
  ): Promise<ProviderPaymentCodeChargeResult> {
    const config = parseWeChatPayConfig(input.config);
    const data = await requestWechatV2(
      "https://api.mch.weixin.qq.com/pay/micropay",
      {
        appid: input.config.appId,
        mch_id: input.config.merchantNo,
        device_info:
          config.paymentCodeDeviceInfo ?? input.terminalId ?? undefined,
        body: `VEM order ${input.orderNo}`,
        out_trade_no: input.paymentNo,
        total_fee: input.amountCents,
        fee_type: "CNY",
        spbill_create_ip: input.clientIp ?? "127.0.0.1",
        auth_code: input.authCode,
      },
      config,
      { certificate: false },
    );
    if (
      data.return_code === "SUCCESS" &&
      data.result_code === "SUCCESS" &&
      data.trade_type === "MICROPAY"
    ) {
      return {
        status: "succeeded",
        providerTradeNo: data.transaction_id ?? null,
        paidAt: data.time_end ? parseWechatPayTime(data.time_end) : null,
        providerStatus: "SUCCESS",
        rawPayload: data,
      };
    }
    const errCode =
      data.err_code ??
      data.return_code ??
      data.result_code ??
      "WECHAT_MICROPAY_FAILED";
    if (["USERPAYING"].includes(errCode)) {
      return {
        status: "user_confirming",
        providerTradeNo: data.transaction_id ?? null,
        providerStatus: errCode,
        failureCode: errCode,
        failureMessage: data.err_code_des ?? "用户支付中",
        rawPayload: data,
      };
    }
    if (["SYSTEMERROR", "BANKERROR"].includes(errCode)) {
      return {
        status: "unknown",
        providerTradeNo: data.transaction_id ?? null,
        providerStatus: errCode,
        failureCode: errCode,
        failureMessage: data.err_code_des ?? "微信支付结果未知",
        rawPayload: data,
      };
    }
    return {
      status: "failed",
      providerTradeNo: data.transaction_id ?? null,
      providerStatus: errCode,
      failureCode: errCode,
      failureMessage: data.err_code_des ?? "微信付款码支付失败",
      rawPayload: data,
    };
  }

  async queryPaymentCode(
    input: ProviderPaymentCodeQueryInput,
  ): Promise<ProviderPaymentCodeQueryResult> {
    const config = parseWeChatPayConfig(input.config);
    const data = await requestWechatV2(
      "https://api.mch.weixin.qq.com/pay/orderquery",
      {
        appid: input.config.appId,
        mch_id: input.config.merchantNo,
        transaction_id: input.providerTradeNo ?? undefined,
        out_trade_no: input.paymentNo,
      },
      config,
      { certificate: false },
    );
    if (data.return_code !== "SUCCESS" || data.result_code !== "SUCCESS") {
      const errCode =
        data.err_code ??
        data.return_code ??
        data.result_code ??
        "WECHAT_ORDERQUERY_FAILED";
      return {
        status: errCode === "SYSTEMERROR" ? "unknown" : "failed",
        providerTradeNo: data.transaction_id ?? input.providerTradeNo,
        providerStatus: errCode,
        failureCode: errCode,
        failureMessage: data.err_code_des ?? null,
        rawPayload: data,
      };
    }
    const tradeState = data.trade_state ?? "NOTPAY";
    if (tradeState === "SUCCESS") {
      return {
        status: "succeeded",
        providerTradeNo: data.transaction_id ?? input.providerTradeNo,
        paidAt: data.time_end ? parseWechatPayTime(data.time_end) : null,
        providerStatus: tradeState,
        rawPayload: data,
      };
    }
    if (tradeState === "USERPAYING") {
      return {
        status: "user_confirming",
        providerTradeNo: data.transaction_id ?? input.providerTradeNo,
        providerStatus: tradeState,
        rawPayload: data,
      };
    }
    if (tradeState === "REVOKED" || tradeState === "CLOSED") {
      return {
        status: "reversed",
        providerTradeNo: data.transaction_id ?? input.providerTradeNo,
        providerStatus: tradeState,
        rawPayload: data,
      };
    }
    return {
      status: tradeState === "PAYERROR" ? "failed" : "processing",
      providerTradeNo: data.transaction_id ?? input.providerTradeNo,
      providerStatus: tradeState,
      failureCode: tradeState === "PAYERROR" ? tradeState : null,
      failureMessage: data.trade_state_desc ?? null,
      rawPayload: data,
    };
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

  async reversePaymentCode(
    input: ProviderPaymentCodeReverseInput,
  ): Promise<ProviderPaymentCodeReverseResult> {
    const config = parseWeChatPayConfig(input.config);
    if (!config.merchantApiCertPem || !config.merchantApiKeyPem) {
      throw new ConflictException(
        "wechat_pay merchant API certificate is required for reverse",
      );
    }
    const data = await requestWechatV2(
      "https://api.mch.weixin.qq.com/secapi/pay/reverse",
      {
        appid: input.config.appId,
        mch_id: input.config.merchantNo,
        transaction_id: input.providerTradeNo ?? undefined,
        out_trade_no: input.paymentNo,
      },
      config,
      { certificate: true },
    );
    if (data.return_code === "SUCCESS" && data.result_code === "SUCCESS") {
      return {
        status: data.recall === "Y" ? "processing" : "reversed",
        recall: data.recall === "Y",
        providerStatus: "SUCCESS",
        rawPayload: data,
      };
    }
    const errCode =
      data.err_code ??
      data.return_code ??
      data.result_code ??
      "WECHAT_REVERSE_FAILED";
    if (errCode === "USERPAYING" || errCode === "SYSTEMERROR") {
      return {
        status: "unknown",
        recall: true,
        providerStatus: errCode,
        failureCode: errCode,
        failureMessage: data.err_code_des ?? null,
        rawPayload: data,
      };
    }
    return {
      status: "failed",
      recall: false,
      providerStatus: errCode,
      failureCode: errCode,
      failureMessage: data.err_code_des ?? null,
      rawPayload: data,
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
          total: input.totalAmountCents ?? input.amountCents,
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
          // oxlint-disable-next-line no-unsafe-type-assertion
          input.body as Record<string, unknown>,
          config.apiV3Key,
        );
        return mapWeChatWebhook(
          decrypted,
          // oxlint-disable-next-line no-unsafe-type-assertion
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
