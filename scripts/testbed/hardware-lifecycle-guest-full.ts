#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { waitForDaemonReadyRefresh } from "./daemon-ready-refresh.ts";
import { waitForHardwareBindings } from "./scanner-payment-code-guest-full.ts";

const SCHEMA_VERSION = "vem-hardware-lifecycle-guest-full/v1";

type JsonRecord = Record<string, unknown>;
type GuestInputRecord = JsonRecord;
type HandoffRecord = JsonRecord;

function required(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${label} is required`);
  return value.trim();
}

function option(args: string[], name: string): string {
  const index = args.indexOf(`--${name}`);
  const value = index === -1 ? undefined : args[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`--${name} requires a value`);
  return value;
}

function optionalOption(args: string[], name: string): string | null {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? null : required(args[index + 1], `--${name}`);
}

function windowsAbsolute(value: unknown, label: string): string {
  const path = required(value, label);
  if (!/^[A-Za-z]:\\/.test(path) || path.includes("\0"))
    throw new Error(`${label} must be an absolute Windows path`);
  return path;
}

function localPath(path: string): string {
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

function parseArgs(args: string[]): {
  mode: "full";
  guestInputPath: string;
  handoffPath: string;
  outPath: string;
  fixtureKey: string | null;
} {
  if (required(option(args, "mode"), "--mode") !== "full")
    throw new Error("--mode must be full");
  return {
    mode: "full",
    guestInputPath: windowsAbsolute(
      option(args, "guest-input"),
      "--guest-input",
    ),
    handoffPath: windowsAbsolute(option(args, "handoff"), "--handoff"),
    outPath: windowsAbsolute(option(args, "out"), "--out"),
    fixtureKey: optionalOption(args, "fixture-key"),
  };
}

async function fetchJson(
  url: string,
  options: JsonRecord = {},
): Promise<unknown> {
  const response = await fetch(url, {
    ...options,
    signal: (options.signal as AbortSignal | undefined) ??
      AbortSignal.timeout(30_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      `${options.method ?? "GET"} ${url} failed with HTTP ${response.status}: ${JSON.stringify(payload)}`,
    );
  }
  return payload;
}

function daemonBaseUrl(handoff: HandoffRecord): string {
  const daemon = handoff.daemon as JsonRecord | undefined;
  const ready = daemon?.ready as JsonRecord | undefined;
  const healthzUrl = required(
    ready?.healthzUrl,
    "daemon healthzUrl",
  );
  if (!healthzUrl.endsWith("/healthz"))
    throw new Error("daemon healthzUrl must end with /healthz");
  return healthzUrl.slice(0, -"/healthz".length);
}

function daemonGet(handoff: HandoffRecord, path: string): Promise<unknown> {
  const daemon = handoff.daemon as JsonRecord | undefined;
  const ready = daemon?.ready as JsonRecord | undefined;
  return fetchJson(`${daemonBaseUrl(handoff)}${path}`, {
    headers: {
      authorization: `Bearer ${required(ready?.ipcToken, "daemon ipcToken")}`,
    },
  });
}

function control(
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

async function waitForRoleState(
  handoff: HandoffRecord,
  role: string,
  ready: boolean,
  timeoutMs = 45_000,
): Promise<JsonRecord> {
  const deadline = Date.now() + timeoutMs;
  let last: JsonRecord | null = null;
  while (Date.now() < deadline) {
    const [bindings, healthz, readyz, capability] = await Promise.all([
      daemonGet(handoff, "/v1/hardware-bindings").catch(() => null),
      daemonGet(handoff, "/healthz").catch(() => null),
      daemonGet(handoff, "/readyz").catch(() => null),
      daemonGet(handoff, "/v1/sale-start-capability").catch(() => null),
    ]);
    const bindingsRecord = bindings as JsonRecord | null;
    const roles = (bindingsRecord?.roles ?? []) as unknown[];
    const state = roles.find(
      (entry) => (entry as JsonRecord)?.role === role,
    ) as JsonRecord | undefined;
    last = {
      bindings: bindingsRecord,
      healthz,
      readyz,
      capability,
      state,
    };
    const detached = ready || state?.currentPort == null;
    if (state?.ready === ready && detached) {
      return {
        ready,
        currentPort: state.currentPort ?? null,
        bindingRevision: state.bindingRevision ?? null,
        identityKey: ((state.binding as JsonRecord | undefined)?.identity as
          | JsonRecord
          | undefined)?.identityKey ?? null,
        healthz,
        readyz,
      };
    }
    await sleep(250);
  }
  throw new Error(
    `timed out waiting for ${role} ready=${ready}: ${JSON.stringify(last)}`,
  );
}

export function capabilityReflectsRoleState(
  capability: JsonRecord | null | undefined,
  role: string,
  ready: boolean,
): boolean {
  if (!capability) return false;
  if (role === "lower_controller") {
    return capability.canStartSale === ready;
  }
  const paymentCodeOptions = (
    ((capability.paymentOptions as JsonRecord | undefined)?.options ?? []) as
      | unknown[]
  ).filter(
    (option) => (option as JsonRecord)?.method === "payment_code",
  );
  return (
    paymentCodeOptions.length > 0 &&
    paymentCodeOptions.some(
      (option) => (option as JsonRecord)?.ready === true,
    ) === ready
  );
}

async function waitForRoleCapability(
  handoff: HandoffRecord,
  role: string,
  ready: boolean,
  timeoutMs = 15_000,
): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown = null;
  while (Date.now() < deadline) {
    last = await daemonGet(handoff, "/v1/sale-start-capability").catch(
      () => null,
    );
    if (capabilityReflectsRoleState(last as JsonRecord | null, role, ready))
      return last;
    await sleep(100);
  }
  throw new Error(
    `timed out waiting for ${role} capability ready=${ready}: ${JSON.stringify(last)}`,
  );
}

function roleSummary(snapshot: JsonRecord | null | undefined): JsonRecord[] {
  return ((snapshot?.roles ?? []) as unknown[]).map((role) => {
    const roleRecord = role as JsonRecord;
    return {
    role: roleRecord.role,
    ready: roleRecord.ready,
    currentPort: roleRecord.currentPort ?? null,
    bindingRevision: roleRecord.bindingRevision ?? null,
    identityKey: ((roleRecord.binding as JsonRecord | undefined)?.identity as
      | JsonRecord
      | undefined)?.identityKey ?? null,
    candidateCount: Array.isArray(roleRecord.candidates)
      ? (roleRecord.candidates as unknown[]).length
      : 0,
    };
  });
}

export function serialObservationsForLifecycle(
  observations: unknown,
  role: string,
  connected: boolean,
): unknown {
  if (connected) return observations;
  const expectedPid = role === "scanner" ? "PID_55D3" : "PID_7523";
  return (Array.isArray(observations) ? observations : []).filter(
    (observation) =>
      !JSON.stringify((observation as JsonRecord).hardwareIds ?? [])
        .toUpperCase()
        .includes(expectedPid),
  );
}

export async function runHardwareLifecycleGuest(options: {
  mode: "full";
  guestInputPath: string;
  handoffPath: string;
  outPath: string;
  fixtureKey: string | null;
}): Promise<JsonRecord> {
  const guestInput = readJson(options.guestInputPath);
  const handoff = readJson(options.handoffPath);
  const runId = required(guestInput.runId, "runId");
  const machineCode = required(guestInput.machineCode, "machineCode");
  const discoveryPath = resolve(
    dirname(options.handoffPath),
    "serial-device-observations.json",
  );
  const originalObservations = readJson(discoveryPath);
  let session: JsonRecord | null = null;
  const report: JsonRecord = {
    schemaVersion: SCHEMA_VERSION,
    ok: false,
    mode: options.mode,
    runId,
    machineCode,
    handoffSerialSessionId: null,
    discovery: null,
    readiness: null,
    lifecycle: [],
  };
  try {
    session = (await control(guestInput, "/v1/serial-sessions/start", {
      runId,
      machineCode,
      targetIdentity: required(
        (guestInput.hostControlPlane as JsonRecord | undefined)
          ?.targetIdentity,
        "hostControlPlane.targetIdentity",
      ),
      runtimeBase: required(
        (guestInput.hostControlPlane as JsonRecord | undefined)
          ?.runtimeBaseIdentity,
        "hostControlPlane.runtimeBaseIdentity",
      ),
      saleCorrelationId: `sale-correlation://${runId.toLowerCase()}.hardware-lifecycle`,
    })) as JsonRecord;
    const activeSession = session as JsonRecord;
    report.handoffSerialSessionId = required(
      activeSession.sessionId,
      "hardware lifecycle serial session id",
    );
    await waitForDaemonReadyRefresh(handoff);
    const ready = await waitForHardwareBindings(handoff, session);
    const beforeCapability = await daemonGet(
      handoff,
      "/v1/sale-start-capability",
    );
    const readyRecord = ready as JsonRecord;
    const readyDaemon = readyRecord.daemon as JsonRecord;
    report.discovery = {
      dynamicRoleDiscovery: true,
      fixedComSelection: false,
      roles: roleSummary(readyDaemon),
      qemuUsbSerialMappings: activeSession.qemuUsbSerialMappings,
    };
    report.readiness = { before: beforeCapability, after: null };

    for (const role of ["scanner", "lower_controller"]) {
      const roles = (readyDaemon.roles ?? []) as unknown[];
      const initial = roles.find(
        (entry) => (entry as JsonRecord).role === role,
      ) as JsonRecord | undefined;
      writeJson(
        discoveryPath,
        serialObservationsForLifecycle(originalObservations, role, false),
      );
      const disconnected = await waitForRoleState(handoff, role, false);
      const disconnectedCapability = await waitForRoleCapability(
        handoff,
        role,
        false,
      );
      writeJson(discoveryPath, originalObservations);
      const reconnected = await waitForRoleState(handoff, role, true);
      const reconnectedCapability = await waitForRoleCapability(
        handoff,
        role,
        true,
      );
      (report.lifecycle as unknown[]).push({
        role,
        initialBindingRevision: initial?.bindingRevision ?? null,
        identityKey: ((initial?.binding as JsonRecord | undefined)?.identity as
          | JsonRecord
          | undefined)?.identityKey ?? null,
        disconnect: {
          boundary: {
            adapter: "file_backed_windows_pnp",
            operation: "disconnect",
            identityKey: ((initial?.binding as JsonRecord | undefined)
              ?.identity as JsonRecord | undefined)?.identityKey ?? null,
          },
          daemon: {
            ready: disconnected.ready,
            currentPort: disconnected.currentPort,
            bindingRevision: disconnected.bindingRevision,
            identityKey: disconnected.identityKey,
          },
          saleStartCapability: disconnectedCapability,
        },
        reconnect: {
          boundary: {
            adapter: "file_backed_windows_pnp",
            operation: "reconnect",
            identityKey: ((initial?.binding as JsonRecord | undefined)
              ?.identity as JsonRecord | undefined)?.identityKey ?? null,
          },
          daemon: {
            ready: reconnected.ready,
            currentPort: reconnected.currentPort,
            bindingRevision: reconnected.bindingRevision,
            identityKey: reconnected.identityKey,
          },
          bindingRevision: reconnected.bindingRevision,
          saleStartCapability: reconnectedCapability,
        },
      });
    }
    (report.readiness as JsonRecord).after = await daemonGet(
      handoff,
      "/v1/sale-start-capability",
    );
    report.ok = true;
    writeJson(options.outPath, report);
    return report;
  } catch (error) {
    report.error = {
      message: error instanceof Error ? error.message : String(error),
      stack: String((error as Error)?.stack ?? "").slice(0, 16 * 1024),
    };
    writeJson(options.outPath, report);
    throw error;
  } finally {
    writeJson(discoveryPath, originalObservations);
    if (session?.sessionId) {
      await control(
        guestInput,
        `/v1/serial-sessions/${String((session as JsonRecord).sessionId)}/abort`,
        {},
      ).catch(() => null);
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runHardwareLifecycleGuest(parseArgs(process.argv.slice(2))).catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
