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

const SCHEMA_VERSION = "vem-stock-maintenance-guest-full/v1";
const TIMEOUT_MS = 45_000;
const POLL_MS = 250;
const STOCK_TASK_SELECTOR = "[data-test='maintenance-task-stock']";
const STOCK_PANEL_SELECTOR = "[data-test='stock-maintenance']";

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

function unwrap(payload) {
  return payload?.code === 0 && Object.hasOwn(payload, "data")
    ? payload.data
    : payload;
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: options.signal ?? AbortSignal.timeout(TIMEOUT_MS),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.code !== 0) {
    throw new Error(
      `${options.method ?? "GET"} ${url} returned HTTP ${response.status}: ${JSON.stringify(payload)}`,
    );
  }
  return unwrap(payload);
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
    { headers: { authorization: `Bearer ${token}` } },
  );
}

async function inventory(input, token, inventoryId) {
  const base = required(
    input?.runtimeBootstrap?.provisioningApiBaseUrl,
    "runtimeBootstrap.provisioningApiBaseUrl",
  ).replace(/\/+$/, "");
  const page = await request(`${base}/inventories?page=1&pageSize=100`, {
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
  const slotCode = required(fixture?.slotCode, "stock fixture slotCode");
  const sku = required(fixture?.sku, "stock fixture sku");
  const item = (saleView?.items ?? []).find(
    (entry) => entry?.slotCode === slotCode && entry?.sku === sku,
  );
  if (!item?.slotId || !item?.inventoryId) {
    throw new Error(
      `fixture ${sku} at ${slotCode} is absent from the daemon sale view`,
    );
  }
  return { slotCode, sku, slotId: item.slotId, inventoryId: item.inventoryId };
}

function stockFact(saleView, identity) {
  const item = (saleView?.items ?? []).find(
    (entry) =>
      entry?.slotCode === identity.slotCode &&
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
  await evaluateExpression(
    client,
    "location.hash = '#/maintenance?source=operator'",
  );
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

async function enterRoutineRefill(client, identity) {
  const slotSelector = `[data-test='stock-maintenance-slot'][data-slot-code='${identity.slotCode}'][data-sku='${identity.sku}']`;
  const additionSelector = `[data-test='stock-maintenance-addition'][data-slot-code='${identity.slotCode}']`;
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
  const previewSelector = `[data-test='stock-maintenance-preview'][data-slot-code='${identity.slotCode}']`;
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

export function validateStockMaintenanceReport(report) {
  const firstOrderId = report?.firstSale?.orderId;
  const secondOrderId = report?.secondSale?.orderId;
  const movements = report?.terminal?.movements;
  const stock = (value, quantity) =>
    value?.physicalStock === quantity && value?.saleableStock === quantity;
  if (
    report?.schemaVersion !== SCHEMA_VERSION ||
    report?.ok !== true ||
    report?.fixture?.initialQuantity !== 1 ||
    typeof report?.fixture?.slotCode !== "string" ||
    typeof report?.fixture?.sku !== "string" ||
    typeof report?.fixture?.inventoryId !== "string" ||
    typeof firstOrderId !== "string" ||
    typeof secondOrderId !== "string" ||
    firstOrderId === secondOrderId ||
    !stock(report?.unavailable?.daemon, 0) ||
    report?.unavailable?.platform?.onHandQty !== 0 ||
    report?.maintenance?.addition !== 2 ||
    report?.maintenance?.previewQuantity !== 2 ||
    report?.maintenance?.refillMovementCount !== 1 ||
    !stock(report?.restored?.daemon, 2) ||
    report?.restored?.platform?.onHandQty !== 2 ||
    !stock(report?.terminal?.daemon, 1) ||
    report?.terminal?.platform?.onHandQty !== 1 ||
    !Array.isArray(movements?.saleDecrementOrderIds) ||
    new Set(movements.saleDecrementOrderIds).size !== 2 ||
    !movements.saleDecrementOrderIds.includes(firstOrderId) ||
    !movements.saleDecrementOrderIds.includes(secondOrderId) ||
    JSON.stringify(movements.refillDeltas) !== JSON.stringify([2]) ||
    !["unavailable", "refillConfirmed", "restoredSaleability"].every(
      (key) => typeof report?.screenshots?.[key]?.ref === "string",
    )
  ) {
    throw new Error(
      "stock maintenance report is missing the 1-to-0-to-2-to-1 evidence",
    );
  }
  return { slotCode: report.fixture.slotCode, firstOrderId, secondOrderId };
}

export async function runStockMaintenanceGuest(options) {
  const input = readJson(options.guestInputPath);
  const handoff = readJson(options.handoffPath);
  const fixture = input.fixtureAllocation?.[options.fixtureKey];
  const report = {
    schemaVersion: SCHEMA_VERSION,
    ok: false,
    runId: required(input.runId, "runId"),
    fixture: null,
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
    const firstReportPath = join(
      dirname(localPath(options.outPath)),
      "stock-maintenance-first-sale.json",
    );
    const first = await runSale(options, firstReportPath);
    report.firstSale = {
      orderId: required(
        first?.renderedSale?.orderId,
        "first installed sale orderId",
      ),
    };
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
    report.screenshots.unavailable = await captureScreenshot(client, {
      label: "unavailable",
      screenshotSink: sink,
      validatePng: true,
    });
    await enterRoutineRefill(client, identity);
    const submittedTask = await waitFor(
      "submitted +2 routine refill",
      () => daemon(handoff, "/v1/stock/maintenance-task"),
      (task) =>
        task?.mode === "routine_refill" &&
        task?.slots?.some(
          (slot) =>
            slot?.slotCode === identity.slotCode &&
            slot?.submittedAddition === 2 &&
            slot?.previewQuantity === 2,
        ),
    );
    const submittedSlot = submittedTask.slots.find(
      (slot) => slot.slotCode === identity.slotCode,
    );
    report.maintenance = {
      taskId: submittedTask.taskId,
      addition: submittedSlot.submittedAddition,
      previewQuantity: submittedSlot.previewQuantity,
      refillMovementCount: null,
    };
    report.screenshots.refillConfirmed = await captureScreenshot(client, {
      label: "refill-confirmed",
      screenshotSink: sink,
      validatePng: true,
    });
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
    const afterRefillMovements = await waitFor(
      "one correlated platform refill movement",
      () => inventoryMovements(input, token, identity.inventoryId),
      (page) =>
        (page?.items ?? []).filter(
          (movement) =>
            movement?.reason === "refill" && movement?.deltaQty === 2,
        ).length === 1,
    );
    report.maintenance.refillMovementCount = (
      afterRefillMovements.items ?? []
    ).filter(
      (movement) => movement?.reason === "refill" && movement?.deltaQty === 2,
    ).length;
    report.restored = {
      daemon: stockFact(restoredView, identity),
      platform: restoredPlatform,
    };
    await evaluateExpression(client, "location.hash = '#/catalog'");
    await waitForRoute(client, "#/catalog", {
      timeoutMs: TIMEOUT_MS,
      pollMs: POLL_MS,
    });
    await waitFor(
      "visible restored fixture saleability",
      () =>
        evaluateExpression(
          client,
          `Boolean(document.querySelector(${JSON.stringify(`[data-test='catalog-product'][data-slot-code='${identity.slotCode}']`)})?.getClientRects().length)`,
        ),
      (visible) => visible === true,
    );
    report.screenshots.restoredSaleability = await captureScreenshot(client, {
      label: "restored-saleability",
      screenshotSink: sink,
      validatePng: true,
    });
    await client.close();
    client = null;
    const secondReportPath = join(
      dirname(localPath(options.outPath)),
      "stock-maintenance-second-sale.json",
    );
    const second = await runSale(options, secondReportPath);
    report.secondSale = {
      orderId: required(
        second?.renderedSale?.orderId,
        "second installed sale orderId",
      ),
    };
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
        const ids = (page?.items ?? [])
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
    report.terminal = {
      daemon: stockFact(terminalView, identity),
      platform: terminalPlatform,
      movements: {
        saleDecrementOrderIds: (terminalMovements.items ?? [])
          .filter(
            (movement) =>
              movement?.reason === "purchase_confirmed" &&
              movement?.deltaQty === -1,
          )
          .map((movement) => movement.orderId)
          .filter((orderId) =>
            [report.firstSale.orderId, report.secondSale.orderId].includes(
              orderId,
            ),
          ),
        refillDeltas: (terminalMovements.items ?? [])
          .filter((movement) => movement?.reason === "refill")
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
