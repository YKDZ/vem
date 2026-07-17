import type { EffectiveMachineRuntimeConfiguration } from "@vem/shared";

import { describe, expect, it, vi } from "vitest";

import {
  hasClaimedMachineIdentity,
  recoverPersistedClaim,
} from "./claim-recovery";

function configuration(
  claimed: boolean,
  machineCode = "MACHINE-001",
): EffectiveMachineRuntimeConfiguration {
  const machine = claimed
    ? {
        id: "550e8400-e29b-41d4-a716-446655440001",
        code: machineCode,
        name: "Machine",
        status: "online",
        locationLabel: null,
      }
    : null;
  return {
    profileRefresh: {
      status: claimed ? "accepted" : "unclaimed",
      lastError: null,
    },
    sourceDocuments: {
      profileCache: claimed ? { profile: { machine } } : null,
    },
    machine,
  } as unknown as EffectiveMachineRuntimeConfiguration;
}

describe("claim recovery", () => {
  it("accepts only an effective profile whose cached and projected machine identities match", () => {
    expect(hasClaimedMachineIdentity(configuration(true), "MACHINE-001")).toBe(
      true,
    );
    expect(hasClaimedMachineIdentity(configuration(true), "OTHER-001")).toBe(
      false,
    );

    const mismatched = configuration(true);
    mismatched.machine = {
      ...mismatched.machine!,
      code: "MACHINE-002",
    };
    expect(hasClaimedMachineIdentity(mismatched, null)).toBe(false);
  });

  it("accepts a persisted claim when a later profile refresh is degraded", () => {
    const degraded = configuration(true);
    degraded.profileRefresh = {
      status: "degraded",
      lastError: "platform profile refresh timed out",
    };

    expect(hasClaimedMachineIdentity(degraded, "MACHINE-001")).toBe(true);
  });

  it("forces reconnection and reads until the persisted claim is observable", async () => {
    const client = {
      initialize: vi.fn().mockResolvedValue(undefined),
      getEffectiveRuntimeConfiguration: vi
        .fn()
        .mockResolvedValueOnce(configuration(false))
        .mockResolvedValueOnce(configuration(true)),
    };
    const wait = vi.fn().mockResolvedValue(undefined);

    await expect(
      recoverPersistedClaim(client, "MACHINE-001", { wait }),
    ).resolves.toMatchObject({ machine: { code: "MACHINE-001" } });
    expect(client.initialize).toHaveBeenCalledTimes(2);
    expect(client.initialize).toHaveBeenNthCalledWith(1, true);
    expect(wait).toHaveBeenCalledOnce();
  });

  it("returns no recovery result when the persisted profile never identifies the claimed machine", async () => {
    const client = {
      initialize: vi.fn().mockResolvedValue(undefined),
      getEffectiveRuntimeConfiguration: vi
        .fn()
        .mockResolvedValue(configuration(false)),
    };

    await expect(
      recoverPersistedClaim(client, null, {
        attempts: 2,
        wait: vi.fn().mockResolvedValue(undefined),
      }),
    ).resolves.toBeNull();
  });
});
