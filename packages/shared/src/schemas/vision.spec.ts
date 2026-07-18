import { describe, expect, it } from "vitest";

import {
  VISION_PROTOCOL,
  visionErrorMessageSchema,
  visionPersonDepartedMessageSchema,
  visionPresenceStatusMessageSchema,
  visionProfileResultMessageSchema,
  visionServerMessageSchema,
  visionClientMessageSchema,
  visionTryOnStartedMessageSchema,
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
        capabilities: ["profile_push", "presence_status", "person_departed"],
      },
    });

    expect(message.type).toBe("vision.hello");
    expect(message.payload.capabilities).toContain("profile_push");
    expect(message.payload.capabilities).toContain("person_departed");
  });

  it("parses try-on session control messages", () => {
    const start = visionClientMessageSchema.parse({
      ...BASE_ENVELOPE,
      type: "vision.try_on.start",
      payload: {
        sessionId: "try-on-session-001",
        catalogKey: "catalog-001",
        variantId: "variant-001",
      },
    });
    const stop = visionClientMessageSchema.parse({
      ...BASE_ENVELOPE,
      type: "vision.try_on.stop",
      payload: {
        sessionId: "try-on-session-001",
        reason: "user_exit",
      },
    });

    expect(start.type).toBe("vision.try_on.start");
    expect(stop.type).toBe("vision.try_on.stop");
  });

  it("parses a try-on started message with an MJPEG preview URL", () => {
    const message = visionTryOnStartedMessageSchema.parse({
      ...BASE_ENVELOPE,
      type: "vision.try_on.started",
      payload: {
        sessionId: "try-on-session-001",
        previewUrl: "http://127.0.0.1:7892/try-on/session-001.mjpeg",
        streamType: "mjpeg",
        sourceFrame: {
          adapter: "recorded_video",
          role: "front",
          configSha256: "a".repeat(64),
          fixtureSha256: "b".repeat(64),
          frameIndex: 18,
          decodedFrameCount: 19,
          synthetic: false,
          relabeled: false,
          sessionId: "try-on-session-001",
        },
      },
    });

    expect(message.type).toBe("vision.try_on.started");
    expect(message.payload.streamType).toBe("mjpeg");
    expect(message.payload.sourceFrame?.decodedFrameCount).toBe(19);
  });

  it("accepts only the fixed local Vision loopback preview origin", () => {
    for (const previewUrl of [
      "http://127.0.0.1:7892/try-on/session.mjpeg",
      "http://localhost:7892/try-on/session.mjpeg",
      "http://[::1]:7892/try-on/session.mjpeg",
    ]) {
      expect(() =>
        visionTryOnStartedMessageSchema.parse({
          ...BASE_ENVELOPE,
          type: "vision.try_on.started",
          payload: {
            sessionId: "try-on-session-001",
            previewUrl,
            streamType: "mjpeg",
          },
        }),
      ).not.toThrow();
    }

    for (const previewUrl of [
      "https://vision.example/try-on/session.mjpeg",
      "http://127.0.0.1:8080/try-on/session.mjpeg",
      "https://127.0.0.1:7892/try-on/session.mjpeg",
      "http://user@127.0.0.1:7892/try-on/session.mjpeg",
    ]) {
      expect(() =>
        visionTryOnStartedMessageSchema.parse({
          ...BASE_ENVELOPE,
          type: "vision.try_on.started",
          payload: {
            sessionId: "try-on-session-001",
            previewUrl,
            streamType: "mjpeg",
          },
        }),
      ).toThrow();
    }
  });

  it("parses a pushed profile result", () => {
    const message = visionProfileResultMessageSchema.parse({
      ...BASE_ENVELOPE,
      type: "vision.profile_result",
      payload: {
        source: "front",
        eventId: "vision-event-001",
        detectedAt: "2026-05-29T12:00:00.000Z",
        sourceFrame: {
          adapter: "recorded_video",
          role: "front",
          configSha256: "a".repeat(64),
          fixtureSha256: "b".repeat(64),
          frameIndex: 12,
          decodedFrameCount: 13,
          synthetic: false,
          relabeled: false,
          eventId: "vision-event-001",
        },
        profile: {
          personPresent: true,
          heightCm: 172,
          bodyType: "regular",
          confidence: 0.86,
        },
        quality: {
          overall: "good",
          warnings: [],
          profileUsable: true,
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
        source: "top",
        eventId: "presence-event-001",
        state: "approach",
        reason: "person_present_but_not_close",
        detectedAt: "2026-06-29T10:00:00.000Z",
        sourceFrame: {
          adapter: "recorded_video",
          role: "top",
          configSha256: "a".repeat(64),
          fixtureSha256: "c".repeat(64),
          frameIndex: 4,
          decodedFrameCount: 5,
          synthetic: false,
          relabeled: false,
          eventId: "presence-event-001",
        },
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
      },
    });

    expect(message.type).toBe("vision.presence_status");
    expect(message.payload.state).toBe("approach");
    expect(message.payload.personPresent).toBe(true);
  });

  it("parses presence occupancy without requiring a precise headcount", () => {
    const message = visionPresenceStatusMessageSchema.parse({
      ...BASE_ENVELOPE,
      type: "vision.presence_status",
      payload: {
        source: "top",
        eventId: "presence-event-multiple",
        state: "approach",
        reason: "multiple_people_present",
        detectedAt: "2026-06-29T10:00:00.000Z",
        personPresent: true,
        occupancy: {
          state: "multiple",
          confidence: 0.89,
        },
        proximity: {
          present: true,
        },
      },
    });

    expect(message.payload.personPresent).toBe(true);
    expect(message.payload.occupancy?.state).toBe("multiple");
  });

  it("parses a pushed person departed event", () => {
    const message = visionPersonDepartedMessageSchema.parse({
      ...BASE_ENVELOPE,
      type: "vision.person_departed",
      payload: {
        source: "top",
        eventId: "departure-event-001",
        detectedAt: "2026-06-29T10:03:30.000Z",
        lastSeenAt: "2026-06-29T10:03:10.000Z",
        reason: "left_frame",
        absenceDurationMs: 1200,
        sourceFrame: {
          adapter: "recorded_video",
          role: "top",
          configSha256: "a".repeat(64),
          fixtureSha256: "c".repeat(64),
          frameIndex: 17,
          decodedFrameCount: 18,
          synthetic: false,
          relabeled: false,
          eventId: "departure-event-001",
        },
      },
    });

    expect(message.type).toBe("vision.person_departed");
    expect(message.payload.reason).toBe("left_frame");
    expect(message.payload.lastSeenAt).toBe("2026-06-29T10:03:10.000Z");
  });

  it("rejects synthetic frame-source evidence in protocol payloads", () => {
    expect(() =>
      visionPresenceStatusMessageSchema.parse({
        ...BASE_ENVELOPE,
        type: "vision.presence_status",
        payload: {
          source: "top",
          eventId: "presence-event-synthetic",
          detectedAt: "2026-06-29T10:00:00.000Z",
          state: "approach",
          personPresent: true,
          sourceFrame: {
            adapter: "recorded_video",
            role: "top",
            configSha256: "a".repeat(64),
            fixtureSha256: "c".repeat(64),
            frameIndex: 0,
            decodedFrameCount: 1,
            synthetic: true,
          },
        },
      }),
    ).toThrow();
  });

  it("marks multiple-person profile results as machine-readable unusable", () => {
    const message = visionProfileResultMessageSchema.parse({
      ...BASE_ENVELOPE,
      type: "vision.profile_result",
      payload: {
        source: "front",
        eventId: "vision-event-multiple",
        detectedAt: "2026-06-29T10:00:00.000Z",
        occupancy: {
          state: "multiple",
          confidence: 0.91,
        },
        profile: {
          personPresent: true,
          heightCm: 172,
          bodyType: "regular",
          confidence: 0.86,
        },
        quality: {
          overall: "poor",
          warnings: ["multiple_people"],
          profileUsable: false,
          notUsableReason: "multiple_people",
        },
      },
    });

    expect(message.payload.occupancy?.state).toBe("multiple");
    expect(message.payload.quality.profileUsable).toBe(false);
    expect(message.payload.quality.notUsableReason).toBe("multiple_people");
  });

  it("rejects malformed presence status payloads", () => {
    expect(() =>
      visionServerMessageSchema.parse({
        ...BASE_ENVELOPE,
        type: "vision.presence_status",
        payload: {
          source: "top",
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
        source: "front",
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
          profileUsable: true,
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
          source: "front",
          eventId: "vision-event-001",
          detectedAt: "2026-05-29T12:00:00.000Z",
          profile: {
            personPresent: true,
            heightCm: 300,
          },
          quality: {
            overall: "good",
            warnings: [],
            profileUsable: true,
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
        source: "front",
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
          profileUsable: false,
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
        source: "front",
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
          profileUsable: true,
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
