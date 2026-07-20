#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { waitForDaemonReadyRefresh } from "./daemon-ready-refresh.mjs";
import { buildFullWorkflowEvidenceManifest } from "./full-workflow-evidence-manifest.mjs";
import { buildFullWorkflowAggregate } from "./full-workflow-validator.mjs";
import {
  activateVisibleSelector,
  CdpClient,
  discoverMachineUiTarget,
  enablePageRuntime,
  evaluateExpression,
  rewriteWebSocketDebuggerUrl,
  waitForRoute,
} from "./machine-ui-cdp-driver.mjs";
import {
  isActiveTransaction,
  captureTrackTerminalFacts,
  recoverTrackHandoff,
} from "./track-handoff-recovery.mjs";

const PASSED_EVIDENCE = Object.freeze({
  trace: true,
  logs: true,
  screenshot: true,
});
const FAILED_EVIDENCE = Object.freeze({
  primaryReason: true,
  diagnostic: true,
  trace: false,
  logs: false,
  screenshot: false,
});
const PAYMENT_CANCEL_SELECTOR = '[data-test="payment-cancel"]:not(:disabled)';
const PAYMENT_RETURN_WAIT_MS = 30_000;
const CONTROL_PLANE_TIMEOUT_MS = 10_000;
const CHILD_ERROR_TAIL_BYTES = 8 * 1024;
const DAEMON_READY_FILE =
  "C:\\ProgramData\\VEM\\vending-daemon\\daemon-ready.json";
const STOCK_READY_TIMEOUT_MS = 30_000;

export const FULL_WORKFLOW_TRACK_DESCRIPTORS = Object.freeze(
  [
    [
      "fast",
      false,
      true,
      "fast-route-stress-sale.json",
      "fast-route-stress-sale-artifacts",
      "node",
      "scripts/testbed/fast-route-stress-sale.mjs",
      [],
    ],
    [
      "scanner",
      true,
      true,
      "scanner-payment-code.json",
      "scanner-payment-code-artifacts",
      "node",
      "scripts/testbed/scanner-payment-code-guest-full.mjs",
      ["--mode", "full"],
    ],
    [
      "visionTryOn",
      true,
      false,
      "vision-try-on-acceptance.json",
      "vision-try-on-acceptance-artifacts",
      "powershell",
      "scripts/testbed/run-full-vision-try-on-track.ps1",
      [],
    ],
    [
      "delayedPickup",
      true,
      true,
      "delayed-pickup-native-audio.json",
      "delayed-pickup-native-audio-artifacts",
      "node",
      "scripts/testbed/delayed-pickup-native-audio-guest-full.mjs",
      ["--mode", "full"],
    ],
    [
      "ipcRecovery",
      true,
      true,
      "installed-ipc-recovery.json",
      "ipc-recovery-artifacts",
      "node",
      "scripts/testbed/installed-ipc-recovery-guest-full.mjs",
      ["--mode", "full"],
    ],
    [
      "fulfillmentFailure",
      true,
      true,
      "serial-fulfillment-error.json",
      "serial-fulfillment-error-artifacts",
      "node",
      "scripts/testbed/serial-fulfillment-error-guest-full.mjs",
      ["--mode", "full"],
    ],
  ].map(
    ([
      key,
      fullOnly,
      transactionProducing,
      reportFileName,
      artifactDirectory,
      kind,
      script,
      args,
    ]) =>
      Object.freeze({
        key,
        fullOnly,
        transactionProducing,
        fixtureKey: key,
        reportFileName,
        artifactDirectory,
        command: Object.freeze({ kind, script, args }),
        evidence: Object.freeze({
          passed: PASSED_EVIDENCE,
          failed: FAILED_EVIDENCE,
        }),
      }),
  ),
);

function required(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function option(args, name) {
  const index = args.indexOf(`--${name}`);
  if (index === -1) throw new Error(`--${name} is required`);
  return required(args[index + 1], name);
}

function parseArgs(args) {
  const mode = option(args, "mode");
  if (!["fast", "full"].includes(mode))
    throw new Error("--mode must be fast or full");
  return {
    mode,
    guestInputPath: option(args, "guest-input"),
    handoffPath: option(args, "handoff"),
    outPath: option(args, "out"),
  };
}

function runTrack(command, label) {
  return new Promise((resolvePromise) => {
    const child = spawn(command[0], command.slice(1), {
      env: process.env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-CHILD_ERROR_TAIL_BYTES);
    });
    child.once("error", (error) =>
      resolvePromise({
        label,
        command,
        exitCode: 1,
        status: "failed",
        stderr: error.message,
      }),
    );
    child.once("close", (code) =>
      resolvePromise({
        label,
        command,
        exitCode: code ?? 1,
        status: code === 0 ? "passed" : "failed",
        stderr,
      }),
    );
  });
}

function jsonIfPresent(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function workflowIdentity(guestInputPath) {
  return jsonIfPresent(guestInputPath)?.workflowIdentity ?? null;
}

function writeJson(path, value) {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function refreshDaemonReadyHandoff({
  handoffPath,
  readyPath = DAEMON_READY_FILE,
  handoff = jsonIfPresent(handoffPath),
}) {
  const ready = jsonIfPresent(readyPath);
  if (!handoff?.daemon || !ready) {
    throw new Error("daemon ready handoff inputs are unavailable");
  }
  for (const key of ["healthzUrl", "readyzUrl", "ipcToken", "generation"]) {
    required(ready[key], `daemon ready ${key}`);
  }
  handoff.daemon.ready = { ...ready };
  writeJson(handoffPath, handoff);
  return handoff;
}

function commandForTrack(track, { mode, guestInputPath, handoffPath }) {
  if (track.command.kind === "powershell") {
    return [
      "pwsh",
      "-NoProfile",
      "-NonInteractive",
      "-File",
      track.command.script,
      "-GuestInputPath",
      guestInputPath,
      "-HandoffPath",
      handoffPath,
      "-OutPath",
      track.reportPath,
      "-FixtureKey",
      track.fixtureKey,
    ];
  }
  return [
    process.execPath,
    track.command.script,
    ...(track.command.args.length ? track.command.args : ["--mode", mode]),
    "--guest-input",
    guestInputPath,
    "--handoff",
    handoffPath,
    "--out",
    track.reportPath,
    "--fixture-key",
    track.fixtureKey,
  ];
}

export function buildWorkflowTrackCommands({
  mode,
  guestInputPath,
  handoffPath,
  outPath,
}) {
  const root = dirname(resolve(outPath));
  const tracks = FULL_WORKFLOW_TRACK_DESCRIPTORS.filter(
    (track) => mode === "full" || !track.fullOnly,
  ).map((descriptor) => {
    const track = {
      ...descriptor,
      reportPath: join(root, descriptor.reportFileName),
      artifactRoot: join(root, descriptor.artifactDirectory),
    };
    return {
      ...track,
      command: commandForTrack(track, { mode, guestInputPath, handoffPath }),
    };
  });
  const reportPathFor = (key) =>
    tracks.find((track) => track.key === key)?.reportPath ?? null;
  return {
    fastReportPath: reportPathFor("fast"),
    ipcRecoveryReportPath: reportPathFor("ipcRecovery"),
    fulfillmentFailureReportPath: reportPathFor("fulfillmentFailure"),
    scannerReportPath: reportPathFor("scanner"),
    delayedPickupReportPath: reportPathFor("delayedPickup"),
    visionTryOnReportPath: reportPathFor("visionTryOn"),
    tracks,
  };
}

function shortError(result) {
  return (
    (result.stderr || "").trim().replaceAll(/\s+/g, " ").slice(-500) || null
  );
}

export async function runSerialTrackLifecycle({
  tracks,
  runTrack: executeTrack,
  captureTerminal,
  recover,
  beforeTrack = () => undefined,
  now = () => new Date(),
}) {
  const executed = [];
  for (const track of tracks) {
    const startedAt = now().toISOString();
    let child;
    try {
      await beforeTrack(track);
      child = await executeTrack(track);
    } catch (error) {
      child = {
        status: "failed",
        exitCode: 1,
        stderr: `track preflight failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const report = child.report ?? jsonIfPresent(track.reportPath);
    let terminal;
    try {
      terminal = await captureTerminal(track, { child, report });
    } catch (error) {
      terminal = {
        ok: false,
        facts: null,
        reason: `terminal capture failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const finishedAt = now().toISOString();
    const childFailed = child.status !== "passed" || report?.ok !== true;
    const terminalFailed = terminal?.ok !== true;
    const recoveryStartedAt = now().toISOString();
    let recovery;
    try {
      recovery = await recover(track, { child, report, terminal });
    } catch (error) {
      recovery = {
        ok: false,
        actions: [],
        errors: [
          `handoff recovery failed: ${error instanceof Error ? error.message : String(error)}`,
        ],
      };
    }
    const recoveryFinishedAt = now().toISOString();
    executed.push({
      key: track.key,
      reportPath: track.reportPath,
      status: childFailed || terminalFailed ? "failed" : "passed",
      businessStatus: childFailed || terminalFailed ? "failed" : "passed",
      exitCode: child.exitCode,
      reportOk: report?.ok ?? null,
      startedAt,
      finishedAt,
      durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
      failureStage: childFailed
        ? "child"
        : terminalFailed
          ? "terminal-state"
          : null,
      error: childFailed
        ? shortError(child)
        : terminalFailed
          ? (terminal.reason ?? "terminal facts are incomplete")
          : null,
      terminal,
      handoffRecovery: {
        ...recovery,
        startedAt: recoveryStartedAt,
        finishedAt: recoveryFinishedAt,
        durationMs:
          Date.parse(recoveryFinishedAt) - Date.parse(recoveryStartedAt),
      },
    });
  }
  return executed;
}

async function boundedFetch(
  url,
  options = {},
  timeoutMs = CONTROL_PLANE_TIMEOUT_MS,
) {
  try {
    return await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new Error(`request timed out after ${timeoutMs} ms: ${url}`);
    }
    throw error;
  }
}

function controlPlaneRequest(guestInput, path, body = {}) {
  const controlPlane = guestInput?.hostControlPlane;
  if (!controlPlane?.endpoint || !controlPlane?.token) {
    throw new Error(
      "guest input is missing hostControlPlane endpoint and token",
    );
  }
  return boundedFetch(`${controlPlane.endpoint}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${controlPlane.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  }).then(async (response) => {
    const payload = await response.json().catch(() => null);
    if (!response.ok)
      throw new Error(
        `${path} returned HTTP ${response.status}: ${JSON.stringify(payload)}`,
      );
    return payload;
  });
}

function daemonGet(handoff, path) {
  const healthzUrl = required(
    handoff?.daemon?.ready?.healthzUrl,
    "daemon healthzUrl",
  );
  const baseUrl = healthzUrl.endsWith("/healthz")
    ? healthzUrl.slice(0, -"/healthz".length)
    : healthzUrl;
  return boundedFetch(`${baseUrl}${path}`, {
    headers: {
      authorization: `Bearer ${required(handoff?.daemon?.ready?.ipcToken, "daemon ipcToken")}`,
    },
  }).then(async (response) => {
    const payload = await response.json().catch(() => null);
    if (!response.ok)
      throw new Error(
        `${path} returned HTTP ${response.status}: ${JSON.stringify(payload)}`,
      );
    return payload;
  });
}

function daemonPost(handoff, path, body) {
  const healthzUrl = required(
    handoff?.daemon?.ready?.healthzUrl,
    "daemon healthzUrl",
  );
  const baseUrl = healthzUrl.endsWith("/healthz")
    ? healthzUrl.slice(0, -"/healthz".length)
    : healthzUrl;
  return boundedFetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${required(handoff?.daemon?.ready?.ipcToken, "daemon ipcToken")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  }).then(async (response) => {
    const payload = await response.json().catch(() => null);
    if (!response.ok)
      throw new Error(
        `${path} returned HTTP ${response.status}: ${JSON.stringify(payload)}`,
      );
    return payload;
  });
}

export async function ensureFixtureStockReady({
  fixtureAllocation,
  daemonGet: get,
  daemonPost: post,
  timeoutMs = STOCK_READY_TIMEOUT_MS,
  pollMs = 500,
}) {
  const fixtures = Object.values(fixtureAllocation ?? {});
  const desiredBySlot = new Map(
    fixtures.map((fixture) => [fixture.slotCode, fixture.onHandQty]),
  );
  if (desiredBySlot.size === 0) {
    throw new Error("fixture stock preflight requires allocated slots");
  }

  const targetIsReady = (saleView) => {
    const bySlot = new Map(
      (saleView?.items ?? []).map((item) => [item.slotCode, item]),
    );
    return [...desiredBySlot.keys()].every((slotCode) => {
      const item = bySlot.get(slotCode);
      return (
        item?.slotSalesState === "sale_ready" &&
        item.saleableStock > 0 &&
        item.physicalStock >= desiredBySlot.get(slotCode)
      );
    });
  };
  const initialSaleView = await get("/v1/sale-view");
  if (targetIsReady(initialSaleView)) return { changed: false };

  const task = await get("/v1/stock/maintenance-task");
  if (
    !["initial_count", "recovery_count", "routine_refill"].includes(task?.mode)
  ) {
    throw new Error(
      `fixture stock requires a maintenance task, received ${task?.mode ?? "missing"}`,
    );
  }
  const slots =
    task.mode === "routine_refill"
      ? (task.slots ?? [])
          .map((slot) => ({
            slotCode: slot.slotCode,
            addition: Math.max(
              0,
              (desiredBySlot.get(slot.slotCode) ?? slot.currentQuantity) -
                slot.currentQuantity,
            ),
          }))
          .filter((slot) => slot.addition > 0)
      : (task.slots ?? []).map((slot) => ({
          slotCode: slot.slotCode,
          quantity: desiredBySlot.get(slot.slotCode) ?? slot.currentQuantity,
        }));
  if (slots.length === 0) {
    throw new Error(`fixture stock ${task.mode} task has no restoring slots`);
  }
  await post("/v1/stock/maintenance-task", {
    taskId: task.taskId,
    mode: task.mode,
    slots,
  });

  const deadline = Date.now() + timeoutMs;
  let saleView = initialSaleView;
  while (Date.now() < deadline) {
    saleView = await get("/v1/sale-view");
    if (targetIsReady(saleView)) {
      return { changed: true, taskId: task.taskId, mode: task.mode };
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, pollMs));
  }
  throw new Error(
    `fixture stock did not become sale-ready after ${task.mode}: ${JSON.stringify(
      (saleView?.items ?? []).map((item) => ({
        slotCode: item.slotCode,
        slotSalesState: item.slotSalesState,
        saleableStock: item.saleableStock,
        physicalStock: item.physicalStock,
      })),
    )}`,
  );
}

export async function returnToCatalogFromClient({
  client,
  evaluateExpressionFn = evaluateExpression,
  waitForRouteFn = waitForRoute,
  activateVisibleSelectorFn = activateVisibleSelector,
  settleRouteTimeoutMs = 10_000,
}) {
  const waitForRouteWithTimeout = (
    expected,
    timeoutMs = settleRouteTimeoutMs,
  ) =>
    waitForRouteFn(client, expected, {
      timeoutMs,
      pollMs: 250,
    });
  let route = await evaluateExpressionFn(client, "location.hash");
  if (route === "#/catalog") return route;
  if (/^#\/result(?:\/|$)/.test(route)) {
    await activateVisibleSelectorFn(
      client,
      ".result-return-button, .failure-return-button",
      {
        kind: "touch",
        timeoutMs: 10_000,
      },
    );
    return (await waitForRouteWithTimeout("#/catalog")).route;
  }
  if (route === "#/checkout") {
    await activateVisibleSelectorFn(client, ".checkout-back", {
      kind: "touch",
      timeoutMs: 10_000,
    });
    await waitForRouteWithTimeout(/^#\/products(?:\/|$)/, 10_000);
    await activateVisibleSelectorFn(client, ".detail-back-button", {
      kind: "touch",
      timeoutMs: 10_000,
    });
    return (await waitForRouteWithTimeout("#/catalog")).route;
  }
  if (/^#\/products(?:\/|$)/.test(route)) {
    await activateVisibleSelectorFn(client, ".detail-back-button", {
      kind: "touch",
      timeoutMs: 10_000,
    });
    return (await waitForRouteWithTimeout("#/catalog")).route;
  }
  if (/^#\/payment(?:\/|$)/.test(route)) {
    await activateVisibleSelectorFn(client, PAYMENT_CANCEL_SELECTOR, {
      kind: "touch",
      timeoutMs: 10_000,
    });
    route = (
      await waitForRouteWithTimeout(
        /^(?:#\/catalog|#\/result(?:\/|$)|#\/checkout|#\/products(?:\/|$))/,
        PAYMENT_RETURN_WAIT_MS,
      )
    ).route;
    if (route === "#/catalog") return "#/catalog";
    if (/^#\/result(?:\/|$)/.test(route)) {
      await activateVisibleSelectorFn(
        client,
        ".result-return-button, .failure-return-button",
        {
          kind: "touch",
          timeoutMs: 10_000,
        },
      );
      return (await waitForRouteWithTimeout("#/catalog")).route;
    }
    if (route === "#/checkout") {
      await activateVisibleSelectorFn(client, ".checkout-back", {
        kind: "touch",
        timeoutMs: 10_000,
      });
      await waitForRouteWithTimeout(/^#\/products(?:\/|$)/, 10_000);
      await activateVisibleSelectorFn(client, ".detail-back-button", {
        kind: "touch",
        timeoutMs: 10_000,
      });
      return (await waitForRouteWithTimeout("#/catalog")).route;
    }
    if (/^#\/products(?:\/|$)/.test(route)) {
      await activateVisibleSelectorFn(client, ".detail-back-button", {
        kind: "touch",
        timeoutMs: 10_000,
      });
      return (await waitForRouteWithTimeout("#/catalog")).route;
    }
  }
  throw new Error(
    `no supported customer return control was available for ${route}`,
  );
}

function terminalOperations(guestInput, handoff) {
  const withClient = async (operation) => {
    const endpoint = required(handoff?.cdp?.endpoint, "handoff cdp endpoint");
    const target = await discoverMachineUiTarget({
      endpoint,
      expectedTargetId: required(
        handoff?.cdp?.targetId,
        "handoff cdp targetId",
      ),
    });
    const client = new CdpClient(
      rewriteWebSocketDebuggerUrl(target.webSocketDebuggerUrl, endpoint),
    );
    await client.connect();
    await enablePageRuntime(client);
    try {
      return await operation(client);
    } finally {
      await client.close().catch(() => undefined);
    }
  };
  return {
    captureTerminal: async (track, context) => {
      await waitForDaemonReadyRefresh(handoff);
      return captureTrackTerminalFacts({
        track,
        context,
        readRoute: () =>
          withClient((client) => evaluateExpression(client, "location.hash")),
        daemonGet: (path) => daemonGet(handoff, path),
        platformQuery: () =>
          controlPlaneRequest(guestInput, "/v1/platform/query", {
            runId: guestInput.runId,
            machineCode: guestInput.machineCode,
          }).then((response) => response.report),
      });
    },
    recover: (track, context) =>
      recoverTrackHandoff({
        track,
        terminal: context.terminal,
        fixtureAllocation: guestInput.fixtureAllocation,
        returnToCatalog: () =>
          withClient(async (client) => {
            return returnToCatalogFromClient({ client });
          }),
        disableFaultInjection: () =>
          controlPlaneRequest(guestInput, "/v1/mock-payment-create-gate/open"),
        restoreSerialSession: (sessionId) =>
          controlPlaneRequest(
            guestInput,
            `/v1/serial-sessions/${encodeURIComponent(sessionId)}/abort`,
          ),
        cancelActiveTransaction: (transaction) =>
          daemonPost(handoff, "/v1/intents/cancel-order", {
            orderNo: required(
              transaction?.orderNo,
              "active transaction orderNo",
            ),
          }),
        waitForTransactionTerminal: async () => {
          const deadline = Date.now() + 30_000;
          let transaction = null;
          while (Date.now() < deadline) {
            transaction = await daemonGet(handoff, "/v1/transactions/current");
            if (!isActiveTransaction(transaction)) return transaction;
            await new Promise((resolvePromise) =>
              setTimeout(resolvePromise, 500),
            );
          }
          return transaction;
        },
        restoreFixtureStock: async () => ({
          skipped: "independent fixture allocation",
        }),
      }),
  };
}

export async function runFullWorkflowOrchestrator(options, dependencies = {}) {
  const plan = buildWorkflowTrackCommands(options);
  const guestInput = jsonIfPresent(options.guestInputPath);
  const handoff = jsonIfPresent(options.handoffPath);
  const operations =
    dependencies.captureTerminal ||
    dependencies.recover ||
    !guestInput ||
    !handoff
      ? null
      : terminalOperations(guestInput, handoff);
  const executedTracks = await runSerialTrackLifecycle({
    tracks: plan.tracks,
    runTrack:
      dependencies.runTrack ?? ((track) => runTrack(track.command, track.key)),
    beforeTrack:
      dependencies.beforeTrack ??
      (async () => {
        const refreshed = refreshDaemonReadyHandoff({
          handoffPath: options.handoffPath,
          handoff,
        });
        await ensureFixtureStockReady({
          fixtureAllocation: guestInput.fixtureAllocation,
          daemonGet: (path) => daemonGet(refreshed, path),
          daemonPost: (path, body) => daemonPost(refreshed, path, body),
        });
      }),
    captureTerminal:
      dependencies.captureTerminal ??
      operations?.captureTerminal ??
      (() => ({
        ok: false,
        facts: null,
        reason: "terminal inputs are unavailable",
      })),
    recover:
      dependencies.recover ??
      operations?.recover ??
      (() => ({
        ok: false,
        actions: [],
        errors: ["handoff inputs are unavailable"],
      })),
    now: dependencies.now,
  });
  const evidenceManifestPath = join(
    dirname(resolve(options.outPath)),
    "full-workflow-evidence-manifest.json",
  );
  const evidenceManifest = buildFullWorkflowEvidenceManifest({
    tracks: plan.tracks.map((track) => ({
      ...track,
      result: executedTracks.find((entry) => entry.key === track.key),
    })),
  });
  writeJson(evidenceManifestPath, evidenceManifest);
  const aggregate = buildFullWorkflowAggregate({
    mode: options.mode,
    fastReportPath: plan.fastReportPath,
    ipcRecoveryReportPath: plan.ipcRecoveryReportPath,
    fulfillmentFailureReportPath: plan.fulfillmentFailureReportPath,
    scannerReportPath: plan.scannerReportPath,
    delayedPickupReportPath: plan.delayedPickupReportPath,
    visionTryOnReportPath: plan.visionTryOnReportPath,
    identity: workflowIdentity(options.guestInputPath),
    executedTracks,
    evidenceManifestPath,
  });
  writeJson(options.outPath, aggregate);
  return aggregate;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const aggregate = await runFullWorkflowOrchestrator(options);
  for (const track of aggregate.execution.executedTracks) {
    process.stdout.write(
      `track=${track.key} status=${track.businessStatus} durationMs=${track.durationMs} failureStage=${track.failureStage ?? "none"} error=${track.error ?? "none"}\n`,
    );
  }
  if (!aggregate.ok) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
