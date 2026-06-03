import { z } from "zod";

export const VISION_PROTOCOL = "vem.vision.v1" as const;
export const DEFAULT_VISION_WS_URL = "ws://127.0.0.1:7892/ws" as const;

export const visionClientMessageTypeSchema = z.enum([
  "vision.hello",
  "vision.ping",
]);

export const visionServerMessageTypeSchema = z.enum([
  "vision.ready",
  "vision.profile_result",
  "vision.error",
  "vision.pong",
]);

export const visionQualityOverallSchema = z.enum([
  "good",
  "low_confidence",
  "partial",
]);

export const visionErrorCodeSchema = z.enum([
  "invalid_message",
  "unsupported_version",
  "camera_unavailable",
  "model_not_ready",
  "internal_error",
]);

export const visionEnvelopeBaseSchema = z.object({
  protocol: z.literal(VISION_PROTOCOL),
  messageId: z.string().min(1).max(128),
  timestamp: z.iso.datetime(),
});

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
});

export const visionProfileSchema = z
  .object({
    personPresent: z.boolean(),
    heightCm: z.number().min(80).max(240).nullable().optional(),
    shoulderWidthCm: z.number().min(20).max(80).nullable().optional(),
    ageRange: z.string().min(1).max(32).optional(),
    gender: z.string().min(1).max(32).optional(),
    bodyType: z.string().min(1).max(32).optional(),
    upperColor: z.string().min(1).max(32).optional(),
    confidence: z.number().min(0).max(1).optional(),
  })
  .loose();

export const visionProfileResultPayloadSchema = z.object({
  eventId: z.string().min(1).max(128),
  detectedAt: z.iso.datetime(),
  profile: visionProfileSchema,
  quality: z.object({
    overall: visionQualityOverallSchema,
    warnings: z.array(z.string().min(1).max(256)).default([]),
  }),
});

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
]);

export const visionServerMessageSchema = z.discriminatedUnion("type", [
  visionReadyMessageSchema,
  visionProfileResultMessageSchema,
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
export type VisionProfile = z.infer<typeof visionProfileSchema>;
export type VisionClientMessage = z.infer<typeof visionClientMessageSchema>;
export type VisionServerMessage = z.infer<typeof visionServerMessageSchema>;
export type VisionReadyMessage = z.infer<typeof visionReadyMessageSchema>;
export type VisionProfileResultMessage = z.infer<
  typeof visionProfileResultMessageSchema
>;
export type VisionErrorMessage = z.infer<typeof visionErrorMessageSchema>;
