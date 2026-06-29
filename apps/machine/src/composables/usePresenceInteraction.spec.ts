// @vitest-environment jsdom
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, nextTick, type Ref } from "vue";

import { useAudioCueStore } from "@/stores/audio-cues";
import { useVisionStore } from "@/stores/vision";

import type { PresenceInteractionState } from "./usePresenceInteraction";

import { usePresenceInteraction } from "./usePresenceInteraction";

let pinia: ReturnType<typeof createPinia>;

type RequestedPresenceCue = {
  type: "presence.detected";
  ambientLightLevel?: "bright" | "dim" | "dark" | "unknown" | null;
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
  ambientLightLevel?: "bright" | "dim" | "dark";
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
    ...(input.ambientLightLevel
      ? {
          ambientLight: {
            level: input.ambientLightLevel,
            measuredAt: input.detectedAt,
            source: "camera" as const,
            confidence: 0.82,
          },
        }
      : {}),
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
    pinia = createPinia();
    setActivePinia(pinia);
  });

  afterEach(() => {
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

  it("requests a bright presence audio cue when local presence transitions to present", async () => {
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
      ambientLightLevel: "bright",
    });
    await nextTick();

    expect(presence.state?.value.personPresent).toBe(true);
    expect(requester.requestCustomerAudioCue).toHaveBeenCalledOnce();
    expect(requester.events).toEqual([
      {
        type: "presence.detected",
        ambientLightLevel: "bright",
        requestedAt: "2026-06-29T10:00:00.000Z",
        nowMs: new Date("2026-06-29T10:00:00.000Z").getTime(),
      },
    ]);
  });

  it.each([
    ["dim", "dim"],
    ["dark", "dark"],
    [undefined, "unknown"],
  ] as const)(
    "requests the %s ambient light presence cue variant",
    async (ambientLightLevel, expectedVariant) => {
      enablePresenceAudioCues();
      const requester = createPresenceCueRequester();
      await mountPresence({
        audioCueRequester: requester,
      });

      emitPresenceStatus({
        eventId: `VISION-PRESENCE-EVENT-${expectedVariant}`,
        detectedAt: "2026-06-29T10:01:00.000Z",
        personPresent: true,
        ambientLightLevel,
      });
      await nextTick();

      expect(requester.events).toMatchObject([
        {
          type: "presence.detected",
          ambientLightLevel: expectedVariant,
          requestedAt: "2026-06-29T10:01:00.000Z",
        },
      ]);
    },
  );

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
      ambientLightLevel: "bright",
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
      ambientLightLevel: "dim",
    });
    await nextTick();

    expect(requester.requestCustomerAudioCue).toHaveBeenCalledTimes(2);
    expect(requester.events).toEqual([
      expect.objectContaining({
        type: "presence.detected",
        ambientLightLevel: "bright",
      }),
    ]);
  });

  it("does not replay a presence cue for cached present state after remount", async () => {
    enablePresenceAudioCues();
    emitPresenceStatus({
      eventId: "VISION-PRESENCE-EVENT-CACHED",
      detectedAt: "2026-06-29T10:03:00.000Z",
      personPresent: true,
      ambientLightLevel: "dark",
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
        ambientLightLevel: "bright",
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
      ambientLightLevel: "bright",
    });
    await nextTick();
    await Promise.resolve();

    expect(requester.requestCustomerAudioCue).toHaveBeenCalledOnce();
    expect(presence.state?.value).toEqual({
      personPresent: true,
      lastSeenAt: "2026-06-29T10:05:00.000Z",
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
        ambientLightLevel: "bright",
      });
      await nextTick();
    } finally {
      globalThis.Audio = OriginalAudio;
    }

    expect(requester.events).toHaveLength(1);
    expect(audioConstructor).not.toHaveBeenCalled();
  });

  it("derives person presence from explicit vision presence events and requests the ambient light cue variant", async () => {
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
      ambientLight: {
        level: "dim",
        measuredAt: "2026-06-29T10:00:00.000Z",
        source: "camera",
        confidence: 0.82,
      },
    });
    await nextTick();

    expect(presence.state?.value).toEqual({
      personPresent: true,
      lastSeenAt: "2026-06-29T10:00:00.000Z",
      source: "vision",
    });
    expect(presence.presenceClass?.value).toBe("presence-present");
    expect(requester.events).toMatchObject([
      {
        type: "presence.detected",
        ambientLightLevel: "dim",
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
      lastSeenAt: null,
      source: "unavailable",
    });
    expect(presence.presenceClass?.value).toBe("presence-idle");
  });

  it("expires locally cached present state when vision diagnostics stop arriving", async () => {
    vi.useFakeTimers();
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
      source: "unavailable",
    });
    expect(presence.presenceClass?.value).toBe("presence-idle");
  });
});
