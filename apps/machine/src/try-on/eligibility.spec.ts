import { describe, expect, it } from "vitest";

import type { MachineCatalogItem } from "@/types/catalog";

import { canStartFastTryOn, validateTryOnResultReference } from "./eligibility";

const id = "550e8400-e29b-41d4-a716-446655440124";
const variantId = "550e8400-e29b-41d4-a716-446655440125";
const garment = {
  id: "550e8400-e29b-41d4-a716-446655440126",
  reference: `/api/media-assets/550e8400-e29b-41d4-a716-446655440126/content`,
  digest: `sha256:${"a".repeat(64)}`,
  contentType: "image/png" as const,
  byteSize: 2048,
  purpose: "try_on_garment" as const,
  revision: { catalogRevision: "catalog-1", assetRevision: "asset-1" },
};

function item(overrides: Partial<MachineCatalogItem> = {}): MachineCatalogItem {
  return {
    machineCode: "M001",
    slotId: id,
    slotDisplayLabel: "R1C1",
    rowNo: 1,
    cellNo: 1,
    inventoryId: "550e8400-e29b-41d4-a716-446655440127",
    variantId,
    productId: "550e8400-e29b-41d4-a716-446655440128",
    productName: "T-shirt",
    productDescription: null,
    coverImageUrl: null,
    tryOnGarmentMedia: garment,
    tryOnGarmentReadyUrl:
      "http://127.0.0.1:65000/media/sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?grant=abcdefghijklmnop",
    tryOnGarmentTemplate: "tshirt_short_sleeve",
    categoryId: null,
    categoryName: "T恤",
    sku: "TS-1",
    size: "M",
    color: "白色",
    priceCents: 1000,
    productSortOrder: 1,
    targetGender: null,
    capacity: 1,
    parLevel: 1,
    physicalStock: 1,
    saleableStock: 1,
    slotSalesState: "sale_ready",
    catalogKey: "product:550e8400-e29b-41d4-a716-446655440128",
    aggregatedSlotCount: 1,
    slotCandidates: [],
    variantCandidates: [],
    ...overrides,
  };
}

describe("Fast try-on eligibility", () => {
  it("requires supported associated garment, ready media, and V2 business readiness", () => {
    expect(
      canStartFastTryOn(item(), { fastReady: true, visionBusinessReady: true }),
    ).toBe(true);
    expect(
      canStartFastTryOn(item({ categoryName: "袜子" }), {
        fastReady: true,
        visionBusinessReady: true,
      }),
    ).toBe(false);
    expect(
      canStartFastTryOn(item({ tryOnGarmentMedia: null }), {
        fastReady: true,
        visionBusinessReady: true,
      }),
    ).toBe(false);
    expect(
      canStartFastTryOn(item({ tryOnGarmentReadyUrl: null }), {
        fastReady: true,
        visionBusinessReady: true,
      }),
    ).toBe(false);
    expect(
      canStartFastTryOn(item(), {
        fastReady: false,
        visionBusinessReady: true,
      }),
    ).toBe(false);
    expect(
      canStartFastTryOn(item(), {
        fastReady: true,
        visionBusinessReady: false,
      }),
    ).toBe(false);
  });

  it("rejects unsafe or malformed generated result references", () => {
    const valid = {
      reference: "http://127.0.0.1:65499/results/output?token=result-token",
      digest: `sha256:${"a".repeat(64)}`,
      contentType: "image/png" as const,
      byteSize: 4096,
      width: 512,
      height: 768,
    };
    expect(validateTryOnResultReference(valid)).toEqual(valid);
    expect(() =>
      validateTryOnResultReference({
        ...valid,
        reference: "https://evil.example/results/output?token=x",
      }),
    ).toThrow();
    expect(() =>
      validateTryOnResultReference({
        ...valid,
        reference: "http://127.0.0.1:65499/wrong/output?token=x",
      }),
    ).toThrow();
    expect(() =>
      validateTryOnResultReference({
        ...valid,
        reference: "http://127.0.0.1:65499/results/%6futput?token=x",
      }),
    ).toThrow();
    expect(() =>
      validateTryOnResultReference({
        ...valid,
        reference: "http://127.0.0.1:65499/results/output?token=x&extra=y",
      }),
    ).toThrow();
  });
});
