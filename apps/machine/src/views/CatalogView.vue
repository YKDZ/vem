<script setup lang="ts">
import { computed, onMounted, onUnmounted } from "vue";
import { useRouter } from "vue-router";

import type { MachineCatalogItem } from "@/types/catalog";

import ProductCard from "@/components/ProductCard.vue";
import { useVisionRecommendations } from "@/composables/useVisionRecommendations";
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
const { recommendedItems, lastVisionResult } = useVisionRecommendations();
const READINESS_REFRESH_INTERVAL_MS = 5000;
let readinessRefreshTimer: number | null = null;
let readinessRefreshInFlight: Promise<void> | null = null;

const canDisplayAsSaleReady = computed(
  () => connectivityStore.isSaleNetworkReady,
);
const displayItems = computed(() => catalogStore.availableItems);
const hasRecommendationPanel = computed(
  () => recommendedItems.value.length > 0 || lastVisionResult.value !== null,
);
const visionRecognitionRows = computed(() => {
  const result = lastVisionResult.value;
  if (!result) return [];
  const profile = result.profile;
  return [
    { label: "事件", value: result.eventId },
    { label: "时间", value: result.detectedAt },
    { label: "质量", value: result.quality.overall },
    {
      label: "置信度",
      value:
        typeof profile.confidence === "number"
          ? `${Math.round(profile.confidence * 100)}%`
          : "未返回",
    },
    {
      label: "有人",
      value: profile.personPresent ? "是" : "否",
    },
    {
      label: "身高",
      value:
        typeof profile.heightCm === "number"
          ? `${profile.heightCm} cm`
          : "未返回",
    },
    {
      label: "肩宽",
      value:
        typeof profile.shoulderWidthCm === "number"
          ? `${profile.shoulderWidthCm} cm`
          : "未返回",
    },
    { label: "年龄", value: profile.ageRange ?? "未返回" },
    { label: "性别", value: profile.gender ?? "未返回" },
    { label: "体型", value: profile.bodyType ?? "未返回" },
    { label: "上衣颜色", value: profile.upperColor ?? "未返回" },
  ];
});
const visionProfileJson = computed(() =>
  lastVisionResult.value
    ? JSON.stringify(lastVisionResult.value.profile, null, 2)
    : "",
);
const visionQualityWarnings = computed(
  () => lastVisionResult.value?.quality.warnings ?? [],
);
const degradedStatusMessages = computed(() => {
  const messages: string[] = [];
  if (mqttStore.outboxSize > 0) {
    messages.push(`MQTT backlog：${mqttStore.outboxSize} 条待补发`);
  }
  messages.push(...connectivityStore.degradedReasons);
  messages.push(...connectivityStore.saleReadinessDegradedMessages);
  return [...new Set(messages)];
});

async function selectProduct(item: MachineCatalogItem): Promise<void> {
  if (item.slotSalesState !== "sale_ready" || item.saleableStock <= 0) return;
  checkoutStore.selectItem(item);
  await router.push({
    name: "product-detail",
    params: { catalogKey: item.catalogKey },
  });
}

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
    <section class="flex h-full min-h-0 flex-col">
      <div class="flex shrink-0 items-end justify-between gap-4">
        <div class="min-w-0">
          <p class="text-sm tracking-[0.35em] text-sky-200 uppercase">
            CATALOG
          </p>
          <h2 class="mt-2 text-4xl font-black text-white">请选择商品</h2>
          <p class="mt-2 text-sm text-slate-300">
            最近更新：{{ catalogStore.lastUpdatedAt ?? "尚未同步" }}
            <span v-if="catalogStore.cachedOnly">（daemon 缓存）</span>
            <span v-if="catalogStore.loading"> · 同步中</span>
          </p>
          <p v-if="catalogStore.error" class="mt-2 text-sm text-amber-200">
            自动同步失败：{{ catalogStore.error }}
          </p>
        </div>
      </div>

      <p
        v-if="!canDisplayAsSaleReady"
        class="mt-5 shrink-0 rounded-2xl bg-amber-400/15 p-4 text-amber-100"
      >
        {{
          connectivityStore.saleReadinessBlockingMessages[0] ??
          "daemon 当前判定为不可售卖"
        }}，仅展示本地目录，购买入口已禁用。
      </p>

      <p
        class="mt-5 shrink-0 rounded-2xl bg-fuchsia-400/15 p-4 text-fuchsia-100"
      >
        视觉状态：{{ visionStore.message }}
      </p>

      <div v-if="hasRecommendationPanel" class="mt-5 shrink-0">
        <p class="text-sm tracking-[0.35em] text-amber-200 uppercase">
          FOR YOU
        </p>
        <h3 class="text-2xl font-bold text-white">为你推荐</h3>

        <section
          v-if="lastVisionResult"
          class="mt-3 rounded-2xl border border-fuchsia-300/20 bg-slate-950/45 p-4 text-sm text-slate-100"
        >
          <div class="flex items-center justify-between gap-3">
            <p class="font-bold text-fuchsia-100">视觉识别结果</p>
            <p class="text-xs text-slate-400">
              {{ lastVisionResult.detectedAt }}
            </p>
          </div>
          <div class="mt-3 grid grid-cols-2 gap-2">
            <div
              v-for="row in visionRecognitionRows"
              :key="row.label"
              class="min-w-0 rounded-lg bg-white/5 px-3 py-2"
            >
              <p class="text-xs text-slate-400">{{ row.label }}</p>
              <p class="truncate font-semibold text-white">{{ row.value }}</p>
            </div>
          </div>
          <p
            v-if="visionQualityWarnings.length > 0"
            class="mt-3 rounded-lg bg-amber-400/15 px-3 py-2 text-amber-100"
          >
            {{ visionQualityWarnings.join(" / ") }}
          </p>
          <pre
            class="mt-3 max-h-32 overflow-auto rounded-lg bg-black/30 p-3 text-xs leading-relaxed text-slate-200"
            >{{ visionProfileJson }}</pre
          >
        </section>

        <div
          v-if="recommendedItems.length > 0"
          class="kiosk-scroll mt-3 flex touch-pan-x gap-4 overflow-x-auto pb-4"
        >
          <div
            v-for="item in recommendedItems"
            :key="item.catalogKey"
            class="w-40 flex-shrink-0 cursor-pointer rounded-[1.75rem] border border-white/10 bg-white/10 p-4"
            @click="selectProduct(item)"
          >
            <p class="truncate text-sm font-bold text-white">
              {{ item.productName }}
            </p>
            <p class="mt-1 text-xs text-amber-200">
              {{ item.reason }}
            </p>
            <p class="mt-2 text-lg font-bold text-white">
              ¥{{ (item.priceCents / 100).toFixed(2) }}
            </p>
          </div>
        </div>
        <p
          v-else
          class="mt-3 rounded-2xl bg-white/10 p-4 text-sm text-slate-200"
        >
          暂无推荐商品
        </p>
      </div>

      <p
        v-for="message in degradedStatusMessages"
        :key="message"
        class="mt-5 shrink-0 rounded-2xl bg-sky-400/15 p-4 text-sky-100"
      >
        {{ message }}
      </p>

      <div
        v-if="displayItems.length > 0"
        class="kiosk-scroll mt-6 grid min-h-0 flex-1 touch-pan-y grid-cols-2 gap-4 overflow-y-auto pr-1 pb-8"
      >
        <ProductCard
          v-for="item in displayItems"
          :key="item.catalogKey"
          :item="item"
          :disabled="false"
          @select="selectProduct"
        />
      </div>

      <section
        v-else
        class="mt-8 rounded-4xl border border-white/10 bg-white/10 p-8 text-center text-slate-200"
      >
        <h3 class="text-2xl font-bold text-white">暂无可售商品</h3>
        <p class="mt-3">请联系运维补货，或等待系统自动同步目录。</p>
      </section>
    </section>
  </KioskLayout>
</template>
