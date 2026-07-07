<script setup lang="ts">
import { computed, onMounted } from "vue";
import { useRouter } from "vue-router";

import iconSocksImage from "@/assets/home/icon-socks.png";
import iconTshirtImage from "@/assets/home/icon-tshirt.png";
import iconUnderwearImage from "@/assets/home/icon-underwear.png";
import mascotListImage from "@/assets/home/mascot-list.png";
import alipayCodeImage from "@/assets/payment/alipay-code.png";
import alipayScanImage from "@/assets/payment/alipay-scan.png";
import { topCategoryForItem } from "@/catalog/view-model";
import KioskHeader from "@/components/KioskHeader.vue";
import KioskLayout from "@/layouts/KioskLayout.vue";
import { useCatalogStore } from "@/stores/catalog";
import { useCheckoutStore } from "@/stores/checkout";
import { useConnectivityStore } from "@/stores/connectivity";
import { formatCents } from "@/utils/format";

const router = useRouter();
const checkoutStore = useCheckoutStore();
const catalogStore = useCatalogStore();
const connectivityStore = useConnectivityStore();

const item = computed(() => {
  const selectedItem = checkoutStore.selectedItem;
  if (!selectedItem) return null;
  return catalogStore.saleableItemFor(selectedItem) ?? selectedItem;
});
const specText = computed(() => {
  if (!item.value) return "-";
  return (
    [item.value.size, item.value.color].filter(Boolean).join(" / ") ||
    item.value.sku
  );
});
const fallbackImage = computed(() => {
  if (!item.value) return iconSocksImage;
  const category = topCategoryForItem(item.value);
  if (category?.key === "underwear") return iconUnderwearImage;
  if (category?.key === "tshirts") return iconTshirtImage;
  return iconSocksImage;
});
const hasProductImage = computed(() => Boolean(item.value?.coverImageUrl));
const canSubmit = computed(
  () =>
    Boolean(item.value) &&
    checkoutStore.canCreateOrder &&
    connectivityStore.isSaleNetworkReady &&
    !checkoutStore.loading,
);

const paymentHint = computed(() => {
  const selected = checkoutStore.selectedPaymentOption;
  if (!selected) return null;
  if (selected.providerCode === "mock") return "下一步将进入模拟支付流程。";
  if (selected.method === "payment_code") {
    return "下一步请出示付款码并靠近扫码窗口完成支付。";
  }
  return "下一步将展示所选渠道二维码，请使用对应 App 扫码支付。";
});

const submitButtonText = computed(() => {
  if (checkoutStore.loading) return "正在创建订单...";
  if (checkoutStore.selectedPaymentOption?.method === "payment_code") {
    return "确认并进入付款码支付";
  }
  return "确认并生成支付二维码";
});

function paymentIconKind(providerCode: string, method: string): string {
  if (providerCode === "wechat_pay") return "wechat";
  if (providerCode === "alipay")
    return method === "payment_code" ? "ali-code" : "alipay";
  if (providerCode === "mock") return "mock";
  return method === "payment_code" ? "code" : "qr";
}

function paymentIconImage(providerCode: string, method: string): string | null {
  if (providerCode !== "alipay") return null;
  return method === "payment_code" ? alipayCodeImage : alipayScanImage;
}

function paymentDisplayName(displayName: string, method: string): string {
  if (displayName.includes("扫码") || displayName.includes("付款码")) {
    return displayName;
  }
  return `${displayName}${method === "payment_code" ? "付款码" : "扫码"}`;
}

function paymentDescription(description: string, method: string): string {
  if (description) return description;
  return method === "payment_code"
    ? "展示付款码扫码界面"
    : "展示二维码支付界面";
}

onMounted(async () => {
  if (!item.value) return;
  try {
    await checkoutStore.loadPaymentOptions();
  } catch {
    // checkoutStore.error carries the operator-facing message.
  }
});

async function submitOrder(): Promise<void> {
  if (!canSubmit.value) return;
  try {
    await checkoutStore.createOrder();
    await router.replace("/payment");
  } catch {
    // checkoutStore.error is rendered in the page.
  }
}
</script>

<template>
  <KioskLayout>
    <section v-if="item" class="checkout-page">
      <KioskHeader class="checkout-header" />

      <div class="checkout-back-row">
        <button
          class="checkout-back kiosk-touch-target"
          type="button"
          aria-label="返回"
          @click="router.back()"
        >
          <span aria-hidden="true">&lt;</span>
          返回
        </button>
      </div>

      <div class="checkout-title-row">
        <div>
          <p>确认订单</p>
          <h1>确认购买</h1>
        </div>
        <div class="checkout-amount">
          <p>应付金额</p>
          <strong>{{ formatCents(item.priceCents) }}</strong>
        </div>
      </div>

      <main class="checkout-main">
        <section class="checkout-panel product-panel">
          <h2>商品信息</h2>
          <div class="product-summary">
            <div class="product-image">
              <img
                :src="item.coverImageUrl ?? fallbackImage"
                :alt="item.productName"
                :class="{ 'product-image-fallback': !hasProductImage }"
              />
            </div>
            <div class="product-copy">
              <h3>{{ item.productName }}</h3>
              <p>{{ specText }}</p>
              <p>数量 ×1</p>
              <strong>{{ formatCents(item.priceCents) }}</strong>
            </div>
          </div>
        </section>

        <section class="checkout-panel payment-panel">
          <div class="payment-heading">
            <h2>选择支付方式</h2>
            <p>请选择后在下一步扫码支付</p>
          </div>

          <div
            v-if="checkoutStore.paymentOptions.length > 0"
            class="payment-list"
          >
            <button
              v-for="option in checkoutStore.paymentOptions"
              :key="option.optionKey"
              class="payment-option kiosk-touch-target"
              :class="{
                'payment-option-selected':
                  option.optionKey === checkoutStore.selectedPaymentOptionKey,
              }"
              type="button"
              :disabled="option.disabled"
              @click="checkoutStore.selectPaymentOption(option.optionKey)"
            >
              <span
                class="payment-option-icon"
                :data-kind="paymentIconKind(option.providerCode, option.method)"
                aria-hidden="true"
              >
                <img
                  v-if="paymentIconImage(option.providerCode, option.method)"
                  :src="paymentIconImage(option.providerCode, option.method)!"
                  alt=""
                  aria-hidden="true"
                />
                <template
                  v-else-if="
                    paymentIconKind(option.providerCode, option.method) ===
                    'wechat'
                  "
                  >微</template
                >
                <template v-else>付</template>
              </span>
              <span class="payment-option-copy">
                <strong>
                  {{ paymentDisplayName(option.displayName, option.method) }}
                </strong>
                <small>
                  {{
                    option.disabled
                      ? option.disabledReason
                      : paymentDescription(option.description, option.method)
                  }}
                </small>
              </span>
              <span v-if="option.recommended" class="payment-recommended">
                推荐
              </span>
            </button>
          </div>

          <p
            v-else-if="checkoutStore.paymentOptionsLoaded"
            class="checkout-notice"
          >
            当前暂无可用支付方式，请联系工作人员。
          </p>
          <p v-else class="checkout-notice">正在读取支付方式...</p>
        </section>
      </main>

      <section class="checkout-tip">
        <div>
          <h2>温馨提示</h2>
          <p>
            {{
              paymentHint ??
              "下一步将展示所选渠道二维码，请使用对应 App 扫码支付。"
            }}
          </p>
          <p v-if="!connectivityStore.isSaleNetworkReady">
            网络未就绪，当前不能创建订单。
          </p>
          <p v-if="!connectivityStore.ready?.canSell">
            设备暂时未准备好，当前不能创建订单。
          </p>
          <p v-if="checkoutStore.error">{{ checkoutStore.error }}</p>
        </div>
        <img :src="mascotListImage" alt="" aria-hidden="true" />
      </section>

      <button
        class="checkout-submit kiosk-touch-target"
        type="button"
        :disabled="!canSubmit"
        @click="submitOrder"
      >
        {{ submitButtonText }}
      </button>

      <nav class="checkout-nav" aria-label="自助购物功能">
        <span>
          <i aria-hidden="true">⌗</i>
          <strong>扫码购</strong>
          <small>扫码快捷购物</small>
        </span>
        <span>
          <i aria-hidden="true">▤</i>
          <strong>订单查询</strong>
          <small>查看订单状态</small>
        </span>
        <span>
          <i aria-hidden="true">券</i>
          <strong>优惠活动</strong>
          <small>超值优惠享不停</small>
        </span>
        <span>
          <i aria-hidden="true">♫</i>
          <strong>帮助中心</strong>
          <small>常见问题解答</small>
        </span>
      </nav>
    </section>

    <section v-else class="checkout-empty-state">
      <div>
        <h1>订单信息已失效</h1>
        <p>请返回商品列表重新选择商品。</p>
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
:global(.kiosk-shell:has(.checkout-page) > header),
:global(.kiosk-shell:has(.checkout-empty-state) > header) {
  display: none;
}

:global(.kiosk-shell:has(.checkout-page) > .kiosk-scroll) {
  width: 100%;
  height: 100%;
  margin-top: 0;
  padding-bottom: 0;
}

.checkout-page {
  position: relative;
  display: flex;
  width: 100%;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  align-items: center;
  overflow: hidden;
  margin: 0;
  padding: var(--machine-page-header-top) var(--machine-page-inline) 1rem;
  border: 0;
  border-radius: 0;
  background:
    radial-gradient(
      circle at 5% 8%,
      rgba(132, 154, 112, 0.12),
      transparent 34%
    ),
    radial-gradient(
      circle at 88% 0%,
      rgba(213, 197, 155, 0.16),
      transparent 30%
    ),
    linear-gradient(180deg, #fffdf8 0%, #fbf7ef 58%, #f4eddd 100%);
  color: #5b554b;
  box-shadow: none;
}

.checkout-page::after {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  height: 7rem;
  pointer-events: none;
  background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 620 118' preserveAspectRatio='none'%3E%3Cpath d='M0 58 C82 28 146 26 230 58 C319 91 390 96 475 62 C540 36 579 40 620 52 L620 118 L0 118 Z' fill='%23dfe8d6' fill-opacity='0.76'/%3E%3Cpath d='M0 82 C86 50 160 48 248 76 C326 101 402 98 477 76 C545 56 585 62 620 72 L620 118 L0 118 Z' fill='%23cbdcbe' fill-opacity='0.6'/%3E%3C/svg%3E")
    center bottom / 100% 100% no-repeat;
  content: "";
}

.checkout-header,
.checkout-back-row,
.checkout-title-row,
.checkout-main,
.checkout-tip,
.checkout-submit,
.checkout-nav {
  position: relative;
  z-index: 2;
  width: 100%;
}

.checkout-header {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: space-between;
}

.checkout-brand {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.checkout-brand img:first-child {
  height: clamp(36px, 5.9vw, 64px);
  width: auto;
  object-fit: contain;
}

.checkout-brand img:last-child {
  width: clamp(56px, 8.1vw, 88px);
  height: clamp(56px, 8.1vw, 88px);
  object-fit: contain;
}

.checkout-clock {
  color: #6f835f;
  text-align: right;
}

.checkout-clock p {
  font-family: Georgia, "Times New Roman", serif;
  font-size: clamp(2.25rem, 5.19vw, 3.5rem);
  font-weight: 700;
  line-height: 1;
}

.checkout-clock span {
  display: block;
  margin-top: clamp(0.25rem, 0.46vh, 0.55rem);
  font-size: clamp(0.75rem, 1.4vw, 0.95rem);
  letter-spacing: 0;
}

.checkout-back {
  display: inline-flex;
  width: fit-content;
  min-height: 48px;
  flex: 0 0 auto;
  align-items: center;
  gap: 0.75rem;
  border: 0;
  background: transparent;
  padding: 0;
  color: #6b6258;
  font-family: SimSun, "Songti SC", "Noto Serif CJK SC", serif;
  font-size: 1.35rem;
  font-weight: 700;
  box-shadow: none;
}

.checkout-back span {
  display: grid;
  width: 42px;
  height: 42px;
  place-items: center;
  border: 1px solid rgba(198, 187, 154, 0.76);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.72);
  color: #6f835f;
  font-size: 1.65rem;
  font-weight: 900;
  line-height: 1;
  box-shadow: 0 8px 18px rgba(102, 92, 64, 0.08);
}

.checkout-back-row {
  margin-top: clamp(2rem, 4.3vh, 5.15rem);
}

.checkout-title-row {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 1rem;
  margin-top: clamp(1.6rem, 3.05vh, 3.65rem);
}

.checkout-title-row p,
.checkout-amount p {
  color: #9a978f;
  font-size: 0.95rem;
  font-weight: 800;
  letter-spacing: 0.12em;
}

.checkout-title-row h1 {
  margin-top: 0.65rem;
  color: #6f835f;
  font-family: SimSun, "Songti SC", "Noto Serif CJK SC", serif;
  font-size: clamp(2.3rem, 5.6vw, 3.6rem);
  font-weight: 800;
  line-height: 1;
  letter-spacing: 0;
}

.checkout-amount {
  text-align: right;
}

.checkout-amount strong {
  display: block;
  margin-top: 0.5rem;
  color: #6f835f;
  font-family: Georgia, "Times New Roman", serif;
  font-size: clamp(2rem, 4.7vw, 3.05rem);
  line-height: 1;
}

.checkout-main {
  display: grid;
  min-height: 0;
  flex: 0 0 auto;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: clamp(0.75rem, 2vw, 1.05rem);
  margin-top: clamp(1.4rem, 2.2vh, 2.65rem);
}

.checkout-panel {
  min-height: 0;
  border: 1px solid rgba(219, 211, 191, 0.88);
  border-radius: 18px;
  background: rgba(255, 253, 248, 0.62);
  padding: clamp(1.1rem, 2.3vw, 1.5rem);
}

.checkout-panel h2 {
  color: #758568;
  font-size: 1.05rem;
  font-weight: 900;
  letter-spacing: 0.04em;
}

.product-summary {
  display: grid;
  grid-template-columns: clamp(7rem, 20vw, 10rem) 1fr;
  gap: clamp(0.9rem, 2.2vw, 1.3rem);
  margin-top: clamp(1.35rem, 2.3vh, 2.4rem);
}

.product-image {
  aspect-ratio: var(--product-display-aspect-ratio);
  overflow: hidden;
  border-radius: 12px;
  background:
    linear-gradient(
      180deg,
      rgba(255, 255, 255, 0.44),
      rgba(232, 222, 199, 0.26)
    ),
    #eee8dc;
}

.product-image img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.product-image img.product-image-fallback {
  padding: 1rem;
  object-fit: contain;
}

.product-copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
  padding-top: 0.8rem;
}

.product-copy h3 {
  color: #5a554d;
  font-size: clamp(1.2rem, 3vw, 1.7rem);
  font-weight: 900;
  line-height: 1.25;
}

.product-copy p {
  margin-top: 0.6rem;
  color: #8a8478;
  font-size: clamp(0.9rem, 2.1vw, 1.1rem);
}

.product-copy strong {
  margin-top: auto;
  color: #738665;
  font-family: Georgia, "Times New Roman", serif;
  font-size: clamp(1.25rem, 3.2vw, 1.75rem);
}

.payment-heading p {
  margin-top: 0.7rem;
  color: #9a9489;
  font-size: 0.82rem;
}

.payment-list {
  display: grid;
  gap: clamp(0.48rem, 1.05vh, 0.9rem);
  margin-top: clamp(1rem, 1.65vh, 1.55rem);
}

.payment-option {
  position: relative;
  display: grid;
  min-height: clamp(3.6rem, 5.25vh, 4.7rem);
  grid-template-columns: clamp(2.4rem, 6.4vw, 3.35rem) 1fr auto;
  align-items: center;
  gap: clamp(0.7rem, 1.9vw, 1rem);
  border: 1px solid rgba(219, 211, 191, 0.78);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.54);
  padding: clamp(0.5rem, 1.35vw, 0.75rem);
  color: #5a554d;
  text-align: left;
}

.payment-option:disabled {
  opacity: 0.46;
}

.payment-option-selected {
  border-color: rgba(119, 139, 103, 0.7);
  background: rgba(246, 251, 242, 0.76);
  box-shadow: inset 0 0 0 1px rgba(119, 139, 103, 0.18);
}

.payment-option-icon {
  display: grid;
  width: clamp(2.4rem, 6.4vw, 3.35rem);
  height: clamp(2.4rem, 6.4vw, 3.35rem);
  place-items: center;
  border-radius: 10px;
  background: #f5f6f1;
  color: #4a90e2;
  font-size: clamp(1.3rem, 3.4vw, 1.7rem);
  font-weight: 900;
}

.payment-option-icon[data-kind="wechat"] {
  color: #69ad55;
}

.payment-option-icon[data-kind="mock"],
.payment-option-icon[data-kind="code"],
.payment-option-icon[data-kind="qr"] {
  color: #758568;
}

.payment-option-icon img {
  width: 72%;
  height: 72%;
  object-fit: contain;
}

.payment-option-copy {
  display: grid;
  min-width: 0;
  gap: 0.12rem;
}

.payment-option-copy strong {
  overflow: hidden;
  font-size: clamp(0.98rem, 2.45vw, 1.2rem);
  font-weight: 900;
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.payment-option-copy small {
  overflow: hidden;
  color: #9a9489;
  font-size: clamp(0.68rem, 1.75vw, 0.82rem);
  line-height: 1.25;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.payment-recommended {
  border: 1px solid rgba(117, 133, 104, 0.35);
  border-radius: 999px;
  padding: 0.12rem 0.36rem;
  color: #758568;
  font-size: clamp(0.62rem, 1.55vw, 0.76rem);
  font-weight: 800;
}

.checkout-notice {
  margin-top: 1rem;
  border: 1px solid rgba(219, 211, 191, 0.78);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.48);
  padding: 1rem;
  color: #7a7368;
  font-size: 0.9rem;
}

.checkout-tip {
  display: flex;
  min-height: clamp(8.2rem, 12.7vh, 13rem);
  align-items: center;
  justify-content: space-between;
  margin-top: clamp(1.1rem, 2.15vh, 2.55rem);
  overflow: hidden;
  border: 1px solid rgba(219, 211, 191, 0.88);
  border-radius: 18px;
  background:
    url("data:image/svg+xml,%3Csvg width='88' height='132' viewBox='0 0 88 132' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' stroke='%23768b68' stroke-width='1.25' stroke-linecap='round' opacity='.22'%3E%3Cpath d='M52 130C49 96 52 56 68 12'/%3E%3Cpath d='M38 126c3-31 1-65-10-98'/%3E%3Cpath d='M61 53c10-11 19-16 25-17-4 8-12 14-25 17Z'/%3E%3Cpath d='M56 82c11-9 20-12 27-12-5 7-13 11-27 12Z'/%3E%3Cpath d='M33 60C21 50 12 46 4 45c5 8 15 13 29 15Z'/%3E%3C/g%3E%3C/svg%3E")
      left center / auto 100% no-repeat,
    rgba(255, 253, 248, 0.68);
  padding: clamp(1.2rem, 2.8vw, 1.8rem);
}

.checkout-tip h2 {
  color: #6f835f;
  font-size: clamp(1.05rem, 2.6vw, 1.35rem);
  font-weight: 900;
  letter-spacing: 0.08em;
}

.checkout-tip p {
  margin-top: 0.75rem;
  color: #8a8478;
  font-size: clamp(0.88rem, 2.15vw, 1.08rem);
  line-height: 1.55;
}

.checkout-tip img {
  width: clamp(7.3rem, 21vw, 11rem);
  height: auto;
  align-self: flex-end;
  margin: -1rem -1rem -1.35rem 1rem;
  transform: scaleX(-1);
}

.checkout-submit {
  min-height: clamp(4.6rem, 7vh, 6rem);
  margin-top: clamp(1rem, 2vh, 2rem);
  flex-shrink: 0;
  border-radius: 16px;
  background: linear-gradient(180deg, #819274, #687b5d);
  color: #fffdf7;
  font-size: clamp(1.2rem, 3vw, 1.55rem);
  font-weight: 900;
  letter-spacing: 0.04em;
  box-shadow: 0 12px 20px rgba(96, 115, 84, 0.18);
}

.checkout-submit:disabled {
  background: #c8c3b7;
  color: #f7f3ea;
  box-shadow: none;
}

.checkout-nav {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: clamp(0.75rem, 2vw, 1.2rem);
  margin-top: clamp(1rem, 2vh, 2rem);
  padding: 0 clamp(0.5rem, 4vw, 2.8rem);
}

.checkout-nav span {
  display: grid;
  justify-items: center;
  color: #837d70;
  text-align: center;
}

.checkout-nav i {
  display: grid;
  width: clamp(2.3rem, 6.5vw, 3.3rem);
  height: clamp(2.3rem, 6.5vw, 3.3rem);
  place-items: center;
  border: 1px solid rgba(194, 190, 174, 0.8);
  border-radius: 999px;
  background: rgba(255, 253, 248, 0.76);
  color: #718364;
  font-style: normal;
  font-weight: 900;
}

.checkout-nav strong {
  margin-top: 0.35rem;
  font-size: clamp(0.78rem, 2vw, 0.95rem);
  font-weight: 800;
}

.checkout-nav small {
  margin-top: 0.16rem;
  font-size: clamp(0.58rem, 1.55vw, 0.72rem);
}

.checkout-empty-state {
  display: grid;
  min-height: 100%;
  place-items: center;
  color: #5c554c;
  text-align: center;
}

.checkout-empty-state > div {
  width: min(100%, 28rem);
  border: 1px solid rgba(211, 203, 180, 0.82);
  border-radius: 20px;
  background: rgba(255, 253, 248, 0.76);
  padding: 2.4rem;
}

.checkout-empty-state h1 {
  font-size: 2rem;
  font-weight: 800;
}

.checkout-empty-state p {
  margin-top: 0.8rem;
  color: #746d63;
}

.checkout-empty-state button {
  margin-top: 1.6rem;
  border-radius: 999px;
  background: #6f835f;
  padding: 0.9rem 1.8rem;
  color: #fffdf8;
  font-weight: 800;
}

@container (max-width: 720px) {
  .checkout-page {
    padding: var(--machine-page-header-top) var(--machine-page-inline) 0.75rem;
  }

  .checkout-header,
  .checkout-back-row,
  .checkout-title-row,
  .checkout-main,
  .checkout-tip,
  .checkout-submit,
  .checkout-nav {
    width: 100%;
  }

  .checkout-title-row {
    margin-top: 1.5rem;
  }

  .checkout-main {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 0.6rem;
    margin-top: 1.1rem;
  }

  .checkout-panel {
    padding: 1rem;
  }

  .product-summary {
    grid-template-columns: 6.3rem 1fr;
    gap: 0.8rem;
  }

  .payment-option {
    min-height: 3.55rem;
    grid-template-columns: 2.2rem 1fr auto;
    gap: 0.55rem;
    padding: 0.5rem;
  }

  .payment-option-icon {
    width: 2.2rem;
    height: 2.2rem;
  }

  .checkout-tip {
    min-height: 7.2rem;
    padding: 1rem 1.1rem;
  }

  .checkout-tip img {
    width: 6.8rem;
  }

  .checkout-submit {
    min-height: 3.8rem;
    font-size: 1rem;
  }

  .checkout-nav {
    gap: 0.65rem;
    padding: 0 1.6rem;
  }
}
</style>
