import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  and,
  count,
  desc,
  eq,
  isNull,
  productVariants,
  products,
  type DrizzleClient,
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
type CreateProductInput = z.infer<typeof createProductSchema>;
type UpdateProductInput = z.infer<typeof updateProductSchema>;
type CreateProductVariantInput = z.infer<typeof createProductVariantSchema>;
type UpdateProductVariantInput = z.infer<typeof updateProductVariantSchema>;

@Injectable()
export class ProductsService {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient) {}

  async listProducts(query: PageQueryInput) {
    const items = await this.db
      .select()
      .from(products)
      .where(isNull(products.deletedAt))
      .orderBy(desc(products.createdAt))
      .limit(query.pageSize)
      .offset(getOffset(query));
    const [totalRow] = await this.db
      .select({ total: count() })
      .from(products)
      .where(isNull(products.deletedAt));

    return toPageResult(items, query, Number(totalRow.total));
  }

  async createProduct(input: CreateProductInput) {
    const [created] = await this.db
      .insert(products)
      .values({
        name: input.name,
        categoryId: input.categoryId ?? null,
        description: input.description ?? null,
        coverImageUrl: input.coverImageUrl ?? null,
        status: input.status,
        sortOrder: input.sortOrder,
      })
      .returning();
    return created;
  }

  async updateProduct(id: string, input: UpdateProductInput) {
    const [updated] = await this.db
      .update(products)
      .set({
        name: input.name,
        categoryId: input.categoryId,
        description: input.description,
        coverImageUrl: input.coverImageUrl,
        status: input.status,
        sortOrder: input.sortOrder,
        updatedAt: new Date(),
      })
      .where(and(eq(products.id, id), isNull(products.deletedAt)))
      .returning();

    if (!updated) {
      throw new NotFoundException("Product not found");
    }
    return updated;
  }

  async listVariants(query: PageQueryInput) {
    const items = await this.db
      .select()
      .from(productVariants)
      .where(isNull(productVariants.deletedAt))
      .orderBy(desc(productVariants.createdAt))
      .limit(query.pageSize)
      .offset(getOffset(query));
    const [totalRow] = await this.db
      .select({ total: count() })
      .from(productVariants)
      .where(isNull(productVariants.deletedAt));

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
