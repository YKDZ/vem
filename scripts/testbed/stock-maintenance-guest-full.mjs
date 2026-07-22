#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import {
  activateVisibleSelector,
  captureScreenshot,
  CdpClient,
  discoverMachineUiTarget,
  enablePageRuntime,
  evaluateExpression,
  rewriteWebSocketDebuggerUrl,
  waitForRoute,
} from "./machine-ui-cdp-driver.mjs";
import { replaceSerialSessionAndUpdateHandoff } from "./serial-session-handoff.mjs";

const SCHEMA_VERSION = "vem-stock-maintenance-guest-full/v1";
const TIMEOUT_MS = 45_000;
const POLL_MS = 250;
const STOCK_TASK_SELECTOR = "[data-test='maintenance-task-stock']";
const STOCK_PANEL_SELECTOR = "[data-test='stock-maintenance']";
const MAINTENANCE_ENTRY_SELECTOR = "[data-test='maintenance-entry-header']";
const MAINTENANCE_RETURN_SELECTOR = "[data-test='maintenance-return-catalog']";

function required(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function option(args, name) {
  const index = args.indexOf(`--${name}`);
  return required(index === -1 ? undefined : args[index + 1], `--${name}`);
}

function localPath(value) {
  const path = required(value, "Windows path");
  return process.platform === "win32"
    ? path
    : resolve(
        `/mnt/${path[0].toLowerCase()}/${path.slice(3).replaceAll("\\", "/")}`,
      );
}

export function parseStockMaintenanceGuestArgs(args) {
  if (option(args, "mode") !== "full") throw new Error("--mode must be full");
  return {
    mode: "full",
    guestInputPath: option(args, "guest-input"),
    handoffPath: option(args, "handoff"),
    outPath: option(args, "out"),
    fixtureKey: args.includes("--fixture-key")
      ? option(args, "fixture-key")
      : "stockMaintenance",
  };
}

function readJson(path) {
  return JSON.parse(readFileSync(localPath(path), "utf8"));
}

function writeJson(path, value) {
  const target = localPath(path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function parseDaemonPayload(payload) {
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    Object.hasOwn(payload, "code") ||
    Object.hasOwn(payload, "data")
  ) {
    throw new Error("daemon response must be bare JSON");
  }
  return payload;
}

export function parseServiceApiEnvelope(payload) {
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    payload.code !== 0 ||
    !Object.hasOwn(payload, "data")
  ) {
    throw new Error("Service API response must be a success envelope");
  }
  return payload.data;
}

async function request(url, { parse, ...options } = {}) {
  const response = await fetch(url, {
    ...options,
    signal: options.signal ?? AbortSignal.timeout(TIMEOUT_MS),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      `${options.method ?? "GET"} ${url} returned HTTP ${response.status}: ${JSON.stringify(payload)}`,
    );
  }
  return parse(payload);
}

async function hostControlRequest(input, path, body = {}) {
  const controlPlane = input?.hostControlPlane;
  const endpoint = required(
    controlPlane?.endpoint,
    "hostControlPlane endpoint",
  );
  const token = required(controlPlane?.token, "hostControlPlane token");
  const response = await fetch(`${endpoint}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.ok !== true) {
    throw new Error(
      `host control ${path} returned HTTP ${response.status}: ${JSON.stringify(payload)}`,
    );
  }
  return payload;
}

function daemonBase(handoff) {
  const healthzUrl = required(
    handoff?.daemon?.ready?.healthzUrl,
    "daemon healthzUrl",
  );
  if (!healthzUrl.endsWith("/healthz")) {
    throw new Error("daemon healthzUrl must end with /healthz");
  }
  return healthzUrl.slice(0, -"/healthz".length);
}

function daemon(handoff, path, body) {
  return request(`${daemonBase(handoff)}${path}`, {
    parse: parseDaemonPayload,
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${required(handoff?.daemon?.ready?.ipcToken, "daemon ipcToken")}`,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function adminToken(input) {
  const base = required(
    input?.runtimeBootstrap?.provisioningApiBaseUrl,
    "runtimeBootstrap.provisioningApiBaseUrl",
  ).replace(/\/+$/, "");
  const login = await request(`${base}/auth/login`, {
    parse: parseServiceApiEnvelope,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: required(
        input?.serviceApi?.adminUsername,
        "serviceApi.adminUsername",
      ),
      password: required(
        input?.serviceApi?.adminPassword,
        "serviceApi.adminPassword",
      ),
    }),
  });
  return required(login?.accessToken, "admin access token");
}

async function inventoryMovements(input, token, inventoryId) {
  const base = required(
    input?.runtimeBootstrap?.provisioningApiBaseUrl,
    "runtimeBootstrap.provisioningApiBaseUrl",
  ).replace(/\/+$/, "");
  return await request(
    `${base}/inventory-movements?page=1&pageSize=100&inventoryId=${encodeURIComponent(inventoryId)}`,
    {
      parse: parseServiceApiEnvelope,
      headers: { authorization: `Bearer ${token}` },
    },
  );
}

function movementCursor(page, inventoryId) {
  const baselineItemIds = (page?.items ?? []).map((item) => item?.id);
  if (
    baselineItemIds.some((id) => typeof id !== "string" || id === "") ||
    new Set(baselineItemIds).size !== baselineItemIds.length
  ) {
    throw new Error(
      "Service API inventory movement cursor is not identity-complete",
    );
  }
  return { inventoryId, capturedAt: new Date().toISOString(), baselineItemIds };
}

function movementDelta(page, cursor) {
  return (page?.items ?? []).filter(
    (item) => !cursor.baselineItemIds.includes(item?.id),
  );
}

async function inventory(input, token, inventoryId) {
  const base = required(
    input?.runtimeBootstrap?.provisioningApiBaseUrl,
    "runtimeBootstrap.provisioningApiBaseUrl",
  ).replace(/\/+$/, "");
  const page = await request(`${base}/inventories?page=1&pageSize=100`, {
    parse: parseServiceApiEnvelope,
    headers: { authorization: `Bearer ${token}` },
  });
  const entry = (page?.items ?? []).find((item) => item?.id === inventoryId);
  if (!entry)
    throw new Error(
      `fixture inventory ${inventoryId} is absent from Admin API`,
    );
  return entry;
}

function fixtureIdentity(saleView, fixture) {
  const slotDisplayLabel = required(
    fixture?.slotDisplayLabel,
    "stock fixture slotDisplayLabel",
  );
  const sku = required(fixture?.sku, "stock fixture sku");
  const item = (saleView?.items ?? []).find(
    (entry) =>
      entry?.slotDisplayLabel === slotDisplayLabel && entry?.sku === sku,
  );
  if (!item?.slotId || !item?.inventoryId) {
    throw new Error(
      `fixture ${sku} at ${slotDisplayLabel} is absent from the daemon sale view`,
    );
  }
  return {
    slotDisplayLabel,
    sku,
    slotId: item.slotId,
    inventoryId: item.inventoryId,
  };
}

function stockFact(saleView, identity) {
  const item = (saleView?.items ?? []).find(
    (entry) =>
      entry?.slotDisplayLabel === identity.slotDisplayLabel &&
      entry?.slotId === identity.slotId &&
      entry?.inventoryId === identity.inventoryId &&
      entry?.sku === identity.sku,
  );
  if (!item)
    throw new Error("fixture identity no longer resolves in daemon sale view");
  return {
    physicalStock: item.physicalStock,
    saleableStock: item.saleableStock,
    slotSalesState: item.slotSalesState,
  };
}

async function waitFor(label, read, accepts) {
  const deadline = Date.now() + TIMEOUT_MS;
  let last = null;
  do {
    last = await read();
    if (accepts(last)) return last;
    await sleep(POLL_MS);
  } while (Date.now() < deadline);
  throw new Error(
    `${label} did not reach its correlated state: ${JSON.stringify(last)}`,
  );
}

function screenshotSink(outPath) {
  const root = join(dirname(localPath(outPath)), "stock-maintenance-artifacts");
  return async ({ bytes, label }) => {
    mkdirSync(root, { recursive: true });
    const file = join(root, `${label}.png`);
    writeFileSync(file, bytes);
    return { ref: file };
  };
}

async function connectUi(handoff) {
  const endpoint = required(handoff?.cdp?.endpoint, "handoff cdp endpoint");
  const target = await discoverMachineUiTarget({
    endpoint,
    expectedTargetId: required(handoff?.cdp?.targetId, "handoff cdp targetId"),
  });
  const client = new CdpClient(
    rewriteWebSocketDebuggerUrl(target.webSocketDebuggerUrl, endpoint),
  );
  await client.connect();
  await enablePageRuntime(client);
  return client;
}

async function openStockMaintenance(client) {
  await waitForRoute(client, "#/catalog", {
    timeoutMs: TIMEOUT_MS,
    pollMs: POLL_MS,
  });
  const visibleBeforeEntry = await evaluateExpression(
    client,
    `Boolean(document.querySelector(${JSON.stringify(STOCK_PANEL_SELECTOR)})?.getClientRects().length)`,
  );
  if (visibleBeforeEntry) {
    throw new Error(
      "stock maintenance must be unavailable on Catalog before entry",
    );
  }
  for (let count = 0; count < 7; count += 1) {
    await activateVisibleSelector(client, MAINTENANCE_ENTRY_SELECTOR, {
      kind: "touch",
      timeoutMs: TIMEOUT_MS,
      pollMs: POLL_MS,
    });
  }
  await waitForRoute(client, "#/maintenance?source=operator", {
    timeoutMs: TIMEOUT_MS,
    pollMs: POLL_MS,
    forbiddenRoutes: [],
  });
  await activateVisibleSelector(client, STOCK_TASK_SELECTOR, {
    kind: "touch",
    timeoutMs: TIMEOUT_MS,
    pollMs: POLL_MS,
  });
  await waitFor(
    "visible stock maintenance panel",
    () =>
      evaluateExpression(
        client,
        `Boolean(document.querySelector(${JSON.stringify(STOCK_PANEL_SELECTOR)})?.getClientRects().length)`,
      ),
    (visible) => visible === true,
  );
}

async function returnToCatalogFromMaintenance(client) {
  await activateVisibleSelector(client, MAINTENANCE_RETURN_SELECTOR, {
    kind: "touch",
    timeoutMs: TIMEOUT_MS,
    pollMs: POLL_MS,
  });
  await waitForRoute(client, "#/catalog", {
    timeoutMs: TIMEOUT_MS,
    pollMs: POLL_MS,
  });
}

async function captureStockScreenshot(client, sink, label, route, identity) {
  return {
    ...(await captureScreenshot(client, {
      label,
      screenshotSink: sink,
      validatePng: true,
    })),
    route,
    slotDisplayLabel: identity.slotDisplayLabel,
  };
}

async function enterRoutineRefill(client, identity) {
  const slotSelector = `[data-test='stock-maintenance-slot'][data-slot-id='${identity.slotDisplayLabel}'][data-sku='${identity.sku}']`;
  const additionSelector = `[data-test='stock-maintenance-addition'][data-slot-id='${identity.slotDisplayLabel}']`;
  await waitFor(
    "fixture stock maintenance row",
    () =>
      evaluateExpression(
        client,
        `Boolean(document.querySelector(${JSON.stringify(slotSelector)}))`,
      ),
    (available) => available === true,
  );
  await activateVisibleSelector(client, additionSelector, {
    kind: "touch",
    timeoutMs: TIMEOUT_MS,
    pollMs: POLL_MS,
  });
  await client.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "a",
    code: "KeyA",
    modifiers: 2,
  });
  await client.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "a",
    code: "KeyA",
    modifiers: 2,
  });
  await client.send("Input.insertText", { text: "2" });
  await waitFor(
    "visible +2 refill input",
    () =>
      evaluateExpression(
        client,
        `document.querySelector(${JSON.stringify(additionSelector)})?.value ?? null`,
      ),
    (value) => value === "2",
  );
  const previewSelector = `[data-test='stock-maintenance-preview'][data-slot-id='${identity.slotDisplayLabel}']`;
  await waitFor(
    "visible refill preview",
    () =>
      evaluateExpression(
        client,
        `document.querySelector(${JSON.stringify(previewSelector)})?.textContent ?? null`,
      ),
    (value) => typeof value === "string" && value.includes("2/"),
  );
  await activateVisibleSelector(
    client,
    "[data-test='stock-maintenance-submit']:not(:disabled)",
    {
      kind: "touch",
      timeoutMs: TIMEOUT_MS,
      pollMs: POLL_MS,
    },
  );
}

function runSale(options, outPath) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [
        "scripts/testbed/fast-route-stress-sale.mjs",
        "--mode",
        "full",
        "--guest-input",
        options.guestInputPath,
        "--handoff",
        options.handoffPath,
        "--out",
        outPath,
        "--fixture-key",
        options.fixtureKey,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-8_192);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) return resolvePromise(readJson(outPath));
      reject(
        new Error(`installed stock sale failed with exit ${code}: ${stderr}`),
      );
    });
  });
}

async function replaceSaleHandoff(input, handoff, options) {
  const previousControlPlaneSessionId = required(
    handoff?.commissioningSerialSession?.sessionId,
    "handoff commissioning serial session id",
  );
  const replacement = await replaceSerialSessionAndUpdateHandoff({
    guestInput: input,
    handoff,
    handoffPath: options.handoffPath,
    sessionId: previousControlPlaneSessionId,
    control: hostControlRequest,
  });
  return {
    previousControlPlaneSessionId,
    replacementControlPlaneSessionId: required(
      replacement?.replacement?.sessionId,
      "replacement serial session id",
    ),
  };
}

function saleEvidence(sale, runId, handoff) {
  const summary = sale?.summary ?? {};
  const cleanup = Array.isArray(sale?.cleanup) ? sale.cleanup : [];
  const paymentGateOpen = cleanup.some(
    (step) => step?.label === "reopen payment create gate" && step?.ok === true,
  );
  const serialSessionInactive = cleanup.some(
    (step) => step?.label === "abort serial session" && step?.ok === true,
  );
  const controlPlaneSessionId = required(
    sale?.controlPlaneSessionId,
    "sale control-plane session id",
  );
  if (
    sale?.schemaVersion !== "vem-fast-route-stress-sale/v2" ||
    sale?.ok !== true ||
    sale?.runId !== runId ||
    controlPlaneSessionId !== handoff.replacementControlPlaneSessionId ||
    !paymentGateOpen ||
    !serialSessionInactive
  ) {
    throw new Error(
      "installed sale report is missing independent session cleanup evidence",
    );
  }
  return {
    runId,
    orderId: required(summary.orderId, "sale order id"),
    paymentId: required(summary.paymentId, "sale payment id"),
    paymentNo: required(summary.paymentNo, "sale payment number"),
    commandId: required(summary.vendingCommandId, "sale command id"),
    commandNo: required(summary.commandNo, "sale command number"),
    fulfillmentMovementId: required(
      summary.movementId,
      "sale fulfillment movement id",
    ),
    controlPlaneSessionId,
    serialSessionId: required(
      summary.serialSessionId,
      "sale serial session id",
    ),
    resultRoute: required(sale?.resultRoute, "sale result route"),
    handoff,
    gateCleanup: { paymentGateOpen, serialSessionInactive },
  };
}

export function validateStockMaintenanceReport(report) {
  const runId = report?.runId;
  const firstOrderId = report?.firstSale?.orderId;
  const secondOrderId = report?.secondSale?.orderId;
  const movements = report?.terminal?.movements;
  const projection = report?.maintenance?.projection;
  const platformMovement = report?.maintenance?.platformMovement;
  const salePlatformMovements = movements?.salePlatformMovements;
  const stock = (value, quantity) =>
    value?.physicalStock === quantity && value?.saleableStock === quantity;
  const validSale = (sale) =>
    sale?.runId === runId &&
    [
      "orderId",
      "paymentId",
      "paymentNo",
      "commandId",
      "commandNo",
      "fulfillmentMovementId",
      "controlPlaneSessionId",
      "serialSessionId",
    ].every((key) => typeof sale?.[key] === "string" && sale[key] !== "") &&
    sale?.resultRoute === "#/result/success" &&
    sale?.gateCleanup?.paymentGateOpen === true &&
    sale?.gateCleanup?.serialSessionInactive === true;
  if (
    report?.schemaVersion !== SCHEMA_VERSION ||
    report?.ok !== true ||
    typeof runId !== "string" ||
    report?.fixture?.initialQuantity !== 1 ||
    typeof report?.fixture?.slotDisplayLabel !== "string" ||
    typeof report?.fixture?.sku !== "string" ||
    typeof report?.fixture?.slotId !== "string" ||
    typeof report?.fixture?.inventoryId !== "string" ||
    report?.movementCursor?.inventoryId !== report.fixture.inventoryId ||
    !Number.isFinite(Date.parse(report?.movementCursor?.capturedAt)) ||
    !Array.isArray(report?.movementCursor?.baselineItemIds) ||
    new Set(report.movementCursor.baselineItemIds).size !==
      report.movementCursor.baselineItemIds.length ||
    !validSale(report?.firstSale) ||
    !validSale(report?.secondSale) ||
    firstOrderId === secondOrderId ||
    report.firstSale.controlPlaneSessionId ===
      report.secondSale.controlPlaneSessionId ||
    report.firstSale.serialSessionId === report.secondSale.serialSessionId ||
    report.firstSale.paymentId === report.secondSale.paymentId ||
    report.firstSale.commandId === report.secondSale.commandId ||
    report.firstSale.fulfillmentMovementId ===
      report.secondSale.fulfillmentMovementId ||
    !stock(report?.unavailable?.daemon, 0) ||
    report?.unavailable?.platform?.onHandQty !== 0 ||
    report?.maintenance?.addition !== 2 ||
    report?.maintenance?.previewQuantity !== 2 ||
    report?.maintenance?.refillMovementCount !== 1 ||
    projection?.taskStatus !== "complete" ||
    projection?.slotSyncStatus !== "accepted" ||
    projection?.movementId !==
      `${report.maintenance.taskId}:${report.fixture.slotId}` ||
    projection?.movementType !== "planned_refill" ||
    projection?.source !== "local_maintenance" ||
    projection?.attributedTo !== "local_operations" ||
    typeof projection?.platformRawMovementId !== "string" ||
    projection.platformRawMovementId === "" ||
    platformMovement?.inventoryId !== report.fixture.inventoryId ||
    platformMovement?.reason !== "hardware_sync" ||
    platformMovement?.deltaQty !== 2 ||
    typeof platformMovement?.id !== "string" ||
    platformMovement?.taskId !== report.maintenance.taskId ||
    platformMovement?.note !==
      `machine_stock_movement:${projection.platformRawMovementId}` ||
    !stock(report?.restored?.daemon, 2) ||
    report?.restored?.platform?.onHandQty !== 2 ||
    !stock(report?.terminal?.daemon, 1) ||
    report?.terminal?.platform?.onHandQty !== 1 ||
    !Array.isArray(movements?.saleDecrementOrderIds) ||
    new Set(movements.saleDecrementOrderIds).size !== 2 ||
    !movements.saleDecrementOrderIds.includes(firstOrderId) ||
    !movements.saleDecrementOrderIds.includes(secondOrderId) ||
    !Array.isArray(movements?.salePlatformMovementIds) ||
    movements.salePlatformMovementIds.length !== 2 ||
    new Set(movements.salePlatformMovementIds).size !== 2 ||
    movements.salePlatformMovementIds.some(
      (movementId) => typeof movementId !== "string" || movementId === "",
    ) ||
    !Array.isArray(salePlatformMovements) ||
    salePlatformMovements.length !== 2 ||
    salePlatformMovements.some(
      (movement) =>
        typeof movement?.id !== "string" ||
        movement.id === "" ||
        typeof movement?.orderId !== "string" ||
        movement.orderId === "",
    ) ||
    !salePlatformMovements.some(
      (movement) => movement.orderId === firstOrderId,
    ) ||
    !salePlatformMovements.some(
      (movement) => movement.orderId === secondOrderId,
    ) ||
    new Set(salePlatformMovements.map((movement) => movement.orderId)).size !==
      2 ||
    new Set([
      platformMovement.id,
      ...salePlatformMovements.map((movement) => movement.id),
    ]).size !== 3 ||
    [
      platformMovement.id,
      ...salePlatformMovements.map((movement) => movement.id),
    ].some((movementId) =>
      report.movementCursor.baselineItemIds.includes(movementId),
    ) ||
    salePlatformMovements.some(
      (movement) => !movements.salePlatformMovementIds.includes(movement.id),
    ) ||
    JSON.stringify(movements.refillDeltas) !== JSON.stringify([2]) ||
    report?.screenshots?.unavailable?.route !==
      "#/maintenance?source=operator" ||
    report?.screenshots?.refillConfirmed?.route !==
      "#/maintenance?source=operator" ||
    report?.screenshots?.restoredSaleability?.route !== "#/catalog" ||
    !["unavailable", "refillConfirmed", "restoredSaleability"].every(
      (key) =>
        typeof report?.screenshots?.[key]?.ref === "string" &&
        report.screenshots[key].slotDisplayLabel ===
          report.fixture.slotDisplayLabel,
    )
  ) {
    throw new Error(
      "stock maintenance report is missing the 1-to-0-to-2-to-1 evidence with an accepted task projection",
    );
  }
  return {
    slotDisplayLabel: report.fixture.slotDisplayLabel,
    firstOrderId,
    secondOrderId,
  };
}

export async function runStockMaintenanceGuest(options) {
  const input = readJson(options.guestInputPath);
  let handoff = readJson(options.handoffPath);
  const fixture = input.fixtureAllocation?.[options.fixtureKey];
  const report = {
    schemaVersion: SCHEMA_VERSION,
    ok: false,
    runId: required(input.runId, "runId"),
    fixture: null,
    movementCursor: null,
    firstSale: null,
    unavailable: null,
    maintenance: null,
    restored: null,
    secondSale: null,
    terminal: null,
    screenshots: {},
  };
  let client = null;
  try {
    const initialView = await daemon(handoff, "/v1/sale-view");
    const identity = fixtureIdentity(initialView, fixture);
    const initial = stockFact(initialView, identity);
    if (initial.physicalStock !== 1 || initial.saleableStock !== 1) {
      throw new Error(
        "stock fixture must enter the installed journey at quantity one",
      );
    }
    report.fixture = { ...identity, initialQuantity: 1 };
    const token = await adminToken(input);
    report.movementCursor = movementCursor(
      await inventoryMovements(input, token, identity.inventoryId),
      identity.inventoryId,
    );
    const firstHandoff = await replaceSaleHandoff(input, handoff, options);
    handoff = readJson(options.handoffPath);
    const firstReportPath = join(
      dirname(localPath(options.outPath)),
      "stock-maintenance-first-sale.json",
    );
    const first = await runSale(options, firstReportPath);
    report.firstSale = saleEvidence(first, report.runId, firstHandoff);
    const unavailableView = await waitFor(
      "fixture depletion after first installed sale",
      () => daemon(handoff, "/v1/sale-view"),
      (view) =>
        stockFact(view, identity).physicalStock === 0 &&
        stockFact(view, identity).saleableStock === 0,
    );
    const unavailablePlatform = await waitFor(
      "platform depletion after first installed sale",
      () => inventory(input, token, identity.inventoryId),
      (value) => value?.onHandQty === 0 && value?.reservedQty === 0,
    );
    report.unavailable = {
      daemon: stockFact(unavailableView, identity),
      platform: unavailablePlatform,
    };
    client = await connectUi(handoff);
    await openStockMaintenance(client);
    const sink = screenshotSink(options.outPath);
    report.screenshots.unavailable = await captureStockScreenshot(
      client,
      sink,
      "unavailable",
      "#/maintenance?source=operator",
      identity,
    );
    await enterRoutineRefill(client, identity);
    const submittedTask = await waitFor(
      "submitted +2 routine refill",
      () => daemon(handoff, "/v1/stock/maintenance-task"),
      (task) =>
        task?.mode === "routine_refill" &&
        task?.slots?.some(
          (slot) =>
            slot?.slotDisplayLabel === identity.slotDisplayLabel &&
            slot?.submittedAddition === 2 &&
            slot?.previewQuantity === 2 &&
            slot?.movementId === `${task.taskId}:${identity.slotId}`,
        ),
    );
    const submittedSlot = submittedTask.slots.find(
      (slot) => slot.slotDisplayLabel === identity.slotDisplayLabel,
    );
    report.maintenance = {
      taskId: submittedTask.taskId,
      addition: submittedSlot.submittedAddition,
      previewQuantity: submittedSlot.previewQuantity,
      refillMovementCount: null,
      projection: null,
      platformMovement: null,
    };
    report.screenshots.refillConfirmed = await captureStockScreenshot(
      client,
      sink,
      "refill-confirmed",
      "#/maintenance?source=operator",
      identity,
    );
    const restoredView = await waitFor(
      "local refill synchronization",
      () => daemon(handoff, "/v1/sale-view"),
      (view) =>
        stockFact(view, identity).physicalStock === 2 &&
        stockFact(view, identity).saleableStock === 2,
    );
    const restoredPlatform = await waitFor(
      "platform refill synchronization",
      () => inventory(input, token, identity.inventoryId),
      (value) => value?.onHandQty === 2 && value?.reservedQty === 0,
    );
    const completedTask = await waitFor(
      "accepted routine refill task projection",
      () =>
        daemon(
          handoff,
          `/v1/stock/maintenance-tasks/${encodeURIComponent(submittedTask.taskId)}/projection`,
        ),
      (task) =>
        task?.taskId === submittedTask.taskId &&
        task?.mode === "routine_refill" &&
        task?.status === "complete" &&
        task?.slots?.some(
          (slot) =>
            slot?.slotDisplayLabel === identity.slotDisplayLabel &&
            slot?.submittedAddition === 2 &&
            slot?.previewQuantity === 2 &&
            slot?.movementId === `${submittedTask.taskId}:${identity.slotId}` &&
            slot?.movementType === "planned_refill" &&
            slot?.source === "local_maintenance" &&
            slot?.attributedTo === "local_operations" &&
            typeof slot?.platformRawMovementId === "string" &&
            slot.platformRawMovementId !== "" &&
            slot?.syncStatus === "accepted",
        ),
    );
    const completedSlot = completedTask.slots.find(
      (slot) => slot.slotDisplayLabel === identity.slotDisplayLabel,
    );
    report.maintenance.projection = {
      taskStatus: completedTask.status,
      slotSyncStatus: completedSlot.syncStatus,
      movementId: completedSlot.movementId,
      movementType: completedSlot.movementType,
      source: completedSlot.source,
      attributedTo: completedSlot.attributedTo,
      platformRawMovementId: completedSlot.platformRawMovementId,
    };
    const afterRefillMovements = await waitFor(
      "one correlated platform refill movement",
      () => inventoryMovements(input, token, identity.inventoryId),
      (page) =>
        movementDelta(page, report.movementCursor).filter(
          (movement) =>
            movement?.reason === "hardware_sync" &&
            movement?.deltaQty === 2 &&
            movement?.inventoryId === identity.inventoryId &&
            movement?.note ===
              `machine_stock_movement:${completedSlot.platformRawMovementId}`,
        ).length === 1,
    );
    const refillMovements = movementDelta(
      afterRefillMovements,
      report.movementCursor,
    ).filter(
      (movement) =>
        movement?.reason === "hardware_sync" &&
        movement?.deltaQty === 2 &&
        movement?.inventoryId === identity.inventoryId &&
        movement?.note ===
          `machine_stock_movement:${completedSlot.platformRawMovementId}`,
    );
    report.maintenance.refillMovementCount = refillMovements.length;
    report.maintenance.platformMovement = {
      ...refillMovements[0],
      taskId: submittedTask.taskId,
    };
    report.restored = {
      daemon: stockFact(restoredView, identity),
      platform: restoredPlatform,
    };
    await returnToCatalogFromMaintenance(client);
    await waitFor(
      "visible restored fixture saleability",
      () =>
        evaluateExpression(
          client,
          `Boolean(document.querySelector(${JSON.stringify(`[data-test='catalog-product'][data-slot-id='${identity.slotDisplayLabel}']`)})?.getClientRects().length)`,
        ),
      (visible) => visible === true,
    );
    report.screenshots.restoredSaleability = await captureStockScreenshot(
      client,
      sink,
      "restored-saleability",
      "#/catalog",
      identity,
    );
    await client.close();
    client = null;
    const secondReportPath = join(
      dirname(localPath(options.outPath)),
      "stock-maintenance-second-sale.json",
    );
    const secondHandoff = await replaceSaleHandoff(input, handoff, options);
    handoff = readJson(options.handoffPath);
    const second = await runSale(options, secondReportPath);
    report.secondSale = saleEvidence(second, report.runId, secondHandoff);
    const terminalView = await waitFor(
      "fixture terminal quantity after second installed sale",
      () => daemon(handoff, "/v1/sale-view"),
      (view) =>
        stockFact(view, identity).physicalStock === 1 &&
        stockFact(view, identity).saleableStock === 1,
    );
    const terminalPlatform = await waitFor(
      "platform terminal quantity after second installed sale",
      () => inventory(input, token, identity.inventoryId),
      (value) => value?.onHandQty === 1 && value?.reservedQty === 0,
    );
    const terminalMovements = await waitFor(
      "two correlated sale decrements",
      () => inventoryMovements(input, token, identity.inventoryId),
      (page) => {
        const ids = movementDelta(page, report.movementCursor)
          .filter(
            (movement) =>
              movement?.reason === "purchase_confirmed" &&
              movement?.deltaQty === -1,
          )
          .map((movement) => movement.orderId);
        return (
          ids.includes(report.firstSale.orderId) &&
          ids.includes(report.secondSale.orderId)
        );
      },
    );
    const salePlatformMovements = movementDelta(
      terminalMovements,
      report.movementCursor,
    )
      .filter(
        (movement) =>
          movement?.reason === "purchase_confirmed" &&
          movement?.deltaQty === -1 &&
          [report.firstSale.orderId, report.secondSale.orderId].includes(
            movement?.orderId,
          ),
      )
      .map((movement) => ({ id: movement.id, orderId: movement.orderId }));
    report.terminal = {
      daemon: stockFact(terminalView, identity),
      platform: terminalPlatform,
      movements: {
        saleDecrementOrderIds: salePlatformMovements.map(
          (movement) => movement.orderId,
        ),
        salePlatformMovementIds: salePlatformMovements.map(
          (movement) => movement.id,
        ),
        salePlatformMovements,
        refillDeltas: movementDelta(terminalMovements, report.movementCursor)
          .filter((movement) => movement?.reason === "hardware_sync")
          .map((movement) => movement.deltaQty),
      },
    };
    report.ok = true;
    validateStockMaintenanceReport(report);
    writeJson(options.outPath, report);
    return report;
  } catch (error) {
    report.error = {
      message: error instanceof Error ? error.message : String(error),
    };
    writeJson(options.outPath, report);
    throw error;
  } finally {
    await client?.close().catch(() => undefined);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runStockMaintenanceGuest(
    parseStockMaintenanceGuestArgs(process.argv.slice(2)),
  ).catch((error) => {
    console.error(error.stack ?? error);
    process.exitCode = 1;
  });
}
