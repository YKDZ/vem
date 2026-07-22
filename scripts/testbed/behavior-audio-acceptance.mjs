function diagnostic(code, detail = null) {
  return detail === null ? { code } : { code, detail };
}

function timestamp(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function assertArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function ensureMonotonicTrace(trace) {
  let previousId = 0;
  let previousAt = -Infinity;
  for (const [index, entry] of trace.entries()) {
    if (!Number.isSafeInteger(entry?.id) || entry.id <= previousId) {
      throw new Error(`runtimeTrace[${index}] id must be strictly increasing`);
    }
    const at = timestamp(entry?.at);
    if (at === null || at < previousAt) {
      throw new Error(
        `runtimeTrace[${index}] at must be a canonical increasing timestamp`,
      );
    }
    previousId = entry.id;
    previousAt = at;
  }
}

function checkpointsByLabel(checkpoints) {
  const byLabel = new Map();
  for (const checkpoint of checkpoints) {
    const label = requiredString(checkpoint?.label, "checkpoint.label");
    if (byLabel.has(label)) throw new Error(`duplicate checkpoint ${label}`);
    if (!Number.isSafeInteger(checkpoint?.traceId) || checkpoint.traceId < 0) {
      throw new Error(
        `checkpoint ${label} traceId must be a non-negative integer`,
      );
    }
    byLabel.set(label, checkpoint);
  }
  return byLabel;
}

function traceUpTo(trace, traceId) {
  return trace.filter((entry) => Number(entry?.id) <= traceId);
}

function traceBetween(trace, startExclusive, endInclusive) {
  return trace.filter(
    (entry) =>
      Number(entry?.id) > startExclusive && Number(entry?.id) <= endInclusive,
  );
}

function audioLifecycle(trace, transitionId) {
  const entries = trace.filter((entry) => entry?.transitionId === transitionId);
  return {
    all: entries,
    queued: entries.filter((entry) => entry?.type === "audio_queued"),
    started: entries.filter((entry) => entry?.type === "audio_started"),
    terminal: entries.filter((entry) => entry?.type === "audio_terminal"),
  };
}

function assertLifecycleOnce(
  trace,
  transitionId,
  label,
  allowedTerminalOutcomes = ["completed"],
) {
  const lifecycle = audioLifecycle(trace, transitionId);
  if (
    lifecycle.queued.length !== 1 ||
    lifecycle.started.length !== 1 ||
    lifecycle.terminal.length !== 1
  ) {
    throw new Error(`${label} audio lifecycle is incomplete`);
  }
  const [queued] = lifecycle.queued;
  const [started] = lifecycle.started;
  const [terminal] = lifecycle.terminal;
  if (
    queued.requestId !== started.requestId ||
    started.requestId !== terminal.requestId
  ) {
    throw new Error(`${label} audio request correlation is invalid`);
  }
  if (!allowedTerminalOutcomes.includes(terminal.outcome)) {
    throw new Error(
      `${label} audio terminal outcome must be ${allowedTerminalOutcomes.join(" or ")}`,
    );
  }
  return { queued, started, terminal };
}

function startedEntries(trace) {
  return trace.filter((entry) => entry?.type === "audio_started");
}

function welcomeStarts(trace) {
  return startedEntries(trace).filter((entry) =>
    String(entry?.transitionId ?? "").endsWith(":welcome"),
  );
}

function validateCategoryScenario(trace, checkpoints, scenario) {
  const key = requiredString(scenario?.key, "categoryScenario.key");
  const transitionId = requiredString(
    scenario?.transitionId,
    `categoryScenario ${key} transitionId`,
  );
  const sourceUrl = requiredString(
    scenario?.sourceUrl,
    `categoryScenario ${key} sourceUrl`,
  );
  const entryCheckpoint = checkpoints.get(
    requiredString(
      scenario?.entryCheckpointLabel,
      `categoryScenario ${key} entryCheckpointLabel`,
    ),
  );
  const detailCheckpoint = checkpoints.get(
    requiredString(
      scenario?.detailCheckpointLabel,
      `categoryScenario ${key} detailCheckpointLabel`,
    ),
  );
  const checkoutCheckpoint = checkpoints.get(
    requiredString(
      scenario?.checkoutCheckpointLabel,
      `categoryScenario ${key} checkoutCheckpointLabel`,
    ),
  );
  if (!entryCheckpoint || !detailCheckpoint || !checkoutCheckpoint) {
    throw new Error(`categoryScenario ${key} checkpoints are incomplete`);
  }
  const lifecycle = assertLifecycleOnce(trace, transitionId, `category ${key}`);
  if (lifecycle.started.message !== "native") {
    throw new Error(`category ${key} must start through native playback`);
  }
  if (lifecycle.started.id > detailCheckpoint.traceId) {
    throw new Error(`category ${key} introduction started too late`);
  }
  const duplicateStarts = traceBetween(
    trace,
    entryCheckpoint.traceId,
    checkoutCheckpoint.traceId,
  ).filter(
    (entry) =>
      entry?.type === "audio_started" &&
      entry?.transitionId === transitionId &&
      entry?.id !== lifecycle.started.id,
  );
  if (duplicateStarts.length > 0) {
    throw new Error(`category ${key} introduction replayed after entry`);
  }
  const delayedProductSelection = traceBetween(
    trace,
    entryCheckpoint.traceId,
    checkoutCheckpoint.traceId,
  ).find(
    (entry) =>
      entry?.type === "audio_started" &&
      String(entry?.transitionId ?? "").startsWith("product:") &&
      String(entry?.message ?? "") === "native",
  );
  if (delayedProductSelection) {
    throw new Error(
      `category ${key} introduced from product detail instead of entry`,
    );
  }
  return {
    key,
    transitionId,
    sourceUrl,
    startedTraceId: lifecycle.started.id,
  };
}

export function validateBehaviorAudioAcceptanceEvidence(acceptance) {
  if (
    acceptance?.schemaVersion !== "behavior-audio-production-acceptance/v1" ||
    acceptance?.result !== "passed"
  ) {
    throw new Error("behavior audio acceptance did not pass");
  }
  if (
    acceptance?.boundaries?.vision !== "controlled_mock_protocol" ||
    acceptance?.boundaries?.cdp !== "installed_canonical_machine_cdp" ||
    acceptance?.boundaries?.audio !== "windows_default_output_capture"
  ) {
    throw new Error("behavior audio boundaries are incomplete");
  }
  if (
    !Array.isArray(acceptance?.diagnostics) ||
    acceptance.diagnostics.length > 0
  ) {
    throw new Error("behavior audio diagnostics must be empty");
  }
  const audio = acceptance?.audio ?? {};
  if (
    audio.source !== "windows_default_output" ||
    !Number.isInteger(audio.capture?.nonSilentFrameCount) ||
    audio.capture.nonSilentFrameCount <= 0 ||
    !Number.isInteger(audio.capture?.peakAbsoluteSample) ||
    audio.capture.peakAbsoluteSample <= 0
  ) {
    throw new Error("behavior audio native capture is incomplete");
  }
  const cueWindows = assertArray(audio.cueWindows, "audio.cueWindows");
  if (cueWindows.some((window) => window?.kind !== "passed")) {
    throw new Error("behavior audio cue windows are incomplete");
  }
  const trace = assertArray(acceptance.runtimeTrace, "runtimeTrace");
  ensureMonotonicTrace(trace);
  const checkpoints = checkpointsByLabel(
    assertArray(acceptance.checkpoints, "checkpoints"),
  );
  const scenario = acceptance?.scenario ?? {};

  const rejectedTraceId = Number(
    scenario?.preferenceSuppression?.rejectedTraceId,
  );
  const rejectedTransitionId = requiredString(
    scenario?.preferenceSuppression?.transitionId,
    "scenario.preferenceSuppression.transitionId",
  );
  const rejectedCue = trace.find(
    (entry) =>
      entry?.id === rejectedTraceId &&
      entry?.type === "audio_rejected" &&
      entry?.transitionId === rejectedTransitionId &&
      entry?.message === "audio cue preference disabled",
  );
  if (!rejectedCue) {
    throw new Error("disabled presence cue was not rejected by the runtime");
  }

  const initialTransitionId = requiredString(
    scenario?.welcome?.initialTransitionId,
    "scenario.welcome.initialTransitionId",
  );
  const rearmedTransitionId = requiredString(
    scenario?.welcome?.rearmedTransitionId,
    "scenario.welcome.rearmedTransitionId",
  );
  const departureTransitionId = requiredString(
    scenario?.welcome?.departureTransitionId,
    "scenario.welcome.departureTransitionId",
  );
  const stableCheckpoint = checkpoints.get("stable-arrival-settled");
  const transientCheckpoint = checkpoints.get("transient-empty-recovered");
  const duplicateApproachCheckpoint = checkpoints.get(
    "initial-duplicate-approach-settled",
  );
  const departureCheckpoint = checkpoints.get("sustained-empty-departed");
  const rearmedCheckpoint = checkpoints.get("rearmed-arrival-settled");
  if (
    !stableCheckpoint ||
    !duplicateApproachCheckpoint ||
    !transientCheckpoint ||
    !departureCheckpoint ||
    !rearmedCheckpoint
  ) {
    throw new Error("welcome checkpoints are incomplete");
  }

  const initialLifecycle = assertLifecycleOnce(
    trace,
    initialTransitionId,
    "initial welcome",
    ["completed", "stopped"],
  );
  if (initialLifecycle.started.id > stableCheckpoint.traceId) {
    throw new Error("stable arrival did not start welcome before settling");
  }
  if (
    welcomeStarts(traceUpTo(trace, duplicateApproachCheckpoint.traceId))
      .length !== 1
  ) {
    throw new Error("duplicate initial approach incorrectly replayed welcome");
  }
  const transientWelcomeStarts = welcomeStarts(
    traceUpTo(trace, transientCheckpoint.traceId),
  );
  if (transientWelcomeStarts.length !== 1) {
    throw new Error("transient empty incorrectly rearmed welcome");
  }
  const departureEvent = trace.find(
    (entry) =>
      entry?.type === "journey_transition" &&
      entry?.transitionId === departureTransitionId,
  );
  if (!departureEvent || departureEvent.id > departureCheckpoint.traceId) {
    throw new Error("sustained empty departure transition is missing");
  }
  const rearmedLifecycle = assertLifecycleOnce(
    trace,
    rearmedTransitionId,
    "rearmed welcome",
    ["completed", "stopped"],
  );
  if (rearmedLifecycle.started.id <= departureCheckpoint.traceId) {
    throw new Error("rearmed welcome started before sustained departure");
  }
  if (rearmedLifecycle.started.id > rearmedCheckpoint.traceId) {
    throw new Error("new arrival did not replay welcome after sustained empty");
  }
  if (welcomeStarts(trace).length !== 2) {
    throw new Error("welcome played an unexpected number of times");
  }

  const categories = assertArray(
    scenario?.categories,
    "scenario.categories",
  ).map((entry) => validateCategoryScenario(trace, checkpoints, entry));
  const supportedCategoryKeys = assertArray(
    scenario?.supportedCategoryKeys,
    "scenario.supportedCategoryKeys",
  ).map((key) => requiredString(key, "scenario.supportedCategoryKey"));
  if (supportedCategoryKeys.length === 0) {
    throw new Error("supported product categories are missing");
  }
  if (
    new Set(supportedCategoryKeys).size !== supportedCategoryKeys.length ||
    new Set(categories.map((entry) => entry.key)).size !== categories.length ||
    supportedCategoryKeys.length !== categories.length ||
    supportedCategoryKeys.some(
      (key) => !categories.some((entry) => entry.key === key),
    )
  ) {
    throw new Error(
      "supported product categories were not independently covered",
    );
  }
  const requiredCueTransitions = [
    initialTransitionId,
    rearmedTransitionId,
    ...categories.map((entry) => entry.transitionId),
  ];
  for (const transitionId of requiredCueTransitions) {
    if (!cueWindows.some((entry) => entry?.transitionId === transitionId)) {
      throw new Error(`behavior audio cue window is missing ${transitionId}`);
    }
  }

  return {
    welcomeTransitions: [initialTransitionId, rearmedTransitionId],
    departureTransitionId,
    categoryTransitions: categories,
    cueWindowCount: cueWindows.length,
    nativeSource: audio.source,
  };
}
