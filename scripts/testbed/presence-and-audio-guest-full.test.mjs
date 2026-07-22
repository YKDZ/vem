import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  observeGuestRuntimeIdentity,
  parsePresenceAndAudioGuestArgs,
  runPresenceAndAudioGuestFull,
  validatePresenceAndAudioGuestReport,
} from "./presence-and-audio-guest-full.mjs";

function report() {
  return {
    schemaVersion: "vem-presence-and-audio-guest-full/v1",
    ok: true,
    boundaries: {
      visionMock: true,
      machineCdp: true,
      windowsAudioCapture: true,
    },
    artifacts: {
      audioCueCaptures: [
        {
          start: "C:\\artifacts\\audio-capture-01-start.json",
          stop: "C:\\artifacts\\audio-capture-01-stop.json",
        },
      ],
      runtimeTrace: "C:\\artifacts\\runtime-trace.json",
    },
    presenceAndAudio: {
      schemaVersion: "presence-and-audio-production-acceptance/v1",
      result: "passed",
      boundaries: {
        vision: "controlled_mock_protocol",
        cdp: "installed_canonical_machine_cdp",
        audio: "windows_default_output_capture",
      },
      diagnostics: [],
      audio: {
        source: "windows_default_output",
        capture: {
          nonSilentFrameCount: 4_800,
          peakAbsoluteSample: 2_048,
        },
        cueWindows: [
          {
            transitionId: "vision:presence-1:welcome",
            kind: "detected",
            capture: {
              nonSilentFrameCount: 1_200,
              peakAbsoluteSample: 2_048,
              startedAt: "2026-07-22T08:00:00.000Z",
              completedAt: "2026-07-22T08:00:01.000Z",
            },
          },
          {
            transitionId: "vision:presence-3:welcome",
            kind: "detected",
            capture: {
              nonSilentFrameCount: 1_200,
              peakAbsoluteSample: 2_048,
              startedAt: "2026-07-22T08:00:06.000Z",
              completedAt: "2026-07-22T08:00:07.000Z",
            },
          },
          {
            transitionId: "category:category-entry-socks-1",
            kind: "detected",
            capture: {
              nonSilentFrameCount: 1_200,
              peakAbsoluteSample: 2_048,
              startedAt: "2026-07-22T08:00:10.000Z",
              completedAt: "2026-07-22T08:00:11.000Z",
            },
          },
        ],
      },
      runtimeTrace: [
        {
          type: "journey_transition",
          id: 1,
          at: "2026-07-22T08:00:00.000Z",
          recordedAt: "2026-07-22T08:00:00.000Z",
          transitionId: "vision:presence-1:welcome",
          requestId: null,
          terminalOutcomeId: null,
          outcome: null,
          message: null,
        },
        {
          type: "audio_queued",
          id: 2,
          at: "2026-07-22T08:00:00.000Z",
          recordedAt: "2026-07-22T08:00:00.000Z",
          transitionId: "vision:presence-1:welcome",
          requestId: "audio-request-1",
          terminalOutcomeId: null,
          outcome: null,
          message: null,
        },
        {
          type: "audio_started",
          id: 3,
          at: "2026-07-22T08:00:00.000Z",
          recordedAt: "2026-07-22T08:00:00.000Z",
          transitionId: "vision:presence-1:welcome",
          requestId: "audio-request-1",
          terminalOutcomeId: null,
          outcome: null,
          message: "native",
        },
        {
          type: "audio_terminal",
          id: 4,
          at: "2026-07-22T08:00:00.000Z",
          recordedAt: "2026-07-22T08:00:00.000Z",
          transitionId: "vision:presence-1:welcome",
          requestId: "audio-request-1",
          terminalOutcomeId: "audio-terminal-1",
          outcome: "completed",
          message: null,
        },
        {
          type: "journey_transition",
          id: 5,
          at: "2026-07-22T08:00:03.000Z",
          recordedAt: "2026-07-22T08:00:03.000Z",
          transitionId: "vision:presence-2:departed",
          requestId: null,
          terminalOutcomeId: null,
          outcome: null,
          message: null,
        },
        {
          type: "journey_transition",
          id: 6,
          at: "2026-07-22T08:00:06.000Z",
          recordedAt: "2026-07-22T08:00:06.000Z",
          transitionId: "vision:presence-3:welcome",
          requestId: null,
          terminalOutcomeId: null,
          outcome: null,
          message: null,
        },
        {
          type: "audio_queued",
          id: 7,
          at: "2026-07-22T08:00:06.000Z",
          recordedAt: "2026-07-22T08:00:06.000Z",
          transitionId: "vision:presence-3:welcome",
          requestId: "audio-request-6",
          terminalOutcomeId: null,
          outcome: null,
          message: null,
        },
        {
          type: "audio_started",
          id: 8,
          at: "2026-07-22T08:00:06.000Z",
          recordedAt: "2026-07-22T08:00:06.000Z",
          transitionId: "vision:presence-3:welcome",
          requestId: "audio-request-6",
          terminalOutcomeId: null,
          outcome: null,
          message: "native",
        },
        {
          type: "audio_terminal",
          id: 9,
          at: "2026-07-22T08:00:06.000Z",
          recordedAt: "2026-07-22T08:00:06.000Z",
          transitionId: "vision:presence-3:welcome",
          requestId: "audio-request-6",
          terminalOutcomeId: "audio-terminal-6",
          outcome: "completed",
          message: null,
        },
        {
          type: "journey_transition",
          id: 10,
          at: "2026-07-22T08:00:10.000Z",
          recordedAt: "2026-07-22T08:00:10.000Z",
          transitionId: "category:category-entry-socks-1",
          requestId: null,
          terminalOutcomeId: null,
          outcome: null,
          message: null,
        },
        {
          type: "audio_queued",
          id: 11,
          at: "2026-07-22T08:00:10.000Z",
          recordedAt: "2026-07-22T08:00:10.000Z",
          transitionId: "category:category-entry-socks-1",
          requestId: "audio-request-10",
          terminalOutcomeId: null,
          outcome: null,
          message: null,
        },
        {
          type: "audio_started",
          id: 12,
          at: "2026-07-22T08:00:10.000Z",
          recordedAt: "2026-07-22T08:00:10.000Z",
          transitionId: "category:category-entry-socks-1",
          requestId: "audio-request-10",
          terminalOutcomeId: null,
          outcome: null,
          message: "native",
        },
        {
          type: "audio_terminal",
          id: 13,
          at: "2026-07-22T08:00:10.000Z",
          recordedAt: "2026-07-22T08:00:10.000Z",
          transitionId: "category:category-entry-socks-1",
          requestId: "audio-request-10",
          terminalOutcomeId: "audio-terminal-10",
          outcome: "completed",
          message: null,
        },
        {
          type: "audio_rejected",
          id: 14,
          at: "2026-07-22T08:00:11.000Z",
          recordedAt: "2026-07-22T08:00:11.000Z",
          transitionId: "vision:presence-4:welcome",
          requestId: "audio-request-14",
          terminalOutcomeId: null,
          outcome: null,
          message: "audio cue preference disabled",
        },
      ],
      checkpoints: [
        { label: "stable-arrival-settled", traceId: 4 },
        { label: "initial-duplicate-approach-settled", traceId: 4 },
        { label: "transient-empty-recovered", traceId: 4 },
        { label: "sustained-empty-departed", traceId: 5 },
        { label: "rearmed-arrival-settled", traceId: 9 },
        { label: "category-socks-entry", traceId: 9 },
        { label: "category-socks-detail", traceId: 13 },
        { label: "category-socks-checkout", traceId: 13 },
        { label: "disabled-presence-welcome-rejected", traceId: 14 },
      ],
      scenario: {
        welcome: {
          initialFenceTraceId: 0,
          duplicateFenceTraceId: 4,
          initialTransitionId: "vision:presence-1:welcome",
          departureTransitionId: "vision:presence-2:departed",
          transientFenceTraceId: 4,
          rearmedFenceTraceId: 5,
          rearmedTransitionId: "vision:presence-3:welcome",
        },
        supportedCategoryKeys: ["socks"],
        preferenceSuppression: {
          transitionId: "vision:presence-4:welcome",
          rejectedTraceId: 14,
        },
        categories: [
          {
            key: "socks",
            transitionId: "category:category-entry-socks-1",
            sourceUrl: "/audio/voice/product/socks.mp3",
            entryCheckpointLabel: "category-socks-entry",
            detailCheckpointLabel: "category-socks-detail",
            checkoutCheckpointLabel: "category-socks-checkout",
          },
        ],
      },
      automaticVent: {
        protocolFrames: [
          {
            parsedOpcode: "B3",
            rawFrameHex: "55b302",
            capturedAt: "2026-07-22T08:00:00.000Z",
          },
          {
            parsedOpcode: "B3",
            rawFrameHex: "55b300",
            capturedAt: "2026-07-22T08:00:10.000Z",
          },
        ],
        speeds: [2, 0],
        guardElapsedMs: 10_000,
        edgeCorrelation: [
          {
            edgeId: "presence-1:arrival",
            transitionId: "vision:presence-1:welcome",
            speed: 2,
            frame: {
              parsedOpcode: "B3",
              rawFrameHex: "55b302",
              capturedAt: "2026-07-22T08:00:00.000Z",
            },
          },
          {
            edgeId: "presence-2:departure",
            transitionId: "vision:presence-2:departed",
            speed: 0,
            frame: {
              parsedOpcode: "B3",
              rawFrameHex: "55b300",
              capturedAt: "2026-07-22T08:00:10.000Z",
            },
          },
        ],
        adminPrecedence: {
          commandNo: "environment-command-1",
          requestedSpeed: 3,
          resultStatus: "succeeded",
          frame: {
            parsedOpcode: "B3",
            rawFrameHex: "55b303",
            capturedAt: "2026-07-22T08:00:05.000Z",
          },
          duplicateSameEdge: {
            edgeId: "presence-1:arrival",
            outcome: "deduplicated",
          },
        },
      },
    },
  };
}

describe("presence and audio guest full", () => {
  it("falls back to the shared CDP identity helper when the client lacks observeIdentity", async () => {
    const identity = await observeGuestRuntimeIdentity(
      { webSocketUrl: "ws://127.0.0.1:9222/devtools/page/target-1" },
      {
        observeConnectedCdpIdentity: () => ({
          targetId: "target-1",
          sessionId: "cdp-connection:33333333-3333-4333-8333-333333333333",
          connectedAt: "2026-07-22T08:00:00.000Z",
        }),
      },
    );

    assert.deepEqual(identity, {
      targetId: "target-1",
      sessionId: "cdp-connection:33333333-3333-4333-8333-333333333333",
      connectedAt: "2026-07-22T08:00:00.000Z",
    });
  });

  it("parses the installed guest contract", () => {
    assert.equal(
      parsePresenceAndAudioGuestArgs([
        "--mode",
        "full",
        "--guest-input",
        "C:\\input.json",
        "--handoff",
        "C:\\handoff.json",
        "--out",
        "C:\\out.json",
      ]).mode,
      "full",
    );
    assert.throws(
      () =>
        parsePresenceAndAudioGuestArgs([
          "--mode",
          "full",
          "--guest-input",
          "C:\\input.json",
          "--handoff",
          "C:\\handoff.json",
          "--out",
          "C:\\out.json",
          "--report-path",
          "C:\\report.json",
        ]),
      /unsupported presence-and-audio option: --report-path/,
    );
  });

  it("requires explicit vision, CDP, and native audio boundaries", () => {
    const summary = validatePresenceAndAudioGuestReport(report());
    assert.equal(summary.schemaVersion, "vem-presence-and-audio-guest-full/v1");
    assert.equal(summary.nativeSource, "windows_default_output");

    const missingBoundary = report();
    missingBoundary.boundaries.windowsAudioCapture = false;
    assert.throws(
      () => validatePresenceAndAudioGuestReport(missingBoundary),
      /boundaries are incomplete/,
    );
  });

  it("orchestrates controlled Vision, installed CDP, host audio capture, and runtime trace evidence", async () => {
    const calls = [];
    const writes = new Map();
    const trace = [];
    let nextId = 1;
    const traceTimestamp = () =>
      new Date(
        Date.parse("2026-07-22T08:00:00.000Z") + nextId * 1_000,
      ).toISOString();
    const appendLifecycle = (transitionId) => {
      const requestId = `request-${nextId}`;
      for (const [type, extra] of [
        ["journey_transition", {}],
        ["audio_queued", { requestId }],
        ["audio_started", { requestId, message: "native" }],
        [
          "audio_terminal",
          {
            requestId,
            terminalOutcomeId: `terminal-${nextId}`,
            outcome: "completed",
          },
        ],
      ]) {
        trace.push({
          type,
          id: nextId++,
          at: traceTimestamp(),
          recordedAt: traceTimestamp(),
          transitionId,
          requestId: null,
          terminalOutcomeId: null,
          outcome: null,
          message: null,
          ...extra,
        });
      }
    };
    let approachCount = 0;
    let serialEvidenceReads = 0;
    let audioCaptureOrdinal = 0;
    let now = 0;
    let audioStopBody = null;
    const report = await runPresenceAndAudioGuestFull(
      {
        mode: "full",
        guestInputPath: "C:\\guest.json",
        handoffPath: "C:\\handoff.json",
        outPath: "C:\\out.json",
        fixtureKey: "sale",
      },
      {
        readJson(path) {
          return path === "C:\\guest.json"
            ? {
                runId: "RUN-1",
                hostControlPlane: {
                  endpoint: "http://host-control",
                  token: "token",
                  targetIdentity: "vm-testbed",
                  visionMockControlPort: 17893,
                },
              }
            : {
                cdp: { targetId: "target-1" },
                machine: {
                  processId: 7,
                  executablePath: "C:\\VEM\\bringup\\machine.exe",
                  principal: "Admin",
                  sessionId: 1,
                },
                commissioningSerialSession: {
                  sessionId: "serial-1",
                  saleCorrelationId: "sale-1",
                },
              };
        },
        writeJson(path, value) {
          writes.set(path, value);
        },
        writeText(path, value) {
          writes.set(path, value);
        },
        captureScreenshotArtifact: async (_client, path) => ({
          sha256: "a".repeat(64),
          byteLength: 128,
          format: "png",
          ref: path,
        }),
        artifactRoot: () => "/tmp/presence-and-audio-test-artifacts",
        makeDirectory() {},
        ensureControlledVisionMock: async () => {
          calls.push("vision-start");
          return { child: null, started: false };
        },
        waitForControlledVisionRuntimeClient: async () =>
          calls.push("vision-client"),
        fetchJson: async (_url, request) => {
          const { state } = JSON.parse(request.body);
          calls.push(`vision:${state}`);
          if (state === "approach") {
            approachCount += 1;
            if (approachCount === 1)
              appendLifecycle("vision:presence-1:welcome");
            if (approachCount === 4)
              appendLifecycle("vision:presence-3:welcome");
            if (approachCount === 5) {
              const at = traceTimestamp();
              trace.push({
                type: "audio_rejected",
                id: nextId++,
                at,
                recordedAt: at,
                transitionId: "vision:presence-4:welcome",
                requestId: `audio-request-${nextId}`,
                terminalOutcomeId: null,
                outcome: null,
                message: "audio cue preference disabled",
              });
            }
          }
          return { ok: true };
        },
        discoverTarget: async () => ({
          webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/target-1",
        }),
        rewriteWebSocketDebuggerUrl: (url) => url,
        createClient: () => ({
          async connect() {
            calls.push("cdp-connect");
          },
          async close() {
            calls.push("cdp-close");
          },
          webSocketUrl: "ws://127.0.0.1:9222/devtools/page/target-1",
        }),
        observeConnectedCdpIdentity: () => ({
          targetId: "target-1",
          sessionId: "cdp-connection:33333333-3333-4333-8333-333333333333",
          connectedAt: "2026-07-22T08:00:00.000Z",
        }),
        enablePageRuntime: async () => calls.push("cdp-enable"),
        waitForRoute: async (_client, route) => calls.push(`route:${route}`),
        waitForSaleStartReady: async () => calls.push("sale-ready"),
        activateVisibleSelector: async (_client, selector) => {
          calls.push(`touch:${selector}`);
          const category = /data-category-key="([^"]+)"/.exec(selector)?.[1];
          if (category)
            appendLifecycle(`category:category-entry-${category}-1`);
        },
        evaluateExpression: async (_client, expression) =>
          expression.includes("catalog-category")
            ? ["socks", "underwear"]
            : structuredClone(trace),
        readTrace: async () => structuredClone(trace),
        setAudioPreferences: async (_client, preferences) => {
          calls.push(
            `audio-preferences:${preferences.presenceCuesEnabled ? "enabled" : "disabled"}`,
          );
          return preferences;
        },
        sleep: async (milliseconds) => {
          now += milliseconds;
          if (milliseconds === 10_000) {
            const at = traceTimestamp();
            trace.push({
              type: "journey_transition",
              id: nextId++,
              at,
              recordedAt: at,
              transitionId: "vision:presence-2:departed",
              requestId: null,
              terminalOutcomeId: null,
              outcome: null,
              message: null,
            });
          }
        },
        now: () => now,
        randomUUID: () => "operation-1",
        controlPlaneRequest: async (_input, path, body) => {
          calls.push(path);
          if (path === "/v1/audio-captures/start") {
            audioCaptureOrdinal += 1;
            return {
              audioCaptureId: `audio-${audioCaptureOrdinal}`,
              startReport: { started: true },
            };
          }
          if (path.endsWith("/stop")) {
            audioStopBody = body;
            return {
              stopReport: {
                capture: {
                  nonSilentFrameCount: 10,
                  peakAbsoluteSample: 12,
                  startedAt: "2026-07-22T07:59:00.000Z",
                  completedAt: "2026-07-22T08:01:00.000Z",
                },
              },
              evidencePayloads: [],
            };
          }
          if (
            path.includes("/serial-sessions/") &&
            path.endsWith("/evidence")
          ) {
            serialEvidenceReads += 1;
            return {
              rawFrames:
                serialEvidenceReads === 1
                  ? []
                  : serialEvidenceReads === 2
                    ? [
                        {
                          parsedOpcode: "B3",
                          rawFrameHex: "55b302",
                          capturedAt: "2026-07-22T08:00:00.000Z",
                        },
                      ]
                    : serialEvidenceReads < 5
                      ? [
                          {
                            parsedOpcode: "B3",
                            rawFrameHex: "55b302",
                            capturedAt: "2026-07-22T08:00:00.000Z",
                          },
                          {
                            parsedOpcode: "B3",
                            rawFrameHex: "55b303",
                            capturedAt: "2026-07-22T08:00:05.000Z",
                          },
                        ]
                      : [
                          {
                            parsedOpcode: "B3",
                            rawFrameHex: "55b302",
                            capturedAt: "2026-07-22T08:00:00.000Z",
                          },
                          {
                            parsedOpcode: "B3",
                            rawFrameHex: "55b303",
                            capturedAt: "2026-07-22T08:00:05.000Z",
                          },
                          {
                            parsedOpcode: "B3",
                            rawFrameHex: "55b300",
                            capturedAt: "2026-07-22T08:00:10.000Z",
                          },
                        ],
            };
          }
          throw new Error(`unexpected control-plane call ${path}`);
        },
        issueAdminVentOverride: async () => ({
          commandNo: "environment-command-1",
          requestedSpeed: 3,
          resultStatus: "succeeded",
        }),
        submitDuplicateAutomaticVentIntent: async (_handoff, edgeId) => ({
          edgeId,
          outcome: "deduplicated",
        }),
      },
    );
    assert.equal(report.ok, true, JSON.stringify(report.error));
    assert.deepEqual(report.presenceAndAudio.scenario.supportedCategoryKeys, [
      "socks",
      "underwear",
    ]);
    assert.deepEqual(report.presenceAndAudio.scenario.welcome, {
      initialFenceTraceId: 0,
      duplicateFenceTraceId: 4,
      initialTransitionId: "vision:presence-1:welcome",
      departureTransitionId: "vision:presence-2:departed",
      transientFenceTraceId: 4,
      rearmedFenceTraceId: 5,
      rearmedTransitionId: "vision:presence-3:welcome",
    });
    assert.equal(report.presenceAndAudio.scenario.categories.length, 2);
    assert.equal(
      report.presenceAndAudio.runtimeTrace.filter(
        (entry) =>
          entry.type === "audio_started" &&
          entry.transitionId.endsWith(":welcome"),
      ).length,
      2,
    );
    assert.ok(calls.includes("vision-start"));
    assert.deepEqual(
      calls.filter((value) => value === "vision:approach"),
      [
        "vision:approach",
        "vision:approach",
        "vision:approach",
        "vision:approach",
        "vision:approach",
      ],
    );
    assert.deepEqual(
      calls.filter((value) => value === "vision:empty"),
      ["vision:empty", "vision:empty", "vision:empty", "vision:empty"],
    );
    assert.ok(
      calls.includes(
        'touch:[data-test="catalog-category"][data-category-key="socks"]:not(:disabled)',
      ),
    );
    assert.ok(
      calls.includes(
        'touch:[data-test="catalog-category"][data-category-key="underwear"]:not(:disabled)',
      ),
    );
    assert.equal(
      calls.some((value) => value.includes("checkout-submit")),
      false,
    );
    assert.deepEqual(audioStopBody, { captureKind: "default-audio" });
    assert.equal(
      calls.filter((value) => value === "/v1/audio-captures/start").length,
      4,
    );
    assert.equal(calls.filter((value) => value.endsWith("/stop")).length, 4);
    assert.equal(report.presenceAndAudio.audio.cueWindows.length, 4);
    assert.ok(
      report.presenceAndAudio.audio.cueWindows.every(
        (window) =>
          window.kind === "detected" && window.capture.nonSilentFrameCount > 0,
      ),
    );
    assert.ok(report.presenceAndAudio.runtimeTrace.length > 0);
    assert.equal(writes.get("C:\\out.json").ok, true);
  });

  it("fails closed and cancels an active host audio capture when Vision injection fails", async () => {
    const calls = [];
    const writes = new Map();
    const report = await runPresenceAndAudioGuestFull(
      {
        mode: "full",
        guestInputPath: "C:\\guest.json",
        handoffPath: "C:\\handoff.json",
        outPath: "C:\\out.json",
        fixtureKey: null,
      },
      {
        readJson: (path) =>
          path === "C:\\guest.json"
            ? {
                runId: "RUN-1",
                hostControlPlane: {
                  endpoint: "http://host-control",
                  token: "token",
                  targetIdentity: "vm",
                  visionMockControlPort: 17893,
                },
              }
            : {
                cdp: { targetId: "target-1" },
                machine: {
                  processId: 7,
                  executablePath: "C:\\VEM\\bringup\\machine.exe",
                  principal: "Admin",
                  sessionId: 1,
                },
                commissioningSerialSession: { sessionId: "serial-1" },
              },
        writeJson: (path, value) => writes.set(path, value),
        artifactRoot: () => "/tmp/presence-and-audio-test-artifacts",
        makeDirectory() {},
        ensureControlledVisionMock: async () => ({
          child: null,
          started: false,
        }),
        waitForControlledVisionRuntimeClient: async () => {},
        discoverTarget: async () => ({
          webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/target-1",
        }),
        rewriteWebSocketDebuggerUrl: (url) => url,
        createClient: () => ({
          connect: async () => {},
          close: async () => {},
          webSocketUrl: "ws://127.0.0.1:9222/devtools/page/target-1",
        }),
        observeConnectedCdpIdentity: () => ({
          targetId: "target-1",
          sessionId: "cdp-connection:33333333-3333-4333-8333-333333333333",
          connectedAt: "2026-07-22T08:00:00.000Z",
        }),
        enablePageRuntime: async () => {},
        waitForRoute: async () => {},
        waitForSaleStartReady: async () => {},
        readTrace: async () => [],
        sleep: async () => {},
        controlPlaneRequest: async (_input, path) => {
          calls.push(path);
          if (path === "/v1/audio-captures/start")
            return { audioCaptureId: "audio-1", startReport: {} };
          return { cancelled: true };
        },
        fetchJson: async (_url, request) => {
          if (JSON.parse(request.body).state === "empty") return { ok: true };
          throw new Error("controlled Vision unavailable");
        },
      },
    );
    assert.equal(report.ok, false);
    assert.match(report.error.message, /controlled Vision unavailable/);
    assert.ok(calls.includes("/v1/audio-captures/audio-1/cancel"));
    assert.equal(writes.get("C:\\out.json").ok, false);
  });
});
