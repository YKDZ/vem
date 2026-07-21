// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  installMaintenanceSystemTouchKeyboard,
  isSystemTouchKeyboardTarget,
} from "./system-touch-keyboard";

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("maintenance system touch keyboard", () => {
  it("accepts only editable text and numeric fields", () => {
    const text = document.createElement("input");
    const number = document.createElement("input");
    number.type = "number";
    const range = document.createElement("input");
    range.type = "range";
    const disabled = document.createElement("textarea");
    disabled.disabled = true;

    expect(isSystemTouchKeyboardTarget(text)).toBe(true);
    expect(isSystemTouchKeyboardTarget(number)).toBe(true);
    expect(isSystemTouchKeyboardTarget(range)).toBe(false);
    expect(isSystemTouchKeyboardTarget(disabled)).toBe(false);
  });

  it("reports command failures while still dismissing the keyboard on disposal", async () => {
    vi.useFakeTimers();
    const owner = document.createElement("main");
    const input = document.createElement("input");
    const button = document.createElement("button");
    owner.append(input, button);
    document.body.append(owner);
    const invoke = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(new Error("Windows input pane rejected request"))
      .mockResolvedValue(undefined);
    const reportFailure = vi.fn();
    const dispose = installMaintenanceSystemTouchKeyboard(owner, {
      enabled: true,
      invokeCommand: invoke,
      reportFailure,
    });

    input.focus();
    await Promise.resolve();
    expect(invoke).toHaveBeenCalledWith("show_system_touch_keyboard");
    expect(reportFailure).toHaveBeenCalledWith(
      "show_system_touch_keyboard",
      expect.any(Error),
    );
    button.focus();
    await vi.runAllTimersAsync();
    expect(invoke).toHaveBeenCalledWith("hide_system_touch_keyboard");

    dispose();
  });
});
