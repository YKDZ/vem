<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";

import type {
  CustomerCheckoutResultDetailIntent,
  CustomerCheckoutResultDisplayIntent,
  CustomerCheckoutReturnPolicy,
} from "@/checkout/customer-checkout-view";
import type { CheckoutResultKind } from "@/types/checkout";

import listSloganImage from "@/assets/home/list-slogan.png";
import logoImage from "@/assets/home/logo.png";
import mascotListImage from "@/assets/home/mascot-list.png";
import mascotTopImage from "@/assets/home/mascot-top-cutout.png";
import { useMaintenanceEntry } from "@/composables/useMaintenanceEntry";
import { daemonClient } from "@/daemon/client";
import KioskLayout from "@/layouts/KioskLayout.vue";
import { useCatalogStore } from "@/stores/catalog";
import { useCheckoutStore } from "@/stores/checkout";
import { useConnectivityStore } from "@/stores/connectivity";

const router = useRouter();
const checkoutStore = useCheckoutStore();
const catalogStore = useCatalogStore();
const connectivityStore = useConnectivityStore();
const { handleMaintenanceTap } = useMaintenanceEntry();

const AUTO_RETURN_DELAY_MS = 6000;
const AUTO_RETURN_TICK_MS = 1000;

type ResultCopy = {
  title: string;
  subtitle: string;
  tone: "success" | "warning" | "danger";
  icon: string;
};

const copyMap: Record<CustomerCheckoutResultDisplayIntent, ResultCopy> = {
  success: {
    title: "出货成功",
    subtitle: "请及时取走商品，欢迎再次使用。",
    tone: "success",
    icon: "✓",
  },
  payment_failed: {
    title: "支付失败",
    subtitle: "本次订单已取消，未完成扣款。",
    tone: "danger",
    icon: "×",
  },
  payment_expired: {
    title: "支付超时",
    subtitle: "二维码已过期，库存预占会由后端释放。",
    tone: "warning",
    icon: "⌛",
  },
  dispense_failure: {
    title: "出货失败",
    subtitle: "请联系工作人员处理，已支付款项会按订单状态处理。",
    tone: "danger",
    icon: "!",
  },
  refund_pending: {
    title: "退款处理中",
    subtitle: "出货异常已进入退款流程，请留意原支付渠道通知。",
    tone: "warning",
    icon: "↺",
  },
  refunded: {
    title: "已退款",
    subtitle: "款项已按原支付渠道退回。",
    tone: "success",
    icon: "¥",
  },
  manual_handling: {
    title: "等待人工处理",
    subtitle: "支付成功但出货状态异常，请联系现场运维或客服。",
    tone: "warning",
    icon: "…",
  },
  closed: {
    title: "订单已关闭",
    subtitle: "本次订单已结束。",
    tone: "warning",
    icon: "—",
  },
};
const detailCopyMap: Record<CustomerCheckoutResultDetailIntent, string> = {
  dispense_failure: "请凭订单凭证联系工作人员处理出货异常。",
  dispense_result_unknown: "出货结果待确认，请凭订单凭证联系工作人员处理。",
  manual_handling: "订单已进入人工处理，请凭订单凭证联系工作人员。",
};
const DISPENSE_RESOLUTION_RESULT_KINDS: ReadonlySet<CheckoutResultKind> =
  new Set(["dispense_failed", "refund_pending", "refunded", "manual_handling"]);

const checkoutView = computed(() => checkoutStore.customerCheckoutView);
const projectedResult = computed(() =>
  checkoutView.value.stage === "result" ? checkoutView.value.result : null,
);
const kind = computed<CheckoutResultKind | null>(
  () => projectedResult.value?.kind ?? null,
);
const displayIntent = computed<CustomerCheckoutResultDisplayIntent | null>(
  () => projectedResult.value?.displayIntent ?? null,
);
const copy = computed(() =>
  displayIntent.value ? copyMap[displayIntent.value] : null,
);
const isDispenseFailureResult = computed(
  () => displayIntent.value === "dispense_failure",
);
const isDispenseResolutionResult = computed(() =>
  kind.value ? DISPENSE_RESOLUTION_RESULT_KINDS.has(kind.value) : false,
);
const resultReadinessError = ref<string | null>(null);
const resultReadinessConfirmed = ref(false);
const activeReturnPolicy = computed<CustomerCheckoutReturnPolicy | null>(() => {
  if (!projectedResult.value) return null;
  const projectedPolicy = projectedResult.value.returnPolicy;
  if (
    projectedResult.value.kind !== "success" ||
    resultReadinessConfirmed.value
  ) {
    return projectedPolicy;
  }
  return {
    ...projectedPolicy,
    canAutoReturn: false,
    targetRoute:
      projectedPolicy.targetRoute === "catalog"
        ? "offline"
        : projectedPolicy.targetRoute,
  };
});
const orderCredential = computed(() => {
  if (projectedResult.value?.orderCredentialBehavior === "hidden") {
    return null;
  }
  return checkoutView.value.orderCredential;
});
const resultDetail = computed(() => {
  const detailIntent = projectedResult.value?.detailIntent;
  return detailIntent ? detailCopyMap[detailIntent] : null;
});
const requiresMaintenanceReview = computed(() => {
  return activeReturnPolicy.value?.requiresMaintenanceReview === true;
});
const canAutoReturn = computed(
  () => activeReturnPolicy.value?.canAutoReturn === true,
);
const canManuallyReturn = computed(
  () => activeReturnPolicy.value?.canManualReturn === true,
);
const autoReturnRemainingSeconds = ref(
  Math.ceil(AUTO_RETURN_DELAY_MS / AUTO_RETURN_TICK_MS),
);
const autoReturnMessage = computed(() => {
  const seconds = autoReturnRemainingSeconds.value;
  return `${seconds} 秒后自动返回首页。`;
});

let autoReturnTimer: number | null = null;
let autoReturnStartedAt = 0;
let returningToCatalog = false;

function stopAutoReturn(): void {
  if (autoReturnTimer !== null) {
    window.clearInterval(autoReturnTimer);
    autoReturnTimer = null;
  }
}

function updateAutoReturnCountdown(): void {
  const elapsedMs = Date.now() - autoReturnStartedAt;
  const remainingMs = Math.max(AUTO_RETURN_DELAY_MS - elapsedMs, 0);
  autoReturnRemainingSeconds.value = Math.ceil(
    remainingMs / AUTO_RETURN_TICK_MS,
  );
  if (remainingMs <= 0) {
    void backToCatalog();
  }
}

function startAutoReturn(): void {
  if (autoReturnTimer !== null || returningToCatalog) return;
  autoReturnStartedAt = Date.now();
  autoReturnRemainingSeconds.value = Math.ceil(
    AUTO_RETURN_DELAY_MS / AUTO_RETURN_TICK_MS,
  );
  autoReturnTimer = window.setInterval(
    updateAutoReturnCountdown,
    AUTO_RETURN_TICK_MS,
  );
}

async function backToCatalog(): Promise<void> {
  if (returningToCatalog) return;
  returningToCatalog = true;
  stopAutoReturn();
  const readinessConfirmed = await refreshResultReadiness();
  const returnPolicy = activeReturnPolicy.value;
  if (!readinessConfirmed || returnPolicy?.canManualReturn !== true) {
    returningToCatalog = false;
    return;
  }
  const projectedTargetRoute = returnPolicy.targetRoute;
  checkoutStore.dismissCurrentTerminalTransaction();
  checkoutStore.reset();
  const targetRoute = projectedTargetRoute
    ? `/${projectedTargetRoute}`
    : connectivityStore.isSaleNetworkReady
      ? "/catalog"
      : connectivityStore.ready?.suggestedRoute === "maintenance"
        ? "/maintenance"
        : "/offline";
  if (targetRoute === "/catalog") {
    await catalogStore.refresh().catch((error: unknown) => {
      resultReadinessError.value =
        error instanceof Error ? error.message : String(error);
    });
  }
  await router.replace(targetRoute);
}

async function refreshResultReadiness(): Promise<boolean> {
  resultReadinessConfirmed.value = false;
  try {
    const [ready, saleReadiness] = await Promise.all([
      daemonClient.getReady(),
      daemonClient.getSaleReadiness(),
    ]);
    connectivityStore.applyReady(ready);
    connectivityStore.applySaleReadiness(saleReadiness);
    resultReadinessError.value = null;
    resultReadinessConfirmed.value = true;
    return true;
  } catch (error) {
    resultReadinessError.value =
      error instanceof Error ? error.message : String(error);
    resultReadinessConfirmed.value = false;
    return false;
  }
}

watch(
  canAutoReturn,
  (enabled) => {
    if (enabled) {
      startAutoReturn();
    } else {
      stopAutoReturn();
    }
  },
  { immediate: true },
);

onMounted(() => {
  void refreshResultReadiness();
});

onBeforeUnmount(stopAutoReturn);
</script>

<template>
  <KioskLayout>
    <section v-if="!projectedResult" class="result-empty-state">
      <p>正在恢复页面，请稍候。</p>
    </section>
    <section v-else-if="isDispenseFailureResult" class="dispense-failure-page">
      <div class="failure-mist failure-mist-left"></div>
      <div class="failure-mist failure-mist-right"></div>

      <header class="failure-header">
        <div class="failure-brand" @click="handleMaintenanceTap">
          <img :src="logoImage" alt="唐诗村" />
          <img :src="mascotTopImage" alt="" aria-hidden="true" />
        </div>
        <div class="failure-time">
          <p>10:30</p>
          <span>2026/06/15　星期二</span>
        </div>
      </header>

      <div class="failure-title">
        <h1>出货失败</h1>
        <span aria-hidden="true"></span>
      </div>

      <main class="failure-card">
        <div class="failure-icon" aria-hidden="true">
          <svg viewBox="0 0 160 160">
            <circle cx="80" cy="80" r="76" fill="#fffdf8" />
            <path
              d="M80 35 126 118H34L80 35Z"
              fill="none"
              stroke="currentColor"
              stroke-linejoin="round"
              stroke-width="5"
            />
            <path
              d="M80 64v28M80 108h.1"
              fill="none"
              stroke="currentColor"
              stroke-linecap="round"
              stroke-width="7"
            />
          </svg>
          <span>!</span>
        </div>

        <h2>商品未能正常出货</h2>
        <p class="failure-subtitle">
          请勿离开设备，联系工作人员处理。已支付款项会按照订单状态继续处理。
        </p>
        <p v-if="orderCredential" class="failure-order-credential">
          订单凭证 {{ orderCredential }}
        </p>
        <p v-if="resultDetail" class="failure-detail">{{ resultDetail }}</p>

        <section class="failure-notice">
          <span aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path
                d="M12 8v5m0 4h.1M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"
                fill="none"
                stroke="currentColor"
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="1.9"
              />
            </svg>
          </span>
          <div>
            <h3>请联系现场工作人员</h3>
            <p>如设备侧面有客服二维码，也可以扫码反馈本次异常订单。</p>
          </div>
        </section>

        <p v-if="requiresMaintenanceReview" class="failure-hint">
          设备需要维护检查，当前页面会保留本次处理结果。
        </p>
        <p v-else-if="resultReadinessError" class="failure-hint">
          暂时无法确认设备恢复状态，当前页面会保留本次处理结果。
        </p>
      </main>

      <button
        v-if="canManuallyReturn"
        class="failure-return-button kiosk-touch-target"
        type="button"
        @click="backToCatalog"
      >
        返回首页
      </button>

      <section class="failure-warm-tip">
        <h2>❀ 温馨提示</h2>
        <p>请保留支付凭证或订单信息，方便工作人员核对处理。</p>
      </section>

      <img
        :src="mascotListImage"
        alt=""
        class="failure-mascot pointer-events-none"
        aria-hidden="true"
      />
      <img
        :src="listSloganImage"
        alt="让温柔贴近 让善意发生"
        class="failure-slogan pointer-events-none"
      />
    </section>
    <section v-else-if="copy" class="dispense-result-page">
      <div class="result-mist result-mist-left"></div>
      <div class="result-mist result-mist-right"></div>

      <header class="result-header">
        <div class="result-brand" @click="handleMaintenanceTap">
          <img :src="logoImage" alt="唐诗村" />
          <img :src="mascotTopImage" alt="" aria-hidden="true" />
        </div>
        <div class="result-time">
          <p>10:30</p>
          <span>2026/06/15　星期二</span>
        </div>
      </header>

      <div class="result-title">
        <h1>{{ copy.title }}</h1>
        <span aria-hidden="true"></span>
      </div>

      <main class="result-card">
        <div class="result-icon" :class="`result-icon-${copy.tone}`">
          <span>{{ copy.icon }}</span>
        </div>

        <h2>{{ copy.subtitle }}</h2>
        <p
          v-if="isDispenseResolutionResult && orderCredential"
          class="result-order-credential"
        >
          订单凭证 {{ orderCredential }}
        </p>
        <p v-if="resultDetail" class="result-detail">{{ resultDetail }}</p>
        <p v-if="canAutoReturn" class="result-detail">
          {{ autoReturnMessage }}
        </p>
        <p v-else-if="requiresMaintenanceReview" class="result-detail">
          设备需要维护检查，当前保持本次处理结果。
        </p>
        <p v-else-if="resultReadinessError" class="result-detail">
          无法确认设备恢复状态，当前保持本次处理结果。
        </p>

        <section v-if="canManuallyReturn" class="result-notice">
          <span aria-hidden="true">✓</span>
          <div>
            <h3>感谢您的使用</h3>
            <p>如需继续购买，可返回首页重新选择商品。</p>
          </div>
        </section>
      </main>

      <button
        v-if="canManuallyReturn"
        class="result-return-button kiosk-touch-target"
        type="button"
        @click="backToCatalog"
      >
        返回首页
      </button>

      <img
        :src="mascotListImage"
        alt=""
        class="result-mascot pointer-events-none"
        aria-hidden="true"
      />
      <img
        :src="listSloganImage"
        alt="让温柔贴近 让善意发生"
        class="result-slogan pointer-events-none"
      />
    </section>
  </KioskLayout>
</template>

<style scoped>
:global(.kiosk-shell:has(.dispense-failure-page) > header) {
  display: none;
}

:global(.kiosk-shell:has(.dispense-result-page) > header) {
  display: none;
}

:global(.kiosk-shell:has(.dispense-failure-page) > .kiosk-scroll) {
  margin-top: 0;
  padding-bottom: 0;
}

:global(.kiosk-shell:has(.dispense-result-page) > .kiosk-scroll) {
  margin-top: 0;
  padding-bottom: 0;
}

.dispense-result-page,
.dispense-failure-page {
  position: relative;
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  container-type: inline-size;
  overflow: hidden;
  margin: 0;
  padding: var(--machine-page-header-top) var(--machine-page-inline) 1.1rem;
  border: 0;
  border-radius: 0;
  background:
    radial-gradient(
      circle at 50% 18%,
      rgba(255, 255, 255, 0.9),
      transparent 36%
    ),
    radial-gradient(
      circle at 0% 100%,
      rgba(137, 157, 126, 0.15),
      transparent 28%
    ),
    linear-gradient(180deg, #fffdf8 0%, #fbf7eb 62%, #f6f0df 100%);
  color: #625b52;
  box-shadow: none;
}

.result-header,
.failure-header {
  position: relative;
  z-index: 5;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
}

.result-brand,
.failure-brand {
  display: flex;
  align-items: center;
  gap: 2rem;
}

.result-brand img:first-child,
.failure-brand img:first-child {
  width: 12.8rem;
  height: auto;
}

.result-brand img:last-child,
.failure-brand img:last-child {
  width: 4.6rem;
  height: 4.6rem;
  object-fit: contain;
}

.result-time,
.failure-time {
  color: #6f835f;
  text-align: right;
}

.result-time p,
.failure-time p {
  font-family: Georgia, "Times New Roman", serif;
  font-size: 3rem;
  line-height: 1;
}

.result-time span,
.failure-time span {
  display: block;
  margin-top: 0.65rem;
  font-size: 0.9rem;
}

.result-title,
.failure-title {
  position: relative;
  z-index: 4;
  margin-top: 4.1rem;
  text-align: center;
}

.result-title h1,
.failure-title h1 {
  color: #4c463f;
  font-family: SimSun, "Songti SC", "Noto Serif CJK SC", serif;
  font-size: 2.75rem;
  font-weight: 700;
  letter-spacing: 0.12em;
}

.result-title span,
.failure-title span {
  display: block;
  width: 5.2rem;
  height: 1.1rem;
  margin: 1rem auto 0;
  background: url("data:image/svg+xml,%3Csvg width='92' height='18' viewBox='0 0 92 18' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' stroke='%23c9b989' stroke-width='1.7'%3E%3Cpath d='M42 9h44'/%3E%3Cpath d='M50 13c15 0 21-8 5-8' stroke-linecap='round'/%3E%3Cpath d='M15 4c5 0 9 4 9 9M15 4c-5 0-9 4-9 9M15 4c0-5-4-7-7-1M15 4c0-5 4-7 7-1'/%3E%3C/g%3E%3C/svg%3E")
    center / contain no-repeat;
}

.result-card,
.failure-card {
  position: relative;
  z-index: 4;
  width: min(100%, 46rem);
  margin: 2.5rem auto 0;
  border: 1px solid rgba(211, 203, 180, 0.82);
  border-radius: 24px;
  background: rgba(255, 253, 248, 0.62);
  padding: 4rem 4.6rem 3rem;
  text-align: center;
  box-shadow: 0 22px 44px rgba(102, 92, 64, 0.07);
}

.result-icon,
.failure-icon {
  position: relative;
  display: grid;
  width: 13.2rem;
  height: 13.2rem;
  margin: 0 auto;
  place-items: center;
  border: 1px solid rgba(211, 203, 180, 0.82);
  border-radius: 999px;
  color: #9b7466;
  background: rgba(255, 255, 255, 0.72);
}

.result-icon span {
  display: grid;
  width: 3.7rem;
  height: 3.7rem;
  place-items: center;
  border-radius: 999px;
  background: #6f835f;
  color: #fffdf8;
  font-size: 2rem;
  font-weight: 900;
  box-shadow: 0 10px 20px rgba(85, 105, 76, 0.18);
}

.result-icon-danger span {
  background: #9b7466;
}

.result-icon-warning span {
  background: #a18a61;
}

.failure-icon svg {
  width: 9rem;
  height: 9rem;
}

.failure-icon span {
  position: absolute;
  right: 2.4rem;
  bottom: 2.15rem;
  display: grid;
  width: 3rem;
  height: 3rem;
  place-items: center;
  border-radius: 999px;
  background: #9b7466;
  color: #fffdf8;
  font-size: 1.6rem;
  font-weight: 900;
}

.result-card h2,
.failure-card h2 {
  margin-top: 2.7rem;
  color: #6f835f;
  font-family: SimSun, "Songti SC", "Noto Serif CJK SC", serif;
  font-size: 2rem;
  font-weight: 700;
  letter-spacing: 0.06em;
}

.failure-subtitle {
  margin: 1rem auto 0;
  max-width: 31rem;
  color: #766f66;
  font-size: 1.05rem;
  line-height: 1.75;
}

.result-order-credential,
.failure-order-credential {
  margin-top: 1rem;
  color: #5f584f;
  font-size: 1.05rem;
  font-weight: 800;
}

.result-detail,
.failure-detail {
  margin-top: 0.65rem;
  color: #756e64;
  font-size: 0.98rem;
}

.result-notice,
.failure-notice {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 1.35rem;
  align-items: center;
  margin-top: 2.6rem;
  border: 1px solid rgba(211, 203, 180, 0.74);
  border-radius: 12px;
  background: rgba(255, 253, 248, 0.54);
  padding: 1.45rem 2.6rem;
  text-align: left;
}

.result-notice span,
.failure-notice span {
  display: grid;
  width: 4.2rem;
  height: 4.2rem;
  place-items: center;
  border-radius: 999px;
  background: #9b7466;
  color: #fffdf8;
}

.result-notice span {
  background: #6f835f;
  font-size: 1.6rem;
  font-weight: 900;
}

.failure-notice svg {
  width: 2.4rem;
  height: 2.4rem;
}

.result-notice div,
.failure-notice div {
  border-left: 1px solid rgba(211, 203, 180, 0.65);
  padding-left: 1.35rem;
}

.result-notice h3,
.failure-notice h3 {
  color: #625b52;
  font-size: 1.08rem;
  font-weight: 800;
}

.result-notice p,
.failure-notice p,
.failure-hint,
.failure-warm-tip p {
  color: #756e64;
  font-size: 0.98rem;
}

.result-notice p,
.failure-notice p {
  margin-top: 0.55rem;
}

.failure-hint {
  margin-top: 1.35rem;
}

.result-return-button,
.failure-return-button {
  position: relative;
  z-index: 5;
  min-height: 4.25rem;
  margin: 1.55rem auto 0;
  border-radius: 8px;
  background: #6f835f;
  color: #fffdf8;
  font-size: 1.25rem;
  font-weight: 800;
  letter-spacing: 0.08em;
  box-shadow: 0 10px 20px rgba(85, 105, 76, 0.16);
}

.result-return-button {
  width: min(100%, 46rem);
}

.failure-return-button {
  width: min(100%, 24rem);
}

.failure-warm-tip {
  position: relative;
  z-index: 5;
  width: min(100%, 34rem);
  margin: 2.5rem auto 0;
  padding-left: 5.2rem;
  color: #746d63;
}

.failure-warm-tip h2 {
  color: #5f584f;
  font-family: SimSun, "Songti SC", "Noto Serif CJK SC", serif;
  font-size: 1.15rem;
  font-weight: 700;
  letter-spacing: 0.08em;
}

.failure-warm-tip p {
  margin-top: 0.85rem;
}

.result-mascot,
.failure-mascot {
  position: absolute;
  bottom: 1rem;
  left: 0.65rem;
  z-index: 3;
  width: clamp(12rem, 21cqw, 17rem);
  height: auto;
  max-height: 22rem;
  object-fit: contain;
  object-position: left bottom;
}

.result-slogan,
.failure-slogan {
  position: absolute;
  right: 0;
  bottom: 0.8rem;
  left: 0;
  z-index: 4;
  width: 340px;
  max-width: calc(100% - 2rem);
  height: auto;
  margin: 0 auto;
  object-fit: contain;
}

.result-mist,
.failure-mist {
  position: absolute;
  z-index: 0;
  pointer-events: none;
  border-radius: 999px;
  opacity: 0.55;
}

.result-mist-left,
.failure-mist-left {
  bottom: 1rem;
  left: -8rem;
  width: 32rem;
  height: 12rem;
  background: rgba(131, 157, 126, 0.16);
  filter: blur(30px);
}

.result-mist-right,
.failure-mist-right {
  right: -9rem;
  top: 6rem;
  width: 30rem;
  height: 14rem;
  background: rgba(206, 194, 156, 0.18);
  filter: blur(36px);
}

@container (max-width: 720px) {
  .dispense-failure-page {
    padding: 0.75rem 1rem 0.7rem;
    border-radius: 20px;
  }

  .failure-brand {
    gap: 0.8rem;
  }

  .failure-brand img:first-child {
    width: 6.8rem;
  }

  .failure-brand img:last-child {
    width: 2.55rem;
    height: 2.55rem;
  }

  .failure-time p {
    font-size: 1.75rem;
  }

  .failure-time span {
    margin-top: 0.3rem;
    font-size: 0.66rem;
  }

  .failure-title {
    margin-top: 2.4rem;
  }

  .failure-title h1 {
    font-size: 1.65rem;
  }

  .failure-title span {
    margin-top: 0.45rem;
  }

  .failure-card {
    width: min(100%, 29.5rem);
    margin-top: 1.15rem;
    border-radius: 20px;
    padding: 2.1rem 1.35rem 1.35rem;
  }

  .failure-icon {
    width: 8.2rem;
    height: 8.2rem;
  }

  .failure-icon svg {
    width: 5.5rem;
    height: 5.5rem;
  }

  .failure-icon span {
    right: 1.35rem;
    bottom: 1.25rem;
    width: 2.1rem;
    height: 2.1rem;
    font-size: 1.1rem;
  }

  .failure-card h2 {
    margin-top: 1.35rem;
    font-size: 1.35rem;
  }

  .failure-subtitle,
  .failure-order-credential,
  .failure-detail,
  .failure-notice p,
  .failure-hint,
  .failure-warm-tip p {
    font-size: 0.8rem;
  }

  .failure-subtitle {
    margin-top: 0.6rem;
    line-height: 1.55;
  }

  .failure-notice {
    margin-top: 1.1rem;
    gap: 0.75rem;
    padding: 0.75rem 1rem;
  }

  .failure-notice span {
    width: 2.8rem;
    height: 2.8rem;
  }

  .failure-notice svg {
    width: 1.8rem;
    height: 1.8rem;
  }

  .failure-notice div {
    padding-left: 0.8rem;
  }

  .failure-notice h3 {
    font-size: 0.9rem;
  }

  .failure-notice p {
    margin-top: 0.35rem;
  }

  .failure-hint {
    margin-top: 0.75rem;
  }

  .failure-return-button {
    width: min(100%, 18rem);
    min-height: 3.25rem;
    margin-top: 0.85rem;
    font-size: 0.95rem;
  }

  .failure-warm-tip {
    width: min(100%, 22rem);
    margin-top: 1rem;
    padding-left: 6rem;
  }

  .failure-warm-tip h2 {
    font-size: 0.9rem;
  }

  .failure-warm-tip p {
    margin-top: 0.35rem;
  }

  .failure-mascot {
    z-index: 1;
    width: 7.6rem;
    max-height: 10.2rem;
    opacity: 0.9;
  }

  .failure-slogan {
    bottom: 0.35rem;
    width: 190px;
  }
}
</style>
