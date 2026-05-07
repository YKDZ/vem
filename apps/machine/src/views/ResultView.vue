<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";

import type { CheckoutResultKind } from "@/types/checkout";

import KioskLayout from "@/layouts/KioskLayout.vue";
import { useCatalogStore } from "@/stores/catalog";
import { useCheckoutStore } from "@/stores/checkout";
import { useMachineStore } from "@/stores/machine";

const route = useRoute();
const router = useRouter();
const checkoutStore = useCheckoutStore();
const catalogStore = useCatalogStore();
const machineStore = useMachineStore();

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

const kind = computed(() => String(route.params.kind) as CheckoutResultKind);
const copy = computed(() => copyMap[kind.value] ?? copyMap.manual_handling);
const toneClass = computed(() => {
  if (copy.value.tone === "success") return "bg-emerald-400 text-slate-950";
  if (copy.value.tone === "danger") return "bg-rose-400 text-slate-950";
  return "bg-amber-300 text-slate-950";
});

async function backToCatalog(): Promise<void> {
  const machineCode = machineStore.config.machineCode;
  checkoutStore.reset();
  if (machineCode) await catalogStore.refresh(machineStore.config);
  await router.replace("/catalog");
}
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
        class="kiosk-touch-target mt-8 w-full rounded-3xl bg-sky-400 px-6 py-5 text-2xl font-black text-slate-950 shadow-xl shadow-sky-950/40"
        type="button"
        @click="backToCatalog"
      >
        返回首页
      </button>
    </section>
  </KioskLayout>
</template>
