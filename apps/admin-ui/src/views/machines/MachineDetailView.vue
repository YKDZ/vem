<script setup lang="ts">
import type {
  ExternalNaturalEnvironment,
  MachineCommandStatus,
  MachineSlotStatus,
} from "@vem/shared";

import { formatMachineSlotCoordinate } from "@vem/shared";
import { message, Modal } from "antdv-next";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";

import {
  adjustInventory,
  getStockReconciliationCase,
  listInventories,
  listStockReconciliationCases,
  resolveStockReconciliationCase,
  type Inventory,
  type StockReconciliationCaseDetail,
  type StockReconciliationCaseSummary,
} from "@/api/inventory";
import {
  listMachineOps,
  requestLogExport,
  type MachineOp,
} from "@/api/machine-ops";
import {
  commandEnvironment,
  getExternalNaturalEnvironment,
  getMachine,
  listMachineSlots,
  updateMachine,
  type Machine,
  type MachineGeoLocation,
  type MachineSlot,
} from "@/api/machines";
import { useAuthStore } from "@/stores/auth";
import { formatDateTime } from "@/utils/format";

import {
  isEnvironmentCommandTerminalStatus,
  syncEnvironmentCommandStateFromSnapshot,
  startEnvironmentCommandPoller,
  type EnvironmentCommandSnapshot,
} from "./environment-command-poller";
import {
  mapEnvironmentControlFormToContract,
  type EnvironmentControlAction,
  mapMachineBasicsFormToUpdateContract,
} from "./machine-contract-mappers";
import {
  commandStatusLabel,
  environmentControlFeedback,
  formatEnvironmentNumber,
} from "./machine-environment-display";
import MachineEnvironmentCard from "./MachineEnvironmentCard.vue";

type WholeMachineMaintenanceLockHeartbeat = {
  code?: string;
  message?: string;
  slotDisplayLabel?: string;
  commandNo?: string;
};

const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();

const canWrite = authStore.hasPermission("machines.write");
const canCommand = authStore.hasPermission("machines.command");
const canAdjust = authStore.hasPermission("inventory.adjust");
const canReviewStockReconciliation =
  authStore.hasPermission("inventory.adjust");
const canExportLogs = authStore.hasPermission("machineOps.write");

const machineId = computed(() => String(route.params.id ?? ""));
const loading = ref(false);
const machine = ref<Machine | null>(null);
const slots = ref<MachineSlot[]>([]);
const inventories = ref<Inventory[]>([]);
const ops = ref<MachineOp[]>([]);
const reconciliationCases = ref<StockReconciliationCaseSummary[]>([]);
const externalNaturalEnvironment = ref<ExternalNaturalEnvironment | null>(null);

const environmentControlForm = ref({
  airConditionerOn: false,
  targetTemperatureCelsius: 24,
  ventSpeed: 0,
});
const defaultEnvironmentControlForm = () => ({
  airConditionerOn: false,
  targetTemperatureCelsius: 24,
  ventSpeed: 0,
});
const machineDrawerOpen = ref(false);
const machineSaving = ref(false);
const machineForm = ref({
  name: "",
  locationLabel: "",
  includeGeoLocation: false,
  geoLatitude: null as number | null,
  geoLongitude: null as number | null,
  geoTimezone: "Asia/Shanghai",
});
const environmentSubmittingAction = ref<EnvironmentControlAction | null>(null);
const environmentCommandStatus = ref<MachineCommandStatus | null>(null);
const environmentCommandPoller = ref<ReturnType<
  typeof startEnvironmentCommandPoller
> | null>(null);

function stopEnvironmentCommandPoller(): void {
  environmentCommandPoller.value?.stop();
  environmentCommandPoller.value = null;
}

function syncEnvironmentCommandStateFromMachine(
  command: EnvironmentCommandSnapshot | null | undefined,
): void {
  syncEnvironmentCommandStateFromSnapshot(command ?? null, {
    setEnvironmentCommandStatus: (status) => {
      environmentCommandStatus.value = status;
    },
  });
}

const exportingLogs = ref(false);

const adjustModalOpen = ref(false);
const adjustSaving = ref(false);
const adjustInventoryRow = ref<Inventory | null>(null);
const adjustForm = ref({ deltaQty: 0, note: "" });

const reconciliationModalOpen = ref(false);
const reconciliationSaving = ref(false);
const reconciliationDetail = ref<StockReconciliationCaseDetail | null>(null);
const reconciliationForm = ref({
  note: "",
  correctedOnHandQty: 0,
  clearBlocker: false,
});

const targetTemperatureInvalid = computed(() => {
  const value = environmentControlForm.value.targetTemperatureCelsius;
  return value < 18 || value > 30;
});

const environmentMachineCommandLocked = computed(() =>
  ["pending", "sent", "acknowledged"].includes(
    environmentCommandStatus.value ?? "",
  ),
);

const environmentCommandDisabled = computed(
  () =>
    !canCommand ||
    environmentMachineCommandLocked.value ||
    Boolean(environmentSubmittingAction.value),
);

const heartbeat = computed(() => machine.value?.latestHeartbeatStatus ?? null);
const wholeMachineMaintenanceLock = computed(
  () =>
    (heartbeat.value
      ?.wholeMachineMaintenanceLock as WholeMachineMaintenanceLockHeartbeat | null) ??
    null,
);
const environment = computed(() => machine.value?.latestEnvironment ?? null);
const reportedRuntimeConfiguration = computed(
  () => machine.value?.reportedRuntimeConfiguration ?? null,
);
const externalNaturalEnvironmentDiagnostic = computed(() => {
  const value = externalNaturalEnvironment.value;
  if (!value || !("diagnostic" in value)) return undefined;
  return value.diagnostic;
});

const slotRows = computed(() =>
  slots.value.map((slot) => ({
    ...slot,
    inventory:
      inventories.value.find((item) => item.slotId === slot.id) ?? null,
  })),
);

const machineStatusColor: Record<string, string> = {
  online: "success",
  offline: "default",
  maintenance: "warning",
  disabled: "error",
};

const slotStatusColor: Record<MachineSlotStatus, string> = {
  enabled: "success",
  disabled: "default",
  faulted: "error",
};

const commandStatusColor: Record<string, string> = {
  pending: "processing",
  sent: "processing",
  acknowledged: "warning",
  succeeded: "success",
  failed: "error",
  timeout: "error",
};

const hardwareStatusColor: Record<string, string> = {
  ok: "success",
  degraded: "warning",
  faulted: "error",
};

const slotColumns = [
  { title: "货道坐标", key: "coordinate" },
  { title: "状态", dataIndex: "status", key: "status" },
  { title: "容量", dataIndex: "capacity", key: "capacity" },
  { title: "商品", key: "product" },
  { title: "库存", key: "stock" },
  { title: "操作", key: "actions" },
];

const opColumns = [
  { title: "类型", dataIndex: "type", key: "type" },
  { title: "状态", dataIndex: "status", key: "status" },
  { title: "请求时间", dataIndex: "requestedAt", key: "requestedAt" },
  { title: "完成时间", dataIndex: "finishedAt", key: "finishedAt" },
  { title: "失败原因", dataIndex: "failedReason", key: "failedReason" },
];

const reconciliationColumns = [
  { title: "货道", key: "slot" },
  { title: "异常", dataIndex: "reconciliationReason", key: "reason" },
  { title: "冻结/阻断", key: "blocker" },
  { title: "售卖资格", key: "eligibility" },
  { title: "关联", key: "linked" },
  { title: "上报时间", dataIndex: "receivedAt", key: "receivedAt" },
  { title: "操作", key: "actions" },
];

function formatGeoLocation(geoLocation: MachineGeoLocation | null): string {
  if (!geoLocation) return "未配置";
  return `${geoLocation.latitude}, ${geoLocation.longitude} · ${geoLocation.timezone}`;
}

function reportedBooleanLabel(value: boolean | null | undefined): string {
  if (value === true) return "已开启";
  if (value === false) return "已关闭";
  return "未上报";
}

function reportedVolumeLabel(value: number | null | undefined): string {
  return typeof value === "number" ? `${value}%` : "未上报";
}

function externalNaturalEnvironmentStatusLabel(status: string | undefined) {
  if (status === "ready") return "已就绪";
  if (status === "stale") return "使用缓存";
  if (status === "unavailable") return "暂不可用";
  if (status === "unconfigured") return "未配置";
  return "未知";
}

function externalNaturalEnvironmentStatusColor(status: string | undefined) {
  if (status === "ready") return "success";
  if (status === "stale") return "warning";
  if (status === "unavailable") return "error";
  if (status === "unconfigured") return "default";
  return "default";
}

function formatExternalTemperature(value: number | undefined): string {
  return typeof value === "number" ? formatEnvironmentNumber(value, "C") : "--";
}

function weatherConditionClassLabel(value: string): string {
  if (value === "hail") return "冰雹";
  if (value === "snow") return "降雪";
  if (value === "strong_wind") return "强风";
  if (value === "moderate_or_heavy_rain") return "中到大雨";
  if (value === "light_rain") return "小雨";
  if (value === "other") return "普通天气";
  return value;
}

function formatWeatherConditionClasses(values: string[] | undefined): string {
  return values && values.length > 0
    ? values.map(weatherConditionClassLabel).join("、")
    : "--";
}

function formatLocalTime(
  localTime: ExternalNaturalEnvironment["localTime"] | undefined,
): string {
  if (!localTime) return "--";
  if (localTime.status !== "ready") return localTime.status;
  return `${localTime.localDate ?? "--"} ${localTime.localClock ?? "--"} · ${
    localTime.timezone
  }`;
}

type ExternalDiagnostic = {
  reason:
    | "machine_geo_location_missing"
    | "machine_geo_timezone_missing"
    | "provider_unavailable";
  message: string;
};

function externalDiagnosticReasonLabel(reason: ExternalDiagnostic["reason"]) {
  if (reason === "machine_geo_location_missing") return "机器未配置地理坐标";
  if (reason === "machine_geo_timezone_missing") return "机器未配置地理时区";
  return "外部环境服务暂不可用";
}

function externalDiagnosticMessage(
  block: ExternalDiagnostic | undefined,
): string {
  if (!block) return "--";
  return `${block.reason}: ${externalDiagnosticReasonLabel(block.reason)}`;
}

function hardwareStatusLabel(status: string | undefined): string {
  if (status === "ok") return "正常";
  if (status === "degraded") return "降级";
  if (status === "faulted") return "异常";
  return "未知";
}

function inventoryAvailableQty(inventory: Inventory): number {
  return inventory.availableQty ?? inventory.onHandQty - inventory.reservedQty;
}

function inventorySlotCoordinateLabel(inventory: Inventory | null): string {
  if (!inventory) return "--";
  const slot = slots.value.find((item) => item.id === inventory.slotId);
  return slot ? formatMachineSlotCoordinate(slot) : inventory.slotId;
}

async function loadMachine(): Promise<void> {
  const nextMachine = await getMachine(machineId.value);
  machine.value = nextMachine;
  environmentCommandStatus.value =
    nextMachine.latestEnvironmentCommand?.status ?? null;
  syncEnvironmentCommandStateFromMachine(nextMachine.latestEnvironmentCommand);
  environmentControlForm.value = defaultEnvironmentControlForm();
}

async function loadExternalNaturalEnvironment(): Promise<void> {
  externalNaturalEnvironment.value = await getExternalNaturalEnvironment(
    machineId.value,
  );
}

async function loadInventoryData(): Promise<void> {
  const [nextSlots, nextInventories] = await Promise.all([
    listMachineSlots(machineId.value),
    listInventories({ machineId: machineId.value, page: 1, pageSize: 100 }),
  ]);
  slots.value = nextSlots;
  inventories.value = nextInventories.items;
}

async function loadOps(): Promise<void> {
  ops.value = await listMachineOps({ machineId: machineId.value });
}

async function loadReconciliationCases(): Promise<void> {
  const result = await listStockReconciliationCases({
    machineId: machineId.value,
    page: 1,
    pageSize: 20,
  });
  reconciliationCases.value = result.items;
}

async function refreshAll(): Promise<void> {
  loading.value = true;
  try {
    await Promise.all([
      loadMachine(),
      loadExternalNaturalEnvironment(),
      loadInventoryData(),
      loadOps(),
      loadReconciliationCases(),
    ]);
  } finally {
    loading.value = false;
  }
}

function openEditMachine(): void {
  if (!machine.value) return;
  machineForm.value = {
    name: machine.value.name,
    locationLabel: machine.value.locationLabel ?? "",
    includeGeoLocation: machine.value.geoLocation !== null,
    geoLatitude: machine.value.geoLocation?.latitude ?? null,
    geoLongitude: machine.value.geoLocation?.longitude ?? null,
    geoTimezone: machine.value.geoLocation?.timezone ?? "Asia/Shanghai",
  };
  machineDrawerOpen.value = true;
}

async function saveMachine(): Promise<void> {
  if (!machine.value) return;
  let body: ReturnType<typeof mapMachineBasicsFormToUpdateContract>;
  try {
    body = mapMachineBasicsFormToUpdateContract(machineForm.value);
  } catch {
    Modal.error({
      title: "固定地理坐标无效",
      content:
        "请填写完整 WGS84 纬度、经度和 IANA 时区；纬度 -90..90，经度 -180..180。",
    });
    return;
  }

  machineSaving.value = true;
  try {
    await updateMachine(machine.value.id, body);
    machineDrawerOpen.value = false;
    await Promise.all([loadMachine(), loadExternalNaturalEnvironment()]);
  } finally {
    machineSaving.value = false;
  }
}

async function submitEnvironmentCommand(
  action: EnvironmentControlAction,
  value: boolean | number,
): Promise<void> {
  if (environmentCommandDisabled.value) return;

  const body = mapEnvironmentControlFormToContract(
    environmentControlForm.value,
    action,
    value,
  );

  environmentSubmittingAction.value = action;
  try {
    const command = await commandEnvironment(machineId.value, body);
    syncEnvironmentCommandStateFromMachine(command);
    const terminalFeedback = environmentControlFeedback(action, command);
    if (terminalFeedback) {
      void message[terminalFeedback.type](terminalFeedback.content);
    }
    if (
      command.commandNo &&
      !isEnvironmentCommandTerminalStatus(command.status)
    ) {
      const poller = startEnvironmentCommandPoller({
        commandNo: command.commandNo,
        fetchMachine: () => getMachine(machineId.value),
        isActive: () =>
          environmentSubmittingAction.value !== null &&
          machineId.value === machine.value?.id,
        onCommand: (commandSnapshot) => {
          syncEnvironmentCommandStateFromMachine(commandSnapshot);
          const polledFeedback = environmentControlFeedback(
            action,
            commandSnapshot,
          );
          if (polledFeedback) {
            void message[polledFeedback.type](polledFeedback.content);
          }
        },
      });
      environmentCommandPoller.value = poller;
      void poller.promise
        .finally(() => {
          if (environmentCommandPoller.value === poller) {
            environmentCommandPoller.value = null;
          }
          environmentSubmittingAction.value = null;
        })
        .catch(() => undefined);
      return;
    }
    return;
  } finally {
    if (environmentCommandPoller.value === null) {
      environmentSubmittingAction.value = null;
    }
  }
}

function openAdjust(row: Inventory): void {
  adjustInventoryRow.value = row;
  adjustForm.value = { deltaQty: 0, note: "" };
  adjustModalOpen.value = true;
}

async function saveAdjust(): Promise<void> {
  if (!adjustInventoryRow.value) return;
  adjustSaving.value = true;
  try {
    await adjustInventory({
      inventoryId: adjustInventoryRow.value.id,
      deltaQty: adjustForm.value.deltaQty,
      note: adjustForm.value.note || "single machine inventory adjustment",
    });
    adjustModalOpen.value = false;
    await loadInventoryData();
  } finally {
    adjustSaving.value = false;
  }
}

async function handleRequestLogExport(): Promise<void> {
  if (!machine.value) return;
  exportingLogs.value = true;
  try {
    const op = await requestLogExport(machine.value.id);
    Modal.success({
      title: "日志导出请求已创建",
      content: `运维请求 ID：${op.id}`,
    });
    await loadOps();
  } catch (error) {
    Modal.error({ title: "请求失败", content: String(error) });
  } finally {
    exportingLogs.value = false;
  }
}

async function openReconciliationCase(
  row: StockReconciliationCaseSummary,
): Promise<void> {
  reconciliationDetail.value = await getStockReconciliationCase(row.id);
  reconciliationForm.value = {
    note: "",
    correctedOnHandQty:
      reconciliationDetail.value.evidence.inventory?.onHandQty ?? 0,
    clearBlocker: false,
  };
  reconciliationModalOpen.value = true;
}

async function saveReconciliation(
  action: "reject_machine_stock" | "manual_correct",
): Promise<void> {
  if (!reconciliationDetail.value) return;
  reconciliationSaving.value = true;
  try {
    const request =
      action === "manual_correct"
        ? {
            action,
            note: reconciliationForm.value.note,
            clearBlocker: reconciliationForm.value.clearBlocker,
            correctedOnHandQty: reconciliationForm.value.correctedOnHandQty,
          }
        : {
            action,
            note: reconciliationForm.value.note,
            clearBlocker: reconciliationForm.value.clearBlocker,
          };
    await resolveStockReconciliationCase(
      reconciliationDetail.value.id,
      request,
    );
    reconciliationModalOpen.value = false;
    await Promise.all([loadInventoryData(), loadReconciliationCases()]);
  } finally {
    reconciliationSaving.value = false;
  }
}

onMounted(() => {
  void refreshAll();
});

onBeforeUnmount(() => {
  stopEnvironmentCommandPoller();
});
</script>

<template>
  <section class="flex flex-col gap-4">
    <a-card>
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <a-button type="link" class="px-0" @click="router.push('/machines')">
            返回机器列表
          </a-button>
          <h1 class="mt-1 text-xl font-semibold">
            {{ machine?.code ?? "机器" }} · {{ machine?.name ?? "加载中" }}
          </h1>
          <p class="mt-1 text-sm text-slate-500">
            {{ machine?.locationLabel ?? "未设置位置标签" }}
          </p>
          <p class="mt-1 text-sm text-slate-500">
            固定地理坐标：
            {{ formatGeoLocation(machine?.geoLocation ?? null) }}
          </p>
        </div>
        <a-space>
          <a-button :loading="loading" @click="refreshAll">刷新</a-button>
          <a-button v-if="canWrite" @click="openEditMachine">编辑</a-button>
          <a-button
            v-if="canExportLogs"
            :loading="exportingLogs"
            @click="handleRequestLogExport"
          >
            导出日志
          </a-button>
        </a-space>
      </div>
    </a-card>

    <a-drawer
      v-model:open="machineDrawerOpen"
      title="编辑机器"
      :destroy-on-hidden="true"
    >
      <a-form layout="vertical" :preserve="false">
        <a-form-item label="名称">
          <a-input v-model:value="machineForm.name" />
        </a-form-item>
        <a-form-item label="位置标签">
          <a-input v-model:value="machineForm.locationLabel" />
        </a-form-item>
        <a-form-item label="配置固定地理坐标">
          <a-checkbox v-model:checked="machineForm.includeGeoLocation">
            启用固定地理坐标
          </a-checkbox>
          <p class="mt-1 text-xs text-slate-500">
            使用 WGS84 室外代表性站点坐标；不要填写 GCJ-02 或 BD-09 坐标。
          </p>
        </a-form-item>
        <a-form-item label="纬度 latitude">
          <a-input-number
            v-model:value="machineForm.geoLatitude"
            :min="-90"
            :max="90"
            :disabled="!machineForm.includeGeoLocation"
            class="w-full"
          />
        </a-form-item>
        <a-form-item label="经度 longitude">
          <a-input-number
            v-model:value="machineForm.geoLongitude"
            :min="-180"
            :max="180"
            :disabled="!machineForm.includeGeoLocation"
            class="w-full"
          />
        </a-form-item>
        <a-form-item label="IANA 时区">
          <a-input
            v-model:value="machineForm.geoTimezone"
            :disabled="!machineForm.includeGeoLocation"
          />
        </a-form-item>
        <a-button type="primary" :loading="machineSaving" @click="saveMachine">
          保存
        </a-button>
      </a-form>
    </a-drawer>

    <a-card>
      <div class="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 class="text-lg font-semibold">机器配置</h2>
        </div>
        <a-button v-if="canWrite" size="small" @click="openEditMachine">
          编辑基础信息
        </a-button>
      </div>
      <a-row :gutter="[16, 16]">
        <a-col :xs="24" :lg="12">
          <h3 class="mb-3 text-sm font-medium text-slate-900">基础信息</h3>
          <a-descriptions bordered :column="1" size="small">
            <a-descriptions-item label="机器编码">
              {{ machine?.code ?? "--" }}
            </a-descriptions-item>
            <a-descriptions-item label="机器名称">
              {{ machine?.name ?? "--" }}
            </a-descriptions-item>
            <a-descriptions-item label="位置标签">
              {{ machine?.locationLabel ?? "未设置" }}
            </a-descriptions-item>
            <a-descriptions-item label="固定地理坐标">
              {{ formatGeoLocation(machine?.geoLocation ?? null) }}
            </a-descriptions-item>
          </a-descriptions>
        </a-col>
        <a-col :xs="24" :lg="12">
          <h3
            class="mb-3 border-t border-slate-200 pt-4 text-sm font-medium text-slate-900 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-4"
          >
            机器上报配置
          </h3>
          <a-descriptions bordered :column="1" size="small">
            <a-descriptions-item label="音频总开关">
              {{
                reportedBooleanLabel(
                  reportedRuntimeConfiguration?.audioCues?.enabled,
                )
              }}
            </a-descriptions-item>
            <a-descriptions-item label="到店音频">
              {{
                reportedBooleanLabel(
                  reportedRuntimeConfiguration?.audioCues?.presenceEnabled,
                )
              }}
            </a-descriptions-item>
            <a-descriptions-item label="交易音频">
              {{
                reportedBooleanLabel(
                  reportedRuntimeConfiguration?.audioCues?.transactionEnabled,
                )
              }}
            </a-descriptions-item>
            <a-descriptions-item label="音量">
              {{
                reportedVolumeLabel(reportedRuntimeConfiguration?.audioVolume)
              }}
            </a-descriptions-item>
            <a-descriptions-item label="视觉推荐">
              {{
                reportedBooleanLabel(
                  reportedRuntimeConfiguration?.visionRecommendationsEnabled,
                )
              }}
            </a-descriptions-item>
          </a-descriptions>
        </a-col>
      </a-row>
    </a-card>

    <a-row :gutter="[16, 16]">
      <a-col :xs="24" :lg="12">
        <a-card title="运行状态" :loading="loading && !machine">
          <a-descriptions bordered :column="1" size="small">
            <a-descriptions-item label="机器状态">
              <a-tag
                :color="machineStatusColor[machine?.status ?? ''] ?? 'default'"
              >
                {{ machine?.status ?? "unknown" }}
              </a-tag>
            </a-descriptions-item>
            <a-descriptions-item label="最近心跳">
              {{
                formatDateTime(
                  machine?.latestHeartbeatReportedAt ?? machine?.lastSeenAt,
                )
              }}
            </a-descriptions-item>
            <a-descriptions-item label="网络">
              {{ heartbeat?.network ?? "unknown" }}
            </a-descriptions-item>
            <a-descriptions-item label="MQTT">
              {{
                heartbeat?.mqttConnected === true
                  ? "已连接"
                  : heartbeat?.mqttConnected === false
                    ? "未连接"
                    : "unknown"
              }}
            </a-descriptions-item>
            <a-descriptions-item label="硬件">
              <a-tag
                :color="
                  hardwareStatusColor[heartbeat?.hardwareStatus ?? ''] ??
                  'default'
                "
              >
                {{ hardwareStatusLabel(heartbeat?.hardwareStatus) }}
              </a-tag>
            </a-descriptions-item>
            <a-descriptions-item
              v-if="wholeMachineMaintenanceLock"
              label="整机维护锁"
            >
              <a-tag color="error">{{
                wholeMachineMaintenanceLock.code
              }}</a-tag>
              <div class="mt-1 text-xs text-slate-500">
                {{ wholeMachineMaintenanceLock.message }}
              </div>
              <div class="mt-1 text-xs text-slate-500">
                货道
                {{ wholeMachineMaintenanceLock.slotDisplayLabel ?? "--" }} ·
                命令
                {{ wholeMachineMaintenanceLock.commandNo ?? "--" }}
              </div>
            </a-descriptions-item>
            <a-descriptions-item label="本地队列">
              {{ heartbeat?.localQueueSize ?? "--" }}
            </a-descriptions-item>
            <a-descriptions-item label="最新命令">
              {{ commandStatusLabel(environmentCommandStatus) }}
            </a-descriptions-item>
          </a-descriptions>
        </a-card>
      </a-col>

      <a-col :xs="24" :lg="12">
        <MachineEnvironmentCard
          :environment="environment"
          :command-status="environmentCommandStatus"
          :form="environmentControlForm"
          :can-command="canCommand"
          :submitting-action="environmentSubmittingAction"
          :controls-disabled="environmentCommandDisabled"
          :target-temperature-invalid="targetTemperatureInvalid"
          @command="submitEnvironmentCommand"
        />
      </a-col>
    </a-row>

    <a-card title="外部自然环境">
      <div class="mb-4 flex flex-wrap items-start justify-between gap-3">
        <a-space>
          <a-tag
            :color="
              externalNaturalEnvironmentStatusColor(
                externalNaturalEnvironment?.status,
              )
            "
          >
            {{
              externalNaturalEnvironmentStatusLabel(
                externalNaturalEnvironment?.status,
              )
            }}
          </a-tag>
          <span class="text-sm text-slate-500">
            检查时间 {{ formatDateTime(externalNaturalEnvironment?.checkedAt) }}
          </span>
        </a-space>
      </div>
      <a-row :gutter="[16, 16]">
        <a-col :xs="24" :lg="12">
          <a-descriptions bordered :column="1" size="small">
            <a-descriptions-item label="机器">
              {{
                externalNaturalEnvironment?.machineCode ?? machine?.code ?? "--"
              }}
            </a-descriptions-item>
            <a-descriptions-item label="本地时间">
              {{ formatLocalTime(externalNaturalEnvironment?.localTime) }}
            </a-descriptions-item>
            <a-descriptions-item label="日出">
              {{ formatDateTime(externalNaturalEnvironment?.sun?.sunriseAt) }}
            </a-descriptions-item>
            <a-descriptions-item label="日落">
              {{ formatDateTime(externalNaturalEnvironment?.sun?.sunsetAt) }}
            </a-descriptions-item>
          </a-descriptions>
        </a-col>
        <a-col :xs="24" :lg="12">
          <a-descriptions bordered :column="1" size="small">
            <a-descriptions-item label="天气状态">
              <a-tag
                :color="
                  externalNaturalEnvironmentStatusColor(
                    externalNaturalEnvironment?.weather?.status,
                  )
                "
              >
                {{
                  externalNaturalEnvironmentStatusLabel(
                    externalNaturalEnvironment?.weather?.status,
                  )
                }}
              </a-tag>
            </a-descriptions-item>
            <a-descriptions-item label="温度">
              {{
                formatExternalTemperature(
                  externalNaturalEnvironment?.weather?.temperatureCelsius,
                )
              }}
            </a-descriptions-item>
            <a-descriptions-item label="天气">
              {{ externalNaturalEnvironment?.weather?.conditionText ?? "--" }}
              <span
                v-if="externalNaturalEnvironment?.weather?.conditionCode"
                class="ml-1 text-xs text-slate-500"
              >
                {{ externalNaturalEnvironment.weather.conditionCode }}
              </span>
            </a-descriptions-item>
            <a-descriptions-item label="观测时间">
              {{
                formatDateTime(externalNaturalEnvironment?.weather?.observedAt)
              }}
            </a-descriptions-item>
            <a-descriptions-item label="风力">
              <template
                v-if="
                  externalNaturalEnvironment?.weather?.windScale !== undefined
                "
              >
                {{ externalNaturalEnvironment.weather.windScale }} 级
              </template>
              <template v-else>--</template>
              <span
                v-if="
                  externalNaturalEnvironment?.weather?.windSpeedKph !==
                  undefined
                "
                class="ml-1 text-xs text-slate-500"
              >
                {{ externalNaturalEnvironment.weather.windSpeedKph }} km/h
              </span>
            </a-descriptions-item>
            <a-descriptions-item label="体验天气分类">
              {{
                formatWeatherConditionClasses(
                  externalNaturalEnvironment?.weather?.weatherConditionClasses,
                )
              }}
            </a-descriptions-item>
            <a-descriptions-item label="主要体验分类">
              {{
                externalNaturalEnvironment?.weather
                  ?.primaryWeatherConditionClass
                  ? weatherConditionClassLabel(
                      externalNaturalEnvironment.weather
                        .primaryWeatherConditionClass,
                    )
                  : "--"
              }}
            </a-descriptions-item>
          </a-descriptions>
        </a-col>
      </a-row>
      <div
        v-if="
          externalNaturalEnvironmentDiagnostic ||
          externalNaturalEnvironment?.weather?.diagnostic ||
          externalNaturalEnvironment?.sun?.diagnostic ||
          externalNaturalEnvironment?.calendar?.diagnostic
        "
        class="mt-4 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
      >
        <div v-if="externalNaturalEnvironmentDiagnostic">
          {{ externalDiagnosticMessage(externalNaturalEnvironmentDiagnostic) }}
        </div>
        <div v-if="externalNaturalEnvironment?.weather?.diagnostic">
          天气：{{
            externalDiagnosticMessage(
              externalNaturalEnvironment.weather.diagnostic,
            )
          }}
        </div>
        <div v-if="externalNaturalEnvironment?.sun?.diagnostic">
          日照：{{
            externalDiagnosticMessage(externalNaturalEnvironment.sun.diagnostic)
          }}
        </div>
        <div v-if="externalNaturalEnvironment?.calendar?.diagnostic">
          日历：{{
            externalDiagnosticMessage(
              externalNaturalEnvironment.calendar.diagnostic,
            )
          }}
        </div>
      </div>
    </a-card>

    <a-card title="货道与库存">
      <a-table
        :columns="slotColumns"
        :data-source="slotRows"
        row-key="id"
        :loading="loading && slotRows.length === 0"
        :pagination="false"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'coordinate'">
            {{ formatMachineSlotCoordinate(record) }}
          </template>
          <template v-else-if="column.key === 'status'">
            <a-tag
              :color="
                slotStatusColor[record.status as MachineSlotStatus] ?? 'default'
              "
            >
              {{ record.status }}
            </a-tag>
          </template>
          <template v-else-if="column.key === 'product'">
            <template v-if="record.inventory">
              <div>
                {{ record.inventory.productName ?? record.inventory.sku }}
              </div>
              <div class="text-xs text-slate-500">
                {{ record.inventory.sku }}
              </div>
            </template>
            <span v-else class="text-slate-400">未绑定库存</span>
          </template>
          <template v-else-if="column.key === 'stock'">
            <template v-if="record.inventory">
              在库 {{ record.inventory.onHandQty }} · 预占
              {{ record.inventory.reservedQty }} · 可售
              {{ inventoryAvailableQty(record.inventory) }}
              <a-tag
                v-if="
                  inventoryAvailableQty(record.inventory) <=
                  record.inventory.lowStockThreshold
                "
                color="warning"
                class="ml-1"
              >
                库存预警
              </a-tag>
            </template>
            <span v-else>--</span>
          </template>
          <template v-else-if="column.key === 'actions'">
            <a-space v-if="record.inventory">
              <a-button
                v-if="canAdjust"
                size="small"
                @click="openAdjust(record.inventory)"
              >
                调整
              </a-button>
            </a-space>
          </template>
        </template>
      </a-table>
    </a-card>

    <a-card title="库存异常复核">
      <h2 class="mb-3 text-base font-medium">库存异常复核</h2>
      <a-table
        :columns="reconciliationColumns"
        :data-source="reconciliationCases"
        row-key="id"
        :loading="loading && reconciliationCases.length === 0"
        :pagination="false"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'slot'">
            {{ record.slot.code ?? record.slot.id }}
          </template>
          <template v-else-if="column.key === 'blocker'">
            <template v-if="record.blocker">
              <a-tag color="error">{{ record.blocker.state }}</a-tag>
              <div class="text-xs text-slate-500">
                {{ record.blocker.reason ?? "--" }}
              </div>
            </template>
            <span v-else>--</span>
          </template>
          <template v-else-if="column.key === 'eligibility'">
            <a-tag
              :color="
                record.slot.saleEligibility.eligible ? 'success' : 'error'
              "
            >
              {{ record.slot.saleEligibility.eligible ? "可售" : "不可售" }}
            </a-tag>
            <span class="ml-1 text-xs text-slate-500">
              {{ record.slot.saleEligibility.slotSalesState }}
            </span>
          </template>
          <template v-else-if="column.key === 'linked'">
            <div>{{ record.blocker?.linkedOrderNo ?? "--" }}</div>
            <div class="text-xs text-slate-500">
              {{ record.blocker?.linkedCommandNo ?? "--" }}
            </div>
          </template>
          <template v-else-if="column.key === 'receivedAt'">
            {{ formatDateTime(record.receivedAt) }}
          </template>
          <template v-else-if="column.key === 'actions'">
            <a-button
              v-if="canReviewStockReconciliation"
              size="small"
              @click="openReconciliationCase(record)"
            >
              复核
            </a-button>
          </template>
        </template>
      </a-table>
    </a-card>

    <a-card title="远程运维操作">
      <a-table
        :columns="opColumns"
        :data-source="ops"
        row-key="id"
        :loading="loading && ops.length === 0"
        :pagination="false"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'status'">
            <a-tag :color="commandStatusColor[record.status] ?? 'default'">
              {{ record.status }}
            </a-tag>
          </template>
          <template v-else-if="column.key === 'requestedAt'">
            {{ formatDateTime(record.requestedAt) }}
          </template>
          <template v-else-if="column.key === 'finishedAt'">
            {{ formatDateTime(record.finishedAt) }}
          </template>
          <template v-else-if="column.key === 'failedReason'">
            {{ record.failedReason ?? "--" }}
          </template>
        </template>
      </a-table>
    </a-card>

    <a-modal
      v-model:open="reconciliationModalOpen"
      title="库存异常复核"
      :confirm-loading="reconciliationSaving"
    >
      <a-form layout="vertical">
        <a-form-item label="货道">
          {{
            reconciliationDetail?.slot?.code ??
            reconciliationDetail?.slot?.id ??
            "--"
          }}
        </a-form-item>
        <a-form-item label="证据">
          <pre class="max-h-40 overflow-auto text-xs">{{
            JSON.stringify(
              reconciliationDetail?.evidence.rawPayload ?? {},
              null,
              2,
            )
          }}</pre>
        </a-form-item>
        <a-form-item label="复核备注">
          <a-input v-model:value="reconciliationForm.note" />
        </a-form-item>
        <a-form-item label="修正后在库">
          <a-input-number
            v-model:value="reconciliationForm.correctedOnHandQty"
            :min="0"
            class="w-full"
          />
        </a-form-item>
        <a-form-item v-if="reconciliationDetail?.blocker" label="货道冻结">
          <a-checkbox v-model:checked="reconciliationForm.clearBlocker">
            复核后清除当前冻结
          </a-checkbox>
        </a-form-item>
        <a-space>
          <a-button
            :loading="reconciliationSaving"
            @click="saveReconciliation('reject_machine_stock')"
          >
            拒绝
          </a-button>
          <a-button
            :loading="reconciliationSaving"
            @click="saveReconciliation('manual_correct')"
          >
            修正
          </a-button>
        </a-space>
      </a-form>
    </a-modal>

    <a-modal
      v-model:open="adjustModalOpen"
      title="单机库存调整"
      :confirm-loading="adjustSaving"
      @ok="saveAdjust"
    >
      <a-form layout="vertical">
        <a-form-item label="商品">
          {{ adjustInventoryRow?.productName ?? adjustInventoryRow?.sku }}
        </a-form-item>
        <a-form-item label="货道">
          {{ inventorySlotCoordinateLabel(adjustInventoryRow) }}
        </a-form-item>
        <a-form-item label="调整数量（正数补充，负数扣减）">
          <a-input-number v-model:value="adjustForm.deltaQty" class="w-full" />
        </a-form-item>
        <a-form-item label="备注">
          <a-input v-model:value="adjustForm.note" />
        </a-form-item>
      </a-form>
    </a-modal>
  </section>
</template>
