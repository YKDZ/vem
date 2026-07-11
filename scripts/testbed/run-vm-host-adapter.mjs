#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  createVmHostAdapterRequest,
  runVmHostAdapter,
  VmHostAdapterExecutionError,
} from "./vm-host-adapter-contract.mjs";

const CAPABILITIES_BY_OPERATION = {
  "clean-install": [
    "clean-install",
    "disposable-overlay",
    "serial:lower-controller",
    "serial:scanner",
    "cancellation",
    "cleanup",
  ],
  "restore-approved-base": [
    "approved-base-restore",
    "disposable-overlay",
    "serial:lower-controller",
    "serial:scanner",
    "cancellation",
    "cleanup",
  ],
  "create-disposable-overlay": [
    "disposable-overlay",
    "serial:lower-controller",
    "serial:scanner",
    "cancellation",
    "cleanup",
  ],
  "capture-display": ["display-capture", "cancellation", "cleanup"],
  "capture-default-audio": ["default-audio-capture", "cancellation", "cleanup"],
  cleanup: ["cleanup", "cancellation"],
  cancel: ["cancellation", "cleanup"],
};

function readOption(name, { optional = false } = {}) {
  const index = process.argv.indexOf(name);
  if (index === -1 || !process.argv[index + 1]) {
    if (optional) return null;
    throw new Error(`${name} is required`);
  }
  return process.argv[index + 1];
}

function assetFromIdentity(role, identity) {
  const match = String(identity).match(
    /^factory-cas:\/\/sha256\/([a-f0-9]{64})$/,
  );
  if (!match) throw new Error(`${role} must be a factory-cas SHA-256 identity`);
  return { role, identity, digest: `sha256:${match[1]}` };
}

function assetsForOperation(operation) {
  if (operation === "clean-install") {
    return [
      assetFromIdentity("factory-iso", readOption("--factory-iso")),
      assetFromIdentity(
        "factory-personalization-media",
        readOption("--factory-personalization-media"),
      ),
    ];
  }
  return [
    assetFromIdentity(
      "approved-runtime-base",
      readOption("--approved-runtime-base"),
    ),
  ];
}

async function main() {
  const cancellation = new AbortController();
  const abort = () => cancellation.abort();
  process.on("SIGINT", abort);
  process.on("SIGTERM", abort);
  const operation = readOption("--operation");
  const runId = readOption("--run-id");
  const targetIdentity = readOption("--target-identity");
  const out = readOption("--out");
  const nonce = `op-${randomBytes(16).toString("hex")}`;
  const lifecycleSeed = createHash("sha256")
    .update(`${runId}\n${targetIdentity}`)
    .digest("hex")
    .slice(0, 32);
  const request = createVmHostAdapterRequest({
    schemaVersion: "vem-vm-host-adapter-request/v1",
    kind: "vm-host-adapter-request",
    operation,
    runId,
    operationNonce: nonce,
    operationReference: `vm-operation://${nonce}`,
    lifecycleReference: `vm-lifecycle://${runId.toLowerCase()}.${lifecycleSeed}`,
    cancelOperationReference:
      operation === "cancel"
        ? readOption("--cancel-operation-reference")
        : null,
    target: { identity: targetIdentity },
    assets: assetsForOperation(operation),
    requestedCapabilities: CAPABILITIES_BY_OPERATION[operation] ?? [],
  });
  mkdirSync(dirname(out), { recursive: true });
  try {
    try {
      const report = await runVmHostAdapter({
        request,
        workDirectory: process.env.RUNNER_TEMP ?? ".vm-host-adapter-tmp",
        signal: cancellation.signal,
      });
      writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, {
        mode: 0o600,
      });
    } catch (error) {
      if (error instanceof VmHostAdapterExecutionError) {
        writeFileSync(out, `${JSON.stringify(error.diagnostic, null, 2)}\n`, {
          mode: 0o600,
        });
      }
      throw error;
    }
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}

main().catch((error) => {
  console.error(
    error instanceof Error
      ? error.message
      : "VM Host Adapter invocation failed",
  );
  process.exitCode = 1;
});
