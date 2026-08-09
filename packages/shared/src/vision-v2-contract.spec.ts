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
});
