import {
  computed,
  onUnmounted,
  readonly,
  ref,
  watch,
  type Ref,
  type WatchStopHandle,
} from "vue";

import { submitMachineNavigationIntent } from "@/router/transaction-route-authority";
import { useVisionStore } from "@/stores/vision";

const DEFAULT_PRESENCE_STALE_MS = 15_000;
const DEFAULT_INACTIVITY_DEPARTURE_MS = 45_000;
const DEFAULT_VISION_DEPARTURE_HYSTERESIS_MS = 3_000;

export type PresenceInteractionSource =
  | "vision"
  | "local_interaction"
  | "inactivity"
  | "unavailable";

export type PresenceInteractionState = {
  eventId: string | null;
  personPresent: boolean;
  occupancyState: "none" | "single" | "multiple" | "unknown";
  lastSeenAt: string | null;
  departedAt: string | null;
  lastInteractionAt: string | null;
  source: PresenceInteractionSource;
};

export type PresenceInteractionOptions = {
  presenceStaleMs?: number;
  inactivityDepartureMs?: number;
  visionDepartureHysteresisMs?: number;
};

type CustomerPresenceSession = {
  state: Readonly<Ref<PresenceInteractionState>>;
  presenceClass: Readonly<Ref<string>>;
  registerInteraction: () => void;
};

type MutableSessionState = Ref<PresenceInteractionState>;

const state = ref<PresenceInteractionState>({
  eventId: null,
  personPresent: false,
  occupancyState: "none",
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
let visionDepartureTimer: ReturnType<typeof setTimeout> | null = null;
let stopVisionWatch: WatchStopHandle | null = null;
let activeOptions: Required<PresenceInteractionOptions> | null = null;

function optionsWithDefaults(
  options: PresenceInteractionOptions,
): Required<PresenceInteractionOptions> {
  return {
    presenceStaleMs: options.presenceStaleMs ?? DEFAULT_PRESENCE_STALE_MS,
    inactivityDepartureMs:
      options.inactivityDepartureMs ?? DEFAULT_INACTIVITY_DEPARTURE_MS,
    visionDepartureHysteresisMs:
      options.visionDepartureHysteresisMs ??
      DEFAULT_VISION_DEPARTURE_HYSTERESIS_MS,
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

function clearVisionDepartureTimer(): void {
  visionDepartureTimer = clearTimer(visionDepartureTimer);
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

function markPresent(input: {
  source: Exclude<PresenceInteractionSource, "inactivity" | "unavailable">;
  seenAt: string;
  occupancyState?: PresenceInteractionState["occupancyState"];
  eventId?: string | null;
}): void {
  clearVisionDepartureTimer();
  state.value = {
    eventId: input.eventId ?? state.value.eventId,
    personPresent: true,
    occupancyState: input.occupancyState ?? state.value.occupancyState,
    lastSeenAt: input.seenAt,
    departedAt: null,
    lastInteractionAt: state.value.lastInteractionAt,
    source: input.source,
  };
  restartDepartureTimers();
}

function markDeparted(input: {
  source: Exclude<PresenceInteractionSource, "local_interaction">;
  departedAt: string | null;
  lastSeenAt?: string | null;
  keepLastSeenAt?: boolean;
  eventId?: string | null;
}): void {
  clearVisionDepartureTimer();
  state.value = {
    eventId: input.eventId ?? state.value.eventId,
    personPresent: false,
    occupancyState: "none",
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

function scheduleVisionDeparture(input: {
  departedAt: string | null;
  lastSeenAt?: string | null;
  keepLastSeenAt?: boolean;
  eventId?: string | null;
}): void {
  if (
    visionDepartureTimer !== null ||
    !state.value.personPresent ||
    !activeOptions
  ) {
    return;
  }
  visionDepartureTimer = setTimeout(() => {
    markDeparted({
      source: "vision",
      departedAt: input.departedAt,
      lastSeenAt: input.lastSeenAt,
      keepLastSeenAt: input.keepLastSeenAt,
      eventId: input.eventId,
    });
  }, activeOptions.visionDepartureHysteresisMs);
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
      occupancyState: "unknown",
      eventId: state.value.eventId,
    });
    return;
  }
  restartInactivityTimer();
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
    () => ({ ...visionStore.presence }),
    (presence) => {
      if (!presence.source) {
        markDeparted({
          source: "unavailable",
          departedAt: null,
          lastSeenAt: null,
          eventId: null,
        });
        return;
      }
      if (!presence.personPresent) {
        if (presence.source === "person_departed") {
          markDeparted({
            source: "vision",
            departedAt: presence.departedAt ?? presence.lastChangedAt,
            lastSeenAt: presence.lastSeenAt,
            eventId: presence.eventId,
          });
          return;
        }
        scheduleVisionDeparture({
          departedAt: presence.departedAt ?? presence.lastChangedAt,
          lastSeenAt: presence.lastSeenAt,
          keepLastSeenAt: true,
          eventId: presence.eventId,
        });
        return;
      }

      if (
        presence.source === "profile_result" &&
        presence.profileNotUsableReason === "low_confidence"
      ) {
        scheduleVisionDeparture({
          departedAt: presence.lastChangedAt,
          keepLastSeenAt: true,
          eventId: presence.eventId,
        });
        return;
      }

      const observedAt =
        presence.lastSeenAt ?? presence.lastChangedAt ?? nowIso();
      markPresent({
        source: "vision",
        seenAt: observedAt,
        occupancyState: presence.occupancyState,
        eventId: presence.eventId,
      });
    },
    { immediate: true, flush: "sync" },
  );
}

export function resetCustomerPresenceSessionForTests(): void {
  stopVisionWatch?.();
  stopVisionWatch = null;
  clearStaleTimer();
  clearInactivityTimer();
  clearVisionDepartureTimer();
  removeInteractionListeners();
  started = false;
  activeOptions = null;
  state.value = {
    eventId: null,
    personPresent: false,
    occupancyState: "none",
    lastSeenAt: null,
    departedAt: null,
    lastInteractionAt: null,
    source: "unavailable",
  };
}

export function useCustomerPresenceSession(
  options: PresenceInteractionOptions = {},
): CustomerPresenceSession {
  const session = getCustomerPresenceSession(options);
  onUnmounted(() => {
    // Session is intentionally app-scoped; component unmounts must not tear down
    // input listeners while another consumer still needs the same state.
  });
  return session;
}

export function getCustomerPresenceSession(
  options: PresenceInteractionOptions = {},
): CustomerPresenceSession {
  startCustomerPresenceSession(options);
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

export function installPresenceDepartureNavigation(
  options: PresenceInteractionOptions = {},
): void {
  const session = useCustomerPresenceSession(options);

  watch(
    () => ({
      personPresent: session.state.value.personPresent,
      source: session.state.value.source,
      eventId: session.state.value.eventId,
    }),
    (current, previous) => {
      if (current.personPresent) return;
      const explicitVisionDeparture =
        current.source === "vision" &&
        current.eventId !== null &&
        current.eventId !== previous?.eventId;
      if (!explicitVisionDeparture) return;
      void submitMachineNavigationIntent({
        type: "presence.departed",
        eventId: current.eventId,
      });
    },
  );
}
