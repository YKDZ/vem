<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRouter } from "vue-router";

import type { CatalogTopCategoryKey } from "@/catalog/view-model";
import type { MachineCatalogItem } from "@/types/catalog";

import {
  firstItemInGroups,
  groupItemsByTopCategory,
  groupSubcategories,
} from "@/catalog/view-model";
import ProductTile from "@/components/catalog/ProductTile.vue";
import TopCategoryCard from "@/components/catalog/TopCategoryCard.vue";
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

const selectedTopCategoryKey = ref<CatalogTopCategoryKey | null>(null);
const selectedCatalogKey = ref<string | null>(null);
let readinessRefreshTimer: number | null = null;
let readinessRefreshInFlight: Promise<void> | null = null;

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
});

onUnmounted(() => {
  catalogStore.stopAutoRefresh();
  stopReadinessAutoRefresh();
});
</script>

<template>
  <KioskLayout>
    <section
      v-if="!selectedTopCategoryKey"
      class="flex min-h-0 flex-1 flex-col gap-4"
    >
      <div
        class="aspect-video w-full shrink-0 overflow-hidden rounded-lg border border-neutral-200 bg-neutral-200"
      ></div>

      <p
        v-if="customerReadinessMessage"
        class="shrink-0 rounded-lg border border-neutral-300 bg-white p-4 text-neutral-800"
      >
        {{ customerReadinessMessage }}
      </p>

      <div
        v-if="categoryGroups.some((group) => group.items.length > 0)"
        class="grid min-h-0 flex-1 grid-rows-3 gap-4"
      >
        <TopCategoryCard
          v-for="group in categoryGroups"
          :key="group.key"
          :group="group"
          @select="selectTopCategory"
        />
      </div>

      <section
        v-else
        class="flex min-h-0 flex-1 items-center justify-center rounded-lg border border-neutral-200 bg-white p-8 text-center text-neutral-600"
      >
        暂无可售商品
      </section>
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
