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
  messageSuccess: vi.fn(),
  messageError: vi.fn(),
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
  createMachine,
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
  message: {
    success: apiMocks.messageSuccess,
    error: apiMocks.messageError,
  },
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
    geoLocation: null,
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

const InputStub = defineComponent({
  props: {
    value: { type: String, default: "" },
    disabled: { type: Boolean, default: false },
  },
  emits: ["update:value"],
  setup(props, { emit }) {
    return () =>
      h("input", {
        value: props.value,
        disabled: props.disabled,
        onInput: (event: Event) => {
          emit("update:value", getEventInput(event).value);
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
  props: {
    label: { type: String, default: "" },
    message: { type: String, default: "" },
  },
  setup(props, { slots }) {
    return () =>
      h("div", [
        props.label ? h("span", props.label) : null,
        props.message ? h("span", props.message) : null,
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
  ];
  app.component("a-table", TableStub);
  app.component("a-button", ButtonStub);
  app.component("a-drawer", DrawerStub);
  app.component("a-tag", TagStub);
  app.component("a-checkbox", CheckboxStub);
  app.component("a-switch", SwitchStub);
  app.component("a-input", InputStub);
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

  it("edits machine location label through the canonical locationLabel payload", async () => {
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

    expect(root.textContent).toContain("位置标签");

    Array.from(root.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("编辑"))
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();

    const dialog = requireElement(
      root.querySelector<HTMLElement>('[role="dialog"]'),
      "machine dialog",
    );
    expect(dialog.textContent).toContain("位置标签");
    expect(dialog.textContent).not.toContain("Machine Location Label");

    Array.from(dialog.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("保存"))
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();

    expect(updateMachine).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({ locationLabel: "一层" }),
    );
    expect(updateMachine.mock.calls[0][1]).not.toHaveProperty("locationText");
    expect(updateMachine.mock.calls[0][1]).not.toHaveProperty("code");
    expect(dialog.querySelector<HTMLInputElement>("input")?.disabled).toBe(
      true,
    );
  });

  it("edits fixed geo location through the canonical geoLocation payload", async () => {
    listMachines.mockResolvedValue({
      items: [
        createMachineFixture({
          geoLocation: {
            latitude: 31.2304,
            longitude: 121.4737,
            timezone: "Asia/Shanghai",
          },
        }),
      ],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    updateMachine.mockResolvedValue(createMachineFixture());

    const { root } = await mountMachinesView([
      "machines.read",
      "machines.write",
    ]);

    expect(root.textContent).toContain("固定地理坐标");
    expect(root.textContent).toContain("31.2304, 121.4737");

    Array.from(root.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("编辑"))
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();

    const dialog = requireElement(
      root.querySelector<HTMLElement>('[role="dialog"]'),
      "machine dialog",
    );
    expect(dialog.textContent).toContain("WGS84 室外代表性站点坐标");
    expect(dialog.textContent).toContain("GCJ-02");
    expect(dialog.textContent).toContain("BD-09");
    expect(dialog.textContent).not.toContain("Machine Geo Location");

    const numberInputs = dialog.querySelectorAll<HTMLInputElement>(
      'input[type="number"]',
    );
    numberInputs[0].value = "30.25";
    numberInputs[0].dispatchEvent(new Event("input", { bubbles: true }));
    numberInputs[1].value = "120.5";
    numberInputs[1].dispatchEvent(new Event("input", { bubbles: true }));
    const timezoneInput = Array.from(
      dialog.querySelectorAll<HTMLInputElement>('input:not([type="number"])'),
    ).find((input) => input.value === "Asia/Shanghai");
    expect(timezoneInput).toBeDefined();
    timezoneInput!.value = "Asia/Tokyo";
    timezoneInput!.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();

    Array.from(dialog.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("保存"))
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();

    expect(updateMachine).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        geoLocation: {
          latitude: 30.25,
          longitude: 120.5,
          timezone: "Asia/Tokyo",
        },
      }),
    );
  });

  it("blocks invalid fixed geo location before submitting the machine form", async () => {
    listMachines.mockResolvedValue({
      items: [
        createMachineFixture({
          geoLocation: {
            latitude: 31.2304,
            longitude: 121.4737,
            timezone: "Asia/Shanghai",
          },
        }),
      ],
      total: 1,
      page: 1,
      pageSize: 20,
    });

    const { root } = await mountMachinesView([
      "machines.read",
      "machines.write",
    ]);
    Array.from(root.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("编辑"))
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();

    const dialog = requireElement(
      root.querySelector<HTMLElement>('[role="dialog"]'),
      "machine dialog",
    );
    const latitudeInput = requireElement(
      dialog.querySelector<HTMLInputElement>('input[type="number"]'),
      "latitude input",
    );
    latitudeInput.value = "91";
    latitudeInput.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();

    Array.from(dialog.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("保存"))
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();

    expect(updateMachine).not.toHaveBeenCalled();
  });

  it("blocks invalid fixed geo location timezone before submitting the machine form", async () => {
    listMachines.mockResolvedValue({
      items: [
        createMachineFixture({
          geoLocation: {
            latitude: 31.2304,
            longitude: 121.4737,
            timezone: "Asia/Shanghai",
          },
        }),
      ],
      total: 1,
      page: 1,
      pageSize: 20,
    });

    const { root } = await mountMachinesView([
      "machines.read",
      "machines.write",
    ]);
    Array.from(root.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("编辑"))
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();

    const dialog = requireElement(
      root.querySelector<HTMLElement>('[role="dialog"]'),
      "machine dialog",
    );
    const timezoneInput = Array.from(
      dialog.querySelectorAll<HTMLInputElement>('input:not([type="number"])'),
    ).find((input) => input.value === "Asia/Shanghai");
    expect(timezoneInput).toBeDefined();
    timezoneInput!.value = "Shanghai";
    timezoneInput!.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();

    Array.from(dialog.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("保存"))
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();

    expect(updateMachine).not.toHaveBeenCalled();
  });

  it("clears fixed geo location when the geo location checkbox is disabled", async () => {
    listMachines.mockResolvedValue({
      items: [
        createMachineFixture({
          geoLocation: {
            latitude: 31.2304,
            longitude: 121.4737,
            timezone: "Asia/Shanghai",
          },
        }),
      ],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    updateMachine.mockResolvedValue(createMachineFixture());

    const { root } = await mountMachinesView([
      "machines.read",
      "machines.write",
    ]);
    Array.from(root.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("编辑"))
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();

    const dialog = requireElement(
      root.querySelector<HTMLElement>('[role="dialog"]'),
      "machine dialog",
    );
    const geoCheckbox = requireElement(
      Array.from(dialog.querySelectorAll("label"))
        .find((label) => label.textContent?.includes("启用固定地理坐标"))
        ?.querySelector("input"),
      "geo checkbox",
    );
    geoCheckbox.checked = false;
    geoCheckbox.dispatchEvent(new Event("change", { bubbles: true }));
    await nextTick();

    Array.from(dialog.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("保存"))
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();

    expect(updateMachine).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({ geoLocation: null }),
    );
  });

  it("defaults new machine geo timezone to Asia/Shanghai while leaving geo location unset", async () => {
    listMachines.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    });
    createMachine.mockResolvedValue(createMachineFixture());

    const { root } = await mountMachinesView([
      "machines.read",
      "machines.write",
    ]);
    Array.from(root.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("新增机器"))
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();

    const dialog = requireElement(
      root.querySelector<HTMLElement>('[role="dialog"]'),
      "machine dialog",
    );
    expect(dialog.textContent).toContain("位置标签");
    expect(dialog.textContent).toContain("固定地理坐标");
    expect(dialog.textContent).not.toContain("Machine Location Label");
    expect(dialog.textContent).not.toContain("Machine Geo Location");
    expect(dialog.textContent).not.toContain("MQTT Client ID");
    expect(dialog.textContent).not.toContain("下线");
    expect(dialog.textContent).not.toContain("在线");
    expect(dialog.textContent).not.toContain("维护");
    expect(dialog.textContent).not.toContain("禁用");
    expect(
      Array.from(dialog.querySelectorAll<HTMLInputElement>("input")).some(
        (input) => input.value === "Asia/Shanghai",
      ),
    ).toBe(true);
    const inputs = Array.from(
      dialog.querySelectorAll<HTMLInputElement>("input"),
    );
    inputs[0].value = "M-NEW";
    inputs[0].dispatchEvent(new Event("input"));
    inputs[1].value = "新机器";
    inputs[1].dispatchEvent(new Event("input"));
    await nextTick();

    Array.from(dialog.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("保存"))
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();

    expect(createMachine).toHaveBeenCalledWith(
      expect.objectContaining({ geoLocation: null }),
    );
    expect(createMachine.mock.calls[0][0]).not.toHaveProperty("status");
    expect(createMachine.mock.calls[0][0]).not.toHaveProperty("mqttClientId");
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
    const openButton = Array.from(dialog.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("开启"),
    );
    openButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
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
        },
      }),
    );

    const { root } = await mountMachinesView();
    await openEnvironmentDrawer(root);
    const dialog = requireElement(
      root.querySelector<HTMLElement>('[role="dialog"]'),
      "environment dialog",
    );

    const targetInput = requireElement(
      dialog.querySelector<HTMLInputElement>('input[type="number"]'),
      "target input",
    );
    const targetSubmit = Array.from(dialog.querySelectorAll("button")).find(
      (button) =>
        button.textContent?.includes("设定") &&
        button.previousElementSibling?.textContent?.includes("C"),
    );

    expect(targetInput).toBeDefined();
    expect(targetSubmit).toBeDefined();
    expect(targetInput.min).toBe("18");
    expect(targetInput.max).toBe("30");
    targetInput.value = "31";
    targetInput.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();

    expect(root.querySelector('[role="dialog"]')?.textContent).toContain(
      "18-30 C",
    );
    expect(targetSubmit?.disabled).toBe(true);

    targetInput.value = "30";
    targetInput.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();

    expect(targetSubmit?.disabled).toBe(false);
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
    const openButton = Array.from(dialog.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("开启"),
    );
    openButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();
    await nextTick();

    expect(commandEnvironment).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      { airConditionerOn: true },
    );
    expect(dialog.textContent).toContain("命令已发送");
  });

  it("submits target-only and speed-only command payloads", async () => {
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
        },
      }),
    );
    commandEnvironment.mockResolvedValue({
      id: "cmd-terminal",
      commandNo: "MCMD-TERMINAL",
      status: "succeeded",
    });

    const { root } = await mountMachinesView();
    await openEnvironmentDrawer(root);
    const dialog = requireElement(
      root.querySelector<HTMLElement>('[role="dialog"]'),
      "environment dialog",
    );
    const targetInput = requireElement(
      dialog.querySelector<HTMLInputElement>('input[type="number"]'),
      "target input",
    );
    const targetSetButton = Array.from(dialog.querySelectorAll("button")).find(
      (button) =>
        button.textContent?.includes("设定") &&
        button.previousElementSibling?.textContent?.includes("C"),
    );
    const speedSetButton = Array.from(dialog.querySelectorAll("button")).find(
      (button) =>
        button.textContent?.includes("设定") &&
        button.previousElementSibling instanceof HTMLSelectElement,
    );
    const speedSelect = requireElement(
      dialog.querySelector("select"),
      "speed select",
    );

    expect(targetSetButton).toBeDefined();
    expect(speedSetButton).toBeDefined();

    targetInput.value = "26";
    targetInput.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    targetSetButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();

    expect(commandEnvironment).toHaveBeenLastCalledWith(
      "11111111-1111-4111-8111-111111111111",
      { targetTemperatureCelsius: 26 },
    );

    speedSelect.value = "3";
    speedSelect.dispatchEvent(new Event("change", { bubbles: true }));
    await nextTick();
    speedSetButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();

    expect(commandEnvironment).toHaveBeenLastCalledWith(
      "11111111-1111-4111-8111-111111111111",
      { ventSpeed: 3 },
    );
  });

  it.each(["pending", "sent", "acknowledged"])(
    "disables every environment control while the machine command is %s",
    async (status) => {
      listMachines.mockResolvedValue({
        items: [createMachineFixture()],
        total: 1,
        page: 1,
        pageSize: 20,
      });
      getMachine.mockResolvedValue(
        createMachineFixture({
          latestEnvironmentCommand: {
            id: "cmd-active",
            machineId: "11111111-1111-4111-8111-111111111111",
            commandNo: "MCMD-ACTIVE",
            type: "environment-control",
            status,
            payloadJson: { targetTemperatureCelsius: 25 },
          },
        }),
      );

      const { root } = await mountMachinesView();
      await openEnvironmentDrawer(root);
      const dialog = requireElement(
        root.querySelector<HTMLElement>('[role="dialog"]'),
        "environment dialog",
      );

      expect(
        Array.from(dialog.querySelectorAll("button, input, select")).every(
          (control) =>
            (
              control as
                | HTMLButtonElement
                | HTMLInputElement
                | HTMLSelectElement
            ).disabled,
        ),
      ).toBe(true);
      expect(dialog.textContent).not.toContain("请求：");
    },
  );

  it("uses a transient toast for a failed environment command without inline request details", async () => {
    listMachines.mockResolvedValue({
      items: [createMachineFixture()],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    getMachine.mockResolvedValue(createMachineFixture());
    commandEnvironment.mockResolvedValue({
      id: "cmd-failed",
      commandNo: "MCMD-FAILED",
      status: "failed",
      payloadJson: { ventSpeed: 4 },
      resultJson: { errorCode: "E4" },
      lastError: "controller rejected command",
    });

    const { root } = await mountMachinesView();
    await openEnvironmentDrawer(root);
    const dialog = requireElement(
      root.querySelector<HTMLElement>('[role="dialog"]'),
      "environment dialog",
    );
    const speedButton = requireElement(
      Array.from(dialog.querySelectorAll("button")).find(
        (button) =>
          button.textContent?.includes("设定") &&
          button.previousElementSibling instanceof HTMLSelectElement,
      ),
      "speed set button",
    );
    speedButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();

    expect(apiMocks.messageError).toHaveBeenCalledWith(
      "出风口与风速控制失败：控制器操作过于频繁，请稍后重试（E4）",
    );
    expect(dialog.textContent).not.toContain("请求：");
    expect(dialog.textContent).not.toContain("失败：");
  });

  it("uses a transient toast for a successful environment command", async () => {
    listMachines.mockResolvedValue({
      items: [createMachineFixture()],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    getMachine.mockResolvedValue(createMachineFixture());
    commandEnvironment.mockResolvedValue({
      id: "cmd-succeeded",
      commandNo: "MCMD-SUCCEEDED",
      status: "succeeded",
      payloadJson: { airConditionerOn: true },
    });

    const { root } = await mountMachinesView();
    await openEnvironmentDrawer(root);
    const dialog = requireElement(
      root.querySelector<HTMLElement>('[role="dialog"]'),
      "environment dialog",
    );
    requireElement(
      Array.from(dialog.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("开启"),
      ),
      "air-conditioner on button",
    ).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();

    expect(apiMocks.messageSuccess).toHaveBeenCalledWith("空调控制已完成");
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
        },
      }),
    );

    const { root } = await mountMachinesView();
    await openEnvironmentDrawer(root);
    const dialog = requireElement(
      root.querySelector<HTMLElement>('[role="dialog"]'),
      "environment dialog",
    );
    const closeButton = Array.from(dialog.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("软关闭"),
    );
    const actionSetButtons = Array.from(
      dialog.querySelectorAll("button"),
    ).filter((button) => button.textContent?.includes("设定"));

    let resolveCommand: ((value: unknown) => void) | undefined;
    commandEnvironment.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveCommand = resolve;
      }),
    );
    closeButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();
    expect(closeButton?.disabled).toBe(true);
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
    expect(dialog.textContent).toContain("命令成功");

    commandEnvironment.mockResolvedValueOnce({
      id: "cmd-3",
      commandNo: "MCMD3",
      status: "failed",
    });
    actionSetButtons[0].dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    await flushPromises();
    expect(dialog.textContent).toContain("命令失败");

    commandEnvironment.mockResolvedValueOnce({
      id: "cmd-4",
      commandNo: "MCMD4",
      status: "timeout",
    });
    actionSetButtons[0].dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    await flushPromises();
    expect(dialog.textContent).toContain("命令超时");
  });

  it("tracks environment command progress until terminal status and releases controls", async () => {
    const machine = createMachineFixture({
      latestEnvironment: {
        temperatureCelsius: 21,
        humidityRh: 50,
        sampledAt: "2026-06-04T05:02:00.000Z",
        sensorStatus: "unknown",
      },
    });
    const pendingCommand = {
      id: "cmd-poll",
      machineId: machine.id,
      commandNo: "MCMD-PENDING",
      type: "environment-control",
      status: "sent",
      payloadJson: { airConditionerOn: true },
    };
    const acknowledgedCommand = {
      ...pendingCommand,
      status: "acknowledged",
      payloadJson: { airConditionerOn: true },
    };
    const succeededCommand = {
      ...pendingCommand,
      status: "succeeded",
      payloadJson: { airConditionerOn: true },
    };

    listMachines.mockResolvedValue({
      items: [machine],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    getMachine
      .mockResolvedValueOnce({
        ...machine,
        latestEnvironmentCommand: null,
      })
      .mockResolvedValueOnce({
        ...machine,
        latestEnvironmentCommand: acknowledgedCommand,
      })
      .mockResolvedValueOnce({
        ...machine,
        latestEnvironmentCommand: succeededCommand,
      });
    commandEnvironment.mockResolvedValue(pendingCommand);

    const { root } = await mountMachinesView();
    vi.useFakeTimers();
    try {
      const environmentButton = Array.from(
        root.querySelectorAll("button"),
      ).find((button) => button.textContent?.includes("环境"));
      environmentButton?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
      await Promise.resolve();
      await nextTick();
      const dialog = requireElement(
        root.querySelector<HTMLElement>('[role="dialog"]'),
        "environment dialog",
      );
      const openButton = Array.from(dialog.querySelectorAll("button")).find(
        (button) => button.textContent?.includes("开启"),
      );
      openButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      expect(openButton?.disabled).toBe(true);
      expect(dialog.textContent).toContain("命令");

      const pollerCallAfterSubmit = getMachine.mock.calls.length;

      await vi.advanceTimersByTimeAsync(500);
      await Promise.resolve();
      await nextTick();
      expect(dialog.textContent).toContain("命令成功");
      expect(openButton?.disabled).toBe(false);
      expect(getMachine.mock.calls.length).toBeGreaterThan(
        pollerCallAfterSubmit,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops polling when view is unmounted while command remains pending", async () => {
    const machine = createMachineFixture({
      latestEnvironment: {
        temperatureCelsius: 21,
        humidityRh: 50,
        sampledAt: "2026-06-04T05:02:00.000Z",
        sensorStatus: "unknown",
      },
    });
    const pendingCommand = {
      id: "cmd-unmount",
      machineId: machine.id,
      commandNo: "MCMD-PENDING-UNMOUNT",
      type: "environment-control",
      status: "sent",
      payloadJson: { airConditionerOn: true },
    };

    listMachines.mockResolvedValue({
      items: [machine],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    getMachine
      .mockResolvedValueOnce({
        ...machine,
        latestEnvironmentCommand: null,
      })
      .mockResolvedValue({
        ...machine,
        latestEnvironmentCommand: pendingCommand,
      });
    commandEnvironment.mockResolvedValue({
      ...pendingCommand,
      status: "sent",
    });

    const { app, root } = await mountMachinesView();
    vi.useFakeTimers();
    try {
      const environmentButton = Array.from(
        root.querySelectorAll("button"),
      ).find((button) => button.textContent?.includes("环境"));
      environmentButton?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
      await Promise.resolve();
      await nextTick();
      const openButton = Array.from(
        root.querySelectorAll('[role="dialog"] button'),
      ).find((button) => button.textContent?.includes("开启"));
      openButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();

      const baselineCalls = getMachine.mock.calls.length;
      app.unmount();
      await vi.advanceTimersByTimeAsync(2000);
      expect(getMachine).toHaveBeenCalledTimes(baselineCalls);
    } finally {
      vi.useRealTimers();
    }
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
        },
      }),
    );

    const { root } = await mountMachinesView(["machines.read"]);
    await openEnvironmentDrawer(root);
    const dialog = requireElement(
      root.querySelector<HTMLElement>('[role="dialog"]'),
      "environment dialog",
    );

    expect(dialog.textContent).toContain("命令状态未知");
    expect(dialog.textContent).toContain("空调");
    expect(
      Array.from(dialog.querySelectorAll("button")).every(
        (button) => button.disabled,
      ),
    ).toBe(true);
    expect(
      Array.from(dialog.querySelectorAll("input")).every(
        (input) => input.disabled,
      ),
    ).toBe(true);
    expect(
      Array.from(dialog.querySelectorAll("select")).every(
        (select) => select.disabled,
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
