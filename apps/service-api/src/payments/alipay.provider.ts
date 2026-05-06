import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { createSign, createVerify } from "node:crypto";

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

type AlipayConfig = {
  appId: string;
  privateKeyPem: string;
  alipayPublicKeyPem: string;
  notifyUrl: string;
  gatewayUrl: string;
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

function parseAlipayConfig(input: PaymentProviderRuntimeConfig): AlipayConfig {
  const source: Record<string, unknown> = {
    ...input.publicConfigJson,
    ...input.sensitiveConfigJson,
  };
  if (input.appId) source["appId"] ??= input.appId;

  return {
    appId: readRequiredString(source, "appId", "Alipay"),
    privateKeyPem: readRequiredString(source, "privateKeyPem", "Alipay"),
    alipayPublicKeyPem: readRequiredString(
      source,
      "alipayPublicKeyPem",
      "Alipay",
    ),
    notifyUrl: readRequiredString(source, "notifyUrl", "Alipay"),
    gatewayUrl:
      typeof source["gatewayUrl"] === "string" &&
      source["gatewayUrl"].length > 0
        ? source["gatewayUrl"]
        : "https://openapi.alipay.com/gateway.do",
  };
}

function signAlipayParams(
  params: Record<string, string>,
  privateKeyPem: string,
): string {
  const content = Object.keys(params)
    .filter((key) => key !== "sign" && key !== "sign_type")
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&");
  return createSign("RSA-SHA256")
    .update(content, "utf8")
    .sign(privateKeyPem, "base64");
}

async function callAlipay(
  config: AlipayConfig,
  method: string,
  bizContent: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);
  const params: Record<string, string> = {
    app_id: config.appId,
    method,
    charset: "utf-8",
    sign_type: "RSA2",
    timestamp,
    version: "1.0",
    notify_url: config.notifyUrl,
    biz_content: JSON.stringify(bizContent),
  };
  params["sign"] = signAlipayParams(params, config.privateKeyPem);
  const response = await fetch(config.gatewayUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
    },
    body: new URLSearchParams(params),
  });
  if (!response.ok) {
    throw new BadGatewayException(`Alipay request failed: ${response.status}`);
  }
  const rawData: unknown = await response.json();
  if (typeof rawData !== "object" || rawData === null || Array.isArray(rawData)) {
    throw new BadGatewayException("Alipay returned non-object response");
  }
  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rawData)) {
    data[k] = v;
  }
  const responseKey = `${method.replaceAll(".", "_")}_response`;
  const result = data[responseKey];
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new BadGatewayException(`Alipay response missing ${responseKey}`);
  }
  const resultRecord: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(result)) {
    resultRecord[k] = v;
  }
  return resultRecord;
}

function readString(data: Record<string, unknown>, key: string): string {
  const value = data[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new BadGatewayException(`Alipay response missing ${key}`);
  }
  return value;
}

function mapAlipayTradeStatus(
  data: Record<string, unknown>,
): ProviderPaymentQueryResult {
  const tradeStatus =
    typeof data["trade_status"] === "string"
      ? data["trade_status"]
      : "WAIT_BUYER_PAY";
  const statusByTradeStatus: Record<
    string,
    ProviderPaymentQueryResult["status"]
  > = {
    WAIT_BUYER_PAY: "pending",
    TRADE_SUCCESS: "succeeded",
    TRADE_FINISHED: "succeeded",
    TRADE_CLOSED: "canceled",
  };
  return {
    status: statusByTradeStatus[tradeStatus] ?? "pending",
    providerTradeNo:
      typeof data["trade_no"] === "string" ? data["trade_no"] : null,
    rawPayload: data,
  };
}

function selectAlipayConfig(
  configs: PaymentProviderRuntimeConfig[],
  body: Record<string, string>,
): AlipayConfig {
  const appId = body["app_id"] ?? null;
  const parsed = configs.map(parseAlipayConfig);
  const selected =
    (appId ? parsed.find((config) => config.appId === appId) : null) ??
    parsed[0];
  if (!selected) {
    throw new UnauthorizedException("Alipay config not found for webhook");
  }
  return selected;
}

function assertAlipayBody(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BadRequestException("Alipay webhook body must be an object");
  }
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (Array.isArray(item)) {
      const first = item[0];
      result[key] = typeof first === "string" ? first : String(first ?? "");
    } else {
      result[key] = typeof item === "string" ? item : "";
    }
  }
  return result;
}

function verifyAlipayRsa2(
  body: Record<string, string>,
  alipayPublicKeyPem: string,
): void {
  const signature = body["sign"];
  if (!signature) {
    throw new UnauthorizedException("Alipay signature missing");
  }
  const content = Object.keys(body)
    .filter((key) => key !== "sign" && key !== "sign_type")
    .sort()
    .map((key) => `${key}=${body[key]}`)
    .join("&");
  const valid = createVerify("RSA-SHA256")
    .update(content, "utf8")
    .verify(alipayPublicKeyPem, signature, "base64");
  if (!valid) {
    throw new UnauthorizedException("Alipay signature invalid");
  }
}

function mapAlipayWebhook(body: Record<string, string>): ProviderWebhookResult {
  const queryResult = mapAlipayTradeStatus({
    trade_status: body["trade_status"],
    trade_no: body["trade_no"],
  });
  return {
    providerEventId:
      body["notify_id"] || `${body["out_trade_no"]}:${body["trade_status"]}`,
    eventType: "alipay.webhook",
    paymentNo: body["out_trade_no"] || null,
    providerTradeNo: body["trade_no"] || null,
    paymentStatus: queryResult.status,
    signatureValid: true,
    rawPayload: body,
  };
}

function mapAlipayRefund(
  data: Record<string, unknown>,
  fallbackRefundNo: string,
): ProviderRefundPaymentResult {
  return {
    providerRefundNo:
      typeof data["out_request_no"] === "string"
        ? data["out_request_no"]
        : fallbackRefundNo,
    status: data["fund_change"] === "N" ? "processing" : "succeeded",
    refundedAt: data["fund_change"] === "N" ? null : new Date(),
    rawPayload: data,
  };
}

@Injectable()
export class AlipayProvider implements PaymentProvider {
  readonly code = "alipay";

  async createPaymentIntent(
    input: PaymentIntentInput,
  ): Promise<PaymentIntentResult> {
    const config = parseAlipayConfig(input.config);
    const bizContent = {
      out_trade_no: input.paymentNo,
      total_amount: (input.amountCents / 100).toFixed(2),
      subject: `VEM order ${input.orderNo}`,
      timeout_express: "15m",
    };
    const data = await callAlipay(config, "alipay.trade.precreate", bizContent);
    const qrCode = readString(data, "qr_code");
    return { providerTradeNo: input.paymentNo, paymentUrl: qrCode };
  }

  async queryPayment(
    input: ProviderPaymentQueryInput,
  ): Promise<ProviderPaymentQueryResult> {
    const config = parseAlipayConfig(input.config);
    const data = await callAlipay(config, "alipay.trade.query", {
      out_trade_no: input.paymentNo,
    });
    return mapAlipayTradeStatus(data);
  }

  async cancelPayment(
    input: ProviderCancelPaymentInput,
  ): Promise<ProviderCancelPaymentResult> {
    const config = parseAlipayConfig(input.config);
    const data = await callAlipay(config, "alipay.trade.close", {
      out_trade_no: input.paymentNo,
    });
    return { status: "canceled", rawPayload: data };
  }

  async refundPayment(
    input: ProviderRefundPaymentInput,
  ): Promise<ProviderRefundPaymentResult> {
    const config = parseAlipayConfig(input.config);
    const data = await callAlipay(config, "alipay.trade.refund", {
      out_trade_no: input.paymentNo,
      out_request_no: input.refundNo,
      refund_amount: (input.amountCents / 100).toFixed(2),
      refund_reason: input.reason,
    });
    return mapAlipayRefund(data, input.refundNo);
  }

  async handleWebhook(
    input: ProviderWebhookInput,
  ): Promise<ProviderWebhookResult> {
    const body = assertAlipayBody(input.body);
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
    const config = selectAlipayConfig(configs, body);
    verifyAlipayRsa2(body, config.alipayPublicKeyPem);
    return mapAlipayWebhook(body);
  }
}
