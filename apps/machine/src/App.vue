<script setup lang="ts">
import { computed, onMounted, onUnmounted } from "vue";
import { RouterView, useRoute } from "vue-router";

import TouchKeyboard from "@/components/TouchKeyboard.vue";
import TransactionRecoveryBoundary from "@/components/TransactionRecoveryBoundary.vue";
import { installActiveTransactionSync } from "@/composables/useActiveTransactionSync";
import { installCustomerEventSources } from "@/composables/useCustomerEventSources";
import { installPresenceDepartureNavigation } from "@/composables/usePresenceInteraction";
import { installActiveUiDebugRuntimeScenario } from "@/dev/runtime-scenario-loader";
import { installInstalledKioskSaleRouteObserver } from "@/dev/ui-debug-daemon";
import { router } from "@/router";
import { submitMachineNavigationIntent } from "@/router/transaction-route-authority";
import { useSaleCapabilityStore } from "@/stores/sale-capability";

const route = useRoute();
const saleCapabilityStore = useSaleCapabilityStore();
const cleanupCustomerEventSources = installCustomerEventSources({
  routeName: computed(() => route.name),
});
const cleanupActiveTransactionSync = installActiveTransactionSync();
installPresenceDepartureNavigation();
installActiveUiDebugRuntimeScenario();
installInstalledKioskSaleRouteObserver(router);

onUnmounted(() => {
  saleCapabilityStore.stopRuntime();
  cleanupActiveTransactionSync();
  cleanupCustomerEventSources();
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
  saleCapabilityStore.startRuntime();
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
    <TouchKeyboard />
  </TransactionRecoveryBoundary>
</template>
