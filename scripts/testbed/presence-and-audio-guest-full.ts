#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import {
  ensureControlledVisionMock,
  shutdownControlledVisionMock,
  stopInstalledVisionOwnerForControlledMock,
  waitForControlledVisionRuntimeClient,
  waitForSaleStartReady,
} from "./fast-route-stress-sale.ts";
import { setMachineUiAudioPreferences } from "./local-operations-guest-full.ts";
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
} from "./machine-ui-cdp-driver.ts";
import { validatePresenceAndAudioAcceptanceEvidence } from "./presence-and-audio-acceptance.ts";

const MODE = "full";
const SHORT_EMPTY_MS = 1_000;
const SUSTAINED_EMPTY_MS = 5_000;
const WELCOME_CAPTURE_MS = 1_000;
const TRACE_TIMEOUT_MS = 30_000;
const PRESENCE_PRECONDITION_TIMEOUT_MS = SUSTAINED_EMPTY_MS + 2_000;
const ADMIN_USER = "local-testbed-admin";
const ADMIN_PASSWORD = "LocalTestbedAdminPassword!";

type JsonRecord = Record<string, unknown>;

function recordValue(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}
type GuestInputRecord = JsonRecord;
type HandoffRecord = JsonRecord;

type PresenceAudioDependencies = {
  readJson: (path: string, label: string) => JsonRecord;
  writeJson: (path: string, value: unknown) => void;
  writeText: (path: string, value: unknown) => void;
  captureScreenshotArtifact: (
    client: InstanceType<typeof CdpClient>,
    path: string,
  ) => Promise<unknown>;
  readTrace: (client: InstanceType<typeof CdpClient>) => Promise<unknown>;
  setAudioPreferences: (
    client: InstanceType<typeof CdpClient>,
    preferences: JsonRecord,
  ) => Promise<unknown>;
  fetchJson: (url: string, options: JsonRecord) => Promise<unknown>;
  controlPlaneRequest: (
    guestInput: GuestInputRecord,
    path: string,
    body?: JsonRecord,
  ) => Promise<unknown>;
  ensureControlledVisionMock: typeof ensureControlledVisionMock;
  stopInstalledVisionOwnerForControlledMock: typeof stopInstalledVisionOwnerForControlledMock;
  waitForControlledVisionRuntimeClient: typeof waitForControlledVisionRuntimeClient;
  discoverTarget: typeof discoverMachineUiTarget;
  createClient: (url: string) => InstanceType<typeof CdpClient>;
  enablePageRuntime: typeof enablePageRuntime;
  waitForRoute: typeof waitForRoute;
  waitForSaleStartReady: typeof waitForSaleStartReady;
  activateVisibleSelector: typeof activateVisibleSelector;
  evaluateExpression: typeof evaluateExpression;
  rewriteWebSocketDebuggerUrl: typeof rewriteWebSocketDebuggerUrl;
  observeConnectedCdpIdentity: typeof observeConnectedCdpIdentity;
  sleep: (milliseconds: number) => Promise<void>;
  now: () => number;
  randomUUID: () => string;
  issueAdminVentBaseline: (
    guestInput: GuestInputRecord,
    dependencies: PresenceAudioDependencies,
  ) => Promise<JsonRecord>;
  issueAdminVentOverride: (
    guestInput: GuestInputRecord,
    dependencies: PresenceAudioDependencies,
  ) => Promise<JsonRecord>;
  submitTemporaryVentStop: (
    handoff: HandoffRecord,
    actionId: string,
    dependencies: PresenceAudioDependencies,
  ) => Promise<JsonRecord>;
  submitDuplicateStablePresenceAction: (
    handoff: HandoffRecord,
    edgeId: string,
    dependencies: PresenceAudioDependencies,
  ) => Promise<unknown>;
  artifactRoot: (outPath: string) => string;
  makeDirectory: (path: string) => void;
};

function required(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function windowsAbsolute(value: unknown, label: string): string {
  const path = required(value, label);
  if (!/^[A-Za-z]:\\/.test(path) || path.includes("\0")) {
    throw new Error(`${label} must be an absolute Windows path`);
  }
  return path;
}

function localPath(path: string): string {
  return process.platform === "win32"
    ? path
    : resolve(
        `/mnt/${path[0].toLowerCase()}/${path.slice(3).replaceAll("\\", "/")}`,
      );
}

function readJson(path: string, label: string): JsonRecord {
  try {
    return JSON.parse(readFileSync(localPath(path), "utf8")) as JsonRecord;
  } catch (error) {
    throw new Error(
      `${label} is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function writeJson(path: string, value: unknown): void {
  const target = localPath(path);
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(temporary, target);
}

function writeText(path: string, value: unknown): void {
  const target = localPath(path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, String(value), { mode: 0o600 });
}

async function captureScreenshotArtifact(
  client: InstanceType<typeof CdpClient>,
  path: string,
): Promise<unknown> {
  return captureScreenshot(client, {
    format: "png",
    label: "presence-and-audio-final",
    screenshotSink: async ({ bytes }) => {
      writeFileSync(path, bytes, { mode: 0o600 });
      return { ref: path };
    },
  });
}

function option(args: string[], name: string): string {
  const index = args.indexOf(`--${name}`);
  const value = index === -1 ? undefined : args[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`--${name} requires a value`);
  return value;
}

function optionalOption(args: string[], name: string): string | null {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? null : required(args[index + 1], `--${name}`);
}

export function parsePresenceAndAudioGuestArgs(args: string[]): {
  mode: string;
  guestInputPath: string;
  handoffPath: string;
  outPath: string;
  fixtureKey: string | null;
} {
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

async function fetchJson(
  url: string,
  options: JsonRecord = {},
): Promise<unknown> {
  const response = await fetch(url, {
    ...options,
    signal:
      (options.signal as AbortSignal | undefined) ??
      AbortSignal.timeout(Number(options.timeoutMs ?? 30_000)),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      `${options.method ?? "GET"} ${url} failed with HTTP ${response.status}: ${JSON.stringify(payload)}`,
    );
  }
  return payload;
}

async function controlPlaneRequest(
  guestInput: GuestInputRecord,
  path: string,
  body: JsonRecord = {},
): Promise<unknown> {
  const controlPlane = guestInput?.hostControlPlane as JsonRecord | undefined;
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

function visionControlPort(guestInput: GuestInputRecord): number {
  const hostControlPlane = guestInput?.hostControlPlane as
    | JsonRecord
    | undefined;
  const port = Number(
    hostControlPlane?.visionMockControlPort ??
      guestInput?.visionMockControlPort,
  );
  if (!Number.isInteger(port) || port < 1) {
    throw new Error("guest input is missing vision mock control port");
  }
  return port;
}

async function injectVisionPresence(
  guestInput: GuestInputRecord,
  state: "approach" | "empty",
  dependencies: PresenceAudioDependencies,
): Promise<unknown> {
  if (state !== "approach" && state !== "empty")
    throw new Error("Vision presence state is invalid");
  const port = visionControlPort(guestInput);
  return (
    dependencies.fetchJson as (
      url: string,
      options: JsonRecord,
    ) => Promise<unknown>
  )(`http://127.0.0.1:${port}/control/presence`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ state }),
  });
}

async function injectVisionDeparture(
  guestInput: GuestInputRecord,
  dependencies: PresenceAudioDependencies,
): Promise<unknown> {
  const port = visionControlPort(guestInput);
  return (
    dependencies.fetchJson as (
      url: string,
      options: JsonRecord,
    ) => Promise<unknown>
  )(`http://127.0.0.1:${port}/control/departure`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: "presence-and-audio-precondition" }),
  });
}

function traceId(trace: unknown[]): number {
  return trace.reduce<number>(
    (maximum, entry) =>
      Math.max(maximum, Number((entry as JsonRecord)?.id) || 0),
    0,
  );
}

function traceEntryAfter(
  trace: unknown[],
  boundary: number,
  predicate: (entry: JsonRecord) => boolean,
): unknown {
  return trace.find(
    (entry) =>
      Number((entry as JsonRecord)?.id) > boundary &&
      predicate(entry as JsonRecord),
  );
}

export function latestTouchscreenSessionActive(trace: unknown[]): boolean {
  for (const entry of [...trace].reverse()) {
    const entryRecord = entry as JsonRecord;
    if (typeof entryRecord?.touchscreenSessionActive === "boolean") {
      return entryRecord.touchscreenSessionActive;
    }
  }
  return false;
}

export async function waitForTouchscreenSessionIdle(
  readTrace: () => Promise<unknown[]>,
  dependencies: PresenceAudioDependencies,
  label: string,
  {
    timeoutMs = 50_000,
    pollMs = 250,
  }: {
    timeoutMs?: number;
    pollMs?: number;
  } = {},
): Promise<JsonRecord> {
  const deadline = dependencies.now() + timeoutMs;
  const now = dependencies.now as () => number;
  const sleepFn = dependencies.sleep as (milliseconds: number) => Promise<void>;
  let last = await readTrace();
  if (latestTouchscreenSessionActive(last) !== true) {
    return { waited: false, trace: last };
  }
  do {
    await sleepFn(pollMs);
    last = await readTrace();
    if (latestTouchscreenSessionActive(last) !== true) {
      return { waited: true, trace: last };
    }
  } while (now() < deadline);
  throw new Error(
    `${label} touchscreen session did not become idle: ${JSON.stringify(last.slice(-12))}`,
  );
}

async function waitForTraceEntry(
  readTrace: () => Promise<unknown[]>,
  boundary: number,
  predicate: (entry: JsonRecord) => boolean,
  dependencies: PresenceAudioDependencies,
  label: string,
  {
    timeoutMs = TRACE_TIMEOUT_MS,
    pollMs = 100,
  }: {
    timeoutMs?: number;
    pollMs?: number;
  } = {},
): Promise<{ entry: JsonRecord; trace: unknown[] }> {
  const deadline = dependencies.now() + timeoutMs;
  const now = dependencies.now as () => number;
  const sleepFn = dependencies.sleep as (milliseconds: number) => Promise<void>;
  let last: unknown[] = [];
  do {
    last = await readTrace();
    const entry = traceEntryAfter(last, boundary, predicate) as
      | JsonRecord
      | undefined;
    if (entry) return { entry, trace: last };
    await sleepFn(pollMs);
  } while (now() < deadline);
  throw new Error(
    `${label} was not observed in Machine runtimeTrace: ${JSON.stringify(last.slice(-12))}`,
  );
}

async function waitForAudioLifecycle(
  readTrace: () => Promise<unknown[]>,
  boundary: number,
  transitionPredicate: (entry: JsonRecord) => boolean,
  dependencies: PresenceAudioDependencies,
  label: string,
  { requireTerminal = true }: { requireTerminal?: boolean } = {},
): Promise<JsonRecord> {
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
  const startedResult = await waitForTraceEntry(
    readTrace,
    Number(transition.entry.id),
    (entry) =>
      entry?.type === "audio_started" &&
      entry?.transitionId === transitionId &&
      entry?.message === "native",
    dependencies,
    `${label} native audio start`,
  );
  const terminal = requireTerminal
    ? await waitForTraceEntry(
        readTrace,
        Number(startedResult.entry.id),
        (entry) =>
          entry?.type === "audio_terminal" &&
          entry?.transitionId === transitionId &&
          entry?.outcome === "completed",
        dependencies,
        `${label} native audio terminal`,
      )
    : null;
  const observedTrace = terminal?.trace ?? startedResult.trace;
  const lifecycle = observedTrace.filter(
    (entry) => (entry as JsonRecord)?.transitionId === transitionId,
  );
  const started = lifecycle.filter(
    (entry) => (entry as JsonRecord)?.type === "audio_started",
  );
  if (
    started.length !== 1 ||
    (started[0] as JsonRecord)?.message !== "native"
  ) {
    throw new Error(`${label} did not use exactly one native audio start`);
  }
  return {
    transitionId,
    terminalTraceId: traceId(observedTrace),
    trace: observedTrace,
  };
}

function categoryKeyFromTransition(transitionId: unknown): string {
  const match = /^category:category-entry-([a-z0-9_-]+)-\d+$/i.exec(
    String(transitionId),
  );
  if (!match)
    throw new Error(
      `category transition id is invalid: ${String(transitionId)}`,
    );
  return match[1];
}

function categorySelector(key: unknown): string {
  const normalized = required(key, "supported category key");
  if (!/^[A-Za-z0-9_-]+$/.test(normalized)) {
    throw new Error(`supported category key is invalid: ${normalized}`);
  }
  return `[data-test="catalog-category"][data-category-key="${normalized}"]:not(:disabled)`;
}

async function readSupportedCategoryKeys(
  client: InstanceType<typeof CdpClient>,
  dependencies: PresenceAudioDependencies,
): Promise<string[]> {
  const keys = await (
    dependencies.evaluateExpression as (
      client: InstanceType<typeof CdpClient>,
      expression: string,
      options?: JsonRecord,
    ) => Promise<unknown>
  )(
    client,
    `(() => Array.from(document.querySelectorAll('[data-test="catalog-category"]:not(:disabled)'))
      .map((element) => element.dataset.categoryKey || '')
      .filter(Boolean))()`,
  );
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new Error("installed Catalog has no enabled product categories");
  }
  const normalized = (keys as unknown[]).map((key) =>
    required(key, "supported category key"),
  );
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(
      "installed Catalog exposes duplicate enabled product categories",
    );
  }
  for (const key of normalized) categorySelector(key);
  return normalized;
}

async function returnToCatalogHome(
  client: InstanceType<typeof CdpClient>,
  dependencies: PresenceAudioDependencies,
): Promise<void> {
  const deadline = dependencies.now() + 30_000;
  const now = dependencies.now as () => number;
  const sleepFn = dependencies.sleep as (milliseconds: number) => Promise<void>;
  const evaluate = dependencies.evaluateExpression as (
    client: InstanceType<typeof CdpClient>,
    expression: string,
    options?: JsonRecord,
  ) => Promise<unknown>;
  const waitForRouteFn = dependencies.waitForRoute as (
    client: InstanceType<typeof CdpClient>,
    route: string | RegExp,
    options?: JsonRecord,
  ) => Promise<unknown>;
  let lastError: unknown = null;
  do {
    await evaluate(client, 'location.hash = "#/catalog"');
    try {
      await waitForRouteFn(client, "#/catalog", {
        timeoutMs: 5_000,
        pollMs: 100,
      });
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await sleepFn(250);
        await waitForRouteFn(client, "#/catalog", {
          timeoutMs: 500,
          pollMs: 100,
        });
      }
      return;
    } catch (error) {
      lastError = error;
      await sleepFn(250);
    }
  } while (now() < deadline);
  throw new Error(
    `Catalog route did not stay stable after maintenance recovery: ${
      lastError instanceof Error ? lastError.message : "unknown route error"
    }`,
  );
}

function runtimeBinding(
  handoff: HandoffRecord,
  cdpIdentity: JsonRecord | null | undefined,
): JsonRecord {
  const machine = (handoff?.machine ?? {}) as JsonRecord;
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

export async function observeGuestRuntimeIdentity(
  client: InstanceType<typeof CdpClient>,
  dependencies: PresenceAudioDependencies,
): Promise<unknown> {
  if (typeof client?.observeIdentity === "function") {
    return client.observeIdentity();
  }
  if (typeof dependencies?.observeConnectedCdpIdentity === "function") {
    return Promise.resolve(
      (
        dependencies.observeConnectedCdpIdentity as (
          client: InstanceType<typeof CdpClient>,
        ) => unknown
      )(client),
    );
  }
  throw new Error("connected production CDP client identity is unavailable");
}

function captureSummary(stopReport: JsonRecord | null | undefined): JsonRecord {
  const capture = stopReport?.capture as JsonRecord | undefined;
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

function b3Speed(frame: JsonRecord | null | undefined): number | null {
  const value = /^55b3(0[0-4])$/i.exec(String(frame?.rawFrameHex ?? ""))?.[1];
  return value ? Number.parseInt(value, 16) : null;
}

function stableEdgeId(transitionId: unknown): string {
  const match = /^vision:presence-(\d+):(welcome|departed)$/.exec(
    required(transitionId, "presence transition id"),
  );
  if (!match)
    throw new Error(`presence transition id is invalid: ${transitionId}`);
  return `presence-${match[1]}:${match[2] === "welcome" ? "arrival" : "departure"}`;
}

function serialFrameSequence(frame: unknown): number | null {
  const frameRecord = frame as JsonRecord | undefined;
  if (Number.isInteger(frameRecord?.sequence)) {
    return frameRecord?.sequence as number;
  }
  const match = String(frameRecord?.boundaryId ?? "").match(/:(\d+)$/);
  return match ? Number(match[1]) : null;
}

function serialFrameIdentity(frame: unknown): string {
  const frameRecord = frame as JsonRecord | null | undefined;
  if (!frameRecord || typeof frameRecord !== "object") return "";
  return [
    frameRecord.boundaryId ?? "",
    frameRecord.capturedAt ?? "",
    frameRecord.direction ?? "",
    frameRecord.rawFrameHex ?? "",
    frameRecord.parsedOpcode ?? "",
  ].join(":");
}

export function serialEvidenceCursor(
  evidence: JsonRecord | null | undefined,
): JsonRecord {
  const frames = Array.isArray(evidence?.rawFrames)
    ? (evidence.rawFrames as unknown[])
    : [];
  const sequences = frames
    .map((frame) => serialFrameSequence(frame))
    .filter((value): value is number => Number.isInteger(value));
  const lastFrame = frames.at(-1) ?? null;
  const lastFrameRecord = lastFrame as JsonRecord | null;
  return {
    frameCount: frames.length,
    lastSequence: sequences.length > 0 ? Math.max(...sequences) : null,
    lastCapturedAt: lastFrameRecord?.capturedAt ?? null,
    lastIdentity: serialFrameIdentity(lastFrameRecord),
  };
}

export function serialFramesSince(
  evidence: JsonRecord | null | undefined,
  cursor: JsonRecord | number | null | undefined,
): unknown[] {
  const frames = Array.isArray(evidence?.rawFrames)
    ? (evidence.rawFrames as unknown[])
    : [];
  const cursorRecord = cursor as JsonRecord | null | undefined;
  if (Number.isInteger(cursorRecord?.lastSequence)) {
    const bySequence = frames.filter((frame) => {
      const sequence = serialFrameSequence(frame);
      return (
        sequence !== null && sequence > (cursorRecord?.lastSequence as number)
      );
    });
    if (bySequence.length > 0) return bySequence;
    const lastIdentityIndex = frames.findIndex(
      (frame) => serialFrameIdentity(frame) === cursorRecord?.lastIdentity,
    );
    if (lastIdentityIndex >= 0) return frames.slice(lastIdentityIndex + 1);
    const lastCapturedAt = Date.parse(
      String(cursorRecord?.lastCapturedAt ?? ""),
    );
    if (Number.isFinite(lastCapturedAt)) {
      const byTime = frames.filter((frame) => {
        const capturedAt = Date.parse(
          String((frame as JsonRecord)?.capturedAt ?? ""),
        );
        return Number.isFinite(capturedAt) && capturedAt > lastCapturedAt;
      });
      if (byTime.length > 0) return byTime;
    }
    if (
      Number.isInteger(cursorRecord?.frameCount) &&
      frames.length <= (cursorRecord?.frameCount as number)
    ) {
      return [];
    }
  }
  const frameCount = Number.isInteger(cursorRecord?.frameCount)
    ? (cursorRecord?.frameCount as number)
    : typeof cursor === "number"
      ? cursor
      : 0;
  return frames.slice(frameCount > frames.length ? 0 : frameCount);
}

function b3FramesSince(
  evidence: JsonRecord | null | undefined,
  cursor: JsonRecord | number | null | undefined,
): unknown[] {
  return serialFramesSince(evidence, cursor)
    .filter(
      (frame) =>
        (frame as JsonRecord)?.direction === "daemon-to-controller" &&
        (frame as JsonRecord)?.parsedOpcode === "B3",
    )
    .map((frame) => ({
      ...(frame as JsonRecord),
      speed: b3Speed(frame as JsonRecord),
    }));
}

async function waitForB3Sequence(
  guestInput: GuestInputRecord,
  sessionId: string,
  beforeFrameCount: JsonRecord | number,
  expectedSpeeds: number[],
  dependencies: PresenceAudioDependencies,
): Promise<JsonRecord> {
  const deadline = dependencies.now() + TRACE_TIMEOUT_MS;
  const now = dependencies.now as () => number;
  const sleepFn = dependencies.sleep as (milliseconds: number) => Promise<void>;
  const controlRequest = dependencies.controlPlaneRequest as (
    guestInput: GuestInputRecord,
    path: string,
    body?: JsonRecord,
  ) => Promise<unknown>;
  let evidence: JsonRecord | null = null;
  do {
    evidence = (await controlRequest(
      guestInput,
      `/v1/serial-sessions/${sessionId}/evidence`,
      { rawFrameLimit: 1024 },
    )) as JsonRecord;
    const frames = b3FramesSince(evidence, beforeFrameCount);
    if (
      frames.map((frame) => (frame as JsonRecord).speed).join(",") ===
      expectedSpeeds.join(",")
    ) {
      return { evidence, frames };
    }
    await sleepFn(100);
  } while (now() < deadline);
  throw new Error(
    `B3 sequence ${expectedSpeeds.join(",")} was not observed: ${JSON.stringify(b3FramesSince(evidence, beforeFrameCount))}`,
  );
}

function presenceVentEvidence({
  frames,
  initialTransitionId,
  departureTransitionId,
  rearmedTransitionId,
  operatorSetting,
  duplicateSameEdge,
}: {
  frames: unknown[];
  initialTransitionId: unknown;
  departureTransitionId: unknown;
  rearmedTransitionId: unknown;
  operatorSetting: JsonRecord | null | undefined;
  duplicateSameEdge: JsonRecord | null | undefined;
}): JsonRecord {
  const speeds = frames.map((frame) => (frame as JsonRecord).speed);
  if (speeds.join(",") !== "3,2,0,2") {
    throw new Error(
      `presence-driven B3 evidence must be exactly 3,2,0,2: ${JSON.stringify(frames)}`,
    );
  }
  const [arrivalFrame, operatorFrame, departureFrame, rearmedFrame] = frames;
  const arrivalAt = Date.parse(
    String((arrivalFrame as JsonRecord)?.capturedAt ?? ""),
  );
  const operatorAt = Date.parse(
    String((operatorFrame as JsonRecord)?.capturedAt ?? ""),
  );
  const departureAt = Date.parse(
    String((departureFrame as JsonRecord)?.capturedAt ?? ""),
  );
  if (
    !Number.isFinite(arrivalAt) ||
    !Number.isFinite(operatorAt) ||
    !Number.isFinite(departureAt) ||
    !Number.isFinite(
      Date.parse(String((rearmedFrame as JsonRecord)?.capturedAt ?? "")),
    )
  ) {
    throw new Error(
      "presence-driven B3 evidence requires capturedAt timestamps",
    );
  }
  const guardElapsedMs = departureAt - arrivalAt;
  if (operatorAt - arrivalAt < 5_000 || departureAt - operatorAt < 5_000) {
    throw new Error(
      `presence-driven B3 guard was shorter than 5 seconds: ${guardElapsedMs}`,
    );
  }
  if (
    operatorSetting?.requestedSpeed !== 2 ||
    operatorSetting?.resultStatus !== "succeeded" ||
    duplicateSameEdge?.outcome !== "deduplicated"
  ) {
    throw new Error(
      "presence-driven B3 operator-setting evidence is incomplete",
    );
  }
  return {
    protocolFrames: [arrivalFrame, departureFrame, rearmedFrame],
    speeds: [3, 0, 2],
    guardElapsedMs,
    edgeCorrelation: [
      {
        edgeId: stableEdgeId(initialTransitionId),
        transitionId: initialTransitionId,
        speed: 3,
        frame: arrivalFrame,
      },
      {
        edgeId: stableEdgeId(departureTransitionId),
        transitionId: departureTransitionId,
        speed: 0,
        frame: departureFrame,
      },
      {
        edgeId: stableEdgeId(rearmedTransitionId),
        transitionId: rearmedTransitionId,
        speed: 2,
        frame: rearmedFrame,
      },
    ],
    operatorSetting: {
      ...(operatorSetting ?? {}),
      frame: operatorFrame,
      duplicateSameEdge,
    },
  };
}

function aggregateCapture(cueWindows: unknown[]): JsonRecord {
  const captures = cueWindows.map(
    (window) => (window as JsonRecord).capture as JsonRecord,
  );
  if (captures.length === 0) throw new Error("audio cue captures are empty");
  return {
    nonSilentFrameCount: captures.reduce(
      (total, capture) => total + (capture.nonSilentFrameCount as number),
      0,
    ),
    peakAbsoluteSample: Math.max(
      ...captures.map((capture) => capture.peakAbsoluteSample as number),
    ),
    startedAt: captures[0].startedAt,
    completedAt: captures.at(-1)?.completedAt ?? null,
  };
}

function apiBaseUrl(guestInput: GuestInputRecord): string {
  const bootstrap = guestInput?.runtimeBootstrap as JsonRecord | undefined;
  return required(
    bootstrap?.provisioningApiBaseUrl,
    "runtimeBootstrap.provisioningApiBaseUrl",
  ).replace(/\/+$/, "");
}

function daemonBaseUrl(handoff: HandoffRecord): string {
  const daemon = handoff?.daemon as JsonRecord | undefined;
  const ready = daemon?.ready as JsonRecord | undefined;
  const healthzUrl = required(ready?.healthzUrl, "daemon healthzUrl");
  if (!healthzUrl.endsWith("/healthz")) {
    throw new Error("daemon healthzUrl must end with /healthz");
  }
  return healthzUrl.slice(0, -"/healthz".length);
}

function unwrapServiceApiEnvelope(payload: unknown): unknown {
  const record = payload as JsonRecord | null;
  if (record?.code === 0 && Object.hasOwn(record, "data")) {
    return record.data;
  }
  return payload;
}

async function issueAdminVentCommand(
  guestInput: GuestInputRecord,
  ventSpeed: number,
  dependencies: PresenceAudioDependencies,
): Promise<JsonRecord> {
  const request = async (
    path: string,
    options: JsonRecord = {},
  ): Promise<unknown> =>
    unwrapServiceApiEnvelope(
      await (
        dependencies.fetchJson as (
          url: string,
          options: JsonRecord,
        ) => Promise<unknown>
      )(`${apiBaseUrl(guestInput)}${path}`, options),
    );
  const login = await request("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASSWORD }),
  });
  const token = required(
    (login as JsonRecord | undefined)?.accessToken,
    "admin accessToken",
  );
  const machines = (await request("/machines?page=1&pageSize=100", {
    headers: { authorization: `Bearer ${token}` },
  })) as JsonRecord | null;
  const items = (machines?.items ?? []) as unknown[];
  const machine = items.find(
    (entry) =>
      (entry as JsonRecord)?.code ===
      required(guestInput.machineCode, "machineCode"),
  );
  const machineRecord = machine as JsonRecord | undefined;
  if (!machineRecord?.id)
    throw new Error("admin testbed machine was not found");
  const command = await request(
    `/machines/${String(machineRecord.id)}/commands/environment-control`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ ventSpeed }),
    },
  );
  const commandNo = required(
    (command as JsonRecord | undefined)?.commandNo,
    "Admin environment commandNo",
  );
  const deadline = dependencies.now() + TRACE_TIMEOUT_MS;
  const now = dependencies.now as () => number;
  const sleepFn = dependencies.sleep as (milliseconds: number) => Promise<void>;
  do {
    const status = (await request(`/machines/${String(machineRecord.id)}`, {
      headers: { authorization: `Bearer ${token}` },
    })) as JsonRecord | null;
    const latest = status?.latestEnvironmentCommand as JsonRecord | undefined;
    if (
      latest?.commandNo === commandNo &&
      ["succeeded", "failed", "timeout"].includes(String(latest?.status))
    ) {
      if (latest.status !== "succeeded") {
        throw new Error(
          `Admin B3 command did not succeed: ${JSON.stringify(latest)}`,
        );
      }
      return {
        commandNo,
        resultStatus: latest.status,
        requestedSpeed: ventSpeed,
      };
    }
    await sleepFn(100);
  } while (now() < deadline);
  throw new Error(
    `Admin B3 command did not reach a terminal result: ${commandNo}`,
  );
}

async function issueAdminVentBaseline(
  guestInput: GuestInputRecord,
  dependencies: PresenceAudioDependencies,
): Promise<JsonRecord> {
  return issueAdminVentCommand(guestInput, 3, dependencies);
}

async function issueAdminVentOverride(
  guestInput: GuestInputRecord,
  dependencies: PresenceAudioDependencies,
): Promise<JsonRecord> {
  return issueAdminVentCommand(guestInput, 2, dependencies);
}

async function submitTemporaryVentStop(
  handoff: HandoffRecord,
  actionId: string,
  dependencies: PresenceAudioDependencies,
): Promise<JsonRecord> {
  const daemon = handoff?.daemon as JsonRecord | undefined;
  const ready = daemon?.ready as JsonRecord | undefined;
  const request = dependencies.fetchJson as (
    url: string,
    options: JsonRecord,
  ) => Promise<unknown>;
  const admission = (await request(
    `${daemonBaseUrl(handoff)}/v1/environment-control/actions`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${required(ready?.ipcToken, "daemon ipcToken")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        actionId,
        source: "local_operator",
        action: { type: "temporarily_stop_vent" },
      }),
    },
  )) as JsonRecord;
  if (admission.outcome !== "accepted") {
    throw new Error(
      `temporary vent stop was not accepted: ${JSON.stringify(admission)}`,
    );
  }
  const deadline = dependencies.now() + TRACE_TIMEOUT_MS;
  do {
    const snapshot = (await request(
      `${daemonBaseUrl(handoff)}/v1/environment-control`,
      {
        headers: {
          authorization: `Bearer ${required(ready?.ipcToken, "daemon ipcToken")}`,
        },
      },
    )) as JsonRecord;
    if (
      snapshot.revision === admission.acceptedRevision &&
      snapshot.convergence === "applied" &&
      (snapshot.desired as JsonRecord | undefined)?.ventSpeed === 0
    ) {
      return { admission, snapshot };
    }
    await dependencies.sleep(100);
  } while (dependencies.now() < deadline);
  throw new Error("temporary vent stop did not converge");
}

async function submitDuplicateStablePresenceAction(
  handoff: HandoffRecord,
  edgeId: string,
  dependencies: PresenceAudioDependencies,
): Promise<unknown> {
  const daemon = handoff?.daemon as JsonRecord | undefined;
  const ready = daemon?.ready as JsonRecord | undefined;
  const submit = (actionId: string) =>
    (
      dependencies.fetchJson as (
        url: string,
        options: JsonRecord,
      ) => Promise<unknown>
    )(`${daemonBaseUrl(handoff)}/v1/environment-control/actions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${required(ready?.ipcToken, "daemon ipcToken")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        actionId,
        source: "stable_presence",
        action: { type: "restore_base_vent_speed" },
      }),
    });
  const actionId = `presence-and-audio-test-${dependencies.randomUUID()}:${edgeId}`;
  const first = (await submit(actionId)) as JsonRecord;
  if (first?.outcome !== "accepted") {
    throw new Error(
      `stable-presence action was not accepted: ${JSON.stringify(first)}`,
    );
  }
  const second = (await submit(actionId)) as JsonRecord;
  if (second?.outcome !== "deduplicated") {
    throw new Error(
      `duplicate stable-presence action was not deduplicated: ${JSON.stringify(second)}`,
    );
  }
  return { first, second, actionId, outcome: second?.outcome };
}

function defaultDependencies(): PresenceAudioDependencies {
  return {
    readJson,
    writeJson,
    writeText,
    captureScreenshotArtifact,
    readTrace: (client: InstanceType<typeof CdpClient>) =>
      evaluateExpression(client, "window.__VEM_MACHINE_RUNTIME_TRACE__ || []"),
    setAudioPreferences: setMachineUiAudioPreferences,
    fetchJson,
    controlPlaneRequest,
    ensureControlledVisionMock,
    stopInstalledVisionOwnerForControlledMock,
    waitForControlledVisionRuntimeClient,
    discoverTarget: discoverMachineUiTarget,
    createClient: (url: string) => new CdpClient(url),
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
    issueAdminVentBaseline,
    issueAdminVentOverride,
    submitTemporaryVentStop,
    submitDuplicateStablePresenceAction,
    artifactRoot: (outPath: string) =>
      join(dirname(localPath(outPath)), "presence-and-audio-artifacts"),
    makeDirectory: (path: string) => mkdirSync(path, { recursive: true }),
  };
}

export async function runPresenceAndAudioGuestFull(
  options: {
    mode: string;
    guestInputPath: string;
    handoffPath: string;
    outPath: string;
    fixtureKey: string | null;
  },
  injected: Partial<PresenceAudioDependencies> = {},
): Promise<JsonRecord> {
  const dependencies: PresenceAudioDependencies = {
    ...defaultDependencies(),
    ...injected,
  };
  const report: JsonRecord = {
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
  let guestInput: GuestInputRecord | null = null;
  let handoff: HandoffRecord | null = null;
  let client: InstanceType<typeof CdpClient> | null = null;
  let vision: unknown = null;
  let activeAudioCaptureId: string | null = null;
  let runtimeTrace: unknown[] = [];
  let artifactRoot: string | null = null;

  try {
    guestInput = dependencies.readJson(options.guestInputPath, "guest input");
    const activeGuestInput = guestInput;
    handoff = dependencies.readJson(
      options.handoffPath,
      "installed runtime handoff",
    );
    const activeHandoff = handoff;
    artifactRoot = dependencies.artifactRoot(options.outPath);
    dependencies.makeDirectory(artifactRoot);
    const visionPort = visionControlPort(guestInput);
    await dependencies.stopInstalledVisionOwnerForControlledMock();
    vision = await dependencies.ensureControlledVisionMock(visionPort);
    await dependencies.waitForControlledVisionRuntimeClient(visionPort);
    (report.boundaries as JsonRecord).visionMock = true;

    const handoffCdp = handoff?.cdp as JsonRecord | undefined;
    const target = await dependencies.discoverTarget({
      endpoint: "http://127.0.0.1:9222",
      expectedTargetId: required(handoffCdp?.targetId, "handoff cdp targetId"),
    });
    client = dependencies.createClient(
      dependencies.rewriteWebSocketDebuggerUrl(
        target.webSocketDebuggerUrl,
        "http://127.0.0.1:9222",
      ),
    );
    const activeClient = client;
    await activeClient.connect();
    await dependencies.enablePageRuntime(activeClient);
    await dependencies.waitForRoute(activeClient, "#/catalog", {
      timeoutMs: 30_000,
      pollMs: 250,
    });
    await dependencies.waitForSaleStartReady(activeHandoff, activeClient);
    await dependencies.setAudioPreferences(activeClient, {
      volume: 0.7,
      cuesEnabled: true,
      presenceCuesEnabled: true,
      transactionCuesEnabled: true,
    });
    await dependencies.evaluateExpression(
      activeClient,
      'location.hash = "#/catalog"',
    );
    await dependencies.waitForRoute(activeClient, "#/catalog", {
      timeoutMs: 30_000,
      pollMs: 250,
    });
    (report.boundaries as JsonRecord).machineCdp = true;

    const cdpIdentity = (await observeGuestRuntimeIdentity(
      activeClient,
      dependencies,
    )) as JsonRecord | null | undefined;
    const runtime = runtimeBinding(activeHandoff, cdpIdentity);
    const sessionId = required(
      (activeHandoff?.commissioningSerialSession as JsonRecord | undefined)
        ?.sessionId,
      "commissioning serial session id",
    );
    const operationId = `presence-and-audio-${dependencies.randomUUID()}`;
    const cueWindows: unknown[] = [];
    const cueArtifactPaths: Array<{ start: string; stop: string | null }> = [];
    let cueOrdinal = 0;
    const startCueCapture = async (label: string): Promise<JsonRecord> => {
      cueOrdinal += 1;
      const artifactLabel = `${String(cueOrdinal).padStart(2, "0")}-${label}`;
      const audioStart = (await dependencies.controlPlaneRequest(
        activeGuestInput,
        "/v1/audio-captures/start",
        {
          sessionId,
          runId: required(activeGuestInput.runId, "runId"),
          lifecycleReference: `vm-lifecycle://${required(activeGuestInput.runId, "runId").toLowerCase()}.presence-and-audio`,
          transactionId: `transaction://${required(activeGuestInput.runId, "runId").toLowerCase()}.presence-and-audio.${artifactLabel}`,
          targetIdentity: required(
            (activeGuestInput.hostControlPlane as JsonRecord | undefined)
              ?.targetIdentity,
            "hostControlPlane.targetIdentity",
          ),
          runtime,
          operationId: `${operationId}-${artifactLabel}`,
        },
      )) as JsonRecord;
      activeAudioCaptureId = required(
        audioStart?.audioCaptureId,
        "audio capture id",
      );
      const startPath = join(
        artifactRoot as string,
        `audio-capture-${artifactLabel}-start.json`,
      );
      dependencies.writeJson(startPath, audioStart.startReport);
      cueArtifactPaths.push({ start: startPath, stop: null });
      (report.boundaries as JsonRecord).windowsAudioCapture = true;
      return { id: activeAudioCaptureId, artifactLabel };
    };
    const stopCueCapture = async (
      capture: JsonRecord,
      transitionId: unknown,
    ): Promise<void> => {
      const audioStop = (await dependencies.controlPlaneRequest(
        activeGuestInput,
        `/v1/audio-captures/${String(capture.id)}/stop`,
        { captureKind: "default-audio" },
      )) as JsonRecord;
      activeAudioCaptureId = null;
      const stopPath = join(
        artifactRoot as string,
        `audio-capture-${String(capture.artifactLabel)}-stop.json`,
      );
      dependencies.writeJson(stopPath, audioStop.stopReport);
      const lastArtifact = cueArtifactPaths.at(-1);
      if (lastArtifact) lastArtifact.stop = stopPath;
      const payloads = (audioStop.evidencePayloads ?? []) as unknown[];
      for (const artifactValue of payloads) {
        const artifact = artifactValue as JsonRecord;
        writeFileSync(
          join(
            artifactRoot as string,
            `${String(capture.artifactLabel)}-${String(artifact.fileName)}`,
          ),
          Buffer.from(String(artifact.bytesBase64), "base64"),
          { mode: 0o600 },
        );
      }
      cueWindows.push({
        transitionId,
        kind: "detected",
        capture: captureSummary(audioStop.stopReport as JsonRecord),
      });
    };

    const readTrace = async () => {
      runtimeTrace = (await dependencies.readTrace(activeClient)) as unknown[];
      return runtimeTrace;
    };
    // A previous business set may leave the shared journey in a present state.
    // Observe a real departure when present state is still armed, even if the
    // bounded runtime trace no longer contains the original welcome edge.
    await dependencies.setAudioPreferences(activeClient, {
      volume: 0.7,
      cuesEnabled: true,
      presenceCuesEnabled: false,
      transactionCuesEnabled: true,
    });
    const preconditionTrace = await readTrace();
    const preconditionBoundary = traceId(preconditionTrace);
    let presencePrecondition: JsonRecord = {
      boundaryTraceId: preconditionBoundary,
      outcome: "already_empty_or_unobserved",
      departureTransitionId: null,
    };
    await injectVisionPresence(
      activeGuestInput as GuestInputRecord,
      "approach",
      dependencies,
    );
    await dependencies.sleep(250);
    await injectVisionDeparture(
      activeGuestInput as GuestInputRecord,
      dependencies,
    ).catch(() =>
      injectVisionPresence(
        activeGuestInput as GuestInputRecord,
        "empty",
        dependencies,
      ),
    );
    await waitForTraceEntry(
      readTrace,
      preconditionBoundary,
      (entry) =>
        entry?.type === "journey_transition" &&
        String(entry?.transitionId).endsWith(":departed"),
      dependencies,
      "initial sustained Vision departure",
      { timeoutMs: PRESENCE_PRECONDITION_TIMEOUT_MS },
    )
      .then((departure) => {
        presencePrecondition = {
          boundaryTraceId: preconditionBoundary,
          outcome: "existing_presence_departed",
          departureTransitionId: String(departure.entry.transitionId),
        };
      })
      .catch(() => null);
    await dependencies.sleep(SUSTAINED_EMPTY_MS);
    await waitForTouchscreenSessionIdle(
      readTrace,
      dependencies,
      "initial presence precondition",
    );
    await dependencies.setAudioPreferences(activeClient, {
      volume: 0.7,
      cuesEnabled: true,
      presenceCuesEnabled: true,
      transactionCuesEnabled: true,
    });
    await dependencies.issueAdminVentBaseline(activeGuestInput, dependencies);
    await dependencies.submitTemporaryVentStop(
      activeHandoff,
      `${operationId}:baseline-stop`,
      dependencies,
    );
    await returnToCatalogHome(activeClient, dependencies);
    const ventEvidenceBefore = await dependencies.controlPlaneRequest(
      activeGuestInput,
      `/v1/serial-sessions/${sessionId}/evidence`,
      { rawFrameLimit: 1024 },
    );
    const ventFrameCursor = serialEvidenceCursor(
      ventEvidenceBefore as JsonRecord | null,
    );
    let boundary = traceId(await readTrace());
    const initialFenceTraceId = boundary;
    const initialCapture = await startCueCapture("initial-welcome");
    await injectVisionPresence(activeGuestInput, "approach", dependencies);
    const initialWelcome = await waitForAudioLifecycle(
      readTrace,
      boundary,
      (entry) => String(entry.transitionId).endsWith(":welcome"),
      dependencies,
      "initial welcome",
      { requireTerminal: false },
    );
    await dependencies.sleep(WELCOME_CAPTURE_MS);
    await stopCueCapture(initialCapture, initialWelcome.transitionId);
    await waitForB3Sequence(
      activeGuestInput,
      sessionId,
      ventFrameCursor,
      [3],
      dependencies,
    );
    await dependencies.sleep(5_100);
    const adminOverride = await dependencies.issueAdminVentOverride(
      activeGuestInput,
      dependencies,
    );
    const afterAdminB3 = await waitForB3Sequence(
      activeGuestInput,
      sessionId,
      ventFrameCursor,
      [3, 2],
      dependencies,
    );
    const checkpoints = [
      {
        label: "stable-arrival-settled",
        traceId: initialWelcome.terminalTraceId,
      },
    ];
    const duplicateSameEdge =
      await dependencies.submitDuplicateStablePresenceAction(
        activeHandoff,
        stableEdgeId(initialWelcome.transitionId),
        dependencies,
      );
    const duplicateFenceTraceId = traceId(await readTrace());
    await injectVisionPresence(activeGuestInput, "approach", dependencies);
    await dependencies.sleep(1_500);
    runtimeTrace = await readTrace();
    if (
      traceEntryAfter(
        runtimeTrace,
        duplicateFenceTraceId,
        (entry) =>
          entry?.type === "audio_started" &&
          String(entry?.transitionId).endsWith(":welcome"),
      )
    ) {
      throw new Error("duplicate initial Vision approach replayed welcome");
    }
    checkpoints.push({
      label: "initial-duplicate-approach-settled",
      traceId: traceId(runtimeTrace),
    });
    const duplicateB3 = await dependencies.controlPlaneRequest(
      activeGuestInput,
      `/v1/serial-sessions/${sessionId}/evidence`,
      { rawFrameLimit: 1024 },
    );
    const duplicateB3Record = duplicateB3 as JsonRecord | null;
    const afterAdminB3Record = afterAdminB3 as JsonRecord;
    if (
      b3FramesSince(
        duplicateB3Record,
        serialEvidenceCursor(
          afterAdminB3Record.evidence as JsonRecord | null | undefined,
        ),
      ).length !== 0 ||
      b3FramesSince(duplicateB3Record, ventFrameCursor).length !== 2
    ) {
      throw new Error("duplicate stable edge emitted an unexpected B3 frame");
    }

    await injectVisionPresence(activeGuestInput, "empty", dependencies);
    await dependencies.sleep(SHORT_EMPTY_MS);
    const transientFenceTraceId = traceId(await readTrace());
    await injectVisionPresence(activeGuestInput, "approach", dependencies);
    await dependencies.sleep(500);
    runtimeTrace = await readTrace();
    if (
      traceEntryAfter(
        runtimeTrace,
        transientFenceTraceId,
        (entry) =>
          entry?.type === "audio_started" &&
          String(entry?.transitionId).endsWith(":welcome"),
      )
    )
      throw new Error("transient Vision empty rearmed welcome");
    checkpoints.push({
      label: "transient-empty-recovered",
      traceId: traceId(runtimeTrace),
    });

    boundary = traceId(runtimeTrace);
    await injectVisionPresence(activeGuestInput, "empty", dependencies);
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
    await waitForB3Sequence(
      activeGuestInput,
      sessionId,
      serialEvidenceCursor(
        afterAdminB3Record.evidence as JsonRecord | null | undefined,
      ),
      [0],
      dependencies,
    );
    boundary = traceId(departure.trace);
    const rearmedFenceTraceId = boundary;
    const rearmedCapture = await startCueCapture("rearmed-welcome");
    await injectVisionPresence(activeGuestInput, "approach", dependencies);
    const rearmedWelcome = await waitForAudioLifecycle(
      readTrace,
      boundary,
      (entry) => String(entry.transitionId).endsWith(":welcome"),
      dependencies,
      "rearmed welcome",
      { requireTerminal: false },
    );
    await dependencies.sleep(WELCOME_CAPTURE_MS);
    await stopCueCapture(rearmedCapture, rearmedWelcome.transitionId);
    checkpoints.push({
      label: "rearmed-arrival-settled",
      traceId: rearmedWelcome.terminalTraceId,
    });
    const rearmedB3 = await waitForB3Sequence(
      activeGuestInput,
      sessionId,
      ventFrameCursor,
      [3, 2, 0, 2],
      dependencies,
    );
    const presenceVent = presenceVentEvidence({
      frames: (rearmedB3 as JsonRecord).frames as unknown[],
      initialTransitionId: initialWelcome.transitionId,
      departureTransitionId: departure.entry.transitionId,
      rearmedTransitionId: rearmedWelcome.transitionId,
      operatorSetting: adminOverride as JsonRecord | null | undefined,
      duplicateSameEdge: duplicateSameEdge as JsonRecord | null | undefined,
    });

    const supportedCategoryKeys = await readSupportedCategoryKeys(
      activeClient,
      dependencies,
    );
    const categories = [];
    for (const expectedKey of supportedCategoryKeys) {
      boundary = traceId(await readTrace());
      const categoryCapture = await startCueCapture(`category-${expectedKey}`);
      await dependencies.activateVisibleSelector(
        activeClient,
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
        activeClient,
        '[data-test="catalog-product"]',
        { kind: "touch", timeoutMs: 30_000 },
      );
      await dependencies.waitForRoute(activeClient, /^#\/products\//, {
        timeoutMs: 30_000,
        pollMs: 250,
      });
      runtimeTrace = await readTrace();
      checkpoints.push({
        label: `category-${categoryKey}-detail`,
        traceId: traceId(runtimeTrace),
      });
      await dependencies.activateVisibleSelector(
        activeClient,
        '[data-test="product-buy"]',
        { kind: "touch", timeoutMs: 30_000 },
      );
      await dependencies.waitForRoute(activeClient, "#/checkout", {
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
      await dependencies.activateVisibleSelector(
        activeClient,
        ".checkout-back",
        {
          kind: "touch",
          timeoutMs: 30_000,
        },
      );
      await dependencies.waitForRoute(activeClient, /^#\/products\//, {
        timeoutMs: 30_000,
        pollMs: 250,
      });
      await dependencies.activateVisibleSelector(
        activeClient,
        ".detail-back-button",
        {
          kind: "touch",
          timeoutMs: 30_000,
        },
      );
      await dependencies.waitForRoute(activeClient, "#/catalog", {
        timeoutMs: 30_000,
        pollMs: 250,
      });
    }

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
          precondition: presencePrecondition,
          duplicateFenceTraceId,
          transientFenceTraceId,
          initialTransitionId: initialWelcome.transitionId,
          departureTransitionId: departure.entry.transitionId,
          rearmedFenceTraceId,
          rearmedTransitionId: rearmedWelcome.transitionId,
        },
        supportedCategoryKeys,
        categories,
      },
      presenceVent,
    };
    runtimeTrace = await readTrace();
    acceptance.runtimeTrace = runtimeTrace;
    validatePresenceAndAudioAcceptanceEvidence(acceptance);
    const screenshotPath = join(artifactRoot, "presence-and-audio-final.png");
    const screenshot = await dependencies.captureScreenshotArtifact(
      activeClient,
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
        runId: activeGuestInput.runId,
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
      directory: artifactRoot as string,
      audioCueCaptures: cueArtifactPaths,
      runtimeTrace: join(artifactRoot, "runtime-trace.json"),
      log: logPath,
      screenshot: {
        path: screenshotPath,
        ...(screenshot as JsonRecord),
      },
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
    const visionRecord = vision as JsonRecord | null;
    if (visionRecord?.started) {
      await shutdownControlledVisionMock(
        visionRecord.child as Parameters<
          typeof shutdownControlledVisionMock
        >[0],
      ).catch((error) => {
        report.cleanupError =
          error instanceof Error ? error.message : String(error);
      });
    }
    dependencies.writeJson(options.outPath, report);
  }
  return report;
}

export function validatePresenceAndAudioGuestReport(
  report: JsonRecord | null | undefined,
): JsonRecord {
  if (
    report?.schemaVersion !== "vem-presence-and-audio-guest-full/v1" ||
    report?.ok !== true
  ) {
    throw new Error("presence and audio guest runner did not pass");
  }
  if (
    (report?.boundaries as JsonRecord | undefined)?.visionMock !== true ||
    (report?.boundaries as JsonRecord | undefined)?.machineCdp !== true ||
    (report?.boundaries as JsonRecord | undefined)?.windowsAudioCapture !== true
  ) {
    throw new Error("presence and audio guest boundaries are incomplete");
  }
  for (const name of ["runtimeTrace"]) {
    required(
      (report?.artifacts as JsonRecord | undefined)?.[name],
      `presence and audio artifact ${name}`,
    );
  }
  const artifacts = report.artifacts as JsonRecord | undefined;
  const audioCueCaptures = (artifacts?.audioCueCaptures ?? []) as unknown[];
  if (
    audioCueCaptures.length === 0 ||
    audioCueCaptures.some(
      (capture) =>
        !(capture as JsonRecord)?.start || !(capture as JsonRecord)?.stop,
    )
  ) {
    throw new Error("presence and audio cue capture artifacts are incomplete");
  }
  const summary = validatePresenceAndAudioAcceptanceEvidence(
    recordValue(report.presenceAndAudio),
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
