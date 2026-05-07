import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";

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
  ProviderWebhookInput,
  ProviderWebhookResult,
} from "./payment-provider.interface";

import {
  AlipaySdkClientFactory,
  type AlipayCurlResult,
  type AlipaySdkLike,
} from "./alipay-sdk.client";

type AlipayKeyType = "PKCS8" | "PKCS1";

type AlipayConfig = {
  appId: string;
  sellerId: string;
  privateKeyPem: string;
  appCertPem: string;
  alipayPublicCertPem: string;
  alipayRootCertPem: string;
  notifyUrl: string;
  endpoint: string;
  keyType: AlipayKeyType;
  qrExpiresMinutes: number;
  timeoutCompensationSeconds: number;
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

function readPositiveInteger(
  source: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  const value = source[key];
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

function normalizeEndpoint(gatewayUrl: string): string {
  const url = new URL(gatewayUrl);
  if (url.pathname.endsWith("/gateway.do")) {
    url.pathname = url.pathname.replace(/\/gateway\.do$/, "");
  }
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function parseAlipayConfig(input: PaymentProviderRuntimeConfig): AlipayConfig {
  const source: Record<string, unknown> = {
    ...input.publicConfigJson,
    ...input.sensitiveConfigJson,
  };
  if (input.appId) source["appId"] ??= input.appId;
  if (input.merchantNo) source["sellerId"] ??= input.merchantNo;

  const gatewayUrl =
    typeof source["gatewayUrl"] === "string" && source["gatewayUrl"].length > 0
      ? source["gatewayUrl"]
      : "https://openapi.alipay.com/gateway.do";
  const keyType = source["keyType"] === "PKCS1" ? "PKCS1" : "PKCS8";

  return {
    appId: readRequiredString(source, "appId", "Alipay"),
    sellerId: readRequiredString(source, "sellerId", "Alipay"),
    privateKeyPem: readRequiredString(source, "privateKeyPem", "Alipay"),
    appCertPem: readRequiredString(source, "appCertPem", "Alipay"),
    alipayPublicCertPem: readRequiredString(
      source,
      "alipayPublicCertPem",
      "Alipay",
    ),
    alipayRootCertPem: readRequiredString(
      source,
      "alipayRootCertPem",
      "Alipay",
    ),
    notifyUrl: readRequiredString(source, "notifyUrl", "Alipay"),
    endpoint: normalizeEndpoint(gatewayUrl),
    keyType,
    qrExpiresMinutes: readPositiveInteger(source, "qrExpiresMinutes", 15),
    timeoutCompensationSeconds: readPositiveInteger(
      source,
      "timeoutCompensationSeconds",
      120,
    ),
  };
}

function createAlipaySdk(
  factory: AlipaySdkClientFactory,
  config: AlipayConfig,
): AlipaySdkLike {
  return factory.create({
    appId: config.appId,
    privateKey: config.privateKeyPem,
    keyType: config.keyType,
    endpoint: config.endpoint,
    camelcase: false,
    appCertContent: config.appCertPem,
    alipayPublicCertContent: config.alipayPublicCertPem,
    alipayRootCertContent: config.alipayRootCertPem,
  });
}

type AlipayTradeData = Record<string, unknown> & {
  qr_code?: string;
  trade_status?: string;
  trade_no?: string;
  out_trade_no?: string;
};

function readString(data: Record<string, unknown>, key: string): string {
  const value = data[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new BadGatewayException(`Alipay response missing ${key}`);
  }
  return value;
}

function assertSuccessfulCurl<T extends Record<string, unknown>>(
  result: AlipayCurlResult<T>,
  apiName: string,
): T {
  if (result.responseHttpStatus < 200 || result.responseHttpStatus >= 300) {
    throw new BadGatewayException(
      `Alipay ${apiName} failed: HTTP ${result.responseHttpStatus}`,
    );
  }
  return result.data;
}

function amountCentsToYuan(amountCents: number): string {
  return (amountCents / 100).toFixed(2);
}

function timeoutExpress(expiresAt: Date): string {
  const remainingMs = expiresAt.getTime() - Date.now();
  const minutes = Math.max(1, Math.ceil(remainingMs / 60_000));
  return `${minutes}m`;
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

function mapAlipayRefund(
  data: Record<string, unknown>,
  fallbackRefundNo: string,
): ProviderRefundPaymentResult {
  const fundChange =
    typeof data["fund_change"] === "string" ? data["fund_change"] : null;
  const succeeded = fundChange === "Y";
  return {
    providerRefundNo:
      typeof data["out_request_no"] === "string"
        ? data["out_request_no"]
        : fallbackRefundNo,
    status: succeeded ? "succeeded" : "processing",
    refundedAt: succeeded ? new Date() : null,
    rawPayload: data,
  };
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
      result[key] = typeof item === "string" ? item : String(item ?? "");
    }
  }
  return result;
}

function selectAlipayConfig(
  configs: PaymentProviderRuntimeConfig[],
  body: Record<string, string>,
): AlipayConfig {
  const parsed = configs.map(parseAlipayConfig);
  const appId = body["app_id"] ?? null;
  const selected =
    (appId ? parsed.find((config) => config.appId === appId) : null) ??
    parsed[0];
  if (!selected) {
    throw new UnauthorizedException("Alipay config not found for webhook");
  }
  return selected;
}

function mapAlipayWebhook(body: Record<string, string>): ProviderWebhookResult {
  const queryResult = mapAlipayTradeStatus({
    trade_status: body["trade_status"],
    trade_no: body["trade_no"],
  });
  return {
    eventKind: "payment",
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

@Injectable()
export class AlipayProvider implements PaymentProvider {
  readonly code = "alipay";

  constructor(private readonly sdkFactory: AlipaySdkClientFactory) {}

  async createPaymentIntent(
    input: PaymentIntentInput,
  ): Promise<PaymentIntentResult> {
    const config = parseAlipayConfig(input.config);
    const sdk = createAlipaySdk(this.sdkFactory, config);
    const data = assertSuccessfulCurl(
      await sdk.curl<AlipayTradeData>("POST", "/v3/alipay/trade/precreate", {
        body: {
          notify_url: config.notifyUrl,
          out_trade_no: input.paymentNo,
          total_amount: amountCentsToYuan(input.amountCents),
          subject: `VEM order ${input.orderNo}`,
          product_code: "QR_CODE_OFFLINE",
          seller_id: config.sellerId,
          timeout_express: timeoutExpress(input.expiresAt),
        },
      }),
      "alipay.trade.precreate",
    );
    return {
      providerTradeNo: null,
      paymentUrl: readString(data, "qr_code"),
    };
  }

  async queryPayment(
    input: ProviderPaymentQueryInput,
  ): Promise<ProviderPaymentQueryResult> {
    const config = parseAlipayConfig(input.config);
    const sdk = createAlipaySdk(this.sdkFactory, config);
    const body: Record<string, unknown> = { out_trade_no: input.paymentNo };
    if (input.providerTradeNo) body["trade_no"] = input.providerTradeNo;
    const data = assertSuccessfulCurl(
      await sdk.curl<AlipayTradeData>("POST", "/v3/alipay/trade/query", {
        body,
      }),
      "alipay.trade.query",
    );
    return mapAlipayTradeStatus(data);
  }

  async cancelPayment(
    input: ProviderCancelPaymentInput,
  ): Promise<ProviderCancelPaymentResult> {
    const config = parseAlipayConfig(input.config);
    const sdk = createAlipaySdk(this.sdkFactory, config);
    const body: Record<string, unknown> = { out_trade_no: input.paymentNo };
    if (input.providerTradeNo) body["trade_no"] = input.providerTradeNo;
    const data = assertSuccessfulCurl(
      await sdk.curl<Record<string, unknown>>(
        "POST",
        "/v3/alipay/trade/close",
        {
          body,
        },
      ),
      "alipay.trade.close",
    );
    return { status: "canceled", rawPayload: data };
  }

  async refundPayment(
    input: ProviderRefundPaymentInput,
  ): Promise<ProviderRefundPaymentResult> {
    const config = parseAlipayConfig(input.config);
    const sdk = createAlipaySdk(this.sdkFactory, config);
    const body: Record<string, unknown> = {
      out_trade_no: input.paymentNo,
      out_request_no: input.refundNo,
      refund_amount: amountCentsToYuan(input.amountCents),
      refund_reason: input.reason,
    };
    if (input.providerTradeNo) body["trade_no"] = input.providerTradeNo;
    const data = assertSuccessfulCurl(
      await sdk.curl<Record<string, unknown>>(
        "POST",
        "/v3/alipay/trade/refund",
        {
          body,
        },
      ),
      "alipay.trade.refund",
    );
    return mapAlipayRefund(data, input.refundNo);
  }

  async queryRefund(
    input: ProviderRefundQueryInput,
  ): Promise<ProviderRefundQueryResult> {
    const config = parseAlipayConfig(input.config);
    const sdk = createAlipaySdk(this.sdkFactory, config);
    const body: Record<string, unknown> = {
      out_trade_no: input.paymentNo,
      out_request_no: input.refundNo,
    };
    if (input.providerTradeNo) body["trade_no"] = input.providerTradeNo;
    const data = assertSuccessfulCurl(
      await sdk.curl<Record<string, unknown>>(
        "POST",
        "/v3/alipay/trade/fastpay/refund/query",
        { body },
      ),
      "alipay.trade.fastpay.refund.query",
    );
    const refundStatus =
      typeof data["refund_status"] === "string" ? data["refund_status"] : "";
    const providerRefundNo =
      typeof data["out_request_no"] === "string"
        ? data["out_request_no"]
        : input.providerRefundNo;
    return {
      providerRefundNo,
      status:
        refundStatus === "REFUND_SUCCESS"
          ? "succeeded"
          : refundStatus === "REFUND_FAIL" || refundStatus === ""
            ? "failed"
            : "processing",
      refundedAt: refundStatus === "REFUND_SUCCESS" ? new Date() : null,
      rawPayload: data,
    };
  }

  async handleWebhook(
    input: ProviderWebhookInput,
  ): Promise<ProviderWebhookResult> {
    const body = assertAlipayBody(input.body);
    const configs =
      input.candidateConfigs.length > 0 ? input.candidateConfigs : [];
    const config = selectAlipayConfig(configs, body);
    const sdk = createAlipaySdk(this.sdkFactory, config);
    if (!sdk.checkNotifySignV2(body)) {
      throw new UnauthorizedException("Alipay signature invalid");
    }
    return mapAlipayWebhook(body);
  }
}
