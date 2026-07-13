// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

import { callTauriCommand } from "./tauri";
import {
  hideTouchKeyboard,
  installTouchKeyboardPolicy,
  showTouchKeyboard,
} from "./touch-keyboard";

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {},
  });
});

describe("touch keyboard policy", () => {
  it("shows only for editable focus on an allowed route and hides on customer routes", async () => {
    invokeMock.mockResolvedValue(true);
    let routeAllowed = true;
    let afterEach: (() => void) | undefined;
    const remove = installTouchKeyboardPolicy({
      isAllowed: () => routeAllowed,
      afterEach: (handler) => {
        afterEach = handler;
        return () => undefined;
      },
    });
    const input = document.createElement("input");
    document.body.append(input);

    input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    await Promise.resolve();
    expect(invokeMock).toHaveBeenCalledWith("show_touch_keyboard", undefined);

    routeAllowed = false;
    afterEach?.();
    await Promise.resolve();
    expect(invokeMock).toHaveBeenCalledWith("hide_touch_keyboard", undefined);

    invokeMock.mockClear();
    input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    await Promise.resolve();
    expect(invokeMock).not.toHaveBeenCalledWith(
      "show_touch_keyboard",
      undefined,
    );

    remove();
    input.remove();
  });

  it("exposes explicit native show and hide commands", async () => {
    invokeMock.mockResolvedValue(true);
    await expect(showTouchKeyboard()).resolves.toBe(true);
    await expect(hideTouchKeyboard()).resolves.toBe(true);
  });
});

describe("Tauri command wrapper", () => {
  it("maps invoke failures to command-scoped errors", async () => {
    invokeMock.mockRejectedValue(new Error("native output unavailable"));

    await expect(callTauriCommand("play_machine_audio")).rejects.toThrow(
      "play_machine_audio failed: native output unavailable",
    );
  });
});
