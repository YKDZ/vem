import { visionV2ServerMessageSchema } from "@vem/shared";
import { describe, expect, it } from "vitest";

import { validateTryOnCapturedFrame } from "./eligibility";

const attemptId = "550e8400-e29b-41d4-a716-446655440124";
const digest = `sha256:${"a".repeat(64)}`;

describe("Machine single virtual try-on contract", () => {
  it("accepts the Vision-owned captured source only from the attempt socket", () => {
    const event = visionV2ServerMessageSchema.parse({
      protocol: "vem.vision.v2",
      messageId: "captured-contract",
      timestamp: "2026-08-20T00:00:00.000Z",
      type: "vision.try_on.attempt.captured",
      payload: {
        attemptId,
        captured: {
          reference:
            "http://127.0.0.1:65000/v2/try-on/captured/frame.png?token=captured-token",
          digest,
          contentType: "image/png",
          byteSize: 4096,
          width: 512,
          height: 768,
          frameId: "frame-42",
        },
      },
    });

    expect(event.type).toBe("vision.try_on.attempt.captured");
    if (event.type !== "vision.try_on.attempt.captured")
      throw new Error("wrong event");
    expect(
      validateTryOnCapturedFrame(event.payload.captured, {
        attemptId,
        visionSocketUrl: "ws://127.0.0.1:65000/v2/ws",
      }),
    ).toMatchObject({ digest, frameId: "frame-42", width: 512, height: 768 });
  });

  it("rejects a captured frame issued by another loopback listener", () => {
    expect(() =>
      validateTryOnCapturedFrame(
        {
          reference:
            "http://127.0.0.1:65001/v2/try-on/captured/frame.png?token=captured-token",
          digest,
          contentType: "image/png",
          byteSize: 4096,
          width: 512,
          height: 768,
          frameId: "frame-42",
        },
        { attemptId, visionSocketUrl: "ws://127.0.0.1:65000/v2/ws" },
      ),
    ).toThrow("unsafe captured");
  });
});
