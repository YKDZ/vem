<script setup lang="ts">
import { computed } from "vue";

import { useCheckoutStore } from "@/stores/checkout";

const checkoutStore = useCheckoutStore();
const recovery = computed(() => checkoutStore.customerCheckoutRecovery);
</script>

<template>
  <div
    v-if="recovery.active"
    class="transaction-recovery-overlay"
    role="status"
    aria-live="assertive"
  >
    <div class="transaction-recovery-card">
      <span class="transaction-recovery-spinner" aria-hidden="true"></span>
      <strong>正在恢复本次交易</strong>
      <p>请勿离开或重复操作，交易状态恢复后将自动继续。</p>
      <small v-if="recovery.orderCredential">
        订单凭证 {{ recovery.orderCredential }}
      </small>
    </div>
  </div>
</template>

<style scoped>
.transaction-recovery-overlay {
  position: fixed;
  z-index: 2000;
  inset: 0;
  display: grid;
  place-items: center;
  background: rgb(15 23 42 / 55%);
  backdrop-filter: blur(4px);
}

.transaction-recovery-card {
  display: grid;
  width: min(32rem, calc(100vw - 3rem));
  justify-items: center;
  gap: 0.75rem;
  border: 1px solid rgb(255 255 255 / 30%);
  border-radius: 1.5rem;
  background: rgb(255 255 255 / 96%);
  padding: 2rem;
  color: #172554;
  text-align: center;
  box-shadow: 0 1.5rem 4rem rgb(15 23 42 / 35%);
}

.transaction-recovery-card strong {
  font-size: 1.5rem;
}

.transaction-recovery-card p,
.transaction-recovery-card small {
  margin: 0;
}

.transaction-recovery-spinner {
  width: 2.5rem;
  height: 2.5rem;
  border: 0.3rem solid #bfdbfe;
  border-top-color: #2563eb;
  border-radius: 999px;
  animation: transaction-recovery-spin 0.8s linear infinite;
}

@keyframes transaction-recovery-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
