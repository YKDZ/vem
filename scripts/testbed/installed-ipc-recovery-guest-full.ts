#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { waitForDaemonReadyRefresh } from "./daemon-ready-refresh.ts";
import { catalogProductSelectorForFixture } from "./full-workflow-fixtures.ts";
import {
  buildInstalledKioskGuestOperationScript,
  buildInstalledKioskSaleScenarioSteps,
  evaluateInstalledErrorMatrixEvidence,
} from "./installed-kiosk-sale-acceptance.ts";
import {
  activateVisibleSelector,
  captureCheckpoint,
  captureRuntimeOperationObservation,
  captureScreenshot,
  CdpClient,
  discoverMachineUiTarget,
  enablePageRuntime,
  evaluateExpression,
  readCdpLocationHash,
  rewriteWebSocketDebuggerUrl,
  waitForRoute,
} from "./machine-ui-cdp-driver.ts";
import {
  scannerFrameBytes,
  waitForHardwareBindings,
} from "./scanner-payment-code-guest-full.ts";

const SCHEMA_VERSION = "vem-installed-ipc-recovery-guest-full/v1";
const LOCAL_REQUEST_TIMEOUT_MS = 30_000;
const POWERSHELL_OPERATION_TIMEOUT_MS = 45_000;

type JsonRecord = Record<string, unknown>;
type GuestInputRecord = JsonRecord;
type HandoffRecord = JsonRecord;

function required(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value.trim();
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
  if (required(option(args, "mode"), "--mode") !== "full") {
    throw new Error("--mode must be full");
  }
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
  const {
    retryTimeoutMs = LOCAL_REQUEST_TIMEOUT_MS,
    signal,
    ...fetchOptions
  } = options as JsonRecord & {
    retryTimeoutMs?: number;
    signal?: AbortSignal;
  };
  const deadline = Date.now() + retryTimeoutMs;
  let lastTransportError: Error | null = null;
  while (Date.now() < deadline) {
    let response;
    try {
      response = await fetch(url, {
        ...fetchOptions,
        signal:
          (signal as AbortSignal | undefined) ??
          AbortSignal.timeout(
            Math.max(
              1,
              Math.min(LOCAL_REQUEST_TIMEOUT_MS, deadline - Date.now()),
            ),
          ),
      });
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      lastTransportError = error;
      await sleep(Math.min(250, Math.max(1, deadline - Date.now())));
      continue;
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(
        `${fetchOptions.method ?? "GET"} ${url} failed with HTTP ${response.status}: ${JSON.stringify(payload)}`,
      );
    }
    return payload;
  }
  throw lastTransportError ?? new Error(`fetch timed out: ${url}`);
}

function daemonBaseUrl(handoff: HandoffRecord): string {
  const daemon = handoff.daemon as JsonRecord | undefined;
  const ready = daemon?.ready as JsonRecord | undefined;
  const healthzUrl = required(ready?.healthzUrl, "daemon healthzUrl");
  if (!healthzUrl.endsWith("/healthz")) {
    throw new Error("daemon healthzUrl must end with /healthz");
  }
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

function controlPlaneRequest(
  guestInput: GuestInputRecord,
  path: string,
  body: JsonRecord = {},
): Promise<unknown> {
  const plane = guestInput.hostControlPlane as JsonRecord | undefined;
  return fetchJson(
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

async function waitForCommand(
  handoff: HandoffRecord,
  sale: JsonRecord,
  timeoutMs = 30_000,
): Promise<JsonRecord> {
  const deadline = Date.now() + timeoutMs;
  let last: JsonRecord | null = null;
  while (Date.now() < deadline) {
    last = (await daemonGet(handoff, "/v1/transactions/current").catch(
      () => null,
    )) as JsonRecord | null;
    const vending = last?.vending as JsonRecord | undefined;
    const commandId = vending?.commandId ?? last?.dispenseCommandId;
    if (
      last?.orderId === sale.orderId &&
      last?.paymentId === sale.paymentId &&
      commandId != null
    ) {
      return {
        orderId: last?.orderId,
        paymentId: last?.paymentId,
        orderNo: last?.orderNo,
        vendingCommandId: commandId,
      };
    }
    await sleep(250);
  }
  throw new Error(`vending command did not appear: ${JSON.stringify(last)}`);
}

async function readPaymentSurface(
  client: InstanceType<typeof CdpClient>,
): Promise<JsonRecord> {
  const surface = (await evaluateExpression(
    client,
    `(() => {
      const el = document.querySelector("[data-installed-kiosk-sale-payment-surface]");
      return el ? {
        orderId: el.dataset.orderId || null,
        paymentId: el.dataset.paymentId || null,
        orderNo: el.dataset.orderNo || el.dataset.orderCredential || null,
        route: location.hash
      } : null;
    })()`,
  )) as JsonRecord | null;
  if (!surface?.orderId || !surface?.paymentId || !surface?.orderNo) {
    throw new Error("required rendered payment surface hook is missing");
  }
  return surface;
}

async function waitForSuccessfulResultSurface(
  client: InstanceType<typeof CdpClient>,
  sale: JsonRecord,
  timeoutMs = 60_000,
): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = (await evaluateExpression(
      client,
      `(() => {
        const result = document.querySelector("[data-installed-kiosk-sale-result-surface]");
        return result ? {
          route: location.hash,
          kind: result.dataset.resultKind || null,
          orderId: result.dataset.orderId || null,
          paymentId: result.dataset.paymentId || null,
          commandId: result.dataset.commandId || null
        } : null;
      })()`,
    )) as JsonRecord | null;
    if (
      value?.kind === "success" &&
      value.orderId === sale.orderId &&
      value.paymentId === sale.paymentId &&
      value.commandId === sale.commandId
    ) {
      return value;
    }
    await sleep(250);
  }
  throw new Error(
    "success result surface did not appear for the recovered sale",
  );
}

export function jsonOnlyPowerShellCommand(script: unknown): string {
  return `$ProgressPreference = 'SilentlyContinue'\n& {\n${String(script)}\n} 3>$null 4>$null 5>$null 6>$null`;
}

function runLocalPowerShellJson(script: unknown, label: string): JsonRecord {
  const result = spawnSync(
    "pwsh",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      jsonOnlyPowerShellCommand(script),
    ],
    {
      encoding: "utf8",
      env: process.env as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: POWERSHELL_OPERATION_TIMEOUT_MS,
    },
  );
  if (result.status !== 0) {
    const timeout =
      (result.error as { code?: unknown } | undefined)?.code === "ETIMEDOUT"
        ? " timed out"
        : "";
    throw new Error(
      `${label}${timeout} failed: ${(result.stderr || result.stdout || "").trim() || result.error?.message || `exit ${result.status ?? 1}`}`,
    );
  }
  try {
    return JSON.parse((result.stdout ?? "").trim());
  } catch (error) {
    throw new Error(
      `${label} returned unreadable JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function compactFrames(rawFrames: unknown): JsonRecord[] {
  return Array.isArray(rawFrames)
    ? (rawFrames as unknown[]).map((frame) => ({
        at: (frame as JsonRecord).at ?? null,
        parsedOpcode: (frame as JsonRecord).parsedOpcode ?? null,
      }))
    : [];
}

async function interruptDaemonTransportAndObserveOverlay({
  handoff,
  client,
  screenshotSink,
  session,
  attempts = 2,
  overlayTimeoutMs = 45_000,
}: {
  handoff: HandoffRecord;
  client: InstanceType<typeof CdpClient>;
  screenshotSink: (input: {
    bytes: Uint8Array;
    label: string;
  }) => Promise<{ ref: string }>;
  session: JsonRecord;
  attempts?: number;
  overlayTimeoutMs?: number;
}): Promise<JsonRecord> {
  let lastUiBefore: unknown = null;
  let lastInterrupted: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const uiBefore = await captureRuntimeOperationObservation(client);
    const interrupted = runLocalPowerShellJson(
      buildInstalledKioskGuestOperationScript({
        operation: "daemon_transport_interrupt",
        phase: "interrupt",
        daemonRuntime: handoff.daemon as JsonRecord | undefined,
      }),
      "daemon transport interrupt",
    );
    const overlayDeadline = Date.now() + overlayTimeoutMs;
    let recoveryOverlay = null;
    do {
      const observation = await captureRuntimeOperationObservation(client);
      if (
        Array.isArray(observation.recoveryOverlay) &&
        observation.recoveryOverlay.length > 0
      ) {
        recoveryOverlay = {
          observation,
          screenshot: await captureScreenshot(client, {
            screenshotSink,
            label:
              attempt === 0
                ? "payment-recovery-overlay"
                : `payment-recovery-overlay-retry-${attempt + 1}`,
          }),
        };
        return { uiBefore, interruptedTransport: interrupted, recoveryOverlay };
      }
      await sleep(250);
    } while (Date.now() < overlayDeadline);
    lastUiBefore = uiBefore;
    lastInterrupted = interrupted;
    if (attempt + 1 >= attempts) {
      return {
        uiBefore: lastUiBefore,
        interruptedTransport: lastInterrupted,
        recoveryOverlay: null,
      };
    }
    // Recover before the next attempt so the Machine UI event stream is live;
    // a stale stream can miss the overlay even though the daemon really went
    // down and came back.
    runLocalPowerShellJson(
      buildInstalledKioskGuestOperationScript({
        operation: "daemon_transport_interrupt",
        phase: "recover",
        operationId: String((interrupted as JsonRecord).guestOperationId),
        daemonRuntime: handoff.daemon as JsonRecord | undefined,
        expectedTransaction: {
          ...(((interrupted as JsonRecord).daemon as JsonRecord)
            .transactionBefore as Record<string, unknown>),
          machineCode: ((interrupted as JsonRecord).platform as JsonRecord)
            .machineCode,
        },
      }),
      "daemon transport recovery",
    );
    await waitForDaemonReadyRefresh(handoff);
    await waitForHardwareBindings(handoff, session);
    await sleep(3_000);
  }
  return {
    uiBefore: lastUiBefore,
    interruptedTransport: lastInterrupted,
    recoveryOverlay: null,
  };
}

export async function runInstalledIpcRecoveryGuest(options: {
  mode: "full";
  guestInputPath: string;
  handoffPath: string;
  outPath: string;
  fixtureKey: string | null;
}): Promise<JsonRecord> {
  let guestInput: GuestInputRecord | null = null;
  let handoff: HandoffRecord | null = null;
  let client: InstanceType<typeof CdpClient> | null = null;
  let session: JsonRecord | null = null;
  let recoveredTransport: JsonRecord | null = null;
  let interruptedTransport: JsonRecord | null = null;
  let liveSale: JsonRecord | null = null;
  let failure: unknown = null;
  const report: JsonRecord = {
    schemaVersion: SCHEMA_VERSION,
    ok: false,
    handoffSerialSessionId: null,
    mode: options.mode,
    artifacts: { milestones: [] },
  };
  const screenshotSink = ({
    bytes,
    label,
  }: {
    bytes: Uint8Array;
    label: string;
  }) => {
    const path = join(
      dirname(localPath(options.outPath)),
      "ipc-recovery-artifacts",
      `${label}.png`,
    );
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    return Promise.resolve({ ref: path });
  };
  const pushCheckpoint = async (label: string): Promise<void> => {
    if (!client) return;
    const checkpoint = await captureCheckpoint(client, label, {
      screenshot: true,
      screenshotSink,
    });
    (report.artifacts as JsonRecord).milestones = [
      ...(((report.artifacts as JsonRecord).milestones as unknown[]) ?? []),
      {
        label: (checkpoint as JsonRecord).label,
        route: ((checkpoint as JsonRecord).identity as JsonRecord).route,
        screenshot:
          (
            (checkpoint as JsonRecord).screenshot as
              | JsonRecord
              | null
              | undefined
          )?.ref ?? null,
      },
    ];
  };
  try {
    guestInput = readJson(options.guestInputPath);
    handoff = readJson(options.handoffPath);
    const runId = required(guestInput.runId, "runId");
    const machineCode = required(guestInput.machineCode, "machineCode");
    report.runId = runId;
    report.machineCode = machineCode;

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

    session = (await controlPlaneRequest(
      guestInput,
      "/v1/serial-sessions/start",
      {
        runId,
        machineCode,
        saleCorrelationId: `sale-correlation://ipc-recovery-${Date.now()}`,
        targetIdentity: required(
          (guestInput.hostControlPlane as JsonRecord | undefined)
            ?.targetIdentity,
          "hostControlPlane.targetIdentity",
        ),
        runtimeBase: required(
          (guestInput.hostControlPlane as JsonRecord | undefined)
            ?.runtimeBaseIdentity,
          "hostControlPlane.runtimeBaseIdentity",
        ),
      },
    )) as JsonRecord;
    const activeSession = session as JsonRecord;
    report.handoffSerialSessionId = required(
      activeSession.sessionId,
      "IPC recovery serial session id",
    );
    await waitForDaemonReadyRefresh(handoff);
    await waitForHardwareBindings(handoff, session);
    await controlPlaneRequest(
      guestInput,
      `/v1/serial-sessions/${String(activeSession.sessionId)}/stop-scanner-probe`,
    );

    const steps = buildInstalledKioskSaleScenarioSteps(
      "vm-ipc-recovery",
    ) as unknown as Array<{
      name: string;
      selector: string;
      routeBefore: string;
      routeAfter: string | RegExp;
      timeoutMs?: number;
    }>;
    if (options.fixtureKey) {
      const productStep = steps.find((step) => step.name === "catalog product");
      if (productStep) {
        productStep.selector = catalogProductSelectorForFixture(
          guestInput.fixtureAllocation as JsonRecord | undefined,
          options.fixtureKey,
        );
      }
    }
    for (const step of steps.slice(0, 4)) {
      await waitForRoute(client, step.routeBefore, {
        timeoutMs: step.timeoutMs ?? 30_000,
        pollMs: 250,
      });
      await activateVisibleSelector(client, step.selector, {
        kind: "touch",
        timeoutMs: 30_000,
      });
      await waitForRoute(client, step.routeAfter, {
        timeoutMs: step.timeoutMs ?? 30_000,
        pollMs: 250,
      });
    }
    let paymentRouteReached = false;
    for (let attempt = 0; attempt < 3 && !paymentRouteReached; attempt += 1) {
      const currentRoute = await readCdpLocationHash(client);
      if (/^#\/payment/.test(String(currentRoute))) {
        paymentRouteReached = true;
        break;
      }
      try {
        await activateVisibleSelector(client, '[data-test="checkout-submit"]', {
          kind: "touch",
          timeoutMs: 30_000,
        });
      } catch (error) {
        const projectedRoute = await evaluateExpression(
          client,
          "location.hash",
        );
        if (/^#\/payment/.test(String(projectedRoute))) {
          paymentRouteReached = true;
          break;
        }
        throw error;
      }
      paymentRouteReached = await waitForRoute(client, /^#\/payment/, {
        timeoutMs: attempt === 2 ? 30_000 : 2_000,
        pollMs: 250,
      })
        .then(() => true)
        .catch(() => false);
    }
    if (!paymentRouteReached)
      throw new Error("payment submit touch did not reach the payment route");

    const renderedSale = await readPaymentSurface(client);
    report.renderedSale = renderedSale;
    await pushCheckpoint("payment-before-ipc-recovery");

    const interruption = await interruptDaemonTransportAndObserveOverlay({
      handoff,
      client,
      screenshotSink,
      session,
    });
    interruptedTransport = interruption.interruptedTransport as JsonRecord;
    const uiBefore = interruption.uiBefore as JsonRecord | undefined;
    const recoveryOverlay = interruption.recoveryOverlay as JsonRecord | null;
    recoveredTransport = runLocalPowerShellJson(
      buildInstalledKioskGuestOperationScript({
        operation: "daemon_transport_interrupt",
        phase: "recover",
        operationId: String(interruptedTransport.guestOperationId),
        daemonRuntime: handoff.daemon as JsonRecord | undefined,
        expectedTransaction: {
          ...((interruptedTransport.daemon as JsonRecord)
            .transactionBefore as Record<string, unknown>),
          machineCode: (interruptedTransport.platform as JsonRecord)
            .machineCode,
        },
      }),
      "daemon transport recovery",
    );
    await waitForDaemonReadyRefresh(handoff);
    await waitForHardwareBindings(handoff, session);
    const uiAfter = await captureRuntimeOperationObservation(client);

    report.ipcRecovery = {
      operation: "daemon_transport_interrupt",
      provenance: {
        ...(recoveredTransport as JsonRecord),
        ui: {
          before: uiBefore,
          after: uiAfter,
          recoveryOverlay,
        },
      },
    };

    (report.ipcRecovery as JsonRecord).evidence =
      evaluateInstalledErrorMatrixEvidence({
        profile: "vm-ipc-recovery",
        scenario: {
          evidence: [
            {
              type: "external-operation",
              operation: "daemon_transport_interrupt",
              routeBefore: "#/payment",
              routeAfter: "#/payment",
              provenance: (report.ipcRecovery as JsonRecord).provenance,
            },
          ],
        },
        correlation: {
          rendered: { orderNo: String(renderedSale.orderNo) },
          platform: { orderNo: String(renderedSale.orderNo) },
        },
      });
    (report.ipcRecovery as JsonRecord).assertions = {
      overlayObserved: true,
      retainedOrderCredential: uiBefore?.orderCredential,
      resumedOrderCredential: (uiAfter as JsonRecord | undefined)
        ?.orderCredential,
      daemonTransportPhase:
        (
          (recoveredTransport?.daemon as JsonRecord | undefined)?.transport as
            | JsonRecord
            | undefined
        )?.phase ?? null,
    };

    const scannerBytes = scannerFrameBytes(
      (guestInput?.scannerAcceptance as JsonRecord | undefined)?.validCode,
    );
    (report.ipcRecovery as JsonRecord).scannerInjection =
      await controlPlaneRequest(
        guestInput,
        `/v1/serial-sessions/${String(activeSession.sessionId)}/inject`,
        {
          orderId: renderedSale.orderId,
          paymentId: renderedSale.paymentId,
          scannerCodeBase64: Buffer.from(scannerBytes).toString("base64"),
        },
      );
    liveSale = await waitForCommand(handoff, renderedSale);
    report.liveSale = liveSale;

    report.serial = {
      sessionId: session.sessionId,
      vend: await controlPlaneRequest(
        guestInput,
        `/v1/serial-sessions/${session.sessionId}/wait-frame`,
        { parsedOpcode: "VEND", timeoutMs: 30_000 },
      ),
      releaseF0: await controlPlaneRequest(
        guestInput,
        `/v1/serial-sessions/${session.sessionId}/release-f0`,
      ),
      f0: await controlPlaneRequest(
        guestInput,
        `/v1/serial-sessions/${session.sessionId}/wait-frame`,
        { parsedOpcode: "F0", timeoutMs: 30_000 },
      ),
      f1: await controlPlaneRequest(
        guestInput,
        `/v1/serial-sessions/${session.sessionId}/wait-frame`,
        { parsedOpcode: "F1", timeoutMs: 30_000 },
      ),
      releaseF2: await controlPlaneRequest(
        guestInput,
        `/v1/serial-sessions/${session.sessionId}/release-f2`,
      ),
      f2: await controlPlaneRequest(
        guestInput,
        `/v1/serial-sessions/${session.sessionId}/wait-frame`,
        { parsedOpcode: "F2", timeoutMs: 30_000 },
      ),
    };

    report.result = await waitForSuccessfulResultSurface(
      client,
      {
        orderId: renderedSale.orderId,
        paymentId: renderedSale.paymentId,
        commandId: liveSale.vendingCommandId,
      },
      60_000,
    );
    await pushCheckpoint("result-after-ipc-recovery");
    if (recoveryOverlay == null) {
      throw new Error(
        "daemon transport interruption did not expose a recovery overlay",
      );
    }
    const serialEvidence = await controlPlaneRequest(
      guestInput,
      `/v1/serial-sessions/${String(activeSession.sessionId)}/evidence`,
    );
    report.serial = {
      rawFrames: compactFrames((serialEvidence as JsonRecord).rawFrames),
    };
    report.ok = true;
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
    report.error = (failure as Error).message;
    if (client) {
      try {
        await pushCheckpoint("failure");
      } catch {}
    }
  }

  const cleanup: unknown[] = [];
  let cleanupFailed = false;
  if (interruptedTransport && !recoveredTransport && handoff?.daemon) {
    try {
      recoveredTransport = runLocalPowerShellJson(
        buildInstalledKioskGuestOperationScript({
          operation: "daemon_transport_interrupt",
          phase: "recover",
          operationId: String(interruptedTransport.guestOperationId),
          daemonRuntime: handoff.daemon as JsonRecord | undefined,
          expectedTransaction: {
            ...((interruptedTransport.daemon as JsonRecord)
              .transactionBefore as Record<string, unknown>),
            machineCode: (interruptedTransport.platform as JsonRecord)
              .machineCode,
          },
        }),
        "daemon transport cleanup recovery",
      );
      cleanup.push({ label: "recover daemon transport", ok: true });
    } catch (error) {
      cleanupFailed = true;
      cleanup.push({
        label: "recover daemon transport",
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (guestInput && session?.sessionId) {
    try {
      const result = liveSale
        ? await controlPlaneRequest(
            guestInput,
            `/v1/serial-sessions/${session.sessionId}/stop`,
            {
              orderId: liveSale.orderId,
              paymentId: liveSale.paymentId,
              vendingCommandId: liveSale.vendingCommandId,
            },
          )
        : await controlPlaneRequest(
            guestInput,
            `/v1/serial-sessions/${session.sessionId}/abort`,
          );
      cleanup.push({
        label: liveSale ? "stop serial session" : "abort serial session",
        ok: true,
        result,
      });
    } catch (error) {
      cleanupFailed = true;
      cleanup.push({
        label: liveSale ? "stop serial session" : "abort serial session",
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (client) {
    try {
      await client.close();
      cleanup.push({ label: "close CDP client", ok: true });
    } catch (error) {
      cleanupFailed = true;
      cleanup.push({
        label: "close CDP client",
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  report.cleanup = {
    ok: cleanupFailed === false,
    steps: cleanup,
  };
  if (cleanupFailed) {
    report.ok = false;
    if (!failure) {
      report.error = "cleanup failed";
    }
  }

  writeJson(options.outPath, report);
  if (failure) throw failure;
  if (cleanupFailed) {
    throw new Error("ipc recovery cleanup failed");
  }
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runInstalledIpcRecoveryGuest(parseArgs(process.argv.slice(2))).catch(
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
