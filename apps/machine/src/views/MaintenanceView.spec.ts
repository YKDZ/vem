import type { EffectiveMachineRuntimeConfiguration } from "@vem/shared";

// @vitest-environment jsdom
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";

import { WHOLE_MACHINE_LOCKED_BLOCKER_CODE } from "@/daemon/schemas";
import { useMachineStore } from "@/stores/machine";
import { useSaleCapabilityStore } from "@/stores/sale-capability";
import { saleCapabilitySnapshot } from "@/test-support/sale-capability";

const submitMachineNavigationIntentMock = vi.hoisted(() => vi.fn());
const isDaemonTransportFailureMock = vi.hoisted(() => vi.fn());

const client = vi.hoisted(() => ({
  initialize: vi.fn(),
  getEffectiveRuntimeConfiguration: vi.fn(),
  getStockMaintenanceTask: vi.fn(),
  getHealth: vi.fn(),
  getReady: vi.fn(),
  getSyncStatus: vi.fn(),
  getScannerStatus: vi.fn(),
  getVisionStatus: vi.fn(),
  getNaturalContext: vi.fn(),
  getRemoteOpsStatus: vi.fn(),
  getDeviceBindings: vi.fn(),
  getPaymentEnvironmentDiagnostic: vi.fn(),
  scanWifiNetworks: vi.fn(),
  applyNetworkSettings: vi.fn(),
  claimMachine: vi.fn(),
  testDeviceBinding: vi.fn(),
  confirmDeviceBinding: vi.fn(),
  clearDeviceBinding: vi.fn(),
  setScannerProtocolParameters: vi.fn(),
  setAudioPreferences: vi.fn(),
  clearWholeMachineMaintenanceLock: vi.fn(),
  submitStockMaintenanceBatch: vi.fn(),
  runHardwareSelfCheck: vi.fn(),
  runManualDispenseDiagnostic: vi.fn(),
}));

vi.mock("@/daemon/client", () => ({
  daemonClient: client,
  isDaemonTransportFailure: isDaemonTransportFailureMock,
}));
vi.mock("@/router/transaction-route-authority", () => ({
  submitMachineNavigationIntent: submitMachineNavigationIntentMock,
}));
vi.mock("@/components/VisionCameraMaintenancePanel.vue", () => ({
  default: { template: "<section data-test='vision-panel-stub' />" },
}));

import MaintenanceView from "./MaintenanceView.vue";

let mountedApp: App<Element> | null = null;
let pinia: ReturnType<typeof createPinia>;
let currentConfiguration: EffectiveMachineRuntimeConfiguration;

function configuration(claimed: boolean): EffectiveMachineRuntimeConfiguration {
  const machine = claimed
    ? {
        id: "550e8400-e29b-41d4-a716-446655440001",
        code: "MACHINE-001",
        name: "Machine",
        status: "online",
        locationLabel: null,
      }
    : null;
  return {
    schemaVersion: 1,
    generation: claimed ? 2 : 1,
    sourceRevisions: {
      bootstrapSchemaVersion: 1,
      profile: claimed
        ? {
            generation: 2,
            profileRevision: 7,
            acceptedAt: "2026-07-17T08:00:00.000Z",
          }
        : null,
      localSettingsRevision: 3,
    },
    sourceDocuments: {
      bootstrap: {
        schemaVersion: 1,
        provisioningApiBaseUrl: "https://platform.example/api",
        hardwareModel: "vem-prod-24",
        topology: { identity: "vem-prod-24", version: "v1" },
      },
      profileCache: claimed ? ({ profile: { machine } } as never) : null,
    },
    machine: machine as never,
    platform: null,
    hardware: {
      model: "vem-prod-24",
      topology: { identity: "vem-prod-24", version: "v1" },
      expectedProfile: null,
      lowerControllerBinding: null,
      scannerBinding: null,
      scannerProtocol: { baudRate: 9600, frameSuffix: "crlf" },
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
    profileRefresh: {
      status: claimed ? "accepted" : "unclaimed",
      lastError: null,
    },
  };
}

function deviceBindings() {
  const identity = {
    identityKey: "container:11111111-2222-3333-4444-555555555555",
    instanceId: "USB\\VID_1234&PID_5678\\SCAN-001",
    containerId: "11111111-2222-3333-4444-555555555555",
    hardwareIds: ["USB\\VID_1234&PID_5678"],
    serialNumber: "SCAN-001",
  };
  return {
    roles: [
      {
        role: "lower_controller",
        binding: null,
        currentPort: null,
        ready: false,
        code: "DEVICE_BINDING_REQUIRED",
        message: "select lower controller",
        ambiguous: false,
        ambiguityKind: null,
        ambiguityPorts: [],
        legacyPortHint: null,
        candidates: [],
        discoveryDiagnostics: [],
      },
      {
        role: "scanner",
        binding: {
          identity,
          confirmedAt: "2026-07-17T07:00:00.000Z",
          confirmedBy: "operator",
          testEvidenceCode: "SCANNER_READY",
        },
        currentPort: "COM7",
        ready: true,
        code: "DEVICE_BINDING_READY",
        message: "scanner ready",
        ambiguous: false,
        ambiguityKind: null,
        ambiguityPorts: [],
        legacyPortHint: "COM3",
        candidates: [
          {
            identity,
            currentPort: "COM7",
            friendlyName: "Payment scanner",
            readiness: "ready",
            readinessCode: "SCANNER_READY",
            readinessMessage: "scanner ready",
          },
        ],
        discoveryDiagnostics: [],
      },
    ],
  };
}

function health() {
  return {
    status: "healthy",
    process: {
      component: "daemon",
      level: "ok",
      code: "READY",
      message: "daemon ready",
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

async function flush(): Promise<void> {
  await Promise.resolve();
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

async function render(): Promise<HTMLElement> {
  document.body.innerHTML = "<div id='app'></div>";
  const app = createApp(MaintenanceView);
  app.use(pinia);
  mountedApp = app;
  app.mount("#app");
  await flush();
  return document.querySelector<HTMLElement>("#app")!;
}

function button(host: HTMLElement, name: string): HTMLButtonElement {
  const result = Array.from(host.querySelectorAll("button")).find((candidate) =>
    candidate.textContent?.trim().includes(name),
  );
  if (!result) throw new Error(`button ${name} not found`);
  return result;
}

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  vi.clearAllMocks();
  localStorage.clear();
  currentConfiguration = configuration(false);
  client.getEffectiveRuntimeConfiguration.mockImplementation(
    async () => currentConfiguration,
  );
  client.getStockMaintenanceTask.mockResolvedValue({
    taskId: "stock-1",
    mode: "routine_refill",
    status: "ready",
    slots: [],
  });
  client.getHealth.mockResolvedValue(health());
  client.getReady.mockResolvedValue({
    ready: false,
    updatedAt: "2026-07-17T00:00:00.000Z",
  });
  client.getSyncStatus.mockResolvedValue({
    mqttRunning: true,
    mqttConnected: true,
    brokerUrlMasked: null,
    lastHeartbeatAt: null,
    lastCommandNo: null,
    outboxSize: 0,
    outboxMax: 10,
    outboxUsage: 0,
    nextRetryAt: null,
    lastError: null,
    tlsAuthStatus: null,
  });
  client.getScannerStatus.mockResolvedValue({
    online: true,
    adapter: "serial_text",
    port: "COM7",
    level: "ready",
    code: "SCANNER_READY",
    message: "scanner ready",
    updatedAt: "2026-07-17T00:00:00.000Z",
  });
  client.getVisionStatus.mockResolvedValue({
    enabled: false,
    online: false,
    message: "vision ready",
    latestDiagnosticPayload: null,
  });
  client.getNaturalContext.mockResolvedValue({
    status: "unconfigured",
    machineCode: "MACHINE-001",
    checkedAt: "2026-07-17T00:00:00.000Z",
    degraded: false,
    customerFacingBlocked: false,
    externalEnvironment: null,
    localSiteSignals: null,
  });
  client.getRemoteOpsStatus.mockResolvedValue({
    lastPolledAt: null,
    pending: 0,
    lastError: null,
    processing: null,
  });
  client.getDeviceBindings.mockResolvedValue(deviceBindings());
  client.getPaymentEnvironmentDiagnostic.mockResolvedValue({
    environment: "production",
    readiness: "ready",
    errorCategory: "none",
    channels: [],
  });
  client.scanWifiNetworks.mockResolvedValue({
    status: "available",
    networks: [{ ssid: "Venue-Wifi" }],
    operatorGuidance: "",
    updatedAt: "2026-07-17T00:00:00.000Z",
  });
  client.applyNetworkSettings.mockResolvedValue({
    status: "connected",
    ssid: "Venue-Wifi",
    hidden: false,
    diagnostics: [],
    operatorGuidance: "network connected",
    updatedAt: "2026-07-17T00:00:00.000Z",
  });
  client.claimMachine.mockImplementation(async () => {
    currentConfiguration = configuration(true);
    return {
      status: "provisioned",
      machineCode: "MACHINE-001",
      restartRequested: false,
    };
  });
  client.initialize.mockResolvedValue(undefined);
  isDaemonTransportFailureMock.mockReturnValue(false);
  client.testDeviceBinding.mockResolvedValue({
    identityKey: "container:11111111-2222-3333-4444-555555555555",
    currentPort: "COM7",
    testEvidenceToken: "550e8400-e29b-41d4-a716-446655440099",
  });
  client.confirmDeviceBinding.mockResolvedValue({});
  client.clearDeviceBinding.mockResolvedValue(configuration(false));
  client.setScannerProtocolParameters.mockResolvedValue(configuration(false));
  client.setAudioPreferences.mockImplementation(async (preferences) => {
    currentConfiguration = {
      ...currentConfiguration,
      generation: currentConfiguration.generation + 1,
      sourceRevisions: {
        ...currentConfiguration.sourceRevisions,
        localSettingsRevision:
          currentConfiguration.sourceRevisions.localSettingsRevision + 1,
      },
      experience: {
        ...currentConfiguration.experience,
        audio: preferences,
      },
    };
    return currentConfiguration;
  });
  client.clearWholeMachineMaintenanceLock.mockResolvedValue({ cleared: true });
  client.submitStockMaintenanceBatch.mockImplementation(async (request) => ({
    task: {
      taskId: request.taskId,
      mode: request.mode,
      status: "pending",
      slots: [],
    },
    duplicate: false,
  }));
  client.runHardwareSelfCheck.mockResolvedValue({
    online: true,
    message: "hardware ready",
    portPath: "COM1",
    resolutionSource: "stable_identity",
    boundUsbIdentity: null,
    candidates: [],
    configUpdated: false,
  });
  client.runManualDispenseDiagnostic.mockResolvedValue({
    diagnosticId: "manual-dispense-1",
    outcome: "completed",
    stockReconciliationRequired: true,
    reconciliationStatus: "open",
    replayed: false,
  });
});

afterEach(() => {
  mountedApp?.unmount();
  mountedApp = null;
  vi.useRealTimers();
});

describe("Local Operations", () => {
  it("keeps clean bootstrap commissioning in Local Operations and reloads the effective snapshot after a direct claim", async () => {
    const host = await render();

    expect(host.textContent).toContain("本地运维");
    expect(host.textContent).toContain("网络与认领");
    expect(host.textContent).not.toContain("Runtime Bootstrap 所有者");
    expect(host.textContent).not.toContain("Provisioning Profile 所有者");
    expect(host.querySelector("input[aria-label='网络密码']")).not.toBeNull();

    const claimCode = host.querySelector<HTMLInputElement>(
      "input[aria-label='认领码']",
    );
    if (!claimCode) throw new Error("claim input not found");
    claimCode.value = "claim-001";
    claimCode.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    button(host, "认领机器").click();
    await flush();

    expect(client.claimMachine).toHaveBeenCalledWith("claim-001");
    expect(client.getEffectiveRuntimeConfiguration).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => {
      expect(host.textContent).toContain("MACHINE-001");
      expect(host.textContent).toContain("平台配置已接受");
    });
  });

  it("scans and applies Wi-Fi from the same pre-claim Local Operations surface", async () => {
    const host = await render();
    const initialReloads =
      client.getEffectiveRuntimeConfiguration.mock.calls.length;

    button(host, "扫描网络").click();
    await flush();
    expect(client.scanWifiNetworks).toHaveBeenCalledOnce();
    expect(host.textContent).toContain("Venue-Wifi");

    const ssid = host.querySelector<HTMLInputElement>(
      "input[aria-label='网络名称']",
    );
    const password = host.querySelector<HTMLInputElement>(
      "input[aria-label='网络密码']",
    );
    if (!ssid || !password) throw new Error("network inputs not found");
    ssid.value = "Venue-Wifi";
    ssid.dispatchEvent(new Event("input", { bubbles: true }));
    password.value = "network-secret";
    password.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    button(host, "应用网络").click();
    await flush();

    expect(client.applyNetworkSettings).toHaveBeenCalledWith({
      ssid: "Venue-Wifi",
      password: "network-secret",
      hidden: false,
    });
    expect(
      client.getEffectiveRuntimeConfiguration.mock.calls.length,
    ).toBeGreaterThan(initialReloads);
    expect(password.value).toBe("");
  });

  it("keeps rejected network credentials editable on the same pre-claim Local Operations surface", async () => {
    client.applyNetworkSettings.mockRejectedValueOnce(
      new Error("wireless authentication failed"),
    );
    const host = await render();
    const ssid = host.querySelector<HTMLInputElement>(
      "input[aria-label='网络名称']",
    );
    const password = host.querySelector<HTMLInputElement>(
      "input[aria-label='网络密码']",
    );
    if (!ssid || !password) throw new Error("network inputs not found");
    ssid.value = "Venue-Wifi";
    ssid.dispatchEvent(new Event("input", { bubbles: true }));
    password.value = "wrong-password";
    password.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();

    button(host, "应用网络").click();
    await flush();

    expect(client.applyNetworkSettings).toHaveBeenCalledWith({
      ssid: "Venue-Wifi",
      password: "wrong-password",
      hidden: false,
    });
    expect(password.value).toBe("wrong-password");
    expect(host.textContent).toContain("wireless authentication failed");
    expect(host.querySelector("input[aria-label='认领码']")).not.toBeNull();
  });

  it("keeps a rejected claim in Local Operations with direct operator feedback", async () => {
    client.claimMachine.mockRejectedValueOnce(new Error("claim code rejected"));
    const host = await render();
    const claimCode = host.querySelector<HTMLInputElement>(
      "input[aria-label='认领码']",
    );
    if (!claimCode) throw new Error("claim input not found");
    claimCode.value = "bad-claim";
    claimCode.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    button(host, "认领机器").click();
    await flush();

    expect(client.claimMachine).toHaveBeenCalledWith("bad-claim");
    expect(host.textContent).toContain("claim code rejected");
    expect(host.textContent).toContain("本地运维");
  });

  it("accepts a persisted claim after the expected daemon IPC disconnect", async () => {
    client.claimMachine.mockRejectedValueOnce(new Error("daemon disconnected"));
    isDaemonTransportFailureMock.mockReturnValue(true);
    const host = await render();
    currentConfiguration = configuration(true);
    const claimCode = host.querySelector<HTMLInputElement>(
      "input[aria-label='认领码']",
    );
    if (!claimCode) throw new Error("claim input not found");
    claimCode.value = "claim-001";
    claimCode.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    button(host, "认领机器").click();
    await flush();

    expect(client.initialize).toHaveBeenCalledWith(true);
    await vi.waitFor(() => {
      expect(host.textContent).toContain("MACHINE-001");
      expect(host.querySelector("input[aria-label='认领码']")).toBeNull();
    });
  });

  it("renders the generated whole-machine lock snapshot and exposes its clear action", async () => {
    const host = await render();
    useSaleCapabilityStore().acceptSnapshot(
      saleCapabilitySnapshot({
        canStartSale: false,
        blockerCode: WHOLE_MACHINE_LOCKED_BLOCKER_CODE,
        blockerMessage: "lower controller recovery is required",
      }),
    );
    await nextTick();

    expect(host.textContent).toContain("整机维护锁");
    expect(host.textContent).toContain("lower controller recovery is required");
    expect(button(host, "确认解除整机锁")).toBeTruthy();
  });

  it.each([
    ["MACHINE_AUTH_MISSING", "完成机器认领", "网络与认领"],
    ["NO_SALEABLE_SLOTS", "打开库存维护", "库存维护"],
  ])(
    "opens %s recovery in its owning maintenance task",
    async (code, action, task) => {
      const host = await render();
      useSaleCapabilityStore().acceptSnapshot(
        saleCapabilitySnapshot({
          canStartSale: false,
          blockerCode: code,
          blockerMessage: "runtime diagnostic evidence",
        }),
      );
      await flush();

      button(host, action).click();
      await nextTick();

      expect(host.querySelector("h1")?.textContent).toContain(task);
    },
  );

  it("hard-removes retired scanner binding and protocol mutation controls", async () => {
    const host = await render();

    expect(
      host.querySelector("[data-test='device-binding-scanner']"),
    ).toBeNull();
    expect(host.querySelector("form[aria-label='扫码器协议']")).toBeNull();
    expect(host.textContent).not.toContain("确认绑定");
    expect(host.textContent).not.toContain("清除绑定");
    expect(host.textContent).not.toContain("应用扫码器协议");
    expect(client.getDeviceBindings).not.toHaveBeenCalled();
    expect(client.testDeviceBinding).not.toHaveBeenCalled();
    expect(client.confirmDeviceBinding).not.toHaveBeenCalled();
    expect(client.clearDeviceBinding).not.toHaveBeenCalled();
    expect(client.setScannerProtocolParameters).not.toHaveBeenCalled();
  });

  it("refreshes the daemon-owned audio preferences after each save", async () => {
    const host = await render();
    const initialReloads =
      client.getEffectiveRuntimeConfiguration.mock.calls.length;
    const transactionCuesEnabled = host.querySelector<HTMLInputElement>(
      "[data-test='machine-audio-transaction-enabled']",
    );
    if (!transactionCuesEnabled)
      throw new Error("transaction audio checkbox not found");
    transactionCuesEnabled.checked = false;
    transactionCuesEnabled.dispatchEvent(
      new Event("change", { bubbles: true }),
    );
    await flush();

    await vi.waitFor(() => {
      expect(client.setAudioPreferences).toHaveBeenCalledWith({
        volume: 0.7,
        cuesEnabled: true,
        presenceCuesEnabled: true,
        transactionCuesEnabled: false,
      });
    });

    const volume = host.querySelector<HTMLInputElement>(
      "[data-test='machine-audio-volume-percent']",
    );
    if (!volume) throw new Error("machine audio volume input not found");
    volume.value = "35";
    volume.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();

    await vi.waitFor(() => {
      expect(client.setAudioPreferences).toHaveBeenLastCalledWith({
        volume: 0.35,
        cuesEnabled: true,
        presenceCuesEnabled: true,
        transactionCuesEnabled: false,
      });
    });
    expect(client.getEffectiveRuntimeConfiguration.mock.calls.length).toBe(
      initialReloads + 2,
    );
    expect(transactionCuesEnabled.checked).toBe(false);
    expect(volume.value).toBe("35");
    expect(useMachineStore().customerAudio).toEqual({
      volume: 0.35,
      cuesEnabled: true,
      presenceCuesEnabled: true,
      transactionCuesEnabled: false,
    });
  });

  it("runs hardware and manual dispense diagnostics directly without an authorization interstitial", async () => {
    client.getStockMaintenanceTask.mockResolvedValueOnce({
      taskId: "stock-task-01",
      mode: "routine_refill",
      status: "ready",
      slots: [
        {
          slotId: "A1",
          rowNo: 1,
          cellNo: 1,
          productName: "Mineral Water",
          sku: "WATER-001",
          currentQuantity: 2,
          capacity: 8,
          submittedAddition: null,
          submittedQuantity: null,
          previewQuantity: null,
          movementId: null,
          syncStatus: "not_submitted",
          salesState: "sale_ready",
          reconciliationReason: null,
        },
      ],
    });
    const host = await render();

    button(host, "重新检查").click();
    await flush();
    expect(client.runHardwareSelfCheck).toHaveBeenCalledOnce();
    expect(host.textContent).toContain("硬件就绪");

    button(host, "出货一件").click();
    await flush();
    expect(client.runManualDispenseDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        slotId: "A1",
        quantity: 1,
        timeoutSeconds: 30,
      }),
    );
    expect(host.textContent).toContain("诊断出货完成");
  });

  it("clears hardware attention after a successful retry and when the operator changes task", async () => {
    client.runHardwareSelfCheck.mockRejectedValueOnce(
      new Error("lower controller timeout"),
    );
    const host = await render();

    button(host, "重新检查").click();
    await flush();
    expect(
      host.querySelector("[aria-label='操作提示']")?.textContent,
    ).toContain("硬件检查未完成");

    button(host, "重新检查").click();
    await flush();
    expect(host.querySelector("[aria-label='操作提示']")).toBeNull();

    client.runHardwareSelfCheck.mockRejectedValueOnce(
      new Error("lower controller timeout"),
    );
    button(host, "重新检查").click();
    await flush();
    expect(
      host.querySelector("[aria-label='操作提示']")?.textContent,
    ).toContain("硬件检查未完成");

    button(host, "库存维护").click();
    await flush();
    expect(host.querySelector("[aria-label='操作提示']")).toBeNull();
  });

  it("keeps a manual dispense idempotency key across response loss until an operator starts a new diagnostic", async () => {
    client.getStockMaintenanceTask.mockResolvedValueOnce({
      taskId: "stock-task-01",
      mode: "routine_refill",
      status: "ready",
      slots: [
        {
          slotId: "A1",
          rowNo: 1,
          cellNo: 1,
          productName: "Mineral Water",
          sku: "WATER-001",
          currentQuantity: 2,
          capacity: 8,
          submittedAddition: null,
          submittedQuantity: null,
          previewQuantity: null,
          movementId: null,
          syncStatus: "not_submitted",
          salesState: "sale_ready",
          reconciliationReason: null,
        },
      ],
    });
    client.runManualDispenseDiagnostic.mockRejectedValueOnce(
      new Error("diagnostic response lost"),
    );
    const host = await render();
    await vi.waitFor(() => {
      expect(
        host.querySelector<HTMLSelectElement>(
          "[data-test='manual-dispense-diagnostic'] select",
        )?.value,
      ).toBe("A1");
    });

    button(host, "出货一件").click();
    await flush();
    const firstRequest = client.runManualDispenseDiagnostic.mock.calls[0]?.[0];
    if (!firstRequest)
      throw new Error("first manual dispense request not found");
    expect(host.textContent).toContain("diagnostic response lost");

    button(host, "出货一件").click();
    await flush();
    const retriedRequest =
      client.runManualDispenseDiagnostic.mock.calls[1]?.[0];
    expect(retriedRequest?.idempotencyKey).toBe(firstRequest.idempotencyKey);

    button(host, "新建诊断").click();
    button(host, "出货一件").click();
    await flush();
    const newDiagnosticRequest =
      client.runManualDispenseDiagnostic.mock.calls[2]?.[0];
    expect(newDiagnosticRequest?.idempotencyKey).not.toBe(
      firstRequest.idempotencyKey,
    );
  });

  it("submits only the selected canonical stock-task slot for manual dispense", async () => {
    client.getStockMaintenanceTask.mockResolvedValueOnce({
      taskId: "stock-task-01",
      mode: "routine_refill",
      status: "ready",
      slots: [
        {
          slotId: "A1",
          rowNo: 1,
          cellNo: 1,
          productName: "Mineral Water",
          sku: "WATER-001",
          currentQuantity: 2,
          capacity: 8,
          submittedAddition: null,
          submittedQuantity: null,
          previewQuantity: null,
          movementId: null,
          syncStatus: "not_submitted",
          salesState: "sale_ready",
          reconciliationReason: null,
        },
        {
          slotId: "B3",
          rowNo: 2,
          cellNo: 3,
          productName: "Sparkling Water",
          sku: "WATER-002",
          currentQuantity: 4,
          capacity: 8,
          submittedAddition: null,
          submittedQuantity: null,
          previewQuantity: null,
          movementId: null,
          syncStatus: "not_submitted",
          salesState: "sale_ready",
          reconciliationReason: null,
        },
      ],
    });
    const host = await render();
    const slotSelect = host.querySelector<HTMLSelectElement>(
      "[data-test='manual-dispense-diagnostic'] select",
    );
    if (!slotSelect) throw new Error("manual dispense slot selector not found");
    await vi.waitFor(() => {
      expect(slotSelect.value).toBe("A1");
    });

    slotSelect.value = "B3";
    slotSelect.dispatchEvent(new Event("change", { bubbles: true }));
    await nextTick();
    button(host, "出货一件").click();
    await flush();

    expect(client.runManualDispenseDiagnostic).toHaveBeenCalledWith({
      idempotencyKey: expect.any(String),
      slotId: "B3",
      quantity: 1,
      timeoutSeconds: 30,
    });
    expect(
      host.querySelectorAll("[data-test='manual-dispense-diagnostic'] input"),
    ).toHaveLength(0);
  });

  it("submits a bounded refill task directly and retains only the daemon task and recognizable slot facts", async () => {
    client.getStockMaintenanceTask.mockResolvedValueOnce({
      taskId: "stock-task-01",
      mode: "routine_refill",
      status: "ready",
      slots: [
        {
          slotId: "A1",
          rowNo: 1,
          cellNo: 1,
          productName: "Mineral Water",
          sku: "WATER-001",
          currentQuantity: 2,
          capacity: 8,
          submittedAddition: null,
          submittedQuantity: null,
          previewQuantity: null,
          movementId: null,
          syncStatus: "not_submitted",
          salesState: "sale_ready",
          reconciliationReason: null,
        },
      ],
    });
    const host = await render();
    await vi.waitFor(() => {
      expect(host.textContent).toContain("Mineral Water");
    });
    expect(
      host.querySelector("[data-test='maintenance-task-stock']"),
    ).not.toBeNull();
    const stockPanel = host.querySelector("[data-test='stock-maintenance']");
    expect(stockPanel).not.toBeNull();
    expect(
      stockPanel?.querySelector(
        "[data-test='stock-maintenance-slot'][data-slot-id='A1'][data-sku='WATER-001']",
      ),
    ).not.toBeNull();
    const stockForm = Array.from(host.querySelectorAll("form")).find((form) =>
      form.textContent?.includes("补货数量"),
    );
    const addition = stockForm?.querySelector<HTMLInputElement>(
      "[data-test='stock-maintenance-addition'][data-slot-id='A1']",
    );
    if (!addition) throw new Error("stock addition input not found");
    addition.value = "2";
    addition.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();

    expect(
      stockPanel?.querySelector(
        "[data-test='stock-maintenance-preview'][data-slot-id='A1']",
      )?.textContent,
    ).toContain("补货后 4/8");
    expect(
      stockPanel?.querySelector("[data-test='stock-maintenance-submit']"),
    ).not.toBeNull();
    button(host, "确认补货").click();
    await flush();

    expect(client.submitStockMaintenanceBatch).toHaveBeenCalledWith({
      taskId: "stock-task-01",
      mode: "routine_refill",
      slots: [{ slotId: "A1", addition: 2 }],
    });
    expect(host.textContent).toContain("库存批次已提交");
  });

  it("rejects fractional refill input before it can issue a bounded stock mutation", async () => {
    client.getStockMaintenanceTask.mockResolvedValueOnce({
      taskId: "stock-task-01",
      mode: "routine_refill",
      status: "ready",
      slots: [
        {
          slotId: "A1",
          rowNo: 1,
          cellNo: 1,
          productName: "Mineral Water",
          sku: "WATER-001",
          currentQuantity: 2,
          capacity: 8,
          submittedAddition: null,
          submittedQuantity: null,
          previewQuantity: null,
          movementId: null,
          syncStatus: "not_submitted",
          salesState: "sale_ready",
          reconciliationReason: null,
        },
      ],
    });
    const host = await render();
    await vi.waitFor(() => {
      expect(host.textContent).toContain("Mineral Water");
    });
    const stockForm = Array.from(host.querySelectorAll("form")).find((form) =>
      form.textContent?.includes("补货数量"),
    );
    const addition = stockForm?.querySelector<HTMLInputElement>(
      "input[type='number']",
    );
    if (!addition) throw new Error("stock addition input not found");
    addition.value = "1.5";
    addition.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();

    const submit = button(host, "确认补货");
    expect(submit.disabled).toBe(true);
    expect(host.textContent).toContain("输入无效");
    submit.click();
    expect(client.submitStockMaintenanceBatch).not.toHaveBeenCalled();
  });

  it("submits complete bounded final quantities for an initial count task", async () => {
    client.getStockMaintenanceTask.mockResolvedValueOnce({
      taskId: "stock-count-01",
      mode: "initial_count",
      status: "ready",
      slots: [
        {
          slotId: "A1",
          rowNo: 1,
          cellNo: 1,
          productName: "Mineral Water",
          sku: "WATER-001",
          currentQuantity: 2,
          capacity: 8,
          submittedAddition: null,
          submittedQuantity: null,
          previewQuantity: null,
          syncStatus: "not_submitted",
          salesState: "sale_ready",
          reconciliationReason: null,
        },
      ],
    });
    const host = await render();
    await vi.waitFor(() => {
      expect(host.textContent).toContain("Mineral Water");
    });
    const stockForm = Array.from(host.querySelectorAll("form")).find((form) =>
      form.textContent?.includes("实际数量"),
    );
    const quantity = stockForm?.querySelector<HTMLInputElement>(
      "input[type='number']",
    );
    if (!quantity) throw new Error("stock quantity input not found");
    quantity.value = "6";
    quantity.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();

    button(host, "提交盘点").click();
    await flush();
    expect(client.submitStockMaintenanceBatch).toHaveBeenCalledWith({
      taskId: "stock-count-01",
      mode: "initial_count",
      slots: [{ slotId: "A1", quantity: 6 }],
    });
  });

  it("bounds the latest Vision diagnostic payload while retaining readable status", async () => {
    client.getVisionStatus.mockResolvedValue({
      enabled: true,
      online: true,
      message: "vision ready",
      latestDiagnosticPayload: {
        type: "vision.profile_result",
        payload: {
          eventId: "VISION-HUGE-004",
          warnings: ["x".repeat(20_000)],
        },
      },
    });
    const host = await render();
    const payload = host.querySelector(
      "[data-test='vision-diagnostic-payload']",
    );
    if (!(payload instanceof HTMLElement)) {
      throw new Error("vision diagnostic payload not found");
    }
    await vi.waitFor(() => {
      expect(payload.textContent).toContain("VISION-HUGE-004");
    });
    expect(payload.textContent).toContain("已截断");
    expect(payload.textContent?.length ?? 0).toBeLessThan(14_000);
    expect(host.textContent).toContain("视觉运行状态");
  });

  it("does not fabricate a test-audio success when the installed Tauri runtime is absent", async () => {
    const host = await render();

    button(host, "播放测试音频").click();
    await flush();

    expect(host.textContent).toContain(
      "Machine runtime audio coordinator is not running",
    );
    expect(host.textContent).not.toContain(
      "Windows 默认输出设备已开始测试播放",
    );
  });

  it("keeps return-to-catalog unavailable until Local Operations is sellable", async () => {
    const host = await render();
    const returnToCatalog = button(host, "返回商品目录");

    expect(returnToCatalog.disabled).toBe(true);
    expect(host.textContent).toContain("暂不能回到目录");
  });
});
