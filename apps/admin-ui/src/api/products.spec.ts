import { describe, expect, it, vi } from "vitest";

import {
  patchContract,
  postAdminApiContract,
  postContract,
} from "@/api/request";

import {
  createProduct,
  createProductVariant,
  updateProduct,
  updateProductVariant,
  uploadProductDisplayImage,
  uploadTryOnSilhouette,
} from "./products";

vi.mock("@/api/request", () => ({
  getContract: vi
    .fn()
    .mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 }),
  patchContract: vi.fn().mockResolvedValue({}),
  post: vi.fn(),
  postContract: vi.fn().mockResolvedValue({}),
  postAdminApiContract: vi.fn().mockResolvedValue({}),
}));

describe("products api", () => {
  it("uses schema-bound helpers for product writes", async () => {
    await createProduct({
      name: "Tea",
      description: null,
      displayImageMediaAssetId: null,
      status: "draft",
      sortOrder: 0,
    });
    await updateProduct("550e8400-e29b-41d4-a716-446655440001", {
      description: null,
    });

    expect(postContract).toHaveBeenCalledWith(
      "/products",
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({ name: "Tea" }),
    );
    expect(patchContract).toHaveBeenCalledWith(
      "/products/550e8400-e29b-41d4-a716-446655440001",
      expect.any(Object),
      expect.any(Object),
      { description: null },
    );
  });

  it("uses schema-bound helpers for product variant writes", async () => {
    await createProductVariant({
      productId: "550e8400-e29b-41d4-a716-446655440001",
      sku: "TEA-001",
      priceCents: 300,
    });
    await updateProductVariant("550e8400-e29b-41d4-a716-446655440002", {
      costCents: null,
    });

    expect(postContract).toHaveBeenCalledWith(
      "/product-variants",
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({ sku: "TEA-001" }),
    );
    expect(patchContract).toHaveBeenCalledWith(
      "/product-variants/550e8400-e29b-41d4-a716-446655440002",
      expect.any(Object),
      expect.any(Object),
      { costCents: null },
    );
  });

  it("parses media upload responses through the shared media asset summary schema", async () => {
    const file = new File(["image"], "product.png", { type: "image/png" });

    await uploadProductDisplayImage(file);
    await uploadTryOnSilhouette(file);

    expect(postAdminApiContract).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        path: "/media-assets/product-display-images",
        responseSchema: expect.any(Object),
      }),
      expect.any(FormData),
    );
    expect(postAdminApiContract).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        path: "/media-assets/try-on-silhouettes",
        responseSchema: expect.any(Object),
      }),
      expect.any(FormData),
    );
  });
});
