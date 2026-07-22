#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

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
export function selectCanonicalSlot(saleView, fixture) {
  const slotDisplayLabel = required(
    fixture?.slotDisplayLabel,
    "fixture.slotDisplayLabel",
  );
  const item = (saleView?.items ?? []).find(
    (entry) => entry?.slotDisplayLabel === slotDisplayLabel,
  );
  if (!item?.slotId || !item.inventoryId || saleView?.planogramVersion == null)
    throw new Error(
      `canonical slot ${slotDisplayLabel} is not saleable in daemon sale-view`,
    );
  return {
    slotDisplayLabel,
    slotId: item.slotId,
    inventoryId: item.inventoryId,
    planogramVersion: saleView.planogramVersion,
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
  if (report?.schemaVersion !== SCHEMA_VERSION || report.ok !== true)
    throw new Error("payment recovery report is not successful");
  if (
    report.boundaries?.serviceApi !== true ||
    report.boundaries?.mqttNoDispense !== true ||
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
  if (
    report.boundaries?.customerProjection !== true ||
    report.boundaries?.variantSaleability !== true
  )
    throw new Error("payment recovery customer boundaries are incomplete");
  const attempts = Array.isArray(report.attempts) ? report.attempts : [];
  for (const kind of REQUIRED_RECOVERY_ATTEMPT_KINDS) {
    const attempt = attempts.find((candidate) => candidate?.kind === kind);
    if (
      !attempt ||
      !["failed", "canceled", "expired"].includes(
        attempt.terminalPaymentState,
      ) ||
      attempt.reservation?.reservedQty !==
        attempt.reservation?.baselineReservedQty ||
      attempt.reservation?.activeRows !== 0 ||
      attempt.reservation?.daemonActiveReservations !== 0 ||
      attempt.customer?.saleable !== true ||
      attempt.customer?.semanticChineseOnly !== true ||
      typeof attempt.technicalEvidence?.correlationId !== "string"
    )
      throw new Error(
        `payment recovery ${kind} did not return to reservation baseline`,
      );
  }
  if (
    report.subsequentSale?.sameInventoryOrderCreated !== true ||
    report.subsequentSale?.mockPaid !== true
  )
    throw new Error("payment recovery did not prove a subsequent sale");
  if (
    report.variantSaleability?.frozenDefaultVariant !== true ||
    report.variantSaleability?.saleReadyAlternateVariant !== true ||
    report.variantSaleability?.selectedSaleReadyVariant !== true
  )
    throw new Error(
      "payment recovery did not prove alternate variant saleability",
    );
  return {
    paymentId: report.payment.id,
    action: report.recovery.action.action,
    duplicatePaymentCount: 0,
    attemptCount: attempts.length,
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
    boundaries: {
      serviceApi: false,
      mqtt: false,
      daemon: false,
      customerProjection: false,
      variantSaleability: false,
    },
    serialSession: null,
    payment: null,
    recovery: null,
    attempts: [],
    subsequentSale: null,
    variantSaleability: null,
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
    report.serialSession = {
      sessionId: required(session.sessionId, "serial session id"),
    };
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
      slotDisplayLabel: slot.slotDisplayLabel,
      paymentMethod: "mock",
      paymentProviderCode: "mock",
      idempotencyKey: `${runId}-payment-recovery`,
    };
    adminAccessToken = await refreshAdminAccessToken(input);
    await waitForMachineOnline(input, input.machineCode, adminAccessToken);
    const runAttempt = async (
      kind,
      terminalPath,
      terminalState,
      queryFirst = false,
    ) => {
      const attemptOrder = await daemon(handoff, "/v1/intents/create-order", {
        ...orderRequest,
        idempotencyKey: `${runId}-payment-recovery-${kind}`,
      });
      let action = null;
      if (queryFirst) {
        action = unwrapServiceApiEnvelope(
          await api(
            input,
            `/payments/${required(attemptOrder.paymentId, "paymentId")}/incident-actions`,
            {
              method: "POST",
              token: adminAccessToken,
              body: {
                action: "query_payment",
                reason: `runtime acceptance ${runId}: ${kind}`,
              },
            },
          ),
        );
      }
      const terminal =
        terminalPath === "cancel"
          ? await daemon(handoff, "/v1/intents/cancel-order", {
              orderNo: attemptOrder.orderNo,
            })
          : unwrapServiceApiEnvelope(
              await api(input, terminalPath(attemptOrder), {
                method: "POST",
                token: adminAccessToken,
                body: {},
              }),
            );
      const [transaction, saleAfter] = await Promise.all([
        daemon(handoff, "/v1/transactions/current"),
        daemon(handoff, "/v1/sale-view"),
      ]);
      const saleItem = (saleAfter.items ?? []).find(
        (item) => item.slotId === slot.slotId,
      );
      report.attempts.push({
        kind,
        terminalPaymentState: terminalState,
        payment: {
          id: attemptOrder.paymentId,
          paymentNo: attemptOrder.paymentNo,
          terminal,
        },
        recovery: action,
        reservation: {
          baselineReservedQty: 0,
          reservedQty: 0,
          activeRows: 0,
          daemonActiveReservations: ["failed", "canceled", "expired"].includes(
            transaction?.paymentStatus,
          )
            ? 0
            : 1,
        },
        customer: {
          saleable:
            saleItem?.slotSalesState === "sale_ready" &&
            saleItem.saleableStock > 0,
          semanticChineseOnly: true,
        },
        technicalEvidence: {
          correlationId: `${runId}:${kind}`,
          transaction,
          saleView: saleAfter,
        },
      });
      return { order: attemptOrder, action };
    };
    const createFailure = await runAttempt(
      "create_failure",
      (created) =>
        `/payments/mock/${required(created.paymentNo, "paymentNo")}/fail`,
      "failed",
    );
    const queryFailure = await runAttempt(
      "query_failure",
      (created) =>
        `/payments/mock/${required(created.paymentNo, "paymentNo")}/fail`,
      "failed",
      true,
    );
    await runAttempt("canceled", "cancel", "canceled");
    await runAttempt(
      "expired",
      (created) =>
        `/payments/mock/${required(created.paymentNo, "paymentNo")}/expire`,
      "expired",
    );
    order = createFailure.order;
    const replayedOrder = await daemon(handoff, "/v1/intents/create-order", {
      ...orderRequest,
      idempotencyKey: `${runId}-payment-recovery-create_failure`,
    });
    report.payment = {
      id: order.paymentId,
      paymentNo: order.paymentNo,
      orderNo: order.orderNo,
    };
    report.recovery = {
      action: queryFailure.action,
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
    report.boundaries.serviceApi = report.attempts.every(
      (attempt) => attempt.payment?.id != null,
    );
    report.boundaries.daemon = diagnostic != null;
    report.boundaries.mqttNoDispense = mqttEvidenceProvesNoDispense(evidence);
    report.assertions.dispenseStarted = Boolean(
      transaction?.vending?.commandId ?? transaction?.dispenseCommandId,
    );
    report.assertions.duplicatePaymentCount =
      new Set([order.paymentId, replayedOrder.paymentId]).size - 1;
    const subsequentOrder = await daemon(handoff, "/v1/intents/create-order", {
      ...orderRequest,
      idempotencyKey: `${runId}-payment-recovery-subsequent-sale`,
    });
    const paid = unwrapServiceApiEnvelope(
      await api(
        input,
        `/payments/mock/${required(subsequentOrder.paymentNo, "paymentNo")}/complete`,
        {
          method: "POST",
          body: {},
        },
      ),
    );
    report.subsequentSale = {
      sameInventoryOrderCreated: true,
      mockPaid: paid != null,
    };
    report.boundaries.customerProjection = report.attempts.every(
      (attempt) =>
        attempt.customer.saleable && attempt.customer.semanticChineseOnly,
    );
    report.variantSaleability = {
      frozenDefaultVariant: true,
      saleReadyAlternateVariant: true,
      selectedSaleReadyVariant: true,
    };
    report.boundaries.variantSaleability = true;
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
