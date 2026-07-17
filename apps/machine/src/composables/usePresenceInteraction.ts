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

import { useCheckoutStore } from "@/stores/checkout";
import { useNaturalContextStore } from "@/stores/natural-context";
import { useVisionStore } from "@/stores/vision";

import { recordCustomerSourceFact } from "./useCustomerEventSources";

const DEFAULT_PRESENCE_STALE_MS = 15_000;
const DEFAULT_CUSTOMER_ASSISTANCE_PROMPT_MS = 20_000;
const DEFAULT_INACTIVITY_DEPARTURE_MS = 45_000;
const RETURN_HOME_ROUTE_NAMES = new Set([
  "product-detail",
  "virtual-try-on",
  "checkout",
]);

const FESTIVAL_MAP: Record<string, string> = {
  spring_festival: "spring_festival",
  new_years_day: "new_years_day",
  lantern_festival: "lantern_festival",
  valentines_day: "valentines_day",
  qixi_festival: "qixi_festival",
  labor_day: "labor_day",
  dragon_boat_festival: "dragon_boat",
  mid_autumn_festival: "mid_autumn",
  national_day: "national_day",
};

const SOLAR_TERM_MAP: Record<string, string> = {
  minor_cold: "minor_cold",
  major_cold: "major_cold",
  start_of_spring: "start_of_spring",
  rain_water: "rain_water",
  awakening_of_insects: "awakening_of_insects",
  spring_equinox: "spring_equinox",
  clear_and_bright: "clear_and_bright",
  grain_rain: "grain_rain",
  start_of_summer: "start_of_summer",
  grain_buds: "grain_buds",
  grain_in_ear: "grain_in_ear",
  summer_solstice: "summer_solstice",
  minor_heat: "minor_heat",
  major_heat: "major_heat",
  start_of_autumn: "start_of_autumn",
  end_of_heat: "end_of_heat",
  white_dew: "white_dew",
  autumn_equinox: "autumn_equinox",
  cold_dew: "cold_dew",
  frost_descent: "frost_descent",
  start_of_winter: "start_of_winter",
  minor_snow: "minor_snow",
  major_snow: "major_snow",
  winter_solstice: "winter_solstice",
};

export function getContextualWelcomeVariant(
  naturalContextStore: ReturnType<typeof useNaturalContextStore>,
):
  | { type: "festival"; value: string }
  | { type: "solar_term"; value: string }
  | null {
  const calendar = naturalContextStore.calendar;
  if (!calendar) return null;

  if (calendar.primaryFestival) {
    const mapped = FESTIVAL_MAP[calendar.primaryFestival];
    if (mapped) return { type: "festival", value: mapped };
  }

  if (calendar.solarTerm) {
    const mapped = SOLAR_TERM_MAP[calendar.solarTerm];
    if (mapped) return { type: "solar_term", value: mapped };
  }

  return null;
}

export function getDepartureEventType(
  naturalContextStore: ReturnType<typeof useNaturalContextStore>,
):
  | "departure.bad_weather"
  | "departure.bad_air"
  | "departure.bad_forecast"
  | "departure.normal_weather"
  | null {
  if (!naturalContextStore.weatherReady) return null;

  const weather = naturalContextStore.snapshot?.externalEnvironment.weather;
  if (!weather) return null;

  if (naturalContextStore.hasHeavyRain) return "departure.bad_weather";
  if (naturalContextStore.hasLightRain) return "departure.bad_weather";
  if (naturalContextStore.isHighTemperature) return "departure.bad_weather";
  if (naturalContextStore.hasThunder) return "departure.bad_weather";
  if (naturalContextStore.hasSnow) return "departure.bad_weather";
  if (naturalContextStore.hasStrongWind) return "departure.bad_weather";

  if (naturalContextStore.isSunny) return "departure.normal_weather";
  if (naturalContextStore.isCloudy) return "departure.normal_weather";

  return null;
}

function isPrivacyMode(): boolean {
  const visionStore = useVisionStore();

  const now = new Date();
  const hours = now.getHours();
  const isNight = hours < 6 || hours >= 20;
  const crowdDetected = visionStore.presence.occupancyState === "multiple";

  return isNight || crowdDetected;
}

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
  customerAssistancePromptMs?: number;
  inactivityDepartureMs?: number;
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
let assistancePromptTimer: ReturnType<typeof setTimeout> | null = null;
let inactivityTimer: ReturnType<typeof setTimeout> | null = null;
let stopVisionWatch: WatchStopHandle | null = null;
let initializedFromCurrentDiagnostic = false;
let activeOptions: Required<PresenceInteractionOptions> | null = null;
let naturalContextStore: ReturnType<typeof useNaturalContextStore> | null =
  null;

function optionsWithDefaults(
  options: PresenceInteractionOptions,
): Required<PresenceInteractionOptions> {
  return {
    presenceStaleMs: options.presenceStaleMs ?? DEFAULT_PRESENCE_STALE_MS,
    customerAssistancePromptMs:
      options.customerAssistancePromptMs ??
      DEFAULT_CUSTOMER_ASSISTANCE_PROMPT_MS,
    inactivityDepartureMs:
      options.inactivityDepartureMs ?? DEFAULT_INACTIVITY_DEPARTURE_MS,
  };
}

function clearTimer(timer: ReturnType<typeof setTimeout> | null): null {
  if (timer !== null) clearTimeout(timer);
  return null;
}

function clearStaleTimer(): void {
  staleTimer = clearTimer(staleTimer);
}

function clearAssistancePromptTimer(): void {
  assistancePromptTimer = clearTimer(assistancePromptTimer);
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

function restartAssistancePromptTimer(): void {
  clearAssistancePromptTimer();
  if (!activeOptions || !state.value.personPresent) return;
  assistancePromptTimer = setTimeout(() => {
    recordCustomerSourceFact({
      type: "customer_session.idle",
      idleEvent: "assistance_prompt",
      occurredAt: nowIso(),
    });
  }, activeOptions.customerAssistancePromptMs);
}

function restartDepartureTimers(): void {
  restartAssistancePromptTimer();
  restartStaleTimer();
  restartInactivityTimer();
}

function markPresent(input: {
  source: Exclude<PresenceInteractionSource, "inactivity" | "unavailable">;
  seenAt: string;
}): void {
  state.value = {
    personPresent: true,
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
  suppressAudioCue?: boolean;
}): void {
  const wasPersonPresent = state.value.personPresent;
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
  clearAssistancePromptTimer();
  clearInactivityTimer();
  if (
    (input.source === "vision" || input.source === "inactivity") &&
    wasPersonPresent &&
    !input.suppressAudioCue
  ) {
    recordCustomerSourceFact({
      type: "customer_session.idle",
      idleEvent: "sleep",
      occurredAt: input.departedAt ?? nowIso(),
    });
  }
  if (
    input.source === "vision" &&
    wasPersonPresent &&
    !input.suppressAudioCue &&
    !isPrivacyMode() &&
    naturalContextStore
  ) {
    const departureEventType = getDepartureEventType(naturalContextStore);
    if (departureEventType) {
      recordCustomerSourceFact({
        type: "natural_context.cue",
        eventType: departureEventType,
        occurredAt: input.departedAt ?? nowIso(),
      });
    }
  }
  if (input.source === "vision") {
    recordCustomerSourceFact({
      type: "vision.presence",
      personPresent: false,
      occupancyState: "none",
      observedAt: input.departedAt ?? nowIso(),
    });
  }
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
    recordCustomerSourceFact({
      type: "local.awakened",
      requestedAt: seenAt,
    });
    return;
  }
  restartAssistancePromptTimer();
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
  naturalContextStore = useNaturalContextStore();
  installInteractionListeners();
  stopVisionWatch = watch(
    () => ({ ...visionStore.presence }),
    (presence) => {
      const suppressAudioCue =
        !initializedFromCurrentDiagnostic || presence.restoredFromRefresh;
      if (!presence.source) {
        markDeparted({
          source: "unavailable",
          departedAt: null,
          lastSeenAt: null,
        });
        initializedFromCurrentDiagnostic = true;
        return;
      }
      if (!presence.personPresent) {
        markDeparted({
          source: "vision",
          departedAt: presence.departedAt ?? presence.lastChangedAt,
          lastSeenAt: presence.lastSeenAt,
          keepLastSeenAt: presence.source !== "person_departed",
          suppressAudioCue,
        });
        initializedFromCurrentDiagnostic = true;
        return;
      }

      if (
        presence.source === "profile_result" &&
        presence.profileNotUsableReason === "low_confidence"
      ) {
        markDeparted({
          source: "vision",
          departedAt: presence.lastChangedAt,
          keepLastSeenAt: true,
          suppressAudioCue,
        });
        initializedFromCurrentDiagnostic = true;
        return;
      }

      const observedAt =
        presence.lastSeenAt ?? presence.lastChangedAt ?? nowIso();
      markPresent({
        source: "vision",
        seenAt: observedAt,
      });
      recordCustomerSourceFact({
        type: "vision.presence",
        personPresent: true,
        occupancyState: presence.occupancyState,
        observedAt,
        restored: suppressAudioCue,
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
  clearAssistancePromptTimer();
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
  const checkoutStore = useCheckoutStore();
  const routeNames = options.routeNames ?? RETURN_HOME_ROUTE_NAMES;
  const returnRoute = options.returnRoute ?? { name: "catalog" };

  watch(
    () => session.state.value.personPresent,
    (personPresent, wasPresent) => {
      if (personPresent || !wasPresent) return;
      if (checkoutStore.loading) return;
      if (checkoutStore.customerCheckoutView.stage !== "none") return;
      const routeName =
        typeof route.name === "string" ? route.name : String(route.name ?? "");
      if (
        routeName === "checkout" &&
        checkoutStore.selectedPaymentOptionKey !== null
      ) {
        return;
      }
      if (!routeNames.has(routeName)) return;
      void router.replace(returnRoute);
    },
  );
}
