#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  readMachineRuntimeTraceSnapshot,
  rewriteWebSocketDebuggerUrl,
  waitForRoute,
} from "./machine-ui-cdp-driver.ts";
import { replaceSerialSessionAndUpdateHandoff } from "./serial-session-handoff.ts";

const SCHEMA_VERSION = "vem-stock-maintenance-guest-full/v1";
const TIMEOUT_MS = 45_000;
const POLL_MS = 250;
const STOCK_TASK_SELECTOR = "[data-test='maintenance-task-stock']";
const STOCK_PANEL_SELECTOR = "[data-test='stock-maintenance']";
const MAINTENANCE_ENTRY_SELECTOR = "[data-test='maintenance-entry-header']";
const MAINTENANCE_RETURN_SELECTOR = "[data-test='maintenance-return-catalog']";
const STOCK_FIXTURE_CATEGORY_KEY = "socks";

type JsonRecord = Record<string, unknown>;
type GuestInputRecord = JsonRecord;
type HandoffRecord = JsonRecord;

function required(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function option(args: string[], name: string): string {
  const index = args.indexOf(`--${name}`);
  return required(index === -1 ? undefined : args[index + 1], `--${name}`);
}

function localPath(value: unknown): string {
  const path = required(value, "Windows path");
  return process.platform === "win32"
    ? path
    : resolve(
        `/mnt/${path[0].toLowerCase()}/${path.slice(3).replaceAll("\\", "/")}`,
      );
}

export function parseStockMaintenanceGuestArgs(args: string[]): {
  mode: "full";
  guestInputPath: string;
  handoffPath: string;
  outPath: string;
  fixtureKey: string;
} {
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

function readJson(path: string): JsonRecord {
  return JSON.parse(readFileSync(localPath(path), "utf8")) as JsonRecord;
}

function writeJson(path: string, value: unknown): void {
  const target = localPath(path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function parseDaemonPayload(payload: unknown): JsonRecord {
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    Object.hasOwn(payload, "code") ||
    Object.hasOwn(payload, "data")
  ) {
    throw new Error("daemon response must be bare JSON");
  }
  return payload as JsonRecord;
}

export function parseServiceApiEnvelope(payload: unknown): unknown {
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    (payload as JsonRecord).code !== 0 ||
    !Object.hasOwn(payload, "data")
  ) {
    throw new Error("Service API response must be a success envelope");
  }
  return (payload as JsonRecord).data;
}

async function request(
  url: string,
  {
    parse,
    ...options
  }: JsonRecord & { parse?: (payload: unknown) => unknown } = {},
): Promise<unknown> {
  const response = await fetch(url, {
    ...options,
    signal:
      (options.signal as AbortSignal | undefined) ??
      AbortSignal.timeout(TIMEOUT_MS),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      `${options.method ?? "GET"} ${url} returned HTTP ${response.status}: ${JSON.stringify(payload)}`,
    );
  }
  return parse ? parse(payload) : payload;
}

async function hostControlRequest(
  input: GuestInputRecord,
  path: string,
  body: JsonRecord = {},
): Promise<unknown> {
  const controlPlane = input?.hostControlPlane as JsonRecord | undefined;
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
  if (!response.ok || (payload as JsonRecord | null)?.ok !== true) {
    throw new Error(
      `host control ${path} returned HTTP ${response.status}: ${JSON.stringify(payload)}`,
    );
  }
  return payload;
}

async function openPaymentCreateGate(
  input: GuestInputRecord,
): Promise<unknown> {
  return await hostControlRequest(input, "/v1/mock-payment-create-gate/open");
}

function daemonBase(handoff: HandoffRecord): string {
  const daemon = handoff?.daemon as JsonRecord | undefined;
  const ready = daemon?.ready as JsonRecord | undefined;
  const healthzUrl = required(ready?.healthzUrl, "daemon healthzUrl");
  if (!healthzUrl.endsWith("/healthz")) {
    throw new Error("daemon healthzUrl must end with /healthz");
  }
  return healthzUrl.slice(0, -"/healthz".length);
}

function daemon(
  handoff: HandoffRecord,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const daemon = handoff?.daemon as JsonRecord | undefined;
  const ready = daemon?.ready as JsonRecord | undefined;
  return request(`${daemonBase(handoff)}${path}`, {
    parse: parseDaemonPayload,
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${required(ready?.ipcToken, "daemon ipcToken")}`,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function adminToken(input: GuestInputRecord): Promise<string> {
  const bootstrap = input?.runtimeBootstrap as JsonRecord | undefined;
  const serviceApi = input?.serviceApi as JsonRecord | undefined;
  const base = required(
    bootstrap?.provisioningApiBaseUrl,
    "runtimeBootstrap.provisioningApiBaseUrl",
  ).replace(/\/+$/, "");
  const login = await request(`${base}/auth/login`, {
    parse: parseServiceApiEnvelope,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: required(serviceApi?.adminUsername, "serviceApi.adminUsername"),
      password: required(serviceApi?.adminPassword, "serviceApi.adminPassword"),
    }),
  });
  return required(
    (login as JsonRecord | undefined)?.accessToken,
    "admin access token",
  );
}

async function inventoryMovements(
  input: GuestInputRecord,
  token: string,
  inventoryId: string,
): Promise<unknown> {
  const bootstrap = input?.runtimeBootstrap as JsonRecord | undefined;
  const base = required(
    bootstrap?.provisioningApiBaseUrl,
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

function movementCursor(
  page: JsonRecord | null | undefined,
  inventoryId: string,
): JsonRecord {
  const items = (page?.items ?? []) as unknown[];
  const baselineItemIds = items.map((item) => (item as JsonRecord)?.id);
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

function movementDelta(
  page: JsonRecord | null | undefined,
  cursor: JsonRecord,
): unknown[] {
  const baselineItemIds = cursor.baselineItemIds as unknown[];
  return ((page?.items ?? []) as unknown[]).filter(
    (item) => !baselineItemIds.includes((item as JsonRecord)?.id),
  );
}

async function inventory(
  input: GuestInputRecord,
  token: string,
  inventoryId: string,
): Promise<JsonRecord> {
  const bootstrap = input?.runtimeBootstrap as JsonRecord | undefined;
  const base = required(
    bootstrap?.provisioningApiBaseUrl,
    "runtimeBootstrap.provisioningApiBaseUrl",
  ).replace(/\/+$/, "");
  const page = await request(`${base}/inventories?page=1&pageSize=100`, {
    parse: parseServiceApiEnvelope,
    headers: { authorization: `Bearer ${token}` },
  });
  const pageRecord = page as JsonRecord | null;
  const items = (pageRecord?.items ?? []) as unknown[];
  const entry = items.find((item) => (item as JsonRecord)?.id === inventoryId);
  if (!entry)
    throw new Error(
      `fixture inventory ${inventoryId} is absent from Admin API`,
    );
  return entry as JsonRecord;
}

function fixtureIdentity(
  saleView: JsonRecord | null | undefined,
  fixture: JsonRecord | null | undefined,
): JsonRecord {
  const slotId = required(fixture?.slotId, "stock fixture slotId");
  const rowNo = fixture?.rowNo;
  const cellNo = fixture?.cellNo;
  const sku = required(fixture?.sku, "stock fixture sku");
  const saleViewRecord = saleView as JsonRecord | null;
  const items = (saleViewRecord?.items ?? []) as unknown[];
  const item = items.find(
    (entry) =>
      (entry as JsonRecord)?.rowNo === rowNo &&
      (entry as JsonRecord)?.cellNo === cellNo &&
      (entry as JsonRecord)?.sku === sku,
  ) as JsonRecord | undefined;
  if (!item?.slotId || item.slotId !== slotId || !item?.inventoryId) {
    throw new Error(
      `fixture ${sku} at R${rowNo}C${cellNo} is absent from the daemon sale view`,
    );
  }
  return {
    slotDisplayLabel: item.slotDisplayLabel,
    sku,
    slotId,
    inventoryId: item.inventoryId,
    catalogKey: `product:${item.productId}`,
  };
}

function stockFact(
  saleView: JsonRecord | null | undefined,
  identity: JsonRecord,
): JsonRecord {
  const items = ((saleView as JsonRecord | null)?.items ?? []) as unknown[];
  const item = items.find(
    (entry) =>
      (entry as JsonRecord)?.slotId === identity.slotId &&
      (entry as JsonRecord)?.inventoryId === identity.inventoryId &&
      (entry as JsonRecord)?.sku === identity.sku,
  ) as JsonRecord | undefined;
  if (!item)
    throw new Error("fixture identity no longer resolves in daemon sale view");
  return {
    physicalStock: item.physicalStock,
    saleableStock: item.saleableStock,
    slotSalesState: item.slotSalesState,
  };
}

async function waitFor<T>(
  label: string,
  read: () => Promise<T>,
  accepts: (value: T) => boolean,
): Promise<T> {
  const deadline = Date.now() + TIMEOUT_MS;
  let last: T | null = null;
  do {
    last = await read();
    if (accepts(last)) return last;
    await sleep(POLL_MS);
  } while (Date.now() < deadline);
  throw new Error(
    `${label} did not reach its correlated state: ${JSON.stringify(last)}`,
  );
}

function screenshotSink(
  outPath: string,
): (input: { bytes: Uint8Array; label: string }) => Promise<{ ref: string }> {
  const root = join(dirname(localPath(outPath)), "stock-maintenance-artifacts");
  return async ({ bytes, label }) => {
    mkdirSync(root, { recursive: true });
    const file = join(root, `${label}.png`);
    writeFileSync(file, bytes);
    return { ref: file };
  };
}

async function connectUi(
  handoff: HandoffRecord,
): Promise<InstanceType<typeof CdpClient>> {
  const cdp = handoff?.cdp as JsonRecord | undefined;
  const endpoint = required(cdp?.endpoint, "handoff cdp endpoint");
  const target = await discoverMachineUiTarget({
    endpoint,
    expectedTargetId: required(cdp?.targetId, "handoff cdp targetId"),
  });
  const client = new CdpClient(
    rewriteWebSocketDebuggerUrl(target.webSocketDebuggerUrl, endpoint),
  );
  await client.connect();
  await enablePageRuntime(client);
  return client;
}

async function openStockMaintenance(
  client: InstanceType<typeof CdpClient>,
): Promise<void> {
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
    const dispatched = await evaluateExpression(
      client,
      `(() => {
        const target = document.querySelector(${JSON.stringify(MAINTENANCE_ENTRY_SELECTOR)});
        if (!target) return false;
        target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        return true;
      })()`,
    );
    if (!dispatched) throw new Error("maintenance entry is unavailable");
    await new Promise((resolve) => setTimeout(resolve, 80));
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

async function returnToCatalogFromMaintenance(
  client: InstanceType<typeof CdpClient>,
): Promise<void> {
  await activateVisibleSelector(client, MAINTENANCE_RETURN_SELECTOR, {
    kind: "touch",
    timeoutMs: TIMEOUT_MS,
    pollMs: POLL_MS,
  });
  await waitForRoute(client, "#/catalog", {
    timeoutMs: TIMEOUT_MS,
    pollMs: POLL_MS,
    forbiddenRoutes: [],
  });
}

async function selectStockFixtureCategory(
  client: InstanceType<typeof CdpClient>,
): Promise<void> {
  await activateVisibleSelector(
    client,
    `[data-test="catalog-category"][data-category-key="${STOCK_FIXTURE_CATEGORY_KEY}"]:not(:disabled)`,
    {
      kind: "touch",
      timeoutMs: TIMEOUT_MS,
      pollMs: POLL_MS,
    },
  );
}

async function returnCustomerResultToCatalog(
  client: InstanceType<typeof CdpClient>,
): Promise<unknown> {
  const state = (await evaluateExpression(
    client,
    `(() => ({
      route: location.hash,
      catalogVisible: Boolean(document.querySelector("[data-test='catalog-page']")),
      returnVisible: Boolean(document.querySelector("[data-test='result-return-catalog']")?.getClientRects().length)
    }))()`,
  )) as JsonRecord | null;
  if (state?.route === "#/catalog" && state.catalogVisible === true)
    return state;
  if (!state?.returnVisible) {
    throw new Error(
      `stock maintenance cannot return customer runtime to Catalog from ${JSON.stringify(state)}`,
    );
  }
  await activateVisibleSelector(client, "[data-test='result-return-catalog']", {
    kind: "touch",
    timeoutMs: TIMEOUT_MS,
    pollMs: POLL_MS,
  });
  return await waitForRoute(client, "#/catalog", {
    timeoutMs: TIMEOUT_MS,
    pollMs: POLL_MS,
  });
}

async function primeCatalogTouchSession(
  client: InstanceType<typeof CdpClient>,
): Promise<unknown> {
  await waitForRoute(client, "#/catalog", {
    timeoutMs: TIMEOUT_MS,
    pollMs: POLL_MS,
    forbiddenRoutes: [],
  });
  // 商品详情“返回”现在回到所属大类列表（路由仍是 #/catalog，页面处于分类网格）。
  // 此时盲点 catalog-page 中心可能命中商品卡片并把 UI 带进详情页；先经列表页的
  // “返回首页”回到首页目录，确保后续触摸会话落在中性区域。
  const backHomePresent = await evaluateExpression(
    client,
    `Boolean(document.querySelector(".catalog-back-button"))`,
  );
  if (backHomePresent === true) {
    await activateVisibleSelector(client, ".catalog-back-button", {
      kind: "touch",
      timeoutMs: TIMEOUT_MS,
      pollMs: POLL_MS,
    });
    await waitFor(
      "home catalog after detail return",
      () =>
        evaluateExpression(
          client,
          `!document.querySelector(".catalog-back-button")`,
        ),
      (home) => home === true,
    );
  }
  const traceSnapshot = (await readMachineRuntimeTraceSnapshot(
    client,
  )) as JsonRecord | null;
  const entries = Array.isArray(traceSnapshot?.entries)
    ? (traceSnapshot.entries as unknown[])
    : [];
  const last = entries.at(-1);
  const lastRecord = last as JsonRecord | undefined;
  const boundary = {
    id: Number(lastRecord?.id ?? 0),
    touchscreenSessionActive: Boolean(lastRecord?.touchscreenSessionActive),
  };
  await activateVisibleSelector(client, "[data-test='catalog-page']", {
    kind: "touch",
    timeoutMs: TIMEOUT_MS,
    pollMs: POLL_MS,
  });
  return await waitFor(
    "catalog touch session before stock sale",
    async () => {
      const snapshot = (await readMachineRuntimeTraceSnapshot(
        client,
      )) as JsonRecord | null;
      const currentEntries = Array.isArray(snapshot?.entries)
        ? (snapshot.entries as unknown[])
        : [];
      const touch = currentEntries.findLast((entry) => {
        const entryRecord = entry as JsonRecord;
        return (
          Number(entryRecord?.id ?? 0) > Number(boundary?.id ?? 0) &&
          entryRecord?.type === "navigation" &&
          entryRecord?.intentType === "customer.touch" &&
          entryRecord?.decision === "accepted" &&
          entryRecord?.reasonCode === "touchscreen_session_renewed"
        );
      }) as JsonRecord | undefined;
      return touch
        ? {
            id: touch.id,
            touchscreenSessionActive: touch.touchscreenSessionActive,
          }
        : null;
    },
    (touch) => (touch as JsonRecord | null)?.touchscreenSessionActive === true,
  );
}

async function observeProductDetailStock(
  client: InstanceType<typeof CdpClient>,
  identity: JsonRecord,
  expectedQuantity: number,
): Promise<unknown> {
  await selectStockFixtureCategory(client);
  const productSelector = `[data-test='catalog-product'][data-catalog-key='${identity.catalogKey}']`;
  await waitFor(
    `visible stock fixture ${identity.catalogKey}`,
    () =>
      evaluateExpression(
        client,
        `Boolean(document.querySelector(${JSON.stringify(productSelector)})?.getClientRects().length)`,
      ),
    (visible) => visible === true,
  );
  await activateVisibleSelector(client, productSelector, {
    kind: "touch",
    timeoutMs: TIMEOUT_MS,
    pollMs: POLL_MS,
  });
  await waitForRoute(client, /^#\/products\//, {
    timeoutMs: TIMEOUT_MS,
    pollMs: POLL_MS,
  });
  const detail = await waitFor(
    `visible product detail stock ${expectedQuantity}`,
    () =>
      evaluateExpression(
        client,
        `(() => {
          const page = document.querySelector("[data-test='product-detail-page']");
          const stock = document.querySelector("[data-test='product-detail-stock']");
          return {
            route: location.hash,
            catalogKey: page?.getAttribute("data-catalog-key") || null,
            variantId: page?.getAttribute("data-variant-id") || null,
            saleableStock: Number(stock?.getAttribute("data-saleable-stock")),
            text: (stock?.textContent || "").replace(/\\s+/g, " ").trim()
          };
        })()`,
      ),
    (value) => {
      const valueRecord = value as JsonRecord;
      return (
        valueRecord?.catalogKey === identity.catalogKey &&
        valueRecord.saleableStock === expectedQuantity &&
        typeof valueRecord.text === "string" &&
        String(valueRecord.text).includes(String(expectedQuantity))
      );
    },
  );
  await activateVisibleSelector(
    client,
    "[data-test='product-detail-return-catalog']",
    {
      kind: "touch",
      timeoutMs: TIMEOUT_MS,
      pollMs: POLL_MS,
    },
  );
  await waitForRoute(client, "#/catalog", {
    timeoutMs: TIMEOUT_MS,
    pollMs: POLL_MS,
  });
  return detail;
}

async function captureStockScreenshot(
  client: InstanceType<typeof CdpClient>,
  sink: (input: {
    bytes: Uint8Array;
    label: string;
  }) => Promise<{ ref: string }>,
  label: string,
  route: unknown,
  identity: JsonRecord,
): Promise<JsonRecord> {
  return {
    ...(await captureScreenshot(client, {
      label,
      screenshotSink: sink,
      validatePng: true,
    })),
    route,
    slotId: identity.slotId,
    slotDisplayLabel: identity.slotDisplayLabel,
  };
}

async function enterRoutineRefill(
  client: InstanceType<typeof CdpClient>,
  identity: JsonRecord,
): Promise<void> {
  const slotSelector = `[data-test='stock-maintenance-slot'][data-slot-id='${identity.slotId}'][data-sku='${identity.sku}']`;
  const additionSelector = `[data-test='stock-maintenance-addition'][data-slot-id='${identity.slotId}']`;
  await waitFor(
    "fixture stock maintenance row",
    () =>
      evaluateExpression(
        client,
        `Boolean(document.querySelector(${JSON.stringify(slotSelector)}))`,
      ),
    (available) => available === true,
  );
  const inputSet = await evaluateExpression(
    client,
    `(() => {
      const element = document.querySelector(${JSON.stringify(additionSelector)});
      if (!element || element.disabled) return null;
      element.focus();
      element.value = "";
      element.dispatchEvent(new Event("input", { bubbles: true }));
      return { value: element.value, disabled: element.disabled };
    })()`,
  );
  const inputSetRecord = inputSet as JsonRecord | null;
  if (!inputSetRecord || inputSetRecord.disabled) {
    throw new Error(
      `stock maintenance refill input is unavailable: ${JSON.stringify(inputSet)}`,
    );
  }
  await client.send("Input.insertText", { text: "2" });
  await evaluateExpression(
    client,
    `(() => {
      const element = document.querySelector(${JSON.stringify(additionSelector)});
      element?.dispatchEvent(new Event("change", { bubbles: true }));
      return element?.value ?? null;
    })()`,
  );
  await waitFor(
    "visible +2 refill input",
    () =>
      evaluateExpression(
        client,
        `document.querySelector(${JSON.stringify(additionSelector)})?.value ?? null`,
      ),
    (value) => value === "2",
  );
  const previewSelector = `[data-test='stock-maintenance-preview'][data-slot-id='${identity.slotId}']`;
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

function runSale(
  options: {
    guestInputPath: string;
    handoffPath: string;
    outPath: string;
    fixtureKey: string;
  },
  outPath: string,
): Promise<JsonRecord> {
  return new Promise<JsonRecord>((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [
        "scripts/testbed/fast-route-stress-sale.ts",
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
        "--scenario",
        "sale-only",
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
      const report: JsonRecord | null = existsSync(outPath)
        ? readJson(outPath)
        : null;
      const reportError =
        (report?.error as JsonRecord | undefined)?.message ??
        (report?.summary as JsonRecord | undefined)?.error ??
        (report?.validator as JsonRecord | undefined)?.reason ??
        null;
      const reportSummary = report
        ? {
            ok: report.ok,
            stage:
              report.stage ??
              (report.summary as JsonRecord | undefined)?.stage ??
              null,
            route:
              (
                (report.ui as JsonRecord | undefined)?.afterF2 as
                  | JsonRecord
                  | undefined
              )?.route ??
              (report.summary as JsonRecord | undefined)?.route ??
              null,
            orderNo:
              (report.summary as JsonRecord | undefined)?.orderNo ??
              (report.order as JsonRecord | undefined)?.orderNo ??
              null,
            error:
              typeof reportError === "string"
                ? reportError.slice(0, 2_048)
                : reportError,
          }
        : null;
      reject(
        new Error(
          `installed stock sale failed with exit ${code}: ${JSON.stringify({ report: reportSummary, stderr: stderr.slice(-2_048) })}`,
        ),
      );
    });
  });
}

async function replaceSaleHandoff(
  input: GuestInputRecord,
  handoff: HandoffRecord,
  options: { handoffPath: string },
): Promise<JsonRecord> {
  const previousControlPlaneSessionId = required(
    (handoff?.commissioningSerialSession as JsonRecord | undefined)?.sessionId,
    "handoff commissioning serial session id",
  );
  const replaced = (await replaceSerialSessionAndUpdateHandoff({
    guestInput: input,
    handoff,
    handoffPath: options.handoffPath,
    sessionId: previousControlPlaneSessionId,
    control: hostControlRequest,
  })) as JsonRecord;
  const replacement = replaced.replacement as JsonRecord;
  return {
    previousControlPlaneSessionId,
    replacementControlPlaneSessionId: required(
      replacement?.sessionId,
      "replacement serial session id",
    ),
  };
}

export function saleEvidence(
  sale: JsonRecord | null | undefined,
  runId: string,
  handoff: JsonRecord,
): JsonRecord {
  const summary = (sale?.summary ?? {}) as JsonRecord;
  const cleanup = Array.isArray(sale?.cleanup)
    ? (sale.cleanup as unknown[])
    : [];
  const reopenedPaymentGate = cleanup.find(
    (step) =>
      (step as JsonRecord)?.label === "reopen payment create gate" &&
      (step as JsonRecord)?.ok === true &&
      ((step as JsonRecord)?.detail as JsonRecord | undefined)?.state ===
        "open",
  );
  const verifiedPaymentGate = cleanup.find(
    (step) =>
      (step as JsonRecord)?.label === "verify payment create gate" &&
      (step as JsonRecord)?.ok === true &&
      (
        ((step as JsonRecord)?.detail as JsonRecord | undefined)?.status as
          | JsonRecord
          | undefined
      )?.state === "open" &&
      (
        ((step as JsonRecord)?.detail as JsonRecord | undefined)?.status as
          | JsonRecord
          | undefined
      )?.pending === null,
  );
  const controlPlaneSessionId = required(
    sale?.controlPlaneSessionId,
    "sale control-plane session id",
  );
  const abortedSerialSession = cleanup.find(
    (step) =>
      (step as JsonRecord)?.label === "abort serial session" &&
      (step as JsonRecord)?.ok === true &&
      ((step as JsonRecord)?.detail as JsonRecord | undefined)?.sessionId ===
        controlPlaneSessionId &&
      ((step as JsonRecord)?.detail as JsonRecord | undefined)?.aborted ===
        true,
  );
  const freshAdmission = (sale?.serial as JsonRecord | undefined)?.start as
    | JsonRecord
    | undefined;
  const freshSessionId = (
    freshAdmission?.serialSession as JsonRecord | undefined
  )?.sessionId;
  const hardwareReady =
    (
      (freshAdmission?.hardware as JsonRecord | undefined)?.lower as
        | JsonRecord
        | undefined
    )?.ready === true &&
    (
      (freshAdmission?.hardware as JsonRecord | undefined)?.capability as
        | JsonRecord
        | undefined
    )?.canStartSale === true;
  if (
    sale?.schemaVersion !== "vem-fast-route-stress-sale/v2" ||
    sale?.ok !== true ||
    sale?.runId !== runId ||
    sale?.handoffSerialSessionId !== controlPlaneSessionId ||
    freshSessionId !== controlPlaneSessionId ||
    controlPlaneSessionId === handoff.replacementControlPlaneSessionId ||
    !hardwareReady ||
    !reopenedPaymentGate ||
    !verifiedPaymentGate ||
    !abortedSerialSession
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
    gateCleanup: {
      paymentGateOpen: true,
      paymentGateVerified: true,
      serialSessionInactive: true,
      serialSessionId: controlPlaneSessionId,
      freshControlPlaneSessionId: controlPlaneSessionId,
      lowerControllerReady: true,
      saleStartReady: true,
    },
  };
}

export function validateStockMaintenanceReport(
  report: JsonRecord | null | undefined,
): JsonRecord {
  const fixture = report?.fixture as JsonRecord | undefined;
  const movementCursor = report?.movementCursor as JsonRecord | undefined;
  const firstSale = report?.firstSale as JsonRecord | undefined;
  const secondSale = report?.secondSale as JsonRecord | undefined;
  const unavailable = report?.unavailable as JsonRecord | undefined;
  const maintenance = report?.maintenance as JsonRecord | undefined;
  const restored = report?.restored as JsonRecord | undefined;
  const terminal = report?.terminal as JsonRecord | undefined;
  const screenshots = report?.screenshots as JsonRecord | undefined;
  const movements = terminal?.movements as JsonRecord | undefined;
  const projection = maintenance?.projection as JsonRecord | undefined;
  const platformMovement = maintenance?.platformMovement as
    | JsonRecord
    | undefined;
  const salePlatformMovements = (movements?.salePlatformMovements ??
    []) as unknown[];
  const movementCursorBaselineItemIds = (movementCursor?.baselineItemIds ??
    []) as unknown[];
  const runId = report?.runId;
  const firstOrderId = firstSale?.orderId;
  const secondOrderId = secondSale?.orderId;
  const stock = (value: JsonRecord | null | undefined, quantity: number) =>
    value?.physicalStock === quantity && value?.saleableStock === quantity;
  const visibleStock = (
    value: JsonRecord | null | undefined,
    quantity: number,
  ) =>
    value?.catalogKey === fixture?.catalogKey &&
    value?.saleableStock === quantity &&
    typeof value?.text === "string" &&
    value.text.includes(String(quantity));
  const validSale = (sale: JsonRecord | null | undefined) =>
    (() => {
      if (!sale) return false;
      const gateCleanup = sale.gateCleanup as JsonRecord | undefined;
      const handoff = sale.handoff as JsonRecord | undefined;
      return (
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
        gateCleanup?.paymentGateOpen === true &&
        gateCleanup?.paymentGateVerified === true &&
        gateCleanup?.serialSessionInactive === true &&
        gateCleanup?.serialSessionId === sale?.controlPlaneSessionId &&
        gateCleanup?.freshControlPlaneSessionId ===
          sale?.controlPlaneSessionId &&
        gateCleanup?.lowerControllerReady === true &&
        gateCleanup?.saleStartReady === true &&
        typeof handoff?.previousControlPlaneSessionId === "string" &&
        handoff.previousControlPlaneSessionId !== "" &&
        typeof handoff?.replacementControlPlaneSessionId === "string" &&
        handoff.replacementControlPlaneSessionId !== "" &&
        handoff.replacementControlPlaneSessionId !== sale.controlPlaneSessionId
      );
    })();
  const firstSaleValue = firstSale as JsonRecord | undefined;
  const secondSaleValue = secondSale as JsonRecord | undefined;
  if (
    report?.schemaVersion !== SCHEMA_VERSION ||
    report?.ok !== true ||
    typeof runId !== "string" ||
    typeof report?.handoffSerialSessionId !== "string" ||
    report.handoffSerialSessionId === "" ||
    fixture?.initialQuantity !== 1 ||
    typeof fixture?.slotDisplayLabel !== "string" ||
    typeof fixture?.sku !== "string" ||
    typeof fixture?.slotId !== "string" ||
    typeof fixture?.inventoryId !== "string" ||
    typeof fixture?.catalogKey !== "string" ||
    movementCursor?.inventoryId !== fixture.inventoryId ||
    !Number.isFinite(Date.parse(String(movementCursor?.capturedAt ?? ""))) ||
    !Array.isArray(movementCursor?.baselineItemIds) ||
    new Set(movementCursorBaselineItemIds).size !==
      movementCursorBaselineItemIds.length ||
    !validSale(firstSale) ||
    !validSale(secondSale) ||
    firstOrderId === secondOrderId ||
    firstSaleValue?.controlPlaneSessionId ===
      secondSaleValue?.controlPlaneSessionId ||
    firstSaleValue?.serialSessionId === secondSaleValue?.serialSessionId ||
    firstSaleValue?.paymentId === secondSaleValue?.paymentId ||
    firstSaleValue?.commandId === secondSaleValue?.commandId ||
    firstSaleValue?.fulfillmentMovementId ===
      secondSaleValue?.fulfillmentMovementId ||
    !stock(unavailable?.daemon as JsonRecord | undefined, 0) ||
    (unavailable?.platform as JsonRecord | undefined)?.onHandQty !== 0 ||
    maintenance?.addition !== 2 ||
    maintenance?.previewQuantity !== 2 ||
    maintenance?.refillMovementCount !== 1 ||
    projection?.taskStatus !== "complete" ||
    projection?.slotSyncStatus !== "accepted" ||
    projection?.movementId !==
      `${String(maintenance?.taskId)}:${String(fixture?.slotId)}` ||
    projection?.movementType !== "planned_refill" ||
    projection?.source !== "local_maintenance" ||
    projection?.attributedTo !== "local_operations" ||
    typeof projection?.platformRawMovementId !== "string" ||
    projection?.platformRawMovementId === "" ||
    platformMovement?.inventoryId !== fixture.inventoryId ||
    platformMovement?.reason !== "hardware_sync" ||
    platformMovement?.deltaQty !== 2 ||
    typeof platformMovement?.id !== "string" ||
    platformMovement?.taskId !== maintenance?.taskId ||
    platformMovement?.note !==
      `machine_stock_movement:${String(projection?.platformRawMovementId)}` ||
    !stock(restored?.daemon as JsonRecord | undefined, 2) ||
    (restored?.platform as JsonRecord | undefined)?.onHandQty !== 2 ||
    !visibleStock(restored?.visibleDetailStock as JsonRecord | undefined, 2) ||
    !stock(terminal?.daemon as JsonRecord | undefined, 1) ||
    (terminal?.platform as JsonRecord | undefined)?.onHandQty !== 1 ||
    !visibleStock(terminal?.visibleDetailStock as JsonRecord | undefined, 1) ||
    !Array.isArray(movements?.saleDecrementOrderIds) ||
    new Set(movements.saleDecrementOrderIds as unknown[]).size !== 2 ||
    !(movements.saleDecrementOrderIds as unknown[]).includes(firstOrderId) ||
    !(movements.saleDecrementOrderIds as unknown[]).includes(secondOrderId) ||
    !Array.isArray(movements?.salePlatformMovementIds) ||
    (movements.salePlatformMovementIds as unknown[]).length !== 2 ||
    new Set(movements.salePlatformMovementIds as unknown[]).size !== 2 ||
    (movements.salePlatformMovementIds as unknown[]).some(
      (movementId) => typeof movementId !== "string" || movementId === "",
    ) ||
    !Array.isArray(salePlatformMovements) ||
    salePlatformMovements.length !== 2 ||
    salePlatformMovements.some(
      (movement) =>
        typeof (movement as JsonRecord)?.id !== "string" ||
        String((movement as JsonRecord)?.id ?? "") === "" ||
        typeof (movement as JsonRecord)?.orderId !== "string" ||
        String((movement as JsonRecord)?.orderId ?? "") === "",
    ) ||
    !salePlatformMovements.some(
      (movement) => (movement as JsonRecord).orderId === firstOrderId,
    ) ||
    !salePlatformMovements.some(
      (movement) => (movement as JsonRecord).orderId === secondOrderId,
    ) ||
    new Set(
      salePlatformMovements.map((movement) => (movement as JsonRecord).orderId),
    ).size !== 2 ||
    new Set([
      platformMovement?.id,
      ...salePlatformMovements.map((movement) => (movement as JsonRecord).id),
    ]).size !== 3 ||
    [
      platformMovement?.id,
      ...salePlatformMovements.map((movement) => (movement as JsonRecord).id),
    ].some((movementId) =>
      movementCursorBaselineItemIds.includes(movementId),
    ) ||
    salePlatformMovements.some(
      (movement) =>
        !(
          movements?.salePlatformMovementIds as unknown[] | undefined
        )?.includes((movement as JsonRecord).id),
    ) ||
    JSON.stringify(movements?.refillDeltas) !== JSON.stringify([2]) ||
    (screenshots?.unavailable as JsonRecord | undefined)?.route !==
      "#/maintenance?source=operator" ||
    (screenshots?.refillConfirmed as JsonRecord | undefined)?.route !==
      "#/maintenance?source=operator" ||
    (screenshots?.restoredSaleability as JsonRecord | undefined)?.route !==
      "#/catalog" ||
    !["unavailable", "refillConfirmed", "restoredSaleability"].every(
      (key) =>
        typeof (screenshots?.[key] as JsonRecord | undefined)?.ref ===
          "string" &&
        (screenshots?.[key] as JsonRecord | undefined)?.slotId ===
          fixture?.slotId,
    )
  ) {
    throw new Error(
      "stock maintenance report is missing the 1-to-0-to-2-to-1 evidence with an accepted task projection",
    );
  }
  return {
    slotDisplayLabel: fixture.slotDisplayLabel,
    firstOrderId,
    secondOrderId,
  };
}

export async function runStockMaintenanceGuest(options: {
  mode: string;
  guestInputPath: string;
  handoffPath: string;
  outPath: string;
  fixtureKey: string;
}): Promise<JsonRecord> {
  const input = readJson(options.guestInputPath);
  let handoff = readJson(options.handoffPath);
  const fixture = (input.fixtureAllocation as JsonRecord | undefined)?.[
    options.fixtureKey
  ] as JsonRecord | undefined;
  const report: JsonRecord = {
    schemaVersion: SCHEMA_VERSION,
    ok: false,
    runId: required(input.runId, "runId"),
    handoffSerialSessionId: null,
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
  let client: InstanceType<typeof CdpClient> | null = null;
  try {
    const initialView = (await daemon(
      handoff,
      "/v1/sale-view",
    )) as JsonRecord | null;
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
      (await inventoryMovements(
        input,
        token,
        String(identity.inventoryId),
      )) as JsonRecord | null,
      String(identity.inventoryId),
    );
    const firstHandoff = await replaceSaleHandoff(input, handoff, options);
    report.handoffSerialSessionId =
      firstHandoff.replacementControlPlaneSessionId;
    handoff = readJson(options.handoffPath);
    client = await connectUi(handoff);
    await returnCustomerResultToCatalog(client);
    await primeCatalogTouchSession(client);
    await client.close();
    client = null;
    await openPaymentCreateGate(input);
    const firstReportPath = join(
      dirname(localPath(options.outPath)),
      "stock-maintenance-first-sale.json",
    );
    const first = await runSale(options, firstReportPath);
    report.firstSale = saleEvidence(first, String(report.runId), firstHandoff);
    const unavailableView = await waitFor(
      "fixture depletion after first installed sale",
      () => daemon(handoff, "/v1/sale-view"),
      (view) =>
        stockFact(view as JsonRecord, identity).physicalStock === 0 &&
        stockFact(view as JsonRecord, identity).saleableStock === 0,
    );
    const unavailablePlatform = await waitFor(
      "platform depletion after first installed sale",
      () => inventory(input, token, String(identity.inventoryId)),
      (value) =>
        (value as JsonRecord)?.onHandQty === 0 &&
        (value as JsonRecord)?.reservedQty === 0,
    );
    report.unavailable = {
      daemon: stockFact(unavailableView as JsonRecord, identity),
      platform: unavailablePlatform,
    };
    client = await connectUi(handoff);
    await returnCustomerResultToCatalog(client);
    await openStockMaintenance(client);
    const sink = screenshotSink(options.outPath);
    (report.screenshots as JsonRecord).unavailable =
      await captureStockScreenshot(
        client,
        sink,
        "unavailable",
        "#/maintenance?source=operator",
        identity,
      );
    const refillTask = await waitFor(
      "routine refill task before submit",
      () => daemon(handoff, "/v1/stock/maintenance-task"),
      (task) => {
        const taskRecord = task as JsonRecord;
        const slots = (taskRecord?.slots ?? []) as unknown[];
        return (
          taskRecord?.mode === "routine_refill" &&
          typeof taskRecord?.taskId === "string" &&
          taskRecord.taskId !== "" &&
          slots.some(
            (slot) =>
              (slot as JsonRecord)?.slotId === identity.slotId &&
              (slot as JsonRecord)?.currentQuantity === 0 &&
              (slot as JsonRecord)?.syncStatus === "not_submitted",
          )
        );
      },
    );
    await enterRoutineRefill(client, identity);
    (report.screenshots as JsonRecord).refillConfirmed =
      await captureStockScreenshot(
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
        stockFact(view as JsonRecord, identity).physicalStock === 2 &&
        stockFact(view as JsonRecord, identity).saleableStock === 2,
    );
    const restoredPlatform = await waitFor(
      "platform refill synchronization",
      () => inventory(input, token, String(identity.inventoryId)),
      (value) =>
        (value as JsonRecord)?.onHandQty === 2 &&
        (value as JsonRecord)?.reservedQty === 0,
    );
    const completedTask = await waitFor(
      "accepted routine refill task projection",
      () =>
        daemon(
          handoff,
          `/v1/stock/maintenance-tasks/${encodeURIComponent(String((refillTask as JsonRecord).taskId))}/projection`,
        ),
      (task) => {
        const taskRecord = task as JsonRecord;
        const refillTaskRecord = refillTask as JsonRecord;
        const slots = (taskRecord?.slots ?? []) as unknown[];
        return (
          taskRecord?.taskId === refillTaskRecord.taskId &&
          taskRecord?.mode === "routine_refill" &&
          taskRecord?.status === "complete" &&
          slots.some(
            (slot) =>
              (slot as JsonRecord)?.slotId === identity.slotId &&
              (slot as JsonRecord)?.submittedAddition === 2 &&
              (slot as JsonRecord)?.previewQuantity === 2 &&
              (slot as JsonRecord)?.movementId ===
                `${String(refillTaskRecord.taskId)}:${String(identity.slotId)}` &&
              (slot as JsonRecord)?.movementType === "planned_refill" &&
              (slot as JsonRecord)?.source === "local_maintenance" &&
              (slot as JsonRecord)?.attributedTo === "local_operations" &&
              typeof (slot as JsonRecord)?.platformRawMovementId === "string" &&
              String((slot as JsonRecord)?.platformRawMovementId ?? "") !==
                "" &&
              (slot as JsonRecord)?.syncStatus === "accepted",
          )
        );
      },
    );
    const completedTaskRecord = completedTask as JsonRecord;
    const completedSlots = (completedTaskRecord.slots ?? []) as unknown[];
    const completedSlot = completedSlots.find(
      (slot) => (slot as JsonRecord).slotId === identity.slotId,
    ) as JsonRecord | undefined;
    const completedSlotRecord = completedSlot as JsonRecord | undefined;
    const refillTaskRecord = refillTask as JsonRecord;
    report.maintenance = {
      taskId: refillTaskRecord.taskId,
      addition: completedSlotRecord?.submittedAddition,
      previewQuantity: completedSlotRecord?.previewQuantity,
      refillMovementCount: null,
      projection: {
        taskStatus: completedTaskRecord.status,
        slotSyncStatus: completedSlotRecord?.syncStatus,
        movementId: completedSlotRecord?.movementId,
        movementType: completedSlotRecord?.movementType,
        source: completedSlotRecord?.source,
        attributedTo: completedSlotRecord?.attributedTo,
        platformRawMovementId: completedSlotRecord?.platformRawMovementId,
      },
      platformMovement: null,
    };
    const afterRefillMovements = await waitFor(
      "one correlated platform refill movement",
      () => inventoryMovements(input, token, String(identity.inventoryId)),
      (page) =>
        movementDelta(
          page as JsonRecord,
          report.movementCursor as JsonRecord,
        ).filter(
          (movement) =>
            (movement as JsonRecord)?.reason === "hardware_sync" &&
            (movement as JsonRecord)?.deltaQty === 2 &&
            (movement as JsonRecord)?.inventoryId === identity.inventoryId &&
            (movement as JsonRecord)?.note ===
              `machine_stock_movement:${String(
                completedSlotRecord?.platformRawMovementId,
              )}`,
        ).length === 1,
    );
    const refillMovements = movementDelta(
      afterRefillMovements as JsonRecord,
      report.movementCursor as JsonRecord,
    ).filter(
      (movement) =>
        (movement as JsonRecord)?.reason === "hardware_sync" &&
        (movement as JsonRecord)?.deltaQty === 2 &&
        (movement as JsonRecord)?.inventoryId === identity.inventoryId &&
        (movement as JsonRecord)?.note ===
          `machine_stock_movement:${String(
            completedSlotRecord?.platformRawMovementId,
          )}`,
    );
    (report.maintenance as JsonRecord).refillMovementCount =
      refillMovements.length;
    (report.maintenance as JsonRecord).platformMovement = {
      ...(refillMovements[0] as JsonRecord),
      taskId: refillTaskRecord.taskId,
    };
    report.restored = {
      daemon: stockFact(restoredView as JsonRecord, identity),
      platform: restoredPlatform,
    };
    await returnToCatalogFromMaintenance(client);
    (report.restored as JsonRecord).visibleDetailStock =
      await observeProductDetailStock(client, identity, 2);
    (report.screenshots as JsonRecord).restoredSaleability =
      await captureStockScreenshot(
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
    report.handoffSerialSessionId =
      secondHandoff.replacementControlPlaneSessionId;
    handoff = readJson(options.handoffPath);
    client = await connectUi(handoff);
    await primeCatalogTouchSession(client);
    await client.close();
    client = null;
    await openPaymentCreateGate(input);
    const second = await runSale(options, secondReportPath);
    report.secondSale = saleEvidence(
      second,
      String(report.runId),
      secondHandoff,
    );
    const terminalView = await waitFor(
      "fixture terminal quantity after second installed sale",
      () => daemon(handoff, "/v1/sale-view"),
      (view) =>
        stockFact(view as JsonRecord, identity).physicalStock === 1 &&
        stockFact(view as JsonRecord, identity).saleableStock === 1,
    );
    const terminalPlatform = await waitFor(
      "platform terminal quantity after second installed sale",
      () => inventory(input, token, String(identity.inventoryId)),
      (value) =>
        (value as JsonRecord)?.onHandQty === 1 &&
        (value as JsonRecord)?.reservedQty === 0,
    );
    client = await connectUi(handoff);
    await returnCustomerResultToCatalog(client);
    const terminalVisibleDetailStock = await observeProductDetailStock(
      client,
      identity,
      1,
    );
    await client.close();
    client = null;
    const terminalMovements = await waitFor(
      "two correlated sale decrements",
      () => inventoryMovements(input, token, String(identity.inventoryId)),
      (page) => {
        const ids = movementDelta(
          page as JsonRecord,
          report.movementCursor as JsonRecord,
        )
          .filter(
            (movement) =>
              (movement as JsonRecord)?.reason === "purchase_confirmed" &&
              (movement as JsonRecord)?.deltaQty === -1,
          )
          .map((movement) => (movement as JsonRecord).orderId);
        return (
          ids.includes((report.firstSale as JsonRecord).orderId) &&
          ids.includes((report.secondSale as JsonRecord).orderId)
        );
      },
    );
    const salePlatformMovements = movementDelta(
      terminalMovements as JsonRecord,
      report.movementCursor as JsonRecord,
    )
      .filter(
        (movement) =>
          (movement as JsonRecord)?.reason === "purchase_confirmed" &&
          (movement as JsonRecord)?.deltaQty === -1 &&
          [
            (report.firstSale as JsonRecord).orderId,
            (report.secondSale as JsonRecord).orderId,
          ].includes((movement as JsonRecord)?.orderId),
      )
      .map((movement) => {
        const movementRecord = movement as JsonRecord;
        return { id: movementRecord.id, orderId: movementRecord.orderId };
      });
    report.terminal = {
      daemon: stockFact(terminalView as JsonRecord, identity),
      platform: terminalPlatform,
      visibleDetailStock: terminalVisibleDetailStock,
      movements: {
        saleDecrementOrderIds: salePlatformMovements.map(
          (movement) => movement.orderId,
        ),
        salePlatformMovementIds: salePlatformMovements.map(
          (movement) => movement.id,
        ),
        salePlatformMovements,
        refillDeltas: movementDelta(
          terminalMovements as JsonRecord,
          report.movementCursor as JsonRecord,
        )
          .filter(
            (movement) => (movement as JsonRecord)?.reason === "hardware_sync",
          )
          .map((movement) => (movement as JsonRecord).deltaQty),
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
