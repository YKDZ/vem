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
import {
  createProductSchema,
  createProductVariantSchema,
  pageQuerySchema,
  updateProductSchema,
  updateProductVariantSchema,
} from "@vem/shared";
import { z } from "zod";

import { getOffset, toPageResult } from "../common/pagination.util";
import { DRIZZLE_CLIENT } from "../database/database.constants";

type PageQueryInput = z.infer<typeof pageQuerySchema>;
type ProductListInput = PageQueryInput & {
  keyword?: string;
  status?: "draft" | "active" | "inactive";
};
type ProductVariantListInput = PageQueryInput & {
  productId?: string;
};
type CreateProductInput = z.infer<typeof createProductSchema>;
type UpdateProductInput = z.infer<typeof updateProductSchema>;
type CreateProductVariantInput = z.infer<typeof createProductVariantSchema>;
type UpdateProductVariantInput = z.infer<typeof updateProductVariantSchema>;
type ProductDisplayImageAssetSummary = {
  id: string;
  publicUrl: string;
  contentType: string;
};

@Injectable()
export class ProductsService {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient) {}

  async listProducts(query: ProductListInput) {
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
        ...row.product,
        displayImageMediaAsset: row.displayImageMediaAsset?.id
          ? row.displayImageMediaAsset
          : null,
      })),
      query,
      Number(totalRow.total),
    );
  }

  async createProduct(input: CreateProductInput) {
    const displayImageMediaAsset = await this.requireProductDisplayImageAsset(
      input.displayImageMediaAssetId ?? null,
    );
    const [created] = await this.db
      .insert(products)
      .values({
        name: input.name,
        categoryId: input.categoryId ?? null,
        description: input.description ?? null,
        displayImageMediaAssetId: input.displayImageMediaAssetId ?? null,
        coverImageUrl: null,
        status: input.status,
        sortOrder: input.sortOrder,
      })
      .returning();
    return { ...created, displayImageMediaAsset };
  }

  async updateProduct(id: string, input: UpdateProductInput) {
    const requestedDisplayImageMediaAsset =
      await this.requireProductDisplayImageAsset(
        input.displayImageMediaAssetId ?? null,
        "displayImageMediaAssetId" in input,
      );
    const [updated] = await this.db
      .update(products)
      .set({
        name: input.name,
        categoryId: input.categoryId,
        description: input.description,
        displayImageMediaAssetId: input.displayImageMediaAssetId,
        coverImageUrl: null,
        status: input.status,
        sortOrder: input.sortOrder,
        updatedAt: new Date(),
      })
      .where(and(eq(products.id, id), isNull(products.deletedAt)))
      .returning();

    if (!updated) {
      throw new NotFoundException("Product not found");
    }
    return {
      ...updated,
      displayImageMediaAsset:
        requestedDisplayImageMediaAsset ??
        (await this.findProductDisplayImageAsset(
          updated.displayImageMediaAssetId,
        )),
    };
  }

  private async requireProductDisplayImageAsset(
    id: string | null,
    validate = true,
  ): Promise<ProductDisplayImageAssetSummary | null> {
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
  ): Promise<ProductDisplayImageAssetSummary | null> {
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

  async listVariants(query: ProductVariantListInput) {
    const filters: SQL[] = [isNull(productVariants.deletedAt)];
    if (query.productId) {
      filters.push(eq(productVariants.productId, query.productId));
    }
    const whereClause = and(...filters);

    const items = await this.db
      .select()
      .from(productVariants)
      .where(whereClause)
      .orderBy(desc(productVariants.createdAt))
      .limit(query.pageSize)
      .offset(getOffset(query));
    const [totalRow] = await this.db
      .select({ total: count() })
      .from(productVariants)
      .where(whereClause);

    return toPageResult(items, query, Number(totalRow.total));
  }

  async createVariant(input: CreateProductVariantInput) {
    const [created] = await this.db
      .insert(productVariants)
      .values({
        productId: input.productId,
        sku: input.sku,
        size: input.size ?? null,
        color: input.color ?? null,
        barcode: input.barcode ?? null,
        priceCents: input.priceCents,
        costCents: input.costCents ?? null,
        status: input.status,
        targetGender: input.targetGender ?? null,
      })
      .returning();
    return created;
  }

  async updateVariant(id: string, input: UpdateProductVariantInput) {
    const [updated] = await this.db
      .update(productVariants)
      .set({
        productId: input.productId,
        sku: input.sku,
        size: input.size,
        color: input.color,
        barcode: input.barcode,
        priceCents: input.priceCents,
        costCents: input.costCents,
        status: input.status,
        targetGender: input.targetGender,
        updatedAt: new Date(),
      })
      .where(and(eq(productVariants.id, id), isNull(productVariants.deletedAt)))
      .returning();

    if (!updated) {
      throw new NotFoundException("Product variant not found");
    }
    return updated;
  }
}
