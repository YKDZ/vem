<script setup lang="ts">
import { computed, onMounted, onUnmounted } from "vue";
import { RouterView, useRoute, useRouter } from "vue-router";

import ProtectedTouchKeyboard from "@/components/ProtectedTouchKeyboard.vue";
import TransactionRecoveryBoundary from "@/components/TransactionRecoveryBoundary.vue";
import { installCustomerEventSources } from "@/composables/useCustomerEventSources";
import { useReturnHomeOnCustomerDeparture } from "@/composables/usePresenceInteraction";
import { installActiveUiDebugRuntimeScenario } from "@/dev/runtime-scenario-loader";
import { maintenanceTouchKeyboardSession } from "@/touch-keyboard/maintenance-authorization";

const route = useRoute();
const router = useRouter();
const cleanupCustomerEventSources = installCustomerEventSources({
  routeName: computed(() => route.name),
});
useReturnHomeOnCustomerDeparture();
installActiveUiDebugRuntimeScenario();

onUnmounted(() => {
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

onMounted(async () => {
  if (isDevDirectRouteAllowed()) {
    return;
  }
  if (route.name !== "boot") {
    await router.replace({ name: "boot" });
  }
});
</script>

<template>
  <TransactionRecoveryBoundary>
    <RouterView />
    <ProtectedTouchKeyboard
      :route-name="typeof route.name === 'string' ? route.name : ''"
      :maintenance-session="maintenanceTouchKeyboardSession"
    />
  </TransactionRecoveryBoundary>
</template>
