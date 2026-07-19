<script setup lang="ts">
import { getActivePinia } from "pinia";
import { onMounted, onUnmounted } from "vue";
import { RouterView, useRoute } from "vue-router";

import TransactionRecoveryBoundary from "@/components/TransactionRecoveryBoundary.vue";
import { installActiveTransactionSync } from "@/composables/useActiveTransactionSync";
import { installPresenceDepartureNavigation } from "@/composables/usePresenceInteraction";
import { installActiveUiDebugRuntimeScenario } from "@/dev/runtime-scenario-loader";
import { installInstalledKioskSaleRouteObserver } from "@/dev/ui-debug-daemon";
import { router } from "@/router";
import { submitMachineNavigationIntent } from "@/router/transaction-route-authority";
import {
  startMachineRuntime,
  stopMachineRuntime,
} from "@/runtime/machine-runtime";

const route = useRoute();
const pinia = getActivePinia();
if (!pinia)
  throw new Error("Machine runtime requires an active Pinia instance");
const cleanupActiveTransactionSync = installActiveTransactionSync();
installPresenceDepartureNavigation();
installActiveUiDebugRuntimeScenario();
installInstalledKioskSaleRouteObserver(router);

onUnmounted(async () => {
  cleanupActiveTransactionSync();
  await stopMachineRuntime(pinia);
});

function isDevDirectRouteAllowed(): boolean {
  if (!import.meta.env.DEV) return false;
  if (
    route.path.startsWith("/dev/") ||
    window.location.hash.startsWith("#/dev/")
  ) {
    return true;
  }
  try {
    if (window.localStorage.getItem("vem.machine.uiDebug.enabled") === "1") {
      return true;
    }
  } catch {
    return false;
  }
  return new URLSearchParams(window.location.search).get("uiDebug") === "1";
}

onMounted(() => {
  startMachineRuntime(pinia);
  if (isDevDirectRouteAllowed()) {
    return;
  }
  if (route.name !== "boot") {
    void submitMachineNavigationIntent({
      type: "startup.navigate",
      target: { name: "boot" },
    });
  }
});
</script>

<template>
  <TransactionRecoveryBoundary>
    <RouterView />
  </TransactionRecoveryBoundary>
</template>
