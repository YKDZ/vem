import { afterEach, describe, expect, it, vi } from "vitest";

import type { PaymentCodeAttemptRow } from "./payment-code-attempts.service";

import { PaymentCodeOrchestratorService } from "./payment-code-orchestrator.service";

function makeAttempt(
  patch: Partial<PaymentCodeAttemptRow> = {},
): PaymentCodeAttemptRow {
  return {
    id: "attempt-1",
    paymentId: "payment-1",
    orderId: "order-1",
    providerId: "provider-1",
    paymentProviderConfigId: "config-1",
    attemptNo: 1,
    providerPaymentNo: "PCA-001",
    idempotencyKey: "scan-1",
    status: "created",
    isActive: true,
    amountCents: 300,
    currency: "CNY",
    authCodeHash: "hash",
    authCodeMasked: "2876****4394",
    source: "serial_text",
    scannerHealthJson: null,
    providerTradeNo: null,
    providerStatus: null,
    failureCode: null,
    failureMessage: null,
    rawPayloadJson: null,
    manualReason: null,
    submittedAt: null,
    lastCheckedAt: null,
    reversedAt: null,
    finishedAt: null,
    recoveryLeaseOwnerToken: null,
    recoveryLeaseExpiresAt: null,
    recoveryLeaseFence: 0,
    recoveryAttemptCount: 0,
    recoveryNextAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...patch,
  } as PaymentCodeAttemptRow;
}

function makeHarness(input?: {
  attempt?: PaymentCodeAttemptRow;
  replayed?: boolean;
  workerResult?: PaymentCodeAttemptRow;
}) {
  const attempt = input?.attempt ?? makeAttempt();
  const worker = {
    submitAttempt: vi.fn().mockResolvedValue(input?.workerResult ?? attempt),
    requestManualQuery: vi.fn().mockResolvedValue(attempt),
    requestManualReverse: vi.fn().mockResolvedValue(attempt),
  };
  const attempts = {
    createOrReplay: vi.fn().mockResolvedValue({
      payment: { paymentNo: "PAY-001" },
      attempt,
      replayed: input?.replayed ?? false,
    }),
  };
  const service = new PaymentCodeOrchestratorService(
    attempts as never,
    worker as never,
    { paymentMockEnabled: true } as never,
  );

  return { service, attempts, worker };
}

describe("PaymentCodeOrchestratorService", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("persists scan intent then lets the durable worker own submission", async () => {
    const succeeded = makeAttempt({
      status: "succeeded",
      isActive: false,
      providerTradeNo: "MOCK-PCA-001",
      finishedAt: new Date(),
    });
    const { service, attempts, worker } = makeHarness({
      workerResult: succeeded,
    });

    const result = await service.submit({
      orderNo: "ORD-001",
      machineCode: "M-001",
      authCode: "28763443825664394",
      idempotencyKey: "scan-1",
      source: "serial_text",
      scannerEventId: "evt-scanner-1",
      scannerHealth: {
        online: true,
        adapter: "serial_text",
        port: "ttyUSB0",
      },
      clientIp: "127.0.0.1",
    });

    expect(attempts.createOrReplay).toHaveBeenCalledWith({
      orderNo: "ORD-001",
      machineCode: "M-001",
      authCode: "28763443825664394",
      idempotencyKey: "scan-1",
      source: "serial_text",
      scannerHealthJson: {
        online: true,
        adapter: "serial_text",
        port: "ttyUSB0",
        scannerEventId: "evt-scanner-1",
      },
      mockPaymentEnabled: true,
    });
    expect(worker.submitAttempt).toHaveBeenCalledWith({
      attemptId: "attempt-1",
      authCode: "28763443825664394",
      clientIp: "127.0.0.1",
    });
    expect(result).toMatchObject({
      status: "succeeded",
      nextAction: "dispensing",
      canRetry: false,
    });
  });

  it("returns an idempotency replay without starting a second provider operation", async () => {
    const { service, worker } = makeHarness({
      attempt: makeAttempt({ status: "querying", isActive: true }),
      replayed: true,
    });

    const result = await service.submit({
      orderNo: "ORD-001",
      machineCode: "M-001",
      authCode: "28763443825664394",
      idempotencyKey: "scan-1",
      source: "serial_text",
      clientIp: null,
    });

    expect(worker.submitAttempt).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "querying",
      nextAction: "wait_payment",
      canRetry: false,
    });
  });

  it("makes a provider-rejected attempt retryable without reopening it locally", async () => {
    const { service, worker } = makeHarness({
      workerResult: makeAttempt({
        status: "failed",
        isActive: false,
        failureMessage: "付款码无效",
      }),
    });

    const result = await service.submit({
      orderNo: "ORD-001",
      machineCode: "M-001",
      authCode: "28763443825664394",
      idempotencyKey: "scan-1",
      source: "serial_text",
      clientIp: null,
    });

    expect(worker.submitAttempt).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: "failed",
      nextAction: "wait_payment",
      canRetry: true,
      message: "付款码无效",
    });
  });

  it("routes manual query and reversal requests to the durable worker", async () => {
    const { service, worker } = makeHarness();

    await service.manualQuery("attempt-1");
    await service.manualReverse("attempt-1", "operator_requested");

    expect(worker.requestManualQuery).toHaveBeenCalledWith("attempt-1");
    expect(worker.requestManualReverse).toHaveBeenCalledWith(
      "attempt-1",
      "operator_requested",
    );
  });
});
