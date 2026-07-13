#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

import {
  validateVmHostAdapterRequest,
  VM_HOST_ADAPTER_CONTRACT_VERSION,
} from "./vm-host-adapter-contract.mjs";

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

function defaultAudioCapture(request, evidenceEntry) {
  if (request.operation !== "capture-default-audio") return null;
  return {
    schemaVersion: "vm-default-audio-capture-result/v1",
    runId: request.runId,
    lifecycleReference: request.lifecycleReference,
    captureOperationReference: request.operationReference,
    activeKioskSession: request.audioCapture.activeKioskSession,
    endpoint: {
      status: "selected",
      identity: "guest-audio://fake-runtime-testbed-001",
    },
    nativeCue: {
      status: "emitted",
      source: "tauri_native_audio",
      command: "play_machine_audio",
      challenge: request.audioCapture.nativeCue.challenge,
      emittedAt: "2026-07-11T00:00:00.500Z",
    },
    capture: {
      artifact: evidenceEntry.identity,
      format: "wav_pcm",
      encoding: "pcm_s16le",
      sampleRateHz: 48_000,
      channels: 2,
      frameCount: 24_000,
      threshold: request.audioCapture.threshold,
      nonSilentFrameCount: 24_000,
      peakAbsoluteSample: 2_048,
      durationMs: 500,
      distinctNonSilentSampleMagnitudes: 4,
      startedAt: "2026-07-11T00:00:00.000Z",
      completedAt: "2026-07-11T00:00:01.000Z",
    },
  };
}

function displayCapture(request, evidenceEntry) {
  if (request.operation !== "capture-display") return null;
  return {
    schemaVersion: "vm-display-capture-result/v1",
    runId: request.runId,
    lifecycleReference: request.lifecycleReference,
    captureOperationReference: request.operationReference,
    activeKioskSession: request.displayCapture.activeKioskSession,
    tauriRoute: request.displayCapture.tauriRoute,
    capture: {
      artifact: evidenceEntry.identity,
      format: "png",
      widthPx: 2,
      heightPx: 2,
      pixelCount: 4,
      nonTransparentPixelCount: 4,
      distinctPixelCount: 4,
    },
  };
}

function materializeDisplayEvidence() {
  const directory = process.env.VEM_VM_HOST_EVIDENCE_EXPORT_DIR;
  if (!directory) throw new Error("missing VEM_VM_HOST_EVIDENCE_EXPORT_DIR");
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const chunk = (type, data) => {
    const bytes = Buffer.alloc(12 + data.length);
    bytes.writeUInt32BE(data.length, 0);
    bytes.write(type, 4);
    data.copy(bytes, 8);
    return bytes;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr.writeUInt8(8, 8);
  ihdr.writeUInt8(6, 9);
  const pixels = Buffer.from([
    0, 255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 0, 255, 255, 255, 255, 255, 255,
  ]);
  const bytes = Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const fileName = `${hash}.png`;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, fileName), bytes, { mode: 0o600 });
  return { ...evidence("display-capture", hash), fileName };
}

function materializeDefaultAudioEvidence() {
  const directory = process.env.VEM_VM_HOST_EVIDENCE_EXPORT_DIR;
  if (!directory) throw new Error("missing VEM_VM_HOST_EVIDENCE_EXPORT_DIR");
  const frameCount = 24_000;
  const bytes = Buffer.alloc(44 + frameCount * 2 * 2);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(2, 22);
  bytes.writeUInt32LE(48_000, 24);
  bytes.writeUInt32LE(192_000, 28);
  bytes.writeUInt16LE(4, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(frameCount * 4, 40);
  for (let frame = 0; frame < frameCount; frame += 1) {
    const sample =
      process.env.VEM_VM_HOST_ADAPTER_FAKE_AUDIO_WAV === "silent"
        ? 0
        : [512, 1024, 1536, 2048][frame % 4];
    bytes.writeInt16LE(sample, 44 + frame * 4);
    bytes.writeInt16LE(-sample, 46 + frame * 4);
  }
  const hash = createHash("sha256").update(bytes).digest("hex");
  const fileName = `${hash}.wav`;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, fileName), bytes, { mode: 0o600 });
  return { ...evidence("default-audio-capture", hash), fileName };
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
      ? [materializeDisplayEvidence()]
      : request.operation === "capture-default-audio"
        ? [materializeDefaultAudioEvidence()]
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
    contractVersion: VM_HOST_ADAPTER_CONTRACT_VERSION,
    schemaVersion: "vem-vm-host-adapter-report/v2",
    kind: "vm-host-adapter-report",
    adapter: {
      identity: "vm-host-adapter://deterministic-fake@1.0.0",
      version: "1.0.0",
      contractVersion: VM_HOST_ADAPTER_CONTRACT_VERSION,
    },
    request: {
      contractVersion: request.contractVersion,
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
      factoryMedia: request.factoryMedia,
      displayCapture: request.displayCapture,
      audioCapture: request.audioCapture,
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
      baseIdentity:
        request.operation === "capture-approved-base"
          ? `factory-cas://sha256/${"f".repeat(64)}`
          : request.assets[0].identity,
      overlayIdentity: "vm-overlay://fake-run-001",
      factoryProvenanceDigest:
        request.operation === "clean-install" ||
        request.operation === "capture-approved-base"
          ? request.factoryMedia.provenanceDigest
          : null,
      firmwareMode: request.factoryMedia?.targetFirmware ?? "bios",
    },
    consumedAssets: request.assets,
    guest: {
      maintenanceEndpointIdentity:
        "guest-maintenance://fake-runtime-testbed-001",
      maintenanceEndpoint: {
        protocol: "ssh",
        host: "10.91.2.10",
        port: 22,
        reachability: "discovered",
      },
      deviceMappings,
      defaultAudioIdentity: "guest-audio://fake-runtime-testbed-001",
    },
    evidence: evidenceEntries,
    timestamps: {
      startedAt: "2026-07-11T00:00:00.000Z",
      completedAt: "2026-07-11T00:00:01.000Z",
    },
    displayCapture:
      result === "succeeded"
        ? displayCapture(request, evidenceEntries[0])
        : null,
    defaultAudioCapture:
      result === "succeeded"
        ? defaultAudioCapture(request, evidenceEntries[0])
        : null,
    cleanup:
      request.operation === "cleanup" ||
      request.operation === "cancel" ||
      result === "failed"
        ? {
            status: "completed",
            overlayDisposition: "removed",
            observed: {
              overlay: "removed",
              runDirectory: "removed",
              personalizationMedia: "removed",
            },
          }
        : {
            status: "not-run",
            overlayDisposition: "active",
            observed: {
              overlay: "present",
              runDirectory: "present",
              personalizationMedia: "not-mounted",
            },
          },
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
if (process.env.VEM_VM_HOST_ADAPTER_OPERATION_LOG) {
  writeFileSync(
    process.env.VEM_VM_HOST_ADAPTER_OPERATION_LOG,
    `${request.operation}\n`,
    { flag: "a", mode: 0o600 },
  );
}
if (
  process.env.VEM_VM_HOST_ADAPTER_PID_FILE &&
  request.operation !== "cleanup" &&
  request.operation !== "cancel"
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
if (
  process.env.VEM_VM_HOST_ADAPTER_CANCEL_FILE &&
  request.operation === "cancel"
) {
  writeFileSync(
    process.env.VEM_VM_HOST_ADAPTER_CANCEL_FILE,
    `${request.cancelOperationReference}\n`,
    { mode: 0o600 },
  );
  const pid = Number.parseInt(
    readFileSync(process.env.VEM_VM_HOST_ADAPTER_PID_FILE, "utf8"),
    10,
  );
  if (!Number.isInteger(pid) || pid < 1)
    throw new Error("cancel request has no in-flight adapter operation");
  process.kill(pid, "SIGTERM");
}
const configuredScenario =
  process.env.VEM_VM_HOST_ADAPTER_FAKE_SCENARIO ?? "success";
const scenarioForOperation =
  process.env.VEM_VM_HOST_ADAPTER_FAIL_OPERATION === request.operation
    ? "failure"
    : configuredScenario;
if (
  scenarioForOperation === "hang" &&
  request.operation !== "cleanup" &&
  request.operation !== "cancel"
) {
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
    request.operation === "cleanup" || request.operation === "cancel"
      ? "success"
      : scenarioForOperation === "hang"
        ? "success"
        : scenarioForOperation;
  writeFileSync(
    reportPath,
    `${JSON.stringify(fakeReport(request, scenario))}\n`,
    { mode: 0o600 },
  );
}
