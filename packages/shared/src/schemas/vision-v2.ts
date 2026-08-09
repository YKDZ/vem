import { z } from "zod";

export const VISION_V2_PROTOCOL = "vem.vision.v2" as const;
export const VISION_V2_BUNDLE_VERSION = "1" as const;

const sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/);
const sha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const attemptIdSchema = z.uuid();
const tokenizedLoopbackUrlPattern =
  /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::[0-9]{1,5})?(?:\/[^?#]*)?\?(?:[^#&]*&)*token=[^&#]+(?:&[^#]*)?$/;

function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      ["127.0.0.1", "localhost", "[::1]", "::1"].includes(
        url.hostname.toLowerCase(),
      ) &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

const tokenizedLoopbackUrlSchema = z
  .string()
  .regex(tokenizedLoopbackUrlPattern)
  .refine(isLoopbackUrl, "reference must be a loopback URL")
  .refine(
    (value) => (new URL(value).searchParams.get("token") ?? "").length > 0,
    "reference must contain a non-empty opaque token",
  );

export const visionV2GarmentSourceSchema = z.strictObject({
  assetId: z.uuid(),
  reference: tokenizedLoopbackUrlSchema,
  digest: sha256DigestSchema,
  contentType: z.literal("image/png"),
  byteSize: z.int().positive(),
  template: z.enum(["tshirt_short_sleeve", "tshirt_long_sleeve"]),
});

export const visionV2ResultReferenceSchema = z.strictObject({
  reference: tokenizedLoopbackUrlSchema,
  digest: sha256DigestSchema,
  contentType: z.literal("image/png"),
  byteSize: z.int().positive(),
  width: z.int().positive(),
  height: z.int().positive(),
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
    attemptId: attemptIdSchema,
    mode: z.literal("fast"),
    variantId: z.uuid(),
    garment: visionV2GarmentSourceSchema,
  }),
});

export const visionV2AttemptAcceptedMessageSchema = envelopeBaseSchema.extend({
  type: z.literal("vision.try_on.attempt.accepted"),
  payload: z.strictObject({
    attemptId: attemptIdSchema,
    mode: z.literal("fast"),
  }),
});

export const visionV2AttemptProgressMessageSchema = envelopeBaseSchema.extend({
  type: z.literal("vision.try_on.attempt.progress"),
  payload: z.strictObject({
    attemptId: attemptIdSchema,
    stage: z.literal("generating"),
  }),
});

export const visionV2AttemptCompletedMessageSchema = envelopeBaseSchema.extend({
  type: z.literal("vision.try_on.attempt.completed"),
  payload: z.strictObject({
    attemptId: attemptIdSchema,
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
