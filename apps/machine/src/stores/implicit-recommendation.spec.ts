import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";

import type { MachineSaleViewItem } from "@/types/catalog";

import { useCatalogStore } from "./catalog";
import { useImplicitRecommendationStore } from "./implicit-recommendation";

const { traceRecordMock } = vi.hoisted(() => ({
  traceRecordMock: vi.fn(),
}));

vi.mock("@/router/transaction-route-authority", () => ({
  installedMachineRuntimeTrace: () => ({ record: traceRecordMock }),
}));

function saleViewItem(
  variantId: string,
  size: string,
  productSortOrder: number,
): MachineSaleViewItem {
  return {
    machineCode: "VEM-TEST",
    slotId: `slot-${variantId}`,
    slotDisplayLabel: `R7C${productSortOrder}`,
    rowNo: 7,
    cellNo: productSortOrder,
    inventoryId: `inventory-${variantId}`,
    variantId,
    productId: "product-cn",
    productName: "生产同形中文尺码 T恤",
    productDescription: null,
    coverImageUrl: null,
    categoryId: null,
    categoryName: "T恤",
    sku: `SKU-${variantId}`,
    size,
    color: "白色",
    priceCents: 5_900,
    capacity: 8,
    parLevel: 6,
    physicalStock: 3,
    saleableStock: 3,
    slotSalesState: "sale_ready",
    productSortOrder,
    targetGender: null,
  } as MachineSaleViewItem;
}

describe("useImplicitRecommendationStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    traceRecordMock.mockReset();
    useCatalogStore().applySnapshot({
      items: [
        saleViewItem("small", "小码", 1),
        saleViewItem("medium", "中码", 2),
        saleViewItem("large", "大码", 3),
      ],
      source: "test",
      planogramVersion: "planogram-1",
      lastUpdatedAt: "2026-08-24T15:00:00.000Z",
    });
  });

  it("owns the cross-view neutral recommendation and one live refinement", () => {
    const store = useImplicitRecommendationStore();
    store.observeStablePresence({
      present: true,
      occupancy: "single",
      edgeId: "presence-1:arrival",
    });

    expect(store.projection).toMatchObject({
      visible: true,
      banner: "active",
      sessionId: "presence-1",
      canonicalSize: "M",
      products: {
        "product:product-cn": {
          recommendedSize: "M",
          selectedSize: "中码",
        },
      },
    });

    store.acceptLiveProfile({
      source: "front",
      eventId: "profile-1",
      detectedAt: "2026-08-24T15:00:01.000Z",
      occupancy: { state: "single", confidence: 0.91 },
      profile: {
        personPresent: true,
        bodyType: "strong",
        confidence: 0.91,
      },
      quality: { overall: "good", warnings: [], profileUsable: true },
    });
    expect(store.projection).toMatchObject({
      canonicalSize: "L",
      products: {
        "product:product-cn": {
          recommendedSize: "L",
          selectedSize: "大码",
        },
      },
    });

    store.acceptLiveProfile({
      source: "front",
      eventId: "profile-2",
      detectedAt: "2026-08-24T15:00:02.000Z",
      occupancy: { state: "single", confidence: 0.91 },
      profile: {
        personPresent: true,
        bodyType: "slim",
        confidence: 0.91,
      },
      quality: { overall: "good", warnings: [], profileUsable: true },
    });
    expect(store.projection.canonicalSize).toBe("L");
    expect(traceRecordMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "implicit_recommendation",
        event: "ignored_conflicting_profile",
        profileEventId: "profile-2",
      }),
    );
  });

  it("records neutral presentation latency after the Vue presentation flush", async () => {
    const monotonicClock = vi
      .spyOn(performance, "now")
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(137);
    const store = useImplicitRecommendationStore();

    store.observeStablePresence({
      present: true,
      occupancy: "single",
      edgeId: "presence-latency:arrival",
    });
    await nextTick();

    expect(traceRecordMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "implicit_recommendation",
        event: "neutral_presented",
        sessionId: "presence-latency",
        latencyMs: 37,
      }),
    );
    monotonicClock.mockRestore();
  });

  it("does not let color selection cancel a per-product manual size", () => {
    const store = useImplicitRecommendationStore();
    store.observeStablePresence({
      present: true,
      occupancy: "single",
      edgeId: "presence-1:arrival",
    });
    store.selectManualSize("product:product-cn", "小码");
    store.selectColor("product:product-cn", "黑色");

    expect(store.projection.products["product:product-cn"]).toMatchObject({
      recommendedSize: null,
      selectedSize: "小码",
      selectedColor: "黑色",
      manualSizeSelected: true,
    });

    store.acceptSuccessfulVend("order-1");
    expect(store.projection.products["product:product-cn"]).toMatchObject({
      recommendedSize: "M",
      selectedSize: "中码",
      selectedColor: "黑色",
      manualSizeSelected: false,
    });
  });
});
