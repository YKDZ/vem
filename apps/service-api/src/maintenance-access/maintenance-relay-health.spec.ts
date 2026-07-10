import type { MaintenanceRelayObservedState } from "@vem/shared";

import { describe, expect, it } from "vitest";

import { projectMaintenanceRelayHealth } from "./maintenance-relay-health";

const observed: MaintenanceRelayObservedState = {
  schemaVersion: "maintenance-relay-observed-state/v1",
  observedAt: "2026-07-10T12:00:00.000Z",
  desiredStateSchemaVersion: "maintenance-relay-desired-state/v1",
  appliedDesiredStateVersion: 7,
  attemptedDesiredStateVersion: null,
  appliedPeerIds: [],
  appliedAuthorizationIds: [],
  peerObservations: [],
  activeAuthorizationObservations: [],
  transport: { mode: "https", health: "healthy", reason: null },
  failure: null,
};

describe("maintenance relay health projection", () => {
  it("distinguishes unreported and stale relay observations without claiming health", () => {
    expect(
      projectMaintenanceRelayHealth(null, 7, new Date("2026-07-10T12:00:00Z")),
    ).toEqual({
      observation: "unreported",
      overall: "unknown",
      stale: false,
      observedAt: null,
    });
    expect(
      projectMaintenanceRelayHealth(
        observed,
        7,
        new Date("2026-07-10T12:00:30.001Z"),
      ),
    ).toEqual({
      observation: "stale",
      overall: "unknown",
      stale: true,
      observedAt: observed.observedAt,
    });
  });

  it("reports current health from transport, failure, and convergence facts", () => {
    expect(
      projectMaintenanceRelayHealth(
        observed,
        7,
        new Date("2026-07-10T12:00:05Z"),
      ),
    ).toMatchObject({ observation: "current", overall: "healthy" });

    for (const degraded of [
      {
        ...observed,
        transport: {
          mode: "insecure-http" as const,
          health: "degraded" as const,
          reason: "Service API uses explicitly allowed insecure HTTP",
        },
      },
      { ...observed, failure: "nftables apply failed" },
      { ...observed, appliedDesiredStateVersion: 6 },
      { ...observed, attemptedDesiredStateVersion: 7 },
    ]) {
      expect(
        projectMaintenanceRelayHealth(
          degraded,
          7,
          new Date("2026-07-10T12:00:05Z"),
        ),
      ).toMatchObject({ observation: "current", overall: "degraded" });
    }
  });
});
