import { describe, expect, it } from "vitest";

import {
  environmentControlActionSchema,
  environmentControlAdmissionSchema,
  environmentControlSnapshotSchema,
} from "./environment-control";

const snapshot = {
  schemaVersion: "vem-environment-control/v1",
  revision: 7,
  settings: {
    airConditionerEnabled: false,
    targetTemperatureCelsius: 26,
    baseVentSpeed: 3,
  },
  desired: {
    airConditionerEnabled: false,
    targetTemperatureCelsius: 26,
    ventSpeed: 0,
  },
  confirmed: {
    airConditionerEnabled: null,
    targetTemperatureCelsius: null,
    ventSpeed: null,
  },
  convergence: "pending",
  reasonCode: "action_accepted",
  message: null,
  lastAction: {
    actionId: "presence-7:departure",
    source: "stable_presence",
    action: "temporarily_stop_vent",
    acceptedAt: "2026-08-24T00:00:00.000Z",
  },
  updatedAt: "2026-08-24T00:00:00.000Z",
  lastAttemptAt: null,
  confirmedAt: null,
};

describe("environment control contracts", () => {
  it("parses the single action and authoritative snapshot seam", () => {
    expect(
      environmentControlActionSchema.parse({
        actionId: "local-speed-4",
        source: "local_operator",
        action: { type: "set_base_vent_speed", ventSpeed: 4 },
      }).action,
    ).toEqual({ type: "set_base_vent_speed", ventSpeed: 4 });
    expect(environmentControlSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(
      environmentControlAdmissionSchema.parse({
        outcome: "accepted",
        acceptedRevision: 7,
        snapshot,
      }).acceptedRevision,
    ).toBe(7);
  });

  it("does not admit presence or manual-mode facts into the domain action", () => {
    expect(() =>
      environmentControlActionSchema.parse({
        actionId: "presence-extra",
        source: "stable_presence",
        personPresent: false,
        action: { type: "temporarily_stop_vent" },
      }),
    ).toThrow();
    expect(() =>
      environmentControlActionSchema.parse({
        actionId: "manual-mode",
        source: "local_operator",
        manualMode: true,
        action: { type: "set_base_vent_speed", ventSpeed: 2 },
      }),
    ).toThrow();
  });
});
