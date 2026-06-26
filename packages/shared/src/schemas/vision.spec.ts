import { describe, expect, it } from "vitest";

import {
  VISION_PROTOCOL,
  visionErrorMessageSchema,
  visionProfileResultMessageSchema,
  visionServerMessageSchema,
  visionClientMessageSchema,
} from "./vision";

const BASE_ENVELOPE = {
  protocol: VISION_PROTOCOL,
  messageId: "msg-001",
  timestamp: "2026-05-25T12:00:00.000Z",
};

describe("vision protocol schemas", () => {
  it("parses a machine hello message", () => {
    const message = visionClientMessageSchema.parse({
      ...BASE_ENVELOPE,
      type: "vision.hello",
      payload: {
        clientRole: "machine",
        machineCode: "M001",
        protocolVersion: 1,
        capabilities: ["profile_push"],
      },
    });

    expect(message.type).toBe("vision.hello");
    expect(message.payload.capabilities).toContain("profile_push");
  });

  it("parses a pushed profile result", () => {
    const message = visionProfileResultMessageSchema.parse({
      ...BASE_ENVELOPE,
      type: "vision.profile_result",
      payload: {
        eventId: "vision-event-001",
        detectedAt: "2026-05-29T12:00:00.000Z",
        profile: {
          personPresent: true,
          heightCm: 172,
          bodyType: "regular",
          confidence: 0.86,
        },
        quality: {
          overall: "good",
          warnings: [],
        },
      },
    });

    expect(message.type).toBe("vision.profile_result");
    expect(message.payload.eventId).toBe("vision-event-001");
    expect(message.payload.profile.heightCm).toBe(172);
  });

  it("does not pass through raw images, identifying model details, or sensitive inference fields", () => {
    const message = visionProfileResultMessageSchema.parse({
      ...BASE_ENVELOPE,
      type: "vision.profile_result",
      payload: {
        eventId: "vision-event-raw",
        detectedAt: "2026-05-29T12:00:00.000Z",
        profile: {
          personPresent: true,
          heightCm: 172,
          bodyType: "regular",
          confidence: 0.86,
          shoulderWidthCm: 43,
          ageRange: "25-34",
          gender: "male",
          rawImageBase64: "data:image/jpeg;base64,raw",
          identity: { id: "customer-1" },
          faceEmbedding: [0.1, 0.2],
        },
        quality: {
          overall: "good",
          warnings: [],
        },
      },
    });

    expect(JSON.stringify(message.payload.profile)).not.toContain("raw");
    expect(JSON.stringify(message.payload.profile)).not.toContain("identity");
    expect(JSON.stringify(message.payload.profile)).not.toContain(
      "faceEmbedding",
    );
    expect(JSON.stringify(message.payload.profile)).not.toContain(
      "shoulderWidthCm",
    );
    expect(JSON.stringify(message.payload.profile)).not.toContain("ageRange");
    expect(JSON.stringify(message.payload.profile)).not.toContain("gender");
  });

  it("rejects impossible height values", () => {
    expect(() =>
      visionServerMessageSchema.parse({
        ...BASE_ENVELOPE,
        type: "vision.profile_result",
        payload: {
          eventId: "vision-event-001",
          detectedAt: "2026-05-29T12:00:00.000Z",
          profile: {
            personPresent: true,
            heightCm: 300,
          },
          quality: {
            overall: "good",
            warnings: [],
          },
        },
      }),
    ).toThrow();
  });

  it("accepts null heightCm and strips deprecated sensitive profile fields", () => {
    const message = visionProfileResultMessageSchema.parse({
      ...BASE_ENVELOPE,
      type: "vision.profile_result",
      payload: {
        eventId: "vision-event-002",
        detectedAt: "2026-06-03T12:00:00.000Z",
        profile: {
          personPresent: true,
          heightCm: null,
          shoulderWidthCm: null,
          ageRange: "unknown",
          gender: "unknown",
          bodyType: "unknown",
        },
        quality: {
          overall: "low_confidence",
          warnings: ["image_too_dark"],
        },
      },
    });

    expect(message.payload.profile.heightCm).toBeNull();
    expect("shoulderWidthCm" in message.payload.profile).toBe(false);
    expect("ageRange" in message.payload.profile).toBe(false);
    expect("gender" in message.payload.profile).toBe(false);
  });

  it("accepts fair quality profile results from the real vision service", () => {
    const message = visionProfileResultMessageSchema.parse({
      ...BASE_ENVELOPE,
      type: "vision.profile_result",
      payload: {
        eventId: "vision-event-003",
        detectedAt: "2026-06-11T09:43:59.000Z",
        profile: {
          personPresent: true,
          heightCm: null,
          shoulderWidthCm: null,
          ageRange: "adult",
          gender: "female",
          bodyType: "unknown",
          confidence: 0.54,
        },
        quality: {
          overall: "fair",
          warnings: ["partial_body"],
        },
      },
    });

    expect(message.payload.quality.overall).toBe("fair");
    expect(message.payload.profile.confidence).toBe(0.54);
  });

  it("parses standard errors", () => {
    const message = visionErrorMessageSchema.parse({
      ...BASE_ENVELOPE,
      type: "vision.error",
      payload: {
        eventId: "vision-event-001",
        code: "camera_unavailable",
        message: "camera open failed",
        retryable: true,
      },
    });

    expect(message.type).toBe("vision.error");
    expect(message.payload.retryable).toBe(true);
  });
});
