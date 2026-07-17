// @vitest-environment jsdom
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, nextTick, type Ref } from "vue";

import type { CustomerExperienceEvent } from "@/customer-events/events";
import type { VisionStatus } from "@/daemon/schemas";

import { daemonClient } from "@/daemon/client";
import { useNaturalContextStore } from "@/stores/natural-context";
import { useVisionStore } from "@/stores/vision";

import type { PresenceInteractionState } from "./usePresenceInteraction";

import { onCustomerEvent } from "./useCustomerEvents";
import {
  installCustomerEventSources,
  resetCustomerEventSourcesForTests,
} from "./useCustomerEventSources";
import {
  resetCustomerPresenceSessionForTests,
  usePresenceInteraction,
} from "./usePresenceInteraction";

vi.mock("@/daemon/client", () => ({
  daemonClient: {
    getVisionStatus: vi.fn(),
  },
}));

let pinia: ReturnType<typeof createPinia>;
const mockedDaemonClient = vi.mocked(daemonClient);

function visionStatus(latestDiagnosticPayload: unknown): VisionStatus {
  return {
    enabled: true,
    online: true,
    message: "vision ready",
    updatedAt: "2026-06-29T12:06:01.000Z",
    latestDiagnosticPayload,
  };
}

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

function observeCustomerExperienceEvents(): {
  observed: CustomerExperienceEvent[];
  cleanup: () => void;
} {
  const observed: CustomerExperienceEvent[] = [];
  const unsubscribe = onCustomerEvent((event) => {
    observed.push(event);
  });
  const cleanupSource = installCustomerEventSources();
  return {
    observed,
    cleanup: () => {
      cleanupSource();
      unsubscribe();
    },
  };
}

function applyNaturalContext(input: {
  checkedAt: string;
  sunriseAt: string;
  sunsetAt: string;
}): void {
  useNaturalContextStore().applySnapshot({
    status: "ready",
    machineCode: "MACHINE-PRESENCE",
    checkedAt: input.checkedAt,
    degraded: false,
    customerFacingBlocked: false,
    externalEnvironment: {
      status: "ready",
      machineCode: "MACHINE-PRESENCE",
      checkedAt: input.checkedAt,
      localTime: {
        status: "ready",
        timezone: "Asia/Shanghai",
        localDate: input.checkedAt.slice(0, 10),
        localClock: "12:00:00",
      },
      weather: {
        status: "ready",
        temperatureCelsius: 28,
        conditionText: "晴",
        conditionCode: "100",
        observedAt: input.checkedAt,
        weatherConditionClasses: ["other"],
        primaryWeatherConditionClass: "other",
      },
      sun: {
        status: "ready",
        sunriseAt: input.sunriseAt,
        sunsetAt: input.sunsetAt,
      },
      calendar: {
        status: "ready",
        localDate: input.checkedAt.slice(0, 10),
        festivals: [],
        primaryFestival: null,
        solarTerm: null,
      },
    },
    localSiteSignals: {
      status: "unknown",
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
    mockedDaemonClient.getVisionStatus.mockReset();
    pinia = createPinia();
    setActivePinia(pinia);
  });

  afterEach(() => {
    resetCustomerPresenceSessionForTests();
    resetCustomerEventSourcesForTests();
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

  it("emits a customer event for vision-confirmed single-person presence", async () => {
    const events = observeCustomerExperienceEvents();
    await mountPresence();

    emitPresenceStatus({
      eventId: "VISION-PRESENCE-EVENT-SINGLE",
      detectedAt: "2026-06-29T12:00:00.000Z",
      personPresent: true,
      occupancyState: "single",
    });
    await nextTick();

    events.cleanup();
    expect(events.observed).toEqual([
      {
        type: "presence.detected",
        requestedAt: "2026-06-29T12:00:00.000Z",
      },
    ]);
  });

  it("does not treat legacy unknown occupancy as confirmed single-person presence", async () => {
    const events = observeCustomerExperienceEvents();
    await mountPresence();

    useVisionStore().applyPresenceStatus({
      eventId: "VISION-PRESENCE-EVENT-LEGACY",
      state: "approach",
      reason: "person_present_but_not_close",
      detectedAt: "2026-06-29T12:01:00.000Z",
      personPresent: true,
      closeNow: false,
      close: false,
      closeTrigger: null,
      proximity: { present: true, closeNow: false, close: false },
    });
    await nextTick();
    emitPresenceStatus({
      eventId: "VISION-PRESENCE-EVENT-LATER-SINGLE",
      detectedAt: "2026-06-29T12:01:03.000Z",
      personPresent: true,
      occupancyState: "single",
    });
    await nextTick();

    events.cleanup();
    expect(events.observed).toEqual([
      {
        type: "presence.detected",
        requestedAt: "2026-06-29T12:01:03.000Z",
      },
    ]);
  });

  it("emits a daytime welcome instead of generic detected when natural context reliably indicates day", async () => {
    applyNaturalContext({
      checkedAt: "2026-06-29T04:00:00.000Z",
      sunriseAt: "2026-06-28T21:53:00.000Z",
      sunsetAt: "2026-06-29T10:02:00.000Z",
    });
    const events = observeCustomerExperienceEvents();
    await mountPresence();

    emitPresenceStatus({
      eventId: "VISION-PRESENCE-EVENT-DAY",
      detectedAt: "2026-06-29T04:01:00.000Z",
      personPresent: true,
      occupancyState: "single",
    });
    await nextTick();

    events.cleanup();
    expect(events.observed).toEqual([
      {
        type: "presence.welcome.day",
        requestedAt: "2026-06-29T04:01:00.000Z",
      },
    ]);
  });

  it("emits a nighttime welcome instead of generic detected when natural context reliably indicates night", async () => {
    applyNaturalContext({
      checkedAt: "2026-06-29T14:00:00.000Z",
      sunriseAt: "2026-06-28T21:53:00.000Z",
      sunsetAt: "2026-06-29T10:02:00.000Z",
    });
    const events = observeCustomerExperienceEvents();
    await mountPresence();

    emitPresenceStatus({
      eventId: "VISION-PRESENCE-EVENT-NIGHT",
      detectedAt: "2026-06-29T14:01:00.000Z",
      personPresent: true,
      occupancyState: "single",
    });
    await nextTick();

    events.cleanup();
    expect(events.observed).toEqual([
      {
        type: "presence.welcome.night",
        requestedAt: "2026-06-29T14:01:00.000Z",
      },
    ]);
  });

  it("does not emit a customer event from restored initial vision presence", async () => {
    emitPresenceStatus({
      eventId: "VISION-PRESENCE-EVENT-RESTORED",
      detectedAt: "2026-06-29T12:05:00.000Z",
      personPresent: true,
      occupancyState: "single",
    });
    const events = observeCustomerExperienceEvents();

    await mountPresence();
    await nextTick();

    events.cleanup();
    expect(events.observed).toEqual([]);
  });

  it("does not emit when app boot starts presence before the vision refresh restores presence", async () => {
    mockedDaemonClient.getVisionStatus.mockResolvedValue(
      visionStatus({
        type: "vision.presence_status",
        payload: {
          eventId: "VISION-PRESENCE-EVENT-BOOT-RESTORED",
          state: "approach",
          reason: "person_present_but_not_close",
          detectedAt: "2026-06-29T12:06:00.000Z",
          personPresent: true,
          closeNow: false,
          close: false,
          closeTrigger: null,
          proximity: { present: true, closeNow: false, close: false },
          occupancy: { state: "single", confidence: 0.9 },
        },
      }),
    );
    const events = observeCustomerExperienceEvents();
    await mountPresence();

    await useVisionStore().refresh();
    await nextTick();

    events.cleanup();
    expect(events.observed).toEqual([]);
  });

  it("does not emit sleep from restored empty vision diagnostics", async () => {
    mockedDaemonClient.getVisionStatus.mockResolvedValue(
      visionStatus({
        type: "vision.presence_status",
        payload: {
          eventId: "VISION-PRESENCE-EVENT-BOOT-EMPTY",
          state: "empty",
          reason: "no_person",
          detectedAt: "2026-06-29T12:06:10.000Z",
          personPresent: false,
          closeNow: false,
          close: false,
          closeTrigger: null,
          proximity: { present: false, closeNow: false, close: false },
          occupancy: { state: "none", confidence: 0.9 },
        },
      }),
    );
    const events = observeCustomerExperienceEvents();
    await mountPresence();

    await useVisionStore().refresh();
    await nextTick();

    events.cleanup();
    expect(events.observed).toEqual([]);
  });

  it("does not emit sleep from restored departed vision diagnostics", async () => {
    mockedDaemonClient.getVisionStatus.mockResolvedValue(
      visionStatus({
        type: "vision.person_departed",
        payload: {
          eventId: "VISION-DEPARTURE-EVENT-BOOT-RESTORED",
          detectedAt: "2026-06-29T12:06:20.000Z",
          lastSeenAt: "2026-06-29T12:06:18.000Z",
          reason: "left_frame",
          absenceDurationMs: 1200,
        },
      }),
    );
    const events = observeCustomerExperienceEvents();
    await mountPresence();

    await useVisionStore().refresh();
    await nextTick();

    events.cleanup();
    expect(events.observed).toEqual([]);
  });

  it("does not emit sleep for repeated empty vision diagnostics when no customer was present", async () => {
    const events = observeCustomerExperienceEvents();
    await mountPresence();

    emitPresenceStatus({
      eventId: "VISION-PRESENCE-EVENT-EMPTY-1",
      detectedAt: "2026-06-29T12:06:30.000Z",
      personPresent: false,
      occupancyState: "none",
    });
    await nextTick();
    emitPresenceStatus({
      eventId: "VISION-PRESENCE-EVENT-EMPTY-2",
      detectedAt: "2026-06-29T12:06:31.000Z",
      personPresent: false,
      occupancyState: "none",
    });
    await nextTick();

    events.cleanup();
    expect(events.observed).toEqual([]);
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

  it("does not expire active local touch presence on the vision stale timer", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-29T11:05:00.000Z"));
    const presence = await mountPresence({
      presenceStaleMs: 1000,
      inactivityDepartureMs: 5000,
    });

    window.dispatchEvent(new Event("pointerdown"));
    await nextTick();
    vi.advanceTimersByTime(1000);
    await nextTick();

    expect(presence.state?.value).toMatchObject({
      personPresent: true,
      source: "local_interaction",
    });
  });

  it("emits interaction awakened for local interaction from a not-present session", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-29T12:10:00.000Z"));
    const events = observeCustomerExperienceEvents();
    await mountPresence();

    window.dispatchEvent(new Event("pointerdown"));
    await nextTick();

    events.cleanup();
    expect(events.observed).toEqual([
      {
        type: "interaction.awakened",
        requestedAt: "2026-06-29T12:10:00.000Z",
      },
    ]);
  });

  it("emits interaction awakened for local key interaction from a not-present session", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-29T12:12:00.000Z"));
    const events = observeCustomerExperienceEvents();
    await mountPresence();

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await nextTick();

    events.cleanup();
    expect(events.observed).toEqual([
      {
        type: "interaction.awakened",
        requestedAt: "2026-06-29T12:12:00.000Z",
      },
    ]);
  });

  it("does not emit interaction awakened when vision has already marked the customer present", async () => {
    await mountPresence();
    emitPresenceStatus({
      eventId: "VISION-PRESENCE-BEFORE-TOUCH",
      detectedAt: "2026-06-29T12:15:00.000Z",
      personPresent: true,
      occupancyState: "single",
    });
    await nextTick();
    const events = observeCustomerExperienceEvents();

    window.dispatchEvent(new Event("pointerdown"));
    await nextTick();

    events.cleanup();
    expect(events.observed).toEqual([]);
  });

  it("emits crowd detected without a welcome or generic presence event for multiple-person vision presence", async () => {
    const events = observeCustomerExperienceEvents();
    await mountPresence();

    emitPresenceStatus({
      eventId: "VISION-PRESENCE-CROWD",
      detectedAt: "2026-06-29T12:20:00.000Z",
      personPresent: true,
      occupancyState: "multiple",
    });
    await nextTick();

    events.cleanup();
    expect(events.observed).toEqual([
      {
        type: "privacy.crowd_detected",
        requestedAt: "2026-06-29T12:20:00.000Z",
      },
    ]);
  });

  it("emits crowd detected when vision presence changes from single-person to multiple-person", async () => {
    const events = observeCustomerExperienceEvents();
    await mountPresence();

    emitPresenceStatus({
      eventId: "VISION-PRESENCE-SINGLE-BEFORE-CROWD",
      detectedAt: "2026-06-29T12:22:00.000Z",
      personPresent: true,
      occupancyState: "single",
    });
    await nextTick();
    emitPresenceStatus({
      eventId: "VISION-PRESENCE-BECOMES-CROWD",
      detectedAt: "2026-06-29T12:22:01.000Z",
      personPresent: true,
      occupancyState: "multiple",
    });
    await nextTick();

    events.cleanup();
    expect(events.observed).toEqual([
      {
        type: "presence.detected",
        requestedAt: "2026-06-29T12:22:00.000Z",
      },
      {
        type: "privacy.crowd_detected",
        requestedAt: "2026-06-29T12:22:01.000Z",
      },
    ]);
  });

  it("does not duplicate customer events for unchanged vision presence or crowd state", async () => {
    const events = observeCustomerExperienceEvents();
    await mountPresence();

    emitPresenceStatus({
      eventId: "VISION-PRESENCE-UNCHANGED-1",
      detectedAt: "2026-06-29T12:25:00.000Z",
      personPresent: true,
      occupancyState: "single",
    });
    await nextTick();
    emitPresenceStatus({
      eventId: "VISION-PRESENCE-UNCHANGED-2",
      detectedAt: "2026-06-29T12:25:01.000Z",
      personPresent: true,
      occupancyState: "single",
    });
    await nextTick();
    emitPresenceStatus({
      eventId: "VISION-PRESENCE-DEPART-BEFORE-CROWD",
      detectedAt: "2026-06-29T12:25:02.000Z",
      personPresent: false,
      occupancyState: "none",
    });
    await nextTick();
    emitPresenceStatus({
      eventId: "VISION-CROWD-UNCHANGED-1",
      detectedAt: "2026-06-29T12:25:03.000Z",
      personPresent: true,
      occupancyState: "multiple",
    });
    await nextTick();
    emitPresenceStatus({
      eventId: "VISION-CROWD-UNCHANGED-2",
      detectedAt: "2026-06-29T12:25:04.000Z",
      personPresent: true,
      occupancyState: "multiple",
    });
    await nextTick();

    events.cleanup();
    expect(events.observed).toEqual([
      {
        type: "presence.detected",
        requestedAt: "2026-06-29T12:25:00.000Z",
      },
      {
        type: "idle.sleep",
        requestedAt: "2026-06-29T12:25:02.000Z",
      },
      {
        type: "privacy.crowd_detected",
        requestedAt: "2026-06-29T12:25:03.000Z",
      },
    ]);
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
