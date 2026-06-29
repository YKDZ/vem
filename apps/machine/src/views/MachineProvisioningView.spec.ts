// @vitest-environment jsdom
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";

const {
  DaemonUnavailableErrorMock,
  initializeMock,
  getConfigMock,
  claimMachineMock,
  routerReplaceMock,
} = vi.hoisted(() => ({
  DaemonUnavailableErrorMock: class DaemonUnavailableError extends Error {
    public readonly responseCode?: string;

    constructor(message = "daemon unavailable", responseCode?: string) {
      super(message);
      this.name = "DaemonUnavailableError";
      this.responseCode = responseCode;
    }
  },
  initializeMock: vi.fn(),
  getConfigMock: vi.fn(),
  claimMachineMock: vi.fn(),
  routerReplaceMock: vi.fn(),
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
    initialize: initializeMock,
    getConfig: getConfigMock,
    claimMachine: claimMachineMock,
  },
}));

import MachineProvisioningView from "./MachineProvisioningView.vue";

let mountedApp: App<Element> | null = null;
let pinia: ReturnType<typeof createPinia>;

function unprovisionedConfig() {
  return {
    public: {
      machineCode: null,
      apiBaseUrl: "https://staging-api.example.com/api",
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
    machineSecretConfigured: false,
    mqttSigningSecretConfigured: false,
    mqttPasswordConfigured: false,
    provisioned: false,
    provisioningIssues: [
      "machine_code_missing",
      "machine_secret_missing",
      "mqtt_signing_secret_missing",
    ],
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
  });
  getConfigMock.mockResolvedValue(unprovisionedConfig());
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
    expect(getConfigMock).toHaveBeenCalled();
  });
  await nextTick();
  return host;
}

describe("MachineProvisioningView standard flow", () => {
  it("asks only for a machine claim code and shows safe provisioning diagnostics", async () => {
    const host = await mountView();

    expect(host.textContent).toContain("机器领取");
    expect(host.textContent).toContain("Machine Claim Code");
    expect(host.querySelectorAll("input")).toHaveLength(1);
    expect(host.querySelector("select")).toBeNull();
    expect(host.querySelector("textarea")).toBeNull();

    expect(host.textContent).toContain("机器凭据");
    expect(host.textContent).toContain("MQTT 签名");
    expect(host.textContent).toContain("未配置");
    expect(host.textContent).not.toContain("Machine Secret");
    expect(host.textContent).not.toContain("MQTT Password");
    expect(host.textContent).not.toContain("API Base URL");
    expect(host.textContent).not.toContain("Hardware Adapter");
    expect(host.textContent).not.toContain("Scanner");
    expect(host.textContent).not.toContain("Vision");
    expect(host.textContent).not.toContain("Payment Capability");
    expect(host.textContent).not.toContain("ABCD-2345");
  });

  it("submits the claim code and returns to boot after provisioning succeeds", async () => {
    const provisioned = {
      ...unprovisionedConfig(),
      public: {
        ...unprovisionedConfig().public,
        machineCode: "M001",
      },
      machineSecretConfigured: true,
      mqttSigningSecretConfigured: true,
      provisioned: true,
      provisioningIssues: [],
    };
    claimMachineMock.mockResolvedValue({
      status: "provisioned",
      machineCode: "M001",
      restartRequested: true,
      config: provisioned,
    });
    getConfigMock.mockResolvedValueOnce(unprovisionedConfig());
    getConfigMock.mockResolvedValueOnce(provisioned);
    const host = await mountView();
    const input = host.querySelector("input");
    if (!(input instanceof HTMLInputElement)) {
      throw new Error("claim code input not found");
    }
    input.value = "abcd-2345";
    input.dispatchEvent(new Event("input"));
    await nextTick();

    host.querySelector("form")?.dispatchEvent(new Event("submit"));

    await vi.waitFor(() => {
      expect(claimMachineMock).toHaveBeenCalledWith("ABCD-2345");
    });
    await vi.waitFor(() => {
      expect(host.textContent).toContain("领取成功");
    });
    expect(host.textContent).not.toContain("ABCD-2345");
    expect(routerReplaceMock).toHaveBeenCalledWith("/boot");
  });

  it("waits for daemon config to return provisioned after restart-window IPC failures", async () => {
    const provisioned = {
      ...unprovisionedConfig(),
      public: {
        ...unprovisionedConfig().public,
        machineCode: "M001",
      },
      machineSecretConfigured: true,
      mqttSigningSecretConfigured: true,
      provisioned: true,
      provisioningIssues: [],
    };
    const restartWindowError = new DaemonUnavailableErrorMock(
      "daemon request failed",
    );
    claimMachineMock.mockResolvedValue({
      status: "provisioned",
      machineCode: "M001",
      restartRequested: true,
      config: provisioned,
    });
    getConfigMock
      .mockResolvedValueOnce(unprovisionedConfig())
      .mockRejectedValueOnce(restartWindowError)
      .mockResolvedValueOnce(provisioned);
    const host = await mountView();
    const input = host.querySelector("input");
    if (!(input instanceof HTMLInputElement)) {
      throw new Error("claim code input not found");
    }
    input.value = "abcd-2345";
    input.dispatchEvent(new Event("input"));
    await nextTick();

    host.querySelector("form")?.dispatchEvent(new Event("submit"));

    await vi.waitFor(() => {
      expect(host.textContent).toContain("正在等待 daemon 应用新配置");
    });
    expect(routerReplaceMock).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(initializeMock).toHaveBeenCalledWith(true);
      expect(routerReplaceMock).toHaveBeenCalledWith("/boot");
    });
  });

  it("shows a safe invalid-code state without echoing the submitted claim code", async () => {
    claimMachineMock.mockRejectedValue(
      Object.assign(new Error("invalid claim"), {
        responseCode: "machine_claim_invalid",
      }),
    );
    const host = await mountView();
    const input = host.querySelector("input");
    if (!(input instanceof HTMLInputElement)) {
      throw new Error("claim code input not found");
    }
    input.value = "ABCD-2345";
    input.dispatchEvent(new Event("input"));
    await nextTick();

    host.querySelector("form")?.dispatchEvent(new Event("submit"));

    await vi.waitFor(() => {
      expect(host.textContent).toContain("领取码无效");
    });
    expect(host.textContent).not.toContain("ABCD-2345");
    expect(routerReplaceMock).not.toHaveBeenCalled();
  });

  it.each([
    ["machine_claim_expired", "领取码已过期"],
    ["machine_claim_used", "领取码已使用"],
    ["machine_claim_revoked", "领取码已撤销"],
    ["machine_claim_locked", "领取码已锁定"],
    ["network_unavailable", "网络不可用"],
  ])("shows the %s failure state safely", async (responseCode, copy) => {
    claimMachineMock.mockRejectedValue(
      Object.assign(new Error("safe daemon failure"), { responseCode }),
    );
    const host = await mountView();
    const input = host.querySelector("input");
    if (!(input instanceof HTMLInputElement)) {
      throw new Error("claim code input not found");
    }
    input.value = "ABCD-2345";
    input.dispatchEvent(new Event("input"));
    await nextTick();

    host.querySelector("form")?.dispatchEvent(new Event("submit"));

    await vi.waitFor(() => {
      expect(host.textContent).toContain(copy);
    });
    expect(host.textContent).not.toContain("ABCD-2345");
  });

  it("shows a pending state while daemon provisioning is running", async () => {
    claimMachineMock.mockReturnValue(new Promise(() => undefined));
    const host = await mountView();
    const input = host.querySelector("input");
    const button = host.querySelector("button");
    if (!(input instanceof HTMLInputElement)) {
      throw new Error("claim code input not found");
    }
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error("submit button not found");
    }
    input.value = "ABCD-2345";
    input.dispatchEvent(new Event("input"));
    await nextTick();

    host.querySelector("form")?.dispatchEvent(new Event("submit"));
    await nextTick();

    expect(host.textContent).toContain("正在领取机器配置");
    expect(button.disabled).toBe(true);
  });

  it("shows local daemon unavailable when daemon IPC cannot be reached", async () => {
    claimMachineMock.mockRejectedValue(
      new DaemonUnavailableErrorMock("daemon request failed"),
    );
    const host = await mountView();
    const input = host.querySelector("input");
    if (!(input instanceof HTMLInputElement)) {
      throw new Error("claim code input not found");
    }
    input.value = "ABCD-2345";
    input.dispatchEvent(new Event("input"));
    await nextTick();

    host.querySelector("form")?.dispatchEvent(new Event("submit"));

    await vi.waitFor(() => {
      expect(host.textContent).toContain("本机 daemon 暂不可用");
    });
  });

  it("shows network unavailable when the daemon reports backend claim outage", async () => {
    claimMachineMock.mockRejectedValue(
      new DaemonUnavailableErrorMock(
        "claim backend unavailable",
        "machine_claim_backend_unavailable",
      ),
    );
    const host = await mountView();
    const input = host.querySelector("input");
    if (!(input instanceof HTMLInputElement)) {
      throw new Error("claim code input not found");
    }
    input.value = "ABCD-2345";
    input.dispatchEvent(new Event("input"));
    await nextTick();

    host.querySelector("form")?.dispatchEvent(new Event("submit"));

    await vi.waitFor(() => {
      expect(host.textContent).toContain("网络不可用");
    });
  });

  it("shows a generic safe failure for unspecified claim rejection", async () => {
    claimMachineMock.mockRejectedValue(
      Object.assign(new Error("safe daemon failure"), {
        responseCode: "machine_claim_failed",
      }),
    );
    const host = await mountView();
    const input = host.querySelector("input");
    if (!(input instanceof HTMLInputElement)) {
      throw new Error("claim code input not found");
    }
    input.value = "ABCD-2345";
    input.dispatchEvent(new Event("input"));
    await nextTick();

    host.querySelector("form")?.dispatchEvent(new Event("submit"));

    await vi.waitFor(() => {
      expect(host.textContent).toContain("领取失败，请联系维护人员重试");
    });
    expect(host.textContent).not.toContain("ABCD-2345");
  });
});
