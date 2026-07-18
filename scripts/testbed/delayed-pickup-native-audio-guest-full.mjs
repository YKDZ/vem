#!/usr/bin/env node

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

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
import { readInstalledMachineProductionSample } from "./delayed-pickup-machine-evidence.mjs";
import {
  delayedPickupIssue16ControlPlaneContract,
  startDelayedPickupLiveProductionTrack,
} from "./delayed-pickup-live-production-track.mjs";
import {
  collectDelayedPickupProductionEvidence,
  verifyDelayedPickupNativeAudioProductionEvidence,
} from "./delayed-pickup-native-audio-acceptance.mjs";

const MODES = new Set(["full"]);
const DEFAULT_SCANNER_CODE = "6901234567892";
const MACHINE_PATH = "C:\\VEM\\bringup\\machine.exe";

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
    : resolve(`/mnt/${path[0].toLowerCase()}/${path.slice(3).replaceAll("\\", "/")}`);
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

function parseArgs(args) {
  const mode = required(option(args, "mode"), "--mode");
  if (!MODES.has(mode)) throw new Error("--mode must be full");
  return {
    mode,
    guestInputPath: windowsAbsolute(option(args, "guest-input"), "--guest-input"),
    handoffPath: windowsAbsolute(option(args, "handoff"), "--handoff"),
    outPath: windowsAbsolute(option(args, "out"), "--out"),
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
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      `${options.method ?? "GET"} ${url} failed with HTTP ${response.status}: ${JSON.stringify(payload)}`,
    );
  }
  return payload;
}

function daemonBaseUrl(handoff) {
  const healthzUrl = required(handoff.daemon?.ready?.healthzUrl, "daemon healthzUrl");
  if (!healthzUrl.endsWith("/healthz"))
    throw new Error("daemon healthzUrl must end with /healthz");
  return healthzUrl.slice(0, -"/healthz".length);
}

function daemonHeaders(handoff) {
  return {
    authorization: `Bearer ${required(handoff.daemon?.ready?.ipcToken, "daemon ipcToken")}`,
  };
}

async function daemonGet(handoff, path) {
  return fetchJson(`${daemonBaseUrl(handoff)}${path}`, {
    headers: daemonHeaders(handoff),
  });
}

async function controlPlaneRequest(guestInput, path, body = {}) {
  const endpoint = required(guestInput.hostControlPlane?.endpoint, "hostControlPlane.endpoint");
  const token = required(guestInput.hostControlPlane?.token, "hostControlPlane.token");
  return fetchJson(`${endpoint}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function waitForCommand(handoff, renderedSale, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastTransaction = null;
  while (Date.now() < deadline) {
    const transaction = await daemonGet(handoff, "/v1/transactions/current").catch(
      () => null,
    );
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
    `vending command did not appear for order ${renderedSale.orderId}: ${JSON.stringify(lastTransaction)}`,
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
  const result = await controlPlaneRequest(guestInput, "/v1/platform/query", input);
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
    last = (await controlPlaneRequest(guestInput, "/v1/platform/query", input)).report;
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
      conformancePath: join(dirname(localPath(installedSalePath)), "serial-conformance.json"),
      controlPlaneEvidencePath,
    },
    audio: {
      evidenceDirectory: join(delayedRoot, "host-default-audio"),
      startReportPath: join(delayedRoot, "audio-capture-start.json"),
      stopReportPath: join(delayedRoot, "audio-capture-stop.json"),
      wavPath: null,
      rawSerialCapturePath: null,
    },
    trace: {
      machineEvidencePath: join(delayedRoot, "machine-production-evidence.json"),
    },
    screenshots: screenshotRefs,
  };
  const audioStop = liveEvidence?.audioStop;
  for (const artifact of audioStop?.evidence ?? []) {
    const resolved = join(localPath(liveEvidence.evidenceDirectory), artifact.fileName);
    if (artifact.role === "sale-default-audio-capture") index.audio.wavPath = resolved;
    if (artifact.role === "sale-serial-frame-capture")
      index.audio.rawSerialCapturePath = resolved;
  }
  return index;
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

async function runDelayedPickupGuestFull(options) {
  const guestInput = readJson(options.guestInputPath, "guest input");
  const handoff = readJson(options.handoffPath, "installed runtime handoff");
  const outRoot = dirname(localPath(options.outPath));
  const artifactRoot = join(outRoot, "delayed-pickup-native-audio-artifacts");
  const delayedRoot = join(artifactRoot, "live-production-track");
  const screenshotRoot = join(artifactRoot, "screenshots");
  const installedSalePath = join(artifactRoot, "installed-sale-production-handoff.json");
  const platformBaselinePath = join(artifactRoot, "platform-raw-records-baseline.json");
  const platformPostPath = join(artifactRoot, "platform-raw-records.json");
  const controlPlaneEvidencePath = join(
    artifactRoot,
    "host-control-plane-bounded-evidence.json",
  );
  const platformLogPath = join(artifactRoot, "platform-service-api.log");
  const platformLogReportPath = join(artifactRoot, "platform-service-api.json");
  const serialConformancePath = join(artifactRoot, "serial-conformance.json");
  const screenshotRefs = [];
  const saleCorrelationId =
    `sale-correlation://${guestInput.runId.toLowerCase()}.delayed-pickup`;
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
      screenshotRefs,
    }),
  };
  let client = null;
  let delayedTrack = null;
  let sessionStart = null;
  let liveSale = null;
  let liveEvidence = null;
  let primaryError = null;
  let sessionStopped = false;
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
    const sink = screenshotSink(screenshotRoot);
    let baselinePlatform = null;
    delayedTrack = await startDelayedPickupLiveProductionTrack(
      {
        outputRoot: delayedRoot,
        runId: guestInput.runId,
        lifecycleReference:
          `vm-lifecycle://${guestInput.runId.toLowerCase()}.local-testbed-delayed-pickup`,
        transactionId:
          `transaction://${guestInput.runId.toLowerCase()}.delayed-pickup`,
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
              ...(sessionStart ? { sessionId: sessionStart.sessionId } : {}),
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
      },
    );
    report.evidence = issue17EvidenceIndex({
      guestInputPath: options.guestInputPath,
      handoffPath: options.handoffPath,
      installedSalePath,
      platformBaselinePath,
      platformPostPath,
      delayedRoot,
      screenshotRefs,
    });

    sessionStart = await controlPlaneRequest(guestInput, "/v1/serial-sessions/start", {
        runId: guestInput.runId,
        machineCode: guestInput.machineCode,
        targetIdentity: guestInput.hostControlPlane.targetIdentity,
        runtimeBase: guestInput.hostControlPlane.runtimeBaseIdentity,
        saleCorrelationId,
        serialScenario: "delayed-pickup",
      });

    for (const step of [
      ['[data-test="catalog-category"]:not(:disabled)', "#/catalog"],
      ['[data-test="catalog-product"]', /^#\/products\//],
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
      if (checkpoint?.screenshot?.ref) screenshotRefs.push(checkpoint.screenshot.ref);
    });
    await activateVisibleSelector(client, '[data-test="checkout-submit"]', {
      kind: "touch",
      timeoutMs: 30_000,
    });
    await waitForRoute(client, /^#\/payment/, { timeoutMs: 30_000, pollMs: 250 });
    const paymentSurface = await readRenderedPaymentSurface(client);
    liveSale = await waitForCommand(handoff, paymentSurface);
    await controlPlaneRequest(
      guestInput,
      `/v1/serial-sessions/${sessionStart.sessionId}/inject`,
      {
        orderId: liveSale.orderId,
        paymentId: liveSale.paymentId,
        scannerCode: guestInput.fastSale?.scannerCode ?? DEFAULT_SCANNER_CODE,
      },
    );

    await controlPlaneRequest(
      guestInput,
      `/v1/serial-sessions/${sessionStart.sessionId}/wait-frame`,
      { parsedOpcode: "VEND", timeoutMs: 30_000, serialScenario: "delayed-pickup" },
    );
    await controlPlaneRequest(
      guestInput,
      `/v1/serial-sessions/${sessionStart.sessionId}/release-f0`,
    );
    await controlPlaneRequest(
      guestInput,
      `/v1/serial-sessions/${sessionStart.sessionId}/wait-frame`,
      { parsedOpcode: "F0", timeoutMs: 30_000, serialScenario: "delayed-pickup" },
    );
    const f1Boundary = await controlPlaneRequest(
      guestInput,
      `/v1/serial-sessions/${sessionStart.sessionId}/wait-frame`,
      { parsedOpcode: "F1", timeoutMs: 45_000, serialScenario: "delayed-pickup" },
    );
    await delayedTrack.observeControllerFrame(f1Boundary.frame);
    const afterF1Ui = await readUiBoundary(client);
    if (afterF1Ui.result?.kind === "success")
      throw new Error("UI must not show success before inbound F2");
    await captureCheckpoint(client, "after-f1-before-f2", {
      screenshot: true,
      screenshotSink: sink,
    }).then((checkpoint) => {
      if (checkpoint?.screenshot?.ref) screenshotRefs.push(checkpoint.screenshot.ref);
    });
    await controlPlaneRequest(
      guestInput,
      `/v1/serial-sessions/${sessionStart.sessionId}/release-f2`,
    );
    const f2Boundary = await controlPlaneRequest(
      guestInput,
      `/v1/serial-sessions/${sessionStart.sessionId}/wait-frame`,
      { parsedOpcode: "F2", timeoutMs: 30_000, serialScenario: "delayed-pickup" },
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
    await waitForResultRoute(client, 60_000);
    await captureCheckpoint(client, "result", {
      screenshot: true,
      screenshotSink: sink,
    }).then((checkpoint) => {
      if (checkpoint?.screenshot?.ref) screenshotRefs.push(checkpoint.screenshot.ref);
    });
    const platformPost = await waitForPlatformMovement(
      guestInput,
      {
        runId: guestInput.runId,
        machineCode: guestInput.machineCode,
        sessionId: sessionStart.sessionId,
      },
      baselinePlatform?.raw?.movements?.length ?? 0,
      platformPostPath,
    );
    const command = platformPost.raw.commands.find(
      (entry) => entry.id === liveSale.vendingCommandId,
    );
    if (typeof command?.commandNo !== "string" || command.commandNo.length === 0)
      throw new Error("authoritative platform post-F2 command number is missing");
    liveEvidence = await delayedTrack.finish({
        runId: guestInput.runId,
        lifecycleReference:
          `vm-lifecycle://${guestInput.runId.toLowerCase()}.local-testbed-delayed-pickup`,
        transactionId:
          `transaction://${guestInput.runId.toLowerCase()}.delayed-pickup`,
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
        platformRawBaselinePath,
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
    try {
      if (sessionStart && !sessionStopped) {
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
      }
    } catch (cleanupError) {
      if (!primaryError) primaryError = cleanupError;
    }
    await delayedTrack?.close().catch(() => {});
    await client?.close().catch(() => {});
  }
  if (primaryError) {
    report.error = formatError(primaryError);
    report.controlPlaneSessionId = sessionStart?.sessionId ?? null;
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
