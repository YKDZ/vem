import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { daemonClient } from "@/daemon/client";
import { getDaemonConnectionInfo } from "@/native/daemon-connection";

type ScenarioName = "catalog" | "payment" | "scannerOffline";

vi.mock("@/native/daemon-connection", () => ({
  getDaemonConnectionInfo: vi.fn(),
}));

const emptyTransaction = {
  orderId: null,
  orderNo: null,
  productSummary: null,
  paymentId: null,
  paymentNo: null,
  paymentMethod: null,
  paymentProvider: null,
  paymentUrl: null,
  paymentStatus: null,
  orderStatus: null,
  totalAmountCents: null,
  vending: null,
  nextAction: null,
  maskedAuthCode: null,
  paymentCodeAttempt: null,
  expiresAt: null,
  errorCode: null,
  errorMessage: null,
  operatorHint: null,
  updatedAt: "2026-01-01T00:00:00Z",
};

function healthSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    status: "healthy",
    process: {
      component: "daemon",
      level: "ok",
      code: "ready",
      message: "ready",
      updatedAt: "2026-01-01T00:00:00Z",
    },
    components: [],
    configConfigured: true,
    databaseOnline: true,
    backendOnline: true,
    mqttConnected: true,
    outboxSize: 0,
    outboxMax: 1000,
    hardwareOnline: true,
    scannerOnline: true,
    visionOnline: true,
    remoteOpsActive: false,
    currentTransaction: null,
    operatorReason: "ok",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function readySnapshot(overrides: Record<string, unknown> = {}) {
  return {
    ready: true,
    canSell: true,
    mode: "normal",
    blockingCodes: [],
    blockingReasons: [],
    degradedReasons: [],
    suggestedRoute: "catalog",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function paymentTransaction() {
  return {
    orderId: "550e8400-e29b-41d4-a716-446655440010",
    orderNo: "ORD-001",
    productSummary: { productName: "矿泉水" },
    paymentId: "550e8400-e29b-41d4-a716-446655440011",
    paymentNo: "PAY-001",
    paymentMethod: "payment_code",
    paymentProvider: "alipay",
    paymentUrl: null,
    paymentStatus: "pending",
    orderStatus: "pending_payment",
    totalAmountCents: 100,
    vending: null,
    nextAction: "wait_payment",
    maskedAuthCode: "6212****3456",
    paymentCodeAttempt: {
      attemptNo: 1,
      status: "querying",
      maskedAuthCode: "6212****3456",
      source: "serial_text",
      idempotencyKey: "ORD-001:attempt-1",
      submittedAt: null,
      lastCheckedAt: null,
      canRetry: false,
      message: null,
    },
    expiresAt: "2026-01-01T00:05:00Z",
    errorCode: null,
    errorMessage: null,
    operatorHint: null,
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function expectNoSecretFields(payload: unknown): void {
  const text = JSON.stringify(payload);
  expect(text).not.toContain('"machineSecret":');
  expect(text).not.toContain('"mqttSigningSecret":');
  expect(text).not.toContain('"mqttPassword":');
  expect(text).not.toContain("621234567890123456");
}

let scenario: ScenarioName = "catalog";
let server: {
  close(callback: (error?: Error | null) => void): void;
} | null = null;

function respondJson(
  res: ServerResponse,
  payload: unknown,
  status = 200,
): void {
  res.writeHead(status, {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PUT,OPTIONS",
    "access-control-allow-headers": "Authorization,Content-Type",
    "content-type": "application/json",
  });
  res.end(JSON.stringify(payload));
}

function currentFixtures() {
  if (scenario === "payment") {
    return {
      health: healthSnapshot(),
      ready: readySnapshot({ suggestedRoute: "payment" }),
      transaction: paymentTransaction(),
      scanner: {
        online: true,
        adapter: "serial_text",
        port: "COM4",
        level: "ok",
        code: "SCANNER_READY",
        message: "scanner ready",
        updatedAt: "2026-01-01T00:00:00Z",
      },
      paymentOptions: {
        options: [
          {
            optionKey: "mock:mock",
            providerCode: "mock",
            method: "mock",
            displayName: "模拟支付",
            description: "本地开发模式",
            icon: "mock",
            recommended: true,
            disabled: false,
            disabledReason: null,
          },
          {
            optionKey: "qr_code:alipay",
            providerCode: "alipay",
            method: "qr_code",
            displayName: "支付宝",
            description: "扫码支付",
            icon: "alipay",
            recommended: false,
            disabled: false,
            disabledReason: null,
          },
          {
            optionKey: "payment_code:alipay",
            providerCode: "alipay",
            method: "payment_code",
            displayName: "支付宝付款码",
            description: "出示付款码",
            icon: "alipay",
            recommended: false,
            disabled: false,
            disabledReason: null,
          },
        ],
        defaultOptionKey: "payment_code:alipay",
        defaultProviderCode: "alipay",
        serverTime: "2026-01-01T00:00:00Z",
      },
    };
  }

  if (scenario === "scannerOffline") {
    return {
      health: healthSnapshot({ scannerOnline: false, status: "degraded" }),
      ready: readySnapshot({ suggestedRoute: "catalog" }),
      transaction: emptyTransaction,
      scanner: {
        online: false,
        adapter: "serial_text",
        port: "COM4",
        level: "offline",
        code: "SCANNER_OPEN_FAILED",
        message: "open scanner serial failed: Access denied",
        updatedAt: "2026-01-01T00:00:00Z",
      },
      paymentOptions: {
        options: [
          {
            optionKey: "qr_code:alipay",
            providerCode: "alipay",
            method: "qr_code",
            displayName: "支付宝",
            description: "扫码支付",
            icon: "alipay",
            recommended: true,
            disabled: false,
            disabledReason: null,
          },
          {
            optionKey: "payment_code:alipay",
            providerCode: "alipay",
            method: "payment_code",
            displayName: "支付宝付款码",
            description: "出示付款码",
            icon: "alipay",
            recommended: false,
            disabled: true,
            disabledReason:
              "扫码器不可用：open scanner serial failed: Access denied",
          },
        ],
        defaultOptionKey: "qr_code:alipay",
        defaultProviderCode: "alipay",
        serverTime: "2026-01-01T00:00:00Z",
      },
    };
  }

  return {
    health: healthSnapshot(),
    ready: readySnapshot(),
    transaction: emptyTransaction,
    scanner: {
      online: true,
      adapter: "serial_text",
      port: "COM4",
      level: "ok",
      code: "SCANNER_READY",
      message: "scanner ready",
      updatedAt: "2026-01-01T00:00:00Z",
    },
    paymentOptions: {
      options: [],
      defaultOptionKey: null,
      defaultProviderCode: null,
      serverTime: "2026-01-01T00:00:00Z",
    },
  };
}

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", "http://127.0.0.1:7891");
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,PUT,OPTIONS",
      "access-control-allow-headers": "Authorization,Content-Type",
    });
    res.end();
    return;
  }
  if (
    url.pathname.startsWith("/v1/") &&
    req.headers.authorization !== "Bearer dev-token"
  ) {
    respondJson(res, { code: "unauthorized", message: "invalid token" }, 401);
    return;
  }

  const fixtures = currentFixtures();

  if (url.pathname === "/healthz") {
    respondJson(res, fixtures.health);
    return;
  }
  if (url.pathname === "/readyz") {
    respondJson(res, fixtures.ready);
    return;
  }
  if (url.pathname === "/v1/runtime-configuration") {
    const payload = effectiveRuntimeConfigurationFixture();
    expectNoSecretFields(payload);
    respondJson(res, payload);
    return;
  }
  if (url.pathname === "/v1/transactions/current") {
    expectNoSecretFields(fixtures.transaction);
    respondJson(res, fixtures.transaction);
    return;
  }
  if (url.pathname === "/v1/scanner/status") {
    respondJson(res, fixtures.scanner);
    return;
  }
  if (url.pathname === "/v1/payment-options") {
    respondJson(res, fixtures.paymentOptions);
    return;
  }
  if (url.pathname === "/v1/sync/status") {
    respondJson(res, {
      mqttRunning: true,
      mqttConnected: true,
      brokerUrlMasked: "mqtt://127.0.0.1:1883",
      lastHeartbeatAt: "2026-01-01T00:00:00Z",
      lastCommandNo: null,
      outboxSize: 0,
      outboxMax: 1000,
      outboxUsage: 0,
      nextRetryAt: null,
      lastError: null,
      tlsAuthStatus: "ok",
    });
    return;
  }
  if (url.pathname === "/v1/natural-context") {
    respondJson(res, {
      status: "stale",
      machineCode: "MACHINE-1",
      checkedAt: "2026-06-30T14:00:00.000Z",
      degraded: true,
      customerFacingBlocked: false,
      externalEnvironment: {
        status: "stale",
        machineId: "550e8400-e29b-41d4-a716-446655440000",
        machineCode: "MACHINE-1",
        checkedAt: "2026-06-30T14:00:00.000Z",
        localTime: {
          status: "ready",
          timezone: "Asia/Shanghai",
          localDate: "2026-06-30",
          localClock: "22:00:00",
        },
        weather: {
          status: "stale",
          temperatureCelsius: 28,
          conditionText: "Sunny",
          conditionCode: "100",
          observedAt: "2026-06-30T13:50:00.000Z",
          weatherConditionClasses: ["other"],
          primaryWeatherConditionClass: "other",
          diagnostic: {
            reason: "provider_unavailable",
            message: "External Natural Environment provider is unavailable",
          },
        },
        sun: {
          status: "ready",
          sunriseAt: "2026-06-29T21:53:00.000Z",
          sunsetAt: "2026-06-30T10:02:00.000Z",
        },
        calendar: {
          status: "ready",
          localDate: "2026-06-30",
          festivals: [],
          primaryFestival: null,
          solarTerm: null,
        },
        diagnostic: {
          reason: "provider_unavailable",
          message: "External Natural Environment provider is unavailable",
        },
      },
      localSiteSignals: {
        status: "unavailable",
      },
    });
    return;
  }
  if (url.pathname === "/v1/vision/status") {
    respondJson(res, {
      enabled: true,
      online: true,
      message: "vision ready",
      updatedAt: "2026-01-01T00:00:00Z",
    });
    return;
  }
  if (url.pathname === "/v1/remote-ops/status") {
    respondJson(res, {
      lastPolledAt: "2026-01-01T00:00:00Z",
      pending: 0,
      lastError: null,
      processing: null,
    });
    return;
  }
  respondJson(res, { code: "not_found", message: url.pathname }, 404);
}

async function startMockDaemon() {
  const daemon = createServer(handleRequest);
  await new Promise<void>((resolve) =>
    daemon.listen(7891, "127.0.0.1", resolve),
  );
  return daemon;
}

describe("machine daemon client integration", () => {
  beforeAll(async () => {
    server = await startMockDaemon();
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => {
        if (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        resolve();
      });
    });
  });

  beforeEach(() => {
    scenario = "catalog";
    vi.clearAllMocks();
    vi.mocked(getDaemonConnectionInfo).mockResolvedValue({
      baseUrl: "http://127.0.0.1:7891",
      token: "dev-token",
      source: "browser_env",
      mock: true,
    });
    daemonClient["connection"] = null;
  });

  it("parses serial_text scanner status and payment transaction fixtures", async () => {
    scenario = "payment";

    const [health, ready, tx, scanner, options] = await Promise.all([
      daemonClient.getHealth(),
      daemonClient.getReady(),
      daemonClient.getCurrentTransaction(),
      daemonClient.getScannerStatus(),
      daemonClient.getPaymentOptions(),
    ]);

    expect(health.scannerOnline).toBe(true);
    expect(ready.suggestedRoute).toBe("payment");
    expect(tx.paymentMethod).toBe("payment_code");
    expect(tx.paymentCodeAttempt?.source).toBe("serial_text");
    expect(tx.paymentCodeAttempt?.maskedAuthCode).toBe("6212****3456");
    expect(scanner.adapter).toBe("serial_text");
    expect(scanner.code).toBe("SCANNER_READY");
    expect(options.defaultOptionKey).toBe("payment_code:alipay");
    expectNoSecretFields({ health, ready, tx, scanner, options });
  });

  it("keeps qr option enabled when scanner is offline", async () => {
    scenario = "scannerOffline";

    const [scanner, options] = await Promise.all([
      daemonClient.getScannerStatus(),
      daemonClient.getPaymentOptions(),
    ]);

    expect(scanner.online).toBe(false);
    expect(scanner.code).toBe("SCANNER_OPEN_FAILED");
    const paymentCode = options.options.find(
      (option) => option.method === "payment_code",
    );
    const qrCode = options.options.find(
      (option) => option.method === "qr_code",
    );
    expect(paymentCode?.disabled).toBe(true);
    expect(paymentCode?.disabledReason).toContain("扫码器不可用");
    expect(qrCode?.disabled).toBe(false);
    expect(options.defaultOptionKey).toBe("qr_code:alipay");
  });

  it("retains the Machine Location Label in the effective configuration", async () => {
    const config = await daemonClient.getEffectiveRuntimeConfiguration();

    expect(config.machine?.locationLabel).toBe("E2E lab");
    expect(config.machine).not.toHaveProperty("machineLocationText");
  });

  it("loads Natural Context Projection from daemon IPC", async () => {
    const snapshot = await daemonClient.getNaturalContext();

    expect(snapshot.status).toBe("stale");
    expect(snapshot.degraded).toBe(true);
    expect(snapshot.customerFacingBlocked).toBe(false);
    expect(snapshot.externalEnvironment.status).toBe("stale");
    if (snapshot.externalEnvironment.status !== "stale") {
      throw new Error("expected stale external environment");
    }
    expect(snapshot.externalEnvironment.diagnostic.reason).toBe(
      "provider_unavailable",
    );
  });
});

function effectiveRuntimeConfigurationFixture() {
  const bootstrap = {
    schemaVersion: 1,
    provisioningApiBaseUrl: "http://127.0.0.1:3000/api",
    hardwareModel: "vem-prod-24",
    topology: { identity: "vem-prod-24", version: "v1" },
  };
  const profile = {
    machine: {
      id: "550e8400-e29b-41d4-a716-446655440001",
      code: "M001",
      name: "E2E machine",
      status: "online",
      locationLabel: "E2E lab",
    },
    apiBaseUrl: bootstrap.provisioningApiBaseUrl,
    runtimeEndpoints: {
      apiBasePath: "/api",
      machineAuthTokenPath: "/api/machine-auth/token",
      machineApiBasePath: "/api/machines/M001",
      mqttTopicPrefix: "vem/machines/M001",
    },
    mqttConnection: {
      url: "mqtt://127.0.0.1:1883",
      clientId: "vem-machine-M001",
      username: "machine",
    },
    hardwareProfile: {
      profile: "production",
      controller: { required: true, protocol: "vem-vending-controller" },
      paymentScanner: { required: true, supportsPaymentCode: true },
      vision: { required: false, supportsRecommendations: true },
    },
    hardwareModel: bootstrap.hardwareModel,
    hardwareSlotTopology: bootstrap.topology,
    paymentCapability: {
      profile: "production",
      qrCodeEnabled: true,
      paymentCodeEnabled: true,
      serverTime: "2026-07-17T00:00:00.000Z",
    },
    metadata: {
      profileVersion: 1,
      profileRevision: 1,
      claimCodeId: "550e8400-e29b-41d4-a716-446655440002",
      claimedAt: "2026-07-17T00:00:00.000Z",
      serverTime: "2026-07-17T00:00:00.000Z",
    },
  };
  return {
    schemaVersion: 1,
    generation: 1,
    sourceRevisions: {
      bootstrapSchemaVersion: 1,
      profile: {
        generation: 1,
        profileRevision: 1,
        acceptedAt: "2026-07-17T00:00:00.000Z",
      },
      localSettingsRevision: 0,
    },
    sourceDocuments: {
      bootstrap,
      profileCache: {
        schemaVersion: 1,
        generation: 1,
        acceptedAt: "2026-07-17T00:00:00.000Z",
        profile,
      },
    },
    machine: profile.machine,
    platform: {
      apiBaseUrl: profile.apiBaseUrl,
      runtimeEndpoints: profile.runtimeEndpoints,
      mqttConnection: profile.mqttConnection,
      paymentCapability: profile.paymentCapability,
    },
    hardware: {
      model: bootstrap.hardwareModel,
      topology: bootstrap.topology,
      expectedProfile: profile.hardwareProfile,
      lowerControllerBinding: null,
      scannerBinding: null,
      scannerProtocol: null,
    },
    experience: {
      audio: {
        volume: 0.7,
        cuesEnabled: false,
        presenceCuesEnabled: false,
        transactionCuesEnabled: false,
      },
    },
    secretStatus: {
      machineSecretConfigured: true,
      mqttSigningSecretConfigured: true,
      mqttPasswordConfigured: true,
    },
    profileRefresh: { status: "accepted", lastError: null },
  };
}
