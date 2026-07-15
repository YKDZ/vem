<script setup lang="ts">
import { computed } from "vue";

import TransactionRecoveryOverlay from "@/components/TransactionRecoveryOverlay.vue";
import { useCheckoutStore } from "@/stores/checkout";

const checkoutStore = useCheckoutStore();
const recoveryActive = computed(
  () => checkoutStore.customerCheckoutRecovery.active,
);
</script>

<template>
  <div
    class="transaction-recovery-surface"
    data-test="transaction-surface"
    :inert="recoveryActive || undefined"
    :aria-hidden="recoveryActive ? 'true' : undefined"
  >
    <slot />
  </div>
  <TransactionRecoveryOverlay />
</template>

<style scoped>
.transaction-recovery-surface {
  width: 100%;
  height: 100%;
}
</style>
