<script setup lang="ts">
import { computed } from "vue";
import { useRouter } from "vue-router";

import KioskLayout from "@/layouts/KioskLayout.vue";
import { useCatalogStore } from "@/stores/catalog";
import { useConnectivityStore } from "@/stores/connectivity";
import { useMachineStore } from "@/stores/machine";
import { useMqttStore } from "@/stores/mqtt";

const router = useRouter();
const connectivityStore = useConnectivityStore();
const catalogStore = useCatalogStore();
const machineStore = useMachineStore();
const mqttStore = useMqttStore();

const cachedText = computed(() =>
  catalogStore.hasItems
    ? `已保留 ${catalogStore.items.length} 条最近商品目录，仅供浏览。`
    : "本机暂无可展示的缓存商品目录。",
);

async function retryBoot(): Promise<void> {
  await router.replace("/boot");
}
</script>

<template>
  <KioskLayout>
    <section
      class="flex h-full flex-col justify-center rounded-4xl border border-amber-300/20 bg-amber-500/10 p-8 text-center text-white"
    >
      <p class="text-sm tracking-[0.35em] text-amber-200 uppercase">OFFLINE</p>
      <h2 class="mt-4 text-4xl font-bold">暂时无法购买</h2>
      <p class="mt-5 text-xl text-amber-50">
        网络或服务未就绪，为避免支付和库存风险，当前禁止下单。
      </p>
      <p class="mt-4 text-slate-300">{{ cachedText }}</p>
      <div class="mt-4 grid gap-3 text-left text-sm text-slate-200">
        <div class="rounded-2xl bg-slate-950/40 p-4">
          阻塞原因：{{
            connectivityStore.blockingReasons.join(" / ") ||
            "daemon 未返回阻塞原因"
          }}
        </div>
        <div class="rounded-2xl bg-slate-950/40 p-4">
          缓存商品数：{{ catalogStore.items.length }}
        </div>
        <div class="rounded-2xl bg-slate-950/40 p-4">
          daemon outbox：{{ mqttStore.outboxSize }} 条待补发
        </div>
        <div class="rounded-2xl bg-slate-950/40 p-4">
          MQTT 错误：{{ mqttStore.lastError ?? "无" }}
        </div>
      </div>
      <p
        v-if="connectivityStore.error"
        class="mt-4 rounded-2xl bg-slate-950/40 p-4 text-left text-sm text-slate-200"
      >
        {{ connectivityStore.error }}
      </p>
      <div class="mt-8 grid gap-4">
        <button
          class="kiosk-touch-target rounded-2xl bg-white px-6 py-4 text-lg font-bold text-slate-950"
          type="button"
          @click="retryBoot"
        >
          重新检测网络
        </button>
        <button
          class="kiosk-touch-target rounded-2xl border border-white/20 px-6 py-4 text-lg font-bold text-white"
          type="button"
          @click="router.push('/maintenance')"
        >
          进入维护配置
        </button>
      </div>
      <p class="mt-6 text-sm text-slate-400">
        机器编号：{{ machineStore.machineCode ?? "未配置" }}
      </p>
    </section>
  </KioskLayout>
</template>
