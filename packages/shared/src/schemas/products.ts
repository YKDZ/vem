import { z } from "zod";

import { productStatusSchema, variantStatusSchema } from "../enums/catalog";

export const createProductSchema = z.object({
  name: z.string().min(1).max(128),
  categoryId: z.uuid().nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  coverImageUrl: z.url().nullable().optional(),
  status: productStatusSchema.default("draft"),
  sortOrder: z.int().min(0).default(0),
});

export const updateProductSchema = createProductSchema.partial();

export const createProductVariantSchema = z.object({
  productId: z.uuid(),
  sku: z.string().min(1).max(64),
  size: z.string().max(32).nullable().optional(),
  color: z.string().max(32).nullable().optional(),
  barcode: z.string().max(128).nullable().optional(),
  priceCents: z.int().min(0),
  costCents: z.int().min(0).nullable().optional(),
  status: variantStatusSchema.default("active"),
  targetGender: z.enum(["male", "female"]).nullable().optional(),
});

export const updateProductVariantSchema = createProductVariantSchema.partial();
