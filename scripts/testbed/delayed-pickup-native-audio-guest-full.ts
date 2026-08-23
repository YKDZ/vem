#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { waitForDaemonReadyRefresh } from "./daemon-ready-refresh.ts";
import {
  delayedPickupIssue16ControlPlaneContract,
  startDelayedPickupLiveProductionTrack,
} from "./delayed-pickup-live-production-track.ts";
import { readInstalledMachineProductionSample } from "./delayed-pickup-machine-evidence.ts";
import {
  collectDelayedPickupProductionEvidence,
  verifyDelayedPickupNativeAudioProductionEvidence,
} from "./delayed-pickup-native-audio-acceptance.ts";
import { catalogProductSelectorForFixture } from "./full-workflow-fixtures.ts";
import { setMachineUiAudioPreferences } from "./local-operations-guest-full.ts";
import {
  activateVisibleSelector,
  captureCheckpoint,
  CdpClient,
  discoverMachineUiTarget,
  enablePageRuntime,
  evaluateExpression,
  rewriteWebSocketDebuggerUrl,
  waitForRoute,
} from "./machine-ui-cdp-driver.ts";

const MODES = new Set(["full"]);
const DEFAULT_SCANNER_CODE = "621234567890123456";
const MACHINE_PATH = "C:\\VEM\\bringup\\machine.exe";
const CLEANUP_TIMEOUT_MS = 10_000;
export const REQUIRED_TRANSACTION_AUDIO_PREFERENCES = Object.freeze({
  volume: 0.7,
  cuesEnabled: true,
  presenceCuesEnabled: true,
  transactionCuesEnabled: true,
});

type JsonRecord = Record<string, unknown>;

function recordValue(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}
type HandoffRecord = JsonRecord;
type GuestInputRecord = JsonRecord;
type ParsedGuestFullArgs = {
  mode: string;
  guestInputPath: string;
  handoffPath: string;
  outPath: string;
  fixtureKey: string | null;
};

function scannerFrame(code: unknown): string {
  return `${required(code, "scanner code").replace(/[\r\n]+$/u, "")}\r`;
}

function required(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${label} is required`);
  return value.trim();
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

function readJson(path: string, label: string): JsonRecord {
  try {
    return JSON.parse(readFileSync(localPath(path), "utf8"));
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
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, target);
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

function parseArgs(args: string[]): ParsedGuestFullArgs {
  const mode = required(option(args, "mode"), "--mode");
  if (!MODES.has(mode)) throw new Error("--mode must be full");
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

function screenshotSink(
  root: string,
): (input: {
  bytes: Uint8Array;
  sha256: string;
  label: string;
  format: string;
}) => Promise<{ ref: string; sha256: string }> {
  mkdirSync(localPath(root), { recursive: true });
  return async ({ bytes, sha256, label, format }) => {
    const file = join(
      localPath(root),
      `${String(label).replaceAll(/[^a-z0-9-]+/gi, "-")}.${format}`,
    );
    writeFileSync(file, bytes);
    return { ref: file, sha256 };
  };
}

async function fetchJson(
  url: string,
  options: JsonRecord = {},
): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const { timeoutMs: _timeoutMs, ...requestOptions } = options;
  const response = await fetch(url, {
    ...requestOptions,
    signal: (options.signal as AbortSignal | undefined) ??
      AbortSignal.timeout(Number(timeoutMs)),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      `${String(options.method ?? "GET")} ${url} failed with HTTP ${response.status}: ${JSON.stringify(payload)}`,
    );
  }
  return payload;
}

async function withinDeadline<T>(
  callback: () => Promise<T>,
  label: string,
  timeoutMs = 10_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race<T>([
      callback(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} deadline exceeded`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function daemonBaseUrl(handoff: HandoffRecord): string {
  const daemon = handoff.daemon as JsonRecord | undefined;
  const ready = daemon?.ready as JsonRecord | undefined;
  const healthzUrl = required(
    ready?.healthzUrl,
    "daemon healthzUrl",
  );
  if (!healthzUrl.endsWith("/healthz"))
    throw new Error("daemon healthzUrl must end with /healthz");
  return healthzUrl.slice(0, -"/healthz".length);
}

function daemonHeaders(handoff: HandoffRecord): JsonRecord {
  const daemon = handoff.daemon as JsonRecord | undefined;
  const ready = daemon?.ready as JsonRecord | undefined;
  return {
    authorization: `Bearer ${required(ready?.ipcToken, "daemon ipcToken")}`,
  };
}

async function daemonGet(
  handoff: HandoffRecord,
  path: string,
  timeoutMs = 30_000,
): Promise<unknown> {
  return fetchJson(`${daemonBaseUrl(handoff)}${path}`, {
    headers: daemonHeaders(handoff),
    timeoutMs,
  });
}

export async function restoreTransactionAudioPreferences(
  client: InstanceType<typeof CdpClient>,
  dependencies: JsonRecord = {},
): Promise<unknown> {
  const setPreferences =
    (dependencies.setMachineUiAudioPreferences as
      | ((
          client: unknown,
          preferences: JsonRecord,
        ) => Promise<unknown>)
      | undefined) ?? setMachineUiAudioPreferences;
  const evaluate =
    (dependencies.evaluateExpression as
      | ((
          client: unknown,
          expression: string,
          options?: JsonRecord,
        ) => Promise<unknown>)
      | undefined) ?? evaluateExpression;
  const waitForHashRoute =
    (dependencies.waitForRoute as
      | ((
          client: unknown,
          route: string | RegExp,
          options?: JsonRecord,
        ) => Promise<unknown>)
      | undefined) ?? waitForRoute;
  const restored = await setPreferences(
    client,
    REQUIRED_TRANSACTION_AUDIO_PREFERENCES,
  );
  await evaluate(client, 'location.hash = "#/catalog"');
  await waitForHashRoute(client, "#/catalog", {
    timeoutMs: 30_000,
    pollMs: 250,
  });
  return restored;
}

async function prepareScannerForSale(
  handoff: HandoffRecord,
  guestInput: GuestInputRecord,
  sessionStart: JsonRecord,
): Promise<JsonRecord> {
  const bindingDeadline = Date.now() + 30_000;
  let bindings: JsonRecord | null = null;
  while (Date.now() < bindingDeadline) {
    bindings = (await daemonGet(
      handoff,
      "/v1/hardware-bindings",
    ).catch(() => null)) as JsonRecord | null;
    const roles = (bindings?.roles ?? []) as unknown[];
    const scanner = roles.find(
      (role) => (role as JsonRecord)?.role === "scanner",
    ) as JsonRecord | undefined;
    if (
      scanner?.ready === true &&
      /^COM[1-9][0-9]*$/.test(String(scanner.currentPort))
    )
      break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  const roles = (bindings?.roles ?? []) as unknown[];
  const scanner = roles.find(
    (role) => (role as JsonRecord)?.role === "scanner",
  ) as JsonRecord | undefined;
  if (scanner?.ready !== true)
    throw new Error(
      `scanner binding was not ready: ${JSON.stringify(bindings)}`,
    );

  await controlPlaneRequest(
    guestInput,
    `/v1/serial-sessions/${sessionStart.sessionId}/stop-scanner-probe`,
  );

  const capabilityDeadline = Date.now() + 30_000;
  let capability: JsonRecord | null = null;
  while (Date.now() < capabilityDeadline) {
    capability = (await daemonGet(
      handoff,
      "/v1/sale-start-capability",
    ).catch(() => null)) as JsonRecord | null;
    const paymentOptions = capability?.paymentOptions as
      | JsonRecord
      | undefined;
    const options = (paymentOptions?.options ?? []) as unknown[];
    const paymentCode = options.find(
      (option) =>
        (option as JsonRecord)?.optionKey === "payment_code:mock",
    ) as JsonRecord | undefined;
    if (capability?.canStartSale === true && paymentCode?.ready === true)
      return { bindings, capability };
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(
    `scanner sale capability did not recover: ${JSON.stringify(capability)}`,
  );
}

async function controlPlaneRequest(
  guestInput: GuestInputRecord,
  path: string,
  body: JsonRecord = {},
): Promise<unknown> {
  const hostControlPlane = guestInput.hostControlPlane as
    | JsonRecord
    | undefined;
  const endpoint = required(
    hostControlPlane?.endpoint,
    "hostControlPlane.endpoint",
  );
  const token = required(
    hostControlPlane?.token,
    "hostControlPlane.token",
  );
  return fetchJson(`${endpoint}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    timeoutMs: Number(body.timeoutMs ?? 30_000),
  });
}

async function waitForCommand(
  handoff: HandoffRecord,
  renderedSale: JsonRecord,
  timeoutMs = 30_000,
): Promise<JsonRecord> {
  const deadline = Date.now() + timeoutMs;
  let lastTransaction: JsonRecord | null = null;
  let lastError: string | null = null;
  while (Date.now() < deadline) {
    const transaction = await daemonGet(
      handoff,
      "/v1/transactions/current",
      1_000,
    ).catch((error) => {
      lastError = error instanceof Error ? error.message : String(error);
      return null;
    });
    lastTransaction = transaction as JsonRecord | null;
    const transactionRecord = transaction as JsonRecord | null;
    const vending = transactionRecord?.vending as JsonRecord | undefined;
    const commandId =
      vending?.commandId ?? transactionRecord?.dispenseCommandId ?? null;
    if (
      transactionRecord !== null &&
      transactionRecord?.orderId === renderedSale.orderId &&
      transactionRecord?.paymentId === renderedSale.paymentId &&
      typeof commandId === "string" &&
      commandId
    ) {
      return {
        orderId: transactionRecord.orderId,
        paymentId: transactionRecord.paymentId,
        orderNo: transactionRecord.orderNo,
        vendingCommandId: commandId,
      };
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error(
    `vending command did not appear for order ${renderedSale.orderId}: ${JSON.stringify({ transaction: lastTransaction, ipcError: lastError })}`,
  );
}

async function waitForTransactionAudioSettled(
  client: InstanceType<typeof CdpClient>,
  orderNo: string,
  timeoutMs = 45_000,
) {
  const alwaysRequiredPlaybackSuffixes = [
    "pickup-outlet-opened",
    "pickup-warning-1",
  ];
  const conditionalPlaybackSuffixes = ["pickup-warning-2"];
  const deadline = Date.now() + timeoutMs;
  let last: JsonRecord | null = null;
  while (Date.now() < deadline) {
    last = (await evaluateExpression(
      client,
      `(() => {
        const prefix = ${JSON.stringify(`transaction:${orderNo}:`)};
        const trace = (window.__VEM_MACHINE_RUNTIME_TRACE__ || []).filter(
          (entry) => typeof entry?.transitionId === "string" && entry.transitionId.startsWith(prefix),
        );
        const playbackFor = (suffixes) => suffixes.map((suffix) => {
          const entries = trace.filter((entry) => entry.transitionId === prefix + suffix);
          return {
            suffix,
            queued: entries.some((entry) => entry.type === "audio_queued"),
            started: entries.some((entry) => entry.type === "audio_started"),
            terminal: entries.some((entry) => entry.type === "audio_terminal"),
          };
        });
        const pickupWaiting = trace.filter(
          (entry) => entry.transitionId === prefix + "pickup-waiting",
        );
        return {
          playback: playbackFor(${JSON.stringify(alwaysRequiredPlaybackSuffixes)}),
          conditionalPlayback: playbackFor(${JSON.stringify(conditionalPlaybackSuffixes)}),
          pickupWaitingQueued: pickupWaiting.some(
            (entry) => entry.type === "audio_queued",
          ),
          terminalSuccess: trace.filter(
            (entry) => entry.transitionId === prefix + "dispense-succeeded",
          ),
        };
      })()`,
    )) as JsonRecord | null;
    const playback = last?.playback as unknown[] | undefined;
    const conditionalPlayback = last?.conditionalPlayback as
      | unknown[]
      | undefined;
    const terminalSuccess = last?.terminalSuccess as unknown[] | undefined;
    if (
      last !== null &&
      Array.isArray(playback) &&
      playback.every(
        (entry) => {
          const record = entry as JsonRecord;
          return record.queued && record.started && record.terminal;
        },
      ) &&
      Array.isArray(conditionalPlayback) &&
      conditionalPlayback.every(
        (entry) => {
          const record = entry as JsonRecord;
          return (
            (record.queued && record.started && record.terminal) ||
            Boolean(
              terminalSuccess?.some(
                (terminal) =>
                  (terminal as JsonRecord).type === "journey_transition",
              ),
            )
          );
        },
      ) &&
      last.pickupWaitingQueued === false &&
      terminalSuccess?.filter(
        (terminal) =>
          (terminal as JsonRecord).type === "journey_transition",
      ).length === 1 &&
      terminalSuccess?.every(
        (terminal) =>
          (terminal as JsonRecord).type === "journey_transition",
      )
    ) {
      if (last === null)
        throw new Error("transaction audio trace snapshot is missing");
      return last;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(
    `transaction audio did not settle with silent terminal success: ${JSON.stringify(last)}`,
  );
}

async function waitForPaymentCodeArm(
  handoff: HandoffRecord,
  renderedSale: JsonRecord,
  timeoutMs = 30_000,
): Promise<JsonRecord> {
  const deadline = Date.now() + timeoutMs;
  let lastTransaction: JsonRecord | null = null;
  let consecutiveReady = 0;
  while (Date.now() < deadline) {
    const transaction = await daemonGet(
      handoff,
      "/v1/transactions/current",
    ).catch(() => null);
    const transactionRecord = transaction as JsonRecord | null;
    lastTransaction = transactionRecord;
    const ready =
      transactionRecord?.orderId === renderedSale.orderId &&
      transactionRecord?.paymentId === renderedSale.paymentId &&
      transactionRecord?.orderStatus === "pending_payment" &&
      transactionRecord?.paymentStatus === "pending" &&
      transactionRecord?.nextAction === "wait_payment";
    consecutiveReady = ready ? consecutiveReady + 1 : 0;
    if (consecutiveReady >= 2) {
      if (transactionRecord === null)
        throw new Error("payment-code transaction snapshot is missing");
      return transactionRecord;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(
    `payment-code transaction did not become armed: ${JSON.stringify(lastTransaction)}`,
  );
}

async function readRenderedPaymentSurface(
  client: InstanceType<typeof CdpClient>,
): Promise<JsonRecord> {
  const hook = await evaluateExpression(
    client,
    `(() => {
      const el = document.querySelector("[data-installed-kiosk-sale-payment-surface]");
      return el ? {
        orderId: el.dataset.orderId || null,
        paymentId: el.dataset.paymentId || null,
        orderNo: el.dataset.orderNo || null,
        route: location.hash
      } : null;
    })()`,
  );
  const hookRecord = hook as JsonRecord | null;
  if (!hookRecord?.orderId || !hookRecord?.paymentId || !hookRecord?.orderNo)
    throw new Error("required rendered customer UI payment hook is missing");
  return hookRecord;
}

async function readUiBoundary(
  client: InstanceType<typeof CdpClient>,
): Promise<unknown> {
  return evaluateExpression(
    client,
    `(() => {
      const el = document.querySelector("[data-installed-kiosk-sale-result-surface]");
      return {
        route: location.hash,
        result: el ? {
          kind: el.dataset.resultKind || null,
          orderId: el.dataset.orderId || null,
          paymentId: el.dataset.paymentId || null,
          orderNo: el.dataset.orderNo || null,
          commandId: el.dataset.commandId || null
        } : null
      };
    })()`,
  );
}

async function waitForResultRoute(
  client: InstanceType<typeof CdpClient>,
  timeoutMs = 60_000,
): Promise<unknown> {
  return waitForRoute(client, /^#\/(dispensing|result)/, {
    timeoutMs,
    pollMs: 250,
  });
}

async function queryPlatform(
  guestInput: GuestInputRecord,
  input: JsonRecord,
  outPath: string,
): Promise<unknown> {
  const result = await controlPlaneRequest(
    guestInput,
    "/v1/platform/query",
    input,
  );
  const resultRecord = result as JsonRecord;
  writeJson(outPath, resultRecord.report);
  return resultRecord.report;
}

function daemonTerminalReady(
  transaction: JsonRecord | null | undefined,
  liveSale: JsonRecord,
): boolean {
  const vending = (transaction?.vending ?? {}) as JsonRecord;
  return (
    transaction?.orderId === liveSale.orderId &&
    transaction?.orderNo === liveSale.orderNo &&
    vending.commandId === liveSale.vendingCommandId &&
    transaction?.orderStatus === "fulfilled" &&
    vending.status === "succeeded" &&
    transaction?.nextAction === "success"
  );
}

function platformTerminalReady(
  report: JsonRecord | null | undefined,
  liveSale: JsonRecord,
): boolean {
  const raw = (report?.raw ?? {}) as JsonRecord;
  const orders = (raw.orders ?? []) as unknown[];
  const commands = (raw.commands ?? []) as unknown[];
  const order = orders.find(
    (entry) => (entry as JsonRecord)?.id === liveSale.orderId,
  );
  const command = commands.find(
    (entry) => (entry as JsonRecord)?.id === liveSale.vendingCommandId,
  );
  return (
    (order as JsonRecord)?.status === "fulfilled" &&
    (command as JsonRecord)?.orderId === liveSale.orderId &&
    (command as JsonRecord)?.status === "succeeded" &&
    typeof (command as JsonRecord)?.commandNo === "string" &&
    String((command as JsonRecord)?.commandNo ?? "").length > 0
  );
}

async function waitForTerminalSale({
  guestInput,
  handoff,
  sessionId,
  liveSale,
  outPath,
  timeoutMs = 30_000,
}: {
  guestInput: GuestInputRecord;
  handoff: HandoffRecord;
  sessionId: string;
  liveSale: JsonRecord;
  outPath: string;
  timeoutMs?: number;
}): Promise<{ transaction: JsonRecord | null; platform: JsonRecord | null }> {
  const deadline = Date.now() + timeoutMs;
  let lastPlatform: JsonRecord | null = null;
  let lastTransaction: JsonRecord | null = null;
  do {
    [lastTransaction, lastPlatform] = (await Promise.all([
      daemonGet(handoff, "/v1/transactions/current").catch(() => null),
      queryPlatform(
        guestInput,
        {
          runId: String(guestInput.runId),
          machineCode: String(guestInput.machineCode),
          sessionId,
        },
        outPath,
      ).catch(() => null),
    ])) as [JsonRecord | null, JsonRecord | null];
    if (
      daemonTerminalReady(lastTransaction, liveSale) &&
      platformTerminalReady(lastPlatform, liveSale)
    ) {
      return {
        transaction: lastTransaction,
        platform: lastPlatform,
      };
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  } while (Date.now() < deadline);
  throw new Error(
    `sale did not reach terminal daemon/platform settlement after F2: ${JSON.stringify(
      {
        transaction: lastTransaction,
        commands: ((lastPlatform?.raw ?? {}) as JsonRecord).commands ?? [],
      },
    )}`,
  );
}

function daemonCheckpointFactory(handoff: HandoffRecord) {
  return async (
    stage: string,
    binding: JsonRecord | null,
  ): Promise<JsonRecord> => ({
    stage,
    capturedAt: new Date().toISOString(),
    binding,
    transaction: await daemonGet(handoff, "/v1/transactions/current"),
    saleView: await daemonGet(handoff, "/v1/sale-view"),
  });
}

function issue17EvidenceIndex({
  guestInputPath,
  handoffPath,
  installedSalePath,
  platformBaselinePath,
  platformPostPath,
  delayedRoot,
  liveEvidence = null,
  controlPlaneEvidencePath = null,
  platformLogPath = null,
  audioDiagnosticsPath = null,
  daemonSnapshotPath = null,
  uiSnapshotPath = null,
  screenshotRefs = [],
}: {
  guestInputPath: string;
  handoffPath: string;
  installedSalePath: string;
  platformBaselinePath: string;
  platformPostPath: string;
  delayedRoot: string;
  liveEvidence?: JsonRecord | null;
  controlPlaneEvidencePath?: string | null;
  platformLogPath?: string | null;
  audioDiagnosticsPath?: string | null;
  daemonSnapshotPath?: string | null;
  uiSnapshotPath?: string | null;
  screenshotRefs?: string[];
}): JsonRecord {
  const index: JsonRecord = {
    guestInputPath,
    installedRuntimeHandoffPath: handoffPath,
    installedSaleReportPath: installedSalePath,
    platform: {
      baselinePath: platformBaselinePath,
      atF1Path: join(delayedRoot, "platform-raw-at-f1.json"),
      postF2Path: platformPostPath,
      logPath: platformLogPath,
    },
    daemon: {
      evidencePath: join(delayedRoot, "daemon-fulfillment-store-evidence.json"),
    },
    serial: {
      conformancePath: join(
        dirname(localPath(installedSalePath)),
        "serial-conformance.json",
      ),
      controlPlaneEvidencePath,
    },
    audio: {
      evidenceDirectory: join(delayedRoot, "host-default-audio"),
      startReportPath: join(delayedRoot, "audio-capture-start.json"),
      stopReportPath: join(delayedRoot, "audio-capture-stop.json"),
      diagnosticsPath: audioDiagnosticsPath,
      wavPath: null,
      rawSerialCapturePath: null,
    },
    trace: {
      machineEvidencePath: join(
        delayedRoot,
        "machine-production-evidence.json",
      ),
      daemonSnapshotPath,
      uiSnapshotPath,
    },
    screenshots: screenshotRefs,
  };
  const audioStop = liveEvidence?.audioStop as JsonRecord | undefined;
  const audioEvidence = (audioStop?.evidence ?? []) as unknown[];
  const indexAudio = index.audio as JsonRecord;
  for (const artifactValue of audioEvidence) {
    const artifact = artifactValue as JsonRecord;
    const resolved = join(
      localPath(String(liveEvidence?.evidenceDirectory ?? "")),
      String(artifact.fileName),
    );
    if (artifact.role === "sale-default-audio-capture")
      indexAudio.wavPath = resolved;
    if (artifact.role === "sale-serial-frame-capture")
      indexAudio.rawSerialCapturePath = resolved;
  }
  return index;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cleanupTimeout(label: string, timeoutMs: number): Promise<never> {
  return new Promise<never>((_, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} exceeded ${timeoutMs}ms cleanup deadline`));
    }, timeoutMs);
    timer.unref?.();
  });
}

export async function runCleanupStep<T>(
  label: string,
  action: () => Promise<T>,
  timeoutMs = CLEANUP_TIMEOUT_MS,
): Promise<T> {
  try {
    return await Promise.race([action(), cleanupTimeout(label, timeoutMs)]);
  } catch (error) {
    const wrapped = new Error(`${label} failed: ${formatError(error)}`);
    wrapped.cause = error;
    (wrapped as Error & { cleanupLabel?: string }).cleanupLabel = label;
    throw wrapped;
  }
}

export function combineCleanupError(
  primaryError: unknown,
  cleanupErrors: Error[],
): unknown {
  if (cleanupErrors.length === 0) return primaryError;
  if (primaryError) {
    return new AggregateError(
      [primaryError, ...cleanupErrors],
      `${(primaryError as Error).message}; cleanup failed: ${cleanupErrors.map((error) => error.message).join("; ")}`,
    );
  }
  return new AggregateError(
    cleanupErrors,
    `cleanup failed: ${cleanupErrors.map((error) => error.message).join("; ")}`,
  );
}

async function runDelayedPickupGuestFull(
  options: ParsedGuestFullArgs,
): Promise<JsonRecord> {
  const guestInput = readJson(options.guestInputPath, "guest input");
  const handoff = readJson(options.handoffPath, "installed runtime handoff");
  const outRoot = dirname(localPath(options.outPath));
  const artifactRoot = join(outRoot, "delayed-pickup-native-audio-artifacts");
  const delayedRoot = join(artifactRoot, "live-production-track");
  const screenshotRoot = join(artifactRoot, "screenshots");
  const installedSalePath = join(
    artifactRoot,
    "installed-sale-production-handoff.json",
  );
  const platformBaselinePath = join(
    artifactRoot,
    "platform-raw-records-baseline.json",
  );
  const platformPostPath = join(artifactRoot, "platform-raw-records.json");
  const controlPlaneEvidencePath = join(
    artifactRoot,
    "host-control-plane-bounded-evidence.json",
  );
  const platformLogPath = join(artifactRoot, "platform-service-api.log");
  const platformLogReportPath = join(artifactRoot, "platform-service-api.json");
  const serialConformancePath = join(artifactRoot, "serial-conformance.json");
  const audioDiagnosticsPath = join(artifactRoot, "audio-diagnostics.json");
  const daemonSnapshotPath = join(artifactRoot, "daemon-last-snapshot.json");
  const uiSnapshotPath = join(artifactRoot, "ui-last-snapshot.json");
  const screenshotRefs: string[] = [];
  const saleCorrelationId = `sale-correlation://${String(guestInput.runId).toLowerCase()}.delayed-pickup`;
  const report: JsonRecord = {
    schemaVersion: "local-testbed-delayed-pickup-native-audio/v1",
    kind: "local-testbed-delayed-pickup-native-audio",
    mode: options.mode,
    runId: String(guestInput.runId),
    status: "failed",
    ok: false,
    issue16: delayedPickupIssue16ControlPlaneContract(),
    evidence: issue17EvidenceIndex({
      guestInputPath: options.guestInputPath,
      handoffPath: options.handoffPath,
      installedSalePath,
      platformBaselinePath,
      platformPostPath,
      delayedRoot,
      audioDiagnosticsPath,
      daemonSnapshotPath,
      uiSnapshotPath,
      screenshotRefs,
    }),
    errors: {
      primary: null,
      collection: [],
      cleanup: [],
    },
  };
  let client: InstanceType<typeof CdpClient> | null = null;
  let delayedTrack: Awaited<
    ReturnType<typeof startDelayedPickupLiveProductionTrack>
  > | null = null;
  let sessionStart: JsonRecord | null = null;
  let liveSale: JsonRecord | null = null;
  let liveEvidence: JsonRecord | null = null;
  let primaryError: unknown = null;
  let audioCaptureId: string | null = null;
  const audioOperationId = `audio-capture-${randomUUID()}`;
  let sessionStopped = false;
  let sink: Awaited<ReturnType<typeof screenshotSink>> | null = null;
  try {
    const handoffCdp = handoff.cdp as JsonRecord;
    const handoffMachine = handoff.machine as JsonRecord;
    const hostControlPlane = guestInput.hostControlPlane as JsonRecord;
    const target = await discoverMachineUiTarget({
      endpoint: "http://127.0.0.1:9222",
      expectedTargetId: String(handoffCdp.targetId),
    });
    client = new CdpClient(
      rewriteWebSocketDebuggerUrl(
        target.webSocketDebuggerUrl,
        "http://127.0.0.1:9222",
      ),
    );
    await client.connect();
    await enablePageRuntime(client);
    await waitForRoute(client, "#/catalog", { timeoutMs: 30_000, pollMs: 250 });
    await restoreTransactionAudioPreferences(client);
    sink = screenshotSink(screenshotRoot);
    sessionStart = (await controlPlaneRequest(
      guestInput,
      "/v1/serial-sessions/start",
      {
        runId: String(guestInput.runId),
        machineCode: String(guestInput.machineCode),
        targetIdentity: String(hostControlPlane.targetIdentity),
        runtimeBase: String(hostControlPlane.runtimeBaseIdentity),
        saleCorrelationId,
        serialScenario: "delayed-pickup",
      },
    )) as JsonRecord;
    if (sessionStart === null)
      throw new Error("serial session start returned no session");
    const startedSession = sessionStart;
    await waitForDaemonReadyRefresh(handoff);
    await prepareScannerForSale(handoff, guestInput, startedSession);
    delayedTrack = await startDelayedPickupLiveProductionTrack(
      {
        outputRoot: delayedRoot,
        runId: String(guestInput.runId),
        lifecycleReference: `vm-lifecycle://${String(guestInput.runId).toLowerCase()}.local-testbed-delayed-pickup`,
        transactionId: `transaction://${String(guestInput.runId).toLowerCase()}.delayed-pickup`,
        saleCorrelationId,
        targetIdentity: String(hostControlPlane.targetIdentity),
        remote: {
          remote: "local-testbed@127.0.0.1",
          identity: "not-used",
          certificate: "not-used",
        },
        captureDaemon: daemonCheckpointFactory(handoff),
        async queryPlatform(stage: string) {
          const platformReport = await queryPlatform(
            guestInput,
            {
              runId: String(guestInput.runId),
              machineCode: String(guestInput.machineCode),
              sessionId: startedSession.sessionId,
            },
            stage === "baseline"
              ? platformBaselinePath
              : join(delayedRoot, "platform-raw-at-f1.json"),
          );
          return platformReport as JsonRecord;
        },
      },
      {
        async openSidecar() {
          return {
            endpoint: "http://127.0.0.1:9222",
            process: null,
            async close() {},
          };
        },
        async discoverTarget() {
          return discoverMachineUiTarget({
            endpoint: "http://127.0.0.1:9222",
            expectedTargetId: String(handoffCdp.targetId),
          });
        },
        async inspectRuntime() {
          return {
            machine: {
              processId: handoffMachine.processId,
              executablePath: handoffMachine.executablePath ?? MACHINE_PATH,
              sessionId: handoffMachine.sessionId,
              principal: handoffMachine.principal,
            },
            cdpListener: {
              machineAncestorProcessId: handoffCdp.machineAncestorProcessId,
              sessionId: handoffMachine.sessionId,
              principal: handoffMachine.principal,
            },
          };
        },
        readMachineSample: readInstalledMachineProductionSample,
        async startAudioCapture({ baseBinding, runtime, outPath }) {
          const baseBindingRecord = baseBinding as JsonRecord;
          const result = await controlPlaneRequest(
            guestInput,
            "/v1/audio-captures/start",
            {
              sessionId: startedSession.sessionId,
              runId: String(baseBindingRecord.runId),
              lifecycleReference: String(baseBindingRecord.lifecycleReference),
              transactionId: String(baseBindingRecord.transactionId),
              targetIdentity: String(hostControlPlane.targetIdentity),
              runtime,
              operationId: audioOperationId,
            },
          );
          const resultRecord = result as JsonRecord;
          audioCaptureId = String(resultRecord.audioCaptureId ?? "");
          writeJson(String(outPath), resultRecord.startReport);
          return resultRecord.startReport as JsonRecord;
        },
        async stopAudioCapture({ binding, evidenceDirectory, outPath }) {
          const bindingRecord = binding as JsonRecord;
          const result = await controlPlaneRequest(
            guestInput,
            `/v1/audio-captures/${String(audioCaptureId ?? "")}/stop`,
            {
              saleCorrelationId: bindingRecord.saleCorrelationId,
              orderId: bindingRecord.orderId,
              orderNo: bindingRecord.orderNo,
              commandId: bindingRecord.commandId,
              commandNo: bindingRecord.commandNo,
            },
          );
          const resultRecord = result as JsonRecord;
          writeJson(String(outPath), resultRecord.stopReport);
          mkdirSync(localPath(String(evidenceDirectory)), {
            recursive: true,
          });
          const payloads = (resultRecord.evidencePayloads ?? []) as unknown[];
          for (const artifactValue of payloads) {
            const artifact = artifactValue as JsonRecord;
            writeFileSync(
              join(
                localPath(String(evidenceDirectory)),
                String(artifact.fileName),
              ),
              Buffer.from(String(artifact.bytesBase64), "base64"),
            );
          }
          return resultRecord.stopReport as JsonRecord;
        },
        async cancelAudioCapture(_options: JsonRecord) {
          if (!audioCaptureId)
            return controlPlaneRequest(
              guestInput,
              "/v1/audio-captures/cancel",
              {
                operationId: audioOperationId,
              },
            );
          return controlPlaneRequest(
            guestInput,
            `/v1/audio-captures/${String(audioCaptureId)}/cancel`,
          );
        },
      },
    );
    report.evidence = issue17EvidenceIndex({
      guestInputPath: options.guestInputPath,
      handoffPath: options.handoffPath,
      installedSalePath,
      platformBaselinePath,
      platformPostPath,
      delayedRoot,
      audioDiagnosticsPath,
      daemonSnapshotPath,
      uiSnapshotPath,
      screenshotRefs,
    });

    for (const step of [
      ['[data-test="catalog-category"]:not(:disabled)', "#/catalog"],
      [
        options.fixtureKey
          ? catalogProductSelectorForFixture(
              recordValue(guestInput.fixtureAllocation),
              options.fixtureKey,
            )
          : '[data-test="catalog-product"]',
        /^#\/products\//,
      ],
      ['[data-test="product-buy"]', "#/checkout"],
      [
        '[data-test="payment-option"][data-payment-option-key="payment_code:mock"]:not(:disabled)',
        "#/checkout",
      ],
    ] as Array<[string, string | RegExp]>) {
      await activateVisibleSelector(client, step[0], {
        kind: "touch",
        timeoutMs: 30_000,
      });
      await waitForRoute(client, step[1], { timeoutMs: 30_000, pollMs: 250 });
    }
    await captureCheckpoint(client, "payment-option-selected", {
      screenshot: true,
      screenshotSink: sink,
    }).then((checkpoint) => {
      if (checkpoint?.screenshot?.ref)
        screenshotRefs.push(checkpoint.screenshot.ref);
    });
    const paymentCodeSelector =
      '[data-test="payment-option"][data-payment-option-key="payment_code:mock"]:not(:disabled)';
    let paymentCodeSelected = false;
    for (let attempt = 0; attempt < 3 && !paymentCodeSelected; attempt += 1) {
      await activateVisibleSelector(client, paymentCodeSelector, {
        kind: "touch",
        timeoutMs: 30_000,
      });
      paymentCodeSelected = Boolean(await evaluateExpression(
        client,
        `(() => {
          const option = document.querySelector(${JSON.stringify(paymentCodeSelector)});
          const submit = document.querySelector('[data-test="checkout-submit"]');
          return Boolean(option?.classList.contains('payment-option-selected') && !submit?.hasAttribute('disabled'));
        })()`,
      ));
    }
    if (!paymentCodeSelected)
      throw new Error(
        "payment-code option did not become the actionable checkout selection",
      );
    let paymentRouteReached = false;
    for (let attempt = 0; attempt < 3 && !paymentRouteReached; attempt += 1) {
      paymentRouteReached = await waitForRoute(client, /^#\/payment/, {
        timeoutMs: 250,
        pollMs: 50,
      })
        .then(() => true)
        .catch(() => false);
      if (paymentRouteReached) break;
      await activateVisibleSelector(client, '[data-test="checkout-submit"]', {
        kind: "touch",
        timeoutMs: 30_000,
      });
      paymentRouteReached = await waitForRoute(client, /^#\/payment/, {
        timeoutMs: attempt === 2 ? 30_000 : 2_000,
        pollMs: 250,
      })
        .then(() => true)
        .catch(() => false);
    }
    if (!paymentRouteReached)
      throw new Error("payment submit touch did not reach the payment route");
    const paymentSurface = await readRenderedPaymentSurface(client);
    await waitForPaymentCodeArm(handoff, paymentSurface);
    await controlPlaneRequest(
      guestInput,
      `/v1/serial-sessions/${startedSession.sessionId}/inject`,
      {
        orderId: paymentSurface.orderId,
        paymentId: paymentSurface.paymentId,
        scannerCodeBase64: Buffer.from(
          scannerFrame(
            (guestInput.fastSale as JsonRecord | undefined)?.scannerCode ??
              DEFAULT_SCANNER_CODE,
          ),
          "utf8",
        ).toString("base64"),
      },
    );
    liveSale = await waitForCommand(handoff, paymentSurface);
    const completedSale = liveSale;

    await controlPlaneRequest(
      guestInput,
      `/v1/serial-sessions/${startedSession.sessionId}/wait-frame`,
      {
        parsedOpcode: "VEND",
        timeoutMs: 30_000,
        serialScenario: "delayed-pickup",
      },
    );
    await controlPlaneRequest(
      guestInput,
      `/v1/serial-sessions/${startedSession.sessionId}/release-f0`,
    );
    await controlPlaneRequest(
      guestInput,
      `/v1/serial-sessions/${startedSession.sessionId}/wait-frame`,
      {
        parsedOpcode: "F0",
        timeoutMs: 30_000,
        serialScenario: "delayed-pickup",
      },
    );
    const f1Boundary = (await controlPlaneRequest(
      guestInput,
      `/v1/serial-sessions/${startedSession.sessionId}/wait-frame`,
      {
        parsedOpcode: "F1",
        timeoutMs: 45_000,
        serialScenario: "delayed-pickup",
      },
    )) as JsonRecord;
    await delayedTrack.observeControllerFrame(f1Boundary.frame);
    const afterF1Ui = (await readUiBoundary(client)) as JsonRecord;
    if ((afterF1Ui.result as JsonRecord | undefined)?.kind === "success")
      throw new Error("UI must not show success before inbound F2");
    await captureCheckpoint(client, "after-f1-before-f2", {
      screenshot: true,
      screenshotSink: sink,
    }).then((checkpoint) => {
      if (checkpoint?.screenshot?.ref)
        screenshotRefs.push(checkpoint.screenshot.ref);
    });
    await controlPlaneRequest(
      guestInput,
      `/v1/serial-sessions/${startedSession.sessionId}/release-f2`,
    );
    const f2Boundary = (await controlPlaneRequest(
      guestInput,
      `/v1/serial-sessions/${startedSession.sessionId}/wait-frame`,
      {
        parsedOpcode: "F2",
        timeoutMs: 30_000,
        serialScenario: "delayed-pickup",
      },
    )) as JsonRecord;
    await delayedTrack.observeControllerFrame(f2Boundary.frame);
    const collect = (await controlPlaneRequest(
      guestInput,
      `/v1/serial-sessions/${startedSession.sessionId}/collect`,
      {
        orderId: completedSale.orderId,
        paymentId: completedSale.paymentId,
        vendingCommandId: completedSale.vendingCommandId,
      },
    )) as JsonRecord;
    const terminal = await waitForTerminalSale({
      guestInput,
      handoff,
      sessionId: String(startedSession.sessionId),
      liveSale,
      outPath: platformPostPath,
      timeoutMs: 60_000,
    });
    await waitForResultRoute(client, 60_000);
    await captureCheckpoint(client, "after-f2-terminal", {
      screenshot: true,
      screenshotSink: sink,
    }).then((checkpoint) => {
      if (checkpoint?.screenshot?.ref)
        screenshotRefs.push(checkpoint.screenshot.ref);
    });
    await waitForTransactionAudioSettled(
      client,
      String(completedSale.orderNo),
    );
    const platformPost = terminal.platform;
    const platformRaw = (platformPost?.raw ?? {}) as JsonRecord;
    const platformCommands = (platformRaw.commands ?? []) as unknown[];
    const command = platformCommands.find(
      (entry) => (entry as JsonRecord).id === completedSale.vendingCommandId,
    );
    if (
      typeof (command as JsonRecord)?.commandNo !== "string" ||
      String((command as JsonRecord)?.commandNo ?? "").length === 0
    )
      throw new Error(
        "authoritative platform post-F2 command number is missing",
      );
    liveEvidence = await delayedTrack.finish({
      runId: String(guestInput.runId),
      lifecycleReference: `vm-lifecycle://${String(guestInput.runId).toLowerCase()}.local-testbed-delayed-pickup`,
      transactionId: `transaction://${String(guestInput.runId).toLowerCase()}.delayed-pickup`,
      saleCorrelationId,
      orderId: completedSale.orderId,
      orderNo: completedSale.orderNo,
      commandId: completedSale.vendingCommandId,
      commandNo: String((command as JsonRecord)?.commandNo ?? ""),
    });
    const controlPlaneEvidence = await controlPlaneRequest(
      guestInput,
      `/v1/serial-sessions/${startedSession.sessionId}/evidence`,
      { rawFrameLimit: 256 },
    );
    writeJson(controlPlaneEvidencePath, controlPlaneEvidence);
    const platformLog = (await controlPlaneRequest(
      guestInput,
      `/v1/serial-sessions/${startedSession.sessionId}/platform-log`,
      { lines: 200 },
    )) as JsonRecord;
    writeJson(platformLogReportPath, platformLog);
    writeFileSync(localPath(platformLogPath), String(platformLog.log ?? ""));
    report.evidence = issue17EvidenceIndex({
      guestInputPath: options.guestInputPath,
      handoffPath: options.handoffPath,
      installedSalePath,
      platformBaselinePath,
      platformPostPath,
      delayedRoot,
      liveEvidence,
      controlPlaneEvidencePath,
      platformLogPath,
      audioDiagnosticsPath,
      daemonSnapshotPath,
      uiSnapshotPath,
      screenshotRefs,
    });
    writeJson(installedSalePath, {
      schemaVersion: "installed-kiosk-sale-acceptance/v2",
      status: "passed",
      ok: true,
      runId: String(guestInput.runId),
      runtimeBinding: {
        normal: handoff.machine,
        debug: {
          targetId: handoffCdp.targetId,
          machine: handoff.machine,
        },
      },
      evidence: {
        platformRawBaselinePath: platformBaselinePath,
        platformRawRecordsPath: platformPostPath,
        serialConformancePath,
      },
    });
    writeJson(serialConformancePath, {
      reports: {
        collect: collect.collectReport,
      },
    });
    const liveEvidenceRecord = liveEvidence as JsonRecord;
    const livePaths = liveEvidenceRecord.paths as JsonRecord;
    const artifacts = collectDelayedPickupProductionEvidence({
      installedSaleReportPath: installedSalePath,
      machineEvidencePath: String(livePaths.machine),
      daemonEvidencePath: String(livePaths.daemon),
      platformF1Path: String(livePaths.platformF1),
      audioStartReportPath: String(livePaths.audioStart),
      audioStopReportPath: String(livePaths.audioStop),
    });
    const acceptance = verifyDelayedPickupNativeAudioProductionEvidence({
      artifacts,
      audioEvidenceDirectory: String(liveEvidenceRecord.evidenceDirectory),
    });
    if (acceptance.result !== "passed") {
      throw new Error(
        `delayed pickup native audio acceptance failed: ${JSON.stringify(acceptance.diagnostics)}`,
      );
    }
    const audioStopRecord = liveEvidenceRecord.audioStop as
      | JsonRecord
      | undefined;
    const audioEvidence = (audioStopRecord?.evidence ?? []) as unknown[];
    for (const artifactValue of audioEvidence) {
      const artifact = artifactValue as JsonRecord;
      if (artifact.role !== "sale-default-audio-capture") continue;
      rmSync(
        join(
          localPath(String(liveEvidenceRecord.evidenceDirectory)),
          String(artifact.fileName),
        ),
        {
          force: true,
        },
      );
    }
    await controlPlaneRequest(
      guestInput,
      `/v1/serial-sessions/${startedSession.sessionId}/stop`,
      {
        orderId: completedSale.orderId,
        paymentId: completedSale.paymentId,
        vendingCommandId: completedSale.vendingCommandId,
      },
    );
    sessionStopped = true;
    report.status = "passed";
    report.ok = true;
    report.delayedPickupNativeAudio = acceptance;
    report.handoffSerialSessionId = startedSession.sessionId;
  } catch (error) {
    primaryError = error;
  } finally {
    const reportErrors = report.errors as JsonRecord;
    const collectionErrors = reportErrors.collection as unknown[];
    const cleanupErrors = reportErrors.cleanup as unknown[];
    const cleanupFailures: Error[] = [];
    const collectBestEffort = async (
      label: string,
      callback: () => Promise<unknown>,
    ): Promise<void> => {
      try {
        await withinDeadline(callback, "collection");
      } catch (error) {
        collectionErrors.push(`${label}: ${formatError(error)}`);
      }
    };
    await collectBestEffort("control-plane-evidence", async () => {
      const activeSession = sessionStart;
      if (activeSession === null || liveEvidence) return;
      const controlPlaneEvidence = await controlPlaneRequest(
        guestInput,
        `/v1/serial-sessions/${activeSession.sessionId}/evidence`,
        { rawFrameLimit: 256 },
      );
      writeJson(controlPlaneEvidencePath, controlPlaneEvidence);
    });
    await collectBestEffort("platform-log", async () => {
      const activeSession = sessionStart;
      if (activeSession === null || liveEvidence) return;
      const platformLog = (await controlPlaneRequest(
        guestInput,
        `/v1/serial-sessions/${activeSession.sessionId}/platform-log`,
        { lines: 200 },
      )) as JsonRecord;
      writeJson(platformLogReportPath, platformLog);
      writeFileSync(localPath(platformLogPath), String(platformLog.log ?? ""));
    });
    await collectBestEffort("daemon-snapshot", async () => {
      writeJson(daemonSnapshotPath, {
        capturedAt: new Date().toISOString(),
        transaction: await daemonGet(handoff, "/v1/transactions/current").catch(
          () => null,
        ),
        saleView: await daemonGet(handoff, "/v1/sale-view").catch(() => null),
      });
    });
    await collectBestEffort("ui-snapshot", async () => {
      if (!client) return;
      writeJson(
        uiSnapshotPath,
        await readInstalledMachineProductionSample(client),
      );
    });
    await collectBestEffort("finally-screenshot", async () => {
      if (!client || !sink) return;
      const checkpoint = await captureCheckpoint(client, "finally", {
        screenshot: true,
        screenshotSink: sink,
      });
      if (checkpoint?.screenshot?.ref)
        screenshotRefs.push(checkpoint.screenshot.ref);
    });
    report.evidence = issue17EvidenceIndex({
      guestInputPath: options.guestInputPath,
      handoffPath: options.handoffPath,
      installedSalePath,
      platformBaselinePath,
      platformPostPath,
      delayedRoot,
      liveEvidence,
      controlPlaneEvidencePath,
      platformLogPath,
      audioDiagnosticsPath,
      daemonSnapshotPath,
      uiSnapshotPath,
      screenshotRefs,
    });
    const cleanupFailClosed = async (
      label: string,
      callback: () => Promise<unknown>,
      timeoutMs = CLEANUP_TIMEOUT_MS,
    ): Promise<void> => {
      try {
        await runCleanupStep(label, callback, timeoutMs);
      } catch (error) {
        cleanupErrors.push(`${label}: ${formatError(error)}`);
        cleanupFailures.push(error as Error);
      }
    };
    await cleanupFailClosed(
      "pending-order",
      async () => {
        if (!client || liveSale) return;
        const onPayment = await waitForRoute(client, /^#\/payment/, {
          timeoutMs: 250,
          pollMs: 50,
        })
          .then(() => true)
          .catch(() => false);
        if (!onPayment) return;
        await activateVisibleSelector(
          client,
          '[data-test="payment-cancel"]:not(:disabled)',
          { kind: "touch", timeoutMs: 10_000 },
        );
        await waitForRoute(client, "#/catalog", {
          timeoutMs: 30_000,
          pollMs: 250,
        });
      },
      // The pending-order cleanup may need to cancel a live payment and wait
      // for the catalog route while the machine is already busy; the default
      // 10s cleanup budget is structurally too tight for that path.
      60_000,
    );
    await cleanupFailClosed("audio-capture", async () => {
      if (liveEvidence?.audioStop) return;
      await controlPlaneRequest(guestInput, "/v1/audio-captures/cancel", {
        operationId: audioOperationId,
      });
    });
    await cleanupFailClosed("live-track-close", async () => {
      await delayedTrack?.close();
    });
    await cleanupFailClosed("serial-session", async () => {
      if (!sessionStart || sessionStopped) return;
      const activeSession = sessionStart;
      if (liveSale) {
        await controlPlaneRequest(
          guestInput,
          `/v1/serial-sessions/${activeSession.sessionId}/stop`,
          {
            orderId: liveSale.orderId,
            paymentId: liveSale.paymentId,
            vendingCommandId: liveSale.vendingCommandId,
            idempotencyCheck: true,
          },
        ).catch(async () =>
          controlPlaneRequest(
            guestInput,
            `/v1/serial-sessions/${activeSession.sessionId}/abort`,
          ),
        );
      } else {
        await controlPlaneRequest(
          guestInput,
          `/v1/serial-sessions/${activeSession.sessionId}/abort`,
        );
      }
    });
    await cleanupFailClosed("ui-client-close", async () => {
      await client?.close();
    });
    await collectBestEffort("audio-diagnostics", async () => {
      if (!audioCaptureId) return;
      const diagnostics = await controlPlaneRequest(
        guestInput,
        `/v1/audio-captures/${audioCaptureId}/diagnostics`,
      );
      writeJson(audioDiagnosticsPath, diagnostics);
    });
    primaryError = combineCleanupError(primaryError, cleanupFailures);
  }
  const reportErrors = report.errors as JsonRecord;
  const cleanupReport = reportErrors.cleanup as unknown[];
  if (cleanupReport.length > 0) {
    const cleanupFailure = new Error(
      `delayed pickup native audio cleanup failed: ${cleanupReport.join("; ")}`,
    );
    primaryError = primaryError
      ? new AggregateError(
          [primaryError, cleanupFailure],
          cleanupFailure.message,
        )
      : cleanupFailure;
    report.ok = false;
    report.status = "failed";
  }
  if (primaryError) {
    report.error = formatError(primaryError);
    reportErrors.primary =
      primaryError instanceof AggregateError &&
      primaryError.errors[0] instanceof Error
        ? formatError(primaryError.errors[0])
        : formatError(primaryError);
    report.handoffSerialSessionId = sessionStart?.sessionId ?? null;
  } else {
    reportErrors.primary = null;
  }
  writeJson(options.outPath, report);
  if (primaryError) throw primaryError;
  return report;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await runDelayedPickupGuestFull(options);
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
