#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { catalogProductSelectorForFixture } from "./full-workflow-fixtures.mjs";
import {
  activateVisibleSelector,
  CdpClient,
  discoverMachineUiTarget,
  enablePageRuntime,
  evaluateExpression,
  rewriteWebSocketDebuggerUrl,
  waitForRoute,
} from "./machine-ui-cdp-driver.mjs";
import { replaceSerialSessionAndUpdateHandoff } from "./serial-session-handoff.mjs";

const SCHEMA_VERSION = "vem-payment-provider-guest-full/v1";
const DEFAULT_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 250;
const MAX_DIAGNOSTIC_ATTEMPTS = 2;
const MAX_PAYMENT_CODE_PROVIDER_ATTEMPTS = 3;
const PAYMENT_CODE_CLEANUP_TIMEOUT_MS = 180_000;
export const UNATTENDED_ALIPAY_CUSTOMER_CODE = "288888888888888888\r\n";
const PROVIDER_FAILURE_STAGES = new Set([
  "host-preparation",
  "readiness",
  "creation",
  "customer-code-submission",
  "query",
  "notification",
  "closure",
  "terminal-state",
  "serial-cleanup",
]);

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

function optionalOption(args, name) {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? null : required(args[index + 1], `--${name}`);
}

function localPath(value) {
  const path = required(value, "Windows path");
  return process.platform === "win32"
    ? path
    : resolve(
        `/mnt/${path[0].toLowerCase()}/${path.slice(3).replaceAll("\\", "/")}`,
      );
}

function readJson(path) {
  return JSON.parse(readFileSync(localPath(path), "utf8"));
}

function writeJson(path, value) {
  mkdirSync(dirname(localPath(path)), { recursive: true });
  writeFileSync(localPath(path), `${JSON.stringify(value, null, 2)}\n`);
}

function unwrap(payload) {
  return payload &&
    typeof payload === "object" &&
    payload.code === 0 &&
    Object.hasOwn(payload, "data")
    ? payload.data
    : payload;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function boundedText(value) {
  return String(value ?? "")
    .replaceAll(
      /-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g,
      "[redacted-pem]",
    )
    .replaceAll(
      /(private|secret|password|token|auth.?code|cert|notifyUrl)\s*[:=]\s*[^,\s}]+/gi,
      "$1=[redacted]",
    )
    .slice(0, 512);
}

const sensitiveEvidenceKey =
  /(?:private|secret|password|token|auth.?code|cert|notify|credential|key)/i;

export function sanitizeProviderEvidence(value, depth = 0) {
  if (depth > 4 || value == null) return value ?? null;
  if (typeof value === "string") return boundedText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value))
    return value
      .slice(0, 20)
      .map((entry) => sanitizeProviderEvidence(entry, depth + 1));
  if (typeof value !== "object") return String(value);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !sensitiveEvidenceKey.test(key))
      .slice(0, 40)
      .map(([key, entry]) => [key, sanitizeProviderEvidence(entry, depth + 1)]),
  );
}

export function isRetryableAlipaySandboxError(error) {
  const message = errorMessage(error);
  return ["aop.ACQ.SYSTEM_ERROR", "PAYMENT_CODE_QUERY_UNKNOWN"].some((code) =>
    message.includes(code),
  );
}

export function parsePaymentProviderGuestArgs(args) {
  if (option(args, "mode") !== "full") throw new Error("--mode must be full");
  return {
    mode: "full",
    guestInputPath: option(args, "guest-input"),
    handoffPath: option(args, "handoff"),
    outPath: option(args, "out"),
    fixtureKey: optionalOption(args, "fixture-key"),
  };
}

function daemonBaseUrl(handoff) {
  const healthzUrl = required(
    handoff?.daemon?.ready?.healthzUrl,
    "daemon healthzUrl",
  );
  if (!healthzUrl.endsWith("/healthz"))
    throw new Error("daemon healthzUrl must end with /healthz");
  return healthzUrl.slice(0, -"/healthz".length);
}

async function json(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal:
      options.signal ??
      AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(
      `${options.method ?? "GET"} ${url} failed: ${JSON.stringify(sanitizeProviderEvidence(payload))}`,
    );
    error.httpStatus = response.status;
    error.payload = sanitizeProviderEvidence(payload);
    throw error;
  }
  return unwrap(payload);
}

function daemon(handoff, path, body) {
  return json(`${daemonBaseUrl(handoff)}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${required(handoff?.daemon?.ready?.ipcToken, "daemon ipcToken")}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function apiBase(input) {
  return required(
    input.runtimeBootstrap?.provisioningApiBaseUrl,
    "runtimeBootstrap.provisioningApiBaseUrl",
  ).replace(/\/+$/, "");
}

function api(input, path, { token = null, method = "GET", body } = {}) {
  return json(`${apiBase(input)}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function control(input, path, body = {}) {
  const plane = input.hostControlPlane;
  return await json(
    `${required(plane?.endpoint, "hostControlPlane.endpoint")}${path}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${required(plane?.token, "hostControlPlane.token")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
}

async function adminToken(input) {
  const result = await api(input, "/auth/login", {
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
  });
  return required(result?.accessToken, "auth.login.accessToken");
}

export function validateInstallationOwnedAlipaySandboxFixture(fixture) {
  if (
    fixture?.schemaVersion !== "vem-installation-alipay-sandbox-fixture/v1" ||
    fixture?.ownership !== "host-installation" ||
    fixture?.target !== "local-service-api" ||
    fixture?.providerConfig?.providerCode !== "alipay" ||
    fixture?.providerConfig?.publicConfigJson?.mode !== "sandbox" ||
    fixture?.providerConfig?.publicConfigJson?.keyType !== "PKCS1" ||
    fixture?.providerConfig?.publicConfigJson?.gatewayUrl !==
      "https://openapi-sandbox.dl.alipaydev.com/gateway.do" ||
    typeof fixture?.providerConfig?.sensitiveConfigJson?.privateKeyPem !==
      "string" ||
    fixture.providerConfig.sensitiveConfigJson.privateKeyPem.trim() === ""
  ) {
    throw new Error(
      "installation-owned Alipay sandbox fixture is invalid or incomplete",
    );
  }
  return fixture;
}

function containsSecretMaterial(value, key = "") {
  if (/(?:sensitiveConfigJson|privateKey|cert|secret)/i.test(key)) return true;
  if (Array.isArray(value))
    return value.some((entry) => containsSecretMaterial(entry));
  if (value && typeof value === "object") {
    return Object.entries(value).some(([entryKey, entry]) =>
      containsSecretMaterial(entry, entryKey),
    );
  }
  return false;
}

function providerIdentity(input) {
  const identity = input?.paymentProvider?.identity;
  if (
    containsSecretMaterial(input?.paymentProvider) ||
    identity?.providerCode !== "alipay" ||
    typeof identity?.providerConfigId !== "string" ||
    identity.providerConfigId.length === 0 ||
    typeof identity?.appId !== "string" ||
    identity.appId.length === 0 ||
    typeof identity?.merchantNo !== "string" ||
    identity.merchantNo.length === 0 ||
    identity?.mode !== "sandbox" ||
    identity?.keyType !== "PKCS1" ||
    identity?.gatewayUrl !==
      "https://openapi-sandbox.dl.alipaydev.com/gateway.do" ||
    input?.paymentProvider?.hostPreparation?.source !==
      "host_installation_fixture" ||
    input?.paymentProvider?.hostPreparation?.preflight !== "configured"
  ) {
    throw new Error(
      "guest input must contain host-prepared Alipay identity without provider secrets",
    );
  }
  return identity;
}

function alipayOptions(capability) {
  return (capability?.paymentOptions?.options ?? []).filter(
    (option) => option?.providerCode === "alipay" && option?.ready === true,
  );
}

export async function waitForCondition(
  read,
  matches,
  { timeoutMs = DEFAULT_TIMEOUT_MS, label },
) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  do {
    last = await read();
    if (matches(last)) return last;
    if (Date.now() >= deadline) break;
    await sleep(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
  } while (Date.now() < deadline);
  throw new Error(
    `${label} did not reach its correlated expected state: ${JSON.stringify(sanitizeProviderEvidence(last))}`,
  );
}

async function waitForProviderReadiness(handoff, timeoutMs) {
  return await waitForCondition(
    async () => ({
      environment: await daemon(handoff, "/v1/maintenance/payment-environment"),
      capability: await daemon(handoff, "/v1/sale-start-capability"),
    }),
    ({ environment, capability }) =>
      environment?.environment === "sandbox" &&
      environment?.readiness === "ready" &&
      capability?.canStartSale === true &&
      ["qr_code:alipay", "payment_code:alipay"].every((key) =>
        alipayOptions(capability).some((option) => option.optionKey === key),
      ),
    { timeoutMs, label: "local Alipay sandbox readiness" },
  );
}

function orderIdentity(snapshot) {
  const order = {
    orderId: required(snapshot?.orderId, "orderId"),
    paymentId: required(snapshot?.paymentId, "paymentId"),
    orderNo: required(snapshot?.orderNo, "orderNo"),
    paymentNo: required(snapshot?.paymentNo, "paymentNo"),
    providerCode: required(
      snapshot?.paymentProvider ?? snapshot?.paymentProviderCode,
      "payment provider",
    ),
  };
  if (order.providerCode !== "alipay")
    throw new Error("payment provider must be alipay");
  return order;
}

async function platformReport(input, runId, machineCode) {
  return (await control(input, "/v1/platform/query", { runId, machineCode }))
    .report;
}

function terminalFromReport(report, order) {
  const raw = report?.raw ?? {};
  const payment = (raw.payments ?? []).find(
    (entry) => entry?.id === order.paymentId,
  );
  const platformOrder = (raw.orders ?? []).find(
    (entry) => entry?.id === order.orderId,
  );
  const reservation = (raw.reservations ?? []).some(
    (entry) =>
      entry?.orderId === order.orderId &&
      ["reserved", "active", "pending"].includes(entry?.status),
  );
  return {
    paymentStatus: payment?.status ?? null,
    orderStatus: platformOrder?.status ?? null,
    paymentState: platformOrder?.paymentState ?? null,
    reservedInventory: reservation,
  };
}

async function waitForTerminal(input, runId, machineCode, order, timeoutMs) {
  return await waitForCondition(
    () => platformReport(input, runId, machineCode),
    (report) => {
      const terminal = terminalFromReport(report, order);
      return (
        terminal.reservedInventory === false &&
        ["failed", "canceled", "expired"].includes(terminal.paymentStatus)
      );
    },
    { timeoutMs, label: `terminal state for ${order.orderNo}` },
  );
}

async function closePayment(input, token, order) {
  return await api(
    input,
    `/payments/${encodeURIComponent(order.paymentId)}/incident-actions`,
    {
      method: "POST",
      token,
      body: {
        action: "close_or_reverse_uncertain_payment",
        reason: `payment provider VM acceptance closes unpaid ${order.orderNo}`,
      },
    },
  );
}

async function waitForPreScanQueryEvidence(input, token, order, timeoutMs) {
  return await waitForCondition(
    async () => {
      const page = await api(
        input,
        `/payments/reconciliation-attempts?paymentNo=${encodeURIComponent(order.paymentNo)}&trigger=manual&page=1&pageSize=5`,
        { token },
      );
      return (
        (page?.items ?? []).find(
          (entry) => entry?.paymentId === order.paymentId,
        ) ?? null
      );
    },
    (attempt) =>
      attempt?.id &&
      attempt?.paymentId === order.paymentId &&
      attempt?.providerCode === "alipay" &&
      attempt?.status === "provider_trade_not_exist" &&
      attempt?.providerPaymentStatus === "pending",
    { timeoutMs, label: `pre-scan query evidence for ${order.orderNo}` },
  );
}

async function connectMachineUi(handoff) {
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

async function readVisiblePaymentSurface(client) {
  return await evaluateExpression(
    client,
    `(() => {
          const el = document.querySelector('[data-installed-kiosk-sale-payment-surface]');
          return el && el.getClientRects().length ? {
            orderId: el.dataset.orderId || null,
            paymentId: el.dataset.paymentId || null,
            orderNo: el.dataset.orderNo || null,
            paymentNo: el.dataset.paymentNo || null,
            paymentUrl: el.dataset.paymentUrl || null,
            paymentMethod: el.dataset.paymentMethod || null,
            providerCode: el.dataset.paymentProvider || null,
            route: location.hash,
            scannerPrompt: el.dataset.paymentMethod === 'payment_code'
              ? (el.querySelector('.payment-code-panel')?.textContent || '').trim()
              : null
          } : null;
        })()`,
  );
}

async function visiblePaymentSurface(client, method, timeoutMs) {
  return await waitForCondition(
    () => readVisiblePaymentSurface(client),
    (surface) =>
      surface?.paymentMethod === method &&
      surface?.providerCode === "alipay" &&
      typeof surface?.orderId === "string" &&
      typeof surface?.paymentId === "string",
    { timeoutMs, label: `visible ${method} Alipay payment surface` },
  );
}

async function submitUntilPaymentSurface(client, method, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let submitCount = 0;
  while (Date.now() < deadline) {
    const surface = await readVisiblePaymentSurface(client);
    if (
      surface?.paymentMethod === method &&
      surface?.providerCode === "alipay" &&
      typeof surface?.orderId === "string" &&
      typeof surface?.paymentId === "string"
    ) {
      return surface;
    }
    const submitReady = await evaluateExpression(
      client,
      `(() => {
        const el = document.querySelector('[data-test="checkout-submit"]');
        return Boolean(el && !el.disabled && el.getClientRects().length);
      })()`,
    );
    if (submitReady && submitCount < 3) {
      await activateVisibleSelector(
        client,
        '[data-test="checkout-submit"]:not(:disabled)',
        { kind: "touch", timeoutMs: 5_000, pollMs: POLL_INTERVAL_MS },
      );
      submitCount += 1;
    }
    await sleep(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
  }
  return await visiblePaymentSurface(client, method, 1);
}

async function beginMachineUiOrder(client, input, fixture, method, timeoutMs) {
  await evaluateExpression(client, "location.hash = '#/catalog'");
  await waitForRoute(client, "#/catalog", {
    timeoutMs,
    pollMs: POLL_INTERVAL_MS,
  });
  const steps = [
    '[data-test="catalog-category"]:not(:disabled)',
    catalogProductSelectorForFixture(fixture, "sale"),
    '[data-test="product-buy"]:not(:disabled)',
    `[data-test="payment-option"][data-payment-option-key="${method}:alipay"]:not(:disabled)`,
  ];
  for (const selector of steps) {
    await activateVisibleSelector(client, selector, {
      kind: "touch",
      timeoutMs,
      pollMs: POLL_INTERVAL_MS,
    });
  }
  return await submitUntilPaymentSurface(client, method, timeoutMs);
}

async function cancelVisibleMachineOrder(client, timeoutMs) {
  await activateVisibleSelector(
    client,
    '[data-test="payment-cancel"]:not(:disabled)',
    {
      kind: "touch",
      timeoutMs,
      pollMs: POLL_INTERVAL_MS,
    },
  );
  await waitForRoute(client, /^#\/(products|catalog)/, {
    timeoutMs,
    pollMs: POLL_INTERVAL_MS,
  });
}

async function cleanAuthoritativeOrderBeforeDiagnostics(
  client,
  handoff,
  timeoutMs,
) {
  const initialRoute = await evaluateExpression(client, "location.hash");
  const visible = await evaluateExpression(
    client,
    "Boolean(document.querySelector('[data-installed-kiosk-sale-payment-surface]')?.getClientRects().length)",
  );
  if (visible && initialRoute === "#/payment") {
    const cancelReady = await evaluateExpression(
      client,
      "Boolean(document.querySelector('[data-test=\"payment-cancel\"]:not(:disabled)')?.getClientRects().length)",
    );
    if (cancelReady) {
      await cancelVisibleMachineOrder(client, timeoutMs);
    }
  }
  const transaction = await waitForCondition(
    () => daemon(handoff, "/v1/transactions/current"),
    (current) =>
      current == null ||
      current?.orderId == null ||
      ["canceled", "failed", "expired"].includes(current?.paymentStatus),
    { timeoutMs, label: "authoritative order cleanup before diagnostics" },
  );
  const route = await evaluateExpression(client, "location.hash");
  if (/^#\/result\//.test(route)) {
    await activateVisibleSelector(
      client,
      ".result-return-button, .failure-return-button",
      { kind: "touch", timeoutMs, pollMs: POLL_INTERVAL_MS },
    );
    await waitForRoute(client, "#/catalog", {
      timeoutMs,
      pollMs: POLL_INTERVAL_MS,
    });
  } else if (!["#/catalog", "#/products"].includes(route)) {
    await evaluateExpression(client, "location.hash = '#/catalog'");
    await waitForRoute(client, "#/catalog", {
      timeoutMs,
      pollMs: POLL_INTERVAL_MS,
    });
  }
  return { machineBoundary: "installed_machine_ui_cdp", transaction };
}

async function paymentCodeAttemptFromApi(input, token, order, timeoutMs) {
  return await waitForCondition(
    async () => {
      const page = await api(
        input,
        `/payments/payment-code-attempts?orderNo=${encodeURIComponent(order.orderNo)}&providerCode=alipay&page=1&pageSize=10`,
        { token },
      );
      const attempt = (page?.items ?? []).find(
        (entry) =>
          entry?.orderId === order.orderId &&
          entry?.paymentNo === order.paymentNo &&
          entry?.providerCode === "alipay",
      );
      if (
        attempt?.status === "querying" &&
        typeof attempt?.failureCode === "string" &&
        attempt.failureCode.length > 0
      ) {
        throw new Error(
          `Alipay payment-code provider call remained uncertain: ${attempt.failureCode}`,
        );
      }
      return attempt;
    },
    (attempt) => {
      const rejected =
        attempt?.status === "failed" &&
        typeof attempt?.failureCode === "string" &&
        attempt.failureCode.length > 0;
      const awaitingBuyer =
        attempt?.status === "user_confirming" &&
        attempt?.providerStatus === "WAIT_BUYER_PAY" &&
        typeof attempt?.providerTradeNo === "string" &&
        attempt.providerTradeNo.length > 0;
      return (
        typeof attempt?.id === "string" &&
        attempt.id.length > 0 &&
        (rejected || awaitingBuyer)
      );
    },
    {
      timeoutMs,
      label: `provider handled payment-code attempt for ${order.orderNo}`,
    },
  );
}

async function qrAttempt({
  input,
  client,
  token,
  runId,
  machineCode,
  timeoutMs,
  provider,
  setStage,
}) {
  const surface = await beginMachineUiOrder(
    client,
    input,
    input.fixtureAllocation,
    "qr_code",
    timeoutMs,
  );
  const order = orderIdentity({
    ...surface,
    paymentProviderCode: surface.providerCode,
  });
  const credential = {
    paymentUrlSha256:
      typeof surface.paymentUrl === "string" && surface.paymentUrl.length > 0
        ? `sha256:${createHash("sha256").update(surface.paymentUrl).digest("hex")}`
        : null,
  };
  if (!credential.paymentUrlSha256)
    throw new Error("Alipay QR credential is empty");
  setStage("query");
  const queryResult = await api(
    input,
    `/payments/${encodeURIComponent(order.paymentId)}/incident-actions`,
    {
      method: "POST",
      token,
      body: {
        action: "query_payment",
        reason: `payment provider VM acceptance queries ${order.orderNo} before scan`,
      },
    },
  );
  const reconciliation = await waitForPreScanQueryEvidence(
    input,
    token,
    order,
    timeoutMs,
  );
  const query = {
    reconciliationAttemptId: reconciliation.id,
    providerCode: reconciliation.providerCode,
    status: reconciliation.status,
    providerPaymentStatus: reconciliation.providerPaymentStatus,
    evidence: sanitizeProviderEvidence({
      incidentActionStatus: queryResult?.status ?? null,
      reconciliationStatus: reconciliation.status,
      providerPaymentStatus: reconciliation.providerPaymentStatus,
    }),
  };
  if (
    !query.reconciliationAttemptId ||
    query.providerCode !== "alipay" ||
    query.status !== "provider_trade_not_exist" ||
    query.providerPaymentStatus !== "pending"
  ) {
    throw new Error(
      "pre-scan Alipay query did not expose a real TRADE_NOT_EXIST reconciliation projection",
    );
  }
  setStage("closure");
  const closure = sanitizeProviderEvidence(
    await closePayment(input, token, order),
  );
  setStage("terminal-state");
  const report = await waitForTerminal(
    input,
    runId,
    machineCode,
    order,
    timeoutMs,
  );
  const attempt = {
    channel: "qr_code:alipay",
    order,
    machine: {
      boundary: "installed_machine_ui_cdp",
      paymentMethod: surface.paymentMethod,
      providerCode: surface.providerCode,
      surface: {
        orderId: surface.orderId,
        paymentId: surface.paymentId,
        orderNo: surface.orderNo,
        route: surface.route,
      },
    },
    credential,
    query,
    closure: { ...closure, providerConfigId: provider.providerConfigId },
    terminal: terminalFromReport(report, order),
  };
  validateUnattendedProviderAttempt(attempt);
  await activateVisibleSelector(
    client,
    ".result-return-button, .failure-return-button",
    {
      kind: "touch",
      timeoutMs,
      pollMs: POLL_INTERVAL_MS,
    },
  );
  await waitForRoute(client, "#/catalog", {
    timeoutMs,
    pollMs: POLL_INTERVAL_MS,
  });
  return attempt;
}

export function buildPaymentCodeSubmission(row) {
  return {
    status: row.status,
    providerCode: row.providerCode,
    attemptId: row.id,
    failureCode: row.failureCode ?? null,
    providerStatus: row.providerStatus ?? null,
    evidence: sanitizeProviderEvidence({
      providerStatus: row.providerStatus,
      failureCode: row.failureCode,
      failureMessage: row.failureMessage,
    }),
  };
}

async function paymentCodeAttempt({
  input,
  handoff,
  handoffPath,
  client,
  token,
  timeoutMs,
  provider,
  setStage,
}) {
  const { replacement: session } = await replaceSerialSessionAndUpdateHandoff({
    guestInput: input,
    handoff,
    handoffPath,
    sessionId: required(
      handoff?.commissioningSerialSession?.sessionId,
      "handoff commissioning serial session id",
    ),
    control,
  });
  let order = null;
  let completedAttempt = null;
  let authoritativeError = null;
  try {
    setStage("creation");
    const surface = await beginMachineUiOrder(
      client,
      input,
      input.fixtureAllocation,
      "payment_code",
      timeoutMs,
    );
    order = orderIdentity({
      ...surface,
      paymentProviderCode: surface.providerCode,
    });
    setStage("customer-code-submission");
    await control(
      input,
      `/v1/serial-sessions/${required(session.sessionId, "serial session id")}/inject`,
      {
        orderId: order.orderId,
        paymentId: order.paymentId,
        scannerCodeBase64: Buffer.from(
          UNATTENDED_ALIPAY_CUSTOMER_CODE,
        ).toString("base64"),
      },
    );
    setStage("notification");
    const row = await paymentCodeAttemptFromApi(input, token, order, timeoutMs);
    setStage("closure");
    const closure = sanitizeProviderEvidence(
      await closePayment(input, token, order),
    );
    setStage("terminal-state");
    const terminalReport = await waitForTerminal(
      input,
      runId,
      machineCode,
      order,
      timeoutMs,
    );
    completedAttempt = {
      channel: "payment_code:alipay",
      order,
      machine: {
        boundary: "installed_machine_ui_cdp",
        paymentMethod: surface.paymentMethod,
        providerCode: surface.providerCode,
        surface: {
          orderId: surface.orderId,
          paymentId: surface.paymentId,
          orderNo: surface.orderNo,
          route: surface.route,
        },
        scannerPrompt: surface.scannerPrompt,
      },
      submission: buildPaymentCodeSubmission(row),
      cleanup: {
        action: "close_or_reverse_uncertain_payment",
        closure,
        providerConfigId: provider.providerConfigId,
        serialSession: null,
      },
      terminal: terminalFromReport(terminalReport, order),
    };
  } catch (error) {
    authoritativeError = error;
    if (order) {
      try {
        await closePayment(input, token, order);
        await waitForTerminal(input, runId, machineCode, order, timeoutMs);
      } catch {
        // Preserve the provider failure; bounded diagnostics report cleanup separately.
      }
    }
    throw error;
  } finally {
    try {
      setStage("serial-cleanup");
      const serialCleanup = await control(
        input,
        `/v1/serial-sessions/${required(session.sessionId, "serial session id")}/abort`,
      );
      if (serialCleanup?.aborted !== true) {
        throw new Error(
          "payment-code serial session abort did not confirm cleanup",
        );
      }
      if (completedAttempt)
        completedAttempt.cleanup.serialSession = {
          action: "abort",
          aborted: true,
          cleanup: sanitizeProviderEvidence(serialCleanup.cleanup),
        };
    } catch (cleanupError) {
      if (!authoritativeError) throw cleanupError;
    }
  }
  validateUnattendedProviderAttempt(completedAttempt);
  return completedAttempt;
}

export function validateUnattendedProviderAttempt(attempt) {
  const order = attempt?.order;
  if (
    order?.providerCode !== "alipay" ||
    !order?.orderId ||
    !order?.paymentId ||
    !order?.orderNo
  ) {
    throw new Error("provider attempt is not correlated to one Alipay order");
  }
  const terminal = attempt?.terminal ?? {};
  if (terminal.reservedInventory !== false)
    throw new Error("provider attempt left reserved inventory");
  if (
    ["succeeded", "paid", "fulfilled"].includes(terminal.paymentStatus) ||
    ["paid", "fulfilled"].includes(terminal.paymentState)
  ) {
    throw new Error(
      "unattended provider attempt must not claim a paid customer result",
    );
  }
  if (attempt.channel === "qr_code:alipay") {
    if (
      attempt.machine?.boundary !== "installed_machine_ui_cdp" ||
      attempt.machine?.paymentMethod !== "qr_code" ||
      attempt.machine?.providerCode !== "alipay" ||
      attempt.machine?.surface?.orderId !== order.orderId ||
      attempt.machine?.surface?.paymentId !== order.paymentId ||
      attempt.machine?.surface?.orderNo !== order.orderNo ||
      !String(attempt.credential?.paymentUrlSha256 ?? "").startsWith(
        "sha256:",
      ) ||
      !attempt.query?.reconciliationAttemptId ||
      attempt.query?.providerCode !== "alipay" ||
      attempt.query?.status !== "provider_trade_not_exist" ||
      attempt.query?.providerPaymentStatus !== "pending" ||
      attempt.closure?.action !== "close_or_reverse_uncertain_payment" ||
      attempt.closure?.handled !== true ||
      !attempt.closure?.providerConfigId ||
      !["canceled", "expired"].includes(terminal.paymentStatus)
    ) {
      throw new Error(
        "QR provider attempt did not prove credential, pre-scan query, and closure",
      );
    }
    return;
  }
  if (attempt.channel === "payment_code:alipay") {
    if (
      attempt.machine?.boundary !== "installed_machine_ui_cdp" ||
      attempt.machine?.paymentMethod !== "payment_code" ||
      attempt.machine?.providerCode !== "alipay" ||
      attempt.machine?.surface?.orderId !== order.orderId ||
      attempt.machine?.surface?.paymentId !== order.paymentId ||
      attempt.machine?.surface?.orderNo !== order.orderNo ||
      !String(attempt.machine?.scannerPrompt ?? "").includes("请出示付款码") ||
      !["failed", "user_confirming"].includes(attempt.submission?.status) ||
      attempt.submission?.providerCode !== "alipay" ||
      !attempt.submission?.attemptId ||
      !attempt.submission?.providerStatus ||
      (attempt.submission?.status === "failed" &&
        !attempt.submission?.failureCode) ||
      (attempt.submission?.status === "user_confirming" &&
        attempt.submission?.providerStatus !== "WAIT_BUYER_PAY") ||
      attempt.cleanup?.action !== "close_or_reverse_uncertain_payment" ||
      attempt.cleanup?.closure?.handled !== true ||
      !attempt.cleanup?.providerConfigId ||
      attempt.cleanup?.serialSession?.action !== "abort" ||
      attempt.cleanup?.serialSession?.aborted !== true ||
      !["failed", "canceled", "expired"].includes(terminal.paymentStatus)
    ) {
      throw new Error(
        "payment-code provider attempt did not prove gateway handling and deterministic closure",
      );
    }
    return;
  }
  throw new Error("unsupported unattended payment provider channel");
}

export function buildProviderFailureReport({
  runId,
  stage,
  error,
  diagnostics = [],
  report = {},
}) {
  if (!PROVIDER_FAILURE_STAGES.has(stage)) {
    throw new Error(`payment provider failure stage is invalid: ${stage}`);
  }
  return {
    ...report,
    schemaVersion: SCHEMA_VERSION,
    ok: false,
    runId,
    stage,
    error: { message: boundedText(errorMessage(error)) },
    diagnostics: diagnostics
      .slice(0, MAX_DIAGNOSTIC_ATTEMPTS)
      .map(sanitizeProviderEvidence),
  };
}

export async function collectPaymentProviderFailureEvidence({
  cleanAuthoritativeOrder,
  diagnosticRetries: collectDiagnostics,
}) {
  let cleanupBeforeDiagnostics;
  try {
    cleanupBeforeDiagnostics = await cleanAuthoritativeOrder();
  } catch (error) {
    cleanupBeforeDiagnostics = {
      ok: false,
      error: { message: boundedText(errorMessage(error)) },
    };
  }

  let diagnostics;
  try {
    diagnostics = await collectDiagnostics();
  } catch (error) {
    diagnostics = [{ error: { message: boundedText(errorMessage(error)) } }];
  }
  return { cleanupBeforeDiagnostics, diagnostics };
}

async function diagnosticRetries(context, failedStage) {
  const diagnostics = [];
  for (
    let attemptNo = 1;
    attemptNo <= MAX_DIAGNOSTIC_ATTEMPTS;
    attemptNo += 1
  ) {
    try {
      const surface = await beginMachineUiOrder(
        context.client,
        context.input,
        context.input.fixtureAllocation,
        "qr_code",
        context.timeoutMs,
      );
      const order = orderIdentity({
        ...surface,
        paymentProviderCode: surface.providerCode,
      });
      const closure = await closePayment(context.input, context.token, order);
      const terminalReport = await waitForTerminal(
        context.input,
        context.runId,
        context.machineCode,
        order,
        context.timeoutMs,
      );
      diagnostics.push({
        attemptNo,
        failedStage,
        order: {
          orderId: order.orderId,
          paymentId: order.paymentId,
          orderNo: order.orderNo,
        },
        closure: sanitizeProviderEvidence(closure),
        terminal: terminalFromReport(terminalReport, order),
      });
    } catch (error) {
      diagnostics.push({
        attemptNo,
        failedStage,
        error: { message: boundedText(errorMessage(error)) },
      });
    }
  }
  return diagnostics;
}

export async function runPaymentProviderGuest(options) {
  const input = readJson(options.guestInputPath);
  const handoff = readJson(options.handoffPath);
  const runId = required(input.runId, "runId");
  const machineCode = required(input.machineCode, "machineCode");
  const timeoutMs = DEFAULT_TIMEOUT_MS;
  let stage = "host-preparation";
  let token = null;
  let client = null;
  let provider = null;
  const report = {
    schemaVersion: SCHEMA_VERSION,
    ok: false,
    mode: options.mode,
    runId,
    machineCode,
    environment: null,
    fixture: null,
    authoritative: { ok: false, attempts: [] },
    diagnostics: [],
  };
  try {
    provider = providerIdentity(input);
    token = await adminToken(input);
    report.provider = {
      identity: provider,
      hostPreparation: input.paymentProvider.hostPreparation,
    };
    stage = "readiness";
    const readiness = await waitForProviderReadiness(handoff, timeoutMs);
    report.environment = sanitizeProviderEvidence(readiness.environment);
    client = await connectMachineUi(handoff);
    await cleanAuthoritativeOrderBeforeDiagnostics(client, handoff, timeoutMs);
    stage = "creation";
    report.authoritative.attempts.push(
      await qrAttempt({
        input,
        client,
        token,
        runId,
        machineCode,
        timeoutMs,
        provider,
        setStage: (next) => {
          stage = next;
        },
      }),
    );
    stage = "creation";
    for (
      let attemptNo = 1;
      attemptNo <= MAX_PAYMENT_CODE_PROVIDER_ATTEMPTS;
      attemptNo += 1
    ) {
      try {
        report.authoritative.attempts.push(
          await paymentCodeAttempt({
            input,
            handoff: readJson(options.handoffPath),
            handoffPath: options.handoffPath,
            client,
            token,
            timeoutMs,
            provider,
            setStage: (next) => {
              stage = next;
            },
          }),
        );
        break;
      } catch (error) {
        if (
          attemptNo === MAX_PAYMENT_CODE_PROVIDER_ATTEMPTS ||
          !isRetryableAlipaySandboxError(error)
        ) {
          throw error;
        }
        await cleanAuthoritativeOrderBeforeDiagnostics(
          client,
          readJson(options.handoffPath),
          PAYMENT_CODE_CLEANUP_TIMEOUT_MS,
        );
        stage = "creation";
      }
    }
    report.authoritative.ok = true;
    report.ok = true;
    writeJson(options.outPath, report);
    return report;
  } catch (error) {
    if (token && client) {
      const recovery = await collectPaymentProviderFailureEvidence({
        cleanAuthoritativeOrder: () =>
          cleanAuthoritativeOrderBeforeDiagnostics(client, handoff, timeoutMs),
        diagnosticRetries: () =>
          diagnosticRetries(
            { input, client, token, runId, machineCode, timeoutMs },
            stage,
          ),
      });
      report.cleanupBeforeDiagnostics = recovery.cleanupBeforeDiagnostics;
      report.diagnostics = recovery.diagnostics;
    }
    const failed = buildProviderFailureReport({
      runId,
      stage,
      error,
      diagnostics: report.diagnostics,
      report,
    });
    writeJson(options.outPath, failed);
    throw error;
  } finally {
    await client?.close().catch(() => undefined);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runPaymentProviderGuest(
    parsePaymentProviderGuestArgs(process.argv.slice(2)),
  ).catch((error) => {
    process.stderr.write(`${boundedText(errorMessage(error))}\n`);
    process.exitCode = 1;
  });
}
