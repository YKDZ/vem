// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { createApp, h, nextTick } from "vue";

import TouchKeyboard from "./TouchKeyboard.vue";

describe("TouchKeyboard", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("opens for ordinary text inputs and enters text through touch keys", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const app = createApp({ render: () => h(TouchKeyboard) });
    app.mount(host);
    const input = document.createElement("input");
    document.body.prepend(input);

    input.focus();
    await nextTick();
    const keyboard = document.querySelector<HTMLElement>(
      '[data-test="touch-keyboard"]',
    );
    expect(keyboard?.hidden).toBe(false);

    document
      .querySelector<HTMLButtonElement>('[data-key="q"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(input.value).toBe("q");

    document
      .querySelector<HTMLButtonElement>('[data-test="touch-keyboard-dismiss"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();
    expect(keyboard?.hidden).toBe(true);
    app.unmount();
  });

  it("uses the numeric layout for Wi-Fi and other numeric inputs", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const app = createApp({ render: () => h(TouchKeyboard) });
    app.mount(host);
    const input = document.createElement("input");
    input.type = "number";
    document.body.prepend(input);

    input.focus();
    await nextTick();
    expect(document.querySelector('[data-key="1"]')).not.toBeNull();
    expect(document.querySelector('[data-key="q"]')).toBeNull();
    app.unmount();
  });
});
