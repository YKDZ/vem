// @vitest-environment jsdom
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick } from "vue";

vi.mock("vue-router", () => ({
  useRouter: () => ({ push: vi.fn() }),
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
});
