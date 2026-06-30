<script setup lang="ts">
import { onMounted } from "vue";
import { RouterView, useRoute, useRouter } from "vue-router";

import { useReturnHomeOnCustomerDeparture } from "@/composables/usePresenceInteraction";

const route = useRoute();
const router = useRouter();
useReturnHomeOnCustomerDeparture();

onMounted(async () => {
  if (
    import.meta.env.DEV &&
    (route.path.startsWith("/dev/") ||
      window.location.hash.startsWith("#/dev/"))
  ) {
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
