import type { z } from "zod";

import {
  adminProductListQuerySchema,
  adminProductPageResponseSchema,
  adminProductResponseSchema,
  adminProductVariantPageResponseSchema,
  adminProductVariantResponseSchema,
  adminProductVariantListQuerySchema,
  adminMediaAssetSummarySchema,
  createProductSchema,
  createProductVariantSchema,
  updateProductSchema,
  updateProductVariantSchema,
  type AdminMediaAssetSummary,
  type AdminProductListQuery,
  type AdminProductPageResponse,
  type AdminProductResponse,
  type AdminProductVariantPageResponse,
  type AdminProductVariantResponse,
} from "@vem/shared";

import {
  getContract,
  patchContract,
  postContract,
  postResponseContract,
} from "./request";

export type MediaAssetSummary = AdminMediaAssetSummary;
export type Product = AdminProductResponse;
export type ProductVariant = AdminProductVariantResponse;
export type ProductQuery = AdminProductListQuery;
export type PageResult<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
};

export async function listProducts(
  query?: ProductQuery,
): Promise<AdminProductPageResponse> {
  return await getContract(
    "/products",
    adminProductListQuerySchema,
    adminProductPageResponseSchema,
    query ?? {},
  );
}

export async function createProduct(
  body: z.input<typeof createProductSchema>,
): Promise<Product> {
  return await postContract(
    "/products",
    createProductSchema,
    adminProductResponseSchema,
    body,
  );
}

export async function updateProduct(
  id: string,
  body: z.input<typeof updateProductSchema>,
): Promise<Product> {
  return await patchContract(
    `/products/${id}`,
    updateProductSchema,
    adminProductResponseSchema,
    body,
  );
}

export async function uploadProductDisplayImage(
  file: File,
): Promise<MediaAssetSummary> {
  const body = new FormData();
  body.append("file", file);
  return await postResponseContract(
    "/media-assets/product-display-images",
    adminMediaAssetSummarySchema,
    body,
  );
}

export async function uploadTryOnSilhouette(
  file: File,
): Promise<MediaAssetSummary> {
  const body = new FormData();
  body.append("file", file);
  return await postResponseContract(
    "/media-assets/try-on-silhouettes",
    adminMediaAssetSummarySchema,
    body,
  );
}

export async function listProductVariants(
  productId: string,
): Promise<AdminProductVariantPageResponse> {
  return await getContract(
    "/product-variants",
    adminProductVariantListQuerySchema,
    adminProductVariantPageResponseSchema,
    { productId, pageSize: 100 },
  );
}

export async function createProductVariant(
  body: z.input<typeof createProductVariantSchema>,
): Promise<ProductVariant> {
  return await postContract(
    "/product-variants",
    createProductVariantSchema,
    adminProductVariantResponseSchema,
    body,
  );
}

export async function updateProductVariant(
  id: string,
  body: z.input<typeof updateProductVariantSchema>,
): Promise<ProductVariant> {
  return await patchContract(
    `/product-variants/${id}`,
    updateProductVariantSchema,
    adminProductVariantResponseSchema,
    body,
  );
}
