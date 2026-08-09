import { describe, expect, it } from "vitest";

import {
  invalidVisionV2Fixtures,
  validVisionV2Fixtures,
} from "./fixtures/vision-v2";
import { visionV2MessageSchema } from "./schemas/vision-v2";

describe("Vision V2 shared contract", () => {
  it("accepts the Fast tracer fixture corpus", () => {
    for (const fixture of validVisionV2Fixtures) {
      expect(visionV2MessageSchema.parse(fixture)).toMatchObject({
        protocol: "vem.vision.v2",
      });
    }
  });

  it("rejects V1, AI, and non-loopback source fixtures", () => {
    for (const fixture of invalidVisionV2Fixtures) {
      expect(() => visionV2MessageSchema.parse(fixture.message)).toThrow();
    }
  });

  it("accepts only tokenized loopback ports from 1 through 65535", () => {
    const start = validVisionV2Fixtures[2];
    const garment = (start.payload as { garment: Record<string, unknown> })
      .garment;
    const withReference = (reference: string) => ({
      ...start,
      payload: { ...start.payload, garment: { ...garment, reference } },
    });

    expect(
      visionV2MessageSchema.parse(
        withReference("http://127.0.0.1:65535/garment?token=opaque"),
      ),
    ).toMatchObject({ type: "vision.try_on.attempt.start" });
    for (const port of [0, 65536, 99999]) {
      expect(() =>
        visionV2MessageSchema.parse(
          withReference(`http://127.0.0.1:${port}/garment?token=opaque`),
        ),
      ).toThrow();
    }
  });
});
