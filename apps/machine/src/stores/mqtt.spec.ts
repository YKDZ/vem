import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock native modules
vi.mock("@/native/tauri", () => ({
  isTauriRuntime: vi.fn(),
  callTauriCommand: vi.fn(),
}));

vi.mock("@/native/mqtt-runtime", () => ({
  startNativeMqttRuntime: vi.fn(),
  stopNativeMqttRuntime: vi.fn(),
  getNativeMqttStatus: vi.fn(),
}));

vi.mock("@/mqtt/client", () => ({
  createMachineMqttClient: vi.fn(),
}));

vi.mock("@/local/outbox", () => ({
  flushOutboxEvents: vi.fn().mockResolvedValue(undefined),
  getOutboxStats: vi.fn().mockReturnValue({ size: 0, usageRatio: 0, max: 1000 }),
}));

vi.mock("@/stores/connectivity", () => ({
  useConnectivityStore: vi.fn(() => ({
    setMachineMqttConnected: vi.fn(),
  })),
}));

vi.mock("@/stores/machine", () => ({
  useMachineStore: vi.fn(() => ({
    hardwareReady: true,
  })),
}));

import * as nativeTauri from "@/native/tauri";
import * as mqttRuntime from "@/native/mqtt-runtime";
import * as mqttClient from "@/mqtt/client";
import { useMqttStore } from "./mqtt";

// Node environment - stub window (needed for setInterval/clearInterval)
vi.stubGlobal("window", {
  setInterval: vi.fn().mockReturnValue(42),
  clearInterval: vi.fn(),
  __TAURI_INTERNALS__: undefined,
});

const mockConfig = {
  machineCode: "M001",
  machineSecret: null,
  machineSecretConfigured: false,
  mqttUrl: "ws://localhost:1883",
  mqttUsername: "user",
  mqttPassword: "pass",
  mqttPasswordConfigured: false,
  mqttSigningSecret: "secret",
  mqttSigningSecretConfigured: false,
  apiBaseUrl: "http://localhost:3000",
  hardwareAdapter: "mock" as const,
  kioskMode: false,
};

describe("useMqttStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    vi.mocked(mqttRuntime.stopNativeMqttRuntime).mockResolvedValue(undefined);
  });

  describe("connect — Tauri native path", () => {
    it("calls startNativeMqttRuntime and skips createMachineMqttClient when isTauriRuntime=true", async () => {
      vi.mocked(nativeTauri.isTauriRuntime).mockReturnValue(true);
      vi.mocked(mqttRuntime.startNativeMqttRuntime).mockResolvedValue({
        running: true,
        connected: true,
        lastError: null,
        lastCommandId: null,
        lastHeartbeatAt: null,
      });

      const store = useMqttStore();
      await store.connect(mockConfig);

      expect(mqttRuntime.startNativeMqttRuntime).toHaveBeenCalledOnce();
      expect(mqttClient.createMachineMqttClient).not.toHaveBeenCalled();
      expect(store.status).toBe("connected");
    });

    it("sets status to connecting when native runtime returns connected=false", async () => {
      vi.mocked(nativeTauri.isTauriRuntime).mockReturnValue(true);
      vi.mocked(mqttRuntime.startNativeMqttRuntime).mockResolvedValue({
        running: false,
        connected: false,
        lastError: "broker unreachable",
        lastCommandId: null,
        lastHeartbeatAt: null,
      });

      const store = useMqttStore();
      await store.connect(mockConfig);

      expect(store.status).toBe("connecting");
    });
  });

  describe("connect — browser/WebView fallback path", () => {
    it("calls createMachineMqttClient and skips startNativeMqttRuntime when isTauriRuntime=false", async () => {
      vi.mocked(nativeTauri.isTauriRuntime).mockReturnValue(false);

      const mockSubscribe = vi.fn().mockResolvedValue(undefined);
      const mockClient = {
        isConnected: vi.fn().mockReturnValue(false),
        end: vi.fn(),
        subscribe: mockSubscribe,
        publish: vi.fn().mockResolvedValue(undefined),
      };
      vi.mocked(mqttClient.createMachineMqttClient).mockReturnValue(
        mockClient as never,
      );

      const store = useMqttStore();
      await store.connect(mockConfig);

      expect(mqttClient.createMachineMqttClient).toHaveBeenCalledOnce();
      expect(mqttRuntime.startNativeMqttRuntime).not.toHaveBeenCalled();
    });
  });

  describe("disconnect", () => {
    it("sets status to disconnected and stops native runtime if in native mode", async () => {
      vi.mocked(nativeTauri.isTauriRuntime).mockReturnValue(true);
      vi.mocked(mqttRuntime.startNativeMqttRuntime).mockResolvedValue({
        running: true,
        connected: true,
        lastError: null,
        lastCommandId: null,
        lastHeartbeatAt: null,
      });

      const store = useMqttStore();
      await store.connect(mockConfig);
      store.disconnect();

      expect(store.status).toBe("disconnected");
      expect(mqttRuntime.stopNativeMqttRuntime).toHaveBeenCalledOnce();
    });
  });
});
