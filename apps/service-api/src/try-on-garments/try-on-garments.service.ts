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

import { AuditService } from "../audit/audit.service";
import { DRIZZLE_CLIENT } from "../database/database.constants";
import { managedMediaAssetReference } from "../media-assets/media-assets.service";

@Injectable()
export class TryOnGarmentsService {
  constructor(
    @Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient,
    private readonly auditService: AuditService,
  ) {}

  async createDraft(
    input: TryOnGarmentDraftRequest,
    adminUserId: string,
  ): Promise<TryOnGarmentResponse> {
    await this.requireProduct(input.productId);
    const sourceMediaAsset = await this.requireSourceMediaAsset(
      input.sourceMediaAssetId,
    );
    const created = await this.db.transaction(async (tx) => {
      const [garment] = await tx
        .insert(tryOnGarments)
        .values({
          productId: input.productId,
          colorLabel: input.colorLabel,
          sourceMediaAssetId: input.sourceMediaAssetId,
          template: input.template,
          status: "draft",
        })
        .returning();
      await this.auditService.record(
        {
          adminUserId,
          action: "try_on_garments.draft.create",
          resourceType: "try_on_garment",
          resourceId: garment.id,
          afterJson: tryOnGarmentAuditSnapshot(garment),
        },
        tx,
      );
      return garment;
    });
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
      .where(and(eq(tryOnGarments.id, id), isNull(tryOnGarments.deletedAt)))
      .limit(1);
    if (!row) throw new NotFoundException("Try-On Garment not found");
    return toTryOnGarmentResponse(
      row.garment,
      toTryOnGarmentMediaAsset(row.sourceMediaAsset),
    );
  }

  async confirm(
    id: string,
    adminUserId: string,
  ): Promise<TryOnGarmentResponse> {
    const garment = await this.getById(id);
    if (garment.confirmedAt) return garment;
    const updated = await this.db.transaction(async (tx) => {
      const [confirmed] = await tx
        .update(tryOnGarments)
        .set({ confirmedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(tryOnGarments.id, id), isNull(tryOnGarments.deletedAt)))
        .returning();
      if (!confirmed) throw new NotFoundException("Try-On Garment not found");
      await this.auditService.record(
        {
          adminUserId,
          action: "try_on_garments.source.confirm",
          resourceType: "try_on_garment",
          resourceId: confirmed.id,
          beforeJson: { confirmedAt: null },
          afterJson: tryOnGarmentAuditSnapshot(confirmed),
        },
        tx,
      );
      return confirmed;
    });
    return toTryOnGarmentResponse(updated, garment.sourceMediaAsset);
  }

  async activate(id: string, adminUserId: string): Promise<TryOnGarmentResponse> {
    const garment = await this.getById(id);
    if (!garment.confirmedAt) {
      throw new BadRequestException("TRY_ON_GARMENT_CONFIRMATION_REQUIRED");
    }
    if (garment.status === "active") return garment;
    if (garment.status !== "draft") {
      throw new BadRequestException("TRY_ON_GARMENT_ACTIVATION_INVALID");
    }
    const updated = await this.db.transaction(async (tx) => {
      const [active] = await tx.update(tryOnGarments)
        .set({ status: "active", updatedAt: new Date() })
        .where(and(eq(tryOnGarments.id, id), isNull(tryOnGarments.deletedAt)))
        .returning();
      if (!active) throw new NotFoundException("Try-On Garment not found");
      await this.auditService.record({ adminUserId, action: "try_on_garments.activate", resourceType: "try_on_garment", resourceId: active.id, beforeJson: tryOnGarmentAuditSnapshot({ ...active, status: "draft" }), afterJson: tryOnGarmentAuditSnapshot(active) }, tx);
      return active;
    });
    return toTryOnGarmentResponse(updated, garment.sourceMediaAsset);
  }

  async retire(id: string, adminUserId: string): Promise<TryOnGarmentResponse> {
    const garment = await this.getById(id);
    if (garment.status === "retired") return garment;
    if (garment.status !== "active") {
      throw new BadRequestException("TRY_ON_GARMENT_RETIREMENT_INVALID");
    }
    const updated = await this.db.transaction(async (tx) => {
      const [retired] = await tx.update(tryOnGarments)
        .set({ status: "retired", updatedAt: new Date() })
        .where(and(eq(tryOnGarments.id, id), isNull(tryOnGarments.deletedAt)))
        .returning();
      if (!retired) throw new NotFoundException("Try-On Garment not found");
      await this.auditService.record({ adminUserId, action: "try_on_garments.retire", resourceType: "try_on_garment", resourceId: retired.id, beforeJson: tryOnGarmentAuditSnapshot({ ...retired, status: "active" }), afterJson: tryOnGarmentAuditSnapshot(retired) }, tx);
      return retired;
    });
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

function tryOnGarmentAuditSnapshot(
  garment: typeof tryOnGarments.$inferSelect,
): Record<string, unknown> {
  return {
    id: garment.id,
    productId: garment.productId,
    colorLabel: garment.colorLabel,
    sourceMediaAssetId: garment.sourceMediaAssetId,
    template: garment.template,
    status: garment.status,
    confirmedAt: garment.confirmedAt?.toISOString() ?? null,
    deletedAt: garment.deletedAt?.toISOString() ?? null,
  };
}

function toTryOnGarmentMediaAsset(
  asset: typeof mediaAssets.$inferSelect,
): TryOnGarmentMediaAsset {
  return tryOnGarmentMediaAssetSchema.parse({
    id: asset.id,
    managedReference: managedMediaAssetReference(asset.id),
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
    deletedAt: garment.deletedAt?.toISOString() ?? null,
  });
}
