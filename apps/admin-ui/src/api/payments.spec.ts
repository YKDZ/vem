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
  type UpdatePaymentChannelPolicyInput,
} from "@vem/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { callAdminEndpointContract } from "@/api/request";

import {
  createPaymentIncidentAction,
  getPaymentMachinePreflight,
  getPaymentChannelPolicy,
  listPaymentProviderConfigs,
  listPaymentProviderNotifyUrlChecks,
  listPaymentProviders,
  listPayments,
  listPaymentCodeAttempts,
  listPaymentEvents,
  listReconciliationAttempts,
  listRefunds,
  listWebhookAttempts,
  manualReconcile,
  mockFail,
  mockSucceed,
  queryPaymentCodeAttempt,
  queryRefund,
  reversePaymentCodeAttempt,
  updatePaymentChannelPolicy,
  updatePaymentProvider,
  updatePaymentProviderConfig,
  upsertPaymentProviderConfig,
} from "./payments";

vi.mock("@/api/request", () => ({
  callAdminEndpointContract: vi.fn().mockResolvedValue({}),
}));

describe("payments api operator actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(callAdminEndpointContract).mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    });
  });

  it("uses complete shared endpoint contracts for payment overview reads", async () => {
    await listPayments({ status: "succeeded", page: 2 });
    await listPaymentProviders({ status: "enabled" });
    await listPaymentProviderConfigs();
    await listPaymentProviderNotifyUrlChecks();

    expect(callAdminEndpointContract).toHaveBeenCalledWith(
      adminListPaymentsContract,
      { query: { status: "succeeded", page: 2 } },
    );
    expect(callAdminEndpointContract).toHaveBeenCalledWith(
      adminListPaymentProvidersContract,
      { query: { status: "enabled" } },
    );
    expect(callAdminEndpointContract).toHaveBeenCalledWith(
      adminListPaymentProviderConfigsContract,
      {},
    );
    expect(callAdminEndpointContract).toHaveBeenCalledWith(
      adminListPaymentProviderNotifyUrlChecksContract,
      {},
    );
  });

  it("uses complete shared endpoint contracts for payment read lists", async () => {
    await listWebhookAttempts({ eventKind: "payment" });
    await listReconciliationAttempts({ trigger: "manual" });
    await listRefunds({ status: "processing" });
    await listPaymentEvents({ paymentNo: "PAY-1" });
    await listPaymentCodeAttempts({ manualOnly: true });

    expect(callAdminEndpointContract).toHaveBeenCalledWith(
      adminListPaymentWebhookAttemptsContract,
      { query: { eventKind: "payment" } },
    );
    expect(callAdminEndpointContract).toHaveBeenCalledWith(
      adminListPaymentReconciliationAttemptsContract,
      { query: { trigger: "manual" } },
    );
    expect(callAdminEndpointContract).toHaveBeenCalledWith(
      adminListPaymentRefundsContract,
      { query: { status: "processing" } },
    );
    expect(callAdminEndpointContract).toHaveBeenCalledWith(
      adminListPaymentEventsContract,
      { query: { paymentNo: "PAY-1" } },
    );
    expect(callAdminEndpointContract).toHaveBeenCalledWith(
      adminListPaymentCodeAttemptsContract,
      { query: { manualOnly: true } },
    );
  });

  it("accepts mock payment-code attempts returned by the runtime testbed", async () => {
    vi.mocked(callAdminEndpointContract).mockResolvedValueOnce({
      items: [
        {
          id: "attempt-1",
          orderId: "order-1",
          orderNo: "ORD-1",
          paymentNo: "PAY-1",
          providerCode: "mock",
          attemptNo: 1,
          providerPaymentNo: "MOCK-PAY-1",
          status: "succeeded",
          authCodeMasked: "2800********1234",
          source: "serial_text",
          providerTradeNo: null,
          providerStatus: null,
          failureCode: null,
          failureMessage: null,
          manualReason: null,
          submittedAt: "2026-07-25T05:00:00.000Z",
          lastCheckedAt: null,
          reversedAt: null,
          finishedAt: "2026-07-25T05:00:01.000Z",
          createdAt: "2026-07-25T05:00:00.000Z",
        },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
    });

    const page = await listPaymentCodeAttempts({ providerCode: "mock" });

    expect(page.items[0]?.providerCode).toBe("mock");
  });

  it("uses complete shared endpoint contracts for payment operations reads", async () => {
    await getPaymentMachinePreflight("550e8400-e29b-41d4-a716-446655440010");
    await getPaymentChannelPolicy();

    expect(callAdminEndpointContract).toHaveBeenCalledWith(
      adminGetPaymentMachinePreflightContract,
      { pathParams: { machineId: "550e8400-e29b-41d4-a716-446655440010" } },
    );
    expect(callAdminEndpointContract).toHaveBeenCalledWith(
      adminGetPaymentChannelPolicyContract,
      {},
    );
  });

  it("uses the shared endpoint contract for global payment channel policy writes", async () => {
    const policy: UpdatePaymentChannelPolicyInput = {
      channels: [
        { channelKey: "payment_code:wechat_pay", enabled: true, rank: 1 },
        { channelKey: "qr_code:wechat_pay", enabled: true, rank: 2 },
        { channelKey: "payment_code:alipay", enabled: false, rank: 3 },
        { channelKey: "qr_code:alipay", enabled: true, rank: 4 },
      ],
      defaultChannelKey: "payment_code:wechat_pay",
    };

    await updatePaymentChannelPolicy(policy);

    expect(callAdminEndpointContract).toHaveBeenCalledWith(
      adminUpdatePaymentChannelPolicyContract,
      { body: policy },
    );
  });

  it("sends a reason when manually reconciling a payment", async () => {
    await manualReconcile(
      "550e8400-e29b-41d4-a716-446655440000",
      "customer sees paid but platform is pending",
    );

    expect(callAdminEndpointContract).toHaveBeenCalledWith(
      adminManualReconcilePaymentContract,
      {
        pathParams: { id: "550e8400-e29b-41d4-a716-446655440000" },
        body: { reason: "customer sees paid but platform is pending" },
      },
    );
  });

  it("uses complete shared endpoint contracts for mock payment incident actions", async () => {
    await mockSucceed("PAY-1");
    await mockFail("PAY-2");

    expect(callAdminEndpointContract).toHaveBeenCalledWith(
      adminMockPaymentSucceedContract,
      { pathParams: { paymentNo: "PAY-1" } },
    );
    expect(callAdminEndpointContract).toHaveBeenCalledWith(
      adminMockPaymentFailContract,
      { pathParams: { paymentNo: "PAY-2" } },
    );
  });

  it("uses complete shared endpoint contracts for provider and provider-config writes", async () => {
    await updatePaymentProvider("550e8400-e29b-41d4-a716-446655440010", {
      name: "Wechat Pay",
      status: "enabled",
      capabilities: { qrCode: true },
    });
    await updatePaymentProviderConfig("550e8400-e29b-41d4-a716-446655440011", {
      merchantNo: null,
      publicConfigJson: {},
    });
    await upsertPaymentProviderConfig({
      providerCode: "alipay",
      appId: "2026000000000000",
      publicConfigJson: {},
    });
    await createPaymentIncidentAction("550e8400-e29b-41d4-a716-446655440012", {
      action: "request_refund_handling",
      reason: "operator verified the payment",
    });

    expect(callAdminEndpointContract).toHaveBeenCalledWith(
      adminUpdatePaymentProviderContract,
      {
        pathParams: { id: "550e8400-e29b-41d4-a716-446655440010" },
        body: expect.objectContaining({ name: "Wechat Pay" }),
      },
    );
    expect(callAdminEndpointContract).toHaveBeenCalledWith(
      adminUpdatePaymentProviderConfigContract,
      {
        pathParams: { id: "550e8400-e29b-41d4-a716-446655440011" },
        body: { merchantNo: null, publicConfigJson: {} },
      },
    );
    expect(callAdminEndpointContract).toHaveBeenCalledWith(
      adminUpsertPaymentProviderConfigContract,
      {
        body: expect.objectContaining({
          providerCode: "alipay",
          appId: "2026000000000000",
        }),
      },
    );
    expect(callAdminEndpointContract).toHaveBeenCalledWith(
      adminCreatePaymentIncidentActionContract,
      {
        pathParams: { id: "550e8400-e29b-41d4-a716-446655440012" },
        body: expect.objectContaining({
          action: "request_refund_handling",
        }),
      },
    );
  });

  it("uses complete shared endpoint contracts for refund and payment-code operator actions", async () => {
    await queryRefund("550e8400-e29b-41d4-a716-446655440020");
    await queryPaymentCodeAttempt("550e8400-e29b-41d4-a716-446655440021");
    await reversePaymentCodeAttempt(
      "550e8400-e29b-41d4-a716-446655440022",
      "operator reversed the attempt",
    );

    expect(callAdminEndpointContract).toHaveBeenCalledWith(
      adminQueryPaymentRefundContract,
      {
        pathParams: { id: "550e8400-e29b-41d4-a716-446655440020" },
        body: { reason: "admin_refund_status_query" },
      },
    );
    expect(callAdminEndpointContract).toHaveBeenCalledWith(
      adminQueryPaymentCodeAttemptContract,
      {
        pathParams: { id: "550e8400-e29b-41d4-a716-446655440021" },
        body: { reason: "admin_payment_code_query" },
      },
    );
    expect(callAdminEndpointContract).toHaveBeenCalledWith(
      adminReversePaymentCodeAttemptContract,
      {
        pathParams: { id: "550e8400-e29b-41d4-a716-446655440022" },
        body: { reason: "operator reversed the attempt" },
      },
    );
  });
});
