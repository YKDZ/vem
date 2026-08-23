type JsonRecord = Record<string, unknown>;

function recordValue(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function timestamp(value: unknown): number | null {
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function assertArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function ensureMonotonicTrace(trace: JsonRecord[]): void {
  let previousId = 0;
  let previousAt = -Infinity;
  for (const [index, entry] of trace.entries()) {
    if (
      !Number.isSafeInteger(entry?.id) ||
      (entry.id as number) <= previousId
    ) {
      throw new Error(`runtimeTrace[${index}] id must be strictly increasing`);
    }
    const at = timestamp(entry?.at);
    if (at === null || at < previousAt) {
      throw new Error(
        `runtimeTrace[${index}] at must be a canonical increasing timestamp`,
      );
    }
    previousId = entry.id as number;
    previousAt = at;
  }
}

function checkpointsByLabel(
  checkpoints: JsonRecord[],
): Map<string, JsonRecord> {
  const byLabel = new Map<string, JsonRecord>();
  for (const checkpoint of checkpoints) {
    const label = requiredString(checkpoint?.label, "checkpoint.label");
    if (byLabel.has(label)) throw new Error(`duplicate checkpoint ${label}`);
    if (
      !Number.isSafeInteger(checkpoint?.traceId) ||
      Number(checkpoint.traceId) < 0
    ) {
      throw new Error(
        `checkpoint ${label} traceId must be a non-negative integer`,
      );
    }
    byLabel.set(label, checkpoint);
  }
  return byLabel;
}

function traceBetween(
  trace: JsonRecord[],
  startExclusive: number,
  endInclusive: number,
): JsonRecord[] {
  return trace.filter(
    (entry) =>
      Number(entry?.id) > startExclusive && Number(entry?.id) <= endInclusive,
  );
}

function welcomeStartsBetween(
  trace: JsonRecord[],
  startExclusive: number,
  endInclusive: number,
): JsonRecord[] {
  return welcomeStarts(traceBetween(trace, startExclusive, endInclusive));
}

interface AudioLifecycle {
  all: JsonRecord[];
  queued: JsonRecord[];
  started: JsonRecord[];
  terminal: JsonRecord[];
}

function audioLifecycle(
  trace: JsonRecord[],
  transitionId: string,
): AudioLifecycle {
  const entries = trace.filter((entry) => entry?.transitionId === transitionId);
  return {
    all: entries,
    queued: entries.filter(
      (entry: JsonRecord) => entry?.type === "audio_queued",
    ),
    started: entries.filter(
      (entry: JsonRecord) => entry?.type === "audio_started",
    ),
    terminal: entries.filter(
      (entry: JsonRecord) => entry?.type === "audio_terminal",
    ),
  };
}

function assertLifecycleOnce(
  trace: JsonRecord[],
  transitionId: string,
  label: string,
  allowedTerminalOutcomes: string[] = ["completed"],
): { queued: JsonRecord; started: JsonRecord; terminal: JsonRecord } {
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
  if (!allowedTerminalOutcomes.includes(String(terminal.outcome ?? ""))) {
    throw new Error(
      `${label} audio terminal outcome must be ${allowedTerminalOutcomes.join(" or ")}`,
    );
  }
  return { queued, started, terminal };
}

function assertDetectedCueWindow(window: JsonRecord): JsonRecord {
  const transitionId = requiredString(
    window?.transitionId,
    "audio.cueWindow.transitionId",
  );
  if (window?.kind !== "detected") {
    throw new Error(`audio cue window ${transitionId} was not detected`);
  }
  const capture = recordValue(window?.capture);
  if (
    !Number.isInteger(capture?.nonSilentFrameCount) ||
    Number(capture.nonSilentFrameCount) <= 0 ||
    !Number.isInteger(capture?.peakAbsoluteSample) ||
    Number(capture.peakAbsoluteSample) <= 0
  ) {
    throw new Error(
      `audio cue window ${transitionId} has no non-silent capture`,
    );
  }
  const startedAt = timestamp(capture.startedAt);
  const completedAt = timestamp(capture.completedAt);
  if (startedAt === null || completedAt === null || completedAt < startedAt) {
    throw new Error(
      `audio cue window ${transitionId} capture timestamps are invalid`,
    );
  }
  return { transitionId, capture };
}

function expectedStableEdgeId(transitionId: string): string {
  const match = /^vision:presence-(\d+):(welcome|departed)$/.exec(
    requiredString(transitionId, "presence transitionId"),
  );
  if (!match)
    throw new Error(`presence transition id is invalid: ${transitionId}`);
  return `presence-${match[1]}:${match[2] === "welcome" ? "arrival" : "departure"}`;
}

function b3Speed(frame: JsonRecord | null | undefined): number | null {
  const match = /^55b3(0[0-4])$/i.exec(String(frame?.rawFrameHex ?? ""));
  return match ? Number.parseInt(match[1], 16) : null;
}

function assertAutomaticVentEvidence(
  automaticVent: JsonRecord,
  initialTransitionId: string,
  departureTransitionId: string,
): number[] {
  const protocolFrames = assertArray(
    automaticVent?.protocolFrames,
    "automaticVent.protocolFrames",
  );
  const speeds = assertArray(automaticVent?.speeds, "automaticVent.speeds");
  if (
    protocolFrames.length !== 2 ||
    speeds.length !== 2 ||
    speeds[0] !== 3 ||
    speeds[1] !== 0 ||
    protocolFrames.some((frame: unknown, index: number) => {
      const frameRecord = recordValue(frame);
      return (
        frameRecord?.parsedOpcode !== "B3" ||
        b3Speed(frameRecord) !== Number(speeds[index])
      );
    })
  ) {
    throw new Error(
      "automatic B3 evidence must contain exactly one 3 then one 0",
    );
  }
  const frameTimes = protocolFrames.map((frame) =>
    timestamp(recordValue(frame).capturedAt),
  );
  if (
    frameTimes.some((value) => value === null) ||
    (frameTimes[1] as number) - (frameTimes[0] as number) < 5_000 ||
    !Number.isFinite(automaticVent?.guardElapsedMs) ||
    Number(automaticVent.guardElapsedMs) < 5_000
  ) {
    throw new Error("automatic B3 guard evidence is incomplete");
  }
  const edgeCorrelation = assertArray(
    automaticVent?.edgeCorrelation,
    "automaticVent.edgeCorrelation",
  );
  const expected: Array<[string, string, number]> = [
    [expectedStableEdgeId(initialTransitionId), initialTransitionId, 3],
    [expectedStableEdgeId(departureTransitionId), departureTransitionId, 0],
  ];
  if (
    edgeCorrelation.length !== expected.length ||
    expected.some(
      (
        [edgeId, transitionId, speed]: [string, string, number],
        index: number,
      ) =>
        recordValue(edgeCorrelation[index]).edgeId !== edgeId ||
        recordValue(edgeCorrelation[index]).transitionId !== transitionId ||
        recordValue(edgeCorrelation[index]).speed !== speed ||
        recordValue(recordValue(edgeCorrelation[index]).frame).rawFrameHex !==
          recordValue(protocolFrames[index]).rawFrameHex,
    )
  ) {
    throw new Error("automatic B3 stable-edge correlation is incomplete");
  }
  const precedence = recordValue(automaticVent?.adminPrecedence);
  const duplicateSameEdge = recordValue(precedence?.duplicateSameEdge);
  const precedenceFrame = recordValue(precedence?.frame);
  if (
    typeof precedence?.commandNo !== "string" ||
    precedence.commandNo.trim() === "" ||
    precedence?.requestedSpeed !== 3 ||
    precedence?.resultStatus !== "succeeded" ||
    duplicateSameEdge?.edgeId !== expected[0][0] ||
    duplicateSameEdge?.outcome !== "deduplicated" ||
    precedenceFrame?.parsedOpcode !== "B3" ||
    b3Speed(precedenceFrame) !== 3 ||
    timestamp(precedenceFrame?.capturedAt) === null
  ) {
    throw new Error("automatic B3 Admin precedence evidence is incomplete");
  }
  const adminFrameTime = timestamp(precedenceFrame.capturedAt);
  if (
    (adminFrameTime as number) - (frameTimes[0] as number) < 5_000 ||
    (frameTimes[1] as number) - (adminFrameTime as number) < 5_000
  ) {
    throw new Error("automatic B3 guard evidence is incomplete");
  }
  return speeds.map((speed: unknown) => Number(speed));
}

function startedEntries(trace: JsonRecord[]): JsonRecord[] {
  return trace.filter((entry) => entry?.type === "audio_started");
}

function welcomeStarts(trace: JsonRecord[]): JsonRecord[] {
  return startedEntries(trace).filter((entry) =>
    String(entry?.transitionId ?? "").endsWith(":welcome"),
  );
}

function validateCategoryScenario(
  trace: JsonRecord[],
  checkpoints: Map<string, JsonRecord>,
  scenario: JsonRecord,
): JsonRecord {
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
  if (Number(lifecycle.started.id) > Number(detailCheckpoint.traceId)) {
    throw new Error(`category ${key} introduction started too late`);
  }
  const duplicateStarts = traceBetween(
    trace,
    Number(entryCheckpoint.traceId),
    Number(checkoutCheckpoint.traceId),
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
    Number(entryCheckpoint.traceId),
    Number(checkoutCheckpoint.traceId),
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

export function validatePresenceAndAudioAcceptanceEvidence(
  acceptance: JsonRecord,
): JsonRecord {
  const boundaries = recordValue(acceptance.boundaries);
  const audio = recordValue(acceptance.audio);
  const capture = recordValue(audio.capture);
  const scenario = recordValue(acceptance.scenario);
  const welcome = recordValue(scenario.welcome);
  if (
    acceptance?.schemaVersion !==
      "presence-and-audio-production-acceptance/v1" ||
    acceptance?.result !== "passed"
  ) {
    throw new Error("presence and audio acceptance did not pass");
  }
  if (
    boundaries?.vision !== "controlled_mock_protocol" ||
    boundaries?.cdp !== "installed_canonical_machine_cdp" ||
    boundaries?.audio !== "windows_default_output_capture"
  ) {
    throw new Error("presence and audio boundaries are incomplete");
  }
  if (
    !Array.isArray(acceptance?.diagnostics) ||
    acceptance.diagnostics.length > 0
  ) {
    throw new Error("presence and audio diagnostics must be empty");
  }
  if (
    audio.source !== "windows_default_output" ||
    !Number.isInteger(capture.nonSilentFrameCount) ||
    Number(capture.nonSilentFrameCount) <= 0 ||
    !Number.isInteger(capture.peakAbsoluteSample) ||
    Number(capture.peakAbsoluteSample) <= 0
  ) {
    throw new Error("presence and audio native capture is incomplete");
  }
  const cueWindows = assertArray(audio.cueWindows, "audio.cueWindows").map(
    (entry: unknown) => assertDetectedCueWindow(recordValue(entry)),
  );
  const trace = assertArray(acceptance.runtimeTrace, "runtimeTrace").map(
    (entry: unknown) => recordValue(entry),
  );
  ensureMonotonicTrace(trace);
  const checkpoints = checkpointsByLabel(
    assertArray(acceptance.checkpoints, "checkpoints").map((entry: unknown) =>
      recordValue(entry),
    ),
  );

  const initialTransitionId = requiredString(
    welcome?.initialTransitionId,
    "scenario.welcome.initialTransitionId",
  );
  const initialFenceTraceId = Number(welcome?.initialFenceTraceId);
  const duplicateFenceTraceId = Number(welcome?.duplicateFenceTraceId);
  const transientFenceTraceId = Number(welcome?.transientFenceTraceId);
  const rearmedTransitionId = requiredString(
    welcome?.rearmedTransitionId,
    "scenario.welcome.rearmedTransitionId",
  );
  const departureTransitionId = requiredString(
    welcome?.departureTransitionId,
    "scenario.welcome.departureTransitionId",
  );
  const rearmedFenceTraceId = Number(welcome?.rearmedFenceTraceId);
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
    !rearmedCheckpoint ||
    !Number.isSafeInteger(initialFenceTraceId) ||
    initialFenceTraceId < 0 ||
    !Number.isSafeInteger(duplicateFenceTraceId) ||
    duplicateFenceTraceId < 0 ||
    !Number.isSafeInteger(transientFenceTraceId) ||
    transientFenceTraceId < 0 ||
    !Number.isSafeInteger(rearmedFenceTraceId) ||
    rearmedFenceTraceId < 0
  ) {
    throw new Error("welcome checkpoints are incomplete");
  }

  const initialLifecycle = assertLifecycleOnce(
    trace,
    initialTransitionId,
    "initial welcome",
    ["completed", "stopped"],
  );
  if (Number(initialLifecycle.started.id) > Number(stableCheckpoint.traceId)) {
    throw new Error("stable arrival did not start welcome before settling");
  }
  const initialWindow = welcomeStartsBetween(
    trace,
    initialFenceTraceId,
    Number(stableCheckpoint.traceId),
  );
  if (
    initialWindow.length !== 1 ||
    Number(initialWindow[0]?.id) !== Number(initialLifecycle.started.id)
  ) {
    throw new Error("initial welcome did not use a fresh presence fence");
  }
  if (
    welcomeStartsBetween(
      trace,
      duplicateFenceTraceId,
      Number(duplicateApproachCheckpoint.traceId),
    ).length !== 0
  ) {
    throw new Error("duplicate initial approach incorrectly replayed welcome");
  }
  const transientWelcomeStarts = welcomeStartsBetween(
    trace,
    transientFenceTraceId,
    Number(transientCheckpoint.traceId),
  );
  if (transientWelcomeStarts.length !== 0) {
    throw new Error("transient empty incorrectly rearmed welcome");
  }
  const departureEvent = trace.find(
    (entry) =>
      entry?.type === "journey_transition" &&
      entry?.transitionId === departureTransitionId,
  );
  if (
    !departureEvent ||
    Number(departureEvent.id) > Number(departureCheckpoint.traceId)
  ) {
    throw new Error("sustained empty departure transition is missing");
  }
  const rearmedLifecycle = assertLifecycleOnce(
    trace,
    rearmedTransitionId,
    "rearmed welcome",
    ["completed", "stopped"],
  );
  if (
    Number(rearmedLifecycle.started.id) <= Number(departureCheckpoint.traceId)
  ) {
    throw new Error("rearmed welcome started before sustained departure");
  }
  if (Number(rearmedLifecycle.started.id) > Number(rearmedCheckpoint.traceId)) {
    throw new Error("new arrival did not replay welcome after sustained empty");
  }
  const rearmedWindow = welcomeStartsBetween(
    trace,
    rearmedFenceTraceId,
    Number(rearmedCheckpoint.traceId),
  );
  if (
    rearmedWindow.length !== 1 ||
    Number(rearmedWindow[0]?.id) !== Number(rearmedLifecycle.started.id)
  ) {
    throw new Error("rearmed welcome did not use a fresh presence fence");
  }
  if (
    welcomeStartsBetween(
      trace,
      initialFenceTraceId,
      Number(rearmedCheckpoint.traceId),
    ).length !== 2
  ) {
    throw new Error("welcome played an unexpected number of times");
  }

  const categories = assertArray(
    scenario?.categories,
    "scenario.categories",
  ).map((entry: unknown) =>
    validateCategoryScenario(trace, checkpoints, recordValue(entry)),
  );
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
  if (
    cueWindows.length !== requiredCueTransitions.length ||
    requiredCueTransitions.some(
      (transitionId) =>
        cueWindows.filter((entry) => entry?.transitionId === transitionId)
          .length !== 1,
    ) ||
    cueWindows.some(
      (entry) => !requiredCueTransitions.includes(entry?.transitionId),
    )
  ) {
    throw new Error(
      "presence and audio requires exactly one cue window per required transition",
    );
  }
  const automaticVentSpeeds = assertAutomaticVentEvidence(
    recordValue(acceptance.automaticVent),
    initialTransitionId,
    departureTransitionId,
  );

  return {
    welcomeTransitions: [initialTransitionId, rearmedTransitionId],
    departureTransitionId,
    categoryTransitions: categories,
    cueWindowCount: cueWindows.length,
    nativeSource: audio.source,
    automaticVentSpeeds,
  };
}
