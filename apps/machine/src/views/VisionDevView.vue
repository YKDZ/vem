<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

import KioskLayout from "@/layouts/KioskLayout.vue";
import {
  requestVisionProfile,
  visionSelfCheck,
  type VisionProfileResultPayload,
  type VisionSelfCheckResult,
} from "@/native/vision";
import { useMachineStore } from "@/stores/machine";

const machineStore = useMachineStore();
const loading = ref(false);
const selfCheck = ref<VisionSelfCheckResult | null>(null);
const result = ref<VisionProfileResultPayload | null>(null);
const error = ref<string | null>(null);

const prettyResult = computed(() =>
  result.value ? JSON.stringify(result.value, null, 2) : "",
);
const prettySelfCheck = computed(() =>
  selfCheck.value ? JSON.stringify(selfCheck.value, null, 2) : "",
);

onMounted(async () => {
  if (!machineStore.configLoaded) await machineStore.loadConfig();
});

async function runSelfCheck(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    selfCheck.value = await visionSelfCheck(machineStore.config);
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  } finally {
    loading.value = false;
  }
}

async function runProfileRequest(): Promise<void> {
  loading.value = true;
  error.value = null;
  result.value = null;
  try {
    result.value = await requestVisionProfile(machineStore.config, {
      sessionId: `dev-${Date.now()}`,
      trigger: "test",
      timeoutMs: machineStore.config.visionRequestTimeoutMs,
    });
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <KioskLayout>
    <section class="grid gap-6 text-white">
      <div class="rounded-4xl border border-white/10 bg-white/10 p-6">
        <p class="text-sm tracking-[0.35em] text-fuchsia-200 uppercase">
          VISION DEV
        </p>
        <h2 class="mt-3 text-3xl font-black">机器视觉协议联调</h2>
        <p class="mt-3 text-slate-300">
          本页面仅开发环境可见，可直接连接 apps/vision-mock 或真实 Python
          视觉程序，验证 WebSocket 协议是否工作。
        </p>
        <p class="mt-3 rounded-2xl bg-slate-950/40 p-4 text-sm text-slate-300">
          当前地址：{{
            machineStore.config.visionWsUrl
          }}；请先启动模拟服务或真实视觉服务。
        </p>
      </div>

      <div class="grid gap-4 md:grid-cols-2">
        <button
          class="kiosk-touch-target rounded-2xl bg-fuchsia-300 px-5 py-4 font-black text-slate-950 disabled:opacity-50"
          type="button"
          :disabled="loading"
          @click="runSelfCheck"
        >
          运行握手自检
        </button>
        <button
          class="kiosk-touch-target rounded-2xl bg-sky-300 px-5 py-4 font-black text-slate-950 disabled:opacity-50"
          type="button"
          :disabled="loading"
          @click="runProfileRequest"
        >
          请求模拟画像
        </button>
      </div>

      <p v-if="error" class="rounded-2xl bg-rose-500/20 p-4 text-rose-100">
        {{ error }}
      </p>

      <section
        v-if="selfCheck"
        class="rounded-4xl border border-white/10 bg-slate-950/40 p-6"
      >
        <h3 class="text-xl font-bold text-fuchsia-100">握手结果</h3>
        <pre class="mt-4 overflow-auto text-sm text-slate-200">{{
          prettySelfCheck
        }}</pre>
      </section>

      <section
        v-if="result"
        class="rounded-4xl border border-white/10 bg-slate-950/40 p-6"
      >
        <h3 class="text-xl font-bold text-sky-100">画像结果</h3>
        <pre class="mt-4 overflow-auto text-sm text-slate-200">{{
          prettyResult
        }}</pre>
      </section>
    </section>
  </KioskLayout>
</template>
