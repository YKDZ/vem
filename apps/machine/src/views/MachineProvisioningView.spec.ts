// @vitest-environment jsdom
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";

const {
  DaemonUnavailableErrorMock,
  routerReplaceMock,
  getBringUpMock,
  executeBringUpTaskMock,
  scanWifiNetworksMock,
} = vi.hoisted(() => ({
  DaemonUnavailableErrorMock: class DaemonUnavailableError extends Error {},
  routerReplaceMock: vi.fn(),
  getBringUpMock: vi.fn(),
  executeBringUpTaskMock: vi.fn(),
  scanWifiNetworksMock: vi.fn(),
}));

vi.mock("vue-router", () => ({
  useRouter: () => ({ replace: routerReplaceMock }),
}));
vi.mock("@/layouts/KioskLayout.vue", () => ({
  default: { template: "<main><slot /></main>" },
}));
vi.mock("@/daemon/client", () => ({
  DaemonUnavailableError: DaemonUnavailableErrorMock,
  daemonClient: {
    getBringUp: getBringUpMock,
    executeBringUpTask: executeBringUpTaskMock,
    scanWifiNetworks: scanWifiNetworksMock,
  },
}));

import MachineProvisioningView from "./MachineProvisioningView.vue";

let mountedApp: App<Element> | null = null;

function snapshot(overrides = {}) {
  return {
    state: "network_required",
    blockingReasons: [],
    diagnostics: [],
    readinessLevel: "not_ready",
    hardwareMode: "production",
    allowedActions: {
      configureNetwork: true,
      claimMachine: false,
      retryClaim: false,
      syncProfile: false,
      resolveTopology: false,
      runRuntimeAcceptance: false,
      runHardwareAcceptance: false,
      attestStock: false,
      startSales: false,
    },
    currentTask: {
      contractVersion: 1,
      kind: "configure_network",
      intent: "refresh_network",
      rotateMaintenanceIdentity: false,
      projection: {
        type: "network_settings",
        supportsHiddenNetwork: true,
        supportsExistingNetworkProbe: true,
      },
    },
    progress: [
      { kind: "network", status: "current", evidence: "volatile" },
      { kind: "provisioning", status: "upcoming", evidence: "durable" },
    ],
    updatedAt: "2026-07-04T00:00:00Z",
    ...overrides,
  };
}

function provisionedConfig() {
  return {
    public: {},
    machineSecretConfigured: true,
    mqttSigningSecretConfigured: true,
    mqttPasswordConfigured: false,
    provisioned: true,
    provisioningIssues: [],
  };
}

async function mountView(): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  mountedApp = createApp(MachineProvisioningView);
  mountedApp.use(createPinia());
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
  if (!(input instanceof HTMLInputElement))
    throw new Error(`${labelText} input not found`);
  return input;
}

function buttonByText(host: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(host.querySelectorAll("button")).find((item) =>
    item.textContent?.includes(text),
  );
  if (!(button instanceof HTMLButtonElement))
    throw new Error(`${text} button not found`);
  return button;
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  getBringUpMock.mockResolvedValue(snapshot());
  executeBringUpTaskMock.mockResolvedValue({
    status: "connected",
    ssid: "Store-WiFi",
    hidden: false,
    diagnostics: [],
    operatorGuidance: "现场网络已连通",
    updatedAt: "2026-07-04T00:01:00Z",
  });
  scanWifiNetworksMock.mockResolvedValue({
    networks: [
      {
        ssid: "Store-WiFi",
        signalQuality: 91,
        security: "wpa2_personal",
        connected: false,
        profileSaved: false,
      },
    ],
  });
});

afterEach(() => {
  mountedApp?.unmount();
  mountedApp = null;
  document.body.innerHTML = "";
});

describe("Bring-Up Console", () => {
  it("renders exactly the daemon-projected current task without disabled pseudo-actions", async () => {
    const host = await mountView();

    expect(host.textContent).toContain("当前任务：配置现场网络");
    expect(host.textContent).toContain("机器领取 · 后续");
    expect(host.querySelectorAll("button:disabled")).toHaveLength(0);
    expect(host.textContent).not.toContain("提交领取码");
    expect(host.textContent).not.toContain("本机运行验收");
  });

  it("submits the daemon-projected network intent and clears the password", async () => {
    const host = await mountView();
    const select = host.querySelector("select");
    if (!(select instanceof HTMLSelectElement))
      throw new Error("network selector not found");
    await vi.waitFor(() => {
      expect(select.options).toHaveLength(2);
    });
    select.value = "Store-WiFi";
    select.dispatchEvent(new Event("change"));
    const password = inputByLabel(host, "无线网络密码");
    password.value = "secret-pass";
    password.dispatchEvent(new Event("input"));
    await nextTick();

    buttonByText(host, "提交网络设置").click();
    await vi.waitFor(() => {
      expect(executeBringUpTaskMock).toHaveBeenCalledWith(
        expect.objectContaining({ intent: "refresh_network" }),
        {
          type: "configure_network",
          ssid: "Store-WiFi",
          password: "secret-pass",
          hidden: false,
        },
      );
    });
    await vi.waitFor(() => {
      expect(password.value).toBe("");
    });
    expect(host.innerHTML).not.toContain("secret-pass");
  });

  it("probes an existing wired or connected Wi-Fi network through the daemon cursor", async () => {
    const host = await mountView();
    executeBringUpTaskMock.mockResolvedValueOnce({
      status: "connected",
      ssid: "existing-network",
      hidden: false,
      diagnostics: [],
      operatorGuidance: "已验证现有网络",
      updatedAt: "2026-07-04T00:00:00Z",
    });

    buttonByText(host, "验证现有网络").click();

    await vi.waitFor(() => {
      expect(executeBringUpTaskMock).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "configure_network",
          intent: "refresh_network",
        }),
        { type: "probe_network" },
      );
    });
  });

  it("renders only the claim form when the daemon advances to machine claim", async () => {
    getBringUpMock.mockResolvedValue(
      snapshot({
        state: "claim_required",
        currentTask: {
          contractVersion: 1,
          kind: "claim_machine",
          intent: "claim_machine",
          rotateMaintenanceIdentity: false,
          projection: {
            type: "claim_code",
            rotateMaintenanceIdentity: false,
          },
        },
        progress: [
          { kind: "network", status: "revalidate", evidence: "volatile" },
          { kind: "provisioning", status: "current", evidence: "durable" },
        ],
      }),
    );
    const host = await mountView();
    const claimCode = inputByLabel(host, "领取码");
    claimCode.value = "abcd-2345";
    claimCode.dispatchEvent(new Event("input"));
    await nextTick();

    executeBringUpTaskMock.mockResolvedValueOnce({
      status: "provisioned",
      machineCode: "M001",
      restartRequested: true,
      config: provisionedConfig(),
    });
    buttonByText(host, "提交领取码").click();
    await vi.waitFor(() => {
      expect(executeBringUpTaskMock).toHaveBeenCalledWith(
        expect.objectContaining({ intent: "claim_machine" }),
        { type: "claim_machine", claimCode: "ABCD-2345" },
      );
    });
    expect(host.textContent).not.toContain("无线网络密码");
  });

  it("routes maintenance-owned tasks to maintenance instead of inventing a local completion", async () => {
    getBringUpMock.mockResolvedValue(
      snapshot({
        state: "topology_mismatch",
        currentTask: {
          contractVersion: 1,
          kind: "resolve_topology",
          intent: "open_maintenance",
          rotateMaintenanceIdentity: false,
          projection: { type: "topology_resolution", component: "topology" },
        },
        progress: [
          { kind: "topology", status: "current", evidence: "durable" },
        ],
      }),
    );
    const host = await mountView();

    buttonByText(host, "前往维护控制台继续").click();
    await vi.waitFor(() => {
      expect(routerReplaceMock).toHaveBeenCalledWith("/maintenance");
    });
  });
});
