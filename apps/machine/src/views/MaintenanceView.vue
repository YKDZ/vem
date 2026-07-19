<script setup lang="ts">
import {
  formatMachineSlotCoordinate,
  type EffectiveMachineRuntimeConfiguration,
  type PaymentProviderEnvironmentDiagnostic,
  type StockMaintenanceTask,
} from "@vem/shared";
import { getActivePinia, type Pinia } from "pinia";
import { computed, onMounted, onUnmounted, reactive, ref } from "vue";

import { maintenanceTestToneUrl } from "@/assets/audio/maintenance-test-tone";
import KioskHeader from "@/components/KioskHeader.vue";
import VisionCameraMaintenancePanel from "@/components/VisionCameraMaintenancePanel.vue";
import { recoverPersistedClaim } from "@/daemon/claim-recovery";
import { daemonClient, isDaemonTransportFailure } from "@/daemon/client";
import { WHOLE_MACHINE_LOCKED_BLOCKER_CODE } from "@/daemon/schemas";
import { installMaintenanceSystemTouchKeyboard } from "@/native/system-touch-keyboard";
import {
  openVisionTryOnSession,
  type VisionTryOnSession,
} from "@/native/vision";
import { submitMachineNavigationIntent } from "@/router/transaction-route-authority";
import { requestMachineAudioTestPlayback } from "@/runtime/machine-runtime";
import { useCatalogStore } from "@/stores/catalog";
import { useConnectivityStore } from "@/stores/connectivity";
import { useMachineStore } from "@/stores/machine";
import { useMqttStore } from "@/stores/mqtt";
import { useNaturalContextStore } from "@/stores/natural-context";
import { useRemoteOpsStore } from "@/stores/remote-ops";
import { useSaleCapabilityStore } from "@/stores/sale-capability";
import { useScannerStore } from "@/stores/scanner";
import { useVisionStore } from "@/stores/vision";

const catalogStore = useCatalogStore();
const connectivityStore = useConnectivityStore();
const machineStore = useMachineStore();
const mqttStore = useMqttStore();
const naturalContextStore = useNaturalContextStore();
const remoteOpsStore = useRemoteOpsStore();
const saleCapabilityStore = useSaleCapabilityStore();
const scannerStore = useScannerStore();
const visionStore = useVisionStore();
const activePinia = getActivePinia();
if (!activePinia) {
  throw new Error("Local Operations requires an active Pinia instance");
}
const pinia: Pinia = activePinia;
type MaintenanceTask =
  | "status"
  | "commissioning"
  | "hardware"
  | "stock"
  | "experience"
  | "diagnostics";
const activeTask = ref<MaintenanceTask>("status");
const maintenanceRoot = ref<HTMLElement | null>(null);
let removeSystemTouchKeyboard: (() => void) | null = null;
const operatorAttention = reactive({
  summary: null as string | null,
  technicalEvidence: null as string | null,
  task: null as MaintenanceTask | null,
});

function clearOperatorAttention(task?: MaintenanceTask): void {
  if (task && operatorAttention.task !== task) return;
  operatorAttention.summary = null;
  operatorAttention.technicalEvidence = null;
  operatorAttention.task = null;
}

function reportOperatorAttention(
  summary: string,
  error?: unknown,
  task: MaintenanceTask = activeTask.value,
): void {
  operatorAttention.summary = summary;
  operatorAttention.technicalEvidence =
    error instanceof Error ? error.message : error ? String(error) : null;
  operatorAttention.task = task;
}

function operatorErrorMessage(
  summary: string,
  error: unknown,
  task?: MaintenanceTask,
): string {
  reportOperatorAttention(summary, error, task);
  return summary;
}

function selectMaintenanceTask(task: MaintenanceTask): void {
  clearOperatorAttention();
  activeTask.value = task;
}
const maintenanceTasks = computed(() => [
  {
    key: "status" as const,
    label: "运行状态",
    value: saleCapabilityStore.canStartSale ? "可以销售" : "需要处理",
  },
  {
    key: "commissioning" as const,
    label: "网络与认领",
    value: hasAcceptedProvisioningProfile.value ? "已完成" : "待配置",
  },
  {
    key: "hardware" as const,
    label: "设备检查",
    value:
      machineStore.health?.hardwareOnline && scannerStore.online
        ? "设备正常"
        : "检查设备",
  },
  {
    key: "stock" as const,
    label: "库存维护",
    value: `${stockMaintenance.task?.slots.length ?? 0} 个货道`,
  },
  {
    key: "experience" as const,
    label: "声音与视觉",
    value: visionStore.online ? "运行中" : "检查视觉",
  },
  {
    key: "diagnostics" as const,
    label: "诊断工具",
    value: diagnostics.loading ? "刷新中" : "可用",
  },
]);
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
const MAINTENANCE_DIAGNOSTIC_REFRESH_MS = 5000;
const DIAGNOSTIC_DISPLAY_MAX_CHARS = 12_000;
const DIAGNOSTIC_DISPLAY_MAX_DEPTH = 8;
const DIAGNOSTIC_DISPLAY_MAX_OBJECT_ENTRIES = 80;
const DIAGNOSTIC_DISPLAY_MAX_ARRAY_ITEMS = 40;
const DIAGNOSTIC_DISPLAY_MAX_STRING_CHARS = 1000;
let diagnosticsRefreshTimer: number | null = null;
let diagnosticsRefreshInFlight: Promise<void> | null = null;
const wholeMachineMaintenanceLock = computed(
  () =>
    saleCapabilityStore.accepted?.blockers.find(
      (reason) => reason.code === WHOLE_MACHINE_LOCKED_BLOCKER_CODE,
    ) ?? null,
);
const saleCriticalBlockers = computed(() =>
  (saleCapabilityStore.accepted?.blockers ?? [])
    .filter((reason) => reason.code !== WHOLE_MACHINE_LOCKED_BLOCKER_CODE)
    .map((reason) => ({
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
const clearWholeMachineLockDisabled = computed(
  () =>
    wholeMachineLockMaintenance.loading ||
    !wholeMachineMaintenanceLock.value ||
    !wholeMachineLockMaintenance.selfCheckEvidence?.online ||
    wholeMachineLockMaintenance.operatorNote.trim().length === 0,
);
const returnToCatalogBlockedReason = computed(() => {
  return hasAcceptedProvisioningProfile.value
    ? null
    : "机器尚未接受有效的配置档案。";
});
const hasAcceptedProvisioningProfile = computed(() => {
  const configuration = machineStore.effectiveRuntimeConfiguration;
  return Boolean(
    configuration?.sourceDocuments.profileCache && configuration.machine,
  );
});

const commissioning = reactive({
  ssid: "",
  password: "",
  hidden: false,
  loading: false,
  message: null as string | null,
  wifiNetworks: [] as string[],
  claimCode: "",
  claiming: false,
});

const audioPreferenceMutation = reactive({
  saving: false,
  message: null as string | null,
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

async function reloadEffectiveRuntimeConfiguration(): Promise<void> {
  await machineStore.loadEffectiveRuntimeConfiguration();
}

async function loadWifiNetworks(): Promise<void> {
  commissioning.wifiNetworks = [];
  try {
    commissioning.wifiNetworks = (
      await daemonClient.scanWifiNetworks()
    ).networks.map((network) => network.ssid);
  } catch (error) {
    commissioning.message = operatorErrorMessage(
      "无法读取可用网络，请检查网络适配器后重试。",
      error,
    );
  }
}

async function submitNetworkSettings(): Promise<void> {
  if (!commissioning.ssid.trim() || commissioning.loading) return;
  commissioning.loading = true;
  commissioning.message = null;
  try {
    const result = await daemonClient.applyNetworkSettings({
      ssid: commissioning.ssid.trim(),
      password: commissioning.password,
      hidden: commissioning.hidden,
    });
    commissioning.password = "";
    commissioning.message = result.operatorGuidance;
    await reloadEffectiveRuntimeConfiguration();
  } catch (error) {
    commissioning.message = operatorErrorMessage(
      "网络设置未完成，请检查网络信息后重试。",
      error,
    );
  } finally {
    commissioning.loading = false;
  }
}

async function submitClaim(): Promise<void> {
  if (!commissioning.claimCode.trim() || commissioning.claiming) return;
  commissioning.claiming = true;
  commissioning.message = null;
  let claimedMachineCode: string | null = null;
  try {
    const claim = await daemonClient.claimMachine(commissioning.claimCode);
    claimedMachineCode = claim.machineCode;
    const configuration = await recoverPersistedClaim(
      daemonClient,
      claimedMachineCode,
    );
    if (!configuration) {
      throw new Error("认领已提交，但 daemon 未在限定时间内恢复运行状态。");
    }
    applyRecoveredClaim(configuration);
  } catch (error) {
    if (!isDaemonTransportFailure(error)) {
      commissioning.message = operatorErrorMessage(
        "机器认领未完成，请核对认领码和网络后重试。",
        error,
      );
      return;
    }
    const configuration = await recoverPersistedClaim(
      daemonClient,
      claimedMachineCode,
    );
    if (configuration) {
      applyRecoveredClaim(configuration);
    } else {
      commissioning.message = operatorErrorMessage(
        "机器认领结果尚未恢复，请稍候刷新运行状态。",
        error,
      );
    }
  } finally {
    commissioning.claiming = false;
  }
}

function applyRecoveredClaim(
  configuration: EffectiveMachineRuntimeConfiguration,
): void {
  commissioning.claimCode = "";
  machineStore.applyEffectiveRuntimeConfiguration(configuration);
  void refreshDiagnostics();
  commissioning.message = "机器认领已接受，正在读取当前运行状态。";
}

function isOperatorEnteredMaintenance(): boolean {
  if (typeof window === "undefined") return false;
  const query = window.location.hash.split("?", 2)[1] ?? "";
  return new URLSearchParams(query).get("source") === "operator";
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
  if (maintenanceRoot.value) {
    removeSystemTouchKeyboard = installMaintenanceSystemTouchKeyboard(
      maintenanceRoot.value,
      {
        reportFailure(command, error) {
          reportOperatorAttention(
            command === "show_system_touch_keyboard"
              ? "无法打开 Windows 系统触摸键盘，请检查 Windows 输入服务或改用实体键盘。"
              : "无法收起 Windows 系统触摸键盘，请检查 Windows 输入服务。",
            error,
          );
        },
      },
    );
  }
  try {
    await reloadEffectiveRuntimeConfiguration();
  } catch {
    // Runtime diagnostics remain available when the configuration projection is unavailable.
  }
  await Promise.allSettled([
    refreshStockMaintenanceView(),
    refreshDiagnostics(),
  ]);
  if (!isOperatorEnteredMaintenance() && hasAcceptedProvisioningProfile.value) {
    await submitMachineNavigationIntent({
      type: "readiness.navigate",
      target: { name: "catalog" },
    });
    return;
  }
  startDiagnosticsAutoRefresh();
});

onUnmounted(() => {
  maintenanceViewMounted = false;
  removeSystemTouchKeyboard?.();
  removeSystemTouchKeyboard = null;
  stopDiagnosticsAutoRefresh();
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
    manualDispenseDiagnostic.message = operatorErrorMessage(
      "诊断出货未完成，请核实实物和库存后重试。",
      error,
    );
  } finally {
    manualDispenseDiagnostic.loading = false;
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

const machineAudioTestPlayback = reactive({
  loading: false,
  message: null as string | null,
  requestId: null as string | null,
  volume: machineStore.customerAudio.volume,
});

type AudioPreferencePatch = Partial<
  EffectiveMachineRuntimeConfiguration["experience"]["audio"]
>;

async function updateAudioPreferences(
  patch: AudioPreferencePatch,
): Promise<void> {
  if (audioPreferenceMutation.saving) return;
  audioPreferenceMutation.saving = true;
  audioPreferenceMutation.message = null;
  try {
    await daemonClient.setAudioPreferences({
      ...machineStore.customerAudio,
      ...patch,
    });
    await reloadEffectiveRuntimeConfiguration();
    audioPreferenceMutation.message = "顾客音频偏好已保存。";
  } catch (error) {
    audioPreferenceMutation.message = operatorErrorMessage(
      "顾客音频偏好未保存，请稍后重试。",
      error,
    );
  } finally {
    audioPreferenceMutation.saving = false;
  }
}

function checkedInputValue(event: Event): boolean {
  return event.target instanceof HTMLInputElement && event.target.checked;
}

function audioVolumeFromInput(event: Event): number {
  if (!(event.target instanceof HTMLInputElement)) {
    return machineStore.customerAudio.volume;
  }
  const percent = Number(event.target.value);
  if (!Number.isFinite(percent)) return machineStore.customerAudio.volume;
  return Math.min(100, Math.max(0, percent)) / 100;
}

const latestMachineAudioTestPlaybackRows = computed(() => {
  return [
    {
      label: "播放请求",
      value: machineAudioTestPlayback.requestId ?? "尚未提交",
    },
    {
      label: "播放驱动",
      value: "机器音频协调器",
    },
    {
      label: "播放音量",
      value: `${machineAudioVolumePercent(machineAudioTestPlayback.volume)}%`,
    },
    {
      label: "输出路径",
      value: "系统当前默认扬声器",
    },
  ];
});

async function playMachineAudioTestPlayback(): Promise<void> {
  machineAudioTestPlayback.loading = true;
  machineAudioTestPlayback.message = null;
  try {
    const volume = machineStore.customerAudio.volume;
    machineAudioTestPlayback.volume = volume;
    const requestId = await requestMachineAudioTestPlayback(
      pinia,
      maintenanceTestToneUrl,
      volume,
    );
    if (!requestId) throw new Error("机器音频协调器未接受测试播放请求");
    machineAudioTestPlayback.requestId = requestId;
    machineAudioTestPlayback.message = "测试播放已提交，等待播放结果。";
  } catch (error) {
    machineAudioTestPlayback.message = operatorErrorMessage(
      "测试播放未提交，请检查默认扬声器后重试。",
      error,
    );
  } finally {
    machineAudioTestPlayback.loading = false;
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
      tryOnPreviewDiagnostic.message = operatorErrorMessage(
        "试衣预览未能释放，请检查视觉服务。",
        error,
      );
    }
  }
}

async function startTryOnPreviewDiagnostic(): Promise<void> {
  if (tryOnPreviewDiagnostic.loading) return;
  await stopTryOnPreviewDiagnostic();
  tryOnPreviewDiagnosticSequence += 1;
  const sequence = tryOnPreviewDiagnosticSequence;
  tryOnPreviewDiagnostic.loading = true;
  tryOnPreviewDiagnostic.message = null;
  try {
    const session = await openVisionTryOnSession({
      machineCode: machineStore.machineCode,
    });
    if (
      !maintenanceViewMounted ||
      sequence !== tryOnPreviewDiagnosticSequence
    ) {
      await session.stop("replaced");
      return;
    }
    tryOnPreviewDiagnosticSession = session;
    tryOnPreviewDiagnostic.previewUrl = session.previewUrl;
    tryOnPreviewDiagnostic.sessionId = session.sessionId;
    tryOnPreviewDiagnostic.streamType = session.streamType;
    tryOnPreviewDiagnostic.message = "试衣预览诊断已启动。";
  } catch (error) {
    if (maintenanceViewMounted && sequence === tryOnPreviewDiagnosticSequence) {
      tryOnPreviewDiagnostic.message = operatorErrorMessage(
        "试衣预览未能启动，请检查视觉服务。",
        error,
      );
    }
  } finally {
    if (sequence === tryOnPreviewDiagnosticSequence) {
      tryOnPreviewDiagnostic.loading = false;
    }
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
    if (result.configUpdated) await reloadEffectiveRuntimeConfiguration();
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
    clearOperatorAttention("hardware");
  } catch (error) {
    hardwareMaintenance.message = operatorErrorMessage(
      "硬件检查未完成，请检查下位机连接后重试。",
      error,
      "hardware",
    );
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
    visionMaintenance.message = operatorErrorMessage(
      "视觉状态未刷新，请检查视觉服务后重试。",
      error,
    );
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
      refreshPaymentEnvironmentDiagnostic(),
    ]);
  } catch (error) {
    diagnostics.message = operatorErrorMessage(
      "运行状态未刷新，请检查本机运行服务后重试。",
      error,
    );
  } finally {
    diagnostics.loading = false;
  }
}

async function refreshPaymentEnvironmentDiagnostic(): Promise<void> {
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
      ? operatorErrorMessage(
          "下位机仍处于故障状态，不能解除整机锁。请先按现场复位键并确认下位机恢复在线，再点击解除。",
          error,
        )
      : operatorErrorMessage("整机维护锁未解除，请检查处理记录后重试。", error);
  } finally {
    wholeMachineLockMaintenance.loading = false;
  }
}

function saleCriticalBlockerLabel(code: string): string {
  const labels: Record<string, string> = {
    LOWER_CONTROLLER_UNAVAILABLE: "下位机未在线",
    [WHOLE_MACHINE_LOCKED_BLOCKER_CODE]: "整机维护锁",
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
    [WHOLE_MACHINE_LOCKED_BLOCKER_CODE]:
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
    code === WHOLE_MACHINE_LOCKED_BLOCKER_CODE ||
    code.startsWith("PRODUCTION_DISPENSE_PATH_")
  ) {
    return "执行硬件自检";
  }
  if (code === "NO_SALEABLE_SLOTS") return "打开库存维护";
  if (code === "MACHINE_AUTH_MISSING") return "完成机器认领";
  return "刷新关联诊断";
}

function blockerRecoveryDisabled(): boolean {
  return hardwareMaintenance.loading;
}

async function runBlockerRecovery(code: string): Promise<void> {
  if (code === "MACHINE_AUTH_MISSING") {
    activeTask.value = "commissioning";
    commissioning.message = "请在本页完成网络设置和机器认领。";
    return;
  }
  if (
    code === "LOWER_CONTROLLER_UNAVAILABLE" ||
    code === WHOLE_MACHINE_LOCKED_BLOCKER_CODE ||
    code.startsWith("PRODUCTION_DISPENSE_PATH_")
  ) {
    await runHardwareCheck();
    return;
  }
  if (code === "NO_SALEABLE_SLOTS") {
    activeTask.value = "stock";
    stockMaintenance.message = "请使用下方库存维护完成补货或盘点修正。";
    return;
  }
  await refreshDiagnostics();
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
    connecting: "连接中",
    disconnected: "未连接",
    offline: "离线",
    starting: "启动中",
    unknown: "未知",
    catalog: "目录",
    maintenance: "维护",
    local_stock: "本地库存",
    none: "无",
  };
  return labels[status] ?? status;
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

async function exportLogs(): Promise<void> {
  diagnostics.logsMessage = null;
  try {
    await remoteOpsStore.downloadExport();
    diagnostics.logsMessage = "日志已导出";
  } catch (error) {
    diagnostics.logsMessage = operatorErrorMessage(
      "日志未导出，请稍后重试。",
      error,
    );
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
    stockMaintenance.message = operatorErrorMessage(
      "库存维护任务未读取，请刷新后重试。",
      error,
    );
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
    stockMaintenance.message = operatorErrorMessage(
      "库存批次提交结果未确认，可刷新后恢复。",
      error,
    );
  } finally {
    stockMaintenance.loading = false;
  }
}
</script>

<template>
  <main ref="maintenanceRoot" class="kiosk-shell maintenance-page">
    <KioskHeader />
    <div class="maintenance-layout">
      <aside class="maintenance-task-nav" aria-label="维护任务">
        <p>维护任务</p>
        <button
          v-for="task in maintenanceTasks"
          :key="task.key"
          type="button"
          :class="{ active: activeTask === task.key }"
          @click="selectMaintenanceTask(task.key)"
        >
          <span>{{ task.label }}</span>
          <small>{{ task.value }}</small>
        </button>
      </aside>
      <section class="maintenance-workspace">
        <header class="maintenance-workspace-header">
          <div>
            <p>本地运维</p>
            <h1>
              {{
                maintenanceTasks.find((task) => task.key === activeTask)?.label
              }}
            </h1>
          </div>
          <button
            class="maintenance-primary-button"
            type="button"
            :disabled="Boolean(returnToCatalogBlockedReason)"
            @click="returnToCatalog"
          >
            返回商品目录
          </button>
        </header>

        <section
          v-if="operatorAttention.summary"
          class="maintenance-attention-list"
          aria-live="polite"
          aria-label="操作提示"
        >
          <article>
            <p class="font-semibold text-rose-50">
              {{ operatorAttention.summary }}
            </p>
            <details v-if="operatorAttention.technicalEvidence">
              <summary>技术证据</summary>
              <pre>{{ operatorAttention.technicalEvidence }}</pre>
            </details>
          </article>
        </section>

        <section
          v-show="activeTask === 'commissioning'"
          class="maintenance-panel maintenance-commissioning"
          aria-label="机器认领"
        >
          <form class="grid gap-3" @submit.prevent="submitNetworkSettings">
            <div class="flex items-center justify-between gap-3">
              <p class="font-semibold text-white">本地网络</p>
              <button
                class="kiosk-touch-target rounded-xl border border-sky-200/30 px-3 py-2 text-sm font-bold text-sky-100"
                type="button"
                :disabled="commissioning.loading"
                @click="loadWifiNetworks"
              >
                扫描网络
              </button>
            </div>
            <select
              v-if="commissioning.wifiNetworks.length > 0"
              v-model="commissioning.ssid"
              class="kiosk-touch-target rounded-xl bg-slate-950/60 p-3 text-white"
              aria-label="可用网络"
            >
              <option value="">选择网络</option>
              <option
                v-for="ssid in commissioning.wifiNetworks"
                :key="ssid"
                :value="ssid"
              >
                {{ ssid }}
              </option>
            </select>
            <input
              v-model.trim="commissioning.ssid"
              class="kiosk-touch-target rounded-xl bg-slate-950/60 p-3 text-white"
              autocomplete="off"
              placeholder="网络名称"
              aria-label="网络名称"
              required
            />
            <input
              v-model="commissioning.password"
              class="kiosk-touch-target rounded-xl bg-slate-950/60 p-3 text-white"
              type="password"
              autocomplete="off"
              placeholder="网络密码"
              aria-label="网络密码"
            />
            <label class="flex items-center gap-2 text-sm text-slate-200">
              <input v-model="commissioning.hidden" type="checkbox" /> 隐藏网络
            </label>
            <button
              class="kiosk-touch-target rounded-xl bg-sky-300 px-4 py-3 font-bold text-slate-950 disabled:opacity-50"
              type="submit"
              :disabled="commissioning.loading || !commissioning.ssid"
            >
              {{ commissioning.loading ? "连接中" : "应用网络" }}
            </button>
          </form>
          <form
            v-if="!hasAcceptedProvisioningProfile"
            class="grid content-start gap-3"
            @submit.prevent="submitClaim"
          >
            <p class="font-semibold text-white">机器认领</p>
            <input
              v-model.trim="commissioning.claimCode"
              class="kiosk-touch-target rounded-xl bg-slate-950/60 p-3 text-white"
              autocomplete="off"
              placeholder="认领码"
              aria-label="认领码"
              required
            />
            <button
              class="kiosk-touch-target rounded-xl bg-emerald-300 px-4 py-3 font-bold text-slate-950 disabled:opacity-50"
              type="submit"
              :disabled="commissioning.claiming || !commissioning.claimCode"
            >
              {{ commissioning.claiming ? "认领中" : "认领机器" }}
            </button>
          </form>
          <div v-else class="maintenance-claim-status">
            <p>机器认领</p>
            <strong>{{ machineStore.machineCode ?? "已认领" }}</strong>
            <span>平台配置已接受，本地界面不重复编辑平台字段。</span>
          </div>
          <p
            v-if="commissioning.message"
            class="text-sm text-amber-100 md:col-span-2"
          >
            {{ commissioning.message }}
          </p>
        </section>

        <section
          v-show="activeTask === 'status'"
          class="maintenance-panel"
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
          <p
            v-if="paymentEnvironmentMessage"
            class="mt-1 text-sm text-amber-100"
          >
            {{ paymentEnvironmentMessage }}
          </p>
        </section>

        <section
          v-if="saleCriticalBlockers.length > 0"
          v-show="activeTask === 'status'"
          class="maintenance-attention-list"
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
            <p class="font-semibold text-rose-50">
              {{ blocker.operatorLabel }}
            </p>
            <p class="mt-1 text-sm text-rose-100/90">
              {{ blocker.operatorAction }}
            </p>
            <button
              class="kiosk-touch-target mt-3 rounded-2xl border border-rose-100/40 px-4 py-3 font-bold text-rose-50 disabled:opacity-50"
              type="button"
              :disabled="blockerRecoveryDisabled()"
              @click="runBlockerRecovery(blocker.code)"
            >
              {{ blockerRecoveryLabel(blocker.code) }}
            </button>
            <details class="mt-3 text-sm text-rose-100/80">
              <summary>技术证据</summary>
              <p class="mt-2">{{ blocker.code }} · {{ blocker.message }}</p>
            </details>
          </article>
        </section>

        <section
          v-show="activeTask === 'hardware'"
          class="maintenance-panel"
          data-test="manual-dispense-diagnostic"
        >
          <div class="maintenance-panel-heading">
            <div>
              <h2>设备检查</h2>
              <p>
                下位机{{
                  machineStore.health?.hardwareOnline ? "在线" : "不可用"
                }}，扫码器{{ scannerStore.online ? "在线" : "不可用" }}。
              </p>
            </div>
            <button
              type="button"
              :disabled="hardwareMaintenance.loading"
              @click="runHardwareCheck"
            >
              {{ hardwareMaintenance.loading ? "检查中" : "重新检查" }}
            </button>
          </div>
          <p v-if="hardwareMaintenance.message" class="maintenance-message">
            {{ hardwareMaintenance.message }}
          </p>
          <hr />
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
              :disabled="manualDispenseDiagnostic.loading"
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

        <div
          v-show="activeTask === 'experience'"
          class="maintenance-vision-panel"
        >
          <VisionCameraMaintenancePanel />
        </div>

        <section
          v-show="activeTask === 'experience'"
          class="maintenance-panel"
          aria-label="视觉试衣预览诊断"
        >
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p class="font-semibold text-sky-100">视觉试衣预览诊断</p>
              <p class="mt-1 text-sm text-slate-300">
                直接验证本机视觉服务的临时预览会话。
              </p>
            </div>
            <div class="flex flex-wrap gap-3">
              <button
                type="button"
                :disabled="visionMaintenance.loading"
                @click="refreshVisionStatus"
              >
                {{ visionMaintenance.loading ? "刷新中" : "刷新视觉状态" }}
              </button>
              <button
                class="kiosk-touch-target rounded-xl border border-sky-200/30 px-4 py-3 font-bold text-sky-100 disabled:opacity-50"
                type="button"
                :disabled="tryOnPreviewDiagnostic.loading"
                @click="startTryOnPreviewDiagnostic"
              >
                {{ tryOnPreviewDiagnostic.loading ? "启动中" : "启动试衣预览" }}
              </button>
              <button
                v-if="tryOnPreviewDiagnostic.previewUrl"
                class="kiosk-touch-target rounded-xl border border-rose-200/30 px-4 py-3 font-bold text-rose-100"
                type="button"
                @click="stopTryOnPreviewDiagnostic"
              >
                释放试衣预览
              </button>
            </div>
          </div>
          <p
            v-if="tryOnPreviewDiagnostic.message"
            class="mt-3 text-sm text-sky-100"
            aria-live="polite"
          >
            {{ tryOnPreviewDiagnostic.message }}
          </p>
          <p v-if="visionMaintenance.message" class="maintenance-message">
            {{ visionMaintenance.message }}
          </p>
          <div
            v-if="tryOnPreviewDiagnostic.previewUrl"
            class="mt-4 grid gap-3 md:grid-cols-[minmax(0,1fr)_16rem]"
          >
            <img
              :src="tryOnPreviewDiagnostic.previewUrl"
              alt="视觉试衣预览"
              class="aspect-video w-full rounded-xl bg-slate-950 object-cover"
              data-test="try-on-camera-preview"
            />
            <dl class="grid content-start gap-3 text-sm text-slate-200">
              <div>
                <dt class="text-slate-400">预览流</dt>
                <dd>{{ tryOnPreviewDiagnostic.streamType }}</dd>
              </div>
              <div>
                <dt class="text-slate-400">预览地址</dt>
                <dd class="break-all">
                  {{ tryOnPreviewDiagnostic.previewUrl }}
                </dd>
              </div>
            </dl>
          </div>
        </section>

        <div v-show="activeTask === 'stock'" class="maintenance-panel">
          <p
            class="text-sm font-semibold tracking-[0.28em] text-emerald-200 uppercase"
          >
            库存维护
          </p>
          <form
            class="mt-4 grid gap-4"
            @submit.prevent="submitStockMaintenanceTask"
          >
            <fieldset class="contents">
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
                      {{ resultingStock(slot) ?? "输入无效" }}/{{
                        slot.capacity
                      }}
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
                  :disabled="stockMaintenance.loading || !stockTaskCanSubmit"
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

        <div v-show="activeTask === 'status'" class="maintenance-panel">
          <div class="maintenance-panel-heading">
            <div>
              <h2>
                {{
                  saleCapabilityStore.canStartSale
                    ? "机器可以正常销售"
                    : "机器需要处理"
                }}
              </h2>
              <p>以下状态均来自当前运行观测。</p>
            </div>
            <button
              type="button"
              :disabled="diagnostics.loading"
              @click="refreshDiagnostics"
            >
              {{ diagnostics.loading ? "刷新中" : "刷新状态" }}
            </button>
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
                {{
                  runtimeStatusLabel(machineStore.health?.status ?? "unknown")
                }}
              </dd>
            </div>
            <div class="border-t border-white/10 py-3">
              <dt class="text-sm text-slate-400">后端</dt>
              <dd class="mt-1 font-bold text-white">
                {{ machineStore.health?.backendOnline ? "在线" : "不可用" }}
                ·
                {{
                  runtimeStatusLabel(machineStore.health?.status ?? "unknown")
                }}
              </dd>
            </div>
            <div class="border-t border-white/10 py-3">
              <dt class="text-sm text-slate-400">销售启动能力</dt>
              <dd class="mt-1 font-bold text-white">
                {{
                  saleCapabilityStore.updating
                    ? "更新中"
                    : saleCapabilityStore.canStartSale
                      ? "可开始销售"
                      : "不可开始"
                }}
              </dd>
            </div>
            <div class="border-t border-white/10 py-3">
              <dt class="text-sm text-slate-400">平台同步</dt>
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
                {{ scannerStore.online ? "在线" : "不可用" }}
              </dd>
            </div>
            <div class="border-t border-white/10 py-3">
              <dt class="text-sm text-slate-400">视觉运行状态</dt>
              <dd class="mt-1 font-bold text-white">
                {{ visionStore.online ? "在线" : "不可用" }}
              </dd>
            </div>
          </dl>
        </div>

        <section
          v-show="activeTask === 'diagnostics'"
          class="maintenance-panel"
          aria-label="诊断工具"
        >
          <div class="maintenance-panel-heading">
            <div>
              <h2>诊断工具</h2>
              <p>刷新当前观测，或导出日志用于排查。</p>
            </div>
            <div class="maintenance-button-row">
              <button
                type="button"
                :disabled="diagnostics.loading"
                @click="refreshDiagnostics"
              >
                {{ diagnostics.loading ? "刷新中" : "刷新状态" }}
              </button>
              <button type="button" @click="exportLogs">导出日志</button>
            </div>
          </div>
          <details data-test="catalog-operator-diagnostics">
            <summary>目录媒体与分类</summary>
            <p v-if="catalogOperatorDiagnostics.length === 0">
              尚未记录目录诊断。
            </p>
            <ul v-else>
              <li
                v-for="diagnostic in catalogOperatorDiagnostics"
                :key="`${diagnostic.kind}-${diagnostic.reference}-${diagnostic.message}`"
              >
                {{ diagnostic.message }} ·
                {{ diagnostic.reference ?? "无引用" }}
              </li>
            </ul>
          </details>
          <details>
            <summary>视觉诊断数据</summary>
            <pre data-test="vision-diagnostic-payload">{{
              latestVisionDiagnosticPayloadText
            }}</pre>
          </details>
          <p v-if="diagnostics.message" class="maintenance-message error">
            {{ diagnostics.message }}
          </p>
          <p v-if="diagnostics.logsMessage" class="maintenance-message success">
            {{ diagnostics.logsMessage }}
          </p>
        </section>

        <div
          v-if="mqttStore.outboxWarning"
          v-show="activeTask === 'status'"
          class="mt-6 rounded-2xl border border-amber-300/30 bg-amber-500/20 p-4 text-amber-100"
        >
          {{ mqttStore.outboxWarning }}
        </div>

        <section
          v-show="activeTask === 'experience'"
          class="maintenance-panel"
          data-test="audio-preferences"
        >
          <div class="grid gap-3 text-left">
            <h3 class="text-lg font-bold text-slate-100">顾客音频偏好</h3>
            <p class="text-sm text-slate-300">
              顾客音频使用系统当前默认扬声器。
            </p>
            <fieldset class="grid gap-3 text-left md:grid-cols-3">
              <label class="flex items-center gap-3">
                <input
                  :checked="machineStore.customerAudio.cuesEnabled"
                  :disabled="audioPreferenceMutation.saving"
                  class="size-5 accent-fuchsia-300"
                  data-test="machine-audio-enabled"
                  type="checkbox"
                  @change="
                    updateAudioPreferences({
                      cuesEnabled: checkedInputValue($event),
                    })
                  "
                />
                <span class="text-sm font-semibold text-slate-200"
                  >启用机器音频提示</span
                >
              </label>
              <label class="flex items-center gap-3">
                <input
                  :checked="machineStore.customerAudio.presenceCuesEnabled"
                  :disabled="audioPreferenceMutation.saving"
                  class="size-5 accent-fuchsia-300"
                  data-test="machine-audio-presence-enabled"
                  type="checkbox"
                  @change="
                    updateAudioPreferences({
                      presenceCuesEnabled: checkedInputValue($event),
                    })
                  "
                />
                <span class="text-sm font-semibold text-slate-200"
                  >来人音频提示</span
                >
              </label>
              <label class="flex items-center gap-3">
                <input
                  :checked="machineStore.customerAudio.transactionCuesEnabled"
                  :disabled="audioPreferenceMutation.saving"
                  class="size-5 accent-fuchsia-300"
                  data-test="machine-audio-transaction-enabled"
                  type="checkbox"
                  @change="
                    updateAudioPreferences({
                      transactionCuesEnabled: checkedInputValue($event),
                    })
                  "
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
                  :value="
                    machineAudioVolumePercent(machineStore.customerAudio.volume)
                  "
                  :disabled="audioPreferenceMutation.saving"
                  class="maintenance-volume-slider"
                  data-test="machine-audio-volume-percent"
                  max="100"
                  min="0"
                  step="1"
                  type="range"
                  @change="
                    updateAudioPreferences({
                      volume: audioVolumeFromInput($event),
                    })
                  "
                />
                <output class="maintenance-volume-output">
                  {{
                    machineAudioVolumePercent(
                      machineStore.customerAudio.volume,
                    )
                  }}%
                </output>
              </div>
            </label>
            <div class="flex flex-wrap gap-3">
              <button
                class="kiosk-touch-target rounded-2xl border border-cyan-200/30 px-4 py-3 font-bold text-cyan-100 disabled:opacity-50"
                type="button"
                :disabled="machineAudioTestPlayback.loading"
                @click="playMachineAudioTestPlayback"
              >
                播放测试音频
              </button>
            </div>
            <p
              v-if="audioPreferenceMutation.message"
              class="rounded-2xl bg-cyan-950/40 p-3 text-sm text-cyan-50"
            >
              {{ audioPreferenceMutation.message }}
            </p>
            <dl class="grid gap-3 md:grid-cols-2">
              <div
                v-for="row in latestMachineAudioTestPlaybackRows"
                :key="row.label"
                class="rounded-xl bg-slate-950/35 p-3"
              >
                <dt class="text-xs font-semibold text-cyan-100/70">
                  {{ row.label }}
                </dt>
                <dd class="mt-1 font-bold break-all text-white">
                  {{ row.value }}
                </dd>
              </div>
            </dl>
            <p
              v-if="machineAudioTestPlayback.message"
              class="rounded-2xl bg-cyan-950/40 p-3 text-sm text-cyan-50"
            >
              {{ machineAudioTestPlayback.message }}
            </p>
          </div>
          <p
            v-if="machineStore.error"
            class="rounded-2xl bg-rose-500/20 p-4 text-rose-100"
          >
            {{ machineStore.error }}
          </p>
        </section>
      </section>
    </div>
  </main>
</template>

<style scoped>
.maintenance-page {
  display: flex;
  flex-direction: column;
  padding: var(--machine-page-header-top) var(--machine-page-inline) 0;
  color: #293129;
  background: #f5f4ee;
}

.maintenance-layout {
  display: grid;
  grid-template-columns: 12rem minmax(0, 1fr);
  flex: 1;
  min-height: 0;
  margin: 1.4rem calc(var(--machine-page-inline) * -1) 0;
  overflow: hidden;
  border-top: 1px solid #d8ddd5;
}

.maintenance-task-nav {
  min-height: 0;
  padding: 1.35rem 0.7rem;
  overflow-y: auto;
  background: #e9ebe4;
  border-right: 1px solid #d3d8d0;
}

.maintenance-task-nav > p {
  padding: 0 0.7rem 0.65rem;
  margin: 0;
  color: #737b74;
  font-size: 0.72rem;
  font-weight: 700;
}

.maintenance-task-nav button {
  display: grid;
  gap: 0.25rem;
  width: 100%;
  min-height: 3.6rem;
  padding: 0.65rem 0.7rem;
  color: #3f4841;
  text-align: left;
  background: transparent;
  border: 0;
  border-radius: 6px;
}

.maintenance-task-nav button.active {
  background: #fff;
  box-shadow: 0 2px 8px rgb(64 74 66 / 9%);
}

.maintenance-task-nav button span {
  font-weight: 700;
}

.maintenance-task-nav button small {
  color: #6f786f;
  font-size: 0.68rem;
}

.maintenance-workspace {
  min-width: 0;
  padding: 1.5rem 1.6rem 4rem;
  overflow-y: auto;
}

.maintenance-workspace-header,
.maintenance-panel-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}

.maintenance-workspace-header {
  margin-bottom: 1.2rem;
}

.maintenance-workspace-header p,
.maintenance-panel-heading p {
  margin: 0;
  color: #727a73;
  font-size: 0.72rem;
}

.maintenance-workspace-header h1 {
  margin: 0.2rem 0 0;
  color: #293129;
  font-size: 1.7rem;
}

.maintenance-panel-heading h2 {
  margin: 0;
  color: #293129;
  font-size: 1.1rem;
}

.maintenance-primary-button,
.maintenance-panel-heading button,
.maintenance-button-row button,
.maintenance-panel button {
  padding: 0.55rem 0.8rem;
  color: #42533f !important;
  background: #fff !important;
  border: 1px solid #9ca99a !important;
  border-radius: 6px !important;
  font-weight: 700;
}

.maintenance-primary-button {
  color: #fff !important;
  background: #657a58 !important;
  border-color: #657a58 !important;
}

.maintenance-primary-button:disabled,
.maintenance-panel button:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.maintenance-panel,
.maintenance-attention-list article {
  padding: 1rem;
  margin-top: 0.8rem;
  color: #303832;
  text-align: left;
  background: #fff !important;
  border: 1px solid #d7dcd5 !important;
  border-radius: 8px !important;
  box-shadow: none;
}

.maintenance-panel:first-of-type {
  margin-top: 0;
}

.maintenance-panel hr {
  margin: 1rem 0;
  border: 0;
  border-top: 1px solid #e0e4de;
}

.maintenance-attention-list {
  display: grid;
  gap: 0.6rem;
  margin-top: 1rem;
}

.maintenance-attention-list > h3 {
  margin: 0;
  color: #85591c !important;
}

.maintenance-attention-list article {
  margin-top: 0;
  background: #fff8e9 !important;
  border-color: #dfc28c !important;
}

.maintenance-commissioning {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1rem;
}

.maintenance-claim-status {
  display: grid;
  align-content: start;
  gap: 0.5rem;
  padding: 0.9rem;
  background: #f2f5ef;
  border-radius: 6px;
}

.maintenance-claim-status p,
.maintenance-claim-status span {
  margin: 0;
  color: #667067;
  font-size: 0.75rem;
}

.maintenance-page
  :is(input:not([type="checkbox"]):not([type="range"]), select, textarea) {
  width: 100%;
  min-height: 2.8rem;
  padding: 0.65rem 0.75rem;
  color: #293129 !important;
  background: #fff !important;
  border: 1px solid #b8c0b7 !important;
  border-radius: 6px !important;
  outline: none;
}

.maintenance-page :is(input, select, textarea):focus {
  border-color: #657a58 !important;
  box-shadow: 0 0 0 2px rgb(101 122 88 / 16%);
}

.maintenance-page input[type="checkbox"] {
  accent-color: #657a58;
}

.maintenance-page
  :is(.text-white, .text-slate-100, .text-slate-200, .text-slate-300) {
  color: #3c453e !important;
}

.maintenance-page :is(.text-slate-400, .text-cyan-100\/70) {
  color: #717972 !important;
}

.maintenance-page
  :is(.text-sky-100, .text-sky-200, .text-cyan-50, .text-cyan-100) {
  color: #506847 !important;
}

.maintenance-page :is(.text-amber-100, .text-amber-200) {
  color: #7a5218 !important;
}

.maintenance-page :is(.text-rose-50, .text-rose-100) {
  color: #7e3835 !important;
}

.maintenance-page
  :is(
    .bg-slate-950\/30,
    .bg-slate-950\/35,
    .bg-slate-950\/40,
    .bg-slate-950\/45,
    .bg-slate-950\/60,
    .bg-slate-950\/70
  ) {
  background: #f5f6f2 !important;
}

.maintenance-page :is(.bg-amber-500\/10, .bg-amber-500\/15, .bg-amber-500\/20) {
  color: #704d19 !important;
  background: #fff7e7 !important;
  border-color: #dfc38f !important;
}

.maintenance-page :is(.bg-rose-500\/15, .bg-rose-500\/20) {
  color: #773936 !important;
  background: #fff0ed !important;
  border-color: #d5a4a0 !important;
}

.maintenance-page
  :is(
    .bg-sky-500\/15,
    .bg-fuchsia-500\/15,
    .bg-emerald-500\/15,
    .bg-cyan-950\/40
  ) {
  color: #4d6647 !important;
  background: #eef4ea !important;
  border-color: #bdcbb7 !important;
}

.maintenance-page dl {
  gap: 0 !important;
  background: #fff;
  border: 1px solid #dce0da;
  border-radius: 8px;
}

.maintenance-page dl > div {
  padding: 0.8rem !important;
  border-color: #e0e4de !important;
}

.maintenance-page dt {
  color: #747c75 !important;
  font-size: 0.68rem !important;
  font-weight: 600;
}

.maintenance-page dd {
  color: #2f3731 !important;
  font-size: 0.82rem;
  line-height: 1.4;
}

.maintenance-button-row {
  display: flex;
  gap: 0.5rem;
}

.maintenance-panel details {
  margin-top: 0.8rem;
  padding-top: 0.8rem;
  color: #515a53;
  border-top: 1px solid #e0e4de;
}

.maintenance-panel details summary {
  cursor: pointer;
  font-weight: 700;
}

.maintenance-panel pre {
  max-height: 15rem;
  overflow: auto;
  color: #3f4741;
  font-size: 0.7rem;
  line-height: 1.5;
  white-space: pre-wrap;
}

.maintenance-message {
  padding: 0.7rem;
  margin: 0.8rem 0 0;
  color: #4b6145;
  background: #eef4ea;
  border: 1px solid #bdcbb7;
  border-radius: 6px;
}

.maintenance-message.error {
  color: #773936;
  background: #fff0ed;
  border-color: #d5a4a0;
}

.maintenance-volume-slider {
  width: min(24rem, 78%);
  accent-color: #657a58;
}

.maintenance-volume-output {
  min-width: 3rem;
  color: #384239;
  font-weight: 700;
}

.maintenance-vision-panel :deep(> *) {
  margin-top: 0.8rem;
}

@media (max-width: 760px) {
  .maintenance-layout {
    grid-template-columns: 9.2rem minmax(0, 1fr);
  }

  .maintenance-workspace {
    padding: 1rem 1rem 3rem;
  }

  .maintenance-commissioning {
    grid-template-columns: 1fr;
  }
}
</style>
