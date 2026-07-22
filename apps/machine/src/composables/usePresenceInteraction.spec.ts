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
    source: "top",
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
      source: "front",
      eventId: "VISION-PRESENCE-001",
      detectedAt: "2026-06-27T10:00:00.000Z",
      profile: {
        personPresent: true,
        heightCm: 172,
        bodyType: "regular",
        confidence: 0.91,
      },
      quality: { overall: "good", warnings: [], profileUsable: true },
    });
    await nextTick();

    expect(presence.state?.value).toMatchObject({
      personPresent: true,
      lastSeenAt: "2026-06-27T10:00:00.000Z",
      source: "vision",
    });
    expect(presence.presenceClass?.value).toBe("presence-present");
  });

  it("applies explicit vision departure after the departure hysteresis", async () => {
    vi.useFakeTimers();
    const presence = await mountPresence();

    emitPresenceStatus({
      eventId: "VISION-PRESENCE-EVENT-001",
      detectedAt: "2026-06-29T10:00:00.000Z",
      personPresent: true,
    });
    await nextTick();
    useVisionStore().applyPersonDeparted({
      source: "top",
      eventId: "VISION-DEPARTURE-EVENT-001",
      detectedAt: "2026-06-29T10:00:08.000Z",
      lastSeenAt: "2026-06-29T10:00:06.000Z",
      reason: "left_frame",
      absenceDurationMs: 1200,
    });
    await nextTick();

    expect(presence.state?.value.personPresent).toBe(true);
    await vi.advanceTimersByTimeAsync(3_000);

    expect(presence.state?.value).toEqual({
      eventId: "VISION-DEPARTURE-EVENT-001",
      personPresent: false,
      occupancyState: "none",
      lastSeenAt: "2026-06-29T10:00:06.000Z",
      departedAt: "2026-06-29T10:00:08.000Z",
      lastInteractionAt: null,
      source: "vision",
    });
    expect(presence.presenceClass?.value).toBe("presence-idle");
  });

  it("cancels an explicit vision departure when presence immediately recovers", async () => {
    vi.useFakeTimers();
    const presence = await mountPresence();

    emitPresenceStatus({
      eventId: "VISION-PRESENCE-BEFORE-FLICKER",
      detectedAt: "2026-07-22T14:06:17.963Z",
      personPresent: true,
    });
    useVisionStore().applyPersonDeparted({
      source: "top",
      eventId: "VISION-DEPARTURE-FLICKER",
      detectedAt: "2026-07-22T14:06:18.563Z",
      lastSeenAt: "2026-07-22T14:06:17.963Z",
      reason: "no_person",
    });
    await vi.advanceTimersByTimeAsync(550);
    emitPresenceStatus({
      eventId: "VISION-PRESENCE-RECOVERED",
      detectedAt: "2026-07-22T14:06:19.117Z",
      personPresent: true,
    });
    await vi.advanceTimersByTimeAsync(3_000);

    expect(presence.state?.value).toMatchObject({
      eventId: "VISION-PRESENCE-RECOVERED",
      personPresent: true,
      source: "vision",
    });
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
      eventId: "VISION-PRESENCE-EVENT-STALE",
      personPresent: false,
      occupancyState: "none",
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
      eventId: null,
      personPresent: true,
      occupancyState: "unknown",
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
      eventId: null,
      personPresent: false,
      occupancyState: "none",
      lastSeenAt: "2026-06-29T11:10:00.000Z",
      departedAt: "2026-06-29T11:10:03.000Z",
      lastInteractionAt: "2026-06-29T11:10:00.000Z",
      source: "inactivity",
    });
  });
});
