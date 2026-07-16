#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { connect, createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

const STRICT_TAURI_HOST = "tauri.localhost";
const DEFAULT_REMOTE_CDP_PORT = 9222;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_ROUTE_POLL_MS = 100;
const MAX_URL_LENGTH = 2_048;
const MAX_LABEL_LENGTH = 160;
const MAX_SELECTOR_LENGTH = 512;
const MAX_TARGET_ID_LENGTH = 512;
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
const INITIAL_FORBIDDEN_CUSTOMER_ROUTES = [
  "/maintenance",
  "/offline",
  "/bring-up",
];
const PAYMENT_BARRIER_ALLOWED_ROUTES = ["/payment", "/dispensing", "/result"];
const PAYMENT_BARRIER_TERMINAL_ROUTES = ["/dispensing", "/result"];
const PAYMENT_BARRIER_COMPLETED_ALLOWED_ROUTES = [
  ...PAYMENT_BARRIER_ALLOWED_ROUTES,
  "/catalog",
];
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

export function isStrictTauriHashRouteUrl(value) {
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

export function matchesRoute(value, expected) {
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

export function routeFromTauriUrl(value) {
  const url = new URL(String(value));
  if (!isStrictTauriHashRouteUrl(url.toString())) {
    throw new Error(`not a strict tauri route URL: ${url}`);
  }
  return normalizeMachineRoute(url.hash);
}

export function normalizeMachineRoute(value) {
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

export function validateExpectedRuntimeAttestation(attestation) {
  if (!attestation || typeof attestation !== "object") {
    throw new Error("expectedRuntimeAttestation is required");
  }
  if (
    typeof attestation.targetId !== "string" ||
    attestation.targetId.trim() === ""
  ) {
    throw new Error("expectedRuntimeAttestation.targetId is required");
  }
  const machine = attestation.machine;
  if (!machine || typeof machine !== "object") {
    throw new Error("expectedRuntimeAttestation.machine is required");
  }
  for (const field of ["processId", "sessionId"]) {
    if (!Number.isSafeInteger(machine[field]) || machine[field] <= 0) {
      throw new Error(
        `expectedRuntimeAttestation.machine.${field} must be a positive integer`,
      );
    }
  }
  for (const field of ["executablePath", "principal"]) {
    if (typeof machine[field] !== "string" || machine[field].trim() === "") {
      throw new Error(
        `expectedRuntimeAttestation.machine.${field} is required`,
      );
    }
  }
  return {
    targetId: boundedRequiredString(
      attestation.targetId,
      "expectedRuntimeAttestation.targetId",
      MAX_TARGET_ID_LENGTH,
    ),
    machine: {
      processId: machine.processId,
      sessionId: machine.sessionId,
      executablePath: normalizeWindowsPath(machine.executablePath),
      principal: normalizeWindowsPrincipal(machine.principal),
    },
  };
}

export function rewriteWebSocketDebuggerUrl(
  webSocketDebuggerUrl,
  forwardedEndpoint,
) {
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

export function assertTargetDebuggerWebSocketUrl(
  webSocketDebuggerUrl,
  targetId,
) {
  const id = boundedRequiredString(
    targetId,
    "CDP target id",
    MAX_TARGET_ID_LENGTH,
  );
  let url;
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
} = {}) {
  if (!endpoint) throw new Error("endpoint is required");
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");
  if (typeof expectedTargetId !== "string" || expectedTargetId.trim() === "") {
    throw new Error("expectedTargetId is required");
  }
  const jsonEndpoint = new URL("/json", normalizeEndpoint(endpoint));
  const response = await withTimeout(
    fetchImpl(jsonEndpoint),
    timeoutMs,
    "CDP target discovery",
  );
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

  const candidates = targets.filter((candidate) =>
    isStrictTauriHashRouteUrl(candidate?.url),
  );
  if (candidates.length !== 1) {
    throw new Error(
      `CDP target discovery requires exactly one strict tauri target; found ${candidates.length}`,
    );
  }
  const target = candidates[0];
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
} = {}) {
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
  options = {},
  { commandRunner = runWindowsPowerShellOverSsh } = {},
) {
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
  } = {},
  commandRunner,
) {
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
} = {}) {
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
  for (const field of [
    "processId",
    "sessionId",
    "executablePath",
    "principal",
  ]) {
    if (actualMachine[field] !== expectedMachine[field]) {
      throw new Error(
        `Windows machine process ${field} mismatch: expected ${String(expectedMachine[field])}, observed ${String(actualMachine[field])}`,
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
} = {}) {
  const normalizedMachinePath = normalizeWindowsPath(machinePath);
  if (!Number.isSafeInteger(remoteCdpPort) || remoteCdpPort <= 0) {
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
if ($machine.Count -ne 1) { throw "expected exactly one machine.exe at $machinePath, found $($machine.Count)" }
$machineCim = $machine[0]
$machineProcess = Get-Process -Id ([int]$machineCim.ProcessId) -ErrorAction Stop
$machineOwner = Invoke-CimMethod -InputObject $machineCim -MethodName GetOwner -ErrorAction Stop
$machinePrincipal = "{0}\\{1}" -f [string]$machineOwner.Domain, [string]$machineOwner.User
if ([string]::IsNullOrWhiteSpace([string]$machineOwner.Domain) -or [string]::IsNullOrWhiteSpace([string]$machineOwner.User)) { throw 'machine.exe owner must include Domain and User' }
$listeners = @(Get-NetTCPConnection -LocalPort ${remoteCdpPort} -State Listen -ErrorAction Stop | Where-Object {
  [string]$_.LocalAddress -ceq '127.0.0.1'
})
if ($listeners.Count -ne 1) { throw "expected exactly one loopback CDP listener on port ${remoteCdpPort}, found $($listeners.Count)" }
$listenerCim = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$listeners[0].OwningProcess)" -ErrorAction Stop
$listenerProcess = Get-Process -Id ([int]$listenerCim.ProcessId) -ErrorAction Stop
$listenerOwner = Invoke-CimMethod -InputObject $listenerCim -MethodName GetOwner -ErrorAction Stop
$listenerPrincipal = "{0}\\{1}" -f [string]$listenerOwner.Domain, [string]$listenerOwner.User
if ([string]::IsNullOrWhiteSpace([string]$listenerOwner.Domain) -or [string]::IsNullOrWhiteSpace([string]$listenerOwner.User)) { throw 'CDP listener owner must include Domain and User' }
$cursor = $listenerCim
$ancestor = $null
for ($depth = 0; $depth -lt 32 -and $null -ne $cursor; $depth += 1) {
  if ([int]$cursor.ProcessId -eq [int]$machineCim.ProcessId) { $ancestor = [int]$machineCim.ProcessId; break }
  $parentId = [int]$cursor.ParentProcessId
  if ($parentId -le 0 -or $parentId -eq [int]$cursor.ProcessId) { break }
  $cursor = Get-CimInstance Win32_Process -Filter "ProcessId = $parentId" -ErrorAction SilentlyContinue
}
if ($null -eq $ancestor) { throw 'CDP listener is not descended from machine.exe' }
if ([int]$listenerProcess.SessionId -ne [int]$machineProcess.SessionId) { throw 'CDP listener session differs from machine.exe' }
if ($listenerPrincipal -cne $machinePrincipal) { throw 'CDP listener principal differs from machine.exe' }
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
} = {}) {
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
  let child;
  try {
    child = processAdapter.spawn("ssh", args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (error) {
    throw new Error(`SSH tunnel spawn failed: ${error.message}`, {
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

export class CdpClient {
  constructor(webSocketUrl, options = {}) {
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
  }

  async connect({ timeoutMs = this.defaultTimeoutMs } = {}) {
    if (this.socket) return this;
    let socket;
    try {
      socket = this.webSocketFactory(this.webSocketUrl);
    } catch (error) {
      throw new Error(
        `CDP WebSocket creation failed: ${boundedString(error.message, 512)}`,
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
    if (socket.readyState === 1) return this;
    try {
      await waitForSocketEvent(socket, "open", {
        timeoutMs,
        errorLabel: "CDP WebSocket failed to open",
      });
    } catch (error) {
      await this.close({ timeoutMs }).catch(() => {});
      throw error;
    }
    return this;
  }

  async send(method, params = {}, { timeoutMs = this.defaultTimeoutMs } = {}) {
    if (!this.socket || this.closed || this.socket.readyState !== 1) {
      throw new Error("CDP client is closed");
    }
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    let resolveResponse;
    let rejectResponse;
    const response = new Promise((resolve, reject) => {
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
      throw new Error(`CDP ${method} send failed: ${error.message}`, {
        cause: error,
      });
    }
    return response;
  }

  on(method, handler) {
    if (!this.eventHandlers.has(method)) this.eventHandlers.set(method, []);
    this.eventHandlers.get(method).push(handler);
    return () => {
      const handlers = this.eventHandlers.get(method) ?? [];
      this.eventHandlers.set(
        method,
        handlers.filter((candidate) => candidate !== handler),
      );
    };
  }

  async waitForEvent(
    method,
    predicate = () => true,
    { timeoutMs = this.defaultTimeoutMs } = {},
  ) {
    let off;
    return withTimeout(
      new Promise((resolve) => {
        off = this.on(method, (params) => {
          if (predicate(params)) resolve(params);
        });
      }).finally(() => off?.()),
      timeoutMs,
      `CDP event ${method}`,
      () => off?.(),
    );
  }

  async close({ timeoutMs = this.defaultTimeoutMs } = {}) {
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

  #handleMessage(event) {
    let message;
    try {
      if (typeof event?.data !== "string") {
        throw new Error("browser WebSocket message data must be a string");
      }
      message = JSON.parse(event.data);
    } catch (error) {
      this.#handleError(error);
      return;
    }

    if (message.id != null) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(
          new Error(
            `CDP ${pending.method} failed: ${message.error.message ?? "error"}`,
          ),
        );
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }

    if (message.method) {
      for (const handler of this.eventHandlers.get(message.method) ?? []) {
        try {
          handler(message.params ?? {});
        } catch (error) {
          this.#handleError(error);
        }
      }
    }
  }

  #handleClose() {
    this.closed = true;
    this.#rejectPending(new Error("CDP connection closed"));
  }

  #handleError(event) {
    const error =
      event instanceof Error
        ? event
        : new Error(event?.message ?? "CDP WebSocket error");
    this.#rejectPending(error);
    if (!this.closed) {
      this.closed = true;
      if (this.socket?.readyState === 0 || this.socket?.readyState === 1) {
        this.socket.close();
      }
    }
  }

  #rejectPending(error) {
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

export async function enablePageRuntime(client) {
  await client.send("Runtime.enable");
  await client.send("Page.enable");
}

export async function evaluateExpression(
  client,
  expression,
  { timeoutMs, returnByValue = true } = {},
) {
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
  if (result.exceptionDetails) {
    throw new Error(
      `Runtime.evaluate failed: ${result.exceptionDetails.text ?? "exception"}`,
    );
  }
  return result.result?.value;
}

async function injectDebugDisturbance(client, disturbance, options = {}) {
  const injection = await evaluateExpression(
    client,
    `(() => {
      const control = window.__VEM_INSTALLED_KIOSK_SALE_DEBUG__;
      if (!control || typeof control.inject !== "function" || typeof control.readEvidence !== "function") {
        throw new Error("installed kiosk sale debug disturbance control is unavailable");
      }
      return Promise.resolve(control.inject(${JSON.stringify(disturbance)})).then(() => {
        const injections = control.readEvidence()?.disturbanceInjections;
        return Array.isArray(injections) ? injections[injections.length - 1] ?? null : null;
      });
    })()`,
    options,
  );
  const expectedState =
    disturbance === "catalog_refresh" ? "catalog" : "readiness";
  if (
    injection?.kind !== disturbance ||
    injection.count !== 1 ||
    injection.outcome !== "completed" ||
    injection.pressure?.refreshedState !== expectedState ||
    injection.pressure?.routeAuthorityWon !== true ||
    injection.pressure?.resolvedRoute !== "/payment" ||
    injection.pressure.attemptedRoute === injection.pressure.resolvedRoute
  ) {
    throw new Error(
      `${disturbance} did not prove competing navigation pressure during payment`,
    );
  }
  return {
    injectionId: boundedRequiredString(
      injection.injectionId,
      "debug disturbance injection id",
      MAX_LABEL_LENGTH,
    ),
    kind: disturbance,
    count: 1,
    outcome: "completed",
    pressure: {
      refreshedState: expectedState,
      attemptedRoute: boundedRequiredString(
        injection.pressure.attemptedRoute,
        "debug disturbance attempted route",
        MAX_URL_LENGTH,
      ),
      resolvedRoute: "/payment",
      routeAuthorityWon: true,
    },
  };
}

export async function captureDomIdentity(client, options = {}) {
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

export async function captureScreenshot(client, options = {}) {
  const format = options.format ?? "png";
  if (format !== "png" && format !== "jpeg") {
    throw new Error("screenshot format must be png or jpeg");
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
  if (typeof result.data !== "string") {
    throw new Error("Page.captureScreenshot returned no image data");
  }
  if (result.data.length > Math.ceil((MAX_SCREENSHOT_BYTES * 4) / 3) + 4) {
    throw new Error("Page.captureScreenshot exceeded the maximum size");
  }
  if (
    result.data.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(result.data)
  ) {
    throw new Error("Page.captureScreenshot returned invalid base64");
  }
  const bytes = Buffer.from(result.data, "base64");
  if (bytes.length > MAX_SCREENSHOT_BYTES) {
    throw new Error("Page.captureScreenshot exceeded the maximum size");
  }
  if (bytes.toString("base64") !== result.data) {
    throw new Error("Page.captureScreenshot returned noncanonical base64");
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  let ref = null;
  if (options.screenshotSink) {
    const sinkResult = await options.screenshotSink({
      bytes,
      sha256,
      format,
      label: options.label ?? "screenshot",
    });
    ref = typeof sinkResult === "string" ? sinkResult : sinkResult?.ref;
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

export async function captureCheckpoint(client, label, options = {}) {
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

export async function probeSelectorBounds(client, selector, options = {}) {
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
      const element = document.querySelector(selector);
      if (!element) return { selector, exists: false, actionable: false };
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const center = {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2
      };
      const inViewport = (
        rect.left >= 0 && rect.top >= 0 &&
        rect.right <= innerWidth && rect.bottom <= innerHeight
      );
      const hit = inViewport ? document.elementFromPoint(center.x, center.y) : null;
      const hitTarget = hit === element || element.contains(hit);
      const actionable = (
        rect.width > 0 && rect.height > 0 && inViewport && hitTarget &&
        style.visibility !== "hidden" && style.display !== "none" &&
        style.pointerEvents !== "none" && Number(style.opacity || "1") > 0 &&
        !element.hasAttribute("disabled") &&
        element.getAttribute("aria-disabled") !== "true"
      );
      return {
        selector,
        exists: true,
        actionable,
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
  client,
  point,
  { kind = "touch", timeoutMs } = {},
) {
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
  let primaryError;
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
  } catch (error) {
    primaryError = error;
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
      if (!primaryError) primaryError = releaseError;
    }
  }
  if (primaryError) throw primaryError;
  return { method, kind, x, y, released: true };
}

export async function activateVisibleSelector(client, selector, options = {}) {
  const probe = await probeSelectorBounds(client, selector, options);
  if (!probe?.actionable) {
    throw new Error(`selector is not physically actionable: ${selector}`);
  }
  const input = await dispatchPhysicalInput(client, probe.center, options);
  return {
    selector,
    center: probe.center,
    bounds: probe.bounds,
    input,
  };
}

export async function waitForRoute(client, expected, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_ROUTE_POLL_MS;
  const deadline = Date.now() + timeoutMs;
  let lastIdentity = null;
  do {
    options.assertHealthy?.();
    lastIdentity = await captureDomIdentity(client, options);
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

export function assertRouteIdentity(identity, expected, label = "route") {
  if (!matchesRoute(identity?.route, expected)) {
    throw new Error(
      `${label} route mismatch: expected ${formatExpectedRoute(expected)}, got ${identity?.route ?? "unknown"}`,
    );
  }
}

export function startContinuousIdentityCapture(client, options = {}) {
  const intervalMs =
    options.intervalMs ?? DEFAULT_CONTINUOUS_CAPTURE_INTERVAL_MS;
  const maxCheckpoints = options.maxCheckpoints ?? MAX_CONTINUOUS_CHECKPOINTS;
  if (!Number.isSafeInteger(maxCheckpoints) || maxCheckpoints <= 0) {
    throw new Error(
      "continuous capture maxCheckpoints must be a positive integer",
    );
  }
  const checkpoints = [];
  let stopped = false;
  let inFlight = null;
  let failure = null;
  let ordinal = options.startOrdinal ?? 0;

  const capture = () => {
    if (stopped || inFlight || failure) return;
    // A capture can complete after a payment barrier is armed. Its route must be
    // judged by the policy that existed when the capture began, not afterward.
    const policy = snapshotRoutePolicy(options);
    inFlight = captureCheckpoint(client, options.label ?? "continuous", options)
      .then((checkpoint) => {
        if (checkpoints.length >= maxCheckpoints) {
          throw new Error(
            "continuous capture exceeded maximum evidence entries",
          );
        }
        checkpoint.ordinal = ordinal++;
        assertAllowedRoute(
          checkpoint.identity.route,
          policy.forbiddenRoutes,
          policy.allowedRoutes,
        );
        checkpoints.push(checkpoint);
      })
      .catch((error) => {
        failure = new Error(`continuous capture failed: ${error.message}`, {
          cause: error,
        });
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

export async function runVisibleMachineSaleScenario(options = {}) {
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
  options = {},
  testDependencies = {},
) {
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

async function runVisibleMachineSaleScenarioInternal(options, dependencies) {
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
    routeActions: 0,
  };
  let activeForbiddenRoutes = validateForbiddenRoutes(initialForbiddenRoutes);
  let activeAllowedRoutes = null;
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
  const inspectedRuntime = normalizeWindowsRuntimeObservation(observedRuntime, {
    remoteCdpPort: inspectionRemoteCdpPort,
  });
  const sidecar = await dependencies.openSidecar(
    buildSidecarTunnelOptions(tunnelTransport, inspectedRuntime),
  );
  let client;
  let capture;
  let unsubscribeCdpRoutes;
  let scenarioError;
  let scenarioResult;
  const evidence = [];
  let ordinal = 0;
  let fatalError = null;
  const record = (entry) => {
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
  const classifyRouteEvent = (event, source = "adapter") => {
    if (fatalError) return;
    try {
      const policy = currentRoutePolicy();
      const identity = boundIdentity(event?.identity ?? event);
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
      fatalError = new Error(`route capture failed: ${error.message}`, {
        cause: error,
      });
    }
  };
  const assertHealthy = () => {
    capture?.throwIfFailed();
    if (fatalError) throw fatalError;
  };

  try {
    const target = await discoverMachineUiTarget({
      endpoint: sidecar.endpoint,
      expectedTargetId: expectedRuntime.targetId,
      fetchImpl: dependencies.fetchImpl,
      timeoutMs,
    });
    const runtimeEvidence = bindMachineUiRuntimeEvidence({
      expectedRuntimeAttestation: expectedRuntime,
      observedRuntime: inspectedRuntime,
      target,
    });
    record({ type: "runtime-attestation", attestation: runtimeEvidence });
    if (!matchesRoute(target.route, expectedInitialRoute)) {
      throw new Error(
        `initial CDP target route mismatch: expected ${formatExpectedRoute(expectedInitialRoute)}, got ${target.route}`,
      );
    }
    assertAllowedRoute(
      target.route,
      activeForbiddenRoutes,
      activeAllowedRoutes,
    );
    const webSocketUrl = rewriteWebSocketDebuggerUrl(
      target.webSocketDebuggerUrl,
      sidecar.endpoint,
    );
    client = new CdpClient(webSocketUrl, {
      webSocketFactory: dependencies.webSocketFactory,
      defaultTimeoutMs: timeoutMs,
    });
    await client.connect({ timeoutMs });

    // Route listeners are installed before protocol enablement or scenario actions.
    const offWithinDocument = client.on(
      "Page.navigatedWithinDocument",
      (params) => classifyRouteEvent({ url: params.url }, "cdp"),
    );
    const offFrameNavigated = client.on("Page.frameNavigated", (params) => {
      if (params.frame?.parentId == null) {
        classifyRouteEvent({ url: params.frame?.url }, "cdp");
      }
    });
    const offCdpRoutes = () => {
      offWithinDocument();
      offFrameNavigated();
    };
    unsubscribeCdpRoutes = offCdpRoutes;

    await enablePageRuntime(client);
    assertHealthy();
    capture = continuousCapture
      ? startContinuousIdentityCapture(client, {
          intervalMs: continuousCaptureIntervalMs,
          screenshot: screenshotCheckpoints,
          screenshotSink: adapter.screenshotSink,
          routePolicy: currentRoutePolicy,
          timeoutMs,
          clock,
          startOrdinal: 1_000_000,
          maxCheckpoints: MAX_CONTINUOUS_CHECKPOINTS,
        })
      : null;

    const initial = await captureCheckpoint(client, "initial", {
      timeoutMs,
      screenshot: screenshotCheckpoints,
      screenshotSink: adapter.screenshotSink,
      clock,
    });
    assertAllowedRoute(
      initial.identity.route,
      activeForbiddenRoutes,
      activeAllowedRoutes,
    );
    assertRouteIdentity(initial.identity, expectedInitialRoute, "initial");
    record(initial);

    for (const step of sequence) {
      assertHealthy();
      if (step.type === "customer-activation") {
        const before = await waitForRoute(client, step.routeBefore, {
          timeoutMs: step.timeoutMs ?? timeoutMs,
          pollMs: routePollMs,
          forbiddenRoutes: activeForbiddenRoutes,
          allowedRoutes: activeAllowedRoutes,
          assertHealthy,
        });
        assertRouteIdentity(before, step.routeBefore, `${step.name} before`);
        record({
          type: "checkpoint",
          label: `${step.name}:before`,
          identity: before,
        });
        if (step.activatesRouteBarrier) {
          activeAllowedRoutes = validateAllowedRoutes(
            PAYMENT_BARRIER_ALLOWED_ROUTES,
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
        const activation = await activateVisibleSelector(
          client,
          step.selector,
          {
            kind: step.inputKind ?? inputKind,
            timeoutMs: step.timeoutMs ?? timeoutMs,
          },
        );
        if (!activation.input.method.startsWith("Input.")) {
          throw new Error(`${step.name} emitted no physical Input evidence`);
        }
        record({
          type: "customer-activation",
          label: step.name,
          selector: step.selector,
          input: activation.input,
          ...(step.activatesRouteBarrier ? {} : { routeBefore: before.route }),
        });
        executedExecution.customerActivations += 1;
        assertHealthy();
        const after = await waitForRoute(client, step.routeAfter, {
          timeoutMs: step.timeoutMs ?? timeoutMs,
          pollMs: routePollMs,
          forbiddenRoutes: activeForbiddenRoutes,
          allowedRoutes: activeAllowedRoutes,
          assertHealthy,
        });
        assertRouteIdentity(after, step.routeAfter, `${step.name} after`);
        record({
          type: "checkpoint",
          label: `${step.name}:after`,
          identity: after,
        });
      } else if (step.type === "observation") {
        const observation = await captureCheckpoint(client, step.name, {
          timeoutMs: step.timeoutMs ?? timeoutMs,
          screenshot: screenshotCheckpoints || step.screenshot,
          screenshotSink: adapter.screenshotSink,
          clock,
        });
        assertAllowedRoute(
          observation.identity.route,
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
      } else if (step.type === "route-action") {
        const before = await captureDomIdentity(client, {
          timeoutMs: step.timeoutMs ?? timeoutMs,
        });
        assertAllowedRoute(
          before.route,
          activeForbiddenRoutes,
          activeAllowedRoutes,
        );
        assertRouteIdentity(before, step.routeBefore, `${step.name} before`);
        record({
          type: "checkpoint",
          label: `${step.name}:before`,
          identity: before,
        });
        const routeStimulus = await evaluateExpression(
          client,
          `(() => {
            const routeBefore = location.hash;
            history.back();
            return { stimulus: "history-back", routeBefore };
          })()`,
          { timeoutMs: step.timeoutMs ?? timeoutMs },
        );
        if (
          routeStimulus?.stimulus !== step.stimulus ||
          normalizeMachineRoute(routeStimulus.routeBefore) !== before.route
        ) {
          throw new Error(`${step.name} did not acknowledge ${step.stimulus}`);
        }
        executedExecution.routeActions += 1;
        assertHealthy();
        const after = await waitForRoute(client, step.routeAfter, {
          timeoutMs: step.timeoutMs ?? timeoutMs,
          pollMs: routePollMs,
          forbiddenRoutes: activeForbiddenRoutes,
          allowedRoutes: activeAllowedRoutes,
          assertHealthy,
        });
        assertRouteIdentity(after, step.routeAfter, `${step.name} after`);
        record({
          type: "route-action",
          label: step.name,
          stimulus: step.stimulus,
          routeBefore: before.route,
          routeAfter: after.route,
          triggerAcknowledged: true,
        });
        record({
          type: "checkpoint",
          label: `${step.name}:after`,
          identity: after,
        });
        continue;
      } else if (step.type === "debug-disturbance") {
        const before = await captureDomIdentity(client, {
          timeoutMs: step.timeoutMs ?? timeoutMs,
        });
        assertAllowedRoute(
          before.route,
          activeForbiddenRoutes,
          activeAllowedRoutes,
        );
        assertRouteIdentity(before, step.routeBefore, `${step.name} before`);
        const injection = await injectDebugDisturbance(
          client,
          step.disturbance,
          { timeoutMs: step.timeoutMs ?? timeoutMs },
        );
        const after = await waitForRoute(client, step.routeAfter, {
          timeoutMs: step.timeoutMs ?? timeoutMs,
          pollMs: routePollMs,
          forbiddenRoutes: activeForbiddenRoutes,
          allowedRoutes: activeAllowedRoutes,
          assertHealthy,
        });
        assertRouteIdentity(after, step.routeAfter, `${step.name} after`);
        record({
          type: "route-disturbance",
          label: step.name,
          disturbance: step.disturbance,
          routeBefore: before.route,
          routeAfter: after.route,
          injection,
        });
        continue;
      }
      const checkpoint = await captureCheckpoint(client, step.name, {
        timeoutMs: step.timeoutMs ?? timeoutMs,
        screenshot: screenshotCheckpoints || step.screenshot === true,
        screenshotSink: adapter.screenshotSink,
        clock,
      });
      assertAllowedRoute(
        checkpoint.identity.route,
        activeForbiddenRoutes,
        activeAllowedRoutes,
      );
      record(checkpoint);
    }

    if (typeof onPaymentWindow === "function") {
      const continuousStart = capture ? await capture.captureNow() : null;
      const paymentWindow = await onPaymentWindow();
      const continuousEnd = capture ? await capture.captureNow() : null;
      const continuousDuring = capture?.checkpoints.find(
        (checkpoint) =>
          checkpoint.ordinal > continuousStart?.ordinal &&
          checkpoint.ordinal < continuousEnd?.ordinal,
      );
      if (
        paymentWindow?.serialCompleted !== true ||
        paymentWindow?.postSaleStable !== true ||
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
        continuousCheckpointOrdinals: [
          continuousStart.ordinal,
          continuousDuring.ordinal,
          continuousEnd.ordinal,
        ],
      });
      assertHealthy();
    }

    const final = await captureCheckpoint(client, "final", {
      timeoutMs,
      screenshot: screenshotCheckpoints,
      screenshotSink: adapter.screenshotSink,
      clock,
    });
    assertAllowedRoute(
      final.identity.route,
      activeForbiddenRoutes,
      activeAllowedRoutes,
    );
    record(final);
    assertHealthy();
    const continuous = capture ? await capture.stop() : [];
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
        id: target.id,
        route: target.route,
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
    const cleanup = await Promise.allSettled([
      Promise.resolve().then(() => unsubscribeCdpRoutes?.()),
      capture?.stop() ?? Promise.resolve(),
      client?.close() ?? Promise.resolve(),
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

function validateScenarioSequence({ sequenceName, steps }) {
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
  const validatedSteps = [];
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
    const common = {
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
        }),
      );
    } else if (type === "observation") {
      observations += 1;
      validatedSteps.push(
        Object.freeze({
          ...common,
          route: normalizeMachineRoute(
            requiredStepString(step, "route", index),
          ),
        }),
      );
    } else if (type === "route-action") {
      validatedSteps.push(
        Object.freeze({
          ...common,
          stimulus: requiredStepRouteActionStimulus(step, index),
          routeBefore: requiredStepRouteMatcher(step, "routeBefore", index),
          routeAfter: requiredStepRouteMatcher(step, "routeAfter", index),
        }),
      );
    } else if (type === "debug-disturbance") {
      validatedSteps.push(
        Object.freeze({
          ...common,
          disturbance: requiredStepDebugDisturbance(step, index),
          routeBefore: requiredStepRouteMatcher(step, "routeBefore", index),
          routeAfter: requiredStepRouteMatcher(step, "routeAfter", index),
        }),
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
  return Object.freeze(validatedSteps);
}

function assertClosedStep(step, index, type) {
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
        ])
      : type === "observation"
        ? new Set(["type", "name", "route", "timeoutMs", "screenshot"])
        : type === "route-action"
          ? new Set([
              "type",
              "name",
              "stimulus",
              "routeBefore",
              "routeAfter",
              "timeoutMs",
              "screenshot",
            ])
          : type === "debug-disturbance"
            ? new Set([
                "type",
                "name",
                "disturbance",
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
    if (!Object.hasOwn(Object.getOwnPropertyDescriptor(step, key), "value")) {
      throw new Error(`scenario step ${index + 1} cannot use accessors`);
    }
  }
}

function requiredStepString(step, field, index) {
  const descriptor = Object.getOwnPropertyDescriptor(step, field);
  if (!descriptor || !Object.hasOwn(descriptor, "value")) {
    throw new Error(`scenario step ${index + 1} requires ${field}`);
  }
  if (typeof descriptor.value !== "string" || descriptor.value.trim() === "") {
    throw new Error(`scenario step ${index + 1} requires ${field}`);
  }
  return descriptor.value.trim();
}

function requiredStepRouteMatcher(step, field, index) {
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

function requiredStepRouteActionStimulus(step, index) {
  const stimulus = requiredStepString(step, "stimulus", index);
  if (stimulus !== "history-back") {
    throw new Error(`scenario step ${index + 1} stimulus is invalid`);
  }
  return stimulus;
}

function requiredStepDebugDisturbance(step, index) {
  const disturbance = requiredStepString(step, "disturbance", index);
  if (
    disturbance !== "catalog_refresh" &&
    disturbance !== "readiness_refresh"
  ) {
    throw new Error(`scenario step ${index + 1} disturbance is invalid`);
  }
  return disturbance;
}

function requiredStepTimeout(step, index) {
  const value = step.timeoutMs;
  if (
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > DEFAULT_TIMEOUT_MS * 12
  ) {
    throw new Error(`scenario step ${index + 1} timeoutMs is invalid`);
  }
  return value;
}

function requiredStepBoolean(step, field, index) {
  if (typeof step[field] !== "boolean") {
    throw new Error(`scenario step ${index + 1} ${field} must be boolean`);
  }
  return step[field];
}

function requiredStepInputKind(step, index) {
  if (step.inputKind !== "touch" && step.inputKind !== "mouse") {
    throw new Error(`scenario step ${index + 1} inputKind is invalid`);
  }
  return step.inputKind;
}

function countScenarioSteps(sequence) {
  return {
    customerActivations: sequence.filter(
      (step) => step.type === "customer-activation",
    ).length,
    observations: sequence.filter((step) => step.type === "observation").length,
    routeActions: sequence.filter((step) => step.type === "route-action")
      .length,
  };
}

function assertScenarioExecutionCounts(planned, executed) {
  for (const field of ["customerActivations", "observations", "routeActions"]) {
    if (planned[field] !== executed[field]) {
      throw new Error(
        `scenario executed ${executed[field]} ${field}, expected ${planned[field]}`,
      );
    }
  }
}

function assertAllowedRoute(
  route,
  forbiddenRoutes = INITIAL_FORBIDDEN_CUSTOMER_ROUTES,
  allowedRoutes = null,
) {
  forbiddenRoutes = resolveForbiddenRoutes(forbiddenRoutes);
  allowedRoutes = resolveAllowedRoutes(allowedRoutes);
  const normalized = normalizeMachineRoute(route);
  const path = routePath(normalized);
  if (
    allowedRoutes !== null &&
    !allowedRoutes.some((candidate) => routeMatchesRoutePath(path, candidate))
  ) {
    throw new Error(`payment barrier route observed: ${normalized}`);
  }
  if (
    forbiddenRoutes.some((candidate) => {
      return routeMatchesRoutePath(path, candidate);
    })
  ) {
    throw new Error(`forbidden customer route observed: ${normalized}`);
  }
}

function routeMatchesRoutePath(path, candidate) {
  const route = candidate.startsWith("#")
    ? routePath(normalizeMachineRoute(candidate))
    : normalizeForbiddenRoutePath(candidate);
  return path === route || path.startsWith(`${route}/`);
}

function matchesAnyRoutePath(route, candidates) {
  const path = routePath(normalizeMachineRoute(route));
  return candidates.some((candidate) => routeMatchesRoutePath(path, candidate));
}

function validateForbiddenRoutes(routes) {
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

function validateAllowedRoutes(routes) {
  if (!Array.isArray(routes) || routes.length === 0) {
    throw new Error("allowedRoutes must be a nonempty array");
  }
  return validateForbiddenRoutes(routes);
}

function resolveForbiddenRoutes(routes) {
  return typeof routes === "function"
    ? validateForbiddenRoutes(routes())
    : validateForbiddenRoutes(routes ?? INITIAL_FORBIDDEN_CUSTOMER_ROUTES);
}

function resolveAllowedRoutes(routes) {
  if (routes == null) return null;
  const resolved = typeof routes === "function" ? routes() : routes;
  return resolved == null ? null : validateAllowedRoutes(resolved);
}

function snapshotRoutePolicy(options) {
  const policy =
    typeof options.routePolicy === "function" ? options.routePolicy() : null;
  if (policy != null) {
    if (typeof policy !== "object") {
      throw new Error("routePolicy must return an object");
    }
    return Object.freeze({
      epoch: policy.epoch ?? null,
      forbiddenRoutes: validateForbiddenRoutes(policy.forbiddenRoutes),
      allowedRoutes:
        policy.allowedRoutes == null
          ? null
          : validateAllowedRoutes(policy.allowedRoutes),
    });
  }
  return Object.freeze({
    epoch: null,
    forbiddenRoutes: resolveForbiddenRoutes(options.forbiddenRoutes),
    allowedRoutes: resolveAllowedRoutes(options.allowedRoutes),
  });
}

function boundIdentity(identity) {
  if (!identity || typeof identity !== "object") {
    throw new Error("DOM identity capture returned no object");
  }
  let url;
  try {
    url = new URL(String(identity.url));
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
    title: boundedString(identity.title ?? "", MAX_LABEL_LENGTH),
    readyState: boundedString(identity.readyState ?? "unknown", 32),
    activeElement:
      identity.activeElement == null
        ? null
        : boundedString(identity.activeElement, 64),
    domLength: Number.isSafeInteger(identity.domLength)
      ? identity.domLength
      : null,
    domHash:
      typeof identity.domHash === "string"
        ? boundedString(identity.domHash, 128)
        : null,
  };
}

function sortChronologically(items) {
  return items.sort((left, right) => {
    const time = String(left.capturedAt).localeCompare(
      String(right.capturedAt),
    );
    return time || Number(left.ordinal ?? 0) - Number(right.ordinal ?? 0);
  });
}

function routePath(route) {
  return new URL(
    normalizeMachineRoute(route).slice(1),
    "http://machine-route.invalid",
  ).pathname;
}

function normalizeForbiddenRoutePath(value) {
  const path = String(value ?? "")
    .trim()
    .replaceAll("\\", "/")
    .toLowerCase();
  if (!path.startsWith("/")) {
    throw new Error(`invalid forbidden route path: ${String(value)}`);
  }
  return routePath(`#${path}`);
}

function boundEvidenceEntry(entry) {
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
        identity: boundIdentity(entry.armBaseline?.identity),
        route: normalizeMachineRoute(entry.armBaseline?.route),
      },
    };
  }
  if (entry.type === "route-action") {
    if (entry.stimulus !== "history-back") {
      throw new Error("route action stimulus is invalid");
    }
    if (entry.triggerAcknowledged !== true) {
      throw new Error("route action must acknowledge its stimulus");
    }
    return {
      type: "route-action",
      label: boundedRequiredString(
        entry.label,
        "route action label",
        MAX_LABEL_LENGTH,
      ),
      stimulus: "history-back",
      routeBefore: normalizeMachineRoute(entry.routeBefore),
      routeAfter: normalizeMachineRoute(entry.routeAfter),
      triggerAcknowledged: true,
    };
  }
  if (entry.type === "route-disturbance") {
    const disturbance = entry.disturbance;
    if (
      disturbance !== "catalog_refresh" &&
      disturbance !== "readiness_refresh"
    ) {
      throw new Error("route disturbance is invalid");
    }
    const expectedState =
      disturbance === "catalog_refresh" ? "catalog" : "readiness";
    if (
      entry.injection?.kind !== disturbance ||
      entry.injection?.count !== 1 ||
      entry.injection?.outcome !== "completed" ||
      entry.injection?.pressure?.refreshedState !== expectedState ||
      entry.injection?.pressure?.routeAuthorityWon !== true ||
      entry.injection?.pressure?.resolvedRoute !== "/payment" ||
      entry.injection.pressure.attemptedRoute ===
        entry.injection.pressure.resolvedRoute
    ) {
      throw new Error("route disturbance did not prove route authority");
    }
    return {
      type: "route-disturbance",
      label: boundedRequiredString(
        entry.label,
        "route disturbance label",
        MAX_LABEL_LENGTH,
      ),
      disturbance,
      routeBefore: normalizeMachineRoute(entry.routeBefore),
      routeAfter: normalizeMachineRoute(entry.routeAfter),
      injection: {
        injectionId: boundedRequiredString(
          entry.injection.injectionId,
          "route disturbance injection id",
          MAX_LABEL_LENGTH,
        ),
        kind: disturbance,
        count: 1,
        outcome: "completed",
        pressure: {
          refreshedState: expectedState,
          attemptedRoute: boundedRequiredString(
            entry.injection.pressure.attemptedRoute,
            "route disturbance attempted route",
            MAX_URL_LENGTH,
          ),
          resolvedRoute: "/payment",
          routeAuthorityWon: true,
        },
      },
    };
  }
  if (entry.type === "payment-window") {
    if (
      entry.serialCompleted !== true ||
      entry.postSaleStable !== true ||
      !Array.isArray(entry.continuousCheckpointOrdinals) ||
      entry.continuousCheckpointOrdinals.length !== 3 ||
      entry.continuousCheckpointOrdinals.some(
        (ordinal) => !Number.isSafeInteger(ordinal) || ordinal < 0,
      ) ||
      entry.continuousCheckpointOrdinals[0] >=
        entry.continuousCheckpointOrdinals[1] ||
      entry.continuousCheckpointOrdinals[1] >=
        entry.continuousCheckpointOrdinals[2]
    ) {
      throw new Error(
        "payment window did not prove continuous capture, completion, and stability",
      );
    }
    return {
      type: "payment-window",
      serialCompleted: true,
      postSaleStable: true,
      continuousCheckpointOrdinals: [...entry.continuousCheckpointOrdinals],
    };
  }
  if (entry.type === "runtime-attestation") {
    return {
      type: "runtime-attestation",
      attestation: bindMachineUiRuntimeEvidence({
        expectedRuntimeAttestation: entry.attestation?.expected,
        observedRuntime: entry.attestation?.observed,
        target: entry.attestation?.observed?.cdpTarget,
      }),
    };
  }
  throw new Error(`unsupported evidence entry type ${String(entry.type)}`);
}

function boundScreenshot(screenshot) {
  if (!screenshot || typeof screenshot !== "object") {
    throw new Error("screenshot evidence must be an object");
  }
  if (!/^[a-f0-9]{64}$/.test(screenshot.sha256)) {
    throw new Error("screenshot evidence requires a SHA-256 digest");
  }
  if (
    !Number.isSafeInteger(screenshot.byteLength) ||
    screenshot.byteLength < 0 ||
    screenshot.byteLength > MAX_SCREENSHOT_BYTES
  ) {
    throw new Error("screenshot evidence exceeds the maximum size");
  }
  const ref =
    screenshot.ref == null
      ? null
      : boundedRequiredString(screenshot.ref, "screenshot ref", 1_024);
  return {
    sha256: screenshot.sha256,
    byteLength: screenshot.byteLength,
    format: screenshot.format === "jpeg" ? "jpeg" : "png",
    ref,
  };
}

function boundPhysicalInput(input) {
  if (
    !input ||
    typeof input !== "object" ||
    !String(input.method).startsWith("Input.")
  ) {
    throw new Error("activation requires physical CDP Input evidence");
  }
  if (input.kind !== "touch" && input.kind !== "mouse") {
    throw new Error("activation input kind is invalid");
  }
  for (const field of ["x", "y"]) {
    if (!Number.isFinite(input[field]) || Math.abs(input[field]) > 100_000) {
      throw new Error(`activation input ${field} is invalid`);
    }
  }
  if (input.released !== true)
    throw new Error("activation input was not released");
  return {
    method: input.method,
    kind: input.kind,
    x: input.x,
    y: input.y,
    released: true,
  };
}

function normalizeEndpoint(endpoint) {
  const url = normalizeEndpointUrl(endpoint);
  url.pathname = url.pathname.replace(/\/json\/?$/, "/");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function normalizeEndpointUrl(endpoint) {
  const url = new URL(String(endpoint));
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("forwarded endpoint must use http or https");
  }
  return url;
}

async function withTimeout(promise, timeoutMs, label, onTimeout) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          onTimeout?.();
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function requireBrowserWebSocket(socket) {
  if (
    !socket ||
    typeof socket.addEventListener !== "function" ||
    typeof socket.removeEventListener !== "function" ||
    typeof socket.send !== "function" ||
    typeof socket.close !== "function"
  ) {
    throw new Error(
      "WebSocket adapter must implement the browser WebSocket EventTarget interface",
    );
  }
}

async function waitForSocketEvent(
  socket,
  eventName,
  { timeoutMs, errorLabel, listenForError = true },
) {
  let eventHandler;
  let errorHandler;
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
    socket.removeEventListener(eventName, eventHandler);
    if (listenForError) socket.removeEventListener("error", errorHandler);
  }
}

async function findAvailableLocalPort(host) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function waitForTcpEndpoint({ host, port, timeoutMs, pollMs }) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  do {
    try {
      await new Promise((resolve, reject) => {
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
    `SSH tunnel readiness timed out: ${lastError?.message ?? "unreachable"}`,
  );
}

function watchChildStartup(child, getStderr) {
  let onError;
  let onExit;
  const failure = new Promise((_, reject) => {
    onError = (error) =>
      reject(
        new Error(`SSH tunnel process error: ${error.message}`, {
          cause: error,
        }),
      );
    onExit = (code, signal) => {
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

async function terminateChildProcess(child, processAdapter, timeoutMs) {
  return terminateChildProcessWithOptions(child, processAdapter, timeoutMs);
}

async function terminateChildProcessWithOptions(
  child,
  processAdapter,
  timeoutMs,
  { termAlreadySent = false } = {},
) {
  if (!child || child.exitCode != null) return;
  const wait = (limit) =>
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

async function waitForExit(child, timeoutMs) {
  if (child.exitCode != null) return;
  let onExit;
  let onError;
  await withTimeout(
    new Promise((resolve, reject) => {
      onExit = resolve;
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

function formatSshHost(host) {
  return String(host).includes(":") ? `[${host}]` : String(host);
}

function formatUrlHost(host) {
  return String(host).includes(":") ? `[${host}]` : String(host);
}

function boundedString(value, maxLength) {
  return String(value ?? "").slice(0, maxLength);
}

function nowIso(clock) {
  const value = clock?.() ?? new Date();
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function formatExpectedRoute(expected) {
  if (expected instanceof RegExp) return expected.toString();
  if (typeof expected === "function") return "predicate";
  return JSON.stringify(expected);
}

function normalizeWindowsRuntimeObservation(
  observation,
  { remoteCdpPort } = {},
) {
  if (!observation || typeof observation !== "object") {
    throw new Error("Windows runtime inspection returned no object");
  }
  const machine = normalizeWindowsProcessObservation(
    observation.machine,
    "machine",
  );
  const cdpListener = normalizeWindowsProcessObservation(
    observation.cdpListener,
    "cdpListener",
  );
  if (
    !Number.isSafeInteger(observation.cdpListener.machineAncestorProcessId) ||
    observation.cdpListener.machineAncestorProcessId <= 0
  ) {
    throw new Error(
      "Windows runtime inspection requires cdpListener.machineAncestorProcessId",
    );
  }
  if (observation.cdpListener.localAddress !== "127.0.0.1") {
    throw new Error(
      "Windows runtime inspection requires a loopback CDP listener",
    );
  }
  if (
    !Number.isSafeInteger(observation.cdpListener.localPort) ||
    observation.cdpListener.localPort <= 0
  ) {
    throw new Error(
      "Windows runtime inspection requires cdpListener.localPort",
    );
  }
  if (
    remoteCdpPort != null &&
    observation.cdpListener.localPort !== remoteCdpPort
  ) {
    throw new Error(
      `Windows runtime inspection CDP port mismatch: expected ${remoteCdpPort}, observed ${observation.cdpListener.localPort}`,
    );
  }
  return {
    machine,
    cdpListener: {
      ...cdpListener,
      machineAncestorProcessId:
        observation.cdpListener.machineAncestorProcessId,
      localAddress: observation.cdpListener.localAddress,
      localPort: observation.cdpListener.localPort,
    },
  };
}

function normalizeWindowsProcessObservation(process, label) {
  if (!process || typeof process !== "object") {
    throw new Error(`Windows runtime inspection requires ${label}`);
  }
  for (const field of ["processId", "sessionId"]) {
    if (!Number.isSafeInteger(process[field]) || process[field] <= 0) {
      throw new Error(`Windows runtime inspection requires ${label}.${field}`);
    }
  }
  return {
    processId: process.processId,
    executablePath: normalizeWindowsPath(process.executablePath),
    sessionId: process.sessionId,
    principal: normalizeWindowsPrincipal(process.principal),
  };
}

function normalizeWindowsPath(value) {
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

function normalizeWindowsPrincipal(value) {
  const principal = String(value ?? "").trim();
  if (
    !/^[^\\\0\r\n]+\\[^\\\0\r\n]+$/.test(principal) ||
    principal.length > 512
  ) {
    throw new Error("Windows process principal must be an exact Domain\\User");
  }
  return principal;
}

function boundedRequiredString(value, label, maxLength) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength)
    throw new Error(`${label} exceeds maximum length`);
  return normalized;
}

async function runWindowsPowerShellOverSsh({
  remote,
  sshPort,
  identityFile,
  certificateFile,
  sshKnownHostsPath,
  sshHostKeyAlias,
  sshArgs = [],
  timeoutMs,
  script,
}) {
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
  options,
  { processAdapter = defaultProcessAdapter, shutdownTimeoutMs = 1_000 } = {},
) {
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
  },
  processAdapter,
) {
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
    "-Command",
    script,
  ];
  const child = processAdapter.spawn("ssh", args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let outputError = null;
  const append = (current, chunk, label) => {
    const next = `${current}${String(chunk)}`;
    if (Buffer.byteLength(next, "utf8") > MAX_REMOTE_OUTPUT_BYTES) {
      outputError ??= new Error(
        `Windows runtime inspection ${label} exceeded maximum output`,
      );
      child.kill("SIGTERM");
      return current;
    }
    return next;
  };
  child.stdout.on("data", (chunk) => {
    stdout = append(stdout, chunk, "stdout");
  });
  child.stderr.on("data", (chunk) => {
    stderr = append(stderr, chunk, "stderr");
  });
  let timedOut = false;
  let result;
  try {
    result = await withTimeout(
      new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      }),
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
      `Windows runtime inspection returned invalid JSON: ${boundedString(error.message, 512)}`,
      { cause: error },
    );
  }
}

const defaultProcessAdapter = { spawn };

function assertProductionScenarioOptions(options) {
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

function sanitizeProductionTunnelOptions(tunnelOptions = {}) {
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

function selectTunnelTransportFields(tunnelOptions = {}) {
  const selected = {};
  for (const key of PRODUCTION_TUNNEL_OPTION_KEYS) {
    if (Object.hasOwn(tunnelOptions, key)) selected[key] = tunnelOptions[key];
  }
  return selected;
}

function buildSidecarTunnelOptions(tunnelTransport, inspectedRuntime) {
  const sidecarOptions = {};
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

function parseCliArgs(argv) {
  const options = {
    steps: [],
    expectedRuntimeAttestation: { machine: {} },
  };
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
      options.expectedRuntimeAttestation.targetId = next();
    } else if (arg === "--machine-process-id") {
      options.expectedRuntimeAttestation.machine.processId = Number(next());
    } else if (arg === "--machine-session-id") {
      options.expectedRuntimeAttestation.machine.sessionId = Number(next());
    } else if (arg === "--machine-path") {
      options.expectedRuntimeAttestation.machine.executablePath = next();
    } else if (arg === "--machine-principal") {
      options.expectedRuntimeAttestation.machine.principal = next();
    } else if (arg === "--sequence") options.sequenceName = next();
    else if (arg === "--initial-route") options.expectedInitialRoute = next();
    else if (arg === "--mouse") options.inputKind = "mouse";
    else if (arg === "--screenshot") options.screenshotCheckpoints = true;
    else if (arg === "--step") {
      const [name, selector, routeBefore, routeAfter] = next().split("::");
      options.steps.push({
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
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  }
}
