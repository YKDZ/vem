#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { buildFullWorkflowAggregate } from "./full-workflow-validator.mjs";

function required(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function option(args, name) {
  const index = args.indexOf(`--${name}`);
  if (index === -1) throw new Error(`--${name} is required`);
  return required(args[index + 1], name);
}

function parseArgs(args) {
  const mode = option(args, "mode");
  if (!["fast", "full"].includes(mode)) {
    throw new Error("--mode must be fast or full");
  }
  return {
    mode,
    guestInputPath: option(args, "guest-input"),
    handoffPath: option(args, "handoff"),
    outPath: option(args, "out"),
  };
}

function runTrack(command, label) {
  const result = spawnSync(command[0], command.slice(1), {
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    label,
    command,
    exitCode: result.status ?? 1,
    status: result.status === 0 ? "passed" : "failed",
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function jsonIfPresent(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function buildWorkflowTrackCommands({ mode, guestInputPath, handoffPath, outPath }) {
  const root = dirname(resolve(outPath));
  const fastReportPath = join(root, "fast-route-stress-sale.json");
  const scannerReportPath = join(root, "scanner-payment-code.json");
  const delayedPickupReportPath = join(root, "delayed-pickup-native-audio.json");
  const visionTryOnReportPath = join(root, "vision-try-on-acceptance.json");
  const tracks = [
    {
      key: "fast",
      reportPath: fastReportPath,
      command: [
        process.execPath,
        "scripts/testbed/fast-route-stress-sale.mjs",
        "--mode",
        mode,
        "--guest-input",
        guestInputPath,
        "--handoff",
        handoffPath,
        "--out",
        fastReportPath,
      ],
    },
  ];
  if (mode === "full") {
    tracks.push(
      {
        key: "scanner",
        reportPath: scannerReportPath,
        command: [
          process.execPath,
          "scripts/testbed/scanner-payment-code-guest-full.mjs",
          "--mode",
          "full",
          "--guest-input",
          guestInputPath,
          "--handoff",
          handoffPath,
          "--out",
          scannerReportPath,
        ],
      },
      {
        key: "delayedPickup",
        reportPath: delayedPickupReportPath,
        command: [
          process.execPath,
          "scripts/testbed/delayed-pickup-native-audio-guest-full.mjs",
          "--mode",
          "full",
          "--guest-input",
          guestInputPath,
          "--handoff",
          handoffPath,
          "--out",
          delayedPickupReportPath,
        ],
      },
      {
        key: "visionTryOn",
        reportPath: visionTryOnReportPath,
        command: [
          "pwsh",
          "-NoProfile",
          "-NonInteractive",
          "-File",
          "scripts/testbed/run-full-vision-try-on-track.ps1",
          "-GuestInputPath",
          guestInputPath,
          "-HandoffPath",
          handoffPath,
          "-OutPath",
          visionTryOnReportPath,
        ],
      },
    );
  }
  return {
    fastReportPath,
    scannerReportPath,
    delayedPickupReportPath,
    visionTryOnReportPath,
    tracks,
  };
}

export function runFullWorkflowOrchestrator(options) {
  const plan = buildWorkflowTrackCommands(options);
  const executedTracks = [];
  for (const track of plan.tracks) {
    const result = runTrack(track.command, track.key);
    executedTracks.push({
      key: track.key,
      reportPath: track.reportPath,
      status: result.status,
      exitCode: result.exitCode,
      reportOk: jsonIfPresent(track.reportPath)?.ok ?? null,
      error:
        result.status === "passed"
          ? null
          : (result.stderr || result.stdout).trim().slice(-16 * 1024) || null,
    });
  }
  const aggregate = buildFullWorkflowAggregate({
    mode: options.mode,
    fastReportPath: plan.fastReportPath,
    scannerReportPath: plan.scannerReportPath,
    delayedPickupReportPath: plan.delayedPickupReportPath,
    visionTryOnReportPath: plan.visionTryOnReportPath,
    executedTracks,
  });
  writeJson(options.outPath, aggregate);
  return aggregate;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const aggregate = runFullWorkflowOrchestrator(options);
  process.stdout.write(`${JSON.stringify(aggregate)}\n`);
  if (!aggregate.ok) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
