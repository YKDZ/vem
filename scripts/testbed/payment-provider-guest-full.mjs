#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const SCHEMA_VERSION = "vem-payment-provider-guest-full/v1";
const DEFAULT_FIXTURE_PATH =
  "C:\\ProgramData\\VEM\\testbed\\payment-provider-sandbox.fixture.json";
const DEFAULT_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 250;
const MAX_DIAGNOSTIC_ATTEMPTS = 2;
const INVALID_ALIPAY_CUSTOMER_CODE = "000000000000000000\\r\\n";

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

function fixturePath(input) {
  return input.paymentProviderFixture?.path ?? DEFAULT_FIXTURE_PATH;
}

export function validateHostLocalSandboxFixture(fixture) {
  if (
    fixture?.schemaVersion !== "vem-host-local-alipay-sandbox-fixture/v1" ||
    fixture?.ownership !== "host-local-installation" ||
    fixture?.target !== "local-service-api" ||
    fixture?.providerConfig?.providerCode !== "alipay"
  ) {
    throw new Error(
      "host-local Alipay sandbox fixture is invalid or not installation-owned",
    );
  }
  return fixture;
}

function readHostLocalFixture(input) {
  const path = fixturePath(input);
  return { path, fixture: validateHostLocalSandboxFixture(readJson(path)) };
}

async function importHostLocalFixture(input, token, hostFixture) {
  const providerConfig = hostFixture.fixture.providerConfig;
  await api(input, "/payments/provider-configs", {
    method: "POST",
    token,
    body: providerConfig,
  });
  if (hostFixture.fixture.channelPolicy) {
    await api(input, "/payments/channel-policy", {
      method: "PUT",
      token,
      body: hostFixture.fixture.channelPolicy,
    });
  }
  return {
    ownership: hostFixture.fixture.ownership,
    source: "host_local_installation_fixture",
    imported: true,
    hasChannelPolicy: Boolean(hostFixture.fixture.channelPolicy),
  };
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

function selectSlot(saleView, fixture) {
  const slotCode = required(fixture?.slotCode, "fixture.slotCode");
  const item = (saleView?.items ?? []).find(
    (entry) => entry?.slotCode === slotCode,
  );
  if (!item?.inventoryId || !item?.slotId || !saleView?.planogramVersion) {
    throw new Error(`fixture slot ${slotCode} is not saleable`);
  }
  return {
    inventoryId: item.inventoryId,
    slotId: item.slotId,
    slotCode,
    planogramVersion: saleView.planogramVersion,
  };
}

function orderRequest(slot, method, runId, suffix) {
  return {
    ...slot,
    quantity: 1,
    paymentMethod: method,
    paymentProviderCode: "alipay",
    idempotencyKey:
      `payment-provider:${runId}:${suffix}:${crypto.randomUUID()}`.slice(
        0,
        128,
      ),
  };
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
      attempt?.status === "pending" &&
      attempt?.errorCode === "ACQ.TRADE_NOT_EXIST",
    { timeoutMs, label: `pre-scan query evidence for ${order.orderNo}` },
  );
}

async function qrAttempt({
  input,
  handoff,
  token,
  runId,
  machineCode,
  slot,
  timeoutMs,
}) {
  const snapshot = await daemon(
    handoff,
    "/v1/intents/create-order",
    orderRequest(slot, "qr_code", runId, "qr"),
  );
  const order = orderIdentity(snapshot);
  const credential = {
    present:
      typeof snapshot?.paymentUrl === "string" &&
      snapshot.paymentUrl.length > 0,
  };
  if (!credential.present) throw new Error("Alipay QR credential is empty");
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
    status: queryResult?.status ?? null,
    reconciliationState: "provider_trade_not_exist",
    evidence: sanitizeProviderEvidence({
      reconciliationStatus: reconciliation.status,
      errorCode: reconciliation.errorCode,
      providerPaymentStatus: reconciliation.providerPaymentStatus,
    }),
  };
  if (
    query.status !== "pending" ||
    query.reconciliationState !== "provider_trade_not_exist"
  ) {
    throw new Error(
      "pre-scan Alipay query did not expose provider_trade_not_exist pending semantics",
    );
  }
  const closure = sanitizeProviderEvidence(
    await closePayment(input, token, order),
  );
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
    credential,
    query,
    closure,
    terminal: terminalFromReport(report, order),
  };
  validateUnattendedProviderAttempt(attempt);
  return attempt;
}

async function paymentCodeAttempt({
  input,
  handoff,
  token,
  runId,
  machineCode,
  slot,
  timeoutMs,
}) {
  const session = await control(input, "/v1/serial-sessions/start", {
    runId,
    machineCode,
    saleCorrelationId: `sale-correlation://payment-provider/${crypto.randomUUID()}`,
    targetIdentity: required(
      input.hostControlPlane?.targetIdentity,
      "hostControlPlane.targetIdentity",
    ),
    runtimeBase: required(
      input.hostControlPlane?.runtimeBaseIdentity,
      "hostControlPlane.runtimeBaseIdentity",
    ),
  });
  let order = null;
  try {
    const snapshot = await daemon(
      handoff,
      "/v1/intents/create-order",
      orderRequest(slot, "payment_code", runId, "payment-code"),
    );
    order = orderIdentity(snapshot);
    await control(
      input,
      `/v1/serial-sessions/${required(session.sessionId, "serial session id")}/inject`,
      {
        orderId: order.orderId,
        paymentId: order.paymentId,
        scannerCodeBase64: Buffer.from(INVALID_ALIPAY_CUSTOMER_CODE).toString(
          "base64",
        ),
      },
    );
    const platform = await waitForCondition(
      () => platformReport(input, runId, machineCode),
      (report) =>
        (report?.raw?.paymentCodeAttempts ?? []).some(
          (entry) =>
            entry?.orderId === order.orderId &&
            entry?.paymentId === order.paymentId &&
            entry?.status === "failed" &&
            entry?.providerCode === "alipay",
        ),
      {
        timeoutMs,
        label: `failed Alipay payment-code attempt for ${order.orderNo}`,
      },
    );
    const row = platform.raw.paymentCodeAttempts.find(
      (entry) =>
        entry?.orderId === order.orderId &&
        entry?.paymentId === order.paymentId,
    );
    const terminalReport = await waitForTerminal(
      input,
      runId,
      machineCode,
      order,
      timeoutMs,
    );
    const attempt = {
      channel: "payment_code:alipay",
      order,
      submission: {
        status: row.status,
        providerCode: row.providerCode,
        attemptId: row.id,
        failureCode: row.failureCode ?? null,
        evidence: sanitizeProviderEvidence({
          providerStatus: row.providerStatus,
          failureCode: row.failureCode,
          failureMessage: row.failureMessage,
        }),
      },
      terminal: terminalFromReport(terminalReport, order),
    };
    validateUnattendedProviderAttempt(attempt);
    return attempt;
  } finally {
    const stopBody = order
      ? { orderId: order.orderId, paymentId: order.paymentId }
      : {};
    await control(
      input,
      `/v1/serial-sessions/${required(session.sessionId, "serial session id")}/stop`,
      stopBody,
    ).catch(() => undefined);
  }
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
      attempt.credential?.present !== true ||
      attempt.query?.status !== "pending" ||
      attempt.query?.reconciliationState !== "provider_trade_not_exist" ||
      attempt.closure?.action !== "close_or_reverse_uncertain_payment" ||
      attempt.closure?.handled !== true ||
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
      attempt.submission?.status !== "failed" ||
      attempt.submission?.providerCode !== "alipay" ||
      !attempt.submission?.attemptId ||
      !["failed", "canceled", "expired"].includes(terminal.paymentStatus)
    ) {
      throw new Error(
        "payment-code provider attempt did not prove an attributed gateway rejection",
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
  return {
    schemaVersion: SCHEMA_VERSION,
    ok: false,
    runId,
    stage,
    error: { message: boundedText(errorMessage(error)) },
    ...report,
    diagnostics: diagnostics
      .slice(0, MAX_DIAGNOSTIC_ATTEMPTS)
      .map(sanitizeProviderEvidence),
  };
}

async function diagnosticRetries(context, failedStage) {
  const diagnostics = [];
  for (
    let attemptNo = 1;
    attemptNo <= MAX_DIAGNOSTIC_ATTEMPTS;
    attemptNo += 1
  ) {
    try {
      const snapshot = await daemon(
        context.handoff,
        "/v1/intents/create-order",
        orderRequest(
          context.slot,
          "qr_code",
          context.runId,
          `diagnostic-${attemptNo}`,
        ),
      );
      const order = orderIdentity(snapshot);
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
  const timeoutMs =
    Number.isInteger(input.paymentProviderFixture?.businessTimeoutMs) &&
    input.paymentProviderFixture.businessTimeoutMs > 0
      ? input.paymentProviderFixture.businessTimeoutMs
      : DEFAULT_TIMEOUT_MS;
  let stage = "host-local-fixture";
  let token = null;
  let slot = null;
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
    const hostFixture = readHostLocalFixture(input);
    token = await adminToken(input);
    report.fixture = await importHostLocalFixture(input, token, hostFixture);
    stage = "readiness";
    const readiness = await waitForProviderReadiness(handoff, timeoutMs);
    report.environment = sanitizeProviderEvidence(readiness.environment);
    stage = "slot";
    const fixture =
      input.fixtureAllocation?.[options.fixtureKey ?? "paymentProvider"] ??
      input.fixtureAllocation?.sale;
    slot = selectSlot(await daemon(handoff, "/v1/sale-view"), fixture);
    stage = "qr-creation";
    report.authoritative.attempts.push(
      await qrAttempt({
        input,
        handoff,
        token,
        runId,
        machineCode,
        slot,
        timeoutMs,
      }),
    );
    stage = "payment-code-submission";
    report.authoritative.attempts.push(
      await paymentCodeAttempt({
        input,
        handoff,
        token,
        runId,
        machineCode,
        slot,
        timeoutMs,
      }),
    );
    report.authoritative.ok = true;
    report.ok = true;
    writeJson(options.outPath, report);
    return report;
  } catch (error) {
    if (token && slot) {
      report.diagnostics = await diagnosticRetries(
        { input, handoff, token, runId, machineCode, slot, timeoutMs },
        stage,
      );
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
