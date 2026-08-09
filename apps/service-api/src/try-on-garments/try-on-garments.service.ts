import type {
  TryOnGarmentDraftRequest,
  TryOnGarmentMediaAsset,
  TryOnGarmentResponse,
  TryOnGarmentSourceReplacementRequest,
  TryOnGarmentVariantAssociationRequest,
} from "@vem/shared";

import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  and,
  count,
  eq,
  isNull,
  isNotNull,
  inArray,
  mediaAssets,
  or,
  productVariants,
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
    const sourceMediaAsset = await this.requireSourceMediaAsset(
      input.sourceMediaAssetId,
    );
    const created = await this.db.transaction(async (tx) => {
      // A product row is the stable aggregate lock for this bounded list. It
      // serializes concurrent creates even when no garment row yet exists.
      const [product] = await tx
        .select({ id: products.id })
        .from(products)
        .where(
          and(eq(products.id, input.productId), isNull(products.deletedAt)),
        )
        .for("update", { of: products });
      if (!product) {
        throw new BadRequestException("TRY_ON_GARMENT_PRODUCT_NOT_FOUND");
      }
      const [{ total }] = await tx
        .select({ total: count() })
        .from(tryOnGarments)
        .where(
          and(
            eq(tryOnGarments.productId, input.productId),
            isNull(tryOnGarments.deletedAt),
          ),
        );
      if (Number(total) >= 256) {
        throw new BadRequestException(
          "TRY_ON_GARMENT_PRODUCT_CAPACITY_REACHED",
        );
      }
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
    const associatedVariants = await this.db
      .select({ id: productVariants.id })
      .from(productVariants)
      .where(
        and(
          eq(productVariants.tryOnGarmentId, id),
          isNull(productVariants.deletedAt),
        ),
      );
    return toTryOnGarmentResponse(
      row.garment,
      toTryOnGarmentMediaAsset(row.sourceMediaAsset),
      associatedVariants.map((variant) => variant.id),
    );
  }

  async listByProduct(productId: string): Promise<TryOnGarmentResponse[]> {
    const rows = await this.db
      .select({ garment: tryOnGarments, sourceMediaAsset: mediaAssets })
      .from(tryOnGarments)
      .innerJoin(
        mediaAssets,
        eq(mediaAssets.id, tryOnGarments.sourceMediaAssetId),
      )
      .where(
        and(
          eq(tryOnGarments.productId, productId),
          isNull(tryOnGarments.deletedAt),
        ),
      )
      .orderBy(tryOnGarments.createdAt);
    if (rows.length === 0) return [];
    const garmentIds = rows.map((row) => row.garment.id);
    const associations = await this.db
      .select({
        garmentId: productVariants.tryOnGarmentId,
        id: productVariants.id,
      })
      .from(productVariants)
      .where(
        and(
          inArray(productVariants.tryOnGarmentId, garmentIds),
          isNull(productVariants.deletedAt),
        ),
      );
    return rows.map((row) =>
      toTryOnGarmentResponse(
        row.garment,
        toTryOnGarmentMediaAsset(row.sourceMediaAsset),
        associations
          .filter((association) => association.garmentId === row.garment.id)
          .map((association) => association.id),
      ),
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
      return {
        garment: confirmed,
        associatedVariantIds: await this.readAssociatedVariantIds(
          confirmed.id,
          tx,
        ),
      };
    });
    return toTryOnGarmentResponse(
      updated.garment,
      garment.sourceMediaAsset,
      updated.associatedVariantIds,
    );
  }

  async activate(
    id: string,
    adminUserId: string,
  ): Promise<TryOnGarmentResponse> {
    const garment = await this.getById(id);
    if (!garment.confirmedAt) {
      throw new BadRequestException("TRY_ON_GARMENT_CONFIRMATION_REQUIRED");
    }
    if (garment.status === "active") return garment;
    if (garment.status !== "draft") {
      throw new BadRequestException("TRY_ON_GARMENT_ACTIVATION_INVALID");
    }
    const updated = await this.db.transaction(async (tx) => {
      const [active] = await tx
        .update(tryOnGarments)
        .set({ status: "active", updatedAt: new Date() })
        .where(
          and(
            eq(tryOnGarments.id, id),
            eq(tryOnGarments.status, "draft"),
            isNotNull(tryOnGarments.confirmedAt),
            isNull(tryOnGarments.deletedAt),
          ),
        )
        .returning();
      if (!active) return null;
      await this.auditService.record(
        {
          adminUserId,
          action: "try_on_garments.activate",
          resourceType: "try_on_garment",
          resourceId: active.id,
          beforeJson: tryOnGarmentAuditSnapshot({ ...active, status: "draft" }),
          afterJson: tryOnGarmentAuditSnapshot(active),
        },
        tx,
      );
      return {
        garment: active,
        associatedVariantIds: await this.readAssociatedVariantIds(
          active.id,
          tx,
        ),
      };
    });
    if (!updated) {
      const latest = await this.getById(id);
      if (latest.status === "active") return latest;
      if (!latest.confirmedAt) {
        throw new BadRequestException("TRY_ON_GARMENT_CONFIRMATION_REQUIRED");
      }
      throw new BadRequestException("TRY_ON_GARMENT_ACTIVATION_INVALID");
    }
    return toTryOnGarmentResponse(
      updated.garment,
      garment.sourceMediaAsset,
      updated.associatedVariantIds,
    );
  }

  async retire(id: string, adminUserId: string): Promise<TryOnGarmentResponse> {
    const garment = await this.getById(id);
    if (garment.status === "retired") return garment;
    if (garment.status !== "active") {
      throw new BadRequestException("TRY_ON_GARMENT_RETIREMENT_INVALID");
    }
    const updated = await this.db.transaction(async (tx) => {
      const [retired] = await tx
        .update(tryOnGarments)
        .set({ status: "retired", updatedAt: new Date() })
        .where(
          and(
            eq(tryOnGarments.id, id),
            eq(tryOnGarments.status, "active"),
            isNull(tryOnGarments.deletedAt),
          ),
        )
        .returning();
      if (!retired) return null;
      await this.auditService.record(
        {
          adminUserId,
          action: "try_on_garments.retire",
          resourceType: "try_on_garment",
          resourceId: retired.id,
          beforeJson: tryOnGarmentAuditSnapshot({
            ...retired,
            status: "active",
          }),
          afterJson: tryOnGarmentAuditSnapshot(retired),
        },
        tx,
      );
      return {
        garment: retired,
        associatedVariantIds: await this.readAssociatedVariantIds(
          retired.id,
          tx,
        ),
      };
    });
    if (!updated) {
      const latest = await this.getById(id);
      if (latest.status === "retired") return latest;
      throw new BadRequestException("TRY_ON_GARMENT_RETIREMENT_INVALID");
    }
    return toTryOnGarmentResponse(
      updated.garment,
      garment.sourceMediaAsset,
      updated.associatedVariantIds,
    );
  }

  /** Replaces the exact association set atomically; product traits are never
   * consulted to infer an association. */
  async replaceVariantAssociations(
    id: string,
    input: TryOnGarmentVariantAssociationRequest,
    adminUserId: string,
  ): Promise<TryOnGarmentResponse> {
    if (new Set(input.variantIds).size !== input.variantIds.length) {
      throw new BadRequestException("TRY_ON_GARMENT_VARIANT_DUPLICATE");
    }
    return await this.db.transaction(async (tx) => {
      // The garment lock serializes replacement sets for this shared source;
      // variant row locks make the product check and the following writes one
      // decision, rather than a read-then-write race with variant edits.
      const [row] = await tx
        .select({ garment: tryOnGarments, sourceMediaAsset: mediaAssets })
        .from(tryOnGarments)
        .innerJoin(
          mediaAssets,
          eq(mediaAssets.id, tryOnGarments.sourceMediaAssetId),
        )
        .where(and(eq(tryOnGarments.id, id), isNull(tryOnGarments.deletedAt)))
        .for("update", { of: tryOnGarments });
      if (!row) throw new NotFoundException("Try-On Garment not found");

      const variants = await tx
        .select({
          id: productVariants.id,
          productId: productVariants.productId,
        })
        .from(productVariants)
        .where(
          and(
            or(
              inArray(productVariants.id, input.variantIds),
              eq(productVariants.tryOnGarmentId, id),
            ),
            isNull(productVariants.deletedAt),
          ),
        )
        .for("update");
      const requested = variants.filter((variant) =>
        input.variantIds.includes(variant.id),
      );
      if (
        requested.length !== input.variantIds.length ||
        requested.some((variant) => variant.productId !== row.garment.productId)
      ) {
        throw new BadRequestException(
          "TRY_ON_GARMENT_VARIANT_PRODUCT_MISMATCH",
        );
      }

      await tx
        .update(productVariants)
        .set({ tryOnGarmentId: null, updatedAt: new Date() })
        .where(eq(productVariants.tryOnGarmentId, id));
      await tx
        .update(productVariants)
        .set({ tryOnGarmentId: id, updatedAt: new Date() })
        .where(inArray(productVariants.id, input.variantIds));
      await this.auditService.record(
        {
          adminUserId,
          action: "try_on_garments.variant_associations.replace",
          resourceType: "try_on_garment",
          resourceId: id,
          afterJson: { variantIds: input.variantIds },
        },
        tx,
      );
      return toTryOnGarmentResponse(
        row.garment,
        toTryOnGarmentMediaAsset(row.sourceMediaAsset),
        input.variantIds,
      );
    });
  }

  /** Validate the new immutable source before the sole garment row is changed,
   * so every associated variant observes either the old or new reference. */
  async replaceSource(
    id: string,
    input: TryOnGarmentSourceReplacementRequest,
    adminUserId: string,
  ): Promise<TryOnGarmentResponse> {
    const {
      garment: updated,
      sourceMediaAsset,
      associatedVariantIds,
    } = await this.db.transaction(async (tx) => {
      const [current] = await tx
        .select({ garment: tryOnGarments })
        .from(tryOnGarments)
        .where(and(eq(tryOnGarments.id, id), isNull(tryOnGarments.deletedAt)))
        .for("update", { of: tryOnGarments });
      if (!current) throw new NotFoundException("Try-On Garment not found");
      const [source] = await tx
        .select()
        .from(mediaAssets)
        .where(
          and(
            eq(mediaAssets.id, input.sourceMediaAssetId),
            eq(mediaAssets.purpose, "try_on_garment"),
            eq(mediaAssets.contentType, "image/png"),
            eq(mediaAssets.hasTransparency, true),
            isNull(mediaAssets.deletedAt),
          ),
        )
        .limit(1);
      if (!source) {
        throw new BadRequestException("TRY_ON_GARMENT_SOURCE_INVALID");
      }
      const [garment] = await tx
        .update(tryOnGarments)
        .set({
          sourceMediaAssetId: input.sourceMediaAssetId,
          template: input.template,
          updatedAt: new Date(),
        })
        .where(and(eq(tryOnGarments.id, id), isNull(tryOnGarments.deletedAt)))
        .returning();
      if (!garment) throw new NotFoundException("Try-On Garment not found");
      await this.auditService.record(
        {
          adminUserId,
          action: "try_on_garments.source.replace",
          resourceType: "try_on_garment",
          resourceId: id,
          beforeJson: tryOnGarmentAuditSnapshot(current.garment),
          afterJson: tryOnGarmentAuditSnapshot(garment),
        },
        tx,
      );
      return {
        garment,
        sourceMediaAsset: toTryOnGarmentMediaAsset(source),
        associatedVariantIds: await this.readAssociatedVariantIds(
          garment.id,
          tx,
        ),
      };
    });
    return toTryOnGarmentResponse(
      updated,
      sourceMediaAsset,
      associatedVariantIds,
    );
  }

  private async readAssociatedVariantIds(
    id: string,
    executor: Pick<DrizzleClient, "select"> = this.db,
  ): Promise<string[]> {
    const variants = await executor
      .select({ id: productVariants.id })
      .from(productVariants)
      .where(
        and(
          eq(productVariants.tryOnGarmentId, id),
          isNull(productVariants.deletedAt),
        ),
      );
    return variants.map((variant) => variant.id);
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
  associatedVariantIds: string[] = [],
): TryOnGarmentResponse {
  return tryOnGarmentResponseSchema.parse({
    id: garment.id,
    productId: garment.productId,
    colorLabel: garment.colorLabel,
    sourceMediaAsset,
    template: garment.template,
    status: garment.status,
    associatedVariantIds,
    confirmedAt: garment.confirmedAt?.toISOString() ?? null,
    createdAt: garment.createdAt.toISOString(),
    updatedAt: garment.updatedAt.toISOString(),
    deletedAt: garment.deletedAt?.toISOString() ?? null,
  });
}
