import type {
  TryOnGarmentDraftRequest,
  TryOnGarmentMediaAsset,
  TryOnGarmentResponse,
} from "@vem/shared";

import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  and,
  eq,
  isNull,
  mediaAssets,
  products,
  tryOnGarments,
  type DrizzleClient,
} from "@vem/db";
import {
  tryOnGarmentMediaAssetSchema,
  tryOnGarmentResponseSchema,
} from "@vem/shared";

import { DRIZZLE_CLIENT } from "../database/database.constants";

@Injectable()
export class TryOnGarmentsService {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient) {}

  async createDraft(
    input: TryOnGarmentDraftRequest,
  ): Promise<TryOnGarmentResponse> {
    await this.requireProduct(input.productId);
    const sourceMediaAsset = await this.requireSourceMediaAsset(
      input.sourceMediaAssetId,
    );
    const [created] = await this.db
      .insert(tryOnGarments)
      .values({
        productId: input.productId,
        colorLabel: input.colorLabel,
        sourceMediaAssetId: input.sourceMediaAssetId,
        template: input.template,
        status: "draft",
      })
      .returning();
    return toTryOnGarmentResponse(created, sourceMediaAsset);
  }

  async getById(id: string): Promise<TryOnGarmentResponse> {
    const [row] = await this.db
      .select({ garment: tryOnGarments, sourceMediaAsset: mediaAssets })
      .from(tryOnGarments)
      .innerJoin(
        mediaAssets,
        eq(mediaAssets.id, tryOnGarments.sourceMediaAssetId),
      )
      .where(eq(tryOnGarments.id, id))
      .limit(1);
    if (!row) throw new NotFoundException("Try-On Garment not found");
    return toTryOnGarmentResponse(
      row.garment,
      toTryOnGarmentMediaAsset(row.sourceMediaAsset),
    );
  }

  async confirm(id: string): Promise<TryOnGarmentResponse> {
    const garment = await this.getById(id);
    if (garment.confirmedAt) return garment;
    const [updated] = await this.db
      .update(tryOnGarments)
      .set({ confirmedAt: new Date(), updatedAt: new Date() })
      .where(eq(tryOnGarments.id, id))
      .returning();
    if (!updated) throw new NotFoundException("Try-On Garment not found");
    return toTryOnGarmentResponse(updated, garment.sourceMediaAsset);
  }

  private async requireProduct(id: string): Promise<void> {
    const [product] = await this.db
      .select({ id: products.id })
      .from(products)
      .where(and(eq(products.id, id), isNull(products.deletedAt)))
      .limit(1);
    if (!product)
      throw new BadRequestException("TRY_ON_GARMENT_PRODUCT_NOT_FOUND");
  }

  private async requireSourceMediaAsset(
    id: string,
  ): Promise<TryOnGarmentMediaAsset> {
    const [asset] = await this.db
      .select()
      .from(mediaAssets)
      .where(
        and(
          eq(mediaAssets.id, id),
          eq(mediaAssets.purpose, "try_on_garment"),
          eq(mediaAssets.contentType, "image/png"),
          eq(mediaAssets.hasTransparency, true),
          isNull(mediaAssets.deletedAt),
        ),
      )
      .limit(1);
    if (!asset) {
      throw new BadRequestException("TRY_ON_GARMENT_SOURCE_INVALID");
    }
    return toTryOnGarmentMediaAsset(asset);
  }
}

function toTryOnGarmentMediaAsset(
  asset: typeof mediaAssets.$inferSelect,
): TryOnGarmentMediaAsset {
  return tryOnGarmentMediaAssetSchema.parse({
    id: asset.id,
    managedReference: asset.publicUrl,
    purpose: asset.purpose,
    contentType: asset.contentType,
    byteSize: asset.byteSize,
    width: asset.width,
    height: asset.height,
    hasTransparency: asset.hasTransparency,
    sha256: asset.sha256,
  });
}

function toTryOnGarmentResponse(
  garment: typeof tryOnGarments.$inferSelect,
  sourceMediaAsset: TryOnGarmentMediaAsset,
): TryOnGarmentResponse {
  return tryOnGarmentResponseSchema.parse({
    id: garment.id,
    productId: garment.productId,
    colorLabel: garment.colorLabel,
    sourceMediaAsset,
    template: garment.template,
    status: garment.status,
    confirmedAt: garment.confirmedAt?.toISOString() ?? null,
    createdAt: garment.createdAt.toISOString(),
    updatedAt: garment.updatedAt.toISOString(),
  });
}
