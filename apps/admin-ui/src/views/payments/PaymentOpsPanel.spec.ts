// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick, type PropType } from "vue";

import PaymentOpsPanel from "./PaymentOpsPanel.vue";

const apiMocks = vi.hoisted(() => ({
  getPaymentMachinePreflight: vi.fn(),
  getPaymentOpsMetrics: vi.fn(),
  getPaymentOpsReadiness: vi.fn(),
  listMachines: vi.fn(),
}));

vi.mock("@/api/payments", async () => {
  const actual =
    await vi.importActual<typeof import("@/api/payments")>("@/api/payments");
  return {
    ...actual,
    getPaymentMachinePreflight: apiMocks.getPaymentMachinePreflight,
    getPaymentOpsMetrics: apiMocks.getPaymentOpsMetrics,
    getPaymentOpsReadiness: apiMocks.getPaymentOpsReadiness,
  };
});

vi.mock("@/api/machines", async () => {
  const actual =
    await vi.importActual<typeof import("@/api/machines")>("@/api/machines");
  return {
    ...actual,
    listMachines: apiMocks.listMachines,
  };
});

async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const AlertStub = defineComponent({
  props: {
    message: { type: String, required: true },
    description: { type: String, default: "" },
  },
  setup(props) {
    return () => h("section", [props.message, props.description]);
  },
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

const SelectStub = defineComponent({
  props: {
    value: { type: String as PropType<string | null>, default: null },
  },
  emits: ["update:value"],
  setup(_, { emit, slots }) {
    emit("update:value", "mach-001");
    return () => h("select", slots.default?.());
  },
});

const TableStub = defineComponent({
  props: {
    dataSource: {
      type: Array as PropType<Record<string, unknown>[]>,
      required: true,
    },
    columns: {
      type: Array as PropType<Array<{ dataIndex?: string }>>,
      required: true,
    },
  },
  setup(props) {
    return () =>
      h(
        "table",
        props.dataSource.map((record) =>
          h(
            "tr",
            props.columns.map((column) => {
              const value = column.dataIndex ? record[column.dataIndex] : "";
              return h("td", typeof value === "string" ? value : "");
            }),
          ),
        ),
      );
  },
});

async function mountPaymentOpsPanel(): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp(PaymentOpsPanel);
  app.component("AAlert", AlertStub);
  app.component("AButton", ButtonStub);
  app.component(
    "ACard",
    defineComponent({
      setup:
        (_, { slots }) =>
        () =>
          h("div", slots.default?.()),
    }),
  );
  app.component(
    "ACol",
    defineComponent({
      setup:
        (_, { slots }) =>
        () =>
          h("div", slots.default?.()),
    }),
  );
  app.component(
    "ARow",
    defineComponent({
      setup:
        (_, { slots }) =>
        () =>
          h("div", slots.default?.()),
    }),
  );
  app.component("ASelect", SelectStub);
  app.component(
    "ASelectOption",
    defineComponent({
      setup:
        (_, { slots }) =>
        () =>
          h("option", slots.default?.()),
    }),
  );
  app.component(
    "ASpace",
    defineComponent({
      setup:
        (_, { slots }) =>
        () =>
          h("div", slots.default?.()),
    }),
  );
  app.component(
    "AStatistic",
    defineComponent({ setup: () => () => h("span") }),
  );
  app.component("ATable", TableStub);
  app.component(
    "ATag",
    defineComponent({
      setup:
        (_, { slots }) =>
        () =>
          h("span", slots.default?.()),
    }),
  );
  app.mount(host);
  await flushPromises();
  await nextTick();
  return host;
}

describe("PaymentOpsPanel", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("shows machine preflight production dispense path blockers", async () => {
    apiMocks.getPaymentOpsReadiness.mockResolvedValue({
      status: "ready",
      checkedAt: "2026-06-26T04:00:00.000Z",
      environment: "production",
      checks: [],
    });
    apiMocks.getPaymentOpsMetrics.mockResolvedValue({
      measuredAt: "2026-06-26T04:00:00.000Z",
      windowMinutes: 60,
      paymentFailureRate: 0,
      paymentFailedCount: 0,
      paymentTotalCount: 0,
      webhookSignatureInvalidCount: 0,
      webhookBusinessInvalidCount: 0,
      reconciliationErrorCount: 0,
      refundFailedCount: 0,
      refundProcessingOverdueCount: 0,
      certificateExpiringCount: 0,
      paymentCodeUnknownCount: 0,
      paymentCodeReverseFailedCount: 0,
      paymentCodeDuplicateRejectedCount: 0,
      scannerOfflineMachineCount: 0,
    });
    apiMocks.listMachines.mockResolvedValue({
      items: [{ id: "mach-001", code: "M001", name: "前厅机器" }],
      total: 1,
      page: 1,
      pageSize: 100,
    });
    apiMocks.getPaymentMachinePreflight.mockResolvedValue({
      machineId: "mach-001",
      machineCode: "M001",
      status: "blocked",
      availableProviders: [],
      checks: [
        {
          code: "production_dispense_path.mock",
          severity: "critical",
          passed: false,
          message: "生产出货路径不能使用 mock hardwareAdapter",
          evidence: {},
        },
      ],
      checkedAt: "2026-06-26T04:00:00.000Z",
    });

    const host = await mountPaymentOpsPanel();

    host.querySelector("button")?.click();
    await flushPromises();
    await nextTick();

    expect(host.textContent).toContain(
      "生产出货路径正在使用模拟硬件，不能上线",
    );
    expect(host.textContent).toContain("环境：生产环境");
    expect(host.textContent).not.toContain("环境：production");
    expect(host.textContent).not.toContain("hardwareAdapter");
  });

  it("shows ready payment options and provider setup blockers in Chinese", async () => {
    apiMocks.getPaymentOpsReadiness.mockResolvedValue({
      status: "blocked",
      checkedAt: "2026-06-26T04:00:00.000Z",
      environment: "test",
      checks: [
        {
          code: "provider_environment.production_ready",
          severity: "warning",
          passed: true,
          message: "当前环境允许沙箱支付配置，仅用于测试验证",
          evidence: {},
        },
      ],
    });
    apiMocks.getPaymentOpsMetrics.mockResolvedValue({
      measuredAt: "2026-06-26T04:00:00.000Z",
      windowMinutes: 60,
      paymentFailureRate: 0,
      paymentFailedCount: 0,
      paymentTotalCount: 0,
      webhookSignatureInvalidCount: 0,
      webhookBusinessInvalidCount: 0,
      reconciliationErrorCount: 0,
      refundFailedCount: 0,
      refundProcessingOverdueCount: 0,
      certificateExpiringCount: 0,
      paymentCodeUnknownCount: 0,
      paymentCodeReverseFailedCount: 0,
      paymentCodeDuplicateRejectedCount: 0,
      scannerOfflineMachineCount: 0,
    });
    apiMocks.listMachines.mockResolvedValue({
      items: [{ id: "mach-001", code: "M001", name: "前厅机器" }],
      total: 1,
      page: 1,
      pageSize: 100,
    });
    apiMocks.getPaymentMachinePreflight.mockResolvedValue({
      machineId: "mach-001",
      machineCode: "M001",
      status: "blocked",
      availableProviders: [
        {
          optionKey: "qr_code:alipay",
          providerCode: "alipay",
          method: "qr_code",
          displayName: "支付宝扫码",
          description: "请使用支付宝扫描屏幕二维码",
          icon: "alipay",
          disabled: false,
          disabledReason: null,
          recommended: true,
        },
      ],
      defaultOptionKey: "qr_code:alipay",
      defaultProviderCode: "alipay",
      checks: [
        {
          code: "enabled_channel_provider_setup",
          severity: "critical",
          passed: false,
          message: "已启用支付渠道存在商户配置阻塞",
          evidence: {
            blockedChannels: [
              {
                channelKey: "payment_code:wechat_pay",
                providerCode: "wechat_pay",
                method: "payment_code",
                missingCredentialKeys: ["providerConfig"],
              },
            ],
          },
        },
      ],
      checkedAt: "2026-06-26T04:00:00.000Z",
    });

    const host = await mountPaymentOpsPanel();

    host.querySelector("button")?.click();
    await flushPromises();
    await nextTick();

    expect(host.textContent).toContain("支付环境");
    expect(host.textContent).toContain("环境：测试环境");
    expect(host.textContent).not.toContain("环境：test");
    expect(host.textContent).toContain(
      "当前环境允许沙箱支付配置，仅用于测试验证",
    );
    expect(host.textContent).toContain("可用支付方式：支付宝扫码");
    expect(host.textContent).toContain("支付机构配置");
    expect(host.textContent).toContain("微信付款码缺少支付机构配置/证书");
    expect(host.textContent).not.toContain("qr_code");
    expect(host.textContent).not.toContain("wechat_pay");
    expect(host.textContent).not.toContain("critical");
  });
});
