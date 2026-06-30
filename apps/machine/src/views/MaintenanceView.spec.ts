// @vitest-environment jsdom
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";

import type { ConfigSummary } from "@/daemon/schemas";

const {
  routeMock,
  routerReplaceMock,
  initializeMock,
  getHealthMock,
  getReadyMock,
  getSyncStatusMock,
  getScannerStatusMock,
  getVisionStatusMock,
  getRemoteOpsStatusMock,
  getSaleViewMock,
  recordStockMovementMock,
  clearWholeMachineMaintenanceLockMock,
  runHardwareSelfCheckMock,
  getConfigMock,
  saveConfigMock,
  downloadLogExportMock,
  callTauriCommandMock,
} = vi.hoisted(() => ({
  routeMock: { query: {} as Record<string, unknown> },
  routerReplaceMock: vi.fn(),
  initializeMock: vi.fn(),
  getHealthMock: vi.fn(),
  getReadyMock: vi.fn(),
  getSyncStatusMock: vi.fn(),
  getScannerStatusMock: vi.fn(),
  getVisionStatusMock: vi.fn(),
  getRemoteOpsStatusMock: vi.fn(),
  getSaleViewMock: vi.fn(),
  recordStockMovementMock: vi.fn(),
  clearWholeMachineMaintenanceLockMock: vi.fn(),
  runHardwareSelfCheckMock: vi.fn(),
  getConfigMock: vi.fn(),
  saveConfigMock: vi.fn(),
  downloadLogExportMock: vi.fn(),
  callTauriCommandMock: vi.fn(),
}));

vi.mock("vue-router", () => ({
  useRoute: () => routeMock,
  useRouter: () => ({ replace: routerReplaceMock }),
}));

vi.mock("@/layouts/KioskLayout.vue", () => ({
  default: { template: "<main><slot /></main>" },
}));

vi.mock("@/components/MockHardwareControls.vue", () => ({
  default: { template: "<div>MockHardwareControls</div>" },
}));

vi.mock("@/daemon/client", () => ({
  daemonClient: {
    initialize: initializeMock,
    getHealth: getHealthMock,
    getReady: getReadyMock,
    getSyncStatus: getSyncStatusMock,
    getScannerStatus: getScannerStatusMock,
    getVisionStatus: getVisionStatusMock,
    getRemoteOpsStatus: getRemoteOpsStatusMock,
    getSaleView: getSaleViewMock,
    recordStockMovement: recordStockMovementMock,
    clearWholeMachineMaintenanceLock: clearWholeMachineMaintenanceLockMock,
    runHardwareSelfCheck: runHardwareSelfCheckMock,
    getConfig: getConfigMock,
    saveConfig: saveConfigMock,
    downloadLogExport: downloadLogExportMock,
  },
}));

vi.mock("@/native/tauri", () => ({
  isTauriRuntime: () => true,
  callTauriCommand: callTauriCommandMock,
}));

import { useAudioCueStore } from "@/stores/audio-cues";
import { useCatalogStore } from "@/stores/catalog";
import { useMachineStore } from "@/stores/machine";
import { useVisionStore } from "@/stores/vision";

import MaintenanceView from "./MaintenanceView.vue";

let mountedApp: App<Element> | null = null;
let pinia: ReturnType<typeof createPinia>;

function saleViewFixture() {
  return {
    items: [
      {
        machineCode: "M001",
        slotId: "550e8400-e29b-41d4-a716-446655440001",
        slotCode: "A1",
        layerNo: 1,
        cellNo: 1,
        inventoryId: "550e8400-e29b-41d4-a716-446655440002",
        variantId: "550e8400-e29b-41d4-a716-446655440003",
        productId: "550e8400-e29b-41d4-a716-446655440004",
        productName: "Mineral Water",
        productDescription: null,
        coverImageUrl: null,
        categoryId: null,
        categoryName: null,
        sku: "WATER-001",
        size: null,
        color: null,
        priceCents: 100,
        capacity: 8,
        parLevel: 6,
        physicalStock: 2,
        saleableStock: 2,
        slotSalesState: "sale_ready",
        productSortOrder: 1,
        targetGender: null,
      },
    ],
    source: "local_stock",
    planogramVersion: "PLAN-1",
    lastUpdatedAt: "2026-06-05T00:00:00.000Z",
  };
}

function healthFixture() {
  return {
    status: "healthy",
    process: {
      component: "process",
      level: "ok",
      code: "PROCESS_READY",
      message: "daemon ready",
      updatedAt: "2026-06-05T00:00:00.000Z",
    },
    components: [
      {
        component: "backend",
        level: "ok",
        code: "BACKEND_READY",
        message: "backend reachable",
        updatedAt: "2026-06-05T00:00:00.000Z",
      },
    ],
    configConfigured: true,
    databaseOnline: true,
    backendOnline: true,
    mqttConnected: true,
    outboxSize: 1,
    outboxMax: 1000,
    hardwareOnline: true,
    scannerOnline: true,
    visionOnline: true,
    remoteOpsActive: false,
    currentTransaction: null,
    operatorReason: "",
    updatedAt: "2026-06-05T00:00:00.000Z",
  };
}

function readyFixture() {
  return {
    ready: true,
    canSell: true,
    mode: "catalog",
    blockingCodes: [],
    blockingReasons: [],
    degradedReasons: [],
    suggestedRoute: "catalog",
    updatedAt: "2026-06-05T00:00:00.000Z",
  };
}

function maintenanceReadyFixture() {
  return {
    ...readyFixture(),
    ready: false,
    canSell: false,
    mode: "maintenance",
    blockingCodes: ["LOWER_CONTROLLER_UNAVAILABLE"],
    blockingReasons: [
      {
        code: "LOWER_CONTROLLER_UNAVAILABLE",
        component: "hardware",
        message: "lower controller unavailable",
      },
    ],
    suggestedRoute: "maintenance",
  };
}

function provisionedConfigSummary(): ConfigSummary {
  return {
    public: {
      machineCode: "SECRET-MACHINE-CODE",
      machineLocationLabel: "E2E lab",
      apiBaseUrl: "https://api.secret.example/v1",
      mqttUrl: "mqtt://secret-broker.example:1883",
      mqttUsername: "secret-mqtt-user",
      hardwareAdapter: "mock",
      serialPortPath: null,
      lowerControllerUsbIdentity: {
        vendorId: "1A86",
        productId: "55D3",
        serialNumber: "SECRET-SERIAL",
      },
      scannerAdapter: "serial_text",
      scannerSerialPortPath: "/dev/secret-scanner",
      scannerBaudRate: 9600,
      scannerFrameSuffix: "crlf",
      visionEnabled: true,
      visionWsUrl: "ws://secret-vision.example/ws",
      visionRequestTimeoutMs: 8000,
      audioCueSettings: {
        enabled: false,
        categories: {
          presence: false,
          transaction: false,
        },
      },
      kioskMode: true,
      stockMovementRetentionDays: 30,
    },
    machineSecretConfigured: true,
    mqttSigningSecretConfigured: true,
    mqttPasswordConfigured: true,
    provisioned: true,
    provisioningIssues: [],
  };
}

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  vi.clearAllMocks();
  routeMock.query = { source: "operator" };
  initializeMock.mockResolvedValue({
    baseUrl: "http://127.0.0.1:7891",
    token: "token-1",
    source: "browser_env",
    mock: true,
    runtimeFlags: {
      advancedMaintenanceConfig: false,
    },
  });
  getHealthMock.mockResolvedValue(healthFixture());
  getReadyMock.mockResolvedValue(readyFixture());
  getSyncStatusMock.mockResolvedValue({
    mqttRunning: true,
    mqttConnected: true,
    brokerUrlMasked: "mqtt://broker.example:1883",
    lastHeartbeatAt: "2026-06-05T00:00:00.000Z",
    lastCommandNo: "CMD-1",
    outboxSize: 1,
    outboxMax: 1000,
    outboxUsage: 0.001,
    nextRetryAt: null,
    lastError: null,
    tlsAuthStatus: "configured",
  });
  getScannerStatusMock.mockResolvedValue({
    online: true,
    adapter: "serial_text",
    port: "/dev/ttyUSB1",
    level: "ok",
    code: "SCANNER_READY",
    message: "scanner ready",
    updatedAt: "2026-06-05T00:00:00.000Z",
  });
  getVisionStatusMock.mockResolvedValue({
    enabled: true,
    online: true,
    message: "vision ready",
    updatedAt: "2026-06-05T00:00:00.000Z",
    latestDiagnosticPayload: null,
  });
  getRemoteOpsStatusMock.mockResolvedValue({
    lastPolledAt: "2026-06-05T00:00:00.000Z",
    pending: 0,
    lastError: null,
    processing: null,
  });
  getSaleViewMock.mockResolvedValue(saleViewFixture());
  recordStockMovementMock.mockResolvedValue(saleViewFixture());
  clearWholeMachineMaintenanceLockMock.mockResolvedValue({ cleared: true });
  runHardwareSelfCheckMock.mockResolvedValue({
    online: true,
    message: "ok",
    candidates: [],
    configUpdated: false,
    portPath: null,
    resolutionSource: null,
    boundUsbIdentity: null,
  });
  getConfigMock.mockResolvedValue(provisionedConfigSummary());
  saveConfigMock.mockResolvedValue({});
  downloadLogExportMock.mockResolvedValue(new Response("logs"));
  callTauriCommandMock.mockResolvedValue(undefined);
  useMachineStore().$patch({ configLoaded: true });
});

afterEach(() => {
  mountedApp?.unmount();
  mountedApp = null;
  document.body.innerHTML = "";
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

async function mountView(): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  mountedApp = createApp(MaintenanceView);
  mountedApp.use(pinia);
  mountedApp.mount(host);
  await vi.waitFor(() => {
    expect(getSaleViewMock).toHaveBeenCalled();
  });
  await nextTick();
  return host;
}

function submitButton(host: HTMLElement): HTMLButtonElement {
  const button = Array.from(host.querySelectorAll("button")).find((item) =>
    item.textContent?.includes("记录库存动作"),
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error("submit button not found");
  }
  return button;
}

function buttonByText(host: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(host.querySelectorAll("button")).find((item) =>
    item.textContent?.includes(text),
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`${text} button not found`);
  }
  return button;
}

function hardwareAdapterSelect(host: HTMLElement): HTMLSelectElement {
  const select = Array.from(host.querySelectorAll("select")).find((item) =>
    Array.from(item.options).some((option) => option.value === "serial"),
  );
  if (!(select instanceof HTMLSelectElement)) {
    throw new Error("hardware adapter select not found");
  }
  return select;
}

function movementTypeSelect(host: HTMLElement): HTMLSelectElement {
  const select = Array.from(host.querySelectorAll("select")).find((item) =>
    Array.from(item.options).some(
      (option) => option.value === "stock_count_correction",
    ),
  );
  if (!(select instanceof HTMLSelectElement)) {
    throw new Error("movement type select not found");
  }
  return select;
}

describe("MaintenanceView hardware config", () => {
  it("shows production maintenance without editable deployment or debug configuration fields", async () => {
    const host = await mountView();

    expect(host.textContent).toContain("计划补货");
    expect(host.textContent).toContain("盘点修正");
    expect(host.textContent).toContain("Maintenance Console");
    expect(host.textContent).toContain("后端");
    expect(host.textContent).toContain("MQTT");
    expect(host.textContent).toContain("下位机");
    expect(host.textContent).toContain("扫码器");
    expect(host.textContent).toContain("视觉");
    expect(host.textContent).toContain("本地状态");
    expect(host.textContent).toContain("回到目录");
    expect(host.textContent).toContain("导出日志");
    expect(host.textContent).toContain("硬件自检");
    expect(host.textContent).toContain("视觉状态");

    expect(host.textContent).not.toContain("machineCode");
    expect(host.textContent).not.toContain("machineSecret");
    expect(host.textContent).not.toContain("mqttSigningSecret");
    expect(host.textContent).not.toContain("mqttPassword");
    expect(host.textContent).not.toContain("API Base URL");
    expect(host.textContent).not.toContain("MQTT URL");
    expect(host.textContent).not.toContain("硬件适配器");
    expect(host.textContent).not.toContain("扫码器适配器");
    expect(host.textContent).not.toContain("visionWsUrl");
    expect(host.textContent).not.toContain("MockHardwareControls");
    expect(host.querySelector("input[type='password']")).toBeNull();
    expect(saveConfigMock).not.toHaveBeenCalled();
  });

  it("shows advanced debug configuration only when the local flag is enabled", async () => {
    initializeMock.mockResolvedValueOnce({
      baseUrl: "http://127.0.0.1:7891",
      token: "token-1",
      source: "tauri_ready_file",
      mock: false,
      runtimeFlags: {
        advancedMaintenanceConfig: true,
      },
    });

    const host = await mountView();
    const select = hardwareAdapterSelect(host);

    expect(host.textContent).toContain("machineCode");
    expect(host.textContent).toContain("Machine Location Label");
    expect(host.textContent).toContain("machineSecret");
    expect(host.textContent).toContain("mqttSigningSecret");
    expect(host.textContent).toContain("mqttPassword");
    expect(host.textContent).toContain("API Base URL");
    expect(host.textContent).toContain("MQTT URL");
    expect(host.textContent).toContain("硬件适配器");
    expect(host.textContent).toContain("扫码器适配器");
    expect(host.textContent).toContain("visionWsUrl");
    expect(host.textContent).toContain("MockHardwareControls");
    expect(Array.from(select.options).map((option) => option.value)).toEqual([
      "mock",
      "serial",
    ]);
    expect(host.textContent).not.toContain("bluetooth");
    expect(host.textContent).not.toContain("vendor_sdk");
  });

  it("keeps advanced debug configuration hidden when daemon disables it even if Vite env enables it", async () => {
    vi.stubEnv("VITE_ENABLE_ADVANCED_MAINTENANCE_CONFIG", "true");
    initializeMock.mockResolvedValueOnce({
      baseUrl: "http://127.0.0.1:7891",
      token: "token-1",
      source: "tauri_ready_file",
      mock: false,
      runtimeFlags: {
        advancedMaintenanceConfig: false,
      },
    });

    const host = await mountView();

    expect(host.textContent).not.toContain("machineCode");
    expect(host.textContent).not.toContain("API Base URL");
    expect(host.textContent).not.toContain("MQTT URL");
    expect(host.textContent).not.toContain("MockHardwareControls");
  });

  it("does not leak deployment values into production maintenance UI", async () => {
    useMachineStore().$patch({
      configSummary: provisionedConfigSummary(),
      configLoaded: true,
    });

    const host = await mountView();

    expect(host.textContent).not.toContain("SECRET-MACHINE-CODE");
    expect(host.textContent).not.toContain("E2E lab");
    expect(host.textContent).not.toContain("https://api.secret.example/v1");
    expect(host.textContent).not.toContain("mqtt://secret-broker.example:1883");
    expect(host.textContent).not.toContain("secret-mqtt-user");
    expect(host.textContent).not.toContain("SECRET-SERIAL");
    expect(host.textContent).not.toContain("/dev/secret-scanner");
    expect(host.textContent).not.toContain("ws://secret-vision.example/ws");
    expect(host.textContent).not.toContain("secret-vision-command");
    expect(host.textContent).not.toContain("--secret-vision-args");
  });

  it("does not load deployment config into production maintenance state when advanced debug is disabled", async () => {
    useMachineStore().$patch({
      configSummary: null,
      configLoaded: false,
    });

    const host = await mountView();

    expect(getConfigMock).not.toHaveBeenCalled();
    expect(host.textContent).toContain("计划补货");
    expect(host.textContent).toContain("后端");
    expect(host.textContent).not.toContain("SECRET-MACHINE-CODE");
    expect(host.textContent).not.toContain("https://api.secret.example/v1");
  });

  it("runs production diagnostics and log export from standard maintenance", async () => {
    const host = await mountView();

    buttonByText(host, "硬件自检").click();
    buttonByText(host, "视觉状态").click();
    buttonByText(host, "导出日志").click();

    await vi.waitFor(() => {
      expect(runHardwareSelfCheckMock).toHaveBeenCalledOnce();
      expect(getVisionStatusMock).toHaveBeenCalled();
      expect(downloadLogExportMock).toHaveBeenCalledOnce();
    });
  });

  it("shows vision runtime status and only the latest diagnostic payload", async () => {
    getVisionStatusMock.mockResolvedValue({
      enabled: true,
      online: true,
      message: "vision ready",
      updatedAt: "2026-06-05T00:00:00.000Z",
      latestDiagnosticPayload: {
        type: "vision.profile_result",
        payload: {
          eventId: "VISION-LATEST-002",
          detectedAt: "2026-06-05T00:00:02.000Z",
          profile: {
            personPresent: true,
            heightCm: 172,
          },
          quality: {
            overall: "good",
            warnings: [],
          },
        },
      },
    });

    const host = await mountView();

    expect(host.textContent).toContain("Vision Runtime Status");
    expect(host.textContent).toContain("在线 · vision ready");
    expect(host.textContent).toContain("Latest Vision Diagnostic Payload");
    expect(host.textContent).toContain("VISION-LATEST-002");
    expect(host.textContent).toContain('"personPresent": true');
    expect(host.textContent).not.toContain("VISION-OLD-001");
    expect(
      host.querySelectorAll("[data-test='vision-diagnostic-payload']"),
    ).toHaveLength(1);
  });

  it("shows operator-only presence interaction status from the latest vision payload", async () => {
    getVisionStatusMock.mockResolvedValue({
      enabled: true,
      online: true,
      message: "vision ready",
      updatedAt: "2026-06-05T00:00:00.000Z",
      latestDiagnosticPayload: {
        type: "vision.profile_result",
        payload: {
          eventId: "VISION-PRESENCE-STATUS-001",
          detectedAt: "2026-06-05T00:00:05.000Z",
          profile: {
            personPresent: true,
            heightCm: 172,
            confidence: 0.92,
          },
          quality: {
            overall: "good",
            warnings: [],
          },
        },
      },
    });

    const host = await mountView();

    expect(host.textContent).toContain("Presence Interaction");
    expect(host.textContent).toContain("有人 · 2026-06-05T00:00:05.000Z");
    expect(host.textContent).toContain("VISION-PRESENCE-STATUS-001");
  });

  it("shows Machine Audio Cue settings with global and category state", async () => {
    useMachineStore().$patch({
      configSummary: {
        ...provisionedConfigSummary(),
        public: {
          ...provisionedConfigSummary().public,
          audioCueSettings: {
            enabled: true,
            categories: {
              presence: true,
              transaction: false,
            },
          },
        },
      },
      configLoaded: true,
    });

    const host = await mountView();

    expect(host.textContent).toContain("Audio Cue Settings");
    expect(host.textContent).toContain("Machine Audio Cue");
    expect(host.textContent).toContain("Global audio cues · Enabled");
    expect(host.textContent).toContain("Presence audio cues · Enabled");
    expect(host.textContent).toContain("Transaction audio cues · Disabled");
    expect(host.textContent).not.toContain("来人音频提示");
  });

  it("shows latest Machine Audio Cue diagnostic details without full history", async () => {
    const audioCueStore = useAudioCueStore();
    audioCueStore.recordSuppressedCue({
      category: "presence",
      cueKey: "presence.detected",
      message: "global audio cues disabled",
      recordedAt: "2026-06-29T06:59:00.000Z",
    });
    audioCueStore.applySettings({
      enabled: true,
      categories: { presence: false, transaction: true },
    });
    const request = audioCueStore.requestCue({
      category: "transaction",
      cueKey: "payment.succeeded",
      orderKey: "ORDER-107",
      requestedAt: "2026-06-29T07:00:00.000Z",
      nowMs: 1_000,
    });
    audioCueStore.recordPlaybackOutcome({
      requestId: request?.requestId ?? "",
      outcome: "played",
      message: "playback completed",
      recordedAt: "2026-06-29T07:00:01.000Z",
    });

    const host = await mountView();

    expect(host.textContent).toContain("Latest Machine Audio Cue Diagnostic");
    expect(host.textContent).toContain("Requested cue meaning");
    expect(host.textContent).toContain("Payment succeeded");
    expect(host.textContent).toContain("Category · Transaction audio cue");
    expect(host.textContent).toContain("Playback outcome · Played");
    expect(host.textContent).toContain(
      "Suppression/drop reason · playback completed",
    );
    expect(host.textContent).toContain("Timestamp · 2026-06-29T07:00:01.000Z");
    expect(host.textContent).toContain(
      "Duplicate-suppression order key (debug only) · ORDER-107",
    );
    expect(host.textContent).toContain("ORDER-107");
    expect(host.textContent).not.toContain("presence.detected");
    expect(
      host.querySelectorAll("[data-test='audio-cue-diagnostic']"),
    ).toHaveLength(1);
  });

  it("labels playback failures as local audio diagnostics only", async () => {
    const audioCueStore = useAudioCueStore();
    audioCueStore.applySettings({
      enabled: true,
      categories: { presence: false, transaction: true },
    });
    const request = audioCueStore.requestCue({
      category: "transaction",
      cueKey: "dispense.failed",
      orderKey: "ORDER-108",
      requestedAt: "2026-06-29T07:05:00.000Z",
      nowMs: 2_000,
    });
    audioCueStore.recordPlaybackOutcome({
      requestId: request?.requestId ?? "",
      outcome: "failed",
      message: "NotAllowedError: user gesture required",
      recordedAt: "2026-06-29T07:05:01.000Z",
    });

    const host = await mountView();

    expect(host.textContent).toContain(
      "Playback outcome · Local audio playback failed",
    );
    expect(host.textContent).toContain(
      "Suppression/drop reason · NotAllowedError: user gesture required",
    );
    expect(host.textContent).not.toContain("Payment failed");
    expect(host.textContent).not.toContain("Readiness failure");
  });

  it.each([
    ["dispense.succeeded", "Dispense succeeded"],
    ["dispense.failed", "Dispense failed"],
    ["refund.pending", "Refund pending"],
  ] as const)(
    "labels the real production cue key %s",
    async (cueKey, expectedLabel) => {
      const audioCueStore = useAudioCueStore();
      audioCueStore.recordSuppressedCue({
        category: "transaction",
        cueKey,
        orderKey: "ORDER-REAL-CUE",
        message: "duplicate transaction cue",
        recordedAt: "2026-06-29T07:07:00.000Z",
      });

      const host = await mountView();

      expect(host.textContent).toContain(expectedLabel);
      expect(host.textContent).toContain(
        "Duplicate-suppression order key (debug only) · ORDER-REAL-CUE",
      );
    },
  );

  it("shows suppression or drop reason for skipped Machine Audio Cues", async () => {
    const audioCueStore = useAudioCueStore();
    audioCueStore.recordSuppressedCue({
      category: "presence",
      cueKey: "presence.detected",
      message: "presence audio cue category disabled",
      recordedAt: "2026-06-29T07:10:00.000Z",
    });

    const host = await mountView();

    expect(host.textContent).toContain("Presence detected");
    expect(host.textContent).toContain("Category · Presence audio cue");
    expect(host.textContent).toContain("Playback outcome · Skipped");
    expect(host.textContent).toContain(
      "Suppression/drop reason · presence audio cue category disabled",
    );
    expect(host.textContent).toContain("Timestamp · 2026-06-29T07:10:00.000Z");
  });

  it("does not couple maintenance interactions to customer-facing audio cue playback", async () => {
    const audioCueStore = useAudioCueStore();
    audioCueStore.applySettings({
      enabled: true,
      categories: { presence: true, transaction: true },
    });

    const host = await mountView();

    buttonByText(host, "刷新诊断").click();
    buttonByText(host, "硬件自检").click();
    buttonByText(host, "视觉状态").click();
    buttonByText(host, "导出日志").click();
    buttonByText(host, "回到目录").click();

    await vi.waitFor(() => {
      expect(getReadyMock).toHaveBeenCalled();
      expect(runHardwareSelfCheckMock).toHaveBeenCalledOnce();
      expect(getVisionStatusMock).toHaveBeenCalled();
      expect(downloadLogExportMock).toHaveBeenCalledOnce();
      expect(routerReplaceMock).toHaveBeenCalledWith("/catalog");
    });
    expect(audioCueStore.playback.status).toBe("idle");
    expect(audioCueStore.playback.request).toBeNull();
    expect(audioCueStore.latestPlaybackDiagnostic).toBeNull();
    expect(host.textContent).not.toContain("Payment failed");
    expect(host.textContent).not.toContain("Dispensing failed");
    expect(host.textContent).not.toContain("Refund failed");
    expect(host.textContent).not.toContain("Readiness failure");
  });

  it("clears stale real-time profile result when daemon status has no payload", async () => {
    useVisionStore().applyLatestProfileResult({
      eventId: "VISION-REALTIME-003",
      detectedAt: "2026-06-05T00:00:03.000Z",
      profile: {
        personPresent: true,
        heightCm: 168,
        bodyType: "regular",
        confidence: 0.88,
      },
      quality: {
        overall: "good",
        warnings: [],
      },
    });

    const host = await mountView();

    expect(host.textContent).not.toContain("VISION-REALTIME-003");
    expect(host.textContent).not.toContain('"heightCm": 168');
    expect(host.textContent).toContain("无人 · not seen");
    expect(host.textContent).toContain("No diagnostic payload returned yet.");
  });

  it("bounds the displayed latest diagnostic payload", async () => {
    getVisionStatusMock.mockResolvedValue({
      enabled: true,
      online: true,
      message: "vision ready",
      updatedAt: "2026-06-05T00:00:00.000Z",
      latestDiagnosticPayload: {
        type: "vision.profile_result",
        payload: {
          eventId: "VISION-HUGE-004",
          detectedAt: "2026-06-05T00:00:04.000Z",
          profile: {
            personPresent: true,
            heightCm: 172,
          },
          quality: {
            overall: "good",
            warnings: ["x".repeat(20_000)],
          },
        },
      },
    });

    const host = await mountView();
    const payload = host.querySelector(
      "[data-test='vision-diagnostic-payload']",
    );
    if (!(payload instanceof HTMLElement)) {
      throw new Error("vision diagnostic payload not found");
    }

    expect(payload.textContent).toContain("VISION-HUGE-004");
    expect(payload.textContent).toContain("truncated");
    expect(payload.textContent?.length ?? 0).toBeLessThan(14_000);
    expect(payload.textContent).not.toContain("x".repeat(5000));
  });

  it("does not expose Windows desktop exit in production customer maintenance", async () => {
    const host = await mountView();

    expect(host.textContent).not.toContain("回到 Windows 桌面");
    expect(callTauriCommandMock).not.toHaveBeenCalled();
  });

  it("returns to the Windows desktop through the restricted Tauri command", async () => {
    initializeMock.mockResolvedValueOnce({
      baseUrl: "http://127.0.0.1:7891",
      token: "token-1",
      source: "tauri_ready_file",
      mock: false,
      runtimeFlags: {
        advancedMaintenanceConfig: true,
      },
    });
    const host = await mountView();

    buttonByText(host, "回到 Windows 桌面").click();

    await vi.waitFor(() => {
      expect(callTauriCommandMock).toHaveBeenCalledWith("return_to_desktop");
    });
  });

  it("returns to the catalog from standard maintenance", async () => {
    const host = await mountView();

    buttonByText(host, "回到目录").click();

    await vi.waitFor(() => {
      expect(routerReplaceMock).toHaveBeenCalledWith("/catalog");
    });
  });

  it("blocks returning to the catalog while the machine is not sellable", async () => {
    getReadyMock.mockResolvedValue(maintenanceReadyFixture());

    const host = await mountView();
    const button = buttonByText(host, "回到目录");

    expect(button.disabled).toBe(true);
    expect(host.textContent).toContain("暂不能回到目录");
    expect(host.textContent).toContain("lower controller unavailable");

    button.click();
    await nextTick();

    expect(routerReplaceMock).not.toHaveBeenCalledWith("/catalog");
  });

  it("auto-refreshes system maintenance diagnostics and returns to catalog after recovery", async () => {
    vi.useFakeTimers();
    routeMock.query = {};
    getReadyMock
      .mockResolvedValueOnce(maintenanceReadyFixture())
      .mockResolvedValue(readyFixture());

    await mountView();
    await vi.waitFor(() => {
      expect(getReadyMock).toHaveBeenCalledOnce();
    });
    expect(routerReplaceMock).not.toHaveBeenCalledWith("/catalog");

    await vi.advanceTimersByTimeAsync(5000);

    await vi.waitFor(() => {
      expect(routerReplaceMock).toHaveBeenCalledWith("/catalog");
    });
  });

  it("keeps operator maintenance open while diagnostics auto-refresh", async () => {
    vi.useFakeTimers();
    routeMock.query = { source: "operator" };

    await mountView();
    await vi.waitFor(() => {
      expect(getReadyMock).toHaveBeenCalledOnce();
    });
    await vi.advanceTimersByTimeAsync(5000);

    expect(routerReplaceMock).not.toHaveBeenCalledWith("/catalog");
    expect(getReadyMock).toHaveBeenCalledTimes(2);
  });

  it("shows why whole-machine lock clearing is rejected while hardware remains faulted", async () => {
    getReadyMock.mockResolvedValue({
      ...readyFixture(),
      ready: false,
      canSell: false,
      mode: "maintenance",
      blockingCodes: [
        "LOWER_CONTROLLER_UNAVAILABLE",
        "WHOLE_MACHINE_HARDWARE_FAULT",
      ],
      blockingReasons: [
        {
          code: "LOWER_CONTROLLER_UNAVAILABLE",
          component: "hardware",
          message: "lower controller unavailable",
        },
        {
          code: "WHOLE_MACHINE_HARDWARE_FAULT",
          component: "hardware",
          message:
            "lower controller responded with fault on COM8 (pickup platform blocked)",
        },
      ],
      suggestedRoute: "maintenance",
    });
    clearWholeMachineMaintenanceLockMock.mockRejectedValueOnce(
      new Error(
        "lower controller must be healthy before clearing whole-machine lock: lower controller responded with fault on COM8 (pickup platform blocked)",
      ),
    );
    const host = await mountView();
    const clearButton = buttonByText(host, "确认解除整机锁");

    expect(host.textContent).toContain("整机维护锁");
    expect(host.textContent).toContain("下位机未在线");
    expect(host.textContent).toContain("处理卡货或机械故障");
    expect(clearButton.disabled).toBe(true);

    buttonByText(host, "硬件自检").click();
    await vi.waitFor(() => {
      expect(host.textContent).toContain("下位机自检：通过");
    });
    expect(clearButton.disabled).toBe(true);

    const note = host.querySelector("textarea");
    if (!(note instanceof HTMLTextAreaElement)) {
      throw new Error("operator note textarea not found");
    }
    note.value = "现场复位下位机后，自检通过";
    note.dispatchEvent(new Event("input"));
    await nextTick();
    expect(clearButton.disabled).toBe(false);

    clearButton.click();

    await vi.waitFor(() => {
      expect(clearWholeMachineMaintenanceLockMock).toHaveBeenCalledWith(
        "现场复位下位机后，自检通过",
      );
      expect(host.textContent).toContain(
        "lower controller must be healthy before clearing whole-machine lock",
      );
    });
  });
});

describe("MaintenanceView stock maintenance", () => {
  it("does not expose trusted stock movement sources", async () => {
    const host = await mountView();

    expect(host.textContent).not.toContain("field_service");
    expect(host.textContent).not.toContain("approved_count");
  });

  it("records no-login planned refill as local maintenance with attribution", async () => {
    const host = await mountView();
    const updatedSaleView = {
      ...saleViewFixture(),
      items: [
        {
          ...saleViewFixture().items[0],
          physicalStock: 5,
          saleableStock: 5,
          slotSalesState: "sale_ready",
        },
      ],
      lastUpdatedAt: "2026-06-05T00:05:00.000Z",
    };
    recordStockMovementMock.mockResolvedValueOnce(updatedSaleView);

    submitButton(host).click();

    await vi.waitFor(() => {
      expect(recordStockMovementMock).toHaveBeenCalledWith(
        expect.objectContaining({
          planogramVersion: "PLAN-1",
          slotId: "550e8400-e29b-41d4-a716-446655440001",
          movementType: "planned_refill",
          source: "local_maintenance",
          attributedTo: "front-panel",
        }),
      );
      expect(useCatalogStore().items[0]?.physicalStock).toBe(5);
      expect(useCatalogStore().items[0]?.slotSalesState).toBe("sale_ready");
    });
  });

  it("records no-login stock count as local maintenance with attribution", async () => {
    const host = await mountView();
    const select = movementTypeSelect(host);
    select.value = "stock_count_correction";
    select.dispatchEvent(new Event("change"));
    await nextTick();

    submitButton(host).click();

    await vi.waitFor(() => {
      expect(recordStockMovementMock).toHaveBeenCalledWith(
        expect.objectContaining({
          movementType: "stock_count_correction",
          source: "local_maintenance",
          attributedTo: "front-panel",
        }),
      );
    });
  });
});
