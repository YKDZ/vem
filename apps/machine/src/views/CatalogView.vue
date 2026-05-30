<script setup lang="ts">
import { computed, onMounted } from "vue";
import { useRouter } from "vue-router";

import type { MachineCatalogItem } from "@/types/catalog";

import ProductCard from "@/components/ProductCard.vue";
import KioskLayout from "@/layouts/KioskLayout.vue";
import { useCatalogStore } from "@/stores/catalog";
import { useCheckoutStore } from "@/stores/checkout";
import { useConnectivityStore } from "@/stores/connectivity";
import { useMqttStore } from "@/stores/mqtt";
import { useVisionStore } from "@/stores/vision";

const router = useRouter();
const connectivityStore = useConnectivityStore();
const catalogStore = useCatalogStore();
const checkoutStore = useCheckoutStore();
const visionStore = useVisionStore();
const mqttStore = useMqttStore();

const canDisplayAsSaleReady = computed(
  () => connectivityStore.isSaleNetworkReady,
);
const displayItems = computed(() => catalogStore.availableItems);
const degradedSyncMessage = computed(() => {
  if (mqttStore.outboxSize > 0) {
    return `MQTT backlog：${mqttStore.outboxSize} 条待补发`;
  }
  return connectivityStore.degradedReasons[0] ?? null;
});

async function refreshCatalog(): Promise<void> {
  await connectivityStore.refresh();
  if (!connectivityStore.isSaleNetworkReady) {
    await router.replace("/offline");
    return;
  }
  await catalogStore.refresh();
}

async function selectProduct(item: MachineCatalogItem): Promise<void> {
  if (!canDisplayAsSaleReady.value || item.availableQty <= 0) return;
  checkoutStore.selectItem(item);
  await router.push({
    name: "product-detail",
    params: { inventoryId: item.inventoryId },
  });
}

onMounted(async () => {
  if (!catalogStore.hasItems) {
    await catalogStore.load();
  }
});
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
            最近更新：{{ catalogStore.lastUpdatedAt ?? "尚未同步" }}
            <span v-if="catalogStore.cachedOnly">（daemon 缓存）</span>
          </p>
        </div>
        <button
          class="kiosk-touch-target rounded-2xl border border-white/20 px-5 py-3 font-bold text-white"
          type="button"
          @click="refreshCatalog"
        >
          刷新
        </button>
      </div>

      <p
        v-if="!canDisplayAsSaleReady"
        class="mt-5 rounded-2xl bg-amber-400/15 p-4 text-amber-100"
      >
        daemon 当前判定为不可售卖，仅展示目录缓存，购买入口已禁用。
      </p>

      <p class="mt-5 rounded-2xl bg-fuchsia-400/15 p-4 text-fuchsia-100">
        视觉状态：{{ visionStore.message }}
      </p>

      <p
        v-if="degradedSyncMessage"
        class="mt-5 rounded-2xl bg-sky-400/15 p-4 text-sky-100"
      >
        {{ degradedSyncMessage }}
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
