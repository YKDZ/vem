#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";

import { validateVmHostAdapterRequest } from "./vm-host-adapter-contract.mjs";

function readOption(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || !process.argv[index + 1])
    throw new Error(`missing ${name}`);
  return process.argv[index + 1];
}

function evidence(role, hash) {
  return {
    role,
    identity: `factory-evidence://sha256/${hash}`,
    digest: `sha256:${hash}`,
  };
}

function fakeReport(request, scenario) {
  const resultByScenario = {
    success: "succeeded",
    failure: "failed",
    timeout: "timed_out",
    cancel: "cancelled",
    "evidence-mismatch": "succeeded",
  };
  const result = resultByScenario[scenario];
  if (!result)
    throw new Error("unsupported deterministic fake adapter scenario");
  const completed = result === "succeeded" ? [request.operation] : [];
  const negotiatedCapabilities =
    result === "succeeded" ? request.requestedCapabilities : [];
  const evidenceEntries =
    request.operation === "capture-display"
      ? [evidence("display-capture", "b".repeat(64))]
      : request.operation === "capture-default-audio"
        ? [evidence("default-audio-capture", "c".repeat(64))]
        : [];
  const deviceMappings = [];
  if (negotiatedCapabilities.includes("serial:lower-controller"))
    deviceMappings.push({
      role: "lower-controller",
      guestDeviceIdentity: "guest-device://fake-lower-controller-001",
    });
  if (negotiatedCapabilities.includes("serial:scanner"))
    deviceMappings.push({
      role: "scanner",
      guestDeviceIdentity: "guest-device://fake-scanner-001",
    });
  return {
    schemaVersion: "vem-vm-host-adapter-report/v1",
    kind: "vm-host-adapter-report",
    adapter: {
      identity: "vm-host-adapter://deterministic-fake@1.0.0",
      version: "1.0.0",
    },
    request: {
      runId: request.runId,
      operation: request.operation,
      operationNonce:
        scenario === "evidence-mismatch"
          ? "op-ffffffffffffffff"
          : request.operationNonce,
      operationReference: request.operationReference,
      lifecycleReference: request.lifecycleReference,
      cancelOperationReference: request.cancelOperationReference,
      targetIdentity: request.target.identity,
      requestedCapabilities: request.requestedCapabilities,
    },
    result,
    negotiatedCapabilities,
    completedOperations: completed,
    observed: {
      vmIdentity: "vm-observed://fake-runtime-testbed-001",
      targetBinding: {
        relation: "host-target-mapping/v1",
        targetIdentity: request.target.identity,
      },
      baseIdentity: request.assets[0].identity,
      overlayIdentity: "vm-overlay://fake-run-001",
    },
    consumedAssets: request.assets,
    guest: {
      maintenanceEndpointIdentity:
        "guest-maintenance://fake-runtime-testbed-001",
      deviceMappings,
      defaultAudioIdentity: "guest-audio://fake-runtime-testbed-001",
    },
    evidence: evidenceEntries,
    timestamps: {
      startedAt: "2026-07-11T00:00:00.000Z",
      completedAt: "2026-07-11T00:00:01.000Z",
    },
    cleanup:
      request.operation === "cleanup" && result === "succeeded"
        ? { status: "completed", overlayDisposition: "removed" }
        : { status: "not-run", overlayDisposition: "active" },
    diagnostics: [
      {
        code:
          result === "succeeded" ? "adapter_completed" : `adapter_${result}`,
      },
    ],
  };
}

const requestPath = readOption("--request");
const reportPath = readOption("--report");
const request = validateVmHostAdapterRequest(
  JSON.parse(readFileSync(requestPath, "utf8")),
);
if (
  process.env.VEM_VM_HOST_ADAPTER_PID_FILE &&
  request.operation !== "cleanup"
) {
  writeFileSync(process.env.VEM_VM_HOST_ADAPTER_PID_FILE, `${process.pid}\n`, {
    mode: 0o600,
  });
}
if (
  process.env.VEM_VM_HOST_ADAPTER_CLEANUP_FILE &&
  request.operation === "cleanup"
) {
  writeFileSync(process.env.VEM_VM_HOST_ADAPTER_CLEANUP_FILE, "cleanup\n", {
    mode: 0o600,
  });
}
const configuredScenario =
  process.env.VEM_VM_HOST_ADAPTER_FAKE_SCENARIO ?? "success";
if (configuredScenario === "hang" && request.operation !== "cleanup") {
  process.on("SIGTERM", () => {
    if (process.env.VEM_VM_HOST_ADAPTER_SIGNAL_FILE) {
      writeFileSync(process.env.VEM_VM_HOST_ADAPTER_SIGNAL_FILE, "SIGTERM\n", {
        mode: 0o600,
      });
    }
    process.exit(0);
  });
  setInterval(() => {}, 1000);
} else {
  const scenario =
    configuredScenario === "hang" ? "success" : configuredScenario;
  writeFileSync(
    reportPath,
    `${JSON.stringify(fakeReport(request, scenario))}\n`,
    { mode: 0o600 },
  );
}
