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
    vi.useFakeTimers();
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
    vi.useRealTimers();
  });

  it("keeps an active presence session through a transient Vision absence", async () => {
    vi.useFakeTimers();
    const unmount = await mountPresenceDepartureNavigation();

    emitPresence(true, "2026-06-30T08:00:00.000Z");
    await nextTick();
    useVisionStore().applyPresenceStatus({
      source: "top",
      eventId: "VISION-PRESENCE-TRANSIENT-EMPTY",
      state: "empty",
      reason: "no_person",
      detectedAt: "2026-06-30T08:00:01.000Z",
      personPresent: false,
      closeNow: false,
      close: false,
      closeTrigger: null,
      proximity: { present: false },
    });
    await nextTick();

    await vi.advanceTimersByTimeAsync(2_999);
    emitPresence(true, "2026-06-30T08:00:04.000Z");
    await nextTick();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(submitMachineNavigationIntentMock).not.toHaveBeenCalled();
    unmount();
    vi.useRealTimers();
  });

  it("confirms departure from the first sustained Vision absence", async () => {
    vi.useFakeTimers();
    const unmount = await mountPresenceDepartureNavigation();

    emitPresence(true, "2026-06-30T08:00:00.000Z");
    await nextTick();
    emitPresence(false, "2026-06-30T08:00:01.000Z");
    await nextTick();
    await vi.advanceTimersByTimeAsync(1_000);
    emitPresence(false, "2026-06-30T08:00:02.000Z");
    await nextTick();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(submitMachineNavigationIntentMock).toHaveBeenCalledWith({
      type: "presence.departed",
      eventId: "VISION-PRESENCE-EMPTY",
    });
    unmount();
    vi.useRealTimers();
  });

  it("does not turn local inactivity into a Vision departure", async () => {
    vi.useFakeTimers();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const App = defineComponent({
      setup() {
        useCustomerPresenceSession({
          inactivityDepartureMs: 10,
          presenceStaleMs: 60_000,
        });
        installPresenceDepartureNavigation();
        return () => null;
      },
    });
    const app = createApp(App);
    app.use(createPinia());
    app.mount(host);

    window.dispatchEvent(new Event("pointerdown"));
    await vi.advanceTimersByTimeAsync(10);
    expect(submitMachineNavigationIntentMock).not.toHaveBeenCalled();

    app.unmount();
    vi.useRealTimers();
  });
});
