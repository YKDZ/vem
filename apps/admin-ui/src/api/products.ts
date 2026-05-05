import type { ProductStatus, VariantStatus } from "@vem/shared";

import { get, patch, post } from "./request";

export type Product = {
  id: string;
  name: string;
  description: string | null;
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
  createdAt: string;
  updatedAt: string;
};

export type ProductQuery = {
  keyword?: string;
  status?: ProductStatus;
  page?: number;
  pageSize?: number;
};

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

export async function createProduct(
  body: Omit<Product, "id" | "createdAt" | "updatedAt">,
): Promise<Product> {
  return await post<Product>("/products", body);
}

export async function updateProduct(
  id: string,
  body: Partial<Omit<Product, "id" | "createdAt" | "updatedAt">>,
): Promise<Product> {
  return await patch<Product>(`/products/${id}`, body);
}

export async function listProductVariants(
  productId: string,
): Promise<PageResult<ProductVariant>> {
  return await get<PageResult<ProductVariant>>("/product-variants", {
    params: { productId, pageSize: 100 },
  });
}

export async function createProductVariant(
  body: Omit<ProductVariant, "id" | "createdAt" | "updatedAt">,
): Promise<ProductVariant> {
  return await post<ProductVariant>("/product-variants", body);
}

export async function updateProductVariant(
  id: string,
  body: Partial<Omit<ProductVariant, "id" | "createdAt" | "updatedAt">>,
): Promise<ProductVariant> {
  return await patch<ProductVariant>(`/product-variants/${id}`, body);
}
