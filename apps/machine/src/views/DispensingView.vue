<script setup lang="ts">
import { computed, onMounted, onUnmounted } from "vue";
import { useRouter } from "vue-router";

import KioskLayout from "@/layouts/KioskLayout.vue";
import { resultKindFromNextAction, useCheckoutStore } from "@/stores/checkout";
import { useMqttStore } from "@/stores/mqtt";

const router = useRouter();
const checkoutStore = useCheckoutStore();
const mqttStore = useMqttStore();

let pollTimer: number | undefined;

const status = computed(() => checkoutStore.status);
const command = computed(() => status.value?.vending ?? null);

async function refreshStatus(): Promise<void> {
  await checkoutStore.refreshCurrentTransaction();
  if (!checkoutStore.status) return;
  const resultKind = resultKindFromNextAction(checkoutStore.status.nextAction);
  if (resultKind) {
    await router.replace({ name: "result", params: { kind: resultKind } });
  }
}

onMounted(async () => {
  if (!checkoutStore.currentOrder) {
    await router.replace("/catalog");
    return;
  }
  await refreshStatus();
  pollTimer = window.setInterval(() => {
    void refreshStatus();
  }, 2_000);
});

onUnmounted(() => {
  if (pollTimer) window.clearInterval(pollTimer);
});
</script>

<template>
  <KioskLayout>
    <section
      class="flex h-full flex-col items-center justify-center text-center text-white"
    >
      <div
        class="w-full rounded-[2rem] border border-white/10 bg-white/10 p-8 shadow-2xl"
      >
        <p class="text-sm tracking-[0.35em] text-sky-200 uppercase">
          DISPENSING
        </p>
        <h2 class="mt-4 text-4xl font-black">支付成功，正在出货</h2>
        <p class="mt-4 text-lg text-slate-300">
          daemon 已接管 MQTT、硬件出货和 outbox 补发，UI 仅展示当前进度。
        </p>

        <div class="mt-8 grid gap-3 text-left text-slate-200">
          <div class="rounded-2xl bg-slate-950/40 p-4">
            订单状态：{{ status?.orderStatus ?? "查询中" }}
          </div>
          <div class="rounded-2xl bg-slate-950/40 p-4">
            支付状态：{{ status?.payment.status ?? "查询中" }}
          </div>
          <div class="rounded-2xl bg-slate-950/40 p-4">
            出货命令：{{ command?.commandNo ?? "等待后端创建" }}
          </div>
          <div class="rounded-2xl bg-slate-950/40 p-4">
            命令状态：{{ command?.status ?? "暂无" }}
          </div>
          <div
            v-if="command?.lastError"
            class="rounded-2xl bg-rose-500/20 p-4 text-rose-100"
          >
            {{ command.lastError }}
          </div>
          <div class="rounded-2xl bg-slate-950/40 p-4">
            机器 MQTT：{{ mqttStore.status }}
          </div>
          <div class="rounded-2xl bg-slate-950/40 p-4">
            本地 outbox：{{ mqttStore.outboxSize }} 条待补发
          </div>
          <div class="rounded-2xl bg-slate-950/40 p-4">
            最近命令：{{ mqttStore.lastCommandNo ?? "暂无" }}
          </div>
        </div>
      </div>
    </section>
  </KioskLayout>
</template>
