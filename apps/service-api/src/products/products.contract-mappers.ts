import { productVariants, products } from "@vem/db";
import {
  adminMediaAssetSummarySchema,
  adminProductResponseSchema,
  adminProductVariantResponseSchema,
  type AdminCreateProductRequest,
  type AdminCreateProductVariantRequest,
  type AdminMediaAssetSummary,
  type AdminProductResponse,
  type AdminProductVariantResponse,
  type AdminUpdateProductRequest,
  type AdminUpdateProductVariantRequest,
} from "@vem/shared";

type ProductInsert = typeof products.$inferInsert;
type ProductVariantInsert = typeof productVariants.$inferInsert;
type Patch<T> = { [K in keyof T]?: T[K] | undefined };
type ProductPatch = Patch<ProductInsert>;
type ProductVariantPatch = Patch<ProductVariantInsert>;
type ContractFieldCoverage<T> = Record<keyof T, unknown>;

type ProductResponseRow = Pick<
  typeof products.$inferSelect,
  | "id"
  | "name"
  | "categoryId"
  | "description"
  | "displayImageMediaAssetId"
  | "status"
  | "sortOrder"
  | "createdAt"
  | "updatedAt"
>;

type ProductVariantResponseRow = Pick<
  typeof productVariants.$inferSelect,
  | "id"
  | "productId"
  | "sku"
  | "size"
  | "color"
  | "barcode"
  | "priceCents"
  | "costCents"
  | "status"
  | "targetGender"
  | "tryOnSilhouetteMediaAssetId"
  | "createdAt"
  | "updatedAt"
>;

function toIsoString(value: Date): string {
  return value.toISOString();
}

function toTargetGender(
  value: string | null,
): AdminProductVariantResponse["targetGender"] {
  if (value === null) return null;
  if (value === "male") return "male";
  if (value === "female") return "female";
  throw new Error(`Unsupported product variant target gender: ${value}`);
}

export function mapCreateProductDtoToInsert(
  input: AdminCreateProductRequest,
): ProductInsert {
  const dto = {
    name: input.name,
    categoryId: input.categoryId,
    description: input.description,
    displayImageMediaAssetId: input.displayImageMediaAssetId,
    status: input.status,
    sortOrder: input.sortOrder,
  } satisfies ContractFieldCoverage<AdminCreateProductRequest>;

  const insert = {
    name: dto.name,
    categoryId: dto.categoryId ?? null,
    description: dto.description ?? null,
    displayImageMediaAssetId: dto.displayImageMediaAssetId ?? null,
    coverImageUrl: null,
    status: dto.status,
    sortOrder: dto.sortOrder,
  } satisfies ProductInsert;
  return insert;
}

export function mapUpdateProductDtoToPatch(
  input: AdminUpdateProductRequest,
): ProductPatch {
  const dto = {
    name: input.name,
    categoryId: input.categoryId,
    description: input.description,
    displayImageMediaAssetId: input.displayImageMediaAssetId,
    status: input.status,
    sortOrder: input.sortOrder,
  } satisfies ContractFieldCoverage<AdminUpdateProductRequest>;

  const patch = {
    name: dto.name,
    categoryId: dto.categoryId,
    description: dto.description,
    displayImageMediaAssetId: dto.displayImageMediaAssetId,
    coverImageUrl: "displayImageMediaAssetId" in input ? null : undefined,
    status: dto.status,
    sortOrder: dto.sortOrder,
    updatedAt: new Date(),
  } satisfies ProductPatch;
  return patch;
}

export function mapCreateVariantDtoToInsert(
  input: AdminCreateProductVariantRequest,
): ProductVariantInsert {
  const dto = {
    productId: input.productId,
    sku: input.sku,
    size: input.size,
    color: input.color,
    barcode: input.barcode,
    priceCents: input.priceCents,
    costCents: input.costCents,
    status: input.status,
    targetGender: input.targetGender,
    tryOnSilhouetteMediaAssetId: input.tryOnSilhouetteMediaAssetId,
  } satisfies ContractFieldCoverage<AdminCreateProductVariantRequest>;

  const insert = {
    productId: dto.productId,
    sku: dto.sku,
    size: dto.size ?? null,
    color: dto.color ?? null,
    barcode: dto.barcode ?? null,
    priceCents: dto.priceCents,
    costCents: dto.costCents ?? null,
    tryOnSilhouetteMediaAssetId: dto.tryOnSilhouetteMediaAssetId ?? null,
    status: dto.status,
    targetGender: dto.targetGender ?? null,
  } satisfies ProductVariantInsert;
  return insert;
}

export function mapUpdateVariantDtoToPatch(
  input: AdminUpdateProductVariantRequest,
): ProductVariantPatch {
  const dto = {
    productId: input.productId,
    sku: input.sku,
    size: input.size,
    color: input.color,
    barcode: input.barcode,
    priceCents: input.priceCents,
    costCents: input.costCents,
    status: input.status,
    targetGender: input.targetGender,
    tryOnSilhouetteMediaAssetId: input.tryOnSilhouetteMediaAssetId,
  } satisfies ContractFieldCoverage<AdminUpdateProductVariantRequest>;

  const patch = {
    productId: dto.productId,
    sku: dto.sku,
    size: dto.size,
    color: dto.color,
    barcode: dto.barcode,
    priceCents: dto.priceCents,
    costCents: dto.costCents,
    tryOnSilhouetteMediaAssetId: dto.tryOnSilhouetteMediaAssetId,
    status: dto.status,
    targetGender: dto.targetGender,
    updatedAt: new Date(),
  } satisfies ProductVariantPatch;
  return patch;
}

export function toAdminProductResponse(
  row: ProductResponseRow,
  displayImageMediaAsset: AdminMediaAssetSummary | null,
): AdminProductResponse {
  const response = {
    id: row.id,
    name: row.name,
    categoryId: row.categoryId,
    description: row.description,
    displayImageMediaAssetId: row.displayImageMediaAssetId,
    displayImageMediaAsset: displayImageMediaAsset
      ? adminMediaAssetSummarySchema.parse(displayImageMediaAsset)
      : null,
    status: row.status,
    sortOrder: row.sortOrder,
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
  } satisfies AdminProductResponse;
  return adminProductResponseSchema.parse(response);
}

export function toAdminProductVariantResponse(
  row: ProductVariantResponseRow,
  tryOnSilhouetteMediaAsset: AdminMediaAssetSummary | null,
): AdminProductVariantResponse {
  const response = {
    id: row.id,
    productId: row.productId,
    sku: row.sku,
    size: row.size,
    color: row.color,
    barcode: row.barcode,
    priceCents: row.priceCents,
    costCents: row.costCents,
    status: row.status,
    targetGender: toTargetGender(row.targetGender),
    tryOnSilhouetteMediaAssetId: row.tryOnSilhouetteMediaAssetId,
    tryOnSilhouetteMediaAsset: tryOnSilhouetteMediaAsset
      ? adminMediaAssetSummarySchema.parse(tryOnSilhouetteMediaAsset)
      : null,
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
  } satisfies AdminProductVariantResponse;
  return adminProductVariantResponseSchema.parse(response);
}
