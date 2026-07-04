// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { installKioskBrowserGuards } from "./kiosk-browser-guards";

describe("installKioskBrowserGuards", () => {
  it("prevents the browser context menu in kiosk mode", () => {
    installKioskBrowserGuards();

    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });

    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  it("prevents image and element dragging in kiosk mode", () => {
    installKioskBrowserGuards();

    const event = new Event("dragstart", {
      bubbles: true,
      cancelable: true,
    });

    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });
});
