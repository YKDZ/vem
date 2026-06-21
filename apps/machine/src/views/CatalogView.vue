<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRouter } from "vue-router";

import type { CatalogTopCategoryKey } from "@/catalog/view-model";
import type { MachineCatalogItem } from "@/types/catalog";

import carouselImage1 from "@/assets/home/carousel-1.jpg";
import carouselImage2 from "@/assets/home/carousel-2.jpg";
import carouselImage3 from "@/assets/home/carousel-3.jpg";
import iconSocksImage from "@/assets/home/icon-socks.png";
import iconTshirtImage from "@/assets/home/icon-tshirt.png";
import iconUnderwearImage from "@/assets/home/icon-underwear.png";
import logoImage from "@/assets/home/logo.png";
import mascotBottomImage from "@/assets/home/mascot-bottom.png";
import mascotTopImage from "@/assets/home/mascot-top-cutout.png";
import sloganCalligraphyImage from "@/assets/home/slogan-calligraphy.png";
import {
  firstItemInGroups,
  groupItemsByTopCategory,
  groupSubcategories,
} from "@/catalog/view-model";
import ProductTile from "@/components/catalog/ProductTile.vue";
import ProductDetailPanel from "@/components/product/ProductDetailPanel.vue";
import { useVisionRecommendations } from "@/composables/useVisionRecommendations";
import KioskLayout from "@/layouts/KioskLayout.vue";
import { useCatalogStore } from "@/stores/catalog";
import { useCheckoutStore } from "@/stores/checkout";
import { useConnectivityStore } from "@/stores/connectivity";

const router = useRouter();
const connectivityStore = useConnectivityStore();
const catalogStore = useCatalogStore();
const checkoutStore = useCheckoutStore();
const { currentProfile } = useVisionRecommendations();
const READINESS_REFRESH_INTERVAL_MS = 5000;
const CLOCK_REFRESH_INTERVAL_MS = 30_000;

const selectedTopCategoryKey = ref<CatalogTopCategoryKey | null>(null);
const selectedCatalogKey = ref<string | null>(null);
const activeCarouselIndex = ref(0);
const now = ref(new Date());
let readinessRefreshTimer: number | null = null;
let readinessRefreshInFlight: Promise<void> | null = null;
let clockTimer: number | null = null;

const carouselSlides = [
  carouselImage1,
  carouselImage2,
  carouselImage3,
] as const;
const homeCategoryMeta: Record<
  CatalogTopCategoryKey,
  { label: string; english: string; icon: string }
> = {
  socks: { label: "袜子", english: "SOCKS", icon: iconSocksImage },
  underwear: { label: "内裤", english: "UNDERWEAR", icon: iconUnderwearImage },
  tshirts: { label: "T恤", english: "T-SHIRT", icon: iconTshirtImage },
};
const quickActions = [
  { label: "扫码购", description: "扫码快速购物", icon: "scan" },
  { label: "订单查询", description: "查看订单状态", icon: "order" },
  { label: "优惠活动", description: "超值优惠享不停", icon: "coupon" },
  { label: "帮助中心", description: "常见问题解答", icon: "help" },
] as const;

const canDisplayAsSaleReady = computed(
  () => connectivityStore.isSaleNetworkReady,
);
const categoryGroups = computed(() =>
  groupItemsByTopCategory(catalogStore.availableItems),
);
const activeTopCategory = computed(() =>
  categoryGroups.value.find(
    (group) => group.key === selectedTopCategoryKey.value,
  ),
);
const subcategoryGroups = computed(() =>
  groupSubcategories(activeTopCategory.value?.items ?? []),
);
const selectedItem = computed(() => {
  const key = selectedCatalogKey.value;
  if (!key) return firstItemInGroups(subcategoryGroups.value);
  return (
    activeTopCategory.value?.items.find((item) => item.catalogKey === key) ??
    firstItemInGroups(subcategoryGroups.value)
  );
});
const customerReadinessMessage = computed(() => {
  if (canDisplayAsSaleReady.value) return null;
  return (
    connectivityStore.saleReadinessBlockingMessages[0] ??
    "设备暂时不可购买，请稍后再试。"
  );
});
const clockText = computed(() =>
  now.value.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }),
);
const dateText = computed(() =>
  now.value.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long",
  }),
);

watch(
  [activeTopCategory, subcategoryGroups],
  () => {
    const items = activeTopCategory.value?.items ?? [];
    if (
      selectedCatalogKey.value &&
      items.some((item) => item.catalogKey === selectedCatalogKey.value)
    ) {
      return;
    }
    selectedCatalogKey.value =
      firstItemInGroups(subcategoryGroups.value)?.catalogKey ?? null;
  },
  { immediate: true },
);

function shouldEnterMaintenance(): boolean {
  return (
    connectivityStore.ready?.canSell === false &&
    connectivityStore.ready.suggestedRoute === "maintenance"
  );
}

async function refreshReadinessAndRoute(): Promise<void> {
  if (readinessRefreshInFlight) {
    return readinessRefreshInFlight;
  }
  readinessRefreshInFlight = connectivityStore
    .refresh()
    .then(async () => {
      if (shouldEnterMaintenance()) {
        await router.replace("/maintenance");
      }
    })
    .catch(() => undefined)
    .finally(() => {
      readinessRefreshInFlight = null;
    });
  return readinessRefreshInFlight;
}

function startReadinessAutoRefresh(): void {
  stopReadinessAutoRefresh();
  void refreshReadinessAndRoute();
  readinessRefreshTimer = window.setInterval(() => {
    void refreshReadinessAndRoute();
  }, READINESS_REFRESH_INTERVAL_MS);
}

function stopReadinessAutoRefresh(): void {
  if (readinessRefreshTimer !== null) {
    window.clearInterval(readinessRefreshTimer);
    readinessRefreshTimer = null;
  }
}

function startClock(): void {
  stopClock();
  now.value = new Date();
  clockTimer = window.setInterval(() => {
    now.value = new Date();
  }, CLOCK_REFRESH_INTERVAL_MS);
}

function stopClock(): void {
  if (clockTimer !== null) {
    window.clearInterval(clockTimer);
    clockTimer = null;
  }
}

function previousSlide(): void {
  activeCarouselIndex.value =
    (activeCarouselIndex.value + carouselSlides.length - 1) %
    carouselSlides.length;
}

function nextSlide(): void {
  activeCarouselIndex.value =
    (activeCarouselIndex.value + 1) % carouselSlides.length;
}

function selectTopCategory(key: CatalogTopCategoryKey): void {
  selectedTopCategoryKey.value = key;
  selectedCatalogKey.value =
    firstItemInGroups(
      groupSubcategories(
        categoryGroups.value.find((group) => group.key === key)?.items ?? [],
      ),
    )?.catalogKey ?? null;
}

function selectProduct(item: MachineCatalogItem): void {
  selectedCatalogKey.value = item.catalogKey;
}

function backToHome(): void {
  selectedTopCategoryKey.value = null;
  selectedCatalogKey.value = null;
}

async function goCheckout(item: MachineCatalogItem): Promise<void> {
  checkoutStore.selectItem(item);
  await router.push("/checkout");
}

onMounted(() => {
  catalogStore.startAutoRefresh();
  startReadinessAutoRefresh();
  startClock();
});

onUnmounted(() => {
  catalogStore.stopAutoRefresh();
  stopReadinessAutoRefresh();
  stopClock();
});
</script>

<template>
  <KioskLayout>
    <section
      v-if="!selectedTopCategoryKey"
      class="catalog-home relative flex min-h-0 flex-1 flex-col overflow-hidden px-7 py-6"
    >
      <div class="home-mist home-mist-left"></div>
      <div class="home-mist home-mist-right"></div>

      <header class="relative z-10 flex shrink-0 items-start justify-between">
        <div class="flex items-center gap-3">
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
          <p class="font-serif text-4xl leading-none font-bold">
            {{ clockText }}
          </p>
          <p class="mt-1 text-xs tracking-wide">{{ dateText }}</p>
        </div>
      </header>

      <div
        class="home-carousel-shell relative z-10 mt-6 shrink-0 overflow-hidden rounded-[26px] border border-[#ded6c2] bg-[#f8f3e8] p-2 shadow-[0_16px_40px_rgba(101,94,71,0.12)]"
      >
        <div class="relative aspect-[2.32/1] overflow-hidden rounded-[20px]">
          <img
            :src="carouselSlides[activeCarouselIndex]"
            alt="轮播展示"
            class="h-full w-full object-cover"
          />
          <button
            class="carousel-arrow left-3"
            type="button"
            aria-label="上一张"
            @click="previousSlide"
          >
            ‹
          </button>
          <button
            class="carousel-arrow right-3"
            type="button"
            aria-label="下一张"
            @click="nextSlide"
          >
            ›
          </button>
          <div
            class="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-3"
          >
            <button
              v-for="(_, index) in carouselSlides"
              :key="index"
              class="carousel-dot rounded-full transition"
              :class="
                index === activeCarouselIndex ? 'bg-[#6d815d]' : 'bg-[#b9bca6]'
              "
              type="button"
              :aria-label="`切换到第 ${index + 1} 张`"
              @click="activeCarouselIndex = index"
            ></button>
          </div>
        </div>
      </div>

      <p
        v-if="customerReadinessMessage"
        class="home-readiness-message relative z-10 mt-3 shrink-0 rounded-2xl border border-[#d8cfb9] bg-white/80 p-3 text-sm text-[#5f644f]"
      >
        {{ customerReadinessMessage }}
      </p>

      <div
        class="home-category-heading relative z-10 mt-5 flex shrink-0 items-center justify-center gap-3 text-[#7b8d67]"
      >
        <span class="title-ornament title-ornament-left"></span>
        <h2 class="category-section-title">请选择商品类别</h2>
        <span class="title-ornament title-ornament-right"></span>
      </div>

      <div
        v-if="categoryGroups.some((group) => group.items.length > 0)"
        class="home-category-grid relative z-10 mt-5 grid shrink-0 grid-cols-3 gap-4"
      >
        <button
          v-for="group in categoryGroups"
          :key="group.key"
          class="home-category-card kiosk-touch-target"
          type="button"
          :disabled="group.items.length === 0"
          @click="selectTopCategory(group.key)"
        >
          <img
            :src="homeCategoryMeta[group.key].icon"
            alt=""
            class="category-illustration"
            aria-hidden="true"
          />
          <span class="category-title-text mt-3 block text-[#4b3f34]">
            {{ homeCategoryMeta[group.key].label }}
          </span>
          <span class="mt-2 block text-xs tracking-[0.2em] text-[#c2b8a6]">
            {{ homeCategoryMeta[group.key].english }}
          </span>
          <span class="home-category-action">点击选购 ›</span>
        </button>
      </div>

      <section
        v-else
        class="home-empty-state relative z-10 mt-6 flex min-h-0 flex-1 items-center justify-center rounded-2xl border border-[#ded6c2] bg-white/80 p-8 text-center text-[#6b735e]"
      >
        暂无可售商品
      </section>

      <div
        class="home-quick-grid relative z-30 mt-7 grid shrink-0 grid-cols-4 gap-2 pr-28"
      >
        <button
          v-for="action in quickActions"
          :key="action.label"
          class="quick-action"
          type="button"
        >
          <span class="quick-action-icon" aria-hidden="true">
            <svg v-if="action.icon === 'scan'" viewBox="0 0 32 32">
              <path
                d="M6 12V6h6M20 6h6v6M26 20v6h-6M12 26H6v-6M11 16h10M16 11v10"
                fill="none"
                stroke="currentColor"
                stroke-linecap="round"
                stroke-width="2.4"
              />
            </svg>
            <svg v-else-if="action.icon === 'order'" viewBox="0 0 32 32">
              <path
                d="M11 7h10M10 5h12v22H10zM13 14h8M13 19h8"
                fill="none"
                stroke="currentColor"
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2.4"
              />
            </svg>
            <svg v-else-if="action.icon === 'coupon'" viewBox="0 0 32 32">
              <path
                d="M6 11h20v4a3 3 0 0 0 0 6v4H6v-4a3 3 0 0 0 0-6v-4Z"
                fill="none"
                stroke="currentColor"
                stroke-linejoin="round"
                stroke-width="2.4"
              />
              <path
                d="M13 18h6"
                stroke="currentColor"
                stroke-linecap="round"
                stroke-width="2.4"
              />
            </svg>
            <svg v-else viewBox="0 0 32 32">
              <path
                d="M9 18v-3a7 7 0 0 1 14 0v3M9 18H7v6h4v-6H9Zm14 0h2v6h-4v-6h2Z"
                fill="none"
                stroke="currentColor"
                stroke-linejoin="round"
                stroke-width="2.4"
              />
            </svg>
          </span>
          <span class="mt-2 block font-semibold text-[#5f6e55] text-base">
            {{ action.label }}
          </span>
          <span
            class="mt-1 block rounded-full bg-[#fbf7eb]/85 px-1.5 text-[10px] text-[#8f8879]"
          >
            {{ action.description }}
          </span>
        </button>
      </div>

      <img
        :src="sloganCalligraphyImage"
        alt="让温柔生长，让善意发生"
        class="home-slogan pointer-events-none absolute bottom-[-0.35rem] left-8 z-[2] w-36 opacity-20"
      />
      <img
        :src="mascotBottomImage"
        alt=""
        class="home-bottom-mascot pointer-events-none absolute right-0 bottom-1 z-[2] w-32"
        aria-hidden="true"
      />
      <div class="home-hills" aria-hidden="true"></div>
    </section>

    <section v-else class="flex min-h-0 flex-1 flex-col gap-4">
      <div class="flex shrink-0 items-center justify-between gap-4">
        <button
          class="kiosk-touch-target rounded-lg border border-neutral-300 bg-white px-4 py-2 font-bold text-neutral-950"
          type="button"
          @click="backToHome"
        >
          返回
        </button>
        <h2 class="text-3xl font-black text-neutral-950">
          {{ activeTopCategory?.label }}
        </h2>
      </div>

      <p
        v-if="customerReadinessMessage"
        class="shrink-0 rounded-lg border border-neutral-300 bg-white p-4 text-neutral-800"
      >
        {{ customerReadinessMessage }}
      </p>

      <div
        class="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(15rem,38%)] gap-4"
      >
        <div
          class="kiosk-scroll min-h-0 overflow-y-auto rounded-lg border border-neutral-200 bg-neutral-50 p-4"
        >
          <section
            v-for="group in subcategoryGroups"
            :key="group.key"
            class="mt-6 first:mt-0"
          >
            <h3 class="mb-3 text-xl font-black text-neutral-950">
              {{ group.label }}
            </h3>
            <div class="grid grid-cols-1 gap-3">
              <ProductTile
                v-for="item in group.items"
                :key="item.catalogKey"
                :item="item"
                :selected="item.catalogKey === selectedItem?.catalogKey"
                @select="selectProduct"
              />
            </div>
          </section>
        </div>

        <ProductDetailPanel
          v-if="selectedItem"
          :key="selectedItem.catalogKey"
          :item="selectedItem"
          :profile="currentProfile"
          @purchase="goCheckout"
        />
      </div>
    </section>
  </KioskLayout>
</template>

<style scoped>
:global(.kiosk-shell:has(.catalog-home) > header) {
  display: none;
}

:global(.kiosk-shell:has(.catalog-home)) {
  padding: 0;
}

:global(.kiosk-shell:has(.catalog-home) > .kiosk-scroll) {
  margin-top: 0;
  padding-bottom: 0;
}

.catalog-home {
  --home-inline: clamp(28px, 4.82vw, 52px);
  --home-block-start: clamp(24px, 3.75vh, 72px);
  --home-block-end: clamp(24px, 2.3vh, 44px);
  --home-carousel-gap: clamp(24px, 2.92vh, 56px);
  --home-heading-gap: clamp(20px, 3.02vh, 58px);
  --home-category-gap: clamp(20px, 2.19vh, 42px);
  --home-quick-gap: clamp(28px, 3.96vh, 76px);
  --home-card-height: clamp(268px, 29.2vh, 560px);
  --home-hills-height: clamp(118px, 9.9vh, 190px);
  display: grid;
  grid-template-rows: auto auto auto auto auto auto minmax(0, 1fr);
  align-content: start;
  width: 100%;
  padding: var(--home-block-start) var(--home-inline) var(--home-block-end);
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
}

.catalog-home > header {
  grid-row: 1;
}

.catalog-home > header img[alt="唐诗村"] {
  height: clamp(36px, 5.9vw, 64px);
}

.catalog-home > header img[aria-hidden="true"] {
  width: clamp(56px, 8.1vw, 88px);
  height: clamp(56px, 8.1vw, 88px);
}

.catalog-home > header p:first-child {
  font-size: clamp(2.25rem, 5.19vw, 3.5rem);
}

.catalog-home > header p:last-child {
  margin-top: clamp(0.25rem, 0.46vh, 0.55rem);
  font-size: clamp(0.75rem, 1.4vw, 0.95rem);
}

.home-carousel-shell {
  grid-row: 2;
  margin-top: var(--home-carousel-gap);
  padding: clamp(8px, 0.93vw, 10px);
  border-radius: clamp(26px, 2.8vw, 30px);
}

.home-carousel-shell > div {
  border-radius: clamp(20px, 2.22vw, 24px);
}

.home-readiness-message {
  grid-row: 3;
  margin-top: clamp(12px, 1.04vh, 20px);
}

.home-category-heading {
  grid-row: 4;
  margin-top: var(--home-heading-gap);
  gap: clamp(12px, 1.85vw, 20px);
}

.home-category-grid,
.home-empty-state {
  grid-row: 5;
  margin-top: var(--home-category-gap);
}

.home-category-grid {
  gap: clamp(16px, 2.41vw, 26px);
}

.home-quick-grid {
  grid-row: 6;
  margin-top: var(--home-quick-gap);
  gap: clamp(8px, 1.67vw, 18px);
  padding-right: clamp(112px, 20.4vw, 220px);
}

.home-mist {
  position: absolute;
  z-index: 0;
  pointer-events: none;
  border-radius: 999px;
  opacity: 0.55;
}

.home-mist-left {
  bottom: 1.5rem;
  left: -7rem;
  width: 26rem;
  height: 10rem;
  background: rgba(131, 157, 126, 0.18);
  filter: blur(28px);
}

.home-mist-right {
  right: -10rem;
  bottom: 6rem;
  width: 30rem;
  height: 13rem;
  background: rgba(206, 194, 156, 0.24);
  filter: blur(34px);
}

.carousel-arrow {
  position: absolute;
  top: 50%;
  display: grid;
  width: clamp(38px, 5.19vw, 56px);
  height: clamp(38px, 5.19vw, 56px);
  min-height: clamp(38px, 5.19vw, 56px);
  transform: translateY(-50%);
  place-items: center;
  border-radius: 999px;
  background: rgba(112, 133, 95, 0.86);
  color: #fffdf5;
  font-size: clamp(2.1rem, 4.45vw, 3rem);
  line-height: 1;
  box-shadow: 0 8px 22px rgba(61, 75, 49, 0.18);
}

.carousel-dot {
  width: clamp(10px, 1.3vw, 14px);
  height: clamp(10px, 1.3vw, 14px);
  min-height: clamp(10px, 1.3vw, 14px);
}

.title-ornament {
  position: relative;
  width: clamp(76px, 11.48vw, 124px);
  height: clamp(14px, 2.04vw, 22px);
  color: #c9b989;
}

.title-ornament::before,
.title-ornament::after {
  position: absolute;
  top: 50%;
  content: "";
  transform: translateY(-50%);
}

.title-ornament::before {
  width: clamp(52px, 7.96vw, 86px);
  height: 1px;
  background: currentColor;
}

.title-ornament::after {
  width: clamp(10px, 1.48vw, 16px);
  height: clamp(10px, 1.48vw, 16px);
  border: 1.5px solid currentColor;
  border-radius: 999px 999px 999px 2px;
  transform: translateY(-50%) rotate(45deg);
}

.title-ornament-left::before {
  right: 0;
}

.title-ornament-left::after {
  left: 10px;
}

.title-ornament-right::before {
  left: 0;
}

.title-ornament-right::after {
  right: 10px;
}

.category-section-title {
  font-family:
    "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", "Source Han Sans SC",
    sans-serif;
  font-size: clamp(1.38rem, 3.19vw, 2.15rem);
  font-weight: 700;
  letter-spacing: 0.12em;
  line-height: 1;
}

.home-category-card {
  position: relative;
  display: flex;
  height: var(--home-card-height);
  min-height: 0;
  flex-direction: column;
  align-items: center;
  overflow: hidden;
  border: 1px solid rgba(189, 178, 146, 0.65);
  border-radius: clamp(20px, 2.22vw, 24px);
  background:
    linear-gradient(
      180deg,
      rgba(255, 255, 255, 0.92),
      rgba(252, 249, 239, 0.9)
    ),
    radial-gradient(
      circle at 85% 86%,
      rgba(126, 145, 104, 0.2),
      transparent 32%
    );
  padding: clamp(26px, 4.26vh, 46px) clamp(14px, 1.85vw, 20px)
    clamp(20px, 3.15vh, 34px);
  text-align: center;
  box-shadow: 0 14px 28px rgba(102, 92, 64, 0.1);
}

.home-category-card::before {
  position: absolute;
  right: clamp(-34px, -3.15vw, -24px);
  bottom: clamp(-12px, -1.11vw, -8px);
  width: clamp(122px, 17.59vw, 190px);
  height: clamp(82px, 11.85vw, 128px);
  content: "";
  background: rgba(126, 145, 104, 0.12);
  border-radius: 65% 35% 0 0;
}

.home-category-card:disabled {
  opacity: 0.52;
}

.category-illustration {
  width: clamp(116px, 17.6vw, 190px);
  height: clamp(116px, 17.6vw, 190px);
  object-fit: contain;
  filter: drop-shadow(0 8px 10px rgba(80, 92, 66, 0.08));
}

.category-title-text {
  font-family:
    "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", "Source Han Sans SC",
    sans-serif;
  margin-top: clamp(12px, 1.88vh, 36px);
  font-size: clamp(1.72rem, 4vw, 2.7rem);
  font-weight: 700;
  line-height: 1;
}

.home-category-card > span:nth-of-type(2) {
  margin-top: clamp(8px, 0.94vh, 18px);
  font-size: clamp(0.75rem, 1.48vw, 1rem);
}

.home-category-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: clamp(32px, 4.63vw, 50px);
  margin-top: auto;
  padding: 0 clamp(16px, 2.59vw, 28px);
  border-radius: 999px;
  background: linear-gradient(180deg, #869674, #728462);
  color: #fffdf7;
  font-size: clamp(0.8rem, 1.6vw, 1.08rem);
  font-weight: 700;
  box-shadow: 0 8px 16px rgba(74, 88, 58, 0.16);
}

.quick-action {
  display: flex;
  min-height: clamp(78px, 13.9vw, 150px);
  flex-direction: column;
  align-items: center;
  justify-content: flex-start;
  text-align: center;
}

.quick-action-icon {
  display: grid;
  width: clamp(50px, 7.22vw, 78px);
  height: clamp(50px, 7.22vw, 78px);
  place-items: center;
  border: 1px solid rgba(202, 192, 162, 0.72);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.64);
  color: #738462;
  box-shadow: inset 0 0 0 clamp(4px, 0.65vw, 7px) rgba(245, 241, 228, 0.9);
}

.quick-action-icon svg {
  width: clamp(28px, 4.07vw, 44px);
  height: clamp(28px, 4.07vw, 44px);
}

.quick-action span:nth-of-type(2) {
  margin-top: clamp(8px, 0.73vh, 14px);
  font-size: clamp(1rem, 2.15vw, 1.45rem);
}

.quick-action span:nth-of-type(3) {
  margin-top: clamp(4px, 0.42vh, 8px);
  font-size: clamp(0.625rem, 1.21vw, 0.82rem);
}

.home-hills {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: 1;
  height: var(--home-hills-height);
  pointer-events: none;
  background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 620 118' preserveAspectRatio='none'%3E%3Cpath d='M0 54 C72 28 142 20 224 54 C314 92 388 96 472 58 C536 29 582 24 620 34 L620 118 L0 118 Z' fill='%23dfe8d6' fill-opacity='0.82'/%3E%3Cpath d='M0 76 C76 48 152 43 234 72 C318 101 396 98 472 72 C536 50 585 50 620 58 L620 118 L0 118 Z' fill='%23cbdcbe' fill-opacity='0.72'/%3E%3Cpath d='M0 96 C56 75 116 69 184 88 C266 111 340 110 422 88 C496 68 566 71 620 84 L620 118 L0 118 Z' fill='%2399b781' fill-opacity='0.66'/%3E%3Cpath d='M0 54 C72 28 142 20 224 54 C314 92 388 96 472 58 C536 29 582 24 620 34' fill='none' stroke='%23b6c6aa' stroke-opacity='0.72' stroke-width='2'/%3E%3Cpath d='M0 76 C76 48 152 43 234 72 C318 101 396 98 472 72 C536 50 585 50 620 58' fill='none' stroke='%23d7cda9' stroke-opacity='0.4' stroke-width='1.3'/%3E%3C/svg%3E")
    bottom / 100% 100% no-repeat;
}

.home-bottom-mascot {
  bottom: clamp(4px, 0.52vh, 10px);
  width: clamp(128px, 22.2vw, 240px);
  mix-blend-mode: multiply;
  opacity: 0.96;
  -webkit-mask-image:
    linear-gradient(to right, transparent 0%, #000 20%, #000 100%),
    linear-gradient(to bottom, transparent 0%, #000 16%, #000 100%);
  mask-image:
    linear-gradient(to right, transparent 0%, #000 20%, #000 100%),
    linear-gradient(to bottom, transparent 0%, #000 16%, #000 100%);
  -webkit-mask-composite: source-in;
  mask-composite: intersect;
}

.home-slogan {
  bottom: clamp(-6px, 4.38vh, 84px);
  left: var(--home-inline);
  width: clamp(144px, 24.1vw, 260px);
}

.home-mist-left {
  bottom: clamp(1.5rem, 2vh, 2rem);
  width: clamp(26rem, 50.4vw, 34rem);
  height: clamp(10rem, 12.5vw, 15rem);
}

.home-mist-right {
  bottom: clamp(6rem, 7.5vw, 9rem);
  width: clamp(30rem, 56.3vw, 38rem);
  height: clamp(13rem, 15.7vw, 17rem);
}
</style>
