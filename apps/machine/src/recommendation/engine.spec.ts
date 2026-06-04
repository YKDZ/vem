import type { VisionProfile } from "@vem/shared";

import { describe, it, expect } from "vitest";

import type { MachineCatalogItem } from "@/types/catalog";

import { inferSize, scoreItem, computeRecommendations } from "./engine";

/** Create a minimal MachineCatalogItem for testing */
function makeCatalogItem(
  override?: Partial<MachineCatalogItem>,
): MachineCatalogItem {
  return {
    machineCode: "test",
    slotId: "slot-1",
    slotCode: "A1",
    layerNo: 1,
    cellNo: 1,
    inventoryId: "inv-1",
    variantId: "var-1",
    productId: "prod-1",
    productName: "Test Product",
    productDescription: null,
    coverImageUrl: null,
    categoryId: null,
    categoryName: null,
    sku: "SKU-001",
    size: "M",
    color: null,
    priceCents: 1000,
    capacity: 10,
    parLevel: 8,
    physicalStock: 0,
    saleableStock: 0,
    slotSalesState: "sold_out",
    productSortOrder: 10,
    targetGender: null,
    ...override,
  };
}

describe("inferSize", () => {
  it("heightCm=undefined → null", () => {
    expect(inferSize(undefined, "regular")).toBeNull();
  });

  it("heightCm=160, bodyType=slim → S", () => {
    expect(inferSize(160, "slim")).toBe("S");
  });

  it("heightCm=160, bodyType=strong → M", () => {
    expect(inferSize(160, "strong")).toBe("M");
  });

  it("heightCm=170, bodyType=regular → M", () => {
    expect(inferSize(170, "regular")).toBe("M");
  });

  it("heightCm=170, bodyType=strong → L", () => {
    expect(inferSize(170, "strong")).toBe("L");
  });

  it("heightCm=180, bodyType=slim → L", () => {
    expect(inferSize(180, "slim")).toBe("L");
  });

  it("heightCm=180, bodyType=strong → XL", () => {
    expect(inferSize(180, "strong")).toBe("XL");
  });

  it("heightCm=190, bodyType=any → XL", () => {
    expect(inferSize(190, "slim")).toBe("XL");
    expect(inferSize(190, "regular")).toBe("XL");
    expect(inferSize(190, "strong")).toBe("XL");
  });
});

describe("scoreItem — size matching", () => {
  // 175cm regular → size "L"
  const baseProfile: VisionProfile = {
    personPresent: true,
    heightCm: 175,
    bodyType: "regular",
    gender: "male",
  };

  it("exact match, score includes 50 points", () => {
    const item = makeCatalogItem({
      size: "L",
      capacity: 10,
      parLevel: 8,
      physicalStock: 0,
      saleableStock: 0,
      slotSalesState: "sold_out",
      productSortOrder: 10,
    });
    const result = scoreItem(baseProfile, item);
    expect(result).not.toBeNull();
    expect(result!.score).toBeGreaterThanOrEqual(50);
  });

  it("adjacent size (M vs L), score includes 25 points", () => {
    const item = makeCatalogItem({
      size: "M",
      capacity: 10,
      parLevel: 8,
      physicalStock: 0,
      saleableStock: 0,
      slotSalesState: "sold_out",
      productSortOrder: 10,
    });
    const result = scoreItem(baseProfile, item);
    expect(result).not.toBeNull();
    expect(result!.score).toBeGreaterThanOrEqual(25);
    expect(result!.score).toBeLessThan(50);
  });

  it("non-matching size, score is only stockScore + sortScore", () => {
    const item = makeCatalogItem({
      size: "XS",
      capacity: 10,
      parLevel: 8,
      physicalStock: 0,
      saleableStock: 0,
      slotSalesState: "sold_out",
      productSortOrder: 10,
    });
    const result = scoreItem(baseProfile, item);
    expect(result).not.toBeNull();
    expect(result!.score).toBeLessThan(25);
  });

  it("item.size=null, size dimension is 0", () => {
    const item = makeCatalogItem({
      size: null,
      capacity: 10,
      parLevel: 8,
      physicalStock: 0,
      saleableStock: 0,
      slotSalesState: "sold_out",
      productSortOrder: 10,
    });
    const result = scoreItem(baseProfile, item);
    expect(result).not.toBeNull();
    expect(result!.score).toBeLessThan(25);
  });
});

describe("scoreItem — gender filtering", () => {
  it("targetGender=male, profile.gender=female → returns null (excluded)", () => {
    const profile: VisionProfile = {
      personPresent: true,
      gender: "female",
    };
    const item = makeCatalogItem({ targetGender: "male" });
    expect(scoreItem(profile, item)).toBeNull();
  });

  it("targetGender=female, profile.gender=male → returns null (excluded)", () => {
    const profile: VisionProfile = {
      personPresent: true,
      gender: "male",
    };
    const item = makeCatalogItem({ targetGender: "female" });
    expect(scoreItem(profile, item)).toBeNull();
  });

  it("targetGender=null → not excluded", () => {
    const profile: VisionProfile = {
      personPresent: true,
      gender: "male",
    };
    const item = makeCatalogItem({ targetGender: null });
    expect(scoreItem(profile, item)).not.toBeNull();
  });

  it("profile.gender=unknown → doesn't filter any targetGender", () => {
    const profile: VisionProfile = {
      personPresent: true,
      gender: "unknown",
    };
    const itemMale = makeCatalogItem({ targetGender: "male" });
    const itemFemale = makeCatalogItem({ targetGender: "female" });
    const itemNull = makeCatalogItem({ targetGender: null });
    expect(scoreItem(profile, itemMale)).not.toBeNull();
    expect(scoreItem(profile, itemFemale)).not.toBeNull();
    expect(scoreItem(profile, itemNull)).not.toBeNull();
  });
});

describe("scoreItem — stock and sort weight", () => {
  it("saleableStock=5 → stockScore=5", () => {
    const profile: VisionProfile = { personPresent: true };
    const item = makeCatalogItem({
      saleableStock: 5,
      productSortOrder: 10,
      size: null,
    });
    const result = scoreItem(profile, item);
    expect(result).not.toBeNull();
    expect(result!.score).toBe(5);
  });

  it("saleableStock=15 → stockScore=10 (capped)", () => {
    const profile: VisionProfile = {
      personPresent: true,
      heightCm: null,
      bodyType: undefined,
    };
    const item = makeCatalogItem({
      saleableStock: 15,
      productSortOrder: 10,
      size: null,
    });
    const result = scoreItem(profile, item);
    expect(result).not.toBeNull();
    expect(result!.score).toBe(10);
  });

  it("productSortOrder=3 → sortScore=7", () => {
    const profile: VisionProfile = {
      personPresent: true,
      heightCm: null,
      bodyType: undefined,
    };
    const item = makeCatalogItem({
      capacity: 10,
      parLevel: 8,
      physicalStock: 0,
      saleableStock: 0,
      slotSalesState: "sold_out",
      productSortOrder: 3,
      size: null,
    });
    const result = scoreItem(profile, item);
    expect(result).not.toBeNull();
    expect(result!.score).toBe(7);
  });

  it("productSortOrder=12 → sortScore=0 (floor)", () => {
    const profile: VisionProfile = {
      personPresent: true,
      heightCm: null,
      bodyType: undefined,
    };
    const item = makeCatalogItem({
      capacity: 10,
      parLevel: 8,
      physicalStock: 0,
      saleableStock: 0,
      slotSalesState: "sold_out",
      productSortOrder: 12,
      size: null,
    });
    const result = scoreItem(profile, item);
    expect(result).not.toBeNull();
    expect(result!.score).toBe(0);
  });
});

describe("computeRecommendations", () => {
  it("returns results sorted by score descending", () => {
    const profile: VisionProfile = {
      personPresent: true,
      heightCm: 175,
      bodyType: "regular",
      gender: "unknown",
    };
    const items = [
      makeCatalogItem({ sku: "low", saleableStock: 1, productSortOrder: 10 }),
      makeCatalogItem({
        sku: "high",
        saleableStock: 10,
        productSortOrder: 0,
        size: "M",
      }),
    ];
    const result = computeRecommendations(profile, items);
    expect(result.length).toBe(2);
    expect(result[0].sku).toBe("high");
    expect(result[1].sku).toBe("low");
  });

  it("returns at most 6 items", () => {
    const profile: VisionProfile = { personPresent: true };
    const items = Array.from({ length: 10 }, (_, i) =>
      makeCatalogItem({ sku: `item-${i}`, saleableStock: i }),
    );
    const result = computeRecommendations(profile, items);
    expect(result.length).toBe(6);
  });

  it("returns fewer than 6 when not enough items pass filter", () => {
    const profile: VisionProfile = { personPresent: true, gender: "male" };
    const items = [
      makeCatalogItem({ sku: "m1", targetGender: "male" }),
      makeCatalogItem({ sku: "f1", targetGender: "female" }),
      makeCatalogItem({ sku: "f2", targetGender: "female" }),
    ];
    const result = computeRecommendations(profile, items);
    expect(result.length).toBe(1);
    expect(result[0].sku).toBe("m1");
  });

  it("when catalog is empty, returns empty array", () => {
    const profile: VisionProfile = { personPresent: true };
    const result = computeRecommendations(profile, []);
    expect(result).toEqual([]);
  });

  it("when all items are filtered by gender, returns empty array", () => {
    const profile: VisionProfile = { personPresent: true, gender: "male" };
    const items = [
      makeCatalogItem({ sku: "f1", targetGender: "female" }),
      makeCatalogItem({ sku: "f2", targetGender: "female" }),
    ];
    const result = computeRecommendations(profile, items);
    expect(result).toEqual([]);
  });
});
