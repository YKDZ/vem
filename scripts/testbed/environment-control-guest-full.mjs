#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { waitForDaemonReadyRefresh } from "./daemon-ready-refresh.mjs";
import { waitForHardwareBindings } from "./scanner-payment-code-guest-full.mjs";

const SCHEMA_VERSION = "vem-environment-control-guest-full/v1";
const ADMIN_USER = "local-testbed-admin";
const ADMIN_PASSWORD = "LocalTestbedAdminPassword!";

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
    const error = new Error(
      `${options.method ?? "GET"} ${url} failed with HTTP ${response.status}: ${JSON.stringify(payload)}`,
    );
    error.httpStatus = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
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

function apiBase(guestInput) {
  return required(
    guestInput.runtimeBootstrap?.provisioningApiBaseUrl,
    "runtimeBootstrap.provisioningApiBaseUrl",
  ).replace(/\/+$/, "");
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

function daemonPost(handoff, path, body = {}) {
  return fetchJson(`${daemonBaseUrl(handoff)}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${required(handoff.daemon?.ready?.ipcToken, "daemon ipcToken")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
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

async function adminRequest(
  guestInput,
  path,
  { token = null, method = "GET", body = null } = {},
) {
  const payload = await fetchJson(`${apiBase(guestInput)}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return unwrapServiceApiEnvelope(payload);
}

async function adminLogin(guestInput) {
  const login = await adminRequest(guestInput, "/auth/login", {
    method: "POST",
    body: { username: ADMIN_USER, password: ADMIN_PASSWORD },
  });
  return required(login.accessToken, "admin accessToken");
}

async function findMachine(guestInput, token) {
  const page = await adminRequest(guestInput, "/machines?page=1&pageSize=100", {
    token,
  });
  const machine = page.items?.find(
    (entry) => entry?.code === guestInput.machineCode,
  );
  if (!machine?.id)
    throw new Error(`admin machine ${guestInput.machineCode} was not found`);
  return machine;
}

async function waitForCommandResult(
  guestInput,
  token,
  machineId,
  commandNo,
  timeoutMs = 45_000,
) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await adminRequest(guestInput, `/machines/${machineId}`, {
      token,
    }).catch(() => null);
    const command = last?.latestEnvironmentCommand;
    if (
      command?.commandNo === commandNo &&
      ["succeeded", "failed", "timeout"].includes(command.status)
    ) {
      return command;
    }
    await sleep(250);
  }
  throw new Error(
    `environment command ${commandNo} did not reach terminal state: ${JSON.stringify(last?.latestEnvironmentCommand ?? null)}`,
  );
}

function mqttMessages(evidence) {
  return [
    ...(evidence?.mqtt?.messages ?? []),
    ...(evidence?.machineMqtt?.messages ?? []),
  ];
}

function mqttObserved(evidence, commandNo, suffix) {
  return mqttMessages(evidence).some((entry) => {
    const topic = String(entry?.topic ?? "");
    const payload = entry?.payload?.payload ?? entry?.payload;
    return (
      topic.includes("/environment-control") &&
      topic.includes(suffix) &&
      payload?.commandNo === commandNo
    );
  });
}

function serialFrameCount(evidence) {
  return Array.isArray(evidence?.rawFrames) ? evidence.rawFrames.length : 0;
}

function serialTailIdentity(evidence) {
  const frames = Array.isArray(evidence?.rawFrames) ? evidence.rawFrames : [];
  return frames
    .slice(-8)
    .map(
      (frame) =>
        `${frame.boundaryId ?? ""}:${frame.rawFrameHex ?? ""}:${frame.parsedOpcode ?? ""}`,
    )
    .join("|");
}

function serialProtocolFrames(evidence, beforeFrameCount) {
  return (evidence?.rawFrames ?? [])
    .slice(beforeFrameCount)
    .filter((frame) => frame?.parsedOpcode)
    .map((frame) => frame.parsedOpcode);
}

async function commandEnvironment({
  guestInput,
  token,
  machineId,
  sessionId,
  action,
  body,
}) {
  const beforeEvidence = await control(
    guestInput,
    `/v1/serial-sessions/${sessionId}/evidence`,
    {},
  );
  const beforeFrameCount = serialFrameCount(beforeEvidence);
  const beforeTail = serialTailIdentity(beforeEvidence);
  const admin = await adminRequest(
    guestInput,
    `/machines/${machineId}/commands/environment-control`,
    {
      token,
      method: "POST",
      body,
    },
  );
  const result = await waitForCommandResult(
    guestInput,
    token,
    machineId,
    admin.commandNo,
  );
  const afterEvidence = await control(
    guestInput,
    `/v1/serial-sessions/${sessionId}/evidence`,
    {},
  );
  const expectedOpcode =
    action === "airConditionerOnTrue" || action === "airConditionerOnFalse"
      ? "B2"
      : action === "ventSpeed"
        ? "B3"
        : "B1";
  return {
    action,
    request: body,
    admin,
    result,
    mqtt: {
      commandObserved: mqttObserved(
        afterEvidence,
        admin.commandNo,
        "/commands/environment-control",
      ),
      resultObserved: mqttObserved(
        afterEvidence,
        admin.commandNo,
        "/events/environment-control-result",
      ),
    },
    serial: {
      lowerBoundaryObserved:
        serialFrameCount(afterEvidence) > beforeFrameCount ||
        serialTailIdentity(afterEvidence) !== beforeTail,
      beforeFrameCount,
      afterFrameCount: serialFrameCount(afterEvidence),
      protocolFrames: serialProtocolFrames(afterEvidence, beforeFrameCount),
      expectedOpcode,
      protocolFrameObserved: serialProtocolFrames(
        afterEvidence,
        beforeFrameCount,
      ).includes(expectedOpcode),
    },
  };
}

async function proveOverlapRejection({ guestInput, token, machineId }) {
  const first = adminRequest(
    guestInput,
    `/machines/${machineId}/commands/environment-control`,
    {
      token,
      method: "POST",
      body: { airConditionerOn: true },
    },
  );
  try {
    await adminRequest(
      guestInput,
      `/machines/${machineId}/commands/environment-control`,
      {
        token,
        method: "POST",
        body: { ventSpeed: 2 },
      },
    );
    return {
      rejected: false,
      httpStatus: null,
      error: null,
      first: await first,
    };
  } catch (error) {
    return {
      rejected: true,
      httpStatus: error.httpStatus ?? null,
      error: error.payload?.message ?? error.payload?.error ?? null,
      first: await first.catch((firstError) => ({
        error:
          firstError instanceof Error ? firstError.message : String(firstError),
      })),
    };
  }
}

export async function runEnvironmentControlGuest(options) {
  const guestInput = readJson(options.guestInputPath);
  const handoff = readJson(options.handoffPath);
  const runId = required(guestInput.runId, "runId");
  const machineCode = required(guestInput.machineCode, "machineCode");
  let session = null;
  const report = {
    schemaVersion: SCHEMA_VERSION,
    ok: false,
    mode: options.mode,
    runId,
    machineCode,
    commands: [],
    overlapRejection: null,
    boundaries: {
      adminApi: true,
      mqtt: false,
      daemonIpc: false,
      lowerSerial: false,
    },
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
      saleCorrelationId: `sale-correlation://${runId.toLowerCase()}.environment-control`,
    });
    await waitForDaemonReadyRefresh(handoff);
    await waitForHardwareBindings(handoff, session);
    const hardware = await daemonPost(handoff, "/v1/hardware/self-check", {});
    if (hardware?.online !== true) {
      throw new Error(
        `lower-controller was not ready before environment commands: ${JSON.stringify(hardware)}`,
      );
    }
    const token = await adminLogin(guestInput);
    const machine = await findMachine(guestInput, token);

    report.overlapRejection = await proveOverlapRejection({
      guestInput,
      token,
      machineId: machine.id,
    });
    if (report.overlapRejection.first?.commandNo) {
      await waitForCommandResult(
        guestInput,
        token,
        machine.id,
        report.overlapRejection.first.commandNo,
      ).catch(() => null);
    }

    for (const step of [
      ["airConditionerOnTrue", { airConditionerOn: true }],
      ["airConditionerOnFalse", { airConditionerOn: false }],
      ["ventSpeed", { ventSpeed: 3 }],
      ["targetTemperatureCelsius", { targetTemperatureCelsius: 23 }],
    ]) {
      report.commands.push(
        await commandEnvironment({
          guestInput,
          token,
          machineId: machine.id,
          sessionId: session.sessionId,
          action: step[0],
          body: step[1],
        }),
      );
    }
    report.boundaries.mqtt = report.commands.every(
      (entry) => entry.mqtt.commandObserved && entry.mqtt.resultObserved,
    );
    report.boundaries.lowerSerial = report.commands.every(
      (entry) =>
        entry.serial.lowerBoundaryObserved &&
        entry.serial.protocolFrameObserved &&
        entry.result?.status === "succeeded",
    );
    report.boundaries.daemonIpc =
      (await daemonGet(handoff, "/healthz")).hardwareOnline === true &&
      (await daemonGet(handoff, "/readyz")).ready === true;
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
  runEnvironmentControlGuest(parseArgs(process.argv.slice(2))).catch(
    (error) => {
      console.error(error instanceof Error ? error.stack : String(error));
      process.exitCode = 1;
    },
  );
}
