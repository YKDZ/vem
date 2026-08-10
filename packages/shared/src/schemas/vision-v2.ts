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
const visionV2AcquisitionPreviewPathPattern =
  /^\/vision\/v2\/try-on\/attempts\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/preview\.mjpeg$/;
const visionV2AcquisitionPreviewUrlPattern =
  /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::(?:[1-9]\d{0,3}|[1-5]\d{4}|6[0-4]\d{3}|65[0-4]\d{2}|655[0-2]\d|6553[0-5]))?\/vision\/v2\/try-on\/attempts\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/preview\.mjpeg\?token=[A-Za-z0-9_-]{1,128}(?![\s\S])/;

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
    .superRefine((value, context) => {
      validateTokenizedLoopbackUrl(value, context);
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        return;
      }
      if (!visionV2AcquisitionPreviewPathPattern.test(url.pathname)) {
        context.addIssue({
          code: "custom",
          message: "preview reference must use the V2 acquisition MJPEG path",
        });
      }
    });
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
    visionBusinessReady: z.boolean(),
    businessReadinessDiagnostic: visionV2BusinessReadinessDiagnosticSchema,
    capabilities: z.array(codePointString({ minimum: 1, maximum: 64 })).max(32),
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

const visionV2AttemptAcquiringPayloadSchema = z
  .strictObject({
    attemptId: nonSentinelUuidSchema,
    preview: visionV2AcquisitionPreviewSchema,
    occupancy: z.enum(["none", "single", "multiple"]),
    guidance: z.enum([
      "no_person",
      "multiple_people",
      "align",
      "hold_still",
      "ready",
    ]),
    manualCaptureAllowed: z.boolean(),
  })
  .superRefine((payload, context) => {
    let previewUrl: URL;
    try {
      previewUrl = new URL(payload.preview.reference);
    } catch {
      return;
    }
    const attemptPath = previewUrl.pathname.split("/")[5];
    if (attemptPath !== payload.attemptId) {
      context.addIssue({
        code: "custom",
        path: ["preview", "reference"],
        message: "preview reference must be scoped to attemptId",
      });
    }
    const expectedGuidance: Record<string, readonly string[]> = {
      none: ["no_person"],
      multiple: ["multiple_people"],
      single: ["align", "hold_still", "ready"],
    };
    if (!expectedGuidance[payload.occupancy].includes(payload.guidance)) {
      context.addIssue({
        code: "custom",
        path: ["guidance"],
        message: "guidance must truthfully match occupancy",
      });
    }
    const eligible =
      payload.occupancy === "single" &&
      ["align", "hold_still", "ready"].includes(payload.guidance);
    if (payload.manualCaptureAllowed && !eligible) {
      context.addIssue({
        code: "custom",
        path: ["manualCaptureAllowed"],
        message: "manual capture requires one aligned person",
      });
    }
  })
  .meta({ "x-vem-semantic": "vision-v2-acquiring-payload" });

export const visionV2AttemptAcquiringMessageSchema = envelopeBaseSchema.extend({
  type: z.literal("vision.try_on.attempt.acquiring"),
  payload: visionV2AttemptAcquiringPayloadSchema,
});

export const visionV2AttemptGeneratingMessageSchema = envelopeBaseSchema.extend(
  {
    type: z.literal("vision.try_on.attempt.generating"),
    payload: z.strictObject({
      attemptId: nonSentinelUuidSchema,
      stage: z.enum(["preparing", "rendering"]),
    }),
  },
);

export const visionV2AttemptProgressMessageSchema = envelopeBaseSchema
  .extend({
    type: z.literal("vision.try_on.attempt.progress"),
    payload: z.strictObject({
      attemptId: nonSentinelUuidSchema,
      stage: z.literal("generating"),
    }),
  })
  .meta({ deprecated: true, "x-vem-phase": "phase-b-delete" });

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
      "attempt_already_active",
      "attempt_replaced",
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

export const visionV2MessageSchema = z.discriminatedUnion("type", [
  visionV2HelloMessageSchema,
  visionV2ReadyMessageSchema,
  visionV2FastAttemptStartMessageSchema,
  visionV2AttemptAcceptedMessageSchema,
  visionV2AttemptCaptureMessageSchema,
  visionV2AttemptCancelMessageSchema,
  visionV2AttemptAcquiringMessageSchema,
  visionV2AttemptGeneratingMessageSchema,
  visionV2AttemptProgressMessageSchema,
  visionV2AttemptCompletedMessageSchema,
  visionV2AttemptFailedMessageSchema,
  visionV2AttemptCanceledMessageSchema,
]);

export type VisionV2Message = z.infer<typeof visionV2MessageSchema>;
