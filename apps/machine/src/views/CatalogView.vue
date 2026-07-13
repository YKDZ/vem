<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useRouter } from "vue-router";

import type { CatalogTopCategoryKey } from "@/catalog/view-model";
import type { MachineCatalogItem } from "@/types/catalog";

import carouselImage1 from "@/assets/home/carousel-1.jpg";
import carouselImage2 from "@/assets/home/carousel-2.jpg";
import carouselImage3 from "@/assets/home/carousel-3.png";
import carouselImage4 from "@/assets/home/carousel-4.png";
import iconSocksImage from "@/assets/home/icon-socks.png";
import iconTshirtImage from "@/assets/home/icon-tshirt.png";
import iconUnderwearImage from "@/assets/home/icon-underwear.png";
import listSloganImage from "@/assets/home/list-slogan.png";
import listTitleImage from "@/assets/home/list-title.png";
import mascotListImage from "@/assets/home/mascot-list.png";
import sloganCalligraphyImage from "@/assets/home/slogan-calligraphy.png";
import { groupItemsByTopCategory } from "@/catalog/view-model";
import KioskHeader from "@/components/KioskHeader.vue";
import { useCatalogNotifications } from "@/composables/useCatalogNotifications";
import { usePresenceInteraction } from "@/composables/usePresenceInteraction";
import { useVisionRecommendations } from "@/composables/useVisionRecommendations";
import KioskLayout from "@/layouts/KioskLayout.vue";
import { useCatalogStore } from "@/stores/catalog";
import { useConnectivityStore } from "@/stores/connectivity";
import { formatCents } from "@/utils/format";

const router = useRouter();
const connectivityStore = useConnectivityStore();
const catalogStore = useCatalogStore();
useVisionRecommendations();
const { presenceClass } = usePresenceInteraction();
const { primaryNotification } = useCatalogNotifications();
const READINESS_REFRESH_INTERVAL_MS = 5000;
const CAROUSEL_AUTO_ADVANCE_INTERVAL_MS = 5000;
const CAROUSEL_SWIPE_THRESHOLD_PX = 60;
const RUNTIME_SCREENSHOT_STORAGE_KEY = "vem.machine.runtimeScreenshot";

const selectedTopCategoryKey = ref<CatalogTopCategoryKey | null>(null);
const activeGenderFilter = ref<ProductGenderFilter>("all");
const activeCarouselIndex = ref(0);
const carouselSwipeStartX = ref<number | null>(null);
let readinessRefreshTimer: number | null = null;
let readinessRefreshInFlight: Promise<void> | null = null;
let carouselAutoAdvanceTimer: number | null = null;

type ProductGenderFilter = "all" | "male" | "female" | "kids" | "elder";

type DisplayProduct = {
  id: string;
  name: string;
  categoryKey: CatalogTopCategoryKey;
  gender: ProductGenderFilter;
  genderLabel: string;
  colors: number;
  sizeLabel: string;
  price: string;
  image: string;
  hasProductImage: boolean;
  item: MachineCatalogItem;
};

const carouselSlides = [
  carouselImage1,
  carouselImage2,
  carouselImage3,
  carouselImage4,
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
const homeCategoryEntries = (
  Object.keys(homeCategoryMeta) as CatalogTopCategoryKey[]
).map((key) => ({
  key,
  ...homeCategoryMeta[key],
}));
const genderFilters: {
  key: ProductGenderFilter;
  label: string;
}[] = [
  { key: "all", label: "全部" },
  { key: "male", label: "男款" },
  { key: "female", label: "女款" },
  { key: "kids", label: "儿童" },
  { key: "elder", label: "老人" },
];

const categoryGroups = computed(() =>
  groupItemsByTopCategory(catalogStore.availableItems),
);
const displayProducts = computed(() =>
  categoryGroups.value.flatMap((group) =>
    group.items.map((item) => toDisplayProduct(item, group.key)),
  ),
);
const availableCategoryKeys = computed(
  () => new Set(categoryGroups.value.map((group) => group.key)),
);
const activeProducts = computed(() =>
  displayProducts.value.filter((product) => {
    const matchesCategory =
      product.categoryKey === selectedTopCategoryKey.value;
    const matchesGender =
      activeGenderFilter.value === "all" ||
      product.gender === activeGenderFilter.value;
    return matchesCategory && matchesGender;
  }),
);
const hasAnySaleableProduct = computed(() => displayProducts.value.length > 0);

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

function previousSlide(): void {
  activeCarouselIndex.value =
    (activeCarouselIndex.value + carouselSlides.length - 1) %
    carouselSlides.length;
}

function nextSlide(): void {
  activeCarouselIndex.value =
    (activeCarouselIndex.value + 1) % carouselSlides.length;
}

function startCarouselAutoAdvance(): void {
  if (isRuntimeScreenshotMode()) return;
  stopCarouselAutoAdvance();
  carouselAutoAdvanceTimer = window.setInterval(() => {
    nextSlide();
  }, CAROUSEL_AUTO_ADVANCE_INTERVAL_MS);
}

function stopCarouselAutoAdvance(): void {
  if (carouselAutoAdvanceTimer !== null) {
    window.clearInterval(carouselAutoAdvanceTimer);
    carouselAutoAdvanceTimer = null;
  }
}

function restartCarouselAutoAdvance(): void {
  startCarouselAutoAdvance();
}

function handleCarouselPointerDown(event: PointerEvent): void {
  carouselSwipeStartX.value = event.clientX;
  stopCarouselAutoAdvance();
}

function handleCarouselPointerUp(event: PointerEvent): void {
  const startX = carouselSwipeStartX.value;
  carouselSwipeStartX.value = null;
  if (startX === null) {
    restartCarouselAutoAdvance();
    return;
  }
  const deltaX = event.clientX - startX;
  if (Math.abs(deltaX) >= CAROUSEL_SWIPE_THRESHOLD_PX) {
    if (deltaX < 0) {
      nextSlide();
    } else {
      previousSlide();
    }
  }
  restartCarouselAutoAdvance();
}

function handleCarouselPointerCancel(): void {
  carouselSwipeStartX.value = null;
  restartCarouselAutoAdvance();
}

function isRuntimeScreenshotMode(): boolean {
  return (
    import.meta.env.DEV &&
    window.localStorage.getItem(RUNTIME_SCREENSHOT_STORAGE_KEY) === "1"
  );
}

function selectTopCategory(key: CatalogTopCategoryKey): void {
  if (!categoryHasProducts(key)) return;
  selectedTopCategoryKey.value = key;
  activeGenderFilter.value = "all";
}

function categoryHasProducts(key: CatalogTopCategoryKey): boolean {
  return (
    availableCategoryKeys.value.has(key) &&
    displayProducts.value.some(
      (product) =>
        product.categoryKey === key &&
        product.item.slotSalesState === "sale_ready" &&
        product.item.saleableStock > 0,
    )
  );
}

function backToHome(): void {
  selectedTopCategoryKey.value = null;
  activeGenderFilter.value = "all";
}

function genderForItem(item: MachineCatalogItem): ProductGenderFilter {
  if (item.targetGender === "male" || item.targetGender === "female") {
    return item.targetGender;
  }
  const text = `${item.productName} ${item.categoryName ?? ""}`;
  if (text.includes("儿童") || text.includes("童")) return "kids";
  if (text.includes("老年") || text.includes("老人")) return "elder";
  return "all";
}

function genderLabelForFilter(filter: ProductGenderFilter): string {
  if (filter === "male") return "男款";
  if (filter === "female") return "女款";
  if (filter === "kids") return "儿童";
  if (filter === "elder") return "老人";
  return "通用";
}

function fallbackImageForCategory(key: CatalogTopCategoryKey): string {
  return homeCategoryMeta[key].icon;
}

function toDisplayProduct(
  item: MachineCatalogItem,
  categoryKey: CatalogTopCategoryKey,
): DisplayProduct {
  const gender = genderForItem(item);
  const colorCount = new Set(
    item.variantCandidates.map((variant) => variant.color).filter(Boolean),
  ).size;
  const sizeLabel = [
    ...new Set(
      item.variantCandidates.map((variant) => variant.size).filter(Boolean),
    ),
  ].join(" / ");
  return {
    id: item.catalogKey,
    name: item.productName,
    categoryKey,
    gender,
    genderLabel: genderLabelForFilter(gender),
    colors: Math.max(colorCount, 1),
    sizeLabel: sizeLabel || item.size || "常规码",
    price: formatCents(item.priceCents),
    image: item.coverImageUrl || fallbackImageForCategory(categoryKey),
    hasProductImage: Boolean(item.coverImageUrl),
    item,
  };
}

async function openProductDetail(product: DisplayProduct): Promise<void> {
  await router.push({
    name: "product-detail",
    params: { catalogKey: product.item.catalogKey },
  });
}

onMounted(() => {
  catalogStore.startAutoRefresh();
  startReadinessAutoRefresh();
  startCarouselAutoAdvance();
});

onUnmounted(() => {
  catalogStore.stopAutoRefresh();
  stopReadinessAutoRefresh();
  stopCarouselAutoAdvance();
});
</script>

<template>
  <KioskLayout>
    <section
      v-if="!selectedTopCategoryKey"
      class="catalog-home relative -mx-6 -my-5 flex min-h-0 flex-1 flex-col overflow-hidden px-7 py-6"
      :class="presenceClass"
    >
      <div class="home-mist home-mist-left"></div>
      <div class="home-mist home-mist-right"></div>

      <KioskHeader class="relative z-10" :enable-maintenance-entry="true" />

      <div
        class="home-carousel-shell relative z-10 mt-6 shrink-0 overflow-hidden rounded-[26px] border border-[#ded6c2] bg-[#f8f3e8] p-2 shadow-[0_16px_40px_rgba(101,94,71,0.12)]"
      >
        <div
          class="relative aspect-video overflow-hidden rounded-[20px]"
          role="region"
          aria-roledescription="carousel"
          aria-label="首页展示轮播"
          @pointerdown="handleCarouselPointerDown"
          @pointerup="handleCarouselPointerUp"
          @pointercancel="handleCarouselPointerCancel"
          @pointerleave="handleCarouselPointerCancel"
        >
          <img
            :src="carouselSlides[activeCarouselIndex]"
            alt="轮播展示"
            class="h-full w-full object-cover select-none"
            draggable="false"
          />
          <div
            class="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-3"
            aria-hidden="true"
          >
            <span
              v-for="(_, index) in carouselSlides"
              :key="index"
              class="carousel-dot rounded-full transition"
              :class="
                index === activeCarouselIndex ? 'bg-[#6d815d]' : 'bg-[#b9bca6]'
              "
            ></span>
          </div>
        </div>
      </div>

      <div
        v-if="primaryNotification"
        class="catalog-notification home-readiness-message"
        :class="`catalog-notification-${primaryNotification.tone}`"
        role="status"
      >
        <span class="catalog-notification-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path
              d="M4 10v4h3l5 4V6l-5 4H4Z"
              fill="none"
              stroke="currentColor"
              stroke-linejoin="round"
              stroke-width="2"
            />
            <path
              d="M15.5 9.5a3.5 3.5 0 0 1 0 5M18 7a7 7 0 0 1 0 10"
              fill="none"
              stroke="currentColor"
              stroke-linecap="round"
              stroke-width="2"
            />
          </svg>
        </span>
        <span>{{ primaryNotification.message }}</span>
      </div>

      <div
        class="home-category-heading relative z-10 mt-5 flex shrink-0 items-center justify-center gap-3 text-[#7b8d67]"
      >
        <span class="title-ornament title-ornament-left"></span>
        <h2 class="category-section-title">请选择商品类别</h2>
        <span class="title-ornament title-ornament-right"></span>
      </div>

      <div
        class="home-category-grid relative z-10 mt-5 grid shrink-0 grid-cols-3 gap-4"
      >
        <button
          v-for="category in homeCategoryEntries"
          :key="category.key"
          class="home-category-card kiosk-touch-target"
          :disabled="!categoryHasProducts(category.key)"
          type="button"
          @click="selectTopCategory(category.key)"
        >
          <img
            :src="category.icon"
            alt=""
            class="category-illustration"
            aria-hidden="true"
          />
          <span class="category-title-text mt-3 block text-[#4b3f34]">
            {{ category.label }}
          </span>
          <span class="mt-2 block text-xs tracking-[0.2em] text-[#c2b8a6]">
            {{ category.english }}
          </span>
          <span class="home-category-action">
            {{ categoryHasProducts(category.key) ? "点击选购" : "暂时售罄" }}
          </span>
        </button>
      </div>

      <p
        v-if="!hasAnySaleableProduct"
        class="home-empty-message relative z-10 mt-5 shrink-0 rounded-2xl border border-[#d8cfb9] bg-white/82 p-4 text-center text-base font-semibold text-[#5f644f]"
      >
        暂无可售商品，请稍后再来或联系工作人员。
      </p>

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
          <span class="mt-2 block text-base font-semibold text-[#5f6e55]">
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
        :src="mascotListImage"
        alt=""
        class="home-bottom-mascot pointer-events-none absolute right-0 bottom-1 z-[2] w-32"
        aria-hidden="true"
      />
      <div class="home-hills" aria-hidden="true"></div>
    </section>

    <section
      v-else
      class="catalog-list relative flex min-h-0 flex-1 flex-col overflow-hidden px-[var(--machine-page-inline)] pt-[var(--machine-page-header-top)] pb-6"
      :class="presenceClass"
    >
      <div class="home-mist home-mist-left"></div>
      <div class="home-mist home-mist-right"></div>

      <KioskHeader class="relative z-10" />

      <div class="list-heading-row">
        <div class="list-title-group">
          <button
            class="catalog-back-button kiosk-touch-target"
            type="button"
            aria-label="返回首页"
            @click="backToHome"
          >
            <span aria-hidden="true">&lt;</span>
            返回
          </button>
          <img
            :src="listTitleImage"
            alt="商品列表，请点击选择您需要的商品"
            class="list-title-image"
          />
        </div>
      </div>

      <div
        v-if="primaryNotification"
        class="catalog-notification relative z-10 mt-3 shrink-0"
        :class="`catalog-notification-${primaryNotification.tone}`"
        role="status"
      >
        <span class="catalog-notification-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path
              d="M4 10v4h3l5 4V6l-5 4H4Z"
              fill="none"
              stroke="currentColor"
              stroke-linejoin="round"
              stroke-width="2"
            />
            <path
              d="M15.5 9.5a3.5 3.5 0 0 1 0 5M18 7a7 7 0 0 1 0 10"
              fill="none"
              stroke="currentColor"
              stroke-linecap="round"
              stroke-width="2"
            />
          </svg>
        </span>
        <span>{{ primaryNotification.message }}</span>
      </div>

      <div class="catalog-list-body">
        <aside class="catalog-sidebar">
          <button
            v-for="category in homeCategoryEntries"
            :key="category.key"
            class="sidebar-category kiosk-touch-target"
            :class="{
              'sidebar-category-active':
                category.key === selectedTopCategoryKey,
            }"
            :disabled="!categoryHasProducts(category.key)"
            type="button"
            @click="selectTopCategory(category.key)"
          >
            <span>
              <strong>{{ category.label }}</strong>
              <small>{{ category.english }}</small>
            </span>
          </button>
        </aside>

        <main class="product-main">
          <div class="product-filter-row">
            <button
              v-for="filter in genderFilters"
              :key="filter.key"
              class="gender-filter kiosk-touch-target"
              :class="{
                'gender-filter-active': filter.key === activeGenderFilter,
              }"
              type="button"
              @click="activeGenderFilter = filter.key"
            >
              {{ filter.label }}
            </button>
          </div>

          <div class="kiosk-scroll product-scroll">
            <div v-if="activeProducts.length > 0" class="product-grid">
              <button
                v-for="product in activeProducts"
                :key="product.id"
                class="display-product-card"
                type="button"
                @click="openProductDetail(product)"
              >
                <div class="product-image-panel">
                  <img
                    :src="product.image"
                    :alt="product.name"
                    :class="{
                      'product-image-fallback': !product.hasProductImage,
                    }"
                  />
                  <span class="product-bamboo" aria-hidden="true"></span>
                </div>
                <div class="mt-5">
                  <h3>{{ product.name }}</h3>
                  <p class="mt-3">
                    {{ product.genderLabel }} ｜ {{ product.colors }}种颜色
                  </p>
                  <p class="mt-1">尺码 {{ product.sizeLabel }}</p>
                  <strong>{{ product.price }}</strong>
                </div>
              </button>
            </div>
            <p v-else class="product-empty-message">
              当前分类暂无可售商品，请选择其他分类或联系工作人员。
            </p>
          </div>
        </main>
      </div>

      <img
        :src="mascotListImage"
        alt=""
        class="list-bottom-mascot pointer-events-none absolute bottom-3 left-2 z-[3]"
        aria-hidden="true"
      />
      <img
        :src="listSloganImage"
        alt="让温柔贴近 让善意发生"
        class="list-slogan-image pointer-events-none"
      />
    </section>
  </KioskLayout>
</template>

<style scoped>
:global(.kiosk-shell:has(.catalog-home) > header),
:global(.kiosk-shell:has(.catalog-list) > header) {
  display: none;
}

:global(.kiosk-shell:has(.catalog-home) > .kiosk-scroll),
:global(.kiosk-shell:has(.catalog-list) > .kiosk-scroll) {
  margin-top: 0;
  padding-bottom: 0;
}

.catalog-home,
.catalog-list {
  container-type: inline-size;
}

.catalog-home.presence-present,
.catalog-list.presence-present {
  filter: saturate(1.03) brightness(1.01);
}

.catalog-home {
  --home-inline: var(--machine-page-inline);
  --home-block-start: var(--machine-page-header-top);
  --home-block-end: clamp(24px, 2.3vh, 44px);
  --home-carousel-gap: clamp(24px, 2.92vh, 56px);
  --home-heading-gap: clamp(20px, 3.02vh, 58px);
  --home-category-gap: clamp(20px, 2.19vh, 42px);
  --home-quick-gap: clamp(28px, 3.96vh, 76px);
  --home-card-height: clamp(268px, 29.2vh, 560px);
  --home-hills-height: clamp(118px, 9.9vh, 190px);
  display: grid;
  width: 100%;
  grid-template-rows: auto auto auto auto auto auto minmax(0, 1fr);
  align-content: start;
  margin: 0;
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

.catalog-notification {
  position: relative;
  z-index: 10;
  display: grid;
  grid-template-columns: clamp(30px, 3.33vw, 36px) minmax(0, 1fr);
  align-items: center;
  gap: clamp(10px, 1.48vw, 16px);
  padding: clamp(10px, 1.11vw, 14px) clamp(12px, 1.67vw, 18px);
  border: 1px solid #d8cfb9;
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.86);
  color: #5f644f;
  font-size: clamp(0.83rem, 1.3vw, 0.95rem);
  font-weight: 650;
  line-height: 1.45;
  box-shadow: 0 10px 26px rgba(101, 94, 71, 0.08);
}

.catalog-notification-warning {
  border-color: rgba(201, 172, 105, 0.72);
  background: rgba(255, 251, 235, 0.9);
}

.catalog-notification-info {
  border-color: rgba(135, 157, 126, 0.48);
  background: rgba(250, 253, 246, 0.9);
}

.catalog-notification-icon {
  display: grid;
  width: clamp(30px, 3.33vw, 36px);
  height: clamp(30px, 3.33vw, 36px);
  place-items: center;
  border-radius: 999px;
  background: rgba(109, 129, 93, 0.12);
  color: #6d815d;
}

.catalog-notification-icon svg {
  width: 68%;
  height: 68%;
}

.home-category-heading {
  grid-row: 4;
  margin-top: var(--home-heading-gap);
  gap: clamp(12px, 1.85vw, 20px);
}

.home-category-grid {
  grid-row: 5;
  gap: clamp(16px, 2.41vw, 26px);
  margin-top: var(--home-category-gap);
}

.home-quick-grid {
  grid-row: 6;
  gap: clamp(8px, 1.67vw, 18px);
  margin-top: var(--home-quick-gap);
  padding-right: clamp(112px, 20.4vw, 220px);
}

.catalog-list-body {
  position: relative;
  z-index: 10;
  display: grid;
  min-height: 0;
  flex: 1;
  grid-template-columns: 8.4rem minmax(0, 1fr);
  gap: 1.4rem;
  margin-top: 1.55rem;
  padding-bottom: 7.5rem;
}

.product-main {
  min-height: 0;
}

.product-filter-row {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 0.85rem;
  align-items: center;
}

.product-scroll {
  min-height: 0;
  max-height: 100%;
  margin-top: 1.35rem;
  overflow-y: auto;
  padding-right: 0.5rem;
}

.product-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1.35rem;
}

.catalog-list {
  margin: 0;
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
  border: 0;
  border-radius: 0;
  box-shadow: none;
}

.catalog-back-button {
  display: inline-flex;
  min-height: 48px;
  align-items: center;
  gap: 0.75rem;
  flex: 0 0 auto;
  color: #6b6258;
  font-family: SimSun, "Songti SC", "Noto Serif CJK SC", serif;
  font-size: 1.35rem;
  font-weight: 700;
}

.catalog-back-button span {
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

.list-heading-row {
  position: relative;
  z-index: 10;
  display: flex;
  align-items: center;
  margin-top: 1.45rem;
}

.list-title-group {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 0.85rem;
}

.list-title-image {
  width: 255px;
  max-width: 100%;
  height: auto;
  object-fit: contain;
}

.catalog-sidebar {
  position: relative;
  z-index: 2;
  align-self: start;
  min-height: 44rem;
  overflow: hidden;
  border: 1px solid rgba(206, 197, 169, 0.78);
  border-radius: 18px;
  background: rgba(255, 253, 248, 0.7);
  padding: 18px 0;
  box-shadow: 0 12px 26px rgba(102, 92, 64, 0.08);
}

.sidebar-category {
  display: flex;
  width: calc(100% + 8px);
  min-height: 5rem;
  align-items: center;
  margin-left: 0;
  padding: 0 10px;
  border-radius: 0 18px 18px 0;
  color: #60594d;
  text-align: left;
}

.sidebar-category strong {
  display: block;
  font-family: SimSun, "Songti SC", "Noto Serif CJK SC", serif;
  font-size: 1.18rem;
  line-height: 1;
}

.sidebar-category small {
  display: block;
  margin-top: 8px;
  color: #aaa293;
  font-size: 0.62rem;
  letter-spacing: 0.12em;
}

.sidebar-category-active {
  background: linear-gradient(180deg, #758868, #627655);
  color: #fffdf7;
  box-shadow: 0 10px 18px rgba(82, 101, 65, 0.18);
}

.sidebar-category-active small {
  color: rgba(255, 253, 247, 0.72);
}

.sidebar-category:disabled {
  cursor: not-allowed;
  opacity: 0.46;
}

.gender-filter {
  min-width: 0;
  min-height: 48px;
  border: 1px solid rgba(206, 197, 169, 0.78);
  border-radius: 999px;
  background: rgba(255, 253, 248, 0.74);
  color: #615a50;
  font-family: SimSun, "Songti SC", "Noto Serif CJK SC", serif;
  font-size: 1.08rem;
  font-weight: 700;
  box-shadow: 0 8px 16px rgba(102, 92, 64, 0.06);
}

.gender-filter-active {
  border-color: transparent;
  background: linear-gradient(180deg, #758868, #627655);
  color: #fffdf7;
}

.display-product-card {
  display: block;
  width: 100%;
  min-height: 17.5rem;
  overflow: hidden;
  border: 1px solid rgba(211, 203, 180, 0.92);
  border-radius: 20px;
  background:
    linear-gradient(
      180deg,
      rgba(255, 254, 250, 0.88),
      rgba(249, 245, 236, 0.9)
    ),
    radial-gradient(
      circle at 88% 88%,
      rgba(129, 151, 107, 0.12),
      transparent 34%
    );
  padding: 9px 9px 14px;
  color: #4f473f;
  text-align: left;
  box-shadow: 0 14px 30px rgba(102, 92, 64, 0.08);
}

.product-image-panel {
  position: relative;
  display: grid;
  aspect-ratio: var(--product-display-aspect-ratio);
  height: auto;
  overflow: hidden;
  place-items: center;
  border-radius: 18px;
  background: radial-gradient(circle at 50% 45%, #fff 0%, #f7f0e4 64%), #f7f0e4;
}

.product-image-panel img {
  position: absolute;
  inset: 0;
  z-index: 2;
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: center center;
  filter: drop-shadow(0 16px 16px rgba(81, 70, 51, 0.12));
}

.product-image-panel img.product-image-fallback {
  top: 50%;
  left: 50%;
  width: 72%;
  height: 72%;
  object-fit: contain;
  transform: translate(-50%, -50%);
}

.product-bamboo {
  position: absolute;
  right: 0;
  bottom: -8px;
  width: 88px;
  height: 132px;
  opacity: 0.18;
  background: url("data:image/svg+xml,%3Csvg width='88' height='132' viewBox='0 0 88 132' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' stroke='%23768b68' stroke-width='1.4' stroke-linecap='round'%3E%3Cpath d='M52 130C49 96 52 56 68 12'/%3E%3Cpath d='M38 126c3-31 1-65-10-98'/%3E%3Cpath d='M61 53c10-11 19-16 25-17-4 8-12 14-25 17Z'/%3E%3Cpath d='M56 82c11-9 20-12 27-12-5 7-13 11-27 12Z'/%3E%3Cpath d='M33 60C21 50 12 46 4 45c5 8 15 13 29 15Z'/%3E%3Cpath d='M35 92C22 85 12 83 5 84c7 6 17 9 30 8Z'/%3E%3C/g%3E%3C/svg%3E")
    center / contain no-repeat;
}

.display-product-card h3 {
  font-family: SimSun, "Songti SC", "Noto Serif CJK SC", serif;
  font-size: 1.22rem;
  font-weight: 700;
  line-height: 1.1;
}

.display-product-card p {
  color: #827b70;
  font-size: 0.88rem;
}

.display-product-card strong {
  display: block;
  margin-top: 8px;
  color: #6f835f;
  font-family: Georgia, "Times New Roman", serif;
  font-size: 1.42rem;
  line-height: 1;
  text-align: right;
}

.list-bottom-mascot {
  width: 12.2rem;
  height: 19.6rem;
  object-fit: cover;
  object-position: left bottom;
  mix-blend-mode: multiply;
}

.list-slogan {
  position: absolute;
  right: 0;
  bottom: 16px;
  left: 0;
  z-index: 4;
  color: #a9a07d;
  font-size: 0.95rem;
  letter-spacing: 0.3em;
  text-align: center;
}

.list-slogan-image {
  position: absolute;
  right: 0;
  bottom: 12px;
  left: 0;
  z-index: 4;
  width: 270px;
  max-width: calc(100% - 2rem);
  height: auto;
  margin: 0 auto;
  object-fit: contain;
}

@container (max-width: 720px) {
  .catalog-list {
    padding: 1.1rem 1.25rem 1rem;
  }

  .catalog-list header {
    align-items: center;
  }

  .catalog-list header img:first-of-type {
    height: 1.9rem;
  }

  .catalog-list header img:last-of-type {
    width: 2.6rem;
    height: 2.6rem;
  }

  .catalog-list header p:first-child {
    font-size: 2rem;
  }

  .catalog-list header p:last-child {
    max-width: 7rem;
    font-size: 0.72rem;
  }

  .list-heading-row {
    display: grid;
    grid-template-columns: 206px minmax(180px, 1fr);
    gap: 0.85rem;
    justify-content: space-between;
    margin-top: 1.2rem;
  }

  .list-title-image {
    width: 206px;
  }

  .catalog-search {
    width: min(100%, 230px);
    min-height: 46px;
    justify-self: end;
    padding: 0 16px;
  }

  .catalog-list-body {
    grid-template-columns: 5.9rem minmax(0, 1fr);
    gap: 0.65rem;
    margin-top: 1.1rem;
    padding-bottom: 4.7rem;
  }

  .catalog-sidebar {
    min-height: 31rem;
    padding: 0.6rem 0;
  }

  .sidebar-category {
    min-height: 62px;
    padding: 0 0.5rem;
  }

  .sidebar-category strong {
    font-size: 0.9rem;
  }

  .sidebar-category small {
    margin-top: 0.32rem;
    font-size: 0.48rem;
  }

  .product-filter-row {
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: 0.55rem;
  }

  .gender-filter {
    min-width: 0;
    min-height: 42px;
    font-size: 0.92rem;
  }

  .product-scroll {
    margin-top: 1rem;
    padding-right: 0;
  }

  .product-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0.65rem;
  }

  .display-product-card {
    min-height: 196px;
    padding: 0.55rem;
  }

  .product-image-panel {
    aspect-ratio: var(--product-display-aspect-ratio);
    height: auto;
  }

  .product-image-panel img {
    width: 100%;
    height: 100%;
  }

  .product-image-panel img.product-image-fallback {
    width: 72%;
    height: 72%;
  }

  .display-product-card h3 {
    font-size: 0.98rem;
  }

  .display-product-card p {
    font-size: 0.72rem;
  }

  .display-product-card strong {
    margin-top: 0.45rem;
    font-size: 1rem;
  }

  .list-bottom-mascot {
    width: 7.8rem;
    height: 12.7rem;
  }

  .list-slogan-image {
    bottom: 0.65rem;
    width: 250px;
  }
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

.carousel-dot {
  width: clamp(10px, 1.3vw, 14px);
  height: clamp(10px, 1.3vw, 14px);
  min-height: clamp(10px, 1.3vw, 14px);
}

.home-carousel-shell [aria-roledescription="carousel"] {
  touch-action: pan-y;
  user-select: none;
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
  font-family: SimSun, "Songti SC", "Noto Serif CJK SC", serif;
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
  cursor: not-allowed;
  opacity: 0.52;
}

.product-empty-message {
  display: grid;
  min-height: 18rem;
  place-items: center;
  border: 1px solid rgba(206, 197, 169, 0.78);
  border-radius: 18px;
  background: rgba(255, 253, 248, 0.74);
  color: #5f644f;
  font-size: 1.12rem;
  font-weight: 700;
  text-align: center;
}

.category-illustration {
  width: clamp(116px, 17.6vw, 190px);
  height: clamp(116px, 17.6vw, 190px);
  object-fit: contain;
  filter: drop-shadow(0 8px 10px rgba(80, 92, 66, 0.08));
}

.category-title-text {
  font-family: SimSun, "Songti SC", "Noto Serif CJK SC", serif;
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
  opacity: 0.96;
  filter: drop-shadow(0 10px 18px rgba(80, 92, 66, 0.08));
}

.home-slogan {
  bottom: clamp(-6px, 4.38vh, 84px);
  left: var(--home-inline);
  width: clamp(144px, 24.1vw, 260px);
}
</style>
