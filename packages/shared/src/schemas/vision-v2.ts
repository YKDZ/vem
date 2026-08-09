import { z } from "zod";

export const VISION_V2_PROTOCOL = "vem.vision.v2" as const;
export const VISION_V2_BUNDLE_VERSION = "1" as const;

const sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/);
const sha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const nonSentinelUuidSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
const maximumBinaryBytes = 64 * 1024 * 1024;
const maximumImageDimension = 8192;
const tokenizedLoopbackUrlPattern =
  /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::(?:[1-9]\d{0,3}|[1-5]\d{4}|6[0-4]\d{3}|65[0-4]\d|655[0-2]\d|6553[0-5]))?(?:\/[^?#]*)?\?(?:[^#&]*&)*token=[^&#]+(?:&[^#]*)?$/;

function validateTokenizedLoopbackUrl(
  value: string,
  ctx: z.RefinementCtx,
): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    ctx.addIssue({
      code: "custom",
      message: "reference must be a valid loopback URL",
    });
    return;
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !["127.0.0.1", "localhost", "[::1]", "::1"].includes(
      url.hostname.toLowerCase(),
    ) ||
    url.username !== "" ||
    url.password !== ""
  ) {
    ctx.addIssue({
      code: "custom",
      message: "reference must be a loopback URL",
    });
  }
  if ((url.searchParams.get("token") ?? "").length === 0) {
    ctx.addIssue({
      code: "custom",
      message: "reference must contain a non-empty opaque token",
    });
  }
}

const tokenizedLoopbackUrlSchema = z
  .string()
  .regex(tokenizedLoopbackUrlPattern)
  .describe("vem.tokenized-loopback-url")
  .superRefine(validateTokenizedLoopbackUrl);

export const visionV2GarmentSourceSchema = z.strictObject({
  assetId: nonSentinelUuidSchema,
  reference: tokenizedLoopbackUrlSchema,
  digest: sha256DigestSchema,
  contentType: z.literal("image/png"),
  byteSize: z.int().positive().max(maximumBinaryBytes),
  template: z.enum(["tshirt_short_sleeve", "tshirt_long_sleeve"]),
});

export const visionV2ResultReferenceSchema = z.strictObject({
  reference: tokenizedLoopbackUrlSchema,
  digest: sha256DigestSchema,
  contentType: z.literal("image/png"),
  byteSize: z.int().positive().max(maximumBinaryBytes),
  width: z.int().positive().max(maximumImageDimension),
  height: z.int().positive().max(maximumImageDimension),
});

const envelopeBaseSchema = z.strictObject({
  protocol: z.literal(VISION_V2_PROTOCOL),
  messageId: z.string().min(1).max(128),
  timestamp: z.iso.datetime(),
});

export const visionV2HelloMessageSchema = envelopeBaseSchema.extend({
  type: z.literal("vision.hello"),
  payload: z.strictObject({
    clientRole: z.literal("machine"),
    machineCode: z.string().min(1).max(64).optional(),
    contractDigest: sha256HexSchema,
    capabilities: z.array(z.string().min(1).max(64)).max(32),
  }),
});

export const visionV2ReadyMessageSchema = envelopeBaseSchema.extend({
  type: z.literal("vision.ready"),
  payload: z.strictObject({
    serverName: z.string().min(1).max(128),
    serverVersion: z.string().min(1).max(64),
    contractDigest: sha256HexSchema,
    cameraReady: z.boolean(),
    fastReady: z.boolean(),
    visionBusinessReady: z.boolean(),
    capabilities: z.array(z.string().min(1).max(64)).max(32),
  }),
});

export const visionV2FastAttemptStartMessageSchema = envelopeBaseSchema.extend({
  type: z.literal("vision.try_on.attempt.start"),
  payload: z.strictObject({
    attemptId: nonSentinelUuidSchema,
    mode: z.literal("fast"),
    variantId: nonSentinelUuidSchema,
    garment: visionV2GarmentSourceSchema,
  }),
});

export const visionV2AttemptAcceptedMessageSchema = envelopeBaseSchema.extend({
  type: z.literal("vision.try_on.attempt.accepted"),
  payload: z.strictObject({
    attemptId: nonSentinelUuidSchema,
    mode: z.literal("fast"),
  }),
});

export const visionV2AttemptProgressMessageSchema = envelopeBaseSchema.extend({
  type: z.literal("vision.try_on.attempt.progress"),
  payload: z.strictObject({
    attemptId: nonSentinelUuidSchema,
    stage: z.literal("generating"),
  }),
});

export const visionV2AttemptCompletedMessageSchema = envelopeBaseSchema.extend({
  type: z.literal("vision.try_on.attempt.completed"),
  payload: z.strictObject({
    attemptId: nonSentinelUuidSchema,
    result: visionV2ResultReferenceSchema,
  }),
});

export const visionV2MessageSchema = z.discriminatedUnion("type", [
  visionV2HelloMessageSchema,
  visionV2ReadyMessageSchema,
  visionV2FastAttemptStartMessageSchema,
  visionV2AttemptAcceptedMessageSchema,
  visionV2AttemptProgressMessageSchema,
  visionV2AttemptCompletedMessageSchema,
]);

export type VisionV2Message = z.infer<typeof visionV2MessageSchema>;
