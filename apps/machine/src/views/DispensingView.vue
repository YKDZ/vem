<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useRouter } from "vue-router";

import listSloganImage from "@/assets/home/list-slogan.png";
import mascotListImage from "@/assets/home/mascot-list.png";
import KioskHeader from "@/components/KioskHeader.vue";
import KioskLayout from "@/layouts/KioskLayout.vue";
import { useCheckoutStore } from "@/stores/checkout";

const router = useRouter();
const checkoutStore = useCheckoutStore();

let pollTimer: number | undefined;
let pickupRemainingTimer: number | undefined;
const pickupRemainingSeconds = ref<number | null>(null);

const checkoutView = computed(() => checkoutStore.customerCheckoutView);
const dispensingView = computed(() => checkoutView.value.dispensing);
const hasOrder = computed(() => checkoutView.value.stage === "dispensing");
const pickupReminder = computed(
  () => dispensingView.value?.pickupReminder ?? null,
);
const hasCustomerVisibleError = computed(
  () => dispensingView.value?.customerVisibleError !== null,
);
const orderCredential = computed(() => checkoutView.value.orderCredential);
const productName = computed(() => {
  const summary = checkoutStore.transaction?.productSummary;
  if (!summary || typeof summary !== "object") return null;
  for (const key of ["name", "productName", "title"]) {
    const value = (summary as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return null;
});
const titleText = computed(() =>
  hasCustomerVisibleError.value ? "出货异常" : "正在出货",
);
const pickupTitle = computed(() =>
  hasCustomerVisibleError.value
    ? "出货遇到问题"
    : pickupReminder.value?.urgency === "urgent"
      ? "请立即取走商品"
      : pickupReminder.value?.urgency === "warning"
        ? "请及时取走商品"
        : "设备出货中",
);
const pickupSubtitle = computed(() => {
  if (hasCustomerVisibleError.value) return "请联系工作人员处理";
  if (pickupReminder.value?.stage === "pickup_completed") {
    return "商品已完成出货，请确认取货";
  }
  if (pickupReminder.value?.stage === "pickup_waiting") {
    return "商品已到达取货口，请及时取走";
  }
  if (pickupReminder.value?.stage === "pickup_timeout_warning") {
    return "取货倒计时进行中，请尽快取走商品";
  }
  return "请稍候，商品正在送往取货口";
});
const pickupNoticeTitle = computed(() =>
  pickupReminder.value?.urgency === "urgent"
    ? "取货口即将关闭"
    : pickupReminder.value?.urgency === "warning"
      ? "请尽快完成取货"
      : "出货完成后请取货",
);
const pickupNoticeCopy = computed(() =>
  pickupReminder.value?.urgency === "urgent"
    ? "请立即取走商品，避免取货口超时关闭。"
    : pickupReminder.value?.urgency === "warning"
      ? "商品已在取货口等待，请及时取走。"
      : "取货口打开后，请及时取走商品。",
);
const hasPickupRemainingSeconds = computed(
  () => pickupRemainingSeconds.value !== null,
);
const pickupTimeText = computed(() => {
  const seconds = pickupRemainingSeconds.value ?? 0;
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(
    seconds % 60,
  ).padStart(2, "0")}`;
});

function syncPickupRemainingSeconds(): void {
  const remainingSeconds = pickupReminder.value?.remainingSeconds;
  pickupRemainingSeconds.value =
    typeof remainingSeconds === "number" && Number.isFinite(remainingSeconds)
      ? Math.max(0, Math.trunc(remainingSeconds))
      : null;
}

async function refreshStatus(): Promise<void> {
  await checkoutStore.refreshCurrentTransaction();
  syncPickupRemainingSeconds();
  const target = checkoutView.value.routeTarget;
  if ("path" in target) {
    if (target.path !== "/dispensing") {
      await router.replace(target.path);
    }
    return;
  }
  await router.replace(target);
}

onMounted(async () => {
  await refreshStatus();
  if (!hasOrder.value) return;

  pollTimer = window.setInterval(() => {
    void refreshStatus();
  }, 2_000);
  pickupRemainingTimer = window.setInterval(() => {
    if (pickupRemainingSeconds.value === null) return;
    pickupRemainingSeconds.value = Math.max(
      0,
      pickupRemainingSeconds.value - 1,
    );
  }, 1_000);
});

onUnmounted(() => {
  if (pollTimer) window.clearInterval(pollTimer);
  if (pickupRemainingTimer) window.clearInterval(pickupRemainingTimer);
});
</script>

<template>
  <KioskLayout>
    <section v-if="hasOrder" class="dispensing-page">
      <div class="dispensing-mist dispensing-mist-left"></div>
      <div class="dispensing-mist dispensing-mist-right"></div>

      <KioskHeader class="dispensing-header" />

      <div class="dispensing-title">
        <h1>{{ titleText }}</h1>
        <span aria-hidden="true"></span>
      </div>

      <main class="pickup-card">
        <div
          class="pickup-illustration"
          :class="{ 'pickup-error': hasCustomerVisibleError }"
        >
          <svg viewBox="0 0 180 180" aria-hidden="true">
            <circle cx="90" cy="90" r="88" fill="#fffdf8" />
            <path
              d="M56 84 90 72l35 12-34 13-35-13Z"
              fill="none"
              stroke="currentColor"
              stroke-width="3"
            />
            <path
              d="m56 84 10 46 26 12 26-12 7-46M91 97v45M66 130l25-12 27 12"
              fill="none"
              stroke="currentColor"
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="3"
            />
            <path
              d="M75 71V48l43 8v27M75 48l25-10 43 8-25 10"
              fill="none"
              stroke="currentColor"
              stroke-linejoin="round"
              stroke-width="3"
            />
            <path
              d="M92 69c8 0 14 6 14 14s-6 14-14 14-14-6-14-14 6-14 14-14Z"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              opacity=".5"
            />
          </svg>
          <span aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path
                d="m5 12 4 4 10-10"
                fill="none"
                stroke="currentColor"
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2.6"
              />
            </svg>
          </span>
        </div>

        <h2>{{ pickupTitle }}</h2>
        <p class="pickup-subtitle">{{ pickupSubtitle }}</p>
        <div
          v-if="productName || orderCredential"
          class="pickup-order-context"
          aria-label="出货订单信息"
        >
          <p v-if="productName">
            <span>商品</span>
            <strong>{{ productName }}</strong>
          </p>
          <p v-if="orderCredential" class="pickup-order-credential">
            <strong>订单凭证 {{ orderCredential }}</strong>
          </p>
        </div>

        <div class="pickup-divider" aria-hidden="true"></div>

        <template v-if="hasPickupRemainingSeconds">
          <p class="pickup-time-label">剩余取货时间</p>
          <strong class="pickup-time">{{ pickupTimeText }}</strong>
          <p class="pickup-time-copy">超时未取货，商品将返回柜内</p>
        </template>

        <section class="pickup-notice">
          <span aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path
                d="M18 8a6 6 0 1 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"
                fill="none"
                stroke="currentColor"
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="1.9"
              />
            </svg>
          </span>
          <div>
            <h3>{{ pickupNoticeTitle }}</h3>
            <p>{{ pickupNoticeCopy }}</p>
          </div>
        </section>
      </main>

      <section class="warm-tip">
        <h2>❀ 温馨提示</h2>
        <p>如商品有问题，请联系设备侧面客服热线</p>
        <p>或扫描机身二维码进行反馈</p>
      </section>

      <img
        :src="mascotListImage"
        alt=""
        class="dispensing-mascot pointer-events-none"
        aria-hidden="true"
      />
      <img
        :src="listSloganImage"
        alt="让温柔贴近 让善意发生"
        class="dispensing-slogan pointer-events-none"
      />
    </section>
    <section v-else class="dispensing-empty-state">
      <div>
        <h1>取货状态已失效</h1>
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
:global(.kiosk-shell:has(.dispensing-page) > header) {
  display: none;
}

:global(.kiosk-shell:has(.dispensing-page) > .kiosk-scroll) {
  margin-top: 0;
  padding-bottom: 0;
}

:global(.kiosk-shell:has(.dispensing-empty-state) > header) {
  display: none;
}

.dispensing-empty-state {
  display: grid;
  min-height: 100%;
  place-items: center;
  color: #5c554c;
  text-align: center;
}

.dispensing-empty-state > div {
  width: min(100%, 28rem);
  border: 1px solid rgba(211, 203, 180, 0.82);
  border-radius: 20px;
  background: rgba(255, 253, 248, 0.76);
  padding: 2.4rem;
}

.dispensing-empty-state h1 {
  font-size: 2rem;
  font-weight: 800;
}

.dispensing-empty-state p {
  margin-top: 0.8rem;
  color: #746d63;
}

.dispensing-empty-state button {
  margin-top: 1.6rem;
  border-radius: 999px;
  background: #6f835f;
  padding: 0.9rem 1.8rem;
  color: #fffdf8;
  font-weight: 800;
}

.dispensing-page {
  position: relative;
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  container-type: inline-size;
  overflow: hidden;
  margin: 0;
  padding: var(--machine-page-header-top) var(--machine-page-inline) 1rem;
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

.dispensing-header {
  position: relative;
  z-index: 5;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
}

.dispensing-brand {
  display: flex;
  align-items: center;
  gap: 2.2rem;
}

.dispensing-brand img:first-child {
  width: 13.2rem;
  height: auto;
}

.dispensing-brand img:last-child {
  width: 4.9rem;
  height: 4.9rem;
  object-fit: contain;
}

.dispensing-time {
  color: #6f835f;
  text-align: right;
}

.dispensing-time p {
  font-family: Georgia, "Times New Roman", serif;
  font-size: 3.25rem;
  line-height: 1;
}

.dispensing-time span {
  display: block;
  margin-top: 0.8rem;
  font-size: 0.9rem;
}

.dispensing-title {
  position: relative;
  z-index: 4;
  margin-top: 4.6rem;
  text-align: center;
}

.dispensing-title h1 {
  color: #4c463f;
  font-family: SimSun, "Songti SC", "Noto Serif CJK SC", serif;
  font-size: 2.85rem;
  font-weight: 700;
  letter-spacing: 0.12em;
}

.dispensing-title span,
.pickup-divider {
  display: block;
  width: 5.2rem;
  height: 1.1rem;
  margin: 1rem auto 0;
  background: url("data:image/svg+xml,%3Csvg width='92' height='18' viewBox='0 0 92 18' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' stroke='%23c9b989' stroke-width='1.7'%3E%3Cpath d='M42 9h44'/%3E%3Cpath d='M50 13c15 0 21-8 5-8' stroke-linecap='round'/%3E%3Cpath d='M15 4c5 0 9 4 9 9M15 4c-5 0-9 4-9 9M15 4c0-5-4-7-7-1M15 4c0-5 4-7 7-1'/%3E%3C/g%3E%3C/svg%3E")
    center / contain no-repeat;
}

.pickup-card {
  position: relative;
  z-index: 4;
  width: min(100%, 48rem);
  margin: 1.4rem auto 0;
  border: 1px solid rgba(211, 203, 180, 0.82);
  border-radius: 26px;
  background: rgba(255, 253, 248, 0.58);
  padding: 2.4rem 4.2rem 2.1rem;
  text-align: center;
  box-shadow: 0 22px 44px rgba(102, 92, 64, 0.07);
}

.pickup-illustration {
  position: relative;
  display: grid;
  width: 10.8rem;
  height: 10.8rem;
  margin: 0 auto;
  place-items: center;
  border: 1px solid rgba(211, 203, 180, 0.82);
  border-radius: 999px;
  color: #c7bda9;
  background: rgba(255, 255, 255, 0.72);
}

.pickup-illustration > svg {
  width: 7.1rem;
  height: 7.1rem;
}

.pickup-illustration span {
  position: absolute;
  right: 2rem;
  bottom: 1.9rem;
  display: grid;
  width: 3.2rem;
  height: 3.2rem;
  place-items: center;
  border-radius: 999px;
  background: #6f835f;
  color: #fffdf8;
  box-shadow: 0 8px 18px rgba(85, 105, 76, 0.25);
}

.pickup-illustration span svg {
  width: 1.8rem;
  height: 1.8rem;
}

.pickup-error span {
  background: #8b6f5f;
}

.pickup-card h2 {
  margin-top: 1.8rem;
  color: #6f835f;
  font-family: SimSun, "Songti SC", "Noto Serif CJK SC", serif;
  font-size: 2rem;
  font-weight: 700;
  letter-spacing: 0.08em;
}

.pickup-subtitle {
  margin-top: 1.1rem;
  color: #7b746a;
  font-size: 1.08rem;
}

.pickup-order-context {
  display: grid;
  gap: 0.45rem;
  width: min(100%, 25rem);
  margin: 1rem auto 0;
  border: 1px solid rgba(211, 203, 180, 0.74);
  border-radius: 8px;
  background: rgba(255, 253, 248, 0.62);
  padding: 0.75rem 1.15rem;
  color: #5f584f;
}

.pickup-order-context p {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1rem;
  margin: 0;
}

.pickup-order-context span {
  flex: 0 0 auto;
  color: #827b70;
  font-size: 0.92rem;
  font-weight: 700;
}

.pickup-order-context strong {
  min-width: 0;
  text-align: right;
  overflow-wrap: anywhere;
  font-size: 1.05rem;
  font-weight: 800;
}

.pickup-time-label {
  margin-top: 1.55rem;
  color: #5f584f;
  font-size: 1.15rem;
}

.pickup-time {
  display: block;
  margin-top: 0.75rem;
  color: #6f835f;
  font-family: Georgia, "Times New Roman", serif;
  font-size: 2.85rem;
  line-height: 1;
  letter-spacing: 0.08em;
}

.pickup-time-copy {
  margin-top: 0.75rem;
  color: #827b70;
  font-size: 1rem;
}

.pickup-notice {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 1.5rem;
  align-items: center;
  margin-top: 1.6rem;
  border: 1px solid rgba(211, 203, 180, 0.74);
  border-radius: 12px;
  background: rgba(255, 253, 248, 0.54);
  padding: 1.15rem 2.2rem;
  text-align: left;
}

.pickup-notice span {
  display: grid;
  width: 4.6rem;
  height: 4.6rem;
  place-items: center;
  border-radius: 999px;
  background: #6f835f;
  color: #fffdf8;
}

.pickup-notice span svg {
  width: 2.5rem;
  height: 2.5rem;
}

.pickup-notice div {
  border-left: 1px solid rgba(211, 203, 180, 0.65);
  padding-left: 1.55rem;
}

.pickup-notice h3 {
  color: #625b52;
  font-size: 1.1rem;
  font-weight: 700;
}

.pickup-notice p {
  margin-top: 0.65rem;
  color: #756e64;
  font-size: 1rem;
}

.warm-tip {
  position: relative;
  z-index: 5;
  width: min(100%, 33rem);
  margin: 1.3rem auto 0;
  color: #746d63;
  padding-left: 4.5rem;
}

.warm-tip h2 {
  color: #5f584f;
  font-family: SimSun, "Songti SC", "Noto Serif CJK SC", serif;
  font-size: 1.2rem;
  font-weight: 700;
  letter-spacing: 0.08em;
}

.warm-tip p {
  margin-top: 1rem;
  font-size: 1rem;
}

.dispensing-mascot {
  position: absolute;
  bottom: 1.25rem;
  left: 0.65rem;
  z-index: 3;
  width: clamp(13rem, 22cqw, 18rem);
  height: auto;
  max-height: 24rem;
  object-fit: contain;
  object-position: left bottom;
}

.dispensing-slogan {
  position: absolute;
  right: 0;
  bottom: 0.9rem;
  left: 0;
  z-index: 4;
  width: 360px;
  max-width: calc(100% - 2rem);
  height: auto;
  margin: 0 auto;
  object-fit: contain;
}

.dispensing-mist {
  position: absolute;
  z-index: 0;
  pointer-events: none;
  border-radius: 999px;
  opacity: 0.55;
}

.dispensing-mist-left {
  bottom: 1rem;
  left: -8rem;
  width: 32rem;
  height: 12rem;
  background: rgba(131, 157, 126, 0.18);
  filter: blur(30px);
}

.dispensing-mist-right {
  right: -9rem;
  top: 6rem;
  width: 30rem;
  height: 14rem;
  background: rgba(206, 194, 156, 0.18);
  filter: blur(36px);
}

@container (max-width: 720px) {
  .dispensing-page {
    padding: 0.75rem 1rem 0.7rem;
    border-radius: 20px;
  }

  .dispensing-brand {
    gap: 0.8rem;
  }

  .dispensing-brand img:first-child {
    width: 6.8rem;
  }

  .dispensing-brand img:last-child {
    width: 2.55rem;
    height: 2.55rem;
  }

  .dispensing-time p {
    font-size: 1.75rem;
  }

  .dispensing-time span {
    margin-top: 0.3rem;
    font-size: 0.66rem;
  }

  .dispensing-title {
    margin-top: 1.35rem;
  }

  .dispensing-title h1 {
    font-size: 1.55rem;
  }

  .dispensing-title span,
  .pickup-divider {
    margin-top: 0.45rem;
  }

  .pickup-card {
    width: min(100%, 29.5rem);
    margin-top: 0.95rem;
    border-radius: 20px;
    padding: 1.65rem 1.35rem 1.1rem;
  }

  .pickup-illustration {
    width: 7.8rem;
    height: 7.8rem;
  }

  .pickup-illustration > svg {
    width: 5.2rem;
    height: 5.2rem;
  }

  .pickup-illustration span {
    right: 1.35rem;
    bottom: 1.25rem;
    width: 2rem;
    height: 2rem;
  }

  .pickup-illustration span svg {
    width: 1.25rem;
    height: 1.25rem;
  }

  .pickup-card h2 {
    margin-top: 1.2rem;
    font-size: 1.28rem;
  }

  .pickup-subtitle,
  .pickup-order-context span,
  .pickup-order-context strong,
  .pickup-time-copy,
  .pickup-notice p,
  .warm-tip p {
    font-size: 0.78rem;
  }

  .pickup-order-context {
    gap: 0.32rem;
    margin-top: 0.65rem;
    padding: 0.55rem 0.8rem;
  }

  .pickup-subtitle {
    margin-top: 0.55rem;
  }

  .pickup-time-label {
    margin-top: 1.15rem;
    font-size: 0.92rem;
  }

  .pickup-time {
    margin-top: 0.45rem;
    font-size: 1.85rem;
  }

  .pickup-time-copy {
    margin-top: 0.55rem;
  }

  .pickup-notice {
    margin-top: 1rem;
    gap: 0.75rem;
    padding: 0.75rem 1rem;
  }

  .pickup-notice span {
    width: 2.8rem;
    height: 2.8rem;
  }

  .pickup-notice span svg {
    width: 1.8rem;
    height: 1.8rem;
  }

  .pickup-notice div {
    padding-left: 0.8rem;
  }

  .pickup-notice h3 {
    font-size: 0.9rem;
  }

  .pickup-notice p {
    margin-top: 0.35rem;
  }

  .warm-tip {
    width: min(100%, 22rem);
    margin-top: 0.9rem;
    padding-left: 6rem;
  }

  .warm-tip h2 {
    font-size: 0.9rem;
  }

  .warm-tip p {
    margin-top: 0.35rem;
  }

  .dispensing-mascot {
    z-index: 1;
    width: 7.6rem;
    max-height: 10.2rem;
    opacity: 0.9;
  }

  .dispensing-slogan {
    bottom: 0.35rem;
    width: 190px;
  }
}
</style>
