import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { ProductsService } from "./products.service";

const displayImageAsset = {
  id: "550e8400-e29b-41d4-a716-446655440124",
  publicUrl: "/api/media-assets/550e8400-e29b-41d4-a716-446655440124/content",
  contentType: "image/jpeg",
};
const tryOnSilhouetteAsset = {
  id: "550e8400-e29b-41d4-a716-446655440125",
  publicUrl: "/api/media-assets/550e8400-e29b-41d4-a716-446655440125/content",
  contentType: "image/png",
};

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
      {
        id: "550e8400-e29b-41d4-a716-446655440224",
        name: "基础短袖",
        displayImageMediaAssetId: displayImageAsset.id,
        coverImageUrl: null,
      },
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
        coverImageUrl: null,
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
    const updated = {
      id: "550e8400-e29b-41d4-a716-446655440224",
      name: "基础短袖",
      displayImageMediaAssetId: displayImageAsset.id,
      coverImageUrl: null,
    };
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
    ).resolves.toEqual({
      ...updated,
      displayImageMediaAsset: displayImageAsset,
    });
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        displayImageMediaAssetId: displayImageAsset.id,
        coverImageUrl: null,
      }),
    );
  });

  it("validates and returns a bound variant try-on silhouette on create", async () => {
    const returning = vi.fn().mockResolvedValue([
      {
        id: "550e8400-e29b-41d4-a716-446655440225",
        productId: "550e8400-e29b-41d4-a716-446655440224",
        sku: "TSHIRT-M-WHITE",
        tryOnSilhouetteMediaAssetId: tryOnSilhouetteAsset.id,
      },
    ]);
    const values = vi.fn().mockReturnValue({ returning });
    const insert = vi.fn().mockReturnValue({ values });
    const db = {
      select: vi.fn().mockReturnValueOnce(selectRows([tryOnSilhouetteAsset])),
      insert,
    };
    const service = new ProductsService(db as never);

    const variant = await service.createVariant({
      productId: "550e8400-e29b-41d4-a716-446655440224",
      sku: "TSHIRT-M-WHITE",
      priceCents: 1000,
      status: "active",
      tryOnSilhouetteMediaAssetId: tryOnSilhouetteAsset.id,
    });

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        tryOnSilhouetteMediaAssetId: tryOnSilhouetteAsset.id,
      }),
    );
    expect(variant).toEqual(
      expect.objectContaining({
        tryOnSilhouetteMediaAssetId: tryOnSilhouetteAsset.id,
        tryOnSilhouetteMediaAsset: tryOnSilhouetteAsset,
      }),
    );
  });

  it("rejects binding a missing, deleted, or wrong-purpose variant try-on silhouette", async () => {
    const db = {
      select: vi.fn().mockReturnValueOnce(selectRows([])),
      insert: vi.fn(),
    };
    const service = new ProductsService(db as never);

    await expect(
      service.createVariant({
        productId: "550e8400-e29b-41d4-a716-446655440224",
        sku: "TSHIRT-M-WHITE",
        priceCents: 1000,
        status: "active",
        tryOnSilhouetteMediaAssetId: tryOnSilhouetteAsset.id,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("returns the bound variant try-on silhouette on update writes", async () => {
    const updated = {
      id: "550e8400-e29b-41d4-a716-446655440225",
      productId: "550e8400-e29b-41d4-a716-446655440224",
      sku: "TSHIRT-M-WHITE",
      tryOnSilhouetteMediaAssetId: tryOnSilhouetteAsset.id,
    };
    const returning = vi.fn().mockResolvedValue([updated]);
    const set = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ returning }),
    });
    const db = {
      select: vi.fn().mockReturnValueOnce(selectRows([tryOnSilhouetteAsset])),
      update: vi.fn().mockReturnValue({ set }),
    };
    const service = new ProductsService(db as never);

    await expect(
      service.updateVariant(updated.id, {
        tryOnSilhouetteMediaAssetId: tryOnSilhouetteAsset.id,
      }),
    ).resolves.toEqual({
      ...updated,
      tryOnSilhouetteMediaAsset: tryOnSilhouetteAsset,
    });
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        tryOnSilhouetteMediaAssetId: tryOnSilhouetteAsset.id,
      }),
    );
  });

  it("returns the bound variant try-on silhouette on list reads", async () => {
    const variant = {
      id: "550e8400-e29b-41d4-a716-446655440225",
      productId: "550e8400-e29b-41d4-a716-446655440224",
      sku: "TSHIRT-M-WHITE",
      tryOnSilhouetteMediaAssetId: tryOnSilhouetteAsset.id,
      createdAt: new Date("2026-07-01T00:00:00Z"),
    };
    const listQuery = {
      from: vi.fn(() => listQuery),
      leftJoin: vi.fn(() => listQuery),
      where: vi.fn(() => listQuery),
      orderBy: vi.fn(() => listQuery),
      limit: vi.fn(() => listQuery),
      offset: vi.fn(async () => [
        {
          variant,
          tryOnSilhouetteMediaAsset: tryOnSilhouetteAsset,
        },
      ]),
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
          tryOnSilhouetteMediaAssetId: tryOnSilhouetteAsset.id,
          tryOnSilhouetteMediaAsset: tryOnSilhouetteAsset,
        },
      ],
    });
  });
});
