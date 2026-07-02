import type { VisionProfile } from "@vem/shared";

import { describe, it, expect } from "vitest";

import type {
  MachineCatalogItem,
  MachineCatalogSlotCandidate,
} from "@/types/catalog";

import { choosePreferredVariant, inferSize } from "./engine";

/** Create a minimal MachineCatalogItem for testing */
function makeCatalogItem(
  override?: Partial<MachineCatalogItem>,
): MachineCatalogItem {
  const item = {
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
  } as Omit<
    MachineCatalogItem,
    | "catalogKey"
    | "aggregatedSlotCount"
    | "slotCandidates"
    | "variantCandidates"
  >;
  const slotCandidates: readonly MachineCatalogSlotCandidate[] =
    override?.slotCandidates ?? [
      {
        slotId: item.slotId,
        slotCode: item.slotCode,
        layerNo: item.layerNo,
        cellNo: item.cellNo,
        inventoryId: item.inventoryId,
        variantId: item.variantId,
        sku: item.sku,
        size: item.size,
        color: item.color,
        priceCents: item.priceCents,
        capacity: item.capacity,
        parLevel: item.parLevel,
        physicalStock: item.physicalStock,
        saleableStock: item.saleableStock,
        slotSalesState: item.slotSalesState,
      },
    ];
  return {
    ...item,
    catalogKey: override?.catalogKey ?? `product:${item.productId}`,
    aggregatedSlotCount: override?.aggregatedSlotCount ?? 1,
    slotCandidates,
    variantCandidates: override?.variantCandidates ?? [
      {
        variantId: item.variantId,
        sku: item.sku,
        size: item.size,
        color: item.color,
        priceCents: item.priceCents,
        capacity: item.capacity,
        parLevel: item.parLevel,
        physicalStock: item.physicalStock,
        saleableStock: item.saleableStock,
        slotSalesState: item.slotSalesState,
        slotCandidates,
      },
    ],
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

describe("choosePreferredVariant", () => {
  const variants = makeCatalogItem({
    variantCandidates: [
      {
        variantId: "m-white",
        sku: "M-WHITE",
        size: "M",
        color: "白色",
        priceCents: 1000,
        capacity: 10,
        parLevel: 8,
        physicalStock: 3,
        saleableStock: 3,
        slotSalesState: "sale_ready",
        slotCandidates: [],
      },
      {
        variantId: "m-black",
        sku: "M-BLACK",
        size: "M",
        color: "黑色",
        priceCents: 1000,
        capacity: 10,
        parLevel: 8,
        physicalStock: 3,
        saleableStock: 3,
        slotSalesState: "sale_ready",
        slotCandidates: [],
      },
      {
        variantId: "l-blue",
        sku: "L-BLUE",
        size: "L",
        color: "深蓝色",
        priceCents: 1000,
        capacity: 10,
        parLevel: 8,
        physicalStock: 3,
        saleableStock: 3,
        slotSalesState: "sale_ready",
        slotCandidates: [],
      },
    ],
  }).variantCandidates;

  it("uses inferred size and recognized color when both match", () => {
    const profile: VisionProfile = {
      personPresent: true,
      heightCm: 178,
      bodyType: "regular",
      upperColor: "蓝",
    };
    expect(choosePreferredVariant(variants, profile)?.variantId).toBe("l-blue");
  });

  it("falls back to default color inside the inferred size when color is missing", () => {
    const profile: VisionProfile = {
      personPresent: true,
      heightCm: 178,
      bodyType: "regular",
    };
    expect(choosePreferredVariant(variants, profile)?.variantId).toBe("l-blue");
  });

  it("falls back to default size but still applies recognized color within that size", () => {
    const profile: VisionProfile = {
      personPresent: true,
      upperColor: "黑",
    };
    expect(choosePreferredVariant(variants, profile)?.variantId).toBe(
      "m-black",
    );
  });

  it("falls back to the first saleable variant when recognized signals do not match", () => {
    const profile: VisionProfile = {
      personPresent: true,
      heightCm: 190,
      bodyType: "regular",
      upperColor: "红",
    };
    expect(choosePreferredVariant(variants, profile)?.variantId).toBe(
      "m-white",
    );
  });

  it("uses the first variant when no variant is saleable", () => {
    const soldOutVariants = variants.map((variant) => ({
      ...variant,
      saleableStock: 0,
      slotSalesState: "sold_out" as const,
    }));
    expect(choosePreferredVariant(soldOutVariants, null)?.variantId).toBe(
      "m-white",
    );
  });

  it("returns null for an empty variant list", () => {
    expect(choosePreferredVariant([], { personPresent: true })).toBeNull();
  });
});
