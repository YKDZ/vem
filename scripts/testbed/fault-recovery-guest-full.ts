#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { waitForDaemonReadyRefresh } from "./daemon-ready-refresh.ts";
import {
  activateVisibleSelector,
  captureCheckpoint,
  CdpClient,
  discoverMachineUiTarget,
  enablePageRuntime,
  evaluateExpression,
  rewriteWebSocketDebuggerUrl,
  waitForRoute,
} from "./machine-ui-cdp-driver.ts";
import { openFixtureProductFromCatalog } from "./payment-recovery-guest-full.ts";
import {
  waitForHardwareBindings,
  waitForSaleStartCapability,
} from "./scanner-payment-code-guest-full.ts";

const SCHEMA_VERSION = "vem-fault-recovery-guest-full/v1";
const TERMINAL_FAILURE_ORDER_STATUSES = new Set([
  "refund_pending",
  "refunded",
  "manual_handling",
]);
const MAINTENANCE_ENTRY_SELECTOR = "[data-test='maintenance-entry-header']";

export type JsonRecord = Record<string, unknown>;
export type GuestInputRecord = JsonRecord;
export type HandoffRecord = JsonRecord;

export function required(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

export function option(args: string[], name: string): string {
  const index = args.indexOf(`--${name}`);
  return required(index === -1 ? undefined : args[index + 1], `--${name}`);
}

export function localPath(value: unknown): string {
  const path = required(value, "Windows path");
  return process.platform === "win32"
    ? path
    : resolve(
        `/mnt/${path[0].toLowerCase()}/${path.slice(3).replaceAll("\\", "/")}`,
      );
}

export function readJson(path: string): JsonRecord {
  return JSON.parse(readFileSync(localPath(path), "utf8")) as JsonRecord;
}

export function writeJson(path: string, value: unknown): void {
  const target = localPath(path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function rows(
  report: JsonRecord | null | undefined,
  name: string,
): unknown[] {
  const raw = report?.raw as JsonRecord | undefined;
  return Array.isArray(raw?.[name]) ? (raw?.[name] as unknown[]) : [];
}

export function daemonBaseUrl(handoff: HandoffRecord): string {
  const daemon = handoff.daemon as JsonRecord | undefined;
  const ready = daemon?.ready as JsonRecord | undefined;
  const healthzUrl = required(ready?.healthzUrl, "daemon healthzUrl");
  if (!healthzUrl.endsWith("/healthz"))
    throw new Error("daemon healthzUrl must end with /healthz");
  return healthzUrl.slice(0, -"/healthz".length);
}

export async function fetchJson(
  url: string,
  options: JsonRecord = {},
): Promise<unknown> {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      `${options.method ?? "GET"} ${url} failed with HTTP ${response.status}: ${JSON.stringify(payload)}`,
    );
  }
  return payload;
}

export function daemonGet(
  handoff: HandoffRecord,
  path: string,
): Promise<unknown> {
  const daemon = handoff.daemon as JsonRecord | undefined;
  const ready = daemon?.ready as JsonRecord | undefined;
  return fetchJson(`${daemonBaseUrl(handoff)}${path}`, {
    headers: {
      authorization: `Bearer ${required(ready?.ipcToken, "daemon ipcToken")}`,
    },
  });
}

export function daemonPost(
  handoff: HandoffRecord,
  path: string,
  body: JsonRecord = {},
): Promise<unknown> {
  const daemon = handoff.daemon as JsonRecord | undefined;
  const ready = daemon?.ready as JsonRecord | undefined;
  return fetchJson(`${daemonBaseUrl(handoff)}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${required(ready?.ipcToken, "daemon ipcToken")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

export function control(
  guestInput: GuestInputRecord,
  path: string,
  body: JsonRecord = {},
): Promise<unknown> {
  const plane = guestInput.hostControlPlane as JsonRecord | undefined;
  return fetchJson(
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

export function platform(
  guestInput: GuestInputRecord,
  runId: string,
  machineCode: string,
  sessionId: string | null,
): Promise<unknown> {
  return control(guestInput, "/v1/platform/query", {
    runId,
    machineCode,
    ...(sessionId ? { sessionId } : {}),
  }).then((value) => (value as JsonRecord).report);
}

export async function adminToken(input: GuestInputRecord): Promise<string> {
  const bootstrap = input?.runtimeBootstrap as JsonRecord | undefined;
  const serviceApi = input?.serviceApi as JsonRecord | undefined;
  const base = required(
    bootstrap?.provisioningApiBaseUrl,
    "runtimeBootstrap.provisioningApiBaseUrl",
  ).replace(/\/+$/, "");
  const response = await fetchJson(`${base}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: required(serviceApi?.adminUsername, "serviceApi.adminUsername"),
      password: required(serviceApi?.adminPassword, "serviceApi.adminPassword"),
    }),
  });
  const data = (response as JsonRecord).data as JsonRecord | undefined;
  return required(data?.accessToken, "admin access token");
}

export async function selectMockPaymentAndSubmit(
  client: InstanceType<typeof CdpClient>,
): Promise<void> {
  const paymentSelector =
    '[data-test="payment-option"][data-payment-option-key="mock:mock"]:not(:disabled)';
  let selected = false;
  for (let attempt = 0; attempt < 3 && !selected; attempt += 1) {
    await activateVisibleSelector(client, paymentSelector, {
      kind: "touch",
      timeoutMs: 30_000,
    });
    selected = Boolean(
      await evaluateExpression(
        client,
        `(() => {
        const option = document.querySelector(${JSON.stringify(paymentSelector)});
        const submit = document.querySelector('[data-test="checkout-submit"]');
        return Boolean(option?.classList.contains('payment-option-selected') && submit && !submit.hasAttribute('disabled'));
      })()`,
      ),
    );
    if (!selected) await sleep(250);
  }
  if (!selected) {
    throw new Error("mock payment option did not become actionable");
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const alreadyPayment = await waitForRoute(client, /^#\/payment/, {
      timeoutMs: 250,
      pollMs: 50,
    })
      .then(() => true)
      .catch(() => false);
    if (alreadyPayment) return;
    await activateVisibleSelector(
      client,
      '[data-test="checkout-submit"]:not(:disabled)',
      {
        kind: "touch",
        timeoutMs: 30_000,
      },
    );
    const reachedPayment = await waitForRoute(client, /^#\/payment/, {
      timeoutMs: attempt === 2 ? 30_000 : 2_000,
      pollMs: 250,
    })
      .then(() => true)
      .catch(() => false);
    if (reachedPayment) return;
  }
  throw new Error("payment submit touch did not reach the payment route");
}

export async function waitForCommand(
  handoff: HandoffRecord,
  sale: JsonRecord,
  timeoutMs = 30_000,
): Promise<JsonRecord> {
  const deadline = Date.now() + timeoutMs;
  let last: JsonRecord | null = null;
  while (Date.now() < deadline) {
    last = (await daemonGet(handoff, "/v1/transactions/current").catch(
      () => null,
    )) as JsonRecord | null;
    const vending = last?.vending as JsonRecord | undefined;
    const commandId = vending?.commandId ?? last?.dispenseCommandId;
    if (
      last?.orderId === sale.orderId &&
      last?.paymentId === sale.paymentId &&
      commandId != null
    ) {
      return {
        orderId: last?.orderId,
        paymentId: last?.paymentId,
        orderNo: last?.orderNo,
        vendingCommandId: commandId,
      };
    }
    await sleep(250);
  }
  throw new Error(`vending command did not appear: ${JSON.stringify(last)}`);
}

export async function readPaymentSurface(
  client: InstanceType<typeof CdpClient>,
): Promise<JsonRecord> {
  const surface = (await evaluateExpression(
    client,
    `(() => {
    const el = document.querySelector("[data-installed-kiosk-sale-payment-surface]");
    return el ? { orderId: el.dataset.orderId || null, paymentId: el.dataset.paymentId || null,
      orderNo: el.dataset.orderNo || null, route: location.hash } : null;
  })()`,
  )) as JsonRecord | null;
  if (!surface?.orderId || !surface?.paymentId || !surface?.orderNo) {
    throw new Error("required rendered payment surface hook is missing");
  }
  return surface;
}

export function readUi(
  client: InstanceType<typeof CdpClient>,
): Promise<unknown> {
  return evaluateExpression(
    client,
    `(() => {
    const result = document.querySelector("[data-installed-kiosk-sale-result-surface]");
    return { route: location.hash, result: result ? { kind: result.dataset.resultKind || null,
      orderId: result.dataset.orderId || null, paymentId: result.dataset.paymentId || null,
      commandId: result.dataset.commandId || null } : null,
      trace: window.__VEM_MACHINE_RUNTIME_TRACE__ || [] };
  })()`,
  );
}

export function parseFaultRecoveryGuestArgs(args: string[]): {
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
    fixtureKey: option(args, "fixture-key"),
  };
}

async function enterMaintenance(
  client: InstanceType<typeof CdpClient>,
): Promise<void> {
  await waitForRoute(client, "#/catalog", {
    timeoutMs: 30_000,
    pollMs: 250,
  });
  const entryDeadline = Date.now() + 30_000;
  let entryReady = false;
  while (Date.now() < entryDeadline && !entryReady) {
    const state = (await evaluateExpression(
      client,
      `(() => ({
        ready: document.readyState === "complete",
        entry: Boolean(document.querySelector(${JSON.stringify(
          MAINTENANCE_ENTRY_SELECTOR,
        )})),
      }))()`,
    )) as JsonRecord | null;
    if (state?.ready === true && state.entry === true) entryReady = true;
    if (!entryReady) await sleep(250);
  }
  if (!entryReady) throw new Error("maintenance entry is unavailable");
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
    await sleep(80);
  }
  await waitForRoute(client, "#/maintenance?source=operator", {
    timeoutMs: 30_000,
    pollMs: 250,
    forbiddenRoutes: [],
  });
}

export async function runFaultRecoveryGuest(options: {
  mode: "full";
  guestInputPath: string;
  handoffPath: string;
  outPath: string;
  fixtureKey: string;
}): Promise<JsonRecord> {
  let guestInput: GuestInputRecord | null = null;
  let handoff: HandoffRecord | null = null;
  let client: InstanceType<typeof CdpClient> | null = null;
  let session: JsonRecord | null = null;
  let cleaned = false;
  let stage = "read-input";
  const checkpoints: unknown[] = [];
  const report: JsonRecord = {
    schemaVersion: SCHEMA_VERSION,
    ok: false,
    handoffSerialSessionId: null,
    mode: options.mode,
    evidence: { checkpoints },
  };
  const screenshotSink = ({
    bytes,
    label,
  }: {
    bytes: Uint8Array;
    label: string;
  }) => {
    const path = join(
      dirname(localPath(options.outPath)),
      "fault-recovery-artifacts",
      `${label}.png`,
    );
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    return { ref: path };
  };
  const snapshot = async (label: string): Promise<void> => {
    if (!client) return;
    const checkpoint = await captureCheckpoint(client, label, {
      screenshot: true,
      screenshotSink,
    }).catch((error) => ({ label, error: String(error) }));
    checkpoints.push(checkpoint);
    (report.evidence as JsonRecord).ui = await readUi(client).catch(
      (error) => ({ error: String(error) }),
    );
  };
  const cleanup = async (): Promise<void> => {
    if (!session || cleaned) return;
    cleaned = true;
    const activeSession = session as JsonRecord;
    const path = `/v1/serial-sessions/${String(activeSession.sessionId)}/abort`;
    report.cleanup = await control(
      guestInput as GuestInputRecord,
      path,
      {},
    ).catch((error) => ({ error: String(error) }));
  };

  try {
    guestInput = readJson(options.guestInputPath);
    handoff = readJson(options.handoffPath);
    const evidence = report.evidence as JsonRecord;
    const runId = required(guestInput.runId, "runId");
    const machineCode = required(guestInput.machineCode, "machineCode");
    const handoffCdp = handoff.cdp as JsonRecord;
    const target = await discoverMachineUiTarget({
      endpoint: "http://127.0.0.1:9222",
      expectedTargetId: String(handoffCdp.targetId),
    });
    client = new CdpClient(
      rewriteWebSocketDebuggerUrl(
        target.webSocketDebuggerUrl,
        "http://127.0.0.1:9222",
      ),
    );
    await client.connect();
    await enablePageRuntime(client);
    await waitForRoute(client, "#/catalog", { timeoutMs: 30_000, pollMs: 250 });
    report.runId = runId;
    report.machineCode = machineCode;
    evidence.baseline = {
      platform: await platform(guestInput, runId, machineCode, null),
    };

    stage = "start-mechanical-host-serial-session";
    session = (await control(guestInput, "/v1/serial-sessions/start", {
      runId,
      machineCode,
      serialScenario: "mechanical",
      saleCorrelationId: `sale-correlation://serial-mechanical-${Date.now()}`,
      targetIdentity: required(
        (guestInput.hostControlPlane as JsonRecord | undefined)?.targetIdentity,
        "hostControlPlane.targetIdentity",
      ),
      runtimeBase: required(
        (guestInput.hostControlPlane as JsonRecord | undefined)
          ?.runtimeBaseIdentity,
        "hostControlPlane.runtimeBaseIdentity",
      ),
    })) as JsonRecord;
    const activeSession = session as JsonRecord;
    report.handoffSerialSessionId = required(
      activeSession.sessionId,
      "fault recovery serial session id",
    );
    await waitForDaemonReadyRefresh(handoff);
    stage = "await-daemon-binding-and-capability";
    evidence.hardwareBindings = await waitForHardwareBindings(
      handoff,
      activeSession,
    );
    evidence.saleStartCapability = await waitForSaleStartCapability(
      (path) => daemonGet(handoff as HandoffRecord, path),
      { paymentOptionKey: "mock:mock" },
    );

    stage = "physical-tauri-payment";
    const fixture = (guestInput.fixtureAllocation as JsonRecord | undefined)?.[
      options.fixtureKey
    ] as JsonRecord | undefined;
    await openFixtureProductFromCatalog({
      client,
      slotId: required(fixture?.slotId, `${options.fixtureKey} slotId`),
      categoryKey: required(
        fixture?.categoryKey,
        `${options.fixtureKey} categoryKey`,
      ),
    });
    await waitForRoute(client, /^#\/products\//, {
      timeoutMs: 30_000,
      pollMs: 250,
    });
    await activateVisibleSelector(client, '[data-test="product-buy"]', {
      kind: "touch",
      timeoutMs: 30_000,
    });
    await waitForRoute(client, "#/checkout", {
      timeoutMs: 30_000,
      pollMs: 250,
    });
    await selectMockPaymentAndSubmit(client);
    const sale = await readPaymentSurface(client);
    report.sale = sale;
    await snapshot("payment-before-e3");

    stage = "complete-physical-payment";
    const bootstrap = guestInput.runtimeBootstrap as JsonRecord | undefined;
    const currentTransaction = (await daemonGet(
      handoff,
      "/v1/transactions/current",
    )) as JsonRecord;
    const completed = await fetchJson(
      `${required(bootstrap?.provisioningApiBaseUrl, "runtimeBootstrap.provisioningApiBaseUrl").replace(/\/+$/, "")}/payments/mock/${encodeURIComponent(required(currentTransaction.paymentNo, "paymentNo"))}/complete`,
      { method: "POST", headers: { "content-type": "application/json" } },
    );
    report.paymentCompletion = completed;
    const liveSale = await waitForCommand(handoff, sale);
    await control(
      guestInput,
      `/v1/serial-sessions/${String(activeSession.sessionId)}/bind-sale`,
      liveSale,
    );

    stage = "mechanical-serial-boundaries";
    evidence.boundaries = {
      vend: await control(
        guestInput,
        `/v1/serial-sessions/${String(activeSession.sessionId)}/wait-frame`,
        { parsedOpcode: "VEND", timeoutMs: 30_000 },
      ),
      e3: await control(
        guestInput,
        `/v1/serial-sessions/${String(activeSession.sessionId)}/wait-frame`,
        { parsedOpcode: "E3", timeoutMs: 30_000 },
      ),
    };
    evidence.serial = await control(
      guestInput,
      `/v1/serial-sessions/${String(activeSession.sessionId)}/evidence`,
    ).catch((error) => ({ error: String(error) }));
    await waitForRoute(client, "#/result/dispense_failed", {
      timeoutMs: 30_000,
      pollMs: 250,
    });
    evidence.resultUi = await readUi(client).catch((error) => ({
      error: String(error),
    }));
    await snapshot("dispense-failed");

    stage = "wait-authoritative-recovery";
    const deadline = Date.now() + 60_000;
    let finalPlatform: JsonRecord | null = null;
    do {
      const final = (await platform(
        guestInput,
        runId,
        machineCode,
        String(activeSession.sessionId),
      )) as JsonRecord;
      finalPlatform = final;
      const order = rows(final, "orders").find(
        (row) => (row as JsonRecord).id === sale.orderId,
      );
      if (
        TERMINAL_FAILURE_ORDER_STATUSES.has(
          String((order as JsonRecord | undefined)?.status),
        )
      )
        break;
      await sleep(500);
    } while (Date.now() < deadline);
    evidence.finalPlatform = finalPlatform;
    evidence.finalDaemon = await daemonGet(
      handoff,
      "/v1/transactions/current",
    ).catch(() => null);
    const capabilityBefore = (await daemonGet(
      handoff,
      "/v1/sale-start-capability",
    )) as JsonRecord;
    evidence.capabilityBefore = capabilityBefore;
    const saleViewBefore = (await daemonGet(
      handoff,
      "/v1/sale-view",
    )) as JsonRecord;
    evidence.saleViewBefore = saleViewBefore;
    if (
      !(capabilityBefore.blockers as unknown[] | undefined)?.some(
        (blocker) => (blocker as JsonRecord).code === "WHOLE_MACHINE_LOCKED",
      )
    ) {
      throw new Error("mechanical fault did not raise the whole-machine lock");
    }
    const frozenSlot = (saleViewBefore.items as unknown[] | undefined)?.find(
      (item) => (item as JsonRecord).slotId === fixture?.slotId,
    ) as JsonRecord | undefined;
    if (frozenSlot?.slotSalesState !== "frozen") {
      throw new Error(
        `faulted slot is not frozen: ${JSON.stringify(frozenSlot)}`,
      );
    }

    stage = "capture-maintenance-lock-ui";
    const canReturnToCatalog = await evaluateExpression(
      client,
      `document.querySelector(".failure-return-button") !== null`,
    );
    if (canReturnToCatalog) {
      await activateVisibleSelector(client, ".failure-return-button", {
        kind: "touch",
        timeoutMs: 10_000,
      });
      await waitForRoute(client, "#/catalog", {
        timeoutMs: 10_000,
        pollMs: 100,
      });
    } else {
      throw new Error("dispense-failed result did not offer a return button");
    }
    await enterMaintenance(client);
    await snapshot("maintenance-lock-reset-button");
    await evaluateExpression(
      client,
      `(() => {
        const panel = document.querySelector('.maintenance-vision-panel');
        if (panel) panel.scrollIntoView({ block: 'center' });
        return true;
      })()`,
    );
    await snapshot("maintenance-vision-debug");

    stage = "fault-reset-and-auto-unlock";
    const reset = (await daemonPost(handoff, "/v1/hardware/fault-reset", {
      operatorNote: "testbed fault recovery",
    })) as JsonRecord;
    evidence.faultReset = reset;
    const resetResult = reset.reset as JsonRecord | undefined;
    if (
      resetResult?.status !== "succeeded" ||
      reset.wholeMachineLockCleared !== true
    ) {
      throw new Error(
        `fault reset did not succeed and auto-clear: ${JSON.stringify(reset)}`,
      );
    }
    const capabilityAfter = (await daemonGet(
      handoff,
      "/v1/sale-start-capability",
    )) as JsonRecord;
    evidence.capabilityAfter = capabilityAfter;
    if (
      (capabilityAfter.blockers as unknown[] | undefined)?.some(
        (blocker) => (blocker as JsonRecord).code === "WHOLE_MACHINE_LOCKED",
      )
    ) {
      throw new Error("whole-machine lock remained after fault reset");
    }

    stage = "refill-and-verify-sale-ready";
    const inventoryId = required(
      (
        (saleViewBefore.items as unknown[] | undefined)?.find(
          (item) => (item as JsonRecord).slotId === fixture?.slotId,
        ) as JsonRecord | undefined
      )?.inventoryId,
      "faulted slot inventoryId",
    );
    const token = await adminToken(guestInput);
    const serviceApiBase = required(
      (guestInput.runtimeBootstrap as JsonRecord | undefined)
        ?.provisioningApiBaseUrl,
      "runtimeBootstrap.provisioningApiBaseUrl",
    ).replace(/\/+$/, "");
    evidence.refill = await fetchJson(`${serviceApiBase}/inventories/adjust`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ inventoryId, deltaQty: 10 }),
    });
    const saleReadyDeadline = Date.now() + 60_000;
    let saleViewAfter: JsonRecord | null = null;
    do {
      saleViewAfter = (await daemonGet(handoff, "/v1/sale-view")) as JsonRecord;
      const item = (saleViewAfter.items as JsonRecord[] | undefined)?.find(
        (entry) => (entry as JsonRecord).slotId === fixture?.slotId,
      ) as JsonRecord | undefined;
      if (
        item?.slotSalesState === "sale_ready" &&
        Number(item?.saleableStock ?? 0) > 0
      )
        break;
      await sleep(500);
    } while (Date.now() < saleReadyDeadline);
    evidence.saleViewAfter = saleViewAfter;
    const finalItem = (saleViewAfter.items as JsonRecord[] | undefined)?.find(
      (entry) => (entry as JsonRecord).slotId === fixture?.slotId,
    ) as JsonRecord | undefined;
    if (
      finalItem?.slotSalesState !== "sale_ready" ||
      Number(finalItem?.saleableStock ?? 0) <= 0
    ) {
      throw new Error(
        `faulted slot did not return to sale_ready: ${JSON.stringify(finalItem)}`,
      );
    }
    await snapshot("catalog-after-recovery");
    await cleanup();
    report.assertions = {
      mechanicalFaultRaisedLock: true,
      maintenanceResetButtonCaptured: true,
      maintenanceVisionDebugCaptured: true,
      faultResetAutoClearedLock: true,
      refillRestoredSaleReady: true,
    };
    report.ok = true;
    stage = "complete";
  } catch (error) {
    report.stage = stage;
    report.error = error instanceof Error ? error.message : String(error);
    if (client) await snapshot("failure").catch(() => undefined);
    throw error;
  } finally {
    if (guestInput && handoff) {
      await daemonPost(
        handoff,
        "/v1/hardware/fault-reset",
        { operatorNote: "testbed fault recovery cleanup" },
      ).catch(() => undefined);
    }
    await cleanup();
    writeJson(options.outPath, report);
    await client?.close().catch(() => undefined);
  }
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runFaultRecoveryGuest(
    parseFaultRecoveryGuestArgs(process.argv.slice(2)),
  ).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
