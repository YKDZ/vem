import type { PaymentStatus, RefundStatus } from "@vem/shared";

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
};

export type ProviderPaymentQueryInput = {
  paymentNo: string;
  providerTradeNo: string | null;
  config: PaymentProviderRuntimeConfig;
};

export type ProviderPaymentQueryResult = {
  status: Extract<
    PaymentStatus,
    "pending" | "processing" | "succeeded" | "failed" | "expired" | "canceled"
  >;
  providerTradeNo?: string | null;
  paidAt?: Date;
  failedReason?: string | null;
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

export type ProviderRefundPaymentInput = {
  refundNo: string;
  paymentNo: string;
  providerTradeNo: string | null;
  amountCents: number;
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
};

export interface PaymentProvider {
  readonly code: string;
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
