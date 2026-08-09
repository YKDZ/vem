import { z } from "zod";

export const managedMediaPurposeSchema = z.enum([
  "product_display_image",
  "try_on_garment",
]);

export const managedMediaContentTypeSchema = z.enum([
  "image/png",
  "image/jpeg",
  "image/webp",
]);

/** Immutable facts needed by a machine to materialize trusted media. */
export const managedMediaDescriptorSchema = z
  .strictObject({
    id: z.uuid(),
    reference: z.string().regex(/^\/api\/media-assets\/[0-9a-f-]+\/content$/i),
    digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    contentType: managedMediaContentTypeSchema,
    byteSize: z.int().positive(),
    purpose: managedMediaPurposeSchema,
    revision: z.strictObject({
      catalogRevision: z.string().min(1).max(128),
      assetRevision: z.string().min(1).max(128).optional(),
    }),
  })
  .superRefine((descriptor, context) => {
    const referencedId = /\/media-assets\/([0-9a-f-]+)\/content$/i.exec(
      descriptor.reference,
    )?.[1];
    if (referencedId?.toLowerCase() !== descriptor.id.toLowerCase()) {
      context.addIssue({
        code: "custom",
        path: ["reference"],
        message: "managed media reference must identify the descriptor id",
      });
    }
  });

export type ManagedMediaDescriptor = z.infer<
  typeof managedMediaDescriptorSchema
>;

export const managedMediaReadinessSchema = z.enum([
  "ready",
  "warming",
  "unavailable",
]);

export const managedMediaDiagnosticReasonSchema = z.enum([
  "descriptor_invalid",
  "cache_budget_exceeded",
  "manifest_persistence_failed",
  "download_failed",
  "byte_size_mismatch",
  "content_type_mismatch",
  "media_facts_invalid",
  "digest_mismatch",
  "published_media_corrupt",
  "defensive_read_failed",
]);

export const managedMediaLoopbackUrlSchema = z
  .string()
  .regex(
    /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::(?:[1-9][0-9]{0,4}))?\/media\/sha256:[0-9a-f]{64}\?grant=[A-Za-z0-9._~-]{16,128}$/,
  );

/** The complete generation-scoped media interest set accepted by the daemon. */
export const daemonIpcManagedMediaReconcileRequestSchema = z.strictObject({
  generation: z.string().min(1).max(128),
  interests: z.array(managedMediaDescriptorSchema).max(256),
});

export type DaemonIpcManagedMediaReconcileRequest = z.infer<
  typeof daemonIpcManagedMediaReconcileRequestSchema
>;

export const managedMediaProjectionSchema = z.strictObject({
  descriptor: managedMediaDescriptorSchema,
  readiness: managedMediaReadinessSchema,
  readyUrl: managedMediaLoopbackUrlSchema.nullable(),
  diagnostic: z.string().nullable(),
  diagnosticReason: managedMediaDiagnosticReasonSchema.nullable().optional(),
});

export const daemonIpcManagedMediaProjectionSchema =
  managedMediaProjectionSchema;

export const daemonIpcManagedMediaSnapshotSchema = z.strictObject({
  generation: z.string().min(1).max(128),
  assets: z.array(daemonIpcManagedMediaProjectionSchema).max(256),
});

export const daemonIpcManagedMediaReconcileReceiptSchema = z.strictObject({
  generation: z.string().min(1).max(128),
  accepted: z.literal(true),
  interestCount: z.number().int().nonnegative().max(256),
  snapshot: daemonIpcManagedMediaSnapshotSchema,
});

export type DaemonIpcManagedMediaProjection = z.infer<
  typeof daemonIpcManagedMediaProjectionSchema
>;
export type DaemonIpcManagedMediaSnapshot = z.infer<
  typeof daemonIpcManagedMediaSnapshotSchema
>;
export type DaemonIpcManagedMediaReconcileReceipt = z.infer<
  typeof daemonIpcManagedMediaReconcileReceiptSchema
>;

/** Structural generation root; every public managed-media DTO is reachable. */
export const daemonIpcManagedMediaContractSchema = z.strictObject({
  reconcileRequest: daemonIpcManagedMediaReconcileRequestSchema,
  reconcileReceipt: daemonIpcManagedMediaReconcileReceiptSchema,
  projection: daemonIpcManagedMediaProjectionSchema,
  snapshot: daemonIpcManagedMediaSnapshotSchema,
});

export type ManagedMediaProjection = z.infer<
  typeof managedMediaProjectionSchema
>;
