<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
import { useRouter } from "vue-router";

import HardwareStatusBadge from "@/components/HardwareStatusBadge.vue";
import NetworkStatusBadge from "@/components/NetworkStatusBadge.vue";
import { useConnectivityStore } from "@/stores/connectivity";
import { useMachineStore } from "@/stores/machine";

const router = useRouter();
const machineStore = useMachineStore();
const connectivityStore = useConnectivityStore();
const MAINTENANCE_TAP_THRESHOLD = 7;
const MAINTENANCE_TAP_RESET_MS = 1600;

const machineCodeLabel = computed(
  () => machineStore.machineCode ?? "未配置机器编号",
);
const hardwareMessage = computed(
  () => machineStore.health?.operatorReason ?? "硬件状态由 daemon 管理",
);

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
        <p class="text-xs tracking-[0.32em] text-slate-400 uppercase">
          VEM KIOSK
        </p>
        <h1 class="mt-1 text-2xl font-bold text-white">
          {{ machineCodeLabel }}
        </h1>
      </div>
      <div class="flex flex-col items-end gap-2">
        <NetworkStatusBadge
          :label="connectivityStore.networkLabel"
          :online="connectivityStore.isSaleNetworkReady"
        />
        <HardwareStatusBadge
          :ready="machineStore.hardwareReady"
          :message="hardwareMessage"
        />
      </div>
    </header>

    <section
      class="kiosk-scroll mt-6 min-h-0 flex-1 overflow-x-hidden overflow-y-auto pb-8"
    >
      <slot />
    </section>
  </main>
</template>
