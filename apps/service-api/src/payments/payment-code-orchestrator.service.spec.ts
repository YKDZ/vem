import { afterEach, describe, expect, it, vi } from "vitest";

import type { PaymentProviderRuntimeConfig } from "./payment-provider.interface";

import { PaymentCodeOrchestratorService } from "./payment-code-orchestrator.service";

const baseConfig: PaymentProviderRuntimeConfig = {
  providerCode: "alipay",
  merchantNo: null,
  appId: null,
  publicConfigJson: {},
  sensitiveConfigJson: {},
};

type OrchestratorPrivateMethods = {
  wait(ms: number): Promise<void>;
  confirmAttempt(
    attemptId: string,
    providerCode: string,
    config: PaymentProviderRuntimeConfig,
  ): Promise<void>;
};

function makeHarness(overrides?: {
  config?: PaymentProviderRuntimeConfig;
  provider?: Record<string, unknown>;
  attempt?: Record<string, unknown>;
}) {
  let attempt = {
    id: "attempt-1",
    paymentId: "payment-1",
    orderId: "order-1",
    providerId: "provider-1",
    paymentProviderConfigId: "cfg-1",
    providerPaymentNo: "PCA001",
    providerTradeNo: null,
    attemptNo: 1,
    status: "created",
    isActive: true,
    failureMessage: null,
    failureCode: null,
    manualReason: null,
    ...overrides?.attempt,
  };
  const payment = {
    id: "payment-1",
    paymentNo: "PAY001",
    amountCents: 300,
    status: "pending",
    providerCode: overrides?.config?.providerCode ?? "alipay",
    providerId: "provider-1",
    orderId: "order-1",
    machineId: "machine-1",
  };

  const attempts = {
    createOrReplay: vi.fn().mockResolvedValue({
      payment,
      attempt,
      replayed: false,
    }),
    markStatus: vi.fn().mockImplementation(async (_id, status, patch = {}) => {
      attempt = {
        ...attempt,
        ...patch,
        status,
        isActive:
          patch.isActive ??
          !["succeeded", "failed", "reversed", "canceled"].includes(status),
      };
      return attempt;
    }),
    getById: vi.fn().mockImplementation(async () => attempt),
    getContextById: vi.fn().mockImplementation(async () => ({
      attempt,
      paymentNo: payment.paymentNo,
      orderNo: "ORD001",
      machineId: payment.machineId,
      providerCode: payment.providerCode,
      providerConfigId: "cfg-1",
    })),
  };

  const provider = {
    chargePaymentCode: vi.fn().mockResolvedValue({
      status: "succeeded",
      providerTradeNo: "ALI-TXN-001",
      providerStatus: "TRADE_SUCCESS",
      rawPayload: { code: "10000" },
    }),
    queryPaymentCode: vi.fn().mockResolvedValue({
      status: "processing",
      providerTradeNo: "ALI-TXN-001",
      providerStatus: "WAIT_BUYER_PAY",
      rawPayload: { trade_status: "WAIT_BUYER_PAY" },
    }),
    reversePaymentCode: vi.fn().mockResolvedValue({
      status: "reversed",
      recall: false,
      providerStatus: "TRADE_CLOSED",
      rawPayload: { action: "cancel" },
    }),
    ...overrides?.provider,
  };
  const registry = {
    getPaymentCodeProvider: vi.fn().mockReturnValue(provider),
  };
  const configService = {
    resolveForPayment: vi
      .fn()
      .mockResolvedValue(overrides?.config ?? baseConfig),
    resolveForExistingPayment: vi
      .fn()
      .mockResolvedValue(overrides?.config ?? baseConfig),
  };
  const paymentsService = {
    applyProviderPaymentResult: vi.fn().mockResolvedValue(true),
  };

  const service = new PaymentCodeOrchestratorService(
    attempts as never,
    registry as never,
    configService as never,
    paymentsService as never,
  );

  return {
    service,
    attempts,
    provider,
    paymentsService,
    getAttempt: () => attempt,
    setReplayAttempt(next: Record<string, unknown>) {
      attempts.createOrReplay.mockResolvedValue({
        payment,
        attempt: next,
        replayed: true,
      });
    },
  };
}

describe("PaymentCodeOrchestratorService", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("applies provider payment result when charge succeeds", async () => {
    const { service, paymentsService } = makeHarness();

    const result = await service.submit({
      orderNo: "ORD001",
      machineCode: "M001",
      authCode: "28763443825664394",
      idempotencyKey: "idem-1",
      source: "tauri_scanner",
      clientIp: "127.0.0.1",
    });

    expect(result.status).toBe("succeeded");
    expect(result.nextAction).toBe("dispensing");
    expect(paymentsService.applyProviderPaymentResult).toHaveBeenCalledTimes(1);
  });

  it("polls user_confirming attempt until query succeeds and applies success once", async () => {
    const { service, paymentsService } = makeHarness({
      provider: {
        queryPaymentCode: vi.fn().mockResolvedValue({
          status: "succeeded",
          providerTradeNo: "ALI-TXN-002",
          providerStatus: "TRADE_SUCCESS",
          rawPayload: { trade_status: "TRADE_SUCCESS" },
        }),
      },
      attempt: {
        status: "user_confirming",
        providerTradeNo: "ALI-TXN-002",
      },
    });
    const privateApi = service as unknown as OrchestratorPrivateMethods;
    vi.spyOn(privateApi, "wait").mockResolvedValue(undefined);

    await privateApi.confirmAttempt("attempt-1", "alipay", baseConfig);

    expect(paymentsService.applyProviderPaymentResult).toHaveBeenCalledTimes(1);
    expect(paymentsService.applyProviderPaymentResult).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: "payment-1",
        providerTradeNo: "ALI-TXN-002",
        status: "succeeded",
      }),
    );
  });

  it("reverses after query stays pending until deadline and replayed attempt can retry", async () => {
    const config: PaymentProviderRuntimeConfig = {
      ...baseConfig,
      publicConfigJson: {
        paymentCodePollIntervalSeconds: 1,
        paymentCodeMaxConfirmSeconds: 1,
      },
    };
    const { service, provider, getAttempt, setReplayAttempt } = makeHarness({
      config,
      provider: {
        queryPaymentCode: vi.fn().mockResolvedValue({
          status: "processing",
          providerTradeNo: "ALI-TXN-003",
          providerStatus: "WAIT_BUYER_PAY",
          rawPayload: { trade_status: "WAIT_BUYER_PAY" },
        }),
        reversePaymentCode: vi.fn().mockResolvedValue({
          status: "reversed",
          recall: false,
          providerStatus: "TRADE_CLOSED",
          rawPayload: { action: "cancel" },
        }),
      },
      attempt: {
        status: "querying",
        providerTradeNo: "ALI-TXN-003",
      },
    });
    const privateApi = service as unknown as OrchestratorPrivateMethods;
    vi.spyOn(privateApi, "wait").mockResolvedValue(undefined);
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValue(2_000);

    await privateApi.confirmAttempt("attempt-1", "alipay", config);

    expect(provider.reversePaymentCode).toHaveBeenCalledTimes(1);
    setReplayAttempt({ ...getAttempt(), status: "reversed", isActive: false });

    const result = await service.submit({
      orderNo: "ORD001",
      machineCode: "M001",
      authCode: "28763443825664394",
      idempotencyKey: "idem-replay",
      source: "tauri_scanner",
      clientIp: "127.0.0.1",
    });

    expect(result.status).toBe("reversed");
    expect(result.canRetry).toBe(true);
  });

  it("marks attempt manual_handling after three reverse unknown results", async () => {
    const { service, provider, attempts, paymentsService, getAttempt } =
      makeHarness({
        provider: {
          reversePaymentCode: vi.fn().mockResolvedValue({
            status: "unknown",
            recall: true,
            providerStatus: "SYSTEMERROR",
            rawPayload: { err_code: "SYSTEMERROR" },
          }),
        },
        attempt: {
          status: "querying",
          providerTradeNo: "ALI-TXN-004",
        },
      });

    await service.reverseUnknownAttempt("attempt-1", "alipay", baseConfig);

    expect(provider.reversePaymentCode).toHaveBeenCalledTimes(3);
    expect(attempts.markStatus).toHaveBeenLastCalledWith(
      "attempt-1",
      "manual_handling",
      expect.objectContaining({
        manualReason: "reverse_result_unknown_after_retries",
      }),
    );
    expect(getAttempt().status).toBe("manual_handling");
    expect(paymentsService.applyProviderPaymentResult).not.toHaveBeenCalled();
  });
});
