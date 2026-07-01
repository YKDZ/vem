import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { ProductsService } from "./products.service";

const displayImageAsset = {
  id: "550e8400-e29b-41d4-a716-446655440124",
  publicUrl: "/api/media-assets/550e8400-e29b-41d4-a716-446655440124/content",
  contentType: "image/jpeg",
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
});
