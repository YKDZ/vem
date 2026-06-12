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

  it("submits machine claim code through daemon IPC without extra deployment fields", async () => {
    vi.mocked(getDaemonConnectionInfo).mockResolvedValue({
      baseUrl: "http://127.0.0.1:7891",
      token: "token-1",
      source: "browser_env",
      mock: true,
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: "provisioned",
          machineCode: "M001",
          restartRequested: true,
          config: {
            public: {
              machineCode: "M001",
              apiBaseUrl: "http://localhost:3000/api",
              mqttUrl: "mqtt://localhost:1883",
              mqttUsername: null,
              hardwareAdapter: "mock",
              serialPortPath: null,
              lowerControllerUsbIdentity: null,
              scannerAdapter: "disabled",
              scannerSerialPortPath: null,
              scannerBaudRate: 9600,
              scannerFrameSuffix: "crlf",
              visionEnabled: true,
              visionWsUrl: "ws://127.0.0.1:7892/ws",
              visionRequestTimeoutMs: 8000,
              kioskMode: false,
              stockMovementRetentionDays: 30,
            },
            machineSecretConfigured: true,
            mqttSigningSecretConfigured: true,
            mqttPasswordConfigured: false,
            provisioned: true,
            provisioningIssues: [],
          },
        }),
        { status: 200 },
      ),
    );

    const result = await daemonClient.claimMachine("ABCD-2345");

    expect(result.status).toBe("provisioned");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:7891/v1/provisioning/claim",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ claimCode: "ABCD-2345" }),
      }),
    );
    const requestBody = vi.mocked(globalThis.fetch).mock.calls[0]?.[1]?.body;
    expect(typeof requestBody).toBe("string");
    expect(requestBody).not.toContain("machineSecret");
  });

  it("preserves safe daemon claim error codes for operator-state mapping", async () => {
    vi.mocked(getDaemonConnectionInfo).mockResolvedValue({
      baseUrl: "http://127.0.0.1:7891",
      token: "token-1",
      source: "browser_env",
      mock: true,
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: "machine_claim_expired",
          message: "claim ABCD-2345 expired with secret-value",
        }),
        { status: 400 },
      ),
    );

    await expect(daemonClient.claimMachine("ABCD-2345")).rejects.toMatchObject({
      statusCode: 400,
      responseCode: "machine_claim_expired",
      responseMessage: "claim ABCD-2345 expired with secret-value",
    });
  });

  it("surfaces daemon JSON error messages for failed create-order requests", async () => {
    vi.mocked(getDaemonConnectionInfo).mockResolvedValue({
      baseUrl: "http://127.0.0.1:7891",
      token: "token-1",
      source: "browser_env",
      mock: true,
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: "create_order_blocked",
          message: "selected payment provider is required for payment_code",
        }),
        { status: 400 },
      ),
    );

    await expect(daemonClient.createOrder({})).rejects.toMatchObject({
      message:
        "selected payment provider is required for payment_code (/v1/intents/create-order returned HTTP 400)",
      statusCode: 400,
      responseCode: "create_order_blocked",
      responseMessage: "selected payment provider is required for payment_code",
    });
  });

  it("posts cancel-order requests with the current order number", async () => {
    vi.mocked(getDaemonConnectionInfo).mockResolvedValue({
      baseUrl: "http://127.0.0.1:7891",
      token: "token-1",
      source: "browser_env",
      mock: true,
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          orderId: "order-1",
          orderNo: "ORD-001",
          productSummary: null,
          paymentNo: "PAY-001",
          paymentMethod: "qr_code",
          paymentProvider: "alipay",
          paymentUrl: null,
          paymentStatus: "canceled",
          orderStatus: "canceled",
          totalAmountCents: 1,
          vending: null,
          nextAction: "closed",
          maskedAuthCode: null,
          paymentCodeAttempt: null,
          expiresAt: null,
          errorCode: null,
          errorMessage: null,
          operatorHint: null,
          updatedAt: "2026-06-12T00:00:00.000Z",
        }),
        { status: 200 },
      ),
    );

    await expect(daemonClient.cancelOrder("ORD-001")).resolves.toMatchObject({
      orderNo: "ORD-001",
      nextAction: "closed",
    });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:7891/v1/intents/cancel-order",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ orderNo: "ORD-001" }),
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
