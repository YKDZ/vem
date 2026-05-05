<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";

import KioskLayout from "@/layouts/KioskLayout.vue";
import { useCatalogStore } from "@/stores/catalog";
import { useConnectivityStore } from "@/stores/connectivity";
import { useMachineStore } from "@/stores/machine";
import { useMqttStore } from "@/stores/mqtt";

const router = useRouter();
const machineStore = useMachineStore();
const connectivityStore = useConnectivityStore();
const catalogStore = useCatalogStore();
const mqttStore = useMqttStore();
const steps = ref<string[]>([]);

function pushStep(message: string): void {
  steps.value = [...steps.value, message];
}

onMounted(async () => {
  pushStep("读取本地机器配置");
  await machineStore.loadConfig();

  if (!machineStore.hasDeploymentConfig) {
    pushStep("缺少 machineCode，进入部署配置页");
    await router.replace("/maintenance");
    return;
  }

  pushStep("执行 mock 硬件自检");
  await machineStore.runHardwareSelfCheck();

  pushStep("检查后端健康状态");
  await connectivityStore.checkBackend(machineStore.config);

  if (!connectivityStore.backendOnline) {
    pushStep("后端不可用，进入离线页");
    catalogStore.loadCached(machineStore.config.machineCode!);
    await router.replace("/offline");
    return;
  }

  pushStep("拉取本机商品目录");
  await catalogStore.refresh(machineStore.config);

  pushStep("连接 MQTT 并补发本地事件");
  await mqttStore.connect(machineStore.config);
  await mqttStore.flushOutbox();

  if (!connectivityStore.isSaleNetworkReady || !machineStore.canSell) {
    pushStep("网络或硬件未就绪，进入离线页");
    await router.replace("/offline");
    return;
  }

  pushStep("启动完成，进入商品目录");
  await router.replace("/catalog");
});
</script>

<template>
  <KioskLayout>
    <section
      class="flex h-full flex-col items-center justify-center text-center"
    >
      <div
        class="w-full rounded-4xl border border-white/10 bg-white/10 p-8 shadow-2xl"
      >
        <p class="text-sm tracking-[0.4em] text-sky-200 uppercase">BOOTING</p>
        <h2 class="mt-4 text-4xl font-bold text-white">正在启动售货机端</h2>
        <ul class="mt-8 space-y-3 text-left text-lg text-slate-200">
          <li
            v-for="step in steps"
            :key="step"
            class="rounded-2xl bg-slate-950/40 px-5 py-4"
          >
            {{ step }}
          </li>
        </ul>
      </div>
    </section>
  </KioskLayout>
</template>
