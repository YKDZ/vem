import { z } from "zod";

export const VISION_V2_PROTOCOL = "vem.vision.v2" as const;
export const VISION_V2_BUNDLE_VERSION = "1" as const;
export const VISION_V2_BUNDLE_SCHEMA_VERSION =
  "vem-vision-v2-contract-bundle/v1" as const;

export const visionV2BusinessReadinessDiagnosticSchema = z.enum([
  "ready",
  "camera_unavailable",
  "contract_digest_mismatch",
  "contract_version_mismatch",
  "contract_bundle_unavailable",
]);

export const visionV2AiReadinessDiagnosticSchema = z.enum([
  "ready",
  "model_pack_missing",
  "model_pack_invalid",
  "worker_unavailable",
]);
export type VisionV2AiReadinessDiagnostic = z.infer<
  typeof visionV2AiReadinessDiagnosticSchema
>;

const sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/);
const sha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const nonSentinelUuidSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
const maximumBinaryBytes = 64 * 1024 * 1024;
const maximumImageDimension = 8192;
const maximumTokenizedLoopbackUrlLength = 2048;
const tokenizedLoopbackTokenPattern = /^[A-Za-z0-9_-]{1,128}(?![\s\S])/;
const tokenizedLoopbackHttpUrlPattern =
  /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::(?:[1-9]\d{0,3}|[1-5]\d{4}|6[0-4]\d{3}|65[0-4]\d{2}|655[0-2]\d|6553[0-5]))?(?:\/[^?#]*)?\?token=[A-Za-z0-9_-]{1,128}(?![\s\S])/;
const visionV2AcquisitionPreviewUrlPattern =
  /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::(?:[1-9]\d{0,3}|[1-5]\d{4}|6[0-4]\d{3}|65[0-4]\d{2}|655[0-2]\d|6553[0-5]))?\/v2\/try-on\/acquisition\/preview\.mjpeg\?token=[A-Za-z0-9_-]{1,128}(?![\s\S])/;

/**
 * JSON Schema measures string length in Unicode code points. JavaScript's
 * built-in Zod string checks measure UTF-16 code units, so use the iterator
 * here to keep the authored schema, standalone JSON Schema, Python, and Rust
 * on one wire-length rule.
 */
function codePointString({
  minimum,
  maximum,
}: {
  minimum?: number;
  maximum?: number;
}) {
  return z
    .string()
    .superRefine((value, ctx) => {
      const length = Array.from(value).length;
      if (minimum !== undefined && length < minimum) {
        ctx.addIssue({
          code: "custom",
          message: `expected at least ${minimum} Unicode code points`,
        });
      }
      if (maximum !== undefined && length > maximum) {
        ctx.addIssue({
          code: "custom",
          message: `expected at most ${maximum} Unicode code points`,
        });
      }
    })
    .meta({
      ...(minimum === undefined ? {} : { minLength: minimum }),
      ...(maximum === undefined ? {} : { maxLength: maximum }),
    });
}

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
    url.protocol !== "http:" ||
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
  const token = url.search.slice("?token=".length);
  if (
    url.hash !== "" ||
    !url.search.startsWith("?token=") ||
    url.search.includes("&") ||
    !tokenizedLoopbackTokenPattern.test(token)
  ) {
    ctx.addIssue({
      code: "custom",
      message: "reference must contain a non-empty opaque token",
    });
  }
}

function tokenizedLoopbackUrlSchema() {
  return codePointString({
    maximum: maximumTokenizedLoopbackUrlLength,
  })
    .regex(tokenizedLoopbackHttpUrlPattern)
    .describe("vem.tokenized-loopback-url")
    .superRefine((value, context) => {
      validateTokenizedLoopbackUrl(value, context);
    });
}

function acquisitionPreviewReferenceSchema() {
  return codePointString({ maximum: maximumTokenizedLoopbackUrlLength })
    .regex(visionV2AcquisitionPreviewUrlPattern)
    .describe("vem.vision-v2-acquisition-preview-url")
    .superRefine(validateTokenizedLoopbackUrl);
}

export const visionV2AcquisitionPreviewSchema = z.strictObject({
  reference: acquisitionPreviewReferenceSchema(),
  streamType: z.literal("mjpeg"),
});

export const visionV2GarmentSourceSchema = z.strictObject({
  assetId: nonSentinelUuidSchema,
  reference: tokenizedLoopbackUrlSchema(),
  digest: sha256DigestSchema,
  contentType: z.literal("image/png"),
  byteSize: z.int().positive().max(maximumBinaryBytes),
  template: z.enum(["tshirt_short_sleeve", "tshirt_long_sleeve"]),
});

export const visionV2ResultReferenceSchema = z.strictObject({
  reference: tokenizedLoopbackUrlSchema(),
  digest: sha256DigestSchema,
  contentType: z.literal("image/png"),
  byteSize: z.int().positive().max(maximumBinaryBytes),
  width: z.int().positive().max(maximumImageDimension),
  height: z.int().positive().max(maximumImageDimension),
});

const envelopeBaseSchema = z.strictObject({
  protocol: z.literal(VISION_V2_PROTOCOL),
  messageId: codePointString({ minimum: 1, maximum: 128 }),
  timestamp: z.iso.datetime(),
});

export const visionV2HelloMessageSchema = envelopeBaseSchema.extend({
  type: z.literal("vision.hello"),
  payload: z.strictObject({
    clientRole: z.literal("machine"),
    machineCode: codePointString({ minimum: 1, maximum: 64 }).optional(),
    schemaVersion: codePointString({ minimum: 1, maximum: 128 }),
    bundleVersion: codePointString({ minimum: 1, maximum: 64 }),
    contractDigest: sha256HexSchema,
    capabilities: z.array(codePointString({ minimum: 1, maximum: 64 })).max(32),
  }),
});

export const visionV2ReadyMessageSchema = envelopeBaseSchema.extend({
  type: z.literal("vision.ready"),
  payload: z.strictObject({
    serverName: codePointString({ minimum: 1, maximum: 128 }),
    serverVersion: codePointString({ minimum: 1, maximum: 64 }),
    schemaVersion: codePointString({ minimum: 1, maximum: 128 }),
    bundleVersion: codePointString({ minimum: 1, maximum: 64 }),
    contractDigest: sha256HexSchema,
    cameraReady: z.boolean(),
    fastReady: z.boolean(),
    // AI readiness is independent: an unavailable model pack must never
    // remove Fast or ordinary sale capability.
    aiReady: z.boolean().default(false),
    aiReadinessDiagnostic: visionV2AiReadinessDiagnosticSchema,
    visionBusinessReady: z.boolean(),
    businessReadinessDiagnostic: visionV2BusinessReadinessDiagnosticSchema,
    capabilities: z.array(codePointString({ minimum: 1, maximum: 64 })).max(32),
  }),
});

export const visionV2AttemptStartMessageSchema = envelopeBaseSchema.extend({
  type: z.literal("vision.try_on.attempt.start"),
  payload: z.strictObject({
    attemptId: nonSentinelUuidSchema,
    mode: z.enum(["fast", "ai"]),
    variantId: nonSentinelUuidSchema,
    garment: visionV2GarmentSourceSchema,
  }),
});

export const visionV2AttemptAcceptedMessageSchema = envelopeBaseSchema.extend({
  type: z.literal("vision.try_on.attempt.accepted"),
  payload: z.strictObject({
    attemptId: nonSentinelUuidSchema,
    mode: z.enum(["fast", "ai"]),
  }),
});

export const visionV2AttemptCaptureMessageSchema = envelopeBaseSchema.extend({
  type: z.literal("vision.try_on.attempt.capture"),
  payload: z.strictObject({
    attemptId: nonSentinelUuidSchema,
  }),
});

export const visionV2AttemptCancelMessageSchema = envelopeBaseSchema.extend({
  type: z.literal("vision.try_on.attempt.cancel"),
  payload: z.strictObject({
    attemptId: nonSentinelUuidSchema,
    reason: z.enum(["user", "route_leave"]),
  }),
});

const acquiringPayloadBase = {
  attemptId: nonSentinelUuidSchema,
  preview: visionV2AcquisitionPreviewSchema,
};

/** Enumerated on-wire truth table, shared identically by Zod, JSON Schema and Python. */
const visionV2AttemptAcquiringPayloadSchema = z.union([
  z.strictObject({
    ...acquiringPayloadBase,
    occupancy: z.literal("none"),
    guidance: z.literal("no_person"),
    manualCaptureAllowed: z.literal(false),
  }),
  z.strictObject({
    ...acquiringPayloadBase,
    occupancy: z.literal("multiple"),
    guidance: z.literal("multiple_people"),
    manualCaptureAllowed: z.literal(false),
  }),
  z.strictObject({
    ...acquiringPayloadBase,
    occupancy: z.literal("single"),
    guidance: z.literal("align"),
    manualCaptureAllowed: z.literal(false),
  }),
  z.strictObject({
    ...acquiringPayloadBase,
    occupancy: z.literal("single"),
    guidance: z.literal("hold_still"),
    manualCaptureAllowed: z.literal(true),
  }),
  z.strictObject({
    ...acquiringPayloadBase,
    occupancy: z.literal("single"),
    guidance: z.literal("ready"),
    manualCaptureAllowed: z.literal(false),
  }),
]);

export const visionV2AttemptAcquiringMessageSchema = envelopeBaseSchema.extend({
  type: z.literal("vision.try_on.attempt.acquiring"),
  payload: visionV2AttemptAcquiringPayloadSchema,
});

export const visionV2AttemptGeneratingMessageSchema = envelopeBaseSchema.extend(
  {
    type: z.literal("vision.try_on.attempt.generating"),
    payload: z.strictObject({
      attemptId: nonSentinelUuidSchema,
      stage: z.enum([
        "preparing",
        "loading_model",
        "generating",
        "validating_result",
        "rendering",
      ]),
    }),
  },
);

export const visionV2AttemptCompletedMessageSchema = envelopeBaseSchema.extend({
  type: z.literal("vision.try_on.attempt.completed"),
  payload: z.strictObject({
    attemptId: nonSentinelUuidSchema,
    result: visionV2ResultReferenceSchema,
  }),
});

export const visionV2AttemptFailedMessageSchema = envelopeBaseSchema.extend({
  type: z.literal("vision.try_on.attempt.failed"),
  payload: z.strictObject({
    attemptId: nonSentinelUuidSchema,
    reason: z.enum([
      "garment_rejected",
      "fast_failed",
      "fast_unavailable",
      "ai_failed",
      "ai_unavailable",
      "ai_model_pack_invalid",
    ]),
  }),
});

export const visionV2AttemptCanceledMessageSchema = envelopeBaseSchema.extend({
  type: z.literal("vision.try_on.attempt.canceled"),
  payload: z.strictObject({
    attemptId: nonSentinelUuidSchema,
    reason: z.enum([
      "user",
      "route_leave",
      "disconnect",
      "departure",
      "replaced",
      "timeout",
    ]),
  }),
});

export const visionV2ClientMessageSchema = z.discriminatedUnion("type", [
  visionV2HelloMessageSchema,
  visionV2AttemptStartMessageSchema,
  visionV2AttemptCaptureMessageSchema,
  visionV2AttemptCancelMessageSchema,
]);

export const visionV2ServerMessageSchema = z.discriminatedUnion("type", [
  visionV2ReadyMessageSchema,
  visionV2AttemptAcceptedMessageSchema,
  visionV2AttemptAcquiringMessageSchema,
  visionV2AttemptGeneratingMessageSchema,
  visionV2AttemptCompletedMessageSchema,
  visionV2AttemptFailedMessageSchema,
  visionV2AttemptCanceledMessageSchema,
]);

export type VisionV2ClientMessage = z.infer<typeof visionV2ClientMessageSchema>;
export type VisionV2ServerMessage = z.infer<typeof visionV2ServerMessageSchema>;
export type VisionV2AttemptStartMessage = z.infer<
  typeof visionV2AttemptStartMessageSchema
>;
/** Compatibility type name; its wire shape is now explicitly mode-neutral. */
export type VisionV2FastAttemptStartMessage = VisionV2AttemptStartMessage;
export type VisionV2AttemptEvent =
  | z.infer<typeof visionV2AttemptAcceptedMessageSchema>
  | z.infer<typeof visionV2AttemptAcquiringMessageSchema>
  | z.infer<typeof visionV2AttemptGeneratingMessageSchema>
  | z.infer<typeof visionV2AttemptCompletedMessageSchema>
  | z.infer<typeof visionV2AttemptFailedMessageSchema>
  | z.infer<typeof visionV2AttemptCanceledMessageSchema>;
