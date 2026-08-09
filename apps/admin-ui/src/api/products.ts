import type { z } from "zod";

import {
  adminListProductsContract,
  adminCreateProductContract,
  adminUpdateProductContract,
  adminListProductVariantsContract,
  adminCreateProductVariantContract,
  adminUpdateProductVariantContract,
  adminProductDisplayImageUploadContract,
  createProductSchema,
  createProductVariantSchema,
  updateProductSchema,
  updateProductVariantSchema,
  type AdminMediaAssetSummary,
  type AdminProductListQuery,
  type AdminProductPageResponse,
  type AdminProductResponse,
  type AdminProductVariantListQuery,
  type AdminProductVariantPageResponse,
  type AdminProductVariantResponse,
  type PageResult,
} from "@vem/shared";

import { callAdminEndpointContract } from "./request";

export type MediaAssetSummary = AdminMediaAssetSummary;
export type Product = AdminProductResponse;
export type ProductVariant = AdminProductVariantResponse;
export type ProductQuery = AdminProductListQuery;
export type { PageResult };

export async function listProducts(
  query?: ProductQuery,
): Promise<AdminProductPageResponse> {
  return await callAdminEndpointContract(adminListProductsContract, {
    query: query ?? {},
  });
}

export async function createProduct(
  body: z.input<typeof createProductSchema>,
): Promise<Product> {
  return await callAdminEndpointContract(adminCreateProductContract, { body });
}

export async function updateProduct(
  id: string,
  body: z.input<typeof updateProductSchema>,
): Promise<Product> {
  return await callAdminEndpointContract(adminUpdateProductContract, {
    pathParams: { id },
    body,
  });
}

export async function uploadProductDisplayImage(
  file: File,
): Promise<MediaAssetSummary> {
  return await callAdminEndpointContract(
    adminProductDisplayImageUploadContract,
    {
      body: { file },
    },
  );
}

export async function listProductVariants(
  productId: string,
  query?: Omit<AdminProductVariantListQuery, "productId">,
): Promise<AdminProductVariantPageResponse> {
  return await callAdminEndpointContract(adminListProductVariantsContract, {
    query: { productId, pageSize: 100, ...query },
  });
}

export async function createProductVariant(
  body: z.input<typeof createProductVariantSchema>,
): Promise<ProductVariant> {
  return await callAdminEndpointContract(adminCreateProductVariantContract, {
    body,
  });
}

export async function updateProductVariant(
  id: string,
  body: z.input<typeof updateProductVariantSchema>,
): Promise<ProductVariant> {
  return await callAdminEndpointContract(adminUpdateProductVariantContract, {
    pathParams: { id },
    body,
  });
}
