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
import { useMachineStore } from "./machine";

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
});

describe("useMachineStore", () => {
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
});
