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
      quality: {
        overall: "good",
        warnings: [],
      },
    });
    await nextTick();

    expect(presence.state?.value).toMatchObject({
      personPresent: true,
      lastSeenAt: "2026-06-27T10:00:00.000Z",
      source: "vision",
    });
    expect(presence.presenceClass?.value).toBe("presence-present");
  });

  it("derives person presence from explicit vision presence events", async () => {
    const presence = await mountPresence();

    useVisionStore().applyPresenceStatus({
      eventId: "VISION-PRESENCE-EVENT-001",
      state: "approach",
      reason: "person_present_but_not_close",
      detectedAt: "2026-06-29T10:00:00.000Z",
      personPresent: true,
      closeNow: false,
      close: false,
      closeTrigger: null,
      proximity: { present: true, closeNow: false, close: false },
    });
    await nextTick();

    expect(presence.state?.value).toEqual({
      personPresent: true,
      lastSeenAt: "2026-06-29T10:00:00.000Z",
      departedAt: null,
      lastInteractionAt: null,
      source: "vision",
    });
    expect(presence.presenceClass?.value).toBe("presence-present");
    useVisionStore().applyPresenceStatus({
      eventId: "VISION-PRESENCE-EVENT-002",
      state: "empty",
      reason: "no_person",
      detectedAt: "2026-06-29T10:00:05.000Z",
      personPresent: false,
      closeNow: false,
      close: false,
      closeTrigger: null,
      proximity: { present: false, closeNow: false, close: false },
    });
    await nextTick();

    expect(presence.state?.value).toEqual({
      personPresent: false,
      lastSeenAt: "2026-06-29T10:00:00.000Z",
      departedAt: "2026-06-29T10:00:05.000Z",
      lastInteractionAt: null,
      source: "vision",
    });
    expect(presence.presenceClass?.value).toBe("presence-idle");
  });

  it("clears stale presence state when the latest vision diagnostic is unavailable", async () => {
    const presence = await mountPresence();

    useVisionStore().applyLatestProfileResult({
      eventId: "VISION-PRESENCE-001",
      detectedAt: "2026-06-27T10:00:00.000Z",
      profile: { personPresent: true, confidence: 0.91 },
      quality: { overall: "good", warnings: [] },
    });
    await nextTick();
    expect(presence.state?.value).toMatchObject({
      personPresent: true,
      lastSeenAt: "2026-06-27T10:00:00.000Z",
      source: "vision",
    });

    useVisionStore().applyStatus({
      enabled: true,
      online: false,
      message: "vision camera unavailable",
      updatedAt: "2026-06-27T10:00:01.000Z",
      latestDiagnosticPayload: null,
    });
    await nextTick();

    expect(presence.state?.value).toEqual({
      personPresent: false,
      lastSeenAt: "2026-06-27T10:00:00.000Z",
      departedAt: null,
      lastInteractionAt: null,
      source: "unavailable",
    });
    expect(presence.presenceClass?.value).toBe("presence-idle");
  });

  it("expires locally cached present state when vision diagnostics stop arriving", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-29T10:00:00.000Z"));
    const presence = await mountPresence({
      presenceStaleMs: 1000,
    });

    useVisionStore().applyPresenceStatus({
      eventId: "VISION-PRESENCE-EVENT-001",
      state: "approach",
      reason: "person_present_but_not_close",
      detectedAt: "2026-06-29T10:00:00.000Z",
      personPresent: true,
      closeNow: false,
      close: false,
      closeTrigger: null,
      proximity: { present: true, closeNow: false, close: false },
    });
    await nextTick();
    expect(presence.state?.value.personPresent).toBe(true);

    vi.advanceTimersByTime(1000);
    await nextTick();

    expect(presence.state?.value).toEqual({
      personPresent: false,
      lastSeenAt: "2026-06-29T10:00:00.000Z",
      departedAt: "2026-06-29T10:00:01.000Z",
      lastInteractionAt: null,
      source: "unavailable",
    });
    expect(presence.presenceClass?.value).toBe("presence-idle");
  });

  it("treats the first local touch as a presence signal before vision arrives", async () => {
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

  it("applies explicit vision person departed events", async () => {
    const presence = await mountPresence();

    emitPresenceStatus({
      eventId: "VISION-PRESENCE-EVENT-PRESENT",
      detectedAt: "2026-06-29T11:05:00.000Z",
      personPresent: true,
    });
    await nextTick();
    useVisionStore().applyPersonDeparted({
      eventId: "VISION-DEPARTURE-EVENT-001",
      detectedAt: "2026-06-29T11:05:08.000Z",
      lastSeenAt: "2026-06-29T11:05:06.000Z",
      reason: "left_frame",
      absenceDurationMs: 1200,
    });
    await nextTick();

    expect(presence.state?.value).toEqual({
      personPresent: false,
      lastSeenAt: "2026-06-29T11:05:06.000Z",
      departedAt: "2026-06-29T11:05:08.000Z",
      lastInteractionAt: null,
      source: "vision",
    });
  });

  it("falls back to departed after a present customer stops interacting", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-29T11:10:00.000Z"));
    const presence = await mountPresence({
      inactivityDepartureMs: 3000,
    });

    window.dispatchEvent(new Event("pointerdown"));
    await nextTick();
    expect(presence.state?.value.personPresent).toBe(true);

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
