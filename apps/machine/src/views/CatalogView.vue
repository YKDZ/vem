<script setup lang="ts">
import { computed } from "vue";
import { useRouter } from "vue-router";

import ProductCard from "@/components/ProductCard.vue";
import KioskLayout from "@/layouts/KioskLayout.vue";
import { useCatalogStore } from "@/stores/catalog";
import { useConnectivityStore } from "@/stores/connectivity";
import { useMachineStore } from "@/stores/machine";
import { formatDateTimeFromMs } from "@/utils/format";

const router = useRouter();
const machineStore = useMachineStore();
const connectivityStore = useConnectivityStore();
const catalogStore = useCatalogStore();

const canDisplayAsSaleReady = computed(
  () => machineStore.canSell && connectivityStore.isSaleNetworkReady,
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
        当前网络或硬件未就绪，仅展示商品，购买入口已禁用。
      </p>

      <div
        v-if="catalogStore.availableItems.length > 0"
        class="mt-6 grid min-h-0 flex-1 grid-cols-2 gap-4 overflow-y-auto pb-8"
      >
        <ProductCard
          v-for="item in catalogStore.availableItems"
          :key="item.inventoryId"
          :item="item"
          :disabled="!canDisplayAsSaleReady"
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
