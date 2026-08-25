#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { waitForDaemonReadyRefresh } from "./daemon-ready-refresh.ts";
import { restartInstalledDaemon } from "./local-operations-guest-full.ts";
import { replaceSerialSessionAndUpdateHandoff } from "./serial-session-handoff.ts";

const SCHEMA_VERSION = "vem-environment-control-guest-full/v2";
const ADMIN_USER = "local-testbed-admin";
const ADMIN_PASSWORD = "LocalTestbedAdminPassword!";
const HARDWARE_BINDING_READY_TIMEOUT_MS = 60_000;

type JsonRecord = Record<string, unknown>;
type GuestInputRecord = JsonRecord;
type HandoffRecord = JsonRecord;

function recordValue(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

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
    replacementControlPlaneSessionId: required(
      recordValue(replaced.replacement).sessionId,
      "replacement serial session id",
    ),
    aborted: recordValue(replaced.aborted).aborted ?? null,
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

export function serialProtocolFrames(
  evidence: JsonRecord | null | undefined,
  beforeFrameCount: JsonRecord | number,
  expectedOutboundOpcode: string | null = null,
): unknown[] {
  return serialFramesSince(evidence, beforeFrameCount)
    .filter((frame) => {
      const frameRecord = frame as JsonRecord;
      if (!frameRecord?.parsedOpcode) return false;
      return (
        expectedOutboundOpcode === null ||
        (frameRecord.direction === "daemon-to-controller" &&
          frameRecord.parsedOpcode === expectedOutboundOpcode)
      );
    })
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

function environmentControlHealth(
  health: JsonRecord | null | undefined,
): JsonRecord | null {
  const components = (health?.components ?? []) as unknown[];
  return (
    (components.find(
      (component) =>
        (component as JsonRecord)?.component === "environment_control",
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

export function environmentSerialEvidence(
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

async function waitForEnvironmentSnapshot(
  handoff: HandoffRecord,
  label: string,
  predicate: (snapshot: JsonRecord) => boolean,
  timeoutMs = 45_000,
): Promise<JsonRecord> {
  const deadline = Date.now() + timeoutMs;
  let last: JsonRecord | null = null;
  do {
    last = (await daemonGet(handoff, "/v1/environment-control").catch(
      () => null,
    )) as JsonRecord | null;
    if (last && predicate(last)) return last;
    await sleep(100);
  } while (Date.now() < deadline);
  throw new Error(
    `${label} did not reach the expected environment snapshot: ${JSON.stringify(last)}`,
  );
}

function snapshotRevision(snapshot: JsonRecord | null | undefined): number {
  const revision = snapshot?.revision;
  if (!Number.isInteger(revision) || Number(revision) < 0) {
    throw new Error(`environment snapshot revision is invalid: ${revision}`);
  }
  return Number(revision);
}

async function submitDaemonAction({
  handoff,
  actionId,
  source,
  action,
}: {
  handoff: HandoffRecord;
  actionId: string;
  source: "local_operator" | "stable_presence" | "automatic_policy";
  action: JsonRecord;
}): Promise<JsonRecord> {
  return (await daemonPost(handoff, "/v1/environment-control/actions", {
    actionId,
    source,
    action,
  })) as JsonRecord;
}

async function submitDaemonActionAndWait({
  handoff,
  actionId,
  source,
  action,
}: {
  handoff: HandoffRecord;
  actionId: string;
  source: "local_operator" | "stable_presence" | "automatic_policy";
  action: JsonRecord;
}): Promise<JsonRecord> {
  const admission = await submitDaemonAction({
    handoff,
    actionId,
    source,
    action,
  });
  if (admission.outcome !== "accepted") {
    throw new Error(
      `environment action ${actionId} was not newly accepted: ${JSON.stringify(admission)}`,
    );
  }
  const acceptedRevision = Number(admission.acceptedRevision);
  const snapshot = await waitForEnvironmentSnapshot(
    handoff,
    `environment action ${actionId}`,
    (candidate) =>
      snapshotRevision(candidate) === acceptedRevision &&
      candidate.convergence === "applied",
  );
  return { actionId, source, action, admission, snapshot };
}

async function submitDaemonActionWithFrame({
  guestInput,
  handoff,
  sessionId,
  actionId,
  source,
  action,
  expectedOpcode,
  expectedSpeed = null,
  expectedOutcome = "accepted",
}: {
  guestInput: GuestInputRecord;
  handoff: HandoffRecord;
  sessionId: string;
  actionId: string;
  source: "local_operator" | "stable_presence" | "automatic_policy";
  action: JsonRecord;
  expectedOpcode: string;
  expectedSpeed?: number | null;
  expectedOutcome?: "accepted" | "deduplicated";
}): Promise<JsonRecord> {
  const beforeEvidence = (await control(
    guestInput,
    `/v1/serial-sessions/${sessionId}/evidence`,
    {},
  )) as JsonRecord;
  const beforeCursor = serialEvidenceCursor(beforeEvidence);
  const admission = await submitDaemonAction({
    handoff,
    actionId,
    source,
    action,
  });
  if (admission.outcome !== expectedOutcome) {
    throw new Error(
      `environment action ${actionId} returned ${String(admission.outcome)} instead of ${expectedOutcome}`,
    );
  }
  if (expectedOutcome === "deduplicated") {
    await sleep(500);
    const evidence = (await control(
      guestInput,
      `/v1/serial-sessions/${sessionId}/evidence`,
      {},
    )) as JsonRecord;
    const protocolFrames = serialProtocolFrames(
      evidence,
      beforeCursor,
      expectedOpcode,
    );
    if (protocolFrames.length !== 0) {
      throw new Error(
        `deduplicated environment action emitted protocol frames: ${JSON.stringify(protocolFrames)}`,
      );
    }
    return {
      actionId,
      source,
      action,
      admission,
      snapshot: admission.snapshot,
      serial: {
        beforeFrameCursor: beforeCursor,
        protocolFrames,
        protocolFrame: null,
      },
    };
  }
  const { evidence, frame } = await waitForExpectedProtocolFrame({
    guestInput,
    sessionId,
    beforeFrameCount: beforeCursor,
    expectedOpcode,
    expectedSpeed,
  });
  const acceptedRevision = Number(admission.acceptedRevision);
  const snapshot = await waitForEnvironmentSnapshot(
    handoff,
    `environment action ${actionId}`,
    (candidate) =>
      snapshotRevision(candidate) === acceptedRevision &&
      candidate.convergence === "applied",
  );
  return {
    actionId,
    source,
    action,
    admission,
    snapshot,
    serial: {
      beforeFrameCursor: beforeCursor,
      protocolFrames: serialProtocolFrames(
        evidence as JsonRecord,
        beforeCursor,
      ),
      protocolFrame: frame,
    },
  };
}

async function commandEnvironment({
  guestInput,
  handoff,
  token,
  machineId,
  sessionId,
  action,
  body,
}: {
  guestInput: GuestInputRecord;
  handoff: HandoffRecord;
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
  const resultJson = result.resultJson as JsonRecord | undefined;
  if (
    result.status !== "succeeded" ||
    !["accepted", "deduplicated"].includes(String(resultJson?.outcome)) ||
    !Number.isInteger(resultJson?.acceptedRevision)
  ) {
    throw new Error(
      `remote environment action was not admitted: ${JSON.stringify(result)}`,
    );
  }
  const snapshot = await waitForEnvironmentSnapshot(
    handoff,
    `remote environment command ${String(admin.commandNo)}`,
    (candidate) =>
      snapshotRevision(candidate) === Number(resultJson?.acceptedRevision) &&
      candidate.convergence === "applied",
  );
  return {
    action,
    request: body,
    admin,
    result,
    snapshot,
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
      b3FrameCount: b3FramesSince(afterEvidence as JsonRecord, beforeCursor)
        .length,
    },
  };
}

async function startEnvironmentSerialSession(
  guestInput: GuestInputRecord,
  handoff: HandoffRecord,
  handoffPath: string,
): Promise<JsonRecord> {
  const replacement = (await control(guestInput, "/v1/serial-sessions/start", {
    runId: required(guestInput.runId, "runId"),
    machineCode: required(guestInput.machineCode, "machineCode"),
    saleCorrelationId: `sale-correlation://${required(guestInput.runId, "runId").toLowerCase()}.environment-reconnect-${Date.now()}`,
    targetIdentity: required(
      recordValue(guestInput.hostControlPlane).targetIdentity,
      "hostControlPlane.targetIdentity",
    ),
    runtimeBase: required(
      recordValue(guestInput.hostControlPlane).runtimeBaseIdentity,
      "hostControlPlane.runtimeBaseIdentity",
    ),
  })) as JsonRecord;
  required(replacement.sessionId, "replacement serial session id");
  handoff.commissioningSerialSession = replacement;
  writeJson(handoffPath, handoff);
  return replacement;
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
  const actionPrefix = `vm-env:${runId.replace(/[^A-Za-z0-9._:-]/g, "-").slice(-48)}`;
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
    baseline: null,
    axisIndependence: null,
    persistentZero: null,
    temporaryStopRestore: null,
    idempotency: null,
    explicitRetry: null,
    daemonRestart: null,
    lowerControllerReconnect: null,
    cleanup: null,
    daemon: { environmentControl: { health: null } },
    boundaries: {
      adminApi: false,
      mqtt: false,
      daemonIpc: false,
      lowerSerial: false,
      daemonRestart: false,
      lowerControllerReconnect: false,
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

    const baselineActions = [];
    for (const [label, action] of [
      ["baseline-ac-off", { type: "set_air_conditioner", enabled: false }],
      [
        "baseline-target-26",
        { type: "set_target_temperature", temperatureCelsius: 26 },
      ],
      ["baseline-base-3", { type: "set_base_vent_speed", ventSpeed: 3 }],
      ["baseline-stop", { type: "temporarily_stop_vent" }],
    ] as Array<[string, JsonRecord]>) {
      baselineActions.push(
        await submitDaemonActionAndWait({
          handoff,
          actionId: `${actionPrefix}:${label}`,
          source: "local_operator",
          action,
        }),
      );
    }
    const baselineSnapshot = await waitForEnvironmentSnapshot(
      handoff,
      "normalized environment baseline",
      (snapshot) => {
        const settings = recordValue(snapshot.settings);
        const desired = recordValue(snapshot.desired);
        return (
          settings.airConditionerEnabled === false &&
          settings.targetTemperatureCelsius === 26 &&
          settings.baseVentSpeed === 3 &&
          desired.ventSpeed === 0 &&
          snapshot.convergence === "applied"
        );
      },
    );
    report.baseline = { actions: baselineActions, snapshot: baselineSnapshot };

    const commands = report.commands as unknown[];
    for (const [action, body] of [
      ["airConditionerOnTrue", { airConditionerOn: true }],
      ["targetTemperatureCelsius", { targetTemperatureCelsius: 23 }],
      ["airConditionerOnFalse", { airConditionerOn: false }],
    ] as Array<[string, JsonRecord]>) {
      commands.push(
        await commandEnvironment({
          guestInput,
          handoff,
          token,
          machineId: String(machine.id),
          sessionId: String(activeSession.sessionId),
          action,
          body,
        }),
      );
    }
    const axisSnapshots = commands.map(
      (entry) => (entry as JsonRecord).snapshot as JsonRecord,
    );
    if (
      axisSnapshots.some((snapshot) => {
        const settings = recordValue(snapshot.settings);
        const desired = recordValue(snapshot.desired);
        return settings.baseVentSpeed !== 3 || desired.ventSpeed !== 0;
      })
    ) {
      throw new Error("AC or target-temperature action changed vent state");
    }
    report.axisIndependence = { snapshots: axisSnapshots };

    const restoreBeforeZero = await submitDaemonActionWithFrame({
      guestInput,
      handoff,
      sessionId: String(activeSession.sessionId),
      actionId: `${actionPrefix}:restore-before-zero`,
      source: "stable_presence",
      action: { type: "restore_base_vent_speed" },
      expectedOpcode: "B3",
      expectedSpeed: 3,
    });
    const persistentZeroCommand = await commandEnvironment({
      guestInput,
      handoff,
      token,
      machineId: String(machine.id),
      sessionId: String(activeSession.sessionId),
      action: "ventSpeed",
      body: { ventSpeed: 0 },
    });
    commands.push(persistentZeroCommand);
    const stopAtPersistentZero = await submitDaemonActionAndWait({
      handoff,
      actionId: `${actionPrefix}:stop-at-persistent-zero`,
      source: "stable_presence",
      action: { type: "temporarily_stop_vent" },
    });
    const restorePersistentZero = await submitDaemonActionAndWait({
      handoff,
      actionId: `${actionPrefix}:restore-persistent-zero`,
      source: "stable_presence",
      action: { type: "restore_base_vent_speed" },
    });
    const persistentZeroSnapshot = recordValue(restorePersistentZero.snapshot);
    if (
      recordValue(persistentZeroSnapshot.settings).baseVentSpeed !== 0 ||
      recordValue(persistentZeroSnapshot.desired).ventSpeed !== 0
    ) {
      throw new Error("persistent vent speed 0 was incorrectly restored");
    }
    report.persistentZero = {
      restoreBeforeZero,
      command: persistentZeroCommand,
      stop: stopAtPersistentZero,
      restore: restorePersistentZero,
    };

    const baseTwoCommand = await commandEnvironment({
      guestInput,
      handoff,
      token,
      machineId: String(machine.id),
      sessionId: String(activeSession.sessionId),
      action: "ventSpeed",
      body: { ventSpeed: 2 },
    });
    commands.push(baseTwoCommand);
    const stopBaseTwo = await submitDaemonActionWithFrame({
      guestInput,
      handoff,
      sessionId: String(activeSession.sessionId),
      actionId: `${actionPrefix}:stop-base-two`,
      source: "stable_presence",
      action: { type: "temporarily_stop_vent" },
      expectedOpcode: "B3",
      expectedSpeed: 0,
    });
    const restoreBaseTwo = await submitDaemonActionWithFrame({
      guestInput,
      handoff,
      sessionId: String(activeSession.sessionId),
      actionId: `${actionPrefix}:restore-base-two`,
      source: "stable_presence",
      action: { type: "restore_base_vent_speed" },
      expectedOpcode: "B3",
      expectedSpeed: 2,
    });
    report.temporaryStopRestore = {
      setBaseWhileUnoccupied: baseTwoCommand,
      stop: stopBaseTwo,
      restore: restoreBaseTwo,
    };

    const deduplicatedRestore = await submitDaemonActionWithFrame({
      guestInput,
      handoff,
      sessionId: String(activeSession.sessionId),
      actionId: `${actionPrefix}:restore-base-two`,
      source: "stable_presence",
      action: { type: "restore_base_vent_speed" },
      expectedOpcode: "B3",
      expectedSpeed: 2,
      expectedOutcome: "deduplicated",
    });
    if (
      Number(recordValue(deduplicatedRestore.admission).acceptedRevision) !==
      Number(recordValue(restoreBaseTwo.admission).acceptedRevision)
    ) {
      throw new Error("deduplicated environment action changed revision");
    }
    report.idempotency = {
      first: restoreBaseTwo,
      retry: deduplicatedRestore,
    };

    const retryCurrent = await submitDaemonActionWithFrame({
      guestInput,
      handoff,
      sessionId: String(activeSession.sessionId),
      actionId: `${actionPrefix}:explicit-retry`,
      source: "local_operator",
      action: { type: "retry_current_desired" },
      expectedOpcode: "B3",
      expectedSpeed: 2,
    });
    if (
      Number(recordValue(retryCurrent.admission).acceptedRevision) !==
      Number(recordValue(restoreBaseTwo.admission).acceptedRevision)
    ) {
      throw new Error("explicit retry incorrectly incremented revision");
    }
    report.explicitRetry = retryCurrent;

    const restartBeforeEvidence = (await control(
      guestInput,
      `/v1/serial-sessions/${String(activeSession.sessionId)}/evidence`,
      {},
    )) as JsonRecord;
    const restartCursor = serialEvidenceCursor(restartBeforeEvidence);
    const beforeRestart = await daemonGet(handoff, "/v1/environment-control");
    const restartedDaemon = await restartInstalledDaemon(
      handoff,
      options.handoffPath,
    );
    await waitForDaemonReadyRefresh(handoff);
    await waitForLowerControllerReady(
      handoff,
      HARDWARE_BINDING_READY_TIMEOUT_MS,
    );
    const restartFrame = await waitForExpectedProtocolFrame({
      guestInput,
      sessionId: String(activeSession.sessionId),
      beforeFrameCount: restartCursor,
      expectedOpcode: "B3",
      expectedSpeed: 2,
    });
    const afterRestart = await waitForEnvironmentSnapshot(
      handoff,
      "daemon restart replay",
      (snapshot) =>
        snapshotRevision(snapshot) ===
          snapshotRevision(beforeRestart as JsonRecord) &&
        recordValue(snapshot.settings).baseVentSpeed === 2 &&
        recordValue(snapshot.desired).ventSpeed === 2 &&
        recordValue(snapshot.confirmed).ventSpeed === 2 &&
        snapshot.convergence === "applied",
    );
    report.daemonRestart = {
      before: beforeRestart,
      daemon: restartedDaemon,
      after: afterRestart,
      frame: restartFrame.frame,
    };

    const disconnectedSessionId = String(activeSession.sessionId);
    const disconnected = await control(
      guestInput,
      `/v1/serial-sessions/${disconnectedSessionId}/abort`,
      {},
    );
    const offlineAdmission = await submitDaemonAction({
      handoff,
      actionId: `${actionPrefix}:offline-base-four`,
      source: "local_operator",
      action: { type: "set_base_vent_speed", ventSpeed: 4 },
    });
    if (offlineAdmission.outcome !== "accepted") {
      throw new Error(
        `offline environment action was not accepted: ${JSON.stringify(offlineAdmission)}`,
      );
    }
    const offlineSnapshot = await waitForEnvironmentSnapshot(
      handoff,
      "lower-controller offline persistence",
      (snapshot) =>
        snapshotRevision(snapshot) ===
          Number(offlineAdmission.acceptedRevision) &&
        recordValue(snapshot.settings).baseVentSpeed === 4 &&
        recordValue(snapshot.desired).ventSpeed === 4 &&
        snapshot.convergence === "offline",
    );
    const reconnectedSession = await startEnvironmentSerialSession(
      guestInput,
      handoff,
      options.handoffPath,
    );
    session = reconnectedSession;
    await waitForLowerControllerReady(
      handoff,
      HARDWARE_BINDING_READY_TIMEOUT_MS,
    );
    const reconnectFrame = await waitForExpectedProtocolFrame({
      guestInput,
      sessionId: String(reconnectedSession.sessionId),
      beforeFrameCount: 0,
      expectedOpcode: "B3",
      expectedSpeed: 4,
    });
    const reconnectedSnapshot = await waitForEnvironmentSnapshot(
      handoff,
      "lower-controller reconnect convergence",
      (snapshot) =>
        snapshotRevision(snapshot) ===
          Number(offlineAdmission.acceptedRevision) &&
        recordValue(snapshot.confirmed).ventSpeed === 4 &&
        snapshot.convergence === "applied",
    );
    report.lowerControllerReconnect = {
      disconnectedSessionId,
      disconnected,
      admission: offlineAdmission,
      offlineSnapshot,
      reconnectedSessionId: reconnectedSession.sessionId,
      frame: reconnectFrame.frame,
      snapshot: reconnectedSnapshot,
    };

    const cleanupActions = [];
    for (const [label, action] of [
      ["cleanup-ac-off", { type: "set_air_conditioner", enabled: false }],
      [
        "cleanup-target-26",
        { type: "set_target_temperature", temperatureCelsius: 26 },
      ],
      ["cleanup-base-3", { type: "set_base_vent_speed", ventSpeed: 3 }],
      ["cleanup-stop", { type: "temporarily_stop_vent" }],
    ] as Array<[string, JsonRecord]>) {
      cleanupActions.push(
        await submitDaemonActionAndWait({
          handoff,
          actionId: `${actionPrefix}:${label}`,
          source: "local_operator",
          action,
        }),
      );
    }
    const finalSnapshot = await daemonGet(handoff, "/v1/environment-control");
    report.cleanup = { actions: cleanupActions, snapshot: finalSnapshot };

    const health = await daemonGet(handoff, "/healthz");
    report.daemon = {
      health,
      readiness: await daemonGet(handoff, "/readyz"),
      environmentControl: {
        health: environmentControlHealth(health as JsonRecord | null),
        snapshot: finalSnapshot,
      },
    };
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
        )?.outcome === "accepted" &&
        Number.isInteger(
          (
            ((entry as JsonRecord).result as JsonRecord | undefined)
              ?.resultJson as JsonRecord | undefined
          )?.acceptedRevision,
        ),
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
    const persistentZero = report.persistentZero as JsonRecord;
    const stopRestore = report.temporaryStopRestore as JsonRecord;
    const idempotency = report.idempotency as JsonRecord;
    const retry = report.explicitRetry as JsonRecord;
    const restart = report.daemonRestart as JsonRecord;
    const reconnect = report.lowerControllerReconnect as JsonRecord;
    const final = finalSnapshot as JsonRecord;
    const persistentZeroRestoreSnapshot = recordValue(
      recordValue(persistentZero.restore).snapshot,
    );
    const stopBaseTwoSnapshot = recordValue(
      recordValue(stopRestore.stop).snapshot,
    );
    const restoreBaseTwoSnapshot = recordValue(
      recordValue(stopRestore.restore).snapshot,
    );
    (report.boundaries as JsonRecord).daemonIpc =
      (daemon.health as JsonRecord | undefined)?.hardwareOnline === true &&
      (daemon.readiness as JsonRecord | undefined)?.ready === true &&
      recordValue(persistentZeroRestoreSnapshot.settings).baseVentSpeed === 0 &&
      recordValue(persistentZeroRestoreSnapshot.desired).ventSpeed === 0 &&
      recordValue(stopBaseTwoSnapshot.settings).baseVentSpeed === 2 &&
      recordValue(stopBaseTwoSnapshot.desired).ventSpeed === 0 &&
      recordValue(restoreBaseTwoSnapshot.desired).ventSpeed === 2 &&
      recordValue(recordValue(idempotency.retry).admission).outcome ===
        "deduplicated" &&
      Number(
        recordValue(recordValue(idempotency.first).admission).acceptedRevision,
      ) ===
        Number(
          recordValue(recordValue(idempotency.retry).admission)
            .acceptedRevision,
        ) &&
      Number(recordValue(retry.admission).acceptedRevision) ===
        Number(
          recordValue(recordValue(idempotency.first).admission)
            .acceptedRevision,
        ) &&
      recordValue(final.settings).airConditionerEnabled === false &&
      recordValue(final.settings).targetTemperatureCelsius === 26 &&
      recordValue(final.settings).baseVentSpeed === 3 &&
      recordValue(final.desired).ventSpeed === 0 &&
      final.convergence === "applied";
    (report.boundaries as JsonRecord).daemonRestart =
      snapshotRevision(restart.before as JsonRecord) ===
        snapshotRevision(restart.after as JsonRecord) &&
      recordValue(recordValue(restart.after).settings).baseVentSpeed === 2 &&
      recordValue(recordValue(restart.after).desired).ventSpeed === 2 &&
      recordValue(recordValue(restart.after).confirmed).ventSpeed === 2 &&
      b3Speed(restart.frame as JsonRecord) === 2;
    (report.boundaries as JsonRecord).lowerControllerReconnect =
      recordValue(reconnect.admission).outcome === "accepted" &&
      recordValue(reconnect.offlineSnapshot).convergence === "offline" &&
      recordValue(recordValue(reconnect.offlineSnapshot).settings)
        .baseVentSpeed === 4 &&
      recordValue(reconnect.snapshot).convergence === "applied" &&
      recordValue(recordValue(reconnect.snapshot).confirmed).ventSpeed === 4 &&
      b3Speed(reconnect.frame as JsonRecord) === 4;
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
      environmentControl: {
        ...((report.daemon as JsonRecord).environmentControl as JsonRecord),
        health: environmentControlHealth(health as JsonRecord | null),
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
