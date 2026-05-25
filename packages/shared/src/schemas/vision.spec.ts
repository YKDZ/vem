import { describe, expect, it } from "vitest";

import {
  VISION_PROTOCOL,
  visionErrorMessageSchema,
  visionProfileResultMessageSchema,
  visionServerMessageSchema,
  visionStartProfileMessageSchema,
} from "./vision";

const BASE_ENVELOPE = {
  protocol: VISION_PROTOCOL,
  messageId: "msg-001",
  timestamp: "2026-05-25T12:00:00.000Z",
};

describe("vision protocol schemas", () => {
  it("parses a start profile request with defaults", () => {
    const message = visionStartProfileMessageSchema.parse({
      ...BASE_ENVELOPE,
      type: "vision.start_profile",
      payload: {
        sessionId: "vision-session-001",
        trigger: "human_presence",
      },
    });

    expect(message.type).toBe("vision.start_profile");
    expect(message.payload.timeoutMs).toBe(8000);
    expect(message.payload.requested).toContain("heightCm");
  });

  it("parses a successful profile result", () => {
    const message = visionProfileResultMessageSchema.parse({
      ...BASE_ENVELOPE,
      type: "vision.profile_result",
      payload: {
        sessionId: "vision-session-001",
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
        startedAt: "2026-05-25T12:00:00.000Z",
        completedAt: "2026-05-25T12:00:03.000Z",
      },
    });

    expect(message.type).toBe("vision.profile_result");
    expect(message.payload.profile.heightCm).toBe(172);
  });

  it("rejects impossible height values", () => {
    expect(() =>
      visionServerMessageSchema.parse({
        ...BASE_ENVELOPE,
        type: "vision.profile_result",
        payload: {
          sessionId: "vision-session-001",
          profile: {
            personPresent: true,
            heightCm: 300,
          },
          quality: {
            overall: "good",
            warnings: [],
          },
          startedAt: "2026-05-25T12:00:00.000Z",
          completedAt: "2026-05-25T12:00:03.000Z",
        },
      }),
    ).toThrow();
  });

  it("parses standard errors", () => {
    const message = visionErrorMessageSchema.parse({
      ...BASE_ENVELOPE,
      type: "vision.error",
      payload: {
        sessionId: "vision-session-001",
        code: "camera_unavailable",
        message: "camera open failed",
        retryable: true,
      },
    });

    expect(message.type).toBe("vision.error");
    expect(message.payload.retryable).toBe(true);
  });
});
