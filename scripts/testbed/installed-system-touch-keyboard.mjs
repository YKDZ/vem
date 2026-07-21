#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  activateVisibleSelector,
  CdpClient,
  discoverMachineUiTarget,
  enablePageRuntime,
  evaluateExpression,
  rewriteWebSocketDebuggerUrl,
  waitForRoute,
} from "./machine-ui-cdp-driver.mjs";

const MODE = "full";
const WINDOW_QUERY_TIMEOUT_MS = 5_000;
const FIELD_TIMEOUT_MS = 15_000;

function required(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function option(args, name) {
  const index = args.indexOf(`--${name}`);
  const value = index === -1 ? undefined : args[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`--${name} requires a value`);
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

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(localPath(path), "utf8"));
  } catch (error) {
    throw new Error(
      `${label} is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function writeJson(path, value) {
  const target = localPath(path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(value)}\n`);
}

export function parseInstalledSystemTouchKeyboardArgs(args) {
  if (required(option(args, "mode"), "--mode") !== MODE) {
    throw new Error("--mode must be full");
  }
  return {
    mode: MODE,
    guestInputPath: windowsAbsolute(
      option(args, "guest-input"),
      "--guest-input",
    ),
    handoffPath: windowsAbsolute(option(args, "handoff"), "--handoff"),
    outPath: windowsAbsolute(option(args, "out"), "--out"),
  };
}

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

async function waitFor(predicate, label, timeoutMs = WINDOW_QUERY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let last;
  do {
    last = await predicate();
    if (last) return last;
    await sleep(150);
  } while (Date.now() < deadline);
  throw new Error(`${label} timed out after ${timeoutMs}ms`);
}

async function setRoute(client, route) {
  await evaluateExpression(client, `location.hash = ${JSON.stringify(route)}`);
  return waitForRoute(client, route, {
    timeoutMs: FIELD_TIMEOUT_MS,
    pollMs: 150,
    forbiddenRoutes: route.startsWith("#/maintenance") ? [] : undefined,
  });
}

async function focusAndProbeField(client, field, queryWindow) {
  await activateVisibleSelector(client, field.selector, {
    kind: "touch",
    timeoutMs: FIELD_TIMEOUT_MS,
    pollMs: 150,
  });
  const shown = await waitFor(async () => {
    const state = await queryWindow();
    return state.visible === true ? state : null;
  }, `${field.name} did not show the system touch keyboard`);
  await client.send("Input.insertText", { text: field.value });
  const binding = await evaluateExpression(
    client,
    `(() => { const element = document.querySelector(${JSON.stringify(field.selector)}); return { focused: document.activeElement === element, valuePresent: Boolean(element?.value), type: element?.type ?? null }; })()`,
  );
  if (!binding?.focused || !binding.valuePresent) {
    throw new Error(
      `${field.name} did not retain input through its existing form binding`,
    );
  }
  await evaluateExpression(client, "document.activeElement?.blur()");
  const hidden = await waitFor(async () => {
    const state = await queryWindow();
    return state.visible === false ? state : null;
  }, `${field.name} did not hide the system touch keyboard`);
  return {
    field: field.name,
    shown,
    hidden,
    binding: { type: binding.type, valuePresent: binding.valuePresent },
    submitted: false,
  };
}

export async function runInstalledSystemTouchKeyboardAcceptance(
  options,
  dependencies = {},
) {
  const handoff = readJson(options.handoffPath, "installed runtime handoff");
  const guestInput = readJson(options.guestInputPath, "guest input");
  const report = {
    schemaVersion: "vem-installed-system-touch-keyboard/v1",
    ok: false,
    mode: options.mode,
    runId: guestInput.runId ?? null,
    fields: [],
    customerRouteProbe: null,
    error: null,
  };
  let client;
  try {
    const target = await discoverMachineUiTarget({
      endpoint: "http://127.0.0.1:9222",
      expectedTargetId: required(handoff.cdp?.targetId, "handoff cdp targetId"),
    });
    client = new CdpClient(
      rewriteWebSocketDebuggerUrl(
        target.webSocketDebuggerUrl,
        "http://127.0.0.1:9222",
      ),
    );
    await client.connect();
    await enablePageRuntime(client);
    const queryWindow =
      dependencies.queryWindow ??
      (() =>
        evaluateExpression(
          client,
          `window.__TAURI_INTERNALS__.invoke("query_system_touch_keyboard_state")`,
          { timeoutMs: WINDOW_QUERY_TIMEOUT_MS },
        ));
    await setRoute(client, "#/maintenance?source=operator");
    await activateVisibleSelector(
      client,
      ".maintenance-task-nav button:nth-of-type(2)",
      {
        kind: "touch",
        timeoutMs: FIELD_TIMEOUT_MS,
        pollMs: 150,
      },
    );
    for (const field of [
      {
        name: "text",
        selector: 'input[aria-label="网络名称"]',
        value: "VEM-ACCEPTANCE",
      },
      {
        name: "password",
        selector: 'input[aria-label="网络密码"]',
        value: "acceptance-only",
      },
    ]) {
      report.fields.push(await focusAndProbeField(client, field, queryWindow));
    }
    await activateVisibleSelector(
      client,
      ".maintenance-task-nav button:nth-of-type(3)",
      { kind: "touch", timeoutMs: FIELD_TIMEOUT_MS, pollMs: 150 },
    );
    report.fields.push(
      await focusAndProbeField(
        client,
        { name: "number", selector: 'input[type="number"]', value: "1" },
        queryWindow,
      ),
    );
    await setRoute(client, "#/catalog");
    const catalog = await queryWindow();
    await setRoute(client, "#/result/payment_failed");
    const result = await queryWindow();
    if (catalog.visible || result.visible)
      throw new Error("customer route left the system touch keyboard visible");
    report.customerRouteProbe = {
      catalogHidden: true,
      resultHidden: true,
      submitted: false,
    };
    report.ok = true;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (client) {
      await setRoute(client, "#/catalog").catch(() => {});
    }
    await client?.close().catch(() => {});
  }
  writeJson(options.outPath, report);
  if (!report.ok)
    throw new Error(report.error ?? "system touch keyboard acceptance failed");
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runInstalledSystemTouchKeyboardAcceptance(
    parseInstalledSystemTouchKeyboardArgs(process.argv.slice(2)),
  )
    .then((report) => process.stdout.write(`${JSON.stringify(report)}\n`))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
