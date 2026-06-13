import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getSaleViewMock } = vi.hoisted(() => ({
  getSaleViewMock: vi.fn(),
}));

vi.mock("@/daemon/client", () => ({
  daemonClient: {
    getSaleView: getSaleViewMock,
  },
}));

import { useCatalogStore } from "./catalog";

function saleViewItem(overrides: Record<string, unknown> = {}) {
  return {
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
    physicalStock: 2,
    saleableStock: 2,
    slotSalesState: "sale_ready",
    ...overrides,
  };
}

describe("catalog store sale view", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  afterEach(() => {
    useCatalogStore().stopAutoRefresh();
    vi.useRealTimers();
  });

  it("loads machine sale view and filters saleable items without availableQty", async () => {
    getSaleViewMock.mockResolvedValue({
      items: [
        saleViewItem(),
        saleViewItem({
          slotId: "550e8400-e29b-41d4-a716-446655440011",
          slotCode: "A2",
          inventoryId: "550e8400-e29b-41d4-a716-446655440012",
          productName: "苏打水",
          sku: "SODA-001",
          physicalStock: 0,
          saleableStock: 0,
          slotSalesState: "sold_out",
        }),
      ],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
    });

    const store = useCatalogStore();
    await store.load();

    expect(getSaleViewMock).toHaveBeenCalledOnce();
    expect(store.items).toHaveLength(2);
    expect(store.planogramVersion).toBe("PLAN-1");
    expect(store.availableItems.map((item) => item.productName)).toEqual([
      "矿泉水",
    ]);
    expect(
      store.itemByInventoryId("550e8400-e29b-41d4-a716-446655440012")
        ?.slotSalesState,
    ).toBe("sold_out");
    expect("availableQty" in store.items[0]).toBe(false);
  });

  it("excludes reconciliation-blocked slots from saleable catalog items", async () => {
    getSaleViewMock.mockResolvedValue({
      items: [
        saleViewItem({
          slotSalesState: "needs_platform_review",
          physicalStock: 2,
          saleableStock: 2,
        }),
      ],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
    });

    const store = useCatalogStore();
    await store.load();

    expect(store.items[0].slotSalesState).toBe("needs_platform_review");
    expect(store.availableItems).toHaveLength(0);
  });

  it("aggregates multiple saleable slots for the same SKU into one catalog item", async () => {
    getSaleViewMock.mockResolvedValue({
      items: [
        saleViewItem({ saleableStock: 2, physicalStock: 2 }),
        saleViewItem({
          slotId: "550e8400-e29b-41d4-a716-446655440011",
          slotCode: "B1",
          layerNo: 2,
          cellNo: 1,
          inventoryId: "550e8400-e29b-41d4-a716-446655440012",
          saleableStock: 5,
          physicalStock: 5,
        }),
      ],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
    });

    const store = useCatalogStore();
    await store.load();

    expect(store.availableItems).toHaveLength(1);
    expect(store.availableItems[0]).toMatchObject({
      sku: "WATER-001",
      saleableStock: 7,
      physicalStock: 7,
      aggregatedSlotCount: 2,
    });
    expect(
      store.availableItems[0].slotCandidates.map((slot) => slot.slotCode),
    ).toEqual(["A1", "B1"]);
  });

  it("auto-refreshes the sale view without a manual catalog button", async () => {
    vi.useFakeTimers();
    getSaleViewMock
      .mockResolvedValueOnce({
        items: [saleViewItem({ physicalStock: 1, saleableStock: 1 })],
        source: "local_stock",
        planogramVersion: "PLAN-1",
        lastUpdatedAt: "2026-06-04T00:00:00Z",
      })
      .mockResolvedValueOnce({
        items: [saleViewItem({ physicalStock: 5, saleableStock: 5 })],
        source: "platform_stock_sync",
        planogramVersion: "PLAN-1",
        lastUpdatedAt: "2026-06-04T00:00:05Z",
      });

    const store = useCatalogStore();
    store.startAutoRefresh(1_000);
    await vi.waitFor(() => {
      expect(store.items[0]?.saleableStock).toBe(1);
    });

    await vi.advanceTimersByTimeAsync(1_000);

    await vi.waitFor(() => {
      expect(store.items[0]?.saleableStock).toBe(5);
    });
    expect(getSaleViewMock).toHaveBeenCalledTimes(2);
    expect(store.source).toBe("platform_stock_sync");
    expect(store.autoRefreshEnabled).toBe(true);
  });

  it("deduplicates overlapping sale-view refresh requests", async () => {
    let resolveSnapshot: (value: unknown) => void = () => undefined;
    getSaleViewMock.mockReturnValue(
      new Promise((resolve) => {
        resolveSnapshot = resolve;
      }),
    );

    const store = useCatalogStore();
    const first = store.refresh();
    const second = store.refresh();

    expect(getSaleViewMock).toHaveBeenCalledOnce();
    resolveSnapshot?.({
      items: [saleViewItem()],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
    });
    await Promise.all([first, second]);

    expect(store.items).toHaveLength(1);
  });
});
