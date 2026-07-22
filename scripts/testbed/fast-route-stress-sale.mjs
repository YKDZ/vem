#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { catalogProductSelectorForFixture } from "./full-workflow-fixtures.mjs";
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
const CLEANUP_TIMEOUT_MS = 10_000;
function required(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function processLiveness(processId) {
  if (!Number.isInteger(processId) || processId < 1) return null;
  try {
    process.kill(processId, 0);
    return { processId, alive: true };
  } catch (error) {
    return {
      processId,
      alive: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function timestamp(value, label) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed))
    throw new Error(`${label} must be an ISO timestamp`);
  return parsed;
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

function optionalOption(args, name) {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? null : required(args[index + 1], `--${name}`);
}

export function parseFastRouteStressSaleArgs(args) {
  const mode = required(option(args, "mode"), "--mode");
  if (!MODES.has(mode)) throw new Error("--mode must be fast or full");
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

export function buildFastRouteStressScenarioSteps(
  productSelector = '[data-test="catalog-product"]',
) {
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
      selector: productSelector,
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
  throw new Error(
    "mock create-order gate did not observe a pending payment creation",
  );
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
  return await controlPlaneRequest(
    guestInput,
    "/v1/mock-payment-create-gate/open",
  );
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
      inventory.id === identity.inventoryId &&
      inventory.slotId === identity.slotId,
  );
}

function matchingRowById(raw, key, id) {
  return rows(raw, key).find((row) => row.id === id);
}

function compactRuntimeTrace(trace, maxEntries = 64) {
  return Array.isArray(trace) ? trace.slice(-maxEntries) : [];
}

function traceBoundary(entries, label) {
  if (!Array.isArray(entries)) {
    throw new Error(
      `${label} requires an installed Machine Runtime Trace array`,
    );
  }
  return {
    source: "installed_machine_runtime_trace_cdp",
    entryCount: entries.length,
    capturedAt: new Date().toISOString(),
  };
}

function traceEntriesAfterBoundary(entries, boundary, label) {
  if (
    boundary?.source !== "installed_machine_runtime_trace_cdp" ||
    !Number.isInteger(boundary?.entryCount) ||
    boundary.entryCount < 0 ||
    boundary.entryCount > entries.length ||
    !Number.isFinite(Date.parse(boundary?.capturedAt))
  ) {
    throw new Error(
      `${label} must retain an installed-CDP trace entry boundary and capture timestamp`,
    );
  }
  return entries.slice(boundary.entryCount);
}

function isCatalogRoute(route) {
  if (typeof route !== "string") return false;
  return route.replace(/^#/, "") === "/catalog";
}

function isCatalogOrRootLocationHash(value) {
  const hash = String(value ?? "");
  if (hash === "" || hash === "#" || hash === "#/") return true;
  if (!hash.startsWith("#/")) {
    throw new Error(`invalid CDP location.hash observation: ${hash}`);
  }
  const route = new URL(hash.slice(1), "http://machine-route.invalid");
  return route.pathname.toLowerCase() === "/catalog";
}

function isCatalogLocationHash(value) {
  const hash = String(value ?? "");
  if (!hash.startsWith("#/")) return false;
  const route = new URL(hash.slice(1), "http://machine-route.invalid");
  return route.pathname.toLowerCase() === "/catalog";
}

function locationHashFromCdpUrl(value, label) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new Error(`${label} must expose an absolute CDP page URL`);
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "tauri.localhost" ||
    url.port !== "" ||
    url.pathname !== "/" ||
    url.search !== ""
  ) {
    throw new Error(`${label} must retain the installed Tauri page origin`);
  }
  return url.hash;
}

function compactPlatformBoundary(report, summary) {
  const raw = report?.raw ?? {};
  return {
    scope: report?.scope ?? null,
    order: matchingRowById(raw, "orders", summary.orderId) ?? null,
    orderItem:
      rows(raw, "orderItems").find(
        (row) =>
          row.inventoryId === summary.inventoryId &&
          row.slotId === summary.slotId,
      ) ?? null,
    payment: matchingRowById(raw, "payments", summary.paymentId) ?? null,
    command: matchingRowById(raw, "commands", summary.vendingCommandId) ?? null,
    movement: matchingRowById(raw, "movements", summary.movementId) ?? null,
    inventory:
      rows(raw, "inventories").find(
        (row) =>
          row.id === summary.inventoryId && row.slotId === summary.slotId,
      ) ?? null,
  };
}

function compactDaemonBoundary(view, summary) {
  return {
    item:
      rows(view, "items").find(
        (row) =>
          row.inventoryId === summary.inventoryId &&
          row.slotId === summary.slotId,
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
    noCatalogTraceBoundary: evidence.noCatalogTraceBoundary,
    repeatedPaymentTouch: evidence.repeatedPaymentTouch,
    continuousCdpLocationHash: evidence.continuousCdpLocationHash,
    saleStartCapability: evidence.saleStartCapability,
    uiViewport: evidence.uiViewport,
    visionDelivery: evidence.visionDelivery,
    platform: {
      baseline: compactPlatformBoundary(evidence.platform?.baseline, summary),
      beforeF0: compactPlatformBoundary(evidence.platform?.beforeF0, summary),
      afterF1BeforeF2: compactPlatformBoundary(
        evidence.platform?.afterF1BeforeF2,
        summary,
      ),
      afterF2: compactPlatformBoundary(evidence.platform?.afterF2, summary),
    },
    daemon: {
      baseline: compactDaemonBoundary(evidence.daemon?.baseline, summary),
      beforeF0: compactDaemonBoundary(evidence.daemon?.beforeF0, summary),
      afterF1BeforeF2: compactDaemonBoundary(
        evidence.daemon?.afterF1BeforeF2,
        summary,
      ),
      afterF2: compactDaemonBoundary(evidence.daemon?.afterF2, summary),
    },
    ui: evidence.ui,
    mqttMessages: Array.isArray(evidence.mqttMessages)
      ? evidence.mqttMessages.slice(-2)
      : [],
    serial: {
      sessionId: evidence.serial?.sessionId ?? null,
      rawFrames: Array.isArray(evidence.serial?.rawFrames)
        ? evidence.serial.rawFrames
            .filter((frame) =>
              ["VEND", "F0", "F1", "F2"].includes(frame?.parsedOpcode),
            )
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
  const createOrderGate = input.createOrderGate ?? {};
  const machineCode = required(input.machineCode, "machineCode");
  const order = exactlyOne(
    deltaRows(baseline, afterF1, "orders"),
    "expected exactly one correlated order",
  );
  if (
    order.id !== rendered.orderId ||
    order.id !== live.orderId ||
    order.orderNo !== rendered.orderNo ||
    order.orderNo !== live.orderNo
  ) {
    throw new Error(
      "rendered, daemon, and platform order identities must match",
    );
  }
  const orderItem = exactlyOne(
    rows(afterF1, "orderItems").filter((row) => row.orderId === order.id),
    "expected exactly one correlated order item",
  );
  const payment = exactlyOne(
    deltaRows(baseline, afterF1, "payments").filter(
      (row) => row.orderId === order.id,
    ),
    "expected exactly one correlated payment",
  );
  if (payment.id !== rendered.paymentId || payment.id !== live.paymentId) {
    throw new Error(
      "rendered, daemon, and platform payment identities must match",
    );
  }
  const command = exactlyOne(
    deltaRows(baseline, afterF1, "commands").filter(
      (row) => row.orderId === order.id && row.orderItemId === orderItem.id,
    ),
    "expected exactly one correlated vending command",
  );
  if (
    command.id !== live.vendingCommandId ||
    command.slotId !== orderItem.slotId
  ) {
    throw new Error(
      "daemon and platform vending command identities must match the order slot",
    );
  }
  if (
    deltaRows(baseline, afterF2, "orders").length !== 1 ||
    deltaRows(baseline, afterF2, "payments").length !== 1 ||
    deltaRows(baseline, afterF2, "commands").length !== 1
  ) {
    throw new Error(
      "duplicate order, payment, or vending command appeared after inbound F2",
    );
  }
  if (
    deltaRows(baseline, beforeF0, "orders").length !== 1 ||
    deltaRows(baseline, beforeF0, "payments").length !== 1 ||
    deltaRows(baseline, beforeF0, "commands").length !== 1
  ) {
    throw new Error(
      "before inbound F0 the correlated order, payment, and vending command must already exist exactly once",
    );
  }
  const beforeF0Payment = matchingRowById(beforeF0, "payments", payment.id);
  const beforeF0Command = matchingRowById(beforeF0, "commands", command.id);
  if (
    beforeF0Payment?.orderId !== order.id ||
    beforeF0Command?.orderId !== order.id ||
    beforeF0Command?.orderItemId !== orderItem.id
  ) {
    throw new Error(
      "authoritative platform payment and command facts must bind the same sale before host raw F0",
    );
  }
  if (
    beforeF0Payment.paymentNo !==
    required(createOrderGate.paymentNo, "create-order gate paymentNo")
  ) {
    throw new Error(
      "authoritative pre-F0 paymentNo must match the create-order gate paymentNo",
    );
  }
  if (beforeF0Payment.status !== "succeeded") {
    throw new Error("authoritative pre-F0 payment status must be succeeded");
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
  if (
    !baselineInventory ||
    !daemonBefore ||
    !daemonMiddle ||
    !daemonAfter ||
    !platformBefore ||
    !platformMiddle ||
    !platformAfter
  ) {
    throw new Error(
      "all temporal boundaries require the correlated slot inventory snapshot",
    );
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
    throw new Error(
      "correlated daemon and platform stock must remain unchanged through inbound F1",
    );
  }
  if (
    daemonAfter.physicalStock - daemonMiddle.physicalStock !== -1 ||
    daemonAfter.saleableStock !== daemonMiddle.saleableStock
  ) {
    throw new Error(
      "correlated daemon physical stock must decrement exactly once without double-decrementing saleable stock after inbound F2",
    );
  }
  if (platformAfter.onHandQty - platformMiddle.onHandQty !== -1) {
    throw new Error(
      "correlated platform inventory must decrement exactly once after inbound F2",
    );
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
    throw new Error(
      "platform movement must correlate order, command, item, inventory, and slot",
    );
  }
  const afterF2Order = matchingRowById(afterF2, "orders", order.id);
  const afterF2Payment = matchingRowById(afterF2, "payments", payment.id);
  const afterF2Command = matchingRowById(afterF2, "commands", command.id);
  if (
    afterF2Payment?.orderId !== order.id ||
    afterF2Payment?.paymentNo !== createOrderGate.paymentNo ||
    afterF2Payment.paymentNo !== beforeF0Payment.paymentNo ||
    afterF2Payment?.status !== "succeeded"
  ) {
    throw new Error(
      "authoritative post-F2 payment must retain the gated paymentNo and succeeded status",
    );
  }
  if (
    afterF2Order?.status !== "fulfilled" ||
    afterF2Order?.paymentState !== "paid" ||
    afterF2Order?.fulfillmentState !== "dispensed" ||
    afterF2Command?.commandKind !== "dispatch" ||
    afterF2Command?.status !== "succeeded"
  ) {
    throw new Error(
      "authoritative post-F2 order and dispatch command must be fulfilled, paid, dispensed, and succeeded",
    );
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
    throw new Error(
      `MQTT vend command must correlate commandNo ${command.commandNo}`,
    );
  }
  if (mqttPayload.orderNo !== order.orderNo || mqttPayload.quantity !== 1) {
    throw new Error("MQTT vend command must correlate order and quantity");
  }
  if (
    mqttPayload.slot?.slotCode !== daemonBefore.slotCode ||
    mqttPayload.slot?.layerNo !== daemonBefore.layerNo ||
    mqttPayload.slot?.cellNo !== daemonBefore.cellNo
  ) {
    throw new Error(
      "MQTT vend command must correlate the daemon slot coordinates",
    );
  }
  const rawFrames = Array.isArray(input.serial?.rawFrames)
    ? input.serial.rawFrames
    : [];
  const observedProtocolFrames = rawFrames
    .map((frame, index) =>
      validateProductionRawSerialFrame(frame, `raw serial frame ${index + 1}`),
    )
    .filter((frame) => ["VEND", "F0", "F1", "F2"].includes(frame.parsedOpcode));
  const protocolFrames = observedProtocolFrames.filter(
    (frame, index) =>
      index === 0 ||
      frame.parsedOpcode !== observedProtocolFrames[index - 1].parsedOpcode,
  );
  if (
    JSON.stringify(protocolFrames.map((frame) => frame.parsedOpcode)) !==
    JSON.stringify(["VEND", "F0", "F1", "F2"])
  ) {
    throw new Error("raw serial protocol must be VEND -> F0 -> F1 -> F2");
  }
  if (
    protocolFrames[0].direction !== "daemon-to-controller" ||
    protocolFrames
      .slice(1)
      .some((frame) => frame.direction !== "controller-to-daemon")
  ) {
    throw new Error("raw serial protocol directions are invalid");
  }
  if (
    protocolFrames[1].rawFrameHex !== "55F0" ||
    protocolFrames[2].rawFrameHex !== "55F1" ||
    protocolFrames[3].rawFrameHex !== "55F2"
  ) {
    throw new Error(
      "raw inbound serial protocol must expose exact production 55 F0/F1/F2 frames",
    );
  }
  const serialSessionId = required(
    input.serial?.sessionId,
    "serial session identity",
  );
  const frameBoundaries = protocolFrames.slice(1);
  let previousFrameCapturedAt = -Infinity;
  for (const frame of frameBoundaries) {
    if (
      frame.provenance !== "host_pty_raw_serial_journal" ||
      frame.sessionId !== serialSessionId ||
      frame.boundaryId !== `host-pty:${serialSessionId}:${frame.sequence}`
    ) {
      throw new Error(
        "F0/F1/F2 must retain host PTY raw-journal provenance and boundary/session identity",
      );
    }
    const capturedAt = timestamp(
      frame.capturedAt,
      `host raw ${frame.parsedOpcode} capturedAt`,
    );
    if (capturedAt <= previousFrameCapturedAt) {
      throw new Error(
        "host raw F0/F1/F2 capturedAt values must be strictly ordered",
      );
    }
    previousFrameCapturedAt = capturedAt;
  }
  const f0CapturedAt = timestamp(
    frameBoundaries[0].capturedAt,
    "host raw F0 capturedAt",
  );
  timestamp(frameBoundaries.at(-1).capturedAt, "host raw F2 capturedAt");
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
  if (
    vendBytes[1] !== daemonBefore.layerNo ||
    vendBytes[2] !== daemonBefore.cellNo
  ) {
    throw new Error(
      "outbound serial vend frame must correlate the slot coordinates",
    );
  }
  for (const report of [
    input.platform?.baseline,
    input.platform?.beforeF0,
    input.platform?.afterF1BeforeF2,
    input.platform?.afterF2,
  ]) {
    if (
      report?.source !== "authoritative_ephemeral_platform_database" ||
      !Number.isFinite(Date.parse(report?.capturedAt)) ||
      report?.scope?.machineCode !== machineCode ||
      typeof report?.scope?.machineId !== "string" ||
      report.scope.machineId === ""
    ) {
      throw new Error(
        "platform evidence must retain authoritative provenance, capturedAt, and correlated machine scope at every boundary",
      );
    }
  }
  if (
    timestamp(
      input.platform.beforeF0.capturedAt,
      "platform payment snapshot capturedAt",
    ) > f0CapturedAt
  ) {
    throw new Error(
      "platform payment snapshot must be captured no later than host raw F0",
    );
  }
  if (!input.serial?.sessionId)
    throw new Error("serial session identity is required");
  const gateObservedAt = Date.parse(createOrderGate.pendingObservedAt);
  const gateReleasedAt = Date.parse(createOrderGate.releasedAt);
  if (
    !Number.isFinite(gateObservedAt) ||
    !Number.isFinite(gateReleasedAt) ||
    gateReleasedAt < gateObservedAt
  ) {
    throw new Error(
      "create-order gate must expose a pending boundary before release",
    );
  }
  const vision = input.visionDelivery ?? {};
  const repeatedPaymentTouch = input.repeatedPaymentTouch ?? {};
  const pendingConfirmedAt = timestamp(
    repeatedPaymentTouch.pendingConfirmedAt,
    "guest-local payment gate pending confirmation",
  );
  const releaseRequestedAt = timestamp(
    repeatedPaymentTouch.releaseRequestedAt,
    "guest-local payment gate release request",
  );
  if (releaseRequestedAt < pendingConfirmedAt) {
    throw new Error(
      "guest-local payment gate sequence must confirm pending before release",
    );
  }
  if (
    vision.ok !== true ||
    typeof vision.eventId !== "string" ||
    vision.eventId === "" ||
    vision.connectedRuntimeClients < 1 ||
    vision.acceptedDeliveries < 1
  ) {
    throw new Error(
      "Vision departure requires a connected installed runtime client and accepted delivery",
    );
  }
  const visionRequestedAt = timestamp(
    vision.requestedAt,
    "guest-local Vision departure request",
  );
  const visionCompletedAt = timestamp(
    vision.completedAt,
    "guest-local Vision departure completion",
  );
  if (
    !(
      pendingConfirmedAt <= visionRequestedAt &&
      visionRequestedAt <= visionCompletedAt &&
      visionCompletedAt <= releaseRequestedAt
    )
  ) {
    throw new Error(
      "Vision departure must occur while payment creation is explicitly pending",
    );
  }
  const continuousHash = input.continuousCdpLocationHash ?? {};
  if (
    continuousHash.source !== "cdp_page_navigation_events_and_location_hash" ||
    continuousHash.initialHash !== "#/catalog" ||
    !Number.isFinite(Date.parse(continuousHash.startedAt)) ||
    !Number.isFinite(Date.parse(continuousHash.armedAt)) ||
    !Number.isFinite(Date.parse(continuousHash.terminalAt)) ||
    !Array.isArray(continuousHash.entries) ||
    continuousHash.entries.length < 2
  ) {
    throw new Error(
      "continuous CDP location.hash observation must span Catalog exit through terminal result",
    );
  }
  let previousHashSequence = 0;
  let previousHashObservedAt = -Infinity;
  for (const entry of continuousHash.entries) {
    const observedAt = timestamp(
      entry?.observedAt,
      "continuous CDP location.hash observedAt",
    );
    if (
      !Number.isInteger(entry?.sequence) ||
      entry.sequence <= previousHashSequence ||
      observedAt < previousHashObservedAt ||
      ![
        "Page.navigatedWithinDocument",
        "Page.frameNavigated",
        "Runtime.evaluate(location.hash)",
      ].includes(entry?.method)
    ) {
      throw new Error(
        "continuous CDP location.hash entries must retain ordered protocol provenance",
      );
    }
    if (isCatalogOrRootLocationHash(entry.locationHash)) {
      throw new Error(
        "continuous CDP location.hash observation reached Catalog or root",
      );
    }
    previousHashSequence = entry.sequence;
    previousHashObservedAt = observedAt;
  }
  const firstHashEntry = continuousHash.entries[0];
  const terminalHashEntry = continuousHash.entries.at(-1);
  if (
    firstHashEntry.method === "Runtime.evaluate(location.hash)" ||
    firstHashEntry.observedAt !== continuousHash.armedAt ||
    continuousHash.terminalHash !== "#/result/success" ||
    terminalHashEntry.locationHash !== continuousHash.terminalHash ||
    timestamp(continuousHash.armedAt, "continuous CDP armedAt") <
      timestamp(continuousHash.startedAt, "continuous CDP startedAt") ||
    timestamp(continuousHash.terminalAt, "continuous CDP terminalAt") <
      previousHashObservedAt
  ) {
    throw new Error(
      "continuous CDP location.hash observation must arm on Catalog exit and end at terminal result",
    );
  }
  const machineRuntimeTrace = input.machineRuntimeTrace ?? {};
  if (
    machineRuntimeTrace.source !== "installed_machine_runtime_trace_cdp" ||
    !Number.isFinite(Date.parse(machineRuntimeTrace.capturedAt)) ||
    !Array.isArray(machineRuntimeTrace.entries)
  ) {
    throw new Error(
      "Machine Runtime Trace must retain direct installed-CDP provenance and capture timestamp",
    );
  }
  const runtimeTrace = machineRuntimeTrace.entries;
  const noCatalogTrace = traceEntriesAfterBoundary(
    runtimeTrace,
    input.noCatalogTraceBoundary,
    "no-Catalog trace boundary",
  );
  const repeatedTouchTrace = traceEntriesAfterBoundary(
    runtimeTrace,
    repeatedPaymentTouch.preDispatchTraceBoundary,
    "repeated payment touch pre-dispatch trace boundary",
  );
  const repeatedTouch = repeatedTouchTrace.find(
    (entry) =>
      entry?.type === "navigation" &&
      entry?.intentType === "customer.touch" &&
      entry?.decision === "accepted" &&
      entry?.reasonCode === "touchscreen_session_renewed" &&
      entry?.id === repeatedPaymentTouch.traceEntryId,
  );
  if (!repeatedTouch) {
    throw new Error(
      "installed runtime trace must record the repeated physical customer.touch after its pre-dispatch boundary",
    );
  }
  const guardedDeparture = runtimeTrace.find(
    (entry) =>
      entry.type === "navigation" &&
      entry.intentType === "presence.departed" &&
      entry.sourceEventId === vision.eventId &&
      ["touchscreen_session_active", "active_transaction_route"].includes(
        entry.reasonCode,
      ) &&
      entry.decision === "rejected" &&
      entry.finalRoute !== "#/catalog",
  );
  if (!guardedDeparture) {
    throw new Error(
      "installed runtime trace must contain the guarded Vision departure navigation effect for the accepted eventId",
    );
  }
  const projectionRefresh = runtimeTrace.find(
    (entry) =>
      entry?.type === "navigation" &&
      entry?.intentType === "transaction.projection" &&
      entry?.decision === "accepted" &&
      ["transaction_projection", "transaction_projection_current"].includes(
        entry?.reasonCode,
      ) &&
      entry?.transactionOrderNo === order.orderNo &&
      entry?.finalRoute !== "#/catalog" &&
      Number.isFinite(entry?.id) &&
      Number.isFinite(guardedDeparture?.id) &&
      entry.id > guardedDeparture.id,
  );
  if (!projectionRefresh) {
    throw new Error(
      "runtime trace must contain the real transaction projection refresh for the correlated order after Vision departure",
    );
  }
  const result = input.ui?.afterF2?.result;
  if (
    input.ui?.afterF2?.route !== "#/result/success" ||
    result?.kind !== "success" ||
    result.orderId !== order.id ||
    result.paymentId !== payment.id ||
    result.orderNo !== order.orderNo ||
    result.commandId !== command.id
  ) {
    throw new Error(
      "successful UI result must correlate order, payment, and command after inbound F2",
    );
  }
  const correlatedResultTraces = runtimeTrace.filter(
    (entry) =>
      entry?.type === "transaction_surface" &&
      entry?.stage === "result" &&
      entry?.route === "#/result/success" &&
      entry?.orderId === order.id &&
      entry?.paymentId === payment.id &&
      entry?.commandId === command.id &&
      entry?.resultKind === "success",
  );
  const correlatedResultTrace = correlatedResultTraces.find((entry) => {
    timestamp(entry?.recordedAt, "Machine Runtime Trace success recordedAt");
    return entry.at === entry.recordedAt;
  });
  if (!correlatedResultTrace) {
    throw new Error(
      "runtime trace must expose a correlated result surface with its raw timestamp",
    );
  }
  const resultTraceIndex = runtimeTrace.indexOf(correlatedResultTrace);
  const noCatalogResultIndex = noCatalogTrace.indexOf(correlatedResultTrace);
  if (resultTraceIndex < 0 || noCatalogResultIndex < 0) {
    throw new Error(
      "no-Catalog trace boundary must precede the correlated terminal result",
    );
  }
  const catalogNavigation = noCatalogTrace
    .slice(0, noCatalogResultIndex + 1)
    .find(
      (entry) =>
        entry?.type === "navigation" &&
        (isCatalogRoute(entry.finalRoute) ||
          isCatalogRoute(entry.decidedRoute) ||
          isCatalogRoute(entry.targetRoute)),
    );
  if (catalogNavigation) {
    throw new Error(
      "runtime trace contains an actual or decided Catalog navigation after the stressed customer flow began",
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
    serialSessionId,
    inventoryId: orderItem.inventoryId,
    slotId: orderItem.slotId,
    slotCode: daemonBefore.slotCode,
    protocol: protocolFrames.map((frame) => frame.parsedOpcode),
    daemonStockDeltaAfterF2:
      daemonAfter.physicalStock - daemonMiddle.physicalStock,
    platformStockDeltaAfterF2:
      platformAfter.onHandQty - platformMiddle.onHandQty,
    movementId: movement.id,
    visionEventId: vision.eventId,
    repeatedPhysicalTouchTraceId: repeatedTouch.id ?? null,
    repeatedPhysicalTouchAt: repeatedTouch.at,
    guardedNavigationReason: guardedDeparture.reasonCode,
    projectionRefreshReason: projectionRefresh.reasonCode,
    projectionRefreshRoute: projectionRefresh.finalRoute,
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
          capturedAt: frame.capturedAt,
          boundaryId: frame.boundaryId,
          sessionId: frame.sessionId,
          provenance: frame.provenance,
        })),
      resultRecordedAt: correlatedResultTrace.recordedAt,
    },
    createOrderGateObservedAt: createOrderGate.pendingObservedAt,
    createOrderGateReleasedAt: createOrderGate.releasedAt,
  };
}

function localPath(path) {
  return process.platform === "win32"
    ? path
    : resolve(
        `/mnt/${path[0].toLowerCase()}/${path.slice(3).replaceAll("\\", "/")}`,
      );
}

function readJson(path, label) {
  return JSON.parse(readFileSync(localPath(path), "utf8"));
}

function daemonBaseUrl(handoff) {
  const healthzUrl = required(
    handoff.daemon?.ready?.healthzUrl,
    "daemon healthzUrl",
  );
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

async function daemonPost(handoff, path, body = {}) {
  return fetchJson(`${daemonBaseUrl(handoff)}${path}`, {
    method: "POST",
    headers: {
      ...daemonHeaders(handoff),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function transactionIsActive(transaction) {
  return (
    ["wait_payment", "dispensing"].includes(transaction?.nextAction) ||
    ["pending_payment", "waiting_payment", "paid", "dispensing"].includes(
      transaction?.orderStatus,
    )
  );
}

export async function settlePendingCreateOrder({
  paymentNo,
  timeoutMs = 15_000,
  readTransaction,
  cancelTransaction,
  wait = sleep,
  now = () => Date.now(),
}) {
  const deadline = now() + timeoutMs;
  let transaction = null;
  while (now() < deadline) {
    transaction = await readTransaction();
    if (transaction?.paymentNo === paymentNo) break;
    await wait(100);
  }
  if (transaction?.paymentNo !== paymentNo) {
    throw new Error(
      `released payment create request did not project transaction ${paymentNo}`,
    );
  }
  if (!transactionIsActive(transaction)) return transaction;
  await cancelTransaction(transaction);
  while (now() < deadline) {
    transaction = await readTransaction();
    if (
      transaction?.paymentNo === paymentNo &&
      !transactionIsActive(transaction)
    ) {
      return transaction;
    }
    await wait(100);
  }
  throw new Error(
    `transaction ${paymentNo} remained active after cancellation`,
  );
}

export async function waitForSaleStartReady(
  handoff,
  client,
  timeoutMs = 30_000,
  {
    now = () => Date.now(),
    readRoute = readCdpLocationHash,
    readCapability = (input) => daemonGet(input, "/v1/sale-start-capability"),
    wait = sleep,
  } = {},
) {
  const deadline = now() + timeoutMs;
  let stableSince = null;
  let last = null;
  while (now() < deadline) {
    const [route, capability] = await Promise.all([
      readRoute(client),
      readCapability(handoff),
    ]);
    last = { route, capability };
    if (route === "#/catalog" && capability?.canStartSale === true) {
      stableSince ??= now();
      if (now() - stableSince >= 3_000) return capability;
    } else {
      stableSince = null;
    }
    await wait(250);
  }
  throw new Error(
    `installed sale startup did not settle before interaction: ${JSON.stringify(last)}`,
  );
}

async function waitForCommand(handoff, renderedSale, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastTransaction = null;
  while (Date.now() < deadline) {
    const transaction = await daemonGet(
      handoff,
      "/v1/transactions/current",
    ).catch(() => null);
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
  return evaluateExpression(
    client,
    "window.__VEM_MACHINE_RUNTIME_TRACE__ || []",
  );
}

async function readCdpLocationHash(client) {
  return evaluateExpression(client, "location.hash");
}

export async function startContinuousCdpLocationHashObservation(
  client,
  { clock = () => new Date() } = {},
) {
  const entries = [];
  const startedAt = clock().toISOString();
  let armedAt = null;
  let terminalAt = null;
  let terminalHash = null;
  let stopped = false;
  let failure = null;

  const recordHash = (method, locationHash) => {
    if (stopped || failure) return;
    try {
      if (armedAt === null && isCatalogLocationHash(locationHash)) return;
      const observedAt = clock().toISOString();
      if (armedAt === null) armedAt = observedAt;
      const entry = {
        sequence: entries.length + 1,
        method,
        locationHash,
        observedAt,
      };
      entries.push(entry);
      if (isCatalogOrRootLocationHash(locationHash)) {
        failure = new Error(
          "continuous CDP location.hash observation reached Catalog or root",
        );
      }
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    }
  };
  const recordUrl = (method, url) => {
    try {
      recordHash(method, locationHashFromCdpUrl(url, method));
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    }
  };
  const offWithinDocument = client.on(
    "Page.navigatedWithinDocument",
    (params) => recordUrl("Page.navigatedWithinDocument", params?.url),
  );
  const offFrameNavigated = client.on("Page.frameNavigated", (params) => {
    if (params?.frame?.parentId == null) {
      recordUrl("Page.frameNavigated", params?.frame?.url);
    }
  });
  const initialHash = await readCdpLocationHash(client);
  if (initialHash !== "#/catalog") {
    offWithinDocument();
    offFrameNavigated();
    throw new Error(
      `continuous CDP location.hash observation must start at #/catalog, got ${initialHash}`,
    );
  }

  const snapshot = () => ({
    source: "cdp_page_navigation_events_and_location_hash",
    startedAt,
    initialHash,
    armedAt,
    terminalAt,
    terminalHash,
    entries: entries.map((entry) => ({ ...entry })),
  });
  const stop = () => {
    if (!stopped) {
      stopped = true;
      offWithinDocument();
      offFrameNavigated();
    }
    return snapshot();
  };
  return {
    assertArmed() {
      if (failure) throw failure;
      if (armedAt === null) {
        throw new Error(
          "continuous CDP location.hash observation did not observe Catalog exit",
        );
      }
    },
    throwIfFailed() {
      if (failure) throw failure;
    },
    async finish(expectedTerminalHash) {
      const observedTerminalHash = await readCdpLocationHash(client);
      recordHash("Runtime.evaluate(location.hash)", observedTerminalHash);
      terminalAt = clock().toISOString();
      terminalHash = observedTerminalHash;
      stop();
      if (failure) throw failure;
      if (observedTerminalHash !== expectedTerminalHash) {
        throw new Error(
          `continuous CDP location.hash terminal mismatch: expected ${expectedTerminalHash}, got ${observedTerminalHash}`,
        );
      }
      return snapshot();
    },
    snapshot,
    stop,
  };
}

async function captureRuntimeTraceBoundary(client, label) {
  return traceBoundary(await readRuntimeTrace(client), label);
}

async function waitForRepeatedCustomerTouchTrace(
  client,
  preDispatchTraceBoundary,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  let lastTrace = [];
  do {
    lastTrace = await readRuntimeTrace(client);
    const touch = traceEntriesAfterBoundary(
      lastTrace,
      preDispatchTraceBoundary,
      "repeated payment touch pre-dispatch trace boundary",
    ).find(
      (entry) =>
        entry?.type === "navigation" &&
        entry?.intentType === "customer.touch" &&
        entry?.decision === "accepted" &&
        entry?.reasonCode === "touchscreen_session_renewed",
    );
    if (touch) return touch;
    await sleep(25);
  } while (Date.now() < deadline);
  throw new Error(
    `installed runtime did not trace the repeated physical customer.touch after the pre-dispatch boundary: ${JSON.stringify(lastTrace.slice(-8))}`,
  );
}

export async function waitForGuardedVisionDepartureTrace(
  client,
  eventId,
  { timeoutMs = 8_000, readTrace = readRuntimeTrace, sleepFn = sleep } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let lastTrace = [];
  do {
    lastTrace = await readTrace(client);
    const departure = lastTrace.find(
      (entry) =>
        entry?.type === "navigation" &&
        entry?.intentType === "presence.departed" &&
        entry?.sourceEventId === eventId &&
        entry?.decision === "rejected" &&
        ["touchscreen_session_active", "active_transaction_route"].includes(
          entry?.reasonCode,
        ) &&
        entry?.finalRoute !== "#/catalog",
    );
    if (departure) return departure;
    await sleepFn(25);
  } while (Date.now() < deadline);
  throw new Error(
    `installed runtime did not trace guarded Vision departure ${eventId}: ${JSON.stringify(lastTrace.slice(-8))}`,
  );
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

async function waitForPlatformMovement(
  guestInput,
  input,
  baselineCount,
  expected,
  timeoutMs = 30_000,
) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  do {
    last = (await controlPlaneRequest(guestInput, "/v1/platform/query", input))
      .report;
    const raw = last?.raw ?? {};
    const order = matchingRowById(raw, "orders", expected.orderId);
    const payment = matchingRowById(raw, "payments", expected.paymentId);
    const command = matchingRowById(raw, "commands", expected.commandId);
    if (
      rows(raw, "movements").length > baselineCount &&
      order?.status === "fulfilled" &&
      order?.paymentState === "paid" &&
      order?.fulfillmentState === "dispensed" &&
      payment?.paymentNo === expected.paymentNo &&
      payment?.status === "succeeded" &&
      command?.commandKind === "dispatch" &&
      command?.status === "succeeded"
    ) {
      return last;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  } while (Date.now() < deadline);
  throw new Error(
    `platform did not reach terminal post-F2 order/command state: ${JSON.stringify(last?.raw ?? {})}`,
  );
}

async function waitForBeforeF0Boundary(
  guestInput,
  input,
  baselineRaw,
  renderedSale,
  liveSale,
  expectedPaymentNo,
  timeoutMs = 30_000,
) {
  const baselineOrders = rows(baselineRaw, "orders").length;
  const baselinePayments = rows(baselineRaw, "payments").length;
  const baselineCommands = rows(baselineRaw, "commands").length;
  const baselineMovements = rows(baselineRaw, "movements").length;
  const deadline = Date.now() + timeoutMs;
  let last = null;
  do {
    last = (await controlPlaneRequest(guestInput, "/v1/platform/query", input))
      .report;
    const raw = last?.raw ?? {};
    const order = rows(raw, "orders").find(
      (row) => row.id === renderedSale.orderId,
    );
    const payment = rows(raw, "payments").find(
      (row) => row.id === renderedSale.paymentId,
    );
    const command = rows(raw, "commands").find(
      (row) => row.id === liveSale.vendingCommandId,
    );
    if (
      order &&
      payment &&
      command &&
      payment.paymentNo === expectedPaymentNo &&
      payment.status === "succeeded" &&
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
  const root = join(
    dirname(localPath(outPath)),
    "fast-route-stress-sale-artifacts",
  );
  mkdirSync(root, { recursive: true });
  return async ({ bytes, sha256, label, format }) => {
    const file = join(
      root,
      `${String(label).replaceAll(/[^a-z0-9-]+/gi, "-")}.${format}`,
    );
    writeFileSync(file, bytes);
    return { ref: file, sha256 };
  };
}

function writeBoundedLogTail(sourcePath, outPath, label, maxBytes = 64 * 1024) {
  if (typeof sourcePath !== "string" || sourcePath === "") return null;
  try {
    const bytes = readFileSync(localPath(sourcePath));
    const root = join(
      dirname(localPath(outPath)),
      "fast-route-stress-sale-artifacts",
    );
    mkdirSync(root, { recursive: true });
    const destination = join(root, `${label}.tail.log`);
    writeFileSync(
      destination,
      bytes.subarray(Math.max(0, bytes.length - maxBytes)),
    );
    return {
      ref: destination,
      source: sourcePath,
      byteLength: Math.min(bytes.length, maxBytes),
      tail: bytes
        .subarray(Math.max(0, bytes.length - Math.min(maxBytes, 4 * 1024)))
        .toString("utf8"),
    };
  } catch {
    return { ref: null, source: sourcePath, byteLength: 0 };
  }
}

function writeTextArtifact(outPath, label, text) {
  const root = join(
    dirname(localPath(outPath)),
    "fast-route-stress-sale-artifacts",
  );
  mkdirSync(root, { recursive: true });
  const destination = join(root, `${label}.log`);
  writeFileSync(destination, String(text ?? ""));
  return {
    ref: destination,
    byteLength: Buffer.byteLength(String(text ?? ""), "utf8"),
  };
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function serializeError(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: String(error.stack ?? "").slice(0, 16 * 1024),
    };
  }
  return { name: "Error", message: String(error) };
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
    const detail = await Promise.race([
      action(),
      cleanupTimeout(label, timeoutMs),
    ]);
    return { label, ok: true, detail };
  } catch (error) {
    const wrapped = new Error(
      `${label} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
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
    continuousCdpLocationHash: input.continuousCdpLocationHash ?? null,
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
        failureCurrentTransaction:
          input.snapshots?.daemon?.failureCurrentTransaction ?? null,
      },
    },
    hostEvidence: input.hostEvidence ?? null,
    checkpoints: input.checkpoints ?? [],
    cleanup: input.cleanup ?? [],
    cleanupError: input.cleanupError ?? null,
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
    throw new Error(
      "guest input is missing hostControlPlane endpoint and token",
    );
  }
  // The Linux host control plane is the runner-owned bridge to run-vm-host-adapter.mjs.
  const request = {
    method: "POST",
    headers: {
      authorization: `Bearer ${controlPlane.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  };
  let lastError;
  for (const retryDelayMs of [0, 100, 250]) {
    if (retryDelayMs > 0) await sleep(retryDelayMs);
    try {
      return await fetchJson(`${controlPlane.endpoint}${path}`, request);
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      lastError = error;
    }
  }
  throw lastError;
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
    artifact: writeTextArtifact(
      outPath,
      "platform-service-api",
      result.log ?? "",
    ),
  };
}

export async function ensureControlledVisionMock(controlPort) {
  try {
    const status = await fetchJson(
      `http://127.0.0.1:${controlPort}/control/status`,
    );
    if (status.scenario === "controlled")
      return { child: null, started: false };
  } catch {}
  const child = spawn(
    process.execPath,
    [
      "--conditions=vem-source",
      "--import",
      "tsx",
      "apps/vision-mock/src/server.ts",
    ],
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

export async function waitForControlledVisionRuntimeClient(controlPort) {
  const deadline = Date.now() + 30_000;
  let lastStatus = null;
  while (Date.now() < deadline) {
    try {
      lastStatus = await fetchJson(
        `http://127.0.0.1:${controlPort}/control/status`,
      );
      if (
        lastStatus.scenario === "controlled" &&
        Number(lastStatus.connectedRuntimeClients) >= 1
      ) {
        return lastStatus;
      }
    } catch {}
    await sleep(250);
  }
  throw new Error(
    `controlled vision mock did not receive a runtime client: ${JSON.stringify(lastStatus)}`,
  );
}

export async function shutdownControlledVisionMock(child, timeoutMs = 10_000) {
  if (!child) return;
  if (child.exitCode == null) {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolvePromise) => child.once("exit", resolvePromise)),
      sleep(timeoutMs),
    ]);
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetchJson("http://127.0.0.1:7892/health");
      await sleep(250);
    } catch {
      return;
    }
  }
  throw new Error(
    "controlled vision mock did not release port 7892 after SIGTERM",
  );
}

async function dispatchVisionDeparture(guestInput) {
  const port =
    guestInput.hostControlPlane?.visionMockControlPort ??
    guestInput.visionMockControlPort;
  const controlPort = Number(port);
  if (!Number.isInteger(controlPort) || controlPort < 1) {
    throw new Error("guest input is missing vision mock control port");
  }
  // Use the controlled vision injection endpoint rather than browser-state spoofing.
  // Full guest-local URL shape: http://127.0.0.1:<port>/control/departure.
  // Regex guard anchor: vision/control/departure.
  const url = `http://127.0.0.1:${controlPort}/control/departure`;
  const deadline = Date.now() + 15_000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      return await fetchJson(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "fast-route-stress-sale" }),
      });
    } catch (error) {
      lastError = error;
      await sleep(250);
    }
  }
  throw lastError ?? new Error("Vision departure delivery timed out");
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
  let pendingCreate = null;
  let noCatalogTraceBoundary = null;
  let repeatedPaymentTouch = null;
  let continuousCdpLocationHashObserver = null;
  let continuousCdpLocationHash = null;
  let successReport = null;
  let failureReport = null;
  let primaryError = null;
  try {
    guestInput = readJson(options.guestInputPath, "guest input");
    handoff = readJson(options.handoffPath, "handoff");
    const runId = required(guestInput.runId, "runId");
    const machineCode = required(guestInput.machineCode, "machineCode");
    const commissioningSession = handoff.commissioningSerialSession ?? null;
    const saleCorrelationId =
      commissioningSession?.saleCorrelationId ??
      `sale-correlation://fast-route-${Date.now()}`;
    const steps = buildFastRouteStressScenarioSteps(
      options.fixtureKey
        ? catalogProductSelectorForFixture(
            guestInput.fixtureAllocation,
            options.fixtureKey,
          )
        : undefined,
    );
    createOrderGate = await armCreateOrderGate(guestInput);
    stage = "start-controlled-vision";
    vision = await ensureControlledVisionMock(
      guestInput.hostControlPlane?.visionMockControlPort ??
        guestInput.visionMockControlPort,
    );
    await waitForControlledVisionRuntimeClient(
      guestInput.hostControlPlane?.visionMockControlPort ??
        guestInput.visionMockControlPort,
    );
    stage = "reuse-or-start-host-serial-session";
    sessionStart =
      commissioningSession ??
      (await controlPlaneRequest(guestInput, "/v1/serial-sessions/start", {
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
      }));
    required(sessionStart.sessionId, "serial session id");
    stage = "connect-installed-tauri-cdp";
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
    clientReady = true;
    await waitForRoute(client, "#/catalog", { timeoutMs: 30_000, pollMs: 250 });
    saleStartCapability = await waitForSaleStartReady(handoff, client);
    await waitForRoute(client, "#/catalog", { timeoutMs: 30_000, pollMs: 250 });
    stage = "snapshot-baseline";
    uiViewport = await readInstalledUiViewport(client);
    baselineSaleView = await daemonGet(handoff, "/v1/sale-view");
    baselinePlatform = (
      await controlPlaneRequest(guestInput, "/v1/platform/query", {
        runId,
        machineCode,
      })
    ).report;
    checkpoints.push(
      await captureCheckpoint(client, "catalog", {
        screenshot: true,
        screenshotSink: sink,
      }),
    );
    continuousCdpLocationHashObserver =
      await startContinuousCdpLocationHashObservation(client);
    stage = "physical-catalog-to-checkout";
    for (const step of steps.slice(0, 4)) {
      await waitForRoute(client, step.routeBefore, {
        timeoutMs: 30_000,
        pollMs: 250,
      });
      // activateVisibleSelector hard-fails unless the UI action is dispatched via
      // the real Chrome DevTools Input.dispatchTouchEvent path.
      const activation = await activateVisibleSelector(client, step.selector, {
        kind: step.inputKind,
        timeoutMs: 30_000,
      });
      assert.match(activation.input.method, /Input\.dispatchTouchEvent/);
      await waitForRoute(client, step.routeAfter, {
        timeoutMs: 30_000,
        pollMs: 250,
      });
      if (step.name === "catalog product") {
        continuousCdpLocationHashObserver.assertArmed();
        noCatalogTraceBoundary = await captureRuntimeTraceBoundary(
          client,
          "no-Catalog trace boundary",
        );
      }
    }
    await waitForRoute(client, "#/checkout", {
      timeoutMs: 30_000,
      pollMs: 250,
    });
    stage = "wait-create-order-pending-boundary";
    let firstSubmit = null;
    for (let attempt = 0; attempt < 3 && !pendingCreate; attempt += 1) {
      firstSubmit = await activateVisibleSelector(client, steps[4].selector, {
        kind: "touch",
        timeoutMs: 30_000,
      });
      assert.match(firstSubmit.input.method, /Input\.dispatchTouchEvent/);
      pendingCreate = await waitForCreateOrderGatePending(
        guestInput,
        attempt === 2 ? 30_000 : 2_000,
      ).catch(() => null);
    }
    if (!pendingCreate)
      throw new Error(
        "mock create-order gate did not observe a pending payment creation",
      );
    stage = "vision-departure-during-create-order";
    const pendingConfirmedAt = new Date().toISOString();
    const visionRequestedAt = new Date().toISOString();
    let visionDeliveryResult;
    try {
      visionDeliveryResult = await dispatchVisionDeparture(guestInput);
    } catch {
      await shutdownControlledVisionMock(vision?.child).catch(() => undefined);
      vision = await ensureControlledVisionMock(
        guestInput.hostControlPlane?.visionMockControlPort ??
          guestInput.visionMockControlPort,
      );
      await waitForControlledVisionRuntimeClient(
        guestInput.hostControlPlane?.visionMockControlPort ??
          guestInput.visionMockControlPort,
      );
      visionDeliveryResult = await dispatchVisionDeparture(guestInput);
    }
    const visionDelivery = {
      ...visionDeliveryResult,
      requestedAt: visionRequestedAt,
      completedAt: new Date().toISOString(),
    };
    await waitForGuardedVisionDepartureTrace(client, visionDelivery.eventId);
    const preDispatchTraceBoundary = await captureRuntimeTraceBoundary(
      client,
      "repeated payment touch pre-dispatch trace boundary",
    );
    const secondSubmit = await dispatchRepeatedPaymentTouch(
      client,
      firstSubmit,
    );
    assert.match(secondSubmit.input.method, /Input\.dispatchTouchEvent/);
    const repeatedTouchTrace = await waitForRepeatedCustomerTouchTrace(
      client,
      preDispatchTraceBoundary,
    );
    const releaseRequestedAt = new Date().toISOString();
    repeatedPaymentTouch = {
      preDispatchTraceBoundary,
      traceEntryId: repeatedTouchTrace.id,
      pendingConfirmedAt,
      releaseRequestedAt,
    };
    const releasedCreateOrderGate = await releaseCreateOrderGate(
      guestInput,
      pendingCreate.paymentNo,
    );
    await waitForRoute(client, /^#\/payment/, {
      timeoutMs: 30_000,
      pollMs: 250,
    });
    checkpoints.push(
      await captureCheckpoint(client, "payment-creation", {
        screenshot: true,
        screenshotSink: sink,
      }),
    );
    stage = "read-rendered-payment-surface";
    const renderedSale = await readRenderedPaymentSurface(client);
    stage = "read-pending-transaction";
    const pendingTransaction = await daemonGet(
      handoff,
      "/v1/transactions/current",
    );
    if (pendingTransaction?.paymentNo !== pendingCreate.paymentNo) {
      throw new Error(
        "released create-order gate paymentNo must match the rendered payment surface",
      );
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
      pendingCreate.paymentNo,
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
    continuousCdpLocationHash = await continuousCdpLocationHashObserver.finish(
      resultSurface.route,
    );
    checkpoints.push(
      await captureCheckpoint(client, "result", {
        screenshot: true,
        screenshotSink: sink,
      }),
    );
    stage = "collect-raw-serial-evidence";
    const collect = await controlPlaneRequest(
      guestInput,
      `/v1/serial-sessions/${sessionStart.sessionId}/evidence`,
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
      {
        orderId: renderedSale.orderId,
        paymentId: renderedSale.paymentId,
        paymentNo: pendingCreate.paymentNo,
        commandId: liveSale.vendingCommandId,
      },
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
      controlPlaneSessionId: sessionStart.sessionId,
      machineCode,
      machineRuntimeTrace: {
        source: "installed_machine_runtime_trace_cdp",
        capturedAt: new Date().toISOString(),
        entries: runtimeTrace,
      },
      createOrderGate: {
        controlPlane: createOrderGate.controlPlane,
        armedAt: createOrderGate.armedAt,
        paymentNo: pendingCreate.paymentNo,
        pendingObservedAt: pendingCreate.observedAt,
        releasedAt: releasedCreateOrderGate.releasedAt,
      },
      noCatalogTraceBoundary,
      repeatedPaymentTouch,
      continuousCdpLocationHash,
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
    successReport = {
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
        daemonProcess: processLiveness(handoff?.daemon?.processId),
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
  } catch (error) {
    primaryError = error instanceof Error ? error : new Error(String(error));
    const failureCurrentTransaction = handoff
      ? await daemonGet(handoff, "/v1/transactions/current").catch(
          (transactionError) => ({
            evidenceError:
              transactionError instanceof Error
                ? transactionError.message
                : String(transactionError),
          }),
        )
      : null;
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
    continuousCdpLocationHash =
      continuousCdpLocationHash ??
      continuousCdpLocationHashObserver?.snapshot() ??
      null;
    const platformLog =
      guestInput && sessionStart
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
    const hostEvidence =
      guestInput && sessionStart
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
      error: primaryError,
      controlPlaneSessionId: sessionStart?.sessionId ?? null,
      liveSale,
      runtimeTrace,
      continuousCdpLocationHash,
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
          failureCurrentTransaction,
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
    failureReport = report;
  }

  const cleanup = [];
  const cleanupErrors = [];
  if (guestInput && createOrderGate) {
    try {
      cleanup.push(
        await runCleanupStep("reopen payment create gate", async () => {
          const opened = await openCreateOrderGate(guestInput);
          const status = await controlPlaneRequest(
            guestInput,
            "/v1/mock-payment-create-gate/status",
          );
          if (
            opened?.state !== "open" ||
            status?.state !== "open" ||
            status?.pending !== null
          ) {
            throw new Error(
              "payment create gate did not return to open with no pending payment",
            );
          }
          const transaction = pendingCreate?.paymentNo
            ? await settlePendingCreateOrder({
                paymentNo: pendingCreate.paymentNo,
                readTransaction: () =>
                  daemonGet(handoff, "/v1/transactions/current"),
                cancelTransaction: (active) =>
                  daemonPost(handoff, "/v1/intents/cancel-order", {
                    orderNo: required(active?.orderNo, "active orderNo"),
                  }),
              })
            : null;
          return { opened, status, transaction };
        }),
      );
    } catch (error) {
      cleanupErrors.push(error);
      cleanup.push({
        label: error.cleanupLabel ?? "reopen payment create gate",
        ok: false,
        error: serializeError(error),
      });
    }
  }
  if (guestInput && sessionStart?.sessionId) {
    try {
      cleanup.push(
        await runCleanupStep("abort serial session", async () => {
          const result = await controlPlaneRequest(
            guestInput,
            `/v1/serial-sessions/${sessionStart.sessionId}/abort`,
          );
          if (result?.aborted !== true) {
            throw new Error(
              "serial session abort did not confirm inactive state",
            );
          }
          return result;
        }),
      );
    } catch (error) {
      cleanupErrors.push(error);
      cleanup.push({
        label: error.cleanupLabel ?? "abort serial session",
        ok: false,
        error: serializeError(error),
      });
    }
  }
  if (client) {
    if (continuousCdpLocationHashObserver) {
      try {
        cleanup.push(
          await runCleanupStep(
            "stop continuous CDP location.hash observation",
            async () => continuousCdpLocationHashObserver.stop(),
          ),
        );
      } catch (error) {
        cleanupErrors.push(error);
        cleanup.push({
          label:
            error.cleanupLabel ??
            "stop continuous CDP location.hash observation",
          ok: false,
          error: serializeError(error),
        });
      }
    }
    try {
      cleanup.push(
        await runCleanupStep("close CDP client", async () => {
          await client.close();
          return { closed: true };
        }),
      );
    } catch (error) {
      cleanupErrors.push(error);
      cleanup.push({
        label: error.cleanupLabel ?? "close CDP client",
        ok: false,
        error: serializeError(error),
      });
    }
  }
  try {
    cleanup.push(
      await runCleanupStep(
        "stop controlled vision mock",
        async () => {
          await shutdownControlledVisionMock(vision?.child);
          return { stopped: true, port: 7892 };
        },
        20_000,
      ),
    );
  } catch (error) {
    cleanupErrors.push(error);
    cleanup.push({
      label: error.cleanupLabel ?? "stop controlled vision mock",
      ok: false,
      error: serializeError(error),
    });
  }

  if (successReport) successReport.cleanup = cleanup;
  if (failureReport) {
    failureReport.cleanup = cleanup;
  }
  const finalError = combineCleanupError(primaryError, cleanupErrors);
  if (finalError) {
    if (!failureReport) {
      failureReport = buildFastRouteStressSaleFailureReport({
        mode: options.mode,
        stage: "cleanup",
        error: finalError,
        controlPlaneSessionId: sessionStart?.sessionId ?? null,
        liveSale,
        runtimeTrace: [],
        continuousCdpLocationHash:
          continuousCdpLocationHash ??
          continuousCdpLocationHashObserver?.snapshot() ??
          null,
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
        hostEvidence: successReport,
        checkpoints,
        cleanup,
        cleanupError: serializeError(finalError),
      });
    } else {
      failureReport.cleanupError = serializeError(finalError);
    }
    writeReport(options.outPath, failureReport);
    throw finalError;
  }

  writeReport(options.outPath, successReport);
  return successReport;
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
