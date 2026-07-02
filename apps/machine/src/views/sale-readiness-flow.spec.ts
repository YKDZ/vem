// @vitest-environment jsdom
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick, ref, type App } from "vue";

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
  createOrderMock,
  subscribeVisionProfilesMock,
  routeParams,
  routeQuery,
  routeName,
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
  createOrderMock: vi.fn(),
  subscribeVisionProfilesMock: vi.fn(),
  routeParams: {} as Record<string, string>,
  routeQuery: {} as Record<string, string>,
  routeName: { value: "catalog" },
}));

vi.mock("vue-router", () => ({
  useRouter: () => ({
    push: routerPushMock,
    back: routerBackMock,
    replace: routerReplaceMock,
  }),
  useRoute: () => ({
    get name() {
      return routeName.value;
    },
    params: routeParams,
    query: routeQuery,
  }),
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
    createOrder: createOrderMock,
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

import {
  resetCustomerPresenceSessionForTests,
  useReturnHomeOnCustomerDeparture,
} from "@/composables/usePresenceInteraction";
import { machineConfigDefaults } from "@/config/machine-config";
import { useCatalogStore } from "@/stores/catalog";
import { useCheckoutStore } from "@/stores/checkout";
import { useConnectivityStore } from "@/stores/connectivity";
import { useMachineStore } from "@/stores/machine";
import { useVisionStore } from "@/stores/vision";

import BootView from "./BootView.vue";
import CatalogView from "./CatalogView.vue";
import CheckoutView from "./CheckoutView.vue";
import PaymentView from "./PaymentView.vue";
import ProductDetailView from "./ProductDetailView.vue";
import VirtualTryOnView from "./VirtualTryOnView.vue";

let mountedApp: App<Element> | null = null;
let pinia: ReturnType<typeof createPinia>;
let latestVisionHandlers: VisionProfileSubscriptionHandlers | null = null;
let propertyRestorers: Array<() => void> = [];

beforeEach(() => {
  resetCustomerPresenceSessionForTests();
  pinia = createPinia();
  setActivePinia(pinia);
  window.localStorage.clear();
  vi.clearAllMocks();
  for (const key of Object.keys(routeParams)) {
    delete routeParams[key];
  }
  for (const key of Object.keys(routeQuery)) {
    delete routeQuery[key];
  }
  routeName.value = "catalog";
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
  createOrderMock.mockResolvedValue(transactionSnapshot());
});

afterEach(() => {
  resetCustomerPresenceSessionForTests();
  unmountMountedView();
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const restore of propertyRestorers.splice(0).reverse()) {
    restore();
  }
});

function unmountMountedView(): void {
  const app = mountedApp;
  if (app) {
    app.unmount();
  }
  mountedApp = null;
  document.body.innerHTML = "";
}

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
    tryOnSilhouetteUrl: null,
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

function applyTryOnCameraConfig(deviceId: string | null): void {
  useMachineStore().$patch({
    configLoaded: true,
    configSummary: {
      public: {
        ...machineConfigDefaults,
        machineCode: "M001",
        tryOnCameraDeviceId: deviceId,
      },
      machineSecretConfigured: true,
      mqttSigningSecretConfigured: true,
      mqttPasswordConfigured: false,
      provisioned: true,
      provisioningIssues: [],
    },
  });
}

function installMediaDevicesMock(getUserMedia = vi.fn()) {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
  });
  return { getUserMedia };
}

function replaceTestProperty(
  target: object,
  key: PropertyKey,
  value: unknown,
): void {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, {
    configurable: true,
    writable: true,
    value,
  });
  propertyRestorers.push(() => {
    if (descriptor) {
      Object.defineProperty(target, key, descriptor);
    } else {
      delete (target as Record<PropertyKey, unknown>)[key];
    }
  });
}

function spyEgressMethod(
  target: object,
  key: PropertyKey,
  implementation: (...args: never[]) => unknown = () => undefined,
) {
  const current = (target as Record<PropertyKey, unknown>)[key];
  if (typeof current === "function") {
    return vi
      .spyOn(
        target as Record<string, (...args: never[]) => unknown>,
        key as string,
      )
      .mockImplementation(implementation);
  }
  const mock = vi.fn(implementation);
  replaceTestProperty(target, key, mock);
  return mock;
}

function stubEgressConstructor(name: string) {
  const mock = vi.fn();
  replaceTestProperty(globalThis, name, mock);
  return mock;
}

function makeMediaStream() {
  const tracks = [{ stop: vi.fn() }];
  return {
    stream: { getTracks: () => tracks } as unknown as MediaStream,
    tracks,
  };
}

function transactionSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    orderId: "550e8400-e29b-41d4-a716-446655440010",
    orderNo: "ORD-PRIVACY-001",
    productSummary: null,
    paymentNo: "PAY-PRIVACY-001",
    paymentMethod: "qr_code",
    paymentProvider: "alipay",
    paymentUrl: "https://pay.example/1",
    paymentStatus: "pending",
    orderStatus: "pending_payment",
    totalAmountCents: 100,
    vending: null,
    nextAction: "wait_payment",
    maskedAuthCode: null,
    paymentCodeAttempt: null,
    expiresAt: "2026-06-04T00:05:00Z",
    errorCode: null,
    errorMessage: null,
    operatorHint: null,
    updatedAt: "2026-06-04T00:00:00Z",
    ...overrides,
  };
}

function applySensitiveVisionProfile(): void {
  useVisionStore().applyLatestProfileResult({
    eventId: "vision-event-001",
    detectedAt: "2026-06-12T10:20:30.000Z",
    profile: {
      personPresent: true,
      heightCm: 172,
      bodyType: "regular",
      upperColor: "blue",
      confidence: 0.91,
    },
    quality: {
      overall: "good",
      warnings: ["light glare"],
    },
  });
}

function expectRecognitionDetailsHidden(host: HTMLElement): void {
  expect(host.textContent).not.toContain("vision-event-001");
  expect(host.textContent).not.toContain("172 cm");
  expect(host.textContent).not.toContain("light glare");
  expect(host.textContent).not.toContain('"heightCm": 172');
  expect(host.textContent).not.toContain('"confidence": 0.91');
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

  it("does not reopen a dismissed terminal transaction during boot after a fresh reload", async () => {
    const dismissedTransaction = {
      orderId: "550e8400-e29b-41d4-a716-446655440010",
      orderNo: "ORD-DISMISSED-001",
      productSummary: null,
      paymentNo: "PAY-DISMISSED-001",
      paymentMethod: "payment_code",
      paymentProvider: "alipay",
      paymentUrl: null,
      paymentStatus: "refunded",
      orderStatus: "refunded",
      totalAmountCents: 4900,
      vending: {
        commandNo: "CMD-DISMISSED",
        status: "failed",
        lastError: "dispense failure already handled",
      },
      nextAction: "refunded",
      maskedAuthCode: null,
      paymentCodeAttempt: null,
      expiresAt: "2026-06-04T00:05:00Z",
      errorCode: null,
      errorMessage: null,
      operatorHint: null,
      updatedAt: "2026-06-04T00:10:00Z",
    };
    getHealthMock.mockResolvedValue(healthSnapshot());
    getReadyMock.mockResolvedValue(readySnapshot());
    getSaleReadinessMock.mockResolvedValue(saleReadiness(true));
    getCurrentTransactionMock.mockResolvedValue(dismissedTransaction);
    getSaleViewMock.mockResolvedValue({
      items: [makeCatalogItem()],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
    });
    const checkoutStore = useCheckoutStore();
    checkoutStore.applyTransaction(dismissedTransaction);
    checkoutStore.dismissCurrentTerminalTransaction();
    checkoutStore.reset();

    pinia = createPinia();
    setActivePinia(pinia);
    const reloadedCheckoutStore = useCheckoutStore();
    expect(
      reloadedCheckoutStore.shouldIgnoreTransaction(dismissedTransaction),
    ).toBe(true);

    await mountView(BootView);

    await vi.waitFor(() => {
      expect(routerReplaceMock).toHaveBeenCalledWith("/catalog");
    });
    expect(routerReplaceMock).not.toHaveBeenCalledWith({
      name: "result",
      params: { kind: "refunded" },
    });
    expect(reloadedCheckoutStore.currentOrder).toBeNull();
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

  it("opens catalog product detail without selecting a checkout item", async () => {
    const item = makeCatalogItem();
    useCatalogStore().applySnapshot({
      items: [item],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
    });

    const host = await mountView(CatalogView);

    const categoryButton = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("T恤"),
    );
    expect(categoryButton).toBeTruthy();
    categoryButton?.click();
    await nextTick();

    const productButton = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("基础短袖"),
    );
    expect(productButton).toBeTruthy();
    productButton?.click();
    await nextTick();

    expect(routerPushMock).toHaveBeenCalledWith({
      name: "product-detail",
      params: { catalogKey: item.catalogKey },
    });
    expect(useCheckoutStore().selectedItem).toBeNull();
    expect(useCheckoutStore().currentOrder).toBeNull();
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
          ageRange: "adult",
          gender: "male",
          bodyType: "regular",
          upperColor: "blue",
          confidence: 0.91,
        },
        quality: {
          overall: "good",
          warnings: ["light glare"],
        },
      } as Parameters<
        NonNullable<typeof latestVisionHandlers>["onProfile"]
      >[0]),
    );
    await nextTick();

    expect(host.querySelector(".presence-present")).toBeTruthy();
    expect(host.textContent).not.toContain("视觉识别结果");
    expect(host.textContent).not.toContain("vision-event-001");
    expect(host.textContent).not.toContain("172 cm");
    expect(host.textContent).not.toContain("light glare");
    expect(host.textContent).not.toContain('"heightCm": 172');
    expect(host.textContent).toContain("T恤");
  });

  it("keeps vision recognition details silent in the product detail page", async () => {
    const item = makeCatalogItem();
    useCatalogStore().applySnapshot({
      items: [{ ...item, size: "M", targetGender: "male" }],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
    });
    routeParams.catalogKey = item.catalogKey;
    applySensitiveVisionProfile();

    const host = await mountView(ProductDetailView);

    expect(host.textContent).toContain("基础短袖");
    expectRecognitionDetailsHidden(host);
  });

  it("shows routed product detail try-on entry only for the selected variant silhouette", async () => {
    const item = makeCatalogItem();
    const silhouettedVariant: MachineCatalogItem = {
      ...item,
      slotId: "550e8400-e29b-41d4-a716-446655440021",
      inventoryId: "550e8400-e29b-41d4-a716-446655440022",
      variantId: "550e8400-e29b-41d4-a716-446655440023",
      sku: "TEE-BASIC-L-WHITE",
      size: "L",
      color: "白色",
      tryOnSilhouetteUrl:
        "/api/media-assets/550e8400-e29b-41d4-a716-446655440125/content",
    };
    useCatalogStore().applySnapshot({
      items: [item, silhouettedVariant],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
    });
    routeParams.catalogKey = item.catalogKey;

    const host = await mountView(ProductDetailView);

    expect(host.textContent).toContain("基础短袖");
    expect(host.querySelector('[data-test="try-on-entry"]')).toBeNull();

    const sizeLButton = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "L",
    );
    expect(sizeLButton).toBeTruthy();
    sizeLButton?.click();
    await nextTick();

    const tryOnEntry = host.querySelector<HTMLButtonElement>(
      '[data-test="try-on-entry"]',
    );
    expect(tryOnEntry).toBeTruthy();
    expect(tryOnEntry?.disabled).toBe(false);

    tryOnEntry?.click();
    await nextTick();

    expect(routerPushMock).toHaveBeenCalledWith({
      name: "virtual-try-on",
      params: { catalogKey: item.catalogKey },
      query: { variantId: silhouettedVariant.variantId },
    });
    expect(useCheckoutStore().selectedItem).toBeNull();
    expect(useCheckoutStore().currentOrder).toBeNull();

    const sizeMButton = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "M",
    );
    expect(sizeMButton).toBeTruthy();
    sizeMButton?.click();
    await nextTick();

    expect(host.querySelector('[data-test="try-on-entry"]')).toBeNull();
  });

  it("starts virtual try-on with the configured camera and overlays the selected silhouette", async () => {
    const item = makeCatalogItem();
    const tryOnSilhouetteUrl =
      "/api/media-assets/550e8400-e29b-41d4-a716-446655440125/content";
    const silhouettedVariant: MachineCatalogItem = {
      ...item,
      slotId: "550e8400-e29b-41d4-a716-446655440021",
      inventoryId: "550e8400-e29b-41d4-a716-446655440022",
      variantId: "550e8400-e29b-41d4-a716-446655440023",
      sku: "TEE-BASIC-L-WHITE",
      size: "L",
      color: "白色",
      tryOnSilhouetteUrl,
    };
    useCatalogStore().applySnapshot({
      items: [item, silhouettedVariant],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
    });
    applyTryOnCameraConfig("try-on-camera-1");
    const { stream } = makeMediaStream();
    const media = installMediaDevicesMock(vi.fn().mockResolvedValue(stream));
    routeParams.catalogKey = item.catalogKey;
    routeQuery.variantId = silhouettedVariant.variantId;

    const host = await mountView(VirtualTryOnView);

    await vi.waitFor(() => {
      expect(media.getUserMedia).toHaveBeenCalledWith({
        audio: false,
        video: { deviceId: { exact: "try-on-camera-1" } },
      });
    });
    const video = host.querySelector<HTMLVideoElement>(
      '[data-test="try-on-video"]',
    );
    expect(video).toBeTruthy();
    expect(video?.srcObject).toBe(stream);
    const silhouette = host.querySelector<HTMLImageElement>(
      '[data-test="try-on-silhouette"]',
    );
    expect(silhouette?.getAttribute("src")).toBe(tryOnSilhouetteUrl);
    expect(silhouette?.className).toContain("try-on-silhouette-fixed");
  });

  it("keeps try-on preview local without capture, upload, storage, or diagnostic logging", async () => {
    const item = makeCatalogItem();
    const silhouettedVariant: MachineCatalogItem = {
      ...item,
      variantId: "550e8400-e29b-41d4-a716-446655440023",
      sku: "TEE-BASIC-L-WHITE",
      size: "L",
      color: "白色",
      tryOnSilhouetteUrl:
        "/api/media-assets/550e8400-e29b-41d4-a716-446655440125/content",
    };
    useCatalogStore().applySnapshot({
      items: [silhouettedVariant],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
    });
    applyTryOnCameraConfig("try-on-camera-1");
    const { stream } = makeMediaStream();
    const media = installMediaDevicesMock(vi.fn().mockResolvedValue(stream));
    routeParams.catalogKey = item.catalogKey;
    routeQuery.variantId = silhouettedVariant.variantId;
    const fetchSpy = spyEgressMethod(
      globalThis,
      "fetch",
      async () => new Response(null),
    );
    const sendBeaconSpy = spyEgressMethod(navigator, "sendBeacon", () => false);
    const xhrSpy = stubEgressConstructor("XMLHttpRequest");
    const webSocketSpy = stubEgressConstructor("WebSocket");
    const mediaRecorderSpy = stubEgressConstructor("MediaRecorder");
    const imageCaptureSpy = stubEgressConstructor("ImageCapture");
    const tauriInvokeSpy = vi.fn();
    const tauriCoreInvokeSpy = vi.fn();
    replaceTestProperty(globalThis, "__TAURI_INTERNALS__", {
      invoke: tauriInvokeSpy,
    });
    replaceTestProperty(globalThis, "__TAURI__", {
      core: { invoke: tauriCoreInvokeSpy },
    });
    const storageSetSpy = vi.spyOn(Storage.prototype, "setItem");
    const canvasToDataUrlSpy = vi
      .spyOn(HTMLCanvasElement.prototype, "toDataURL")
      .mockReturnValue("data:,");
    const canvasToBlobSpy = vi
      .spyOn(HTMLCanvasElement.prototype, "toBlob")
      .mockImplementation(() => undefined);
    const consoleLogSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);
    const consoleInfoSpy = vi
      .spyOn(console, "info")
      .mockImplementation(() => undefined);
    const consoleWarnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await mountView(VirtualTryOnView);

    await vi.waitFor(() => {
      expect(media.getUserMedia).toHaveBeenCalledWith({
        audio: false,
        video: { deviceId: { exact: "try-on-camera-1" } },
      });
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(sendBeaconSpy).not.toHaveBeenCalled();
    expect(xhrSpy).not.toHaveBeenCalled();
    expect(webSocketSpy).not.toHaveBeenCalled();
    expect(mediaRecorderSpy).not.toHaveBeenCalled();
    expect(imageCaptureSpy).not.toHaveBeenCalled();
    expect(tauriInvokeSpy).not.toHaveBeenCalled();
    expect(tauriCoreInvokeSpy).not.toHaveBeenCalled();
    expect(storageSetSpy).not.toHaveBeenCalled();
    expect(canvasToDataUrlSpy).not.toHaveBeenCalled();
    expect(canvasToBlobSpy).not.toHaveBeenCalled();
    expect(consoleLogSpy).not.toHaveBeenCalled();
    expect(consoleInfoSpy).not.toHaveBeenCalled();
    expect(consoleWarnSpy).not.toHaveBeenCalled();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("does not subscribe to vision profiles or require them for virtual try-on", async () => {
    const item = makeCatalogItem();
    const silhouettedVariant: MachineCatalogItem = {
      ...item,
      variantId: "550e8400-e29b-41d4-a716-446655440023",
      sku: "TEE-BASIC-L-WHITE",
      size: "L",
      color: "白色",
      tryOnSilhouetteUrl:
        "/api/media-assets/550e8400-e29b-41d4-a716-446655440125/content",
    };
    useCatalogStore().applySnapshot({
      items: [silhouettedVariant],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
    });
    applyTryOnCameraConfig("try-on-camera-1");
    applySensitiveVisionProfile();
    const { stream } = makeMediaStream();
    const media = installMediaDevicesMock(vi.fn().mockResolvedValue(stream));
    routeParams.catalogKey = item.catalogKey;
    routeQuery.variantId = silhouettedVariant.variantId;

    const host = await mountView(VirtualTryOnView);

    await vi.waitFor(() => {
      expect(media.getUserMedia).toHaveBeenCalledWith({
        audio: false,
        video: { deviceId: { exact: "try-on-camera-1" } },
      });
    });
    expect(subscribeVisionProfilesMock).not.toHaveBeenCalled();
    expect(
      host.querySelector<HTMLVideoElement>('[data-test="try-on-video"]'),
    ).toBeTruthy();
    expectRecognitionDetailsHidden(host);
  });

  it("does not fall back to a default camera when try-on camera config is missing", async () => {
    const item = makeCatalogItem();
    const tryOnSilhouetteUrl =
      "/api/media-assets/550e8400-e29b-41d4-a716-446655440125/content";
    const silhouettedVariant: MachineCatalogItem = {
      ...item,
      variantId: "550e8400-e29b-41d4-a716-446655440023",
      sku: "TEE-BASIC-L-WHITE",
      size: "L",
      color: "白色",
      tryOnSilhouetteUrl,
    };
    useCatalogStore().applySnapshot({
      items: [silhouettedVariant],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
    });
    applyTryOnCameraConfig(null);
    const media = installMediaDevicesMock();
    routeParams.catalogKey = item.catalogKey;
    routeQuery.variantId = silhouettedVariant.variantId;

    const host = await mountView(VirtualTryOnView);

    expect(media.getUserMedia).not.toHaveBeenCalled();
    expect(
      host.querySelector('[data-test="try-on-error"]')?.textContent,
    ).toContain("维护人员检查摄像头配置与调试");
  });

  it("does not retry with video fallback when the configured try-on camera fails", async () => {
    const item = makeCatalogItem();
    const silhouettedVariant: MachineCatalogItem = {
      ...item,
      variantId: "550e8400-e29b-41d4-a716-446655440023",
      sku: "TEE-BASIC-L-WHITE",
      size: "L",
      color: "白色",
      tryOnSilhouetteUrl:
        "/api/media-assets/550e8400-e29b-41d4-a716-446655440125/content",
    };
    useCatalogStore().applySnapshot({
      items: [silhouettedVariant],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
    });
    applyTryOnCameraConfig("missing-camera");
    const media = installMediaDevicesMock(
      vi.fn().mockRejectedValue(new DOMException("missing", "NotFoundError")),
    );
    routeParams.catalogKey = item.catalogKey;
    routeQuery.variantId = silhouettedVariant.variantId;

    const host = await mountView(VirtualTryOnView);

    await vi.waitFor(() => {
      expect(media.getUserMedia).toHaveBeenCalledTimes(1);
    });
    expect(media.getUserMedia).toHaveBeenCalledWith({
      audio: false,
      video: { deviceId: { exact: "missing-camera" } },
    });
    expect(media.getUserMedia).not.toHaveBeenCalledWith({ video: true });
    expect(
      host.querySelector('[data-test="try-on-error"]')?.textContent,
    ).toContain("维护人员检查摄像头配置与调试");
  });

  it("keeps product detail and checkout usable after try-on camera failure without sending frame data", async () => {
    const item = makeCatalogItem();
    const silhouettedVariant: MachineCatalogItem = {
      ...item,
      variantId: "550e8400-e29b-41d4-a716-446655440023",
      sku: "TEE-BASIC-L-WHITE",
      size: "L",
      color: "白色",
      tryOnSilhouetteUrl:
        "/api/media-assets/550e8400-e29b-41d4-a716-446655440125/content",
    };
    const saleView = {
      items: [silhouettedVariant],
      source: "local_stock" as const,
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
    };
    useCatalogStore().applySnapshot(saleView);
    useConnectivityStore().applyHealth(healthSnapshot());
    useConnectivityStore().applyReady(readySnapshot());
    useConnectivityStore().applySaleReadiness(saleReadiness(true));
    getSaleViewMock.mockResolvedValue(saleView);
    applySensitiveVisionProfile();
    applyTryOnCameraConfig("missing-camera");
    const media = installMediaDevicesMock(
      vi.fn().mockRejectedValue(new DOMException("missing", "NotFoundError")),
    );
    routeParams.catalogKey = item.catalogKey;
    routeQuery.variantId = silhouettedVariant.variantId;

    let host = await mountView(VirtualTryOnView);

    await vi.waitFor(() => {
      expect(media.getUserMedia).toHaveBeenCalledTimes(1);
    });
    expect(
      host.querySelector('[data-test="try-on-error"]')?.textContent,
    ).toContain("维护人员检查摄像头配置与调试");

    unmountMountedView();

    routeParams.catalogKey = item.catalogKey;
    routeQuery.variantId = silhouettedVariant.variantId;
    host = await mountView(ProductDetailView);

    const buyButton = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("立即购买"),
    );
    expect(buyButton).toBeTruthy();
    expect(buyButton?.disabled).toBe(false);
    buyButton?.click();
    await nextTick();

    expect(routerPushMock).toHaveBeenCalledWith("/checkout");
    expect(useCheckoutStore().selectedItem?.variantId).toBe(
      silhouettedVariant.variantId,
    );

    unmountMountedView();

    host = await mountView(CheckoutView);
    await vi.waitFor(() => {
      expect(useCheckoutStore().selectedPaymentOptionKey).toBe("mock:mock");
    });

    const submitButton = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("确认并生成支付二维码"),
    );
    expect(submitButton).toBeTruthy();
    expect(submitButton?.disabled).toBe(false);
    submitButton?.click();

    await vi.waitFor(() => {
      expect(createOrderMock).toHaveBeenCalledOnce();
    });
    expect(createOrderMock).toHaveBeenCalledWith({
      inventoryId: silhouettedVariant.inventoryId,
      quantity: 1,
      planogramVersion: "PLAN-1",
      slotId: silhouettedVariant.slotId,
      slotCode: silhouettedVariant.slotCode,
      paymentMethod: "mock",
      paymentProviderCode: "mock",
      profileSnapshot: null,
    });
    expect(JSON.stringify(createOrderMock.mock.calls)).not.toMatch(
      /frame|image|raw|canvas|dataUrl|blob|base64|diagnostic|vision/i,
    );
    expect(media.getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("keeps product detail and checkout usable when try-on camera config is missing", async () => {
    const item = makeCatalogItem();
    const silhouettedVariant: MachineCatalogItem = {
      ...item,
      variantId: "550e8400-e29b-41d4-a716-446655440023",
      sku: "TEE-BASIC-L-WHITE",
      size: "L",
      color: "白色",
      tryOnSilhouetteUrl:
        "/api/media-assets/550e8400-e29b-41d4-a716-446655440125/content",
    };
    const saleView = {
      items: [silhouettedVariant],
      source: "local_stock" as const,
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
    };
    useCatalogStore().applySnapshot(saleView);
    useConnectivityStore().applyHealth(healthSnapshot());
    useConnectivityStore().applyReady(readySnapshot());
    useConnectivityStore().applySaleReadiness(saleReadiness(true));
    getSaleViewMock.mockResolvedValue(saleView);
    applySensitiveVisionProfile();
    applyTryOnCameraConfig(null);
    const media = installMediaDevicesMock();
    routeParams.catalogKey = item.catalogKey;
    routeQuery.variantId = silhouettedVariant.variantId;

    let host = await mountView(VirtualTryOnView);

    expect(media.getUserMedia).not.toHaveBeenCalled();
    expect(
      host.querySelector('[data-test="try-on-error"]')?.textContent,
    ).toContain("维护人员检查摄像头配置与调试");

    unmountMountedView();

    routeParams.catalogKey = item.catalogKey;
    routeQuery.variantId = silhouettedVariant.variantId;
    host = await mountView(ProductDetailView);

    const buyButton = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("立即购买"),
    );
    expect(buyButton).toBeTruthy();
    expect(buyButton?.disabled).toBe(false);
    buyButton?.click();
    await nextTick();

    expect(routerPushMock).toHaveBeenCalledWith("/checkout");
    expect(useCheckoutStore().selectedItem?.variantId).toBe(
      silhouettedVariant.variantId,
    );

    unmountMountedView();

    host = await mountView(CheckoutView);
    await vi.waitFor(() => {
      expect(useCheckoutStore().selectedPaymentOptionKey).toBe("mock:mock");
    });

    const submitButton = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("确认并生成支付二维码"),
    );
    expect(submitButton).toBeTruthy();
    expect(submitButton?.disabled).toBe(false);
    submitButton?.click();

    await vi.waitFor(() => {
      expect(createOrderMock).toHaveBeenCalledOnce();
    });
    expect(createOrderMock).toHaveBeenCalledWith({
      inventoryId: silhouettedVariant.inventoryId,
      quantity: 1,
      planogramVersion: "PLAN-1",
      slotId: silhouettedVariant.slotId,
      slotCode: silhouettedVariant.slotCode,
      paymentMethod: "mock",
      paymentProviderCode: "mock",
      profileSnapshot: null,
    });
    expect(JSON.stringify(createOrderMock.mock.calls)).not.toMatch(
      /frame|image|raw|canvas|dataUrl|blob|base64|diagnostic|vision/i,
    );
    expectRecognitionDetailsHidden(host);
  });

  it("stops try-on media tracks immediately when leaving the view", async () => {
    const item = makeCatalogItem();
    const silhouettedVariant: MachineCatalogItem = {
      ...item,
      variantId: "550e8400-e29b-41d4-a716-446655440023",
      sku: "TEE-BASIC-L-WHITE",
      size: "L",
      color: "白色",
      tryOnSilhouetteUrl:
        "/api/media-assets/550e8400-e29b-41d4-a716-446655440125/content",
    };
    useCatalogStore().applySnapshot({
      items: [silhouettedVariant],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
    });
    applyTryOnCameraConfig("try-on-camera-1");
    const { stream, tracks } = makeMediaStream();
    installMediaDevicesMock(vi.fn().mockResolvedValue(stream));
    routeParams.catalogKey = item.catalogKey;
    routeQuery.variantId = silhouettedVariant.variantId;

    const host = await mountView(VirtualTryOnView);

    await vi.waitFor(() => {
      expect(
        host.querySelector<HTMLVideoElement>('[data-test="try-on-video"]')
          ?.srcObject,
      ).toBe(stream);
    });
    host.querySelector<HTMLButtonElement>('[data-test="try-on-exit"]')?.click();
    await nextTick();

    expect(tracks[0]?.stop).toHaveBeenCalledOnce();
    expect(routerPushMock).toHaveBeenCalledWith({
      name: "product-detail",
      params: { catalogKey: item.catalogKey },
      query: { variantId: silhouettedVariant.variantId },
    });
  });

  it("stops try-on media tracks when customer departure returns home", async () => {
    const item = makeCatalogItem();
    const silhouettedVariant: MachineCatalogItem = {
      ...item,
      variantId: "550e8400-e29b-41d4-a716-446655440023",
      sku: "TEE-BASIC-L-WHITE",
      size: "L",
      color: "白色",
      tryOnSilhouetteUrl:
        "/api/media-assets/550e8400-e29b-41d4-a716-446655440125/content",
    };
    useCatalogStore().applySnapshot({
      items: [silhouettedVariant],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
    });
    applyTryOnCameraConfig("try-on-camera-1");
    const { stream, tracks } = makeMediaStream();
    installMediaDevicesMock(vi.fn().mockResolvedValue(stream));
    routeName.value = "virtual-try-on";
    routeParams.catalogKey = item.catalogKey;
    routeQuery.variantId = silhouettedVariant.variantId;
    const showTryOn = ref(true);
    routerReplaceMock.mockImplementation(async () => {
      showTryOn.value = false;
      routeName.value = "catalog";
    });

    const App = defineComponent({
      setup() {
        useReturnHomeOnCustomerDeparture();
        return () => (showTryOn.value ? h(VirtualTryOnView) : null);
      },
    });
    const host = await mountView(App);

    await vi.waitFor(() => {
      expect(
        host.querySelector<HTMLVideoElement>('[data-test="try-on-video"]')
          ?.srcObject,
      ).toBe(stream);
    });
    useVisionStore().applyPresenceStatus({
      eventId: "VISION-PRESENCE-PRESENT",
      state: "approach",
      reason: "person_present_but_not_close",
      detectedAt: "2026-06-30T08:05:00.000Z",
      personPresent: true,
      closeNow: false,
      close: false,
      closeTrigger: null,
      proximity: { present: true },
    });
    await nextTick();
    useVisionStore().applyPersonDeparted({
      eventId: "VISION-DEPARTURE-TRY-ON-001",
      detectedAt: "2026-06-30T08:05:05.000Z",
      lastSeenAt: "2026-06-30T08:05:04.000Z",
      reason: "left_frame",
    });
    await nextTick();

    expect(routerReplaceMock).toHaveBeenCalledWith({ name: "catalog" });
    expect(tracks[0]?.stop).toHaveBeenCalledOnce();
  });

  it("stops a stale try-on stream if camera startup completes after unmount", async () => {
    const item = makeCatalogItem();
    const silhouettedVariant: MachineCatalogItem = {
      ...item,
      variantId: "550e8400-e29b-41d4-a716-446655440023",
      sku: "TEE-BASIC-L-WHITE",
      size: "L",
      color: "白色",
      tryOnSilhouetteUrl:
        "/api/media-assets/550e8400-e29b-41d4-a716-446655440125/content",
    };
    useCatalogStore().applySnapshot({
      items: [silhouettedVariant],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
    });
    applyTryOnCameraConfig("try-on-camera-1");
    const { stream, tracks } = makeMediaStream();
    let resolveStream: (stream: MediaStream) => void = () => undefined;
    installMediaDevicesMock(
      vi.fn(
        async () =>
          await new Promise<MediaStream>((resolve) => {
            resolveStream = resolve;
          }),
      ),
    );
    routeParams.catalogKey = item.catalogKey;
    routeQuery.variantId = silhouettedVariant.variantId;

    await mountView(VirtualTryOnView);
    mountedApp?.unmount();
    mountedApp = null;
    resolveStream(stream);

    await vi.waitFor(() => {
      expect(tracks[0]?.stop).toHaveBeenCalledOnce();
    });
  });

  it("restores the selected variant when returning from virtual try-on to product detail", async () => {
    const item = makeCatalogItem();
    const silhouettedVariant: MachineCatalogItem = {
      ...item,
      slotId: "550e8400-e29b-41d4-a716-446655440021",
      inventoryId: "550e8400-e29b-41d4-a716-446655440022",
      variantId: "550e8400-e29b-41d4-a716-446655440023",
      sku: "TEE-BASIC-L-WHITE",
      size: "L",
      color: "白色",
      tryOnSilhouetteUrl:
        "/api/media-assets/550e8400-e29b-41d4-a716-446655440125/content",
    };
    useCatalogStore().applySnapshot({
      items: [item, silhouettedVariant],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
    });
    routeParams.catalogKey = item.catalogKey;
    routeQuery.variantId = silhouettedVariant.variantId;

    const host = await mountView(ProductDetailView);

    expect(host.textContent).toContain("商品尺码：L");
    expect(host.textContent).toContain("商品货号：TEE-BASIC-L-WHITE");
    expect(host.querySelector('[data-test="try-on-entry"]')).toBeTruthy();
  });

  it("keeps vision recognition details silent in checkout", async () => {
    const item = makeCatalogItem();
    useCatalogStore().applySnapshot({
      items: [item],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
    });
    useCheckoutStore().selectItem(item);
    applyBlockedSaleReadiness();
    applySensitiveVisionProfile();

    const host = await mountView(CheckoutView);

    expect(host.textContent).toContain("确认购买");
    expectRecognitionDetailsHidden(host);
  });

  it("keeps vision recognition details silent during payment", async () => {
    const transaction = transactionSnapshot();
    useCheckoutStore().applyTransaction(transaction);
    getCurrentTransactionMock.mockResolvedValue(transaction);
    applySensitiveVisionProfile();

    const host = await mountView(PaymentView);

    expect(host.textContent).toContain("订单支付");
    expectRecognitionDetailsHidden(host);
  });

  it("keeps sale navigation available when vision presence is unavailable", async () => {
    const item = makeCatalogItem();
    useCatalogStore().applySnapshot({
      items: [item],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
    });

    const host = await mountView(CatalogView);
    latestVisionHandlers?.onError?.(
      new Error("vision camera_unavailable: camera unavailable"),
    );
    await nextTick();

    expect(host.querySelector(".presence-present")).toBeNull();
    expect(host.textContent).toContain("T恤");
    const categoryButton = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("T恤"),
    );
    categoryButton?.click();
    await nextTick();

    expect(host.textContent).toContain("基础短袖");
    expect(routerPushMock).not.toHaveBeenCalled();
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
