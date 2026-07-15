import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { once } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createScannerCodeDescriptor,
  createVmHostAdapterRequest,
  deriveSerialDeviceMappingDigest,
  deriveSerialEvidenceCaptureChainDigest,
  deriveSerialFrameCaptureBindingDigest,
  deriveSerialSessionBinding,
  redactScannerCode,
  runVmHostAdapter,
  validateVmHostAdapterReport,
  validateVmHostAdapterRequest,
  VM_HOST_ADAPTER_CONTRACT_VERSION,
  VmHostAdapterExecutionError,
} from "./vm-host-adapter-contract.mjs";
import {
  assertBlockedSaleEvidence,
  deriveSerialOperationReportDigest,
  observedMappingFailureCase,
  validateSerialConformanceReport,
} from "./vm-host-adapter-serial-conformance.mjs";

const HASH = "a".repeat(64);
const PROTECTED_SCANNER_INPUT = "test-scanner-secret";
const FAKE_ADAPTER = new URL("./fake-vm-host-adapter.mjs", import.meta.url)
  .pathname;
const CLIENT = new URL("./run-vm-host-adapter.mjs", import.meta.url).pathname;
const CONFORMANCE = new URL(
  "./vm-host-adapter-conformance.mjs",
  import.meta.url,
).pathname;
const SERIAL_CONFORMANCE = new URL(
  "./vm-host-adapter-serial-conformance.mjs",
  import.meta.url,
).pathname;

process.env.VEM_VM_HOST_ADAPTER_CONTRACT_TEST_ONLY = "1";

function blockedSaleOutput(overrides = {}) {
  const flow = {
    phase: "prepare",
    result: { simulatedHardwareReady: { status: "failed" } },
    daemonIpc: {
      healthz: {
        observed: true,
        hardwareOnline: false,
        scannerOnline: true,
      },
      readyz: {
        observed: true,
        blockingCodes: ["LOWER_CONTROLLER_UNAVAILABLE"],
      },
    },
    hardwareMappingFault: {
      healthzObserved: true,
      readyzObserved: true,
      hardwareOnline: false,
      readinessBlockingCodes: ["LOWER_CONTROLLER_UNAVAILABLE"],
      adapterSession: {
        serialSessionId: "serial-session-001",
        startOperationReference: "vm-operation://start-001",
        deviceMappingDigest: `sha256:${"b".repeat(64)}`,
        faultStartedAt: "2026-07-11T00:00:00.000Z",
      },
    },
    transactionEntry: {
      endpoint: "/v1/intents/create-order",
      attempted: true,
      rejected: true,
      statusCode: 400,
      responseCode: "create_order_blocked",
      readinessBlockingCodes: ["LOWER_CONTROLLER_UNAVAILABLE"],
      responseBlockingCodes: ["LOWER_CONTROLLER_UNAVAILABLE"],
      context: {
        runId: "RUN-12-CONTRACT",
        successfulPrepare: {
          runId: "RUN-12-CONTRACT",
          status: "succeeded",
          phase: "prepare",
        },
        selectedItem: {
          inventoryId: "inventory-001",
          slotId: "slot-001",
          slotCode: "A1",
        },
        planogramVersion: "planogram-001",
        paymentOption: {
          optionKey: "qr_code:alipay",
          method: "qr_code",
          providerCode: "alipay",
          ready: true,
        },
      },
      request: {
        inventoryId: "inventory-001",
        quantity: 1,
        planogramVersion: "planogram-001",
        slotId: "slot-001",
        slotCode: "A1",
        paymentMethod: "qr_code",
        paymentProviderCode: "alipay",
      },
      orderId: null,
      paymentId: null,
      vendingCommandId: null,
    },
    sale: { orderId: null, paymentId: null, vendingCommandId: null },
  };
  return {
    ok: false,
    simulatedHardwareSaleFlow: { ...flow, ...overrides },
  };
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(assertion, message) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (assertion()) return;
    await sleep(20);
  }
  assert.fail(message);
}

function requestFor(operation = "restore-approved-base", overrides = {}) {
  const nonce = "op-0123456789abcdef";
  const capabilities = {
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
    "capture-approved-base": [
      "approved-base-capture",
      "disposable-overlay",
      "cancellation",
      "cleanup",
    ],
    "capture-display": ["display-capture", "cancellation", "cleanup"],
    "capture-default-audio": [
      "default-audio-capture",
      "cancellation",
      "cleanup",
    ],
    "start-serial-session": [
      "serial-session",
      "serial:lower-controller",
      "serial:scanner",
      "cancellation",
      "cleanup",
    ],
    "inject-scanner-code": [
      "serial-session",
      "serial:lower-controller",
      "serial:scanner",
      "serial:scanner-injection",
      "cancellation",
      "cleanup",
    ],
    "collect-serial-evidence": [
      "serial-session",
      "serial:lower-controller",
      "serial:scanner",
      "serial:evidence",
      "cancellation",
      "cleanup",
    ],
    "stop-serial-session": [
      "serial-session",
      "serial:lower-controller",
      "serial:scanner",
      "cleanup",
      "cancellation",
    ],
    cleanup: ["cleanup", "cancellation"],
    cancel: ["cancellation", "cleanup"],
  }[operation];
  return {
    contractVersion: VM_HOST_ADAPTER_CONTRACT_VERSION,
    schemaVersion: "vem-vm-host-adapter-request/v2",
    kind: "vm-host-adapter-request",
    operation,
    runId: "RUN-12-CONTRACT",
    operationNonce: nonce,
    operationReference: `vm-operation://${nonce}`,
    lifecycleReference: "vm-lifecycle://run-12-contract.runtime-testbed",
    cancelOperationReference:
      operation === "cancel" ? "vm-operation://op-fedcba9876543210" : null,
    target: { identity: "vm-target://runtime-testbed" },
    factoryMedia: null,
    displayCapture:
      operation === "capture-display"
        ? {
            activeKioskSession: { sessionUser: "VEMKiosk", sessionId: 3 },
            tauriRoute: "http://tauri.localhost/#/",
            cdpTargetId: "cdp-target-runtime-001",
            visualChallenge: {
              token: "d".repeat(64),
              colorRgb: [23, 141, 209],
              region: { x: 24, y: 24, width: 48, height: 24 },
            },
          }
        : null,
    audioCapture:
      operation === "capture-default-audio"
        ? {
            schemaVersion: "vm-default-audio-capture-request/v1",
            activeKioskSession: { sessionUser: "VEMKiosk", sessionId: 3 },
            nativeCue: {
              source: "tauri_native_audio",
              command: "play_machine_audio",
              challenge: "b".repeat(64),
            },
            threshold: {
              minimumPeakAbsoluteSample: 512,
              minimumNonSilentFrames: 24_000,
              minimumDurationMs: 500,
              minimumDistinctNonSilentSampleMagnitudes: 2,
            },
          }
        : null,
    assets: [
      {
        role: "approved-runtime-base",
        identity: `factory-cas://sha256/${HASH}`,
        digest: `sha256:${HASH}`,
      },
    ],
    requestedCapabilities: capabilities,
    serialSession: null,
    ...overrides,
  };
}

function serialSessionRequest(operation, overrides = {}) {
  const base = requestFor(operation);
  const startOperationReference = base.operationReference;
  const binding = deriveSerialSessionBinding({
    runId: base.runId,
    lifecycleReference: base.lifecycleReference,
    targetIdentity: base.target.identity,
    startOperationReference,
  });
  const mappings = serialDeviceMappings(
    operation === "stop-serial-session" ? "disconnected" : "connected",
  );
  const scannerInjection = {
    operationNonce:
      operation === "inject-scanner-code"
        ? base.operationNonce
        : "op-fedcba9876543210",
    ...createScannerCodeDescriptor(PROTECTED_SCANNER_INPUT),
  };
  return requestFor(operation, {
    schemaVersion: "vem-vm-host-adapter-request/v2",
    serialSession: {
      serialSessionId:
        operation === "start-serial-session" ? null : binding.serialSessionId,
      sessionBindingToken:
        operation === "start-serial-session"
          ? null
          : binding.sessionBindingToken,
      startOperationReference:
        operation === "start-serial-session" ? null : startOperationReference,
      deviceMappingDigest:
        operation === "start-serial-session"
          ? null
          : deriveSerialDeviceMappingDigest(mappings),
      deviceRoles: ["lower-controller", "scanner"],
      scannerInjection: [
        "inject-scanner-code",
        "collect-serial-evidence",
      ].includes(operation)
        ? scannerInjection
        : null,
      saleCorrelationIds: ["sale-correlation://sale-001"],
      saleBindings:
        operation === "start-serial-session"
          ? []
          : [
              {
                saleCorrelationId: "sale-correlation://sale-001",
                orderId: "order-001",
                paymentId: "payment-001",
                vendingCommandId: "vending-command-001",
              },
            ],
      operationEvidence:
        operation === "collect-serial-evidence"
          ? {
              runnerChallenge: `serial-runner-challenge://sha256-${"c".repeat(64)}`,
              startReportDigest: `sha256:${"d".repeat(64)}`,
              injectReportDigest: `sha256:${"e".repeat(64)}`,
            }
          : null,
      idempotencyCheck: false,
    },
    ...overrides,
  });
}

function serialDeviceMappings(connectionState) {
  return [
    {
      role: "lower-controller",
      guestDeviceIdentity: "guest-device://lower-controller-001",
      simulatorProcessIdentity: "simulator-process://lower-controller-001",
      simulatorSocketIdentity: "simulator-socket://lower-controller-001",
      connectionState,
    },
    {
      role: "scanner",
      guestDeviceIdentity: "guest-device://scanner-001",
      simulatorProcessIdentity: "simulator-process://scanner-001",
      simulatorSocketIdentity: "simulator-socket://scanner-001",
      connectionState,
    },
  ];
}

function serialEvidenceRecords(request) {
  const saleCorrelationId = request.serialSession.saleCorrelationIds[0];
  const saleBinding = request.serialSession.saleBindings[0];
  let sequence = 0;
  const capturedFrame = () => ({
    source: "guest-serial-session",
    sequence: (sequence += 1),
    digest: `sha256:${"f".repeat(64)}`,
    byteLength: 16,
  });
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
    sessionBindingToken: request.serialSession.sessionBindingToken,
    deviceMappingDigest: request.serialSession.deviceMappingDigest,
    scannerCodeDigest: null,
    scannerCodeByteLength: null,
    scannerCodeSuffix: null,
    saleCorrelationId: event.startsWith("dispense-")
      ? (request.serialSession.saleCorrelationIds[0] ?? null)
      : null,
    saleBinding: event.startsWith("dispense-") ? saleBinding : null,
    capturedFrame: capturedFrame(),
  }));
  const records = [
    ...lower.slice(0, 2),
    {
      role: "scanner",
      event: "scanner-injection",
      operationNonce: request.serialSession.scannerInjection.operationNonce,
      sessionBindingToken: request.serialSession.sessionBindingToken,
      deviceMappingDigest: request.serialSession.deviceMappingDigest,
      scannerCodeDigest:
        request.serialSession.scannerInjection.scannerCodeDigest,
      scannerCodeByteLength:
        request.serialSession.scannerInjection.scannerCodeByteLength,
      scannerCodeSuffix:
        request.serialSession.scannerInjection.scannerCodeSuffix,
      saleCorrelationId,
      saleBinding,
      capturedFrame: capturedFrame(),
    },
    ...["payment-request", "payment-ack", "payment-result"].map((event) => ({
      role: "payment",
      event,
      operationNonce: request.operationNonce,
      sessionBindingToken: request.serialSession.sessionBindingToken,
      deviceMappingDigest: request.serialSession.deviceMappingDigest,
      scannerCodeDigest: null,
      scannerCodeByteLength: null,
      scannerCodeSuffix: null,
      saleCorrelationId,
      saleBinding,
      capturedFrame: capturedFrame(),
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

function cleanInstallRequest() {
  const isoHash = "d".repeat(64);
  const personalizationHash = "e".repeat(64);
  const provenanceHash = "c".repeat(64);
  return requestFor("clean-install", {
    factoryMedia: {
      assemblyMode: "windows-serviced-iso",
      targetFirmware: "bios",
      manifestIdentity: `sha256:${"f".repeat(64)}`,
      provenanceIdentity: `factory-evidence://sha256/${provenanceHash}`,
      provenanceDigest: `sha256:${provenanceHash}`,
      outputIdentity: `factory-cas://sha256/${isoHash}`,
      outputDigest: `sha256:${isoHash}`,
    },
    assets: [
      {
        role: "factory-iso",
        identity: `factory-cas://sha256/${isoHash}`,
        digest: `sha256:${isoHash}`,
      },
      {
        role: "factory-personalization-media",
        identity: `factory-cas://sha256/${personalizationHash}`,
        digest: `sha256:${personalizationHash}`,
      },
    ],
  });
}

function reportFor(request, overrides = {}) {
  const completed = [request.operation];
  const evidence =
    request.operation === "capture-display"
      ? [
          {
            role: "display-capture",
            identity: `factory-evidence://sha256/${"b".repeat(64)}`,
            digest: `sha256:${"b".repeat(64)}`,
            fileName: `${"b".repeat(64)}.png`,
          },
        ]
      : request.operation === "capture-default-audio"
        ? [
            {
              role: "default-audio-capture",
              identity: `factory-evidence://sha256/${"c".repeat(64)}`,
              digest: `sha256:${"c".repeat(64)}`,
              fileName: `${"c".repeat(64)}.wav`,
            },
          ]
        : [];
  const isV2 = Object.hasOwn(request, "serialSession");
  const isSerialCleanup = ["stop-serial-session", "cleanup", "cancel"].includes(
    request.operation,
  );
  const serialMappings = serialDeviceMappings(
    isSerialCleanup ? "disconnected" : "connected",
  );
  const startBinding = deriveSerialSessionBinding({
    runId: request.runId,
    lifecycleReference: request.lifecycleReference,
    targetIdentity: request.target.identity,
    startOperationReference: request.operationReference,
  });
  const serialBinding =
    request.operation === "start-serial-session"
      ? {
          ...startBinding,
          startOperationReference: request.operationReference,
          deviceMappingDigest: deriveSerialDeviceMappingDigest(serialMappings),
        }
      : request.serialSession;
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
      operationNonce: request.operationNonce,
      operationReference: request.operationReference,
      lifecycleReference: request.lifecycleReference,
      cancelOperationReference: request.cancelOperationReference,
      targetIdentity: request.target.identity,
      factoryMedia: request.factoryMedia,
      displayCapture: request.displayCapture,
      audioCapture: request.audioCapture,
      requestedCapabilities: request.requestedCapabilities,
      maintenanceRelaySession: request.maintenanceRelaySession ?? null,
      ...(isV2 ? { serialSession: request.serialSession } : {}),
    },
    result: "succeeded",
    negotiatedCapabilities: request.requestedCapabilities,
    completedOperations: completed,
    observed: {
      vmIdentity: "vm-observed://runtime-testbed-001",
      targetBinding: {
        relation: "host-target-mapping/v1",
        targetIdentity: request.target.identity,
      },
      baseIdentity: request.assets[0].identity,
      overlayIdentity: "vm-overlay://run-12-contract",
      factoryProvenanceDigest:
        request.operation === "clean-install" ||
        request.operation === "capture-approved-base"
          ? request.factoryMedia.provenanceDigest
          : null,
      firmwareMode: request.factoryMedia?.targetFirmware ?? "bios",
    },
    consumedAssets: request.assets,
    guest: {
      maintenanceEndpointIdentity: "guest-maintenance://runtime-testbed-001",
      maintenanceEndpoint: {
        protocol: "ssh",
        host:
          request.maintenanceRelaySession?.endpointTunnelAddress ??
          "10.91.2.10",
        port: 22,
        reachability: "discovered",
        ...(request.maintenanceRelaySession
          ? {
              relayProof: {
                ...request.maintenanceRelaySession,
                relayPeer: { ...request.maintenanceRelaySession.relayPeer },
                endpointAllowedIp: `${request.maintenanceRelaySession.endpointTunnelAddress}/32`,
                endpointRoute: `${request.maintenanceRelaySession.endpointTunnelAddress}/32`,
                handshakeUnixSeconds: 1_784_160_000,
              },
            }
          : {}),
      },
      deviceMappings:
        request.requestedCapabilities.includes("serial:lower-controller") ||
        (isV2 && request.serialSession !== null)
          ? [
              {
                role: "lower-controller",
                guestDeviceIdentity: "guest-device://lower-controller-001",
              },
              {
                role: "scanner",
                guestDeviceIdentity: "guest-device://scanner-001",
              },
            ]
          : [],
      defaultAudioIdentity: "guest-audio://runtime-testbed-001",
    },
    evidence,
    timestamps: {
      startedAt: "2026-07-11T00:00:00.000Z",
      completedAt: "2026-07-11T00:00:01.000Z",
    },
    displayCapture:
      request.operation === "capture-display"
        ? {
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
              artifact: evidence[0].identity,
              format: "png",
              widthPx: 1080,
              heightPx: 1920,
              pixelCount: 2_073_600,
              nonTransparentPixelCount: 2_073_600,
              nonTransparentPixelRatio: 1,
              distinctPixelCount: 513,
            },
          }
        : null,
    defaultAudioCapture:
      request.operation === "capture-default-audio"
        ? {
            schemaVersion: "vm-default-audio-capture-result/v1",
            runId: request.runId,
            lifecycleReference: request.lifecycleReference,
            captureOperationReference: request.operationReference,
            activeKioskSession: request.audioCapture.activeKioskSession,
            endpoint: {
              status: "selected",
              identity: "guest-audio://runtime-testbed-001",
            },
            nativeCue: {
              status: "emitted",
              source: "tauri_native_audio",
              command: "play_machine_audio",
              challenge: request.audioCapture.nativeCue.challenge,
              emittedAt: "2026-07-11T00:00:00.500Z",
            },
            capture: {
              source: "contract-test-generated-wav",
              adapterIdentity: "vm-host-adapter://deterministic-fake@1.0.0",
              artifact: evidence[0].identity,
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
          }
        : null,
    cleanup:
      request.operation === "cleanup" || request.operation === "cancel"
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
    diagnostics: [{ code: "adapter_completed" }],
    ...(isV2
      ? {
          serialSession:
            request.serialSession === null &&
            request.operation !== "start-serial-session"
              ? null
              : {
                  serialSessionId: serialBinding.serialSessionId,
                  sessionBindingToken: serialBinding.sessionBindingToken,
                  startOperationReference:
                    serialBinding.startOperationReference,
                  deviceMappingDigest: serialBinding.deviceMappingDigest,
                  state:
                    request.operation === "stop-serial-session"
                      ? "stopped"
                      : ["cleanup", "cancel"].includes(request.operation)
                        ? "cleaned"
                        : "active",
                  deviceMappings: serialMappings,
                  scannerAcknowledgement:
                    request.operation === "inject-scanner-code"
                      ? {
                          scannerCodeDigest:
                            request.serialSession.scannerInjection
                              .scannerCodeDigest,
                          scannerCodeByteLength:
                            request.serialSession.scannerInjection
                              .scannerCodeByteLength,
                          scannerCodeSuffix:
                            request.serialSession.scannerInjection
                              .scannerCodeSuffix,
                          accepted: true,
                        }
                      : null,
                  simulatorCleanup: isSerialCleanup
                    ? {
                        cleanupAttemptCount: request.serialSession
                          ?.idempotencyCheck
                          ? 2
                          : 1,
                        idempotencyVerified:
                          request.operation === "stop-serial-session" &&
                          request.serialSession?.idempotencyCheck === true,
                        survivingProcessCount: 0,
                        survivingSocketCount: 0,
                      }
                    : null,
                },
          serialEvidence:
            request.operation === "collect-serial-evidence"
              ? (() => {
                  const records = serialEvidenceRecords(request);
                  return {
                    serialSessionId: request.serialSession.serialSessionId,
                    sessionBindingToken:
                      request.serialSession.sessionBindingToken,
                    deviceMappingDigest:
                      request.serialSession.deviceMappingDigest,
                    operationEvidence: request.serialSession.operationEvidence,
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
    ...overrides,
  };
}

describe("VM Host Adapter contract", () => {
  it("permits lifecycle cleanup to recover a failed clean install from its Factory ISO", () => {
    const request = createVmHostAdapterRequest(
      requestFor("cleanup", {
        assets: [
          {
            role: "factory-iso",
            identity: `factory-cas://sha256/${HASH}`,
            digest: `sha256:${HASH}`,
          },
        ],
      }),
    );
    assert.equal(request.assets[0].role, "factory-iso");
    assert.equal(
      validateVmHostAdapterReport(reportFor(request), request).observed
        .baseIdentity,
      request.assets[0].identity,
    );
  });

  it("accepts a strict logical restore request with operation and lifecycle references", () => {
    const request = createVmHostAdapterRequest(requestFor());
    assert.deepEqual(validateVmHostAdapterRequest(request), request);
    assert.doesNotMatch(
      JSON.stringify(request),
      /\/mnt\/|retired-host:|qcow2|C:\\\\/i,
    );
  });

  it("hard-rejects stale request, report, and adapter contract versions", () => {
    const request = createVmHostAdapterRequest(requestFor());
    const { serialSession: _serialSession, ...requestWithoutSerialSession } =
      request;
    assert.throws(
      () => createVmHostAdapterRequest(requestWithoutSerialSession),
      /serialSession/,
    );
    assert.throws(
      () =>
        createVmHostAdapterRequest({
          ...request,
          contractVersion: "vem-vm-host-adapter-contract/v1",
        }),
      /contractVersion/,
    );
    assert.throws(
      () =>
        validateVmHostAdapterReport(
          reportFor(request, {
            contractVersion: "vem-vm-host-adapter-contract/v1",
            adapter: {
              ...reportFor(request).adapter,
              contractVersion: "vem-vm-host-adapter-contract/v1",
            },
          }),
          request,
        ),
      /contractVersion/,
    );
  });

  it("extends the existing lifecycle with v2 serial-session operations", () => {
    const start = createVmHostAdapterRequest(
      serialSessionRequest("start-serial-session"),
    );
    const started = validateVmHostAdapterReport(reportFor(start), start);
    const sessionId = started.serialSession.serialSessionId;
    assert.match(sessionId, /^serial-session:\/\/sha256-/);

    for (const operation of [
      "inject-scanner-code",
      "collect-serial-evidence",
      "stop-serial-session",
    ]) {
      const request = createVmHostAdapterRequest(
        serialSessionRequest(operation),
      );
      const report = validateVmHostAdapterReport(reportFor(request), request);
      assert.equal(report.request.runId, start.runId);
      assert.equal(report.request.lifecycleReference, start.lifecycleReference);
      assert.equal(report.serialSession.serialSessionId, sessionId);
      if (operation === "inject-scanner-code")
        assert.deepEqual(report.serialSession.scannerAcknowledgement, {
          ...createScannerCodeDescriptor(PROTECTED_SCANNER_INPUT),
          accepted: true,
        });
      if (operation === "collect-serial-evidence")
        assert.equal(report.serialEvidence.records.length, 9);
      if (operation === "stop-serial-session")
        assert.deepEqual(report.serialSession.simulatorCleanup, {
          cleanupAttemptCount: 1,
          idempotencyVerified: false,
          survivingProcessCount: 0,
          survivingSocketCount: 0,
        });
    }
  });

  it("rejects serial-session requests that weaken the v2 session binding", () => {
    assert.throws(
      () => createVmHostAdapterRequest(requestFor("start-serial-session")),
      /must bind serial-session operations/,
    );
    assert.throws(
      () =>
        createVmHostAdapterRequest(
          serialSessionRequest("inject-scanner-code", {
            serialSession: {
              serialSessionId: null,
              sessionBindingToken: null,
              startOperationReference: null,
              deviceMappingDigest: null,
              deviceRoles: ["lower-controller", "scanner"],
              scannerInjection: {
                operationNonce: "op-0123456789abcdef",
                ...createScannerCodeDescriptor(PROTECTED_SCANNER_INPUT),
              },
              saleCorrelationIds: ["sale-correlation://sale-001"],
              idempotencyCheck: false,
            },
          }),
        ),
      /derived from this run lifecycle target/,
    );
    assert.throws(
      () =>
        createVmHostAdapterRequest(
          serialSessionRequest("collect-serial-evidence", {
            requestedCapabilities: ["serial-session", "serial:evidence"],
          }),
        ),
      /serial:lower-controller/,
    );
    assert.throws(
      () =>
        createVmHostAdapterRequest(
          serialSessionRequest("inject-scanner-code", {
            serialSession: {
              ...serialSessionRequest("inject-scanner-code").serialSession,
              deviceRoles: ["scanner", "lower-controller"],
            },
          }),
        ),
      /deviceRoles/,
    );
    assert.throws(
      () =>
        createVmHostAdapterRequest(
          serialSessionRequest("collect-serial-evidence", {
            runId: "OTHER-RUN-12",
          }),
        ),
      /derived from this run lifecycle target/,
    );
    assert.throws(
      () =>
        createVmHostAdapterRequest(
          serialSessionRequest("collect-serial-evidence", {
            serialSession: {
              ...serialSessionRequest("collect-serial-evidence").serialSession,
              saleCorrelationIds: [],
            },
          }),
        ),
      /must bind at least one logical sale correlation identity/,
    );
  });

  it("requires connected mapped simulators, exact scanner acknowledgement, and sanitized serial evidence", () => {
    const inject = createVmHostAdapterRequest(
      serialSessionRequest("inject-scanner-code"),
    );
    assert.throws(
      () =>
        validateVmHostAdapterReport(
          reportFor(inject, {
            serialSession: {
              ...reportFor(inject).serialSession,
              scannerAcknowledgement: {
                ...reportFor(inject).serialSession.scannerAcknowledgement,
                scannerCodeDigest: `sha256:${"0".repeat(64)}`,
              },
            },
          }),
          inject,
        ),
      /must bind protected scanner input/,
    );
    assert.throws(
      () =>
        validateVmHostAdapterReport(
          reportFor(inject, {
            serialSession: {
              ...reportFor(inject).serialSession,
              deviceMappings: [
                {
                  ...reportFor(inject).serialSession.deviceMappings[0],
                  simulatorSocketIdentity: "not-a-logical-identity",
                },
                reportFor(inject).serialSession.deviceMappings[1],
              ],
            },
          }),
          inject,
        ),
      /logical identity/,
    );
    assert.throws(
      () =>
        validateVmHostAdapterReport(
          reportFor(inject, {
            request: {
              ...reportFor(inject).request,
              lifecycleReference: "vm-lifecycle://other-run.runtime-testbed",
            },
          }),
          inject,
        ),
      /lifecycleReference/,
    );

    const collect = createVmHostAdapterRequest(
      serialSessionRequest("collect-serial-evidence"),
    );
    for (const serialEvidence of [
      {
        ...reportFor(collect).serialEvidence,
        records: reportFor(collect).serialEvidence.records.slice(0, 5),
      },
      {
        ...reportFor(collect).serialEvidence,
        records: reportFor(collect).serialEvidence.records.map((record) =>
          record.role === "scanner"
            ? { ...record, operationNonce: "op-ffffffffffffffff" }
            : record,
        ),
      },
      {
        ...reportFor(collect).serialEvidence,
        sessionBindingToken:
          "serial-session-binding://sha256-" + "0".repeat(64),
      },
    ])
      assert.throws(() =>
        validateVmHostAdapterReport(
          reportFor(collect, { serialEvidence }),
          collect,
        ),
      );
  });

  it("requires frame-captured sale evidence to bind the actual order, payment, and vending command", () => {
    const collect = createVmHostAdapterRequest(
      serialSessionRequest("collect-serial-evidence"),
    );
    const report = reportFor(collect);
    for (const records of [
      report.serialEvidence.records.map((record) =>
        record.role === "scanner"
          ? {
              ...record,
              capturedFrame: { ...record.capturedFrame, source: "sidecar" },
            }
          : record,
      ),
      report.serialEvidence.records.map((record) =>
        record.saleBinding === null
          ? record
          : {
              ...record,
              saleBinding: {
                ...record.saleBinding,
                paymentId: "payment-other",
              },
            },
      ),
    ])
      assert.throws(() =>
        validateVmHostAdapterReport(
          reportFor(collect, {
            serialEvidence: { ...report.serialEvidence, records },
          }),
          collect,
        ),
      );
  });

  it("rejects a completed sale relabeled without recapturing its serial frames", () => {
    const collect = createVmHostAdapterRequest(
      serialSessionRequest("collect-serial-evidence"),
    );
    const original = reportFor(collect);
    const retaggedRequest = createVmHostAdapterRequest({
      ...collect,
      serialSession: {
        ...collect.serialSession,
        saleBindings: [
          {
            ...collect.serialSession.saleBindings[0],
            orderId: "order-attacker",
            paymentId: "payment-attacker",
            vendingCommandId: "vending-command-attacker",
          },
        ],
      },
    });
    const retagged = reportFor(retaggedRequest);
    retagged.serialEvidence.records = retagged.serialEvidence.records.map(
      (record, index) => ({
        ...record,
        captureBindingDigest:
          original.serialEvidence.records[index].captureBindingDigest,
      }),
    );

    assert.throws(
      () => validateVmHostAdapterReport(retagged, retaggedRequest),
      /immutably bind the run, sale, and raw serial frame at capture/,
    );
  });

  it("rejects duplicate, non-monotonic, and causally inverted sale frames", () => {
    const collect = createVmHostAdapterRequest(
      serialSessionRequest("collect-serial-evidence"),
    );
    const report = reportFor(collect);
    const records = report.serialEvidence.records;
    const scannerIndex = records.findIndex(
      (record) => record.role === "scanner",
    );
    const paymentRequestIndex = records.findIndex(
      (record) => record.event === "payment-request",
    );
    const dispenseRequestIndex = records.findIndex(
      (record) => record.event === "dispense-request",
    );
    const cases = [
      records.map((record, index) =>
        index === paymentRequestIndex
          ? {
              ...record,
              capturedFrame: {
                ...record.capturedFrame,
                sequence: records[scannerIndex].capturedFrame.sequence,
              },
            }
          : record,
      ),
      records.map((record, index) =>
        index === paymentRequestIndex
          ? {
              ...record,
              capturedFrame: { ...record.capturedFrame, sequence: 1 },
            }
          : record,
      ),
      records.map((record, index) =>
        index === dispenseRequestIndex
          ? { ...record, event: "payment-request", role: "payment" }
          : index === paymentRequestIndex
            ? { ...record, event: "dispense-request", role: "lower-controller" }
            : record,
      ),
    ];
    for (const invalidRecords of cases)
      assert.throws(() =>
        validateVmHostAdapterReport(
          reportFor(collect, {
            serialEvidence: {
              ...report.serialEvidence,
              records: invalidRecords,
            },
          }),
          collect,
        ),
      );
  });

  it("rejects plaintext scanner input persisted outside adapter-work but inside the run scope", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-vm-host-scanner-leak-"));
    const start = await runVmHostAdapter({
      request: createVmHostAdapterRequest(
        serialSessionRequest("start-serial-session"),
      ),
      workDirectory: root,
      environment: { VEM_VM_HOST_ADAPTER: FAKE_ADAPTER },
    });
    const inject = serialSessionRequest("inject-scanner-code");
    inject.serialSession = {
      ...inject.serialSession,
      serialSessionId: start.serialSession.serialSessionId,
      sessionBindingToken: start.serialSession.sessionBindingToken,
      startOperationReference: start.serialSession.startOperationReference,
      deviceMappingDigest: start.serialSession.deviceMappingDigest,
    };
    await assert.rejects(
      () =>
        runVmHostAdapter({
          request: createVmHostAdapterRequest(inject),
          workDirectory: root,
          environment: {
            VEM_VM_HOST_ADAPTER: FAKE_ADAPTER,
            VEM_VM_HOST_ADAPTER_SCANNER_LEAK_FILE: join(root, "sidecar.txt"),
          },
          scannerCode: PROTECTED_SCANNER_INPUT,
        }),
      (error) =>
        error instanceof VmHostAdapterExecutionError &&
        error.diagnostic.diagnostics[0].code === "evidence_invalid",
    );
    assert.equal(existsSync(join(root, "sidecar.txt")), true);
    rmSync(join(root, "sidecar.txt"), { force: true });
  });

  it("requires stopped sessions to prove idempotent simulator cleanup with no survivors", () => {
    const stop = createVmHostAdapterRequest(
      serialSessionRequest("stop-serial-session", {
        serialSession: {
          ...serialSessionRequest("stop-serial-session").serialSession,
          idempotencyCheck: true,
        },
      }),
    );
    for (const simulatorCleanup of [
      {
        cleanupAttemptCount: 1,
        idempotencyVerified: false,
        survivingProcessCount: 0,
        survivingSocketCount: 0,
      },
      {
        cleanupAttemptCount: 2,
        idempotencyVerified: true,
        survivingProcessCount: 1,
        survivingSocketCount: 0,
      },
      {
        cleanupAttemptCount: 2,
        idempotencyVerified: true,
        survivingProcessCount: 0,
        survivingSocketCount: 1,
      },
    ])
      assert.throws(
        () =>
          validateVmHostAdapterReport(
            reportFor(stop, {
              serialSession: {
                ...reportFor(stop).serialSession,
                simulatorCleanup,
              },
            }),
            stop,
          ),
        /repeated stop was idempotent|no simulator resources survive/,
      );
  });

  it("allows a failed serial operation to report no invented session or traffic evidence", () => {
    const request = createVmHostAdapterRequest(
      serialSessionRequest("collect-serial-evidence"),
    );
    const report = validateVmHostAdapterReport(
      reportFor(request, {
        result: "failed",
        negotiatedCapabilities: [],
        completedOperations: [],
        serialSession: null,
        serialEvidence: null,
        cleanup: {
          status: "completed",
          overlayDisposition: "removed",
          observed: {
            overlay: "removed",
            runDirectory: "removed",
            personalizationMedia: "removed",
          },
        },
        diagnostics: [{ code: "adapter_failed" }],
      }),
      request,
    );
    assert.equal(report.result, "failed");
  });

  it("redacts protected scanner input from sanitized diagnostics", () => {
    const diagnostic = redactScannerCode(
      { message: `adapter rejected ${PROTECTED_SCANNER_INPUT}` },
      PROTECTED_SCANNER_INPUT,
    );
    assert.deepEqual(diagnostic, {
      message: "adapter rejected [redacted-scanner-code]",
    });
  });

  it("requires Factory Personalization Media for a logical clean install", () => {
    const request = requestFor("clean-install", {
      requestedCapabilities: ["clean-install", "cancellation", "cleanup"],
    });
    assert.throws(
      () => createVmHostAdapterRequest(request),
      /factory-personalization-media/,
    );
  });

  it("requires an exact Factory firmware target and matching host observation", () => {
    const request = cleanInstallRequest();
    const missingFirmware = structuredClone(request);
    delete missingFirmware.factoryMedia.targetFirmware;
    assert.throws(
      () => createVmHostAdapterRequest(missingFirmware),
      /targetFirmware/,
    );

    const unknownFirmware = structuredClone(request);
    unknownFirmware.factoryMedia.targetFirmware = "auto";
    assert.throws(
      () => createVmHostAdapterRequest(unknownFirmware),
      /targetFirmware/,
    );

    assert.throws(
      () =>
        validateVmHostAdapterReport(
          reportFor(request, {
            observed: {
              ...reportFor(request).observed,
              firmwareMode: "uefi",
            },
          }),
          request,
        ),
      /firmwareMode/,
    );
  });

  it("binds a clean-install observation to its requested Factory ISO, never an approved base fallback", () => {
    const factoryIso = `factory-cas://sha256/${"d".repeat(64)}`;
    const personalization = `factory-cas://sha256/${"e".repeat(64)}`;
    const request = createVmHostAdapterRequest(
      requestFor("clean-install", {
        assets: [
          {
            role: "factory-iso",
            identity: factoryIso,
            digest: `sha256:${"d".repeat(64)}`,
          },
          {
            role: "factory-personalization-media",
            identity: personalization,
            digest: `sha256:${"e".repeat(64)}`,
          },
        ],
        factoryMedia: {
          assemblyMode: "windows-serviced-iso",
          targetFirmware: "bios",
          manifestIdentity: `sha256:${"f".repeat(64)}`,
          provenanceIdentity: `factory-evidence://sha256/${"c".repeat(64)}`,
          provenanceDigest: `sha256:${"c".repeat(64)}`,
          outputIdentity: factoryIso,
          outputDigest: `sha256:${"d".repeat(64)}`,
        },
        requestedCapabilities: [
          "clean-install",
          "disposable-overlay",
          "serial:lower-controller",
          "serial:scanner",
          "cancellation",
          "cleanup",
        ],
      }),
    );
    assert.equal(
      validateVmHostAdapterReport(reportFor(request), request).observed
        .baseIdentity,
      factoryIso,
    );
    assert.throws(() =>
      validateVmHostAdapterReport(
        reportFor(request, {
          observed: {
            ...reportFor(request).observed,
            baseIdentity: `factory-cas://sha256/${HASH}`,
          },
        }),
        request,
      ),
    );
    assert.throws(() =>
      validateVmHostAdapterReport(
        reportFor(request, {
          observed: {
            ...reportFor(request).observed,
            factoryProvenanceDigest: `sha256:${"0".repeat(64)}`,
          },
        }),
        request,
      ),
    );
  });

  it("captures a distinct approved base from the clean Factory ISO lifecycle", () => {
    const factoryIso = `factory-cas://sha256/${"d".repeat(64)}`;
    const request = requestFor("capture-approved-base", {
      factoryMedia: {
        assemblyMode: "windows-serviced-iso",
        targetFirmware: "bios",
        manifestIdentity: `sha256:${"e".repeat(64)}`,
        provenanceIdentity: `factory-evidence://sha256/${"f".repeat(64)}`,
        provenanceDigest: `sha256:${"f".repeat(64)}`,
        outputIdentity: factoryIso,
        outputDigest: `sha256:${"d".repeat(64)}`,
      },
      assets: [
        {
          role: "factory-iso",
          identity: factoryIso,
          digest: `sha256:${"d".repeat(64)}`,
        },
      ],
    });
    const report = reportFor(request);
    report.observed.baseIdentity = `factory-cas://sha256/${"1".repeat(64)}`;
    assert.equal(
      validateVmHostAdapterReport(report, request).observed.baseIdentity,
      `factory-cas://sha256/${"1".repeat(64)}`,
    );
  });

  it("accepts an idempotent approved-base capture with cleanup-completed unavailable endpoint", () => {
    const factoryIso = `factory-cas://sha256/${"d".repeat(64)}`;
    const request = createVmHostAdapterRequest(
      requestFor("capture-approved-base", {
        factoryMedia: {
          assemblyMode: "windows-serviced-iso",
          targetFirmware: "bios",
          manifestIdentity: `sha256:${"e".repeat(64)}`,
          provenanceIdentity: `factory-evidence://sha256/${"f".repeat(64)}`,
          provenanceDigest: `sha256:${"f".repeat(64)}`,
          outputIdentity: factoryIso,
          outputDigest: `sha256:${"d".repeat(64)}`,
        },
        assets: [
          {
            role: "factory-iso",
            identity: factoryIso,
            digest: `sha256:${"d".repeat(64)}`,
          },
        ],
      }),
    );
    const report = reportFor(request, {
      guest: {
        maintenanceEndpointIdentity:
          "guest-maintenance://unreachable-runtime-testbed-001",
        maintenanceEndpoint: {
          protocol: "ssh",
          host: "guest-unreachable.invalid",
          port: 22,
          reachability: "unavailable",
        },
        deviceMappings: [],
        defaultAudioIdentity: "guest-audio://runtime-testbed-001",
      },
      cleanup: {
        status: "completed",
        overlayDisposition: "removed",
        observed: {
          overlay: "removed",
          runDirectory: "removed",
          personalizationMedia: "removed",
        },
      },
    });

    assert.deepEqual(
      validateVmHostAdapterReport(report, request).cleanup,
      report.cleanup,
    );
  });

  it("rejects unavailable approved-base capture endpoints unless cleanup proves removal", () => {
    const factoryIso = `factory-cas://sha256/${"d".repeat(64)}`;
    const request = createVmHostAdapterRequest(
      requestFor("capture-approved-base", {
        factoryMedia: {
          assemblyMode: "windows-serviced-iso",
          targetFirmware: "bios",
          manifestIdentity: `sha256:${"e".repeat(64)}`,
          provenanceIdentity: `factory-evidence://sha256/${"f".repeat(64)}`,
          provenanceDigest: `sha256:${"f".repeat(64)}`,
          outputIdentity: factoryIso,
          outputDigest: `sha256:${"d".repeat(64)}`,
        },
        assets: [
          {
            role: "factory-iso",
            identity: factoryIso,
            digest: `sha256:${"d".repeat(64)}`,
          },
        ],
      }),
    );
    const unavailableGuest = {
      maintenanceEndpointIdentity:
        "guest-maintenance://unreachable-runtime-testbed-001",
      maintenanceEndpoint: {
        protocol: "ssh",
        host: "guest-unreachable.invalid",
        port: 22,
        reachability: "unavailable",
      },
      deviceMappings: [],
      defaultAudioIdentity: "guest-audio://runtime-testbed-001",
    };

    assert.throws(() =>
      validateVmHostAdapterReport(
        reportFor(request, { guest: unavailableGuest }),
        request,
      ),
    );

    for (const [key, value] of [
      ["overlay", "present"],
      ["runDirectory", "present"],
      ["personalizationMedia", "not-mounted"],
    ]) {
      assert.throws(() =>
        validateVmHostAdapterReport(
          reportFor(request, {
            guest: unavailableGuest,
            cleanup: {
              status: "completed",
              overlayDisposition: "removed",
              observed: {
                overlay: "removed",
                runDirectory: "removed",
                personalizationMedia: "removed",
                [key]: value,
              },
            },
          }),
          request,
        ),
      );
    }
  });

  it("requires a distinct canonical operation reference when cancelling", () => {
    const valid = createVmHostAdapterRequest(requestFor("cancel"));
    assert.equal(
      valid.cancelOperationReference,
      "vm-operation://op-fedcba9876543210",
    );
    assert.throws(
      () =>
        createVmHostAdapterRequest(
          requestFor("cancel", {
            cancelOperationReference: valid.operationReference,
          }),
        ),
      /distinct operation/,
    );
    assert.throws(
      () =>
        createVmHostAdapterRequest(
          requestFor("restore-approved-base", {
            cancelOperationReference: valid.operationReference,
          }),
        ),
      /must be null outside cancel/,
    );
  });

  it("binds the observed VM to the exact requested logical target and reconstructs only allowed output", () => {
    const request = createVmHostAdapterRequest(requestFor());
    const report = reportFor(request);
    const validated = validateVmHostAdapterReport(report, request);
    assert.deepEqual(validated, report);
    assert.throws(() =>
      validateVmHostAdapterReport(
        reportFor(request, {
          observed: {
            ...report.observed,
            targetBinding: {
              relation: "host-target-mapping/v1",
              targetIdentity: "vm-target://other",
            },
          },
        }),
        request,
      ),
    );
    assert.throws(() =>
      validateVmHostAdapterReport(
        reportFor(request, {
          observed: { ...report.observed, hostPath: "/host-private/secret" },
        }),
        request,
      ),
    );
  });

  it("accepts a host-discovered endpoint and rejects an unavailable one", () => {
    const request = createVmHostAdapterRequest(requestFor());
    const report = reportFor(request);
    assert.equal(
      validateVmHostAdapterReport(report, request).guest.maintenanceEndpoint
        .host,
      "10.91.2.10",
    );
    assert.throws(() =>
      validateVmHostAdapterReport(
        reportFor(request, {
          guest: {
            ...report.guest,
            maintenanceEndpoint: {
              protocol: "ssh",
              host: "10.91.2.10",
              port: 22,
              reachability: "unavailable",
            },
          },
        }),
        request,
      ),
    );
  });

  it("requires the discovered maintenance endpoint to be a concrete SSH tunnel address", () => {
    const request = createVmHostAdapterRequest(requestFor());
    const report = reportFor(request);

    for (const host of [
      "guest.testbed.internal",
      "0.0.0.0",
      "127.0.0.1",
      "::",
    ]) {
      const invalid = structuredClone(report);
      invalid.guest.maintenanceEndpoint.host = host;
      assert.throws(
        () => validateVmHostAdapterReport(invalid, request),
        /maintenanceEndpoint\.host must be a concrete WireGuard tunnel IP address/,
      );
    }

    const wrongPort = structuredClone(report);
    wrongPort.guest.maintenanceEndpoint.port = 2222;
    assert.throws(
      () => validateVmHostAdapterReport(wrongPort, request),
      /maintenanceEndpoint\.port must be the SSH port 22/,
    );
  });

  it("rejects a fresh handshake from a non-session Relay peer", () => {
    const maintenanceRelaySession = {
      sessionId: "550e8400-e29b-41d4-a716-446655440000",
      relayPeer: {
        publicKey: "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=",
        tunnelAddress: "10.91.0.1",
      },
      sourceTunnelAddress: "10.91.2.10",
      endpointTunnelAddress: "10.91.16.10",
    };
    const request = createVmHostAdapterRequest(
      requestFor("restore-approved-base", { maintenanceRelaySession }),
    );
    const report = reportFor(request);
    report.guest.maintenanceEndpoint.relayProof = {
      ...maintenanceRelaySession,
      relayPeer: {
        ...maintenanceRelaySession.relayPeer,
        publicKey: "AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM=",
      },
      endpointAllowedIp: "10.91.16.10/32",
      endpointRoute: "10.91.16.10/32",
      handshakeUnixSeconds: 1_784_160_000,
    };
    assert.throws(
      () => validateVmHostAdapterReport(report, request),
      /relayProof\.relayPeer does not match maintenance session/,
    );
  });

  it("allows cleanup to attest removal after its guest endpoint is gone", () => {
    const request = createVmHostAdapterRequest(requestFor("cleanup"));
    const report = reportFor(request, {
      guest: {
        maintenanceEndpointIdentity:
          "guest-maintenance://unreachable-runtime-testbed-001",
        maintenanceEndpoint: {
          protocol: "ssh",
          host: "guest-unreachable.invalid",
          port: 22,
          reachability: "unavailable",
        },
        deviceMappings: [],
        defaultAudioIdentity: "guest-audio://runtime-testbed-001",
      },
      cleanup: {
        status: "completed",
        overlayDisposition: "removed",
        observed: {
          overlay: "removed",
          runDirectory: "removed",
          personalizationMedia: "removed",
        },
      },
    });
    assert.equal(
      validateVmHostAdapterReport(report, request).result,
      "succeeded",
    );
  });

  it("binds Factory ISO cancellation evidence to its lifecycle source", () => {
    const cleanInstall = cleanInstallRequest();
    const request = createVmHostAdapterRequest(
      requestFor("cancel", {
        assets: cleanInstall.assets,
      }),
    );
    const report = reportFor(request);
    report.observed.baseIdentity = `factory-cas://sha256/${"b".repeat(64)}`;
    assert.throws(() => validateVmHostAdapterReport(report, request));
  });

  it("rejects ambiguous recovery lifecycle sources", () => {
    const cleanInstall = cleanInstallRequest();
    assert.throws(() =>
      createVmHostAdapterRequest(
        requestFor("cancel", {
          assets: [
            ...cleanInstall.assets,
            {
              role: "approved-runtime-base",
              identity: `factory-cas://sha256/${HASH}`,
              digest: `sha256:${HASH}`,
            },
          ],
          cancelOperationReference: cleanInstall.operationReference,
        }),
      ),
    );
  });

  it("keeps overlay lifecycle active through restore and separates the completed operation from negotiated capabilities", () => {
    const restore = createVmHostAdapterRequest(requestFor());
    const report = reportFor(restore, {
      negotiatedCapabilities: restore.requestedCapabilities,
      completedOperations: ["restore-approved-base"],
    });
    assert.equal(
      validateVmHostAdapterReport(report, restore).cleanup.overlayDisposition,
      "active",
    );
    assert.throws(() =>
      validateVmHostAdapterReport(
        reportFor(restore, {
          cleanup: {
            status: "completed",
            overlayDisposition: "removed",
            observed: {
              overlay: "removed",
              runDirectory: "removed",
              personalizationMedia: "removed",
            },
          },
        }),
        restore,
      ),
    );
    const capture = createVmHostAdapterRequest(requestFor("capture-display"));
    assert.equal(
      validateVmHostAdapterReport(reportFor(capture), capture).evidence[0].role,
      "display-capture",
    );
    assert.throws(() =>
      validateVmHostAdapterReport(
        reportFor(restore, { evidence: reportFor(capture).evidence }),
        restore,
      ),
    );
    const cleanup = createVmHostAdapterRequest(requestFor("cleanup"));
    assert.equal(
      validateVmHostAdapterReport(reportFor(cleanup), cleanup).cleanup
        .overlayDisposition,
      "removed",
    );
  });

  it("requires a digest-bound relative image file name for a display capture", () => {
    const capture = createVmHostAdapterRequest(requestFor("capture-display"));
    assert.equal(
      validateVmHostAdapterReport(reportFor(capture), capture).evidence[0]
        .fileName,
      `${"b".repeat(64)}.png`,
    );
    assert.throws(
      () =>
        validateVmHostAdapterReport(
          reportFor(capture, {
            evidence: [
              {
                ...reportFor(capture).evidence[0],
                fileName: "/runner/evidence/display.png",
              },
            ],
          }),
          capture,
        ),
      /fileName/,
    );
  });

  it("requires a foreground kiosk binding, 1080x1920 framebuffer, and a matching CDP visual challenge", () => {
    const request = createVmHostAdapterRequest(requestFor("capture-display"));
    const report = reportFor(request);
    for (const displayCapture of [
      {
        ...report.displayCapture,
        tauriRoute: "http://tauri.localhost/#/maintenance",
      },
      {
        ...report.displayCapture,
        cdpProbe: { ...report.displayCapture.cdpProbe, appTextLength: 0 },
      },
      {
        ...report.displayCapture,
        foregroundKiosk: {
          ...report.displayCapture.foregroundKiosk,
          visible: false,
        },
      },
      {
        ...report.displayCapture,
        cdpProbe: {
          ...report.displayCapture.cdpProbe,
          targetId: "cdp-target-other-002",
        },
      },
      {
        ...report.displayCapture,
        visualChallenge: {
          ...report.displayCapture.visualChallenge,
          matchingPixelCount: 1,
        },
      },
      {
        ...report.displayCapture,
        capture: {
          ...report.displayCapture.capture,
          widthPx: 1920,
          heightPx: 1080,
        },
      },
      {
        ...report.displayCapture,
        capture: {
          ...report.displayCapture.capture,
          source: "platform-framebuffer",
        },
      },
      {
        ...report.displayCapture,
        capture: {
          ...report.displayCapture.capture,
          nonTransparentPixelCount: 1_000,
          nonTransparentPixelRatio: 1_000 / 2_073_600,
        },
      },
      {
        ...report.displayCapture,
        capture: {
          ...report.displayCapture.capture,
          distinctPixelCount: 255,
        },
      },
    ])
      assert.throws(() =>
        validateVmHostAdapterReport(
          reportFor(request, { displayCapture }),
          request,
        ),
      );
  });

  it("rejects default-audio evidence without an active kiosk binding, selected endpoint, native cue, or synchronized non-silent capture", () => {
    const request = createVmHostAdapterRequest(
      requestFor("capture-default-audio"),
    );
    const report = reportFor(request);
    const cases = [
      {
        defaultAudioCapture: {
          ...report.defaultAudioCapture,
          lifecycleReference: "vm-lifecycle://other-run.runtime",
        },
      },
      {
        defaultAudioCapture: {
          ...report.defaultAudioCapture,
          activeKioskSession: { sessionUser: "VEMKiosk", sessionId: 4 },
        },
      },
      {
        defaultAudioCapture: {
          ...report.defaultAudioCapture,
          endpoint: { status: "missing", identity: null },
        },
      },
      {
        defaultAudioCapture: {
          ...report.defaultAudioCapture,
          nativeCue: {
            ...report.defaultAudioCapture.nativeCue,
            command: "browser_audio_play",
          },
        },
      },
      {
        defaultAudioCapture: {
          ...report.defaultAudioCapture,
          capture: {
            ...report.defaultAudioCapture.capture,
            nonSilentFrameCount: 0,
          },
        },
      },
      {
        defaultAudioCapture: {
          ...report.defaultAudioCapture,
          capture: {
            ...report.defaultAudioCapture.capture,
            source: "",
          },
        },
      },
      {
        defaultAudioCapture: {
          ...report.defaultAudioCapture,
          nativeCue: {
            ...report.defaultAudioCapture.nativeCue,
            emittedAt: "2026-07-11T00:00:02.000Z",
          },
        },
      },
      {
        evidence: [
          {
            ...report.evidence[0],
            fileName: "audio.wav",
          },
        ],
      },
    ];
    for (const override of cases)
      assert.throws(() =>
        validateVmHostAdapterReport(reportFor(request, override), request),
      );
    assert.doesNotThrow(() =>
      validateVmHostAdapterReport(
        reportFor(request, {
          defaultAudioCapture: {
            ...report.defaultAudioCapture,
            capture: {
              ...report.defaultAudioCapture.capture,
              source: "windows-loopback-wav",
            },
          },
        }),
        request,
      ),
    );
  });

  it("treats a silent exported WAV as evidence-invalid and recovers the active lifecycle", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-vm-host-audio-silent-"));
    const cleanupFile = join(root, "cleanup.txt");
    await assert.rejects(
      () =>
        runVmHostAdapter({
          request: createVmHostAdapterRequest(
            requestFor("capture-default-audio"),
          ),
          workDirectory: root,
          environment: {
            VEM_VM_HOST_ADAPTER: FAKE_ADAPTER,
            VEM_VM_HOST_EVIDENCE_EXPORT_DIR: join(root, "evidence"),
            VEM_VM_HOST_ADAPTER_FAKE_AUDIO_WAV: "silent",
            VEM_VM_HOST_ADAPTER_CLEANUP_FILE: cleanupFile,
          },
        }),
      (error) =>
        error instanceof VmHostAdapterExecutionError &&
        error.diagnostic.result === "failed" &&
        error.diagnostic.diagnostics[0].code === "evidence_invalid" &&
        error.diagnostic.cleanup.status === "completed",
    );
    assert.equal(readFileSync(cleanupFile, "utf8"), "cleanup\n");
  });

  it("requires the runner to supply an absolute display evidence export directory", async () => {
    await assert.rejects(
      () =>
        runVmHostAdapter({
          request: createVmHostAdapterRequest(requestFor("capture-display")),
          workDirectory: mkdtempSync(join(tmpdir(), "vem-vm-host-display-")),
          environment: { VEM_VM_HOST_ADAPTER: FAKE_ADAPTER },
        }),
      /VEM_VM_HOST_EVIDENCE_EXPORT_DIR must be an absolute runner-owned directory/,
    );
  });

  it("exports decoded display evidence under its run and operation scope", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-vm-host-display-scope-"));
    const request = createVmHostAdapterRequest(requestFor("capture-display"));
    const report = await runVmHostAdapter({
      request,
      workDirectory: root,
      evidenceDirectory: join(root, "uploaded-evidence"),
      environment: { VEM_VM_HOST_ADAPTER: FAKE_ADAPTER },
    });
    const file = report.evidence[0].fileName;
    assert.equal(
      existsSync(
        join(
          root,
          "uploaded-evidence",
          request.runId,
          request.operationNonce,
          file,
        ),
      ),
      true,
    );
    assert.deepEqual(report.displayCapture.activeKioskSession, {
      sessionUser: "VEMKiosk",
      sessionId: 3,
    });
    assert.equal(report.displayCapture.tauriRoute, "http://tauri.localhost/#/");
  });

  it("accepts a successful operation only when every requested capability is negotiated", () => {
    const request = createVmHostAdapterRequest(requestFor());
    assert.throws(
      () =>
        validateVmHostAdapterReport(
          reportFor(request, {
            negotiatedCapabilities: [
              "approved-base-restore",
              "disposable-overlay",
              "cancellation",
              "cleanup",
            ],
          }),
          request,
        ),
      /complete requested capability set/,
    );
  });

  it("requires every requested role-addressed device mapping before accepting a successful operation", () => {
    const request = createVmHostAdapterRequest(requestFor());
    assert.throws(
      () =>
        validateVmHostAdapterReport(
          reportFor(request, {
            negotiatedCapabilities: [
              "approved-base-restore",
              "disposable-overlay",
              "serial:lower-controller",
              "cancellation",
              "cleanup",
            ],
            guest: {
              ...reportFor(request).guest,
              deviceMappings: [
                {
                  role: "lower-controller",
                  guestDeviceIdentity: "guest-device://lower-controller-001",
                },
              ],
            },
          }),
          request,
        ),
      /must include scanner/,
    );
  });

  it("rejects duplicate serial and evidence roles, extra consumed asset fields, loose timestamps, and non-canonical evidence identity", () => {
    const request = createVmHostAdapterRequest(requestFor("capture-display"));
    const report = reportFor(request);
    const cases = [
      { ...report, secret: "leak" },
      reportFor(request, {
        consumedAssets: [{ ...request.assets[0], secret: "leak" }],
      }),
      reportFor(request, {
        guest: {
          ...report.guest,
          deviceMappings: [
            {
              role: "lower-controller",
              guestDeviceIdentity: "guest-device://one",
            },
            {
              role: "lower-controller",
              guestDeviceIdentity: "guest-device://two",
            },
          ],
        },
      }),
      reportFor(request, {
        evidence: [report.evidence[0], { ...report.evidence[0] }],
      }),
      reportFor(request, {
        evidence: [{ ...report.evidence[0], secret: "leak" }],
      }),
      reportFor(request, {
        evidence: [{ ...report.evidence[0], identity: "vm-evidence://frame" }],
      }),
      reportFor(request, {
        timestamps: {
          startedAt: "2026-07-11T00:00:00Z",
          completedAt: "2026-07-11T00:00:01Z",
        },
      }),
    ];
    for (const candidate of cases)
      assert.throws(() => validateVmHostAdapterReport(candidate, request));
    assert.throws(() =>
      createVmHostAdapterRequest({
        ...request,
        hostPath: "/host-private/base",
      }),
    );
  });

  it("runs only the runner-service adapter and accepts a deterministic restore with an active overlay", async () => {
    const request = createVmHostAdapterRequest(requestFor());
    const report = await runVmHostAdapter({
      request,
      workDirectory: mkdtempSync(join(tmpdir(), "vem-vm-host-client-")),
      environment: {
        VEM_VM_HOST_ADAPTER: FAKE_ADAPTER,
        VEM_VM_HOST_ADAPTER_FAKE_SCENARIO: "success",
      },
    });
    assert.equal(report.result, "succeeded");
    assert.equal(report.cleanup.overlayDisposition, "active");
  });

  it("runs a v2 serial session through the existing adapter runner lifecycle", async () => {
    const workDirectory = mkdtempSync(join(tmpdir(), "vem-vm-host-serial-"));
    const environment = {
      VEM_VM_HOST_ADAPTER: FAKE_ADAPTER,
      VEM_VM_HOST_ADAPTER_FAKE_SCENARIO: "success",
      VEM_VM_HOST_ADAPTER_STATE_FILE: join(workDirectory, "state.json"),
    };
    const start = await runVmHostAdapter({
      request: createVmHostAdapterRequest(
        serialSessionRequest("start-serial-session"),
      ),
      workDirectory,
      environment,
    });
    let stopAttempts = 0;
    for (const operation of [
      "inject-scanner-code",
      "collect-serial-evidence",
      "stop-serial-session",
      "stop-serial-session",
    ]) {
      const retryStop =
        operation === "stop-serial-session" && stopAttempts++ > 0;
      const input = serialSessionRequest(operation);
      const report = await runVmHostAdapter({
        request: createVmHostAdapterRequest({
          ...input,
          serialSession: {
            ...input.serialSession,
            serialSessionId: start.serialSession.serialSessionId,
            sessionBindingToken: start.serialSession.sessionBindingToken,
            startOperationReference:
              start.serialSession.startOperationReference,
            deviceMappingDigest: start.serialSession.deviceMappingDigest,
            idempotencyCheck: retryStop,
          },
        }),
        workDirectory,
        environment,
        ...(operation === "inject-scanner-code"
          ? { scannerCode: PROTECTED_SCANNER_INPUT }
          : {}),
      });
      assert.equal(
        report.serialSession.serialSessionId,
        start.serialSession.serialSessionId,
      );
      if (retryStop)
        assert.equal(
          report.serialSession.simulatorCleanup.idempotencyVerified,
          true,
        );
    }
  });

  it("reports an expected serial device fault without cleaning the active overlay", async () => {
    const workDirectory = mkdtempSync(
      join(tmpdir(), "vem-vm-host-serial-device-fault-"),
    );
    const statePath = join(workDirectory, "state.json");
    const environment = {
      VEM_VM_HOST_ADAPTER: FAKE_ADAPTER,
      VEM_VM_HOST_ADAPTER_FAKE_SCENARIO: "success",
      VEM_VM_HOST_ADAPTER_STATE_FILE: statePath,
    };
    const start = await runVmHostAdapter({
      request: createVmHostAdapterRequest(
        serialSessionRequest("start-serial-session"),
      ),
      workDirectory,
      environment,
    });
    const input = serialSessionRequest("inject-scanner-code");
    const report = await runVmHostAdapter({
      request: createVmHostAdapterRequest({
        ...input,
        serialSession: {
          ...input.serialSession,
          serialSessionId: start.serialSession.serialSessionId,
          sessionBindingToken: start.serialSession.sessionBindingToken,
          startOperationReference: start.serialSession.startOperationReference,
          deviceMappingDigest: start.serialSession.deviceMappingDigest,
        },
      }),
      workDirectory,
      environment: {
        ...environment,
        VEM_VM_HOST_SERIAL_CONFORMANCE_FAULT: "scanner-timeout",
      },
      scannerCode: PROTECTED_SCANNER_INPUT,
    });
    assert.equal(report.result, "succeeded");
    assert.deepEqual(report.diagnostics, [{ code: "serial_scanner_timeout" }]);
    assert.deepEqual(report.cleanup, {
      status: "not-run",
      overlayDisposition: "active",
      observed: {
        overlay: "present",
        runDirectory: "present",
        personalizationMedia: "not-mounted",
      },
    });
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(
      state.sessions[start.serialSession.serialSessionId].active,
      true,
    );
    assert.equal(
      state.sessions[start.serialSession.serialSessionId].cleanupAttemptCount,
      0,
    );
  });

  it("retains known serial session binding during failed-operation recovery cleanup", async () => {
    const workDirectory = mkdtempSync(
      join(tmpdir(), "vem-vm-host-serial-recovery-"),
    );
    const statePath = join(workDirectory, "state.json");
    const environment = {
      VEM_VM_HOST_ADAPTER: FAKE_ADAPTER,
      VEM_VM_HOST_ADAPTER_FAKE_SCENARIO: "failure",
      VEM_VM_HOST_ADAPTER_STATE_FILE: statePath,
    };
    const start = await runVmHostAdapter({
      request: createVmHostAdapterRequest(
        serialSessionRequest("start-serial-session"),
      ),
      workDirectory,
      environment: {
        ...environment,
        VEM_VM_HOST_ADAPTER_FAKE_SCENARIO: "success",
      },
    });
    const input = serialSessionRequest("inject-scanner-code");
    await assert.rejects(
      () =>
        runVmHostAdapter({
          request: createVmHostAdapterRequest({
            ...input,
            serialSession: {
              ...input.serialSession,
              serialSessionId: start.serialSession.serialSessionId,
              sessionBindingToken: start.serialSession.sessionBindingToken,
              startOperationReference:
                start.serialSession.startOperationReference,
              deviceMappingDigest: start.serialSession.deviceMappingDigest,
            },
          }),
          workDirectory,
          environment,
          scannerCode: PROTECTED_SCANNER_INPUT,
        }),
      VmHostAdapterExecutionError,
    );
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(
      state.sessions[start.serialSession.serialSessionId].cleanupAttemptCount,
      1,
    );
  });

  it("derives a cleanable serial binding when start fails before a mapping receipt", async () => {
    const workDirectory = mkdtempSync(
      join(tmpdir(), "vem-vm-host-start-recovery-"),
    );
    const statePath = join(workDirectory, "state.json");
    const request = createVmHostAdapterRequest(
      serialSessionRequest("start-serial-session"),
    );
    const expected = deriveSerialSessionBinding({
      runId: request.runId,
      lifecycleReference: request.lifecycleReference,
      targetIdentity: request.target.identity,
      startOperationReference: request.operationReference,
    });
    await assert.rejects(
      () =>
        runVmHostAdapter({
          request,
          workDirectory,
          environment: {
            VEM_VM_HOST_ADAPTER: FAKE_ADAPTER,
            VEM_VM_HOST_ADAPTER_FAKE_SCENARIO: "failure",
            VEM_VM_HOST_ADAPTER_STATE_FILE: statePath,
          },
        }),
      VmHostAdapterExecutionError,
    );
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(state.sessions[expected.serialSessionId].active, false);
    assert.equal(
      state.sessions[expected.serialSessionId].cleanupAttemptCount,
      1,
    );
  });

  it("retains the serial binding when a start times out before a mapping receipt", async () => {
    const workDirectory = mkdtempSync(
      join(tmpdir(), "vem-vm-host-start-timeout-recovery-"),
    );
    const statePath = join(workDirectory, "state.json");
    const request = createVmHostAdapterRequest(
      serialSessionRequest("start-serial-session"),
    );
    const expected = deriveSerialSessionBinding({
      runId: request.runId,
      lifecycleReference: request.lifecycleReference,
      targetIdentity: request.target.identity,
      startOperationReference: request.operationReference,
    });
    await assert.rejects(
      () =>
        runVmHostAdapter({
          request,
          workDirectory,
          timeoutMs: 300,
          environment: {
            VEM_VM_HOST_ADAPTER: FAKE_ADAPTER,
            VEM_VM_HOST_ADAPTER_FAKE_SCENARIO: "hang",
            VEM_VM_HOST_ADAPTER_STATE_FILE: statePath,
          },
        }),
      VmHostAdapterExecutionError,
    );
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(state.sessions[expected.serialSessionId].active, false);
    assert.equal(
      state.sessions[expected.serialSessionId].cleanupAttemptCount,
      2,
    );
  });

  it("terminates a genuinely hanging child with SIGTERM, invokes cleanup, and persists a sanitized timeout diagnostic", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-vm-host-timeout-"));
    const signalFile = join(root, "adapter.signal");
    await assert.rejects(
      () =>
        runVmHostAdapter({
          request: createVmHostAdapterRequest(requestFor()),
          workDirectory: root,
          timeoutMs: 80,
          environment: {
            VEM_VM_HOST_ADAPTER: FAKE_ADAPTER,
            VEM_VM_HOST_ADAPTER_FAKE_SCENARIO: "hang",
            VEM_VM_HOST_ADAPTER_SIGNAL_FILE: signalFile,
          },
        }),
      (error) => {
        assert.ok(error instanceof VmHostAdapterExecutionError);
        assert.equal(error.diagnostic.result, "timed_out");
        assert.deepEqual(error.diagnostic.cleanup, {
          attempted: true,
          status: "completed",
          observed: {
            overlay: "removed",
            runDirectory: "removed",
            personalizationMedia: "removed",
          },
        });
        assert.doesNotMatch(
          JSON.stringify(error.diagnostic),
          /\/mnt\/|secret|password|private.?key/i,
        );
        return true;
      },
    );
    assert.equal(existsSync(signalFile), true);
    assert.equal(readFileSync(signalFile, "utf8"), "SIGTERM\n");
  });

  it("removes descendants left by a successful adapter before accepting its report", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-vm-host-descendant-"));
    const descendantPidFile = join(root, "adapter-descendant.pid");
    await runVmHostAdapter({
      request: createVmHostAdapterRequest(requestFor()),
      workDirectory: root,
      environment: {
        VEM_VM_HOST_ADAPTER: FAKE_ADAPTER,
        VEM_VM_HOST_ADAPTER_FAKE_SCENARIO: "spawn-descendant",
        VEM_VM_HOST_ADAPTER_DESCENDANT_PID_FILE: descendantPidFile,
      },
    });
    const descendantPid = Number.parseInt(
      readFileSync(descendantPidFile, "utf8"),
      10,
    );
    assert.ok(Number.isInteger(descendantPid));
    assert.throws(() => process.kill(descendantPid, 0), { code: "ESRCH" });
  });

  it("withholds runner signing-key metadata from the adapter subprocess", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-vm-host-signing-key-env-"));
    const signingKeyFile = join(root, "runner-ed25519.pem");
    writeFileSync(signingKeyFile, "private signing key", { mode: 0o600 });
    await runVmHostAdapter({
      request: createVmHostAdapterRequest(requestFor()),
      workDirectory: root,
      environment: {
        VEM_VM_HOST_ADAPTER: FAKE_ADAPTER,
        VEM_SERIAL_RUNNER_SIGNING_KEY_FILE: signingKeyFile,
        VEM_SERIAL_RUNNER_EXPECTED_PUBLIC_KEY: "runner-public-key",
        VEM_VM_HOST_ADAPTER_EXPECT_ABSENT_ENV:
          "VEM_SERIAL_RUNNER_SIGNING_KEY_FILE,VEM_SERIAL_RUNNER_EXPECTED_PUBLIC_KEY",
      },
    });
    assert.equal(readFileSync(signingKeyFile, "utf8"), "private signing key");
  });

  it("cancels a hanging child through AbortSignal with the same cleanup and signal semantics", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-vm-host-cancel-"));
    const signalFile = join(root, "adapter.signal");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 40);
    await assert.rejects(
      () =>
        runVmHostAdapter({
          request: createVmHostAdapterRequest(requestFor()),
          workDirectory: root,
          timeoutMs: 1000,
          signal: controller.signal,
          environment: {
            VEM_VM_HOST_ADAPTER: FAKE_ADAPTER,
            VEM_VM_HOST_ADAPTER_FAKE_SCENARIO: "hang",
            VEM_VM_HOST_ADAPTER_SIGNAL_FILE: signalFile,
          },
        }),
      (error) =>
        error instanceof VmHostAdapterExecutionError &&
        error.diagnostic.result === "cancelled" &&
        error.diagnostic.cleanup.status === "completed",
    );
    assert.equal(readFileSync(signalFile, "utf8"), "SIGTERM\n");
  });

  it("writes a sanitized failed diagnostic for workflow upload", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-vm-host-cli-"));
    const out = join(root, "report.json");
    assert.throws(() =>
      execFileSync(
        process.execPath,
        [
          CLIENT,
          "--operation",
          "restore-approved-base",
          "--run-id",
          "RUN-12-CONTRACT",
          "--target-identity",
          "vm-target://runtime-testbed",
          "--approved-runtime-base",
          `factory-cas://sha256/${HASH}`,
          "--out",
          out,
        ],
        {
          env: {
            ...process.env,
            RUNNER_TEMP: root,
            VEM_VM_HOST_ADAPTER: FAKE_ADAPTER,
            VEM_VM_HOST_ADAPTER_FAKE_SCENARIO: "failure",
          },
        },
      ),
    );
    const diagnostic = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(diagnostic.result, "failed");
    assert.doesNotMatch(
      JSON.stringify(diagnostic),
      /\/mnt\/|password|private.?key/i,
    );
  });

  it("rejects the deterministic fake adapter from the production CLI", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-vm-host-fake-guard-"));
    const out = join(root, "report.json");
    const {
      VEM_VM_HOST_ADAPTER_CONTRACT_TEST_ONLY: _testOnly,
      ...productionEnvironment
    } = process.env;
    assert.throws(() =>
      execFileSync(
        process.execPath,
        [
          CLIENT,
          "--operation",
          "restore-approved-base",
          "--run-id",
          "RUN-12-CONTRACT",
          "--target-identity",
          "vm-target://runtime-testbed",
          "--approved-runtime-base",
          `factory-cas://sha256/${HASH}`,
          "--out",
          out,
        ],
        {
          env: {
            ...productionEnvironment,
            RUNNER_TEMP: root,
            VEM_VM_HOST_ADAPTER: FAKE_ADAPTER,
          },
        },
      ),
    );
    const diagnostic = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(diagnostic.diagnostics[0].code, "evidence_invalid");
  });

  it("binds the CLI display capture to the supplied CDP target and generated visual challenge", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-vm-host-display-cli-"));
    const out = join(root, "display.json");
    execFileSync(
      process.execPath,
      [
        CLIENT,
        "--operation",
        "capture-display",
        "--run-id",
        "RUN-12-CONTRACT",
        "--target-identity",
        "vm-target://runtime-testbed",
        "--approved-runtime-base",
        `factory-cas://sha256/${HASH}`,
        "--active-kiosk-session-user",
        "VEMKiosk",
        "--active-kiosk-session-id",
        "3",
        "--tauri-route",
        "http://tauri.localhost/#/",
        "--cdp-target-id",
        "cdp-target-runtime-001",
        "--out",
        out,
      ],
      {
        env: {
          ...process.env,
          RUNNER_TEMP: root,
          VEM_VM_HOST_ADAPTER: FAKE_ADAPTER,
          VEM_VM_HOST_EVIDENCE_EXPORT_DIR: join(root, "evidence"),
        },
      },
    );
    const report = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(report.displayCapture.tauriRoute, "http://tauri.localhost/#/");
    assert.equal(report.displayCapture.cdpTargetId, "cdp-target-runtime-001");
    assert.match(report.displayCapture.visualChallenge.token, /^[a-f0-9]{64}$/);
    assert.equal(
      report.displayCapture.visualChallenge.matchingPixelCount,
      report.displayCapture.visualChallenge.region.width *
        report.displayCapture.visualChallenge.region.height,
    );
  });

  it("runs validated recovery cleanup after an ordinary adapter failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-vm-host-failure-"));
    const cleanupFile = join(root, "cleanup.txt");
    await assert.rejects(
      () =>
        runVmHostAdapter({
          request: createVmHostAdapterRequest(requestFor()),
          workDirectory: root,
          environment: {
            VEM_VM_HOST_ADAPTER: FAKE_ADAPTER,
            VEM_VM_HOST_ADAPTER_FAKE_SCENARIO: "failure",
            VEM_VM_HOST_ADAPTER_CLEANUP_FILE: cleanupFile,
          },
        }),
      (error) =>
        error instanceof VmHostAdapterExecutionError &&
        error.diagnostic.cleanup.status === "completed" &&
        error.diagnostic.cleanup.observed.overlay === "removed",
    );
    assert.equal(readFileSync(cleanupFile, "utf8"), "cleanup\n");
  });

  it("runs validated recovery cleanup after a clean-install adapter failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-vm-host-clean-failure-"));
    const cleanupFile = join(root, "cleanup.txt");
    await assert.rejects(
      () =>
        runVmHostAdapter({
          request: createVmHostAdapterRequest(cleanInstallRequest()),
          workDirectory: root,
          environment: {
            VEM_VM_HOST_ADAPTER: FAKE_ADAPTER,
            VEM_VM_HOST_ADAPTER_FAKE_SCENARIO: "failure",
            VEM_VM_HOST_ADAPTER_CLEANUP_FILE: cleanupFile,
          },
        }),
      (error) =>
        error instanceof VmHostAdapterExecutionError &&
        error.diagnostic.result === "failed" &&
        error.diagnostic.cleanup.status === "completed",
    );
    assert.equal(readFileSync(cleanupFile, "utf8"), "cleanup\n");
  });

  it("cancels and cleans up a timed-out clean-install adapter", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-vm-host-clean-timeout-"));
    const signalFile = join(root, "adapter.signal");
    const cancelFile = join(root, "adapter.cancel");
    const cleanupFile = join(root, "cleanup.txt");
    const operationLog = join(root, "operations.log");
    const pidFile = join(root, "adapter.pid");
    const request = createVmHostAdapterRequest(cleanInstallRequest());
    await assert.rejects(
      () =>
        runVmHostAdapter({
          request,
          workDirectory: root,
          timeoutMs: 80,
          environment: {
            VEM_VM_HOST_ADAPTER: FAKE_ADAPTER,
            VEM_VM_HOST_ADAPTER_FAKE_SCENARIO: "hang",
            VEM_VM_HOST_ADAPTER_SIGNAL_FILE: signalFile,
            VEM_VM_HOST_ADAPTER_CANCEL_FILE: cancelFile,
            VEM_VM_HOST_ADAPTER_CLEANUP_FILE: cleanupFile,
            VEM_VM_HOST_ADAPTER_OPERATION_LOG: operationLog,
            VEM_VM_HOST_ADAPTER_PID_FILE: pidFile,
          },
        }),
      (error) =>
        error instanceof VmHostAdapterExecutionError &&
        error.diagnostic.result === "timed_out" &&
        error.diagnostic.cleanup.status === "completed",
    );
    assert.equal(readFileSync(signalFile, "utf8"), "SIGTERM\n");
    assert.equal(
      readFileSync(cancelFile, "utf8"),
      `${request.operationReference}\n`,
    );
    assert.equal(readFileSync(cleanupFile, "utf8"), "cleanup\n");
    assert.deepEqual(readFileSync(operationLog, "utf8").trim().split("\n"), [
      "clean-install",
      "cancel",
      "cleanup",
    ]);
  });

  it("builds a logical clean-install request from Factory ISO and personalization asset identities", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-vm-host-clean-install-"));
    const out = join(root, "report.json");
    execFileSync(
      process.execPath,
      [
        CLIENT,
        "--operation",
        "clean-install",
        "--run-id",
        "RUN-12-CONTRACT",
        "--target-identity",
        "vm-target://runtime-testbed",
        "--factory-iso",
        `factory-cas://sha256/${"d".repeat(64)}`,
        "--factory-personalization-media",
        `factory-cas://sha256/${"e".repeat(64)}`,
        "--factory-assembly-mode",
        "windows-serviced-iso",
        "--factory-target-firmware",
        "bios",
        "--factory-manifest",
        `sha256:${"f".repeat(64)}`,
        "--factory-provenance",
        `factory-evidence://sha256/${"c".repeat(64)}`,
        "--factory-provenance-digest",
        `sha256:${"c".repeat(64)}`,
        "--out",
        out,
      ],
      {
        env: {
          ...process.env,
          RUNNER_TEMP: root,
          VEM_VM_HOST_ADAPTER: FAKE_ADAPTER,
          VEM_VM_HOST_ADAPTER_FAKE_SCENARIO: "success",
        },
      },
    );
    const report = JSON.parse(readFileSync(out, "utf8"));
    assert.deepEqual(
      report.consumedAssets.map((asset) => asset.role),
      ["factory-iso", "factory-personalization-media"],
    );
    assert.equal(report.observed.firmwareMode, "bios");
  });

  it("builds v2 serial-session requests from logical CLI options", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-vm-host-serial-cli-"));
    const startOut = join(root, "start.json");
    const shared = [
      "--run-id",
      "RUN-12-CONTRACT",
      "--target-identity",
      "vm-target://runtime-testbed",
      "--approved-runtime-base",
      `factory-cas://sha256/${HASH}`,
      "--sale-correlation-id",
      "sale-correlation://sale-001",
      "--order-id",
      "order-001",
      "--payment-id",
      "payment-001",
      "--vending-command-id",
      "vending-command-001",
    ];
    const environment = {
      ...process.env,
      RUNNER_TEMP: root,
      VEM_VM_HOST_ADAPTER: FAKE_ADAPTER,
      VEM_VM_HOST_ADAPTER_FAKE_SCENARIO: "success",
    };
    execFileSync(
      process.execPath,
      [
        CLIENT,
        "--operation",
        "start-serial-session",
        ...shared,
        "--out",
        startOut,
      ],
      { env: environment },
    );
    const start = JSON.parse(readFileSync(startOut, "utf8"));
    assert.equal(start.schemaVersion, "vem-vm-host-adapter-report/v2");
    const injectOut = join(root, "inject.json");
    const protectedScannerCodePath = join(root, "scanner-code.txt");
    writeFileSync(protectedScannerCodePath, PROTECTED_SCANNER_INPUT, {
      mode: 0o600,
    });
    execFileSync(
      process.execPath,
      [
        CLIENT,
        "--operation",
        "inject-scanner-code",
        ...shared,
        "--serial-session-id",
        start.serialSession.serialSessionId,
        "--session-binding-token",
        start.serialSession.sessionBindingToken,
        "--start-operation-reference",
        start.serialSession.startOperationReference,
        "--device-mapping-digest",
        start.serialSession.deviceMappingDigest,
        "--scanner-code-file",
        protectedScannerCodePath,
        "--out",
        injectOut,
      ],
      { env: environment },
    );
    const inject = JSON.parse(readFileSync(injectOut, "utf8"));
    assert.equal(existsSync(protectedScannerCodePath), false);
    assert.deepEqual(inject.serialSession.scannerAcknowledgement, {
      ...createScannerCodeDescriptor(PROTECTED_SCANNER_INPUT),
      accepted: true,
    });
    assert.doesNotMatch(
      JSON.stringify(inject),
      new RegExp(PROTECTED_SCANNER_INPUT),
    );
  });

  it("drives an external adapter executable through serial conformance without scanner persistence", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-vm-host-serial-conformance-"));
    const scannerCodePath = join(root, "protected-scanner-code.txt");
    const runnerSigningKeyFile = join(root, "runner-ed25519.pem");
    const out = join(root, "conformance.json");
    writeFileSync(scannerCodePath, PROTECTED_SCANNER_INPUT, { mode: 0o600 });
    const runnerKey = generateKeyPairSync("ed25519");
    const expectedRunnerPublicKey = `ed25519-public-key:base64:${runnerKey.publicKey
      .export({ type: "spki", format: "der" })
      .toString("base64")}`;
    writeFileSync(
      runnerSigningKeyFile,
      runnerKey.privateKey.export({ type: "pkcs8", format: "pem" }),
      { mode: 0o600 },
    );
    execFileSync(
      process.execPath,
      [
        SERIAL_CONFORMANCE,
        "--adapter",
        FAKE_ADAPTER,
        "--out",
        out,
        "--scanner-code-file",
        scannerCodePath,
        "--runner-signing-key-file",
        runnerSigningKeyFile,
        "--expected-runner-public-key",
        expectedRunnerPublicKey,
        "--run-id",
        "RUN-12-CONTRACT",
        "--target-identity",
        "vm-target://runtime-testbed",
        "--approved-runtime-base",
        `factory-cas://sha256/${HASH}`,
        "--lifecycle-reference",
        "vm-lifecycle://run-12-contract.runtime-testbed",
        "--sale-correlation-id",
        "sale-correlation://sale-001",
        "--order-id",
        "order-001",
        "--payment-id",
        "payment-001",
        "--vending-command-id",
        "vending-command-001",
      ],
      {
        env: {
          ...process.env,
          RUNNER_TEMP: root,
          VEM_VM_HOST_ADAPTER_STATE_FILE: join(root, "adapter-state.json"),
          VEM_SERIAL_RUNNER_SIGNING_KEY_FILE: runnerSigningKeyFile,
          VEM_VM_HOST_ADAPTER_EXPECT_ABSENT_ENV:
            "VEM_SERIAL_RUNNER_SIGNING_KEY_FILE",
        },
      },
    );
    const report = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(existsSync(runnerSigningKeyFile), false);
    assert.equal(report.runnerEvidence.publicKey, expectedRunnerPublicKey);
    assert.equal(
      report.reports.repeatedStop.serialSession.simulatorCleanup
        .idempotencyVerified,
      true,
    );
    assert.equal(report.reports.collect.serialEvidence.records.length, 9);
    assert.deepEqual(report.failureMatrix, [
      {
        failureMode: "malformed-frame",
        operation: "collect-serial-evidence",
        result: "observed_failure",
        adapterResult: "succeeded",
        diagnosticCode: "serial_malformed_frame",
        orderId: "order-001",
        paymentId: "payment-001",
        vendingCommandId: "vending-command-001",
      },
      {
        failureMode: "device-disconnected",
        operation: "collect-serial-evidence",
        result: "observed_failure",
        adapterResult: "succeeded",
        diagnosticCode: "serial_device_disconnected",
        orderId: "order-001",
        paymentId: "payment-001",
        vendingCommandId: "vending-command-001",
      },
      {
        failureMode: "scanner-timeout",
        operation: "inject-scanner-code",
        result: "observed_failure",
        adapterResult: "succeeded",
        diagnosticCode: "serial_scanner_timeout",
        orderId: "order-001",
        paymentId: "payment-001",
        vendingCommandId: "vending-command-001",
      },
      {
        failureMode: "dispense-failed",
        operation: "collect-serial-evidence",
        result: "observed_failure",
        adapterResult: "succeeded",
        diagnosticCode: "serial_dispense_failed",
        orderId: "order-001",
        paymentId: "payment-001",
        vendingCommandId: "vending-command-001",
      },
      {
        failureMode: "swapped-roles",
        operation: "collect-serial-evidence",
        result: "observed_failure",
        adapterResult: "succeeded",
        diagnosticCode: "serial_swapped_roles",
        orderId: "order-001",
        paymentId: "payment-001",
        vendingCommandId: "vending-command-001",
      },
      {
        failureMode: "missing-device",
        operation: "collect-serial-evidence",
        result: "observed_failure",
        adapterResult: "succeeded",
        diagnosticCode: "serial_missing_device",
        orderId: "order-001",
        paymentId: "payment-001",
        vendingCommandId: "vending-command-001",
      },
    ]);
    assert.doesNotMatch(
      JSON.stringify(report),
      new RegExp(PROTECTED_SCANNER_INPUT),
    );

    const rekeyed = structuredClone(report);
    const attacker = generateKeyPairSync("ed25519");
    rekeyed.runnerEvidence.publicKey = `ed25519-public-key:base64:${attacker.publicKey
      .export({ type: "spki", format: "der" })
      .toString("base64")}`;
    for (const name of ["start", "inject", "collect"]) {
      const receipt = rekeyed.runnerEvidence.operations[name];
      receipt.reportDigest = deriveSerialOperationReportDigest(
        rekeyed.reports[name],
      );
      receipt.signature = `ed25519-signature:base64:${sign(
        null,
        Buffer.from(receipt.reportDigest),
        attacker.privateKey,
      ).toString("base64")}`;
    }
    assert.throws(
      () =>
        validateSerialConformanceReport(rekeyed, {
          expectedRunnerPublicKey: report.runnerEvidence.publicKey,
        }),
      /expected runner public key/,
    );

    const forged = structuredClone(report);
    const collectRequest = forged.requests.collect;
    const forgedNonce = "op-abcdefabcdefabcdefabcdefabcdefab";
    const forgedStartReference = `vm-operation://${forgedNonce}`;
    const forgedBinding = deriveSerialSessionBinding({
      runId: "RUN-ATTACKER",
      lifecycleReference: "vm-lifecycle://run-attacker.runtime-testbed",
      targetIdentity: "vm-target://attacker",
      startOperationReference: forgedStartReference,
    });
    const forgedSale = {
      saleCorrelationId: "sale-correlation://sale-attacker",
      orderId: "order-attacker",
      paymentId: "payment-attacker",
      vendingCommandId: "vending-command-attacker",
    };
    const forgedOperationEvidence = {
      runnerChallenge: `serial-runner-challenge://sha256-${"b".repeat(64)}`,
      startReportDigest: `sha256:${"c".repeat(64)}`,
      injectReportDigest: `sha256:${"d".repeat(64)}`,
    };
    Object.assign(collectRequest, {
      runId: "RUN-ATTACKER",
      operationNonce: forgedNonce,
      operationReference: forgedStartReference,
      lifecycleReference: "vm-lifecycle://run-attacker.runtime-testbed",
      target: { identity: "vm-target://attacker" },
      serialSession: {
        ...collectRequest.serialSession,
        ...forgedBinding,
        startOperationReference: forgedStartReference,
        scannerInjection: {
          ...collectRequest.serialSession.scannerInjection,
          operationNonce: "op-fedcba9876543210",
        },
        saleCorrelationIds: [forgedSale.saleCorrelationId],
        saleBindings: [forgedSale],
        operationEvidence: forgedOperationEvidence,
      },
    });
    const collectReport = forged.reports.collect;
    Object.assign(collectReport.request, {
      runId: collectRequest.runId,
      operationNonce: collectRequest.operationNonce,
      operationReference: collectRequest.operationReference,
      lifecycleReference: collectRequest.lifecycleReference,
      targetIdentity: collectRequest.target.identity,
      serialSession: collectRequest.serialSession,
    });
    collectReport.observed.targetBinding.targetIdentity =
      collectRequest.target.identity;
    Object.assign(collectReport.serialSession, {
      ...forgedBinding,
      startOperationReference: forgedStartReference,
    });
    const records = collectReport.serialEvidence.records.map((record) => ({
      ...record,
      operationNonce:
        record.role === "scanner"
          ? collectRequest.serialSession.scannerInjection.operationNonce
          : collectRequest.operationNonce,
      sessionBindingToken: forgedBinding.sessionBindingToken,
      saleCorrelationId:
        record.saleCorrelationId === null ? null : forgedSale.saleCorrelationId,
      saleBinding: record.saleBinding === null ? null : forgedSale,
    }));
    let previousCaptureBindingDigest = null;
    for (const record of records) {
      record.captureBindingDigest = deriveSerialFrameCaptureBindingDigest({
        request: collectRequest,
        record,
        previousCaptureBindingDigest,
      });
      previousCaptureBindingDigest = record.captureBindingDigest;
    }
    Object.assign(collectReport.serialEvidence, {
      serialSessionId: forgedBinding.serialSessionId,
      sessionBindingToken: forgedBinding.sessionBindingToken,
      operationEvidence: forgedOperationEvidence,
      records,
      captureChainDigest: deriveSerialEvidenceCaptureChainDigest({
        request: collectRequest,
        records,
      }),
    });
    assert.doesNotThrow(() =>
      validateVmHostAdapterReport(collectReport, collectRequest),
    );
    assert.throws(
      () =>
        validateSerialConformanceReport(forged, {
          expectedRunnerPublicKey: report.runnerEvidence.publicKey,
        }),
      /runner collect operation evidence (does not bind|signature is invalid)/,
    );
  });

  it("requires swapped and missing serial mappings to block a new sale before business IDs exist", () => {
    const source = readFileSync(SERIAL_CONFORMANCE, "utf8");
    assert.match(source, /prepare-sale-with-faulted-mapping/);
    assert.match(source, /healthz\?\.observed !== true/);
    assert.match(source, /readyz\?\.observed !== true/);
    assert.match(source, /readinessBlockingCodes\.length === 1/);
    assert.match(
      source,
      /Object\.hasOwn\(mappingFault \?\? \{\}, "adapterDiagnosticCode"\)/,
    );
    assert.match(source, /transactionEntry\?\.statusCode !== 400/);
    assert.match(
      source,
      /transactionEntry\?\.responseCode !== "create_order_blocked"/,
    );
    assert.match(
      source,
      /context\?\.successfulPrepare\?\.status !== "succeeded"/,
    );
    assert.match(source, /paymentOption\?\.method === "payment_code"/);
    assert.match(source, /startSerialSession/);
    assert.match(source, /runtimeRecoveryCommandJson/);
    assert.match(source, /did not restore healthy daemon runtime/);
    assert.match(source, /VEM_VM_HOST_FAULT_DEVICE_MAPPING_DIGEST/);
    assert.doesNotMatch(source, /hardware-mapping-fault-code/);
    assert.match(
      source,
      /transactionEntry\?\.endpoint !== "\/v1\/intents\/create-order"/,
    );
    assert.match(source, /transactionEntry\?\.rejected !== true/);
    assert.match(source, /transactionEntry\?\.orderId !== null/);
    assert.match(source, /transactionEntry\?\.paymentId !== null/);
    assert.match(source, /transactionEntry\?\.vendingCommandId !== null/);
  });

  it("rejects mapping fault reports with extra blockers or fabricated sale context", () => {
    const evidence = assertBlockedSaleEvidence({
      commandExitStatus: 1,
      output: blockedSaleOutput(),
      failureMode: "swapped-roles",
      runId: "RUN-12-CONTRACT",
    });
    assert.equal(evidence.scannerOnline, true);
    assert.deepEqual(evidence.readinessBlockingCodes, [
      "LOWER_CONTROLLER_UNAVAILABLE",
    ]);

    for (const [description, responseBlockingCodes] of [
      [
        "a response with multiple blockers after a single-blocker readyz snapshot",
        ["LOWER_CONTROLLER_UNAVAILABLE", "NO_PAYMENT_OPTIONS"],
      ],
      [
        "a response with a different blocker after a single-blocker readyz snapshot",
        ["NO_PAYMENT_OPTIONS"],
      ],
      [
        "an unparseable response message after a single-blocker readyz snapshot",
        [],
      ],
    ]) {
      const staleReadyzSnapshot = blockedSaleOutput();
      staleReadyzSnapshot.simulatedHardwareSaleFlow.transactionEntry.responseBlockingCodes =
        responseBlockingCodes;
      assert.throws(
        () =>
          assertBlockedSaleEvidence({
            commandExitStatus: 1,
            output: staleReadyzSnapshot,
            failureMode: "swapped-roles",
            runId: "RUN-12-CONTRACT",
          }),
        /did not fail closed/,
        description,
      );
    }

    const multiBlocker = blockedSaleOutput();
    multiBlocker.simulatedHardwareSaleFlow.daemonIpc.readyz.blockingCodes.push(
      "NO_PAYMENT_OPTIONS",
    );
    multiBlocker.simulatedHardwareSaleFlow.hardwareMappingFault.readinessBlockingCodes.push(
      "NO_PAYMENT_OPTIONS",
    );
    multiBlocker.simulatedHardwareSaleFlow.transactionEntry.readinessBlockingCodes.push(
      "NO_PAYMENT_OPTIONS",
    );
    assert.throws(
      () =>
        assertBlockedSaleEvidence({
          commandExitStatus: 1,
          output: multiBlocker,
          failureMode: "swapped-roles",
          runId: "RUN-12-CONTRACT",
        }),
      /did not fail closed/,
    );

    const unavailablePayment = blockedSaleOutput();
    unavailablePayment.simulatedHardwareSaleFlow.transactionEntry.context.paymentOption.ready = false;
    assert.throws(
      () =>
        assertBlockedSaleEvidence({
          commandExitStatus: 1,
          output: unavailablePayment,
          failureMode: "missing-device",
          runId: "RUN-12-CONTRACT",
        }),
      /did not fail closed/,
    );

    const missingContext = blockedSaleOutput();
    missingContext.simulatedHardwareSaleFlow.transactionEntry.context = null;
    assert.throws(
      () =>
        assertBlockedSaleEvidence({
          commandExitStatus: 1,
          output: missingContext,
          failureMode: "missing-device",
          runId: "RUN-12-CONTRACT",
        }),
      /did not fail closed/,
    );

    const fabricatedContext = blockedSaleOutput();
    fabricatedContext.simulatedHardwareSaleFlow.transactionEntry.request.slotId =
      "invented-slot";
    assert.throws(
      () =>
        assertBlockedSaleEvidence({
          commandExitStatus: 1,
          output: fabricatedContext,
          failureMode: "missing-device",
          runId: "RUN-12-CONTRACT",
        }),
      /did not fail closed/,
    );
  });

  it("binds mapping fault evidence to the actual adapter start report", () => {
    const startReport = {
      result: "succeeded",
      diagnostics: [{ code: "serial_swapped_roles" }],
      serialSession: {
        serialSessionId: "serial-session-001",
        startOperationReference: "vm-operation://start-001",
        deviceMappingDigest: `sha256:${"b".repeat(64)}`,
      },
      timestamps: { startedAt: "2026-07-11T00:00:00.000Z" },
    };
    const failureCase = observedMappingFailureCase({
      failureMode: "swapped-roles",
      startReport,
      expectedDiagnosticCode: "serial_swapped_roles",
      daemonFailClosed: {
        saleBindingCreated: false,
        adapterSession:
          blockedSaleOutput().simulatedHardwareSaleFlow.hardwareMappingFault
            .adapterSession,
      },
      recovery: {
        runtimeReady: "passed",
        hardwareOnline: true,
        scannerOnline: true,
        ready: true,
      },
    });
    assert.equal(failureCase.diagnosticCode, "serial_swapped_roles");
    assert.deepEqual(failureCase.startSerialSession, startReport.serialSession);

    assert.throws(
      () =>
        observedMappingFailureCase({
          failureMode: "swapped-roles",
          startReport: { ...startReport, serialSession: null },
          expectedDiagnosticCode: "serial_swapped_roles",
          daemonFailClosed: { saleBindingCreated: false },
          recovery: {
            runtimeReady: "passed",
            hardwareOnline: true,
            scannerOnline: true,
            ready: true,
          },
        }),
      /did not bind its fail-closed evidence/,
    );
  });

  it("stops the serial session from finally when evidence collection fails", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-vm-host-serial-finally-"));
    const scannerCodePath = join(root, "protected-scanner-code.txt");
    const out = join(root, "conformance.json");
    writeFileSync(scannerCodePath, PROTECTED_SCANNER_INPUT, { mode: 0o600 });
    assert.throws(() =>
      execFileSync(
        process.execPath,
        [
          SERIAL_CONFORMANCE,
          "--adapter",
          FAKE_ADAPTER,
          "--out",
          out,
          "--scanner-code-file",
          scannerCodePath,
          "--run-id",
          "RUN-12-CONTRACT",
          "--target-identity",
          "vm-target://runtime-testbed",
          "--approved-runtime-base",
          `factory-cas://sha256/${HASH}`,
          "--lifecycle-reference",
          "vm-lifecycle://run-12-contract.runtime-testbed",
          "--sale-correlation-id",
          "sale-correlation://sale-001",
          "--order-id",
          "order-001",
          "--payment-id",
          "payment-001",
          "--vending-command-id",
          "vending-command-001",
        ],
        {
          env: {
            ...process.env,
            RUNNER_TEMP: root,
            VEM_VM_HOST_ADAPTER_STATE_FILE: join(root, "adapter-state.json"),
            VEM_VM_HOST_ADAPTER_FAIL_OPERATION: "collect-serial-evidence",
          },
        },
      ),
    );
    const report = JSON.parse(readFileSync(out, "utf8"));
    assert.match(
      report.runnerEvidence?.publicKey ?? "",
      /^ed25519-public-key:base64:/,
    );
    assert.deepEqual(
      Object.keys(report.runnerEvidence?.operations ?? {}).sort(),
      ["inject", "start"],
    );
    assert.equal(report.reports.recoveryStop.serialSession.state, "stopped");
    assert.equal(
      report.reports.recoveryStop.serialSession.simulatorCleanup
        .survivingProcessCount,
      0,
    );
    assert.equal(
      report.reports.recoveryStop.serialSession.simulatorCleanup
        .survivingSocketCount,
      0,
    );
  });

  it("does not let an adapter claim conformance while clean install is blocked by Issue15", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-vm-host-conformance-"));
    const out = join(root, "conformance.json");
    assert.throws(() =>
      execFileSync(process.execPath, [CONFORMANCE, "--out", out], {
        env: {
          ...process.env,
          RUNNER_TEMP: root,
          VEM_VM_HOST_ADAPTER: FAKE_ADAPTER,
          VEM_VM_HOST_TARGET_ID: "vm-target://runtime-testbed",
          VEM_VM_HOST_APPROVED_BASE_ID: `factory-cas://sha256/${HASH}`,
          VEM_VM_HOST_FACTORY_ISO_ID: `factory-cas://sha256/${"d".repeat(64)}`,
          VEM_VM_HOST_FACTORY_PERSONALIZATION_MEDIA_ID: `factory-cas://sha256/${"e".repeat(64)}`,
          VEM_VM_HOST_EVIDENCE_EXPORT_DIR: join(root, "evidence-export"),
          VEM_VM_HOST_CLEAN_INSTALL_STATUS: "blocked-issue15",
          VEM_VM_HOST_ADAPTER_FAKE_SCENARIO: "success",
        },
      }),
    );
    const evidence = JSON.parse(readFileSync(out, "utf8"));
    assert.deepEqual(evidence.evidence.cleanInstall, {
      status: "blocked-issue15",
    });
  });

  it("cancels the CLI subprocess, waits for its hanging adapter, persists a diagnostic, and coordinates recovery cleanup", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-vm-host-cli-cancel-"));
    const out = join(root, "diagnostic.json");
    const pidFile = join(root, "adapter.pid");
    const cleanupFile = join(root, "cleanup.txt");
    const cancelFile = join(root, "cancel.txt");
    const signalFile = join(root, "signal.txt");
    let client;
    let adapterPid;
    try {
      client = spawn(
        process.execPath,
        [
          CLIENT,
          "--operation",
          "restore-approved-base",
          "--run-id",
          "RUN-12-CONTRACT",
          "--target-identity",
          "vm-target://runtime-testbed",
          "--approved-runtime-base",
          `factory-cas://sha256/${HASH}`,
          "--out",
          out,
        ],
        {
          env: {
            ...process.env,
            RUNNER_TEMP: root,
            VEM_VM_HOST_ADAPTER: FAKE_ADAPTER,
            VEM_VM_HOST_ADAPTER_FAKE_SCENARIO: "hang",
            VEM_VM_HOST_ADAPTER_PID_FILE: pidFile,
            VEM_VM_HOST_ADAPTER_CLEANUP_FILE: cleanupFile,
            VEM_VM_HOST_ADAPTER_CANCEL_FILE: cancelFile,
            VEM_VM_HOST_ADAPTER_SIGNAL_FILE: signalFile,
          },
          stdio: "ignore",
        },
      );
      await waitFor(() => existsSync(pidFile), "adapter did not start");
      adapterPid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
      assert.ok(Number.isInteger(adapterPid));

      client.kill("SIGTERM");
      const [exitCode] = await once(client, "close");
      assert.notEqual(exitCode, 0);
      await waitFor(() => {
        try {
          process.kill(adapterPid, 0);
          return false;
        } catch (error) {
          return error?.code === "ESRCH";
        }
      }, "adapter process remained after CLI cancellation");

      const diagnostic = JSON.parse(readFileSync(out, "utf8"));
      assert.equal(diagnostic.result, "cancelled");
      assert.deepEqual(diagnostic.cleanup, {
        attempted: true,
        status: "completed",
        observed: {
          overlay: "removed",
          runDirectory: "removed",
          personalizationMedia: "removed",
        },
      });
      assert.equal(readFileSync(cleanupFile, "utf8"), "cleanup\n");
      assert.equal(
        readFileSync(cancelFile, "utf8").trim(),
        diagnostic.request.operationReference,
      );
      assert.equal(
        readFileSync(signalFile, "utf8").trim(),
        "SIGTERM",
        "the operation-reference-bound cancel request must signal the in-flight adapter",
      );
    } finally {
      client?.kill("SIGKILL");
      if (Number.isInteger(adapterPid)) {
        try {
          process.kill(adapterPid, "SIGKILL");
        } catch {}
      }
    }
  });
});
