#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { waitForDaemonReadyRefresh } from "./daemon-ready-refresh.mjs";
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
import {
  waitForHardwareBindings,
  waitForSaleStartCapability,
} from "./scanner-payment-code-guest-full.mjs";

const TERMINAL_FAILURE_ORDER_STATUSES = new Set([
  "refund_pending",
  "refunded",
  "manual_handling",
]);

const EXPECTED_E6_PROTOCOL_SEQUENCE = Object.freeze([
  "VEND",
  "F0",
  "E5",
  "E5",
  "F1",
  "E6",
]);
const E6_WARNING_TIMING_WINDOWS_MS = Object.freeze({
  firstWarningMs: 15_000,
  secondWarningMs: 25_000,
  toleranceMs: 2_500,
});

function orderedProtocolMilestones(frames, expected) {
  const milestones = [];
  let expectedIndex = 0;
  for (const frame of frames) {
    if (frame.parsedOpcode !== expected[expectedIndex]) continue;
    milestones.push(frame);
    expectedIndex += 1;
    if (expectedIndex === expected.length) return milestones;
  }
  return null;
}

function assertWithinTolerance(actual, expected, tolerance, message) {
  const delta = actual - expected;
  if (Math.abs(delta) > tolerance) {
    throw new Error(
      `${message}: ${actual}ms (expected ${expected}ms ± ${tolerance}ms)`,
    );
  }
}

function parseIsoTimestamp(value) {
  if (typeof value !== "string") return Number.NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function required(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value.trim();
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

function windowsAbsolute(value, label) {
  const path = required(value, label);
  if (!/^[A-Za-z]:\\/.test(path) || path.includes("\0")) {
    throw new Error(`${label} must be an absolute Windows path`);
  }
  return path;
}

function localPath(path) {
  return process.platform === "win32"
    ? path
    : resolve(
        `/mnt/${path[0].toLowerCase()}/${path.slice(3).replaceAll("\\", "/")}`,
      );
}

function readJson(path) {
  return JSON.parse(readFileSync(localPath(path), "utf8"));
}

function writeJson(path, value) {
  mkdirSync(dirname(localPath(path)), { recursive: true });
  writeFileSync(localPath(path), `${JSON.stringify(value, null, 2)}\n`);
}

function rows(report, name) {
  return Array.isArray(report?.raw?.[name]) ? report.raw[name] : [];
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

function daemonGet(handoff, path) {
  return fetchJson(`${daemonBaseUrl(handoff)}${path}`, {
    headers: {
      authorization: `Bearer ${required(handoff.daemon?.ready?.ipcToken, "daemon ipcToken")}`,
    },
  });
}

function daemonPost(handoff, path, body = {}) {
  return fetchJson(`${daemonBaseUrl(handoff)}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${required(handoff.daemon?.ready?.ipcToken, "daemon ipcToken")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function control(guestInput, path, body = {}) {
  return fetchJson(
    `${required(guestInput.hostControlPlane?.endpoint, "hostControlPlane.endpoint")}${path}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${required(guestInput.hostControlPlane?.token, "hostControlPlane.token")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
}

function platform(guestInput, runId, machineCode, sessionId) {
  return control(guestInput, "/v1/platform/query", {
    runId,
    machineCode,
    ...(sessionId ? { sessionId } : {}),
  }).then((value) => value.report);
}

export async function recoverWholeMachineLockAfterFulfillmentFailure({
  guestInput,
  handoff,
  runId,
  machineCode,
  controlRequest = control,
  waitForReady = waitForDaemonReadyRefresh,
  waitForBindings = waitForHardwareBindings,
  daemonGetRequest = daemonGet,
  daemonPostRequest = daemonPost,
}) {
  const recoverySession = await controlRequest(
    guestInput,
    "/v1/serial-sessions/start",
    {
      runId,
      machineCode,
      serialScenario: "normal",
      saleCorrelationId: `sale-correlation://serial-recovery-${Date.now()}`,
      targetIdentity: required(
        guestInput.hostControlPlane?.targetIdentity,
        "hostControlPlane.targetIdentity",
      ),
      runtimeBase: required(
        guestInput.hostControlPlane?.runtimeBaseIdentity,
        "hostControlPlane.runtimeBaseIdentity",
      ),
    },
  );
  try {
    await waitForReady(handoff);
    const hardwareBindings = await waitForBindings(handoff, recoverySession);
    const selfCheck = await daemonPostRequest(
      handoff,
      "/v1/hardware/self-check",
      {},
    );
    if (selfCheck?.online !== true) {
      throw new Error(
        `lower-controller recovery self-check failed: ${JSON.stringify(selfCheck)}`,
      );
    }
    const clear = await daemonPostRequest(
      handoff,
      "/v1/maintenance/whole-machine-lock/clear",
      { operatorNote: "testbed fulfillment failure recovery" },
    );
    const capability = await daemonGetRequest(
      handoff,
      "/v1/sale-start-capability",
    );
    if (
      capability?.blockers?.some(
        (blocker) => blocker?.code === "WHOLE_MACHINE_LOCKED",
      )
    ) {
      throw new Error(
        "whole-machine lock remained after healthy controller recovery",
      );
    }
    return { hardwareBindings, selfCheck, clear, capability };
  } catch (error) {
    await controlRequest(
      guestInput,
      `/v1/serial-sessions/${recoverySession.sessionId}/abort`,
    ).catch(() => undefined);
    throw error;
  }
}

async function waitForCommand(handoff, sale, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await daemonGet(handoff, "/v1/transactions/current").catch(
      () => null,
    );
    const commandId = last?.vending?.commandId ?? last?.dispenseCommandId;
    if (
      last?.orderId === sale.orderId &&
      last?.paymentId === sale.paymentId &&
      commandId
    ) {
      return {
        orderId: last.orderId,
        paymentId: last.paymentId,
        orderNo: last.orderNo,
        vendingCommandId: commandId,
      };
    }
    await sleep(250);
  }
  throw new Error(`vending command did not appear: ${JSON.stringify(last)}`);
}

async function readPaymentSurface(client) {
  const surface = await evaluateExpression(
    client,
    `(() => {
    const el = document.querySelector("[data-installed-kiosk-sale-payment-surface]");
    return el ? { orderId: el.dataset.orderId || null, paymentId: el.dataset.paymentId || null,
      orderNo: el.dataset.orderNo || null, route: location.hash } : null;
  })()`,
  );
  if (!surface?.orderId || !surface?.paymentId || !surface?.orderNo) {
    throw new Error("required rendered payment surface hook is missing");
  }
  return surface;
}

function readUi(client) {
  return evaluateExpression(
    client,
    `(() => {
    const result = document.querySelector("[data-installed-kiosk-sale-result-surface]");
    return { route: location.hash, result: result ? { kind: result.dataset.resultKind || null,
      orderId: result.dataset.orderId || null, paymentId: result.dataset.paymentId || null,
      commandId: result.dataset.commandId || null } : null,
      trace: window.__VEM_MACHINE_RUNTIME_TRACE__ || [] };
  })()`,
  );
}

function hasBoundSuccess(value, sale) {
  if (Array.isArray(value))
    return value.some((entry) => hasBoundSuccess(entry, sale));
  if (!value || typeof value !== "object") return false;
  const result = value.result ?? value;
  if (
    (value.route === "#/result/success" || result.kind === "success") &&
    result.orderId === sale.orderId &&
    result.paymentId === sale.paymentId
  ) {
    return true;
  }
  return Object.values(value).some((entry) => hasBoundSuccess(entry, sale));
}

function inventoryQuantity(report, inventoryId) {
  return rows(report, "inventories").find((row) => row.id === inventoryId)
    ?.onHandQty;
}

export function validateSerialFulfillmentErrorEvidence(evidence) {
  const { baseline, final, sale, liveSale, serial, daemon, ui, boundaries } =
    evidence;
  const order = rows(final.platform, "orders").find(
    (row) => row.id === sale.orderId,
  );
  const payment = rows(final.platform, "payments").find(
    (row) => row.id === sale.paymentId,
  );
  const command = rows(final.platform, "commands").find(
    (row) => row.id === liveSale.vendingCommandId,
  );
  const orderItem = rows(final.platform, "orderItems").find(
    (row) => row.orderId === sale.orderId,
  );
  if (!order || !TERMINAL_FAILURE_ORDER_STATUSES.has(order.status)) {
    throw new Error(
      "authoritative order must settle as refund_pending, refunded, or manual_handling",
    );
  }
  if (!payment || !command || !orderItem?.inventoryId)
    throw new Error(
      "platform payment, order item, and vending command must retain the rendered sale binding",
    );
  if (
    serial.saleBinding?.orderId !== sale.orderId ||
    serial.saleBinding?.paymentId !== sale.paymentId ||
    serial.saleBinding?.vendingCommandId !== liveSale.vendingCommandId
  ) {
    throw new Error(
      "raw serial evidence must retain the same order, payment, and vending command binding",
    );
  }
  if (
    daemon?.orderId !== sale.orderId ||
    daemon?.paymentId !== sale.paymentId
  ) {
    throw new Error(
      "daemon evidence must retain the rendered order and payment binding",
    );
  }
  const completeBoundaryFrames = boundaries?.e6?.protocolFrames ?? [];
  const rawProtocolFrames =
    completeBoundaryFrames.length > 0
      ? completeBoundaryFrames
      : (serial.rawFrames ?? []);
  const opcodes = rawProtocolFrames.map((frame) => frame.parsedOpcode);
  const protocolFrames = rawProtocolFrames.filter((frame) =>
    ["VEND", "F0", "E5", "F1", "AF", "F2", "E6"].includes(frame.parsedOpcode),
  );
  if (!opcodes.includes("E6") || opcodes.includes("F2")) {
    throw new Error("serial failure must contain E6 and must not contain F2");
  }
  const protocolMilestones = orderedProtocolMilestones(
    protocolFrames,
    EXPECTED_E6_PROTOCOL_SEQUENCE,
  );
  if (!protocolMilestones) {
    throw new Error(
      `serial failure raw protocol must contain ${EXPECTED_E6_PROTOCOL_SEQUENCE.join(" -> ")}`,
    );
  }

  const f0 = protocolMilestones.find((frame) => frame.parsedOpcode === "F0");
  const e5 = protocolMilestones.filter((frame) => frame.parsedOpcode === "E5");
  const f1 = protocolMilestones.find((frame) => frame.parsedOpcode === "F1");
  const f0At = parseIsoTimestamp(f0?.capturedAt);
  const firstE5At = parseIsoTimestamp(e5[0]?.capturedAt);
  const secondE5At = parseIsoTimestamp(e5[1]?.capturedAt);
  if (
    Number.isNaN(f0At) ||
    Number.isNaN(firstE5At) ||
    Number.isNaN(secondE5At) ||
    !f1
  ) {
    throw new Error(
      "serial failure must include timestamped F0, E5, and F1 frames",
    );
  }
  assertWithinTolerance(
    firstE5At - f0At,
    E6_WARNING_TIMING_WINDOWS_MS.firstWarningMs,
    E6_WARNING_TIMING_WINDOWS_MS.toleranceMs,
    "first pickup timeout warning timing must be within the timeout window",
  );
  assertWithinTolerance(
    secondE5At - f0At,
    E6_WARNING_TIMING_WINDOWS_MS.secondWarningMs,
    E6_WARNING_TIMING_WINDOWS_MS.toleranceMs,
    "second pickup timeout warning timing must be within the timeout window",
  );
  if (
    rows(final.platform, "movements").some(
      (row) => row.orderNo === sale.orderNo,
    )
  ) {
    throw new Error(
      "dispense_succeeded movement must not exist for the failed sale",
    );
  }
  const baselineQuantity = inventoryQuantity(
    baseline.platform,
    orderItem.inventoryId,
  );
  const finalQuantity = inventoryQuantity(
    final.platform,
    orderItem.inventoryId,
  );
  if (
    !Number.isInteger(baselineQuantity) ||
    !Number.isInteger(finalQuantity) ||
    baselineQuantity !== finalQuantity
  ) {
    throw new Error("failed fulfillment must have stock delta 0");
  }
  if (
    ui?.route !== "#/result/dispense_failed" ||
    ui?.result?.kind === "success" ||
    hasBoundSuccess(ui?.trace, sale)
  )
    throw new Error(
      "customer UI must end on dispense_failed for the failed sale",
    );
  return {
    orderStatus: order.status,
    paymentId: payment.id,
    commandId: command.id,
    inventoryDelta: 0,
  };
}

export function parseSerialFulfillmentErrorGuestArgs(args) {
  if (required(option(args, "mode"), "--mode") !== "full")
    throw new Error("--mode must be full");
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

export async function runSerialFulfillmentErrorGuest(options) {
  let guestInput;
  let handoff;
  let client;
  let session;
  let sale;
  let liveSale;
  let cleaned = false;
  let stage = "read-input";
  const checkpoints = [];
  const report = {
    schemaVersion: "vem-serial-fulfillment-error-guest-full/v1",
    ok: false,
    handoffSerialSessionId: null,
    mode: options.mode,
    evidence: { checkpoints },
  };
  const screenshotSink = ({ bytes, label }) => {
    const path = join(
      dirname(localPath(options.outPath)),
      "serial-fulfillment-error-artifacts",
      `${label}.png`,
    );
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    return { ref: path };
  };
  const snapshot = async (label) => {
    if (!client) return;
    const checkpoint = await captureCheckpoint(client, label, {
      screenshot: true,
      screenshotSink,
    }).catch((error) => ({ label, error: String(error) }));
    checkpoints.push(checkpoint);
    report.evidence.ui = await readUi(client).catch((error) => ({
      error: String(error),
    }));
  };
  const cleanup = async () => {
    if (!session || cleaned) return;
    cleaned = true;
    const path = `/v1/serial-sessions/${session.sessionId}/${liveSale ? "stop" : "abort"}`;
    const body = liveSale
      ? {
          orderId: liveSale.orderId,
          paymentId: liveSale.paymentId,
          vendingCommandId: liveSale.vendingCommandId,
        }
      : {};
    report.cleanup = await control(guestInput, path, body).catch((error) => ({
      error: String(error),
    }));
  };
  try {
    guestInput = readJson(options.guestInputPath);
    handoff = readJson(options.handoffPath);
    const runId = required(guestInput.runId, "runId");
    const machineCode = required(guestInput.machineCode, "machineCode");
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
    report.runId = runId;
    report.machineCode = machineCode;
    report.evidence.baseline = {
      platform: await platform(guestInput, runId, machineCode),
    };
    stage = "start-e6-host-serial-session";
    session = await control(guestInput, "/v1/serial-sessions/start", {
      runId,
      machineCode,
      serialScenario: "e6",
      saleCorrelationId: `sale-correlation://serial-e6-${Date.now()}`,
      targetIdentity: required(
        guestInput.hostControlPlane?.targetIdentity,
        "hostControlPlane.targetIdentity",
      ),
      runtimeBase: required(
        guestInput.hostControlPlane?.runtimeBaseIdentity,
        "hostControlPlane.runtimeBaseIdentity",
      ),
    });
    report.handoffSerialSessionId = required(
      session?.sessionId,
      "fulfillment recovery serial session id",
    );
    await waitForDaemonReadyRefresh(handoff);
    stage = "await-daemon-binding-and-capability";
    report.evidence.hardwareBindings = await waitForHardwareBindings(
      handoff,
      session,
    );
    report.evidence.saleStartCapability = await waitForSaleStartCapability(
      (path) => daemonGet(handoff, path),
      { paymentOptionKey: "mock:mock" },
    );
    stage = "physical-tauri-payment";
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
        '[data-test="payment-option"][data-payment-option-key="mock:mock"]:not(:disabled)',
        "#/checkout",
      ],
    ]) {
      await activateVisibleSelector(client, step[0], {
        kind: "touch",
        timeoutMs: 30_000,
      });
      await waitForRoute(client, step[1], { timeoutMs: 30_000, pollMs: 250 });
    }
    await activateVisibleSelector(client, '[data-test="checkout-submit"]', {
      kind: "touch",
      timeoutMs: 30_000,
    });
    await waitForRoute(client, /^#\/payment/, {
      timeoutMs: 30_000,
      pollMs: 250,
    });
    sale = await readPaymentSurface(client);
    report.sale = sale;
    await snapshot("payment-before-e6");
    stage = "complete-physical-payment";
    const completed = await fetchJson(
      `${required(guestInput.runtimeBootstrap?.provisioningApiBaseUrl, "runtimeBootstrap.provisioningApiBaseUrl").replace(/\/+$/, "")}/payments/mock/${encodeURIComponent(required((await daemonGet(handoff, "/v1/transactions/current")).paymentNo, "paymentNo"))}/complete`,
      { method: "POST", headers: { "content-type": "application/json" } },
    );
    report.paymentCompletion = completed;
    liveSale = await waitForCommand(handoff, sale);
    await control(
      guestInput,
      `/v1/serial-sessions/${session.sessionId}/bind-sale`,
      liveSale,
    );
    stage = "e6-serial-boundaries";
    report.evidence.boundaries = {
      vend: await control(
        guestInput,
        `/v1/serial-sessions/${session.sessionId}/wait-frame`,
        { parsedOpcode: "VEND", timeoutMs: 30_000 },
      ),
      releaseF0: await control(
        guestInput,
        `/v1/serial-sessions/${session.sessionId}/release-f0`,
      ),
      f0: await control(
        guestInput,
        `/v1/serial-sessions/${session.sessionId}/wait-frame`,
        { parsedOpcode: "F0", timeoutMs: 30_000 },
      ),
    };
    report.evidence.daemon = await daemonGet(
      handoff,
      "/v1/transactions/current",
    );
    report.evidence.boundaries.e6 = await control(
      guestInput,
      `/v1/serial-sessions/${session.sessionId}/wait-frame`,
      { parsedOpcode: "E6", timeoutMs: 50_000 },
    );
    await waitForRoute(client, "#/result/dispense_failed", {
      timeoutMs: 30_000,
      pollMs: 250,
    });
    report.evidence.resultUi = await readUi(client).catch((error) => ({
      error: String(error),
    }));
    const canReturnToCatalog = await evaluateExpression(
      client,
      `document.querySelector(".failure-return-button") !== null`,
    );
    if (canReturnToCatalog) {
      report.evidence.failureReturnAttempts = [];
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const activation = await activateVisibleSelector(
          client,
          ".failure-return-button",
          {
            kind: "touch",
            timeoutMs: 10_000,
          },
        );
        let route = null;
        try {
          route = (
            await waitForRoute(client, "#/catalog", {
              timeoutMs: 2_000,
              pollMs: 100,
            })
          ).route;
        } catch {
          route = await evaluateExpression(client, "location.hash");
        }
        report.evidence.failureReturnAttempts.push({
          attempt,
          activation,
          route,
        });
        if (route === "#/catalog") break;
      }
      await waitForRoute(client, "#/catalog", {
        timeoutMs: 10_000,
        pollMs: 100,
      });
    }
    stage = "wait-authoritative-recovery";
    const deadline = Date.now() + 60_000;
    do {
      report.evidence.final = {
        platform: await platform(
          guestInput,
          runId,
          machineCode,
          session.sessionId,
        ),
      };
      const order = rows(report.evidence.final.platform, "orders").find(
        (row) => row.id === sale.orderId,
      );
      if (TERMINAL_FAILURE_ORDER_STATUSES.has(order?.status)) break;
      await sleep(500);
    } while (Date.now() < deadline);
    report.evidence.finalDaemon = await daemonGet(
      handoff,
      "/v1/transactions/current",
    ).catch(() => null);
    report.evidence.serial = await control(
      guestInput,
      `/v1/serial-sessions/${session.sessionId}/evidence`,
    );
    report.evidence.platformLog = await control(
      guestInput,
      `/v1/serial-sessions/${session.sessionId}/platform-log`,
    ).catch((error) => ({ error: String(error) }));
    await snapshot("e6-terminal");
    report.assertions = validateSerialFulfillmentErrorEvidence({
      baseline: report.evidence.baseline,
      final: report.evidence.final,
      sale,
      liveSale,
      serial: report.evidence.serial,
      boundaries: report.evidence.boundaries,
      daemon: report.evidence.daemon,
      ui: report.evidence.resultUi,
    });
    stage = "recover-whole-machine-lock";
    await cleanup();
    report.evidence.wholeMachineLockRecovery =
      await recoverWholeMachineLockAfterFulfillmentFailure({
        guestInput,
        handoff,
        runId,
        machineCode,
      });
    report.ok = true;
    stage = "complete";
  } catch (error) {
    report.stage = stage;
    report.error = error instanceof Error ? error.message : String(error);
    if (guestInput && report.runId && report.machineCode) {
      report.evidence.failurePlatform = await platform(
        guestInput,
        report.runId,
        report.machineCode,
        session?.sessionId,
      ).catch((failure) => ({ error: String(failure) }));
    }
    if (handoff)
      report.evidence.failureDaemon = await daemonGet(
        handoff,
        "/v1/transactions/current",
      ).catch((failure) => ({ error: String(failure) }));
    if (guestInput && session)
      report.evidence.failureSerial = await control(
        guestInput,
        `/v1/serial-sessions/${session.sessionId}/evidence`,
      ).catch((failure) => ({ error: String(failure) }));
    await snapshot("failure");
    throw error;
  } finally {
    await cleanup();
    writeJson(options.outPath, report);
    await client?.close().catch(() => undefined);
  }
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runSerialFulfillmentErrorGuest(
    parseSerialFulfillmentErrorGuestArgs(process.argv.slice(2)),
  ).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
