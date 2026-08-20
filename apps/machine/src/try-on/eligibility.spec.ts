import { describe, expect, it } from "vitest";

import type { MachineCatalogItem } from "@/types/catalog";

import {
  canStartTryOn,
  validateTryOnCapturedFrame,
  validateTryOnPreviewReference,
  validateTryOnResultReference,
  visionGarmentSourceFor,
} from "./eligibility";

const item = (
  overrides: Partial<MachineCatalogItem> = {},
): MachineCatalogItem =>
  ({
    catalogKey: "product:550e8400-e29b-41d4-a716-446655440128",
    productId: "550e8400-e29b-41d4-a716-446655440128",
    variantId: "550e8400-e29b-41d4-a716-446655440125",
    slotId: "550e8400-e29b-41d4-a716-446655440124",
    slotDisplayLabel: "R1C1",
    rowNo: 1,
    cellNo: 1,
    inventoryId: "550e8400-e29b-41d4-a716-446655440127",
    machineCode: "M001",
    productName: "蓝色 T 恤",
    productDescription: null,
    coverImageUrl: null,
    tryOnGarmentMedia: {
      id: "550e8400-e29b-41d4-a716-446655440126",
      reference: "/api/media-assets/garment/content",
      digest: `sha256:${"a".repeat(64)}`,
      contentType: "image/png",
      byteSize: 2048,
      purpose: "try_on_garment",
      revision: { catalogRevision: "catalog-2", assetRevision: "asset-2" },
    },
    tryOnGarmentReadyUrl: `http://127.0.0.1:65000/media/sha256:${"a".repeat(64)}?grant=abcdefghijklmnop`,
    tryOnGarmentTemplate: "tshirt_short_sleeve",
    categoryId: null,
    categoryName: "T恤",
    sku: "TEE-1",
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
    ...overrides,
  }) as MachineCatalogItem;

const readiness = { tryOnReady: true, visionBusinessReady: true };
const context = {
  attemptId: "550e8400-e29b-41d4-a716-446655440124",
  visionSocketUrl: "ws://127.0.0.1:7892/ws",
};

describe("single-path try-on eligibility", () => {
  it("requires one ready Vision capability and a current eligible garment", () => {
    expect(canStartTryOn(item(), readiness)).toBe(true);
    expect(canStartTryOn(item(), { ...readiness, tryOnReady: false })).toBe(
      false,
    );
    expect(canStartTryOn(item({ slotSalesState: "sold_out" }), readiness)).toBe(
      false,
    );
    expect(canStartTryOn(item({ tryOnGarmentMedia: null }), readiness)).toBe(
      false,
    );
    expect(
      canStartTryOn(
        item({ tryOnGarmentReadyUrl: "https://example.invalid/a" }),
        readiness,
      ),
    ).toBe(false);
  });

  it("maps the daemon grant into a start-only V2 tokenized garment source", () => {
    const source = visionGarmentSourceFor(item());
    expect(source).toMatchObject({
      assetId: "550e8400-e29b-41d4-a716-446655440126",
      template: "tshirt_short_sleeve",
      contentType: "image/png",
    });
    expect(source.reference).toContain("?token=abcdefghijklmnop");
    expect(source.reference).not.toContain("grant=");
  });
});

describe("single-path controlled Vision resources", () => {
  it("accepts only the exact socket-origin preview, captured frame and result routes", () => {
    expect(
      validateTryOnPreviewReference(
        {
          reference:
            "http://127.0.0.1:7892/v2/try-on/acquisition/preview.mjpeg?token=preview-token",
          streamType: "mjpeg",
        },
        context,
      ).reference,
    ).toContain("preview.mjpeg");
    expect(
      validateTryOnCapturedFrame(
        {
          reference:
            "http://127.0.0.1:7892/v2/try-on/captured/frame.png?token=captured-token",
          digest: `sha256:${"b".repeat(64)}`,
          contentType: "image/png",
          byteSize: 2048,
          width: 512,
          height: 768,
          frameId: "front-42",
        },
        context,
      ).frameId,
    ).toBe("front-42");
    expect(
      validateTryOnResultReference(
        {
          reference: `http://127.0.0.1:7892/v2/try-on/results/${context.attemptId}?token=result-token`,
          digest: `sha256:${"c".repeat(64)}`,
          contentType: "image/png",
          byteSize: 2048,
          width: 512,
          height: 768,
        },
        context,
      ).width,
    ).toBe(512);
  });

  it("rejects a captured reference from another listener even when it is loopback", () => {
    expect(() =>
      validateTryOnCapturedFrame(
        {
          reference:
            "http://127.0.0.1:7893/v2/try-on/captured/frame.png?token=captured-token",
          digest: `sha256:${"b".repeat(64)}`,
          contentType: "image/png",
          byteSize: 2048,
          width: 512,
          height: 768,
          frameId: "front-42",
        },
        context,
      ),
    ).toThrow(/unsafe captured/);
  });
});
