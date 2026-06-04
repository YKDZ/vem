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
  productName: "矿泉水",
  productDescription: null,
  coverImageUrl: null,
  categoryId: null,
  categoryName: null,
  sku: "WATER-001",
  size: null,
  color: null,
  priceCents: 100,
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
  visionAutoStart: false,
  visionProcessCommand: null,
  visionProcessArgs: null,
  visionRequestTimeoutMs: 8000,
  kioskMode: true,
};

const emptyTransaction = {
  orderId: null,
  orderNo: null,
  productSummary: null,
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
    productSummary: { productName: "矿泉水" },
    paymentNo: "PAY-001",
    paymentMethod: nextAction === "wait_payment" ? "qr_code" : "mock",
    paymentProvider: "alipay",
    paymentUrl: "https://pay.example/qr",
    paymentStatus: nextAction === "success" ? "paid" : "pending",
    orderStatus: nextAction === "success" ? "completed" : "pending_payment",
    totalAmountCents: 100,
    vending:
      nextAction === "dispensing" || nextAction === "success"
        ? {
            commandNo: "CMD-001",
            status: nextAction === "success" ? "succeeded" : "created",
            lastError: null,
          }
        : null,
    nextAction,
    maskedAuthCode: null,
    paymentCodeAttempt: null,
    expiresAt: "2026-01-01T00:05:00Z",
    errorCode: null,
    errorMessage: null,
    operatorHint: null,
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
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
      transaction: emptyTransaction,
    };
  }

  if (scenario === "payment") {
    return {
      health: healthSnapshot(),
      ready: readySnapshot({ suggestedRoute: "payment" }),
      transaction: transactionSnapshot("wait_payment"),
    };
  }

  if (scenario === "dispensing") {
    return {
      health: healthSnapshot(),
      ready: readySnapshot({ suggestedRoute: "dispensing" }),
      transaction: transactionSnapshot("dispensing"),
    };
  }

  if (scenario === "result") {
    return {
      health: healthSnapshot(),
      ready: readySnapshot({ suggestedRoute: "result" }),
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
      transaction: emptyTransaction,
    };
  }

  return {
    health: healthSnapshot(),
    ready: readySnapshot(),
    transaction: emptyTransaction,
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

  if (url.pathname === "/v1/config") {
    const payload = {
      public: publicConfig,
      machineSecretConfigured: true,
      mqttSigningSecretConfigured: true,
      mqttPasswordConfigured: true,
    };
    expectNoSecretFields(payload);
    respondJson(res, payload);
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

test.beforeAll(async () => {
  server = await startMockDaemon();
});

test.afterAll(async () => {
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
  await expect(page.getByRole("heading", { name: "请选择商品" })).toBeVisible();
});

test("catalog hides sold-out sale-view items", async ({ page }) => {
  scenario = "soldOut";
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "请选择商品" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "暂无可售商品" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "查看详情" })).toHaveCount(0);
});

test("routes missing config to maintenance", async ({ page }) => {
  scenario = "maintenance";
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "部署配置 / 维护入口" }),
  ).toBeVisible();
});

test("routes not-ready daemon to offline", async ({ page }) => {
  scenario = "offline";
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "暂时无法购买" }),
  ).toBeVisible();
});

test("restores active payment transaction", async ({ page }) => {
  scenario = "payment";
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "支付宝扫码支付" }),
  ).toBeVisible();
  await expect(page.getByText("订单 ORD-001")).toBeVisible();
});

test("routes active dispensing transaction", async ({ page }) => {
  scenario = "dispensing";
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "支付成功，正在出货" }),
  ).toBeVisible();
});

test("routes finished transaction to result", async ({ page }) => {
  scenario = "result";
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "出货成功" })).toBeVisible();
});

test("page reload keeps current transaction route", async ({ page }) => {
  scenario = "payment";
  await page.goto("/");
  await expect(page.getByText("订单 ORD-001")).toBeVisible();
  await page.goto("/#/boot");
  await expect(page).toHaveURL(/#\/payment$/);
  await expect(
    page.getByRole("heading", { name: "支付宝扫码支付" }),
  ).toBeVisible();
});

test("daemon snapshots never expose secret fields to browser storage", async ({
  page,
}) => {
  scenario = "catalog";
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "请选择商品" })).toBeVisible();
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

test("sync backlog routes to catalog but displays degraded sync status", async ({
  page,
}) => {
  scenario = "syncBacklog";
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "请选择商品" })).toBeVisible();
  const body = await page.textContent("body");
  expect(body ?? "").toContain("MQTT");
});
