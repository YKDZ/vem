import type { EffectiveMachineRuntimeConfiguration } from "@vem/shared";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getDaemonConnectionInfo } from "@/native/daemon-connection";

import {
  DaemonApiClient,
  DaemonUnavailableError,
  isDaemonTransportFailure,
} from "./client";

vi.mock("@/native/daemon-connection", () => ({
  getDaemonConnectionInfo: vi.fn(),
}));

function configurationFixture(): EffectiveMachineRuntimeConfiguration {
  return {
    schemaVersion: 1,
    generation: 1,
    sourceRevisions: {
      bootstrapSchemaVersion: 1,
      profile: null,
      localSettingsRevision: 1,
    },
    sourceDocuments: {
      bootstrap: {
        schemaVersion: 1,
        provisioningApiBaseUrl: "https://platform.example/api",
        hardwareModel: "vem-prod-24",
        topology: { identity: "vem-prod-24", version: "v1" },
      },
      profileCache: null,
    },
    machine: null,
    platform: null,
    hardware: {
      model: "vem-prod-24",
      topology: { identity: "vem-prod-24", version: "v1" },
      expectedProfile: null,
      lowerControllerBinding: null,
      scannerBinding: null,
      scannerProtocol: null,
    },
    experience: {
      audio: {
        volume: 0.7,
        cuesEnabled: true,
        presenceCuesEnabled: true,
        transactionCuesEnabled: true,
      },
    },
    secretStatus: {
      machineSecretConfigured: true,
      mqttSigningSecretConfigured: true,
      mqttPasswordConfigured: true,
    },
    profileRefresh: { status: "unclaimed", lastError: null },
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function lastFetchRequest(): RequestInit {
  const calls = vi.mocked(globalThis.fetch).mock.calls;
  const request = calls[calls.length - 1]?.[1];
  if (!request) throw new Error("expected daemon fetch request");
  return request;
}

function healthFixture() {
  return {
    status: "healthy",
    process: {
      component: "daemon",
      level: "ok",
      code: "READY",
      message: "ready",
      updatedAt: "2026-07-17T00:00:00.000Z",
    },
    components: [],
    configConfigured: true,
    databaseOnline: true,
    backendOnline: true,
    mqttConnected: true,
    outboxSize: 0,
    outboxMax: 10,
    hardwareOnline: true,
    scannerOnline: true,
    visionOnline: true,
    remoteOpsActive: false,
    currentTransaction: null,
    operatorReason: "ready",
    updatedAt: "2026-07-17T00:00:00.000Z",
  };
}

function noCurrentTransaction() {
  return {
    orderId: null,
    orderNo: null,
    productSummary: null,
    paymentId: null,
    paymentNo: null,
    paymentMethod: null,
    paymentProvider: null,
    paymentUrl: null,
    paymentStatus: null,
    orderStatus: null,
    totalAmountCents: null,
    vending: null,
    nextAction: null,
    maskedAuthCode: null,
    paymentCodeAttempt: null,
    expiresAt: null,
    errorCode: null,
    errorMessage: null,
    operatorHint: null,
    updatedAt: "2026-07-17T00:00:00.000Z",
  };
}

function saleViewItem(overrides: Record<string, unknown> = {}) {
  return {
    machineCode: "M001",
    slotId: "550e8400-e29b-41d4-a716-446655440001",
    slotCode: "A1",
    layerNo: 1,
    cellNo: 1,
    inventoryId: "550e8400-e29b-41d4-a716-446655440002",
    variantId: "550e8400-e29b-41d4-a716-446655440003",
    productId: "550e8400-e29b-41d4-a716-446655440004",
    productName: "基础短袖",
    productDescription: null,
    coverImageUrl: null,
    tryOnSilhouetteUrl: null,
    categoryId: null,
    categoryName: "T恤",
    sku: "TEE-001",
    size: "M",
    color: "黑色",
    priceCents: 1000,
    productSortOrder: 1,
    targetGender: null,
    capacity: 8,
    parLevel: 6,
    physicalStock: 1,
    saleableStock: 1,
    slotSalesState: "sale_ready",
    ...overrides,
  };
}

class MockWebSocket {
  public onopen: ((event: Event) => void) | null = null;
  public onmessage: ((event: MessageEvent<string>) => void) | null = null;
  public onerror: (() => void) | null = null;
  public onclose: (() => void) | null = null;

  public static instances: MockWebSocket[] = [];

  constructor(readonly url: string) {
    MockWebSocket.instances.push(this);
    queueMicrotask(() => this.onopen?.(new Event("open")));
  }

  close(): void {
    this.onclose?.();
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  MockWebSocket.instances = [];
  vi.stubGlobal("WebSocket", MockWebSocket as unknown as typeof WebSocket);
  vi.mocked(getDaemonConnectionInfo).mockResolvedValue({
    baseUrl: "http://127.0.0.1:7891",
    token: "daemon-token",
    source: "browser_env",
    mock: true,
  });
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DaemonApiClient direct runtime intents", () => {
  it("reads the daemon-owned sale-start capability from its exact endpoint", async () => {
    const snapshot = {
      generation: "daemon-generation-2",
      revision: 19,
      observedAt: "2026-07-17T00:00:00.000Z",
      canStartSale: true,
      blockers: [],
      degradations: [],
      paymentOptions: {
        ready: true,
        defaultOptionKey: "qr_code:alipay",
        defaultProviderCode: "alipay",
        options: [
          {
            optionKey: "qr_code:alipay",
            providerCode: "alipay",
            method: "qr_code",
            displayName: "支付宝",
            description: "扫码支付",
            icon: "alipay",
            recommended: true,
            ready: true,
            disabledReason: null,
          },
        ],
      },
    };
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(jsonResponse(snapshot));

    await expect(
      new DaemonApiClient().getSaleStartCapability(),
    ).resolves.toEqual(snapshot);
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledWith(
      "http://127.0.0.1:7891/v1/sale-start-capability",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("reads the effective runtime snapshot without a maintenance credential", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      jsonResponse(configurationFixture()),
    );

    const configuration =
      await new DaemonApiClient().getEffectiveRuntimeConfiguration();

    expect(configuration.profileRefresh.status).toBe("unclaimed");
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledWith(
      "http://127.0.0.1:7891/v1/runtime-configuration",
      expect.objectContaining({
        headers: {
          Authorization: "Bearer daemon-token",
          "Content-Type": "application/json",
        },
      }),
    );
  });

  it("sends network setup as a narrow direct intent and preserves typed rejection guidance", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      jsonResponse(
        {
          status: "failed",
          ssid: "Venue-Wifi",
          hidden: false,
          diagnostics: [],
          operatorGuidance: "检查无线网络密码",
          updatedAt: "2026-07-17T00:00:00.000Z",
        },
        422,
      ),
    );

    const result = await new DaemonApiClient().applyNetworkSettings({
      ssid: "Venue-Wifi",
      password: "network-secret",
      hidden: false,
    });

    expect(result).toMatchObject({ status: "failed", ssid: "Venue-Wifi" });
    expect(lastFetchRequest()).toMatchObject({
      method: "POST",
      body: JSON.stringify({
        ssid: "Venue-Wifi",
        password: "network-secret",
        hidden: false,
      }),
      headers: {
        Authorization: "Bearer daemon-token",
        "Content-Type": "application/json",
      },
    });
  });

  it("claims directly with a normalized claim code", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      jsonResponse({
        status: "provisioned",
        machineCode: "MACHINE-001",
        restartRequested: false,
      }),
    );

    await expect(
      new DaemonApiClient().claimMachine("  claim-001  "),
    ).resolves.toMatchObject({
      machineCode: "MACHINE-001",
    });
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledWith(
      "http://127.0.0.1:7891/v1/provisioning/claim",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ claimCode: "CLAIM-001" }),
      }),
    );
  });

  it("recognizes only daemon transport failures as recoverable claim disconnects", () => {
    expect(
      isDaemonTransportFailure(
        new DaemonUnavailableError("daemon request failed", new TypeError()),
      ),
    ).toBe(true);
    expect(
      isDaemonTransportFailure(
        new DaemonUnavailableError("machine claim rejected", undefined, {
          statusCode: 422,
        }),
      ),
    ).toBe(false);
  });

  it("uses only runtime-configuration intents for binding, scanner protocol, and audio mutations", async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          binding: {
            identity: {
              identityKey: "container:11111111-2222-3333-4444-555555555555",
              instanceId: "USB\\VID_1234&PID_5678\\SCAN-001",
              containerId: "11111111-2222-3333-4444-555555555555",
              hardwareIds: ["USB\\VID_1234&PID_5678"],
              serialNumber: "SCAN-001",
            },
            confirmedAt: "2026-07-17T00:00:00.000Z",
            confirmedBy: "operator",
            testEvidenceCode: "SCANNER_READY",
          },
          currentPort: "COM7",
          ready: true,
          code: "DEVICE_BINDING_ACTIVATED",
          message: "bound",
          unrelatedRuntimeRestarted: false,
        }),
      )
      .mockResolvedValueOnce(jsonResponse(configurationFixture()))
      .mockResolvedValueOnce(jsonResponse(configurationFixture()))
      .mockResolvedValueOnce(jsonResponse(configurationFixture()));
    const client = new DaemonApiClient();

    await client.confirmDeviceBinding(
      "scanner",
      "container:scanner-001",
      "550e8400-e29b-41d4-a716-446655440099",
    );
    await client.clearDeviceBinding("scanner");
    await client.setScannerProtocolParameters({
      baudRate: 115200,
      frameSuffix: "lf",
    });
    await client.setAudioPreferences({
      volume: 0.35,
      cuesEnabled: true,
      presenceCuesEnabled: false,
      transactionCuesEnabled: true,
    });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:7891/v1/runtime-configuration/intents/hardware-bindings/scanner/confirm",
      "http://127.0.0.1:7891/v1/runtime-configuration/intents/hardware-bindings/scanner/clear",
      "http://127.0.0.1:7891/v1/runtime-configuration/intents/scanner-protocol-parameters",
      "http://127.0.0.1:7891/v1/runtime-configuration/intents/audio-preferences",
    ]);
    expect(fetchMock.mock.calls.map(([, options]) => options?.headers)).toEqual(
      [
        {
          Authorization: "Bearer daemon-token",
          "Content-Type": "application/json",
        },
        {
          Authorization: "Bearer daemon-token",
          "Content-Type": "application/json",
        },
        {
          Authorization: "Bearer daemon-token",
          "Content-Type": "application/json",
        },
        {
          Authorization: "Bearer daemon-token",
          "Content-Type": "application/json",
        },
      ],
    );
  });

  it("decodes health, Wi-Fi discovery, and the null transaction boundary from daemon IPC", async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock
      .mockResolvedValueOnce(jsonResponse(healthFixture()))
      .mockResolvedValueOnce(
        jsonResponse({
          status: "available",
          networks: [
            {
              ssid: "Venue-Wifi",
              signalQuality: 83,
              security: "wpa2_personal",
              connected: true,
              profileSaved: true,
            },
          ],
          operatorGuidance: "select a network",
          updatedAt: "2026-07-17T00:00:00.000Z",
        }),
      )
      .mockResolvedValueOnce(jsonResponse(noCurrentTransaction()));
    const client = new DaemonApiClient();

    await expect(client.getHealth()).resolves.toMatchObject({
      status: "healthy",
      process: { code: "READY" },
    });
    await expect(client.scanWifiNetworks()).resolves.toMatchObject({
      networks: [{ ssid: "Venue-Wifi", signalQuality: 83 }],
    });
    await expect(client.getCurrentTransaction()).resolves.toMatchObject({
      orderNo: null,
      nextAction: null,
    });
  });

  it("rejects malformed transaction snapshots at the shared IPC boundary", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      jsonResponse({ ...noCurrentTransaction(), orderNo: "ORD-1" }),
    );

    await expect(
      new DaemonApiClient().getCurrentTransaction(),
    ).rejects.toThrow();
  });

  it("preserves daemon JSON errors for direct customer intents", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      jsonResponse(
        {
          code: "payment_provider_unavailable",
          message: "payment provider unavailable",
        },
        422,
      ),
    );

    await expect(
      new DaemonApiClient().createOrder({ itemId: "item-1" }),
    ).rejects.toMatchObject({
      name: "DaemonUnavailableError",
      statusCode: 422,
      responseCode: "payment_provider_unavailable",
      responseMessage: "payment provider unavailable",
    });
  });

  it("bounds oversized rejected responses without parsing a partial daemon payload", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response("too large", {
        status: 500,
        headers: { "content-length": "65537" },
      }),
    );

    await expect(
      new DaemonApiClient().getEffectiveRuntimeConfiguration(),
    ).rejects.toBeInstanceOf(DaemonUnavailableError);
  });

  it("retries a daemon 401 once with a refreshed bearer token and no extra credential", async () => {
    vi.mocked(getDaemonConnectionInfo)
      .mockResolvedValueOnce({
        baseUrl: "http://127.0.0.1:7891",
        token: "expired-token",
        source: "browser_env",
        mock: true,
      })
      .mockResolvedValueOnce({
        baseUrl: "http://127.0.0.1:7891",
        token: "fresh-token",
        source: "browser_env",
        mock: true,
      });
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(jsonResponse({ message: "unauthorized" }, 401))
      .mockResolvedValueOnce(jsonResponse(configurationFixture()));

    await expect(
      new DaemonApiClient().getEffectiveRuntimeConfiguration(),
    ).resolves.toMatchObject({
      generation: 1,
    });
    expect(vi.mocked(globalThis.fetch)).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:7891/v1/runtime-configuration",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer fresh-token",
        }),
      }),
    );
  });

  it("does not misclassify malformed network rejections as safe operator guidance", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      jsonResponse(
        { code: "invalid_network", message: "invalid network" },
        422,
      ),
    );

    await expect(
      new DaemonApiClient().applyNetworkSettings({
        ssid: "Venue-Wifi",
        password: "network-secret",
        hidden: false,
      }),
    ).rejects.toMatchObject({
      responseCode: "invalid_network",
      statusCode: 422,
    });
  });

  it("keeps sale routing usable when malformed managed media is replaced with diagnostics", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      jsonResponse({
        items: [
          saleViewItem({
            coverImageUrl:
              "//untrusted.example/api/media-assets/550e8400-e29b-41d4-a716-446655440124/content",
          }),
          saleViewItem({
            slotId: "550e8400-e29b-41d4-a716-446655440011",
            inventoryId: "550e8400-e29b-41d4-a716-446655440012",
            productId: "550e8400-e29b-41d4-a716-446655440014",
            productName: "正常可售商品",
            sku: "SOCK-001",
          }),
        ],
        source: "local_stock",
        planogramVersion: "PLAN-1",
        lastUpdatedAt: "2026-07-14T00:00:00Z",
      }),
    );

    const snapshot = await new DaemonApiClient().getSaleView();

    expect(snapshot.items).toHaveLength(2);
    expect(snapshot.items[0]?.coverImageUrl).toBeNull();
    expect(snapshot.items[1]?.productName).toBe("正常可售商品");
    expect(snapshot.mediaDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          diagnosticKey:
            "media:550e8400-e29b-41d4-a716-446655440001:coverImageUrl:invalid://untrusted.example/api/media-assets/550e8400-e29b-41d4-a716-446655440124/content",
        }),
      ]),
    );
  });

  it("decodes maintenance status without exposing credential material", async () => {
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(
        jsonResponse({
          state: "handshake_pending",
          publicKey: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
          tunnelAddress: "10.91.16.10/32",
          endpoint: "https://relay.example",
          handshakeVerified: false,
          lastHandshakeAt: null,
          lastError: "first WireGuard handshake has not been observed",
          updatedAt: "2026-07-10T00:00:00Z",
        }),
      );
    const client = new DaemonApiClient();

    await expect(client.getMaintenanceStatus()).resolves.toMatchObject({
      state: "handshake_pending",
      publicKey: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
    });
  });

  it("posts customer cancellation with the current order number and validates its terminal snapshot", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      jsonResponse({
        ...noCurrentTransaction(),
        orderId: "order-1",
        orderNo: "ORD-001",
        paymentId: "550e8400-e29b-41d4-a716-446655440002",
        paymentNo: "PAY-001",
        paymentMethod: "qr_code",
        paymentProvider: "alipay",
        paymentStatus: "canceled",
        orderStatus: "canceled",
        totalAmountCents: 1,
        nextAction: "closed",
      }),
    );

    await expect(
      new DaemonApiClient().cancelOrder("ORD-001"),
    ).resolves.toMatchObject({
      orderNo: "ORD-001",
      nextAction: "closed",
    });
    expect(lastFetchRequest()).toMatchObject({
      method: "POST",
      body: JSON.stringify({ orderNo: "ORD-001" }),
    });
  });

  it("decodes known and unknown daemon events, deduplicates ids, and stops after close", async () => {
    vi.mocked(getDaemonConnectionInfo).mockResolvedValue({
      baseUrl: "http://127.0.0.1:7891",
      token: "event-token",
      source: "browser_env",
      mock: true,
    });
    const events: string[] = [];
    const onUnknownEvent = vi.fn();
    const client = new DaemonApiClient();
    const subscription = client.subscribeEvents({
      onEvent: (event) => events.push(event.type),
      onUnknownEvent,
      onError: vi.fn(),
      onStale: vi.fn(),
    });

    await vi.waitFor(() => {
      expect(MockWebSocket.instances).toHaveLength(1);
    });
    const socket = MockWebSocket.instances[0];
    if (!socket) throw new Error("event socket was not opened");
    expect(socket.url).toBe("ws://127.0.0.1:7891/v1/events?token=event-token");
    socket.onmessage?.({
      data: JSON.stringify({
        type: "scanner_code",
        eventId: "scan-1",
        updatedAt: "2026-01-01T00:00:01Z",
        maskedCode: "6212****9012",
        source: "serial_text",
        scannedAtMs: 1,
      }),
    } as MessageEvent<string>);
    socket.onmessage?.({
      data: JSON.stringify({
        type: "scanner_code",
        eventId: "scan-1",
        updatedAt: "2026-01-01T00:00:01Z",
        maskedCode: "6212****9012",
        source: "serial_text",
        scannedAtMs: 1,
      }),
    } as MessageEvent<string>);
    socket.onmessage?.({
      data: JSON.stringify({
        type: "temperature_sensor_changed",
        eventId: "unknown-1",
        updatedAt: "2026-01-01T00:00:02Z",
      }),
    } as MessageEvent<string>);

    expect(events).toEqual(["scanner_code"]);
    expect(onUnknownEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "temperature_sensor_changed",
        known: false,
      }),
    );
    subscription.close();
    socket.onmessage?.({
      data: JSON.stringify({
        type: "scanner_code",
        eventId: "scan-2",
        updatedAt: "2026-01-01T00:00:03Z",
        maskedCode: "6212****9013",
        source: "serial_text",
        scannedAtMs: 2,
      }),
    } as MessageEvent<string>);
    expect(events).toEqual(["scanner_code"]);
  });

  it("delivers one event id independently to concurrent subscribers", async () => {
    const client = new DaemonApiClient();
    const first = vi.fn();
    const second = vi.fn();
    const subscriptions = [
      client.subscribeEvents({
        onEvent: first,
        onError: vi.fn(),
        onStale: vi.fn(),
      }),
      client.subscribeEvents({
        onEvent: second,
        onError: vi.fn(),
        onStale: vi.fn(),
      }),
    ];
    await vi.waitFor(() => {
      expect(MockWebSocket.instances).toHaveLength(2);
    });
    const payload = JSON.stringify({
      type: "sale_start_capability_changed",
      eventId: "capability-event-2",
      updatedAt: "2026-07-17T00:00:02Z",
      generation: "daemon-a",
      revision: 2,
    });

    for (const socket of MockWebSocket.instances) {
      socket.onmessage?.({ data: payload } as MessageEvent<string>);
      socket.onmessage?.({ data: payload } as MessageEvent<string>);
    }

    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    for (const subscription of subscriptions) subscription.close();
  });

  it("signals runtime reconciliation only after a disconnected event stream opens again", async () => {
    vi.useFakeTimers();
    const onOpen = vi.fn();
    const onReconnect = vi.fn();
    const subscription = new DaemonApiClient().subscribeEvents({
      onEvent: vi.fn(),
      onError: vi.fn(),
      onStale: vi.fn(),
      onOpen,
      onReconnect,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(onOpen).toHaveBeenCalledWith({ reconnected: false });
    const firstSocket = MockWebSocket.instances[0];
    if (!firstSocket) throw new Error("initial event socket was not opened");
    firstSocket.onclose?.();
    expect(onReconnect).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);
    expect(MockWebSocket.instances).toHaveLength(2);
    expect(onOpen).toHaveBeenLastCalledWith({ reconnected: true });
    expect(onReconnect).toHaveBeenCalledOnce();
    subscription.close();
  });

  it("reconnects the original event subscription after a runtime reconfigure request", async () => {
    vi.useFakeTimers();
    const onEvent = vi.fn();
    const onStale = vi.fn();
    const onOpen = vi.fn();
    const onReconnect = vi.fn();
    const subscription = new DaemonApiClient().subscribeEvents({
      onEvent,
      onError: vi.fn(),
      onStale,
      onOpen,
      onReconnect,
    });

    await vi.advanceTimersByTimeAsync(0);
    const firstSocket = MockWebSocket.instances[0];
    if (!firstSocket) throw new Error("initial event socket was not opened");
    firstSocket.onmessage?.({
      data: JSON.stringify({
        type: "runtime_reconfigure_requested",
        eventId: "reconfigure-1",
        updatedAt: "2026-07-17T00:00:03Z",
        reason: "claim_completed",
        machineCode: "MACHINE-001",
      }),
    } as MessageEvent<string>);

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "runtime_reconfigure_requested" }),
    );
    expect(onStale).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(500);
    expect(MockWebSocket.instances).toHaveLength(2);
    expect(onOpen).toHaveBeenLastCalledWith({ reconnected: true });
    expect(onReconnect).toHaveBeenCalledOnce();
    subscription.close();
  });

  it("retries a failed forced connection refresh with bounded backoff", async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const subscription = new DaemonApiClient().subscribeEvents({
      onEvent: vi.fn(),
      onError,
      onStale: vi.fn(),
    });

    await vi.advanceTimersByTimeAsync(0);
    const firstSocket = MockWebSocket.instances[0];
    if (!firstSocket) throw new Error("initial event socket was not opened");
    vi.mocked(getDaemonConnectionInfo).mockRejectedValueOnce(
      new Error("daemon ready file unavailable"),
    );
    firstSocket.onclose?.();

    await vi.advanceTimersByTimeAsync(500);
    expect(onError).toHaveBeenCalled();
    expect(MockWebSocket.instances).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(MockWebSocket.instances).toHaveLength(2);
    subscription.close();
  });
});
