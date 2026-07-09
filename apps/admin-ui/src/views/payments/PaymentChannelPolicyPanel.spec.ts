// @vitest-environment jsdom

import type { PermissionCode } from "@vem/shared";

import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick, type PropType } from "vue";

import { useAuthStore } from "@/stores/auth";

import PaymentChannelPolicyPanel from "./PaymentChannelPolicyPanel.vue";

const apiMocks = vi.hoisted(() => ({
  getPaymentChannelPolicy: vi.fn(),
  updatePaymentChannelPolicy: vi.fn(),
}));

vi.mock("@/api/payments", async () => {
  const actual =
    await vi.importActual<typeof import("@/api/payments")>("@/api/payments");
  return {
    ...actual,
    getPaymentChannelPolicy: apiMocks.getPaymentChannelPolicy,
    updatePaymentChannelPolicy: apiMocks.updatePaymentChannelPolicy,
  };
});

async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const ButtonStub = defineComponent({
  props: {
    disabled: { type: Boolean, default: false },
    loading: { type: Boolean, default: false },
  },
  emits: ["click"],
  setup(props, { slots, emit }) {
    return () =>
      h(
        "button",
        {
          disabled: props.disabled,
          "data-loading": String(props.loading),
          onClick: () => {
            emit("click");
          },
        },
        slots.default?.(),
      );
  },
});

const PassthroughStub = defineComponent({
  props: {
    message: { type: String, default: "" },
  },
  setup(props, { slots }) {
    return () => h("section", [props.message, slots.default?.()]);
  },
});

const SwitchStub = defineComponent({
  props: {
    checked: { type: Boolean, default: false },
    disabled: { type: Boolean, default: false },
  },
  emits: ["update:checked"],
  setup(props, { emit }) {
    return () =>
      h("button", {
        "aria-label": "启用",
        disabled: props.disabled,
        "data-checked": String(props.checked),
        onClick: () => {
          emit("update:checked", !props.checked);
        },
      });
  },
});

const TableStub = defineComponent({
  props: {
    columns: {
      type: Array as PropType<Array<{ key: string }>>,
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
            props.columns.map((column) =>
              h("td", slots.bodyCell?.({ column, record }) ?? ""),
            ),
          ),
        ),
      );
  },
});

async function mountPanel(permissions: PermissionCode[]) {
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

  const root = document.createElement("div");
  document.body.appendChild(root);
  const app = createApp(PaymentChannelPolicyPanel);
  app.use(pinia);
  app.component("AAlert", PassthroughStub);
  app.component("AButton", ButtonStub);
  app.component("ASpace", PassthroughStub);
  app.component("ASwitch", SwitchStub);
  app.component("ATable", TableStub);
  app.mount(root);
  await flushPromises();
  await nextTick();
  return { app, root };
}

describe("PaymentChannelPolicyPanel", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
    apiMocks.getPaymentChannelPolicy.mockResolvedValue({
      channels: [
        { channelKey: "qr_code:alipay", enabled: true, rank: 1 },
        { channelKey: "payment_code:alipay", enabled: true, rank: 2 },
        { channelKey: "qr_code:wechat_pay", enabled: true, rank: 3 },
        { channelKey: "payment_code:wechat_pay", enabled: false, rank: 4 },
      ],
      defaultChannelKey: "qr_code:alipay",
      updatedAt: null,
      updatedByAdminUserId: null,
    });
  });

  it("loads read-only channel policy without exposing save to payments.read users", async () => {
    const { root } = await mountPanel(["payments.read"]);

    expect(apiMocks.getPaymentChannelPolicy).toHaveBeenCalledOnce();
    expect(root.textContent).toContain("支付宝扫码");
    expect(root.textContent).toContain("只读");
    expect(root.textContent).not.toContain("保存");
    expect(apiMocks.updatePaymentChannelPolicy).not.toHaveBeenCalled();
  });
});
