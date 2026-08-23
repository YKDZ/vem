#!/usr/bin/env node

import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { connect, createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

const STRICT_TAURI_HOST = "tauri.localhost";
const DEFAULT_REMOTE_CDP_PORT = 9222;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_ROUTE_POLL_MS = 100;
const TOUCH_PRESS_HOLD_MS = 40;
const MAX_URL_LENGTH = 2_048;
const MAX_LABEL_LENGTH = 160;
const MAX_SELECTOR_LENGTH = 512;
const MAX_TARGET_ID_LENGTH = 512;
const CANONICAL_CDP_TARGET_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,511}$/;
const MAX_REMOTE_OUTPUT_BYTES = 64 * 1024;
const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;
const MAX_SCENARIO_STEPS = 32;
const MAX_ROUTE_EVIDENCE_ENTRIES = 128;
const MAX_EVIDENCE_ENTRIES = 512;
const DEFAULT_CONTINUOUS_CAPTURE_INTERVAL_MS = 500;
const CONTINUOUS_CAPTURE_BUDGET_MS = 120_000 + 30_000;
const CONTINUOUS_CAPTURE_HEADROOM_CHECKPOINTS = 20;
const MAX_CONTINUOUS_CHECKPOINTS =
  Math.ceil(
    CONTINUOUS_CAPTURE_BUDGET_MS / DEFAULT_CONTINUOUS_CAPTURE_INTERVAL_MS,
  ) + CONTINUOUS_CAPTURE_HEADROOM_CHECKPOINTS;
const INITIAL_FORBIDDEN_CUSTOMER_ROUTES = ["/maintenance", "/offline"];
const PAYMENT_BARRIER_ALLOWED_ROUTES = ["/payment", "/dispensing", "/result"];
const PAYMENT_BARRIER_ARMING_ALLOWED_ROUTES = [
  "/checkout",
  ...PAYMENT_BARRIER_ALLOWED_ROUTES,
];
const PAYMENT_BARRIER_TERMINAL_ROUTES = ["/dispensing", "/result"];
const PAYMENT_BARRIER_COMPLETED_ALLOWED_ROUTES = [
  ...PAYMENT_BARRIER_ALLOWED_ROUTES,
  "/catalog",
];
const MAX_CDP_RUNTIME_RECOVERY_ATTEMPTS = 2;
const PRODUCTION_TUNNEL_OPTION_KEYS = new Set([
  "remote",
  "sshPort",
  "identityFile",
  "certificateFile",
  "sshKnownHostsPath",
  "sshHostKeyAlias",
  "sshArgs",
  "remoteCdpPort",
]);

interface SshRunOptions {
  remote?: string;
  sshPort?: number;
  identityFile?: string;
  certificateFile?: string;
  sshKnownHostsPath?: string;
  sshHostKeyAlias?: string;
  sshArgs?: string[];
  remoteCdpPort?: number;
  timeoutMs?: number;
  script?: string;
}

interface WindowsMachineUiInspectionOptions {
  remote?: string;
  sshPort?: number;
  identityFile?: string;
  certificateFile?: string;
  sshKnownHostsPath?: string;
  sshHostKeyAlias?: string;
  sshArgs?: string[];
  remoteCdpPort?: number;
  expectedMachinePath?: string;
  timeoutMs?: number;
}

type WindowsRuntimeCommandRunner = (
  options: SshRunOptions,
) => Promise<unknown>;

interface ProcessAdapter {
  spawn: typeof spawn;
  waitForExit?: (
    child: ChildProcess,
    timeoutMs: number,
  ) => Promise<unknown>;
  waitForReady?: (options: {
    child: ChildProcess;
    endpoint: string;
    host: string;
    port: number;
    timeoutMs: number;
    pollMs: number;
  }) => Promise<unknown>;
}

interface NormalizedWindowsProcessObservation {
  processId: number;
  sessionId: number;
  executablePath: string;
  principal: string;
}

interface NormalizedWindowsRuntimeObservation {
  machine: NormalizedWindowsProcessObservation;
  cdpListener: NormalizedWindowsProcessObservation & {
    machineAncestorProcessId: number;
    localAddress: string;
    localPort: number;
  };
}

export function isStrictTauriHashRouteUrl(value: unknown): boolean {
  try {
    const url = new URL(String(value));
    return (
      url.protocol === "http:" &&
      url.hostname === STRICT_TAURI_HOST &&
      url.port === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      normalizeMachineRoute(url.hash).startsWith("#/")
    );
  } catch {
    return false;
  }
}

export function matchesRoute(
  value: unknown,
  expected: string | RegExp | ((route: string) => boolean),
): boolean {
  const route = normalizeMachineRoute(value);
  if (typeof expected === "string") {
    return route === normalizeMachineRoute(expected);
  }
  if (expected instanceof RegExp) {
    expected.lastIndex = 0;
    return expected.test(route);
  }
  if (typeof expected === "function") return expected(route);
  throw new Error("expected route must be a string, RegExp, or predicate");
}

export function routeFromTauriUrl(value: unknown): string {
  const url = new URL(String(value));
  if (!isStrictTauriHashRouteUrl(url.toString())) {
    throw new Error(`not a strict tauri route URL: ${url}`);
  }
  return normalizeMachineRoute(url.hash);
}

export function normalizeMachineRoute(value: unknown): string {
  let raw = String(value ?? "").trim();
  if (raw.startsWith("http:") || raw.startsWith("https:")) {
    const url = new URL(raw);
    if (
      url.protocol !== "http:" ||
      url.hostname !== STRICT_TAURI_HOST ||
      url.port !== "" ||
      url.pathname !== "/" ||
      url.search !== ""
    ) {
      throw new Error(`not a strict tauri route URL: ${url}`);
    }
    raw = url.hash;
  }
  if (!raw.startsWith("#/")) {
    throw new Error(`invalid machine route: ${raw}`);
  }
  const parsed = new URL(raw.slice(1), "http://machine-route.invalid");
  if (parsed.origin !== "http://machine-route.invalid") {
    throw new Error(`invalid machine route: ${raw}`);
  }
  const decodedPath = decodeURIComponent(parsed.pathname).replaceAll("\\", "/");
  const segments = [];
  for (const segment of decodedPath.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0)
        throw new Error(`invalid machine route: ${raw}`);
      segments.pop();
      continue;
    }
    if (/\0/.test(segment)) throw new Error(`invalid machine route: ${raw}`);
    segments.push(segment.toLowerCase());
  }
  const query = new URLSearchParams(parsed.search);
  const entries = [...query.entries()].sort(
    ([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue),
  );
  const normalizedQuery = new URLSearchParams(entries).toString();
  const route = `#/${segments.join("/")}${normalizedQuery ? `?${normalizedQuery}` : ""}`;
  if (route.length > MAX_URL_LENGTH) {
    throw new Error("machine route exceeds maximum length");
  }
  return route;
}

interface ContinuousCaptureCheckpoint {
  ordinal?: number;
}

interface ContinuousCaptureSegment {
  stopped?: boolean;
  capture: { checkpoints: Array<{ ordinal?: number }> };
}

export function findContinuousPaymentCheckpoint({
  startSegment,
  endSegment,
  startCheckpoint,
  endCheckpoint,
}: {
  startSegment: ContinuousCaptureSegment | null | undefined;
  endSegment: ContinuousCaptureSegment | null | undefined;
  startCheckpoint: ContinuousCaptureCheckpoint | null | undefined;
  endCheckpoint: ContinuousCaptureCheckpoint | null | undefined;
}): ContinuousCaptureCheckpoint | null {
  if (
    startSegment == null ||
    startSegment !== endSegment ||
    startSegment.stopped ||
    startCheckpoint == null ||
    endCheckpoint == null
  ) {
    return null;
  }
  return (
    startSegment.capture.checkpoints.find(
      (checkpoint) =>
        (checkpoint.ordinal ?? 0) > (startCheckpoint.ordinal ?? 0) &&
        (checkpoint.ordinal ?? 0) < (endCheckpoint.ordinal ?? 0),
    ) ?? null
  );
}

export interface NormalizedExpectedRuntimeAttestation {
  targetId: string;
  machine: {
    processId: number;
    sessionId: number;
    executablePath: string;
    principal: string;
  };
}

export function validateExpectedRuntimeAttestation(
  attestation: unknown,
): NormalizedExpectedRuntimeAttestation {
  if (!attestation || typeof attestation !== "object") {
    throw new Error("expectedRuntimeAttestation is required");
  }
  const record = attestation as {
    targetId?: unknown;
    machine?: unknown;
  };
  if (
    typeof record.targetId !== "string" ||
    record.targetId.trim() === ""
  ) {
    throw new Error("expectedRuntimeAttestation.targetId is required");
  }
  if (!record.machine || typeof record.machine !== "object") {
    throw new Error("expectedRuntimeAttestation.machine is required");
  }
  const machine = record.machine as Record<string, unknown>;
  for (const field of ["processId", "sessionId"]) {
    const value = machine[field];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
      throw new Error(
        `expectedRuntimeAttestation.machine.${field} must be a positive integer`,
      );
    }
  }
  for (const field of ["executablePath", "principal"]) {
    const value = machine[field];
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(
        `expectedRuntimeAttestation.machine.${field} is required`,
      );
    }
  }
  return {
    targetId: boundedRequiredString(
      record.targetId,
      "expectedRuntimeAttestation.targetId",
      MAX_TARGET_ID_LENGTH,
    ),
    machine: {
      processId: machine.processId as number,
      sessionId: machine.sessionId as number,
      executablePath: normalizeWindowsPath(machine.executablePath as string),
      principal: normalizeWindowsPrincipal(machine.principal as string),
    },
  };
}

export function rewriteWebSocketDebuggerUrl(
  webSocketDebuggerUrl: unknown,
  forwardedEndpoint: unknown,
): string {
  const original = new URL(String(webSocketDebuggerUrl));
  const forwarded = normalizeEndpointUrl(forwardedEndpoint);
  if (original.protocol !== "ws:" && original.protocol !== "wss:") {
    throw new Error("debugger websocket URL must use ws or wss");
  }
  original.protocol = forwarded.protocol === "https:" ? "wss:" : "ws:";
  original.username = forwarded.username;
  original.password = forwarded.password;
  original.hostname = forwarded.hostname;
  original.port = forwarded.port;
  return original.toString();
}

function cdpTargetIdFromWebSocketUrl(webSocketUrl: unknown): string {
  let url: URL;
  try {
    url = new URL(String(webSocketUrl));
  } catch {
    throw new Error("CDP target webSocketDebuggerUrl is invalid");
  }
  const match = /^\/devtools\/page\/([^/]+)$/.exec(url.pathname);
  if (!match) {
    throw new Error(
      "CDP target webSocketDebuggerUrl pathname does not match target id",
    );
  }
  return boundedRequiredString(
    decodeURIComponent(match[1]),
    "CDP target id",
    MAX_TARGET_ID_LENGTH,
  );
}

export function assertTargetDebuggerWebSocketUrl(
  webSocketDebuggerUrl: unknown,
  targetId: unknown,
): URL {
  const id = boundedRequiredString(
    targetId,
    "CDP target id",
    MAX_TARGET_ID_LENGTH,
  );
  let url: URL;
  try {
    url = new URL(String(webSocketDebuggerUrl));
  } catch {
    throw new Error("CDP target webSocketDebuggerUrl is invalid");
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("CDP target webSocketDebuggerUrl must use ws or wss");
  }
  if (url.pathname !== `/devtools/page/${encodeURIComponent(id)}`) {
    throw new Error(
      "CDP target webSocketDebuggerUrl pathname does not match target id",
    );
  }
  return url;
}

export async function discoverMachineUiTarget({
  endpoint,
  expectedTargetId,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: {
  endpoint?: string;
  expectedTargetId?: string;
  fetchImpl?: typeof globalThis.fetch;
  timeoutMs?: number;
} = {}): Promise<Record<string, unknown>> {
  if (!endpoint) throw new Error("endpoint is required");
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");
  if (typeof expectedTargetId !== "string" || expectedTargetId.trim() === "") {
    throw new Error("expectedTargetId is required");
  }
  const jsonEndpoint = new URL("/json", normalizeEndpoint(endpoint));
  const deadline = Date.now() + timeoutMs;
  let response: Response;
  while (true) {
    try {
      response = await withTimeout(
        fetchImpl(jsonEndpoint),
        Math.max(1, deadline - Date.now()),
        "CDP target discovery",
      );
      break;
    } catch (error) {
      if (!(error instanceof TypeError) || Date.now() >= deadline) throw error;
      await sleep(Math.min(100, Math.max(1, deadline - Date.now())));
    }
  }
  if (!response.ok) {
    throw new Error(`CDP target discovery failed with HTTP ${response.status}`);
  }
  const targets = await withTimeout(
    response.json(),
    timeoutMs,
    "CDP target discovery JSON",
  );
  if (!Array.isArray(targets)) {
    throw new Error("CDP target discovery did not return a target array");
  }

  const targetRecords = targets as Array<Record<string, unknown>>;
  const candidates = targetRecords.filter((candidate) =>
    isStrictTauriHashRouteUrl(candidate.url),
  );
  if (candidates.length !== 1) {
    throw new Error(
      `CDP target discovery requires exactly one strict tauri target; found ${candidates.length}`,
    );
  }
  const target = candidates[0] ?? {};
  if (target.id !== expectedTargetId) {
    throw new Error(
      `CDP target binding is stale: expected ${expectedTargetId}, found ${String(target.id)}`,
    );
  }
  if (typeof target.webSocketDebuggerUrl !== "string") {
    throw new Error("CDP target is missing webSocketDebuggerUrl");
  }
  assertTargetDebuggerWebSocketUrl(target.webSocketDebuggerUrl, target.id);
  return {
    ...target,
    route: routeFromTauriUrl(target.url),
  };
}

export async function discoverCanonicalMachineUiTarget({
  endpoint,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: {
  endpoint?: string;
  fetchImpl?: typeof globalThis.fetch;
  timeoutMs?: number;
} = {}): Promise<Record<string, unknown>> {
  if (!endpoint) throw new Error("endpoint is required");
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");
  const jsonEndpoint = new URL("/json", normalizeEndpoint(endpoint));
  const response = await withTimeout(
    fetchImpl(jsonEndpoint),
    timeoutMs,
    "CDP target discovery",
  );
  if (!response.ok)
    throw new Error(`CDP target discovery failed with HTTP ${response.status}`);
  const targets = await withTimeout(
    response.json(),
    timeoutMs,
    "CDP target discovery JSON",
  );
  const candidates = Array.isArray(targets)
    ? (targets as Array<Record<string, unknown>>).filter((candidate) =>
        isStrictTauriHashRouteUrl(candidate.url),
      )
    : [];
  if (candidates.length !== 1)
    throw new Error(
      `CDP target discovery requires exactly one strict tauri target; found ${candidates.length}`,
    );
  const target = candidates[0] ?? {};
  if (typeof target.id !== "string" || !CANONICAL_CDP_TARGET_ID.test(target.id))
    throw new Error("CDP target identity is invalid");
  assertTargetDebuggerWebSocketUrl(target.webSocketDebuggerUrl, target.id);
  return { ...target, route: routeFromTauriUrl(target.url) };
}

export async function inspectWindowsMachineUiRuntime({
  remote,
  sshPort,
  identityFile,
  certificateFile,
  sshKnownHostsPath,
  sshHostKeyAlias,
  sshArgs = [],
  remoteCdpPort = DEFAULT_REMOTE_CDP_PORT,
  expectedMachinePath,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: WindowsMachineUiInspectionOptions = {}): Promise<unknown> {
  return inspectWindowsMachineUiRuntimeWithRunner(
    {
      remote,
      sshPort,
      identityFile,
      certificateFile,
      sshKnownHostsPath,
      sshHostKeyAlias,
      sshArgs,
      remoteCdpPort,
      expectedMachinePath,
      timeoutMs,
    },
    runWindowsPowerShellOverSsh,
  );
}

export async function inspectWindowsMachineUiRuntimeForTest(
  options: WindowsMachineUiInspectionOptions = {},
  { commandRunner = runWindowsPowerShellOverSsh }: {
    commandRunner?: WindowsRuntimeCommandRunner;
  } = {},
): Promise<unknown> {
  return inspectWindowsMachineUiRuntimeWithRunner(options, commandRunner);
}

async function inspectWindowsMachineUiRuntimeWithRunner(
  {
    remote,
    sshPort,
    identityFile,
    certificateFile,
    sshKnownHostsPath,
    sshHostKeyAlias,
    sshArgs = [],
    remoteCdpPort = DEFAULT_REMOTE_CDP_PORT,
    expectedMachinePath,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  }: WindowsMachineUiInspectionOptions = {},
  commandRunner: WindowsRuntimeCommandRunner,
): Promise<unknown> {
  if (typeof remote !== "string" || remote.trim() === "") {
    throw new Error("remote is required for Windows runtime inspection");
  }
  if (!Number.isSafeInteger(remoteCdpPort) || remoteCdpPort <= 0) {
    throw new Error("remoteCdpPort must be a positive integer");
  }
  const machinePath = normalizeWindowsPath(expectedMachinePath);
  if (typeof commandRunner !== "function") {
    throw new Error("Windows runtime commandRunner must be a function");
  }
  const raw = await commandRunner({
    remote: remote.trim(),
    sshPort,
    identityFile,
    certificateFile,
    sshKnownHostsPath,
    sshHostKeyAlias,
    sshArgs,
    timeoutMs,
    script: buildWindowsMachineUiInspectionScript({
      machinePath,
      remoteCdpPort,
    }),
  });
  return normalizeWindowsRuntimeObservation(raw, { remoteCdpPort });
}

export function bindMachineUiRuntimeEvidence({
  expectedRuntimeAttestation,
  observedRuntime,
  target,
}: {
  expectedRuntimeAttestation?: unknown;
  observedRuntime?: unknown;
  target?: { id?: unknown; url?: unknown };
} = {}): {
  expected: NormalizedExpectedRuntimeAttestation;
  observed: {
    machine: NormalizedWindowsProcessObservation;
    cdpListener: NormalizedWindowsRuntimeObservation["cdpListener"];
    cdpTarget: { id: string; url: string; route: string };
  };
} {
  const expected = validateExpectedRuntimeAttestation(
    expectedRuntimeAttestation,
  );
  const observed = normalizeWindowsRuntimeObservation(observedRuntime);
  if (!target || typeof target !== "object") {
    throw new Error("live CDP target is required");
  }
  const targetId = boundedRequiredString(
    target.id,
    "live CDP target id",
    MAX_TARGET_ID_LENGTH,
  );
  const targetUrl = boundedRequiredString(
    target.url,
    "live CDP target URL",
    MAX_URL_LENGTH,
  );
  const route = routeFromTauriUrl(targetUrl);
  const canonicalTargetUrl = new URL(targetUrl);
  canonicalTargetUrl.hash = route;
  const expectedMachine = expected.machine;
  const actualMachine = observed.machine;
  const machineFields: Array<
    [label: string, expected: string | number, actual: string | number]
  > = [
    ["processId", expectedMachine.processId, actualMachine.processId],
    ["sessionId", expectedMachine.sessionId, actualMachine.sessionId],
    ["executablePath", expectedMachine.executablePath, actualMachine.executablePath],
    ["principal", expectedMachine.principal, actualMachine.principal],
  ];
  for (const [label, expectedValue, actualValue] of machineFields) {
    if (actualValue !== expectedValue) {
      throw new Error(
        `Windows machine process ${label} mismatch: expected ${String(expectedValue)}, observed ${String(actualValue)}`,
      );
    }
  }
  if (targetId !== expected.targetId) {
    throw new Error(
      `CDP target id mismatch: expected ${expected.targetId}, observed ${targetId}`,
    );
  }
  if (
    observed.cdpListener.machineAncestorProcessId !== actualMachine.processId
  ) {
    throw new Error(
      "CDP listener is not descended from the observed machine process",
    );
  }
  if (observed.cdpListener.sessionId !== actualMachine.sessionId) {
    throw new Error(
      "CDP listener session does not match the observed machine process",
    );
  }
  if (observed.cdpListener.principal !== actualMachine.principal) {
    throw new Error(
      "CDP listener principal does not match the observed machine process",
    );
  }
  return {
    expected,
    observed: {
      machine: actualMachine,
      cdpListener: observed.cdpListener,
      cdpTarget: { id: targetId, url: canonicalTargetUrl.toString(), route },
    },
  };
}

export function buildWindowsMachineUiInspectionScript({
  machinePath,
  remoteCdpPort,
}: {
  machinePath?: string;
  remoteCdpPort?: number;
} = {}): string {
  const normalizedMachinePath = normalizeWindowsPath(machinePath);
  if (
    typeof remoteCdpPort !== "number" ||
    !Number.isSafeInteger(remoteCdpPort) ||
    remoteCdpPort <= 0
  ) {
    throw new Error("remoteCdpPort must be a positive integer");
  }
  const encodedMachinePath = Buffer.from(
    normalizedMachinePath,
    "utf8",
  ).toString("base64");
  return `
$ErrorActionPreference = 'Stop'
$machinePath = [System.IO.Path]::GetFullPath([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encodedMachinePath}')))
$machine = @(Get-CimInstance Win32_Process -Filter "Name = 'machine.exe'" | Where-Object {
  $_.ExecutablePath -and ([System.IO.Path]::GetFullPath($_.ExecutablePath) -ieq $machinePath)
})
if ($machine.Count -ne 1) { throw "machine_count:$($machine.Count)" }
$machineCim = $machine[0]
$machineProcess = Get-Process -Id ([int]$machineCim.ProcessId) -ErrorAction Stop
$machineOwner = Invoke-CimMethod -InputObject $machineCim -MethodName GetOwner -ErrorAction Stop
$machinePrincipal = "{0}\\{1}" -f [string]$machineOwner.Domain, [string]$machineOwner.User
if ([string]::IsNullOrWhiteSpace([string]$machineOwner.Domain) -or [string]::IsNullOrWhiteSpace([string]$machineOwner.User)) { throw 'machine_owner' }
$listeners = @(Get-NetTCPConnection -LocalPort ${remoteCdpPort} -State Listen -ErrorAction Stop | Where-Object {
  [string]$_.LocalAddress -ceq '127.0.0.1'
})
if ($listeners.Count -ne 1) { throw "listener_count:$($listeners.Count)" }
$listenerCim = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$listeners[0].OwningProcess)" -ErrorAction Stop
$listenerProcess = Get-Process -Id ([int]$listenerCim.ProcessId) -ErrorAction Stop
$listenerOwner = Invoke-CimMethod -InputObject $listenerCim -MethodName GetOwner -ErrorAction Stop
$listenerPrincipal = "{0}\\{1}" -f [string]$listenerOwner.Domain, [string]$listenerOwner.User
if ([string]::IsNullOrWhiteSpace([string]$listenerOwner.Domain) -or [string]::IsNullOrWhiteSpace([string]$listenerOwner.User)) { throw 'listener_owner' }
$cursor = $listenerCim
$ancestor = $null
for ($depth = 0; $depth -lt 32 -and $null -ne $cursor; $depth += 1) {
  if ([int]$cursor.ProcessId -eq [int]$machineCim.ProcessId) { $ancestor = [int]$machineCim.ProcessId; break }
  $parentId = [int]$cursor.ParentProcessId
  if ($parentId -le 0 -or $parentId -eq [int]$cursor.ProcessId) { break }
  $cursor = Get-CimInstance Win32_Process -Filter "ProcessId = $parentId" -ErrorAction SilentlyContinue
}
if ($null -eq $ancestor) { throw 'listener_ancestor' }
if ([int]$listenerProcess.SessionId -ne [int]$machineProcess.SessionId) { throw 'listener_session' }
if ($listenerPrincipal -cne $machinePrincipal) { throw 'listener_principal' }
[Console]::Out.WriteLine(([ordered]@{
  machine = [ordered]@{
    processId = [int]$machineProcess.Id
    executablePath = [System.IO.Path]::GetFullPath($machineCim.ExecutablePath)
    sessionId = [int]$machineProcess.SessionId
    principal = $machinePrincipal
  }
  cdpListener = [ordered]@{
    processId = [int]$listenerProcess.Id
    executablePath = [System.IO.Path]::GetFullPath($listenerCim.ExecutablePath)
    sessionId = [int]$listenerProcess.SessionId
    principal = $listenerPrincipal
    machineAncestorProcessId = $ancestor
    localAddress = [string]$listeners[0].LocalAddress
    localPort = [int]$listeners[0].LocalPort
  }
} | ConvertTo-Json -Compress -Depth 4))
`.trim();
}

export async function openMachineUiCdpSidecar({
  endpoint,
  remote,
  sshPort,
  identityFile,
  certificateFile,
  sshKnownHostsPath,
  sshHostKeyAlias,
  sshArgs = [],
  localHost = "127.0.0.1",
  localPort,
  remoteCdpHost,
  remoteCdpPort = DEFAULT_REMOTE_CDP_PORT,
  startupTimeoutMs = DEFAULT_TIMEOUT_MS,
  startupPollMs = 25,
  shutdownTimeoutMs = 1_000,
  processAdapter = defaultProcessAdapter,
}: {
  endpoint?: string;
  remote?: string;
  sshPort?: number;
  identityFile?: string;
  certificateFile?: string;
  sshKnownHostsPath?: string;
  sshHostKeyAlias?: string;
  sshArgs?: string[];
  localHost?: string;
  localPort?: number;
  remoteCdpHost?: string;
  remoteCdpPort?: number;
  startupTimeoutMs?: number;
  startupPollMs?: number;
  shutdownTimeoutMs?: number;
  processAdapter?: ProcessAdapter;
} = {}): Promise<{
  endpoint: string;
  process: ChildProcess | null;
  close: () => Promise<void>;
}> {
  if (endpoint) {
    return {
      endpoint: normalizeEndpoint(endpoint),
      process: null,
      async close() {},
    };
  }
  if (!remote) throw new Error("remote is required when endpoint is omitted");
  if (!Number.isSafeInteger(remoteCdpPort) || remoteCdpPort <= 0) {
    throw new Error("remoteCdpPort must be a positive integer");
  }
  if (remoteCdpHost != null && remoteCdpHost !== "127.0.0.1") {
    throw new Error("remote CDP tunnel host must be inspected loopback");
  }
  if (localHost !== "127.0.0.1" && localHost !== "::1") {
    throw new Error("local CDP tunnel host must be loopback");
  }

  const selectedLocalPort =
    localPort ?? (await findAvailableLocalPort(localHost));
  const tunnelSpec = `${formatSshHost(localHost)}:${selectedLocalPort}:127.0.0.1:${remoteCdpPort}`;
  const args = [
    "-N",
    "-o",
    "ExitOnForwardFailure=yes",
    "-L",
    tunnelSpec,
    ...(sshPort ? ["-p", String(sshPort)] : []),
    ...(identityFile ? ["-i", identityFile] : []),
    ...(certificateFile ? ["-o", `CertificateFile=${certificateFile}`] : []),
    ...(sshKnownHostsPath
      ? ["-o", `UserKnownHostsFile=${sshKnownHostsPath}`]
      : []),
    ...(sshHostKeyAlias ? ["-o", `HostKeyAlias=${sshHostKeyAlias}`] : []),
    ...sshArgs,
    remote,
  ];
  let child: ChildProcess;
  try {
    child = processAdapter.spawn("ssh", args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (error) {
    throw new Error(`SSH tunnel spawn failed: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  if (!child || typeof child.once !== "function") {
    throw new Error("SSH process adapter returned an invalid child process");
  }

  let stderr = "";
  child.stderr?.on?.("data", (chunk) => {
    stderr = `${stderr}${String(chunk)}`.slice(-4_096);
  });
  child.stderr?.resume?.();
  const endpointUrl = `http://${formatUrlHost(localHost)}:${selectedLocalPort}`;
  const startup = watchChildStartup(child, () => stderr);
  try {
    await Promise.race([
      processAdapter.waitForReady
        ? processAdapter.waitForReady({
            child,
            endpoint: endpointUrl,
            host: localHost,
            port: selectedLocalPort,
            timeoutMs: startupTimeoutMs,
            pollMs: startupPollMs,
          })
        : waitForTcpEndpoint({
            host: localHost,
            port: selectedLocalPort,
            timeoutMs: startupTimeoutMs,
            pollMs: startupPollMs,
          }),
      startup.failure,
    ]);
  } catch (error) {
    startup.stop();
    await terminateChildProcess(child, processAdapter, shutdownTimeoutMs).catch(
      () => {},
    );
    throw error;
  }
  startup.stop();

  let closed = false;
  return {
    endpoint: endpointUrl,
    process: child,
    async close() {
      if (closed) return;
      closed = true;
      await terminateChildProcess(child, processAdapter, shutdownTimeoutMs);
    },
  };
}

interface BrowserSocket {
  addEventListener(
    type: string,
    handler: (event: unknown) => void,
    options?: { once?: boolean },
  ): void;
  removeEventListener(type: string, handler: (event: unknown) => void): void;
  send(data: string): void;
  close(): void;
  readyState: number;
}

type WebSocketFactory = (url: string) => BrowserSocket;

interface CdpClientOptions {
  webSocketFactory?: WebSocketFactory;
  defaultTimeoutMs?: number;
}

interface PendingCdpRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

type CdpEventHandler = (params: unknown) => void;

interface CdpRuntimeClient {
  closed?: boolean;
  send: (
    method: string,
    params?: unknown,
    options?: { timeoutMs?: number },
  ) => Promise<unknown>;
}

interface EvaluateOptions {
  timeoutMs?: number;
  returnByValue?: boolean;
}

interface ScreenshotOptions {
  format?: "png" | "jpeg";
  maxBytes?: number;
  fromSurface?: boolean;
  captureBeyondViewport?: boolean;
  timeoutMs?: number;
  validatePng?: boolean;
  expectedDimensions?: { width: number; height: number };
  screenshotSink?: (input: {
    bytes: Uint8Array;
    sha256: string;
    format: string;
    label: string;
  }) => Promise<string | { ref?: string }> | string | { ref?: string };
  label?: string;
  clock?: () => Date;
}

export class CdpClient {
  readonly webSocketUrl: string;
  readonly webSocketFactory: WebSocketFactory;
  readonly defaultTimeoutMs: number;
  nextId = 1;
  pending = new Map<number, PendingCdpRequest>();
  eventHandlers = new Map<string, CdpEventHandler[]>();
  closed = false;
  socket: BrowserSocket | null = null;
  targetId: string;
  connectionSessionId: string | null = null;
  connectedAt: string | null = null;

  constructor(webSocketUrl: unknown, options: CdpClientOptions = {}) {
    const url = new URL(String(webSocketUrl));
    if (url.protocol !== "ws:" && url.protocol !== "wss:") {
      throw new Error("CDP WebSocket URL must use ws or wss");
    }
    this.webSocketUrl = url.toString();
    this.webSocketFactory =
      options.webSocketFactory ??
      ((value) => {
        if (typeof WebSocket !== "function") {
          throw new Error("WebSocket is unavailable");
        }
        return new WebSocket(value);
      });
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.nextId = 1;
    this.pending = new Map();
    this.eventHandlers = new Map();
    this.closed = false;
    this.socket = null;
    this.targetId = cdpTargetIdFromWebSocketUrl(this.webSocketUrl);
    this.connectionSessionId = null;
    this.connectedAt = null;
  }

  async connect({ timeoutMs = this.defaultTimeoutMs }: { timeoutMs?: number } = {}): Promise<this> {
    if (this.socket) return this;
    let socket: BrowserSocket;
    try {
      socket = this.webSocketFactory(this.webSocketUrl);
    } catch (error) {
      throw new Error(
        `CDP WebSocket creation failed: ${boundedString(errorMessage(error), 512)}`,
        {
          cause: error,
        },
      );
    }
    requireBrowserWebSocket(socket);
    this.socket = socket;
    socket.addEventListener("message", (event) => this.#handleMessage(event));
    socket.addEventListener("close", () => this.#handleClose());
    socket.addEventListener("error", (event) => this.#handleError(event));
    if (socket.readyState === 1) {
      return this;
    }
    try {
      await waitForSocketEvent(socket, "open", {
        timeoutMs,
        errorLabel: "CDP WebSocket failed to open",
      });
    } catch (error) {
      await this.close({ timeoutMs }).catch(() => {});
      throw error;
    }
    if (this.connectionSessionId === null) {
      this.connectionSessionId = `cdp-connection:${randomUUID()}`;
    }
    if (this.connectedAt === null) {
      this.connectedAt = new Date().toISOString();
    }
    return this;
  }

  async observeIdentity(): Promise<{
    targetId: string;
    sessionId: string;
    connectedAt: string;
  }> {
    if (!this.socket || this.closed || this.socket.readyState !== 1) {
      throw new Error("CDP client is closed");
    }
    return observeConnectedCdpIdentity(this);
  }

  async send(
    method: string,
    params: unknown = {},
    { timeoutMs = this.defaultTimeoutMs }: { timeoutMs?: number } = {},
  ): Promise<unknown> {
    if (!this.socket || this.closed || this.socket.readyState !== 1) {
      throw new Error("CDP client is closed");
    }
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    let resolveResponse!: (value: unknown) => void;
    let rejectResponse!: (error: Error) => void;
    const response = new Promise<unknown>((resolve, reject) => {
      resolveResponse = resolve;
      rejectResponse = reject;
    });
    const timer = setTimeout(() => {
      if (!this.pending.delete(id)) return;
      rejectResponse(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    this.pending.set(id, {
      method,
      resolve: resolveResponse,
      reject: rejectResponse,
      timer,
    });
    try {
      this.socket.send(payload);
    } catch (error) {
      clearTimeout(timer);
      this.pending.delete(id);
      throw new Error(`CDP ${method} send failed: ${errorMessage(error)}`, {
        cause: error,
      });
    }
    return response;
  }

  on(method: string, handler: CdpEventHandler): () => void {
    const handlers = this.eventHandlers.get(method) ?? [];
    handlers.push(handler);
    this.eventHandlers.set(method, handlers);
    return () => {
      const handlers = this.eventHandlers.get(method) ?? [];
      this.eventHandlers.set(
        method,
        handlers.filter((candidate) => candidate !== handler),
      );
    };
  }

  async waitForEvent(
    method: string,
    predicate: (params: unknown) => boolean = () => true,
    { timeoutMs = this.defaultTimeoutMs }: { timeoutMs?: number } = {},
  ): Promise<unknown> {
    let off: (() => void) | undefined;
    return withTimeout(
      new Promise<unknown>((resolve) => {
        off = this.on(method, (params) => {
          if (predicate(params)) resolve(params);
        });
      }).finally(() => off?.()),
      timeoutMs,
      `CDP event ${method}`,
      () => off?.(),
    );
  }

  async close({ timeoutMs = this.defaultTimeoutMs }: { timeoutMs?: number } = {}): Promise<void> {
    if (this.closed && this.socket?.readyState === 3) return;
    this.closed = true;
    this.#rejectPending(new Error("CDP client closed"));
    const socket = this.socket;
    if (!socket || socket.readyState === 3) return;
    const closed = waitForSocketEvent(socket, "close", {
      timeoutMs,
      listenForError: false,
    });
    if (socket.readyState === 0 || socket.readyState === 1) socket.close();
    await closed;
  }

  #handleMessage(event: unknown): void {
    let message: Record<string, unknown>;
    try {
      const data = (event as { data?: unknown } | null | undefined)?.data;
      if (typeof data !== "string") {
        throw new Error("browser WebSocket message data must be a string");
      }
      message = JSON.parse(data) as Record<string, unknown>;
    } catch (error) {
      this.#handleError(error);
      return;
    }

    if (message.id != null) {
      const messageId = message.id as number;
      const pending = this.pending.get(messageId);
      if (!pending) return;
      this.pending.delete(messageId);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(
          new Error(
            `CDP ${pending.method} failed: ${(message.error as { message?: string } | undefined)?.message ?? "error"}`,
          ),
        );
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }

    if (message.method) {
      for (const handler of this.eventHandlers.get(String(message.method)) ?? []) {
        try {
          handler(message.params ?? {});
        } catch (error) {
          this.#handleError(error);
        }
      }
    }
  }

  #handleClose(): void {
    this.closed = true;
    this.#rejectPending(new Error("CDP connection closed"));
  }

  #handleError(event: unknown): void {
    const error =
      event instanceof Error
        ? event
        : new Error(
            (event as { message?: string } | null | undefined)?.message ??
              "CDP WebSocket error",
          );
    this.#rejectPending(error);
    if (!this.closed) {
      this.closed = true;
      if (this.socket?.readyState === 0 || this.socket?.readyState === 1) {
        this.socket.close();
      }
    }
  }

  #rejectPending(error: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(
        new Error(`${error.message} before ${pending.method}`, {
          cause: error,
        }),
      );
      this.pending.delete(id);
    }
  }
}

export function observeConnectedCdpIdentity(client: unknown): {
  targetId: string;
  sessionId: string;
  connectedAt: string;
} {
  if (!client || typeof client !== "object") {
    throw new Error("connected production CDP client is required");
  }
  const record = client as Record<string, unknown> & {
    targetId?: unknown;
    webSocketUrl?: unknown;
    connectionSessionId?: unknown;
    connectedAt?: unknown;
  };
  const targetId =
    typeof record.targetId === "string" && record.targetId.trim() !== ""
      ? boundedRequiredString(
          record.targetId,
          "CDP target id",
          MAX_TARGET_ID_LENGTH,
        )
      : cdpTargetIdFromWebSocketUrl(record.webSocketUrl);
  const sessionId =
    typeof record.connectionSessionId === "string" &&
    record.connectionSessionId.trim() !== ""
      ? record.connectionSessionId
      : `cdp-connection:${randomUUID()}`;
  const connectedAt =
    typeof record.connectedAt === "string" &&
    Number.isFinite(Date.parse(record.connectedAt))
      ? record.connectedAt
      : new Date().toISOString();
  record.targetId = targetId;
  record.connectionSessionId = sessionId;
  record.connectedAt = connectedAt;
  return {
    targetId,
    sessionId,
    connectedAt,
  };
}

export async function enablePageRuntime(client: {
  send: (method: string, params?: unknown) => Promise<unknown>;
}): Promise<void> {
  await client.send("Runtime.enable");
  await client.send("Page.enable");
}

export async function evaluateExpression(
  client: {
    send: (
      method: string,
      params?: unknown,
      options?: { timeoutMs?: number },
    ) => Promise<unknown>;
  },
  expression: string,
  {
    timeoutMs,
    returnByValue = true,
  }: { timeoutMs?: number; returnByValue?: boolean } = {},
): Promise<unknown> {
  const result = await client.send(
    "Runtime.evaluate",
    {
      expression,
      awaitPromise: true,
      returnByValue,
      userGesture: false,
    },
    { timeoutMs },
  );
  const resultRecord = result as {
    exceptionDetails?: { text?: string };
    result?: { value?: unknown };
  };
  if (resultRecord.exceptionDetails) {
    throw new Error(
      `Runtime.evaluate failed: ${resultRecord.exceptionDetails.text ?? "exception"}`,
    );
  }
  return resultRecord.result?.value;
}

const MACHINE_RUNTIME_TRACE_SNAPSHOT_EXPRESSION =
  "window.__VEM_MACHINE_RUNTIME_TRACE_SNAPSHOT__ || null";
const MACHINE_RUNTIME_GENERATION_EXPRESSION =
  "window.__VEM_MACHINE_RUNTIME_TRACE_SNAPSHOT__?.runtimeGenerationId ?? null";
const LOCATION_HASH_EXPRESSION = "location.hash";
const RUNTIME_OPERATION_OBSERVATION_EXPRESSION = `(() => {
  const traceSnapshot = window.__VEM_MACHINE_RUNTIME_TRACE_SNAPSHOT__;
  const transactionSurface = document.querySelector([
    '[data-installed-kiosk-sale-payment-surface]',
    '[data-installed-kiosk-sale-fulfillment-surface]',
    '[data-installed-kiosk-sale-result-surface]'
  ].join(','));
  const overlays = [...document.querySelectorAll(
    '[data-test*="recovery"], [data-vem-recovery-overlay], [role="alert"]'
  )].map((element) => ({
    test: element.getAttribute('data-test'),
    recoveryMarker: element.hasAttribute('data-vem-recovery-overlay'),
    text: (element.textContent || '').trim().slice(0, 256),
    visible: Boolean(element.getClientRects().length)
  })).filter((entry) => entry.visible && (entry.recoveryMarker || /recover|reconnect|daemon|connection/i.test((entry.test || '') + ' ' + entry.text)));
  const catalogRequests = performance.getEntriesByType('resource')
    .map((entry) => entry.name)
    .filter((name) => /\\/v1\\/catalog(?:[?#]|$)/.test(name))
    .slice(-32);
  return {
    runtimeTraceSnapshot:
      traceSnapshot && typeof traceSnapshot === 'object'
        ? structuredClone(traceSnapshot)
        : null,
    runtimeTrace: Array.isArray(traceSnapshot?.entries)
      ? structuredClone(traceSnapshot.entries).slice(-256)
      : [],
    catalogRequests,
    catalogRevision: document.documentElement?.dataset.catalogRevision || document.querySelector('[data-catalog-revision]')?.dataset.catalogRevision || null,
    catalogInvalidationId: document.documentElement?.dataset.catalogInvalidationId || document.querySelector('[data-catalog-invalidation-id]')?.dataset.catalogInvalidationId || null,
    recoveryOverlay: overlays,
    orderCredential: transactionSurface?.dataset.orderNo || transactionSurface?.dataset.orderCredential || null,
    route: location.hash
  };
})()`;

/**
 * 读取 Machine UI 暴露的运行时轨迹快照（`window.__VEM_MACHINE_RUNTIME_TRACE_SNAPSHOT__`）。
 * 这是唯一读取该全局的入口；轨道代码不应再内联此表达式。
 */
export async function readMachineRuntimeTraceSnapshot(
  client: any,
  options: any = {},
) {
  return evaluateExpression(
    client,
    MACHINE_RUNTIME_TRACE_SNAPSHOT_EXPRESSION,
    options,
  );
}

export async function readCdpLocationHash(client: any, options: any = {}) {
  return evaluateExpression(client, LOCATION_HASH_EXPRESSION, options);
}

export async function setCdpLocationHash(
  client: CdpRuntimeClient,
  hash: string,
  options: EvaluateOptions = {},
): Promise<unknown> {
  return evaluateExpression(
    client,
    `location.hash = ${JSON.stringify(hash)}`,
    options,
  );
}

export async function captureDomIdentity(
  client: CdpRuntimeClient,
  options: EvaluateOptions = {},
): Promise<unknown> {
  const identity = await evaluateExpression(
    client,
    `(() => {
      const html = document.documentElement?.outerHTML ?? "";
      let hash = 2166136261;
      for (let index = 0; index < html.length; index += 1) {
        hash ^= html.charCodeAt(index);
        hash = Math.imul(hash, 16777619) >>> 0;
      }
      return {
        url: location.href,
        route: location.hash,
        pathname: location.pathname,
        title: document.title,
        readyState: document.readyState,
        activeElement: document.activeElement?.tagName?.toLowerCase() ?? null,
        domLength: html.length,
        domHash: hash.toString(16).padStart(8, "0")
      };
    })()`,
    options,
  );
  return boundIdentity(identity);
}

// This is intentionally a CDP read-only probe.  Installed acceptance must not
// manufacture a UI state while it is trying to observe the daemon transport.
export async function captureRuntimeOperationObservation(
  client: CdpRuntimeClient,
  options: EvaluateOptions = {},
): Promise<Record<string, unknown>> {
  const value = await evaluateExpression(
    client,
    RUNTIME_OPERATION_OBSERVATION_EXPRESSION,
    options,
  );
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("runtime operation observation returned no object");
  }
  return value as Record<string, unknown>;
}

async function captureRecoveredOperationObservation(
  client: CdpRuntimeClient,
  {
    uiBefore,
    timeoutMs,
    pollMs,
  }: {
    uiBefore?: Record<string, unknown> | null;
    timeoutMs: number;
    pollMs: number;
  },
  recover: <T>(operation: () => Promise<T>) => Promise<T>,
): Promise<Record<string, unknown> | null> {
  // After daemon transport recovery the UI may briefly pass through a
  // loading/empty state before the payment surface re-exposes the order
  // credential. Capture the stable state instead of racing the restore.
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await recover(() =>
      captureRuntimeOperationObservation(client, { timeoutMs }),
    );
    if (
      uiBefore?.orderCredential &&
      last?.orderCredential === uiBefore.orderCredential
    ) {
      return last;
    }
    await sleep(pollMs);
  }
  return last;
}

async function readRuntimeGeneration(
  client: CdpRuntimeClient,
  options: EvaluateOptions = {},
): Promise<string | null> {
  const value = await evaluateExpression(
    client,
    MACHINE_RUNTIME_GENERATION_EXPRESSION,
    options,
  );
  // Older focused driver tests do not expose the optional trace snapshot. A
  // real value must still be a generation id; an absent snapshot cannot fake one.
  if (value == null || typeof value === "object") return null;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("Machine Runtime generation is invalid");
  }
  return boundedRequiredString(
    value,
    "Machine Runtime generation",
    MAX_LABEL_LENGTH,
  );
}

export async function captureScreenshot(
  client: CdpRuntimeClient,
  options: ScreenshotOptions = {},
): Promise<{
  sha256: string;
  byteLength: number;
  format: string;
  ref: string | null;
}> {
  const format = options.format ?? "png";
  if (format !== "png" && format !== "jpeg") {
    throw new Error("screenshot format must be png or jpeg");
  }
  const maxBytes = options.maxBytes ?? MAX_SCREENSHOT_BYTES;
  if (
    !Number.isInteger(maxBytes) ||
    maxBytes <= 0 ||
    maxBytes > MAX_SCREENSHOT_BYTES
  ) {
    throw new Error("screenshot maxBytes is invalid");
  }
  const result = await client.send(
    "Page.captureScreenshot",
    {
      format,
      fromSurface: options.fromSurface ?? true,
      captureBeyondViewport: options.captureBeyondViewport ?? false,
    },
    { timeoutMs: options.timeoutMs },
  );
  const resultRecord = result as { data?: unknown };
  if (typeof resultRecord.data !== "string") {
    throw new Error("Page.captureScreenshot returned no image data");
  }
  const imageData = resultRecord.data;
  if (imageData.length > Math.ceil((maxBytes * 4) / 3) + 4) {
    throw new Error("Page.captureScreenshot exceeded the maximum size");
  }
  if (
    imageData.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(imageData)
  ) {
    throw new Error("Page.captureScreenshot returned invalid base64");
  }
  const bytes = Buffer.from(imageData, "base64");
  if (bytes.length > maxBytes) {
    throw new Error("Page.captureScreenshot exceeded the maximum size");
  }
  if (bytes.toString("base64") !== imageData) {
    throw new Error("Page.captureScreenshot returned noncanonical base64");
  }
  if (options.validatePng === true) {
    validatePngScreenshot(bytes, options.expectedDimensions);
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  let ref: string | null = null;
  if (options.screenshotSink) {
    const sinkResult = await options.screenshotSink({
      bytes,
      sha256,
      format,
      label: options.label ?? "screenshot",
    });
    ref =
      typeof sinkResult === "string"
        ? sinkResult
        : sinkResult?.ref ?? null;
    if (typeof ref !== "string" || ref.trim() === "" || ref.length > 1_024) {
      throw new Error("screenshot sink must return a bounded nonempty ref");
    }
  }
  return {
    sha256,
    byteLength: bytes.length,
    format,
    ref,
  };
}

export function validatePngScreenshot(
  bytes: unknown,
  expected: { width: number; height: number } = {
    width: 1080,
    height: 1920,
  },
): { format: "png"; width: number; height: number } {
  if (!Buffer.isBuffer(bytes) || bytes.length < 24) {
    throw new Error("screenshot is not a readable PNG");
  }
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!bytes.subarray(0, 8).equals(signature)) {
    throw new Error("screenshot is not a readable PNG");
  }
  if (
    bytes.readUInt32BE(8) !== 13 ||
    bytes.toString("ascii", 12, 16) !== "IHDR"
  ) {
    throw new Error("PNG screenshot is missing IHDR");
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width !== expected.width || height !== expected.height) {
    throw new Error(
      `PNG screenshot dimensions must be ${expected.width}x${expected.height}; got ${width}x${height}`,
    );
  }
  return { format: "png", width, height };
}

export async function captureCheckpoint(
  client: CdpRuntimeClient,
  label: string,
  options: ScreenshotOptions & { screenshot?: boolean } = {},
): Promise<{
  type: "checkpoint";
  label: string;
  capturedAt: string;
  identity: unknown;
  screenshot: Awaited<ReturnType<typeof captureScreenshot>> | null;
}> {
  const capturedAt = nowIso(options.clock);
  const identity = await captureDomIdentity(client, options);
  return {
    type: "checkpoint",
    label: boundedString(label, MAX_LABEL_LENGTH),
    capturedAt,
    identity,
    screenshot:
      options.screenshot === true
        ? await captureScreenshot(client, { ...options, label })
        : null,
  };
}

export async function probeSelectorBounds(
  client: CdpRuntimeClient,
  selector: string,
  options: EvaluateOptions = {},
): Promise<unknown> {
  if (typeof selector !== "string" || selector.trim() === "") {
    throw new Error("selector is required");
  }
  if (selector.length > MAX_SELECTOR_LENGTH) {
    throw new Error("selector exceeds maximum length");
  }
  return evaluateExpression(
    client,
    `(() => {
      const selector = ${JSON.stringify(selector)};
      const elements = [...document.querySelectorAll(selector)];
      if (elements.length === 0) {
        return { selector, exists: false, actionable: false };
      }
      const probes = elements.map((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const center = {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2
        };
        const inViewport = (
          center.x >= 0 && center.y >= 0 &&
          center.x < innerWidth && center.y < innerHeight
        );
        const hit = inViewport
          ? document.elementFromPoint(center.x, center.y)
          : null;
        const hitTarget = hit === element || element.contains(hit);
        const actionable = (
          rect.width > 0 && rect.height > 0 && inViewport && hitTarget &&
          style.visibility !== "hidden" && style.display !== "none" &&
          style.pointerEvents !== "none" && Number(style.opacity || "1") > 0 &&
          !element.hasAttribute("disabled") &&
          element.getAttribute("aria-disabled") !== "true"
        );
        return {
          element,
          rect,
          style,
          center,
          inViewport,
          hitTarget,
          actionable,
        };
      });
      const selected = probes.find((probe) => probe.actionable) ?? probes[0];
      const { element, rect, style, center, inViewport, hitTarget, actionable } = selected;
      return {
        selector,
        exists: true,
        matchCount: elements.length,
        actionable,
        disabled: element.hasAttribute("disabled"),
        ariaDisabled: element.getAttribute("aria-disabled"),
        text: String(element.textContent || "").trim().slice(0, 256),
        pageMessage: String(
          document.querySelector(".checkout-tip, [role='alert']")?.textContent || ""
        ).replace(/\s+/g, " ").trim().slice(0, 1024),
        inViewport,
        pointerEvents: style.pointerEvents,
        hitTarget,
        bounds: {
          x: rect.x, y: rect.y, width: rect.width, height: rect.height,
          top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left
        },
        center
      };
    })()`,
    options,
  );
}

export async function dispatchPhysicalInput(
  client: CdpRuntimeClient,
  point: { x?: unknown; y?: unknown },
  {
    kind = "touch",
    timeoutMs,
  }: { kind?: "touch" | "mouse"; timeoutMs?: number } = {},
): Promise<{
  method: string;
  kind: "touch" | "mouse";
  x: number;
  y: number;
  released: boolean;
}> {
  const x = Number(point?.x);
  const y = Number(point?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error("physical input point must contain finite x and y");
  }
  if (kind !== "touch" && kind !== "mouse") {
    throw new Error("input kind must be touch or mouse");
  }

  const method =
    kind === "touch" ? "Input.dispatchTouchEvent" : "Input.dispatchMouseEvent";
  let primaryError: Error | undefined;
  try {
    await client.send(
      method,
      kind === "touch"
        ? {
            type: "touchStart",
            touchPoints: [{ x, y, radiusX: 1, radiusY: 1, force: 1 }],
          }
        : { type: "mousePressed", x, y, button: "left", clickCount: 1 },
      { timeoutMs },
    );
    // A zero-duration touch press is coalesced/dropped by the WebView under
    // load. Hold the press briefly so the browser synthesizes a real tap.
    if (kind === "touch") await sleep(TOUCH_PRESS_HOLD_MS);
  } catch (error) {
    primaryError = error instanceof Error ? error : new Error(String(error));
  } finally {
    try {
      await client.send(
        method,
        kind === "touch"
          ? { type: "touchEnd", touchPoints: [] }
          : { type: "mouseReleased", x, y, button: "left", clickCount: 1 },
        { timeoutMs },
      );
    } catch (releaseError) {
      if (!primaryError) {
        primaryError =
          releaseError instanceof Error
            ? releaseError
            : new Error(String(releaseError));
      }
    }
  }
  if (primaryError) throw primaryError;
  return { method, kind, x, y, released: true };
}

export async function activateVisibleSelector(
  client: CdpRuntimeClient,
  selector: string,
  options: EvaluateOptions & { pollMs?: number; kind?: "touch" | "mouse" } = {},
): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? 0;
  const pollMs = options.pollMs ?? DEFAULT_ROUTE_POLL_MS;
  const deadline = Date.now() + timeoutMs;
  let scrolled = false;
  let probe: SelectorBoundsProbe | null = null;
  do {
    probe = (await probeSelectorBounds(
      client,
      selector,
      options,
    )) as SelectorBoundsProbe | null;
    if (probe?.actionable) break;
    if (
      probe?.exists === true &&
      !scrolled &&
      (probe.inViewport === false ||
        (probe.inViewport === true &&
          probe.hitTarget === false &&
          probe.pointerEvents === "auto" &&
          probe.disabled !== true &&
          probe.ariaDisabled !== "true" &&
          Number.isFinite(probe.bounds?.y)))
    ) {
      await evaluateExpression(
        client,
        `(() => {
          const elements = [...document.querySelectorAll(${JSON.stringify(selector)})];
          const element = elements.find((candidate) => {
            const rect = candidate.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          }) ?? elements[0];
          if (!element) return false;
          element.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
          return true;
        })()`,
        options,
      );
      scrolled = true;
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `selector is not physically actionable: ${selector}; last probe=${JSON.stringify(probe ?? null)}`,
      );
    }
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  } while (true);
  const input = await dispatchPhysicalInput(
    client,
    probe.center ?? {},
    options,
  );
  return {
    selector,
    center: probe.center,
    bounds: probe.bounds,
    input,
  };
}

interface SelectorBoundsProbe {
  selector?: unknown;
  exists?: boolean;
  actionable?: boolean;
  inViewport?: boolean;
  hitTarget?: boolean;
  pointerEvents?: string;
  disabled?: boolean;
  ariaDisabled?: string | null;
  bounds?: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  };
  center?: { x: number; y: number };
}

interface RouteIdentity {
  route?: string;
  [key: string]: unknown;
}

interface WaitForRouteOptions {
  timeoutMs?: number;
  pollMs?: number;
  assertHealthy?: () => void;
  forbiddenRoutes?: unknown;
  allowedRoutes?: unknown;
  returnByValue?: boolean;
}

type RouteMatcher = string | RegExp | ((route: string) => boolean);

interface TunnelOptions {
  remote?: string;
  sshPort?: number;
  identityFile?: string;
  certificateFile?: string;
  sshKnownHostsPath?: string;
  sshHostKeyAlias?: string;
  sshArgs?: string[];
  remoteCdpPort?: number;
  localHost?: string;
  localPort?: number;
  remoteCdpHost?: string;
  [key: string]: unknown;
}

interface ScenarioStepInput {
  type?: unknown;
  name?: unknown;
  timeoutMs?: unknown;
  screenshot?: unknown;
  selector?: unknown;
  routeBefore?: unknown;
  routeAfter?: unknown;
  inputKind?: unknown;
  activatesRouteBarrier?: unknown;
  completesRouteBarrier?: unknown;
  repeatPreviousActivationCenter?: unknown;
  operation?: unknown;
  expectedOperation?: unknown;
  expectedRoute?: unknown;
  [key: string]: unknown;
}

interface ActivationResult {
  selector?: string;
  center?: { x: number; y: number };
  bounds?: unknown;
  input?: Record<string, unknown> | null;
}

interface ScenarioStepCommon {
  name: string;
  timeoutMs?: number;
  screenshot?: boolean;
}

interface CustomerActivationStep extends ScenarioStepCommon {
  type: "customer-activation";
  selector: string;
  routeBefore: RouteMatcher;
  routeAfter: RouteMatcher;
  inputKind?: "touch" | "mouse";
  activatesRouteBarrier?: boolean;
  completesRouteBarrier?: boolean;
  repeatPreviousActivationCenter?: boolean;
}

interface ObservationStep extends ScenarioStepCommon {
  type: "observation";
  route: RouteMatcher;
}

interface ExternalOperationStep extends ScenarioStepCommon {
  type: "external-operation";
  operation: string;
  routeBefore: RouteMatcher;
  routeAfter: RouteMatcher;
}

type ValidatedScenarioStep =
  | CustomerActivationStep
  | ObservationStep
  | ExternalOperationStep;

interface ScenarioAdapter {
  screenshotSink?: ScreenshotOptions["screenshotSink"];
  [key: string]: unknown;
}

interface ScenarioOptions {
  tunnelOptions?: TunnelOptions;
  expectedRuntimeAttestation?: unknown;
  expectedInitialRoute?: RouteMatcher;
  sequenceName?: string;
  steps?: ScenarioStepInput[];
  adapter?: ScenarioAdapter;
  timeoutMs?: number;
  routePollMs?: number;
  inputKind?: "touch" | "mouse";
  continuousCapture?: boolean;
  continuousCaptureIntervalMs?: number;
  initialForbiddenRoutes?: unknown;
  screenshotCheckpoints?: boolean;
  onPaymentWindow?: unknown;
  clock?: () => Date;
}

interface ScenarioDependencies {
  openSidecar: (
    options: TunnelOptions,
  ) => Promise<{
    endpoint: string;
    process: ChildProcess | null;
    close: () => Promise<void>;
  }>;
  inspectRuntime: (
    options: WindowsMachineUiInspectionOptions,
  ) => Promise<unknown>;
  fetchImpl?: typeof globalThis.fetch;
  webSocketFactory?: WebSocketFactory;
}

export async function waitForRoute(
  client: CdpRuntimeClient,
  expected: string | RegExp | ((route: string) => boolean),
  options: WaitForRouteOptions = {},
): Promise<RouteIdentity> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_ROUTE_POLL_MS;
  const deadline = Date.now() + timeoutMs;
  let lastIdentity: RouteIdentity | null = null;
  do {
    options.assertHealthy?.();
    lastIdentity = (await captureDomIdentity(
      client,
      options,
    )) as RouteIdentity;
    assertAllowedRoute(
      lastIdentity.route,
      options.forbiddenRoutes,
      options.allowedRoutes,
    );
    if (matchesRoute(lastIdentity.route, expected)) return lastIdentity;
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  } while (Date.now() < deadline);
  options.assertHealthy?.();
  throw new Error(
    `route did not reach ${formatExpectedRoute(expected)}; last route was ${lastIdentity?.route ?? "unknown"}`,
  );
}

export function assertRouteIdentity(
  identity: unknown,
  expected: string | RegExp | ((route: string) => boolean),
  label = "route",
): void {
  const route = (identity as { route?: unknown } | null | undefined)?.route;
  if (!matchesRoute(route, expected)) {
    throw new Error(
      `${label} route mismatch: expected ${formatExpectedRoute(expected)}, got ${route ?? "unknown"}`,
    );
  }
}

interface ContinuousCaptureOptions extends ScreenshotOptions {
  intervalMs?: number;
  maxCheckpoints?: number;
  startOrdinal?: number;
  label?: string;
  routePolicy?: RoutePolicy | (() => RoutePolicy);
  screenshot?: boolean;
}

interface ContinuousCheckpoint extends Awaited<ReturnType<typeof captureCheckpoint>> {
  ordinal?: number;
}

export function startContinuousIdentityCapture(
  client: CdpRuntimeClient,
  options: ContinuousCaptureOptions = {},
): {
  checkpoints: ContinuousCheckpoint[];
  throwIfFailed: () => void;
  captureNow: () => Promise<ContinuousCheckpoint | null>;
  stop: () => Promise<ContinuousCheckpoint[]>;
} {
  const intervalMs =
    options.intervalMs ?? DEFAULT_CONTINUOUS_CAPTURE_INTERVAL_MS;
  const maxCheckpoints = options.maxCheckpoints ?? MAX_CONTINUOUS_CHECKPOINTS;
  if (!Number.isSafeInteger(maxCheckpoints) || maxCheckpoints <= 0) {
    throw new Error(
      "continuous capture maxCheckpoints must be a positive integer",
    );
  }
  const checkpoints: ContinuousCheckpoint[] = [];
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  let failure: Error | null = null;
  let ordinal = options.startOrdinal ?? 0;

  const capture = (): void => {
    if (stopped || inFlight || failure) return;
    // A capture can complete after a payment barrier is armed. Its route must be
    // judged by the policy that existed when the capture began, not afterward.
    const policy = snapshotRoutePolicy(options);
    inFlight = captureCheckpoint(client, options.label ?? "continuous", options)
      .then((checkpoint: ContinuousCheckpoint) => {
        if (checkpoints.length >= maxCheckpoints) {
          throw new Error(
            "continuous capture exceeded maximum evidence entries",
          );
        }
        checkpoint.ordinal = ordinal++;
        assertAllowedRoute(
          (checkpoint.identity as RouteIdentity).route,
          policy.forbiddenRoutes,
          policy.allowedRoutes,
        );
        checkpoints.push(checkpoint);
      })
      .catch((error) => {
        failure = new Error(
          `continuous capture failed: ${errorMessage(error)}`,
          { cause: error },
        );
      })
      .finally(() => {
        inFlight = null;
      });
  };
  const timer = setInterval(capture, intervalMs);
  timer.unref?.();
  return {
    checkpoints,
    throwIfFailed() {
      if (failure) throw failure;
    },
    async captureNow() {
      if (inFlight) await inFlight;
      capture();
      await inFlight;
      if (failure) throw failure;
      return checkpoints.at(-1) ?? null;
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      await inFlight;
      if (failure) throw failure;
      return checkpoints;
    },
  };
}

export async function runVisibleMachineSaleScenario(
  options: ScenarioOptions = {},
): Promise<unknown> {
  assertProductionScenarioOptions(options);
  return runVisibleMachineSaleScenarioInternal(
    {
      ...options,
      tunnelOptions: sanitizeProductionTunnelOptions(options.tunnelOptions),
    },
    {
      openSidecar: async (tunnelOptions) =>
        openMachineUiCdpSidecar(tunnelOptions),
      inspectRuntime: inspectWindowsMachineUiRuntime,
    },
  );
}

// This harness is intentionally not reachable from CLI argument parsing.
export async function runVisibleMachineSaleScenarioForTest(
  options: ScenarioOptions & { endpoint?: string } = {},
  testDependencies: {
    openSidecar?: ScenarioDependencies["openSidecar"];
    inspectRuntime?: ScenarioDependencies["inspectRuntime"];
    remoteCommandRunner?: WindowsRuntimeCommandRunner;
    processAdapter?: ProcessAdapter;
    fetchImpl?: typeof globalThis.fetch;
    webSocketFactory?: WebSocketFactory;
  } = {},
): Promise<unknown> {
  const { endpoint, ...scenarioOptions } = options;
  return runVisibleMachineSaleScenarioInternal(scenarioOptions, {
    openSidecar:
      testDependencies.openSidecar ??
      ((tunnelOptions) =>
        openMachineUiCdpSidecar({
          endpoint,
          ...tunnelOptions,
          processAdapter: testDependencies.processAdapter,
        })),
    inspectRuntime:
      testDependencies.inspectRuntime ??
      ((inspectionOptions) =>
        inspectWindowsMachineUiRuntimeForTest(inspectionOptions, {
          commandRunner: testDependencies.remoteCommandRunner,
        })),
    fetchImpl: testDependencies.fetchImpl,
    webSocketFactory: testDependencies.webSocketFactory,
  });
}

async function runVisibleMachineSaleScenarioInternal(
  options: ScenarioOptions,
  dependencies: ScenarioDependencies,
): Promise<unknown> {
  const {
    tunnelOptions = {},
    expectedRuntimeAttestation,
    expectedInitialRoute,
    sequenceName,
    steps,
    adapter = {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
    routePollMs = DEFAULT_ROUTE_POLL_MS,
    inputKind = "touch",
    continuousCapture = true,
    continuousCaptureIntervalMs = DEFAULT_CONTINUOUS_CAPTURE_INTERVAL_MS,
    initialForbiddenRoutes = INITIAL_FORBIDDEN_CUSTOMER_ROUTES,
    screenshotCheckpoints = false,
    onPaymentWindow,
    clock,
  } = options;
  const sequence = validateScenarioSequence({ sequenceName, steps });
  const expectedRuntime = validateExpectedRuntimeAttestation(
    expectedRuntimeAttestation,
  );
  if (expectedInitialRoute == null) {
    throw new Error("expectedInitialRoute is required");
  }
  const tunnelTransport = selectTunnelTransportFields(tunnelOptions);
  const inspectionRemoteCdpPort =
    tunnelTransport.remoteCdpPort ?? DEFAULT_REMOTE_CDP_PORT;

  const plannedExecution = countScenarioSteps(sequence);
  const executedExecution = {
    customerActivations: 0,
    observations: 0,
    externalOperations: 0,
  };
  let activeForbiddenRoutes = validateForbiddenRoutes(initialForbiddenRoutes);
  let activeAllowedRoutes: readonly string[] | null = null;
  let routePolicyEpoch = 0;
  let paymentBarrierTerminalObserved = false;
  const currentRoutePolicy = () =>
    Object.freeze({
      epoch: routePolicyEpoch,
      forbiddenRoutes: activeForbiddenRoutes,
      allowedRoutes: activeAllowedRoutes,
    });
  const observedRuntime = await dependencies.inspectRuntime({
    remote: tunnelTransport.remote,
    sshPort: tunnelTransport.sshPort,
    identityFile: tunnelTransport.identityFile,
    certificateFile: tunnelTransport.certificateFile,
    sshKnownHostsPath: tunnelTransport.sshKnownHostsPath,
    sshHostKeyAlias: tunnelTransport.sshHostKeyAlias,
    sshArgs: tunnelTransport.sshArgs,
    remoteCdpPort: inspectionRemoteCdpPort,
    expectedMachinePath: expectedRuntime.machine.executablePath,
    timeoutMs,
  });
  let inspectedRuntime = normalizeWindowsRuntimeObservation(observedRuntime, {
    remoteCdpPort: inspectionRemoteCdpPort,
  });
  const sidecar = await dependencies.openSidecar(
    buildSidecarTunnelOptions(tunnelTransport, inspectedRuntime),
  );
  let client: CdpClient | null = null;
  const getClient = (): CdpClient | null => client;
  const requireConnectedClient = (): CdpRuntimeClient => {
    const current = getClient();
    if (current === null) {
      throw new Error("CDP client is not connected");
    }
    return current;
  };
  let target: Record<string, unknown> | null = null;
  const getTarget = (): Record<string, unknown> | null => target;
  let runtimeEvidence: ReturnType<typeof bindMachineUiRuntimeEvidence> | null =
    null;
  let capture: ReturnType<typeof startContinuousIdentityCapture> | null = null;
  const getCapture =
    (): ReturnType<typeof startContinuousIdentityCapture> | null => capture;
  const captureSegments: Array<{
    capture: ReturnType<typeof startContinuousIdentityCapture>;
    runtimeGeneration: string | null;
    targetId: unknown;
    stopped: boolean;
  }> = [];
  let nextContinuousOrdinal = 1_000_000;
  let unsubscribeCdpRoutes: (() => void) | undefined;
  let runtimeGeneration: string | null = null;
  let runtimeGenerationMayHaveChanged = false;
  let recoveryAttempts = 0;
  let scenarioError: unknown;
  let scenarioResult: unknown;
  const evidence: Array<Record<string, unknown>> = [];
  let ordinal = 0;
  let fatalError: Error | null = null;
  let lastCustomerActivation: {
    selector?: string;
    center?: { x: number; y: number };
    bounds?: unknown;
  } | null = null;
  const record = (entry: Record<string, unknown>): Record<string, unknown> => {
    if (evidence.length >= MAX_EVIDENCE_ENTRIES) {
      throw new Error("machine UI CDP evidence exceeded maximum entries");
    }
    if (
      entry.type === "route-changed" &&
      evidence.filter((item) => item.type === "route-changed").length >=
        MAX_ROUTE_EVIDENCE_ENTRIES
    ) {
      throw new Error("machine UI CDP route evidence exceeded maximum entries");
    }
    const item = {
      ...boundEvidenceEntry(entry),
      capturedAt: entry.capturedAt ?? nowIso(clock),
      ordinal: ordinal++,
    };
    evidence.push(item);
    return item;
  };
  const classifyRouteEvent = (event: unknown, source = "adapter"): void => {
    if (fatalError) return;
    try {
      const policy = currentRoutePolicy();
      const eventRecord = event as { identity?: unknown } | null | undefined;
      const identity = boundIdentity(eventRecord?.identity ?? eventRecord);
      assertAllowedRoute(
        identity.route,
        policy.forbiddenRoutes,
        policy.allowedRoutes,
      );
      if (
        activeAllowedRoutes !== null &&
        !paymentBarrierTerminalObserved &&
        matchesAnyRoutePath(identity.route, PAYMENT_BARRIER_TERMINAL_ROUTES)
      ) {
        paymentBarrierTerminalObserved = true;
        activeAllowedRoutes = validateAllowedRoutes(
          PAYMENT_BARRIER_COMPLETED_ALLOWED_ROUTES,
        );
        routePolicyEpoch += 1;
      }
      record({ type: "route-changed", source, identity });
    } catch (error) {
      fatalError = new Error(`route capture failed: ${errorMessage(error)}`, {
        cause: error,
      });
    }
  };
  const assertHealthy = () => {
    for (const segment of captureSegments) segment.capture.throwIfFailed();
    if (fatalError) throw fatalError;
  };
  const stopActiveCapture = async () => {
    if (!capture) return;
    const segment = captureSegments.at(-1);
    capture = null;
    if (!segment || segment.stopped) return;
    segment.stopped = true;
    try {
      await segment.capture.stop();
    } finally {
      const lastOrdinal = segment.capture.checkpoints.at(-1)?.ordinal;
      if (
        typeof lastOrdinal === "number" &&
        Number.isSafeInteger(lastOrdinal)
      ) {
        nextContinuousOrdinal = Math.max(
          nextContinuousOrdinal,
          lastOrdinal + 1,
        );
      }
    }
  };
  const stopAllCaptures = async (): Promise<ContinuousCheckpoint[]> => {
    const checkpoints: ContinuousCheckpoint[] = [];
    let captureError: Error | null = null;
    for (const segment of captureSegments) {
      try {
        if (!segment.stopped) {
          segment.stopped = true;
          await segment.capture.stop();
        }
      } catch (error) {
        if (captureError === null) {
          captureError =
            error instanceof Error ? error : new Error(String(error));
        }
      }
      checkpoints.push(...segment.capture.checkpoints);
    }
    if (captureError) throw captureError;
    return checkpoints;
  };
  const connectTarget = async ({
    nextTarget,
    nextRuntime,
    expected,
  }: {
    nextTarget: Record<string, unknown>;
    nextRuntime: NormalizedWindowsRuntimeObservation;
    expected: unknown;
  }): Promise<void> => {
    target = nextTarget;
    inspectedRuntime = nextRuntime;
    runtimeEvidence = bindMachineUiRuntimeEvidence({
      expectedRuntimeAttestation: expected,
      observedRuntime: inspectedRuntime,
      target,
    });
    record({ type: "runtime-attestation", attestation: runtimeEvidence });
    client = new CdpClient(
      rewriteWebSocketDebuggerUrl(
        target.webSocketDebuggerUrl,
        sidecar.endpoint,
      ),
      {
        webSocketFactory: dependencies.webSocketFactory,
        defaultTimeoutMs: timeoutMs,
      },
    );
    await client.connect({ timeoutMs });
    const offWithinDocument = client.on(
      "Page.navigatedWithinDocument",
      (params) =>
        classifyRouteEvent({ url: (params as { url?: unknown }).url }, "cdp"),
    );
    const offFrameNavigated = client.on("Page.frameNavigated", (params) => {
      const frame = (params as { frame?: { parentId?: unknown; url?: unknown } })
        .frame;
      if (frame?.parentId == null) {
        runtimeGenerationMayHaveChanged = true;
        classifyRouteEvent({ url: frame?.url }, "cdp");
      }
    });
    unsubscribeCdpRoutes = () => {
      offWithinDocument();
      offFrameNavigated();
    };
    await enablePageRuntime(client);
    runtimeGeneration = await readRuntimeGeneration(client, { timeoutMs });
    runtimeGenerationMayHaveChanged = false;
    capture = continuousCapture
      ? startContinuousIdentityCapture(client, {
          intervalMs: continuousCaptureIntervalMs,
          screenshot: screenshotCheckpoints,
          screenshotSink: adapter.screenshotSink,
          routePolicy: currentRoutePolicy,
          timeoutMs,
          clock,
          startOrdinal: nextContinuousOrdinal,
          maxCheckpoints: MAX_CONTINUOUS_CHECKPOINTS,
        })
      : null;
    if (capture) {
      captureSegments.push({
        capture,
        runtimeGeneration,
        targetId: target.id,
        stopped: false,
      });
    }
  };
  const reattestRuntime = async (reason: string): Promise<void> => {
    if (recoveryAttempts >= MAX_CDP_RUNTIME_RECOVERY_ATTEMPTS) {
      throw new Error(
        `CDP runtime recovery exceeded ${MAX_CDP_RUNTIME_RECOVERY_ATTEMPTS} attempts while ${reason}`,
      );
    }
    recoveryAttempts += 1;
    await Promise.resolve().then(() => unsubscribeCdpRoutes?.());
    unsubscribeCdpRoutes = undefined;
    await stopActiveCapture().catch(() => {});
    await client?.close().catch(() => {});
    const observed = await dependencies.inspectRuntime({
      remote: tunnelTransport.remote,
      sshPort: tunnelTransport.sshPort,
      identityFile: tunnelTransport.identityFile,
      certificateFile: tunnelTransport.certificateFile,
      sshKnownHostsPath: tunnelTransport.sshKnownHostsPath,
      sshHostKeyAlias: tunnelTransport.sshHostKeyAlias,
      sshArgs: tunnelTransport.sshArgs,
      remoteCdpPort: inspectionRemoteCdpPort,
      expectedMachinePath: expectedRuntime.machine.executablePath,
      timeoutMs,
    });
    const nextRuntime = normalizeWindowsRuntimeObservation(observed, {
      remoteCdpPort: inspectionRemoteCdpPort,
    });
    const nextTarget = await discoverCanonicalMachineUiTarget({
      endpoint: sidecar.endpoint,
      fetchImpl: dependencies.fetchImpl,
      timeoutMs,
    });
    assertAllowedRoute(
      nextTarget.route,
      activeForbiddenRoutes,
      activeAllowedRoutes,
    );
    await connectTarget({
      nextTarget,
      nextRuntime,
      expected: {
        targetId: nextTarget.id,
        machine: {
          ...expectedRuntime.machine,
          processId: nextRuntime.machine.processId,
        },
      },
    });
    assertHealthy();
  };
  const ensureRuntimeBoundary = async (): Promise<void> => {
    if (client === null || client.closed) {
      await reattestRuntime("the CDP WebSocket closed");
      return;
    }
    const observedGeneration = await readRuntimeGeneration(client, {
      timeoutMs,
    });
    if (
      (runtimeGeneration !== null &&
        observedGeneration !== null &&
        observedGeneration !== runtimeGeneration) ||
      (runtimeGenerationMayHaveChanged && observedGeneration === null)
    ) {
      await reattestRuntime("the Machine Runtime generation changed");
      return;
    }
    runtimeGeneration = observedGeneration;
    runtimeGenerationMayHaveChanged = false;
  };
  const withCdpRecovery = async <T>(
    operation: () => Promise<T>,
    { retry = true }: { retry?: boolean } = {},
  ): Promise<T> => {
    let recovered = false;
    while (true) {
      try {
        await ensureRuntimeBoundary();
        return await operation();
      } catch (error) {
        if (!retry || recovered || !isCdpTransportFailure(error, client)) {
          throw error;
        }
        recovered = true;
        await reattestRuntime(
          `a CDP operation failed: ${boundedString(errorMessage(error), 256)}`,
        );
      }
    }
  };

  try {
    const initialTarget = await discoverMachineUiTarget({
      endpoint: sidecar.endpoint,
      expectedTargetId: expectedRuntime.targetId,
      fetchImpl: dependencies.fetchImpl,
      timeoutMs,
    });
    if (!matchesRoute(initialTarget.route, expectedInitialRoute)) {
      throw new Error(
        `initial CDP target route mismatch: expected ${formatExpectedRoute(expectedInitialRoute)}, got ${initialTarget.route}`,
      );
    }
    assertAllowedRoute(
      initialTarget.route,
      activeForbiddenRoutes,
      activeAllowedRoutes,
    );
    await connectTarget({
      nextTarget: initialTarget,
      nextRuntime: inspectedRuntime,
      expected: expectedRuntime,
    });
    assertHealthy();

    const initial = await withCdpRecovery(() =>
      captureCheckpoint(requireConnectedClient(), "initial", {
        timeoutMs,
        screenshot: screenshotCheckpoints,
        screenshotSink: adapter.screenshotSink,
        clock,
      }),
    );
    assertAllowedRoute(
      (initial.identity as RouteIdentity).route,
      activeForbiddenRoutes,
      activeAllowedRoutes,
    );
    assertRouteIdentity(initial.identity, expectedInitialRoute, "initial");
    record(initial);

    for (const step of sequence) {
      assertHealthy();
      if (step.type === "customer-activation") {
        const before = await withCdpRecovery(() =>
          waitForRoute(requireConnectedClient(), step.routeBefore, {
            timeoutMs: step.timeoutMs ?? timeoutMs,
            pollMs: routePollMs,
            forbiddenRoutes: activeForbiddenRoutes,
            allowedRoutes: activeAllowedRoutes,
            assertHealthy,
          }),
        );
        assertRouteIdentity(before, step.routeBefore, `${step.name} before`);
        record({
          type: "checkpoint",
          label: `${step.name}:before`,
          identity: before,
        });
        if (step.activatesRouteBarrier) {
          activeAllowedRoutes = validateAllowedRoutes(
            PAYMENT_BARRIER_ARMING_ALLOWED_ROUTES,
          );
          paymentBarrierTerminalObserved = false;
          routePolicyEpoch += 1;
          record({
            type: "route-barrier",
            label: step.name,
            forbiddenRoutes: activeForbiddenRoutes,
            allowedRoutes: activeAllowedRoutes,
            armedBeforeInput: true,
            armBaseline: { identity: before, route: before.route },
          });
          assertHealthy();
        }
        const repeatedActivation = step.repeatPreviousActivationCenter === true;
        const activation: ActivationResult = repeatedActivation
          ? ((): ActivationResult => {
              if (!lastCustomerActivation?.center) {
                throw new Error(
                  `${step.name} requires a previous physical activation center`,
                );
              }
              return {
                selector: step.selector,
                center: lastCustomerActivation.center,
                bounds: lastCustomerActivation.bounds,
                input: null,
              };
            })()
          : ((await withCdpRecovery(
              () =>
                activateVisibleSelector(
                  requireConnectedClient(),
                  step.selector,
                  {
                  kind: step.inputKind ?? inputKind,
                  timeoutMs: step.timeoutMs ?? timeoutMs,
                  },
                ),
              { retry: false },
            )) as ActivationResult);
        const dispatchedInput: Record<string, unknown> = repeatedActivation
          ? await withCdpRecovery(
              () =>
                dispatchPhysicalInput(
                  requireConnectedClient(),
                  activation.center ?? {},
                  {
                  kind: step.inputKind ?? inputKind,
                  timeoutMs: step.timeoutMs ?? timeoutMs,
                  },
                ),
              { retry: false },
            )
          : activation.input ?? {};
        const dispatchedMethod = dispatchedInput.method;
        if (
          typeof dispatchedMethod !== "string" ||
          !dispatchedMethod.startsWith("Input.")
        ) {
          throw new Error(`${step.name} emitted no physical Input evidence`);
        }
        lastCustomerActivation = {
          selector: step.selector,
          center: activation.center,
          bounds: activation.bounds,
        };
        record({
          type: "customer-activation",
          label: step.name,
          selector: step.selector,
          input: dispatchedInput,
          ...(step.activatesRouteBarrier ? {} : { routeBefore: before.route }),
        });
        executedExecution.customerActivations += 1;
        assertHealthy();
        let after;
        try {
          after = await withCdpRecovery(() =>
            waitForRoute(requireConnectedClient(), step.routeAfter, {
              timeoutMs: step.timeoutMs ?? timeoutMs,
              pollMs: routePollMs,
              forbiddenRoutes: activeForbiddenRoutes,
              allowedRoutes: activeAllowedRoutes,
              assertHealthy,
            }),
          );
        } catch (error) {
          const probe = await probeSelectorBounds(
            requireConnectedClient(),
            step.selector,
            {
            timeoutMs: step.timeoutMs ?? timeoutMs,
            },
          ).catch(() => null);
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}; activation probe=${JSON.stringify(probe)}`,
            { cause: error },
          );
        }
        assertRouteIdentity(after, step.routeAfter, `${step.name} after`);
        if (
          (step.activatesRouteBarrier === true &&
            step.completesRouteBarrier !== false) ||
          (step.activatesRouteBarrier !== true &&
            step.completesRouteBarrier === true)
        ) {
          activeAllowedRoutes = validateAllowedRoutes(
            PAYMENT_BARRIER_ALLOWED_ROUTES,
          );
          routePolicyEpoch += 1;
        }
        record({
          type: "checkpoint",
          label: `${step.name}:after`,
          identity: after,
        });
      } else if (step.type === "observation") {
        const observation = await withCdpRecovery(() =>
          captureCheckpoint(requireConnectedClient(), step.name, {
            timeoutMs: step.timeoutMs ?? timeoutMs,
            screenshot: screenshotCheckpoints || step.screenshot,
            screenshotSink: adapter.screenshotSink,
            clock,
          }),
        );
        assertAllowedRoute(
          (observation.identity as RouteIdentity).route,
          activeForbiddenRoutes,
          activeAllowedRoutes,
        );
        assertRouteIdentity(
          observation.identity,
          step.route,
          `${step.name} observation`,
        );
        record({ ...observation, type: "observation" });
        executedExecution.observations += 1;
        continue;
      } else if (step.type === "external-operation") {
        const before = (await withCdpRecovery(() =>
          captureDomIdentity(requireConnectedClient(), {
            timeoutMs: step.timeoutMs ?? timeoutMs,
          }),
        )) as RouteIdentity;
        assertAllowedRoute(
          before.route,
          activeForbiddenRoutes,
          activeAllowedRoutes,
        );
        assertRouteIdentity(before, step.routeBefore, `${step.name} before`);
        if (typeof adapter.executeExternalOperation !== "function") {
          throw new Error(
            "external operation requires adapter.executeExternalOperation",
          );
        }
        const uiBefore = await withCdpRecovery(() =>
          captureRuntimeOperationObservation(requireConnectedClient(), {
            timeoutMs: step.timeoutMs ?? timeoutMs,
          }),
        );
        let rawProvenance: Record<string, unknown>;
        let recoveryOverlay: unknown = null;
        if (
          step.operation === "daemon_transport_interrupt" &&
          typeof adapter.beginExternalOperation === "function" &&
          typeof adapter.completeExternalOperation === "function"
        ) {
          const pending = await adapter.beginExternalOperation({
            operation: step.operation,
            label: step.name,
            routeBefore: before.route,
            uiBefore,
          });
          const overlayDeadline = Date.now() + (step.timeoutMs ?? timeoutMs);
          do {
            const observation = await withCdpRecovery(() =>
              captureRuntimeOperationObservation(requireConnectedClient(), {
                timeoutMs: step.timeoutMs ?? timeoutMs,
              }),
            );
            const overlayLength = (
              observation.recoveryOverlay as { length?: number } | null
            )?.length;
            if (overlayLength !== undefined && overlayLength > 0) {
              recoveryOverlay = {
                observation,
                screenshot: await captureScreenshot(requireConnectedClient(), {
                  timeoutMs: step.timeoutMs ?? timeoutMs,
                  screenshotSink: adapter.screenshotSink,
                  label: `${step.name}:recovery-overlay`,
                }),
              };
              break;
            }
            await sleep(routePollMs);
          } while (Date.now() < overlayDeadline);
          if (recoveryOverlay === null) {
            throw new Error(
              "daemon transport interruption did not expose a recovery overlay to read-only CDP",
            );
          }
          rawProvenance = (await adapter.completeExternalOperation(pending, {
            operation: step.operation,
            label: step.name,
            routeBefore: before.route,
            uiBefore,
            recoveryOverlay,
          })) as Record<string, unknown>;
        } else {
          rawProvenance = (await adapter.executeExternalOperation({
            operation: step.operation,
            label: step.name,
            routeBefore: before.route,
            uiBefore,
          })) as Record<string, unknown>;
        }
        const uiAfter =
          step.operation === "daemon_transport_interrupt"
            ? await captureRecoveredOperationObservation(
                requireConnectedClient(),
                {
                uiBefore,
                timeoutMs: step.timeoutMs ?? timeoutMs,
                pollMs: routePollMs,
                },
                withCdpRecovery,
              )
            : await withCdpRecovery(() =>
                captureRuntimeOperationObservation(requireConnectedClient(), {
                  timeoutMs: step.timeoutMs ?? timeoutMs,
                }),
              );
        const provenance = boundExternalOperation(
          {
            ...rawProvenance,
            ui: { before: uiBefore, after: uiAfter, recoveryOverlay },
          },
          step.operation,
        );
        const after = await withCdpRecovery(() =>
          waitForRoute(requireConnectedClient(), step.routeAfter, {
            timeoutMs: step.timeoutMs ?? timeoutMs,
            pollMs: routePollMs,
            forbiddenRoutes: activeForbiddenRoutes,
            allowedRoutes: activeAllowedRoutes,
            assertHealthy,
          }),
        );
        assertRouteIdentity(after, step.routeAfter, `${step.name} after`);
        record({
          type: "external-operation",
          label: step.name,
          operation: step.operation,
          routeBefore: before.route,
          routeAfter: after.route,
          provenance,
        });
        executedExecution.externalOperations += 1;
        if (step.screenshot) {
          const checkpoint = await withCdpRecovery(() =>
            captureCheckpoint(requireConnectedClient(), `${step.name}:after`, {
              timeoutMs: step.timeoutMs ?? timeoutMs,
              screenshot: true,
              screenshotSink: adapter.screenshotSink,
              clock,
            }),
          );
          assertAllowedRoute(
            (checkpoint.identity as RouteIdentity).route,
            activeForbiddenRoutes,
            activeAllowedRoutes,
          );
          record(checkpoint);
        }
        continue;
      }
      const checkpoint = await withCdpRecovery(() =>
        captureCheckpoint(requireConnectedClient(), step.name, {
          timeoutMs: step.timeoutMs ?? timeoutMs,
          screenshot: screenshotCheckpoints || step.screenshot === true,
          screenshotSink: adapter.screenshotSink,
          clock,
        }),
      );
      assertAllowedRoute(
        (checkpoint.identity as RouteIdentity).route,
        activeForbiddenRoutes,
        activeAllowedRoutes,
      );
      record(checkpoint);
    }

    if (typeof onPaymentWindow === "function") {
      const paymentCaptureSegment = captureSegments.at(-1) ?? null;
      const activeCapture = getCapture();
      const continuousStart = activeCapture
        ? await withCdpRecovery(() => activeCapture.captureNow())
        : null;
      const paymentWindow = await onPaymentWindow();
      const endingCaptureSegment = captureSegments.at(-1) ?? null;
      const continuousEnd = activeCapture
        ? await withCdpRecovery(() => activeCapture.captureNow())
        : null;
      const continuousDuring = findContinuousPaymentCheckpoint({
        startSegment: paymentCaptureSegment,
        endSegment: endingCaptureSegment,
        startCheckpoint: continuousStart,
        endCheckpoint: continuousEnd,
      });
      if (
        paymentWindow?.serialCompleted !== true ||
        paymentWindow?.postSaleStable !== true ||
        paymentCaptureSegment == null ||
        paymentCaptureSegment !== endingCaptureSegment ||
        paymentCaptureSegment.stopped ||
        continuousStart == null ||
        continuousDuring == null ||
        continuousEnd == null
      ) {
        throw new Error(
          "payment window must include a continuous checkpoint during serial completion",
        );
      }
      record({
        type: "payment-window",
        serialCompleted: true,
        postSaleStable: true,
        runtimeGeneration: paymentCaptureSegment.runtimeGeneration,
        continuousCheckpointOrdinals: [
          continuousStart.ordinal,
          continuousDuring.ordinal,
          continuousEnd.ordinal,
        ],
      });
      assertHealthy();
    }

    const final = await withCdpRecovery(() =>
      captureCheckpoint(requireConnectedClient(), "final", {
        timeoutMs,
        screenshot: screenshotCheckpoints,
        screenshotSink: adapter.screenshotSink,
        clock,
      }),
    );
    assertAllowedRoute(
      (final.identity as RouteIdentity).route,
      activeForbiddenRoutes,
      activeAllowedRoutes,
    );
    record(final);
    assertHealthy();
    const continuous = await stopAllCaptures();
    capture = null;
    if (evidence.length + continuous.length > MAX_EVIDENCE_ENTRIES) {
      throw new Error("machine UI CDP evidence exceeded maximum entries");
    }
    assertScenarioExecutionCounts(plannedExecution, executedExecution);
    scenarioResult = {
      schemaVersion: "machine-ui-cdp-sale-scenario/v3",
      status: "passed",
      sequenceName: boundedString(sequenceName, MAX_LABEL_LENGTH),
      target: {
        id: getTarget()?.id,
        route: getTarget()?.route,
        attestation: runtimeEvidence,
      },
      execution: {
        planned: plannedExecution,
        executed: executedExecution,
      },
      evidence: sortChronologically([...evidence, ...continuous]),
    };
  } catch (error) {
    scenarioError = error;
  } finally {
    const activeClient = getClient();
    const cleanup = await Promise.allSettled([
      Promise.resolve().then(() => unsubscribeCdpRoutes?.()),
      stopAllCaptures(),
      activeClient === null ? Promise.resolve() : activeClient.close(),
      sidecar.close(),
    ]);
    const failures = cleanup.filter((result) => result.status === "rejected");
    if (!scenarioError && failures.length > 0) {
      scenarioError = new AggregateError(
        failures.map((result) => result.reason),
        "machine UI CDP cleanup failed",
      );
    }
  }
  if (scenarioError) throw scenarioError;
  return scenarioResult;
}

function validateScenarioSequence({
  sequenceName,
  steps,
}: {
  sequenceName: unknown;
  steps: unknown;
}): readonly ValidatedScenarioStep[] {
  if (typeof sequenceName !== "string" || sequenceName.trim() === "") {
    throw new Error("sequenceName is required");
  }
  if (sequenceName.length > MAX_LABEL_LENGTH) {
    throw new Error("sequenceName exceeds maximum length");
  }
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error("scenario requires a nonempty step sequence");
  }
  if (steps.length > MAX_SCENARIO_STEPS) {
    throw new Error("scenario exceeds maximum step count");
  }
  let customerActivations = 0;
  let observations = 0;
  let externalOperations = 0;
  const validatedSteps: ValidatedScenarioStep[] = [];
  for (const [index, step] of steps.entries()) {
    if (
      !step ||
      typeof step !== "object" ||
      Array.isArray(step) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(step))
    ) {
      throw new Error(`scenario step ${index + 1} must be an object`);
    }
    const type = requiredStepString(step, "type", index);
    assertClosedStep(step, index, type);
    const name = requiredStepString(step, "name", index);
    if (name.length > MAX_LABEL_LENGTH) {
      throw new Error(
        `${name.slice(0, MAX_LABEL_LENGTH)} step name exceeds maximum length`,
      );
    }
    const common: ScenarioStepCommon & { type: string } = {
      type,
      name,
      ...(step.timeoutMs == null
        ? {}
        : { timeoutMs: requiredStepTimeout(step, index) }),
      ...(step.screenshot == null
        ? {}
        : { screenshot: requiredStepBoolean(step, "screenshot", index) }),
    };
    if (type === "customer-activation") {
      customerActivations += 1;
      const selector = requiredStepString(step, "selector", index);
      if (selector.length > MAX_SELECTOR_LENGTH) {
        throw new Error(
          `${name} customer activation selector exceeds maximum length`,
        );
      }
      const routeBefore = requiredStepRouteMatcher(step, "routeBefore", index);
      const routeAfter = requiredStepRouteMatcher(step, "routeAfter", index);
      const inputKind =
        step.inputKind == null ? undefined : requiredStepInputKind(step, index);
      validatedSteps.push(
        Object.freeze({
          ...common,
          selector,
          routeBefore,
          routeAfter,
          ...(inputKind == null ? {} : { inputKind }),
          ...(step.activatesRouteBarrier == null
            ? {}
            : {
                activatesRouteBarrier: requiredStepBoolean(
                  step,
                  "activatesRouteBarrier",
                  index,
                ),
              }),
          ...(step.completesRouteBarrier == null
            ? {}
            : {
                completesRouteBarrier: requiredStepBoolean(
                  step,
                  "completesRouteBarrier",
                  index,
                ),
              }),
          ...(step.repeatPreviousActivationCenter == null
            ? {}
            : {
                repeatPreviousActivationCenter: requiredStepBoolean(
                  step,
                  "repeatPreviousActivationCenter",
                  index,
                ),
              }),
        }) as CustomerActivationStep,
      );
    } else if (type === "observation") {
      observations += 1;
      validatedSteps.push(
        Object.freeze({
          ...common,
          route: normalizeMachineRoute(
            requiredStepString(step, "route", index),
          ),
        }) as ObservationStep,
      );
    } else if (type === "external-operation") {
      externalOperations += 1;
      validatedSteps.push(
        Object.freeze({
          ...common,
          operation: requiredStepExternalOperation(step, index),
          routeBefore: requiredStepRouteMatcher(step, "routeBefore", index),
          routeAfter: requiredStepRouteMatcher(step, "routeAfter", index),
        }) as ExternalOperationStep,
      );
    } else {
      throw new Error(`${name} has unsupported step type ${String(step.type)}`);
    }
  }
  if (customerActivations === 0) {
    throw new Error("sale scenario requires at least one customer activation");
  }
  if (observations > MAX_SCENARIO_STEPS) {
    throw new Error("scenario observations exceed maximum step count");
  }
  if (externalOperations > 8) {
    throw new Error("scenario external operations exceed maximum");
  }
  return Object.freeze(validatedSteps);
}

function assertClosedStep(
  step: ScenarioStepInput,
  index: number,
  type: string,
): void {
  const allowed =
    type === "customer-activation"
      ? new Set([
          "type",
          "name",
          "selector",
          "routeBefore",
          "routeAfter",
          "timeoutMs",
          "inputKind",
          "screenshot",
          "activatesRouteBarrier",
          "completesRouteBarrier",
          "repeatPreviousActivationCenter",
        ])
      : type === "observation"
        ? new Set(["type", "name", "route", "timeoutMs", "screenshot"])
        : type === "external-operation"
          ? new Set([
              "type",
              "name",
              "operation",
              "routeBefore",
              "routeAfter",
              "timeoutMs",
              "screenshot",
            ])
          : null;
  if (!allowed) return;
  for (const key of Object.keys(step)) {
    if (!allowed.has(key)) {
      throw new Error(
        `scenario step ${index + 1} has unsupported field ${key}`,
      );
    }
    const descriptor = Object.getOwnPropertyDescriptor(step, key);
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
      throw new Error(`scenario step ${index + 1} cannot use accessors`);
    }
  }
}

function requiredStepString(
  step: ScenarioStepInput,
  field: string,
  index: number,
): string {
  const descriptor = Object.getOwnPropertyDescriptor(step, field);
  if (!descriptor || !Object.hasOwn(descriptor, "value")) {
    throw new Error(`scenario step ${index + 1} requires ${field}`);
  }
  if (typeof descriptor.value !== "string" || descriptor.value.trim() === "") {
    throw new Error(`scenario step ${index + 1} requires ${field}`);
  }
  return descriptor.value.trim();
}

function requiredStepRouteMatcher(
  step: ScenarioStepInput,
  field: string,
  index: number,
): RouteMatcher {
  const descriptor = Object.getOwnPropertyDescriptor(step, field);
  if (!descriptor || !Object.hasOwn(descriptor, "value")) {
    throw new Error(`scenario step ${index + 1} requires ${field}`);
  }
  if (typeof descriptor.value === "string") {
    if (descriptor.value.trim() === "") {
      throw new Error(`scenario step ${index + 1} requires ${field}`);
    }
    return normalizeMachineRoute(descriptor.value);
  }
  if (descriptor.value instanceof RegExp) {
    return new RegExp(descriptor.value.source, descriptor.value.flags);
  }
  throw new Error(`scenario step ${index + 1} requires ${field}`);
}

function requiredStepExternalOperation(
  step: ScenarioStepInput,
  index: number,
): string {
  const operation = requiredStepString(step, "operation", index);
  if (
    operation !== "vision_departure" &&
    operation !== "catalog_projection_refresh" &&
    operation !== "daemon_transport_interrupt"
  ) {
    throw new Error(`scenario step ${index + 1} operation is invalid`);
  }
  return operation;
}

function requiredStepTimeout(step: ScenarioStepInput, index: number): number {
  const value = step.timeoutMs;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > DEFAULT_TIMEOUT_MS * 12
  ) {
    throw new Error(`scenario step ${index + 1} timeoutMs is invalid`);
  }
  return value;
}

function requiredStepBoolean(
  step: ScenarioStepInput,
  field: string,
  index: number,
): boolean {
  if (typeof step[field] !== "boolean") {
    throw new Error(`scenario step ${index + 1} ${field} must be boolean`);
  }
  return step[field];
}

function requiredStepInputKind(
  step: ScenarioStepInput,
  index: number,
): "touch" | "mouse" {
  if (step.inputKind !== "touch" && step.inputKind !== "mouse") {
    throw new Error(`scenario step ${index + 1} inputKind is invalid`);
  }
  return step.inputKind;
}

function countScenarioSteps(
  sequence: readonly ValidatedScenarioStep[],
): {
  customerActivations: number;
  observations: number;
  externalOperations: number;
} {
  return {
    customerActivations: sequence.filter(
      (step) => step.type === "customer-activation",
    ).length,
    observations: sequence.filter((step) => step.type === "observation").length,
    externalOperations: sequence.filter(
      (step) => step.type === "external-operation",
    ).length,
  };
}

interface ScenarioExecutionCounts {
  customerActivations: number;
  observations: number;
  externalOperations: number;
}

function assertScenarioExecutionCounts(
  planned: ScenarioExecutionCounts,
  executed: ScenarioExecutionCounts,
): void {
  for (const field of [
    "customerActivations",
    "observations",
    "externalOperations",
  ] as const) {
    if (planned[field] !== executed[field]) {
      throw new Error(
        `scenario executed ${executed[field]} ${field}, expected ${planned[field]}`,
      );
    }
  }
}

function assertAllowedRoute(
  route: unknown,
  forbiddenRoutes: unknown = INITIAL_FORBIDDEN_CUSTOMER_ROUTES,
  allowedRoutes: unknown = null,
): void {
  const resolvedForbidden = resolveForbiddenRoutes(forbiddenRoutes);
  const resolvedAllowed = resolveAllowedRoutes(allowedRoutes);
  const normalized = normalizeMachineRoute(route);
  const path = routePath(normalized);
  if (
    resolvedAllowed !== null &&
    !resolvedAllowed.some((candidate) =>
      routeMatchesRoutePath(path, candidate),
    )
  ) {
    throw new Error(`payment barrier route observed: ${normalized}`);
  }
  if (
    resolvedForbidden.some((candidate) => {
      return routeMatchesRoutePath(path, candidate);
    })
  ) {
    throw new Error(`forbidden customer route observed: ${normalized}`);
  }
}

function isCdpTransportFailure(
  error: unknown,
  client: CdpRuntimeClient | null,
): boolean {
  if (client?.closed) return true;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /CDP (?:client is closed|connection closed|WebSocket|.*send failed)|CDP connection closed|CDP client closed/.test(
    message,
  );
}

function routeMatchesRoutePath(path: string, candidate: string): boolean {
  const route = candidate.startsWith("#")
    ? routePath(normalizeMachineRoute(candidate))
    : normalizeForbiddenRoutePath(candidate);
  return path === route || path.startsWith(`${route}/`);
}

function matchesAnyRoutePath(
  route: unknown,
  candidates: readonly string[],
): boolean {
  const path = routePath(normalizeMachineRoute(route));
  return candidates.some((candidate) => routeMatchesRoutePath(path, candidate));
}

function validateForbiddenRoutes(routes: unknown): readonly string[] {
  if (!Array.isArray(routes)) {
    throw new Error("forbiddenRoutes must be an array");
  }
  return Object.freeze(
    routes.map((route) => {
      if (typeof route !== "string") {
        throw new Error("forbiddenRoutes must contain route strings");
      }
      return route.startsWith("#")
        ? normalizeMachineRoute(route)
        : normalizeForbiddenRoutePath(route);
    }),
  );
}

function validateAllowedRoutes(routes: unknown): readonly string[] {
  if (!Array.isArray(routes) || routes.length === 0) {
    throw new Error("allowedRoutes must be a nonempty array");
  }
  return validateForbiddenRoutes(routes);
}

function resolveForbiddenRoutes(routes: unknown): readonly string[] {
  return typeof routes === "function"
    ? validateForbiddenRoutes(routes())
    : validateForbiddenRoutes(routes ?? INITIAL_FORBIDDEN_CUSTOMER_ROUTES);
}

function resolveAllowedRoutes(routes: unknown): readonly string[] | null {
  if (routes == null) return null;
  const resolved = typeof routes === "function" ? routes() : routes;
  return resolved == null ? null : validateAllowedRoutes(resolved);
}

interface RoutePolicy {
  epoch: number | null;
  forbiddenRoutes: readonly string[];
  allowedRoutes: readonly string[] | null;
}

function snapshotRoutePolicy(options: {
  routePolicy?: (() => unknown) | RoutePolicy;
  forbiddenRoutes?: unknown;
  allowedRoutes?: unknown;
}): RoutePolicy {
  const policy =
    typeof options.routePolicy === "function" ? options.routePolicy() : null;
  if (policy != null) {
    if (typeof policy !== "object") {
      throw new Error("routePolicy must return an object");
    }
    const policyRecord = policy as {
      epoch?: unknown;
      forbiddenRoutes?: unknown;
      allowedRoutes?: unknown;
    };
    return Object.freeze({
      epoch:
        typeof policyRecord.epoch === "number" ? policyRecord.epoch : null,
      forbiddenRoutes: validateForbiddenRoutes(
        policyRecord.forbiddenRoutes,
      ),
      allowedRoutes:
        policyRecord.allowedRoutes == null
          ? null
          : validateAllowedRoutes(policyRecord.allowedRoutes),
    });
  }
  return Object.freeze({
    epoch: null,
    forbiddenRoutes: resolveForbiddenRoutes(options.forbiddenRoutes),
    allowedRoutes: resolveAllowedRoutes(options.allowedRoutes),
  });
}

function boundIdentity(identity: unknown): RouteIdentity {
  if (!identity || typeof identity !== "object") {
    throw new Error("DOM identity capture returned no object");
  }
  const record = identity as Record<string, unknown>;
  let url: URL;
  try {
    url = new URL(String(record.url));
  } catch {
    throw new Error("DOM identity capture returned an invalid URL");
  }
  if (!isStrictTauriHashRouteUrl(url.toString())) {
    throw new Error(`DOM identity URL is not a strict tauri route: ${url}`);
  }
  return {
    url: boundedString(url.toString(), MAX_URL_LENGTH),
    route: normalizeMachineRoute(url.hash),
    pathname: boundedString(url.pathname, 256),
    title: boundedString(record.title ?? "", MAX_LABEL_LENGTH),
    readyState: boundedString(record.readyState ?? "unknown", 32),
    activeElement:
      record.activeElement == null
        ? null
        : boundedString(record.activeElement, 64),
    domLength:
      typeof record.domLength === "number" &&
      Number.isSafeInteger(record.domLength)
      ? record.domLength
      : null,
    domHash:
      typeof record.domHash === "string"
        ? boundedString(record.domHash, 128)
        : null,
  };
}

function sortChronologically(
  items: Array<{ capturedAt?: unknown; ordinal?: unknown }>,
): Array<{ capturedAt?: unknown; ordinal?: unknown }> {
  return items.sort((left, right) => {
    const time = String(left.capturedAt).localeCompare(
      String(right.capturedAt),
    );
    return time || Number(left.ordinal ?? 0) - Number(right.ordinal ?? 0);
  });
}

function routePath(route: unknown): string {
  return new URL(
    normalizeMachineRoute(route).slice(1),
    "http://machine-route.invalid",
  ).pathname;
}

function normalizeForbiddenRoutePath(value: unknown): string {
  const path = String(value ?? "")
    .trim()
    .replaceAll("\\", "/")
    .toLowerCase();
  if (!path.startsWith("/")) {
    throw new Error(`invalid forbidden route path: ${String(value)}`);
  }
  return routePath(`#${path}`);
}

function boundExternalOperation(
  value: unknown,
  expectedOperation: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("external operation returned no provenance");
  }
  const record = value as Record<string, unknown>;
  const operation = boundedRequiredString(
    record.operation,
    "external operation",
    MAX_LABEL_LENGTH,
  );
  if (operation !== expectedOperation) {
    throw new Error(
      "external operation provenance does not match the requested operation",
    );
  }
  const guestOperationId = boundedRequiredString(
    record.guestOperationId,
    "guest operation id",
    MAX_LABEL_LENGTH,
  );
  const adapterSessionId = boundedRequiredString(
    record.adapterSessionId,
    "adapter session id",
    MAX_LABEL_LENGTH,
  );
  const session = record.session;
  const daemon = record.daemon;
  const platform = record.platform;
  const log = record.log;
  const vision = record.vision;
  const ui = record.ui;
  for (const [name, fact] of Object.entries({
    session,
    daemon,
    platform,
    log,
    vision,
    ui,
  })) {
    if (!fact || typeof fact !== "object" || Array.isArray(fact)) {
      throw new Error(`external operation ${name} fact is required`);
    }
  }
  return {
    operation,
    guestOperationId,
    adapterSessionId,
    session,
    daemon,
    platform,
    log,
    vision,
    ui,
  };
}

function boundEvidenceEntry(
  entry: Record<string, unknown>,
): Record<string, unknown> {
  if (!entry || typeof entry !== "object") {
    throw new Error("evidence entry must be an object");
  }
  if (entry.type === "checkpoint") {
    return {
      type: "checkpoint",
      label: boundedRequiredString(
        entry.label,
        "checkpoint label",
        MAX_LABEL_LENGTH,
      ),
      identity: boundIdentity(entry.identity),
      screenshot:
        entry.screenshot == null ? null : boundScreenshot(entry.screenshot),
    };
  }
  if (entry.type === "customer-activation") {
    return {
      type: "customer-activation",
      label: boundedRequiredString(
        entry.label,
        "activation label",
        MAX_LABEL_LENGTH,
      ),
      selector: boundedRequiredString(
        entry.selector,
        "activation selector",
        MAX_SELECTOR_LENGTH,
      ),
      input: boundPhysicalInput(entry.input),
      ...(entry.routeBefore == null
        ? {}
        : { routeBefore: normalizeMachineRoute(entry.routeBefore) }),
    };
  }
  if (entry.type === "observation") {
    return {
      type: "observation",
      label: boundedRequiredString(
        entry.label,
        "observation label",
        MAX_LABEL_LENGTH,
      ),
      identity: boundIdentity(entry.identity),
      screenshot:
        entry.screenshot == null ? null : boundScreenshot(entry.screenshot),
    };
  }
  if (entry.type === "route-changed") {
    if (entry.source !== "cdp")
      throw new Error("route evidence source must be CDP");
    return {
      type: "route-changed",
      source: "cdp",
      identity: boundIdentity(entry.identity),
    };
  }
  if (entry.type === "route-barrier") {
    return {
      type: "route-barrier",
      label: boundedRequiredString(
        entry.label,
        "route barrier label",
        MAX_LABEL_LENGTH,
      ),
      forbiddenRoutes: validateForbiddenRoutes(entry.forbiddenRoutes),
      allowedRoutes: validateAllowedRoutes(entry.allowedRoutes),
      armedBeforeInput: entry.armedBeforeInput === true,
      armBaseline: {
        identity: boundIdentity(
          (entry.armBaseline as { identity?: unknown } | undefined)?.identity,
        ),
        route: normalizeMachineRoute(
          (entry.armBaseline as { route?: unknown } | undefined)?.route,
        ),
      },
    };
  }
  if (entry.type === "external-operation") {
    const operationName = boundedRequiredString(
      entry.operation,
      "external operation",
      MAX_LABEL_LENGTH,
    );
    return {
      type: "external-operation",
      label: boundedRequiredString(
        entry.label,
        "external operation label",
        MAX_LABEL_LENGTH,
      ),
      operation: operationName,
      routeBefore: normalizeMachineRoute(entry.routeBefore),
      routeAfter: normalizeMachineRoute(entry.routeAfter),
      provenance: boundExternalOperation(entry.provenance, operationName),
    };
  }
  if (entry.type === "payment-window") {
    const ordinals = entry.continuousCheckpointOrdinals;
    if (
      entry.serialCompleted !== true ||
      entry.postSaleStable !== true ||
      typeof entry.runtimeGeneration !== "string" ||
      entry.runtimeGeneration.trim() === "" ||
      !Array.isArray(ordinals) ||
      ordinals.length !== 3 ||
      ordinals.some(
        (ordinal: unknown) =>
          typeof ordinal !== "number" ||
          !Number.isSafeInteger(ordinal) ||
          ordinal < 0,
      ) ||
      (ordinals as number[])[0] >= (ordinals as number[])[1] ||
      (ordinals as number[])[1] >= (ordinals as number[])[2]
    ) {
      throw new Error(
        "payment window did not prove continuous capture, completion, and stability",
      );
    }
    return {
      type: "payment-window",
      serialCompleted: true,
      postSaleStable: true,
      runtimeGeneration: entry.runtimeGeneration,
      continuousCheckpointOrdinals: [...(ordinals as number[])],
    };
  }
  if (entry.type === "runtime-attestation") {
    const attestation = entry.attestation as
      | { expected?: unknown; observed?: { cdpTarget?: unknown } }
      | undefined;
    return {
      type: "runtime-attestation",
      attestation: bindMachineUiRuntimeEvidence({
        expectedRuntimeAttestation: attestation?.expected,
        observedRuntime: attestation?.observed,
        target: attestation?.observed?.cdpTarget as
          | { id?: unknown; url?: unknown }
          | undefined,
      }),
    };
  }
  throw new Error(`unsupported evidence entry type ${String(entry.type)}`);
}

function boundScreenshot(screenshot: unknown): Record<string, unknown> {
  if (!screenshot || typeof screenshot !== "object") {
    throw new Error("screenshot evidence must be an object");
  }
  const record = screenshot as Record<string, unknown>;
  if (
    typeof record.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.sha256)
  ) {
    throw new Error("screenshot evidence requires a SHA-256 digest");
  }
  if (
    typeof record.byteLength !== "number" ||
    !Number.isSafeInteger(record.byteLength) ||
    record.byteLength < 0 ||
    record.byteLength > MAX_SCREENSHOT_BYTES
  ) {
    throw new Error("screenshot evidence exceeds the maximum size");
  }
  const ref =
    record.ref == null
      ? null
      : boundedRequiredString(record.ref, "screenshot ref", 1_024);
  return {
    sha256: record.sha256 as string,
    byteLength: record.byteLength as number,
    format: record.format === "jpeg" ? "jpeg" : "png",
    ref,
  };
}

function boundPhysicalInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object") {
    throw new Error("activation requires physical CDP Input evidence");
  }
  const record = input as Record<string, unknown>;
  if (
    typeof record.method !== "string" ||
    !record.method.startsWith("Input.")
  ) {
    throw new Error("activation requires physical CDP Input evidence");
  }
  if (record.kind !== "touch" && record.kind !== "mouse") {
    throw new Error("activation input kind is invalid");
  }
  for (const field of ["x", "y"]) {
    const value = record[field];
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      Math.abs(value) > 100_000
    ) {
      throw new Error(`activation input ${field} is invalid`);
    }
  }
  if (record.released !== true)
    throw new Error("activation input was not released");
  return {
    method: record.method as string,
    kind: record.kind as string,
    x: record.x as number,
    y: record.y as number,
    released: true,
  };
}

function normalizeEndpoint(endpoint: unknown): string {
  const url = normalizeEndpointUrl(endpoint);
  url.pathname = url.pathname.replace(/\/json\/?$/, "/");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function normalizeEndpointUrl(endpoint: unknown): URL {
  const url = new URL(String(endpoint));
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("forwarded endpoint must use http or https");
  }
  return url;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  onTimeout?: () => void,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          onTimeout?.();
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function requireBrowserWebSocket(
  socket: unknown,
): asserts socket is BrowserSocket {
  const candidate = socket as Partial<BrowserSocket> | null | undefined;
  if (
    !candidate ||
    typeof candidate.addEventListener !== "function" ||
    typeof candidate.removeEventListener !== "function" ||
    typeof candidate.send !== "function" ||
    typeof candidate.close !== "function"
  ) {
    throw new Error(
      "WebSocket adapter must implement the browser WebSocket EventTarget interface",
    );
  }
}

async function waitForSocketEvent(
  socket: BrowserSocket,
  eventName: string,
  {
    timeoutMs,
    errorLabel,
    listenForError = true,
  }: { timeoutMs: number; errorLabel?: string; listenForError?: boolean },
): Promise<void> {
  let eventHandler: ((event: unknown) => void) | undefined;
  let errorHandler: ((event: unknown) => void) | undefined;
  try {
    await withTimeout(
      new Promise((resolve, reject) => {
        eventHandler = resolve;
        errorHandler = () => reject(new Error(errorLabel ?? "WebSocket error"));
        socket.addEventListener(eventName, eventHandler, { once: true });
        if (listenForError) {
          socket.addEventListener("error", errorHandler, { once: true });
        }
      }),
      timeoutMs,
      `CDP WebSocket ${eventName}`,
    );
  } finally {
    if (eventHandler !== undefined) {
      socket.removeEventListener(eventName, eventHandler);
    }
    if (listenForError && errorHandler !== undefined) {
      socket.removeEventListener("error", errorHandler);
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function findAvailableLocalPort(host: string): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("SSH tunnel local port did not bind to a TCP address");
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function waitForTcpEndpoint({
  host,
  port,
  timeoutMs,
  pollMs,
}: {
  host: string;
  port: number;
  timeoutMs: number;
  pollMs: number;
}): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  do {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = connect({ host, port });
        socket.once("connect", () => {
          socket.destroy();
          resolve();
        });
        socket.once("error", (error) => {
          socket.destroy();
          reject(error);
        });
      });
      return;
    } catch (error) {
      lastError = error;
      await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    }
  } while (Date.now() < deadline);
  throw new Error(
    `SSH tunnel readiness timed out: ${errorMessage(lastError) || "unreachable"}`,
  );
}

function watchChildStartup(
  child: ChildProcess,
  getStderr: () => string,
): { failure: Promise<never>; stop: () => void } {
  let onError: (error: Error) => void;
  let onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
  const failure = new Promise<never>((_, reject) => {
    onError = (error: Error) =>
      reject(
        new Error(`SSH tunnel process error: ${error.message}`, {
          cause: error,
        }),
      );
    onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      const detail = getStderr().trim();
      reject(
        new Error(
          `SSH tunnel exited before readiness (code=${String(code)}, signal=${String(signal)})${detail ? `: ${detail}` : ""}`,
        ),
      );
    };
    child.once("error", onError);
    child.once("exit", onExit);
  });
  return {
    failure,
    stop() {
      child.removeListener?.("error", onError);
      child.removeListener?.("exit", onExit);
    },
  };
}

async function terminateChildProcess(
  child: ChildProcess,
  processAdapter: ProcessAdapter,
  timeoutMs: number,
): Promise<void> {
  return terminateChildProcessWithOptions(child, processAdapter, timeoutMs);
}

async function terminateChildProcessWithOptions(
  child: ChildProcess,
  processAdapter: ProcessAdapter,
  timeoutMs: number,
  { termAlreadySent = false }: { termAlreadySent?: boolean } = {},
): Promise<void> {
  if (!child || child.exitCode != null) return;
  const wait = (limit: number): Promise<unknown> =>
    processAdapter.waitForExit?.(child, limit) ?? waitForExit(child, limit);
  if (!termAlreadySent) child.kill?.("SIGTERM");
  try {
    await wait(timeoutMs);
  } catch {
    if (child.exitCode != null) return;
    child.kill?.("SIGKILL");
    await wait(timeoutMs);
  }
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode != null) return;
  let onExit: () => void;
  let onError: (error: Error) => void;
  await withTimeout(
    new Promise<void>((resolve, reject) => {
      onExit = () => resolve();
      onError = reject;
      child.once("exit", onExit);
      child.once("error", onError);
    }),
    timeoutMs,
    "child process exit",
  ).finally(() => {
    child.removeListener?.("exit", onExit);
    child.removeListener?.("error", onError);
  });
}

function formatSshHost(host: unknown): string {
  return String(host).includes(":") ? `[${host}]` : String(host);
}

function formatUrlHost(host: unknown): string {
  return String(host).includes(":") ? `[${host}]` : String(host);
}

function boundedString(value: unknown, maxLength: number): string {
  return String(value ?? "").slice(0, maxLength);
}

function nowIso(clock?: () => Date): string {
  const value = clock?.() ?? new Date();
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function formatExpectedRoute(expected: RouteMatcher): string {
  if (expected instanceof RegExp) return expected.toString();
  if (typeof expected === "function") return "predicate";
  return JSON.stringify(expected);
}

function normalizeWindowsRuntimeObservation(
  observation: unknown,
  { remoteCdpPort }: { remoteCdpPort?: number } = {},
): NormalizedWindowsRuntimeObservation {
  if (!observation || typeof observation !== "object") {
    throw new Error("Windows runtime inspection returned no object");
  }
  const record = observation as Record<string, unknown>;
  const machine = normalizeWindowsProcessObservation(
    record.machine,
    "machine",
  );
  const cdpListener = normalizeWindowsProcessObservation(
    record.cdpListener,
    "cdpListener",
  );
  const cdpListenerRecord = record.cdpListener as Record<string, unknown>;
  const machineAncestorProcessId =
    cdpListenerRecord.machineAncestorProcessId as number;
  const localAddress = cdpListenerRecord.localAddress as string;
  const localPort = cdpListenerRecord.localPort as number;
  if (
    typeof cdpListenerRecord.machineAncestorProcessId !== "number" ||
    !Number.isSafeInteger(cdpListenerRecord.machineAncestorProcessId) ||
    cdpListenerRecord.machineAncestorProcessId <= 0
  ) {
    throw new Error(
      "Windows runtime inspection requires cdpListener.machineAncestorProcessId",
    );
  }
  if (cdpListenerRecord.localAddress !== "127.0.0.1") {
    throw new Error(
      "Windows runtime inspection requires a loopback CDP listener",
    );
  }
  if (
    typeof cdpListenerRecord.localPort !== "number" ||
    !Number.isSafeInteger(cdpListenerRecord.localPort) ||
    cdpListenerRecord.localPort <= 0
  ) {
    throw new Error(
      "Windows runtime inspection requires cdpListener.localPort",
    );
  }
  if (
    remoteCdpPort != null &&
    cdpListenerRecord.localPort !== remoteCdpPort
  ) {
    throw new Error(
      `Windows runtime inspection CDP port mismatch: expected ${remoteCdpPort}, observed ${localPort}`,
    );
  }
  return {
    machine,
    cdpListener: {
      ...cdpListener,
      machineAncestorProcessId,
      localAddress,
      localPort,
    },
  };
}

function normalizeWindowsProcessObservation(
  process: unknown,
  label: string,
): NormalizedWindowsProcessObservation {
  if (!process || typeof process !== "object") {
    throw new Error(`Windows runtime inspection requires ${label}`);
  }
  const record = process as Record<string, unknown>;
  for (const field of ["processId", "sessionId"]) {
    const value = record[field];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`Windows runtime inspection requires ${label}.${field}`);
    }
  }
  return {
    processId: record.processId as number,
    executablePath: normalizeWindowsPath(record.executablePath as string),
    sessionId: record.sessionId as number,
    principal: normalizeWindowsPrincipal(record.principal as string),
  };
}

function normalizeWindowsPath(value: unknown): string {
  const path = String(value ?? "")
    .trim()
    .replaceAll("/", "\\");
  if (!/^[A-Za-z]:\\/.test(path) || /[\0\r\n]/.test(path)) {
    throw new Error("Windows executable path must be an absolute drive path");
  }
  const segments = [];
  for (const segment of path.slice(3).split("\\")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) {
        throw new Error("Windows executable path escapes its drive root");
      }
      segments.pop();
    } else {
      segments.push(segment.toLowerCase());
    }
  }
  if (segments.length === 0)
    throw new Error("Windows executable path is incomplete");
  return `${path.slice(0, 2).toLowerCase()}\\${segments.join("\\")}`;
}

function normalizeWindowsPrincipal(value: unknown): string {
  const principal = String(value ?? "").trim();
  if (
    !/^[^\\\0\r\n]+\\[^\\\0\r\n]+$/.test(principal) ||
    principal.length > 512
  ) {
    throw new Error("Windows process principal must be an exact Domain\\User");
  }
  return principal;
}

function boundedRequiredString(
  value: unknown,
  label: string,
  maxLength: number,
): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength)
    throw new Error(`${label} exceeds maximum length`);
  return normalized;
}

export async function runWindowsPowerShellOverSsh({
  remote,
  sshPort,
  identityFile,
  certificateFile,
  sshKnownHostsPath,
  sshHostKeyAlias,
  sshArgs = [],
  timeoutMs,
  script,
}: SshRunOptions): Promise<unknown> {
  return runWindowsPowerShellOverSshWithAdapter(
    {
      remote,
      sshPort,
      identityFile,
      certificateFile,
      sshKnownHostsPath,
      sshHostKeyAlias,
      sshArgs,
      timeoutMs,
      script,
    },
    defaultProcessAdapter,
  );
}

export async function runWindowsPowerShellOverSshForTest(
  options: SshRunOptions,
  {
    processAdapter = defaultProcessAdapter,
    shutdownTimeoutMs = 1_000,
  }: { processAdapter?: ProcessAdapter; shutdownTimeoutMs?: number } = {},
): Promise<unknown> {
  return runWindowsPowerShellOverSshWithAdapter(
    { ...options, shutdownTimeoutMs },
    processAdapter,
  );
}

async function runWindowsPowerShellOverSshWithAdapter(
  {
    remote,
    sshPort,
    identityFile,
    certificateFile,
    sshKnownHostsPath,
    sshHostKeyAlias,
    sshArgs = [],
    timeoutMs = DEFAULT_TIMEOUT_MS,
    shutdownTimeoutMs = 1_000,
    script,
  }: SshRunOptions & { shutdownTimeoutMs?: number },
  processAdapter: ProcessAdapter,
): Promise<unknown> {
  if (typeof remote !== "string" || remote.trim() === "") {
    throw new Error("remote is required for Windows runtime inspection");
  }
  if (typeof script !== "string") {
    throw new Error("script is required for Windows runtime inspection");
  }
  const encodedScript = Buffer.from(script, "utf16le").toString(
    "base64",
  );
  const args = [
    "-o",
    "BatchMode=yes",
    ...(sshPort ? ["-p", String(sshPort)] : []),
    ...(identityFile ? ["-i", identityFile] : []),
    ...(certificateFile ? ["-o", `CertificateFile=${certificateFile}`] : []),
    ...(sshKnownHostsPath
      ? ["-o", `UserKnownHostsFile=${sshKnownHostsPath}`]
      : []),
    ...(sshHostKeyAlias ? ["-o", `HostKeyAlias=${sshHostKeyAlias}`] : []),
    ...sshArgs,
    remote,
    "powershell.exe",
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    encodedScript,
  ];
  const child = processAdapter.spawn("ssh", args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let outputError: Error | null = null;
  const append = (current: string, chunk: unknown, label: string): string => {
    const next = `${current}${String(chunk)}`;
    if (Buffer.byteLength(next, "utf8") > MAX_REMOTE_OUTPUT_BYTES) {
      if (outputError === null) {
        outputError = new Error(
          `Windows runtime inspection ${label} exceeded maximum output`,
        );
      }
      child.kill("SIGTERM");
      return current;
    }
    return next;
  };
  child.stdout.on("data", (chunk: Buffer) => {
    stdout = append(stdout, chunk, "stdout");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = append(stderr, chunk, "stderr");
  });
  let timedOut = false;
  let result: { code: number | null; signal: NodeJS.Signals | null };
  try {
    result = await withTimeout(
      new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
        },
      ),
      timeoutMs,
      "Windows runtime inspection",
      () => {
        timedOut = true;
        child.kill?.("SIGTERM");
      },
    );
  } catch (error) {
    await terminateChildProcessWithOptions(
      child,
      processAdapter,
      shutdownTimeoutMs,
      { termAlreadySent: timedOut },
    ).catch(() => {});
    throw error;
  }
  if (outputError) throw outputError;
  if (result.code !== 0) {
    throw new Error(
      `Windows runtime inspection failed (code=${String(result.code)}, signal=${String(result.signal)}): ${boundedString(stderr.trim() || stdout.trim(), 4_096)}`,
    );
  }
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(
      `Windows runtime inspection returned invalid JSON: ${boundedString(errorMessage(error), 512)}`,
      { cause: error },
    );
  }
}

const defaultProcessAdapter: ProcessAdapter = { spawn };

function assertProductionScenarioOptions(options: ScenarioOptions): void {
  if (!options || typeof options !== "object") {
    throw new Error("scenario options must be an object");
  }
  for (const field of [
    "endpoint",
    "remoteCommandRunner",
    "fetchImpl",
    "webSocketFactory",
    "processAdapter",
    "adapter",
  ]) {
    if (Object.hasOwn(options, field)) {
      throw new Error(
        `${field} is test-only and cannot be used for production acceptance`,
      );
    }
  }
  sanitizeProductionTunnelOptions(options.tunnelOptions);
}

function sanitizeProductionTunnelOptions(
  tunnelOptions: TunnelOptions | null | undefined = {},
): TunnelOptions {
  if (tunnelOptions == null) return {};
  if (typeof tunnelOptions !== "object" || Array.isArray(tunnelOptions)) {
    throw new Error("tunnelOptions must be an object");
  }
  const prototype = Object.getPrototypeOf(tunnelOptions);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("tunnelOptions must be a plain object");
  }
  for (const key of Reflect.ownKeys(tunnelOptions)) {
    if (typeof key !== "string") {
      throw new Error("tunnelOptions cannot use symbol keys");
    }
    if (!PRODUCTION_TUNNEL_OPTION_KEYS.has(key)) {
      throw new Error(
        `tunnelOptions.${key} is not allowed for production acceptance`,
      );
    }
  }
  return selectTunnelTransportFields(tunnelOptions);
}

function selectTunnelTransportFields(tunnelOptions: TunnelOptions = {}): TunnelOptions {
  const selected: TunnelOptions = {};
  for (const key of PRODUCTION_TUNNEL_OPTION_KEYS) {
    if (Object.hasOwn(tunnelOptions, key)) selected[key] = tunnelOptions[key];
  }
  return selected;
}

function buildSidecarTunnelOptions(
  tunnelTransport: TunnelOptions,
  inspectedRuntime: NormalizedWindowsRuntimeObservation,
): TunnelOptions {
  const sidecarOptions: TunnelOptions = {};
  for (const key of [
    "remote",
    "sshPort",
    "identityFile",
    "certificateFile",
    "sshKnownHostsPath",
    "sshHostKeyAlias",
    "sshArgs",
  ]) {
    if (Object.hasOwn(tunnelTransport, key)) {
      sidecarOptions[key] = tunnelTransport[key];
    }
  }
  return {
    ...sidecarOptions,
    remoteCdpHost: "127.0.0.1",
    remoteCdpPort: inspectedRuntime.cdpListener.localPort,
  };
}

function parseCliArgs(argv: string[]): ScenarioOptions {
  const attestation: {
    targetId?: string;
    machine: {
      processId?: number;
      sessionId?: number;
      executablePath?: string;
      principal?: string;
    };
  } = {
    machine: {},
  };
  const options: ScenarioOptions = {
    steps: [],
    expectedRuntimeAttestation: attestation,
  };
  const steps = options.steps ?? [];
  options.steps = steps;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[index];
    };
    if (arg === "--remote") {
      options.tunnelOptions ??= {};
      options.tunnelOptions.remote = next();
    } else if (arg === "--identity") {
      options.tunnelOptions ??= {};
      options.tunnelOptions.identityFile = next();
    } else if (arg === "--certificate") {
      options.tunnelOptions ??= {};
      options.tunnelOptions.certificateFile = next();
    } else if (arg === "--ssh-port") {
      options.tunnelOptions ??= {};
      options.tunnelOptions.sshPort = Number(next());
    } else if (arg === "--remote-cdp-port") {
      options.tunnelOptions ??= {};
      options.tunnelOptions.remoteCdpPort = Number(next());
    } else if (arg === "--target-id") {
      attestation.targetId = next();
    } else if (arg === "--machine-process-id") {
      attestation.machine.processId = Number(next());
    } else if (arg === "--machine-session-id") {
      attestation.machine.sessionId = Number(next());
    } else if (arg === "--machine-path") {
      attestation.machine.executablePath = next();
    } else if (arg === "--machine-principal") {
      attestation.machine.principal = next();
    } else if (arg === "--sequence") options.sequenceName = next();
    else if (arg === "--initial-route") options.expectedInitialRoute = next();
    else if (arg === "--mouse") options.inputKind = "mouse";
    else if (arg === "--screenshot") options.screenshotCheckpoints = true;
    else if (arg === "--step") {
      const [name, selector, routeBefore, routeAfter] = next().split("::");
      steps.push({
        type: "customer-activation",
        name,
        selector,
        routeBefore,
        routeAfter,
      });
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const result = await runVisibleMachineSaleScenario(
      parseCliArgs(process.argv.slice(2)),
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    const message =
      error instanceof Error && error.stack !== undefined
        ? error.stack
        : errorMessage(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
