#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { validateAiRegionalEvidenceSet } from "./ai-regional-evidence.mjs";
import {
  BUSINESS_CHECK_REGISTRY,
  selectBusinessChecks,
} from "./business-check-registry.mjs";
import { waitForDaemonReadyRefresh } from "./daemon-ready-refresh.mjs";
import {
  buildFullWorkflowEvidenceManifest,
  validateFullWorkflowEvidenceManifest,
} from "./full-workflow-evidence-manifest.mjs";
import {
  buildFullWorkflowAggregate,
  validateBusinessCheckReport,
} from "./full-workflow-validator.mjs";
import {
  activateVisibleSelector,
  CdpClient,
  discoverCanonicalMachineUiTarget,
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
const CHECKOUT_EMPTY_RETURN_SELECTOR =
  '[data-test="checkout-empty-return-catalog"]:not(:disabled)';
const CHECKOUT_BACK_PRODUCT_SELECTOR =
  '[data-test="checkout-back-product"]:not(:disabled), .checkout-back';
const PRODUCT_DETAIL_RETURN_SELECTOR =
  '[data-test="product-detail-return-catalog"]:not(:disabled), .detail-back-button';
const PAYMENT_RETURN_WAIT_MS = 30_000;
const CONTROL_PLANE_TIMEOUT_MS = 10_000;
const CHILD_ERROR_TAIL_BYTES = 8 * 1024;
const DAEMON_READY_FILE =
  "C:\\ProgramData\\VEM\\vending-daemon\\daemon-ready.json";
const STOCK_READY_TIMEOUT_MS = 30_000;
const PLATFORM_STOCK_READY_TIMEOUT_MS = 30_000;
const STOCK_ATTESTATION_READY_TIMEOUT_MS = 180_000;
const HARDWARE_READY_TIMEOUT_MS = 30_000;
const RUNTIME_BARRIER_TIMEOUT_MS = 60_000;
const RUNTIME_BARRIER_POLL_MS = 1_000;

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

export async function waitForInstalledRuntimeBarrier(
  handoff,
  {
    discoverTarget = discoverCanonicalMachineUiTarget,
    timeoutMs = RUNTIME_BARRIER_TIMEOUT_MS,
    pollMs = RUNTIME_BARRIER_POLL_MS,
  } = {},
) {
  const endpoint = handoff?.cdp?.endpoint ?? "http://127.0.0.1:9222";
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const target = await discoverTarget({
        endpoint,
        timeoutMs: Math.min(5_000, Math.max(250, deadline - Date.now())),
      });
      return target;
    } catch (error) {
      lastError = error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, pollMs));
    }
  }
  throw (
    lastError ??
    new Error("Machine UI CDP target did not become available before the track")
  );
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
  haltOnRecoveryFailure = false,
  emitTrackProgress = () => undefined,
  now = () => new Date(),
}) {
  const executed = [];
  for (const track of tracks) {
    const startedAt = now().toISOString();
    emitTrackProgress({ type: "started", track, startedAt });
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
      { artifactRoot: track.artifactRoot },
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
    const recoveryFailed = recovery?.ok !== true;
    const entry = {
      key: track.key,
      reportPath: track.reportPath,
      status:
        child.status === "blocked"
          ? "blocked"
          : childFailed || terminalFailed || recoveryFailed
            ? "failed"
            : "passed",
      businessStatus:
        child.status === "blocked"
          ? "blocked"
          : childFailed || terminalFailed || recoveryFailed
            ? "failed"
            : "passed",
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
          : recoveryFailed
            ? "handoff-recovery"
            : null,
      error: childFailed
        ? child.stderr?.startsWith("track preflight failed:")
          ? shortError(child)
          : (shortError(child) ?? validation.reason)
        : terminalFailed
          ? (terminal.reason ?? "terminal facts are incomplete")
          : recoveryFailed
            ? (recovery.errors?.join("; ") ?? "handoff recovery failed")
            : null,
      terminal,
      handoffRecovery: {
        ...recovery,
        startedAt: recoveryStartedAt,
        finishedAt: recoveryFinishedAt,
        durationMs:
          Date.parse(recoveryFinishedAt) - Date.parse(recoveryStartedAt),
      },
    };
    executed.push(entry);
    emitTrackProgress({ type: "finished", track, result: entry });
    if (recoveryFailed && haltOnRecoveryFailure) break;
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

function sleepMs(milliseconds) {
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds),
  );
}

function isTransientBoundaryError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    error instanceof TypeError ||
    /fetch failed|timed out|ECONNRESET|ECONNREFUSED|socket hang up|CDP WebSocket failed to open/i.test(
      message,
    )
  );
}

async function retryTransientBoundary(
  label,
  operation,
  { timeoutMs = 10_000, pollMs = 250 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  do {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isTransientBoundaryError(error) || Date.now() >= deadline) break;
      await sleepMs(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    }
  } while (Date.now() < deadline);
  throw new Error(
    `${label} failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    { cause: lastError },
  );
}

function controlPlaneRequest(guestInput, path, body = {}) {
  const controlPlane = guestInput?.hostControlPlane;
  if (!controlPlane?.endpoint || !controlPlane?.token) {
    throw new Error(
      "guest input is missing hostControlPlane endpoint and token",
    );
  }
  return retryTransientBoundary(`host control-plane ${path}`, () =>
    boundedFetch(`${controlPlane.endpoint}${path}`, {
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
    }),
  );
}

function daemonGet(handoff, path) {
  const healthzUrl = required(
    handoff?.daemon?.ready?.healthzUrl,
    "daemon healthzUrl",
  );
  const baseUrl = healthzUrl.endsWith("/healthz")
    ? healthzUrl.slice(0, -"/healthz".length)
    : healthzUrl;
  return retryTransientBoundary(`daemon GET ${path}`, () =>
    boundedFetch(`${baseUrl}${path}`, {
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
    }),
  );
}

function daemonPost(handoff, path, body) {
  const healthzUrl = required(
    handoff?.daemon?.ready?.healthzUrl,
    "daemon healthzUrl",
  );
  const baseUrl = healthzUrl.endsWith("/healthz")
    ? healthzUrl.slice(0, -"/healthz".length)
    : healthzUrl;
  return retryTransientBoundary(`daemon POST ${path}`, () =>
    boundedFetch(`${baseUrl}${path}`, {
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
    }),
  );
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
  const hasCoordinateIdentity = (fixture) =>
    Number.isInteger(fixture?.rowNo) &&
    Number.isInteger(fixture?.cellNo) &&
    typeof fixture?.sku === "string" &&
    fixture.sku !== "";
  const fixtureKey = (fixture) =>
    hasCoordinateIdentity(fixture)
      ? `${fixture.rowNo}:${fixture.cellNo}:${fixture.sku}`
      : `slot:${fixture.slotId}`;
  const itemMatchesFixture = (item, fixture) =>
    hasCoordinateIdentity(fixture)
      ? item?.rowNo === fixture.rowNo &&
        item?.cellNo === fixture.cellNo &&
        item?.sku === fixture.sku
      : item?.slotId === fixture.slotId;
  const itemForFixture = (saleView, fixture) =>
    (saleView?.items ?? []).find((item) => itemMatchesFixture(item, fixture));
  const desiredByFixtureKey = new Map(
    fixtures.map((fixture) => [fixtureKey(fixture), fixture.onHandQty]),
  );
  if (
    desiredByFixtureKey.size === 0 ||
    fixtures.some(
      (fixture) =>
        (!hasCoordinateIdentity(fixture) &&
          (typeof fixture?.slotId !== "string" || fixture.slotId === "")) ||
        !Number.isInteger(fixture?.onHandQty),
    )
  ) {
    throw new Error("fixture stock preflight requires allocated slots");
  }

  const targetIsReady = (saleView) => {
    return fixtures.every((fixture) => {
      const item = itemForFixture(saleView, fixture);
      const desired = desiredByFixtureKey.get(fixtureKey(fixture));
      return (
        item?.slotSalesState === "sale_ready" &&
        item.saleableStock === desired &&
        item.physicalStock === desired
      );
    });
  };
  const attestationStatusSummary = (status) =>
    status
      ? {
          status: status.status,
          code: status.code,
          attestationId: status.attestationId,
          planogramVersion: status.planogramVersion,
          inconsistentSlots: status.inconsistentSlots,
        }
      : null;
  const waitForAttestationReady = async (attestationId) => {
    const attestationDeadline =
      Date.now() + Math.max(timeoutMs, STOCK_ATTESTATION_READY_TIMEOUT_MS);
    let status = null;
    while (Date.now() < attestationDeadline) {
      status = await get("/v1/stock/attestation");
      if (
        status?.status === "ready" &&
        status?.attestationId === attestationId &&
        (status?.inconsistentSlots ?? []).length === 0
      ) {
        return status;
      }
      if (
        ["failed", "rejected", "inconsistent", "stale"].includes(status?.status)
      ) {
        throw new Error(
          `fixture stock attestation did not complete: ${JSON.stringify(
            attestationStatusSummary(status),
          )}`,
        );
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, pollMs));
    }
    throw new Error(
      `fixture stock attestation did not become ready: ${JSON.stringify(
        attestationStatusSummary(status),
      )}`,
    );
  };
  const fixtureReadinessSnapshot = (saleView) =>
    fixtures.map((fixture) => {
      const item = itemForFixture(saleView, fixture);
      const desired = desiredByFixtureKey.get(fixtureKey(fixture));
      return {
        fixture: {
          slotId: fixture.slotId,
          rowNo: fixture.rowNo,
          cellNo: fixture.cellNo,
          sku: fixture.sku,
          onHandQty: fixture.onHandQty,
        },
        matched: item
          ? {
              slotId: item.slotId,
              inventoryId: item.inventoryId,
              rowNo: item.rowNo,
              cellNo: item.cellNo,
              sku: item.sku,
              slotDisplayLabel: item.slotDisplayLabel,
              slotSalesState: item.slotSalesState,
              saleableStock: item.saleableStock,
              physicalStock: item.physicalStock,
            }
          : null,
        desired,
        ready:
          item?.slotSalesState === "sale_ready" &&
          item.saleableStock === desired &&
          item.physicalStock === desired,
      };
    });
  const deadline = Date.now() + timeoutMs;
  let initialSaleView = null;
  let task = null;
  let taskError = null;
  while (Date.now() < deadline) {
    initialSaleView = await get("/v1/sale-view");
    try {
      task = await get("/v1/stock/maintenance-task");
      if (
        targetIsReady(initialSaleView) &&
        !["initial_count", "recovery_count"].includes(task?.mode)
      ) {
        return { changed: false };
      }
      break;
    } catch (error) {
      taskError = error;
      if (targetIsReady(initialSaleView)) return { changed: false };
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
  const initialFixtureItems = fixtures.map((fixture) => ({
    fixture,
    item: itemForFixture(initialSaleView, fixture),
  }));
  if (initialFixtureItems.some(({ item }) => !item?.slotId)) {
    throw new Error(
      `fixture stock preflight could not resolve current sale-view slots: ${JSON.stringify(
        fixtures.map((fixture) => ({
          rowNo: fixture.rowNo,
          cellNo: fixture.cellNo,
          sku: fixture.sku,
          slotId: fixture.slotId,
        })),
      )}`,
    );
  }
  const desiredByCurrentSlotId = new Map(
    initialFixtureItems.map(({ fixture, item }) => [
      item.slotId,
      fixture.onHandQty,
    ]),
  );
  const activeAttestationSlots = (initialSaleView?.items ?? [])
    .filter(
      (item) =>
        typeof item?.slotId === "string" &&
        item.slotId !== "" &&
        typeof item?.sku === "string" &&
        item.sku !== "",
    )
    .map((item) => ({
      slotId: item.slotId,
      sku: item.sku,
      quantity: desiredByCurrentSlotId.get(item.slotId) ?? item.physicalStock,
      enabled:
        desiredByCurrentSlotId.has(item.slotId) ||
        item.slotSalesState !== "frozen",
    }));
  const taskSlotsById = new Map(
    (task.slots ?? []).map((slot) => [slot?.slotId, slot]),
  );
  const fixtureTaskSlots = fixtures.map((fixture) => {
    const currentItem = initialFixtureItems.find(
      (entry) => entry.fixture === fixture,
    )?.item;
    const taskSlot = taskSlotsById.get(currentItem?.slotId);
    if (!taskSlot) {
      throw new Error(
        `fixture stock ${task.mode} task does not contain fixture slot R${fixture.rowNo}C${fixture.cellNo}`,
      );
    }
    return { fixture, taskSlot };
  });
  const routineRefillSlots = fixtureTaskSlots.map(({ fixture, taskSlot }) => {
    if (!Number.isInteger(taskSlot.currentQuantity)) {
      throw new Error(
        `fixture stock routine_refill task has invalid current quantity for ${fixture.slotId}`,
      );
    }
    return {
      slotId: fixture.slotId,
      addition: Math.max(0, fixture.onHandQty - taskSlot.currentQuantity),
    };
  });
  const requiresAttestation = initialFixtureItems.some(({ fixture, item }) => {
    const desired = desiredByFixtureKey.get(fixtureKey(fixture));
    return (
      item?.slotSalesState !== "sale_ready" ||
      item?.saleableStock > desired ||
      item?.physicalStock > desired
    );
  });
  let requiresFreshAttestation = false;
  if (
    task.mode === "routine_refill" &&
    (!requiresAttestation || ["pending", "complete"].includes(task.status)) &&
    routineRefillSlots.every((slot) => slot.addition === 0)
  ) {
    let projection = null;
    while (Date.now() < deadline) {
      projection = await get(
        `/v1/stock/maintenance-tasks/${encodeURIComponent(task.taskId)}/projection`,
      );
      if (
        projection?.taskId === task.taskId &&
        projection?.mode === "routine_refill"
      ) {
        const projectedSlots = new Map(
          (projection?.slots ?? []).map((slot) => [slot?.slotId, slot]),
        );
        const projectionStillNotSubmitted = fixtures.every((fixture) => {
          const currentItem = initialFixtureItems.find(
            (entry) => entry.fixture === fixture,
          )?.item;
          const slot = projectedSlots.get(currentItem?.slotId);
          return (
            slot?.syncStatus === "not_submitted" &&
            (slot?.previewQuantity === fixture.onHandQty ||
              slot?.previewQuantity === null) &&
            (slot?.submittedAddition === 0 ||
              slot?.submittedAddition === null) &&
            (slot?.platformRawMovementId === null ||
              slot?.platformRawMovementId === undefined)
          );
        });
        if (projectionStillNotSubmitted) {
          requiresFreshAttestation = true;
          break;
        }
      }
      if (projection?.status === "complete") break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, pollMs));
    }
    if (!requiresFreshAttestation) {
      const projectedSlots = new Map(
        (projection?.slots ?? []).map((slot) => [slot?.slotId, slot]),
      );
      const projectionMatchesFixtures =
        projection?.taskId === task.taskId &&
        projection?.mode === "routine_refill" &&
        projection?.status === "complete" &&
        fixtures.every((fixture) => {
          const currentItem = initialFixtureItems.find(
            (entry) => entry.fixture === fixture,
          )?.item;
          const slot = projectedSlots.get(currentItem?.slotId);
          return (
            slot?.syncStatus === "accepted" &&
            slot?.previewQuantity === fixture.onHandQty &&
            Number.isInteger(slot?.submittedAddition) &&
            slot.submittedAddition >= 0
          );
        });
      if (!projectionMatchesFixtures) {
        throw new Error(
          `fixture stock routine_refill projection does not satisfy allocated fixtures: ${JSON.stringify(projection)}`,
        );
      }
      let projectedSaleView = initialSaleView;
      while (Date.now() < deadline) {
        projectedSaleView = await get("/v1/sale-view");
        if (targetIsReady(projectedSaleView)) {
          return {
            changed: false,
            taskId: task.taskId,
            mode: task.mode,
            projection,
          };
        }
        await new Promise((resolvePromise) =>
          setTimeout(resolvePromise, pollMs),
        );
      }
      throw new Error(
        `fixture stock routine_refill projection did not become sale-ready without a positive addition: ${JSON.stringify(
          (projectedSaleView?.items ?? []).filter((item) =>
            desiredByCurrentSlotId.has(item?.slotId),
          ),
        )}`,
      );
    }
  }
  let operationMode = task.mode;
  let operationId = task.taskId;
  if (
    task.mode === "routine_refill" &&
    (requiresAttestation || requiresFreshAttestation)
  ) {
    operationMode = "physical_stock_attestation";
    operationId = `testbed-stock-recovery-${Date.now()}`;
    const slots = activeAttestationSlots;
    if (
      !initialSaleView?.planogramVersion ||
      slots.length === 0 ||
      slots.some(
        (slot) => !slot.slotId || !slot.sku || !Number.isInteger(slot.quantity),
      )
    ) {
      throw new Error("fixture stock attestation inputs are incomplete");
    }
    await post("/v1/stock/attestation", {
      attestationId: operationId,
      planogramVersion: initialSaleView.planogramVersion,
      operatorId: "testbed-orchestrator",
      slots,
    });
    await waitForAttestationReady(operationId);
  } else {
    const slots =
      task.mode === "routine_refill"
        ? routineRefillSlots.filter((slot) => slot.addition > 0)
        : (task.slots ?? []).map((slot) => ({
            slotId: slot.slotId,
            quantity:
              desiredByCurrentSlotId.get(slot.slotId) ?? slot.currentQuantity,
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
    `fixture stock did not become sale-ready after ${operationMode}: ${JSON.stringify(fixtureReadinessSnapshot(saleView))}`,
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

export async function replaceUnavailableTestbedLowerController({
  capability,
  sessionId,
  replaceSerialSession,
}) {
  const unavailable = capability?.blockers?.some(
    (blocker) => blocker?.code === "LOWER_CONTROLLER_UNAVAILABLE",
  );
  if (!unavailable) return { replaced: false };
  if (!sessionId) {
    throw new Error(
      "testbed lower controller is unavailable without a serial session",
    );
  }
  const replacement = await replaceSerialSession(sessionId);
  return { replaced: true, replacement };
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
  const returnFromProductToCatalog = async () => {
    if (
      !(await activateUnlessAlreadyCatalog(PRODUCT_DETAIL_RETURN_SELECTOR, {
        kind: "touch",
        timeoutMs: 10_000,
      }))
    )
      return "#/catalog";
    return (await waitForRouteWithTimeout("#/catalog")).route;
  };
  const returnFromCheckoutToCatalog = async () => {
    const emptyCheckoutCanReturn = await evaluateExpressionFn(
      client,
      `Boolean(document.querySelector(${JSON.stringify(CHECKOUT_EMPTY_RETURN_SELECTOR)})?.getClientRects().length)`,
    );
    if (emptyCheckoutCanReturn) {
      if (
        !(await activateUnlessAlreadyCatalog(CHECKOUT_EMPTY_RETURN_SELECTOR, {
          kind: "touch",
          timeoutMs: 10_000,
        }))
      )
        return "#/catalog";
      return (await waitForRouteWithTimeout("#/catalog")).route;
    }
    if (
      !(await activateUnlessAlreadyCatalog(CHECKOUT_BACK_PRODUCT_SELECTOR, {
        kind: "touch",
        timeoutMs: 10_000,
      }))
    )
      return "#/catalog";
    await waitForRouteWithTimeout(/^#\/products(?:\/|$)/, 10_000);
    return returnFromProductToCatalog();
  };
  let route = await evaluateExpressionFn(client, "location.hash");
  if (route === "#/catalog") return route;
  if (route === "" || route === "#" || route === "#/") {
    route = (await waitForRouteWithTimeout(/^(?:#\/boot|#\/catalog)$/, 30_000))
      .route;
    if (route === "#/catalog") return "#/catalog";
  }
  if (route === "#/boot") {
    return (await waitForRouteWithTimeout("#/catalog", 30_000)).route;
  }
  if (/^#\/result(?:\/|$)/.test(route)) {
    const activated = await activateUnlessAlreadyCatalog(
      '[data-test="result-return-catalog"]:not(:disabled)',
      {
        kind: "touch",
        timeoutMs: 10_000,
      },
    );
    if (!activated) return "#/catalog";
    return (await waitForRouteWithTimeout("#/catalog")).route;
  }
  if (route === "#/checkout") {
    return returnFromCheckoutToCatalog();
  }
  if (/^#\/products(?:\/|$)/.test(route)) {
    return returnFromProductToCatalog();
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
          '[data-test="result-return-catalog"]:not(:disabled)',
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
      return returnFromCheckoutToCatalog();
    }
    if (/^#\/products(?:\/|$)/.test(route)) {
      return returnFromProductToCatalog();
    }
  }
  if (/^#\/maintenance(?:\?|$|\/)/.test(route)) {
    if (
      !(await activateUnlessAlreadyCatalog(
        '[data-test="maintenance-return-catalog"]:not(:disabled)',
        {
          kind: "touch",
          timeoutMs: 10_000,
        },
      ))
    )
      return "#/catalog";
    return (await waitForRouteWithTimeout("#/catalog", 30_000)).route;
  }
  throw new Error(
    `no supported customer return control was available for ${route}`,
  );
}

export async function restoreCatalogHomeFromClient({
  client,
  returnToCatalogFn = returnToCatalogFromClient,
  evaluateExpressionFn = evaluateExpression,
  activateVisibleSelectorFn = activateVisibleSelector,
  waitForRouteFn = waitForRoute,
  waitForCatalogHomeStateFn = waitForCatalogHomeState,
  settleRouteTimeoutMs = 10_000,
}) {
  await returnToCatalogFn({ client });
  const categoryIsOpen = await evaluateExpressionFn(
    client,
    'Boolean(document.querySelector(".catalog-back-button"))',
  );
  if (categoryIsOpen) {
    await activateVisibleSelectorFn(client, ".catalog-back-button", {
      kind: "touch",
      timeoutMs: 10_000,
    });
  }
  await waitForRouteFn(client, "#/catalog", {
    timeoutMs: settleRouteTimeoutMs,
    pollMs: 250,
  });
  return await waitForCatalogHomeStateFn({
    client,
    evaluateExpressionFn,
    timeoutMs: settleRouteTimeoutMs,
  });
}

export async function waitForCatalogHomeState({
  client,
  evaluateExpressionFn = evaluateExpression,
  timeoutMs = 10_000,
  pollMs = 250,
}) {
  const deadline = Date.now() + timeoutMs;
  let state = null;
  do {
    state = await evaluateExpressionFn(
      client,
      `(() => ({
        homeMarkerVisible: Boolean(document.querySelector('[data-test="catalog-page"]:not([data-category-key])')),
        categoryBackVisible: Boolean(document.querySelector('.catalog-back-button')),
      }))()`,
    );
    if (
      state?.homeMarkerVisible === true &&
      state.categoryBackVisible === false
    )
      return "#/catalog";
    await new Promise((resolvePromise) => setTimeout(resolvePromise, pollMs));
  } while (Date.now() < deadline);
  throw new Error(`Catalog home did not settle: ${JSON.stringify(state)}`);
}

function terminalOperations(guestInput, handoff, handoffPath) {
  const withClient = async (operation) => {
    reloadRuntimeHandoff(handoffPath, handoff);
    const { client } = await retryTransientBoundary(
      "machine UI CDP attach",
      async () => {
        const endpoint = required(
          handoff?.cdp?.endpoint,
          "handoff cdp endpoint",
        );
        const target = await discoverCanonicalMachineUiTarget({
          endpoint,
        });
        handoff.cdp.targetId = target.id;
        writeJson(handoffPath, handoff);
        const client = new CdpClient(
          rewriteWebSocketDebuggerUrl(target.webSocketDebuggerUrl, endpoint),
        );
        try {
          await client.connect();
          await enablePageRuntime(client);
          return { client, target };
        } catch (error) {
          await client.close().catch(() => undefined);
          throw error;
        }
      },
    );
    try {
      return await operation(client);
    } finally {
      await client.close().catch(() => undefined);
    }
  };
  return {
    prepareTrack: async () => {
      const capability = await daemonGet(
        handoff,
        "/v1/sale-start-capability",
      ).catch(() => null);
      await replaceUnavailableTestbedLowerController({
        capability,
        sessionId: handoff?.commissioningSerialSession?.sessionId,
        replaceSerialSession: (sessionId) =>
          replaceSerialSessionAndUpdateHandoff({
            guestInput,
            handoff,
            handoffPath,
            sessionId,
            control: controlPlaneRequest,
          }),
      });
      await waitForBusinessHardwareReady({
        daemonGet: (path) => daemonGet(handoff, path),
      });
      await clearWholeMachineLockIfPresent({
        daemonGet: (path) => daemonGet(handoff, path),
        daemonPost: (path, body) => daemonPost(handoff, path, body),
      });
      return withClient((client) => restoreCatalogHomeFromClient({ client }));
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
        restoreFixtureStock: async (fixture) => {
          const allocation = {
            [track.fixtureKey ?? track.key]: fixture,
          };
          const daemon = await ensureFixtureStockReady({
            fixtureAllocation: allocation,
            daemonGet: (path) => daemonGet(handoff, path),
            daemonPost: (path, body) => daemonPost(handoff, path, body),
          });
          const platform = await waitForPlatformFixtureStock({
            guestInput,
            fixtureAllocation: allocation,
          });
          return { targetQuantity: fixture.onHandQty, daemon, platform };
        },
      }),
  };
}

export async function runFullWorkflowOrchestrator(options, dependencies = {}) {
  const guestInput = jsonIfPresent(options.guestInputPath);
  if (
    guestInput?.aiVirtualTryOn?.skipAiRss === true ||
    guestInput?.aiVirtualTryOn?.functional === true
  ) {
    process.env.VEM_VM_ACCEPTANCE_SKIP_AI_RSS = "1";
  }
  const plan = buildWorkflowTrackCommands(options);
  const aiBlock = guestInput?.acceptanceBlocks?.aiVirtualTryOn;
  if (typeof aiBlock === "string" && aiBlock.length > 0) {
    const aiTrack = plan.tracks.find((track) => track.key === "aiVirtualTryOn");
    if (aiTrack) {
      aiTrack.runner = null;
      aiTrack.command = null;
      aiTrack.blockedReason = aiBlock;
    }
  }
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
        await waitForInstalledRuntimeBarrier(refreshed);
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
    haltOnRecoveryFailure: options.mode === "fast",
    emitTrackProgress:
      dependencies.emitTrackProgress ??
      ((event) => {
        if (event.type === "started") {
          process.stdout.write(
            `track=${event.track.key} status=started startedAt=${event.startedAt}\n`,
          );
        } else if (event.type === "finished") {
          const track = event.result;
          process.stdout.write(
            `track=${track.key} status=${track.businessStatus} durationMs=${track.durationMs} failureStage=${track.failureStage ?? "none"} error=${track.error ?? "none"}\n`,
          );
        }
      }),
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
  const evidenceManifestBytes = readFileSync(evidenceManifestPath);
  const evidenceManifestFile = {
    byteLength: evidenceManifestBytes.byteLength,
    sha256: createHash("sha256").update(evidenceManifestBytes).digest("hex"),
  };
  const evidenceValidationErrors = [
    ...validateFullWorkflowEvidenceManifest(evidenceManifest),
    ...plan.tracks
      .filter((track) => track.key === "aiVirtualTryOn")
      .flatMap((track) => {
        const report = jsonIfPresent(track.reportPath);
        const regional =
          report?.execution?.functional === true
            ? { ok: true, reason: null }
            : validateAiRegionalEvidenceSet(
                report?.attempts,
                track.artifactRoot,
                evidenceManifest,
              );
        return regional.ok ? [] : [regional.reason];
      }),
  ];
  const aggregate = buildFullWorkflowAggregate({
    mode: options.mode,
    selectedDescriptors: plan.tracks,
    identity: workflowIdentity(options.guestInputPath, options.commit),
    executedTracks,
    evidenceManifestPath,
    evidenceManifest,
    evidenceManifestFile,
    evidenceValidationErrors,
  });
  writeJson(options.outPath, aggregate);
  return aggregate;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const aggregate = await runFullWorkflowOrchestrator(options);
  if (!aggregate.ok) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
