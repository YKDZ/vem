<script setup lang="ts">
import { computed } from "vue";

import HardwareStatusBadge from "@/components/HardwareStatusBadge.vue";
import NetworkStatusBadge from "@/components/NetworkStatusBadge.vue";
import { useConnectivityStore } from "@/stores/connectivity";
import { useMachineStore } from "@/stores/machine";

const machineStore = useMachineStore();
const connectivityStore = useConnectivityStore();

const machineCodeLabel = computed(
  () => machineStore.machineCode ?? "未配置机器编号",
);
const hardwareMessage = computed(
  () => machineStore.health?.operatorReason ?? "硬件状态由 daemon 管理",
);
</script>

<template>
  <main class="kiosk-shell flex flex-col px-6 py-5">
    <header class="flex items-center justify-between gap-3">
      <div>
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

    <section class="mt-6 min-h-0 flex-1">
      <slot />
    </section>
  </main>
</template>
