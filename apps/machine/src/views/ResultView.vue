<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import type { CheckoutResultKind } from "@/types/checkout";

import { daemonClient } from "@/daemon/client";
import KioskLayout from "@/layouts/KioskLayout.vue";
import { useCatalogStore } from "@/stores/catalog";
import { useCheckoutStore } from "@/stores/checkout";
import { useConnectivityStore } from "@/stores/connectivity";

const route = useRoute();
const router = useRouter();
const checkoutStore = useCheckoutStore();
const catalogStore = useCatalogStore();
const connectivityStore = useConnectivityStore();

const AUTO_RETURN_DELAY_MS = 6000;
const AUTO_RETURN_TICK_MS = 1000;

type ResultCopy = {
  title: string;
  subtitle: string;
  tone: "success" | "warning" | "danger";
  icon: string;
};

const copyMap: Record<CheckoutResultKind, ResultCopy> = {
  success: {
    title: "出货成功",
    subtitle: "请及时取走商品，欢迎再次使用。",
    tone: "success",
    icon: "✓",
  },
  payment_failed: {
    title: "支付失败",
    subtitle: "本次订单已取消，未完成扣款。",
    tone: "danger",
    icon: "×",
  },
  payment_expired: {
    title: "支付超时",
    subtitle: "二维码已过期，库存预占会由后端释放。",
    tone: "warning",
    icon: "⌛",
  },
  dispense_failed: {
    title: "出货失败",
    subtitle: "系统已记录异常，正在按订单状态发起退款或转人工处理。",
    tone: "danger",
    icon: "!",
  },
  refund_pending: {
    title: "退款处理中",
    subtitle: "出货异常已进入退款流程，请留意原支付渠道通知。",
    tone: "warning",
    icon: "↺",
  },
  refunded: {
    title: "已退款",
    subtitle: "款项已按原支付渠道退回。",
    tone: "success",
    icon: "¥",
  },
  manual_handling: {
    title: "等待人工处理",
    subtitle: "支付成功但出货状态异常，请联系现场运维或客服。",
    tone: "warning",
    icon: "…",
  },
  closed: {
    title: "订单已关闭",
    subtitle: "本次订单已结束。",
    tone: "warning",
    icon: "—",
  },
};
const DISPENSE_RESOLUTION_RESULT_KINDS: ReadonlySet<CheckoutResultKind> =
  new Set(["dispense_failed", "refund_pending", "refunded", "manual_handling"]);

const kind = computed(() => String(route.params.kind) as CheckoutResultKind);
const copy = computed(() => copyMap[kind.value] ?? copyMap.manual_handling);
const toneClass = computed(() => {
  if (copy.value.tone === "success") return "bg-emerald-400 text-slate-950";
  if (copy.value.tone === "danger") return "bg-rose-400 text-slate-950";
  return "bg-amber-300 text-slate-950";
});
const isDispenseFailureResult = computed(
  () => kind.value === "dispense_failed",
);
const isDispenseResolutionResult = computed(() =>
  DISPENSE_RESOLUTION_RESULT_KINDS.has(kind.value),
);
const resultReadinessError = ref<string | null>(null);
const requiresMaintenanceReview = computed(() => {
  if (!isDispenseFailureResult.value) return false;
  const ready = connectivityStore.ready;
  const saleReadiness = connectivityStore.saleReadiness;
  return Boolean(
    ready?.suggestedRoute === "maintenance" ||
    ready?.blockingCodes.includes("WHOLE_MACHINE_HARDWARE_FAULT") ||
    saleReadiness?.blockingCodes.includes("WHOLE_MACHINE_HARDWARE_FAULT") ||
    saleReadiness?.components.wholeMachineBlockers.ready === false,
  );
});
const canAutoReturn = computed(
  () =>
    Boolean(checkoutStore.resultKind) &&
    connectivityStore.isSaleNetworkReady &&
    !isDispenseResolutionResult.value,
);
const canManuallyReturn = computed(() => !isDispenseResolutionResult.value);
const autoReturnRemainingSeconds = ref(
  Math.ceil(AUTO_RETURN_DELAY_MS / AUTO_RETURN_TICK_MS),
);
const autoReturnMessage = computed(() => {
  const seconds = autoReturnRemainingSeconds.value;
  return `设备已恢复，${seconds} 秒后返回首页。`;
});

let autoReturnTimer: number | null = null;
let autoReturnStartedAt = 0;
let returningToCatalog = false;

function stopAutoReturn(): void {
  if (autoReturnTimer !== null) {
    window.clearInterval(autoReturnTimer);
    autoReturnTimer = null;
  }
}

function updateAutoReturnCountdown(): void {
  const elapsedMs = Date.now() - autoReturnStartedAt;
  const remainingMs = Math.max(AUTO_RETURN_DELAY_MS - elapsedMs, 0);
  autoReturnRemainingSeconds.value = Math.ceil(
    remainingMs / AUTO_RETURN_TICK_MS,
  );
  if (remainingMs <= 0) {
    void backToCatalog();
  }
}

function startAutoReturn(): void {
  if (autoReturnTimer !== null || returningToCatalog) return;
  autoReturnStartedAt = Date.now();
  autoReturnRemainingSeconds.value = Math.ceil(
    AUTO_RETURN_DELAY_MS / AUTO_RETURN_TICK_MS,
  );
  autoReturnTimer = window.setInterval(
    updateAutoReturnCountdown,
    AUTO_RETURN_TICK_MS,
  );
}

async function backToCatalog(): Promise<void> {
  if (returningToCatalog) return;
  returningToCatalog = true;
  stopAutoReturn();
  checkoutStore.dismissCurrentTerminalTransaction();
  checkoutStore.reset();
  await catalogStore.refresh();
  await router.replace("/catalog");
}

async function refreshResultReadiness(): Promise<void> {
  if (!isDispenseFailureResult.value) {
    return;
  }
  try {
    const [ready, saleReadiness] = await Promise.all([
      daemonClient.getReady(),
      daemonClient.getSaleReadiness(),
    ]);
    connectivityStore.applyReady(ready);
    connectivityStore.applySaleReadiness(saleReadiness);
  } catch (error) {
    resultReadinessError.value =
      error instanceof Error ? error.message : String(error);
    return;
  }
}

watch(
  canAutoReturn,
  (enabled) => {
    if (enabled) {
      startAutoReturn();
    } else {
      stopAutoReturn();
    }
  },
  { immediate: true },
);

onMounted(() => {
  void refreshResultReadiness();
});

onBeforeUnmount(stopAutoReturn);
</script>

<template>
  <KioskLayout>
    <section
      class="flex h-full flex-col items-center justify-center text-center text-white"
    >
      <div
        class="w-full rounded-4xl border border-white/10 bg-white/10 p-8 shadow-2xl"
      >
        <div
          class="mx-auto flex size-28 items-center justify-center rounded-full text-6xl font-black"
          :class="toneClass"
        >
          {{ copy.icon }}
        </div>
        <h2 class="mt-6 text-5xl font-black">{{ copy.title }}</h2>
        <p class="mt-4 text-xl text-slate-200">{{ copy.subtitle }}</p>
        <p v-if="canAutoReturn" class="mt-4 text-base text-slate-300">
          {{ autoReturnMessage }}
        </p>
        <p
          v-else-if="requiresMaintenanceReview"
          class="mt-4 text-base text-rose-100"
        >
          设备需要维护检查，当前保持本次处理结果。
        </p>
        <p
          v-else-if="resultReadinessError"
          class="mt-4 text-amber-100 text-base"
        >
          无法确认设备恢复状态，当前保持本次处理结果。
        </p>

        <div class="mt-8 grid gap-3 text-left text-slate-200">
          <div class="rounded-2xl bg-slate-950/40 p-4">
            订单号：{{ checkoutStore.currentOrder?.orderNo ?? "-" }}
          </div>
          <div class="rounded-2xl bg-slate-950/40 p-4">
            订单状态：{{ checkoutStore.status?.orderStatus ?? "-" }}
          </div>
          <div class="rounded-2xl bg-slate-950/40 p-4">
            支付状态：{{ checkoutStore.status?.payment.status ?? "-" }}
          </div>
          <div
            v-if="checkoutStore.status?.vending?.lastError"
            class="rounded-2xl bg-rose-500/20 p-4 text-rose-100"
          >
            {{ checkoutStore.status.vending.lastError }}
          </div>
        </div>
      </div>

      <button
        v-if="canManuallyReturn"
        class="kiosk-touch-target mt-8 w-full rounded-3xl bg-sky-400 px-6 py-5 text-2xl font-black text-slate-950 shadow-xl shadow-sky-950/40"
        type="button"
        @click="backToCatalog"
      >
        返回首页
      </button>
    </section>
  </KioskLayout>
</template>
