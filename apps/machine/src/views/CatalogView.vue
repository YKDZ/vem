<script setup lang="ts">
import { computed, ref } from "vue";
import { useRouter } from "vue-router";

import type { MachineCatalogItem } from "@/types/catalog";

import ProductCard from "@/components/ProductCard.vue";
import KioskLayout from "@/layouts/KioskLayout.vue";
import { requestVisionProfile } from "@/native/vision";
import { useCatalogStore } from "@/stores/catalog";
import { useCheckoutStore } from "@/stores/checkout";
import { useConnectivityStore } from "@/stores/connectivity";
import { useMachineStore } from "@/stores/machine";
import { formatDateTimeFromMs } from "@/utils/format";

const router = useRouter();
const machineStore = useMachineStore();
const connectivityStore = useConnectivityStore();
const catalogStore = useCatalogStore();
const checkoutStore = useCheckoutStore();
const recommendationMessage = ref<string | null>(null);

const canDisplayAsSaleReady = computed(
  () => machineStore.canSell && connectivityStore.isSaleNetworkReady,
);
const displayItems = computed(() =>
  catalogStore.hasRecommendations
    ? catalogStore.recommendedAvailableItems
    : catalogStore.availableItems,
);

async function refreshCatalog(): Promise<void> {
  if (!machineStore.config.machineCode) {
    await router.replace("/maintenance");
    return;
  }
  await connectivityStore.checkBackend(machineStore.config);
  if (!connectivityStore.backendOnline) {
    await router.replace("/offline");
    return;
  }
  await catalogStore.refresh(machineStore.config);
}

async function startVisionRecommendation(): Promise<void> {
  if (!canDisplayAsSaleReady.value) return;
  if (!machineStore.config.visionEnabled) {
    recommendationMessage.value = "视觉推荐未启用，请在维护页开启。";
    return;
  }

  recommendationMessage.value = "正在请求机器视觉模块识别用户画像…";
  try {
    const result = await requestVisionProfile(machineStore.config, {
      sessionId: `catalog-${Date.now()}`,
      trigger: "human_presence",
      timeoutMs: machineStore.config.visionRequestTimeoutMs,
    });
    await catalogStore.refreshRecommendations(
      machineStore.config,
      result.profile,
    );
    recommendationMessage.value = `已根据身高 ${
      result.profile.heightCm ?? "未知"
    }cm / 体型 ${result.profile.bodyType ?? "未知"} 生成推荐。`;
  } catch (error) {
    recommendationMessage.value = `视觉推荐失败，已保留默认目录：${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

function clearVisionRecommendation(): void {
  catalogStore.clearRecommendations();
  recommendationMessage.value = null;
}

async function selectProduct(item: MachineCatalogItem): Promise<void> {
  if (!canDisplayAsSaleReady.value || item.availableQty <= 0) return;
  checkoutStore.selectItem(item);
  await router.push({
    name: "product-detail",
    params: { inventoryId: item.inventoryId },
  });
}
</script>

<template>
  <KioskLayout>
    <section class="flex h-full flex-col">
      <div class="flex items-end justify-between gap-4">
        <div>
          <p class="text-sm tracking-[0.35em] text-sky-200 uppercase">
            CATALOG
          </p>
          <h2 class="mt-2 text-4xl font-black text-white">请选择商品</h2>
          <p class="mt-2 text-sm text-slate-300">
            最近更新：{{ formatDateTimeFromMs(catalogStore.lastUpdatedAt) }}
            <span v-if="catalogStore.cachedOnly">（缓存目录）</span>
          </p>
        </div>
        <div class="flex gap-3">
          <button
            class="kiosk-touch-target rounded-2xl border border-fuchsia-200/40 px-5 py-3 font-bold text-fuchsia-100 disabled:opacity-50"
            type="button"
            :disabled="
              !canDisplayAsSaleReady || catalogStore.recommendationLoading
            "
            @click="startVisionRecommendation"
          >
            智能推荐
          </button>
          <button
            v-if="catalogStore.hasRecommendations"
            class="kiosk-touch-target rounded-2xl border border-white/20 px-5 py-3 font-bold text-white"
            type="button"
            @click="clearVisionRecommendation"
          >
            全部商品
          </button>
          <button
            class="kiosk-touch-target rounded-2xl border border-white/20 px-5 py-3 font-bold text-white"
            type="button"
            @click="refreshCatalog"
          >
            刷新
          </button>
        </div>
      </div>

      <p
        v-if="!canDisplayAsSaleReady"
        class="mt-5 rounded-2xl bg-amber-400/15 p-4 text-amber-100"
      >
        当前网络或硬件未就绪，仅展示商品，购买入口已禁用。
      </p>

      <p
        v-if="recommendationMessage"
        class="mt-5 rounded-2xl bg-fuchsia-400/15 p-4 text-fuchsia-100"
      >
        {{ recommendationMessage }}
      </p>

      <div
        v-if="displayItems.length > 0"
        class="mt-6 grid min-h-0 flex-1 grid-cols-2 gap-4 overflow-y-auto pb-8"
      >
        <ProductCard
          v-for="item in displayItems"
          :key="item.inventoryId"
          :item="item"
          :disabled="!canDisplayAsSaleReady"
          @select="selectProduct"
        />
      </div>

      <section
        v-else
        class="mt-8 rounded-4xl border border-white/10 bg-white/10 p-8 text-center text-slate-200"
      >
        <h3 class="text-2xl font-bold text-white">暂无可售商品</h3>
        <p class="mt-3">请联系运维补货，或稍后刷新目录。</p>
      </section>
    </section>
  </KioskLayout>
</template>
