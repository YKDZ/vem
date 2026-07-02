<script setup lang="ts">
import { computed, onMounted, onUnmounted } from "vue";
import { useRouter } from "vue-router";

import listSloganImage from "@/assets/home/list-slogan.png";
import logoImage from "@/assets/home/logo.png";
import mascotListImage from "@/assets/home/mascot-list.png";
import mascotTopImage from "@/assets/home/mascot-top-cutout.png";
import PaymentQrCode from "@/components/PaymentQrCode.vue";
import { useMaintenanceEntry } from "@/composables/useMaintenanceEntry";
import { shouldShowMockPaymentControls } from "@/config/runtime-flags";
import { daemonClient } from "@/daemon/client";
import KioskLayout from "@/layouts/KioskLayout.vue";
import { resultKindFromNextAction, useCheckoutStore } from "@/stores/checkout";
import { useScannerStore } from "@/stores/scanner";
import { formatCents, formatCountdown } from "@/utils/format";

const router = useRouter();
const checkoutStore = useCheckoutStore();
const scannerStore = useScannerStore();
const { handleMaintenanceTap } = useMaintenanceEntry();

let pollTimer: number | undefined;
let clockTimer: number | undefined;

const order = computed(() => checkoutStore.currentOrder);
const status = computed(() => checkoutStore.status);
const orderCredential = computed(
  () =>
    checkoutStore.currentOrder?.orderNo ??
    checkoutStore.status?.orderNo ??
    null,
);
const remainingText = computed(() =>
  formatCountdown(checkoutStore.remainingSeconds),
);
const expired = computed(() => checkoutStore.remainingSeconds <= 0);
const isPaymentCode = computed(
  () => status.value?.payment.method === "payment_code",
);
const paymentCodeStatusTitle = computed(() => {
  if (scannerStore.lastMaskedCode) return "已读取付款码";
  return scannerStore.online ? "扫码器已就绪" : "扫码器暂不可用";
});
const paymentCodeStatusCopy = computed(() => {
  if (scannerStore.lastMaskedCode) return "正在确认支付结果，请稍候。";
  return scannerStore.online
    ? "请打开支付宝或微信付款码，靠近设备扫码窗口。"
    : "请稍后重试，或返回选择二维码支付。";
});
const canUseDevScan = computed(
  () => import.meta.env.DEV && daemonClient.currentConnection?.mock === true,
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
const activePaymentCodeAttemptStatus = computed(
  () => status.value?.paymentCodeAttempt?.status ?? null,
);
const paymentCodeCancelBlocked = computed(() =>
  [
    "submitting",
    "user_confirming",
    "querying",
    "reversing",
    "unknown",
    "manual_handling",
    "succeeded",
  ].includes(activePaymentCodeAttemptStatus.value ?? ""),
);
const canCancelOrder = computed(() => {
  if (!status.value) return false;
  if (checkoutStore.loading) return false;
  if (confirmingExpiredPayment.value) return false;
  if (status.value.nextAction !== "wait_payment") return false;
  if (status.value.orderStatus !== "pending_payment") return false;
  if (
    !["created", "pending", "processing"].includes(status.value.payment.status)
  ) {
    return false;
  }
  if (isPaymentCode.value && paymentCodeCancelBlocked.value) return false;
  return true;
});
const cancelOrderDisabledReason = computed(() => {
  if (checkoutStore.loading) return "正在同步订单状态";
  if (confirmingExpiredPayment.value) return "支付结果确认中，暂不可取消";
  if (isPaymentCode.value && paymentCodeCancelBlocked.value) {
    return "付款码支付处理中，暂不可取消";
  }
  if (status.value?.nextAction !== "wait_payment") return "订单已进入下一阶段";
  if (status.value?.orderStatus !== "pending_payment")
    return "当前订单不可取消";
  if (
    status.value &&
    !["created", "pending", "processing"].includes(status.value.payment.status)
  ) {
    return "当前支付状态不可取消";
  }
  return null;
});

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
  const catalogKey = checkoutStore.selectedItem?.catalogKey ?? null;
  try {
    await checkoutStore.cancelCurrentOrder({ preserveSelectedItem: true });
    if (catalogKey) {
      await router.replace({
        name: "product-detail",
        params: { catalogKey },
      });
    } else {
      await router.replace("/catalog");
    }
  } catch {
    // checkoutStore.error already carries the operator-facing message.
  }
}

onMounted(async () => {
  if (!order.value) {
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
    <section v-if="order" class="payment-page">
      <div class="payment-mist payment-mist-left"></div>
      <div class="payment-mist payment-mist-right"></div>

      <header class="payment-header">
        <div class="flex items-center gap-3" @click="handleMaintenanceTap">
          <img
            :src="logoImage"
            alt="唐诗村"
            class="h-9 w-auto object-contain"
          />
          <img
            :src="mascotTopImage"
            alt=""
            class="h-14 w-14 object-contain"
            aria-hidden="true"
          />
        </div>
        <div class="text-right text-[#6f835f]">
          <p class="font-serif text-4xl leading-none font-bold">10:30</p>
          <p class="mt-1 text-xs tracking-wide">2026/06/15　星期二</p>
        </div>
      </header>

      <div class="payment-title">
        <h1>订单支付</h1>
        <span aria-hidden="true"></span>
      </div>

      <main class="payment-card">
        <p class="payment-amount-label">应付金额</p>
        <strong class="payment-amount">
          {{ formatCents(order.totalAmountCents) }}
        </strong>

        <div class="qr-shell" :class="{ 'payment-code-shell': isPaymentCode }">
          <PaymentQrCode
            v-if="!isPaymentCode"
            :value="order.paymentUrl"
            :blocked="qrBlocked"
            :overlay-text="qrOverlayText"
            :empty-text="qrEmptyText"
          />
          <div v-else class="payment-code-panel">
            <span class="payment-code-icon" aria-hidden="true">
              <svg viewBox="0 0 48 48">
                <path
                  d="M14 8h20a4 4 0 0 1 4 4v24a4 4 0 0 1-4 4H14a4 4 0 0 1-4-4V12a4 4 0 0 1 4-4Z"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2.8"
                />
                <path
                  d="M17 16h6M17 23h14M17 30h8M31 31l3 3 6-7"
                  fill="none"
                  stroke="currentColor"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2.8"
                />
              </svg>
            </span>
            <h2>{{ paymentCodeStatusTitle }}</h2>
            <p>{{ paymentCodeStatusCopy }}</p>
            <p v-if="checkoutStore.paymentCodeMessage">
              {{ checkoutStore.paymentCodeMessage }}
            </p>
            <RouterLink v-if="canUseDevScan" to="/dev/payment-code-scan">
              手动扫码测试
            </RouterLink>
          </div>
        </div>

        <p class="qr-instruction">
          {{
            isPaymentCode
              ? "请将付款码靠近扫码窗口完成支付"
              : "请使用微信 / 支付宝扫码支付"
          }}
        </p>

        <p v-if="confirmingExpiredPayment" class="payment-hint">
          二维码已到期，系统正在向支付平台确认最终结果，请勿重复扫码或关闭页面。
          <span v-if="orderCredential" class="payment-order-credential">
            订单凭证 {{ orderCredential }}
          </span>
        </p>
        <p v-else-if="preparingQrCode" class="payment-hint">
          支付平台正在同步订单，请等待二维码出现后再扫码。
        </p>

        <p class="payment-countdown-label">剩余支付时间</p>
        <p class="payment-countdown">{{ remainingText }}</p>
        <p class="payment-expire-copy">
          请在倒计时结束前完成支付，超时订单将自动取消
        </p>

        <p v-if="checkoutStore.error" class="payment-hint">
          {{ checkoutStore.error }}
        </p>
      </main>

      <section class="payment-steps">
        <div class="payment-step payment-step-active">
          <span aria-hidden="true">
            <svg viewBox="0 0 32 32">
              <path
                d="M8 8h6M18 8h6M8 24h6M18 24h6M8 14h16M8 19h16"
                fill="none"
                stroke="currentColor"
                stroke-linecap="round"
                stroke-width="2"
              />
            </svg>
          </span>
          <p>扫码支付</p>
        </div>
        <i></i>
        <div class="payment-step">
          <span aria-hidden="true">
            <svg viewBox="0 0 32 32">
              <path
                d="M16 7v10l6 4"
                fill="none"
                stroke="currentColor"
                stroke-linecap="round"
                stroke-width="2"
              />
              <circle
                cx="16"
                cy="16"
                r="10"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              />
            </svg>
          </span>
          <p>支付中</p>
        </div>
        <i></i>
        <div class="payment-step">
          <span aria-hidden="true">
            <svg viewBox="0 0 32 32">
              <path
                d="m9 16 5 5 9-10"
                fill="none"
                stroke="currentColor"
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2.3"
              />
            </svg>
          </span>
          <p>支付成功</p>
        </div>
      </section>

      <section class="payment-cancel-section">
        <button
          class="payment-cancel-button kiosk-touch-target"
          type="button"
          :disabled="!canCancelOrder"
          @click="cancelOrder"
        >
          取消订单
        </button>
        <p v-if="cancelOrderDisabledReason" class="payment-cancel-hint">
          {{ cancelOrderDisabledReason }}
        </p>
      </section>

      <footer class="payment-footer">
        <div class="payment-help">？ 支付遇到问题？ 联系客服</div>
      </footer>

      <div v-if="showMockControls" class="payment-mock-controls">
        <button
          type="button"
          :disabled="checkoutStore.loading || expired"
          @click="simulateSuccess"
        >
          模拟支付成功
        </button>
        <button
          type="button"
          :disabled="checkoutStore.loading"
          @click="simulateFail"
        >
          模拟支付失败
        </button>
      </div>

      <img
        :src="mascotListImage"
        alt=""
        class="payment-mascot pointer-events-none"
        aria-hidden="true"
      />
      <img
        :src="listSloganImage"
        alt="让温柔贴近 让善意发生"
        class="payment-slogan pointer-events-none"
      />
    </section>
    <section v-else class="payment-empty-state">
      <div>
        <h1>支付状态已失效</h1>
        <p>当前订单信息已更新或已结束，请返回商品列表重新选择。</p>
        <button
          class="kiosk-touch-target"
          type="button"
          @click="router.replace('/catalog')"
        >
          返回商品列表
        </button>
      </div>
    </section>
  </KioskLayout>
</template>

<style scoped>
:global(.kiosk-shell:has(.payment-page) > header) {
  display: none;
}

:global(.kiosk-shell:has(.payment-page) > .kiosk-scroll) {
  margin-top: 0;
  padding-bottom: 0;
}

:global(.kiosk-shell:has(.payment-empty-state) > header) {
  display: none;
}

.payment-empty-state {
  display: grid;
  min-height: 100%;
  place-items: center;
  color: #5c554c;
  text-align: center;
}

.payment-empty-state > div {
  width: min(100%, 28rem);
  border: 1px solid rgba(211, 203, 180, 0.82);
  border-radius: 20px;
  background: rgba(255, 253, 248, 0.76);
  padding: 2.4rem;
}

.payment-empty-state h1 {
  font-size: 2rem;
  font-weight: 800;
}

.payment-empty-state p {
  margin-top: 0.8rem;
  color: #746d63;
}

.payment-empty-state button {
  margin-top: 1.6rem;
  border-radius: 999px;
  background: #6f835f;
  padding: 0.9rem 1.8rem;
  color: #fffdf8;
  font-weight: 800;
}

.payment-page {
  position: relative;
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  align-items: center;
  container-type: inline-size;
  overflow: hidden;
  margin: 0;
  padding: var(--machine-page-header-top) var(--machine-page-inline) 1rem;
  border: 0;
  border-radius: 0;
  background:
    radial-gradient(
      circle at 0% 4%,
      rgba(141, 157, 118, 0.14),
      transparent 32%
    ),
    radial-gradient(
      circle at 100% 0%,
      rgba(210, 196, 151, 0.12),
      transparent 30%
    ),
    linear-gradient(180deg, #fffdf8 0%, #fbf7eb 62%, #f6f0df 100%);
  color: #5c554c;
  box-shadow: none;
}

.payment-header {
  position: relative;
  z-index: 5;
  display: flex;
  width: 100%;
  flex-shrink: 0;
  align-items: center;
  justify-content: space-between;
}

.payment-title {
  display: none;
}

.payment-title h1 {
  color: #4c463f;
  font-family: SimSun, "Songti SC", "Noto Serif CJK SC", serif;
  font-size: 2.1rem;
  font-weight: 700;
  letter-spacing: 0.12em;
}

.payment-title span {
  display: block;
  width: 5.2rem;
  height: 1.1rem;
  margin: 0.8rem auto 0;
  background: url("data:image/svg+xml,%3Csvg width='92' height='18' viewBox='0 0 92 18' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' stroke='%23c9b989' stroke-width='1.7'%3E%3Cpath d='M42 9h44'/%3E%3Cpath d='M50 13c15 0 21-8 5-8' stroke-linecap='round'/%3E%3Cpath d='M15 4c5 0 9 4 9 9M15 4c-5 0-9 4-9 9M15 4c0-5-4-7-7-1M15 4c0-5 4-7 7-1'/%3E%3C/g%3E%3C/svg%3E")
    center / contain no-repeat;
}

.payment-card {
  position: relative;
  z-index: 4;
  width: min(100%, 34.6rem);
  min-height: 36.8rem;
  margin: 1.05rem auto 0;
  border: 1px solid rgba(211, 203, 180, 0.88);
  border-radius: 20px;
  background:
    radial-gradient(
      circle at 50% 16%,
      rgba(255, 250, 242, 0.92),
      transparent 42%
    ),
    rgba(255, 253, 248, 0.58);
  padding: 2.1rem 2rem 1.9rem;
  text-align: center;
  box-shadow: 0 18px 36px rgba(102, 92, 64, 0.08);
}

.payment-amount-label,
.payment-countdown-label {
  color: #706a60;
  font-size: 1.05rem;
}

.payment-amount {
  display: block;
  margin-top: 0.7rem;
  color: #6f835f;
  font-family: Georgia, "Times New Roman", serif;
  font-size: 3rem;
  line-height: 1;
}

.qr-shell {
  width: min(100%, 18rem);
  margin: 2rem auto 0;
}

.qr-shell.payment-code-shell {
  width: min(100%, 26rem);
  margin-top: 1.8rem;
}

.qr-shell :deep(> div) {
  border: 1px solid rgba(211, 203, 180, 0.82);
  border-radius: 18px;
  background: rgba(255, 255, 255, 0.84);
  padding: 1.85rem 1.7rem 1.25rem;
  box-shadow: 0 10px 24px rgba(102, 92, 64, 0.07);
}

.qr-shell :deep(img),
.qr-shell :deep(.size-\[320px\]) {
  width: min(100%, 14.3rem);
  height: min(100vw, 14.3rem);
  max-height: 14.3rem;
}

.qr-shell.payment-code-shell :deep(> div) {
  border: 0;
  border-radius: 0;
  background: transparent;
  padding: 0;
  box-shadow: none;
}

.qr-instruction {
  margin-top: 0.9rem;
  color: #4f4a43;
  font-size: 1rem;
}

.payment-countdown-label {
  margin-top: 2.35rem;
}

.payment-countdown {
  margin-top: 0.55rem;
  color: #6f835f;
  font-family: Georgia, "Times New Roman", serif;
  font-size: 2.25rem;
  line-height: 1;
}

.payment-expire-copy {
  margin-top: 1.25rem;
  color: #827b70;
  font-size: 0.95rem;
}

.payment-hint {
  margin: 1rem auto 0;
  max-width: 32rem;
  border: 1px solid rgba(211, 203, 180, 0.82);
  border-radius: 12px;
  background: rgba(255, 253, 248, 0.72);
  padding: 0.8rem 1rem;
  color: #6d665b;
}

.payment-order-credential {
  display: block;
  margin-top: 0.55rem;
  color: #4f4a43;
  font-weight: 800;
}

.payment-code-panel {
  display: grid;
  min-height: 13.5rem;
  justify-items: center;
  align-content: center;
  gap: 0.75rem;
  color: #6d665b;
}

.payment-code-icon {
  display: grid;
  width: 5.4rem;
  height: 5.4rem;
  place-items: center;
  border: 1px solid rgba(111, 131, 95, 0.25);
  border-radius: 999px;
  background: rgba(111, 131, 95, 0.08);
  color: #6f835f;
}

.payment-code-icon svg {
  width: 3.1rem;
  height: 3.1rem;
}

.payment-code-panel h2 {
  margin: 0;
  color: #4f6248;
  font-size: 1.35rem;
  font-weight: 900;
}

.payment-code-panel p {
  max-width: 19rem;
  margin: 0;
  color: #756e64;
  font-size: 0.98rem;
  line-height: 1.55;
}

.payment-code-panel a {
  border: 1px solid rgba(211, 203, 180, 0.82);
  border-radius: 999px;
  padding: 0.5rem 1rem;
}

.payment-steps {
  position: relative;
  z-index: 4;
  display: grid;
  width: min(100%, 34rem);
  grid-template-columns: 1fr 1fr 1fr 1fr 1fr;
  align-items: center;
  margin: 2.25rem auto 0;
  border: 1px solid rgba(211, 203, 180, 0.88);
  border-radius: 18px;
  background: rgba(255, 253, 248, 0.68);
  padding: 0.95rem 3rem 0.85rem;
}

.payment-step {
  text-align: center;
}

.payment-step span {
  display: grid;
  width: 50px;
  height: 50px;
  margin: 0 auto 0.45rem;
  place-items: center;
  border: 1px solid rgba(211, 203, 180, 0.86);
  border-radius: 999px;
  color: #9b9589;
}

.payment-step span svg {
  width: 32px;
  height: 32px;
}

.payment-step-active span {
  border-color: transparent;
  background: linear-gradient(180deg, #758868, #627655);
  color: #fffdf7;
}

.payment-step p {
  color: #746d63;
  font-size: 0.95rem;
}

.payment-steps i {
  display: block;
  height: 1px;
  border-top: 1px dashed #d8cfb9;
}

.payment-cancel-section {
  position: relative;
  z-index: 5;
  display: grid;
  width: min(100%, 34rem);
  margin: 1.4rem auto 0;
  gap: 0.55rem;
}

.payment-cancel-button {
  width: 100%;
  min-height: 58px;
  border-radius: 8px;
  background: linear-gradient(180deg, #758868, #627655);
  color: #fffdf7;
  font-family: SimSun, "Songti SC", "Noto Serif CJK SC", serif;
  font-size: 1.2rem;
  font-weight: 800;
  box-shadow: 0 12px 24px rgba(82, 101, 65, 0.16);
}

.payment-cancel-button:disabled {
  cursor: not-allowed;
  background: rgba(170, 168, 155, 0.54);
  color: rgba(255, 253, 248, 0.72);
  box-shadow: none;
}

.payment-cancel-hint {
  color: #8a8175;
  font-size: 0.86rem;
  text-align: center;
}

.payment-footer {
  position: relative;
  z-index: 5;
  display: grid;
  width: min(100%, 34rem);
  margin: 0.95rem auto 2.9rem;
  justify-items: center;
  padding: 0 8rem;
}

.payment-help {
  color: #6f835f;
  font-size: 0.98rem;
}

.payment-mascot {
  position: absolute;
  bottom: 1.25rem;
  left: 0;
  z-index: 2;
  width: clamp(12rem, 24cqw, 15.5rem);
  height: auto;
  max-height: 19rem;
  object-fit: contain;
  object-position: left bottom;
}

.payment-slogan {
  position: absolute;
  right: 0;
  bottom: 1rem;
  left: 0;
  z-index: 3;
  width: 320px;
  max-width: calc(100% - 2rem);
  height: auto;
  margin: 0 auto;
  object-fit: contain;
  opacity: 0.92;
}

.payment-mock-controls {
  position: absolute;
  right: 1rem;
  bottom: 1rem;
  z-index: 9;
  display: flex;
  gap: 0.5rem;
}

.payment-mock-controls button {
  border: 1px solid rgba(211, 203, 180, 0.86);
  border-radius: 999px;
  background: rgba(255, 253, 248, 0.86);
  padding: 0.45rem 0.8rem;
  color: #625b52;
  font-size: 0.8rem;
}

.payment-mist {
  position: absolute;
  z-index: 0;
  pointer-events: none;
  border-radius: 999px;
  opacity: 0.55;
}

.payment-mist-left {
  bottom: 1.5rem;
  left: -7rem;
  width: 26rem;
  height: 10rem;
  background: rgba(131, 157, 126, 0.18);
  filter: blur(28px);
}

.payment-mist-right {
  right: -10rem;
  bottom: 6rem;
  width: 30rem;
  height: 13rem;
  background: rgba(206, 194, 156, 0.24);
  filter: blur(34px);
}

@container (max-width: 720px) {
  .payment-page {
    padding: 1rem 0.8rem 0.8rem;
  }

  .payment-header {
    align-items: center;
  }

  .payment-header img:first-child {
    height: 1.85rem;
  }

  .payment-header img:last-child {
    width: 2.6rem;
    height: 2.6rem;
  }

  .payment-header p:first-child {
    font-size: 2rem;
  }

  .payment-header p:last-child {
    font-size: 0.72rem;
  }

  .payment-title {
    margin-top: 0.7rem;
  }

  .payment-title h1 {
    font-size: 1.55rem;
  }

  .payment-title span {
    margin-top: 0.45rem;
  }

  .payment-card {
    width: min(100%, 34.2rem);
    min-height: 36.2rem;
    margin-top: 0.9rem;
    border-radius: 18px;
    padding: 1.85rem 1.1rem 1.55rem;
  }

  .payment-amount {
    font-size: 2.9rem;
  }

  .qr-shell {
    width: min(100%, 18rem);
    margin-top: 1.9rem;
  }

  .qr-shell :deep(img),
  .qr-shell :deep(.size-\[320px\]) {
    width: min(100%, 14rem);
    height: min(100vw, 14rem);
    max-height: 14rem;
  }

  .payment-countdown-label {
    margin-top: 2.1rem;
  }

  .payment-countdown {
    font-size: 2.1rem;
  }

  .payment-expire-copy,
  .qr-instruction {
    font-size: 0.82rem;
  }

  .payment-steps {
    width: min(100%, 33.2rem);
    margin-top: 2.2rem;
    border-radius: 16px;
    padding: 0.85rem 2.2rem 0.75rem;
  }

  .payment-step span {
    width: 40px;
    height: 40px;
  }

  .payment-step p {
    font-size: 0.78rem;
  }

  .payment-cancel-section {
    width: min(100%, 33.2rem);
    margin-top: 1.1rem;
  }

  .payment-cancel-button {
    min-height: 52px;
    font-size: 1.02rem;
  }

  .payment-footer {
    width: min(100%, 33.2rem);
    margin-bottom: 2.45rem;
    padding: 0 6rem;
  }

  .payment-help {
    font-size: 0.82rem;
  }

  .payment-mascot {
    width: 12.3rem;
    max-height: 15.5rem;
  }

  .payment-slogan {
    bottom: 0.7rem;
    width: 220px;
  }
}
</style>
