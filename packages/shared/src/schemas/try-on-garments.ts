import { z } from "zod";

import { defineAdminEndpointContract } from "../admin-api-contract";
import {
  tryOnGarmentStatusSchema,
  tryOnGarmentTemplateSchema,
} from "../enums/catalog";

const noQuerySchema = z.strictObject({});
const noBodySchema = z.strictObject({});
const garmentPathParamsSchema = z.strictObject({ id: z.uuid() });

/**
 * The upload operation is transported as multipart in the browser and is
 * represented by Multer's file object at the Service API boundary.  Keep the
 * two transport representations in one contract rather than making the
 * request body an unconstrained unknown value.
 */
export type AdminMultipartFile =
  | Blob
  | {
      originalname: string;
      mimetype: string;
      size: number;
      buffer: Uint8Array;
    };

export const adminMultipartFileSchema = z.custom<AdminMultipartFile>(
  (value) => {
    if (typeof Blob !== "undefined" && value instanceof Blob) return true;
    if (!isRecord(value)) return false;
    const candidate = value;
    return (
      typeof candidate.originalname === "string" &&
      typeof candidate.mimetype === "string" &&
      typeof candidate.size === "number" &&
      Number.isInteger(candidate.size) &&
      candidate.size >= 0 &&
      candidate.buffer instanceof Uint8Array
    );
  },
  "a multipart file is required",
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

export const tryOnGarmentResponseSchema = z.strictObject({
  id: z.uuid(),
  productId: z.uuid(),
  colorLabel: z.string().min(1).max(32),
  sourceMediaAsset: tryOnGarmentMediaAssetSchema,
  template: tryOnGarmentTemplateSchema,
  status: tryOnGarmentStatusSchema,
  confirmedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
});

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
export const adminTryOnGarmentActivationContract =
  defineAdminEndpointContract({
    method: "POST",
    path: "/try-on-garments/:id/activation",
    pathParamsSchema: garmentPathParamsSchema,
    querySchema: noQuerySchema,
    bodySchema: noBodySchema,
    responseSchema: tryOnGarmentResponseSchema,
  });

export const adminTryOnGarmentRetirementContract =
  defineAdminEndpointContract({
    method: "POST",
    path: "/try-on-garments/:id/retirement",
    pathParamsSchema: garmentPathParamsSchema,
    querySchema: noQuerySchema,
    bodySchema: noBodySchema,
    responseSchema: tryOnGarmentResponseSchema,
  });

export type TryOnGarmentMediaAsset = z.infer<
  typeof tryOnGarmentMediaAssetSchema
>;
export type TryOnGarmentDraftRequest = z.infer<
  typeof tryOnGarmentDraftRequestSchema
>;
export type TryOnGarmentResponse = z.infer<typeof tryOnGarmentResponseSchema>;
