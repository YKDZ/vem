// @vitest-environment jsdom
import type { VisionProfile } from "@vem/shared";

import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick, ref } from "vue";

import type { MachineCatalogItem } from "@/types/catalog";

import { useCatalogStore } from "@/stores/catalog";

import ProductDetailPanel from "./ProductDetailPanel.vue";

let pinia: ReturnType<typeof createPinia>;

function makeCatalogItem(): MachineCatalogItem {
  const variantCandidates = [
    {
      variantId: "m-white",
      sku: "TSHIRT-M-WHITE",
      size: "M",
      color: "白色",
      priceCents: 1000,
      tryOnSilhouetteUrl: null,
      capacity: 10,
      parLevel: 8,
      physicalStock: 3,
      saleableStock: 3,
      slotSalesState: "sale_ready" as const,
      slotCandidates: [],
    },
    {
      variantId: "l-blue",
      sku: "TSHIRT-L-BLUE",
      size: "L",
      color: "蓝色",
      priceCents: 1000,
      tryOnSilhouetteUrl: null,
      capacity: 10,
      parLevel: 8,
      physicalStock: 3,
      saleableStock: 3,
      slotSalesState: "sale_ready" as const,
      slotCandidates: [],
    },
  ];
  return {
    machineCode: "M001",
    slotId: "slot-m-white",
    slotCode: "A1",
    layerNo: 1,
    cellNo: 1,
    inventoryId: "inv-m-white",
    variantId: "m-white",
    productId: "product-1",
    productName: "基础短袖",
    productDescription: null,
    coverImageUrl: null,
    tryOnSilhouetteUrl: null,
    categoryId: null,
    categoryName: "T恤",
    sku: "TSHIRT-M-WHITE",
    size: "M",
    color: "白色",
    priceCents: 1000,
    capacity: 10,
    parLevel: 8,
    physicalStock: 3,
    saleableStock: 3,
    slotSalesState: "sale_ready",
    productSortOrder: 1,
    targetGender: null,
    catalogKey: "product:product-1",
    aggregatedSlotCount: 2,
    slotCandidates: [],
    variantCandidates,
  };
}

function selectedOptionText(host: HTMLElement): string {
  return Array.from(host.querySelectorAll("button"))
    .filter((button) => button.className.includes("bg-neutral-950"))
    .map((button) => button.textContent?.trim())
    .join(" ");
}

describe("ProductDetailPanel recommendation policy", () => {
  let host: HTMLDivElement;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("updates the default variant from later recommendation profiles until the customer chooses manually", async () => {
    const item = makeCatalogItem();
    useCatalogStore().applySnapshot({
      items: [item],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
    });
    const profile = ref<VisionProfile | null>(null);
    const Wrapper = defineComponent({
      setup() {
        return () =>
          h(ProductDetailPanel, {
            item,
            profile: profile.value,
            onPurchase: () => undefined,
          });
      },
    });

    createApp(Wrapper).use(pinia).mount(host);
    await nextTick();
    expect(selectedOptionText(host)).toContain("M");
    expect(selectedOptionText(host)).toContain("白色");

    profile.value = {
      personPresent: true,
      heightCm: 178,
      bodyType: "regular",
      upperColor: "蓝",
    };
    await nextTick();

    expect(selectedOptionText(host)).toContain("L");
    expect(selectedOptionText(host)).toContain("蓝色");
  });

  it("uses an available recommendation as the initial default variant", async () => {
    const item = makeCatalogItem();
    useCatalogStore().applySnapshot({
      items: [item],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
    });

    createApp(ProductDetailPanel, {
      item,
      profile: {
        personPresent: true,
        heightCm: 178,
        bodyType: "regular",
        upperColor: "蓝",
      } satisfies VisionProfile,
    })
      .use(pinia)
      .mount(host);
    await nextTick();

    expect(selectedOptionText(host)).toContain("L");
    expect(selectedOptionText(host)).toContain("蓝色");
  });

  it("falls back to normal manual purchase when recommendation is unavailable", async () => {
    const baseItem = makeCatalogItem();
    const onPurchase = vi.fn();
    const catalogStore = useCatalogStore();
    catalogStore.applySnapshot({
      items: [
        baseItem,
        {
          ...baseItem,
          slotId: "slot-l-blue",
          slotCode: "B1",
          inventoryId: "inv-l-blue",
          variantId: "l-blue",
          sku: "TSHIRT-L-BLUE",
          size: "L",
          color: "蓝色",
        },
      ],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
    });
    const item = catalogStore.itemByCatalogKey(baseItem.catalogKey);
    expect(item).toBeTruthy();

    createApp(ProductDetailPanel, {
      item: item!,
      profile: null,
      onPurchase,
    })
      .use(pinia)
      .mount(host);
    await nextTick();
    const manualSize = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "L",
    );
    expect(manualSize).toBeTruthy();
    manualSize?.click();
    await nextTick();
    expect(selectedOptionText(host)).toContain("L");
    expect(selectedOptionText(host)).toContain("蓝色");
    const purchaseButton = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("下单"),
    );
    expect(purchaseButton?.disabled).toBe(false);
    purchaseButton?.click();

    expect(onPurchase).toHaveBeenCalledWith(
      expect.objectContaining({ variantId: "l-blue" }),
    );
  });

  it("does not override a manually selected variant when later recommendation profiles arrive", async () => {
    const item = makeCatalogItem();
    useCatalogStore().applySnapshot({
      items: [item],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
    });
    const profile = ref<VisionProfile | null>({
      personPresent: true,
      heightCm: 178,
      bodyType: "regular",
      upperColor: "蓝",
    });
    const Wrapper = defineComponent({
      setup() {
        return () =>
          h(ProductDetailPanel, {
            item,
            profile: profile.value,
            onPurchase: () => undefined,
          });
      },
    });

    createApp(Wrapper).use(pinia).mount(host);
    await nextTick();
    expect(selectedOptionText(host)).toContain("L");

    const manualSize = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "M",
    );
    expect(manualSize).toBeTruthy();
    manualSize?.click();
    await nextTick();
    expect(selectedOptionText(host)).toContain("M");

    profile.value = {
      personPresent: true,
      heightCm: 180,
      bodyType: "regular",
      upperColor: "蓝",
    };
    await nextTick();

    expect(selectedOptionText(host)).toContain("M");
    expect(selectedOptionText(host)).not.toContain("L");
  });

  it("reselects a saleable default when the automatic variant becomes unsaleable after refresh", async () => {
    const baseItem = makeCatalogItem();
    const catalogStore = useCatalogStore();
    catalogStore.applySnapshot({
      items: [
        baseItem,
        {
          ...baseItem,
          slotId: "slot-l-blue",
          slotCode: "B1",
          inventoryId: "inv-l-blue",
          variantId: "l-blue",
          sku: "TSHIRT-L-BLUE",
          size: "L",
          color: "蓝色",
        },
      ],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
    });
    const item = ref(catalogStore.itemByCatalogKey(baseItem.catalogKey)!);
    const onPurchase = vi.fn();
    const Wrapper = defineComponent({
      setup() {
        return () =>
          h(ProductDetailPanel, {
            item: item.value,
            profile: null,
            onPurchase,
          });
      },
    });

    createApp(Wrapper).use(pinia).mount(host);
    await nextTick();
    expect(selectedOptionText(host)).toContain("M");

    catalogStore.applySnapshot({
      items: [
        {
          ...baseItem,
          saleableStock: 0,
          physicalStock: 0,
          slotSalesState: "sold_out",
        },
        {
          ...baseItem,
          slotId: "slot-l-blue",
          slotCode: "B1",
          inventoryId: "inv-l-blue",
          variantId: "l-blue",
          sku: "TSHIRT-L-BLUE",
          size: "L",
          color: "蓝色",
        },
      ],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:01:00Z",
    });
    item.value = catalogStore.itemByCatalogKey(baseItem.catalogKey)!;
    await nextTick();

    expect(selectedOptionText(host)).toContain("L");
    expect(selectedOptionText(host)).toContain("蓝色");
    const purchaseButton = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("下单"),
    );
    expect(purchaseButton?.disabled).toBe(false);
    purchaseButton?.click();
    expect(onPurchase).toHaveBeenCalledWith(
      expect.objectContaining({ variantId: "l-blue" }),
    );
  });

  it("shows try-on only when the selected variant has a silhouette", async () => {
    const item = makeCatalogItem();
    item.tryOnSilhouetteUrl =
      "/api/media-assets/550e8400-e29b-41d4-a716-446655440125/content";
    item.variantCandidates = [
      {
        ...item.variantCandidates[0],
        tryOnSilhouetteUrl: item.tryOnSilhouetteUrl,
      },
      {
        ...item.variantCandidates[1],
        tryOnSilhouetteUrl: null,
      },
    ];
    useCatalogStore().applySnapshot({
      items: [item],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
    });

    createApp(ProductDetailPanel, {
      item,
      profile: null,
      onPurchase: () => undefined,
    })
      .use(pinia)
      .mount(host);
    await nextTick();

    expect(host.textContent).toContain("试穿");
    const largeSize = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "L",
    );
    largeSize?.click();
    await nextTick();

    expect(selectedOptionText(host)).toContain("L");
    expect(host.textContent).not.toContain("试穿");
  });

  it("does not show try-on for category-matched products without a selected variant silhouette", async () => {
    const item = makeCatalogItem();
    item.categoryName = "T恤";
    useCatalogStore().applySnapshot({
      items: [item],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
    });

    createApp(ProductDetailPanel, {
      item,
      profile: null,
      onPurchase: () => undefined,
    })
      .use(pinia)
      .mount(host);
    await nextTick();

    expect(host.textContent).not.toContain("试穿");
  });
});
