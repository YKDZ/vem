<script setup lang="ts">
import logoImage from "@/assets/home/logo.png";
import mascotTopImage from "@/assets/home/mascot-top-cutout.png";
import { useKioskClock } from "@/composables/useKioskClock";
import { useMaintenanceEntry } from "@/composables/useMaintenanceEntry";

const props = withDefaults(
  defineProps<{
    enableMaintenanceEntry?: boolean;
  }>(),
  {
    enableMaintenanceEntry: false,
  },
);

const { clockText, dateText } = useKioskClock();
const { handleMaintenanceTap } = useMaintenanceEntry();

function handleBrandClick(): void {
  if (!props.enableMaintenanceEntry) return;
  handleMaintenanceTap();
}
</script>

<template>
  <header class="kiosk-header">
    <div
      class="kiosk-header-brand"
      data-test="maintenance-entry-brand"
      @click="handleBrandClick"
    >
      <img :src="logoImage" alt="唐诗村" class="kiosk-header-logo" />
      <img
        :src="mascotTopImage"
        alt=""
        class="kiosk-header-mascot"
        aria-hidden="true"
      />
    </div>
    <div class="kiosk-header-time">
      <p>{{ clockText }}</p>
      <span>{{ dateText }}</span>
    </div>
  </header>
</template>

<style scoped>
.kiosk-header {
  display: flex;
  flex-shrink: 0;
  align-items: flex-start;
  justify-content: space-between;
}

.kiosk-header-brand {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.kiosk-header-logo {
  width: auto;
  height: clamp(36px, 5.9vw, 64px);
  object-fit: contain;
}

.kiosk-header-mascot {
  width: clamp(56px, 8.1vw, 88px);
  height: clamp(56px, 8.1vw, 88px);
  object-fit: contain;
}

.kiosk-header-time {
  color: #6f835f;
  text-align: right;
}

.kiosk-header-time p {
  font-family: Georgia, "Times New Roman", serif;
  font-size: clamp(2.25rem, 5.19vw, 3.5rem);
  font-weight: 700;
  line-height: 1;
}

.kiosk-header-time span {
  display: block;
  margin-top: clamp(0.25rem, 0.46vh, 0.55rem);
  font-size: clamp(0.75rem, 1.4vw, 0.95rem);
  letter-spacing: 0;
  white-space: nowrap;
}
</style>
