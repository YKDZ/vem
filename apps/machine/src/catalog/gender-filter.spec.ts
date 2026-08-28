import { describe, expect, it } from "vitest";

import type { MachineCatalogItem } from "@/types/catalog";

import {
  genderForItem,
  genderLabelForFilter,
  type ProductGenderFilter,
} from "./gender-filter";

function item(overrides: Partial<MachineCatalogItem>): MachineCatalogItem {
  return {
    slotId: "slot-1",
    rowNo: 1,
    cellNo: 1,
    slotDisplayLabel: "R1C1",
    inventoryId: "inv-1",
    variantId: "variant-1",
    productId: "product-1",
    productName: "测试商品",
    productDescription: null,
    coverImageUrl: null,
    categoryId: null,
    categoryName: null,
    sku: "TSC-TEST-001",
    size: null,
    color: null,
    priceCents: 1000,
    availableQty: 1,
    productSortOrder: 0,
    targetGender: null,
    ...overrides,
  } as MachineCatalogItem;
}

describe("genderForItem", () => {
  it("classifies children products as kids even when targetGender is set", () => {
    expect(
      genderForItem(
        item({
          productName: "会呼吸的汉麻T·短袖·男童",
          targetGender: "male",
        }),
      ),
    ).toBe("kids");
    expect(
      genderForItem(
        item({
          productName: "会呼吸的汉麻T·短袖·女童",
          targetGender: "female",
        }),
      ),
    ).toBe("kids");
  });

  it("classifies elder products as elder even when targetGender is set", () => {
    expect(
      genderForItem(
        item({
          productName: "会呼吸的汉麻T·短袖·中老年男士",
          targetGender: "male",
        }),
      ),
    ).toBe("elder");
    expect(
      genderForItem(
        item({
          productName: "会呼吸的汉麻T·长袖·中老年女士",
          targetGender: "female",
        }),
      ),
    ).toBe("elder");
  });

  it("falls back to targetGender for adult products", () => {
    expect(
      genderForItem(
        item({
          productName: "汉麻透气消臭四季袜·商务·男士",
          targetGender: "male",
        }),
      ),
    ).toBe("male");
    expect(
      genderForItem(
        item({
          productName: "汉麻抗菌舒适内裤·时尚·女士",
          targetGender: "female",
        }),
      ),
    ).toBe("female");
  });

  it("returns all when neither age nor gender is known", () => {
    expect(genderForItem(item({ productName: "通用商品" }))).toBe("all");
  });
});

describe("genderLabelForFilter", () => {
  it.each([
    ["male", "男款"],
    ["female", "女款"],
    ["kids", "儿童"],
    ["elder", "老人"],
    ["all", "通用"],
  ] as Array<[ProductGenderFilter, string]>)(
    "maps %s to %s",
    (filter, label) => {
      expect(genderLabelForFilter(filter)).toBe(label);
    },
  );
});
