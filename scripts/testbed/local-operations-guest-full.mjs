#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { waitForDaemonReadyRefresh } from "./daemon-ready-refresh.mjs";
import { runInstalledSystemTouchKeyboardAcceptance } from "./installed-system-touch-keyboard.mjs";
import {
  activateVisibleSelector,
  CdpClient,
  discoverCanonicalMachineUiTarget,
  discoverMachineUiTarget,
  enablePageRuntime,
  evaluateExpression,
  rewriteWebSocketDebuggerUrl,
  waitForRoute,
} from "./machine-ui-cdp-driver.mjs";

const SCHEMA_VERSION = "vem-local-operations-guest-full/v1";
const AUDIO_PREFERENCE_TIMEOUT_MS = 30_000;
const MACHINE_AUDIO_DEFAULTS = Object.freeze({
  volume: 0.7,
  cuesEnabled: true,
  presenceCuesEnabled: true,
  transactionCuesEnabled: true,
});
const AUDIO_PERSISTENCE_TARGET = Object.freeze({
  volume: 0.35,
  cuesEnabled: false,
  presenceCuesEnabled: false,
  transactionCuesEnabled: false,
});
const INSTALLED_RUNTIME_TASK = "VEMLocalTestbedInstalledRuntime";
const CANONICAL_DAEMON_PATH = "C:\\VEM\\bringup\\vending-daemon.exe";
const CANONICAL_MACHINE_PATH = "C:\\VEM\\bringup\\machine.exe";
const CANONICAL_CDP_ENDPOINT = "http://127.0.0.1:9222";
const EXPERIENCE_TASK_SELECTOR = ".maintenance-task-nav button:nth-of-type(5)";
const AUDIO_SELECTORS = Object.freeze({
  cuesEnabled: "[data-test='machine-audio-enabled']",
  presenceCuesEnabled: "[data-test='machine-audio-presence-enabled']",
  transactionCuesEnabled: "[data-test='machine-audio-transaction-enabled']",
  volumePercent: "[data-test='machine-audio-volume-percent']",
});

function required(value, label) {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${label} is required`);
  return value.trim();
}
function option(args, name) {
  const i = args.indexOf(`--${name}`);
  return required(i < 0 ? undefined : args[i + 1], `--${name}`);
}
function localPath(value) {
  const path = required(value, "Windows path");
  return process.platform === "win32"
    ? path
    : resolve(
        `/mnt/${path[0].toLowerCase()}/${path.slice(3).replaceAll("\\", "/")}`,
      );
}
export function parseLocalOperationsGuestArgs(args) {
  if (option(args, "mode") !== "full") throw new Error("--mode must be full");
  return {
    mode: "full",
    guestInputPath: option(args, "guest-input"),
    handoffPath: option(args, "handoff"),
    outPath: option(args, "out"),
    fixtureKey: args.includes("--fixture-key")
      ? option(args, "fixture-key")
      : null,
  };
}
function readJson(path) {
  return JSON.parse(readFileSync(localPath(path), "utf8"));
}
function writeJson(path, value) {
  mkdirSync(dirname(localPath(path)), { recursive: true });
  writeFileSync(localPath(path), `${JSON.stringify(value, null, 2)}\n`);
}
async function json(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: options.signal ?? AbortSignal.timeout(30_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(
      `${options.method ?? "GET"} ${url} failed: ${JSON.stringify(payload)}`,
    );
  return payload;
}
function daemonUrl(handoff) {
  const url = required(handoff.daemon?.ready?.healthzUrl, "daemon healthzUrl");
  if (!url.endsWith("/healthz"))
    throw new Error("daemon healthzUrl must end with /healthz");
  return url.slice(0, -"/healthz".length);
}
function daemon(handoff, path, body) {
  return json(`${daemonUrl(handoff)}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${required(handoff.daemon?.ready?.ipcToken, "daemon ipcToken")}`,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function control(input, path, body = {}) {
  return json(
    `${required(input.hostControlPlane?.endpoint, "hostControlPlane.endpoint")}${path}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${required(input.hostControlPlane?.token, "hostControlPlane.token")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
}
function boundedNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label} must be finite`);
  return number;
}
export function normalizeAudioPreferences(value) {
  return {
    volume: Number(boundedNumber(value?.volume, "audio volume").toFixed(2)),
    cuesEnabled: Boolean(value?.cuesEnabled),
    presenceCuesEnabled: Boolean(value?.presenceCuesEnabled),
    transactionCuesEnabled: Boolean(value?.transactionCuesEnabled),
  };
}
export function audioPreferencesEqual(left, right) {
  const actual = normalizeAudioPreferences(left);
  const expected = normalizeAudioPreferences(right);
  return (
    actual.volume === expected.volume &&
    actual.cuesEnabled === expected.cuesEnabled &&
    actual.presenceCuesEnabled === expected.presenceCuesEnabled &&
    actual.transactionCuesEnabled === expected.transactionCuesEnabled
  );
}
function describeAudioPreferences(value) {
  return JSON.stringify(normalizeAudioPreferences(value));
}
async function waitForState(
  label,
  read,
  accept,
  describe = (value) => JSON.stringify(value),
  timeoutMs = AUDIO_PREFERENCE_TIMEOUT_MS,
) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  do {
    last = await read();
    if (accept(last)) return last;
    await sleep(150);
  } while (Date.now() < deadline);
  throw new Error(
    `${label} did not reach the expected state; last value was ${describe(last)}`,
  );
}
async function waitForMatch(
  label,
  read,
  expected,
  timeoutMs = AUDIO_PREFERENCE_TIMEOUT_MS,
) {
  return normalizeAudioPreferences(
    await waitForState(
      label,
      read,
      (last) => audioPreferencesEqual(last, expected),
      describeAudioPreferences,
      timeoutMs,
    ),
  );
}
async function daemonRuntimeConfiguration(handoff, daemonRequest = daemon) {
  return daemonRequest(handoff, "/v1/runtime-configuration");
}
async function readDaemonAudioPreferences(handoff, daemonRequest = daemon) {
  const configuration = await daemonRuntimeConfiguration(
    handoff,
    daemonRequest,
  );
  return normalizeAudioPreferences(configuration?.experience?.audio);
}
async function setRoute(client, route) {
  await evaluateExpression(client, `location.hash = ${JSON.stringify(route)}`);
  return waitForRoute(client, route, {
    timeoutMs: AUDIO_PREFERENCE_TIMEOUT_MS,
    pollMs: 150,
    forbiddenRoutes: route.startsWith("#/maintenance") ? [] : undefined,
  });
}
async function ensureMaintenanceExperienceTask(client) {
  await setRoute(client, "#/maintenance?source=operator");
  await activateVisibleSelector(client, EXPERIENCE_TASK_SELECTOR, {
    kind: "touch",
    timeoutMs: AUDIO_PREFERENCE_TIMEOUT_MS,
    pollMs: 150,
  });
  await waitForState(
    "maintenance experience panel",
    async () =>
      evaluateExpression(
        client,
        `(() => {
          const input = document.querySelector(${JSON.stringify(AUDIO_SELECTORS.volumePercent)});
          const button = document.querySelector(${JSON.stringify(EXPERIENCE_TASK_SELECTOR)});
          return {
            visible: Boolean(input?.getClientRects().length),
            selected: button?.classList?.contains("active") ?? false,
          };
        })()`,
      ),
    (value) => value?.visible === true && value?.selected === true,
  );
}
export async function readMachineUiAudioPreferences(client) {
  const value = await evaluateExpression(
    client,
    `(() => {
      const cuesEnabled = document.querySelector(${JSON.stringify(AUDIO_SELECTORS.cuesEnabled)});
      const presenceCuesEnabled = document.querySelector(${JSON.stringify(AUDIO_SELECTORS.presenceCuesEnabled)});
      const transactionCuesEnabled = document.querySelector(${JSON.stringify(AUDIO_SELECTORS.transactionCuesEnabled)});
      const volume = document.querySelector(${JSON.stringify(AUDIO_SELECTORS.volumePercent)});
      if (!cuesEnabled || !presenceCuesEnabled || !transactionCuesEnabled || !volume) {
        return null;
      }
      return {
        cuesEnabled: Boolean(cuesEnabled.checked),
        presenceCuesEnabled: Boolean(presenceCuesEnabled.checked),
        transactionCuesEnabled: Boolean(transactionCuesEnabled.checked),
        volume: Number(volume.value) / 100,
      };
    })()`,
  );
  if (!value)
    throw new Error("machine UI audio preference controls are unavailable");
  return normalizeAudioPreferences(value);
}
async function setMachineUiCheckbox(client, selector, expected) {
  const current = await evaluateExpression(
    client,
    `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      return element
        ? { checked: Boolean(element.checked), disabled: Boolean(element.disabled) }
        : null;
    })()`,
  );
  if (current == null)
    throw new Error(`machine UI control is unavailable: ${selector}`);
  if (current.checked !== expected) {
    await activateVisibleSelector(client, selector, {
      kind: "touch",
      timeoutMs: AUDIO_PREFERENCE_TIMEOUT_MS,
      pollMs: 150,
    });
  }
  await waitForState(
    `machine UI checkbox ${selector}`,
    async () =>
      evaluateExpression(
        client,
        `(() => {
          const element = document.querySelector(${JSON.stringify(selector)});
          return element
            ? { checked: Boolean(element.checked), disabled: Boolean(element.disabled) }
            : null;
        })()`,
      ),
    (value) => value?.checked === expected && value?.disabled === false,
  );
}
async function setMachineUiVolumePercent(client, expectedVolume) {
  const percent = Math.round(
    normalizeAudioPreferences({
      ...MACHINE_AUDIO_DEFAULTS,
      volume: expectedVolume,
    }).volume * 100,
  );
  const result = await evaluateExpression(
    client,
    `(() => {
      const element = document.querySelector(${JSON.stringify(AUDIO_SELECTORS.volumePercent)});
      if (!element) return null;
      element.value = ${percent};
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return { value: Number(element.value) };
    })()`,
  );
  if (!result) throw new Error("machine UI volume control is unavailable");
  await waitForState(
    "machine UI volume",
    async () =>
      evaluateExpression(
        client,
        `(() => {
          const element = document.querySelector(${JSON.stringify(AUDIO_SELECTORS.volumePercent)});
          return element
            ? { value: Number(element.value), disabled: Boolean(element.disabled) }
            : null;
        })()`,
      ),
    (value) => value?.value === percent && value?.disabled === false,
  );
}
export async function setMachineUiAudioPreferences(client, expected) {
  const target = normalizeAudioPreferences(expected);
  await ensureMaintenanceExperienceTask(client);
  await setMachineUiCheckbox(
    client,
    AUDIO_SELECTORS.cuesEnabled,
    target.cuesEnabled,
  );
  await setMachineUiCheckbox(
    client,
    AUDIO_SELECTORS.presenceCuesEnabled,
    target.presenceCuesEnabled,
  );
  await setMachineUiCheckbox(
    client,
    AUDIO_SELECTORS.transactionCuesEnabled,
    target.transactionCuesEnabled,
  );
  await setMachineUiVolumePercent(client, target.volume);
  return waitForMatch(
    "machine UI audio preferences",
    () => readMachineUiAudioPreferences(client),
    target,
  );
}
async function withMachineUiClient(
  handoff,
  {
    discoverMachineUiTargetFn = discoverMachineUiTarget,
    webSocketFactory,
    cdpClientClass = CdpClient,
  } = {},
  operation,
) {
  const endpoint = required(handoff?.cdp?.endpoint, "handoff cdp endpoint");
  const target = await discoverMachineUiTargetFn({
    endpoint,
    expectedTargetId: required(handoff?.cdp?.targetId, "handoff cdp targetId"),
  });
  const client = new cdpClientClass(
    rewriteWebSocketDebuggerUrl(target.webSocketDebuggerUrl, endpoint),
    { webSocketFactory },
  );
  await client.connect();
  await enablePageRuntime(client);
  try {
    return await operation(client, target);
  } finally {
    await client.close().catch(() => undefined);
  }
}
async function runLocalPowerShell(
  script,
  { timeoutMs = AUDIO_PREFERENCE_TIMEOUT_MS, spawnImpl = spawn } = {},
) {
  const encodedScript = Buffer.from(String(script), "utf16le").toString(
    "base64",
  );
  const child = spawnImpl(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      encodedScript,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const result = await Promise.race([
    new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    }),
    sleep(timeoutMs).then(() => {
      child.kill("SIGTERM");
      throw new Error(`PowerShell timed out after ${timeoutMs}ms`);
    }),
  ]);
  if (result.code !== 0) {
    throw new Error(
      `PowerShell failed with exit ${result.code ?? "unknown"}: ${(stderr || stdout).trim()}`,
    );
  }
  return stdout.trim();
}
export function buildInstalledRuntimeRestartScript({
  daemonPath = CANONICAL_DAEMON_PATH,
  daemonDataDirectory = "C:\\ProgramData\\VEM\\vending-daemon",
  machinePath = CANONICAL_MACHINE_PATH,
  machineTaskName = INSTALLED_RUNTIME_TASK,
} = {}) {
  const encodedDaemonPath = Buffer.from(daemonPath, "utf8").toString("base64");
  const encodedMachinePath = Buffer.from(machinePath, "utf8").toString(
    "base64",
  );
  const encodedDaemonDataDirectory = Buffer.from(
    daemonDataDirectory,
    "utf8",
  ).toString("base64");
  return `
$ErrorActionPreference = 'Stop'
$daemonPath = [System.IO.Path]::GetFullPath([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encodedDaemonPath}')))
$daemonDataDirectory = [System.IO.Path]::GetFullPath([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encodedDaemonDataDirectory}')))
$machinePath = [System.IO.Path]::GetFullPath([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encodedMachinePath}')))
$taskName = ${JSON.stringify(machineTaskName)}
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name = 'machine.exe'" | Where-Object {
  $_.ExecutablePath -and ([System.IO.Path]::GetFullPath($_.ExecutablePath) -ieq $machinePath)
} | ForEach-Object {
  try { Stop-Process -Id ([int]$_.ProcessId) -Force -ErrorAction Stop } catch {}
}
Get-CimInstance Win32_Process -Filter "Name = 'vending-daemon.exe'" | Where-Object {
  $_.ExecutablePath -and ([System.IO.Path]::GetFullPath($_.ExecutablePath) -ieq $daemonPath)
} | ForEach-Object {
  try { Stop-Process -Id ([int]$_.ProcessId) -Force -ErrorAction Stop } catch {}
}
for ($attempt = 0; $attempt -lt 100; $attempt += 1) {
  $machineAlive = @(Get-CimInstance Win32_Process -Filter "Name = 'machine.exe'" | Where-Object {
    $_.ExecutablePath -and ([System.IO.Path]::GetFullPath($_.ExecutablePath) -ieq $machinePath)
  })
  $daemonAlive = @(Get-CimInstance Win32_Process -Filter "Name = 'vending-daemon.exe'" | Where-Object {
    $_.ExecutablePath -and ([System.IO.Path]::GetFullPath($_.ExecutablePath) -ieq $daemonPath)
  })
  if ($machineAlive.Count -eq 0 -and $daemonAlive.Count -eq 0) { break }
  Start-Sleep -Milliseconds 200
}
$daemonProcess = Start-Process -FilePath $daemonPath -ArgumentList @('--console', '--data-dir', $daemonDataDirectory) -WorkingDirectory ([System.IO.Path]::GetDirectoryName($daemonPath)) -PassThru
Start-ScheduledTask -TaskName $taskName
[Console]::Out.WriteLine(([ordered]@{
  daemonProcessId = [int]$daemonProcess.Id
  taskName = $taskName
} | ConvertTo-Json -Compress))
`.trim();
}
function buildInstalledRuntimeObservationScript({
  daemonPath = CANONICAL_DAEMON_PATH,
  machinePath = CANONICAL_MACHINE_PATH,
  remoteCdpPort = 9222,
} = {}) {
  const encodedDaemonPath = Buffer.from(daemonPath, "utf8").toString("base64");
  const encodedMachinePath = Buffer.from(machinePath, "utf8").toString(
    "base64",
  );
  return `
$ErrorActionPreference = 'Stop'
$daemonPath = [System.IO.Path]::GetFullPath([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encodedDaemonPath}')))
$machinePath = [System.IO.Path]::GetFullPath([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encodedMachinePath}')))
$daemon = @(Get-CimInstance Win32_Process -Filter "Name = 'vending-daemon.exe'" | Where-Object {
  $_.ExecutablePath -and ([System.IO.Path]::GetFullPath($_.ExecutablePath) -ieq $daemonPath)
})
if ($daemon.Count -ne 1) { throw "daemon_count:$($daemon.Count)" }
$daemonProcess = Get-Process -Id ([int]$daemon[0].ProcessId) -ErrorAction Stop
$machine = @(Get-CimInstance Win32_Process -Filter "Name = 'machine.exe'" | Where-Object {
  $_.ExecutablePath -and ([System.IO.Path]::GetFullPath($_.ExecutablePath) -ieq $machinePath)
})
if ($machine.Count -ne 1) { throw "machine_count:$($machine.Count)" }
$machineCim = $machine[0]
$machineProcess = Get-Process -Id ([int]$machineCim.ProcessId) -ErrorAction Stop
$machineOwner = Invoke-CimMethod -InputObject $machineCim -MethodName GetOwner -ErrorAction Stop
$machinePrincipal = "{0}\\{1}" -f [string]$machineOwner.Domain, [string]$machineOwner.User
$listeners = @(Get-NetTCPConnection -LocalPort ${remoteCdpPort} -State Listen -ErrorAction Stop | Where-Object {
  [string]$_.LocalAddress -ceq '127.0.0.1'
})
if ($listeners.Count -ne 1) { throw "listener_count:$($listeners.Count)" }
$listenerCim = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$listeners[0].OwningProcess)" -ErrorAction Stop
$cursor = $listenerCim
$ancestor = $null
for ($depth = 0; $depth -lt 32 -and $null -ne $cursor; $depth += 1) {
  if ([int]$cursor.ProcessId -eq [int]$machineCim.ProcessId) { $ancestor = [int]$machineCim.ProcessId; break }
  $parentId = [int]$cursor.ParentProcessId
  if ($parentId -le 0 -or $parentId -eq [int]$cursor.ProcessId) { break }
  $cursor = Get-CimInstance Win32_Process -Filter "ProcessId = $parentId" -ErrorAction SilentlyContinue
}
if ($null -eq $ancestor) { throw 'listener_ancestor' }
[Console]::Out.WriteLine(([ordered]@{
  daemon = [ordered]@{
    processId = [int]$daemonProcess.Id
    executablePath = [System.IO.Path]::GetFullPath($daemon[0].ExecutablePath)
  }
  machine = [ordered]@{
    processId = [int]$machineProcess.Id
    executablePath = [System.IO.Path]::GetFullPath($machineCim.ExecutablePath)
    sessionId = [int]$machineProcess.SessionId
    principal = $machinePrincipal
  }
  cdp = [ordered]@{
    endpoint = ${JSON.stringify(CANONICAL_CDP_ENDPOINT)}
    listenerProcessId = [int]$listeners[0].OwningProcess
    machineAncestorProcessId = $ancestor
  }
} | ConvertTo-Json -Compress -Depth 4))
`.trim();
}
export function applyRestartedRuntimeHandoff(
  handoff,
  { ready, observedRuntime, target },
) {
  const next = {
    ...handoff,
    daemon: {
      ...handoff.daemon,
      ...observedRuntime.daemon,
      ready: { ...ready },
    },
    machine: {
      ...handoff.machine,
      ...observedRuntime.machine,
    },
    cdp: {
      ...handoff.cdp,
      ...observedRuntime.cdp,
      endpoint: observedRuntime.cdp.endpoint,
      targetId: required(target?.id, "CDP target id"),
    },
  };
  return next;
}
async function refreshRestartedRuntimeHandoff(
  handoff,
  handoffPath,
  {
    previousGeneration,
    waitForDaemonReadyRefreshFn = waitForDaemonReadyRefresh,
    discoverCanonicalMachineUiTargetFn = discoverCanonicalMachineUiTarget,
    runPowerShell = runLocalPowerShell,
    writeJsonFn = writeJson,
  } = {},
) {
  const baselineGeneration = required(
    previousGeneration ?? handoff.daemon?.ready?.generation,
    "daemon ready generation before restart",
  );
  let ready = null;
  const deadline = Date.now() + AUDIO_PREFERENCE_TIMEOUT_MS;
  do {
    ready = await waitForDaemonReadyRefreshFn(handoff);
    if (ready.generation !== baselineGeneration) break;
    await sleep(200);
  } while (Date.now() < deadline);
  if (!ready || ready.generation === baselineGeneration) {
    throw new Error("daemon ready generation did not advance after restart");
  }
  let target = null;
  do {
    try {
      target = await discoverCanonicalMachineUiTargetFn({
        endpoint: handoff?.cdp?.endpoint ?? CANONICAL_CDP_ENDPOINT,
        timeoutMs: 2_000,
      });
      break;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await sleep(200);
    }
  } while (Date.now() < deadline);
  const observedRuntime = JSON.parse(
    await runPowerShell(buildInstalledRuntimeObservationScript()),
  );
  const next = applyRestartedRuntimeHandoff(handoff, {
    ready,
    observedRuntime,
    target,
  });
  handoff.daemon = next.daemon;
  handoff.machine = next.machine;
  handoff.cdp = next.cdp;
  writeJsonFn(handoffPath, handoff);
  return {
    ready: { ...handoff.daemon.ready },
    machine: { ...handoff.machine },
    daemon: { ...handoff.daemon },
    cdp: { ...handoff.cdp },
  };
}
async function restartInstalledRuntime(
  handoff,
  handoffPath,
  dependencies = {},
) {
  const runPowerShell = dependencies.runPowerShell ?? runLocalPowerShell;
  const waitForDaemonReadyRefreshFn =
    dependencies.waitForDaemonReadyRefreshFn ?? waitForDaemonReadyRefresh;
  const readyBeforeRestart = await waitForDaemonReadyRefreshFn(handoff);
  await runPowerShell(
    buildInstalledRuntimeRestartScript({
      daemonPath: handoff.daemon?.executablePath ?? CANONICAL_DAEMON_PATH,
      daemonDataDirectory: required(
        handoff.daemon?.dataDirectory,
        "handoff daemon dataDirectory",
      ),
      machinePath: handoff.machine?.executablePath ?? CANONICAL_MACHINE_PATH,
    }),
  );
  return refreshRestartedRuntimeHandoff(handoff, handoffPath, {
    ...dependencies,
    runPowerShell,
    waitForDaemonReadyRefreshFn,
    previousGeneration: readyBeforeRestart.generation,
  });
}
export async function collectAudioPreferencePersistenceEvidence(
  { handoff, handoffPath },
  dependencies = {},
) {
  const daemonRequest = dependencies.daemonRequest ?? daemon;
  const withUiClientFn =
    dependencies.withUiClient ??
    ((runtimeHandoff, operation) =>
      withMachineUiClient(runtimeHandoff, dependencies, operation));
  const setUiAudioPreferences =
    dependencies.setUiAudioPreferences ?? setMachineUiAudioPreferences;
  const readUiAudioPreferences =
    dependencies.readUiAudioPreferences ?? readMachineUiAudioPreferences;
  const ensureMaintenanceExperienceTaskFn =
    dependencies.ensureMaintenanceExperienceTask ??
    ensureMaintenanceExperienceTask;
  const restartRuntime =
    dependencies.restartRuntime ??
    ((runtimeHandoff, path) =>
      restartInstalledRuntime(runtimeHandoff, path, dependencies));
  const target = { ...AUDIO_PERSISTENCE_TARGET };
  const defaults = { ...MACHINE_AUDIO_DEFAULTS };
  let restoreError = null;
  let customApplied = false;
  const evidence = {
    target,
    defaults,
    preRestart: null,
    postRestart: null,
    restoredDefaults: null,
    restartedRuntime: null,
  };
  try {
    evidence.preRestart = await withUiClientFn(handoff, async (client) => {
      const uiAfterSave = await setUiAudioPreferences(client, target);
      const daemonAfterSave = await waitForMatch(
        "daemon effective audio preferences before restart",
        () => readDaemonAudioPreferences(handoff, daemonRequest),
        target,
      );
      customApplied = true;
      return {
        ui: normalizeAudioPreferences(uiAfterSave),
        daemon: normalizeAudioPreferences(daemonAfterSave),
      };
    });
    evidence.restartedRuntime = await restartRuntime(handoff, handoffPath);
    evidence.postRestart = await withUiClientFn(handoff, async (client) => {
      await ensureMaintenanceExperienceTaskFn(client);
      const uiAfterRestart = await waitForMatch(
        "machine UI audio preferences after restart",
        () => readUiAudioPreferences(client),
        target,
      );
      const daemonAfterRestart = await waitForMatch(
        "daemon effective audio preferences after restart",
        () => readDaemonAudioPreferences(handoff, daemonRequest),
        target,
      );
      return {
        ui: normalizeAudioPreferences(uiAfterRestart),
        daemon: normalizeAudioPreferences(daemonAfterRestart),
      };
    });
    return evidence;
  } finally {
    if (!customApplied) return;
    try {
      evidence.restoredDefaults = await withUiClientFn(
        handoff,
        async (client) => {
          const uiAfterRestore = await setUiAudioPreferences(client, defaults);
          const daemonAfterRestore = await waitForMatch(
            "daemon effective audio preferences after restore",
            () => readDaemonAudioPreferences(handoff, daemonRequest),
            defaults,
          );
          return {
            ui: normalizeAudioPreferences(uiAfterRestore),
            daemon: normalizeAudioPreferences(daemonAfterRestore),
          };
        },
      );
    } catch (error) {
      restoreError = error;
    }
    if (restoreError) {
      throw new Error(
        `audio preference default restoration failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
        { cause: restoreError },
      );
    }
  }
}

async function waitForSerialBoundary(input, sessionId, parsedOpcode) {
  return control(input, `/v1/serial-sessions/${sessionId}/wait-frame`, {
    parsedOpcode,
    timeoutMs: 30_000,
    serialScenario: "normal",
  });
}
export function selectPlanogramSlot(saleView, fixture) {
  const slotId = required(fixture?.slotId, "fixture.slotId");
  const item = (saleView?.items ?? []).find(
    (entry) => entry?.slotId === slotId,
  );
  if (
    !item?.inventoryId ||
    !saleView?.planogramVersion ||
    !Number.isInteger(item.rowNo) ||
    !Number.isInteger(item.cellNo)
  )
    throw new Error(`active planogram fixture slot ${slotId} is unavailable`);
  return {
    slotDisplayLabel: required(
      item.slotDisplayLabel,
      "sale-view slotDisplayLabel",
    ),
    slotId,
    inventoryId: item.inventoryId,
    planogramVersion: saleView.planogramVersion,
    rowNo: item.rowNo,
    cellNo: item.cellNo,
  };
}
export function manualDispenseFrames(beforeEvidence, afterEvidence) {
  const beforeCount = beforeEvidence?.rawFrames?.length ?? 0;
  return (afterEvidence?.rawFrames ?? []).slice(beforeCount);
}
export function validateLocalOperationsEvidence(report) {
  if (report?.schemaVersion !== SCHEMA_VERSION || report.ok !== true)
    throw new Error("local operations report is not successful");
  if (
    report.boundaries?.daemon !== true ||
    report.boundaries?.hardwareSelfCheck !== true ||
    report.boundaries?.serial !== true ||
    report.planogram?.canonical !== true
  )
    throw new Error("local operations boundary evidence is incomplete");
  if (
    report.manualDispense?.slotDisplayLabel == null ||
    !["completed", "failed", "result_unknown"].includes(
      report.manualDispense.outcome,
    )
  )
    throw new Error("manual dispense diagnostic outcome is missing");
  return {
    slotDisplayLabel: report.manualDispense.slotDisplayLabel,
    outcome: report.manualDispense.outcome,
    canonical: true,
  };
}
export async function runLocalOperationsGuest(options, dependencies = {}) {
  const readJsonFn = dependencies.readJson ?? readJson;
  const writeJsonFn = dependencies.writeJson ?? writeJson;
  const daemonRequest = dependencies.daemonRequest ?? daemon;
  const controlRequest = dependencies.controlRequest ?? control;
  const runSystemTouchKeyboard =
    dependencies.runInstalledSystemTouchKeyboardAcceptance ??
    runInstalledSystemTouchKeyboardAcceptance;
  const runAudioPreferencePersistence =
    dependencies.collectAudioPreferencePersistenceEvidence ??
    collectAudioPreferencePersistenceEvidence;
  const waitForSerialBoundaryFn =
    dependencies.waitForSerialBoundary ?? waitForSerialBoundary;
  const input = readJsonFn(options.guestInputPath);
  const handoff = readJsonFn(options.handoffPath);
  const runId = required(input.runId, "runId");
  const fixture =
    input.fixtureAllocation?.[options.fixtureKey ?? "localOperations"] ??
    input.fixtureAllocation?.sale;
  const report = {
    schemaVersion: SCHEMA_VERSION,
    ok: false,
    mode: options.mode,
    runId,
    boundaries: { daemon: false, hardwareSelfCheck: false, serial: false },
    planogram: { canonical: false },
    manualDispense: null,
    hardware: null,
    systemTouchKeyboard: null,
    audioPreferencePersistence: null,
  };
  let session = null;
  try {
    session = await controlRequest(input, "/v1/serial-sessions/start", {
      runId,
      machineCode: required(input.machineCode, "machineCode"),
      targetIdentity: required(
        input.hostControlPlane.targetIdentity,
        "hostControlPlane.targetIdentity",
      ),
      runtimeBase: required(
        input.hostControlPlane.runtimeBaseIdentity,
        "hostControlPlane.runtimeBaseIdentity",
      ),
      saleCorrelationId: `sale-correlation://${runId.toLowerCase()}.local-operations`,
    });
    const saleView = await daemonRequest(handoff, "/v1/sale-view");
    const slot = selectPlanogramSlot(saleView, fixture);
    report.planogram = {
      canonical: true,
      planogramVersion: slot.planogramVersion,
      slotDisplayLabel: slot.slotDisplayLabel,
      slotId: slot.slotId,
      rowNo: slot.rowNo,
      cellNo: slot.cellNo,
    };
    report.hardware = {
      selfCheck: await daemonRequest(handoff, "/v1/hardware/self-check", {}),
      bindings: await daemonRequest(handoff, "/v1/hardware-bindings"),
    };
    report.boundaries.daemon = true;
    report.boundaries.hardwareSelfCheck =
      report.hardware.selfCheck?.online === true;
    const beforeEvidence = await controlRequest(
      input,
      `/v1/serial-sessions/${session.sessionId}/evidence`,
    );
    const diagnosticPromise = daemonRequest(
      handoff,
      "/v1/maintenance/manual-dispense-diagnostic",
      {
        idempotencyKey: `${runId}-local-operations`,
        slotId: slot.slotId,
        quantity: 1,
        timeoutSeconds: 15,
      },
    );
    await waitForSerialBoundaryFn(input, session.sessionId, "VEND");
    await controlRequest(
      input,
      `/v1/serial-sessions/${session.sessionId}/release-f0`,
    );
    await waitForSerialBoundaryFn(input, session.sessionId, "F0");
    await waitForSerialBoundaryFn(input, session.sessionId, "F1");
    await controlRequest(
      input,
      `/v1/serial-sessions/${session.sessionId}/release-f2`,
    );
    await waitForSerialBoundaryFn(input, session.sessionId, "F2");
    const diagnostic = await diagnosticPromise;
    report.manualDispense = {
      ...diagnostic,
      slotDisplayLabel: slot.slotDisplayLabel,
      canonicalSlot: slot,
    };
    const evidence = await controlRequest(
      input,
      `/v1/serial-sessions/${session.sessionId}/evidence`,
    );
    report.serial = evidence;
    const operationFrames = manualDispenseFrames(beforeEvidence, evidence);
    report.serial.operationFrames = operationFrames;
    report.boundaries.serial = ["VEND", "F0", "F1", "AF", "F2"].every(
      (opcode) =>
        operationFrames.some((frame) => frame?.parsedOpcode === opcode),
    );
    if (diagnostic.outcome !== "completed" || !report.boundaries.serial)
      throw new Error(
        `manual dispense did not complete the lower-controller protocol: ${JSON.stringify({ outcome: diagnostic.outcome, frames: operationFrames.map((frame) => frame?.parsedOpcode) })}`,
      );
    report.audioPreferencePersistence = await runAudioPreferencePersistence(
      {
        input,
        handoff,
        handoffPath: options.handoffPath,
      },
      dependencies,
    );
    const keyboardOutPath = options.outPath.replace(
      /[^\\]+$/,
      "system-touch-keyboard.json",
    );
    try {
      report.systemTouchKeyboard = await runSystemTouchKeyboard({
        mode: options.mode,
        guestInputPath: options.guestInputPath,
        handoffPath: options.handoffPath,
        outPath: keyboardOutPath,
      });
    } catch (error) {
      report.systemTouchKeyboard = {
        ...readJson(keyboardOutPath),
        blocking: false,
        diagnosticError: error instanceof Error ? error.message : String(error),
      };
    }
    report.ok = true;
    validateLocalOperationsEvidence(report);
    writeJsonFn(options.outPath, report);
    return report;
  } catch (error) {
    report.error = {
      message: error instanceof Error ? error.message : String(error),
    };
    writeJsonFn(options.outPath, report);
    throw error;
  } finally {
    if (session?.sessionId)
      await controlRequest(
        input,
        `/v1/serial-sessions/${session.sessionId}/abort`,
      ).catch(() => null);
  }
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  runLocalOperationsGuest(
    parseLocalOperationsGuestArgs(process.argv.slice(2)),
  ).catch((error) => {
    console.error(error.stack ?? error);
    process.exitCode = 1;
  });
