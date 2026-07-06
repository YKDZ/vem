import {
  adminProductResponseSchema,
  adminProductVariantResponseSchema,
  createProductSchema,
  createProductVariantSchema,
  type AdminCreateProductRequest,
  type AdminCreateProductVariantRequest,
  type AdminProductResponse,
  type AdminProductVariantResponse,
  type ProductStatus,
  type VariantStatus,
} from "@vem/shared";
import { z } from "zod";

export type ProductForm = {
  name: string;
  description: string;
  displayImageMediaAssetId: string | null;
  displayImagePublicUrl: string | null;
  status: ProductStatus;
  sortOrder: number;
};

export type VariantForm = {
  productId: string;
  sku: string;
  priceCents: number;
  costCents: number | null;
  status: VariantStatus;
  size: string;
  color: string;
  barcode: string;
  targetGender: "male" | "female" | null;
  tryOnSilhouetteMediaAssetId: string | null;
  tryOnSilhouettePublicUrl: string | null;
};

function emptyStringToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

const productFormSchema = z.strictObject({
  name: z.string(),
  description: z.string(),
  displayImageMediaAssetId: z.string().nullable(),
  displayImagePublicUrl: z.string().nullable(),
  status: z.enum(["draft", "active", "inactive"]),
  sortOrder: z.number(),
});

const variantFormSchema = z.strictObject({
  productId: z.string(),
  sku: z.string(),
  priceCents: z.number(),
  costCents: z.number().nullable(),
  status: z.enum(["active", "inactive"]),
  size: z.string(),
  color: z.string(),
  barcode: z.string(),
  targetGender: z.enum(["male", "female"]).nullable(),
  tryOnSilhouetteMediaAssetId: z.string().nullable(),
  tryOnSilhouettePublicUrl: z.string().nullable(),
});

export function mapProductFormToContract(
  form: ProductForm,
): AdminCreateProductRequest {
  const parsedForm = productFormSchema.parse(form);
  const contract = {
    name: parsedForm.name,
    description: emptyStringToNull(parsedForm.description),
    displayImageMediaAssetId: parsedForm.displayImageMediaAssetId,
    status: parsedForm.status,
    sortOrder: parsedForm.sortOrder,
  } satisfies AdminCreateProductRequest;
  return createProductSchema.parse(contract);
}

export function mapVariantFormToContract(
  form: VariantForm,
): AdminCreateProductVariantRequest {
  const parsedForm = variantFormSchema.parse(form);
  const contract = {
    productId: parsedForm.productId,
    sku: parsedForm.sku,
    priceCents: parsedForm.priceCents,
    costCents: parsedForm.costCents,
    status: parsedForm.status,
    size: emptyStringToNull(parsedForm.size),
    color: emptyStringToNull(parsedForm.color),
    barcode: emptyStringToNull(parsedForm.barcode),
    targetGender: parsedForm.targetGender,
    tryOnSilhouetteMediaAssetId: parsedForm.tryOnSilhouetteMediaAssetId,
  } satisfies AdminCreateProductVariantRequest;
  return createProductVariantSchema.parse(contract);
}

export function mapProductResponseToForm(
  product: AdminProductResponse,
): ProductForm {
  const parsed = adminProductResponseSchema.parse(product);
  return {
    name: parsed.name,
    description: parsed.description ?? "",
    displayImageMediaAssetId: parsed.displayImageMediaAssetId,
    displayImagePublicUrl: parsed.displayImageMediaAsset?.publicUrl ?? null,
    status: parsed.status,
    sortOrder: parsed.sortOrder,
  };
}

export function mapVariantResponseToForm(
  variant: AdminProductVariantResponse,
): VariantForm {
  const parsed = adminProductVariantResponseSchema.parse(variant);
  return {
    productId: parsed.productId,
    sku: parsed.sku,
    priceCents: parsed.priceCents,
    costCents: parsed.costCents,
    status: parsed.status,
    size: parsed.size ?? "",
    color: parsed.color ?? "",
    barcode: parsed.barcode ?? "",
    targetGender: parsed.targetGender,
    tryOnSilhouetteMediaAssetId: parsed.tryOnSilhouetteMediaAssetId,
    tryOnSilhouettePublicUrl:
      parsed.tryOnSilhouetteMediaAsset?.publicUrl ?? null,
  };
}
