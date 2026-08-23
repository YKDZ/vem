#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { waitForDaemonReadyRefresh } from "./daemon-ready-refresh.ts";
import { replaceSerialSessionAndUpdateHandoff } from "./serial-session-handoff.ts";

const SCHEMA_VERSION = "vem-environment-control-guest-full/v1";
const ADMIN_USER = "local-testbed-admin";
const ADMIN_PASSWORD = "LocalTestbedAdminPassword!";
const ADMIN_OVERRIDE_GUARD_MS = 5_000;
const HARDWARE_BINDING_READY_TIMEOUT_MS = 60_000;

type JsonRecord = Record<string, unknown>;
type GuestInputRecord = JsonRecord;
type HandoffRecord = JsonRecord;

function required(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${label} is required`);
  return value.trim();
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

function windowsAbsolute(value: unknown, label: string): string {
  const path = required(value, label);
  if (!/^[A-Za-z]:\\/.test(path) || path.includes("\0"))
    throw new Error(`${label} must be an absolute Windows path`);
  return path;
}

function localPath(path: string): string {
  return process.platform === "win32"
    ? path
    : resolve(
        `/mnt/${path[0].toLowerCase()}/${path.slice(3).replaceAll("\\", "/")}`,
      );
}

function readJson(path: string): JsonRecord {
  return JSON.parse(readFileSync(localPath(path), "utf8")) as JsonRecord;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(localPath(path)), { recursive: true });
  writeFileSync(localPath(path), `${JSON.stringify(value, null, 2)}\n`);
}

function parseArgs(args: string[]): {
  mode: "full";
  guestInputPath: string;
  handoffPath: string;
  outPath: string;
  fixtureKey: string | null;
} {
  if (required(option(args, "mode"), "--mode") !== "full")
    throw new Error("--mode must be full");
  return {
    mode: "full",
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
      AbortSignal.timeout(30_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(
      `${options.method ?? "GET"} ${url} failed with HTTP ${response.status}: ${JSON.stringify(payload)}`,
    );
    (error as Error & { httpStatus?: number; payload?: unknown }).httpStatus =
      response.status;
    (error as Error & { httpStatus?: number; payload?: unknown }).payload =
      payload;
    throw error;
  }
  return payload;
}

export function unwrapServiceApiEnvelope(payload: unknown): unknown {
  const record = payload as JsonRecord | null;
  if (
    record &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    record.code === 0 &&
    Object.hasOwn(record, "data")
  ) {
    return record.data;
  }
  return payload;
}

function apiBase(guestInput: GuestInputRecord): string {
  const bootstrap = guestInput.runtimeBootstrap as JsonRecord | undefined;
  return required(
    bootstrap?.provisioningApiBaseUrl,
    "runtimeBootstrap.provisioningApiBaseUrl",
  ).replace(/\/+$/, "");
}

function daemonBaseUrl(handoff: HandoffRecord): string {
  const daemon = handoff.daemon as JsonRecord | undefined;
  const ready = daemon?.ready as JsonRecord | undefined;
  const healthzUrl = required(ready?.healthzUrl, "daemon healthzUrl");
  if (!healthzUrl.endsWith("/healthz"))
    throw new Error("daemon healthzUrl must end with /healthz");
  return healthzUrl.slice(0, -"/healthz".length);
}

function daemonGet(handoff: HandoffRecord, path: string): Promise<unknown> {
  const daemon = handoff.daemon as JsonRecord | undefined;
  const ready = daemon?.ready as JsonRecord | undefined;
  return fetchJson(`${daemonBaseUrl(handoff)}${path}`, {
    headers: {
      authorization: `Bearer ${required(ready?.ipcToken, "daemon ipcToken")}`,
    },
  });
}

function daemonPost(
  handoff: HandoffRecord,
  path: string,
  body: JsonRecord = {},
): Promise<unknown> {
  const daemon = handoff.daemon as JsonRecord | undefined;
  const ready = daemon?.ready as JsonRecord | undefined;
  return fetchJson(`${daemonBaseUrl(handoff)}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${required(ready?.ipcToken, "daemon ipcToken")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function waitForLowerControllerReady(
  handoff: HandoffRecord,
  timeoutMs: number,
): Promise<JsonRecord> {
  const deadline = Date.now() + timeoutMs;
  let last: JsonRecord | null = null;
  while (Date.now() < deadline) {
    const [selfCheck, bindings] = await Promise.all([
      daemonPost(handoff, "/v1/hardware/self-check", {}).catch((error) => ({
        error: error instanceof Error ? error.message : String(error),
      })),
      daemonGet(handoff, "/v1/hardware-bindings").catch((error) => ({
        error: error instanceof Error ? error.message : String(error),
      })),
    ]);
    const bindingsRecord = bindings as JsonRecord | null;
    const roles = Array.isArray(bindingsRecord?.roles)
      ? (bindingsRecord.roles as unknown[])
      : [];
    const lower = roles.find(
      (role) => (role as JsonRecord)?.role === "lower_controller",
    ) as JsonRecord | undefined;
    last = { selfCheck, lower };
    if (
      (selfCheck as JsonRecord | null)?.online === true &&
      lower?.ready === true &&
      /^COM[1-9][0-9]*$/.test(String(lower.currentPort ?? ""))
    ) {
      return { selfCheck, bindings, lower };
    }
    await sleep(250);
  }
  throw new Error(
    `lower controller was not ready before environment commands: ${JSON.stringify(last)}`,
  );
}

function control(
  guestInput: GuestInputRecord,
  path: string,
  body: JsonRecord = {},
): Promise<unknown> {
  const hostControlPlane = guestInput.hostControlPlane as
    | JsonRecord
    | undefined;
  return fetchJson(
    `${required(hostControlPlane?.endpoint, "hostControlPlane.endpoint")}${path}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${required(hostControlPlane?.token, "hostControlPlane.token")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
}

export async function replaceEnvironmentSerialHandoff({
  guestInput,
  handoff,
  handoffPath,
  controlRequest = control,
}: {
  guestInput: GuestInputRecord;
  handoff: HandoffRecord;
  handoffPath: string;
  controlRequest?: (
    guestInput: GuestInputRecord,
    path: string,
    body?: JsonRecord,
  ) => Promise<unknown>;
}): Promise<JsonRecord> {
  const previousControlPlaneSessionId = required(
    (handoff?.commissioningSerialSession as JsonRecord | undefined)?.sessionId,
    "handoff commissioning serial session id",
  );
  const replaced = (await replaceSerialSessionAndUpdateHandoff({
    guestInput,
    handoff,
    handoffPath,
    sessionId: previousControlPlaneSessionId,
    control: controlRequest,
  })) as JsonRecord;
  return {
    previousControlPlaneSessionId,
    replacement: replaced.replacement,
  };
}

async function adminRequest(
  guestInput: GuestInputRecord,
  path: string,
  {
    token = null,
    method = "GET",
    body = null,
  }: { token?: string | null; method?: string; body?: unknown } = {},
): Promise<unknown> {
  const payload = await fetchJson(`${apiBase(guestInput)}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return unwrapServiceApiEnvelope(payload);
}

async function adminLogin(guestInput: GuestInputRecord): Promise<string> {
  const login = await adminRequest(guestInput, "/auth/login", {
    method: "POST",
    body: { username: ADMIN_USER, password: ADMIN_PASSWORD },
  });
  return required(
    (login as JsonRecord | undefined)?.accessToken,
    "admin accessToken",
  );
}

async function findMachine(
  guestInput: GuestInputRecord,
  token: string,
): Promise<JsonRecord> {
  const page = (await adminRequest(
    guestInput,
    "/machines?page=1&pageSize=100",
    { token },
  )) as JsonRecord | null;
  const items = (page?.items ?? []) as unknown[];
  const machine = items.find(
    (entry) =>
      (entry as JsonRecord)?.code ===
      required(guestInput.machineCode, "machineCode"),
  );
  if (!(machine as JsonRecord | undefined)?.id)
    throw new Error(`admin machine ${guestInput.machineCode} was not found`);
  return machine as JsonRecord;
}

async function waitForCommandResult(
  guestInput: GuestInputRecord,
  token: string,
  machineId: string,
  commandNo: string,
  timeoutMs = 45_000,
): Promise<JsonRecord> {
  const deadline = Date.now() + timeoutMs;
  let last: JsonRecord | null = null;
  while (Date.now() < deadline) {
    last = (await adminRequest(guestInput, `/machines/${machineId}`, {
      token,
    }).catch(() => null)) as JsonRecord | null;
    const command = last?.latestEnvironmentCommand as JsonRecord | undefined;
    if (
      command?.commandNo === commandNo &&
      ["succeeded", "failed", "timeout"].includes(String(command.status))
    ) {
      return command;
    }
    await sleep(250);
  }
  throw new Error(
    `environment command ${commandNo} did not reach terminal state: ${JSON.stringify(last?.latestEnvironmentCommand ?? null)}`,
  );
}

function mqttMessages(evidence: JsonRecord | null | undefined): unknown[] {
  const mqtt = evidence?.mqtt as JsonRecord | undefined;
  const machineMqtt = evidence?.machineMqtt as JsonRecord | undefined;
  return [
    ...((mqtt?.messages ?? []) as unknown[]),
    ...((machineMqtt?.messages ?? []) as unknown[]),
  ];
}

function mqttMessage(
  evidence: JsonRecord | null | undefined,
  commandNo: string,
  suffix: string,
): JsonRecord | null {
  return (
    (mqttMessages(evidence).find((entry) => {
      const topic = String((entry as JsonRecord)?.topic ?? "");
      const entryPayload = (entry as JsonRecord)?.payload as
        | JsonRecord
        | undefined;
      const payload = entryPayload?.payload ?? entryPayload;
      return (
        topic.includes("/environment-control") &&
        topic.includes(suffix) &&
        (payload as JsonRecord | undefined)?.commandNo === commandNo
      );
    }) as JsonRecord | undefined) ?? null
  );
}

function serialFrameCount(evidence: JsonRecord | null | undefined): number {
  return Array.isArray(evidence?.rawFrames)
    ? (evidence.rawFrames as unknown[]).length
    : 0;
}

function serialFrameSequence(frame: unknown): number | null {
  const frameRecord = frame as JsonRecord | undefined;
  if (
    Number.isInteger(frameRecord?.sequence) &&
    (frameRecord?.sequence as number) >= 0
  ) {
    return frameRecord?.sequence as number;
  }
  const match = /:(\d+)$/.exec(String(frameRecord?.boundaryId ?? ""));
  return match ? Number.parseInt(match[1], 10) : null;
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

function serialEvidenceCursor(
  evidence: JsonRecord | null | undefined,
): JsonRecord {
  const frames = Array.isArray(evidence?.rawFrames)
    ? (evidence.rawFrames as unknown[])
    : [];
  const lastFrame = frames.at(-1) ?? null;
  const lastFrameRecord = lastFrame as JsonRecord | null;
  return {
    frameCount: frames.length,
    lastSequence: serialFrameSequence(lastFrameRecord),
    lastCapturedAt: lastFrameRecord?.capturedAt ?? null,
    lastIdentity: serialFrameIdentity(lastFrameRecord),
  };
}

function serialTailIdentity(evidence: JsonRecord | null | undefined): string {
  const frames = Array.isArray(evidence?.rawFrames)
    ? (evidence.rawFrames as unknown[])
    : [];
  return frames
    .slice(-8)
    .map((frame) => {
      const frameRecord = frame as JsonRecord;
      return `${frameRecord.boundaryId ?? ""}:${frameRecord.rawFrameHex ?? ""}:${frameRecord.parsedOpcode ?? ""}`;
    })
    .join("|");
}

function serialProtocolFrames(
  evidence: JsonRecord | null | undefined,
  beforeFrameCount: JsonRecord | number,
): unknown[] {
  return serialFramesSince(evidence, beforeFrameCount)
    .filter((frame) => (frame as JsonRecord)?.parsedOpcode)
    .map((frame) => (frame as JsonRecord).parsedOpcode);
}

function b3Speed(frame: JsonRecord | null | undefined): number | null {
  const match = /^55b3(0[0-4])$/i.exec(String(frame?.rawFrameHex ?? ""));
  return match ? Number.parseInt(match[1], 16) : null;
}

export function isReplacementSessionB3(
  frame: JsonRecord | null | undefined,
  sessionId: string,
  speed: number,
): boolean {
  return (
    (frame?.sessionId === sessionId ||
      String(frame?.sessionId ?? "").startsWith("serial-session://")) &&
    frame?.parsedOpcode === "B3" &&
    b3Speed(frame) === speed
  );
}

function automaticVentHealth(
  health: JsonRecord | null | undefined,
): JsonRecord | null {
  const components = (health?.components ?? []) as unknown[];
  return (
    (components.find(
      (component) => (component as JsonRecord)?.component === "automatic_vent",
    ) as JsonRecord | undefined) ?? null
  );
}

export function serialFramesSince(
  evidence: JsonRecord | null | undefined,
  beforeFrameCount: JsonRecord | number,
): unknown[] {
  const frames = Array.isArray(evidence?.rawFrames)
    ? (evidence.rawFrames as unknown[])
    : [];
  const before = beforeFrameCount as JsonRecord;
  if (
    before &&
    typeof beforeFrameCount === "object" &&
    !Array.isArray(beforeFrameCount)
  ) {
    const lastSequence = Number.isInteger(before.lastSequence)
      ? (before.lastSequence as number)
      : null;
    if (lastSequence !== null) {
      const bySequence = frames.filter((frame) => {
        const sequence = serialFrameSequence(frame);
        return sequence !== null && sequence > lastSequence;
      });
      if (bySequence.length > 0) return bySequence;
      const lastIdentityIndex = frames.findIndex(
        (frame) => serialFrameIdentity(frame) === before.lastIdentity,
      );
      if (lastIdentityIndex >= 0) return frames.slice(lastIdentityIndex + 1);
      const lastCapturedAt = Date.parse(String(before.lastCapturedAt ?? ""));
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
        Number.isInteger(before.frameCount) &&
        frames.length <= (before.frameCount as number)
      ) {
        return [];
      }
    }
  }
  const frameCount =
    typeof beforeFrameCount === "number"
      ? beforeFrameCount
      : Number(beforeFrameCount?.frameCount);
  if (!Number.isInteger(frameCount) || frameCount < 0) {
    return frames.slice();
  }
  return frames.slice(frameCount > frames.length ? 0 : frameCount);
}

function b3FramesSince(
  evidence: JsonRecord | null | undefined,
  beforeFrameCount: JsonRecord | number,
): unknown[] {
  return serialFramesSince(evidence, beforeFrameCount)
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

export function automaticSerialEvidence(
  evidence: JsonRecord | null | undefined,
  beforeFrameCount: JsonRecord | number,
): JsonRecord {
  const b3Frames = b3FramesSince(evidence, beforeFrameCount);
  return {
    b3FrameCountDelta: b3Frames.length,
    protocolFrames: b3Frames.map((frame) => (frame as JsonRecord).parsedOpcode),
  };
}

export async function waitForExpectedProtocolFrame({
  guestInput,
  sessionId,
  beforeFrameCount,
  expectedOpcode,
  expectedSpeed = null,
  timeoutMs = 45_000,
  pollMs = 100,
  controlRequest = control,
}: {
  guestInput: GuestInputRecord;
  sessionId: string;
  beforeFrameCount: JsonRecord | number;
  expectedOpcode: string;
  expectedSpeed?: number | null;
  timeoutMs?: number;
  pollMs?: number;
  controlRequest?: (
    guestInput: GuestInputRecord,
    path: string,
    body?: JsonRecord,
  ) => Promise<unknown>;
}): Promise<JsonRecord> {
  const deadline = Date.now() + timeoutMs;
  let evidence: JsonRecord | null = null;
  do {
    evidence = (await controlRequest(
      guestInput,
      `/v1/serial-sessions/${sessionId}/evidence`,
      {},
    )) as JsonRecord;
    const frame = serialFramesSince(evidence, beforeFrameCount).find(
      (entry) =>
        (entry as JsonRecord)?.parsedOpcode === expectedOpcode &&
        (expectedOpcode !== "B3" ||
          !Number.isInteger(expectedSpeed) ||
          b3Speed(entry as JsonRecord) === expectedSpeed),
    );
    if (frame) return { evidence, frame };
    await sleep(pollMs);
  } while (Date.now() < deadline);
  const observed = serialFramesSince(evidence, beforeFrameCount).filter(
    (entry) => (entry as JsonRecord)?.parsedOpcode === expectedOpcode,
  );
  throw new Error(
    `${expectedOpcode}${Number.isInteger(expectedSpeed) ? `=${expectedSpeed}` : ""} was not observed: ${JSON.stringify(observed)}`,
  );
}

async function requestAutomaticVentIntent({
  guestInput,
  handoff,
  sessionId,
  edgeId,
  ventSpeed,
  expectedSpeed = ventSpeed,
}: {
  guestInput: GuestInputRecord;
  handoff: HandoffRecord;
  sessionId: string;
  edgeId: string;
  ventSpeed: number;
  expectedSpeed?: number;
}): Promise<JsonRecord> {
  const beforeEvidence = (await control(
    guestInput,
    `/v1/serial-sessions/${sessionId}/evidence`,
    {},
  )) as JsonRecord;
  const beforeCursor = serialEvidenceCursor(beforeEvidence);
  const response = (await daemonPost(handoff, "/v1/intents/automatic-vent", {
    edgeId,
    ventSpeed,
  })) as JsonRecord | null;
  if (response?.edgeId !== edgeId) {
    throw new Error(
      `automatic vent edge correlation is invalid: ${JSON.stringify(response)}`,
    );
  }
  if (response?.outcome !== "accepted") {
    const evidence = (await control(
      guestInput,
      `/v1/serial-sessions/${sessionId}/evidence`,
      {},
    )) as JsonRecord;
    return {
      edgeId,
      requestedSpeed: ventSpeed,
      outcome: response?.outcome,
      beforeFrameCount: beforeCursor.frameCount,
      ...automaticSerialEvidence(evidence as JsonRecord, beforeCursor),
    };
  }
  const { evidence, frame } = await waitForExpectedProtocolFrame({
    guestInput,
    sessionId,
    beforeFrameCount: beforeCursor,
    expectedOpcode: "B3",
    expectedSpeed,
  });
  return {
    edgeId,
    requestedSpeed: ventSpeed,
    expectedSpeed,
    outcome: response?.outcome,
    beforeFrameCount: beforeCursor.frameCount,
    frame,
    ...automaticSerialEvidence(evidence as JsonRecord, beforeCursor),
  };
}

async function observeAdminOverrideGuard({
  guestInput,
  sessionId,
  beforeFrameCount,
}: {
  guestInput: GuestInputRecord;
  sessionId: string;
  beforeFrameCount: JsonRecord | number;
}): Promise<JsonRecord> {
  const startedAt = Date.now();
  const deadline = startedAt + ADMIN_OVERRIDE_GUARD_MS;
  let evidence: JsonRecord | null = null;
  do {
    evidence = (await control(
      guestInput,
      `/v1/serial-sessions/${sessionId}/evidence`,
      {},
    )) as JsonRecord;
    const observation = automaticSerialEvidence(evidence, beforeFrameCount);
    const protocolFrames = (observation.protocolFrames as unknown[]) ?? [];
    if (protocolFrames.length > 0) {
      return {
        completed: false,
        durationMs: Date.now() - startedAt,
        ...observation,
      };
    }
    if (Date.now() >= deadline) {
      return {
        completed: true,
        durationMs: Date.now() - startedAt,
        ...observation,
      };
    }
    await sleep(100);
  } while (true);
}

async function commandEnvironment({
  guestInput,
  token,
  machineId,
  sessionId,
  action,
  body,
}: {
  guestInput: GuestInputRecord;
  token: string;
  machineId: string;
  sessionId: string;
  action: string;
  body: JsonRecord;
}): Promise<JsonRecord> {
  const beforeEvidence = (await control(
    guestInput,
    `/v1/serial-sessions/${sessionId}/evidence`,
    {},
  )) as JsonRecord;
  const beforeCursor = serialEvidenceCursor(beforeEvidence);
  const beforeTail = serialTailIdentity(beforeEvidence);
  const admin = (await adminRequest(
    guestInput,
    `/machines/${machineId}/commands/environment-control`,
    {
      token,
      method: "POST",
      body,
    },
  )) as JsonRecord;
  const result = await waitForCommandResult(
    guestInput,
    token,
    machineId,
    String(admin.commandNo),
  );
  const expectedOpcode =
    action === "airConditionerOnTrue" || action === "airConditionerOnFalse"
      ? "B2"
      : action === "ventSpeed"
        ? "B3"
        : "B1";
  const expectedSpeed =
    action === "ventSpeed" ? (body.ventSpeed as number) : null;
  const { evidence: afterEvidence, frame: protocolFrame } =
    await waitForExpectedProtocolFrame({
      guestInput,
      sessionId,
      beforeFrameCount: beforeCursor,
      expectedOpcode,
      expectedSpeed,
    });
  const commandMqtt = mqttMessage(
    afterEvidence as JsonRecord,
    String(admin.commandNo),
    "/commands/environment-control",
  );
  const resultMqtt = mqttMessage(
    afterEvidence as JsonRecord,
    String(admin.commandNo),
    "/events/environment-control-result",
  );
  const protocolFrames = serialProtocolFrames(
    afterEvidence as JsonRecord,
    beforeCursor,
  );
  const commandMqttPayload = commandMqtt?.payload as JsonRecord | undefined;
  const resultMqttPayload = resultMqtt?.payload as JsonRecord | undefined;
  return {
    action,
    request: body,
    admin,
    result,
    mqtt: {
      commandObserved: commandMqtt !== null,
      resultObserved: resultMqtt !== null,
      commandNo:
        (commandMqttPayload?.payload as JsonRecord | undefined)?.commandNo ??
        commandMqttPayload?.commandNo ??
        null,
      resultCommandNo:
        (resultMqttPayload?.payload as JsonRecord | undefined)?.commandNo ??
        resultMqttPayload?.commandNo ??
        null,
    },
    serial: {
      lowerBoundaryObserved:
        serialFrameCount(afterEvidence as JsonRecord) >
          (beforeCursor.frameCount as number) ||
        serialTailIdentity(afterEvidence as JsonRecord) !== beforeTail,
      beforeFrameCount: beforeCursor.frameCount as number,
      beforeFrameCursor: beforeCursor,
      afterFrameCount: serialFrameCount(afterEvidence as JsonRecord),
      protocolFrames,
      expectedOpcode,
      protocolFrame,
      protocolFrameObserved: protocolFrames.includes(expectedOpcode),
      automaticB3FrameCount: b3FramesSince(
        afterEvidence as JsonRecord,
        beforeCursor,
      ).length,
    },
  };
}

export async function collectAutomaticVentPrecedence({
  guestInput,
  handoff,
  token,
  machineId,
  sessionId,
  runId,
  report,
  commandEnvironmentRequest = commandEnvironment,
  requestAutomaticVentIntentRequest = requestAutomaticVentIntent,
  observeAdminOverrideGuardRequest = observeAdminOverrideGuard,
}: {
  guestInput: GuestInputRecord;
  handoff: HandoffRecord;
  token: string;
  machineId: string;
  sessionId: string;
  runId: string;
  report: JsonRecord;
  commandEnvironmentRequest?: typeof commandEnvironment;
  requestAutomaticVentIntentRequest?: typeof requestAutomaticVentIntent;
  observeAdminOverrideGuardRequest?: typeof observeAdminOverrideGuard;
}): Promise<JsonRecord> {
  const commands = (report.commands as unknown[]) ?? [];
  const daemon = report.daemon as JsonRecord;
  const automaticVent = daemon.automaticVent as JsonRecord;
  const outcomes = (automaticVent.outcomes as unknown[]) ?? [];
  const initialVentReset = await commandEnvironmentRequest({
    guestInput,
    token,
    machineId,
    sessionId,
    action: "ventSpeed",
    body: { ventSpeed: 0 },
  });
  commands.push(initialVentReset);
  const automaticArrival = await requestAutomaticVentIntentRequest({
    guestInput,
    handoff,
    sessionId,
    edgeId: `environment-control:${runId}:arrival`,
    ventSpeed: 3,
  });
  outcomes.push(automaticArrival);
  const adminVent = await commandEnvironmentRequest({
    guestInput,
    token,
    machineId,
    sessionId,
    action: "ventSpeed",
    body: { ventSpeed: 3 },
  });
  commands.push(adminVent);
  const sameEdgeAfterAdmin = await requestAutomaticVentIntentRequest({
    guestInput,
    handoff,
    sessionId,
    edgeId: String(automaticArrival.edgeId),
    ventSpeed: 3,
  });
  outcomes.push(sameEdgeAfterAdmin);
  const sameEdgeRecord = sameEdgeAfterAdmin as JsonRecord;
  sameEdgeRecord.guardWindow = await observeAdminOverrideGuardRequest({
    guestInput,
    sessionId,
    beforeFrameCount: sameEdgeAfterAdmin.beforeFrameCount as
      | JsonRecord
      | number,
  });
  const guardWindow = sameEdgeRecord.guardWindow as JsonRecord;
  if (guardWindow.completed !== true) {
    const { protocolFrames, b3FrameCountDelta } = guardWindow;
    const reason =
      (b3FrameCountDelta as number) > 0
        ? "delayed automatic B3 rebound"
        : "lower-controller activity";
    throw new Error(
      `Admin B3 override guard observed ${reason}: ${JSON.stringify(protocolFrames)}`,
    );
  }
  const nextStableEdge = await requestAutomaticVentIntentRequest({
    guestInput,
    handoff,
    sessionId,
    edgeId: `environment-control:${runId}:departure`,
    ventSpeed: 0,
  });
  outcomes.push(nextStableEdge);
  // 操作员风速挡位保持回归：Admin 设为 2 档后，后续每次来人都应打开 2 档，
  // 而不是回到固定 3 档；离开仍应关闭（0）。
  const operatorGearCommand = await commandEnvironmentRequest({
    guestInput,
    token,
    machineId,
    sessionId,
    action: "ventSpeed",
    body: { ventSpeed: 2 },
  });
  commands.push(operatorGearCommand);
  const departureAfterOperatorGear = await requestAutomaticVentIntentRequest({
    guestInput,
    handoff,
    sessionId,
    edgeId: `environment-control:${runId}:departure-after-gear`,
    ventSpeed: 0,
  });
  outcomes.push(departureAfterOperatorGear);
  const arrivalAfterOperatorGear = await requestAutomaticVentIntentRequest({
    guestInput,
    handoff,
    sessionId,
    edgeId: `environment-control:${runId}:arrival-after-gear`,
    ventSpeed: 3,
    expectedSpeed: 2,
  });
  outcomes.push(arrivalAfterOperatorGear);
  const secondDepartureAfterOperatorGear =
    await requestAutomaticVentIntentRequest({
      guestInput,
      handoff,
      sessionId,
      edgeId: `environment-control:${runId}:departure-after-gear-2`,
      ventSpeed: 0,
    });
  outcomes.push(secondDepartureAfterOperatorGear);
  const secondArrivalAfterOperatorGear =
    await requestAutomaticVentIntentRequest({
      guestInput,
      handoff,
      sessionId,
      edgeId: `environment-control:${runId}:arrival-after-gear-2`,
      ventSpeed: 3,
      expectedSpeed: 2,
    });
  outcomes.push(secondArrivalAfterOperatorGear);
  automaticVent.outcomes = outcomes;
  report.commands = commands;
  report.precedence = {
    initialVentReset,
    automaticArrival,
    adminB3: {
      commandNo: (adminVent.admin as JsonRecord).commandNo,
      resultStatus: (adminVent.result as JsonRecord).status,
      mqttCommandNo: (adminVent.mqtt as JsonRecord).commandNo,
      mqttResultNo: (adminVent.mqtt as JsonRecord).resultCommandNo,
      frame:
        ((adminVent.serial as JsonRecord).protocolFrame as unknown) ?? null,
    },
    sameEdgeAfterAdmin,
    nextStableEdge,
  };
  report.operatorGearPersistence = {
    operatorGearCommand,
    departureAfterOperatorGear,
    arrivalAfterOperatorGear,
    secondDepartureAfterOperatorGear,
    secondArrivalAfterOperatorGear,
  };
  return {
    initialVentReset,
    automaticArrival,
    adminVent,
    sameEdgeAfterAdmin,
    nextStableEdge,
    operatorGearPersistence: report.operatorGearPersistence,
  };
}

async function proveOverlapRejection({
  guestInput,
  token,
  machineId,
}: {
  guestInput: GuestInputRecord;
  token: string;
  machineId: string;
}): Promise<JsonRecord> {
  const first = adminRequest(
    guestInput,
    `/machines/${machineId}/commands/environment-control`,
    {
      token,
      method: "POST",
      body: { targetTemperatureCelsius: 22 },
    },
  );
  try {
    await adminRequest(
      guestInput,
      `/machines/${machineId}/commands/environment-control`,
      {
        token,
        method: "POST",
        body: { ventSpeed: 3 },
      },
    );
    return {
      rejected: false,
      httpStatus: null,
      error: null,
      first: await first,
    };
  } catch (error) {
    const err = error as Error & {
      httpStatus?: unknown;
      payload?: { message?: unknown; error?: unknown };
    };
    return {
      rejected: true,
      httpStatus: err.httpStatus ?? null,
      error: err.payload?.message ?? err.payload?.error ?? null,
      first: await first.catch((firstError) => ({
        error:
          firstError instanceof Error ? firstError.message : String(firstError),
      })),
    };
  }
}

export async function runEnvironmentControlGuest(options: {
  mode: "full";
  guestInputPath: string;
  handoffPath: string;
  outPath: string;
  fixtureKey: string | null;
}): Promise<JsonRecord> {
  const guestInput = readJson(options.guestInputPath);
  const handoff = readJson(options.handoffPath);
  const runId = required(guestInput.runId, "runId");
  const machineCode = required(guestInput.machineCode, "machineCode");
  let session: JsonRecord | null = null;
  const report: JsonRecord = {
    schemaVersion: SCHEMA_VERSION,
    ok: false,
    mode: options.mode,
    runId,
    machineCode,
    handoffSerialSessionId: null,
    serialSessionReplacement: null,
    commands: [],
    overlapRejection: null,
    daemon: { automaticVent: { health: null, outcomes: [] } },
    precedence: null,
    operatorGearPersistence: null,
    boundaries: {
      adminApi: false,
      mqtt: false,
      daemonIpc: false,
      lowerSerial: false,
    },
  };
  try {
    report.serialSessionReplacement = await replaceEnvironmentSerialHandoff({
      guestInput,
      handoff,
      handoffPath: options.handoffPath,
    });
    session = handoff.commissioningSerialSession as JsonRecord;
    const activeSession = session;
    report.handoffSerialSessionId = required(
      session?.sessionId,
      "environment control serial session id",
    );
    await waitForDaemonReadyRefresh(handoff);
    report.lowerControllerReady = await waitForLowerControllerReady(
      handoff,
      HARDWARE_BINDING_READY_TIMEOUT_MS,
    );
    const token = await adminLogin(guestInput);
    const machine = await findMachine(guestInput, token);

    report.overlapRejection = await proveOverlapRejection({
      guestInput,
      token,
      machineId: String(machine.id),
    });
    const overlapRejection = report.overlapRejection as JsonRecord;
    const overlapFirst = overlapRejection.first as JsonRecord | undefined;
    if (overlapFirst?.commandNo) {
      await waitForCommandResult(
        guestInput,
        token,
        String(machine.id),
        String(overlapFirst.commandNo),
      ).catch(() => null);
    }

    for (const step of [
      ["airConditionerOnTrue", { airConditionerOn: true }],
      ["airConditionerOnFalse", { airConditionerOn: false }],
    ] as Array<[string, JsonRecord]>) {
      (report.commands as unknown[]).push(
        await commandEnvironment({
          guestInput,
          token,
          machineId: String(machine.id),
          sessionId: String(activeSession.sessionId),
          action: step[0],
          body: step[1] as JsonRecord,
        }),
      );
    }
    const {
      initialVentReset,
      automaticArrival,
      adminVent,
      sameEdgeAfterAdmin,
      nextStableEdge,
    } = await collectAutomaticVentPrecedence({
      guestInput,
      handoff,
      token,
      machineId: String(machine.id),
      sessionId: String(activeSession.sessionId),
      runId,
      report,
    });
    (report.commands as unknown[]).push(
      await commandEnvironment({
        guestInput,
        token,
        machineId: String(machine.id),
        sessionId: String(activeSession.sessionId),
        action: "targetTemperatureCelsius",
        body: { targetTemperatureCelsius: 23 },
      }),
    );
    const health = await daemonGet(handoff, "/healthz");
    report.daemon = {
      ...(report.daemon as JsonRecord),
      health,
      readiness: await daemonGet(handoff, "/readyz"),
      automaticVent: {
        ...((report.daemon as JsonRecord).automaticVent as JsonRecord),
        health: automaticVentHealth(health as JsonRecord | null),
      },
    };
    const commands = report.commands as unknown[];
    const daemon = report.daemon as JsonRecord;
    (report.boundaries as JsonRecord).adminApi = commands.every(
      (entry) =>
        typeof ((entry as JsonRecord).admin as JsonRecord | undefined)
          ?.commandNo === "string" &&
        String(
          ((entry as JsonRecord).admin as JsonRecord | undefined)?.commandNo ??
            "",
        ) !== "" &&
        ((entry as JsonRecord).admin as JsonRecord | undefined)?.status ===
          "sent" &&
        ((entry as JsonRecord).result as JsonRecord | undefined)?.status ===
          "succeeded" &&
        (
          ((entry as JsonRecord).result as JsonRecord | undefined)
            ?.resultJson as JsonRecord | undefined
        )?.success === true,
    );
    (report.boundaries as JsonRecord).mqtt = commands.every(
      (entry) =>
        ((entry as JsonRecord).mqtt as JsonRecord | undefined)
          ?.commandObserved &&
        ((entry as JsonRecord).mqtt as JsonRecord | undefined)
          ?.resultObserved &&
        ((entry as JsonRecord).mqtt as JsonRecord | undefined)?.commandNo ===
          ((entry as JsonRecord).admin as JsonRecord | undefined)?.commandNo &&
        ((entry as JsonRecord).mqtt as JsonRecord | undefined)
          ?.resultCommandNo ===
          ((entry as JsonRecord).admin as JsonRecord | undefined)?.commandNo,
    );
    (report.boundaries as JsonRecord).lowerSerial = commands.every(
      (entry) =>
        ((entry as JsonRecord).serial as JsonRecord | undefined)
          ?.lowerBoundaryObserved &&
        ((entry as JsonRecord).serial as JsonRecord | undefined)
          ?.protocolFrameObserved &&
        ((entry as JsonRecord).result as JsonRecord | undefined)?.status ===
          "succeeded" &&
        (
          ((entry as JsonRecord).serial as JsonRecord | undefined)
            ?.protocolFrame as JsonRecord | undefined
        )?.parsedOpcode ===
          ((entry as JsonRecord).serial as JsonRecord | undefined)
            ?.expectedOpcode,
    );
    const replacement = report.serialSessionReplacement as JsonRecord;
    const replacementSessionId = String(
      replacement.replacementControlPlaneSessionId,
    );
    const automaticArrivalRecord = automaticArrival as JsonRecord;
    const initialVentResetRecord = initialVentReset as JsonRecord;
    const adminVentRecord = adminVent as JsonRecord;
    const sameEdgeAfterAdminRecord = sameEdgeAfterAdmin as JsonRecord;
    const nextStableEdgeRecord = nextStableEdge as JsonRecord;
    (report.boundaries as JsonRecord).daemonIpc =
      (daemon.health as JsonRecord | undefined)?.hardwareOnline === true &&
      (daemon.readiness as JsonRecord | undefined)?.ready === true &&
      automaticArrivalRecord.outcome === "accepted" &&
      automaticArrivalRecord.requestedSpeed === 3 &&
      isReplacementSessionB3(
        (initialVentResetRecord.serial as JsonRecord | undefined)
          ?.protocolFrame as JsonRecord | undefined,
        replacementSessionId,
        0,
      ) &&
      isReplacementSessionB3(
        automaticArrivalRecord.frame as JsonRecord | undefined,
        replacementSessionId,
        3,
      ) &&
      isReplacementSessionB3(
        (adminVentRecord.serial as JsonRecord | undefined)?.protocolFrame as
          | JsonRecord
          | undefined,
        replacementSessionId,
        3,
      ) &&
      sameEdgeAfterAdminRecord.edgeId === automaticArrivalRecord.edgeId &&
      sameEdgeAfterAdminRecord.outcome === "deduplicated" &&
      (sameEdgeAfterAdminRecord.b3FrameCountDelta as number) === 0 &&
      ((sameEdgeAfterAdminRecord.protocolFrames as unknown[]) ?? []).length ===
        0 &&
      (sameEdgeAfterAdminRecord.guardWindow as JsonRecord)?.completed ===
        true &&
      Number(
        (sameEdgeAfterAdminRecord.guardWindow as JsonRecord)?.durationMs,
      ) >= ADMIN_OVERRIDE_GUARD_MS &&
      (
        (sameEdgeAfterAdminRecord.guardWindow as JsonRecord)
          .protocolFrames as unknown[]
      ).length === 0 &&
      (sameEdgeAfterAdminRecord.guardWindow as JsonRecord).b3FrameCountDelta ===
        0 &&
      nextStableEdgeRecord.edgeId !== automaticArrivalRecord.edgeId &&
      nextStableEdgeRecord.outcome === "accepted" &&
      nextStableEdgeRecord.requestedSpeed === 0 &&
      isReplacementSessionB3(
        nextStableEdgeRecord.frame as JsonRecord | undefined,
        replacementSessionId,
        0,
      ) &&
      (automaticArrivalRecord.b3FrameCountDelta as number) === 1 &&
      ((automaticArrivalRecord.protocolFrames as unknown[]) ?? []).length ===
        1 &&
      (automaticArrivalRecord.protocolFrames as unknown[])[0] === "B3" &&
      (nextStableEdgeRecord.b3FrameCountDelta as number) === 1 &&
      ((nextStableEdgeRecord.protocolFrames as unknown[]) ?? []).length === 1 &&
      (nextStableEdgeRecord.protocolFrames as unknown[])[0] === "B3";
    report.ok = Object.values(report.boundaries as JsonRecord).every(Boolean);
    writeJson(options.outPath, report);
    return report;
  } catch (error) {
    const health = await daemonGet(handoff, "/healthz").catch(
      (healthError) => ({
        error:
          healthError instanceof Error
            ? healthError.message
            : String(healthError),
      }),
    );
    report.daemon = {
      ...(report.daemon as JsonRecord),
      health,
      automaticVent: {
        ...((report.daemon as JsonRecord).automaticVent as JsonRecord),
        health: automaticVentHealth(health as JsonRecord | null),
      },
    };
    report.error = {
      message: error instanceof Error ? error.message : String(error),
      stack: String((error as Error)?.stack ?? "").slice(0, 16 * 1024),
    };
    writeJson(options.outPath, report);
    throw error;
  } finally {
    if (session?.sessionId) {
      await control(
        guestInput,
        `/v1/serial-sessions/${session.sessionId}/abort`,
        {},
      ).catch(() => null);
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runEnvironmentControlGuest(parseArgs(process.argv.slice(2))).catch(
    (error) => {
      console.error(error instanceof Error ? error.stack : String(error));
      process.exitCode = 1;
    },
  );
}
