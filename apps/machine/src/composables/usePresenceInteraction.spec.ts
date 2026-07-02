// @vitest-environment jsdom
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, nextTick, type Ref } from "vue";

import { useAudioCueStore } from "@/stores/audio-cues";
import { useVisionStore } from "@/stores/vision";

import type { PresenceInteractionState } from "./usePresenceInteraction";

import {
  resetCustomerPresenceSessionForTests,
  usePresenceInteraction,
} from "./usePresenceInteraction";

let pinia: ReturnType<typeof createPinia>;

type RequestedPresenceCue = {
  type: "presence.detected";
  requestedAt?: string;
  nowMs?: number;
};

function enablePresenceAudioCues(): void {
  useAudioCueStore().applySettings({
    enabled: true,
    categories: {
      presence: true,
      transaction: false,
    },
  });
}

function createPresenceCueRequester() {
  const events: RequestedPresenceCue[] = [];
  return {
    events,
    requestCustomerAudioCue: vi.fn(async (event: RequestedPresenceCue) => {
      const request = useAudioCueStore().requestCue({
        category: "presence",
        cueKey: event.type,
        requestedAt: event.requestedAt,
        nowMs: event.nowMs,
        minimumIntervalMs: 10_000,
      });
      if (request) {
        events.push(event);
        useAudioCueStore().recordPlaybackOutcome({
          requestId: request.requestId,
          outcome: "completed",
        });
      }
      return Promise.resolve(request !== null);
    }),
  };
}

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

  it("requests a presence audio cue when local presence transitions to present", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-29T10:00:00.000Z"));
    enablePresenceAudioCues();
    const requester = createPresenceCueRequester();
    const presence = await mountPresence({
      audioCueRequester: requester,
    });

    emitPresenceStatus({
      eventId: "VISION-PRESENCE-EVENT-BRIGHT",
      detectedAt: "2026-06-29T10:00:00.000Z",
      personPresent: true,
    });
    await nextTick();

    expect(presence.state?.value.personPresent).toBe(true);
    expect(requester.requestCustomerAudioCue).toHaveBeenCalledOnce();
    expect(requester.events).toEqual([
      {
        type: "presence.detected",
        requestedAt: "2026-06-29T10:00:00.000Z",
        nowMs: new Date("2026-06-29T10:00:00.000Z").getTime(),
      },
    ]);
  });

  it("does not accept a duplicate welcome cue during the central presence cooldown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-29T10:02:00.000Z"));
    enablePresenceAudioCues();
    const requester = createPresenceCueRequester();
    await mountPresence({
      audioCueRequester: requester,
    });

    emitPresenceStatus({
      eventId: "VISION-PRESENCE-EVENT-FIRST",
      detectedAt: "2026-06-29T10:02:00.000Z",
      personPresent: true,
    });
    await nextTick();
    emitPresenceStatus({
      eventId: "VISION-PRESENCE-EVENT-ABSENT",
      detectedAt: "2026-06-29T10:02:01.000Z",
      personPresent: false,
    });
    await nextTick();
    emitPresenceStatus({
      eventId: "VISION-PRESENCE-EVENT-SECOND",
      detectedAt: "2026-06-29T10:02:02.000Z",
      personPresent: true,
    });
    await nextTick();

    expect(requester.requestCustomerAudioCue).toHaveBeenCalledTimes(2);
    expect(requester.events).toEqual([
      expect.objectContaining({
        type: "presence.detected",
      }),
    ]);
  });

  it("does not replay a presence cue for cached present state after remount", async () => {
    enablePresenceAudioCues();
    emitPresenceStatus({
      eventId: "VISION-PRESENCE-EVENT-CACHED",
      detectedAt: "2026-06-29T10:03:00.000Z",
      personPresent: true,
    });

    const firstRequester = createPresenceCueRequester();
    const firstMount = await mountPresence({
      audioCueRequester: firstRequester,
    });
    firstMount.unmount?.();
    const secondRequester = createPresenceCueRequester();
    const secondMount = await mountPresence({
      audioCueRequester: secondRequester,
    });

    expect(secondMount.state?.value.personPresent).toBe(true);
    expect(firstRequester.events).toHaveLength(0);
    expect(secondRequester.events).toHaveLength(0);
  });

  it.each([
    [
      "global audio cue setting",
      { enabled: false, categories: { presence: true, transaction: true } },
    ],
    [
      "presence audio cue category",
      { enabled: true, categories: { presence: false, transaction: true } },
    ],
  ] as const)(
    "does not accept presence audio cues when the %s is disabled",
    async (_settingName, settings) => {
      useAudioCueStore().applySettings(settings);
      const requester = createPresenceCueRequester();
      await mountPresence({
        audioCueRequester: requester,
      });

      emitPresenceStatus({
        eventId: "VISION-PRESENCE-EVENT-MUTED",
        detectedAt: "2026-06-29T10:04:00.000Z",
        personPresent: true,
      });
      await nextTick();

      expect(requester.requestCustomerAudioCue).toHaveBeenCalledOnce();
      expect(requester.events).toHaveLength(0);
      expect(useAudioCueStore().playback.status).toBe("idle");
    },
  );

  it("keeps presence state when presence audio cue playback request fails", async () => {
    const requester = {
      requestCustomerAudioCue: vi.fn(async () => {
        throw new Error("NotAllowedError");
      }),
    };
    const presence = await mountPresence({
      audioCueRequester: requester,
    });

    emitPresenceStatus({
      eventId: "VISION-PRESENCE-EVENT-FAILS",
      detectedAt: "2026-06-29T10:05:00.000Z",
      personPresent: true,
    });
    await nextTick();
    await Promise.resolve();

    expect(requester.requestCustomerAudioCue).toHaveBeenCalledOnce();
    expect(presence.state?.value).toEqual({
      personPresent: true,
      lastSeenAt: "2026-06-29T10:05:00.000Z",
      departedAt: null,
      lastInteractionAt: null,
      source: "vision",
    });
    expect(presence.presenceClass?.value).toBe("presence-present");
  });

  it("does not directly construct browser audio from presence interaction", async () => {
    enablePresenceAudioCues();
    const OriginalAudio = globalThis.Audio;
    const audioConstructor = vi.fn();
    globalThis.Audio = audioConstructor as unknown as typeof Audio;
    const requester = createPresenceCueRequester();
    try {
      await mountPresence({
        audioCueRequester: requester,
      });
      emitPresenceStatus({
        eventId: "VISION-PRESENCE-EVENT-NO-DIRECT-AUDIO",
        detectedAt: "2026-06-29T10:06:00.000Z",
        personPresent: true,
      });
      await nextTick();
    } finally {
      globalThis.Audio = OriginalAudio;
    }

    expect(requester.events).toHaveLength(1);
    expect(audioConstructor).not.toHaveBeenCalled();
  });

  it("derives person presence from explicit vision presence events and requests a presence cue", async () => {
    enablePresenceAudioCues();
    const requester = createPresenceCueRequester();
    const presence = await mountPresence({
      audioCueRequester: requester,
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

    expect(presence.state?.value).toEqual({
      personPresent: true,
      lastSeenAt: "2026-06-29T10:00:00.000Z",
      departedAt: null,
      lastInteractionAt: null,
      source: "vision",
    });
    expect(presence.presenceClass?.value).toBe("presence-present");
    expect(requester.events).toMatchObject([
      {
        type: "presence.detected",
        requestedAt: "2026-06-29T10:00:00.000Z",
      },
    ]);

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
    expect(requester.events).toHaveLength(1);
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
    enablePresenceAudioCues();
    const requester = createPresenceCueRequester();
    const presence = await mountPresence({
      audioCueRequester: requester,
    });

    window.dispatchEvent(new Event("pointerdown"));
    await nextTick();

    expect(presence.state?.value).toEqual({
      personPresent: true,
      lastSeenAt: "2026-06-29T11:00:00.000Z",
      departedAt: null,
      lastInteractionAt: "2026-06-29T11:00:00.000Z",
      source: "local_interaction",
    });
    expect(requester.events).toEqual([
      expect.objectContaining({
        type: "presence.detected",
      }),
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
