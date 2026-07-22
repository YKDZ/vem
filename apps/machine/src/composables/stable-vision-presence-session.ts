import { readonly, ref, watch, type Ref, type WatchStopHandle } from "vue";

import { useVisionStore } from "@/stores/vision";

const ABSENCE_DEPARTURE_MS = 10_000;

export type StableVisionPresenceEdge = "arrival" | "departure" | null;

export type StableVisionPresenceState = {
  present: boolean;
  edge: StableVisionPresenceEdge;
  edgeId: string | null;
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
  lastSeenAt: null,
  departedAt: null,
});

let started = false;
let stopVisionWatch: WatchStopHandle | null = null;
let absenceTimer: ReturnType<typeof setTimeout> | null = null;
let epoch = 0;

function clearAbsenceTimer(): void {
  if (absenceTimer !== null) clearTimeout(absenceTimer);
  absenceTimer = null;
}

function arrive(lastSeenAt: string | null): void {
  clearAbsenceTimer();
  if (state.value.present) {
    state.value = { ...state.value, lastSeenAt };
    return;
  }
  epoch += 1;
  state.value = {
    present: true,
    edge: "arrival",
    edgeId: `vision-presence-${epoch}:arrival`,
    lastSeenAt,
    departedAt: null,
  };
}

function scheduleDeparture(departedAt: string | null): void {
  if (!state.value.present || absenceTimer !== null) return;
  absenceTimer = setTimeout(() => {
    absenceTimer = null;
    if (!state.value.present) return;
    epoch += 1;
    state.value = {
      ...state.value,
      present: false,
      edge: "departure",
      edgeId: `vision-presence-${epoch}:departure`,
      departedAt,
    };
  }, ABSENCE_DEPARTURE_MS);
}

function start(): void {
  if (started) return;
  started = true;
  const visionStore = useVisionStore();
  stopVisionWatch = watch(
    () => ({
      online: visionStore.online,
      enabled: visionStore.enabled,
      presence: { ...visionStore.presence },
    }),
    ({ online, enabled, presence }) => {
      // A missing Vision capability is not absence. Preserve the last stable
      // session until Vision emits a confirmed observation again.
      if (!enabled || !online || presence.source === null) return;
      if (presence.personPresent) {
        arrive(presence.lastSeenAt ?? presence.lastChangedAt);
        return;
      }
      // Profile quality controls recommendation only. It cannot end a
      // customer-presence session without an explicit absence observation.
      if (
        presence.source === "profile_result" &&
        presence.profileNotUsableReason === "low_confidence"
      ) {
        return;
      }
      scheduleDeparture(presence.departedAt ?? presence.lastChangedAt);
    },
    { immediate: true, flush: "sync" },
  );
}

export function getStableVisionPresenceSession(): StableVisionPresenceSession {
  start();
  return { state: readonly(state) };
}

export function resetStableVisionPresenceSessionForTests(): void {
  stopVisionWatch?.();
  stopVisionWatch = null;
  clearAbsenceTimer();
  started = false;
  epoch = 0;
  state.value = {
    present: false,
    edge: null,
    edgeId: null,
    lastSeenAt: null,
    departedAt: null,
  };
}
