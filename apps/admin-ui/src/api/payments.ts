import type { z } from "zod";

import {
  adminCreatePaymentIncidentActionContract,
  adminGetPaymentChannelPolicyContract,
  adminGetPaymentMachinePreflightContract,
  adminListPaymentCodeAttemptsContract,
  adminListPaymentEventsContract,
  adminListPaymentProviderConfigsContract,
  adminListPaymentProviderNotifyUrlChecksContract,
  adminListPaymentProvidersContract,
  adminListPaymentReconciliationAttemptsContract,
  adminListPaymentRefundsContract,
  adminListPaymentWebhookAttemptsContract,
  adminListPaymentsContract,
  adminManualReconcilePaymentContract,
  adminMockPaymentFailContract,
  adminMockPaymentSucceedContract,
  adminQueryPaymentCodeAttemptContract,
  adminQueryPaymentRefundContract,
  adminReversePaymentCodeAttemptContract,
  adminUpdatePaymentChannelPolicyContract,
  adminUpdatePaymentProviderConfigContract,
  adminUpdatePaymentProviderContract,
  adminUpsertPaymentProviderConfigContract,
  type PaymentAdminResponse,
  type PaymentChannelPolicyResponse,
  type PaymentCodeAttemptAdminResponse,
  type PaymentEventAdminResponse,
  type PaymentIncidentActionResponse,
  type PaymentMachinePreflight,
  type PaymentProviderConfigResponse,
  type PaymentProviderNotifyUrlCheckResponse,
  type PaymentProviderResponse,
  type PaymentReconciliationAttemptAdminResponse,
  type PaymentWebhookAttemptAdminResponse,
  type PageResult,
  type RefundAdminResponse,
  type RefundReconciliationAttemptAdminResponse,
} from "@vem/shared";

import { callAdminEndpointContract } from "./request";

type PaymentListQuery = z.input<typeof adminListPaymentsContract.querySchema>;
type PaymentEventListQuery = z.input<
  typeof adminListPaymentEventsContract.querySchema
>;
type PaymentWebhookAttemptListQuery = z.input<
  typeof adminListPaymentWebhookAttemptsContract.querySchema
>;
type PaymentReconciliationAttemptListQuery = z.input<
  typeof adminListPaymentReconciliationAttemptsContract.querySchema
>;
type RefundListQuery = z.input<
  typeof adminListPaymentRefundsContract.querySchema
>;
type PaymentCodeAttemptListQuery = z.input<
  typeof adminListPaymentCodeAttemptsContract.querySchema
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
export type { PaymentMachinePreflight };
export type { PageResult };

export async function listPayments(
  query?: PaymentListQuery,
): Promise<PageResult<Payment>> {
  return await callAdminEndpointContract(adminListPaymentsContract, {
    query: query ?? {},
  });
}

export async function mockSucceed(paymentNo: string): Promise<void> {
  await callAdminEndpointContract(adminMockPaymentSucceedContract, {
    pathParams: { paymentNo },
  });
}

export async function mockFail(paymentNo: string): Promise<void> {
  await callAdminEndpointContract(adminMockPaymentFailContract, {
    pathParams: { paymentNo },
  });
}

export async function listPaymentProviders(
  query?: z.input<typeof adminListPaymentProvidersContract.querySchema>,
): Promise<PaymentProvider[]> {
  return await callAdminEndpointContract(adminListPaymentProvidersContract, {
    query: query ?? {},
  });
}

export async function updatePaymentProvider(
  id: string,
  body: z.input<typeof adminUpdatePaymentProviderContract.bodySchema>,
): Promise<PaymentProvider> {
  return await callAdminEndpointContract(adminUpdatePaymentProviderContract, {
    pathParams: { id },
    body,
  });
}

export async function listPaymentProviderConfigs(): Promise<
  PaymentProviderConfig[]
> {
  return await callAdminEndpointContract(
    adminListPaymentProviderConfigsContract,
    {},
  );
}

export async function updatePaymentProviderConfig(
  id: string,
  body: z.input<typeof adminUpdatePaymentProviderConfigContract.bodySchema>,
): Promise<PaymentProviderConfig> {
  return await callAdminEndpointContract(
    adminUpdatePaymentProviderConfigContract,
    {
      pathParams: { id },
      body,
    },
  );
}

export async function upsertPaymentProviderConfig(
  body: z.input<typeof adminUpsertPaymentProviderConfigContract.bodySchema>,
): Promise<PaymentProviderConfig> {
  return await callAdminEndpointContract(
    adminUpsertPaymentProviderConfigContract,
    { body },
  );
}

export async function listPaymentEvents(
  query?: PaymentEventListQuery,
): Promise<PageResult<PaymentEvent>> {
  return await callAdminEndpointContract(adminListPaymentEventsContract, {
    query: query ?? {},
  });
}

export async function listPaymentProviderNotifyUrlChecks(): Promise<
  PaymentProviderNotifyUrlCheck[]
> {
  return await callAdminEndpointContract(
    adminListPaymentProviderNotifyUrlChecksContract,
    {},
  );
}

export async function getPaymentChannelPolicy(): Promise<PaymentChannelPolicy> {
  return await callAdminEndpointContract(
    adminGetPaymentChannelPolicyContract,
    {},
  );
}

export async function updatePaymentChannelPolicy(
  body: z.input<typeof adminUpdatePaymentChannelPolicyContract.bodySchema>,
): Promise<PaymentChannelPolicy> {
  return await callAdminEndpointContract(
    adminUpdatePaymentChannelPolicyContract,
    { body },
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
  body: z.input<typeof adminCreatePaymentIncidentActionContract.bodySchema>,
): Promise<PaymentIncidentActionResult> {
  return await callAdminEndpointContract(
    adminCreatePaymentIncidentActionContract,
    { pathParams: { id: paymentId }, body },
  );
}

export async function listWebhookAttempts(
  query?: PaymentWebhookAttemptListQuery,
): Promise<PageResult<WebhookAttempt>> {
  return await callAdminEndpointContract(
    adminListPaymentWebhookAttemptsContract,
    { query: query ?? {} },
  );
}

export async function listReconciliationAttempts(
  query?: PaymentReconciliationAttemptListQuery,
): Promise<PageResult<ReconciliationAttempt>> {
  return await callAdminEndpointContract(
    adminListPaymentReconciliationAttemptsContract,
    { query: query ?? {} },
  );
}

export async function listRefunds(
  query?: RefundListQuery,
): Promise<PageResult<Refund>> {
  return await callAdminEndpointContract(adminListPaymentRefundsContract, {
    query: query ?? {},
  });
}

export async function queryRefund(
  refundId: string,
  reason = "admin_refund_status_query",
): Promise<z.output<typeof adminQueryPaymentRefundContract.responseSchema>> {
  return await callAdminEndpointContract(adminQueryPaymentRefundContract, {
    pathParams: { id: refundId },
    body: { reason },
  });
}

export async function listPaymentCodeAttempts(
  query?: PaymentCodeAttemptListQuery,
): Promise<PageResult<PaymentCodeAttempt>> {
  return await callAdminEndpointContract(adminListPaymentCodeAttemptsContract, {
    query: query ?? {},
  });
}

export async function queryPaymentCodeAttempt(
  id: string,
  reason = "admin_payment_code_query",
): Promise<PaymentCodeAttempt> {
  return await callAdminEndpointContract(adminQueryPaymentCodeAttemptContract, {
    pathParams: { id },
    body: { reason },
  });
}

export async function reversePaymentCodeAttempt(
  id: string,
  reason: string,
): Promise<PaymentCodeAttempt> {
  return await callAdminEndpointContract(
    adminReversePaymentCodeAttemptContract,
    {
      pathParams: { id },
      body: { reason },
    },
  );
}

export async function manualReconcile(
  paymentId: string,
  reason = "admin_manual_payment_reconcile",
): Promise<
  z.output<typeof adminManualReconcilePaymentContract.responseSchema>
> {
  return await callAdminEndpointContract(adminManualReconcilePaymentContract, {
    pathParams: { id: paymentId },
    body: { reason },
  });
}

export async function getPaymentMachinePreflight(
  machineId: string,
): Promise<PaymentMachinePreflight> {
  return await callAdminEndpointContract(
    adminGetPaymentMachinePreflightContract,
    { pathParams: { machineId } },
  );
}
