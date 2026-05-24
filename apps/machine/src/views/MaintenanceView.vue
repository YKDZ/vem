<script setup lang="ts">
import { onMounted, reactive } from "vue";
import { useRouter } from "vue-router";

import MockHardwareControls from "@/components/MockHardwareControls.vue";
import {
  normalizeMachineConfig,
  type HardwareAdapter,
} from "@/config/machine-config";
import KioskLayout from "@/layouts/KioskLayout.vue";
import { useMachineStore } from "@/stores/machine";
import { useMqttStore } from "@/stores/mqtt";

const router = useRouter();
const machineStore = useMachineStore();
const mqttStore = useMqttStore();

const form = reactive({
  machineCode: machineStore.config.machineCode,
  apiBaseUrl: machineStore.config.apiBaseUrl,
  mqttUrl: machineStore.config.mqttUrl,
  mqttUsername: machineStore.config.mqttUsername,
  hardwareAdapter: machineStore.config.hardwareAdapter,
  serialPortPath: machineStore.config.serialPortPath,
  kioskMode: machineStore.config.kioskMode,
  machineSecretInput: "",
  mqttSigningSecretInput: "",
  mqttPasswordInput: "",
});

onMounted(async () => {
  if (!machineStore.configLoaded) {
    await machineStore.loadConfig();
    form.machineCode = machineStore.config.machineCode;
    form.apiBaseUrl = machineStore.config.apiBaseUrl;
    form.mqttUrl = machineStore.config.mqttUrl;
    form.mqttUsername = machineStore.config.mqttUsername;
    form.hardwareAdapter = machineStore.config.hardwareAdapter;
    form.serialPortPath = machineStore.config.serialPortPath;
    form.kioskMode = machineStore.config.kioskMode;
  }
});

const adapters: HardwareAdapter[] = [
  "mock",
  "serial",
  "bluetooth",
  "vendor_sdk",
];

async function saveAndReboot(): Promise<void> {
  try {
    const normalized = normalizeMachineConfig({
      ...form,
      machineSecret: form.machineSecretInput.trim() || null,
      mqttSigningSecret: form.mqttSigningSecretInput.trim() || null,
      mqttPassword: form.mqttPasswordInput.trim() || null,
    });
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
        未配置机器编号时不会进入商品售卖页。真实设备请选择 serial 适配器并填写
        USB-TTL 串口路径；mock 适配器仅用于本地联调。
      </p>

      <div
        v-if="mqttStore.outboxWarning"
        class="mt-6 rounded-2xl border border-amber-300/30 bg-amber-500/20 p-4 text-amber-100"
      >
        {{ mqttStore.outboxWarning }}
      </div>

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

        <div class="grid gap-2 text-left">
          <span class="text-sm font-semibold text-slate-200"
            >机器密钥 machineSecret</span
          >
          <p class="rounded-2xl bg-slate-950/40 p-3 text-sm text-slate-300">
            机器密钥状态：
            <span class="font-semibold text-emerald-200">
              {{
                machineStore.config.machineSecretConfigured
                  ? "已配置"
                  : "未配置"
              }}
            </span>
          </p>
          <input
            v-model="form.machineSecretInput"
            autocomplete="new-password"
            class="kiosk-touch-target rounded-2xl border border-white/10 bg-slate-950/70 px-4 text-white outline-none focus:border-sky-300"
            placeholder="输入新机器密钥；留空保持现有密钥"
            type="password"
          />
        </div>

        <div class="grid gap-2 text-left">
          <span class="text-sm font-semibold text-slate-200"
            >MQTT 签名密钥 mqttSigningSecret</span
          >
          <p class="rounded-2xl bg-slate-950/40 p-3 text-sm text-slate-300">
            MQTT 签名密钥状态：
            <span class="font-semibold text-emerald-200">
              {{
                machineStore.config.mqttSigningSecretConfigured
                  ? "已配置"
                  : "未配置"
              }}
            </span>
          </p>
          <input
            v-model="form.mqttSigningSecretInput"
            autocomplete="new-password"
            class="kiosk-touch-target rounded-2xl border border-white/10 bg-slate-950/70 px-4 text-white outline-none focus:border-sky-300"
            placeholder="输入新 MQTT 签名密钥；留空保持现有密钥"
            type="password"
          />
        </div>

        <label class="grid gap-2 text-left">
          <span class="text-sm font-semibold text-slate-200"
            >MQTT 用户名 mqttUsername</span
          >
          <input
            v-model="form.mqttUsername"
            class="kiosk-touch-target rounded-2xl border border-white/10 bg-slate-950/70 px-4 text-white outline-none focus:border-sky-300"
            placeholder="MQTT Broker 用户名"
          />
        </label>

        <div class="grid gap-2 text-left">
          <span class="text-sm font-semibold text-slate-200"
            >MQTT 密码 mqttPassword</span
          >
          <p class="rounded-2xl bg-slate-950/40 p-3 text-sm text-slate-300">
            MQTT 密码状态：
            <span class="font-semibold text-emerald-200">
              {{
                machineStore.config.mqttPasswordConfigured ? "已配置" : "未配置"
              }}
            </span>
          </p>
          <input
            v-model="form.mqttPasswordInput"
            autocomplete="new-password"
            class="kiosk-touch-target rounded-2xl border border-white/10 bg-slate-950/70 px-4 text-white outline-none focus:border-sky-300"
            placeholder="输入新 MQTT 密码；留空保持现有密码"
            type="password"
          />
        </div>

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
          <span class="text-sm font-semibold text-slate-200">硬件适配器</span>
          <select
            v-model="form.hardwareAdapter"
            class="kiosk-touch-target rounded-2xl border border-white/10 bg-slate-950/70 px-4 text-white outline-none focus:border-sky-300"
          >
            <option v-for="adapter in adapters" :key="adapter" :value="adapter">
              {{ adapter }}
            </option>
          </select>
        </label>

        <label
          v-if="form.hardwareAdapter === 'serial'"
          class="grid gap-2 text-left"
        >
          <span class="text-sm font-semibold text-slate-200"
            >串口路径 serialPortPath</span
          >
          <input
            v-model="form.serialPortPath"
            class="kiosk-touch-target rounded-2xl border border-white/10 bg-slate-950/70 px-4 text-white outline-none focus:border-sky-300"
            placeholder="Linux 如 /dev/ttyUSB0；Windows 如 COM3"
          />
          <p class="text-sm text-slate-400">
            当前协议固定 115200 / 8N1 / None 校验 / 1 停止位。
          </p>
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
      <div v-if="form.hardwareAdapter === 'mock'" class="mt-6">
        <MockHardwareControls />
      </div>
    </section>
  </KioskLayout>
</template>
