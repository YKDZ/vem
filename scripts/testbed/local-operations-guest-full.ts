#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { waitForDaemonReadyRefresh } from "./daemon-ready-refresh.ts";
import { runInstalledSystemTouchKeyboardAcceptance } from "./installed-system-touch-keyboard.ts";
import {
  activateVisibleSelector,
  CdpClient,
  discoverCanonicalMachineUiTarget,
  enablePageRuntime,
  evaluateExpression,
  rewriteWebSocketDebuggerUrl,
  setCdpLocationHash,
  waitForRoute,
} from "./machine-ui-cdp-driver.ts";
import { replaceSerialSessionAndUpdateHandoff } from "./serial-session-handoff.ts";

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
const INSTALLED_RUNTIME_TASK = "VEMMachineUI";
const CANONICAL_DAEMON_PATH = "C:\\VEM\\bringup\\vending-daemon.exe";
const CANONICAL_MACHINE_PATH = "C:\\VEM\\bringup\\machine.exe";
const CANONICAL_CDP_ENDPOINT = "http://127.0.0.1:9222";
const EXPERIENCE_TASK_SELECTOR = "[data-test='maintenance-task-experience']";
const AUDIO_SELECTORS = Object.freeze({
  cuesEnabled: "[data-test='machine-audio-enabled']",
  presenceCuesEnabled: "[data-test='machine-audio-presence-enabled']",
  transactionCuesEnabled: "[data-test='machine-audio-transaction-enabled']",
  volumePercent: "[data-test='machine-audio-volume-percent']",
});
const MAINTENANCE_ENTRY_SELECTOR =
  "[data-test='maintenance-entry-brand'], [data-test='maintenance-entry-header']";
const MAINTENANCE_RETURN_SELECTOR = "[data-test='maintenance-return-catalog']";
const MAINTENANCE_TASK_KEYS = Object.freeze([
  "status",
  "commissioning",
  "hardware",
  "environment",
  "stock",
  "experience",
  "diagnostics",
]);
const DEFAULT_MAINTENANCE_ENTRY_ROUTES = Object.freeze(["#/catalog"]);
const HARDWARE_READY_TIMEOUT_MS = 30_000;
const HARDWARE_READY_POLL_MS = 500;

type JsonRecord = Record<string, unknown>;

function recordValue(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}
type GuestInputRecord = JsonRecord;
type HandoffRecord = JsonRecord;
type MachineUiClientDependencies = {
  discoverMachineUiTargetFn?: (options: {
    endpoint?: string;
    expectedTargetId?: unknown;
    timeoutMs?: number;
  }) => Promise<JsonRecord>;
  webSocketFactory?: (url: string) => WebSocket;
  cdpClientClass?: typeof CdpClient;
};

type RuntimeRestartDependencies = {
  runPowerShell?: (
    script: unknown,
    options?: {
      timeoutMs?: number;
      spawnImpl?: typeof spawn;
    },
  ) => Promise<string>;
  waitForDaemonReadyRefreshFn?: (
    handoff: JsonRecord,
    options?: unknown,
  ) => Promise<unknown>;
  discoverCanonicalMachineUiTargetFn?: (options: {
    endpoint?: string;
    timeoutMs?: number;
  }) => Promise<JsonRecord>;
  writeJsonFn?: (path: string, value: unknown) => void;
};

type AudioPersistenceDependencies = RuntimeRestartDependencies & {
  daemonRequest?: (
    handoff: HandoffRecord,
    path: string,
    body?: unknown,
  ) => Promise<unknown>;
  withUiClient?: (
    handoff: HandoffRecord,
    operation: (client: InstanceType<typeof CdpClient>) => Promise<unknown>,
  ) => Promise<unknown>;
  setUiAudioPreferences?: typeof setMachineUiAudioPreferences;
  readUiAudioPreferences?: typeof readMachineUiAudioPreferences;
  ensureMaintenanceExperienceTask?: typeof ensureMaintenanceExperienceTask;
  restartRuntime?: (
    handoff: HandoffRecord,
    path: string,
  ) => Promise<JsonRecord>;
};

type LocalOperationsGuestDependencies = {
  readJson?: (path: string) => JsonRecord;
  writeJson?: (path: string, value: unknown) => void;
  daemonRequest?: (
    handoff: HandoffRecord,
    path: string,
    body?: unknown,
  ) => Promise<unknown>;
  controlRequest?: (
    input: GuestInputRecord,
    path: string,
    body?: JsonRecord,
  ) => Promise<unknown>;
  runInstalledSystemTouchKeyboardAcceptance?: (
    ...args: unknown[]
  ) => Promise<unknown>;
  collectAudioPreferencePersistenceEvidence?: (
    options: { handoff: HandoffRecord; handoffPath: string },
    dependencies?: AudioPersistenceDependencies,
  ) => Promise<JsonRecord>;
  waitForSerialBoundary?: (
    input: GuestInputRecord,
    sessionId: string,
    parsedOpcode: string,
  ) => Promise<unknown>;
  collectMaintenanceEntryEvidence?: (
    handoff: HandoffRecord,
    dependencies?: JsonRecord,
  ) => Promise<JsonRecord>;
};

function required(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${label} is required`);
  return value.trim();
}
function option(args: string[], name: string): string {
  const i = args.indexOf(`--${name}`);
  return required(i < 0 ? undefined : args[i + 1], `--${name}`);
}
function localPath(value: unknown): string {
  const path = required(value, "Windows path");
  return process.platform === "win32"
    ? path
    : resolve(
        `/mnt/${path[0].toLowerCase()}/${path.slice(3).replaceAll("\\", "/")}`,
      );
}
export function parseLocalOperationsGuestArgs(args: string[]): {
  mode: "full";
  guestInputPath: string;
  handoffPath: string;
  outPath: string;
  fixtureKey: string | null;
} {
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
function readJson(path: string): JsonRecord {
  return JSON.parse(readFileSync(localPath(path), "utf8"));
}
function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(localPath(path)), { recursive: true });
  writeFileSync(localPath(path), `${JSON.stringify(value, null, 2)}\n`);
}
async function json(url: string, options: JsonRecord = {}): Promise<unknown> {
  const response = await fetch(url, {
    ...options,
    signal:
      (options.signal as AbortSignal | undefined) ??
      AbortSignal.timeout(30_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(
      `${options.method ?? "GET"} ${url} failed: ${JSON.stringify(payload)}`,
    );
  return payload;
}
function daemonUrl(handoff: HandoffRecord): string {
  const daemon = handoff.daemon as JsonRecord | undefined;
  const ready = daemon?.ready as JsonRecord | undefined;
  const url = required(ready?.healthzUrl, "daemon healthzUrl");
  if (!url.endsWith("/healthz"))
    throw new Error("daemon healthzUrl must end with /healthz");
  return url.slice(0, -"/healthz".length);
}
function daemon(
  handoff: HandoffRecord,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const daemon = handoff.daemon as JsonRecord | undefined;
  const ready = daemon?.ready as JsonRecord | undefined;
  return json(`${daemonUrl(handoff)}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${required(ready?.ipcToken, "daemon ipcToken")}`,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function control(
  input: GuestInputRecord,
  path: string,
  body: JsonRecord = {},
): Promise<unknown> {
  const plane = input.hostControlPlane as JsonRecord | undefined;
  return json(
    `${required(plane?.endpoint, "hostControlPlane.endpoint")}${path}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${required(plane?.token, "hostControlPlane.token")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
}
function lowerControllerBinding(
  snapshot: JsonRecord | null | undefined,
): JsonRecord | null {
  const roles = (snapshot?.roles ?? []) as unknown[];
  return (
    (roles.find(
      (role) =>
        (role as JsonRecord)?.role === "lower_controller" ||
        (role as JsonRecord)?.role === "lower-controller",
    ) as JsonRecord | undefined) ?? null
  );
}
export async function waitForLowerControllerReady(
  handoff: HandoffRecord,
  daemonRequest = daemon,
  {
    timeoutMs = HARDWARE_READY_TIMEOUT_MS,
    pollMs = HARDWARE_READY_POLL_MS,
    sleepFn = sleep,
  }: {
    timeoutMs?: number;
    pollMs?: number;
    sleepFn?: (milliseconds: number) => Promise<void>;
  } = {},
): Promise<JsonRecord> {
  const deadline = Date.now() + timeoutMs;
  let last: JsonRecord | null = null;
  do {
    const selfCheck = await daemonRequest(
      handoff,
      "/v1/hardware/self-check",
      {},
    ).catch((error) => ({
      error: error instanceof Error ? error.message : String(error),
    }));
    const bindings = await daemonRequest(
      handoff,
      "/v1/hardware-bindings",
    ).catch((error) => ({
      error: error instanceof Error ? error.message : String(error),
    }));
    const lower = lowerControllerBinding(bindings as JsonRecord | null);
    last = {
      selfCheck: selfCheck as JsonRecord,
      bindings: bindings as JsonRecord,
      lowerController: lower,
    };
    if (
      (selfCheck as JsonRecord | null)?.online === true &&
      (selfCheck as JsonRecord | null)?.adapter === "serial" &&
      lower?.ready === true &&
      typeof lower.currentPort === "string" &&
      lower.currentPort === (selfCheck as JsonRecord | null)?.portPath
    ) {
      return last;
    }
    await sleepFn(pollMs);
  } while (Date.now() < deadline);
  throw new Error(
    `lower controller did not become ready for local operations: ${JSON.stringify(last)}`,
  );
}
function boundedNumber(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label} must be finite`);
  return number;
}
export function normalizeAudioPreferences(
  value: JsonRecord | null | undefined,
): JsonRecord {
  return {
    volume: Number(boundedNumber(value?.volume, "audio volume").toFixed(2)),
    cuesEnabled: Boolean(value?.cuesEnabled),
    presenceCuesEnabled: Boolean(value?.presenceCuesEnabled),
    transactionCuesEnabled: Boolean(value?.transactionCuesEnabled),
  };
}
export function audioPreferencesEqual(
  left: JsonRecord | null | undefined,
  right: JsonRecord | null | undefined,
): boolean {
  const actual = normalizeAudioPreferences(left);
  const expected = normalizeAudioPreferences(right);
  return (
    actual.volume === expected.volume &&
    actual.cuesEnabled === expected.cuesEnabled &&
    actual.presenceCuesEnabled === expected.presenceCuesEnabled &&
    actual.transactionCuesEnabled === expected.transactionCuesEnabled
  );
}
function describeAudioPreferences(value: unknown): string {
  return JSON.stringify(
    normalizeAudioPreferences(value as JsonRecord | null | undefined),
  );
}
async function waitForState(
  label: string,
  read: () => Promise<unknown>,
  accept: (value: unknown) => boolean,
  describe: (value: unknown) => string = (value) => JSON.stringify(value),
  timeoutMs = AUDIO_PREFERENCE_TIMEOUT_MS,
): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown = null;
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
  label: string,
  read: () => Promise<unknown>,
  expected: JsonRecord | null | undefined,
  timeoutMs = AUDIO_PREFERENCE_TIMEOUT_MS,
): Promise<JsonRecord> {
  return normalizeAudioPreferences(
    (await waitForState(
      label,
      read,
      (last) =>
        audioPreferencesEqual(last as JsonRecord | null | undefined, expected),
      describeAudioPreferences,
      timeoutMs,
    )) as JsonRecord | null | undefined,
  );
}
async function daemonRuntimeConfiguration(
  handoff: HandoffRecord,
  daemonRequest: (
    handoff: HandoffRecord,
    path: string,
    body?: unknown,
  ) => Promise<unknown> = daemon,
): Promise<unknown> {
  return daemonRequest(handoff, "/v1/runtime-configuration");
}
async function readDaemonAudioPreferences(
  handoff: HandoffRecord,
  daemonRequest: (
    handoff: HandoffRecord,
    path: string,
    body?: unknown,
  ) => Promise<unknown> = daemon,
): Promise<JsonRecord> {
  const configuration = await daemonRuntimeConfiguration(
    handoff,
    daemonRequest,
  );
  return normalizeAudioPreferences(
    ((configuration as JsonRecord | null)?.experience as JsonRecord | undefined)
      ?.audio as JsonRecord | undefined,
  );
}
async function setDaemonAudioPreferences(
  handoff: HandoffRecord,
  preferences: JsonRecord | null | undefined,
  daemonRequest: (
    handoff: HandoffRecord,
    path: string,
    body?: unknown,
  ) => Promise<unknown>,
): Promise<JsonRecord> {
  const configuration = await daemonRequest(
    handoff,
    "/v1/runtime-configuration/intents/audio-preferences",
    normalizeAudioPreferences(preferences),
  );
  return normalizeAudioPreferences(
    ((configuration as JsonRecord | null)?.experience as JsonRecord | undefined)
      ?.audio as JsonRecord | undefined,
  );
}
async function setRoute(
  client: InstanceType<typeof CdpClient>,
  route: string,
): Promise<unknown> {
  await setCdpLocationHash(client, route);
  return waitForRoute(client, route, {
    timeoutMs: AUDIO_PREFERENCE_TIMEOUT_MS,
    pollMs: 150,
    forbiddenRoutes: route.startsWith("#/maintenance") ? [] : undefined,
  });
}
export function maintenanceEntryRoutesForSaleView(
  saleView: JsonRecord | null | undefined,
): string[] {
  const items = ((saleView as JsonRecord | null)?.items ?? []) as unknown[];
  const item = items.find(
    (candidate) =>
      (typeof (candidate as JsonRecord)?.catalogKey === "string" &&
        String((candidate as JsonRecord)?.catalogKey ?? "") !== "") ||
      (typeof (candidate as JsonRecord)?.productId === "string" &&
        String((candidate as JsonRecord)?.productId ?? "") !== ""),
  );
  const itemRecord = item as JsonRecord | undefined;
  const catalogKey =
    typeof itemRecord?.catalogKey === "string" &&
    String(itemRecord?.catalogKey ?? "") !== ""
      ? String(itemRecord.catalogKey)
      : typeof itemRecord?.productId === "string" &&
          String(itemRecord?.productId ?? "") !== ""
        ? `product:${String(itemRecord.productId)}`
        : null;
  return [
    ...DEFAULT_MAINTENANCE_ENTRY_ROUTES,
    ...(catalogKey ? [`#/products/${encodeURIComponent(catalogKey)}`] : []),
  ];
}
async function ensureMaintenanceExperienceTask(
  client: InstanceType<typeof CdpClient>,
): Promise<void> {
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
    (value) => {
      const valueRecord = value as JsonRecord;
      return valueRecord?.visible === true && valueRecord?.selected === true;
    },
  );
}
export async function readMachineUiAudioPreferences(
  client: InstanceType<typeof CdpClient>,
): Promise<JsonRecord> {
  const value = (await evaluateExpression(
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
  )) as JsonRecord | null;
  if (!value)
    throw new Error("machine UI audio preference controls are unavailable");
  return normalizeAudioPreferences(value);
}
async function setMachineUiCheckbox(
  client: InstanceType<typeof CdpClient>,
  selector: string,
  expected: boolean,
): Promise<void> {
  const readState = () =>
    evaluateExpression(
      client,
      `(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        return element
          ? { checked: Boolean(element.checked), disabled: Boolean(element.disabled) }
          : null;
      })()`,
    );
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = (await readState()) as JsonRecord | null;
    if (current == null)
      throw new Error(`machine UI control is unavailable: ${selector}`);
    if (current.checked === expected && current.disabled === false) return;
    if (current.disabled) {
      await waitForState(
        `machine UI checkbox ${selector} enabled`,
        readState,
        (value) => (value as JsonRecord | null)?.disabled === false,
      );
    }
    await activateVisibleSelector(client, selector, {
      kind: "touch",
      timeoutMs: AUDIO_PREFERENCE_TIMEOUT_MS,
      pollMs: 150,
    });
    try {
      await waitForState(
        `machine UI checkbox ${selector}`,
        readState,
        (value) => {
          const valueRecord = value as JsonRecord | null;
          return (
            valueRecord?.checked === expected && valueRecord?.disabled === false
          );
        },
      );
      return;
    } catch (error) {
      if (attempt === 1) throw error;
    }
  }
}
async function setMachineUiVolumePercent(
  client: InstanceType<typeof CdpClient>,
  expectedVolume: number,
): Promise<void> {
  const percent = Math.round(
    Number(
      normalizeAudioPreferences({
        ...MACHINE_AUDIO_DEFAULTS,
        volume: expectedVolume,
      }).volume,
    ) * 100,
  );
  const readState = () =>
    evaluateExpression(
      client,
      `(() => {
        const element = document.querySelector(${JSON.stringify(AUDIO_SELECTORS.volumePercent)});
        return element
          ? { value: Number(element.value), disabled: Boolean(element.disabled) }
          : null;
      })()`,
    );
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = await waitForState(
      "machine UI volume control enabled",
      readState,
      (value) => {
        const valueRecord = value as JsonRecord | null;
        return valueRecord != null && valueRecord.disabled === false;
      },
    );
    const currentRecord = current as JsonRecord;
    if (currentRecord.value === percent) return;
    const result = (await evaluateExpression(
      client,
      `(() => {
        const element = document.querySelector(${JSON.stringify(AUDIO_SELECTORS.volumePercent)});
        if (!element) return null;
        element.value = ${percent};
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
        return { value: Number(element.value), disabled: Boolean(element.disabled) };
      })()`,
    )) as JsonRecord | null;
    if (!result) throw new Error("machine UI volume control is unavailable");
    try {
      await waitForState("machine UI volume", readState, (value) => {
        const valueRecord = value as JsonRecord;
        return (
          valueRecord?.value === percent && valueRecord?.disabled === false
        );
      });
      return;
    } catch (error) {
      if (attempt === 1) throw error;
    }
  }
}
export async function setMachineUiAudioPreferences(
  client: InstanceType<typeof CdpClient>,
  expected: JsonRecord | null | undefined,
): Promise<JsonRecord> {
  const target = normalizeAudioPreferences(expected);
  await ensureMaintenanceExperienceTask(client);
  await setMachineUiCheckbox(
    client,
    AUDIO_SELECTORS.cuesEnabled,
    Boolean(target.cuesEnabled),
  );
  await setMachineUiCheckbox(
    client,
    AUDIO_SELECTORS.presenceCuesEnabled,
    Boolean(target.presenceCuesEnabled),
  );
  await setMachineUiCheckbox(
    client,
    AUDIO_SELECTORS.transactionCuesEnabled,
    Boolean(target.transactionCuesEnabled),
  );
  await setMachineUiVolumePercent(client, Number(target.volume));
  return waitForMatch(
    "machine UI audio preferences",
    () => readMachineUiAudioPreferences(client),
    target,
  );
}
export async function collectMaintenanceEntryEvidence(
  handoff: HandoffRecord,
  dependencies: JsonRecord = {},
): Promise<JsonRecord> {
  const withMachineUiClientFn = dependencies.withUiClient as
    | ((
        runtimeHandoff: HandoffRecord,
        operation: (client: InstanceType<typeof CdpClient>) => Promise<unknown>,
      ) => Promise<unknown>)
    | undefined;
  const withUiClientFn =
    withMachineUiClientFn ??
    ((runtimeHandoff, operation) =>
      withMachineUiClient(
        runtimeHandoff,
        dependencies as MachineUiClientDependencies,
        operation,
      ));
  return (await withUiClientFn(handoff, async (client) => {
    const entries: unknown[] = [];
    const routes =
      (dependencies.maintenanceEntryRoutes as string[] | undefined) ??
      DEFAULT_MAINTENANCE_ENTRY_ROUTES;
    for (const route of routes) {
      await setRoute(client, route);
      await sleep(800);
      let finalRoute = null;
      const attempts = [];
      for (let index = 0; index < 10; index += 1) {
        const activation = await activateVisibleSelector(
          client,
          MAINTENANCE_ENTRY_SELECTOR,
          {
            kind: "mouse",
            timeoutMs: AUDIO_PREFERENCE_TIMEOUT_MS,
            pollMs: 150,
          },
        );
        const activationRecord = activation as JsonRecord;
        await sleep(220);
        const currentRoute = await evaluateExpression(client, "location.hash", {
          timeoutMs: AUDIO_PREFERENCE_TIMEOUT_MS,
        });
        attempts.push({
          attempt: index + 1,
          route: currentRoute,
          center: activationRecord.center,
        });
        if (currentRoute === "#/maintenance?source=operator") {
          finalRoute = { route: currentRoute };
          break;
        }
      }
      try {
        finalRoute ??= await waitForRoute(
          client,
          "#/maintenance?source=operator",
          {
            timeoutMs: 5_000,
            pollMs: 150,
            forbiddenRoutes: [],
          },
        );
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; attempts=${JSON.stringify(attempts)}`,
          { cause: error },
        );
      }
      entries.push({
        route,
        selector: MAINTENANCE_ENTRY_SELECTOR,
        finalRoute: finalRoute?.route ?? finalRoute,
        attempts,
        ok: true,
      });
    }
    const taskReturns = [];
    for (const task of MAINTENANCE_TASK_KEYS) {
      await setRoute(client, "#/maintenance?source=operator");
      await activateVisibleSelector(
        client,
        `[data-test='maintenance-task-${task}']`,
        {
          kind: "touch",
          timeoutMs: AUDIO_PREFERENCE_TIMEOUT_MS,
          pollMs: 150,
        },
      );
      await activateVisibleSelector(client, MAINTENANCE_RETURN_SELECTOR, {
        kind: "touch",
        timeoutMs: AUDIO_PREFERENCE_TIMEOUT_MS,
        pollMs: 150,
      });
      const finalRoute = await waitForRoute(client, "#/catalog", {
        timeoutMs: AUDIO_PREFERENCE_TIMEOUT_MS,
        pollMs: 150,
        forbiddenRoutes: [],
      });
      taskReturns.push({
        task,
        selector: `[data-test='maintenance-task-${task}']`,
        returnSelector: MAINTENANCE_RETURN_SELECTOR,
        finalRoute: finalRoute?.route ?? finalRoute,
        ok: true,
      });
    }
    return { entries, taskReturns };
  })) as JsonRecord;
}
async function withMachineUiClient(
  handoff: HandoffRecord,
  {
    discoverMachineUiTargetFn = discoverCanonicalMachineUiTarget,
    webSocketFactory,
    cdpClientClass = CdpClient,
  }: MachineUiClientDependencies = {},
  operation: (
    client: InstanceType<typeof CdpClient>,
    target?: JsonRecord,
  ) => Promise<unknown>,
): Promise<unknown> {
  const cdp = handoff?.cdp as JsonRecord | undefined;
  const endpoint = required(cdp?.endpoint, "handoff cdp endpoint");
  const target = (await discoverMachineUiTargetFn({
    endpoint,
    expectedTargetId: cdp?.targetId,
  })) as JsonRecord;
  if (cdp) cdp.targetId = target.id;
  const client = new cdpClientClass(
    rewriteWebSocketDebuggerUrl(String(target.webSocketDebuggerUrl), endpoint),
    {
      webSocketFactory: webSocketFactory as
        | ((url: string) => WebSocket)
        | undefined,
    },
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
  script: unknown,
  {
    timeoutMs = AUDIO_PREFERENCE_TIMEOUT_MS,
    spawnImpl = spawn,
  }: {
    timeoutMs?: number;
    spawnImpl?: typeof spawn;
  } = {},
): Promise<string> {
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
    new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      },
    ),
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
$daemonServiceName = 'VemVendingDaemon'
$daemonService = Get-Service -Name $daemonServiceName -ErrorAction SilentlyContinue
if ($null -ne $daemonService) {
  Stop-Service -Name $daemonServiceName -Force -ErrorAction SilentlyContinue
}
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
if ($null -ne $daemonService) {
  Start-Service -Name $daemonServiceName -ErrorAction Stop
  $daemonProcess = $null
  for ($attempt = 0; $attempt -lt 100; $attempt += 1) {
    $daemonAlive = @(Get-CimInstance Win32_Process -Filter "Name = 'vending-daemon.exe'" | Where-Object {
      $_.ExecutablePath -and ([System.IO.Path]::GetFullPath($_.ExecutablePath) -ieq $daemonPath)
    })
    if ($daemonAlive.Count -eq 1) {
      $daemonProcess = Get-Process -Id ([int]$daemonAlive[0].ProcessId) -ErrorAction Stop
      break
    }
    if ($daemonAlive.Count -gt 1) { throw "daemon_count:$($daemonAlive.Count)" }
    Start-Sleep -Milliseconds 200
  }
  if ($null -eq $daemonProcess) { throw 'daemon_service_start_timeout' }
} else {
  $daemonProcess = Start-Process -FilePath $daemonPath -ArgumentList @('--console', '--data-dir', $daemonDataDirectory) -WorkingDirectory ([System.IO.Path]::GetDirectoryName($daemonPath)) -PassThru
}
Start-ScheduledTask -TaskName $taskName
[Console]::Out.WriteLine(([ordered]@{
  daemonProcessId = [int]$daemonProcess.Id
  daemonService = if ($null -ne $daemonService) { $daemonServiceName } else { $null }
  taskName = $taskName
} | ConvertTo-Json -Compress))
`.trim();
}
export function buildInstalledDaemonRestartScript({
  daemonPath = CANONICAL_DAEMON_PATH,
  daemonDataDirectory = "C:\\ProgramData\\VEM\\vending-daemon",
} = {}) {
  const encodedDaemonPath = Buffer.from(daemonPath, "utf8").toString("base64");
  const encodedDaemonDataDirectory = Buffer.from(
    daemonDataDirectory,
    "utf8",
  ).toString("base64");
  return `
$ErrorActionPreference = 'Stop'
$daemonPath = [System.IO.Path]::GetFullPath([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encodedDaemonPath}')))
$daemonDataDirectory = [System.IO.Path]::GetFullPath([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encodedDaemonDataDirectory}')))
$daemonServiceName = 'VemVendingDaemon'
$daemonService = Get-Service -Name $daemonServiceName -ErrorAction SilentlyContinue
if ($null -ne $daemonService) {
  Restart-Service -Name $daemonServiceName -Force -ErrorAction Stop
} else {
  Get-CimInstance Win32_Process -Filter "Name = 'vending-daemon.exe'" | Where-Object {
    $_.ExecutablePath -and ([System.IO.Path]::GetFullPath($_.ExecutablePath) -ieq $daemonPath)
  } | ForEach-Object {
    try { Stop-Process -Id ([int]$_.ProcessId) -Force -ErrorAction Stop } catch {}
  }
  for ($attempt = 0; $attempt -lt 100; $attempt += 1) {
    $daemonAlive = @(Get-CimInstance Win32_Process -Filter "Name = 'vending-daemon.exe'" | Where-Object {
      $_.ExecutablePath -and ([System.IO.Path]::GetFullPath($_.ExecutablePath) -ieq $daemonPath)
    })
    if ($daemonAlive.Count -eq 0) { break }
    Start-Sleep -Milliseconds 200
  }
  $null = Start-Process -FilePath $daemonPath -ArgumentList @('--console', '--data-dir', $daemonDataDirectory) -WorkingDirectory ([System.IO.Path]::GetDirectoryName($daemonPath)) -PassThru
}
$daemonProcess = $null
for ($attempt = 0; $attempt -lt 100; $attempt += 1) {
  $daemonAlive = @(Get-CimInstance Win32_Process -Filter "Name = 'vending-daemon.exe'" | Where-Object {
    $_.ExecutablePath -and ([System.IO.Path]::GetFullPath($_.ExecutablePath) -ieq $daemonPath)
  })
  if ($daemonAlive.Count -eq 1) {
    $daemonProcess = Get-Process -Id ([int]$daemonAlive[0].ProcessId) -ErrorAction Stop
    break
  }
  if ($daemonAlive.Count -gt 1) { throw "daemon_count:$($daemonAlive.Count)" }
  Start-Sleep -Milliseconds 200
}
if ($null -eq $daemonProcess) { throw 'daemon_restart_timeout' }
[Console]::Out.WriteLine(([ordered]@{
  daemonProcessId = [int]$daemonProcess.Id
  daemonService = if ($null -ne $daemonService) { $daemonServiceName } else { $null }
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
  handoff: HandoffRecord,
  {
    ready,
    observedRuntime,
    target,
  }: {
    ready: JsonRecord;
    observedRuntime: JsonRecord;
    target: JsonRecord | null | undefined;
  },
): JsonRecord {
  const observedDaemon = observedRuntime.daemon as JsonRecord | undefined;
  const observedMachine = observedRuntime.machine as JsonRecord | undefined;
  const observedCdp = observedRuntime.cdp as JsonRecord | undefined;
  const handoffDaemon = handoff.daemon as JsonRecord | undefined;
  const handoffMachine = handoff.machine as JsonRecord | undefined;
  const handoffCdp = handoff.cdp as JsonRecord | undefined;
  const next = {
    ...handoff,
    daemon: {
      ...(handoffDaemon ?? {}),
      ...(observedDaemon ?? {}),
      ready: { ...ready },
    },
    machine: {
      ...(handoffMachine ?? {}),
      ...(observedMachine ?? {}),
    },
    cdp: {
      ...(handoffCdp ?? {}),
      ...(observedCdp ?? {}),
      endpoint: observedCdp?.endpoint,
      targetId: required(target?.id, "CDP target id"),
    },
  };
  return next as JsonRecord;
}
async function refreshRestartedRuntimeHandoff(
  handoff: HandoffRecord,
  handoffPath: string,
  {
    previousGeneration,
    waitForDaemonReadyRefreshFn = waitForDaemonReadyRefresh as (
      handoff: JsonRecord,
      options?: unknown,
    ) => Promise<unknown>,
    discoverCanonicalMachineUiTargetFn = discoverCanonicalMachineUiTarget,
    runPowerShell = runLocalPowerShell,
    writeJsonFn = writeJson,
  }: RuntimeRestartDependencies & { previousGeneration?: unknown } = {},
): Promise<JsonRecord> {
  const baselineGeneration = required(
    previousGeneration ??
      (
        (handoff.daemon as JsonRecord | undefined)?.ready as
          | JsonRecord
          | undefined
      )?.generation,
    "daemon ready generation before restart",
  );
  let ready: JsonRecord | null = null;
  const deadline = Date.now() + AUDIO_PREFERENCE_TIMEOUT_MS;
  do {
    ready = (await waitForDaemonReadyRefreshFn(handoff)) as JsonRecord;
    if (ready.generation !== baselineGeneration) break;
    await sleep(200);
  } while (Date.now() < deadline);
  if (!ready || ready.generation === baselineGeneration) {
    throw new Error("daemon ready generation did not advance after restart");
  }
  let target: JsonRecord | null = null;
  do {
    try {
      target = await discoverCanonicalMachineUiTargetFn({
        endpoint:
          String((handoff?.cdp as JsonRecord | undefined)?.endpoint ?? "") ||
          CANONICAL_CDP_ENDPOINT,
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
  ) as JsonRecord;
  const next = applyRestartedRuntimeHandoff(handoff, {
    ready,
    observedRuntime,
    target,
  });
  handoff.daemon = next.daemon;
  handoff.machine = next.machine;
  handoff.cdp = next.cdp;
  writeJsonFn(handoffPath, handoff);
  const handoffDaemon = handoff.daemon as JsonRecord;
  const handoffMachine = handoff.machine as JsonRecord;
  const handoffCdp = handoff.cdp as JsonRecord;
  return {
    ready: { ...(handoffDaemon.ready as JsonRecord) },
    machine: { ...handoffMachine },
    daemon: { ...handoffDaemon },
    cdp: { ...handoffCdp },
  };
}
export async function restartInstalledRuntime(
  handoff: HandoffRecord,
  handoffPath: string,
  dependencies: RuntimeRestartDependencies = {},
): Promise<JsonRecord> {
  const runPowerShell = dependencies.runPowerShell ?? runLocalPowerShell;
  const waitForDaemonReadyRefreshFn =
    dependencies.waitForDaemonReadyRefreshFn ??
    (waitForDaemonReadyRefresh as (
      handoff: JsonRecord,
      options?: unknown,
    ) => Promise<unknown>);
  const readyBeforeRestart = (await waitForDaemonReadyRefreshFn(
    handoff,
  )) as JsonRecord;
  await runPowerShell(
    buildInstalledRuntimeRestartScript({
      daemonPath:
        String(
          (handoff.daemon as JsonRecord | undefined)?.executablePath ?? "",
        ) || CANONICAL_DAEMON_PATH,
      daemonDataDirectory: required(
        (handoff.daemon as JsonRecord | undefined)?.dataDirectory,
        "handoff daemon dataDirectory",
      ),
      machinePath:
        String(
          (handoff.machine as JsonRecord | undefined)?.executablePath ?? "",
        ) || CANONICAL_MACHINE_PATH,
    }),
  );
  return refreshRestartedRuntimeHandoff(handoff, handoffPath, {
    ...dependencies,
    runPowerShell,
    waitForDaemonReadyRefreshFn,
    previousGeneration: readyBeforeRestart.generation,
  });
}
export async function restartInstalledDaemon(
  handoff: HandoffRecord,
  handoffPath: string,
  dependencies: RuntimeRestartDependencies = {},
): Promise<JsonRecord> {
  const runPowerShell = dependencies.runPowerShell ?? runLocalPowerShell;
  const waitForDaemonReadyRefreshFn =
    dependencies.waitForDaemonReadyRefreshFn ??
    (waitForDaemonReadyRefresh as (
      handoff: JsonRecord,
      options?: unknown,
    ) => Promise<unknown>);
  const writeJsonFn = dependencies.writeJsonFn ?? writeJson;
  const readyBeforeRestart = (await waitForDaemonReadyRefreshFn(
    handoff,
  )) as JsonRecord;
  const restartObservation = recordValue(
    JSON.parse(
      await runPowerShell(
        buildInstalledDaemonRestartScript({
          daemonPath:
            String(
              (handoff.daemon as JsonRecord | undefined)?.executablePath ?? "",
            ) || CANONICAL_DAEMON_PATH,
          daemonDataDirectory: required(
            (handoff.daemon as JsonRecord | undefined)?.dataDirectory,
            "handoff daemon dataDirectory",
          ),
        }),
      ),
    ),
  );
  const deadline = Date.now() + AUDIO_PREFERENCE_TIMEOUT_MS;
  let ready: JsonRecord | null = null;
  do {
    ready = (await waitForDaemonReadyRefreshFn(handoff)) as JsonRecord;
    if (ready.generation !== readyBeforeRestart.generation) break;
    await sleep(200);
  } while (Date.now() < deadline);
  if (!ready || ready.generation === readyBeforeRestart.generation) {
    throw new Error("daemon ready generation did not advance after restart");
  }
  const daemonProcessId = Number(restartObservation.daemonProcessId);
  if (!Number.isInteger(daemonProcessId) || daemonProcessId <= 0) {
    throw new Error("daemon restart did not report one valid process owner");
  }
  const daemon = recordValue(handoff.daemon);
  handoff.daemon = {
    ...daemon,
    processId: daemonProcessId,
    serviceName: restartObservation.daemonService ?? null,
    ready: { ...ready },
  };
  writeJsonFn(handoffPath, handoff);
  return {
    ready: { ...ready },
    daemon: { ...(handoff.daemon as JsonRecord) },
  };
}
export async function collectAudioPreferencePersistenceEvidence(
  { handoff, handoffPath }: { handoff: HandoffRecord; handoffPath: string },
  dependencies: AudioPersistenceDependencies = {},
): Promise<JsonRecord> {
  const daemonRequest = dependencies.daemonRequest ?? daemon;
  const withUiClientFn =
    dependencies.withUiClient ??
    ((runtimeHandoff, operation) =>
      withMachineUiClient(
        runtimeHandoff,
        dependencies as MachineUiClientDependencies,
        operation,
      ));
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
  let activeHandoff: HandoffRecord = handoff;
  let restoreError: unknown = null;
  let customApplied = false;
  const evidence: JsonRecord = {
    target,
    defaults,
    preRestart: null,
    postRestart: null,
    restoredDefaults: null,
    restoreWarning: null,
    restartedRuntime: null,
  };
  try {
    evidence.preRestart = await withUiClientFn(
      activeHandoff,
      async (client) => {
        const uiAfterSave = await setUiAudioPreferences(client, target);
        const daemonAfterSave = await waitForMatch(
          "daemon effective audio preferences before restart",
          () => readDaemonAudioPreferences(activeHandoff, daemonRequest),
          target,
        );
        customApplied = true;
        return {
          ui: normalizeAudioPreferences(uiAfterSave),
          daemon: normalizeAudioPreferences(daemonAfterSave),
        };
      },
    );
    evidence.restartedRuntime = await restartRuntime(
      activeHandoff,
      handoffPath,
    );
    const restartedRuntime = evidence.restartedRuntime as JsonRecord;
    activeHandoff = {
      ...activeHandoff,
      daemon: restartedRuntime.daemon,
      machine: restartedRuntime.machine,
      cdp: restartedRuntime.cdp,
    };
    handoff.daemon = activeHandoff.daemon;
    handoff.machine = activeHandoff.machine;
    handoff.cdp = activeHandoff.cdp;
    evidence.postRestart = await withUiClientFn(
      activeHandoff,
      async (client) => {
        await ensureMaintenanceExperienceTaskFn(client);
        const uiAfterRestart = await waitForMatch(
          "machine UI audio preferences after restart",
          () => readUiAudioPreferences(client),
          target,
        );
        const daemonAfterRestart = await waitForMatch(
          "daemon effective audio preferences after restart",
          () => readDaemonAudioPreferences(activeHandoff, daemonRequest),
          target,
        );
        return {
          ui: normalizeAudioPreferences(uiAfterRestart),
          daemon: normalizeAudioPreferences(daemonAfterRestart),
        };
      },
    );
    return evidence;
  } finally {
    if (!customApplied) return evidence;
    try {
      evidence.restoredDefaults = await withUiClientFn(
        activeHandoff,
        async (client) => {
          const uiAfterRestore = await setUiAudioPreferences(client, defaults);
          const daemonAfterRestore = await waitForMatch(
            "daemon effective audio preferences after restore",
            () => readDaemonAudioPreferences(activeHandoff, daemonRequest),
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
      evidence.restoreWarning =
        restoreError instanceof Error
          ? restoreError.message
          : String(restoreError);
      const daemonAfterForcedRestore = await setDaemonAudioPreferences(
        activeHandoff,
        defaults,
        daemonRequest,
      );
      const daemonAfterRestore = await waitForMatch(
        "daemon effective audio preferences after forced restore",
        () => readDaemonAudioPreferences(activeHandoff, daemonRequest),
        defaults,
      );
      evidence.restoredDefaults = {
        ui: null,
        daemon: daemonAfterRestore,
        forcedDaemonWrite: daemonAfterForcedRestore,
      };
    }
  }
}

export function serialBoundaryWaitRequest(parsedOpcode: string): JsonRecord {
  return {
    parsedOpcode,
    timeoutMs: 30_000,
  };
}

async function waitForSerialBoundary(
  input: GuestInputRecord,
  sessionId: string,
  parsedOpcode: string,
): Promise<unknown> {
  return control(
    input,
    `/v1/serial-sessions/${sessionId}/wait-frame`,
    serialBoundaryWaitRequest(parsedOpcode),
  );
}
export function selectPlanogramSlot(
  saleView: JsonRecord | null | undefined,
  fixture: JsonRecord | null | undefined,
): JsonRecord {
  const slotId = required(fixture?.slotId, "fixture.slotId");
  const items = ((saleView as JsonRecord | null)?.items ?? []) as unknown[];
  const item = items.find((entry) => (entry as JsonRecord)?.slotId === slotId);
  const itemRecord = item as JsonRecord | undefined;
  if (
    !itemRecord?.inventoryId ||
    !saleView?.planogramVersion ||
    !Number.isInteger(itemRecord.rowNo) ||
    !Number.isInteger(itemRecord.cellNo)
  )
    throw new Error(`active planogram fixture slot ${slotId} is unavailable`);
  return {
    slotDisplayLabel: required(
      itemRecord.slotDisplayLabel,
      "sale-view slotDisplayLabel",
    ),
    slotId,
    inventoryId: itemRecord.inventoryId,
    planogramVersion: saleView.planogramVersion,
    rowNo: itemRecord.rowNo,
    cellNo: itemRecord.cellNo,
  };
}
export function manualDispenseFrames(
  beforeEvidence: JsonRecord | null | undefined,
  afterEvidence: JsonRecord | null | undefined,
): unknown[] {
  const beforeCount =
    (beforeEvidence?.rawFrames as unknown[] | undefined)?.length ?? 0;
  return ((afterEvidence?.rawFrames ?? []) as unknown[]).slice(beforeCount);
}

export function localEnvironmentControlFrames(
  beforeEvidence: JsonRecord | null | undefined,
  afterEvidence: JsonRecord | null | undefined,
): unknown[] {
  return manualDispenseFrames(beforeEvidence, afterEvidence).filter(
    (frame) => (frame as JsonRecord)?.parsedOpcode === "B3",
  );
}

export function validateLocalOperationsEvidence(
  report: JsonRecord | null | undefined,
): JsonRecord {
  if (report?.schemaVersion !== SCHEMA_VERSION || report.ok !== true)
    throw new Error("local operations report is not successful");
  const boundaries = report.boundaries as JsonRecord | undefined;
  const planogram = report.planogram as JsonRecord | undefined;
  const manualDispense = report.manualDispense as JsonRecord | undefined;
  const localEnvironmentControl = report.localEnvironmentControl as
    | JsonRecord
    | undefined;
  const maintenanceEntry = report.maintenanceEntry as JsonRecord | undefined;
  if (
    boundaries?.daemon !== true ||
    boundaries?.hardwareSelfCheck !== true ||
    boundaries?.serial !== true ||
    planogram?.canonical !== true
  )
    throw new Error("local operations boundary evidence is incomplete");
  if (planogram?.slotId == null || manualDispense?.slotId !== planogram?.slotId)
    throw new Error("manual dispense slotId must match the planogram slotId");
  if (
    manualDispense?.slotDisplayLabel == null ||
    !["completed", "failed", "result_unknown"].includes(
      String(manualDispense.outcome),
    )
  )
    throw new Error("manual dispense diagnostic outcome is missing");
  if (
    recordValue(localEnvironmentControl?.request).source !== "local_operator" ||
    recordValue(recordValue(localEnvironmentControl?.request).action).type !==
      "set_base_vent_speed" ||
    recordValue(recordValue(localEnvironmentControl?.request).action)
      .ventSpeed !== 3 ||
    recordValue(localEnvironmentControl?.admission).outcome !== "accepted" ||
    !Number.isInteger(
      recordValue(localEnvironmentControl?.admission).acceptedRevision,
    ) ||
    recordValue(recordValue(localEnvironmentControl?.snapshot).settings)
      .baseVentSpeed !== 3 ||
    recordValue(recordValue(localEnvironmentControl?.snapshot).desired)
      .ventSpeed !== 3 ||
    recordValue(localEnvironmentControl?.snapshot).convergence !== "applied" ||
    (localEnvironmentControl?.protocolFrame as JsonRecord | undefined)
      ?.parsedOpcode !== "B3"
  )
    throw new Error("local environment control evidence is incomplete");
  if (
    !Array.isArray(maintenanceEntry?.entries) ||
    (maintenanceEntry?.entries as unknown[]).length <
      DEFAULT_MAINTENANCE_ENTRY_ROUTES.length ||
    (maintenanceEntry?.entries as unknown[]).some((entry) => {
      const entryRecord = entry as JsonRecord;
      return (
        entryRecord?.ok !== true ||
        typeof entryRecord.route !== "string" ||
        entryRecord.finalRoute !== "#/maintenance?source=operator"
      );
    }) ||
    !DEFAULT_MAINTENANCE_ENTRY_ROUTES.every((route) =>
      (maintenanceEntry?.entries as unknown[]).some(
        (entry) => (entry as JsonRecord).route === route,
      ),
    ) ||
    !Array.isArray(maintenanceEntry?.taskReturns) ||
    (maintenanceEntry?.taskReturns as unknown[]).length <
      MAINTENANCE_TASK_KEYS.length ||
    (maintenanceEntry?.taskReturns as unknown[]).some((entry) => {
      const entryRecord = entry as JsonRecord;
      return (
        entryRecord?.ok !== true ||
        !MAINTENANCE_TASK_KEYS.includes(String(entryRecord.task)) ||
        entryRecord.finalRoute !== "#/catalog"
      );
    })
  )
    throw new Error("maintenance entry evidence is incomplete");
  return {
    slotId: planogram?.slotId,
    slotDisplayLabel: manualDispense?.slotDisplayLabel,
    outcome: manualDispense?.outcome,
    canonical: true,
  };
}
export async function runLocalOperationsGuest(
  options: {
    mode: string;
    guestInputPath: string;
    handoffPath: string;
    outPath: string;
    fixtureKey: string | null;
  },
  dependencies: LocalOperationsGuestDependencies = {},
): Promise<JsonRecord> {
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
  const fixtureAllocation = input.fixtureAllocation as JsonRecord | undefined;
  const fixture =
    fixtureAllocation?.[options.fixtureKey ?? "localOperations"] ??
    (fixtureAllocation?.sale as JsonRecord | undefined);
  const fixtureRecord = fixture as JsonRecord | undefined;
  const report: JsonRecord = {
    schemaVersion: SCHEMA_VERSION,
    ok: false,
    mode: options.mode,
    runId,
    handoffSerialSessionId: null,
    boundaries: { daemon: false, hardwareSelfCheck: false, serial: false },
    planogram: { canonical: false },
    manualDispense: null,
    localEnvironmentControl: null,
    hardware: null,
    serialSessionReplacement: null,
    systemTouchKeyboard: null,
    audioPreferencePersistence: null,
    maintenanceEntry: null,
  };
  let session: JsonRecord | null = null;
  try {
    session = (await controlRequest(input, "/v1/serial-sessions/start", {
      runId,
      machineCode: required(input.machineCode, "machineCode"),
      targetIdentity: required(
        (input.hostControlPlane as JsonRecord).targetIdentity,
        "hostControlPlane.targetIdentity",
      ),
      runtimeBase: required(
        (input.hostControlPlane as JsonRecord).runtimeBaseIdentity,
        "hostControlPlane.runtimeBaseIdentity",
      ),
      saleCorrelationId: `sale-correlation://${runId.toLowerCase()}.local-operations`,
    })) as JsonRecord;
    const activeSession = session as JsonRecord;
    report.handoffSerialSessionId = required(
      activeSession.sessionId,
      "local operations serial session id",
    );
    const saleView = (await daemonRequest(
      handoff,
      "/v1/sale-view",
    )) as JsonRecord | null;
    const slot = selectPlanogramSlot(saleView, fixtureRecord);
    report.planogram = {
      canonical: true,
      planogramVersion: slot.planogramVersion,
      slotDisplayLabel: slot.slotDisplayLabel,
      slotId: slot.slotId,
      rowNo: slot.rowNo,
      cellNo: slot.cellNo,
    };
    report.hardware = await waitForLowerControllerReady(handoff, daemonRequest);
    const hardware = report.hardware as JsonRecord;
    (report.boundaries as JsonRecord).daemon = true;
    (report.boundaries as JsonRecord).hardwareSelfCheck =
      (hardware.selfCheck as JsonRecord | undefined)?.online === true;
    const beforeEvidence = (await controlRequest(
      input,
      `/v1/serial-sessions/${String(activeSession.sessionId)}/evidence`,
    )) as JsonRecord;
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
    await waitForSerialBoundaryFn(
      input,
      String(activeSession.sessionId),
      "VEND",
    );
    await controlRequest(
      input,
      `/v1/serial-sessions/${String(activeSession.sessionId)}/release-f0`,
    );
    await waitForSerialBoundaryFn(input, String(activeSession.sessionId), "F0");
    await waitForSerialBoundaryFn(input, String(activeSession.sessionId), "F1");
    await controlRequest(
      input,
      `/v1/serial-sessions/${String(activeSession.sessionId)}/release-f2`,
    );
    await waitForSerialBoundaryFn(input, String(activeSession.sessionId), "F2");
    const diagnostic = (await diagnosticPromise) as JsonRecord;
    report.manualDispense = {
      ...(diagnostic as JsonRecord),
      slotId: slot.slotId,
      slotDisplayLabel: slot.slotDisplayLabel,
      canonicalSlot: slot,
    };
    const evidence = (await controlRequest(
      input,
      `/v1/serial-sessions/${String(activeSession.sessionId)}/evidence`,
    )) as JsonRecord;
    report.serial = evidence;
    const operationFrames = manualDispenseFrames(beforeEvidence, evidence);
    (report.serial as JsonRecord).operationFrames = operationFrames;
    (report.boundaries as JsonRecord).serial = [
      "VEND",
      "F0",
      "F1",
      "AF",
      "F2",
    ].every((opcode) =>
      operationFrames.some(
        (frame) => (frame as JsonRecord)?.parsedOpcode === opcode,
      ),
    );
    if (
      diagnostic.outcome !== "completed" ||
      !(report.boundaries as JsonRecord).serial
    )
      throw new Error(
        `manual dispense did not complete the lower-controller protocol: ${JSON.stringify({ outcome: diagnostic.outcome, frames: operationFrames.map((frame) => (frame as JsonRecord)?.parsedOpcode) })}`,
      );
    const environmentBeforeEvidence = (await controlRequest(
      input,
      `/v1/serial-sessions/${String(activeSession.sessionId)}/evidence`,
    )) as JsonRecord;
    const environmentRequest = {
      actionId: `local-operations:${runId}:base-vent-3`,
      source: "local_operator",
      action: { type: "set_base_vent_speed", ventSpeed: 3 },
    };
    const environmentAdmission = await daemonRequest(
      handoff,
      "/v1/environment-control/actions",
      environmentRequest,
    );
    await waitForSerialBoundaryFn(input, String(activeSession.sessionId), "B3");
    const environmentAfterEvidence = (await controlRequest(
      input,
      `/v1/serial-sessions/${String(activeSession.sessionId)}/evidence`,
    )) as JsonRecord;
    const environmentFrames = localEnvironmentControlFrames(
      environmentBeforeEvidence,
      environmentAfterEvidence,
    );
    const environmentSnapshot = await waitForState(
      "local environment control convergence",
      () => daemonRequest(handoff, "/v1/environment-control"),
      (value) => {
        const snapshot = recordValue(value);
        return (
          snapshot.revision ===
            recordValue(environmentAdmission).acceptedRevision &&
          snapshot.convergence === "applied" &&
          recordValue(snapshot.settings).baseVentSpeed === 3 &&
          recordValue(snapshot.desired).ventSpeed === 3
        );
      },
    );
    report.localEnvironmentControl = {
      request: environmentRequest,
      admission: environmentAdmission as JsonRecord,
      snapshot: environmentSnapshot,
      protocolFrame: environmentFrames.at(-1) ?? null,
      protocolFrames: environmentFrames,
    };
    const replacement = await replaceSerialSessionAndUpdateHandoff({
      guestInput: input,
      handoff,
      handoffPath: options.handoffPath,
      sessionId: String(activeSession.sessionId),
      control: controlRequest,
      writeJsonFile: writeJsonFn,
    });
    report.serialSessionReplacement = {
      previousControlPlaneSessionId: String(activeSession.sessionId),
      replacementControlPlaneSessionId: required(
        recordValue(replacement?.replacement).sessionId,
        "local operations replacement serial session id",
      ),
    };
    session = replacement.replacement as JsonRecord;
    report.handoffSerialSessionId = (session as JsonRecord).sessionId;
    report.hardware = await waitForLowerControllerReady(handoff, daemonRequest);
    report.audioPreferencePersistence = await runAudioPreferencePersistence(
      {
        handoff,
        handoffPath: options.handoffPath,
      },
      dependencies,
    );
    report.maintenanceEntry = await (
      dependencies.collectMaintenanceEntryEvidence ??
      collectMaintenanceEntryEvidence
    )(handoff, {
      ...dependencies,
      maintenanceEntryRoutes: maintenanceEntryRoutesForSaleView(saleView),
    });
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
