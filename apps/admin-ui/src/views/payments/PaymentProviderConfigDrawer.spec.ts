// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createApp,
  defineComponent,
  h,
  nextTick,
  onMounted,
  ref,
  type PropType,
} from "vue";

import PaymentProviderConfigDrawer from "./PaymentProviderConfigDrawer.vue";

const apiMocks = vi.hoisted(() => ({
  listPaymentProviderConfigs: vi.fn(),
  listPaymentProviderNotifyUrlChecks: vi.fn(),
  upsertPaymentProviderConfig: vi.fn(),
}));

vi.mock("@/api/payments", async () => {
  const actual =
    await vi.importActual<typeof import("@/api/payments")>("@/api/payments");
  return {
    ...actual,
    listPaymentProviderConfigs: apiMocks.listPaymentProviderConfigs,
    listPaymentProviderNotifyUrlChecks:
      apiMocks.listPaymentProviderNotifyUrlChecks,
    upsertPaymentProviderConfig: apiMocks.upsertPaymentProviderConfig,
  };
});

async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const PassthroughStub = defineComponent({
  setup:
    (_, { slots }) =>
    () =>
      h("section", slots.default?.()),
});

const LabelledStub = defineComponent({
  props: {
    label: String,
  },
  setup(props, { slots }) {
    return () =>
      h("label", [
        props.label ? h("span", props.label) : null,
        slots.default?.(),
      ]);
  },
});

const DrawerStub = defineComponent({
  props: {
    open: Boolean,
    title: String,
  },
  setup(props, { slots }) {
    return () =>
      props.open
        ? h("aside", [h("h2", props.title ?? ""), slots.default?.()])
        : null;
  },
});

const AlertStub = defineComponent({
  setup:
    (_, { slots }) =>
    () =>
      h("section", [slots.message?.(), slots.description?.()]),
});

const FormStub = defineComponent({
  emits: ["finish"],
  setup(_, { emit, slots }) {
    return () =>
      h(
        "form",
        {
          onSubmit: (event: SubmitEvent) => {
            event.preventDefault();
            emit("finish");
          },
        },
        slots.default?.(),
      );
  },
});

const ButtonStub = defineComponent({
  props: {
    htmlType: String,
    type: String,
  },
  emits: ["click"],
  setup(props, { emit, slots }) {
    return () =>
      h(
        "button",
        {
          type: props.htmlType === "submit" ? "submit" : "button",
          onClick: () => {
            emit("click");
          },
        },
        slots.default?.(),
      );
  },
});

const TextInputStub = defineComponent({
  props: {
    value: [String, Number] as PropType<string | number>,
    readonly: Boolean,
    placeholder: String,
  },
  emits: ["update:value"],
  setup(props, { emit }) {
    return () =>
      h("input", {
        value: props.value ?? "",
        readonly: props.readonly,
        placeholder: props.placeholder,
        onInput: (event: Event) => {
          emit("update:value", (event.target as HTMLInputElement).value);
        },
      });
  },
});

const TextareaStub = defineComponent({
  props: {
    value: String,
    rows: Number,
    placeholder: String,
  },
  emits: ["update:value"],
  setup(props, { emit }) {
    return () =>
      h("textarea", {
        value: props.value ?? "",
        rows: props.rows,
        placeholder: props.placeholder,
        onInput: (event: Event) => {
          emit("update:value", (event.target as HTMLTextAreaElement).value);
        },
      });
  },
});

const InputNumberStub = defineComponent({
  props: {
    value: Number,
    min: Number,
    max: Number,
  },
  emits: ["update:value"],
  setup(props, { emit }) {
    return () =>
      h("input", {
        type: "number",
        value: props.value ?? "",
        min: props.min,
        max: props.max,
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
    value: String,
  },
  emits: ["update:value"],
  setup(props, { emit, slots }) {
    return () =>
      h(
        "select",
        {
          value: props.value,
          onChange: (event: Event) => {
            emit("update:value", (event.target as HTMLSelectElement).value);
          },
        },
        slots.default?.(),
      );
  },
});

const SelectOptionStub = defineComponent({
  props: {
    value: {
      type: String,
      required: true,
    },
  },
  setup(props, { slots }) {
    return () => h("option", { value: props.value }, slots.default?.());
  },
});

const SwitchStub = defineComponent({
  props: {
    checked: Boolean,
  },
  emits: ["update:checked"],
  setup(props, { emit }) {
    return () =>
      h("input", {
        type: "checkbox",
        checked: props.checked,
        onChange: (event: Event) => {
          emit("update:checked", (event.target as HTMLInputElement).checked);
        },
      });
  },
});

async function mountDrawer(): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const Harness = defineComponent({
    setup() {
      const open = ref(false);
      onMounted(() => {
        open.value = true;
      });
      return () =>
        h(PaymentProviderConfigDrawer, {
          open: open.value,
          providerCode: "alipay",
          providerName: "支付宝",
          "onUpdate:open": (value: boolean) => {
            open.value = value;
          },
        });
    },
  });
  const app = createApp(Harness);
  app.component("a-drawer", DrawerStub);
  app.component("a-alert", AlertStub);
  app.component("a-form", FormStub);
  app.component("a-form-item", LabelledStub);
  app.component("a-button", ButtonStub);
  app.component("a-input", TextInputStub);
  app.component("a-input-password", TextInputStub);
  app.component("a-input-number", InputNumberStub);
  app.component("a-textarea", TextareaStub);
  app.component("a-select", SelectStub);
  app.component("a-select-option", SelectOptionStub);
  app.component("a-switch", SwitchStub);
  app.component("a-descriptions-item", LabelledStub);
  for (const name of [
    "a-spin",
    "a-space",
    "a-tag",
    "a-row",
    "a-col",
    "a-divider",
    "a-descriptions",
  ]) {
    app.component(name, PassthroughStub);
  }

  app.mount(host);
  await flushPromises();
  await nextTick();
  return host;
}

describe("PaymentProviderConfigDrawer", () => {
  beforeEach(() => {
    apiMocks.listPaymentProviderConfigs.mockResolvedValue([
      {
        id: "cfg-1",
        providerId: "provider-1",
        providerCode: "alipay",
        providerName: "支付宝",
        machineId: null,
        merchantNo: "2088721101045878",
        appId: "9021000163629927",
        publicConfigJson: {
          mode: "production",
          gatewayUrl: "https://openapi.alipay.com/gateway.do",
          keyType: "PKCS8",
          storeId: "STORE-01",
          terminalId: "TERM-01",
          qrExpiresMinutes: 10,
          timeoutCompensationSeconds: 30,
        },
        sensitiveConfigJson: {},
        secretStatusJson: {
          privateKeyPem: {
            configured: true,
            updatedAt: "2026-07-24T00:00:00.000Z",
            fingerprintSha256: "private-key-fp",
          },
          appCertPem: {
            configured: true,
            updatedAt: "2026-07-24T00:00:00.000Z",
            certificateExpiresAt: "2027-07-24T00:00:00.000Z",
          },
          alipayPublicCertPem: {
            configured: false,
            updatedAt: null,
            errorCode: "CERT_PARSE_FAILED",
          },
        },
        status: "enabled",
      },
    ]);
    apiMocks.listPaymentProviderNotifyUrlChecks.mockResolvedValue([]);
    apiMocks.upsertPaymentProviderConfig.mockResolvedValue(undefined);
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("renders alipay runtime sections, derived gateway, and stored secret status", async () => {
    const host = await mountDrawer();

    expect(host.textContent).toContain("基础身份");
    expect(host.textContent).toContain("证书与私钥");
    expect(host.textContent).toContain("付款码配置");
    expect(host.textContent).toContain("运行参数");
    expect(host.textContent).toContain("应用私钥");
    expect(host.textContent).toContain("已配置");
    expect(host.textContent).toContain("private-key-fp");
    expect(host.textContent).toContain("解析错误：CERT_PARSE_FAILED");
    expect(
      Array.from(host.querySelectorAll("input")).some(
        (input) => input.value === "https://openapi.alipay.com/gateway.do",
      ),
    ).toBe(true);
  });

  it("accepts file-backed alipay secrets and saves the canonical production gateway", async () => {
    const host = await mountDrawer();
    const privateKeyInput = host.querySelector(
      'input[type="file"][accept=".txt,.pem,.key"]',
    );

    expect(privateKeyInput).toBeInstanceOf(HTMLInputElement);
    Object.defineProperty(privateKeyInput, "files", {
      configurable: true,
      value: [
        new File(["uploaded private key"], "app_private_key.pem", {
          type: "application/x-pem-file",
        }),
      ],
    });
    privateKeyInput?.dispatchEvent(new Event("change", { bubbles: true }));
    await flushPromises();

    host
      .querySelector("form")
      ?.dispatchEvent(
        new SubmitEvent("submit", { bubbles: true, cancelable: true }),
      );
    await flushPromises();

    expect(apiMocks.upsertPaymentProviderConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        providerCode: "alipay",
        publicConfigJson: expect.objectContaining({
          mode: "production",
          gatewayUrl: "https://openapi.alipay.com/gateway.do",
          storeId: "STORE-01",
          terminalId: "TERM-01",
        }),
        sensitiveConfigJson: expect.objectContaining({
          privateKeyPem: "uploaded private key",
        }),
      }),
    );
  });
});
