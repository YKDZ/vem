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
        guidance: "hold_still",
        manualCaptureAllowed: true,
      }),
      expect.objectContaining({
        occupancy: "single",
        guidance: "ready",
        manualCaptureAllowed: false,
      }),
    ]);
  });

  it("accepts an independently selected AI attempt and AI readiness fact", () => {
    const aiStart = structuredClone(validVisionV2ClientFixtures[1]);
    aiStart.payload.mode = "ai";
    expect(visionV2ClientMessageSchema.parse(aiStart)).toMatchObject({
      type: "vision.try_on.attempt.start",
      payload: { mode: "ai" },
    });

    const ready = structuredClone(validVisionV2ServerFixtures[0]);
    ready.payload.aiReady = true;
    ready.payload.capabilities = ["try_on_fast", "try_on_ai"];
    expect(visionV2ServerMessageSchema.parse(ready)).toMatchObject({
      payload: { fastReady: true, aiReady: true },
    });
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
