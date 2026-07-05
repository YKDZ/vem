<script setup lang="ts">
import { onMounted, onUnmounted } from "vue";
import { RouterView, useRoute, useRouter } from "vue-router";

import { installCustomerAudioCueEventSource } from "@/composables/useCustomerAudioCueEventSource";
import { useReturnHomeOnCustomerDeparture } from "@/composables/usePresenceInteraction";
import { installActiveUiDebugRuntimeScenario } from "@/dev/runtime-scenario-loader";

const route = useRoute();
const router = useRouter();
const cleanupCustomerAudioCueEventSource =
  installCustomerAudioCueEventSource();
useReturnHomeOnCustomerDeparture();
installActiveUiDebugRuntimeScenario();

onUnmounted(() => {
  cleanupCustomerAudioCueEventSource();
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
  <RouterView />
</template>
