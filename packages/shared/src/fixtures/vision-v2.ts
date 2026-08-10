import {
  VISION_V2_BUNDLE_SCHEMA_VERSION,
  VISION_V2_BUNDLE_VERSION,
} from "../schemas/vision-v2";

const digest = "a".repeat(64);
const attemptId = "550e8400-e29b-41d4-a716-446655440124";
const variantId = "550e8400-e29b-41d4-a716-446655440125";
const assetId = "550e8400-e29b-41d4-a716-446655440126";
const fastGarment = {
  assetId,
  reference: "http://127.0.0.1:65000/media/garment?token=source-token",
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
    schemaVersion: VISION_V2_BUNDLE_SCHEMA_VERSION,
    bundleVersion: VISION_V2_BUNDLE_VERSION,
    contractDigest: digest,
    capabilities: ["try_on_fast"],
  }),
  envelope("vision.ready", {
    serverName: "vending-vision",
    serverVersion: "2.0.0",
    schemaVersion: VISION_V2_BUNDLE_SCHEMA_VERSION,
    bundleVersion: VISION_V2_BUNDLE_VERSION,
    contractDigest: digest,
    cameraReady: true,
    fastReady: true,
    visionBusinessReady: true,
    businessReadinessDiagnostic: "ready",
    capabilities: ["try_on_fast"],
  }),
  envelope("vision.try_on.attempt.start", {
    attemptId,
    mode: "fast",
    variantId,
    garment: fastGarment,
  }),
  envelope("vision.try_on.attempt.start", {
    attemptId,
    mode: "fast",
    variantId,
    garment: {
      ...fastGarment,
      reference: "http://127.0.0.1:65000/media/garment?token=A",
    },
  }),
  envelope("vision.try_on.attempt.start", {
    attemptId,
    mode: "fast",
    variantId,
    garment: {
      ...fastGarment,
      reference: `http://127.0.0.1:65000/media/garment?token=${"a".repeat(128)}`,
    },
  }),
  envelope("vision.try_on.attempt.accepted", { attemptId, mode: "fast" }),
  envelope("vision.try_on.attempt.progress", {
    attemptId,
    stage: "generating",
  }),
  envelope("vision.try_on.attempt.completed", {
    attemptId,
    result: {
      reference: "http://127.0.0.1:65499/results/output?token=result-token",
      digest: `sha256:${digest}`,
      contentType: "image/png",
      byteSize: 4096,
      width: 512,
      height: 768,
    },
  }),
  envelope("vision.try_on.attempt.failed", {
    attemptId,
    reason: "garment_rejected",
  }),
  envelope("vision.try_on.attempt.capture", { attemptId }),
  envelope("vision.try_on.attempt.cancel", { attemptId, reason: "user" }),
  envelope("vision.try_on.attempt.acquiring", {
    attemptId,
    preview: {
      reference: `http://127.0.0.1:65000/vision/v2/try-on/attempts/${attemptId}/preview.mjpeg?token=preview-token`,
      streamType: "mjpeg",
    },
    occupancy: "single",
    guidance: "ready",
    manualCaptureAllowed: true,
  }),
  envelope("vision.try_on.attempt.generating", {
    attemptId,
    stage: "preparing",
  }),
  envelope("vision.try_on.attempt.canceled", {
    attemptId,
    reason: "departure",
  }),
  {
    ...envelope("vision.ready", {
      serverName: "名".repeat(128),
      serverVersion: "🙂".repeat(64),
      schemaVersion: "架".repeat(128),
      bundleVersion: "🙂".repeat(64),
      contractDigest: digest,
      cameraReady: true,
      fastReady: true,
      visionBusinessReady: true,
      businessReadinessDiagnostic: "ready",
      capabilities: ["🙂".repeat(64)],
    }),
    messageId: "🙂".repeat(128),
  },
];

export const invalidVisionV2Fixtures = [
  {
    name: "rejects-unsupported-protocol",
    message: {
      ...validVisionV2Fixtures[0],
      protocol: "vem.vision.unsupported",
    },
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
    name: "rejects-https-loopback-garment",
    message: {
      ...validVisionV2Fixtures[2],
      payload: {
        ...validVisionV2Fixtures[2].payload,
        garment: {
          ...fastGarment,
          reference: "https://127.0.0.1:65000/media?token=source-token",
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
    name: "rejects-empty-then-duplicate-loopback-token",
    message: {
      ...validVisionV2Fixtures[2],
      payload: {
        ...validVisionV2Fixtures[2].payload,
        garment: {
          ...fastGarment,
          reference:
            "http://127.0.0.1:65000/media/garment?token=&token=source-token",
        },
      },
    },
  },
  {
    name: "rejects-duplicate-loopback-token",
    message: {
      ...validVisionV2Fixtures[2],
      payload: {
        ...validVisionV2Fixtures[2].payload,
        garment: {
          ...fastGarment,
          reference: "http://127.0.0.1:65000/media/garment?token=one&token=two",
        },
      },
    },
  },
  {
    name: "rejects-loopback-extra-query",
    message: {
      ...validVisionV2Fixtures[2],
      payload: {
        ...validVisionV2Fixtures[2].payload,
        garment: {
          ...fastGarment,
          reference:
            "http://127.0.0.1:65000/media/garment?token=source-token&extra=true",
        },
      },
    },
  },
  {
    name: "rejects-loopback-fragment",
    message: {
      ...validVisionV2Fixtures[2],
      payload: {
        ...validVisionV2Fixtures[2].payload,
        garment: {
          ...fastGarment,
          reference:
            "http://127.0.0.1:65000/media/garment?token=source-token#fragment",
        },
      },
    },
  },
  {
    name: "rejects-loopback-port-above-maximum",
    message: {
      ...validVisionV2Fixtures[2],
      payload: {
        ...validVisionV2Fixtures[2].payload,
        garment: {
          ...fastGarment,
          reference: "http://127.0.0.1:65536/media/garment?token=source-token",
        },
      },
    },
  },
  {
    name: "rejects-loopback-five-digit-port-above-maximum",
    message: {
      ...validVisionV2Fixtures[2],
      payload: {
        ...validVisionV2Fixtures[2].payload,
        garment: {
          ...fastGarment,
          reference: "http://127.0.0.1:99999/media/garment?token=source-token",
        },
      },
    },
  },
  {
    name: "rejects-overlong-loopback-token",
    message: {
      ...validVisionV2Fixtures[2],
      payload: {
        ...validVisionV2Fixtures[2].payload,
        garment: {
          ...fastGarment,
          reference: `http://127.0.0.1:65000/media/garment?token=${"x".repeat(513)}`,
        },
      },
    },
  },
  ...[
    ["percent-question", "x%3F"],
    ["percent-ampersand", "x%26"],
    ["percent-fragment", "x%23"],
    ["percent-null", "x%00"],
    ["unicode", "令牌"],
    ["emoji-256", "🙂".repeat(256)],
    ["emoji-257", "🙂".repeat(257)],
    ["ascii-129", "a".repeat(129)],
    ["padding", "base64url="],
  ].map(([name, token]) => ({
    name: `rejects-non-base64url-token-${name}`,
    message: {
      ...validVisionV2Fixtures[2],
      payload: {
        ...validVisionV2Fixtures[2].payload,
        garment: {
          ...fastGarment,
          reference: `http://127.0.0.1:65000/media/garment?token=${token}`,
        },
      },
    },
  })),
  ...[
    ["trailing-line-feed", "\n"],
    ["trailing-carriage-return", "\r"],
    ["trailing-tab", "\t"],
  ].map(([name, suffix]) => ({
    name: `rejects-token-url-${name}`,
    message: {
      ...validVisionV2Fixtures[2],
      payload: {
        ...validVisionV2Fixtures[2].payload,
        garment: {
          ...fastGarment,
          reference: `http://127.0.0.1:65000/media/garment?token=source-token${suffix}`,
        },
      },
    },
  })),
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
  {
    name: "rejects-fractional-byte-size",
    message: {
      ...validVisionV2Fixtures[2],
      payload: {
        ...validVisionV2Fixtures[2].payload,
        garment: { ...fastGarment, byteSize: 1.5 },
      },
    },
  },
  {
    name: "rejects-boolean-byte-size",
    message: {
      ...validVisionV2Fixtures[2],
      payload: {
        ...validVisionV2Fixtures[2].payload,
        garment: { ...fastGarment, byteSize: true },
      },
    },
  },
  {
    name: "rejects-unknown-message-discriminator",
    message: {
      ...validVisionV2Fixtures[0],
      type: "vision.try_on.unknown",
      payload: {},
    },
  },
  {
    name: "rejects-wrong-payload-for-discriminator",
    message: { ...validVisionV2Fixtures[0], payload: {} },
  },
  {
    name: "rejects-extra-envelope-property",
    message: { ...validVisionV2Fixtures[0], unexpected: true },
  },
  {
    name: "rejects-result-without-token",
    message: {
      ...validVisionV2Fixtures[5],
      payload: {
        ...validVisionV2Fixtures[5].payload,
        result: {
          reference: "http://127.0.0.1:39002/results/output",
          digest: `sha256:${digest}`,
          contentType: "image/png",
          byteSize: 4096,
          width: 512,
          height: 768,
        },
      },
    },
  },
  {
    name: "rejects-nil-attempt-uuid",
    message: {
      ...validVisionV2Fixtures[2],
      payload: {
        ...validVisionV2Fixtures[2].payload,
        attemptId: "00000000-0000-0000-0000-000000000000",
      },
    },
  },
  {
    name: "rejects-invalid-garment-digest",
    message: {
      ...validVisionV2Fixtures[2],
      payload: {
        ...validVisionV2Fixtures[2].payload,
        garment: { ...fastGarment, digest: "sha256:not-a-digest" },
      },
    },
  },
  {
    name: "rejects-message-id-over-limit",
    message: { ...validVisionV2Fixtures[0], messageId: "x".repeat(129) },
  },
  {
    name: "rejects-message-id-code-point-over-limit",
    message: { ...validVisionV2Fixtures[0], messageId: "🙂".repeat(129) },
  },
  {
    name: "rejects-capability-code-point-over-limit",
    message: {
      ...validVisionV2Fixtures[1],
      payload: {
        ...validVisionV2Fixtures[1].payload,
        capabilities: ["🙂".repeat(65)],
      },
    },
  },
  {
    name: "rejects-result-dimension-over-limit",
    message: {
      ...validVisionV2Fixtures[5],
      payload: {
        ...validVisionV2Fixtures[5].payload,
        result: {
          reference: "http://127.0.0.1:39002/results/output?token=result-token",
          digest: `sha256:${digest}`,
          contentType: "image/png",
          byteSize: 4096,
          width: 8193,
          height: 768,
        },
      },
    },
  },
  {
    name: "rejects-unknown-attempt-message",
    message: {
      ...validVisionV2Fixtures[0],
      type: "vision.try_on.attempt.unknown",
      payload: { attemptId },
    },
  },
  {
    name: "rejects-extra-capture-property",
    message: {
      ...validVisionV2Fixtures[10],
      payload: { attemptId, unexpected: true },
    },
  },
  {
    name: "rejects-coerced-capture-attempt-id",
    message: {
      ...validVisionV2Fixtures[10],
      payload: { attemptId: 42 },
    },
  },
  {
    name: "rejects-extra-cancel-property",
    message: {
      ...validVisionV2Fixtures[11],
      payload: { attemptId, reason: "user", unexpected: true },
    },
  },
  {
    name: "rejects-wrong-cancel-reason",
    message: {
      ...validVisionV2Fixtures[11],
      payload: { attemptId, reason: "departure" },
    },
  },
  {
    name: "rejects-acquiring-extra-property",
    message: {
      ...validVisionV2Fixtures[12],
      payload: { ...validVisionV2Fixtures[12].payload, percentage: 50 },
    },
  },
  ...[
    ["none", "no_person", false],
    ["multiple", "multiple_people", false],
  ].map(([occupancy, guidance]) => ({
    name: `rejects-${occupancy}-manual-acquisition`,
    message: {
      ...validVisionV2Fixtures[12],
      payload: {
        ...validVisionV2Fixtures[12].payload,
        occupancy,
        guidance,
        manualCaptureAllowed: true,
      },
    },
  })),
  {
    name: "rejects-single-misaligned-manual-acquisition",
    message: {
      ...validVisionV2Fixtures[12],
      payload: {
        ...validVisionV2Fixtures[12].payload,
        guidance: "no_person",
      },
    },
  },
  {
    name: "rejects-acquiring-bad-guidance",
    message: {
      ...validVisionV2Fixtures[12],
      payload: { ...validVisionV2Fixtures[12].payload, guidance: "aligned" },
    },
  },
  {
    name: "rejects-acquiring-bad-occupancy",
    message: {
      ...validVisionV2Fixtures[12],
      payload: { ...validVisionV2Fixtures[12].payload, occupancy: "unknown" },
    },
  },
  {
    name: "rejects-generating-percentage",
    message: {
      ...validVisionV2Fixtures[13],
      payload: { ...validVisionV2Fixtures[13].payload, percentage: 50 },
    },
  },
  {
    name: "rejects-canceled-client-only-reason",
    message: {
      ...validVisionV2Fixtures[14],
      payload: { attemptId, reason: "client" },
    },
  },
  ...[
    [
      "https",
      `https://127.0.0.1:65000/vision/v2/try-on/attempts/${attemptId}/preview.mjpeg?token=preview-token`,
    ],
    [
      "crossorigin",
      `http://192.168.1.2:65000/vision/v2/try-on/attempts/${attemptId}/preview.mjpeg?token=preview-token`,
    ],
    [
      "wrongpath",
      `http://127.0.0.1:65000/other/${attemptId}/preview.mjpeg?token=preview-token`,
    ],
    [
      "extra-query",
      `http://127.0.0.1:65000/vision/v2/try-on/attempts/${attemptId}/preview.mjpeg?token=preview-token&x=1`,
    ],
    [
      "duplicate-token",
      `http://127.0.0.1:65000/vision/v2/try-on/attempts/${attemptId}/preview.mjpeg?token=one&token=two`,
    ],
  ].map(([name, reference]) => ({
    name: `rejects-preview-${name}`,
    message: {
      ...validVisionV2Fixtures[12],
      payload: {
        ...validVisionV2Fixtures[12].payload,
        preview: { reference, streamType: "mjpeg" },
      },
    },
  })),
  {
    name: "rejects-preview-for-different-attempt",
    message: {
      ...validVisionV2Fixtures[12],
      payload: {
        ...validVisionV2Fixtures[12].payload,
        preview: {
          reference:
            "http://127.0.0.1:65000/vision/v2/try-on/attempts/550e8400-e29b-41d4-a716-446655440123/preview.mjpeg?token=preview-token",
          streamType: "mjpeg",
        },
      },
    },
  },
];
