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
});
