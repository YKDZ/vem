// @vitest-environment jsdom

import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h } from "vue";

import LoginView from "./LoginView.vue";

const authApiMocks = vi.hoisted(() => ({
  loginApi: vi.fn(),
  meApi: vi.fn(),
}));

const routerMocks = vi.hoisted(() => ({
  replace: vi.fn(),
}));

const messageMocks = vi.hoisted(() => ({
  success: vi.fn(),
}));

vi.mock("@/api/auth", () => ({
  loginApi: authApiMocks.loginApi,
  meApi: authApiMocks.meApi,
}));

vi.mock("vue-router", () => ({
  useRoute: () => ({ query: {} }),
  useRouter: () => routerMocks,
}));

vi.mock("antdv-next", () => ({
  App: {
    useApp: () => ({ message: messageMocks }),
  },
}));

const FormStub = defineComponent({
  emits: ["finish"],
  setup(_, { emit, slots }) {
    return () =>
      h(
        "form",
        {
          onSubmit: (event: Event) => {
            event.preventDefault();
            emit("finish");
          },
        },
        slots.default?.(),
      );
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
          if (event.target instanceof HTMLInputElement) {
            emit("update:value", event.target.value);
          }
        },
      });
  },
});

const ButtonStub = defineComponent({
  props: {
    loading: { type: Boolean, default: false },
  },
  setup(props, { slots }) {
    return () =>
      h(
        "button",
        { disabled: props.loading, type: "submit" },
        slots.default?.(),
      );
  },
});

const AlertStub = defineComponent({
  props: {
    message: { type: String, required: true },
  },
  setup(props) {
    return () => h("div", { role: "alert" }, props.message);
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
  app.component("a-form", FormStub);
  app.component("a-form-item", PassthroughStub);
  app.component("a-input", InputStub);
  app.component("a-input-password", InputStub);
  app.component("a-button", ButtonStub);
  app.component("a-alert", AlertStub);
}

async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function mountView() {
  const root = document.createElement("div");
  document.body.append(root);
  const pinia = createPinia();
  setActivePinia(pinia);
  const app = createApp(LoginView);
  app.use(pinia);
  installStubs(app);
  app.mount(root);
  await flushPromises();
  return { root };
}

describe("LoginView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    authApiMocks.meApi.mockResolvedValue({
      id: "admin-1",
      username: "operator",
      displayName: "Operator",
      roles: [],
      permissions: [],
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("shows an antd alert and stays on login when credentials are rejected", async () => {
    authApiMocks.loginApi.mockRejectedValue(new Error("Unauthorized"));
    const { root } = await mountView();

    const inputs = root.querySelectorAll<HTMLInputElement>("input");
    inputs[0].value = "bad-user";
    inputs[0].dispatchEvent(new Event("input", { bubbles: true }));
    inputs[1].value = "bad-password";
    inputs[1].dispatchEvent(new Event("input", { bubbles: true }));
    root
      .querySelector("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flushPromises();

    expect(root.querySelector('[role="alert"]')?.textContent).toContain(
      "登录失败，请检查用户名和密码。",
    );
    expect(routerMocks.replace).not.toHaveBeenCalled();
  });
});
