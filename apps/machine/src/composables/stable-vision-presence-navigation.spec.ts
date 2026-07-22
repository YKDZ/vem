// @vitest-environment jsdom
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";

import { useVisionStore } from "@/stores/vision";

const { submitMachineNavigationIntentMock } = vi.hoisted(() => ({
  submitMachineNavigationIntentMock: vi.fn(),
}));

vi.mock("@/router/transaction-route-authority", () => ({
  submitMachineNavigationIntent: submitMachineNavigationIntentMock,
}));

import {
  installStableVisionPresenceDepartureNavigation,
  resetStableVisionPresenceSessionForTests,
} from "./stable-vision-presence-session";

function emitPresence(personPresent: boolean, eventId: string): void {
  useVisionStore().applyPresenceStatus({
    source: "top",
    eventId,
    state: personPresent ? "approach" : "empty",
    reason: personPresent ? "person_present_but_not_close" : "no_person",
    detectedAt: "2026-07-22T10:00:00.000Z",
    personPresent,
    closeNow: false,
    close: false,
    closeTrigger: null,
    proximity: { present: personPresent },
    occupancy: {
      state: personPresent ? "single" : "none",
      confidence: 0.91,
    },
  });
}

describe("stable Vision presence navigation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setActivePinia(createPinia());
    resetStableVisionPresenceSessionForTests();
    submitMachineNavigationIntentMock.mockReset();
  });

  afterEach(() => {
    resetStableVisionPresenceSessionForTests();
    vi.useRealTimers();
  });

  it("submits one navigation intent from the stable departure edge", async () => {
    installStableVisionPresenceDepartureNavigation();
    emitPresence(true, "PRESENT-1");
    emitPresence(false, "EMPTY-1");
    await nextTick();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(submitMachineNavigationIntentMock).toHaveBeenCalledTimes(1);
    expect(submitMachineNavigationIntentMock).toHaveBeenCalledWith({
      type: "presence.departed",
      eventId: "presence-2:departure",
    });
  });
});
