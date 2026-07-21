#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { runInstalledSystemTouchKeyboardAcceptance } from "./installed-system-touch-keyboard.mjs";

const SCHEMA_VERSION = "vem-local-operations-guest-full/v1";
function required(value, label) {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${label} is required`);
  return value.trim();
}
function option(args, name) {
  const i = args.indexOf(`--${name}`);
  return required(i < 0 ? undefined : args[i + 1], `--${name}`);
}
function localPath(value) {
  const path = required(value, "Windows path");
  return process.platform === "win32"
    ? path
    : resolve(
        `/mnt/${path[0].toLowerCase()}/${path.slice(3).replaceAll("\\", "/")}`,
      );
}
export function parseLocalOperationsGuestArgs(args) {
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
  if (!response.ok)
    throw new Error(
      `${options.method ?? "GET"} ${url} failed: ${JSON.stringify(payload)}`,
    );
  return payload;
}
function daemonUrl(handoff) {
  const url = required(handoff.daemon?.ready?.healthzUrl, "daemon healthzUrl");
  if (!url.endsWith("/healthz"))
    throw new Error("daemon healthzUrl must end with /healthz");
  return url.slice(0, -"/healthz".length);
}
function daemon(handoff, path, body) {
  return json(`${daemonUrl(handoff)}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${required(handoff.daemon?.ready?.ipcToken, "daemon ipcToken")}`,
      "content-type": "application/json",
    },
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

async function waitForSerialBoundary(input, sessionId, parsedOpcode) {
  return control(input, `/v1/serial-sessions/${sessionId}/wait-frame`, {
    parsedOpcode,
    timeoutMs: 30_000,
    serialScenario: "normal",
  });
}
export function canonicalPlanogramSlot(saleView, slotCode) {
  const code = required(slotCode, "slotCode");
  const item = (saleView?.items ?? []).find(
    (entry) => entry?.slotCode === code,
  );
  if (!item?.slotId || !item.inventoryId || !saleView?.planogramVersion)
    throw new Error(`active canonical planogram slot ${code} is unavailable`);
  return {
    slotCode: code,
    slotId: item.slotId,
    inventoryId: item.inventoryId,
    planogramVersion: saleView.planogramVersion,
    layerNo: item.layerNo,
    cellNo: item.cellNo,
  };
}
export function manualDispenseFrames(beforeEvidence, afterEvidence) {
  const beforeCount = beforeEvidence?.rawFrames?.length ?? 0;
  return (afterEvidence?.rawFrames ?? []).slice(beforeCount);
}
export function validateLocalOperationsEvidence(report) {
  if (report?.schemaVersion !== SCHEMA_VERSION || report.ok !== true)
    throw new Error("local operations report is not successful");
  if (
    report.boundaries?.daemon !== true ||
    report.boundaries?.hardwareSelfCheck !== true ||
    report.boundaries?.serial !== true ||
    report.planogram?.canonical !== true
  )
    throw new Error("local operations boundary evidence is incomplete");
  if (
    report.manualDispense?.slotCode == null ||
    !["completed", "failed", "result_unknown"].includes(
      report.manualDispense.outcome,
    )
  )
    throw new Error("manual dispense diagnostic outcome is missing");
  return {
    slotCode: report.manualDispense.slotCode,
    outcome: report.manualDispense.outcome,
    canonical: true,
  };
}
export async function runLocalOperationsGuest(options) {
  const input = readJson(options.guestInputPath);
  const handoff = readJson(options.handoffPath);
  const runId = required(input.runId, "runId");
  const fixture =
    input.fixtureAllocation?.[options.fixtureKey ?? "localOperations"] ??
    input.fixtureAllocation?.sale;
  const report = {
    schemaVersion: SCHEMA_VERSION,
    ok: false,
    mode: options.mode,
    runId,
    boundaries: { daemon: false, hardwareSelfCheck: false, serial: false },
    planogram: { canonical: false },
    manualDispense: null,
    hardware: null,
    systemTouchKeyboard: null,
  };
  let session = null;
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
      saleCorrelationId: `sale-correlation://${runId.toLowerCase()}.local-operations`,
    });
    const saleView = await daemon(handoff, "/v1/sale-view");
    const slot = canonicalPlanogramSlot(saleView, fixture?.slotCode);
    report.planogram = {
      canonical: true,
      planogramVersion: slot.planogramVersion,
      slotCode: slot.slotCode,
      slotId: slot.slotId,
    };
    report.hardware = {
      selfCheck: await daemon(handoff, "/v1/hardware/self-check", {}),
      bindings: await daemon(handoff, "/v1/hardware-bindings"),
    };
    report.boundaries.daemon = true;
    report.boundaries.hardwareSelfCheck =
      report.hardware.selfCheck?.online === true;
    const beforeEvidence = await control(
      input,
      `/v1/serial-sessions/${session.sessionId}/evidence`,
    );
    const diagnosticPromise = daemon(
      handoff,
      "/v1/maintenance/manual-dispense-diagnostic",
      {
        idempotencyKey: `${runId}-local-operations`,
        slotCode: slot.slotCode,
        quantity: 1,
        timeoutSeconds: 15,
      },
    );
    await waitForSerialBoundary(input, session.sessionId, "VEND");
    await control(input, `/v1/serial-sessions/${session.sessionId}/release-f0`);
    await waitForSerialBoundary(input, session.sessionId, "F0");
    await waitForSerialBoundary(input, session.sessionId, "F1");
    await control(input, `/v1/serial-sessions/${session.sessionId}/release-f2`);
    await waitForSerialBoundary(input, session.sessionId, "F2");
    const diagnostic = await diagnosticPromise;
    report.manualDispense = {
      ...diagnostic,
      slotCode: slot.slotCode,
      canonicalSlot: slot,
    };
    const evidence = await control(
      input,
      `/v1/serial-sessions/${session.sessionId}/evidence`,
    );
    report.serial = evidence;
    const operationFrames = manualDispenseFrames(beforeEvidence, evidence);
    report.serial.operationFrames = operationFrames;
    report.boundaries.serial = ["VEND", "F0", "F1", "AF", "F2"].every(
      (opcode) =>
        operationFrames.some((frame) => frame?.parsedOpcode === opcode),
    );
    if (diagnostic.outcome !== "completed" || !report.boundaries.serial)
      throw new Error(
        `manual dispense did not complete the lower-controller protocol: ${JSON.stringify({ outcome: diagnostic.outcome, frames: operationFrames.map((frame) => frame?.parsedOpcode) })}`,
      );
    const keyboardOutPath = options.outPath.replace(
      /[^\\]+$/,
      "system-touch-keyboard.json",
    );
    try {
      report.systemTouchKeyboard =
        await runInstalledSystemTouchKeyboardAcceptance({
          mode: options.mode,
          guestInputPath: options.guestInputPath,
          handoffPath: options.handoffPath,
          outPath: keyboardOutPath,
        });
    } catch (error) {
      report.systemTouchKeyboard = {
        ...readJson(keyboardOutPath),
        blocking: false,
        diagnosticError: error instanceof Error ? error.message : String(error),
      };
    }
    report.ok = true;
    validateLocalOperationsEvidence(report);
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
  runLocalOperationsGuest(
    parseLocalOperationsGuestArgs(process.argv.slice(2)),
  ).catch((error) => {
    console.error(error.stack ?? error);
    process.exitCode = 1;
  });
