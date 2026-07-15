// @vitest-environment jsdom
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";

const {
  createOrderMock,
  getHealthMock,
  getPaymentOptionsMock,
  getReadyMock,
  getSaleReadinessMock,
  getSaleViewMock,
  routeState,
  routerBackMock,
  routerPushMock,
  routerReplaceMock,
} = vi.hoisted(() => ({
  createOrderMock: vi.fn(),
  getHealthMock: vi.fn(),
  getPaymentOptionsMock: vi.fn(),
  getReadyMock: vi.fn(),
  getSaleReadinessMock: vi.fn(),
  getSaleViewMock: vi.fn(),
  routeState: { params: {}, query: {} },
  routerBackMock: vi.fn(),
  routerPushMock: vi.fn(),
  routerReplaceMock: vi.fn(),
}));

vi.mock("vue-router", () => ({
  useRoute: () => routeState,
  useRouter: () => ({
    back: routerBackMock,
    push: routerPushMock,
    replace: routerReplaceMock,
  }),
}));

vi.mock("@/layouts/KioskLayout.vue", () => ({
  default: { template: "<main><slot /></main>" },
}));

vi.mock("@/components/KioskHeader.vue", () => ({
  default: { template: "<header />" },
}));

vi.mock("@/components/catalog/ManagedMediaImage.vue", () => ({
  default: {
    props: ["alt"],
    template: '<img :alt="alt" />',
  },
}));

vi.mock("@/composables/useCatalogNotifications", () => ({
  useCatalogNotifications: () => ({
    primaryNotification: { value: null },
  }),
}));

vi.mock("@/composables/usePresenceInteraction", () => ({
  usePresenceInteraction: () => ({
    presenceClass: "presence-idle",
  }),
}));

vi.mock("@/composables/useVisionRecommendations", () => ({
  useVisionRecommendations: () => undefined,
}));

vi.mock("@/composables/useCustomerEvents", () => ({
  emitCustomerEvent: vi.fn(),
}));

vi.mock("@/daemon/client", () => ({
  daemonClient: {
    createOrder: createOrderMock,
    getHealth: getHealthMock,
    getPaymentOptions: getPaymentOptionsMock,
    getReady: getReadyMock,
    getSaleReadiness: getSaleReadinessMock,
    getSaleView: getSaleViewMock,
  },
}));

import type {
  HealthSnapshot,
  MachineSaleReadiness,
  ReadySnapshot,
} from "@/daemon/schemas";
import type { MachineSaleViewItem } from "@/types/catalog";

import { useCatalogStore } from "@/stores/catalog";
import { useCheckoutStore } from "@/stores/checkout";
import { useConnectivityStore } from "@/stores/connectivity";

import CatalogView from "./CatalogView.vue";
import CheckoutView from "./CheckoutView.vue";
import ProductDetailView from "./ProductDetailView.vue";

let mountedApp: App<Element> | null = null;
let pinia: ReturnType<typeof createPinia>;

function saleViewItem(
  overrides: Partial<MachineSaleViewItem> = {},
): MachineSaleViewItem {
  return {
    machineCode: "M001",
    slotId: "550e8400-e29b-41d4-a716-446655440001",
    slotCode: "A1",
    layerNo: 1,
    cellNo: 1,
    inventoryId: "550e8400-e29b-41d4-a716-446655440002",
    variantId: "550e8400-e29b-41d4-a716-446655440003",
    productId: "550e8400-e29b-41d4-a716-446655440004",
    productName: "基础棉袜",
    productDescription: null,
    coverImageUrl: null,
    categoryId: null,
    categoryName: "袜子",
    sku: "SOCK-001",
    size: "M",
    color: "白色",
    priceCents: 1200,
    productSortOrder: 1,
    targetGender: null,
    capacity: 8,
    parLevel: 6,
    physicalStock: 2,
    saleableStock: 2,
    slotSalesState: "sale_ready",
    ...overrides,
  };
}

function saleViewSnapshot(items = [saleViewItem()]) {
  return {
    items,
    source: "local_stock",
    planogramVersion: "PLAN-1",
    lastUpdatedAt: "2026-07-15T00:00:00.000Z",
  };
}

function healthFixture(): HealthSnapshot {
  return {
    status: "healthy",
    process: {
      component: "daemon",
      level: "ok",
      code: "PROCESS_READY",
      message: "ready",
      updatedAt: "2026-07-15T00:00:00.000Z",
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
    operatorReason: "",
    updatedAt: "2026-07-15T00:00:00.000Z",
  } as HealthSnapshot;
}

function readyFixture(): ReadySnapshot {
  return {
    ready: true,
    canSell: true,
    mode: "catalog",
    blockingCodes: [],
    blockingReasons: [],
    degradedReasons: [],
    suggestedRoute: "catalog",
    updatedAt: "2026-07-15T00:00:00.000Z",
  };
}

function saleReadinessFixture(): MachineSaleReadiness {
  return {
    canStartNetworkAuthorizedSale: true,
    blockingCodes: [],
    components: {
      platformReachability: {
        ready: true,
        code: "PLATFORM_REACHABLE",
        message: "platform reachable",
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
        ready: true,
        code: "PAYMENT_OPTIONS_READY",
        message: "payment option available",
        methods: [
          {
            method: "qr_code",
            optionKey: "qr_code:alipay",
            providerCode: "alipay",
            ready: true,
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
        code: "SYNC_READY",
        message: "sync connected",
      },
      wholeMachineBlockers: {
        ready: true,
        code: "WHOLE_MACHINE_READY",
        message: "hardware ready",
      },
      slotSaleSafety: {
        ready: true,
        code: "SLOT_SALE_SAFETY_READY",
        message: "slot sale safety ready",
        blockedSlots: [],
      },
    },
  };
}

function applySaleView(): MachineSaleViewItem {
  const item = saleViewItem();
  useCatalogStore().applySnapshot(saleViewSnapshot([item]));
  return item;
}

function applySaleReadiness(): void {
  const connectivityStore = useConnectivityStore();
  connectivityStore.applyHealth(healthFixture());
  connectivityStore.applyReady(readyFixture());
  connectivityStore.applySaleReadiness(saleReadinessFixture());
}

async function mountView(component: object): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  mountedApp = createApp(component);
  mountedApp.use(pinia);
  mountedApp.mount(host);
  await nextTick();
  await Promise.resolve();
  await nextTick();
  return host;
}

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  vi.clearAllMocks();
  routeState.params = {};
  routeState.query = {};
  getSaleViewMock.mockResolvedValue(saleViewSnapshot());
  getHealthMock.mockResolvedValue(healthFixture());
  getReadyMock.mockResolvedValue(readyFixture());
  getSaleReadinessMock.mockResolvedValue(saleReadinessFixture());
  getPaymentOptionsMock.mockResolvedValue({
    options: [
      {
        optionKey: "qr_code:alipay",
        providerCode: "alipay",
        method: "qr_code",
        displayName: "支付宝扫码",
        description: "请使用支付宝扫描屏幕二维码",
        icon: "alipay",
        disabled: false,
        disabledReason: null,
        recommended: true,
      },
    ],
    defaultOptionKey: "qr_code:alipay",
    defaultProviderCode: "alipay",
    serverTime: "2026-07-15T00:00:00.000Z",
  });
});

afterEach(() => {
  mountedApp?.unmount();
  mountedApp = null;
  useCatalogStore().stopAutoRefresh();
  document.body.innerHTML = "";
});

describe("customer acceptance hooks", () => {
  it("exposes catalog category and product identity attrs", async () => {
    const item = applySaleView();
    applySaleReadiness();

    const host = await mountView(CatalogView);
    const category = host.querySelector(
      '[data-test="catalog-category"][data-category-key="socks"]',
    );
    expect(category).toBeInstanceOf(HTMLButtonElement);

    category?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();

    const product = host.querySelector('[data-test="catalog-product"]');
    expect(product?.getAttribute("data-catalog-key")).toBe(
      `product:${item.productId}`,
    );
    expect(product?.getAttribute("data-slot-id")).toBe(item.slotId);
    expect(product?.getAttribute("data-slot-code")).toBe(item.slotCode);
    expect(product?.getAttribute("data-variant-id")).toBe(item.variantId);
  });

  it("exposes product buy identity attrs", async () => {
    const item = applySaleView();
    routeState.params = { catalogKey: `product:${item.productId}` };

    const host = await mountView(ProductDetailView);
    const page = host.querySelector('[data-test="product-detail-page"]');
    const buy = host.querySelector('[data-test="product-buy"]');

    expect(page?.getAttribute("data-catalog-key")).toBe(
      `product:${item.productId}`,
    );
    expect(buy).toBeInstanceOf(HTMLButtonElement);
    expect(buy?.getAttribute("data-catalog-key")).toBe(
      `product:${item.productId}`,
    );
    expect(buy?.getAttribute("data-slot-id")).toBe(item.slotId);
    expect(buy?.getAttribute("data-slot-code")).toBe(item.slotCode);
    expect(buy?.getAttribute("data-variant-id")).toBe(item.variantId);
  });

  it("exposes checkout payment-option and submit identity attrs", async () => {
    applySaleView();
    applySaleReadiness();
    const checkoutStore = useCheckoutStore();
    const selectedItem = useCatalogStore().availableItems[0];
    if (!selectedItem) throw new Error("expected saleable catalog item");
    checkoutStore.selectItem(selectedItem);

    const host = await mountView(CheckoutView);
    const option = host.querySelector('[data-test="payment-option"]');
    const submit = host.querySelector('[data-test="checkout-submit"]');

    expect(option?.getAttribute("data-payment-option-key")).toBe(
      "qr_code:alipay",
    );
    expect(option?.getAttribute("data-payment-method")).toBe("qr_code");
    expect(option?.getAttribute("data-payment-provider")).toBe("alipay");
    expect(submit).toBeInstanceOf(HTMLButtonElement);
    expect(submit?.getAttribute("data-catalog-key")).toBe(
      checkoutStore.selectedItem?.catalogKey,
    );
    expect(submit?.getAttribute("data-slot-id")).toBe(
      checkoutStore.selectedItem?.slotId,
    );
    expect(submit?.getAttribute("data-payment-method")).toBe("qr_code");
    expect(submit?.getAttribute("data-payment-provider")).toBe("alipay");
  });
});
