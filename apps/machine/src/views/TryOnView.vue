<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute } from "vue-router";

import KioskLayout from "@/layouts/KioskLayout.vue";
import { submitMachineNavigationIntent } from "@/router/transaction-route-authority";
import { useCatalogStore } from "@/stores/catalog";
import { type TryOnPhase, useTryOnStore } from "@/stores/try-on";

const route = useRoute();
const catalog = useCatalogStore();
const tryOn = useTryOnStore();
const previewErrored = ref(false);
const capturedImageState = ref<"loading" | "ready" | "error">("loading");
const resultErrored = ref(false);
const departureHandled = ref(false);
const capturedPresentationError = ref(false);
const presentedPreviewUrl = ref<string | null>(null);
type CapturedPresentation = {
  attemptId: string;
  reference: string;
  width: number;
  height: number;
};
const presentedCaptured = ref<CapturedPresentation | null>(null);
const capturedVisibleSince = ref<number | null>(null);
const capturedPresentationPhase = ref<"captured" | "generating">("captured");
const resultPresentationReady = ref(false);
let resultPresentationTimer: ReturnType<typeof setTimeout> | null = null;
// 从成功 load 起至少展示一秒，覆盖常规观测采样，不改变 Vision 协议超时。
const minimumCapturedPresentationMs = 1_000;
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
      return tryOn.generationStage === "generating" ||
        tryOn.generationStage === "rendering" ||
        tryOn.generationStage === "validating_result"
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
    case "counting_down": {
      return countdownSeconds.value === null
        ? "请保持不动，正在拍摄"
        : `请保持不动，${countdownSeconds.value} 秒后自动拍摄`;
    }
    default:
      return "正在连接镜头";
  }
});
const countdownSeconds = computed(() => {
  const holdRemainingMs = tryOn.holdRemainingMs;
  if (
    typeof holdRemainingMs !== "number" ||
    !Number.isInteger(holdRemainingMs) ||
    holdRemainingMs < 0 ||
    holdRemainingMs > 3_000
  ) {
    return null;
  }
  const seconds = Math.ceil(holdRemainingMs / 1000);
  return seconds >= 1 && seconds <= 3 ? seconds : null;
});
const manualCaptureLabel = computed(() =>
  tryOn.guidance === "counting_down" ? "立即拍摄" : "手动采集",
);
const garmentScalePercent = computed(() =>
  Math.round(tryOn.garmentScale * 100),
);
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
const isCapturedPreloading = computed(
  () =>
    presentedCaptured.value !== null && capturedImageState.value === "loading",
);
const isCapturedPresented = computed(
  () =>
    presentedCaptured.value !== null && capturedImageState.value === "ready",
);
const showLivePreview = computed(
  () =>
    (tryOn.phase === "acquiring" || isCapturedPreloading.value) &&
    Boolean(presentedPreviewUrl.value) &&
    !previewErrored.value,
);
const showResult = computed(
  () =>
    tryOn.phase === "completed" &&
    Boolean(tryOn.result) &&
    !tryOn.resultUnavailable &&
    !resultErrored.value &&
    resultPresentationReady.value,
);
const canScaleGarment = computed(() => showResult.value && !tryOn.adjusting);
const canScaleUp = computed(
  () => canScaleGarment.value && tryOn.garmentScale < 1.6,
);
const canScaleDown = computed(
  () => canScaleGarment.value && tryOn.garmentScale > 0.8,
);
const presentationPhase = computed<TryOnPhase>(() => {
  if (isCapturedPreloading.value) return "acquiring";
  if (isCapturedPresented.value && !showResult.value) {
    if (tryOn.phase === "captured" || tryOn.phase === "generating") {
      return tryOn.phase;
    }
    return capturedPresentationPhase.value;
  }
  return tryOn.phase;
});

watch(
  () => tryOn.previewUrl,
  (previewUrl) => {
    if (previewUrl) presentedPreviewUrl.value = previewUrl;
    previewErrored.value = false;
  },
  { immediate: true },
);
watch(
  () => ({ attemptId: tryOn.attemptId, captured: tryOn.captured }),
  ({ attemptId, captured }, previous) => {
    if (!attemptId || !captured) {
      if (tryOn.phase !== "completed" && !capturedPresentationError.value) {
        resetCapturedPresentation();
      }
      return;
    }
    if (
      previous?.attemptId === attemptId &&
      previous.captured?.reference === captured.reference
    ) {
      return;
    }
    clearResultPresentationTimer();
    presentedCaptured.value = {
      attemptId,
      reference: captured.reference,
      width: captured.width,
      height: captured.height,
    };
    capturedImageState.value = "loading";
    capturedVisibleSince.value = null;
    capturedPresentationPhase.value = "captured";
    resultPresentationReady.value = false;
  },
  { immediate: true },
);
watch(
  () => tryOn.result?.reference,
  () => {
    resultErrored.value = false;
  },
);
watch(
  [() => tryOn.resultUnavailable, resultErrored],
  ([resultUnavailable, errored]) => {
    if (resultUnavailable || errored) resetCapturedPresentation();
  },
);
watch(
  () => tryOn.phase,
  (phase) => {
    if (phase === "generating" && isCapturedPresented.value) {
      capturedPresentationPhase.value = "generating";
    }
    if (phase === "completed" && tryOn.result) {
      scheduleResultPresentation();
      return;
    }
    if (phase !== "completed") resultPresentationReady.value = false;
    if (
      (phase === "failed" || phase === "canceled" || phase === "idle") &&
      !capturedPresentationError.value
    ) {
      resetCapturedPresentation();
    }
  },
);
watch(
  () => tryOn.attemptId,
  (attemptId, previousAttemptId) => {
    if (attemptId !== previousAttemptId) {
      resetCapturedPresentation();
      presentedPreviewUrl.value = null;
    }
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
  if (tryOn.context && tryOn.phase === "idle") void tryOn.start();
});

onUnmounted(() => {
  resetCapturedPresentation();
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

function recordCapturedImageLoad(event: Event): void {
  const resource = capturedResourceFor(event);
  if (!resource) return;
  if (!isCurrentCapturedPresentation(resource)) return;
  const image = event.currentTarget as HTMLImageElement;
  if (image.naturalWidth <= 0 || image.naturalHeight <= 0) {
    failCapturedPresentation(resource);
    return;
  }
  capturedImageState.value = "ready";
  capturedVisibleSince.value = Date.now();
  capturedPresentationPhase.value =
    tryOn.phase === "generating" ? "generating" : "captured";
  scheduleResultPresentation();
}

function recordCapturedImageError(event: Event): void {
  const resource = capturedResourceFor(event);
  if (!resource) return;
  if (!isCurrentCapturedPresentation(resource)) return;
  failCapturedPresentation(resource);
}

function isCurrentCapturedPresentation(
  resource: CapturedPresentation,
): boolean {
  return (
    presentedCaptured.value?.attemptId === resource.attemptId &&
    presentedCaptured.value.reference === resource.reference &&
    tryOn.attemptId === resource.attemptId &&
    tryOn.phase !== "failed" &&
    tryOn.phase !== "canceled" &&
    tryOn.phase !== "idle"
  );
}

function capturedResourceFor(event: Event): CapturedPresentation | null {
  const image = event.currentTarget as HTMLImageElement;
  const attemptId = image.dataset.capturedAttemptId;
  const reference = image.getAttribute("src");
  if (!attemptId || !reference) return null;
  return {
    attemptId,
    reference,
    width: image.width,
    height: image.height,
  };
}

function scheduleResultPresentation(): void {
  clearResultPresentationTimer();
  if (
    tryOn.phase !== "completed" ||
    !tryOn.result ||
    capturedImageState.value !== "ready" ||
    capturedVisibleSince.value === null
  ) {
    return;
  }
  const remaining = Math.max(
    0,
    minimumCapturedPresentationMs - (Date.now() - capturedVisibleSince.value),
  );
  if (remaining === 0) {
    resultPresentationReady.value = true;
    return;
  }
  const owner = presentedCaptured.value;
  resultPresentationTimer = setTimeout(() => {
    if (
      owner &&
      isCurrentCapturedPresentation(owner) &&
      tryOn.phase === "completed" &&
      Boolean(tryOn.result)
    ) {
      resultPresentationReady.value = true;
    }
  }, remaining);
}

function clearResultPresentationTimer(): void {
  if (resultPresentationTimer !== null) {
    clearTimeout(resultPresentationTimer);
    resultPresentationTimer = null;
  }
}

function resetCapturedPresentation(): void {
  clearResultPresentationTimer();
  presentedCaptured.value = null;
  capturedImageState.value = "loading";
  capturedVisibleSince.value = null;
  capturedPresentationPhase.value = "captured";
  capturedPresentationError.value = false;
  resultPresentationReady.value = false;
}

function failCapturedPresentation(resource: CapturedPresentation): void {
  if (!isCurrentCapturedPresentation(resource)) return;
  clearResultPresentationTimer();
  presentedCaptured.value = null;
  capturedImageState.value = "error";
  capturedPresentationError.value = true;
  resultPresentationReady.value = false;
  tryOn.failCapturedPresentation(resource.attemptId);
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

function scaleGarment(delta: number): void {
  if (!canScaleGarment.value) return;
  void tryOn.requestGarmentScale(tryOn.garmentScale + delta);
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
      :data-failure-reason="tryOn.failureReason ?? ''"
      :data-state="presentationPhase"
    >
      <p class="try-on-subtitle">{{ title }}</p>
      <h1 class="try-on-title">虚拟试衣</h1>
      <img
        v-if="showLivePreview"
        :src="presentedPreviewUrl ?? undefined"
        alt="虚拟试衣采集画面"
        class="try-on-acquisition-preview try-on-media"
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
        v-else-if="showResult && tryOn.result"
        :src="tryOn.result.reference"
        :width="tryOn.result.width"
        :height="tryOn.result.height"
        alt="虚拟试衣结果"
        class="try-on-result try-on-media"
        data-test="try-on-result-image"
        @error="resultErrored = true"
      />
      <p
        v-else-if="capturedPresentationError"
        class="text-base text-red-600"
        data-test="try-on-captured-error"
        data-image-state="error"
      >
        试衣输入暂不可显示，请重试或返回商品。
      </p>
      <p
        v-else-if="
          tryOn.phase === 'completed' &&
          (tryOn.resultUnavailable || resultErrored) &&
          capturedImageState !== 'error'
        "
        class="text-base text-red-600"
        data-test="try-on-result-error"
      >
        {{
          tryOn.resultUnavailable
            ? "试衣结果连接已断开，请重试或返回商品。"
            : "试衣结果暂不可显示，请重试或返回商品。"
        }}
      </p>
      <p
        v-else-if="presentationPhase !== 'acquiring' && !isCapturedPresented"
        class="try-on-phase"
        data-test="try-on-phase"
      >
        {{ phaseText }}
      </p>
      <img
        v-if="
          presentedCaptured && capturedImageState !== 'error' && !showResult
        "
        :key="`${presentedCaptured.attemptId}:${presentedCaptured.reference}`"
        :src="presentedCaptured.reference"
        :width="presentedCaptured.width"
        :height="presentedCaptured.height"
        alt="虚拟试衣捕获画面"
        class="try-on-captured-preload try-on-media"
        :data-test="
          capturedImageState === 'ready' ? 'try-on-captured-image' : undefined
        "
        :data-image-state="capturedImageState"
        :data-captured-attempt-id="presentedCaptured.attemptId"
        :style="{
          display: capturedImageState === 'ready' ? undefined : 'none',
        }"
        @error="recordCapturedImageError"
        @load="recordCapturedImageLoad"
      />
      <p
        v-if="tryOn.phase === 'acquiring'"
        class="try-on-guidance"
        data-test="try-on-guidance"
      >
        <span
          v-if="tryOn.guidance === 'counting_down' && countdownSeconds !== null"
          class="try-on-countdown"
          data-test="try-on-countdown"
          :data-hold-remaining-ms="tryOn.holdRemainingMs"
        >
          {{ countdownSeconds }}
        </span>
        {{ guidanceText }}
      </p>
      <p
        v-if="tryOn.phase === 'failed'"
        class="text-base text-red-600"
        data-test="try-on-failure"
      >
        商品购买不受影响。
      </p>
      <div
        v-if="showResult && tryOn.result"
        class="flex items-center justify-center gap-4"
        data-test="try-on-garment-scale"
      >
        <button
          class="try-on-button kiosk-touch-target disabled:opacity-35"
          type="button"
          data-test="try-on-scale-down"
          :disabled="!canScaleDown"
          @click="scaleGarment(-0.05)"
        >
          − 缩小
        </button>
        <span class="try-on-scale-value" data-test="try-on-scale-value">
          {{ garmentScalePercent }}%
        </span>
        <button
          class="try-on-button kiosk-touch-target disabled:opacity-35"
          type="button"
          data-test="try-on-scale-up"
          :disabled="!canScaleUp"
          @click="scaleGarment(0.05)"
        >
          + 放大
        </button>
      </div>
      <div class="flex flex-wrap justify-center gap-4">
        <button
          v-if="tryOn.phase === 'acquiring'"
          class="try-on-button kiosk-touch-target disabled:opacity-35"
          type="button"
          :disabled="
            !tryOn.manualCaptureAllowed || tryOn.manualCaptureSubmitted
          "
          data-test="try-on-manual-capture"
          @click="requestManualCapture"
        >
          {{ manualCaptureLabel }}
        </button>
        <button
          v-if="tryOn.hasActiveAttempt"
          class="try-on-button try-on-button-danger kiosk-touch-target"
          type="button"
          data-test="try-on-cancel"
          @click="cancel"
        >
          取消试衣
        </button>
        <button
          v-if="canRetry"
          class="try-on-button try-on-button-primary kiosk-touch-target"
          type="button"
          data-test="try-on-retry"
          @click="retry"
        >
          重试
        </button>
        <button
          class="try-on-button kiosk-touch-target"
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

<style scoped>
.try-on-subtitle {
  color: #8b8174;
  font-family: SimSun, "Songti SC", "Noto Serif CJK SC", serif;
  font-size: 0.95rem;
  letter-spacing: 0.08em;
}

.try-on-title {
  color: #474039;
  font-family: SimSun, "Songti SC", "Noto Serif CJK SC", serif;
  font-size: 2.6rem;
  font-weight: 800;
  letter-spacing: 0.1em;
}

.try-on-media {
  max-height: 55vh;
  max-width: 100%;
  border: 1px solid rgba(211, 203, 180, 0.92);
  border-radius: 24px;
  background: rgba(255, 253, 248, 0.72);
  object-fit: contain;
  box-shadow:
    inset 0 0 0 6px rgba(255, 255, 255, 0.5),
    0 16px 34px rgba(102, 92, 64, 0.1);
}

.try-on-result {
  max-height: 60vh;
}

.try-on-phase {
  color: #6b6258;
  font-family: SimSun, "Songti SC", "Noto Serif CJK SC", serif;
  font-size: 1.35rem;
  font-weight: 700;
  letter-spacing: 0.06em;
}

.try-on-guidance {
  display: flex;
  min-height: 58px;
  align-items: center;
  justify-content: center;
  gap: 0.9rem;
  border: 1px solid rgba(211, 203, 180, 0.92);
  border-radius: 18px;
  background: rgba(255, 253, 248, 0.82);
  padding: 0.7rem 1.4rem;
  color: #6b6258;
  font-family: SimSun, "Songti SC", "Noto Serif CJK SC", serif;
  font-size: 1.15rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  box-shadow: 0 10px 20px rgba(102, 92, 64, 0.08);
}

.try-on-countdown {
  display: grid;
  width: 44px;
  height: 44px;
  place-items: center;
  border-radius: 999px;
  background: linear-gradient(180deg, #758868, #627655);
  color: #fffdf7;
  font-family: Georgia, "Times New Roman", serif;
  font-size: 1.45rem;
  font-weight: 800;
  line-height: 1;
}

.try-on-button {
  min-height: 54px;
  border: 1px solid rgba(211, 203, 180, 0.92);
  border-radius: 18px;
  background: rgba(255, 253, 248, 0.78);
  color: #5f584f;
  font-family: SimSun, "Songti SC", "Noto Serif CJK SC", serif;
  font-size: 1.08rem;
  font-weight: 700;
  letter-spacing: 0.05em;
  padding: 0 1.5rem;
  box-shadow: 0 10px 20px rgba(102, 92, 64, 0.08);
}

.try-on-button-primary {
  border-color: rgba(111, 131, 95, 0.72);
  background: linear-gradient(180deg, #758868, #627655);
  color: #fffdf7;
  box-shadow: 0 14px 24px rgba(82, 101, 65, 0.2);
}

.try-on-button-danger {
  border-color: rgba(210, 169, 155, 0.72);
  color: #a65a4a;
}

.try-on-scale-value {
  width: 4rem;
  color: #6b6258;
  font-family: Georgia, "Times New Roman", serif;
  font-size: 1.15rem;
  font-weight: 700;
  text-align: center;
}
</style>
