// @vitest-environment jsdom
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick, ref, type App } from "vue";

const {
  createOrderMock,
  getSaleStartCapabilityMock,
  getSaleViewMock,
  routeState,
  routerBackMock,
  routerPushMock,
  routerReplaceMock,
} = vi.hoisted(() => ({
  createOrderMock: vi.fn(),
  getSaleStartCapabilityMock: vi.fn(),
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
  useVisionRecommendations: () => ({
    currentProfile: ref(null),
    lastVisionResult: ref(null),
  }),
}));

vi.mock("@/daemon/client", () => ({
  daemonClient: {
    createOrder: createOrderMock,
    getSaleStartCapability: getSaleStartCapabilityMock,
    getSaleView: getSaleViewMock,
  },
}));

import type { MachineSaleViewItem } from "@/types/catalog";

import { useCatalogStore } from "@/stores/catalog";
import { useCheckoutStore } from "@/stores/checkout";
import {
  applySaleCapability,
  saleCapabilitySnapshot,
} from "@/test-support/sale-capability";

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
    slotDisplayLabel: "A1",
    rowNo: 1,
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

function applySaleView(): MachineSaleViewItem {
  const item = saleViewItem();
  useCatalogStore().applySnapshot(saleViewSnapshot([item]));
  return item;
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
  getSaleStartCapabilityMock.mockResolvedValue(saleCapabilitySnapshot());
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
    applySaleCapability();

    const host = await mountView(CatalogView);
    const page = host.querySelector('[data-test="catalog-page"]');
    expect(page?.getAttribute("data-vision-recommendation-active")).toBe(
      "false",
    );
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
    expect(product?.getAttribute("data-variant-id")).toBe(item.variantId);
    expect(product?.getAttribute("data-preferred-variant-id")).toBe("");
    expect(product?.getAttribute("data-recommendation-score")).toBe("0");
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
    expect(buy?.getAttribute("data-variant-id")).toBe(item.variantId);
  });

  it("exposes checkout payment-option and submit identity attrs", async () => {
    applySaleView();
    applySaleCapability();
    const checkoutStore = useCheckoutStore();
    const selectedItem = useCatalogStore().availableItems[0];
    if (!selectedItem) throw new Error("expected saleable catalog item");
    checkoutStore.selectItem(selectedItem);

    const host = await mountView(CheckoutView);
    await vi.waitFor(() => {
      expect(checkoutStore.selectedPaymentOptionKey).toBe("qr_code:alipay");
    });
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
