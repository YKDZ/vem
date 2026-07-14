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
  gatewayUrl: string;
  endpoint: string;
  keyType: AlipayKeyType;
  qrExpiresMinutes: number;
  requestTimeoutMs: number;
  timeoutCompensationSeconds: number;
  orderCodePrecreateMaxAttempts: number;
  orderCodePrecreateRetryDelayMs: number;
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
    gatewayUrl,
    endpoint: normalizeEndpoint(gatewayUrl),
    keyType,
    qrExpiresMinutes: readPositiveInteger(source, "qrExpiresMinutes", 15),
    requestTimeoutMs: readPositiveInteger(source, "requestTimeoutMs", 20_000),
    timeoutCompensationSeconds: readPositiveInteger(
      source,
      "timeoutCompensationSeconds",
      120,
    ),
    orderCodePrecreateMaxAttempts: readPositiveInteger(
      source,
      "orderCodePrecreateMaxAttempts",
      3,
    ),
    orderCodePrecreateRetryDelayMs: readPositiveInteger(
      source,
      "orderCodePrecreateRetryDelayMs",
      1_000,
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
    gateway: config.gatewayUrl,
    endpoint: config.endpoint,
    timeout: config.requestTimeoutMs,
    camelcase: false,
    appCertContent: config.appCertPem,
    alipayPublicCertContent: config.alipayPublicCertPem,
    alipayRootCertContent: config.alipayRootCertPem,
  });
}

type AlipayErrorProperties = {
  code?: unknown;
  responseHttpStatus?: unknown;
  status?: unknown;
};

function readAlipayErrorProperties(
  error: unknown,
): AlipayErrorProperties | null {
  if (!error || typeof error !== "object") return null;
  return error;
}

function parseAlipayDate(value: unknown): Date | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const normalized = value.includes("T") ? value : value.replace(" ", "T");
  const withTimezone = /(?:Z|[+-]\d{2}:\d{2})$/.test(normalized)
    ? normalized
    : `${normalized}+08:00`;
  const parsed = new Date(withTimezone);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

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

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mapAlipayTradeStatus(
  data: Record<string, unknown>,
): ProviderPaymentQueryResult {
  const code = typeof data["code"] === "string" ? data["code"] : null;
  const subCode =
    typeof data["sub_code"] === "string" ? data["sub_code"] : null;
  if (code && code !== "10000") {
    const indeterminate = code === "20000" || subCode === "ACQ.SYSTEM_ERROR";
    return {
      status:
        subCode === "ACQ.TRADE_NOT_EXIST"
          ? "pending"
          : indeterminate
            ? "processing"
            : "failed",
      providerTradeNo:
        typeof data["trade_no"] === "string" ? data["trade_no"] : null,
      failedReason: subCode ?? code,
      rawPayload: data,
    };
  }

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
    paidAt:
      parseAlipayDate(data["send_pay_date"] ?? data["gmt_payment"]) ??
      undefined,
    rawPayload: data,
  };
}

function assertSuccessfulPrecreate(
  data: Record<string, unknown>,
  paymentNo: string,
  amountCents: number,
): string {
  const code = typeof data["code"] === "string" ? data["code"] : null;
  if (code !== "10000") {
    const subCode =
      typeof data["sub_code"] === "string" ? data["sub_code"] : code;
    const subMsg =
      typeof data["sub_msg"] === "string"
        ? data["sub_msg"]
        : "支付宝预下单失败";
    throw new BadGatewayException(
      `Alipay alipay.trade.precreate failed: ${subCode ?? "UNKNOWN"} ${subMsg}`,
    );
  }

  const outTradeNo = readString(data, "out_trade_no");
  if (outTradeNo !== paymentNo) {
    throw new BadGatewayException(
      `Alipay alipay.trade.precreate out_trade_no mismatch: ${outTradeNo}`,
    );
  }

  const totalAmount = readString(data, "total_amount");
  if (totalAmount !== amountCentsToYuan(amountCents)) {
    throw new BadGatewayException(
      `Alipay alipay.trade.precreate total_amount mismatch: ${totalAmount}`,
    );
  }

  return readString(data, "qr_code");
}

function assertVerifiedSuccessfulAlipayQuery(
  data: Record<string, unknown>,
  input: ProviderPaymentQueryInput,
): ProviderPaymentQueryResult {
  const result = mapAlipayTradeStatus(data);
  if (result.status !== "succeeded") return result;

  const outTradeNo = readString(data, "out_trade_no");
  if (outTradeNo !== input.paymentNo) {
    throw new BadGatewayException(
      `Alipay alipay.trade.query out_trade_no mismatch: ${outTradeNo}`,
    );
  }

  const totalAmount = readString(data, "total_amount");
  if (totalAmount !== amountCentsToYuan(input.amountCents)) {
    throw new BadGatewayException(
      `Alipay alipay.trade.query total_amount mismatch: ${totalAmount}`,
    );
  }

  return result;
}

function isTradeNotExistResponse(data: Record<string, unknown>): boolean {
  return data["code"] === "40004" && data["sub_code"] === "ACQ.TRADE_NOT_EXIST";
}

function mapAlipayPaymentCodeResponse(
  data: Record<string, unknown>,
): ProviderPaymentCodeChargeResult {
  const code = typeof data["code"] === "string" ? data["code"] : null;
  const subCode =
    typeof data["sub_code"] === "string" ? data["sub_code"] : null;
  const tradeNo =
    typeof data["trade_no"] === "string" ? data["trade_no"] : null;
  const gmtPayment = parseAlipayDate(data["gmt_payment"]);
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

function mapAlipayPaymentCodeQueryResponse(
  data: Record<string, unknown>,
): ProviderPaymentCodeQueryResult {
  const code = typeof data["code"] === "string" ? data["code"] : null;
  const subCode =
    typeof data["sub_code"] === "string" ? data["sub_code"] : null;
  if (code === "10000") {
    const result = mapAlipayTradeStatus(data);
    if (result.status === "succeeded") {
      return {
        status: "succeeded",
        providerTradeNo: result.providerTradeNo ?? null,
        paidAt: result.paidAt ?? null,
        providerStatus:
          typeof data["trade_status"] === "string"
            ? data["trade_status"]
            : "TRADE_SUCCESS",
        rawPayload: data,
      };
    }
    if (result.status === "canceled") {
      return {
        status: "reversed",
        providerTradeNo: result.providerTradeNo ?? null,
        providerStatus: "TRADE_CLOSED",
        rawPayload: data,
      };
    }
    return {
      status: "processing",
      providerTradeNo: result.providerTradeNo ?? null,
      providerStatus:
        typeof data["trade_status"] === "string"
          ? data["trade_status"]
          : result.status,
      rawPayload: data,
    };
  }
  if (code === "20000" || subCode === "ACQ.SYSTEM_ERROR") {
    return {
      status: "unknown",
      providerTradeNo: null,
      providerStatus: code ?? subCode,
      failureCode: subCode ?? code ?? "ALIPAY_QUERY_UNKNOWN",
      failureMessage:
        typeof data["sub_msg"] === "string"
          ? data["sub_msg"]
          : "支付宝付款码查询结果未知",
      rawPayload: data,
    };
  }
  if (subCode === "ACQ.TRADE_NOT_EXIST") {
    return {
      status: "processing",
      providerTradeNo: null,
      providerStatus: subCode,
      failureCode: subCode,
      failureMessage:
        typeof data["sub_msg"] === "string"
          ? data["sub_msg"]
          : "支付宝交易暂不存在",
      rawPayload: data,
    };
  }
  return {
    status: "failed",
    providerTradeNo: null,
    providerStatus: code ?? subCode,
    failureCode: subCode ?? code ?? "ALIPAY_QUERY_FAILED",
    failureMessage:
      typeof data["sub_msg"] === "string"
        ? data["sub_msg"]
        : "支付宝付款码查询失败",
    rawPayload: data,
  };
}

function alipayErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") return JSON.stringify(error);
  if (
    typeof error === "string" ||
    typeof error === "number" ||
    typeof error === "boolean"
  ) {
    return `${error}`;
  }
  return "unknown_error";
}

function alipayErrorPropertyMessage(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return `${value}`;
  try {
    return JSON.stringify(value) ?? "unserializable_error_property";
  } catch {
    return "unserializable_error_property";
  }
}

function isIndeterminateAlipayError(error: unknown): boolean {
  const properties = readAlipayErrorProperties(error);
  const responseHttpStatus = properties?.responseHttpStatus;
  const statusValue = properties?.status;
  const status =
    typeof responseHttpStatus === "number"
      ? responseHttpStatus
      : typeof statusValue === "number"
        ? statusValue
        : null;
  const message = alipayErrorMessage(error).toLowerCase();
  return (
    (status !== null && status >= 500) ||
    message.includes("timeout") ||
    message.includes("504") ||
    message.includes("gateway time-out") ||
    message.includes("gateway timeout")
  );
}

const ALIPAY_PAYMENT_CHANNEL_UNAVAILABLE_MESSAGE =
  "支付宝支付通道暂不可用，请稍后重试";

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
    const request = {
      notify_url: config.notifyUrl,
      bizContent: {
        out_trade_no: input.paymentNo,
        total_amount: amountCentsToYuan(input.amountCents),
        subject: `VEM order ${input.orderNo}`,
        product_code: "QR_CODE_OFFLINE",
        seller_id: config.sellerId,
        timeout_express: timeoutExpress(input.expiresAt),
      },
    };

    const data = await this.precreateOrderCodeWithRetry(
      sdk,
      config,
      input.paymentNo,
      request,
    );

    const paymentUrl = assertSuccessfulPrecreate(
      data,
      input.paymentNo,
      input.amountCents,
    );
    return {
      providerTradeNo: null,
      paymentUrl,
      initialStatus: "pending",
    };
  }

  private async precreateOrderCodeWithRetry(
    sdk: AlipaySdkLike,
    config: AlipayConfig,
    paymentNo: string,
    request: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const maxAttempts = Math.max(1, config.orderCodePrecreateMaxAttempts);
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- retry must preserve out_trade_no idempotency.
        return await sdk.exec("alipay.trade.precreate", request, {
          validateSign: true,
        });
      } catch (error) {
        if (!isIndeterminateAlipayError(error)) {
          throw error;
        }
        lastError = error;
        this.logger.warn(
          `alipay.trade.precreate attempt ${attempt}/${maxAttempts} unavailable for ${paymentNo}: ${alipayErrorMessage(error)}`,
        );

        // The request may have reached Alipay even though the gateway timed
        // out. Never repeat a precreate until a signed query proves that the
        // provider has no trade for this exact payment number.
        let query: Record<string, unknown>;
        try {
          // oxlint-disable-next-line no-await-in-loop -- query decides whether retrying the same payment number is safe.
          query = await sdk.exec(
            "alipay.trade.query",
            { bizContent: { out_trade_no: paymentNo } },
            { validateSign: true },
          );
        } catch (queryError) {
          lastError = queryError;
          break;
        }
        if (!isTradeNotExistResponse(query)) {
          break;
        }

        if (attempt >= maxAttempts) break;
        // oxlint-disable-next-line no-await-in-loop -- bounded retry delay for transient Alipay sandbox 5xx.
        await sleep(config.orderCodePrecreateRetryDelayMs * attempt);
      }
    }

    throw new BadGatewayException(ALIPAY_PAYMENT_CHANNEL_UNAVAILABLE_MESSAGE, {
      cause: lastError,
    });
  }

  async queryPayment(
    input: ProviderPaymentQueryInput,
  ): Promise<ProviderPaymentQueryResult> {
    const config = parseAlipayConfig(input.config);
    const sdk = createAlipaySdk(this.sdkFactory, config);
    const body: Record<string, unknown> = { out_trade_no: input.paymentNo };
    if (input.providerTradeNo) body["trade_no"] = input.providerTradeNo;
    const data = await sdk.exec(
      "alipay.trade.query",
      {
        bizContent: body,
      },
      { validateSign: true },
    );
    // The SDK query is authenticated with the exact persisted app/seller binding.
    // A terminal success must additionally echo this payment number and amount.
    return assertVerifiedSuccessfulAlipayQuery(data, input);
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
    };
    try {
      const data = await sdk.exec("alipay.trade.pay", {
        bizContent: body,
      });
      return mapAlipayPaymentCodeResponse(data);
    } catch (err) {
      const errProperties = readAlipayErrorProperties(err);
      const codeValue = errProperties?.code;
      const responseHttpStatus = errProperties?.responseHttpStatus;
      const errCode = alipayErrorPropertyMessage(codeValue);
      const errStatus = alipayErrorPropertyMessage(responseHttpStatus) ?? "?";
      const errMessage = alipayErrorMessage(err);
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
      if (isIndeterminateAlipayError(err)) {
        return {
          status: "unknown",
          providerTradeNo: null,
          providerStatus: errCode ?? "ALIPAY_REQUEST_UNKNOWN",
          failureCode: errCode ?? "ALIPAY_REQUEST_UNKNOWN",
          failureMessage: errMessage,
          rawPayload: {},
        };
      }
      throw err;
    }
  }

  async queryPaymentCode(
    input: ProviderPaymentCodeQueryInput,
  ): Promise<ProviderPaymentCodeQueryResult> {
    const config = parseAlipayConfig(input.config);
    const sdk = createAlipaySdk(this.sdkFactory, config);
    const body: Record<string, unknown> = { out_trade_no: input.paymentNo };
    if (input.providerTradeNo) body["trade_no"] = input.providerTradeNo;
    try {
      const data = await sdk.exec(
        "alipay.trade.query",
        {
          bizContent: body,
        },
        { validateSign: true },
      );
      return mapAlipayPaymentCodeQueryResponse(data);
    } catch (err) {
      if (isIndeterminateAlipayError(err)) {
        return {
          status: "unknown",
          providerTradeNo: input.providerTradeNo,
          providerStatus: "ALIPAY_QUERY_UNKNOWN",
          failureCode: "ALIPAY_QUERY_UNKNOWN",
          failureMessage: alipayErrorMessage(err),
          rawPayload: {},
        };
      }
      throw err;
    }
  }

  async cancelPayment(
    input: ProviderCancelPaymentInput,
  ): Promise<ProviderCancelPaymentResult> {
    const config = parseAlipayConfig(input.config);
    const sdk = createAlipaySdk(this.sdkFactory, config);
    const body: Record<string, unknown> = { out_trade_no: input.paymentNo };
    if (input.providerTradeNo) body["trade_no"] = input.providerTradeNo;
    const data = await sdk.exec("alipay.trade.cancel", {
      bizContent: body,
    });
    const code = typeof data["code"] === "string" ? data["code"] : null;
    if (code && code !== "10000") {
      const subCode =
        typeof data["sub_code"] === "string" ? data["sub_code"] : code;
      const subMsg =
        typeof data["sub_msg"] === "string"
          ? data["sub_msg"]
          : "支付宝交易撤销失败";
      throw new BadGatewayException(
        `Alipay alipay.trade.cancel failed: ${subCode} ${subMsg}`,
      );
    }
    return { status: "canceled", rawPayload: data };
  }

  async reversePaymentCode(
    input: ProviderPaymentCodeReverseInput,
  ): Promise<ProviderPaymentCodeReverseResult> {
    const config = parseAlipayConfig(input.config);
    const sdk = createAlipaySdk(this.sdkFactory, config);
    let data: Record<string, unknown>;
    try {
      data = await sdk.exec("alipay.trade.cancel", {
        bizContent: {
          out_trade_no: input.paymentNo,
          ...(input.providerTradeNo ? { trade_no: input.providerTradeNo } : {}),
        },
      });
    } catch (err) {
      if (isIndeterminateAlipayError(err)) {
        return {
          status: "unknown",
          recall: true,
          providerStatus: "ALIPAY_REVERSE_UNKNOWN",
          failureCode: "ALIPAY_REVERSE_UNKNOWN",
          failureMessage: alipayErrorMessage(err),
          rawPayload: {},
        };
      }
      throw err;
    }
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
