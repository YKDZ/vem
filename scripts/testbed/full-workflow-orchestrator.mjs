#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  BUSINESS_CHECK_REGISTRY,
  selectBusinessChecks,
} from "./business-check-registry.mjs";
import { waitForDaemonReadyRefresh } from "./daemon-ready-refresh.mjs";
import { buildFullWorkflowEvidenceManifest } from "./full-workflow-evidence-manifest.mjs";
import {
  buildFullWorkflowAggregate,
  validateBusinessCheckReport,
} from "./full-workflow-validator.mjs";
import {
  activateVisibleSelector,
  CdpClient,
  discoverMachineUiTarget,
  enablePageRuntime,
  evaluateExpression,
  rewriteWebSocketDebuggerUrl,
  waitForRoute,
} from "./machine-ui-cdp-driver.mjs";
import { replaceSerialSessionAndUpdateHandoff } from "./serial-session-handoff.mjs";
import {
  isActiveTransaction,
  captureTrackTerminalFacts,
  recoverTrackHandoff,
} from "./track-handoff-recovery.mjs";

export { replaceSerialSessionAndUpdateHandoff } from "./serial-session-handoff.mjs";

const PAYMENT_CANCEL_SELECTOR = '[data-test="payment-cancel"]:not(:disabled)';
const PAYMENT_RETURN_WAIT_MS = 30_000;
const CONTROL_PLANE_TIMEOUT_MS = 10_000;
const CHILD_ERROR_TAIL_BYTES = 8 * 1024;
const DAEMON_READY_FILE =
  "C:\\ProgramData\\VEM\\vending-daemon\\daemon-ready.json";
const STOCK_READY_TIMEOUT_MS = 30_000;
const PLATFORM_STOCK_READY_TIMEOUT_MS = 30_000;
const HARDWARE_READY_TIMEOUT_MS = 30_000;

// This is the one canonical registry for business acceptance.
export const FULL_WORKFLOW_TRACK_DESCRIPTORS = BUSINESS_CHECK_REGISTRY;

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

function repeatableOption(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== `--${name}`) continue;
    values.push(required(args[index + 1], name));
    index += 1;
  }
  return values;
}

function parseArgs(args) {
  const mode = option(args, "mode");
  if (!["fast", "full"].includes(mode))
    throw new Error("--mode must be fast or full");
  const commit = args.includes("--commit") ? option(args, "commit") : null;
  if (commit && !/^[0-9a-f]{40}$/i.test(commit)) {
    throw new Error("--commit must be a full 40-character Git SHA");
  }
  return {
    mode,
    focus: repeatableOption(args, "focus"),
    commit: commit?.toLowerCase() ?? null,
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

function clearTrackReport(path) {
  if (typeof path !== "string" || path.trim() === "") return;
  rmSync(path, { force: true });
}

function workflowIdentity(guestInputPath, commit = null) {
  const identity = jsonIfPresent(guestInputPath)?.workflowIdentity ?? null;
  return commit ? { ...identity, githubSha: commit } : identity;
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

export function reloadRuntimeHandoff(handoffPath, handoff) {
  const current = jsonIfPresent(handoffPath);
  if (!current) throw new Error("runtime handoff is unavailable");
  Object.assign(handoff, current);
  return handoff;
}

function commandForTrack(track, { mode, guestInputPath, handoffPath }) {
  if (!track.runner) return null;
  if (track.runner.kind === "powershell") {
    return [
      "pwsh",
      "-NoProfile",
      "-NonInteractive",
      "-File",
      track.runner.script,
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
    track.runner.script,
    ...(track.runner.args.length ? track.runner.args : ["--mode", mode]),
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
  focus = [],
  guestInputPath,
  handoffPath,
  outPath,
}) {
  const root = dirname(resolve(outPath));
  const tracks = selectBusinessChecks({ mode, focus }).map((descriptor) => {
    const runner = descriptor.runner;
    const track = {
      ...descriptor,
      key: descriptor.name,
      reportPath: runner ? join(root, runner.reportFileName) : null,
      artifactRoot: runner ? join(root, runner.artifactDirectory) : null,
    };
    return {
      ...track,
      command: commandForTrack(track, { mode, guestInputPath, handoffPath }),
    };
  });
  return { tracks };
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
      if (!track.runner) {
        child = {
          status: "blocked",
          exitCode: null,
          stderr: track.blockedReason,
          report: null,
        };
      } else {
        // A report is valid only when produced by this invocation.
        clearTrackReport(track.reportPath);
        await beforeTrack(track);
        child = await executeTrack(track);
      }
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
    const validation = validateBusinessCheckReport(
      track,
      report,
      track.reportPath,
    );
    const childFailed =
      child.status !== "passed" || validation.status !== "passed";
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
      validator: validation,
      startedAt,
      finishedAt,
      durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
      failureStage: childFailed
        ? "child"
        : terminalFailed
          ? "terminal-state"
          : null,
      error: childFailed
        ? child.stderr?.startsWith("track preflight failed:")
          ? shortError(child)
          : (shortError(child) ?? validation.reason)
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

function unwrapServiceApiEnvelope(payload) {
  if (
    payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    payload.code === 0 &&
    Object.hasOwn(payload, "data")
  ) {
    return payload.data;
  }
  return payload;
}

async function serviceApiRequest(guestInput, path, options = {}) {
  const baseUrl = required(
    guestInput?.runtimeBootstrap?.provisioningApiBaseUrl,
    "runtime bootstrap provisioning API base URL",
  ).replace(/\/+$/, "");
  const response = await boundedFetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.body ? { "content-type": "application/json" } : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.code !== 0) {
    throw new Error(
      `${options.method ?? "GET"} ${path} returned HTTP ${response.status}: ${JSON.stringify(payload)}`,
    );
  }
  return unwrapServiceApiEnvelope(payload);
}

export async function waitForPlatformFixtureStock({
  guestInput,
  fixtureAllocation,
  request = serviceApiRequest,
  timeoutMs = PLATFORM_STOCK_READY_TIMEOUT_MS,
  pollMs = 250,
}) {
  const fixtures = Object.values(fixtureAllocation ?? {});
  if (fixtures.length === 0) {
    throw new Error("platform fixture stock wait requires allocated slots");
  }
  const login = await request(guestInput, "/auth/login", {
    method: "POST",
    body: {
      username: required(
        guestInput?.serviceApi?.adminUsername,
        "service API admin username",
      ),
      password: required(
        guestInput?.serviceApi?.adminPassword,
        "service API admin password",
      ),
    },
  });
  const token = required(login?.accessToken, "service API access token");
  const deadline = Date.now() + timeoutMs;
  let last = [];
  while (Date.now() < deadline) {
    const page = await request(guestInput, "/inventories?page=1&pageSize=100", {
      token,
    });
    last = fixtures.map((fixture) => {
      const inventory = (page?.items ?? []).find(
        (entry) => entry?.id === fixture.inventoryId,
      );
      return {
        inventoryId: fixture.inventoryId,
        expectedOnHandQty: fixture.onHandQty,
        onHandQty: inventory?.onHandQty ?? null,
        reservedQty: inventory?.reservedQty ?? null,
      };
    });
    if (
      last.every(
        (entry) =>
          entry.onHandQty === entry.expectedOnHandQty &&
          entry.reservedQty === 0,
      )
    ) {
      return { inventories: last };
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, pollMs));
  }
  throw new Error(
    `platform fixture stock did not settle before business assertions: ${JSON.stringify(last)}`,
  );
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
  const deadline = Date.now() + timeoutMs;
  let initialSaleView = null;
  let task = null;
  let taskError = null;
  while (Date.now() < deadline) {
    initialSaleView = await get("/v1/sale-view");
    if (targetIsReady(initialSaleView)) return { changed: false };
    try {
      task = await get("/v1/stock/maintenance-task");
      break;
    } catch (error) {
      taskError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, pollMs));
  }
  if (!task) {
    throw new Error(
      `fixture stock maintenance task did not become available: ${
        taskError instanceof Error ? taskError.message : String(taskError)
      }`,
    );
  }
  if (
    !["initial_count", "recovery_count", "routine_refill"].includes(task?.mode)
  ) {
    throw new Error(
      `fixture stock requires a maintenance task, received ${task?.mode ?? "missing"}`,
    );
  }
  const initialBySlot = new Map(
    (initialSaleView?.items ?? []).map((item) => [item.slotCode, item]),
  );
  const requiresCount = [...desiredBySlot.keys()].some(
    (slotCode) => initialBySlot.get(slotCode)?.slotSalesState !== "sale_ready",
  );
  let operationMode = task.mode;
  let operationId = task.taskId;
  if (task.mode === "routine_refill" && requiresCount) {
    operationMode = "physical_stock_attestation";
    operationId = `testbed-stock-recovery-${Date.now()}`;
    const slots = (initialSaleView?.items ?? []).map((item) => ({
      slotId: item.slotId,
      slotCode: item.slotCode,
      sku: item.sku,
      quantity: desiredBySlot.get(item.slotCode) ?? item.physicalStock,
      enabled: true,
    }));
    if (
      !initialSaleView?.planogramVersion ||
      slots.length === 0 ||
      slots.some((slot) => !slot.slotId || !slot.slotCode || !slot.sku)
    ) {
      throw new Error("fixture stock attestation inputs are incomplete");
    }
    await post("/v1/stock/attestation", {
      attestationId: operationId,
      planogramVersion: initialSaleView.planogramVersion,
      operatorId: "testbed-orchestrator",
      slots,
    });
  } else {
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
  }

  let saleView = initialSaleView;
  while (Date.now() < deadline) {
    saleView = await get("/v1/sale-view");
    if (targetIsReady(saleView)) {
      return { changed: true, taskId: operationId, mode: operationMode };
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, pollMs));
  }
  throw new Error(
    `fixture stock did not become sale-ready after ${operationMode}: ${JSON.stringify(
      (saleView?.items ?? []).map((item) => ({
        slotCode: item.slotCode,
        slotSalesState: item.slotSalesState,
        saleableStock: item.saleableStock,
        physicalStock: item.physicalStock,
      })),
    )}`,
  );
}

export function fixtureAllocationForTrack(fixtureAllocation, track) {
  const fixture = fixtureAllocation?.[track?.fixtureKey];
  return fixture ? { [track.fixtureKey]: fixture } : null;
}

export async function clearWholeMachineLockIfPresent({
  daemonGet: get,
  daemonPost: post,
}) {
  const capability = await get("/v1/sale-start-capability");
  const locked = capability?.blockers?.some(
    (blocker) => blocker?.code === "WHOLE_MACHINE_LOCKED",
  );
  if (!locked) return { cleared: false };
  await post("/v1/hardware/self-check", {});
  const result = await post("/v1/maintenance/whole-machine-lock/clear", {
    operatorNote: "testbed business-set handoff recovery",
  });
  const refreshed = await get("/v1/sale-start-capability");
  if (
    refreshed?.blockers?.some(
      (blocker) => blocker?.code === "WHOLE_MACHINE_LOCKED",
    )
  ) {
    throw new Error("whole-machine lock remained after production recovery");
  }
  return { cleared: true, result };
}

export async function waitForBusinessHardwareReady({
  daemonGet: get,
  timeoutMs = HARDWARE_READY_TIMEOUT_MS,
  pollMs = 250,
}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const [bindings, capability] = await Promise.all([
      get("/v1/hardware-bindings").catch(() => null),
      get("/v1/sale-start-capability").catch(() => null),
    ]);
    const lower = bindings?.roles?.find(
      (role) => role?.role === "lower_controller",
    );
    last = { lower, capability };
    if (lower?.ready === true && capability?.canStartSale === true) return last;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, pollMs));
  }
  throw new Error(
    `business hardware did not become ready: ${JSON.stringify(last)}`,
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
  const activateUnlessAlreadyCatalog = async (selector, options) => {
    try {
      await activateVisibleSelectorFn(client, selector, options);
      return true;
    } catch (error) {
      if (
        (await evaluateExpressionFn(client, "location.hash")) === "#/catalog"
      ) {
        return false;
      }
      throw error;
    }
  };
  let route = await evaluateExpressionFn(client, "location.hash");
  if (route === "#/catalog") return route;
  if (route === "#/boot") {
    return (await waitForRouteWithTimeout("#/catalog", 30_000)).route;
  }
  if (/^#\/result(?:\/|$)/.test(route)) {
    const activated = await activateUnlessAlreadyCatalog(
      ".result-return-button, .failure-return-button",
      {
        kind: "touch",
        timeoutMs: 10_000,
      },
    );
    if (!activated) return "#/catalog";
    return (await waitForRouteWithTimeout("#/catalog")).route;
  }
  if (route === "#/checkout") {
    if (
      !(await activateUnlessAlreadyCatalog(".checkout-back", {
        kind: "touch",
        timeoutMs: 10_000,
      }))
    )
      return "#/catalog";
    await waitForRouteWithTimeout(/^#\/products(?:\/|$)/, 10_000);
    if (
      !(await activateUnlessAlreadyCatalog(".detail-back-button", {
        kind: "touch",
        timeoutMs: 10_000,
      }))
    )
      return "#/catalog";
    return (await waitForRouteWithTimeout("#/catalog")).route;
  }
  if (/^#\/products(?:\/|$)/.test(route)) {
    if (
      !(await activateUnlessAlreadyCatalog(".detail-back-button", {
        kind: "touch",
        timeoutMs: 10_000,
      }))
    )
      return "#/catalog";
    return (await waitForRouteWithTimeout("#/catalog")).route;
  }
  if (/^#\/payment(?:\/|$)/.test(route)) {
    try {
      if (
        !(await activateUnlessAlreadyCatalog(PAYMENT_CANCEL_SELECTOR, {
          kind: "touch",
          timeoutMs: 2_000,
        }))
      )
        return "#/catalog";
    } catch (error) {
      const projected = await waitForRouteWithTimeout(
        /^(?:#\/catalog|#\/result(?:\/|$)|#\/checkout|#\/products(?:\/|$))/,
        10_000,
      ).catch(() => null);
      if (!projected) throw error;
      route = projected.route;
    }
    if (/^#\/payment(?:\/|$)/.test(route)) {
      route = (
        await waitForRouteWithTimeout(
          /^(?:#\/catalog|#\/result(?:\/|$)|#\/checkout|#\/products(?:\/|$))/,
          PAYMENT_RETURN_WAIT_MS,
        )
      ).route;
    }
    if (route === "#/catalog") return "#/catalog";
    if (/^#\/result(?:\/|$)/.test(route)) {
      if (
        !(await activateUnlessAlreadyCatalog(
          ".result-return-button, .failure-return-button",
          {
            kind: "touch",
            timeoutMs: 10_000,
          },
        ))
      )
        return "#/catalog";
      return (await waitForRouteWithTimeout("#/catalog")).route;
    }
    if (route === "#/checkout") {
      if (
        !(await activateUnlessAlreadyCatalog(".checkout-back", {
          kind: "touch",
          timeoutMs: 10_000,
        }))
      )
        return "#/catalog";
      await waitForRouteWithTimeout(/^#\/products(?:\/|$)/, 10_000);
      if (
        !(await activateUnlessAlreadyCatalog(".detail-back-button", {
          kind: "touch",
          timeoutMs: 10_000,
        }))
      )
        return "#/catalog";
      return (await waitForRouteWithTimeout("#/catalog")).route;
    }
    if (/^#\/products(?:\/|$)/.test(route)) {
      if (
        !(await activateUnlessAlreadyCatalog(".detail-back-button", {
          kind: "touch",
          timeoutMs: 10_000,
        }))
      )
        return "#/catalog";
      return (await waitForRouteWithTimeout("#/catalog")).route;
    }
  }
  throw new Error(
    `no supported customer return control was available for ${route}`,
  );
}

export async function refreshCatalogPageFromClient({
  client,
  returnToCatalogFn = returnToCatalogFromClient,
  waitForRouteFn = waitForRoute,
}) {
  await returnToCatalogFn({ client });
  await client.send("Page.reload", { ignoreCache: true });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  return waitForRouteFn(client, "#/catalog", {
    timeoutMs: 20_000,
    pollMs: 250,
  });
}

function terminalOperations(guestInput, handoff, handoffPath) {
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
    prepareTrack: async () => {
      await waitForBusinessHardwareReady({
        daemonGet: (path) => daemonGet(handoff, path),
      });
      await clearWholeMachineLockIfPresent({
        daemonGet: (path) => daemonGet(handoff, path),
        daemonPost: (path, body) => daemonPost(handoff, path, body),
      });
      return withClient((client) => refreshCatalogPageFromClient({ client }));
    },
    captureTerminal: async (track, context) => {
      reloadRuntimeHandoff(handoffPath, handoff);
      refreshDaemonReadyHandoff({ handoffPath, handoff });
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
        recoverAfterFailure:
          context.child?.status !== "passed" || context.report?.ok !== true,
        fixtureAllocation: guestInput.fixtureAllocation,
        returnToCatalog: () =>
          withClient(async (client) => {
            return returnToCatalogFromClient({ client });
          }),
        disableFaultInjection: () =>
          controlPlaneRequest(guestInput, "/v1/mock-payment-create-gate/open"),
        restoreSerialSession: (sessionId) =>
          replaceSerialSessionAndUpdateHandoff({
            guestInput,
            handoff,
            handoffPath,
            sessionId,
            control: controlPlaneRequest,
          }),
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
        readLateTransaction: async () => {
          const deadline = Date.now() + 2_000;
          let transaction = null;
          do {
            transaction = await daemonGet(handoff, "/v1/transactions/current");
            if (isActiveTransaction(transaction)) return transaction;
            await new Promise((resolvePromise) =>
              setTimeout(resolvePromise, 100),
            );
          } while (Date.now() < deadline);
          return transaction;
        },
        selfCheckHardware: () =>
          daemonPost(handoff, "/v1/hardware/self-check", {}),
        clearWholeMachineLock: (operatorNote) =>
          daemonPost(handoff, "/v1/maintenance/whole-machine-lock/clear", {
            operatorNote,
          }),
        wholeMachineLockOperatorNote: "testbed business-set handoff recovery",
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
      : terminalOperations(guestInput, handoff, options.handoffPath);
  const executedTracks = await runSerialTrackLifecycle({
    tracks: plan.tracks,
    runTrack:
      dependencies.runTrack ?? ((track) => runTrack(track.command, track.key)),
    beforeTrack:
      dependencies.beforeTrack ??
      (async (track) => {
        await waitForDaemonReadyRefresh(handoff);
        const refreshed = refreshDaemonReadyHandoff({
          handoffPath: options.handoffPath,
          handoff,
        });
        await operations?.prepareTrack();
        const fixtureAllocation = fixtureAllocationForTrack(
          guestInput.fixtureAllocation,
          track,
        );
        if (fixtureAllocation) {
          await ensureFixtureStockReady({
            fixtureAllocation,
            daemonGet: (path) => daemonGet(refreshed, path),
            daemonPost: (path, body) => daemonPost(refreshed, path, body),
          });
          await waitForPlatformFixtureStock({
            guestInput,
            fixtureAllocation,
          });
        }
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
    selectedDescriptors: plan.tracks,
    identity: workflowIdentity(options.guestInputPath, options.commit),
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
