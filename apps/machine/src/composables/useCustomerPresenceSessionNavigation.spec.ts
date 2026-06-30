// @vitest-environment jsdom
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, nextTick } from "vue";

import { useVisionStore } from "@/stores/vision";

const { routeName, routerReplaceMock } = vi.hoisted(() => ({
  routeName: { value: "product-detail" },
  routerReplaceMock: vi.fn(),
}));

vi.mock("vue-router", () => ({
  useRoute: () => ({ name: routeName.value }),
  useRouter: () => ({ replace: routerReplaceMock }),
}));

import {
  resetCustomerPresenceSessionForTests,
  useCustomerPresenceSession,
  useReturnHomeOnCustomerDeparture,
} from "./usePresenceInteraction";

function emitPresence(personPresent: boolean, detectedAt: string): void {
  useVisionStore().applyPresenceStatus({
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

async function mountReturnHomeController(): Promise<() => void> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const App = defineComponent({
    setup() {
      useCustomerPresenceSession();
      useReturnHomeOnCustomerDeparture();
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
    routerReplaceMock.mockReset();
    routeName.value = "product-detail";
  });

  afterEach(() => {
    resetCustomerPresenceSessionForTests();
    document.body.innerHTML = "";
  });

  it("returns browsing pages to catalog when the customer leaves", async () => {
    const unmount = await mountReturnHomeController();

    emitPresence(true, "2026-06-30T08:00:00.000Z");
    await nextTick();
    useVisionStore().applyPersonDeparted({
      eventId: "VISION-DEPARTURE-001",
      detectedAt: "2026-06-30T08:00:05.000Z",
      lastSeenAt: "2026-06-30T08:00:04.000Z",
      reason: "left_frame",
    });
    await nextTick();

    expect(routerReplaceMock).toHaveBeenCalledWith({ name: "catalog" });
    unmount();
  });

  it("does not interrupt payment when the customer leaves", async () => {
    routeName.value = "payment";
    const unmount = await mountReturnHomeController();

    emitPresence(true, "2026-06-30T08:10:00.000Z");
    await nextTick();
    emitPresence(false, "2026-06-30T08:10:05.000Z");
    await nextTick();

    expect(routerReplaceMock).not.toHaveBeenCalled();
    unmount();
  });
});
