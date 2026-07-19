#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import {
  buildInstalledKioskGuestOperationScript,
  buildInstalledKioskSaleScenarioSteps,
  evaluateInstalledErrorMatrixEvidence,
} from "./installed-kiosk-sale-acceptance.mjs";
import {
  activateVisibleSelector,
  captureCheckpoint,
  captureRuntimeOperationObservation,
  captureScreenshot,
  CdpClient,
  discoverMachineUiTarget,
  enablePageRuntime,
  evaluateExpression,
  rewriteWebSocketDebuggerUrl,
  waitForRoute,
} from "./machine-ui-cdp-driver.mjs";

const SCHEMA_VERSION = "vem-installed-ipc-recovery-guest-full/v1";

function required(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function option(args, name) {
  const index = args.indexOf(`--${name}`);
  const value = index === -1 ? undefined : args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`--${name} requires a value`);
  }
  return value;
}

function windowsAbsolute(value, label) {
  const path = required(value, label);
  if (!/^[A-Za-z]:\\/.test(path) || path.includes("\0")) {
    throw new Error(`${label} must be an absolute Windows path`);
  }
  return path;
}

function localPath(path) {
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

function parseArgs(args) {
  if (required(option(args, "mode"), "--mode") !== "full") {
    throw new Error("--mode must be full");
  }
  return {
    mode: "full",
    guestInputPath: windowsAbsolute(
      option(args, "guest-input"),
      "--guest-input",
    ),
    handoffPath: windowsAbsolute(option(args, "handoff"), "--handoff"),
    outPath: windowsAbsolute(option(args, "out"), "--out"),
  };
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      `${options.method ?? "GET"} ${url} failed with HTTP ${response.status}: ${JSON.stringify(payload)}`,
    );
  }
  return payload;
}

function daemonBaseUrl(handoff) {
  const healthzUrl = required(
    handoff.daemon?.ready?.healthzUrl,
    "daemon healthzUrl",
  );
  if (!healthzUrl.endsWith("/healthz")) {
    throw new Error("daemon healthzUrl must end with /healthz");
  }
  return healthzUrl.slice(0, -"/healthz".length);
}

function daemonGet(handoff, path) {
  return fetchJson(`${daemonBaseUrl(handoff)}${path}`, {
    headers: {
      authorization: `Bearer ${required(handoff.daemon?.ready?.ipcToken, "daemon ipcToken")}`,
    },
  });
}

function controlPlaneRequest(guestInput, path, body = {}) {
  return fetchJson(
    `${required(guestInput.hostControlPlane?.endpoint, "hostControlPlane.endpoint")}${path}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${required(guestInput.hostControlPlane?.token, "hostControlPlane.token")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
}

async function completeMockPayment(guestInput, paymentNo) {
  return fetchJson(
    `${required(guestInput.runtimeBootstrap?.provisioningApiBaseUrl, "runtimeBootstrap.provisioningApiBaseUrl").replace(/\/+$/, "")}/payments/mock/${encodeURIComponent(required(paymentNo, "paymentNo"))}/complete`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
    },
  );
}

async function waitForCommand(handoff, sale, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await daemonGet(handoff, "/v1/transactions/current").catch(
      () => null,
    );
    const commandId = last?.vending?.commandId ?? last?.dispenseCommandId;
    if (
      last?.orderId === sale.orderId &&
      last?.paymentId === sale.paymentId &&
      commandId
    ) {
      return {
        orderId: last.orderId,
        paymentId: last.paymentId,
        orderNo: last.orderNo,
        vendingCommandId: commandId,
      };
    }
    await sleep(250);
  }
  throw new Error(`vending command did not appear: ${JSON.stringify(last)}`);
}

async function readPaymentSurface(client) {
  const surface = await evaluateExpression(
    client,
    `(() => {
      const el = document.querySelector("[data-installed-kiosk-sale-payment-surface]");
      return el ? {
        orderId: el.dataset.orderId || null,
        paymentId: el.dataset.paymentId || null,
        orderNo: el.dataset.orderNo || el.dataset.orderCredential || null,
        route: location.hash
      } : null;
    })()`,
  );
  if (!surface?.orderId || !surface?.paymentId || !surface?.orderNo) {
    throw new Error("required rendered payment surface hook is missing");
  }
  return surface;
}

async function waitForSuccessfulResultSurface(
  client,
  sale,
  timeoutMs = 60_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await evaluateExpression(
      client,
      `(() => {
        const result = document.querySelector("[data-installed-kiosk-sale-result-surface]");
        return result ? {
          route: location.hash,
          kind: result.dataset.resultKind || null,
          orderId: result.dataset.orderId || null,
          paymentId: result.dataset.paymentId || null,
          commandId: result.dataset.commandId || null
        } : null;
      })()`,
    );
    if (
      value?.kind === "success" &&
      value.orderId === sale.orderId &&
      value.paymentId === sale.paymentId &&
      value.commandId === sale.commandId
    ) {
      return value;
    }
    await sleep(250);
  }
  throw new Error(
    "success result surface did not appear for the recovered sale",
  );
}

function runLocalPowerShellJson(script, label) {
  const result = spawnSync(
    "pwsh",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `${label} failed: ${(result.stderr || result.stdout || "").trim() || `exit ${result.status ?? 1}`}`,
    );
  }
  try {
    return JSON.parse((result.stdout ?? "").trim());
  } catch (error) {
    throw new Error(
      `${label} returned unreadable JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function compactFrames(rawFrames) {
  return Array.isArray(rawFrames)
    ? rawFrames.map((frame) => ({
        at: frame.at ?? null,
        parsedOpcode: frame.parsedOpcode ?? null,
      }))
    : [];
}

export async function runInstalledIpcRecoveryGuest(options) {
  let guestInput;
  let handoff;
  let client;
  let session;
  let recoveredTransport = null;
  let interruptedTransport = null;
  let liveSale = null;
  let failure = null;
  const report = {
    schemaVersion: SCHEMA_VERSION,
    ok: false,
    mode: options.mode,
    artifacts: { milestones: [] },
  };
  const screenshotSink = ({ bytes, label }) => {
    const path = join(
      dirname(localPath(options.outPath)),
      "ipc-recovery-artifacts",
      `${label}.png`,
    );
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    return { ref: path };
  };
  const pushCheckpoint = async (label) => {
    if (!client) return;
    const checkpoint = await captureCheckpoint(client, label, {
      screenshot: true,
      screenshotSink,
    });
    report.artifacts.milestones.push({
      label: checkpoint.label,
      route: checkpoint.identity.route,
      screenshot: checkpoint.screenshot?.ref ?? null,
    });
  };
  try {
    guestInput = readJson(options.guestInputPath);
    handoff = readJson(options.handoffPath);
    const runId = required(guestInput.runId, "runId");
    const machineCode = required(guestInput.machineCode, "machineCode");
    report.runId = runId;
    report.machineCode = machineCode;

    const target = await discoverMachineUiTarget({
      endpoint: "http://127.0.0.1:9222",
      expectedTargetId: handoff.cdp.targetId,
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

    session = await controlPlaneRequest(
      guestInput,
      "/v1/serial-sessions/start",
      {
        runId,
        machineCode,
        saleCorrelationId: `sale-correlation://ipc-recovery-${Date.now()}`,
        targetIdentity: required(
          guestInput.hostControlPlane?.targetIdentity,
          "hostControlPlane.targetIdentity",
        ),
        runtimeBase: required(
          guestInput.hostControlPlane?.runtimeBaseIdentity,
          "hostControlPlane.runtimeBaseIdentity",
        ),
      },
    );

    const steps = buildInstalledKioskSaleScenarioSteps("vm-ipc-recovery");
    for (const step of steps.slice(0, 4)) {
      await waitForRoute(client, step.routeBefore, {
        timeoutMs: step.timeoutMs ?? 30_000,
        pollMs: 250,
      });
      await activateVisibleSelector(client, step.selector, {
        kind: "touch",
        timeoutMs: 30_000,
      });
      await waitForRoute(client, step.routeAfter, {
        timeoutMs: step.timeoutMs ?? 30_000,
        pollMs: 250,
      });
    }
    let paymentRouteReached = false;
    for (let attempt = 0; attempt < 3 && !paymentRouteReached; attempt += 1) {
      await activateVisibleSelector(client, '[data-test="checkout-submit"]', {
        kind: "touch",
        timeoutMs: 30_000,
      });
      paymentRouteReached = await waitForRoute(client, /^#\/payment/, {
        timeoutMs: attempt === 2 ? 30_000 : 2_000,
        pollMs: 250,
      })
        .then(() => true)
        .catch(() => false);
    }
    if (!paymentRouteReached)
      throw new Error("payment submit touch did not reach the payment route");

    const renderedSale = await readPaymentSurface(client);
    report.renderedSale = renderedSale;
    await pushCheckpoint("payment-before-ipc-recovery");

    const uiBefore = await captureRuntimeOperationObservation(client);
    interruptedTransport = runLocalPowerShellJson(
      buildInstalledKioskGuestOperationScript({
        operation: "daemon_transport_interrupt",
        phase: "interrupt",
        daemonRuntime: handoff.daemon,
      }),
      "daemon transport interrupt",
    );
    const overlayDeadline = Date.now() + 30_000;
    let recoveryOverlay = null;
    do {
      const observation = await captureRuntimeOperationObservation(client);
      if (
        Array.isArray(observation.recoveryOverlay) &&
        observation.recoveryOverlay.length > 0
      ) {
        recoveryOverlay = {
          observation,
          screenshot: await captureScreenshot(client, {
            screenshotSink,
            label: "payment-recovery-overlay",
          }),
        };
        break;
      }
      await sleep(250);
    } while (Date.now() < overlayDeadline);
    recoveredTransport = runLocalPowerShellJson(
      buildInstalledKioskGuestOperationScript({
        operation: "daemon_transport_interrupt",
        phase: "recover",
        operationId: interruptedTransport.guestOperationId,
        daemonRuntime: handoff.daemon,
      }),
      "daemon transport recovery",
    );
    const uiAfter = await captureRuntimeOperationObservation(client);

    report.ipcRecovery = {
      operation: "daemon_transport_interrupt",
      provenance: {
        ...recoveredTransport,
        ui: {
          before: uiBefore,
          after: uiAfter,
          recoveryOverlay,
        },
      },
    };

    report.ipcRecovery.evidence = evaluateInstalledErrorMatrixEvidence({
      profile: "vm-ipc-recovery",
      scenario: {
        evidence: [
          {
            type: "external-operation",
            operation: "daemon_transport_interrupt",
            routeBefore: "#/payment",
            routeAfter: "#/payment",
            provenance: report.ipcRecovery.provenance,
          },
        ],
      },
      correlation: {
        rendered: { orderNo: renderedSale.orderNo },
        platform: { orderNo: renderedSale.orderNo },
      },
    });
    report.ipcRecovery.assertions = {
      overlayObserved: true,
      retainedOrderCredential: uiBefore.orderCredential,
      resumedOrderCredential: uiAfter.orderCredential,
      daemonTransportPhase: recoveredTransport.daemon?.transport?.phase ?? null,
    };

    const current = await daemonGet(handoff, "/v1/transactions/current");
    await completeMockPayment(
      guestInput,
      required(current.paymentNo, "paymentNo"),
    );
    liveSale = await waitForCommand(handoff, renderedSale);
    report.liveSale = liveSale;

    report.serial = {
      sessionId: session.sessionId,
      vend: await controlPlaneRequest(
        guestInput,
        `/v1/serial-sessions/${session.sessionId}/wait-frame`,
        { parsedOpcode: "VEND", timeoutMs: 30_000 },
      ),
      releaseF0: await controlPlaneRequest(
        guestInput,
        `/v1/serial-sessions/${session.sessionId}/release-f0`,
      ),
      f0: await controlPlaneRequest(
        guestInput,
        `/v1/serial-sessions/${session.sessionId}/wait-frame`,
        { parsedOpcode: "F0", timeoutMs: 30_000 },
      ),
      f1: await controlPlaneRequest(
        guestInput,
        `/v1/serial-sessions/${session.sessionId}/wait-frame`,
        { parsedOpcode: "F1", timeoutMs: 30_000 },
      ),
      releaseF2: await controlPlaneRequest(
        guestInput,
        `/v1/serial-sessions/${session.sessionId}/release-f2`,
      ),
      f2: await controlPlaneRequest(
        guestInput,
        `/v1/serial-sessions/${session.sessionId}/wait-frame`,
        { parsedOpcode: "F2", timeoutMs: 30_000 },
      ),
    };

    report.result = await waitForSuccessfulResultSurface(
      client,
      {
        orderId: renderedSale.orderId,
        paymentId: renderedSale.paymentId,
        commandId: liveSale.vendingCommandId,
      },
      60_000,
    );
    await pushCheckpoint("result-after-ipc-recovery");
    if (recoveryOverlay == null) {
      throw new Error(
        "daemon transport interruption did not expose a recovery overlay",
      );
    }
    const serialEvidence = await controlPlaneRequest(
      guestInput,
      `/v1/serial-sessions/${session.sessionId}/evidence`,
    );
    report.serial.rawFrames = compactFrames(serialEvidence.rawFrames);
    report.ok = true;
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
    report.error = failure.message;
    if (client) {
      try {
        await pushCheckpoint("failure");
      } catch {}
    }
  }

  const cleanup = [];
  let cleanupFailed = false;
  if (interruptedTransport && !recoveredTransport && handoff?.daemon) {
    try {
      recoveredTransport = runLocalPowerShellJson(
        buildInstalledKioskGuestOperationScript({
          operation: "daemon_transport_interrupt",
          phase: "recover",
          operationId: interruptedTransport.guestOperationId,
          daemonRuntime: handoff.daemon,
        }),
        "daemon transport cleanup recovery",
      );
      cleanup.push({ label: "recover daemon transport", ok: true });
    } catch (error) {
      cleanupFailed = true;
      cleanup.push({
        label: "recover daemon transport",
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (guestInput && session?.sessionId) {
    try {
      const result = liveSale
        ? await controlPlaneRequest(
            guestInput,
            `/v1/serial-sessions/${session.sessionId}/stop`,
            {
              orderId: liveSale.orderId,
              paymentId: liveSale.paymentId,
              vendingCommandId: liveSale.vendingCommandId,
            },
          )
        : await controlPlaneRequest(
            guestInput,
            `/v1/serial-sessions/${session.sessionId}/abort`,
          );
      cleanup.push({
        label: liveSale ? "stop serial session" : "abort serial session",
        ok: true,
        result,
      });
    } catch (error) {
      cleanupFailed = true;
      cleanup.push({
        label: liveSale ? "stop serial session" : "abort serial session",
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (client) {
    try {
      await client.close();
      cleanup.push({ label: "close CDP client", ok: true });
    } catch (error) {
      cleanupFailed = true;
      cleanup.push({
        label: "close CDP client",
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  report.cleanup = {
    ok: cleanupFailed === false,
    steps: cleanup,
  };
  if (cleanupFailed) {
    report.ok = false;
    if (!failure) {
      report.error = "cleanup failed";
    }
  }

  writeJson(options.outPath, report);
  if (failure) throw failure;
  if (cleanupFailed) {
    throw new Error("ipc recovery cleanup failed");
  }
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runInstalledIpcRecoveryGuest(parseArgs(process.argv.slice(2))).catch(
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
