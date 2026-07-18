#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  activateVisibleSelector,
  captureCheckpoint,
  CdpClient,
  dispatchPhysicalInput,
  discoverMachineUiTarget,
  enablePageRuntime,
  evaluateExpression,
  rewriteWebSocketDebuggerUrl,
  waitForRoute,
} from "./machine-ui-cdp-driver.mjs";
import { validateProductionRawSerialFrame } from "./qemu-usb-serial-host-adapter.mjs";

const MODES = new Set(["fast", "full"]);
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
        '[data-test="payment-option"][data-payment-option-key="mock:mock"]:not(:disabled)',
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
      routeAfter: "#/checkout",
      inputKind: "touch",
    },
  ];
}

export async function dispatchRepeatedPaymentTouch(client, firstActivation) {
  const originalPoint = firstActivation?.center;
  const input = await dispatchPhysicalInput(client, originalPoint, {
    kind: "touch",
    timeoutMs: 5_000,
  });
  return { originalPoint: { x: originalPoint.x, y: originalPoint.y }, input };
}

async function armCreateOrderGate(guestInput) {
  const armed = await controlPlaneRequest(
    guestInput,
    "/v1/mock-payment-create-gate/arm",
  );
  return {
    controlPlane: "mock-payment-create-gate",
    armedAt: armed.armedAt,
  };
}

async function waitForCreateOrderGatePending(guestInput, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      const status = await controlPlaneRequest(
        guestInput,
        "/v1/mock-payment-create-gate/status",
      );
      const pending = status?.pending;
      if (
        pending?.state === "pending" &&
        typeof pending.paymentNo === "string" &&
        typeof pending.observedAt === "string"
      ) {
        return pending;
      }
    } catch {}
    await sleep(25);
  } while (Date.now() < deadline);
  throw new Error("mock create-order gate did not observe a pending payment creation");
}

async function releaseCreateOrderGate(guestInput, paymentNo) {
  const released = await controlPlaneRequest(
    guestInput,
    "/v1/mock-payment-create-gate/release",
    { paymentNo },
  );
  return {
    paymentNo,
    releasedAt: released.releasedAt,
  };
}

async function openCreateOrderGate(guestInput) {
  return await controlPlaneRequest(guestInput, "/v1/mock-payment-create-gate/open");
}

function rows(raw, key) {
  return Array.isArray(raw?.[key]) ? raw[key] : [];
}

function deltaRows(before, after, key) {
  const prior = new Set(rows(before, key).map((row) => row.id));
  return rows(after, key).filter((row) => !prior.has(row.id));
}

function exactlyOne(values, message) {
  if (values.length !== 1) throw new Error(message);
  return values[0];
}

function matchingItem(view, identity) {
  return rows(view, "items").find(
    (item) =>
      item.inventoryId === identity.inventoryId &&
      item.slotId === identity.slotId,
  );
}

function matchingInventory(raw, identity) {
  return rows(raw, "inventories").find(
    (inventory) =>
      inventory.id === identity.inventoryId && inventory.slotId === identity.slotId,
  );
}

function matchingRowById(raw, key, id) {
  return rows(raw, key).find((row) => row.id === id);
}

function compactRuntimeTrace(trace, maxEntries = 64) {
  return Array.isArray(trace) ? trace.slice(-maxEntries) : [];
}

function compactPlatformBoundary(report, summary) {
  const raw = report?.raw ?? {};
  return {
    scope: report?.scope ?? null,
    order: matchingRowById(raw, "orders", summary.orderId) ?? null,
    orderItem: rows(raw, "orderItems").find((row) => row.inventoryId === summary.inventoryId && row.slotId === summary.slotId) ?? null,
    payment: matchingRowById(raw, "payments", summary.paymentId) ?? null,
    command: matchingRowById(raw, "commands", summary.vendingCommandId) ?? null,
    movement: matchingRowById(raw, "movements", summary.movementId) ?? null,
    inventory: rows(raw, "inventories").find(
      (row) => row.id === summary.inventoryId && row.slotId === summary.slotId,
    ) ?? null,
  };
}

function compactDaemonBoundary(view, summary) {
  return {
    item:
      rows(view, "items").find(
        (row) => row.inventoryId === summary.inventoryId && row.slotId === summary.slotId,
      ) ?? null,
  };
}

function compactEvidenceForReport(evidence, summary) {
  return {
    saleCorrelationId: evidence.saleCorrelationId,
    machineCode: evidence.machineCode,
    renderedSale: evidence.renderedSale,
    liveSale: evidence.liveSale,
    createOrderGate: evidence.createOrderGate,
    saleStartCapability: evidence.saleStartCapability,
    uiViewport: evidence.uiViewport,
    visionDelivery: evidence.visionDelivery,
    platform: {
      baseline: compactPlatformBoundary(evidence.platform?.baseline, summary),
      beforeF0: compactPlatformBoundary(evidence.platform?.beforeF0, summary),
      afterF1BeforeF2: compactPlatformBoundary(evidence.platform?.afterF1BeforeF2, summary),
      afterF2: compactPlatformBoundary(evidence.platform?.afterF2, summary),
    },
    daemon: {
      baseline: compactDaemonBoundary(evidence.daemon?.baseline, summary),
      beforeF0: compactDaemonBoundary(evidence.daemon?.beforeF0, summary),
      afterF1BeforeF2: compactDaemonBoundary(evidence.daemon?.afterF1BeforeF2, summary),
      afterF2: compactDaemonBoundary(evidence.daemon?.afterF2, summary),
    },
    ui: evidence.ui,
    mqttMessages: Array.isArray(evidence.mqttMessages) ? evidence.mqttMessages.slice(-2) : [],
    serial: {
      sessionId: evidence.serial?.sessionId ?? null,
      rawFrames: Array.isArray(evidence.serial?.rawFrames)
        ? evidence.serial.rawFrames
            .filter((frame) => ["VEND", "F0", "F1", "F2"].includes(frame?.parsedOpcode))
            .slice(-4)
        : [],
    },
  };
}

export function validateFastRouteStressSaleEvidence(input) {
  const baseline = input.platform?.baseline?.raw ?? {};
  const beforeF0 = input.platform?.beforeF0?.raw ?? {};
  const afterF1 = input.platform?.afterF1BeforeF2?.raw ?? {};
  const afterF2 = input.platform?.afterF2?.raw ?? {};
  const rendered = input.renderedSale ?? {};
  const live = input.liveSale ?? {};
  const machineCode = required(input.machineCode, "machineCode");
  const order = exactlyOne(
    deltaRows(baseline, afterF1, "orders"),
    "expected exactly one correlated order",
  );
  if (order.id !== rendered.orderId || order.id !== live.orderId || order.orderNo !== rendered.orderNo || order.orderNo !== live.orderNo) {
    throw new Error("rendered, daemon, and platform order identities must match");
  }
  const orderItem = exactlyOne(
    rows(afterF1, "orderItems").filter((row) => row.orderId === order.id),
    "expected exactly one correlated order item",
  );
  const payment = exactlyOne(
    deltaRows(baseline, afterF1, "payments").filter((row) => row.orderId === order.id),
    "expected exactly one correlated payment",
  );
  if (payment.id !== rendered.paymentId || payment.id !== live.paymentId) {
    throw new Error("rendered, daemon, and platform payment identities must match");
  }
  const command = exactlyOne(
    deltaRows(baseline, afterF1, "commands").filter(
      (row) => row.orderId === order.id && row.orderItemId === orderItem.id,
    ),
    "expected exactly one correlated vending command",
  );
  if (command.id !== live.vendingCommandId || command.slotId !== orderItem.slotId) {
    throw new Error("daemon and platform vending command identities must match the order slot");
  }
  if (
    deltaRows(baseline, afterF2, "orders").length !== 1 ||
    deltaRows(baseline, afterF2, "payments").length !== 1 ||
    deltaRows(baseline, afterF2, "commands").length !== 1
  ) {
    throw new Error("duplicate order, payment, or vending command appeared after inbound F2");
  }
  if (
    deltaRows(baseline, beforeF0, "orders").length !== 1 ||
    deltaRows(baseline, beforeF0, "payments").length !== 1 ||
    deltaRows(baseline, beforeF0, "commands").length !== 1
  ) {
    throw new Error("before inbound F0 the correlated order, payment, and vending command must already exist exactly once");
  }
  const identity = {
    inventoryId: orderItem.inventoryId,
    slotId: orderItem.slotId,
  };
  const baselineInventory = matchingInventory(baseline, identity);
  const daemonBefore = matchingItem(input.daemon?.beforeF0, identity);
  const daemonMiddle = matchingItem(input.daemon?.afterF1BeforeF2, identity);
  const daemonAfter = matchingItem(input.daemon?.afterF2, identity);
  const platformBefore = matchingInventory(beforeF0, identity);
  const platformMiddle = matchingInventory(afterF1, identity);
  const platformAfter = matchingInventory(afterF2, identity);
  if (!baselineInventory || !daemonBefore || !daemonMiddle || !daemonAfter || !platformBefore || !platformMiddle || !platformAfter) {
    throw new Error("all temporal boundaries require the correlated slot inventory snapshot");
  }
  if (input.ui?.beforeF0?.result?.kind === "success") {
    throw new Error("UI must not show success before inbound F0");
  }
  if (input.ui?.afterF1BeforeF2?.result?.kind === "success") {
    throw new Error("UI must not show success before inbound F2");
  }
  if (
    daemonMiddle.saleableStock !== daemonBefore.saleableStock ||
    platformMiddle.onHandQty !== platformBefore.onHandQty ||
    deltaRows(beforeF0, afterF1, "movements").length !== 0 ||
    deltaRows(baseline, beforeF0, "movements").length !== 0
  ) {
    throw new Error("correlated daemon and platform stock must remain unchanged through inbound F1");
  }
  if (daemonAfter.saleableStock - daemonMiddle.saleableStock !== -1) {
    throw new Error("correlated daemon slot stock must decrement exactly once after inbound F2");
  }
  if (platformAfter.onHandQty - platformMiddle.onHandQty !== -1) {
    throw new Error("correlated platform inventory must decrement exactly once after inbound F2");
  }
  const movement = exactlyOne(
    deltaRows(afterF1, afterF2, "movements"),
    "expected exactly one correlated platform movement after inbound F2",
  );
  if (
    movement.orderNo !== order.orderNo ||
    movement.orderItemId !== orderItem.id ||
    movement.commandNo !== command.commandNo ||
    movement.inventoryId !== orderItem.inventoryId ||
    movement.slotId !== orderItem.slotId ||
    Number(movement.quantity) !== 1
  ) {
    throw new Error("platform movement must correlate order, command, item, inventory, and slot");
  }
  const mqtt = exactlyOne(
    Array.isArray(input.mqttMessages) ? input.mqttMessages : [],
    "expected exactly one MQTT vend command",
  );
  if (
    mqtt?.topic !== `vem/machines/${machineCode}/commands/dispense` ||
    mqtt?.payload?.machineCode !== machineCode
  ) {
    throw new Error("MQTT vend command must correlate the machine identity");
  }
  const mqttPayload = mqtt?.payload?.payload;
  if (mqttPayload?.commandNo !== command.commandNo) {
    throw new Error(`MQTT vend command must correlate commandNo ${command.commandNo}`);
  }
  if (mqttPayload.orderNo !== order.orderNo || mqttPayload.quantity !== 1) {
    throw new Error("MQTT vend command must correlate order and quantity");
  }
  if (
    mqttPayload.slot?.slotCode !== daemonBefore.slotCode ||
    mqttPayload.slot?.layerNo !== daemonBefore.layerNo ||
    mqttPayload.slot?.cellNo !== daemonBefore.cellNo
  ) {
    throw new Error("MQTT vend command must correlate the daemon slot coordinates");
  }
  const rawFrames = Array.isArray(input.serial?.rawFrames) ? input.serial.rawFrames : [];
  const protocolFrames = rawFrames
    .map((frame, index) =>
      validateProductionRawSerialFrame(frame, `raw serial frame ${index + 1}`),
    )
    .filter((frame) => ["VEND", "F0", "F1", "F2"].includes(frame.parsedOpcode));
  if (JSON.stringify(protocolFrames.map((frame) => frame.parsedOpcode)) !== JSON.stringify(["VEND", "F0", "F1", "F2"])) {
    throw new Error("raw serial protocol must be VEND -> F0 -> F1 -> F2");
  }
  if (
    protocolFrames[0].direction !== "daemon-to-controller" ||
    protocolFrames.slice(1).some((frame) => frame.direction !== "controller-to-daemon")
  ) {
    throw new Error("raw serial protocol directions are invalid");
  }
  if (
    protocolFrames[1].rawFrameHex !== "55F0" ||
    protocolFrames[2].rawFrameHex !== "55F1" ||
    protocolFrames[3].rawFrameHex !== "55F2"
  ) {
    throw new Error("raw inbound serial protocol must expose exact production 55 F0/F1/F2 frames");
  }
  const uiViewport = input.uiViewport ?? {};
  if (
    uiViewport.innerWidth !== 1080 ||
    uiViewport.innerHeight !== 1920 ||
    uiViewport.documentClientWidth !== 1080 ||
    uiViewport.documentClientHeight !== 1920
  ) {
    throw new Error("installed UI viewport must be exactly 1080x1920");
  }
  const saleStartCapability = input.saleStartCapability ?? {};
  if (
    !Number.isInteger(saleStartCapability.revision) ||
    saleStartCapability.revision < 1
  ) {
    throw new Error("sale-start-capability must expose a positive revision");
  }
  if (saleStartCapability.canStartSale !== true) {
    throw new Error("sale-start-capability must allow the fast sale to start");
  }
  const mockOption = Array.isArray(saleStartCapability.paymentOptions?.options)
    ? saleStartCapability.paymentOptions.options.find(
        (option) =>
          option?.optionKey === "mock:mock" &&
          option?.providerCode === "mock" &&
          option?.method === "mock",
      )
    : null;
  if (
    !mockOption ||
    mockOption.ready !== true ||
    mockOption.disabledReason !== null
  ) {
    throw new Error(
      "sale-start-capability must expose a ready mock:mock payment option",
    );
  }
  const vendBytes = protocolFrames[0].bytes;
  if (vendBytes[1] !== daemonBefore.layerNo || vendBytes[2] !== daemonBefore.cellNo) {
    throw new Error("outbound serial vend frame must correlate the slot coordinates");
  }
  for (const report of [
    input.platform?.baseline,
    input.platform?.beforeF0,
    input.platform?.afterF1BeforeF2,
    input.platform?.afterF2,
  ]) {
    if (report?.scope?.machineCode !== machineCode || typeof report?.scope?.machineId !== "string" || report.scope.machineId === "") {
      throw new Error("platform evidence must preserve correlated machine scope at every boundary");
    }
  }
  if (!input.serial?.sessionId) throw new Error("serial session identity is required");
  const createOrderGate = input.createOrderGate ?? {};
  const gateObservedAt = Date.parse(createOrderGate.pendingObservedAt);
  const gateReleasedAt = Date.parse(createOrderGate.releasedAt);
  if (
    !Number.isFinite(gateObservedAt) ||
    !Number.isFinite(gateReleasedAt) ||
    gateReleasedAt < gateObservedAt
  ) {
    throw new Error("create-order gate must expose a pending boundary before release");
  }
  const vision = input.visionDelivery ?? {};
  if (
    vision.ok !== true ||
    typeof vision.eventId !== "string" ||
    vision.eventId === "" ||
    vision.connectedRuntimeClients < 1 ||
    vision.acceptedDeliveries < 1
  ) {
    throw new Error("Vision departure requires a connected installed runtime client and accepted delivery");
  }
  const visionAt = Date.parse(vision.timestamp);
  if (!(gateObservedAt <= visionAt && visionAt <= gateReleasedAt)) {
    throw new Error("Vision departure must occur while payment creation is explicitly pending");
  }
  const guardedDeparture = (Array.isArray(input.runtimeTrace) ? input.runtimeTrace : []).find(
    (entry) =>
      entry.type === "navigation" &&
      entry.intentType === "presence.departed" &&
      entry.sourceEventId === vision.eventId &&
      ["touchscreen_session_active", "active_transaction_route"].includes(entry.reasonCode) &&
      entry.decision === "rejected" &&
      entry.finalRoute !== "#/catalog" &&
      Number.isFinite(visionAt) &&
      Date.parse(entry.at) >= visionAt,
  );
  if (!guardedDeparture) {
    throw new Error("installed runtime trace must contain the guarded Vision departure navigation effect for the accepted eventId");
  }
  const runtimeTrace = Array.isArray(input.runtimeTrace) ? input.runtimeTrace : [];
  const spontaneousCatalog = runtimeTrace.some(
    (entry) =>
      entry.type === "navigation" &&
      Date.parse(entry.at) >= visionAt &&
      entry.finalRoute === "#/catalog",
  );
  if (spontaneousCatalog) throw new Error("runtime returned spontaneously to Catalog");
  const result = input.ui?.afterF2?.result;
  if (
    input.ui?.afterF2?.route !== "#/result/success" ||
    result?.kind !== "success" ||
    result.orderId !== order.id ||
    result.paymentId !== payment.id ||
    result.orderNo !== order.orderNo ||
    result.commandId !== command.id
  ) {
    throw new Error("successful UI result must correlate order, payment, and command after inbound F2");
  }
  const correlatedResultTrace = runtimeTrace.find(
    (entry) =>
      entry?.type === "transaction_surface" &&
      entry?.stage === "result" &&
      entry?.route === "#/result/success" &&
      entry?.orderId === order.id &&
      entry?.paymentId === payment.id &&
      entry?.commandId === command.id &&
      entry?.resultKind === "success",
  );
  if (!correlatedResultTrace) {
    throw new Error(
      "runtime trace must expose a correlated result surface for order, payment, and command",
    );
  }
  return {
    machineCode,
    machineId: input.platform.beforeF0.scope.machineId,
    orderId: order.id,
    orderNo: order.orderNo,
    paymentId: payment.id,
    paymentNo: payment.paymentNo,
    vendingCommandId: command.id,
    commandNo: command.commandNo,
    serialSessionId: input.serial.sessionId,
    inventoryId: orderItem.inventoryId,
    slotId: orderItem.slotId,
    slotCode: daemonBefore.slotCode,
    protocol: protocolFrames.map((frame) => frame.parsedOpcode),
    daemonStockDeltaAfterF2: daemonAfter.saleableStock - daemonMiddle.saleableStock,
    platformStockDeltaAfterF2: platformAfter.onHandQty - platformMiddle.onHandQty,
    movementId: movement.id,
    visionEventId: vision.eventId,
    guardedNavigationReason: guardedDeparture.reasonCode,
    saleStartCapabilityRevision: saleStartCapability.revision,
    mockPaymentOptionKey: mockOption.optionKey,
    uiViewport: {
      width: uiViewport.innerWidth,
      height: uiViewport.innerHeight,
    },
    runtimeTraceCorrelation: {
      traceEntryId: correlatedResultTrace.id,
      stage: correlatedResultTrace.stage,
      route: correlatedResultTrace.route,
      orderId: correlatedResultTrace.orderId,
      paymentId: correlatedResultTrace.paymentId,
      commandId: correlatedResultTrace.commandId,
      resultKind: correlatedResultTrace.resultKind,
      rawFrames: protocolFrames
        .filter((frame) => ["F0", "F1", "F2"].includes(frame.parsedOpcode))
        .map((frame) => ({
          parsedOpcode: frame.parsedOpcode,
          rawFrameHex: frame.rawFrameHex,
        })),
    },
    createOrderGateObservedAt: createOrderGate.pendingObservedAt,
    createOrderGateReleasedAt: createOrderGate.releasedAt,
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

async function waitForSuccessfulResultSurface(
  client,
  expected,
  timeoutMs = 60_000,
) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  do {
    last = await readUiBoundary(client).catch(() => null);
    if (
      last?.route === "#/result/success" &&
      last?.result?.kind === "success" &&
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
    `timed out waiting for #/result/success with correlated order/payment/command: ${JSON.stringify(last)}`,
  );
}

async function readRuntimeTrace(client) {
  return evaluateExpression(client, "window.__VEM_MACHINE_RUNTIME_TRACE__ || []");
}

async function readInstalledUiViewport(client) {
  return evaluateExpression(
    client,
    `(() => ({
      route: location.hash,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      documentClientWidth: document.documentElement.clientWidth,
      documentClientHeight: document.documentElement.clientHeight,
      visualViewportWidth: window.visualViewport?.width ?? null,
      visualViewportHeight: window.visualViewport?.height ?? null
    }))()`,
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
    throw new Error("required rendered customer UI payment hook is missing");
  }
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

async function waitForPlatformMovement(guestInput, input, baselineCount, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  do {
    last = (
      await controlPlaneRequest(guestInput, "/v1/platform/query", input)
    ).report;
    if (rows(last?.raw, "movements").length > baselineCount) return last;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  } while (Date.now() < deadline);
  throw new Error(`platform movement did not appear after inbound F2: ${JSON.stringify(last?.raw?.movements ?? [])}`);
}

async function waitForBeforeF0Boundary(
  guestInput,
  input,
  baselineRaw,
  renderedSale,
  liveSale,
  timeoutMs = 30_000,
) {
  const baselineOrders = rows(baselineRaw, "orders").length;
  const baselinePayments = rows(baselineRaw, "payments").length;
  const baselineCommands = rows(baselineRaw, "commands").length;
  const baselineMovements = rows(baselineRaw, "movements").length;
  const deadline = Date.now() + timeoutMs;
  let last = null;
  do {
    last = (
      await controlPlaneRequest(guestInput, "/v1/platform/query", input)
    ).report;
    const raw = last?.raw ?? {};
    const order = rows(raw, "orders").find((row) => row.id === renderedSale.orderId);
    const payment = rows(raw, "payments").find((row) => row.id === renderedSale.paymentId);
    const command = rows(raw, "commands").find((row) => row.id === liveSale.vendingCommandId);
    if (
      order &&
      payment &&
      command &&
      rows(raw, "orders").length === baselineOrders + 1 &&
      rows(raw, "payments").length === baselinePayments + 1 &&
      rows(raw, "commands").length === baselineCommands + 1 &&
      rows(raw, "movements").length === baselineMovements
    ) {
      return last;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  } while (Date.now() < deadline);
  throw new Error(
    `platform did not reach the pre-F0 correlated boundary: ${JSON.stringify(last?.raw ?? {})}`,
  );
}

function writeReport(outPath, report) {
  const path = localPath(outPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
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

function writeBoundedLogTail(sourcePath, outPath, label, maxBytes = 64 * 1024) {
  if (typeof sourcePath !== "string" || sourcePath === "") return null;
  try {
    const bytes = readFileSync(localPath(sourcePath));
    const root = join(dirname(localPath(outPath)), "fast-route-stress-sale-artifacts");
    mkdirSync(root, { recursive: true });
    const destination = join(root, `${label}.tail.log`);
    writeFileSync(destination, bytes.subarray(Math.max(0, bytes.length - maxBytes)));
    return { ref: destination, source: sourcePath, byteLength: Math.min(bytes.length, maxBytes) };
  } catch {
    return { ref: null, source: sourcePath, byteLength: 0 };
  }
}

function writeTextArtifact(outPath, label, text) {
  const root = join(dirname(localPath(outPath)), "fast-route-stress-sale-artifacts");
  mkdirSync(root, { recursive: true });
  const destination = join(root, `${label}.log`);
  writeFileSync(destination, String(text ?? ""));
  return { ref: destination, byteLength: Buffer.byteLength(String(text ?? ""), "utf8") };
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

export function buildFastRouteStressSaleFailureReport(input) {
  return {
    schemaVersion: "vem-fast-route-stress-sale/v2",
    ok: false,
    mode: input.mode,
    stage: input.stage,
    error:
      input.error instanceof Error
        ? {
            name: input.error.name,
            message: input.error.message,
            stack: String(input.error.stack ?? "").slice(0, 16 * 1024),
          }
        : { name: "Error", message: String(input.error) },
    controlPlaneSessionId: input.controlPlaneSessionId ?? null,
    liveSale: input.liveSale ?? null,
    runtimeTrace: compactRuntimeTrace(input.runtimeTrace ?? [], 256),
    snapshots: {
      platform: {
        baseline: input.snapshots?.platform?.baseline ?? null,
        beforeF0: input.snapshots?.platform?.beforeF0 ?? null,
        afterF1BeforeF2: input.snapshots?.platform?.afterF1BeforeF2 ?? null,
        afterF2: input.snapshots?.platform?.afterF2 ?? null,
      },
      daemon: {
        baseline: input.snapshots?.daemon?.baseline ?? null,
        beforeF0: input.snapshots?.daemon?.beforeF0 ?? null,
        afterF1BeforeF2: input.snapshots?.daemon?.afterF1BeforeF2 ?? null,
        afterF2: input.snapshots?.daemon?.afterF2 ?? null,
      },
    },
    hostEvidence: input.hostEvidence ?? null,
    checkpoints: input.checkpoints ?? [],
    logs: {
      daemonStdout: input.logs?.daemonStdout ?? null,
      daemonStderr: input.logs?.daemonStderr ?? null,
      platform: input.logs?.platform ?? null,
      platformError: input.logs?.platformError ?? null,
      simulator: input.logs?.simulator ?? null,
      failureScreenshots: (input.checkpoints ?? [])
        .map((checkpoint) => checkpoint?.screenshot?.ref)
        .filter(Boolean),
    },
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

async function collectPlatformLog(guestInput, sessionId, outPath) {
  const result = await controlPlaneRequest(
    guestInput,
    `/v1/serial-sessions/${sessionId}/platform-log`,
    { lines: 200 },
  );
  return {
    reference: result.reference ?? null,
    unit: result.unit,
    artifact: writeTextArtifact(outPath, "platform-service-api", result.log ?? ""),
  };
}

async function ensureControlledVisionMock(controlPort) {
  const healthUrl = "http://127.0.0.1:7892/health";
  try {
    await fetchJson(healthUrl);
    const status = await fetchJson(`http://127.0.0.1:${controlPort}/control/status`);
    if (status.scenario === "controlled") return { child: null, started: false };
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
      const status = await fetchJson(
        `http://127.0.0.1:${controlPort}/control/status`,
      );
      if (status.scenario === "controlled") {
        return { child, started: true };
      }
    } catch {
      await sleep(500);
    }
  }
  await shutdownControlledVisionMock(child);
  throw new Error("controlled vision mock did not become ready");
}

export async function shutdownControlledVisionMock(child, timeoutMs = 10_000) {
  if (!child) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolvePromise) => child.once("exit", resolvePromise)),
    sleep(timeoutMs),
  ]);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetchJson("http://127.0.0.1:7892/health");
      await sleep(250);
    } catch {
      return;
    }
  }
  throw new Error("controlled vision mock did not release port 7892 after SIGTERM");
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

async function completeMockPayment(guestInput, paymentNo) {
  const provisioningApiBaseUrl = required(
    guestInput?.runtimeBootstrap?.provisioningApiBaseUrl,
    "runtimeBootstrap.provisioningApiBaseUrl",
  );
  const apiBase = provisioningApiBaseUrl.replace(/\/+$/, "");
  return fetchJson(
    `${apiBase}/payments/mock/${encodeURIComponent(paymentNo)}/complete`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
    },
  );
}

async function runFastRouteStressSale(options) {
  let guestInput = null;
  let handoff = null;
  let vision = null;
  let client = null;
  let clientReady = false;
  let sessionStart = null;
  let liveSale = null;
  let saleStartCapability = null;
  let uiViewport = null;
  let baselineSaleView = null;
  let baselinePlatform = null;
  let beforeF0SaleView = null;
  let beforeF0Platform = null;
  let afterF1SaleView = null;
  let afterF1Platform = null;
  let afterF2SaleView = null;
  let afterF2Platform = null;
  let stage = "read-input";
  const checkpoints = [];
  const sink = screenshotSink(options.outPath);
  let createOrderGate = null;
  try {
    guestInput = readJson(options.guestInputPath, "guest input");
    handoff = readJson(options.handoffPath, "handoff");
    const runId = required(guestInput.runId, "runId");
    const machineCode = required(guestInput.machineCode, "machineCode");
    const saleCorrelationId = `sale-correlation://fast-route-${Date.now()}`;
    const steps = buildFastRouteStressScenarioSteps();
    createOrderGate = await armCreateOrderGate(guestInput);
    stage = "start-controlled-vision";
    vision = await ensureControlledVisionMock(
      guestInput.hostControlPlane?.visionMockControlPort ?? guestInput.visionMockControlPort,
    );
    stage = "connect-installed-tauri-cdp";
    const target = await discoverMachineUiTarget({
      endpoint: "http://127.0.0.1:9222",
      expectedTargetId: handoff.cdp.targetId,
    });
    client = new CdpClient(
      rewriteWebSocketDebuggerUrl(target.webSocketDebuggerUrl, "http://127.0.0.1:9222"),
    );
    await client.connect();
    await enablePageRuntime(client);
    clientReady = true;
    await waitForRoute(client, "#/catalog", { timeoutMs: 30_000, pollMs: 250 });
    stage = "snapshot-baseline";
    uiViewport = await readInstalledUiViewport(client);
    saleStartCapability = await daemonGet(handoff, "/v1/sale-start-capability");
    baselineSaleView = await daemonGet(handoff, "/v1/sale-view");
    baselinePlatform = (
      await controlPlaneRequest(guestInput, "/v1/platform/query", {
        runId,
        machineCode,
      })
    ).report;
    stage = "start-host-serial-session";
    sessionStart = await controlPlaneRequest(
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
    checkpoints.push(
      await captureCheckpoint(client, "catalog", {
        screenshot: true,
        screenshotSink: sink,
      }),
    );
    stage = "physical-catalog-to-checkout";
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
    stage = "wait-create-order-pending-boundary";
    const pendingCreate = await waitForCreateOrderGatePending(guestInput);
    stage = "vision-departure-during-create-order";
    const visionDelivery = await dispatchVisionDeparture(guestInput);
    const secondSubmit = await dispatchRepeatedPaymentTouch(client, firstSubmit);
    assert.match(secondSubmit.input.method, /Input\.dispatchTouchEvent/);
    const releasedCreateOrderGate = await releaseCreateOrderGate(
      guestInput,
      pendingCreate.paymentNo,
    );
    await waitForRoute(client, /^#\/payment/, { timeoutMs: 30_000, pollMs: 250 });
    checkpoints.push(
      await captureCheckpoint(client, "payment-creation", {
        screenshot: true,
        screenshotSink: sink,
      }),
    );
    const renderedSale = await readRenderedPaymentSurface(client);
    const pendingTransaction = await daemonGet(handoff, "/v1/transactions/current");
    if (pendingTransaction?.paymentNo !== pendingCreate.paymentNo) {
      throw new Error("released create-order gate paymentNo must match the rendered payment surface");
    }
    stage = "complete-mock-payment";
    await completeMockPayment(guestInput, pendingCreate.paymentNo);
    liveSale = await waitForCommand(handoff, renderedSale);
    stage = "snapshot-before-f0";
    const vendBoundary = await controlPlaneRequest(
      guestInput,
      `/v1/serial-sessions/${sessionStart.sessionId}/wait-frame`,
      { parsedOpcode: "VEND", timeoutMs: 30_000 },
    );
    beforeF0Platform = await waitForBeforeF0Boundary(
      guestInput,
      {
        runId,
        machineCode,
        sessionId: sessionStart.sessionId,
      },
      baselinePlatform.raw,
      renderedSale,
      liveSale,
    );
    beforeF0SaleView = await daemonGet(handoff, "/v1/sale-view");
    const beforeF0Ui = await readUiBoundary(client);
    checkpoints.push(
      await captureCheckpoint(client, "before-f0-active", {
        screenshot: true,
        screenshotSink: sink,
      }),
    );
    const releaseF0 = await controlPlaneRequest(
      guestInput,
      `/v1/serial-sessions/${sessionStart.sessionId}/release-f0`,
    );
    stage = "wait-inbound-f0";
    const f0Boundary = await controlPlaneRequest(
      guestInput,
      `/v1/serial-sessions/${sessionStart.sessionId}/wait-frame`,
      { parsedOpcode: "F0", timeoutMs: 30_000 },
    );
    stage = "wait-inbound-f1";
    const f1Boundary = await controlPlaneRequest(
      guestInput,
      `/v1/serial-sessions/${sessionStart.sessionId}/wait-frame`,
      { parsedOpcode: "F1", timeoutMs: 30_000 },
    );
    stage = "snapshot-after-f1-before-f2";
    afterF1SaleView = await daemonGet(handoff, "/v1/sale-view");
    afterF1Platform = (
      await controlPlaneRequest(guestInput, "/v1/platform/query", {
        runId,
        machineCode,
        sessionId: sessionStart.sessionId,
      })
    ).report;
    const afterF1Ui = await readUiBoundary(client);
    if (afterF1Ui.result?.kind === "success") {
      throw new Error("UI must not show success before inbound F2");
    }
    checkpoints.push(
      await captureCheckpoint(client, "after-f1-before-f2", {
        screenshot: true,
        screenshotSink: sink,
      }),
    );
    stage = "release-and-wait-inbound-f2";
    const releaseF2 = await controlPlaneRequest(
      guestInput,
      `/v1/serial-sessions/${sessionStart.sessionId}/release-f2`,
    );
    const f2Boundary = await controlPlaneRequest(
      guestInput,
      `/v1/serial-sessions/${sessionStart.sessionId}/wait-frame`,
      { parsedOpcode: "F2", timeoutMs: 30_000 },
    );
    stage = "collect-raw-serial-evidence";
    const collect = await controlPlaneRequest(
      guestInput,
      `/v1/serial-sessions/${sessionStart.sessionId}/evidence`,
    );
    stage = "wait-success-result";
    const resultSurface = await waitForSuccessfulResultSurface(
      client,
      {
        orderId: renderedSale.orderId,
        paymentId: renderedSale.paymentId,
        orderNo: renderedSale.orderNo,
        commandId: liveSale.vendingCommandId,
      },
      60_000,
    );
    checkpoints.push(
      await captureCheckpoint(client, "result", {
        screenshot: true,
        screenshotSink: sink,
      }),
    );
    afterF2SaleView = await daemonGet(handoff, "/v1/sale-view");
    afterF2Platform = await waitForPlatformMovement(
      guestInput,
      {
        runId,
        machineCode,
        sessionId: sessionStart.sessionId,
      },
      rows(afterF1Platform.raw, "movements").length,
    );
    const afterF2Ui = resultSurface;
    const runtimeTrace = await readRuntimeTrace(client);
    const platformLog = await collectPlatformLog(
      guestInput,
      sessionStart.sessionId,
      options.outPath,
    );
    const evidence = {
      saleCorrelationId,
      machineCode,
      runtimeTrace,
      createOrderGate: {
        controlPlane: createOrderGate.controlPlane,
        armedAt: createOrderGate.armedAt,
        paymentNo: pendingCreate.paymentNo,
        pendingObservedAt: pendingCreate.observedAt,
        releasedAt: releasedCreateOrderGate.releasedAt,
      },
      saleStartCapability,
      uiViewport,
      visionDelivery,
      renderedSale,
      liveSale,
      platform: {
        baseline: baselinePlatform,
        beforeF0: beforeF0Platform,
        afterF1BeforeF2: afterF1Platform,
        afterF2: afterF2Platform,
      },
      daemon: {
        baseline: baselineSaleView,
        beforeF0: beforeF0SaleView,
        afterF1BeforeF2: afterF1SaleView,
        afterF2: afterF2SaleView,
      },
      ui: {
        beforeF0: beforeF0Ui,
        afterF1BeforeF2: afterF1Ui,
        afterF2: afterF2Ui,
      },
      mqttMessages: collect.mqtt?.messages ?? [],
      serial: {
        sessionId: sessionStart.binding.serialSessionId,
        rawFrames: collect.rawFrames ?? [],
      },
    };
    const summary = validateFastRouteStressSaleEvidence(evidence);
    stage = "stop-host-serial-session";
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
    const report = {
      schemaVersion: "vem-fast-route-stress-sale/v2",
      ok: true,
      mode: options.mode,
      runId,
      machineCode,
      resultRoute: resultSurface.route,
      controlPlaneSessionId: sessionStart.sessionId,
      renderedSale,
      liveSale,
      summary,
      boundaries: {
        vend: vendBoundary.frame,
        releaseF0,
        f0: f0Boundary.frame,
        f1: f1Boundary.frame,
        releaseF2,
        f2: f2Boundary.frame,
      },
      evidence: compactEvidenceForReport(evidence, summary),
      serial: {
        start: sessionStart,
        collect,
        stop,
        stopRepeat,
      },
      runtimeTrace: compactRuntimeTrace(runtimeTrace),
      checkpoints,
      logs: {
        daemonStdout: writeBoundedLogTail(
          handoff?.daemon?.logs?.stdout,
          options.outPath,
          "daemon-stdout",
        ),
        daemonStderr: writeBoundedLogTail(
          handoff?.daemon?.logs?.stderr,
          options.outPath,
          "daemon-stderr",
        ),
        platform: platformLog.artifact,
        milestones: checkpoints.map((checkpoint) => ({
          label: checkpoint.label,
          route: checkpoint.identity.route,
          screenshot: checkpoint.screenshot?.ref ?? null,
        })),
      },
    };
    writeReport(options.outPath, report);
    return report;
  } catch (error) {
    const failureCheckpoints = [...checkpoints];
    if (clientReady) {
      const failure = await captureCheckpoint(client, `failure-${stage}`, {
        screenshot: true,
        screenshotSink: sink,
      }).catch(() => null);
      if (failure) failureCheckpoints.push(failure);
    }
    const runtimeTrace = clientReady
      ? await readRuntimeTrace(client).catch(() => [])
      : [];
    const platformLog = guestInput && sessionStart
      ? await collectPlatformLog(
          guestInput,
          sessionStart.sessionId,
          options.outPath,
        ).catch((platformError) => ({
          error:
            platformError instanceof Error
              ? platformError.message
              : String(platformError),
        }))
      : null;
    const hostEvidence = guestInput && sessionStart
      ? await controlPlaneRequest(
          guestInput,
          `/v1/serial-sessions/${sessionStart.sessionId}/evidence`,
        ).catch(() => null)
      : null;
    if (guestInput && sessionStart) {
      await controlPlaneRequest(
        guestInput,
        `/v1/serial-sessions/${sessionStart.sessionId}/abort`,
      ).catch(() => null);
    }
    const report = buildFastRouteStressSaleFailureReport({
      mode: options.mode,
      stage,
      error,
      controlPlaneSessionId: sessionStart?.sessionId ?? null,
      liveSale,
      runtimeTrace,
      snapshots: {
        platform: {
          baseline: baselinePlatform,
          beforeF0: beforeF0Platform,
          afterF1BeforeF2: afterF1Platform,
          afterF2: afterF2Platform,
        },
        daemon: {
          baseline: baselineSaleView,
          beforeF0: beforeF0SaleView,
          afterF1BeforeF2: afterF1SaleView,
          afterF2: afterF2SaleView,
        },
      },
      hostEvidence,
      checkpoints: failureCheckpoints,
      logs: {
        daemonStdout: writeBoundedLogTail(
          handoff?.daemon?.logs?.stdout,
          options.outPath,
          "daemon-stdout",
        ),
        daemonStderr: writeBoundedLogTail(
          handoff?.daemon?.logs?.stderr,
          options.outPath,
          "daemon-stderr",
        ),
        platform: platformLog?.artifact ?? null,
        platformError: platformLog?.error ?? null,
        simulator: hostEvidence?.references?.simulatorLog ?? null,
      },
    });
    writeReport(options.outPath, report);
    throw error;
  } finally {
    if (guestInput && createOrderGate) {
      await openCreateOrderGate(guestInput).catch(() => null);
    }
    await client?.close().catch(() => undefined);
    await shutdownControlledVisionMock(vision?.child).catch(() => undefined);
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
