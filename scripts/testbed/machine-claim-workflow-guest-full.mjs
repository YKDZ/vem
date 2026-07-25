#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  activateVisibleSelector,
  captureScreenshot,
  CdpClient,
  discoverMachineUiTarget,
  enablePageRuntime,
  evaluateExpression,
  rewriteWebSocketDebuggerUrl,
  waitForRoute,
} from "./machine-ui-cdp-driver.mjs";

const SCHEMA_VERSION = "vem-machine-claim-workflow-guest-full/v1";
const TIMEOUT_MS = 45_000;
const POLL_MS = 250;
const COMMISSIONING_TASK_SELECTOR =
  "[data-test='maintenance-task-commissioning']";
const MAINTENANCE_ENTRY_SELECTOR =
  "[data-test='maintenance-entry-header'], [data-test='maintenance-entry-brand']";

function required(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function option(args, name) {
  const index = args.indexOf(`--${name}`);
  return required(index < 0 ? undefined : args[index + 1], `--${name}`);
}

function localPath(value) {
  const path = required(value, "Windows path");
  return process.platform === "win32"
    ? path
    : resolve(
        `/mnt/${path[0].toLowerCase()}/${path.slice(3).replaceAll("\\", "/")}`,
      );
}

export function parseMachineClaimWorkflowGuestArgs(args) {
  if (option(args, "mode") !== "full") throw new Error("--mode must be full");
  return {
    mode: "full",
    guestInputPath: option(args, "guest-input"),
    handoffPath: option(args, "handoff"),
    outPath: option(args, "out"),
  };
}

function readJson(path) {
  return JSON.parse(readFileSync(localPath(path), "utf8"));
}

function writeJson(path, value) {
  const target = localPath(path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function parseServiceApiEnvelope(payload) {
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    payload.code !== 0 ||
    !Object.hasOwn(payload, "data")
  ) {
    throw new Error("Service API response must be a success envelope");
  }
  return payload.data;
}

async function request(url, { parse = (value) => value, ...options } = {}) {
  const response = await fetch(url, {
    ...options,
    signal: options.signal ?? AbortSignal.timeout(TIMEOUT_MS),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      `${options.method ?? "GET"} ${url} returned HTTP ${response.status}: ${JSON.stringify(payload)}`,
    );
  }
  return parse(payload);
}

function apiBase(input) {
  return required(
    input?.runtimeBootstrap?.provisioningApiBaseUrl,
    "runtimeBootstrap.provisioningApiBaseUrl",
  ).replace(/\/+$/, "");
}

async function adminToken(input) {
  const login = await request(`${apiBase(input)}/auth/login`, {
    parse: parseServiceApiEnvelope,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: required(
        input?.serviceApi?.adminUsername,
        "serviceApi.adminUsername",
      ),
      password: required(
        input?.serviceApi?.adminPassword,
        "serviceApi.adminPassword",
      ),
    }),
  });
  return required(login?.accessToken, "admin access token");
}

async function findMachine(input, token) {
  const page = await request(`${apiBase(input)}/machines?page=1&pageSize=100`, {
    parse: parseServiceApiEnvelope,
    headers: { authorization: `Bearer ${token}` },
  });
  const machine = (page?.items ?? []).find(
    (entry) => entry?.code === input.machineCode,
  );
  if (!machine?.id) {
    throw new Error(`machine ${input.machineCode} was not found`);
  }
  return machine;
}

async function generateReclaimCode(input, token, machineId) {
  const endpoint = `${apiBase(input)}/machines/${encodeURIComponent(machineId)}/claim-codes`;
  const claim = await request(endpoint, {
    parse: parseServiceApiEnvelope,
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ purpose: "reclaim" }),
  });
  return {
    id: required(claim?.id, "reclaim claimCode id"),
    purpose: required(claim?.purpose, "reclaim claimCode purpose"),
    claimCode: required(claim?.claimCode, "reclaim claimCode"),
  };
}

async function revokePendingClaimCodes(input, token, machineId) {
  const endpoint = `${apiBase(input)}/machines/${encodeURIComponent(machineId)}/claim-codes`;
  const page = await request(endpoint, {
    parse: parseServiceApiEnvelope,
    headers: { authorization: `Bearer ${token}` },
  });
  const pending = (page?.items ?? []).filter(
    (claimCode) => claimCode?.state === "pending" && claimCode?.id,
  );
  for (const claimCode of pending) {
    await request(`${endpoint}/${encodeURIComponent(claimCode.id)}/revoke`, {
      parse: parseServiceApiEnvelope,
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: "{}",
    });
  }
  return pending.map((claimCode) => claimCode.id);
}

async function openMachineUiClient(handoff) {
  const endpoint = required(handoff?.cdp?.endpoint, "handoff cdp endpoint");
  const target = await discoverMachineUiTarget({
    endpoint,
    expectedTargetId: handoff?.cdp?.targetId,
  });
  if (handoff?.cdp) handoff.cdp.targetId = target.id;
  const client = new CdpClient(
    rewriteWebSocketDebuggerUrl(target.webSocketDebuggerUrl, endpoint),
  );
  await client.connect();
  await enablePageRuntime(client);
  return client;
}

async function waitForText(client, label, predicateSource) {
  const deadline = Date.now() + TIMEOUT_MS;
  let last = null;
  do {
    last = await evaluateExpression(client, predicateSource);
    if (last?.ok === true) return last;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, POLL_MS));
  } while (Date.now() < deadline);
  throw new Error(`${label} did not converge: ${JSON.stringify(last)}`);
}

async function setRoute(client, route) {
  await evaluateExpression(client, `location.hash = ${JSON.stringify(route)}`);
  return waitForRoute(client, route, {
    timeoutMs: TIMEOUT_MS,
    pollMs: POLL_MS,
    forbiddenRoutes: route.startsWith("#/maintenance") ? [] : undefined,
  });
}

async function openCommissioningTask(client) {
  await setRoute(client, "#/catalog");
  for (let count = 0; count < 7; count += 1) {
    await activateVisibleSelector(client, MAINTENANCE_ENTRY_SELECTOR, {
      kind: "mouse",
      timeoutMs: TIMEOUT_MS,
      pollMs: POLL_MS,
    });
  }
  await waitForRoute(client, "#/maintenance?source=operator", {
    timeoutMs: TIMEOUT_MS,
    pollMs: POLL_MS,
    forbiddenRoutes: [],
  });
  await activateVisibleSelector(client, COMMISSIONING_TASK_SELECTOR, {
    kind: "touch",
    timeoutMs: TIMEOUT_MS,
    pollMs: POLL_MS,
  });
  await waitForText(
    client,
    "commissioning reclaim form",
    `(() => {
      const text = document.body?.innerText ?? "";
      return {
        ok: text.includes("网络与认领") && text.includes("重新认领"),
        text: text.slice(0, 500),
      };
    })()`,
  );
}

async function capture(client, outputRoot, name) {
  const path = join(outputRoot, `${name}.png`);
  return await captureScreenshot(client, {
    timeoutMs: TIMEOUT_MS,
    label: name,
    validatePng: true,
    screenshotSink: async ({ bytes }) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes);
      return path;
    },
  });
}

async function submitReclaimCode(client, claimCode) {
  const inputSet = await evaluateExpression(
    client,
    `(() => {
      const input = document.querySelector('input[aria-label="重领码"]');
      if (!input) return { ok: false, reason: "reclaim input missing" };
      input.value = ${JSON.stringify(claimCode)};
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, valueLength: input.value.length };
    })()`,
  );
  if (inputSet?.ok !== true) {
    throw new Error(
      `reclaim input is unavailable: ${JSON.stringify(inputSet)}`,
    );
  }
  await activateVisibleSelector(
    client,
    "[data-test='machine-reclaim-submit']",
    {
      kind: "touch",
      timeoutMs: TIMEOUT_MS,
      pollMs: POLL_MS,
    },
  );
  return await waitForText(
    client,
    "reclaim accepted message",
    `(() => {
      const text = document.body?.innerText ?? "";
      return {
        ok: text.includes("机器认领已接受") && !text.includes("重领中"),
        text: text.slice(0, 800),
      };
    })()`,
  );
}

export function validateMachineClaimWorkflowReport(report) {
  if (
    report?.schemaVersion !== SCHEMA_VERSION ||
    report?.ok !== true ||
    typeof report?.machine?.id !== "string" ||
    report.machine.id === "" ||
    typeof report?.machine?.code !== "string" ||
    report.machine.code === "" ||
    report?.reclaim?.purpose !== "reclaim" ||
    typeof report?.reclaim?.claimCodeId !== "string" ||
    report.reclaim.claimCodeId === "" ||
    report?.submission?.accepted !== true ||
    !Array.isArray(report?.reclaim?.revokedPendingClaimCodeIds) ||
    typeof report?.screenshots?.beforeSubmit?.sha256 !== "string" ||
    typeof report?.screenshots?.afterSubmit?.sha256 !== "string"
  ) {
    throw new Error("machine claim workflow evidence is incomplete");
  }
  return {
    machineCode: report.machine.code,
    claimCodeId: report.reclaim.claimCodeId,
  };
}

export async function runMachineClaimWorkflowGuest(options) {
  const input = readJson(options.guestInputPath);
  const handoff = readJson(options.handoffPath);
  const outPath = localPath(options.outPath);
  const artifactRoot = join(dirname(outPath), "machine-claim-artifacts");
  const token = await adminToken(input);
  const machine = await findMachine(input, token);
  const revokedClaimCodeIds = await revokePendingClaimCodes(
    input,
    token,
    machine.id,
  );
  const reclaim = await generateReclaimCode(input, token, machine.id);
  const client = await openMachineUiClient(handoff);
  try {
    await openCommissioningTask(client);
    const beforeSubmit = await capture(client, artifactRoot, "reclaim-ready");
    const submission = await submitReclaimCode(client, reclaim.claimCode);
    const afterSubmit = await capture(client, artifactRoot, "reclaim-accepted");
    const report = {
      schemaVersion: SCHEMA_VERSION,
      ok: true,
      runId: input.runId,
      machine: { id: machine.id, code: machine.code },
      reclaim: {
        claimCodeId: reclaim.id,
        purpose: reclaim.purpose,
        revokedPendingClaimCodeIds: revokedClaimCodeIds,
      },
      submission: { accepted: true, observedText: submission.text },
      screenshots: { beforeSubmit, afterSubmit },
    };
    validateMachineClaimWorkflowReport(report);
    writeJson(options.outPath, report);
    return report;
  } finally {
    await client.close().catch(() => undefined);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runMachineClaimWorkflowGuest(
    parseMachineClaimWorkflowGuestArgs(process.argv.slice(2)),
  )
    .then((report) => {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error.stack ?? error.message}\n`);
      process.exitCode = 1;
    });
}
