import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  automaticSerialEvidence,
  collectAutomaticVentPrecedence,
  isReplacementSessionB3,
  waitForExpectedProtocolFrame,
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

  it("uses frame count only for legacy evidence without a sequence cursor", () => {
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

  it("does not treat a sequence rollback as fresh command evidence", () => {
    const beforeCursor = { frameCount: 64, lastSequence: 64 };
    const evidence = {
      rawFrames: [
        {
          boundaryId: "host-pty:serial-replacement:1",
          parsedOpcode: "B3",
          rawFrameHex: "55b302",
        },
      ],
    };

    assert.deepEqual(serialFramesSince(evidence, beforeCursor), []);
    assert.deepEqual(automaticSerialEvidence(evidence, beforeCursor), {
      b3FrameCountDelta: 0,
      protocolFrames: [],
    });
  });

  it("tracks new automatic frames by sequence when the 64-frame evidence window rolls", () => {
    const beforeCursor = { frameCount: 64, lastSequence: 64 };
    const evidence = {
      rawFrames: [
        {
          boundaryId: "host-pty:serial-replacement:64",
          parsedOpcode: "B3",
          rawFrameHex: "55b303",
        },
        {
          boundaryId: "host-pty:serial-replacement:65",
          parsedOpcode: "B3",
          rawFrameHex: "55b302",
        },
      ],
    };

    assert.deepEqual(serialFramesSince(evidence, beforeCursor), [
      evidence.rawFrames[1],
    ]);
    assert.deepEqual(automaticSerialEvidence(evidence, beforeCursor), {
      b3FrameCountDelta: 1,
      protocolFrames: ["B3"],
    });
  });

  it("falls back to frame count when fresh frames do not carry sequence metadata", () => {
    const beforeCursor = { frameCount: 1, lastSequence: 9 };
    const evidence = {
      rawFrames: [
        {
          boundaryId: "host-pty:serial-replacement:9",
          parsedOpcode: "AB",
          rawFrameHex: "55ab",
        },
        {
          sessionId: "serial-replacement",
          parsedOpcode: "B3",
          rawFrameHex: "55b302",
        },
      ],
    };

    assert.deepEqual(serialFramesSince(evidence, beforeCursor), [
      evidence.rawFrames[1],
    ]);
    assert.deepEqual(automaticSerialEvidence(evidence, beforeCursor), {
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

  it("waits for the requested B3 speed before advancing", async () => {
    const evidenceResponses = [
      {
        rawFrames: [
          {
            sessionId: "serial-replacement",
            parsedOpcode: "B3",
            rawFrameHex: "55b302",
          },
        ],
      },
      {
        rawFrames: [
          {
            sessionId: "serial-replacement",
            parsedOpcode: "B3",
            rawFrameHex: "55b302",
          },
          {
            sessionId: "serial-replacement",
            parsedOpcode: "B3",
            rawFrameHex: "55b303",
          },
        ],
      },
    ];

    const observed = await waitForExpectedProtocolFrame({
      guestInput: {},
      sessionId: "serial-replacement",
      beforeFrameCount: 0,
      expectedOpcode: "B3",
      expectedSpeed: 3,
      pollMs: 0,
      timeoutMs: 100,
      controlRequest: async () => evidenceResponses.shift(),
    });

    assert.equal(observed.frame.rawFrameHex, "55b303");
  });

  it("resets vent speed to zero before collecting automatic vent precedence", async () => {
    const report = {
      commands: [],
      daemon: { automaticVent: { outcomes: [] } },
      precedence: null,
    };
    const calls = [];
    let commandNo = 0;
    const commandEnvironmentRequest = async ({ action, body }) => {
      calls.push({ kind: "command", action, body });
      commandNo += 1;
      return {
        action,
        request: body,
        admin: { commandNo: `command-${commandNo}`, status: "sent" },
        result: { status: "succeeded" },
        mqtt: {
          commandNo: `command-${commandNo}`,
          resultCommandNo: `command-${commandNo}`,
        },
        serial: {
          protocolFrame: {
            sessionId: "serial-replacement",
            parsedOpcode: "B3",
            rawFrameHex: `55b30${body.ventSpeed}`,
          },
        },
      };
    };
    const requestAutomaticVentIntentRequest = async ({ edgeId, ventSpeed }) => {
      calls.push({ kind: "automatic", edgeId, ventSpeed });
      if (edgeId.endsWith(":arrival")) {
        return {
          edgeId,
          requestedSpeed: ventSpeed,
          outcome: "accepted",
          beforeFrameCount: 1,
          b3FrameCountDelta: 1,
          protocolFrames: ["B3"],
          frame: {
            sessionId: "serial-replacement",
            parsedOpcode: "B3",
            rawFrameHex: "55b302",
          },
        };
      }
      if (edgeId.endsWith(":departure")) {
        return {
          edgeId,
          requestedSpeed: ventSpeed,
          outcome: "accepted",
          beforeFrameCount: 3,
          b3FrameCountDelta: 1,
          protocolFrames: ["B3"],
          frame: {
            sessionId: "serial-replacement",
            parsedOpcode: "B3",
            rawFrameHex: "55b300",
          },
        };
      }
      return {
        edgeId,
        requestedSpeed: ventSpeed,
        outcome: "deduplicated",
        beforeFrameCount: 2,
        b3FrameCountDelta: 0,
        protocolFrames: [],
      };
    };
    const observeAdminOverrideGuardRequest = async ({ beforeFrameCount }) => {
      calls.push({ kind: "guard", beforeFrameCount });
      return {
        completed: true,
        durationMs: 5_000,
        b3FrameCountDelta: 0,
        protocolFrames: [],
      };
    };

    const result = await collectAutomaticVentPrecedence({
      guestInput: {},
      handoff: {},
      token: "admin-token",
      machineId: "machine-1",
      sessionId: "serial-replacement",
      runId: "RUN-1784767229481",
      report,
      commandEnvironmentRequest,
      requestAutomaticVentIntentRequest,
      observeAdminOverrideGuardRequest,
    });

    assert.deepEqual(calls, [
      { kind: "command", action: "ventSpeed", body: { ventSpeed: 0 } },
      {
        kind: "automatic",
        edgeId: "environment-control:RUN-1784767229481:arrival",
        ventSpeed: 2,
      },
      { kind: "command", action: "ventSpeed", body: { ventSpeed: 3 } },
      {
        kind: "automatic",
        edgeId: "environment-control:RUN-1784767229481:arrival",
        ventSpeed: 2,
      },
      { kind: "guard", beforeFrameCount: 1 },
      {
        kind: "automatic",
        edgeId: "environment-control:RUN-1784767229481:departure",
        ventSpeed: 0,
      },
    ]);
    assert.equal(report.commands[0].request.ventSpeed, 0);
    assert.equal(report.commands[1].request.ventSpeed, 3);
    assert.equal(report.daemon.automaticVent.outcomes.length, 3);
    assert.equal(report.precedence.initialVentReset.request.ventSpeed, 0);
    assert.equal(result.nextStableEdge.requestedSpeed, 0);
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
