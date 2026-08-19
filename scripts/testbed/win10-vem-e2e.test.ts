import assert from "node:assert/strict";
import { it } from "node:test";

import {
  buildRuntimeAcceptanceReport,
  readVisionV2ContractIdentity,
} from "./win10-vem-e2e.ts";

function v2VisionRuntime(overrides = {}) {
  const identity = readVisionV2ContractIdentity();
  return {
    healthReachable: true,
    healthStatus: "ok",
    healthProtocol: identity.protocol,
    healthModule: "vision",
    healthMockScenario: "off",
    cameraReady: true,
    installedProcessBound: true,
    installedRecordPresent: true,
    installedCommit: "a".repeat(40),
    installedRuntime: "vending-vision.exe",
    installedAppDirectory: "C:\\VEM\\vision\\app",
    installedRuntimeWorkDirectory: "C:\\ProgramData\\VEM\\vision\\runtime",
    executablePath: "C:\\VEM\\vision\\app\\vending-vision.exe",
    processId: 42,
    listenerBound: true,
    listenerProcessId: 42,
    listenerOwnerCount: 1,
    listenerBindingSource: "Get-NetTCPConnection",
    webSocketConnected: true,
    readyProtocol: identity.protocol,
    readyType: "vision.ready",
    readyMessageId: "550e8400-e29b-41d4-a716-446655440124",
    readyTimestamp: "2026-08-09T00:00:00.000Z",
    readyServerName: "vending-vision",
    readyCameraReady: true,
    readyFastReady: true,
    readyVisionBusinessReady: true,
    readyBusinessReadinessDiagnostic: "ready",
    readySchemaVersion: identity.schemaVersion,
    readyBundleVersion: identity.bundleVersion,
    readyContractDigest: identity.contractDigest,
    readyCapabilities: [
      "profile_push",
      "presence_status",
      "person_departed",
      "try_on_fast",
    ],
    ...overrides,
  };
}

it("accepts only the manifest-derived V2 ready identity", () => {
  const accepted = buildRuntimeAcceptanceReport({
    visionRuntime: v2VisionRuntime(),
  });
  assert.equal(
    accepted.diagnostics.some((diagnostic) =>
      diagnostic.code.startsWith("vision_"),
    ),
    false,
  );

  const rejected = buildRuntimeAcceptanceReport({
    visionRuntime: v2VisionRuntime({ readyContractDigest: "f".repeat(64) }),
  });
  assert.ok(
    rejected.diagnostics.some(
      (diagnostic) => diagnostic.code === "vision_protocol_not_ready",
    ),
  );
});
