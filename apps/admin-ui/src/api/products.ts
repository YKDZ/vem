import type { ProductStatus, VariantStatus } from "@vem/shared";

import { get, patch, post } from "./request";

export type MediaAssetSummary = {
  id: string;
  publicUrl: string;
  contentType: string;
};

export type Product = {
  id: string;
  name: string;
  description: string | null;
  displayImageMediaAssetId: string | null;
  displayImageMediaAsset: MediaAssetSummary | null;
  status: ProductStatus;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

export type ProductVariant = {
  id: string;
  productId: string;
  sku: string;
  size: string | null;
  color: string | null;
  barcode: string | null;
  priceCents: number;
  costCents: number | null;
  status: VariantStatus;
  targetGender?: "male" | "female" | null;
  tryOnSilhouetteMediaAssetId: string | null;
  tryOnSilhouetteMediaAsset: MediaAssetSummary | null;
  createdAt: string;
  updatedAt: string;
};
type ProductVariantWrite = Omit<
  ProductVariant,
  "id" | "createdAt" | "updatedAt" | "tryOnSilhouetteMediaAsset"
>;

export type ProductQuery = {
  keyword?: string;
  status?: ProductStatus;
  page?: number;
  pageSize?: number;
};

type ProductWrite = Omit<
  Product,
  "id" | "createdAt" | "updatedAt" | "displayImageMediaAsset"
>;

export type PageResult<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
};

export async function listProducts(
  query?: ProductQuery,
): Promise<PageResult<Product>> {
  return await get<PageResult<Product>>("/products", { params: query });
}

export async function createProduct(body: ProductWrite): Promise<Product> {
  return await post<Product>("/products", body);
}

export async function updateProduct(
  id: string,
  body: Partial<ProductWrite>,
): Promise<Product> {
  return await patch<Product>(`/products/${id}`, body);
}

export async function uploadProductDisplayImage(
  file: File,
): Promise<MediaAssetSummary> {
  const body = new FormData();
  body.append("file", file);
  return await post<MediaAssetSummary, FormData>(
    "/media-assets/product-display-images",
    body,
  );
}

export async function uploadTryOnSilhouette(
  file: File,
): Promise<MediaAssetSummary> {
  const body = new FormData();
  body.append("file", file);
  return await post<MediaAssetSummary, FormData>(
    "/media-assets/try-on-silhouettes",
    body,
  );
}

export async function listProductVariants(
  productId: string,
): Promise<PageResult<ProductVariant>> {
  return await get<PageResult<ProductVariant>>("/product-variants", {
    params: { productId, pageSize: 100 },
  });
}

export async function createProductVariant(
  body: ProductVariantWrite,
): Promise<ProductVariant> {
  return await post<ProductVariant>("/product-variants", body);
}

export async function updateProductVariant(
  id: string,
  body: Partial<ProductVariantWrite>,
): Promise<ProductVariant> {
  return await patch<ProductVariant>(`/product-variants/${id}`, body);
}
