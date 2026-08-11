import { describe, expect, it } from "vitest";

import type { MachineCatalogItem } from "@/types/catalog";

import {
  canStartFastTryOn,
  validateTryOnPreviewReference,
  validateTryOnResultReference,
} from "./eligibility";

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
  it("uses the explicit active association rather than a category label", () => {
    expect(
      canStartFastTryOn(item({ categoryName: "定制上衣" }), {
        fastReady: true,
        visionBusinessReady: true,
      }),
    ).toBe(true);
    expect(
      canStartFastTryOn(
        item({ categoryName: "袜子", tryOnGarmentMedia: null }),
        {
          fastReady: true,
          visionBusinessReady: true,
        },
      ),
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
      canStartFastTryOn(item({ tryOnGarmentTemplate: null }), {
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

  it("accepts only the current attempt result on the connected Vision origin", () => {
    const valid = {
      reference: `http://127.0.0.1:65499/v2/try-on/results/${id}?token=result-token`,
      digest: `sha256:${"a".repeat(64)}`,
      contentType: "image/png" as const,
      byteSize: 4096,
      width: 512,
      height: 768,
    };
    const expected = {
      attemptId: id,
      visionSocketUrl: "ws://127.0.0.1:65499/v2/machine",
    };
    expect(validateTryOnResultReference(valid, expected)).toEqual(valid);
    expect(() =>
      validateTryOnResultReference(
        {
          ...valid,
          reference: `https://127.0.0.1:65499/v2/try-on/results/${id}?token=result-token`,
        },
        { ...expected, visionSocketUrl: "wss://127.0.0.1:65499/v2/machine" },
      ),
    ).toThrow();
    expect(() =>
      validateTryOnResultReference(
        {
          ...valid,
          reference: `http://127.0.0.1:65500/v2/try-on/results/${id}?token=x`,
        },
        expected,
      ),
    ).toThrow();
    expect(() =>
      validateTryOnResultReference(
        {
          ...valid,
          reference: `http://127.0.0.1:65499/v2/try-on/results/${variantId}?token=x`,
        },
        expected,
      ),
    ).toThrow();
    expect(() =>
      validateTryOnResultReference(
        {
          ...valid,
          reference: `http://127.0.0.1:65499/v2/try-on/results/${id}?token=x%32`,
        },
        expected,
      ),
    ).toThrow();
    expect(() =>
      validateTryOnResultReference(
        {
          ...valid,
          reference: `http://vision@127.0.0.1:65499/v2/try-on/results/${id}?token=x`,
        },
        expected,
      ),
    ).toThrow();
  });

  it("accepts an acquisition preview only from the exact current Vision socket origin", () => {
    const expected = {
      attemptId: id,
      visionSocketUrl: "ws://127.0.0.1:7892/ws",
    };
    const valid = {
      reference:
        "http://127.0.0.1:7892/v2/try-on/acquisition/preview.mjpeg?token=preview-token",
      streamType: "mjpeg" as const,
    };
    expect(validateTryOnPreviewReference(valid, expected)).toEqual(valid);
    for (const reference of [
      "http://127.0.0.1:65000/v2/try-on/acquisition/preview.mjpeg?token=preview-token",
      "http://localhost:7892/v2/try-on/acquisition/preview.mjpeg?token=preview-token",
      "http://vision@127.0.0.1:7892/v2/try-on/acquisition/preview.mjpeg?token=preview-token",
    ]) {
      expect(() =>
        validateTryOnPreviewReference({ ...valid, reference }, expected),
      ).toThrow();
    }
  });
});
