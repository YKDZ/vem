import type { PaymentProviderStatus, PaymentProviderType } from "@vem/shared";

import { get, patch, post } from "./request";

export type Payment = {
  id: string;
  paymentNo: string;
  orderId: string;
  orderNo: string;
  providerCode: string;
  method: string;
  status: string;
  amountCents: number;
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
  query?: Record<string, unknown>,
): Promise<PageResult<Payment>> {
  return await get<PageResult<Payment>>("/payments", { params: query });
}

export async function mockSucceed(paymentNo: string): Promise<void> {
  await post<void>(`/payments/mock/${paymentNo}/succeed`);
}

export async function mockFail(paymentNo: string): Promise<void> {
  await post<void>(`/payments/mock/${paymentNo}/fail`);
}

export async function listPaymentProviders(
  query?: Record<string, unknown>,
): Promise<PaymentProvider[]> {
  return await get<PaymentProvider[]>("/payments/providers", { params: query });
}

export async function updatePaymentProvider(
  id: string,
  body: Partial<Pick<PaymentProvider, "name" | "status" | "capabilities">>,
): Promise<PaymentProvider> {
  return await patch<PaymentProvider>(`/payments/providers/${id}`, body);
}

export async function listPaymentProviderConfigs(): Promise<
  PaymentProviderConfig[]
> {
  return await get<PaymentProviderConfig[]>("/payments/provider-configs");
}

export async function updatePaymentProviderConfig(
  id: string,
  body: Partial<
    Pick<
      PaymentProviderConfig,
      "merchantNo" | "appId" | "publicConfigJson" | "status"
    >
  >,
): Promise<PaymentProviderConfig> {
  return await patch<PaymentProviderConfig>(
    `/payments/provider-configs/${id}`,
    body,
  );
}

export async function upsertPaymentProviderConfig(body: {
  providerCode: "wechat_pay" | "alipay";
  machineId?: string | null;
  merchantNo?: string | null;
  appId?: string | null;
  publicConfigJson?: Record<string, unknown>;
  sensitiveConfigJson?: Record<string, string | number | boolean | null>;
  status?: "enabled" | "disabled";
}): Promise<PaymentProviderConfig> {
  return await post<PaymentProviderConfig>(`/payments/provider-configs`, body);
}

export async function listPaymentEvents(
  query?: Record<string, unknown>,
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
  reason: string;
  providerRefundNo: string | null;
  refundedAt: string | null;
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
  query?: Record<string, unknown>,
): Promise<PageResult<WebhookAttempt>> {
  return await get<PageResult<WebhookAttempt>>("/payments/webhook-attempts", {
    params: query,
  });
}

export async function listReconciliationAttempts(
  query?: Record<string, unknown>,
): Promise<PageResult<ReconciliationAttempt>> {
  return await get<PageResult<ReconciliationAttempt>>(
    "/payments/reconciliation-attempts",
    { params: query },
  );
}

export async function listRefunds(
  query?: Record<string, unknown>,
): Promise<PageResult<Refund>> {
  return await get<PageResult<Refund>>("/payments/refunds", { params: query });
}

export async function listPaymentCodeAttempts(
  query?: Record<string, unknown>,
): Promise<PageResult<PaymentCodeAttempt>> {
  return await get<PageResult<PaymentCodeAttempt>>(
    "/payments/payment-code-attempts",
    { params: query },
  );
}

export async function queryPaymentCodeAttempt(id: string): Promise<void> {
  await post<void>(`/payments/payment-code-attempts/${id}/query`);
}

export async function reversePaymentCodeAttempt(
  id: string,
  reason: string,
): Promise<void> {
  await post<void>(`/payments/payment-code-attempts/${id}/reverse`, {
    reason,
  });
}

export async function manualReconcile(paymentId: string): Promise<{
  status: string;
  reconciled: boolean;
  reason?: string;
}> {
  return await post<{ status: string; reconciled: boolean; reason?: string }>(
    `/payments/${paymentId}/reconcile`,
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
    providerCode: "mock" | "wechat_pay" | "alipay";
    method: "mock" | "qr_code" | "payment_code" | "face_pay";
    displayName: string;
    description: string;
    icon: "mock" | "wechat" | "alipay";
    recommended: boolean;
  }>;
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
