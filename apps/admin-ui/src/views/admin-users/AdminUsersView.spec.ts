// @vitest-environment jsdom

import type { PermissionCode } from "@vem/shared";

import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, type PropType } from "vue";

import { useAuthStore } from "@/stores/auth";

import AdminUsersView from "./AdminUsersView.vue";

const apiMocks = vi.hoisted(() => ({
  createAdminUser: vi.fn(),
  listAdminUsers: vi.fn(),
  updateAdminUser: vi.fn(),
  listRoles: vi.fn(),
}));

vi.mock("@/api/admin-users", async () => {
  const actual =
    await vi.importActual<typeof import("@/api/admin-users")>(
      "@/api/admin-users",
    );
  return {
    ...actual,
    createAdminUser: apiMocks.createAdminUser,
    listAdminUsers: apiMocks.listAdminUsers,
    updateAdminUser: apiMocks.updateAdminUser,
  };
});

vi.mock("@/api/roles", async () => {
  const actual =
    await vi.importActual<typeof import("@/api/roles")>("@/api/roles");
  return {
    ...actual,
    listRoles: apiMocks.listRoles,
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
  },
  emits: ["update:open"],
  setup(props, { slots }) {
    return () =>
      props.open
        ? h("section", [
            props.title ? h("h2", props.title) : null,
            props.label ? h("span", props.label) : null,
            slots.default?.(),
          ])
        : null;
  },
});

const ButtonStub = defineComponent({
  emits: ["click"],
  setup(_, { slots, emit }) {
    return () => h("button", { onClick: () => emit("click") }, slots.default?.());
  },
});

const TableStub = defineComponent({
  props: {
    columns: { type: Array as PropType<unknown[]>, default: () => [] },
    dataSource: { type: Array as PropType<unknown[]>, default: () => [] },
  },
  setup() {
    return () => h("table");
  },
});

function installStubs(app: ReturnType<typeof createApp>): void {
  for (const name of [
    "a-card",
    "a-drawer",
    "a-form",
    "a-form-item",
    "a-input",
    "a-input-password",
    "a-select",
    "a-select-option",
    "a-tag",
  ]) {
    app.component(name, PassthroughStub);
  }
  app.component("a-button", ButtonStub);
  app.component("a-table", TableStub);
}

async function mountAdminUsersView(permissions: PermissionCode[]) {
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
  const app = createApp(AdminUsersView);
  app.use(pinia);
  installStubs(app);
  app.mount(root);
  await flushPromises();
  return { app, root };
}

describe("AdminUsersView permissions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
    apiMocks.listAdminUsers.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    });
    apiMocks.listRoles.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    });
  });

  it("does not request role picker data for read-only admin users", async () => {
    await mountAdminUsersView(["adminUsers.read"]);

    expect(apiMocks.listAdminUsers).toHaveBeenCalledWith({
      page: 1,
      pageSize: 20,
    });
    expect(apiMocks.listRoles).not.toHaveBeenCalled();
  });

  it("requests role picker data when the admin can write users", async () => {
    await mountAdminUsersView(["adminUsers.read", "adminUsers.write"]);

    expect(apiMocks.listRoles).toHaveBeenCalledWith();
  });
});
