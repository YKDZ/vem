// @vitest-environment jsdom
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";

import {
  deviceBindingSnapshotSchema,
  type ConfigSummary,
} from "@/daemon/schemas";

const {
  routeMock,
  routerReplaceMock,
  initializeMock,
  getHealthMock,
  getReadyMock,
  getSyncStatusMock,
  getScannerStatusMock,
  getDeviceBindingsMock,
  testDeviceBindingMock,
  confirmDeviceBindingMock,
  getVisionStatusMock,
  getNaturalContextMock,
  getRemoteOpsStatusMock,
  getStockMaintenanceTaskMock,
  submitStockMaintenanceBatchMock,
  getPaymentEnvironmentDiagnosticMock,
  clearWholeMachineMaintenanceLockMock,
  runHardwareSelfCheckMock,
  getConfigMock,
  saveConfigMock,
  getAudioOutputBindingMock,
  testAudioOutputMock,
  confirmAudioOutputMock,
  downloadLogExportMock,
  beginMaintenanceSessionMock,
  clearMaintenanceSessionMock,
  handoffMaintenanceSessionToBringUpMock,
  getMaintenanceSessionForRouteMock,
  releaseMaintenanceSessionRouteMock,
  revokeMaintenanceSessionRouteMock,
  runManualDispenseDiagnosticMock,
  onMaintenanceSessionInvalidatedMock,
  callTauriCommandMock,
  openVisionTryOnSessionMock,
} = vi.hoisted(() => ({
  routeMock: { query: {} as Record<string, unknown> },
  routerReplaceMock: vi.fn(),
  initializeMock: vi.fn(),
  getHealthMock: vi.fn(),
  getReadyMock: vi.fn(),
  getSyncStatusMock: vi.fn(),
  getScannerStatusMock: vi.fn(),
  getDeviceBindingsMock: vi.fn(),
  testDeviceBindingMock: vi.fn(),
  confirmDeviceBindingMock: vi.fn(),
  getVisionStatusMock: vi.fn(),
  getNaturalContextMock: vi.fn(),
  getRemoteOpsStatusMock: vi.fn(),
  getStockMaintenanceTaskMock: vi.fn(),
  submitStockMaintenanceBatchMock: vi.fn(),
  getPaymentEnvironmentDiagnosticMock: vi.fn(),
  clearWholeMachineMaintenanceLockMock: vi.fn(),
  runHardwareSelfCheckMock: vi.fn(),
  getConfigMock: vi.fn(),
  saveConfigMock: vi.fn(),
  getAudioOutputBindingMock: vi.fn(),
  testAudioOutputMock: vi.fn(),
  confirmAudioOutputMock: vi.fn(),
  downloadLogExportMock: vi.fn(),
  beginMaintenanceSessionMock: vi.fn(),
  clearMaintenanceSessionMock: vi.fn(),
  handoffMaintenanceSessionToBringUpMock: vi.fn(),
  getMaintenanceSessionForRouteMock: vi.fn(),
  releaseMaintenanceSessionRouteMock: vi.fn(),
  revokeMaintenanceSessionRouteMock: vi.fn().mockResolvedValue(undefined),
  runManualDispenseDiagnosticMock: vi.fn(),
  onMaintenanceSessionInvalidatedMock: vi.fn(),
  callTauriCommandMock: vi.fn(),
  openVisionTryOnSessionMock: vi.fn(),
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

vi.mock("@/daemon/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/daemon/client")>();
  return {
    ...actual,
    daemonClient: {
      initialize: initializeMock,
      getHealth: getHealthMock,
      getReady: getReadyMock,
      getSyncStatus: getSyncStatusMock,
      getScannerStatus: getScannerStatusMock,
      getDeviceBindings: getDeviceBindingsMock,
      testDeviceBinding: testDeviceBindingMock,
      confirmDeviceBinding: confirmDeviceBindingMock,
      getVisionStatus: getVisionStatusMock,
      getNaturalContext: getNaturalContextMock,
      getRemoteOpsStatus: getRemoteOpsStatusMock,
      getStockMaintenanceTask: getStockMaintenanceTaskMock,
      submitStockMaintenanceBatch: submitStockMaintenanceBatchMock,
      getPaymentEnvironmentDiagnostic: getPaymentEnvironmentDiagnosticMock,
      clearWholeMachineMaintenanceLock: clearWholeMachineMaintenanceLockMock,
      runHardwareSelfCheck: runHardwareSelfCheckMock,
      getConfig: getConfigMock,
      saveConfig: saveConfigMock,
      getAudioOutputBinding: getAudioOutputBindingMock,
      testAudioOutput: testAudioOutputMock,
      confirmAudioOutput: confirmAudioOutputMock,
      downloadLogExport: downloadLogExportMock,
      beginMaintenanceSession: beginMaintenanceSessionMock,
      clearMaintenanceSession: clearMaintenanceSessionMock,
      handoffMaintenanceSessionToBringUp:
        handoffMaintenanceSessionToBringUpMock,
      getMaintenanceSessionForRoute: getMaintenanceSessionForRouteMock,
      releaseMaintenanceSessionRoute: releaseMaintenanceSessionRouteMock,
      revokeMaintenanceSessionRoute: revokeMaintenanceSessionRouteMock,
      runManualDispenseDiagnostic: runManualDispenseDiagnosticMock,
      onMaintenanceSessionInvalidated: onMaintenanceSessionInvalidatedMock,
    },
  };
});

vi.mock("@/native/tauri", () => ({
  isTauriRuntime: () => true,
  callTauriCommand: callTauriCommandMock,
}));

vi.mock("@/native/vision", () => ({
  openVisionTryOnSession: openVisionTryOnSessionMock,
}));

import { useAudioCueStore } from "@/stores/audio-cues";
import { useMachineStore } from "@/stores/machine";
import { useVisionStore } from "@/stores/vision";

import MaintenanceView from "./MaintenanceView.vue";

let mountedApp: App<Element> | null = null;
let pinia: ReturnType<typeof createPinia>;
let maintenanceSessionInvalidationListener: (() => void) | null = null;

function stockMaintenanceTaskFixture(
  mode:
    | "initial_count"
    | "recovery_count"
    | "routine_refill" = "routine_refill",
) {
  return {
    taskId: "stock-task-01",
    mode,
    status: "ready" as const,
    slots: [
      {
        slotCode: "A1",
        layerNo: 1,
        cellNo: 1,
        productName: "Mineral Water",
        sku: "WATER-001",
        capacity: 8,
        currentQuantity: 2,
        submittedQuantity: null,
        submittedAddition: null,
        previewQuantity: null,
        syncStatus: "not_submitted" as const,
        salesState: "sale_ready",
        reconciliationReason: null,
      },
    ],
    discoveryDiagnostics: [],
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
      machineAudioVolume: 0.7,
      machineAudioOutputBinding: null,
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
    maintenancePinConfigured: true,
    provisioned: true,
    provisioningIssues: [],
  };
}

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  globalThis.localStorage.clear();
  vi.clearAllMocks();
  maintenanceSessionInvalidationListener = null;
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
  getDeviceBindingsMock.mockResolvedValue(
    deviceBindingSnapshotSchema.parse({
      roles: [
        {
          role: "lower_controller",
          binding: null,
          currentPort: null,
          ready: false,
          code: "DEVICE_BINDING_SELECTION_REQUIRED",
          message: "select lower controller",
          ambiguous: true,
          ambiguityKind: "candidate_selection",
          ambiguityPorts: ["COM5", "COM3"],
          legacyPortHint: "COM5",
          candidates: [
            {
              identity: {
                identityKey: "container:11111111-2222-3333-4444-555555555555",
                instanceId: "USB\\CONTROLLER-1",
                containerId: "11111111-2222-3333-4444-555555555555",
                hardwareIds: ["USB\\VID_1A86&PID_55D3"],
                serialNumber: null,
              },
              currentPort: "COM5",
              friendlyName: "下位机串口",
              readiness: "candidate",
              readinessCode: "ROLE_TEST_REQUIRED",
              readinessMessage: "test required",
            },
            {
              identity: {
                identityKey: "container:22222222-3333-4444-5555-666666666666",
                instanceId: "USB\\VID_1234&PID_5678\\SCANNER-1",
                containerId: "22222222-3333-4444-5555-666666666666",
                hardwareIds: ["USB\\VID_1234&PID_5678"],
                serialNumber: "SCANNER-1",
              },
              currentPort: "COM3",
              friendlyName: "扫码器串口",
              readiness: "candidate",
              readinessCode: "ROLE_TEST_REQUIRED",
              readinessMessage: "test required",
            },
          ],
          discoveryDiagnostics: [],
        },
        {
          role: "scanner",
          binding: null,
          currentPort: null,
          ready: false,
          code: "DEVICE_BINDING_REQUIRED",
          message: "select scanner",
          ambiguous: false,
          ambiguityKind: null,
          ambiguityPorts: [],
          legacyPortHint: "COM3",
          candidates: [],
          discoveryDiagnostics: [],
        },
      ],
    }),
  );
  testDeviceBindingMock.mockResolvedValue({
    role: "lower_controller",
    identityKey: "container:11111111-2222-3333-4444-555555555555",
    currentPort: "COM5",
    success: true,
    code: "LOWER_CONTROLLER_HANDSHAKE_READY",
    message: "ready",
    testedAt: "2026-07-15T00:00:00Z",
    testEvidenceToken: "11111111-2222-4333-8444-555555555555",
    testEvidenceExpiresAt: "2026-07-15T00:01:00Z",
    observationRevision: `sha256:${"a".repeat(64)}`,
    observationGeneration: 1,
    configRevision: `sha256:${"b".repeat(64)}`,
    configGeneration: 1,
  });
  confirmDeviceBindingMock.mockResolvedValue({
    binding: {
      identity: {
        identityKey: "container:11111111-2222-3333-4444-555555555555",
        instanceId: "USB\\CONTROLLER-1",
        containerId: "11111111-2222-3333-4444-555555555555",
        hardwareIds: ["USB\\VID_1A86&PID_55D3"],
        serialNumber: null,
      },
      confirmedAt: "2026-07-15T00:00:00Z",
      confirmedBy: "operator-1",
      testEvidenceCode: "LOWER_CONTROLLER_HANDSHAKE_READY",
    },
    currentPort: "COM5",
    ready: true,
    code: "DEVICE_BINDING_ACTIVATED",
    message: "activated",
    unrelatedRuntimeRestarted: false,
  });
  getVisionStatusMock.mockResolvedValue({
    enabled: true,
    online: true,
    message: "vision ready",
    updatedAt: "2026-06-05T00:00:00.000Z",
    latestDiagnosticPayload: null,
  });
  getNaturalContextMock.mockResolvedValue({
    status: "ready",
    machineCode: "SECRET-MACHINE-CODE",
    checkedAt: "2026-06-30T14:00:00.000Z",
    degraded: false,
    customerFacingBlocked: false,
    externalEnvironment: {
      status: "ready",
      machineId: "550e8400-e29b-41d4-a716-446655440000",
      machineCode: "SECRET-MACHINE-CODE",
      checkedAt: "2026-06-30T14:00:00.000Z",
      localTime: {
        status: "ready",
        timezone: "Asia/Shanghai",
        localDate: "2026-06-30",
        localClock: "22:00:00",
      },
      weather: {
        status: "ready",
        temperatureCelsius: 28,
        conditionText: "Sunny",
        conditionCode: "100",
        observedAt: "2026-06-30T13:50:00.000Z",
        weatherConditionClasses: ["other"],
        primaryWeatherConditionClass: "other",
      },
      sun: {
        status: "ready",
        sunriseAt: "2026-06-29T21:53:00.000Z",
        sunsetAt: "2026-06-30T10:02:00.000Z",
      },
      calendar: {
        status: "ready",
        localDate: "2026-06-30",
        festivals: [],
        primaryFestival: null,
        solarTerm: null,
      },
    },
    localSiteSignals: {
      status: "unavailable",
    },
  });
  getRemoteOpsStatusMock.mockResolvedValue({
    lastPolledAt: "2026-06-05T00:00:00.000Z",
    pending: 0,
    lastError: null,
    processing: null,
  });
  getStockMaintenanceTaskMock.mockResolvedValue(stockMaintenanceTaskFixture());
  submitStockMaintenanceBatchMock.mockResolvedValue({
    task: { ...stockMaintenanceTaskFixture(), status: "pending" },
    duplicate: false,
  });
  getPaymentEnvironmentDiagnosticMock.mockResolvedValue({
    environment: "sandbox",
    readiness: "ready",
    errorCategory: "none",
  });
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
  getAudioOutputBindingMock.mockResolvedValue({
    binding: null,
    currentObservation: null,
    observationRevision: `sha256:${"a".repeat(64)}`,
    candidates: [
      {
        endpointId: "{0.0.0.00000000}.speaker-1",
        friendlyName: "Near-field speaker",
        isDefault: true,
      },
      {
        endpointId: "{0.0.0.00000000}.hdmi-1",
        friendlyName: "HDMI monitor",
        isDefault: false,
      },
    ],
    ready: false,
    code: "AUDIO_OUTPUT_BINDING_REQUIRED",
    message: "binding required",
  });
  testAudioOutputMock.mockResolvedValue({
    endpointId: "wasapi:endpoint-speaker",
    testEvidenceToken: "11111111-2222-4333-8444-555555555555",
    testEvidenceExpiresAt: "2030-07-15T00:01:00Z",
    observationRevision: `sha256:${"a".repeat(64)}`,
    observationGeneration: 1,
    configRevision: `sha256:${"b".repeat(64)}`,
    configGeneration: 1,
    proposedSettingsDigest: `sha256:${"c".repeat(64)}`,
  });
  confirmAudioOutputMock.mockResolvedValue(provisionedConfigSummary());
  downloadLogExportMock.mockResolvedValue(new Response("logs"));
  beginMaintenanceSessionMock.mockResolvedValue({
    sessionId: "maintenance-session-1",
    expiresAt: "2030-07-14T12:00:00.000Z",
    scopes: ["maintenance.mutate"],
  });
  handoffMaintenanceSessionToBringUpMock.mockReturnValue(true);
  getMaintenanceSessionForRouteMock.mockReturnValue(null);
  onMaintenanceSessionInvalidatedMock.mockImplementation(
    (listener: () => void) => {
      maintenanceSessionInvalidationListener = listener;
      return () => {
        if (maintenanceSessionInvalidationListener === listener) {
          maintenanceSessionInvalidationListener = null;
        }
      };
    },
  );
  callTauriCommandMock.mockResolvedValue(undefined);
  openVisionTryOnSessionMock.mockResolvedValue({
    sessionId: "maintenance-session-1",
    previewUrl: "http://127.0.0.1:7892/try-on/maintenance.mjpeg",
    streamType: "mjpeg",
    stop: vi.fn().mockResolvedValue(undefined),
  });
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
    expect(getStockMaintenanceTaskMock).toHaveBeenCalled();
  });
  await nextTick();
  return host;
}

async function unlockMaintenance(host: HTMLElement): Promise<void> {
  const input = host.querySelector('input[aria-label="维护 PIN"]');
  if (!(input instanceof HTMLInputElement)) {
    throw new Error("maintenance PIN input not found");
  }
  input.value = "2468";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input
    .closest("form")
    ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await vi.waitFor(() => {
    expect(host.textContent).toContain("已授权");
  });
}

it("keeps automatic maintenance diagnostics readable while mutations remain PIN-gated", async () => {
  routeMock.query = {};
  getReadyMock.mockResolvedValue(maintenanceReadyFixture());
  const host = await mountView();

  expect(host.textContent).toContain("只读");
  expect(host.textContent).toContain("当前阻塞项");
  const recovery = Array.from(host.querySelectorAll("button")).find((button) =>
    button.textContent?.includes("先验证 PIN"),
  );
  expect(recovery).toBeInstanceOf(HTMLButtonElement);
  expect(recovery).toHaveProperty("disabled", true);
});

it("verifies the PIN through daemon IPC before enabling protected maintenance actions", async () => {
  const host = await mountView();
  await unlockMaintenance(host);
  await vi.waitFor(() => {
    expect(beginMaintenanceSessionMock).toHaveBeenCalledWith(
      "2468",
      ["maintenance.reclaim", "maintenance.manual_dispense"],
      "operator-console",
    );
  });
  expect(clearMaintenanceSessionMock).not.toHaveBeenCalled();
});

it("shows only the secret-free payment environment diagnostic after maintenance authorization", async () => {
  const host = await mountView();

  expect(host.textContent).not.toContain("支付环境");
  await unlockMaintenance(host);
  await vi.waitFor(() => {
    expect(getPaymentEnvironmentDiagnosticMock).toHaveBeenCalled();
    expect(host.textContent).toContain("支付环境");
    expect(host.textContent).toContain("沙箱");
    expect(host.textContent).toContain("已就绪");
  });
  expect(host.textContent).not.toMatch(/privateKeyPem|certificate|密钥|证书/);
});

it("runs one protected manual dispense diagnostic and requires explicit stock reconciliation", async () => {
  runManualDispenseDiagnosticMock.mockResolvedValue({
    diagnosticId: "manual-dispense-1",
    outcome: "completed",
    errorCode: null,
    reportedAt: "2026-07-15T00:00:00.000Z",
    stockReconciliationRequired: true,
    reconciliationStatus: "open",
    replayed: false,
  });
  const host = await mountView();
  await unlockMaintenance(host);
  buttonByText(host, "出货一件").click();
  await vi.waitFor(() => {
    expect(runManualDispenseDiagnosticMock).toHaveBeenCalledWith(
      expect.objectContaining({
        slotCode: "A1",
        layerNo: 1,
        cellNo: 1,
        quantity: 1,
      }),
    );
    expect(host.textContent).toContain("请立即执行库存核对");
  });
  expect(recordStockMovementMock).not.toHaveBeenCalled();
});

it("returns the rendered maintenance session to read-only when the daemon invalidates it", async () => {
  const host = await mountView();
  await unlockMaintenance(host);

  maintenanceSessionInvalidationListener?.();
  await nextTick();

  expect(host.textContent).toContain("只读");
  expect(host.textContent).not.toContain("支付环境");
  expect(host.textContent).toContain("守护进程连接已更新");
  expect(clearMaintenanceSessionMock).toHaveBeenCalled();
});

it("makes MACHINE_AUTH_MISSING recovery usable in production after PIN verification", async () => {
  routeMock.query = {};
  getReadyMock.mockResolvedValue({
    ...maintenanceReadyFixture(),
    blockingCodes: ["MACHINE_AUTH_MISSING"],
    blockingReasons: [
      {
        code: "MACHINE_AUTH_MISSING",
        component: "machine_authentication",
        message: "machine identity is not configured",
      },
    ],
  });
  const host = await mountView();

  const lockedRecovery = buttonByText(host, "先验证 PIN");
  expect(lockedRecovery.disabled).toBe(true);
  await unlockMaintenance(host);

  const unlockedRecovery = buttonByText(host, "打开首次部署控制台");
  expect(unlockedRecovery.disabled).toBe(false);
  unlockedRecovery.click();
  await vi.waitFor(() => {
    expect(routerReplaceMock).toHaveBeenCalledWith({
      path: "/bring-up",
      query: { source: "protected-maintenance" },
    });
  });
});

function stockInputByLabel(
  host: HTMLElement,
  labelText: string,
): HTMLInputElement {
  const label = Array.from(host.querySelectorAll("label")).find((item) =>
    item.textContent?.includes(labelText),
  );
  const input = label?.querySelector("input");
  if (!(input instanceof HTMLInputElement)) {
    throw new Error(`${labelText} stock input not found`);
  }
  return input;
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

function imgByTest(host: HTMLElement, testId: string): HTMLImageElement {
  const image = host.querySelector(`[data-test='${testId}']`);
  if (!(image instanceof HTMLImageElement)) {
    throw new Error(`${testId} image not found`);
  }
  return image;
}

function inputByTest(host: HTMLElement, testId: string): HTMLInputElement {
  const input = host.querySelector(`[data-test='${testId}']`);
  if (!(input instanceof HTMLInputElement)) {
    throw new Error(`${testId} input not found`);
  }
  return input;
}

describe("MaintenanceView hardware config", () => {
  it("hides unsafe binding actions for duplicate observations and offers an actionable refresh", async () => {
    const duplicateCandidate = {
      identity: {
        identityKey: "container:11111111-2222-3333-4444-555555555555",
        instanceId: "USB\\VID_1A86&PID_55D3\\CONTROLLER-1",
        containerId: "11111111-2222-3333-4444-555555555555",
        hardwareIds: ["USB\\VID_1A86&PID_55D3"],
        serialNumber: null,
      },
      currentPort: "COM5",
      friendlyName: "下位机串口",
      readiness: "blocked" as const,
      readinessCode: "DEVICE_BINDING_AMBIGUOUS",
      readinessMessage: "duplicate observation",
    };
    getDeviceBindingsMock.mockResolvedValueOnce({
      roles: [
        {
          role: "lower_controller",
          binding: null,
          currentPort: null,
          ready: false,
          code: "DEVICE_BINDING_AMBIGUOUS",
          message: "same identity observed more than once",
          ambiguous: true,
          ambiguityKind: "duplicate_observation",
          ambiguityPorts: ["COM5", "COM5"],
          legacyPortHint: "COM5",
          candidates: [duplicateCandidate, { ...duplicateCandidate }],
          discoveryDiagnostics: [],
        },
      ],
    });
    const host = await mountView();
    const role = await vi.waitFor(() => {
      const element = host.querySelector(
        "[data-test='device-binding-lower_controller']",
      );
      expect(element).not.toBeNull();
      return element as HTMLElement;
    });

    expect(role.textContent).toContain("拔除重复设备后刷新");
    expect(
      Array.from(role.querySelectorAll("button")).some((button) =>
        ["测试", "确认绑定"].includes(button.textContent?.trim() ?? ""),
      ),
    ).toBe(false);
    buttonByText(role, "刷新设备").click();
    await vi.waitFor(() => {
      expect(getDeviceBindingsMock).toHaveBeenCalledTimes(2);
    });
  });

  it("tests then confirms each stable device identity through protected maintenance", async () => {
    const host = await mountView();
    await vi.waitFor(() => {
      expect(
        host.querySelector("[data-test='device-binding-lower_controller']"),
      ).not.toBeNull();
    });
    expect(host.textContent).toContain("下位机串口 · COM5");
    expect(host.textContent).toContain("迁移提示：COM5（不作为绑定）");

    await unlockMaintenance(host);
    buttonByText(host, "测试").click();
    await vi.waitFor(() => {
      expect(testDeviceBindingMock).toHaveBeenCalledWith(
        "lower_controller",
        "container:11111111-2222-3333-4444-555555555555",
      );
    });

    const confirm = buttonByText(host, "确认绑定");
    await vi.waitFor(() => {
      expect(confirm.disabled).toBe(false);
    });
    confirm.click();
    await vi.waitFor(() => {
      expect(confirmDeviceBindingMock).toHaveBeenCalledWith(
        "lower_controller",
        "container:11111111-2222-3333-4444-555555555555",
        "11111111-2222-4333-8444-555555555555",
      );
    });
  });

  it("shows production maintenance without editable deployment or debug configuration fields", async () => {
    const host = await mountView();

    expect(host.textContent).toContain("确认补货");
    expect(host.textContent).toContain("补货后");
    expect(host.textContent).toContain("维护控制台");
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

    expect(host.textContent).not.toContain("机器编号");
    expect(host.textContent).not.toContain("机器密钥状态");
    expect(host.textContent).not.toContain("MQTT 签名密钥状态");
    expect(host.textContent).not.toContain("MQTT 密码状态");
    expect(host.textContent).not.toContain("后端 API 地址");
    expect(host.textContent).not.toContain("MQTT 地址");
    expect(host.textContent).not.toContain("硬件适配器");
    expect(host.textContent).not.toContain("扫码器适配器");
    expect(host.textContent).not.toContain("visionWsUrl");
    expect(host.textContent).not.toContain("MockHardwareControls");
    expect(
      host.querySelector("input[type='password']:not([aria-label='维护 PIN'])"),
    ).toBeNull();
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

    expect(host.textContent).toContain("机器编号");
    expect(host.textContent).toContain("机器位置标签");
    expect(host.textContent).toContain("机器密钥状态");
    expect(host.textContent).toContain("MQTT 签名密钥状态");
    expect(host.textContent).toContain("MQTT 密码状态");
    expect(host.textContent).toContain("后端 API 地址");
    expect(host.textContent).toContain("MQTT 地址");
    expect(host.textContent).toContain("硬件适配器");
    expect(host.textContent).toContain("扫码器适配器");
    expect(host.textContent).toContain("视觉 WebSocket 地址");
    expect(host.textContent).toContain("视觉试衣预览诊断");
    expect(host.textContent).toContain("用于现场检查试衣预览通道");
    expect(host.textContent).toContain("MockHardwareControls");
    expect(Array.from(select.options).map((option) => option.value)).toEqual([
      "mock",
      "serial",
    ]);
    expect(host.textContent).not.toContain("bluetooth");
    expect(host.textContent).not.toContain("vendor_sdk");
  });

  it("starts and stops the vision try-on preview diagnostic session", async () => {
    initializeMock.mockResolvedValueOnce({
      baseUrl: "http://127.0.0.1:7891",
      token: "token-1",
      source: "tauri_ready_file",
      mock: false,
      runtimeFlags: {
        advancedMaintenanceConfig: true,
      },
    });
    const stop = vi.fn().mockResolvedValue(undefined);
    openVisionTryOnSessionMock.mockResolvedValueOnce({
      sessionId: "maintenance-session-42",
      previewUrl: "http://127.0.0.1:7892/try-on/maintenance-42.mjpeg",
      streamType: "mjpeg",
      stop,
    });
    const host = await mountView();

    buttonByText(host, "启动试衣预览").click();
    await vi.waitFor(() => {
      expect(openVisionTryOnSessionMock).toHaveBeenCalledWith(
        expect.objectContaining({
          visionWsUrl: "ws://127.0.0.1:7892/ws",
        }),
        {
          catalogKey: "maintenance-diagnostic",
          variantId: "maintenance-diagnostic",
        },
      );
    });
    const preview = imgByTest(host, "try-on-camera-preview");
    expect(preview.getAttribute("src")).toBe(
      "http://127.0.0.1:7892/try-on/maintenance-42.mjpeg",
    );
    expect(host.textContent).toContain("maintenance-session-42");
    expect(host.textContent).toContain("mjpeg");

    buttonByText(host, "释放试衣预览").click();
    await vi.waitFor(() => {
      expect(stop).toHaveBeenCalledOnce();
    });
    expect(
      host.querySelector("[data-test='try-on-camera-preview']"),
    ).toBeNull();
  });

  it("blocks the retired direct configuration save entrypoint", async () => {
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
    await unlockMaintenance(host);
    const button = buttonByText(
      host,
      "直接配置编辑已禁用；请使用首次部署控制台",
    );
    expect(button.disabled).toBe(true);
    button.click();
    await nextTick();
    expect(saveConfigMock).not.toHaveBeenCalled();
  });

  it("releases the vision try-on preview diagnostic session on unmount", async () => {
    initializeMock.mockResolvedValueOnce({
      baseUrl: "http://127.0.0.1:7891",
      token: "token-1",
      source: "tauri_ready_file",
      mock: false,
      runtimeFlags: {
        advancedMaintenanceConfig: true,
      },
    });
    const stop = vi.fn().mockResolvedValue(undefined);
    openVisionTryOnSessionMock.mockResolvedValueOnce({
      sessionId: "maintenance-session-99",
      previewUrl: "http://127.0.0.1:7892/try-on/maintenance-99.mjpeg",
      streamType: "mjpeg",
      stop,
    });
    const host = await mountView();

    buttonByText(host, "启动试衣预览").click();
    await vi.waitFor(() => {
      expect(host.textContent).toContain("maintenance-session-99");
    });

    mountedApp?.unmount();
    mountedApp = null;
    await vi.waitFor(() => {
      expect(stop).toHaveBeenCalledOnce();
    });
  });

  it("shows vision try-on diagnostic startup failures", async () => {
    initializeMock.mockResolvedValueOnce({
      baseUrl: "http://127.0.0.1:7891",
      token: "token-1",
      source: "tauri_ready_file",
      mock: false,
      runtimeFlags: {
        advancedMaintenanceConfig: true,
      },
    });
    openVisionTryOnSessionMock.mockRejectedValueOnce(new Error("vision down"));

    const host = await mountView();

    buttonByText(host, "启动试衣预览").click();
    await vi.waitFor(() => {
      expect(host.textContent).toContain("vision down");
    });
    expect(
      host.querySelector("[data-test='try-on-camera-preview']"),
    ).toBeNull();
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
    expect(host.textContent).not.toContain("后端 API 地址");
    expect(host.textContent).not.toContain("MQTT 地址");
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
    expect(host.textContent).toContain("确认补货");
    expect(host.textContent).toContain("后端");
    expect(host.textContent).not.toContain("SECRET-MACHINE-CODE");
    expect(host.textContent).not.toContain("https://api.secret.example/v1");
  });

  it("runs production diagnostics and log export from standard maintenance", async () => {
    const host = await mountView();
    await unlockMaintenance(host);

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

    expect(host.textContent).toContain("视觉运行状态");
    expect(host.textContent).toContain("在线 · 视觉模块就绪");
    expect(host.textContent).toContain("最新视觉诊断载荷");
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

    expect(host.textContent).toContain("来人交互");
    expect(host.textContent).toContain(
      "有人 · 未知 · 画像可用 · 2026-06-05T00:00:05.000Z",
    );
    expect(host.textContent).toContain("VISION-PRESENCE-STATUS-001");
  });

  it("shows Natural Context Degradation without blocking customer catalog return", async () => {
    getNaturalContextMock.mockResolvedValue({
      status: "unconfigured",
      machineCode: "MACHINE-NATURAL",
      checkedAt: "2026-06-30T14:00:00.000Z",
      degraded: true,
      customerFacingBlocked: false,
      externalEnvironment: {
        status: "unconfigured",
        machineId: "550e8400-e29b-41d4-a716-446655440000",
        machineCode: "MACHINE-NATURAL",
        checkedAt: "2026-06-30T14:00:00.000Z",
        diagnostic: {
          reason: "machine_geo_location_missing",
          message: "Machine Geo Location is not configured",
        },
      },
      localSiteSignals: {
        status: "unavailable",
      },
    });

    const host = await mountView();

    expect(getNaturalContextMock).toHaveBeenCalled();
    expect(host.textContent).toContain("自然环境上下文");
    expect(host.textContent).toContain("降级 · 未配置");
    expect(host.textContent).toContain("机器地理位置未配置");
    expect(host.textContent).not.toContain("自然环境上下文就绪失败");

    buttonByText(host, "回到目录").click();
    await vi.waitFor(() => {
      expect(routerReplaceMock).toHaveBeenCalledWith("/catalog");
    });
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
          machineAudioVolume: 0.35,
        },
      },
      configLoaded: true,
    });

    const host = await mountView();

    expect(host.textContent).toContain("音频提示设置");
    expect(host.textContent).toContain("机器音频提示");
    expect(host.textContent).toContain("全局音频提示 · 已启用");
    expect(host.textContent).toContain("来人音频提示 · 已启用");
    expect(host.textContent).toContain("交易音频提示 · 已停用");
    expect(host.textContent).toContain("机器音频音量 · 35%");
    expect(host.textContent).not.toContain("Presence audio cues");
  });

  it("keeps direct audio configuration saves unavailable", async () => {
    initializeMock.mockResolvedValueOnce({
      baseUrl: "http://127.0.0.1:7891",
      token: "token-1",
      source: "tauri_ready_file",
      mock: false,
      runtimeFlags: {
        advancedMaintenanceConfig: true,
      },
    });
    useMachineStore().$patch({
      configSummary: {
        ...provisionedConfigSummary(),
        public: {
          ...provisionedConfigSummary().public,
          machineAudioVolume: 0.35,
        },
      },
      configLoaded: true,
    });
    const host = await mountView();
    await unlockMaintenance(host);
    const input = inputByTest(host, "machine-audio-volume-percent");

    expect(input.value).toBe("35");

    const button = buttonByText(
      host,
      "直接配置编辑已禁用；请使用首次部署控制台",
    );
    expect(button.disabled).toBe(true);
    expect(saveConfigMock).not.toHaveBeenCalled();
  });

  it("asks daemon to test the selected stable endpoint before enabling heard confirmation", async () => {
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
    await unlockMaintenance(host);
    const candidate = host.querySelector(
      'input[type="radio"][value="{0.0.0.00000000}.hdmi-1"]',
    );
    if (!(candidate instanceof HTMLInputElement)) {
      throw new Error("audio output candidate radio not found");
    }
    candidate.click();
    await nextTick();

    const heard = Array.from(host.querySelectorAll("label"))
      .find((label) => label.textContent?.includes("我已经"))
      ?.querySelector('input[type="checkbox"]');
    expect(heard).toBeInstanceOf(HTMLInputElement);
    expect((heard as HTMLInputElement).disabled).toBe(true);

    buttonByText(host, "播放测试音频").click();
    await vi.waitFor(() => {
      expect(testAudioOutputMock).toHaveBeenCalledOnce();
    });

    expect(callTauriCommandMock).not.toHaveBeenCalledWith(
      "test_machine_audio_output",
      expect.anything(),
    );
    expect(testAudioOutputMock).toHaveBeenCalledWith({
      endpointId: "{0.0.0.00000000}.hdmi-1",
      audioCueSettings: {
        enabled: false,
        categories: { presence: false, transaction: false },
      },
      machineAudioVolume: 0.7,
    });
    await vi.waitFor(() => {
      expect((heard as HTMLInputElement).disabled).toBe(false);
    });
  });

  it("persists the heard output binding together with audio cue settings through protected maintenance", async () => {
    initializeMock.mockResolvedValueOnce({
      baseUrl: "http://127.0.0.1:7891",
      token: "token-1",
      source: "tauri_ready_file",
      mock: false,
      runtimeFlags: {
        advancedMaintenanceConfig: true,
      },
    });
    confirmAudioOutputMock.mockResolvedValue({
      ...provisionedConfigSummary(),
      public: {
        ...provisionedConfigSummary().public,
        machineAudioVolume: 0.42,
        machineAudioOutputBinding: {
          endpointId: "{0.0.0.00000000}.speaker-1",
          friendlyName: "Near-field speaker",
          confirmedHeardAt: "2026-07-15T06:10:00.000Z",
          confirmedObservationRevision:
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
        audioCueSettings: {
          enabled: true,
          categories: {
            presence: true,
            transaction: false,
          },
        },
      },
    });
    const host = await mountView();
    await unlockMaintenance(host);

    const selected = host.querySelector(
      'input[type="radio"][value="{0.0.0.00000000}.speaker-1"]',
    );
    if (!(selected instanceof HTMLInputElement)) {
      throw new Error("near-field speaker radio not found");
    }
    selected.click();
    await nextTick();

    const volume = inputByTest(host, "machine-audio-volume-percent");
    volume.value = "42";
    volume.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();

    buttonByText(host, "播放测试音频").click();
    await vi.waitFor(() => {
      expect(testAudioOutputMock).toHaveBeenCalledOnce();
    });

    const heardLabel = Array.from(host.querySelectorAll("label")).find((item) =>
      item.textContent?.includes("我已经在近场顾客扬声器上听到了测试音频"),
    );
    const heardCheckbox = heardLabel?.querySelector('input[type="checkbox"]');
    if (!(heardCheckbox instanceof HTMLInputElement)) {
      throw new Error("heard confirmation checkbox not found");
    }
    await vi.waitFor(() => {
      expect(heardCheckbox.disabled).toBe(false);
    });
    heardCheckbox.click();
    await nextTick();

    buttonByText(host, "保存顾客扬声器绑定与音频提示设置").click();

    await vi.waitFor(() => {
      expect(confirmAudioOutputMock).toHaveBeenCalledTimes(1);
    });
    expect(confirmAudioOutputMock.mock.calls[0]?.[0]).toEqual({
      endpointId: "{0.0.0.00000000}.speaker-1",
      testEvidenceToken: "11111111-2222-4333-8444-555555555555",
      heard: true,
      audioCueSettings: {
        enabled: false,
        categories: {
          presence: false,
          transaction: false,
        },
      },
      machineAudioVolume: 0.42,
    });
    expect(confirmAudioOutputMock.mock.calls[0]?.[0]).not.toHaveProperty(
      "confirmedAt",
    );
    await vi.waitFor(() => {
      expect(host.textContent).toContain(
        "顾客音频输出绑定与音频提示设置已保存",
      );
    });
  });

  it("clears heard evidence when the candidate or proposed audio settings change", async () => {
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
    await unlockMaintenance(host);
    const candidate = host.querySelector(
      'input[type="radio"][value="{0.0.0.00000000}.speaker-1"]',
    );
    if (!(candidate instanceof HTMLInputElement)) {
      throw new Error("audio output candidate radio not found");
    }
    candidate.click();
    await nextTick();

    buttonByText(host, "播放测试音频").click();
    await vi.waitFor(() => {
      expect(testAudioOutputMock).toHaveBeenCalledOnce();
    });

    const heard = Array.from(host.querySelectorAll("label"))
      .find((label) => label.textContent?.includes("我已经"))
      ?.querySelector('input[type="checkbox"]');
    if (!(heard instanceof HTMLInputElement)) {
      throw new Error("heard confirmation checkbox not found");
    }
    await vi.waitFor(() => {
      expect(heard.disabled).toBe(false);
    });
    heard.click();
    await nextTick();
    expect(heard.checked).toBe(true);

    const volume = inputByTest(host, "machine-audio-volume-percent");
    volume.value = "42";
    volume.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();

    expect(heard.checked).toBe(false);
    expect(heard.disabled).toBe(true);
    expect(
      buttonByText(host, "保存顾客扬声器绑定与音频提示设置").disabled,
    ).toBe(true);
  });

  it("clears heard evidence when daemon observation revision changes", async () => {
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
    await unlockMaintenance(host);
    const candidate = host.querySelector(
      'input[type="radio"][value="{0.0.0.00000000}.speaker-1"]',
    );
    if (!(candidate instanceof HTMLInputElement)) {
      throw new Error("audio output candidate radio not found");
    }
    candidate.click();
    await nextTick();

    buttonByText(host, "播放测试音频").click();
    await vi.waitFor(() => {
      expect(testAudioOutputMock).toHaveBeenCalledOnce();
    });
    const heard = Array.from(host.querySelectorAll("label"))
      .find((label) => label.textContent?.includes("我已经"))
      ?.querySelector('input[type="checkbox"]');
    if (!(heard instanceof HTMLInputElement)) {
      throw new Error("heard confirmation checkbox not found");
    }
    heard.click();
    await nextTick();

    getAudioOutputBindingMock.mockResolvedValueOnce({
      binding: null,
      currentObservation: null,
      observationRevision: `sha256:${"c".repeat(64)}`,
      candidates: [
        {
          endpointId: "{0.0.0.00000000}.speaker-1",
          friendlyName: "Near-field speaker",
          isDefault: false,
        },
      ],
      ready: false,
      code: "AUDIO_OUTPUT_BINDING_REQUIRED",
      message: "binding required",
    });
    buttonByText(host, "刷新端点").click();
    await vi.waitFor(() => {
      expect(getAudioOutputBindingMock).toHaveBeenCalledTimes(2);
    });

    await vi.waitFor(() => {
      expect(heard.checked).toBe(false);
      expect(heard.disabled).toBe(true);
    });
  });

  it("fails closed when native maintenance test playback is unavailable", async () => {
    initializeMock.mockResolvedValueOnce({
      baseUrl: "http://127.0.0.1:7891",
      token: "token-1",
      source: "tauri_ready_file",
      mock: false,
      runtimeFlags: {
        advancedMaintenanceConfig: true,
      },
    });
    testAudioOutputMock.mockRejectedValueOnce(
      new Error("native output unavailable"),
    );
    const host = await mountView();
    await unlockMaintenance(host);
    const candidate = host.querySelector(
      'input[type="radio"][value="{0.0.0.00000000}.speaker-1"]',
    );
    if (!(candidate instanceof HTMLInputElement)) {
      throw new Error("audio output candidate radio not found");
    }
    candidate.click();
    await nextTick();

    buttonByText(host, "播放测试音频").click();

    await vi.waitFor(() => {
      expect(host.textContent).toContain("native output unavailable");
    });
    expect(testAudioOutputMock).toHaveBeenCalledOnce();
    expect(host.textContent).not.toContain("当前播放驱动 · browser");
    const heard = Array.from(host.querySelectorAll("label"))
      .find((label) => label.textContent?.includes("我已经"))
      ?.querySelector('input[type="checkbox"]');
    expect(heard).toHaveProperty("disabled", true);
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

    expect(host.textContent).toContain("最新机器音频提示诊断");
    expect(host.textContent).toContain("请求的提示含义");
    expect(host.textContent).toContain("支付成功");
    expect(host.textContent).toContain("分类 · 交易音频提示");
    expect(host.textContent).toContain("播放结果 · 已播放");
    expect(host.textContent).toContain("抑制或丢弃原因 · playback completed");
    expect(host.textContent).toContain("记录时间 · 2026-06-29T07:00:01.000Z");
    expect(host.textContent).toContain("重复抑制订单键（仅调试） · ORDER-107");
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

    expect(host.textContent).toContain("播放结果 · 本地音频播放失败");
    expect(host.textContent).toContain(
      "抑制或丢弃原因 · NotAllowedError: user gesture required",
    );
    expect(host.textContent).not.toContain("Payment failed");
    expect(host.textContent).not.toContain("Readiness failure");
  });

  it.each([
    ["dispense.succeeded", "出货成功"],
    ["dispense.failed", "出货失败"],
    ["refund.pending", "退款处理中"],
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
        "重复抑制订单键（仅调试） · ORDER-REAL-CUE",
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

    expect(host.textContent).toContain("检测到顾客靠近");
    expect(host.textContent).toContain("分类 · 来人音频提示");
    expect(host.textContent).toContain("播放结果 · 已跳过");
    expect(host.textContent).toContain(
      "抑制或丢弃原因 · presence audio cue category disabled",
    );
    expect(host.textContent).toContain("记录时间 · 2026-06-29T07:10:00.000Z");
  });

  it("does not couple maintenance interactions to customer-facing audio cue playback", async () => {
    const audioCueStore = useAudioCueStore();
    audioCueStore.applySettings({
      enabled: true,
      categories: { presence: true, transaction: true },
    });

    const host = await mountView();
    await unlockMaintenance(host);

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
    expect(host.textContent).toContain("无人 · 无 · 画像不可用 · 未看到");
    expect(host.textContent).toContain("尚未返回诊断载荷。");
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
    expect(payload.textContent).toContain("已截断");
    expect(payload.textContent?.length ?? 0).toBeLessThan(14_000);
    expect(payload.textContent).not.toContain("x".repeat(5000));
  });

  it("does not expose Windows desktop exit in production customer maintenance", async () => {
    const host = await mountView();

    expect(host.textContent).not.toContain("回到 Windows 桌面");
    expect(host.textContent).not.toContain("首次部署控制台");
    expect(callTauriCommandMock).not.toHaveBeenCalled();
  });

  it("opens the bring-up console only from protected maintenance mode", async () => {
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
    await unlockMaintenance(host);

    buttonByText(host, "首次部署控制台").click();

    expect(handoffMaintenanceSessionToBringUpMock).toHaveBeenCalledOnce();
    expect(routerReplaceMock).toHaveBeenCalledWith({
      path: "/bring-up",
      query: { source: "protected-maintenance" },
    });
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
    await unlockMaintenance(host);

    buttonByText(host, "回到 Windows 桌面").click();

    await vi.waitFor(() => {
      expect(beginMaintenanceSessionMock).toHaveBeenCalledWith(
        "2468",
        [
          "maintenance.reclaim",
          "maintenance.manual_dispense",
          "maintenance.desktop_exit",
        ],
        "operator-console",
      );
      expect(callTauriCommandMock).toHaveBeenCalledWith("return_to_desktop", {
        sessionId: "maintenance-session-1",
      });
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
    await unlockMaintenance(host);
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

describe("MaintenanceView protected route continuation", () => {
  it("restores an explicit Bring-Up-to-Maintenance session without another PIN prompt", async () => {
    getMaintenanceSessionForRouteMock.mockReturnValue({
      sessionId: "continued-bring-up-session",
      expiresAt: "2030-07-14T12:00:00.000Z",
      scopes: ["maintenance.mutate"],
    });

    const host = await mountView();

    expect(getMaintenanceSessionForRouteMock).toHaveBeenCalledWith(
      "maintenance",
    );
    expect(host.textContent).toContain("已授权");
    expect(host.textContent).toContain("已继续首次部署的维护会话。");
    expect(host.textContent).not.toContain("验证并解锁");
  });
});

describe("MaintenanceView planogram-driven stock task", () => {
  it("shows recognizable slot facts without planogram, UUID, or operator inputs", async () => {
    const host = await mountView();

    expect(host.textContent).toContain("A1");
    expect(host.textContent).toContain("Mineral Water");
    expect(host.textContent).toContain("2/8");
    expect(host.textContent).toContain("未提交");
    expect(host.textContent).not.toContain("货道图版本");
    expect(host.textContent).not.toContain("记录人");
    expect(host.textContent).not.toContain(
      "550e8400-e29b-41d4-a716-446655440001",
    );
  });

  it("previews resulting refill counts and submits only additions under the daemon task", async () => {
    const host = await mountView();
    await unlockMaintenance(host);
    const addition = stockInputByLabel(host, "补货数量");
    addition.value = "2";
    addition.dispatchEvent(new Event("input"));
    await nextTick();

    expect(host.textContent).toContain("补货后 4/8");
    const button = Array.from(host.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.trim() === "确认补货",
    );
    button?.click();

    await vi.waitFor(() => {
      expect(submitStockMaintenanceBatchMock).toHaveBeenCalledWith({
        taskId: "stock-task-01",
        mode: "routine_refill",
        slots: [{ slotCode: "A1", addition: 2 }],
      });
    });
    const body = submitStockMaintenanceBatchMock.mock.calls[0]?.[0];
    expect(body).not.toHaveProperty("operatorId");
    expect(body).not.toHaveProperty("planogramVersion");
  });

  it("recovers an immutable pending refill addition and its original preview", async () => {
    const ready = stockMaintenanceTaskFixture();
    const pending = {
      ...ready,
      status: "pending" as const,
      slots: [
        {
          ...ready.slots[0],
          currentQuantity: 4,
          submittedAddition: 2,
          previewQuantity: 4,
          syncStatus: "pending" as const,
        },
      ],
    };
    getStockMaintenanceTaskMock.mockResolvedValueOnce(pending);
    const host = await mountView();
    await unlockMaintenance(host);

    const addition = stockInputByLabel(host, "补货数量");
    expect(addition.value).toBe("2");
    expect(addition.disabled).toBe(true);
    expect(host.textContent).toContain("补货后 4/8");
    const submit = buttonByText(host, "确认补货");
    expect(submit.disabled).toBe(false);
    submit.click();
    await vi.waitFor(() => {
      expect(submitStockMaintenanceBatchMock).toHaveBeenCalledWith({
        taskId: "stock-task-01",
        mode: "routine_refill",
        slots: [{ slotCode: "A1", addition: 2 }],
      });
    });
  });

  it("reprojects values when a completed historical retry returns a new ready refill task", async () => {
    const next = stockMaintenanceTaskFixture();
    next.taskId = "stock-task-02";
    next.slots[0].currentQuantity = 4;
    submitStockMaintenanceBatchMock.mockResolvedValueOnce({
      task: next,
      duplicate: true,
    });
    const host = await mountView();
    await unlockMaintenance(host);
    const addition = stockInputByLabel(host, "补货数量");
    addition.value = "2";
    addition.dispatchEvent(new Event("input"));
    await nextTick();
    buttonByText(host, "确认补货").click();

    await vi.waitFor(() => {
      expect(stockInputByLabel(host, "补货数量").value).toBe("0");
    });
    expect(host.textContent).toContain("补货后 4/8");
    expect(buttonByText(host, "确认补货").disabled).toBe(true);
  });

  it("reprojects a completed count response into a fresh refill form", async () => {
    getStockMaintenanceTaskMock.mockResolvedValueOnce(
      stockMaintenanceTaskFixture("initial_count"),
    );
    const refill = stockMaintenanceTaskFixture();
    refill.taskId = "stock-task-02";
    refill.slots[0].currentQuantity = 6;
    submitStockMaintenanceBatchMock.mockResolvedValueOnce({
      task: refill,
      duplicate: false,
    });
    const host = await mountView();
    await unlockMaintenance(host);
    const count = stockInputByLabel(host, "实际数量");
    count.value = "6";
    count.dispatchEvent(new Event("input"));
    await nextTick();
    buttonByText(host, "提交盘点").click();

    await vi.waitFor(() => {
      expect(stockInputByLabel(host, "补货数量").value).toBe("0");
    });
    expect(host.textContent).toContain("补货后 6/8");
    expect(buttonByText(host, "确认补货").disabled).toBe(true);
    const addition = stockInputByLabel(host, "补货数量");
    addition.value = "1";
    addition.dispatchEvent(new Event("input"));
    await nextTick();
    buttonByText(host, "确认补货").click();
    await vi.waitFor(() => {
      expect(submitStockMaintenanceBatchMock).toHaveBeenLastCalledWith({
        taskId: "stock-task-02",
        mode: "routine_refill",
        slots: [{ slotCode: "A1", addition: 1 }],
      });
    });
  });

  it("rejects a fractional refill without silently rewriting its value", async () => {
    const host = await mountView();
    await unlockMaintenance(host);
    const addition = stockInputByLabel(host, "补货数量");
    addition.value = "1.5";
    addition.dispatchEvent(new Event("input"));
    await nextTick();

    const button = Array.from(host.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.trim() === "确认补货",
    );
    expect(button).toBeInstanceOf(HTMLButtonElement);
    expect(button!.disabled).toBe(true);
    expect(host.textContent).not.toContain("补货后 3.5/8");
    button?.click();
    expect(submitStockMaintenanceBatchMock).not.toHaveBeenCalled();
  });

  it.each(["", "-1", "7", "NaN"])(
    "rejects invalid refill input %j",
    async (rawValue) => {
      const host = await mountView();
      await unlockMaintenance(host);
      const addition = stockInputByLabel(host, "补货数量");
      addition.value = rawValue;
      addition.dispatchEvent(new Event("input"));
      await nextTick();

      const button = buttonByText(host, "确认补货");
      expect(button.disabled).toBe(true);
      expect(host.textContent).toContain("输入无效");
      button.click();
      expect(submitStockMaintenanceBatchMock).not.toHaveBeenCalled();
    },
  );

  it("submits one complete final-quantity batch for initial stock", async () => {
    getStockMaintenanceTaskMock.mockResolvedValueOnce(
      stockMaintenanceTaskFixture("initial_count"),
    );
    const host = await mountView();
    await unlockMaintenance(host);
    const quantity = stockInputByLabel(host, "实际数量");
    quantity.value = "6";
    quantity.dispatchEvent(new Event("input"));
    await nextTick();
    const button = Array.from(host.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.trim() === "提交盘点",
    );
    button?.click();

    await vi.waitFor(() => {
      expect(submitStockMaintenanceBatchMock).toHaveBeenCalledWith({
        taskId: "stock-task-01",
        mode: "initial_count",
        slots: [{ slotCode: "A1", quantity: 6 }],
      });
    });
  });

  it.each(["", "-1", "1.5", "9", "NaN"])(
    "rejects invalid final count input %j",
    async (rawValue) => {
      getStockMaintenanceTaskMock.mockResolvedValueOnce(
        stockMaintenanceTaskFixture("initial_count"),
      );
      const host = await mountView();
      await unlockMaintenance(host);
      const quantity = stockInputByLabel(host, "实际数量");
      quantity.value = rawValue;
      quantity.dispatchEvent(new Event("input"));
      await nextTick();

      const button = buttonByText(host, "提交盘点");
      expect(button.disabled).toBe(true);
      expect(host.textContent).toContain("输入无效");
      button.click();
      expect(submitStockMaintenanceBatchMock).not.toHaveBeenCalled();
    },
  );
});
