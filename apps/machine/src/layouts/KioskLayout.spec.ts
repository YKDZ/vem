// @vitest-environment jsdom
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick } from "vue";

const { routerPushMock } = vi.hoisted(() => ({
  routerPushMock: vi.fn(),
}));

vi.mock("vue-router", () => ({
  useRouter: () => ({ push: routerPushMock }),
}));

vi.mock("@/components/HardwareStatusBadge.vue", () => ({
  default: { template: "<div />" },
}));

vi.mock("@/components/NetworkStatusBadge.vue", () => ({
  default: { template: "<div />" },
}));

import KioskLayout from "./KioskLayout.vue";

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
});

describe("KioskLayout", () => {
  it("keeps the content area vertically scrollable for long maintenance pages", async () => {
    const host = document.createElement("div");
    const app = createApp({
      components: { KioskLayout },
      template: "<KioskLayout>maintenance content</KioskLayout>",
    });
    app.use(createPinia());
    app.mount(host);
    await nextTick();

    const content = host.querySelector("section");
    expect(content?.className).toContain("kiosk-scroll");
    expect(content?.className).toContain("overflow-y-auto");

    app.unmount();
  });

  it("opens maintenance after the hidden header tap sequence", async () => {
    const host = document.createElement("div");
    const app = createApp({
      components: { KioskLayout },
      template: "<KioskLayout>result content</KioskLayout>",
    });
    app.use(createPinia());
    app.mount(host);
    await nextTick();

    const hiddenMaintenanceTarget = host.querySelector("header > div");
    expect(hiddenMaintenanceTarget).not.toBeNull();

    for (let index = 0; index < 7; index += 1) {
      hiddenMaintenanceTarget?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    }

    expect(routerPushMock).toHaveBeenCalledWith({
      path: "/maintenance",
      query: { source: "operator" },
    });

    app.unmount();
  });
});
