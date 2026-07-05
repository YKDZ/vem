import { describe, expect, it } from "vitest";

import {
  mapCreateProductDtoToInsert,
  mapCreateVariantDtoToInsert,
  mapUpdateVariantDtoToPatch,
  toAdminProductResponse,
} from "./products.contract-mappers";

describe("Product Variant Catalog admin contract mappers", () => {
  it("maps parsed admin product DTOs into explicit product insert values", () => {
    const insert = mapCreateProductDtoToInsert({
      name: "Tea",
      description: undefined,
      displayImageMediaAssetId: "550e8400-e29b-41d4-a716-446655440124",
      status: "draft",
      sortOrder: 0,
    });

    expect(insert).toEqual({
      name: "Tea",
      categoryId: null,
      description: null,
      displayImageMediaAssetId: "550e8400-e29b-41d4-a716-446655440124",
      coverImageUrl: null,
      status: "draft",
      sortOrder: 0,
    });
    expect(insert).not.toHaveProperty("displayImageMediaAsset");
  });

  it("maps parsed admin variant DTOs into explicit variant insert values", () => {
    const insert = mapCreateVariantDtoToInsert({
      productId: "550e8400-e29b-41d4-a716-446655440224",
      sku: "TEA-001",
      priceCents: 300,
      costCents: null,
      status: "active",
      tryOnSilhouetteMediaAssetId: null,
    });

    expect(insert).toEqual({
      productId: "550e8400-e29b-41d4-a716-446655440224",
      sku: "TEA-001",
      size: null,
      color: null,
      barcode: null,
      priceCents: 300,
      costCents: null,
      tryOnSilhouetteMediaAssetId: null,
      status: "active",
      targetGender: null,
    });
    expect(insert).not.toHaveProperty("tryOnSilhouetteMediaAsset");
  });

  it("keeps omitted and nullable variant cost distinct for update patches", () => {
    expect(mapUpdateVariantDtoToPatch({ sku: "TEA-001" })).toMatchObject({
      sku: "TEA-001",
      costCents: undefined,
    });
    expect(mapUpdateVariantDtoToPatch({ costCents: null })).toMatchObject({
      costCents: null,
    });
  });

  it("assembles a strict admin product response DTO", () => {
    expect(
      toAdminProductResponse(
        {
          id: "550e8400-e29b-41d4-a716-446655440224",
          name: "Tea",
          categoryId: null,
          description: null,
          displayImageMediaAssetId: null,
          status: "draft",
          sortOrder: 0,
          createdAt: new Date("2026-07-01T00:00:00.000Z"),
          updatedAt: new Date("2026-07-01T00:00:00.000Z"),
        },
        null,
      ),
    ).toEqual({
      id: "550e8400-e29b-41d4-a716-446655440224",
      name: "Tea",
      categoryId: null,
      description: null,
      displayImageMediaAssetId: null,
      displayImageMediaAsset: null,
      status: "draft",
      sortOrder: 0,
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
  });
});
