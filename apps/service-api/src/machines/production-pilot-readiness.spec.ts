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
      saleReadiness: { state: "restored" as const, blockingCodes: [] },
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
    ["stale", "physical_stock_attestation.stale"],
    ["inconsistent", "physical_stock_attestation.inconsistent"],
  ])(
    "exposes %s Physical Stock Attestation as its own blocker",
    (status, code) => {
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
          code,
          label: "Physical Stock Attestation",
          status: "blocked",
        }),
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
        code: "physical_stock_attestation.planogram_mismatch",
        label: "Physical Stock Attestation",
        status: "blocked",
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
        code: "natural_context_readiness.unconfigured",
        label: "Natural Context Readiness",
        status: "degraded",
      }),
    );
  });
});
