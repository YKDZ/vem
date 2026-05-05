<script setup lang="ts">
import { reactive } from "vue";
import { useRouter } from "vue-router";

import MockHardwareControls from "@/components/MockHardwareControls.vue";
import {
  normalizeMachineConfig,
  type HardwareAdapter,
} from "@/config/machine-config";
import KioskLayout from "@/layouts/KioskLayout.vue";
import { useMachineStore } from "@/stores/machine";

const router = useRouter();
const machineStore = useMachineStore();

const form = reactive({ ...machineStore.config });
const adapters: HardwareAdapter[] = [
  "mock",
  "serial",
  "bluetooth",
  "vendor_sdk",
];

async function saveAndReboot(): Promise<void> {
  try {
    const normalized = normalizeMachineConfig(form);
    await machineStore.saveConfig(normalized);
    await router.replace("/boot");
  } catch (error) {
    machineStore.error = error instanceof Error ? error.message : String(error);
  }
}
</script>

<template>
  <KioskLayout>
    <section
      class="rounded-4xl border border-white/10 bg-white/10 p-6 text-white shadow-2xl"
    >
      <p class="text-sm tracking-[0.35em] text-amber-200 uppercase">
        MAINTENANCE
      </p>
      <h2 class="mt-3 text-3xl font-bold">部署配置 / 维护入口</h2>
      <p class="mt-3 text-slate-300">
        未配置机器编号时不会进入商品售卖页。第三阶段支持 mock
        出货模式切换，用于验证 MQTT 出货成功、失败与补发链路。
      </p>

      <form class="mt-8 grid gap-5" @submit.prevent="saveAndReboot">
        <label class="grid gap-2 text-left">
          <span class="text-sm font-semibold text-slate-200"
            >机器编号 machineCode</span
          >
          <input
            v-model="form.machineCode"
            class="kiosk-touch-target rounded-2xl border border-white/10 bg-slate-950/70 px-4 text-white outline-none focus:border-sky-300"
            placeholder="例如 M001"
          />
        </label>

        <label class="grid gap-2 text-left">
          <span class="text-sm font-semibold text-slate-200">API Base URL</span>
          <input
            v-model="form.apiBaseUrl"
            class="kiosk-touch-target rounded-2xl border border-white/10 bg-slate-950/70 px-4 text-white outline-none focus:border-sky-300"
          />
        </label>

        <label class="grid gap-2 text-left">
          <span class="text-sm font-semibold text-slate-200">MQTT URL</span>
          <input
            v-model="form.mqttUrl"
            class="kiosk-touch-target rounded-2xl border border-white/10 bg-slate-950/70 px-4 text-white outline-none focus:border-sky-300"
          />
        </label>

        <label class="grid gap-2 text-left">
          <span class="text-sm font-semibold text-slate-200"
            >Hardware Adapter</span
          >
          <select
            v-model="form.hardwareAdapter"
            class="kiosk-touch-target rounded-2xl border border-white/10 bg-slate-950/70 px-4 text-white outline-none focus:border-sky-300"
          >
            <option v-for="adapter in adapters" :key="adapter" :value="adapter">
              {{ adapter }}
            </option>
          </select>
        </label>

        <button
          class="kiosk-touch-target rounded-2xl bg-sky-400 px-6 py-4 text-lg font-bold text-slate-950 shadow-lg shadow-sky-950/40"
          type="submit"
        >
          保存配置并重新自检
        </button>

        <p
          v-if="machineStore.error"
          class="rounded-2xl bg-rose-500/20 p-4 text-rose-100"
        >
          {{ machineStore.error }}
        </p>
      </form>
      <div class="mt-6">
        <MockHardwareControls />
      </div>
    </section>
  </KioskLayout>
</template>
