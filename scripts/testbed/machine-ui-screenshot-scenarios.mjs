#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  captureRuntimeOperationObservation,
  captureScreenshot,
  CdpClient,
  discoverMachineUiTarget,
  enablePageRuntime,
  evaluateExpression,
  inspectWindowsMachineUiRuntime,
  rewriteWebSocketDebuggerUrl,
  validatePngScreenshot,
  waitForRoute,
  openMachineUiCdpSidecar,
} from "./machine-ui-cdp-driver.mjs";

export const MACHINE_UI_SCREENSHOT_SCENARIOS = Object.freeze(
  [
    ["boot", "#/boot"],
    ["catalog", "#/catalog"],
    ["product-detail", "#/products/test-item"],
    ["virtual-try-on", "#/products/test-item/try-on"],
    ["checkout", "#/checkout"],
    ["payment", "#/payment"],
    ["dispensing", "#/dispensing"],
    ["result-success", "#/result/success", true],
    ["result-failure", "#/result/failure", true],
    ["result-refunded", "#/result/refunded", true],
    ["offline", "#/offline"],
    ["maintenance-status", "#/maintenance", false, "status"],
    ["maintenance-commissioning", "#/maintenance", false, "commissioning"],
    ["maintenance-hardware", "#/maintenance", false, "hardware"],
    ["maintenance-stock", "#/maintenance", false, "stock"],
    ["maintenance-experience", "#/maintenance", false, "experience"],
    ["maintenance-diagnostics", "#/maintenance", false, "diagnostics"],
  ].map(([name, route, transactionRequired = false, maintenanceTask = null]) =>
    Object.freeze({ name, route, transactionRequired, maintenanceTask }),
  ),
);

const SCENARIO_BY_NAME = new Map(
  MACHINE_UI_SCREENSHOT_SCENARIOS.map((scenario) => [scenario.name, scenario]),
);

export function selectMachineUiScreenshotScenarios(names = []) {
  if (!Array.isArray(names) || names.length === 0) {
    throw new Error("at least one --scenario is required");
  }
  const selected = [];
  const seen = new Set();
  for (const name of names) {
    if (typeof name !== "string" || !SCENARIO_BY_NAME.has(name)) {
      throw new Error(
        `unknown machine UI screenshot scenario: ${String(name)}`,
      );
    }
    if (!seen.has(name)) {
      selected.push(SCENARIO_BY_NAME.get(name));
      seen.add(name);
    }
  }
  return selected;
}

function transactionIdentity(observation) {
  return observation?.orderCredential ?? null;
}

function screenshotFileName(scenario) {
  return `${scenario.name}.png`;
}

const MAINTENANCE_TASK_LABELS = Object.freeze({
  status: "运行状态",
  commissioning: "网络与认领",
  hardware: "设备检查",
  stock: "库存维护",
  experience: "声音与视觉",
  diagnostics: "诊断工具",
});

async function prepareDirectScenario({ client, scenario, timeoutMs }) {
  const directlyReachable = new Set(["boot", "catalog", "offline"]);
  if (!directlyReachable.has(scenario.name) && !scenario.maintenanceTask) {
    throw new Error(
      `${scenario.name} requires its owning real-runtime business scenario adapter`,
    );
  }
  await evaluateExpression(
    client,
    `location.hash = ${JSON.stringify(scenario.route.slice(1))}`,
    { timeoutMs },
  );
  await waitForRoute(client, scenario.route, { timeoutMs });
  if (scenario.maintenanceTask) {
    const label = MAINTENANCE_TASK_LABELS[scenario.maintenanceTask];
    const selected = await evaluateExpression(
      client,
      `(() => {
        const label = ${JSON.stringify(label)};
        const button = [...document.querySelectorAll('.maintenance-task-nav button')]
          .find((entry) => entry.querySelector('span')?.textContent?.trim() === label);
        if (!button) return false;
        button.click();
        return true;
      })()`,
      { timeoutMs },
    );
    if (selected !== true) {
      throw new Error(
        `maintenance task ${scenario.maintenanceTask} is unavailable`,
      );
    }
  }
  return null;
}

export async function runMachineUiScreenshotBatch(
  options = {},
  dependencies = {},
) {
  const scenarios = selectMachineUiScreenshotScenarios(options.scenarios);
  const outputRoot = resolve(options.outputRoot ?? ".");
  const timeoutMs = options.timeoutMs ?? 5_000;
  const sidecar = await (dependencies.openSidecar ?? openMachineUiCdpSidecar)(
    options.tunnelOptions ?? {},
  );
  let client;
  const captures = [];
  const failures = [];
  try {
    const target = await discoverMachineUiTarget({
      endpoint: sidecar.endpoint,
      expectedTargetId: options.expectedTargetId,
      fetchImpl: dependencies.fetchImpl,
      timeoutMs,
    });
    client = new CdpClient(
      rewriteWebSocketDebuggerUrl(
        target.webSocketDebuggerUrl,
        sidecar.endpoint,
      ),
      {
        webSocketFactory: dependencies.webSocketFactory,
        defaultTimeoutMs: timeoutMs,
      },
    );
    await client.connect({ timeoutMs });
    await enablePageRuntime(client);
    for (const scenario of scenarios) {
      try {
        const prepared = await (
          options.prepareScenario ?? prepareDirectScenario
        )({ client, scenario, timeoutMs });
        const identity = await waitForRoute(client, scenario.route, {
          timeoutMs,
          pollMs: options.routePollMs,
        });
        const observation = await captureRuntimeOperationObservation(client, {
          timeoutMs,
        });
        const transaction = transactionIdentity(observation);
        if (
          scenario.transactionRequired &&
          !transaction &&
          !prepared?.transactionIdentity
        ) {
          throw new Error(`${scenario.name} requires a transaction identity`);
        }
        const expectedTransaction = prepared?.transactionIdentity ?? null;
        if (expectedTransaction && transaction !== expectedTransaction) {
          throw new Error(
            `${scenario.name} transaction identity mismatch: expected ${expectedTransaction}, got ${transaction ?? "none"}`,
          );
        }
        const path = resolve(outputRoot, screenshotFileName(scenario));
        await mkdir(dirname(path), { recursive: true });
        const screenshot = await captureScreenshot(client, {
          timeoutMs,
          label: scenario.name,
          validatePng: true,
          screenshotSink: async ({ bytes }) => {
            validatePngScreenshot(bytes);
            await writeFile(path, bytes);
            return path;
          },
        });
        captures.push({
          name: scenario.name,
          route: identity.route,
          transactionIdentity: transaction ?? expectedTransaction,
          screenshot,
        });
      } catch (error) {
        failures.push({ name: scenario.name, error: error.message });
        if (options.failFast === true) break;
      }
    }
  } finally {
    await client?.close().catch(() => {});
    await sidecar.close().catch(() => {});
  }
  const report = {
    schemaVersion: "vem-machine-ui-screenshot-batch/v1",
    ok: failures.length === 0,
    standalone: true,
    sessionCount: 1,
    scenarios: captures,
    failures,
  };
  await mkdir(outputRoot, { recursive: true });
  await writeFile(
    resolve(outputRoot, "index.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  if (!report.ok)
    throw Object.assign(new Error("standalone Machine UI screenshots failed"), {
      report,
    });
  return report;
}

export function parseScreenshotScenarioArgs(args) {
  const options = { scenarios: [], tunnelOptions: {} };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = () => {
      const value = args[++index];
      if (!value || value.startsWith("--"))
        throw new Error(`${arg} requires a value`);
      return value;
    };
    if (arg === "--scenario") options.scenarios.push(next());
    else if (arg === "--out") options.outputRoot = next();
    else if (arg === "--handoff") options.handoffPath = next();
    else if (arg === "--target-id") options.expectedTargetId = next();
    else if (arg === "--remote") options.tunnelOptions.remote = next();
    else if (arg === "--identity") options.tunnelOptions.identityFile = next();
    else if (arg === "--certificate")
      options.tunnelOptions.certificateFile = next();
    else if (arg === "--ssh-port")
      options.tunnelOptions.sshPort = Number(next());
    else if (arg === "--fail-fast") options.failFast = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  selectMachineUiScreenshotScenarios(options.scenarios);
  if (!options.outputRoot) throw new Error("--out is required");
  return options;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const options = parseScreenshotScenarioArgs(process.argv.slice(2));
    const handoff = options.handoffPath
      ? JSON.parse(await readFile(options.handoffPath, "utf8"))
      : null;
    const runtime = handoff?.machine ?? {};
    const cdp = handoff?.cdp ?? {};
    const inspected = await inspectWindowsMachineUiRuntime(
      options.tunnelOptions,
    );
    const result = await runMachineUiScreenshotBatch({
      ...options,
      expectedTargetId: options.expectedTargetId ?? cdp.targetId,
      tunnelOptions: { ...options.tunnelOptions, endpoint: inspected.endpoint },
      runtimeExecutablePath: runtime.executablePath ?? null,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  }
}
