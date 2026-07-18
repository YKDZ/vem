import { inspectWavPcmWindows } from "./default-audio-evidence.mjs";

export const DEFAULT_DELAYED_PICKUP_TIMING = Object.freeze({
  firstWarningAfterF0Ms: 15_000,
  secondWarningAfterF0Ms: 25_000,
  resetStartAfterF0Ms: 30_000,
  controllerTimingToleranceMs: 1_500,
  traceTimingToleranceMs: 3_000,
  repeatedFrameWindowMs: 250,
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
const TRACE_CUES = [
  ["outlet_opened", "pickup-outlet-opened"],
  ["ordinary_warning", "pickup-warning-1"],
  ["urgent_warning", "pickup-warning-2"],
  ["reset_progress", "pickup-completed"],
  ["dispense_succeeded", "dispense-succeeded"],
];

function diagnostic(code, detail = null) {
  return detail === null ? { code } : { code, detail };
}

function timestamp(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function completeBinding(value, expected) {
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
      typeof value?.[name] === "string" &&
      value[name].length > 0 &&
      value[name] === expected?.[name],
  );
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function decodeControllerCode(bytesHex) {
  const match = /^80(f0|e5|f1|af|f2)$/i.exec(String(bytesHex ?? ""));
  return match ? CODES.get(match[1].toLowerCase()) : null;
}

function collapseRepeated(events, code, timing) {
  const matching = events.filter((entry) => entry.code === code);
  if (!new Set(["F0", "F1", "F2"]).has(code)) return matching;
  const groups = [];
  for (const entry of matching) {
    const group = groups.at(-1);
    if (!group || entry.atMs - group.at(-1).atMs > timing.repeatedFrameWindowMs)
      groups.push([entry]);
    else group.push(entry);
  }
  return groups;
}

export function analyzeDelayedPickupControllerFrames(
  serialCapture,
  expectedBinding,
  timing = DEFAULT_DELAYED_PICKUP_TIMING,
) {
  const diagnostics = [];
  if (
    serialCapture?.schemaVersion !==
      "host-production-serial-frame-capture/v1" ||
    !completeBinding(serialCapture?.binding, expectedBinding) ||
    !Array.isArray(serialCapture?.frames)
  ) {
    return {
      ok: false,
      diagnostics: [diagnostic("production_serial_capture_missing")],
      events: null,
      timing: null,
    };
  }
  const events = [];
  let previousSequence = 0;
  let previousAt = -Infinity;
  const seenSequences = new Set();
  serialCapture.frames.forEach((frame, index) => {
    const code = decodeControllerCode(frame?.bytesHex);
    if (!code || frame?.role !== "lower-controller") return;
    const atMs = timestamp(frame.capturedAt);
    if (
      !Number.isSafeInteger(frame.sequence) ||
      frame.sequence < 1 ||
      seenSequences.has(frame.sequence) ||
      frame.sequence <= previousSequence ||
      atMs === null ||
      atMs < previousAt
    )
      diagnostics.push(diagnostic("controller_frame_order_invalid", { index }));
    if (!completeBinding(frame.binding, expectedBinding))
      diagnostics.push(
        diagnostic("controller_frame_sale_binding_incomplete", { index, code }),
      );
    if (frame.direction !== "guest_to_host")
      diagnostics.push(
        diagnostic("controller_frame_direction_invalid", { index }),
      );
    seenSequences.add(frame.sequence);
    previousSequence = frame.sequence;
    if (atMs !== null) previousAt = atMs;
    events.push({
      code,
      at: frame.capturedAt,
      atMs,
      sequence: frame.sequence,
      digest: frame.digest ?? null,
    });
  });
  const f0Groups = collapseRepeated(events, "F0", timing);
  const f1Groups = collapseRepeated(events, "F1", timing);
  const f2Groups = collapseRepeated(events, "F2", timing);
  const e5 = collapseRepeated(events, "E5", timing);
  const af = collapseRepeated(events, "AF", timing);
  for (const [code, groups] of [
    ["F0", f0Groups],
    ["F1", f1Groups],
    ["F2", f2Groups],
  ]) {
    if (groups.length !== 1 || groups[0]?.length !== 3)
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
  const ordered = [f0, e5[0], e5[1], f1, f2].filter(Boolean);
  if (
    ordered.length === 5 &&
    ordered.some(
      (entry, index) => index > 0 && entry.atMs <= ordered[index - 1].atMs,
    )
  )
    diagnostics.push(diagnostic("controller_timeline_order_invalid"));
  if (
    !f1 ||
    !f2 ||
    !af.some((entry) => entry.atMs > f1.atMs && entry.atMs < f2.atMs)
  )
    diagnostics.push(diagnostic("controller_reset_heartbeat_missing"));
  const deltas =
    f0 && e5[0] && e5[1] && f1
      ? {
          firstWarningDeltaMs: e5[0].atMs - f0.atMs,
          secondWarningDeltaMs: e5[1].atMs - f0.atMs,
          resetStartDeltaMs: f1.atMs - f0.atMs,
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
    ])
      if (
        Math.abs(deltas[name] - expected) > timing.controllerTimingToleranceMs
      )
        diagnostics.push(diagnostic(code));
  }
  return {
    ok: diagnostics.length === 0,
    diagnostics,
    events: { f0, firstE5: e5[0] ?? null, secondE5: e5[1] ?? null, f1, af, f2 },
    timing: deltas,
  };
}

function runtimeMatches(actual, expected) {
  return [
    "processId",
    "executablePath",
    "principal",
    "sessionId",
    "cdpTargetId",
    "cdpSessionId",
  ].every((name) => actual?.[name] === expected?.[name]);
}

export function analyzeDelayedPickupUiEvidence(
  machineEvidence,
  expectedBinding,
  canonicalRuntime,
) {
  const diagnostics = [];
  if (
    machineEvidence?.schemaVersion !== "machine-production-evidence/v1" ||
    machineEvidence.source !== "installed_canonical_machine_cdp" ||
    !completeBinding(machineEvidence.binding, expectedBinding) ||
    !runtimeMatches(machineEvidence.runtime, canonicalRuntime) ||
    !Array.isArray(machineEvidence.uiObservations)
  ) {
    return {
      ok: false,
      diagnostics: [diagnostic("canonical_machine_cdp_evidence_missing")],
      firstBySurface: {},
      observations: [],
    };
  }
  const observations = [];
  machineEvidence.uiObservations.forEach((entry, index) => {
    const atMs = timestamp(entry?.observedAt);
    if (
      !UI_SURFACES.includes(entry?.surface) ||
      entry.route !== "#/dispensing" ||
      atMs === null ||
      !completeBinding(entry.binding, expectedBinding) ||
      !runtimeMatches(entry.runtime, canonicalRuntime)
    ) {
      diagnostics.push(diagnostic("ui_observation_binding_invalid", { index }));
      return;
    }
    observations.push({ ...entry, atMs });
  });
  const firstBySurface = Object.fromEntries(
    UI_SURFACES.map((surface) => [
      surface,
      observations.find((entry) => entry.surface === surface) ?? null,
    ]),
  );
  if (UI_SURFACES.some((surface) => !firstBySurface[surface]))
    diagnostics.push(diagnostic("ui_surface_sequence_incomplete"));
  const ordered = UI_SURFACES.map((surface) => firstBySurface[surface]).filter(
    Boolean,
  );
  if (
    ordered.length === UI_SURFACES.length &&
    ordered.some(
      (entry, index) => index > 0 && entry.atMs <= ordered[index - 1].atMs,
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
  machineEvidence,
  expectedBinding,
  canonicalRuntime,
) {
  const diagnostics = [];
  if (
    machineEvidence?.schemaVersion !== "machine-production-evidence/v1" ||
    !completeBinding(machineEvidence.binding, expectedBinding) ||
    !runtimeMatches(machineEvidence.runtime, canonicalRuntime) ||
    !Array.isArray(machineEvidence.runtimeTrace)
  ) {
    return {
      ok: false,
      diagnostics: [diagnostic("runtime_trace_missing")],
      cues: {},
    };
  }
  const trace = machineEvidence.runtimeTrace;
  const ids = new Set();
  const terminalOutcomeIds = new Set();
  let previousId = 0;
  let previousAt = -Infinity;
  trace.forEach((entry, index) => {
    const atMs = timestamp(entry?.at);
    const recordedAtMs = timestamp(entry?.recordedAt);
    if (
      !Number.isSafeInteger(entry?.id) ||
      entry.id < 1 ||
      ids.has(entry.id) ||
      entry.id <= previousId ||
      atMs === null ||
      recordedAtMs === null ||
      atMs !== recordedAtMs ||
      atMs < previousAt ||
      typeof entry.transitionId !== "string" ||
      entry.transitionId.length === 0
    )
      diagnostics.push(diagnostic("runtime_trace_entry_invalid", { index }));
    if (entry?.type === "audio_terminal") {
      if (
        typeof entry.terminalOutcomeId !== "string" ||
        entry.terminalOutcomeId.length === 0 ||
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
    previousId = entry.id;
    if (atMs !== null) previousAt = atMs;
  });
  const queuedRequestIds = trace
    .filter((entry) => entry?.type === "audio_queued")
    .map((entry) => entry.requestId);
  if (
    queuedRequestIds.some(
      (requestId) => typeof requestId !== "string" || requestId.length === 0,
    ) ||
    new Set(queuedRequestIds).size !== queuedRequestIds.length
  )
    diagnostics.push(
      diagnostic("runtime_audio_request_id_duplicate_or_missing"),
    );
  const cues = {};
  for (const [label, suffix] of TRACE_CUES) {
    const transitionId = `transaction:${expectedBinding.orderNo}:${suffix}`;
    const entries = trace.filter(
      (entry) => entry?.transitionId === transitionId,
    );
    const byType = Object.fromEntries(
      [
        "journey_transition",
        "audio_queued",
        "audio_started",
        "audio_terminal",
      ].map((type) => [type, entries.filter((entry) => entry.type === type)]),
    );
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
      (entry) => entry?.requestId,
    );
    if (
      requestIds.some(
        (value) => typeof value !== "string" || value.length === 0,
      ) ||
      new Set(requestIds).size !== 1 ||
      journey?.requestId !== null
    )
      diagnostics.push(
        diagnostic("runtime_audio_request_binding_invalid", { transitionId }),
      );
    if (
      terminal?.outcome !== "completed" ||
      typeof terminal?.terminalOutcomeId !== "string"
    )
      diagnostics.push(
        diagnostic("runtime_audio_terminal_outcome_invalid", { transitionId }),
      );
    const times = [journey, queued, started, terminal].map((entry) =>
      timestamp(entry?.at),
    );
    if (
      times.some((value) => value === null) ||
      times.some((value, index) => index > 0 && value < times[index - 1])
    )
      diagnostics.push(
        diagnostic("runtime_audio_trace_order_invalid", { transitionId }),
      );
    cues[label] = { transitionId, journey, queued, started, terminal };
  }
  return { ok: diagnostics.length === 0, diagnostics, cues };
}

function rawSnapshot(value, label, expectedRunId) {
  if (
    value?.schemaVersion !== "installed-kiosk-sale-platform-raw-records/v2" ||
    value.source !== "authoritative_ephemeral_platform_database" ||
    value.scope?.runId !== expectedRunId ||
    typeof value.scope?.machineId !== "string" ||
    !value.raw
  )
    throw new Error(`${label} authoritative platform snapshot is invalid`);
  for (const name of [
    "orders",
    "orderItems",
    "payments",
    "reservations",
    "commands",
    "movements",
  ])
    if (!Array.isArray(value.raw[name]))
      throw new Error(`${label} authoritative platform ${name} is invalid`);
  return value;
}

function deltaRecords(baseline, later, name) {
  const ids = new Set(baseline.raw[name].map((entry) => entry.id));
  return later.raw[name].filter((entry) => !ids.has(entry.id));
}

export function analyzeAuthoritativePlatformEvidence({
  runId,
  baseline,
  atF1,
  postF2,
}) {
  const diagnostics = [];
  const f1Envelope = atF1;
  try {
    baseline = rawSnapshot(baseline, "baseline", runId);
    if (
      f1Envelope?.schemaVersion !== "delayed-pickup-platform-f1-evidence/v1" ||
      f1Envelope.source !== "authoritative_ephemeral_platform_database" ||
      timestamp(f1Envelope.capturedAt) === null
    )
      throw new Error("F1 authoritative platform capture envelope is invalid");
    atF1 = rawSnapshot(f1Envelope.snapshot, "F1", runId);
    postF2 = rawSnapshot(postF2, "post-F2", runId);
  } catch (error) {
    return {
      ok: false,
      diagnostics: [
        diagnostic("authoritative_platform_evidence_invalid", {
          message: error.message,
        }),
      ],
      binding: null,
    };
  }
  if (
    baseline.scope.machineId !== atF1.scope.machineId ||
    baseline.scope.machineId !== postF2.scope.machineId
  )
    diagnostics.push(diagnostic("authoritative_platform_scope_mismatch"));
  if (deltaRecords(baseline, atF1, "movements").length !== 0)
    diagnostics.push(diagnostic("platform_inventory_decremented_before_f2"));
  const post = Object.fromEntries(
    [
      "orders",
      "orderItems",
      "payments",
      "reservations",
      "commands",
      "movements",
    ].map((name) => [name, deltaRecords(baseline, postF2, name)]),
  );
  for (const name of Object.keys(post))
    if (post[name].length !== 1)
      diagnostics.push(
        diagnostic("platform_exact_once_invalid", {
          name,
          count: post[name].length,
        }),
      );
  const order = post.orders[0];
  const item = post.orderItems[0];
  const payment = post.payments[0];
  const command = post.commands[0];
  const movement = post.movements[0];
  if (
    !order ||
    !item ||
    !payment ||
    !command ||
    !movement ||
    item.orderId !== order.id ||
    item.quantity !== 1 ||
    payment.orderId !== order.id ||
    command.orderId !== order.id ||
    command.orderItemId !== item.id ||
    command.slotId !== item.slotId ||
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
      platformStockDelta: movement ? -movement.quantity : null,
    },
    f1Capture: {
      capturedAt: f1Envelope?.capturedAt ?? null,
      binding: f1Envelope?.binding ?? null,
    },
  };
}

function stockFor(checkpoint, platform) {
  const matches = checkpoint?.saleView?.items?.filter(
    (item) =>
      item?.inventoryId === platform.inventoryId &&
      item?.slotId === platform.slotId,
  );
  return matches?.length === 1 ? matches[0].physicalStock : null;
}

export function analyzeDaemonFulfillmentStoreEvidence(
  evidence,
  expectedBinding,
  platformBinding,
) {
  const diagnostics = [];
  if (
    evidence?.schemaVersion !== "daemon-fulfillment-store-evidence/v1" ||
    evidence.source !== "vending_daemon_ipc" ||
    !completeBinding(evidence.binding, expectedBinding) ||
    !Array.isArray(evidence.checkpoints)
  )
    return {
      ok: false,
      diagnostics: [diagnostic("daemon_fulfillment_store_evidence_missing")],
      stock: null,
    };
  const byStage = Object.fromEntries(
    ["before_f0", "after_f1_before_f2", "after_f2"].map((stage) => [
      stage,
      evidence.checkpoints.filter((entry) => entry?.stage === stage),
    ]),
  );
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
  if (!Number.isInteger(stocks.beforeF0) || stocks.atF1 !== stocks.beforeF0)
    diagnostics.push(diagnostic("daemon_inventory_changed_before_f2"));
  if (stocks.afterF2 !== stocks.beforeF0 - 1)
    diagnostics.push(diagnostic("daemon_inventory_delta_after_f2_invalid"));
  const f1Transaction = f1?.transaction;
  if (
    f1Transaction?.orderNo !== expectedBinding.orderNo ||
    f1Transaction?.vending?.commandNo !== expectedBinding.commandNo ||
    f1Transaction?.nextAction !== "dispensing" ||
    f1Transaction?.orderStatus === "fulfilled" ||
    f1Transaction?.vending?.status !== "dispensing" ||
    f1Transaction?.vending?.fulfillmentProgressStage !== "pickup_completed"
  )
    diagnostics.push(diagnostic("daemon_f1_not_nonterminal"));
  const f2Transaction = f2?.transaction;
  if (
    f2Transaction?.orderNo !== expectedBinding.orderNo ||
    f2Transaction?.vending?.commandNo !== expectedBinding.commandNo ||
    f2Transaction?.nextAction !== "success" ||
    f2Transaction?.orderStatus !== "fulfilled" ||
    f2Transaction?.vending?.status !== "succeeded"
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
  threshold = DEFAULT_AUDIO_CUE_WINDOW_THRESHOLD,
}) {
  const diagnostics = [];
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
  const windows = TRACE_CUES.map(([label]) => {
    const started = timestamp(cues?.[label]?.started?.at);
    const terminal = timestamp(cues?.[label]?.terminal?.at);
    if (started === null || terminal === null || terminal <= started)
      return null;
    return {
      label,
      startMs: Math.max(0, started - captureStartMs - 250),
      endMs: Math.min(
        captureEndMs - captureStartMs,
        terminal - captureStartMs + 250,
      ),
    };
  });
  if (
    windows.some(
      (window) =>
        !window || window.endMs <= window.startMs || window.startMs < 0,
    )
  )
    return {
      ok: false,
      diagnostics: [diagnostic("audio_cue_window_missing_or_empty")],
      inspections: [],
    };
  const inspections = inspectWavPcmWindows(captureBytes, windows, threshold);
  for (const inspection of inspections)
    if (!inspection.ok || inspection.kind !== "passed")
      diagnostics.push(
        diagnostic("cue_audio_window_silent", {
          label: inspection.label,
          kind: inspection.kind,
        }),
      );
  return { ok: diagnostics.length === 0, diagnostics, inspections };
}

export function expectedDelayedPickupTraceCues() {
  return TRACE_CUES.map(([label, suffix]) => ({ label, suffix }));
}

export function bindingEquals(left, right) {
  return (
    completeBinding(left, right) &&
    completeBinding(right, left) &&
    same(left, right)
  );
}
