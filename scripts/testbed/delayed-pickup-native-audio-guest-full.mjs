#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { waitForDaemonReadyRefresh } from "./daemon-ready-refresh.mjs";
import {
  delayedPickupIssue16ControlPlaneContract,
  startDelayedPickupLiveProductionTrack,
} from "./delayed-pickup-live-production-track.mjs";
import { readInstalledMachineProductionSample } from "./delayed-pickup-machine-evidence.mjs";
import {
  collectDelayedPickupProductionEvidence,
  verifyDelayedPickupNativeAudioProductionEvidence,
} from "./delayed-pickup-native-audio-acceptance.mjs";
import { catalogProductSelectorForFixture } from "./full-workflow-fixtures.mjs";
import {
  activateVisibleSelector,
  captureCheckpoint,
  CdpClient,
  discoverMachineUiTarget,
  enablePageRuntime,
  evaluateExpression,
  rewriteWebSocketDebuggerUrl,
  waitForRoute,
} from "./machine-ui-cdp-driver.mjs";

const MODES = new Set(["full"]);
const DEFAULT_SCANNER_CODE = "621234567890123456";
const MACHINE_PATH = "C:\\VEM\\bringup\\machine.exe";
const CLEANUP_TIMEOUT_MS = 10_000;

function scannerFrame(code) {
  return `${required(code, "scanner code").replace(/[\r\n]+$/u, "")}\r\n`;
}

function required(value, label) {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${label} is required`);
  return value.trim();
}

function windowsAbsolute(value, label) {
  const path = required(value, label);
  if (!/^[A-Za-z]:\\/.test(path) || path.includes("\0"))
    throw new Error(`${label} must be an absolute Windows path`);
  return path;
}

function localPath(path) {
  return process.platform === "win32"
    ? path
    : resolve(
        `/mnt/${path[0].toLowerCase()}/${path.slice(3).replaceAll("\\", "/")}`,
      );
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(localPath(path), "utf8"));
  } catch (error) {
    throw new Error(
      `${label} is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function writeJson(path, value) {
  const target = localPath(path);
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, target);
}

function option(args, name) {
  const index = args.indexOf(`--${name}`);
  const value = index === -1 ? undefined : args[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`--${name} requires a value`);
  return value;
}

function optionalOption(args, name) {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? null : required(args[index + 1], `--${name}`);
}

function parseArgs(args) {
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

function screenshotSink(root) {
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

async function fetchJson(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const { timeoutMs: _timeoutMs, ...requestOptions } = options;
  const response = await fetch(url, {
    ...requestOptions,
    signal: options.signal ?? AbortSignal.timeout(timeoutMs),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      `${options.method ?? "GET"} ${url} failed with HTTP ${response.status}: ${JSON.stringify(payload)}`,
    );
  }
  return payload;
}

async function withinDeadline(callback, label, timeoutMs = 10_000) {
  let timer = null;
  try {
    return await Promise.race([
      callback(),
      new Promise((_, reject) => {
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

function daemonBaseUrl(handoff) {
  const healthzUrl = required(
    handoff.daemon?.ready?.healthzUrl,
    "daemon healthzUrl",
  );
  if (!healthzUrl.endsWith("/healthz"))
    throw new Error("daemon healthzUrl must end with /healthz");
  return healthzUrl.slice(0, -"/healthz".length);
}

function daemonHeaders(handoff) {
  return {
    authorization: `Bearer ${required(handoff.daemon?.ready?.ipcToken, "daemon ipcToken")}`,
  };
}

async function daemonGet(handoff, path, timeoutMs = 30_000) {
  return fetchJson(`${daemonBaseUrl(handoff)}${path}`, {
    headers: daemonHeaders(handoff),
    timeoutMs,
  });
}

async function prepareScannerForSale(handoff, guestInput, sessionStart) {
  const bindingDeadline = Date.now() + 30_000;
  let bindings = null;
  while (Date.now() < bindingDeadline) {
    bindings = await daemonGet(handoff, "/v1/hardware-bindings").catch(
      () => null,
    );
    const scanner = bindings?.roles?.find((role) => role?.role === "scanner");
    if (scanner?.ready === true && /^COM[1-9][0-9]*$/.test(scanner.currentPort))
      break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  const scanner = bindings?.roles?.find((role) => role?.role === "scanner");
  if (scanner?.ready !== true)
    throw new Error(
      `scanner binding was not ready: ${JSON.stringify(bindings)}`,
    );

  await controlPlaneRequest(
    guestInput,
    `/v1/serial-sessions/${sessionStart.sessionId}/stop-scanner-probe`,
  );

  const capabilityDeadline = Date.now() + 30_000;
  let capability = null;
  while (Date.now() < capabilityDeadline) {
    capability = await daemonGet(handoff, "/v1/sale-start-capability").catch(
      () => null,
    );
    const paymentCode = capability?.paymentOptions?.options?.find(
      (option) => option?.optionKey === "payment_code:mock",
    );
    if (capability?.canStartSale === true && paymentCode?.ready === true)
      return { bindings, capability };
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(
    `scanner sale capability did not recover: ${JSON.stringify(capability)}`,
  );
}

async function controlPlaneRequest(guestInput, path, body = {}) {
  const endpoint = required(
    guestInput.hostControlPlane?.endpoint,
    "hostControlPlane.endpoint",
  );
  const token = required(
    guestInput.hostControlPlane?.token,
    "hostControlPlane.token",
  );
  return fetchJson(`${endpoint}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    timeoutMs: body.timeoutMs ?? 30_000,
  });
}

async function waitForCommand(handoff, renderedSale, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastTransaction = null;
  let lastError = null;
  while (Date.now() < deadline) {
    const transaction = await daemonGet(
      handoff,
      "/v1/transactions/current",
      1_000,
    ).catch((error) => {
      lastError = error instanceof Error ? error.message : String(error);
      return null;
    });
    lastTransaction = transaction;
    const commandId =
      transaction?.vending?.commandId ?? transaction?.dispenseCommandId ?? null;
    if (
      transaction?.orderId === renderedSale.orderId &&
      transaction?.paymentId === renderedSale.paymentId &&
      typeof commandId === "string" &&
      commandId
    ) {
      return {
        orderId: transaction.orderId,
        paymentId: transaction.paymentId,
        orderNo: transaction.orderNo,
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
  client,
  orderNo,
  timeoutMs = 45_000,
) {
  const requiredSuffixes = [
    "pickup-outlet-opened",
    "pickup-warning-1",
    "pickup-warning-2",
    "pickup-completed",
    "dispense-succeeded",
  ];
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await evaluateExpression(
      client,
      `(() => {
        const prefix = ${JSON.stringify(`transaction:${orderNo}:`)};
        const trace = (window.__VEM_MACHINE_RUNTIME_TRACE__ || []).filter(
          (entry) => typeof entry?.transitionId === "string" && entry.transitionId.startsWith(prefix),
        );
        return ${JSON.stringify(requiredSuffixes)}.map((suffix) => {
          const entries = trace.filter((entry) => entry.transitionId === prefix + suffix);
          return {
            suffix,
            queued: entries.some((entry) => entry.type === "audio_queued"),
            started: entries.some((entry) => entry.type === "audio_started"),
            terminal: entries.some((entry) => entry.type === "audio_terminal"),
          };
        });
      })()`,
    );
    if (
      Array.isArray(last) &&
      last.every((entry) => entry.queued && entry.started && entry.terminal)
    ) {
      return last;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(`transaction audio did not settle: ${JSON.stringify(last)}`);
}

async function waitForPaymentCodeArm(
  handoff,
  renderedSale,
  timeoutMs = 30_000,
) {
  const deadline = Date.now() + timeoutMs;
  let lastTransaction = null;
  let consecutiveReady = 0;
  while (Date.now() < deadline) {
    const transaction = await daemonGet(
      handoff,
      "/v1/transactions/current",
    ).catch(() => null);
    lastTransaction = transaction;
    const ready =
      transaction?.orderId === renderedSale.orderId &&
      transaction?.paymentId === renderedSale.paymentId &&
      transaction?.orderStatus === "pending_payment" &&
      transaction?.paymentStatus === "pending" &&
      transaction?.nextAction === "wait_payment";
    consecutiveReady = ready ? consecutiveReady + 1 : 0;
    if (consecutiveReady >= 2) return transaction;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(
    `payment-code transaction did not become armed: ${JSON.stringify(lastTransaction)}`,
  );
}

async function readRenderedPaymentSurface(client) {
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
  if (!hook?.orderId || !hook?.paymentId || !hook?.orderNo)
    throw new Error("required rendered customer UI payment hook is missing");
  return hook;
}

async function readUiBoundary(client) {
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

async function waitForResultRoute(client, timeoutMs = 60_000) {
  return waitForRoute(client, /^#\/(dispensing|result)/, {
    timeoutMs,
    pollMs: 250,
  });
}

async function queryPlatform(guestInput, input, outPath) {
  const result = await controlPlaneRequest(
    guestInput,
    "/v1/platform/query",
    input,
  );
  writeJson(outPath, result.report);
  return result.report;
}

async function waitForPlatformMovement(
  guestInput,
  input,
  baselineCount,
  outPath,
  timeoutMs = 30_000,
) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  do {
    last = (await controlPlaneRequest(guestInput, "/v1/platform/query", input))
      .report;
    if ((last?.raw?.movements ?? []).length > baselineCount) {
      writeJson(outPath, last);
      return last;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  } while (Date.now() < deadline);
  throw new Error(
    `platform movement did not appear after inbound F2: ${JSON.stringify(last?.raw?.movements ?? [])}`,
  );
}

function daemonTerminalReady(transaction, liveSale) {
  return (
    transaction?.orderId === liveSale.orderId &&
    transaction?.orderNo === liveSale.orderNo &&
    transaction?.vending?.commandId === liveSale.vendingCommandId &&
    transaction?.orderStatus === "fulfilled" &&
    transaction?.vending?.status === "succeeded" &&
    transaction?.nextAction === "success"
  );
}

function platformTerminalReady(report, liveSale) {
  const order = report?.raw?.orders?.find(
    (entry) => entry?.id === liveSale.orderId,
  );
  const command = report?.raw?.commands?.find(
    (entry) => entry?.id === liveSale.vendingCommandId,
  );
  return (
    order?.status === "fulfilled" &&
    command?.orderId === liveSale.orderId &&
    command?.status === "succeeded" &&
    typeof command?.commandNo === "string" &&
    command.commandNo.length > 0
  );
}

async function waitForTerminalSale({
  guestInput,
  handoff,
  sessionId,
  liveSale,
  outPath,
  timeoutMs = 30_000,
}) {
  const deadline = Date.now() + timeoutMs;
  let lastPlatform = null;
  let lastTransaction = null;
  do {
    [lastTransaction, lastPlatform] = await Promise.all([
      daemonGet(handoff, "/v1/transactions/current").catch(() => null),
      queryPlatform(
        guestInput,
        {
          runId: guestInput.runId,
          machineCode: guestInput.machineCode,
          sessionId,
        },
        outPath,
      ).catch(() => null),
    ]);
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
        commands: lastPlatform?.raw?.commands ?? [],
      },
    )}`,
  );
}

function daemonCheckpointFactory(handoff) {
  return async (stage, binding) => ({
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
}) {
  const index = {
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
  const audioStop = liveEvidence?.audioStop;
  for (const artifact of audioStop?.evidence ?? []) {
    const resolved = join(
      localPath(liveEvidence.evidenceDirectory),
      artifact.fileName,
    );
    if (artifact.role === "sale-default-audio-capture")
      index.audio.wavPath = resolved;
    if (artifact.role === "sale-serial-frame-capture")
      index.audio.rawSerialCapturePath = resolved;
  }
  return index;
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

function cleanupTimeout(label, timeoutMs) {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} exceeded ${timeoutMs}ms cleanup deadline`));
    }, timeoutMs);
    timer.unref?.();
  });
}

export async function runCleanupStep(
  label,
  action,
  timeoutMs = CLEANUP_TIMEOUT_MS,
) {
  try {
    return await Promise.race([action(), cleanupTimeout(label, timeoutMs)]);
  } catch (error) {
    const wrapped = new Error(`${label} failed: ${formatError(error)}`);
    wrapped.cause = error;
    wrapped.cleanupLabel = label;
    throw wrapped;
  }
}

export function combineCleanupError(primaryError, cleanupErrors) {
  if (cleanupErrors.length === 0) return primaryError;
  if (primaryError) {
    return new AggregateError(
      [primaryError, ...cleanupErrors],
      `${primaryError.message}; cleanup failed: ${cleanupErrors.map((error) => error.message).join("; ")}`,
    );
  }
  return new AggregateError(
    cleanupErrors,
    `cleanup failed: ${cleanupErrors.map((error) => error.message).join("; ")}`,
  );
}

async function runDelayedPickupGuestFull(options) {
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
  const screenshotRefs = [];
  const saleCorrelationId = `sale-correlation://${guestInput.runId.toLowerCase()}.delayed-pickup`;
  const report = {
    schemaVersion: "local-testbed-delayed-pickup-native-audio/v1",
    kind: "local-testbed-delayed-pickup-native-audio",
    mode: options.mode,
    runId: guestInput.runId,
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
  let client = null;
  let delayedTrack = null;
  let sessionStart = null;
  let liveSale = null;
  let liveEvidence = null;
  let primaryError = null;
  let audioCaptureId = null;
  const audioOperationId = `audio-capture-${randomUUID()}`;
  let sessionStopped = false;
  let sink = null;
  try {
    const target = await discoverMachineUiTarget({
      endpoint: "http://127.0.0.1:9222",
      expectedTargetId: handoff.cdp.targetId,
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
    sink = screenshotSink(screenshotRoot);
    sessionStart = await controlPlaneRequest(
      guestInput,
      "/v1/serial-sessions/start",
      {
        runId: guestInput.runId,
        machineCode: guestInput.machineCode,
        targetIdentity: guestInput.hostControlPlane.targetIdentity,
        runtimeBase: guestInput.hostControlPlane.runtimeBaseIdentity,
        saleCorrelationId,
        serialScenario: "delayed-pickup",
      },
    );
    await waitForDaemonReadyRefresh(handoff);
    await prepareScannerForSale(handoff, guestInput, sessionStart);
    let baselinePlatform = null;
    delayedTrack = await startDelayedPickupLiveProductionTrack(
      {
        outputRoot: delayedRoot,
        runId: guestInput.runId,
        lifecycleReference: `vm-lifecycle://${guestInput.runId.toLowerCase()}.local-testbed-delayed-pickup`,
        transactionId: `transaction://${guestInput.runId.toLowerCase()}.delayed-pickup`,
        saleCorrelationId,
        targetIdentity: guestInput.hostControlPlane.targetIdentity,
        remote: {
          remote: "local-testbed@127.0.0.1",
          identity: "not-used",
          certificate: "not-used",
        },
        captureDaemon: daemonCheckpointFactory(handoff),
        async queryPlatform(stage) {
          const report = await queryPlatform(
            guestInput,
            {
              runId: guestInput.runId,
              machineCode: guestInput.machineCode,
              sessionId: sessionStart.sessionId,
            },
            stage === "baseline"
              ? platformBaselinePath
              : join(delayedRoot, "platform-raw-at-f1.json"),
          );
          if (stage === "baseline") baselinePlatform = report;
          return report;
        },
      },
      {
        async openSidecar() {
          return {
            endpoint: "http://127.0.0.1:9222",
            async close() {},
          };
        },
        async discoverTarget() {
          return discoverMachineUiTarget({
            endpoint: "http://127.0.0.1:9222",
            expectedTargetId: handoff.cdp.targetId,
          });
        },
        async inspectRuntime() {
          return {
            machine: {
              processId: handoff.machine.processId,
              executablePath: handoff.machine.executablePath ?? MACHINE_PATH,
              sessionId: handoff.machine.sessionId,
              principal: handoff.machine.principal,
            },
            cdpListener: {
              machineAncestorProcessId: handoff.cdp.machineAncestorProcessId,
              sessionId: handoff.machine.sessionId,
              principal: handoff.machine.principal,
            },
          };
        },
        readMachineSample: readInstalledMachineProductionSample,
        async startAudioCapture({ baseBinding, runtime, outPath }) {
          const result = await controlPlaneRequest(
            guestInput,
            "/v1/audio-captures/start",
            {
              sessionId: sessionStart.sessionId,
              runId: baseBinding.runId,
              lifecycleReference: baseBinding.lifecycleReference,
              transactionId: baseBinding.transactionId,
              targetIdentity: guestInput.hostControlPlane.targetIdentity,
              runtime,
              operationId: audioOperationId,
            },
          );
          audioCaptureId = result.audioCaptureId;
          writeJson(outPath, result.startReport);
          return result.startReport;
        },
        async stopAudioCapture({ binding, evidenceDirectory, outPath }) {
          const result = await controlPlaneRequest(
            guestInput,
            `/v1/audio-captures/${audioCaptureId}/stop`,
            {
              saleCorrelationId: binding.saleCorrelationId,
              orderId: binding.orderId,
              orderNo: binding.orderNo,
              commandId: binding.commandId,
              commandNo: binding.commandNo,
            },
          );
          writeJson(outPath, result.stopReport);
          mkdirSync(localPath(evidenceDirectory), { recursive: true });
          for (const artifact of result.evidencePayloads ?? []) {
            writeFileSync(
              join(localPath(evidenceDirectory), artifact.fileName),
              Buffer.from(artifact.bytesBase64, "base64"),
            );
          }
          return result.stopReport;
        },
        async cancelAudioCapture() {
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
            `/v1/audio-captures/${audioCaptureId}/cancel`,
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
              guestInput.fixtureAllocation,
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
    ]) {
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
      paymentCodeSelected = await evaluateExpression(
        client,
        `(() => {
          const option = document.querySelector(${JSON.stringify(paymentCodeSelector)});
          const submit = document.querySelector('[data-test="checkout-submit"]');
          return Boolean(option?.classList.contains('payment-option-selected') && !submit?.hasAttribute('disabled'));
        })()`,
      );
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
      `/v1/serial-sessions/${sessionStart.sessionId}/inject`,
      {
        orderId: paymentSurface.orderId,
        paymentId: paymentSurface.paymentId,
        scannerCodeBase64: Buffer.from(
          scannerFrame(
            guestInput.fastSale?.scannerCode ?? DEFAULT_SCANNER_CODE,
          ),
          "utf8",
        ).toString("base64"),
      },
    );
    liveSale = await waitForCommand(handoff, paymentSurface);

    await controlPlaneRequest(
      guestInput,
      `/v1/serial-sessions/${sessionStart.sessionId}/wait-frame`,
      {
        parsedOpcode: "VEND",
        timeoutMs: 30_000,
        serialScenario: "delayed-pickup",
      },
    );
    await controlPlaneRequest(
      guestInput,
      `/v1/serial-sessions/${sessionStart.sessionId}/release-f0`,
    );
    await controlPlaneRequest(
      guestInput,
      `/v1/serial-sessions/${sessionStart.sessionId}/wait-frame`,
      {
        parsedOpcode: "F0",
        timeoutMs: 30_000,
        serialScenario: "delayed-pickup",
      },
    );
    const f1Boundary = await controlPlaneRequest(
      guestInput,
      `/v1/serial-sessions/${sessionStart.sessionId}/wait-frame`,
      {
        parsedOpcode: "F1",
        timeoutMs: 45_000,
        serialScenario: "delayed-pickup",
      },
    );
    await delayedTrack.observeControllerFrame(f1Boundary.frame);
    const afterF1Ui = await readUiBoundary(client);
    if (afterF1Ui.result?.kind === "success")
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
      `/v1/serial-sessions/${sessionStart.sessionId}/release-f2`,
    );
    const f2Boundary = await controlPlaneRequest(
      guestInput,
      `/v1/serial-sessions/${sessionStart.sessionId}/wait-frame`,
      {
        parsedOpcode: "F2",
        timeoutMs: 30_000,
        serialScenario: "delayed-pickup",
      },
    );
    await delayedTrack.observeControllerFrame(f2Boundary.frame);
    const collect = await controlPlaneRequest(
      guestInput,
      `/v1/serial-sessions/${sessionStart.sessionId}/collect`,
      {
        orderId: liveSale.orderId,
        paymentId: liveSale.paymentId,
        vendingCommandId: liveSale.vendingCommandId,
      },
    );
    const terminal = await waitForTerminalSale({
      guestInput,
      handoff,
      sessionId: sessionStart.sessionId,
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
    await waitForTransactionAudioSettled(client, liveSale.orderNo);
    const platformPost = terminal.platform;
    const command = platformPost?.raw?.commands?.find(
      (entry) => entry.id === liveSale.vendingCommandId,
    );
    if (
      typeof command?.commandNo !== "string" ||
      command.commandNo.length === 0
    )
      throw new Error(
        "authoritative platform post-F2 command number is missing",
      );
    liveEvidence = await delayedTrack.finish({
      runId: guestInput.runId,
      lifecycleReference: `vm-lifecycle://${guestInput.runId.toLowerCase()}.local-testbed-delayed-pickup`,
      transactionId: `transaction://${guestInput.runId.toLowerCase()}.delayed-pickup`,
      saleCorrelationId,
      orderId: liveSale.orderId,
      orderNo: liveSale.orderNo,
      commandId: liveSale.vendingCommandId,
      commandNo: command.commandNo,
    });
    const controlPlaneEvidence = await controlPlaneRequest(
      guestInput,
      `/v1/serial-sessions/${sessionStart.sessionId}/evidence`,
    );
    writeJson(controlPlaneEvidencePath, controlPlaneEvidence);
    const platformLog = await controlPlaneRequest(
      guestInput,
      `/v1/serial-sessions/${sessionStart.sessionId}/platform-log`,
      { lines: 200 },
    );
    writeJson(platformLogReportPath, platformLog);
    writeFileSync(localPath(platformLogPath), platformLog.log ?? "");
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
      runId: guestInput.runId,
      runtimeBinding: {
        normal: handoff.machine,
        debug: {
          targetId: handoff.cdp.targetId,
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
    const artifacts = collectDelayedPickupProductionEvidence({
      installedSaleReportPath: installedSalePath,
      machineEvidencePath: liveEvidence.paths.machine,
      daemonEvidencePath: liveEvidence.paths.daemon,
      platformF1Path: liveEvidence.paths.platformF1,
      audioStartReportPath: liveEvidence.paths.audioStart,
      audioStopReportPath: liveEvidence.paths.audioStop,
    });
    const acceptance = verifyDelayedPickupNativeAudioProductionEvidence({
      artifacts,
      audioEvidenceDirectory: liveEvidence.evidenceDirectory,
    });
    if (acceptance.result !== "passed") {
      throw new Error(
        `delayed pickup native audio acceptance failed: ${JSON.stringify(acceptance.diagnostics)}`,
      );
    }
    await controlPlaneRequest(
      guestInput,
      `/v1/serial-sessions/${sessionStart.sessionId}/stop`,
      {
        orderId: liveSale.orderId,
        paymentId: liveSale.paymentId,
        vendingCommandId: liveSale.vendingCommandId,
      },
    );
    sessionStopped = true;
    report.status = "passed";
    report.ok = true;
    report.delayedPickupNativeAudio = acceptance;
    report.controlPlaneSessionId = sessionStart.sessionId;
  } catch (error) {
    primaryError = error;
  } finally {
    const collectionErrors = report.errors.collection;
    const cleanupErrors = report.errors.cleanup;
    const cleanupFailures = [];
    const collectBestEffort = async (label, callback) => {
      try {
        await withinDeadline(callback, "collection");
      } catch (error) {
        collectionErrors.push(`${label}: ${formatError(error)}`);
      }
    };
    await collectBestEffort("control-plane-evidence", async () => {
      if (!sessionStart || liveEvidence) return;
      const controlPlaneEvidence = await controlPlaneRequest(
        guestInput,
        `/v1/serial-sessions/${sessionStart.sessionId}/evidence`,
      );
      writeJson(controlPlaneEvidencePath, controlPlaneEvidence);
    });
    await collectBestEffort("platform-log", async () => {
      if (!sessionStart || liveEvidence) return;
      const platformLog = await controlPlaneRequest(
        guestInput,
        `/v1/serial-sessions/${sessionStart.sessionId}/platform-log`,
        { lines: 200 },
      );
      writeJson(platformLogReportPath, platformLog);
      writeFileSync(localPath(platformLogPath), platformLog.log ?? "");
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
      if (!client) return;
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
    const cleanupFailClosed = async (label, callback) => {
      try {
        await runCleanupStep(label, callback);
      } catch (error) {
        cleanupErrors.push(`${label}: ${formatError(error)}`);
        cleanupFailures.push(error);
      }
    };
    await cleanupFailClosed("pending-order", async () => {
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
    });
    await cleanupFailClosed("serial-session", async () => {
      if (!sessionStart || sessionStopped) return;
      if (liveSale) {
        await controlPlaneRequest(
          guestInput,
          `/v1/serial-sessions/${sessionStart.sessionId}/stop`,
          {
            orderId: liveSale.orderId,
            paymentId: liveSale.paymentId,
            vendingCommandId: liveSale.vendingCommandId,
            idempotencyCheck: true,
          },
        ).catch(async () =>
          controlPlaneRequest(
            guestInput,
            `/v1/serial-sessions/${sessionStart.sessionId}/abort`,
          ),
        );
      } else {
        await controlPlaneRequest(
          guestInput,
          `/v1/serial-sessions/${sessionStart.sessionId}/abort`,
        );
      }
    });
    await cleanupFailClosed("audio-capture", async () => {
      if (liveEvidence?.audioStop) return;
      await controlPlaneRequest(guestInput, "/v1/audio-captures/cancel", {
        operationId: audioOperationId,
      });
    });
    await cleanupFailClosed("live-track-close", async () => {
      await delayedTrack?.close();
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
  if (report.errors.cleanup.length > 0) {
    const cleanupFailure = new Error(
      `delayed pickup native audio cleanup failed: ${report.errors.cleanup.join("; ")}`,
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
    report.errors.primary =
      primaryError instanceof AggregateError &&
      primaryError.errors[0] instanceof Error
        ? formatError(primaryError.errors[0])
        : formatError(primaryError);
    report.controlPlaneSessionId = sessionStart?.sessionId ?? null;
  } else {
    report.errors.primary = null;
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
