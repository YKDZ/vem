// @vitest-environment jsdom

import type { PermissionCode } from "@vem/shared";

import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick, type PropType } from "vue";

import { useAuthStore } from "@/stores/auth";

import InventoryView from "./InventoryView.vue";

const apiMocks = vi.hoisted(() => ({
  adjustInventory: vi.fn(),
  createInventory: vi.fn(),
  listInventories: vi.fn(),
  listInventoryMovements: vi.fn(),
  listMachines: vi.fn(),
  listMachineSlots: vi.fn(),
  listProducts: vi.fn(),
  listProductVariants: vi.fn(),
  messageError: vi.fn(),
}));

vi.mock("@/api/inventory", async () => {
  const actual =
    await vi.importActual<typeof import("@/api/inventory")>("@/api/inventory");
  return {
    ...actual,
    adjustInventory: apiMocks.adjustInventory,
    createInventory: apiMocks.createInventory,
    listInventories: apiMocks.listInventories,
    listInventoryMovements: apiMocks.listInventoryMovements,
  };
});

vi.mock("@/api/machines", async () => {
  const actual =
    await vi.importActual<typeof import("@/api/machines")>("@/api/machines");
  return {
    ...actual,
    listMachines: apiMocks.listMachines,
    listMachineSlots: apiMocks.listMachineSlots,
  };
});

vi.mock("@/api/products", async () => {
  const actual =
    await vi.importActual<typeof import("@/api/products")>("@/api/products");
  return {
    ...actual,
    listProducts: apiMocks.listProducts,
    listProductVariants: apiMocks.listProductVariants,
  };
});

vi.mock("antdv-next", () => ({
  App: {
    useApp: () => ({
      message: { error: apiMocks.messageError },
    }),
  },
}));

vi.mock("@/components/OrderDetailDrawer.vue", () => ({
  default: { template: "<section data-test='order-detail-stub' />" },
}));

async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

type TableColumn = {
  title: string;
  key: string;
  dataIndex?: string;
};

const PassthroughStub = defineComponent({
  props: {
    title: { type: String, default: "" },
  },
  setup(props, { slots }) {
    return () => h("section", [props.title, slots.default?.()]);
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
          onClick: () => emit("click"),
        },
        slots.default?.(),
      );
  },
});

const ModalStub = defineComponent({
  props: {
    open: { type: Boolean, default: false },
    title: { type: String, default: "" },
    confirmLoading: { type: Boolean, default: false },
    okButtonProps: {
      type: Object as PropType<{ disabled?: boolean }>,
      default: () => ({}),
    },
  },
  emits: ["ok", "update:open"],
  setup(props, { emit, slots }) {
    return () =>
      props.open
        ? h("section", { role: "dialog", "aria-label": props.title }, [
            h("h2", props.title),
            slots.default?.(),
            h(
              "button",
              {
                disabled:
                  props.confirmLoading || props.okButtonProps.disabled === true,
                onClick: () => emit("ok"),
              },
              "确定",
            ),
          ])
        : null;
  },
});

const FormItemStub = defineComponent({
  props: {
    label: { type: String, default: "" },
  },
  setup(props, { slots }) {
    return () => h("label", [h("span", props.label), slots.default?.()]);
  },
});

const InputStub = defineComponent({
  props: {
    value: { type: String, default: "" },
  },
  emits: ["update:value"],
  setup(props, { emit }) {
    return () =>
      h("input", {
        value: props.value,
        onInput: (event: Event) => {
          emit("update:value", (event.target as HTMLInputElement).value);
        },
      });
  },
});

const InputNumberStub = defineComponent({
  props: {
    value: { type: Number, default: undefined },
    min: { type: Number, default: undefined },
  },
  emits: ["update:value"],
  setup(props, { emit }) {
    return () =>
      h("input", {
        type: "number",
        value: props.value,
        min: props.min,
        onInput: (event: Event) => {
          emit(
            "update:value",
            Number((event.target as HTMLInputElement).value),
          );
        },
      });
  },
});

const SelectStub = defineComponent({
  props: {
    value: { type: String, default: "" },
    disabled: { type: Boolean, default: false },
  },
  emits: ["update:value", "change"],
  setup(props, { emit, slots }) {
    return () =>
      h(
        "select",
        {
          value: props.value,
          disabled: props.disabled,
          onChange: (event: Event) => {
            const value = (event.target as HTMLSelectElement).value;
            emit("update:value", value);
            emit("change", value);
          },
        },
        [h("option", { value: "" }, "请选择"), slots.default?.()],
      );
  },
});

const SelectOptionStub = defineComponent({
  props: {
    value: { type: String, required: true },
  },
  setup(props, { slots }) {
    return () => h("option", { value: props.value }, slots.default?.());
  },
});

const TableStub = defineComponent({
  props: {
    columns: { type: Array as PropType<TableColumn[]>, required: true },
    dataSource: {
      type: Array as PropType<Record<string, unknown>[]>,
      required: true,
    },
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
                const value = column.dataIndex ? record[column.dataIndex] : "";
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

function setSelect(select: HTMLSelectElement, value: string): void {
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

function setInput(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function mountView(permissions: PermissionCode[]) {
  const pinia = createPinia();
  setActivePinia(pinia);
  useAuthStore().currentAdmin = {
    id: "admin-1",
    username: "operator",
    displayName: "Operator",
    roles: [],
    permissions,
  };

  const root = document.createElement("div");
  document.body.appendChild(root);
  const app = createApp(InventoryView);
  app.use(pinia);
  app.component("ACard", PassthroughStub);
  app.component("AButton", ButtonStub);
  app.component("AForm", PassthroughStub);
  app.component("AFormItem", FormItemStub);
  app.component("AInput", InputStub);
  app.component("AInputNumber", InputNumberStub);
  app.component("AModal", ModalStub);
  app.component("ASelect", SelectStub);
  app.component("ASelectOption", SelectOptionStub);
  app.component("ASpace", PassthroughStub);
  app.component("ATable", TableStub);
  app.component(
    "RouterLink",
    defineComponent({
      props: { to: { type: [String, Object], required: true } },
      setup(_props, { slots }) {
        return () => h("a", slots.default?.());
      },
    }),
  );
  app.mount(root);
  await flushPromises();
  await nextTick();
  return { app, root };
}

describe("InventoryView", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
    apiMocks.listInventories.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    });
    apiMocks.listInventoryMovements.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    });
    apiMocks.listMachines.mockResolvedValue({
      items: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          code: "VEM-001",
          name: "前厅机器",
          locationLabel: null,
          geoLocation: null,
          status: "online",
          mqttClientId: null,
          lastSeenAt: null,
          createdAt: "2026-07-25T00:00:00.000Z",
          updatedAt: "2026-07-25T00:00:00.000Z",
        },
      ],
      total: 1,
      page: 1,
      pageSize: 100,
    });
    apiMocks.listMachineSlots.mockResolvedValue([
      {
        id: "22222222-2222-4222-8222-222222222222",
        machineId: "11111111-1111-4111-8111-111111111111",
        rowNo: 7,
        cellNo: 2,
        capacity: 10,
        status: "active",
        createdAt: "2026-07-25T00:00:00.000Z",
        updatedAt: "2026-07-25T00:00:00.000Z",
        deletedAt: null,
      },
    ]);
    apiMocks.listProducts.mockResolvedValue({
      items: [
        {
          id: "33333333-3333-4333-8333-333333333333",
          name: "唐诗村 T 恤",
          categoryId: null,
          description: null,
          displayImageMediaAssetId: null,
          displayImageMediaAsset: null,
          status: "active",
          sortOrder: 0,
          createdAt: "2026-07-25T00:00:00.000Z",
          updatedAt: "2026-07-25T00:00:00.000Z",
        },
      ],
      total: 1,
      page: 1,
      pageSize: 100,
    });
    apiMocks.listProductVariants.mockResolvedValue({
      items: [
        {
          id: "44444444-4444-4444-8444-444444444444",
          productId: "33333333-3333-4333-8333-333333333333",
          sku: "TSHIRT-BLACK-L",
          size: "L",
          color: "黑色",
          barcode: null,
          priceCents: 6900,
          costCents: null,
          status: "active",
          targetGender: null,
          tryOnSilhouetteMediaAssetId: null,
          tryOnSilhouetteMediaAsset: null,
          createdAt: "2026-07-25T00:00:00.000Z",
          updatedAt: "2026-07-25T00:00:00.000Z",
        },
      ],
      total: 1,
      page: 1,
      pageSize: 100,
    });
    apiMocks.createInventory.mockResolvedValue({});
  });

  it("binds inventory through operator selections instead of raw identifiers", async () => {
    const { root } = await mountView(["inventory.adjust"]);

    root.querySelector("button")?.click();
    await flushPromises();
    await nextTick();

    expect(root.textContent).toContain("绑定库存");
    expect(root.textContent).toContain("机器");
    expect(root.textContent).toContain("货道");
    expect(root.textContent).toContain("商品规格");
    expect(root.textContent).not.toContain("机器ID");
    expect(root.textContent).not.toContain("格口ID");
    expect(root.textContent).not.toContain("SKU ID");
    expect(root.textContent).toContain("VEM-001 · 前厅机器");
    expect(root.textContent).toContain("唐诗村 T 恤");

    const selects = Array.from(root.querySelectorAll("select"));
    expect(selects).toHaveLength(4);
    setSelect(selects[0], "11111111-1111-4111-8111-111111111111");
    await flushPromises();
    await nextTick();
    expect(apiMocks.listMachineSlots).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
    );
    expect(root.textContent).toContain("第 7 层 / 第 2 格");

    setSelect(selects[1], "22222222-2222-4222-8222-222222222222");
    setSelect(selects[2], "33333333-3333-4333-8333-333333333333");
    await flushPromises();
    await nextTick();
    expect(apiMocks.listProductVariants).toHaveBeenCalledWith(
      "33333333-3333-4333-8333-333333333333",
    );
    expect(root.textContent).toContain("TSHIRT-BLACK-L");

    setSelect(selects[3], "44444444-4444-4444-8444-444444444444");
    const quantityInput = root.querySelector<HTMLInputElement>(
      "input[type='number']",
    );
    if (!quantityInput) throw new Error("quantity input not found");
    setInput(quantityInput, "10");
    await nextTick();
    Array.from(root.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("确定"))
      ?.click();
    await flushPromises();

    expect(apiMocks.createInventory).toHaveBeenCalledWith({
      machineId: "11111111-1111-4111-8111-111111111111",
      slotId: "22222222-2222-4222-8222-222222222222",
      variantId: "44444444-4444-4444-8444-444444444444",
      onHandQty: 10,
      reservedQty: 0,
      lowStockThreshold: 1,
      note: undefined,
    });
  });
});
