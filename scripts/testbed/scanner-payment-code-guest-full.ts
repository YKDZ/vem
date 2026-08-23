#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { waitForDaemonReadyRefresh } from "./daemon-ready-refresh.ts";
import { catalogProductSelectorForFixture } from "./full-workflow-fixtures.ts";
import { buildInstalledKioskSaleScenarioSteps } from "./installed-kiosk-sale-acceptance.ts";
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
import { replaceSerialSessionAndUpdateHandoff } from "./serial-session-handoff.ts";

const MODES = new Set(["full"]);
const DEFAULT_VALID_SCANNER_CODE = "621234567890123456\r";
const MALFORMED_SCANNER_BYTES = Buffer.from([
  0x36, 0x32, 0x31, 0x32, 0xff, 0x62, 0x61, 0x64, 0x0d,
]);
const TIMEOUT_PARTIAL_SCANNER_BYTES = Buffer.from("621234567890123456", "utf8");
const CLEANUP_TIMEOUT_MS = 10_000;
const SCANNER_QUIET_BOUNDARY_MS = 750;

type JsonRecord = Record<string, unknown>;
type HandoffRecord = JsonRecord;
type GuestInputRecord = JsonRecord;

type ScannerEventCapture = {
  opened: Promise<void>;
  nextEvent: Promise<JsonRecord>;
  events: JsonRecord[];
  waitForEventId: (eventId: string, timeoutMs?: number) => Promise<JsonRecord>;
  assertQuiet: (
    timeoutMs?: number,
  ) => Promise<{ quietForMs: number; scannerEventCount: number }>;
  close: () => void;
};

type ScannerSerialControl = {
  sessionId: string;
  inject: (
    renderedSale: JsonRecord,
    bytes: Buffer | string,
  ) => Promise<unknown>;
  bindSale: (command: JsonRecord) => Promise<unknown>;
  stopScannerProbe: () => Promise<unknown>;
  waitFrame: (parsedOpcode: string, timeoutMs?: number) => Promise<unknown>;
  releaseF0: () => Promise<unknown>;
  releaseF2: () => Promise<unknown>;
  evidence: () => Promise<unknown>;
  stop: (payload: JsonRecord) => Promise<unknown>;
  abort: () => Promise<unknown>;
};

export function scannerFrameBytes(
  value: unknown = DEFAULT_VALID_SCANNER_CODE,
): Buffer {
  const bytes = Buffer.isBuffer(value)
    ? Buffer.from(value)
    : typeof value === "string"
      ? Buffer.from(value, "utf8")
      : null;
  if (
    !bytes ||
    bytes.length <= 1 ||
    !bytes.subarray(-1).equals(Buffer.from("\r"))
  ) {
    throw new Error(
      "scannerAcceptance.validCode must end with exactly one CR frame suffix",
    );
  }
  const body = bytes.subarray(0, -1);
  if (body.includes(0x0d) || body.includes(0x0a)) {
    throw new Error(
      "scannerAcceptance.validCode must contain exactly one trailing CR frame suffix",
    );
  }
  return bytes;
}

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

function option(args: string[], name: string): string {
  const index = args.indexOf(`--${name}`);
  const value = index === -1 ? undefined : args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`--${name} requires a value`);
  }
  return value;
}

function optionalOption(args: string[], name: string): string | null {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? null : required(args[index + 1], `--${name}`);
}

function localPath(path: string): string {
  return process.platform === "win32"
    ? path
    : resolve(
        `/mnt/${path[0].toLowerCase()}/${path.slice(3).replaceAll("\\", "/")}`,
      );
}

function readJson(path: string, label: string): JsonRecord {
  return JSON.parse(readFileSync(localPath(path), "utf8")) as JsonRecord;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(localPath(path)), { recursive: true });
  writeFileSync(localPath(path), `${JSON.stringify(value, null, 2)}\n`);
}

function serializeError(error: unknown): JsonRecord {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: String(error.stack ?? "").slice(0, 16 * 1024),
    };
  }
  return { name: "Error", message: String(error) };
}

function cleanupTimeout(label: string, timeoutMs: number): Promise<never> {
  return new Promise<never>((_, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} exceeded ${timeoutMs}ms cleanup deadline`));
    }, timeoutMs);
    timer.unref?.();
  });
}

export async function runCleanupStep(
  label: string,
  action: () => Promise<unknown>,
  timeoutMs = CLEANUP_TIMEOUT_MS,
): Promise<unknown> {
  try {
    const detail = await Promise.race([
      action(),
      cleanupTimeout(label, timeoutMs),
    ]);
    return { label, ok: true, detail };
  } catch (error) {
    const wrapped = new Error(
      `${label} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
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

async function finalizeScannerCleanup({
  guestInput,
  sessionStart,
  sessionControl,
  client,
}: {
  guestInput: GuestInputRecord | null | undefined;
  sessionStart: JsonRecord | null | undefined;
  sessionControl: { abort: () => Promise<unknown> } | null | undefined;
  client: InstanceType<typeof CdpClient> | null | undefined;
}): Promise<{ cleanup: unknown[]; cleanupErrors: Error[] }> {
  const cleanup: unknown[] = [];
  const cleanupErrors: Error[] = [];
  if (sessionStart?.sessionId) {
    try {
      cleanup.push(
        await runCleanupStep("abort serial session", async () => {
          const result = sessionControl
            ? await sessionControl.abort()
            : await controlPlaneRequest(
                guestInput as GuestInputRecord,
                `/v1/serial-sessions/${sessionStart.sessionId}/abort`,
              );
          if ((result as JsonRecord | null)?.aborted !== true) {
            throw new Error(
              "serial session abort did not confirm inactive state",
            );
          }
          return result;
        }),
      );
    } catch (error) {
      const err = error as Error;
      cleanupErrors.push(err);
      cleanup.push({
        label:
          (err as Error & { cleanupLabel?: string }).cleanupLabel ??
          "abort serial session",
        ok: false,
        error: serializeError(error),
      });
    }
  }
  if (client) {
    try {
      cleanup.push(
        await runCleanupStep("close CDP client", async () => {
          await client.close();
          return { closed: true };
        }),
      );
    } catch (error) {
      const err = error as Error;
      cleanupErrors.push(err);
      cleanup.push({
        label:
          (err as Error & { cleanupLabel?: string }).cleanupLabel ??
          "close CDP client",
        ok: false,
        error: serializeError(error),
      });
    }
  }
  return { cleanup, cleanupErrors };
}

function rows(raw: unknown, key: string): unknown[] {
  const record = raw as JsonRecord | null | undefined;
  return Array.isArray(record?.[key]) ? (record?.[key] as unknown[]) : [];
}

function paymentRowsByOrder(
  report: JsonRecord | null | undefined,
  orderId: string,
): unknown[] {
  return rows(report?.raw, "payments").filter(
    (entry) => (entry as JsonRecord).orderId === orderId,
  );
}

function attemptRowsByOrder(
  report: JsonRecord | null | undefined,
  orderId: string,
): unknown[] {
  return rows(report?.raw, "paymentCodeAttempts").filter(
    (entry) => (entry as JsonRecord).orderId === orderId,
  );
}

function movementRowsByOrderNo(
  report: JsonRecord | null | undefined,
  orderNo: string,
): unknown[] {
  return rows(report?.raw, "movements").filter(
    (entry) => (entry as JsonRecord).orderNo === orderNo,
  );
}

function daemonBaseUrl(handoff: HandoffRecord): string {
  const daemon = handoff.daemon as JsonRecord | undefined;
  const ready = daemon?.ready as JsonRecord | undefined;
  const healthzUrl = required(
    ready?.healthzUrl,
    "daemon healthzUrl",
  );
  if (!healthzUrl.endsWith("/healthz")) {
    throw new Error("daemon healthzUrl must end with /healthz");
  }
  return healthzUrl.slice(0, -"/healthz".length);
}

function daemonHeaders(handoff: HandoffRecord): JsonRecord {
  const daemon = handoff.daemon as JsonRecord | undefined;
  const ready = daemon?.ready as JsonRecord | undefined;
  return {
    authorization: `Bearer ${required(ready?.ipcToken, "daemon ipcToken")}`,
  };
}

function daemonEventsUrl(handoff: HandoffRecord): string {
  const daemon = handoff.daemon as JsonRecord | undefined;
  const ready = daemon?.ready as JsonRecord | undefined;
  const baseUrl = daemonBaseUrl(handoff).replace(/^http/i, "ws");
  return `${baseUrl}/v1/events?token=${encodeURIComponent(required(ready?.ipcToken, "daemon ipcToken"))}`;
}

function captureNextSerialScannerEvent(
  handoff: HandoffRecord,
  timeoutMs = 30_000,
): ScannerEventCapture {
  let socket: WebSocket | null = null;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let resolveOpen: () => void = () => {};
  let rejectOpen: (error: Error) => void = () => {};
  let resolveEvent: (event: JsonRecord) => void = () => {};
  let rejectEvent: (error: Error) => void = () => {};
  const events: JsonRecord[] = [];
  const close = (): void => {
    if (timer) clearTimeout(timer);
    socket?.close();
  };
  const opened = new Promise<void>((resolvePromise, reject) => {
    resolveOpen = resolvePromise;
    rejectOpen = reject;
  });
  const nextEvent = new Promise<JsonRecord>((resolvePromise, reject) => {
    resolveEvent = resolvePromise;
    rejectEvent = reject;
  });
  void nextEvent.catch(() => undefined);
  socket = new WebSocket(daemonEventsUrl(handoff));
  timer = setTimeout(() => {
    const error = new Error(
      "timed out waiting for daemon scanner event stream",
    );
    if (!settled) {
      rejectOpen(error);
      rejectEvent(error);
    }
  }, timeoutMs);
  socket.addEventListener("open", () => resolveOpen());
  socket.addEventListener("error", () => {
    const error = new Error("daemon scanner event stream failed");
    if (!settled) {
      rejectOpen(error);
      rejectEvent(error);
    }
  });
  socket.addEventListener("message", (message) => {
    let event: JsonRecord;
    try {
      event = JSON.parse(String(message.data)) as JsonRecord;
    } catch {
      return;
    }
    if (
      event?.type === "scanner_code" &&
      event.source === "serial_text" &&
      typeof event.eventId === "string" &&
      event.eventId.length > 0
    ) {
      events.push(event);
      if (!settled) {
        settled = true;
        resolveEvent(event);
      }
    }
  });
  return {
    opened,
    nextEvent,
    events,
    async waitForEventId(eventId, timeoutMs = 30_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const event = events.find(
          (candidate) => candidate.eventId === eventId,
        );
        if (event) return event;
        await sleep(50);
      }
      throw new Error(
        `timed out waiting for correlated scanner event ${eventId}`,
      );
    },
    async assertQuiet(timeoutMs = SCANNER_QUIET_BOUNDARY_MS) {
      await opened;
      await sleep(timeoutMs);
      if (events.length > 0) {
        throw new Error(
          "scanner binding probe left a serial scanner event before sale scans",
        );
      }
      return { quietForMs: timeoutMs, scannerEventCount: events.length };
    },
    close,
  };
}

function matchesStableGuestUsbIdentity(
  expected: JsonRecord | null | undefined,
  actual: JsonRecord | null | undefined,
): boolean {
  if (!expected || !actual || expected.identityKey !== actual.identityKey) {
    return false;
  }
  if (expected.containerId) return expected.containerId === actual.containerId;
  const expectedHardwareIds = (expected.hardwareIds ?? []) as unknown[];
  const actualHardwareIds = (actual.hardwareIds ?? []) as unknown[];
  return (
    expected.serialNumber === actual.serialNumber &&
    expectedHardwareIds.every((hardwareId) =>
      actualHardwareIds.includes(hardwareId),
    )
  );
}

export function pnpObservationMatchesLibvirtTopology(
  observation: JsonRecord | null | undefined,
  topology: JsonRecord | null | undefined,
): boolean {
  if (
    !observation ||
    !topology ||
    !/^COM[1-9][0-9]*$/.test(String(observation.currentPort ?? ""))
  )
    return false;
  const paths = Array.isArray(observation.locationPaths)
    ? observation.locationPaths
    : [];
  const portSegments = String(topology.usbPort).split(".").map(Number);
  return paths.some((path) => {
    const root = String(path).match(/USBROOT\((\d+)\)/i);
    const ports = [...String(path).matchAll(/USB\((\d+)\)/gi)].map((match) =>
      Number(match[1]),
    );
    return (
      Number(root?.[1]) === topology.usbBus &&
      ports.length >= portSegments.length &&
      portSegments.every(
        (port, index) =>
          ports[ports.length - portSegments.length + index] === port,
      )
    );
  });
}

export function pnpObservationMatchesDaemonIdentity(
  observation: JsonRecord | null | undefined,
  identity: JsonRecord | null | undefined,
  expectedCurrentPort: unknown,
): boolean {
  if (!observation || !identity) return false;
  const currentPort = String(observation.currentPort ?? "").toUpperCase();
  if (
    !/^COM[1-9][0-9]*$/.test(currentPort) ||
    currentPort !== String(expectedCurrentPort ?? "").toUpperCase()
  ) {
    return false;
  }
  const pnpDeviceId = String(observation.pnpDeviceId ?? "").toUpperCase();
  const instanceId = String(identity.instanceId ?? "").toUpperCase();
  if (!pnpDeviceId || pnpDeviceId !== instanceId) return false;
  const observedContainer = String(observation.containerId ?? "")
    .replace(/^\{|\}$/g, "")
    .toLowerCase();
  const identityContainer = String(identity.containerId ?? "").toLowerCase();
  if (Boolean(observedContainer) !== Boolean(identityContainer)) return false;
  return observedContainer === identityContainer;
}

function observeWindowsSerialPnP(): unknown[] {
  const script = String.raw`$ErrorActionPreference = 'Stop'
$devices = @(Get-CimInstance Win32_SerialPort | ForEach-Object {
  $instanceId = [string]$_.PNPDeviceID
  $property = { param($key) try { (Get-PnpDeviceProperty -InstanceId $instanceId -KeyName $key -ErrorAction Stop).Data } catch { $null } }
  [pscustomobject]@{
    currentPort = [string]$_.DeviceID
    pnpDeviceId = $instanceId
    containerId = [string](& $property 'DEVPKEY_Device_ContainerId')
    locationPaths = @(& $property 'DEVPKEY_Device_LocationPaths' | ForEach-Object { [string]$_ })
    locationInformation = [string](& $property 'DEVPKEY_Device_LocationInfo')
    address = & $property 'DEVPKEY_Device_Address'
  }
})
ConvertTo-Json -Compress -Depth 4 -InputObject $devices`;
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      windowsHide: true,
    },
  );
  if (result.status !== 0)
    throw new Error(`Windows PnP serial observation failed: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout) as unknown;
  return Array.isArray(parsed) ? parsed : [parsed];
}

function scannerQemuMapping(sessionStart: JsonRecord | null | undefined) {
  const qemuMappings = sessionStart?.qemuUsbSerialMappings as unknown[];
  if (!Array.isArray(qemuMappings) || qemuMappings.length !== 2) {
    throw new Error(
      "serial session did not expose the real QEMU USB device mappings",
    );
  }
  for (const role of ["lower-controller", "scanner"]) {
    const mapping = qemuMappings.find(
      (entry) => (entry as JsonRecord).role === role,
    ) as JsonRecord | undefined;
    if (
      !mapping ||
      !((mapping.guestUsbTopology as JsonRecord | undefined)?.alias)
    ) {
      throw new Error(
        `QEMU USB mapping for ${role} is missing live libvirt USB topology`,
      );
    }
  }
  return qemuMappings.find(
    (entry) => (entry as JsonRecord).role === "scanner",
  ) as JsonRecord;
}

async function fetchJson(
  url: string,
  options: JsonRecord = {},
): Promise<unknown> {
  const response = await fetch(url, options as RequestInit);
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      `${options.method ?? "GET"} ${url} failed with HTTP ${response.status}: ${JSON.stringify(payload)}`,
    );
  }
  return payload;
}

async function daemonGet(handoff: HandoffRecord, path: string): Promise<unknown> {
  return fetchJson(`${daemonBaseUrl(handoff)}${path}`, {
    headers: daemonHeaders(handoff),
  });
}

async function controlPlaneRequest(
  guestInput: GuestInputRecord,
  path: string,
  body: JsonRecord = {},
): Promise<unknown> {
  const hostControlPlane = guestInput?.hostControlPlane as
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
  });
}

async function queryPlatform(
  guestInput: GuestInputRecord,
  runId: string,
  machineCode: string,
  sessionId: string | null = null,
): Promise<unknown> {
  const response = (await controlPlaneRequest(
    guestInput,
    "/v1/platform/query",
    {
      runId,
      machineCode,
      ...(sessionId ? { sessionId } : {}),
    },
  )) as JsonRecord;
  return response.report;
}

async function waitForCommand(
  handoff: HandoffRecord,
  renderedSale: JsonRecord,
  timeoutMs = 30_000,
): Promise<JsonRecord> {
  const deadline = Date.now() + timeoutMs;
  let lastTransaction: JsonRecord | null = null;
  while (Date.now() < deadline) {
    const transaction = await daemonGet(
      handoff,
      "/v1/transactions/current",
    ).catch(() => null);
    lastTransaction = transaction as JsonRecord | null;
    const transactionRecord = transaction as JsonRecord | null;
    const vending = transactionRecord?.vending as JsonRecord | undefined;
    const commandId =
      vending?.commandId ?? transactionRecord?.dispenseCommandId ?? null;
    const commandNo = vending?.commandNo ?? null;
    if (
      transactionRecord !== null &&
      transactionRecord?.orderId === renderedSale.orderId &&
      transactionRecord?.paymentId === renderedSale.paymentId &&
      typeof commandId === "string" &&
      commandId &&
      typeof commandNo === "string" &&
      commandNo
    ) {
      return {
        orderId: transactionRecord.orderId,
        paymentId: transactionRecord.paymentId,
        orderNo: transactionRecord.orderNo,
        vendingCommandId: commandId,
        vendingCommandNo: commandNo,
        vendingStatus: vending?.status ?? null,
      };
    }
    await sleep(250);
  }
  throw new Error(
    `vending command did not appear for ${renderedSale.orderId}: ${JSON.stringify(lastTransaction)}`,
  );
}

export function paymentCodeAttemptCorrelationReady(
  transaction: JsonRecord | null | undefined,
  renderedSale: JsonRecord,
): boolean {
  const attempt = (transaction?.paymentCodeAttempt ?? null) as
    | JsonRecord
    | null;
  return (
    transaction?.orderId === renderedSale.orderId &&
    transaction?.paymentId === renderedSale.paymentId &&
    typeof attempt?.scannerEventId === "string" &&
    String(attempt.scannerEventId ?? "").length > 0 &&
    attempt.source === "serial_text" &&
    Number.isSafeInteger(attempt.attemptNo) &&
    typeof attempt.idempotencyKey === "string" &&
    String(attempt.idempotencyKey ?? "").length > 0
  );
}

async function waitForPaymentCodeAttempt(
  handoff: HandoffRecord,
  renderedSale: JsonRecord,
  timeoutMs = 30_000,
): Promise<JsonRecord> {
  const deadline = Date.now() + timeoutMs;
  let lastTransaction: JsonRecord | null = null;
  while (Date.now() < deadline) {
    const transaction = await daemonGet(
      handoff,
      "/v1/transactions/current",
    ).catch(() => null);
    lastTransaction = transaction as JsonRecord | null;
    if (
      paymentCodeAttemptCorrelationReady(
        transaction as JsonRecord | null,
        renderedSale,
      )
    ) {
      return transaction as JsonRecord;
    }
    await sleep(250);
  }
  throw new Error(
    `serial-text payment-code attempt did not appear: ${JSON.stringify(lastTransaction)}`,
  );
}

export async function waitForHardwareBindings(
  handoff: HandoffRecord,
  sessionStart: JsonRecord,
  timeoutMs = 30_000,
): Promise<JsonRecord> {
  const deadline = Date.now() + timeoutMs;
  let last: JsonRecord | null = null;
  while (Date.now() < deadline) {
    const snapshot = await daemonGet(handoff, "/v1/hardware-bindings").catch(
      () => null,
    );
    const snapshotRecord = snapshot as JsonRecord | null;
    last = snapshotRecord;
    const roles = Array.isArray(snapshotRecord?.roles)
      ? (snapshotRecord.roles as unknown[])
      : [];
    const resolved = Object.fromEntries(
      roles.map((role) => [
        (role as JsonRecord).role,
        role,
      ]),
    ) as Record<string, JsonRecord>;
    const lower = resolved.lower_controller;
    const scanner = resolved.scanner;
    const scannerMapping = scannerQemuMapping(sessionStart);
    const windowsPnp = observeWindowsSerialPnP();
    const scannerPnp = windowsPnp.find(
      (observation) =>
        (observation as JsonRecord).currentPort === scanner?.currentPort &&
        pnpObservationMatchesLibvirtTopology(
          observation as JsonRecord,
          scannerMapping.guestUsbTopology as JsonRecord,
        ),
    );
    const candidates = (scanner?.candidates ?? []) as unknown[];
    const scannerCandidate = candidates.find(
      (candidate) =>
        (candidate as JsonRecord).currentPort === scanner.currentPort &&
        matchesStableGuestUsbIdentity(
          (candidate as JsonRecord).identity as JsonRecord | undefined,
          (scanner?.binding as JsonRecord | undefined)?.identity as
            | JsonRecord
            | undefined,
        ),
    ) as JsonRecord | undefined;
    const lowerBinding = lower?.binding as JsonRecord | undefined;
    const scannerBinding = scanner?.binding as JsonRecord | undefined;
    if (
      lower?.ready === true &&
      scanner?.ready === true &&
      /^COM[1-9][0-9]*$/.test(String(lower.currentPort ?? "")) &&
      /^COM[1-9][0-9]*$/.test(String(scanner.currentPort ?? "")) &&
      lower.currentPort !== scanner.currentPort &&
      typeof (lowerBinding?.identity as JsonRecord | undefined)?.identityKey ===
        "string" &&
      scannerCandidate
    ) {
      const qemuMappings = sessionStart?.qemuUsbSerialMappings;
      return {
        daemon: snapshot,
        qemuUsbSerialMappings: qemuMappings,
        scanner: {
          libvirtUsbTopology: scannerMapping.guestUsbTopology,
          windowsPnpObservation: scannerPnp ?? null,
          daemonBindingIdentity: scannerBinding?.identity,
          currentPort: scanner.currentPort,
          observedCandidate: scannerCandidate,
        },
      };
    }
    await sleep(250);
  }
  throw new Error(
    `daemon hardware bindings were not ready: ${JSON.stringify(last)}`,
  );
}

async function waitForScannerSaleCapability(
  handoff: HandoffRecord,
  timeoutMs = 30_000,
): Promise<unknown> {
  try {
    return await waitForSaleStartCapability(
      (path) => daemonGet(handoff, path),
      {
        timeoutMs,
        paymentOptionKey: "payment_code:mock",
      },
    );
  } catch (error) {
    throw new Error(
      `scanner sale capability did not recover after binding: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function waitForSaleStartCapability(
  daemonGetRequest: (path: string) => Promise<unknown>,
  {
    timeoutMs = 30_000,
    paymentOptionKey = "mock:mock",
  }: { timeoutMs?: number; paymentOptionKey?: string } = {},
): Promise<JsonRecord> {
  const deadline = Date.now() + timeoutMs;
  let last: JsonRecord | null = null;
  while (Date.now() < deadline) {
    last = (await daemonGetRequest("/v1/sale-start-capability").catch(
      () => null,
    )) as JsonRecord | null;
    const paymentOptions = last?.paymentOptions as JsonRecord | undefined;
    const options = paymentOptions?.options;
    const option = Array.isArray(options)
      ? (options as unknown[]).find(
          (entry) => (entry as JsonRecord)?.optionKey === paymentOptionKey,
        )
      : null;
    if (
      last?.canStartSale === true &&
      Number.isInteger(last?.revision) &&
      (option as JsonRecord)?.ready === true &&
      (option as JsonRecord)?.disabledReason === null
    ) {
      return last;
    }
    await sleep(250);
  }
  throw new Error(
    `${paymentOptionKey} sale capability did not recover: ${JSON.stringify(last)}`,
  );
}

async function waitForSuccessfulResultSurface(
  client: InstanceType<typeof CdpClient>,
  expected: JsonRecord,
  timeoutMs = 60_000,
): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  let last: JsonRecord | null = null;
  do {
    await waitForRoute(client, /^#\/(payment|dispensing|result\/success)/, {
      timeoutMs: 5_000,
      pollMs: 250,
    });
    last = (await readUiBoundary(client)) as JsonRecord | null;
    const result = last?.result as JsonRecord | undefined;
    if (
      last?.route === "#/result/success" &&
      result?.kind === "success" &&
      result.orderId === expected.orderId &&
      result.paymentId === expected.paymentId &&
      result.orderNo === expected.orderNo &&
      result.commandId === expected.commandId
    ) {
      return last;
    }
    await sleep(250);
  } while (Date.now() < deadline);
  throw new Error(
    `timed out waiting for successful result surface: ${JSON.stringify(last)}`,
  );
}

async function readRenderedPaymentSurface(
  client: InstanceType<typeof CdpClient>,
): Promise<JsonRecord> {
  const hook = (await evaluateExpression(
    client,
    `(() => {
      const el = document.querySelector("[data-installed-kiosk-sale-payment-surface]");
      return el ? {
        orderId: el.dataset.orderId || null,
        paymentId: el.dataset.paymentId || null,
        orderNo: el.dataset.orderNo || null,
        commandId: el.dataset.commandId || null,
        route: location.hash
      } : null;
    })()`,
  )) as JsonRecord | null;
  if (!hook?.orderId || !hook?.paymentId || !hook?.orderNo) {
    throw new Error("required rendered payment surface hook is missing");
  }
  return hook;
}

async function readUiBoundary(
  client: InstanceType<typeof CdpClient>,
): Promise<unknown> {
  return evaluateExpression(
    client,
    `(() => {
      const payment = document.querySelector("[data-installed-kiosk-sale-payment-surface]");
      const result = document.querySelector("[data-installed-kiosk-sale-result-surface]");
      return {
        route: location.hash,
        payment: payment ? {
          orderId: payment.dataset.orderId || null,
          paymentId: payment.dataset.paymentId || null,
          orderNo: payment.dataset.orderNo || null
        } : null,
        result: result ? {
          kind: result.dataset.resultKind || null,
          orderId: result.dataset.orderId || null,
          paymentId: result.dataset.paymentId || null,
          orderNo: result.dataset.orderNo || null,
          commandId: result.dataset.commandId || null
        } : null
      };
    })()`,
  );
}

async function readRuntimeTrace(
  client: InstanceType<typeof CdpClient>,
): Promise<unknown> {
  return evaluateExpression(
    client,
    "window.__VEM_MACHINE_RUNTIME_TRACE__ || []",
  );
}

export async function replaceScannerSerialSessionAndUpdateHandoff({
  guestInput,
  handoff,
  handoffPath,
  control = controlPlaneRequest,
  writeJsonFile,
}: {
  guestInput: GuestInputRecord;
  handoff: HandoffRecord;
  handoffPath: string;
  control?: (input: GuestInputRecord, path: string, body?: JsonRecord) => Promise<unknown>;
  writeJsonFile?: (path: string, value: unknown) => void;
}): Promise<JsonRecord> {
  const replaced = (await replaceSerialSessionAndUpdateHandoff({
    guestInput,
    handoff,
    handoffPath,
    sessionId: required(
      (handoff?.commissioningSerialSession as JsonRecord | undefined)
        ?.sessionId,
      "handoff commissioning serial session id",
    ),
    control,
    writeJsonFile,
  })) as JsonRecord;
  const replacement = replaced.replacement as JsonRecord;
  required(replacement?.sessionId, "scanner replacement serial session id");
  return replacement;
}

export function createScannerPaymentSerialControl({
  guestInput,
  sessionId,
  control = controlPlaneRequest,
}: {
  guestInput: GuestInputRecord;
  sessionId: string;
  control?: (
    input: GuestInputRecord,
    path: string,
    body?: JsonRecord,
  ) => Promise<unknown>;
}): ScannerSerialControl {
  const activeSessionId = required(sessionId, "scanner serial session id");
  const request = (operation: string, body: JsonRecord = {}) =>
    control(
      guestInput,
      `/v1/serial-sessions/${encodeURIComponent(activeSessionId)}/${operation}`,
      body,
    );
  return {
    sessionId: activeSessionId,
    inject(renderedSale: JsonRecord, bytes: Buffer | string) {
      return request("inject", {
        orderId: renderedSale.orderId,
        paymentId: renderedSale.paymentId,
        scannerCodeBase64: Buffer.from(bytes).toString("base64"),
      });
    },
    bindSale(command: JsonRecord) {
      return request("bind-sale", command);
    },
    stopScannerProbe() {
      return request("stop-scanner-probe");
    },
    waitFrame(parsedOpcode: string, timeoutMs = 30_000) {
      return request("wait-frame", { parsedOpcode, timeoutMs });
    },
    releaseF0() {
      return request("release-f0");
    },
    releaseF2() {
      return request("release-f2");
    },
    evidence() {
      return request("evidence");
    },
    stop(payload: JsonRecord) {
      return request("stop", payload);
    },
    abort() {
      return request("abort");
    },
  };
}

export async function admitScannerPaymentSession({
  guestInput,
  handoff,
  handoffPath,
  control = controlPlaneRequest,
  writeJsonFile,
  replaceSession = replaceScannerSerialSessionAndUpdateHandoff,
  waitForDaemonReady = waitForDaemonReadyRefresh,
  waitForHardware = waitForHardwareBindings,
  waitForSale = waitForScannerSaleCapability,
  captureScannerEvent = captureNextSerialScannerEvent,
}: {
  guestInput: GuestInputRecord;
  handoff: HandoffRecord;
  handoffPath: string;
  control?: (
    input: GuestInputRecord,
    path: string,
    body?: JsonRecord,
  ) => Promise<unknown>;
  writeJsonFile?: (path: string, value: unknown) => void;
  replaceSession?: typeof replaceScannerSerialSessionAndUpdateHandoff;
  waitForDaemonReady?: typeof waitForDaemonReadyRefresh;
  waitForHardware?: typeof waitForHardwareBindings;
  waitForSale?: typeof waitForScannerSaleCapability;
  captureScannerEvent?: typeof captureNextSerialScannerEvent;
}): Promise<JsonRecord> {
  const sessionStart = await replaceSession({
    guestInput,
    handoff,
    handoffPath,
    control,
    writeJsonFile,
  });
  const sessionControl = createScannerPaymentSerialControl({
    guestInput,
    sessionId: String(sessionStart.sessionId),
    control,
  });
  const abortFreshSession = async () => {
    try {
      await sessionControl.abort();
    } catch {
      // Preserve the admission failure after best-effort session cleanup.
    }
  };
  let quietScannerCapture: ScannerEventCapture | null = null;
  let primaryError: unknown = null;
  try {
    await waitForDaemonReady(handoff);
    const hardwareBindings = await waitForHardware(handoff, sessionStart);
    const saleStartCapability = await waitForSale(handoff);
    quietScannerCapture = captureScannerEvent(handoff);
    await quietScannerCapture.opened;
    const scannerBindingProbe = (await sessionControl.stopScannerProbe()) as
      | JsonRecord
      | null;
    const scannerProbe = scannerBindingProbe?.scannerBindingProbe as
      | JsonRecord
      | undefined;
    if (
      scannerProbe?.purpose !== "non_payment_scanner_binding_probe" ||
      scannerProbe.stopReason !== "daemon_binding_confirmed" ||
      typeof scannerProbe.stoppedAt !== "string"
    ) {
      throw new Error(
        "scanner binding probe did not stop after daemon binding confirmation",
      );
    }
    const scannerQuietBoundary = await quietScannerCapture.assertQuiet();
    return {
      sessionStart,
      sessionControl,
      hardwareBindings,
      saleStartCapability,
      scannerBindingProbe,
      scannerQuietBoundary,
    };
  } catch (error) {
    primaryError = error;
    await abortFreshSession();
    throw error;
  } finally {
    try {
      await quietScannerCapture?.close();
    } catch (closeError) {
      if (!primaryError) {
        await abortFreshSession();
        throw closeError;
      }
    }
  }
}

export function assertNoAttemptOrDuplicatePayment(
  label: string,
  baseline: JsonRecord | null | undefined,
  post: JsonRecord | null | undefined,
  renderedSale: JsonRecord,
): void {
  const baselineAttempts = attemptRowsByOrder(
    baseline,
    String(renderedSale.orderId),
  );
  const postAttempts = attemptRowsByOrder(post, String(renderedSale.orderId));
  if (baselineAttempts.length !== 0 || postAttempts.length !== 0) {
    throw new Error(`${label} must not create a payment-code attempt`);
  }
  const paymentIds = new Set(
    paymentRowsByOrder(post, String(renderedSale.orderId)).map(
      (entry) => (entry as JsonRecord).id,
    ),
  );
  if (paymentIds.size !== 1 || !paymentIds.has(renderedSale.paymentId)) {
    throw new Error(`${label} duplicated or replaced the payment row`);
  }
  if (
    movementRowsByOrderNo(post, String(renderedSale.orderNo)).length !== 0
  ) {
    throw new Error(`${label} must not vend before a valid scanner frame`);
  }
  if (
    paymentRowsByOrder(post, String(renderedSale.orderId)).length !==
    paymentRowsByOrder(baseline, String(renderedSale.orderId)).length
  ) {
    throw new Error(`${label} must have platform payment delta 0`);
  }
}

export function validateSuccessfulOutcome({
  baseline,
  post,
  renderedSale,
  command,
  attemptSnapshot,
  scannerEvent,
  afterF2Ui,
}: {
  baseline: JsonRecord | null | undefined;
  post: JsonRecord | null | undefined;
  renderedSale: JsonRecord;
  command: JsonRecord;
  attemptSnapshot: JsonRecord | null | undefined;
  scannerEvent: JsonRecord | null | undefined;
  afterF2Ui: JsonRecord | null | undefined;
}): JsonRecord {
  const orderRows = rows(post?.raw, "orders").filter(
    (entry) =>
      (entry as JsonRecord).id === renderedSale.orderId &&
      (entry as JsonRecord).orderNo === renderedSale.orderNo,
  );
  if (
    orderRows.length !== 1 ||
    (orderRows[0] as JsonRecord).paymentState !== "paid" ||
    (orderRows[0] as JsonRecord).status !== "fulfilled" ||
    (orderRows[0] as JsonRecord).fulfillmentState !== "dispensed"
  ) {
    throw new Error(
      "successful scan must persist one paid and fulfilled order",
    );
  }
  const attempts = attemptRowsByOrder(post, String(renderedSale.orderId));
  if (attempts.length !== 1) {
    throw new Error("valid scan must produce exactly one payment-code attempt");
  }
  const attempt = attempts[0] as JsonRecord;
  if (
    attempt.paymentId !== renderedSale.paymentId ||
    attempt.status !== "succeeded" ||
    attempt.isActive !== false ||
    attempt.source !== "serial_text"
  ) {
    throw new Error(
      "successful attempt did not converge to one succeeded serial-text attempt",
    );
  }
  const paymentRows = paymentRowsByOrder(post, String(renderedSale.orderId));
  if (
    paymentRows.length !== 1 ||
    (paymentRows[0] as JsonRecord).id !== renderedSale.paymentId ||
    (paymentRows[0] as JsonRecord).status !== "succeeded"
  ) {
    throw new Error("successful scan must persist one authorized payment row");
  }
  const orderItems = rows(post?.raw, "orderItems").filter(
    (entry) => (entry as JsonRecord).orderId === renderedSale.orderId,
  );
  if (
    orderItems.length !== 1 ||
    (orderItems[0] as JsonRecord).quantity !== 1 ||
    (orderItems[0] as JsonRecord).fulfillmentStatus !== "dispensed"
  ) {
    throw new Error("successful scan must persist one dispensed order item");
  }
  const commands = rows(post?.raw, "commands").filter(
    (entry) => (entry as JsonRecord).orderId === renderedSale.orderId,
  );
  const orderItem = orderItems[0] as JsonRecord;
  if (
    commands.length !== 1 ||
    (commands[0] as JsonRecord).id !== command.vendingCommandId ||
    (commands[0] as JsonRecord).commandNo !== command.vendingCommandNo ||
    (commands[0] as JsonRecord).orderItemId !== orderItem.id ||
    (commands[0] as JsonRecord).slotId !== orderItem.slotId ||
    (commands[0] as JsonRecord).commandKind !== "dispatch" ||
    (commands[0] as JsonRecord).status !== "succeeded"
  ) {
    throw new Error(
      "successful scan must complete exactly one correlated vending command",
    );
  }
  const movements = movementRowsByOrderNo(
    post,
    String(renderedSale.orderNo),
  );
  if (movements.length !== 1) {
    throw new Error(
      "successful scan must produce exactly one total movement for the order",
    );
  }
  const movement = movements[0] as JsonRecord;
  const commandRow = commands[0] as JsonRecord;
  if (
    movement.commandNo !== commandRow.commandNo ||
    movement.orderItemId !== orderItem.id ||
    movement.inventoryId !== orderItem.inventoryId ||
    movement.slotId !== orderItem.slotId ||
    movement.quantity !== orderItem.quantity ||
    movement.movementType !== "dispense_succeeded" ||
    movement.status !== "accepted"
  ) {
    throw new Error(
      "successful command-bound movement is not bound to the completed order item and inventory",
    );
  }
  if (
    afterF2Ui?.route !== "#/result/success" ||
    (afterF2Ui?.result as JsonRecord | undefined)?.kind !== "success" ||
    (afterF2Ui?.result as JsonRecord | undefined)?.orderId !==
      renderedSale.orderId ||
    (afterF2Ui?.result as JsonRecord | undefined)?.paymentId !==
      renderedSale.paymentId ||
    (afterF2Ui?.result as JsonRecord | undefined)?.commandId !==
      command.vendingCommandId
  ) {
    throw new Error(
      "successful scan did not reach a correlated success result surface",
    );
  }
  const daemonAttempt = attemptSnapshot?.paymentCodeAttempt as
    | JsonRecord
    | undefined;
  if (
    scannerEvent?.type !== "scanner_code" ||
    scannerEvent.source !== "serial_text" ||
    typeof scannerEvent.eventId !== "string" ||
    daemonAttempt?.scannerEventId !== scannerEvent.eventId ||
    attempt.scannerEventId !== scannerEvent.eventId ||
    daemonAttempt?.attemptNo !== attempt.attemptNo ||
    daemonAttempt?.idempotencyKey !== attempt.idempotencyKey
  ) {
    throw new Error(
      "ScannerCode event id does not strictly correlate daemon and platform payment attempts",
    );
  }
  const baselineInventory = rows(baseline?.raw, "inventories").find(
    (entry) => (entry as JsonRecord).id === movement.inventoryId,
  );
  const finalInventory = rows(post?.raw, "inventories").find(
    (entry) => (entry as JsonRecord).id === movement.inventoryId,
  );
  const baselineInventoryRecord = baselineInventory as JsonRecord | undefined;
  const finalInventoryRecord = finalInventory as JsonRecord | undefined;
  if (
    !baselineInventoryRecord ||
    !finalInventoryRecord ||
    baselineInventoryRecord.id !== finalInventoryRecord.id ||
    (baselineInventoryRecord.onHandQty as number) -
      (finalInventoryRecord.onHandQty as number) !==
      movement.quantity
  ) {
    throw new Error(
      "successful scan must decrement the same platform inventory by the completed movement quantity",
    );
  }
  return {
    attempt,
    order: orderRows[0] as JsonRecord,
    payment: paymentRows[0] as JsonRecord,
    command: commandRow,
    movement,
    baselinePaymentCount: paymentRowsByOrder(
      baseline,
      String(renderedSale.orderId),
    ).length,
    finalPaymentCount: paymentRowsByOrder(
      post,
      String(renderedSale.orderId),
    ).length,
    inventory: {
      id: baselineInventoryRecord.id,
      baselineOnHandQty: baselineInventoryRecord.onHandQty,
      finalOnHandQty: finalInventoryRecord.onHandQty,
      deltaOnHandQty:
        (finalInventoryRecord.onHandQty as number) -
        (baselineInventoryRecord.onHandQty as number),
    },
  };
}

export async function waitForSuccessfulOutcomeSnapshot({
  queryPlatformFn,
  guestInput,
  runId,
  machineCode,
  sessionId,
  baseline,
  renderedSale,
  command,
  attemptSnapshot,
  scannerEvent,
  afterF2Ui,
  timeoutMs = 30_000,
  pollMs = 500,
}: {
  queryPlatformFn: (
    guestInput: GuestInputRecord,
    runId: string,
    machineCode: string,
    sessionId: string | null,
  ) => Promise<unknown>;
  guestInput: GuestInputRecord;
  runId: string;
  machineCode: string;
  sessionId: string | null;
  baseline: JsonRecord | null | undefined;
  renderedSale: JsonRecord;
  command: JsonRecord;
  attemptSnapshot: JsonRecord | null | undefined;
  scannerEvent: JsonRecord | null | undefined;
  afterF2Ui: JsonRecord | null | undefined;
  timeoutMs?: number;
  pollMs?: number;
}): Promise<JsonRecord> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  do {
    const postPlatform = await queryPlatformFn(
      guestInput,
      runId,
      machineCode,
      sessionId,
    );
    try {
      return {
        postPlatform,
        success: validateSuccessfulOutcome({
          baseline,
          post: postPlatform as JsonRecord,
          renderedSale,
          command,
          attemptSnapshot,
          scannerEvent,
          afterF2Ui,
        }),
      };
    } catch (error) {
      lastError = error;
    }
    await sleep(pollMs);
  } while (Date.now() < deadline);
  throw new Error(
    `successful platform outcome did not become observable: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
    { cause: lastError },
  );
}

export function parseScannerPaymentCodeGuestArgs(args: string[]): {
  mode: string;
  guestInputPath: string;
  handoffPath: string;
  outPath: string;
  fixtureKey: string | null;
} {
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

export async function runScannerPaymentCodeGuest(options: {
  mode: string;
  guestInputPath: string;
  handoffPath: string;
  outPath: string;
  fixtureKey: string | null;
}): Promise<JsonRecord> {
  let guestInput: GuestInputRecord | null = null;
  let handoff: HandoffRecord | null = null;
  const artifactRoot = join(
    dirname(localPath(options.outPath)),
    "scanner-payment-code-artifacts",
  );
  mkdirSync(artifactRoot, { recursive: true });
  const checkpoints: unknown[] = [];
  let client: InstanceType<typeof CdpClient> | null = null;
  let sessionStart: JsonRecord | null = null;
  let sessionControl: ScannerSerialControl | null = null;
  let scannerEventCapture: ScannerEventCapture | null = null;
  let stage = "connect";
  let successReport: JsonRecord | null = null;
  let failureReport: JsonRecord | null = null;
  let primaryError: unknown = null;
  try {
    guestInput = readJson(options.guestInputPath, "guest input");
    handoff = readJson(options.handoffPath, "handoff");
    const runId = required(guestInput.runId, "runId");
    const machineCode = required(guestInput.machineCode, "machineCode");
    const handoffCdp = handoff.cdp as JsonRecord;
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

    stage = "start-session";
    const admission = (await admitScannerPaymentSession({
      guestInput,
      handoff,
      handoffPath: options.handoffPath,
    })) as JsonRecord;
    sessionStart = admission.sessionStart as JsonRecord;
    sessionControl = admission.sessionControl as ScannerSerialControl;
    const {
      hardwareBindings,
      saleStartCapability,
      scannerBindingProbe,
      scannerQuietBoundary,
    } = admission;

    const steps = buildInstalledKioskSaleScenarioSteps(
      "vm-scanner-payment-code",
    ) as unknown as Array<{
      name: string;
      selector: string;
      routeBefore: string;
      routeAfter: string | RegExp;
      inputKind: "touch" | "mouse";
      timeoutMs?: number;
    }>;
    if (options.fixtureKey) {
      const productStep = steps.find(
        (step) => step.name === "catalog product",
      );
      if (productStep) {
        productStep.selector =
        catalogProductSelectorForFixture(
          guestInput.fixtureAllocation as JsonRecord | undefined,
          options.fixtureKey,
        );
      }
    }
    for (const step of steps) {
      await waitForRoute(client, step.routeBefore, {
        timeoutMs: 30_000,
        pollMs: 250,
      });
      await activateVisibleSelector(client, step.selector, {
        kind: step.inputKind,
        timeoutMs: step.timeoutMs ?? 30_000,
      });
      await waitForRoute(client, step.routeAfter, {
        timeoutMs: 30_000,
        pollMs: 250,
      });
    }

    await waitForRoute(client, /^#\/payment/, {
      timeoutMs: 30_000,
      pollMs: 250,
    });
    checkpoints.push(
      await captureCheckpoint(client, "scanner-payment", {
        screenshot: true,
        screenshotSink({ bytes, label }) {
          const ref = join(artifactRoot, `${label}.png`);
          writeFileSync(ref, bytes);
          return { ref };
        },
      }),
    );

    const renderedSale = await readRenderedPaymentSurface(client);
    const paymentBaseline = (await queryPlatform(
      guestInput,
      runId,
      machineCode,
      String(sessionStart.sessionId),
    )) as JsonRecord;

    stage = "malformed-scan";
    await sessionControl.inject(renderedSale, MALFORMED_SCANNER_BYTES);
    await sleep(250);
    const postMalformed = (await queryPlatform(
      guestInput,
      runId,
      machineCode,
      String(sessionStart.sessionId),
    )) as JsonRecord;
    assertNoAttemptOrDuplicatePayment(
      "malformed scan",
      paymentBaseline,
      postMalformed,
      renderedSale,
    );

    stage = "timeout-scan";
    await sessionControl.inject(renderedSale, TIMEOUT_PARTIAL_SCANNER_BYTES);
    await sleep(1_200);
    const postTimeout = (await queryPlatform(
      guestInput,
      runId,
      machineCode,
      String(sessionStart.sessionId),
    )) as JsonRecord;
    assertNoAttemptOrDuplicatePayment(
      "scanner timeout",
      paymentBaseline,
      postTimeout,
      renderedSale,
    );

    stage = "valid-scan";
    const validScannerBytes = scannerFrameBytes(
      (guestInput?.scannerAcceptance as JsonRecord | undefined)?.validCode ??
        DEFAULT_VALID_SCANNER_CODE,
    );
    scannerEventCapture = captureNextSerialScannerEvent(handoff);
    await scannerEventCapture.opened;
    await sessionControl.inject(renderedSale, validScannerBytes);

    const attemptSnapshot = await waitForPaymentCodeAttempt(
      handoff,
      renderedSale,
      30_000,
    );
    const attemptSnapshotRecord = attemptSnapshot as JsonRecord;
    const paymentCodeAttempt = attemptSnapshotRecord.paymentCodeAttempt as
      | JsonRecord
      | undefined;
    const scannerEvent = await scannerEventCapture.waitForEventId(
      String(paymentCodeAttempt?.scannerEventId ?? ""),
    );
    scannerEventCapture.close();
    scannerEventCapture = null;
    const command = await waitForCommand(handoff, renderedSale, 30_000);
    await sessionControl.bindSale(command);

    stage = "vend-boundaries";
    const vendBoundary = await sessionControl.waitFrame("VEND");
    const beforeF0Platform = (await queryPlatform(
      guestInput,
      runId,
      machineCode,
      String(sessionStart.sessionId),
    )) as JsonRecord;
    const releaseF0 = await sessionControl.releaseF0();
    const f0Boundary = await sessionControl.waitFrame("F0");
    const f1Boundary = await sessionControl.waitFrame("F1");
    const afterF1Platform = (await queryPlatform(
      guestInput,
      runId,
      machineCode,
      String(sessionStart.sessionId),
    )) as JsonRecord;
    const releaseF2 = await sessionControl.releaseF2();
    const f2Boundary = await sessionControl.waitFrame("F2");
    const afterF2Ui = (await waitForSuccessfulResultSurface(
      client,
      {
        orderId: renderedSale.orderId,
        paymentId: renderedSale.paymentId,
        orderNo: renderedSale.orderNo,
        commandId: command.vendingCommandId,
      },
      60_000,
    )) as JsonRecord;
    const outcomeSnapshot = await waitForSuccessfulOutcomeSnapshot({
      queryPlatformFn: queryPlatform,
      guestInput,
      runId,
      machineCode,
      sessionId: String(sessionStart.sessionId),
      baseline: paymentBaseline,
      renderedSale,
      command,
      attemptSnapshot,
      scannerEvent,
      afterF2Ui,
    });
    const success = (outcomeSnapshot as JsonRecord).success;
    const sessionEvidence = await sessionControl.evidence();
    const runtimeTrace = await readRuntimeTrace(client);

    const stop = await sessionControl.stop({
      orderId: renderedSale.orderId,
      paymentId: renderedSale.paymentId,
      vendingCommandId: command.vendingCommandId,
    });

    successReport = {
      schemaVersion: "vem-scanner-payment-code-guest-full/v1",
      ok: true,
      handoffSerialSessionId: required(
        sessionStart?.sessionId,
        "scanner payment serial session id",
      ),
      mode: options.mode,
      runId,
      machineCode,
      renderedSale,
      scannerAttempt: {
        attemptNo: paymentCodeAttempt?.attemptNo,
        status: paymentCodeAttempt?.status,
        source: paymentCodeAttempt?.source,
        scannerEventId: paymentCodeAttempt?.scannerEventId,
        idempotencyKey: paymentCodeAttempt?.idempotencyKey,
      },
      scannerEvent: {
        eventId: scannerEvent.eventId,
        source: scannerEvent.source,
        scannedAtMs: scannerEvent.scannedAtMs,
      },
      hardwareBindings,
      saleStartCapability,
      scannerBindingProbe: (scannerBindingProbe as JsonRecord)
        .scannerBindingProbe,
      platformAssertions: success,
      checkpoints,
      boundaries: {
        vend: vendBoundary,
        beforeF0PlatformCapturedAt: beforeF0Platform.capturedAt,
        releaseF0,
        f0: f0Boundary,
        f1: f1Boundary,
        afterF1PlatformCapturedAt: afterF1Platform.capturedAt,
        releaseF2,
        f2: f2Boundary,
      },
      invalidScanEvidence: {
        malformed: {
          platformCapturedAt: postMalformed.capturedAt,
          attemptCount: attemptRowsByOrder(
            postMalformed,
            String(renderedSale.orderId),
          ).length,
          paymentDelta:
            paymentRowsByOrder(
              postMalformed,
              String(renderedSale.orderId),
            ).length -
            paymentRowsByOrder(
              paymentBaseline,
              String(renderedSale.orderId),
            ).length,
        },
        timeout: {
          platformCapturedAt: postTimeout.capturedAt,
          attemptCount: attemptRowsByOrder(
            postTimeout,
            String(renderedSale.orderId),
          ).length,
          paymentDelta:
            paymentRowsByOrder(
              postTimeout,
              String(renderedSale.orderId),
            ).length -
            paymentRowsByOrder(
              paymentBaseline,
              String(renderedSale.orderId),
            ).length,
        },
        scannerQuietBoundary,
      },
      final: {
        route: afterF2Ui.route,
        result: afterF2Ui.result,
        stop,
      },
      serial: sessionEvidence,
      runtimeTrace,
    };
  } catch (error) {
    primaryError = error instanceof Error ? error : new Error(String(error));
    failureReport = {
      schemaVersion: "vem-scanner-payment-code-guest-full/v1",
      ok: false,
      handoffSerialSessionId: sessionStart?.sessionId ?? null,
      stage,
      error: serializeError(primaryError),
      evidence: { checkpoints } as JsonRecord,
    };
    if (guestInput) {
      const runId = String(guestInput.runId);
      const machineCode = String(guestInput.machineCode);
      if (runId && machineCode) {
        (failureReport.evidence as JsonRecord).platform = await queryPlatform(
          guestInput,
          runId,
          machineCode,
          sessionStart?.sessionId != null
            ? String(sessionStart.sessionId)
            : null,
        ).catch((captureError) => ({ error: String(captureError) }));
      }
      if (sessionStart?.sessionId && sessionControl) {
        (failureReport.evidence as JsonRecord).serial = await sessionControl
          .evidence()
          .catch((captureError) => ({ error: String(captureError) }));
      }
    }
    if (handoff) {
      (failureReport.evidence as JsonRecord).daemon = await daemonGet(
        handoff,
        "/v1/transactions/current",
      ).catch((captureError) => ({ error: String(captureError) }));
    }
    if (client) {
      (failureReport.evidence as JsonRecord).ui = await readUiBoundary(client).catch(
        (captureError) => ({ error: String(captureError) }),
      );
      checkpoints.push(
        await captureCheckpoint(client, "scanner-payment-code-failure", {
          screenshot: true,
          screenshotSink({ bytes, label }) {
            const ref = join(artifactRoot, `${label}.png`);
            writeFileSync(ref, bytes);
            return { ref };
          },
        }).catch((captureError) => ({ error: String(captureError) })),
      );
    }
  }

  const { cleanup, cleanupErrors } = await finalizeScannerCleanup({
    guestInput,
    sessionStart,
    sessionControl,
    client,
  });
  if (successReport) successReport.cleanup = cleanup;
  if (failureReport) failureReport.cleanup = cleanup;
  scannerEventCapture?.close();
  const finalError = combineCleanupError(primaryError, cleanupErrors);
  if (finalError) {
    if (!failureReport) {
      failureReport = {
        schemaVersion: "vem-scanner-payment-code-guest-full/v1",
        ok: false,
        handoffSerialSessionId: sessionStart?.sessionId ?? null,
        stage: "cleanup",
        error: serializeError(finalError),
        evidence: {
          checkpoints,
          report: successReport,
        },
        cleanup,
      };
    } else {
      failureReport.cleanupError = serializeError(finalError);
    }
    if (failureReport === null)
      throw new Error("payment provider guest failed without a report");
    writeJson(options.outPath, failureReport);
    throw finalError;
  }

  if (successReport === null)
    throw new Error("scanner payment code guest finished without a report");
  writeJson(options.outPath, successReport);
  return successReport;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const options = parseScannerPaymentCodeGuestArgs(process.argv.slice(2));
  runScannerPaymentCodeGuest(options).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
