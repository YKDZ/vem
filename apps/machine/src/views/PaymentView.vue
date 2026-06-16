<script setup lang="ts">
import { computed, onMounted, onUnmounted } from "vue";
import { useRouter } from "vue-router";

import PaymentQrCode from "@/components/PaymentQrCode.vue";
import { shouldShowMockPaymentControls } from "@/config/runtime-flags";
import { daemonClient } from "@/daemon/client";
import KioskLayout from "@/layouts/KioskLayout.vue";
import { resultKindFromNextAction, useCheckoutStore } from "@/stores/checkout";
import { useScannerStore } from "@/stores/scanner";
import {
  formatCents,
  formatCountdown,
  formatIsoDateTime,
} from "@/utils/format";
import { getPaymentProviderCopy } from "@/utils/payment-copy";

const router = useRouter();
const checkoutStore = useCheckoutStore();
const scannerStore = useScannerStore();

let pollTimer: number | undefined;
let clockTimer: number | undefined;

const order = computed(() => checkoutStore.currentOrder);
const status = computed(() => checkoutStore.status);
const remainingText = computed(() =>
  formatCountdown(checkoutStore.remainingSeconds),
);
const expired = computed(() => checkoutStore.remainingSeconds <= 0);
const isPaymentCode = computed(
  () => status.value?.payment.method === "payment_code",
);
const canUseDevScan = computed(
  () => import.meta.env.DEV && daemonClient.currentConnection?.mock === true,
);

const activeProviderCode = computed(
  () => checkoutStore.activePaymentProviderCode,
);
const paymentCopy = computed(() =>
  getPaymentProviderCopy(activeProviderCode.value),
);

const confirmingExpiredPayment = computed(
  () => expired.value && status.value?.nextAction === "wait_payment",
);
const preparingQrCode = computed(
  () =>
    !isPaymentCode.value &&
    status.value?.nextAction === "wait_payment" &&
    status.value.payment.status === "processing" &&
    !order.value?.paymentUrl,
);
const qrBlocked = computed(
  () =>
    expired.value || confirmingExpiredPayment.value || preparingQrCode.value,
);
const qrOverlayText = computed(() =>
  preparingQrCode.value
    ? "正在准备支付二维码"
    : confirmingExpiredPayment.value
      ? "正在确认支付结果"
      : expired.value
        ? "二维码已过期"
        : null,
);
const qrEmptyText = computed(() =>
  preparingQrCode.value ? "正在准备支付二维码，请稍候" : "暂无支付二维码",
);

const showMockControls = computed(
  () =>
    shouldShowMockPaymentControls({
      dev: import.meta.env.DEV,
      paymentMethod: status.value?.payment.method,
      flag: import.meta.env.VITE_ENABLE_MOCK_PAYMENT_CONTROLS,
    }) && daemonClient.currentConnection?.mock === true,
);

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
  await checkoutStore.refreshCurrentTransaction();
  await routeByStatus();
}

async function simulateSuccess(): Promise<void> {
  await checkoutStore.markMockSucceeded();
  await routeByStatus();
}

async function simulateFail(): Promise<void> {
  await checkoutStore.markMockFailed();
  await routeByStatus();
}

async function cancelOrder(): Promise<void> {
  try {
    await checkoutStore.cancelCurrentOrder();
    await router.replace("/catalog");
  } catch {
    // checkoutStore.error already carries the operator-facing message.
  }
}

onMounted(async () => {
  if (!order.value) {
    await router.replace("/catalog");
    return;
  }
  await refreshStatus();
  if (isPaymentCode.value) {
    await scannerStore.refresh();
  }
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
        class="rounded-4xl border border-white/10 bg-white/10 p-6 shadow-2xl"
      >
        <p class="text-sm tracking-[0.35em] text-sky-200 uppercase">PAYMENT</p>
        <div class="mt-2 flex items-start justify-between gap-4">
          <div>
            <h2 class="text-4xl font-black">{{ paymentCopy.title }}</h2>
            <p class="mt-2 text-slate-300">{{ paymentCopy.subtitle }}</p>
            <p class="mt-1 text-sm text-slate-400">订单 {{ order.orderNo }}</p>
          </div>
          <div class="text-right">
            <p class="text-sm text-slate-300">剩余支付时间</p>
            <p class="text-4xl font-black text-amber-200">
              {{ remainingText }}
            </p>
          </div>
        </div>

        <div class="mt-6 grid gap-5">
          <PaymentQrCode
            v-if="!isPaymentCode"
            :value="order.paymentUrl"
            :blocked="qrBlocked"
            :overlay-text="qrOverlayText"
            :empty-text="qrEmptyText"
          />
          <div
            v-else
            class="rounded-4xl border border-emerald-300/30 bg-emerald-400/10 p-8 text-center"
          >
            <p class="text-sm tracking-[0.3em] text-emerald-100 uppercase">
              PAYMENT CODE
            </p>
            <h3 class="mt-3 text-3xl font-black">请出示付款码</h3>
            <div class="mt-6 rounded-3xl bg-slate-950/45 p-5">
              <p class="text-slate-300">扫码模块</p>
              <p
                class="mt-2 text-xl font-black"
                :class="
                  scannerStore.online ? 'text-emerald-200' : 'text-amber-200'
                "
              >
                {{ scannerStore.message }}
              </p>
              <p v-if="scannerStore.port" class="mt-2 text-sm text-slate-400">
                端口：{{ scannerStore.port }}
              </p>
              <p v-if="scannerStore.lastMaskedCode" class="mt-3 text-slate-300">
                已读取：{{ scannerStore.lastMaskedCode }}
              </p>
              <p
                v-if="checkoutStore.paymentCodeMessage"
                class="mt-3 rounded-2xl bg-sky-400/10 p-3 text-sky-100"
              >
                {{ checkoutStore.paymentCodeMessage }}
              </p>
              <RouterLink
                v-if="canUseDevScan"
                class="mt-4 inline-flex rounded-2xl border border-white/15 px-4 py-2 text-sm text-white"
                to="/dev/payment-code-scan"
              >
                开发环境：手动模拟扫码
              </RouterLink>
            </div>
          </div>
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
            <p
              v-if="confirmingExpiredPayment"
              class="mt-3 rounded-2xl bg-amber-400/15 p-4 text-amber-100"
            >
              二维码已到期，系统正在向支付平台确认最终结果，请勿重复扫码或关闭页面。
            </p>
            <p
              v-else-if="preparingQrCode"
              class="mt-3 rounded-2xl bg-sky-400/15 p-4 text-sky-100"
            >
              支付平台正在同步订单，请等待二维码出现后再扫码。
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

      <div class="mt-auto flex flex-col gap-4">
        <button
          class="kiosk-touch-target rounded-3xl border border-white/20 px-6 py-5 text-xl font-black disabled:border-slate-500 disabled:text-slate-400"
          type="button"
          :disabled="checkoutStore.loading"
          @click="cancelOrder"
        >
          {{ checkoutStore.loading ? "正在取消..." : "取消订单" }}
        </button>
        <div v-if="showMockControls" class="grid grid-cols-2 gap-4">
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
      </div>
    </section>
  </KioskLayout>
</template>
