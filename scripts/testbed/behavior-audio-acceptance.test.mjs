import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { validateBehaviorAudioAcceptanceEvidence } from "./behavior-audio-acceptance.mjs";

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

function passingAcceptance() {
  const initialWelcome = "vision:presence-1:welcome";
  const departed = "vision:presence-2:departed";
  const rearmedWelcome = "vision:presence-3:welcome";
  const socks = "category:category-entry-socks-1";
  const underwear = "category:category-entry-underwear-1";
  return {
    schemaVersion: "behavior-audio-production-acceptance/v1",
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
        { transitionId: initialWelcome, kind: "passed" },
        { transitionId: rearmedWelcome, kind: "passed" },
        { transitionId: socks, kind: "passed" },
        { transitionId: underwear, kind: "passed" },
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
    ],
    scenario: {
      welcome: {
        initialTransitionId: initialWelcome,
        departureTransitionId: departed,
        rearmedTransitionId: rearmedWelcome,
      },
      supportedCategoryKeys: ["socks", "underwear"],
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

describe("behavior audio acceptance", () => {
  it("accepts one stable welcome, one rearmed welcome, and category entry-only intros", () => {
    const summary =
      validateBehaviorAudioAcceptanceEvidence(passingAcceptance());
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
      validateBehaviorAudioAcceptanceEvidence(acceptance).nativeSource,
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
    assert.throws(
      () => validateBehaviorAudioAcceptanceEvidence(acceptance),
      /transient empty incorrectly rearmed welcome/,
    );
  });

  it("rejects a report that omits an enabled product category", () => {
    const acceptance = passingAcceptance();
    acceptance.scenario.categories.pop();
    assert.throws(
      () => validateBehaviorAudioAcceptanceEvidence(acceptance),
      /supported product categories were not independently covered/,
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
    assert.throws(
      () => validateBehaviorAudioAcceptanceEvidence(acceptance),
      /category socks introduction started too late/,
    );
  });
});
