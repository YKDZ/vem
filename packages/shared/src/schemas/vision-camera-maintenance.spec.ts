import { describe, expect, it } from "vitest";

import {
  VISION_CAMERA_MAINTENANCE_CONTRACT_VERSION,
  visionCameraMaintenanceConfirmRequestSchema,
  visionCameraMaintenanceContractSchema,
  visionCameraMaintenanceErrorSchema,
  visionCameraMaintenanceTestResponseSchema,
} from "./vision-camera-maintenance";

describe("vision camera maintenance schemas", () => {
  it("parses the v2 contract with role-scoped readiness", () => {
    const parsed = visionCameraMaintenanceContractSchema.parse({
      contractVersion: VISION_CAMERA_MAINTENANCE_CONTRACT_VERSION,
      generation: "generation-42",
      candidates: [
        {
          id: "usb#top-001",
          label: "Top Camera",
          backendObservation: {
            backend: "directshow",
            index: 3,
            available: true,
            mappingState: "proven",
          },
        },
      ],
      roles: {
        top: {
          role: "top",
          state: "ready",
          ready: true,
          candidateId: "usb#top-001",
          backendObservation: {
            backend: "directshow",
            index: 3,
            available: true,
            mappingState: "proven",
          },
        },
        front: {
          role: "front",
          state: "missing",
          ready: false,
          candidateId: "usb#front-002",
          reason: "bound_camera_missing",
          backendObservation: {
            backend: "directshow",
            index: null,
            available: false,
            mappingState: "proven",
          },
        },
      },
    });

    expect(parsed.roles.top.state).toBe("ready");
    expect(parsed.roles.front.state).toBe("missing");
  });

  it("rejects a role payload bound to the wrong slot", () => {
    expect(() =>
      visionCameraMaintenanceContractSchema.parse({
        contractVersion: VISION_CAMERA_MAINTENANCE_CONTRACT_VERSION,
        generation: "generation-42",
        candidates: [],
        roles: {
          top: {
            role: "front",
            state: "unbound",
            ready: false,
            reason: "camera_not_confirmed",
          },
          front: {
            role: "front",
            state: "unbound",
            ready: false,
            reason: "camera_not_confirmed",
          },
        },
      }),
    ).toThrow(/role=top/);
  });

  it("parses test evidence and confirm requests with generation protection", () => {
    const tested = visionCameraMaintenanceTestResponseSchema.parse({
      role: "front",
      candidateId: "usb#front-002",
      generation: "generation-42",
      ok: true,
      frame: {
        width: 1280,
        height: 720,
      },
      backendObservation: {
        backend: "directshow",
        index: 7,
        available: true,
        mappingState: "proven",
      },
      evidence: {
        id: "evidence-1",
        role: "front",
        candidateId: "usb#front-002",
        generation: "generation-42",
        expiresAt: 1_752_570_000,
      },
    });
    const confirm = visionCameraMaintenanceConfirmRequestSchema.parse({
      candidateId: tested.candidateId,
      testEvidenceId: tested.evidence.id,
      operatorVisualConfirmation: true,
      expectedGeneration: tested.generation,
    });

    expect(confirm.expectedGeneration).toBe("generation-42");
  });

  it("parses contract-versioned maintenance errors", () => {
    const parsed = visionCameraMaintenanceErrorSchema.parse({
      contractVersion: VISION_CAMERA_MAINTENANCE_CONTRACT_VERSION,
      error: {
        code: "MaintenanceCapabilityError",
        message: "replay ledger is unavailable",
      },
    });

    expect(parsed.error.code).toBe("MaintenanceCapabilityError");
  });
});
