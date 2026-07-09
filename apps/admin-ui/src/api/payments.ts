import {
  paymentAdminActionResultSchema,
  paymentAdminNoBodySchema,
  paymentChannelPolicyResponseSchema,
  paymentAdminPageResponseSchema,
  paymentCodeAttemptAdminActionSchema,
  paymentCodeAttemptAdminPageResponseSchema,
  paymentCodeAttemptAdminResponseSchema,
  paymentCodeAttemptListQuerySchema,
  paymentEventAdminPageResponseSchema,
  paymentEventListQuerySchema,
  paymentIncidentActionRequestSchema,
  paymentIncidentActionResponseSchema,
  paymentListQuerySchema,
  paymentProviderConfigListResponseSchema,
  paymentProviderListResponseSchema,
  paymentProviderNotifyUrlCheckListResponseSchema,
  paymentProviderQuerySchema,
  paymentReconciliationAttemptListQuerySchema,
  paymentReconciliationAttemptAdminPageResponseSchema,
  paymentMockAdminActionResponseSchema,
  paymentOperatorReasonSchema,
  paymentWebhookAttemptAdminPageResponseSchema,
  paymentWebhookAttemptListQuerySchema,
  refundAdminPageResponseSchema,
  refundListQuerySchema,
  paymentProviderConfigSchema,
  paymentProviderSchema,
  paymentMachinePreflightSchema,
  paymentOpsMetricsSchema,
  paymentOpsReadinessSchema,
  updatePaymentChannelPolicySchema,
  updatePaymentProviderConfigSchema,
  updatePaymentProviderSchema,
  upsertPaymentProviderConfigSchema,
  type PaymentAdminResponse,
  type PaymentCodeAttemptAdminResponse,
  type PaymentEventAdminResponse,
  type PaymentIncidentActionResponse,
  type PaymentMachinePreflight,
  type PaymentChannelPolicyResponse,
  type PaymentOpsMetrics,
  type PaymentOpsReadiness,
  type PaymentProviderConfigResponse,
  type PaymentProviderNotifyUrlCheckResponse,
  type PaymentProviderResponse,
  type PaymentReconciliationAttemptAdminResponse,
  type PaymentWebhookAttemptAdminResponse,
  type PageResult,
  type RefundAdminResponse,
  type RefundReconciliationAttemptAdminResponse,
} from "@vem/shared";
import { z } from "zod";

import {
  getContract,
  patchContract,
  postContract,
  putContract,
} from "./request";

type PaymentListQuery = z.input<typeof paymentListQuerySchema>;
type PaymentEventListQuery = z.input<typeof paymentEventListQuerySchema>;
type PaymentWebhookAttemptListQuery = z.input<
  typeof paymentWebhookAttemptListQuerySchema
>;
type PaymentReconciliationAttemptListQuery = z.input<
  typeof paymentReconciliationAttemptListQuerySchema
>;
type RefundListQuery = z.input<typeof refundListQuerySchema>;
type PaymentCodeAttemptListQuery = z.input<
  typeof paymentCodeAttemptListQuerySchema
>;

export type Payment = PaymentAdminResponse;
export type PaymentProvider = PaymentProviderResponse;
export type PaymentChannelPolicy = PaymentChannelPolicyResponse;
export type PaymentProviderConfig = PaymentProviderConfigResponse;
export type PaymentProviderNotifyUrlCheck =
  PaymentProviderNotifyUrlCheckResponse;
export type PaymentSecretStatus =
  PaymentProviderConfigResponse["secretStatusJson"][string];
export type PaymentEvent = PaymentEventAdminResponse;
export type { PaymentMachinePreflight, PaymentOpsMetrics, PaymentOpsReadiness };
export type { PageResult };

export async function listPayments(
  query?: PaymentListQuery,
): Promise<PageResult<Payment>> {
  return await getContract(
    "/payments",
    paymentListQuerySchema,
    paymentAdminPageResponseSchema,
    query ?? {},
  );
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
  return await getContract(
    "/payments/providers",
    paymentProviderQuerySchema,
    paymentProviderListResponseSchema,
    query ?? {},
  );
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
  return await getContract(
    "/payments/provider-configs",
    paymentAdminNoBodySchema,
    paymentProviderConfigListResponseSchema,
    {},
  );
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
  return await getContract(
    "/payments/events",
    paymentEventListQuerySchema,
    paymentEventAdminPageResponseSchema,
    query ?? {},
  );
}

export async function listPaymentProviderNotifyUrlChecks(): Promise<
  PaymentProviderNotifyUrlCheck[]
> {
  return await getContract(
    "/payments/provider-configs/notify-url-checks",
    paymentAdminNoBodySchema,
    paymentProviderNotifyUrlCheckListResponseSchema,
    {},
  );
}

export async function getPaymentChannelPolicy(): Promise<PaymentChannelPolicy> {
  return await getContract(
    "/payments/channel-policy",
    paymentAdminNoBodySchema,
    paymentChannelPolicyResponseSchema,
    {},
  );
}

export async function updatePaymentChannelPolicy(
  body: z.input<typeof updatePaymentChannelPolicySchema>,
): Promise<PaymentChannelPolicy> {
  return await putContract(
    "/payments/channel-policy",
    updatePaymentChannelPolicySchema,
    paymentChannelPolicyResponseSchema,
    body,
  );
}

export type WebhookAttempt = PaymentWebhookAttemptAdminResponse;
export type ReconciliationAttempt = PaymentReconciliationAttemptAdminResponse;
export type RefundReconciliationAttempt =
  RefundReconciliationAttemptAdminResponse;
export type Refund = RefundAdminResponse;
export type PaymentCodeAttempt = PaymentCodeAttemptAdminResponse;
export type PaymentIncidentActionResult = PaymentIncidentActionResponse;

export async function createPaymentIncidentAction(
  paymentId: string,
  body: z.input<typeof paymentIncidentActionRequestSchema>,
): Promise<PaymentIncidentActionResult> {
  return await postContract(
    `/payments/${paymentId}/incident-actions`,
    paymentIncidentActionRequestSchema,
    paymentIncidentActionResponseSchema,
    body,
  );
}

export async function listWebhookAttempts(
  query?: PaymentWebhookAttemptListQuery,
): Promise<PageResult<WebhookAttempt>> {
  return await getContract(
    "/payments/webhook-attempts",
    paymentWebhookAttemptListQuerySchema,
    paymentWebhookAttemptAdminPageResponseSchema,
    query ?? {},
  );
}

export async function listReconciliationAttempts(
  query?: PaymentReconciliationAttemptListQuery,
): Promise<PageResult<ReconciliationAttempt>> {
  return await getContract(
    "/payments/reconciliation-attempts",
    paymentReconciliationAttemptListQuerySchema,
    paymentReconciliationAttemptAdminPageResponseSchema,
    query ?? {},
  );
}

export async function listRefunds(
  query?: RefundListQuery,
): Promise<PageResult<Refund>> {
  return await getContract(
    "/payments/refunds",
    refundListQuerySchema,
    refundAdminPageResponseSchema,
    query ?? {},
  );
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
  return await getContract(
    "/payments/payment-code-attempts",
    paymentCodeAttemptListQuerySchema,
    paymentCodeAttemptAdminPageResponseSchema,
    query ?? {},
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

export async function getPaymentOpsReadiness(): Promise<PaymentOpsReadiness> {
  return await getContract(
    "/payments/ops/readiness",
    paymentAdminNoBodySchema,
    paymentOpsReadinessSchema,
    {},
  );
}

export async function getPaymentOpsMetrics(
  windowMinutes = 60,
): Promise<PaymentOpsMetrics> {
  return await getContract(
    "/payments/ops/metrics",
    paymentAdminNoBodySchema.extend({
      windowMinutes: z.number().int().min(5).max(1440).optional(),
    }),
    paymentOpsMetricsSchema,
    { windowMinutes },
  );
}

export async function getPaymentMachinePreflight(
  machineId: string,
): Promise<PaymentMachinePreflight> {
  return await getContract(
    `/payments/ops/machines/${machineId}/preflight`,
    paymentAdminNoBodySchema,
    paymentMachinePreflightSchema,
    {},
  );
}
