<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute } from "vue-router";

import KioskLayout from "@/layouts/KioskLayout.vue";
import { submitMachineNavigationIntent } from "@/router/transaction-route-authority";
import { useCatalogStore } from "@/stores/catalog";
import { useTryOnStore } from "@/stores/try-on";

const route = useRoute();
const catalog = useCatalogStore();
const tryOn = useTryOnStore();
const previewErrored = ref(false);
const resultErrored = ref(false);
const departureHandled = ref(false);
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
    case "accepted":
      return "正在准备虚拟试衣";
    case "acquiring":
      return guidanceText.value;
    case "generating":
      return tryOn.generationStage === "rendering"
        ? "正在生成试衣效果"
        : "正在准备试衣效果";
    case "completed":
      return "虚拟试衣完成";
    case "canceled":
      return cancellationText.value;
    case "failed":
      return "本次虚拟试衣未完成";
    default:
      return "准备虚拟试衣";
  }
});
const guidanceText = computed(() => {
  switch (tryOn.guidance) {
    case "no_person":
      return "请站到镜头前";
    case "multiple_people":
      return "请确保画面中只有一人";
    case "align":
      return "请面向镜头并调整站位";
    case "hold_still":
      return "请保持站稳，可手动采集";
    case "ready":
      return "正在采集，请保持站稳";
    default:
      return "正在连接镜头";
  }
});
const cancellationText = computed(() => {
  switch (tryOn.failureReason) {
    case "departure":
      return "检测到顾客已离开，本次试衣已取消";
    case "disconnect":
      return "视觉连接已断开，本次试衣已取消";
    case "timeout":
      return "本次试衣等待超时，已取消";
    case "replaced":
      return "已开始新的试衣，本次已取消";
    case "route_leave":
      return "已离开试衣页面";
    default:
      return "本次试衣已取消";
  }
});
const canRetry = computed(
  () =>
    tryOn.phase === "completed" ||
    tryOn.phase === "failed" ||
    tryOn.phase === "canceled",
);

watch(
  () => tryOn.previewUrl,
  () => {
    previewErrored.value = false;
  },
);
watch(
  () => tryOn.result?.reference,
  () => {
    resultErrored.value = false;
  },
);
watch(
  () => ({ phase: tryOn.phase, reason: tryOn.failureReason }),
  ({ phase, reason }) => {
    if (
      phase !== "canceled" ||
      reason !== "departure" ||
      departureHandled.value
    )
      return;
    departureHandled.value = true;
    void returnToProduct();
  },
  { flush: "sync" },
);

onMounted(() => {
  if (!tryOn.context) {
    const key =
      typeof route.query.catalogKey === "string" ? route.query.catalogKey : "";
    const variantId =
      typeof route.query.variantId === "string" ? route.query.variantId : "";
    const item = catalog.saleableVariantItemFor(key, variantId);
    if (item) tryOn.prepare(item);
  }
  if (tryOn.context && tryOn.phase === "idle") void tryOn.startFast();
});

onUnmounted(() => {
  if (tryOn.hasActiveAttempt) tryOn.cancelCurrentAttempt("route_leave");
  tryOn.clear();
});

async function retry(): Promise<void> {
  if (!tryOn.context) return;
  await tryOn.retry();
}

function requestManualCapture(): void {
  tryOn.requestManualCapture();
}

function cancel(): void {
  tryOn.cancelCurrentAttempt("user");
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
  if (tryOn.hasActiveAttempt) tryOn.cancelCurrentAttempt("route_leave");
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
        v-if="
          tryOn.phase === 'acquiring' && tryOn.previewUrl && !previewErrored
        "
        :src="tryOn.previewUrl"
        alt="虚拟试衣采集画面"
        class="max-h-[55vh] max-w-full rounded-xl object-contain shadow-lg"
        data-test="try-on-acquisition-preview"
        @error="previewErrored = true"
      />
      <p
        v-else-if="tryOn.phase === 'acquiring' && previewErrored"
        class="text-base text-red-600"
        data-test="try-on-acquisition-stream-error"
      >
        采集画面暂不可显示，请返回商品后重新开始。
      </p>
      <img
        v-else-if="
          tryOn.phase === 'completed' && tryOn.result && !resultErrored
        "
        :src="tryOn.result.reference"
        :width="tryOn.result.width"
        :height="tryOn.result.height"
        alt="虚拟试衣结果"
        class="max-h-[60vh] max-w-full rounded-xl object-contain shadow-lg"
        data-test="try-on-result-image"
        @error="resultErrored = true"
      />
      <p
        v-else-if="tryOn.phase === 'completed' && resultErrored"
        class="text-base text-red-600"
        data-test="try-on-result-error"
      >
        试衣结果暂不可显示，请重试或返回商品。
      </p>
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
        商品购买不受影响。
      </p>
      <div class="flex flex-wrap justify-center gap-4">
        <button
          v-if="tryOn.phase === 'acquiring'"
          class="kiosk-touch-target rounded-lg border border-neutral-300 bg-white px-6 py-3 text-lg font-bold disabled:opacity-35"
          type="button"
          :disabled="
            !tryOn.manualCaptureAllowed || tryOn.manualCaptureSubmitted
          "
          data-test="try-on-manual-capture"
          @click="requestManualCapture"
        >
          手动采集
        </button>
        <button
          v-if="tryOn.hasActiveAttempt"
          class="kiosk-touch-target rounded-lg border border-red-300 bg-white px-6 py-3 text-lg font-bold text-red-700"
          type="button"
          data-test="try-on-cancel"
          @click="cancel"
        >
          取消试衣
        </button>
        <button
          v-if="canRetry"
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
    </main>
  </KioskLayout>
</template>
