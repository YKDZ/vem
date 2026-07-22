#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import {
  ensureControlledVisionMock,
  shutdownControlledVisionMock,
  waitForControlledVisionRuntimeClient,
  waitForSaleStartReady,
} from "./fast-route-stress-sale.mjs";
import { setMachineUiAudioPreferences } from "./local-operations-guest-full.mjs";
import {
  activateVisibleSelector,
  captureScreenshot,
  CdpClient,
  discoverMachineUiTarget,
  enablePageRuntime,
  evaluateExpression,
  observeConnectedCdpIdentity,
  rewriteWebSocketDebuggerUrl,
  waitForRoute,
} from "./machine-ui-cdp-driver.mjs";
import { validatePresenceAndAudioAcceptanceEvidence } from "./presence-and-audio-acceptance.mjs";

const MODE = "full";
const SHORT_EMPTY_MS = 1_000;
const SUSTAINED_EMPTY_MS = 10_000;
const TRACE_TIMEOUT_MS = 30_000;
const ADMIN_USER = "local-testbed-admin";
const ADMIN_PASSWORD = "LocalTestbedAdminPassword!";

function required(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function windowsAbsolute(value, label) {
  const path = required(value, label);
  if (!/^[A-Za-z]:\\/.test(path) || path.includes("\0")) {
    throw new Error(`${label} must be an absolute Windows path`);
  }
  return path;
}

function localPath(path) {
  return process.platform === "win32"
    ? path
    : resolve(
        `/mnt/${path[0].toLowerCase()}/${path.slice(3).replaceAll("\\", "/")}`,
      );
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(localPath(path), "utf8"));
  } catch (error) {
    throw new Error(
      `${label} is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function writeJson(path, value) {
  const target = localPath(path);
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(temporary, target);
}

function writeText(path, value) {
  const target = localPath(path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, String(value), { mode: 0o600 });
}

async function captureScreenshotArtifact(client, path) {
  return captureScreenshot(client, {
    format: "png",
    label: "presence-and-audio-final",
    screenshotSink: async ({ bytes }) => {
      writeFileSync(path, bytes, { mode: 0o600 });
      return { ref: path };
    },
  });
}

function option(args, name) {
  const index = args.indexOf(`--${name}`);
  const value = index === -1 ? undefined : args[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`--${name} requires a value`);
  return value;
}

function optionalOption(args, name) {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? null : required(args[index + 1], `--${name}`);
}

export function parsePresenceAndAudioGuestArgs(args) {
  const allowed = new Set([
    "--mode",
    "--guest-input",
    "--handoff",
    "--out",
    "--fixture-key",
  ]);
  for (const value of args) {
    if (value.startsWith("--") && !allowed.has(value)) {
      throw new Error(`unsupported presence-and-audio option: ${value}`);
    }
  }
  const mode = required(option(args, "mode"), "--mode");
  if (mode !== MODE) throw new Error("--mode must be full");
  return {
    mode,
    guestInputPath: windowsAbsolute(
      option(args, "guest-input"),
      "--guest-input",
    ),
    handoffPath: windowsAbsolute(option(args, "handoff"), "--handoff"),
    outPath: windowsAbsolute(option(args, "out"), "--out"),
    fixtureKey: optionalOption(args, "fixture-key"),
  };
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 30_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      `${options.method ?? "GET"} ${url} failed with HTTP ${response.status}: ${JSON.stringify(payload)}`,
    );
  }
  return payload;
}

async function controlPlaneRequest(guestInput, path, body = {}) {
  const controlPlane = guestInput?.hostControlPlane;
  if (!controlPlane?.endpoint || !controlPlane?.token) {
    throw new Error(
      "guest input is missing hostControlPlane endpoint and token",
    );
  }
  return fetchJson(`${controlPlane.endpoint}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${controlPlane.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function visionControlPort(guestInput) {
  const port = Number(
    guestInput?.hostControlPlane?.visionMockControlPort ??
      guestInput?.visionMockControlPort,
  );
  if (!Number.isInteger(port) || port < 1) {
    throw new Error("guest input is missing vision mock control port");
  }
  return port;
}

async function injectVisionPresence(guestInput, state, dependencies) {
  if (state !== "approach" && state !== "empty")
    throw new Error("Vision presence state is invalid");
  const port = visionControlPort(guestInput);
  return dependencies.fetchJson(`http://127.0.0.1:${port}/control/presence`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ state }),
  });
}

function traceId(trace) {
  return trace.reduce(
    (maximum, entry) => Math.max(maximum, Number(entry?.id) || 0),
    0,
  );
}

function latestPresenceTransition(trace) {
  return [...trace]
    .reverse()
    .find(
      (entry) =>
        entry?.type === "journey_transition" &&
        /^vision:presence-.+:(?:welcome|departed)$/.test(
          String(entry?.transitionId ?? ""),
        ),
    );
}

function traceEntryAfter(trace, boundary, predicate) {
  return trace.find(
    (entry) => Number(entry?.id) > boundary && predicate(entry),
  );
}

async function waitForTraceEntry(
  readTrace,
  boundary,
  predicate,
  dependencies,
  label,
) {
  const deadline = dependencies.now() + TRACE_TIMEOUT_MS;
  let last = [];
  do {
    last = await readTrace();
    const entry = traceEntryAfter(last, boundary, predicate);
    if (entry) return { entry, trace: last };
    await dependencies.sleep(100);
  } while (dependencies.now() < deadline);
  throw new Error(
    `${label} was not observed in Machine runtimeTrace: ${JSON.stringify(last.slice(-12))}`,
  );
}

async function waitForAudioLifecycle(
  readTrace,
  boundary,
  transitionPredicate,
  dependencies,
  label,
) {
  const transition = await waitForTraceEntry(
    readTrace,
    boundary,
    (entry) =>
      entry?.type === "journey_transition" && transitionPredicate(entry),
    dependencies,
    `${label} transition`,
  );
  const transitionId = required(
    transition.entry.transitionId,
    `${label} transitionId`,
  );
  const terminal = await waitForTraceEntry(
    readTrace,
    Number(transition.entry.id),
    (entry) =>
      entry?.type === "audio_terminal" &&
      entry?.transitionId === transitionId &&
      entry?.outcome === "completed",
    dependencies,
    `${label} native audio terminal`,
  );
  const lifecycle = terminal.trace.filter(
    (entry) => entry?.transitionId === transitionId,
  );
  const started = lifecycle.filter((entry) => entry?.type === "audio_started");
  if (started.length !== 1 || started[0]?.message !== "native") {
    throw new Error(`${label} did not use exactly one native audio start`);
  }
  return {
    transitionId,
    terminalTraceId: Number(terminal.entry.id),
    trace: terminal.trace,
  };
}

function categoryKeyFromTransition(transitionId) {
  const match = /^category:category-entry-([a-z0-9_-]+)-\d+$/i.exec(
    transitionId,
  );
  if (!match)
    throw new Error(`category transition id is invalid: ${transitionId}`);
  return match[1];
}

function categorySelector(key) {
  const normalized = required(key, "supported category key");
  if (!/^[A-Za-z0-9_-]+$/.test(normalized)) {
    throw new Error(`supported category key is invalid: ${normalized}`);
  }
  return `[data-test="catalog-category"][data-category-key="${normalized}"]:not(:disabled)`;
}

async function readSupportedCategoryKeys(client, dependencies) {
  const keys = await dependencies.evaluateExpression(
    client,
    `(() => Array.from(document.querySelectorAll('[data-test="catalog-category"]:not(:disabled)'))
      .map((element) => element.dataset.categoryKey || '')
      .filter(Boolean))()`,
  );
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new Error("installed Catalog has no enabled product categories");
  }
  const normalized = keys.map((key) => required(key, "supported category key"));
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(
      "installed Catalog exposes duplicate enabled product categories",
    );
  }
  for (const key of normalized) categorySelector(key);
  return normalized;
}

function runtimeBinding(handoff, cdpIdentity) {
  const machine = handoff?.machine ?? {};
  return {
    processId: Number(machine.processId),
    executablePath: required(
      machine.executablePath,
      "handoff machine executablePath",
    ),
    principal: required(machine.principal, "handoff machine principal"),
    sessionId: Number(machine.sessionId),
    cdpTargetId: required(cdpIdentity?.targetId, "CDP targetId"),
    cdpSessionId: required(cdpIdentity?.sessionId, "CDP sessionId"),
  };
}

export async function observeGuestRuntimeIdentity(client, dependencies) {
  if (typeof client?.observeIdentity === "function") {
    return client.observeIdentity();
  }
  if (typeof dependencies?.observeConnectedCdpIdentity === "function") {
    return dependencies.observeConnectedCdpIdentity(client);
  }
  throw new Error("connected production CDP client identity is unavailable");
}

function captureSummary(stopReport) {
  const capture = stopReport?.capture;
  if (
    !capture ||
    !Number.isInteger(capture.nonSilentFrameCount) ||
    !Number.isInteger(capture.peakAbsoluteSample)
  ) {
    throw new Error("host default-audio stop report is incomplete");
  }
  return {
    nonSilentFrameCount: capture.nonSilentFrameCount,
    peakAbsoluteSample: capture.peakAbsoluteSample,
    startedAt: required(capture.startedAt, "audio capture startedAt"),
    completedAt: required(capture.completedAt, "audio capture completedAt"),
  };
}

function b3Speed(frame) {
  const value = /^55b3(0[0-4])$/i.exec(String(frame?.rawFrameHex ?? ""))?.[1];
  return value ? Number.parseInt(value, 16) : null;
}

function stableEdgeId(transitionId) {
  const match = /^vision:presence-(\d+):(welcome|departed)$/.exec(
    required(transitionId, "presence transition id"),
  );
  if (!match)
    throw new Error(`presence transition id is invalid: ${transitionId}`);
  return `presence-${match[1]}:${match[2] === "welcome" ? "arrival" : "departure"}`;
}

function b3FramesSince(evidence, beforeFrameCount) {
  return (evidence?.rawFrames ?? [])
    .slice(beforeFrameCount)
    .filter((frame) => frame?.parsedOpcode === "B3")
    .map((frame) => ({ ...frame, speed: b3Speed(frame) }));
}

function serialFrameCount(evidence) {
  return Array.isArray(evidence?.rawFrames) ? evidence.rawFrames.length : 0;
}

async function waitForB3Sequence(
  guestInput,
  sessionId,
  beforeFrameCount,
  expectedSpeeds,
  dependencies,
) {
  const deadline = dependencies.now() + TRACE_TIMEOUT_MS;
  let evidence = null;
  do {
    evidence = await dependencies.controlPlaneRequest(
      guestInput,
      `/v1/serial-sessions/${sessionId}/evidence`,
    );
    const frames = b3FramesSince(evidence, beforeFrameCount);
    if (
      frames.map((frame) => frame.speed).join(",") === expectedSpeeds.join(",")
    ) {
      return { evidence, frames };
    }
    await dependencies.sleep(100);
  } while (dependencies.now() < deadline);
  throw new Error(
    `B3 sequence ${expectedSpeeds.join(",")} was not observed: ${JSON.stringify(b3FramesSince(evidence, beforeFrameCount))}`,
  );
}

function automaticVentEvidence({
  frames,
  initialTransitionId,
  departureTransitionId,
  adminOverride,
  duplicateSameEdge,
}) {
  const speeds = frames.map((frame) => frame.speed);
  if (speeds.join(",") !== "2,3,0") {
    throw new Error(
      `automatic B3 evidence must be exactly 2,3,0: ${JSON.stringify(frames)}`,
    );
  }
  const [arrivalFrame, adminFrame, departureFrame] = frames;
  const arrivalAt = Date.parse(arrivalFrame?.capturedAt);
  const adminAt = Date.parse(adminFrame?.capturedAt);
  const departureAt = Date.parse(departureFrame?.capturedAt);
  if (
    !Number.isFinite(arrivalAt) ||
    !Number.isFinite(adminAt) ||
    !Number.isFinite(departureAt)
  ) {
    throw new Error("automatic B3 evidence requires capturedAt timestamps");
  }
  const guardElapsedMs = departureAt - arrivalAt;
  if (adminAt - arrivalAt < 5_000 || departureAt - adminAt < 5_000) {
    throw new Error(
      `automatic B3 guard was shorter than 5 seconds: ${guardElapsedMs}`,
    );
  }
  if (
    adminOverride?.requestedSpeed !== 3 ||
    adminOverride?.resultStatus !== "succeeded" ||
    duplicateSameEdge?.outcome !== "deduplicated"
  ) {
    throw new Error("automatic B3 Admin precedence evidence is incomplete");
  }
  return {
    protocolFrames: [arrivalFrame, departureFrame],
    speeds: [2, 0],
    guardElapsedMs,
    edgeCorrelation: [
      {
        edgeId: stableEdgeId(initialTransitionId),
        transitionId: initialTransitionId,
        speed: 2,
        frame: arrivalFrame,
      },
      {
        edgeId: stableEdgeId(departureTransitionId),
        transitionId: departureTransitionId,
        speed: 0,
        frame: departureFrame,
      },
    ],
    adminPrecedence: {
      ...adminOverride,
      frame: adminFrame,
      duplicateSameEdge,
    },
  };
}

function aggregateCapture(cueWindows) {
  const captures = cueWindows.map((window) => window.capture);
  if (captures.length === 0) throw new Error("audio cue captures are empty");
  return {
    nonSilentFrameCount: captures.reduce(
      (total, capture) => total + capture.nonSilentFrameCount,
      0,
    ),
    peakAbsoluteSample: Math.max(
      ...captures.map((capture) => capture.peakAbsoluteSample),
    ),
    startedAt: captures[0].startedAt,
    completedAt: captures.at(-1).completedAt,
  };
}

function apiBaseUrl(guestInput) {
  return required(
    guestInput?.runtimeBootstrap?.provisioningApiBaseUrl,
    "runtimeBootstrap.provisioningApiBaseUrl",
  ).replace(/\/+$/, "");
}

function daemonBaseUrl(handoff) {
  const healthzUrl = required(
    handoff?.daemon?.ready?.healthzUrl,
    "daemon healthzUrl",
  );
  if (!healthzUrl.endsWith("/healthz")) {
    throw new Error("daemon healthzUrl must end with /healthz");
  }
  return healthzUrl.slice(0, -"/healthz".length);
}

function unwrapServiceApiEnvelope(payload) {
  if (payload?.code === 0 && Object.hasOwn(payload, "data"))
    return payload.data;
  return payload;
}

async function issueAdminVentOverride(guestInput, dependencies) {
  const request = async (path, options = {}) =>
    unwrapServiceApiEnvelope(
      await dependencies.fetchJson(`${apiBaseUrl(guestInput)}${path}`, options),
    );
  const login = await request("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASSWORD }),
  });
  const token = required(login?.accessToken, "admin accessToken");
  const machines = await request("/machines?page=1&pageSize=100", {
    headers: { authorization: `Bearer ${token}` },
  });
  const machine = machines?.items?.find(
    (entry) => entry?.code === required(guestInput.machineCode, "machineCode"),
  );
  if (!machine?.id) throw new Error("admin testbed machine was not found");
  const command = await request(
    `/machines/${machine.id}/commands/environment-control`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ ventSpeed: 3 }),
    },
  );
  const commandNo = required(command?.commandNo, "Admin environment commandNo");
  const deadline = dependencies.now() + TRACE_TIMEOUT_MS;
  do {
    const status = await request(`/machines/${machine.id}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const latest = status?.latestEnvironmentCommand;
    if (
      latest?.commandNo === commandNo &&
      ["succeeded", "failed", "timeout"].includes(latest?.status)
    ) {
      if (latest.status !== "succeeded") {
        throw new Error(
          `Admin B3 override did not succeed: ${JSON.stringify(latest)}`,
        );
      }
      return { commandNo, resultStatus: latest.status, requestedSpeed: 3 };
    }
    await dependencies.sleep(100);
  } while (dependencies.now() < deadline);
  throw new Error(
    `Admin B3 override did not reach a terminal result: ${commandNo}`,
  );
}

async function submitDuplicateAutomaticVentIntent(
  handoff,
  edgeId,
  dependencies,
) {
  const response = await dependencies.fetchJson(
    `${daemonBaseUrl(handoff)}/v1/intents/automatic-vent`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${required(handoff?.daemon?.ready?.ipcToken, "daemon ipcToken")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ edgeId, ventSpeed: 2 }),
    },
  );
  if (response?.edgeId !== edgeId || response?.outcome !== "deduplicated") {
    throw new Error(
      `duplicate automatic vent edge was not deduplicated: ${JSON.stringify(response)}`,
    );
  }
  return response;
}

function defaultDependencies() {
  return {
    readJson,
    writeJson,
    writeText,
    captureScreenshotArtifact,
    readTrace: (client) =>
      evaluateExpression(client, "window.__VEM_MACHINE_RUNTIME_TRACE__ || []"),
    setAudioPreferences: setMachineUiAudioPreferences,
    fetchJson,
    controlPlaneRequest,
    ensureControlledVisionMock,
    waitForControlledVisionRuntimeClient,
    discoverTarget: discoverMachineUiTarget,
    createClient: (url) => new CdpClient(url),
    enablePageRuntime,
    waitForRoute,
    waitForSaleStartReady,
    activateVisibleSelector,
    evaluateExpression,
    rewriteWebSocketDebuggerUrl,
    observeConnectedCdpIdentity,
    sleep,
    now: () => Date.now(),
    randomUUID,
    issueAdminVentOverride,
    submitDuplicateAutomaticVentIntent,
    artifactRoot: (outPath) =>
      join(dirname(localPath(outPath)), "presence-and-audio-artifacts"),
    makeDirectory: (path) => mkdirSync(path, { recursive: true }),
  };
}

export async function runPresenceAndAudioGuestFull(options, injected = {}) {
  const dependencies = { ...defaultDependencies(), ...injected };
  const report = {
    schemaVersion: "vem-presence-and-audio-guest-full/v1",
    ok: false,
    mode: options.mode,
    boundaries: {
      visionMock: false,
      machineCdp: false,
      windowsAudioCapture: false,
    },
    artifacts: null,
    presenceAndAudio: null,
    error: null,
  };
  let guestInput = null;
  let handoff = null;
  let client = null;
  let vision = null;
  let activeAudioCaptureId = null;
  let runtimeTrace = [];
  let artifactRoot = null;

  try {
    guestInput = dependencies.readJson(options.guestInputPath, "guest input");
    handoff = dependencies.readJson(
      options.handoffPath,
      "installed runtime handoff",
    );
    artifactRoot = dependencies.artifactRoot(options.outPath);
    dependencies.makeDirectory(artifactRoot);
    const visionPort = visionControlPort(guestInput);
    vision = await dependencies.ensureControlledVisionMock(visionPort);
    await dependencies.waitForControlledVisionRuntimeClient(visionPort);
    report.boundaries.visionMock = true;

    const target = await dependencies.discoverTarget({
      endpoint: "http://127.0.0.1:9222",
      expectedTargetId: required(
        handoff?.cdp?.targetId,
        "handoff cdp targetId",
      ),
    });
    client = dependencies.createClient(
      dependencies.rewriteWebSocketDebuggerUrl(
        target.webSocketDebuggerUrl,
        "http://127.0.0.1:9222",
      ),
    );
    await client.connect();
    await dependencies.enablePageRuntime(client);
    await dependencies.waitForRoute(client, "#/catalog", {
      timeoutMs: 30_000,
      pollMs: 250,
    });
    await dependencies.waitForSaleStartReady(handoff, client);
    report.boundaries.machineCdp = true;

    const cdpIdentity = await observeGuestRuntimeIdentity(client, dependencies);
    const runtime = runtimeBinding(handoff, cdpIdentity);
    const sessionId = required(
      handoff?.commissioningSerialSession?.sessionId,
      "commissioning serial session id",
    );
    const operationId = `presence-and-audio-${dependencies.randomUUID()}`;
    const cueWindows = [];
    const cueArtifactPaths = [];
    let cueOrdinal = 0;
    const startCueCapture = async (label) => {
      cueOrdinal += 1;
      const artifactLabel = `${String(cueOrdinal).padStart(2, "0")}-${label}`;
      const audioStart = await dependencies.controlPlaneRequest(
        guestInput,
        "/v1/audio-captures/start",
        {
          sessionId,
          runId: required(guestInput.runId, "runId"),
          lifecycleReference: `vm-lifecycle://${required(guestInput.runId, "runId").toLowerCase()}.presence-and-audio`,
          transactionId: `transaction://${required(guestInput.runId, "runId").toLowerCase()}.presence-and-audio.${artifactLabel}`,
          targetIdentity: required(
            guestInput.hostControlPlane?.targetIdentity,
            "hostControlPlane.targetIdentity",
          ),
          runtime,
          operationId: `${operationId}-${artifactLabel}`,
        },
      );
      activeAudioCaptureId = required(
        audioStart?.audioCaptureId,
        "audio capture id",
      );
      const startPath = join(
        artifactRoot,
        `audio-capture-${artifactLabel}-start.json`,
      );
      dependencies.writeJson(startPath, audioStart.startReport);
      cueArtifactPaths.push({ start: startPath, stop: null });
      report.boundaries.windowsAudioCapture = true;
      return { id: activeAudioCaptureId, artifactLabel };
    };
    const stopCueCapture = async (capture, transitionId) => {
      const audioStop = await dependencies.controlPlaneRequest(
        guestInput,
        `/v1/audio-captures/${capture.id}/stop`,
        { captureKind: "default-audio" },
      );
      activeAudioCaptureId = null;
      const stopPath = join(
        artifactRoot,
        `audio-capture-${capture.artifactLabel}-stop.json`,
      );
      dependencies.writeJson(stopPath, audioStop.stopReport);
      cueArtifactPaths.at(-1).stop = stopPath;
      for (const artifact of audioStop.evidencePayloads ?? []) {
        writeFileSync(
          join(artifactRoot, `${capture.artifactLabel}-${artifact.fileName}`),
          Buffer.from(artifact.bytesBase64, "base64"),
          { mode: 0o600 },
        );
      }
      cueWindows.push({
        transitionId,
        kind: "detected",
        capture: captureSummary(audioStop.stopReport),
      });
    };

    const readTrace = async () => {
      runtimeTrace = await dependencies.readTrace(client);
      return runtimeTrace;
    };
    // A previous business set may leave the shared journey in a present state.
    // Observe its real departure before proving a fresh arrival.
    const preconditionTrace = await readTrace();
    const preconditionBoundary = traceId(preconditionTrace);
    const priorPresence = latestPresenceTransition(preconditionTrace);
    await injectVisionPresence(guestInput, "empty", dependencies);
    if (String(priorPresence?.transitionId ?? "").endsWith(":welcome")) {
      await waitForTraceEntry(
        readTrace,
        preconditionBoundary,
        (entry) =>
          entry?.type === "journey_transition" &&
          String(entry?.transitionId).endsWith(":departed"),
        dependencies,
        "initial sustained Vision departure",
      );
    }
    const ventEvidenceBefore = await dependencies.controlPlaneRequest(
      guestInput,
      `/v1/serial-sessions/${sessionId}/evidence`,
    );
    const ventFrameCount = Array.isArray(ventEvidenceBefore?.rawFrames)
      ? ventEvidenceBefore.rawFrames.length
      : 0;
    let boundary = traceId(await readTrace());
    const initialFenceTraceId = boundary;
    const initialCapture = await startCueCapture("initial-welcome");
    await injectVisionPresence(guestInput, "approach", dependencies);
    const initialWelcome = await waitForAudioLifecycle(
      readTrace,
      boundary,
      (entry) => String(entry.transitionId).endsWith(":welcome"),
      dependencies,
      "initial welcome",
    );
    await stopCueCapture(initialCapture, initialWelcome.transitionId);
    await waitForB3Sequence(
      guestInput,
      sessionId,
      ventFrameCount,
      [2],
      dependencies,
    );
    const adminOverride = await dependencies.issueAdminVentOverride(
      guestInput,
      dependencies,
    );
    const afterAdminB3 = await waitForB3Sequence(
      guestInput,
      sessionId,
      ventFrameCount,
      [2, 3],
      dependencies,
    );
    const checkpoints = [
      {
        label: "stable-arrival-settled",
        traceId: initialWelcome.terminalTraceId,
      },
    ];
    const duplicateSameEdge =
      await dependencies.submitDuplicateAutomaticVentIntent(
        handoff,
        stableEdgeId(initialWelcome.transitionId),
        dependencies,
      );
    const duplicateFenceTraceId = traceId(await readTrace());
    await injectVisionPresence(guestInput, "approach", dependencies);
    await dependencies.sleep(500);
    runtimeTrace = await readTrace();
    if (
      runtimeTrace.filter(
        (entry) =>
          entry?.type === "audio_started" &&
          String(entry?.transitionId).endsWith(":welcome"),
      ).length !== 1
    ) {
      throw new Error("duplicate initial Vision approach replayed welcome");
    }
    checkpoints.push({
      label: "initial-duplicate-approach-settled",
      traceId: traceId(runtimeTrace),
    });
    const duplicateB3 = await dependencies.controlPlaneRequest(
      guestInput,
      `/v1/serial-sessions/${sessionId}/evidence`,
    );
    if (
      serialFrameCount(duplicateB3) !==
        serialFrameCount(afterAdminB3.evidence) ||
      b3FramesSince(duplicateB3, ventFrameCount).length !== 2
    ) {
      throw new Error("duplicate stable edge emitted an unexpected B3 frame");
    }

    await injectVisionPresence(guestInput, "empty", dependencies);
    await dependencies.sleep(SHORT_EMPTY_MS);
    const transientFenceTraceId = traceId(await readTrace());
    await injectVisionPresence(guestInput, "approach", dependencies);
    await dependencies.sleep(500);
    runtimeTrace = await readTrace();
    const transientWelcomes = runtimeTrace.filter(
      (entry) =>
        entry?.type === "audio_started" &&
        String(entry?.transitionId).endsWith(":welcome"),
    );
    if (transientWelcomes.length !== 1)
      throw new Error("transient Vision empty rearmed welcome");
    checkpoints.push({
      label: "transient-empty-recovered",
      traceId: traceId(runtimeTrace),
    });

    boundary = traceId(runtimeTrace);
    await injectVisionPresence(guestInput, "empty", dependencies);
    await dependencies.sleep(SUSTAINED_EMPTY_MS);
    const departure = await waitForTraceEntry(
      readTrace,
      boundary,
      (entry) =>
        entry?.type === "journey_transition" &&
        String(entry?.transitionId).endsWith(":departed"),
      dependencies,
      "sustained Vision departure",
    );
    checkpoints.push({
      label: "sustained-empty-departed",
      traceId: Number(departure.entry.id),
    });
    const completeB3 = await waitForB3Sequence(
      guestInput,
      sessionId,
      ventFrameCount,
      [2, 3, 0],
      dependencies,
    );
    const automaticVent = automaticVentEvidence({
      frames: completeB3.frames,
      initialTransitionId: initialWelcome.transitionId,
      departureTransitionId: departure.entry.transitionId,
      adminOverride,
      duplicateSameEdge,
    });

    boundary = traceId(departure.trace);
    const rearmedFenceTraceId = boundary;
    const rearmedCapture = await startCueCapture("rearmed-welcome");
    await injectVisionPresence(guestInput, "approach", dependencies);
    const rearmedWelcome = await waitForAudioLifecycle(
      readTrace,
      boundary,
      (entry) => String(entry.transitionId).endsWith(":welcome"),
      dependencies,
      "rearmed welcome",
    );
    await stopCueCapture(rearmedCapture, rearmedWelcome.transitionId);
    checkpoints.push({
      label: "rearmed-arrival-settled",
      traceId: rearmedWelcome.terminalTraceId,
    });

    const supportedCategoryKeys = await readSupportedCategoryKeys(
      client,
      dependencies,
    );
    const categories = [];
    for (const expectedKey of supportedCategoryKeys) {
      boundary = traceId(await readTrace());
      const categoryCapture = await startCueCapture(`category-${expectedKey}`);
      await dependencies.activateVisibleSelector(
        client,
        categorySelector(expectedKey),
        { kind: "touch", timeoutMs: 30_000 },
      );
      const category = await waitForAudioLifecycle(
        readTrace,
        boundary,
        (entry) =>
          String(entry.transitionId).startsWith(
            `category:category-entry-${expectedKey}-`,
          ),
        dependencies,
        `category ${expectedKey} entry`,
      );
      await stopCueCapture(categoryCapture, category.transitionId);
      const categoryKey = categoryKeyFromTransition(category.transitionId);
      if (categoryKey !== expectedKey) {
        throw new Error(
          `Catalog category ${expectedKey} emitted ${categoryKey}`,
        );
      }
      checkpoints.push({
        label: `category-${categoryKey}-entry`,
        traceId: category.terminalTraceId,
      });
      await dependencies.activateVisibleSelector(
        client,
        '[data-test="catalog-product"]',
        { kind: "touch", timeoutMs: 30_000 },
      );
      await dependencies.waitForRoute(client, /^#\/products\//, {
        timeoutMs: 30_000,
        pollMs: 250,
      });
      runtimeTrace = await readTrace();
      checkpoints.push({
        label: `category-${categoryKey}-detail`,
        traceId: traceId(runtimeTrace),
      });
      await dependencies.activateVisibleSelector(
        client,
        '[data-test="product-buy"]',
        { kind: "touch", timeoutMs: 30_000 },
      );
      await dependencies.waitForRoute(client, "#/checkout", {
        timeoutMs: 30_000,
        pollMs: 250,
      });
      runtimeTrace = await readTrace();
      checkpoints.push({
        label: `category-${categoryKey}-checkout`,
        traceId: traceId(runtimeTrace),
      });
      categories.push({
        key: categoryKey,
        transitionId: category.transitionId,
        sourceUrl: `/audio/voice/product/${categoryKey}.mp3`,
        entryCheckpointLabel: `category-${categoryKey}-entry`,
        detailCheckpointLabel: `category-${categoryKey}-detail`,
        checkoutCheckpointLabel: `category-${categoryKey}-checkout`,
      });
      await dependencies.activateVisibleSelector(client, ".checkout-back", {
        kind: "touch",
        timeoutMs: 30_000,
      });
      await dependencies.waitForRoute(client, /^#\/products\//, {
        timeoutMs: 30_000,
        pollMs: 250,
      });
      await dependencies.activateVisibleSelector(
        client,
        ".detail-back-button",
        {
          kind: "touch",
          timeoutMs: 30_000,
        },
      );
      await dependencies.waitForRoute(client, "#/catalog", {
        timeoutMs: 30_000,
        pollMs: 250,
      });
    }

    await dependencies.setAudioPreferences(client, {
      volume: 0.35,
      cuesEnabled: true,
      presenceCuesEnabled: false,
      transactionCuesEnabled: true,
    });
    await dependencies.evaluateExpression(
      client,
      'location.hash = "#/catalog"',
    );
    await dependencies.waitForRoute(client, "#/catalog", {
      timeoutMs: 30_000,
      pollMs: 250,
    });
    boundary = traceId(await readTrace());
    await injectVisionPresence(guestInput, "empty", dependencies);
    await dependencies.sleep(SUSTAINED_EMPTY_MS);
    await injectVisionPresence(guestInput, "approach", dependencies);
    const disabledWelcome = await waitForTraceEntry(
      readTrace,
      boundary,
      (entry) =>
        entry?.type === "audio_rejected" &&
        String(entry?.transitionId).endsWith(":welcome") &&
        entry?.message === "audio cue preference disabled",
      dependencies,
      "disabled presence welcome rejection",
    );
    checkpoints.push({
      label: "disabled-presence-welcome-rejected",
      traceId: Number(disabledWelcome.entry.id),
    });
    await dependencies.setAudioPreferences(client, {
      volume: 0.7,
      cuesEnabled: true,
      presenceCuesEnabled: true,
      transactionCuesEnabled: true,
    });
    await dependencies.evaluateExpression(
      client,
      'location.hash = "#/catalog"',
    );
    await dependencies.waitForRoute(client, "#/catalog", {
      timeoutMs: 30_000,
      pollMs: 250,
    });

    const capture = aggregateCapture(cueWindows);
    const acceptance = {
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
        capture,
        cueWindows,
      },
      runtimeTrace,
      checkpoints,
      scenario: {
        welcome: {
          initialFenceTraceId,
          duplicateFenceTraceId,
          transientFenceTraceId,
          initialTransitionId: initialWelcome.transitionId,
          departureTransitionId: departure.entry.transitionId,
          rearmedFenceTraceId,
          rearmedTransitionId: rearmedWelcome.transitionId,
        },
        supportedCategoryKeys,
        categories,
        preferenceSuppression: {
          transitionId: disabledWelcome.entry.transitionId,
          rejectedTraceId: Number(disabledWelcome.entry.id),
        },
      },
      automaticVent,
    };
    runtimeTrace = await readTrace();
    acceptance.runtimeTrace = runtimeTrace;
    validatePresenceAndAudioAcceptanceEvidence(acceptance);
    const screenshotPath = join(artifactRoot, "presence-and-audio-final.png");
    const screenshot = await dependencies.captureScreenshotArtifact(
      client,
      screenshotPath,
    );
    dependencies.writeJson(
      join(artifactRoot, "runtime-trace.json"),
      runtimeTrace,
    );
    const logPath = join(artifactRoot, "presence-and-audio-summary.log");
    dependencies.writeText(
      logPath,
      `${JSON.stringify({
        runId: guestInput.runId,
        welcomeTransitions: [
          initialWelcome.transitionId,
          rearmedWelcome.transitionId,
        ],
        categoryTransitions: categories.map((entry) => entry.transitionId),
        nativeAudio: capture,
      })}\n`,
    );
    report.ok = true;
    report.presenceAndAudio = acceptance;
    report.artifacts = {
      directory: artifactRoot,
      audioCueCaptures: cueArtifactPaths,
      runtimeTrace: join(artifactRoot, "runtime-trace.json"),
      log: logPath,
      screenshot: { path: screenshotPath, ...screenshot },
    };
  } catch (error) {
    report.error =
      error instanceof Error
        ? {
            message: error.message,
            stack: String(error.stack ?? "").slice(0, 16_384),
          }
        : { message: String(error) };
    report.presenceAndAudio = report.presenceAndAudio ?? {
      result: "failed",
      runtimeTrace,
    };
  } finally {
    if (guestInput && activeAudioCaptureId) {
      await dependencies
        .controlPlaneRequest(
          guestInput,
          `/v1/audio-captures/${activeAudioCaptureId}/cancel`,
        )
        .catch((error) => {
          report.cleanupError =
            error instanceof Error ? error.message : String(error);
        });
    }
    await client?.close().catch((error) => {
      report.cleanupError =
        error instanceof Error ? error.message : String(error);
    });
    if (vision?.started) {
      await shutdownControlledVisionMock(vision.child).catch((error) => {
        report.cleanupError =
          error instanceof Error ? error.message : String(error);
      });
    }
    dependencies.writeJson(options.outPath, report);
  }
  return report;
}

export function validatePresenceAndAudioGuestReport(report) {
  if (
    report?.schemaVersion !== "vem-presence-and-audio-guest-full/v1" ||
    report?.ok !== true
  ) {
    throw new Error("presence and audio guest runner did not pass");
  }
  if (
    report?.boundaries?.visionMock !== true ||
    report?.boundaries?.machineCdp !== true ||
    report?.boundaries?.windowsAudioCapture !== true
  ) {
    throw new Error("presence and audio guest boundaries are incomplete");
  }
  for (const name of ["runtimeTrace"]) {
    required(report?.artifacts?.[name], `presence and audio artifact ${name}`);
  }
  if (
    !Array.isArray(report.artifacts.audioCueCaptures) ||
    report.artifacts.audioCueCaptures.length === 0 ||
    report.artifacts.audioCueCaptures.some(
      (capture) => !capture?.start || !capture?.stop,
    )
  ) {
    throw new Error("presence and audio cue capture artifacts are incomplete");
  }
  const summary = validatePresenceAndAudioAcceptanceEvidence(
    report.presenceAndAudio,
  );
  return { schemaVersion: report.schemaVersion, ...summary };
}

async function main() {
  const report = await runPresenceAndAudioGuestFull(
    parsePresenceAndAudioGuestArgs(process.argv.slice(2)),
  );
  if (!report.ok) process.exitCode = 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
