#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { catalogProductSelectorForFixture } from "./full-workflow-fixtures.ts";
import { waitForBusinessHardwareReady } from "./full-workflow-orchestrator.ts";
import {
  activateVisibleSelector,
  captureCheckpoint,
  CdpClient,
  dispatchPhysicalInput,
  discoverMachineUiTarget,
  enablePageRuntime,
  evaluateExpression,
  readCdpLocationHash,
  readMachineRuntimeTraceSnapshot,
  rewriteWebSocketDebuggerUrl,
  waitForRoute,
} from "./machine-ui-cdp-driver.ts";
import { validateProductionRawSerialFrame } from "./qemu-usb-serial-host-adapter.ts";
import { replaceSerialSessionAndUpdateHandoff } from "./serial-session-handoff.ts";

type JsonRecord = Record<string, unknown>;

interface CleanupError extends Error {
  cleanupLabel?: string;
  cause?: unknown;
}

function recordValue(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function maybeRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}

const MODES = new Set(["fast", "full"]);
const CLEANUP_TIMEOUT_MS = 10_000;
const CLEANUP_REQUEST_TIMEOUT_MS = 3_000;
const PENDING_TRANSACTION_CLEANUP_TIMEOUT_MS = 15_000;
function required(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function processLiveness(processId: unknown): JsonRecord | null {
  if (
    typeof processId !== "number" ||
    !Number.isInteger(processId) ||
    processId < 1
  ) {
    return null;
  }
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

function timestamp(value: unknown, label: string): number {
  const parsed = Date.parse(String(value));
  if (!Number.isFinite(parsed))
    throw new Error(`${label} must be an ISO timestamp`);
  return parsed;
}

function integerLike(value: unknown, label: string): number {
  const normalized =
    typeof value === "string" && value.trim() !== ""
      ? Number(value)
      : typeof value === "number"
        ? value
        : Number.NaN;
  if (!Number.isInteger(normalized)) {
    throw new Error(`${label} must be an integer`);
  }
  return normalized;
}

function windowsAbsolute(value: unknown, label: string): string {
  const path = required(value, label);
  if (!/^[A-Za-z]:\\/.test(path) || path.includes("\0")) {
    throw new Error(`${label} must be an absolute Windows path`);
  }
  return path;
}

function option(args: string[], name: string): string {
  const index = args.indexOf(`--${name}`);
  const value = index === -1 ? undefined : args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`--${name} requires a value`);
  }
  return value;
}

function optionalOption(args: string[], name: string): string | null {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? null : required(args[index + 1], `--${name}`);
}

const SCENARIOS = new Set(["route-stress", "sale-only"]);

export function parseFastRouteStressSaleArgs(args: string[]): JsonRecord {
  const mode = required(option(args, "mode"), "--mode");
  if (!MODES.has(mode)) throw new Error("--mode must be fast or full");
  const scenario = optionalOption(args, "scenario") ?? "route-stress";
  if (!SCENARIOS.has(scenario)) {
    throw new Error("--scenario must be route-stress or sale-only");
  }
  return {
    mode,
    scenario,
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
  categorySelector = '[data-test="catalog-category"]:not(:disabled)',
): JsonRecord[] {
  return [
    {
      type: "customer-activation",
      name: "catalog category",
      selector: categorySelector,
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

export async function dispatchRepeatedPaymentTouch(
  client: unknown,
  firstActivation: JsonRecord | null | undefined,
): Promise<JsonRecord> {
  const originalPoint = firstActivation?.center;
  const center = recordValue(originalPoint);
  const input = await dispatchPhysicalInput(
    client as Parameters<typeof dispatchPhysicalInput>[0],
    { x: center.x, y: center.y },
    {
    kind: "touch",
    timeoutMs: 5_000,
    },
  );
  return { originalPoint: { x: center.x, y: center.y }, input };
}

async function armCreateOrderGate(guestInput: JsonRecord): Promise<JsonRecord> {
  const armed = await controlPlaneRequest(
    guestInput,
    "/v1/mock-payment-create-gate/arm",
    { timeoutMs: 30_000 },
  );
  const armedRecord = recordValue(armed);
  return {
    controlPlane: "mock-payment-create-gate",
    armedAt: armedRecord.armedAt,
  };
}

async function waitForCreateOrderGatePending(
  guestInput: JsonRecord,
  timeoutMs = 30_000,
): Promise<JsonRecord> {
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      const status = recordValue(
        await controlPlaneRequest(
        guestInput,
        "/v1/mock-payment-create-gate/status",
        ),
      );
      const pending = maybeRecord(status.pending);
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

async function releaseCreateOrderGate(
  guestInput: JsonRecord,
  paymentNo: unknown,
): Promise<JsonRecord> {
  const released = await controlPlaneRequest(
    guestInput,
    "/v1/mock-payment-create-gate/release",
    { paymentNo },
  );
  const releasedRecord = recordValue(released);
  return {
    paymentNo,
    releasedAt: releasedRecord.releasedAt,
  };
}

function rows(raw: unknown, key: string): unknown[] {
  return arrayValue(recordValue(raw)[key]);
}

function deltaRows(before: unknown, after: unknown, key: string): unknown[] {
  const prior = new Set(
    rows(before, key).map((row: unknown) => recordValue(row).id),
  );
  return rows(after, key).filter(
    (row: unknown) => !prior.has(recordValue(row).id),
  );
}

function exactlyOne(values: unknown[], message: string): JsonRecord {
  if (values.length !== 1) throw new Error(message);
  return recordValue(values[0]);
}

function matchingItem(
  view: unknown,
  identity: JsonRecord,
): JsonRecord | undefined {
  return rows(view, "items")
    .map((item: unknown) => recordValue(item))
    .find(
      (item) =>
        item.inventoryId === identity.inventoryId &&
        item.slotId === identity.slotId,
    );
}

function matchingInventory(
  raw: unknown,
  identity: JsonRecord,
): JsonRecord | undefined {
  return rows(raw, "inventories")
    .map((inventory: unknown) => recordValue(inventory))
    .find(
      (inventory) =>
        inventory.id === identity.inventoryId &&
        inventory.slotId === identity.slotId,
    );
}

function matchingRowById(
  raw: unknown,
  key: string,
  id: unknown,
): JsonRecord | undefined {
  return rows(raw, key)
    .map((row: unknown) => recordValue(row))
    .find((row) => row.id === id);
}

function compactRuntimeTrace(trace: unknown, maxEntries = 64): unknown[] {
  return arrayValue(trace).slice(-maxEntries);
}

function latestTouchscreenSessionActive(entries: unknown[]): boolean {
  for (const entry of [...entries].reverse()) {
    const record = recordValue(entry);
    if (typeof record.touchscreenSessionActive === "boolean") {
      return record.touchscreenSessionActive;
    }
  }
  return false;
}

export function latestVisionPresence(entries: unknown[]): JsonRecord {
  for (const entry of [...entries].reverse()) {
    const transitionId = String(recordValue(entry).transitionId ?? "");
    if (!transitionId.startsWith("vision:presence-")) continue;
    if (transitionId.endsWith(":welcome")) {
      return { active: true, transitionId };
    }
    if (transitionId.endsWith(":departed")) {
      return { active: false, transitionId };
    }
  }
  return { active: false, transitionId: null };
}

function runtimeTraceSnapshot(
  snapshot: JsonRecord,
  label: string,
): JsonRecord {
  const rawEntries = snapshot.entries;
  if (
    !snapshot ||
    typeof snapshot.runtimeGenerationId !== "string" ||
    snapshot.runtimeGenerationId.trim() === "" ||
    !Array.isArray(rawEntries)
  ) {
    throw new Error(
      `${label} requires an atomic Machine Runtime trace snapshot`,
    );
  }
  return {
    runtimeGenerationId: snapshot.runtimeGenerationId,
    entries: rawEntries as unknown[],
  };
}

function traceBoundary(snapshot: JsonRecord, label: string): JsonRecord {
  const { entries, runtimeGenerationId } = runtimeTraceSnapshot(
    snapshot,
    label,
  );
  const traceEntries = arrayValue(entries);
  if (traceEntries.length === 0 && !Array.isArray(entries)) {
    throw new Error(
      `${label} requires an installed Machine Runtime Trace array`,
    );
  }
  const lastEntryId = recordValue(traceEntries.at(-1)).id ?? 0;
  if (
    !Number.isInteger(lastEntryId) ||
    (lastEntryId as number) < 0 ||
    !traceEntries.every(
      (entry: unknown, index: number) =>
        Number.isInteger(recordValue(entry)?.id) &&
        (recordValue(entry).id as number) >
          (recordValue(traceEntries[index - 1]).id as number),
    )
  ) {
    throw new Error(`${label} requires monotonically increasing trace ids`);
  }
  const visionPresence = latestVisionPresence(traceEntries);
  return {
    source: "installed_machine_runtime_trace_cdp",
    lastEntryId,
    capturedAt: new Date().toISOString(),
    runtimeGenerationId,
    touchscreenSessionActive: latestTouchscreenSessionActive(traceEntries),
    visionPresenceActive: visionPresence.active,
    visionPresenceTransitionId: visionPresence.transitionId,
  };
}

function traceEntriesAfterBoundary(
  snapshot: JsonRecord,
  boundary: JsonRecord,
  label: string,
): unknown[] {
  const boundaryRecord = recordValue(boundary);
  if (
    boundaryRecord?.source !== "installed_machine_runtime_trace_cdp" ||
    !Number.isInteger(boundaryRecord?.lastEntryId) ||
    (boundaryRecord.lastEntryId as number) < 0 ||
    !Number.isFinite(Date.parse(String(boundaryRecord?.capturedAt ?? "")))
  ) {
    throw new Error(
      `${label} must retain an installed-CDP trace id boundary and capture timestamp`,
    );
  }
  if (
    typeof boundaryRecord.runtimeGenerationId !== "string" ||
    boundaryRecord.runtimeGenerationId.trim() === ""
  ) {
    throw new Error(`${label} boundary requires a Machine Runtime generation`);
  }
  const { entries, runtimeGenerationId } = runtimeTraceSnapshot(
    snapshot,
    label,
  );
  const traceEntries = arrayValue(entries);
  const sameRuntime =
    boundaryRecord.runtimeGenerationId === runtimeGenerationId;
  return traceEntries.filter((entry: unknown) => {
    const entryRecord = recordValue(entry);
    if (!Number.isInteger(entryRecord?.id) || (entryRecord.id as number) < 1) {
      return false;
    }
    if (sameRuntime) {
      return (entryRecord.id as number) > (boundaryRecord.lastEntryId as number);
    }
    // A trace id restarts with a recreated runtime. Its event must be newer
    // than the captured boundary; callers still verify the target semantics.
    return (
      timestamp(entryRecord?.at, `${label} restarted trace entry`) >
      timestamp(boundaryRecord.capturedAt, `${label} boundary capture`)
    );
  });
}

function isCatalogRoute(route: unknown): boolean {
  if (typeof route !== "string") return false;
  return route.replace(/^#/, "") === "/catalog";
}

function isCatalogOrRootLocationHash(value: unknown): boolean {
  const hash = String(value ?? "");
  if (hash === "" || hash === "#" || hash === "#/") return true;
  if (!hash.startsWith("#/")) {
    throw new Error(`invalid CDP location.hash observation: ${hash}`);
  }
  const route = new URL(hash.slice(1), "http://machine-route.invalid");
  return route.pathname.toLowerCase() === "/catalog";
}

function isCatalogLocationHash(value: unknown): boolean {
  const hash = String(value ?? "");
  if (!hash.startsWith("#/")) return false;
  const route = new URL(hash.slice(1), "http://machine-route.invalid");
  return route.pathname.toLowerCase() === "/catalog";
}

function locationHashFromCdpUrl(value: unknown, label: string): string {
  let url: URL;
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

function compactPlatformBoundary(
  report: unknown,
  summary: JsonRecord,
): JsonRecord {
  const reportRecord = recordValue(report);
  const raw = recordValue(reportRecord.raw);
  const orderItems = rows(raw, "orderItems").map((row: unknown) =>
    recordValue(row),
  );
  const inventories = rows(raw, "inventories").map((row: unknown) =>
    recordValue(row),
  );
  return {
    scope: reportRecord.scope ?? null,
    order: matchingRowById(raw, "orders", summary.orderId) ?? null,
    orderItem:
      orderItems.find(
        (row) =>
          row.inventoryId === summary.inventoryId &&
          row.slotId === summary.slotId,
      ) ?? null,
    payment: matchingRowById(raw, "payments", summary.paymentId) ?? null,
    command: matchingRowById(raw, "commands", summary.vendingCommandId) ?? null,
    movement: matchingRowById(raw, "movements", summary.movementId) ?? null,
    inventory:
      inventories.find(
        (row) =>
          row.id === summary.inventoryId && row.slotId === summary.slotId,
      ) ?? null,
  };
}

function compactDaemonBoundary(
  view: unknown,
  summary: JsonRecord,
): JsonRecord {
  const items = rows(view, "items").map((row: unknown) => recordValue(row));
  return {
    item:
      items.find(
        (row) =>
          row.inventoryId === summary.inventoryId &&
          row.slotId === summary.slotId,
      ) ?? null,
  };
}

function compactEvidenceForReport(
  evidence: JsonRecord,
  summary: JsonRecord,
): JsonRecord {
  const platform = recordValue(evidence.platform);
  const daemon = recordValue(evidence.daemon);
  const serial = recordValue(evidence.serial);
  const mqttMessages = arrayValue(evidence.mqttMessages);
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
      baseline: compactPlatformBoundary(platform.baseline, summary),
      beforeF0: compactPlatformBoundary(platform.beforeF0, summary),
      afterF1BeforeF2: compactPlatformBoundary(
        platform.afterF1BeforeF2,
        summary,
      ),
      afterF2: compactPlatformBoundary(platform.afterF2, summary),
    },
    daemon: {
      baseline: compactDaemonBoundary(daemon.baseline, summary),
      beforeF0: compactDaemonBoundary(daemon.beforeF0, summary),
      afterF1BeforeF2: compactDaemonBoundary(
        daemon.afterF1BeforeF2,
        summary,
      ),
      afterF2: compactDaemonBoundary(daemon.afterF2, summary),
    },
    ui: evidence.ui,
    mqttMessages: mqttMessages.slice(-2),
    serial: {
      sessionId: serial.sessionId ?? null,
      rawFrames: arrayValue(serial.rawFrames)
        .filter((frame: unknown) =>
          ["VEND", "F0", "F1", "F2"].includes(
            String(recordValue(frame).parsedOpcode ?? ""),
          ),
        )
        .slice(-4),
    },
  };
}

export function validateFastRouteStressSaleEvidence(
  input: JsonRecord,
): JsonRecord {
  const platform = recordValue(input.platform);
  const baseline = recordValue(recordValue(platform.baseline).raw);
  const beforeF0 = recordValue(recordValue(platform.beforeF0).raw);
  const afterF1 = recordValue(recordValue(platform.afterF1BeforeF2).raw);
  const afterF2 = recordValue(recordValue(platform.afterF2).raw);
  const rendered = recordValue(input.renderedSale);
  const live = recordValue(input.liveSale);
  const createOrderGate = recordValue(input.createOrderGate);
  const daemon = recordValue(input.daemon);
  const ui = recordValue(input.ui);
  const serial = recordValue(input.serial);
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
    rows(afterF1, "orderItems").filter(
      (row: unknown) => recordValue(row).orderId === order.id,
    ),
    "expected exactly one correlated order item",
  );
  const payment = exactlyOne(
    deltaRows(baseline, afterF1, "payments").filter(
      (row: unknown) => recordValue(row).orderId === order.id,
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
      (row: unknown) =>
        recordValue(row).orderId === order.id &&
        recordValue(row).orderItemId === orderItem.id,
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
  if (!beforeF0Payment || !beforeF0Command) {
    throw new Error(
      "authoritative pre-F0 payment and command facts are missing",
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
  const daemonBefore = matchingItem(daemon.beforeF0, identity);
  const daemonMiddle = matchingItem(daemon.afterF1BeforeF2, identity);
  const daemonAfter = matchingItem(daemon.afterF2, identity);
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
  if (recordValue(recordValue(ui.beforeF0).result).kind === "success") {
    throw new Error("UI must not show success before inbound F0");
  }
  if (recordValue(recordValue(ui.afterF1BeforeF2).result).kind === "success") {
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
    Number(daemonAfter.physicalStock) - Number(daemonMiddle.physicalStock) !==
      -1 ||
    daemonAfter.saleableStock !== daemonMiddle.saleableStock
  ) {
    throw new Error(
      "correlated daemon physical stock must decrement exactly once without double-decrementing saleable stock after inbound F2",
    );
  }
  if (Number(platformAfter.onHandQty) - Number(platformMiddle.onHandQty) !== -1) {
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
  if (!afterF2Payment || !beforeF0Payment) {
    throw new Error("authoritative post-F2 payment facts are missing");
  }
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
    arrayValue(input.mqttMessages),
    "expected exactly one MQTT vend command",
  );
  if (
    mqtt?.topic !== `vem/machines/${machineCode}/commands/dispense` ||
    recordValue(mqtt.payload).machineCode !== machineCode
  ) {
    throw new Error("MQTT vend command must correlate the machine identity");
  }
  const mqttPayload = recordValue(recordValue(mqtt.payload).payload);
  if (mqttPayload?.commandNo !== command.commandNo) {
    throw new Error(
      `MQTT vend command must correlate commandNo ${command.commandNo}`,
    );
  }
  if (mqttPayload.orderNo !== order.orderNo || mqttPayload.quantity !== 1) {
    throw new Error("MQTT vend command must correlate order and quantity");
  }
  const mqttSlot = recordValue(mqttPayload.slot);
  if (
    integerLike(mqttSlot.rowNo, "MQTT vend slot rowNo") !==
      daemonBefore.rowNo ||
    integerLike(mqttSlot.cellNo, "MQTT vend slot cellNo") !==
      daemonBefore.cellNo
  ) {
    throw new Error(
      "MQTT vend command must correlate the daemon slot coordinates",
    );
  }
  const rawFrames = arrayValue(serial.rawFrames);
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
    serial?.sessionId,
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
  const uiViewport = recordValue(input.uiViewport);
  if (
    uiViewport.innerWidth !== 1080 ||
    uiViewport.innerHeight !== 1920 ||
    uiViewport.documentClientWidth !== 1080 ||
    uiViewport.documentClientHeight !== 1920
  ) {
    throw new Error("installed UI viewport must be exactly 1080x1920");
  }
  const saleStartCapability = recordValue(input.saleStartCapability);
  if (
    !Number.isInteger(saleStartCapability.revision) ||
    (saleStartCapability.revision as number) < 1
  ) {
    throw new Error("sale-start-capability must expose a positive revision");
  }
  if (saleStartCapability.canStartSale !== true) {
    throw new Error("sale-start-capability must allow the fast sale to start");
  }
  const paymentOptions = recordValue(saleStartCapability.paymentOptions);
  const mockOption = arrayValue(paymentOptions.options)
    .map((option: unknown) => recordValue(option))
    .find(
      (option) =>
        option?.optionKey === "mock:mock" &&
        option?.providerCode === "mock" &&
        option?.method === "mock",
    ) ?? null;
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
    vendBytes[1] !== daemonBefore.rowNo ||
    vendBytes[2] !== daemonBefore.cellNo
  ) {
    throw new Error(
      "outbound serial vend frame must correlate the slot coordinates",
    );
  }
  for (const report of [
    platform.baseline,
    platform.beforeF0,
    platform.afterF1BeforeF2,
    platform.afterF2,
  ]) {
    const reportRecord = recordValue(report);
    if (
      reportRecord?.source !== "authoritative_ephemeral_platform_database" ||
      !Number.isFinite(Date.parse(String(reportRecord?.capturedAt ?? ""))) ||
      recordValue(reportRecord.scope).machineCode !== machineCode ||
      typeof recordValue(reportRecord.scope).machineId !== "string" ||
      String(recordValue(reportRecord.scope).machineId) === ""
    ) {
      throw new Error(
        "platform evidence must retain authoritative provenance, capturedAt, and correlated machine scope at every boundary",
      );
    }
  }
  if (
    timestamp(
      recordValue(platform.beforeF0).capturedAt,
      "platform payment snapshot capturedAt",
    ) > f0CapturedAt
  ) {
    throw new Error(
      "platform payment snapshot must be captured no later than host raw F0",
    );
  }
  if (!serial?.sessionId)
    throw new Error("serial session identity is required");
  const gateObservedAt = Date.parse(
    String(createOrderGate.pendingObservedAt),
  );
  const gateReleasedAt = Date.parse(String(createOrderGate.releasedAt));
  if (
    !Number.isFinite(gateObservedAt) ||
    !Number.isFinite(gateReleasedAt) ||
    gateReleasedAt < gateObservedAt
  ) {
    throw new Error(
      "create-order gate must expose a pending boundary before release",
    );
  }
  const vision = recordValue(input.visionDelivery);
  const repeatedPaymentTouch = recordValue(input.repeatedPaymentTouch);
  const routeStressScenario = input.scenario !== "sale-only";
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
  let repeatedTouch = null;
  if (routeStressScenario) {
    if (
      vision.ok !== true ||
      typeof vision.eventId !== "string" ||
      vision.eventId === "" ||
      Number(vision.connectedRuntimeClients) < 1 ||
      Number(vision.acceptedDeliveries) < 1
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
  }
  const continuousHash = recordValue(input.continuousCdpLocationHash);
  if (
    continuousHash.source !== "cdp_page_navigation_events_and_location_hash" ||
    continuousHash.initialHash !== "#/catalog" ||
    !Number.isFinite(Date.parse(String(continuousHash.startedAt))) ||
    !Number.isFinite(Date.parse(String(continuousHash.armedAt))) ||
    !Number.isFinite(Date.parse(String(continuousHash.terminalAt))) ||
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
  const machineRuntimeTrace = recordValue(input.machineRuntimeTrace);
  if (
    machineRuntimeTrace.source !== "installed_machine_runtime_trace_cdp" ||
    !Number.isFinite(Date.parse(String(machineRuntimeTrace.capturedAt))) ||
    !Array.isArray(machineRuntimeTrace.entries) ||
    typeof machineRuntimeTrace.runtimeGenerationId !== "string" ||
    machineRuntimeTrace.runtimeGenerationId.trim() === ""
  ) {
    throw new Error(
      "Machine Runtime Trace must retain direct installed-CDP provenance and capture timestamp",
    );
  }
  const runtimeSnapshot = {
    runtimeGenerationId: machineRuntimeTrace.runtimeGenerationId,
    entries: machineRuntimeTrace.entries,
  };
  const runtimeTrace = arrayValue(runtimeSnapshot.entries);
  const noCatalogTrace = traceEntriesAfterBoundary(
    runtimeSnapshot,
    recordValue(input.noCatalogTraceBoundary),
    "no-Catalog trace boundary",
  );
  if (routeStressScenario) {
    const repeatedTouchTrace = traceEntriesAfterBoundary(
      runtimeSnapshot,
      recordValue(repeatedPaymentTouch.preDispatchTraceBoundary),
      "repeated payment touch pre-dispatch trace boundary",
    );
    repeatedTouch =
      repeatedTouchTrace
        .map((entry: unknown) => recordValue(entry))
        .find(
          (entry) =>
            entry?.type === "navigation" &&
            entry?.intentType === "customer.touch" &&
            entry?.decision === "accepted" &&
            entry?.reasonCode === "touchscreen_session_renewed" &&
            entry?.id === repeatedPaymentTouch.traceEntryId,
        ) ?? null;
    if (!repeatedTouch) {
      throw new Error(
        "installed runtime trace must record the repeated physical customer.touch after its pre-dispatch boundary",
      );
    }
  }
  let guardedDeparture: JsonRecord | null = null;
  let projectionRefresh: JsonRecord | null = null;
  if (routeStressScenario) {
    const guardedDepartureTrace = traceEntriesAfterBoundary(
      runtimeSnapshot,
      recordValue(vision.traceBoundary),
      "Vision departure control-request trace boundary",
    );
    guardedDeparture =
      guardedDepartureTrace
        .map((entry: unknown) => recordValue(entry))
        .find(
          (entry) =>
            entry.type === "navigation" &&
            entry.intentType === "presence.departed" &&
            /^presence-\d+:departure$/.test(
              String(entry.sourceEventId ?? ""),
            ) &&
        ["touchscreen_session_active", "active_transaction_route"].includes(
              String(entry.reasonCode ?? ""),
        ) &&
            entry.decision === "rejected" &&
            entry.finalRoute !== "#/catalog",
        ) ?? null;
    if (!guardedDeparture) {
      throw new Error(
        "installed runtime trace must contain the guarded stable Vision departure navigation effect after the control-request boundary",
      );
    }
    projectionRefresh =
      runtimeTrace
        .map((entry: unknown) => recordValue(entry))
        .find(
          (entry) =>
            entry?.type === "navigation" &&
            entry?.intentType === "transaction.projection" &&
            entry?.decision === "accepted" &&
            ["transaction_projection", "transaction_projection_current"].includes(
              String(entry?.reasonCode ?? ""),
            ) &&
            entry?.transactionOrderNo === order.orderNo &&
            entry?.finalRoute !== "#/catalog" &&
            Number.isFinite(entry?.id) &&
            Number.isFinite(guardedDeparture?.id) &&
            (entry.id as number) > (guardedDeparture?.id as number),
        ) ?? null;
    if (!projectionRefresh) {
      throw new Error(
        "runtime trace must contain the real transaction projection refresh for the correlated order after Vision departure",
      );
    }
  }
  const uiAfterF2 = recordValue(ui.afterF2);
  const result = recordValue(uiAfterF2.result);
  if (
    uiAfterF2?.route !== "#/result/success" ||
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
    (entry: unknown) => {
      const record = recordValue(entry);
      return (
        record?.type === "transaction_surface" &&
        record?.stage === "result" &&
        record?.route === "#/result/success" &&
        record?.orderId === order.id &&
        record?.paymentId === payment.id &&
        record?.commandId === command.id &&
        record?.resultKind === "success"
      );
    },
  );
  const correlatedResultTrace = correlatedResultTraces
    .map((entry: unknown) => recordValue(entry))
    .find((entry) => {
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
      (entry: unknown) => {
        const record = recordValue(entry);
        return (
          record?.type === "navigation" &&
          (isCatalogRoute(record.finalRoute) ||
            isCatalogRoute(record.decidedRoute) ||
            isCatalogRoute(record.targetRoute))
        );
      },
    );
  if (catalogNavigation) {
    throw new Error(
      "runtime trace contains an actual or decided Catalog navigation after the stressed customer flow began",
    );
  }
  return {
    machineCode,
    machineId: recordValue(recordValue(platform.beforeF0).scope).machineId,
    orderId: order.id,
    orderNo: order.orderNo,
    paymentId: payment.id,
    paymentNo: payment.paymentNo,
    vendingCommandId: command.id,
    commandNo: command.commandNo,
    serialSessionId,
    inventoryId: orderItem.inventoryId,
    slotId: orderItem.slotId,
    slotDisplayLabel: daemonBefore.slotDisplayLabel,
    protocol: protocolFrames.map((frame: JsonRecord) => frame.parsedOpcode),
    daemonStockDeltaAfterF2:
      Number(daemonAfter.physicalStock) - Number(daemonMiddle.physicalStock),
    platformStockDeltaAfterF2:
      Number(platformAfter.onHandQty) - Number(platformMiddle.onHandQty),
    movementId: movement.id,
    visionEventId: vision.eventId,
    repeatedPhysicalTouchTraceId: repeatedTouch?.id ?? null,
    repeatedPhysicalTouchAt: repeatedTouch?.at ?? null,
    guardedNavigationReason: guardedDeparture?.reasonCode ?? null,
    projectionRefreshReason: projectionRefresh?.reasonCode ?? null,
    projectionRefreshRoute: projectionRefresh?.finalRoute ?? null,
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

function localPath(path: string): string {
  return process.platform === "win32"
    ? path
    : resolve(
        `/mnt/${path[0].toLowerCase()}/${path.slice(3).replaceAll("\\", "/")}`,
      );
}

function readJson(path: string, label: string): JsonRecord {
  return JSON.parse(readFileSync(localPath(path), "utf8"));
}

function writeJsonLocal(path: string, value: JsonRecord): void {
  const target = localPath(path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
}

function daemonBaseUrl(handoff: JsonRecord): string {
  const ready = recordValue(recordValue(handoff.daemon).ready);
  const healthzUrl = required(
    ready.healthzUrl,
    "daemon healthzUrl",
  );
  if (!healthzUrl.endsWith("/healthz")) {
    throw new Error("daemon healthzUrl must end with /healthz");
  }
  return healthzUrl.slice(0, -"/healthz".length);
}

function daemonHeaders(handoff: JsonRecord): Record<string, string> {
  const ready = recordValue(recordValue(handoff.daemon).ready);
  return {
    authorization: `Bearer ${required(ready.ipcToken, "daemon ipcToken")}`,
  };
}

interface FetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

async function fetchJson(
  url: string,
  options: FetchOptions = {},
): Promise<unknown> {
  const response = await fetch(url, {
    ...options,
    signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 30_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      `${options.method ?? "GET"} ${url} failed with HTTP ${response.status}: ${JSON.stringify(payload)}`,
    );
  }
  return payload;
}

export async function daemonGet(
  handoff: JsonRecord,
  path: string,
  options: Pick<FetchOptions, "timeoutMs" | "signal"> = {},
): Promise<unknown> {
  return fetchJson(`${daemonBaseUrl(handoff)}${path}`, {
    headers: daemonHeaders(handoff),
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
}

async function daemonPost(
  handoff: JsonRecord,
  path: string,
  body: JsonRecord = {},
  options: Pick<FetchOptions, "timeoutMs" | "signal"> = {},
): Promise<unknown> {
  return fetchJson(`${daemonBaseUrl(handoff)}${path}`, {
    method: "POST",
    headers: {
      ...daemonHeaders(handoff),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
}

function transactionIsActive(
  transaction: JsonRecord | null | undefined,
): boolean {
  return (
    ["wait_payment", "dispensing"].includes(
      String(transaction?.nextAction ?? ""),
    ) ||
    ["pending_payment", "waiting_payment", "paid", "dispensing"].includes(
      String(transaction?.orderStatus ?? ""),
    )
  );
}

export async function settlePendingCreateOrder({
  paymentNo,
  timeoutMs = PENDING_TRANSACTION_CLEANUP_TIMEOUT_MS,
  readTransaction,
  cancelTransaction,
  wait = sleep,
  now = () => Date.now(),
}: {
  paymentNo: unknown;
  timeoutMs?: number;
  readTransaction: () => Promise<unknown>;
  cancelTransaction: (transaction: JsonRecord) => Promise<unknown>;
  wait?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<JsonRecord> {
  const deadline = now() + timeoutMs;
  let transaction: JsonRecord | null = null;
  while (now() < deadline) {
    transaction = recordValue(
      await runCleanupStep(
        `read transaction for ${paymentNo}`,
        readTransaction,
        CLEANUP_REQUEST_TIMEOUT_MS,
      ),
    ).detail as JsonRecord;
    if (transaction?.paymentNo === paymentNo) break;
    await wait(100);
  }
  if (transaction?.paymentNo !== paymentNo) {
    throw new Error(
      `released payment create request did not project transaction ${paymentNo}`,
    );
  }
  if (transaction && !transactionIsActive(transaction)) return transaction;
  if (!transaction) {
    throw new Error(`transaction ${paymentNo} is missing before cancellation`);
  }
  await runCleanupStep(
    `cancel transaction for ${paymentNo}`,
    () => cancelTransaction(transaction as JsonRecord),
    CLEANUP_REQUEST_TIMEOUT_MS,
  );
  while (now() < deadline) {
    transaction = recordValue(
      await runCleanupStep(
        `read settled transaction for ${paymentNo}`,
        readTransaction,
        CLEANUP_REQUEST_TIMEOUT_MS,
      ),
    ).detail as JsonRecord;
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
  handoff: JsonRecord,
  client: unknown,
  timeoutMs = 30_000,
  {
    now = () => Date.now(),
    readRoute = readCdpLocationHash,
    readCapability = (input: JsonRecord) =>
      daemonGet(input, "/v1/sale-start-capability"),
    wait = sleep,
  } = {},
): Promise<unknown> {
  const mockPaymentOptionReady = (capability: unknown): boolean => {
    const paymentOptions = recordValue(
      recordValue(capability).paymentOptions,
    );
    return arrayValue(paymentOptions.options)
      .map((option: unknown) => recordValue(option))
      .some(
        (option) =>
          option?.optionKey === "mock:mock" &&
          option?.providerCode === "mock" &&
          option?.method === "mock" &&
          option?.ready === true &&
          option?.disabledReason === null,
      );
  };
  const deadline = now() + timeoutMs;
  let stableSince: number | null = null;
  let last: unknown = null;
  while (now() < deadline) {
    const [route, capability] = await Promise.all([
      readRoute(client),
      readCapability(handoff),
    ]);
    last = { route, capability };
    const capabilityRecord = recordValue(capability);
    if (
      route === "#/catalog" &&
      capabilityRecord?.canStartSale === true &&
      mockPaymentOptionReady(capability)
    ) {
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

export async function admitFreshSerialSessionForSale({
  guestInput,
  handoff,
  handoffPath,
  control,
  daemonGet: get,
  armCreateOrderGate: armGate,
  writeJsonFile,
  waitForHardwareReady = waitForBusinessHardwareReady,
}: {
  guestInput: JsonRecord;
  handoff: JsonRecord;
  handoffPath: string;
  control: (
    guestInput: JsonRecord,
    path: string,
    body?: JsonRecord,
  ) => Promise<unknown>;
  daemonGet: (path: string) => Promise<unknown>;
  armCreateOrderGate: (guestInput: JsonRecord) => Promise<unknown>;
  writeJsonFile: (path: string, value: JsonRecord) => void | Promise<void>;
  waitForHardwareReady?: typeof waitForBusinessHardwareReady;
}): Promise<FreshSerialAdmission> {
  if (typeof control !== "function") {
    throw new Error("fresh sale serial admission control is required");
  }
  if (typeof get !== "function") {
    throw new Error("fresh sale serial admission daemonGet is required");
  }
  if (typeof armGate !== "function") {
    throw new Error("fresh sale serial admission gate is required");
  }
  const { replacement } = await replaceSerialSessionAndUpdateHandoff({
    guestInput,
    handoff,
    handoffPath,
    sessionId: required(
      recordValue(handoff.commissioningSerialSession).sessionId,
      "handoff commissioning serial session id",
    ),
    control,
    writeJsonFile,
  });
  const sessionId = required(
    recordValue(replacement).sessionId,
    "fresh serial session id",
  );
  const hardware = await waitForHardwareReady({
    daemonGet: get,
  });
  return {
    serialSession: replacement,
    hardware,
    armCreateOrderGate: () => armGate(guestInput),
    runCustomerAction: (action: () => unknown) => {
      if (typeof action !== "function") {
        throw new Error("fresh sale customer action is required");
      }
      return action();
    },
    serialRequest: (operation: string, body: JsonRecord = {}) =>
      control(
        guestInput,
        `/v1/serial-sessions/${sessionId}/${required(operation, "serial operation")}`,
        body,
      ),
  };
}

async function waitForCommand(
  handoff: JsonRecord,
  renderedSale: JsonRecord,
  timeoutMs = 30_000,
): Promise<JsonRecord> {
  const deadline = Date.now() + timeoutMs;
  let lastTransaction: JsonRecord | null = null;
  while (Date.now() < deadline) {
    const transaction = recordValue(
      await daemonGet(handoff, "/v1/transactions/current").catch(() => null),
    );
    lastTransaction = transaction;
    const commandId =
      recordValue(transaction.vending).commandId ??
      transaction.dispenseCommandId ??
      null;
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
        vendingStatus: recordValue(transaction.vending).status ?? null,
      };
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error(
    `vending command did not appear for order ${renderedSale.orderId}: ${JSON.stringify(lastTransaction)}`,
  );
}

async function waitForSuccessfulResultSurface(
  client: unknown,
  expected: JsonRecord,
  timeoutMs = 60_000,
): Promise<JsonRecord> {
  const deadline = Date.now() + timeoutMs;
  let last: JsonRecord | null = null;
  do {
    last = recordValue(await readUiBoundary(client).catch(() => null));
    if (
      last?.route === "#/result/success" &&
      recordValue(last.result).kind === "success" &&
      recordValue(last.result).orderId === expected.orderId &&
      recordValue(last.result).paymentId === expected.paymentId &&
      recordValue(last.result).orderNo === expected.orderNo &&
      recordValue(last.result).commandId === expected.commandId
    ) {
      return last;
    }
    await sleep(250);
  } while (Date.now() < deadline);
  throw new Error(
    `timed out waiting for #/result/success with correlated order/payment/command: ${JSON.stringify(last)}`,
  );
}

async function readRuntimeTraceSnapshot(client: unknown): Promise<JsonRecord> {
  return runtimeTraceSnapshot(
    recordValue(await readMachineRuntimeTraceSnapshot(client)),
    "Machine Runtime Trace",
  );
}

interface CdpEventClient {
  on: (
    event: string,
    listener: (params: JsonRecord) => void,
  ) => () => void;
}

interface CdpLocationHashObserver extends JsonRecord {
  assertArmed: () => void;
  throwIfFailed: () => void;
  finish: (expectedTerminalHash: string) => Promise<JsonRecord>;
  snapshot: () => JsonRecord;
  stop: () => JsonRecord;
}

interface FreshSerialAdmission extends JsonRecord {
  serialSession: JsonRecord;
  hardware: unknown;
  armCreateOrderGate: () => Promise<unknown>;
  runCustomerAction: (action: () => unknown) => unknown;
  serialRequest: (operation: string, body?: JsonRecord) => Promise<unknown>;
}

export async function startContinuousCdpLocationHashObservation(
  client: unknown,
  { clock = () => new Date() }: { clock?: () => Date } = {},
): Promise<CdpLocationHashObserver> {
  const cdp = client as CdpEventClient;
  const entries: JsonRecord[] = [];
  const startedAt = clock().toISOString();
  let armedAt: string | null = null;
  let terminalAt: string | null = null;
  let terminalHash: string | null = null;
  let stopped = false;
  let failure: Error | null = null;

  const recordHash = (method: string, locationHash: string) => {
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
  const recordUrl = (method: string, url: string) => {
    try {
      recordHash(method, locationHashFromCdpUrl(url, method));
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    }
  };
  const offWithinDocument = cdp.on(
    "Page.navigatedWithinDocument",
    (params) =>
      recordUrl(
        "Page.navigatedWithinDocument",
        String(recordValue(params).url ?? ""),
      ),
  );
  const offFrameNavigated = cdp.on("Page.frameNavigated", (params) => {
    const frame = recordValue(params.frame);
    if (frame?.parentId == null) {
      recordUrl("Page.frameNavigated", String(frame.url ?? ""));
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
    async finish(expectedTerminalHash: string) {
      const observedTerminalHash = String(
        (await readCdpLocationHash(client)) ?? "",
      );
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

async function captureRuntimeTraceBoundary(
  client: unknown,
  label: string,
): Promise<JsonRecord> {
  return traceBoundary(await readRuntimeTraceSnapshot(client), label);
}

async function waitForRepeatedCustomerTouchTrace(
  client: unknown,
  preDispatchTraceBoundary: JsonRecord,
  timeoutMs = 5_000,
): Promise<JsonRecord> {
  const deadline = Date.now() + timeoutMs;
  let lastTrace: unknown[] = [];
  do {
    const snapshot = await readRuntimeTraceSnapshot(client);
    lastTrace = arrayValue(snapshot.entries);
    const touch = traceEntriesAfterBoundary(
      snapshot,
      preDispatchTraceBoundary,
      "repeated payment touch pre-dispatch trace boundary",
    )
      .map((entry: unknown) => recordValue(entry))
      .find(
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
  client: unknown,
  traceBoundary: JsonRecord,
  {
    timeoutMs = 15_000,
    readTrace = readRuntimeTraceSnapshot,
    sleepFn = sleep,
    now = () => Date.now(),
  } = {},
): Promise<JsonRecord> {
  const deadline = now() + timeoutMs;
  let lastTrace: unknown[] = [];
  do {
    const snapshot = await readTrace(client);
    lastTrace = arrayValue(snapshot.entries);
    const departure = traceEntriesAfterBoundary(
      snapshot,
      traceBoundary,
      "Vision departure control-request trace boundary",
    )
      .map((entry: unknown) => recordValue(entry))
      .find(
        (entry) =>
          entry?.type === "navigation" &&
          entry?.intentType === "presence.departed" &&
          /^presence-\d+:departure$/.test(
            String(entry?.sourceEventId ?? ""),
          ) &&
          entry?.decision === "rejected" &&
          ["touchscreen_session_active", "active_transaction_route"].includes(
            String(entry?.reasonCode ?? ""),
          ) &&
          entry?.finalRoute !== "#/catalog",
      );
    if (departure) return departure;
    await sleepFn(25);
  } while (now() < deadline);
  throw new Error(
    `installed runtime did not trace a guarded stable Vision departure after the control-request boundary: ${JSON.stringify(lastTrace.slice(-8))}`,
  );
}

export async function waitForStableVisionArrivalTrace(
  client: unknown,
  traceBoundary: JsonRecord,
  {
    timeoutMs = 5_000,
    readTrace = readRuntimeTraceSnapshot,
    sleepFn = sleep,
    now = () => Date.now(),
  } = {},
): Promise<JsonRecord> {
  const deadline = now() + timeoutMs;
  let lastTrace: unknown[] = [];
  do {
    const snapshot = await readTrace(client);
    lastTrace = arrayValue(snapshot.entries);
    const arrival = traceEntriesAfterBoundary(
      snapshot,
      traceBoundary,
      "Vision arrival control-request trace boundary",
    )
      .map((entry: unknown) => recordValue(entry))
      .find(
        (entry) =>
          entry?.type === "journey_transition" &&
          /^vision:presence-\d+:welcome$/.test(
            String(entry?.transitionId ?? ""),
          ),
      );
    if (arrival) return arrival;
    const activeTouchSession = traceEntriesAfterBoundary(
      snapshot,
      traceBoundary,
      "Vision arrival control-request trace boundary",
    )
      .map((entry: unknown) => recordValue(entry))
      .find(
        (entry) =>
          entry?.type === "navigation" &&
          entry?.intentType === "customer.touch" &&
          entry?.decision === "accepted" &&
          entry?.reasonCode === "touchscreen_session_renewed",
      );
    if (activeTouchSession) return activeTouchSession;
    await sleepFn(25);
  } while (now() < deadline);
  throw new Error(
    `installed runtime did not trace a stable Vision arrival or active touch session after the control-request boundary: ${JSON.stringify(lastTrace.slice(-8))}`,
  );
}

export async function waitForStableVisionDepartureTransition(
  client: unknown,
  traceBoundary: JsonRecord,
  {
    timeoutMs = 15_000,
    readTrace = readRuntimeTraceSnapshot,
    sleepFn = sleep,
    now = () => Date.now(),
  } = {},
): Promise<JsonRecord> {
  const deadline = now() + timeoutMs;
  let lastTrace: unknown[] = [];
  do {
    const snapshot = await readTrace(client);
    lastTrace = arrayValue(snapshot.entries);
    const departure = traceEntriesAfterBoundary(
      snapshot,
      traceBoundary,
      "Vision presence reset boundary",
    )
      .map((entry: unknown) => recordValue(entry))
      .find(
        (entry) =>
          entry?.type === "journey_transition" &&
          /^vision:presence-\d+:departed$/.test(
            String(entry?.transitionId ?? ""),
          ),
      );
    if (departure) return departure;
    await sleepFn(25);
  } while (now() < deadline);
  throw new Error(
    `installed runtime did not settle the previous Vision presence before a fresh sale: ${JSON.stringify(lastTrace.slice(-8))}`,
  );
}

async function readInstalledUiViewport(client: unknown): Promise<JsonRecord> {
  return recordValue(
    await evaluateExpression(
      client as Parameters<typeof evaluateExpression>[0],
      `(() => ({
      route: location.hash,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      documentClientWidth: document.documentElement.clientWidth,
      documentClientHeight: document.documentElement.clientHeight,
      visualViewportWidth: window.visualViewport?.width ?? null,
      visualViewportHeight: window.visualViewport?.height ?? null
    }))()`,
    ),
  );
}

async function readRenderedPaymentSurface(
  client: unknown,
): Promise<JsonRecord> {
  const hook = await evaluateExpression(
    client as Parameters<typeof evaluateExpression>[0],
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
  const hookRecord = recordValue(hook);
  if (!hookRecord?.orderId || !hookRecord?.paymentId || !hookRecord?.orderNo) {
    throw new Error("required rendered customer UI payment hook is missing");
  }
  return hookRecord;
}

async function readUiBoundary(client: unknown): Promise<JsonRecord> {
  return recordValue(
    await evaluateExpression(
      client as Parameters<typeof evaluateExpression>[0],
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
    ),
  );
}

async function waitForPlatformMovement(
  guestInput: JsonRecord,
  input: JsonRecord,
  baselineCount: number,
  expected: JsonRecord,
  timeoutMs = 30_000,
): Promise<JsonRecord> {
  const deadline = Date.now() + timeoutMs;
  let last: JsonRecord | null = null;
  do {
    last = recordValue(
      recordValue(
        await controlPlaneRequest(guestInput, "/v1/platform/query", input),
      ).report,
    );
    const raw = recordValue(last?.raw);
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

async function waitForDaemonSaleViewAfterF2(
  handoff: JsonRecord,
  identity: JsonRecord,
  middle: JsonRecord,
  quantity: unknown,
  timeoutMs = 30_000,
): Promise<JsonRecord> {
  const expectedPhysicalStock = Math.max(
    0,
    Number(middle.physicalStock) - Number(quantity),
  );
  const expectedSaleableStock = middle.saleableStock;
  const deadline = Date.now() + timeoutMs;
  let last: JsonRecord | null = null;
  do {
    last = recordValue(await daemonGet(handoff, "/v1/sale-view"));
    const item = matchingItem(last, identity);
    if (
      Number(item?.physicalStock) === expectedPhysicalStock &&
      item?.saleableStock === expectedSaleableStock
    ) {
      return last;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  } while (Date.now() < deadline);
  throw new Error(
    `daemon sale-view did not reach terminal post-F2 stock projection for ${JSON.stringify(
      {
        identity,
        expectedPhysicalStock,
        expectedSaleableStock,
        last: matchingItem(last, identity) ?? null,
      },
    )}`,
  );
}

async function waitForBeforeF0Boundary(
  guestInput: JsonRecord,
  input: JsonRecord,
  baselineRaw: JsonRecord,
  renderedSale: JsonRecord,
  liveSale: JsonRecord,
  expectedPaymentNo: unknown,
  timeoutMs = 30_000,
): Promise<JsonRecord> {
  const baselineOrders = rows(baselineRaw, "orders").length;
  const baselinePayments = rows(baselineRaw, "payments").length;
  const baselineCommands = rows(baselineRaw, "commands").length;
  const baselineMovements = rows(baselineRaw, "movements").length;
  const deadline = Date.now() + timeoutMs;
  let last: JsonRecord | null = null;
  do {
    last = recordValue(
      recordValue(
        await controlPlaneRequest(guestInput, "/v1/platform/query", input),
      ).report,
    );
    const raw = recordValue(last?.raw);
    const order = rows(raw, "orders")
      .map((row: unknown) => recordValue(row))
      .find((row) => row.id === renderedSale.orderId);
    const payment = rows(raw, "payments")
      .map((row: unknown) => recordValue(row))
      .find((row) => row.id === renderedSale.paymentId);
    const command = rows(raw, "commands")
      .map((row: unknown) => recordValue(row))
      .find((row) => row.id === liveSale.vendingCommandId);
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

function writeReport(outPath: string, report: JsonRecord): void {
  const path = localPath(outPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
}

function screenshotSink(outPath: string): (
  input: {
    bytes: Uint8Array;
    sha256: string;
    label: string;
    format: string;
  },
) => Promise<JsonRecord> {
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

function writeBoundedLogTail(
  sourcePath: string,
  outPath: string,
  label: string,
  maxBytes = 64 * 1024,
): JsonRecord | null {
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

function writeTextArtifact(
  outPath: string,
  label: string,
  text: unknown,
): JsonRecord {
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

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolvePromise) => setTimeout(resolvePromise, ms));
}

function serializeError(error: unknown): JsonRecord {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: String(error.stack ?? "").slice(0, 16 * 1024),
    };
  }
  return { name: "Error", message: String(error) };
}

function cleanupTimeout(label: string, timeoutMs: number): Promise<never> {
  return new Promise<never>((_, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} exceeded ${timeoutMs}ms cleanup deadline`));
    }, timeoutMs);
    timer.unref?.();
  });
}

export async function runCleanupStep(
  label: string,
  action: () => unknown | Promise<unknown>,
  timeoutMs = CLEANUP_TIMEOUT_MS,
): Promise<JsonRecord> {
  try {
    const detail = await Promise.race([
      action(),
      cleanupTimeout(label, timeoutMs),
    ]);
    return { label, ok: true, detail };
  } catch (error) {
    const wrapped: CleanupError = new Error(
      `${label} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    wrapped.cause = error;
    wrapped.cleanupLabel = label;
    throw wrapped;
  }
}

export function combineCleanupError(
  primaryError: Error | null | undefined,
  cleanupErrors: Error[],
): Error | null {
  if (cleanupErrors.length === 0) return primaryError ?? null;
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

async function collectCleanupStep(
  cleanup: JsonRecord[],
  cleanupErrors: Error[],
  label: string,
  action: () => unknown | Promise<unknown>,
  timeoutMs = CLEANUP_TIMEOUT_MS,
): Promise<unknown> {
  try {
    const result = await runCleanupStep(label, action, timeoutMs);
    cleanup.push(result);
    return result.detail;
  } catch (error) {
    cleanupErrors.push(error as Error);
    cleanup.push({
      label: (error as CleanupError).cleanupLabel ?? label,
      ok: false,
      error: serializeError(error),
    });
    return null;
  }
}

export function buildFastRouteStressSaleFailureReport(
  input: JsonRecord,
): JsonRecord {
  const error = input.error;
  const snapshots = recordValue(input.snapshots);
  const platform = recordValue(snapshots.platform);
  const daemon = recordValue(snapshots.daemon);
  const logs = recordValue(input.logs);
  const checkpoints = arrayValue(input.checkpoints);
  return {
    schemaVersion: "vem-fast-route-stress-sale/v2",
    ok: false,
    handoffSerialSessionId: input.handoffSerialSessionId ?? null,
    mode: input.mode,
    stage: input.stage,
    error:
      error instanceof Error
        ? {
            name: error.name,
            message: error.message,
            stack: String(error.stack ?? "").slice(0, 16 * 1024),
          }
        : { name: "Error", message: String(error) },
    controlPlaneSessionId: input.controlPlaneSessionId ?? null,
    liveSale: input.liveSale ?? null,
    runtimeTrace: compactRuntimeTrace(input.runtimeTrace ?? [], 256),
    continuousCdpLocationHash: input.continuousCdpLocationHash ?? null,
    snapshots: {
      platform: {
        baseline: platform.baseline ?? null,
        beforeF0: platform.beforeF0 ?? null,
        afterF1BeforeF2: platform.afterF1BeforeF2 ?? null,
        afterF2: platform.afterF2 ?? null,
      },
      daemon: {
        baseline: daemon.baseline ?? null,
        beforeF0: daemon.beforeF0 ?? null,
        afterF1BeforeF2: daemon.afterF1BeforeF2 ?? null,
        afterF2: daemon.afterF2 ?? null,
        failureCurrentTransaction:
          daemon.failureCurrentTransaction ?? null,
      },
    },
    hostEvidence: input.hostEvidence ?? null,
    checkpoints: input.checkpoints ?? [],
    cleanup: input.cleanup ?? [],
    cleanupError: input.cleanupError ?? null,
    logs: {
      daemonStdout: logs.daemonStdout ?? null,
      daemonStderr: logs.daemonStderr ?? null,
      platform: logs.platform ?? null,
      platformError: logs.platformError ?? null,
      simulator: logs.simulator ?? null,
      failureScreenshots: checkpoints
        .map((checkpoint: unknown) =>
          recordValue(recordValue(checkpoint).screenshot).ref,
        )
        .filter(Boolean),
    },
  };
}

export function buildFastRouteStressSaleSuccessReport(
  input: JsonRecord,
): JsonRecord {
  const sessionStart = recordValue(input?.sessionStart);
  const sessionId = required(
    sessionStart.sessionId,
    "successful sale serial session id",
  );
  return {
    schemaVersion: "vem-fast-route-stress-sale/v2",
    ok: true,
    handoffSerialSessionId: sessionId,
    mode: input.mode,
    runId: input.runId,
    machineCode: input.machineCode,
    resultRoute: input.resultRoute,
    controlPlaneSessionId: sessionId,
    renderedSale: input.renderedSale,
    liveSale: input.liveSale,
    summary: input.summary,
    boundaries: input.boundaries,
    evidence: input.evidence,
    serial: {
      start: input.serialStart ?? sessionStart,
      collect: input.collect,
      stop: input.stop,
      stopRepeat: input.stopRepeat,
    },
    runtimeTrace: input.runtimeTrace,
    checkpoints: input.checkpoints,
    logs: input.logs,
    cleanup: input.cleanup,
  };
}

export async function controlPlaneRequest(
  guestInput: JsonRecord,
  path: string,
  body: JsonRecord = {},
  options: Pick<FetchOptions, "timeoutMs" | "signal"> = {},
): Promise<unknown> {
  const controlPlane = recordValue(guestInput.hostControlPlane);
  if (!controlPlane?.endpoint || !controlPlane?.token) {
    throw new Error(
      "guest input is missing hostControlPlane endpoint and token",
    );
  }
  // The Linux host control plane is the runner-owned bridge to run-vm-host-adapter.ts.
  const request: FetchOptions = {
    method: "POST",
    headers: {
      authorization: `Bearer ${controlPlane.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  };
  let lastError: unknown;
  const requestSignal = request.signal;
  for (const retryDelayMs of [0, 100, 250]) {
    if (retryDelayMs > 0) {
      if (requestSignal?.aborted) throw requestSignal.reason;
      await new Promise<void>((resolvePromise, reject) => {
        let timer: NodeJS.Timeout;
        const finish = () => {
          requestSignal?.removeEventListener("abort", abort);
          resolvePromise();
        };
        const abort = () => {
          clearTimeout(timer);
          requestSignal?.removeEventListener("abort", abort);
          reject(requestSignal?.reason);
        };
        timer = setTimeout(finish, retryDelayMs);
        requestSignal?.addEventListener("abort", abort, { once: true });
      });
    }
    try {
      return await fetchJson(`${controlPlane.endpoint}${path}`, request);
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

async function collectPlatformLog(
  guestInput: JsonRecord,
  sessionId: unknown,
  outPath: string,
): Promise<JsonRecord> {
  const result = await controlPlaneRequest(
    guestInput,
    `/v1/serial-sessions/${sessionId}/platform-log`,
    { lines: 200 },
  );
  const resultRecord = recordValue(result);
  return {
    reference: resultRecord.reference ?? null,
    unit: resultRecord.unit,
    artifact: writeTextArtifact(
      outPath,
      "platform-service-api",
      resultRecord.log ?? "",
    ),
  };
}

async function runPowerShellScript(
  script: string,
  label: string,
): Promise<string> {
  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const exitCode = await new Promise<number>((resolvePromise) => {
    child.once("exit", (code) => resolvePromise(code ?? 1));
  });
  if (exitCode !== 0) {
    throw new Error(
      `${label} failed with exit code ${exitCode}: ${stderr || stdout}`,
    );
  }
  return stdout;
}

export async function stopInstalledVisionOwnerForControlledMock() {
  await runPowerShellScript(
    String.raw`
$ErrorActionPreference = "Stop"
Stop-ScheduledTask -TaskName "VEMVisionRuntime" -ErrorAction SilentlyContinue
$canonicalExecutablePath = [IO.Path]::GetFullPath("C:\VEM\vision\app\vending-vision.exe")
$canonicalConfigurationPath = [IO.Path]::GetFullPath("C:\ProgramData\VEM\vision\site.json").ToLowerInvariant()
$deadline = [DateTime]::UtcNow.AddSeconds(10)
do {
  $ownedProcesses = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ExecutablePath -and
    [IO.Path]::GetFullPath([string]$_.ExecutablePath) -ieq $canonicalExecutablePath -and
    $_.CommandLine -and
    ([string]$_.CommandLine).ToLowerInvariant().Contains("--config") -and
    ([string]$_.CommandLine).ToLowerInvariant().Contains($canonicalConfigurationPath)
  })
  foreach ($process in $ownedProcesses) {
    Stop-Process -Id ([int]$process.ProcessId) -Force -ErrorAction SilentlyContinue
  }
  if ($ownedProcesses.Count -eq 0) { break }
  Start-Sleep -Milliseconds 250
} while ([DateTime]::UtcNow -lt $deadline)
if ($ownedProcesses.Count -ne 0) {
  throw "installed Vision owner did not stop before controlled mock startup"
}
`,
    "stop installed Vision owner",
  );
  await verifyPortCanBeRebound(7892);
}

export async function ensureControlledVisionMock(
  controlPort: number,
): Promise<JsonRecord> {
  try {
    const status = recordValue(await fetchJson(
      `http://127.0.0.1:${controlPort}/control/status`,
    ));
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
      const status = recordValue(await fetchJson(
        `http://127.0.0.1:${controlPort}/control/status`,
      ));
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

export async function waitForControlledVisionRuntimeClient(
  controlPort: number,
): Promise<JsonRecord> {
  const deadline = Date.now() + 30_000;
  let lastStatus: JsonRecord | null = null;
  while (Date.now() < deadline) {
    try {
      lastStatus = recordValue(await fetchJson(
        `http://127.0.0.1:${controlPort}/control/status`,
      ));
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

function hasChildExited(child: ReturnType<typeof spawn>): boolean {
  return child.exitCode != null || child.signalCode != null;
}

async function waitForChildExit(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<boolean> {
  if (hasChildExited(child)) return true;
  return await new Promise<boolean>((resolvePromise) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolvePromise(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolvePromise(true);
    };
    child.once("exit", onExit);
    if (hasChildExited(child)) {
      clearTimeout(timer);
      child.off("exit", onExit);
      resolvePromise(true);
    }
  });
}

async function verifyPortCanBeRebound(port: number): Promise<void> {
  const listener = createServer();
  try {
    await new Promise<void>((resolvePromise, reject) => {
      listener.once("error", reject);
      listener.listen(port, "127.0.0.1", resolvePromise);
    });
  } finally {
    if (listener.listening) {
      await new Promise<void>((resolvePromise, reject) => {
        listener.close((error) => (error ? reject(error) : resolvePromise()));
      });
    }
  }
}

export async function shutdownControlledVisionMock(
  child: ReturnType<typeof spawn> | null,
  timeoutMs = 10_000,
  visionPort = 7892,
): Promise<void> {
  if (!child) return;
  if (!hasChildExited(child)) {
    child.kill("SIGTERM");
    if (!(await waitForChildExit(child, timeoutMs))) {
      child.kill("SIGKILL");
      if (!(await waitForChildExit(child, timeoutMs))) {
        throw new Error(
          "controlled vision mock child did not exit after SIGTERM and SIGKILL",
        );
      }
    }
  }
  try {
    await verifyPortCanBeRebound(visionPort);
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(
      `controlled vision mock did not release port ${visionPort} after SIGTERM${detail}`,
    );
  }
}

function visionMockControlPort(guestInput: JsonRecord): number {
  const port =
    recordValue(guestInput.hostControlPlane).visionMockControlPort ??
    guestInput.visionMockControlPort;
  const controlPort = Number(port);
  if (!Number.isInteger(controlPort) || controlPort < 1) {
    throw new Error("guest input is missing vision mock control port");
  }
  return controlPort;
}

async function dispatchVisionDeparture(
  guestInput: JsonRecord,
): Promise<unknown> {
  const controlPort = visionMockControlPort(guestInput);
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

async function dispatchVisionArrival(
  guestInput: JsonRecord,
): Promise<unknown> {
  const controlPort = visionMockControlPort(guestInput);
  return fetchJson(`http://127.0.0.1:${controlPort}/control/presence`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ state: "approach" }),
  });
}

async function dispatchCatalogTouchSession(
  client: unknown,
): Promise<JsonRecord> {
  const point = recordValue(
    await evaluateExpression(
      client as Parameters<typeof evaluateExpression>[0],
      `(() => {
      const target =
        document.querySelector("[data-test='catalog-page']") ??
        document.body ??
        document.documentElement;
      const rect = target.getBoundingClientRect();
      const x = Math.max(1, Math.min(innerWidth - 1, rect.left + Math.min(64, Math.max(16, rect.width / 2))));
      const y = Math.max(1, Math.min(innerHeight - 1, rect.top + Math.min(64, Math.max(16, rect.height / 2))));
      return { x, y, selector: target.getAttribute?.("data-test") ?? target.tagName };
    })()`,
    ),
  );
  return {
    ...point,
    input: await dispatchPhysicalInput(
      client as Parameters<typeof dispatchPhysicalInput>[0],
      point as Parameters<typeof dispatchPhysicalInput>[1],
      {
      kind: "touch",
      timeoutMs: 5_000,
      },
    ),
  };
}

export async function waitForVisionArrivalOrTouchSession(
  client: unknown,
  traceBoundary: JsonRecord,
  {
    waitArrival = waitForStableVisionArrivalTrace,
    dispatchTouch = dispatchCatalogTouchSession,
    readTrace = readRuntimeTraceSnapshot,
    arrivalTimeoutMs = 5_000,
    touchTimeoutMs = 3_000,
  } = {},
): Promise<JsonRecord> {
  try {
    return {
      trace: await waitArrival(client, traceBoundary, {
        timeoutMs: arrivalTimeoutMs,
      }),
      fallback: null,
    };
  } catch (arrivalError) {
    if (traceBoundary?.touchscreenSessionActive === true) {
      return {
        trace: {
          type: "navigation",
          intentType: "customer.touch",
          decision: "accepted",
          reasonCode: "touchscreen_session_already_active",
          id: traceBoundary.lastEntryId,
        },
        fallback: {
          kind: "existing_touchscreen_session",
          arrivalError:
            arrivalError instanceof Error
              ? arrivalError.message
              : String(arrivalError),
        },
      };
    }
    const touch = await dispatchTouch(client);
    try {
      return {
        trace: await waitArrival(client, traceBoundary, {
          timeoutMs: touchTimeoutMs,
        }),
        fallback: {
          kind: "touchscreen_session",
          touch,
          arrivalError:
            arrivalError instanceof Error
              ? arrivalError.message
              : String(arrivalError),
        },
      };
    } catch (touchArrivalError) {
    const snapshot = await readTrace(client);
    if (latestTouchscreenSessionActive(arrayValue(snapshot.entries))) {
        return {
          trace: {
            type: "navigation",
            intentType: "customer.touch",
            decision: "accepted",
            reasonCode: "touchscreen_session_active_after_dispatch",
            id: traceBoundary.lastEntryId,
          },
          fallback: {
            kind: "touchscreen_session_active_after_dispatch",
            touch,
            arrivalError:
              arrivalError instanceof Error
                ? arrivalError.message
                : String(arrivalError),
            touchArrivalError:
              touchArrivalError instanceof Error
                ? touchArrivalError.message
                : String(touchArrivalError),
          },
        };
      }
      throw touchArrivalError;
    }
  }
}

async function establishVisionPresenceForSale(
  guestInput: JsonRecord,
  client: unknown,
): Promise<JsonRecord> {
  const resetBoundary = await captureRuntimeTraceBoundary(
    client,
    "Vision presence reset boundary",
  );
  if (resetBoundary.visionPresenceActive === true) {
    return {
      precondition: "existing-arrival",
      resetPrecondition: "existing-presence-retained",
      resetDelivery: null,
      resetTransitionId: null,
      ok: true,
      eventId: null,
      connectedRuntimeClients: null,
      acceptedDeliveries: null,
      traceBoundary: resetBoundary,
      fallback: null,
      transitionId: resetBoundary.visionPresenceTransitionId,
      touchNavigationTraceId: null,
      completedAt: new Date().toISOString(),
    };
  }
  if (resetBoundary.touchscreenSessionActive === true) {
    return {
      precondition: "existing-touchscreen-session",
      resetPrecondition: "existing-touchscreen-session-retained",
      resetDelivery: null,
      resetTransitionId: null,
      ok: true,
      eventId: null,
      connectedRuntimeClients: null,
      acceptedDeliveries: null,
      traceBoundary: resetBoundary,
      fallback: {
        kind: "existing_touchscreen_session",
      },
      transitionId: null,
      touchNavigationTraceId: resetBoundary.lastEntryId,
      completedAt: new Date().toISOString(),
    };
  }
  let resetPrecondition = "existing-presence-departed";
  let resetDelivery: unknown = await dispatchVisionDeparture(guestInput);
  let resetTrace: JsonRecord | null = null;
  try {
    resetTrace = await waitForStableVisionDepartureTransition(
      client,
      resetBoundary,
      { timeoutMs: 7_000 },
    );
  } catch (initialDepartureError) {
    resetPrecondition = "synthetic-arrival-departed";
    const resetArrivalDelivery = await dispatchVisionArrival(guestInput);
    const resetArrivalTrace = await waitForStableVisionArrivalTrace(
      client,
      resetBoundary,
      { timeoutMs: 7_000 },
    );
    resetDelivery = {
      firstDepartureError:
        initialDepartureError instanceof Error
          ? initialDepartureError.message
          : String(initialDepartureError),
      resetArrivalDelivery,
      resetArrivalTrace,
      ...recordValue(await dispatchVisionDeparture(guestInput)),
    };
    resetTrace = await waitForStableVisionDepartureTransition(
      client,
      resetBoundary,
      { timeoutMs: 7_000 },
    );
  }
  const arrivalTraceBoundary = await captureRuntimeTraceBoundary(
    client,
    "Vision arrival control-request trace boundary",
  );
  const delivery = recordValue(await dispatchVisionArrival(guestInput));
  const arrivalOrTouch = await waitForVisionArrivalOrTouchSession(
    client,
    arrivalTraceBoundary,
  );
  const arrivalOrTouchRecord = recordValue(arrivalOrTouch);
  const trace = recordValue(arrivalOrTouchRecord.trace);
  return {
    precondition: "fresh-arrival",
    resetPrecondition,
    resetDelivery,
    resetTransitionId: resetTrace.transitionId,
    ...delivery,
    traceBoundary: arrivalTraceBoundary,
    fallback: arrivalOrTouch.fallback,
    transitionId: trace.transitionId,
    touchNavigationTraceId:
      trace.intentType === "customer.touch" ? trace.id : null,
    completedAt: new Date().toISOString(),
  };
}

async function completeMockPayment(
  guestInput: JsonRecord,
  paymentNo: unknown,
): Promise<unknown> {
  const runtimeBootstrap = recordValue(guestInput?.runtimeBootstrap);
  const provisioningApiBaseUrl = required(
    runtimeBootstrap.provisioningApiBaseUrl,
    "runtimeBootstrap.provisioningApiBaseUrl",
  );
  const apiBase = provisioningApiBaseUrl.replace(/\/+$/, "");
  return fetchJson(
    `${apiBase}/payments/mock/${encodeURIComponent(String(paymentNo))}/complete`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
    },
  );
}

const installedOwnerOrdinarySaleDependencies = Object.freeze({
  waitForRoute,
  waitForSaleStartReady,
  readInstalledUiViewport,
  readDaemonSaleView: (handoff: JsonRecord) =>
    daemonGet(handoff, "/v1/sale-view"),
  readCurrentTransaction: (
    handoff: JsonRecord,
    options: Pick<FetchOptions, "timeoutMs" | "signal"> = {},
  ) =>
    daemonGet(handoff, "/v1/transactions/current", options),
  readPlatform: async (guestInput: JsonRecord, body: JsonRecord) =>
    recordValue(
      await controlPlaneRequest(guestInput, "/v1/platform/query", body),
    ).report,
  activateVisibleSelector,
  armCreateOrderGate,
  waitForCreateOrderGatePending,
  releaseCreateOrderGate: (
    guestInput: JsonRecord,
    paymentNo: unknown,
    options: Pick<FetchOptions, "timeoutMs" | "signal"> = {},
  ) =>
    controlPlaneRequest(
      guestInput,
      "/v1/mock-payment-create-gate/release",
      { paymentNo },
      options,
    ).then((released) => {
      const releasedRecord = recordValue(released);
      return {
        paymentNo,
        releasedAt: releasedRecord.releasedAt,
      };
    }),
  readRenderedPaymentSurface,
  completeMockPayment,
  waitForCommand,
  waitForBeforeF0Boundary,
  readUiBoundary,
  waitForSuccessfulResultSurface,
  waitForPlatformMovement,
  waitForDaemonSaleViewAfterF2,
  readRuntimeTraceSnapshot,
  captureRuntimeTraceBoundary,
  startContinuousCdpLocationHashObservation,
  serialRequest: (
    guestInput: JsonRecord,
    sessionId: unknown,
    operation: string,
    body: JsonRecord = {},
  ) =>
    controlPlaneRequest(
      guestInput,
      `/v1/serial-sessions/${sessionId}/${operation}`,
      body,
    ),
  cancelTransaction: (
    handoff: JsonRecord,
    transaction: JsonRecord | null | undefined,
    options: Pick<FetchOptions, "timeoutMs" | "signal">,
  ) =>
    fetchJson(`${daemonBaseUrl(handoff)}/v1/intents/cancel-order`, {
      method: "POST",
      headers: {
        ...daemonHeaders(handoff),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        orderNo: required(transaction?.orderNo, "active orderNo"),
      }),
      ...options,
    }),
  openCreateOrderGate: (
    guestInput: JsonRecord,
    options: Pick<FetchOptions, "timeoutMs" | "signal"> = {},
  ) =>
    controlPlaneRequest(
      guestInput,
      "/v1/mock-payment-create-gate/open",
      {},
      options,
    ),
  readCreateOrderGate: (
    guestInput: JsonRecord,
    options: Pick<FetchOptions, "timeoutMs" | "signal"> = {},
  ) =>
    controlPlaneRequest(
      guestInput,
      "/v1/mock-payment-create-gate/status",
      {},
      options,
    ),
});

function boundedCleanupRequest(
  deadline: number,
): Pick<FetchOptions, "timeoutMs" | "signal"> {
  const remaining = deadline - performance.now();
  if (remaining <= 0)
    throw new Error("ordinary sale cleanup deadline exceeded");
  const timeoutMs = Math.max(
    1,
    Math.min(CLEANUP_REQUEST_TIMEOUT_MS, Math.ceil(remaining)),
  );
  return { timeoutMs, signal: AbortSignal.timeout(timeoutMs) };
}

export async function waitForOrdinarySaleCleanupPoll(
  deadline: number,
  maxDelayMs = 100,
): Promise<void> {
  const remaining = deadline - performance.now();
  if (remaining <= 0)
    throw new Error("ordinary sale cleanup deadline exceeded");
  const delayMs = Math.max(1, Math.min(maxDelayMs, Math.ceil(remaining)));
  const deadlineSignal = AbortSignal.timeout(Math.max(1, Math.ceil(remaining)));
  await new Promise<void>((resolvePromise, reject) => {
    let timer: NodeJS.Timeout;
    const finish = () => {
      deadlineSignal.removeEventListener("abort", abort);
      resolvePromise();
    };
    const abort = () => {
      clearTimeout(timer);
      deadlineSignal.removeEventListener("abort", abort);
      reject(new Error("ordinary sale cleanup deadline exceeded"));
    };
    timer = setTimeout(finish, delayMs);
    deadlineSignal.addEventListener("abort", abort, { once: true });
  });
  boundedCleanupRequest(deadline);
}

async function cleanupOrdinarySalePayment({
  dependencies,
  guestInput,
  handoff,
  deadline,
  knownPaymentNo,
}: {
  dependencies: typeof installedOwnerOrdinarySaleDependencies;
  guestInput: JsonRecord;
  handoff: JsonRecord;
  deadline: number;
  knownPaymentNo: unknown;
}): Promise<JsonRecord> {
  const status = recordValue(
    await dependencies.readCreateOrderGate(
      guestInput,
      boundedCleanupRequest(deadline),
    ),
  );
  const pendingPaymentNo = recordValue(status.pending).paymentNo;
  if (
    typeof pendingPaymentNo === "string" &&
    pendingPaymentNo !== "" &&
    typeof knownPaymentNo === "string" &&
    knownPaymentNo !== "" &&
    pendingPaymentNo !== knownPaymentNo
  )
    throw new Error(
      "payment create gate pending identity conflicts with the known payment",
    );
  const paymentNo = pendingPaymentNo ?? knownPaymentNo;
  if (typeof paymentNo === "string" && paymentNo !== "") {
    if (typeof pendingPaymentNo === "string" && pendingPaymentNo !== "")
      await dependencies.releaseCreateOrderGate(
        guestInput,
        paymentNo,
        boundedCleanupRequest(deadline),
      );
    let transaction: JsonRecord | null = null;
    do {
      transaction = recordValue(
        await dependencies.readCurrentTransaction(
          handoff,
          boundedCleanupRequest(deadline),
        ),
      );
      if (transaction?.paymentNo === paymentNo) break;
      await waitForOrdinarySaleCleanupPoll(deadline);
    } while (true);
    if (transactionIsActive(transaction)) {
      await dependencies.cancelTransaction(
        handoff,
        transaction,
        boundedCleanupRequest(deadline),
      );
      do {
        transaction = recordValue(
          await dependencies.readCurrentTransaction(
            handoff,
            boundedCleanupRequest(deadline),
          ),
        );
        if (
          transaction?.paymentNo === paymentNo &&
          !transactionIsActive(transaction)
        )
          break;
        await waitForOrdinarySaleCleanupPoll(deadline);
      } while (true);
    }
  }
  const opened = recordValue(
    await dependencies.openCreateOrderGate(
      guestInput,
      boundedCleanupRequest(deadline),
    ),
  );
  const finalStatus = recordValue(
    await dependencies.readCreateOrderGate(
      guestInput,
      boundedCleanupRequest(deadline),
    ),
  );
  if (
    opened?.state !== "open" ||
    finalStatus?.state !== "open" ||
    finalStatus?.pending !== null
  )
    throw new Error(
      "payment create gate did not return to open with no pending payment",
    );
  return finalStatus;
}

/**
 * Completes one ordinary installed-owner sale without taking ownership of the
 * connected CDP client, the existing Vision owner, or the active serial
 * session. The optional dependency override is a test-owned boundary only.
 */
export async function runInstalledOwnerOrdinarySaleCompletion(
  input: JsonRecord,
): Promise<JsonRecord> {
  const client = input?.client;
  const guestInput = recordValue(input?.guestInput);
  const handoff = recordValue(input?.handoff);
  const serialSession = recordValue(input?.serialSession);
  if (
    !client ||
    !input?.guestInput ||
    !input?.handoff ||
    !serialSession?.sessionId
  )
    throw new Error(
      "ordinary installed-owner sale requires connected client, guest input, handoff, and active serial session",
    );
  if (input.testDependencies && process.env.NODE_ENV !== "test")
    throw new Error(
      "ordinary installed-owner sale test dependencies require NODE_ENV=test",
    );
  if (
    input.testCleanupTimeoutMs !== undefined &&
    (process.env.NODE_ENV !== "test" ||
      typeof input.testCleanupTimeoutMs !== "number" ||
      !Number.isFinite(input.testCleanupTimeoutMs) ||
      input.testCleanupTimeoutMs <= 0)
  )
    throw new Error(
      "ordinary sale cleanup timeout override requires NODE_ENV=test and a positive timeout",
    );
  const dependencies = {
    ...installedOwnerOrdinarySaleDependencies,
    ...recordValue(input.testDependencies),
  };
  const runId = required(guestInput.runId, "runId");
  const machineCode = required(guestInput.machineCode, "machineCode");
  const steps = buildFastRouteStressScenarioSteps(
    typeof input.productSelector === "string"
      ? input.productSelector
      : undefined,
    typeof input.categorySelector === "string"
      ? input.categorySelector
      : undefined,
  );
  let gateOpened = false;
  let pendingCreate: JsonRecord | null = null;
  let observer: CdpLocationHashObserver | null = null;
  let primaryError: Error | null = null;
  try {
    const cdpClient = client as Parameters<typeof waitForRoute>[0];
    await dependencies.waitForRoute(cdpClient, "#/catalog", {
      timeoutMs: 30_000,
      pollMs: 250,
    });
    const saleStartCapability = await dependencies.waitForSaleStartReady(
      handoff,
      client,
    );
    const uiViewport = await dependencies.readInstalledUiViewport(cdpClient);
    const baselineSaleView = await dependencies.readDaemonSaleView(handoff);
    const baselinePlatform = recordValue(
      await dependencies.readPlatform(guestInput, {
        runId,
        machineCode,
        sessionId: serialSession.sessionId,
      }),
    );
    const createOrderGate = recordValue(
      await dependencies.armCreateOrderGate(guestInput),
    );
    gateOpened = true;
    observer =
      await dependencies.startContinuousCdpLocationHashObservation(cdpClient);
    const noCatalogTraceBoundary = recordValue(
      await dependencies.captureRuntimeTraceBoundary(
        cdpClient,
        "ordinary sale Catalog trace boundary",
      ),
    );
    for (const step of steps.slice(0, 4)) {
      const stepRecord = recordValue(step);
      await dependencies.waitForRoute(cdpClient, String(stepRecord.routeBefore), {
        timeoutMs: 30_000,
        pollMs: 250,
      });
      const activation = recordValue(
        await dependencies.activateVisibleSelector(
          cdpClient,
          String(stepRecord.selector),
          { kind: "touch", timeoutMs: 30_000 },
        ),
      );
      assert.match(
        String(recordValue(activation.input).method),
        /Input\.dispatchTouchEvent/,
      );
      await dependencies.waitForRoute(cdpClient, String(stepRecord.routeAfter), {
        timeoutMs: 30_000,
        pollMs: 250,
      });
    }
    observer.assertArmed();
    const submit = recordValue(
      await dependencies.activateVisibleSelector(
        cdpClient,
        String(recordValue(steps[4]).selector),
        { kind: "touch", timeoutMs: 30_000 },
      ),
    );
    assert.match(
      String(recordValue(submit.input).method),
      /Input\.dispatchTouchEvent/,
    );
    pendingCreate = await dependencies.waitForCreateOrderGatePending(
      guestInput,
      30_000,
    );
    const pendingConfirmedAt =
      pendingCreate.observedAt ?? new Date().toISOString();
    const releasedCreateOrderGate = recordValue(
      await dependencies.releaseCreateOrderGate(
        guestInput,
        pendingCreate.paymentNo,
      ),
    );
    await dependencies.waitForRoute(cdpClient, /^#\/payment/, {
      timeoutMs: 30_000,
      pollMs: 250,
    });
    const renderedSale = await dependencies.readRenderedPaymentSurface(
      cdpClient,
    );
    const pendingTransaction = recordValue(
      await dependencies.readCurrentTransaction(handoff),
    );
    if (pendingTransaction?.paymentNo !== pendingCreate.paymentNo)
      throw new Error(
        "released create-order gate paymentNo must match the current transaction",
      );
    await dependencies.completeMockPayment(guestInput, pendingCreate.paymentNo);
    const liveSale = recordValue(
      await dependencies.waitForCommand(handoff, renderedSale),
    );
    const vendBoundary = recordValue(
      await dependencies.serialRequest(
        guestInput,
        serialSession.sessionId,
        "wait-frame",
        { parsedOpcode: "VEND", timeoutMs: 30_000 },
      ),
    );
    const beforeF0Platform = recordValue(
      await dependencies.waitForBeforeF0Boundary(
        guestInput,
        { runId, machineCode, sessionId: serialSession.sessionId },
        recordValue(baselinePlatform.raw),
        renderedSale,
        liveSale,
        pendingCreate.paymentNo,
      ),
    );
    const beforeF0SaleView = recordValue(
      await dependencies.readDaemonSaleView(handoff),
    );
    const beforeF0Ui = await dependencies.readUiBoundary(cdpClient);
    const releaseF0 = recordValue(
      await dependencies.serialRequest(
        guestInput,
        serialSession.sessionId,
        "release-f0",
      ),
    );
    const f0Boundary = recordValue(
      await dependencies.serialRequest(
        guestInput,
        serialSession.sessionId,
        "wait-frame",
        { parsedOpcode: "F0", timeoutMs: 30_000 },
      ),
    );
    const f1Boundary = recordValue(
      await dependencies.serialRequest(
        guestInput,
        serialSession.sessionId,
        "wait-frame",
        { parsedOpcode: "F1", timeoutMs: 30_000 },
      ),
    );
    const afterF1SaleView = recordValue(
      await dependencies.readDaemonSaleView(handoff),
    );
    const afterF1Platform = recordValue(
      await dependencies.readPlatform(guestInput, {
        runId,
        machineCode,
        sessionId: serialSession.sessionId,
      }),
    );
    const afterF1Ui = await dependencies.readUiBoundary(cdpClient);
    if (recordValue(afterF1Ui.result).kind === "success")
      throw new Error("UI must not show success before inbound F2");
    const releaseF2 = recordValue(
      await dependencies.serialRequest(
        guestInput,
        serialSession.sessionId,
        "release-f2",
      ),
    );
    const f2Boundary = recordValue(
      await dependencies.serialRequest(
        guestInput,
        serialSession.sessionId,
        "wait-frame",
        { parsedOpcode: "F2", timeoutMs: 30_000 },
      ),
    );
    const resultSurface = recordValue(
      await dependencies.waitForSuccessfulResultSurface(
        cdpClient,
        {
          orderId: renderedSale.orderId,
          paymentId: renderedSale.paymentId,
          orderNo: renderedSale.orderNo,
          commandId: liveSale.vendingCommandId,
        },
        60_000,
      ),
    );
    const continuousCdpLocationHash = recordValue(
      await observer.finish(String(resultSurface.route)),
    );
    observer = null;
    const collect = recordValue(
      await dependencies.serialRequest(
        guestInput,
        serialSession.sessionId,
        "evidence",
      ),
    );
    const afterF2Platform = recordValue(
      await dependencies.waitForPlatformMovement(
        guestInput,
        { runId, machineCode, sessionId: serialSession.sessionId },
        rows(afterF1Platform.raw, "movements").length,
        {
          orderId: renderedSale.orderId,
          paymentId: renderedSale.paymentId,
          paymentNo: pendingCreate.paymentNo,
          commandId: liveSale.vendingCommandId,
        },
      ),
    );
    const orderItem = rows(afterF2Platform.raw, "orderItems")
      .map((row: unknown) => recordValue(row))
      .find((row) => row.orderId === renderedSale.orderId);
    if (!orderItem) {
      throw new Error("after-F2 platform order item is missing");
    }
    const identity = {
      inventoryId: required(orderItem?.inventoryId, "order item inventoryId"),
      slotId: required(orderItem?.slotId, "order item slotId"),
    };
    const middleItem = matchingItem(afterF1SaleView, identity);
    if (!middleItem) {
      throw new Error("after-F1 daemon sale view item is missing");
    }
    const afterF2SaleView = recordValue(
      await dependencies.waitForDaemonSaleViewAfterF2(
        handoff,
        identity,
        middleItem,
        Number(orderItem.quantity),
      ),
    );
    const runtimeTrace = await dependencies.readRuntimeTraceSnapshot(cdpClient);
    const evidence = {
      scenario: "sale-only",
      saleCorrelationId:
        serialSession.saleCorrelationId ?? `installed-owner:${runId}`,
      controlPlaneSessionId: serialSession.sessionId,
      machineCode,
      renderedSale,
      liveSale,
      createOrderGate: {
        controlPlane: createOrderGate.controlPlane,
        armedAt: createOrderGate.armedAt,
        paymentNo: pendingCreate.paymentNo,
        pendingObservedAt: pendingConfirmedAt,
        releasedAt: releasedCreateOrderGate.releasedAt,
      },
      saleStartCapability,
      uiViewport,
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
        afterF2: resultSurface,
      },
      visionDelivery: {
        scenario: "sale-only",
        skippedReason: "installed_vision_owner_retained",
        arrival: null,
        traceBoundary: null,
        requestedAt: null,
        completedAt: null,
      },
      repeatedPaymentTouch: {
        scenario: "sale-only",
        traceEntryId: null,
        preDispatchTraceBoundary: null,
        pendingConfirmedAt,
        releaseRequestedAt: releasedCreateOrderGate.releasedAt,
      },
      noCatalogTraceBoundary,
      continuousCdpLocationHash,
      machineRuntimeTrace: {
        source: "installed_machine_runtime_trace_cdp",
        capturedAt: new Date().toISOString(),
        runtimeGenerationId: runtimeTrace.runtimeGenerationId,
        entries: runtimeTrace.entries,
      },
      mqttMessages: arrayValue(recordValue(collect.mqtt).messages),
      serial: {
        sessionId:
          recordValue(serialSession.binding).serialSessionId ??
          serialSession.sessionId,
        rawFrames: arrayValue(collect.rawFrames),
      },
    };
    const summary = validateFastRouteStressSaleEvidence(evidence);
    const opened = recordValue(
      await dependencies.openCreateOrderGate(guestInput),
    );
    const openStatus = recordValue(
      await dependencies.readCreateOrderGate(guestInput),
    );
    if (
      opened?.state !== "open" ||
      openStatus?.state !== "open" ||
      openStatus?.pending !== null
    )
      throw new Error(
        "payment create gate did not return to open with no pending payment",
      );
    gateOpened = false;
    return {
      schemaVersion: "vem-installed-owner-ordinary-sale/v1",
      ok: true,
      evidence,
      summary,
      boundaries: {
        vend: recordValue(vendBoundary.frame),
        releaseF0,
        f0: recordValue(f0Boundary.frame),
        f1: recordValue(f1Boundary.frame),
        releaseF2,
        f2: recordValue(f2Boundary.frame),
      },
    };
  } catch (error) {
    primaryError = error instanceof Error ? error : new Error(String(error));
    const cleanupErrors: Error[] = [];
    if (gateOpened || pendingCreate) {
      await collectCleanupStep(
        [],
        cleanupErrors,
        "restore payment create gate and transaction",
        () =>
          cleanupOrdinarySalePayment({
            dependencies,
            guestInput,
            handoff,
            knownPaymentNo: pendingCreate?.paymentNo,
            deadline:
              performance.now() +
              Number(
                input.testCleanupTimeoutMs ??
                  PENDING_TRANSACTION_CLEANUP_TIMEOUT_MS,
              ),
          }),
        Number(
          input.testCleanupTimeoutMs ??
            PENDING_TRANSACTION_CLEANUP_TIMEOUT_MS,
        ) +
          1_000,
      );
    }
    throw combineCleanupError(primaryError, cleanupErrors);
  } finally {
    observer?.stop();
  }
}

async function runFastRouteStressSale(
  options: JsonRecord,
): Promise<JsonRecord> {
  const routeStressScenario = options.scenario !== "sale-only";
  let guestInput: JsonRecord | null = null;
  let handoff: JsonRecord | null = null;
  let vision: JsonRecord | null = null;
  let client: CdpClient | null = null;
  let clientReady = false;
  let sessionStart: JsonRecord | null = null;
  let serialAdmission: FreshSerialAdmission | null = null;
  let liveSale: JsonRecord | null = null;
  let saleStartCapability: unknown = null;
  let uiViewport: JsonRecord | null = null;
  let baselineSaleView: JsonRecord | null = null;
  let baselinePlatform: JsonRecord | null = null;
  let beforeF0SaleView: JsonRecord | null = null;
  let beforeF0Platform: JsonRecord | null = null;
  let afterF1SaleView: JsonRecord | null = null;
  let afterF1Platform: JsonRecord | null = null;
  let afterF2SaleView: JsonRecord | null = null;
  let afterF2Platform: JsonRecord | null = null;
  let failureCurrentTransaction: JsonRecord | null = null;
  let stage = "read-input";
  const checkpoints: JsonRecord[] = [];
  const sink = screenshotSink(String(options.outPath));
  let createOrderGate: JsonRecord | null = null;
  let pendingCreate: JsonRecord | null = null;
  let noCatalogTraceBoundary: JsonRecord | null = null;
  let visionArrival: JsonRecord | null = null;
  let repeatedPaymentTouch: JsonRecord | null = null;
  let continuousCdpLocationHashObserver: CdpLocationHashObserver | null = null;
  let continuousCdpLocationHash: JsonRecord | null = null;
  let successReport: JsonRecord | null = null;
  let failureReport: JsonRecord | null = null;
  let primaryError: Error | null = null;
  try {
    guestInput = readJson(String(options.guestInputPath), "guest input");
    handoff = readJson(String(options.handoffPath), "handoff");
    const runId = required(guestInput.runId, "runId");
    const machineCode = required(guestInput.machineCode, "machineCode");
    let saleCorrelationId = null;
    const steps = buildFastRouteStressScenarioSteps(
      typeof options.fixtureKey === "string"
        ? catalogProductSelectorForFixture(
            guestInput.fixtureAllocation,
            options.fixtureKey,
          )
        : undefined,
    );
    stage = "stop-installed-vision-owner";
    await stopInstalledVisionOwnerForControlledMock();
    stage = "start-controlled-vision";
    vision = await ensureControlledVisionMock(
      visionMockControlPort(guestInput),
    );
    await waitForControlledVisionRuntimeClient(
      visionMockControlPort(guestInput),
    );
    stage = "replace-host-serial-session-before-sale";
    serialAdmission = await admitFreshSerialSessionForSale({
      guestInput,
      handoff,
      handoffPath: String(options.handoffPath),
      control: controlPlaneRequest,
      daemonGet: (path: string) => daemonGet(handoff as JsonRecord, path),
      armCreateOrderGate,
      writeJsonFile: writeJsonLocal,
    });
    if (!serialAdmission) {
      throw new Error("fresh serial admission is unavailable");
    }
    sessionStart = serialAdmission.serialSession;
    required(sessionStart.sessionId, "serial session id");
    saleCorrelationId =
      sessionStart.saleCorrelationId ??
      `sale-correlation://fast-route-${Date.now()}`;
    stage = "connect-installed-tauri-cdp";
    const target = await discoverMachineUiTarget({
      endpoint: "http://127.0.0.1:9222",
      expectedTargetId: String(recordValue(handoff.cdp).targetId),
    });
    client = new CdpClient(
      rewriteWebSocketDebuggerUrl(
        String(target.webSocketDebuggerUrl),
        "http://127.0.0.1:9222",
      ),
    );
    await client.connect();
    await enablePageRuntime(client);
    clientReady = true;
    const cdpClient = client;
    await waitForRoute(cdpClient, "#/catalog", {
      timeoutMs: 30_000,
      pollMs: 250,
    });
    saleStartCapability = await waitForSaleStartReady(handoff, cdpClient);
    await waitForRoute(cdpClient, "#/catalog", {
      timeoutMs: 30_000,
      pollMs: 250,
    });
    stage = "arm-create-order-gate";
    createOrderGate = recordValue(
      await serialAdmission.armCreateOrderGate(),
    );
    stage = "snapshot-baseline";
    uiViewport = recordValue(await readInstalledUiViewport(cdpClient));
    baselineSaleView = recordValue(await daemonGet(handoff, "/v1/sale-view"));
    baselinePlatform = recordValue(
      recordValue(
        await controlPlaneRequest(guestInput, "/v1/platform/query", {
          runId,
          machineCode,
        }),
      ).report,
    );
    checkpoints.push(
      recordValue(await captureCheckpoint(cdpClient, "catalog", {
        screenshot: true,
        screenshotSink: sink,
      })),
    );
    stage = "establish-stable-vision-presence";
    visionArrival = recordValue(
      await establishVisionPresenceForSale(guestInput, cdpClient),
    );
    continuousCdpLocationHashObserver =
      await startContinuousCdpLocationHashObservation(cdpClient);
    stage = "physical-catalog-to-checkout";
    for (const step of steps.slice(0, 4)) {
      const stepRecord = recordValue(step);
      await waitForRoute(cdpClient, String(stepRecord.routeBefore), {
        timeoutMs: 30_000,
        pollMs: 250,
      });
      // activateVisibleSelector hard-fails unless the UI action is dispatched via
      // the real Chrome DevTools Input.dispatchTouchEvent path.
      const activation = recordValue(
        await serialAdmission.runCustomerAction(() =>
          activateVisibleSelector(cdpClient, String(stepRecord.selector), {
            kind: String(stepRecord.inputKind) === "mouse" ? "mouse" : "touch",
            timeoutMs: 30_000,
          }),
        ),
      );
      assert.match(
        String(recordValue(activation.input).method),
        /Input\.dispatchTouchEvent/,
      );
      await waitForRoute(cdpClient, String(stepRecord.routeAfter), {
        timeoutMs: 30_000,
        pollMs: 250,
      });
      if (stepRecord.name === "catalog product") {
        continuousCdpLocationHashObserver.assertArmed();
        noCatalogTraceBoundary = await captureRuntimeTraceBoundary(
          cdpClient,
          "no-Catalog trace boundary",
        );
      }
    }
    await waitForRoute(cdpClient, "#/checkout", {
      timeoutMs: 30_000,
      pollMs: 250,
    });
    stage = "wait-create-order-pending-boundary";
    let firstSubmit: JsonRecord | null = null;
    for (let attempt = 0; attempt < 3 && !pendingCreate; attempt += 1) {
      firstSubmit = recordValue(
        await serialAdmission.runCustomerAction(() =>
          activateVisibleSelector(cdpClient, String(recordValue(steps[4]).selector), {
            kind: "touch",
            timeoutMs: 30_000,
          }),
        ),
      );
      assert.match(
        String(recordValue(firstSubmit.input).method),
        /Input\.dispatchTouchEvent/,
      );
      pendingCreate = await waitForCreateOrderGatePending(
        guestInput,
        attempt === 2 ? 30_000 : 2_000,
      ).catch(() => null);
    }
    if (!pendingCreate)
      throw new Error(
        "mock create-order gate did not observe a pending payment creation",
      );
    const pendingConfirmedAt = new Date().toISOString();
    let releaseRequestedAt = new Date().toISOString();
    let visionDelivery: JsonRecord = {
      scenario: "sale-only",
      skippedReason: "route_stress_not_requested",
      arrival: visionArrival,
      traceBoundary: null,
      requestedAt: null,
      completedAt: null,
    };
    repeatedPaymentTouch = {
      scenario: "sale-only",
      preDispatchTraceBoundary: null,
      traceEntryId: null,
      pendingConfirmedAt,
      releaseRequestedAt,
    };
    if (routeStressScenario) {
      stage = "vision-departure-during-create-order";
      const visionDepartureTraceBoundary = recordValue(
        await captureRuntimeTraceBoundary(
          cdpClient,
          "Vision departure control-request trace boundary",
        ),
      );
      const visionRequestedAt = new Date().toISOString();
      let visionDeliveryResult: unknown;
      try {
        visionDeliveryResult = await dispatchVisionDeparture(guestInput);
      } catch {
        await shutdownControlledVisionMock(
          (vision?.child as ReturnType<typeof spawn> | null) ?? null,
        ).catch(
          () => undefined,
        );
        vision = await ensureControlledVisionMock(
          visionMockControlPort(guestInput),
        );
        await waitForControlledVisionRuntimeClient(
          visionMockControlPort(guestInput),
        );
        visionDeliveryResult = await dispatchVisionDeparture(guestInput);
      }
      visionDelivery = {
        ...recordValue(visionDeliveryResult),
        scenario: "route-stress",
        arrival: visionArrival,
        traceBoundary: visionDepartureTraceBoundary,
        requestedAt: visionRequestedAt,
        completedAt: new Date().toISOString(),
      };
      await waitForGuardedVisionDepartureTrace(
        client,
        visionDepartureTraceBoundary,
      );
      const preDispatchTraceBoundary = recordValue(
        await captureRuntimeTraceBoundary(
          client,
          "repeated payment touch pre-dispatch trace boundary",
        ),
      );
      const secondSubmit = recordValue(
        await serialAdmission.runCustomerAction(() =>
          dispatchRepeatedPaymentTouch(cdpClient, firstSubmit),
        ),
      );
      assert.match(
        String(recordValue(secondSubmit.input).method),
        /Input\.dispatchTouchEvent/,
      );
      const repeatedTouchTrace = await waitForRepeatedCustomerTouchTrace(
        cdpClient,
        preDispatchTraceBoundary,
      );
      releaseRequestedAt = new Date().toISOString();
      repeatedPaymentTouch = {
        scenario: "route-stress",
        preDispatchTraceBoundary,
        traceEntryId: repeatedTouchTrace.id,
        pendingConfirmedAt,
        releaseRequestedAt,
      };
    }
    if (!routeStressScenario) {
      releaseRequestedAt = new Date().toISOString();
      repeatedPaymentTouch.releaseRequestedAt = releaseRequestedAt;
    }
    const releasedCreateOrderGate = recordValue(
      await releaseCreateOrderGate(guestInput, pendingCreate.paymentNo),
    );
    await waitForRoute(cdpClient, /^#\/payment/, {
      timeoutMs: 30_000,
      pollMs: 250,
    });
    checkpoints.push(
      recordValue(await captureCheckpoint(cdpClient, "payment-creation", {
        screenshot: true,
        screenshotSink: sink,
      })),
    );
    stage = "read-rendered-payment-surface";
    const renderedSale = await readRenderedPaymentSurface(cdpClient);
    stage = "read-pending-transaction";
    const pendingTransaction = recordValue(
      await daemonGet(handoff, "/v1/transactions/current"),
    );
    if (pendingTransaction?.paymentNo !== pendingCreate.paymentNo) {
      throw new Error(
        "released create-order gate paymentNo must match the rendered payment surface",
      );
    }
    stage = "complete-mock-payment";
    await completeMockPayment(guestInput, pendingCreate.paymentNo);
    liveSale = recordValue(await waitForCommand(handoff, renderedSale));
    stage = "snapshot-before-f0";
    const vendBoundary = recordValue(
      await serialAdmission.serialRequest("wait-frame", {
        parsedOpcode: "VEND",
        timeoutMs: 30_000,
      }),
    );
    beforeF0Platform = recordValue(
      await waitForBeforeF0Boundary(
        guestInput,
        {
          runId,
          machineCode,
          sessionId: sessionStart.sessionId,
        },
        recordValue(baselinePlatform.raw),
        renderedSale,
        liveSale,
        pendingCreate.paymentNo,
      ),
    );
    beforeF0SaleView = recordValue(await daemonGet(handoff, "/v1/sale-view"));
    const beforeF0Ui = await readUiBoundary(cdpClient);
    checkpoints.push(
      recordValue(await captureCheckpoint(cdpClient, "before-f0-active", {
        screenshot: true,
        screenshotSink: sink,
      })),
    );
    const releaseF0 = recordValue(
      await serialAdmission.serialRequest("release-f0"),
    );
    stage = "wait-inbound-f0";
    const f0Boundary = recordValue(
      await serialAdmission.serialRequest("wait-frame", {
        parsedOpcode: "F0",
        timeoutMs: 30_000,
      }),
    );
    stage = "wait-inbound-f1";
    const f1Boundary = recordValue(
      await serialAdmission.serialRequest("wait-frame", {
        parsedOpcode: "F1",
        timeoutMs: 30_000,
      }),
    );
    stage = "snapshot-after-f1-before-f2";
    afterF1SaleView = recordValue(await daemonGet(handoff, "/v1/sale-view"));
    afterF1Platform = recordValue(
      recordValue(
        await controlPlaneRequest(guestInput, "/v1/platform/query", {
          runId,
          machineCode,
          sessionId: sessionStart.sessionId,
        }),
      ).report,
    );
    const afterF1Ui = await readUiBoundary(cdpClient);
    if (recordValue(afterF1Ui.result).kind === "success") {
      throw new Error("UI must not show success before inbound F2");
    }
    checkpoints.push(
      recordValue(await captureCheckpoint(cdpClient, "after-f1-before-f2", {
        screenshot: true,
        screenshotSink: sink,
      })),
    );
    stage = "release-and-wait-inbound-f2";
    const releaseF2 = recordValue(
      await serialAdmission.serialRequest("release-f2"),
    );
    const f2Boundary = recordValue(
      await serialAdmission.serialRequest("wait-frame", {
        parsedOpcode: "F2",
        timeoutMs: 30_000,
      }),
    );
    stage = "wait-success-result";
    const resultSurface = recordValue(
      await waitForSuccessfulResultSurface(
        cdpClient,
        {
          orderId: renderedSale.orderId,
          paymentId: renderedSale.paymentId,
          orderNo: renderedSale.orderNo,
          commandId: liveSale.vendingCommandId,
        },
        60_000,
      ),
    );
    continuousCdpLocationHash = recordValue(
      await continuousCdpLocationHashObserver.finish(
        String(resultSurface.route),
      ),
    );
    checkpoints.push(
      recordValue(await captureCheckpoint(cdpClient, "result", {
        screenshot: true,
        screenshotSink: sink,
      })),
    );
    stage = "collect-raw-serial-evidence";
    const collect = recordValue(
      await serialAdmission.serialRequest("evidence"),
    );
    afterF2Platform = recordValue(
      await waitForPlatformMovement(
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
      ),
    );
    const terminalRaw = recordValue(afterF2Platform.raw);
    const terminalOrderItem = rows(terminalRaw, "orderItems")
      .map((row: unknown) => recordValue(row))
      .find((row) => row.orderId === renderedSale.orderId);
    if (!terminalOrderItem) {
      throw new Error("terminal order item is missing");
    }
    const terminalIdentity = {
      inventoryId: required(
        terminalOrderItem?.inventoryId,
        "terminal order item inventoryId",
      ),
      slotId: required(
        terminalOrderItem?.slotId,
        "terminal order item slotId",
      ),
    };
    const terminalQuantity = Number(terminalOrderItem?.quantity);
    if (!Number.isInteger(terminalQuantity) || terminalQuantity < 1) {
      throw new Error(
        `terminal order item quantity is invalid: ${JSON.stringify(terminalOrderItem)}`,
      );
    }
    const terminalMiddleItem = matchingItem(
      afterF1SaleView as JsonRecord,
      terminalIdentity,
    );
    if (!terminalMiddleItem) {
      throw new Error(
        `daemon sale-view is missing the terminal order item before F2: ${JSON.stringify(terminalIdentity)}`,
      );
    }
    afterF2SaleView = recordValue(
      await waitForDaemonSaleViewAfterF2(
        handoff,
        terminalIdentity,
        terminalMiddleItem,
        terminalQuantity,
      ),
    );
    const afterF2Ui = resultSurface;
    const runtimeTrace = await readRuntimeTraceSnapshot(cdpClient);
    const platformLog = recordValue(
      await collectPlatformLog(
        guestInput,
        sessionStart.sessionId,
        String(options.outPath),
      ),
    );
    const evidence = {
      scenario: options.scenario,
      saleCorrelationId,
      controlPlaneSessionId: sessionStart.sessionId,
      machineCode,
      machineRuntimeTrace: {
        source: "installed_machine_runtime_trace_cdp",
        capturedAt: new Date().toISOString(),
        runtimeGenerationId: runtimeTrace.runtimeGenerationId,
        entries: runtimeTrace.entries,
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
      mqttMessages: arrayValue(recordValue(collect.mqtt).messages),
      serial: {
        sessionId:
          recordValue(sessionStart.binding).serialSessionId ??
          sessionStart.sessionId,
        rawFrames: arrayValue(collect.rawFrames),
      },
    };
    const summary = validateFastRouteStressSaleEvidence(evidence);
    stage = "stop-host-serial-session";
    await serialAdmission.serialRequest("stop", {
      orderId: liveSale.orderId,
      paymentId: liveSale.paymentId,
      vendingCommandId: liveSale.vendingCommandId,
    });
    await serialAdmission.serialRequest("stop", {
      orderId: liveSale.orderId,
      paymentId: liveSale.paymentId,
      vendingCommandId: liveSale.vendingCommandId,
      idempotencyCheck: true,
    });
    successReport = buildFastRouteStressSaleSuccessReport({
      mode: options.mode,
      runId,
      machineCode,
      resultRoute: resultSurface.route,
      sessionStart,
      serialStart: serialAdmission,
      renderedSale,
      liveSale,
      summary,
      boundaries: {
        vend: recordValue(vendBoundary.frame),
        releaseF0,
        f0: recordValue(f0Boundary.frame),
        f1: recordValue(f1Boundary.frame),
        releaseF2,
        f2: recordValue(f2Boundary.frame),
      },
      evidence: compactEvidenceForReport(evidence, summary),
      runtimeTrace: compactRuntimeTrace(runtimeTrace.entries),
      checkpoints,
      logs: {
        daemonProcess: processLiveness(
          recordValue(handoff.daemon).processId,
        ),
        daemonStdout: writeBoundedLogTail(
          String(
            recordValue(recordValue(handoff.daemon).logs).stdout ?? "",
          ),
          String(options.outPath),
          "daemon-stdout",
        ),
        daemonStderr: writeBoundedLogTail(
          String(
            recordValue(recordValue(handoff.daemon).logs).stderr ?? "",
          ),
          String(options.outPath),
          "daemon-stderr",
        ),
        platform: platformLog.artifact,
        milestones: checkpoints.map((checkpoint) => ({
          label: checkpoint.label,
          route: recordValue(checkpoint.identity).route,
          screenshot:
            recordValue(checkpoint.screenshot).ref ?? null,
        })),
      },
    });
  } catch (error) {
    primaryError = error instanceof Error ? error : new Error(String(error));
    failureCurrentTransaction = handoff
      ? recordValue(
          await daemonGet(handoff, "/v1/transactions/current").catch(
            (transactionError) => ({
            evidenceError:
              transactionError instanceof Error
                ? transactionError.message
                : String(transactionError),
            }),
          ),
        )
      : null;
    const failureCheckpoints: JsonRecord[] = [...checkpoints];
    if (clientReady) {
      const failure = recordValue(
        await captureCheckpoint(client as CdpClient, `failure-${stage}`, {
        screenshot: true,
        screenshotSink: sink,
        }).catch(() => null),
      );
      if (failure) failureCheckpoints.push(failure);
    }
    const runtimeTrace = clientReady
      ? recordValue(
          await readRuntimeTraceSnapshot(client as CdpClient).catch(() => ({
            runtimeGenerationId: null,
            entries: [],
          })),
        )
      : { runtimeGenerationId: null, entries: [] };
    continuousCdpLocationHash =
      continuousCdpLocationHash ??
      continuousCdpLocationHashObserver?.snapshot() ??
      null;
    const platformLog: JsonRecord | null =
      guestInput && sessionStart
        ? recordValue(
            await collectPlatformLog(
              guestInput,
              sessionStart.sessionId,
              String(options.outPath),
            ).catch((platformError) => ({
              error:
                platformError instanceof Error
                  ? platformError.message
                  : String(platformError),
            })),
          )
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
      handoffSerialSessionId: sessionStart?.sessionId ?? null,
      controlPlaneSessionId: sessionStart?.sessionId ?? null,
      liveSale,
      runtimeTrace: runtimeTrace.entries,
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
          String(
            recordValue(recordValue(handoff?.daemon).logs).stdout ?? "",
          ),
          String(options.outPath),
          "daemon-stdout",
        ),
        daemonStderr: writeBoundedLogTail(
          String(
            recordValue(recordValue(handoff?.daemon).logs).stderr ?? "",
          ),
          String(options.outPath),
          "daemon-stderr",
        ),
        platform: platformLog?.artifact ?? null,
        platformError: platformLog?.error ?? null,
        simulator:
          recordValue(recordValue(hostEvidence).references).simulatorLog ??
          null,
      },
    });
    failureReport = report;
  }

  const cleanup: JsonRecord[] = [];
  const cleanupErrors: Error[] = [];
  if (guestInput && createOrderGate) {
    const activeGuest = guestInput;
    const activeHandoff = handoff;
    const cleanupPaymentNo =
      pendingCreate?.paymentNo ?? failureCurrentTransaction?.paymentNo ?? null;
    if (pendingCreate?.paymentNo) {
      await collectCleanupStep(
        cleanup,
        cleanupErrors,
        "release pending create gate",
        () => releaseCreateOrderGate(activeGuest, pendingCreate.paymentNo),
        CLEANUP_REQUEST_TIMEOUT_MS + 1_000,
      );
    }
    if (cleanupPaymentNo) {
      const settleCleanupErrors = primaryError ? cleanupErrors : [];
      await collectCleanupStep(
        cleanup,
        settleCleanupErrors,
        "settle pending create transaction",
        () =>
          settlePendingCreateOrder({
            paymentNo: cleanupPaymentNo,
            readTransaction: () =>
              daemonGet(activeHandoff as JsonRecord, "/v1/transactions/current", {
                timeoutMs: CLEANUP_REQUEST_TIMEOUT_MS,
              }),
            cancelTransaction: (active: JsonRecord) =>
              daemonPost(
                activeHandoff as JsonRecord,
                "/v1/intents/cancel-order",
                { orderNo: required(active?.orderNo, "active orderNo") },
                { timeoutMs: CLEANUP_REQUEST_TIMEOUT_MS },
              ),
          }),
        PENDING_TRANSACTION_CLEANUP_TIMEOUT_MS + CLEANUP_REQUEST_TIMEOUT_MS,
      );
    }
    const opened = await collectCleanupStep(
      cleanup,
      cleanupErrors,
      "reopen payment create gate",
      () =>
        controlPlaneRequest(
          activeGuest,
          "/v1/mock-payment-create-gate/open",
          {},
          { timeoutMs: CLEANUP_REQUEST_TIMEOUT_MS },
        ),
      CLEANUP_REQUEST_TIMEOUT_MS + 1_000,
    );
    await collectCleanupStep(
      cleanup,
      cleanupErrors,
      "verify payment create gate",
      async () => {
        const status = await controlPlaneRequest(
          activeGuest,
          "/v1/mock-payment-create-gate/status",
          {},
          { timeoutMs: CLEANUP_REQUEST_TIMEOUT_MS },
        );
        const openedRecord = recordValue(opened);
        const statusRecord = recordValue(status);
        if (
          openedRecord?.state !== "open" ||
          statusRecord?.state !== "open" ||
          statusRecord?.pending !== null
        ) {
          throw new Error(
            "payment create gate did not return to open with no pending payment",
          );
        }
        return { opened: openedRecord, status: statusRecord };
      },
      CLEANUP_REQUEST_TIMEOUT_MS + 1_000,
    );
  }
  if (guestInput && sessionStart?.sessionId) {
    try {
      cleanup.push(
        await runCleanupStep("abort serial session", async () => {
          const result = await controlPlaneRequest(
            guestInput,
            `/v1/serial-sessions/${sessionStart.sessionId}/abort`,
          );
          if (recordValue(result).aborted !== true) {
            throw new Error(
              "serial session abort did not confirm inactive state",
            );
          }
          return result;
        }),
      );
    } catch (error) {
      cleanupErrors.push(error as Error);
      cleanup.push({
        label: (error as CleanupError).cleanupLabel ?? "abort serial session",
        ok: false,
        error: serializeError(error),
      });
    }
  }
  if (client) {
    const connectedClient = client;
    if (continuousCdpLocationHashObserver) {
      try {
        cleanup.push(
          await runCleanupStep(
            "stop continuous CDP location.hash observation",
            async () => continuousCdpLocationHashObserver.stop(),
          ),
        );
      } catch (error) {
        cleanupErrors.push(error as Error);
        cleanup.push({
          label:
            (error as CleanupError).cleanupLabel ??
            "stop continuous CDP location.hash observation",
          ok: false,
          error: serializeError(error),
        });
      }
    }
    try {
      cleanup.push(
        await runCleanupStep("close CDP client", async () => {
          await connectedClient.close();
          return { closed: true };
        }),
      );
    } catch (error) {
      cleanupErrors.push(error as Error);
      cleanup.push({
        label: (error as CleanupError).cleanupLabel ?? "close CDP client",
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
          await shutdownControlledVisionMock(
            (vision?.child as ReturnType<typeof spawn> | null) ?? null,
          );
          return { stopped: true, port: 7892 };
        },
        20_000,
      ),
    );
  } catch (error) {
    cleanupErrors.push(error as Error);
    cleanup.push({
      label:
        (error as CleanupError).cleanupLabel ?? "stop controlled vision mock",
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
        handoffSerialSessionId: sessionStart?.sessionId ?? null,
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
    writeReport(String(options.outPath), failureReport);
    throw finalError;
  }

  if (!successReport) {
    throw new Error("fast route stress sale success report is missing");
  }
  writeReport(String(options.outPath), successReport);
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
