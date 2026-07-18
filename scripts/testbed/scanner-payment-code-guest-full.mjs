#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
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
import { buildInstalledKioskSaleScenarioSteps } from "./installed-kiosk-sale-acceptance.mjs";

const MODES = new Set(["full"]);
const DEFAULT_VALID_SCANNER_CODE = "621234567890123456\r\n";
const MALFORMED_SCANNER_BYTES = Buffer.from([
  0x36, 0x32, 0x31, 0x32, 0xff, 0x62, 0x61, 0x64, 0x0d, 0x0a,
]);
const TIMEOUT_PARTIAL_SCANNER_BYTES = Buffer.from(
  "621234567890123456",
  "utf8",
);

export function scannerFrameBytes(value = DEFAULT_VALID_SCANNER_CODE) {
  const bytes = Buffer.isBuffer(value)
    ? Buffer.from(value)
    : typeof value === "string"
      ? Buffer.from(value, "utf8")
      : null;
  if (!bytes || bytes.length <= 2 || !bytes.subarray(-2).equals(Buffer.from("\r\n"))) {
    throw new Error("scannerAcceptance.validCode must end with exactly one CRLF frame suffix");
  }
  const body = bytes.subarray(0, -2);
  if (body.includes(0x0d) || body.includes(0x0a)) {
    throw new Error("scannerAcceptance.validCode must contain exactly one trailing CRLF frame suffix");
  }
  return bytes;
}

function required(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function windowsAbsolute(value, label) {
  const path = required(value, label);
  if (!/^[A-Za-z]:\\/.test(path) || path.includes("\0")) {
    throw new Error(`${label} must be an absolute Windows path`);
  }
  return path;
}

function option(args, name) {
  const index = args.indexOf(`--${name}`);
  const value = index === -1 ? undefined : args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`--${name} requires a value`);
  }
  return value;
}

function localPath(path) {
  return process.platform === "win32"
    ? path
    : resolve(`/mnt/${path[0].toLowerCase()}/${path.slice(3).replaceAll("\\", "/")}`);
}

function readJson(path, label) {
  return JSON.parse(readFileSync(localPath(path), "utf8"));
}

function writeJson(path, value) {
  mkdirSync(dirname(localPath(path)), { recursive: true });
  writeFileSync(localPath(path), `${JSON.stringify(value, null, 2)}\n`);
}

function rows(raw, key) {
  return Array.isArray(raw?.[key]) ? raw[key] : [];
}

function paymentRowsByOrder(report, orderId) {
  return rows(report?.raw, "payments").filter((entry) => entry.orderId === orderId);
}

function attemptRowsByOrder(report, orderId) {
  return rows(report?.raw, "paymentCodeAttempts").filter(
    (entry) => entry.orderId === orderId,
  );
}

function movementRowsByOrderNo(report, orderNo) {
  return rows(report?.raw, "movements").filter((entry) => entry.orderNo === orderNo);
}

function daemonBaseUrl(handoff) {
  const healthzUrl = required(handoff.daemon?.ready?.healthzUrl, "daemon healthzUrl");
  if (!healthzUrl.endsWith("/healthz")) {
    throw new Error("daemon healthzUrl must end with /healthz");
  }
  return healthzUrl.slice(0, -"/healthz".length);
}

function daemonHeaders(handoff) {
  return {
    authorization: `Bearer ${required(handoff.daemon?.ready?.ipcToken, "daemon ipcToken")}`,
  };
}

function daemonEventsUrl(handoff) {
  const baseUrl = daemonBaseUrl(handoff).replace(/^http/i, "ws");
  return `${baseUrl}/v1/events?token=${encodeURIComponent(required(handoff.daemon?.ready?.ipcToken, "daemon ipcToken"))}`;
}

function captureNextSerialScannerEvent(handoff, timeoutMs = 30_000) {
  let socket = null;
  let settled = false;
  let timer = null;
  const close = () => {
    if (timer) clearTimeout(timer);
    socket?.close();
  };
  const promise = new Promise((resolvePromise, reject) => {
    socket = new WebSocket(daemonEventsUrl(handoff));
    timer = setTimeout(() => {
      if (!settled) reject(new Error("timed out waiting for a daemon scanner_code event"));
    }, timeoutMs);
    socket.addEventListener("error", () => {
      if (!settled) reject(new Error("daemon scanner event stream failed"));
    });
    socket.addEventListener("message", (message) => {
      let event;
      try {
        event = JSON.parse(String(message.data));
      } catch {
        return;
      }
      if (
        event?.type === "scanner_code" &&
        event.source === "serial_text" &&
        typeof event.eventId === "string" &&
        event.eventId.length > 0
      ) {
        settled = true;
        close();
        resolvePromise(event);
      }
    });
  });
  return { promise, close };
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

async function daemonGet(handoff, path) {
  return fetchJson(`${daemonBaseUrl(handoff)}${path}`, {
    headers: daemonHeaders(handoff),
  });
}

async function controlPlaneRequest(guestInput, path, body = {}) {
  const endpoint = required(guestInput?.hostControlPlane?.endpoint, "hostControlPlane.endpoint");
  const token = required(guestInput?.hostControlPlane?.token, "hostControlPlane.token");
  return fetchJson(`${endpoint}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function queryPlatform(guestInput, runId, machineCode, sessionId = null) {
  return (
    await controlPlaneRequest(guestInput, "/v1/platform/query", {
      runId,
      machineCode,
      ...(sessionId ? { sessionId } : {}),
    })
  ).report;
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
        vendingStatus: transaction?.vending?.status ?? null,
      };
    }
    await sleep(250);
  }
  throw new Error(
    `vending command did not appear for ${renderedSale.orderId}: ${JSON.stringify(lastTransaction)}`,
  );
}

async function waitForPaymentCodeAttempt(handoff, renderedSale, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastTransaction = null;
  while (Date.now() < deadline) {
    const transaction = await daemonGet(handoff, "/v1/transactions/current").catch(
      () => null,
    );
    lastTransaction = transaction;
    const attempt = transaction?.paymentCodeAttempt ?? null;
    if (
      transaction?.orderId === renderedSale.orderId &&
      transaction?.paymentId === renderedSale.paymentId &&
      typeof attempt?.scannerEventId === "string" &&
      attempt.scannerEventId.length > 0 &&
      attempt.source === "serial_text"
    ) {
      return transaction;
    }
    await sleep(250);
  }
  throw new Error(
    `serial-text payment-code attempt did not appear: ${JSON.stringify(lastTransaction)}`,
  );
}

async function waitForHardwareBindings(handoff, sessionStart, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const snapshot = await daemonGet(handoff, "/v1/hardware-bindings").catch(() => null);
    last = snapshot;
    const roles = Array.isArray(snapshot?.roles) ? snapshot.roles : [];
    const resolved = Object.fromEntries(roles.map((role) => [role.role, role]));
    const lower = resolved.lower_controller;
    const scanner = resolved.scanner;
    if (
      lower?.ready === true &&
      scanner?.ready === true &&
      /^COM[1-9][0-9]*$/.test(lower.currentPort ?? "") &&
      /^COM[1-9][0-9]*$/.test(scanner.currentPort ?? "") &&
      lower.currentPort !== scanner.currentPort &&
      typeof lower.binding?.identity?.identityKey === "string" &&
      typeof scanner.binding?.identity?.identityKey === "string"
    ) {
      const qemuMappings = sessionStart?.qemuUsbSerialMappings;
      if (!Array.isArray(qemuMappings) || qemuMappings.length !== 2) {
        throw new Error("serial session did not expose the real QEMU USB device mappings");
      }
      for (const role of ["lower-controller", "scanner"]) {
        if (!qemuMappings.some((mapping) => mapping.role === role && /^qemu-usb-serial:\/\//.test(mapping.guestDeviceIdentity ?? ""))) {
          throw new Error(`QEMU USB mapping for ${role} is missing`);
        }
      }
      return { daemon: snapshot, qemuUsbSerialMappings: qemuMappings };
    }
    await sleep(250);
  }
  throw new Error(`daemon hardware bindings were not ready: ${JSON.stringify(last)}`);
}

async function waitForSuccessfulResultSurface(client, expected, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  do {
    await waitForRoute(client, /^#\/(payment|dispensing|result\/success)/, {
      timeoutMs: 5_000,
      pollMs: 250,
    });
    last = await readUiBoundary(client);
    if (
      last.route === "#/result/success" &&
      last.result?.kind === "success" &&
      last.result.orderId === expected.orderId &&
      last.result.paymentId === expected.paymentId &&
      last.result.orderNo === expected.orderNo &&
      last.result.commandId === expected.commandId
    ) {
      return last;
    }
    await sleep(250);
  } while (Date.now() < deadline);
  throw new Error(
    `timed out waiting for successful result surface: ${JSON.stringify(last)}`,
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
        commandId: el.dataset.commandId || null,
        route: location.hash
      } : null;
    })()`,
  );
  if (!hook?.orderId || !hook?.paymentId || !hook?.orderNo) {
    throw new Error("required rendered payment surface hook is missing");
  }
  return hook;
}

async function readUiBoundary(client) {
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

async function readRuntimeTrace(client) {
  return evaluateExpression(client, "window.__VEM_MACHINE_RUNTIME_TRACE__ || []");
}

async function startSession(guestInput, runId, machineCode) {
  return controlPlaneRequest(guestInput, "/v1/serial-sessions/start", {
    runId,
    machineCode,
    saleCorrelationId: `sale-correlation://scanner-payment-code-${Date.now()}`,
    targetIdentity: required(
      guestInput.hostControlPlane?.targetIdentity,
      "hostControlPlane.targetIdentity",
    ),
    runtimeBase: required(
      guestInput.hostControlPlane?.runtimeBaseIdentity,
      "hostControlPlane.runtimeBaseIdentity",
    ),
  });
}

async function injectSessionCode(guestInput, sessionId, renderedSale, bytes) {
  return controlPlaneRequest(
    guestInput,
    `/v1/serial-sessions/${sessionId}/inject`,
    {
      orderId: renderedSale.orderId,
      paymentId: renderedSale.paymentId,
      scannerCodeBase64: Buffer.from(bytes).toString("base64"),
    },
  );
}

export function assertNoAttemptOrDuplicatePayment(label, baseline, post, renderedSale) {
  const baselineAttempts = attemptRowsByOrder(baseline, renderedSale.orderId);
  const postAttempts = attemptRowsByOrder(post, renderedSale.orderId);
  if (baselineAttempts.length !== 0 || postAttempts.length !== 0) {
    throw new Error(`${label} must not create a payment-code attempt`);
  }
  const paymentIds = new Set(
    paymentRowsByOrder(post, renderedSale.orderId).map((entry) => entry.id),
  );
  if (paymentIds.size !== 1 || !paymentIds.has(renderedSale.paymentId)) {
    throw new Error(`${label} duplicated or replaced the payment row`);
  }
  if (movementRowsByOrderNo(post, renderedSale.orderNo).length !== 0) {
    throw new Error(`${label} must not vend before a valid scanner frame`);
  }
  if (
    paymentRowsByOrder(post, renderedSale.orderId).length !==
    paymentRowsByOrder(baseline, renderedSale.orderId).length
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
}) {
  const attempts = attemptRowsByOrder(post, renderedSale.orderId);
  if (attempts.length !== 1) {
    throw new Error("valid scan must produce exactly one payment-code attempt");
  }
  const attempt = attempts[0];
  if (
    attempt.paymentId !== renderedSale.paymentId ||
    attempt.status !== "succeeded" ||
    attempt.isActive !== false ||
    attempt.source !== "serial_text"
  ) {
    throw new Error("successful attempt did not converge to one succeeded serial-text attempt");
  }
  const paymentIds = new Set(
    paymentRowsByOrder(post, renderedSale.orderId).map((entry) => entry.id),
  );
  if (paymentIds.size !== 1 || !paymentIds.has(renderedSale.paymentId)) {
    throw new Error("successful scan duplicated or replaced the payment row");
  }
  const movements = movementRowsByOrderNo(post, renderedSale.orderNo);
  if (movements.length !== 1) {
    throw new Error("successful scan must produce exactly one movement");
  }
  if (
    afterF2Ui.route !== "#/result/success" ||
    afterF2Ui.result?.kind !== "success" ||
    afterF2Ui.result?.orderId !== renderedSale.orderId ||
    afterF2Ui.result?.paymentId !== renderedSale.paymentId ||
    afterF2Ui.result?.commandId !== command.vendingCommandId
  ) {
    throw new Error("successful scan did not reach a correlated success result surface");
  }
  const daemonAttempt = attemptSnapshot?.paymentCodeAttempt;
  if (
    scannerEvent?.type !== "scanner_code" ||
    scannerEvent.source !== "serial_text" ||
    typeof scannerEvent.eventId !== "string" ||
    daemonAttempt?.scannerEventId !== scannerEvent.eventId ||
    attempt.scannerEventId !== scannerEvent.eventId ||
    daemonAttempt?.attemptNo !== attempt.attemptNo ||
    daemonAttempt?.idempotencyKey !== attempt.idempotencyKey
  ) {
    throw new Error("ScannerCode event id does not strictly correlate daemon and platform payment attempts");
  }
  const baselineInventory = rows(baseline?.raw, "inventories").find(
    (entry) => entry.id === movements[0].inventoryId,
  );
  const finalInventory = rows(post?.raw, "inventories").find(
    (entry) => entry.id === movements[0].inventoryId,
  );
  if (
    !baselineInventory ||
    !finalInventory ||
    baselineInventory.onHandQty - finalInventory.onHandQty !== 1
  ) {
    throw new Error("successful scan must decrement the same platform inventory by exactly one from baseline to final");
  }
  return {
    attempt,
    movement: movements[0],
    baselinePaymentCount: paymentRowsByOrder(baseline, renderedSale.orderId).length,
    finalPaymentCount: paymentRowsByOrder(post, renderedSale.orderId).length,
    inventory: {
      id: baselineInventory.id,
      baselineOnHandQty: baselineInventory.onHandQty,
      finalOnHandQty: finalInventory.onHandQty,
      deltaOnHandQty: finalInventory.onHandQty - baselineInventory.onHandQty,
    },
  };
}

export function parseScannerPaymentCodeGuestArgs(args) {
  const mode = required(option(args, "mode"), "--mode");
  if (!MODES.has(mode)) throw new Error("--mode must be full");
  return {
    mode,
    guestInputPath: windowsAbsolute(option(args, "guest-input"), "--guest-input"),
    handoffPath: windowsAbsolute(option(args, "handoff"), "--handoff"),
    outPath: windowsAbsolute(option(args, "out"), "--out"),
  };
}

export async function runScannerPaymentCodeGuest(options) {
  let guestInput = null;
  let handoff = null;
  const artifactRoot = join(
    dirname(localPath(options.outPath)),
    "scanner-payment-code-artifacts",
  );
  mkdirSync(artifactRoot, { recursive: true });
  const checkpoints = [];
  let client = null;
  let sessionStart = null;
  let scannerEventCapture = null;
  let failure = null;
  let cleanup = null;
  let stage = "connect";
  try {
    guestInput = readJson(options.guestInputPath, "guest input");
    handoff = readJson(options.handoffPath, "handoff");
    const runId = required(guestInput.runId, "runId");
    const machineCode = required(guestInput.machineCode, "machineCode");
    const target = await discoverMachineUiTarget({
      endpoint: "http://127.0.0.1:9222",
      expectedTargetId: handoff.cdp.targetId,
    });
    client = new CdpClient(
      rewriteWebSocketDebuggerUrl(target.webSocketDebuggerUrl, "http://127.0.0.1:9222"),
    );
    await client.connect();
    await enablePageRuntime(client);
    await waitForRoute(client, "#/catalog", { timeoutMs: 30_000, pollMs: 250 });

    stage = "start-session";
    sessionStart = await startSession(guestInput, runId, machineCode);
    const hardwareBindings = await waitForHardwareBindings(handoff, sessionStart);

    const steps = buildInstalledKioskSaleScenarioSteps("vm-scanner-payment-code");
    for (const step of steps) {
      await waitForRoute(client, step.routeBefore, { timeoutMs: 30_000, pollMs: 250 });
      await activateVisibleSelector(client, step.selector, {
        kind: step.inputKind,
        timeoutMs: step.timeoutMs ?? 30_000,
      });
      await waitForRoute(client, step.routeAfter, { timeoutMs: 30_000, pollMs: 250 });
    }

    await waitForRoute(client, /^#\/payment/, { timeoutMs: 30_000, pollMs: 250 });
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
    const paymentBaseline = await queryPlatform(
      guestInput,
      runId,
      machineCode,
      sessionStart.sessionId,
    );

    stage = "malformed-scan";
    await injectSessionCode(
      guestInput,
      sessionStart.sessionId,
      renderedSale,
      MALFORMED_SCANNER_BYTES,
    );
    await sleep(250);
    const postMalformed = await queryPlatform(
      guestInput,
      runId,
      machineCode,
      sessionStart.sessionId,
    );
    assertNoAttemptOrDuplicatePayment(
      "malformed scan",
      paymentBaseline,
      postMalformed,
      renderedSale,
    );

    stage = "timeout-scan";
    await injectSessionCode(
      guestInput,
      sessionStart.sessionId,
      renderedSale,
      TIMEOUT_PARTIAL_SCANNER_BYTES,
    );
    await sleep(1_200);
    const postTimeout = await queryPlatform(
      guestInput,
      runId,
      machineCode,
      sessionStart.sessionId,
    );
    assertNoAttemptOrDuplicatePayment(
      "scanner timeout",
      paymentBaseline,
      postTimeout,
      renderedSale,
    );

    stage = "valid-scan";
    const validScannerBytes = scannerFrameBytes(
      guestInput?.scannerAcceptance?.validCode ?? DEFAULT_VALID_SCANNER_CODE,
    );
    scannerEventCapture = captureNextSerialScannerEvent(handoff);
    await injectSessionCode(
      guestInput,
      sessionStart.sessionId,
      renderedSale,
      validScannerBytes,
    );

    const scannerEvent = await scannerEventCapture.promise;
    scannerEventCapture = null;

    const attemptSnapshot = await waitForPaymentCodeAttempt(
      handoff,
      renderedSale,
      30_000,
    );
    const command = await waitForCommand(handoff, renderedSale, 30_000);
    await controlPlaneRequest(
      guestInput,
      `/v1/serial-sessions/${sessionStart.sessionId}/bind-sale`,
      command,
    );

    stage = "vend-boundaries";
    const vendBoundary = await controlPlaneRequest(
      guestInput,
      `/v1/serial-sessions/${sessionStart.sessionId}/wait-frame`,
      { parsedOpcode: "VEND", timeoutMs: 30_000 },
    );
    const beforeF0Platform = await queryPlatform(
      guestInput,
      runId,
      machineCode,
      sessionStart.sessionId,
    );
    const releaseF0 = await controlPlaneRequest(
      guestInput,
      `/v1/serial-sessions/${sessionStart.sessionId}/release-f0`,
    );
    const f0Boundary = await controlPlaneRequest(
      guestInput,
      `/v1/serial-sessions/${sessionStart.sessionId}/wait-frame`,
      { parsedOpcode: "F0", timeoutMs: 30_000 },
    );
    const f1Boundary = await controlPlaneRequest(
      guestInput,
      `/v1/serial-sessions/${sessionStart.sessionId}/wait-frame`,
      { parsedOpcode: "F1", timeoutMs: 30_000 },
    );
    const afterF1Platform = await queryPlatform(
      guestInput,
      runId,
      machineCode,
      sessionStart.sessionId,
    );
    const releaseF2 = await controlPlaneRequest(
      guestInput,
      `/v1/serial-sessions/${sessionStart.sessionId}/release-f2`,
    );
    const f2Boundary = await controlPlaneRequest(
      guestInput,
      `/v1/serial-sessions/${sessionStart.sessionId}/wait-frame`,
      { parsedOpcode: "F2", timeoutMs: 30_000 },
    );
    const afterF2Ui = await waitForSuccessfulResultSurface(
      client,
      {
        orderId: renderedSale.orderId,
        paymentId: renderedSale.paymentId,
        orderNo: renderedSale.orderNo,
        commandId: command.vendingCommandId,
      },
      60_000,
    );
    const postPlatform = await queryPlatform(
      guestInput,
      runId,
      machineCode,
      sessionStart.sessionId,
    );
    const sessionEvidence = await controlPlaneRequest(
      guestInput,
      `/v1/serial-sessions/${sessionStart.sessionId}/evidence`,
    );
    const runtimeTrace = await readRuntimeTrace(client);
    const success = validateSuccessfulOutcome({
      baseline: paymentBaseline,
      post: postPlatform,
      renderedSale,
      command,
      attemptSnapshot,
      scannerEvent,
      afterF2Ui,
    });

    const stop = await controlPlaneRequest(
      guestInput,
      `/v1/serial-sessions/${sessionStart.sessionId}/stop`,
      {
        orderId: renderedSale.orderId,
        paymentId: renderedSale.paymentId,
        vendingCommandId: command.vendingCommandId,
      },
    );

    const report = {
      schemaVersion: "vem-scanner-payment-code-guest-full/v1",
      ok: true,
      mode: options.mode,
      runId,
      machineCode,
      renderedSale,
      scannerAttempt: {
        attemptNo: attemptSnapshot.paymentCodeAttempt.attemptNo,
        status: attemptSnapshot.paymentCodeAttempt.status,
        source: attemptSnapshot.paymentCodeAttempt.source,
        scannerEventId: attemptSnapshot.paymentCodeAttempt.scannerEventId,
        idempotencyKey: attemptSnapshot.paymentCodeAttempt.idempotencyKey,
      },
      scannerEvent: {
        eventId: scannerEvent.eventId,
        source: scannerEvent.source,
        scannedAtMs: scannerEvent.scannedAtMs,
      },
      hardwareBindings,
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
          attemptCount: attemptRowsByOrder(postMalformed, renderedSale.orderId).length,
          paymentDelta:
            paymentRowsByOrder(postMalformed, renderedSale.orderId).length -
            paymentRowsByOrder(paymentBaseline, renderedSale.orderId).length,
        },
        timeout: {
          platformCapturedAt: postTimeout.capturedAt,
          attemptCount: attemptRowsByOrder(postTimeout, renderedSale.orderId).length,
          paymentDelta:
            paymentRowsByOrder(postTimeout, renderedSale.orderId).length -
            paymentRowsByOrder(paymentBaseline, renderedSale.orderId).length,
        },
      },
      final: {
        route: afterF2Ui.route,
        result: afterF2Ui.result,
        stop,
      },
      serial: sessionEvidence,
      runtimeTrace,
    };
    writeJson(options.outPath, report);
    return report;
  } catch (error) {
    failure = {
      schemaVersion: "vem-scanner-payment-code-guest-full/v1",
      ok: false,
      stage,
      error: error instanceof Error ? error.message : String(error),
      evidence: { checkpoints },
    };
    if (guestInput) {
      const runId = guestInput.runId;
      const machineCode = guestInput.machineCode;
      if (runId && machineCode) {
        failure.evidence.platform = await queryPlatform(
          guestInput,
          runId,
          machineCode,
          sessionStart?.sessionId ?? null,
        ).catch((captureError) => ({ error: String(captureError) }));
      }
      if (sessionStart?.sessionId) {
        failure.evidence.serial = await controlPlaneRequest(
          guestInput,
          `/v1/serial-sessions/${sessionStart.sessionId}/evidence`,
        ).catch((captureError) => ({ error: String(captureError) }));
      }
    }
    if (handoff) {
      failure.evidence.daemon = await daemonGet(
        handoff,
        "/v1/transactions/current",
      ).catch((captureError) => ({ error: String(captureError) }));
    }
    if (client) {
      failure.evidence.ui = await readUiBoundary(client).catch(
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
    if (guestInput && sessionStart?.sessionId) {
      failure.cleanup = await controlPlaneRequest(
        guestInput,
        `/v1/serial-sessions/${sessionStart.sessionId}/abort`,
      ).catch((cleanupError) => ({ error: String(cleanupError) }));
    }
    writeJson(options.outPath, failure);
    throw error;
  } finally {
    try {
      if (sessionStart?.sessionId) {
        cleanup = await controlPlaneRequest(
          guestInput,
          `/v1/serial-sessions/${sessionStart.sessionId}/abort`,
        ).catch((error) => ({
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    } finally {
      scannerEventCapture?.close();
      await client?.close().catch(() => undefined);
    }
    if (failure) writeJson(options.outPath, { ...failure, cleanup });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const options = parseScannerPaymentCodeGuestArgs(process.argv.slice(2));
  runScannerPaymentCodeGuest(options).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
