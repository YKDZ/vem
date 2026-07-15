// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";

import { createProtectedTouchKeyboardController } from "./protected-touch-keyboard";

describe("protected touch keyboard authorization", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("opens only for eligible Bring-Up and authenticated Maintenance inputs", () => {
    let routeName = "boot";
    let maintenanceAuthorized = false;
    const controller = createProtectedTouchKeyboardController(() => ({
      routeName,
      maintenanceAuthorized,
    }));
    const remove = controller.install(document);
    const input = document.createElement("input");
    input.type = "password";
    document.body.append(input);

    input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(controller.state.open).toBe(false);

    routeName = "bring-up";
    input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(controller.state.open).toBe(true);

    routeName = "maintenance";
    controller.reconcileAccess();
    expect(controller.state.open).toBe(false);

    maintenanceAuthorized = true;
    input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(controller.state.open).toBe(true);

    maintenanceAuthorized = false;
    controller.reconcileAccess();
    expect(controller.state.open).toBe(false);
    expect(controller.state.target).toBeNull();

    maintenanceAuthorized = true;
    input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(controller.state.open).toBe(true);

    routeName = "catalog";
    controller.reconcileAccess();
    expect(controller.state.open).toBe(false);

    remove();
  });

  it("enters and deletes text through native input events", () => {
    const controller = createProtectedTouchKeyboardController(() => ({
      routeName: "bring-up",
      maintenanceAuthorized: false,
    }));
    controller.install(document);
    const input = document.createElement("input");
    const inputEvents: string[] = [];
    input.addEventListener("input", () => inputEvents.push(input.value));
    document.body.append(input);
    input.focus();

    controller.enter("a");
    controller.enter("b");
    controller.backspace();

    expect(input.value).toBe("a");
    expect(inputEvents).toEqual(["a", "ab", "a"]);
  });

  it("submits through the owning form's native validation path", () => {
    const controller = createProtectedTouchKeyboardController(() => ({
      routeName: "bring-up",
      maintenanceAuthorized: false,
    }));
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
    expect(controller.state.open).toBe(true);

    controller.enter("a");
    controller.submit();
    expect(submissions).toBe(1);
    expect(controller.state.open).toBe(false);
  });

  it("switches layouts, dismisses without changing form data, and leaves physical input intact", () => {
    const controller = createProtectedTouchKeyboardController(() => ({
      routeName: "bring-up",
      maintenanceAuthorized: false,
    }));
    controller.install(document);
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();

    controller.setLayout("symbols");
    expect(controller.state.layout).toBe("symbols");
    controller.setLayout("letters");
    controller.toggleUppercase();
    controller.enter("a");
    expect(input.value).toBe("A");

    input.value += "b";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    expect(input.value).toBe("Ab");

    controller.dismiss();
    expect(controller.state.open).toBe(false);
    expect(controller.state.target).toBeNull();
    expect(input.value).toBe("Ab");
  });
});
