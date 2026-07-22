<script setup lang="ts">
import logoImage from "@/assets/home/logo.png";
import mascotTopImage from "@/assets/home/mascot-top-cutout.png";
import { useMaintenanceEntry } from "@/composables/useMaintenanceEntry";

const { handleMaintenanceTap } = useMaintenanceEntry();
</script>

<template>
  <main
    class="kiosk-shell flex min-h-0 flex-col px-[var(--machine-page-inline)] pt-[var(--machine-page-header-top)] pb-5"
  >
    <header class="flex items-center justify-between gap-3">
      <div
        class="flex items-center gap-3"
        data-test="maintenance-entry-header"
        @click="handleMaintenanceTap"
      >
        <img :src="logoImage" alt="唐诗村" />
        <img
          :src="mascotTopImage"
          alt=""
          class="h-14 w-14 object-contain"
          aria-hidden="true"
        />
      </div>
    </header>

    <section
      class="kiosk-scroll mt-6 flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto pb-8"
    >
      <slot />
    </section>
  </main>
</template>
