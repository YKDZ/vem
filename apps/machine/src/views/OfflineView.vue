<script setup lang="ts">
import { computed } from "vue";

import listSloganImage from "@/assets/home/list-slogan.png";
import mascotListImage from "@/assets/home/mascot-list.png";
import KioskHeader from "@/components/KioskHeader.vue";
import KioskLayout from "@/layouts/KioskLayout.vue";
import { submitMachineNavigationIntent } from "@/router/transaction-route-authority";
import { useSaleCapabilityStore } from "@/stores/sale-capability";

const saleCapabilityStore = useSaleCapabilityStore();

const reasonText = computed(() => {
  const codes = saleCapabilityStore.blockerCodes;
  if (!saleCapabilityStore.accepted || saleCapabilityStore.updating) {
    return "正在确认当前购买状态";
  }
  if (codes.includes("WHOLE_MACHINE_HARDWARE_FAULT")) {
    return "设备需要工作人员检查后才能继续售卖";
  }
  if (
    codes.includes("LOWER_CONTROLLER_UNAVAILABLE") ||
    codes.includes("SLOT_SALE_SAFETY_BLOCKED")
  ) {
    return "设备暂时无法确认出货状态";
  }
  if (
    codes.includes("PLATFORM_UNREACHABLE") ||
    codes.includes("BACKEND_UNREACHABLE") ||
    codes.includes("mqtt")
  ) {
    return "当前设备暂时无法连接网络";
  }
  if (
    codes.includes("NO_PAYMENT_OPTIONS") ||
    codes.includes("PAYMENT_OPTIONS_UNAVAILABLE")
  ) {
    return "支付服务暂时不可用";
  }
  if (codes.includes("ACTIVE_PLANOGRAM_MISSING")) {
    return "商品信息暂未准备好";
  }
  return "当前设备暂时无法购买";
});

const supportHint = computed(() => {
  const codes = saleCapabilityStore.blockerCodes;
  if (!saleCapabilityStore.accepted || saleCapabilityStore.updating) {
    return "状态确认中";
  }
  if (codes.includes("WHOLE_MACHINE_HARDWARE_FAULT")) return "设备维护";
  if (
    codes.includes("LOWER_CONTROLLER_UNAVAILABLE") ||
    codes.includes("SLOT_SALE_SAFETY_BLOCKED")
  ) {
    return "出货状态待确认";
  }
  if (
    codes.includes("PLATFORM_UNREACHABLE") ||
    codes.includes("BACKEND_UNREACHABLE") ||
    codes.includes("mqtt")
  ) {
    return "网络连接异常";
  }
  if (
    codes.includes("NO_PAYMENT_OPTIONS") ||
    codes.includes("PAYMENT_OPTIONS_UNAVAILABLE")
  ) {
    return "支付服务不可用";
  }
  if (codes.includes("ACTIVE_PLANOGRAM_MISSING")) return "商品信息未准备";
  return "暂不可售";
});

async function retryBoot(): Promise<void> {
  await submitMachineNavigationIntent({
    type: "startup.navigate",
    target: { name: "boot" },
  });
}
</script>

<template>
  <KioskLayout>
    <section class="offline-page">
      <div class="offline-mist offline-mist-left"></div>
      <div class="offline-mist offline-mist-right"></div>

      <KioskHeader class="offline-header" />

      <main class="offline-card">
        <div class="offline-bamboo" aria-hidden="true"></div>
        <div class="offline-icon" aria-hidden="true">
          <svg viewBox="0 0 120 120">
            <path
              d="M29 58c17-15 45-15 62 0M40 70c11-9 29-9 40 0M51 82c5-4 13-4 18 0"
              fill="none"
              stroke="currentColor"
              stroke-linecap="round"
              stroke-width="5"
            />
            <circle
              cx="60"
              cy="94"
              r="5"
              fill="none"
              stroke="currentColor"
              stroke-width="5"
            />
          </svg>
          <span>×</span>
        </div>

        <h1>设备离线</h1>
        <p>{{ reasonText }}</p>
        <p>请检查网络连接或稍后重试</p>

        <div class="offline-divider" aria-hidden="true"></div>
        <p class="offline-try-label">您可以尝试</p>

        <button
          class="offline-retry kiosk-touch-target"
          type="button"
          @click="retryBoot"
        >
          <span>刷新重试</span>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M20 12a8 8 0 1 1-2.34-5.66M20 4v6h-6"
              fill="none"
              stroke="currentColor"
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
            />
          </svg>
        </button>

        <p class="offline-code">客服提示：{{ supportHint }}</p>
      </main>

      <section class="offline-alternatives">
        <div class="offline-section-title">
          <span aria-hidden="true"></span>
          <h2>其他购物方式</h2>
          <span aria-hidden="true"></span>
        </div>
        <div class="offline-option-grid">
          <article class="offline-option">
            <svg viewBox="0 0 48 48" aria-hidden="true">
              <path
                d="M17 8h14a4 4 0 0 1 4 4v24a4 4 0 0 1-4 4H17a4 4 0 0 1-4-4V12a4 4 0 0 1 4-4Zm1 8h12M19 34h10M18 22h4l2 7h7l3-8H22"
                fill="none"
                stroke="currentColor"
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2.4"
              />
            </svg>
            <h3>移动端购买</h3>
            <p>扫描二维码进入小程序</p>
            <button type="button">去查看 <span>›</span></button>
          </article>
          <article class="offline-option">
            <svg viewBox="0 0 48 48" aria-hidden="true">
              <path
                d="M13 27v-5a11 11 0 0 1 22 0v5M13 27h-3v8h6v-8h-3Zm22 0h3v8h-6v-8h3ZM20 39c3 2 8 2 11 0"
                fill="none"
                stroke="currentColor"
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2.4"
              />
            </svg>
            <h3>联系客服</h3>
            <p>联系我们的客服人员</p>
            <button type="button">去联系 <span>›</span></button>
          </article>
          <article class="offline-option">
            <svg viewBox="0 0 48 48" aria-hidden="true">
              <path
                d="M24 42s13-11 13-23a13 13 0 1 0-26 0c0 12 13 23 13 23Zm0-17a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z"
                fill="none"
                stroke="currentColor"
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2.4"
              />
            </svg>
            <h3>查找附近设备</h3>
            <p>查找附近可用设备</p>
            <button type="button">去查找 <span>›</span></button>
          </article>
        </div>
      </section>

      <img
        :src="mascotListImage"
        alt=""
        class="offline-mascot pointer-events-none"
        aria-hidden="true"
      />
      <img
        :src="listSloganImage"
        alt="让温柔贴近 让善意发生"
        class="offline-slogan pointer-events-none"
      />
      <div class="offline-hills" aria-hidden="true"></div>
    </section>
  </KioskLayout>
</template>

<style scoped>
:global(.kiosk-shell:has(.offline-page) > header) {
  display: none;
}

.offline-page {
  position: relative;
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  overflow: hidden;
  margin: 0;
  padding: var(--machine-page-header-top) var(--machine-page-inline) 1.2rem;
  background:
    radial-gradient(
      circle at 50% 18%,
      rgba(255, 255, 255, 0.9),
      transparent 34%
    ),
    radial-gradient(
      circle at 0% 100%,
      rgba(137, 157, 126, 0.15),
      transparent 28%
    ),
    linear-gradient(180deg, #fffdf8 0%, #fbf7eb 62%, #f6f0df 100%);
  color: #625b52;
}

.offline-header,
.offline-brand {
  position: relative;
  z-index: 5;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
}

.offline-brand {
  gap: 2rem;
  align-items: center;
}

.offline-brand img:first-child {
  width: 12.8rem;
  height: auto;
}

.offline-brand img:last-child {
  width: 4.6rem;
  height: 4.6rem;
  object-fit: contain;
}

.offline-time {
  color: #6f835f;
  text-align: right;
}

.offline-time p {
  font-family: Georgia, "Times New Roman", serif;
  font-size: 3rem;
  line-height: 1;
}

.offline-time span {
  display: block;
  margin-top: 0.65rem;
  font-size: 0.9rem;
}

.offline-card {
  position: relative;
  z-index: 4;
  min-height: 34.5rem;
  margin-top: 3rem;
  overflow: hidden;
  border: 1px solid rgba(211, 203, 180, 0.82);
  border-radius: 28px;
  background: rgba(255, 253, 248, 0.5);
  padding: 2.6rem 4rem 2.2rem;
  text-align: center;
  box-shadow: 0 22px 44px rgba(102, 92, 64, 0.06);
}

.offline-bamboo {
  position: absolute;
  top: 0.5rem;
  right: 0.9rem;
  width: 12rem;
  height: 12rem;
  opacity: 0.16;
  background: url("data:image/svg+xml,%3Csvg width='180' height='180' viewBox='0 0 180 180' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' stroke='%23768b68' stroke-width='3' stroke-linecap='round'%3E%3Cpath d='M110 176C105 124 113 68 150 6'/%3E%3Cpath d='M80 170C85 116 78 78 52 22'/%3E%3Cpath d='M132 58c20-19 34-24 44-25-7 13-21 20-44 25Z'/%3E%3Cpath d='M119 104c24-17 41-20 55-18-12 11-28 15-55 18Z'/%3E%3Cpath d='M68 74C43 58 25 54 10 56c14 12 32 17 58 18Z'/%3E%3C/g%3E%3C/svg%3E")
    center / contain no-repeat;
}

.offline-icon {
  position: relative;
  display: grid;
  width: 7.8rem;
  height: 7.8rem;
  margin: 0 auto;
  place-items: center;
  border: 1px solid rgba(211, 203, 180, 0.82);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.62);
  color: #aa987c;
}

.offline-icon svg {
  width: 4.6rem;
  height: 4.6rem;
}

.offline-icon span {
  position: absolute;
  right: 1.65rem;
  bottom: 1.5rem;
  display: grid;
  width: 2.5rem;
  height: 2.5rem;
  place-items: center;
  border-radius: 999px;
  background: #6f835f;
  color: #fffdf8;
  font-size: 1.8rem;
  font-weight: 900;
}

.offline-card h1 {
  margin-top: 2rem;
  color: #6f835f;
  font-family: SimSun, "Songti SC", "Noto Serif CJK SC", serif;
  font-size: 2.8rem;
  font-weight: 700;
  letter-spacing: 0.34em;
}

.offline-card p {
  margin-top: 1.2rem;
  color: #756e64;
  font-size: 1.15rem;
}

.offline-divider {
  width: 7rem;
  height: 1.1rem;
  margin: 2rem auto 0;
  background: url("data:image/svg+xml,%3Csvg width='120' height='18' viewBox='0 0 120 18' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' stroke='%23c9b989' stroke-width='1.7'%3E%3Cpath d='M6 9h40M74 9h40'/%3E%3Cpath d='M57 9c0-6 8-6 8 0s-8 6-8 0Z'/%3E%3Cpath d='M61 5v8M57 9h8'/%3E%3C/g%3E%3C/svg%3E")
    center / contain no-repeat;
}

.offline-try-label {
  margin-top: 1.35rem;
  color: #6b6258;
}

.offline-retry {
  display: inline-flex;
  min-width: 14rem;
  min-height: 4.4rem;
  align-items: center;
  justify-content: center;
  gap: 1.2rem;
  margin-top: 0.8rem;
  border-radius: 999px;
  background: linear-gradient(180deg, #7c8f6d, #667b58);
  color: #fffdf8;
  font-family: SimSun, "Songti SC", "Noto Serif CJK SC", serif;
  font-size: 1.35rem;
  font-weight: 700;
  box-shadow: 0 14px 24px rgba(85, 105, 76, 0.2);
}

.offline-retry svg {
  width: 1.7rem;
  height: 1.7rem;
}

.offline-code {
  color: #898077;
  font-size: 0.9rem;
  letter-spacing: 0.16em;
}

.offline-alternatives {
  position: relative;
  z-index: 4;
  margin-top: 2.1rem;
}

.offline-section-title {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 1.4rem;
  color: #6f835f;
}

.offline-section-title h2 {
  font-family: SimSun, "Songti SC", "Noto Serif CJK SC", serif;
  font-size: 1.55rem;
  font-weight: 700;
  letter-spacing: 0.18em;
}

.offline-section-title span {
  width: 5.6rem;
  height: 1px;
  background: #d4c69e;
}

.offline-option-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 1.6rem;
  margin-top: 1.7rem;
}

.offline-option {
  min-height: 15.7rem;
  border: 1px solid rgba(211, 203, 180, 0.78);
  border-radius: 24px;
  background: rgba(255, 253, 248, 0.58);
  padding: 1.5rem 1.1rem 1.15rem;
  text-align: center;
  box-shadow: 0 18px 36px rgba(102, 92, 64, 0.06);
}

.offline-option svg {
  width: 4.1rem;
  height: 4.1rem;
  color: #6f835f;
}

.offline-option h3 {
  margin-top: 1.4rem;
  color: #4f473f;
  font-family: SimSun, "Songti SC", "Noto Serif CJK SC", serif;
  font-size: 1.55rem;
  font-weight: 700;
}

.offline-option p {
  margin-top: 0.8rem;
  color: #766f66;
  font-size: 1rem;
}

.offline-option button {
  display: inline-flex;
  min-height: 2.3rem;
  align-items: center;
  gap: 0.45rem;
  margin-top: 1.35rem;
  border-radius: 999px;
  background: linear-gradient(180deg, #7c8f6d, #667b58);
  color: #fffdf8;
  padding: 0 1.25rem;
  font-size: 0.86rem;
  font-weight: 700;
}

.offline-mascot {
  position: absolute;
  bottom: 0.9rem;
  left: 0.6rem;
  z-index: 2;
  width: clamp(9.5rem, 17cqw, 13.5rem);
  height: auto;
  object-fit: contain;
  opacity: 0.82;
}

.offline-slogan {
  position: absolute;
  right: 0;
  bottom: 0.7rem;
  left: 0;
  z-index: 5;
  width: 330px;
  max-width: calc(100% - 2rem);
  margin: 0 auto;
}

.offline-hills {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: 1;
  height: 8.5rem;
  background: linear-gradient(8deg, rgba(153, 183, 129, 0.35), transparent 60%);
}

.offline-mist {
  position: absolute;
  z-index: 0;
  pointer-events: none;
  border-radius: 999px;
  opacity: 0.55;
}

.offline-mist-left {
  bottom: 2rem;
  left: -8rem;
  width: 32rem;
  height: 12rem;
  background: rgba(131, 157, 126, 0.18);
  filter: blur(30px);
}

.offline-mist-right {
  right: -9rem;
  top: 6rem;
  width: 30rem;
  height: 14rem;
  background: rgba(206, 194, 156, 0.18);
  filter: blur(36px);
}
</style>
