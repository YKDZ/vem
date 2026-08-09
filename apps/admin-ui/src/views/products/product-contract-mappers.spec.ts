import { describe, expect, it } from "vitest";

import {
  mapProductResponseToForm,
  mapVariantResponseToForm,
  mapProductFormToContract,
  mapVariantFormToContract,
  type ProductForm,
  type VariantForm,
} from "./product-contract-mappers";

describe("Product Variant Catalog form contract mappers", () => {
  it("maps product form fields into the shared admin product contract", () => {
    const form: ProductForm = {
      name: "Tea",
      description: "",
      displayImageMediaAssetId: "550e8400-e29b-41d4-a716-446655440124",
      displayImagePublicUrl: "/api/media-assets/image/content",
      status: "draft",
      sortOrder: 0,
    };

    expect(mapProductFormToContract(form)).toEqual({
      name: "Tea",
      description: null,
      displayImageMediaAssetId: "550e8400-e29b-41d4-a716-446655440124",
      status: "draft",
      sortOrder: 0,
    });
  });

  it("maps variant form fields into the shared admin variant contract", () => {
    const form: VariantForm = {
      productId: "550e8400-e29b-41d4-a716-446655440224",
      sku: "TEA-001",
      priceCents: 300,
      costCents: 0,
      status: "active",
      size: "",
      color: "green",
      barcode: "",
      targetGender: null,
    };

    expect(mapVariantFormToContract(form)).toEqual({
      productId: "550e8400-e29b-41d4-a716-446655440224",
      sku: "TEA-001",
      priceCents: 300,
      costCents: 0,
      status: "active",
      size: null,
      color: "green",
      barcode: null,
      targetGender: null,
    });
  });

  it("normalizes numeric form fields that browser controls provide as strings", () => {
    expect(
      mapProductFormToContract({
        name: "Tea",
        description: "",
        displayImageMediaAssetId: null,
        displayImagePublicUrl: null,
        status: "active",
        sortOrder: "12",
      } as unknown as ProductForm),
    ).toMatchObject({ sortOrder: 12 });

    expect(
      mapVariantFormToContract({
        productId: "550e8400-e29b-41d4-a716-446655440224",
        sku: "TEA-STRING-NUMBER",
        priceCents: "456",
        costCents: "123",
        status: "active",
        size: "",
        color: "",
        barcode: "",
        targetGender: null,
      } as unknown as VariantForm),
    ).toMatchObject({ priceCents: 456, costCents: 123 });
  });

  it("does not silently turn cleared numeric inputs into zero", () => {
    expect(() =>
      mapProductFormToContract({
        name: "Tea",
        description: "",
        displayImageMediaAssetId: null,
        displayImagePublicUrl: null,
        status: "active",
        sortOrder: "",
      } as unknown as ProductForm),
    ).toThrow();

    expect(() =>
      mapVariantFormToContract({
        productId: "550e8400-e29b-41d4-a716-446655440224",
        sku: "TEA-EMPTY-PRICE",
        priceCents: "",
        costCents: null,
        status: "active",
        size: "",
        color: "",
        barcode: "",
        targetGender: null,
      } as unknown as VariantForm),
    ).toThrow();

    expect(
      mapVariantFormToContract({
        productId: "550e8400-e29b-41d4-a716-446655440224",
        sku: "TEA-EMPTY-COST",
        priceCents: "456",
        costCents: "",
        status: "active",
        size: "",
        color: "",
        barcode: "",
        targetGender: null,
      } as unknown as VariantForm),
    ).toMatchObject({ priceCents: 456, costCents: null });
  });

  it("preserves nullable variant cost when opening an edit form", () => {
    expect(
      mapVariantResponseToForm({
        id: "550e8400-e29b-41d4-a716-446655440225",
        productId: "550e8400-e29b-41d4-a716-446655440224",
        sku: "TEA-NULL-COST",
        priceCents: 300,
        costCents: null,
        status: "active",
        size: null,
        color: "green",
        barcode: null,
        targetGender: null,
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z",
      }),
    ).toEqual({
      productId: "550e8400-e29b-41d4-a716-446655440224",
      sku: "TEA-NULL-COST",
      priceCents: 300,
      costCents: null,
      status: "active",
      size: "",
      color: "green",
      barcode: "",
      targetGender: null,
    });
  });

  it("maps product responses back into form state through the shared contract", () => {
    expect(
      mapProductResponseToForm({
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
      }),
    ).toEqual({
      name: "Tea",
      description: "",
      displayImageMediaAssetId: null,
      displayImagePublicUrl: null,
      status: "draft",
      sortOrder: 0,
    });
  });

  it("rejects fields that are not part of the shared contract", () => {
    expect(() =>
      mapProductFormToContract({
        name: "Tea",
        description: "",
        displayImageMediaAssetId: null,
        displayImagePublicUrl: null,
        status: "draft",
        sortOrder: 0,
        coverImageUrl: "https://example.com/free-form.jpg",
      } as ProductForm & { coverImageUrl: string }),
    ).toThrow();
  });
});
