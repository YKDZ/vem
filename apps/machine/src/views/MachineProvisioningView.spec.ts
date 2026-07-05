// @vitest-environment jsdom
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";

const {
  DaemonUnavailableErrorMock,
  routeMock,
  routerReplaceMock,
  initializeMock,
  getBringUpMock,
  getConfigMock,
  claimMachineMock,
  applyNetworkSettingsMock,
  downloadLogExportMock,
} = vi.hoisted(() => ({
  DaemonUnavailableErrorMock: class DaemonUnavailableError extends Error {
    public readonly responseCode?: string;

    constructor(message = "daemon unavailable", responseCode?: string) {
      super(message);
      this.name = "DaemonUnavailableError";
      this.responseCode = responseCode;
    }
  },
  routeMock: { query: {} as Record<string, unknown> },
  routerReplaceMock: vi.fn(),
  initializeMock: vi.fn(),
  getBringUpMock: vi.fn(),
  getConfigMock: vi.fn(),
  claimMachineMock: vi.fn(),
  applyNetworkSettingsMock: vi.fn(),
  downloadLogExportMock: vi.fn(),
}));

vi.mock("vue-router", () => ({
  useRoute: () => routeMock,
  useRouter: () => ({ replace: routerReplaceMock }),
}));

vi.mock("@/layouts/KioskLayout.vue", () => ({
  default: { template: "<main><slot /></main>" },
}));

vi.mock("@/daemon/client", () => ({
  DaemonUnavailableError: DaemonUnavailableErrorMock,
  daemonClient: {
    initialize: initializeMock,
    getBringUp: getBringUpMock,
    getConfig: getConfigMock,
    claimMachine: claimMachineMock,
    applyNetworkSettings: applyNetworkSettingsMock,
    downloadLogExport: downloadLogExportMock,
  },
}));

import MachineProvisioningView from "./MachineProvisioningView.vue";

let mountedApp: App<Element> | null = null;
let pinia: ReturnType<typeof createPinia>;

function bringUpSnapshot(overrides = {}) {
  return {
    state: "topology_mismatch",
    blockingReasons: [
      {
        code: "HARDWARE_SLOT_TOPOLOGY_MISMATCH",
        component: "topology",
        message:
          "factory hardware slot topology does not match platform expectation",
      },
    ],
    diagnostics: [
      {
        code: "LOWER_CONTROLLER_SLOT_COUNT",
        component: "lower-controller",
        message:
          "lower controller reported 4 slots but profile expects 6 slots",
      },
    ],
    readinessLevel: "not_ready",
    hardwareMode: "production",
    allowedActions: {
      configureNetwork: true,
      claimMachine: false,
      retryClaim: false,
      syncProfile: false,
      resolveTopology: true,
      runRuntimeAcceptance: false,
      runHardwareAcceptance: false,
      attestStock: false,
      startSales: false,
    },
    updatedAt: "2026-07-04T00:00:00Z",
    ...overrides,
  };
}

function provisionedConfig() {
  return {
    public: {
      machineCode: "M001",
      apiBaseUrl: "https://api.example.com/api",
      mqttUrl: "mqtt://broker.example:1883",
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
      audioCueSettings: {
        enabled: false,
        categories: {
          presence: false,
          transaction: false,
        },
      },
      kioskMode: false,
      stockMovementRetentionDays: 30,
    },
    machineSecretConfigured: true,
    mqttSigningSecretConfigured: true,
    mqttPasswordConfigured: false,
    provisioned: true,
    provisioningIssues: [],
  };
}

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  vi.clearAllMocks();
  routeMock.query = {};
  initializeMock.mockResolvedValue({
    baseUrl: "http://127.0.0.1:7891",
    token: "token-1",
    source: "browser_env",
    mock: true,
  });
  getBringUpMock.mockResolvedValue(bringUpSnapshot());
  getConfigMock.mockResolvedValue(provisionedConfig());
  claimMachineMock.mockResolvedValue({
    status: "provisioned",
    machineCode: "M001",
    restartRequested: true,
    config: provisionedConfig(),
  });
  applyNetworkSettingsMock.mockResolvedValue({
    status: "connected",
    ssid: "Store-WiFi",
    hidden: false,
    diagnostics: [],
    operatorGuidance: "现场网络已连通",
    updatedAt: "2026-07-04T00:01:00Z",
  });
  downloadLogExportMock.mockResolvedValue(new Response("logs"));
});

afterEach(() => {
  mountedApp?.unmount();
  mountedApp = null;
  document.body.innerHTML = "";
});

async function mountView(): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  mountedApp = createApp(MachineProvisioningView);
  mountedApp.use(pinia);
  mountedApp.mount(host);
  await vi.waitFor(() => {
    expect(getBringUpMock).toHaveBeenCalled();
  });
  await nextTick();
  return host;
}

function inputByLabel(host: HTMLElement, labelText: string): HTMLInputElement {
  const label = Array.from(host.querySelectorAll("label")).find((item) =>
    item.textContent?.includes(labelText),
  );
  const input = label?.querySelector("input");
  if (!(input instanceof HTMLInputElement)) {
    throw new Error(`${labelText} input not found`);
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

describe("Bring-Up Console", () => {
  it("renders bring-up state, blockers, diagnostics, and allowed actions as operator Chinese copy", async () => {
    const host = await mountView();

    expect(host.textContent).toContain("首次部署控制台");
    expect(host.textContent).toContain("货道拓扑不匹配");
    expect(host.textContent).toContain("平台货道拓扑与本机下位机返回不一致");
    expect(host.textContent).toContain("下位机返回货道数量与平台档案不一致");
    expect(host.textContent).toContain("处理货道拓扑");
    expect(host.textContent).toContain("配置现场网络");
    expect(host.textContent).toContain("本机运行验收");
    expect(host.textContent).toContain("导出现场证据");
    expect(host.textContent).not.toContain("Bring-Up Console");
    expect(host.textContent).not.toContain("daemon");
    expect(host.textContent).not.toContain("Runtime Acceptance");
    expect(host.textContent).not.toContain("Protected Maintenance Mode");
    expect(host.textContent).not.toContain(
      "factory hardware slot topology does not match platform expectation",
    );
    expect(host.textContent).not.toContain(
      "lower controller reported 4 slots but profile expects 6 slots",
    );
    expect(host.textContent).not.toContain("PROVISIONING");
    expect(host.textContent).not.toContain("HARDWARE_SLOT_TOPOLOGY_MISMATCH");
    expect(host.textContent).not.toContain("LOWER_CONTROLLER_SLOT_COUNT");
    expect(host.textContent).not.toContain("Diagnostics");
    expect(host.textContent).not.toContain("API Base URL");
  });

  it("uses a safe Chinese fallback for unknown daemon reason prose", async () => {
    getBringUpMock.mockResolvedValueOnce(
      bringUpSnapshot({
        blockingReasons: [
          {
            code: "SHELL_SCRIPT_EXIT_9009",
            component: "daemon",
            message: "daemon shell script failed with exit 9009",
          },
        ],
        diagnostics: [],
      }),
    );

    const host = await mountView();

    expect(host.textContent).toContain("存在未识别状态项");
    expect(host.textContent).toContain("请导出现场证据并交由维护人员处理");
    expect(host.textContent).not.toContain("SHELL_SCRIPT_EXIT_9009");
    expect(host.textContent).not.toContain(
      "daemon shell script failed with exit 9009",
    );
  });

  it("submits protected network settings through the daemon contract", async () => {
    const host = await mountView();
    inputByLabel(host, "无线网络名称").value = "Store-WiFi";
    inputByLabel(host, "无线网络名称").dispatchEvent(new Event("input"));
    inputByLabel(host, "无线网络密码").value = "secret-pass";
    inputByLabel(host, "无线网络密码").dispatchEvent(new Event("input"));
    await nextTick();

    buttonByText(host, "提交网络设置").click();

    await vi.waitFor(() => {
      expect(applyNetworkSettingsMock).toHaveBeenCalledWith({
        ssid: "Store-WiFi",
        password: "secret-pass",
        hidden: false,
      });
    });
    await vi.waitFor(() => {
      expect(host.textContent).toContain("现场网络已连通");
    });
    expect(inputByLabel(host, "无线网络密码").value).toBe("");
    expect(host.innerHTML).not.toContain("secret-pass");
  });

  it("clears and does not render the network password after submit failure", async () => {
    applyNetworkSettingsMock.mockRejectedValueOnce(
      new Error("adapter rejected password secret-pass"),
    );
    const host = await mountView();
    inputByLabel(host, "无线网络名称").value = "Store-WiFi";
    inputByLabel(host, "无线网络名称").dispatchEvent(new Event("input"));
    inputByLabel(host, "无线网络密码").value = "secret-pass";
    inputByLabel(host, "无线网络密码").dispatchEvent(new Event("input"));
    await nextTick();

    buttonByText(host, "提交网络设置").click();

    await vi.waitFor(() => {
      expect(applyNetworkSettingsMock).toHaveBeenCalledWith({
        ssid: "Store-WiFi",
        password: "secret-pass",
        hidden: false,
      });
    });
    await vi.waitFor(() => {
      expect(inputByLabel(host, "无线网络密码").value).toBe("");
    });
    expect(host.textContent).toContain("网络设置提交失败");
    expect(host.innerHTML).not.toContain("secret-pass");
  });

  it("submits claim and hides the entered claim code after success", async () => {
    getBringUpMock.mockResolvedValueOnce(
      bringUpSnapshot({
        state: "claim_required",
        allowedActions: {
          ...bringUpSnapshot().allowedActions,
          configureNetwork: false,
          claimMachine: true,
        },
      }),
    );
    const host = await mountView();
    const input = inputByLabel(host, "领取码");
    input.value = "abcd-2345";
    input.dispatchEvent(new Event("input"));
    await nextTick();

    input.closest("form")?.dispatchEvent(new Event("submit"));

    await vi.waitFor(() => {
      expect(claimMachineMock).toHaveBeenCalledWith("ABCD-2345");
    });
    await vi.waitFor(() => {
      expect(routerReplaceMock).toHaveBeenCalledWith("/boot");
    });
    expect(host.textContent).not.toContain("ABCD-2345");
  });

  it("keeps reclaim, local reset, and acceptance rerun disabled outside protected maintenance entry", async () => {
    const host = await mountView();

    expect(buttonByText(host, "重新领取机器").disabled).toBe(true);
    expect(buttonByText(host, "本机重置").disabled).toBe(true);
    expect(buttonByText(host, "重新运行验收").disabled).toBe(true);
  });

  it("does not let the protected maintenance query enable daemon-forbidden actions", async () => {
    routeMock.query = { source: "protected-maintenance" };
    const host = await mountView();

    const claimInput = inputByLabel(host, "领取码");
    claimInput.value = "abcd-2345";
    claimInput.dispatchEvent(new Event("input"));
    await nextTick();

    expect(buttonByText(host, "提交领取码").disabled).toBe(true);
    expect(buttonByText(host, "重新领取机器").disabled).toBe(true);
    expect(buttonByText(host, "本机重置").disabled).toBe(true);
    expect(buttonByText(host, "重新运行验收").disabled).toBe(true);
  });

  it("exports field evidence through the daemon log export entry point", async () => {
    const host = await mountView();

    buttonByText(host, "导出现场证据").click();

    await vi.waitFor(() => {
      expect(downloadLogExportMock).toHaveBeenCalledOnce();
    });
    await vi.waitFor(() => {
      expect(host.textContent).toContain("现场证据已导出");
    });
  });
});
