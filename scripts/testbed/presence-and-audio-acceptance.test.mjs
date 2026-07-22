import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { validatePresenceAndAudioAcceptanceEvidence } from "./presence-and-audio-acceptance.mjs";

function traceLifecycle(transitionId, startId, at) {
  return [
    {
      type: "journey_transition",
      id: startId,
      at,
      recordedAt: at,
      transitionId,
      requestId: null,
      terminalOutcomeId: null,
      outcome: null,
      message: null,
    },
    {
      type: "audio_queued",
      id: startId + 1,
      at,
      recordedAt: at,
      transitionId,
      requestId: `audio-request-${startId}`,
      terminalOutcomeId: null,
      outcome: null,
      message: null,
    },
    {
      type: "audio_started",
      id: startId + 2,
      at,
      recordedAt: at,
      transitionId,
      requestId: `audio-request-${startId}`,
      terminalOutcomeId: null,
      outcome: null,
      message: "native",
      volume: 0.52,
    },
    {
      type: "audio_terminal",
      id: startId + 3,
      at,
      recordedAt: at,
      transitionId,
      requestId: `audio-request-${startId}`,
      terminalOutcomeId: `audio-terminal:${startId}`,
      outcome: "completed",
      message: null,
    },
  ];
}

function detectedCueWindow(transitionId, offsetSeconds) {
  const startedAt = new Date(
    Date.parse("2026-07-22T08:00:00.000Z") + offsetSeconds * 1_000,
  ).toISOString();
  return {
    transitionId,
    kind: "detected",
    capture: {
      nonSilentFrameCount: 2_400,
      peakAbsoluteSample: 2_048,
      startedAt,
      completedAt: new Date(Date.parse(startedAt) + 1_000).toISOString(),
    },
  };
}

function passingAcceptance() {
  const initialWelcome = "vision:presence-1:welcome";
  const departed = "vision:presence-2:departed";
  const rearmedWelcome = "vision:presence-3:welcome";
  const socks = "category:category-entry-socks-1";
  const underwear = "category:category-entry-underwear-1";
  return {
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
        nonSilentFrameCount: 9_600,
        peakAbsoluteSample: 3_072,
      },
      cueWindows: [
        detectedCueWindow(initialWelcome, 0),
        detectedCueWindow(rearmedWelcome, 6),
        detectedCueWindow(socks, 10),
        detectedCueWindow(underwear, 15),
      ],
    },
    runtimeTrace: [
      ...traceLifecycle(initialWelcome, 1, "2026-07-22T08:00:00.000Z"),
      {
        type: "journey_transition",
        id: 5,
        at: "2026-07-22T08:00:03.000Z",
        recordedAt: "2026-07-22T08:00:03.000Z",
        transitionId: departed,
        requestId: null,
        terminalOutcomeId: null,
        outcome: null,
        message: null,
      },
      ...traceLifecycle(rearmedWelcome, 6, "2026-07-22T08:00:06.000Z"),
      ...traceLifecycle(socks, 10, "2026-07-22T08:00:10.000Z"),
      {
        type: "journey_transition",
        id: 14,
        at: "2026-07-22T08:00:11.000Z",
        recordedAt: "2026-07-22T08:00:11.000Z",
        transitionId: "product:detail-socks-1",
        requestId: null,
        terminalOutcomeId: null,
        outcome: null,
        message: null,
      },
      ...traceLifecycle(underwear, 15, "2026-07-22T08:00:15.000Z"),
      {
        type: "audio_rejected",
        id: 19,
        at: "2026-07-22T08:00:20.000Z",
        recordedAt: "2026-07-22T08:00:20.000Z",
        transitionId: "vision:presence-4:welcome",
        requestId: "audio-request-19",
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
      { label: "category-socks-detail", traceId: 14 },
      { label: "category-socks-checkout", traceId: 14 },
      { label: "category-underwear-entry", traceId: 14 },
      { label: "category-underwear-detail", traceId: 19 },
      { label: "category-underwear-checkout", traceId: 19 },
      { label: "disabled-presence-welcome-rejected", traceId: 19 },
    ],
    scenario: {
      welcome: {
        initialFenceTraceId: 0,
        duplicateFenceTraceId: 4,
        initialTransitionId: initialWelcome,
        departureTransitionId: departed,
        transientFenceTraceId: 4,
        rearmedFenceTraceId: 5,
        rearmedTransitionId: rearmedWelcome,
      },
      supportedCategoryKeys: ["socks", "underwear"],
      preferenceSuppression: {
        transitionId: "vision:presence-4:welcome",
        rejectedTraceId: 19,
      },
      categories: [
        {
          key: "socks",
          transitionId: socks,
          sourceUrl: "/audio/voice/product/socks.mp3",
          entryCheckpointLabel: "category-socks-entry",
          detailCheckpointLabel: "category-socks-detail",
          checkoutCheckpointLabel: "category-socks-checkout",
        },
        {
          key: "underwear",
          transitionId: underwear,
          sourceUrl: "/audio/voice/product/underwear.mp3",
          entryCheckpointLabel: "category-underwear-entry",
          detailCheckpointLabel: "category-underwear-detail",
          checkoutCheckpointLabel: "category-underwear-checkout",
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
          transitionId: initialWelcome,
          speed: 2,
          frame: {
            parsedOpcode: "B3",
            rawFrameHex: "55b302",
            capturedAt: "2026-07-22T08:00:00.000Z",
          },
        },
        {
          edgeId: "presence-2:departure",
          transitionId: departed,
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
  };
}

function renumberTrace(trace) {
  return trace.map((entry, index) => ({
    ...entry,
    id: index + 1,
    at: new Date(
      Date.parse("2026-07-22T08:00:00.000Z") + index * 1_000,
    ).toISOString(),
    recordedAt: new Date(
      Date.parse("2026-07-22T08:00:00.000Z") + index * 1_000,
    ).toISOString(),
  }));
}

describe("presence and audio acceptance", () => {
  it("accepts one stable welcome, one rearmed welcome, and category entry-only intros", () => {
    const summary =
      validatePresenceAndAudioAcceptanceEvidence(passingAcceptance());
    assert.deepEqual(summary.welcomeTransitions, [
      "vision:presence-1:welcome",
      "vision:presence-3:welcome",
    ]);
    assert.equal(summary.categoryTransitions.length, 2);
    assert.equal(summary.nativeSource, "windows_default_output");
  });

  it("accepts welcome cues stopped by later higher-priority behavior edges", () => {
    const acceptance = passingAcceptance();
    for (const entry of acceptance.runtimeTrace) {
      if (
        entry.type === "audio_terminal" &&
        entry.transitionId.endsWith(":welcome")
      ) {
        entry.outcome = "stopped";
      }
    }
    assert.equal(
      validatePresenceAndAudioAcceptanceEvidence(acceptance).nativeSource,
      "windows_default_output",
    );
  });

  it("rejects a transient empty scene that rearms welcome", () => {
    const acceptance = passingAcceptance();
    acceptance.runtimeTrace = renumberTrace([
      ...acceptance.runtimeTrace.slice(0, 4),
      ...traceLifecycle(
        "vision:presence-2:welcome",
        5,
        "2026-07-22T08:00:02.000Z",
      ),
      acceptance.runtimeTrace[4],
      ...acceptance.runtimeTrace.slice(5),
    ]);
    acceptance.checkpoints = acceptance.checkpoints.map((entry) => ({
      ...entry,
      traceId:
        entry.label === "stable-arrival-settled" ||
        entry.label === "initial-duplicate-approach-settled" ||
        entry.label === "transient-empty-recovered"
          ? entry.traceId +
            (entry.label === "transient-empty-recovered" ? 4 : 0)
          : entry.traceId + 4,
    }));
    acceptance.scenario.preferenceSuppression.rejectedTraceId =
      acceptance.runtimeTrace.find(
        (entry) => entry.type === "audio_rejected",
      ).id;
    assert.throws(
      () => validatePresenceAndAudioAcceptanceEvidence(acceptance),
      /transient empty incorrectly rearmed welcome/,
    );
  });

  it("rejects a stale welcome that happened before the explicit fresh fence", () => {
    const acceptance = passingAcceptance();
    acceptance.scenario.welcome.initialFenceTraceId = 3;
    assert.throws(
      () => validatePresenceAndAudioAcceptanceEvidence(acceptance),
      /initial welcome did not use a fresh presence fence/,
    );
  });

  it("ignores welcome history before the explicit initial fence", () => {
    const acceptance = passingAcceptance();
    const priorWelcome = acceptance.runtimeTrace.find(
      (entry) => entry.type === "audio_started",
    );
    acceptance.runtimeTrace = [
      {
        ...priorWelcome,
        id: 1,
        transitionId: "vision:prior-run:welcome",
      },
      ...acceptance.runtimeTrace.map((entry) => ({
        ...entry,
        id: entry.id + 1,
      })),
    ];
    acceptance.checkpoints = acceptance.checkpoints.map((checkpoint) => ({
      ...checkpoint,
      traceId: checkpoint.traceId + 1,
    }));
    const welcome = acceptance.scenario.welcome;
    welcome.initialFenceTraceId += 1;
    welcome.duplicateFenceTraceId += 1;
    welcome.transientFenceTraceId += 1;
    welcome.rearmedFenceTraceId += 1;
    acceptance.scenario.preferenceSuppression.rejectedTraceId += 1;
    assert.doesNotThrow(() =>
      validatePresenceAndAudioAcceptanceEvidence(acceptance),
    );
  });

  it("rejects a report that omits an enabled product category", () => {
    const acceptance = passingAcceptance();
    acceptance.scenario.categories.pop();
    assert.throws(
      () => validatePresenceAndAudioAcceptanceEvidence(acceptance),
      /supported product categories were not independently covered/,
    );
  });

  it("rejects duplicate and extra audio cue windows", () => {
    for (const cueWindow of [
      detectedCueWindow("vision:presence-1:welcome", 20),
      detectedCueWindow("unexpected:transition", 20),
    ]) {
      const acceptance = passingAcceptance();
      acceptance.audio.cueWindows.push(cueWindow);
      assert.throws(
        () => validatePresenceAndAudioAcceptanceEvidence(acceptance),
        /exactly one cue window per required transition/,
      );
    }
  });

  it("rejects an Admin B3 frame that bypasses the shared guard", () => {
    const acceptance = passingAcceptance();
    acceptance.automaticVent.adminPrecedence.frame.capturedAt =
      "2026-07-22T08:00:01.000Z";
    assert.throws(
      () => validatePresenceAndAudioAcceptanceEvidence(acceptance),
      /automatic B3 guard evidence is incomplete/,
    );
  });

  it("rejects a category intro that starts after detail entry", () => {
    const acceptance = passingAcceptance();
    const socksTrace = acceptance.runtimeTrace.filter(
      (entry) => entry.transitionId === "category:category-entry-socks-1",
    );
    const underwearTrace = acceptance.runtimeTrace.filter(
      (entry) => entry.transitionId === "category:category-entry-underwear-1",
    );
    const otherTrace = acceptance.runtimeTrace.filter(
      (entry) =>
        ![
          "category:category-entry-socks-1",
          "category:category-entry-underwear-1",
        ].includes(entry.transitionId),
    );
    acceptance.runtimeTrace = renumberTrace([
      ...otherTrace,
      socksTrace[0],
      socksTrace[1],
      underwearTrace[0],
      underwearTrace[1],
      socksTrace[2],
      socksTrace[3],
      underwearTrace[2],
      underwearTrace[3],
    ]);
    acceptance.checkpoints.find(
      (entry) => entry.label === "category-socks-detail",
    ).traceId = 14;
    acceptance.checkpoints.find(
      (entry) => entry.label === "category-socks-checkout",
    ).traceId = 17;
    acceptance.checkpoints.find(
      (entry) => entry.label === "category-underwear-detail",
    ).traceId = 21;
    acceptance.checkpoints.find(
      (entry) => entry.label === "category-underwear-checkout",
    ).traceId = 21;
    acceptance.scenario.preferenceSuppression.rejectedTraceId =
      acceptance.runtimeTrace.find(
        (entry) => entry.type === "audio_rejected",
      ).id;
    assert.throws(
      () => validatePresenceAndAudioAcceptanceEvidence(acceptance),
      /category socks introduction started too late/,
    );
  });
});
