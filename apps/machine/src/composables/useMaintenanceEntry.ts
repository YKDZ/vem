import { onBeforeUnmount, ref } from "vue";
import { useRouter } from "vue-router";

const MAINTENANCE_TAP_THRESHOLD = 7;
const MAINTENANCE_TAP_RESET_MS = 1600;

export function useMaintenanceEntry() {
  const router = useRouter();
  const maintenanceTapCount = ref(0);
  let maintenanceTapResetTimer: number | null = null;

  function clearMaintenanceTapResetTimer(): void {
    if (maintenanceTapResetTimer !== null) {
      window.clearTimeout(maintenanceTapResetTimer);
      maintenanceTapResetTimer = null;
    }
  }

  function handleMaintenanceTap(): void {
    clearMaintenanceTapResetTimer();
    maintenanceTapCount.value += 1;
    if (maintenanceTapCount.value >= MAINTENANCE_TAP_THRESHOLD) {
      maintenanceTapCount.value = 0;
      void router.push({ path: "/maintenance", query: { source: "operator" } });
      return;
    }
    maintenanceTapResetTimer = window.setTimeout(() => {
      maintenanceTapCount.value = 0;
      maintenanceTapResetTimer = null;
    }, MAINTENANCE_TAP_RESET_MS);
  }

  onBeforeUnmount(clearMaintenanceTapResetTimer);

  return { handleMaintenanceTap };
}
