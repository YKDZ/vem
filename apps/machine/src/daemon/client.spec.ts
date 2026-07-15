import { beforeEach, describe, expect, it, vi } from "vitest";

import { getDaemonConnectionInfo } from "@/native/daemon-connection";

import { DaemonUnavailableError, daemonClient } from "./client";
import { networkSettingsResponseSchema } from "./schemas";

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
  daemonClient["maintenanceSession"] = null;
  daemonClient["maintenanceSessionRouteScope"] = null;
  if (daemonClient["maintenanceSessionExpiryTimer"] !== null) {
    globalThis.clearTimeout(daemonClient["maintenanceSessionExpiryTimer"]);
  }
  daemonClient["maintenanceSessionExpiryTimer"] = null;
  daemonClient["maintenanceSessionInvalidationListeners"].clear();
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

const configureNetworkTask: Parameters<
  typeof daemonClient.executeBringUpTask
>[0] = {
  contractVersion: 1,
  taskId: "bring_up.configure_network",
  taskVersion: 1,
  kind: "configure_network",
  intent: "refresh_network",
  rotateMaintenanceIdentity: false,
  projection: {
    type: "network_settings",
    supportsHiddenNetwork: true,
    supportsExistingNetworkProbe: true,
  },
};

async function executeProtectedNetworkTask(
  mutation:
    | {
        type: "configure_network";
        ssid: string;
        password: string;
        hidden: boolean;
      }
    | { type: "probe_network" },
) {
  return networkSettingsResponseSchema.parse(
    await daemonClient.executeBringUpTask(configureNetworkTask, mutation),
  );
}

describe("DaemonApiClient", () => {
  it("reads the safe runtime configuration summary instead of legacy config IPC", async () => {
    vi.mocked(getDaemonConnectionInfo).mockResolvedValue({
      baseUrl: "http://127.0.0.1:7891",
      token: "token-1",
      source: "browser_env",
      mock: true,
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          configuredState: {
            factoryManifest: true,
            localBringUpSettings: true,
            provisioningProfileCache: false,
            machineSecretConfigured: false,
            mqttSigningSecretConfigured: false,
            mqttPasswordConfigured: false,
            maintenancePinConfigured: false,
          },
          provisioningProfileCache: null,
          effectivePublic: {
            machineCode: null,
            apiBaseUrl: "http://127.0.0.1:26849/api",
            mqttUrl: "mqtt://127.0.0.1:1883",
            mqttUsername: null,
            hardwareAdapter: "mock",
            serialPortPath: null,
            scannerAdapter: "disabled",
            scannerSerialPortPath: null,
            scannerBaudRate: 9600,
            scannerFrameSuffix: "crlf",
            visionEnabled: false,
            visionWsUrl: "ws://127.0.0.1:7892/ws",
            visionRequestTimeoutMs: 8000,
            kioskMode: true,
          },
        }),
        { status: 200 },
      ),
    );

    await expect(daemonClient.getConfig()).resolves.toMatchObject({
      provisioned: false,
      provisioningIssues: [
        "provisioning_profile_cache_missing",
        "maintenance_pin_not_configured",
      ],
    });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:7891/v1/config/summary",
      expect.any(Object),
    );
  });

  it("never sends a mutable legacy configuration request", async () => {
    await expect(
      daemonClient.saveConfig({ machineCode: "M001" }),
    ).rejects.toThrow("直接配置编辑已禁用");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("issues a daemon-maintained scoped session and attaches its opaque id only to later IPC calls", async () => {
    vi.mocked(getDaemonConnectionInfo).mockResolvedValue({
      baseUrl: "http://127.0.0.1:7891",
      token: "token-1",
      source: "browser_env",
      mock: true,
    });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            sessionId: "opaque-session",
            expiresAt: "2030-07-14T12:00:00.000Z",
            scopes: ["maintenance.mutate"],
          }),
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(healthFixture()), { status: 200 }),
      );

    await daemonClient.beginMaintenanceSession("2468");
    await daemonClient.getHealth();

    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:7891/v1/maintenance/sessions",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          pin: "2468",
          scopes: [],
          operatorId: "front-panel",
        }),
      }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:7891/healthz",
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-vem-maintenance-session": "opaque-session",
        }),
      }),
    );
  });

  it("drops an expired maintenance session before a later IPC request", async () => {
    vi.mocked(getDaemonConnectionInfo).mockResolvedValue({
      baseUrl: "http://127.0.0.1:7891",
      token: "token-1",
      source: "browser_env",
      mock: true,
    });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            sessionId: "expired-session",
            expiresAt: "2020-01-01T00:00:00.000Z",
            scopes: ["maintenance.mutate"],
          }),
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(healthFixture()), { status: 200 }),
      );

    await daemonClient.beginMaintenanceSession("2468");
    await daemonClient.getHealth();

    expect(globalThis.fetch).toHaveBeenLastCalledWith(
      "http://127.0.0.1:7891/healthz",
      expect.objectContaining({
        headers: {
          Authorization: "Bearer token-1",
          "Content-Type": "application/json",
        },
      }),
    );
    expect(daemonClient.currentMaintenanceSession).toBeNull();
  });

  it("clears a route-scoped maintenance session at expiry without another IPC request", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-07-14T12:00:00.000Z"));
    try {
      vi.mocked(getDaemonConnectionInfo).mockResolvedValue({
        baseUrl: "http://127.0.0.1:7891",
        token: "token-1",
        source: "browser_env",
        mock: true,
      });
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            sessionId: "soon-expired-session",
            expiresAt: "2030-07-14T12:00:01.000Z",
            scopes: ["maintenance.mutate"],
          }),
          { status: 201 },
        ),
      );
      const invalidated = vi.fn();
      daemonClient.onMaintenanceSessionInvalidated(invalidated);

      await daemonClient.beginMaintenanceSession("2468");
      expect(daemonClient.handoffMaintenanceSessionToBringUp()).toBe(true);
      vi.advanceTimersByTime(1_000);

      expect(invalidated).toHaveBeenCalledOnce();
      expect(daemonClient.currentMaintenanceSession).toBeNull();
      expect(daemonClient.hasMaintenanceSessionForRoute("bring-up")).toBe(
        false,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears a maintenance session when the daemon rejects it", async () => {
    vi.mocked(getDaemonConnectionInfo).mockResolvedValue({
      baseUrl: "http://127.0.0.1:7891",
      token: "token-1",
      source: "browser_env",
      mock: true,
    });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            sessionId: "rejected-session",
            expiresAt: "2030-01-01T00:00:00.000Z",
            scopes: ["maintenance.mutate"],
          }),
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: "protected_maintenance_authorization_denied",
          }),
          {
            status: 403,
          },
        ),
      );

    await daemonClient.beginMaintenanceSession("2468");
    await expect(daemonClient.getHealth()).rejects.toThrow("HTTP 403");

    expect(daemonClient.currentMaintenanceSession).toBeNull();
  });

  it("passes the daemon-issued reclaim capability inside the typed bring-up mutation", async () => {
    vi.mocked(getDaemonConnectionInfo).mockResolvedValue({
      baseUrl: "http://127.0.0.1:7891",
      token: "token-1",
      source: "browser_env",
      mock: true,
    });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            sessionId: "reclaim-session",
            expiresAt: "2030-07-14T12:00:00.000Z",
            scopes: ["maintenance.mutate", "maintenance.reclaim"],
          }),
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));

    await daemonClient.beginMaintenanceSession("2468", ["maintenance.reclaim"]);
    await daemonClient.executeBringUpTask(
      {
        contractVersion: 1,
        taskId: "bring_up.reclaim_machine",
        taskVersion: 1,
        kind: "reclaim_machine",
        intent: "reclaim_machine",
        rotateMaintenanceIdentity: true,
        projection: { type: "claim_code", rotateMaintenanceIdentity: true },
      },
      { type: "claim_machine", claimCode: "RECLAIM-1" },
    );

    expect(globalThis.fetch).toHaveBeenLastCalledWith(
      "http://127.0.0.1:7891/v1/bring-up/tasks/execute",
      expect.objectContaining({
        body: expect.stringContaining(
          '"maintenanceAuthorization":{"sessionId":"reclaim-session"}',
        ),
      }),
    );
  });

  it("hands a maintenance capability to Bring-Up and sends it with each protected task", async () => {
    vi.mocked(getDaemonConnectionInfo).mockResolvedValue({
      baseUrl: "http://127.0.0.1:7891",
      token: "token-1",
      source: "browser_env",
      mock: true,
    });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            sessionId: "route-scoped-session",
            expiresAt: "2030-07-14T12:00:00.000Z",
            scopes: ["maintenance.mutate"],
          }),
          { status: 201 },
        ),
      )
      .mockImplementation(() =>
        Promise.resolve(new Response("{}", { status: 200 })),
      );

    await daemonClient.beginMaintenanceSession("2468");
    expect(daemonClient.handoffMaintenanceSessionToBringUp()).toBe(true);
    expect(daemonClient.hasMaintenanceSessionForRoute("bring-up")).toBe(true);

    await daemonClient.executeBringUpTask(
      {
        contractVersion: 1,
        taskId: "bring_up.configure_network",
        taskVersion: 1,
        kind: "configure_network",
        intent: "refresh_network",
        rotateMaintenanceIdentity: false,
        projection: {
          type: "network_settings",
          supportsHiddenNetwork: true,
          supportsExistingNetworkProbe: true,
        },
      },
      {
        type: "configure_network",
        ssid: "Store-WiFi",
        password: "secret-pass",
        hidden: false,
      },
    );
    await daemonClient.executeBringUpTask(
      {
        contractVersion: 1,
        taskId: "bring_up.claim_machine",
        taskVersion: 1,
        kind: "claim_machine",
        intent: "claim_machine",
        rotateMaintenanceIdentity: false,
        projection: { type: "claim_code", rotateMaintenanceIdentity: false },
      },
      { type: "claim_machine", claimCode: "ABCD-2345" },
    );
    await daemonClient.executeBringUpTask(
      {
        contractVersion: 1,
        taskId: "bring_up.attest_stock",
        taskVersion: 1,
        kind: "attest_stock",
        intent: "record_stock",
        rotateMaintenanceIdentity: false,
        projection: {
          type: "stock_attestation",
          entryMode: "final_actual_quantities",
        },
      },
      {
        type: "record_stock",
        attestation: { planogramVersion: "PLAN-1", slots: [] },
      },
    );

    const taskCalls = vi
      .mocked(globalThis.fetch)
      .mock.calls.slice(1)
      .map(([, options]) => options);
    expect(taskCalls).toHaveLength(3);
    for (const options of taskCalls) {
      expect(options).toEqual(
        expect.objectContaining({
          headers: expect.objectContaining({
            "x-vem-maintenance-session": "route-scoped-session",
          }),
        }),
      );
    }

    daemonClient.releaseMaintenanceSessionRoute("bring-up");
    expect(daemonClient.currentMaintenanceSession).toBeNull();
  });

  it("continues an explicit protected Bring-Up flow back to maintenance", async () => {
    vi.mocked(getDaemonConnectionInfo).mockResolvedValue({
      baseUrl: "http://127.0.0.1:7891",
      token: "token-1",
      source: "browser_env",
      mock: true,
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          sessionId: "continued-session",
          expiresAt: "2030-07-14T12:00:00.000Z",
          scopes: ["maintenance.mutate"],
        }),
        { status: 201 },
      ),
    );

    await daemonClient.beginMaintenanceSession("2468");
    expect(daemonClient.handoffMaintenanceSessionToBringUp()).toBe(true);
    expect(daemonClient.handoffMaintenanceSessionToMaintenance()).toBe(true);
    expect(daemonClient.getMaintenanceSessionForRoute("maintenance")).toEqual(
      expect.objectContaining({ sessionId: "continued-session" }),
    );
    daemonClient.releaseMaintenanceSessionRoute("bring-up");
    expect(daemonClient.currentMaintenanceSession).not.toBeNull();
    daemonClient.releaseMaintenanceSessionRoute("maintenance");
    expect(daemonClient.currentMaintenanceSession).toBeNull();
  });

  it("keeps catalog usable when missing, empty, or invalid media is cleaned to placeholders", async () => {
    vi.mocked(getDaemonConnectionInfo).mockResolvedValue({
      baseUrl: "http://127.0.0.1:7891",
      token: "token-1",
      source: "browser_env",
      mock: true,
    });
    const item = (overrides: Record<string, unknown> = {}) => ({
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
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          items: [
            item({ coverImageUrl: null }),
            item({
              slotId: "550e8400-e29b-41d4-a716-446655440011",
              inventoryId: "550e8400-e29b-41d4-a716-446655440012",
              productId: "550e8400-e29b-41d4-a716-446655440014",
              coverImageUrl: "",
            }),
          ],
          source: "local_stock",
          planogramVersion: "PLAN-1",
          lastUpdatedAt: "2026-07-14T00:00:00Z",
        }),
        { status: 200 },
      ),
    );

    const snapshot = await daemonClient.getSaleView();

    expect(snapshot.items).toHaveLength(2);
    expect(
      snapshot.items.map((catalogItem) => catalogItem.coverImageUrl),
    ).toEqual([null, null]);
    expect(snapshot.mediaDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reference: null,
          diagnosticKey:
            "media:550e8400-e29b-41d4-a716-446655440001:coverImageUrl:missing",
          message:
            "daemon sale view contained no coverImageUrl managed media reference",
        }),
        expect.objectContaining({
          reference: "",
          diagnosticKey:
            "media:550e8400-e29b-41d4-a716-446655440011:coverImageUrl:invalid:empty",
          message:
            "daemon sale view contained an invalid coverImageUrl managed media reference",
        }),
      ]),
    );
  });

  it("keeps valid sale-view items when one item has malformed managed media", async () => {
    vi.mocked(getDaemonConnectionInfo).mockResolvedValue({
      baseUrl: "http://127.0.0.1:7891",
      token: "token-1",
      source: "browser_env",
      mock: true,
    });
    const item = (overrides: Record<string, unknown> = {}) => ({
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
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          items: [
            item({
              coverImageUrl:
                "//untrusted.example/api/media-assets/550e8400-e29b-41d4-a716-446655440124/content",
            }),
            item({
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
        { status: 200 },
      ),
    );

    const snapshot = await daemonClient.getSaleView();

    expect(snapshot.items).toHaveLength(2);
    expect(snapshot.items[0]?.coverImageUrl).toBeNull();
    expect(snapshot.items[1]?.productName).toBe("正常可售商品");
    expect(snapshot.mediaDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reference:
            "//untrusted.example/api/media-assets/550e8400-e29b-41d4-a716-446655440124/content",
        }),
      ]),
    );
  });

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

  it("submits the planogram-driven stock task with only the daemon task and recognizable slots", async () => {
    vi.mocked(getDaemonConnectionInfo).mockResolvedValue({
      baseUrl: "http://127.0.0.1:7891",
      token: "token-1",
      source: "browser_env",
      mock: true,
    });
    const task = {
      taskId: "stock-task-01",
      mode: "routine_refill" as const,
      status: "ready" as const,
      slots: [
        {
          slotCode: "A1",
          layerNo: 1,
          cellNo: 1,
          productName: "Water",
          sku: "WATER-1",
          capacity: 8,
          currentQuantity: 2,
          submittedQuantity: null,
          syncStatus: "not_submitted" as const,
          salesState: "sale_ready",
          reconciliationReason: null,
        },
      ],
    };
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            sessionId: "maintenance-session-1",
            expiresAt: "2030-07-15T00:00:00.000Z",
            scopes: ["maintenance.mutate"],
          }),
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ task, duplicate: false }), {
          status: 201,
        }),
      );
    await daemonClient.beginMaintenanceSession("2468");

    await daemonClient.submitStockMaintenanceBatch({
      taskId: task.taskId,
      mode: "routine_refill",
      slots: [{ slotCode: "A1", addition: 2 }],
    });

    expect(globalThis.fetch).toHaveBeenLastCalledWith(
      "http://127.0.0.1:7891/v1/stock/maintenance-task",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer token-1",
          "x-vem-maintenance-session": "maintenance-session-1",
        }),
        body: JSON.stringify({
          taskId: "stock-task-01",
          mode: "routine_refill",
          slots: [{ slotCode: "A1", addition: 2 }],
        }),
      }),
    );
  });

  it("types a rejected maintenance stock movement as a definite 4xx daemon response", async () => {
    vi.mocked(getDaemonConnectionInfo).mockResolvedValue({
      baseUrl: "http://127.0.0.1:7891",
      token: "token-1",
      source: "browser_env",
      mock: true,
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: "stock_movement_record_failed",
          message: "movement exceeds capacity",
        }),
        { status: 400 },
      ),
    );

    await expect(daemonClient.recordStockMovement({})).rejects.toMatchObject({
      name: "DaemonUnavailableError",
      statusCode: 400,
      responseCode: "stock_movement_record_failed",
      responseMessage: "movement exceeds capacity",
    });
  });

  it("does not expose legacy direct claim, network, or mutable config clients", async () => {
    expect(daemonClient).not.toHaveProperty("claimMachine");
    expect(daemonClient).not.toHaveProperty("applyNetworkSettings");
    await expect(
      daemonClient.saveConfig({ machineCode: "M001" }),
    ).rejects.toThrow("直接配置编辑已禁用");
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
            contractVersion: 1,
            taskId: "bring_up.claim_machine",
            taskVersion: 1,
            kind: "claim_machine",
            intent: "claim_machine",
            rotateMaintenanceIdentity: false,
            projection: {
              type: "claim_code",
              rotateMaintenanceIdentity: false,
            },
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

    const result = await executeProtectedNetworkTask({
      type: "configure_network",
      ssid: "VEM-Lab",
      password: submittedPassword,
      hidden: false,
    });

    expect(result.status).toBe("connected");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:7891/v1/bring-up/tasks/execute",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          contractVersion: 1,
          taskId: "bring_up.configure_network",
          taskVersion: 1,
          kind: "configure_network",
          intent: "refresh_network",
          mutation: {
            type: "configure_network",
            ssid: "VEM-Lab",
            password: submittedPassword,
            hidden: false,
          },
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

    const result = await executeProtectedNetworkTask({
      type: "configure_network",
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

  it("preserves typed network evidence when an authorized Bring-Up task is rejected", async () => {
    vi.mocked(getDaemonConnectionInfo).mockResolvedValue({
      baseUrl: "http://127.0.0.1:7891",
      token: "token-1",
      source: "browser_env",
      mock: true,
    });
    const diagnostics = [
      ["local_adapter", "local_adapter", "ready", "LOCAL_ADAPTER_READY"],
      ["local_address", "local_address", "ready", "LOCAL_ADDRESS_READY"],
      [
        "local_default_route",
        "local_default_route",
        "failed",
        "LOCAL_DEFAULT_ROUTE_UNAVAILABLE",
      ],
      [
        "provisioning_endpoint",
        "platform_api",
        "failed",
        "PRECLAIM_PLATFORM_ENDPOINT_UNREACHABLE",
      ],
      ["mqtt", "mqtt_broker", "not_configured", "MQTT_BROKER_NOT_PROVISIONED"],
    ].map(([component, source, status, code]) => ({
      component,
      level: "error",
      code,
      message: `${code} diagnostic for the operator`,
      evidence: {
        source,
        status,
        reasonCode: code,
        reason: `${code} diagnostic for the operator`,
        recoveryAction: "Follow the operator guidance and retry.",
      },
    }));
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            sessionId: "network-session",
            expiresAt: "2030-07-14T12:00:00.000Z",
            scopes: ["maintenance.mutate"],
          }),
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "failed",
            ssid: "Store-WiFi",
            hidden: false,
            diagnostics,
            operatorGuidance: "请检查本机网络和平台连接。",
            updatedAt: "2026-07-14T00:00:00Z",
          }),
          { status: 422 },
        ),
      );

    await daemonClient.beginMaintenanceSession("2468");
    expect(daemonClient.handoffMaintenanceSessionToBringUp()).toBe(true);

    const result = await executeProtectedNetworkTask({
      type: "configure_network",
      ssid: "Store-WiFi",
      password: "correct-password",
      hidden: false,
    });

    expect(result.diagnostics.map((item) => item.code)).toEqual([
      "LOCAL_ADAPTER_READY",
      "LOCAL_ADDRESS_READY",
      "LOCAL_DEFAULT_ROUTE_UNAVAILABLE",
      "PRECLAIM_PLATFORM_ENDPOINT_UNREACHABLE",
      "MQTT_BROKER_NOT_PROVISIONED",
    ]);
    expect(result.diagnostics.map((item) => item.evidence?.source)).toEqual([
      "local_adapter",
      "local_address",
      "local_default_route",
      "platform_api",
      "mqtt_broker",
    ]);
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:7891/v1/bring-up/tasks/execute",
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-vem-maintenance-session": "network-session",
        }),
      }),
    );
  });

  it("safely falls back when a rejected daemon response exceeds the read limit", async () => {
    vi.mocked(getDaemonConnectionInfo).mockResolvedValue({
      baseUrl: "http://127.0.0.1:7891",
      token: "token-1",
      source: "browser_env",
      mock: true,
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("x".repeat(64 * 1024 + 1), { status: 422 }),
    );

    await expect(
      executeProtectedNetworkTask({
        type: "configure_network",
        ssid: "Store-WiFi",
        password: "correct-password",
        hidden: false,
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: "DaemonUnavailableError",
        statusCode: 422,
        responseBody: undefined,
      } satisfies Partial<DaemonUnavailableError>),
    );
  });

  it("preserves a rejected cursor network response instead of resolving a failed mock", async () => {
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
          ssid: "Store-WiFi",
          hidden: false,
          diagnostics: [
            {
              component: "local_default_route",
              level: "error",
              code: "LOCAL_DEFAULT_ROUTE_UNAVAILABLE",
              message: "No default route on the selected Wi-Fi adapter",
              evidence: {
                source: "local_default_route",
                status: "failed",
                reasonCode: "LOCAL_DEFAULT_ROUTE_UNAVAILABLE",
                reason: "No default route on the selected Wi-Fi adapter",
                recoveryAction: "Check the DHCP gateway option.",
              },
            },
            {
              component: "provisioning_endpoint",
              level: "error",
              code: "PRECLAIM_PLATFORM_ENDPOINT_UNREACHABLE",
              message: "Platform API unavailable",
              evidence: {
                source: "platform_api",
                status: "failed",
                reasonCode: "PRECLAIM_PLATFORM_ENDPOINT_UNREACHABLE",
                reason: "Platform API unavailable",
                recoveryAction: "Check Platform API availability.",
              },
            },
            {
              component: "mqtt",
              level: "unknown",
              code: "MQTT_BROKER_NOT_PROVISIONED",
              message: "No machine MQTT broker before claim",
              evidence: {
                source: "mqtt_broker",
                status: "not_configured",
                reasonCode: "MQTT_BROKER_NOT_PROVISIONED",
                reason: "No machine MQTT broker before claim",
                recoveryAction: "Complete claim first.",
              },
            },
          ],
          operatorGuidance: "请检查本机路由和平台 API。",
          updatedAt: "2026-07-04T00:00:00Z",
        }),
        { status: 422 },
      ),
    );

    const result = await daemonClient.executeBringUpTask(
      {
        contractVersion: 1,
        taskId: "configure-network",
        taskVersion: 1,
        kind: "configure_network",
        intent: "refresh_network",
        rotateMaintenanceIdentity: false,
        projection: {
          type: "network_settings",
          supportsHiddenNetwork: true,
          supportsExistingNetworkProbe: true,
        },
      },
      { type: "probe_network" },
    );

    expect(result).toMatchObject({
      status: "failed",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          evidence: expect.objectContaining({ source: "local_default_route" }),
        }),
        expect.objectContaining({
          evidence: expect.objectContaining({ source: "platform_api" }),
        }),
        expect.objectContaining({
          evidence: expect.objectContaining({ source: "mqtt_broker" }),
        }),
      ]),
    });
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

    const result = await executeProtectedNetworkTask({
      type: "configure_network",
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

    await expect(
      daemonClient.executeBringUpTask(
        {
          contractVersion: 1,
          taskId: "bring_up.claim_machine",
          taskVersion: 1,
          kind: "claim_machine",
          intent: "claim_machine",
          rotateMaintenanceIdentity: false,
          projection: {
            type: "claim_code",
            rotateMaintenanceIdentity: false,
          },
        },
        { type: "claim_machine", claimCode: "ABCD-2345" },
      ),
    ).rejects.toMatchObject({
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

  it("clears and notifies the UI about a maintenance session before retrying a daemon 401", async () => {
    vi.mocked(getDaemonConnectionInfo).mockResolvedValue({
      baseUrl: "http://127.0.0.1:7891",
      token: "token-1",
      source: "browser_env",
      mock: true,
    });
    const invalidated = vi.fn();
    daemonClient.onMaintenanceSessionInvalidated(invalidated);
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            sessionId: "restart-session",
            expiresAt: "2030-07-14T12:00:00.000Z",
            scopes: ["maintenance.mutate"],
          }),
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(new Response("no", { status: 401 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(healthFixture()), { status: 200 }),
      );

    await daemonClient.beginMaintenanceSession("2468");
    await daemonClient.getHealth();

    expect(daemonClient.currentMaintenanceSession).toBeNull();
    expect(invalidated).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).toHaveBeenLastCalledWith(
      "http://127.0.0.1:7891/healthz",
      expect.objectContaining({
        headers: {
          Authorization: "Bearer token-1",
          "Content-Type": "application/json",
        },
      }),
    );
  });

  it("clears and notifies the UI when the daemon event stream closes", async () => {
    vi.mocked(getDaemonConnectionInfo).mockResolvedValue({
      baseUrl: "http://127.0.0.1:7891",
      token: "token-1",
      source: "browser_env",
      mock: true,
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          sessionId: "event-session",
          expiresAt: "2030-07-14T12:00:00.000Z",
          scopes: ["maintenance.mutate"],
        }),
        { status: 201 },
      ),
    );
    const invalidated = vi.fn();
    const onStale = vi.fn();
    daemonClient.onMaintenanceSessionInvalidated(invalidated);
    await daemonClient.beginMaintenanceSession("2468");
    const subscription = daemonClient.subscribeEvents({
      onEvent: vi.fn(),
      onError: vi.fn(),
      onStale,
    });

    await vi.waitFor(() => {
      expect(MockWebSocket.openCount).toBe(1);
    });
    MockWebSocket.instances[0]?.onclose?.();

    expect(daemonClient.currentMaintenanceSession).toBeNull();
    expect(invalidated).toHaveBeenCalledTimes(1);
    expect(onStale).toHaveBeenCalledTimes(1);
    subscription.close();
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
