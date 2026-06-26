<script setup lang="ts">
import { computed, onMounted, onUnmounted } from "vue";
import { useRouter } from "vue-router";

import PaymentQrCode from "@/components/PaymentQrCode.vue";
import { shouldShowMockPaymentControls } from "@/config/runtime-flags";
import { daemonClient } from "@/daemon/client";
import KioskLayout from "@/layouts/KioskLayout.vue";
import { resultKindFromNextAction, useCheckoutStore } from "@/stores/checkout";
import { useScannerStore } from "@/stores/scanner";
import { formatCents, formatCountdown } from "@/utils/format";
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
    <section v-if="order" class="flex h-full flex-col gap-5 text-neutral-950">
      <div class="rounded-lg border border-neutral-200 bg-white p-6">
        <p class="text-sm font-semibold tracking-[0.2em] text-neutral-500">
          支付
        </p>
        <div class="mt-2 flex items-start justify-between gap-4">
          <div>
            <h2 class="text-4xl font-black">{{ paymentCopy.title }}</h2>
            <p class="mt-2 text-neutral-600">{{ paymentCopy.subtitle }}</p>
          </div>
          <div class="text-right">
            <p class="text-sm text-neutral-500">剩余支付时间</p>
            <p class="text-4xl font-black">
              {{ remainingText }}
            </p>
          </div>
        </div>

        <div class="mt-6 grid grid-cols-[1.2fr_0.8fr] gap-5">
          <PaymentQrCode
            v-if="!isPaymentCode"
            :value="order.paymentUrl"
            :blocked="qrBlocked"
            :overlay-text="qrOverlayText"
            :empty-text="qrEmptyText"
          />
          <div
            v-else
            class="rounded-lg border border-neutral-200 bg-neutral-50 p-8 text-center"
          >
            <p class="text-sm font-semibold tracking-[0.2em] text-neutral-500">
              付款码
            </p>
            <h3 class="mt-3 text-3xl font-black">请出示付款码</h3>
            <div class="mt-6 rounded-lg border border-neutral-200 bg-white p-5">
              <p class="text-neutral-500">扫码状态</p>
              <p
                class="mt-2 text-xl font-black"
                :class="
                  scannerStore.online ? 'text-neutral-950' : 'text-neutral-500'
                "
              >
                {{ scannerStore.message }}
              </p>
              <p
                v-if="scannerStore.lastMaskedCode"
                class="mt-3 text-neutral-600"
              >
                已读取付款码
              </p>
              <p
                v-if="checkoutStore.paymentCodeMessage"
                class="mt-3 rounded-md border border-neutral-200 bg-neutral-50 p-3 text-neutral-700"
              >
                {{ checkoutStore.paymentCodeMessage }}
              </p>
              <RouterLink
                v-if="canUseDevScan"
                class="mt-4 inline-flex rounded-md border border-neutral-300 px-4 py-2 text-sm text-neutral-600"
                to="/dev/payment-code-scan"
              >
                手动扫码测试
              </RouterLink>
            </div>
          </div>
          <div class="rounded-lg border border-neutral-200 bg-neutral-50 p-5">
            <div class="flex h-full flex-col justify-between gap-6">
              <span class="text-neutral-500">应付金额</span>
              <strong class="text-5xl font-black">
                {{ formatCents(order.totalAmountCents) }}
              </strong>
            </div>
            <div>
              <p
                v-if="confirmingExpiredPayment"
                class="mt-5 rounded-md border border-neutral-200 bg-white p-4 text-neutral-700"
              >
                二维码已到期，系统正在向支付平台确认最终结果，请勿重复扫码或关闭页面。
                <span class="mt-3 block font-black text-neutral-950">
                  订单凭证 {{ order.orderNo }}
                </span>
              </p>
              <p
                v-else-if="preparingQrCode"
                class="mt-5 rounded-md border border-neutral-200 bg-white p-4 text-neutral-700"
              >
                支付平台正在同步订单，请等待二维码出现后再扫码。
              </p>
            </div>
          </div>
        </div>

        <p
          v-if="checkoutStore.error"
          class="mt-5 rounded-md border border-neutral-200 bg-neutral-50 p-4 text-neutral-800"
        >
          {{ checkoutStore.error }}
        </p>
      </div>

      <div class="mt-auto flex flex-col gap-4">
        <button
          class="kiosk-touch-target rounded-lg border border-neutral-300 bg-white px-6 py-5 text-xl font-black text-neutral-950 disabled:bg-neutral-200 disabled:text-neutral-500"
          type="button"
          :disabled="checkoutStore.loading"
          @click="cancelOrder"
        >
          {{ checkoutStore.loading ? "正在取消..." : "取消订单" }}
        </button>
        <div v-if="showMockControls" class="grid grid-cols-2 gap-4">
          <button
            class="kiosk-touch-target rounded-lg bg-neutral-950 px-6 py-5 text-xl font-black text-white disabled:bg-neutral-300 disabled:text-neutral-500"
            type="button"
            :disabled="checkoutStore.loading || expired"
            @click="simulateSuccess"
          >
            模拟支付成功
          </button>
          <button
            class="kiosk-touch-target col-span-2 rounded-lg border border-neutral-300 bg-white px-6 py-5 text-xl font-black text-neutral-950 disabled:bg-neutral-200 disabled:text-neutral-500"
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
