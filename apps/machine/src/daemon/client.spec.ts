import { beforeEach, describe, expect, it, vi } from "vitest";

import { getDaemonConnectionInfo } from "@/native/daemon-connection";

import { daemonClient } from "./client";

declare global {
  interface Window {
    WebSocket?: typeof EventTarget;
  }
}

class MockWebSocket {
  public onopen: ((event: unknown) => void) | null = null;
  public onmessage: ((event: { data: string }) => void) | null = null;
  public onerror: (() => void) | null = null;
  public onclose: (() => void) | null = null;

  public static openCount = 0;
  public static instances: MockWebSocket[] = [];
  public closed = false;

  constructor(readonly url: string) {
    MockWebSocket.openCount += 1;
    MockWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.onopen?.(new Event("open"));
    });
  }

  close(): void {
    this.closed = true;
    this.onclose?.();
  }
}

const resetWs = (): void => {
  MockWebSocket.openCount = 0;
  MockWebSocket.instances = [];
  // @ts-expect-error assign global ctor in test
  globalThis.WebSocket = MockWebSocket as unknown as typeof EventTarget;
};

vi.mock("@/native/daemon-connection", () => ({
  getDaemonConnectionInfo: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  resetWs();
  vi.spyOn(globalThis, "fetch").mockReset();
  daemonClient["connection"] = null;
  daemonClient["seenEventIds"].clear();
});

function healthFixture() {
  return {
    status: "healthy",
    process: {
      component: "daemon",
      level: "ok",
      code: "ready",
      message: "ready",
      updatedAt: "2026-01-01T00:00:00Z",
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
    visionOnline: true,
    remoteOpsActive: false,
    currentTransaction: null,
    operatorReason: "ok",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

describe("DaemonApiClient", () => {
  it("adds Authorization header to requests", async () => {
    vi.mocked(getDaemonConnectionInfo).mockResolvedValue({
      baseUrl: "http://127.0.0.1:7891",
      token: "token-1",
      source: "browser_env",
      mock: true,
    });

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(healthFixture()), {
        status: 200,
      }),
    );

    await daemonClient.getHealth();

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:7891/healthz",
      expect.objectContaining({
        method: "GET",
        headers: {
          Authorization: "Bearer token-1",
          "Content-Type": "application/json",
        },
      }),
    );
  });

  it("records maintenance stock movement with daemon token and attribution", async () => {
    vi.mocked(getDaemonConnectionInfo).mockResolvedValue({
      baseUrl: "http://127.0.0.1:7891",
      token: "token-1",
      source: "browser_env",
      mock: true,
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          items: [],
          source: "local",
          planogramVersion: "PLAN-1",
          lastUpdatedAt: "2026-06-05T00:00:00.000Z",
        }),
        { status: 201 },
      ),
    );

    await daemonClient.recordStockMovement({
      movementId: "MOVE-1",
      planogramVersion: "PLAN-1",
      slotId: "550e8400-e29b-41d4-a716-446655440001",
      movementType: "stock_count_correction",
      quantity: 4,
      source: "local_maintenance",
      attributedTo: "front-panel",
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:7891/v1/stock/movements",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer token-1",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          movementId: "MOVE-1",
          planogramVersion: "PLAN-1",
          slotId: "550e8400-e29b-41d4-a716-446655440001",
          movementType: "stock_count_correction",
          quantity: 4,
          source: "local_maintenance",
          attributedTo: "front-panel",
        }),
      }),
    );
  });

  it("retries after 401 once", async () => {
    vi.mocked(getDaemonConnectionInfo).mockResolvedValue({
      baseUrl: "http://127.0.0.1:7891",
      token: "token-1",
      source: "browser_env",
      mock: true,
    });

    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("no", { status: 401 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(healthFixture()), { status: 200 }),
      );

    await daemonClient.getHealth();

    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("subscribes events with query token and deduplicates", async () => {
    vi.mocked(getDaemonConnectionInfo).mockResolvedValue({
      baseUrl: "http://127.0.0.1:7891",
      token: "dev-token",
      source: "browser_env",
      mock: true,
    });

    const events: string[] = [];
    const onEvent = vi.fn((event) => {
      events.push(event.type);
    });
    const onError = vi.fn();
    const onStale = vi.fn();
    const subscription = daemonClient.subscribeEvents({
      onEvent,
      onError,
      onStale,
    });

    await vi.waitFor(() => {
      expect(MockWebSocket.openCount).toBe(1);
    });
    expect(MockWebSocket.instances[0]?.url).toBe(
      "ws://127.0.0.1:7891/v1/events?token=dev-token",
    );

    const socket = MockWebSocket.instances[0];
    socket.onmessage?.({
      data: JSON.stringify({
        type: "scanner_health_changed",
        eventId: "h1",
        updatedAt: "2026-01-01T00:00:00Z",
        snapshot: {
          online: true,
          adapter: "serial_text",
          port: "COM4",
          level: "ok",
          code: "SCANNER_READY",
          message: "scanner ready",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      }),
    });
    socket.onmessage?.({
      data: JSON.stringify({
        type: "scanner_code",
        eventId: "e1",
        updatedAt: "2026-01-01T00:00:01Z",
        maskedCode: "6212****9012",
        source: "serial_text",
        scannedAtMs: 1,
      }),
    });
    socket.onmessage?.({
      data: JSON.stringify({
        type: "scanner_code",
        eventId: "e1",
        updatedAt: "2026-01-01T00:00:01Z",
        maskedCode: "6212****9012",
        source: "serial_text",
        scannedAtMs: 1,
      }),
    });

    expect(events).toEqual(["scanner_health_changed", "scanner_code"]);
    expect(onError).not.toHaveBeenCalled();
    subscription.close();
    socket.onmessage?.({
      data: JSON.stringify({
        type: "mqtt_changed",
        eventId: "e2",
        updatedAt: "2026",
        connected: true,
        lastError: null,
      }),
    });
    expect(events).toEqual(["scanner_health_changed", "scanner_code"]);
  });

  it("does not reconnect after close", async () => {
    vi.mocked(getDaemonConnectionInfo).mockResolvedValue({
      baseUrl: "http://127.0.0.1:7891",
      token: "dev-token",
      source: "browser_env",
      mock: true,
    });

    const subscription = daemonClient.subscribeEvents({
      onEvent: vi.fn(),
      onError: vi.fn(),
      onStale: vi.fn(),
    });

    await vi.waitFor(() => {
      expect(MockWebSocket.openCount).toBe(1);
    });
    const first = MockWebSocket.instances[0];
    subscription.close();
    first.onclose?.();

    expect(MockWebSocket.openCount).toBe(1);
  });
});
