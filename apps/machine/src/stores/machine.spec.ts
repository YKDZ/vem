import type { EffectiveMachineRuntimeConfiguration } from "@vem/shared";

import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useAudioCueStore } from "./audio-cues";
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

    const request = useAudioCueStore().requestCue({
      category: "presence",
      cueKey: "presence.detected",
      requestedAt: "2026-06-29T07:00:00.000Z",
    });
    expect(request).toMatchObject({
      category: "presence",
      cueKey: "presence.detected",
    });
    expect(useAudioCueStore()).not.toHaveProperty("settings");
    expect(useAudioCueStore()).not.toHaveProperty("applySettings");

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
    expect(
      useAudioCueStore().requestCue({
        category: "transaction",
        cueKey: "payment.succeeded",
      }),
    ).toBeNull();
  });

  it("does not expose a generic mutable machine configuration action", () => {
    expect(useMachineStore()).not.toHaveProperty("saveConfig");
  });
});
