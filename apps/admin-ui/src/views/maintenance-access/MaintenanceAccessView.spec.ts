// @vitest-environment jsdom

import type {
  MaintenanceAccessOverviewResponse,
  PermissionCode,
} from "@vem/shared";

import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick, type PropType } from "vue";

import { useAuthStore } from "@/stores/auth";

import MaintenanceAccessView from "./MaintenanceAccessView.vue";

const apiMocks = vi.hoisted(() => ({
  createMaintenanceSession: vi.fn(),
  getMaintenanceAccessOverview: vi.fn(),
}));

vi.mock("@/api/maintenance-access", () => apiMocks);

const overview = {
  schemaVersion: "maintenance-access-overview/v1",
  sourcePeers: [
    {
      id: "550e8400-e29b-41d4-a716-446655440001",
      role: "runner",
      publicKey: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
      tunnelAddress: "10.91.1.10",
      privateKey: "runner-private-key-must-not-render",
    },
  ],
  targetMachines: [
    {
      id: "550e8400-e29b-41d4-a716-446655440002",
      code: "VEM-001",
      name: "测试机器",
      maintenancePeerId: "550e8400-e29b-41d4-a716-446655440004",
      tunnelAddress: "10.91.16.10",
    },
  ],
  sessions: [],
  desiredState: {
    schemaVersion: "maintenance-relay-desired-state/v1",
    desiredStateVersion: 12,
    generatedAt: "2026-07-10T12:00:00.000Z",
    peers: [
      {
        id: "550e8400-e29b-41d4-a716-446655440001",
        role: "runner",
        publicKey: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
        tunnelAddress: "10.91.1.10",
        privateKey: "desired-private-key-must-not-render",
      },
    ],
    authorizations: [
      {
        sessionId: "550e8400-e29b-41d4-a716-446655440003",
        sourcePeerId: "550e8400-e29b-41d4-a716-446655440001",
        sourceTunnelAddress: "10.91.1.10",
        targetMachineId: "550e8400-e29b-41d4-a716-446655440002",
        targetTunnelAddress: "10.91.16.10",
        protocol: "tcp",
        port: 22,
        expiresAt: "2026-07-10T12:30:00.000Z",
      },
    ],
    shell: "iptables -A FORWARD -j ACCEPT",
  },
  observedState: {
    schemaVersion: "maintenance-relay-observed-state/v1",
    observedAt: "2026-07-10T12:00:01.000Z",
    desiredStateSchemaVersion: "maintenance-relay-desired-state/v1",
    appliedDesiredStateVersion: 12,
    attemptedDesiredStateVersion: null,
    appliedPeerIds: ["550e8400-e29b-41d4-a716-446655440001"],
    appliedAuthorizationIds: ["550e8400-e29b-41d4-a716-446655440003"],
    peerObservations: [
      {
        peerId: "550e8400-e29b-41d4-a716-446655440001",
        latestHandshakeAt: null,
      },
    ],
    activeAuthorizationObservations: [
      {
        sessionId: "550e8400-e29b-41d4-a716-446655440003",
        expiresAt: "2026-07-10T12:30:00.000Z",
      },
    ],
    failure: null,
    relayCredential: "relay-credential-must-not-render",
  },
} as unknown as MaintenanceAccessOverviewResponse;

async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
}

const PassthroughStub = defineComponent({
  props: {
    title: { type: String, default: "" },
    label: { type: String, default: "" },
  },
  setup(props, { slots }) {
    return () =>
      h("section", [
        props.title ? h("h2", props.title) : null,
        props.label ? h("label", props.label) : null,
        slots.default?.(),
      ]);
  },
});

const SelectStub = defineComponent({
  props: {
    value: { type: [String, Number], default: undefined },
    disabled: { type: Boolean, default: false },
  },
  emits: ["update:value"],
  setup(props, { slots, emit }) {
    return () =>
      h(
        "select",
        {
          disabled: props.disabled,
          value: props.value,
          onChange: (event: Event) => {
            emit("update:value", (event.target as HTMLSelectElement).value);
          },
        },
        slots.default?.(),
      );
  },
});

const TextareaStub = defineComponent({
  props: {
    value: { type: String, default: "" },
    disabled: { type: Boolean, default: false },
  },
  emits: ["update:value"],
  setup(props, { emit }) {
    return () =>
      h("textarea", {
        disabled: props.disabled,
        value: props.value,
        onInput: (event: Event) => {
          emit("update:value", (event.target as HTMLTextAreaElement).value);
        },
      });
  },
});

const ButtonStub = defineComponent({
  props: { disabled: { type: Boolean, default: false } },
  emits: ["click"],
  setup(props, { slots, emit }) {
    return () =>
      h(
        "button",
        {
          disabled: props.disabled,
          onClick: () => {
            emit("click");
          },
        },
        slots.default?.(),
      );
  },
});

const TableStub = defineComponent({
  props: {
    columns: {
      type: Array as PropType<Array<{ dataIndex?: string }>>,
      default: () => [],
    },
    dataSource: {
      type: Array as PropType<Record<string, unknown>[]>,
      default: () => [],
    },
  },
  setup(props) {
    return () =>
      h(
        "table",
        props.dataSource.map((row) =>
          h(
            "tr",
            props.columns.map((column) =>
              h("td", String(row[column.dataIndex ?? ""] ?? "")),
            ),
          ),
        ),
      );
  },
});

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
  document.body.append(root);
  const app = createApp(MaintenanceAccessView);
  app.use(pinia);
  for (const name of [
    "a-space",
    "a-card",
    "a-form",
    "a-form-item",
    "a-row",
    "a-col",
    "a-tag",
  ]) {
    app.component(name, PassthroughStub);
  }
  app.component("a-select", SelectStub);
  app.component("a-select-option", PassthroughStub);
  app.component("a-textarea", TextareaStub);
  app.component("a-button", ButtonStub);
  app.component("a-table", TableStub);
  app.mount(root);
  await flushPromises();
  return { app, root };
}

describe("MaintenanceAccessView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.getMaintenanceAccessOverview.mockResolvedValue(overview);
    apiMocks.createMaintenanceSession.mockResolvedValue({});
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders sanitized desired and observed projections for a read-only operator", async () => {
    const { root } = await mountView(["maintenanceAccess.read"]);

    expect(
      root.querySelector("[data-testid='desired-state-projection']")
        ?.textContent,
    ).toContain("12");
    expect(
      root.querySelector("[data-testid='observed-state-projection']")
        ?.textContent,
    ).toContain("12");
    expect(root.textContent).toContain("10.91.1.10");
    expect(root.textContent).toContain("10.91.16.10");
    expect(root.textContent).not.toMatch(/private-key|iptables|credential/i);
    for (const control of root.querySelectorAll("select, textarea, button")) {
      expect((control as HTMLInputElement).disabled).toBe(true);
    }
  });

  it("enables session creation only for an operator with write permission", async () => {
    const { root } = await mountView([
      "maintenanceAccess.read",
      "maintenanceAccess.write",
    ]);
    const textarea = root.querySelector<HTMLTextAreaElement>("textarea")!;
    textarea.value = "Investigate Windows runtime failure";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();

    const button = root.querySelector<HTMLButtonElement>("button")!;
    expect(button.disabled).toBe(false);
    button.click();
    await flushPromises();

    expect(apiMocks.createMaintenanceSession).toHaveBeenCalledWith({
      sourcePeerId: "550e8400-e29b-41d4-a716-446655440001",
      targetMachineId: "550e8400-e29b-41d4-a716-446655440002",
      reason: "Investigate Windows runtime failure",
      ttlMinutes: 30,
    });
  });
});
