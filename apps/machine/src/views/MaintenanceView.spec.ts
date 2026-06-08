// @vitest-environment jsdom
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";

import type { ConfigSummary } from "@/daemon/schemas";

const {
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
  runHardwareSelfCheckMock,
  saveConfigMock,
  downloadLogExportMock,
} = vi.hoisted(() => ({
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
  runHardwareSelfCheckMock: vi.fn(),
  saveConfigMock: vi.fn(),
  downloadLogExportMock: vi.fn(),
}));

vi.mock("vue-router", () => ({
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
    runHardwareSelfCheck: runHardwareSelfCheckMock,
    saveConfig: saveConfigMock,
    downloadLogExport: downloadLogExportMock,
  },
}));

import { useMachineStore } from "@/stores/machine";

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

function provisionedConfigSummary(): ConfigSummary {
  return {
    public: {
      machineCode: "SECRET-MACHINE-CODE",
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
      visionAutoStart: true,
      visionProcessCommand: "secret-vision-command",
      visionProcessArgs: "--secret-vision-args",
      visionRequestTimeoutMs: 8000,
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
  });
  getRemoteOpsStatusMock.mockResolvedValue({
    lastPolledAt: "2026-06-05T00:00:00.000Z",
    pending: 0,
    lastError: null,
    processing: null,
  });
  getSaleViewMock.mockResolvedValue(saleViewFixture());
  recordStockMovementMock.mockResolvedValue(saleViewFixture());
  runHardwareSelfCheckMock.mockResolvedValue({
    online: true,
    message: "ok",
    candidates: [],
    configUpdated: false,
    portPath: null,
    resolutionSource: null,
    boundUsbIdentity: null,
  });
  saveConfigMock.mockResolvedValue({});
  downloadLogExportMock.mockResolvedValue(new Response("logs"));
  useMachineStore().$patch({ configLoaded: true });
});

afterEach(() => {
  mountedApp?.unmount();
  mountedApp = null;
  document.body.innerHTML = "";
  vi.unstubAllEnvs();
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
    expect(host.textContent).toContain("后端");
    expect(host.textContent).toContain("MQTT");
    expect(host.textContent).toContain("下位机");
    expect(host.textContent).toContain("扫码器");
    expect(host.textContent).toContain("视觉");
    expect(host.textContent).toContain("本地状态");
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

  it("does not leak deployment values into production maintenance UI", async () => {
    useMachineStore().$patch({
      configSummary: provisionedConfigSummary(),
      configLoaded: true,
    });

    const host = await mountView();

    expect(host.textContent).not.toContain("SECRET-MACHINE-CODE");
    expect(host.textContent).not.toContain("https://api.secret.example/v1");
    expect(host.textContent).not.toContain("mqtt://secret-broker.example:1883");
    expect(host.textContent).not.toContain("secret-mqtt-user");
    expect(host.textContent).not.toContain("SECRET-SERIAL");
    expect(host.textContent).not.toContain("/dev/secret-scanner");
    expect(host.textContent).not.toContain("ws://secret-vision.example/ws");
    expect(host.textContent).not.toContain("secret-vision-command");
    expect(host.textContent).not.toContain("--secret-vision-args");
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
});

describe("MaintenanceView stock maintenance", () => {
  it("does not expose trusted stock movement sources", async () => {
    const host = await mountView();

    expect(host.textContent).not.toContain("field_service");
    expect(host.textContent).not.toContain("approved_count");
  });

  it("records no-login planned refill as local maintenance with attribution", async () => {
    const host = await mountView();

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
