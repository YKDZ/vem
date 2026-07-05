import type { PaymentProviderStatus, PaymentProviderType } from "@vem/shared";
import type { z } from "zod";

import {
  paymentAdminActionResultSchema,
  paymentAdminNoBodySchema,
  paymentCodeAttemptAdminActionSchema,
  paymentCodeAttemptAdminResponseSchema,
  paymentCodeAttemptQuerySchema,
  paymentEventQuerySchema,
  paymentProviderQuerySchema,
  paymentQuerySchema,
  paymentReconciliationAttemptQuerySchema,
  paymentMockAdminActionResponseSchema,
  paymentOperatorReasonSchema,
  paymentWebhookAttemptQuerySchema,
  pageQuerySchema,
  refundQuerySchema,
  paymentProviderConfigSchema,
  paymentProviderSchema,
  updatePaymentProviderConfigSchema,
  updatePaymentProviderSchema,
  upsertPaymentProviderConfigSchema,
} from "@vem/shared";

import { get, patchContract, postContract } from "./request";

type PaymentListQuery = z.input<typeof paymentQuerySchema> &
  z.input<typeof pageQuerySchema>;
type PaymentEventListQuery = z.input<typeof paymentEventQuerySchema> &
  z.input<typeof pageQuerySchema>;
type PaymentWebhookAttemptListQuery = z.input<
  typeof paymentWebhookAttemptQuerySchema
> &
  z.input<typeof pageQuerySchema>;
type PaymentReconciliationAttemptListQuery = z.input<
  typeof paymentReconciliationAttemptQuerySchema
> &
  z.input<typeof pageQuerySchema>;
type RefundListQuery = z.input<typeof refundQuerySchema> &
  z.input<typeof pageQuerySchema>;
type PaymentCodeAttemptListQuery = z.input<
  typeof paymentCodeAttemptQuerySchema
> &
  z.input<typeof pageQuerySchema>;

export type Payment = {
  id: string;
  paymentNo: string;
  orderId: string;
  orderNo: string;
  providerCode: string;
  method: string;
  status: string;
  amountCents: number;
  isDrill?: boolean;
  isTest?: boolean;
  scenario?: string | null;
  expiresAt: string | null;
  paidAt: string | null;
  failedReason: string | null;
  createdAt: string;
};

export type PaymentProvider = {
  id: string;
  code: string;
  name: string;
  type: PaymentProviderType;
  status: PaymentProviderStatus;
  capabilities: Record<string, unknown>;
};

export type PaymentSecretStatus = {
  configured: boolean;
  updatedAt: string | null;
  fingerprintSha256?: string | null;
  certificateExpiresAt?: string | null;
  errorCode?: string | null;
};

export type PaymentProviderConfig = {
  id: string;
  providerId: string;
  providerCode: "wechat_pay" | "alipay" | "mock";
  providerName: string;
  machineId: string | null;
  merchantNo: string | null;
  appId: string | null;
  publicConfigJson: Record<string, unknown>;
  derivedNotifyUrl: string | null;
  secretStatusJson: Record<string, PaymentSecretStatus>;
  status: string;
  updatedByAdminUserId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PaymentProviderNotifyUrlCheck = {
  providerCode: "wechat_pay" | "alipay";
  notifyUrl: string;
  usesHttps: boolean;
  isLocalhost: boolean;
  pathMatchesWebhookRoute: boolean;
  reachable: boolean;
  statusCode: number | null;
  errorCode: string | null;
  checkedAt: string;
};

export type PaymentEvent = {
  id: string;
  paymentId: string;
  orderId: string;
  orderNo: string;
  paymentNo: string;
  providerId: string;
  providerCode: string;
  eventType: string;
  providerEventId: string | null;
  signatureValid: boolean | null;
  handledAt: string | null;
  createdAt: string;
};

export type PageResult<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
};

export async function listPayments(
  query?: PaymentListQuery,
): Promise<PageResult<Payment>> {
  return await get<PageResult<Payment>>("/payments", { params: query });
}

export async function mockSucceed(paymentNo: string): Promise<void> {
  await postContract(
    `/payments/mock/${paymentNo}/succeed`,
    paymentAdminNoBodySchema,
    paymentMockAdminActionResponseSchema,
    {},
  );
}

export async function mockFail(paymentNo: string): Promise<void> {
  await postContract(
    `/payments/mock/${paymentNo}/fail`,
    paymentAdminNoBodySchema,
    paymentMockAdminActionResponseSchema,
    {},
  );
}

export async function listPaymentProviders(
  query?: z.input<typeof paymentProviderQuerySchema>,
): Promise<PaymentProvider[]> {
  return await get<PaymentProvider[]>("/payments/providers", { params: query });
}

export async function updatePaymentProvider(
  id: string,
  body: z.input<typeof updatePaymentProviderSchema>,
): Promise<PaymentProvider> {
  return await patchContract(
    `/payments/providers/${id}`,
    updatePaymentProviderSchema,
    paymentProviderSchema,
    body,
  );
}

export async function listPaymentProviderConfigs(): Promise<
  PaymentProviderConfig[]
> {
  return await get<PaymentProviderConfig[]>("/payments/provider-configs");
}

export async function updatePaymentProviderConfig(
  id: string,
  body: z.input<typeof updatePaymentProviderConfigSchema>,
): Promise<PaymentProviderConfig> {
  return await patchContract(
    `/payments/provider-configs/${id}`,
    updatePaymentProviderConfigSchema,
    paymentProviderConfigSchema,
    body,
  );
}

export async function upsertPaymentProviderConfig(
  body: z.input<typeof upsertPaymentProviderConfigSchema>,
): Promise<PaymentProviderConfig> {
  return await postContract(
    `/payments/provider-configs`,
    upsertPaymentProviderConfigSchema,
    paymentProviderConfigSchema,
    body,
  );
}

export async function listPaymentEvents(
  query?: PaymentEventListQuery,
): Promise<PageResult<PaymentEvent>> {
  return await get<PageResult<PaymentEvent>>("/payments/events", {
    params: query,
  });
}

export async function listPaymentProviderNotifyUrlChecks(): Promise<
  PaymentProviderNotifyUrlCheck[]
> {
  return await get<PaymentProviderNotifyUrlCheck[]>(
    "/payments/provider-configs/notify-url-checks",
  );
}

export type WebhookAttempt = {
  id: string;
  orderId: string | null;
  providerCode: string | null;
  eventKind: string;
  eventType: string | null;
  paymentNo: string | null;
  refundNo: string | null;
  orderNo: string | null;
  signatureValid: boolean | null;
  businessValid: boolean | null;
  handled: boolean;
  duplicate: boolean;
  failureReason: string | null;
  remoteIp: string | null;
  httpStatus: number | null;
  createdAt: string;
};

export type ReconciliationAttempt = {
  id: string;
  paymentId: string;
  orderId: string;
  orderNo: string;
  paymentNo: string;
  providerCode: string;
  trigger: string;
  attemptNo: number;
  status: string;
  providerPaymentStatus: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  nextRetryAt: string | null;
  startedAt: string;
  finishedAt: string | null;
  createdAt: string;
};

export type RefundReconciliationAttempt = {
  trigger: string;
  attemptNo: number;
  status: string;
  providerRefundStatus: string | null;
  providerRefundNo: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  nextRetryAt: string | null;
  startedAt: string;
  finishedAt: string | null;
  createdAt: string;
};

export type Refund = {
  id: string;
  refundNo: string;
  paymentId: string;
  orderId: string;
  paymentNo: string;
  orderNo: string;
  providerCode: string;
  status: string;
  amountCents: number;
  isDrill?: boolean;
  isTest?: boolean;
  scenario?: string | null;
  reason: string;
  providerRefundNo: string | null;
  refundedAt: string | null;
  latestReconciliationStatus: string | null;
  latestProviderRefundStatus: string | null;
  latestReconciliationError: string | null;
  latestReconciliationAt: string | null;
  reconciliationAttempts: RefundReconciliationAttempt[];
  createdAt: string;
  updatedAt: string;
};

export type PaymentCodeAttempt = {
  id: string;
  orderId: string;
  orderNo: string;
  paymentNo: string;
  providerCode: "wechat_pay" | "alipay";
  attemptNo: number;
  providerPaymentNo: string;
  status: string;
  authCodeMasked: string;
  source: string;
  providerTradeNo: string | null;
  providerStatus: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  manualReason: string | null;
  submittedAt: string | null;
  lastCheckedAt: string | null;
  reversedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
};

export async function listWebhookAttempts(
  query?: PaymentWebhookAttemptListQuery,
): Promise<PageResult<WebhookAttempt>> {
  return await get<PageResult<WebhookAttempt>>("/payments/webhook-attempts", {
    params: query,
  });
}

export async function listReconciliationAttempts(
  query?: PaymentReconciliationAttemptListQuery,
): Promise<PageResult<ReconciliationAttempt>> {
  return await get<PageResult<ReconciliationAttempt>>(
    "/payments/reconciliation-attempts",
    { params: query },
  );
}

export async function listRefunds(
  query?: RefundListQuery,
): Promise<PageResult<Refund>> {
  return await get<PageResult<Refund>>("/payments/refunds", { params: query });
}

export async function queryRefund(
  refundId: string,
  reason?: string,
): Promise<z.output<typeof paymentAdminActionResultSchema>> {
  return await postContract(
    `/payments/refunds/${refundId}/query`,
    paymentOperatorReasonSchema,
    paymentAdminActionResultSchema,
    { reason: reason ?? "admin_refund_status_query" },
  );
}

export async function listPaymentCodeAttempts(
  query?: PaymentCodeAttemptListQuery,
): Promise<PageResult<PaymentCodeAttempt>> {
  return await get<PageResult<PaymentCodeAttempt>>(
    "/payments/payment-code-attempts",
    { params: query },
  );
}

export async function queryPaymentCodeAttempt(
  id: string,
  reason = "admin_payment_code_query",
): Promise<PaymentCodeAttempt> {
  return await postContract(
    `/payments/payment-code-attempts/${id}/query`,
    paymentCodeAttemptAdminActionSchema,
    paymentCodeAttemptAdminResponseSchema,
    { reason },
  );
}

export async function reversePaymentCodeAttempt(
  id: string,
  reason: string,
): Promise<PaymentCodeAttempt> {
  return await postContract(
    `/payments/payment-code-attempts/${id}/reverse`,
    paymentCodeAttemptAdminActionSchema,
    paymentCodeAttemptAdminResponseSchema,
    {
      reason,
    },
  );
}

export async function manualReconcile(
  paymentId: string,
  reason = "admin_manual_payment_reconcile",
): Promise<z.output<typeof paymentAdminActionResultSchema>> {
  return await postContract(
    `/payments/${paymentId}/reconcile`,
    paymentOperatorReasonSchema,
    paymentAdminActionResultSchema,
    { reason },
  );
}

// ---------------------------------------------------------------------------
// Payment Ops
// ---------------------------------------------------------------------------

export type PaymentOpsCheck = {
  code: string;
  severity: "info" | "warning" | "critical";
  passed: boolean;
  message: string;
  evidence: Record<string, unknown>;
};

export type PaymentOpsReadiness = {
  status: "ready" | "blocked";
  checkedAt: string;
  environment: "development" | "test" | "production";
  checks: PaymentOpsCheck[];
};

export type PaymentOpsMetrics = {
  measuredAt: string;
  windowMinutes: number;
  paymentFailureRate: number;
  paymentFailedCount: number;
  paymentTotalCount: number;
  webhookSignatureInvalidCount: number;
  webhookBusinessInvalidCount: number;
  reconciliationErrorCount: number;
  refundFailedCount: number;
  refundProcessingOverdueCount: number;
  certificateExpiringCount: number;
  paymentCodeUnknownCount: number;
  paymentCodeReverseFailedCount: number;
  paymentCodeDuplicateRejectedCount: number;
  scannerOfflineMachineCount: number;
};

export type PaymentMachinePreflight = {
  machineId: string;
  machineCode: string;
  status: "ready" | "blocked";
  availableProviders: Array<{
    optionKey: string;
    providerCode: "mock" | "wechat_pay" | "alipay";
    method: "mock" | "qr_code" | "payment_code" | "face_pay";
    displayName: string;
    description: string;
    icon: "mock" | "wechat" | "alipay";
    recommended: boolean;
    disabled: boolean;
    disabledReason: string | null;
  }>;
  defaultOptionKey: string | null;
  defaultProviderCode: "mock" | "wechat_pay" | "alipay" | null;
  checks: PaymentOpsCheck[];
  checkedAt: string;
};

export async function getPaymentOpsReadiness(): Promise<PaymentOpsReadiness> {
  return await get<PaymentOpsReadiness>("/payments/ops/readiness");
}

export async function getPaymentOpsMetrics(
  windowMinutes = 60,
): Promise<PaymentOpsMetrics> {
  return await get<PaymentOpsMetrics>("/payments/ops/metrics", {
    params: { windowMinutes },
  });
}

export async function getPaymentMachinePreflight(
  machineId: string,
): Promise<PaymentMachinePreflight> {
  return await get<PaymentMachinePreflight>(
    `/payments/ops/machines/${machineId}/preflight`,
  );
}
