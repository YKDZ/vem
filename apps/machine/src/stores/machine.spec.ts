import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getConfigMock } = vi.hoisted(() => ({
  getConfigMock: vi.fn(),
}));

vi.mock("@/daemon/client", () => ({
  daemonClient: {
    getConfig: getConfigMock,
  },
}));

import { normalizeMachineConfig } from "@/config/machine-config";

import { useAudioCueStore } from "./audio-cues";
import { useMachineStore } from "./machine";

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
});

describe("useMachineStore", () => {
  it("applies daemon audio cue settings to the runtime cue store when config loads", async () => {
    const config = normalizeMachineConfig({
      machineCode: "MACHINE-1",
      audioCueSettings: {
        enabled: true,
        categories: {
          presence: true,
          transaction: false,
        },
      },
    });
    getConfigMock.mockResolvedValue({
      public: {
        ...config,
        machineSecret: undefined,
        machineSecretConfigured: undefined,
        mqttSigningSecret: undefined,
        mqttSigningSecretConfigured: undefined,
        mqttPassword: undefined,
        mqttPasswordConfigured: undefined,
      },
      machineSecretConfigured: false,
      mqttSigningSecretConfigured: false,
      mqttPasswordConfigured: false,
    });

    await useMachineStore().loadConfig();

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
