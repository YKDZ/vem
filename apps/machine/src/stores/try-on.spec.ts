import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getSaleViewMock, refreshCatalogMock, openFastMock } = vi.hoisted(
  () => ({
    getSaleViewMock: vi.fn(),
    refreshCatalogMock: vi.fn(),
    openFastMock: vi.fn(),
  }),
);

vi.mock("@/daemon/client", () => ({
  daemonClient: {
    getSaleView: getSaleViewMock,
    refreshCatalog: refreshCatalogMock,
  },
}));

vi.mock("@/native/vision", () => ({
  openVisionFastAttempt: openFastMock,
}));

import { useCatalogStore } from "./catalog";
import { useTryOnStore } from "./try-on";
import { useVisionStore } from "./vision";

const productId = "550e8400-e29b-41d4-a716-446655440128";
const variantId = "550e8400-e29b-41d4-a716-446655440125";

function saleView(template: string | null) {
  return {
    items: [
      {
        machineCode: "M001",
        slotId: "550e8400-e29b-41d4-a716-446655440124",
        slotDisplayLabel: "R1C1",
        rowNo: 1,
        cellNo: 1,
        inventoryId: "550e8400-e29b-41d4-a716-446655440127",
        variantId,
        productId,
        productName: "定制上衣",
        productDescription: null,
        coverImageUrl: null,
        tryOnGarmentMedia: template
          ? {
              id: "550e8400-e29b-41d4-a716-446655440126",
              reference:
                "/api/media-assets/550e8400-e29b-41d4-a716-446655440126/content",
              digest: `sha256:${"a".repeat(64)}`,
              contentType: "image/png",
              byteSize: 2048,
              purpose: "try_on_garment",
              revision: {
                catalogRevision: "catalog-2",
                assetRevision: "asset-2",
              },
            }
          : null,
        tryOnGarmentReadyUrl: template
          ? `http://127.0.0.1:65000/media/sha256:${"a".repeat(64)}?grant=abcdefghijklmnop`
          : null,
        tryOnGarmentTemplate: template,
        categoryId: null,
        categoryName: "自定义分类",
        sku: "CUSTOM-1",
        size: "M",
        color: "蓝色",
        priceCents: 1000,
        productSortOrder: 1,
        targetGender: null,
        capacity: 1,
        parLevel: 1,
        physicalStock: 1,
        saleableStock: 1,
        slotSalesState: "sale_ready",
      },
    ],
    source: "backend",
    planogramVersion: "PLAN-1",
    lastUpdatedAt: "2026-08-10T00:00:00.000Z",
  };
}

describe("try-on store current catalog boundary", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    refreshCatalogMock.mockResolvedValue(undefined);
    openFastMock.mockResolvedValue({ close: vi.fn() });
    useVisionStore().applyVisionReady({
      serverName: "vision",
      serverVersion: "1",
      schemaVersion: "vem-vision-v2-contract-bundle/v1",
      bundleVersion: "1",
      contractDigest: "a".repeat(64),
      cameraReady: true,
      fastReady: true,
      visionBusinessReady: true,
      businessReadinessDiagnostic: "ready",
      capabilities: ["try_on_fast"],
    });
  });

  it("does not reuse a route snapshot after its active association is withdrawn", async () => {
    getSaleViewMock.mockResolvedValueOnce(saleView("tshirt_short_sleeve"));
    const catalog = useCatalogStore();
    await catalog.refresh();
    const selected = catalog.saleableVariantItemFor(
      `product:${productId}`,
      variantId,
    );
    expect(selected).not.toBeNull();
    useTryOnStore().prepare(selected!);

    getSaleViewMock.mockResolvedValueOnce(saleView(null));
    await expect(useTryOnStore().startFast()).resolves.toBe(false);

    expect(openFastMock).not.toHaveBeenCalled();
    expect(useTryOnStore().phase).toBe("failed");
    expect(useTryOnStore().context).toEqual({
      catalogKey: `product:${productId}`,
      productId,
      variantId,
    });
  });

  it("resolves the current descriptor and template again for retry", async () => {
    getSaleViewMock
      .mockResolvedValueOnce(saleView("tshirt_short_sleeve"))
      .mockResolvedValueOnce(saleView("tshirt_long_sleeve"));
    const catalog = useCatalogStore();
    await catalog.refresh();
    useTryOnStore().prepare(
      catalog.saleableVariantItemFor(`product:${productId}`, variantId)!,
    );

    await expect(useTryOnStore().startFast()).resolves.toBe(true);

    expect(openFastMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        variantId,
        garment: expect.objectContaining({ template: "tshirt_long_sleeve" }),
      }),
      expect.any(Function),
      expect.any(AbortSignal),
    );
  });

  it("clear during a blocked daemon refresh prevents any future Vision start", async () => {
    getSaleViewMock.mockResolvedValueOnce(saleView("tshirt_short_sleeve"));
    const catalog = useCatalogStore();
    await catalog.refresh();
    useTryOnStore().prepare(
      catalog.saleableVariantItemFor(`product:${productId}`, variantId)!,
    );

    const refresh = deferred<ReturnType<typeof saleView>>();
    getSaleViewMock.mockReturnValueOnce(refresh.promise);
    const starting = useTryOnStore().startFast();
    useTryOnStore().clear();
    refresh.resolve(saleView("tshirt_short_sleeve"));

    await expect(starting).resolves.toBe(false);
    expect(openFastMock).not.toHaveBeenCalled();
    expect(useTryOnStore().phase).toBe("idle");
    expect(useTryOnStore().attemptId).toBeNull();
  });

  it("keeps concurrent start and retry single-flight with one current Vision socket", async () => {
    getSaleViewMock.mockResolvedValueOnce(saleView("tshirt_short_sleeve"));
    const catalog = useCatalogStore();
    await catalog.refresh();
    useTryOnStore().prepare(
      catalog.saleableVariantItemFor(`product:${productId}`, variantId)!,
    );

    const refresh = deferred<ReturnType<typeof saleView>>();
    const close = vi.fn();
    getSaleViewMock.mockReturnValueOnce(refresh.promise);
    openFastMock.mockResolvedValueOnce({ close });

    const first = useTryOnStore().startFast();
    const second = useTryOnStore().retry();
    refresh.resolve(saleView("tshirt_short_sleeve"));
    await expect(second).resolves.toBe(true);

    await expect(first).resolves.toBe(false);
    expect(openFastMock).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
    expect(useTryOnStore().phase).toBe("starting");
  });

  it("clear during Vision handshake aborts the pending operation and closes a late socket", async () => {
    getSaleViewMock.mockResolvedValueOnce(saleView("tshirt_short_sleeve"));
    const catalog = useCatalogStore();
    await catalog.refresh();
    useTryOnStore().prepare(
      catalog.saleableVariantItemFor(`product:${productId}`, variantId)!,
    );

    const opening = deferred<{ close: ReturnType<typeof vi.fn> }>();
    const signals: AbortSignal[] = [];
    openFastMock.mockImplementationOnce((_connection, _input, _onEvent, s) => {
      signals.push(s);
      return opening.promise;
    });
    getSaleViewMock.mockResolvedValueOnce(saleView("tshirt_short_sleeve"));

    const starting = useTryOnStore().startFast();
    await vi.waitFor(() => {
      expect(openFastMock).toHaveBeenCalledTimes(1);
    });
    const close = vi.fn();
    useTryOnStore().clear();
    opening.resolve({ close });

    await expect(starting).resolves.toBe(false);
    expect(signals[0]?.aborted).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    expect(useTryOnStore().phase).toBe("idle");
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
