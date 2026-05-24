<script setup lang="ts">
import { computed, ref } from "vue";
import { useRouter } from "vue-router";

import KioskLayout from "@/layouts/KioskLayout.vue";
import { useCheckoutStore } from "@/stores/checkout";
import { useMachineStore } from "@/stores/machine";

const router = useRouter();
const checkoutStore = useCheckoutStore();
const machineStore = useMachineStore();

const authCode = ref("");
const submitting = ref(false);

const orderNo = computed(() => checkoutStore.currentOrder?.orderNo ?? null);

function maskAuthCode(value: string): string {
  if (value.length <= 8) return value;
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

async function submit(): Promise<void> {
  if (!authCode.value.trim()) return;
  if (!orderNo.value) {
    await router.replace("/catalog");
    return;
  }
  submitting.value = true;
  checkoutStore.paymentCodeLastMasked = maskAuthCode(authCode.value.trim());
  await checkoutStore.submitScannedPaymentCode(
    machineStore.config,
    authCode.value.trim(),
    "browser_test",
  );
  submitting.value = false;
  await router.replace("/payment");
}
</script>

<template>
  <KioskLayout>
    <section
      class="mx-auto flex w-full max-w-3xl flex-col rounded-4xl border border-white/10 bg-white/10 p-8 text-white shadow-2xl"
    >
      <p class="text-sm tracking-[0.35em] text-emerald-200 uppercase">DEV</p>
      <h2 class="mt-3 text-3xl font-black">付款码模拟扫码</h2>
      <p class="mt-3 text-slate-300">
        仅开发环境可见。这里不会保存付款码，只会把输入内容直接提交到当前订单的付款码接口。
      </p>

      <div class="mt-6 rounded-3xl bg-slate-950/40 p-5">
        <p class="text-slate-300">当前订单</p>
        <p class="mt-2 text-xl font-black text-sky-100">
          {{ orderNo ?? "暂无待支付订单" }}
        </p>
      </div>

      <label class="mt-6 grid gap-2 text-left">
        <span class="text-sm font-semibold text-slate-200"
          >付款码 authCode</span
        >
        <input
          v-model="authCode"
          class="kiosk-touch-target rounded-2xl border border-white/10 bg-slate-950/70 px-4 py-4 text-white outline-none focus:border-sky-300"
          inputmode="numeric"
          placeholder="请输入 18 位左右付款码"
        />
      </label>

      <button
        class="kiosk-touch-target mt-6 rounded-2xl bg-emerald-400 px-6 py-4 text-lg font-black text-slate-950 shadow-lg shadow-emerald-950/40 disabled:bg-slate-500 disabled:text-slate-300"
        :disabled="submitting || !orderNo"
        type="button"
        @click="submit"
      >
        {{ submitting ? "正在提交付款码..." : "提交模拟扫码" }}
      </button>

      <p
        v-if="checkoutStore.error"
        class="mt-4 rounded-2xl bg-rose-500/20 p-4 text-rose-100"
      >
        {{ checkoutStore.error }}
      </p>
      <p
        v-else-if="checkoutStore.paymentCodeMessage"
        class="mt-4 rounded-2xl bg-sky-500/20 p-4 text-sky-100"
      >
        {{ checkoutStore.paymentCodeMessage }}
      </p>
    </section>
  </KioskLayout>
</template>
