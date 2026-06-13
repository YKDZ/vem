<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive } from "vue";
import { useRoute, useRouter } from "vue-router";

import MockHardwareControls from "@/components/MockHardwareControls.vue";
import {
  machineConfigDefaults,
  normalizeMachineConfig,
  type HardwareAdapter,
  type MachineConfig,
  type ScannerAdapter,
} from "@/config/machine-config";
import { shouldShowAdvancedMaintenanceConfig } from "@/config/runtime-flags";
import { daemonClient } from "@/daemon/client";
import KioskLayout from "@/layouts/KioskLayout.vue";
import { callTauriCommand, isTauriRuntime } from "@/native/tauri";
import { useCatalogStore } from "@/stores/catalog";
import { useConnectivityStore } from "@/stores/connectivity";
import { useMachineStore } from "@/stores/machine";
import { useMqttStore } from "@/stores/mqtt";
import { useRemoteOpsStore } from "@/stores/remote-ops";
import { useScannerStore } from "@/stores/scanner";
import { useVisionStore } from "@/stores/vision";

const router = useRouter();
const route = useRoute();
const catalogStore = useCatalogStore();
const connectivityStore = useConnectivityStore();
const machineStore = useMachineStore();
const mqttStore = useMqttStore();
const remoteOpsStore = useRemoteOpsStore();
const scannerStore = useScannerStore();
const visionStore = useVisionStore();
const MAINTENANCE_DIAGNOSTIC_REFRESH_MS = 5000;
let diagnosticsRefreshTimer: number | null = null;
let diagnosticsRefreshInFlight: Promise<void> | null = null;
const runtimeFlags = reactive({
  advancedMaintenanceConfig: false,
});
const showAdvancedDebugConfig = computed(
  () => runtimeFlags.advancedMaintenanceConfig,
);
const wholeMachineMaintenanceLock = computed(
  () =>
    connectivityStore.ready?.blockingReasons.find(
      (reason) => reason.code === "WHOLE_MACHINE_HARDWARE_FAULT",
    ) ?? null,
);
const returnToCatalogBlockedReason = computed(() => {
  if (connectivityStore.ready?.canSell === true) {
    return null;
  }
  const reason = connectivityStore.ready?.blockingReasons[0];
  if (reason) {
    return reason.message;
  }
  if (!connectivityStore.ready) {
    return "正在读取机器状态。";
  }
  return "机器未就绪。";
});
const operatorEnteredMaintenance = computed(() => {
  const source = route.query.source;
  return Array.isArray(source)
    ? source.includes("operator")
    : source === "operator";
});

function cloneLowerControllerUsbIdentity(
  identity: MachineConfig["lowerControllerUsbIdentity"],
) {
  return identity
    ? {
        vendorId: identity.vendorId,
        productId: identity.productId,
        serialNumber: identity.serialNumber ?? null,
      }
    : null;
}

const form = reactive({
  machineCode: machineConfigDefaults.machineCode,
  apiBaseUrl: machineConfigDefaults.apiBaseUrl,
  mqttUrl: machineConfigDefaults.mqttUrl,
  mqttUsername: machineConfigDefaults.mqttUsername,
  hardwareAdapter: machineConfigDefaults.hardwareAdapter,
  serialPortPath: machineConfigDefaults.serialPortPath,
  lowerControllerUsbIdentity: cloneLowerControllerUsbIdentity(
    machineConfigDefaults.lowerControllerUsbIdentity,
  ),
  scannerAdapter: machineConfigDefaults.scannerAdapter,
  scannerSerialPortPath: machineConfigDefaults.scannerSerialPortPath,
  scannerBaudRate: machineConfigDefaults.scannerBaudRate,
  scannerFrameSuffix: machineConfigDefaults.scannerFrameSuffix,
  visionEnabled: machineConfigDefaults.visionEnabled,
  visionWsUrl: machineConfigDefaults.visionWsUrl,
  visionRequestTimeoutMs: machineConfigDefaults.visionRequestTimeoutMs,
  kioskMode: machineConfigDefaults.kioskMode,
  machineSecretInput: "",
  mqttSigningSecretInput: "",
  mqttPasswordInput: "",
});

function syncFormFromStore(): void {
  form.machineCode = machineStore.config.machineCode;
  form.apiBaseUrl = machineStore.config.apiBaseUrl;
  form.mqttUrl = machineStore.config.mqttUrl;
  form.mqttUsername = machineStore.config.mqttUsername;
  form.hardwareAdapter = machineStore.config.hardwareAdapter;
  form.serialPortPath = machineStore.config.serialPortPath;
  form.lowerControllerUsbIdentity = cloneLowerControllerUsbIdentity(
    machineStore.config.lowerControllerUsbIdentity,
  );
  form.scannerAdapter = machineStore.config.scannerAdapter;
  form.scannerSerialPortPath = machineStore.config.scannerSerialPortPath;
  form.scannerBaudRate = machineStore.config.scannerBaudRate;
  form.scannerFrameSuffix = machineStore.config.scannerFrameSuffix;
  form.visionEnabled = machineStore.config.visionEnabled;
  form.visionWsUrl = machineStore.config.visionWsUrl;
  form.visionRequestTimeoutMs = machineStore.config.visionRequestTimeoutMs;
  form.kioskMode = machineStore.config.kioskMode;
}

onMounted(async () => {
  try {
    const connection = await daemonClient.initialize();
    runtimeFlags.advancedMaintenanceConfig =
      shouldShowAdvancedMaintenanceConfig({
        flag: connection.runtimeFlags?.advancedMaintenanceConfig,
      });
  } catch {
    runtimeFlags.advancedMaintenanceConfig =
      shouldShowAdvancedMaintenanceConfig({
        flag: import.meta.env.VITE_ENABLE_ADVANCED_MAINTENANCE_CONFIG,
      });
  }

  if (runtimeFlags.advancedMaintenanceConfig) {
    try {
      if (!machineStore.configLoaded) {
        await machineStore.loadConfig();
      }
      syncFormFromStore();
    } catch {
      // Keep maintenance usable with local defaults when daemon is temporarily unavailable.
    }
  }
  await Promise.allSettled([
    refreshStockMaintenanceView(),
    refreshDiagnostics(),
  ]);
  startDiagnosticsAutoRefresh();
});

onUnmounted(() => {
  stopDiagnosticsAutoRefresh();
});

const diagnostics = reactive({
  loading: false,
  message: null as string | null,
  logsMessage: null as string | null,
});

const hardwareMaintenance = reactive({
  loading: false,
  message: null as string | null,
});

const visionMaintenance = reactive({
  loading: false,
  message: null as string | null,
});

const wholeMachineLockMaintenance = reactive({
  loading: false,
  message: null as string | null,
});

const desktopMaintenance = reactive({
  loading: false,
  message: null as string | null,
});

const catalogNavigation = reactive({
  message: null as string | null,
});

const stockMaintenance = reactive({
  loading: false,
  message: null as string | null,
  planogramVersion: null as string | null,
  source: null as string | null,
  slots: [] as Array<{
    slotId: string;
    slotCode: string;
    productName: string;
    physicalStock: number;
    capacity: number;
  }>,
});

const stockForm = reactive({
  movementType: "planned_refill" as "planned_refill" | "stock_count_correction",
  planogramVersion: "",
  slotId: "",
  quantity: 1,
  attributedTo: "front-panel",
});

const adapters: HardwareAdapter[] = ["mock", "serial"];

const scannerAdapters: ScannerAdapter[] = ["disabled", "serial_text"];

const scannerFrameSuffixes = ["crlf", "lf", "cr", "none"] as const;

async function saveAndReboot(): Promise<void> {
  if (!runtimeFlags.advancedMaintenanceConfig) {
    return;
  }
  try {
    const normalized = normalizeMachineConfig({
      ...form,
      machineSecret: form.machineSecretInput.trim() || null,
      mqttSigningSecret: form.mqttSigningSecretInput.trim() || null,
      mqttPassword: form.mqttPasswordInput.trim() || null,
    });
    await machineStore.saveConfig(normalized);
    syncFormFromStore();
    await router.replace("/boot");
  } catch (error) {
    machineStore.error = error instanceof Error ? error.message : String(error);
  } finally {
    form.machineSecretInput = "";
    form.mqttSigningSecretInput = "";
    form.mqttPasswordInput = "";
  }
}

async function runHardwareCheck(): Promise<void> {
  hardwareMaintenance.loading = true;
  hardwareMaintenance.message = null;
  try {
    const result = await daemonClient.runHardwareSelfCheck();
    if (result.configUpdated) {
      await machineStore.loadConfig();
      if (runtimeFlags.advancedMaintenanceConfig) {
        syncFormFromStore();
      }
    }
    const details = [
      result.portPath ? `端口 ${result.portPath}` : null,
      result.resolutionSource ? `来源 ${result.resolutionSource}` : null,
      result.boundUsbIdentity
        ? `USB ${result.boundUsbIdentity.vendorId}:${result.boundUsbIdentity.productId}${
            result.boundUsbIdentity.serialNumber
              ? ` / ${result.boundUsbIdentity.serialNumber}`
              : ""
          }`
        : null,
      result.configUpdated ? "配置已绑定" : null,
      result.candidates.length > 1
        ? `候选 ${result.candidates.map((candidate) => candidate.portPath).join("、")}`
        : null,
    ].filter((item): item is string => Boolean(item));
    hardwareMaintenance.message = `${
      result.online ? "硬件就绪" : "硬件告警"
    }：${result.message}${details.length > 0 ? `（${details.join("；")}）` : ""}`;
  } catch (error) {
    hardwareMaintenance.message =
      error instanceof Error ? error.message : String(error);
  } finally {
    hardwareMaintenance.loading = false;
  }
}

async function refreshVisionStatus(): Promise<void> {
  visionMaintenance.loading = true;
  visionMaintenance.message = null;
  try {
    await visionStore.refresh();
    visionMaintenance.message = visionStore.online
      ? `视觉模块在线：${visionStore.message}`
      : `视觉模块不可用：${visionStore.message}`;
  } catch (error) {
    visionMaintenance.message =
      error instanceof Error ? error.message : String(error);
  } finally {
    visionMaintenance.loading = false;
  }
}

async function refreshDiagnostics(): Promise<void> {
  if (diagnosticsRefreshInFlight) {
    return diagnosticsRefreshInFlight;
  }
  diagnosticsRefreshInFlight = runDiagnosticsRefresh().finally(() => {
    diagnosticsRefreshInFlight = null;
  });
  return diagnosticsRefreshInFlight;
}

async function runDiagnosticsRefresh(): Promise<void> {
  diagnostics.loading = true;
  diagnostics.message = null;
  try {
    const [health, ready] = await Promise.all([
      daemonClient.getHealth(),
      daemonClient.getReady(),
    ]);
    machineStore.applyHealth(health);
    connectivityStore.applyHealth(health);
    connectivityStore.applyReady(ready);
    await Promise.allSettled([
      mqttStore.refresh(),
      scannerStore.refresh(),
      visionStore.refresh(),
      remoteOpsStore.refresh(),
    ]);
    await returnToCatalogAfterSystemRecovery();
  } catch (error) {
    diagnostics.message =
      error instanceof Error ? error.message : String(error);
  } finally {
    diagnostics.loading = false;
  }
}

function startDiagnosticsAutoRefresh(): void {
  stopDiagnosticsAutoRefresh();
  diagnosticsRefreshTimer = window.setInterval(() => {
    void refreshDiagnostics();
  }, MAINTENANCE_DIAGNOSTIC_REFRESH_MS);
}

function stopDiagnosticsAutoRefresh(): void {
  if (diagnosticsRefreshTimer !== null) {
    window.clearInterval(diagnosticsRefreshTimer);
    diagnosticsRefreshTimer = null;
  }
}

async function returnToCatalogAfterSystemRecovery(): Promise<void> {
  if (operatorEnteredMaintenance.value) {
    return;
  }
  if (connectivityStore.ready?.canSell === true) {
    await router.replace("/catalog");
  }
}

async function clearWholeMachineLock(): Promise<void> {
  wholeMachineLockMaintenance.loading = true;
  wholeMachineLockMaintenance.message = null;
  try {
    await daemonClient.clearWholeMachineMaintenanceLock();
    wholeMachineLockMaintenance.message = "整机维护锁已解除";
    await refreshDiagnostics();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    wholeMachineLockMaintenance.message = message.includes(
      "must be healthy before clearing whole-machine lock",
    )
      ? `下位机仍处于故障状态，不能解除整机锁。请先按现场复位键并确认下位机恢复在线，再点击解除。(${message})`
      : message;
  } finally {
    wholeMachineLockMaintenance.loading = false;
  }
}

async function returnToCatalog(): Promise<void> {
  if (returnToCatalogBlockedReason.value) {
    catalogNavigation.message = `暂不能回到目录：${returnToCatalogBlockedReason.value}`;
    return;
  }
  catalogNavigation.message = null;
  await router.replace("/catalog");
}

async function returnToDesktop(): Promise<void> {
  desktopMaintenance.loading = true;
  desktopMaintenance.message = "正在回到 Windows 桌面";
  try {
    if (!isTauriRuntime()) {
      desktopMaintenance.message = "当前不是 Tauri 运行环境，无法退出全屏应用";
      return;
    }
    await callTauriCommand<void>("return_to_desktop");
  } catch (error) {
    desktopMaintenance.message =
      error instanceof Error ? error.message : String(error);
    desktopMaintenance.loading = false;
  }
}

async function exportLogs(): Promise<void> {
  diagnostics.logsMessage = null;
  try {
    await remoteOpsStore.downloadExport();
    diagnostics.logsMessage = "日志已导出";
  } catch (error) {
    diagnostics.logsMessage =
      error instanceof Error ? error.message : String(error);
  }
}

async function refreshStockMaintenanceView(): Promise<void> {
  stockMaintenance.loading = true;
  try {
    const snapshot = await daemonClient.getSaleView();
    stockMaintenance.planogramVersion = snapshot.planogramVersion;
    stockMaintenance.source = snapshot.source;
    stockMaintenance.slots = snapshot.items.map((item) => ({
      slotId: item.slotId,
      slotCode: item.slotCode,
      productName: item.productName,
      physicalStock: item.physicalStock,
      capacity: item.capacity,
    }));
    stockForm.planogramVersion =
      snapshot.planogramVersion ?? stockForm.planogramVersion;
    if (!stockForm.slotId && stockMaintenance.slots[0]) {
      stockForm.slotId = stockMaintenance.slots[0].slotId;
    }
  } catch (error) {
    stockMaintenance.message =
      error instanceof Error ? error.message : String(error);
  } finally {
    stockMaintenance.loading = false;
  }
}

function nextMovementId(): string {
  const randomId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}`;
  return `LOCAL-${randomId}`;
}

async function submitStockMovement(): Promise<void> {
  stockMaintenance.loading = true;
  stockMaintenance.message = null;
  try {
    const snapshot = await daemonClient.recordStockMovement({
      movementId: nextMovementId(),
      planogramVersion: stockForm.planogramVersion.trim(),
      slotId: stockForm.slotId,
      movementType: stockForm.movementType,
      quantity: Number(stockForm.quantity),
      source: "local_maintenance",
      attributedTo: stockForm.attributedTo.trim() || "front-panel",
    });
    catalogStore.applySnapshot(snapshot);
    stockMaintenance.message = "库存动作已记录";
    await refreshStockMaintenanceView();
  } catch (error) {
    stockMaintenance.message =
      error instanceof Error ? error.message : String(error);
  } finally {
    stockMaintenance.loading = false;
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
      <h2 class="mt-3 text-3xl font-bold">生产维护</h2>

      <div class="mt-6 rounded-3xl border border-white/10 bg-slate-950/30 p-5">
        <p
          class="text-sm font-semibold tracking-[0.28em] text-emerald-200 uppercase"
        >
          Stock Maintenance
        </p>
        <form class="mt-4 grid gap-4" @submit.prevent="submitStockMovement">
          <div class="grid gap-4 md:grid-cols-2">
            <label class="grid gap-2 text-left">
              <span class="text-sm font-semibold text-slate-200">动作类型</span>
              <select
                v-model="stockForm.movementType"
                class="kiosk-touch-target rounded-2xl border border-white/10 bg-slate-950/70 px-4 text-white outline-none focus:border-emerald-300"
              >
                <option value="planned_refill">计划补货</option>
                <option value="stock_count_correction">盘点修正</option>
              </select>
            </label>
            <label class="grid gap-2 text-left">
              <span class="text-sm font-semibold text-slate-200">数量</span>
              <input
                v-model.number="stockForm.quantity"
                class="kiosk-touch-target rounded-2xl border border-white/10 bg-slate-950/70 px-4 text-white outline-none focus:border-emerald-300"
                min="0"
                step="1"
                type="number"
              />
            </label>
          </div>

          <label class="grid gap-2 text-left">
            <span class="text-sm font-semibold text-slate-200"
              >Planogram Version</span
            >
            <input
              v-model="stockForm.planogramVersion"
              class="kiosk-touch-target rounded-2xl border border-white/10 bg-slate-950/70 px-4 text-white outline-none focus:border-emerald-300"
            />
          </label>

          <label class="grid gap-2 text-left">
            <span class="text-sm font-semibold text-slate-200">货道</span>
            <select
              v-model="stockForm.slotId"
              class="kiosk-touch-target rounded-2xl border border-white/10 bg-slate-950/70 px-4 text-white outline-none focus:border-emerald-300"
            >
              <option
                v-for="slot in stockMaintenance.slots"
                :key="slot.slotId"
                :value="slot.slotId"
              >
                {{ slot.slotCode }} · {{ slot.productName }} ·
                {{ slot.physicalStock }}/{{ slot.capacity }}
              </option>
            </select>
          </label>

          <label class="grid gap-2 text-left">
            <span class="text-sm font-semibold text-slate-200"
              >Attribution</span
            >
            <input
              v-model="stockForm.attributedTo"
              class="kiosk-touch-target rounded-2xl border border-white/10 bg-slate-950/70 px-4 text-white outline-none focus:border-emerald-300"
            />
          </label>

          <div class="grid gap-3 md:grid-cols-2">
            <button
              class="kiosk-touch-target rounded-2xl border border-emerald-200/30 px-4 py-3 font-bold text-emerald-100 disabled:opacity-50"
              type="button"
              :disabled="stockMaintenance.loading"
              @click="refreshStockMaintenanceView"
            >
              刷新库存
            </button>
            <button
              class="kiosk-touch-target rounded-2xl bg-emerald-300 px-4 py-3 font-bold text-slate-950 disabled:opacity-50"
              type="submit"
              :disabled="
                stockMaintenance.loading ||
                !stockForm.planogramVersion ||
                !stockForm.slotId
              "
            >
              记录库存动作
            </button>
          </div>

          <p
            v-if="stockMaintenance.message"
            class="rounded-2xl bg-emerald-500/15 p-4 text-emerald-100"
          >
            {{ stockMaintenance.message }}
          </p>
        </form>
      </div>

      <div class="mt-6 rounded-3xl border border-white/10 bg-slate-950/30 p-5">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <p
            class="text-sm font-semibold tracking-[0.28em] text-sky-200 uppercase"
          >
            Diagnostics
          </p>
          <div class="flex flex-wrap gap-3">
            <button
              class="kiosk-touch-target rounded-2xl border border-emerald-200/30 px-4 py-3 font-bold text-emerald-100 disabled:opacity-50"
              type="button"
              :disabled="Boolean(returnToCatalogBlockedReason)"
              @click="returnToCatalog"
            >
              回到目录
            </button>
            <button
              class="kiosk-touch-target rounded-2xl border border-slate-200/30 px-4 py-3 font-bold text-slate-100 disabled:opacity-50"
              type="button"
              :disabled="desktopMaintenance.loading"
              @click="returnToDesktop"
            >
              回到 Windows 桌面
            </button>
            <button
              class="kiosk-touch-target rounded-2xl border border-sky-200/30 px-4 py-3 font-bold text-sky-100 disabled:opacity-50"
              type="button"
              :disabled="diagnostics.loading"
              @click="refreshDiagnostics"
            >
              刷新诊断
            </button>
            <button
              class="kiosk-touch-target rounded-2xl border border-sky-200/30 px-4 py-3 font-bold text-sky-100"
              type="button"
              @click="exportLogs"
            >
              导出日志
            </button>
            <button
              class="kiosk-touch-target rounded-2xl border border-sky-200/30 px-4 py-3 font-bold text-sky-100 disabled:opacity-50"
              type="button"
              :disabled="hardwareMaintenance.loading"
              @click="runHardwareCheck"
            >
              硬件自检
            </button>
            <button
              class="kiosk-touch-target rounded-2xl border border-sky-200/30 px-4 py-3 font-bold text-sky-100 disabled:opacity-50"
              type="button"
              :disabled="visionMaintenance.loading"
              @click="refreshVisionStatus"
            >
              视觉状态
            </button>
          </div>
        </div>

        <p
          v-if="returnToCatalogBlockedReason || catalogNavigation.message"
          class="mt-4 rounded-2xl bg-amber-500/15 p-4 text-amber-100"
          aria-live="polite"
        >
          {{
            catalogNavigation.message ??
            `暂不能回到目录：${returnToCatalogBlockedReason}`
          }}
        </p>

        <div
          v-if="
            wholeMachineMaintenanceLock || wholeMachineLockMaintenance.message
          "
          class="mt-4 rounded-2xl border border-rose-300/30 bg-rose-500/15 p-4"
        >
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div class="text-left">
              <p class="text-sm font-semibold text-rose-100">整机维护锁</p>
              <p class="mt-1 text-sm text-rose-50/90">
                {{
                  wholeMachineMaintenanceLock?.message ??
                  wholeMachineLockMaintenance.message
                }}
              </p>
              <p
                v-if="wholeMachineLockMaintenance.message"
                class="mt-2 text-sm font-semibold text-rose-50"
                aria-live="polite"
              >
                {{ wholeMachineLockMaintenance.message }}
              </p>
            </div>
            <button
              class="kiosk-touch-target rounded-2xl border border-rose-100/40 px-4 py-3 font-bold text-rose-50 disabled:opacity-50"
              type="button"
              :disabled="
                wholeMachineLockMaintenance.loading ||
                !wholeMachineMaintenanceLock
              "
              @click="clearWholeMachineLock"
            >
              确认解除整机锁
            </button>
          </div>
        </div>

        <dl class="mt-4 grid gap-3 md:grid-cols-2">
          <div class="rounded-2xl bg-slate-950/45 p-4">
            <dt class="text-sm text-slate-400">后端</dt>
            <dd class="mt-1 font-bold text-white">
              {{ machineStore.health?.backendOnline ? "在线" : "不可用" }}
              · {{ machineStore.health?.status ?? "unknown" }}
            </dd>
          </div>
          <div class="rounded-2xl bg-slate-950/45 p-4">
            <dt class="text-sm text-slate-400">Readiness</dt>
            <dd class="mt-1 font-bold text-white">
              {{ connectivityStore.ready?.ready ? "就绪" : "未就绪" }}
              · {{ connectivityStore.ready?.mode ?? "unknown" }}
            </dd>
          </div>
          <div class="rounded-2xl bg-slate-950/45 p-4">
            <dt class="text-sm text-slate-400">MQTT</dt>
            <dd class="mt-1 font-bold text-white">
              {{ mqttStore.status }} · outbox {{ mqttStore.outboxSize }}
            </dd>
          </div>
          <div class="rounded-2xl bg-slate-950/45 p-4">
            <dt class="text-sm text-slate-400">下位机</dt>
            <dd class="mt-1 font-bold text-white">
              {{ machineStore.health?.hardwareOnline ? "在线" : "不可用" }}
            </dd>
          </div>
          <div class="rounded-2xl bg-slate-950/45 p-4">
            <dt class="text-sm text-slate-400">扫码器</dt>
            <dd class="mt-1 font-bold text-white">
              {{ scannerStore.online ? "在线" : "不可用" }} ·
              {{ scannerStore.message }}
            </dd>
          </div>
          <div class="rounded-2xl bg-slate-950/45 p-4">
            <dt class="text-sm text-slate-400">视觉</dt>
            <dd class="mt-1 font-bold text-white">
              {{ visionStore.online ? "在线" : "不可用" }} ·
              {{ visionStore.message }}
            </dd>
          </div>
          <div class="rounded-2xl bg-slate-950/45 p-4">
            <dt class="text-sm text-slate-400">本地状态</dt>
            <dd class="mt-1 font-bold text-white">
              {{ stockMaintenance.source ?? "unknown" }} ·
              {{ stockMaintenance.planogramVersion ?? "no planogram" }}
            </dd>
          </div>
          <div class="rounded-2xl bg-slate-950/45 p-4">
            <dt class="text-sm text-slate-400">Remote Ops</dt>
            <dd class="mt-1 font-bold text-white">
              pending {{ remoteOpsStore.pending }} ·
              {{ remoteOpsStore.lastError ?? "ok" }}
            </dd>
          </div>
        </dl>

        <p
          v-if="diagnostics.message"
          class="mt-4 rounded-2xl bg-rose-500/20 p-4 text-rose-100"
        >
          {{ diagnostics.message }}
        </p>
        <p
          v-if="diagnostics.logsMessage"
          class="mt-4 rounded-2xl bg-sky-500/15 p-4 text-sky-100"
        >
          {{ diagnostics.logsMessage }}
        </p>
        <p
          v-if="desktopMaintenance.message"
          class="mt-4 rounded-2xl bg-slate-500/15 p-4 text-slate-100"
        >
          {{ desktopMaintenance.message }}
        </p>
        <p
          v-if="hardwareMaintenance.message"
          class="mt-4 rounded-2xl bg-sky-500/15 p-4 text-sky-100"
        >
          {{ hardwareMaintenance.message }}
        </p>
        <p
          v-if="visionMaintenance.message"
          class="mt-4 rounded-2xl bg-fuchsia-500/15 p-4 text-fuchsia-100"
        >
          {{ visionMaintenance.message }}
        </p>
      </div>

      <div
        v-if="mqttStore.outboxWarning"
        class="mt-6 rounded-2xl border border-amber-300/30 bg-amber-500/20 p-4 text-amber-100"
      >
        {{ mqttStore.outboxWarning }}
      </div>

      <form
        v-if="showAdvancedDebugConfig"
        class="mt-8 grid gap-5"
        @submit.prevent="saveAndReboot"
      >
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

        <div v-if="form.hardwareAdapter === 'serial'" class="grid gap-4">
          <label class="grid gap-2 text-left">
            <span class="text-sm font-semibold text-slate-200"
              >手动串口兜底 serialPortPath</span
            >
            <input
              v-model="form.serialPortPath"
              class="kiosk-touch-target rounded-2xl border border-white/10 bg-slate-950/70 px-4 text-white outline-none focus:border-sky-300"
              placeholder="Linux 如 /dev/ttyUSB0；Windows 如 COM3"
            />
          </label>

          <div
            v-if="form.lowerControllerUsbIdentity"
            class="grid gap-4 md:grid-cols-3"
          >
            <label class="grid gap-2 text-left">
              <span class="text-sm font-semibold text-slate-200">USB VID</span>
              <input
                v-model="form.lowerControllerUsbIdentity.vendorId"
                class="kiosk-touch-target rounded-2xl border border-white/10 bg-slate-950/70 px-4 text-white outline-none focus:border-sky-300"
                maxlength="4"
              />
            </label>
            <label class="grid gap-2 text-left">
              <span class="text-sm font-semibold text-slate-200">USB PID</span>
              <input
                v-model="form.lowerControllerUsbIdentity.productId"
                class="kiosk-touch-target rounded-2xl border border-white/10 bg-slate-950/70 px-4 text-white outline-none focus:border-sky-300"
                maxlength="4"
              />
            </label>
            <label class="grid gap-2 text-left">
              <span class="text-sm font-semibold text-slate-200"
                >绑定序列号</span
              >
              <input
                v-model="form.lowerControllerUsbIdentity.serialNumber"
                class="kiosk-touch-target rounded-2xl border border-white/10 bg-slate-950/70 px-4 text-white outline-none focus:border-sky-300"
                placeholder="自检后自动绑定"
              />
            </label>
          </div>
        </div>

        <div class="rounded-3xl border border-white/10 bg-slate-950/30 p-5">
          <p
            class="text-sm font-semibold tracking-[0.28em] text-emerald-200 uppercase"
          >
            Scanner Adapter
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

            <div class="grid gap-3 md:grid-cols-2">
              <button
                class="kiosk-touch-target rounded-2xl border border-fuchsia-200/30 px-4 py-3 font-bold text-fuchsia-100 disabled:opacity-50"
                type="button"
                :disabled="hardwareMaintenance.loading"
                @click="runHardwareCheck"
              >
                硬件自检
              </button>
              <button
                class="kiosk-touch-target rounded-2xl border border-fuchsia-200/30 px-4 py-3 font-bold text-fuchsia-100 disabled:opacity-50"
                type="button"
                :disabled="visionMaintenance.loading"
                @click="refreshVisionStatus"
              >
                视觉状态
              </button>
            </div>

            <p
              v-if="hardwareMaintenance.message"
              class="rounded-2xl bg-sky-500/15 p-4 text-sky-100"
            >
              {{ hardwareMaintenance.message }}
            </p>
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
      <div
        v-if="showAdvancedDebugConfig && form.hardwareAdapter === 'mock'"
        class="mt-6"
      >
        <MockHardwareControls />
      </div>
    </section>
  </KioskLayout>
</template>
