import { describe, expect, it, vi } from "vitest";

import type { AppConfigService } from "../config/app-config.service";
import type { PaymentConfigSecretService } from "./payment-config-secret.service";
import type { PaymentProviderConfigService } from "./payment-provider-config.service";

import { PaymentOpsService } from "./payment-ops.service";

// ---- helpers ---------------------------------------------------------------

function makeDb() {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
    }),
    insert: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn(),
  };
}

function makeConfig(
  overrides: Partial<{
    nodeEnv: "development" | "test" | "production";
    paymentMockEnabled: boolean;
    paymentAlertWindowMinutes: number;
    paymentCertificateExpiryWarningDays: number;
    machineHeartbeatTimeoutSeconds: number;
    notifyUrlCheck: ReturnType<
      AppConfigService["getPaymentNotifyUrlStaticCheck"]
    >;
  }> = {},
): AppConfigService {
  return {
    nodeEnv: overrides.nodeEnv ?? "development",
    paymentMockEnabled: overrides.paymentMockEnabled ?? false,
    paymentAlertWindowMinutes: overrides.paymentAlertWindowMinutes ?? 60,
    paymentCertificateExpiryWarningDays:
      overrides.paymentCertificateExpiryWarningDays ?? 30,
    machineHeartbeatTimeoutSeconds:
      overrides.machineHeartbeatTimeoutSeconds ?? 120,
    getPaymentNotifyUrlStaticCheck: vi.fn().mockReturnValue(
      overrides.notifyUrlCheck ?? {
        providerCode: "alipay",
        notifyUrl: "https://pay.example.com/api/payments/webhooks/alipay",
        usesHttps: true,
        isLocalhost: false,
        pathMatchesWebhookRoute: true,
      },
    ),
  } as unknown as AppConfigService;
}

function makeProviderConfigs(): PaymentProviderConfigService {
  return {
    resolveForPayment: vi.fn().mockResolvedValue({
      providerCode: "alipay",
      merchantNo: null,
      appId: null,
      publicConfigJson: {},
      sensitiveConfigJson: {},
    }),
    listMachinePaymentOptionsForMachine: vi.fn().mockResolvedValue({
      options: [
        {
          providerCode: "alipay",
          method: "qr_code",
          displayName: "支付宝",
          description: "请使用支付宝扫码支付",
          icon: "alipay",
          recommended: true,
        },
      ],
      defaultProviderCode: "alipay",
      serverTime: new Date().toISOString(),
    }),
  } as unknown as PaymentProviderConfigService;
}

function makeSecrets(): PaymentConfigSecretService {
  return {
    decrypt: vi.fn().mockReturnValue({}),
    summarize: vi.fn().mockReturnValue({}),
  } as unknown as PaymentConfigSecretService;
}

function makeService(options: {
  db?: ReturnType<typeof makeDb>;
  config?: AppConfigService;
  secrets?: PaymentConfigSecretService;
  providerConfigs?: PaymentProviderConfigService;
}) {
  const db = options.db ?? makeDb();
  const config = options.config ?? makeConfig();
  const secrets = options.secrets ?? makeSecrets();
  const providerConfigs = options.providerConfigs ?? makeProviderConfigs();
  return new PaymentOpsService(db as never, config, secrets, providerConfigs);
}

function mockMachinePreflightSelects(
  db: ReturnType<typeof makeDb>,
  heartbeatRows: unknown[],
  machineOverrides: Partial<{
    id: string;
    code: string;
    status: string;
    lastSeenAt: Date | null;
  }> = {},
) {
  let selectCallCount = 0;
  db.select.mockImplementation(() => {
    const callIdx = selectCallCount++;
    const result =
      callIdx === 0
        ? [
            {
              id: "mach-003",
              code: "M003",
              status: "online",
              lastSeenAt: new Date(),
              ...machineOverrides,
            },
          ]
        : heartbeatRows;
    const whereResult = {
      limit: vi.fn().mockResolvedValue(result.slice(0, 1)),
      orderBy: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(result.slice(0, 1)),
      }),
    };
    return {
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue(whereResult),
      }),
    };
  });
}

/** Helper to set up db.select with specific results for different calls */
function buildSelectSequence(
  db: ReturnType<typeof makeDb>,
  results: unknown[],
) {
  let callIndex = 0;
  db.select.mockImplementation(() => ({
    from: vi.fn().mockImplementation(() => {
      const result = Array.isArray(results[callIndex])
        ? (results[callIndex++] as unknown[])
        : results[callIndex++] !== undefined
          ? [results[callIndex - 1]]
          : [];
      // Make where() both awaitable AND chainable with .limit()
      const whereResult = Object.assign(Promise.resolve(result), {
        limit: vi.fn().mockResolvedValue(result.slice(0, 1)),
        orderBy: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(result.slice(0, 1)),
        }),
      });
      return {
        where: vi.fn().mockReturnValue(whereResult),
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(result),
        }),
        limit: vi.fn().mockResolvedValue(result.slice(0, 1)),
      };
    }),
  }));
}

// ---- tests -----------------------------------------------------------------

describe("PaymentOpsService.getReadiness", () => {
  it("mock env false + mock provider disabled → mock_provider_disabled.passed=true", async () => {
    const db = makeDb();
    // All selects return empty/zero counts for this test (no issues)
    buildSelectSequence(db, [
      // checkMockProviderDisabled: mock provider query → null (not found)
      [],
      // checkRealProviderConfigsPresent: no real configs
      [],
      // checkMachineRealProviderOptionsAvailable: no online machines
      [],
      // checkCertificates: no enabled configs
      [],
      // checkRecentWebhookFailures: 0 failures
      [{ total: 0 }],
      // checkRecentReconciliationFailures: 0 failures
      [{ total: 0 }],
      // checkRefundBacklog: 0 backlog
      [{ total: 0 }],
    ]);

    const service = makeService({
      db,
      config: makeConfig({ nodeEnv: "development", paymentMockEnabled: false }),
    });

    const result = await service.getReadiness();
    const mockCheck = result.checks.find(
      (c) => c.code === "mock_provider_disabled",
    );
    expect(mockCheck?.passed).toBe(true);
  });

  it("production + localhost/http notify → notify_url_static_check.passed=false", async () => {
    const db = makeDb();
    buildSelectSequence(db, [
      [],
      [],
      [],
      [],
      [{ total: 0 }],
      [{ total: 0 }],
      [{ total: 0 }],
    ]);

    const service = makeService({
      db,
      config: makeConfig({
        nodeEnv: "production",
        paymentMockEnabled: false,
        notifyUrlCheck: {
          providerCode: "alipay",
          notifyUrl: "http://localhost:3000/api/payments/webhooks/alipay",
          usesHttps: false,
          isLocalhost: true,
          pathMatchesWebhookRoute: true,
        },
      }),
    });

    const result = await service.getReadiness();
    const urlCheck = result.checks.find(
      (c) => c.code === "notify_url_static_check",
    );
    expect(urlCheck?.passed).toBe(false);
    expect(result.status).toBe("blocked");
  });

  it("webhook attempt signature invalid → readiness status=blocked", async () => {
    const db = makeDb();
    buildSelectSequence(db, [
      [], // mock provider check
      [], // real provider check
      [], // machine real provider check (no online machines)
      [], // cert check
      [{ total: 3 }], // webhook failures
      [{ total: 0 }], // reconciliation
      [{ total: 0 }], // refund backlog
    ]);

    const service = makeService({ db });
    const result = await service.getReadiness();
    expect(result.status).toBe("blocked");
    const webhookCheck = result.checks.find(
      (c) => c.code === "recent_webhook_failures",
    );
    expect(webhookCheck?.passed).toBe(false);
  });

  it("only machine-level real provider enabled → real_provider_config_present.passed=true", async () => {
    const db = makeDb();
    let selectCallCount = 0;
    db.select.mockImplementation(() => {
      const callIdx = selectCallCount++;
      return {
        from: vi.fn().mockImplementation(() => {
          if (callIdx === 1) {
            // checkRealProviderConfigsPresent: has machine-level enabled config with all required fields
            return {
              innerJoin: vi.fn().mockReturnValue({
                where: vi.fn().mockResolvedValue([
                  {
                    providerCode: "alipay",
                    providerStatus: "enabled",
                    configStatus: "enabled",
                    machineId: "mach-001",
                    merchantNo: "MERCHANT001",
                    appId: "APP001",
                    publicConfigJson: {
                      gatewayUrl: "https://openapi.alipay.com",
                    },
                    configEncryptedJson: {
                      v: 1,
                      alg: "aes-256-gcm",
                      iv: "yyy",
                      tag: "zzz",
                      ciphertext: "xxx",
                    },
                  },
                ]),
              }),
            };
          }
          if (callIdx === 2) {
            // checkMachineRealProviderOptionsAvailable: no online machines
            const noMachines = Object.assign(Promise.resolve([]), {
              limit: vi.fn().mockResolvedValue([]),
            });
            return {
              where: vi.fn().mockReturnValue(noMachines),
              innerJoin: vi.fn().mockReturnValue({
                where: vi.fn().mockResolvedValue([]),
              }),
              limit: vi.fn().mockResolvedValue([]),
            };
          }
          // All other checks: no rows (empty counts)
          const zeroRow = [{ total: 0 }];
          const whereResult = Object.assign(Promise.resolve(zeroRow), {
            limit: vi.fn().mockResolvedValue([]),
          });
          return {
            where: vi.fn().mockReturnValue(whereResult),
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([]),
            }),
            limit: vi.fn().mockResolvedValue([]),
          };
        }),
      };
    });

    const service = makeService({ db });
    const result = await service.getReadiness();
    const providerCheck = result.checks.find(
      (c) => c.code === "real_provider_config_present",
    );
    expect(providerCheck?.passed).toBe(true);
  });
});

describe("PaymentOpsService.getMachinePreflight", () => {
  it("machine not found → status=blocked with machine_not_found check", async () => {
    const db = makeDb();
    buildSelectSequence(db, [[]]);

    const service = makeService({ db });
    const result = await service.getMachinePreflight(
      "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
    );
    expect(result.status).toBe("blocked");
    expect(result.checks[0]?.code).toBe("machine_not_found");
  });

  it("machine online with no real providers → machine_real_provider_available.passed=false", async () => {
    const db = makeDb();
    buildSelectSequence(db, [
      [{ id: "mach-001", code: "M001", status: "online" }],
    ]);

    const providerConfigs = makeProviderConfigs();
    vi.mocked(
      providerConfigs.listMachinePaymentOptionsForMachine,
    ).mockResolvedValue({
      options: [],
      defaultOptionKey: null,
      defaultProviderCode: null,
      serverTime: new Date().toISOString(),
    });

    const service = makeService({ db, providerConfigs });
    const result = await service.getMachinePreflight("mach-001");
    expect(result.status).toBe("blocked");
    const providerCheck = result.checks.find(
      (c) => c.code === "machine_real_provider_available",
    );
    expect(providerCheck?.passed).toBe(false);
  });

  it("adds scanner health warning for payment_code without blocking ready machine", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-26T04:02:30.000Z"));
    const db = makeDb();
    buildSelectSequence(db, [
      [
        {
          id: "mach-002",
          code: "M002",
          status: "online",
          lastSeenAt: new Date("2026-06-26T04:02:00.000Z"),
        },
      ],
      [
        {
          reportedAt: new Date("2026-06-26T04:02:00.000Z"),
          receivedAt: new Date("2026-06-26T04:02:00.000Z"),
          statusPayloadJson: {
            hardwareAdapter: "serial",
            hardwarePortPath: "COM5",
            hardwareStatus: "ok",
          },
        },
      ],
    ]);

    try {
      const providerConfigs = makeProviderConfigs();
      vi.mocked(
        providerConfigs.listMachinePaymentOptionsForMachine,
      ).mockResolvedValue({
        options: [
          {
            optionKey: "payment_code:alipay",
            providerCode: "alipay",
            method: "payment_code",
            displayName: "支付宝付款码",
            description: "请出示支付宝付款码",
            icon: "alipay",
            disabled: false,
            disabledReason: null,
            recommended: true,
          },
        ],
        defaultOptionKey: "payment_code:alipay",
        defaultProviderCode: "alipay",
        serverTime: new Date().toISOString(),
      });

      const service = makeService({ db, providerConfigs });
      const result = await service.getMachinePreflight("mach-002");

      expect(result.status).toBe("ready");
      expect(
        result.checks.find(
          (check) => check.code === "payment_code.scanner_health_not_reported",
        ),
      ).toMatchObject({ severity: "warning", passed: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("blocks production machine preflight when runtime heartbeat reports mock dispense hardware", async () => {
    const db = makeDb();
    mockMachinePreflightSelects(db, [
      {
        reportedAt: new Date("2026-06-26T04:00:00.000Z"),
        statusPayloadJson: {
          hardwareAdapter: "mock",
          hardwarePortPath: null,
        },
      },
    ]);

    const service = makeService({
      db,
      config: makeConfig({ nodeEnv: "production" }),
    });
    const result = await service.getMachinePreflight("mach-003");

    expect(result.status).toBe("blocked");
    expect(
      result.checks.find(
        (check) => check.code === "production_dispense_path.mock",
      ),
    ).toMatchObject({
      severity: "critical",
      passed: false,
      message: "生产出货路径不能使用 mock hardwareAdapter",
    });
  });

  it("blocks production machine preflight when heartbeat reports tcp lower-controller simulator", async () => {
    const db = makeDb();
    mockMachinePreflightSelects(db, [
      {
        reportedAt: new Date("2026-06-26T04:01:00.000Z"),
        statusPayloadJson: {
          hardwareAdapter: "serial",
          hardwarePortPath: "tcp://127.0.0.1:17991",
        },
      },
    ]);

    const service = makeService({
      db,
      config: makeConfig({ nodeEnv: "production" }),
    });
    const result = await service.getMachinePreflight("mach-003");

    expect(result.status).toBe("blocked");
    expect(
      result.checks.find(
        (check) => check.code === "production_dispense_path.tcp_simulator",
      ),
    ).toMatchObject({
      severity: "critical",
      passed: false,
      evidence: {
        reportedAt: "2026-06-26T04:01:00.000Z",
        hardwareAdapter: "serial",
        hardwarePortPath: "tcp://127.0.0.1:17991",
      },
    });
  });

  it("allows production machine preflight when heartbeat reports real serial hardware", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-26T04:02:30.000Z"));
    try {
      const db = makeDb();
      mockMachinePreflightSelects(
        db,
        [
          {
            reportedAt: new Date("2026-06-26T04:02:00.000Z"),
            receivedAt: new Date("2026-06-26T04:02:00.000Z"),
            statusPayloadJson: {
              hardwareAdapter: "serial",
              hardwarePortPath: "COM5",
              hardwareStatus: "ok",
            },
          },
        ],
        { lastSeenAt: new Date("2026-06-26T04:02:00.000Z") },
      );

      const service = makeService({
        db,
        config: makeConfig({ nodeEnv: "production" }),
      });
      const result = await service.getMachinePreflight("mach-003");

      expect(result.status).toBe("ready");
      expect(
        result.checks.find((check) => check.code === "machine_heartbeat.fresh"),
      ).toMatchObject({
        severity: "critical",
        passed: true,
        evidence: {
          lastSeenAt: "2026-06-26T04:02:00.000Z",
          reportedAt: "2026-06-26T04:02:00.000Z",
          timeoutSeconds: 120,
          ageSeconds: 30,
        },
      });
      expect(
        result.checks.find(
          (check) => check.code === "production_dispense_path.ready",
        ),
      ).toMatchObject({
        severity: "critical",
        passed: true,
        evidence: {
          reportedAt: "2026-06-26T04:02:00.000Z",
          hardwareAdapter: "serial",
          hardwarePortPath: "COM5",
          hardwareStatus: "ok",
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    {
      reportedAt: "2026-06-26T04:10:00.000Z",
      caseName: "future",
    },
    {
      reportedAt: "2026-06-26T03:00:00.000Z",
      caseName: "backdated",
    },
  ])(
    "uses server lastSeenAt, not $caseName reportedAt, for preflight heartbeat freshness",
    async ({ reportedAt }) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-06-26T04:02:30.000Z"));
      try {
        const db = makeDb();
        mockMachinePreflightSelects(
          db,
          [
            {
              reportedAt: new Date(reportedAt),
              receivedAt: new Date("2026-06-26T04:02:00.000Z"),
              statusPayloadJson: {
                hardwareAdapter: "serial",
                hardwarePortPath: "COM5",
                hardwareStatus: "ok",
              },
            },
          ],
          { lastSeenAt: new Date("2026-06-26T04:02:00.000Z") },
        );

        const service = makeService({
          db,
          config: makeConfig({ nodeEnv: "production" }),
        });
        const result = await service.getMachinePreflight("mach-003");

        expect(result.status).toBe("ready");
        expect(
          result.checks.find(
            (check) => check.code === "machine_heartbeat.fresh",
          ),
        ).toMatchObject({
          passed: true,
          evidence: {
            lastSeenAt: "2026-06-26T04:02:00.000Z",
            reportedAt,
            ageSeconds: 30,
          },
        });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("blocks machine preflight when the latest heartbeat is stale", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-26T04:05:00.000Z"));
    try {
      const db = makeDb();
      mockMachinePreflightSelects(
        db,
        [
          {
            reportedAt: new Date("2026-06-26T04:04:59.000Z"),
            receivedAt: new Date("2026-06-26T04:02:30.000Z"),
            statusPayloadJson: {
              network: "online",
              mqttConnected: true,
              hardwareAdapter: "serial",
              hardwarePortPath: "COM5",
              hardwareStatus: "ok",
            },
          },
        ],
        { lastSeenAt: new Date("2026-06-26T04:02:30.000Z") },
      );

      const service = makeService({
        db,
        config: makeConfig({ machineHeartbeatTimeoutSeconds: 120 }),
      });
      const result = await service.getMachinePreflight("mach-003");

      expect(result.status).toBe("blocked");
      expect(
        result.checks.find((check) => check.code === "machine_heartbeat.fresh"),
      ).toMatchObject({
        severity: "critical",
        passed: false,
        evidence: {
          lastSeenAt: "2026-06-26T04:02:30.000Z",
          reportedAt: "2026-06-26T04:04:59.000Z",
          timeoutSeconds: 120,
          ageSeconds: 150,
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("blocks machine preflight when an online machine has no lastSeenAt", async () => {
    const db = makeDb();
    mockMachinePreflightSelects(
      db,
      [
        {
          reportedAt: new Date("2026-06-26T04:02:00.000Z"),
          receivedAt: new Date("2026-06-26T04:02:00.000Z"),
          statusPayloadJson: {
            hardwareAdapter: "serial",
            hardwarePortPath: "COM5",
            hardwareStatus: "ok",
          },
        },
      ],
      { lastSeenAt: null },
    );

    const service = makeService({
      db,
      config: makeConfig({ nodeEnv: "production" }),
    });
    const result = await service.getMachinePreflight("mach-003");

    expect(result.status).toBe("blocked");
    expect(
      result.checks.find((check) => check.code === "machine_heartbeat.fresh"),
    ).toMatchObject({
      severity: "critical",
      passed: false,
      message: "Machine heartbeat receive time is missing",
      evidence: {
        lastSeenAt: null,
        reportedAt: "2026-06-26T04:02:00.000Z",
        ageSeconds: null,
      },
    });
  });

  it("blocks production machine preflight when no heartbeat evidence exists", async () => {
    const db = makeDb();
    mockMachinePreflightSelects(db, []);

    const service = makeService({
      db,
      config: makeConfig({ nodeEnv: "production" }),
    });
    const result = await service.getMachinePreflight("mach-003");

    expect(result.status).toBe("blocked");
    expect(
      result.checks.find((check) => check.code === "machine_heartbeat.fresh"),
    ).toMatchObject({
      severity: "critical",
      passed: false,
      message: "Machine heartbeat is missing",
      evidence: {
        reportedAt: null,
      },
    });
    expect(
      result.checks.find(
        (check) => check.code === "production_dispense_path.evidence_missing",
      ),
    ).toMatchObject({
      severity: "critical",
      passed: false,
      evidence: {
        reportedAt: null,
        hardwareAdapter: null,
        hardwarePortPath: null,
      },
    });
  });

  it("blocks production machine preflight when heartbeat lacks hardware evidence", async () => {
    const db = makeDb();
    mockMachinePreflightSelects(db, [
      {
        reportedAt: new Date("2026-06-26T04:03:00.000Z"),
        statusPayloadJson: {
          network: "online",
          mqttConnected: true,
        },
      },
    ]);

    const service = makeService({
      db,
      config: makeConfig({ nodeEnv: "production" }),
    });
    const result = await service.getMachinePreflight("mach-003");

    expect(result.status).toBe("blocked");
    expect(
      result.checks.find(
        (check) => check.code === "production_dispense_path.evidence_missing",
      ),
    ).toMatchObject({
      severity: "critical",
      passed: false,
      evidence: {
        reportedAt: "2026-06-26T04:03:00.000Z",
        hardwareAdapter: null,
        hardwarePortPath: null,
      },
    });
  });
});

describe("PaymentOpsService.getMetrics", () => {
  it("returns payment_code counters from attempts and events", async () => {
    const db = makeDb();
    buildSelectSequence(db, [
      [{ total: 10, failed: 2 }],
      [{ signatureInvalid: 1, businessInvalid: 2 }],
      [{ total: 3 }],
      [{ failed: 4, overdue: 5 }],
      [{ unknown: 6, reverseFailed: 7 }],
      [{ total: 8 }],
      [],
    ]);

    const service = makeService({ db });
    const result = await service.getMetrics(60);

    expect(result.paymentCodeUnknownCount).toBe(6);
    expect(result.paymentCodeReverseFailedCount).toBe(7);
    expect(result.paymentCodeDuplicateRejectedCount).toBe(8);
    expect(result.scannerOfflineMachineCount).toBe(0);
  });
});
