// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getCustomerInteractionSession,
  resetCustomerInteractionSessionForTests,
} from "./customer-interaction-session";

describe("customer interaction session", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetCustomerInteractionSessionForTests();
  });

  afterEach(() => {
    resetCustomerInteractionSessionForTests();
    vi.useRealTimers();
  });

  it("tracks touchscreen activity independently from Vision and expires after inactivity", async () => {
    const session = getCustomerInteractionSession();

    window.dispatchEvent(new Event("pointerdown"));
    expect(session.state.value.active).toBe(true);
    expect(session.state.value.lastInteractionAt).not.toBeNull();

    await vi.advanceTimersByTimeAsync(45_000);
    expect(session.state.value.active).toBe(false);
  });

  it("ignores operator maintenance input as a customer presence signal", async () => {
    const session = getCustomerInteractionSession();
    const operatorRoot = document.createElement("main");
    operatorRoot.dataset.customerInteractionScope = "operator";
    const input = document.createElement("input");
    operatorRoot.append(input);
    document.body.append(operatorRoot);

    input.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true }));

    expect(session.state.value.active).toBe(false);

    document.body.removeChild(operatorRoot);
  });

  it("keeps customer surface input eligible for presence cues", () => {
    const session = getCustomerInteractionSession();
    const customerButton = document.createElement("button");
    document.body.append(customerButton);

    customerButton.dispatchEvent(new Event("pointerdown", { bubbles: true }));

    expect(session.state.value.active).toBe(true);

    document.body.removeChild(customerButton);
  });
});
