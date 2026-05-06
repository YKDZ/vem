import type { PaymentStatus, RefundStatus } from "@vem/shared";

export type PaymentProviderRuntimeConfig = {
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
  providerTradeNo: string;
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

export type ProviderWebhookInput = {
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  rawBodyText: string;
  candidateConfigs: PaymentProviderRuntimeConfig[];
};

export type ProviderWebhookResult = {
  providerEventId: string;
  eventType: string;
  paymentNo: string | null;
  providerTradeNo: string | null;
  paymentStatus: PaymentStatus | null;
  signatureValid: boolean;
  rawPayload: Record<string, unknown>;
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
  handleWebhook?(input: ProviderWebhookInput): Promise<ProviderWebhookResult>;
}
