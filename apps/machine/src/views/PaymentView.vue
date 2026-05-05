<script setup lang="ts">
import { computed, onMounted, onUnmounted } from "vue";
import { useRouter } from "vue-router";

import PaymentQrCode from "@/components/PaymentQrCode.vue";
import KioskLayout from "@/layouts/KioskLayout.vue";
import { resultKindFromNextAction, useCheckoutStore } from "@/stores/checkout";
import { useMachineStore } from "@/stores/machine";
import {
  formatCents,
  formatCountdown,
  formatIsoDateTime,
} from "@/utils/format";

const router = useRouter();
const checkoutStore = useCheckoutStore();
const machineStore = useMachineStore();

let pollTimer: number | undefined;
let clockTimer: number | undefined;

const order = computed(() => checkoutStore.currentOrder);
const status = computed(() => checkoutStore.status);
const remainingText = computed(() =>
  formatCountdown(checkoutStore.remainingSeconds),
);
const expired = computed(() => checkoutStore.remainingSeconds <= 0);

async function routeByStatus(): Promise<void> {
  if (!status.value) return;
  if (status.value.nextAction === "dispensing") {
    await router.replace("/dispensing");
    return;
  }
  const resultKind = resultKindFromNextAction(status.value.nextAction);
  if (resultKind) {
    await router.replace({ name: "result", params: { kind: resultKind } });
  }
}

async function refreshStatus(): Promise<void> {
  await checkoutStore.refreshStatus(machineStore.config);
  await routeByStatus();
}

async function simulateSuccess(): Promise<void> {
  await checkoutStore.markMockSucceeded(machineStore.config);
  await routeByStatus();
}

async function simulateFail(): Promise<void> {
  await checkoutStore.markMockFailed(machineStore.config);
  await routeByStatus();
}

onMounted(async () => {
  if (!order.value) {
    await router.replace("/catalog");
    return;
  }
  await refreshStatus();
  pollTimer = window.setInterval(() => {
    void refreshStatus();
  }, 2_000);
  clockTimer = window.setInterval(() => {
    checkoutStore.tick();
  }, 1_000);
});

onUnmounted(() => {
  if (pollTimer) window.clearInterval(pollTimer);
  if (clockTimer) window.clearInterval(clockTimer);
});
</script>

<template>
  <KioskLayout>
    <section v-if="order" class="flex h-full flex-col gap-5 text-white">
      <div
        class="rounded-[2rem] border border-white/10 bg-white/10 p-6 shadow-2xl"
      >
        <p class="text-sm tracking-[0.35em] text-sky-200 uppercase">PAYMENT</p>
        <div class="mt-2 flex items-start justify-between gap-4">
          <div>
            <h2 class="text-4xl font-black">扫码支付</h2>
            <p class="mt-2 text-slate-300">订单 {{ order.orderNo }}</p>
          </div>
          <div class="text-right">
            <p class="text-sm text-slate-300">剩余支付时间</p>
            <p class="text-4xl font-black text-amber-200">
              {{ remainingText }}
            </p>
          </div>
        </div>

        <div class="mt-6 grid gap-5">
          <PaymentQrCode :value="order.paymentUrl" :expired="expired" />
          <div class="rounded-3xl bg-slate-950/45 p-5">
            <div class="flex items-center justify-between">
              <span class="text-slate-300">应付金额</span>
              <strong class="text-4xl font-black text-sky-200">
                {{ formatCents(order.totalAmountCents) }}
              </strong>
            </div>
            <p class="mt-3 text-sm text-slate-400">
              过期时间：{{ formatIsoDateTime(order.expiresAt) }}
            </p>
            <p class="mt-2 text-sm text-slate-400">
              当前状态：{{ status?.orderStatus ?? "查询中" }} /
              {{ status?.payment.status ?? "查询中" }}
            </p>
          </div>
        </div>

        <p
          v-if="checkoutStore.error"
          class="mt-5 rounded-2xl bg-rose-500/20 p-4 text-rose-100"
        >
          {{ checkoutStore.error }}
        </p>
      </div>

      <div class="mt-auto grid grid-cols-2 gap-4">
        <button
          class="kiosk-touch-target rounded-3xl border border-white/20 px-6 py-5 text-xl font-black"
          type="button"
          @click="router.replace('/catalog')"
        >
          取消返回
        </button>
        <button
          class="kiosk-touch-target rounded-3xl bg-sky-400 px-6 py-5 text-xl font-black text-slate-950 disabled:bg-slate-500 disabled:text-slate-300"
          type="button"
          :disabled="checkoutStore.loading || expired"
          @click="simulateSuccess"
        >
          模拟支付成功
        </button>
        <button
          class="kiosk-touch-target col-span-2 rounded-3xl bg-rose-400 px-6 py-5 text-xl font-black text-slate-950 disabled:bg-slate-500 disabled:text-slate-300"
          type="button"
          :disabled="checkoutStore.loading"
          @click="simulateFail"
        >
          模拟支付失败
        </button>
      </div>
    </section>
  </KioskLayout>
</template>
