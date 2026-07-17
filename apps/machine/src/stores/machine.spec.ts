import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useAudioCueStore } from "./audio-cues";
import { useMachineStore } from "./machine";

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
});

describe("useMachineStore", () => {
  it("applies daemon-owned effective audio preferences to the runtime cue store", () => {
    useMachineStore().applyCustomerAudioPreferences({
      volume: 0.7,
      cuesEnabled: true,
      presenceCuesEnabled: true,
      transactionCuesEnabled: false,
    });

    const request = useAudioCueStore().requestCue({
      category: "presence",
      cueKey: "presence.detected",
      requestedAt: "2026-06-29T07:00:00.000Z",
    });
    expect(request).toMatchObject({
      category: "presence",
      cueKey: "presence.detected",
    });
  });

  it("does not expose a generic mutable machine configuration action", () => {
    expect(useMachineStore()).not.toHaveProperty("saveConfig");
  });
});
