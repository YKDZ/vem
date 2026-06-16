// @vitest-environment jsdom

import type { PermissionCode } from "@vem/shared";

import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick, type PropType } from "vue";

import { useAuthStore } from "@/stores/auth";

import MachineDetailView from "./MachineDetailView.vue";

const apiMocks = vi.hoisted(() => ({
  getMachine: vi.fn(),
  listMachineSlots: vi.fn(),
  commandEnvironment: vi.fn(),
  listInventories: vi.fn(),
  refillInventory: vi.fn(),
  adjustInventory: vi.fn(),
  listMachineOps: vi.fn(),
  requestLogExport: vi.fn(),
}));
const routerMocks = vi.hoisted(() => ({
  push: vi.fn(),
}));

vi.mock("vue-router", () => ({
  useRoute: () => ({
    params: { id: "11111111-1111-4111-8111-111111111111" },
  }),
  useRouter: () => routerMocks,
}));

vi.mock("@/api/machines", async () => {
  const actual =
    await vi.importActual<typeof import("@/api/machines")>("@/api/machines");
  return {
    ...actual,
    getMachine: apiMocks.getMachine,
    listMachineSlots: apiMocks.listMachineSlots,
    commandEnvironment: apiMocks.commandEnvironment,
  };
});

vi.mock("@/api/inventory", () => ({
  listInventories: apiMocks.listInventories,
  refillInventory: apiMocks.refillInventory,
  adjustInventory: apiMocks.adjustInventory,
}));

vi.mock("@/api/machine-ops", () => ({
  listMachineOps: apiMocks.listMachineOps,
  requestLogExport: apiMocks.requestLogExport,
}));

vi.mock("antdv-next", () => ({
  Modal: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

type TableColumn = {
  title: string;
  key: string;
  dataIndex?: string;
};

type TableRecord = Record<string, unknown>;

const TableStub = defineComponent({
  props: {
    columns: { type: Array as PropType<TableColumn[]>, required: true },
    dataSource: { type: Array as PropType<TableRecord[]>, required: true },
  },
  setup(props, { slots }) {
    return () =>
      h("table", [
        h(
          "tbody",
          props.dataSource.map((record) =>
            h(
              "tr",
              props.columns.map((column) => {
                const value = column.dataIndex
                  ? record[column.dataIndex]
                  : undefined;
                return h(
                  "td",
                  slots.bodyCell?.({ column, record }) ??
                    (typeof value === "string" || typeof value === "number"
                      ? String(value)
                      : ""),
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
            emit(
              "update:checked",
              event.target instanceof HTMLInputElement
                ? event.target.checked
                : false,
            );
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
    disabled: { type: Boolean, default: false },
  },
  emits: ["update:value"],
  setup(props, { emit }) {
    return () =>
      h("input", {
        type: "number",
        value: props.value,
        disabled: props.disabled,
        onInput: (event: Event) => {
          if (event.target instanceof HTMLInputElement) {
            emit("update:value", Number(event.target.value));
          }
        },
      });
  },
});

const ModalStub = defineComponent({
  props: {
    open: { type: Boolean, default: false },
    title: { type: String, default: "" },
  },
  emits: ["ok", "update:open"],
  setup(props, { emit, slots }) {
    return () =>
      props.open
        ? h("section", { role: "dialog" }, [
            h("h2", props.title),
            slots.default?.(),
            h(
              "button",
              {
                onClick: () => {
                  emit("ok");
                },
              },
              "确定",
            ),
          ])
        : null;
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
  for (const name of [
    "a-card",
    "a-row",
    "a-col",
    "a-space",
    "a-descriptions",
    "a-descriptions-item",
    "a-form",
    "a-form-item",
    "a-input",
    "a-tag",
  ]) {
    app.component(name, PassthroughStub);
  }
  app.component("a-table", TableStub);
  app.component("a-button", ButtonStub);
  app.component("a-checkbox", CheckboxStub);
  app.component("a-switch", SwitchStub);
  app.component("a-input-number", InputNumberStub);
  app.component("a-modal", ModalStub);
}

async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function mountView(
  permissions: PermissionCode[] = [
    "machines.read",
    "machines.command",
    "inventory.refill",
    "inventory.adjust",
    "machineOps.write",
  ],
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
  const app = createApp(MachineDetailView);
  app.use(pinia);
  installStubs(app);
  app.mount(root);
  await flushPromises();
  await nextTick();
  return { root };
}

function machineFixture() {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    code: "M001",
    name: "前厅机器",
    locationText: "一层",
    status: "online",
    mqttClientId: "mqtt-M001",
    lastSeenAt: "2026-06-04T05:00:00.000Z",
    createdAt: "2026-06-04T04:00:00.000Z",
    updatedAt: "2026-06-04T04:00:00.000Z",
    latestHeartbeatReportedAt: "2026-06-04T05:01:00.000Z",
    latestHeartbeatStatus: {
      network: "online",
      mqttConnected: true,
      hardwareStatus: "ok",
      localQueueSize: 0,
      environment: {
        temperatureCelsius: 23,
        humidityRh: 51,
        sampledAt: "2026-06-04T05:01:00.000Z",
        sensorStatus: "ok",
        airConditionerOn: false,
        targetTemperatureCelsius: 24,
      },
    },
    latestEnvironment: {
      temperatureCelsius: 23,
      humidityRh: 51,
      sampledAt: "2026-06-04T05:01:00.000Z",
      sensorStatus: "ok",
      airConditionerOn: false,
      targetTemperatureCelsius: 24,
    },
    latestEnvironmentCommand: {
      id: "cmd-1",
      machineId: "11111111-1111-4111-8111-111111111111",
      commandNo: "MCMD1",
      type: "environment-control",
      status: "acknowledged",
    },
  };
}

describe("MachineDetailView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.getMachine.mockResolvedValue(machineFixture());
    apiMocks.listMachineSlots.mockResolvedValue([
      {
        id: "22222222-2222-4222-8222-222222222222",
        machineId: "11111111-1111-4111-8111-111111111111",
        layerNo: 1,
        cellNo: 2,
        slotCode: "A2",
        capacity: 6,
        status: "enabled",
      },
    ]);
    apiMocks.listInventories.mockResolvedValue({
      items: [
        {
          id: "33333333-3333-4333-8333-333333333333",
          machineId: "11111111-1111-4111-8111-111111111111",
          slotId: "22222222-2222-4222-8222-222222222222",
          variantId: "44444444-4444-4444-8444-444444444444",
          slotCode: "A2",
          sku: "SKU-A2",
          productName: "测试衬衫",
          onHandQty: 1,
          reservedQty: 0,
          availableQty: 1,
          lowStockThreshold: 1,
        },
      ],
      total: 1,
      page: 1,
      pageSize: 100,
    });
    apiMocks.listMachineOps.mockResolvedValue([]);
    apiMocks.commandEnvironment.mockResolvedValue({
      id: "cmd-2",
      commandNo: "MCMD2",
      status: "sent",
    });
    apiMocks.refillInventory.mockResolvedValue({});
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("loads single machine status, controls environment, and refills a slot inventory", async () => {
    const { root } = await mountView();

    expect(apiMocks.getMachine).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
    );
    expect(apiMocks.listInventories).toHaveBeenCalledWith({
      machineId: "11111111-1111-4111-8111-111111111111",
      page: 1,
      pageSize: 100,
    });
    expect(root.textContent).toContain("M001");
    expect(root.textContent).toContain("23 C");
    expect(root.textContent).toContain("空调关");
    expect(root.textContent).toContain("测试衬衫");
    expect(root.textContent).toContain("库存预警");

    const checkboxes = root.querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    checkboxes[0].checked = true;
    checkboxes[0].dispatchEvent(new Event("change", { bubbles: true }));
    checkboxes[1].checked = true;
    checkboxes[1].dispatchEvent(new Event("change", { bubbles: true }));
    await nextTick();
    Array.from(root.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("提交环境控制"))
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();

    expect(apiMocks.commandEnvironment).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      { airConditionerOn: true },
    );

    Array.from(root.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("补货"))
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();
    const refillInput = root.querySelector<HTMLInputElement>(
      '[role="dialog"] input[type="number"]',
    );
    expect(refillInput).not.toBeNull();
    refillInput!.value = "6";
    refillInput!.dispatchEvent(new Event("input", { bubbles: true }));
    Array.from(root.querySelectorAll('[role="dialog"] button'))
      .find((button) => button.textContent?.includes("确定"))
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();

    expect(apiMocks.refillInventory).toHaveBeenCalledWith({
      inventoryId: "33333333-3333-4333-8333-333333333333",
      quantity: 6,
      note: undefined,
    });
  });
});
