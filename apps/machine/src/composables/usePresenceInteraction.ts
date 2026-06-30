import {
  visionPersonDepartedPayloadSchema,
  visionPresenceStatusPayloadSchema,
  visionProfileResultPayloadSchema,
} from "@vem/shared";
import {
  computed,
  onUnmounted,
  readonly,
  ref,
  watch,
  type Ref,
  type WatchStopHandle,
} from "vue";
import { useRoute, useRouter, type RouteLocationRaw } from "vue-router";

import type {
  VisionPersonDepartedPayload,
  VisionPresenceStatusPayload,
  VisionProfileResultPayload,
} from "@/native/vision";

import {
  createMachineAudioCuePlaybackAdapter,
  type CustomerAudioCueEvent,
} from "@/audio-cues/browser-playback";
import { useVisionStore } from "@/stores/vision";

const DEFAULT_PRESENCE_STALE_MS = 15_000;
const DEFAULT_INACTIVITY_DEPARTURE_MS = 45_000;
const PRESENCE_CONFIDENCE_THRESHOLD = 0.5;
const RETURN_HOME_ROUTE_NAMES = new Set(["product-detail", "checkout"]);

export type PresenceInteractionSource =
  | "vision"
  | "local_interaction"
  | "inactivity"
  | "unavailable";

export type PresenceInteractionState = {
  personPresent: boolean;
  lastSeenAt: string | null;
  departedAt: string | null;
  lastInteractionAt: string | null;
  source: PresenceInteractionSource;
};

export type PresenceInteractionOptions = {
  presenceStaleMs?: number;
  inactivityDepartureMs?: number;
  audioCueRequester?: {
    requestCustomerAudioCue(event: CustomerAudioCueEvent): Promise<boolean>;
  };
};

type CustomerPresenceSession = {
  state: Readonly<Ref<PresenceInteractionState>>;
  presenceClass: Readonly<Ref<string>>;
  registerInteraction: () => void;
};

type MutableSessionState = Ref<PresenceInteractionState>;

const state = ref<PresenceInteractionState>({
  personPresent: false,
  lastSeenAt: null,
  departedAt: null,
  lastInteractionAt: null,
  source: "unavailable",
}) as MutableSessionState;

const presenceClass = computed(() =>
  state.value.personPresent ? "presence-present" : "presence-idle",
);

let started = false;
let staleTimer: ReturnType<typeof setTimeout> | null = null;
let inactivityTimer: ReturnType<typeof setTimeout> | null = null;
let stopVisionWatch: WatchStopHandle | null = null;
let initializedFromCurrentDiagnostic = false;
let activeOptions: Required<PresenceInteractionOptions> | null = null;

function defaultAudioCueRequester(): {
  requestCustomerAudioCue(event: CustomerAudioCueEvent): Promise<boolean>;
} {
  return createMachineAudioCuePlaybackAdapter();
}

function optionsWithDefaults(
  options: PresenceInteractionOptions,
): Required<PresenceInteractionOptions> {
  return {
    presenceStaleMs: options.presenceStaleMs ?? DEFAULT_PRESENCE_STALE_MS,
    inactivityDepartureMs:
      options.inactivityDepartureMs ?? DEFAULT_INACTIVITY_DEPARTURE_MS,
    audioCueRequester: options.audioCueRequester ?? defaultAudioCueRequester(),
  };
}

function clearTimer(timer: ReturnType<typeof setTimeout> | null): null {
  if (timer !== null) clearTimeout(timer);
  return null;
}

function clearStaleTimer(): void {
  staleTimer = clearTimer(staleTimer);
}

function clearInactivityTimer(): void {
  inactivityTimer = clearTimer(inactivityTimer);
}

function nowIso(): string {
  return new Date().toISOString();
}

function restartStaleTimer(): void {
  clearStaleTimer();
  if (!activeOptions || !state.value.personPresent) return;
  staleTimer = setTimeout(() => {
    markDeparted({
      source: "unavailable",
      departedAt: nowIso(),
      keepLastSeenAt: true,
    });
  }, activeOptions.presenceStaleMs);
}

function restartInactivityTimer(): void {
  clearInactivityTimer();
  if (!activeOptions || !state.value.personPresent) return;
  inactivityTimer = setTimeout(() => {
    markDeparted({
      source: "inactivity",
      departedAt: nowIso(),
      keepLastSeenAt: true,
    });
  }, activeOptions.inactivityDepartureMs);
}

function restartDepartureTimers(): void {
  restartStaleTimer();
  restartInactivityTimer();
}

function requestPresenceCue(input: { requestedAt: string }): void {
  if (!activeOptions) return;
  void activeOptions.audioCueRequester
    .requestCustomerAudioCue({
      type: "presence.detected",
      requestedAt: input.requestedAt,
      nowMs: millisecondsForDetectedAt(input.requestedAt),
    })
    .catch(() => {
      // Audio cue playback is customer-experience best effort only.
    });
}

function markPresent(input: {
  source: Exclude<PresenceInteractionSource, "inactivity" | "unavailable">;
  seenAt: string;
  suppressAudioCue?: boolean;
}): void {
  const wasPresent = state.value.personPresent;
  state.value = {
    personPresent: true,
    lastSeenAt: input.seenAt,
    departedAt: null,
    lastInteractionAt: state.value.lastInteractionAt,
    source: input.source,
  };
  if (!wasPresent && !input.suppressAudioCue) {
    requestPresenceCue({
      requestedAt: input.seenAt,
    });
  }
  restartDepartureTimers();
}

function markDeparted(input: {
  source: Exclude<PresenceInteractionSource, "local_interaction">;
  departedAt: string | null;
  lastSeenAt?: string | null;
  keepLastSeenAt?: boolean;
}): void {
  state.value = {
    personPresent: false,
    lastSeenAt: input.keepLastSeenAt
      ? state.value.lastSeenAt
      : (input.lastSeenAt ?? state.value.lastSeenAt),
    departedAt: input.departedAt,
    lastInteractionAt: state.value.lastInteractionAt,
    source: input.source,
  };
  clearStaleTimer();
  clearInactivityTimer();
}

function registerInteraction(): void {
  const seenAt = nowIso();
  state.value = {
    ...state.value,
    lastInteractionAt: seenAt,
  };
  if (!state.value.personPresent) {
    markPresent({
      source: "local_interaction",
      seenAt,
    });
    return;
  }
  restartInactivityTimer();
}

function applyProfileResult(
  payload: VisionProfileResultPayload,
  options: { suppressAudioCue?: boolean } = {},
): void {
  const personPresent =
    payload.profile.personPresent &&
    (payload.profile.confidence === undefined ||
      payload.profile.confidence >= PRESENCE_CONFIDENCE_THRESHOLD);
  if (!personPresent) {
    markDeparted({
      source: "vision",
      departedAt: payload.detectedAt,
      keepLastSeenAt: true,
    });
    return;
  }
  markPresent({
    source: "vision",
    seenAt: payload.detectedAt,
    suppressAudioCue: options.suppressAudioCue,
  });
}

function applyPresenceStatus(
  payload: VisionPresenceStatusPayload,
  options: { suppressAudioCue?: boolean } = {},
): void {
  if (!payload.personPresent) {
    markDeparted({
      source: "vision",
      departedAt: payload.detectedAt,
      keepLastSeenAt: true,
    });
    return;
  }
  markPresent({
    source: "vision",
    seenAt: payload.detectedAt,
    suppressAudioCue: options.suppressAudioCue,
  });
}

function applyPersonDeparted(payload: VisionPersonDepartedPayload): void {
  markDeparted({
    source: "vision",
    departedAt: payload.detectedAt,
    lastSeenAt: payload.lastSeenAt ?? state.value.lastSeenAt,
  });
}

function onLocalInteraction(): void {
  registerInteraction();
}

function installInteractionListeners(): void {
  if (typeof window === "undefined") return;
  window.addEventListener("pointerdown", onLocalInteraction, {
    passive: true,
    capture: true,
  });
  window.addEventListener("touchstart", onLocalInteraction, {
    passive: true,
    capture: true,
  });
  window.addEventListener("keydown", onLocalInteraction, { capture: true });
}

function removeInteractionListeners(): void {
  if (typeof window === "undefined") return;
  window.removeEventListener("pointerdown", onLocalInteraction, {
    capture: true,
  });
  window.removeEventListener("touchstart", onLocalInteraction, {
    capture: true,
  });
  window.removeEventListener("keydown", onLocalInteraction, { capture: true });
}

function startCustomerPresenceSession(
  options: PresenceInteractionOptions,
): void {
  if (started) return;
  started = true;
  activeOptions = optionsWithDefaults(options);
  const visionStore = useVisionStore();
  installInteractionListeners();
  stopVisionWatch = watch(
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
      const personDeparted = personDepartedFromDiagnostic(payload);
      if (personDeparted) {
        applyPersonDeparted(personDeparted);
        initializedFromCurrentDiagnostic = true;
        return;
      }
      markDeparted({
        source: "unavailable",
        departedAt: null,
        lastSeenAt: null,
      });
      initializedFromCurrentDiagnostic = true;
    },
    { immediate: true },
  );
}

export function resetCustomerPresenceSessionForTests(): void {
  stopVisionWatch?.();
  stopVisionWatch = null;
  clearStaleTimer();
  clearInactivityTimer();
  removeInteractionListeners();
  started = false;
  activeOptions = null;
  initializedFromCurrentDiagnostic = false;
  state.value = {
    personPresent: false,
    lastSeenAt: null,
    departedAt: null,
    lastInteractionAt: null,
    source: "unavailable",
  };
}

export function useCustomerPresenceSession(
  options: PresenceInteractionOptions = {},
): CustomerPresenceSession {
  startCustomerPresenceSession(options);
  onUnmounted(() => {
    // Session is intentionally app-scoped; component unmounts must not tear down
    // input listeners while another consumer still needs the same state.
  });
  return {
    state: readonly(state),
    presenceClass: readonly(presenceClass),
    registerInteraction,
  };
}

export function usePresenceInteraction(
  options: PresenceInteractionOptions = {},
): CustomerPresenceSession {
  return useCustomerPresenceSession(options);
}

export function useReturnHomeOnCustomerDeparture(
  options: {
    returnRoute?: RouteLocationRaw;
    routeNames?: Set<string>;
  } = {},
): void {
  const route = useRoute();
  const router = useRouter();
  const session = useCustomerPresenceSession();
  const routeNames = options.routeNames ?? RETURN_HOME_ROUTE_NAMES;
  const returnRoute = options.returnRoute ?? { name: "catalog" };

  watch(
    () => session.state.value.personPresent,
    (personPresent, wasPresent) => {
      if (personPresent || !wasPresent) return;
      const routeName =
        typeof route.name === "string" ? route.name : String(route.name ?? "");
      if (!routeNames.has(routeName)) return;
      void router.replace(returnRoute);
    },
  );
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

function personDepartedFromDiagnostic(
  value: unknown,
): VisionPersonDepartedPayload | null {
  if (
    typeof value !== "object" ||
    value === null ||
    !("type" in value) ||
    value.type !== "vision.person_departed" ||
    !("payload" in value)
  ) {
    return null;
  }
  const result = visionPersonDepartedPayloadSchema.safeParse(value.payload);
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

function millisecondsForDetectedAt(detectedAt: string): number {
  const parsed = Date.parse(detectedAt);
  return Number.isFinite(parsed) ? parsed : Date.now();
}
