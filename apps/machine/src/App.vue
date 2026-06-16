<script setup lang="ts">
import { onMounted } from "vue";
import { RouterView, useRoute, useRouter } from "vue-router";

const route = useRoute();
const router = useRouter();

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
