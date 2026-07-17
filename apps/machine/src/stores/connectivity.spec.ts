import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getHealthMock, getReadyMock } = vi.hoisted(() => ({
  getHealthMock: vi.fn(),
  getReadyMock: vi.fn(),
}));

vi.mock("@/daemon/client", () => ({
  daemonClient: {
    getHealth: getHealthMock,
    getReady: getReadyMock,
  },
}));

import { useConnectivityStore } from "./connectivity";

function healthSnapshot() {
  return {
    status: "healthy" as const,
    process: {
      component: "process",
      level: "ok",
      code: "PROCESS_READY",
      message: "ready",
      updatedAt: "2026-06-04T00:00:00Z",
    },
    components: [],
    configConfigured: true,
    databaseOnline: true,
    backendOnline: true,
    mqttConnected: true,
    outboxSize: 0,
    outboxMax: 1000,
    hardwareOnline: true,
    scannerOnline: true,
    visionOnline: false,
    remoteOpsActive: false,
    currentTransaction: null,
    operatorReason: "",
    updatedAt: "2026-06-04T00:00:00Z",
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
});

describe("connectivity diagnostics", () => {
  it("refreshes health and narrow readyz without deriving sale availability", async () => {
    getHealthMock.mockResolvedValue(healthSnapshot());
    getReadyMock.mockResolvedValue({
      ready: false,
      updatedAt: "2026-06-04T00:00:01Z",
    });

    const store = useConnectivityStore();
    await store.refresh();

    expect(store.health?.backendOnline).toBe(true);
    expect(store.ready).toEqual({
      ready: false,
      updatedAt: "2026-06-04T00:00:01Z",
    });
    expect(Object.keys(store.$state).sort()).toEqual([
      "error",
      "health",
      "lastCheckedAt",
      "latestUnknownEventDiagnostic",
      "loading",
      "ready",
      "stale",
    ]);
  });

  it("marks diagnostics stale when refresh fails", async () => {
    getHealthMock.mockRejectedValue(new Error("health unavailable"));
    getReadyMock.mockResolvedValue({
      ready: true,
      updatedAt: "2026-06-04T00:00:01Z",
    });

    const store = useConnectivityStore();
    await expect(store.refresh()).rejects.toThrow("health unavailable");

    expect(store.stale).toBe(true);
    expect(store.error).toBe("health unavailable");
  });
});
