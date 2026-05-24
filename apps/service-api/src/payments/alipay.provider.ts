import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";

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

function mapAlipayPaymentCodeResponse(
  data: Record<string, unknown>,
): ProviderPaymentCodeChargeResult {
  const code = typeof data["code"] === "string" ? data["code"] : null;
  const subCode =
    typeof data["sub_code"] === "string" ? data["sub_code"] : null;
  const tradeNo =
    typeof data["trade_no"] === "string" ? data["trade_no"] : null;
  const gmtPayment =
    typeof data["gmt_payment"] === "string"
      ? new Date(data["gmt_payment"].replace(" ", "T"))
      : null;
  // v3 API: success response has no "code" field but contains trade_no + gmt_payment
  if (!code && tradeNo && gmtPayment) {
    return {
      status: "succeeded",
      providerTradeNo: tradeNo,
      paidAt: gmtPayment,
      providerStatus: "TRADE_SUCCESS",
      rawPayload: data,
    };
  }
  // v2 API compat
  if (code === "10000") {
    return {
      status: "succeeded",
      providerTradeNo: tradeNo,
      paidAt: gmtPayment,
      providerStatus: "TRADE_SUCCESS",
      rawPayload: data,
    };
  }
  if (code === "10003") {
    return {
      status: "user_confirming",
      providerTradeNo: tradeNo,
      providerStatus: "WAIT_BUYER_PAY",
      failureCode: subCode,
      failureMessage:
        typeof data["sub_msg"] === "string"
          ? data["sub_msg"]
          : "等待用户确认支付",
      rawPayload: data,
    };
  }
  if (code === "20000" || subCode === "ACQ.SYSTEM_ERROR") {
    return {
      status: "unknown",
      providerTradeNo: tradeNo,
      providerStatus: code ?? subCode,
      failureCode: subCode ?? code ?? "ALIPAY_UNKNOWN",
      failureMessage:
        typeof data["sub_msg"] === "string"
          ? data["sub_msg"]
          : "支付宝返回未知结果",
      rawPayload: data,
    };
  }
  return {
    status: "failed",
    providerTradeNo: tradeNo,
    providerStatus: code ?? subCode,
    failureCode: subCode ?? code ?? "ALIPAY_PAYMENT_CODE_FAILED",
    failureMessage:
      typeof data["sub_msg"] === "string"
        ? data["sub_msg"]
        : "支付宝付款码支付失败",
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

function mapAlipayRefundWebhook(
  body: Record<string, string>,
): ProviderRefundWebhookResult {
  const refundNo = body["out_biz_no"] || body["out_request_no"] || null;
  const refundStatus =
    body["refund_status"] === "REFUND_FAIL"
      ? "failed"
      : body["refund_status"] === "REFUND_PROCESSING"
        ? "processing"
        : "succeeded";
  return {
    eventKind: "refund",
    providerEventId:
      body["notify_id"] ||
      `${refundNo ?? body["trade_no"]}:refund:${refundStatus}`,
    eventType: "alipay.refund.webhook",
    refundNo,
    paymentNo: body["out_trade_no"] || null,
    providerRefundNo: body["trade_no"] || null,
    refundStatus,
    signatureValid: true,
    rawPayload: body,
  };
}

function mapAlipayWebhook(body: Record<string, string>): ProviderWebhookResult {
  // Detect refund notifications by refund-specific fields
  if (body["refund_fee"] || body["out_biz_no"] || body["out_request_no"]) {
    return mapAlipayRefundWebhook(body);
  }
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
export class AlipayProvider implements PaymentCodeCapableProvider {
  readonly code = "alipay";
  private readonly logger = new Logger(AlipayProvider.name);

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

  async chargePaymentCode(
    input: ProviderPaymentCodeChargeInput,
  ): Promise<ProviderPaymentCodeChargeResult> {
    const config = parseAlipayConfig(input.config);
    const sdk = createAlipaySdk(this.sdkFactory, config);
    const body: Record<string, unknown> = {
      notify_url: config.notifyUrl,
      out_trade_no: input.paymentNo,
      total_amount: amountCentsToYuan(input.amountCents),
      subject: `VEM order ${input.orderNo}`,
      auth_code: input.authCode,
      scene: "bar_code",
      product_code: "FACE_TO_FACE_PAYMENT",
      seller_id: config.sellerId,
      store_id: input.storeId ?? undefined,
      terminal_id: input.terminalId ?? undefined,
      query_options: ["fund_bill_list"],
    };
    try {
      const data = assertSuccessfulCurl(
        await sdk.curl<Record<string, unknown>>(
          "POST",
          "/v3/alipay/trade/pay",
          {
            body,
          },
        ),
        "alipay.trade.pay",
      );
      return mapAlipayPaymentCodeResponse(data);
    } catch (err) {
      const errCode =
        err && typeof err === "object" && "code" in err
          ? String((err as Record<string, unknown>).code)
          : null;
      const errStatus =
        err && typeof err === "object" && "responseHttpStatus" in err
          ? String((err as Record<string, unknown>).responseHttpStatus)
          : "?";
      const errMessage =
        err instanceof Error
          ? err.message
          : err && typeof err === "object"
            ? JSON.stringify(err)
            : typeof err === "string"
              ? err
              : typeof err === "number" || typeof err === "boolean"
                ? `${err}`
                : "unknown_error";
      this.logger.error(
        `chargePaymentCode Alipay error code=${errCode} responseHttpStatus=${errStatus} message=${errMessage}`,
      );
      // ACQ.USER_PAYING: user is authenticating in Alipay app — treat as user_confirming (poll)
      if (errCode === "ACQ.USER_PAYING") {
        return {
          status: "user_confirming",
          providerTradeNo: null,
          providerStatus: "ACQ.USER_PAYING",
          rawPayload: {},
        };
      }
      throw err;
    }
  }

  async queryPaymentCode(
    input: ProviderPaymentCodeQueryInput,
  ): Promise<ProviderPaymentCodeQueryResult> {
    const result = await this.queryPayment(input);
    if (result.status === "succeeded") {
      return {
        status: "succeeded",
        providerTradeNo: result.providerTradeNo ?? null,
        paidAt: result.paidAt ?? null,
        providerStatus: "TRADE_SUCCESS",
        rawPayload: result.rawPayload,
      };
    }
    if (result.status === "pending" || result.status === "processing") {
      return {
        status: "processing",
        providerTradeNo: result.providerTradeNo ?? null,
        providerStatus: result.status,
        rawPayload: result.rawPayload,
      };
    }
    if (result.status === "canceled") {
      return {
        status: "reversed",
        providerTradeNo: result.providerTradeNo ?? null,
        providerStatus: "TRADE_CLOSED",
        rawPayload: result.rawPayload,
      };
    }
    return {
      status: "failed",
      providerTradeNo: result.providerTradeNo ?? null,
      providerStatus: result.status,
      failureMessage: result.failedReason ?? "支付宝付款码支付失败",
      rawPayload: result.rawPayload,
    };
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

  async reversePaymentCode(
    input: ProviderPaymentCodeReverseInput,
  ): Promise<ProviderPaymentCodeReverseResult> {
    const config = parseAlipayConfig(input.config);
    const sdk = createAlipaySdk(this.sdkFactory, config);
    const data = assertSuccessfulCurl(
      await sdk.curl<Record<string, unknown>>(
        "POST",
        "/v3/alipay/trade/cancel",
        {
          body: {
            out_trade_no: input.paymentNo,
            ...(input.providerTradeNo
              ? { trade_no: input.providerTradeNo }
              : {}),
          },
        },
      ),
      "alipay.trade.cancel",
    );
    const retryFlag = data["retry_flag"];
    const code = data["code"];
    if (code === "10000") {
      return {
        status: retryFlag === "Y" ? "processing" : "reversed",
        providerStatus:
          typeof data["action"] === "string" ? data["action"] : "cancel",
        recall: retryFlag === "Y",
        rawPayload: data,
      };
    }
    return {
      status: code === "20000" ? "unknown" : "failed",
      providerStatus: typeof code === "string" ? code : null,
      failureCode:
        typeof data["sub_code"] === "string" ? data["sub_code"] : null,
      failureMessage:
        typeof data["sub_msg"] === "string" ? data["sub_msg"] : null,
      rawPayload: data,
    };
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
      typeof data["refund_status"] === "string" ? data["refund_status"] : null;
    const providerRefundNo =
      typeof data["out_request_no"] === "string"
        ? data["out_request_no"]
        : input.providerRefundNo;
    return {
      providerRefundNo,
      status:
        refundStatus === "REFUND_SUCCESS"
          ? "succeeded"
          : refundStatus === "REFUND_FAIL"
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
