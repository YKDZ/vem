import type { Pinia } from "pinia";

import { readonly, ref, watch, type Ref, type WatchStopHandle } from "vue";

import { submitMachineNavigationIntent } from "@/router/transaction-route-authority";
import { useVisionStore } from "@/stores/vision";

const ABSENCE_DEPARTURE_MS = 5_000;
const OCCUPANCY_CONFIRMATION_MS = 1_000;
const MIN_OCCUPANCY_CONFIDENCE = 0.5;

export type StableVisionPresenceEdge = "arrival" | "departure" | null;

export type StableVisionPresenceState = {
  present: boolean;
  edge: StableVisionPresenceEdge;
  edgeId: string | null;
  occupancyState: "none" | "single" | "multiple";
  restored: boolean;
  lastSeenAt: string | null;
  departedAt: string | null;
};

export type StableVisionPresenceSession = {
  state: Readonly<Ref<StableVisionPresenceState>>;
};

const state = ref<StableVisionPresenceState>({
  present: false,
  edge: null,
  edgeId: null,
  occupancyState: "none",
  restored: false,
  lastSeenAt: null,
  departedAt: null,
});

let started = false;
let stopVisionWatch: WatchStopHandle | null = null;
let stopDepartureNavigationWatch: WatchStopHandle | null = null;
let absenceTimer: ReturnType<typeof setTimeout> | null = null;
let occupancyTimer: ReturnType<typeof setTimeout> | null = null;
let occupancyCandidate: {
  occupancyState: "single" | "multiple";
  lastSeenAt: string | null;
  restored: boolean;
} | null = null;
let epoch = 0;

function clearAbsenceTimer(): void {
  if (absenceTimer !== null) clearTimeout(absenceTimer);
  absenceTimer = null;
}

function clearOccupancyCandidate(): void {
  if (occupancyTimer !== null) clearTimeout(occupancyTimer);
  occupancyTimer = null;
  occupancyCandidate = null;
}

function confirmOccupancy(
  lastSeenAt: string | null,
  occupancyState: "single" | "multiple",
  restored: boolean,
): void {
  clearAbsenceTimer();
  if (state.value.present) {
    state.value = { ...state.value, lastSeenAt, occupancyState, restored };
    return;
  }
  epoch += 1;
  state.value = {
    present: true,
    edge: "arrival",
    edgeId: `presence-${epoch}:arrival`,
    occupancyState,
    restored,
    lastSeenAt,
    departedAt: null,
  };
}

function scheduleOccupancyConfirmation(
  lastSeenAt: string | null,
  occupancyState: "single" | "multiple",
  restored: boolean,
): void {
  clearAbsenceTimer();
  if (state.value.present && state.value.occupancyState === occupancyState) {
    clearOccupancyCandidate();
    state.value = { ...state.value, lastSeenAt, restored };
    return;
  }
  if (occupancyCandidate?.occupancyState === occupancyState) {
    occupancyCandidate = { occupancyState, lastSeenAt, restored };
    return;
  }

  clearOccupancyCandidate();
  occupancyCandidate = { occupancyState, lastSeenAt, restored };
  occupancyTimer = setTimeout(() => {
    occupancyTimer = null;
    const candidate = occupancyCandidate;
    occupancyCandidate = null;
    if (!candidate) return;
    confirmOccupancy(
      candidate.lastSeenAt,
      candidate.occupancyState,
      candidate.restored,
    );
  }, OCCUPANCY_CONFIRMATION_MS);
}

function scheduleDeparture(departedAt: string | null, restored: boolean): void {
  clearOccupancyCandidate();
  if (!state.value.present || absenceTimer !== null) return;
  absenceTimer = setTimeout(() => {
    absenceTimer = null;
    if (!state.value.present) return;
    epoch += 1;
    state.value = {
      ...state.value,
      present: false,
      edge: "departure",
      edgeId: `presence-${epoch}:departure`,
      occupancyState: "none",
      restored,
      departedAt,
    };
  }, ABSENCE_DEPARTURE_MS);
}

function start(pinia?: Pinia): void {
  if (started) return;
  started = true;
  const visionStore = useVisionStore(pinia);
  stopVisionWatch = watch(
    () => ({
      online: visionStore.online,
      enabled: visionStore.enabled,
      presence: { ...visionStore.presence },
    }),
    ({ online, enabled, presence }) => {
      // Missing capability or an uncertain occupancy observation is not
      // absence. It also invalidates an in-flight absence interval: the next
      // departure must be backed by five continuous seconds of confirmed input.
      if (
        !enabled ||
        !online ||
        presence.source === null ||
        presence.occupancyState === "unknown"
      ) {
        clearAbsenceTimer();
        clearOccupancyCandidate();
        return;
      }
      if (presence.personPresent) {
        if (
          presence.occupancyConfidence === null ||
          presence.occupancyConfidence < MIN_OCCUPANCY_CONFIDENCE ||
          (presence.occupancyState !== "single" &&
            presence.occupancyState !== "multiple")
        ) {
          clearAbsenceTimer();
          clearOccupancyCandidate();
          return;
        }
        scheduleOccupancyConfirmation(
          presence.lastSeenAt ?? presence.lastChangedAt,
          presence.occupancyState,
          presence.restoredFromRefresh,
        );
        return;
      }
      if (
        presence.source !== "person_departed" &&
        (presence.occupancyConfidence === null ||
          presence.occupancyConfidence < MIN_OCCUPANCY_CONFIDENCE)
      ) {
        clearAbsenceTimer();
        clearOccupancyCandidate();
        return;
      }
      scheduleDeparture(
        presence.departedAt ?? presence.lastChangedAt,
        presence.restoredFromRefresh,
      );
    },
    { immediate: true, flush: "sync" },
  );
}

export function getStableVisionPresenceSession(
  pinia?: Pinia,
): StableVisionPresenceSession {
  start(pinia);
  return { state: readonly(state) };
}

export function installStableVisionPresenceDepartureNavigation(): void {
  if (stopDepartureNavigationWatch) return;
  const session = getStableVisionPresenceSession();
  stopDepartureNavigationWatch = watch(
    () => ({
      edge: session.state.value.edge,
      edgeId: session.state.value.edgeId,
    }),
    ({ edge, edgeId }) => {
      if (edge !== "departure" || !edgeId) return;
      void submitMachineNavigationIntent({
        type: "presence.departed",
        eventId: edgeId,
      });
    },
    { flush: "sync" },
  );
}

export function resetStableVisionPresenceSessionForTests(): void {
  stopDepartureNavigationWatch?.();
  stopDepartureNavigationWatch = null;
  stopVisionWatch?.();
  stopVisionWatch = null;
  clearAbsenceTimer();
  clearOccupancyCandidate();
  started = false;
  epoch = 0;
  state.value = {
    present: false,
    edge: null,
    edgeId: null,
    occupancyState: "none",
    restored: false,
    lastSeenAt: null,
    departedAt: null,
  };
}
