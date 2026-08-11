import {
  VISION_V2_BUNDLE_SCHEMA_VERSION,
  VISION_V2_BUNDLE_VERSION,
} from "../schemas/vision-v2";

const digest = "a".repeat(64);
const attemptId = "550e8400-e29b-41d4-a716-446655440124";
const variantId = "550e8400-e29b-41d4-a716-446655440125";
const assetId = "550e8400-e29b-41d4-a716-446655440126";

type Envelope = Record<string, unknown> & {
  type: string;
  payload: Record<string, unknown>;
};
type NegativeFixture = {
  name: string;
  field: string;
  base: Envelope;
  message: Envelope;
};

const envelope = (
  type: string,
  payload: Record<string, unknown>,
): Envelope => ({
  protocol: "vem.vision.v2",
  type,
  messageId: `fixture-${type}`,
  timestamp: "2026-08-09T00:00:00.000Z",
  payload,
});

const garment = () => ({
  assetId,
  reference: "http://127.0.0.1:65000/media/garment?token=source-token",
  digest: `sha256:${digest}`,
  contentType: "image/png",
  byteSize: 2048,
  template: "tshirt_short_sleeve",
});
const preview = () => ({
  reference:
    "http://127.0.0.1:65000/v2/try-on/acquisition/preview.mjpeg?token=preview-token",
  streamType: "mjpeg",
});
const result = () => ({
  reference: "http://127.0.0.1:65499/results/output?token=result-token",
  digest: `sha256:${digest}`,
  contentType: "image/png",
  byteSize: 4096,
  width: 512,
  height: 768,
});

export const visionV2ClientFixtures = {
  hello: envelope("vision.hello", {
    clientRole: "machine",
    machineCode: "M001",
    schemaVersion: VISION_V2_BUNDLE_SCHEMA_VERSION,
    bundleVersion: VISION_V2_BUNDLE_VERSION,
    contractDigest: digest,
    capabilities: ["try_on_fast"],
  }),
  start: envelope("vision.try_on.attempt.start", {
    attemptId,
    mode: "fast",
    variantId,
    garment: garment(),
  }),
  startAi: envelope("vision.try_on.attempt.start", {
    attemptId,
    mode: "ai",
    variantId,
    garment: garment(),
  }),
  capture: envelope("vision.try_on.attempt.capture", { attemptId }),
  cancel: envelope("vision.try_on.attempt.cancel", {
    attemptId,
    reason: "user",
  }),
} as const;

export const visionV2ServerFixtures = {
  ready: envelope("vision.ready", {
    serverName: "vending-vision",
    serverVersion: "2.0.0",
    schemaVersion: VISION_V2_BUNDLE_SCHEMA_VERSION,
    bundleVersion: VISION_V2_BUNDLE_VERSION,
    contractDigest: digest,
    cameraReady: true,
    fastReady: true,
    aiReady: true,
    aiReadinessDiagnostic: "ready",
    visionBusinessReady: true,
    businessReadinessDiagnostic: "ready",
    capabilities: ["try_on_fast"],
  }),
  readyUnicodeBounds: {
    ...envelope("vision.ready", {
      serverName: "名".repeat(128),
      serverVersion: "版".repeat(64),
      schemaVersion: "架".repeat(128),
      bundleVersion: "包".repeat(64),
      contractDigest: digest,
      cameraReady: true,
      fastReady: true,
      aiReady: true,
      aiReadinessDiagnostic: "ready",
      visionBusinessReady: true,
      businessReadinessDiagnostic: "ready",
      capabilities: ["能".repeat(64)],
    }),
    messageId: "\u{1f600}".repeat(128),
  },
  accepted: envelope("vision.try_on.attempt.accepted", {
    attemptId,
    mode: "fast",
  }),
  acceptedAi: envelope("vision.try_on.attempt.accepted", {
    attemptId,
    mode: "ai",
  }),
  acquiringNone: envelope("vision.try_on.attempt.acquiring", {
    attemptId,
    preview: preview(),
    occupancy: "none",
    guidance: "no_person",
    manualCaptureAllowed: false,
  }),
  acquiringMultiple: envelope("vision.try_on.attempt.acquiring", {
    attemptId,
    preview: preview(),
    occupancy: "multiple",
    guidance: "multiple_people",
    manualCaptureAllowed: false,
  }),
  acquiringAlign: envelope("vision.try_on.attempt.acquiring", {
    attemptId,
    preview: preview(),
    occupancy: "single",
    guidance: "align",
    manualCaptureAllowed: false,
  }),
  acquiringHoldStill: envelope("vision.try_on.attempt.acquiring", {
    attemptId,
    preview: preview(),
    occupancy: "single",
    guidance: "hold_still",
    manualCaptureAllowed: true,
  }),
  acquiringReady: envelope("vision.try_on.attempt.acquiring", {
    attemptId,
    preview: preview(),
    occupancy: "single",
    guidance: "ready",
    manualCaptureAllowed: false,
  }),
  generating: envelope("vision.try_on.attempt.generating", {
    attemptId,
    stage: "preparing",
  }),
  completed: envelope("vision.try_on.attempt.completed", {
    attemptId,
    result: result(),
  }),
  failed: envelope("vision.try_on.attempt.failed", {
    attemptId,
    reason: "fast_failed",
  }),
  canceled: envelope("vision.try_on.attempt.canceled", {
    attemptId,
    reason: "replaced",
  }),
} as const;

export const validVisionV2ClientFixtures = Object.values(
  visionV2ClientFixtures,
);
export const validVisionV2ServerFixtures = Object.values(
  visionV2ServerFixtures,
);

/** Every rejected fixture is a single mutation of a committed directional base. */
const mutate = (
  name: string,
  field: string,
  base: Envelope,
  apply: (message: Envelope) => void,
): NegativeFixture => {
  const message = structuredClone(base);
  apply(message);
  return { name, field, base: structuredClone(base), message };
};

const payload = (message: Envelope): Record<string, unknown> => message.payload;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const nestedPayload = (
  message: Envelope,
  key: string,
): Record<string, unknown> => {
  const value = payload(message)[key];
  if (isRecord(value)) return value;
  throw new Error(`fixture payload.${key} must be an object`);
};
const garmentPayload = (message: Envelope): Record<string, unknown> =>
  nestedPayload(message, "garment");
const previewPayload = (message: Envelope): Record<string, unknown> =>
  nestedPayload(message, "preview");
const resultPayload = (message: Envelope): Record<string, unknown> =>
  nestedPayload(message, "result");
const overlongToken = "a".repeat(129);
const overlongCodePoints = "\u{1f600}".repeat(129);

export const invalidVisionV2ClientFixtures = [
  mutate(
    "rejects-client-server-discriminator",
    "type",
    visionV2ClientFixtures.hello,
    (message) => {
      message.type = "vision.ready";
    },
  ),
  mutate(
    "rejects-client-unknown-discriminator",
    "type",
    visionV2ClientFixtures.hello,
    (message) => {
      message.type = "vision.try_on.attempt.unknown";
    },
  ),
  mutate(
    "rejects-client-wrong-payload",
    "payload.clientRole",
    visionV2ClientFixtures.hello,
    (message) => {
      payload(message).clientRole = "vision";
    },
  ),
  mutate(
    "rejects-client-unknown-mode",
    "payload.mode",
    visionV2ClientFixtures.start,
    (message) => {
      payload(message).mode = "automatic";
    },
  ),
  mutate(
    "rejects-client-attempt-id-nil",
    "payload.attemptId",
    visionV2ClientFixtures.start,
    (message) => {
      payload(message).attemptId = "00000000-0000-0000-0000-000000000000";
    },
  ),
  mutate(
    "rejects-client-attempt-id-coercion",
    "payload.attemptId",
    visionV2ClientFixtures.start,
    (message) => {
      payload(message).attemptId = 1;
    },
  ),
  mutate(
    "rejects-client-garment-byte-size-coercion",
    "payload.garment.byteSize",
    visionV2ClientFixtures.start,
    (message) => {
      garmentPayload(message).byteSize = "2048";
    },
  ),
  mutate(
    "rejects-client-garment-byte-size-fraction",
    "payload.garment.byteSize",
    visionV2ClientFixtures.start,
    (message) => {
      garmentPayload(message).byteSize = 1.5;
    },
  ),
  mutate(
    "rejects-client-garment-byte-size-bool",
    "payload.garment.byteSize",
    visionV2ClientFixtures.start,
    (message) => {
      garmentPayload(message).byteSize = true;
    },
  ),
  mutate(
    "rejects-client-garment-digest-invalid",
    "payload.garment.digest",
    visionV2ClientFixtures.start,
    (message) => {
      garmentPayload(message).digest = "sha256:not-a-digest";
    },
  ),
  mutate(
    "rejects-client-garment-url-https",
    "payload.garment.reference",
    visionV2ClientFixtures.start,
    (message) => {
      garmentPayload(message).reference =
        "https://127.0.0.1:65000/media/garment?token=source-token";
    },
  ),
  mutate(
    "rejects-client-garment-url-origin",
    "payload.garment.reference",
    visionV2ClientFixtures.start,
    (message) => {
      garmentPayload(message).reference =
        "http://example.test/media/garment?token=source-token";
    },
  ),
  mutate(
    "rejects-client-garment-url-port",
    "payload.garment.reference",
    visionV2ClientFixtures.start,
    (message) => {
      garmentPayload(message).reference =
        "http://127.0.0.1:65536/media/garment?token=source-token";
    },
  ),
  mutate(
    "rejects-client-garment-url-fragment",
    "payload.garment.reference",
    visionV2ClientFixtures.start,
    (message) => {
      garmentPayload(message).reference =
        "http://127.0.0.1:65000/media/garment?token=source-token#fragment";
    },
  ),
  mutate(
    "rejects-client-garment-url-empty-token",
    "payload.garment.reference",
    visionV2ClientFixtures.start,
    (message) => {
      garmentPayload(message).reference =
        "http://127.0.0.1:65000/media/garment?token=";
    },
  ),
  mutate(
    "rejects-client-garment-url-duplicate-token",
    "payload.garment.reference",
    visionV2ClientFixtures.start,
    (message) => {
      garmentPayload(message).reference =
        "http://127.0.0.1:65000/media/garment?token=one&token=two";
    },
  ),
  mutate(
    "rejects-client-garment-url-overlong-token",
    "payload.garment.reference",
    visionV2ClientFixtures.start,
    (message) => {
      garmentPayload(message).reference =
        `http://127.0.0.1:65000/media/garment?token=${overlongToken}`;
    },
  ),
  mutate(
    "rejects-client-garment-url-non-base64url-token",
    "payload.garment.reference",
    visionV2ClientFixtures.start,
    (message) => {
      garmentPayload(message).reference =
        "http://127.0.0.1:65000/media/garment?token=not%2Fsafe";
    },
  ),
  mutate(
    "rejects-client-unicode-code-point-over-limit",
    "messageId",
    visionV2ClientFixtures.hello,
    (message) => {
      message.messageId = overlongCodePoints;
    },
  ),
  mutate(
    "rejects-client-extra",
    "unexpected",
    visionV2ClientFixtures.capture,
    (message) => {
      (message as Record<string, unknown>).unexpected = true;
    },
  ),
  mutate(
    "rejects-client-invalid-cancel-reason",
    "payload.reason",
    visionV2ClientFixtures.cancel,
    (message) => {
      payload(message).reason = "departure";
    },
  ),
  mutate(
    "rejects-client-cancel-strict-extra",
    "payload.unexpected",
    visionV2ClientFixtures.cancel,
    (message) => {
      payload(message).unexpected = true;
    },
  ),
] as const;

export const invalidVisionV2ServerFixtures = [
  mutate(
    "rejects-server-client-discriminator",
    "type",
    visionV2ServerFixtures.ready,
    (message) => {
      message.type = "vision.hello";
    },
  ),
  mutate(
    "rejects-server-unknown-discriminator",
    "type",
    visionV2ServerFixtures.ready,
    (message) => {
      message.type = "vision.try_on.attempt.unknown";
    },
  ),
  mutate(
    "rejects-server-wrong-payload",
    "payload.fastReady",
    visionV2ServerFixtures.ready,
    (message) => {
      payload(message).fastReady = "true";
    },
  ),
  mutate(
    "rejects-server-unstable-ai-readiness-diagnostic",
    "payload.aiReadinessDiagnostic",
    visionV2ServerFixtures.ready,
    (message) => {
      payload(message).aiReadinessDiagnostic =
        "C:\\private\\models\\missing-weight.bin";
    },
  ),
  mutate(
    "rejects-server-protocol",
    "protocol",
    visionV2ServerFixtures.ready,
    (message) => {
      message.protocol = "invalid.protocol";
    },
  ),
  mutate(
    "rejects-server-unicode-code-point-over-limit",
    "messageId",
    visionV2ServerFixtures.ready,
    (message) => {
      message.messageId = overlongCodePoints;
    },
  ),
  mutate(
    "rejects-preview-wrong-static-path",
    "payload.preview.reference",
    visionV2ServerFixtures.acquiringHoldStill,
    (message) => {
      previewPayload(message).reference =
        "http://127.0.0.1:65000/v2/try-on/acquisition/other.mjpeg?token=preview-token";
    },
  ),
  mutate(
    "rejects-preview-url-https",
    "payload.preview.reference",
    visionV2ServerFixtures.acquiringHoldStill,
    (message) => {
      previewPayload(message).reference =
        "https://127.0.0.1:65000/v2/try-on/acquisition/preview.mjpeg?token=preview-token";
    },
  ),
  mutate(
    "rejects-preview-url-origin",
    "payload.preview.reference",
    visionV2ServerFixtures.acquiringHoldStill,
    (message) => {
      previewPayload(message).reference =
        "http://example.test/v2/try-on/acquisition/preview.mjpeg?token=preview-token";
    },
  ),
  mutate(
    "rejects-preview-url-port",
    "payload.preview.reference",
    visionV2ServerFixtures.acquiringHoldStill,
    (message) => {
      previewPayload(message).reference =
        "http://127.0.0.1:65536/v2/try-on/acquisition/preview.mjpeg?token=preview-token";
    },
  ),
  mutate(
    "rejects-preview-url-fragment",
    "payload.preview.reference",
    visionV2ServerFixtures.acquiringHoldStill,
    (message) => {
      previewPayload(message).reference =
        "http://127.0.0.1:65000/v2/try-on/acquisition/preview.mjpeg?token=preview-token#fragment";
    },
  ),
  mutate(
    "rejects-preview-url-empty-token",
    "payload.preview.reference",
    visionV2ServerFixtures.acquiringHoldStill,
    (message) => {
      previewPayload(message).reference =
        "http://127.0.0.1:65000/v2/try-on/acquisition/preview.mjpeg?token=";
    },
  ),
  mutate(
    "rejects-preview-url-duplicate-token",
    "payload.preview.reference",
    visionV2ServerFixtures.acquiringHoldStill,
    (message) => {
      previewPayload(message).reference =
        "http://127.0.0.1:65000/v2/try-on/acquisition/preview.mjpeg?token=one&token=two";
    },
  ),
  mutate(
    "rejects-preview-url-overlong-token",
    "payload.preview.reference",
    visionV2ServerFixtures.acquiringHoldStill,
    (message) => {
      previewPayload(message).reference =
        `http://127.0.0.1:65000/v2/try-on/acquisition/preview.mjpeg?token=${overlongToken}`;
    },
  ),
  mutate(
    "rejects-preview-url-non-base64url-token",
    "payload.preview.reference",
    visionV2ServerFixtures.acquiringHoldStill,
    (message) => {
      previewPayload(message).reference =
        "http://127.0.0.1:65000/v2/try-on/acquisition/preview.mjpeg?token=not%2Fsafe";
    },
  ),
  mutate(
    "rejects-none-manual",
    "payload.manualCaptureAllowed",
    visionV2ServerFixtures.acquiringNone,
    (message) => {
      payload(message).manualCaptureAllowed = true;
    },
  ),
  mutate(
    "rejects-multiple-manual",
    "payload.manualCaptureAllowed",
    visionV2ServerFixtures.acquiringMultiple,
    (message) => {
      payload(message).manualCaptureAllowed = true;
    },
  ),
  mutate(
    "rejects-align-manual",
    "payload.manualCaptureAllowed",
    visionV2ServerFixtures.acquiringAlign,
    (message) => {
      payload(message).manualCaptureAllowed = true;
    },
  ),
  mutate(
    "rejects-ready-manual",
    "payload.manualCaptureAllowed",
    visionV2ServerFixtures.acquiringReady,
    (message) => {
      payload(message).manualCaptureAllowed = true;
    },
  ),
  mutate(
    "rejects-acquiring-extra",
    "payload.percentage",
    visionV2ServerFixtures.acquiringHoldStill,
    (message) => {
      payload(message).percentage = 50;
    },
  ),
  mutate(
    "rejects-generating-extra",
    "payload.percentage",
    visionV2ServerFixtures.generating,
    (message) => {
      payload(message).percentage = 50;
    },
  ),
  mutate(
    "rejects-generating-attempt-id-coercion",
    "payload.attemptId",
    visionV2ServerFixtures.generating,
    (message) => {
      payload(message).attemptId = 1;
    },
  ),
  mutate(
    "rejects-result-byte-size-coercion",
    "payload.result.byteSize",
    visionV2ServerFixtures.completed,
    (message) => {
      resultPayload(message).byteSize = "4096";
    },
  ),
  mutate(
    "rejects-result-byte-size-fraction",
    "payload.result.byteSize",
    visionV2ServerFixtures.completed,
    (message) => {
      resultPayload(message).byteSize = 1.5;
    },
  ),
  mutate(
    "rejects-result-byte-size-bool",
    "payload.result.byteSize",
    visionV2ServerFixtures.completed,
    (message) => {
      resultPayload(message).byteSize = true;
    },
  ),
  mutate(
    "rejects-result-width-fraction",
    "payload.result.width",
    visionV2ServerFixtures.completed,
    (message) => {
      resultPayload(message).width = 1.5;
    },
  ),
  mutate(
    "rejects-result-height-bool",
    "payload.result.height",
    visionV2ServerFixtures.completed,
    (message) => {
      resultPayload(message).height = false;
    },
  ),
  mutate(
    "rejects-result-dimension-over-limit",
    "payload.result.width",
    visionV2ServerFixtures.completed,
    (message) => {
      resultPayload(message).width = 8193;
    },
  ),
  mutate(
    "rejects-result-url-https",
    "payload.result.reference",
    visionV2ServerFixtures.completed,
    (message) => {
      resultPayload(message).reference =
        "https://127.0.0.1:65499/results/output?token=result-token";
    },
  ),
  mutate(
    "rejects-result-url-origin",
    "payload.result.reference",
    visionV2ServerFixtures.completed,
    (message) => {
      resultPayload(message).reference =
        "http://example.test/results/output?token=result-token";
    },
  ),
  mutate(
    "rejects-result-url-port",
    "payload.result.reference",
    visionV2ServerFixtures.completed,
    (message) => {
      resultPayload(message).reference =
        "http://127.0.0.1:65536/results/output?token=result-token";
    },
  ),
  mutate(
    "rejects-result-url-fragment",
    "payload.result.reference",
    visionV2ServerFixtures.completed,
    (message) => {
      resultPayload(message).reference =
        "http://127.0.0.1:65499/results/output?token=result-token#fragment";
    },
  ),
  mutate(
    "rejects-result-url-empty-token",
    "payload.result.reference",
    visionV2ServerFixtures.completed,
    (message) => {
      resultPayload(message).reference =
        "http://127.0.0.1:65499/results/output?token=";
    },
  ),
  mutate(
    "rejects-result-url-duplicate-token",
    "payload.result.reference",
    visionV2ServerFixtures.completed,
    (message) => {
      resultPayload(message).reference =
        "http://127.0.0.1:65499/results/output?token=one&token=two";
    },
  ),
  mutate(
    "rejects-result-url-overlong-token",
    "payload.result.reference",
    visionV2ServerFixtures.completed,
    (message) => {
      resultPayload(message).reference =
        `http://127.0.0.1:65499/results/output?token=${overlongToken}`;
    },
  ),
  mutate(
    "rejects-result-url-non-base64url-token",
    "payload.result.reference",
    visionV2ServerFixtures.completed,
    (message) => {
      resultPayload(message).reference =
        "http://127.0.0.1:65499/results/output?token=not%2Fsafe";
    },
  ),
  mutate(
    "rejects-result-digest-invalid",
    "payload.result.digest",
    visionV2ServerFixtures.completed,
    (message) => {
      resultPayload(message).digest = "sha256:not-a-digest";
    },
  ),
  mutate(
    "rejects-failed-reason-enum",
    "payload.reason",
    visionV2ServerFixtures.failed,
    (message) => {
      payload(message).reason = "unknown";
    },
  ),
  mutate(
    "rejects-failed-strict-extra",
    "payload.unexpected",
    visionV2ServerFixtures.failed,
    (message) => {
      payload(message).unexpected = true;
    },
  ),
  mutate(
    "rejects-canceled-reason-enum",
    "payload.reason",
    visionV2ServerFixtures.canceled,
    (message) => {
      payload(message).reason = "unknown";
    },
  ),
  mutate(
    "rejects-canceled-strict-extra",
    "payload.unexpected",
    visionV2ServerFixtures.canceled,
    (message) => {
      payload(message).unexpected = true;
    },
  ),
] as const;
