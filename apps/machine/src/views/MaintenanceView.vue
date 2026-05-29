<script setup lang="ts">
import { onMounted, reactive } from "vue";
import { useRouter } from "vue-router";

import MockHardwareControls from "@/components/MockHardwareControls.vue";
import {
  normalizeMachineConfig,
  type HardwareAdapter,
  type ScannerAdapter,
} from "@/config/machine-config";
import KioskLayout from "@/layouts/KioskLayout.vue";
import {
  getVisionRuntimeStatus,
  startVisionRuntime,
  stopVisionRuntime,
  visionSelfCheck,
} from "@/native/vision";
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
  scannerAdapter: machineStore.config.scannerAdapter,
  scannerSerialPortPath: machineStore.config.scannerSerialPortPath,
  scannerBaudRate: machineStore.config.scannerBaudRate,
  scannerFrameSuffix: machineStore.config.scannerFrameSuffix,
  visionEnabled: machineStore.config.visionEnabled,
  visionWsUrl: machineStore.config.visionWsUrl,
  visionAutoStart: machineStore.config.visionAutoStart,
  visionProcessCommand: machineStore.config.visionProcessCommand,
  visionProcessArgs: machineStore.config.visionProcessArgs,
  visionRequestTimeoutMs: machineStore.config.visionRequestTimeoutMs,
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
    form.scannerAdapter = machineStore.config.scannerAdapter;
    form.scannerSerialPortPath = machineStore.config.scannerSerialPortPath;
    form.scannerBaudRate = machineStore.config.scannerBaudRate;
    form.scannerFrameSuffix = machineStore.config.scannerFrameSuffix;
    form.visionEnabled = machineStore.config.visionEnabled;
    form.visionWsUrl = machineStore.config.visionWsUrl;
    form.visionAutoStart = machineStore.config.visionAutoStart;
    form.visionProcessCommand = machineStore.config.visionProcessCommand;
    form.visionProcessArgs = machineStore.config.visionProcessArgs;
    form.visionRequestTimeoutMs = machineStore.config.visionRequestTimeoutMs;
    form.kioskMode = machineStore.config.kioskMode;
  }
});

const visionMaintenance = reactive({
  loading: false,
  message: null as string | null,
});

const adapters: HardwareAdapter[] = [
  "mock",
  "serial",
  "bluetooth",
  "vendor_sdk",
];

const scannerAdapters: ScannerAdapter[] = [
  "disabled",
  "serial_text",
  "keyboard_hid",
  "web_serial_dev",
];

const scannerFrameSuffixes = ["crlf", "lf", "cr", "none"] as const;

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

async function runVisionAction(
  action: () => Promise<{ message: string }>,
): Promise<void> {
  visionMaintenance.loading = true;
  visionMaintenance.message = null;
  try {
    const result = await action();
    visionMaintenance.message = result.message;
  } catch (error) {
    visionMaintenance.message =
      error instanceof Error ? error.message : String(error);
  } finally {
    visionMaintenance.loading = false;
  }
}

async function checkVisionModule(): Promise<void> {
  const config = normalizeMachineConfig({
    ...machineStore.config,
    ...form,
    machineSecret: null,
    mqttSigningSecret: null,
    mqttPassword: null,
  });
  await runVisionAction(async () => {
    const result = await visionSelfCheck(config);
    return {
      message: result.online
        ? `视觉模块就绪：${result.message}`
        : `视觉模块不可用：${result.message}`,
    };
  });
}

async function startVisionModule(): Promise<void> {
  await runVisionAction(startVisionRuntime);
}

async function stopVisionModule(): Promise<void> {
  await runVisionAction(stopVisionRuntime);
}

async function refreshVisionStatus(): Promise<void> {
  await runVisionAction(getVisionRuntimeStatus);
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
        USB-TTL 串口路径；付款码被扫请在下方配置独立扫码器。mock
        适配器仅用于本地联调。
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

        <div class="rounded-3xl border border-white/10 bg-slate-950/30 p-5">
          <p
            class="text-sm font-semibold tracking-[0.28em] text-emerald-200 uppercase"
          >
            Scanner Adapter
          </p>
          <p class="mt-2 text-sm text-slate-300">
            用于读取支付宝/微信付款码；推荐将硬件控制板和扫码器分成独立串口。
          </p>

          <div class="mt-4 grid gap-4">
            <label class="grid gap-2 text-left">
              <span class="text-sm font-semibold text-slate-200"
                >扫码器适配器</span
              >
              <select
                v-model="form.scannerAdapter"
                class="kiosk-touch-target rounded-2xl border border-white/10 bg-slate-950/70 px-4 text-white outline-none focus:border-sky-300"
              >
                <option
                  v-for="scannerAdapter in scannerAdapters"
                  :key="scannerAdapter"
                  :value="scannerAdapter"
                >
                  {{ scannerAdapter }}
                </option>
              </select>
            </label>

            <label
              v-if="form.scannerAdapter === 'serial_text'"
              class="grid gap-2 text-left"
            >
              <span class="text-sm font-semibold text-slate-200"
                >扫码串口路径 scannerSerialPortPath</span
              >
              <input
                v-model="form.scannerSerialPortPath"
                class="kiosk-touch-target rounded-2xl border border-white/10 bg-slate-950/70 px-4 text-white outline-none focus:border-sky-300"
                placeholder="Linux 如 /dev/ttyUSB1；Windows 如 COM4"
              />
            </label>

            <label class="grid gap-2 text-left">
              <span class="text-sm font-semibold text-slate-200"
                >扫码波特率 scannerBaudRate</span
              >
              <input
                v-model.number="form.scannerBaudRate"
                class="kiosk-touch-target rounded-2xl border border-white/10 bg-slate-950/70 px-4 text-white outline-none focus:border-sky-300"
                min="1200"
                step="1"
                type="number"
              />
            </label>

            <label class="grid gap-2 text-left">
              <span class="text-sm font-semibold text-slate-200"
                >扫码结尾符 scannerFrameSuffix</span
              >
              <select
                v-model="form.scannerFrameSuffix"
                class="kiosk-touch-target rounded-2xl border border-white/10 bg-slate-950/70 px-4 text-white outline-none focus:border-sky-300"
              >
                <option
                  v-for="frameSuffix in scannerFrameSuffixes"
                  :key="frameSuffix"
                  :value="frameSuffix"
                >
                  {{ frameSuffix }}
                </option>
              </select>
            </label>
          </div>
        </div>

        <div class="rounded-3xl border border-white/10 bg-slate-950/30 p-5">
          <p
            class="text-sm font-semibold tracking-[0.28em] text-fuchsia-200 uppercase"
          >
            Vision Module
          </p>
          <p class="mt-2 text-sm text-slate-300">
            用于通过本地 WebSocket 接入机器视觉层；本地联调可启动
            apps/vision-mock。
          </p>

          <div class="mt-4 grid gap-4">
            <label class="flex items-center gap-3 text-left">
              <input
                v-model="form.visionEnabled"
                class="size-5 accent-fuchsia-300"
                type="checkbox"
              />
              <span class="text-sm font-semibold text-slate-200"
                >启用视觉推荐 visionEnabled</span
              >
            </label>

            <label class="grid gap-2 text-left">
              <span class="text-sm font-semibold text-slate-200"
                >视觉 WebSocket 地址 visionWsUrl</span
              >
              <input
                v-model="form.visionWsUrl"
                class="kiosk-touch-target rounded-2xl border border-white/10 bg-slate-950/70 px-4 text-white outline-none focus:border-fuchsia-300"
                placeholder="ws://127.0.0.1:7892/ws"
              />
            </label>

            <label class="grid gap-2 text-left">
              <span class="text-sm font-semibold text-slate-200"
                >视觉连接自检超时 visionRequestTimeoutMs</span
              >
              <input
                v-model.number="form.visionRequestTimeoutMs"
                class="kiosk-touch-target rounded-2xl border border-white/10 bg-slate-950/70 px-4 text-white outline-none focus:border-fuchsia-300"
                max="30000"
                min="1000"
                step="500"
                type="number"
              />
            </label>

            <label class="flex items-center gap-3 text-left">
              <input
                v-model="form.visionAutoStart"
                class="size-5 accent-fuchsia-300"
                type="checkbox"
              />
              <span class="text-sm font-semibold text-slate-200"
                >启动时托管视觉进程 visionAutoStart</span
              >
            </label>

            <label class="grid gap-2 text-left">
              <span class="text-sm font-semibold text-slate-200"
                >视觉进程命令 visionProcessCommand</span
              >
              <input
                v-model="form.visionProcessCommand"
                class="kiosk-touch-target rounded-2xl border border-white/10 bg-slate-950/70 px-4 text-white outline-none focus:border-fuchsia-300"
                placeholder="例如 pnpm"
              />
            </label>

            <label class="grid gap-2 text-left">
              <span class="text-sm font-semibold text-slate-200"
                >视觉进程参数 visionProcessArgs</span
              >
              <input
                v-model="form.visionProcessArgs"
                class="kiosk-touch-target rounded-2xl border border-white/10 bg-slate-950/70 px-4 text-white outline-none focus:border-fuchsia-300"
                placeholder="例如 -F vision-mock dev"
              />
              <p class="text-sm text-slate-400">
                如视觉程序由 systemd/Docker 单独维护，请关闭 autoStart。
              </p>
            </label>

            <div class="grid gap-3 md:grid-cols-4">
              <button
                class="kiosk-touch-target rounded-2xl border border-fuchsia-200/30 px-4 py-3 font-bold text-fuchsia-100 disabled:opacity-50"
                type="button"
                :disabled="visionMaintenance.loading"
                @click="checkVisionModule"
              >
                自检
              </button>
              <button
                class="kiosk-touch-target rounded-2xl border border-fuchsia-200/30 px-4 py-3 font-bold text-fuchsia-100 disabled:opacity-50"
                type="button"
                :disabled="visionMaintenance.loading"
                @click="startVisionModule"
              >
                启动进程
              </button>
              <button
                class="kiosk-touch-target rounded-2xl border border-fuchsia-200/30 px-4 py-3 font-bold text-fuchsia-100 disabled:opacity-50"
                type="button"
                :disabled="visionMaintenance.loading"
                @click="stopVisionModule"
              >
                停止进程
              </button>
              <button
                class="kiosk-touch-target rounded-2xl border border-fuchsia-200/30 px-4 py-3 font-bold text-fuchsia-100 disabled:opacity-50"
                type="button"
                :disabled="visionMaintenance.loading"
                @click="refreshVisionStatus"
              >
                状态
              </button>
            </div>

            <p
              v-if="visionMaintenance.message"
              class="rounded-2xl bg-fuchsia-500/15 p-4 text-fuchsia-100"
            >
              {{ visionMaintenance.message }}
            </p>
          </div>
        </div>

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
