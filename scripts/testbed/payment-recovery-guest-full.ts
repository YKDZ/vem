#!/usr/bin/env node

import { topCategoryKeyForCatalogItem } from "@vem/shared/catalog-top-category";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  CdpClient,
  activateVisibleSelector,
  discoverMachineUiTarget,
  enablePageRuntime,
  evaluateExpression,
  rewriteWebSocketDebuggerUrl,
  waitForRoute,
} from "./machine-ui-cdp-driver.ts";

const SCHEMA_VERSION = "vem-payment-recovery-guest-full/v1";
const REQUIRED_RECOVERY_ATTEMPT_KINDS = Object.freeze([
  "create_failure",
  "query_failure",
  "canceled",
  "expired",
]);

type JsonRecord = Record<string, unknown>;
type InputRecord = JsonRecord;
type HandoffRecord = JsonRecord;

function required(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${label} is required`);
  return value.trim();
}
function option(args: string[], name: string): string {
  const i = args.indexOf(`--${name}`);
  const value = i < 0 ? undefined : args[i + 1];
  return required(value, `--${name}`);
}
function localPath(value: unknown): string {
  const path = required(value, "Windows path");
  return process.platform === "win32"
    ? path
    : resolve(
        `/mnt/${path[0].toLowerCase()}/${path.slice(3).replaceAll("\\", "/")}`,
      );
}
export function parsePaymentRecoveryGuestArgs(args: string[]): {
  mode: "full";
  guestInputPath: string;
  handoffPath: string;
  outPath: string;
  fixtureKey: string | null;
} {
  if (option(args, "mode") !== "full") throw new Error("--mode must be full");
  return {
    mode: "full",
    guestInputPath: option(args, "guest-input"),
    handoffPath: option(args, "handoff"),
    outPath: option(args, "out"),
    fixtureKey: args.includes("--fixture-key")
      ? option(args, "fixture-key")
      : null,
  };
}
function readJson(path: string): JsonRecord {
  return JSON.parse(readFileSync(localPath(path), "utf8"));
}
function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(localPath(path)), { recursive: true });
  writeFileSync(localPath(path), `${JSON.stringify(value, null, 2)}\n`);
}
async function json(url: string, options: JsonRecord = {}): Promise<unknown> {
  const response = await fetch(url, {
    ...options,
    signal:
      (options.signal as AbortSignal | undefined) ??
      AbortSignal.timeout(30_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(
      `${options.method ?? "GET"} ${url} failed: ${JSON.stringify(payload)}`,
    );
    (error as Error & { httpStatus?: number; payload?: unknown }).httpStatus =
      response.status;
    (error as Error & { httpStatus?: number; payload?: unknown }).payload =
      payload;
    throw error;
  }
  return payload;
}
function daemonUrl(handoff: HandoffRecord): string {
  const daemon = handoff.daemon as JsonRecord | undefined;
  const ready = daemon?.ready as JsonRecord | undefined;
  const url = required(ready?.healthzUrl, "daemon healthzUrl");
  if (!url.endsWith("/healthz"))
    throw new Error("daemon healthzUrl must end with /healthz");
  return url.slice(0, -"/healthz".length);
}
function daemonHeaders(handoff: HandoffRecord): JsonRecord {
  const daemon = handoff.daemon as JsonRecord | undefined;
  const ready = daemon?.ready as JsonRecord | undefined;
  return {
    authorization: `Bearer ${required(ready?.ipcToken, "daemon ipcToken")}`,
    "content-type": "application/json",
  };
}
function daemon(
  handoff: HandoffRecord,
  path: string,
  body?: unknown,
  { timeoutMs = 30_000 }: { timeoutMs?: number } = {},
): Promise<unknown> {
  return json(`${daemonUrl(handoff)}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: daemonHeaders(handoff),
    signal: AbortSignal.timeout(timeoutMs),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function control(
  input: InputRecord,
  path: string,
  body: JsonRecord = {},
): Promise<unknown> {
  const hostControlPlane = input.hostControlPlane as JsonRecord | undefined;
  return json(
    `${required(hostControlPlane?.endpoint, "hostControlPlane.endpoint")}${path}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${required(hostControlPlane?.token, "hostControlPlane.token")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
}
function apiBase(input: InputRecord): string {
  const bootstrap = input.runtimeBootstrap as JsonRecord | undefined;
  return required(
    bootstrap?.provisioningApiBaseUrl,
    "runtimeBootstrap.provisioningApiBaseUrl",
  ).replace(/\/+$/, "");
}
function api(
  input: InputRecord,
  path: string,
  options: JsonRecord = {},
): Promise<unknown> {
  return json(`${apiBase(input)}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.token
        ? { authorization: `Bearer ${String(options.token)}` }
        : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
}
export function unwrapServiceApiEnvelope(payload: unknown): unknown {
  if (
    payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    (payload as JsonRecord).code === 0 &&
    Object.hasOwn(payload, "data")
  ) {
    return (payload as JsonRecord).data;
  }
  return payload;
}
export async function refreshAdminAccessToken(
  input: InputRecord,
  login: (
    input: InputRecord,
    path: string,
    options: JsonRecord,
  ) => Promise<unknown> = api,
): Promise<string> {
  const serviceApi = input.serviceApi as JsonRecord | undefined;
  const result = unwrapServiceApiEnvelope(
    await login(input, "/auth/login", {
      method: "POST",
      body: {
        username: required(
          serviceApi?.adminUsername ?? "local-testbed-admin",
          "serviceApi.adminUsername",
        ),
        password: required(
          serviceApi?.adminPassword ?? "LocalTestbedAdminPassword!",
          "serviceApi.adminPassword",
        ),
      },
    }),
  );
  return required(
    (result as JsonRecord | undefined)?.accessToken,
    "auth.login.accessToken",
  );
}
export async function waitForMachineOnline(
  input: InputRecord,
  machineCode: string,
  token: string,
  {
    timeoutMs = 15_000,
    pollIntervalMs = 250,
    now = () => Date.now(),
    wait = (milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
    query = api,
  } = {},
) {
  const code = required(machineCode, "machineCode");
  const deadline = now() + timeoutMs;
  let lastStatus: unknown = null;
  do {
    const page = unwrapServiceApiEnvelope(
      await query(input, "/machines?page=1&pageSize=100", {
        method: "GET",
        token: required(token, "admin access token"),
      }),
    );
    const pageRecord = page as JsonRecord | null;
    const items = (pageRecord?.items ?? []) as unknown[];
    const machine = items.find((entry) => (entry as JsonRecord)?.code === code);
    if (!machine) throw new Error(`Service API machine ${code} was not found`);
    lastStatus = (machine as JsonRecord).status;
    if (lastStatus === "online") return machine;
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await wait(Math.min(pollIntervalMs, remaining));
  } while (now() < deadline);
  throw new Error(
    `Service API machine ${code} did not become online (last status: ${lastStatus ?? "unknown"})`,
  );
}
export function selectFixtureSlot(
  saleView: JsonRecord | null | undefined,
  fixture: JsonRecord | null | undefined,
): JsonRecord {
  const slotId = required(fixture?.slotId, "fixture.slotId");
  const saleViewRecord = saleView as JsonRecord | null;
  const items = (saleViewRecord?.items ?? []) as unknown[];
  const item = items.find((entry) => (entry as JsonRecord)?.slotId === slotId);
  const itemRecord = item as JsonRecord | undefined;
  if (!itemRecord?.inventoryId || saleViewRecord?.planogramVersion == null)
    throw new Error(
      `fixture slot ${slotId} is not saleable in daemon sale-view`,
    );
  const actualCategoryKey = topCategoryKeyForCatalogItem({
    categoryName: String(itemRecord?.categoryName ?? ""),
    productName: String(itemRecord?.productName ?? ""),
  });
  const categoryKey =
    typeof fixture?.categoryKey === "string" &&
    fixture.categoryKey.trim() !== ""
      ? fixture.categoryKey.trim()
      : actualCategoryKey;
  if (actualCategoryKey !== categoryKey) {
    throw new Error(
      `fixture slot ${slotId} category ${categoryKey} does not match Machine Catalog category ${actualCategoryKey ?? "other"}`,
    );
  }
  return {
    slotId,
    categoryKey,
    inventoryId: itemRecord.inventoryId,
    planogramVersion: saleViewRecord.planogramVersion,
  };
}
export function buildCreateOrderRequest(
  slot: JsonRecord | null | undefined,
): JsonRecord {
  return {
    inventoryId: required(slot?.inventoryId, "slot.inventoryId"),
    quantity: 1,
    planogramVersion: required(slot?.planogramVersion, "slot.planogramVersion"),
    slotId: required(slot?.slotId, "slot.slotId"),
    paymentMethod: "mock",
    paymentProviderCode: "mock",
  };
}
export function mqttEvidenceProvesNoDispense(
  evidence: JsonRecord | null | undefined,
): boolean {
  const mqtt = evidence?.mqtt as JsonRecord | undefined;
  return (
    String(mqtt?.topic ?? "").endsWith("/commands/dispense") === true &&
    Array.isArray(mqtt?.messages) &&
    (mqtt?.messages as unknown[]).length === 0
  );
}

export function runtimeTraceTechnicalMessage(
  entry: JsonRecord | null | undefined,
): string | null {
  const legacy = entry?.technicalMessage;
  if (typeof legacy === "string" && legacy !== "") return legacy;
  const technical = entry?.technical as JsonRecord | undefined;
  const nested = technical?.message;
  return typeof nested === "string" && nested !== "" ? nested : null;
}

function daemonTransactionBelongsToAttempt(
  transaction: JsonRecord | null | undefined,
  attempt: JsonRecord,
): boolean {
  if (transaction == null) return false;
  const order = attempt.order as JsonRecord | undefined;
  const payment = attempt.payment as JsonRecord | undefined;
  return (
    transaction.orderId === order?.id || transaction.paymentId === payment?.id
  );
}

function semanticBackendApiError(message: unknown): boolean {
  return (
    typeof message === "string" &&
    /^BACKEND_API_ERROR:\s+[45]\d{2}(?:\s|$)/.test(message) &&
    !message.includes("mock payment create gate timed out before release")
  );
}

export function validatePaymentRecoveryEvidence(
  report: JsonRecord,
): JsonRecord {
  if (report?.schemaVersion !== SCHEMA_VERSION || report.ok !== true) {
    throw new Error("payment recovery report is not successful");
  }
  if (
    typeof report.handoffSerialSessionId !== "string" ||
    report.handoffSerialSessionId === ""
  ) {
    throw new Error(
      "payment recovery report did not publish its handoff serial session",
    );
  }
  const reportPayment = report.payment as JsonRecord | undefined;
  const reportAssertions = report.assertions as JsonRecord | undefined;
  if (!reportPayment?.id || reportAssertions?.duplicatePaymentCount !== 0) {
    throw new Error("payment recovery allowed a duplicate payment");
  }
  if (
    !mqttEvidenceProvesNoDispense(
      report.recoveryMqttEvidence as JsonRecord | null | undefined,
    )
  ) {
    throw new Error("payment recovery MQTT evidence includes a dispense");
  }
  const attempts = (
    Array.isArray(report.attempts) ? report.attempts : []
  ) as unknown[];
  for (const kind of REQUIRED_RECOVERY_ATTEMPT_KINDS) {
    const attempt = attempts.find(
      (candidate) => (candidate as JsonRecord)?.kind === kind,
    ) as JsonRecord | undefined;
    const reservation = attempt?.reservation as JsonRecord | undefined;
    const baseline = reservation?.baseline as JsonRecord | undefined;
    const active = reservation?.active as JsonRecord | undefined;
    const terminal = reservation?.terminal as JsonRecord | undefined;
    const order = attempt?.order as JsonRecord | undefined;
    const payment = attempt?.payment as JsonRecord | undefined;
    const expectedTerminal = attempt?.expectedTerminal as
      | JsonRecord
      | undefined;
    const terminalState = attempt?.terminal as JsonRecord | undefined;
    const assertions = attempt?.assertions as JsonRecord | undefined;
    const createGate = attempt?.createGate as JsonRecord | undefined;
    const technicalEvidence = attempt?.technicalEvidence as
      | JsonRecord
      | undefined;
    const providerCreate = technicalEvidence?.providerCreate as
      | JsonRecord
      | undefined;
    const runtimeTrace = technicalEvidence?.runtimeTrace as
      | JsonRecord
      | undefined;
    const daemonState = attempt?.daemon as JsonRecord | undefined;
    const customer = attempt?.customer as JsonRecord | undefined;
    const recovery = attempt?.recovery as JsonRecord | undefined;
    const expiryInjection = attempt?.expiryInjection as JsonRecord | undefined;
    const activeRow = active?.row as JsonRecord | undefined;
    const terminalRow = terminal?.row as JsonRecord | undefined;
    if (
      !attempt ||
      !order?.id ||
      order.paymentId !== payment?.id ||
      !expectedTerminal ||
      typeof expectedTerminal.customerCopy !== "string" ||
      terminalState?.paymentStatus !== expectedTerminal.paymentStatus ||
      terminalState?.orderStatus !== expectedTerminal.orderStatus ||
      terminalState?.paymentState !== expectedTerminal.paymentState ||
      !baseline ||
      !active ||
      !terminal ||
      !reservation ||
      active.activeRows !== (baseline.activeRows as number) + 1 ||
      terminal.activeRows !== baseline.activeRows ||
      active.onHandQty !== baseline.onHandQty ||
      terminal.onHandQty !== baseline.onHandQty ||
      active.reservedQty !==
        (baseline.reservedQty as number) + Number(reservation.quantity) ||
      terminal.reservedQty !== baseline.reservedQty ||
      active.orderReservationRows !== 1 ||
      terminal.orderReservationRows !== 1 ||
      activeRow?.status !== "active" ||
      terminalRow?.id !== activeRow?.id ||
      terminalRow?.status !== "released" ||
      assertions?.duplicatePaymentCount !== 0
    )
      throw new Error(
        `payment recovery ${kind} did not return to reservation baseline`,
      );
    if (kind === "create_failure") {
      if (
        createGate?.source !== "mock_provider_create_gate" ||
        createGate?.paymentNo !== payment?.paymentNo ||
        createGate?.released !== false ||
        createGate?.openedAfterFailure !== true ||
        !String(createGate?.error ?? "").includes(
          "mock payment create gate timed out before release",
        ) ||
        providerCreate?.source !== "mock_provider_create_gate" ||
        providerCreate?.paymentNo !== payment?.paymentNo ||
        !String(providerCreate?.error ?? "").includes(
          "mock payment create gate timed out before release",
        ) ||
        daemonState?.active !== null ||
        daemonTransactionBelongsToAttempt(
          daemonState?.terminal as JsonRecord | undefined,
          attempt,
        ) ||
        customer?.source !== "installed_machine_runtime_cdp" ||
        customer?.checkoutAttemptIdempotencyKey !== attempt.idempotencyKey ||
        customer?.stage !== "payment_creation" ||
        typeof customer?.text !== "string" ||
        !String(customer.text).includes(
          String(expectedTerminal.customerCopy),
        ) ||
        /(?:provider|HTTP|MQTT|IPC|COM\d|schema|query_failed)/i.test(
          String(customer.text),
        ) ||
        runtimeTrace?.source !== "installed_machine_runtime_trace_cdp" ||
        runtimeTrace?.checkoutAttemptIdempotencyKey !==
          attempt.idempotencyKey ||
        !Number.isFinite((runtimeTrace?.entry as JsonRecord | undefined)?.id) ||
        !semanticBackendApiError(
          runtimeTraceTechnicalMessage(
            runtimeTrace?.entry as JsonRecord | undefined,
          ),
        )
      ) {
        throw new Error(
          "payment recovery create failure did not prove installed customer copy and durable technical evidence",
        );
      }
      continue;
    }
    if (
      (daemonState?.active as JsonRecord | undefined)?.orderId !== order.id ||
      (daemonState?.active as JsonRecord | undefined)?.paymentId !==
        payment?.id ||
      (daemonState?.terminal as JsonRecord | undefined)?.orderId !== order.id ||
      (daemonState?.terminal as JsonRecord | undefined)?.paymentId !==
        payment?.id ||
      (daemonState?.terminal as JsonRecord | undefined)?.paymentStatus !==
        expectedTerminal?.paymentStatus
    ) {
      throw new Error(
        `payment recovery ${kind} daemon terminal state is incomplete`,
      );
    }
    if (
      customer?.source !== "installed_machine_runtime_cdp" ||
      typeof customer?.text !== "string" ||
      !/[\u3400-\u9fff]/.test(String(customer.text)) ||
      !String(customer.text).includes(String(expectedTerminal?.customerCopy)) ||
      String(customer.text).includes(String(payment?.paymentNo)) ||
      /(?:provider|HTTP|MQTT|IPC|COM\d|schema|query_failed)/i.test(
        String(customer.text),
      ) ||
      runtimeTrace?.source !== "installed_machine_runtime_trace_cdp"
    ) {
      throw new Error(
        `payment recovery ${kind} customer surface or correlation is not installed-runtime evidence`,
      );
    }
    if (
      (runtimeTrace?.entry as JsonRecord | undefined) != null &&
      (runtimeTrace?.orderId !== order.id ||
        runtimeTrace?.paymentId !== payment?.id ||
        runtimeTrace?.resultKind !== expectedTerminal?.resultKind ||
        !Number.isFinite((runtimeTrace?.entry as JsonRecord | undefined)?.id))
    ) {
      throw new Error(
        `payment recovery ${kind} runtime trace correlation is invalid`,
      );
    }
    if (
      kind === "query_failure" &&
      ((recovery?.queryFault as JsonRecord | undefined)?.source !==
        "mock_provider_query_fault_boundary" ||
        (recovery?.queryFault as JsonRecord | undefined)?.paymentNo !==
          payment?.paymentNo ||
        (recovery?.reconciliationAttempt as JsonRecord | undefined)
          ?.paymentId !== payment?.id ||
        (recovery?.reconciliationAttempt as JsonRecord | undefined)?.status !==
          "network_error" ||
        (recovery?.reconciliationAttempt as JsonRecord | undefined)
          ?.errorCode !== "query_failed" ||
        (recovery?.closeAction as JsonRecord | undefined)?.action !==
          "close_or_reverse_uncertain_payment")
    ) {
      throw new Error(
        "payment recovery query failure did not use provider recovery",
      );
    }
    if (
      kind === "expired" &&
      (expiryInjection?.source !== "testbed_payment_expiry_time_injection" ||
        !["created", "pending", "processing"].includes(
          String(expiryInjection.beforePaymentStatus),
        ))
    ) {
      throw new Error(
        "payment recovery expiry did not use the production worker",
      );
    }
  }
  const subsequentSale = report.subsequentSale as JsonRecord | undefined;
  const subsequentOrder = subsequentSale?.order as JsonRecord | undefined;
  const subsequentTerminal = subsequentSale?.terminal as JsonRecord | undefined;
  const subsequentInventory = subsequentSale?.inventory as
    | JsonRecord
    | undefined;
  const subsequentCustomer = subsequentSale?.customer as JsonRecord | undefined;
  const subsequentSerial = subsequentSale?.serial as JsonRecord | undefined;
  const reportInventory = report.inventory as JsonRecord | undefined;
  if (
    subsequentOrder?.inventoryId !== reportInventory?.id ||
    subsequentTerminal?.paymentStatus !== "succeeded" ||
    subsequentTerminal?.orderStatus !== "fulfilled" ||
    subsequentTerminal?.fulfillmentState !== "dispensed" ||
    subsequentInventory?.afterOnHandQty !==
      (subsequentInventory?.beforeOnHandQty as number) - 1 ||
    subsequentInventory?.movementCount !== 1 ||
    subsequentCustomer?.route !== "#/result/success" ||
    subsequentCustomer?.orderId !== subsequentOrder?.id ||
    subsequentCustomer?.paymentId !== subsequentOrder?.paymentId ||
    subsequentCustomer?.orderNo !== subsequentOrder?.orderNo ||
    subsequentCustomer?.commandId !== subsequentOrder?.commandId ||
    subsequentCustomer?.resultKind !== "success" ||
    subsequentSerial?.stopped !== true ||
    !["VEND", "F0", "F1", "F2"].every((frame) =>
      String(subsequentSerial?.protocol ?? "").includes(frame),
    )
  )
    throw new Error(
      "payment recovery did not prove the fulfilled subsequent sale",
    );
  const saleabilityRecovery = (report.saleabilityRecovery ?? {}) as JsonRecord;
  const saleableCategories = Array.isArray(saleabilityRecovery.categories)
    ? (saleabilityRecovery.categories as unknown[])
    : [];
  const categoryKeys = new Set(
    saleableCategories
      .map((category) => (category as JsonRecord)?.key)
      .filter(Boolean),
  );
  if (
    saleabilityRecovery.source !==
      "daemon_sale_view_and_installed_machine_runtime_cdp" ||
    saleabilityRecovery.route !== "#/catalog" ||
    categoryKeys.size < 3 ||
    saleableCategories.some(
      (category) =>
        !Number.isInteger((category as JsonRecord)?.daemonSaleableItemCount) ||
        ((category as JsonRecord).daemonSaleableItemCount as number) < 1 ||
        !Number.isInteger((category as JsonRecord)?.saleableProductCount) ||
        ((category as JsonRecord).saleableProductCount as number) < 1,
    )
  ) {
    throw new Error(
      "payment recovery did not prove saleability after failed payment attempts",
    );
  }
  return {
    paymentId: String(reportPayment?.id),
    action: "query_payment",
    duplicatePaymentCount: 0,
    attemptCount: attempts.length,
    saleableCategoryKeys: [...categoryKeys].sort(),
  };
}

function rows(raw: unknown, key: string): unknown[] {
  const record = raw as JsonRecord | null | undefined;
  return Array.isArray(record?.[key]) ? (record?.[key] as unknown[]) : [];
}

function exactlyOne(values: unknown[], message: string): JsonRecord {
  if (values.length !== 1) throw new Error(message);
  return values[0] as JsonRecord;
}

async function waitFor<T>(
  label: string,
  observe: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | null = null;
  do {
    last = await observe();
    if (predicate(last)) return last;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  } while (Date.now() < deadline);
  throw new Error(`${label} did not settle: ${JSON.stringify(last)}`);
}

async function platformReport(
  input: InputRecord,
  runId: string,
  machineCode: string,
  sessionId: string | undefined,
): Promise<JsonRecord> {
  const response = await control(input, "/v1/platform/query", {
    runId,
    machineCode,
    ...(sessionId ? { sessionId } : {}),
  });
  const responseRecord = response as JsonRecord | null;
  const report = responseRecord?.report as JsonRecord | undefined;
  if (!report?.raw) throw new Error("platform query returned no raw rows");
  return report;
}

function inventorySnapshot(
  platform: JsonRecord,
  inventoryId: string,
): JsonRecord {
  return exactlyOne(
    rows(platform.raw, "inventories").filter(
      (row) => (row as JsonRecord).id === inventoryId,
    ),
    `platform inventory ${inventoryId} was not unique`,
  );
}

function activeReservationCount(
  platform: JsonRecord,
  inventoryId: string,
): number {
  return rows(platform.raw, "reservations").filter(
    (row) =>
      (row as JsonRecord).inventoryId === inventoryId &&
      (row as JsonRecord).status === "active",
  ).length;
}

function reservationBaseline(
  platform: JsonRecord,
  inventoryId: string,
): JsonRecord {
  const inventory = inventorySnapshot(platform, inventoryId);
  return {
    onHandQty: inventory.onHandQty,
    reservedQty: inventory.reservedQty,
    activeRows: activeReservationCount(platform, inventoryId),
  };
}

function reservationObservation(
  platform: JsonRecord,
  orderId: string,
  inventoryId: string,
): JsonRecord {
  const inventory = inventorySnapshot(platform, inventoryId);
  const own = rows(platform.raw, "reservations").filter(
    (row) =>
      (row as JsonRecord).orderId === orderId &&
      (row as JsonRecord).inventoryId === inventoryId,
  );
  return {
    onHandQty: inventory.onHandQty,
    reservedQty: inventory.reservedQty,
    activeRows: activeReservationCount(platform, inventoryId),
    orderReservationRows: own.length,
    row: own[0] ?? null,
  };
}

function terminalRows(
  platform: JsonRecord,
  orderId: string,
  paymentId: string,
): JsonRecord {
  return {
    order: exactlyOne(
      rows(platform.raw, "orders").filter(
        (row) => (row as JsonRecord).id === orderId,
      ),
      `platform order ${orderId} was not unique`,
    ),
    payment: exactlyOne(
      rows(platform.raw, "payments").filter(
        (row) => (row as JsonRecord).id === paymentId,
      ),
      `platform payment ${paymentId} was not unique`,
    ),
  };
}

function orderForPaymentNo(
  platform: JsonRecord,
  paymentNo: string,
): JsonRecord {
  const payment = exactlyOne(
    rows(platform.raw, "payments").filter(
      (row) => (row as JsonRecord).paymentNo === paymentNo,
    ),
    `platform payment ${paymentNo} was not unique`,
  );
  const order = exactlyOne(
    rows(platform.raw, "orders").filter(
      (row) => (row as JsonRecord).id === payment.orderId,
    ),
    `platform order for payment ${paymentNo} was not unique`,
  );
  return {
    order: {
      id: order.id,
      orderNo: order.orderNo,
      paymentId: payment.id,
    },
    payment: { id: payment.id, paymentNo: payment.paymentNo },
  };
}

function dispenseMovementsForOrder(
  platform: JsonRecord,
  order: JsonRecord,
  inventoryId: string,
): unknown[] {
  const orderItem = rows(platform.raw, "orderItems").find(
    (item) =>
      (item as JsonRecord).orderId === order.orderId &&
      (item as JsonRecord).inventoryId === inventoryId,
  );
  if (!orderItem) return [];
  return rows(platform.raw, "movements").filter(
    (movement) =>
      (movement as JsonRecord).inventoryId === inventoryId &&
      ((movement as JsonRecord).orderNo === order.orderNo ||
        (movement as JsonRecord).orderItemId === (orderItem as JsonRecord).id),
  );
}

async function waitForDaemonTransaction(
  handoff: HandoffRecord,
  order: JsonRecord,
  expectedStatus: string | null = null,
): Promise<unknown> {
  return await waitFor(
    `daemon transaction ${order.paymentId}`,
    () => daemon(handoff, "/v1/transactions/current"),
    (transaction) =>
      (transaction as JsonRecord)?.orderId === order.orderId &&
      (transaction as JsonRecord)?.paymentId === order.paymentId &&
      (expectedStatus === null ||
        (transaction as JsonRecord)?.paymentStatus === expectedStatus),
  );
}

async function waitForDaemonCleanup(
  handoff: HandoffRecord,
  paymentNo: string,
): Promise<unknown> {
  return await waitFor(
    `daemon create failure cleanup ${paymentNo}`,
    () => daemon(handoff, "/v1/transactions/current"),
    (transaction) => (transaction as JsonRecord)?.paymentNo !== paymentNo,
  );
}

function saleableCategoriesFromDaemon(saleView: JsonRecord | null | undefined) {
  const categories = new Map<string, JsonRecord>();
  const items = ((saleView as JsonRecord | null)?.items ?? []) as unknown[];
  for (const itemValue of items) {
    const item = itemValue as JsonRecord;
    if (typeof item?.inventoryId !== "string" || item.inventoryId === "")
      continue;
    const key = topCategoryKeyForCatalogItem({
      categoryName: String(item.categoryName ?? ""),
      productName: String(item.productName ?? ""),
    });
    if (!key) continue;
    const entry = categories.get(key) ?? { key, daemonSaleableItemCount: 0 };
    entry.daemonSaleableItemCount = Number(entry.daemonSaleableItemCount) + 1;
    categories.set(key, entry);
  }
  return [...categories.values()].sort((left, right) =>
    String(left.key).localeCompare(String(right.key)),
  );
}

export async function observeSaleabilityRecovery({
  client,
  handoff,
}: {
  client: InstanceType<typeof CdpClient>;
  handoff: HandoffRecord;
}): Promise<JsonRecord> {
  const saleView = (await daemon(
    handoff,
    "/v1/sale-view",
  )) as JsonRecord | null;
  const daemonCategories = saleableCategoriesFromDaemon(saleView);
  const categories: JsonRecord[] = [];
  for (const daemonCategory of daemonCategories) {
    const selector = `[data-test="catalog-category"][data-category-key=${JSON.stringify(daemonCategory.key)}]:not(:disabled)`;
    const before = await evaluateExpression(
      client,
      `(() => ({
        route: location.hash,
        activeCategoryKey: document.querySelector("[data-test='catalog-page']")?.dataset.categoryKey || null,
        enabled: Boolean(document.querySelector(${JSON.stringify(selector)})),
      }))()`,
    );
    const beforeRecord = before as JsonRecord | null;
    if (beforeRecord?.enabled !== true) {
      throw new Error(
        `saleable daemon category ${daemonCategory.key} is disabled in installed Machine Runtime`,
      );
    }
    if (beforeRecord?.activeCategoryKey !== daemonCategory.key) {
      await activateVisibleSelector(client, selector, {
        kind: "touch",
        timeoutMs: 30_000,
      });
    }
    const projection = await waitFor(
      `installed Machine Runtime saleable category ${daemonCategory.key}`,
      () =>
        evaluateExpression(
          client,
          `(() => ({
            route: location.hash,
            activeCategoryKey: document.querySelector("[data-test='catalog-page']")?.dataset.categoryKey || null,
            saleableProductCount: document.querySelectorAll("[data-test='catalog-product']").length,
          }))()`,
        ),
      (state) => {
        const stateRecord = state as JsonRecord;
        return (
          stateRecord?.route === "#/catalog" &&
          stateRecord?.activeCategoryKey === daemonCategory.key &&
          Number.isInteger(stateRecord?.saleableProductCount) &&
          (stateRecord.saleableProductCount as number) > 0
        );
      },
    );
    categories.push({
      ...daemonCategory,
      ...(projection as JsonRecord),
    });
  }
  return {
    source: "daemon_sale_view_and_installed_machine_runtime_cdp",
    route: "#/catalog",
    categories,
  };
}

async function connectInstalledCustomerRuntime(
  handoff: HandoffRecord,
): Promise<InstanceType<typeof CdpClient>> {
  const cdp = handoff.cdp as JsonRecord | undefined;
  const target = await discoverMachineUiTarget({
    endpoint: "http://127.0.0.1:9222",
    expectedTargetId: required(cdp?.targetId, "handoff.cdp.targetId"),
  });
  const client = new CdpClient(
    rewriteWebSocketDebuggerUrl(
      target.webSocketDebuggerUrl,
      "http://127.0.0.1:9222",
    ),
  );
  await client.connect();
  await enablePageRuntime(client);
  return client;
}

async function waitForCustomerTerminal(
  client: InstanceType<typeof CdpClient>,
  order: JsonRecord,
  expected: JsonRecord,
): Promise<unknown> {
  return await waitFor(
    `installed customer result ${order.paymentId}`,
    () =>
      evaluateExpression(
        client,
        `(() => {
          const el = document.querySelector("[data-installed-kiosk-sale-result-surface]");
          const entries = Array.isArray(window.__VEM_MACHINE_RUNTIME_TRACE__) ? window.__VEM_MACHINE_RUNTIME_TRACE__ : [];
          const trace = [...entries].reverse().find((entry) =>
            entry && entry.type === "transaction_surface" && entry.stage === "result" &&
            entry.orderId === ${JSON.stringify(order.orderId)} &&
            entry.paymentId === ${JSON.stringify(order.paymentId)} &&
            entry.resultKind === ${JSON.stringify(expected.resultKind)}
          );
          return el ? {
            route: location.hash,
            orderId: el.dataset.orderId || null,
            paymentId: el.dataset.paymentId || null,
            resultKind: el.dataset.resultKind || null,
            displayIntent: el.dataset.resultDisplayIntent || null,
            text: (el.textContent || "").replace(/\\s+/g, " ").trim(),
            trace: trace || null
          } : null;
        })()`,
      ),
    (surface) => {
      const surfaceRecord = surface as JsonRecord | null;
      return (
        typeof surfaceRecord?.text === "string" &&
        (surfaceRecord.text as string).includes(String(expected.customerCopy))
      );
    },
    60_000,
  );
}

async function waitForSuccessfulCustomerResult(
  client: InstanceType<typeof CdpClient>,
  expected: JsonRecord,
): Promise<unknown> {
  return await waitFor(
    `installed customer success result ${expected.paymentId}`,
    () =>
      evaluateExpression(
        client,
        `(() => {
          const el = document.querySelector("[data-installed-kiosk-sale-result-surface]");
          return el ? {
            route: location.hash,
            orderId: el.dataset.orderId || null,
            paymentId: el.dataset.paymentId || null,
            orderNo: el.dataset.orderNo || null,
            commandId: el.dataset.commandId || null,
            resultKind: el.dataset.resultKind || null,
            displayIntent: el.dataset.resultDisplayIntent || null,
            text: (el.textContent || "").replace(/\\s+/g, " ").trim()
          } : { route: location.hash };
        })()`,
      ),
    (surface) => {
      const surfaceRecord = surface as JsonRecord;
      return (
        surfaceRecord?.route === "#/result/success" &&
        surfaceRecord.orderId === expected.orderId &&
        surfaceRecord.paymentId === expected.paymentId &&
        surfaceRecord.orderNo === expected.orderNo &&
        surfaceRecord.commandId === expected.commandId &&
        surfaceRecord.resultKind === "success"
      );
    },
    60_000,
  );
}

export async function returnCustomerToCatalog(
  client: InstanceType<typeof CdpClient>,
  {
    evaluateExpressionFn = evaluateExpression,
    activateVisibleSelectorFn = activateVisibleSelector,
  }: {
    evaluateExpressionFn?: typeof evaluateExpression;
    activateVisibleSelectorFn?: typeof activateVisibleSelector;
  } = {},
): Promise<unknown> {
  const selectors = [
    "[data-test='result-return-catalog']",
    "[data-test='checkout-back-product']",
    "[data-test='product-detail-return-catalog']",
    "[data-test='checkout-empty-return-catalog']",
  ];
  const observe = () =>
    evaluateExpressionFn(
      client,
      `(() => ({
        route: location.hash,
        catalogVisible: Boolean(document.querySelector("[data-test='catalog-page']")),
        returnSelector: ${JSON.stringify(selectors)}.find((selector) => {
          const element = document.querySelector(selector);
          if (!element || element.disabled) return false;
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        }) || null
      }))()`,
    );
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const state = (await observe()) as JsonRecord | null;
    if (state?.route === "#/catalog" && state.catalogVisible === true) {
      return state;
    }
    if (!state?.returnSelector) {
      throw new Error(
        `installed customer runtime cannot return to Catalog from ${JSON.stringify(state)}`,
      );
    }
    await activateVisibleSelectorFn(client, String(state.returnSelector), {
      kind: "touch",
      timeoutMs: 30_000,
    });
    await waitFor(
      `installed customer navigation after ${state.returnSelector}`,
      observe,
      (next) => {
        const nextRecord = next as JsonRecord | null;
        return (
          nextRecord?.route === "#/catalog" ||
          (typeof nextRecord?.route === "string" &&
            nextRecord.route !== state.route)
        );
      },
      30_000,
    );
  }
  throw new Error("installed customer runtime did not settle on Catalog");
}

export async function openFixtureProductFromCatalog({
  client,
  slotId,
  categoryKey,
  evaluateExpressionFn = evaluateExpression,
  activateVisibleSelectorFn = activateVisibleSelector,
}: {
  client: InstanceType<typeof CdpClient>;
  slotId: string;
  categoryKey: string;
  evaluateExpressionFn?: typeof evaluateExpression;
  activateVisibleSelectorFn?: typeof activateVisibleSelector;
}): Promise<void> {
  const productSelector = `[data-test="catalog-product"][data-slot-id=${JSON.stringify(slotId)}]`;
  const expectedCategoryKey = required(categoryKey, "fixture categoryKey");
  const expectedCategorySelector = `[data-test="catalog-category"][data-category-key=${JSON.stringify(expectedCategoryKey)}]:not(:disabled)`;
  let state = (await evaluateExpressionFn(
    client,
    `(() => ({
      activeCategoryKey: document.querySelector('[data-test="catalog-page"]')?.dataset.categoryKey || null,
      productVisible: Boolean(document.querySelector(${JSON.stringify(productSelector)})),
      expectedCategoryAvailable: Boolean(document.querySelector(${JSON.stringify(expectedCategorySelector)})),
    }))()`,
  )) as JsonRecord | null;
  if (state?.activeCategoryKey !== expectedCategoryKey) {
    if (!state?.expectedCategoryAvailable) {
      throw new Error(
        `fixture slot ${slotId} expected Catalog category ${expectedCategoryKey} is unavailable`,
      );
    }
    await activateVisibleSelectorFn(client, expectedCategorySelector, {
      kind: "touch",
      timeoutMs: 30_000,
    });
    state = (await waitFor(
      `fixture slot ${slotId} expected Catalog category ${expectedCategoryKey}`,
      () =>
        evaluateExpressionFn(
          client,
          `(() => ({
            activeCategoryKey: document.querySelector('[data-test="catalog-page"]')?.dataset.categoryKey || null,
            productVisible: Boolean(document.querySelector(${JSON.stringify(productSelector)})),
          }))()`,
        ),
      (candidate) => {
        const candidateRecord = candidate as JsonRecord;
        return (
          candidateRecord?.activeCategoryKey === expectedCategoryKey &&
          candidateRecord.productVisible === true
        );
      },
      30_000,
    )) as JsonRecord | null;
  }
  if (
    state?.activeCategoryKey !== expectedCategoryKey ||
    state.productVisible !== true
  ) {
    throw new Error(
      `fixture slot ${slotId} is not visible in expected Catalog category ${expectedCategoryKey}`,
    );
  }
  await activateVisibleSelectorFn(client, productSelector, {
    kind: "touch",
    timeoutMs: 30_000,
  });
}

async function prepareCustomerCreateFailure(
  client: InstanceType<typeof CdpClient>,
  slot: JsonRecord,
): Promise<string> {
  await waitForRoute(client, "#/catalog", { timeoutMs: 30_000 });
  await openFixtureProductFromCatalog({
    client,
    slotId: String(slot.slotId),
    categoryKey: String(slot.categoryKey),
  });
  await waitFor(
    "installed customer product detail",
    () =>
      evaluateExpression(
        client,
        'Boolean(document.querySelector("[data-test=product-buy]"))',
      ),
    Boolean,
    30_000,
  );
  await activateVisibleSelector(client, "[data-test=product-buy]", {
    kind: "touch",
    timeoutMs: 30_000,
  });
  await waitForRoute(client, "#/checkout", { timeoutMs: 30_000 });
  await activateVisibleSelector(
    client,
    '[data-test="payment-option"][data-payment-option-key="mock:mock"]:not(:disabled)',
    { kind: "touch", timeoutMs: 30_000 },
  );
  return (await waitFor(
    "checkout attempt idempotency key before payment create",
    () =>
      evaluateExpression(
        client,
        'document.querySelector("[data-test=checkout-submit]")?.dataset.checkoutAttemptIdempotencyKey || null',
      ),
    (key) => typeof key === "string" && key.startsWith("checkout:"),
    30_000,
  )) as string;
}

async function waitForCustomerCreateFailure(
  client: InstanceType<typeof CdpClient>,
  idempotencyKey: string,
  expected: JsonRecord,
): Promise<unknown> {
  return await waitFor(
    `installed customer create failure ${idempotencyKey}`,
    () =>
      evaluateExpression(
        client,
        `(() => {
          const page = document.querySelector("[data-test=checkout-page]");
          const entries = Array.isArray(window.__VEM_MACHINE_RUNTIME_TRACE__) ? window.__VEM_MACHINE_RUNTIME_TRACE__ : [];
          const trace = [...entries].reverse().find((entry) =>
            entry && entry.type === "customer_error" &&
            entry.stage === "payment_creation" &&
            entry.operation === "checkout.create_order" &&
            entry.checkoutAttemptIdempotencyKey === ${JSON.stringify(idempotencyKey)}
          );
          return page ? {
            route: location.hash,
            checkoutAttemptIdempotencyKey: page.dataset.checkoutAttemptIdempotencyKey || null,
            text: (page.textContent || "").replace(/\\s+/g, " ").trim(),
            trace: trace || null,
          } : null;
        })()`,
      ),
    (surface) => {
      const surfaceRecord = surface as JsonRecord | null;
      const trace = surfaceRecord?.trace as JsonRecord | null | undefined;
      return (
        surfaceRecord?.checkoutAttemptIdempotencyKey === idempotencyKey &&
        typeof surfaceRecord?.text === "string" &&
        (surfaceRecord.text as string).includes(
          String(expected.customerCopy),
        ) &&
        !/(?:provider|HTTP|MQTT|IPC|COM\d|schema|query_failed)/i.test(
          String(surfaceRecord.text),
        ) &&
        trace?.checkoutAttemptIdempotencyKey === idempotencyKey
      );
    },
    60_000,
  );
}

const RECOVERY_TERMINALS = Object.freeze({
  create_failure: {
    paymentStatus: "failed",
    orderStatus: "canceled",
    paymentState: "payment_failed",
    resultKind: "payment_failed",
    customerCopy: "支付订单创建失败，请稍后重试",
  },
  query_failure: {
    paymentStatus: "canceled",
    orderStatus: "canceled",
    paymentState: "canceled",
    resultKind: "closed",
    customerCopy: "订单已关闭",
  },
  canceled: {
    paymentStatus: "canceled",
    orderStatus: "canceled",
    paymentState: "canceled",
    resultKind: "closed",
    customerCopy: "订单已关闭",
  },
  expired: {
    paymentStatus: "expired",
    orderStatus: "payment_expired",
    paymentState: "payment_expired",
    resultKind: "payment_expired",
    customerCopy: "支付超时",
  },
});

async function waitForCreateGatePending(input: InputRecord): Promise<unknown> {
  return await waitFor(
    "mock payment create gate pending marker",
    () => control(input, "/v1/mock-payment-create-gate/status"),
    (state) => {
      const pending = (state as JsonRecord | null)?.pending as
        | JsonRecord
        | undefined;
      return pending?.state === "pending" && Boolean(pending.paymentNo);
    },
  );
}
export async function runPaymentRecoveryGuest(options: {
  mode: "full";
  guestInputPath: string;
  handoffPath: string;
  outPath: string;
  fixtureKey: string | null;
}): Promise<JsonRecord> {
  const input = readJson(options.guestInputPath);
  const handoff = readJson(options.handoffPath);
  const runId = required(input.runId, "runId");
  const machineCode = required(input.machineCode, "machineCode");
  const report: JsonRecord = {
    schemaVersion: SCHEMA_VERSION,
    ok: false,
    handoffSerialSessionId: null,
    mode: options.mode,
    runId,
    inventory: null,
    serialSession: null,
    payment: null,
    attempts: [],
    recoveryMqttEvidence: null,
    saleabilityRecovery: null,
    subsequentSale: null,
    assertions: { duplicatePaymentCount: null },
  };
  let session: JsonRecord | null = null;
  let customer: InstanceType<typeof CdpClient> | null = null;
  let serialStopped = false;
  try {
    const hostControlPlane = input.hostControlPlane as JsonRecord | undefined;
    session = (await control(input, "/v1/serial-sessions/start", {
      runId,
      machineCode,
      targetIdentity: required(
        hostControlPlane?.targetIdentity,
        "hostControlPlane.targetIdentity",
      ),
      runtimeBase: required(
        hostControlPlane?.runtimeBaseIdentity,
        "hostControlPlane.runtimeBaseIdentity",
      ),
      saleCorrelationId: `sale-correlation://${runId.toLowerCase()}.payment-recovery`,
    })) as JsonRecord;
    if (session === null)
      throw new Error("serial session start returned no session");
    const activeSession = session;
    report.handoffSerialSessionId = required(
      activeSession.sessionId,
      "payment recovery serial session id",
    );
    report.serialSession = {
      sessionId: required(activeSession.sessionId, "serial session id"),
    };
    customer = await connectInstalledCustomerRuntime(handoff);
    const activeCustomer = customer;
    const saleView = (await daemon(
      handoff,
      "/v1/sale-view",
    )) as JsonRecord | null;
    const fixtureAllocation = input.fixtureAllocation as JsonRecord | undefined;
    const fixture =
      (fixtureAllocation?.[options.fixtureKey ?? "paymentRecovery"] as
        | JsonRecord
        | undefined) ?? (fixtureAllocation?.sale as JsonRecord | undefined);
    const slot = selectFixtureSlot(saleView, fixture);
    report.inventory = {
      id: String(slot.inventoryId),
      slotId: String(slot.slotId),
    };
    const orderRequest = buildCreateOrderRequest(slot);
    const adminAccessToken = await refreshAdminAccessToken(input);
    await waitForMachineOnline(input, machineCode, adminAccessToken);

    const createAttempt = async (kind: string): Promise<JsonRecord> => {
      if (activeCustomer === null)
        throw new Error("installed customer runtime is not connected");
      await returnCustomerToCatalog(activeCustomer);
      const baselinePlatform = await platformReport(
        input,
        runId,
        machineCode,
        String(activeSession.sessionId),
      );
      const baseline = reservationBaseline(
        baselinePlatform,
        String(slot.inventoryId),
      );
      let attemptOrder: JsonRecord | null = null;
      let gate = null;
      let activePlatform: JsonRecord | null = null;
      let activeDaemon: unknown = null;
      let customerSurface: JsonRecord | null = null;
      let idempotencyKey = `${runId}-payment-recovery-${kind}`;
      if (kind === "create_failure") {
        idempotencyKey = await prepareCustomerCreateFailure(
          activeCustomer,
          slot,
        );
        await control(input, "/v1/mock-payment-create-gate/arm", {
          timeoutMs: 10_000,
        });
        let pending: JsonRecord | null = null;
        let openedAfterFailure = false;
        try {
          await activateVisibleSelector(
            activeCustomer,
            "[data-test=checkout-submit]",
            {
              kind: "touch",
              timeoutMs: 30_000,
            },
          );
          pending = (await waitForCreateGatePending(input)) as JsonRecord;
          const pendingMarker = pending.pending as JsonRecord;
          activePlatform = await waitFor(
            `platform active reservation for ${String(pendingMarker.paymentNo)}`,
            () =>
              platformReport(
                input,
                runId,
                machineCode,
                String(activeSession.sessionId),
              ),
            (platform) => {
              const correlated = orderForPaymentNo(
                platform as JsonRecord,
                String(pendingMarker.paymentNo),
              );
              return rows(platform.raw, "reservations").some(
                (reservation) =>
                  (reservation as JsonRecord).orderId ===
                    (correlated.order as JsonRecord).id &&
                  (reservation as JsonRecord).status === "active" &&
                  (reservation as JsonRecord).inventoryId === slot.inventoryId,
              );
            },
            45_000,
          );
          const correlated = orderForPaymentNo(
            activePlatform as JsonRecord,
            String(pendingMarker.paymentNo),
          );
          const correlatedOrder = correlated.order as JsonRecord;
          const correlatedPayment = correlated.payment as JsonRecord;
          attemptOrder = {
            orderId: String(correlatedOrder.id),
            orderNo: String(correlatedOrder.orderNo),
            paymentId: String(correlatedPayment.id),
            paymentNo: String(correlatedPayment.paymentNo),
          };
          gate = {
            source: "mock_provider_create_gate",
            pendingObservedAt: pendingMarker.observedAt,
            paymentNo: String(pendingMarker.paymentNo),
            released: false,
            openedAfterFailure: false,
            error: "mock payment create gate timed out before release",
            httpStatus: null,
          };
          customerSurface = (await waitForCustomerCreateFailure(
            activeCustomer,
            idempotencyKey,
            RECOVERY_TERMINALS.create_failure,
          )) as JsonRecord;
          if (
            !semanticBackendApiError(
              runtimeTraceTechnicalMessage(
                customerSurface?.trace as JsonRecord | undefined,
              ),
            )
          ) {
            throw new Error(
              "customer create failure did not retain semantic backend error",
            );
          }
        } finally {
          const opened = (await control(
            input,
            "/v1/mock-payment-create-gate/open",
          )) as JsonRecord | null;
          openedAfterFailure = opened?.state === "open";
          if (gate) gate.openedAfterFailure = openedAfterFailure;
        }
        if (!gate?.openedAfterFailure) {
          throw new Error(
            "mock payment create gate did not reopen after timeout",
          );
        }
      } else {
        attemptOrder = (await daemon(handoff, "/v1/intents/create-order", {
          ...orderRequest,
          idempotencyKey,
        })) as JsonRecord;
      }
      if (attemptOrder === null)
        throw new Error("attempt order response is missing");
      const attemptOrderRecord = attemptOrder;
      const order = {
        id: required(attemptOrderRecord.orderId, "orderId"),
        orderNo: required(attemptOrderRecord.orderNo, "orderNo"),
        paymentId: required(attemptOrderRecord.paymentId, "paymentId"),
      };
      const payment = {
        id: order.paymentId,
        paymentNo: required(attemptOrderRecord.paymentNo, "paymentNo"),
      };
      if (gate && gate.paymentNo !== payment.paymentNo) {
        throw new Error(
          "create gate pending payment did not match daemon order response",
        );
      }
      if (kind !== "create_failure") {
        activePlatform = await waitFor(
          `platform active reservation ${payment.id}`,
          () =>
            platformReport(
              input,
              runId,
              machineCode,
              String(activeSession.sessionId),
            ),
          (platform) => {
            const reservation = rows(
              (platform as JsonRecord).raw,
              "reservations",
            ).filter(
              (row) =>
                (row as JsonRecord).orderId === order.id &&
                (row as JsonRecord).inventoryId === slot.inventoryId,
            );
            return (
              reservation.length === 1 &&
              (reservation[0] as JsonRecord).status === "active"
            );
          },
        );
        activeDaemon = await waitForDaemonTransaction(handoff, {
          orderId: order.id,
          paymentId: payment.id,
        });
      }
      return {
        baseline,
        activePlatform,
        activeDaemon,
        customerSurface,
        idempotencyKey,
        order,
        payment,
        gate,
      };
    };

    const terminalizeAttempt = async (
      kind: string,
      created: JsonRecord,
    ): Promise<JsonRecord> => {
      const expectedTerminal = RECOVERY_TERMINALS[
        kind as keyof typeof RECOVERY_TERMINALS
      ] as JsonRecord;
      if (!expectedTerminal) throw new Error(`unknown recovery kind ${kind}`);
      let recovery = null;
      let expiryInjection = null;
      const createdPayment = created.payment as JsonRecord;
      const createdOrder = created.order as JsonRecord;
      const createdGate = created.gate as JsonRecord | null | undefined;
      if (kind === "create_failure") {
        // The provider create timeout above is the production failure input.
        // OrdersService performs the local cancellation and reservation release.
      } else if (kind === "query_failure") {
        const queryFault = await control(
          input,
          "/v1/mock-payment-query-fault/arm",
          {
            paymentNo: createdPayment.paymentNo,
          },
        );
        let queryError = null;
        let queryActionResponse = null;
        try {
          queryActionResponse = unwrapServiceApiEnvelope(
            await api(
              input,
              `/payments/${String(createdPayment.id)}/incident-actions`,
              {
                method: "POST",
                token: adminAccessToken,
                body: {
                  action: "query_payment",
                  reason: `runtime acceptance ${runId}`,
                },
              },
            ),
          );
        } catch (error) {
          queryError = error instanceof Error ? error.message : String(error);
        }
        const queryFaultPlatform = await waitFor(
          `query reconciliation attempt ${String(createdPayment.id)}`,
          () =>
            platformReport(
              input,
              runId,
              machineCode,
              String(activeSession.sessionId),
            ),
          (platform) =>
            rows(
              (platform as JsonRecord).raw,
              "paymentReconciliationAttempts",
            ).some(
              (attempt) =>
                (attempt as JsonRecord).paymentId === createdPayment.id &&
                (attempt as JsonRecord).status === "network_error" &&
                (attempt as JsonRecord).errorCode === "query_failed",
            ),
        );
        const queryFailureAttempt = exactlyOne(
          rows(
            (queryFaultPlatform as JsonRecord).raw,
            "paymentReconciliationAttempts",
          ).filter(
            (attempt) =>
              (attempt as JsonRecord).paymentId === createdPayment.id &&
              (attempt as JsonRecord).status === "network_error" &&
              (attempt as JsonRecord).errorCode === "query_failed",
          ),
          "query failure reconciliation attempt was not unique",
        );
        const providerBoundaryError = (queryError ??
          queryFailureAttempt.errorMessage ??
          (queryActionResponse
            ? JSON.stringify(queryActionResponse)
            : "query failure recorded without an HTTP error body")) as
          | string
          | null;
        if (
          !providerBoundaryError ||
          queryFailureAttempt.errorCode !== "query_failed"
        ) {
          throw new Error(
            `query failure did not retain a semantic provider boundary: ${providerBoundaryError}`,
          );
        }
        await control(input, "/v1/mock-payment-query-fault/open");
        const closeAction = unwrapServiceApiEnvelope(
          await api(
            input,
            `/payments/${String(createdPayment.id)}/incident-actions`,
            {
              method: "POST",
              token: adminAccessToken,
              body: {
                action: "close_or_reverse_uncertain_payment",
                reason: `runtime acceptance ${runId}`,
              },
            },
          ),
        );
        const queryFaultRecord = queryFault as JsonRecord;
        recovery = {
          queryFault: {
            source: "mock_provider_query_fault_boundary",
            paymentNo: queryFaultRecord.paymentNo,
            armedAt: queryFaultRecord.armedAt,
            error: providerBoundaryError,
          },
          reconciliationAttempt: {
            ...queryFailureAttempt,
          },
          closeAction,
        };
      } else if (kind === "canceled") {
        await daemon(handoff, "/v1/intents/cancel-order", {
          orderNo: createdOrder.orderNo,
        });
      } else if (kind === "expired") {
        expiryInjection = (await control(input, "/v1/platform/payment-expiry", {
          runId,
          machineCode,
          paymentId: createdPayment.id,
          expiresAt: new Date(Date.now() - 200_000).toISOString(),
        })) as JsonRecord;
        expiryInjection = (expiryInjection as JsonRecord).report;
      }
      const terminalPlatform = await waitFor(
        `platform terminal ${String(createdPayment.id)}`,
        () =>
          platformReport(
            input,
            runId,
            machineCode,
            String(activeSession.sessionId),
          ),
        (platform) => {
          const platformRecord = platform as JsonRecord;
          const order = rows(platformRecord.raw, "orders").find(
            (row) => (row as JsonRecord).id === createdOrder.id,
          );
          const payment = rows(platformRecord.raw, "payments").find(
            (row) => (row as JsonRecord).id === createdPayment.id,
          );
          const reservation = rows(platformRecord.raw, "reservations").find(
            (row) =>
              (row as JsonRecord).orderId === createdOrder.id &&
              (row as JsonRecord).inventoryId === slot.inventoryId,
          );
          return (
            (order as JsonRecord)?.status === expectedTerminal.orderStatus &&
            (order as JsonRecord)?.paymentState ===
              expectedTerminal.paymentState &&
            (payment as JsonRecord)?.status ===
              expectedTerminal.paymentStatus &&
            (reservation as JsonRecord)?.status === "released"
          );
        },
        kind === "expired" ? 95_000 : 30_000,
      );
      const terminalDaemon =
        kind === "create_failure"
          ? await waitForDaemonCleanup(
              handoff,
              String(createdPayment.paymentNo),
            )
          : await waitForDaemonTransaction(
              handoff,
              {
                orderId: createdOrder.id,
                paymentId: createdPayment.id,
              },
              String(expectedTerminal.paymentStatus),
            );
      const customerSurface =
        kind === "create_failure"
          ? created.customerSurface
          : await waitForCustomerTerminal(
              activeCustomer,
              {
                orderId: createdOrder.id,
                paymentId: createdPayment.id,
              },
              expectedTerminal,
            );
      const customerSurfaceRecord = customerSurface as JsonRecord | null;
      const terminal = terminalRows(
        terminalPlatform as JsonRecord,
        String(createdOrder.id),
        String(createdPayment.id),
      );
      const terminalOrder = terminal.order as JsonRecord;
      const terminalPayment = terminal.payment as JsonRecord;
      const customerTrace = customerSurfaceRecord?.trace as
        | JsonRecord
        | undefined;
      return {
        kind,
        ...(kind === "create_failure"
          ? { idempotencyKey: String(created.idempotencyKey) }
          : {}),
        order: { ...createdOrder },
        payment: { ...createdPayment },
        expectedTerminal,
        terminal: {
          paymentStatus: terminalPayment.status,
          orderStatus: terminalOrder.status,
          paymentState: terminalOrder.paymentState,
          fulfillmentState: terminalOrder.fulfillmentState,
        },
        reservation: {
          inventoryId: String(slot.inventoryId),
          quantity: 1,
          baseline: created.baseline,
          active: reservationObservation(
            created.activePlatform as JsonRecord,
            String(createdOrder.id),
            String(slot.inventoryId),
          ),
          terminal: reservationObservation(
            terminalPlatform as JsonRecord,
            String(createdOrder.id),
            String(slot.inventoryId),
          ),
        },
        daemon: { active: created.activeDaemon, terminal: terminalDaemon },
        customer:
          customerSurfaceRecord === null
            ? null
            : {
                source: "installed_machine_runtime_cdp",
                observedAt: new Date().toISOString(),
                ...(kind === "create_failure"
                  ? {
                      checkoutAttemptIdempotencyKey:
                        customerSurfaceRecord.checkoutAttemptIdempotencyKey,
                      stage: "payment_creation",
                    }
                  : {
                      orderId: customerSurfaceRecord.orderId,
                      paymentId: customerSurfaceRecord.paymentId,
                      resultKind: customerSurfaceRecord.resultKind,
                      displayIntent: customerSurfaceRecord.displayIntent,
                    }),
                text: customerSurfaceRecord.text,
                route: customerSurfaceRecord.route,
              },
        technicalEvidence:
          kind === "create_failure"
            ? {
                providerCreate: {
                  source: "mock_provider_create_gate",
                  paymentNo: String(createdPayment.paymentNo),
                  error: createdGate?.error ?? null,
                  httpStatus: createdGate?.httpStatus ?? null,
                },
                runtimeTrace: {
                  source: "installed_machine_runtime_trace_cdp",
                  checkoutAttemptIdempotencyKey:
                    customerTrace?.checkoutAttemptIdempotencyKey ?? null,
                  entry: customerTrace ?? null,
                },
              }
            : {
                runtimeTrace: {
                  source: "installed_machine_runtime_trace_cdp",
                  orderId: customerTrace?.orderId ?? null,
                  paymentId: customerTrace?.paymentId ?? null,
                  resultKind: customerTrace?.resultKind ?? null,
                  entry: customerTrace,
                },
              },
        ...(createdGate ? { createGate: createdGate } : {}),
        ...(recovery ? { recovery } : {}),
        ...(expiryInjection ? { expiryInjection } : {}),
        assertions: {
          duplicatePaymentCount:
            rows((terminalPlatform as JsonRecord).raw, "payments").filter(
              (payment) => (payment as JsonRecord).orderId === createdOrder.id,
            ).length - 1,
        },
      };
    };

    let createFailure: JsonRecord | null = null;
    for (const kind of REQUIRED_RECOVERY_ATTEMPT_KINDS) {
      const attempt = await terminalizeAttempt(kind, await createAttempt(kind));
      (report.attempts as unknown[]).push(attempt);
      if (kind === "create_failure") createFailure = attempt;
    }
    if (createFailure === null)
      throw new Error("create failure recovery attempt was not produced");
    const createFailurePayment = createFailure.payment as JsonRecord;
    const createFailureOrder = createFailure.order as JsonRecord;
    const createFailureAssertions = createFailure.assertions as JsonRecord;
    report.payment = {
      id: String(createFailurePayment.id),
      paymentNo: String(createFailurePayment.paymentNo),
      orderNo: String(createFailureOrder.orderNo),
    };
    (report.assertions as JsonRecord).duplicatePaymentCount =
      createFailureAssertions.duplicatePaymentCount;
    const recoveryEvidence = await control(
      input,
      `/v1/serial-sessions/${String(activeSession.sessionId)}/evidence`,
    );
    report.recoveryMqttEvidence = recoveryEvidence;
    await returnCustomerToCatalog(activeCustomer);
    report.saleabilityRecovery = await observeSaleabilityRecovery({
      client: activeCustomer,
      handoff,
    });

    const subsequentBaseline = await platformReport(
      input,
      runId,
      machineCode,
      String(activeSession.sessionId),
    );
    const subsequentInventoryBefore = inventorySnapshot(
      subsequentBaseline,
      String(slot.inventoryId),
    );
    const subsequentOrder = (await daemon(handoff, "/v1/intents/create-order", {
      ...orderRequest,
      idempotencyKey: `${runId}-payment-recovery-subsequent-sale`,
    })) as JsonRecord;
    await api(
      input,
      `/payments/mock/${required(subsequentOrder.paymentNo, "paymentNo")}/complete`,
      {
        method: "POST",
        body: {},
      },
    );
    const paidDaemon = (await waitFor(
      `paid dispense command ${String(subsequentOrder.paymentId)}`,
      () => daemon(handoff, "/v1/transactions/current"),
      (transaction) => {
        const transactionRecord = transaction as JsonRecord;
        const vending = transactionRecord?.vending as JsonRecord | undefined;
        return (
          transactionRecord?.orderId === subsequentOrder.orderId &&
          transactionRecord?.paymentId === subsequentOrder.paymentId &&
          transactionRecord?.paymentStatus === "succeeded" &&
          typeof (
            vending?.commandId ?? transactionRecord?.dispenseCommandId
          ) === "string"
        );
      },
    )) as JsonRecord;
    const paidVending = (paidDaemon?.vending ?? {}) as JsonRecord;
    const vendingCommandId =
      paidVending.commandId ?? paidDaemon.dispenseCommandId;
    const serial: unknown[] = [];
    serial.push(
      await control(
        input,
        `/v1/serial-sessions/${String(activeSession.sessionId)}/wait-frame`,
        { parsedOpcode: "VEND", timeoutMs: 30_000 },
      ),
    );
    serial.push(
      await control(
        input,
        `/v1/serial-sessions/${String(activeSession.sessionId)}/release-f0`,
      ),
    );
    serial.push(
      await control(
        input,
        `/v1/serial-sessions/${String(activeSession.sessionId)}/wait-frame`,
        { parsedOpcode: "F0", timeoutMs: 30_000 },
      ),
    );
    serial.push(
      await control(
        input,
        `/v1/serial-sessions/${String(activeSession.sessionId)}/wait-frame`,
        { parsedOpcode: "F1", timeoutMs: 30_000 },
      ),
    );
    serial.push(
      await control(
        input,
        `/v1/serial-sessions/${String(activeSession.sessionId)}/release-f2`,
      ),
    );
    serial.push(
      await control(
        input,
        `/v1/serial-sessions/${String(activeSession.sessionId)}/wait-frame`,
        { parsedOpcode: "F2", timeoutMs: 30_000 },
      ),
    );
    const fulfilledPlatform = await waitFor(
      `platform fulfillment ${String(subsequentOrder.paymentId)}`,
      () =>
        platformReport(
          input,
          runId,
          machineCode,
          String(activeSession.sessionId),
        ),
      (platform) => {
        const platformRecord = platform as JsonRecord;
        const terminal = terminalRows(
          platformRecord,
          String(subsequentOrder.orderId),
          String(subsequentOrder.paymentId),
        );
        const command = rows(platformRecord.raw, "commands").find(
          (row) => (row as JsonRecord).id === vendingCommandId,
        );
        const movements = dispenseMovementsForOrder(
          platformRecord,
          subsequentOrder,
          String(slot.inventoryId),
        );
        const terminalPayment = terminal.payment as JsonRecord;
        const terminalOrder = terminal.order as JsonRecord;
        return (
          terminalPayment.status === "succeeded" &&
          terminalOrder.status === "fulfilled" &&
          terminalOrder.fulfillmentState === "dispensed" &&
          (command as JsonRecord)?.status === "succeeded" &&
          movements.length === 1
        );
      },
      60_000,
    );
    const fulfilled = terminalRows(
      fulfilledPlatform as JsonRecord,
      String(subsequentOrder.orderId),
      String(subsequentOrder.paymentId),
    );
    const customerResult = (await waitForSuccessfulCustomerResult(
      activeCustomer,
      {
        orderId: String(subsequentOrder.orderId),
        paymentId: String(subsequentOrder.paymentId),
        orderNo: String(subsequentOrder.orderNo),
        commandId: vendingCommandId,
      },
    )) as JsonRecord;
    const subsequentInventoryAfter = inventorySnapshot(
      fulfilledPlatform as JsonRecord,
      String(slot.inventoryId),
    );
    const movementCount = dispenseMovementsForOrder(
      fulfilledPlatform as JsonRecord,
      subsequentOrder,
      String(slot.inventoryId),
    ).length;
    const serialEvidence = await control(
      input,
      `/v1/serial-sessions/${String(activeSession.sessionId)}/evidence`,
    );
    await control(
      input,
      `/v1/serial-sessions/${String(activeSession.sessionId)}/stop`,
      {
        orderId: subsequentOrder.orderId,
        paymentId: subsequentOrder.paymentId,
        vendingCommandId,
      },
    );
    serialStopped = true;
    report.subsequentSale = {
      order: {
        id: String(subsequentOrder.orderId),
        orderNo: String(subsequentOrder.orderNo),
        paymentId: String(subsequentOrder.paymentId),
        commandId: vendingCommandId,
        inventoryId: String(slot.inventoryId),
      },
      terminal: {
        paymentStatus: (fulfilled.payment as JsonRecord).status,
        orderStatus: (fulfilled.order as JsonRecord).status,
        fulfillmentState: (fulfilled.order as JsonRecord).fulfillmentState,
      },
      inventory: {
        beforeOnHandQty: subsequentInventoryBefore.onHandQty,
        afterOnHandQty: subsequentInventoryAfter.onHandQty,
        movementCount,
      },
      serial: {
        protocol: ["VEND", "F0", "F1", "F2"],
        boundaries: serial,
        evidence: serialEvidence,
        stopped: true,
      },
      customer: customerResult,
    };
    report.ok = true;
    validatePaymentRecoveryEvidence(report);
    writeJson(options.outPath, report);
    return report;
  } catch (error) {
    report.error = {
      message: error instanceof Error ? error.message : String(error),
    };
    writeJson(options.outPath, report);
    throw error;
  } finally {
    await customer?.close().catch(() => undefined);
    if (session?.sessionId && !serialStopped) {
      await control(
        input,
        `/v1/serial-sessions/${session.sessionId}/abort`,
      ).catch(() => null);
    }
  }
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  runPaymentRecoveryGuest(
    parsePaymentRecoveryGuestArgs(process.argv.slice(2)),
  ).catch((error) => {
    console.error(error.stack ?? error);
    process.exitCode = 1;
  });
