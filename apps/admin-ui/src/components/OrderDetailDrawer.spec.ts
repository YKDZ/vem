// @vitest-environment jsdom

import type { PermissionCode } from "@vem/shared";

import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createApp,
  defineComponent,
  h,
  nextTick,
  onMounted,
  ref,
  type PropType,
} from "vue";

import { useAuthStore } from "@/stores/auth";

import OrderDetailDrawer from "./OrderDetailDrawer.vue";

const apiMocks = vi.hoisted(() => ({
  getOrderInvestigation: vi.fn(),
}));

vi.mock("@/api/orders", async () => {
  const actual =
    await vi.importActual<typeof import("@/api/orders")>("@/api/orders");
  return {
    ...actual,
    getOrderInvestigation: apiMocks.getOrderInvestigation,
  };
});

async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const PassthroughStub = defineComponent({
  props: {
    open: { type: Boolean, default: true },
    title: { type: String, default: "" },
    label: { type: String, default: "" },
    description: { type: String, default: "" },
  },
  emits: ["update:open"],
  setup(props, { slots }) {
    return () =>
      props.open
        ? h("section", [
            props.title ? h("h2", props.title) : null,
            props.label ? h("span", props.label) : null,
            props.description ? h("span", props.description) : null,
            slots.default?.(),
          ])
        : null;
  },
});

const TableStub = defineComponent({
  props: {
    columns: {
      type: Array as PropType<Array<{ key?: string; dataIndex?: string }>>,
      default: () => [],
    },
    dataSource: {
      type: Array as PropType<Record<string, unknown>[]>,
      required: true,
    },
  },
  setup(props, { slots }) {
    return () =>
      h(
        "table",
        props.dataSource.map((record) =>
          h(
            "tr",
            props.columns.map((column) => {
              const fallback =
                column.dataIndex &&
                record[column.dataIndex] !== null &&
                record[column.dataIndex] !== undefined
                  ? String(record[column.dataIndex])
                  : "";
              return h("td", slots.bodyCell?.({ column, record }) ?? fallback);
            }),
          ),
        ),
      );
  },
});

function installStubs(app: ReturnType<typeof createApp>): void {
  for (const name of [
    "a-drawer",
    "a-spin",
    "a-descriptions",
    "a-descriptions-item",
    "a-divider",
    "a-empty",
    "a-timeline",
    "a-timeline-item",
    "a-typography-text",
  ]) {
    app.component(name, PassthroughStub);
  }
  app.component("a-table", TableStub);
}

function mountDrawer(permissions: PermissionCode[]) {
  setActivePinia(createPinia());
  const authStore = useAuthStore();
  authStore.currentAdmin = {
    id: "admin-1",
    username: "admin",
    displayName: "Admin",
    roles: [],
    permissions,
  };

  const Host = defineComponent({
    setup() {
      const drawer = ref<{ show: (orderId: string) => Promise<void> } | null>(
        null,
      );
      onMounted(() => void drawer.value?.show("order-1"));
      return () => h(OrderDetailDrawer, { ref: drawer });
    },
  });

  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp(Host);
  installStubs(app);
  app.mount(host);
  return { host, app };
}

const baseInvestigation = {
  order: {
    id: "order-1",
    orderNo: "ORD-1",
    machineId: "machine-1",
    machineCode: "VEM-001",
    status: "manual_handling",
    paymentState: "paid",
    fulfillmentState: "dispense_failed",
    totalAmountCents: 1200,
    currency: "CNY",
    paidAt: "2026-06-26T04:00:00.000Z",
    dispensedAt: null,
    canceledAt: null,
    createdAt: "2026-06-26T03:59:00.000Z",
  },
  items: [],
  payments: [],
  paymentEvents: [],
  paymentWebhookAttempts: [],
  paymentReconciliationAttempts: [],
  paymentCodeAttempts: [],
  vendingCommands: [],
  fulfillmentProjection: {
    state: "dispense_failed",
    latestCommand: null,
  },
  inventoryMovements: [],
  stockReconciliationLinks: [],
  refunds: [],
  maintenanceWorkOrders: [],
  adminAuditEntries: [],
  orderStatusEvents: [],
};

describe("OrderDetailDrawer", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("loads the order investigation surface and renders empty evidence states", async () => {
    apiMocks.getOrderInvestigation.mockResolvedValue(baseInvestigation);

    mountDrawer([
      "orders.read",
      "payments.read",
      "inventory.read",
      "maintenanceWorkOrders.read",
      "audit.read",
    ]);
    await flushPromises();
    await nextTick();

    expect(apiMocks.getOrderInvestigation).toHaveBeenCalledWith("order-1");
    expect(document.body.textContent).toContain("订单调查");
    expect(document.body.textContent).toContain("暂无Webhook尝试");
    expect(document.body.textContent).toContain("暂无付款码尝试");
    expect(document.body.textContent).toContain("暂无出货命令");
    expect(document.body.textContent).toContain("暂无库存流水");
    expect(document.body.textContent).toContain("暂无维修工单");
    expect(document.body.textContent).toContain("暂无审计记录");
  });

  it("hides payment, inventory, maintenance, and audit evidence without those permissions", async () => {
    apiMocks.getOrderInvestigation.mockResolvedValue({
      ...baseInvestigation,
      payments: [{ id: "payment-1", paymentNo: "PAY-1", status: "succeeded" }],
      paymentWebhookAttempts: [
        { id: "webhook-1", eventType: "payment.succeeded" },
      ],
      vendingCommands: [
        {
          id: "command-1",
          commandNo: "VC-1",
          status: "failed",
          machineCode: "VEM-001",
          slotCode: "A1",
        },
      ],
      inventoryMovements: [
        { id: "movement-1", inventoryId: "inventory-1", reason: "adjust" },
      ],
      maintenanceWorkOrders: [
        { id: "work-1", workOrderNo: "WO-1", title: "Check slot" },
      ],
      adminAuditEntries: [{ id: "audit-1", action: "orders.refund_request" }],
    });

    mountDrawer(["orders.read"]);
    await flushPromises();
    await nextTick();

    expect(document.body.textContent).toContain("VC-1");
    expect(document.body.textContent).not.toContain("PAY-1");
    expect(document.body.textContent).not.toContain("payment.succeeded");
    expect(document.body.textContent).not.toContain("inventory-1");
    expect(document.body.textContent).not.toContain("WO-1");
    expect(document.body.textContent).not.toContain("orders.refund_request");
  });

  it("shows a stable error state when the investigation API rejects", async () => {
    apiMocks.getOrderInvestigation.mockRejectedValue(
      new Error("Forbidden resource"),
    );

    mountDrawer(["orders.read"]);
    await flushPromises();
    await nextTick();

    expect(apiMocks.getOrderInvestigation).toHaveBeenCalledWith("order-1");
    expect(document.body.textContent).toContain("订单调查");
    expect(document.body.textContent).toContain("Forbidden resource");
  });
});
