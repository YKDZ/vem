import type { EffectiveMachineRuntimeConfiguration } from "@vem/shared";

import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useMachineStore } from "./machine";

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
});

describe("useMachineStore", () => {
  it("keeps effective runtime configuration as the cue preference authority", () => {
    const machineStore = useMachineStore();
    machineStore.applyEffectiveRuntimeConfiguration({
      experience: {
        audio: {
          volume: 0.7,
          cuesEnabled: true,
          presenceCuesEnabled: true,
          transactionCuesEnabled: false,
        },
      },
    } as EffectiveMachineRuntimeConfiguration);

    expect(machineStore.customerAudio).toEqual({
      volume: 0.7,
      cuesEnabled: true,
      presenceCuesEnabled: true,
      transactionCuesEnabled: false,
    });

    machineStore.applyEffectiveRuntimeConfiguration({
      experience: {
        audio: {
          volume: 0.7,
          cuesEnabled: false,
          presenceCuesEnabled: true,
          transactionCuesEnabled: true,
        },
      },
    } as EffectiveMachineRuntimeConfiguration);
    expect(machineStore.customerAudio.cuesEnabled).toBe(false);
  });

  it("does not expose a generic mutable machine configuration action", () => {
    expect(useMachineStore()).not.toHaveProperty("saveConfig");
  });
});
