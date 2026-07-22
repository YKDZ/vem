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
const ADMIN_OVERRIDE_GUARD_MS = 5_000;

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

function mqttMessage(evidence, commandNo, suffix) {
  return (
    mqttMessages(evidence).find((entry) => {
      const topic = String(entry?.topic ?? "");
      const payload = entry?.payload?.payload ?? entry?.payload;
      return (
        topic.includes("/environment-control") &&
        topic.includes(suffix) &&
        payload?.commandNo === commandNo
      );
    }) ?? null
  );
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

function b3Speed(frame) {
  const match = /^55b3(0[0-4])$/i.exec(String(frame?.rawFrameHex ?? ""));
  return match ? Number.parseInt(match[1], 16) : null;
}

function b3FramesSince(evidence, beforeFrameCount) {
  return (evidence?.rawFrames ?? [])
    .slice(beforeFrameCount)
    .filter((frame) => frame?.parsedOpcode === "B3")
    .map((frame) => ({ ...frame, speed: b3Speed(frame) }));
}

export function automaticSerialEvidence(evidence, beforeFrameCount) {
  return {
    b3FrameCountDelta: b3FramesSince(evidence, beforeFrameCount).length,
    protocolFrames: serialProtocolFrames(evidence, beforeFrameCount),
  };
}

async function waitForB3Frame({
  guestInput,
  sessionId,
  beforeFrameCount,
  expectedSpeed,
  timeoutMs = 45_000,
}) {
  const deadline = Date.now() + timeoutMs;
  let evidence = null;
  do {
    evidence = await control(
      guestInput,
      `/v1/serial-sessions/${sessionId}/evidence`,
      {},
    );
    const frame = b3FramesSince(evidence, beforeFrameCount).find(
      (entry) => entry.speed === expectedSpeed,
    );
    if (frame) return { evidence, frame };
    await sleep(100);
  } while (Date.now() < deadline);
  throw new Error(
    `automatic B3=${expectedSpeed} was not observed: ${JSON.stringify(b3FramesSince(evidence, beforeFrameCount))}`,
  );
}

async function requestAutomaticVentIntent({
  guestInput,
  handoff,
  sessionId,
  edgeId,
  ventSpeed,
}) {
  const beforeEvidence = await control(
    guestInput,
    `/v1/serial-sessions/${sessionId}/evidence`,
    {},
  );
  const beforeFrameCount = serialFrameCount(beforeEvidence);
  const response = await daemonPost(handoff, "/v1/intents/automatic-vent", {
    edgeId,
    ventSpeed,
  });
  if (response?.edgeId !== edgeId) {
    throw new Error(
      `automatic vent edge correlation is invalid: ${JSON.stringify(response)}`,
    );
  }
  if (response.outcome !== "accepted") {
    const evidence = await control(
      guestInput,
      `/v1/serial-sessions/${sessionId}/evidence`,
      {},
    );
    return {
      edgeId,
      requestedSpeed: ventSpeed,
      outcome: response.outcome,
      beforeFrameCount,
      ...automaticSerialEvidence(evidence, beforeFrameCount),
    };
  }
  const { evidence, frame } = await waitForB3Frame({
    guestInput,
    sessionId,
    beforeFrameCount,
    expectedSpeed: ventSpeed,
  });
  return {
    edgeId,
    requestedSpeed: ventSpeed,
    outcome: response.outcome,
    beforeFrameCount,
    frame,
    ...automaticSerialEvidence(evidence, beforeFrameCount),
  };
}

async function observeAdminOverrideGuard({
  guestInput,
  sessionId,
  beforeFrameCount,
}) {
  const startedAt = Date.now();
  const deadline = startedAt + ADMIN_OVERRIDE_GUARD_MS;
  let evidence = null;
  do {
    evidence = await control(
      guestInput,
      `/v1/serial-sessions/${sessionId}/evidence`,
      {},
    );
    const observation = automaticSerialEvidence(evidence, beforeFrameCount);
    if (observation.protocolFrames.length > 0) {
      return {
        completed: false,
        durationMs: Date.now() - startedAt,
        ...observation,
      };
    }
    if (Date.now() >= deadline) {
      return {
        completed: true,
        durationMs: Date.now() - startedAt,
        ...observation,
      };
    }
    await sleep(100);
  } while (true);
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
  const commandMqtt = mqttMessage(
    afterEvidence,
    admin.commandNo,
    "/commands/environment-control",
  );
  const resultMqtt = mqttMessage(
    afterEvidence,
    admin.commandNo,
    "/events/environment-control-result",
  );
  const protocolFrames = serialProtocolFrames(afterEvidence, beforeFrameCount);
  const protocolFrame = (afterEvidence?.rawFrames ?? [])
    .slice(beforeFrameCount)
    .find((frame) => frame?.parsedOpcode === expectedOpcode);
  return {
    action,
    request: body,
    admin,
    result,
    mqtt: {
      commandObserved: commandMqtt !== null,
      resultObserved: resultMqtt !== null,
      commandNo:
        commandMqtt?.payload?.payload?.commandNo ??
        commandMqtt?.payload?.commandNo ??
        null,
      resultCommandNo:
        resultMqtt?.payload?.payload?.commandNo ??
        resultMqtt?.payload?.commandNo ??
        null,
    },
    serial: {
      lowerBoundaryObserved:
        serialFrameCount(afterEvidence) > beforeFrameCount ||
        serialTailIdentity(afterEvidence) !== beforeTail,
      beforeFrameCount,
      afterFrameCount: serialFrameCount(afterEvidence),
      protocolFrames,
      expectedOpcode,
      protocolFrame,
      protocolFrameObserved: protocolFrames.includes(expectedOpcode),
      automaticB3FrameCount: b3FramesSince(afterEvidence, beforeFrameCount)
        .length,
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
    daemon: null,
    precedence: null,
    boundaries: {
      adminApi: false,
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
    const automaticArrival = await requestAutomaticVentIntent({
      guestInput,
      handoff,
      sessionId: session.sessionId,
      edgeId: `environment-control:${runId}:arrival`,
      ventSpeed: 2,
    });
    const adminVent = await commandEnvironment({
      guestInput,
      token,
      machineId: machine.id,
      sessionId: session.sessionId,
      action: "ventSpeed",
      body: { ventSpeed: 3 },
    });
    report.commands.push(adminVent);
    const sameEdgeAfterAdmin = await requestAutomaticVentIntent({
      guestInput,
      handoff,
      sessionId: session.sessionId,
      edgeId: automaticArrival.edgeId,
      ventSpeed: 2,
    });
    sameEdgeAfterAdmin.guardWindow = await observeAdminOverrideGuard({
      guestInput,
      sessionId: session.sessionId,
      beforeFrameCount: sameEdgeAfterAdmin.beforeFrameCount,
    });
    report.precedence = {
      automaticArrival,
      adminB3: {
        commandNo: adminVent.admin.commandNo,
        resultStatus: adminVent.result.status,
        mqttCommandNo: adminVent.mqtt.commandNo,
        mqttResultNo: adminVent.mqtt.resultCommandNo,
        frame: adminVent.serial.protocolFrame ?? null,
      },
      sameEdgeAfterAdmin,
      nextStableEdge: null,
    };
    if (sameEdgeAfterAdmin.guardWindow.completed !== true) {
      const { protocolFrames, b3FrameCountDelta } =
        sameEdgeAfterAdmin.guardWindow;
      const reason =
        b3FrameCountDelta > 0
          ? "delayed automatic B3 rebound"
          : "lower-controller activity";
      throw new Error(
        `Admin B3 override guard observed ${reason}: ${JSON.stringify(protocolFrames)}`,
      );
    }
    const nextStableEdge = await requestAutomaticVentIntent({
      guestInput,
      handoff,
      sessionId: session.sessionId,
      edgeId: `environment-control:${runId}:departure`,
      ventSpeed: 0,
    });
    report.commands.push(
      await commandEnvironment({
        guestInput,
        token,
        machineId: machine.id,
        sessionId: session.sessionId,
        action: "targetTemperatureCelsius",
        body: { targetTemperatureCelsius: 23 },
      }),
    );
    report.precedence.nextStableEdge = nextStableEdge;
    report.daemon = {
      health: await daemonGet(handoff, "/healthz"),
      readiness: await daemonGet(handoff, "/readyz"),
    };
    report.boundaries.adminApi = report.commands.every(
      (entry) =>
        typeof entry.admin?.commandNo === "string" &&
        entry.admin.commandNo !== "" &&
        entry.admin.status === "sent" &&
        entry.result?.status === "succeeded" &&
        entry.result?.resultJson?.success === true,
    );
    report.boundaries.mqtt = report.commands.every(
      (entry) =>
        entry.mqtt.commandObserved &&
        entry.mqtt.resultObserved &&
        entry.mqtt.commandNo === entry.admin.commandNo &&
        entry.mqtt.resultCommandNo === entry.admin.commandNo,
    );
    report.boundaries.lowerSerial = report.commands.every(
      (entry) =>
        entry.serial.lowerBoundaryObserved &&
        entry.serial.protocolFrameObserved &&
        entry.result?.status === "succeeded" &&
        entry.serial.protocolFrame?.parsedOpcode ===
          entry.serial.expectedOpcode,
    );
    report.boundaries.daemonIpc =
      report.daemon.health?.hardwareOnline === true &&
      report.daemon.readiness?.ready === true &&
      automaticArrival.outcome === "accepted" &&
      automaticArrival.requestedSpeed === 2 &&
      automaticArrival.frame?.parsedOpcode === "B3" &&
      b3Speed(automaticArrival.frame) === 2 &&
      sameEdgeAfterAdmin.edgeId === automaticArrival.edgeId &&
      sameEdgeAfterAdmin.outcome === "deduplicated" &&
      sameEdgeAfterAdmin.b3FrameCountDelta === 0 &&
      sameEdgeAfterAdmin.protocolFrames.length === 0 &&
      sameEdgeAfterAdmin.guardWindow.completed === true &&
      sameEdgeAfterAdmin.guardWindow.durationMs >= ADMIN_OVERRIDE_GUARD_MS &&
      sameEdgeAfterAdmin.guardWindow.protocolFrames.length === 0 &&
      sameEdgeAfterAdmin.guardWindow.b3FrameCountDelta === 0 &&
      nextStableEdge.edgeId !== automaticArrival.edgeId &&
      nextStableEdge.outcome === "accepted" &&
      nextStableEdge.requestedSpeed === 0 &&
      nextStableEdge.frame?.parsedOpcode === "B3" &&
      b3Speed(nextStableEdge.frame) === 0 &&
      automaticArrival.b3FrameCountDelta === 1 &&
      automaticArrival.protocolFrames.length === 1 &&
      automaticArrival.protocolFrames[0] === "B3" &&
      nextStableEdge.b3FrameCountDelta === 1 &&
      nextStableEdge.protocolFrames.length === 1 &&
      nextStableEdge.protocolFrames[0] === "B3";
    report.ok = Object.values(report.boundaries).every(Boolean);
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
