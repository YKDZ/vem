import { onUnmounted, readonly, ref, type Ref } from "vue";

const DEFAULT_INACTIVITY_MS = 45_000;

export type CustomerInteractionState = {
  active: boolean;
  lastInteractionAt: string | null;
};

export type CustomerInteractionSession = {
  state: Readonly<Ref<CustomerInteractionState>>;
  registerInteraction: () => void;
};

const state = ref<CustomerInteractionState>({
  active: false,
  lastInteractionAt: null,
});

let started = false;
let inactivityTimer: ReturnType<typeof setTimeout> | null = null;

function clearInactivityTimer(): void {
  if (inactivityTimer !== null) clearTimeout(inactivityTimer);
  inactivityTimer = null;
}

function registerInteraction(): void {
  clearInactivityTimer();
  state.value = {
    active: true,
    lastInteractionAt: new Date().toISOString(),
  };
  inactivityTimer = setTimeout(() => {
    inactivityTimer = null;
    state.value = { ...state.value, active: false };
  }, DEFAULT_INACTIVITY_MS);
}

function installInteractionListeners(): void {
  if (typeof window === "undefined") return;
  window.addEventListener("pointerdown", registerInteraction, {
    passive: true,
    capture: true,
  });
  window.addEventListener("touchstart", registerInteraction, {
    passive: true,
    capture: true,
  });
  window.addEventListener("keydown", registerInteraction, { capture: true });
}

function removeInteractionListeners(): void {
  if (typeof window === "undefined") return;
  window.removeEventListener("pointerdown", registerInteraction, {
    capture: true,
  });
  window.removeEventListener("touchstart", registerInteraction, {
    capture: true,
  });
  window.removeEventListener("keydown", registerInteraction, { capture: true });
}

function start(): void {
  if (started) return;
  started = true;
  installInteractionListeners();
}

export function getCustomerInteractionSession(): CustomerInteractionSession {
  start();
  return { state: readonly(state), registerInteraction };
}

export function useCustomerInteractionSession(): CustomerInteractionSession {
  const session = getCustomerInteractionSession();
  onUnmounted(() => {
    // Input capture is application scoped and survives route component changes.
  });
  return session;
}

export function resetCustomerInteractionSessionForTests(): void {
  clearInactivityTimer();
  removeInteractionListeners();
  started = false;
  state.value = { active: false, lastInteractionAt: null };
}
