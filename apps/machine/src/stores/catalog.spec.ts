import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
    slotSalesState: "saleable",
    ...overrides,
  };
}

describe("catalog store sale view", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
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
    expect(store.availableItems.map((item) => item.productName)).toEqual([
      "矿泉水",
    ]);
    expect(
      store.itemByInventoryId("550e8400-e29b-41d4-a716-446655440012")
        ?.slotSalesState,
    ).toBe("sold_out");
    expect("availableQty" in store.items[0]).toBe(false);
  });
});
