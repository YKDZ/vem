// @vitest-environment jsdom
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";

const {
  routerPushMock,
  routerBackMock,
  routerReplaceMock,
  initializeMock,
  subscribeEventsMock,
  getHealthMock,
  getReadyMock,
  getConfigMock,
  getSaleReadinessMock,
  getCurrentTransactionMock,
  getSaleViewMock,
  getPaymentOptionsMock,
  subscribeVisionProfilesMock,
} = vi.hoisted(() => ({
  routerPushMock: vi.fn(),
  routerBackMock: vi.fn(),
  routerReplaceMock: vi.fn(),
  initializeMock: vi.fn(),
  subscribeEventsMock: vi.fn(),
  getHealthMock: vi.fn(),
  getReadyMock: vi.fn(),
  getConfigMock: vi.fn(),
  getSaleReadinessMock: vi.fn(),
  getCurrentTransactionMock: vi.fn(),
  getSaleViewMock: vi.fn(),
  getPaymentOptionsMock: vi.fn(),
  subscribeVisionProfilesMock: vi.fn(),
}));

vi.mock("vue-router", () => ({
  useRouter: () => ({
    push: routerPushMock,
    back: routerBackMock,
    replace: routerReplaceMock,
  }),
  useRoute: () => ({ params: {} }),
}));

vi.mock("@/daemon/client", () => ({
  daemonClient: {
    initialize: initializeMock,
    subscribeEvents: subscribeEventsMock,
    getHealth: getHealthMock,
    getReady: getReadyMock,
    getConfig: getConfigMock,
    getSaleReadiness: getSaleReadinessMock,
    getCurrentTransaction: getCurrentTransactionMock,
    getSaleView: getSaleViewMock,
    getPaymentOptions: getPaymentOptionsMock,
  },
}));

vi.mock("@/native/vision", () => ({
  subscribeVisionProfiles: subscribeVisionProfilesMock,
}));

import type { VisionProfileSubscriptionHandlers } from "@/native/vision";
import type {
  MachineCatalogItem,
  MachineCatalogSlotCandidate,
} from "@/types/catalog";

import { useCatalogStore } from "@/stores/catalog";
import { useCheckoutStore } from "@/stores/checkout";
import { useConnectivityStore } from "@/stores/connectivity";

import BootView from "./BootView.vue";
import CatalogView from "./CatalogView.vue";
import CheckoutView from "./CheckoutView.vue";

let mountedApp: App<Element> | null = null;
let pinia: ReturnType<typeof createPinia>;
let latestVisionHandlers: VisionProfileSubscriptionHandlers | null = null;

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  vi.clearAllMocks();
  latestVisionHandlers = null;
  subscribeVisionProfilesMock.mockImplementation(
    (_config: unknown, handlers: VisionProfileSubscriptionHandlers) => {
      latestVisionHandlers = handlers;
      return { close: vi.fn() };
    },
  );
  initializeMock.mockResolvedValue(undefined);
  subscribeEventsMock.mockReturnValue({ close: vi.fn() });
  getSaleViewMock.mockRejectedValue(new Error("sale view not mocked"));
  getCurrentTransactionMock.mockResolvedValue({
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
    updatedAt: "2026-06-04T00:00:00Z",
  });
  getConfigMock.mockResolvedValue({
    public: {
      machineCode: "M001",
      apiBaseUrl: "http://localhost:3000/api",
      mqttUrl: "mqtt://localhost:1883",
      mqttUsername: null,
      hardwareAdapter: "mock",
      serialPortPath: null,
      lowerControllerUsbIdentity: null,
      scannerAdapter: "disabled",
      scannerSerialPortPath: null,
      scannerBaudRate: 9600,
      scannerFrameSuffix: "crlf",
      visionEnabled: true,
      visionWsUrl: "ws://127.0.0.1:7892/ws",
      visionRequestTimeoutMs: 8000,
      kioskMode: false,
      stockMovementRetentionDays: 30,
    },
    machineSecretConfigured: true,
    mqttSigningSecretConfigured: true,
    mqttPasswordConfigured: false,
    provisioned: true,
    provisioningIssues: [],
  });
  getPaymentOptionsMock.mockResolvedValue({
    options: [
      {
        optionKey: "mock:mock",
        providerCode: "mock",
        method: "mock",
        displayName: "模拟支付",
        description: "本地模拟",
        icon: "mock",
        disabled: false,
        disabledReason: null,
        recommended: true,
      },
    ],
    defaultOptionKey: "mock:mock",
    defaultProviderCode: "mock",
    serverTime: "2026-06-04T00:00:00Z",
  });
});

afterEach(() => {
  mountedApp?.unmount();
  mountedApp = null;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

function makeCatalogItem(): MachineCatalogItem {
  const item = {
    machineCode: "M001",
    slotId: "550e8400-e29b-41d4-a716-446655440001",
    slotCode: "A1",
    layerNo: 1,
    cellNo: 1,
    inventoryId: "550e8400-e29b-41d4-a716-446655440002",
    variantId: "550e8400-e29b-41d4-a716-446655440003",
    productId: "550e8400-e29b-41d4-a716-446655440004",
    productName: "基础短袖",
    productDescription: null,
    coverImageUrl: null,
    categoryId: null,
    categoryName: "T恤 / 基础短袖",
    sku: "TEE-BASIC-M-BLACK",
    size: "M",
    color: "黑色",
    priceCents: 100,
    capacity: 8,
    parLevel: 6,
    physicalStock: 2,
    saleableStock: 2,
    slotSalesState: "sale_ready",
    productSortOrder: 1,
    targetGender: null,
  } as Omit<
    MachineCatalogItem,
    | "catalogKey"
    | "aggregatedSlotCount"
    | "slotCandidates"
    | "variantCandidates"
  >;
  const slotCandidates: readonly MachineCatalogSlotCandidate[] = [
    {
      slotId: item.slotId,
      slotCode: item.slotCode,
      layerNo: item.layerNo,
      cellNo: item.cellNo,
      inventoryId: item.inventoryId,
      variantId: item.variantId,
      sku: item.sku,
      size: item.size,
      color: item.color,
      priceCents: item.priceCents,
      capacity: item.capacity,
      parLevel: item.parLevel,
      physicalStock: item.physicalStock,
      saleableStock: item.saleableStock,
      slotSalesState: item.slotSalesState,
    },
  ];
  return {
    ...item,
    catalogKey: `product:${item.productId}`,
    aggregatedSlotCount: 1,
    slotCandidates,
    variantCandidates: [
      {
        variantId: item.variantId,
        sku: item.sku,
        size: item.size,
        color: item.color,
        priceCents: item.priceCents,
        capacity: item.capacity,
        parLevel: item.parLevel,
        physicalStock: item.physicalStock,
        saleableStock: item.saleableStock,
        slotSalesState: item.slotSalesState,
        slotCandidates,
      },
    ],
  };
}

function healthSnapshot() {
  return {
    status: "healthy" as const,
    process: {
      component: "daemon",
      level: "ok",
      code: "PROCESS_READY",
      message: "ready",
      updatedAt: "2026-06-04T00:00:00Z",
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
    visionOnline: false,
    remoteOpsActive: false,
    currentTransaction: null,
    operatorReason: "",
    updatedAt: "2026-06-04T00:00:00Z",
  };
}

function readySnapshot() {
  return {
    ready: true,
    canSell: true,
    mode: "catalog",
    blockingCodes: [],
    blockingReasons: [],
    degradedReasons: [],
    suggestedRoute: "catalog" as const,
    updatedAt: "2026-06-04T00:00:00Z",
  };
}

function saleReadiness(canStartNetworkAuthorizedSale: boolean) {
  return {
    canStartNetworkAuthorizedSale,
    blockingCodes: canStartNetworkAuthorizedSale
      ? []
      : ["PLATFORM_UNREACHABLE", "NO_PAYMENT_OPTIONS"],
    components: {
      platformReachability: {
        ready: canStartNetworkAuthorizedSale,
        code: canStartNetworkAuthorizedSale
          ? "PLATFORM_REACHABLE"
          : "PLATFORM_UNREACHABLE",
        message: canStartNetworkAuthorizedSale
          ? "platform reachable"
          : "platform offline",
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
        ready: canStartNetworkAuthorizedSale,
        code: canStartNetworkAuthorizedSale
          ? "PAYMENT_OPTIONS_READY"
          : "NO_PAYMENT_OPTIONS",
        message: canStartNetworkAuthorizedSale
          ? "payment option available"
          : "no ready payment option",
        methods: [],
      },
      scannerCapability: {
        ready: true,
        code: "SCANNER_READY",
        message: "scanner ready",
      },
      syncHealth: {
        ready: true,
        code: "SYNC_READY",
        message: "sync connected",
      },
      wholeMachineBlockers: {
        ready: true,
        code: "WHOLE_MACHINE_READY",
        message: "hardware ready",
      },
    },
  };
}

function applyBlockedSaleReadiness(): void {
  const health = {
    status: "healthy" as const,
    process: {
      component: "daemon",
      level: "ok",
      code: "PROCESS_READY",
      message: "ready",
      updatedAt: "2026-06-04T00:00:00Z",
    },
    components: [],
    configConfigured: true,
    databaseOnline: true,
    backendOnline: false,
    mqttConnected: true,
    outboxSize: 0,
    outboxMax: 1000,
    hardwareOnline: true,
    scannerOnline: true,
    visionOnline: false,
    remoteOpsActive: false,
    currentTransaction: null,
    operatorReason: "",
    updatedAt: "2026-06-04T00:00:00Z",
  };
  const ready = {
    ready: true,
    canSell: true,
    mode: "catalog",
    blockingCodes: [],
    blockingReasons: [],
    degradedReasons: [],
    suggestedRoute: "catalog" as const,
    updatedAt: "2026-06-04T00:00:00Z",
  };
  const readiness = {
    canStartNetworkAuthorizedSale: false,
    blockingCodes: ["PLATFORM_UNREACHABLE", "NO_PAYMENT_OPTIONS"],
    components: {
      platformReachability: {
        ready: false,
        code: "PLATFORM_UNREACHABLE",
        message: "platform offline",
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
        ready: false,
        code: "NO_PAYMENT_OPTIONS",
        message: "no ready payment option",
        methods: [],
      },
      scannerCapability: {
        ready: true,
        code: "SCANNER_READY",
        message: "scanner ready",
      },
      syncHealth: {
        ready: true,
        code: "SYNC_READY",
        message: "sync connected",
      },
      wholeMachineBlockers: {
        ready: true,
        code: "WHOLE_MACHINE_READY",
        message: "hardware ready",
      },
    },
  };
  getHealthMock.mockResolvedValue(health);
  getReadyMock.mockResolvedValue(ready);
  getSaleReadinessMock.mockResolvedValue(readiness);
  useConnectivityStore().applyHealth(health);
  useConnectivityStore().applyReady(ready);
  useConnectivityStore().applySaleReadiness(readiness);
}

async function mountView(component: object): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  mountedApp = createApp(component);
  mountedApp.use(pinia);
  mountedApp.mount(host);
  await nextTick();
  await nextTick();
  return host;
}

describe("sale readiness UI flow", () => {
  it("routes first boot machines without provisioning to the claim-code page", async () => {
    getHealthMock.mockResolvedValue({
      ...healthSnapshot(),
      configConfigured: false,
    });
    getReadyMock.mockResolvedValue({
      ...readySnapshot(),
      canSell: false,
      suggestedRoute: "maintenance",
    });
    getSaleReadinessMock.mockResolvedValue(saleReadiness(false));
    getConfigMock.mockResolvedValue({
      public: {
        machineCode: null,
        apiBaseUrl: "http://localhost:3000/api",
        mqttUrl: "mqtt://localhost:1883",
        mqttUsername: null,
        hardwareAdapter: "mock",
        serialPortPath: null,
        lowerControllerUsbIdentity: null,
        scannerAdapter: "disabled",
        scannerSerialPortPath: null,
        scannerBaudRate: 9600,
        scannerFrameSuffix: "crlf",
        visionEnabled: true,
        visionWsUrl: "ws://127.0.0.1:7892/ws",
        visionRequestTimeoutMs: 8000,
        kioskMode: false,
        stockMovementRetentionDays: 30,
      },
      machineSecretConfigured: false,
      mqttSigningSecretConfigured: false,
      mqttPasswordConfigured: false,
      provisioned: false,
      provisioningIssues: [
        "machine_code_missing",
        "machine_secret_missing",
        "mqtt_signing_secret_missing",
      ],
    });

    await mountView(BootView);

    await vi.waitFor(() => {
      expect(routerReplaceMock).toHaveBeenCalledWith("/provisioning");
    });
  });

  it("does not route to catalog when startup config loading fails", async () => {
    getHealthMock.mockResolvedValue(healthSnapshot());
    getReadyMock.mockResolvedValue(readySnapshot());
    getSaleReadinessMock.mockResolvedValue(saleReadiness(true));
    getConfigMock.mockRejectedValue(new Error("config unavailable"));

    await mountView(BootView);

    await vi.waitFor(() => {
      expect(routerReplaceMock).toHaveBeenCalledWith("/provisioning");
    });
    expect(routerReplaceMock).not.toHaveBeenCalledWith("/catalog");
  });

  it("loads sale readiness during boot so a ready catalog can enter purchase", async () => {
    const item = makeCatalogItem();
    getHealthMock.mockResolvedValue(healthSnapshot());
    getReadyMock.mockResolvedValue(readySnapshot());
    getSaleReadinessMock.mockResolvedValue(saleReadiness(true));
    useCatalogStore().applySnapshot({
      items: [item],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
    });

    await mountView(BootView);

    await vi.waitFor(() => {
      expect(getSaleReadinessMock).toHaveBeenCalledOnce();
    });
    expect(
      useConnectivityStore().saleReadiness?.canStartNetworkAuthorizedSale,
    ).toBe(true);

    const checkoutStore = useCheckoutStore();
    checkoutStore.paymentOptions = [
      {
        optionKey: "mock:mock",
        providerCode: "mock",
        method: "mock",
        displayName: "模拟支付",
        description: "本地模拟",
        icon: "mock",
        disabled: false,
        disabledReason: null,
        recommended: true,
      },
    ];
    checkoutStore.selectedPaymentOptionKey = "mock:mock";
    checkoutStore.selectItem(item);

    expect(checkoutStore.canCreateOrder).toBe(true);
    await vi.waitFor(() => {
      expect(routerReplaceMock).toHaveBeenCalledWith("/catalog");
    });
  });

  it("keeps catalog products visible and navigable when readiness is blocked", async () => {
    const item = makeCatalogItem();
    useCatalogStore().applySnapshot({
      items: [item],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
    });
    applyBlockedSaleReadiness();

    const host = await mountView(CatalogView);

    expect(host.textContent).toContain("T恤");
    expect(host.textContent).toContain("platform offline");
    expect(
      Array.from(host.querySelectorAll("button")).some(
        (button) => button.textContent?.trim() === "刷新",
      ),
    ).toBe(false);
    const categoryButton = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("T恤"),
    );
    expect(categoryButton).toBeTruthy();
    expect(categoryButton?.disabled).toBe(false);

    categoryButton?.click();
    await nextTick();

    expect(host.textContent).toContain("基础短袖");
    expect(host.textContent).toContain("颜色");
    expect(host.textContent).toContain("尺码");
    expect(routerPushMock).not.toHaveBeenCalled();
  });

  it("leaves the catalog when readiness refresh requires maintenance", async () => {
    vi.useFakeTimers();
    const item = makeCatalogItem();
    const blockedHealth = {
      ...healthSnapshot(),
      status: "degraded" as const,
      hardwareOnline: false,
      operatorReason: "LOWER_CONTROLLER_UNAVAILABLE",
    };
    const blockedReady = {
      ...readySnapshot(),
      ready: false,
      canSell: false,
      mode: "maintenance" as const,
      blockingCodes: ["LOWER_CONTROLLER_UNAVAILABLE"],
      blockingReasons: [
        {
          code: "LOWER_CONTROLLER_UNAVAILABLE",
          component: "hardware",
          message: "lower controller unavailable",
        },
      ],
      suggestedRoute: "maintenance" as const,
    };
    useCatalogStore().applySnapshot({
      items: [item],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
    });
    getSaleViewMock.mockResolvedValue({
      items: [item],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
    });
    getHealthMock.mockResolvedValue(blockedHealth);
    getReadyMock.mockResolvedValue(blockedReady);
    getSaleReadinessMock.mockResolvedValue(saleReadiness(false));

    await mountView(CatalogView);

    await vi.waitFor(() => {
      expect(routerReplaceMock).toHaveBeenCalledWith("/maintenance");
    });
  });

  it("keeps vision recognition details silent in the catalog", async () => {
    const item = makeCatalogItem();
    useCatalogStore().applySnapshot({
      items: [{ ...item, size: "M", targetGender: "male" }],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
    });

    const host = await mountView(CatalogView);

    expect(latestVisionHandlers).toBeTruthy();
    await Promise.resolve(
      latestVisionHandlers?.onProfile({
        eventId: "vision-event-001",
        detectedAt: "2026-06-12T10:20:30.000Z",
        profile: {
          personPresent: true,
          heightCm: 172,
          shoulderWidthCm: 43,
          ageRange: "25-34",
          gender: "male",
          bodyType: "regular",
          upperColor: "blue",
          confidence: 0.91,
        },
        quality: {
          overall: "good",
          warnings: ["light glare"],
        },
      }),
    );
    await nextTick();

    expect(host.textContent).not.toContain("视觉识别结果");
    expect(host.textContent).not.toContain("vision-event-001");
    expect(host.textContent).not.toContain("172 cm");
    expect(host.textContent).not.toContain("light glare");
    expect(host.textContent).not.toContain('"heightCm": 172');
    expect(host.textContent).toContain("T恤");
  });

  it("keeps checkout visible but disables order creation when readiness is blocked", async () => {
    const item = makeCatalogItem();
    useCatalogStore().applySnapshot({
      items: [item],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
    });
    useCheckoutStore().selectItem(item);
    applyBlockedSaleReadiness();

    const host = await mountView(CheckoutView);
    await nextTick();

    expect(host.textContent).toContain("确认购买");
    expect(host.textContent).toContain("基础短袖");
    expect(host.textContent).toContain("网络未就绪");
    const submitButton = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("确认并生成支付二维码"),
    );
    expect(submitButton).toBeTruthy();
    expect(submitButton?.disabled).toBe(true);
  });
});
