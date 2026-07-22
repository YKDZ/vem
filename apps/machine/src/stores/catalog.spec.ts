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

import type { MachineSaleViewItem } from "@/types/catalog";

import { useCatalogStore } from "./catalog";

function saleViewItem(
  overrides: Record<string, unknown> = {},
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
          slotDisplayLabel: "A2",
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

  it("aggregates multiple saleable slots for the same variant into one catalog item", async () => {
    getSaleViewMock.mockResolvedValue({
      items: [
        saleViewItem({ saleableStock: 2, physicalStock: 2 }),
        saleViewItem({
          slotId: "550e8400-e29b-41d4-a716-446655440011",
          slotDisplayLabel: "B1",
          rowNo: 2,
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
      store.availableItems[0].slotCandidates.map(
        (slot) => slot.slotDisplayLabel,
      ),
    ).toEqual(["A1", "B1"]);
  });

  it("aggregates different variants of the same product into one catalog item", async () => {
    getSaleViewMock.mockResolvedValue({
      items: [
        saleViewItem({
          sku: "TSHIRT-M-BLACK",
          size: "M",
          color: "黑色",
          saleableStock: 2,
          physicalStock: 2,
        }),
        saleViewItem({
          slotId: "550e8400-e29b-41d4-a716-446655440011",
          slotDisplayLabel: "B1",
          rowNo: 2,
          cellNo: 1,
          inventoryId: "550e8400-e29b-41d4-a716-446655440012",
          variantId: "550e8400-e29b-41d4-a716-446655440013",
          sku: "TSHIRT-L-WHITE",
          size: "L",
          color: "白色",
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
      productId: "550e8400-e29b-41d4-a716-446655440004",
      saleableStock: 7,
      physicalStock: 7,
      aggregatedSlotCount: 2,
    });
    expect(
      store.availableItems[0].variantCandidates.map((variant) => ({
        sku: variant.sku,
        saleableStock: variant.saleableStock,
      })),
    ).toEqual([
      { sku: "TSHIRT-M-BLACK", saleableStock: 2 },
      { sku: "TSHIRT-L-WHITE", saleableStock: 5 },
    ]);
  });

  it("keeps try-on silhouettes on the selected variant rather than product category", async () => {
    getSaleViewMock.mockResolvedValue({
      items: [
        saleViewItem({
          productName: "基础短袖",
          categoryName: "T恤",
          sku: "TSHIRT-M-WHITE",
          size: "M",
          color: "白色",
          tryOnSilhouetteUrl:
            "/api/media-assets/550e8400-e29b-41d4-a716-446655440125/content",
        }),
        saleViewItem({
          slotId: "550e8400-e29b-41d4-a716-446655440011",
          slotDisplayLabel: "B1",
          rowNo: 2,
          cellNo: 1,
          inventoryId: "550e8400-e29b-41d4-a716-446655440012",
          variantId: "550e8400-e29b-41d4-a716-446655440013",
          productName: "基础短袖",
          categoryName: "T恤",
          sku: "TSHIRT-L-BLUE",
          size: "L",
          color: "蓝色",
          tryOnSilhouetteUrl: null,
        }),
      ],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
    });

    const store = useCatalogStore();
    await store.load();

    expect(
      store.availableItems[0].variantCandidates.map((variant) => ({
        sku: variant.sku,
        tryOnSilhouetteUrl: variant.tryOnSilhouetteUrl,
      })),
    ).toEqual([
      {
        sku: "TSHIRT-M-WHITE",
        tryOnSilhouetteUrl:
          "/api/media-assets/550e8400-e29b-41d4-a716-446655440125/content",
      },
      { sku: "TSHIRT-L-BLUE", tryOnSilhouetteUrl: null },
    ]);
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

  it("keeps one bounded operator diagnostic per media identity despite different pipeline messages", () => {
    const store = useCatalogStore();

    store.recordMediaDiagnostic(
      "/api/media-assets/bad/content",
      "daemon sale view contained an invalid coverImageUrl managed media reference",
    );
    store.recordMediaDiagnostic(
      "/api/media-assets/bad/content",
      "managed media failed to load",
    );
    store.recordMediaDiagnostic(
      "/api/media-assets/another-bad/content",
      "managed media failed to load",
    );
    store.recordMediaDiagnostic(
      "/api/media-assets/bad/content",
      "managed media failed to load",
    );
    store.recordCatalogDiagnostic(
      "category",
      "product:unknown",
      "saleable item used fixed socks fallback because its category was missing or unknown",
    );

    expect(store.operatorDiagnostics).toEqual([
      expect.objectContaining({
        kind: "media",
        reference: "/api/media-assets/bad/content",
        diagnosticKey: "media:/api/media-assets/bad/content",
      }),
      expect.objectContaining({
        kind: "media",
        reference: "/api/media-assets/another-bad/content",
        diagnosticKey: "media:/api/media-assets/another-bad/content",
      }),
      expect.objectContaining({
        kind: "category",
        reference: "product:unknown",
      }),
    ]);
    expect(store.mediaDiagnostics).toHaveLength(2);

    for (let index = 0; index < 25; index += 1) {
      store.recordMediaDiagnostic(
        `/api/media-assets/${index}/content`,
        "managed media failed to load",
      );
    }
    store.recordMediaDiagnostic(
      "/api/media-assets/24/content",
      "managed media failed to load",
    );
    expect(store.operatorDiagnostics).toHaveLength(20);
    expect(store.mediaDiagnostics).toHaveLength(20);
  });

  it("keeps an invalid slot media identity through the placeholder fallback", async () => {
    const locationKey =
      "media:550e8400-e29b-41d4-a716-446655440001:coverImageUrl";
    const invalidReference = "https://forged.example/asset.png";
    const diagnosticKey = `${locationKey}:invalid:${invalidReference}`;
    getSaleViewMock.mockResolvedValue({
      items: [saleViewItem({ coverImageUrl: null })],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
      mediaDiagnostics: [
        {
          reference: invalidReference,
          diagnosticKey,
          message:
            "daemon sale view contained an invalid coverImageUrl managed media reference",
        },
      ],
    });
    const store = useCatalogStore();

    await store.load();
    store.recordMediaDiagnostic(
      null,
      "managed media failed to load",
      locationKey,
    );

    expect(store.operatorDiagnostics).toEqual([
      expect.objectContaining({
        kind: "media",
        diagnosticKey,
        reference: "https://forged.example/asset.png",
      }),
    ]);
    expect(store.mediaDiagnostics).toHaveLength(1);
  });

  it("records a new diagnostic when one slot later receives a different managed image", async () => {
    const locationKey =
      "media:550e8400-e29b-41d4-a716-446655440001:coverImageUrl";
    const invalidReference = "https://forged.example/asset.png";
    const initialDiagnosticKey = `${locationKey}:invalid:${invalidReference}`;
    const replacementReference =
      "/api/media-assets/550e8400-e29b-41d4-a716-446655440124/content";
    getSaleViewMock.mockResolvedValue({
      items: [saleViewItem({ coverImageUrl: null })],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
      mediaDiagnostics: [
        {
          reference: invalidReference,
          diagnosticKey: initialDiagnosticKey,
          message:
            "daemon sale view contained an invalid coverImageUrl managed media reference",
        },
      ],
    });
    const store = useCatalogStore();

    await store.load();
    store.applySnapshot({
      items: [saleViewItem({ coverImageUrl: replacementReference })],
      source: "local_stock",
      planogramVersion: "PLAN-2",
      lastUpdatedAt: "2026-06-04T00:00:05Z",
    });
    store.recordMediaDiagnostic(
      replacementReference,
      "managed media failed to load",
      locationKey,
    );

    expect(store.mediaDiagnostics).toEqual([
      expect.objectContaining({ diagnosticKey: initialDiagnosticKey }),
      expect.objectContaining({
        reference: replacementReference,
        diagnosticKey: `${locationKey}:managed:${replacementReference}`,
      }),
    ]);
    expect(store.operatorDiagnostics).toHaveLength(2);
  });

  it("keys try-on media diagnostics by slot and managed image identity within the bounded history", () => {
    const store = useCatalogStore();
    const sharedReference =
      "/api/media-assets/550e8400-e29b-41d4-a716-446655440124/content";
    const replacementReference =
      "/api/media-assets/550e8400-e29b-41d4-a716-446655440125/content";
    const firstLocation =
      "media:550e8400-e29b-41d4-a716-446655440001:tryOnSilhouetteUrl";
    const secondLocation =
      "media:550e8400-e29b-41d4-a716-446655440011:tryOnSilhouetteUrl";

    store.recordMediaDiagnostic(
      sharedReference,
      "managed try-on silhouette failed to load",
      `${firstLocation}:managed:${sharedReference}`,
    );
    store.recordMediaDiagnostic(
      sharedReference,
      "managed try-on silhouette failed to load again",
      `${firstLocation}:managed:${sharedReference}`,
    );
    expect(store.mediaDiagnostics).toHaveLength(1);

    store.recordMediaDiagnostic(
      sharedReference,
      "the same managed silhouette failed in another slot",
      `${secondLocation}:managed:${sharedReference}`,
    );
    store.recordMediaDiagnostic(
      replacementReference,
      "the replacement managed silhouette failed in the first slot",
      `${firstLocation}:managed:${replacementReference}`,
    );
    expect(
      store.mediaDiagnostics.map(({ diagnosticKey }) => diagnosticKey),
    ).toEqual([
      `${firstLocation}:managed:${sharedReference}`,
      `${secondLocation}:managed:${sharedReference}`,
      `${firstLocation}:managed:${replacementReference}`,
    ]);

    for (let index = 0; index < 20; index += 1) {
      const reference = `/api/media-assets/550e8400-e29b-41d4-a716-${String(index).padStart(12, "0")}/content`;
      store.recordMediaDiagnostic(
        reference,
        "managed try-on silhouette failed to load",
        `${firstLocation}:managed:${reference}`,
      );
    }

    expect(store.mediaDiagnostics).toHaveLength(20);
    expect(store.operatorDiagnostics).toHaveLength(20);
    expect(store.mediaDiagnostics[store.mediaDiagnostics.length - 1]).toEqual(
      expect.objectContaining({
        diagnosticKey: `${firstLocation}:managed:/api/media-assets/550e8400-e29b-41d4-a716-000000000019/content`,
      }),
    );
  });
});
