import { createHash } from "node:crypto";

import { inspectWavPcm } from "./default-audio-evidence.ts";

type JsonRecord = Record<string, unknown>;

function recordValue(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}

export const DEFAULT_DELAYED_PICKUP_TIMING = Object.freeze({
  firstWarningAfterF0Ms: 15_000,
  secondWarningAfterF0Ms: 25_000,
  resetStartAfterF0Ms: 30_000,
  controllerTimingToleranceMs: 2_500,
  traceTimingToleranceMs: 3_000,
  maxCueStartLatencyMs: 2_000,
  repeatedFrameWindowMs: 1_500,
});

export const DEFAULT_AUDIO_CUE_WINDOW_THRESHOLD = Object.freeze({
  minimumPeakAbsoluteSample: 512,
  minimumNonSilentFrames: 4_800,
  minimumDurationMs: 100,
  minimumDistinctNonSilentSampleMagnitudes: 2,
});

const CODES = new Map([
  ["f0", "F0"],
  ["e5", "E5"],
  ["f1", "F1"],
  ["af", "AF"],
  ["f2", "F2"],
]);
const UI_SURFACES = ["ordinary_warning", "urgent_warning", "reset_progress"];
const PICKUP_TRACE_CUES = [
  ["pickup_started", "pickup-outlet-opened"],
  ["ordinary_warning", "pickup-warning-1"],
  ["urgent_warning", "pickup-warning-2"],
];
const TERMINAL_SUCCESS_TRACE = ["dispense_succeeded", "dispense-succeeded"];
const CANONICAL_UTC_RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const AUDIO_REQUEST_ID = /^audio-request-[1-9]\d*$/;
const REFERENCES = Object.freeze({
  lifecycleReference: /^vm-lifecycle:\/\/[a-z0-9][a-z0-9._-]{2,127}$/,
  transactionId: /^transaction:\/\/[a-z0-9][a-z0-9._:-]{2,127}$/,
  saleCorrelationId: /^sale-correlation:\/\/[a-z0-9][a-z0-9._:-]{2,127}$/,
});

function diagnostic(code: string, detail: JsonRecord | null = null): JsonRecord {
  return detail === null ? { code } : { code, detail };
}

function timestamp(value: unknown): number | null {
  if (typeof value !== "string" || !CANONICAL_UTC_RFC3339.test(value))
    return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
    ? parsed
    : null;
}

export function isCanonicalUtcTimestamp(value: unknown): boolean {
  return timestamp(value) !== null;
}

function canonicalId(name: string, value: unknown): boolean {
  if (typeof value !== "string" || value !== value.trim()) return false;
  if (["orderId", "commandId"].includes(name)) return UUID.test(value);
  if (name === "runId" || name === "orderNo" || name === "commandNo")
    return TOKEN_ID.test(value);
  return (
    REFERENCES[name as keyof typeof REFERENCES]?.test(value) === true
  );
}

function completeBinding(value: unknown, expected: JsonRecord): boolean {
  const record = recordValue(value);
  return [
    "runId",
    "lifecycleReference",
    "transactionId",
    "saleCorrelationId",
    "orderId",
    "orderNo",
    "commandId",
    "commandNo",
  ].every(
    (name) =>
      canonicalId(name, record[name]) && record[name] === expected?.[name],
  );
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeHex(value: unknown): string | null {
  const normalized = String(value ?? "").toLowerCase();
  return normalized.length > 0 &&
    normalized.length % 2 === 0 &&
    /^[a-f0-9]+$/.test(normalized)
    ? normalized
    : null;
}

function frameDigest(bytesHex: string): string {
  return `sha256:${createHash("sha256")
    .update(Buffer.from(bytesHex, "hex"))
    .digest("hex")}`;
}

function crc8(bytes: number[]): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1)
      crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
  }
  return crc;
}

function decodeControllerCode(bytesHex: unknown): string | null {
  const match = /^55(f0|e5|f1|af|f2)$/i.exec(String(bytesHex ?? ""));
  return match ? CODES.get(match[1].toLowerCase()) ?? null : null;
}

function validDispenseCommand(bytesHex: unknown): boolean {
  const normalized = normalizeHex(bytesHex);
  if (!normalized || normalized.length !== 8 || !normalized.startsWith("55"))
    return false;
  const bytes = Buffer.from(normalized, "hex");
  const maxCell =
    bytes[1] <= 6 ? 5 : bytes[1] <= 8 ? 4 : bytes[1] === 9 ? 3 : 0;
  return (
    bytes[1] >= 1 &&
    bytes[2] >= 1 &&
    bytes[2] <= maxCell &&
    crc8([bytes[1], bytes[2]]) === bytes[3]
  );
}

function validLowerFrameStructure(bytesHex: unknown): boolean {
  const value = String(bytesHex ?? "");
  if (/^55(?:00|e[1-6]|f[012]|a[abcf])$/i.test(value)) return true;
  if (/^55b0[0-9a-f]{4}$/i.test(value)) return true;
  if (/^55b1[0-9a-f]{4}$/i.test(value)) return true;
  return /^55b[23][0-9a-f]{2}$/i.test(value);
}

function validUpperControlFrame(bytesHex: unknown): boolean {
  const value = String(bytesHex ?? "");
  return (
    /^55(?:a0|b1|b2|b3)$/i.test(value) ||
    /^55b0[0-9a-f]{2}$/i.test(value) ||
    /^55b1[0-9a-f]{4}$/i.test(value) ||
    /^55b[23][0-9a-f]{2}$/i.test(value)
  );
}

function collapseRepeated(
  events: JsonRecord[],
  code: string,
  timing: JsonRecord,
): JsonRecord[] | JsonRecord[][] {
  const matching = events.filter((entry) => entry.code === code);
  if (!new Set(["F0", "F1", "F2"]).has(code)) return matching;
  const groups: JsonRecord[][] = [];
  for (const entry of matching) {
    const group = groups.at(-1);
    if (
      !group ||
      (entry.atMs as number) - (group.at(-1)?.atMs as number) >
        (timing.repeatedFrameWindowMs as number)
    )
      groups.push([entry]);
    else group.push(entry);
  }
  return groups;
}

export function analyzeDelayedPickupControllerFrames(
  serialCapture: unknown,
  expectedBinding: JsonRecord,
  timing = DEFAULT_DELAYED_PICKUP_TIMING,
): JsonRecord {
  const capture = recordValue(serialCapture);
  const diagnostics: JsonRecord[] = [];
  if (
    capture?.schemaVersion !==
      "host-production-serial-frame-capture/v1" ||
    !completeBinding(capture?.binding, expectedBinding) ||
    !Array.isArray(capture?.frames)
  ) {
    return {
      ok: false,
      diagnostics: [diagnostic("production_serial_capture_missing")],
      events: null,
      timing: null,
    };
  }
  const events: JsonRecord[] = [];
  const commands: JsonRecord[] = [];
  let previousSequence = 0;
  let previousAt = -Infinity;
  const seenSequences = new Set();
  arrayValue(capture.frames).forEach((frame: unknown, index: number) => {
    const frameRecord = recordValue(frame);
    const bytesHex = normalizeHex(frameRecord.bytesHex);
    if (
      !bytesHex ||
      frameRecord?.digest !== frameDigest(bytesHex) ||
      timestamp(frameRecord?.capturedAt) === null
    ) {
      diagnostics.push(diagnostic("serial_frame_integrity_invalid", { index }));
      return;
    }
    if (frameRecord?.direction === "guest_to_host") {
      if (
        frameRecord?.role === "upper-controller" &&
        validDispenseCommand(bytesHex) &&
        completeBinding(frameRecord.binding, expectedBinding)
      )
        commands.push(frameRecord);
      else if (
        frameRecord?.role !== "upper-controller" ||
        !validUpperControlFrame(bytesHex)
      )
        diagnostics.push(
          diagnostic("dispense_command_frame_invalid", { index }),
        );
      return;
    }
    if (
      frameRecord?.direction !== "host_to_guest" ||
      frameRecord?.role !== "lower-controller" ||
      !validLowerFrameStructure(bytesHex)
    ) {
      diagnostics.push(diagnostic("lower_controller_frame_invalid", { index }));
      return;
    }
    if (!completeBinding(frameRecord.binding, expectedBinding)) {
      diagnostics.push(
        diagnostic("controller_frame_sale_binding_incomplete", { index }),
      );
      return;
    }
    const code = decodeControllerCode(bytesHex);
    if (!code) return;
    const atMs = timestamp(frameRecord.capturedAt);
    if (
      !Number.isSafeInteger(frameRecord.sequence) ||
      (frameRecord.sequence as number) < 1 ||
      seenSequences.has(frameRecord.sequence) ||
      (frameRecord.sequence as number) <= previousSequence ||
      atMs === null ||
      atMs < previousAt
    )
      diagnostics.push(diagnostic("controller_frame_order_invalid", { index }));
    if (frameRecord.direction !== "host_to_guest")
      diagnostics.push(
        diagnostic("controller_frame_direction_invalid", { index }),
      );
    seenSequences.add(frameRecord.sequence);
    previousSequence = frameRecord.sequence as number;
    if (atMs !== null) previousAt = atMs;
    events.push({
      code,
      at: frameRecord.capturedAt,
      atMs,
      sequence: frameRecord.sequence,
      digest: frameRecord.digest ?? null,
    });
  });
  if (commands.length !== 1)
    diagnostics.push(
      diagnostic("dispense_command_frame_count_invalid", {
        count: commands.length,
      }),
    );
  const f0Groups = collapseRepeated(events, "F0", timing) as JsonRecord[][];
  const f1Groups = collapseRepeated(events, "F1", timing) as JsonRecord[][];
  const f2Groups = collapseRepeated(events, "F2", timing) as JsonRecord[][];
  const e5 = collapseRepeated(events, "E5", timing) as JsonRecord[];
  const af = collapseRepeated(events, "AF", timing) as JsonRecord[];
  for (const [code, groups] of [
    ["F0", f0Groups],
    ["F1", f1Groups],
    ["F2", f2Groups],
  ]) {
    if (groups.length !== 1 || (groups[0]?.length ?? 0) < 1)
      diagnostics.push(
        diagnostic("controller_repeated_event_count_invalid", {
          code,
          groupCount: groups.length,
          frameCount: groups[0]?.length ?? 0,
        }),
      );
  }
  if (e5.length !== 2)
    diagnostics.push(
      diagnostic("controller_warning_count_invalid", { count: e5.length }),
    );
  const f0 = f0Groups[0]?.[0] ?? null;
  const f1 = f1Groups[0]?.[0] ?? null;
  const f2 = f2Groups[0]?.[0] ?? null;
  if (!f0 || !e5[0] || !e5[1] || !f1 || !f2)
    diagnostics.push(diagnostic("controller_timeline_incomplete"));
  const command = commands[0];
  if (command && f0) {
    if (
      (command.sequence as number) >= (f0.sequence as number) ||
      (timestamp(command.capturedAt) ?? -Infinity) >= (f0.atMs as number)
    ) {
      diagnostics.push(diagnostic("dispense_command_order_invalid"));
    }
  }
  const ordered = [f0, e5[0], e5[1], f1, f2].filter(Boolean);
  if (
    ordered.length === 5 &&
    ordered.some(
      (entry: JsonRecord, index: number) => {
        if (index === 0) return false;
        const previous = ordered[index - 1] as JsonRecord;
        return (entry.atMs as number) <= (previous.atMs as number);
      },
    )
  )
    diagnostics.push(diagnostic("controller_timeline_order_invalid"));
  if (
    !f1 ||
    !f2 ||
    !af.some(
      (entry: JsonRecord) =>
        (entry.sequence as number) > (f1.sequence as number) &&
        (entry.sequence as number) < (f2.sequence as number),
    )
  )
    diagnostics.push(diagnostic("controller_reset_heartbeat_missing"));
  const deltas =
    f0 && e5[0] && e5[1] && f1
      ? {
          firstWarningDeltaMs: (e5[0].atMs as number) - (f0.atMs as number),
          secondWarningDeltaMs: (e5[1].atMs as number) - (f0.atMs as number),
          resetStartDeltaMs: (f1.atMs as number) - (f0.atMs as number),
        }
      : null;
  if (deltas) {
    for (const [name, expected, code] of [
      [
        "firstWarningDeltaMs",
        timing.firstWarningAfterF0Ms,
        "controller_first_warning_timing_invalid",
      ],
      [
        "secondWarningDeltaMs",
        timing.secondWarningAfterF0Ms,
        "controller_second_warning_timing_invalid",
      ],
      [
        "resetStartDeltaMs",
        timing.resetStartAfterF0Ms,
        "controller_reset_start_timing_invalid",
      ],
    ] as Array<[string, number, string]>)
      if (
        Math.abs(
          (deltas as JsonRecord)[String(name)] as number,
        ) -
          Number(expected) >
          Number(timing.controllerTimingToleranceMs)
      )
        diagnostics.push(diagnostic(code));
  }
  return {
    ok: diagnostics.length === 0,
    diagnostics,
    events: {
      command: commands[0] ?? null,
      f0,
      firstE5: e5[0] ?? null,
      secondE5: e5[1] ?? null,
      f1,
      af,
      f2,
    },
    timing: deltas,
  };
}

function runtimeMatches(actual: unknown, expected: unknown): boolean {
  const actualRecord = recordValue(actual);
  const expectedRecord = recordValue(expected);
  return [
    "processId",
    "executablePath",
    "principal",
    "sessionId",
    "cdpTargetId",
    "cdpSessionId",
  ].every((name) => actualRecord[name] === expectedRecord[name]);
}

export function analyzeDelayedPickupUiEvidence(
  machineEvidence: unknown,
  expectedBinding: JsonRecord,
  canonicalRuntime: unknown,
): JsonRecord {
  const evidence = recordValue(machineEvidence);
  const diagnostics: JsonRecord[] = [];
  if (
    evidence?.schemaVersion !== "machine-production-evidence/v2" ||
    evidence.source !== "installed_canonical_machine_cdp" ||
    !completeBinding(evidence.binding, expectedBinding) ||
    !runtimeMatches(evidence.runtime, canonicalRuntime) ||
    !Array.isArray(evidence.uiObservations)
  ) {
    return {
      ok: false,
      diagnostics: [diagnostic("canonical_machine_cdp_evidence_missing")],
      firstBySurface: {},
      observations: [],
    };
  }
  const observations: JsonRecord[] = [];
  const captureStartMs = timestamp(evidence.captureStartedAt);
  const captureEndMs = timestamp(evidence.captureCompletedAt);
  if (
    captureStartMs === null ||
    captureEndMs === null ||
    captureEndMs <= captureStartMs
  )
    diagnostics.push(diagnostic("machine_capture_window_invalid"));
  arrayValue(evidence.uiObservations).forEach((entry: unknown, index: number) => {
    const entryRecord = recordValue(entry);
    const atMs = timestamp(entryRecord?.observedAt);
    if (
      !UI_SURFACES.includes(String(entryRecord?.surface ?? "")) ||
      entryRecord.route !== "#/dispensing" ||
      atMs === null ||
      (captureStartMs !== null && atMs < captureStartMs) ||
      (captureEndMs !== null && atMs > captureEndMs) ||
      !["orderId", "orderNo", "commandId", "commandNo"].every(
        (name) =>
          recordValue(entryRecord.observedSale)[name] === expectedBinding[name],
      )
    ) {
      diagnostics.push(diagnostic("ui_observation_binding_invalid", { index }));
      return;
    }
    observations.push({ ...entryRecord, atMs });
  });
  const firstBySurface = Object.fromEntries(
    UI_SURFACES.map((surface) => [
      surface,
      observations.find((entry) => entry.surface === surface) ?? null,
    ]),
  ) as JsonRecord;
  if (UI_SURFACES.some((surface) => !firstBySurface[surface]))
    diagnostics.push(diagnostic("ui_surface_sequence_incomplete"));
  const ordered = UI_SURFACES.map(
    (surface) => firstBySurface[surface] as JsonRecord | null | undefined,
  ).filter((entry): entry is JsonRecord => Boolean(entry));
  if (
    ordered.length === UI_SURFACES.length &&
    ordered.some(
      (entry: JsonRecord, index: number) => {
        if (index === 0) return false;
        return (
          (entry.atMs as number) <=
          ((ordered[index - 1] as JsonRecord).atMs as number)
        );
      },
    )
  )
    diagnostics.push(diagnostic("ui_surface_sequence_order_invalid"));
  return {
    ok: diagnostics.length === 0,
    diagnostics,
    observations,
    firstBySurface,
  };
}

export function analyzeDelayedPickupRuntimeTrace(
  machineEvidence: unknown,
  expectedBinding: JsonRecord,
  canonicalRuntime: unknown,
  timing = DEFAULT_DELAYED_PICKUP_TIMING,
): JsonRecord {
  const evidence = recordValue(machineEvidence);
  const diagnostics: JsonRecord[] = [];
  if (
    evidence?.schemaVersion !== "machine-production-evidence/v2" ||
    !completeBinding(evidence.binding, expectedBinding) ||
    !runtimeMatches(evidence.runtime, canonicalRuntime) ||
    !Array.isArray(evidence.runtimeTrace)
  ) {
    return {
      ok: false,
      diagnostics: [diagnostic("runtime_trace_missing")],
      cues: {},
    };
  }
  const captureStartMs = timestamp(evidence.captureStartedAt);
  const captureEndMs = timestamp(evidence.captureCompletedAt);
  if (
    captureStartMs === null ||
    captureEndMs === null ||
    captureEndMs <= captureStartMs
  )
    diagnostics.push(diagnostic("machine_capture_window_invalid"));
  const transitionPrefix = `transaction:${expectedBinding.orderNo}:`;
  const trace = arrayValue(evidence.runtimeTrace)
    .map((entry: unknown) => recordValue(entry))
    .filter(
      (entry) =>
      [
        "journey_transition",
        "audio_queued",
        "audio_started",
        "audio_terminal",
        "audio_rejected",
      ].includes(String(entry?.type ?? "")) &&
      String(entry?.transitionId ?? "").startsWith(transitionPrefix),
    );
  const ids = new Set<unknown>();
  const journeyTransitionIds = new Set<unknown>();
  const terminalOutcomeIds = new Set<unknown>();
  let previousId = 0;
  let previousAt = -Infinity;
  trace.forEach((entry: JsonRecord, index: number) => {
    const atMs = timestamp(entry?.at);
    const recordedAtMs = timestamp(entry?.recordedAt);
    if (
      !Number.isSafeInteger(entry?.id) ||
      (entry.id as number) < 1 ||
      ids.has(entry.id) ||
      (entry.id as number) <= previousId ||
      atMs === null ||
      recordedAtMs === null ||
      atMs !== recordedAtMs ||
      atMs < previousAt ||
      (captureStartMs !== null && atMs < captureStartMs) ||
      (captureEndMs !== null && atMs > captureEndMs) ||
      !TOKEN_ID.test(String(entry?.transitionId ?? "")) ||
      (entry.requestId !== null &&
        !AUDIO_REQUEST_ID.test(String(entry.requestId ?? "")))
    )
      diagnostics.push(diagnostic("runtime_trace_entry_invalid", { index }));
    if (entry?.type === "journey_transition") {
      if (journeyTransitionIds.has(entry.transitionId))
        diagnostics.push(
          diagnostic("runtime_transition_id_duplicate", { index }),
        );
      journeyTransitionIds.add(entry.transitionId);
    }
    if (entry?.type === "audio_terminal") {
      if (
        !TOKEN_ID.test(String(entry.terminalOutcomeId ?? "")) ||
        terminalOutcomeIds.has(entry.terminalOutcomeId)
      )
        diagnostics.push(
          diagnostic("runtime_terminal_outcome_id_invalid", { index }),
        );
      terminalOutcomeIds.add(entry.terminalOutcomeId);
    } else if (entry?.terminalOutcomeId !== null)
      diagnostics.push(
        diagnostic("runtime_terminal_outcome_id_invalid", { index }),
      );
    ids.add(entry.id);
    previousId = entry.id as number;
    if (atMs !== null) previousAt = atMs;
  });
  const queuedRequestIds = trace
    .filter((entry) => entry?.type === "audio_queued")
    .map((entry) => entry.requestId);
  if (
    queuedRequestIds.some(
      (requestId: unknown) =>
        !AUDIO_REQUEST_ID.test(String(requestId ?? "")),
    ) ||
    new Set(queuedRequestIds).size !== queuedRequestIds.length
  )
    diagnostics.push(
      diagnostic("runtime_audio_request_id_duplicate_or_missing"),
    );
  const cues: JsonRecord = {};
  for (const [label, suffix] of PICKUP_TRACE_CUES) {
    const transitionId = `transaction:${expectedBinding.orderNo}:${suffix}`;
    const entries = trace.filter(
      (entry: JsonRecord) => entry?.transitionId === transitionId,
    );
    if (entries.some((entry) => entry.type === "audio_rejected"))
      diagnostics.push(
        diagnostic("runtime_audio_request_rejected", { transitionId }),
      );
    const byType = Object.fromEntries(
      [
        "journey_transition",
        "audio_queued",
        "audio_started",
        "audio_terminal",
      ].map((type) => [type, entries.filter((entry) => entry.type === type)]),
    ) as Record<string, JsonRecord[]>;
    for (const [type, matches] of Object.entries(byType))
      if (matches.length !== 1)
        diagnostics.push(
          diagnostic("runtime_trace_event_count_invalid", {
            transitionId,
            type,
            count: matches.length,
          }),
        );
    const journey = byType.journey_transition[0] ?? null;
    const queued = byType.audio_queued[0] ?? null;
    const started = byType.audio_started[0] ?? null;
    const terminal = byType.audio_terminal[0] ?? null;
    const requestIds = [queued, started, terminal].map(
      (entry: JsonRecord | null) => entry?.requestId,
    );
    if (
      requestIds.some(
        (value: unknown) => !AUDIO_REQUEST_ID.test(String(value ?? "")),
      ) ||
      new Set(requestIds).size !== 1 ||
      journey?.requestId !== null
    )
      diagnostics.push(
        diagnostic("runtime_audio_request_binding_invalid", { transitionId }),
      );
    const terminalOutcomeAccepted = terminal?.outcome === "completed";
    if (
      !terminalOutcomeAccepted ||
      !TOKEN_ID.test(String(terminal?.terminalOutcomeId ?? "")) ||
      terminal?.terminalOutcomeId !== `audio-terminal:${requestIds[0]}`
    )
      diagnostics.push(
        diagnostic("runtime_audio_terminal_outcome_invalid", { transitionId }),
      );
    const times = [journey, queued, started, terminal].map((entry) =>
      timestamp(entry?.at),
    );
    if (
      times.some((value) => value === null) ||
      times.some(
        (value: number | null, index: number) =>
          index > 0 &&
          value !== null &&
          times[index - 1] !== null &&
          value < (times[index - 1] as number),
      )
    )
      diagnostics.push(
        diagnostic("runtime_audio_trace_order_invalid", { transitionId }),
      );
    if (
      times[0] !== null &&
      times[2] !== null &&
      ((times[2] as number) < (times[0] as number) ||
        (times[2] as number) - (times[0] as number) >
          Number(timing.maxCueStartLatencyMs))
    )
      diagnostics.push(
        diagnostic("runtime_audio_cue_start_latency_invalid", {
          transitionId,
          latencyMs: (times[2] as number) - (times[0] as number),
          maximumMs: timing.maxCueStartLatencyMs,
        }),
      );
    cues[label] = {
      transitionId,
      journey,
      queued,
      started,
      terminal,
      startLatencyMs:
        times[0] === null || times[2] === null
          ? null
          : (times[2] as number) - (times[0] as number),
    };
  }
  const [terminalLabel, terminalSuffix] = TERMINAL_SUCCESS_TRACE;
  const terminalTransitionId = `${transitionPrefix}${terminalSuffix}`;
  const terminalEntries = trace.filter(
    (entry: JsonRecord) => entry?.transitionId === terminalTransitionId,
  );
  const terminalJourney = terminalEntries.filter(
    (entry: JsonRecord) => entry.type === "journey_transition",
  );
  const terminalAudio = terminalEntries.filter(
    (entry: JsonRecord) => entry.type !== "journey_transition",
  );
  if (terminalJourney.length !== 1)
    diagnostics.push(
      diagnostic("runtime_terminal_success_transition_invalid", {
        transitionId: terminalTransitionId,
        count: terminalJourney.length,
      }),
    );
  if (terminalAudio.length !== 0)
    diagnostics.push(
      diagnostic("runtime_terminal_success_audio_present", {
        transitionId: terminalTransitionId,
        types: terminalAudio.map((entry: JsonRecord) => entry.type),
      }),
    );
  cues[terminalLabel] = {
    transitionId: terminalTransitionId,
    journey: terminalJourney[0] ?? null,
    queued: null,
    started: null,
    terminal: null,
    startLatencyMs: null,
  };
  return { ok: diagnostics.length === 0, diagnostics, cues };
}

export function pickupCueWithinPickupPhase({
  playback,
  controller,
  clockOffsetMs = 0,
  toleranceMs = 0,
}: {
  playback: unknown;
  controller: JsonRecord;
  clockOffsetMs?: number;
  toleranceMs?: number;
}): boolean {
  const pickupAt = timestamp(recordValue(playback).at);
  const pickupStartedAt = timestamp(recordValue(controller.f0).at);
  const resetStartedAt = timestamp(recordValue(controller.f1).at);
  const adjustedPickupAt = pickupAt === null ? null : pickupAt - clockOffsetMs;
  return (
    adjustedPickupAt !== null &&
    pickupStartedAt !== null &&
    resetStartedAt !== null &&
    adjustedPickupAt >= pickupStartedAt - toleranceMs &&
    adjustedPickupAt < resetStartedAt
  );
}

function rawSnapshot(
  value: unknown,
  label: string,
  expectedRunId: unknown,
): JsonRecord {
  const record = recordValue(value);
  const scope = recordValue(record.scope);
  const raw = recordValue(record.raw);
  if (
    record?.schemaVersion !== "installed-kiosk-sale-platform-raw-records/v3" ||
    record.source !== "authoritative_ephemeral_platform_database" ||
    timestamp(record.capturedAt) === null ||
    scope?.runId !== expectedRunId ||
    typeof scope?.machineId !== "string" ||
    !record.raw
  )
    throw new Error(`${label} authoritative platform snapshot is invalid`);
  for (const name of [
    "orders",
    "orderItems",
    "payments",
    "reservations",
    "commands",
    "movements",
    "inventories",
  ])
    if (!Array.isArray(raw[name]))
      throw new Error(`${label} authoritative platform ${name} is invalid`);
  return record;
}

function deltaRecords(
  baseline: JsonRecord,
  later: JsonRecord,
  name: string,
): unknown[] {
  const ids = new Set(
    arrayValue(recordValue(baseline.raw)[name]).map(
      (entry: unknown) => recordValue(entry).id,
    ),
  );
  return arrayValue(recordValue(later.raw)[name]).filter(
    (entry: unknown) => !ids.has(recordValue(entry).id),
  );
}

export function analyzeAuthoritativePlatformEvidence({
  runId,
  baseline,
  atF1,
  postF2,
}: {
  runId: unknown;
  baseline: unknown;
  atF1: unknown;
  postF2: unknown;
}): JsonRecord {
  const diagnostics: JsonRecord[] = [];
  let baselineRecord: JsonRecord;
  let atF1Record: JsonRecord;
  let postF2Record: JsonRecord;
  try {
    baselineRecord = rawSnapshot(baseline, "baseline", runId);
    atF1Record = rawSnapshot(atF1, "F1", runId);
    postF2Record = rawSnapshot(postF2, "post-F2", runId);
  } catch (error) {
    return {
      ok: false,
      diagnostics: [
        diagnostic("authoritative_platform_evidence_invalid", {
          message: error instanceof Error ? error.message : String(error),
        }),
      ],
      binding: null,
    };
  }
  if (
    recordValue(baselineRecord.scope).machineId !==
      recordValue(atF1Record.scope).machineId ||
    recordValue(baselineRecord.scope).machineId !==
      recordValue(postF2Record.scope).machineId
  )
    diagnostics.push(diagnostic("authoritative_platform_scope_mismatch"));
  const baselineCapturedAt = timestamp(baselineRecord.capturedAt);
  const atF1CapturedAt = timestamp(atF1Record.capturedAt);
  const postF2CapturedAt = timestamp(postF2Record.capturedAt);
  if (
    baselineCapturedAt === null ||
    atF1CapturedAt === null ||
    postF2CapturedAt === null ||
    baselineCapturedAt >= atF1CapturedAt ||
    atF1CapturedAt >= postF2CapturedAt
  )
    diagnostics.push(
      diagnostic("authoritative_platform_capture_order_invalid"),
    );
  if (deltaRecords(baselineRecord, atF1Record, "movements").length !== 0)
    diagnostics.push(diagnostic("platform_inventory_decremented_before_f2"));
  const f1 = Object.fromEntries(
    ["orders", "orderItems", "payments", "reservations", "commands"].map(
      (name) => [name, deltaRecords(baselineRecord, atF1Record, name)],
    ),
  );
  const f1Orders = arrayValue(f1.orders).map((entry: unknown) =>
    recordValue(entry),
  );
  const f1OrderItems = arrayValue(f1.orderItems).map((entry: unknown) =>
    recordValue(entry),
  );
  const f1Payments = arrayValue(f1.payments).map((entry: unknown) =>
    recordValue(entry),
  );
  const f1Reservations = arrayValue(f1.reservations).map((entry: unknown) =>
    recordValue(entry),
  );
  const f1Commands = arrayValue(f1.commands).map((entry: unknown) =>
    recordValue(entry),
  );
  for (const [name, records] of Object.entries(f1))
    if (records.length !== 1)
      diagnostics.push(
        diagnostic("platform_f1_exact_once_invalid", {
          name,
          count: records.length,
        }),
      );
  const post = Object.fromEntries(
    [
      "orders",
      "orderItems",
      "payments",
      "reservations",
      "commands",
      "movements",
    ].map((name) => [name, deltaRecords(baselineRecord, postF2Record, name)]),
  );
  for (const name of Object.keys(post))
    if (post[name].length !== 1)
      diagnostics.push(
        diagnostic("platform_exact_once_invalid", {
          name,
          count: post[name].length,
        }),
      );
  const postOrders = arrayValue(post.orders).map((entry: unknown) =>
    recordValue(entry),
  );
  const postOrderItems = arrayValue(post.orderItems).map((entry: unknown) =>
    recordValue(entry),
  );
  const postPayments = arrayValue(post.payments).map((entry: unknown) =>
    recordValue(entry),
  );
  const postReservations = arrayValue(post.reservations).map((entry: unknown) =>
    recordValue(entry),
  );
  const postCommands = arrayValue(post.commands).map((entry: unknown) =>
    recordValue(entry),
  );
  const postMovements = arrayValue(post.movements).map((entry: unknown) =>
    recordValue(entry),
  );
  const order = postOrders[0] ?? null;
  const item = postOrderItems[0] ?? null;
  const payment = postPayments[0] ?? null;
  const reservation = postReservations[0] ?? null;
  const command = postCommands[0] ?? null;
  const movement = postMovements[0] ?? null;
  const inventoriesByStage =
    typeof item?.inventoryId === "string"
      ? {
          baseline: arrayValue(recordValue(baselineRecord.raw).inventories)
            .map((entry: unknown) => recordValue(entry))
            .find((entry) => entry?.id === item.inventoryId),
          atF1: arrayValue(recordValue(atF1Record.raw).inventories)
            .map((entry: unknown) => recordValue(entry))
            .find((entry) => entry?.id === item.inventoryId),
          postF2: arrayValue(recordValue(postF2Record.raw).inventories)
            .map((entry: unknown) => recordValue(entry))
            .find((entry) => entry?.id === item.inventoryId),
        }
      : {
          baseline: null,
          atF1: null,
          postF2: null,
        };
  if (
    f1Orders[0]?.id !== order?.id ||
    f1OrderItems[0]?.id !== item?.id ||
    f1Payments[0]?.id !== payment?.id ||
    f1Reservations[0]?.id !== reservation?.id ||
    f1Commands[0]?.id !== command?.id ||
    f1Commands[0]?.commandNo !== command?.commandNo ||
    f1Reservations[0]?.orderId !== order?.id
  )
    diagnostics.push(diagnostic("platform_f1_sale_binding_invalid"));
  const f1OrderStateValid =
    f1Orders[0]?.status === "dispensing" ||
    (f1Orders[0]?.status === "paid" &&
      f1Orders[0]?.paymentState === "paid" &&
      f1Orders[0]?.fulfillmentState === "awaiting_fulfillment");
  if (
    !f1OrderStateValid ||
    f1Payments[0]?.status !== "succeeded" ||
    f1Reservations[0]?.status !== "active" ||
    !new Set(["pending", "sent", "acknowledged", "dispensing"]).has(
      String(f1Commands[0]?.status ?? ""),
    )
  )
    diagnostics.push(diagnostic("platform_f1_not_nonterminal"));
  const baselineOnHand = Number(inventoriesByStage.baseline?.onHandQty);
  const atF1OnHand = Number(inventoriesByStage.atF1?.onHandQty);
  const postF2OnHand = Number(inventoriesByStage.postF2?.onHandQty);
  if (
    !Number.isFinite(baselineOnHand) ||
    !Number.isFinite(atF1OnHand) ||
    !Number.isFinite(postF2OnHand)
  ) {
    diagnostics.push(
      diagnostic("platform_inventory_snapshot_missing", {
        inventoryId: item?.inventoryId ?? null,
      }),
    );
  } else {
    if (atF1OnHand !== baselineOnHand)
      diagnostics.push(
        diagnostic("platform_inventory_changed_before_f2", {
          inventoryId: item?.inventoryId ?? null,
          baselineOnHand,
          atF1OnHand,
        }),
      );
    if (postF2OnHand !== baselineOnHand - 1)
      diagnostics.push(
        diagnostic("platform_inventory_delta_after_f2_invalid", {
          inventoryId: item?.inventoryId ?? null,
          baselineOnHand,
          postF2OnHand,
        }),
      );
  }
  if (
    !order ||
    !item ||
    !payment ||
    !reservation ||
    !command ||
    !movement ||
    order.status !== "fulfilled" ||
    item.orderId !== order.id ||
    item.quantity !== 1 ||
    payment.orderId !== order.id ||
    payment.status !== "succeeded" ||
    reservation.orderId !== order.id ||
    reservation.orderItemId !== item.id ||
    reservation.inventoryId !== item.inventoryId ||
    reservation.quantity !== 1 ||
    reservation.status !== "confirmed" ||
    command.orderId !== order.id ||
    command.orderItemId !== item.id ||
    command.slotId !== item.slotId ||
    command.status !== "succeeded" ||
    movement.orderNo !== order.orderNo ||
    movement.orderItemId !== item.id ||
    movement.inventoryId !== item.inventoryId ||
    movement.slotId !== item.slotId ||
    movement.commandNo !== command.commandNo ||
    movement.movementType !== "dispense_succeeded" ||
    movement.status !== "accepted" ||
    movement.quantity !== 1
  )
    diagnostics.push(diagnostic("platform_sale_chain_invalid"));
  return {
    ok: diagnostics.length === 0,
    diagnostics,
    binding:
      order && payment && command
        ? {
            runId,
            orderId: order.id,
            orderNo: order.orderNo,
            paymentId: payment.id,
            commandId: command.id,
            commandNo: command.commandNo,
            inventoryId: item?.inventoryId ?? null,
            slotId: item?.slotId ?? null,
          }
        : null,
    exactOnce: {
      orderCount: post.orders.length,
      paymentCount: post.payments.length,
      commandCount: post.commands.length,
      movementCount: post.movements.length,
      platformStockDelta: movement ? -Number(movement.quantity) : null,
      baselineOnHandQty: Number.isFinite(baselineOnHand)
        ? baselineOnHand
        : null,
      atF1OnHandQty: Number.isFinite(atF1OnHand) ? atF1OnHand : null,
      postF2OnHandQty: Number.isFinite(postF2OnHand) ? postF2OnHand : null,
    },
    f1Capture: {
      capturedAt: atF1Record.capturedAt,
    },
  };
}

function stockFor(checkpoint: unknown, platform: JsonRecord): unknown {
  const saleView = recordValue(recordValue(checkpoint).saleView);
  const matches = arrayValue(saleView.items)
    .map((item: unknown) => recordValue(item))
    .filter(
      (item) =>
      item?.inventoryId === platform.inventoryId &&
      item?.slotId === platform.slotId,
    );
  return matches.length === 1 ? matches[0].physicalStock : null;
}

export function analyzeDaemonFulfillmentStoreEvidence(
  evidence: unknown,
  expectedBinding: JsonRecord,
  platformBinding: JsonRecord,
): JsonRecord {
  const evidenceRecord = recordValue(evidence);
  const diagnostics: JsonRecord[] = [];
  if (
    evidenceRecord?.schemaVersion !== "daemon-fulfillment-store-evidence/v1" ||
    evidenceRecord.source !== "vending_daemon_ipc" ||
    !completeBinding(evidenceRecord.binding, expectedBinding) ||
    !Array.isArray(evidenceRecord.checkpoints)
  )
    return {
      ok: false,
      diagnostics: [diagnostic("daemon_fulfillment_store_evidence_missing")],
      stock: null,
    };
  const checkpoints = arrayValue(evidenceRecord.checkpoints).map(
    (entry: unknown) => recordValue(entry),
  );
  const byStage = Object.fromEntries(
    ["before_f0", "after_f1_before_f2", "after_f2"].map((stage) => [
      stage,
      checkpoints.filter((entry) => entry?.stage === stage),
    ]),
  ) as Record<string, JsonRecord[]>;
  let previousCheckpointAt = -Infinity;
  for (const [index, checkpoint] of checkpoints.entries()) {
    const at = timestamp(checkpoint?.capturedAt);
    if (at === null || at <= previousCheckpointAt)
      diagnostics.push(
        diagnostic("daemon_checkpoint_order_invalid", { index }),
      );
    if (at !== null) previousCheckpointAt = at;
  }
  for (const [stage, matches] of Object.entries(byStage)) {
    if (matches.length !== 1)
      diagnostics.push(
        diagnostic("daemon_checkpoint_count_invalid", {
          stage,
          count: matches.length,
        }),
      );
    const checkpoint = matches[0];
    if (
      timestamp(checkpoint?.capturedAt) === null ||
      !completeBinding(checkpoint?.binding, expectedBinding)
    )
      diagnostics.push(
        diagnostic("daemon_checkpoint_binding_invalid", { stage }),
      );
  }
  const before = byStage.before_f0[0];
  const f1 = byStage.after_f1_before_f2[0];
  const f2 = byStage.after_f2[0];
  const stocks = {
    beforeF0: stockFor(before, platformBinding),
    atF1: stockFor(f1, platformBinding),
    afterF2: stockFor(f2, platformBinding),
  };
  if (
    !Number.isInteger(Number(stocks.beforeF0)) ||
    Number(stocks.atF1) !== Number(stocks.beforeF0)
  )
    diagnostics.push(diagnostic("daemon_inventory_changed_before_f2"));
  if (Number(stocks.afterF2) !== Number(stocks.beforeF0) - 1)
    diagnostics.push(diagnostic("daemon_inventory_delta_after_f2_invalid"));
  const f1Transaction = recordValue(f1?.transaction);
  const f1Vending = recordValue(f1Transaction.vending);
  const f1PickupCompleted =
    f1Vending?.fulfillmentProgressStage === "pickup_completed" ||
    recordValue(f1Vending.pickupReminder).stage === "pickup_completed";
  if (
    f1Transaction?.orderNo !== expectedBinding.orderNo ||
    f1Vending?.commandNo !== expectedBinding.commandNo ||
    f1Transaction?.nextAction !== "dispensing" ||
    f1Transaction?.orderStatus === "fulfilled" ||
    f1Vending?.status === "succeeded" ||
    f1Vending?.status === "failed" ||
    !f1PickupCompleted
  )
    diagnostics.push(diagnostic("daemon_f1_not_nonterminal"));
  const f2Transaction = recordValue(f2?.transaction);
  if (
    f2Transaction?.orderNo !== expectedBinding.orderNo ||
    recordValue(f2Transaction.vending).commandNo !== expectedBinding.commandNo ||
    f2Transaction?.nextAction !== "success" ||
    f2Transaction?.orderStatus !== "fulfilled" ||
    recordValue(f2Transaction.vending).status !== "succeeded"
  )
    diagnostics.push(diagnostic("daemon_f2_terminal_state_invalid"));
  return {
    ok: diagnostics.length === 0,
    diagnostics,
    stock: stocks,
    checkpointTimes: {
      beforeF0: before?.capturedAt ?? null,
      atF1: f1?.capturedAt ?? null,
      afterF2: f2?.capturedAt ?? null,
    },
  };
}

export function correlateDelayedPickupCueWindows({
  captureBytes,
  captureStartedAt,
  captureCompletedAt,
  cues,
  clockOffsetMs = 0,
  threshold =
    DEFAULT_AUDIO_CUE_WINDOW_THRESHOLD as unknown as Parameters<
      typeof inspectWavPcm
    >[1],
}: {
  captureBytes: Buffer;
  captureStartedAt: unknown;
  captureCompletedAt: unknown;
  cues: JsonRecord;
  clockOffsetMs?: number;
  threshold?: Parameters<typeof inspectWavPcm>[1];
}): JsonRecord {
  const diagnostics: JsonRecord[] = [];
  const captureStartMs = timestamp(captureStartedAt);
  const captureEndMs = timestamp(captureCompletedAt);
  if (
    captureStartMs === null ||
    captureEndMs === null ||
    captureEndMs <= captureStartMs
  )
    return {
      ok: false,
      diagnostics: [diagnostic("default_audio_capture_window_binding_missing")],
      inspections: [],
    };
  const windows: JsonRecord[] = [];
  PICKUP_TRACE_CUES.forEach(([label]) => {
    const cue = recordValue(cues[label]);
    const rawStarted = timestamp(recordValue(cue.started).at);
    const rawTerminal = timestamp(recordValue(cue.terminal).at);
    const started = rawStarted === null ? null : rawStarted - clockOffsetMs;
    const terminal = rawTerminal === null ? null : rawTerminal - clockOffsetMs;
    if (started === null || terminal === null || terminal <= started) {
      diagnostics.push(
        diagnostic("audio_cue_window_missing_or_empty", {
          label,
        }),
      );
      return;
    }
    const startMs = Math.max(0, started - captureStartMs - 250);
    const endMs = Math.min(
      captureEndMs - captureStartMs,
      terminal - captureStartMs + 250,
    );
    if (endMs <= startMs || startMs < 0) {
      diagnostics.push(
        diagnostic("audio_cue_window_missing_or_empty", {
          label,
        }),
      );
      return;
    }
    windows.push({
      label,
      startMs,
      endMs,
    });
  });
  if (windows.length === 0)
    return {
      ok: false,
      diagnostics,
      inspections: [],
    };
  const sampleWindow = recordValue(
    inspectWavPcm(captureBytes, threshold),
  );
  if (!sampleWindow.ok) {
    return {
      ok: false,
      diagnostics: [diagnostic("audio_capture_malformed", sampleWindow)],
      inspections: [],
    };
  }
  const overallWindow: JsonRecord = {
    ...sampleWindow,
    label: "default_output_capture",
    startMs: 0,
    endMs: sampleWindow.durationMs,
  };
  const requiredNonSilentFrames =
    Number(threshold?.minimumNonSilentFrames) * windows.length;
  const inspections = [overallWindow];
  if (Number(sampleWindow.nonSilentFrameCount) < requiredNonSilentFrames) {
    diagnostics.push(
      diagnostic("default_audio_capture_insufficient_for_cues", {
        cueCount: windows.length,
        nonSilentFrames: sampleWindow.nonSilentFrameCount,
        requiredNonSilentFrames,
      }),
    );
  }
  for (const inspection of inspections)
    if (!inspection.ok || inspection.kind !== "passed")
      diagnostics.push(
        diagnostic("cue_audio_window_silent", {
          label: inspection.label,
          kind: inspection.kind,
        }),
      );
  return {
    ok: diagnostics.length === 0,
    diagnostics,
    inspections,
    cueTimings: windows,
  };
}

export function expectedDelayedPickupTraceCues() {
  return [
    ...PICKUP_TRACE_CUES.map(([label, suffix]) => ({ label, suffix })),
    {
      label: TERMINAL_SUCCESS_TRACE[0],
      suffix: TERMINAL_SUCCESS_TRACE[1],
      silent: true,
    },
  ];
}

export function bindingEquals(left: unknown, right: unknown): boolean {
  return (
    completeBinding(recordValue(left), recordValue(right)) &&
    completeBinding(recordValue(right), recordValue(left)) &&
    same(left, right)
  );
}
