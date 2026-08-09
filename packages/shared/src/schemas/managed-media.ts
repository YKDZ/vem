import { z } from "zod";

export const managedMediaPurposeSchema = z.enum([
  "product_display_image",
  "try_on_garment",
]);

/** Immutable facts needed by a machine to materialize trusted media. */
export const managedMediaDescriptorSchema = z
  .strictObject({
    id: z.uuid(),
    reference: z.string().regex(/^\/api\/media-assets\/[0-9a-f-]+\/content$/i),
    digest: z.string().regex(/^sha256:[0-9a-f]{64}$/i),
    contentType: z.string().min(1).max(128),
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

export const managedMediaProjectionSchema = z.strictObject({
  descriptor: managedMediaDescriptorSchema,
  readiness: managedMediaReadinessSchema,
  readyUrl: z.url().nullable(),
  diagnostic: z.string().nullable(),
});

export type ManagedMediaProjection = z.infer<
  typeof managedMediaProjectionSchema
>;
