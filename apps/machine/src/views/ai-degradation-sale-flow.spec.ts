// @vitest-environment jsdom
import {
  VISION_V2_RUNTIME_IDENTITY,
  type EffectiveMachineRuntimeConfiguration,
} from "@vem/shared";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, h, nextTick, type App } from "vue";
import {
  createMemoryHistory,
  createRouter,
  RouterView,
  type Router,
} from "vue-router";

const {
  createOrderMock,
  getCurrentTransactionMock,
  getSaleStartCapabilityMock,
  getSaleViewMock,
  refreshCatalogMock,
} = vi.hoisted(() => ({
  createOrderMock: vi.fn(),
  getCurrentTransactionMock: vi.fn(),
  getSaleStartCapabilityMock: vi.fn(),
  getSaleViewMock: vi.fn(),
  refreshCatalogMock: vi.fn(),
}));

vi.mock("@/daemon/client", () => ({
  daemonClient: {
    createOrder: createOrderMock,
    getCurrentTransaction: getCurrentTransactionMock,
    getSaleStartCapability: getSaleStartCapabilityMock,
    getSaleView: getSaleViewMock,
    refreshCatalog: refreshCatalogMock,
  },
}));

import type { TransactionSnapshot } from "@/daemon/schemas";

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
          reference: "/api/media-assets/garment/content",
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
    productSummary: null,
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

    const pinia = createPinia();
    setActivePinia(pinia);
    const snapshot = saleView();
    getSaleViewMock.mockResolvedValue(snapshot);
    refreshCatalogMock.mockResolvedValue(undefined);
    const capability = saleCapabilitySnapshot();
    getSaleStartCapabilityMock.mockResolvedValue(capability);
    const awaitingPayment = transaction();
    const paymentSucceeded = deferred<TransactionSnapshot>();
    const dispenseSucceeded = deferred<TransactionSnapshot>();
    createOrderMock.mockResolvedValue(awaitingPayment);
    getCurrentTransactionMock
      .mockReturnValueOnce(paymentSucceeded.promise)
      .mockReturnValueOnce(dispenseSucceeded.promise);
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

    paymentSucceeded.resolve(
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

    dispenseSucceeded.resolve(
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
    getSaleViewMock.mockResolvedValue(snapshot);
    refreshCatalogMock.mockResolvedValue(undefined);
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
