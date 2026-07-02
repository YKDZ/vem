// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

import {
  emitCustomerExperienceEvent,
  onCustomerExperienceEvent,
} from "./useCustomerExperienceEvents";

describe("customer experience event bus", () => {
  it("lets feature code subscribe to semantic customer events", () => {
    const listener = vi.fn();
    const unsubscribe = onCustomerExperienceEvent(listener);

    emitCustomerExperienceEvent({
      type: "interaction.awakened",
      requestedAt: "2026-07-02T13:00:00.000Z",
    });
    unsubscribe();
    emitCustomerExperienceEvent({
      type: "idle.sleep",
      requestedAt: "2026-07-02T13:00:30.000Z",
    });

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({
      type: "interaction.awakened",
      requestedAt: "2026-07-02T13:00:00.000Z",
    });
  });
});
