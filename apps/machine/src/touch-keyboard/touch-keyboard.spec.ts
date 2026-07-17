// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";

import { createTouchKeyboardController } from "./touch-keyboard";

describe("touch keyboard controller", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("opens for ordinary editable inputs and ignores disabled controls", () => {
    const controller = createTouchKeyboardController();
    controller.install(document);
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    expect(controller.state.open).toBe(true);

    const disabled = document.createElement("input");
    disabled.disabled = true;
    document.body.append(disabled);
    disabled.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(controller.state.open).toBe(false);
  });

  it("enters, replaces, and deletes text through native input events", () => {
    const controller = createTouchKeyboardController();
    controller.install(document);
    const input = document.createElement("input");
    const events: Array<{ inputType: string; data: string | null; value: string }> = [];
    input.addEventListener("input", (event) => {
      events.push({ inputType: event.inputType, data: event.data, value: input.value });
    });
    document.body.append(input);
    input.focus();

    controller.enter("a");
    controller.enter("b");
    input.setSelectionRange(0, 1);
    controller.enter("X");
    controller.backspace();

    expect(input.value).toBe("b");
    expect(events).toEqual([
      { inputType: "insertText", data: "a", value: "a" },
      { inputType: "insertText", data: "b", value: "ab" },
      { inputType: "insertText", data: "X", value: "Xb" },
      { inputType: "deleteContentBackward", data: null, value: "b" },
    ]);
  });

  it("uses a numeric layout for number inputs and preserves physical input", () => {
    const controller = createTouchKeyboardController();
    controller.install(document);
    const input = document.createElement("input");
    input.type = "number";
    document.body.append(input);
    input.focus();

    expect(controller.state.layout).toBe("numbers");
    input.value = "42";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    controller.dismiss();
    expect(input.value).toBe("42");
  });

  it("submits through the owning form validation path", () => {
    const controller = createTouchKeyboardController();
    controller.install(document);
    const form = document.createElement("form");
    const input = document.createElement("input");
    input.required = true;
    form.append(input);
    document.body.append(form);
    let submissions = 0;
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      submissions += 1;
    });
    input.focus();

    controller.submit();
    expect(submissions).toBe(0);
    controller.enter("a");
    controller.submit();
    expect(submissions).toBe(1);
    expect(controller.state.open).toBe(false);
  });
});
