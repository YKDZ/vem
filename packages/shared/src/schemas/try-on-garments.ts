import { z } from "zod";

import {
  adminMultipartFileSchema,
  defineAdminEndpointContract,
} from "../admin-api-contract";
import {
  tryOnGarmentStatusSchema,
  tryOnGarmentTemplateSchema,
} from "../enums/catalog";

const noQuerySchema = z.strictObject({});
const noBodySchema = z.strictObject({});
const garmentPathParamsSchema = z.strictObject({ id: z.uuid() });
const garmentListQuerySchema = z.strictObject({ productId: z.uuid() });

/**
 * The upload operation is transported as multipart in the browser and is
 * represented by Multer's file object at the Service API boundary.  Keep the
 * two transport representations in one contract rather than making the
 * request body an unconstrained unknown value.
 */
export const tryOnGarmentMediaAssetSchema = z.strictObject({
  id: z.uuid(),
  managedReference: z
    .string()
    .regex(/^\/api\/media-assets\/[0-9a-f-]+\/content$/i),
  purpose: z.literal("try_on_garment"),
  contentType: z.literal("image/png"),
  byteSize: z.int().positive(),
  width: z.int().positive(),
  height: z.int().positive(),
  hasTransparency: z.literal(true),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i),
});

export const tryOnGarmentDraftRequestSchema = z.strictObject({
  productId: z.uuid(),
  colorLabel: z.string().trim().min(1).max(32),
  sourceMediaAssetId: z.uuid(),
  template: tryOnGarmentTemplateSchema,
});

/** Association, not product metadata, is the sole eligibility authority. */
export const tryOnGarmentVariantAssociationRequestSchema = z.strictObject({
  variantIds: z.array(z.uuid()).max(256),
});

export const tryOnGarmentSourceReplacementRequestSchema = z.strictObject({
  sourceMediaAssetId: z.uuid(),
  template: tryOnGarmentTemplateSchema,
});

export const tryOnGarmentResponseSchema = z.strictObject({
  id: z.uuid(),
  productId: z.uuid(),
  colorLabel: z.string().min(1).max(32),
  sourceMediaAsset: tryOnGarmentMediaAssetSchema,
  template: tryOnGarmentTemplateSchema,
  status: tryOnGarmentStatusSchema,
  /** Bounded UI impact list; absence means no explicit eligibility. */
  associatedVariantIds: z.array(z.uuid()).max(256).default([]),
  confirmedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
});
export const tryOnGarmentListResponseSchema = z
  .array(tryOnGarmentResponseSchema)
  .max(256);

export const adminTryOnGarmentUploadContract = defineAdminEndpointContract({
  method: "POST",
  path: "/media-assets/try-on-garments",
  pathParamsSchema: z.strictObject({}),
  querySchema: noQuerySchema,
  bodySchema: z.strictObject({ file: adminMultipartFileSchema }),
  responseSchema: tryOnGarmentMediaAssetSchema,
});

export const adminCreateTryOnGarmentContract = defineAdminEndpointContract({
  method: "POST",
  path: "/try-on-garments",
  pathParamsSchema: z.strictObject({}),
  querySchema: noQuerySchema,
  bodySchema: tryOnGarmentDraftRequestSchema,
  responseSchema: tryOnGarmentResponseSchema,
});

export const adminGetTryOnGarmentContract = defineAdminEndpointContract({
  method: "GET",
  path: "/try-on-garments/:id",
  pathParamsSchema: garmentPathParamsSchema,
  querySchema: noQuerySchema,
  bodySchema: noBodySchema,
  responseSchema: tryOnGarmentResponseSchema,
});

/** Product management rehydrates its shared sources from the server, rather
 * than treating a closed modal as the source of truth. */
export const adminListTryOnGarmentsByProductContract =
  defineAdminEndpointContract({
    method: "GET",
    path: "/try-on-garments",
    pathParamsSchema: z.strictObject({}),
    querySchema: garmentListQuerySchema,
    bodySchema: noBodySchema,
    responseSchema: tryOnGarmentListResponseSchema,
  });

export const adminTryOnGarmentConfirmationContract =
  defineAdminEndpointContract({
    method: "POST",
    path: "/try-on-garments/:id/confirmation",
    pathParamsSchema: garmentPathParamsSchema,
    querySchema: noQuerySchema,
    bodySchema: noBodySchema,
    responseSchema: tryOnGarmentResponseSchema,
  });

/** Activating is distinct from source confirmation: only a confirmed draft
 * may become eligible through an explicit association. */
export const adminTryOnGarmentActivationContract = defineAdminEndpointContract({
  method: "POST",
  path: "/try-on-garments/:id/activation",
  pathParamsSchema: garmentPathParamsSchema,
  querySchema: noQuerySchema,
  bodySchema: noBodySchema,
  responseSchema: tryOnGarmentResponseSchema,
});

export const adminTryOnGarmentRetirementContract = defineAdminEndpointContract({
  method: "POST",
  path: "/try-on-garments/:id/retirement",
  pathParamsSchema: garmentPathParamsSchema,
  querySchema: noQuerySchema,
  bodySchema: noBodySchema,
  responseSchema: tryOnGarmentResponseSchema,
});

export const adminTryOnGarmentAssociationContract = defineAdminEndpointContract(
  {
    method: "PUT",
    path: "/try-on-garments/:id/variant-associations",
    pathParamsSchema: garmentPathParamsSchema,
    querySchema: noQuerySchema,
    bodySchema: tryOnGarmentVariantAssociationRequestSchema,
    responseSchema: tryOnGarmentResponseSchema,
  },
);

export const adminTryOnGarmentSourceReplacementContract =
  defineAdminEndpointContract({
    method: "PATCH",
    path: "/try-on-garments/:id/source",
    pathParamsSchema: garmentPathParamsSchema,
    querySchema: noQuerySchema,
    bodySchema: tryOnGarmentSourceReplacementRequestSchema,
    responseSchema: tryOnGarmentResponseSchema,
  });

export type TryOnGarmentMediaAsset = z.infer<
  typeof tryOnGarmentMediaAssetSchema
>;
export type TryOnGarmentDraftRequest = z.infer<
  typeof tryOnGarmentDraftRequestSchema
>;
export type TryOnGarmentVariantAssociationRequest = z.infer<
  typeof tryOnGarmentVariantAssociationRequestSchema
>;
export type TryOnGarmentSourceReplacementRequest = z.infer<
  typeof tryOnGarmentSourceReplacementRequestSchema
>;
export type TryOnGarmentListQuery = z.infer<typeof garmentListQuerySchema>;
export type TryOnGarmentResponse = z.infer<typeof tryOnGarmentResponseSchema>;
