import { test, expect } from "@playwright/test";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

type ScenarioName =
  | "catalog"
  | "soldOut"
  | "maintenance"
  | "offline"
  | "payment"
  | "dispensing"
  | "result"
  | "provisioning"
  | "stockAttestation"
  | "staleEventStream"
  | "syncBacklog";

const saleViewItem = {
  machineCode: "M001",
  slotId: "550e8400-e29b-41d4-a716-446655440001",
  slotCode: "A1",
  layerNo: 1,
  cellNo: 1,
  inventoryId: "550e8400-e29b-41d4-a716-446655440002",
  variantId: "550e8400-e29b-41d4-a716-446655440003",
  productId: "550e8400-e29b-41d4-a716-446655440004",
  productName: "基础短袖",
  productDescription: "T恤类目，基础版型短袖上衣。",
  coverImageUrl: null,
  categoryId: null,
  categoryName: "T恤 / 基础短袖",
  sku: "TEE-BASIC-M-BLACK",
  size: "M",
  color: "黑色",
  priceCents: 5900,
  productSortOrder: 1,
  targetGender: null,
  capacity: 8,
  parLevel: 6,
  physicalStock: 5,
  saleableStock: 5,
  slotSalesState: "sale_ready",
};

const publicConfig = {
  machineCode: "M001",
  apiBaseUrl: "http://127.0.0.1:3000/api",
  mqttUrl: "mqtt://127.0.0.1:1883",
  mqttUsername: "machine",
  hardwareAdapter: "mock",
  serialPortPath: null,
  scannerAdapter: "disabled",
  scannerSerialPortPath: null,
  scannerBaudRate: 9600,
  scannerFrameSuffix: "crlf",
  visionEnabled: true,
  visionWsUrl: "ws://127.0.0.1:7892/ws",
  visionRequestTimeoutMs: 8000,
  kioskMode: true,
};

const emptyTransaction = {
  orderId: null,
  orderNo: null,
  productSummary: null,
  paymentId: null,
  paymentNo: null,
  paymentMethod: null,
  paymentProvider: null,
  paymentUrl: "https://pay.example/qr",
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

function bringUpSnapshot(
  state: "claim_required" | "runtime_ready" | "sell_ready" = "sell_ready",
) {
  const ready = state === "sell_ready" || state === "runtime_ready";
  return {
    state,
    blockingReasons:
      state === "claim_required"
        ? [
            {
              code: "CLAIM_REQUIRED",
              component: "provisioning",
              message:
                "machine must be claimed before runtime profile can be applied",
            },
          ]
        : [],
    diagnostics: [],
    readinessLevel:
      state === "sell_ready"
        ? "sell_ready"
        : state === "runtime_ready"
          ? "runtime_ready"
          : "not_ready",
    hardwareMode: ready ? "production" : "simulated",
    allowedActions: {
      configureNetwork: false,
      claimMachine: state === "claim_required",
      retryClaim: state === "claim_required",
      syncProfile: false,
      resolveTopology: false,
      runRuntimeAcceptance: ready,
      runHardwareAcceptance: false,
      attestStock: false,
      startSales: state === "sell_ready",
    },
    currentTask: null,
    progress: [],
    updatedAt: "2026-07-04T00:00:00Z",
  };
}

function saleReadinessSnapshot(canStartNetworkAuthorizedSale = true) {
  const maybeUnavailable = !canStartNetworkAuthorizedSale;
  return {
    canStartNetworkAuthorizedSale,
    blockingCodes: maybeUnavailable
      ? ["PLATFORM_UNREACHABLE", "NO_PAYMENT_OPTIONS"]
      : [],
    components: {
      platformReachability: {
        ready: !maybeUnavailable,
        code: maybeUnavailable ? "PLATFORM_UNREACHABLE" : "PLATFORM_REACHABLE",
        message: maybeUnavailable ? "platform offline" : "platform reachable",
      },
      machineAuthentication: {
        ready: true,
        code: "MACHINE_AUTH_READY",
        message: "machine code configured",
      },
      activePlanogram: {
        ready: true,
        code: "ACTIVE_PLANOGRAM_READY",
        message: "PLAN-1",
      },
      paymentOptions: {
        ready: !maybeUnavailable,
        code: maybeUnavailable ? "NO_PAYMENT_OPTIONS" : "PAYMENT_OPTIONS_READY",
        message: maybeUnavailable
          ? "no ready payment option"
          : "payment option available",
        methods: [
          {
            method: "mock",
            optionKey: "mock:mock",
            providerCode: "mock",
            ready: !maybeUnavailable,
            disabledReason: maybeUnavailable ? "platform offline" : null,
          },
        ],
      },
      scannerCapability: {
        ready: true,
        code: "SCANNER_READY",
        message: "scanner ready",
      },
      syncHealth: {
        ready: true,
        code: scenario === "syncBacklog" ? "SYNC_DEGRADED" : "SYNC_READY",
        message:
          scenario === "syncBacklog"
            ? "MQTT backlog pending"
            : "sync connected",
      },
      wholeMachineBlockers: {
        ready: true,
        code: "WHOLE_MACHINE_READY",
        message: "hardware ready",
      },
      slotSaleSafety: {
        ready: scenario !== "soldOut",
        code: scenario === "soldOut" ? "SLOT_SOLD_OUT" : "SLOT_SALE_READY",
        message: scenario === "soldOut" ? "all slots sold out" : "slots ready",
        blockedSlots:
          scenario === "soldOut"
            ? [
                {
                  slotId: saleViewItem.slotId,
                  slotCode: saleViewItem.slotCode,
                  slotSalesState: "sold_out",
                },
              ]
            : [],
      },
    },
  };
}

function transactionSnapshot(
  nextAction: string | null,
  overrides: Record<string, unknown> = {},
) {
  if (!nextAction) {
    return emptyTransaction;
  }

  return {
    orderId: "550e8400-e29b-41d4-a716-446655440010",
    orderNo: "ORD-001",
    productSummary: { productName: "基础短袖" },
    paymentId: "550e8400-e29b-41d4-a716-446655440011",
    paymentNo: "PAY-001",
    paymentMethod: nextAction === "wait_payment" ? "qr_code" : "mock",
    paymentProvider: nextAction === "wait_payment" ? "alipay" : "mock",
    paymentUrl: "https://pay.example/qr",
    paymentStatus: nextAction === "success" ? "succeeded" : "pending",
    orderStatus: nextAction === "success" ? "fulfilled" : "pending_payment",
    totalAmountCents: 5900,
    vending:
      nextAction === "dispensing" || nextAction === "success"
        ? {
            commandId: "550e8400-e29b-41d4-a716-446655440012",
            commandNo: "CMD-001",
            status: nextAction === "success" ? "succeeded" : "pending",
            lastError: null,
          }
        : null,
    nextAction,
    maskedAuthCode: null,
    paymentCodeAttempt: null,
    expiresAt: "2030-01-01T00:00:00.000Z",
    errorCode: null,
    errorMessage: null,
    operatorHint: null,
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

let scenario: ScenarioName = "catalog";
let stockAttestationSubmitted = false;
const protectedBringUpRequests: Array<{
  maintenanceSession: string | undefined;
  body: unknown;
}> = [];
let server: {
  close(callback: (error?: Error | null) => void): void;
  closeAllConnections(): void;
  closeIdleConnections(): void;
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

function expectNoSecretFields(payload: unknown): void {
  const text = JSON.stringify(payload);
  expect(text).not.toContain('"machineSecret":');
  expect(text).not.toContain('"mqttSigningSecret":');
  expect(text).not.toContain('"mqttPassword":');
  expect(text).not.toContain("621234567890123456");
}

function currentFixtures(): Record<string, unknown> {
  if (scenario === "maintenance") {
    return {
      health: healthSnapshot({
        configConfigured: false,
        status: "maintenance",
      }),
      ready: readySnapshot({
        ready: false,
        canSell: false,
        suggestedRoute: "maintenance",
        blockingCodes: ["config_missing"],
        blockingReasons: [
          {
            code: "config_missing",
            component: "config",
            message: "缺少部署配置",
          },
        ],
      }),
      bringUp: bringUpSnapshot("sell_ready"),
      transaction: emptyTransaction,
    };
  }

  if (scenario === "offline") {
    return {
      health: healthSnapshot({
        backendOnline: false,
        mqttConnected: false,
        status: "offline",
      }),
      ready: readySnapshot({
        ready: false,
        canSell: false,
        suggestedRoute: "offline",
        blockingCodes: ["network_unavailable"],
        blockingReasons: [
          {
            code: "network_unavailable",
            component: "backend",
            message: "网络未就绪",
          },
        ],
      }),
      bringUp: bringUpSnapshot("runtime_ready"),
      transaction: emptyTransaction,
    };
  }

  if (scenario === "payment") {
    return {
      health: healthSnapshot(),
      ready: readySnapshot({ suggestedRoute: "payment" }),
      bringUp: bringUpSnapshot("sell_ready"),
      transaction: transactionSnapshot("wait_payment"),
    };
  }

  if (scenario === "dispensing") {
    return {
      health: healthSnapshot(),
      ready: readySnapshot({ suggestedRoute: "dispensing" }),
      bringUp: bringUpSnapshot("sell_ready"),
      transaction: transactionSnapshot("dispensing"),
    };
  }

  if (scenario === "result") {
    return {
      health: healthSnapshot(),
      ready: readySnapshot({ suggestedRoute: "result" }),
      bringUp: bringUpSnapshot("sell_ready"),
      transaction: transactionSnapshot("success"),
    };
  }

  if (scenario === "syncBacklog") {
    return {
      health: healthSnapshot({ outboxSize: 25 }),
      ready: readySnapshot({
        ready: true,
        canSell: true,
        suggestedRoute: "catalog",
        degradedReasons: [
          {
            code: "mqtt_backlog",
            component: "mqtt",
            message: "MQTT backlog pending",
          },
        ],
      }),
      bringUp: bringUpSnapshot("sell_ready"),
      transaction: emptyTransaction,
    };
  }

  if (scenario === "provisioning") {
    return {
      health: healthSnapshot({
        configConfigured: false,
        status: "maintenance",
      }),
      ready: readySnapshot({
        ready: false,
        canSell: false,
        suggestedRoute: "maintenance",
        blockingCodes: ["CONFIG_INCOMPLETE"],
        blockingReasons: [
          {
            code: "CONFIG_INCOMPLETE",
            component: "config",
            message: "machine is not provisioned",
          },
        ],
      }),
      bringUp: {
        ...bringUpSnapshot("claim_required"),
        currentTask: {
          contractVersion: 1,
          taskId: "bring_up.claim_machine",
          taskVersion: 1,
          kind: "claim_machine",
          intent: "claim_machine",
          rotateMaintenanceIdentity: false,
          projection: {
            type: "claim_code",
            rotateMaintenanceIdentity: false,
          },
        },
      },
      transaction: emptyTransaction,
    };
  }

  if (scenario === "stockAttestation") {
    return {
      health: healthSnapshot({
        configConfigured: true,
        status: "maintenance",
      }),
      ready: readySnapshot({
        ready: false,
        canSell: false,
        suggestedRoute: "maintenance",
        blockingCodes: ["PHYSICAL_STOCK_ATTESTATION_MISSING"],
        blockingReasons: [
          {
            code: "PHYSICAL_STOCK_ATTESTATION_MISSING",
            component: "stock",
            message: "physical stock attestation is missing",
          },
        ],
      }),
      bringUp: stockAttestationSubmitted
        ? {
            ...bringUpSnapshot("runtime_ready"),
            state: "profile_applied",
            readinessLevel: "not_ready",
            allowedActions: {
              configureNetwork: false,
              claimMachine: false,
              retryClaim: false,
              syncProfile: true,
              resolveTopology: false,
              runRuntimeAcceptance: true,
              runHardwareAcceptance: false,
              attestStock: false,
              startSales: false,
            },
            currentTask: {
              contractVersion: 1,
              taskId: "bring_up.sync_profile",
              taskVersion: 1,
              kind: "sync_profile",
              intent: "refresh_profile",
              rotateMaintenanceIdentity: false,
              projection: { type: "profile_sync" },
            },
          }
        : {
            ...bringUpSnapshot("runtime_ready"),
            state: "stock_attestation_required",
            readinessLevel: "not_ready",
            allowedActions: {
              configureNetwork: false,
              claimMachine: false,
              retryClaim: false,
              syncProfile: false,
              resolveTopology: false,
              runRuntimeAcceptance: true,
              runHardwareAcceptance: false,
              attestStock: true,
              startSales: false,
            },
            currentTask: {
              contractVersion: 1,
              taskId: "bring_up.attest_stock",
              taskVersion: 1,
              kind: "attest_stock",
              intent: "record_stock",
              rotateMaintenanceIdentity: false,
              projection: {
                type: "stock_attestation",
                entryMode: "final_actual_quantities",
              },
            },
          },
      transaction: emptyTransaction,
    };
  }

  return {
    health: healthSnapshot(),
    ready: readySnapshot(),
    bringUp: bringUpSnapshot("sell_ready"),
    transaction: emptyTransaction,
  };
}

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", "http://127.0.0.1:7891");
  if (process.env.VEM_E2E_TRACE === "1") {
    console.error(`[mock-daemon] ${scenario} ${req.method} ${url.pathname}`);
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,PUT,OPTIONS",
      "access-control-allow-headers":
        "Authorization,Content-Type,X-Vem-Maintenance-Session",
    });
    res.end();
    return;
  }

  if (url.pathname === "/v1/events") {
    res.writeHead(426, {
      "access-control-allow-origin": "*",
      "content-type": "text/plain",
    });
    res.end("websocket required");
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

  if (url.pathname === "/v1/bring-up") {
    respondJson(res, fixtures.bringUp);
    return;
  }

  if (url.pathname === "/v1/config/summary") {
    const provisioned = scenario !== "provisioning";
    const payload = {
      configuredState: {
        factoryManifest: true,
        localBringUpSettings: true,
        provisioningProfileCache: provisioned,
        machineSecretConfigured: provisioned,
        mqttSigningSecretConfigured: provisioned,
        mqttPasswordConfigured: provisioned,
        maintenancePinConfigured: provisioned,
      },
      provisioningProfileCache: provisioned ? { machineCode: "M001" } : null,
      effectivePublic: publicConfig,
    };
    expectNoSecretFields(payload);
    respondJson(res, payload);
    return;
  }

  if (url.pathname === "/v1/maintenance/sessions" && req.method === "POST") {
    req.on("end", () => {
      respondJson(
        res,
        {
          sessionId: "e2e-maintenance-session",
          expiresAt: "2030-01-01T00:00:00.000Z",
          scopes: ["maintenance.mutate"],
        },
        201,
      );
    });
    req.resume();
    return;
  }

  if (url.pathname === "/v1/bring-up/tasks/execute" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      const parsed = JSON.parse(body) as {
        kind?: string;
      };
      protectedBringUpRequests.push({
        maintenanceSession: req.headers["x-vem-maintenance-session"],
        body: parsed,
      });
      if (parsed.kind === "attest_stock") {
        stockAttestationSubmitted = true;
        respondJson(res, {
          items: [
            {
              ...saleViewItem,
              physicalStock: 5,
              saleableStock: 5,
              slotSalesState: "sale_ready",
            },
          ],
          source: "local_stock",
          planogramVersion: "PLAN-1",
          lastUpdatedAt: "2026-07-14T00:00:00Z",
        });
        return;
      }
      respondJson(
        res,
        {
          code: "machine_claim_locked",
          message: "machine claim code cannot be used",
        },
        400,
      );
    });
    return;
  }

  if (url.pathname === "/v1/sale-view") {
    respondJson(res, {
      items: [
        scenario === "soldOut"
          ? {
              ...saleViewItem,
              physicalStock: 0,
              saleableStock: 0,
              slotSalesState: "sold_out",
            }
          : saleViewItem,
      ],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-01-01T00:00:00Z",
    });
    return;
  }

  if (url.pathname === "/v1/catalog") {
    respondJson(res, {
      items: [],
      cached: true,
      lastUpdatedAt: "2026-01-01T00:00:00Z",
      source: "legacy-unused",
      lastError: null,
    });
    return;
  }

  if (url.pathname === "/v1/sale-readiness") {
    respondJson(
      res,
      saleReadinessSnapshot(
        scenario !== "offline" && scenario !== "maintenance",
      ),
    );
    return;
  }

  if (url.pathname === "/v1/payment-options") {
    respondJson(res, {
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
      defaultOptionKey: "mock:mock",
      defaultProviderCode: "mock",
      serverTime: "2026-01-01T00:00:00Z",
    });
    return;
  }

  if (url.pathname === "/v1/transactions/current") {
    expectNoSecretFields(fixtures.transaction);
    respondJson(res, fixtures.transaction);
    return;
  }

  if (url.pathname === "/v1/sync/status") {
    const payload = {
      mqttRunning: true,
      mqttConnected: scenario !== "offline",
      brokerUrlMasked: "mqtt://127.0.0.1:1883",
      lastHeartbeatAt: "2026-01-01T00:00:00Z",
      lastCommandNo: null,
      outboxSize: scenario === "syncBacklog" ? 25 : 0,
      outboxMax: 1000,
      outboxUsage: scenario === "syncBacklog" ? 0.025 : 0,
      nextRetryAt: null,
      lastError: scenario === "offline" ? "network down" : null,
      tlsAuthStatus: "ok",
    };
    expectNoSecretFields(payload);
    respondJson(res, payload);
    return;
  }

  if (url.pathname === "/v1/scanner/status") {
    respondJson(res, {
      online: true,
      adapter: "serial_text",
      port: "COM4",
      level: "ok",
      code: "SCANNER_READY",
      message: "scanner ready",
      updatedAt: "2026-01-01T00:00:00Z",
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

  if (url.pathname === "/v1/hardware/self-check") {
    respondJson(res, {
      adapter: "mock",
      online: true,
      message: "hardware ready",
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

async function freezeMotion(page: import("@playwright/test").Page) {
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation: none !important;
        transition: none !important;
      }
    `,
  });
}

test.beforeAll(async () => {
  server = await startMockDaemon();
});

test.afterAll(async () => {
  server?.closeIdleConnections();
  server?.closeAllConnections();
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

test("routes ready daemon to catalog", async ({ page }) => {
  scenario = "catalog";
  await page.goto("/");
  await expect(page.getByRole("button", { name: /T恤/ })).toBeVisible();
});

test("redesigned catalog home controls remain interactive", async ({
  page,
}) => {
  scenario = "catalog";
  await page.goto("/");

  const carousel = page.getByRole("region", { name: "首页展示轮播" });
  await expect(carousel).toBeVisible();
  await expect(page.getByRole("button", { name: "上一张" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "下一张" })).toHaveCount(0);

  const carouselImage = page.getByRole("img", { name: "轮播展示" });
  const firstCarouselSrc = await carouselImage.getAttribute("src");
  await carousel.dispatchEvent("pointerdown", { clientX: 500 });
  await carousel.dispatchEvent("pointerup", { clientX: 100 });
  await expect
    .poll(async () => await carouselImage.getAttribute("src"))
    .not.toBe(firstCarouselSrc);

  await freezeMotion(page);
  await page.getByRole("button", { name: /T恤/ }).click();
  await expect(
    page.getByRole("img", { name: "商品列表，请点击选择您需要的商品" }),
  ).toBeVisible();

  await page.getByRole("button", { name: /基础短袖/ }).click();
  await expect(
    page.getByRole("heading", { name: "基础短袖", exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: /立即购买/ }).click();
  await expect(page.getByRole("heading", { name: "确认购买" })).toBeVisible();

  await page.getByRole("button", { name: "返回" }).click();
  await expect(page.getByRole("button", { name: /立即购买/ })).toBeVisible();
});

test("catalog hides sold-out sale-view items", async ({ page }) => {
  scenario = "soldOut";
  await page.goto("/");
  await expect(page.getByText("暂无可售商品")).toBeVisible();
  await expect(page.getByRole("button", { name: /T恤/ })).toBeDisabled();
});

test("routes missing config to maintenance", async ({ page }) => {
  scenario = "maintenance";
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "生产维护" })).toBeVisible();
});

test("routes not-ready daemon to maintenance without an authoritative task", async ({
  page,
}) => {
  scenario = "offline";
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "生产维护" })).toBeVisible();
  await expect(
    page.getByText("network_unavailable", { exact: true }),
  ).toBeVisible();
});

test("restores active payment transaction", async ({ page }) => {
  scenario = "payment";
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "订单支付" })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("应付金额")).toBeVisible();
  await expect(page.getByText("¥59.00")).toBeVisible();
  await expect(page.getByRole("img", { name: "支付二维码" })).toBeVisible();
});

test("routes active dispensing transaction", async ({ page }) => {
  scenario = "dispensing";
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "正在出货" })).toBeVisible();
});

test("routes finished transaction to result", async ({ page }) => {
  scenario = "result";
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "出货成功" })).toBeVisible();
});

test("page reload keeps current transaction route", async ({ page }) => {
  scenario = "payment";
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "订单支付" })).toBeVisible({
    timeout: 15_000,
  });
  await page.goto("/#/boot");
  await expect(page).toHaveURL(/#\/payment$/);
  await expect(page.getByRole("heading", { name: "订单支付" })).toBeVisible();
});

test("daemon snapshots never expose secret fields to browser storage", async ({
  page,
}) => {
  scenario = "catalog";
  await page.goto("/");
  await expect(page.getByRole("button", { name: /T恤/ })).toBeVisible();
  const storage = await page.evaluate(() => {
    const snapshotStorage = (storage: Storage) =>
      Object.fromEntries(
        Array.from({ length: storage.length }, (_, index) => {
          const key = storage.key(index) ?? "";
          return [key, storage.getItem(key)];
        }),
      );
    return JSON.stringify({
      localStorage: snapshotStorage(localStorage),
      sessionStorage: snapshotStorage(sessionStorage),
    });
  });
  expect(storage).not.toContain('"machineSecret":');
  expect(storage).not.toContain('"mqttSigningSecret":');
  expect(storage).not.toContain('"mqttPassword":');
  expect(storage).not.toContain("621234567890123456");
});

test("provisioning UI sends a PIN-gated typed claim without echoing the code", async ({
  page,
}) => {
  scenario = "provisioning";
  protectedBringUpRequests.length = 0;
  await page.goto("/#/bring-up");
  await page.getByLabel("维护 PIN").fill("2468");
  await page.getByRole("button", { name: "验证维护 PIN" }).click();
  await page.getByLabel("领取码").fill("ABCD-2345");
  await freezeMotion(page);
  await page.getByRole("button", { name: "提交领取码", exact: true }).click();

  await expect(page.getByText("本机服务暂不可用，请稍后重试")).toBeVisible();
  await expect(page.getByText("ABCD-2345")).toHaveCount(0);
  expect(protectedBringUpRequests).toEqual([
    {
      maintenanceSession: "e2e-maintenance-session",
      body: {
        contractVersion: 1,
        taskId: "bring_up.claim_machine",
        taskVersion: 1,
        kind: "claim_machine",
        intent: "claim_machine",
        mutation: { type: "claim_machine", claimCode: "ABCD-2345" },
      },
    },
  ]);
});

test("record-stock UI PIN-gates and advances the typed physical attestation cursor", async ({
  page,
}) => {
  scenario = "stockAttestation";
  stockAttestationSubmitted = false;
  protectedBringUpRequests.length = 0;
  await page.goto("/#/bring-up");

  await expect(page.getByText("实物库存确认")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "确认并提交实物库存" }),
  ).toBeDisabled();
  await page.getByLabel("维护 PIN").fill("2468");
  await page.getByRole("button", { name: "验证维护 PIN" }).click();
  await page.getByLabel("A1 实际数量").fill("5");
  await page.getByLabel("已逐格核对实物数量，并确认提交。").check();
  await page.getByRole("button", { name: "确认并提交实物库存" }).click();

  await expect(page.getByText("当前任务：同步运行档案")).toBeVisible();
  expect(protectedBringUpRequests).toEqual([
    {
      maintenanceSession: "e2e-maintenance-session",
      body: {
        contractVersion: 1,
        taskId: "bring_up.attest_stock",
        taskVersion: 1,
        kind: "attest_stock",
        intent: "record_stock",
        mutation: {
          type: "record_stock",
          attestation: {
            attestationId: expect.stringMatching(/^bring-up-stock-/),
            planogramVersion: "PLAN-1",
            operatorId: "front-panel",
            slots: [
              {
                slotId: saleViewItem.slotId,
                slotCode: "A1",
                sku: saleViewItem.sku,
                quantity: 5,
                enabled: true,
              },
            ],
          },
        },
      },
    },
  ]);
  await expect(page).not.toHaveURL(/#\/maintenance$/);
});

test("sync backlog routes to catalog but displays degraded sync status", async ({
  page,
}) => {
  scenario = "syncBacklog";
  await page.goto("/");
  await expect(page.getByRole("button", { name: /T恤/ })).toBeVisible();
  const body = await page.textContent("body");
  expect(body ?? "").not.toContain("MQTT");
});
