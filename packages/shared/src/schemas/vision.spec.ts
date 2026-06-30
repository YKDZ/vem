import { describe, expect, it } from "vitest";

import {
  VISION_PROTOCOL,
  visionErrorMessageSchema,
  visionPersonDepartedMessageSchema,
  visionPresenceStatusMessageSchema,
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
        capabilities: [
          "profile_push",
          "presence_status",
          "person_departed",
          "ambient_light",
        ],
      },
    });

    expect(message.type).toBe("vision.hello");
    expect(message.payload.capabilities).toContain("profile_push");
    expect(message.payload.capabilities).toContain("person_departed");
    expect(message.payload.capabilities).toContain("ambient_light");
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

  it("parses a pushed presence status from the real vision service", () => {
    const message = visionPresenceStatusMessageSchema.parse({
      ...BASE_ENVELOPE,
      type: "vision.presence_status",
      payload: {
        eventId: "presence-event-001",
        state: "approach",
        reason: "person_present_but_not_close",
        detectedAt: "2026-06-29T10:00:00.000Z",
        personPresent: true,
        closeNow: false,
        close: false,
        closeTrigger: null,
        proximity: {
          present: true,
          close: false,
          closeNow: false,
          largestPersonRatio: 0.12,
        },
        ambientLight: {
          level: "dim",
          measuredAt: "2026-06-29T10:00:00.000Z",
          source: "camera",
          confidence: 0.82,
          sample: {
            lumaMean: 74.5,
          },
        },
      },
    });

    expect(message.type).toBe("vision.presence_status");
    expect(message.payload.state).toBe("approach");
    expect(message.payload.personPresent).toBe(true);
    expect(message.payload.ambientLight?.level).toBe("dim");
    expect(message.payload.ambientLight?.sample?.lumaMean).toBe(74.5);
  });

  it("parses a pushed person departed event", () => {
    const message = visionPersonDepartedMessageSchema.parse({
      ...BASE_ENVELOPE,
      type: "vision.person_departed",
      payload: {
        eventId: "departure-event-001",
        detectedAt: "2026-06-29T10:03:30.000Z",
        lastSeenAt: "2026-06-29T10:03:10.000Z",
        reason: "left_frame",
        absenceDurationMs: 1200,
        ambientLight: {
          level: "bright",
          measuredAt: "2026-06-29T10:03:30.000Z",
          source: "camera",
          confidence: 0.91,
        },
      },
    });

    expect(message.type).toBe("vision.person_departed");
    expect(message.payload.reason).toBe("left_frame");
    expect(message.payload.lastSeenAt).toBe("2026-06-29T10:03:10.000Z");
  });

  it("rejects unknown ambient light levels", () => {
    expect(() =>
      visionServerMessageSchema.parse({
        ...BASE_ENVELOPE,
        type: "vision.presence_status",
        payload: {
          eventId: "presence-event-001",
          state: "approach",
          detectedAt: "2026-06-29T10:00:00.000Z",
          personPresent: true,
          proximity: {},
          ambientLight: {
            level: "night",
            measuredAt: "2026-06-29T10:00:00.000Z",
          },
        },
      }),
    ).toThrow();
  });

  it("rejects malformed presence status payloads", () => {
    expect(() =>
      visionServerMessageSchema.parse({
        ...BASE_ENVELOPE,
        type: "vision.presence_status",
        payload: {
          eventId: "presence-event-001",
          state: "empty",
          detectedAt: "2026-06-29T10:00:00.000Z",
        },
      }),
    ).toThrow();
  });

  it("passes through real vision profile fields but strips raw images and identity fields", () => {
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
          ageRange: "adult",
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
    expect(message.payload.profile.shoulderWidthCm).toBe(43);
    expect(message.payload.profile.ageRange).toBe("adult");
    expect(message.payload.profile.gender).toBe("male");
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

  it("accepts null heightCm and real optional profile fields", () => {
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
    expect(message.payload.profile.shoulderWidthCm).toBeNull();
    expect(message.payload.profile.ageRange).toBe("unknown");
    expect(message.payload.profile.gender).toBe("unknown");
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
