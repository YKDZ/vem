#!/usr/bin/env node

import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { evaluateDocumentationScreenshotFile } from "./documentation-screenshot-quality.ts";

export const MACHINE_DOCUMENTATION_SCREENSHOTS = Object.freeze({
  catalog: {
    id: "machine-catalog",
    expectedTexts: ["唐诗村", "选购"],
  },
  "maintenance-status": {
    id: "machine-maintenance-status",
    expectedTexts: ["运行状态", "返回选购"],
  },
  "maintenance-commissioning": {
    id: "machine-maintenance-commissioning",
    expectedTexts: ["网络与认领", "认领"],
  },
  "maintenance-hardware": {
    id: "machine-maintenance-hardware",
    expectedTexts: ["设备检查", "出货一件"],
  },
  "maintenance-stock": {
    id: "machine-maintenance-stock",
    expectedTexts: ["库存维护", "提交"],
  },
  "maintenance-experience": {
    id: "machine-maintenance-experience",
    expectedTexts: ["声音与视觉", "音量"],
  },
  "maintenance-diagnostics": {
    id: "machine-maintenance-diagnostics",
    expectedTexts: ["诊断工具", "日志"],
  },
});

function requireString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function requireCommit(value) {
  const commit = requireString(value, "commit");
  if (!/^[a-f0-9]{7,40}$/i.test(commit)) {
    throw new Error("commit must be a git commit hash");
  }
  return commit;
}

function scenarioSourceName(entry) {
  return basename(entry?.screenshot?.path ?? `${entry.name}.png`);
}

export function buildMachineDocumentationScreenshotMetadata({
  scenario,
  commit,
  capturedAt,
  manualReviewReason = "机器端截图来自 VM Runtime Console 批次；中文文本由人工对照截图复核。",
}) {
  const definition = MACHINE_DOCUMENTATION_SCREENSHOTS[scenario?.name];
  if (!definition) {
    throw new Error(
      `unsupported machine documentation screenshot: ${scenario?.name}`,
    );
  }
  return {
    id: definition.id,
    source: "machine-runtime",
    route: requireString(scenario.route, "scenario route"),
    capturedAt: requireString(capturedAt, "capturedAt"),
    commit: requireCommit(commit),
    viewport: { width: 1080, height: 1920 },
    expectedOrientation: "portrait",
    expectedTexts: definition.expectedTexts,
    manualReviewReason,
  };
}

export async function importMachineDocumentationScreenshots({
  batchPath,
  sourceRoot = null,
  outputRoot,
  commit,
  capturedAt = new Date().toISOString(),
  scenarios = null,
}) {
  const batchFile = resolve(requireString(batchPath, "batchPath"));
  const batch = JSON.parse(await readFile(batchFile, "utf8"));
  if (batch?.schemaVersion !== "vem-machine-ui-screenshot-batch/v1") {
    throw new Error("machine screenshot batch schema is invalid");
  }
  const selected = scenarios == null ? null : new Set(scenarios);
  const root = resolve(sourceRoot ?? dirname(batchFile));
  const out = resolve(requireString(outputRoot, "outputRoot"));
  await mkdir(out, { recursive: true });

  const imported = [];
  for (const scenario of batch.scenarios ?? []) {
    if (selected && !selected.has(scenario.name)) continue;
    const definition = MACHINE_DOCUMENTATION_SCREENSHOTS[scenario.name];
    if (!definition) continue;
    const sourcePng = resolve(root, scenarioSourceName(scenario));
    const targetPng = resolve(out, `${definition.id}.png`);
    const metadataPath = resolve(out, `${definition.id}.json`);
    const qualityPath = resolve(out, `${definition.id}.quality.json`);
    const metadata = buildMachineDocumentationScreenshotMetadata({
      scenario,
      commit,
      capturedAt,
    });
    await copyFile(sourcePng, targetPng);
    await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
    const quality = await evaluateDocumentationScreenshotFile({
      screenshotPath: targetPng,
      metadataPath,
      outputPath: qualityPath,
    });
    imported.push({
      id: definition.id,
      scenario: scenario.name,
      screenshot: targetPng,
      metadata: metadataPath,
      quality: qualityPath,
      status: quality.status,
    });
  }

  if (selected) {
    const importedNames = new Set(imported.map((entry) => entry.scenario));
    const missing = [...selected].filter((name) => !importedNames.has(name));
    if (missing.length > 0) {
      throw new Error(
        `selected machine screenshots missing from batch: ${missing.join(", ")}`,
      );
    }
  }

  return {
    schemaVersion: "vem-documentation-machine-screenshot-import/v1",
    imported,
  };
}

export function parseMachineScreenshotImportArgs(args) {
  const options = { scenarios: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = () => {
      const value = args[++index];
      if (!value || value.startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
      return value;
    };
    if (arg === "--batch") options.batchPath = next();
    else if (arg === "--source-root") options.sourceRoot = next();
    else if (arg === "--out") options.outputRoot = next();
    else if (arg === "--commit") options.commit = next();
    else if (arg === "--captured-at") options.capturedAt = next();
    else if (arg === "--scenario") options.scenarios.push(next());
    else throw new Error(`unknown argument: ${arg}`);
  }
  requireString(options.batchPath, "--batch");
  requireString(options.outputRoot, "--out");
  requireCommit(options.commit);
  if (options.scenarios.length === 0) options.scenarios = null;
  return options;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const result = await importMachineDocumentationScreenshots(
      parseMachineScreenshotImportArgs(process.argv.slice(2)),
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  }
}
