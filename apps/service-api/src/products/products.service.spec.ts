import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { ProductsService } from "./products.service";

const displayImageAsset = {
  id: "550e8400-e29b-41d4-a716-446655440124",
  publicUrl: "/api/media-assets/550e8400-e29b-41d4-a716-446655440124/content",
  contentType: "image/jpeg",
};
const createdAt = new Date("2026-07-01T00:00:00.000Z");
const updatedAt = new Date("2026-07-01T00:00:00.000Z");

function productRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "550e8400-e29b-41d4-a716-446655440224",
    name: "基础短袖",
    categoryId: null,
    description: null,
    displayImageMediaAssetId: null,
    coverImageUrl: null,
    status: "draft",
    sortOrder: 0,
    createdAt,
    updatedAt,
    ...overrides,
  };
}

function variantRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "550e8400-e29b-41d4-a716-446655440225",
    productId: "550e8400-e29b-41d4-a716-446655440224",
    sku: "TSHIRT-M-WHITE",
    size: null,
    color: null,
    barcode: null,
    priceCents: 1000,
    costCents: null,
    status: "active",
    targetGender: null,
    createdAt,
    updatedAt,
    ...overrides,
  };
}

function selectRows<T>(rows: T[]) {
  return {
    from: () => ({
      where: () => ({
        limit: async () => rows,
      }),
    }),
  };
}

describe("ProductsService", () => {
  it("validates and returns a bound product display image on create", async () => {
    const returning = vi.fn().mockResolvedValue([
      productRow({
        displayImageMediaAssetId: displayImageAsset.id,
      }),
    ]);
    const values = vi.fn().mockReturnValue({ returning });
    const insert = vi.fn().mockReturnValue({ values });
    const db = {
      select: vi.fn().mockReturnValueOnce(selectRows([displayImageAsset])),
      insert,
    };
    const service = new ProductsService(db as never);

    const product = await service.createProduct({
      name: "基础短袖",
      displayImageMediaAssetId: displayImageAsset.id,
      status: "draft",
      sortOrder: 0,
    });

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        displayImageMediaAssetId: displayImageAsset.id,
        coverImageUrl: null,
      }),
    );
    expect(product).toEqual(
      expect.objectContaining({
        displayImageMediaAssetId: displayImageAsset.id,
        displayImageMediaAsset: displayImageAsset,
      }),
    );
  });

  it("rejects binding a missing, deleted, or wrong-purpose media asset", async () => {
    const db = {
      select: vi.fn().mockReturnValueOnce(selectRows([])),
      insert: vi.fn(),
    };
    const service = new ProductsService(db as never);

    await expect(
      service.createProduct({
        name: "基础短袖",
        displayImageMediaAssetId: displayImageAsset.id,
        status: "draft",
        sortOrder: 0,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("returns the bound product display image on update writes", async () => {
    const updated = productRow({
      displayImageMediaAssetId: displayImageAsset.id,
    });
    const returning = vi.fn().mockResolvedValue([updated]);
    const set = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ returning }),
    });
    const db = {
      select: vi.fn().mockReturnValueOnce(selectRows([displayImageAsset])),
      update: vi.fn().mockReturnValue({ set }),
    };
    const service = new ProductsService(db as never);

    await expect(
      service.updateProduct(updated.id, {
        displayImageMediaAssetId: displayImageAsset.id,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        id: updated.id,
        displayImageMediaAssetId: displayImageAsset.id,
        displayImageMediaAsset: displayImageAsset,
      }),
    );
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        displayImageMediaAssetId: displayImageAsset.id,
        coverImageUrl: null,
      }),
    );
  });

  it("creates variants without any legacy media binding", async () => {
    const returning = vi.fn().mockResolvedValue([variantRow()]);
    const values = vi.fn().mockReturnValue({ returning });
    const insert = vi.fn().mockReturnValue({ values });
    const db = {
      insert,
    };
    const service = new ProductsService(db as never);

    const variant = await service.createVariant({
      productId: "550e8400-e29b-41d4-a716-446655440224",
      sku: "TSHIRT-M-WHITE",
      priceCents: 1000,
      status: "active",
    });

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        productId: "550e8400-e29b-41d4-a716-446655440224",
      }),
    );
    expect(variant).toEqual(
      expect.objectContaining({
        productId: "550e8400-e29b-41d4-a716-446655440224",
      }),
    );
  });

  it("updates variants without a legacy media binding", async () => {
    const updated = variantRow();
    const returning = vi.fn().mockResolvedValue([updated]);
    const set = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ returning }),
    });
    const db = {
      update: vi.fn().mockReturnValue({ set }),
    };
    const service = new ProductsService(db as never);

    await expect(
      service.updateVariant(updated.id, { sku: "TSHIRT-L-WHITE" }),
    ).resolves.toEqual(
      expect.objectContaining({
        id: updated.id,
        sku: "TSHIRT-M-WHITE",
      }),
    );
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        sku: "TSHIRT-L-WHITE",
      }),
    );
  });

  it("lists variants without legacy media fields", async () => {
    const variant = variantRow();
    const listQuery = {
      from: vi.fn(() => listQuery),
      where: vi.fn(() => listQuery),
      orderBy: vi.fn(() => listQuery),
      limit: vi.fn(() => listQuery),
      offset: vi.fn(async () => [{ variant }]),
    };
    const countQuery = {
      from: vi.fn(() => ({
        where: vi.fn(async () => [{ total: 1 }]),
      })),
    };
    const db = {
      select: vi
        .fn()
        .mockReturnValueOnce(listQuery)
        .mockReturnValueOnce(countQuery),
    };
    const service = new ProductsService(db as never);

    await expect(
      service.listVariants({
        productId: variant.productId,
        page: 1,
        pageSize: 100,
      }),
    ).resolves.toMatchObject({
      items: [
        {
          id: variant.id,
        },
      ],
    });
  });
});
