import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getSyncStatusMock } = vi.hoisted(() => ({
  getSyncStatusMock: vi.fn(),
}));

vi.mock("@/daemon/client", () => ({
  daemonClient: {
    getSyncStatus: getSyncStatusMock,
  },
}));

import { useMqttStore } from "./mqtt";

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
});

describe("useMqttStore", () => {
  it("loads sync snapshot from daemon", async () => {
    getSyncStatusMock.mockResolvedValue({
      mqttRunning: true,
      mqttConnected: true,
      brokerUrlMasked: "mqtt://127.0.0.1:1883",
      lastHeartbeatAt: "2026-01-01T00:00:00Z",
      lastCommandNo: "CMD-001",
      outboxSize: 10,
      outboxMax: 1000,
      outboxUsage: 0.01,
      nextRetryAt: null,
      lastError: null,
      tlsAuthStatus: "ok",
    });

    const store = useMqttStore();
    await store.refresh();

    expect(store.connected).toBe(true);
    expect(store.status).toBe("connected");
    expect(store.lastCommandNo).toBe("CMD-001");
  });

  it("derives outbox warning from usage ratio", () => {
    const store = useMqttStore();
    store.applySync({
      mqttRunning: true,
      mqttConnected: false,
      brokerUrlMasked: null,
      lastHeartbeatAt: null,
      lastCommandNo: null,
      outboxSize: 950,
      outboxMax: 1000,
      outboxUsage: 0.95,
      nextRetryAt: null,
      lastError: "offline",
      tlsAuthStatus: null,
    });

    expect(store.outboxWarning).toContain("950/1000");
    expect(store.lastError).toBe("offline");
  });
});
