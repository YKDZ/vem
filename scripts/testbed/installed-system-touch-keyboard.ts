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
  setCdpLocationHash,
  waitForRoute,
} from "./machine-ui-cdp-driver.ts";

const MODE = "full";
const WINDOW_QUERY_TIMEOUT_MS = 5_000;
const FIELD_TIMEOUT_MS = 15_000;

type JsonRecord = Record<string, unknown>;

function recordValue(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function required(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function option(args: string[], name: string): string {
  const index = args.indexOf(`--${name}`);
  const value = index === -1 ? undefined : args[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`--${name} requires a value`);
  return value;
}

function windowsAbsolute(value: unknown, label: string): string {
  const path = required(value, label);
  if (!/^[A-Za-z]:\\/.test(path) || path.includes("\0")) {
    throw new Error(`${label} must be an absolute Windows path`);
  }
  return path;
}

function localPath(path: string): string {
  return process.platform === "win32"
    ? path
    : resolve(
        `/mnt/${path[0].toLowerCase()}/${path.slice(3).replaceAll("\\", "/")}`,
      );
}

function readJson(path: string, label: string): JsonRecord {
  try {
    return JSON.parse(readFileSync(localPath(path), "utf8"));
  } catch (error) {
    throw new Error(
      `${label} is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function writeJson(path: string, value: JsonRecord): void {
  const target = localPath(path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(value)}\n`);
}

export function parseInstalledSystemTouchKeyboardArgs(
  args: string[],
): JsonRecord {
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

function sleep(milliseconds: number): Promise<void> {
  return new Promise<void>((resolveSleep) =>
    setTimeout(resolveSleep, milliseconds),
  );
}

async function waitFor<T>(
  predicate: () => Promise<T | null | undefined>,
  label: string,
  timeoutMs = WINDOW_QUERY_TIMEOUT_MS,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last;
  do {
    last = await predicate();
    if (last) return last;
    await sleep(150);
  } while (Date.now() < deadline);
  throw new Error(`${label} timed out after ${timeoutMs}ms`);
}

async function setRoute(client: unknown, route: string): Promise<unknown> {
  await setCdpLocationHash(
    client as Parameters<typeof setCdpLocationHash>[0],
    route,
  );
  return waitForRoute(client as Parameters<typeof waitForRoute>[0], route, {
    timeoutMs: FIELD_TIMEOUT_MS,
    pollMs: 150,
    forbiddenRoutes: route.startsWith("#/maintenance") ? [] : undefined,
  });
}

async function focusAndProbeField(
  client: unknown,
  field: JsonRecord,
  queryWindow: () => Promise<JsonRecord>,
): Promise<JsonRecord> {
  await activateVisibleSelector(
    client as Parameters<typeof activateVisibleSelector>[0],
    String(field.selector),
    {
      kind: "touch",
      timeoutMs: FIELD_TIMEOUT_MS,
      pollMs: 150,
    },
  );
  const shown = await waitFor<JsonRecord>(async () => {
    const state = await queryWindow();
    return state.visible === true ? state : null;
  }, `${field.name} did not show the system touch keyboard`);
  await (client as CdpClient).send("Input.insertText", {
    text: String(field.value),
  });
  const binding = recordValue(
    await evaluateExpression(
      client as Parameters<typeof evaluateExpression>[0],
      `(() => { const element = document.querySelector(${JSON.stringify(field.selector)}); return { focused: document.activeElement === element, valuePresent: Boolean(element?.value), type: element?.type ?? null }; })()`,
    ),
  );
  if (!binding?.focused || !binding.valuePresent) {
    throw new Error(
      `${field.name} did not retain input through its existing form binding`,
    );
  }
  await evaluateExpression(
    client as Parameters<typeof evaluateExpression>[0],
    "document.activeElement?.blur()",
  );
  const hidden = await waitFor<JsonRecord>(async () => {
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
  options: JsonRecord,
  dependencies: JsonRecord = {},
): Promise<JsonRecord> {
  const handoff = readJson(
    String(options.handoffPath),
    "installed runtime handoff",
  );
  const guestInput = readJson(String(options.guestInputPath), "guest input");
  const report = {
    schemaVersion: "vem-installed-system-touch-keyboard/v1",
    ok: false,
    mode: options.mode,
    runId: guestInput.runId ?? null,
    fields: [] as JsonRecord[],
    customerRouteProbe: null as JsonRecord | null,
    error: null as string | null,
  };
  let client: CdpClient | undefined;
  try {
    const target = await discoverMachineUiTarget({
      endpoint: "http://127.0.0.1:9222",
      expectedTargetId: required(
        recordValue(handoff.cdp).targetId,
        "handoff cdp targetId",
      ),
    });
    client = new CdpClient(
      rewriteWebSocketDebuggerUrl(
        String(target.webSocketDebuggerUrl),
        "http://127.0.0.1:9222",
      ),
    );
    await client.connect();
    await enablePageRuntime(client);
    const cdpClient = client;
    const queryWindow =
      (dependencies.queryWindow as (() => Promise<JsonRecord>) | undefined) ??
      ((async () =>
        recordValue(
          await evaluateExpression(
            cdpClient,
            `window.__TAURI_INTERNALS__.invoke("query_system_touch_keyboard_state")`,
            { timeoutMs: WINDOW_QUERY_TIMEOUT_MS },
          ),
        )) as () => Promise<JsonRecord>);
    await setRoute(cdpClient, "#/maintenance?source=operator");
    await activateVisibleSelector(
      cdpClient,
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
      report.fields.push(
        await focusAndProbeField(cdpClient, field, queryWindow),
      );
    }
    await activateVisibleSelector(
      cdpClient,
      ".maintenance-task-nav button:nth-of-type(3)",
      { kind: "touch", timeoutMs: FIELD_TIMEOUT_MS, pollMs: 150 },
    );
    report.fields.push(
      await focusAndProbeField(
        cdpClient,
        { name: "number", selector: 'input[type="number"]', value: "1" },
        queryWindow,
      ),
    );
    await setRoute(cdpClient, "#/catalog");
    const catalog = recordValue(await queryWindow());
    await setRoute(cdpClient, "#/result/payment_failed");
    const result = recordValue(await queryWindow());
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
      if (client) await setRoute(client, "#/catalog").catch(() => {});
    }
    await client?.close().catch(() => {});
  }
  writeJson(String(options.outPath), report);
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
