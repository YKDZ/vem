// @vitest-environment jsdom
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";

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

vi.mock("@/composables/customer-interaction-session", () => ({
  useCustomerInteractionSession: () => ({
    state: { value: { active: false } },
  }),
}));

vi.mock("@/composables/stable-vision-presence-session", () => ({
  getStableVisionPresenceSession: () => ({
    state: { value: { present: false } },
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
import { useImplicitRecommendationStore } from "@/stores/implicit-recommendation";
import { useSaleCapabilityStore } from "@/stores/sale-capability";
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

  it("renders one perceptible recommendation across home, catalog, and product detail", async () => {
    const productId = "550e8400-e29b-41d4-a716-446655440104";
    const items = [
      saleViewItem({
        productId,
        inventoryId: "550e8400-e29b-41d4-a716-446655440111",
        variantId: "550e8400-e29b-41d4-a716-446655440121",
        slotId: "550e8400-e29b-41d4-a716-446655440131",
        sku: "TSHIRT-S",
        productName: "基础 T恤",
        size: "小码",
        categoryName: "T恤",
      }),
      saleViewItem({
        productId,
        inventoryId: "550e8400-e29b-41d4-a716-446655440112",
        variantId: "550e8400-e29b-41d4-a716-446655440122",
        slotId: "550e8400-e29b-41d4-a716-446655440132",
        sku: "TSHIRT-M",
        productName: "基础 T恤",
        size: "中码",
        categoryName: "T恤",
      }),
      saleViewItem({
        productId,
        inventoryId: "550e8400-e29b-41d4-a716-446655440113",
        variantId: "550e8400-e29b-41d4-a716-446655440123",
        slotId: "550e8400-e29b-41d4-a716-446655440133",
        sku: "TSHIRT-L",
        productName: "基础 T恤",
        size: "大码",
        categoryName: "T恤",
      }),
    ];
    useCatalogStore().applySnapshot(saleViewSnapshot(items));
    useImplicitRecommendationStore().observeStablePresence({
      present: true,
      occupancy: "single",
      edgeId: "presence-1:arrival",
    });

    let host = await mountView(CatalogView);
    expect(host.textContent).toContain("智能选码已开启");
    expect(
      host
        .querySelector('[data-test="catalog-page"]')
        ?.getAttribute("data-recommendation-canonical-size"),
    ).toBe("M");

    host
      .querySelector(
        '[data-test="catalog-category"][data-category-key="tshirts"]',
      )
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();
    const card = host.querySelector('[data-test="catalog-product"]');
    expect(card?.textContent).toContain("支持智能选码 · 进入查看");
    expect(card?.getAttribute("data-preferred-variant-id")).toBe(
      "550e8400-e29b-41d4-a716-446655440122",
    );

    mountedApp?.unmount();
    mountedApp = null;
    host.remove();
    routeState.params = { catalogKey: `product:${productId}` };
    host = await mountView(ProductDetailView);
    expect(host.textContent).toContain("推荐 M");
    expect(
      host
        .querySelector('[data-test="product-size-option"][data-size="中码"]')
        ?.getAttribute("data-vision-recommended"),
    ).toBe("true");
  });

  it("asks for one customer during stable multiple occupancy and hides unsupported sizing", async () => {
    useCatalogStore().applySnapshot(
      saleViewSnapshot([
        saleViewItem({
          productName: "多人场景 T恤",
          categoryName: "T恤",
          size: "中码",
        }),
      ]),
    );
    const recommendation = useImplicitRecommendationStore();
    recommendation.observeStablePresence({
      present: true,
      occupancy: "multiple",
      edgeId: "presence-1:arrival",
    });

    const host = await mountView(CatalogView);
    expect(host.textContent).toContain("请一位顾客站到镜头前获取尺码建议");
    expect(host.textContent).not.toContain("智能选码已开启");
    expect(
      host
        .querySelector('[data-test="implicit-recommendation-banner"]')
        ?.getAttribute("data-recommendation-state"),
    ).toBe("multiple");

    useCatalogStore().applySnapshot({
      ...saleViewSnapshot([
        saleViewItem({
          productName: "均码商品",
          categoryName: "T恤",
          size: "均码",
        }),
      ]),
      planogramVersion: "PLAN-2",
      lastUpdatedAt: "2026-07-15T00:00:01.000Z",
    });
    await nextTick();
    expect(
      host.querySelector('[data-test="implicit-recommendation-banner"]'),
    ).toBeNull();
  });

  it("keeps a manual size through profile refinement and treats color as a separate choice", async () => {
    const productId = "550e8400-e29b-41d4-a716-446655440204";
    const items = [
      saleViewItem({
        productId,
        inventoryId: "550e8400-e29b-41d4-a716-446655440211",
        variantId: "550e8400-e29b-41d4-a716-446655440221",
        slotId: "550e8400-e29b-41d4-a716-446655440231",
        sku: "TSHIRT-S-WHITE",
        size: "小码",
        color: "白色",
        categoryName: "T恤",
      }),
      saleViewItem({
        productId,
        inventoryId: "550e8400-e29b-41d4-a716-446655440212",
        variantId: "550e8400-e29b-41d4-a716-446655440222",
        slotId: "550e8400-e29b-41d4-a716-446655440232",
        sku: "TSHIRT-S-BLACK",
        size: "小码",
        color: "黑色",
        categoryName: "T恤",
      }),
      saleViewItem({
        productId,
        inventoryId: "550e8400-e29b-41d4-a716-446655440213",
        variantId: "550e8400-e29b-41d4-a716-446655440223",
        slotId: "550e8400-e29b-41d4-a716-446655440233",
        sku: "TSHIRT-M-WHITE",
        size: "中码",
        color: "白色",
        categoryName: "T恤",
      }),
      saleViewItem({
        productId,
        inventoryId: "550e8400-e29b-41d4-a716-446655440214",
        variantId: "550e8400-e29b-41d4-a716-446655440224",
        slotId: "550e8400-e29b-41d4-a716-446655440234",
        sku: "TSHIRT-L-WHITE",
        size: "大码",
        color: "白色",
        categoryName: "T恤",
      }),
    ];
    useCatalogStore().applySnapshot(saleViewSnapshot(items));
    const recommendation = useImplicitRecommendationStore();
    recommendation.observeStablePresence({
      present: true,
      occupancy: "single",
      edgeId: "presence-1:arrival",
    });
    routeState.params = { catalogKey: `product:${productId}` };
    const host = await mountView(ProductDetailView);

    host
      .querySelector('[data-test="product-size-option"][data-size="小码"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();
    const black = [...host.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "黑色",
    );
    black?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();

    recommendation.acceptLiveProfile({
      source: "front",
      eventId: "profile-strong",
      detectedAt: "2026-08-24T15:00:01.000Z",
      occupancy: { state: "single", confidence: 0.91 },
      profile: {
        personPresent: true,
        bodyType: "strong",
        confidence: 0.91,
      },
      quality: { overall: "good", warnings: [], profileUsable: true },
    });
    await nextTick();

    const page = host.querySelector('[data-test="product-detail-page"]');
    expect(page?.getAttribute("data-variant-id")).toBe(
      "550e8400-e29b-41d4-a716-446655440222",
    );
    expect(page?.getAttribute("data-vision-recommendation-active")).toBe(
      "false",
    );
    expect(
      recommendation.projection.products[`product:${productId}`],
    ).toMatchObject({
      selectedSize: "小码",
      selectedColor: "黑色",
      manualSizeSelected: true,
    });

    useCatalogStore().applySnapshot({
      ...saleViewSnapshot(
        items.map((candidate) =>
          candidate.variantId === "550e8400-e29b-41d4-a716-446655440222"
            ? {
                ...candidate,
                physicalStock: 0,
                saleableStock: 0,
                slotSalesState: "sold_out",
              }
            : candidate,
        ),
      ),
      planogramVersion: "PLAN-2",
      lastUpdatedAt: "2026-07-15T00:00:01.000Z",
    });
    await nextTick();

    expect(page?.getAttribute("data-variant-id")).toBe(
      "550e8400-e29b-41d4-a716-446655440222",
    );
    const buy = host.querySelector<HTMLButtonElement>(
      '[data-test="product-buy"]',
    );
    expect(buy?.disabled).toBe(true);
    expect(buy?.textContent).toContain("该规格暂不可购买");
    expect(
      recommendation.projection.products[`product:${productId}`],
    ).toMatchObject({
      selectedSize: "小码",
      selectedColor: "黑色",
      manualSizeSelected: true,
    });
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
    expect(
      submit?.getAttribute("data-checkout-attempt-idempotency-key"),
    ).toMatch(/^checkout:/);
  });

  it("renders projected payment creation copy instead of a raw daemon failure", async () => {
    applySaleView();
    applySaleCapability();
    createOrderMock.mockRejectedValueOnce(
      new Error(
        "HTTP 502 provider MQTT IPC serial COM3 schema validation failed",
      ),
    );
    const checkoutStore = useCheckoutStore();
    const selectedItem = useCatalogStore().availableItems[0];
    if (!selectedItem) throw new Error("expected saleable catalog item");
    checkoutStore.selectItem(selectedItem);

    const host = await mountView(CheckoutView);
    const submit = host.querySelector('[data-test="checkout-submit"]');
    submit?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await vi.waitFor(() => {
      expect(host.textContent).toContain("支付订单创建失败，请稍后重试");
    });
    expect(host.textContent).not.toContain("HTTP 502");
    expect(host.textContent).not.toContain("MQTT");
    expect(host.textContent).not.toContain("COM3");
    expect(host.textContent).not.toContain("schema validation");
  });

  it("does not render raw payment-option or sale-blocker diagnostics", async () => {
    applySaleView();
    const capability = saleCapabilitySnapshot({
      canStartSale: false,
      blockerMessage: "HTTP 502 provider MQTT IPC serial COM3 schema failed",
      paymentCodeReady: false,
    });
    capability.paymentOptions.options[1].disabledReason =
      "provider scanner serial COM3 unavailable over IPC";
    useSaleCapabilityStore().acceptSnapshot(capability);
    const checkoutStore = useCheckoutStore();
    const selectedItem = useCatalogStore().availableItems[0];
    if (!selectedItem) throw new Error("expected saleable catalog item");
    checkoutStore.selectItem(selectedItem);

    const host = await mountView(CheckoutView);

    expect(host.textContent).toContain("设备暂不可用，请联系工作人员");
    expect(host.textContent).not.toContain("HTTP 502");
    expect(host.textContent).not.toContain("MQTT");
    expect(host.textContent).not.toContain("IPC");
    expect(host.textContent).not.toContain("COM3");
    expect(host.textContent).not.toContain("schema failed");
  });
});
