<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useRoute } from "vue-router";

import KioskLayout from "@/layouts/KioskLayout.vue";
import { submitMachineNavigationIntent } from "@/router/transaction-route-authority";
import { useCatalogStore } from "@/stores/catalog";
import { useTryOnStore } from "@/stores/try-on";

const route = useRoute();
const catalog = useCatalogStore();
const tryOn = useTryOnStore();
const started = ref(false);
const context = computed(() => tryOn.context);
const title = computed(() => {
  const current = context.value;
  return current
    ? (catalog.itemByCatalogKey(current.catalogKey)?.productName ?? "虚拟试衣")
    : "虚拟试衣";
});
const phaseText = computed(() => {
  switch (tryOn.phase) {
    case "starting":
      return "正在准备快速试衣";
    case "accepted":
      return "已接收，请稍候";
    case "generating":
      return "正在生成试衣结果";
    case "completed":
      return "快速试衣完成";
    case "failed":
      return "快速试衣暂时不可用";
    default:
      return "准备快速试衣";
  }
});

onMounted(() => {
  if (!tryOn.context) {
    const key =
      typeof route.query.catalogKey === "string" ? route.query.catalogKey : "";
    const variantId =
      typeof route.query.variantId === "string" ? route.query.variantId : "";
    const item = catalog.saleableVariantItemFor(key, variantId);
    if (item) tryOn.prepare(item);
  }
  if (
    tryOn.context &&
    tryOn.phase !== "completed" &&
    tryOn.phase !== "failed"
  ) {
    started.value = true;
    void tryOn.startFast();
  }
});

onUnmounted(() => {
  // Keep completed result/context available for the result controls; only the
  // in-flight socket is closed by the store's route cleanup boundary.
  if (tryOn.hasActiveAttempt) tryOn.cancelCurrentAttempt();
  tryOn.clear();
});

async function retry(): Promise<void> {
  if (!tryOn.context) return;
  started.value = true;
  await tryOn.retry();
}

async function returnToProduct(): Promise<void> {
  const current = tryOn.context;
  if (!current) {
    await submitMachineNavigationIntent({
      type: "customer.navigate",
      target: { name: "catalog" },
    });
    return;
  }
  tryOn.cancelCurrentAttempt();
  await submitMachineNavigationIntent({
    type: "customer.navigate",
    target: {
      name: "product-detail",
      params: { catalogKey: current.catalogKey },
      query: { variantId: current.variantId },
    },
  });
}
</script>

<template>
  <KioskLayout>
    <main
      class="flex h-full min-h-0 flex-col items-center justify-center gap-6 p-8"
      data-test="try-on-view"
      :data-catalog-key="context?.catalogKey ?? ''"
      :data-variant-id="context?.variantId ?? ''"
      :data-attempt-id="tryOn.attemptId ?? ''"
      :data-state="tryOn.phase"
    >
      <p class="text-sm text-neutral-500">{{ title }}</p>
      <h1 class="text-4xl font-black text-neutral-950">虚拟试衣</h1>
      <img
        v-if="tryOn.phase === 'completed' && tryOn.result"
        :src="tryOn.result.reference"
        :width="tryOn.result.width"
        :height="tryOn.result.height"
        alt="快速试衣结果"
        class="max-h-[60vh] max-w-full rounded-xl object-contain shadow-lg"
        data-test="try-on-result-image"
      />
      <p
        v-else
        class="text-xl font-bold text-neutral-700"
        data-test="try-on-phase"
      >
        {{ phaseText }}
      </p>
      <p
        v-if="tryOn.phase === 'failed'"
        class="text-base text-red-600"
        data-test="try-on-failure"
      >
        本次试衣未完成，商品购买不受影响。
      </p>
      <div class="flex gap-4">
        <button
          v-if="tryOn.phase === 'completed' || tryOn.phase === 'failed'"
          class="kiosk-touch-target rounded-lg bg-neutral-950 px-6 py-3 text-lg font-bold text-white"
          type="button"
          data-test="try-on-retry"
          @click="retry"
        >
          重试
        </button>
        <button
          class="kiosk-touch-target rounded-lg border border-neutral-300 bg-white px-6 py-3 text-lg font-bold"
          type="button"
          data-test="try-on-return"
          @click="returnToProduct"
        >
          返回商品
        </button>
      </div>
      <span v-if="started && tryOn.phase === 'completed'" class="sr-only"
        >可查看结果</span
      >
    </main>
  </KioskLayout>
</template>
