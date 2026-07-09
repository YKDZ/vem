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
  createPaymentIncidentAction: vi.fn(),
  createOrderRecoveryAction: vi.fn(),
  getOrderInvestigation: vi.fn(),
}));

vi.mock("@/api/payments", async () => {
  const actual =
    await vi.importActual<typeof import("@/api/payments")>("@/api/payments");
  return {
    ...actual,
    createPaymentIncidentAction: apiMocks.createPaymentIncidentAction,
  };
});

vi.mock("@/api/orders", async () => {
  const actual =
    await vi.importActual<typeof import("@/api/orders")>("@/api/orders");
  return {
    ...actual,
    createOrderRecoveryAction: apiMocks.createOrderRecoveryAction,
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
    "a-collapse",
    "a-collapse-panel",
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
    requiresPhysicalOutcomeConfirmation: false,
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
    expect(document.body.textContent).toContain("暂无支付事件");
    expect(document.body.textContent).toContain("暂无回调尝试");
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

  it("identifies result_unknown vending commands as requiring physical outcome confirmation", async () => {
    apiMocks.getOrderInvestigation.mockResolvedValue({
      ...baseInvestigation,
      vendingCommands: [
        {
          id: "command-unknown",
          commandNo: "VC-UNKNOWN",
          status: "result_unknown",
          machineCode: "VEM-001",
          slotCode: "A1",
          lastError: "dispense result unknown after command timeout",
        },
      ],
      fulfillmentProjection: {
        state: "manual_handling",
        latestCommand: {
          commandNo: "VC-UNKNOWN",
          status: "result_unknown",
        },
        requiresPhysicalOutcomeConfirmation: true,
        availableRecoveryActions: [
          "confirm_dispensed",
          "confirm_not_dispensed",
        ],
      },
    });

    mountDrawer(["orders.read"]);
    await flushPromises();
    await nextTick();

    expect(document.body.textContent).toContain("VC-UNKNOWN");
    expect(document.body.textContent).toContain("待物理结果确认");
    expect(document.body.textContent).toContain("需要确认");
    expect(document.body.textContent).toContain(
      "dispense result unknown after command timeout",
    );
    expect(document.body.textContent).not.toContain("确认已出");
  });

  it("submits auditable recovery actions only with recovery permission and note", async () => {
    apiMocks.getOrderInvestigation.mockResolvedValue({
      ...baseInvestigation,
      vendingCommands: [
        {
          id: "command-unknown",
          commandNo: "VC-UNKNOWN",
          status: "result_unknown",
          machineCode: "VEM-001",
          slotCode: "A1",
        },
      ],
      fulfillmentProjection: {
        state: "manual_handling",
        latestCommand: {
          commandNo: "VC-UNKNOWN",
          status: "result_unknown",
        },
        requiresPhysicalOutcomeConfirmation: true,
        availableRecoveryActions: [
          "confirm_dispensed",
          "confirm_not_dispensed",
        ],
      },
    });
    apiMocks.createOrderRecoveryAction.mockResolvedValue(undefined);

    mountDrawer(["orders.read", "orders.recover"]);
    await flushPromises();
    await nextTick();

    expect(document.body.textContent).toContain("确认已出");
    const note = document.querySelector("textarea");
    expect(note).toBeTruthy();
    note!.value = "operator checked pickup bin";
    note!.dispatchEvent(new Event("input"));
    await nextTick();
    document
      .querySelectorAll("button")[0]
      ?.dispatchEvent(new MouseEvent("click"));
    await flushPromises();

    expect(apiMocks.createOrderRecoveryAction).toHaveBeenCalledWith("order-1", {
      action: "confirm_dispensed",
      note: "operator checked pickup bin",
    });
  });

  it("shows only remedy actions after physical not-dispensed confirmation", async () => {
    apiMocks.getOrderInvestigation.mockResolvedValue({
      ...baseInvestigation,
      vendingCommands: [
        {
          id: "command-unknown",
          commandNo: "VC-UNKNOWN",
          status: "failed",
          machineCode: "VEM-001",
          slotCode: "A1",
        },
      ],
      fulfillmentProjection: {
        state: "dispense_failed",
        latestCommand: {
          commandNo: "VC-UNKNOWN",
          status: "failed",
        },
        requiresPhysicalOutcomeConfirmation: false,
        availableRecoveryActions: ["request_refund", "compensation_dispense"],
      },
    });

    mountDrawer(["orders.read", "orders.recover"]);
    await flushPromises();
    await nextTick();

    expect(document.body.textContent).not.toContain("确认已出");
    expect(document.body.textContent).not.toContain("确认未出");
    expect(document.body.textContent).toContain("申请退款");
    expect(document.body.textContent).toContain("补偿出货");
  });

  it("hides recovery controls after recovery is complete", async () => {
    apiMocks.getOrderInvestigation.mockResolvedValue({
      ...baseInvestigation,
      vendingCommands: [
        {
          id: "command-unknown",
          commandNo: "VC-UNKNOWN",
          status: "succeeded",
          machineCode: "VEM-001",
          slotCode: "A1",
        },
      ],
      fulfillmentProjection: {
        state: "dispensed",
        latestCommand: {
          commandNo: "VC-UNKNOWN",
          status: "succeeded",
        },
        requiresPhysicalOutcomeConfirmation: false,
        availableRecoveryActions: [],
      },
    });

    mountDrawer(["orders.read", "orders.recover"]);
    await flushPromises();
    await nextTick();

    expect(document.body.textContent).not.toContain("确认已出");
    expect(document.body.textContent).not.toContain("申请退款");
    expect(document.querySelector("textarea")).toBeNull();
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

  it("renders payment-code query and reversal evidence without provider diagnostics for payment readers", async () => {
    apiMocks.getOrderInvestigation.mockResolvedValue({
      ...baseInvestigation,
      paymentCodeAttempts: [
        {
          id: "attempt-1",
          attemptNo: 1,
          status: "reversed",
          authCodeMasked: "2876****4394",
          source: "serial_text",
          manualReason: "query_timeout_reversed",
          protectedDiagnostics: {
            providerPaymentNo: "PCA001",
            providerTradeNo: "ALI-TXN-001",
            providerStatus: "TRADE_CLOSED",
            failureCode: "PAYMENT_CODE_REVERSED",
            failureMessage: "本次付款码交易已撤销，请刷新付款码后重试",
          },
          lastCheckedAt: "2026-06-26T04:01:00.000Z",
          reversedAt: "2026-06-26T04:02:00.000Z",
        },
      ],
    });

    mountDrawer(["orders.read", "payments.read"]);
    await flushPromises();
    await nextTick();

    expect(document.body.textContent).not.toContain("PCA001");
    expect(document.body.textContent).not.toContain("ALI-TXN-001");
    expect(document.body.textContent).not.toContain("TRADE_CLOSED");
    expect(document.body.textContent).not.toContain("PAYMENT_CODE_REVERSED");
    expect(document.body.textContent).toContain("已撤销");
    expect(document.body.textContent).toContain("query_timeout_reversed");
    expect(document.body.textContent).toContain("2876****4394");
    expect(document.body.textContent).not.toContain("28763443825664394");
  });

  it("shows provider payment-code diagnostics only to diagnostic readers", async () => {
    apiMocks.getOrderInvestigation.mockResolvedValue({
      ...baseInvestigation,
      paymentCodeAttempts: [
        {
          id: "attempt-1",
          attemptNo: 1,
          status: "reversed",
          authCodeMasked: "2876****4394",
          source: "serial_text",
          manualReason: "query_timeout_reversed",
          protectedDiagnostics: {
            providerPaymentNo: "PCA001",
            providerTradeNo: "ALI-TXN-001",
            providerStatus: "TRADE_CLOSED",
            failureCode: "PAYMENT_CODE_REVERSED",
            failureMessage: "本次付款码交易已撤销，请刷新付款码后重试",
          },
          lastCheckedAt: "2026-06-26T04:01:00.000Z",
          reversedAt: "2026-06-26T04:02:00.000Z",
        },
      ],
    });

    mountDrawer(["orders.read", "payments.read", "audit.read"]);
    await flushPromises();
    await nextTick();

    expect(document.body.textContent).toContain("PCA001");
    expect(document.body.textContent).toContain("ALI-TXN-001");
    expect(document.body.textContent).toContain("TRADE_CLOSED");
    expect(document.body.textContent).toContain("PAYMENT_CODE_REVERSED");
  });

  it("shows payment incident states and safe actions in concise Chinese", async () => {
    apiMocks.getOrderInvestigation.mockResolvedValue({
      ...baseInvestigation,
      order: {
        ...baseInvestigation.order,
        status: "manual_handling",
        paymentState: "payment_unknown",
        fulfillmentState: "manual_handling",
      },
      payments: [
        {
          id: "payment-unknown",
          paymentNo: "PAY-UNKNOWN",
          status: "unknown",
          amountCents: 1200,
          paidAt: null,
        },
      ],
      paymentEvents: [
        {
          id: "event-unknown",
          paymentId: "payment-unknown",
          eventType: "payment.unknown",
          signatureValid: true,
          protectedDiagnostics: {
            providerEventId: "provider-event-1",
          },
          handledAt: "2026-06-26T04:00:00.000Z",
          createdAt: "2026-06-26T04:00:00.000Z",
        },
      ],
      paymentCodeAttempts: [
        {
          id: "attempt-reversal-unknown",
          attemptNo: 1,
          status: "reversal_unknown",
          authCodeMasked: "2876****4394",
          source: "serial_text",
          manualReason: "provider timeout",
          protectedDiagnostics: {
            providerPaymentNo: "PCA001",
            providerTradeNo: null,
            providerStatus: "UNKNOWN",
            failureCode: "PAYMENT_CODE_REVERSE_UNKNOWN",
            failureMessage: "撤销结果未知",
          },
          lastCheckedAt: "2026-06-26T04:01:00.000Z",
          reversedAt: null,
        },
      ],
      refunds: [
        {
          id: "refund-processing",
          refundNo: "RFD-PROCESSING",
          status: "processing",
          amountCents: 1200,
          reason: "admin_refund",
          reconciliationAttempts: [
            {
              trigger: "manual",
              attemptNo: 1,
              status: "network_error",
              protectedDiagnostics: {
                providerRefundStatus: null,
                providerRefundNo: null,
                errorCode: "query_failed",
                errorMessage: "provider timeout",
              },
              nextRetryAt: null,
              startedAt: "2026-06-26T04:03:00.000Z",
              finishedAt: "2026-06-26T04:03:01.000Z",
              createdAt: "2026-06-26T04:03:00.000Z",
            },
          ],
        },
        {
          id: "refund-failed",
          refundNo: "RFD-FAILED",
          status: "failed",
          amountCents: 1200,
          reason: "admin_refund",
        },
      ],
    });
    apiMocks.createPaymentIncidentAction.mockResolvedValue({
      action: "query_payment",
      status: "processing",
      handled: false,
      message: "支付结果仍待确认",
      protectedDiagnostics: {},
    });

    mountDrawer(["orders.read", "payments.read", "payments.configure"]);
    await flushPromises();
    await nextTick();

    const text = document.body.textContent ?? "";
    expect(text).toContain("支付结果未知");
    expect(text).toContain("有效");
    expect(text).toContain("provider-event-1");
    expect(text).toContain("撤销结果未知");
    expect(text).toContain("退款处理中");
    expect(text).toContain("最近查询失败");
    expect(text).toContain("provider timeout");
    expect(text).toContain("退款失败");
    expect(text).toContain("查询支付");
    expect(text).toContain("关闭/撤销不确定支付");
    expect(text).toContain("查询退款");
    expect(text).toContain("申请退款处理");
    expect(text).toContain("标记人工处理");
    expect(text).not.toContain("payment_unknown");
    expect(text).not.toContain("payment.unknown");
    expect(text).not.toContain("reversal_unknown");
    expect(text).not.toContain("manual_handling");

    const note = document.querySelector<HTMLTextAreaElement>(
      "textarea[placeholder='填写支付处理备注']",
    );
    expect(note).toBeTruthy();
    if (!note) throw new Error("incident action note textarea missing");
    note.value = "operator checks provider";
    note.dispatchEvent(new Event("input"));
    await nextTick();
    Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("查询支付"))
      ?.dispatchEvent(new MouseEvent("click"));
    await flushPromises();

    expect(apiMocks.createPaymentIncidentAction).toHaveBeenCalledWith(
      "payment-unknown",
      {
        action: "query_payment",
        reason: "operator checks provider",
      },
    );
  });
});
