// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick } from "vue";

const { submitMachineNavigationIntentMock } = vi.hoisted(() => ({
  submitMachineNavigationIntentMock: vi.fn(),
}));

vi.mock("@/router/transaction-route-authority", () => ({
  submitMachineNavigationIntent: submitMachineNavigationIntentMock,
}));

import KioskHeader from "./KioskHeader.vue";

async function mountHeader(props: Record<string, unknown> = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp(KioskHeader, props);
  app.mount(host);
  await nextTick();
  return { app, host };
}

function tapBrand(host: HTMLElement): void {
  host
    .querySelector("[data-test='maintenance-entry-brand']")
    ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

describe("KioskHeader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("opens maintenance by default after the shared hidden tap sequence", async () => {
    const { app, host } = await mountHeader();

    for (let index = 0; index < 7; index += 1) {
      tapBrand(host);
    }

    expect(submitMachineNavigationIntentMock).toHaveBeenCalledWith({
      type: "operator.navigate",
      target: {
        path: "/maintenance",
        query: { source: "operator" },
      },
    });

    app.unmount();
  });

  it("keeps an explicit opt-out for non-customer or future critical surfaces", async () => {
    const { app, host } = await mountHeader({ enableMaintenanceEntry: false });

    for (let index = 0; index < 7; index += 1) {
      tapBrand(host);
    }

    expect(submitMachineNavigationIntentMock).not.toHaveBeenCalled();

    app.unmount();
  });
});
