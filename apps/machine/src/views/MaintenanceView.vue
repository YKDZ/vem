<script setup lang="ts">
import {
  type DaemonIpcAudioOutputBindingSnapshot,
  type DaemonIpcAudioOutputTestResponse,
  formatMachineSlotCoordinate,
  type StockMaintenanceTask,
  type PaymentProviderEnvironmentDiagnostic,
} from "@vem/shared";
import { computed, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import { useRoute } from "vue-router";

import type { MachineAudioPlaybackDiagnostic } from "@/audio-playback/machine-audio-playback";
import type {
  DeviceBindingSnapshot,
  MaintenanceSession,
} from "@/daemon/schemas";

import listSloganImage from "@/assets/home/list-slogan.png";
import logoImage from "@/assets/home/logo.png";
import mascotTopImage from "@/assets/home/mascot-top-cutout.png";
import MockHardwareControls from "@/components/MockHardwareControls.vue";
import VisionCameraMaintenancePanel from "@/components/VisionCameraMaintenancePanel.vue";
import { useMaintenanceEntry } from "@/composables/useMaintenanceEntry";
import {
  machineConfigDefaults,
  type HardwareAdapter,
  type MachineConfig,
  type MachineAudioOutputBinding,
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
import { submitMachineNavigationIntent } from "@/router/transaction-route-authority";
import { useAudioCueStore } from "@/stores/audio-cues";
import { useCatalogStore } from "@/stores/catalog";
import { useConnectivityStore } from "@/stores/connectivity";
import { useMachineStore } from "@/stores/machine";
import { useMqttStore } from "@/stores/mqtt";
import { useNaturalContextStore } from "@/stores/natural-context";
import { useRemoteOpsStore } from "@/stores/remote-ops";
import { useScannerStore } from "@/stores/scanner";
import { useVisionStore } from "@/stores/vision";
import { setMaintenanceTouchKeyboardSession } from "@/touch-keyboard/maintenance-authorization";

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
const maintenanceAuthentication = reactive({
  pin: "",
  loading: false,
  message: null as string | null,
});
const maintenanceSession = ref<MaintenanceSession | null>(null);
const maintenanceSessionAuthorized = computed(
  () =>
    maintenanceSession.value !== null &&
    Date.parse(maintenanceSession.value.expiresAt) > Date.now(),
);
const paymentEnvironmentDiagnostic =
  ref<PaymentProviderEnvironmentDiagnostic | null>(null);
const paymentEnvironmentMessage = ref<string | null>(null);
const paymentEnvironmentLabel = computed(() => {
  switch (paymentEnvironmentDiagnostic.value?.environment) {
    case "sandbox":
      return "沙箱";
    case "production":
      return "正式";
    case "mixed":
      return "混合配置";
    default:
      return "未配置";
  }
});
const paymentEnvironmentReadinessLabel = computed(() =>
  paymentEnvironmentDiagnostic.value?.readiness === "ready"
    ? "已就绪"
    : "未就绪",
);
const paymentEnvironmentErrorLabel = computed(() => {
  switch (paymentEnvironmentDiagnostic.value?.errorCategory) {
    case "none":
      return "无";
    case "no_enabled_channel":
      return "未启用支付渠道";
    case "provider_unconfigured":
      return "支付提供方未配置";
    case "credentials_incomplete":
      return "平台凭据不完整";
    case "mixed_environment":
      return "支付环境混合";
    default:
      return "尚未读取";
  }
});
let removeMaintenanceSessionInvalidationListener: (() => void) | null = null;
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
const catalogOperatorDiagnostics = computed(
  () => catalogStore.operatorDiagnostics,
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

const effectiveRuntimeConfigurationRows = computed(() => {
  const configuration = machineStore.effectiveRuntimeConfiguration;
  if (!configuration) return [];
  return [
    {
      label: "认领状态",
      value: configuration.profileRefresh.status,
    },
    {
      label: "平台机器",
      value: configuration.machine?.code ?? "未认领",
    },
    {
      label: "硬件型号",
      value: configuration.hardware.model,
    },
    {
      label: "本地设置版本",
      value: String(configuration.sourceRevisions.localSettingsRevision),
    },
  ];
});

const machineAudioOutputMaintenance = reactive({
  loading: false,
  saving: false,
  message: null as string | null,
  snapshot: null as DaemonIpcAudioOutputBindingSnapshot | null,
  selectedEndpointId: null as string | null,
  heardConfirmation: false,
  testEvidence: null as DaemonIpcAudioOutputTestResponse | null,
});

const machineAudioOutputCandidates = computed(
  () => machineAudioOutputMaintenance.snapshot?.candidates ?? [],
);

const confirmedMachineAudioOutputBinding =
  computed<MachineAudioOutputBinding | null>(
    () => machineStore.config.machineAudioOutputBinding,
  );
const observedMachineAudioOutputBinding = computed(
  () => machineAudioOutputMaintenance.snapshot?.currentObservation ?? null,
);
const selectedMachineAudioOutputCandidate = computed(
  () =>
    machineAudioOutputCandidates.value.find(
      (candidate) =>
        candidate.endpointId ===
        machineAudioOutputMaintenance.selectedEndpointId,
    ) ?? null,
);
const machineAudioOutputBindingRows = computed(() => {
  const binding = confirmedMachineAudioOutputBinding.value;
  const observed = observedMachineAudioOutputBinding.value;
  if (!binding) {
    return [
      { label: "绑定状态", value: "未确认近场顾客扬声器" },
      { label: "当前观察", value: "必须先选择端点并确认“我听到了”" },
    ];
  }
  return [
    {
      label: "绑定状态",
      value: observed ? "已确认" : "已确认，但当前未检测到端点",
    },
    {
      label: "端点",
      value:
        observed?.friendlyName ?? binding.friendlyName ?? binding.endpointId,
    },
    {
      label: "端点 ID",
      value: binding.endpointId,
    },
    {
      label: "当前观察",
      value: observed
        ? observed.isDefault
          ? "已检测到（当前也是 Windows 默认输出）"
          : "已检测到"
        : "未检测到；顾客音频会保持阻塞",
    },
    {
      label: "人工确认时间",
      value: binding.confirmedHeardAt,
    },
  ];
});
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
    !maintenanceSessionAuthorized.value ||
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

async function beginProtectedMaintenance(): Promise<void> {
  maintenanceAuthentication.loading = true;
  maintenanceAuthentication.message = null;
  try {
    const scopes = [
      ...(operatorEnteredMaintenance.value ? ["maintenance.reclaim"] : []),
      ...(operatorEnteredMaintenance.value
        ? ["maintenance.manual_dispense"]
        : []),
      ...(showProtectedDesktopExit.value ? ["maintenance.desktop_exit"] : []),
    ];
    const session = await daemonClient.beginMaintenanceSession(
      maintenanceAuthentication.pin,
      scopes,
      operatorEnteredMaintenance.value ? "operator-console" : "front-panel",
    );
    setMaintenanceSession(session);
    await refreshPaymentEnvironmentDiagnostic();
    maintenanceAuthentication.pin = "";
    maintenanceAuthentication.message = `已验证维护会话，${new Date(session.expiresAt).toLocaleTimeString("zh-CN")} 前有效。`;
  } catch (error) {
    clearMaintenanceSession();
    maintenanceAuthentication.message =
      error instanceof Error ? error.message : "维护 PIN 验证失败";
  } finally {
    maintenanceAuthentication.loading = false;
  }
}

function setMaintenanceSession(session: MaintenanceSession): void {
  clearRenderedMaintenanceSession();
  maintenanceSession.value = session;
  setMaintenanceTouchKeyboardSession(session.sessionId);
}

function clearRenderedMaintenanceSession(): void {
  maintenanceSession.value = null;
  paymentEnvironmentDiagnostic.value = null;
  paymentEnvironmentMessage.value = null;
  setMaintenanceTouchKeyboardSession(null);
}

function clearMaintenanceSession(): void {
  clearRenderedMaintenanceSession();
  daemonClient.clearMaintenanceSession();
}

function clearMaintenanceSessionAfterAuthorizationFailure(
  error: unknown,
): void {
  if (
    error instanceof Error &&
    /HTTP 403|authorization_denied/i.test(error.message)
  ) {
    clearMaintenanceSession();
    maintenanceAuthentication.message = "维护会话已失效，请重新验证 PIN。";
  }
}

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
  machineAudioOutputMaintenance.selectedEndpointId =
    machineStore.config.machineAudioOutputBinding?.endpointId ?? null;
  machineAudioOutputMaintenance.heardConfirmation = false;
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
  const handedOffSession =
    daemonClient.getMaintenanceSessionForRoute("maintenance");
  if (handedOffSession) {
    setMaintenanceSession(handedOffSession);
    maintenanceAuthentication.message = "已继续首次部署的维护会话。";
  }
  removeMaintenanceSessionInvalidationListener =
    daemonClient.onMaintenanceSessionInvalidated(() => {
      clearMaintenanceSession();
      maintenanceAuthentication.message =
        "守护进程连接已更新，维护会话已失效，请重新验证 PIN。";
    });
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

  try {
    await machineStore.loadEffectiveRuntimeConfiguration();
  } catch {
    // Runtime diagnostics remain available when the configuration projection is unavailable.
  }

  if (runtimeFlags.advancedMaintenanceConfig) {
    try {
      if (!machineStore.configLoaded) {
        await machineStore.loadConfig();
      }
      syncFormFromStore();
      await refreshMachineAudioOutputs();
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
  removeMaintenanceSessionInvalidationListener?.();
  removeMaintenanceSessionInvalidationListener = null;
  stopDiagnosticsAutoRefresh();
  void callTauriCommand<void>("stop_machine_audio").catch(() => undefined);
  clearRenderedMaintenanceSession();
  void daemonClient.revokeMaintenanceSessionRoute("maintenance");
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

const manualDispenseDiagnostic = reactive({
  slotCode: "A1",
  layerNo: 1,
  cellNo: 1,
  loading: false,
  message: null as string | null,
});

const MANUAL_DISPENSE_REQUEST_STORAGE_KEY =
  "vem.maintenance.manual-dispense-request.v1";

function manualDispenseRequestFingerprint(): string {
  return JSON.stringify({
    cellNo: manualDispenseDiagnostic.cellNo,
    layerNo: manualDispenseDiagnostic.layerNo,
    quantity: 1,
    slotCode: manualDispenseDiagnostic.slotCode.trim(),
    timeoutSeconds: 30,
  });
}

function persistNewManualDispenseRequest(): {
  fingerprint: string;
  idempotencyKey: string;
} {
  const identity = {
    fingerprint: manualDispenseRequestFingerprint(),
    idempotencyKey: crypto.randomUUID(),
  };
  localStorage.setItem(
    MANUAL_DISPENSE_REQUEST_STORAGE_KEY,
    JSON.stringify(identity),
  );
  return identity;
}

function currentManualDispenseIdempotencyKey(): string {
  const fingerprint = manualDispenseRequestFingerprint();
  try {
    const stored = JSON.parse(
      localStorage.getItem(MANUAL_DISPENSE_REQUEST_STORAGE_KEY) ?? "null",
    ) as unknown;
    if (
      stored &&
      typeof stored === "object" &&
      "fingerprint" in stored &&
      stored.fingerprint === fingerprint &&
      "idempotencyKey" in stored &&
      typeof stored.idempotencyKey === "string" &&
      /^[A-Za-z0-9_-]{1,96}$/.test(stored.idempotencyKey)
    ) {
      return stored.idempotencyKey;
    }
  } catch {
    // Replace malformed local recovery state with a fresh bounded identity.
  }
  return persistNewManualDispenseRequest().idempotencyKey;
}

function startNewManualDispenseDiagnostic(): void {
  persistNewManualDispenseRequest();
  manualDispenseDiagnostic.message =
    "已新建诊断；下次执行会产生一次新的物理出货。";
}

async function runManualDispenseDiagnostic(): Promise<void> {
  if (!maintenanceSessionAuthorized.value || !operatorEnteredMaintenance.value)
    return;
  manualDispenseDiagnostic.loading = true;
  manualDispenseDiagnostic.message = null;
  try {
    const result = await daemonClient.runManualDispenseDiagnostic({
      idempotencyKey: currentManualDispenseIdempotencyKey(),
      slotCode: manualDispenseDiagnostic.slotCode.trim(),
      layerNo: manualDispenseDiagnostic.layerNo,
      cellNo: manualDispenseDiagnostic.cellNo,
      quantity: 1,
      timeoutSeconds: 30,
    });
    manualDispenseDiagnostic.message =
      result.outcome === "completed"
        ? `诊断出货完成（${result.diagnosticId}）。请立即执行库存核对。`
        : `诊断结果 ${result.outcome}（${result.diagnosticId}）。请核实实物并执行库存核对。`;
  } catch (error) {
    clearMaintenanceSessionAfterAuthorizationFailure(error);
    manualDispenseDiagnostic.message =
      error instanceof Error ? error.message : String(error);
  } finally {
    manualDispenseDiagnostic.loading = false;
  }
}

const deviceBindingMaintenance = reactive({
  loading: false,
  message: null as string | null,
  snapshot: null as DeviceBindingSnapshot | null,
  tested: {} as Partial<
    Record<
      "lower_controller" | "scanner",
      { identityKey: string; testEvidenceToken: string }
    >
  >,
});

async function refreshDeviceBindings(): Promise<void> {
  delete deviceBindingMaintenance.tested.lower_controller;
  delete deviceBindingMaintenance.tested.scanner;
  try {
    deviceBindingMaintenance.snapshot = await daemonClient.getDeviceBindings();
  } catch (error) {
    deviceBindingMaintenance.message =
      error instanceof Error ? error.message : String(error);
  }
}

async function testDeviceBinding(
  role: "lower_controller" | "scanner",
  identityKey: string,
): Promise<void> {
  if (!maintenanceSessionAuthorized.value) return;
  deviceBindingMaintenance.loading = true;
  deviceBindingMaintenance.message = null;
  try {
    const result = await daemonClient.testDeviceBinding(role, identityKey);
    deviceBindingMaintenance.tested[role] = {
      identityKey,
      testEvidenceToken: result.testEvidenceToken,
    };
    deviceBindingMaintenance.message = `${role === "lower_controller" ? "下位机" : "扫码器"}测试通过：${result.currentPort}`;
  } catch (error) {
    clearMaintenanceSessionAfterAuthorizationFailure(error);
    deviceBindingMaintenance.message =
      error instanceof Error ? error.message : String(error);
  } finally {
    deviceBindingMaintenance.loading = false;
  }
}

async function confirmDeviceBinding(
  role: "lower_controller" | "scanner",
  identityKey: string,
): Promise<void> {
  if (
    !maintenanceSessionAuthorized.value ||
    deviceBindingMaintenance.tested[role]?.identityKey !== identityKey
  )
    return;
  deviceBindingMaintenance.loading = true;
  deviceBindingMaintenance.message = null;
  try {
    const tested = deviceBindingMaintenance.tested[role];
    if (!tested) return;
    delete deviceBindingMaintenance.tested[role];
    const result = await daemonClient.confirmDeviceBinding(
      role,
      identityKey,
      tested.testEvidenceToken,
    );
    deviceBindingMaintenance.message = `${role === "lower_controller" ? "下位机" : "扫码器"}已绑定到 ${result.currentPort}`;
    await Promise.all([refreshDeviceBindings(), refreshDiagnostics()]);
  } catch (error) {
    clearMaintenanceSessionAfterAuthorizationFailure(error);
    deviceBindingMaintenance.message =
      error instanceof Error ? error.message : String(error);
  } finally {
    deviceBindingMaintenance.loading = false;
  }
}

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
  task: null as StockMaintenanceTask | null,
  values: {} as Record<string, number | string>,
});

const stockTaskIsRefill = computed(
  () => stockMaintenance.task?.mode === "routine_refill",
);
function isValidStockInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0
  );
}
function refillValueFits(
  slot: StockMaintenanceTask["slots"][number],
  addition: unknown,
): addition is number {
  if (!isValidStockInteger(addition)) return false;
  if (addition === slot.submittedAddition && slot.previewQuantity !== null) {
    return slot.previewQuantity <= slot.capacity;
  }
  return slot.currentQuantity + addition <= slot.capacity;
}
const stockTaskCanSubmit = computed(() => {
  const task = stockMaintenance.task;
  if (!task) return false;
  if (task.mode === "routine_refill") {
    const additions = task.slots.map((slot) => ({
      slot,
      addition: stockMaintenance.values[slot.slotCode] ?? 0,
    }));
    return (
      additions.some(
        ({ addition }) => isValidStockInteger(addition) && addition > 0,
      ) &&
      additions.every(({ slot, addition }) => {
        return refillValueFits(slot, addition);
      })
    );
  }
  return task.slots.every((slot) => {
    const quantity = stockMaintenance.values[slot.slotCode];
    return isValidStockInteger(quantity) && quantity <= slot.capacity;
  });
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
const daemonAudioCalibrationSource = "daemon://audio-output-calibration";

function clearMachineAudioTestEvidence(): void {
  machineAudioOutputMaintenance.testEvidence = null;
  machineAudioOutputMaintenance.heardConfirmation = false;
}

watch(
  () => [
    machineAudioOutputMaintenance.selectedEndpointId,
    machineAudioOutputMaintenance.snapshot?.observationRevision ?? null,
    form.machineAudioVolumePercent,
    form.audioCueSettings.enabled,
    form.audioCueSettings.categories.presence,
    form.audioCueSettings.categories.transaction,
  ],
  () => clearMachineAudioTestEvidence(),
);

async function refreshMachineAudioOutputs(): Promise<void> {
  machineAudioOutputMaintenance.loading = true;
  machineAudioOutputMaintenance.message = null;
  try {
    const snapshot = await daemonClient.getAudioOutputBinding();
    machineAudioOutputMaintenance.snapshot = snapshot;
    if (
      !machineAudioOutputMaintenance.selectedEndpointId &&
      snapshot.binding?.endpointId
    ) {
      machineAudioOutputMaintenance.selectedEndpointId =
        snapshot.binding.endpointId;
    }
  } catch (error) {
    machineAudioOutputMaintenance.message =
      error instanceof Error ? error.message : String(error);
  } finally {
    machineAudioOutputMaintenance.loading = false;
  }
}

async function saveMachineAudioSettings(): Promise<void> {
  if (!maintenanceSessionAuthorized.value) {
    machineAudioOutputMaintenance.message = "请先验证维护 PIN。";
    return;
  }
  const selected = selectedMachineAudioOutputCandidate.value;
  if (!selected) {
    machineAudioOutputMaintenance.message = "请先选择顾客扬声器端点。";
    return;
  }
  if (!machineAudioOutputMaintenance.heardConfirmation) {
    machineAudioOutputMaintenance.message = "请确认“我听到了”后再保存绑定。";
    return;
  }
  const testEvidence = machineAudioOutputMaintenance.testEvidence;
  if (!testEvidence) {
    machineAudioOutputMaintenance.message =
      "请先对当前端点和设置完成测试播放。";
    return;
  }
  machineAudioOutputMaintenance.saving = true;
  machineAudioOutputMaintenance.message = null;
  try {
    const summary = await daemonClient.confirmAudioOutput({
      endpointId: selected.endpointId,
      testEvidenceToken: testEvidence.testEvidenceToken,
      heard: true,
      audioCueSettings: {
        enabled: form.audioCueSettings.enabled,
        categories: {
          presence: form.audioCueSettings.categories.presence,
          transaction: form.audioCueSettings.categories.transaction,
        },
      },
      machineAudioVolume: form.machineAudioVolumePercent / 100,
    });
    machineStore.applyConfigSummary(summary);
    syncFormFromStore();
    await refreshMachineAudioOutputs();
    machineAudioOutputMaintenance.message =
      "顾客音频输出绑定与音频提示设置已保存。";
  } catch (error) {
    clearMaintenanceSessionAfterAuthorizationFailure(error);
    machineAudioOutputMaintenance.message =
      error instanceof Error ? error.message : String(error);
  } finally {
    machineAudioOutputMaintenance.saving = false;
  }
}

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
  if (!maintenanceSessionAuthorized.value) {
    machineAudioTestPlayback.message = "请先验证维护 PIN。";
    return;
  }
  const selected = selectedMachineAudioOutputCandidate.value;
  if (!selected) {
    machineAudioTestPlayback.message = "请先选择顾客扬声器端点。";
    return;
  }
  machineAudioTestPlayback.loading = true;
  machineAudioTestPlayback.message = null;
  clearMachineAudioTestEvidence();
  try {
    const volume = form.machineAudioVolumePercent / 100;
    const testEvidence = await daemonClient.testAudioOutput({
      endpointId: selected.endpointId,
      audioCueSettings: {
        enabled: form.audioCueSettings.enabled,
        categories: {
          presence: form.audioCueSettings.categories.presence,
          transaction: form.audioCueSettings.categories.transaction,
        },
      },
      machineAudioVolume: volume,
    });
    machineAudioOutputMaintenance.testEvidence = testEvidence;
    machineAudioTestPlayback.volume = volume;
    machineAudioTestPlayback.driver = "native";
    machineAudioTestPlayback.diagnostic = {
      requestId: testEvidence.testEvidenceToken,
      status: "started",
      driver: "native",
      sourceUrl: daemonAudioCalibrationSource,
      message: null,
      recordedAt: new Date().toISOString(),
    };
    machineAudioTestPlayback.message =
      "机器音频测试播放已启动，请确认实际听感。";
  } catch (error) {
    clearMachineAudioTestEvidence();
    machineAudioTestPlayback.message =
      error instanceof Error ? error.message : String(error);
  } finally {
    machineAudioTestPlayback.loading = false;
  }
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

async function runHardwareCheck(): Promise<void> {
  if (!maintenanceSessionAuthorized.value) return;
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
    clearMaintenanceSessionAfterAuthorizationFailure(error);
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
      refreshDeviceBindings(),
      ...(maintenanceSessionAuthorized.value
        ? [refreshPaymentEnvironmentDiagnostic()]
        : []),
    ]);
  } catch (error) {
    diagnostics.message =
      error instanceof Error ? error.message : String(error);
  } finally {
    diagnostics.loading = false;
  }
}

async function refreshPaymentEnvironmentDiagnostic(): Promise<void> {
  if (!maintenanceSessionAuthorized.value) return;
  paymentEnvironmentMessage.value = null;
  try {
    paymentEnvironmentDiagnostic.value =
      await daemonClient.getPaymentEnvironmentDiagnostic();
  } catch {
    paymentEnvironmentDiagnostic.value = null;
    paymentEnvironmentMessage.value = "支付环境诊断暂不可用";
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

async function clearWholeMachineLock(): Promise<void> {
  if (!maintenanceSessionAuthorized.value) return;
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
    clearMaintenanceSessionAfterAuthorizationFailure(error);
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

function blockerRecoveryLabel(code: string): string {
  if (
    code === "LOWER_CONTROLLER_UNAVAILABLE" ||
    code === "WHOLE_MACHINE_HARDWARE_FAULT" ||
    code.startsWith("PRODUCTION_DISPENSE_PATH_")
  ) {
    return "执行硬件自检";
  }
  if (code === "NO_SALEABLE_SLOTS") return "打开库存维护";
  if (code === "MACHINE_AUTH_MISSING") return "打开首次部署控制台";
  return "刷新关联诊断";
}

function blockerRecoveryRequiresSession(code: string): boolean {
  return (
    code === "MACHINE_AUTH_MISSING" ||
    code === "LOWER_CONTROLLER_UNAVAILABLE" ||
    code === "WHOLE_MACHINE_HARDWARE_FAULT" ||
    code.startsWith("PRODUCTION_DISPENSE_PATH_")
  );
}

function blockerRecoveryDisabled(code: string): boolean {
  return (
    (blockerRecoveryRequiresSession(code) &&
      !maintenanceSessionAuthorized.value) ||
    hardwareMaintenance.loading ||
    diagnostics.loading
  );
}

async function runBlockerRecovery(code: string): Promise<void> {
  if (code === "MACHINE_AUTH_MISSING") {
    await openProtectedBringUpConsole();
    return;
  }
  if (blockerRecoveryRequiresSession(code)) {
    await runHardwareCheck();
    return;
  }
  if (code === "NO_SALEABLE_SLOTS") {
    stockMaintenance.message = "请使用下方库存维护完成补货或盘点修正。";
    return;
  }
  await refreshDiagnostics();
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
  await submitMachineNavigationIntent({
    type: "operator.navigate",
    target: { name: "catalog" },
  });
}

async function returnToDesktop(): Promise<void> {
  const session = maintenanceSession.value;
  if (
    !showProtectedDesktopExit.value ||
    !session ||
    !maintenanceSessionAuthorized.value
  ) {
    return;
  }
  desktopMaintenance.loading = true;
  desktopMaintenance.message = "正在回到 Windows 桌面";
  try {
    if (!isTauriRuntime()) {
      desktopMaintenance.message = "当前不是 Tauri 运行环境，无法退出全屏应用";
      return;
    }
    await callTauriCommand<void>("return_to_desktop", {
      sessionId: session.sessionId,
    });
  } catch (error) {
    clearMaintenanceSessionAfterAuthorizationFailure(error);
    desktopMaintenance.message =
      error instanceof Error ? error.message : String(error);
    desktopMaintenance.loading = false;
  }
}

async function openProtectedBringUpConsole(): Promise<void> {
  if (!maintenanceSessionAuthorized.value) {
    return;
  }
  if (!daemonClient.handoffMaintenanceSessionToBringUp()) {
    clearMaintenanceSession();
    maintenanceAuthentication.message = "维护会话已失效，请重新验证 PIN。";
    return;
  }
  try {
    await submitMachineNavigationIntent({
      type: "operator.navigate",
      target: {
        path: "/bring-up",
        query: { source: "protected-maintenance" },
      },
    });
  } catch (error) {
    clearMaintenanceSession();
    maintenanceAuthentication.message =
      error instanceof Error ? error.message : "无法打开首次部署控制台";
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

function applyStockMaintenanceTask(task: StockMaintenanceTask): void {
  const values = Object.fromEntries(
    task.slots.map((slot) => [
      slot.slotCode,
      task.mode === "routine_refill"
        ? (slot.submittedAddition ?? 0)
        : (slot.submittedQuantity ?? slot.currentQuantity),
    ]),
  );
  stockMaintenance.task = task;
  stockMaintenance.values = values;
}

async function refreshStockMaintenanceView(): Promise<void> {
  stockMaintenance.loading = true;
  try {
    applyStockMaintenanceTask(await daemonClient.getStockMaintenanceTask());
  } catch (error) {
    stockMaintenance.message =
      error instanceof Error ? error.message : String(error);
  } finally {
    stockMaintenance.loading = false;
  }
}

function stockSyncLabel(status: string): string {
  return (
    {
      not_submitted: "未提交",
      pending: "同步中",
      failed: "等待重试",
      accepted: "已确认",
      rejected: "已拒绝",
      reconciliation: "待对账",
    }[status] ?? status
  );
}

function resultingStock(
  slot: StockMaintenanceTask["slots"][number],
): number | null {
  const value = stockMaintenance.values[slot.slotCode];
  if (!isValidStockInteger(value) || value > slot.capacity) return null;
  if (stockTaskIsRefill.value) {
    if (value === slot.submittedAddition && slot.previewQuantity !== null) {
      return slot.previewQuantity;
    }
    return slot.currentQuantity + value <= slot.capacity
      ? slot.currentQuantity + value
      : null;
  }
  return value;
}

async function submitStockMaintenanceTask(): Promise<void> {
  const task = stockMaintenance.task;
  if (!task) return;
  if (!stockTaskCanSubmit.value) {
    stockMaintenance.message = "库存数量必须是容量范围内的非负整数。";
    return;
  }
  stockMaintenance.loading = true;
  stockMaintenance.message = null;
  try {
    const response =
      task.mode === "routine_refill"
        ? await daemonClient.submitStockMaintenanceBatch({
            taskId: task.taskId,
            mode: "routine_refill",
            slots: task.slots
              .map((slot) => ({
                slotCode: slot.slotCode,
                addition: stockMaintenance.values[slot.slotCode] as number,
              }))
              .filter((slot) => slot.addition > 0),
          })
        : await daemonClient.submitStockMaintenanceBatch({
            taskId: task.taskId,
            mode: task.mode,
            slots: task.slots.map((slot) => ({
              slotCode: slot.slotCode,
              quantity: stockMaintenance.values[slot.slotCode] as number,
            })),
          });
    applyStockMaintenanceTask(response.task);
    stockMaintenance.message = response.duplicate
      ? "批次已存在，已恢复原同步状态。"
      : "库存批次已提交，等待平台逐货道确认。";
  } catch (error) {
    clearMaintenanceSessionAfterAuthorizationFailure(error);
    stockMaintenance.message =
      error instanceof Error
        ? `${error.message}；本机服务保留批次状态，可刷新后恢复。`
        : "库存批次提交结果未确认，可刷新后恢复。";
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

      <section
        class="mt-4 rounded-3xl border border-white/10 bg-slate-950/30 p-4"
      >
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div class="text-left">
            <p class="text-sm font-semibold text-slate-100">维护授权</p>
            <p class="mt-1 text-sm text-slate-300">
              健康与阻塞诊断始终可查看；修改机器前需验证 PIN。
            </p>
          </div>
          <span
            class="text-sm font-semibold"
            :class="
              maintenanceSessionAuthorized
                ? 'text-emerald-200'
                : 'text-amber-200'
            "
          >
            {{ maintenanceSessionAuthorized ? "已授权" : "只读" }}
          </span>
        </div>
        <form
          v-if="!maintenanceSessionAuthorized"
          class="mt-3 flex flex-wrap gap-3"
          @submit.prevent="beginProtectedMaintenance"
        >
          <input
            v-model="maintenanceAuthentication.pin"
            class="kiosk-touch-target min-w-40 rounded-2xl border border-white/10 bg-slate-950/70 px-4 py-3 text-white outline-none"
            type="password"
            inputmode="numeric"
            autocomplete="off"
            placeholder="维护 PIN"
            aria-label="维护 PIN"
          />
          <button
            class="kiosk-touch-target rounded-2xl bg-emerald-300 px-4 py-3 font-bold text-slate-950 disabled:opacity-50"
            type="submit"
            :disabled="
              maintenanceAuthentication.loading ||
              !maintenanceAuthentication.pin
            "
          >
            验证并解锁
          </button>
        </form>
        <p
          v-if="maintenanceAuthentication.message"
          class="mt-3 text-sm text-slate-200"
          aria-live="polite"
        >
          {{ maintenanceAuthentication.message }}
        </p>
      </section>

      <section
        v-if="maintenanceSessionAuthorized"
        class="mt-4 rounded-3xl border border-white/10 bg-slate-950/30 p-4 text-left"
        aria-label="支付环境诊断"
      >
        <div class="flex flex-wrap items-center justify-between gap-3">
          <p class="font-semibold text-white">支付环境</p>
          <span class="text-sm font-semibold text-sky-100">
            {{ paymentEnvironmentLabel }} ·
            {{ paymentEnvironmentReadinessLabel }}
          </span>
        </div>
        <p class="mt-1 text-sm text-slate-300">
          错误分类：{{ paymentEnvironmentErrorLabel }}
        </p>
        <p v-if="paymentEnvironmentMessage" class="mt-1 text-sm text-amber-100">
          {{ paymentEnvironmentMessage }}
        </p>
      </section>

      <section
        v-if="saleCriticalBlockers.length > 0"
        class="mt-4 grid gap-3"
        aria-label="当前阻塞项"
      >
        <h3 class="text-left text-sm font-semibold text-rose-100">
          当前阻塞项
        </h3>
        <article
          v-for="blocker in saleCriticalBlockers"
          :key="`${blocker.component}-${blocker.code}`"
          class="rounded-3xl border border-rose-300/30 bg-rose-500/15 p-4 text-left"
        >
          <p class="font-semibold text-rose-50">{{ blocker.operatorLabel }}</p>
          <p class="mt-1 text-sm text-rose-100/90">
            {{ blocker.operatorAction }}
          </p>
          <button
            class="kiosk-touch-target mt-3 rounded-2xl border border-rose-100/40 px-4 py-3 font-bold text-rose-50 disabled:opacity-50"
            type="button"
            :disabled="blockerRecoveryDisabled(blocker.code)"
            @click="runBlockerRecovery(blocker.code)"
          >
            {{
              blockerRecoveryRequiresSession(blocker.code) &&
              !maintenanceSessionAuthorized
                ? "先验证 PIN"
                : blockerRecoveryLabel(blocker.code)
            }}
          </button>
          <details class="mt-3 text-sm text-rose-100/80">
            <summary>技术证据</summary>
            <p class="mt-2">{{ blocker.code }} · {{ blocker.message }}</p>
          </details>
        </article>
      </section>

      <section
        v-if="operatorEnteredMaintenance"
        class="mt-4 grid gap-3 md:grid-cols-2"
        aria-label="维护任务概览"
      >
        <article
          class="rounded-3xl border border-white/10 bg-slate-950/30 p-4 text-left"
        >
          <p class="font-semibold text-white">健康与连接</p>
          <p class="mt-1 text-sm text-slate-300">
            查看本地服务、平台与 MQTT 状态。
          </p>
          <button
            class="kiosk-touch-target mt-3 rounded-2xl border border-sky-200/30 px-4 py-3 font-bold text-sky-100"
            type="button"
            :disabled="diagnostics.loading"
            @click="refreshDiagnostics"
          >
            刷新诊断
          </button>
          <details class="mt-3 text-sm text-slate-300">
            <summary>技术证据</summary>
            <p class="mt-2">
              {{ machineStore.health?.process.code ?? "未读取" }}
            </p>
          </details>
        </article>
        <article
          class="rounded-3xl border border-white/10 bg-slate-950/30 p-4 text-left"
        >
          <p class="font-semibold text-white">硬件与绑定</p>
          <p class="mt-1 text-sm text-slate-300">
            检查下位机、扫码器与视觉运行状态。
          </p>
          <button
            class="kiosk-touch-target mt-3 rounded-2xl border border-sky-200/30 px-4 py-3 font-bold text-sky-100 disabled:opacity-50"
            type="button"
            :disabled="
              !maintenanceSessionAuthorized || hardwareMaintenance.loading
            "
            @click="runHardwareCheck"
          >
            执行设备检查
          </button>
          <details class="mt-3 text-sm text-slate-300">
            <summary>技术证据</summary>
            <p class="mt-2">
              {{
                machineStore.health?.hardwareOnline
                  ? "下位机在线"
                  : "下位机不可用"
              }}
            </p>
          </details>
        </article>
      </section>

      <section
        v-if="operatorEnteredMaintenance && deviceBindingMaintenance.snapshot"
        class="mt-4 grid gap-3"
        aria-label="设备稳定身份绑定"
      >
        <article
          v-for="role in deviceBindingMaintenance.snapshot.roles"
          :key="role.role"
          class="rounded-3xl border border-white/10 bg-slate-950/30 p-4 text-left"
          :data-test="`device-binding-${role.role}`"
        >
          <div class="flex items-center justify-between gap-3">
            <p class="font-semibold text-white">
              {{
                role.role === "lower_controller" ? "下位机绑定" : "扫码器绑定"
              }}
            </p>
            <span :class="role.ready ? 'text-emerald-200' : 'text-amber-200'">
              {{ role.ready ? `已就绪 · ${role.currentPort}` : "待处理" }}
            </span>
          </div>
          <p v-if="!role.ready" class="mt-2 text-sm text-amber-100">
            {{ operatorMessageLabel(role.message) }}
          </p>
          <div
            v-if="role.ambiguityKind === 'duplicate_observation'"
            class="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-200/20 bg-amber-500/10 p-3"
          >
            <p class="text-sm font-semibold text-amber-100">
              检测到重复设备。请拔除重复设备后刷新，再进行测试和绑定。
            </p>
            <button
              class="kiosk-touch-target rounded-xl border border-amber-200/30 px-3 py-2 font-bold text-amber-100 disabled:opacity-40"
              type="button"
              :disabled="deviceBindingMaintenance.loading"
              @click="refreshDeviceBindings"
            >
              刷新设备
            </button>
          </div>
          <div v-else class="mt-3 grid gap-2">
            <div
              v-for="(candidate, candidateIndex) in role.candidates"
              :key="`${candidate.identity.identityKey}:${candidate.currentPort}:${candidateIndex}`"
              class="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-white/10 p-3"
            >
              <div>
                <p class="font-semibold text-slate-100">
                  {{ candidate.friendlyName ?? "串口设备" }} ·
                  {{ candidate.currentPort }}
                </p>
                <p class="mt-1 text-xs text-slate-400">
                  {{ candidate.identity.identityKey }}
                </p>
              </div>
              <div class="flex gap-2">
                <button
                  class="kiosk-touch-target rounded-xl border border-sky-200/30 px-3 py-2 font-bold text-sky-100 disabled:opacity-40"
                  type="button"
                  :disabled="
                    !maintenanceSessionAuthorized ||
                    deviceBindingMaintenance.loading
                  "
                  @click="
                    testDeviceBinding(role.role, candidate.identity.identityKey)
                  "
                >
                  测试
                </button>
                <button
                  class="kiosk-touch-target rounded-xl bg-emerald-300 px-3 py-2 font-bold text-slate-950 disabled:opacity-40"
                  type="button"
                  :disabled="
                    !maintenanceSessionAuthorized ||
                    deviceBindingMaintenance.loading ||
                    deviceBindingMaintenance.tested[role.role]?.identityKey !==
                      candidate.identity.identityKey
                  "
                  @click="
                    confirmDeviceBinding(
                      role.role,
                      candidate.identity.identityKey,
                    )
                  "
                >
                  确认绑定
                </button>
              </div>
            </div>
          </div>
          <p
            v-for="(diagnostic, diagnosticIndex) in role.discoveryDiagnostics"
            :key="`${diagnostic.currentPort}:${diagnostic.code}:${diagnosticIndex}`"
            class="mt-2 rounded-2xl border border-amber-200/20 p-3 text-sm text-amber-100"
          >
            {{ diagnostic.friendlyName ?? "串口设备" }} ·
            {{ diagnostic.currentPort }}：
            {{ operatorMessageLabel(diagnostic.message) }}
          </p>
          <details
            v-if="role.binding || role.legacyPortHint"
            class="mt-3 text-sm text-slate-300"
          >
            <summary>技术证据</summary>
            <p v-if="role.binding" class="mt-2 break-all">
              {{ role.binding.identity.identityKey }}
            </p>
            <p v-if="role.legacyPortHint" class="mt-1">
              迁移提示：{{ role.legacyPortHint }}（不作为绑定）
            </p>
          </details>
        </article>
        <p
          v-if="deviceBindingMaintenance.message"
          class="rounded-2xl bg-sky-500/15 p-3 text-sky-100"
        >
          {{ deviceBindingMaintenance.message }}
        </p>
      </section>

      <section
        v-if="operatorEnteredMaintenance"
        class="mt-6 rounded-3xl border border-amber-200/20 bg-amber-500/10 p-5"
        data-test="manual-dispense-diagnostic"
      >
        <div class="flex flex-wrap items-center justify-between gap-3">
          <p class="font-semibold text-amber-100">手动出货诊断</p>
          <div class="flex items-center gap-3 text-sm text-amber-100">
            <span>执行后必须核对库存</span>
            <button
              class="kiosk-touch-target rounded-xl border border-amber-100/30 px-3 py-2"
              type="button"
              :disabled="manualDispenseDiagnostic.loading"
              @click="startNewManualDispenseDiagnostic"
            >
              新建诊断
            </button>
          </div>
        </div>
        <form
          class="mt-4 grid gap-3 md:grid-cols-4"
          @submit.prevent="runManualDispenseDiagnostic"
        >
          <label class="grid gap-1 text-left text-sm text-slate-200">
            货道
            <input
              v-model.trim="manualDispenseDiagnostic.slotCode"
              class="rounded-xl bg-slate-950/60 p-3"
              maxlength="32"
              required
            />
          </label>
          <label class="grid gap-1 text-left text-sm text-slate-200">
            层
            <input
              v-model.number="manualDispenseDiagnostic.layerNo"
              class="rounded-xl bg-slate-950/60 p-3"
              type="number"
              min="1"
              max="255"
              required
            />
          </label>
          <label class="grid gap-1 text-left text-sm text-slate-200">
            格
            <input
              v-model.number="manualDispenseDiagnostic.cellNo"
              class="rounded-xl bg-slate-950/60 p-3"
              type="number"
              min="1"
              max="255"
              required
            />
          </label>
          <button
            class="kiosk-touch-target self-end rounded-xl bg-amber-200 px-4 py-3 font-bold text-slate-950 disabled:opacity-40"
            type="submit"
            :disabled="
              !maintenanceSessionAuthorized || manualDispenseDiagnostic.loading
            "
          >
            {{ manualDispenseDiagnostic.loading ? "执行中" : "出货一件" }}
          </button>
        </form>
        <p
          v-if="manualDispenseDiagnostic.message"
          class="mt-3 text-sm text-amber-100"
        >
          {{ manualDispenseDiagnostic.message }}
        </p>
      </section>

      <VisionCameraMaintenancePanel
        v-if="operatorEnteredMaintenance"
        :maintenance-authorized="maintenanceSessionAuthorized"
        mode="maintenance"
      />

      <div class="mt-6 rounded-3xl border border-white/10 bg-slate-950/30 p-5">
        <p
          class="text-sm font-semibold tracking-[0.28em] text-emerald-200 uppercase"
        >
          库存维护
        </p>
        <form
          class="mt-4 grid gap-4"
          @submit.prevent="submitStockMaintenanceTask"
        >
          <fieldset :disabled="!maintenanceSessionAuthorized" class="contents">
            <div class="grid gap-3">
              <article
                v-for="slot in stockMaintenance.task?.slots ?? []"
                :key="slot.slotCode"
                class="grid gap-3 rounded-2xl border border-white/10 bg-slate-950/40 p-4 text-left md:grid-cols-[1fr_11rem]"
              >
                <div>
                  <p class="font-semibold text-white">
                    {{ slot.slotCode }} ·
                    {{ formatMachineSlotCoordinate(slot) }}
                  </p>
                  <p class="text-sm text-slate-200">
                    {{ slot.productName }} · {{ slot.sku }}
                  </p>
                  <p class="text-sm text-slate-400">
                    {{ slot.currentQuantity }}/{{ slot.capacity }} ·
                    {{ stockSyncLabel(slot.syncStatus) }}
                  </p>
                  <p
                    v-if="slot.reconciliationReason"
                    class="mt-1 text-sm text-amber-200"
                  >
                    仅此货道待对账：{{ slot.reconciliationReason }}
                  </p>
                </div>
                <label class="grid gap-2">
                  <span class="text-sm font-semibold text-slate-200">
                    {{ stockTaskIsRefill ? "补货数量" : "实际数量" }}
                  </span>
                  <input
                    v-model.number="stockMaintenance.values[slot.slotCode]"
                    class="kiosk-touch-target rounded-2xl border border-white/10 bg-slate-950/70 px-4 text-white outline-none focus:border-emerald-300"
                    :max="
                      stockTaskIsRefill
                        ? (slot.submittedAddition ??
                          slot.capacity - slot.currentQuantity)
                        : slot.capacity
                    "
                    :disabled="
                      stockTaskIsRefill && slot.submittedAddition !== null
                    "
                    min="0"
                    step="1"
                    type="number"
                  />
                  <span class="text-xs text-emerald-200">
                    {{ stockTaskIsRefill ? "补货后" : "提交后" }}
                    {{ resultingStock(slot) ?? "输入无效" }}/{{ slot.capacity }}
                  </span>
                </label>
              </article>
            </div>
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
                  !maintenanceSessionAuthorized ||
                  stockMaintenance.loading ||
                  !stockTaskCanSubmit
                "
              >
                {{ stockTaskIsRefill ? "确认补货" : "提交盘点" }}
              </button>
            </div>
          </fieldset>
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
              v-if="showProtectedDesktopExit && maintenanceSessionAuthorized"
              class="kiosk-touch-target rounded-2xl border border-slate-200/30 px-4 py-3 font-bold text-slate-100 disabled:opacity-50"
              type="button"
              :disabled="desktopMaintenance.loading"
              @click="returnToDesktop"
            >
              回到 Windows 桌面
            </button>
            <button
              v-if="showAdvancedDebugConfig"
              class="kiosk-touch-target rounded-2xl border border-amber-200/30 px-4 py-3 font-bold text-amber-100 disabled:opacity-50"
              type="button"
              :disabled="!maintenanceSessionAuthorized"
              @click="openProtectedBringUpConsole"
            >
              {{
                maintenanceSessionAuthorized ? "首次部署控制台" : "先验证 PIN"
              }}
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
              :disabled="
                !maintenanceSessionAuthorized || hardwareMaintenance.loading
              "
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
              {{ stockMaintenance.task?.status ?? "未读取" }} ·
              {{ stockMaintenance.task?.slots.length ?? 0 }} 个货道
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

        <section
          class="mt-5 border-t border-white/10 pt-4 text-left"
          data-test="catalog-operator-diagnostics"
        >
          <h3 class="text-sm font-semibold text-slate-200">
            目录媒体与分类诊断
          </h3>
          <p
            v-if="catalogOperatorDiagnostics.length === 0"
            class="mt-2 text-sm text-slate-300"
          >
            尚未记录目录诊断。
          </p>
          <ul v-else class="mt-2 grid gap-2 text-sm text-slate-100">
            <li
              v-for="diagnostic in catalogOperatorDiagnostics"
              :key="`${diagnostic.kind}-${diagnostic.reference}-${diagnostic.message}`"
            >
              {{ diagnostic.kind }} · {{ diagnostic.message }}
              <span class="text-slate-300">{{
                diagnostic.reference ?? "无引用"
              }}</span>
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

        <section class="mt-5 border-t border-white/10 pt-4 text-left">
          <h3 class="text-sm font-semibold text-slate-200">顾客扬声器绑定</h3>
          <dl class="mt-3 grid gap-3 md:grid-cols-2">
            <div
              v-for="row in machineAudioOutputBindingRows"
              :key="row.label"
              class="rounded-xl bg-slate-950/35 p-3"
            >
              <dt class="text-xs font-semibold text-slate-400">
                {{ row.label }}
              </dt>
              <dd class="mt-1 font-bold break-all text-white">
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

        <section
          v-if="effectiveRuntimeConfigurationRows.length > 0"
          class="mt-5 border-t border-white/10 pt-4 text-left"
          data-test="effective-runtime-configuration"
        >
          <h3 class="text-sm font-semibold text-slate-200">运行时配置</h3>
          <dl class="mt-3 grid gap-3 md:grid-cols-2">
            <div
              v-for="row in effectiveRuntimeConfigurationRows"
              :key="row.label"
              class="rounded-xl bg-slate-950/35 p-3"
            >
              <dt class="text-xs font-semibold text-slate-400">{{ row.label }}</dt>
              <dd class="mt-1 font-bold text-white">{{ row.value }}</dd>
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

      <section v-if="showAdvancedDebugConfig" class="mt-8 grid gap-5">
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

        <p class="rounded-2xl bg-slate-950/40 p-3 text-sm text-slate-300">
          维护 PIN 验证器状态：
          <span class="font-semibold text-emerald-200">
            {{
              machineStore.config.maintenancePinConfigured ? "已配置" : "未配置"
            }}
          </span>
          <span class="ml-2 text-slate-400"
            >仅显示是否已受保护预置，不显示 PIN。</span
          >
        </p>

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
              >旧 COM 迁移提示（只读）</span
            >
            <input
              v-model="form.serialPortPath"
              disabled
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
                disabled
                class="kiosk-touch-target rounded-2xl border border-white/10 bg-slate-950/70 px-4 text-white outline-none focus:border-sky-300"
                maxlength="4"
              />
            </label>
            <label class="grid gap-2 text-left">
              <span class="text-sm font-semibold text-slate-200">USB PID</span>
              <input
                v-model="form.lowerControllerUsbIdentity.productId"
                disabled
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
                disabled
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
                >旧扫码 COM 迁移提示（只读）</span
              >
              <input
                v-model="form.scannerSerialPortPath"
                disabled
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

            <section
              class="grid gap-4 rounded-2xl border border-cyan-200/20 bg-cyan-500/10 p-4 text-left"
            >
              <div class="flex flex-wrap items-center justify-between gap-3">
                <div class="grid gap-1">
                  <h3 class="text-base font-bold text-cyan-100">
                    顾客扬声器绑定
                  </h3>
                  <p class="text-sm leading-6 text-cyan-50/85">
                    选择稳定的 WASAPI
                    输出端点，测试播放并在听到近场顾客扬声器后确认保存。
                  </p>
                </div>
                <button
                  class="kiosk-touch-target rounded-2xl border border-cyan-100/40 px-4 py-3 font-bold text-cyan-50 disabled:opacity-50"
                  type="button"
                  :disabled="machineAudioOutputMaintenance.loading"
                  @click="refreshMachineAudioOutputs"
                >
                  刷新端点
                </button>
              </div>

              <div
                v-if="machineAudioOutputCandidates.length === 0"
                class="rounded-2xl bg-slate-950/35 p-4 text-sm text-cyan-50"
              >
                {{
                  machineAudioOutputMaintenance.loading
                    ? "正在枚举音频端点…"
                    : "尚未发现可用输出端点。"
                }}
              </div>

              <div v-else class="grid gap-3">
                <label
                  v-for="candidate in machineAudioOutputCandidates"
                  :key="candidate.endpointId"
                  class="flex items-start gap-3 rounded-2xl border border-white/10 bg-slate-950/35 p-4"
                >
                  <input
                    v-model="machineAudioOutputMaintenance.selectedEndpointId"
                    :value="candidate.endpointId"
                    class="mt-1 size-5 accent-cyan-300"
                    type="radio"
                  />
                  <span class="grid gap-1">
                    <span class="text-sm font-semibold text-white">
                      {{ candidate.friendlyName }}
                      <span v-if="candidate.isDefault" class="text-cyan-100/80">
                        · 默认
                      </span>
                    </span>
                    <span class="text-xs break-all text-cyan-50/80">
                      {{ candidate.endpointId }}
                    </span>
                  </span>
                </label>
              </div>

              <label class="flex items-center gap-3 text-left">
                <input
                  v-model="machineAudioOutputMaintenance.heardConfirmation"
                  :disabled="!machineAudioOutputMaintenance.testEvidence"
                  class="size-5 accent-cyan-300"
                  type="checkbox"
                />
                <span class="text-sm font-semibold text-cyan-50">
                  我已经在近场顾客扬声器上听到了测试音频
                </span>
              </label>

              <button
                class="kiosk-touch-target rounded-2xl bg-cyan-300 px-4 py-3 font-bold text-slate-950 disabled:opacity-50"
                type="button"
                :disabled="
                  machineAudioOutputMaintenance.saving ||
                  !machineAudioOutputMaintenance.selectedEndpointId ||
                  !machineAudioOutputMaintenance.testEvidence ||
                  !machineAudioOutputMaintenance.heardConfirmation
                "
                @click="saveMachineAudioSettings"
              >
                保存顾客扬声器绑定与音频提示设置
              </button>

              <p
                v-if="machineAudioOutputMaintenance.message"
                class="rounded-2xl bg-cyan-950/40 p-3 text-sm text-cyan-50"
              >
                {{ machineAudioOutputMaintenance.message }}
              </p>
            </section>

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
                  :disabled="
                    machineAudioTestPlayback.loading ||
                    !maintenanceSessionAuthorized ||
                    !machineAudioOutputMaintenance.selectedEndpointId
                  "
                  @click="playMachineAudioTestPlayback"
                >
                  播放测试音频
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
                :disabled="
                  !maintenanceSessionAuthorized || hardwareMaintenance.loading
                "
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
          class="kiosk-touch-target rounded-2xl bg-slate-600 px-6 py-4 text-lg font-bold text-slate-200"
          type="button"
          disabled
        >
          直接配置编辑已禁用；请使用首次部署控制台
        </button>

        <p
          v-if="machineStore.error"
          class="rounded-2xl bg-rose-500/20 p-4 text-rose-100"
        >
          {{ machineStore.error }}
        </p>
      </section>
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
