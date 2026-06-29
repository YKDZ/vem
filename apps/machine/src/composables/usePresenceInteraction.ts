import {
  visionPresenceStatusPayloadSchema,
  visionProfileResultPayloadSchema,
} from "@vem/shared";
import { computed, onUnmounted, readonly, ref, watch, type Ref } from "vue";

import type {
  VisionPresenceStatusPayload,
  VisionProfileResultPayload,
} from "@/native/vision";

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
};

export function usePresenceInteraction(
  options: PresenceInteractionOptions = {},
): {
  state: Readonly<Ref<PresenceInteractionState>>;
  presenceClass: Readonly<Ref<string>>;
} {
  const visionStore = useVisionStore();
  const presenceStaleMs = options.presenceStaleMs ?? DEFAULT_PRESENCE_STALE_MS;

  const state = ref<PresenceInteractionState>({
    personPresent: false,
    lastSeenAt: null,
    source: "unavailable",
  });
  let staleTimer: ReturnType<typeof setTimeout> | null = null;
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

  function applyProfileResult(payload: VisionProfileResultPayload): void {
    const personPresent =
      payload.profile.personPresent &&
      (payload.profile.confidence === undefined ||
        payload.profile.confidence >= PRESENCE_CONFIDENCE_THRESHOLD);
    state.value = {
      personPresent,
      lastSeenAt: personPresent ? payload.detectedAt : state.value.lastSeenAt,
      source: "vision",
    };
    restartStaleTimer();
  }

  function applyPresenceStatus(payload: VisionPresenceStatusPayload): void {
    const personPresent = payload.personPresent;
    state.value = {
      personPresent,
      lastSeenAt: personPresent ? payload.detectedAt : state.value.lastSeenAt,
      source: "vision",
    };
    restartStaleTimer();
  }

  watch(
    () => visionStore.latestDiagnosticPayload,
    (payload) => {
      const profileResult = profileResultFromDiagnostic(payload);
      if (profileResult) {
        applyProfileResult(profileResult);
        return;
      }
      const presenceStatus = presenceStatusFromDiagnostic(payload);
      if (presenceStatus) {
        applyPresenceStatus(presenceStatus);
        return;
      }
      state.value = {
        personPresent: false,
        lastSeenAt: null,
        source: "unavailable",
      };
      clearStaleTimer();
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
