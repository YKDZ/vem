import { onBeforeUnmount, ref } from "vue";

import { submitMachineNavigationIntent } from "@/router/transaction-route-authority";

const MAINTENANCE_TAP_THRESHOLD = 7;
const MAINTENANCE_TAP_RESET_MS = 1600;
const MAINTENANCE_DUPLICATE_INPUT_IGNORE_MS = 500;

export function useMaintenanceEntry() {
  const maintenanceTapCount = ref(0);
  let maintenanceTapResetTimer: number | null = null;
  let lastPointerTapAtMs: number | null = null;

  function clearMaintenanceTapResetTimer(): void {
    if (maintenanceTapResetTimer !== null) {
      window.clearTimeout(maintenanceTapResetTimer);
      maintenanceTapResetTimer = null;
    }
  }

  function registerMaintenanceTap(): void {
    clearMaintenanceTapResetTimer();
    maintenanceTapCount.value += 1;
    if (maintenanceTapCount.value >= MAINTENANCE_TAP_THRESHOLD) {
      maintenanceTapCount.value = 0;
      void submitMachineNavigationIntent({
        type: "operator.navigate",
        target: { path: "/maintenance", query: { source: "operator" } },
      });
      return;
    }
    maintenanceTapResetTimer = window.setTimeout(() => {
      maintenanceTapCount.value = 0;
      maintenanceTapResetTimer = null;
    }, MAINTENANCE_TAP_RESET_MS);
  }

  function inputClockMs(): number {
    return globalThis.performance?.now() ?? Date.now();
  }

  function handleMaintenancePointerDown(): void {
    lastPointerTapAtMs = inputClockMs();
    registerMaintenanceTap();
  }

  function shouldIgnoreCompatibilityEvent(): boolean {
    if (lastPointerTapAtMs === null) return false;
    return (
      inputClockMs() - lastPointerTapAtMs <=
      MAINTENANCE_DUPLICATE_INPUT_IGNORE_MS
    );
  }

  function handleMaintenanceTap(): void {
    if (shouldIgnoreCompatibilityEvent()) return;
    registerMaintenanceTap();
  }

  onBeforeUnmount(clearMaintenanceTapResetTimer);

  return { handleMaintenancePointerDown, handleMaintenanceTap };
}
