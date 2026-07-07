import type {
  AudioCueCategory,
  CustomerAudioCueRequest,
} from "@/stores/audio-cues";

import {
  createMachineAudioPlayback,
  type MachineAudioPlayback,
  type MachineAudioPlaybackDiagnostic,
} from "@/audio-playback/machine-audio-playback";
import {
  CUSTOMER_EXPERIENCE_EVENT_PRIORITIES,
  describeCustomerExperienceEvent,
  type CustomerExperienceEvent,
} from "@/customer-events/events";
import { getEasterEggType, getDepartureEventType } from "@/composables/usePresenceInteraction";
import { useAudioCueStore } from "@/stores/audio-cues";
import { useMachineStore } from "@/stores/machine";
import { useNaturalContextStore } from "@/stores/natural-context";

const VOICE_BASE_PATH = "/audio/voice";

type MachineAudioCuePlaybackFactoryOptions = {
  volume: number;
  onDiagnostic: (diagnostic: MachineAudioPlaybackDiagnostic) => void;
};

type MachineAudioCuePlaybackFactory = (
  options: MachineAudioCuePlaybackFactoryOptions,
) => MachineAudioPlayback;

type MachineAudioCuePlaybackAdapterOptions = {
  playbackFactory?: MachineAudioCuePlaybackFactory;
  autoStart?: boolean;
};

type ActiveCuePlayback = {
  requestId: string;
  request: CustomerAudioCueRequest;
  playback: MachineAudioPlayback;
};

type SharedPlaybackState = {
  pendingSources: Map<string, string>;
  activePlayback: ActiveCuePlayback | null;
};

type CueDescriptor = {
  category: AudioCueCategory;
  cueKey: string;
  orderKey: string | null;
  requestedAt?: string;
  nowMs: number;
  minimumIntervalMs?: number;
  priority: number;
  staleAfterMs: number | null;
  source: string;
};

const PRESENCE_STALE_AFTER_MS = 2_000;

const PLACEHOLDER_TONE_SOURCE =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=";

const CUE_SOURCES: Record<CustomerExperienceEvent["type"], string> = {
  "presence.detected": `${PLACEHOLDER_TONE_SOURCE}#presence-detected`,
  "presence.easter_egg": `${VOICE_BASE_PATH}/easter_egg/festival/spring_festival.mp3`,
  "presence.easter_egg.festival": `${VOICE_BASE_PATH}/easter_egg/festival/spring_festival.mp3`,
  "presence.easter_egg.solar_term": `${VOICE_BASE_PATH}/easter_egg/solar_term/start_of_spring.mp3`,
  "presence.easter_egg.season": `${VOICE_BASE_PATH}/easter_egg/season/spring.mp3`,
  "presence.welcome.day": `${VOICE_BASE_PATH}/interaction/awakened.mp3`,
  "presence.welcome.night": `${VOICE_BASE_PATH}/interaction/awakened.mp3`,
  "interaction.awakened": `${VOICE_BASE_PATH}/interaction/awakened.mp3`,
  "privacy.crowd_detected": `${VOICE_BASE_PATH}/privacy/crowd_detected.mp3`,
  "idle.assistance_prompt": `${VOICE_BASE_PATH}/error/idle_timeout.mp3`,
  "idle.sleep": `${VOICE_BASE_PATH}/error/idle_timeout.mp3`,
  "departure.bad_weather": `${VOICE_BASE_PATH}/departure/bad_weather/high_temp.mp3`,
  "departure.bad_air": `${VOICE_BASE_PATH}/departure/bad_air.mp3`,
  "departure.bad_forecast": `${VOICE_BASE_PATH}/departure/bad_forecast/light_rain.mp3`,
  "departure.normal_weather": `${VOICE_BASE_PATH}/departure/normal_weather/sunny.mp3`,
  "product.selected": `${VOICE_BASE_PATH}/interaction/product_selected.mp3`,
  "payment.prompt": `${VOICE_BASE_PATH}/payment/prompt.mp3`,
  "payment.succeeded": `${VOICE_BASE_PATH}/payment/succeeded.mp3`,
  "payment.failed": `${VOICE_BASE_PATH}/payment/failed.mp3`,
  "dispensing.started": `${VOICE_BASE_PATH}/dispensing/started.mp3`,
  "dispense.outlet_opened": `${VOICE_BASE_PATH}/dispensing/succeeded.mp3`,
  "dispense.succeeded": `${VOICE_BASE_PATH}/dispensing/succeeded.mp3`,
  "dispense.failed": `${VOICE_BASE_PATH}/error/dispense_failed.mp3`,
  "pickup.waiting": `${VOICE_BASE_PATH}/dispensing/started.mp3`,
  "pickup.warning": `${VOICE_BASE_PATH}/pickup/reminder_10s.mp3`,
  "pickup.urgent": `${VOICE_BASE_PATH}/pickup/reminder_25s.mp3`,
  "pickup.completed": `${VOICE_BASE_PATH}/effects/pickup_beep.mp3`,
  "refund.pending": `${VOICE_BASE_PATH}/refund/pending.mp3`,
  "refund.completed": `${VOICE_BASE_PATH}/refund/completed.mp3`,
  "manual_handling.required": `${VOICE_BASE_PATH}/error/hardware_fault.mp3`,
  "system.hardware_fault": `${VOICE_BASE_PATH}/error/hardware_fault.mp3`,
  "product.intro.socks": `${VOICE_BASE_PATH}/product/socks.mp3`,
  "product.intro.underwear": `${VOICE_BASE_PATH}/product/underwear.mp3`,
  "product.intro.tshirt": `${VOICE_BASE_PATH}/product/tshirt.mp3`,
};

const CUE_SOURCE_BY_KEY: Readonly<Record<string, string | undefined>> =
  CUE_SOURCES;

const CUE_PRIORITY_BY_KEY: Readonly<Record<string, number | undefined>> =
  CUSTOMER_EXPERIENCE_EVENT_PRIORITIES;

const sharedPlaybackState: SharedPlaybackState = {
  pendingSources: new Map<string, string>(),
  activePlayback: null,
};

export function createMachineAudioCuePlaybackAdapter(
  options: MachineAudioCuePlaybackAdapterOptions = {},
): {
  handleCustomerEvent(event: CustomerExperienceEvent): Promise<boolean>;
  startPendingCue(): Promise<boolean>;
  clearPendingCue(message?: string): boolean;
  pendingSourceCount(): number;
} {
  const playbackFactory =
    options.playbackFactory ?? defaultMachineAudioPlaybackFactory;
  const autoStart = options.autoStart ?? true;

  async function handleCustomerEvent(
    event: CustomerExperienceEvent,
  ): Promise<boolean> {
    const store = useAudioCueStore();
    const naturalContextStore = useNaturalContextStore();
    const descriptor = descriptorFromEvent(event, naturalContextStore);
    const currentRequest = store.playback.request;
    if (!currentRequest) {
      sharedPlaybackState.pendingSources.clear();
    }
    let droppedCurrentRequest = false;

    if (
      descriptor.orderKey &&
      store.hasOrderCuePlayed(descriptor.orderKey, descriptor.cueKey)
    ) {
      store.recordSuppressedCue({
        category: descriptor.category,
        cueKey: descriptor.cueKey,
        orderKey: descriptor.orderKey,
        message: "duplicate transaction cue",
        recordedAt: descriptor.requestedAt,
      });
      return false;
    }

    if (currentRequest) {
      const currentPriority = priorityFor(currentRequest.cueKey);
      if (isStaleLowPriorityCue(currentRequest, descriptor.nowMs)) {
        sharedPlaybackState.pendingSources.delete(currentRequest.requestId);
        stopActivePlayback(currentRequest.requestId);
        store.recordPlaybackOutcome({
          requestId: currentRequest.requestId,
          outcome: "skipped",
          message: "stale",
          recordedAt: descriptor.requestedAt,
        });
        droppedCurrentRequest = true;
      } else if (descriptor.priority <= currentPriority) {
        store.recordSuppressedCue({
          category: descriptor.category,
          cueKey: descriptor.cueKey,
          orderKey: descriptor.orderKey,
          message: `lower priority than ${currentRequest.cueKey}`,
          recordedAt: descriptor.requestedAt,
        });
        return false;
      } else {
        sharedPlaybackState.pendingSources.delete(currentRequest.requestId);
        stopActivePlayback(currentRequest.requestId);
        store.recordPlaybackOutcome({
          requestId: currentRequest.requestId,
          outcome: "skipped",
          message: `replaced by ${descriptor.cueKey}`,
          recordedAt: descriptor.requestedAt,
        });
      }
    }

    const request = store.requestCue({
      category: descriptor.category,
      cueKey: descriptor.cueKey,
      orderKey: descriptor.orderKey,
      requestedAt: descriptor.requestedAt,
      nowMs: descriptor.nowMs,
      minimumIntervalMs:
        currentRequest && !droppedCurrentRequest
          ? undefined
          : descriptor.minimumIntervalMs,
    });
    if (!request) {
      stopStaleActivePresencePlayback(descriptor.nowMs);
      return false;
    }
    sharedPlaybackState.pendingSources.set(
      request.requestId,
      descriptor.source,
    );

    if (!autoStart) return true;
    return startPlayback(request, descriptor.source);
  }

  async function startPendingCue(): Promise<boolean> {
    const store = useAudioCueStore();
    const request = store.playback.request;
    if (!request || store.playback.status !== "pending") return false;
    return startPlayback(
      request,
      sharedPlaybackState.pendingSources.get(request.requestId) ??
        sourceForRequest(request),
    );
  }

  function clearPendingCue(message = "cleared"): boolean {
    const store = useAudioCueStore();
    const request = store.playback.request;
    if (!request || store.playback.status !== "pending") return false;
    sharedPlaybackState.pendingSources.delete(request.requestId);
    store.recordPlaybackOutcome({
      requestId: request.requestId,
      outcome: "skipped",
      message,
    });
    return true;
  }

  async function startPlayback(
    request: CustomerAudioCueRequest,
    source: string,
  ): Promise<boolean> {
    const store = useAudioCueStore();
    if (!store.markCuePlaying(request.requestId)) return false;
    sharedPlaybackState.pendingSources.delete(request.requestId);
    stopActivePlayback();

    const playback = playbackFactory({
      volume: normalizeMachineAudioVolume(
        useMachineStore().config.machineAudioVolume,
      ),
      onDiagnostic: (diagnostic) => {
        if (
          diagnostic.status !== "completed" ||
          sharedPlaybackState.activePlayback?.requestId !== request.requestId
        ) {
          return;
        }
        sharedPlaybackState.activePlayback = null;
      },
    });
    sharedPlaybackState.activePlayback = {
      requestId: request.requestId,
      request,
      playback,
    };

    try {
      const started = await playback.playLocal(source);
      if (!started) {
        if (
          sharedPlaybackState.activePlayback?.requestId === request.requestId
        ) {
          sharedPlaybackState.activePlayback = null;
        }
        store.recordPlaybackOutcome({
          requestId: request.requestId,
          outcome: "failed",
          message:
            playback.latestDiagnostic()?.message ??
            "Machine Audio Playback did not start",
        });
        return false;
      }
      if (sharedPlaybackState.activePlayback?.requestId !== request.requestId) {
        return false;
      }
      if (request.orderKey) {
        store.rememberOrderCuePlayed(request.orderKey, request.cueKey);
      }
      store.recordPlaybackOutcome({
        requestId: request.requestId,
        outcome: "played",
      });
      return true;
    } catch (error) {
      if (sharedPlaybackState.activePlayback?.requestId === request.requestId) {
        sharedPlaybackState.activePlayback = null;
      }
      store.recordPlaybackOutcome({
        requestId: request.requestId,
        outcome: "failed",
        message: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  return {
    handleCustomerEvent,
    startPendingCue,
    clearPendingCue,
    pendingSourceCount: () => sharedPlaybackState.pendingSources.size,
  };

  function stopActivePlayback(requestId?: string): void {
    if (
      requestId !== undefined &&
      sharedPlaybackState.activePlayback?.requestId !== requestId
    ) {
      return;
    }
    if (!sharedPlaybackState.activePlayback) return;
    const playback = sharedPlaybackState.activePlayback.playback;
    sharedPlaybackState.activePlayback = null;
    playback.stop();
  }

  function stopStaleActivePresencePlayback(nowMs: number): void {
    const activeRequest = sharedPlaybackState.activePlayback?.request;
    if (!activeRequest || !isStaleLowPriorityCue(activeRequest, nowMs)) return;
    stopActivePlayback(activeRequest.requestId);
  }
}

function getDynamicAudioSource(
  eventKey: string,
  naturalContextStore: ReturnType<typeof useNaturalContextStore>
): string {
  if (eventKey.startsWith("presence.easter_egg.")) {
    const eggType = getEasterEggType(naturalContextStore);
    if (eggType) {
      return `${VOICE_BASE_PATH}/easter_egg/${eggType.type}/${eggType.value}.mp3`;
    }
  }
  if (eventKey.startsWith("departure.")) {
    const departureType = getDepartureEventType(naturalContextStore);
    if (departureType) {
      if (departureType === "departure.bad_weather") {
        const weather = naturalContextStore.snapshot?.externalEnvironment.weather;
        if (weather) {
          if (naturalContextStore.isHighTemperature) return `${VOICE_BASE_PATH}/departure/bad_weather/high_temp.mp3`;
          if (naturalContextStore.hasHeavyRain) return `${VOICE_BASE_PATH}/departure/bad_weather/heavy_rain.mp3`;
          if (naturalContextStore.hasLightRain) return `${VOICE_BASE_PATH}/departure/bad_weather/light_rain.mp3`;
          if (naturalContextStore.hasThunder) return `${VOICE_BASE_PATH}/departure/bad_weather/thunder.mp3`;
          if (naturalContextStore.hasSnow) return `${VOICE_BASE_PATH}/departure/bad_weather/snow.mp3`;
          if (naturalContextStore.hasStrongWind) return `${VOICE_BASE_PATH}/departure/bad_weather/strong_wind.mp3`;
        }
      } else if (departureType === "departure.normal_weather") {
        if (naturalContextStore.isSunny) return `${VOICE_BASE_PATH}/departure/normal_weather/sunny.mp3`;
        if (naturalContextStore.isCloudy) return `${VOICE_BASE_PATH}/departure/normal_weather/cloudy.mp3`;
      }
    }
  }
  return CUE_SOURCE_BY_KEY[eventKey] ?? "";
}

function descriptorFromEvent(
  event: CustomerExperienceEvent,
  naturalContextStore: ReturnType<typeof useNaturalContextStore>
): CueDescriptor {
  const descriptor = describeCustomerExperienceEvent(event);
  return {
    category: descriptor.category,
    cueKey: descriptor.eventKey,
    orderKey: descriptor.orderKey,
    requestedAt: descriptor.requestedAt,
    nowMs: descriptor.nowMs,
    minimumIntervalMs: descriptor.minimumIntervalMs,
    priority: descriptor.priority,
    staleAfterMs: descriptor.staleAfterMs,
    source: getDynamicAudioSource(descriptor.eventKey, naturalContextStore),
  };
}

function priorityFor(cueKey: string): number {
  return CUE_PRIORITY_BY_KEY[cueKey] ?? 0;
}

function isStaleLowPriorityCue(
  request: CustomerAudioCueRequest,
  nowMs: number,
): boolean {
  if (request.category !== "presence") return false;
  return nowMs - request.requestedAtMs > PRESENCE_STALE_AFTER_MS;
}

function sourceForRequest(request: CustomerAudioCueRequest): string {
  return CUE_SOURCE_BY_KEY[request.cueKey] ?? CUE_SOURCES["presence.detected"];
}

function defaultMachineAudioPlaybackFactory(
  options: MachineAudioCuePlaybackFactoryOptions,
): MachineAudioPlayback {
  return createMachineAudioPlayback(options);
}

function normalizeMachineAudioVolume(value: unknown): number {
  const numericValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numericValue)) return 0.7;
  return Math.min(1, Math.max(0, numericValue));
}
