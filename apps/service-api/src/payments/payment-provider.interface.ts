import type { PaymentStatus, RefundStatus } from "@vem/shared";

export class PaymentProviderRequestNotSentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentProviderRequestNotSentError";
  }
}

export type PaymentProviderRuntimeConfig = {
  id?: string;
  providerCode: string;
  merchantNo: string | null;
  appId: string | null;
  publicConfigJson: Record<string, unknown>;
  sensitiveConfigJson: Record<string, unknown>;
};

export type PaymentIntentInput = {
  paymentNo: string;
  orderNo: string;
  amountCents: number;
  expiresAt: Date;
  config: PaymentProviderRuntimeConfig;
};

export type PaymentIntentResult = {
  providerTradeNo: string | null;
  paymentUrl: string;
  initialStatus?: "pending" | "processing";
};

export type ProviderPaymentQueryInput = {
  paymentNo: string;
  providerTradeNo: string | null;
  amountCents: number;
  config: PaymentProviderRuntimeConfig;
};

export type PaymentReconciliationState =
  | "provider_trade_not_exist"
  | "wait_buyer_pay";

export type ProviderPaymentQueryResult = {
  status: Extract<
    PaymentStatus,
    "pending" | "processing" | "succeeded" | "failed" | "expired" | "canceled"
  >;
  providerTradeNo?: string | null;
  paidAt?: Date;
  failedReason?: string | null;
  /**
   * Provider facts that control whether an uncertain order-code create may be
   * retried. They are intentionally distinct from generic pending status.
   */
  reconciliationState?: PaymentReconciliationState | null;
  rawPayload?: Record<string, unknown>;
};

export type ProviderCancelPaymentInput = {
  paymentNo: string;
  providerTradeNo: string | null;
  config: PaymentProviderRuntimeConfig;
};

export type ProviderCancelPaymentResult = {
  status: Extract<PaymentStatus, "canceled" | "expired">;
  rawPayload?: Record<string, unknown>;
};

export type ProviderPaymentCodeStatus =
  | "succeeded"
  | "user_confirming"
  | "processing"
  | "failed"
  | "reversed"
  | "unknown";

export type ProviderPaymentCodeChargeInput = {
  paymentNo: string;
  /** Durable provider-side idempotency identity (normally out_trade_no). */
  idempotencyKey?: string;
  orderNo: string;
  amountCents: number;
  authCode: string;
  terminalId: string | null;
  storeId: string | null;
  clientIp: string | null;
  config: PaymentProviderRuntimeConfig;
};

export type ProviderPaymentCodeChargeResult = {
  status: ProviderPaymentCodeStatus;
  providerTradeNo: string | null;
  paidAt?: Date | null;
  providerStatus?: string | null;
  failureCode?: string | null;
  failureMessage?: string | null;
  rawPayload?: Record<string, unknown>;
};

export type ProviderPaymentCodeQueryInput = {
  paymentNo: string;
  providerTradeNo: string | null;
  config: PaymentProviderRuntimeConfig;
};

export type ProviderPaymentCodeQueryResult = ProviderPaymentCodeChargeResult;

export type ProviderPaymentCodeReverseInput = {
  paymentNo: string;
  /** Reversal retries use the same durable provider operation identity. */
  idempotencyKey?: string;
  providerTradeNo: string | null;
  config: PaymentProviderRuntimeConfig;
};

export type ProviderPaymentCodeReverseResult = {
  status: "reversed" | "processing" | "failed" | "unknown";
  recall?: boolean;
  providerStatus?: string | null;
  failureCode?: string | null;
  failureMessage?: string | null;
  rawPayload?: Record<string, unknown>;
};

export type ProviderRefundPaymentInput = {
  refundNo: string;
  paymentNo: string;
  providerTradeNo: string | null;
  amountCents: number;
  totalAmountCents?: number;
  reason: string;
  config: PaymentProviderRuntimeConfig;
};

export type ProviderRefundPaymentResult = {
  providerRefundNo: string;
  status: Extract<RefundStatus, "processing" | "succeeded" | "failed">;
  refundedAt: Date | null;
  rawPayload?: Record<string, unknown>;
};

export type ProviderWebhookResult =
  | ProviderPaymentWebhookResult
  | ProviderRefundWebhookResult;

export type ProviderPaymentWebhookResult = {
  eventKind: "payment";
  providerEventId: string;
  eventType: string;
  paymentNo: string | null;
  providerTradeNo: string | null;
  paymentStatus: PaymentStatus | null;
  signatureValid: boolean;
  rawPayload: Record<string, unknown>;
  /** 标准化后的业务字段，供 PaymentsService 业务校验使用 */
  normalizedPayload?: Record<string, unknown> | null;
  /** 匹配到的配置 id，用于业务字段校验时找到对应商户信息 */
  matchedConfigId?: string | null;
};

export type ProviderRefundWebhookResult = {
  eventKind: "refund";
  providerEventId: string;
  eventType: string;
  refundNo: string | null;
  paymentNo: string | null;
  providerRefundNo: string | null;
  refundStatus: RefundStatus | null;
  signatureValid: boolean;
  rawPayload: Record<string, unknown>;
  normalizedPayload?: Record<string, unknown> | null;
  matchedConfigId?: string | null;
};

export type ProviderRefundQueryInput = {
  refundNo: string;
  paymentNo: string;
  providerRefundNo: string | null;
  providerTradeNo: string | null;
  amountCents: number;
  config: PaymentProviderRuntimeConfig;
};

export type ProviderRefundQueryResult = {
  providerRefundNo: string | null;
  status: Extract<
    RefundStatus,
    "processing" | "succeeded" | "failed" | "canceled"
  >;
  refundedAt: Date | null;
  rawPayload?: Record<string, unknown>;
};

export type ProviderWebhookInput = {
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  rawBodyText: string;
  candidateConfigs: PaymentProviderRuntimeConfig[];
  /** Immutable config binding found from the untrusted payment number before
   * signature verification. Providers must verify with this exact config. */
  expectedConfigId?: string | null;
  expectedConfig?: PaymentProviderRuntimeConfig | null;
};

export interface PaymentProvider {
  readonly code: string;
  readonly supportsPartialRefund?: boolean;
  createPaymentIntent(input: PaymentIntentInput): Promise<PaymentIntentResult>;
  queryPayment(
    input: ProviderPaymentQueryInput,
  ): Promise<ProviderPaymentQueryResult>;
  cancelPayment(
    input: ProviderCancelPaymentInput,
  ): Promise<ProviderCancelPaymentResult>;
  refundPayment(
    input: ProviderRefundPaymentInput,
  ): Promise<ProviderRefundPaymentResult>;
  queryRefund?(
    input: ProviderRefundQueryInput,
  ): Promise<ProviderRefundQueryResult>;
  handleWebhook?(input: ProviderWebhookInput): Promise<ProviderWebhookResult>;
}

export interface PaymentCodeCapableProvider extends PaymentProvider {
  chargePaymentCode(
    input: ProviderPaymentCodeChargeInput,
  ): Promise<ProviderPaymentCodeChargeResult>;
  queryPaymentCode(
    input: ProviderPaymentCodeQueryInput,
  ): Promise<ProviderPaymentCodeQueryResult>;
  /**
   * 仅用于付款码等待/未知结果的撤销；已明确支付成功的订单继续走现有
   * refundPayment() 全额退款路径，不能用 reversePaymentCode() 替代正常退款。
   */
  reversePaymentCode(
    input: ProviderPaymentCodeReverseInput,
  ): Promise<ProviderPaymentCodeReverseResult>;
}
