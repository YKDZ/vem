#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { waitForDaemonReadyRefresh } from "./daemon-ready-refresh.mjs";
import { waitForHardwareBindings } from "./scanner-payment-code-guest-full.mjs";

const SCHEMA_VERSION = "vem-hardware-lifecycle-guest-full/v1";

function required(value, label) {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${label} is required`);
  return value.trim();
}

function option(args, name) {
  const index = args.indexOf(`--${name}`);
  const value = index === -1 ? undefined : args[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`--${name} requires a value`);
  return value;
}

function optionalOption(args, name) {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? null : required(args[index + 1], `--${name}`);
}

function windowsAbsolute(value, label) {
  const path = required(value, label);
  if (!/^[A-Za-z]:\\/.test(path) || path.includes("\0"))
    throw new Error(`${label} must be an absolute Windows path`);
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

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: options.signal ?? AbortSignal.timeout(30_000),
  });
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
  if (!healthzUrl.endsWith("/healthz"))
    throw new Error("daemon healthzUrl must end with /healthz");
  return healthzUrl.slice(0, -"/healthz".length);
}

function daemonGet(handoff, path) {
  return fetchJson(`${daemonBaseUrl(handoff)}${path}`, {
    headers: {
      authorization: `Bearer ${required(handoff.daemon?.ready?.ipcToken, "daemon ipcToken")}`,
    },
  });
}

function control(guestInput, path, body = {}) {
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

async function waitForRoleState(handoff, role, ready, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const [bindings, healthz, readyz, capability] = await Promise.all([
      daemonGet(handoff, "/v1/hardware-bindings").catch(() => null),
      daemonGet(handoff, "/healthz").catch(() => null),
      daemonGet(handoff, "/readyz").catch(() => null),
      daemonGet(handoff, "/v1/sale-start-capability").catch(() => null),
    ]);
    const state = bindings?.roles?.find((entry) => entry?.role === role);
    last = { bindings, healthz, readyz, capability, state };
    const detached = ready || state?.currentPort == null;
    if (state?.ready === ready && detached) {
      return {
        ready,
        currentPort: state.currentPort ?? null,
        bindingRevision: state.bindingRevision ?? null,
        identityKey: state.binding?.identity?.identityKey ?? null,
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

export function capabilityReflectsRoleState(capability, role, ready) {
  if (!capability) return false;
  if (role === "lower_controller") return capability.canStartSale === ready;
  const paymentCodeOptions = (capability.paymentOptions?.options ?? []).filter(
    (option) => option?.method === "payment_code",
  );
  return (
    paymentCodeOptions.length > 0 &&
    paymentCodeOptions.some((option) => option?.ready === true) === ready
  );
}

async function waitForRoleCapability(handoff, role, ready, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await daemonGet(handoff, "/v1/sale-start-capability").catch(
      () => null,
    );
    if (capabilityReflectsRoleState(last, role, ready)) return last;
    await sleep(100);
  }
  throw new Error(
    `timed out waiting for ${role} capability ready=${ready}: ${JSON.stringify(last)}`,
  );
}

function roleSummary(snapshot) {
  return (snapshot?.roles ?? []).map((role) => ({
    role: role.role,
    ready: role.ready,
    currentPort: role.currentPort ?? null,
    bindingRevision: role.bindingRevision ?? null,
    identityKey: role.binding?.identity?.identityKey ?? null,
    candidateCount: Array.isArray(role.candidates) ? role.candidates.length : 0,
  }));
}

export function serialObservationsForLifecycle(observations, role, connected) {
  if (connected) return observations;
  const expectedPid = role === "scanner" ? "PID_55D3" : "PID_7523";
  return observations.filter(
    (observation) =>
      !JSON.stringify(observation.hardwareIds ?? [])
        .toUpperCase()
        .includes(expectedPid),
  );
}

export async function runHardwareLifecycleGuest(options) {
  const guestInput = readJson(options.guestInputPath);
  const handoff = readJson(options.handoffPath);
  const runId = required(guestInput.runId, "runId");
  const machineCode = required(guestInput.machineCode, "machineCode");
  const discoveryPath = resolve(
    dirname(options.handoffPath),
    "serial-device-observations.json",
  );
  const originalObservations = readJson(discoveryPath);
  let session = null;
  const report = {
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
    session = await control(guestInput, "/v1/serial-sessions/start", {
      runId,
      machineCode,
      targetIdentity: required(
        guestInput.hostControlPlane?.targetIdentity,
        "hostControlPlane.targetIdentity",
      ),
      runtimeBase: required(
        guestInput.hostControlPlane?.runtimeBaseIdentity,
        "hostControlPlane.runtimeBaseIdentity",
      ),
      saleCorrelationId: `sale-correlation://${runId.toLowerCase()}.hardware-lifecycle`,
    });
    report.handoffSerialSessionId = required(
      session?.sessionId,
      "hardware lifecycle serial session id",
    );
    await waitForDaemonReadyRefresh(handoff);
    const ready = await waitForHardwareBindings(handoff, session);
    const beforeCapability = await daemonGet(
      handoff,
      "/v1/sale-start-capability",
    );
    report.discovery = {
      dynamicRoleDiscovery: true,
      fixedComSelection: false,
      roles: roleSummary(ready.daemon),
      qemuUsbSerialMappings: session.qemuUsbSerialMappings,
    };
    report.readiness = { before: beforeCapability, after: null };

    for (const role of ["scanner", "lower_controller"]) {
      const initial = ready.daemon.roles.find((entry) => entry.role === role);
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
      report.lifecycle.push({
        role,
        initialBindingRevision: initial?.bindingRevision ?? null,
        identityKey: initial?.binding?.identity?.identityKey ?? null,
        disconnect: {
          boundary: {
            adapter: "file_backed_windows_pnp",
            operation: "disconnect",
            identityKey: initial?.binding?.identity?.identityKey ?? null,
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
            identityKey: initial?.binding?.identity?.identityKey ?? null,
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
    report.readiness.after = await daemonGet(
      handoff,
      "/v1/sale-start-capability",
    );
    report.ok = true;
    writeJson(options.outPath, report);
    return report;
  } catch (error) {
    report.error = {
      message: error instanceof Error ? error.message : String(error),
      stack: String(error?.stack ?? "").slice(0, 16 * 1024),
    };
    writeJson(options.outPath, report);
    throw error;
  } finally {
    writeJson(discoveryPath, originalObservations);
    if (session?.sessionId) {
      await control(
        guestInput,
        `/v1/serial-sessions/${session.sessionId}/abort`,
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
