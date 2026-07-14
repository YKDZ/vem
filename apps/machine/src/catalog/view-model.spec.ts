import { describe, expect, it } from "vitest";

import type { MachineCatalogItem } from "@/types/catalog";

import {
  firstItemInGroups,
  groupItemsByTopCategory,
  groupSubcategories,
  topCategoryForItem,
} from "./view-model";

function item(
  productName: string,
  categoryName: string | null,
  productSortOrder: number,
  saleableStock = 1,
): MachineCatalogItem {
  return {
    machineCode: "M001",
    slotId: `slot-${productSortOrder}`,
    slotCode: `A${productSortOrder}`,
    layerNo: 1,
    cellNo: productSortOrder,
    inventoryId: `inventory-${productSortOrder}`,
    variantId: `variant-${productSortOrder}`,
    productId: `product-${productSortOrder}`,
    productName,
    productDescription: null,
    coverImageUrl: null,
    categoryId: categoryName ? `category-${categoryName}` : null,
    categoryName,
    sku: `SKU-${productSortOrder}`,
    size: "M",
    color: "黑色",
    priceCents: 1000,
    productSortOrder,
    targetGender: null,
    capacity: 8,
    parLevel: 4,
    physicalStock: saleableStock,
    saleableStock,
    slotSalesState: "sale_ready",
    catalogKey: `product:product-${productSortOrder}`,
    aggregatedSlotCount: 1,
    slotCandidates: [],
    variantCandidates: [],
  };
}

describe("machine catalog view model", () => {
  it("maps sale view items into the three kiosk top categories", () => {
    expect(topCategoryForItem(item("商务中筒袜三双装", "袜子", 1))?.key).toBe(
      "socks",
    );
    expect(
      topCategoryForItem(item("莫代尔男士平角裤三条装", "内衣", 2))?.key,
    ).toBe("underwear");
    expect(topCategoryForItem(item("轻氧圆领短袖 T 恤", "上装", 3))?.key).toBe(
      "tshirts",
    );
  });

  it("preserves fixed top category order and stock totals", () => {
    const groups = groupItemsByTopCategory([
      item("轻氧圆领短袖 T 恤", "上装", 3, 2),
      item("商务中筒袜三双装", "袜子", 1, 5),
      item("莫代尔男士平角裤三条装", "内衣", 2, 3),
    ]);

    expect(groups.map((group) => group.key)).toEqual([
      "socks",
      "underwear",
      "tshirts",
    ]);
    expect(groups.map((group) => group.saleableStock)).toEqual([5, 3, 2]);
  });

  it("keeps an available product with a missing or unknown category in a stable fixed-card fallback", () => {
    const groups = groupItemsByTopCategory([
      item("未知品类的可售商品", null, 1, 2),
      item("另一未知商品", "季节限定", 2, 1),
    ]);

    expect(groups).toHaveLength(3);
    expect(groups[0]).toMatchObject({
      key: "socks",
      saleableStock: 3,
    });
    expect(
      groups[0].items.map((catalogItem) => catalogItem.productName),
    ).toEqual(["未知品类的可售商品", "另一未知商品"]);
  });

  it("groups second-level product types by current category snapshot", () => {
    const groups = groupSubcategories([
      item("运动船袜五双装", "袜子", 2),
      item("商务中筒袜三双装", "袜子", 1),
      item("未知商品", null, 3),
    ]);

    expect(groups.map((group) => group.label)).toEqual(["袜子", "其他商品"]);
    expect(groups[0].items.map((groupItem) => groupItem.productName)).toEqual([
      "商务中筒袜三双装",
      "运动船袜五双装",
    ]);
    expect(firstItemInGroups(groups)?.productName).toBe("商务中筒袜三双装");
  });
});
