<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useRouter } from "vue-router";

import type { CatalogTopCategoryKey } from "@/catalog/view-model";
import type { MachineCatalogItem } from "@/types/catalog";

import carouselImage1 from "@/assets/home/carousel-1.jpg";
import carouselImage2 from "@/assets/home/carousel-2.jpg";
import carouselImage3 from "@/assets/home/carousel-3.jpg";
import iconSocksImage from "@/assets/home/icon-socks.png";
import iconTshirtImage from "@/assets/home/icon-tshirt.png";
import iconUnderwearImage from "@/assets/home/icon-underwear.png";
import listSloganImage from "@/assets/home/list-slogan.png";
import listTitleImage from "@/assets/home/list-title.png";
import logoImage from "@/assets/home/logo.png";
import mascotListImage from "@/assets/home/mascot-list.png";
import mascotTopImage from "@/assets/home/mascot-top-cutout.png";
import sloganCalligraphyImage from "@/assets/home/slogan-calligraphy.png";
import { groupItemsByTopCategory } from "@/catalog/view-model";
import { useVisionRecommendations } from "@/composables/useVisionRecommendations";
import KioskLayout from "@/layouts/KioskLayout.vue";
import { useCatalogStore } from "@/stores/catalog";
import { useCheckoutStore } from "@/stores/checkout";
import { useConnectivityStore } from "@/stores/connectivity";
import { formatCents } from "@/utils/format";

const router = useRouter();
const connectivityStore = useConnectivityStore();
const catalogStore = useCatalogStore();
const checkoutStore = useCheckoutStore();
useVisionRecommendations();
const READINESS_REFRESH_INTERVAL_MS = 5000;
const CLOCK_REFRESH_INTERVAL_MS = 30_000;

const selectedTopCategoryKey = ref<CatalogTopCategoryKey | null>(null);
const activeGenderFilter = ref<ProductGenderFilter>("all");
const activeCarouselIndex = ref(0);
const now = ref(new Date());
let readinessRefreshTimer: number | null = null;
let readinessRefreshInFlight: Promise<void> | null = null;
let clockTimer: number | null = null;

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
  item: MachineCatalogItem;
};

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

const canDisplayAsSaleReady = computed(
  () => connectivityStore.isSaleNetworkReady,
);
const categoryGroups = computed(() =>
  groupItemsByTopCategory(catalogStore.availableItems),
);
const displayProducts = computed(() =>
  categoryGroups.value.flatMap((group) =>
    group.items.map((item) => toDisplayProduct(item, group.key)),
  ),
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
const dateText = computed(
  () =>
    `${now.value.toLocaleDateString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })} ${now.value.toLocaleDateString("zh-CN", { weekday: "long" })}`,
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
  activeGenderFilter.value = "all";
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
    item,
  };
}

async function openProductDetail(product: DisplayProduct): Promise<void> {
  checkoutStore.selectItem(product.item);
  await router.push({
    name: "product-detail",
    params: { catalogKey: product.item.catalogKey },
  });
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
      class="catalog-home relative -mx-6 -my-5 flex min-h-0 flex-1 flex-col overflow-hidden px-7 py-6"
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
          <p class="mt-1 text-xs whitespace-nowrap">{{ dateText }}</p>
        </div>
      </header>

      <div
        class="relative z-10 mt-6 shrink-0 overflow-hidden rounded-[26px] border border-[#ded6c2] bg-[#f8f3e8] p-2 shadow-[0_16px_40px_rgba(101,94,71,0.12)]"
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
        class="relative z-10 mt-3 shrink-0 rounded-2xl border border-[#d8cfb9] bg-white/80 p-3 text-sm text-[#5f644f]"
      >
        {{ customerReadinessMessage }}
      </p>

      <div
        class="relative z-10 mt-5 flex shrink-0 items-center justify-center gap-3 text-[#7b8d67]"
      >
        <span class="title-ornament title-ornament-left"></span>
        <h2 class="category-section-title">请选择商品类别</h2>
        <span class="title-ornament title-ornament-right"></span>
      </div>

      <div class="relative z-10 mt-5 grid shrink-0 grid-cols-3 gap-4">
        <button
          v-for="category in homeCategoryEntries"
          :key="category.key"
          class="home-category-card kiosk-touch-target"
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
          <span class="home-category-action">点击选购</span>
        </button>
      </div>

      <div class="relative z-30 mt-7 grid shrink-0 grid-cols-4 gap-2 pr-28">
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
        class="pointer-events-none absolute bottom-[-0.35rem] left-8 z-[2] w-36 opacity-20"
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
      class="catalog-list relative -mx-6 -my-5 flex min-h-0 flex-1 flex-col overflow-hidden px-7 py-6"
    >
      <div class="home-mist home-mist-left"></div>
      <div class="home-mist home-mist-right"></div>

      <header class="relative z-10 flex shrink-0 items-start justify-between">
        <div class="flex items-center gap-3">
          <button
            class="catalog-back-button kiosk-touch-target"
            type="button"
            aria-label="返回首页"
            @click="backToHome"
          >
            ‹
          </button>
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
          <p class="mt-1 text-xs whitespace-nowrap">{{ dateText }}</p>
        </div>
      </header>

      <div class="list-heading-row">
        <img
          :src="listTitleImage"
          alt="商品列表，请点击选择您需要的商品"
          class="list-title-image"
        />
        <label class="catalog-search" aria-label="搜索商品">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="m20 20-4.5-4.5M10.8 18a7.2 7.2 0 1 1 0-14.4 7.2 7.2 0 0 1 0 14.4Z"
              fill="none"
              stroke="currentColor"
              stroke-linecap="round"
              stroke-width="1.8"
            />
          </svg>
          <input type="search" placeholder="搜索商品" />
        </label>
      </div>

      <p
        v-if="customerReadinessMessage"
        class="relative z-10 mt-3 shrink-0 rounded-2xl border border-[#d8cfb9] bg-white/80 p-3 text-sm text-[#5f644f]"
      >
        {{ customerReadinessMessage }}
      </p>

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
            <div class="product-grid">
              <button
                v-for="product in activeProducts"
                :key="product.id"
                class="display-product-card"
                type="button"
                @click="openProductDetail(product)"
              >
                <div class="product-image-panel">
                  <img :src="product.image" :alt="product.name" />
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

.catalog-list-body {
  position: relative;
  z-index: 10;
  display: grid;
  min-height: 0;
  flex: 1;
  grid-template-columns: 6.4rem minmax(0, 1fr);
  gap: 1.05rem;
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
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 1.15rem;
}

.catalog-list {
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
  border: 1px solid rgba(89, 83, 66, 0.2);
  border-radius: 20px;
  box-shadow: inset 0 0 0 2px rgba(255, 255, 255, 0.78);
}

.catalog-back-button {
  display: grid;
  width: 42px;
  height: 42px;
  place-items: center;
  border: 1px solid rgba(198, 187, 154, 0.76);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.72);
  color: #6f835f;
  font-size: 2rem;
  line-height: 1;
  box-shadow: 0 8px 18px rgba(102, 92, 64, 0.08);
}

.list-heading-row {
  position: relative;
  z-index: 10;
  display: grid;
  grid-template-columns: 270px minmax(220px, 270px);
  gap: 1.5rem;
  align-items: center;
  justify-content: space-between;
  margin-top: 1.6rem;
}

.list-title-image {
  width: 255px;
  max-width: 100%;
  height: auto;
  object-fit: contain;
}

.catalog-search {
  display: flex;
  width: 360px;
  min-height: 56px;
  align-items: center;
  gap: 12px;
  justify-self: end;
  border: 1px solid rgba(181, 171, 132, 0.82);
  border-radius: 999px;
  background:
    linear-gradient(
      180deg,
      rgba(255, 254, 249, 0.9),
      rgba(248, 243, 232, 0.78)
    ),
    rgba(255, 252, 244, 0.72);
  padding: 0 20px;
  color: #6f7f61;
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.86),
    inset 0 -10px 18px rgba(214, 204, 174, 0.12),
    0 10px 22px rgba(102, 92, 64, 0.07);
  transition:
    border-color 0.18s ease,
    box-shadow 0.18s ease,
    background 0.18s ease;
}

.catalog-search:focus-within {
  border-color: rgba(112, 132, 95, 0.88);
  background: rgba(255, 254, 249, 0.95);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.95),
    0 0 0 4px rgba(117, 136, 104, 0.12),
    0 14px 28px rgba(102, 92, 64, 0.1);
}

.catalog-search svg {
  width: 28px;
  height: 28px;
  flex: 0 0 auto;
  color: #6c8060;
}

.catalog-search input {
  min-width: 0;
  flex: 1;
  background: transparent;
  color: #5c554c;
  font-size: 1.05rem;
  outline: none;
}

.catalog-search input::placeholder {
  color: #8f8879;
}

.catalog-sidebar {
  position: relative;
  z-index: 2;
  align-self: start;
  min-height: 37.5rem;
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
  min-height: 66px;
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
  font-size: 1.04rem;
  line-height: 1;
}

.sidebar-category small {
  display: block;
  margin-top: 8px;
  color: #aaa293;
  font-size: 0.5rem;
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
  min-height: 244px;
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
  height: 118px;
  overflow: hidden;
  place-items: center;
  border-radius: 18px;
  background: radial-gradient(circle at 50% 45%, #fff 0%, #f7f0e4 64%), #f7f0e4;
}

.product-image-panel img {
  position: relative;
  z-index: 2;
  width: 78px;
  height: 78px;
  object-fit: contain;
  filter: drop-shadow(0 16px 16px rgba(81, 70, 51, 0.12));
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
    height: 86px;
  }

  .product-image-panel img {
    width: 58px;
    height: 58px;
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

.carousel-arrow {
  position: absolute;
  top: 50%;
  display: grid;
  width: 38px;
  height: 38px;
  min-height: 38px;
  transform: translateY(-50%);
  place-items: center;
  border-radius: 999px;
  background: rgba(112, 133, 95, 0.86);
  color: #fffdf5;
  font-size: 2.1rem;
  line-height: 1;
  box-shadow: 0 8px 22px rgba(61, 75, 49, 0.18);
}

.carousel-dot {
  width: 10px;
  height: 10px;
  min-height: 10px;
}

.title-ornament {
  position: relative;
  width: 76px;
  height: 14px;
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
  width: 52px;
  height: 1px;
  background: currentColor;
}

.title-ornament::after {
  width: 10px;
  height: 10px;
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
  font-size: 1.38rem;
  font-weight: 700;
  letter-spacing: 0.12em;
  line-height: 1;
}

.home-category-card {
  position: relative;
  display: flex;
  min-height: 268px;
  flex-direction: column;
  align-items: center;
  overflow: hidden;
  border: 1px solid rgba(189, 178, 146, 0.65);
  border-radius: 20px;
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
  padding: 26px 14px 20px;
  text-align: center;
  box-shadow: 0 14px 28px rgba(102, 92, 64, 0.1);
}

.home-category-card::before {
  position: absolute;
  right: -24px;
  bottom: -8px;
  width: 122px;
  height: 82px;
  content: "";
  background: rgba(126, 145, 104, 0.12);
  border-radius: 65% 35% 0 0;
}

.home-category-card:disabled {
  opacity: 0.52;
}

.category-illustration {
  width: 116px;
  height: 116px;
  object-fit: contain;
  filter: drop-shadow(0 8px 10px rgba(80, 92, 66, 0.08));
}

.category-title-text {
  font-family: SimSun, "Songti SC", "Noto Serif CJK SC", serif;
  font-size: 1.72rem;
  font-weight: 700;
  line-height: 1;
}

.home-category-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 32px;
  margin-top: auto;
  padding: 0 16px;
  border-radius: 999px;
  background: linear-gradient(180deg, #869674, #728462);
  color: #fffdf7;
  font-size: 0.8rem;
  font-weight: 700;
  box-shadow: 0 8px 16px rgba(74, 88, 58, 0.16);
}

.quick-action {
  display: flex;
  min-height: 78px;
  flex-direction: column;
  align-items: center;
  justify-content: flex-start;
  text-align: center;
}

.quick-action-icon {
  display: grid;
  width: 50px;
  height: 50px;
  place-items: center;
  border: 1px solid rgba(202, 192, 162, 0.72);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.64);
  color: #738462;
  box-shadow: inset 0 0 0 4px rgba(245, 241, 228, 0.9);
}

.quick-action-icon svg {
  width: 28px;
  height: 28px;
}

.home-hills {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: 1;
  height: 118px;
  pointer-events: none;
  background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 620 118' preserveAspectRatio='none'%3E%3Cpath d='M0 54 C72 28 142 20 224 54 C314 92 388 96 472 58 C536 29 582 24 620 34 L620 118 L0 118 Z' fill='%23dfe8d6' fill-opacity='0.82'/%3E%3Cpath d='M0 76 C76 48 152 43 234 72 C318 101 396 98 472 72 C536 50 585 50 620 58 L620 118 L0 118 Z' fill='%23cbdcbe' fill-opacity='0.72'/%3E%3Cpath d='M0 96 C56 75 116 69 184 88 C266 111 340 110 422 88 C496 68 566 71 620 84 L620 118 L0 118 Z' fill='%2399b781' fill-opacity='0.66'/%3E%3Cpath d='M0 54 C72 28 142 20 224 54 C314 92 388 96 472 58 C536 29 582 24 620 34' fill='none' stroke='%23b6c6aa' stroke-opacity='0.72' stroke-width='2'/%3E%3Cpath d='M0 76 C76 48 152 43 234 72 C318 101 396 98 472 72 C536 50 585 50 620 58' fill='none' stroke='%23d7cda9' stroke-opacity='0.4' stroke-width='1.3'/%3E%3C/svg%3E")
    bottom / 100% 100% no-repeat;
}

.home-bottom-mascot {
  opacity: 0.96;
  filter: drop-shadow(0 10px 18px rgba(80, 92, 66, 0.08));
}
</style>
