// @vitest-environment jsdom
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, nextTick } from "vue";

import { useVisionStore } from "@/stores/vision";

const { submitMachineNavigationIntentMock } = vi.hoisted(() => ({
  submitMachineNavigationIntentMock: vi.fn(),
}));

vi.mock("@/router/transaction-route-authority", () => ({
  submitMachineNavigationIntent: submitMachineNavigationIntentMock,
}));

import {
  installPresenceDepartureNavigation,
  resetCustomerPresenceSessionForTests,
  useCustomerPresenceSession,
} from "./usePresenceInteraction";

function emitPresence(personPresent: boolean, detectedAt: string): void {
  useVisionStore().applyPresenceStatus({
    source: "top",
    eventId: `VISION-PRESENCE-${personPresent ? "PRESENT" : "EMPTY"}`,
    state: personPresent ? "approach" : "empty",
    reason: personPresent ? "person_present_but_not_close" : "no_person",
    detectedAt,
    personPresent,
    closeNow: false,
    close: false,
    closeTrigger: null,
    proximity: { present: personPresent },
  });
}

async function mountPresenceDepartureNavigation(): Promise<() => void> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const App = defineComponent({
    setup() {
      useCustomerPresenceSession();
      installPresenceDepartureNavigation();
      return () => null;
    },
  });
  const app = createApp(App);
  app.use(createPinia());
  app.mount(host);
  await nextTick();
  return () => {
    app.unmount();
    host.remove();
  };
}

describe("customer presence navigation", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    resetCustomerPresenceSessionForTests();
    submitMachineNavigationIntentMock.mockReset();
  });

  afterEach(() => {
    resetCustomerPresenceSessionForTests();
    document.body.innerHTML = "";
  });

  it("submits a typed departure intent without writing a route", async () => {
    const unmount = await mountPresenceDepartureNavigation();

    emitPresence(true, "2026-06-30T08:00:00.000Z");
    await nextTick();
    useVisionStore().applyPersonDeparted({
      source: "top",
      eventId: "VISION-DEPARTURE-001",
      detectedAt: "2026-06-30T08:00:05.000Z",
      lastSeenAt: "2026-06-30T08:00:04.000Z",
      reason: "left_frame",
    });
    await nextTick();

    expect(submitMachineNavigationIntentMock).toHaveBeenCalledWith({
      type: "presence.departed",
      eventId: "VISION-DEPARTURE-001",
    });
    unmount();
  });
});
