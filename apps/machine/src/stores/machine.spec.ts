import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getConfigMock, saveConfigMock } = vi.hoisted(() => ({
  getConfigMock: vi.fn(),
  saveConfigMock: vi.fn(),
}));

vi.mock("@/daemon/client", () => ({
  daemonClient: {
    getConfig: getConfigMock,
    saveConfig: saveConfigMock,
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

  it("round-trips stock movement retention days through daemon config save", async () => {
    const config = normalizeMachineConfig({
      machineCode: "MACHINE-1",
      stockMovementRetentionDays: 90,
    });
    saveConfigMock.mockResolvedValue({
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

    const store = useMachineStore();
    await store.saveConfig(config);

    expect(saveConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        public: expect.objectContaining({
          stockMovementRetentionDays: 90,
        }),
      }),
    );
  });

  it("round-trips audio cue settings through daemon config save", async () => {
    const config = normalizeMachineConfig({
      machineCode: "MACHINE-1",
      audioCueSettings: {
        enabled: true,
        categories: {
          presence: true,
          transaction: true,
        },
      },
    });
    saveConfigMock.mockResolvedValue({
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

    const store = useMachineStore();
    await store.saveConfig(config);

    expect(saveConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        public: expect.objectContaining({
          audioCueSettings: {
            enabled: true,
            categories: {
              presence: true,
              transaction: true,
            },
          },
        }),
      }),
    );
    const request = useAudioCueStore().requestCue({
      category: "transaction",
      cueKey: "payment.succeeded",
      orderKey: "ORDER-1",
      requestedAt: "2026-06-29T07:00:00.000Z",
    });
    expect(request).toMatchObject({
      category: "transaction",
      cueKey: "payment.succeeded",
      orderKey: "ORDER-1",
    });
  });
});
