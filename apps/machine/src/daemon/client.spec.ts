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
  daemonClient["seenEventIdQueue"].length = 0;
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

  it("reads maintenance enrollment diagnostics without private key material", async () => {
    vi.mocked(getDaemonConnectionInfo).mockResolvedValue({
      baseUrl: "http://127.0.0.1:7891",
      token: "token-1",
      source: "browser_env",
      mock: true,
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          state: "handshake_pending",
          publicKey: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
          tunnelAddress: "10.91.16.10/32",
          endpoint: "https://relay.example",
          handshakeVerified: false,
          lastHandshakeAt: null,
          lastError: "first WireGuard handshake has not been observed",
          updatedAt: "2026-07-10T00:00:00Z",
        }),
        { status: 200 },
      ),
    );

    const status = await daemonClient.getMaintenanceStatus();

    expect(status.state).toBe("handshake_pending");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:7891/v1/maintenance/status",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer token-1" }),
      }),
    );
    expect(JSON.stringify(status)).not.toContain("private");
  });

  it("sends an explicit rotation marker only for reclaim claims", async () => {
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

    await daemonClient.claimMachine("RECL-2345", {
      rotateMaintenanceIdentity: true,
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:7891/v1/provisioning/claim",
      expect.objectContaining({
        body: JSON.stringify({
          claimCode: "RECL-2345",
          rotateMaintenanceIdentity: true,
        }),
      }),
    );
  });

  it("loads bring-up snapshot through daemon IPC without secret fields", async () => {
    vi.mocked(getDaemonConnectionInfo).mockResolvedValue({
      baseUrl: "http://127.0.0.1:7891",
      token: "token-1",
      source: "browser_env",
      mock: true,
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          state: "claim_required",
          blockingReasons: [
            {
              code: "CLAIM_REQUIRED",
              component: "provisioning",
              message:
                "machine must be claimed before runtime profile can be applied",
            },
          ],
          diagnostics: [],
          readinessLevel: "not_ready",
          hardwareMode: "simulated",
          allowedActions: {
            configureNetwork: false,
            claimMachine: true,
            retryClaim: true,
            syncProfile: false,
            resolveTopology: false,
            runRuntimeAcceptance: false,
            runHardwareAcceptance: false,
            attestStock: false,
            startSales: false,
          },
          currentTask: {
            kind: "claim_machine",
            intent: "claim_machine",
          },
          progress: [
            {
              kind: "network",
              status: "revalidate",
              evidence: "volatile",
            },
            {
              kind: "provisioning",
              status: "current",
              evidence: "durable",
            },
          ],
          updatedAt: "2026-07-04T00:00:00Z",
        }),
        { status: 200 },
      ),
    );

    const result = await daemonClient.getBringUp();

    expect(result.state).toBe("claim_required");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:7891/v1/bring-up",
      expect.objectContaining({ method: "GET" }),
    );
    expect(JSON.stringify(result)).not.toContain("machineSecret");
  });

  it("applies Protected Network Settings through daemon IPC without retaining password", async () => {
    const submittedPassword = ["wifi", "secret"].join("-");
    vi.mocked(getDaemonConnectionInfo).mockResolvedValue({
      baseUrl: "http://127.0.0.1:7891",
      token: "token-1",
      source: "browser_env",
      mock: true,
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: "connected",
          ssid: "VEM-Lab",
          hidden: false,
          diagnostics: [
            {
              component: "local_network",
              level: "ok",
              code: "LOCAL_NETWORK_CONNECTED",
              message: "Wi-Fi association succeeded",
            },
          ],
          operatorGuidance: "网络已连接，可以继续领取机器。",
          updatedAt: "2026-07-04T00:00:00Z",
        }),
        { status: 200 },
      ),
    );

    const result = await daemonClient.applyNetworkSettings({
      ssid: "VEM-Lab",
      password: submittedPassword,
      hidden: false,
    });

    expect(result.status).toBe("connected");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:7891/v1/network/settings",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          ssid: "VEM-Lab",
          password: submittedPassword,
          hidden: false,
        }),
      }),
    );
    expect(JSON.stringify(result)).not.toContain(submittedPassword);
  });

  it("parses structured failed Protected Network Settings responses", async () => {
    const submittedPassword = ["wrong", "secret"].join("-");
    vi.mocked(getDaemonConnectionInfo).mockResolvedValue({
      baseUrl: "http://127.0.0.1:7891",
      token: "token-1",
      source: "browser_env",
      mock: true,
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: "failed",
          ssid: "VEM-Lab",
          hidden: false,
          diagnostics: [
            {
              component: "local_network",
              level: "error",
              code: "WIFI_AUTH_FAILED",
              message: "Wi-Fi password was rejected by the access point",
            },
            {
              component: "dhcp_ip",
              level: "unknown",
              code: "DHCP_IP_NOT_CHECKED",
              message:
                "DHCP/IP was not checked because Wi-Fi authentication failed",
            },
          ],
          operatorGuidance: "Wi-Fi 密码验证失败。请重新输入密码。",
          updatedAt: "2026-07-04T00:00:00Z",
        }),
        { status: 400 },
      ),
    );

    const result = await daemonClient.applyNetworkSettings({
      ssid: "VEM-Lab",
      password: submittedPassword,
      hidden: false,
    });

    expect(result.status).toBe("failed");
    expect(result.diagnostics.map((item) => item.code)).toContain(
      "WIFI_AUTH_FAILED",
    );
    expect(JSON.stringify(result)).not.toContain(submittedPassword);
  });

  it("parses structured unsupported Protected Network Settings responses", async () => {
    const submittedPassword = ["guest", "secret"].join("-");
    vi.mocked(getDaemonConnectionInfo).mockResolvedValue({
      baseUrl: "http://127.0.0.1:7891",
      token: "token-1",
      source: "browser_env",
      mock: true,
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: "unsupported",
          ssid: "Venue-Guest",
          hidden: false,
          diagnostics: [
            {
              component: "local_network",
              level: "warn",
              code: "INTERACTIVE_LOGIN_NETWORK_UNSUPPORTED",
              message:
                "Network appears to require captive portal or other interactive login",
            },
          ],
          operatorGuidance:
            "该网络需要网页登录、短信登录或其他交互式认证。请改用普通 WPA/WPA2 网络。",
          updatedAt: "2026-07-04T00:00:00Z",
        }),
        { status: 422 },
      ),
    );

    const result = await daemonClient.applyNetworkSettings({
      ssid: "Venue-Guest",
      password: submittedPassword,
      hidden: false,
    });

    expect(result.status).toBe("unsupported");
    expect(result.operatorGuidance).toContain("网页登录");
    expect(result.diagnostics.map((item) => item.code)).toContain(
      "INTERACTIVE_LOGIN_NETWORK_UNSUPPORTED",
    );
    expect(JSON.stringify(result)).not.toContain(submittedPassword);
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

  it("controls machine environment through daemon IPC", async () => {
    vi.mocked(getDaemonConnectionInfo).mockResolvedValue({
      baseUrl: "http://127.0.0.1:7891",
      token: "token-1",
      source: "browser_env",
      mock: true,
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          commandNo: "local-env-1",
          success: true,
          errorCode: null,
          message: "environment control completed",
          airConditionerOn: true,
          targetTemperatureCelsius: 24,
          reportedAt: "2026-07-01T07:00:00.000Z",
        }),
        { status: 200 },
      ),
    );

    const result = await daemonClient.controlEnvironment({
      airConditionerOn: true,
      targetTemperatureCelsius: 24,
      timeoutSeconds: 5,
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:7891/v1/environment/control",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          airConditionerOn: true,
          targetTemperatureCelsius: 24,
          timeoutSeconds: 5,
        }),
      }),
    );
    expect(result.airConditionerOn).toBe(true);
    expect(result.targetTemperatureCelsius).toBe(24);
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

  it("rejects current transaction responses that fail daemon IPC boundary semantics", async () => {
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
          paymentId: "550e8400-e29b-41d4-a716-446655440001",
          paymentNo: "PAY-001",
          paymentMethod: null,
          paymentProvider: "alipay",
          paymentUrl: "https://pay.example/qr",
          paymentStatus: "pending",
          orderStatus: "pending_payment",
          totalAmountCents: 100,
          vending: null,
          nextAction: "wait_payment",
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

    await expect(daemonClient.getCurrentTransaction()).rejects.toThrow(
      /awaiting-payment transaction snapshots must include paymentMethod/,
    );
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
          paymentId: "550e8400-e29b-41d4-a716-446655440002",
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

  it("records and ignores unknown daemon event notifications without interrupting the event stream", async () => {
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
    const onUnknownEvent = vi.fn();
    const onError = vi.fn();
    const subscription = daemonClient.subscribeEvents({
      onEvent,
      onUnknownEvent,
      onError,
      onStale: vi.fn(),
    });

    await vi.waitFor(() => {
      expect(MockWebSocket.openCount).toBe(1);
    });
    const socket = MockWebSocket.instances[0];
    socket.onmessage?.({
      data: JSON.stringify({
        type: "temperature_sensor_changed",
        eventId: "unknown-1",
        updatedAt: "2026-01-01T00:00:00Z",
        diagnostic: { status: "warm" },
      }),
    });
    socket.onmessage?.({
      data: JSON.stringify({
        type: "scanner_code",
        eventId: "scan-1",
        updatedAt: "2026-01-01T00:00:01Z",
        maskedCode: "6212****9012",
        source: "serial_text",
        scannedAtMs: 1,
      }),
    });

    expect(events).toEqual(["scanner_code"]);
    expect(onUnknownEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "temperature_sensor_changed",
        eventId: "unknown-1",
        known: false,
      }),
    );
    expect(onError).not.toHaveBeenCalled();
    subscription.close();
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

  it("bounds remembered event ids for long-running kiosks", async () => {
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
    const socket = MockWebSocket.instances[0];
    for (let index = 0; index < 1005; index += 1) {
      socket.onmessage?.({
        data: JSON.stringify({
          type: "ready_changed",
          eventId: `ready-${index}`,
          updatedAt: "2026-01-01T00:00:00Z",
          snapshot: {
            ready: true,
            canSell: true,
            mode: "sale",
            blockingCodes: [],
            blockingReasons: [],
            degradedReasons: [],
            suggestedRoute: "catalog",
            updatedAt: "2026-01-01T00:00:00Z",
          },
        }),
      });
    }

    expect(daemonClient["seenEventIds"].size).toBeLessThanOrEqual(1000);
    expect(daemonClient["seenEventIds"].has("ready-0")).toBe(false);
    expect(daemonClient["seenEventIds"].has("ready-1004")).toBe(true);
    subscription.close();
  });
});
