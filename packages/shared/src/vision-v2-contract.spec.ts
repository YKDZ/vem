import Ajv from "ajv/dist/2020";
import { describe, expect, it } from "vitest";

import {
  invalidVisionV2ClientFixtures,
  invalidVisionV2ServerFixtures,
  validVisionV2ClientFixtures,
  validVisionV2ServerFixtures,
} from "./fixtures/vision-v2";
import {
  visionV2ClientMessageSchema,
  visionV2ServerMessageSchema,
} from "./schemas/vision-v2";

const validators = {
  client: visionV2ClientMessageSchema,
  server: visionV2ServerMessageSchema,
} as const;

describe("Vision V2 shared contract", () => {
  it("accepts each explicitly directed corpus and rejects its reverse direction", () => {
    for (const [direction, fixtures] of Object.entries({
      client: validVisionV2ClientFixtures,
      server: validVisionV2ServerFixtures,
    }) as Array<[keyof typeof validators, readonly object[]]>) {
      const opposite = direction === "client" ? "server" : "client";
      for (const fixture of fixtures) {
        expect(validators[direction].parse(fixture)).toMatchObject({
          protocol: "vem.vision.v2",
        });
        expect(() => validators[opposite].parse(fixture)).toThrow();
      }
    }
  });

  it("exports the acquisition manual-action truth table without private semantics", () => {
    const acquiring = validVisionV2ServerFixtures.filter(
      (fixture) => fixture.type === "vision.try_on.attempt.acquiring",
    );
    expect(acquiring.map((fixture) => fixture.payload)).toEqual([
      expect.objectContaining({
        occupancy: "none",
        guidance: "no_person",
        manualCaptureAllowed: false,
      }),
      expect.objectContaining({
        occupancy: "multiple",
        guidance: "multiple_people",
        manualCaptureAllowed: false,
      }),
      expect.objectContaining({
        occupancy: "single",
        guidance: "align",
        manualCaptureAllowed: false,
      }),
      expect.objectContaining({
        occupancy: "single",
        guidance: "counting_down",
        manualCaptureAllowed: true,
        holdRemainingMs: 1500,
      }),
    ]);
  });

  it("publishes one mode-free attempt contract and the exact captured source frame", () => {
    const start = structuredClone(validVisionV2ClientFixtures[1]);
    delete start.payload.mode;
    expect(visionV2ClientMessageSchema.parse(start)).toMatchObject({
      type: "vision.try_on.attempt.start",
      payload: { attemptId: start.payload.attemptId },
    });

    const captured = {
      protocol: "vem.vision.v2",
      messageId: "captured-source-frame",
      timestamp: "2026-08-20T00:00:00.000Z",
      type: "vision.try_on.attempt.captured",
      payload: {
        attemptId: start.payload.attemptId,
        captured: {
          reference:
            "http://127.0.0.1:65000/v2/try-on/captured/frame.png?token=captured-token",
          digest: `sha256:${"b".repeat(64)}`,
          contentType: "image/png",
          byteSize: 4096,
          width: 512,
          height: 768,
          frameId: "frame-000042",
        },
      },
    };
    expect(visionV2ServerMessageSchema.parse(captured)).toMatchObject(captured);

    const legacyMode = structuredClone(start);
    legacyMode.payload.mode = "fast";
    expect(() => visionV2ClientMessageSchema.parse(legacyMode)).toThrow();

    const legacyAiReady = structuredClone(validVisionV2ServerFixtures[0]);
    legacyAiReady.payload.aiReady = false;
    expect(() => visionV2ServerMessageSchema.parse(legacyAiReady)).toThrow();
  });

  it("rejects every single-mutation fixture in its declared direction with Zod and standalone Ajv", () => {
    for (const [direction, fixtures] of Object.entries({
      client: invalidVisionV2ClientFixtures,
      server: invalidVisionV2ServerFixtures,
    }) as Array<
      [
        keyof typeof validators,
        readonly { base: object; message: object; field: string }[],
      ]
    >) {
      const schema = validators[direction].toJSONSchema();
      const ajv = new Ajv({ strict: false, validateFormats: false }).compile(
        schema,
      );
      for (const fixture of fixtures) {
        expect(validators[direction].safeParse(fixture.base).success).toBe(
          true,
        );
        expect(validators[direction].safeParse(fixture.message).success).toBe(
          false,
        );
        expect(ajv(fixture.message)).toBe(false);
      }
    }
  });
});
