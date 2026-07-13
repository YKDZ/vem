#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  createVmHostAdapterRequest,
  runVmHostAdapter,
  VmHostAdapterExecutionError,
} from "./vm-host-adapter-contract.mjs";

const CAPABILITIES = {
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
  "capture-display": ["display-capture", "cancellation", "cleanup"],
  "capture-default-audio": ["default-audio-capture", "cancellation", "cleanup"],
  cleanup: ["cleanup", "cancellation"],
};

function readOption(name, { optional = false } = {}) {
  const index = process.argv.indexOf(name);
  if (index === -1 || !process.argv[index + 1]) {
    if (optional) return null;
    throw new Error(`${name} is required`);
  }
  return process.argv[index + 1];
}

function asset(role, identity) {
  const match = String(identity).match(
    /^factory-cas:\/\/sha256\/([a-f0-9]{64})$/,
  );
  if (!match) throw new Error(`${role} must be a factory-cas SHA-256 identity`);
  return { role, identity, digest: `sha256:${match[1]}` };
}

function cleanInstallStatus() {
  const status = String(
    process.env.VEM_VM_HOST_CLEAN_INSTALL_STATUS ?? "blocked-issue15",
  ).trim();
  if (!new Set(["ready", "blocked-issue15"]).has(status))
    throw new Error(
      "VEM_VM_HOST_CLEAN_INSTALL_STATUS must be ready or blocked-issue15",
    );
  return status;
}

function runId() {
  const value = String(process.env.GITHUB_RUN_ID ?? `LOCAL-${Date.now()}`)
    .toUpperCase()
    .replaceAll(/[^A-Z0-9-]/g, "-");
  return `CONFORMANCE-${value}`.slice(0, 63);
}

function requestFor({ operation, run, targetIdentity, assets }) {
  const nonce = `op-${randomBytes(16).toString("hex")}`;
  const lifecycleSeed = createHash("sha256")
    .update(`${run}\n${targetIdentity}`)
    .digest("hex")
    .slice(0, 32);
  return createVmHostAdapterRequest({
    schemaVersion: "vem-vm-host-adapter-request/v1",
    kind: "vm-host-adapter-request",
    operation,
    runId: run,
    operationNonce: nonce,
    operationReference: `vm-operation://${nonce}`,
    lifecycleReference: `vm-lifecycle://${run.toLowerCase()}.${lifecycleSeed}`,
    cancelOperationReference: null,
    target: { identity: targetIdentity },
    factoryMedia: null,
    audioCapture:
      operation === "capture-default-audio"
        ? {
            schemaVersion: "vm-default-audio-capture-request/v1",
            activeKioskSession: { sessionUser: "VEMKiosk", sessionId: 3 },
            nativeCue: {
              source: "tauri_native_audio",
              command: "play_machine_audio",
            },
            threshold: {
              minimumPeakAbsoluteSample: 512,
              minimumNonSilentFrames: 2,
            },
          }
        : null,
    assets,
    requestedCapabilities: CAPABILITIES[operation],
  });
}

function assertActiveRuntimeEvidence(report) {
  if (
    report.guest.maintenanceEndpoint.reachability !== "discovered" &&
    report.guest.maintenanceEndpoint.reachability !== "authenticated"
  )
    throw new Error("adapter did not report a discovered maintenance endpoint");
  const mappings = new Set(
    report.guest.deviceMappings.map((entry) => entry.role),
  );
  if (!mappings.has("lower-controller") || !mappings.has("scanner"))
    throw new Error("adapter did not report both serial device mappings");
  if (report.cleanup.overlayDisposition !== "active")
    throw new Error(
      "adapter did not preserve the active overlay for evidence capture",
    );
}

function assertCaptureEvidence(report, role) {
  if (report.evidence.length !== 1 || report.evidence[0].role !== role)
    throw new Error(`adapter did not produce ${role} evidence`);
}

function assertDefaultAudioEvidence(report) {
  assertCaptureEvidence(report, "default-audio-capture");
  const audio = report.defaultAudioCapture;
  if (
    audio?.runId !== report.request.runId ||
    audio.lifecycleReference !== report.request.lifecycleReference ||
    audio.captureOperationReference !== report.request.operationReference ||
    audio?.endpoint?.status !== "selected" ||
    audio.endpoint.identity !== report.guest.defaultAudioIdentity ||
    audio.nativeCue?.status !== "emitted" ||
    audio.nativeCue.source !== "tauri_native_audio" ||
    audio.nativeCue.command !== "play_machine_audio" ||
    audio.capture?.artifact !== report.evidence[0].identity ||
    audio.capture.nonSilentFrameCount <
      audio.capture.threshold.minimumNonSilentFrames ||
    audio.capture.peakAbsoluteSample <
      audio.capture.threshold.minimumPeakAbsoluteSample
  )
    throw new Error("adapter did not produce semantic default-audio evidence");
}

function assertRemoved(report) {
  if (
    report.cleanup.status !== "completed" ||
    report.cleanup.overlayDisposition !== "removed" ||
    report.cleanup.observed.overlay !== "removed" ||
    report.cleanup.observed.runDirectory !== "removed" ||
    report.cleanup.observed.personalizationMedia !== "removed"
  )
    throw new Error(
      "adapter cleanup did not observe removal of all run-owned resources",
    );
}

function sanitizedFailure(error) {
  if (!(error instanceof VmHostAdapterExecutionError)) throw error;
  if (
    error.diagnostic.cleanup.status !== "completed" ||
    error.diagnostic.cleanup.observed.overlay !== "removed"
  )
    throw new Error("adapter failure recovery did not observe cleanup");
  return error.diagnostic;
}

async function main() {
  const out = readOption("--out");
  const targetIdentity = String(process.env.VEM_VM_HOST_TARGET_ID ?? "").trim();
  const approvedBaseIdentity = String(
    process.env.VEM_VM_HOST_APPROVED_BASE_ID ?? "",
  ).trim();
  const factoryIsoIdentity = String(
    process.env.VEM_VM_HOST_FACTORY_ISO_ID ?? "",
  ).trim();
  const personalizationIdentity = String(
    process.env.VEM_VM_HOST_FACTORY_PERSONALIZATION_MEDIA_ID ?? "",
  ).trim();
  const status = cleanInstallStatus();
  const run = runId();
  const baseAssets = [asset("approved-runtime-base", approvedBaseIdentity)];
  const installAssets = [
    asset("factory-iso", factoryIsoIdentity),
    asset("factory-personalization-media", personalizationIdentity),
  ];
  const workDirectory = join(
    process.env.RUNNER_TEMP ?? ".",
    "vm-host-conformance",
  );
  mkdirSync(dirname(out), { recursive: true, mode: 0o700 });

  const evidence = {
    schema: null,
    cleanInstall: null,
    restore: null,
    display: null,
    audio: null,
    cancellation: null,
    failure: null,
    cleanup: null,
  };
  try {
    if (status === "ready") {
      const cleanInstall = await runVmHostAdapter({
        request: requestFor({
          operation: "clean-install",
          run,
          targetIdentity,
          assets: installAssets,
        }),
        workDirectory,
      });
      assertActiveRuntimeEvidence(cleanInstall);
      evidence.cleanInstall = cleanInstall;
      const cleanCleanup = await runVmHostAdapter({
        request: requestFor({
          operation: "cleanup",
          run,
          targetIdentity,
          assets: baseAssets,
        }),
        workDirectory,
      });
      assertRemoved(cleanCleanup);
    } else {
      evidence.cleanInstall = { status: "blocked-issue15" };
    }

    try {
      await runVmHostAdapter({
        request: requestFor({
          operation: "capture-display",
          run,
          targetIdentity,
          assets: baseAssets,
        }),
        workDirectory,
      });
      throw new Error("adapter accepted capture without a restored overlay");
    } catch (error) {
      evidence.failure = sanitizedFailure(error);
    }

    const controller = new AbortController();
    let operationStarted;
    const operationStartedPromise = new Promise((resolve) => {
      operationStarted = resolve;
    });
    const cancellationRequest = requestFor({
      operation: "restore-approved-base",
      run,
      targetIdentity,
      assets: baseAssets,
    });
    try {
      const cancellationRun = runVmHostAdapter({
        request: cancellationRequest,
        workDirectory,
        signal: controller.signal,
        onOperationStarted(request) {
          if (
            request.operationReference !==
              cancellationRequest.operationReference ||
            request.lifecycleReference !==
              cancellationRequest.lifecycleReference
          )
            throw new Error(
              "adapter did not begin the requested lifecycle operation",
            );
          operationStarted(request);
        },
      });
      await operationStartedPromise;
      controller.abort();
      await cancellationRun;
      throw new Error(
        "adapter completed before cancellation conformance could interrupt it",
      );
    } catch (error) {
      evidence.cancellation = sanitizedFailure(error);
    }

    const restore = await runVmHostAdapter({
      request: requestFor({
        operation: "restore-approved-base",
        run,
        targetIdentity,
        assets: baseAssets,
      }),
      workDirectory,
    });
    assertActiveRuntimeEvidence(restore);
    evidence.schema = restore.schemaVersion;
    evidence.restore = restore;

    const display = await runVmHostAdapter({
      request: requestFor({
        operation: "capture-display",
        run,
        targetIdentity,
        assets: baseAssets,
      }),
      workDirectory,
    });
    assertCaptureEvidence(display, "display-capture");
    evidence.display = display;

    const audio = await runVmHostAdapter({
      request: requestFor({
        operation: "capture-default-audio",
        run,
        targetIdentity,
        assets: baseAssets,
      }),
      workDirectory,
    });
    assertDefaultAudioEvidence(audio);
    evidence.audio = audio;

    const cleanup = await runVmHostAdapter({
      request: requestFor({
        operation: "cleanup",
        run,
        targetIdentity,
        assets: baseAssets,
      }),
      workDirectory,
    });
    assertRemoved(cleanup);
    evidence.cleanup = cleanup;
    if (status !== "ready")
      throw new Error(
        "clean-install conformance is blocked by missing Issue15 base evidence",
      );
  } finally {
    writeFileSync(
      out,
      `${JSON.stringify({ schemaVersion: "vem-vm-host-adapter-conformance/v1", runId: run, evidence }, null, 2)}\n`,
      { mode: 0o600 },
    );
  }
}

main().catch((error) => {
  console.error(
    error instanceof Error
      ? error.message
      : "VM Host Adapter conformance failed",
  );
  process.exitCode = 1;
});
