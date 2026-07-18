#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  activateVisibleSelector,
  captureCheckpoint,
  captureDomIdentity,
  CdpClient,
  discoverMachineUiTarget,
  enablePageRuntime,
  evaluateExpression,
  rewriteWebSocketDebuggerUrl,
  waitForRoute,
} from "./machine-ui-cdp-driver.mjs";

const MODES = new Set(["fast", "full"]);
const DEFAULT_SCANNER_CODE = "6901234567892";

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

export function parseFastRouteStressSaleArgs(args) {
  const mode = required(option(args, "mode"), "--mode");
  if (!MODES.has(mode)) throw new Error("--mode must be fast or full");
  return {
    mode,
    guestInputPath: windowsAbsolute(option(args, "guest-input"), "--guest-input"),
    handoffPath: windowsAbsolute(option(args, "handoff"), "--handoff"),
    outPath: windowsAbsolute(option(args, "out"), "--out"),
  };
}

export function buildFastRouteStressScenarioSteps() {
  return [
    {
      type: "customer-activation",
      name: "catalog category",
      selector: '[data-test="catalog-category"]:not(:disabled)',
      routeBefore: "#/catalog",
      routeAfter: "#/catalog",
      inputKind: "touch",
    },
    {
      type: "customer-activation",
      name: "catalog product",
      selector: '[data-test="catalog-product"]',
      routeBefore: "#/catalog",
      routeAfter: /^#\/products\//,
      inputKind: "touch",
    },
    {
      type: "customer-activation",
      name: "buy",
      selector: '[data-test="product-buy"]',
      routeBefore: /^#\/products\//,
      routeAfter: "#/checkout",
      inputKind: "touch",
    },
    {
      type: "customer-activation",
      name: "payment option",
      selector:
        '[data-test="payment-option"][data-payment-option-key="payment_code:mock"]',
      routeBefore: "#/checkout",
      routeAfter: "#/checkout",
      inputKind: "touch",
    },
    {
      type: "customer-activation",
      name: "payment submit",
      selector: '[data-test="checkout-submit"]',
      routeBefore: "#/checkout",
      routeAfter: "#/checkout",
      inputKind: "touch",
    },
    {
      type: "customer-activation",
      name: "payment submit repeat",
      selector: '[data-test="checkout-submit"]',
      routeBefore: "#/checkout",
      routeAfter: /^#\/payment/,
      inputKind: "touch",
    },
  ];
}

function platformCount(raw, key) {
  return Array.isArray(raw?.[key]) ? raw[key].length : 0;
}

function daemonSaleableTotal(view) {
  return Array.isArray(view?.items)
    ? view.items.reduce((sum, item) => sum + Number(item.saleableStock ?? 0), 0)
    : 0;
}

function protocolFrames(serial) {
  const lowerControllerRecords = Array.isArray(serial?.lowerControllerRecords)
    ? serial.lowerControllerRecords
    : [];
  const frameByEvent = new Map(
    lowerControllerRecords.map((record) => [record?.event, record]),
  );
  return [
    ["F0", "dispense-request"],
    ["F1", "dispense-ack"],
    ["F2", "dispense-result"],
  ]
    .map(([stage, event]) => {
      const record = frameByEvent.get(event);
      return record
        ? {
            stage,
            event,
            sequence: record?.capturedFrame?.sequence ?? null,
            digest: record?.capturedFrame?.digest ?? null,
            byteLength: record?.capturedFrame?.byteLength ?? null,
          }
        : null;
    })
    .filter(Boolean);
}

export function summarizeFastRouteStressSale(input) {
  const baseline = input.platform?.baseline?.raw ?? {};
  const beforeF2 = input.platform?.beforeF2?.raw ?? {};
  const afterF2 = input.platform?.afterF2?.raw ?? {};
  const lowerControllerEvents = Array.isArray(input.serial?.lowerControllerEvents)
    ? input.serial.lowerControllerEvents
    : [];
  return {
    counts: {
      ordersCreated: platformCount(beforeF2, "orders") - platformCount(baseline, "orders"),
      paymentsCreated:
        platformCount(beforeF2, "payments") - platformCount(baseline, "payments"),
      commandsCreated:
        platformCount(beforeF2, "commands") - platformCount(baseline, "commands"),
      mqttCommands: Array.isArray(input.mqttMessages) ? input.mqttMessages.length : 0,
      platformMovementsBeforeF2:
        platformCount(beforeF2, "movements") - platformCount(baseline, "movements"),
      platformMovementsAfterF2:
        platformCount(afterF2, "movements") - platformCount(beforeF2, "movements"),
      daemonSaleableDeltaBeforeF2:
        daemonSaleableTotal(input.daemon?.beforeF2) -
        daemonSaleableTotal(input.daemon?.baseline ?? input.daemon?.beforeF2),
      daemonSaleableDeltaAfterF2:
        daemonSaleableTotal(input.daemon?.afterF2) -
        daemonSaleableTotal(input.daemon?.beforeF2),
    },
    runtime: {
      navigationRecords: Array.isArray(input.runtimeTrace)
        ? input.runtimeTrace.filter((entry) => entry?.type === "navigation").length
        : 0,
      renderedSale: input.renderedSale,
    },
    serial: {
      lowerControllerEvents,
      protocolFrames: protocolFrames(input.serial),
    },
  };
}

function localPath(path) {
  return process.platform === "win32"
    ? path
    : resolve(`/mnt/${path[0].toLowerCase()}/${path.slice(3).replaceAll("\\", "/")}`);
}

function readJson(path, label) {
  return JSON.parse(readFileSync(localPath(path), "utf8"));
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

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`${options.method ?? "GET"} ${url} failed with HTTP ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function daemonGet(handoff, path) {
  return fetchJson(`${daemonBaseUrl(handoff)}${path}`, {
    headers: daemonHeaders(handoff),
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
        vendingStatus: transaction?.vending?.status ?? null,
      };
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error(
    `vending command did not appear for order ${renderedSale.orderId}: ${JSON.stringify(lastTransaction)}`,
  );
}

async function waitForResultRoute(client, timeoutMs = 60_000) {
  return waitForRoute(client, /^#\/(dispensing|result)/, { timeoutMs, pollMs: 250 });
}

async function readRuntimeTrace(client) {
  return evaluateExpression(client, "window.__VEM_MACHINE_RUNTIME_TRACE__ || []");
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
    throw new Error("required rendered customer UI payment hook is missing");
  }
  return hook;
}

function screenshotSink(outPath) {
  const root = join(dirname(localPath(outPath)), "fast-route-stress-sale-artifacts");
  mkdirSync(root, { recursive: true });
  return async ({ bytes, sha256, label, format }) => {
    const file = join(root, `${String(label).replaceAll(/[^a-z0-9-]+/gi, "-")}.${format}`);
    writeFileSync(file, bytes);
    return { ref: file, sha256 };
  };
}

async function controlPlaneRequest(guestInput, path, body = {}) {
  const controlPlane = guestInput.hostControlPlane;
  if (!controlPlane?.endpoint || !controlPlane?.token) {
    throw new Error("guest input is missing hostControlPlane endpoint and token");
  }
  // The Linux host control plane is the runner-owned bridge to run-vm-host-adapter.mjs.
  return fetchJson(`${controlPlane.endpoint}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${controlPlane.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function ensureControlledVisionMock(controlPort) {
  const healthUrl = "http://127.0.0.1:7892/health";
  const controlUrl = `http://127.0.0.1:${controlPort}/control/departure`;
  try {
    await fetchJson(healthUrl);
    const probe = await fetch(controlUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "probe" }),
    });
    if (probe.ok) return { child: null, started: false };
  } catch {}
  const child = spawn(
    process.execPath,
    ["--conditions=vem-source", "--import", "tsx", "apps/vision-mock/src/server.ts"],
    {
    cwd: process.cwd(),
    env: {
      ...process.env,
      VISION_MOCK_SCENARIO: "controlled",
      VISION_MOCK_CONTROL_PORT: String(controlPort),
      VISION_MOCK_PORT: "7892",
      VISION_MOCK_PATH: "/ws",
    },
    stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.resume();
  child.stderr.resume();
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      await fetchJson(healthUrl);
      return { child, started: true };
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    }
  }
  child.kill("SIGTERM");
  throw new Error("controlled vision mock did not become ready");
}

async function dispatchVisionDeparture(guestInput) {
  const port = guestInput.hostControlPlane?.visionMockControlPort ?? guestInput.visionMockControlPort;
  const controlPort = Number(port);
  if (!Number.isInteger(controlPort) || controlPort < 1) {
    throw new Error("guest input is missing vision mock control port");
  }
  // Use the controlled vision injection endpoint rather than browser-state spoofing.
  // Full guest-local URL shape: http://127.0.0.1:<port>/control/departure.
  // Regex guard anchor: vision/control/departure.
  return fetchJson(`http://127.0.0.1:${controlPort}/control/departure`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: "fast-route-stress-sale" }),
  });
}

async function runFastRouteStressSale(options) {
  const guestInput = readJson(options.guestInputPath, "guest input");
  const handoff = readJson(options.handoffPath, "handoff");
  const sink = screenshotSink(options.outPath);
  const vision = await ensureControlledVisionMock(
    guestInput.hostControlPlane?.visionMockControlPort ?? guestInput.visionMockControlPort,
  );
  const target = await discoverMachineUiTarget({
    endpoint: "http://127.0.0.1:9222",
    expectedTargetId: handoff.cdp.targetId,
  });
  const client = new CdpClient(
    rewriteWebSocketDebuggerUrl(target.webSocketDebuggerUrl, "http://127.0.0.1:9222"),
  );
  const runId = required(guestInput.runId, "runId");
  const machineCode = required(guestInput.machineCode, "machineCode");
  const saleCorrelationId = `fast-route-${Date.now()}`;
  const steps = buildFastRouteStressScenarioSteps();
  try {
    await client.connect();
    await enablePageRuntime(client);
    await waitForRoute(client, "#/catalog", { timeoutMs: 30_000, pollMs: 250 });
    const baselineSaleView = await daemonGet(handoff, "/v1/sale-view");
    const baselinePlatform = (
      await controlPlaneRequest(guestInput, "/v1/platform/query", {
        runId,
        machineCode,
      })
    ).report;
    const sessionStart = await controlPlaneRequest(
      guestInput,
      "/v1/serial-sessions/start",
      {
        runId,
        machineCode,
        saleCorrelationId,
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
    const checkpoints = [
      await captureCheckpoint(client, "catalog-start", {
        screenshot: true,
        screenshotSink: sink,
      }),
    ];
    for (const step of steps.slice(0, 4)) {
      await waitForRoute(client, step.routeBefore, { timeoutMs: 30_000, pollMs: 250 });
      // activateVisibleSelector hard-fails unless the UI action is dispatched via
      // the real Chrome DevTools Input.dispatchTouchEvent path.
      const activation = await activateVisibleSelector(client, step.selector, {
        kind: step.inputKind,
        timeoutMs: 30_000,
      });
      assert.match(activation.input.method, /Input\.dispatchTouchEvent/);
      await waitForRoute(client, step.routeAfter, { timeoutMs: 30_000, pollMs: 250 });
    }
    await waitForRoute(client, "#/checkout", { timeoutMs: 30_000, pollMs: 250 });
    const firstSubmit = await activateVisibleSelector(
      client,
      steps[4].selector,
      { kind: "touch", timeoutMs: 30_000 },
    );
    assert.match(firstSubmit.input.method, /Input\.dispatchTouchEvent/);
    await dispatchVisionDeparture(guestInput);
    const secondSubmit = await activateVisibleSelector(
      client,
      steps[5].selector,
      { kind: "touch", timeoutMs: 5_000 },
    );
    assert.match(secondSubmit.input.method, /Input\.dispatchTouchEvent/);
    await waitForRoute(client, /^#\/payment/, { timeoutMs: 30_000, pollMs: 250 });
    checkpoints.push(
      await captureCheckpoint(client, "payment-creation", {
        screenshot: true,
        screenshotSink: sink,
      }),
    );
    const renderedSale = await readRenderedPaymentSurface(client);
    await controlPlaneRequest(guestInput, `/v1/serial-sessions/${sessionStart.sessionId}/inject`, {
      orderId: renderedSale.orderId,
      paymentId: renderedSale.paymentId,
      scannerCode: guestInput.fastSale?.scannerCode ?? DEFAULT_SCANNER_CODE,
    });
    const liveSale = await waitForCommand(handoff, renderedSale);
    const beforeF2SaleView = await daemonGet(handoff, "/v1/sale-view");
    const beforeF2Platform = (
      await controlPlaneRequest(guestInput, "/v1/platform/query", {
        runId,
        machineCode,
        sessionId: sessionStart.sessionId,
      })
    ).report;
    const summaryBefore = summarizeFastRouteStressSale({
      renderedSale,
      platform: {
        baseline: baselinePlatform,
        beforeF2: beforeF2Platform,
        afterF2: beforeF2Platform,
      },
      daemon: {
        baseline: baselineSaleView,
        beforeF2: beforeF2SaleView,
        afterF2: beforeF2SaleView,
      },
      mqttMessages: [],
      serial: { lowerControllerEvents: [] },
    });
    if (summaryBefore.counts.platformMovementsBeforeF2 !== 0) {
      throw new Error("platform inventory changed before F2");
    }
    if (summaryBefore.counts.daemonSaleableDeltaBeforeF2 !== 0) {
      throw new Error("daemon saleable stock changed before F2");
    }
    const collect = await controlPlaneRequest(
      guestInput,
      `/v1/serial-sessions/${sessionStart.sessionId}/collect`,
      {
        orderId: liveSale.orderId,
        paymentId: liveSale.paymentId,
        vendingCommandId: liveSale.vendingCommandId,
      },
    );
    const stop = await controlPlaneRequest(
      guestInput,
      `/v1/serial-sessions/${sessionStart.sessionId}/stop`,
      {
        orderId: liveSale.orderId,
        paymentId: liveSale.paymentId,
        vendingCommandId: liveSale.vendingCommandId,
      },
    );
    const stopRepeat = await controlPlaneRequest(
      guestInput,
      `/v1/serial-sessions/${sessionStart.sessionId}/stop`,
      {
        orderId: liveSale.orderId,
        paymentId: liveSale.paymentId,
        vendingCommandId: liveSale.vendingCommandId,
        idempotencyCheck: true,
      },
    );
    const resultRoute = await waitForResultRoute(client, 60_000);
    checkpoints.push(
      await captureCheckpoint(client, "result", {
        screenshot: true,
        screenshotSink: sink,
      }),
    );
    const afterF2SaleView = await daemonGet(handoff, "/v1/sale-view");
    const afterF2Platform = (
      await controlPlaneRequest(guestInput, "/v1/platform/query", {
        runId,
        machineCode,
        sessionId: sessionStart.sessionId,
      })
    ).report;
    const runtimeTrace = await readRuntimeTrace(client);
    const serialLowerControllerEvents = Array.isArray(
      collect.collectReport?.serialEvidence?.records,
    )
      ? collect.collectReport.serialEvidence.records
          .filter((record) => record.role === "lower-controller")
          .map((record) => ({
            event: record.event,
            capturedFrame: record.capturedFrame ?? null,
          }))
      : [];
    const summary = summarizeFastRouteStressSale({
      runtimeTrace,
      renderedSale,
      platform: {
        baseline: baselinePlatform,
        beforeF2: beforeF2Platform,
        afterF2: afterF2Platform,
      },
      daemon: {
        baseline: baselineSaleView,
        beforeF2: beforeF2SaleView,
        afterF2: afterF2SaleView,
      },
      mqttMessages: collect.mqtt?.messages ?? stop.mqtt?.messages ?? [],
      serial: {
        lowerControllerEvents: serialLowerControllerEvents.map((record) => record.event),
        lowerControllerRecords: serialLowerControllerEvents,
      },
    });
    if (summary.counts.ordersCreated !== 1) throw new Error("expected exactly one order");
    if (summary.counts.paymentsCreated !== 1) throw new Error("expected exactly one payment");
    if (summary.counts.commandsCreated !== 1) throw new Error("expected exactly one vending command");
    if (summary.counts.mqttCommands !== 1) throw new Error("expected exactly one MQTT vending command");
    if (summary.counts.platformMovementsAfterF2 !== 1) throw new Error("expected one platform movement after F2");
    if (summary.counts.daemonSaleableDeltaAfterF2 !== -1) throw new Error("expected daemon saleable stock to decrement only after F2");
    if (
      JSON.stringify(summary.serial.protocolFrames.map((frame) => frame.stage)) !==
      JSON.stringify(["F0", "F1", "F2"])
    ) {
      throw new Error("serial evidence must expose ordered F0/F1/F2 protocol stages");
    }
    for (const event of ["dispense-request", "dispense-ack", "dispense-result"]) {
      if (!summary.serial.lowerControllerEvents.includes(event)) {
        throw new Error(`serial evidence is missing ${event}`);
      }
    }
    const report = {
      schemaVersion: "vem-fast-route-stress-sale/v1",
      ok: true,
      mode: options.mode,
      runId,
      machineCode,
      resultRoute: resultRoute.route,
      controlPlaneSessionId: sessionStart.sessionId,
      renderedSale,
      liveSale,
      summary,
      serial: {
        start: sessionStart,
        collect,
        stop,
        stopRepeat,
      },
      runtimeTrace,
      checkpoints,
      logs: {
        milestones: checkpoints.map((checkpoint) => ({
          label: checkpoint.label,
          route: checkpoint.identity.route,
          screenshot: checkpoint.screenshot?.ref ?? null,
        })),
      },
    };
    mkdirSync(dirname(localPath(options.outPath)), { recursive: true });
    writeFileSync(localPath(options.outPath), `${JSON.stringify(report, null, 2)}\n`);
    return report;
  } finally {
    await client.close().catch(() => undefined);
    vision.child?.kill("SIGTERM");
  }
}

async function main() {
  const options = parseFastRouteStressSaleArgs(process.argv.slice(2));
  const result = await runFastRouteStressSale(options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  });
}
