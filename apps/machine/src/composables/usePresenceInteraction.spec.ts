// @vitest-environment jsdom
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, nextTick, type Ref } from "vue";

import { useVisionStore } from "@/stores/vision";

import type { PresenceInteractionState } from "./usePresenceInteraction";

import {
  resetCustomerPresenceSessionForTests,
  usePresenceInteraction,
} from "./usePresenceInteraction";

let pinia: ReturnType<typeof createPinia>;

function emitPresenceStatus(input: {
  eventId: string;
  personPresent: boolean;
  detectedAt: string;
  occupancyState?: "single" | "multiple" | "unknown" | "none";
}): void {
  useVisionStore().applyPresenceStatus({
    eventId: input.eventId,
    state: input.personPresent ? "approach" : "empty",
    reason: input.personPresent ? "person_present_but_not_close" : "no_person",
    detectedAt: input.detectedAt,
    personPresent: input.personPresent,
    closeNow: false,
    close: false,
    closeTrigger: null,
    proximity: {
      present: input.personPresent,
      closeNow: false,
      close: false,
    },
    occupancy: {
      state: input.occupancyState ?? (input.personPresent ? "single" : "none"),
      confidence: 0.9,
    },
  });
}

async function mountPresence(
  options?: Parameters<typeof usePresenceInteraction>[0],
) {
  const captured: {
    state?: Readonly<Ref<PresenceInteractionState>>;
    presenceClass?: Readonly<Ref<string>>;
    unmount?: () => void;
  } = {};
  const host = document.createElement("div");
  document.body.appendChild(host);
  const App = defineComponent({
    setup() {
      const presence = usePresenceInteraction(options);
      captured.state = presence.state;
      captured.presenceClass = presence.presenceClass;
      return () => null;
    },
  });
  const app = createApp(App);
  app.use(pinia);
  app.mount(host);
  captured.unmount = () => {
    app.unmount();
    host.remove();
  };
  await nextTick();
  return captured;
}

describe("usePresenceInteraction", () => {
  beforeEach(() => {
    resetCustomerPresenceSessionForTests();
    pinia = createPinia();
    setActivePinia(pinia);
  });

  afterEach(() => {
    resetCustomerPresenceSessionForTests();
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("derives person presence from the latest vision profile", async () => {
    const presence = await mountPresence();

    useVisionStore().applyLatestProfileResult({
      eventId: "VISION-PRESENCE-001",
      detectedAt: "2026-06-27T10:00:00.000Z",
      profile: {
        personPresent: true,
        heightCm: 172,
        bodyType: "regular",
        confidence: 0.91,
      },
      quality: { overall: "good", warnings: [] },
    });
    await nextTick();

    expect(presence.state?.value).toMatchObject({
      personPresent: true,
      lastSeenAt: "2026-06-27T10:00:00.000Z",
      source: "vision",
    });
    expect(presence.presenceClass?.value).toBe("presence-present");
  });

  it("applies explicit vision presence and departure facts", async () => {
    const presence = await mountPresence();

    emitPresenceStatus({
      eventId: "VISION-PRESENCE-EVENT-001",
      detectedAt: "2026-06-29T10:00:00.000Z",
      personPresent: true,
    });
    await nextTick();
    useVisionStore().applyPersonDeparted({
      eventId: "VISION-DEPARTURE-EVENT-001",
      detectedAt: "2026-06-29T10:00:08.000Z",
      lastSeenAt: "2026-06-29T10:00:06.000Z",
      reason: "left_frame",
      absenceDurationMs: 1200,
    });
    await nextTick();

    expect(presence.state?.value).toEqual({
      personPresent: false,
      lastSeenAt: "2026-06-29T10:00:06.000Z",
      departedAt: "2026-06-29T10:00:08.000Z",
      lastInteractionAt: null,
      source: "vision",
    });
    expect(presence.presenceClass?.value).toBe("presence-idle");
  });

  it("clears stale presence when vision becomes unavailable", async () => {
    const presence = await mountPresence();

    emitPresenceStatus({
      eventId: "VISION-PRESENCE-AVAILABLE",
      detectedAt: "2026-06-27T10:00:00.000Z",
      personPresent: true,
    });
    await nextTick();
    useVisionStore().applyStatus({
      enabled: true,
      online: false,
      message: "vision camera unavailable",
      updatedAt: "2026-06-27T10:00:01.000Z",
      latestDiagnosticPayload: null,
    });
    await nextTick();

    expect(presence.state?.value).toMatchObject({
      personPresent: false,
      lastSeenAt: "2026-06-27T10:00:00.000Z",
      source: "unavailable",
    });
  });

  it("expires locally cached vision presence without inventing a journey event", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-29T10:00:00.000Z"));
    const presence = await mountPresence({ presenceStaleMs: 1000 });

    emitPresenceStatus({
      eventId: "VISION-PRESENCE-EVENT-STALE",
      detectedAt: "2026-06-29T10:00:00.000Z",
      personPresent: true,
    });
    await nextTick();
    vi.advanceTimersByTime(1000);
    await nextTick();

    expect(presence.state?.value).toEqual({
      personPresent: false,
      lastSeenAt: "2026-06-29T10:00:00.000Z",
      departedAt: "2026-06-29T10:00:01.000Z",
      lastInteractionAt: null,
      source: "unavailable",
    });
  });

  it("uses local touchscreen interaction as a session fact before vision arrives", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-29T11:00:00.000Z"));
    const presence = await mountPresence();

    window.dispatchEvent(new Event("pointerdown"));
    await nextTick();

    expect(presence.state?.value).toEqual({
      personPresent: true,
      lastSeenAt: "2026-06-29T11:00:00.000Z",
      departedAt: null,
      lastInteractionAt: "2026-06-29T11:00:00.000Z",
      source: "local_interaction",
    });
  });

  it("marks a locally active session departed after bounded inactivity", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-29T11:10:00.000Z"));
    const presence = await mountPresence({ inactivityDepartureMs: 3000 });

    window.dispatchEvent(new Event("pointerdown"));
    await nextTick();
    vi.advanceTimersByTime(3000);
    await nextTick();

    expect(presence.state?.value).toEqual({
      personPresent: false,
      lastSeenAt: "2026-06-29T11:10:00.000Z",
      departedAt: "2026-06-29T11:10:03.000Z",
      lastInteractionAt: "2026-06-29T11:10:00.000Z",
      source: "inactivity",
    });
  });
});
