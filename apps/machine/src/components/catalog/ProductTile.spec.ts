import { describe, expect, it } from "vitest";
// @vitest-environment jsdom
import { createApp } from "vue";

import type { MachineCatalogItem } from "@/types/catalog";

import ProductTile from "./ProductTile.vue";

function item(): MachineCatalogItem {
  return {
    machineCode: "M001",
    slotId: "slot-1",
    slotCode: "A1",
    layerNo: 1,
    cellNo: 1,
    inventoryId: "inventory-1",
    variantId: "variant-1",
    productId: "product-1",
    productName: "基础短袖",
    productDescription: null,
    coverImageUrl:
      "/api/media-assets/550e8400-e29b-41d4-a716-446655440124/content",
    categoryId: null,
    categoryName: null,
    sku: "TEE-001",
    size: "M",
    color: "白色",
    priceCents: 3900,
    productSortOrder: 1,
    capacity: 8,
    parLevel: 6,
    physicalStock: 3,
    saleableStock: 3,
    slotSalesState: "sale_ready",
    catalogKey: "product:product-1",
    aggregatedSlotCount: 1,
    slotCandidates: [],
    variantCandidates: [
      {
        variantId: "variant-1",
        sku: "TEE-001",
        size: "M",
        color: "白色",
        priceCents: 3900,
        capacity: 8,
        parLevel: 6,
        physicalStock: 3,
        saleableStock: 3,
        slotSalesState: "sale_ready",
        slotCandidates: [],
      },
    ],
  };
}

describe("ProductTile", () => {
  it("renders the managed product display image in the catalog", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);

    const app = createApp(ProductTile, { item: item() });
    app.mount(host);

    const image = host.querySelector("img");
    expect(image?.getAttribute("src")).toBe(
      "/api/media-assets/550e8400-e29b-41d4-a716-446655440124/content",
    );
    expect(image?.getAttribute("alt")).toBe("基础短袖");

    app.unmount();
    host.remove();
  });
});
