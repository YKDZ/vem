import {
  VISION_V2_BUNDLE_SCHEMA_VERSION,
  VISION_V2_BUNDLE_VERSION,
} from "../schemas/vision-v2";

const digest = "a".repeat(64);
const attemptId = "550e8400-e29b-41d4-a716-446655440124";
const variantId = "550e8400-e29b-41d4-a716-446655440125";
const assetId = "550e8400-e29b-41d4-a716-446655440126";

type Envelope = Record<string, unknown> & { type: string; payload: Record<string, unknown> };
type NegativeFixture = { name: string; field: string; base: Envelope; message: Envelope };

const envelope = (type: string, payload: Record<string, unknown>): Envelope => ({
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
  reference: "http://127.0.0.1:65000/v2/try-on/acquisition/preview.mjpeg?token=preview-token",
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
    clientRole: "machine", machineCode: "M001",
    schemaVersion: VISION_V2_BUNDLE_SCHEMA_VERSION, bundleVersion: VISION_V2_BUNDLE_VERSION,
    contractDigest: digest, capabilities: ["try_on_fast"],
  }),
  start: envelope("vision.try_on.attempt.start", { attemptId, mode: "fast", variantId, garment: garment() }),
  capture: envelope("vision.try_on.attempt.capture", { attemptId }),
  cancel: envelope("vision.try_on.attempt.cancel", { attemptId, reason: "user" }),
} as const;

export const visionV2ServerFixtures = {
  ready: envelope("vision.ready", {
    serverName: "vending-vision", serverVersion: "2.0.0",
    schemaVersion: VISION_V2_BUNDLE_SCHEMA_VERSION, bundleVersion: VISION_V2_BUNDLE_VERSION,
    contractDigest: digest, cameraReady: true, fastReady: true, visionBusinessReady: true,
    businessReadinessDiagnostic: "ready", capabilities: ["try_on_fast"],
  }),
  accepted: envelope("vision.try_on.attempt.accepted", { attemptId, mode: "fast" }),
  acquiringNone: envelope("vision.try_on.attempt.acquiring", { attemptId, preview: preview(), occupancy: "none", guidance: "no_person", manualCaptureAllowed: false }),
  acquiringMultiple: envelope("vision.try_on.attempt.acquiring", { attemptId, preview: preview(), occupancy: "multiple", guidance: "multiple_people", manualCaptureAllowed: false }),
  acquiringAlign: envelope("vision.try_on.attempt.acquiring", { attemptId, preview: preview(), occupancy: "single", guidance: "align", manualCaptureAllowed: false }),
  acquiringHoldStill: envelope("vision.try_on.attempt.acquiring", { attemptId, preview: preview(), occupancy: "single", guidance: "hold_still", manualCaptureAllowed: true }),
  acquiringReady: envelope("vision.try_on.attempt.acquiring", { attemptId, preview: preview(), occupancy: "single", guidance: "ready", manualCaptureAllowed: false }),
  generating: envelope("vision.try_on.attempt.generating", { attemptId, stage: "preparing" }),
  completed: envelope("vision.try_on.attempt.completed", { attemptId, result: result() }),
  failed: envelope("vision.try_on.attempt.failed", { attemptId, reason: "fast_failed" }),
  canceled: envelope("vision.try_on.attempt.canceled", { attemptId, reason: "replaced" }),
} as const;

export const validVisionV2ClientFixtures = Object.values(visionV2ClientFixtures);
export const validVisionV2ServerFixtures = Object.values(visionV2ServerFixtures);

const mutate = (name: string, field: string, base: Envelope, message: Envelope): NegativeFixture => ({ name, field, base, message });

export const invalidVisionV2ClientFixtures = [
  mutate("rejects-client-server-discriminator", "type", visionV2ClientFixtures.hello, { ...visionV2ClientFixtures.hello, type: "vision.ready" }),
  mutate("rejects-client-ai", "payload.mode", visionV2ClientFixtures.start, { ...visionV2ClientFixtures.start, payload: { ...visionV2ClientFixtures.start.payload, mode: "ai" } }),
  mutate("rejects-client-extra", "unexpected", visionV2ClientFixtures.capture, { ...visionV2ClientFixtures.capture, unexpected: true }),
  mutate("rejects-client-invalid-cancel-reason", "payload.reason", visionV2ClientFixtures.cancel, { ...visionV2ClientFixtures.cancel, payload: { ...visionV2ClientFixtures.cancel.payload, reason: "departure" } }),
] as const;

export const invalidVisionV2ServerFixtures = [
  mutate("rejects-server-client-discriminator", "type", visionV2ServerFixtures.ready, { ...visionV2ServerFixtures.ready, type: "vision.hello" }),
  mutate("rejects-preview-wrong-static-path", "payload.preview.reference", visionV2ServerFixtures.acquiringHoldStill, { ...visionV2ServerFixtures.acquiringHoldStill, payload: { ...visionV2ServerFixtures.acquiringHoldStill.payload, preview: { ...preview(), reference: "http://127.0.0.1:65000/v2/try-on/acquisition/other.mjpeg?token=preview-token" } } }),
  mutate("rejects-preview-extra-query", "payload.preview.reference", visionV2ServerFixtures.acquiringHoldStill, { ...visionV2ServerFixtures.acquiringHoldStill, payload: { ...visionV2ServerFixtures.acquiringHoldStill.payload, preview: { ...preview(), reference: "http://127.0.0.1:65000/v2/try-on/acquisition/preview.mjpeg?token=one&token=two" } } }),
  mutate("rejects-none-manual", "payload.manualCaptureAllowed", visionV2ServerFixtures.acquiringNone, { ...visionV2ServerFixtures.acquiringNone, payload: { ...visionV2ServerFixtures.acquiringNone.payload, manualCaptureAllowed: true } }),
  mutate("rejects-multiple-manual", "payload.manualCaptureAllowed", visionV2ServerFixtures.acquiringMultiple, { ...visionV2ServerFixtures.acquiringMultiple, payload: { ...visionV2ServerFixtures.acquiringMultiple.payload, manualCaptureAllowed: true } }),
  mutate("rejects-align-manual", "payload.manualCaptureAllowed", visionV2ServerFixtures.acquiringAlign, { ...visionV2ServerFixtures.acquiringAlign, payload: { ...visionV2ServerFixtures.acquiringAlign.payload, manualCaptureAllowed: true } }),
  mutate("rejects-ready-manual", "payload.manualCaptureAllowed", visionV2ServerFixtures.acquiringReady, { ...visionV2ServerFixtures.acquiringReady, payload: { ...visionV2ServerFixtures.acquiringReady.payload, manualCaptureAllowed: true } }),
] as const;
