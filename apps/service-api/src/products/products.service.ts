import type {
  AdminCreateProductRequest,
  AdminCreateProductVariantRequest,
  AdminMediaAssetSummary,
  AdminProductListQuery,
  AdminProductVariantListQuery,
  AdminUpdateProductRequest,
  AdminUpdateProductVariantRequest,
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
  desc,
  eq,
  isNull,
  mediaAssets,
  productVariants,
  products,
  sql,
  type DrizzleClient,
  type SQL,
} from "@vem/db";

import { getOffset, toPageResult } from "../common/pagination.util";
import { DRIZZLE_CLIENT } from "../database/database.constants";
import {
  mapCreateProductDtoToInsert,
  mapCreateVariantDtoToInsert,
  mapUpdateProductDtoToPatch,
  mapUpdateVariantDtoToPatch,
  toAdminProductResponse,
  toAdminProductVariantResponse,
} from "./products.contract-mappers";

@Injectable()
export class ProductsService {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient) {}

  async listProducts(query: AdminProductListQuery) {
    const filters: SQL[] = [isNull(products.deletedAt)];
    if (query.status) {
      filters.push(eq(products.status, query.status));
    }
    if (query.keyword?.trim()) {
      const keyword = `%${query.keyword.trim()}%`;
      filters.push(sql`(
        ${products.name} ilike ${keyword}
        or exists (
          select 1 from ${productVariants}
          where ${productVariants.productId} = ${products.id}
            and ${productVariants.deletedAt} is null
            and (
              ${productVariants.sku} ilike ${keyword}
              or ${productVariants.barcode} ilike ${keyword}
              or ${productVariants.color} ilike ${keyword}
              or ${productVariants.size} ilike ${keyword}
            )
        )
      )`);
    }
    const whereClause = and(...filters);

    const rows = await this.db
      .select({
        product: products,
        displayImageMediaAsset: {
          id: mediaAssets.id,
          publicUrl: mediaAssets.publicUrl,
          contentType: mediaAssets.contentType,
        },
      })
      .from(products)
      .leftJoin(
        mediaAssets,
        and(
          eq(mediaAssets.id, products.displayImageMediaAssetId),
          isNull(mediaAssets.deletedAt),
        ),
      )
      .where(whereClause)
      .orderBy(desc(products.createdAt))
      .limit(query.pageSize)
      .offset(getOffset(query));
    const [totalRow] = await this.db
      .select({ total: count() })
      .from(products)
      .where(whereClause);

    return toPageResult(
      rows.map((row) => ({
        ...toAdminProductResponse(
          row.product,
          row.displayImageMediaAsset?.id ? row.displayImageMediaAsset : null,
        ),
      })),
      query,
      Number(totalRow.total),
    );
  }

  async createProduct(input: AdminCreateProductRequest) {
    const displayImageMediaAsset = await this.requireProductDisplayImageAsset(
      input.displayImageMediaAssetId ?? null,
    );
    const [created] = await this.db
      .insert(products)
      .values(mapCreateProductDtoToInsert(input))
      .returning();
    return toAdminProductResponse(created, displayImageMediaAsset);
  }

  async updateProduct(id: string, input: AdminUpdateProductRequest) {
    const requestedDisplayImageMediaAsset =
      await this.requireProductDisplayImageAsset(
        input.displayImageMediaAssetId ?? null,
        "displayImageMediaAssetId" in input,
      );
    const [updated] = await this.db
      .update(products)
      .set(mapUpdateProductDtoToPatch(input))
      .where(and(eq(products.id, id), isNull(products.deletedAt)))
      .returning();

    if (!updated) {
      throw new NotFoundException("Product not found");
    }
    return toAdminProductResponse(
      updated,
      requestedDisplayImageMediaAsset ??
        (await this.findProductDisplayImageAsset(
          updated.displayImageMediaAssetId,
        )),
    );
  }

  private async requireProductDisplayImageAsset(
    id: string | null,
    validate = true,
  ): Promise<AdminMediaAssetSummary | null> {
    if (!validate || id === null) return null;
    const asset = await this.findProductDisplayImageAsset(id);
    if (!asset) {
      throw new BadRequestException(
        "Product display image media asset not found",
      );
    }
    return asset;
  }

  private async findProductDisplayImageAsset(
    id: string | null,
  ): Promise<AdminMediaAssetSummary | null> {
    if (!id) return null;
    const [asset] = await this.db
      .select({
        id: mediaAssets.id,
        publicUrl: mediaAssets.publicUrl,
        contentType: mediaAssets.contentType,
      })
      .from(mediaAssets)
      .where(
        and(
          eq(mediaAssets.id, id),
          eq(mediaAssets.purpose, "product_display_image"),
          isNull(mediaAssets.deletedAt),
        ),
      )
      .limit(1);
    return asset ?? null;
  }

  async listVariants(query: AdminProductVariantListQuery) {
    const filters: SQL[] = [isNull(productVariants.deletedAt)];
    if (query.productId) {
      filters.push(eq(productVariants.productId, query.productId));
    }
    const whereClause = and(...filters);

    const rows = await this.db
      .select({
        variant: productVariants,
        tryOnSilhouetteMediaAsset: {
          id: mediaAssets.id,
          publicUrl: mediaAssets.publicUrl,
          contentType: mediaAssets.contentType,
        },
      })
      .from(productVariants)
      .leftJoin(
        mediaAssets,
        and(
          eq(mediaAssets.id, productVariants.tryOnSilhouetteMediaAssetId),
          eq(mediaAssets.purpose, "try_on_silhouette"),
          isNull(mediaAssets.deletedAt),
        ),
      )
      .where(whereClause)
      .orderBy(desc(productVariants.createdAt))
      .limit(query.pageSize)
      .offset(getOffset(query));
    const [totalRow] = await this.db
      .select({ total: count() })
      .from(productVariants)
      .where(whereClause);

    return toPageResult(
      rows.map((row) =>
        toAdminProductVariantResponse(
          row.variant,
          row.tryOnSilhouetteMediaAsset?.id
            ? row.tryOnSilhouetteMediaAsset
            : null,
        ),
      ),
      query,
      Number(totalRow.total),
    );
  }

  async createVariant(input: AdminCreateProductVariantRequest) {
    const tryOnSilhouetteMediaAsset =
      await this.requireVariantTryOnSilhouetteAsset(
        input.tryOnSilhouetteMediaAssetId ?? null,
      );
    const [created] = await this.db
      .insert(productVariants)
      .values(mapCreateVariantDtoToInsert(input))
      .returning();
    return toAdminProductVariantResponse(created, tryOnSilhouetteMediaAsset);
  }

  async updateVariant(id: string, input: AdminUpdateProductVariantRequest) {
    const requestedTryOnSilhouetteMediaAsset =
      await this.requireVariantTryOnSilhouetteAsset(
        input.tryOnSilhouetteMediaAssetId ?? null,
        "tryOnSilhouetteMediaAssetId" in input,
      );
    const [updated] = await this.db
      .update(productVariants)
      .set(mapUpdateVariantDtoToPatch(input))
      .where(and(eq(productVariants.id, id), isNull(productVariants.deletedAt)))
      .returning();

    if (!updated) {
      throw new NotFoundException("Product variant not found");
    }
    return toAdminProductVariantResponse(
      updated,
      requestedTryOnSilhouetteMediaAsset ??
        (await this.findVariantTryOnSilhouetteAsset(
          updated.tryOnSilhouetteMediaAssetId,
        )),
    );
  }

  private async requireVariantTryOnSilhouetteAsset(
    id: string | null,
    validate = true,
  ): Promise<AdminMediaAssetSummary | null> {
    if (!validate || id === null) return null;
    const asset = await this.findVariantTryOnSilhouetteAsset(id);
    if (!asset) {
      throw new BadRequestException(
        "Variant try-on silhouette media asset not found",
      );
    }
    return asset;
  }

  private async findVariantTryOnSilhouetteAsset(
    id: string | null,
  ): Promise<AdminMediaAssetSummary | null> {
    if (!id) return null;
    const [asset] = await this.db
      .select({
        id: mediaAssets.id,
        publicUrl: mediaAssets.publicUrl,
        contentType: mediaAssets.contentType,
      })
      .from(mediaAssets)
      .where(
        and(
          eq(mediaAssets.id, id),
          eq(mediaAssets.purpose, "try_on_silhouette"),
          isNull(mediaAssets.deletedAt),
        ),
      )
      .limit(1);
    return asset ?? null;
  }
}
