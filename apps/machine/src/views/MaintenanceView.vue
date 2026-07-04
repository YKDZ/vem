<script setup lang="ts">
import { formatMachineSlotCoordinate } from "@vem/shared";
import { computed, onMounted, onUnmounted, reactive } from "vue";
import { useRoute, useRouter } from "vue-router";

import { maintenanceTestToneUrl } from "@/assets/audio/maintenance-test-tone";
import listSloganImage from "@/assets/home/list-slogan.png";
import logoImage from "@/assets/home/logo.png";
import mascotTopImage from "@/assets/home/mascot-top-cutout.png";
import {
  createMachineAudioPlayback,
  createMockMachineAudioPlaybackDriver,
  type MachineAudioPlayback,
  type MachineAudioPlaybackDiagnostic,
} from "@/audio-playback/machine-audio-playback";
import MockHardwareControls from "@/components/MockHardwareControls.vue";
import { useMaintenanceEntry } from "@/composables/useMaintenanceEntry";
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
import {
  openVisionTryOnSession,
  type VisionTryOnSession,
} from "@/native/vision";
import { useAudioCueStore } from "@/stores/audio-cues";
import { useCatalogStore } from "@/stores/catalog";
import { useConnectivityStore } from "@/stores/connectivity";
import { useMachineStore } from "@/stores/machine";
import { useMqttStore } from "@/stores/mqtt";
import { useNaturalContextStore } from "@/stores/natural-context";
import { useRemoteOpsStore } from "@/stores/remote-ops";
import { useScannerStore } from "@/stores/scanner";
import { useVisionStore } from "@/stores/vision";

const router = useRouter();
const route = useRoute();
const catalogStore = useCatalogStore();
const audioCueStore = useAudioCueStore();
const connectivityStore = useConnectivityStore();
const machineStore = useMachineStore();
const mqttStore = useMqttStore();
const naturalContextStore = useNaturalContextStore();
const remoteOpsStore = useRemoteOpsStore();
const scannerStore = useScannerStore();
const visionStore = useVisionStore();
const { handleMaintenanceTap } = useMaintenanceEntry();
const MAINTENANCE_DIAGNOSTIC_REFRESH_MS = 5000;
const DIAGNOSTIC_DISPLAY_MAX_CHARS = 12_000;
const DIAGNOSTIC_DISPLAY_MAX_DEPTH = 8;
const DIAGNOSTIC_DISPLAY_MAX_OBJECT_ENTRIES = 80;
const DIAGNOSTIC_DISPLAY_MAX_ARRAY_ITEMS = 40;
const DIAGNOSTIC_DISPLAY_MAX_STRING_CHARS = 1000;
let diagnosticsRefreshTimer: number | null = null;
let diagnosticsRefreshInFlight: Promise<void> | null = null;
const runtimeFlags = reactive({
  advancedMaintenanceConfig: false,
});
const showAdvancedDebugConfig = computed(
  () => runtimeFlags.advancedMaintenanceConfig,
);
const showProtectedDesktopExit = computed(
  () => runtimeFlags.advancedMaintenanceConfig,
);
const wholeMachineMaintenanceLock = computed(
  () =>
    connectivityStore.ready?.blockingReasons.find(
      (reason) => reason.code === "WHOLE_MACHINE_HARDWARE_FAULT",
    ) ?? null,
);
const saleCriticalBlockers = computed(() =>
  (connectivityStore.ready?.blockingReasons ?? []).map((reason) => ({
    ...reason,
    operatorLabel: saleCriticalBlockerLabel(reason.code),
    operatorAction: saleCriticalBlockerAction(reason.code),
  })),
);
const latestVisionDiagnosticPayloadText = computed(() => {
  if (visionStore.latestDiagnosticPayload === null) {
    return "尚未返回诊断载荷。";
  }
  return serializeDiagnosticPayload(visionStore.latestDiagnosticPayload);
});
const audioCueSettingsRows = computed(() => [
  {
    label: "全局音频提示",
    value: machineStore.config.audioCueSettings.enabled ? "已启用" : "已停用",
  },
  {
    label: "来人音频提示",
    value: machineStore.config.audioCueSettings.categories.presence
      ? "已启用"
      : "已停用",
  },
  {
    label: "交易音频提示",
    value: machineStore.config.audioCueSettings.categories.transaction
      ? "已启用"
      : "已停用",
  },
  {
    label: "机器音频音量",
    value: `${machineAudioVolumePercent(machineStore.config.machineAudioVolume)}%`,
  },
]);
const latestAudioCueDiagnosticRows = computed(() => {
  const diagnostic = audioCueStore.latestPlaybackDiagnostic;
  if (!diagnostic) return [];
  return [
    {
      label: "请求的提示含义",
      value: audioCueMeaningLabel(diagnostic.cueKey),
    },
    {
      label: "分类",
      value: audioCueCategoryLabel(diagnostic.category),
    },
    {
      label: "播放结果",
      value: audioCueOutcomeLabel(diagnostic.outcome),
    },
    {
      label: "抑制或丢弃原因",
      value: diagnostic.message ?? "无",
    },
    {
      label: "记录时间",
      value: diagnostic.recordedAt,
    },
    {
      label: "重复抑制订单键（仅调试）",
      value: diagnostic.orderKey ?? "无",
    },
  ];
});
const naturalContextDiagnosticMessage = computed(() =>
  naturalContextStore.snapshot?.degraded || naturalContextStore.error
    ? naturalContextStore.operatorMessage
    : null,
);
const clearWholeMachineLockDisabled = computed(
  () =>
    wholeMachineLockMaintenance.loading ||
    !wholeMachineMaintenanceLock.value ||
    !wholeMachineLockMaintenance.selfCheckEvidence?.online ||
    wholeMachineLockMaintenance.operatorNote.trim().length === 0,
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
  machineLocationLabel: machineConfigDefaults.machineLocationLabel,
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
  machineAudioVolumePercent: machineAudioVolumePercent(
    machineConfigDefaults.machineAudioVolume,
  ),
  audioCueSettings: {
    enabled: machineConfigDefaults.audioCueSettings.enabled,
    categories: {
      presence: machineConfigDefaults.audioCueSettings.categories.presence,
      transaction:
        machineConfigDefaults.audioCueSettings.categories.transaction,
    },
  },
  kioskMode: machineConfigDefaults.kioskMode,
  machineSecretInput: "",
  mqttSigningSecretInput: "",
  mqttPasswordInput: "",
});

const tryOnPreviewDiagnostic = reactive({
  loading: false,
  message: null as string | null,
  previewUrl: null as string | null,
  sessionId: null as string | null,
  streamType: null as string | null,
});
let tryOnPreviewDiagnosticSession: VisionTryOnSession | null = null;
let maintenanceViewMounted = false;
let tryOnPreviewDiagnosticSequence = 0;

function syncFormFromStore(): void {
  form.machineCode = machineStore.config.machineCode;
  form.machineLocationLabel = machineStore.config.machineLocationLabel;
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
  form.machineAudioVolumePercent = machineAudioVolumePercent(
    machineStore.config.machineAudioVolume,
  );
  form.audioCueSettings = {
    enabled: machineStore.config.audioCueSettings.enabled,
    categories: {
      presence: machineStore.config.audioCueSettings.categories.presence,
      transaction: machineStore.config.audioCueSettings.categories.transaction,
    },
  };
  form.kioskMode = machineStore.config.kioskMode;
}

type DiagnosticSerializationState = {
  remainingChars: number;
  truncated: boolean;
  seen: WeakSet<object>;
};

function serializeDiagnosticPayload(value: unknown): string {
  const state: DiagnosticSerializationState = {
    remainingChars: DIAGNOSTIC_DISPLAY_MAX_CHARS,
    truncated: false,
    seen: new WeakSet<object>(),
  };
  const bounded = boundDiagnosticValue(value, state, 0);
  let text: string;
  try {
    text = JSON.stringify(bounded, null, 2);
  } catch (error) {
    text = `无法序列化诊断载荷：${
      error instanceof Error ? error.message : String(error)
    }`;
  }
  if (text.length > DIAGNOSTIC_DISPLAY_MAX_CHARS) {
    state.truncated = true;
    text = `${text.slice(0, DIAGNOSTIC_DISPLAY_MAX_CHARS)}\n... 已截断`;
  }
  if (state.truncated && !text.includes("已截断")) {
    text = `${text}\n... 已截断`;
  }
  return text;
}

function boundDiagnosticValue(
  value: unknown,
  state: DiagnosticSerializationState,
  depth: number,
): unknown {
  if (state.remainingChars <= 0) {
    state.truncated = true;
    return "[已截断]";
  }
  if (typeof value === "string") {
    return boundDiagnosticString(value, state);
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    state.remainingChars -= String(value).length;
    return value;
  }
  if (typeof value === "bigint") {
    const serialized = `${value.toString()}n`;
    state.remainingChars -= serialized.length;
    return serialized;
  }
  if (typeof value !== "object") {
    const serialized = String(value);
    state.remainingChars -= serialized.length;
    return serialized;
  }
  if (state.seen.has(value)) {
    state.truncated = true;
    return "[循环引用]";
  }
  if (depth >= DIAGNOSTIC_DISPLAY_MAX_DEPTH) {
    state.truncated = true;
    return "[已达到最大层级]";
  }
  state.seen.add(value);
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    for (
      let index = 0;
      index < value.length &&
      index < DIAGNOSTIC_DISPLAY_MAX_ARRAY_ITEMS &&
      state.remainingChars > 0;
      index += 1
    ) {
      output.push(boundDiagnosticValue(value[index], state, depth + 1));
    }
    if (output.length < value.length) {
      state.truncated = true;
      output.push(`[... 已截断 ${value.length - output.length} 项]`);
    }
    return output;
  }

  const output: Record<string, unknown> = {};
  let included = 0;
  let omitted = 0;
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    if (
      included >= DIAGNOSTIC_DISPLAY_MAX_OBJECT_ENTRIES ||
      state.remainingChars <= 0
    ) {
      omitted += 1;
      continue;
    }
    state.remainingChars -= key.length;
    output[key] = boundDiagnosticValue(
      (value as Record<string, unknown>)[key],
      state,
      depth + 1,
    );
    included += 1;
  }
  if (omitted > 0) {
    state.truncated = true;
    output.__truncated = `已省略 ${omitted} 个字段`;
  }
  return output;
}

function boundDiagnosticString(
  value: string,
  state: DiagnosticSerializationState,
): string {
  const maxLength = Math.min(
    value.length,
    DIAGNOSTIC_DISPLAY_MAX_STRING_CHARS,
    Math.max(state.remainingChars, 0),
  );
  state.remainingChars -= maxLength;
  if (maxLength < value.length) {
    state.truncated = true;
    return `${value.slice(0, maxLength)}... 已截断`;
  }
  return value;
}

onMounted(async () => {
  maintenanceViewMounted = true;
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
      ensureMachineAudioTestPlayback();
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
  maintenanceViewMounted = false;
  stopDiagnosticsAutoRefresh();
  activeMachineAudioPlayback?.stop();
  void stopTryOnPreviewDiagnostic();
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
  operatorNote: "",
  selfCheckEvidence: null as null | {
    online: boolean;
    message: string;
    portPath?: string | null;
    checkedAt: string;
  },
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
    layerNo: number;
    cellNo: number;
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

const machineAudioTestPlayback = reactive({
  loading: false,
  message: null as string | null,
  driver: "unknown",
  diagnostic: null as MachineAudioPlaybackDiagnostic | null,
  volume: machineStore.config.machineAudioVolume,
});
let activeMachineAudioPlayback: MachineAudioPlayback | null = null;
let activeMachineAudioPlaybackVolume: number | null = null;

const latestMachineAudioTestPlaybackRows = computed(() => {
  const diagnostic = machineAudioTestPlayback.diagnostic;
  if (!diagnostic) {
    return [
      {
        label: "播放状态",
        value: "尚未记录测试播放诊断",
      },
    ];
  }
  return [
    {
      label: "播放状态",
      value: machineAudioPlaybackStatusLabel(diagnostic.status),
    },
    {
      label: "播放驱动",
      value: diagnostic.driver,
    },
    {
      label: "播放音量",
      value: `${machineAudioVolumePercent(machineAudioTestPlayback.volume)}%`,
    },
    {
      label: "降级诊断",
      value: diagnostic.message ?? "无",
    },
    {
      label: "记录时间",
      value: diagnostic.recordedAt,
    },
  ];
});

async function playMachineAudioTestPlayback(): Promise<void> {
  machineAudioTestPlayback.loading = true;
  machineAudioTestPlayback.message = null;
  try {
    const playback = ensureMachineAudioTestPlayback();
    const playbackRequest = playback.playLocal(maintenanceTestToneUrl);
    refreshMachineAudioTestPlaybackDiagnostic();
    const started = await playbackRequest;
    refreshMachineAudioTestPlaybackDiagnostic();
    machineAudioTestPlayback.message = started
      ? "机器音频测试播放已启动。"
      : "机器音频测试播放未启动。";
  } catch (error) {
    machineAudioTestPlayback.message =
      error instanceof Error ? error.message : String(error);
  } finally {
    machineAudioTestPlayback.loading = false;
  }
}

function stopMachineAudioTestPlayback(): void {
  activeMachineAudioPlayback?.stop();
  refreshMachineAudioTestPlaybackDiagnostic();
}

function ensureMachineAudioTestPlayback(): MachineAudioPlayback {
  const volume = machineStore.config.machineAudioVolume;
  if (
    activeMachineAudioPlayback &&
    activeMachineAudioPlaybackVolume === volume
  ) {
    return activeMachineAudioPlayback;
  }
  activeMachineAudioPlayback?.stop();
  activeMachineAudioPlaybackVolume = volume;
  machineAudioTestPlayback.volume = volume;
  activeMachineAudioPlayback = createMachineAudioPlayback({
    driver:
      import.meta.env.MODE === "test"
        ? createMockMachineAudioPlaybackDriver({
            startDelayMs: 10,
            completeAfterMs: 10,
          })
        : undefined,
    onDiagnostic: (diagnostic) => {
      machineAudioTestPlayback.driver = diagnostic.driver;
      machineAudioTestPlayback.diagnostic = diagnostic;
    },
    volume,
  });
  machineAudioTestPlayback.driver = activeMachineAudioPlayback.currentDriver();
  machineAudioTestPlayback.diagnostic =
    activeMachineAudioPlayback.latestDiagnostic();
  return activeMachineAudioPlayback;
}

function refreshMachineAudioTestPlaybackDiagnostic(): void {
  if (!activeMachineAudioPlayback) return;
  machineAudioTestPlayback.driver = activeMachineAudioPlayback.currentDriver();
  machineAudioTestPlayback.diagnostic =
    activeMachineAudioPlayback.latestDiagnostic();
}

async function startTryOnPreviewDiagnostic(): Promise<void> {
  await stopTryOnPreviewDiagnostic();
  const sequence = (tryOnPreviewDiagnosticSequence += 1);
  tryOnPreviewDiagnostic.loading = true;
  tryOnPreviewDiagnostic.message = null;
  try {
    const session = await openVisionTryOnSession(machineStore.config, {
      catalogKey: "maintenance-diagnostic",
      variantId: "maintenance-diagnostic",
    });
    if (
      !maintenanceViewMounted ||
      sequence !== tryOnPreviewDiagnosticSequence
    ) {
      await session.stop();
      return;
    }
    tryOnPreviewDiagnosticSession = session;
    tryOnPreviewDiagnostic.previewUrl = session.previewUrl;
    tryOnPreviewDiagnostic.sessionId = session.sessionId;
    tryOnPreviewDiagnostic.streamType = session.streamType;
    tryOnPreviewDiagnostic.message = "试衣预览诊断已启动。";
  } catch (error) {
    if (maintenanceViewMounted && sequence === tryOnPreviewDiagnosticSequence) {
      tryOnPreviewDiagnostic.message =
        error instanceof Error ? error.message : String(error);
    }
  } finally {
    if (sequence === tryOnPreviewDiagnosticSequence) {
      tryOnPreviewDiagnostic.loading = false;
    }
  }
}

async function stopTryOnPreviewDiagnostic(): Promise<void> {
  tryOnPreviewDiagnosticSequence += 1;
  const session = tryOnPreviewDiagnosticSession;
  tryOnPreviewDiagnosticSession = null;
  tryOnPreviewDiagnostic.loading = false;
  tryOnPreviewDiagnostic.previewUrl = null;
  tryOnPreviewDiagnostic.sessionId = null;
  tryOnPreviewDiagnostic.streamType = null;
  if (!session) {
    return;
  }
  try {
    await session.stop();
    if (maintenanceViewMounted) {
      tryOnPreviewDiagnostic.message = "试衣预览诊断已释放。";
    }
  } catch (error) {
    if (maintenanceViewMounted) {
      tryOnPreviewDiagnostic.message =
        error instanceof Error ? error.message : String(error);
    }
  }
}

async function saveAndReboot(): Promise<void> {
  if (!runtimeFlags.advancedMaintenanceConfig) {
    return;
  }
  try {
    const normalized = normalizeMachineConfig({
      ...form,
      machineAudioVolume: form.machineAudioVolumePercent / 100,
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
    wholeMachineLockMaintenance.selfCheckEvidence = {
      online: result.online,
      message: result.message,
      portPath: result.portPath,
      checkedAt: new Date().toISOString(),
    };
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

function machineAudioVolumePercent(volume: number): number {
  return Math.round(Math.min(1, Math.max(0, volume)) * 100);
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
      naturalContextStore.refresh(),
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
    await daemonClient.clearWholeMachineMaintenanceLock(
      wholeMachineLockMaintenance.operatorNote,
    );
    wholeMachineLockMaintenance.message = "整机维护锁已解除";
    wholeMachineLockMaintenance.operatorNote = "";
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

function saleCriticalBlockerLabel(code: string): string {
  const labels: Record<string, string> = {
    LOWER_CONTROLLER_UNAVAILABLE: "下位机未在线",
    WHOLE_MACHINE_HARDWARE_FAULT: "整机维护锁",
    PRODUCTION_DISPENSE_PATH_EVIDENCE_MISSING: "生产出货路径证据缺失",
    PRODUCTION_DISPENSE_PATH_MOCK: "当前不是生产出货路径",
    SYNC_UNHEALTHY: "平台同步异常",
    ACTIVE_PLANOGRAM_MISSING: "未加载有效货道图",
    NO_PAYMENT_OPTIONS: "没有可用支付方式",
    MACHINE_AUTH_MISSING: "机器身份未配置",
    PLATFORM_UNREACHABLE: "后端不可达",
    NO_SALEABLE_SLOTS: "没有可售货道",
  };
  return labels[code] ?? code;
}

function saleCriticalBlockerAction(code: string): string {
  const actions: Record<string, string> = {
    LOWER_CONTROLLER_UNAVAILABLE:
      "检查下位机供电、串口线和 COM 口后运行硬件自检。",
    WHOLE_MACHINE_HARDWARE_FAULT:
      "处理卡货或机械故障，运行下位机自检，通过后填写处理记录解除整机锁。",
    PRODUCTION_DISPENSE_PATH_EVIDENCE_MISSING:
      "核对生产硬件配置和验收资料，确认真实下位机路径。",
    PRODUCTION_DISPENSE_PATH_MOCK: "切换到生产下位机适配器后再恢复销售。",
    SYNC_UNHEALTHY: "检查网络、MQTT 和本地队列积压。",
    ACTIVE_PLANOGRAM_MISSING: "等待后台下发并应用有效货道图。",
    NO_PAYMENT_OPTIONS: "检查支付配置和扫码器能力。",
    MACHINE_AUTH_MISSING: "重新完成机器认领或凭证配置。",
    PLATFORM_UNREACHABLE: "检查网络和后端 API 连通性。",
    NO_SALEABLE_SLOTS: "补货、盘点或处理货道冻结后恢复可售库存。",
  };
  return actions[code] ?? "按现场 SOP 排查该阻塞项。";
}

function audioCueMeaningLabel(cueKey: string): string {
  const labels: Record<string, string> = {
    "presence.detected": "检测到顾客靠近",
    "payment.succeeded": "支付成功",
    "dispensing.started": "开始出货",
    "dispense.succeeded": "出货成功",
    "dispense.failed": "出货失败",
    "refund.pending": "退款处理中",
    "refund.completed": "退款完成",
    "manual_handling.required": "需要人工处理",
  };
  return labels[cueKey] ?? cueKey;
}

function audioCueCategoryLabel(category: string): string {
  const labels: Record<string, string> = {
    presence: "来人音频提示",
    transaction: "交易音频提示",
  };
  return labels[category] ?? category;
}

function audioCueOutcomeLabel(outcome: string): string {
  const labels: Record<string, string> = {
    played: "已播放",
    completed: "已完成",
    failed: "本地音频播放失败",
    skipped: "已跳过",
  };
  return labels[outcome] ?? outcome;
}

function machineAudioPlaybackStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    requested: "已请求",
    started: "已开始",
    completed: "已完成",
    failed: "失败",
    stopped: "已停止",
  };
  return labels[status] ?? status;
}

function naturalContextDisplayStatus(): string {
  const snapshot = naturalContextStore.snapshot;
  if (!snapshot) return "未知";
  return `${snapshot.degraded ? "降级" : "就绪"} · ${runtimeStatusLabel(snapshot.status)}`;
}

function runtimeStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    ok: "正常",
    ready: "就绪",
    healthy: "健康",
    degraded: "降级",
    unhealthy: "异常",
    unconfigured: "未配置",
    unavailable: "不可用",
    connected: "已连接",
    disconnected: "未连接",
    unknown: "未知",
    catalog: "目录",
    maintenance: "维护",
    local_stock: "本地库存",
    none: "无",
  };
  return labels[status] ?? status;
}

function adapterLabel(adapter: string): string {
  const labels: Record<string, string> = {
    mock: "模拟适配器",
    serial: "串口适配器",
    disabled: "停用",
    serial_text: "串口文本",
  };
  return labels[adapter] ?? adapter;
}

function frameSuffixLabel(frameSuffix: string): string {
  const labels: Record<string, string> = {
    crlf: "回车换行",
    lf: "换行",
    cr: "回车",
    none: "无结尾符",
  };
  return labels[frameSuffix] ?? frameSuffix;
}

function operatorMessageLabel(message: string): string {
  const labels: Record<string, string> = {
    "daemon ready": "本地服务就绪",
    "backend reachable": "后端可达",
    "scanner ready": "扫码器就绪",
    "vision ready": "视觉模块就绪",
    "lower controller unavailable": "下位机不可用",
    "Machine Geo Location is not configured": "机器地理位置未配置",
    ok: "正常",
  };
  return labels[message] ?? message;
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
  if (!showProtectedDesktopExit.value) {
    return;
  }
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
      layerNo: item.layerNo,
      cellNo: item.cellNo,
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
    <section class="maintenance-page">
      <header class="maintenance-header">
        <div class="maintenance-brand" @click="handleMaintenanceTap">
          <img :src="logoImage" alt="唐诗村" />
          <img :src="mascotTopImage" alt="" aria-hidden="true" />
        </div>
        <div class="maintenance-title-block">
          <p>维护</p>
          <h2>生产维护</h2>
        </div>
      </header>

      <div class="mt-6 rounded-3xl border border-white/10 bg-slate-950/30 p-5">
        <p
          class="text-sm font-semibold tracking-[0.28em] text-emerald-200 uppercase"
        >
          库存维护
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
            <span class="text-sm font-semibold text-slate-200">货道图版本</span>
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
                {{ formatMachineSlotCoordinate(slot) }} ·
                {{ slot.productName }} · {{ slot.physicalStock }}/{{
                  slot.capacity
                }}
              </option>
            </select>
          </label>

          <label class="grid gap-2 text-left">
            <span class="text-sm font-semibold text-slate-200">记录人</span>
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
            维护控制台
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
              v-if="showProtectedDesktopExit"
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
          <div class="grid gap-4">
            <div class="text-left">
              <p class="text-sm font-semibold text-rose-100">整机维护锁</p>
              <p class="mt-1 text-sm text-rose-50/90">
                {{
                  operatorMessageLabel(
                    wholeMachineMaintenanceLock?.message ?? "",
                  ) || wholeMachineLockMaintenance.message
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
            <div
              v-if="saleCriticalBlockers.length > 0"
              class="grid gap-2 text-left"
            >
              <div
                v-for="blocker in saleCriticalBlockers"
                :key="`${blocker.component}-${blocker.code}`"
                class="rounded-xl bg-slate-950/35 p-3 text-sm text-rose-50/90"
              >
                <div class="font-semibold text-rose-50">
                  {{ blocker.operatorLabel }} · {{ blocker.code }}
                </div>
                <div class="mt-1">
                  {{ operatorMessageLabel(blocker.message) }}
                </div>
                <div class="mt-1 text-rose-100/80">
                  {{ blocker.operatorAction }}
                </div>
              </div>
            </div>
            <div
              v-if="wholeMachineLockMaintenance.selfCheckEvidence"
              class="rounded-xl bg-slate-950/35 p-3 text-left text-sm text-rose-50/90"
            >
              下位机自检：{{
                wholeMachineLockMaintenance.selfCheckEvidence.online
                  ? "通过"
                  : "未通过"
              }}
              ·
              {{
                operatorMessageLabel(
                  wholeMachineLockMaintenance.selfCheckEvidence.message,
                )
              }}
              <span
                v-if="wholeMachineLockMaintenance.selfCheckEvidence.portPath"
              >
                · {{ wholeMachineLockMaintenance.selfCheckEvidence.portPath }}
              </span>
            </div>
            <label
              class="grid gap-2 text-left text-sm font-semibold text-rose-50"
            >
              处理记录
              <textarea
                v-model="wholeMachineLockMaintenance.operatorNote"
                class="min-h-24 rounded-xl border border-rose-100/30 bg-slate-950/45 p-3 font-normal text-white outline-none"
                placeholder="填写现场处理、复位和自检结果"
              />
            </label>
            <button
              class="kiosk-touch-target rounded-2xl border border-rose-100/40 px-4 py-3 font-bold text-rose-50 disabled:opacity-50"
              type="button"
              :disabled="clearWholeMachineLockDisabled"
              @click="clearWholeMachineLock"
            >
              确认解除整机锁
            </button>
          </div>
        </div>

        <dl class="mt-4 grid gap-3 md:grid-cols-2">
          <div class="border-t border-white/10 py-3">
            <dt class="text-sm text-slate-400">本地服务</dt>
            <dd class="mt-1 font-bold text-white">
              {{ runtimeStatusLabel(machineStore.health?.status ?? "unknown") }}
              ·
              {{
                machineStore.health?.process.message
                  ? operatorMessageLabel(machineStore.health.process.message)
                  : "未连接"
              }}
            </dd>
          </div>
          <div class="border-t border-white/10 py-3">
            <dt class="text-sm text-slate-400">后端</dt>
            <dd class="mt-1 font-bold text-white">
              {{ machineStore.health?.backendOnline ? "在线" : "不可用" }}
              ·
              {{ runtimeStatusLabel(machineStore.health?.status ?? "unknown") }}
            </dd>
          </div>
          <div class="border-t border-white/10 py-3">
            <dt class="text-sm text-slate-400">销售就绪</dt>
            <dd class="mt-1 font-bold text-white">
              {{ connectivityStore.ready?.ready ? "就绪" : "未就绪" }}
              ·
              {{
                runtimeStatusLabel(connectivityStore.ready?.mode ?? "unknown")
              }}
            </dd>
          </div>
          <div class="border-t border-white/10 py-3">
            <dt class="text-sm text-slate-400">同步</dt>
            <dd class="mt-1 font-bold text-white">
              {{ runtimeStatusLabel(mqttStore.status) }} ·
              {{ mqttStore.lastError ?? "正常" }}
            </dd>
          </div>
          <div class="border-t border-white/10 py-3">
            <dt class="text-sm text-slate-400">MQTT</dt>
            <dd class="mt-1 font-bold text-white">
              {{ runtimeStatusLabel(mqttStore.status) }} · 待发队列
              {{ mqttStore.outboxSize }}
            </dd>
          </div>
          <div class="border-t border-white/10 py-3">
            <dt class="text-sm text-slate-400">下位机</dt>
            <dd class="mt-1 font-bold text-white">
              {{ machineStore.health?.hardwareOnline ? "在线" : "不可用" }}
            </dd>
          </div>
          <div class="border-t border-white/10 py-3">
            <dt class="text-sm text-slate-400">扫码器</dt>
            <dd class="mt-1 font-bold text-white">
              {{ scannerStore.online ? "在线" : "不可用" }} ·
              {{ operatorMessageLabel(scannerStore.message) }}
            </dd>
          </div>
          <div class="border-t border-white/10 py-3">
            <dt class="text-sm text-slate-400">视觉运行状态</dt>
            <dd class="mt-1 font-bold text-white">
              {{ visionStore.online ? "在线" : "不可用" }} ·
              {{ operatorMessageLabel(visionStore.message) }}
            </dd>
          </div>
          <div class="border-t border-white/10 py-3">
            <dt class="text-sm text-slate-400">来人交互</dt>
            <dd class="mt-1 font-bold text-white">
              {{ visionStore.presence.personPresent ? "有人" : "无人" }} ·
              {{ runtimeStatusLabel(visionStore.presence.occupancyState) }} ·
              画像{{ visionStore.presence.profileUsable ? "可用" : "不可用" }}
              ·
              {{ visionStore.presence.lastSeenAt ?? "未看到" }}
            </dd>
          </div>
          <div class="border-t border-white/10 py-3">
            <dt class="text-sm text-slate-400">自然环境上下文</dt>
            <dd class="mt-1 font-bold text-white">
              {{ naturalContextDisplayStatus() }}
            </dd>
            <dd
              v-if="naturalContextDiagnosticMessage"
              class="mt-1 text-sm font-semibold text-amber-100"
            >
              {{ operatorMessageLabel(naturalContextDiagnosticMessage) }}
            </dd>
          </div>
          <div class="border-t border-white/10 py-3">
            <dt class="text-sm text-slate-400">本地状态</dt>
            <dd class="mt-1 font-bold text-white">
              {{ runtimeStatusLabel(stockMaintenance.source ?? "unknown") }} ·
              {{ stockMaintenance.planogramVersion ?? "无货道图" }}
            </dd>
          </div>
          <div class="border-t border-white/10 py-3">
            <dt class="text-sm text-slate-400">远程运维</dt>
            <dd class="mt-1 font-bold text-white">
              待处理 {{ remoteOpsStore.pending }} ·
              {{ remoteOpsStore.lastError ?? "正常" }}
            </dd>
          </div>
        </dl>

        <section
          v-if="saleCriticalBlockers.length > 0"
          class="mt-5 border-t border-white/10 pt-4 text-left"
        >
          <h3 class="text-sm font-semibold text-slate-200">销售就绪阻塞项</h3>
          <ul class="mt-2 grid gap-2 text-sm text-slate-100">
            <li
              v-for="blocker in saleCriticalBlockers"
              :key="`${blocker.component}-${blocker.code}`"
            >
              <span class="font-semibold">
                {{ blocker.operatorLabel }} · {{ blocker.code }}:
              </span>
              {{ blocker.message }}
              <span class="text-slate-300"> {{ blocker.operatorAction }}</span>
            </li>
          </ul>
        </section>

        <section class="mt-5 border-t border-white/10 pt-4 text-left">
          <h3 class="text-sm font-semibold text-slate-200">音频提示设置</h3>
          <p class="mt-1 text-sm text-slate-300">
            机器音频提示分类是本地顾客体验设置。
          </p>
          <dl class="mt-3 grid gap-3 md:grid-cols-3">
            <div
              v-for="row in audioCueSettingsRows"
              :key="row.label"
              class="rounded-xl bg-slate-950/35 p-3"
            >
              <dt class="text-xs font-semibold text-slate-400">机器音频提示</dt>
              <dd class="mt-1 font-bold text-white">
                {{ row.label }} · {{ row.value }}
              </dd>
            </div>
          </dl>
        </section>

        <section
          class="mt-5 border-t border-white/10 pt-4 text-left"
          data-test="audio-cue-diagnostic"
        >
          <h3 class="text-sm font-semibold text-slate-200">
            最新机器音频提示诊断
          </h3>
          <p
            v-if="latestAudioCueDiagnosticRows.length === 0"
            class="mt-2 text-sm text-slate-300"
          >
            尚未记录机器音频提示诊断。
          </p>
          <dl v-else class="mt-3 grid gap-3 md:grid-cols-2">
            <div
              v-for="row in latestAudioCueDiagnosticRows"
              :key="row.label"
              class="rounded-xl bg-slate-950/35 p-3"
            >
              <dt class="text-xs font-semibold text-slate-400">
                {{ row.label }}
              </dt>
              <dd class="mt-1 font-bold text-white">
                {{ row.label }} · {{ row.value }}
              </dd>
            </div>
          </dl>
        </section>

        <section class="mt-5 border-t border-white/10 pt-4 text-left">
          <h3 class="text-sm font-semibold text-slate-200">最新视觉诊断载荷</h3>
          <pre
            class="mt-2 max-h-72 overflow-auto text-sm leading-6 break-words whitespace-pre-wrap text-slate-100"
            data-test="vision-diagnostic-payload"
            >{{ latestVisionDiagnosticPayloadText }}</pre
          >
        </section>

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
          <span class="text-sm font-semibold text-slate-200">机器编号</span>
          <input
            v-model="form.machineCode"
            class="kiosk-touch-target rounded-2xl border border-white/10 bg-slate-950/70 px-4 text-white outline-none focus:border-sky-300"
            placeholder="例如 M001"
          />
        </label>

        <label class="grid gap-2 text-left">
          <span class="text-sm font-semibold text-slate-200">机器位置标签</span>
          <input
            v-model="form.machineLocationLabel"
            class="kiosk-touch-target rounded-2xl border border-white/10 bg-slate-950/70 px-4 text-white outline-none focus:border-sky-300"
            placeholder="例如 一层大厅"
          />
        </label>

        <div class="grid gap-2 text-left">
          <span class="text-sm font-semibold text-slate-200">机器密钥</span>
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
            >MQTT 签名密钥</span
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
          <span class="text-sm font-semibold text-slate-200">MQTT 用户名</span>
          <input
            v-model="form.mqttUsername"
            class="kiosk-touch-target rounded-2xl border border-white/10 bg-slate-950/70 px-4 text-white outline-none focus:border-sky-300"
            placeholder="MQTT Broker 用户名"
          />
        </label>

        <div class="grid gap-2 text-left">
          <span class="text-sm font-semibold text-slate-200">MQTT 密码</span>
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
          <span class="text-sm font-semibold text-slate-200"
            >后端 API 地址</span
          >
          <input
            v-model="form.apiBaseUrl"
            class="kiosk-touch-target rounded-2xl border border-white/10 bg-slate-950/70 px-4 text-white outline-none focus:border-sky-300"
          />
        </label>

        <label class="grid gap-2 text-left">
          <span class="text-sm font-semibold text-slate-200">MQTT 地址</span>
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
              {{ adapterLabel(adapter) }}
            </option>
          </select>
        </label>

        <div v-if="form.hardwareAdapter === 'serial'" class="grid gap-4">
          <label class="grid gap-2 text-left">
            <span class="text-sm font-semibold text-slate-200"
              >手动串口兜底</span
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
            扫码器适配器
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
                  {{ adapterLabel(scannerAdapter) }}
                </option>
              </select>
            </label>

            <label
              v-if="form.scannerAdapter === 'serial_text'"
              class="grid gap-2 text-left"
            >
              <span class="text-sm font-semibold text-slate-200"
                >扫码串口路径</span
              >
              <input
                v-model="form.scannerSerialPortPath"
                class="kiosk-touch-target rounded-2xl border border-white/10 bg-slate-950/70 px-4 text-white outline-none focus:border-sky-300"
                placeholder="Linux 如 /dev/ttyUSB1；Windows 如 COM4"
              />
            </label>

            <label class="grid gap-2 text-left">
              <span class="text-sm font-semibold text-slate-200"
                >扫码波特率</span
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
                >扫码结尾符</span
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
                  {{ frameSuffixLabel(frameSuffix) }}
                </option>
              </select>
            </label>
          </div>
        </div>

        <div class="rounded-3xl border border-white/10 bg-slate-950/30 p-5">
          <p
            class="text-sm font-semibold tracking-[0.28em] text-fuchsia-200 uppercase"
          >
            视觉模块
          </p>

          <div class="mt-4 grid gap-4">
            <label class="flex items-center gap-3 text-left">
              <input
                v-model="form.visionEnabled"
                class="size-5 accent-fuchsia-300"
                type="checkbox"
              />
              <span class="text-sm font-semibold text-slate-200"
                >启用视觉推荐</span
              >
            </label>

            <label class="grid gap-2 text-left">
              <span class="text-sm font-semibold text-slate-200"
                >视觉 WebSocket 地址</span
              >
              <input
                v-model="form.visionWsUrl"
                class="kiosk-touch-target rounded-2xl border border-white/10 bg-slate-950/70 px-4 text-white outline-none focus:border-fuchsia-300"
                placeholder="ws://127.0.0.1:7892/ws"
              />
            </label>

            <label class="grid gap-2 text-left">
              <span class="text-sm font-semibold text-slate-200"
                >视觉连接自检超时</span
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

            <div class="grid gap-4 rounded-2xl border border-white/10 p-4">
              <div class="grid gap-1 text-left">
                <span class="text-sm font-semibold text-slate-200">
                  视觉试衣预览诊断
                </span>
                <span class="text-xs text-slate-300"
                  >用于现场检查试衣预览通道</span
                >
              </div>

              <div class="grid gap-3 md:grid-cols-2">
                <button
                  class="kiosk-touch-target rounded-2xl border border-fuchsia-200/30 px-4 py-3 font-bold text-fuchsia-100 disabled:opacity-50"
                  type="button"
                  :disabled="
                    tryOnPreviewDiagnostic.loading ||
                    Boolean(tryOnPreviewDiagnostic.previewUrl)
                  "
                  @click="startTryOnPreviewDiagnostic"
                >
                  启动试衣预览
                </button>
                <button
                  class="kiosk-touch-target rounded-2xl border border-slate-200/30 px-4 py-3 font-bold text-slate-100 disabled:opacity-50"
                  type="button"
                  :disabled="!tryOnPreviewDiagnostic.previewUrl"
                  @click="stopTryOnPreviewDiagnostic"
                >
                  释放试衣预览
                </button>
              </div>

              <img
                v-if="tryOnPreviewDiagnostic.previewUrl"
                :src="tryOnPreviewDiagnostic.previewUrl"
                class="aspect-video w-full rounded-2xl border border-white/10 bg-slate-950 object-cover"
                data-test="try-on-camera-preview"
                alt=""
              />

              <dl
                v-if="tryOnPreviewDiagnostic.previewUrl"
                class="grid gap-2 rounded-2xl bg-slate-950/50 p-4 text-left text-sm text-slate-100"
              >
                <div class="grid gap-1">
                  <dt class="text-xs text-slate-400">会话</dt>
                  <dd class="break-all">
                    {{ tryOnPreviewDiagnostic.sessionId }}
                  </dd>
                </div>
                <div class="grid gap-1">
                  <dt class="text-xs text-slate-400">视频流</dt>
                  <dd>{{ tryOnPreviewDiagnostic.streamType }}</dd>
                </div>
                <div class="grid gap-1">
                  <dt class="text-xs text-slate-400">预览地址</dt>
                  <dd class="break-all">
                    {{ tryOnPreviewDiagnostic.previewUrl }}
                  </dd>
                </div>
              </dl>

              <p
                v-if="tryOnPreviewDiagnostic.message"
                class="rounded-2xl bg-fuchsia-500/15 p-4 text-fuchsia-100"
              >
                {{ tryOnPreviewDiagnostic.message }}
              </p>
            </div>

            <fieldset class="grid gap-3 text-left md:grid-cols-3">
              <label class="flex items-center gap-3">
                <input
                  v-model="form.audioCueSettings.enabled"
                  class="size-5 accent-fuchsia-300"
                  type="checkbox"
                />
                <span class="text-sm font-semibold text-slate-200"
                  >启用机器音频提示</span
                >
              </label>
              <label class="flex items-center gap-3">
                <input
                  v-model="form.audioCueSettings.categories.presence"
                  class="size-5 accent-fuchsia-300"
                  type="checkbox"
                />
                <span class="text-sm font-semibold text-slate-200"
                  >来人音频提示</span
                >
              </label>
              <label class="flex items-center gap-3">
                <input
                  v-model="form.audioCueSettings.categories.transaction"
                  class="size-5 accent-fuchsia-300"
                  type="checkbox"
                />
                <span class="text-sm font-semibold text-slate-200"
                  >交易音频提示</span
                >
              </label>
            </fieldset>

            <label class="grid gap-2 text-left">
              <span class="text-sm font-semibold text-slate-200"
                >机器音频音量</span
              >
              <div class="flex items-center gap-3">
                <input
                  v-model.number="form.machineAudioVolumePercent"
                  class="kiosk-touch-target w-32 rounded-2xl border border-white/10 bg-slate-950/70 px-4 text-white outline-none focus:border-fuchsia-300"
                  data-test="machine-audio-volume-percent"
                  max="100"
                  min="0"
                  step="1"
                  type="number"
                />
                <span class="text-sm font-bold text-slate-200">%</span>
              </div>
            </label>

            <section
              class="grid gap-4 rounded-2xl border border-cyan-200/20 bg-cyan-500/10 p-4 text-left"
              data-test="machine-audio-test-playback"
            >
              <div class="grid gap-1">
                <h3 class="text-base font-bold text-cyan-100">
                  机器音频测试播放
                </h3>
                <p class="text-sm leading-6 text-cyan-50/85">
                  现场检查：通过近场顾客扬声器确认顾客音频区域清晰可听，并确认顾客区域外声音不扰人。
                </p>
              </div>

              <div class="flex flex-wrap gap-3">
                <button
                  class="kiosk-touch-target rounded-2xl bg-cyan-300 px-4 py-3 font-bold text-slate-950 disabled:opacity-50"
                  type="button"
                  :disabled="machineAudioTestPlayback.loading"
                  @click="playMachineAudioTestPlayback"
                >
                  播放测试音频
                </button>
                <button
                  class="kiosk-touch-target rounded-2xl border border-cyan-100/40 px-4 py-3 font-bold text-cyan-50 disabled:opacity-50"
                  type="button"
                  @click="stopMachineAudioTestPlayback"
                >
                  停止当前播放
                </button>
              </div>

              <dl class="grid gap-3 md:grid-cols-2">
                <div class="rounded-xl bg-slate-950/35 p-3">
                  <dt class="text-xs font-semibold text-cyan-100/70">
                    当前播放驱动
                  </dt>
                  <dd class="mt-1 font-bold text-white">
                    当前播放驱动 ·
                    {{ machineAudioTestPlayback.driver }}
                  </dd>
                </div>
                <div
                  v-for="row in latestMachineAudioTestPlaybackRows"
                  :key="row.label"
                  class="rounded-xl bg-slate-950/35 p-3"
                >
                  <dt class="text-xs font-semibold text-cyan-100/70">
                    {{ row.label }}
                  </dt>
                  <dd class="mt-1 font-bold break-all text-white">
                    {{ row.label }} · {{ row.value }}
                  </dd>
                </div>
              </dl>

              <p
                v-if="machineAudioTestPlayback.message"
                class="rounded-2xl bg-cyan-950/40 p-3 text-sm text-cyan-50"
              >
                {{ machineAudioTestPlayback.message }}
              </p>
            </section>

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
      <img
        :src="listSloganImage"
        alt=""
        aria-hidden="true"
        class="maintenance-slogan"
      />
    </section>
  </KioskLayout>
</template>

<style scoped>
:global(.kiosk-shell:has(.maintenance-page)) {
  padding: 0;
}

:global(.kiosk-shell:has(.maintenance-page) > header) {
  display: none;
}

:global(.kiosk-shell:has(.maintenance-page) > .kiosk-scroll) {
  width: 100%;
  height: 100%;
  margin-top: 0;
  padding-bottom: 0;
}

.maintenance-page {
  position: relative;
  min-height: 100%;
  padding: var(--machine-page-header-top) var(--machine-page-inline) 2.5rem;
  overflow-x: hidden;
  color: #3f3b34;
  background:
    radial-gradient(
      circle at 18% 6%,
      rgba(255, 255, 255, 0.92),
      rgba(255, 255, 255, 0) 28%
    ),
    linear-gradient(180deg, #faf8f1 0%, #f4efe2 54%, #efe8d8 100%);
}

.maintenance-header {
  position: sticky;
  top: 0;
  z-index: 4;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 1rem;
  align-items: center;
  padding: 0.35rem 0 1rem;
  background: linear-gradient(
    180deg,
    rgba(250, 248, 241, 0.96) 0%,
    rgba(250, 248, 241, 0.86) 74%,
    rgba(250, 248, 241, 0) 100%
  );
  backdrop-filter: blur(4px);
}

.maintenance-brand {
  display: flex;
  align-items: center;
  min-width: 0;
  gap: 1.1rem;
}

.maintenance-brand img:first-child {
  width: clamp(9rem, 25cqw, 13.2rem);
  height: auto;
}

.maintenance-brand img:last-child {
  width: clamp(2.5rem, 8cqw, 4rem);
  height: auto;
  opacity: 0.82;
}

.maintenance-title-block {
  text-align: right;
}

.maintenance-title-block p,
.maintenance-page p[class*="uppercase"] {
  margin: 0;
  color: #6d7f5f;
  font-size: 0.74rem;
  font-weight: 700;
  letter-spacing: 0.14em;
}

.maintenance-title-block h2 {
  margin-top: 0.18rem;
  color: #263326;
  font-size: 1.45rem;
  font-weight: 800;
  letter-spacing: 0;
}

.maintenance-page > div,
.maintenance-page > form {
  position: relative;
  z-index: 1;
}

.maintenance-page > div[class*="rounded-3xl"],
.maintenance-page > form {
  border: 1px solid rgba(126, 112, 82, 0.28) !important;
  border-radius: 0.65rem !important;
  background: rgba(255, 253, 247, 0.84) !important;
  padding: 1rem !important;
  color: #403c34 !important;
  box-shadow: 0 1rem 2.4rem rgba(98, 80, 50, 0.08) !important;
}

.maintenance-page > form {
  display: grid;
  gap: 0.9rem;
}

.maintenance-page :is(.rounded-4xl, .rounded-3xl, .rounded-2xl, .rounded-xl) {
  border-radius: 0.42rem !important;
}

.maintenance-page
  :is(
    .bg-slate-950\/30,
    .bg-slate-950\/35,
    .bg-slate-950\/40,
    .bg-slate-950\/45
  ) {
  background: rgba(248, 244, 234, 0.72) !important;
}

.maintenance-page
  :is(
    .text-white,
    .text-slate-50,
    .text-slate-100,
    .text-slate-200,
    .text-slate-300,
    .text-slate-400
  ) {
  color: #463f34 !important;
}

.maintenance-page
  :is(
    .text-emerald-100,
    .text-emerald-200,
    .text-sky-100,
    .text-sky-200,
    .text-fuchsia-100,
    .text-fuchsia-200
  ) {
  color: #5f7353 !important;
}

.maintenance-page [class*="text-rose-"] {
  color: #7b3430 !important;
}

.maintenance-page
  :is(
    .border-white\/10,
    .border-slate-200\/30,
    .border-sky-200\/30,
    .border-emerald-200\/30,
    .border-fuchsia-200\/30
  ) {
  border-color: rgba(126, 112, 82, 0.24) !important;
}

.maintenance-page :is(input, select, textarea) {
  border: 1px solid rgba(126, 112, 82, 0.3) !important;
  border-radius: 0.38rem !important;
  background: rgba(255, 255, 255, 0.76) !important;
  color: #2f2a23 !important;
}

.maintenance-page :is(input, select) {
  min-height: 2.85rem;
}

.maintenance-page label {
  gap: 0.38rem;
}

.maintenance-page label > span,
.maintenance-page label {
  color: #4d463c !important;
}

.maintenance-page button {
  border-radius: 0.42rem !important;
  border-color: rgba(93, 112, 80, 0.38) !important;
  background: rgba(255, 253, 247, 0.86) !important;
  color: #49613f !important;
  box-shadow: none !important;
}

.maintenance-page button[type="submit"],
.maintenance-page button:last-child:not([type="button"]) {
  background: #6f835f !important;
  color: #fffdf7 !important;
}

.maintenance-page dl {
  overflow: hidden;
  border: 1px solid rgba(126, 112, 82, 0.22);
  border-radius: 0.48rem;
  background: rgba(255, 253, 247, 0.66);
}

.maintenance-page dl > div {
  min-height: 4.05rem;
  border-bottom: 1px solid rgba(126, 112, 82, 0.16);
  border-radius: 0 !important;
  background: transparent !important;
  padding: 0.7rem 0.85rem !important;
}

.maintenance-page dl > div:nth-last-child(-n + 2) {
  border-bottom: 0;
}

.maintenance-page dt {
  color: #7b7468 !important;
  font-size: 0.72rem;
  font-weight: 600;
}

.maintenance-page dd {
  color: #2e2a24 !important;
  font-size: 0.92rem;
  line-height: 1.35;
}

.maintenance-page :is(.bg-amber-500\/15, .bg-amber-500\/20) {
  border: 1px solid rgba(181, 126, 34, 0.24);
  background: rgba(255, 246, 220, 0.82) !important;
  color: #70501d !important;
}

.maintenance-page :is(.bg-rose-500\/15, .bg-rose-500\/20) {
  border: 1px solid rgba(174, 74, 70, 0.28);
  background: rgba(255, 239, 235, 0.9) !important;
  color: #7b3430 !important;
}

.maintenance-page
  :is(
    .bg-sky-500\/15,
    .bg-fuchsia-500\/15,
    .bg-emerald-500\/15,
    .bg-slate-500\/15
  ) {
  border: 1px solid rgba(99, 119, 85, 0.2);
  background: rgba(242, 247, 236, 0.88) !important;
  color: #4f6845 !important;
}

.maintenance-page .grid.gap-3.md\:grid-cols-2,
.maintenance-page .grid.gap-4.md\:grid-cols-2 {
  gap: 0.55rem;
}

.maintenance-page .maintenance-slogan {
  display: block;
  width: min(24rem, 62%);
  margin: 1.2rem auto 0;
  opacity: 0.45;
}

@media (max-width: 760px) {
  .maintenance-page {
    padding: 1.5rem 1.45rem 2rem;
  }

  .maintenance-header {
    grid-template-columns: 1fr;
  }

  .maintenance-title-block {
    text-align: left;
  }

  .maintenance-page dl > div:nth-last-child(2) {
    border-bottom: 1px solid rgba(126, 112, 82, 0.16);
  }
}
</style>
