import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  automaticSerialEvidence,
  isReplacementSessionB3,
  replaceEnvironmentSerialHandoff,
  serialFramesSince,
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

  it("treats a reset evidence window as a fresh automatic-vent increment", () => {
    const evidence = {
      rawFrames: [
        {
          sessionId: "serial-replacement",
          parsedOpcode: "B3",
          rawFrameHex: "55b302",
        },
      ],
    };

    assert.deepEqual(serialFramesSince(evidence, 5), evidence.rawFrames);
    assert.deepEqual(automaticSerialEvidence(evidence, 5), {
      b3FrameCountDelta: 1,
      protocolFrames: ["B3"],
    });
  });

  it("requires B3 evidence from the replacement serial session", () => {
    const frame = {
      sessionId: "serial-replacement",
      parsedOpcode: "B3",
      rawFrameHex: "55b302",
    };

    assert.equal(isReplacementSessionB3(frame, "serial-replacement", 2), true);
    assert.equal(isReplacementSessionB3(frame, "serial-stale", 2), false);
  });

  it("replaces the serial session published by the current handoff", async () => {
    const handoffPath = join(
      mkdtempSync(join(tmpdir(), "vem-environment-handoff-")),
      "handoff.json",
    );
    const handoff = { commissioningSerialSession: { sessionId: "serial-old" } };
    const calls = [];
    const replacement = await replaceEnvironmentSerialHandoff({
      guestInput: {
        runId: "RUN-92",
        machineCode: "VEM-92",
        hostControlPlane: {
          targetIdentity: "vm-target://92",
          runtimeBaseIdentity: "runtime-base://92",
        },
      },
      handoff,
      handoffPath,
      controlRequest: async (_input, path) => {
        calls.push(path);
        return path.endsWith("/start")
          ? { sessionId: "serial-replacement" }
          : { aborted: true };
      },
    });

    assert.deepEqual(calls, [
      "/v1/serial-sessions/serial-old/abort",
      "/v1/serial-sessions/start",
    ]);
    assert.deepEqual(replacement, {
      previousControlPlaneSessionId: "serial-old",
      replacementControlPlaneSessionId: "serial-replacement",
      aborted: { aborted: true },
    });
    assert.equal(
      JSON.parse(readFileSync(handoffPath, "utf8")).commissioningSerialSession
        .sessionId,
      "serial-replacement",
    );
  });
});
