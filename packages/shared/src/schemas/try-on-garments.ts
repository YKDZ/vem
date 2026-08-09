import { z } from "zod";

import { defineAdminEndpointContract } from "../admin-api-contract";
import {
  tryOnGarmentStatusSchema,
  tryOnGarmentTemplateSchema,
} from "../enums/catalog";

const noQuerySchema = z.strictObject({});
const noBodySchema = z.strictObject({});
const garmentPathParamsSchema = z.strictObject({ id: z.uuid() });

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
  // Multipart file bytes are validated by the upload endpoint after transport parsing.
  bodySchema: z.strictObject({ file: z.unknown() }),
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

export type TryOnGarmentMediaAsset = z.infer<
  typeof tryOnGarmentMediaAssetSchema
>;
export type TryOnGarmentDraftRequest = z.infer<
  typeof tryOnGarmentDraftRequestSchema
>;
export type TryOnGarmentResponse = z.infer<typeof tryOnGarmentResponseSchema>;
