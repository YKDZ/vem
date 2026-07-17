import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  PaymentCodeCapableProvider,
  PaymentProviderRuntimeConfig,
} from "./payment-provider.interface";

import { MockPaymentProvider } from "./mock-payment.provider";
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
  providerInstance?: PaymentCodeCapableProvider;
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
  const updateAttempt = (
    status: string,
    patch: Record<string, unknown> = {},
  ) => {
    const patchIsActive =
      typeof patch.isActive === "boolean" ? patch.isActive : undefined;
    attempt = {
      ...attempt,
      ...patch,
      status,
      isActive:
        patchIsActive ??
        !["succeeded", "failed", "reversed", "canceled"].includes(status),
    };
    return attempt;
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
    createOrReplay: vi.fn(),
    markStatus: vi.fn().mockImplementation(async (_id, status, patch = {}) => {
      return updateAttempt(status, patch);
    }),
    markStatusIfCurrentStatusIn: vi
      .fn()
      .mockImplementation(async (_id, status, allowedStatuses, patch = {}) => {
        if (!allowedStatuses.includes(attempt.status)) return null;
        return updateAttempt(status, patch);
      }),
    toDto: vi.fn(),
    listAttempts: vi.fn(),
    latestForPayment: vi.fn(),
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

  attempts.createOrReplay.mockResolvedValue({
    payment,
    attempt,
    replayed: false,
  });

  const defaultProvider = {
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
  const provider = overrides?.providerInstance ?? defaultProvider;
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
    assertMachinePaymentChannelAvailable: vi.fn().mockResolvedValue(undefined),
  };
  const paymentsService = {
    applyProviderPaymentResult: vi.fn().mockResolvedValue(true),
  };

  const service = new PaymentCodeOrchestratorService(
    attempts as never,
    registry as never,
    configService as never,
    paymentsService as never,
    { paymentMockEnabled: true } as never,
  );

  return {
    service,
    attempts,
    provider,
    configService,
    paymentsService,
    getAttempt: () => attempt,
    setAttempt(next: Record<string, unknown>) {
      attempt = { ...attempt, ...next };
    },
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
    const { service, attempts, paymentsService } = makeHarness();

    const result = await service.submit({
      orderNo: "ORD001",
      machineCode: "M001",
      authCode: "28763443825664394",
      idempotencyKey: "idem-1",
      source: "serial_text",
      clientIp: "127.0.0.1",
    });

    expect(result.status).toBe("succeeded");
    expect(result.nextAction).toBe("dispensing");
    expect(attempts.markStatus).toHaveBeenCalledWith(
      "attempt-1",
      "succeeded",
      expect.objectContaining({
        failureCode: null,
        failureMessage: null,
        manualReason: null,
      }),
    );
    expect(paymentsService.applyProviderPaymentResult).toHaveBeenCalledTimes(1);
  });

  it("uses the test provider through the normal scanner submit and payment transition", async () => {
    const mockProvider = new MockPaymentProvider({
      paymentMockEnabled: true,
      paymentWebhookBaseUrl: "http://localhost:3000/api/payments/webhooks",
    } as never);
    const { service, paymentsService } = makeHarness({
      config: {
        providerCode: "mock",
        merchantNo: null,
        appId: null,
        publicConfigJson: {},
        sensitiveConfigJson: {},
      },
      providerInstance: mockProvider,
    });

    const result = await service.submit({
      orderNo: "ORD001",
      machineCode: "M001",
      authCode: "28763443825664394",
      idempotencyKey: "idem-mock-serial",
      source: "serial_text",
      clientIp: "127.0.0.1",
    });

    expect(result).toMatchObject({
      status: "succeeded",
      nextAction: "dispensing",
    });
    expect(paymentsService.applyProviderPaymentResult).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: "payment-1",
        providerTradeNo: "MOCK-CODE-PCA001",
        status: "succeeded",
      }),
    );
  });

  it("does not return dispensing when provider success cannot be safely applied", async () => {
    const { service, attempts, paymentsService } = makeHarness();
    paymentsService.applyProviderPaymentResult.mockResolvedValueOnce(false);

    const result = await service.submit({
      orderNo: "ORD001",
      machineCode: "M001",
      authCode: "28763443825664394",
      idempotencyKey: "idem-apply-false",
      source: "serial_text",
      clientIp: "127.0.0.1",
    });

    expect(result.status).toBe("manual_handling");
    expect(result.nextAction).toBe("manual_handling");
    expect(result.message).toBe("支付结果需人工核验");
    expect(attempts.markStatus).toHaveBeenCalledWith(
      "attempt-1",
      "manual_handling",
      expect.objectContaining({
        failureCode: "PAYMENT_RESULT_NOT_APPLIED",
        manualReason: "payment_result_not_applied",
      }),
    );
  });

  it("rejects submit when payment_code channel is provider-blocked", async () => {
    const { service, provider, configService } = makeHarness();
    configService.assertMachinePaymentChannelAvailable.mockRejectedValue(
      new Error("Payment channel is not available"),
    );

    await expect(
      service.submit({
        orderNo: "ORD001",
        machineCode: "M001",
        authCode: "28763443825664394",
        idempotencyKey: "idem-blocked",
        source: "serial_text",
        clientIp: "127.0.0.1",
      }),
    ).rejects.toThrow("Payment channel is not available");

    expect(
      configService.assertMachinePaymentChannelAvailable,
    ).toHaveBeenCalledWith({
      machineId: "machine-1",
      providerCode: "alipay",
      method: "payment_code",
    });
    expect(configService.resolveForPayment).not.toHaveBeenCalled();
    expect(provider.chargePaymentCode).not.toHaveBeenCalled();
  });

  it("does not reach a provider when durable payment-code admission rejects the order", async () => {
    const { service, attempts, provider, configService } = makeHarness();
    attempts.createOrReplay.mockRejectedValue(
      new Error("payment_code_order_not_payable"),
    );

    await expect(
      service.submit({
        orderNo: "ORD001",
        machineCode: "M001",
        authCode: "28763443825664394",
        idempotencyKey: "idem-not-payable",
        source: "serial_text",
        clientIp: "127.0.0.1",
      }),
    ).rejects.toThrow("payment_code_order_not_payable");

    expect(
      configService.assertMachinePaymentChannelAvailable,
    ).not.toHaveBeenCalled();
    expect(provider.chargePaymentCode).not.toHaveBeenCalled();
  });

  it("keeps indeterminate charge result active for provider query instead of retry", async () => {
    const { service, attempts, paymentsService } = makeHarness({
      provider: {
        chargePaymentCode: vi.fn().mockResolvedValue({
          status: "unknown",
          providerTradeNo: null,
          providerStatus: "ALIPAY_REQUEST_UNKNOWN",
          failureCode: "ALIPAY_REQUEST_UNKNOWN",
          failureMessage:
            "HttpClient Request error: Request timeout for 5000 ms",
          rawPayload: {},
        }),
      },
    });
    vi.spyOn(
      service as unknown as { confirmLater: () => Promise<void> },
      "confirmLater",
    ).mockResolvedValue(undefined);

    const result = await service.submit({
      orderNo: "ORD001",
      machineCode: "M001",
      authCode: "28763443825664394",
      idempotencyKey: "idem-timeout",
      source: "serial_text",
      clientIp: "127.0.0.1",
    });

    expect(result.status).toBe("querying");
    expect(result.canRetry).toBe(false);
    expect(result.nextAction).toBe("wait_payment");
    expect(attempts.markStatus).toHaveBeenCalledWith(
      "attempt-1",
      "querying",
      expect.objectContaining({
        failureCode: "ALIPAY_REQUEST_UNKNOWN",
      }),
    );
    expect(paymentsService.applyProviderPaymentResult).not.toHaveBeenCalled();
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

  it("manual query can converge an unknown attempt to success", async () => {
    const { service, provider, paymentsService } = makeHarness({
      provider: {
        queryPaymentCode: vi.fn().mockResolvedValue({
          status: "succeeded",
          providerTradeNo: "ALI-TXN-UNKNOWN",
          providerStatus: "TRADE_SUCCESS",
          rawPayload: { trade_status: "TRADE_SUCCESS" },
        }),
      },
      attempt: {
        status: "unknown",
        providerTradeNo: "ALI-TXN-UNKNOWN",
      },
    });

    const result = await service.manualQuery("attempt-1");

    expect(provider.queryPaymentCode).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("succeeded");
    expect(paymentsService.applyProviderPaymentResult).toHaveBeenCalledTimes(1);
    expect(paymentsService.applyProviderPaymentResult).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: "payment-1",
        providerTradeNo: "ALI-TXN-UNKNOWN",
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
    expect(getAttempt()).toMatchObject({
      status: "reversed",
      failureMessage: "本次付款码交易已撤销，请刷新付款码后重试",
    });
    setReplayAttempt({ ...getAttempt(), status: "reversed", isActive: false });

    const result = await service.submit({
      orderNo: "ORD001",
      machineCode: "M001",
      authCode: "28763443825664394",
      idempotencyKey: "idem-replay",
      source: "serial_text",
      clientIp: "127.0.0.1",
    });

    expect(result.status).toBe("reversed");
    expect(result.canRetry).toBe(true);
    expect(result.message).toBe("本次付款码交易已撤销，请刷新付款码后重试");
  });

  it("marks attempt manual_handling after three reverse unknown results", async () => {
    const config: PaymentProviderRuntimeConfig = {
      ...baseConfig,
      publicConfigJson: { paymentCodeReverseMaxAttempts: 3 },
    };
    const { service, provider, attempts, paymentsService, getAttempt } =
      makeHarness({
        config,
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
    const privateApi = service as unknown as OrchestratorPrivateMethods;
    vi.spyOn(privateApi, "wait").mockResolvedValue(undefined);

    await service.reverseUnknownAttempt("attempt-1", "alipay", config);

    expect(provider.reversePaymentCode).toHaveBeenCalledTimes(3);
    expect(attempts.markStatusIfCurrentStatusIn).toHaveBeenLastCalledWith(
      "attempt-1",
      "manual_handling",
      expect.any(Array),
      expect.objectContaining({
        manualReason: "reverse_result_unknown_after_retries",
      }),
    );
    expect(getAttempt().status).toBe("manual_handling");
    expect(paymentsService.applyProviderPaymentResult).not.toHaveBeenCalled();
  });

  it("marks attempt manual_handling instead of leaving reversing when reverse throws", async () => {
    const config: PaymentProviderRuntimeConfig = {
      ...baseConfig,
      publicConfigJson: { paymentCodeReverseMaxAttempts: 3 },
    };
    const { service, provider, attempts, getAttempt } = makeHarness({
      config,
      provider: {
        reversePaymentCode: vi
          .fn()
          .mockRejectedValue(
            new Error("HttpClient Request error: Request timeout for 5000 ms"),
          ),
      },
      attempt: {
        status: "querying",
        providerTradeNo: "ALI-TXN-REVERSE-TIMEOUT",
      },
    });
    const privateApi = service as unknown as OrchestratorPrivateMethods;
    vi.spyOn(privateApi, "wait").mockResolvedValue(undefined);

    await expect(
      service.reverseUnknownAttempt("attempt-1", "alipay", config),
    ).resolves.toBeUndefined();

    expect(provider.reversePaymentCode).toHaveBeenCalledTimes(3);
    expect(attempts.markStatusIfCurrentStatusIn).toHaveBeenLastCalledWith(
      "attempt-1",
      "manual_handling",
      expect.any(Array),
      expect.objectContaining({
        isActive: true,
        manualReason: "reverse_result_unknown_after_retries",
      }),
    );
    expect(getAttempt()).toMatchObject({
      status: "manual_handling",
      failureCode: "PAYMENT_CODE_REVERSE_UNKNOWN",
      failureMessage: "HttpClient Request error: Request timeout for 5000 ms",
    });
  });

  it("clears stale failure fields when manual query confirms success", async () => {
    const { service, attempts, paymentsService, getAttempt } = makeHarness({
      provider: {
        queryPaymentCode: vi.fn().mockResolvedValue({
          status: "succeeded",
          providerTradeNo: "ALI-TXN-005",
          providerStatus: "TRADE_SUCCESS",
          rawPayload: { trade_status: "TRADE_SUCCESS" },
        }),
      },
      attempt: {
        status: "querying",
        providerTradeNo: "ALI-TXN-005",
        failureCode: "PROVIDER_EXCEPTION",
        failureMessage: "HttpClient Request error: Request timeout for 5000 ms",
        manualReason: "previous_manual_note",
      },
    });

    const updated = await service.manualQuery("attempt-1");

    expect(updated.status).toBe("succeeded");
    expect(getAttempt().failureCode).toBeNull();
    expect(getAttempt().failureMessage).toBeNull();
    expect(getAttempt().manualReason).toBeNull();
    expect(attempts.markStatusIfCurrentStatusIn).toHaveBeenCalledWith(
      "attempt-1",
      "succeeded",
      expect.any(Array),
      expect.objectContaining({
        failureCode: null,
        failureMessage: null,
        manualReason: null,
      }),
    );
    expect(paymentsService.applyProviderPaymentResult).toHaveBeenCalledTimes(1);
  });

  it("does not query provider or apply payment again for an already succeeded attempt", async () => {
    const { service, provider, paymentsService, getAttempt } = makeHarness({
      attempt: {
        status: "succeeded",
        isActive: false,
        providerTradeNo: "ALI-TXN-PAID",
        finishedAt: new Date("2026-06-26T04:00:00.000Z"),
      },
    });

    const result = await service.manualQuery("attempt-1");

    expect(result).toBe(getAttempt());
    expect(provider.queryPaymentCode).not.toHaveBeenCalled();
    expect(paymentsService.applyProviderPaymentResult).not.toHaveBeenCalled();
  });

  it("does not reverse an already failed terminal attempt", async () => {
    const { service, provider, getAttempt } = makeHarness({
      attempt: {
        status: "failed",
        isActive: false,
        failureCode: "PAYMENT_CODE_FAILED",
        finishedAt: new Date("2026-06-26T04:00:00.000Z"),
      },
    });

    const result = await service.manualReverse(
      "attempt-1",
      "admin_manual_reverse",
    );

    expect(result).toBe(getAttempt());
    expect(provider.reversePaymentCode).not.toHaveBeenCalled();
  });

  it("does not apply manual query success when a terminal update wins the race", async () => {
    const { service, attempts, provider, paymentsService, setAttempt } =
      makeHarness({
        provider: {
          queryPaymentCode: vi.fn().mockResolvedValue({
            status: "succeeded",
            providerTradeNo: "ALI-TXN-RACE",
            providerStatus: "TRADE_SUCCESS",
            rawPayload: { trade_status: "TRADE_SUCCESS" },
          }),
        },
        attempt: {
          status: "querying",
          providerTradeNo: "ALI-TXN-RACE",
        },
      });
    attempts.markStatusIfCurrentStatusIn.mockImplementationOnce(async () => {
      setAttempt({
        status: "reversed",
        isActive: false,
        finishedAt: new Date("2026-06-26T04:01:00.000Z"),
      });
      return null;
    });

    const result = await service.manualQuery("attempt-1");

    expect(result.status).toBe("reversed");
    expect(provider.queryPaymentCode).toHaveBeenCalledTimes(1);
    expect(paymentsService.applyProviderPaymentResult).not.toHaveBeenCalled();
  });

  it("does not let background polling success overwrite a reversed attempt", async () => {
    const { service, attempts, provider, paymentsService, setAttempt } =
      makeHarness({
        provider: {
          queryPaymentCode: vi.fn().mockResolvedValue({
            status: "succeeded",
            providerTradeNo: "ALI-TXN-POLL-RACE",
            providerStatus: "TRADE_SUCCESS",
            rawPayload: { trade_status: "TRADE_SUCCESS" },
          }),
        },
        attempt: {
          status: "querying",
          providerTradeNo: "ALI-TXN-POLL-RACE",
        },
      });
    const privateApi = service as unknown as OrchestratorPrivateMethods;
    vi.spyOn(privateApi, "wait").mockResolvedValue(undefined);
    attempts.markStatusIfCurrentStatusIn.mockImplementationOnce(async () => {
      setAttempt({
        status: "reversed",
        isActive: false,
        finishedAt: new Date("2026-06-26T04:01:00.000Z"),
      });
      return null;
    });

    await privateApi.confirmAttempt("attempt-1", "alipay", baseConfig);

    expect(provider.queryPaymentCode).toHaveBeenCalledTimes(1);
    expect(paymentsService.applyProviderPaymentResult).not.toHaveBeenCalled();
  });
});
