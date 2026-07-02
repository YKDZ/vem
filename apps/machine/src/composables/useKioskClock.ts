import { computed, onMounted, onUnmounted, ref } from "vue";

const CLOCK_REFRESH_INTERVAL_MS = 30_000;

export function useKioskClock() {
  const now = ref(new Date());
  let clockTimer: number | null = null;

  const clockText = computed(() =>
    now.value.toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }),
  );
  const dateText = computed(
    () =>
      `${now.value.toLocaleDateString("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      })} ${now.value.toLocaleDateString("zh-CN", { weekday: "long" })}`,
  );

  onMounted(() => {
    now.value = new Date();
    clockTimer = window.setInterval(() => {
      now.value = new Date();
    }, CLOCK_REFRESH_INTERVAL_MS);
  });

  onUnmounted(() => {
    if (clockTimer !== null) {
      window.clearInterval(clockTimer);
      clockTimer = null;
    }
  });

  return { clockText, dateText };
}
