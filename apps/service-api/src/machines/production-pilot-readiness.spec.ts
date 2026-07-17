import { describe, expect, it } from "vitest";

import { evaluateProductionPilotReadiness } from "./production-pilot-readiness";

const readyInput = {
  machine: {
    status: "online" as const,
    lastSeenAt: new Date("2026-06-27T02:00:00.000Z"),
  },
  latestHeartbeat: {
    reportedAt: new Date("2026-06-27T02:00:00.000Z"),
    statusPayload: {
      scannerHealth: { status: "online" },
      productionDispensePath: { status: "ready" },
      physicalStockAttestation: { status: "ready", planogramVersion: "PLAN-1" },
      recoveryDrill: { status: "ready" },
      managedMachineUpdate: { status: "ready" },
    },
  },
  paymentOptions: [
    {
      providerCode: "wechat_pay",
      method: "qr_code",
      mode: "production",
    },
  ],
  machineHeartbeatTimeoutSeconds: 120,
  platformPlanogram: {
    activeAcknowledgedPlanogramVersion: "PLAN-1",
  },
};

describe("evaluateProductionPilotReadiness", () => {
  it.each([
    ["stale", "stale", "record_active_planogram_stock_attestation"],
    ["inconsistent", "inconsistent", "resolve_stock_state_inconsistencies"],
  ])(
    "exposes %s Physical Stock Attestation as its own blocker",
    (status, reasonCode, actionCode) => {
      const result = evaluateProductionPilotReadiness(
        {
          ...readyInput,
          latestHeartbeat: {
            ...readyInput.latestHeartbeat,
            statusPayload: {
              ...readyInput.latestHeartbeat.statusPayload,
              physicalStockAttestation: { status },
            },
          },
        },
        new Date("2026-06-27T02:00:30.000Z"),
      );

      expect(result.status).toBe("blocked");
      expect(result.blockers).toContainEqual(
        expect.objectContaining({
          kind: "physical_stock_attestation",
          reasonCode,
          status: "blocked",
          actionCode,
          evidence: expect.objectContaining({
            attestationStatus: status,
          }),
        }),
      );
      expect(JSON.stringify(result)).not.toMatch(
        /"label"|"message"|"operatorAction"/,
      );
    },
  );

  it("blocks Physical Stock Attestation when heartbeat planogram differs from platform active acknowledged planogram", () => {
    const result = evaluateProductionPilotReadiness(
      {
        ...readyInput,
        latestHeartbeat: {
          ...readyInput.latestHeartbeat,
          statusPayload: {
            ...readyInput.latestHeartbeat.statusPayload,
            physicalStockAttestation: {
              status: "ready",
              planogramVersion: "PLAN-OLD",
            },
          },
        },
        platformPlanogram: {
          activeAcknowledgedPlanogramVersion: "PLAN-NEW",
        },
      },
      new Date("2026-06-27T02:00:30.000Z"),
    );

    expect(result.status).toBe("blocked");
    expect(result.blockers).toContainEqual(
      expect.objectContaining({
        kind: "physical_stock_attestation",
        reasonCode: "planogram_mismatch",
        status: "blocked",
        actionCode: "apply_planogram_then_attest_stock",
        evidence: expect.objectContaining({
          attestationPlanogramVersion: "PLAN-OLD",
          activeAcknowledgedPlanogramVersion: "PLAN-NEW",
          planogramMatches: false,
        }),
      }),
    );
  });

  it("reports unconfigured External Natural Environment as degraded Natural Context Readiness", () => {
    const result = evaluateProductionPilotReadiness(
      {
        ...readyInput,
        externalNaturalEnvironment: { status: "unconfigured" },
      },
      new Date("2026-06-27T02:00:30.000Z"),
    );

    expect(result.status).toBe("degraded");
    expect(result.blockers).toEqual([]);
    expect(result.degraded).toContainEqual(
      expect.objectContaining({
        kind: "natural_context_readiness",
        reasonCode: "unconfigured",
        status: "degraded",
        actionCode: "configure_machine_geo_location",
        evidence: {
          externalNaturalEnvironmentStatus: "unconfigured",
        },
      }),
    );
  });
});
