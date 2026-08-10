import Ajv from "ajv/dist/2020";
import { describe, expect, it } from "vitest";

import {
  invalidVisionV2Fixtures,
  validVisionV2Fixtures,
} from "./fixtures/vision-v2";
import {
  VISION_V2_BUNDLE_VERSION,
  visionV2MessageSchema,
} from "./schemas/vision-v2";

describe("Vision V2 shared contract", () => {
  it("accepts the Fast tracer fixture corpus", () => {
    for (const fixture of validVisionV2Fixtures) {
      expect(visionV2MessageSchema.parse(fixture)).toMatchObject({
        protocol: "vem.vision.v2",
      });
    }
  });

  it("requires the generated bundle identity in both handshake directions", () => {
    const hello = visionV2MessageSchema.parse(validVisionV2Fixtures[0]);
    const ready = visionV2MessageSchema.parse(validVisionV2Fixtures[1]);

    expect(hello).toMatchObject({
      type: "vision.hello",
      payload: {
        schemaVersion: "vem-vision-v2-contract-bundle/v1",
        bundleVersion: VISION_V2_BUNDLE_VERSION,
      },
    });
    expect(ready).toMatchObject({
      type: "vision.ready",
      payload: {
        schemaVersion: "vem-vision-v2-contract-bundle/v1",
        bundleVersion: VISION_V2_BUNDLE_VERSION,
      },
    });
  });

  it("rejects V1, AI, and non-loopback source fixtures", () => {
    for (const fixture of invalidVisionV2Fixtures) {
      expect(() => visionV2MessageSchema.parse(fixture.message)).toThrow();
    }
  });

  it("publishes Unicode code-point bounds to standalone JSON Schema", () => {
    const schema = visionV2MessageSchema.toJSONSchema();
    const ready = schema.oneOf.find(
      (branch) => branch.properties.type.const === "vision.ready",
    );
    if (!ready) throw new Error("expected vision.ready schema branch");

    expect(ready.properties.messageId).toMatchObject({
      minLength: 1,
      maxLength: 128,
    });
    expect(ready.properties.payload.properties.serverVersion).toMatchObject({
      minLength: 1,
      maxLength: 64,
    });
    expect(
      ready.properties.payload.properties.capabilities.items,
    ).toMatchObject({
      minLength: 1,
      maxLength: 64,
    });

    const validate = new Ajv({ strict: false, validateFormats: false }).compile(
      schema,
    );
    expect(validate(validVisionV2Fixtures.at(-1))).toBe(true);
    for (const fixture of invalidVisionV2Fixtures.filter((fixture) =>
      fixture.name.includes("code-point-over-limit"),
    )) {
      expect(validate(fixture.message)).toBe(false);
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
