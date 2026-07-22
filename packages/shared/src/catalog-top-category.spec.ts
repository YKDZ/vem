import { describe, expect, it } from "vitest";

import { topCategoryKeyForCatalogItem } from "./catalog-top-category";

describe("catalog top category", () => {
  it("classifies category and product keywords with the Machine Catalog semantics", () => {
    expect(
      topCategoryKeyForCatalogItem({
        categoryName: "内衣",
        productName: "基础款",
      }),
    ).toBe("underwear");
    expect(
      topCategoryKeyForCatalogItem({
        categoryName: "上装",
        productName: "轻氧圆领短袖",
      }),
    ).toBe("tshirts");
    expect(
      topCategoryKeyForCatalogItem({
        categoryName: null,
        productName: "男士平角裤",
      }),
    ).toBe("underwear");
    expect(
      topCategoryKeyForCatalogItem({
        categoryName: "",
        productName: "女款短袖上衣",
      }),
    ).toBe("tshirts");
  });
});
