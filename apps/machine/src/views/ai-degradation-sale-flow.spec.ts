import {
  VISION_V2_RUNTIME_IDENTITY,
  type EffectiveMachineRuntimeConfiguration,
} from "@vem/shared";
// @vitest-environment jsdom
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createPinia, setActivePinia } from "pinia";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createApp, h, nextTick, type App } from "vue";
import {
  createMemoryHistory,
  createRouter,
  RouterView,
  type Router,
} from "vue-router";

vi.mock("@/native/daemon-connection", () => ({
  getDaemonConnectionInfo: vi.fn(),
}));

import type { TransactionSnapshot } from "@/daemon/schemas";

import { daemonClient } from "@/daemon/client";
import { getDaemonConnectionInfo } from "@/native/daemon-connection";
import { installTransactionRouteAuthority } from "@/router/transaction-route-authority";
import { installVisionRecommendationCoordinator } from "@/runtime/vision-recommendation-coordinator";
import { useCatalogStore } from "@/stores/catalog";
import { useCheckoutStore } from "@/stores/checkout";
import { useMachineStore } from "@/stores/machine";
import { useSaleCapabilityStore } from "@/stores/sale-capability";
import { useVisionStore } from "@/stores/vision";
import { saleCapabilitySnapshot } from "@/test-support/sale-capability";

import CheckoutView from "./CheckoutView.vue";
import DispensingView from "./DispensingView.vue";
import PaymentView from "./PaymentView.vue";
import ProductDetailView from "./ProductDetailView.vue";
import ResultView from "./ResultView.vue";
import TryOnView from "./TryOnView.vue";

const nativeWebSocket = globalThis.WebSocket;
let mountedApp: App<Element> | null = null;
let router: Router | null = null;
let uninstallAuthority: (() => void) | null = null;
let closeVisionCoordinator: (() => void) | null = null;
let daemonServer: Server | null = null;
let daemonBaseUrl = "";
let daemonMode: "idle" | "flow" | "reject_create" | "reject_order" = "idle";
let daemonRequests: Array<{ method: string; path: string; body: unknown }> = [];
let daemonViolations: string[] = [];
let transactionReadIndex = 0;
let paymentSucceededGate: ReturnType<
  typeof deferred<TransactionSnapshot>
> | null = null;
let dispenseSucceededGate: ReturnType<
  typeof deferred<TransactionSnapshot>
> | null = null;

const DAEMON_TOKEN = "ai-degradation-daemon-token";
const FIXED_RANDOM_UUID = "00000000-0000-4000-8000-000000000001";
const EXPECTED_CREATE_ORDER = {
  inventoryId: "550e8400-e29b-41d4-a716-446655440127",
  quantity: 1,
  planogramVersion: "PLAN-1",
  slotId: "550e8400-e29b-41d4-a716-446655440124",
  paymentMethod: "qr_code",
  paymentProviderCode: "alipay",
  profileSnapshot: null,
  idempotencyKey: `checkout:${FIXED_RANDOM_UUID}`,
};
const FLOW_REQUEST_SEQUENCE = [
  "POST /v1/catalog",
  "GET /v1/sale-view",
  "POST /v1/catalog",
  "GET /v1/sale-view",
  "POST /v1/intents/create-order",
  "GET /v1/transactions/current",
  "GET /v1/transactions/current",
  "GET /v1/sale-start-capability",
] as const;

beforeAll(async () => {
  daemonServer = createServer((request, response) => {
    void handleDaemonRequest(request, response).catch((error: unknown) => {
      daemonViolations.push(
        error instanceof Error ? error.message : String(error),
      );
      respondJson(
        response,
        { code: "fixture_failed", message: "fixture failed" },
        500,
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    daemonServer?.once("error", reject);
    daemonServer?.listen(0, "127.0.0.1", resolve);
  });
  const address = daemonServer.address();
  if (!address || typeof address === "string") {
    throw new Error("strict daemon fixture did not allocate a loopback port");
  }
  daemonBaseUrl = `http://127.0.0.1:${address.port}`;
});

beforeEach(async () => {
  daemonMode = "idle";
  daemonRequests = [];
  daemonViolations = [];
  transactionReadIndex = 0;
  paymentSucceededGate = null;
  dispenseSucceededGate = null;
  vi.clearAllMocks();
  vi.mocked(getDaemonConnectionInfo).mockResolvedValue({
    baseUrl: daemonBaseUrl,
    token: DAEMON_TOKEN,
    source: "browser_env",
    mock: true,
  });
  await daemonClient.initialize(true);
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    if (!daemonServer) {
      resolve();
      return;
    }
    daemonServer.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  daemonServer = null;
});

afterEach(() => {
  mountedApp?.unmount();
  uninstallAuthority?.();
  closeVisionCoordinator?.();
  mountedApp = null;
  router = null;
  uninstallAuthority = null;
  closeVisionCoordinator = null;
  globalThis.WebSocket = nativeWebSocket;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function saleView() {
  return {
    items: [
      {
        machineCode: "M001",
        slotId: "550e8400-e29b-41d4-a716-446655440124",
        slotDisplayLabel: "R1C1",
        rowNo: 1,
        cellNo: 1,
        inventoryId: "550e8400-e29b-41d4-a716-446655440127",
        variantId: "550e8400-e29b-41d4-a716-446655440125",
        productId: "550e8400-e29b-41d4-a716-446655440128",
        productName: "蓝色 T 恤",
        productDescription: null,
        coverImageUrl: null,
        tryOnGarmentMedia: {
          id: "550e8400-e29b-41d4-a716-446655440126",
          reference:
            "/api/media-assets/550e8400-e29b-41d4-a716-446655440126/content",
          digest: `sha256:${"a".repeat(64)}`,
          contentType: "image/png" as const,
          byteSize: 2048,
          purpose: "try_on_garment" as const,
          revision: { catalogRevision: "catalog-2", assetRevision: "asset-2" },
        },
        tryOnGarmentReadyUrl: `http://127.0.0.1:65000/media/sha256:${"a".repeat(64)}?grant=abcdefghijklmnop`,
        tryOnGarmentTemplate: "tshirt_short_sleeve" as const,
        categoryId: null,
        categoryName: "T恤",
        sku: "TEE-1",
        size: "M",
        color: "蓝色",
        priceCents: 1000,
        productSortOrder: 1,
        targetGender: null,
        capacity: 1,
        parLevel: 1,
        physicalStock: 1,
        saleableStock: 1,
        slotSalesState: "sale_ready" as const,
      },
    ],
    source: "backend" as const,
    planogramVersion: "PLAN-1",
    lastUpdatedAt: "2026-08-11T00:00:00.000Z",
  };
}

function envelope(type: string, payload: object) {
  return {
    protocol: "vem.vision.v2",
    type,
    messageId: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    payload,
  };
}

function transaction(
  overrides: Partial<TransactionSnapshot> = {},
): TransactionSnapshot {
  return {
    orderId: "550e8400-e29b-41d4-a716-446655440010",
    orderNo: "ORD-AI-DEGRADED-001",
    productSummary: {
      catalogKey: "product:550e8400-e29b-41d4-a716-446655440128",
      productId: "550e8400-e29b-41d4-a716-446655440128",
      variantId: "550e8400-e29b-41d4-a716-446655440125",
      inventoryId: "550e8400-e29b-41d4-a716-446655440127",
      slotId: "550e8400-e29b-41d4-a716-446655440124",
      productName: "蓝色 T 恤",
    },
    paymentId: "550e8400-e29b-41d4-a716-446655440011",
    paymentNo: "PAY-AI-DEGRADED-001",
    paymentMethod: "qr_code",
    paymentProvider: "alipay",
    paymentUrl: "https://pay.example/ai-degraded",
    paymentStatus: "pending",
    orderStatus: "pending_payment",
    totalAmountCents: 1000,
    vending: null,
    nextAction: "wait_payment",
    maskedAuthCode: null,
    paymentCodeAttempt: null,
    expiresAt: "2026-08-11T00:05:00.000Z",
    errorCode: null,
    errorMessage: null,
    operatorHint: null,
    updatedAt: "2026-08-11T00:00:01.000Z",
    ...overrides,
  } as TransactionSnapshot;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function readRequestBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text === "" ? null : (JSON.parse(text) as unknown);
}

function respondJson(
  response: ServerResponse,
  payload: unknown,
  status = 200,
): void {
  if (response.headersSent) return;
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    connection: "close",
  });
  response.end(body);
}

function exactJsonMatches(actual: unknown, expected: unknown): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function transactionIdentityViolation(
  snapshot: TransactionSnapshot,
): string | null {
  const summary = snapshot.productSummary as Record<string, unknown> | null;
  if (
    snapshot.orderNo !== "ORD-AI-DEGRADED-001" ||
    snapshot.paymentId !== "550e8400-e29b-41d4-a716-446655440011" ||
    snapshot.paymentNo !== "PAY-AI-DEGRADED-001" ||
    summary?.catalogKey !== "product:550e8400-e29b-41d4-a716-446655440128" ||
    summary.productId !== "550e8400-e29b-41d4-a716-446655440128" ||
    summary.variantId !== "550e8400-e29b-41d4-a716-446655440125" ||
    summary.inventoryId !== "550e8400-e29b-41d4-a716-446655440127" ||
    summary.slotId !== "550e8400-e29b-41d4-a716-446655440124"
  ) {
    return "transaction identity does not match the selected sale item";
  }
  if (
    snapshot.vending !== null &&
    (snapshot.vending.commandId !== "550e8400-e29b-41d4-a716-446655440012" ||
      snapshot.vending.commandNo !== "CMD-AI-DEGRADED-001")
  ) {
    return "vending identity does not match the created order";
  }
  return null;
}

function catalogRefreshSnapshot() {
  const snapshot = saleView();
  return {
    items: snapshot.items,
    cached: false,
    source: snapshot.source,
    lastUpdatedAt: snapshot.lastUpdatedAt,
    lastError: null,
  };
}

async function handleDaemonRequest(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const method = request.method ?? "GET";
  const path = new URL(request.url ?? "/", daemonBaseUrl).pathname;
  const body = await readRequestBody(request);
  daemonRequests.push({ method, path, body });

  if (request.headers.authorization !== `Bearer ${DAEMON_TOKEN}`) {
    daemonViolations.push("missing or incorrect daemon bearer token");
    respondJson(
      response,
      { code: "unauthorized", message: "unauthorized" },
      401,
    );
    return;
  }

  if (daemonMode === "reject_create") {
    if (
      method !== "POST" ||
      path !== "/v1/intents/create-order" ||
      !exactJsonMatches(body, EXPECTED_CREATE_ORDER)
    ) {
      daemonViolations.push("create-order payload identity mismatch");
      respondJson(
        response,
        {
          code: "identity_mismatch",
          message: "create-order identity mismatch",
        },
        400,
      );
      return;
    }
    respondJson(response, transaction());
    return;
  }

  if (daemonMode === "reject_order") {
    const mutated = transaction({ orderNo: "ORD-WRONG-IDENTITY" });
    const violation = transactionIdentityViolation(mutated);
    if (method !== "GET" || path !== "/v1/transactions/current" || violation) {
      daemonViolations.push(violation ?? "unexpected order identity probe");
      respondJson(
        response,
        { code: "identity_mismatch", message: "transaction identity mismatch" },
        409,
      );
      return;
    }
    respondJson(response, mutated);
    return;
  }

  if (daemonMode !== "flow") {
    daemonViolations.push(`unexpected request while idle: ${method} ${path}`);
    respondJson(
      response,
      { code: "unexpected", message: "unexpected request" },
      500,
    );
    return;
  }

  const requestIndex = daemonRequests.length - 1;
  const actualStep = `${method} ${path}`;
  if (FLOW_REQUEST_SEQUENCE[requestIndex] !== actualStep) {
    daemonViolations.push(
      `request ${requestIndex} expected ${FLOW_REQUEST_SEQUENCE[requestIndex] ?? "end"}, received ${actualStep}`,
    );
    respondJson(
      response,
      { code: "sequence_mismatch", message: "sequence mismatch" },
      409,
    );
    return;
  }

  if (path === "/v1/catalog" && method === "POST") {
    if (body !== null)
      daemonViolations.push("catalog refresh body must be empty");
    respondJson(response, catalogRefreshSnapshot());
    return;
  }
  if (path === "/v1/sale-view" && method === "GET") {
    respondJson(response, saleView());
    return;
  }
  if (path === "/v1/intents/create-order" && method === "POST") {
    if (
      request.headers["content-type"] !== "application/json" ||
      !exactJsonMatches(body, EXPECTED_CREATE_ORDER)
    ) {
      daemonViolations.push(
        "create-order method, content type, or exact JSON mismatch",
      );
      respondJson(
        response,
        {
          code: "identity_mismatch",
          message: "create-order identity mismatch",
        },
        400,
      );
      return;
    }
    const snapshot = transaction();
    const violation = transactionIdentityViolation(snapshot);
    if (violation) {
      daemonViolations.push(violation);
      respondJson(
        response,
        { code: "identity_mismatch", message: violation },
        409,
      );
      return;
    }
    respondJson(response, snapshot);
    return;
  }
  if (path === "/v1/transactions/current" && method === "GET") {
    const gate =
      transactionReadIndex++ === 0
        ? paymentSucceededGate
        : dispenseSucceededGate;
    if (!gate) throw new Error("transaction response gate is missing");
    const snapshot = await gate.promise;
    const violation = transactionIdentityViolation(snapshot);
    if (violation) {
      daemonViolations.push(violation);
      respondJson(
        response,
        { code: "identity_mismatch", message: violation },
        409,
      );
      return;
    }
    respondJson(response, snapshot);
    return;
  }
  if (path === "/v1/sale-start-capability" && method === "GET") {
    respondJson(response, saleCapabilitySnapshot());
    return;
  }
  daemonViolations.push(`unhandled strict daemon request: ${actualStep}`);
  respondJson(response, { code: "not_found", message: "not found" }, 404);
}

function machineConfiguration(): EffectiveMachineRuntimeConfiguration {
  return {
    machine: { code: "M001" },
  } as EffectiveMachineRuntimeConfiguration;
}

type SentVisionFrame = {
  type?: string;
  payload?: { attemptId?: string; mode?: string };
};

describe("AI degradation public sale flow", () => {
  it("continues the ordinary sale through payment and dispense after a public AI failure without starting Fast", async () => {
    const sockets: ProtocolSocket[] = [];
    class ProtocolSocket extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readyState = ProtocolSocket.OPEN;
      readonly sent: SentVisionFrame[] = [];
      constructor(_url: string) {
        super();
        sockets.push(this);
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }
      send(value: string): void {
        this.sent.push(JSON.parse(value));
      }
      close(): void {
        this.readyState = ProtocolSocket.CLOSED;
      }
      emit(message: object): void {
        this.dispatchEvent(
          new MessageEvent("message", { data: JSON.stringify(message) }),
        );
      }
    }
    globalThis.WebSocket = ProtocolSocket as unknown as typeof WebSocket;
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(
      FIXED_RANDOM_UUID,
    );

    daemonMode = "reject_create";
    await expect(
      daemonClient.createOrder({
        ...EXPECTED_CREATE_ORDER,
        inventoryId: "550e8400-e29b-41d4-a716-446655449999",
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      daemonClient.createOrder({
        ...EXPECTED_CREATE_ORDER,
        slotId: "550e8400-e29b-41d4-a716-446655449998",
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(daemonViolations).toEqual([
      "create-order payload identity mismatch",
      "create-order payload identity mismatch",
    ]);

    daemonMode = "reject_order";
    await expect(daemonClient.getCurrentTransaction()).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(daemonViolations[daemonViolations.length - 1]).toBe(
      "transaction identity does not match the selected sale item",
    );

    daemonMode = "flow";
    daemonRequests = [];
    daemonViolations = [];
    transactionReadIndex = 0;
    const paymentGate = deferred<TransactionSnapshot>();
    const dispenseGate = deferred<TransactionSnapshot>();
    paymentSucceededGate = paymentGate;
    dispenseSucceededGate = dispenseGate;

    const pinia = createPinia();
    setActivePinia(pinia);
    const snapshot = saleView();
    const capability = saleCapabilitySnapshot();
    useCatalogStore().applySnapshot(snapshot);
    useSaleCapabilityStore().acceptSnapshot(capability);
    useVisionStore().applyVisionReady({
      serverName: "vision",
      serverVersion: "1",
      schemaVersion: VISION_V2_RUNTIME_IDENTITY.schemaVersion,
      bundleVersion: VISION_V2_RUNTIME_IDENTITY.bundleVersion,
      contractDigest: VISION_V2_RUNTIME_IDENTITY.contractDigest,
      cameraReady: true,
      fastReady: true,
      aiReady: true,
      aiReadinessDiagnostic: "ready",
      visionBusinessReady: true,
      businessReadinessDiagnostic: "ready",
      capabilities: ["try_on_fast", "try_on_ai"],
    });
    router = createRouter({
      history: createMemoryHistory(),
      routes: [
        {
          path: "/catalog",
          name: "catalog",
          component: { template: "<p>商品目录</p>" },
        },
        {
          path: "/products/:catalogKey",
          name: "product-detail",
          component: ProductDetailView,
        },
        { path: "/try-on", name: "try-on", component: TryOnView },
        { path: "/checkout", name: "checkout", component: CheckoutView },
        { path: "/payment", name: "payment", component: PaymentView },
        { path: "/dispensing", name: "dispensing", component: DispensingView },
        { path: "/result/:kind", name: "result", component: ResultView },
      ],
    });
    uninstallAuthority = installTransactionRouteAuthority(router, pinia);
    await router.push({
      name: "product-detail",
      params: { catalogKey: "product:550e8400-e29b-41d4-a716-446655440128" },
      query: { variantId: "550e8400-e29b-41d4-a716-446655440125" },
    });
    const host = document.createElement("div");
    document.body.append(host);
    mountedApp = createApp({ render: () => h(RouterView) });
    mountedApp.use(pinia).use(router).mount(host);
    await nextTick();

    host.querySelector<HTMLButtonElement>('[data-test="try-on-ai"]')?.click();
    await vi.waitFor(() => {
      expect(sockets).toHaveLength(1);
    });
    sockets[0].emit(
      envelope("vision.ready", {
        serverName: "vision",
        serverVersion: "1",
        schemaVersion: VISION_V2_RUNTIME_IDENTITY.schemaVersion,
        bundleVersion: VISION_V2_RUNTIME_IDENTITY.bundleVersion,
        contractDigest: VISION_V2_RUNTIME_IDENTITY.contractDigest,
        cameraReady: true,
        fastReady: true,
        aiReady: true,
        aiReadinessDiagnostic: "ready",
        visionBusinessReady: true,
        businessReadinessDiagnostic: "ready",
        capabilities: ["try_on_fast", "try_on_ai"],
      }),
    );
    await vi.waitFor(() => {
      expect(
        sockets[0].sent.find(
          (frame) => frame.type === "vision.try_on.attempt.start",
        ),
      ).toBeTruthy();
    });
    const start = sockets[0].sent.find(
      (frame) => frame.type === "vision.try_on.attempt.start",
    );
    if (!start?.payload?.attemptId) {
      throw new Error("expected public AI attempt start frame");
    }
    sockets[0].emit(
      envelope("vision.try_on.attempt.failed", {
        attemptId: start.payload.attemptId,
        reason: "ai_failed",
      }),
    );
    await vi.waitFor(() => {
      expect(host.querySelector('[data-test="try-on-failure"]')).not.toBeNull();
    });

    expect(
      sockets
        .flatMap((socket) => socket.sent)
        .filter(
          (frame) =>
            frame.type === "vision.try_on.attempt.start" &&
            frame.payload?.mode === "fast",
        ),
    ).toEqual([]);
    host
      .querySelector<HTMLButtonElement>('[data-test="try-on-return"]')
      ?.click();
    await vi.waitFor(() => {
      expect(router?.currentRoute.value.name).toBe("product-detail");
    });
    const buy = host.querySelector<HTMLButtonElement>(
      '[data-test="product-buy"]',
    );
    expect(buy?.disabled).toBe(false);
    buy?.click();
    await vi.waitFor(() => {
      expect(router?.currentRoute.value.name).toBe("checkout");
    });
    expect(host.textContent).toContain("确认购买");
    expect(useCheckoutStore().selectedItem?.productName).toBe("蓝色 T 恤");
    expect(useSaleCapabilityStore().canStartSale).toBe(true);
    const submit = host.querySelector<HTMLButtonElement>(
      '[data-test="checkout-submit"]',
    );
    expect(submit?.disabled).toBe(false);
    submit?.click();
    await vi.waitFor(() => {
      expect(router?.currentRoute.value.name).toBe("payment");
    });
    expect(host.querySelector('[data-test="payment-page"]')).not.toBeNull();
    expect(useCheckoutStore().transaction?.orderNo).toBe("ORD-AI-DEGRADED-001");

    paymentGate.resolve(
      transaction({
        paymentStatus: "succeeded",
        orderStatus: "dispensing",
        nextAction: "dispensing",
        vending: {
          commandId: "550e8400-e29b-41d4-a716-446655440012",
          commandNo: "CMD-AI-DEGRADED-001",
          status: "sent",
          lastError: null,
        },
        updatedAt: "2026-08-11T00:00:02.000Z",
      }),
    );
    await vi.waitFor(() => {
      expect(router?.currentRoute.value.name).toBe("dispensing");
    });
    expect(host.querySelector('[data-test="dispensing-page"]')).not.toBeNull();
    expect(host.textContent).toContain("正在出货");

    dispenseGate.resolve(
      transaction({
        paymentStatus: "succeeded",
        orderStatus: "fulfilled",
        nextAction: "success",
        vending: {
          commandId: "550e8400-e29b-41d4-a716-446655440012",
          commandNo: "CMD-AI-DEGRADED-001",
          status: "succeeded",
          lastError: null,
        },
        updatedAt: "2026-08-11T00:00:03.000Z",
      }),
    );
    await vi.waitFor(() => {
      expect(router?.currentRoute.value.name).toBe("result");
    });
    expect(host.querySelector('[data-test="result-page"]')).not.toBeNull();
    expect(host.textContent).toContain("出货完成");
    expect(useCheckoutStore().selectedItem?.productName).toBe("蓝色 T 恤");
    expect(useSaleCapabilityStore().canStartSale).toBe(true);
    await vi.waitFor(() => {
      expect(daemonRequests).toHaveLength(FLOW_REQUEST_SEQUENCE.length);
    });
    expect(
      daemonRequests.map(({ method, path }) => `${method} ${path}`),
    ).toEqual(FLOW_REQUEST_SEQUENCE);
    expect(daemonViolations).toEqual([]);
    expect(daemonRequests[4]?.body).toEqual(EXPECTED_CREATE_ORDER);
    expect(
      sockets
        .flatMap((socket) => socket.sent)
        .filter((frame) => frame.type === "vision.try_on.attempt.start"),
    ).toHaveLength(1);
  });

  it("hides only AI after a public missing-pack ready frame while Fast, buy, and catalog remain available", async () => {
    const sockets: ProtocolSocket[] = [];
    class ProtocolSocket extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readyState = ProtocolSocket.OPEN;
      readonly sent: SentVisionFrame[] = [];
      constructor(_url: string) {
        super();
        sockets.push(this);
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }
      send(value: string): void {
        this.sent.push(JSON.parse(value));
      }
      close(): void {
        this.readyState = ProtocolSocket.CLOSED;
      }
      emit(message: object): void {
        this.dispatchEvent(
          new MessageEvent("message", { data: JSON.stringify(message) }),
        );
      }
    }
    globalThis.WebSocket = ProtocolSocket as unknown as typeof WebSocket;

    const pinia = createPinia();
    setActivePinia(pinia);
    const snapshot = saleView();
    useCatalogStore().applySnapshot(snapshot);
    useSaleCapabilityStore().acceptSnapshot(saleCapabilitySnapshot());
    useMachineStore().applyEffectiveRuntimeConfiguration(
      machineConfiguration(),
    );
    closeVisionCoordinator =
      installVisionRecommendationCoordinator(pinia).close;
    await vi.waitFor(() => {
      expect(sockets).toHaveLength(1);
    });
    await vi.waitFor(() => {
      expect(
        sockets[0].sent.some((frame) => frame.type === "vision.hello"),
      ).toBe(true);
    });
    sockets[0].emit(
      envelope("vision.ready", {
        serverName: "vision",
        serverVersion: "1",
        schemaVersion: VISION_V2_RUNTIME_IDENTITY.schemaVersion,
        bundleVersion: VISION_V2_RUNTIME_IDENTITY.bundleVersion,
        contractDigest: VISION_V2_RUNTIME_IDENTITY.contractDigest,
        cameraReady: true,
        fastReady: true,
        aiReady: false,
        aiReadinessDiagnostic: "model_pack_missing",
        visionBusinessReady: true,
        businessReadinessDiagnostic: "ready",
        capabilities: ["try_on_fast"],
      }),
    );
    await vi.waitFor(() => {
      expect(useVisionStore().aiReadinessDiagnostic).toBe("model_pack_missing");
    });

    router = createRouter({
      history: createMemoryHistory(),
      routes: [
        {
          path: "/catalog",
          name: "catalog",
          component: { template: "<p>商品目录</p>" },
        },
        {
          path: "/products/:catalogKey",
          name: "product-detail",
          component: ProductDetailView,
        },
        { path: "/try-on", name: "try-on", component: TryOnView },
        { path: "/checkout", name: "checkout", component: CheckoutView },
      ],
    });
    uninstallAuthority = installTransactionRouteAuthority(router, pinia);
    await router.push({
      name: "product-detail",
      params: { catalogKey: "product:550e8400-e29b-41d4-a716-446655440128" },
      query: { variantId: "550e8400-e29b-41d4-a716-446655440125" },
    });
    const host = document.createElement("div");
    document.body.append(host);
    mountedApp = createApp({ render: () => h(RouterView) });
    mountedApp.use(pinia).use(router).mount(host);
    await nextTick();

    expect(host.querySelector('[data-test="try-on-ai"]')).toBeNull();
    expect(host.querySelector('[data-test="try-on-fast"]')).not.toBeNull();
    const buy = host.querySelector<HTMLButtonElement>(
      '[data-test="product-buy"]',
    );
    expect(buy?.disabled).toBe(false);
    await router.push({ name: "catalog" });
    expect(host.textContent).toContain("商品目录");
    expect(useSaleCapabilityStore().canStartSale).toBe(true);
    expect(
      sockets
        .flatMap((socket) => socket.sent)
        .filter((frame) => frame.type === "vision.try_on.attempt.start"),
    ).toEqual([]);
  });
});
