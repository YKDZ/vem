// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { createApp, h, nextTick, ref } from "vue";

import ProtectedTouchKeyboard from "./ProtectedTouchKeyboard.vue";

describe("ProtectedTouchKeyboard", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("renders an app-owned keyboard and enters text through touch keys", async () => {
    const routeName = ref("bring-up");
    const host = document.createElement("div");
    document.body.append(host);
    const app = createApp({
      render: () =>
        h(ProtectedTouchKeyboard, {
          routeName: routeName.value,
          maintenanceSession: null,
        }),
    });
    app.mount(host);
    const input = document.createElement("input");
    document.body.prepend(input);

    input.focus();
    await nextTick();
    const keyboard = document.querySelector<HTMLElement>(
      '[data-test="protected-touch-keyboard"]',
    );
    expect(keyboard?.hidden).toBe(false);

    document
      .querySelector<HTMLButtonElement>('[data-key="q"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(input.value).toBe("q");

    routeName.value = "payment";
    await nextTick();
    expect(keyboard?.hidden).toBe(true);

    app.unmount();
  });
});
