#!/usr/bin/env node

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
} from "./machine-ui-cdp-driver.mjs";

const SCHEMA_VERSION = "vem-payment-recovery-guest-full/v1";
const REQUIRED_RECOVERY_ATTEMPT_KINDS = Object.freeze([
  "create_failure",
  "query_failure",
  "canceled",
  "expired",
]);
function required(value, label) {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${label} is required`);
  return value.trim();
}
function option(args, name) {
  const i = args.indexOf(`--${name}`);
  const value = i < 0 ? undefined : args[i + 1];
  return required(value, `--${name}`);
}
function localPath(value) {
  const path = required(value, "Windows path");
  return process.platform === "win32"
    ? path
    : resolve(
        `/mnt/${path[0].toLowerCase()}/${path.slice(3).replaceAll("\\", "/")}`,
      );
}
export function parsePaymentRecoveryGuestArgs(args) {
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
function readJson(path) {
  return JSON.parse(readFileSync(localPath(path), "utf8"));
}
function writeJson(path, value) {
  mkdirSync(dirname(localPath(path)), { recursive: true });
  writeFileSync(localPath(path), `${JSON.stringify(value, null, 2)}\n`);
}
async function json(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: options.signal ?? AbortSignal.timeout(30_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(
      `${options.method ?? "GET"} ${url} failed: ${JSON.stringify(payload)}`,
    );
    error.httpStatus = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}
function daemonUrl(handoff) {
  const url = required(handoff.daemon?.ready?.healthzUrl, "daemon healthzUrl");
  if (!url.endsWith("/healthz"))
    throw new Error("daemon healthzUrl must end with /healthz");
  return url.slice(0, -"/healthz".length);
}
function daemonHeaders(handoff) {
  return {
    authorization: `Bearer ${required(handoff.daemon?.ready?.ipcToken, "daemon ipcToken")}`,
    "content-type": "application/json",
  };
}
function daemon(handoff, path, body, { timeoutMs = 30_000 } = {}) {
  return json(`${daemonUrl(handoff)}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: daemonHeaders(handoff),
    signal: AbortSignal.timeout(timeoutMs),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function control(input, path, body = {}) {
  return json(
    `${required(input.hostControlPlane?.endpoint, "hostControlPlane.endpoint")}${path}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${required(input.hostControlPlane?.token, "hostControlPlane.token")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
}
function apiBase(input) {
  return required(
    input.runtimeBootstrap?.provisioningApiBaseUrl,
    "runtimeBootstrap.provisioningApiBaseUrl",
  ).replace(/\/+$/, "");
}
function api(input, path, options = {}) {
  return json(`${apiBase(input)}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
}
export function unwrapServiceApiEnvelope(payload) {
  if (
    payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    payload.code === 0 &&
    Object.hasOwn(payload, "data")
  ) {
    return payload.data;
  }
  return payload;
}
export async function refreshAdminAccessToken(input, login = api) {
  const result = unwrapServiceApiEnvelope(
    await login(input, "/auth/login", {
      method: "POST",
      body: {
        username: required(
          input.serviceApi?.adminUsername ?? "local-testbed-admin",
          "serviceApi.adminUsername",
        ),
        password: required(
          input.serviceApi?.adminPassword ?? "LocalTestbedAdminPassword!",
          "serviceApi.adminPassword",
        ),
      },
    }),
  );
  return required(result?.accessToken, "auth.login.accessToken");
}
export async function waitForMachineOnline(
  input,
  machineCode,
  token,
  {
    timeoutMs = 15_000,
    pollIntervalMs = 250,
    now = () => Date.now(),
    wait = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
    query = api,
  } = {},
) {
  const code = required(machineCode, "machineCode");
  const deadline = now() + timeoutMs;
  let lastStatus = null;
  do {
    const page = unwrapServiceApiEnvelope(
      await query(input, "/machines?page=1&pageSize=100", {
        method: "GET",
        token: required(token, "admin access token"),
      }),
    );
    const machine = (page?.items ?? []).find((entry) => entry?.code === code);
    if (!machine) throw new Error(`Service API machine ${code} was not found`);
    lastStatus = machine.status;
    if (lastStatus === "online") return machine;
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await wait(Math.min(pollIntervalMs, remaining));
  } while (now() < deadline);
  throw new Error(
    `Service API machine ${code} did not become online (last status: ${lastStatus ?? "unknown"})`,
  );
}
export function selectFixtureSlot(saleView, fixture) {
  const slotId = required(fixture?.slotId, "fixture.slotId");
  const item = (saleView?.items ?? []).find(
    (entry) => entry?.slotId === slotId,
  );
  if (!item?.inventoryId || saleView?.planogramVersion == null)
    throw new Error(
      `fixture slot ${slotId} is not saleable in daemon sale-view`,
    );
  return {
    slotId,
    inventoryId: item.inventoryId,
    planogramVersion: saleView.planogramVersion,
  };
}
export function buildCreateOrderRequest(slot) {
  return {
    inventoryId: required(slot?.inventoryId, "slot.inventoryId"),
    quantity: 1,
    planogramVersion: required(slot?.planogramVersion, "slot.planogramVersion"),
    slotId: required(slot?.slotId, "slot.slotId"),
    paymentMethod: "mock",
    paymentProviderCode: "mock",
  };
}
export function mqttEvidenceProvesNoDispense(evidence) {
  return (
    evidence?.mqtt?.topic?.endsWith("/commands/dispense") === true &&
    Array.isArray(evidence.mqtt.messages) &&
    evidence.mqtt.messages.length === 0
  );
}
export function validatePaymentRecoveryEvidence(report) {
  if (report?.schemaVersion !== SCHEMA_VERSION || report.ok !== true) {
    throw new Error("payment recovery report is not successful");
  }
  if (!report.payment?.id || report.assertions?.duplicatePaymentCount !== 0) {
    throw new Error("payment recovery allowed a duplicate payment");
  }
  if (!mqttEvidenceProvesNoDispense(report.recoveryMqttEvidence)) {
    throw new Error("payment recovery MQTT evidence includes a dispense");
  }
  const attempts = Array.isArray(report.attempts) ? report.attempts : [];
  for (const kind of REQUIRED_RECOVERY_ATTEMPT_KINDS) {
    const attempt = attempts.find((candidate) => candidate?.kind === kind);
    const baseline = attempt?.reservation?.baseline;
    const active = attempt?.reservation?.active;
    const terminal = attempt?.reservation?.terminal;
    if (
      !attempt ||
      !attempt.order?.id ||
      attempt.order.paymentId !== attempt.payment?.id ||
      !attempt.expectedTerminal ||
      typeof attempt.expectedTerminal.customerCopy !== "string" ||
      attempt.terminal?.paymentStatus !==
        attempt.expectedTerminal.paymentStatus ||
      attempt.terminal?.orderStatus !== attempt.expectedTerminal.orderStatus ||
      attempt.terminal?.paymentState !==
        attempt.expectedTerminal.paymentState ||
      !baseline ||
      !active ||
      !terminal ||
      active.activeRows !== baseline.activeRows + 1 ||
      terminal.activeRows !== baseline.activeRows ||
      active.onHandQty !== baseline.onHandQty ||
      terminal.onHandQty !== baseline.onHandQty ||
      active.reservedQty !==
        baseline.reservedQty + attempt.reservation.quantity ||
      terminal.reservedQty !== baseline.reservedQty ||
      active.orderReservationRows !== 1 ||
      terminal.orderReservationRows !== 1 ||
      active.row?.status !== "active" ||
      terminal.row?.id !== active.row?.id ||
      terminal.row?.status !== "released" ||
      attempt.assertions?.duplicatePaymentCount !== 0
    )
      throw new Error(
        `payment recovery ${kind} did not return to reservation baseline`,
      );
    if (kind === "create_failure") {
      if (
        attempt.createGate?.source !== "mock_provider_create_gate" ||
        attempt.createGate?.paymentNo !== attempt.payment.paymentNo ||
        attempt.createGate?.released !== false ||
        attempt.createGate?.openedAfterFailure !== true ||
        !attempt.createGate?.error?.includes(
          "mock payment create gate timed out before release",
        ) ||
        attempt.technicalEvidence?.providerCreate?.source !==
          "mock_provider_create_gate" ||
        attempt.technicalEvidence.providerCreate.paymentNo !==
          attempt.payment.paymentNo ||
        !attempt.technicalEvidence.providerCreate.error?.includes(
          "mock payment create gate timed out before release",
        ) ||
        attempt.daemon?.active !== null ||
        attempt.daemon?.terminal?.orderId !== null ||
        attempt.daemon?.terminal?.paymentId !== null ||
        attempt.daemon?.terminal?.paymentStatus !== null ||
        attempt.daemon?.terminal?.nextAction !== null ||
        attempt.customer?.source !== "installed_machine_runtime_cdp" ||
        attempt.customer?.checkoutAttemptIdempotencyKey !==
          attempt.idempotencyKey ||
        attempt.customer?.stage !== "payment_creation" ||
        typeof attempt.customer?.text !== "string" ||
        !attempt.customer.text.includes(
          attempt.expectedTerminal.customerCopy,
        ) ||
        /(?:provider|HTTP|MQTT|IPC|COM\d|schema|query_failed)/i.test(
          attempt.customer.text,
        ) ||
        attempt.technicalEvidence?.runtimeTrace?.source !==
          "installed_machine_runtime_trace_cdp" ||
        attempt.technicalEvidence.runtimeTrace
          ?.checkoutAttemptIdempotencyKey !== attempt.idempotencyKey ||
        !Number.isFinite(attempt.technicalEvidence.runtimeTrace?.entry?.id) ||
        attempt.technicalEvidence?.localOperations?.source !==
          "installed_machine_local_operations_cdp_after_refresh" ||
        attempt.technicalEvidence.localOperations
          ?.checkoutAttemptIdempotencyKey !== attempt.idempotencyKey ||
        attempt.technicalEvidence.localOperations?.orderId !==
          attempt.order.id ||
        attempt.technicalEvidence.localOperations?.paymentId !==
          attempt.payment.id ||
        !attempt.technicalEvidence.localOperations?.entry?.technicalMessage?.includes(
          "mock payment create gate timed out before release",
        )
      ) {
        throw new Error(
          "payment recovery create failure did not prove installed customer copy and durable technical evidence",
        );
      }
      continue;
    }
    if (
      attempt.daemon?.active?.orderId !== attempt.order.id ||
      attempt.daemon?.active?.paymentId !== attempt.payment.id ||
      attempt.daemon?.terminal?.orderId !== attempt.order.id ||
      attempt.daemon?.terminal?.paymentId !== attempt.payment.id ||
      attempt.daemon?.terminal?.paymentStatus !==
        attempt.expectedTerminal.paymentStatus
    ) {
      throw new Error(
        `payment recovery ${kind} daemon terminal state is incomplete`,
      );
    }
    if (
      attempt.customer?.source !== "installed_machine_runtime_cdp" ||
      attempt.customer?.orderId !== attempt.order.id ||
      attempt.customer?.paymentId !== attempt.payment.id ||
      attempt.customer?.resultKind !== attempt.expectedTerminal.resultKind ||
      typeof attempt.customer?.text !== "string" ||
      !/[\u3400-\u9fff]/.test(attempt.customer.text) ||
      !attempt.customer.text.includes(attempt.expectedTerminal.customerCopy) ||
      attempt.customer.text.includes(attempt.payment.paymentNo) ||
      /(?:provider|HTTP|MQTT|IPC|COM\d|schema|query_failed)/i.test(
        attempt.customer.text,
      ) ||
      attempt.technicalEvidence?.runtimeTrace?.source !==
        "installed_machine_runtime_trace_cdp" ||
      attempt.technicalEvidence.runtimeTrace.orderId !== attempt.order.id ||
      attempt.technicalEvidence.runtimeTrace.paymentId !== attempt.payment.id ||
      attempt.technicalEvidence.runtimeTrace.resultKind !==
        attempt.expectedTerminal.resultKind ||
      !Number.isFinite(attempt.technicalEvidence.runtimeTrace.entry?.id)
    ) {
      throw new Error(
        `payment recovery ${kind} customer surface or correlation is not installed-runtime evidence`,
      );
    }
    if (
      kind === "query_failure" &&
      (attempt.recovery?.queryFault?.source !==
        "mock_provider_query_fault_boundary" ||
        attempt.recovery?.queryFault?.paymentNo !== attempt.payment.paymentNo ||
        attempt.recovery?.reconciliationAttempt?.paymentId !==
          attempt.payment.id ||
        attempt.recovery?.reconciliationAttempt?.status !== "network_error" ||
        attempt.recovery?.reconciliationAttempt?.errorCode !== "query_failed" ||
        attempt.recovery?.closeAction?.action !==
          "close_or_reverse_uncertain_payment")
    ) {
      throw new Error(
        "payment recovery query failure did not use provider recovery",
      );
    }
    if (
      kind === "expired" &&
      (attempt.expiryInjection?.source !==
        "testbed_payment_expiry_time_injection" ||
        !["created", "pending", "processing"].includes(
          attempt.expiryInjection.beforePaymentStatus,
        ))
    ) {
      throw new Error(
        "payment recovery expiry did not use the production worker",
      );
    }
  }
  if (
    report.subsequentSale?.order?.inventoryId !== report.inventory?.id ||
    report.subsequentSale?.terminal?.paymentStatus !== "succeeded" ||
    report.subsequentSale?.terminal?.orderStatus !== "fulfilled" ||
    report.subsequentSale?.terminal?.fulfillmentState !== "dispensed" ||
    report.subsequentSale?.inventory?.afterOnHandQty !==
      report.subsequentSale?.inventory?.beforeOnHandQty - 1 ||
    report.subsequentSale?.inventory?.movementCount !== 1 ||
    report.subsequentSale?.serial?.stopped !== true ||
    !["VEND", "F0", "F1", "F2"].every((frame) =>
      report.subsequentSale?.serial?.protocol?.includes(frame),
    )
  )
    throw new Error(
      "payment recovery did not prove the fulfilled subsequent sale",
    );
  return {
    paymentId: report.payment.id,
    action: "query_payment",
    duplicatePaymentCount: 0,
    attemptCount: attempts.length,
  };
}

function rows(raw, key) {
  return Array.isArray(raw?.[key]) ? raw[key] : [];
}

function exactlyOne(values, message) {
  if (values.length !== 1) throw new Error(message);
  return values[0];
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds),
  );
}

async function waitFor(label, observe, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  do {
    last = await observe();
    if (predicate(last)) return last;
    await sleep(250);
  } while (Date.now() < deadline);
  throw new Error(`${label} did not settle: ${JSON.stringify(last)}`);
}

async function platformReport(input, runId, machineCode, sessionId) {
  const response = await control(input, "/v1/platform/query", {
    runId,
    machineCode,
    ...(sessionId ? { sessionId } : {}),
  });
  if (!response?.report?.raw)
    throw new Error("platform query returned no raw rows");
  return response.report;
}

function inventorySnapshot(platform, inventoryId) {
  return exactlyOne(
    rows(platform.raw, "inventories").filter((row) => row.id === inventoryId),
    `platform inventory ${inventoryId} was not unique`,
  );
}

function activeReservationCount(platform, inventoryId) {
  return rows(platform.raw, "reservations").filter(
    (row) => row.inventoryId === inventoryId && row.status === "active",
  ).length;
}

function reservationBaseline(platform, inventoryId) {
  const inventory = inventorySnapshot(platform, inventoryId);
  return {
    onHandQty: inventory.onHandQty,
    reservedQty: inventory.reservedQty,
    activeRows: activeReservationCount(platform, inventoryId),
  };
}

function reservationObservation(platform, orderId, inventoryId) {
  const inventory = inventorySnapshot(platform, inventoryId);
  const own = rows(platform.raw, "reservations").filter(
    (row) => row.orderId === orderId && row.inventoryId === inventoryId,
  );
  return {
    onHandQty: inventory.onHandQty,
    reservedQty: inventory.reservedQty,
    activeRows: activeReservationCount(platform, inventoryId),
    orderReservationRows: own.length,
    row: own[0] ?? null,
  };
}

function terminalRows(platform, orderId, paymentId) {
  return {
    order: exactlyOne(
      rows(platform.raw, "orders").filter((row) => row.id === orderId),
      `platform order ${orderId} was not unique`,
    ),
    payment: exactlyOne(
      rows(platform.raw, "payments").filter((row) => row.id === paymentId),
      `platform payment ${paymentId} was not unique`,
    ),
  };
}

function orderForPaymentNo(platform, paymentNo) {
  const payment = exactlyOne(
    rows(platform.raw, "payments").filter((row) => row.paymentNo === paymentNo),
    `platform payment ${paymentNo} was not unique`,
  );
  const order = exactlyOne(
    rows(platform.raw, "orders").filter((row) => row.id === payment.orderId),
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

function dispenseMovementsForOrder(platform, order, inventoryId) {
  const orderItem = rows(platform.raw, "orderItems").find(
    (item) =>
      item.orderId === order.orderId && item.inventoryId === inventoryId,
  );
  if (!orderItem) return [];
  return rows(platform.raw, "movements").filter(
    (movement) =>
      movement.inventoryId === inventoryId &&
      (movement.orderNo === order.orderNo ||
        movement.orderItemId === orderItem.id),
  );
}

async function waitForDaemonTransaction(handoff, order, expectedStatus = null) {
  return await waitFor(
    `daemon transaction ${order.paymentId}`,
    () => daemon(handoff, "/v1/transactions/current"),
    (transaction) =>
      transaction?.orderId === order.orderId &&
      transaction?.paymentId === order.paymentId &&
      (expectedStatus === null ||
        transaction?.paymentStatus === expectedStatus),
  );
}

async function waitForDaemonCleanup(handoff, paymentNo) {
  return await waitFor(
    `daemon create failure cleanup ${paymentNo}`,
    () => daemon(handoff, "/v1/transactions/current"),
    (transaction) =>
      transaction?.orderId === null &&
      transaction?.paymentId === null &&
      transaction?.paymentStatus === null &&
      transaction?.nextAction === null,
  );
}

async function connectInstalledCustomerRuntime(handoff) {
  const target = await discoverMachineUiTarget({
    endpoint: "http://127.0.0.1:9222",
    expectedTargetId: required(handoff.cdp?.targetId, "handoff.cdp.targetId"),
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

async function waitForCustomerTerminal(client, order, expected) {
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
    (surface) =>
      surface?.orderId === order.orderId &&
      surface?.paymentId === order.paymentId &&
      surface?.resultKind === expected.resultKind &&
      typeof surface?.text === "string" &&
      surface.text.includes(expected.customerCopy) &&
      surface?.trace?.orderId === order.orderId &&
      surface?.trace?.paymentId === order.paymentId,
    60_000,
  );
}

export async function openFixtureProductFromCatalog({
  client,
  slotId,
  evaluateExpressionFn = evaluateExpression,
  activateVisibleSelectorFn = activateVisibleSelector,
}) {
  const productSelector = `[data-test="catalog-product"][data-slot-id=${JSON.stringify(slotId)}]`;
  const categorySelector = '[data-test="catalog-category"]:not(:disabled)';
  const state = await evaluateExpressionFn(
    client,
    `(() => ({
      productVisible: Boolean(document.querySelector(${JSON.stringify(productSelector)})),
      categories: Array.from(document.querySelectorAll(${JSON.stringify(categorySelector)}))
        .map((element) => element.dataset.categoryKey)
        .filter(Boolean),
    }))()`,
  );
  if (state?.productVisible) {
    await activateVisibleSelectorFn(client, productSelector, {
      kind: "touch",
      timeoutMs: 30_000,
    });
    return;
  }
  const categories = Array.isArray(state?.categories) ? state.categories : [];
  for (const category of categories) {
    await activateVisibleSelectorFn(
      client,
      `[data-test="catalog-category"][data-category-key=${JSON.stringify(category)}]:not(:disabled)`,
      { kind: "touch", timeoutMs: 30_000 },
    );
    const visible = await evaluateExpressionFn(
      client,
      `Boolean(document.querySelector(${JSON.stringify(productSelector)}))`,
    );
    if (!visible) continue;
    await activateVisibleSelectorFn(client, productSelector, {
      kind: "touch",
      timeoutMs: 30_000,
    });
    return;
  }
  throw new Error(
    `fixture slot ${slotId} is not visible in any enabled Catalog category`,
  );
}

async function prepareCustomerCreateFailure(client, slot) {
  await waitForRoute(client, "#/catalog", { timeoutMs: 30_000 });
  await openFixtureProductFromCatalog({ client, slotId: slot.slotId });
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
  return await waitFor(
    "checkout attempt idempotency key before payment create",
    () =>
      evaluateExpression(
        client,
        'document.querySelector("[data-test=checkout-submit]")?.dataset.checkoutAttemptIdempotencyKey || null',
      ),
    (key) => typeof key === "string" && key.startsWith("checkout:"),
    30_000,
  );
}

async function waitForCustomerCreateFailure(client, idempotencyKey, expected) {
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
    (surface) =>
      surface?.checkoutAttemptIdempotencyKey === idempotencyKey &&
      typeof surface?.text === "string" &&
      surface.text.includes(expected.customerCopy) &&
      !/(?:provider|HTTP|MQTT|IPC|COM\d|schema|query_failed)/i.test(
        surface.text,
      ) &&
      surface?.trace?.checkoutAttemptIdempotencyKey === idempotencyKey,
    60_000,
  );
}

async function readCustomerErrorFromLocalOperations(client, idempotencyKey) {
  await client.send("Page.reload", { ignoreCache: true });
  await waitFor(
    "installed machine reload",
    () => evaluateExpression(client, "document.readyState"),
    (state) => state === "complete",
    30_000,
  );
  await evaluateExpression(
    client,
    'location.hash = "#/maintenance?source=operator"',
  );
  await waitForRoute(client, "#/maintenance?source=operator", {
    timeoutMs: 30_000,
    forbiddenRoutes: [],
  });
  await activateVisibleSelector(
    client,
    "[data-test=maintenance-task-diagnostics]",
    {
      kind: "touch",
      timeoutMs: 30_000,
    },
  );
  return await waitFor(
    `Local Operations customer error ${idempotencyKey}`,
    () =>
      evaluateExpression(
        client,
        `(() => {
          const entry = [...document.querySelectorAll("[data-test=customer-error-evidence-entry]")]
            .find((candidate) => candidate.dataset.checkoutAttemptIdempotencyKey === ${JSON.stringify(idempotencyKey)});
          return entry ? {
            checkoutAttemptIdempotencyKey: entry.dataset.checkoutAttemptIdempotencyKey || null,
            technicalMessage: (entry.textContent || "").replace(/\\s+/g, " ").trim(),
          } : null;
        })()`,
      ),
    (entry) =>
      entry?.checkoutAttemptIdempotencyKey === idempotencyKey &&
      entry.technicalMessage.includes(
        "mock payment create gate timed out before release",
      ),
    30_000,
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

async function waitForCreateGatePending(input) {
  return await waitFor(
    "mock payment create gate pending marker",
    () => control(input, "/v1/mock-payment-create-gate/status"),
    (state) => state?.pending?.state === "pending" && state.pending.paymentNo,
  );
}
export async function runPaymentRecoveryGuest(options) {
  const input = readJson(options.guestInputPath);
  const handoff = readJson(options.handoffPath);
  const runId = required(input.runId, "runId");
  const machineCode = required(input.machineCode, "machineCode");
  const report = {
    schemaVersion: SCHEMA_VERSION,
    ok: false,
    mode: options.mode,
    runId,
    inventory: null,
    serialSession: null,
    payment: null,
    attempts: [],
    recoveryMqttEvidence: null,
    subsequentSale: null,
    assertions: { duplicatePaymentCount: null },
  };
  let session = null;
  let customer = null;
  let serialStopped = false;
  try {
    session = await control(input, "/v1/serial-sessions/start", {
      runId,
      machineCode,
      targetIdentity: required(
        input.hostControlPlane?.targetIdentity,
        "hostControlPlane.targetIdentity",
      ),
      runtimeBase: required(
        input.hostControlPlane?.runtimeBaseIdentity,
        "hostControlPlane.runtimeBaseIdentity",
      ),
      saleCorrelationId: `sale-correlation://${runId.toLowerCase()}.payment-recovery`,
    });
    report.serialSession = {
      sessionId: required(session.sessionId, "serial session id"),
    };
    customer = await connectInstalledCustomerRuntime(handoff);
    const saleView = await daemon(handoff, "/v1/sale-view");
    const fixture =
      input.fixtureAllocation?.[options.fixtureKey ?? "paymentRecovery"] ??
      input.fixtureAllocation?.sale;
    const slot = selectFixtureSlot(saleView, fixture);
    report.inventory = { id: slot.inventoryId, slotId: slot.slotId };
    const orderRequest = buildCreateOrderRequest(slot);
    const adminAccessToken = await refreshAdminAccessToken(input);
    await waitForMachineOnline(input, machineCode, adminAccessToken);

    const createAttempt = async (kind) => {
      const baselinePlatform = await platformReport(
        input,
        runId,
        machineCode,
        session.sessionId,
      );
      const baseline = reservationBaseline(baselinePlatform, slot.inventoryId);
      let attemptOrder;
      let gate = null;
      let activePlatform = null;
      let activeDaemon = null;
      let customerSurface = null;
      let idempotencyKey = `${runId}-payment-recovery-${kind}`;
      if (kind === "create_failure") {
        idempotencyKey = await prepareCustomerCreateFailure(customer, slot);
        await control(input, "/v1/mock-payment-create-gate/arm");
        let pending = null;
        let openedAfterFailure = false;
        try {
          await activateVisibleSelector(
            customer,
            "[data-test=checkout-submit]",
            {
              kind: "touch",
              timeoutMs: 30_000,
            },
          );
          pending = await waitForCreateGatePending(input);
          activePlatform = await waitFor(
            `platform active reservation for ${pending.pending.paymentNo}`,
            () => platformReport(input, runId, machineCode, session.sessionId),
            (platform) => {
              const correlated = orderForPaymentNo(
                platform,
                pending.pending.paymentNo,
              );
              return rows(platform.raw, "reservations").some(
                (reservation) =>
                  reservation.orderId === correlated.order.id &&
                  reservation.status === "active" &&
                  reservation.inventoryId === slot.inventoryId,
              );
            },
            45_000,
          );
          const correlated = orderForPaymentNo(
            activePlatform,
            pending.pending.paymentNo,
          );
          attemptOrder = {
            orderId: correlated.order.id,
            orderNo: correlated.order.orderNo,
            paymentId: correlated.payment.id,
            paymentNo: correlated.payment.paymentNo,
          };
          gate = {
            source: "mock_provider_create_gate",
            pendingObservedAt: pending.pending.observedAt,
            paymentNo: pending.pending.paymentNo,
            released: false,
            openedAfterFailure: false,
            error: "mock payment create gate timed out before release",
            httpStatus: null,
          };
          customerSurface = await waitForCustomerCreateFailure(
            customer,
            idempotencyKey,
            RECOVERY_TERMINALS.create_failure,
          );
          if (
            !customerSurface.trace.technicalMessage.includes(
              "mock payment create gate timed out before release",
            )
          ) {
            throw new Error(
              "customer create failure did not retain gate error",
            );
          }
        } finally {
          const opened = await control(
            input,
            "/v1/mock-payment-create-gate/open",
          );
          openedAfterFailure = opened?.state === "open";
          if (gate) gate.openedAfterFailure = openedAfterFailure;
        }
        if (!gate?.openedAfterFailure) {
          throw new Error(
            "mock payment create gate did not reopen after timeout",
          );
        }
      } else {
        attemptOrder = await daemon(handoff, "/v1/intents/create-order", {
          ...orderRequest,
          idempotencyKey,
        });
      }
      const order = {
        id: required(attemptOrder.orderId, "orderId"),
        orderNo: required(attemptOrder.orderNo, "orderNo"),
        paymentId: required(attemptOrder.paymentId, "paymentId"),
      };
      const payment = {
        id: order.paymentId,
        paymentNo: required(attemptOrder.paymentNo, "paymentNo"),
      };
      if (gate?.paymentNo !== payment.paymentNo) {
        throw new Error(
          "create gate pending payment did not match daemon order response",
        );
      }
      if (kind !== "create_failure") {
        activePlatform = await waitFor(
          `platform active reservation ${payment.id}`,
          () => platformReport(input, runId, machineCode, session.sessionId),
          (platform) => {
            const reservation = rows(platform.raw, "reservations").filter(
              (row) =>
                row.orderId === order.id &&
                row.inventoryId === slot.inventoryId,
            );
            return (
              reservation.length === 1 && reservation[0].status === "active"
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

    const terminalizeAttempt = async (kind, created) => {
      const expectedTerminal = RECOVERY_TERMINALS[kind];
      let recovery = null;
      let expiryInjection = null;
      if (kind === "create_failure") {
        // The provider create timeout above is the production failure input.
        // OrdersService performs the local cancellation and reservation release.
      } else if (kind === "query_failure") {
        const queryFault = await control(
          input,
          "/v1/mock-payment-query-fault/arm",
          {
            paymentNo: created.payment.paymentNo,
          },
        );
        let queryError = null;
        try {
          await api(input, `/payments/${created.payment.id}/incident-actions`, {
            method: "POST",
            token: adminAccessToken,
            body: {
              action: "query_payment",
              reason: `runtime acceptance ${runId}`,
            },
          });
        } catch (error) {
          queryError = error instanceof Error ? error.message : String(error);
        }
        if (!queryError?.includes("mock payment query fault injected")) {
          throw new Error(
            "query failure did not reach the mock provider boundary",
          );
        }
        const queryFaultPlatform = await waitFor(
          `query reconciliation attempt ${created.payment.id}`,
          () => platformReport(input, runId, machineCode, session.sessionId),
          (platform) =>
            rows(platform.raw, "paymentReconciliationAttempts").some(
              (attempt) =>
                attempt.paymentId === created.payment.id &&
                attempt.status === "network_error" &&
                attempt.errorCode === "query_failed",
            ),
        );
        await control(input, "/v1/mock-payment-query-fault/open");
        const closeAction = unwrapServiceApiEnvelope(
          await api(input, `/payments/${created.payment.id}/incident-actions`, {
            method: "POST",
            token: adminAccessToken,
            body: {
              action: "close_or_reverse_uncertain_payment",
              reason: `runtime acceptance ${runId}`,
            },
          }),
        );
        recovery = {
          queryFault: {
            source: "mock_provider_query_fault_boundary",
            paymentNo: queryFault.paymentNo,
            armedAt: queryFault.armedAt,
            error: queryError,
          },
          reconciliationAttempt: exactlyOne(
            rows(
              queryFaultPlatform.raw,
              "paymentReconciliationAttempts",
            ).filter(
              (attempt) =>
                attempt.paymentId === created.payment.id &&
                attempt.status === "network_error" &&
                attempt.errorCode === "query_failed",
            ),
            "query failure reconciliation attempt was not unique",
          ),
          closeAction,
        };
      } else if (kind === "canceled") {
        await daemon(handoff, "/v1/intents/cancel-order", {
          orderNo: created.order.orderNo,
        });
      } else if (kind === "expired") {
        expiryInjection = (
          await control(input, "/v1/platform/payment-expiry", {
            runId,
            machineCode,
            paymentId: created.payment.id,
            expiresAt: new Date(Date.now() - 60_000).toISOString(),
          })
        ).report;
      }
      const terminalPlatform = await waitFor(
        `platform terminal ${created.payment.id}`,
        () => platformReport(input, runId, machineCode, session.sessionId),
        (platform) => {
          const order = rows(platform.raw, "orders").find(
            (row) => row.id === created.order.id,
          );
          const payment = rows(platform.raw, "payments").find(
            (row) => row.id === created.payment.id,
          );
          const reservation = rows(platform.raw, "reservations").find(
            (row) =>
              row.orderId === created.order.id &&
              row.inventoryId === slot.inventoryId,
          );
          return (
            order?.status === expectedTerminal.orderStatus &&
            order?.paymentState === expectedTerminal.paymentState &&
            payment?.status === expectedTerminal.paymentStatus &&
            reservation?.status === "released"
          );
        },
        kind === "expired" ? 95_000 : 30_000,
      );
      const terminalDaemon =
        kind === "create_failure"
          ? await waitForDaemonCleanup(handoff, created.payment.paymentNo)
          : await waitForDaemonTransaction(
              handoff,
              { orderId: created.order.id, paymentId: created.payment.id },
              expectedTerminal.paymentStatus,
            );
      const customerSurface =
        kind === "create_failure"
          ? created.customerSurface
          : await waitForCustomerTerminal(
              customer,
              { orderId: created.order.id, paymentId: created.payment.id },
              expectedTerminal,
            );
      const localOperationsEvidence =
        kind === "create_failure"
          ? await readCustomerErrorFromLocalOperations(
              customer,
              created.idempotencyKey,
            )
          : null;
      const terminal = terminalRows(
        terminalPlatform,
        created.order.id,
        created.payment.id,
      );
      return {
        kind,
        ...(kind === "create_failure"
          ? { idempotencyKey: created.idempotencyKey }
          : {}),
        order: { ...created.order },
        payment: { ...created.payment },
        expectedTerminal,
        terminal: {
          paymentStatus: terminal.payment.status,
          orderStatus: terminal.order.status,
          paymentState: terminal.order.paymentState,
          fulfillmentState: terminal.order.fulfillmentState,
        },
        reservation: {
          inventoryId: slot.inventoryId,
          quantity: 1,
          baseline: created.baseline,
          active: reservationObservation(
            created.activePlatform,
            created.order.id,
            slot.inventoryId,
          ),
          terminal: reservationObservation(
            terminalPlatform,
            created.order.id,
            slot.inventoryId,
          ),
        },
        daemon: { active: created.activeDaemon, terminal: terminalDaemon },
        customer:
          customerSurface === null
            ? null
            : {
                source: "installed_machine_runtime_cdp",
                observedAt: new Date().toISOString(),
                ...(kind === "create_failure"
                  ? {
                      checkoutAttemptIdempotencyKey:
                        customerSurface.checkoutAttemptIdempotencyKey,
                      stage: "payment_creation",
                    }
                  : {
                      orderId: customerSurface.orderId,
                      paymentId: customerSurface.paymentId,
                      resultKind: customerSurface.resultKind,
                      displayIntent: customerSurface.displayIntent,
                    }),
                text: customerSurface.text,
                route: customerSurface.route,
              },
        technicalEvidence:
          kind === "create_failure"
            ? {
                providerCreate: {
                  source: "mock_provider_create_gate",
                  paymentNo: created.payment.paymentNo,
                  error: created.gate?.error ?? null,
                  httpStatus: created.gate?.httpStatus ?? null,
                },
                runtimeTrace: {
                  source: "installed_machine_runtime_trace_cdp",
                  checkoutAttemptIdempotencyKey:
                    customerSurface?.trace?.checkoutAttemptIdempotencyKey ??
                    null,
                  entry: customerSurface?.trace ?? null,
                },
                localOperations: {
                  source:
                    "installed_machine_local_operations_cdp_after_refresh",
                  checkoutAttemptIdempotencyKey:
                    localOperationsEvidence?.checkoutAttemptIdempotencyKey ??
                    null,
                  orderId: created.order.id,
                  paymentId: created.payment.id,
                  entry: localOperationsEvidence,
                },
              }
            : {
                runtimeTrace: {
                  source: "installed_machine_runtime_trace_cdp",
                  orderId: customerSurface.trace.orderId,
                  paymentId: customerSurface.trace.paymentId,
                  resultKind: customerSurface.trace.resultKind,
                  entry: customerSurface.trace,
                },
              },
        ...(created.gate ? { createGate: created.gate } : {}),
        ...(recovery ? { recovery } : {}),
        ...(expiryInjection ? { expiryInjection } : {}),
        assertions: {
          duplicatePaymentCount:
            rows(terminalPlatform.raw, "payments").filter(
              (payment) => payment.orderId === created.order.id,
            ).length - 1,
        },
      };
    };

    let createFailure = null;
    for (const kind of REQUIRED_RECOVERY_ATTEMPT_KINDS) {
      const attempt = await terminalizeAttempt(kind, await createAttempt(kind));
      report.attempts.push(attempt);
      if (kind === "create_failure") createFailure = attempt;
    }
    report.payment = {
      id: createFailure.payment.id,
      paymentNo: createFailure.payment.paymentNo,
      orderNo: createFailure.order.orderNo,
    };
    report.assertions.duplicatePaymentCount =
      createFailure.assertions.duplicatePaymentCount;
    const recoveryEvidence = await control(
      input,
      `/v1/serial-sessions/${session.sessionId}/evidence`,
    );
    report.recoveryMqttEvidence = recoveryEvidence;

    const subsequentBaseline = await platformReport(
      input,
      runId,
      machineCode,
      session.sessionId,
    );
    const subsequentInventoryBefore = inventorySnapshot(
      subsequentBaseline,
      slot.inventoryId,
    );
    const subsequentOrder = await daemon(handoff, "/v1/intents/create-order", {
      ...orderRequest,
      idempotencyKey: `${runId}-payment-recovery-subsequent-sale`,
    });
    await api(
      input,
      `/payments/mock/${required(subsequentOrder.paymentNo, "paymentNo")}/complete`,
      {
        method: "POST",
        body: {},
      },
    );
    const paidDaemon = await waitFor(
      `paid dispense command ${subsequentOrder.paymentId}`,
      () => daemon(handoff, "/v1/transactions/current"),
      (transaction) =>
        transaction?.orderId === subsequentOrder.orderId &&
        transaction?.paymentId === subsequentOrder.paymentId &&
        transaction?.paymentStatus === "succeeded" &&
        typeof (
          transaction?.vending?.commandId ?? transaction?.dispenseCommandId
        ) === "string",
    );
    const vendingCommandId =
      paidDaemon.vending?.commandId ?? paidDaemon.dispenseCommandId;
    const serial = [];
    serial.push(
      await control(
        input,
        `/v1/serial-sessions/${session.sessionId}/wait-frame`,
        { parsedOpcode: "VEND", timeoutMs: 30_000 },
      ),
    );
    serial.push(
      await control(
        input,
        `/v1/serial-sessions/${session.sessionId}/release-f0`,
      ),
    );
    serial.push(
      await control(
        input,
        `/v1/serial-sessions/${session.sessionId}/wait-frame`,
        { parsedOpcode: "F0", timeoutMs: 30_000 },
      ),
    );
    serial.push(
      await control(
        input,
        `/v1/serial-sessions/${session.sessionId}/wait-frame`,
        { parsedOpcode: "F1", timeoutMs: 30_000 },
      ),
    );
    serial.push(
      await control(
        input,
        `/v1/serial-sessions/${session.sessionId}/release-f2`,
      ),
    );
    serial.push(
      await control(
        input,
        `/v1/serial-sessions/${session.sessionId}/wait-frame`,
        { parsedOpcode: "F2", timeoutMs: 30_000 },
      ),
    );
    const fulfilledPlatform = await waitFor(
      `platform fulfillment ${subsequentOrder.paymentId}`,
      () => platformReport(input, runId, machineCode, session.sessionId),
      (platform) => {
        const terminal = terminalRows(
          platform,
          subsequentOrder.orderId,
          subsequentOrder.paymentId,
        );
        const command = rows(platform.raw, "commands").find(
          (row) => row.id === vendingCommandId,
        );
        const movements = dispenseMovementsForOrder(
          platform,
          subsequentOrder,
          slot.inventoryId,
        );
        return (
          terminal.payment.status === "succeeded" &&
          terminal.order.status === "fulfilled" &&
          terminal.order.fulfillmentState === "dispensed" &&
          command?.status === "succeeded" &&
          movements.length === 1
        );
      },
      60_000,
    );
    const fulfilled = terminalRows(
      fulfilledPlatform,
      subsequentOrder.orderId,
      subsequentOrder.paymentId,
    );
    const subsequentInventoryAfter = inventorySnapshot(
      fulfilledPlatform,
      slot.inventoryId,
    );
    const movementCount = dispenseMovementsForOrder(
      fulfilledPlatform,
      subsequentOrder,
      slot.inventoryId,
    ).length;
    const serialEvidence = await control(
      input,
      `/v1/serial-sessions/${session.sessionId}/evidence`,
    );
    await control(input, `/v1/serial-sessions/${session.sessionId}/stop`, {
      orderId: subsequentOrder.orderId,
      paymentId: subsequentOrder.paymentId,
      vendingCommandId,
    });
    serialStopped = true;
    report.subsequentSale = {
      order: {
        id: subsequentOrder.orderId,
        paymentId: subsequentOrder.paymentId,
        inventoryId: slot.inventoryId,
      },
      terminal: {
        paymentStatus: fulfilled.payment.status,
        orderStatus: fulfilled.order.status,
        fulfillmentState: fulfilled.order.fulfillmentState,
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
