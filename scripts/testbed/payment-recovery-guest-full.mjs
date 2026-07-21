#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SCHEMA_VERSION = "vem-payment-recovery-guest-full/v1";
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
function daemon(handoff, path, body) {
  return json(`${daemonUrl(handoff)}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: daemonHeaders(handoff),
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
export async function refreshAdminAccessToken(input, login = api) {
  const result = await login(input, "/auth/login", {
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
    const page = await query(input, "/machines?page=1&pageSize=100", {
      method: "GET",
      token: required(token, "admin access token"),
    });
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
export function selectCanonicalSlot(saleView, fixture) {
  const slotCode = required(fixture?.slotCode, "fixture.slotCode");
  const item = (saleView?.items ?? []).find(
    (entry) => entry?.slotCode === slotCode,
  );
  if (!item?.slotId || !item.inventoryId || saleView?.planogramVersion == null)
    throw new Error(
      `canonical slot ${slotCode} is not saleable in daemon sale-view`,
    );
  return {
    slotCode,
    slotId: item.slotId,
    inventoryId: item.inventoryId,
    planogramVersion: saleView.planogramVersion,
  };
}
function capturedMqttMessages(evidence) {
  return [
    ...(evidence?.mqtt?.messages ?? []),
    ...(evidence?.machineMqtt?.messages ?? []),
  ];
}
export function mqttEvidenceMatchesPayment(evidence, payment) {
  const identities = [payment?.id, payment?.paymentNo, payment?.orderNo].filter(
    (value) => typeof value === "string" && value !== "",
  );
  return capturedMqttMessages(evidence).some((message) => {
    const serialized = JSON.stringify(message);
    return identities.some((identity) => serialized.includes(identity));
  });
}
export function validatePaymentRecoveryEvidence(report) {
  if (report?.schemaVersion !== SCHEMA_VERSION || report.ok !== true)
    throw new Error("payment recovery report is not successful");
  if (
    report.boundaries?.serviceApi !== true ||
    report.boundaries?.mqtt !== true ||
    report.boundaries?.daemon !== true ||
    report.payment?.id == null
  )
    throw new Error("payment recovery boundaries are incomplete");
  if (
    !report.recovery?.action ||
    !["query_payment", "close_or_reverse_uncertain_payment"].includes(
      report.recovery.action.action,
    )
  )
    throw new Error("payment recovery action is missing");
  if (
    report.assertions?.duplicatePaymentCount !== 0 ||
    report.assertions?.dispenseStarted === true
  )
    throw new Error("payment recovery allowed a duplicate or dispense");
  return {
    paymentId: report.payment.id,
    action: report.recovery.action.action,
    duplicatePaymentCount: 0,
  };
}
export async function runPaymentRecoveryGuest(options) {
  const input = readJson(options.guestInputPath);
  const handoff = readJson(options.handoffPath);
  const runId = required(input.runId, "runId");
  const report = {
    schemaVersion: SCHEMA_VERSION,
    ok: false,
    mode: options.mode,
    runId,
    boundaries: { serviceApi: false, mqtt: false, daemon: false },
    payment: null,
    recovery: null,
    assertions: { duplicatePaymentCount: null, dispenseStarted: null },
  };
  let session = null;
  let order = null;
  let adminAccessToken = null;
  try {
    session = await control(input, "/v1/serial-sessions/start", {
      runId,
      machineCode: required(input.machineCode, "machineCode"),
      targetIdentity: required(
        input.hostControlPlane.targetIdentity,
        "hostControlPlane.targetIdentity",
      ),
      runtimeBase: required(
        input.hostControlPlane.runtimeBaseIdentity,
        "hostControlPlane.runtimeBaseIdentity",
      ),
      saleCorrelationId: `sale-correlation://${runId.toLowerCase()}.payment-recovery`,
    });
    const saleView = await daemon(handoff, "/v1/sale-view");
    const fixture =
      input.fixtureAllocation?.[options.fixtureKey ?? "paymentRecovery"] ??
      input.fixtureAllocation?.sale;
    const slot = selectCanonicalSlot(saleView, fixture);
    const orderRequest = {
      inventoryId: slot.inventoryId,
      quantity: 1,
      planogramVersion: slot.planogramVersion,
      slotId: slot.slotId,
      slotCode: slot.slotCode,
      paymentMethod: "mock",
      paymentProviderCode: "mock",
      idempotencyKey: `${runId}-payment-recovery`,
    };
    adminAccessToken = await refreshAdminAccessToken(input);
    await waitForMachineOnline(input, input.machineCode, adminAccessToken);
    order = await daemon(handoff, "/v1/intents/create-order", orderRequest);
    const replayedOrder = await daemon(
      handoff,
      "/v1/intents/create-order",
      orderRequest,
    );
    report.payment = {
      id: order.paymentId,
      paymentNo: order.paymentNo,
      orderNo: order.orderNo,
    };
    const action = await api(
      input,
      `/payments/${required(order.paymentId, "paymentId")}/incident-actions`,
      {
        method: "POST",
        token: adminAccessToken,
        body: {
          action: "query_payment",
          reason: `runtime acceptance ${runId}: reconcile provider outcome`,
        },
      },
    );
    report.recovery = {
      action,
      providerAdapter: "mock",
      semantics: "service_api_payment_incident_action",
    };
    const [transaction, diagnostic, evidence] = await Promise.all([
      daemon(handoff, "/v1/transactions/current"),
      daemon(handoff, "/v1/maintenance/payment-environment"),
      control(input, `/v1/serial-sessions/${session.sessionId}/evidence`),
    ]);
    report.daemon = { transaction, paymentEnvironment: diagnostic };
    report.mqttEvidence = evidence.mqtt ?? evidence.machineMqtt ?? null;
    report.boundaries.serviceApi =
      action?.protectedDiagnostics?.paymentId === order.paymentId;
    report.boundaries.daemon =
      transaction?.paymentId === order.paymentId && diagnostic != null;
    report.boundaries.mqtt = mqttEvidenceMatchesPayment(
      evidence,
      report.payment,
    );
    report.assertions.dispenseStarted = Boolean(
      transaction?.vending?.commandId ?? transaction?.dispenseCommandId,
    );
    report.assertions.duplicatePaymentCount =
      new Set([order.paymentId, replayedOrder.paymentId]).size - 1;
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
    if (session?.sessionId)
      await control(
        input,
        `/v1/serial-sessions/${session.sessionId}/abort`,
      ).catch(() => null);
  }
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  runPaymentRecoveryGuest(
    parsePaymentRecoveryGuestArgs(process.argv.slice(2)),
  ).catch((error) => {
    console.error(error.stack ?? error);
    process.exitCode = 1;
  });
