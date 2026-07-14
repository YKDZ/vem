// @vitest-environment jsdom
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";

const {
  DaemonUnavailableErrorMock,
  routerReplaceMock,
  getBringUpMock,
  executeBringUpTaskMock,
  getSaleViewMock,
  scanWifiNetworksMock,
  beginMaintenanceSessionMock,
  hasMaintenanceSessionForRouteMock,
  handoffMaintenanceSessionToBringUpMock,
  handoffMaintenanceSessionToMaintenanceMock,
  onMaintenanceSessionInvalidatedMock,
  releaseMaintenanceSessionRouteMock,
} = vi.hoisted(() => ({
  DaemonUnavailableErrorMock: class DaemonUnavailableError extends Error {},
  routerReplaceMock: vi.fn(),
  getBringUpMock: vi.fn(),
  executeBringUpTaskMock: vi.fn(),
  getSaleViewMock: vi.fn(),
  scanWifiNetworksMock: vi.fn(),
  beginMaintenanceSessionMock: vi.fn(),
  hasMaintenanceSessionForRouteMock: vi.fn(),
  handoffMaintenanceSessionToBringUpMock: vi.fn(),
  handoffMaintenanceSessionToMaintenanceMock: vi.fn(),
  onMaintenanceSessionInvalidatedMock: vi.fn(),
  releaseMaintenanceSessionRouteMock: vi.fn(),
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
    getSaleView: getSaleViewMock,
    scanWifiNetworks: scanWifiNetworksMock,
    beginMaintenanceSession: beginMaintenanceSessionMock,
    hasMaintenanceSessionForRoute: hasMaintenanceSessionForRouteMock,
    handoffMaintenanceSessionToBringUp: handoffMaintenanceSessionToBringUpMock,
    handoffMaintenanceSessionToMaintenance:
      handoffMaintenanceSessionToMaintenanceMock,
    onMaintenanceSessionInvalidated: onMaintenanceSessionInvalidatedMock,
    releaseMaintenanceSessionRoute: releaseMaintenanceSessionRouteMock,
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

function saleView() {
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
        productSortOrder: 1,
        targetGender: null,
        capacity: 8,
        parLevel: 6,
        physicalStock: 2,
        saleableStock: 2,
        slotSalesState: "needs_count",
      },
    ],
    source: "local_stock",
    planogramVersion: "PLAN-1",
    lastUpdatedAt: "2026-07-14T00:00:00Z",
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
  getBringUpMock.mockReset();
  getBringUpMock.mockResolvedValue(snapshot());
  executeBringUpTaskMock.mockResolvedValue({
    status: "connected",
    ssid: "Store-WiFi",
    hidden: false,
    diagnostics: [],
    operatorGuidance: "现场网络已连通",
    updatedAt: "2026-07-04T00:01:00Z",
  });
  getSaleViewMock.mockResolvedValue(saleView());
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
  hasMaintenanceSessionForRouteMock.mockReturnValue(true);
  handoffMaintenanceSessionToBringUpMock.mockReturnValue(true);
  handoffMaintenanceSessionToMaintenanceMock.mockReturnValue(true);
  onMaintenanceSessionInvalidatedMock.mockReturnValue(() => undefined);
  beginMaintenanceSessionMock.mockImplementation(async () => {
    hasMaintenanceSessionForRouteMock.mockReturnValue(true);
    return {
      sessionId: "bring-up-session",
      expiresAt: "2030-07-14T12:00:00.000Z",
      scopes: ["maintenance.mutate"],
    };
  });
});

afterEach(() => {
  vi.useRealTimers();
  mountedApp?.unmount();
  mountedApp = null;
  document.body.innerHTML = "";
});

describe("Bring-Up Console", () => {
  it("requires a PIN-issued maintenance session before a cold-start network mutation", async () => {
    hasMaintenanceSessionForRouteMock.mockReturnValue(false);
    const host = await mountView();
    const select = host.querySelector("select");
    if (!(select instanceof HTMLSelectElement)) {
      throw new Error("network selector not found");
    }
    await vi.waitFor(() => {
      expect(select.options).toHaveLength(2);
    });
    select.value = "Store-WiFi";
    select.dispatchEvent(new Event("change"));
    const password = inputByLabel(host, "无线网络密码");
    password.value = "secret-pass";
    password.dispatchEvent(new Event("input"));
    await nextTick();

    expect(host.textContent).toContain("验证维护 PIN");
    expect(buttonByText(host, "提交网络设置").disabled).toBe(true);

    const pin = inputByLabel(host, "维护 PIN");
    pin.value = "2468";
    pin.dispatchEvent(new Event("input"));
    await nextTick();
    buttonByText(host, "验证维护 PIN").click();
    await vi.waitFor(() => {
      expect(beginMaintenanceSessionMock).toHaveBeenCalledWith("2468", []);
    });
    await vi.waitFor(() => {
      expect(buttonByText(host, "提交网络设置").disabled).toBe(false);
    });

    buttonByText(host, "提交网络设置").click();
    await vi.waitFor(() => {
      expect(executeBringUpTaskMock).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "configure_network" }),
        expect.objectContaining({ type: "configure_network" }),
      );
    });
  });

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

  it("shows distinct local, Platform API, and MQTT readiness evidence without retaining a Wi-Fi password", async () => {
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
    password.value = "replacement-pass";
    password.dispatchEvent(new Event("input"));
    await nextTick();
    executeBringUpTaskMock.mockRejectedValueOnce(
      Object.assign(new DaemonUnavailableErrorMock("network rejected"), {
        statusCode: 422,
        responseBody: JSON.stringify({
      status: "failed",
      ssid: "Store-WiFi",
      hidden: false,
      diagnostics: [
        {
          component: "local_network",
          level: "ok",
          code: "WIFI_ASSOCIATED",
          message: "association observed",
        },
        {
          component: "provisioning_endpoint",
          level: "error",
          code: "PRECLAIM_PLATFORM_ENDPOINT_UNREACHABLE",
          message: "Platform API unavailable",
        },
        {
          component: "mqtt",
          level: "unknown",
          code: "MQTT_NOT_CHECKED",
          message: "MQTT was not checked after Platform API failure",
        },
      ],
      operatorGuidance: "平台不可达，请检查平台服务。",
      updatedAt: "2026-07-04T00:01:00Z",
        }),
      }),
    );

    buttonByText(host, "提交网络设置").click();

    await vi.waitFor(() => {
      expect(host.textContent).toContain("local_network · WIFI_ASSOCIATED");
      expect(host.textContent).toContain(
        "provisioning_endpoint · PRECLAIM_PLATFORM_ENDPOINT_UNREACHABLE",
      );
      expect(host.textContent).toContain("mqtt · MQTT_NOT_CHECKED");
    });
    expect(password.value).toBe("");
    expect(host.innerHTML).not.toContain("replacement-pass");
  });

  it("shows a bad-password diagnostic without retaining the submitted credential", async () => {
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
    password.value = "wrong-password";
    password.dispatchEvent(new Event("input"));
    await nextTick();
    executeBringUpTaskMock.mockResolvedValueOnce({
      status: "failed",
      ssid: "Store-WiFi",
      hidden: false,
      diagnostics: [
        {
          component: "local_network",
          level: "error",
          code: "WIFI_AUTH_FAILED",
          message: "Wi-Fi password was rejected",
        },
      ],
      operatorGuidance: "Wi-Fi 密码验证失败。请重新输入密码。",
      updatedAt: "2026-07-04T00:01:00Z",
    });

    buttonByText(host, "提交网络设置").click();

    await vi.waitFor(() => {
      expect(host.textContent).toContain("local_network · WIFI_AUTH_FAILED");
    });
    expect(password.value).toBe("");
    expect(host.innerHTML).not.toContain("wrong-password");
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

  it("keeps the typed record-stock cursor pending until Platform acknowledgement", async () => {
    hasMaintenanceSessionForRouteMock.mockReturnValue(false);
    getBringUpMock
      .mockResolvedValueOnce(
        snapshot({
          state: "stock_attestation_required",
          currentTask: {
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
          progress: [{ kind: "stock", status: "current", evidence: "durable" }],
        }),
      )
      .mockResolvedValueOnce(
        snapshot({
          state: "stock_attestation_required",
          diagnostics: [
            {
              code: "PHYSICAL_STOCK_ATTESTATION_PENDING",
              component: "stock",
              message:
                "physical stock attestation is awaiting Platform acknowledgement",
            },
          ],
          currentTask: {
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
          progress: [{ kind: "stock", status: "current", evidence: "durable" }],
        }),
      );
    executeBringUpTaskMock.mockResolvedValueOnce(saleView());
    const host = await mountView();

    expect(host.textContent).toContain("实物库存确认");
    expect(host.textContent).toContain("A1");
    expect(buttonByText(host, "确认并提交实物库存").disabled).toBe(true);

    const pin = inputByLabel(host, "维护 PIN");
    pin.value = "2468";
    pin.dispatchEvent(new Event("input"));
    await nextTick();
    buttonByText(host, "验证维护 PIN").click();
    await vi.waitFor(() => {
      expect(beginMaintenanceSessionMock).toHaveBeenCalledWith("2468", []);
    });

    const quantity = inputByLabel(host, "A1 实际数量");
    quantity.value = "5";
    quantity.dispatchEvent(new Event("input"));
    const confirmation = host.querySelector(
      'input[type="checkbox"]',
    ) as HTMLInputElement;
    confirmation.checked = true;
    confirmation.dispatchEvent(new Event("change"));
    await nextTick();

    buttonByText(host, "确认并提交实物库存").click();
    await vi.waitFor(() => {
      expect(executeBringUpTaskMock).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: "bring_up.attest_stock",
          kind: "attest_stock",
          intent: "record_stock",
        }),
        {
          type: "record_stock",
          attestation: {
            attestationId: expect.any(String),
            planogramVersion: "PLAN-1",
            operatorId: "front-panel",
            slots: [
              {
                slotId: "550e8400-e29b-41d4-a716-446655440001",
                slotCode: "A1",
                sku: "WATER-001",
                quantity: 5,
                enabled: true,
              },
            ],
          },
        },
      );
    });
    expect(routerReplaceMock).not.toHaveBeenCalledWith("/maintenance");
    await vi.waitFor(() => {
      expect(host.textContent).toContain("当前任务：确认初始库存");
      expect(host.textContent).toContain("PHYSICAL_STOCK_ATTESTATION_PENDING");
      expect(host.textContent).toContain("正在等待平台确认");
    });
  });

  it("keeps slot quantities editable when the daemon reports a missing attestation", async () => {
    getBringUpMock.mockResolvedValue(
      snapshot({
        state: "stock_attestation_required",
        diagnostics: [
          {
            code: "PHYSICAL_STOCK_ATTESTATION_MISSING",
            component: "stock",
            message: "physical stock attestation is missing",
          },
        ],
        currentTask: {
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
        progress: [{ kind: "stock", status: "current", evidence: "durable" }],
      }),
    );

    const host = await mountView();
    const quantity = inputByLabel(host, "A1 实际数量");

    expect(quantity.disabled).toBe(false);
    expect(host.textContent).toContain("PHYSICAL_STOCK_ATTESTATION_MISSING");
  });

  it("preserves rejected slot quantities and submits the corrected count with a new attestation", async () => {
    const stockTask = {
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
    };
    getBringUpMock
      .mockResolvedValueOnce(
        snapshot({
          state: "stock_attestation_required",
          currentTask: stockTask,
          progress: [{ kind: "stock", status: "current", evidence: "durable" }],
        }),
      )
      .mockResolvedValue(
        snapshot({
          state: "stock_attestation_required",
          diagnostics: [
            {
              code: "PHYSICAL_STOCK_ATTESTATION_REJECTED",
              component: "stock",
              message: "platform rejected the stock correction",
            },
          ],
          currentTask: stockTask,
          progress: [{ kind: "stock", status: "current", evidence: "durable" }],
        }),
      );
    const host = await mountView();
    const quantity = inputByLabel(host, "A1 实际数量");
    quantity.value = "5";
    quantity.dispatchEvent(new Event("input"));
    const confirmation = host.querySelector(
      'input[type="checkbox"]',
    ) as HTMLInputElement;
    confirmation.checked = true;
    confirmation.dispatchEvent(new Event("change"));
    await nextTick();

    buttonByText(host, "确认并提交实物库存").click();
    await vi.waitFor(() => {
      expect(host.textContent).toContain("PHYSICAL_STOCK_ATTESTATION_REJECTED");
    });
    const correctedQuantity = inputByLabel(host, "A1 实际数量");
    expect(correctedQuantity.value).toBe("5");
    expect(correctedQuantity.disabled).toBe(false);

    correctedQuantity.value = "4";
    correctedQuantity.dispatchEvent(new Event("input"));
    const correctedConfirmation = host.querySelector(
      'input[type="checkbox"]',
    ) as HTMLInputElement;
    correctedConfirmation.checked = true;
    correctedConfirmation.dispatchEvent(new Event("change"));
    await nextTick();
    buttonByText(host, "确认并提交实物库存").click();

    await vi.waitFor(() => {
      expect(executeBringUpTaskMock).toHaveBeenCalledTimes(2);
    });
    const first = executeBringUpTaskMock.mock.calls[0]?.[1] as {
      attestation: {
        attestationId: string;
        slots: Array<{ quantity: number }>;
      };
    };
    const second = executeBringUpTaskMock.mock.calls[1]?.[1] as {
      attestation: {
        attestationId: string;
        slots: Array<{ quantity: number }>;
      };
    };
    expect(second.attestation.attestationId).not.toBe(
      first.attestation.attestationId,
    );
    expect(second.attestation.slots[0]?.quantity).toBe(4);
  });

  it("polls from a pending daemon snapshot after restart while keeping the stock form visible", async () => {
    vi.useFakeTimers();
    getBringUpMock
      .mockResolvedValueOnce(
        snapshot({
          state: "stock_attestation_required",
          diagnostics: [
            {
              code: "PHYSICAL_STOCK_ATTESTATION_PENDING",
              component: "stock",
              message: "awaiting Platform acknowledgement",
            },
          ],
          currentTask: {
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
          progress: [{ kind: "stock", status: "current", evidence: "durable" }],
        }),
      )
      .mockResolvedValue(
        snapshot({
          state: "runtime_ready",
          diagnostics: [],
          currentTask: {
            contractVersion: 1,
            taskId: "bring_up.sync_profile",
            taskVersion: 1,
            kind: "sync_profile",
            intent: "refresh_profile",
            rotateMaintenanceIdentity: false,
            projection: { type: "profile_sync" },
          },
          progress: [
            { kind: "stock", status: "completed", evidence: "durable" },
          ],
        }),
      );

    const host = document.createElement("div");
    document.body.append(host);
    mountedApp = createApp(MachineProvisioningView);
    mountedApp.use(createPinia());
    mountedApp.mount(host);
    await vi.advanceTimersByTimeAsync(0);
    await nextTick();

    expect(host.textContent).toContain("PHYSICAL_STOCK_ATTESTATION_PENDING");
    expect(inputByLabel(host, "A1 实际数量").disabled).toBe(true);
    expect(host.textContent).toContain("正在等待平台确认");
    expect(getBringUpMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_500);
    await nextTick();

    expect(getBringUpMock).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain("当前任务：同步运行档案");
  });

  it("retries the same attestation after a lost response when the daemon snapshot is missing", async () => {
    getBringUpMock.mockResolvedValue(
      snapshot({
        state: "stock_attestation_required",
        diagnostics: [
          {
            code: "PHYSICAL_STOCK_ATTESTATION_MISSING",
            component: "stock",
            message: "physical stock attestation is missing",
          },
        ],
        currentTask: {
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
        progress: [{ kind: "stock", status: "current", evidence: "durable" }],
      }),
    );
    executeBringUpTaskMock
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValueOnce(saleView());
    const host = await mountView();
    const quantity = inputByLabel(host, "A1 实际数量");
    quantity.value = "5";
    quantity.dispatchEvent(new Event("input"));
    const confirmation = host.querySelector(
      'input[type="checkbox"]',
    ) as HTMLInputElement;
    confirmation.checked = true;
    confirmation.dispatchEvent(new Event("change"));
    await nextTick();

    buttonByText(host, "确认并提交实物库存").click();
    await vi.waitFor(() => {
      expect(host.textContent).toContain("可保留当前数量并重试");
    });
    expect(buttonByText(host, "确认并提交实物库存").disabled).toBe(false);
    buttonByText(host, "确认并提交实物库存").click();

    await vi.waitFor(() => {
      expect(executeBringUpTaskMock).toHaveBeenCalledTimes(2);
    });
    const attempts = executeBringUpTaskMock.mock.calls.map(
      (call) =>
        (call[1] as { attestation: { attestationId: string } }).attestation
          .attestationId,
    );
    expect(attempts[1]).toBe(attempts[0]);
  });

  it("waits instead of resubmitting after a lost response when the daemon snapshot is pending", async () => {
    const stockTask = {
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
    };
    getBringUpMock
      .mockResolvedValueOnce(
        snapshot({
          state: "stock_attestation_required",
          currentTask: stockTask,
          progress: [{ kind: "stock", status: "current", evidence: "durable" }],
        }),
      )
      .mockResolvedValue(
        snapshot({
          state: "stock_attestation_required",
          diagnostics: [
            {
              code: "PHYSICAL_STOCK_ATTESTATION_PENDING",
              component: "stock",
              message: "awaiting Platform acknowledgement",
            },
          ],
          currentTask: stockTask,
          progress: [{ kind: "stock", status: "current", evidence: "durable" }],
        }),
      );
    executeBringUpTaskMock.mockRejectedValueOnce(new Error("response lost"));
    const host = await mountView();
    const quantity = inputByLabel(host, "A1 实际数量");
    quantity.value = "5";
    quantity.dispatchEvent(new Event("input"));
    const confirmation = host.querySelector(
      'input[type="checkbox"]',
    ) as HTMLInputElement;
    confirmation.checked = true;
    confirmation.dispatchEvent(new Event("change"));
    await nextTick();

    buttonByText(host, "确认并提交实物库存").click();
    await vi.waitFor(() => {
      expect(host.textContent).toContain("已由本机服务确认为等待平台确认");
    });

    expect(inputByLabel(host, "A1 实际数量").disabled).toBe(true);
    expect(buttonByText(host, "正在等待平台确认").disabled).toBe(true);
    buttonByText(host, "正在等待平台确认").click();
    expect(executeBringUpTaskMock).toHaveBeenCalledTimes(1);
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
      expect(handoffMaintenanceSessionToMaintenanceMock).toHaveBeenCalledOnce();
      expect(routerReplaceMock).toHaveBeenCalledWith({
        path: "/maintenance",
        query: { source: "protected-bring-up" },
      });
    });
  });
});
