const digest = "a".repeat(64);
const attemptId = "550e8400-e29b-41d4-a716-446655440124";
const variantId = "550e8400-e29b-41d4-a716-446655440125";
const assetId = "550e8400-e29b-41d4-a716-446655440126";
const fastGarment = {
  assetId,
  reference: "http://127.0.0.1:39001/media/garment?token=source-token",
  digest: `sha256:${digest}`,
  contentType: "image/png" as const,
  byteSize: 2048,
  template: "tshirt_short_sleeve" as const,
};

const envelope = (type: string, payload: object) => ({
  protocol: "vem.vision.v2",
  type,
  messageId: `fixture-${type}`,
  timestamp: "2026-08-09T00:00:00.000Z",
  payload,
});

export const validVisionV2Fixtures = [
  envelope("vision.hello", {
    clientRole: "machine",
    machineCode: "M001",
    contractDigest: digest,
    capabilities: ["try_on_fast"],
  }),
  envelope("vision.ready", {
    serverName: "vending-vision",
    serverVersion: "2.0.0",
    contractDigest: digest,
    cameraReady: true,
    fastReady: true,
    visionBusinessReady: true,
    capabilities: ["try_on_fast"],
  }),
  envelope("vision.try_on.attempt.start", {
    attemptId,
    mode: "fast",
    variantId,
    garment: fastGarment,
  }),
  envelope("vision.try_on.attempt.accepted", { attemptId, mode: "fast" }),
  envelope("vision.try_on.attempt.progress", {
    attemptId,
    stage: "generating",
  }),
  envelope("vision.try_on.attempt.completed", {
    attemptId,
    result: {
      reference: "http://127.0.0.1:39002/results/output?token=result-token",
      digest: `sha256:${digest}`,
      contentType: "image/png",
      byteSize: 4096,
      width: 512,
      height: 768,
    },
  }),
];

export const invalidVisionV2Fixtures = [
  {
    name: "rejects-v1-protocol",
    message: { ...validVisionV2Fixtures[0], protocol: "vem.vision.v1" },
  },
  {
    name: "rejects-ai-before-ai-slice",
    message: {
      ...validVisionV2Fixtures[2],
      payload: { ...validVisionV2Fixtures[2].payload, mode: "ai" },
    },
  },
  {
    name: "rejects-non-loopback-garment",
    message: {
      ...validVisionV2Fixtures[2],
      payload: {
        ...validVisionV2Fixtures[2].payload,
        garment: {
          ...fastGarment,
          reference: "https://platform.example/media?token=wrong-boundary",
        },
      },
    },
  },
  {
    name: "rejects-empty-loopback-token",
    message: {
      ...validVisionV2Fixtures[2],
      payload: {
        ...validVisionV2Fixtures[2].payload,
        garment: {
          ...fastGarment,
          reference: "http://127.0.0.1:39001/media/garment?token=",
        },
      },
    },
  },
  {
    name: "rejects-extra-fast-payload-property",
    message: {
      ...validVisionV2Fixtures[2],
      payload: {
        ...validVisionV2Fixtures[2].payload,
        unexpected: true,
      },
    },
  },
  {
    name: "rejects-coerced-byte-size",
    message: {
      ...validVisionV2Fixtures[2],
      payload: {
        ...validVisionV2Fixtures[2].payload,
        garment: {
          ...fastGarment,
          byteSize: "2048",
        },
      },
    },
  },
];
