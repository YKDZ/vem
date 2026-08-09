import { describe, expect, it, vi } from "vitest";

import { callAdminEndpointContract } from "@/api/request";

import {
  createProduct,
  createProductVariant,
  updateProduct,
  updateProductVariant,
  uploadProductDisplayImage,
} from "./products";

vi.mock("@/api/request", () => ({
  getContract: vi
    .fn()
    .mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 }),
  callAdminEndpointContract: vi.fn().mockResolvedValue({}),
  post: vi.fn(),
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

    expect(callAdminEndpointContract).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ method: "POST", path: "/products" }),
      { body: expect.objectContaining({ name: "Tea" }) },
    );
    expect(callAdminEndpointContract).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ method: "PATCH", path: "/products/:id" }),
      {
        pathParams: { id: "550e8400-e29b-41d4-a716-446655440001" },
        body: { description: null },
      },
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

    expect(callAdminEndpointContract).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ method: "POST", path: "/product-variants" }),
      { body: expect.objectContaining({ sku: "TEA-001" }) },
    );
    expect(callAdminEndpointContract).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({
        method: "PATCH",
        path: "/product-variants/:id",
      }),
      {
        pathParams: { id: "550e8400-e29b-41d4-a716-446655440002" },
        body: { costCents: null },
      },
    );
  });

  it("uses the complete shared endpoint contract for media uploads", async () => {
    const file = new File(["image"], "product.png", { type: "image/png" });

    await uploadProductDisplayImage(file);

    expect(callAdminEndpointContract).toHaveBeenLastCalledWith(
      expect.objectContaining({
        method: "POST",
        path: "/media-assets/product-display-images",
        pathParamsSchema: expect.any(Object),
        querySchema: expect.any(Object),
        bodySchema: expect.any(Object),
        responseSchema: expect.any(Object),
      }),
      { body: { file } },
    );
  });
});
