import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  automaticSerialEvidence,
  unwrapServiceApiEnvelope,
} from "./environment-control-guest-full.mjs";

describe("environment control guest full", () => {
  it("unwraps successful Service API envelopes", () => {
    const data = { commandNo: 42, status: "accepted" };

    assert.deepEqual(
      unwrapServiceApiEnvelope({ code: 0, message: "ok", data }),
      data,
    );
  });

  it("preserves raw payloads and non-success envelopes", () => {
    const raw = { ready: true };
    const failure = { code: 1001, message: "rejected", data: raw };

    assert.strictEqual(unwrapServiceApiEnvelope(raw), raw);
    assert.strictEqual(unwrapServiceApiEnvelope(failure), failure);
  });

  it("preserves every lower-controller opcode for an automatic intent", () => {
    const evidence = {
      rawFrames: [
        { parsedOpcode: "B3" },
        { parsedOpcode: "B1" },
        { parsedOpcode: "B2" },
      ],
    };

    assert.deepEqual(automaticSerialEvidence(evidence, 0), {
      b3FrameCountDelta: 1,
      protocolFrames: ["B3", "B1", "B2"],
    });
  });
});
