import { z } from "zod";

import { defineAdminApiResponseContract } from "../admin-api-contract";
import { productStatusSchema, variantStatusSchema } from "../enums/catalog";
import { createPageResultSchema, pageQuerySchema } from "./pagination";

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

const productVariantWriteFields = {
  productId: z.uuid(),
  sku: z.string().min(1).max(64),
  size: z.string().max(32).nullable().optional(),
  color: z.string().max(32).nullable().optional(),
  barcode: z.string().max(128).nullable().optional(),
  priceCents: z.int().min(0),
  costCents: z.int().min(0).nullable().optional(),
  targetGender: z.enum(["male", "female"]).nullable().optional(),
  tryOnSilhouetteMediaAssetId: z.uuid().nullable().optional(),
};

export const createProductVariantSchema = z.strictObject({
  ...productVariantWriteFields,
  status: variantStatusSchema.default("active"),
});

export const updateProductVariantSchema = z.strictObject({
  productId: productVariantWriteFields.productId.optional(),
  sku: productVariantWriteFields.sku.optional(),
  size: productVariantWriteFields.size,
  color: productVariantWriteFields.color,
  barcode: productVariantWriteFields.barcode,
  priceCents: productVariantWriteFields.priceCents.optional(),
  costCents: productVariantWriteFields.costCents,
  status: variantStatusSchema.optional(),
  targetGender: productVariantWriteFields.targetGender,
  tryOnSilhouetteMediaAssetId:
    productVariantWriteFields.tryOnSilhouetteMediaAssetId,
});

export const adminProductListQuerySchema = pageQuerySchema.extend({
  keyword: z.string().max(128).optional(),
  status: productStatusSchema.optional(),
});

export const adminProductVariantListQuerySchema = pageQuerySchema.extend({
  productId: z.uuid().optional(),
});

export const adminMediaAssetSummarySchema = z.strictObject({
  id: z.uuid(),
  publicUrl: z.string().min(1),
  contentType: z.string().min(1),
});

export const adminProductDisplayImageUploadContract =
  defineAdminApiResponseContract({
    method: "POST",
    path: "/media-assets/product-display-images",
    responseSchema: adminMediaAssetSummarySchema,
  });

export const adminTryOnSilhouetteUploadContract =
  defineAdminApiResponseContract({
    method: "POST",
    path: "/media-assets/try-on-silhouettes",
    responseSchema: adminMediaAssetSummarySchema,
  });

export const adminProductResponseSchema = z.strictObject({
  id: z.uuid(),
  name: z.string().min(1).max(128),
  categoryId: z.uuid().nullable(),
  description: z.string().max(2000).nullable(),
  displayImageMediaAssetId: z.uuid().nullable(),
  displayImageMediaAsset: adminMediaAssetSummarySchema.nullable(),
  status: productStatusSchema,
  sortOrder: z.int().min(0),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const adminProductVariantResponseSchema = z.strictObject({
  id: z.uuid(),
  productId: z.uuid(),
  sku: z.string().min(1).max(64),
  size: z.string().max(32).nullable(),
  color: z.string().max(32).nullable(),
  barcode: z.string().max(128).nullable(),
  priceCents: z.int().min(0),
  costCents: z.int().min(0).nullable(),
  status: variantStatusSchema,
  targetGender: z.enum(["male", "female"]).nullable(),
  tryOnSilhouetteMediaAssetId: z.uuid().nullable(),
  tryOnSilhouetteMediaAsset: adminMediaAssetSummarySchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const adminProductPageResponseSchema = createPageResultSchema(
  adminProductResponseSchema,
);

export const adminProductVariantPageResponseSchema = createPageResultSchema(
  adminProductVariantResponseSchema,
);

export type AdminCreateProductRequest = z.infer<typeof createProductSchema>;
export type AdminUpdateProductRequest = z.infer<typeof updateProductSchema>;
export type AdminCreateProductVariantRequest = z.infer<
  typeof createProductVariantSchema
>;
export type AdminUpdateProductVariantRequest = z.infer<
  typeof updateProductVariantSchema
>;
export type AdminProductListQuery = z.infer<typeof adminProductListQuerySchema>;
export type AdminProductVariantListQuery = z.infer<
  typeof adminProductVariantListQuerySchema
>;
export type AdminMediaAssetSummary = z.infer<
  typeof adminMediaAssetSummarySchema
>;
export type AdminProductResponse = z.infer<typeof adminProductResponseSchema>;
export type AdminProductVariantResponse = z.infer<
  typeof adminProductVariantResponseSchema
>;
export type AdminProductPageResponse = z.infer<
  typeof adminProductPageResponseSchema
>;
export type AdminProductVariantPageResponse = z.infer<
  typeof adminProductVariantPageResponseSchema
>;
