import {
  inspectExportedDefaultAudioCapture,
  inspectWavPcmWindows,
} from "./default-audio-evidence.mjs";

export const DEFAULT_DELAYED_PICKUP_TIMING = Object.freeze({
  firstWarningAfterF0Ms: 15_000,
  secondWarningAfterF0Ms: 25_000,
  resetStartAfterF0Ms: 30_000,
  controllerTimingToleranceMs: 1_500,
  traceTimingToleranceMs: 3_000,
});

export const DEFAULT_AUDIO_CUE_WINDOW_THRESHOLD = Object.freeze({
  minimumPeakAbsoluteSample: 512,
  minimumNonSilentFrames: 4_800,
  minimumDurationMs: 100,
  minimumDistinctNonSilentSampleMagnitudes: 2,
});

const REQUIRED_UI_SURFACES = Object.freeze([
  "ordinary_warning",
  "urgent_warning",
  "reset_progress",
]);

const REQUIRED_TRACE_CUES = Object.freeze([
  { key: "outlet_opened", transitionSuffix: "pickup-outlet-opened" },
  { key: "ordinary_warning", transitionSuffix: "pickup-warning-1" },
  { key: "urgent_warning", transitionSuffix: "pickup-warning-2" },
  { key: "reset_progress", transitionSuffix: "pickup-completed" },
  { key: "dispense_succeeded", transitionSuffix: "dispense-succeeded" },
]);

function diagnostic(code, detail = null) {
  return detail === null ? { code } : { code, detail };
}

function asObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseTimestamp(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizedCode(value) {
  const code = String(value ?? "").trim().toUpperCase();
  return new Set(["F0", "E5", "F1", "AF", "F2"]).has(code) ? code : null;
}

function absoluteDelta(left, right) {
  return Math.abs(left - right);
}

function suffixTransitionId(orderNo, suffix) {
  return `transaction:${orderNo}:${suffix}`;
}

function captureEvidenceEntry(adapterReport) {
  const artifact = adapterReport?.defaultAudioCapture?.capture?.artifact;
  return (
    adapterReport?.evidence?.find((entry) => entry?.identity === artifact) ??
    null
  );
}

export function analyzeDelayedPickupControllerTimeline(
  controllerTimeline,
  timing = DEFAULT_DELAYED_PICKUP_TIMING,
) {
  const diagnostics = [];
  if (!Array.isArray(controllerTimeline)) {
    return {
      ok: false,
      diagnostics: [diagnostic("controller_timeline_missing")],
      events: null,
      orderNo: null,
      commandNo: null,
    };
  }
  const normalizedEvents = controllerTimeline
    .map((event, index) => {
      const code = normalizedCode(event?.code);
      const atMs = parseTimestamp(event?.at);
      if (!code || atMs === null) {
        diagnostics.push(
          diagnostic("controller_timeline_event_malformed", { index }),
        );
        return null;
      }
      return {
        code,
        at: new Date(atMs).toISOString(),
        atMs,
        orderNo:
          typeof event?.orderNo === "string" && event.orderNo.trim()
            ? event.orderNo.trim()
            : null,
        commandNo:
          typeof event?.commandNo === "string" && event.commandNo.trim()
            ? event.commandNo.trim()
            : null,
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.atMs - right.atMs);
  if (normalizedEvents.length < 6)
    diagnostics.push(diagnostic("controller_timeline_incomplete"));

  const orderNos = [...new Set(normalizedEvents.map((event) => event.orderNo).filter(Boolean))];
  const commandNos = [
    ...new Set(normalizedEvents.map((event) => event.commandNo).filter(Boolean)),
  ];
  if (orderNos.length !== 1)
    diagnostics.push(diagnostic("controller_timeline_order_binding_invalid"));
  if (commandNos.length !== 1)
    diagnostics.push(diagnostic("controller_timeline_command_binding_invalid"));

  const f0 = normalizedEvents.filter((event) => event.code === "F0");
  const e5 = normalizedEvents.filter((event) => event.code === "E5");
  const f1 = normalizedEvents.filter((event) => event.code === "F1");
  const af = normalizedEvents.filter((event) => event.code === "AF");
  const f2 = normalizedEvents.filter((event) => event.code === "F2");

  if (f0.length !== 1 || e5.length !== 2 || f1.length !== 1 || f2.length !== 1)
    diagnostics.push(
      diagnostic("controller_timeline_required_events_invalid", {
        f0: f0.length,
        e5: e5.length,
        f1: f1.length,
        af: af.length,
        f2: f2.length,
      }),
    );
  if (af.length < 1) diagnostics.push(diagnostic("controller_reset_heartbeat_missing"));

  const orderedCore = [f0[0], e5[0], e5[1], f1[0], f2[0]].filter(Boolean);
  if (
    orderedCore.length === 5 &&
    orderedCore.some((event, index) => index > 0 && event.atMs <= orderedCore[index - 1].atMs)
  ) {
    diagnostics.push(diagnostic("controller_timeline_order_invalid"));
  }
  if (
    af.length > 0 &&
    f1[0] &&
    f2[0] &&
    af.some((event) => event.atMs <= f1[0].atMs || event.atMs >= f2[0].atMs)
  ) {
    diagnostics.push(diagnostic("controller_reset_heartbeat_outside_reset_window"));
  }

  const f0AtMs = f0[0]?.atMs ?? null;
  const timingChecks =
    f0AtMs === null || !e5[0] || !e5[1] || !f1[0]
      ? null
      : {
          firstWarningDeltaMs: e5[0].atMs - f0AtMs,
          secondWarningDeltaMs: e5[1].atMs - f0AtMs,
          resetStartDeltaMs: f1[0].atMs - f0AtMs,
        };
  if (timingChecks) {
    if (
      absoluteDelta(
        timingChecks.firstWarningDeltaMs,
        timing.firstWarningAfterF0Ms,
      ) > timing.controllerTimingToleranceMs
    ) {
      diagnostics.push(diagnostic("controller_first_warning_timing_invalid"));
    }
    if (
      absoluteDelta(
        timingChecks.secondWarningDeltaMs,
        timing.secondWarningAfterF0Ms,
      ) > timing.controllerTimingToleranceMs
    ) {
      diagnostics.push(diagnostic("controller_second_warning_timing_invalid"));
    }
    if (
      absoluteDelta(
        timingChecks.resetStartDeltaMs,
        timing.resetStartAfterF0Ms,
      ) > timing.controllerTimingToleranceMs
    ) {
      diagnostics.push(diagnostic("controller_reset_start_timing_invalid"));
    }
  }

  return {
    ok: diagnostics.length === 0,
    diagnostics,
    orderNo: orderNos[0] ?? null,
    commandNo: commandNos[0] ?? null,
    events: {
      f0: f0[0] ?? null,
      firstE5: e5[0] ?? null,
      secondE5: e5[1] ?? null,
      f1: f1[0] ?? null,
      af,
      f2: f2[0] ?? null,
    },
    timing: timingChecks,
  };
}

export function analyzeDelayedPickupUiObservations(uiObservations) {
  const diagnostics = [];
  if (!Array.isArray(uiObservations)) {
    return {
      ok: false,
      diagnostics: [diagnostic("ui_observations_missing")],
      observations: [],
      orderNo: null,
    };
  }
  const observations = uiObservations
    .map((entry, index) => {
      const atMs = parseTimestamp(entry?.observedAt);
      const surface = String(entry?.surface ?? "").trim();
      const route = String(entry?.route ?? "").trim();
      const orderNo =
        typeof entry?.orderNo === "string" && entry.orderNo.trim()
          ? entry.orderNo.trim()
          : null;
      if (
        atMs === null ||
        !REQUIRED_UI_SURFACES.includes(surface) ||
        route.length === 0 ||
        orderNo === null
      ) {
        diagnostics.push(diagnostic("ui_observation_malformed", { index }));
        return null;
      }
      return {
        surface,
        route,
        orderNo,
        observedAt: new Date(atMs).toISOString(),
        atMs,
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.atMs - right.atMs);

  const orderNos = [...new Set(observations.map((entry) => entry.orderNo))];
  if (orderNos.length !== 1)
    diagnostics.push(diagnostic("ui_observation_order_binding_invalid"));
  if (observations.some((entry) => entry.route !== "#/dispensing"))
    diagnostics.push(diagnostic("ui_route_not_stable_on_dispensing"));

  const firstBySurface = REQUIRED_UI_SURFACES.map((surface) =>
    observations.find((entry) => entry.surface === surface),
  );
  if (firstBySurface.some((entry) => !entry))
    diagnostics.push(diagnostic("ui_surface_sequence_incomplete"));
  if (
    firstBySurface.every(Boolean) &&
    firstBySurface.some(
      (entry, index) => index > 0 && entry.atMs <= firstBySurface[index - 1].atMs,
    )
  ) {
    diagnostics.push(diagnostic("ui_surface_sequence_order_invalid"));
  }

  return {
    ok: diagnostics.length === 0,
    diagnostics,
    orderNo: orderNos[0] ?? null,
    observations,
    firstBySurface: Object.fromEntries(
      REQUIRED_UI_SURFACES.map((surface, index) => [
        surface,
        firstBySurface[index] ?? null,
      ]),
    ),
  };
}

export function analyzeDelayedPickupRuntimeTrace(runtimeTrace, orderNo) {
  const diagnostics = [];
  if (!Array.isArray(runtimeTrace)) {
    return {
      ok: false,
      diagnostics: [diagnostic("runtime_trace_missing")],
      cues: {},
    };
  }
  if (typeof orderNo !== "string" || orderNo.length === 0) {
    return {
      ok: false,
      diagnostics: [diagnostic("runtime_trace_order_missing")],
      cues: {},
    };
  }

  const cues = {};
  for (const definition of REQUIRED_TRACE_CUES) {
    const transitionId = suffixTransitionId(orderNo, definition.transitionSuffix);
    const entries = runtimeTrace.filter(
      (entry) => asObject(entry) && entry.transitionId === transitionId,
    );
    const journey = entries.filter(
      (entry) => entry.type === "journey_transition",
    );
    const queued = entries.filter((entry) => entry.type === "audio_queued");
    const started = entries.filter((entry) => entry.type === "audio_started");
    const terminal = entries.filter((entry) => entry.type === "audio_terminal");
    if (journey.length !== 1)
      diagnostics.push(
        diagnostic("runtime_transition_count_invalid", {
          transitionId,
          count: journey.length,
        }),
      );
    if (queued.length !== 1)
      diagnostics.push(
        diagnostic("runtime_audio_queue_count_invalid", {
          transitionId,
          count: queued.length,
        }),
      );
    if (started.length !== 1)
      diagnostics.push(
        diagnostic("runtime_audio_started_count_invalid", {
          transitionId,
          count: started.length,
        }),
      );
    if (terminal.length !== 1)
      diagnostics.push(
        diagnostic("runtime_audio_terminal_count_invalid", {
          transitionId,
          count: terminal.length,
        }),
      );
    const requestIds = [
      queued[0]?.requestId ?? null,
      started[0]?.requestId ?? null,
      terminal[0]?.requestId ?? null,
    ].filter(Boolean);
    if (requestIds.length > 0 && new Set(requestIds).size !== 1)
      diagnostics.push(
        diagnostic("runtime_audio_request_binding_invalid", { transitionId }),
      );
    if (terminal[0]?.outcome !== "completed")
      diagnostics.push(
        diagnostic("runtime_audio_terminal_outcome_invalid", {
          transitionId,
          outcome: terminal[0]?.outcome ?? null,
        }),
      );
    const times = [journey[0], queued[0], started[0], terminal[0]]
      .map((entry) => parseTimestamp(entry?.at))
      .filter((value) => value !== null);
    if (
      times.length >= 2 &&
      times.some((value, index) => index > 0 && value < times[index - 1])
    ) {
      diagnostics.push(
        diagnostic("runtime_audio_trace_order_invalid", { transitionId }),
      );
    }
    cues[definition.key] = {
      transitionId,
      journey: journey[0] ?? null,
      queued: queued[0] ?? null,
      started: started[0] ?? null,
      terminal: terminal[0] ?? null,
    };
  }

  return {
    ok: diagnostics.length === 0,
    diagnostics,
    cues,
  };
}

export function correlateDelayedPickupCueWindows({
  captureBytes,
  cueWindows,
  threshold = DEFAULT_AUDIO_CUE_WINDOW_THRESHOLD,
}) {
  const diagnostics = [];
  const windows = cueWindows.map((cue) => ({
    label: cue.label,
    startMs: cue.startMs,
    endMs: cue.endMs,
  }));
  const inspections = inspectWavPcmWindows(captureBytes, windows, threshold);
  inspections.forEach((inspection, index) => {
    if (!inspection.ok || inspection.kind !== "passed") {
      diagnostics.push(
        diagnostic("cue_audio_window_silent", {
          label: windows[index].label,
          kind: inspection.kind,
          message: inspection.message ?? null,
        }),
      );
    }
  });
  return {
    ok: diagnostics.length === 0,
    diagnostics,
    inspections,
  };
}

export function inspectDelayedPickupDefaultAudioCapture({
  directory,
  adapterReport,
  cueWindows,
}) {
  const captureEvidence = captureEvidenceEntry(adapterReport);
  if (!captureEvidence) {
    return {
      ok: false,
      diagnostics: [diagnostic("default_audio_capture_evidence_missing")],
      captureInspection: null,
      cueWindows: null,
    };
  }
  let captureInspection;
  try {
    captureInspection = inspectExportedDefaultAudioCapture({
      directory,
      evidence: captureEvidence,
      capture: adapterReport.defaultAudioCapture.capture,
    });
  } catch (error) {
    return {
      ok: false,
      diagnostics: [
        diagnostic("default_audio_capture_export_invalid", {
          message: error instanceof Error ? error.message : String(error),
        }),
      ],
      captureInspection: null,
      cueWindows: null,
    };
  }
  const cueInspection = correlateDelayedPickupCueWindows({
    captureBytes: captureInspection.bytes,
    cueWindows,
  });
  return {
    ok: cueInspection.ok,
    diagnostics: cueInspection.diagnostics,
    captureInspection,
    cueWindows: cueInspection.inspections,
  };
}
