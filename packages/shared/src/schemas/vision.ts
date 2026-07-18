import { z } from "zod";

export const VISION_PROTOCOL = "vem.vision.v1" as const;
export const DEFAULT_VISION_WS_URL = "ws://127.0.0.1:7892/ws" as const;

export function isVisionLoopbackPreviewUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
    return (
      url.protocol === "http:" &&
      loopbackHosts.has(url.hostname.toLocaleLowerCase()) &&
      url.port === "7892" &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

export const visionTryOnPreviewUrlSchema = z
  .string()
  .trim()
  .pipe(z.url())
  .refine(isVisionLoopbackPreviewUrl, {
    message: "Vision preview URL must use the fixed local loopback origin",
  });

export const visionClientMessageTypeSchema = z.enum([
  "vision.hello",
  "vision.ping",
  "vision.try_on.start",
  "vision.try_on.stop",
]);

export const visionServerMessageTypeSchema = z.enum([
  "vision.ready",
  "vision.presence_status",
  "vision.person_departed",
  "vision.profile_result",
  "vision.try_on.started",
  "vision.try_on.stopped",
  "vision.error",
  "vision.pong",
]);

export const visionQualityOverallSchema = z.enum([
  "good",
  "fair",
  "poor",
  "low_confidence",
  "partial",
]);

export const visionPresenceOccupancyStateSchema = z.enum([
  "none",
  "single",
  "multiple",
  "unknown",
]);

export const visionProfileNotUsableReasonSchema = z.enum([
  "multiple_people",
  "no_person",
  "low_confidence",
  "insufficient_quality",
  "unknown",
]);

export const visionErrorCodeSchema = z.enum([
  "invalid_message",
  "unsupported_version",
  "camera_unavailable",
  "try_on_unavailable",
  "model_not_ready",
  "internal_error",
]);

export const visionEnvelopeBaseSchema = z.object({
  protocol: z.literal(VISION_PROTOCOL),
  messageId: z.string().min(1).max(128),
  timestamp: z.iso.datetime(),
});

export const visionSha256HexSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, "expected lowercase sha256 hex");

export const visionFrameSourceEvidenceSchema = z
  .object({
    adapter: z.string().min(1).max(64),
    role: z.enum(["top", "front"]),
    configSha256: visionSha256HexSchema,
    fixtureSha256: visionSha256HexSchema,
    frameIndex: z.number().int().nonnegative(),
    decodedFrameCount: z.number().int().positive(),
    synthetic: z.literal(false).optional(),
    relabeled: z.literal(false).optional(),
    eventId: z.string().min(1).max(128).optional(),
    sessionId: z.string().min(1).max(128).optional(),
  })
  .loose();

export const visionFrameSourceBindingSchema = z
  .object({
    adapter: z.string().min(1).max(64),
    configSha256: visionSha256HexSchema,
    top: z
      .object({
        path: z.string().min(1).max(512),
        sha256: visionSha256HexSchema,
      })
      .loose(),
    front: z
      .object({
        path: z.string().min(1).max(512),
        sha256: visionSha256HexSchema,
      })
      .loose(),
    expectedResults: z
      .object({
        path: z.string().min(1).max(512),
        sha256: visionSha256HexSchema,
      })
      .loose(),
  })
  .loose();

export const visionHelloPayloadSchema = z.object({
  clientRole: z.literal("machine"),
  machineCode: z.string().min(1).max(64).nullable().optional(),
  protocolVersion: z.literal(1),
  capabilities: z.array(z.string().min(1).max(64)).default([]),
});

const emptyPayloadSchema = z.object({}).loose();

export const visionReadyPayloadSchema = z.object({
  serverName: z.string().min(1).max(128),
  serverVersion: z.string().min(1).max(64),
  cameraReady: z.boolean(),
  modelReady: z.boolean(),
  capabilities: z.array(z.string().min(1).max(64)).default([]),
  frameSource: visionFrameSourceBindingSchema.optional(),
});

export const visionProfileSchema = z
  .object({
    personPresent: z.boolean(),
    heightCm: z.number().min(80).max(240).nullable().optional(),
    shoulderWidthCm: z.number().min(20).max(80).nullable().optional(),
    ageRange: z
      .enum(["child", "teen", "adult", "senior", "unknown"])
      .optional(),
    gender: z.enum(["male", "female", "unknown"]).optional(),
    bodyType: z.string().min(1).max(32).optional(),
    upperColor: z.string().min(1).max(32).optional(),
    confidence: z.number().min(0).max(1).optional(),
  })
  .strip();

export const visionPresenceOccupancySchema = z
  .object({
    state: visionPresenceOccupancyStateSchema,
    confidence: z.number().min(0).max(1).optional(),
  })
  .loose();

export const visionProfileResultPayloadSchema = z.object({
  source: z.literal("front"),
  eventId: z.string().min(1).max(128),
  detectedAt: z.iso.datetime(),
  sourceFrame: visionFrameSourceEvidenceSchema.optional(),
  occupancy: visionPresenceOccupancySchema.optional(),
  profile: visionProfileSchema,
  quality: z
    .object({
      overall: visionQualityOverallSchema,
      warnings: z.array(z.string().min(1).max(256)).default([]),
      profileUsable: z.boolean(),
      notUsableReason: visionProfileNotUsableReasonSchema.optional(),
    })
    .loose(),
});

export const visionPresenceStatusPayloadSchema = z
  .object({
    source: z.literal("top"),
    eventId: z.string().min(1).max(128),
    detectedAt: z.iso.datetime(),
    state: z.string().min(1).max(64),
    reason: z.string().min(1).max(128).optional(),
    personPresent: z.boolean(),
    occupancy: visionPresenceOccupancySchema.optional(),
    closeNow: z.boolean().optional(),
    close: z.boolean().optional(),
    closeTrigger: z.string().min(1).max(64).nullable().optional(),
    sourceFrame: visionFrameSourceEvidenceSchema.optional(),
    proximity: z.record(z.string(), z.unknown()).default({}),
  })
  .loose();

export const visionPersonDepartedPayloadSchema = z
  .object({
    source: z.literal("top"),
    eventId: z.string().min(1).max(128),
    detectedAt: z.iso.datetime(),
    lastSeenAt: z.iso.datetime().nullable().optional(),
    reason: z
      .enum([
        "no_person",
        "left_frame",
        "tracking_lost",
        "absence_timeout",
        "manual",
        "unknown",
      ])
      .default("unknown"),
    absenceDurationMs: z.number().int().nonnegative().optional(),
    sourceFrame: visionFrameSourceEvidenceSchema.optional(),
  })
  .loose();

export const visionErrorPayloadSchema = z
  .object({
    eventId: z.string().min(1).max(128).optional(),
    code: visionErrorCodeSchema,
    message: z.string().min(1).max(512),
    retryable: z.boolean(),
    detail: z.record(z.string(), z.unknown()).optional(),
  })
  .loose();

export const visionHelloMessageSchema = visionEnvelopeBaseSchema.extend({
  type: z.literal("vision.hello"),
  payload: visionHelloPayloadSchema,
});

export const visionPingMessageSchema = visionEnvelopeBaseSchema.extend({
  type: z.literal("vision.ping"),
  payload: emptyPayloadSchema,
});

export const visionTryOnStartPayloadSchema = z
  .object({
    sessionId: z.string().min(1).max(128),
    catalogKey: z.string().min(1).max(128).optional(),
    variantId: z.string().min(1).max(128).optional(),
  })
  .loose();

export const visionTryOnStopPayloadSchema = z
  .object({
    sessionId: z.string().min(1).max(128),
    reason: z
      .enum(["user_exit", "route_leave", "replaced", "error", "unknown"])
      .default("unknown"),
  })
  .loose();

export const visionTryOnStartedPayloadSchema = z
  .object({
    sessionId: z.string().min(1).max(128),
    previewUrl: visionTryOnPreviewUrlSchema,
    streamType: z.literal("mjpeg").default("mjpeg"),
    sourceFrame: visionFrameSourceEvidenceSchema.optional(),
  })
  .loose();

export const visionTryOnStoppedPayloadSchema = z
  .object({
    sessionId: z.string().min(1).max(128),
    reason: z
      .enum([
        "client_stop",
        "person_departed",
        "camera_lost",
        "session_replaced",
        "timeout",
        "unknown",
      ])
      .default("unknown"),
  })
  .loose();

export const visionTryOnStartMessageSchema = visionEnvelopeBaseSchema.extend({
  type: z.literal("vision.try_on.start"),
  payload: visionTryOnStartPayloadSchema,
});

export const visionTryOnStopMessageSchema = visionEnvelopeBaseSchema.extend({
  type: z.literal("vision.try_on.stop"),
  payload: visionTryOnStopPayloadSchema,
});

export const visionReadyMessageSchema = visionEnvelopeBaseSchema.extend({
  type: z.literal("vision.ready"),
  payload: visionReadyPayloadSchema,
});

export const visionProfileResultMessageSchema = visionEnvelopeBaseSchema.extend(
  {
    type: z.literal("vision.profile_result"),
    payload: visionProfileResultPayloadSchema,
  },
);

export const visionPresenceStatusMessageSchema =
  visionEnvelopeBaseSchema.extend({
    type: z.literal("vision.presence_status"),
    payload: visionPresenceStatusPayloadSchema,
  });

export const visionPersonDepartedMessageSchema =
  visionEnvelopeBaseSchema.extend({
    type: z.literal("vision.person_departed"),
    payload: visionPersonDepartedPayloadSchema,
  });

export const visionTryOnStartedMessageSchema = visionEnvelopeBaseSchema.extend({
  type: z.literal("vision.try_on.started"),
  payload: visionTryOnStartedPayloadSchema,
});

export const visionTryOnStoppedMessageSchema = visionEnvelopeBaseSchema.extend({
  type: z.literal("vision.try_on.stopped"),
  payload: visionTryOnStoppedPayloadSchema,
});

export const visionErrorMessageSchema = visionEnvelopeBaseSchema.extend({
  type: z.literal("vision.error"),
  payload: visionErrorPayloadSchema,
});

export const visionPongMessageSchema = visionEnvelopeBaseSchema.extend({
  type: z.literal("vision.pong"),
  payload: emptyPayloadSchema,
});

export const visionClientMessageSchema = z.discriminatedUnion("type", [
  visionHelloMessageSchema,
  visionPingMessageSchema,
  visionTryOnStartMessageSchema,
  visionTryOnStopMessageSchema,
]);

export const visionServerMessageSchema = z.discriminatedUnion("type", [
  visionReadyMessageSchema,
  visionPresenceStatusMessageSchema,
  visionPersonDepartedMessageSchema,
  visionProfileResultMessageSchema,
  visionTryOnStartedMessageSchema,
  visionTryOnStoppedMessageSchema,
  visionErrorMessageSchema,
  visionPongMessageSchema,
]);

export type VisionClientMessageType = z.infer<
  typeof visionClientMessageTypeSchema
>;
export type VisionServerMessageType = z.infer<
  typeof visionServerMessageTypeSchema
>;
export type VisionErrorCode = z.infer<typeof visionErrorCodeSchema>;
export type VisionPresenceOccupancyState = z.infer<
  typeof visionPresenceOccupancyStateSchema
>;
export type VisionPresenceOccupancy = z.infer<
  typeof visionPresenceOccupancySchema
>;
export type VisionProfileNotUsableReason = z.infer<
  typeof visionProfileNotUsableReasonSchema
>;
export type VisionProfile = z.infer<typeof visionProfileSchema>;
export type VisionClientMessage = z.infer<typeof visionClientMessageSchema>;
export type VisionServerMessage = z.infer<typeof visionServerMessageSchema>;
export type VisionReadyMessage = z.infer<typeof visionReadyMessageSchema>;
export type VisionProfileResultMessage = z.infer<
  typeof visionProfileResultMessageSchema
>;
export type VisionPresenceStatusMessage = z.infer<
  typeof visionPresenceStatusMessageSchema
>;
export type VisionPersonDepartedMessage = z.infer<
  typeof visionPersonDepartedMessageSchema
>;
export type VisionTryOnStartedMessage = z.infer<
  typeof visionTryOnStartedMessageSchema
>;
export type VisionTryOnStoppedMessage = z.infer<
  typeof visionTryOnStoppedMessageSchema
>;
export type VisionErrorMessage = z.infer<typeof visionErrorMessageSchema>;
