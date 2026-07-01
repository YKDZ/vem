import { z } from "zod";

import { productStatusSchema, variantStatusSchema } from "../enums/catalog";

const productWriteFields = {
  name: z.string().min(1).max(128),
  categoryId: z.uuid().nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  displayImageMediaAssetId: z.uuid().nullable().optional(),
};

export const createProductSchema = z.strictObject({
  ...productWriteFields,
  status: productStatusSchema.default("draft"),
  sortOrder: z.int().min(0).default(0),
});

export const updateProductSchema = z.strictObject({
  name: productWriteFields.name.optional(),
  categoryId: productWriteFields.categoryId,
  description: productWriteFields.description,
  displayImageMediaAssetId: productWriteFields.displayImageMediaAssetId,
  status: productStatusSchema.optional(),
  sortOrder: z.int().min(0).optional(),
});

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
