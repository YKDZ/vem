// @vitest-environment jsdom

import type { PermissionCode } from "@vem/shared";

import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick, type PropType } from "vue";

import { useAuthStore } from "@/stores/auth";

import MachinesView from "./MachinesView.vue";

const apiMocks = vi.hoisted(() => ({
  listMachines: vi.fn(),
  getMachine: vi.fn(),
  commandEnvironment: vi.fn(),
  listMachineClaimCodes: vi.fn(),
  generateMachineClaimCode: vi.fn(),
  revokeMachineClaimCode: vi.fn(),
  rotateMachineCredentials: vi.fn(),
  requestLogExport: vi.fn(),
  createMachine: vi.fn(),
  updateMachine: vi.fn(),
}));
const routerMocks = vi.hoisted(() => ({
  push: vi.fn(),
  resolve: vi.fn(() => ({
    href: "/machines/11111111-1111-4111-8111-111111111111",
  })),
}));
const windowOpenMock = vi.hoisted(() => vi.fn());

const {
  listMachines,
  getMachine,
  commandEnvironment,
  listMachineClaimCodes,
  generateMachineClaimCode,
  revokeMachineClaimCode,
  updateMachine,
} = apiMocks;

vi.mock("@/api/machines", async () => {
  const actual =
    await vi.importActual<typeof import("@/api/machines")>("@/api/machines");
  return {
    ...actual,
    listMachines: apiMocks.listMachines,
    getMachine: apiMocks.getMachine,
    commandEnvironment: apiMocks.commandEnvironment,
    listMachineClaimCodes: apiMocks.listMachineClaimCodes,
    generateMachineClaimCode: apiMocks.generateMachineClaimCode,
    revokeMachineClaimCode: apiMocks.revokeMachineClaimCode,
    createMachine: apiMocks.createMachine,
    createMachineSlot: vi.fn(),
    listMachineSlots: vi.fn(),
    rotateMachineCredentials: apiMocks.rotateMachineCredentials,
    updateMachine: apiMocks.updateMachine,
  };
});

vi.mock("@/api/machine-ops", () => ({
  requestLogExport: apiMocks.requestLogExport,
}));

vi.mock("antdv-next", () => ({
  Modal: {
    confirm: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("vue-router", () => ({
  useRouter: () => routerMocks,
}));

function createMachineFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    code: "M001",
    name: "前厅机器",
    locationLabel: "一层",
    status: "online",
    mqttClientId: "mqtt-M001",
    lastSeenAt: "2026-06-04T05:00:00.000Z",
    createdAt: "2026-06-04T04:00:00.000Z",
    updatedAt: "2026-06-04T04:00:00.000Z",
    ...overrides,
  };
}

async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function getEventInput(event: Event): HTMLInputElement {
  if (!(event.target instanceof HTMLInputElement)) {
    throw new Error("Expected input event target");
  }
  return event.target;
}

function requireElement<T>(value: T | null | undefined, message: string): T {
  if (!value) throw new Error(message);
  return value;
}

type TableColumn = {
  title: string;
  key: string;
  dataIndex?: string;
};

type TableRecord = Record<
  string,
  string | number | boolean | null | undefined | Record<string, unknown>
>;

const TableStub = defineComponent({
  props: {
    columns: { type: Array as PropType<TableColumn[]>, required: true },
    dataSource: { type: Array as PropType<TableRecord[]>, required: true },
  },
  setup(props, { slots }) {
    return () =>
      h("table", [
        h(
          "thead",
          h(
            "tr",
            props.columns.map((column) => h("th", column.title)),
          ),
        ),
        h(
          "tbody",
          props.dataSource.map((record) =>
            h(
              "tr",
              props.columns.map((column) => {
                const cellValue = column.dataIndex
                  ? record[column.dataIndex]
                  : "";
                const fallback =
                  typeof cellValue === "string" || typeof cellValue === "number"
                    ? String(cellValue)
                    : "";
                return h(
                  "td",
                  slots.bodyCell?.({ column, record }) ?? fallback,
                );
              }),
            ),
          ),
        ),
      ]);
  },
});

const ButtonStub = defineComponent({
  props: {
    disabled: { type: Boolean, default: false },
    loading: { type: Boolean, default: false },
  },
  emits: ["click"],
  setup(props, { emit, slots }) {
    return () =>
      h(
        "button",
        {
          disabled: props.disabled || props.loading,
          onClick: () => {
            emit("click");
          },
        },
        slots.default?.(),
      );
  },
});

const CheckboxStub = defineComponent({
  props: {
    checked: { type: Boolean, default: false },
    disabled: { type: Boolean, default: false },
  },
  emits: ["update:checked"],
  setup(props, { emit, slots }) {
    return () =>
      h("label", [
        h("input", {
          type: "checkbox",
          checked: props.checked,
          disabled: props.disabled,
          onChange: (event: Event) => {
            emit("update:checked", getEventInput(event).checked);
          },
        }),
        slots.default?.(),
      ]);
  },
});

const SwitchStub = CheckboxStub;

const InputNumberStub = defineComponent({
  props: {
    value: { type: Number, default: undefined },
    min: { type: Number, default: undefined },
    max: { type: Number, default: undefined },
    disabled: { type: Boolean, default: false },
  },
  emits: ["update:value"],
  setup(props, { emit }) {
    return () =>
      h("input", {
        type: "number",
        value: props.value,
        min: props.min,
        max: props.max,
        disabled: props.disabled,
        onInput: (event: Event) => {
          emit("update:value", Number(getEventInput(event).value));
        },
      });
  },
});

const DrawerStub = defineComponent({
  props: {
    open: { type: Boolean, default: false },
    title: { type: String, default: "" },
  },
  setup(props, { slots }) {
    return () =>
      props.open
        ? h("aside", { role: "dialog" }, [
            h("h2", props.title),
            slots.default?.(),
          ])
        : null;
  },
});

const TagStub = defineComponent({
  setup(_, { slots }) {
    return () => h("span", slots.default?.());
  },
});

const PassthroughStub = defineComponent({
  props: { label: { type: String, default: "" } },
  setup(props, { slots }) {
    return () =>
      h("div", [
        props.label ? h("span", props.label) : null,
        slots.default?.(),
      ]);
  },
});

function installStubs(app: ReturnType<typeof createApp>): void {
  const passthroughComponents = [
    "a-card",
    "a-space",
    "a-form",
    "a-form-item",
    "a-modal",
    "a-alert",
    "a-descriptions",
    "a-descriptions-item",
    "a-typography-text",
    "a-select",
    "a-select-option",
    "a-input",
  ];
  app.component("a-table", TableStub);
  app.component("a-button", ButtonStub);
  app.component("a-drawer", DrawerStub);
  app.component("a-tag", TagStub);
  app.component("a-checkbox", CheckboxStub);
  app.component("a-switch", SwitchStub);
  app.component("a-input-number", InputNumberStub);
  for (const name of passthroughComponents) {
    app.component(name, PassthroughStub);
  }
}

async function mountMachinesView(
  permissions: PermissionCode[] = ["machines.read", "machines.command"],
) {
  const root = document.createElement("div");
  document.body.append(root);
  const pinia = createPinia();
  setActivePinia(pinia);
  const authStore = useAuthStore();
  authStore.currentAdmin = {
    id: "admin-1",
    username: "operator",
    displayName: "Operator",
    roles: [],
    permissions,
  };

  const app = createApp(MachinesView);
  app.use(pinia);
  installStubs(app);
  app.mount(root);
  await flushPromises();
  await nextTick();
  return { app, root };
}

async function openEnvironmentDrawer(root: HTMLElement): Promise<void> {
  Array.from(root.querySelectorAll("button"))
    .find((button) => button.textContent?.includes("环境"))
    ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await flushPromises();
  await nextTick();
}

async function openClaimCodesDrawer(root: HTMLElement): Promise<void> {
  Array.from(root.querySelectorAll("button"))
    .find((button) => button.textContent?.includes("领取码"))
    ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await flushPromises();
  await nextTick();
}

describe("MachinesView environment controls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.open = windowOpenMock;
    commandEnvironment.mockResolvedValue({
      id: "cmd-1",
      commandNo: "MCMD202606040001",
      status: "sent",
    });
    listMachines.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    });
    getMachine.mockResolvedValue(createMachineFixture());
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("edits Machine Location Label through the canonical locationLabel payload", async () => {
    listMachines.mockResolvedValue({
      items: [createMachineFixture()],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    updateMachine.mockResolvedValue(createMachineFixture());

    const { root } = await mountMachinesView([
      "machines.read",
      "machines.write",
    ]);

    expect(root.textContent).toContain("Machine Location Label");

    Array.from(root.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("编辑"))
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();

    const dialog = requireElement(
      root.querySelector<HTMLElement>('[role="dialog"]'),
      "machine dialog",
    );
    expect(dialog.textContent).toContain("Machine Location Label");

    Array.from(dialog.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("保存"))
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();

    expect(updateMachine).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({ locationLabel: "一层" }),
    );
    expect(updateMachine.mock.calls[0][1]).not.toHaveProperty("locationText");
  });

  it("shows a compact environment summary in the machine list without row controls", async () => {
    listMachines.mockResolvedValue({
      items: [
        createMachineFixture({
          latestEnvironment: {
            temperatureCelsius: 22.4,
            humidityRh: 48,
            sampledAt: "2026-06-04T05:01:00.000Z",
            sensorStatus: "ok",
            airConditionerOn: true,
            targetTemperatureCelsius: 24,
          },
        }),
      ],
      total: 1,
      page: 1,
      pageSize: 20,
    });

    const { root } = await mountMachinesView();

    expect(root.textContent).toContain("22.4 C");
    expect(root.textContent).toContain("48% RH");
    expect(root.textContent).toContain("传感器正常");
    expect(root.textContent).toContain("空调开");
    expect(root.textContent).toContain("目标 24 C");
    expect(root.querySelector("tbody input")).toBeNull();
  });

  it("opens the single machine operation page from the machine list", async () => {
    listMachines.mockResolvedValue({
      items: [createMachineFixture()],
      total: 1,
      page: 1,
      pageSize: 20,
    });

    const { root } = await mountMachinesView();
    Array.from(root.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("详情"))
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();

    expect(routerMocks.push).toHaveBeenCalledWith({
      name: "machine-detail",
      params: { id: "11111111-1111-4111-8111-111111111111" },
    });

    Array.from(root.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("新窗口"))
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(routerMocks.resolve).toHaveBeenCalledWith({
      name: "machine-detail",
      params: { id: "11111111-1111-4111-8111-111111111111" },
    });
    expect(windowOpenMock).toHaveBeenCalledWith(
      "/machines/11111111-1111-4111-8111-111111111111",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("opens an environment drawer with the latest detailed reading", async () => {
    listMachines.mockResolvedValue({
      items: [createMachineFixture()],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    getMachine.mockResolvedValue(
      createMachineFixture({
        latestEnvironment: {
          temperatureCelsius: 19,
          humidityRh: 67.5,
          sampledAt: "2026-06-04T05:02:00.000Z",
          sensorStatus: "faulted",
          airConditionerOn: false,
          targetTemperatureCelsius: null,
        },
        latestEnvironmentCommand: {
          id: "cmd-existing",
          machineId: "11111111-1111-4111-8111-111111111111",
          commandNo: "MCMD-EXISTING",
          type: "environment-control",
          status: "acknowledged",
        },
      }),
    );

    const { root } = await mountMachinesView();
    await openEnvironmentDrawer(root);

    expect(getMachine).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
    );
    expect(root.querySelector('[role="dialog"]')?.textContent).toContain(
      "环境 - M001",
    );
    expect(root.querySelector('[role="dialog"]')?.textContent).toContain(
      "19 C",
    );
    expect(root.querySelector('[role="dialog"]')?.textContent).toContain(
      "67.5% RH",
    );
    expect(root.querySelector('[role="dialog"]')?.textContent).toContain(
      "传感器故障",
    );
    expect(root.querySelector('[role="dialog"]')?.textContent).toContain(
      "空调关",
    );
    expect(root.querySelector('[role="dialog"]')?.textContent).toContain(
      "目标未知",
    );
    expect(root.querySelector('[role="dialog"]')?.textContent).toContain(
      "2026/6/4 05:02:00",
    );
    expect(root.querySelector('[role="dialog"]')?.textContent).toContain(
      "命令已确认",
    );
  });

  it("allows environment controls when the latest reading is unknown", async () => {
    listMachines.mockResolvedValue({
      items: [createMachineFixture()],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    getMachine.mockResolvedValue(
      createMachineFixture({ latestEnvironment: null }),
    );
    commandEnvironment.mockResolvedValue({
      id: "cmd-unknown",
      commandNo: "MCMDUNKNOWN",
      status: "sent",
    });

    const { root } = await mountMachinesView();
    await openEnvironmentDrawer(root);
    const dialog = requireElement(
      root.querySelector<HTMLElement>('[role="dialog"]'),
      "environment dialog",
    );

    expect(dialog.textContent).toContain("环境未知");
    expect(dialog.textContent).toContain("设置空调开关");
    const checkboxes = dialog.querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    checkboxes[0].checked = true;
    checkboxes[0].dispatchEvent(new Event("change", { bubbles: true }));
    checkboxes[1].checked = true;
    checkboxes[1].dispatchEvent(new Event("change", { bubbles: true }));
    await nextTick();

    Array.from(dialog.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("提交环境控制"))
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();
    await nextTick();

    expect(commandEnvironment).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      { airConditionerOn: true },
    );
    expect(dialog.textContent).toContain("环境未知");
    expect(dialog.textContent).toContain("命令已发送");
  });

  it("constrains target temperature control to 18-30 C", async () => {
    listMachines.mockResolvedValue({
      items: [createMachineFixture()],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    getMachine.mockResolvedValue(
      createMachineFixture({
        latestEnvironment: {
          temperatureCelsius: 21,
          humidityRh: 50,
          sampledAt: "2026-06-04T05:02:00.000Z",
          sensorStatus: "ok",
          airConditionerOn: true,
          targetTemperatureCelsius: 24,
        },
      }),
    );

    const { root } = await mountMachinesView();
    await openEnvironmentDrawer(root);

    const targetToggle = Array.from(root.querySelectorAll("label"))
      .find((label) => label.textContent?.includes("设置目标温度"))
      ?.querySelector("input");
    expect(targetToggle).toBeDefined();
    targetToggle!.checked = true;
    targetToggle!.dispatchEvent(new Event("change", { bubbles: true }));
    await nextTick();

    const targetInput = requireElement(
      root.querySelector<HTMLInputElement>('input[type="number"]'),
      "target input",
    );
    const submitButton = Array.from(root.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("提交环境控制"),
    );

    expect(targetInput).toBeDefined();
    expect(targetInput.min).toBe("18");
    expect(targetInput.max).toBe("30");
    targetInput.value = "31";
    targetInput.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();

    expect(root.querySelector('[role="dialog"]')?.textContent).toContain(
      "18-30 C",
    );
    expect(submitButton?.disabled).toBe(true);

    targetInput.value = "30";
    targetInput.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();

    expect(submitButton?.disabled).toBe(false);
  });

  it("submits a switch-only command without optimistic air-conditioner state", async () => {
    listMachines.mockResolvedValue({
      items: [createMachineFixture()],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    getMachine.mockResolvedValue(
      createMachineFixture({
        latestEnvironment: {
          temperatureCelsius: 21,
          humidityRh: 50,
          sampledAt: "2026-06-04T05:02:00.000Z",
          sensorStatus: "ok",
          airConditionerOn: false,
          targetTemperatureCelsius: 24,
        },
      }),
    );
    commandEnvironment.mockResolvedValue({
      id: "cmd-1",
      commandNo: "MCMD202606040001",
      status: "sent",
    });

    const { root } = await mountMachinesView();
    await openEnvironmentDrawer(root);
    const dialog = requireElement(
      root.querySelector<HTMLElement>('[role="dialog"]'),
      "environment dialog",
    );
    const checkboxes = dialog.querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    checkboxes[0].checked = true;
    checkboxes[0].dispatchEvent(new Event("change", { bubbles: true }));
    checkboxes[1].checked = true;
    checkboxes[1].dispatchEvent(new Event("change", { bubbles: true }));
    await nextTick();

    Array.from(dialog.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("提交环境控制"))
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();
    await nextTick();

    expect(commandEnvironment).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      { airConditionerOn: true },
    );
    expect(dialog.textContent).toContain("空调关");
    expect(dialog.textContent).toContain("命令已发送");
  });

  it("submits target-only and combined command payloads", async () => {
    listMachines.mockResolvedValue({
      items: [createMachineFixture()],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    getMachine.mockResolvedValue(
      createMachineFixture({
        latestEnvironment: {
          temperatureCelsius: 21,
          humidityRh: 50,
          sampledAt: "2026-06-04T05:02:00.000Z",
          sensorStatus: "ok",
          airConditionerOn: false,
          targetTemperatureCelsius: 24,
        },
      }),
    );

    const { root } = await mountMachinesView();
    await openEnvironmentDrawer(root);
    const dialog = requireElement(
      root.querySelector<HTMLElement>('[role="dialog"]'),
      "environment dialog",
    );
    const checkboxes = dialog.querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    const targetInput = requireElement(
      dialog.querySelector<HTMLInputElement>('input[type="number"]'),
      "target input",
    );
    const submitButton = Array.from(dialog.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("提交环境控制"),
    );

    checkboxes[2].checked = true;
    checkboxes[2].dispatchEvent(new Event("change", { bubbles: true }));
    targetInput.value = "26";
    targetInput.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    submitButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();

    expect(commandEnvironment).toHaveBeenLastCalledWith(
      "11111111-1111-4111-8111-111111111111",
      { targetTemperatureCelsius: 26 },
    );

    checkboxes[0].checked = true;
    checkboxes[0].dispatchEvent(new Event("change", { bubbles: true }));
    checkboxes[1].checked = true;
    checkboxes[1].dispatchEvent(new Event("change", { bubbles: true }));
    await nextTick();
    submitButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();

    expect(commandEnvironment).toHaveBeenLastCalledWith(
      "11111111-1111-4111-8111-111111111111",
      { airConditionerOn: true, targetTemperatureCelsius: 26 },
    );
  });

  it("shows command loading and result statuses", async () => {
    listMachines.mockResolvedValue({
      items: [createMachineFixture()],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    getMachine.mockResolvedValue(
      createMachineFixture({
        latestEnvironment: {
          temperatureCelsius: 21,
          humidityRh: 50,
          sampledAt: "2026-06-04T05:02:00.000Z",
          sensorStatus: "unknown",
          airConditionerOn: undefined,
          targetTemperatureCelsius: null,
        },
      }),
    );

    const { root } = await mountMachinesView();
    await openEnvironmentDrawer(root);
    const dialog = requireElement(
      root.querySelector<HTMLElement>('[role="dialog"]'),
      "environment dialog",
    );
    const checkboxes = dialog.querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    const submitButton = requireElement(
      Array.from(dialog.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("提交环境控制"),
      ),
      "submit button",
    );
    checkboxes[0].checked = true;
    checkboxes[0].dispatchEvent(new Event("change", { bubbles: true }));
    await nextTick();

    let resolveCommand: ((value: unknown) => void) | undefined;
    commandEnvironment.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveCommand = resolve;
      }),
    );
    submitButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();
    expect(submitButton.disabled).toBe(true);
    requireElement(
      resolveCommand,
      "resolve command",
    )({
      id: "cmd-2",
      commandNo: "MCMD2",
      status: "succeeded",
    });
    await flushPromises();
    expect(dialog.textContent).toContain("传感器未知");
    expect(dialog.textContent).toContain("空调未知");
    expect(dialog.textContent).toContain("命令成功");

    commandEnvironment.mockResolvedValueOnce({
      id: "cmd-3",
      commandNo: "MCMD3",
      status: "failed",
    });
    submitButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();
    expect(dialog.textContent).toContain("命令失败");

    commandEnvironment.mockResolvedValueOnce({
      id: "cmd-4",
      commandNo: "MCMD4",
      status: "timeout",
    });
    submitButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();
    expect(dialog.textContent).toContain("命令超时");
  });

  it("keeps controls disabled without machine command permission", async () => {
    listMachines.mockResolvedValue({
      items: [createMachineFixture()],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    getMachine.mockResolvedValue(
      createMachineFixture({
        latestEnvironment: {
          temperatureCelsius: 21,
          humidityRh: 50,
          sampledAt: "2026-06-04T05:02:00.000Z",
          sensorStatus: "ok",
          airConditionerOn: true,
          targetTemperatureCelsius: 24,
        },
      }),
    );

    const { root } = await mountMachinesView(["machines.read"]);
    await openEnvironmentDrawer(root);
    const dialog = requireElement(
      root.querySelector<HTMLElement>('[role="dialog"]'),
      "environment dialog",
    );

    expect(dialog.textContent).toContain("无机器控制权限");
    expect(dialog.textContent).not.toContain("提交环境控制");
    expect(
      Array.from(dialog.querySelectorAll("input")).every(
        (input) => input.disabled,
      ),
    ).toBe(true);
  });
});

describe("MachinesView claim code lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listMachines.mockResolvedValue({
      items: [createMachineFixture()],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    listMachineClaimCodes.mockResolvedValue({
      items: [
        {
          id: "550e8400-e29b-41d4-a716-446655440111",
          machineId: "11111111-1111-4111-8111-111111111111",
          machineCode: "M001",
          state: "pending",
          expiresAt: "2026-06-08T16:40:00.000Z",
          failedAttemptCount: 1,
          maxFailedAttempts: 5,
          createdAt: "2026-06-08T16:00:00.000Z",
          revokedAt: null,
          consumedAt: null,
          lockedAt: null,
        },
        {
          id: "550e8400-e29b-41d4-a716-446655440112",
          machineId: "11111111-1111-4111-8111-111111111111",
          machineCode: "M001",
          state: "expired",
          expiresAt: "2026-06-08T15:40:00.000Z",
          failedAttemptCount: 0,
          maxFailedAttempts: 5,
          createdAt: "2026-06-08T15:00:00.000Z",
          revokedAt: null,
          consumedAt: null,
          lockedAt: null,
        },
      ],
    });
    generateMachineClaimCode.mockResolvedValue({
      id: "550e8400-e29b-41d4-a716-446655440113",
      machineId: "11111111-1111-4111-8111-111111111111",
      machineCode: "M001",
      claimCode: "ABCD-2345",
      state: "pending",
      expiresAt: "2026-06-08T16:50:00.000Z",
      failedAttemptCount: 0,
      maxFailedAttempts: 5,
      createdAt: "2026-06-08T16:40:00.000Z",
    });
    revokeMachineClaimCode.mockResolvedValue({
      id: "550e8400-e29b-41d4-a716-446655440111",
      machineId: "11111111-1111-4111-8111-111111111111",
      machineCode: "M001",
      state: "revoked",
      expiresAt: "2026-06-08T16:40:00.000Z",
      failedAttemptCount: 1,
      maxFailedAttempts: 5,
      createdAt: "2026-06-08T16:00:00.000Z",
      revokedAt: "2026-06-08T16:20:00.000Z",
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("manages claim code state without showing raw codes from list responses", async () => {
    const { root } = await mountMachinesView([
      "machines.read",
      "machines.manage-credentials",
    ]);
    await openClaimCodesDrawer(root);

    const dialog = requireElement(
      root.querySelector<HTMLElement>('[role="dialog"]'),
      "claim code dialog",
    );
    expect(listMachineClaimCodes).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
    );
    expect(dialog.textContent).toContain("领取码 - M001");
    expect(dialog.textContent).toContain("待领取");
    expect(dialog.textContent).toContain("已过期");
    expect(dialog.textContent).toContain("1/5");
    expect(dialog.textContent).not.toContain("ABCD-2345");

    Array.from(dialog.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("生成领取码"))
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();
    await nextTick();

    expect(generateMachineClaimCode).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
    );
    expect(dialog.textContent).toContain("ABCD-2345");

    Array.from(dialog.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("撤销"))
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();

    expect(revokeMachineClaimCode).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      "550e8400-e29b-41d4-a716-446655440111",
    );
  });

  it("shows reclaim intent safely and sends an explicit reclaim generation request", async () => {
    listMachineClaimCodes.mockResolvedValueOnce({
      items: [
        {
          id: "550e8400-e29b-41d4-a716-446655440114",
          machineId: "11111111-1111-4111-8111-111111111111",
          machineCode: "M001",
          purpose: "reclaim",
          state: "pending",
          expiresAt: "2026-06-08T16:40:00.000Z",
          failedAttemptCount: 0,
          maxFailedAttempts: 5,
          createdAt: "2026-06-08T16:00:00.000Z",
          revokedAt: null,
          consumedAt: null,
          lockedAt: null,
        },
      ],
    });
    generateMachineClaimCode.mockResolvedValueOnce({
      id: "550e8400-e29b-41d4-a716-446655440115",
      machineId: "11111111-1111-4111-8111-111111111111",
      machineCode: "M001",
      purpose: "reclaim",
      claimCode: "RCLM-2345",
      state: "pending",
      expiresAt: "2026-06-08T16:50:00.000Z",
      failedAttemptCount: 0,
      maxFailedAttempts: 5,
      createdAt: "2026-06-08T16:40:00.000Z",
    });

    const { root } = await mountMachinesView([
      "machines.read",
      "machines.manage-credentials",
    ]);
    await openClaimCodesDrawer(root);
    const dialog = requireElement(
      root.querySelector<HTMLElement>('[role="dialog"]'),
      "claim code dialog",
    );

    expect(dialog.textContent).toContain("重新领取");
    expect(dialog.textContent).not.toContain("RCLM-2345");

    Array.from(dialog.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("生成重新领取码"))
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();
    await nextTick();

    expect(generateMachineClaimCode).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      { purpose: "reclaim" },
    );
    expect(dialog.textContent).toContain("RCLM-2345");
    expect(dialog.textContent).toContain("重新领取");
  });

  it("hides claim code management without credential permission", async () => {
    const { root } = await mountMachinesView(["machines.read"]);

    expect(root.textContent).not.toContain("领取码");
  });

  it("requires credential permission for rotation and machine ops permission for log export", async () => {
    const writeOnly = await mountMachinesView([
      "machines.read",
      "machines.write",
    ]);
    expect(writeOnly.root.textContent).not.toContain("轮换凭证");
    expect(writeOnly.root.textContent).not.toContain("导出日志");
    writeOnly.root.remove();

    const credentialOnly = await mountMachinesView([
      "machines.read",
      "machines.manage-credentials",
    ]);
    expect(credentialOnly.root.textContent).toContain("轮换凭证");
    expect(credentialOnly.root.textContent).not.toContain("导出日志");
    credentialOnly.root.remove();

    const opsOnly = await mountMachinesView([
      "machines.read",
      "machineOps.write",
    ]);
    expect(opsOnly.root.textContent).not.toContain("轮换凭证");
    expect(opsOnly.root.textContent).toContain("导出日志");
  });
});
