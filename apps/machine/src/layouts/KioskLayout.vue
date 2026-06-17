<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";
import { useRouter } from "vue-router";

const router = useRouter();
const MAINTENANCE_TAP_THRESHOLD = 7;
const MAINTENANCE_TAP_RESET_MS = 1600;

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
</script>

<template>
  <main class="kiosk-shell flex min-h-0 flex-col px-6 py-5">
    <header class="flex items-center justify-between gap-3">
      <div @click="handleMaintenanceTap">
        <p class="text-xs font-semibold tracking-[0.24em] text-neutral-500">
          汉麻衣物自动售货机
        </p>
        <h1 class="mt-1 text-2xl font-bold text-neutral-950">唐诗村</h1>
      </div>
    </header>

    <section
      class="kiosk-scroll mt-6 flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto pb-8"
    >
      <slot />
    </section>
  </main>
</template>
