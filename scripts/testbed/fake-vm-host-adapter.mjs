#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

import {
  createScannerCodeDescriptor,
  deriveSerialDeviceMappingDigest,
  deriveSerialEvidenceCaptureChainDigest,
  deriveSerialFrameCaptureBindingDigest,
  deriveSerialSessionBinding,
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

function defaultAudioCapture(request, evidenceEntry, calibrationEvidence) {
  if (request.operation !== "capture-default-audio") return null;
  return {
    schemaVersion: "vm-default-audio-capture-result/v2",
    runId: request.runId,
    lifecycleReference: request.lifecycleReference,
    captureOperationReference: request.operationReference,
    activeKioskSession: request.audioCapture.activeKioskSession,
    defaultOutput: {
      status: "active",
    },
    daemonCalibration: {
      status: "completed",
      source: "vending_daemon_ipc",
      command: "audio_output_calibration",
      challenge: request.audioCapture.daemonCalibration.challenge,
      responseArtifact: calibrationEvidence.identity,
      responseDigest: calibrationEvidence.digest,
      responseFileName: calibrationEvidence.fileName,
      startedAt: "2026-07-11T00:00:00.250Z",
      completedAt: "2026-07-11T00:00:00.750Z",
    },
    capture: {
      source: "contract-test-generated-wav",
      adapterIdentity: "vm-host-adapter://deterministic-fake@1.0.0",
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
    cdpTargetId: request.displayCapture.cdpTargetId,
    foregroundKiosk: {
      activeKioskSession: request.displayCapture.activeKioskSession,
      tauriRoute: request.displayCapture.tauriRoute,
      cdpTargetId: request.displayCapture.cdpTargetId,
      visible: true,
    },
    cdpProbe: {
      endpoint: "http://127.0.0.1:9222/json",
      targetId: request.displayCapture.cdpTargetId,
      targetUrl: request.displayCapture.tauriRoute,
      appVisible: true,
      appTextLength: 16,
      domNodeCount: 3,
      challengeToken: request.displayCapture.visualChallenge.token,
    },
    visualChallenge: {
      ...request.displayCapture.visualChallenge,
      matchingPixelCount:
        request.displayCapture.visualChallenge.region.width *
        request.displayCapture.visualChallenge.region.height,
    },
    capture: {
      source: "contract-test-generated-png",
      adapterIdentity: "vm-host-adapter://deterministic-fake@1.0.0",
      artifact: evidenceEntry.identity,
      format: "png",
      widthPx: 1080,
      heightPx: 1920,
      pixelCount: 2_073_600,
      nonTransparentPixelCount: 2_073_600,
      nonTransparentPixelRatio: 1,
      distinctPixelCount: displayDistinctPixelCount(
        request.displayCapture.visualChallenge,
      ),
    },
  };
}

function displayDistinctPixelCount(challenge) {
  const [red, green, blue] = challenge.colorRgb;
  const isBackground = red === 16 && green === 24 && blue === 32;
  const isPaletteColor = blue === 128 && (red === 0 || red === 1);
  return isBackground || isPaletteColor ? 513 : 514;
}

function materializeDisplayEvidence(challenge) {
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
  const width = 1080;
  const height = 1920;
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8);
  ihdr.writeUInt8(6, 9);
  const pixels = Buffer.alloc(height * (width * 4 + 1));
  for (let row = 0; row < height; row += 1) {
    const start = row * (width * 4 + 1);
    pixels[start] = 0;
    for (let column = 0; column < width; column += 1)
      pixels.writeUInt32BE(0x101820ff, start + 1 + column * 4);
  }
  for (let index = 0; index < 512; index += 1) {
    const color =
      (((index >> 8) & 0xff) << 24) |
      ((index & 0xff) << 16) |
      (0x80 << 8) |
      0xff;
    pixels.writeUInt32BE(color >>> 0, 1 + index * 4);
  }
  for (
    let row = challenge.region.y;
    row < challenge.region.y + challenge.region.height;
    row += 1
  ) {
    const rowStart = row * (width * 4 + 1);
    for (
      let column = challenge.region.x;
      column < challenge.region.x + challenge.region.width;
      column += 1
    ) {
      const offset = rowStart + 1 + column * 4;
      pixels[offset] = challenge.colorRgb[0];
      pixels[offset + 1] = challenge.colorRgb[1];
      pixels[offset + 2] = challenge.colorRgb[2];
      pixels[offset + 3] = 255;
    }
  }
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

function materializeDaemonCalibrationEvidence(request) {
  const directory = process.env.VEM_VM_HOST_EVIDENCE_EXPORT_DIR;
  if (!directory) throw new Error("missing VEM_VM_HOST_EVIDENCE_EXPORT_DIR");
  const response = {
    testEvidenceToken: "11111111-2222-4333-8444-555555555555",
    testEvidenceExpiresAt: "2026-07-11T00:05:00.000Z",
    observationRevision: `sha256:${"a".repeat(64)}`,
    observationGeneration: 7,
    configRevision: `sha256:${"b".repeat(64)}`,
    configGeneration: 11,
    proposedSettingsDigest: `sha256:${"c".repeat(64)}`,
    challenge: request.audioCapture.daemonCalibration.challenge,
  };
  const bytes = Buffer.from(`${JSON.stringify(response)}\n`, "utf8");
  const hash = createHash("sha256").update(bytes).digest("hex");
  const fileName = `${hash}.json`;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, fileName), bytes, { mode: 0o600 });
  return { ...evidence("daemon-audio-calibration-response", hash), fileName };
}

function readState(path) {
  if (!path || !existsSync(path)) return { sessions: {} };
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeState(path, state) {
  if (!path) return;
  writeFileSync(path, `${JSON.stringify(state)}\n`, { mode: 0o600 });
}

function serialMappings(state) {
  return [
    {
      role: "lower-controller",
      guestDeviceIdentity:
        process.env.VEM_VM_HOST_FAKE_LOWER_CONTROLLER_GUEST_IDENTITY ??
        "guest-device://fake-lower-controller-001",
      guestUsbTopology: {
        alias: "serial-lower-controller",
        targetPort: 0,
        usbBus: 0,
        usbPort: "1",
      },
      simulatorProcessIdentity: "simulator-process://fake-lower-controller-001",
      simulatorSocketIdentity: "simulator-socket://fake-lower-controller-001",
      connectionState: state,
    },
    {
      role: "scanner",
      guestDeviceIdentity:
        process.env.VEM_VM_HOST_FAKE_SCANNER_GUEST_IDENTITY ??
        "guest-device://fake-scanner-001",
      guestUsbTopology: {
        alias: "serial-scanner",
        targetPort: 1,
        usbBus: 0,
        usbPort: "2",
      },
      simulatorProcessIdentity: "simulator-process://fake-scanner-001",
      simulatorSocketIdentity: "simulator-socket://fake-scanner-001",
      connectionState: state,
    },
  ];
}

function serialBinding(request) {
  if (request.operation === "start-serial-session")
    return deriveSerialSessionBinding({
      runId: request.runId,
      lifecycleReference: request.lifecycleReference,
      targetIdentity: request.target.identity,
      startOperationReference: request.operationReference,
    });
  return request.serialSession;
}

function mutateSerialState(request, state) {
  const binding = serialBinding(request);
  if (!binding?.serialSessionId) return null;
  const session = state.sessions[binding.serialSessionId] ?? {
    cleanupAttemptCount: 0,
    active: true,
  };
  if (request.operation === "start-serial-session") {
    session.active = true;
    session.cleanupAttemptCount = 0;
  }
  if (
    ["stop-serial-session", "cleanup", "cancel"].includes(request.operation)
  ) {
    session.active = false;
    session.cleanupAttemptCount += 1;
  }
  state.sessions[binding.serialSessionId] = session;
  return { ...binding, ...session };
}

function capturedFrame(sequence) {
  return {
    source: "guest-serial-session",
    sequence,
    digest: `sha256:${createHash("sha256").update(`serial-frame-${sequence}`).digest("hex")}`,
    byteLength: 16,
  };
}

function semanticRecords(request) {
  const session = request.serialSession;
  const saleCorrelationId = session.saleCorrelationIds[0];
  const saleBinding = session.saleBindings[0];
  let sequence = 0;
  const lower = [
    "handshake",
    "health",
    "dispense-request",
    "dispense-ack",
    "dispense-result",
  ].map((event) => ({
    role: "lower-controller",
    event,
    operationNonce: request.operationNonce,
    sessionBindingToken: session.sessionBindingToken,
    deviceMappingDigest: session.deviceMappingDigest,
    scannerCodeDigest: null,
    scannerCodeByteLength: null,
    scannerCodeSuffix: null,
    saleCorrelationId:
      event.startsWith("dispense-") && session.saleCorrelationIds.length > 0
        ? session.saleCorrelationIds[0]
        : null,
    saleBinding: event.startsWith("dispense-") ? saleBinding : null,
    capturedFrame: capturedFrame((sequence += 1)),
  }));
  const records = [
    ...lower.slice(0, 2),
    {
      role: "scanner",
      event: "scanner-injection",
      operationNonce: session.scannerInjection.operationNonce,
      sessionBindingToken: session.sessionBindingToken,
      deviceMappingDigest: session.deviceMappingDigest,
      scannerCodeDigest: session.scannerInjection.scannerCodeDigest,
      scannerCodeByteLength: session.scannerInjection.scannerCodeByteLength,
      scannerCodeSuffix: session.scannerInjection.scannerCodeSuffix,
      saleCorrelationId,
      saleBinding,
      capturedFrame: capturedFrame((sequence += 1)),
    },
    ...["payment-request", "payment-ack", "payment-result"].map((event) => ({
      role: "payment",
      event,
      operationNonce: request.operationNonce,
      sessionBindingToken: session.sessionBindingToken,
      deviceMappingDigest: session.deviceMappingDigest,
      scannerCodeDigest: null,
      scannerCodeByteLength: null,
      scannerCodeSuffix: null,
      saleCorrelationId,
      saleBinding,
      capturedFrame: capturedFrame((sequence += 1)),
    })),
    ...lower.slice(2),
  ];
  let previousCaptureBindingDigest = null;
  return records.map((record, index) => {
    const captured = {
      ...record,
      capturedFrame: capturedFrame(index + 1),
    };
    captured.captureBindingDigest = deriveSerialFrameCaptureBindingDigest({
      request,
      record: captured,
      previousCaptureBindingDigest,
    });
    previousCaptureBindingDigest = captured.captureBindingDigest;
    return captured;
  });
}

function fakeReport(request, scenario, state, observedSerialFaultCode = null) {
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
  const isV2 = Object.hasOwn(request, "serialSession");
  const binding = isV2 ? serialBinding(request) : null;
  const statefulSession = isV2 ? mutateSerialState(request, state) : null;
  const serialState = ["stop-serial-session", "cleanup", "cancel"].includes(
    request.operation,
  )
    ? "disconnected"
    : "connected";
  const mappings = serialMappings(serialState);
  const mappingDigest = deriveSerialDeviceMappingDigest(mappings);
  const negotiatedCapabilities =
    result === "succeeded" ? request.requestedCapabilities : [];
  const deviceMappings = [];
  if (
    negotiatedCapabilities.includes("serial:lower-controller") ||
    (isV2 && request.serialSession !== null)
  )
    deviceMappings.push({
      role: "lower-controller",
      guestDeviceIdentity: mappings[0].guestDeviceIdentity,
      guestUsbTopology: mappings[0].guestUsbTopology,
    });
  if (
    negotiatedCapabilities.includes("serial:scanner") ||
    (isV2 && request.serialSession !== null)
  )
    deviceMappings.push({
      role: "scanner",
      guestDeviceIdentity: mappings[1].guestDeviceIdentity,
      guestUsbTopology: mappings[1].guestUsbTopology,
    });
  const evidenceEntries =
    request.operation === "capture-display"
      ? [materializeDisplayEvidence(request.displayCapture.visualChallenge)]
      : request.operation === "capture-default-audio"
        ? [
            materializeDefaultAudioEvidence(),
            materializeDaemonCalibrationEvidence(request),
          ]
        : [];
  const serialRequest = request.serialSession;
  const needsSerialReport =
    isV2 &&
    (request.operation === "start-serial-session" || serialRequest !== null) &&
    result === "succeeded";
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
      ...(isV2 ? { serialSession: request.serialSession } : {}),
    },
    result,
    negotiatedCapabilities,
    completedOperations: result === "succeeded" ? [request.operation] : [],
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
        ? defaultAudioCapture(request, evidenceEntries[0], evidenceEntries[1])
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
          result === "succeeded"
            ? (observedSerialFaultCode ?? "adapter_completed")
            : `adapter_${result}`,
      },
    ],
    ...(isV2
      ? {
          serialSession: needsSerialReport
            ? {
                serialSessionId: binding.serialSessionId,
                sessionBindingToken: binding.sessionBindingToken,
                startOperationReference:
                  request.operation === "start-serial-session"
                    ? request.operationReference
                    : serialRequest.startOperationReference,
                deviceMappingDigest: mappingDigest,
                state:
                  request.operation === "stop-serial-session"
                    ? "stopped"
                    : ["cleanup", "cancel"].includes(request.operation)
                      ? "cleaned"
                      : "active",
                deviceMappings: mappings,
                scannerAcknowledgement:
                  request.operation === "inject-scanner-code"
                    ? {
                        scannerCodeDigest:
                          serialRequest.scannerInjection.scannerCodeDigest,
                        scannerCodeByteLength:
                          serialRequest.scannerInjection.scannerCodeByteLength,
                        scannerCodeSuffix:
                          serialRequest.scannerInjection.scannerCodeSuffix,
                        accepted: true,
                      }
                    : null,
                simulatorCleanup: [
                  "stop-serial-session",
                  "cleanup",
                  "cancel",
                ].includes(request.operation)
                  ? {
                      cleanupAttemptCount: statefulSession.cleanupAttemptCount,
                      idempotencyVerified:
                        request.operation === "stop-serial-session" &&
                        serialRequest.idempotencyCheck,
                      survivingProcessCount: 0,
                      survivingSocketCount: 0,
                    }
                  : null,
              }
            : null,
          serialEvidence:
            request.operation === "collect-serial-evidence" &&
            result === "succeeded"
              ? (() => {
                  const records = semanticRecords(request);
                  return {
                    serialSessionId: serialRequest.serialSessionId,
                    sessionBindingToken: serialRequest.sessionBindingToken,
                    deviceMappingDigest: serialRequest.deviceMappingDigest,
                    operationEvidence: serialRequest.operationEvidence,
                    records,
                    captureChainDigest: deriveSerialEvidenceCaptureChainDigest({
                      request,
                      records,
                    }),
                  };
                })()
              : null,
        }
      : {}),
  };
}

const requestPath = readOption("--request");
const reportPath = readOption("--report");
if (process.env.VEM_VM_HOST_ADAPTER_EXPECT_ABSENT_ENV) {
  for (const name of process.env.VEM_VM_HOST_ADAPTER_EXPECT_ABSENT_ENV.split(
    ",",
  )) {
    if (process.env[name])
      throw new Error(`adapter received protected ${name}`);
  }
}
const request = validateVmHostAdapterRequest(
  JSON.parse(readFileSync(requestPath, "utf8")),
);
if (request.operation === "inject-scanner-code") {
  const scannerCodePath = readOption("--scanner-code-file");
  const protectedCode = readFileSync(scannerCodePath, "utf8");
  if (!protectedCode) throw new Error("missing protected scanner input");
  if (
    JSON.stringify(createScannerCodeDescriptor(protectedCode)) !==
    JSON.stringify({
      scannerCodeDigest:
        request.serialSession.scannerInjection.scannerCodeDigest,
      scannerCodeByteLength:
        request.serialSession.scannerInjection.scannerCodeByteLength,
      scannerCodeSuffix:
        request.serialSession.scannerInjection.scannerCodeSuffix,
    })
  )
    throw new Error(
      "protected scanner input does not match request descriptor",
    );
  if (process.env.VEM_VM_HOST_ADAPTER_SCANNER_LEAK_FILE)
    writeFileSync(
      process.env.VEM_VM_HOST_ADAPTER_SCANNER_LEAK_FILE,
      protectedCode,
      { mode: 0o600 },
    );
}
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
let scenarioForOperation =
  process.env.VEM_VM_HOST_ADAPTER_FAIL_OPERATION === request.operation
    ? "failure"
    : configuredScenario;
const serialFault = String(
  process.env.VEM_VM_HOST_SERIAL_CONFORMANCE_FAULT ?? "",
).trim();
const serialFaultOperation =
  serialFault === "scanner-timeout"
    ? "inject-scanner-code"
    : serialFault === "swapped-roles" || serialFault === "missing-device"
      ? "start-serial-session"
      : "collect-serial-evidence";
const observedSerialFaultCode =
  request.operation === serialFaultOperation &&
  new Set([
    "malformed-frame",
    "device-disconnected",
    "scanner-timeout",
    "dispense-failed",
    "swapped-roles",
    "missing-device",
  ]).has(serialFault)
    ? {
        "malformed-frame": "serial_malformed_frame",
        "device-disconnected": "serial_device_disconnected",
        "scanner-timeout": "serial_scanner_timeout",
        "dispense-failed": "serial_dispense_failed",
        "swapped-roles": "serial_swapped_roles",
        "missing-device": "serial_missing_device",
      }[serialFault]
    : null;
if (
  request.operation === serialFaultOperation &&
  observedSerialFaultCode !== null
)
  scenarioForOperation = "success";
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
  if (
    scenarioForOperation === "spawn-descendant" &&
    request.operation !== "cleanup" &&
    request.operation !== "cancel"
  ) {
    const descendant = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      {
        detached: false,
        stdio: "ignore",
      },
    );
    descendant.unref();
    const descendantPidFile =
      process.env.VEM_VM_HOST_ADAPTER_DESCENDANT_PID_FILE;
    if (!descendantPidFile || !Number.isInteger(descendant.pid))
      throw new Error("spawn-descendant requires a descendant PID file");
    writeFileSync(descendantPidFile, `${descendant.pid}\n`, { mode: 0o600 });
  }
  const scenario =
    request.operation === "cleanup" || request.operation === "cancel"
      ? "success"
      : scenarioForOperation === "hang"
        ? "success"
        : scenarioForOperation === "spawn-descendant"
          ? "success"
          : scenarioForOperation;
  const statePath = process.env.VEM_VM_HOST_ADAPTER_STATE_FILE;
  const state = readState(statePath);
  const report = fakeReport(request, scenario, state, observedSerialFaultCode);
  writeState(statePath, state);
  writeFileSync(reportPath, `${JSON.stringify(report)}\n`, { mode: 0o600 });
}
