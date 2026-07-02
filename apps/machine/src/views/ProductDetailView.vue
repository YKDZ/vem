<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import type { MachineCatalogVariantCandidate } from "@/types/catalog";

import iconSocksImage from "@/assets/home/icon-socks.png";
import iconTshirtImage from "@/assets/home/icon-tshirt.png";
import iconUnderwearImage from "@/assets/home/icon-underwear.png";
import listSloganImage from "@/assets/home/list-slogan.png";
import logoImage from "@/assets/home/logo.png";
import mascotListImage from "@/assets/home/mascot-list.png";
import mascotTopImage from "@/assets/home/mascot-top-cutout.png";
import { useKioskClock } from "@/composables/useKioskClock";
import KioskLayout from "@/layouts/KioskLayout.vue";
import { useCatalogStore } from "@/stores/catalog";
import { useCheckoutStore } from "@/stores/checkout";
import { formatCents } from "@/utils/format";

type VariantOption = {
  value: string | null;
  label: string;
  saleableStock: number;
};

const route = useRoute();
const router = useRouter();
const catalogStore = useCatalogStore();
const checkoutStore = useCheckoutStore();
const { clockText, dateText } = useKioskClock();

const selectedVariantId = ref<string | null>(null);

const catalogKey = computed(() => String(route.params.catalogKey ?? ""));
const item = computed(() => {
  const catalogItem = catalogStore.itemByCatalogKey(catalogKey.value);
  if (catalogItem) return catalogItem;
  if (checkoutStore.selectedItem?.catalogKey === catalogKey.value) {
    return checkoutStore.selectedItem;
  }
  return null;
});
const variantCandidates = computed(() => item.value?.variantCandidates ?? []);
const selectedVariant = computed(
  () =>
    variantCandidates.value.find(
      (variant) => variant.variantId === selectedVariantId.value,
    ) ??
    variantCandidates.value.find(variantIsSaleable) ??
    variantCandidates.value[0] ??
    null,
);
const selectedConcreteItem = computed(() => {
  const current = item.value;
  const variant = selectedVariant.value;
  if (!current || !variant) return null;
  return (
    catalogStore.saleableVariantItemFor(
      current.catalogKey,
      variant.variantId,
    ) ??
    (current.variantId === variant.variantId &&
    current.slotSalesState === "sale_ready" &&
    current.saleableStock > 0
      ? current
      : null)
  );
});
const canBuy = computed(
  () =>
    Boolean(selectedConcreteItem.value) &&
    selectedVariant.value?.slotSalesState === "sale_ready" &&
    (selectedVariant.value?.saleableStock ?? 0) > 0,
);
const productImageUrl = computed(
  () => selectedConcreteItem.value?.coverImageUrl ?? item.value?.coverImageUrl,
);
const categoryLabel = computed(() => item.value?.categoryName ?? "商品");
const productSummary = computed(() => {
  const targetGender = item.value?.targetGender;
  const genderText =
    targetGender === "male"
      ? "男款"
      : targetGender === "female"
        ? "女款"
        : "精选";
  const colorCount = colorOptions.value.length;
  return `${genderText} ｜ ${Math.max(colorCount, 1)}种颜色`;
});
const priceText = computed(() =>
  formatCents(selectedVariant.value?.priceCents ?? item.value?.priceCents ?? 0),
);
const stockText = computed(() => selectedVariant.value?.saleableStock ?? 0);
const skuText = computed(
  () => selectedVariant.value?.sku ?? item.value?.sku ?? "-",
);
const sizeOptions = computed(() =>
  uniqueVariantOptions(
    variantCandidates.value,
    (variant) => variant.size,
    "均码",
  ),
);
const colorOptions = computed(() => {
  const activeSize = selectedVariant.value?.size ?? null;
  return uniqueVariantOptions(
    variantCandidates.value.filter((variant) => variant.size === activeSize),
    (variant) => variant.color,
    "默认颜色",
  );
});
const materialText = computed(() => {
  const label = categoryLabel.value;
  if (label.includes("袜")) return "棉78% 聚酯纤维20% 氨纶2%";
  if (label.includes("内裤")) return "棉92% 氨纶8%";
  if (label.includes("T恤")) return "精梳棉95% 氨纶5%";
  return "亲肤棉混纺";
});
const functionText = computed(() => {
  const label = categoryLabel.value;
  if (label.includes("袜")) return "柔软亲肤 / 透气吸汗 / 四季可穿";
  if (label.includes("内裤")) return "贴身舒适 / 弹力包裹 / 日常可穿";
  if (label.includes("T恤")) return "轻柔透气 / 版型利落 / 易打理";
  return "柔软亲肤 / 透气舒适";
});
const fallbackImage = computed(() => {
  const label = categoryLabel.value;
  if (label.includes("内裤")) return iconUnderwearImage;
  if (label.includes("T恤")) return iconTshirtImage;
  return iconSocksImage;
});

const featureCards = [
  { label: "柔软亲肤", icon: "cotton" },
  { label: "透气吸汗", icon: "breathable" },
  { label: "耐磨耐穿", icon: "shield" },
] as const;

watch(
  variantCandidates,
  () => {
    selectedVariantId.value =
      variantCandidates.value.find(variantIsSaleable)?.variantId ??
      variantCandidates.value[0]?.variantId ??
      null;
  },
  { immediate: true },
);

function variantIsSaleable(variant: MachineCatalogVariantCandidate): boolean {
  return variant.slotSalesState === "sale_ready" && variant.saleableStock > 0;
}

function attributeKey(value: string | null): string {
  return value ?? "__default__";
}

function uniqueVariantOptions(
  variants: readonly MachineCatalogVariantCandidate[],
  valueFor: (variant: MachineCatalogVariantCandidate) => string | null,
  fallbackLabel: string,
): VariantOption[] {
  const options = new Map<string, VariantOption>();
  for (const variant of variants) {
    const value = valueFor(variant);
    const key = attributeKey(value);
    const current = options.get(key);
    options.set(key, {
      value,
      label: value ?? fallbackLabel,
      saleableStock: (current?.saleableStock ?? 0) + variant.saleableStock,
    });
  }
  return [...options.values()];
}

function pickVariant(candidates: MachineCatalogVariantCandidate[]): void {
  selectedVariantId.value =
    candidates.find(variantIsSaleable)?.variantId ??
    candidates[0]?.variantId ??
    selectedVariantId.value;
}

function selectSize(size: string | null): void {
  const currentColor = selectedVariant.value?.color ?? null;
  const candidates = variantCandidates.value.filter(
    (variant) => variant.size === size,
  );
  const preferred = candidates.find(
    (variant) => variant.color === currentColor && variantIsSaleable(variant),
  );
  pickVariant(preferred ? [preferred] : candidates);
}

function selectColor(color: string | null): void {
  const currentSize = selectedVariant.value?.size ?? null;
  pickVariant(
    variantCandidates.value.filter(
      (variant) => variant.size === currentSize && variant.color === color,
    ),
  );
}

async function purchase(): Promise<void> {
  const concreteItem = selectedConcreteItem.value;
  if (!concreteItem || !canBuy.value) return;
  checkoutStore.selectItem(concreteItem);
  await router.push("/checkout");
}
</script>

<template>
  <KioskLayout>
    <section v-if="item" class="product-detail-page">
      <div class="detail-mist detail-mist-left"></div>
      <div class="detail-mist detail-mist-right"></div>

      <header class="detail-header">
        <div class="detail-header-left">
          <button
            class="detail-back-button kiosk-touch-target"
            type="button"
            aria-label="返回"
            @click="router.push('/catalog')"
          >
            <span aria-hidden="true">‹</span>
          </button>
          <div class="detail-brand">
            <img :src="logoImage" alt="唐诗村" />
            <img :src="mascotTopImage" alt="" aria-hidden="true" />
          </div>
        </div>
        <div class="detail-time">
          <p>{{ clockText }}</p>
          <span>{{ dateText }}</span>
        </div>
      </header>

      <main class="detail-main">
        <section class="detail-image-card">
          <div class="detail-image-inner">
            <img
              :src="productImageUrl ?? fallbackImage"
              :alt="item.productName"
            />
            <span class="detail-bamboo" aria-hidden="true"></span>
            <span class="detail-image-count">1/5</span>
          </div>
        </section>

        <section class="detail-info">
          <div>
            <h1>{{ item.productName }}</h1>
            <p class="detail-summary">{{ productSummary }}</p>
            <span class="detail-small-ornament" aria-hidden="true"></span>
            <strong class="detail-price">{{ priceText }}</strong>
          </div>

          <div class="feature-panel">
            <div v-for="feature in featureCards" :key="feature.label">
              <span class="feature-icon" aria-hidden="true">
                <svg v-if="feature.icon === 'cotton'" viewBox="0 0 40 40">
                  <path
                    d="M20 9c4 0 7 3 7 7 4 0 7 3 7 7s-3 7-7 7H13c-4 0-7-3-7-7s3-7 7-7c0-4 3-7 7-7Z"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2.2"
                  />
                  <path
                    d="M20 30V17M14 24h12"
                    fill="none"
                    stroke="currentColor"
                    stroke-linecap="round"
                    stroke-width="2.2"
                  />
                </svg>
                <svg
                  v-else-if="feature.icon === 'breathable'"
                  viewBox="0 0 40 40"
                >
                  <path
                    d="M12 23v-8m8 13V10m8 13v-8M9 29c7 3 15 3 22 0"
                    fill="none"
                    stroke="currentColor"
                    stroke-linecap="round"
                    stroke-width="2.2"
                  />
                  <path
                    d="M12 15 9 18m3-3 3 3M20 10l-3 3m3-3 3 3M28 15l-3 3m3-3 3 3"
                    fill="none"
                    stroke="currentColor"
                    stroke-linecap="round"
                    stroke-width="2.2"
                  />
                </svg>
                <svg v-else viewBox="0 0 40 40">
                  <path
                    d="M20 6 32 11v8c0 8-5 13-12 16C13 32 8 27 8 19v-8l12-5Z"
                    fill="none"
                    stroke="currentColor"
                    stroke-linejoin="round"
                    stroke-width="2.2"
                  />
                  <path
                    d="m15 20 3 3 7-8"
                    fill="none"
                    stroke="currentColor"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2.4"
                  />
                </svg>
              </span>
              <p>{{ feature.label }}</p>
            </div>
          </div>

          <section class="detail-section">
            <h2>❀ 规格选择</h2>
            <p class="option-label">颜色</p>
            <div class="option-row">
              <button
                v-for="option in colorOptions"
                :key="attributeKey(option.value)"
                class="option-pill kiosk-touch-target"
                :class="{
                  'option-pill-active': selectedVariant?.color === option.value,
                }"
                type="button"
                :disabled="option.saleableStock <= 0"
                @click="selectColor(option.value)"
              >
                {{ option.label }}
              </button>
            </div>
            <p class="option-label">尺码</p>
            <div class="option-row">
              <button
                v-for="option in sizeOptions"
                :key="attributeKey(option.value)"
                class="option-pill kiosk-touch-target"
                :class="{
                  'option-pill-active': selectedVariant?.size === option.value,
                }"
                type="button"
                :disabled="option.saleableStock <= 0"
                @click="selectSize(option.value)"
              >
                {{ option.label }}
              </button>
            </div>
          </section>

          <section class="detail-section product-copy">
            <h2>❀ 商品信息</h2>
            <p>商品材质：{{ materialText }}</p>
            <p>商品尺码：{{ selectedVariant?.size ?? "均码" }}</p>
            <p>商品功能：{{ functionText }}</p>
            <p>洗涤建议：建议手洗，水温不超过30°C</p>
            <p>商品货号：{{ skuText }}</p>
          </section>

          <section class="detail-section stock-copy">
            <h2>♧ 商品库存</h2>
            <p>
              库存：<strong>{{ stockText }}</strong>
            </p>
          </section>
        </section>
      </main>

      <img
        :src="mascotListImage"
        alt=""
        class="detail-mascot pointer-events-none"
        aria-hidden="true"
      />

      <div class="detail-bottom-bar">
        <button
          class="detail-buy-button kiosk-touch-target"
          type="button"
          :disabled="!canBuy"
          @click="purchase"
        >
          {{ canBuy ? `立即购买 ${priceText}` : "该规格暂不可购买" }}
        </button>
      </div>

      <img
        :src="listSloganImage"
        alt="让温柔贴近 让善意发生"
        class="detail-slogan pointer-events-none"
      />
    </section>
    <section v-else class="detail-empty-state">
      <div>
        <h1>商品信息已失效</h1>
        <p>当前商品状态已更新，请返回商品列表重新选择。</p>
        <button
          class="kiosk-touch-target"
          type="button"
          @click="router.push('/catalog')"
        >
          返回商品列表
        </button>
      </div>
    </section>
  </KioskLayout>
</template>

<style scoped>
:global(.kiosk-shell:has(.product-detail-page) > header) {
  display: none;
}

:global(.kiosk-shell:has(.product-detail-page) > .kiosk-scroll) {
  margin-top: 0;
  padding-bottom: 0;
}

:global(.kiosk-shell:has(.detail-empty-state) > header) {
  display: none;
}

.detail-empty-state {
  display: grid;
  min-height: 100%;
  place-items: center;
  color: #5c554c;
  text-align: center;
}

.detail-empty-state > div {
  width: min(100%, 28rem);
  border: 1px solid rgba(211, 203, 180, 0.82);
  border-radius: 20px;
  background: rgba(255, 253, 248, 0.76);
  padding: 2.4rem;
}

.detail-empty-state h1 {
  font-size: 2rem;
  font-weight: 800;
}

.detail-empty-state p {
  margin-top: 0.8rem;
  color: #746d63;
}

.detail-empty-state button {
  margin-top: 1.6rem;
  border-radius: 999px;
  background: #6f835f;
  padding: 0.9rem 1.8rem;
  color: #fffdf8;
  font-weight: 800;
}

.product-detail-page {
  position: relative;
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  container-type: inline-size;
  overflow: hidden;
  margin: -1.25rem -1.5rem;
  padding: 1.5rem 1.7rem 1rem;
  border: 1px solid rgba(89, 83, 66, 0.2);
  border-radius: 20px;
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
  box-shadow: inset 0 0 0 2px rgba(255, 255, 255, 0.78);
}

.detail-header {
  position: relative;
  z-index: 5;
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: space-between;
}

.detail-header-left,
.detail-brand {
  display: flex;
  align-items: center;
}

.detail-header-left {
  gap: 0.68rem;
}

.detail-brand {
  gap: 0.75rem;
}

.detail-brand img:first-child {
  height: 2.35rem;
  width: auto;
  object-fit: contain;
}

.detail-brand img:last-child {
  width: 3.5rem;
  height: 3.5rem;
  object-fit: contain;
}

.detail-time {
  color: #6f835f;
  text-align: right;
}

.detail-time p {
  font-family: Georgia, "Times New Roman", serif;
  font-size: 2.35rem;
  font-weight: 700;
  line-height: 1;
}

.detail-time span {
  display: block;
  margin-top: 0.22rem;
  font-size: 0.62rem;
  letter-spacing: 0;
}

.detail-back-button {
  display: grid;
  width: 3rem;
  height: 3rem;
  min-width: 3rem;
  min-height: 3rem;
  flex: 0 0 auto;
  place-items: center;
  border: 1px solid rgba(198, 187, 154, 0.82);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.58);
  color: #879077;
  box-shadow: 0 3px 10px rgba(94, 87, 69, 0.06);
}

.detail-back-button span {
  margin-top: -0.08rem;
  font-size: 2rem;
  font-weight: 800;
  line-height: 1;
}

.detail-main {
  position: relative;
  z-index: 4;
  display: grid;
  min-height: 0;
  flex: 1;
  grid-template-columns: minmax(20rem, 45%) minmax(0, 1fr);
  gap: 2.7rem;
  margin-top: 1.25rem;
  padding: 0 1.8rem 7.4rem 1.2rem;
}

.detail-image-card {
  display: flex;
  min-height: 0;
  flex-direction: column;
  align-items: flex-start;
}

.detail-image-inner {
  position: relative;
  display: grid;
  width: 100%;
  aspect-ratio: 0.82;
  overflow: hidden;
  place-items: center;
  border: 1px solid rgba(211, 203, 180, 0.92);
  border-radius: 28px;
  background:
    linear-gradient(
      180deg,
      rgba(255, 254, 250, 0.86),
      rgba(249, 245, 236, 0.9)
    ),
    radial-gradient(
      circle at 50% 38%,
      rgba(255, 255, 255, 0.9),
      transparent 56%
    );
  box-shadow:
    inset 0 0 0 8px rgba(255, 255, 255, 0.5),
    0 16px 34px rgba(102, 92, 64, 0.08);
}

.detail-image-inner img {
  position: relative;
  z-index: 2;
  width: min(80%, 26rem);
  height: min(70%, 26rem);
  object-fit: contain;
  filter: drop-shadow(0 18px 18px rgba(81, 70, 51, 0.12));
}

.detail-bamboo {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 40%;
  height: 46%;
  opacity: 0.12;
  background: url("data:image/svg+xml,%3Csvg width='180' height='230' viewBox='0 0 180 230' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' stroke='%23768b68' stroke-width='2' stroke-linecap='round'%3E%3Cpath d='M94 226C86 164 95 90 132 10'/%3E%3Cpath d='M70 218C76 158 70 102 42 38'/%3E%3Cpath d='M118 88c22-20 42-28 58-30-10 16-28 26-58 30Z'/%3E%3Cpath d='M108 143c24-18 46-24 64-23-14 14-32 21-64 23Z'/%3E%3Cpath d='M59 102C34 84 16 77 2 78c12 14 33 22 57 24Z'/%3E%3C/g%3E%3C/svg%3E")
    center / contain no-repeat;
}

.detail-image-count {
  position: absolute;
  right: 1.4rem;
  bottom: 1.1rem;
  z-index: 3;
  min-width: 58px;
  border-radius: 999px;
  background: rgba(124, 125, 110, 0.52);
  color: #fffdf7;
  font-size: 1rem;
  line-height: 2rem;
  text-align: center;
}

.detail-info {
  min-height: 0;
  overflow-y: auto;
  padding-right: 0.35rem;
}

.detail-info h1 {
  color: #474039;
  font-family: SimSun, "Songti SC", "Noto Serif CJK SC", serif;
  font-size: 2.15rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  line-height: 1.1;
  word-break: keep-all;
}

.detail-summary {
  margin-top: 1rem;
  color: #827b70;
  font-size: 1.12rem;
}

.detail-small-ornament {
  display: block;
  width: 5.2rem;
  height: 1.1rem;
  margin-top: 1.2rem;
  color: #c9b989;
  background: url("data:image/svg+xml,%3Csvg width='92' height='18' viewBox='0 0 92 18' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' stroke='%23c9b989' stroke-width='1.7'%3E%3Cpath d='M42 9h44'/%3E%3Cpath d='M50 13c15 0 21-8 5-8' stroke-linecap='round'/%3E%3Cpath d='M15 4c5 0 9 4 9 9M15 4c-5 0-9 4-9 9M15 4c0-5-4-7-7-1M15 4c0-5 4-7 7-1'/%3E%3C/g%3E%3C/svg%3E")
    left center / contain no-repeat;
}

.detail-price {
  display: block;
  margin-top: 1rem;
  color: #6f835f;
  font-family: Georgia, "Times New Roman", serif;
  font-size: 2.05rem;
  line-height: 1;
}

.feature-panel {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.8rem;
  margin-top: 2.2rem;
  border: 1px solid rgba(211, 203, 180, 0.85);
  border-radius: 20px;
  background: rgba(255, 253, 248, 0.55);
  padding: 1.1rem 1rem;
}

.feature-panel div {
  text-align: center;
}

.feature-icon {
  display: grid;
  width: 44px;
  height: 44px;
  margin: 0 auto 0.35rem;
  place-items: center;
  color: #738462;
}

.feature-icon svg {
  width: 40px;
  height: 40px;
}

.feature-panel p {
  color: #6d665b;
  font-size: 0.95rem;
}

.detail-section {
  margin-top: 2.2rem;
}

.detail-section h2 {
  color: #5f584f;
  font-family: SimSun, "Songti SC", "Noto Serif CJK SC", serif;
  font-size: 1.2rem;
  font-weight: 700;
  letter-spacing: 0.08em;
}

.option-label {
  margin-top: 1.15rem;
  color: #7f776c;
  font-size: 1rem;
}

.option-row {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  margin-top: 0.65rem;
}

.option-pill {
  min-width: 96px;
  min-height: 46px;
  border: 1px solid rgba(211, 203, 180, 0.88);
  border-radius: 999px;
  background: rgba(255, 253, 248, 0.62);
  color: #625b52;
  font-family: SimSun, "Songti SC", "Noto Serif CJK SC", serif;
  font-size: 1.04rem;
  font-weight: 700;
}

.option-pill-active {
  border-color: transparent;
  background: linear-gradient(180deg, #758868, #627655);
  color: #fffdf7;
}

.option-pill:disabled {
  opacity: 0.35;
}

.product-copy p,
.stock-copy p {
  margin-top: 0.85rem;
  color: #766f65;
  font-size: 1rem;
  line-height: 1.6;
}

.stock-copy strong {
  color: #6f835f;
  font-family: Georgia, "Times New Roman", serif;
  font-size: 1.4rem;
}

.detail-mascot {
  position: absolute;
  bottom: 0.72rem;
  left: 0.6rem;
  z-index: 4;
  width: 11.2rem;
  height: 18rem;
  object-fit: contain;
  object-position: left bottom;
}

.detail-bottom-bar {
  position: absolute;
  right: 2.1rem;
  bottom: 4.35rem;
  left: 18.4rem;
  z-index: 6;
  display: grid;
  min-height: 78px;
  grid-template-columns: minmax(220px, 330px);
  gap: 1.2rem;
  align-items: center;
  justify-content: center;
}

.detail-buy-button {
  min-height: 70px;
  border-radius: 999px;
  background: linear-gradient(180deg, #758868, #627655);
  color: #fffdf7;
  font-family: SimSun, "Songti SC", "Noto Serif CJK SC", serif;
  font-size: 1.38rem;
  font-weight: 700;
  box-shadow: 0 14px 24px rgba(82, 101, 65, 0.2);
}

.detail-buy-button:disabled {
  background: rgba(172, 170, 153, 0.65);
}

.detail-slogan {
  position: absolute;
  right: 0;
  bottom: 0.8rem;
  left: 0;
  z-index: 6;
  width: 360px;
  max-width: calc(100% - 2rem);
  height: auto;
  margin: 0 auto;
  object-fit: contain;
}

.detail-mist {
  position: absolute;
  z-index: 0;
  pointer-events: none;
  border-radius: 999px;
  opacity: 0.55;
}

.detail-mist-left {
  bottom: 1.5rem;
  left: -7rem;
  width: 26rem;
  height: 10rem;
  background: rgba(131, 157, 126, 0.18);
  filter: blur(28px);
}

.detail-mist-right {
  right: -10rem;
  bottom: 6rem;
  width: 30rem;
  height: 13rem;
  background: rgba(206, 194, 156, 0.24);
  filter: blur(34px);
}

@container (max-width: 720px) {
  .product-detail-page {
    margin: -1.25rem -1.5rem;
    padding: 0.95rem 1rem 0.8rem;
  }

  .detail-header {
    align-items: center;
  }

  .detail-brand img:first-child {
    height: 1.85rem;
  }

  .detail-brand img:last-child {
    width: 2.6rem;
    height: 2.6rem;
  }

  .detail-time p {
    font-size: 2rem;
  }

  .detail-time span {
    font-size: 0.72rem;
  }

  .detail-back-button {
    width: 3rem;
    height: 3rem;
  }

  .detail-back-button span {
    font-size: 1.75rem;
  }

  .detail-main {
    display: grid;
    grid-template-columns: minmax(0, 46%) minmax(0, 54%);
    gap: 1rem;
    min-height: 0;
    overflow-y: auto;
    margin-top: 1rem;
    padding: 0 0.2rem 10rem;
  }

  .detail-image-card {
    width: 100%;
    margin: 0;
  }

  .detail-image-inner {
    aspect-ratio: 0.86;
    border-radius: 20px;
  }

  .detail-image-inner img {
    width: min(78%, 13rem);
    height: min(70%, 13rem);
  }

  .detail-image-count {
    right: 1rem;
    bottom: 0.9rem;
    min-width: 50px;
    font-size: 0.9rem;
    line-height: 1.75rem;
  }

  .detail-info {
    min-width: 0;
    overflow: visible;
    margin-top: 0;
    padding: 0 0.1rem;
  }

  .detail-info h1 {
    font-size: 1.38rem;
    letter-spacing: 0.04em;
  }

  .detail-summary {
    margin-top: 0.45rem;
    font-size: 0.82rem;
  }

  .detail-small-ornament {
    margin-top: 0.7rem;
  }

  .detail-price {
    margin-top: 0.55rem;
    font-size: 1.45rem;
  }

  .feature-panel {
    gap: 0.25rem;
    margin-top: 0.95rem;
    border-radius: 14px;
    padding: 0.55rem 0.35rem;
  }

  .feature-icon {
    width: 34px;
    height: 34px;
  }

  .feature-icon svg {
    width: 32px;
    height: 32px;
  }

  .feature-panel p {
    font-size: 0.68rem;
  }

  .detail-section {
    margin-top: 1rem;
  }

  .detail-section h2 {
    font-size: 0.92rem;
  }

  .option-label {
    margin-top: 0.85rem;
    font-size: 0.88rem;
  }

  .option-row {
    gap: 0.6rem;
    margin-top: 0.45rem;
  }

  .option-pill {
    min-width: 62px;
    min-height: 34px;
    font-size: 0.8rem;
  }

  .product-copy p,
  .stock-copy p {
    margin-top: 0.38rem;
    font-size: 0.72rem;
    line-height: 1.42;
  }

  .product-copy {
    max-height: 8.5rem;
    overflow-y: auto;
    padding-right: 0.2rem;
  }

  .detail-mascot {
    bottom: 0.6rem;
    left: 0.35rem;
    width: 7.4rem;
    height: 11.8rem;
    opacity: 0.96;
  }

  .detail-bottom-bar {
    right: 0.9rem;
    bottom: 3.75rem;
    left: 8.1rem;
    min-height: 58px;
    grid-template-columns: minmax(130px, 180px);
    gap: 0.55rem;
    justify-content: center;
  }

  .detail-buy-button {
    min-height: 56px;
    padding: 0 0.7rem;
    font-size: 1rem;
    white-space: nowrap;
  }

  .detail-slogan {
    bottom: 0.55rem;
    width: 250px;
  }
}
</style>
