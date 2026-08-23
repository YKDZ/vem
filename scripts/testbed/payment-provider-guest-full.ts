#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { catalogProductSelectorForFixture } from "./full-workflow-fixtures.ts";
import {
  activateVisibleSelector,
  CdpClient,
  discoverMachineUiTarget,
  enablePageRuntime,
  evaluateExpression,
  readMachineRuntimeTraceSnapshot,
  rewriteWebSocketDebuggerUrl,
  setCdpLocationHash,
  waitForRoute,
} from "./machine-ui-cdp-driver.ts";
import { replaceSerialSessionAndUpdateHandoff } from "./serial-session-handoff.ts";

const SCHEMA_VERSION = "vem-payment-provider-guest-full/v1";
const DEFAULT_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 250;
const MAX_DIAGNOSTIC_ATTEMPTS = 2;
const PAYMENT_CODE_CLEANUP_TIMEOUT_MS = 360_000;
export const UNATTENDED_ALIPAY_CUSTOMER_CODE = "288888888888888888\r";
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
const DISPATCH_CHECKOUT_SUBMIT_DOM_CLICK_EXPRESSION = `(() => {
  const el = document.querySelector('[data-test="checkout-submit"]');
  if (!el || el.disabled || !el.getClientRects().length) return false;
  el.click();
  return true;
})()`;

type JsonRecord = Record<string, unknown>;
type InputRecord = JsonRecord;
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

function optionalOption(args: string[], name: string): string | null {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? null : required(args[index + 1], `--${name}`);
}

function localPath(value: unknown): string {
  const path = required(value, "Windows path");
  return process.platform === "win32"
    ? path
    : resolve(
        `/mnt/${path[0].toLowerCase()}/${path.slice(3).replaceAll("\\", "/")}`,
      );
}

function readJson(path: string): JsonRecord {
  return JSON.parse(readFileSync(localPath(path), "utf8")) as JsonRecord;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(localPath(path)), { recursive: true });
  writeFileSync(localPath(path), `${JSON.stringify(value, null, 2)}\n`);
}

function unwrap(payload: unknown): unknown {
  const record = payload as JsonRecord | null;
  return record !== null &&
    typeof payload === "object" &&
    record.code === 0 &&
    Object.hasOwn(record, "data")
    ? record.data
    : payload;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function boundedText(value: unknown): string {
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

export function sanitizeProviderEvidence(value: unknown, depth = 0): unknown {
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

const ALIPAY_SANDBOX_UNCERTAIN_CODES = new Set([
  "aop.ACQ.SYSTEM_ERROR",
  "PAYMENT_CODE_QUERY_UNKNOWN",
]);

export function parsePaymentProviderGuestArgs(args: string[]): {
  mode: string;
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
    fixtureKey: optionalOption(args, "fixture-key"),
  };
}

function daemonBaseUrl(handoff: HandoffRecord): string {
  const daemon = handoff?.daemon as JsonRecord | undefined;
  const ready = daemon?.ready as JsonRecord | undefined;
  const healthzUrl = required(ready?.healthzUrl, "daemon healthzUrl");
  if (!healthzUrl.endsWith("/healthz"))
    throw new Error("daemon healthzUrl must end with /healthz");
  return healthzUrl.slice(0, -"/healthz".length);
}

async function json(url: string, options: JsonRecord = {}): Promise<unknown> {
  const response = await fetch(url, {
    ...options,
    signal:
      (options.signal as AbortSignal | undefined) ??
      AbortSignal.timeout(Number(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(
      `${options.method ?? "GET"} ${url} failed: ${JSON.stringify(sanitizeProviderEvidence(payload))}`,
    );
    (error as Error & { httpStatus?: number; payload?: unknown }).httpStatus =
      response.status;
    (error as Error & { httpStatus?: number; payload?: unknown }).payload =
      sanitizeProviderEvidence(payload);
    throw error;
  }
  return unwrap(payload);
}

function daemon(
  handoff: HandoffRecord,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const daemon = handoff?.daemon as JsonRecord | undefined;
  const ready = daemon?.ready as JsonRecord | undefined;
  return json(`${daemonBaseUrl(handoff)}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${required(ready?.ipcToken, "daemon ipcToken")}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
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
  {
    token = null,
    method = "GET",
    body,
  }: {
    token?: string | null;
    method?: string;
    body?: unknown;
  } = {},
): Promise<unknown> {
  return json(`${apiBase(input)}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function control(
  input: InputRecord,
  path: string,
  body: JsonRecord = {},
): Promise<unknown> {
  const plane = input.hostControlPlane as JsonRecord | undefined;
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

async function adminToken(input: InputRecord): Promise<string> {
  const serviceApi = input.serviceApi as JsonRecord | undefined;
  const result = await api(input, "/auth/login", {
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
  });
  return required(
    (result as JsonRecord | undefined)?.accessToken,
    "auth.login.accessToken",
  );
}

export function validateInstallationOwnedAlipaySandboxFixture(
  fixture: JsonRecord | null | undefined,
): JsonRecord {
  const providerConfig = fixture?.providerConfig as JsonRecord | undefined;
  const publicConfigJson = providerConfig?.publicConfigJson as
    | JsonRecord
    | undefined;
  const sensitiveConfigJson = providerConfig?.sensitiveConfigJson as
    | JsonRecord
    | undefined;
  if (
    fixture?.schemaVersion !== "vem-installation-alipay-sandbox-fixture/v1" ||
    fixture?.ownership !== "host-installation" ||
    fixture?.target !== "local-service-api" ||
    providerConfig?.providerCode !== "alipay" ||
    publicConfigJson?.mode !== "sandbox" ||
    publicConfigJson?.keyType !== "PKCS1" ||
    publicConfigJson?.gatewayUrl !==
      "https://openapi-sandbox.dl.alipaydev.com/gateway.do" ||
    typeof sensitiveConfigJson?.privateKeyPem !== "string" ||
    String(sensitiveConfigJson?.privateKeyPem ?? "").trim() === ""
  ) {
    throw new Error(
      "installation-owned Alipay sandbox fixture is invalid or incomplete",
    );
  }
  return fixture as JsonRecord;
}

function containsSecretMaterial(value: unknown, key = ""): boolean {
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

function providerIdentity(input: InputRecord): JsonRecord {
  const paymentProvider = input?.paymentProvider as JsonRecord | undefined;
  const identity = paymentProvider?.identity as JsonRecord | undefined;
  const hostPreparation = paymentProvider?.hostPreparation as
    | JsonRecord
    | undefined;
  if (
    containsSecretMaterial(paymentProvider) ||
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
    hostPreparation?.source !== "host_installation_fixture" ||
    hostPreparation?.preflight !== "configured"
  ) {
    throw new Error(
      "guest input must contain host-prepared Alipay identity without provider secrets",
    );
  }
  return identity as JsonRecord;
}

function alipayOptions(capability: JsonRecord | null | undefined): unknown[] {
  const paymentOptions = capability?.paymentOptions as JsonRecord | undefined;
  const options = (paymentOptions?.options ?? []) as unknown[];
  return options.filter(
    (option) =>
      (option as JsonRecord)?.providerCode === "alipay" &&
      (option as JsonRecord)?.ready === true,
  );
}

export async function waitForCondition(
  read: () => Promise<unknown>,
  matches: (value: unknown) => boolean,
  {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    label,
  }: {
    timeoutMs?: number;
    label: string;
  },
): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown = null;
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

async function waitForProviderReadiness(
  handoff: HandoffRecord,
  timeoutMs: number,
): Promise<unknown> {
  return (await waitForCondition(
    async () => ({
      environment: await daemon(handoff, "/v1/maintenance/payment-environment"),
      capability: await daemon(handoff, "/v1/sale-start-capability"),
    }),
    (state) => {
      const stateRecord = state as JsonRecord;
      const environment = stateRecord.environment as JsonRecord | undefined;
      const capability = stateRecord.capability as JsonRecord | undefined;
      return (
        environment?.environment === "sandbox" &&
        environment?.readiness === "ready" &&
        capability?.canStartSale === true &&
        ["qr_code:alipay", "payment_code:alipay"].every((key) =>
          alipayOptions(capability).some(
            (option) => (option as JsonRecord).optionKey === key,
          ),
        )
      );
    },
    { timeoutMs, label: "local Alipay sandbox readiness" },
  )) as JsonRecord;
}

function orderIdentity(snapshot: JsonRecord | null | undefined): JsonRecord {
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

async function platformReport(
  input: InputRecord,
  runId: string,
  machineCode: string,
): Promise<JsonRecord> {
  const response = (await control(input, "/v1/platform/query", {
    runId,
    machineCode,
  })) as JsonRecord;
  return response.report as JsonRecord;
}

function terminalFromReport(
  report: JsonRecord | null | undefined,
  order: JsonRecord,
): JsonRecord {
  const raw = (report?.raw ?? {}) as JsonRecord;
  const payments = (raw.payments ?? []) as unknown[];
  const orders = (raw.orders ?? []) as unknown[];
  const reservations = (raw.reservations ?? []) as unknown[];
  const payment = payments.find(
    (entry) => (entry as JsonRecord)?.id === order.paymentId,
  );
  const platformOrder = orders.find(
    (entry) => (entry as JsonRecord)?.id === order.orderId,
  );
  const reservation = reservations.some(
    (entry) =>
      (entry as JsonRecord)?.orderId === order.orderId &&
      ["reserved", "active", "pending"].includes(
        String((entry as JsonRecord)?.status),
      ),
  );
  return {
    paymentStatus: (payment as JsonRecord)?.status ?? null,
    orderStatus: (platformOrder as JsonRecord)?.status ?? null,
    paymentState: (platformOrder as JsonRecord)?.paymentState ?? null,
    reservedInventory: reservation,
  };
}

async function waitForTerminal(
  input: InputRecord,
  runId: string,
  machineCode: string,
  order: JsonRecord,
  timeoutMs: number,
): Promise<unknown> {
  const matched = await waitForCondition(
    () => platformReport(input, runId, machineCode),
    (report) => {
      const terminal = terminalFromReport(report as JsonRecord, order);
      return (
        terminal.reservedInventory === false &&
        (["failed", "canceled", "expired"].includes(
          String(terminal.paymentStatus),
        ) ||
          (terminal.paymentStatus === "unknown" &&
            terminal.orderStatus === "manual_handling"))
      );
    },
    { timeoutMs, label: `terminal state for ${order.orderNo}` },
  );
  return matched as JsonRecord;
}

async function closePayment(
  input: InputRecord,
  token: string,
  order: JsonRecord,
): Promise<unknown> {
  return await api(
    input,
    `/payments/${encodeURIComponent(String(order.paymentId))}/incident-actions`,
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

async function waitForPreScanQueryEvidence(
  input: InputRecord,
  token: string,
  order: JsonRecord,
  timeoutMs: number,
): Promise<unknown> {
  return await waitForCondition(
    async () => {
      const page = await api(
        input,
        `/payments/reconciliation-attempts?paymentNo=${encodeURIComponent(String(order.paymentNo))}&trigger=manual&page=1&pageSize=5`,
        { token },
      );
      const pageRecord = page as JsonRecord | null;
      const items = (pageRecord?.items ?? []) as unknown[];
      return (
        items.find(
          (entry) => (entry as JsonRecord)?.paymentId === order.paymentId,
        ) ?? null
      );
    },
    (attempt) => {
      const attemptRecord = attempt as JsonRecord | null;
      return (
        Boolean(attemptRecord?.id) &&
        attemptRecord?.paymentId === order.paymentId &&
        attemptRecord?.providerCode === "alipay" &&
        attemptRecord?.status === "provider_trade_not_exist" &&
        attemptRecord?.providerPaymentStatus === "pending"
      );
    },
    { timeoutMs, label: `pre-scan query evidence for ${order.orderNo}` },
  );
}

async function connectMachineUi(
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

async function readVisiblePaymentSurface(
  client: InstanceType<typeof CdpClient>,
): Promise<unknown> {
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

async function readPaymentFlowDiagnostic(
  client: InstanceType<typeof CdpClient>,
  method: string,
): Promise<JsonRecord> {
  const [diagnostic, traceSnapshot] = await Promise.all([
    evaluateExpression(
      client,
      `(() => {
      const submit = document.querySelector('[data-test="checkout-submit"]');
      const selected = document.querySelector('[data-test="payment-option"].payment-option-selected');
      const surface = document.querySelector('[data-installed-kiosk-sale-payment-surface]');
      const visibleText = (selector) => Array.from(document.querySelectorAll(selector))
        .filter((el) => el && el.getClientRects().length)
        .map((el) => (el.textContent || '').trim())
        .filter(Boolean)
        .slice(0, 6);
      const submitEvents = Array.isArray(window.__VEM_PAYMENT_PROVIDER_SUBMIT_EVENTS__)
        ? window.__VEM_PAYMENT_PROVIDER_SUBMIT_EVENTS__
        : [];
      const submitEventSummary = submitEvents.reduce((summary, event) => {
        const key = event.type === 'click' && event.trusted === false
          ? 'domClick'
          : event.type;
        summary[key] = (summary[key] || 0) + 1;
        summary.lastType = event.type;
        summary.lastTrusted = event.trusted;
        return summary;
      }, {});
      return {
        expectedMethod: ${JSON.stringify(method)},
        route: location.hash,
        paymentSurface: surface && surface.getClientRects().length ? {
          orderId: surface.dataset.orderId || null,
          paymentId: surface.dataset.paymentId || null,
          paymentMethod: surface.dataset.paymentMethod || null,
          providerCode: surface.dataset.paymentProvider || null,
        } : null,
        checkout: {
          submitVisible: Boolean(submit?.getClientRects().length),
          submitDisabled: Boolean(submit?.disabled),
          submitText: (submit?.textContent || '').trim() || null,
          submitMethod: submit?.dataset.paymentMethod ?? null,
          submitProvider: submit?.dataset.paymentProvider ?? null,
          selectedOptionKey: selected?.dataset.paymentOptionKey ?? null,
        },
        customerMessages: visibleText('[role="alert"], .ant-message, .ant-alert, .checkout-error, .payment-error, [data-test*="error"]'),
        submitEventSummary,
        submitEvents: submitEvents.slice(-4),
      };
    })()`,
    ),
    readMachineRuntimeTraceSnapshot(client),
  ]);
  const traceRecord = traceSnapshot as JsonRecord | null;
  const runtimeEntries = Array.isArray(traceRecord?.entries)
    ? (traceRecord.entries as unknown[])
    : [];
  const checkoutSubmitTrace = runtimeEntries
    .filter((entry) => (entry as JsonRecord)?.type === "checkout_submit")
    .slice(-8)
    .map((entry) => {
      const entryRecord = entry as JsonRecord;
      return {
        phase: entryRecord.phase,
        canSubmit: entryRecord.canSubmit,
        loading: entryRecord.loading,
        selectedPaymentOptionKey: entryRecord.selectedPaymentOptionKey,
        customerErrorMessage: entryRecord.customerErrorMessage,
        orderNo: entryRecord.orderNo ?? null,
      };
    });
  return { ...(diagnostic as JsonRecord), checkoutSubmitTrace };
}

async function installCheckoutSubmitEventProbe(
  client: InstanceType<typeof CdpClient>,
): Promise<void> {
  await evaluateExpression(
    client,
    `(() => {
      window.__VEM_PAYMENT_PROVIDER_SUBMIT_EVENTS__ = [];
      if (window.__VEM_PAYMENT_PROVIDER_SUBMIT_PROBE_INSTALLED__) return true;
      const record = (event) => {
        const target = event.target?.closest?.('[data-test="checkout-submit"]');
        if (!target) return;
        window.__VEM_PAYMENT_PROVIDER_SUBMIT_EVENTS__.push({
          type: event.type,
          route: location.hash,
          trusted: event.isTrusted,
          disabled: Boolean(target.disabled),
          time: Date.now(),
        });
      };
      document.addEventListener('pointerdown', record, true);
      document.addEventListener('pointerup', record, true);
      document.addEventListener('click', record, true);
      window.__VEM_PAYMENT_PROVIDER_SUBMIT_PROBE_INSTALLED__ = true;
      return true;
    })()`,
  );
}

async function dispatchCheckoutSubmitDomClick(
  client: InstanceType<typeof CdpClient>,
): Promise<boolean> {
  const result = (await client.send("Runtime.evaluate", {
    expression: DISPATCH_CHECKOUT_SUBMIT_DOM_CLICK_EXPRESSION,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  })) as JsonRecord;
  const exceptionDetails = result.exceptionDetails as JsonRecord | undefined;
  if (result.exceptionDetails) {
    throw new Error(
      `Runtime.evaluate failed: ${String(exceptionDetails?.text ?? "exception")}`,
    );
  }
  const evaluateResult = result.result as JsonRecord | undefined;
  return evaluateResult?.value === true;
}

async function submitUntilPaymentSurface(
  client: InstanceType<typeof CdpClient>,
  method: string,
  timeoutMs: number,
): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  let submitCount = 0;
  let mouseClickCount = 0;
  let domClickCount = 0;
  await installCheckoutSubmitEventProbe(client);
  while (Date.now() < deadline) {
    const surface = (await readVisiblePaymentSurface(
      client,
    )) as JsonRecord | null;
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
    } else if (submitReady && mouseClickCount < 1) {
      await activateVisibleSelector(
        client,
        '[data-test="checkout-submit"]:not(:disabled)',
        { kind: "mouse", timeoutMs: 5_000, pollMs: POLL_INTERVAL_MS },
      );
      mouseClickCount += 1;
    } else if (submitReady && domClickCount < 1) {
      const dispatched = await dispatchCheckoutSubmitDomClick(client);
      if (dispatched) domClickCount += 1;
    }
    await sleep(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
  }
  const diagnostic = await readPaymentFlowDiagnostic(client, method);
  throw new Error(
    `visible ${method} Alipay payment surface did not appear after submit attempts: ${JSON.stringify(sanitizeProviderEvidence({ ...diagnostic, submitCount, mouseClickCount, domClickCount }))}`,
  );
}

async function readCheckoutPaymentSelection(
  client: InstanceType<typeof CdpClient>,
): Promise<unknown> {
  return await evaluateExpression(
    client,
    `(() => {
      const submit = document.querySelector('[data-test="checkout-submit"]');
      const selected = document.querySelector('[data-test="payment-option"].payment-option-selected');
      return {
        route: location.hash,
        submitVisible: Boolean(submit?.getClientRects().length),
        submitDisabled: Boolean(submit?.disabled),
        submitMethod: submit?.dataset.paymentMethod ?? null,
        submitProvider: submit?.dataset.paymentProvider ?? null,
        selectedOptionKey: selected?.dataset.paymentOptionKey ?? null,
      };
    })()`,
  );
}

async function waitForCheckoutPaymentSelection(
  client: InstanceType<typeof CdpClient>,
  method: string,
  timeoutMs: number,
): Promise<unknown> {
  return await waitForCondition(
    () => readCheckoutPaymentSelection(client),
    (selection) => {
      const selectionRecord = selection as JsonRecord | null;
      return (
        selectionRecord?.route === "#/checkout" &&
        selectionRecord?.submitVisible === true &&
        selectionRecord?.submitDisabled === false &&
        selectionRecord?.submitMethod === method &&
        selectionRecord?.submitProvider === "alipay"
      );
    },
    { timeoutMs, label: `checkout ${method} Alipay selection` },
  );
}

async function beginMachineUiOrder(
  client: InstanceType<typeof CdpClient>,
  input: InputRecord,
  fixture: JsonRecord | null | undefined,
  method: string,
  timeoutMs: number,
): Promise<unknown> {
  await setCdpLocationHash(client, "#/catalog");
  await waitForRoute(client, "#/catalog", {
    timeoutMs,
    pollMs: POLL_INTERVAL_MS,
  });
  await activateVisibleSelector(
    client,
    '[data-test="catalog-category"]:not(:disabled)',
    {
      kind: "touch",
      timeoutMs,
      pollMs: POLL_INTERVAL_MS,
    },
  );
  await activateVisibleSelector(
    client,
    catalogProductSelectorForFixture(fixture, "sale"),
    {
      kind: "touch",
      timeoutMs,
      pollMs: POLL_INTERVAL_MS,
    },
  );
  await waitForRoute(client, /^#\/products\//, {
    timeoutMs,
    pollMs: POLL_INTERVAL_MS,
  });
  await activateVisibleSelector(
    client,
    '[data-test="product-buy"]:not(:disabled)',
    {
      kind: "touch",
      timeoutMs,
      pollMs: POLL_INTERVAL_MS,
    },
  );
  await waitForRoute(client, "#/checkout", {
    timeoutMs,
    pollMs: POLL_INTERVAL_MS,
  });
  const selected = (await readCheckoutPaymentSelection(client)) as JsonRecord;
  if (
    selected?.submitMethod !== method ||
    selected?.submitProvider !== "alipay"
  ) {
    await activateVisibleSelector(
      client,
      `[data-test="payment-option"][data-payment-option-key="${method}:alipay"]:not(:disabled)`,
      {
        kind: "touch",
        timeoutMs,
        pollMs: POLL_INTERVAL_MS,
      },
    );
  }
  await waitForCheckoutPaymentSelection(client, method, timeoutMs);
  return await submitUntilPaymentSurface(client, method, timeoutMs);
}

async function cancelVisibleMachineOrder(
  client: InstanceType<typeof CdpClient>,
  timeoutMs: number,
): Promise<void> {
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

async function cancelCurrentDaemonOrder(
  handoff: HandoffRecord,
  current: JsonRecord | null | undefined,
): Promise<unknown> {
  const orderNo = required(current?.orderNo, "current transaction orderNo");
  return await daemon(handoff, "/v1/intents/cancel-order", { orderNo });
}

export function isCleanAuthoritativeTransaction(
  current: JsonRecord | null | undefined,
): boolean {
  if (current == null || current?.orderId == null) return true;
  const paymentStatus = String(current?.paymentStatus ?? "");
  const orderStatus = String(current?.orderStatus ?? "");
  if (["canceled", "failed", "expired", "refunded"].includes(paymentStatus)) {
    return true;
  }
  return paymentStatus === "succeeded" && orderStatus === "fulfilled";
}

async function cleanAuthoritativeOrderBeforeDiagnostics(
  client: InstanceType<typeof CdpClient>,
  handoff: HandoffRecord,
  timeoutMs: number,
): Promise<JsonRecord> {
  const initialRoute = String(
    await evaluateExpression(client, "location.hash"),
  );
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
  const routeBeforeCleanup = String(
    await evaluateExpression(client, "location.hash"),
  );
  if (/^#\/result\//.test(routeBeforeCleanup)) {
    await activateVisibleSelector(
      client,
      ".result-return-button, .failure-return-button",
      { kind: "touch", timeoutMs, pollMs: POLL_INTERVAL_MS },
    );
    await waitForRoute(client, "#/catalog", {
      timeoutMs,
      pollMs: POLL_INTERVAL_MS,
    });
  }
  const currentBeforeCleanup = await daemon(
    handoff,
    "/v1/transactions/current",
  );
  let daemonCancel = null;
  const currentRecord = currentBeforeCleanup as JsonRecord | null;
  if (!isCleanAuthoritativeTransaction(currentRecord)) {
    daemonCancel = await cancelCurrentDaemonOrder(handoff, currentRecord);
  }
  const transaction = await waitForCondition(
    () => daemon(handoff, "/v1/transactions/current"),
    (value) =>
      isCleanAuthoritativeTransaction(value as JsonRecord | null | undefined),
    { timeoutMs, label: "authoritative order cleanup before diagnostics" },
  );
  const route = String(await evaluateExpression(client, "location.hash"));
  if (!["#/catalog", "#/products"].includes(route)) {
    await setCdpLocationHash(client, "#/catalog");
    await waitForRoute(client, "#/catalog", {
      timeoutMs,
      pollMs: POLL_INTERVAL_MS,
    });
  }
  return {
    machineBoundary: "installed_machine_ui_cdp",
    transaction,
    daemonCancel,
  };
}

async function paymentCodeAttemptFromApi(
  input: InputRecord,
  token: string,
  order: JsonRecord,
  timeoutMs: number,
): Promise<JsonRecord> {
  const matched = await waitForCondition(
    async () => {
      const page = await api(
        input,
        `/payments/payment-code-attempts?orderNo=${encodeURIComponent(String(order.orderNo))}&providerCode=alipay&page=1&pageSize=10`,
        { token },
      );
      const pageRecord = page as JsonRecord | null;
      const items = (pageRecord?.items ?? []) as unknown[];
      const attempt = items.find(
        (entry) =>
          (entry as JsonRecord)?.orderId === order.orderId &&
          (entry as JsonRecord)?.paymentNo === order.paymentNo &&
          (entry as JsonRecord)?.providerCode === "alipay",
      );
      return attempt as JsonRecord;
    },
    (attempt) => {
      const attemptRecord = attempt as JsonRecord | null;
      const rejected =
        attemptRecord?.status === "failed" &&
        typeof attemptRecord?.failureCode === "string" &&
        String(attemptRecord?.failureCode ?? "").length > 0;
      const awaitingBuyer =
        attemptRecord?.status === "user_confirming" &&
        attemptRecord?.providerStatus === "WAIT_BUYER_PAY" &&
        typeof attemptRecord?.providerTradeNo === "string" &&
        String(attemptRecord?.providerTradeNo ?? "").length > 0;
      const uncertain =
        attemptRecord?.status === "querying" &&
        ALIPAY_SANDBOX_UNCERTAIN_CODES.has(
          String(attemptRecord?.failureCode ?? ""),
        );
      const reversed =
        attemptRecord?.status === "reversed" &&
        attemptRecord?.providerStatus === "cancel" &&
        attemptRecord?.failureCode === "payment_code_reverse_confirmed";
      return (
        typeof attemptRecord?.id === "string" &&
        String(attemptRecord?.id ?? "").length > 0 &&
        (rejected || awaitingBuyer || uncertain || reversed)
      );
    },
    {
      timeoutMs,
      label: `provider handled payment-code attempt for ${order.orderNo}`,
    },
  );
  return matched as JsonRecord;
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
  publishHandoffSerialSessionId,
}: {
  input: InputRecord;
  client: InstanceType<typeof CdpClient>;
  token: string;
  runId: string;
  machineCode: string;
  timeoutMs: number;
  provider: JsonRecord;
  setStage: (stage: string) => void;
  publishHandoffSerialSessionId?: (sessionId: string) => void;
}): Promise<JsonRecord> {
  const surface = (await beginMachineUiOrder(
    client,
    input,
    input.fixtureAllocation as JsonRecord | undefined,
    "qr_code",
    timeoutMs,
  )) as JsonRecord;
  const order = orderIdentity({
    ...surface,
    paymentProviderCode: surface.providerCode,
  });
  const credential = {
    paymentUrlSha256:
      typeof surface.paymentUrl === "string" && surface.paymentUrl.length > 0
        ? `sha256:${createHash("sha256").update(String(surface.paymentUrl)).digest("hex")}`
        : null,
  };
  if (!credential.paymentUrlSha256)
    throw new Error("Alipay QR credential is empty");
  setStage("query");
  const queryResult = (await api(
    input,
    `/payments/${encodeURIComponent(String(order.paymentId))}/incident-actions`,
    {
      method: "POST",
      token,
      body: {
        action: "query_payment",
        reason: `payment provider VM acceptance queries ${order.orderNo} before scan`,
      },
    },
  )) as JsonRecord | null;
  const reconciliation = (await waitForPreScanQueryEvidence(
    input,
    token,
    order,
    timeoutMs,
  )) as JsonRecord;
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
  const closureRecord = closure as JsonRecord | null;
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
    closure: {
      ...(closureRecord ?? {}),
      providerConfigId: provider.providerConfigId,
    },
    terminal: terminalFromReport(report as JsonRecord, order),
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

export function buildPaymentCodeSubmission(row: JsonRecord): JsonRecord {
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
  runId,
  machineCode,
  timeoutMs,
  provider,
  setStage,
  publishHandoffSerialSessionId,
}: {
  input: InputRecord;
  handoff: HandoffRecord;
  handoffPath: string;
  client: InstanceType<typeof CdpClient>;
  token: string;
  runId: string;
  machineCode: string;
  timeoutMs: number;
  provider: JsonRecord;
  setStage: (stage: string) => void;
  publishHandoffSerialSessionId: (sessionId: string) => void;
}): Promise<JsonRecord> {
  const replaced = (await replaceSerialSessionAndUpdateHandoff({
    guestInput: input,
    handoff,
    handoffPath,
    sessionId: required(
      (handoff?.commissioningSerialSession as JsonRecord | undefined)
        ?.sessionId,
      "handoff commissioning serial session id",
    ),
    control,
  })) as JsonRecord;
  const session = replaced.replacement as JsonRecord;
  publishHandoffSerialSessionId(
    required(session?.sessionId, "payment-code serial session id"),
  );
  let order: JsonRecord | null = null;
  let completedAttempt: JsonRecord | null = null;
  let authoritativeError: unknown = null;
  try {
    setStage("creation");
    const surface = (await beginMachineUiOrder(
      client,
      input,
      input.fixtureAllocation as JsonRecord | undefined,
      "payment_code",
      timeoutMs,
    )) as JsonRecord;
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
      terminal: terminalFromReport(terminalReport as JsonRecord, order),
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
      const serialCleanup = (await control(
        input,
        `/v1/serial-sessions/${required(session.sessionId, "serial session id")}/abort`,
      )) as JsonRecord | null;
      if (serialCleanup?.aborted !== true) {
        throw new Error(
          "payment-code serial session abort did not confirm cleanup",
        );
      }
      if (completedAttempt) {
        const cleanup = completedAttempt.cleanup as JsonRecord;
        cleanup.serialSession = {
          action: "abort",
          aborted: true,
          cleanup: sanitizeProviderEvidence(serialCleanup.cleanup),
        };
      }
    } catch (cleanupError) {
      if (!authoritativeError) throw cleanupError;
    }
  }
  validateUnattendedProviderAttempt(completedAttempt);
  return completedAttempt;
}

export function validateUnattendedProviderAttempt(
  attempt: JsonRecord | null | undefined,
): void {
  const order = attempt?.order as JsonRecord | undefined;
  if (
    order?.providerCode !== "alipay" ||
    !order?.orderId ||
    !order?.paymentId ||
    !order?.orderNo
  ) {
    throw new Error("provider attempt is not correlated to one Alipay order");
  }
  const terminal = (attempt?.terminal ?? {}) as JsonRecord;
  if (terminal.reservedInventory !== false)
    throw new Error("provider attempt left reserved inventory");
  if (
    ["succeeded", "paid", "fulfilled"].includes(
      String(terminal.paymentStatus),
    ) ||
    ["paid", "fulfilled"].includes(String(terminal.paymentState))
  ) {
    throw new Error(
      "unattended provider attempt must not claim a paid customer result",
    );
  }
  if (!attempt) throw new Error("provider attempt is missing");
  const machine = attempt.machine as JsonRecord | undefined;
  const surface = machine?.surface as JsonRecord | undefined;
  const credential = attempt.credential as JsonRecord | undefined;
  const query = attempt.query as JsonRecord | undefined;
  const closure = attempt.closure as JsonRecord | undefined;
  const cleanup = attempt.cleanup as JsonRecord | undefined;
  const submission = attempt.submission as JsonRecord | undefined;
  if (attempt.channel === "qr_code:alipay") {
    if (
      machine?.boundary !== "installed_machine_ui_cdp" ||
      machine?.paymentMethod !== "qr_code" ||
      machine?.providerCode !== "alipay" ||
      surface?.orderId !== order.orderId ||
      surface?.paymentId !== order.paymentId ||
      surface?.orderNo !== order.orderNo ||
      !String(credential?.paymentUrlSha256 ?? "").startsWith("sha256:") ||
      !query?.reconciliationAttemptId ||
      query?.providerCode !== "alipay" ||
      query?.status !== "provider_trade_not_exist" ||
      query?.providerPaymentStatus !== "pending" ||
      closure?.action !== "close_or_reverse_uncertain_payment" ||
      closure?.handled !== true ||
      !closure?.providerConfigId ||
      !(
        ["canceled", "expired"].includes(String(terminal.paymentStatus)) ||
        (terminal.paymentStatus === "unknown" &&
          terminal.orderStatus === "manual_handling")
      )
    ) {
      throw new Error(
        "QR provider attempt did not prove credential, pre-scan query, and closure",
      );
    }
    return;
  }
  if (attempt.channel === "payment_code:alipay") {
    const terminalCleaned =
      ["failed", "canceled", "expired"].includes(
        String(terminal.paymentStatus),
      ) ||
      (terminal.paymentStatus === "unknown" &&
        terminal.orderStatus === "manual_handling");
    const closureObservedCleanTerminal =
      (cleanup?.closure as JsonRecord | undefined)?.handled === true ||
      terminalCleaned;
    if (
      machine?.boundary !== "installed_machine_ui_cdp" ||
      machine?.paymentMethod !== "payment_code" ||
      machine?.providerCode !== "alipay" ||
      surface?.orderId !== order.orderId ||
      surface?.paymentId !== order.paymentId ||
      surface?.orderNo !== order.orderNo ||
      !["failed", "querying", "reversed", "user_confirming"].includes(
        String(submission?.status),
      ) ||
      submission?.providerCode !== "alipay" ||
      !submission?.attemptId ||
      (submission?.status === "failed" && !submission?.failureCode) ||
      (submission?.status === "user_confirming" &&
        submission?.providerStatus !== "WAIT_BUYER_PAY") ||
      (submission?.status === "querying" &&
        !ALIPAY_SANDBOX_UNCERTAIN_CODES.has(
          String(submission?.failureCode ?? ""),
        )) ||
      (submission?.status === "reversed" &&
        (submission?.providerStatus !== "cancel" ||
          submission?.failureCode !== "payment_code_reverse_confirmed")) ||
      cleanup?.action !== "close_or_reverse_uncertain_payment" ||
      !closureObservedCleanTerminal ||
      !cleanup?.providerConfigId ||
      (cleanup?.serialSession as JsonRecord | undefined)?.action !== "abort" ||
      (cleanup?.serialSession as JsonRecord | undefined)?.aborted !== true ||
      !terminalCleaned
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
}: {
  runId: string;
  stage: string;
  error: unknown;
  diagnostics?: unknown[];
  report?: JsonRecord;
}): JsonRecord {
  if (!PROVIDER_FAILURE_STAGES.has(stage)) {
    throw new Error(`payment provider failure stage is invalid: ${stage}`);
  }
  return {
    ...report,
    schemaVersion: SCHEMA_VERSION,
    ok: false,
    outcome: classifyProviderFailureOutcome({ stage, error, report }),
    runId,
    stage,
    error: { message: boundedText(errorMessage(error)) },
    diagnostics: diagnostics
      .slice(0, MAX_DIAGNOSTIC_ATTEMPTS)
      .map(sanitizeProviderEvidence),
  };
}

export function classifyProviderFailureOutcome({
  stage,
  error,
  report,
}: {
  stage: string;
  error: unknown;
  report: JsonRecord | null | undefined;
}): string {
  const message = errorMessage(error);
  const explicitProviderUnavailable =
    /支付宝支付通道暂不可用|aop\.ACQ\.SYSTEM_ERROR|ALIPAY_(?:REQUEST|QUERY|REVERSE)_UNKNOWN|gateway (?:time-out|timeout)/i.test(
      message,
    );
  const providerStage = [
    "creation",
    "customer-code-submission",
    "query",
    "notification",
    "closure",
  ].includes(stage);
  const cleanupBeforeDiagnostics = report?.cleanupBeforeDiagnostics as
    | JsonRecord
    | undefined;
  const cleanupProved =
    Boolean(cleanupBeforeDiagnostics) &&
    cleanupBeforeDiagnostics?.ok !== false &&
    !cleanupBeforeDiagnostics?.error;
  return providerStage && explicitProviderUnavailable && cleanupProved
    ? "provider_unavailable"
    : "failed";
}

export async function collectPaymentProviderFailureEvidence({
  cleanAuthoritativeOrder,
  diagnosticRetries: collectDiagnostics,
}: {
  cleanAuthoritativeOrder: () => Promise<unknown>;
  diagnosticRetries: () => Promise<unknown[]>;
}): Promise<JsonRecord> {
  let cleanupBeforeDiagnostics: unknown;
  try {
    cleanupBeforeDiagnostics = await cleanAuthoritativeOrder();
  } catch (error) {
    cleanupBeforeDiagnostics = {
      ok: false,
      error: { message: boundedText(errorMessage(error)) },
    };
  }

  let diagnostics: unknown;
  try {
    diagnostics = await collectDiagnostics();
  } catch (error) {
    diagnostics = [{ error: { message: boundedText(errorMessage(error)) } }];
  }
  return { cleanupBeforeDiagnostics, diagnostics };
}

async function diagnosticRetries(
  context: {
    input: InputRecord;
    client: InstanceType<typeof CdpClient>;
    token: string;
    runId: string;
    machineCode: string;
    timeoutMs: number;
  },
  failedStage: string,
): Promise<unknown[]> {
  const diagnostics: unknown[] = [];
  for (
    let attemptNo = 1;
    attemptNo <= MAX_DIAGNOSTIC_ATTEMPTS;
    attemptNo += 1
  ) {
    try {
      const surface = (await beginMachineUiOrder(
        context.client,
        context.input,
        context.input.fixtureAllocation as JsonRecord | undefined,
        "qr_code",
        context.timeoutMs,
      )) as JsonRecord;
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
        terminal: terminalFromReport(terminalReport as JsonRecord, order),
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

export async function runPaymentProviderGuest(options: {
  mode: string;
  guestInputPath: string;
  handoffPath: string;
  outPath: string;
  fixtureKey: string | null;
}): Promise<JsonRecord> {
  const input = readJson(options.guestInputPath);
  const handoff = readJson(options.handoffPath);
  const runId = required(input.runId, "runId");
  const machineCode = required(input.machineCode, "machineCode");
  const timeoutMs = DEFAULT_TIMEOUT_MS;
  let stage = "host-preparation";
  let token: string | null = null;
  let client: InstanceType<typeof CdpClient> | null = null;
  let provider: JsonRecord | null = null;
  const report: JsonRecord = {
    schemaVersion: SCHEMA_VERSION,
    ok: false,
    outcome: "failed",
    mode: options.mode,
    runId,
    machineCode,
    handoffSerialSessionId: null,
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
      hostPreparation: (input.paymentProvider as JsonRecord).hostPreparation,
    };
    stage = "readiness";
    const readiness = (await waitForProviderReadiness(
      handoff,
      timeoutMs,
    )) as JsonRecord;
    report.environment = sanitizeProviderEvidence(readiness.environment);
    client = await connectMachineUi(handoff);
    await cleanAuthoritativeOrderBeforeDiagnostics(client, handoff, timeoutMs);
    stage = "creation";
    const authoritative = report.authoritative as JsonRecord;
    const attempts = (authoritative.attempts as unknown[]) ?? [];
    attempts.push(
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
    authoritative.attempts = attempts;
    stage = "creation";
    attempts.push(
      await paymentCodeAttempt({
        input,
        handoff,
        handoffPath: options.handoffPath,
        client,
        token,
        runId,
        machineCode,
        timeoutMs: PAYMENT_CODE_CLEANUP_TIMEOUT_MS,
        provider,
        publishHandoffSerialSessionId: (sessionId) => {
          report.handoffSerialSessionId = sessionId;
        },
        setStage: (next) => {
          stage = next;
        },
      }),
    );
    authoritative.attempts = attempts;
    await cleanAuthoritativeOrderBeforeDiagnostics(client, handoff, timeoutMs);
    authoritative.ok = true;
    report.ok = true;
    report.outcome = "passed";
    writeJson(options.outPath, report);
    return report;
  } catch (error) {
    if (token && client) {
      const activeClient = client;
      const activeToken = token;
      const recovery = await collectPaymentProviderFailureEvidence({
        cleanAuthoritativeOrder: () =>
          cleanAuthoritativeOrderBeforeDiagnostics(
            activeClient,
            handoff,
            timeoutMs,
          ),
        diagnosticRetries: () =>
          diagnosticRetries(
            {
              input,
              client: activeClient,
              token: activeToken,
              runId,
              machineCode,
              timeoutMs,
            },
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
      diagnostics: (report.diagnostics as unknown[] | undefined) ?? [],
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
