import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import {
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
  ProviderWebhookInput,
  ProviderWebhookResult,
} from "./payment-provider.interface";

type WeChatPayConfig = {
  mchId: string;
  appId: string;
  apiV3Key: string;
  privateKeyPem: string;
  certificateSerialNo: string;
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

  return {
    mchId: readRequiredString(source, "mchId", "WeChat Pay"),
    appId: readRequiredString(source, "appId", "WeChat Pay"),
    apiV3Key: readRequiredString(source, "apiV3Key", "WeChat Pay"),
    privateKeyPem: readRequiredString(source, "privateKeyPem", "WeChat Pay"),
    certificateSerialNo: readRequiredString(
      source,
      "certificateSerialNo",
      "WeChat Pay",
    ),
    platformPublicKeyPem: readRequiredString(
      source,
      "platformPublicKeyPem",
      "WeChat Pay",
    ),
    notifyUrl: readRequiredString(source, "notifyUrl", "WeChat Pay"),
  };
}

async function requestWechat(
  config: WeChatPayConfig,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<unknown> {
  const bodyText = body === undefined ? "" : JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomUUID().replaceAll("-", "");
  const signText = `${method}\n${path}\n${timestamp}\n${nonce}\n${bodyText}\n`;
  const signature = createSign("RSA-SHA256")
    .update(signText)
    .sign(config.privateKeyPem, "base64");
  const authorization = [
    `mchid="${config.mchId}"`,
    `nonce_str="${nonce}"`,
    `timestamp="${timestamp}"`,
    `serial_no="${config.certificateSerialNo}"`,
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
  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new BadGatewayException(
      `WeChat Pay request failed: ${response.status} ${errText.slice(0, 200)}`,
    );
  }
  // response.json() returns `any`; return as `unknown` for type-safe handling at call sites
  return response.json();
}

function mapWeChatTradeState(
  data: Record<string, unknown>,
): ProviderPaymentQueryResult {
  const tradeState =
    typeof data["trade_state"] === "string" ? data["trade_state"] : "NOTPAY";
  const statusByState: Record<string, ProviderPaymentQueryResult["status"]> = {
    SUCCESS: "succeeded",
    USERPAYING: "pending",
    NOTPAY: "pending",
    CLOSED: "canceled",
    REVOKED: "canceled",
    PAYERROR: "failed",
    REFUND: "succeeded",
  };
  return {
    status: statusByState[tradeState] ?? "pending",
    providerTradeNo:
      typeof data["transaction_id"] === "string"
        ? data["transaction_id"]
        : null,
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
  if (serial !== config.certificateSerialNo) {
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

function mapWeChatWebhook(
  decrypted: Record<string, unknown>,
  originalBody: Record<string, unknown>,
): ProviderWebhookResult {
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
  return {
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
    const rawResponse = await requestWechat(
      config,
      "POST",
      "/v3/pay/transactions/native",
      body,
    );
    const response = assertRecord(rawResponse);
    const codeUrl = readRequiredString(response, "code_url", "WeChat Pay");
    return { providerTradeNo: input.paymentNo, paymentUrl: codeUrl };
  }

  async queryPayment(
    input: ProviderPaymentQueryInput,
  ): Promise<ProviderPaymentQueryResult> {
    const config = parseWeChatPayConfig(input.config);
    const data = assertRecord(
      await requestWechat(
        config,
        "GET",
        `/v3/pay/transactions/out-trade-no/${input.paymentNo}?mchid=${config.mchId}`,
      ),
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
    const data = assertRecord(
      await requestWechat(
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
      ),
    );
    return mapWeChatRefund(data, input.refundNo);
  }

  async handleWebhook(
    input: ProviderWebhookInput,
  ): Promise<ProviderWebhookResult> {
    const body = assertRecord(input.body);
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
        const decrypted = decryptWeChatResource(body, config.apiV3Key);
        return mapWeChatWebhook(decrypted, body);
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
