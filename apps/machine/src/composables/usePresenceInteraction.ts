import {
  visionPresenceStatusPayloadSchema,
  visionProfileResultPayloadSchema,
} from "@vem/shared";
import { computed, onUnmounted, readonly, ref, watch, type Ref } from "vue";

import type {
  VisionPresenceStatusPayload,
  VisionProfileResultPayload,
} from "@/native/vision";

import {
  createMachineAudioCuePlaybackAdapter,
  type CustomerAudioCueEvent,
  type PresenceAmbientLightLevel,
} from "@/audio-cues/browser-playback";
import { useVisionStore } from "@/stores/vision";

const DEFAULT_PRESENCE_STALE_MS = 15_000;
const PRESENCE_CONFIDENCE_THRESHOLD = 0.5;

export type PresenceInteractionState = {
  personPresent: boolean;
  lastSeenAt: string | null;
  source: "vision" | "unavailable";
};

export type PresenceInteractionOptions = {
  presenceStaleMs?: number;
  audioCueRequester?: {
    requestCustomerAudioCue(event: CustomerAudioCueEvent): Promise<boolean>;
  };
};

export function usePresenceInteraction(
  options: PresenceInteractionOptions = {},
): {
  state: Readonly<Ref<PresenceInteractionState>>;
  presenceClass: Readonly<Ref<string>>;
} {
  const visionStore = useVisionStore();
  const presenceStaleMs = options.presenceStaleMs ?? DEFAULT_PRESENCE_STALE_MS;
  const audioCueRequester =
    options.audioCueRequester ?? createMachineAudioCuePlaybackAdapter();

  const state = ref<PresenceInteractionState>({
    personPresent: false,
    lastSeenAt: null,
    source: "unavailable",
  });
  let staleTimer: ReturnType<typeof setTimeout> | null = null;
  let initializedFromCurrentDiagnostic = false;
  const presenceClass = computed(() =>
    state.value.personPresent ? "presence-present" : "presence-idle",
  );

  function clearStaleTimer(): void {
    if (staleTimer !== null) {
      clearTimeout(staleTimer);
      staleTimer = null;
    }
  }

  function restartStaleTimer(): void {
    clearStaleTimer();
    if (!state.value.personPresent) return;
    staleTimer = setTimeout(() => {
      state.value = {
        personPresent: false,
        lastSeenAt: state.value.lastSeenAt,
        source: "unavailable",
      };
      staleTimer = null;
    }, presenceStaleMs);
  }

  function requestPresenceCue(
    payload: VisionProfileResultPayload | VisionPresenceStatusPayload,
  ): void {
    void audioCueRequester
      .requestCustomerAudioCue({
        type: "presence.detected",
        ambientLightLevel: ambientLightLevelFor(payload),
        requestedAt: payload.detectedAt,
        nowMs: millisecondsForDetectedAt(payload.detectedAt),
      })
      .catch(() => {
        // Audio cue playback is customer-experience best effort only.
      });
  }

  function applyProfileResult(
    payload: VisionProfileResultPayload,
    options: { suppressAudioCue?: boolean } = {},
  ): void {
    const wasPresent = state.value.personPresent;
    const personPresent =
      payload.profile.personPresent &&
      (payload.profile.confidence === undefined ||
        payload.profile.confidence >= PRESENCE_CONFIDENCE_THRESHOLD);
    state.value = {
      personPresent,
      lastSeenAt: personPresent ? payload.detectedAt : state.value.lastSeenAt,
      source: "vision",
    };
    if (personPresent && !wasPresent && !options.suppressAudioCue) {
      requestPresenceCue(payload);
    }
    restartStaleTimer();
  }

  function applyPresenceStatus(
    payload: VisionPresenceStatusPayload,
    options: { suppressAudioCue?: boolean } = {},
  ): void {
    const wasPresent = state.value.personPresent;
    const personPresent = payload.personPresent;
    state.value = {
      personPresent,
      lastSeenAt: personPresent ? payload.detectedAt : state.value.lastSeenAt,
      source: "vision",
    };
    if (personPresent && !wasPresent && !options.suppressAudioCue) {
      requestPresenceCue(payload);
    }
    restartStaleTimer();
  }

  watch(
    () => visionStore.latestDiagnosticPayload,
    (payload) => {
      const suppressAudioCue = !initializedFromCurrentDiagnostic;
      const profileResult = profileResultFromDiagnostic(payload);
      if (profileResult) {
        applyProfileResult(profileResult, { suppressAudioCue });
        initializedFromCurrentDiagnostic = true;
        return;
      }
      const presenceStatus = presenceStatusFromDiagnostic(payload);
      if (presenceStatus) {
        applyPresenceStatus(presenceStatus, { suppressAudioCue });
        initializedFromCurrentDiagnostic = true;
        return;
      }
      state.value = {
        personPresent: false,
        lastSeenAt: null,
        source: "unavailable",
      };
      clearStaleTimer();
      initializedFromCurrentDiagnostic = true;
    },
    { immediate: true },
  );

  onUnmounted(() => {
    clearStaleTimer();
  });

  return {
    state: readonly(state),
    presenceClass: readonly(presenceClass),
  };
}

function presenceStatusFromDiagnostic(
  value: unknown,
): VisionPresenceStatusPayload | null {
  if (
    typeof value !== "object" ||
    value === null ||
    !("type" in value) ||
    value.type !== "vision.presence_status" ||
    !("payload" in value)
  ) {
    return null;
  }
  const result = visionPresenceStatusPayloadSchema.safeParse(value.payload);
  return result.success ? result.data : null;
}

function profileResultFromDiagnostic(
  value: unknown,
): VisionProfileResultPayload | null {
  if (
    typeof value !== "object" ||
    value === null ||
    !("type" in value) ||
    value.type !== "vision.profile_result" ||
    !("payload" in value)
  ) {
    return null;
  }
  const result = visionProfileResultPayloadSchema.safeParse(value.payload);
  return result.success ? result.data : null;
}

function ambientLightLevelFor(
  payload: VisionProfileResultPayload | VisionPresenceStatusPayload,
): PresenceAmbientLightLevel {
  if (!("ambientLight" in payload)) return "unknown";
  const level = payload.ambientLight?.level;
  return level === "bright" || level === "dim" || level === "dark"
    ? level
    : "unknown";
}

function millisecondsForDetectedAt(detectedAt: string): number {
  const parsed = Date.parse(detectedAt);
  return Number.isFinite(parsed) ? parsed : Date.now();
}
