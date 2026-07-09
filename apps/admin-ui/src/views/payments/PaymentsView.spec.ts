// @vitest-environment jsdom

import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createApp,
  defineComponent,
  h,
  nextTick,
  onMounted,
  type PropType,
} from "vue";

import { useAuthStore } from "@/stores/auth";

import PaymentsView from "./PaymentsView.vue";

const apiMocks = vi.hoisted(() => ({
  listPaymentCodeAttempts: vi.fn(),
  listPaymentEvents: vi.fn(),
  listPaymentProviderConfigs: vi.fn(),
  listPaymentProviders: vi.fn(),
  listPayments: vi.fn(),
  listReconciliationAttempts: vi.fn(),
  listRefunds: vi.fn(),
  listWebhookAttempts: vi.fn(),
  manualReconcile: vi.fn(),
  mockFail: vi.fn(),
  mockSucceed: vi.fn(),
  queryPaymentCodeAttempt: vi.fn(),
  queryRefund: vi.fn(),
  reversePaymentCodeAttempt: vi.fn(),
}));

vi.mock("@/api/payments", async () => {
  const actual =
    await vi.importActual<typeof import("@/api/payments")>("@/api/payments");
  return {
    ...actual,
    listPaymentCodeAttempts: apiMocks.listPaymentCodeAttempts,
    listPaymentEvents: apiMocks.listPaymentEvents,
    listPaymentProviderConfigs: apiMocks.listPaymentProviderConfigs,
    listPaymentProviders: apiMocks.listPaymentProviders,
    listPayments: apiMocks.listPayments,
    listReconciliationAttempts: apiMocks.listReconciliationAttempts,
    listRefunds: apiMocks.listRefunds,
    listWebhookAttempts: apiMocks.listWebhookAttempts,
    manualReconcile: apiMocks.manualReconcile,
    mockFail: apiMocks.mockFail,
    mockSucceed: apiMocks.mockSucceed,
    queryPaymentCodeAttempt: apiMocks.queryPaymentCodeAttempt,
    queryRefund: apiMocks.queryRefund,
    reversePaymentCodeAttempt: apiMocks.reversePaymentCodeAttempt,
  };
});

vi.mock("@/components/OrderDetailDrawer.vue", () => ({
  default: defineComponent({ setup: () => () => h("section") }),
}));
vi.mock("./PaymentChannelPolicyPanel.vue", () => ({
  default: defineComponent({ setup: () => () => h("section") }),
}));
vi.mock("./PaymentOpsPanel.vue", () => ({
  default: defineComponent({ setup: () => () => h("section") }),
}));
vi.mock("./PaymentProviderConfigDrawer.vue", () => ({
  default: defineComponent({ setup: () => () => h("section") }),
}));

async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const emptyPage = { items: [], total: 0, page: 1, pageSize: 20 };

const PassthroughStub = defineComponent({
  setup:
    (_, { slots }) =>
    () =>
      h("section", slots.default?.()),
});

const ButtonStub = defineComponent({
  emits: ["click"],
  setup(_, { emit, slots }) {
    return () =>
      h(
        "button",
        {
          onClick: () => {
            emit("click");
          },
        },
        slots.default?.(),
      );
  },
});

const TabsStub = defineComponent({
  emits: ["change"],
  props: {
    activeKey: String,
  },
  setup(_, { emit, slots }) {
    onMounted(() => {
      emit("change", "refunds");
    });
    return () => h("section", slots.default?.());
  },
});

const TableStub = defineComponent({
  props: {
    columns: {
      type: Array as PropType<Array<{ key?: string; dataIndex?: string }>>,
      required: true,
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

async function mountPaymentsView(): Promise<HTMLElement> {
  setActivePinia(createPinia());
  const authStore = useAuthStore();
  authStore.currentAdmin = {
    id: "admin-1",
    username: "admin",
    displayName: "Admin",
    roles: [],
    permissions: ["payments.read", "payments.configure"],
  };

  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp(PaymentsView);
  for (const name of [
    "a-card",
    "a-tab-pane",
    "a-space",
    "a-modal",
    "a-tag",
    "a-textarea",
  ]) {
    app.component(name, PassthroughStub);
  }
  app.component("a-button", ButtonStub);
  app.component("a-tabs", TabsStub);
  app.component("a-table", TableStub);
  app.mount(host);
  await flushPromises();
  await nextTick();
  return host;
}

async function mountPaymentsViewWithInitialTab(
  tabKey: string,
): Promise<HTMLElement> {
  setActivePinia(createPinia());
  const authStore = useAuthStore();
  authStore.currentAdmin = {
    id: "admin-1",
    username: "admin",
    displayName: "Admin",
    roles: [],
    permissions: ["payments.read", "payments.configure"],
  };

  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp(PaymentsView);
  for (const name of [
    "a-card",
    "a-tab-pane",
    "a-space",
    "a-modal",
    "a-tag",
    "a-textarea",
  ]) {
    app.component(name, PassthroughStub);
  }
  app.component("a-button", ButtonStub);
  app.component(
    "a-tabs",
    defineComponent({
      emits: ["change"],
      setup(_, { emit, slots }) {
        onMounted(() => {
          emit("change", tabKey);
        });
        return () => h("section", slots.default?.());
      },
    }),
  );
  app.component("a-table", TableStub);
  app.mount(host);
  await flushPromises();
  await nextTick();
  return host;
}

describe("PaymentsView", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("renders refund reconciliation attempts as concise Chinese copy", async () => {
    apiMocks.listPayments.mockResolvedValue(emptyPage);
    apiMocks.listRefunds.mockResolvedValue({
      ...emptyPage,
      items: [
        {
          id: "refund-1",
          refundNo: "REF-1",
          paymentNo: "PAY-1",
          orderId: "order-1",
          orderNo: "ORD-1",
          providerCode: "alipay",
          status: "processing",
          amountCents: 1200,
          reason: "出货失败",
          reconciliationAttempts: [
            {
              trigger: "provider_query",
              attemptNo: 1,
              status: "processing",
              providerRefundStatus: "REFUNDING",
              errorMessage: "网络超时",
              finishedAt: null,
              createdAt: "2026-07-08T01:00:00.000Z",
            },
          ],
          refundedAt: null,
          createdAt: "2026-07-08T00:00:00.000Z",
        },
      ],
    });

    const host = await mountPaymentsView();

    expect(host.textContent).toContain("第 1 次 退款查询：处理中");
    expect(host.textContent).toContain("渠道仍在处理");
    expect(host.textContent).toContain("网络超时");
    expect(host.textContent).not.toContain("provider");
    expect(host.textContent).not.toContain("provider_query");
    expect(host.textContent).not.toContain("processing:");
  });

  it("shows provider configuration status from the provider list", async () => {
    apiMocks.listPayments.mockResolvedValue(emptyPage);
    apiMocks.listPaymentProviders.mockResolvedValue([
      {
        id: "provider-1",
        code: "alipay",
        name: "支付宝",
        type: "alipay",
        status: "disabled",
        capabilities: {},
      },
      {
        id: "provider-2",
        code: "mock",
        name: "Mock 支付",
        type: "mock",
        status: "enabled",
        capabilities: {},
      },
    ]);
    apiMocks.listPaymentProviderConfigs.mockResolvedValue([
      {
        id: "config-1",
        providerId: "provider-1",
        providerCode: "alipay",
        providerName: "支付宝",
        machineId: null,
        merchantNo: "MCH001",
        appId: "APP001",
        publicConfigJson: {},
        derivedNotifyUrl: null,
        secretStatusJson: {},
        status: "enabled",
        updatedByAdminUserId: null,
        createdAt: "2026-07-08T00:00:00.000Z",
        updatedAt: "2026-07-08T01:00:00.000Z",
      },
    ]);

    const host = await mountPaymentsViewWithInitialTab("providers");

    expect(apiMocks.listPaymentProviderConfigs).toHaveBeenCalledOnce();
    expect(host.textContent).toContain("已配置");
    expect(host.textContent).toContain("编辑");
    expect(host.textContent).not.toContain("商户配置");
  });
});
