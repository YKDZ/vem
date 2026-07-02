<script setup lang="ts">
import type {
  MachineCommandStatus,
  MachineEnvironmentControlRequest,
  MachineSlotStatus,
} from "@vem/shared";

import { formatMachineSlotCoordinate } from "@vem/shared";
import { Modal } from "antdv-next";
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";

import {
  adjustInventory,
  getStockReconciliationCase,
  listInventories,
  listStockReconciliationCases,
  refillInventory,
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
  getMachine,
  listMachineSlots,
  type Machine,
  type MachineGeoLocation,
  type MachineSlot,
} from "@/api/machines";
import { useAuthStore } from "@/stores/auth";
import { formatDateTime } from "@/utils/format";

type MachineSaleReadinessHeartbeat = {
  state?: "locked" | "blocked" | "restored";
  blockingCodes?: string[];
};

type WholeMachineMaintenanceLockHeartbeat = {
  code?: string;
  message?: string;
  slotCode?: string;
  commandNo?: string;
};

const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();

const canCommand = authStore.hasPermission("machines.command");
const canRefill = authStore.hasPermission("inventory.refill");
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

const environmentControlForm = ref({
  includeAirConditioner: false,
  airConditionerOn: false,
  includeTargetTemperature: false,
  targetTemperatureCelsius: 24,
});
const environmentSubmitting = ref(false);
const environmentCommandStatus = ref<MachineCommandStatus | null>(null);
const exportingLogs = ref(false);

const refillModalOpen = ref(false);
const refillSaving = ref(false);
const refillInventoryRow = ref<Inventory | null>(null);
const refillForm = ref({ quantity: 1, note: "" });

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
  if (!environmentControlForm.value.includeTargetTemperature) return false;
  const value = environmentControlForm.value.targetTemperatureCelsius;
  return value < 18 || value > 30;
});

const environmentCommandDisabled = computed(
  () =>
    !canCommand ||
    environmentSubmitting.value ||
    targetTemperatureInvalid.value ||
    (!environmentControlForm.value.includeAirConditioner &&
      !environmentControlForm.value.includeTargetTemperature),
);

const heartbeat = computed(() => machine.value?.latestHeartbeatStatus ?? null);
const productionPilotReadiness = computed(
  () => machine.value?.productionPilotReadiness ?? null,
);
const saleReadiness = computed(
  () =>
    (heartbeat.value?.saleReadiness as MachineSaleReadinessHeartbeat | null) ??
    null,
);
const wholeMachineMaintenanceLock = computed(
  () =>
    (heartbeat.value
      ?.wholeMachineMaintenanceLock as WholeMachineMaintenanceLockHeartbeat | null) ??
    null,
);
const environment = computed(() => machine.value?.latestEnvironment ?? null);

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

const productionPilotReadinessColumns = [
  { title: "检查项", dataIndex: "label", key: "label" },
  { title: "状态", dataIndex: "status", key: "status" },
  { title: "说明", dataIndex: "message", key: "message" },
  { title: "操作建议", dataIndex: "operatorAction", key: "operatorAction" },
  { title: "代码", dataIndex: "code", key: "code" },
];

function formatEnvironmentNumber(
  value: number | undefined,
  suffix: string,
): string {
  if (typeof value !== "number") return `-- ${suffix}`;
  const formatted = Number.isInteger(value) ? String(value) : value.toFixed(1);
  return suffix.startsWith("%")
    ? `${formatted}${suffix}`
    : `${formatted} ${suffix}`;
}

function sensorStatusLabel(status: string | undefined): string {
  if (status === "ok") return "传感器正常";
  if (status === "faulted") return "传感器故障";
  return "传感器未知";
}

function airConditionerLabel(on: boolean | undefined): string {
  if (on === true) return "空调开";
  if (on === false) return "空调关";
  return "空调未知";
}

function targetTemperatureLabel(value: number | null | undefined): string {
  if (typeof value !== "number") return "目标未知";
  return `目标 ${formatEnvironmentNumber(value, "C")}`;
}

function formatGeoLocation(geoLocation: MachineGeoLocation | null): string {
  if (!geoLocation) return "未配置";
  return `${geoLocation.latitude}, ${geoLocation.longitude} · ${geoLocation.timezone}`;
}

function commandStatusLabel(status: MachineCommandStatus | null): string {
  if (status === "pending") return "命令待发送";
  if (status === "sent") return "命令已发送";
  if (status === "acknowledged") return "命令已确认";
  if (status === "succeeded") return "命令成功";
  if (status === "failed") return "命令失败";
  if (status === "timeout") return "命令超时";
  return "命令状态未知";
}

function hardwareStatusLabel(status: string | undefined): string {
  if (status === "ok") return "正常";
  if (status === "degraded") return "降级";
  if (status === "faulted") return "异常";
  return "unknown";
}

function saleReadinessStateLabel(status: string | undefined): string {
  if (status === "locked") return "整机锁定";
  if (status === "blocked") return "阻塞";
  if (status === "restored") return "已恢复";
  return "unknown";
}

function saleReadinessStateColor(status: string | undefined): string {
  if (status === "locked") return "error";
  if (status === "blocked") return "warning";
  if (status === "restored") return "success";
  return "default";
}

function productionPilotReadinessStatusLabel(
  status: string | undefined,
): string {
  if (status === "ready") return "生产试运营就绪";
  if (status === "blocked") return "生产试运营阻塞";
  if (status === "degraded") return "生产试运营降级";
  return "生产试运营未知";
}

function readinessCheckStatusColor(status: string | undefined): string {
  if (status === "ready") return "success";
  if (status === "degraded") return "warning";
  if (status === "blocked") return "error";
  if (status === "missing") return "default";
  return "default";
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
  environmentControlForm.value = {
    includeAirConditioner: false,
    airConditionerOn: nextMachine.latestEnvironment?.airConditionerOn ?? false,
    includeTargetTemperature: false,
    targetTemperatureCelsius:
      nextMachine.latestEnvironment?.targetTemperatureCelsius ?? 24,
  };
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
      loadInventoryData(),
      loadOps(),
      loadReconciliationCases(),
    ]);
  } finally {
    loading.value = false;
  }
}

async function submitEnvironmentCommand(): Promise<void> {
  if (environmentCommandDisabled.value) return;
  const body: MachineEnvironmentControlRequest = {};
  if (environmentControlForm.value.includeAirConditioner) {
    body.airConditionerOn = environmentControlForm.value.airConditionerOn;
  }
  if (environmentControlForm.value.includeTargetTemperature) {
    body.targetTemperatureCelsius =
      environmentControlForm.value.targetTemperatureCelsius;
  }

  environmentSubmitting.value = true;
  try {
    const command = await commandEnvironment(machineId.value, body);
    environmentCommandStatus.value = command.status;
    await loadMachine();
  } finally {
    environmentSubmitting.value = false;
  }
}

function openRefill(row: Inventory): void {
  refillInventoryRow.value = row;
  refillForm.value = { quantity: 1, note: "" };
  refillModalOpen.value = true;
}

async function saveRefill(): Promise<void> {
  if (!refillInventoryRow.value) return;
  refillSaving.value = true;
  try {
    await refillInventory({
      inventoryId: refillInventoryRow.value.id,
      quantity: refillForm.value.quantity,
      note: refillForm.value.note || undefined,
    });
    refillModalOpen.value = false;
    await loadInventoryData();
  } finally {
    refillSaving.value = false;
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
  action: "accept_machine_stock" | "reject_machine_stock" | "manual_correct",
): Promise<void> {
  if (!reconciliationDetail.value) return;
  reconciliationSaving.value = true;
  try {
    await resolveStockReconciliationCase(reconciliationDetail.value.id, {
      action,
      note: reconciliationForm.value.note,
      clearBlocker: reconciliationForm.value.clearBlocker,
      correctedOnHandQty:
        action === "manual_correct"
          ? reconciliationForm.value.correctedOnHandQty
          : undefined,
    });
    reconciliationModalOpen.value = false;
    await Promise.all([loadInventoryData(), loadReconciliationCases()]);
  } finally {
    reconciliationSaving.value = false;
  }
}

onMounted(() => {
  void refreshAll();
});
</script>

<template>
  <section class="space-y-8">
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
            {{ machine?.locationLabel ?? "未设置 Machine Location Label" }}
          </p>
          <p class="mt-1 text-sm text-slate-500">
            Machine Geo Location:
            {{ formatGeoLocation(machine?.geoLocation ?? null) }}
          </p>
        </div>
        <a-space>
          <a-button :loading="loading" @click="refreshAll">刷新</a-button>
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
            <a-descriptions-item label="销售就绪">
              <a-tag :color="saleReadinessStateColor(saleReadiness?.state)">
                {{ saleReadinessStateLabel(saleReadiness?.state) }}
              </a-tag>
              <span v-if="saleReadiness?.blockingCodes?.length" class="ml-2">
                {{ saleReadiness.blockingCodes.join("、") }}
              </span>
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
                货道 {{ wholeMachineMaintenanceLock.slotCode ?? "--" }} · 命令
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
        <a-card title="环境与空调">
          <a-descriptions bordered :column="1" size="small">
            <a-descriptions-item label="温度">
              {{
                formatEnvironmentNumber(environment?.temperatureCelsius, "C")
              }}
            </a-descriptions-item>
            <a-descriptions-item label="湿度">
              {{ formatEnvironmentNumber(environment?.humidityRh, "% RH") }}
            </a-descriptions-item>
            <a-descriptions-item label="采样时间">
              {{ formatDateTime(environment?.sampledAt) }}
            </a-descriptions-item>
            <a-descriptions-item label="传感器">
              {{ sensorStatusLabel(environment?.sensorStatus) }}
            </a-descriptions-item>
            <a-descriptions-item label="空调">
              {{ airConditionerLabel(environment?.airConditionerOn) }}
            </a-descriptions-item>
            <a-descriptions-item label="目标温度">
              {{
                targetTemperatureLabel(environment?.targetTemperatureCelsius)
              }}
            </a-descriptions-item>
          </a-descriptions>

          <a-form layout="vertical" class="mt-4">
            <a-form-item label="控制动作">
              <div class="space-y-2">
                <div class="flex items-center gap-3">
                  <a-checkbox
                    v-model:checked="
                      environmentControlForm.includeAirConditioner
                    "
                    :disabled="!canCommand || environmentSubmitting"
                  >
                    设置空调开关
                  </a-checkbox>
                  <a-switch
                    v-model:checked="environmentControlForm.airConditionerOn"
                    :disabled="
                      !canCommand ||
                      environmentSubmitting ||
                      !environmentControlForm.includeAirConditioner
                    "
                  >
                    {{ environmentControlForm.airConditionerOn ? "开" : "关" }}
                  </a-switch>
                </div>
                <div class="flex items-center gap-3">
                  <a-checkbox
                    v-model:checked="
                      environmentControlForm.includeTargetTemperature
                    "
                    :disabled="!canCommand || environmentSubmitting"
                  >
                    设置目标温度
                  </a-checkbox>
                  <a-input-number
                    v-model:value="
                      environmentControlForm.targetTemperatureCelsius
                    "
                    :min="18"
                    :max="30"
                    :disabled="
                      !canCommand ||
                      environmentSubmitting ||
                      !environmentControlForm.includeTargetTemperature
                    "
                    class="w-28"
                  />
                  <span>C</span>
                </div>
                <div
                  v-if="targetTemperatureInvalid"
                  class="text-xs text-red-600"
                >
                  目标温度必须在 18-30 C
                </div>
                <div v-if="!canCommand" class="text-xs text-gray-500">
                  无机器控制权限
                </div>
              </div>
            </a-form-item>
            <a-button
              v-if="canCommand"
              type="primary"
              :loading="environmentSubmitting"
              :disabled="environmentCommandDisabled"
              @click="submitEnvironmentCommand"
            >
              提交环境控制
            </a-button>
          </a-form>
        </a-card>
      </a-col>
    </a-row>

    <a-card v-if="productionPilotReadiness">
      <div class="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 class="text-lg font-semibold">Production Pilot Readiness</h2>
          <p class="mt-1 text-sm text-slate-500">
            区分生产试运营就绪、普通运行健康与 Machine Sale Readiness
          </p>
        </div>
        <a-space>
          <a-tag
            :color="readinessCheckStatusColor(productionPilotReadiness.status)"
          >
            {{
              productionPilotReadinessStatusLabel(
                productionPilotReadiness.status,
              )
            }}
          </a-tag>
          <span class="text-sm text-slate-500">
            阻塞 {{ productionPilotReadiness.blockers.length }} · 降级
            {{ productionPilotReadiness.degraded.length }}
          </span>
        </a-space>
      </div>
      <a-table
        :columns="productionPilotReadinessColumns"
        :data-source="productionPilotReadiness.checks"
        row-key="code"
        :pagination="false"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'status'">
            <a-tag :color="readinessCheckStatusColor(record.status)">
              {{ record.status }}
            </a-tag>
          </template>
          <template v-else-if="column.key === 'code'">
            <span class="font-mono text-xs">{{ record.code }}</span>
          </template>
          <template v-else-if="column.key === 'label'">
            {{ record.label }}
          </template>
          <template v-else-if="column.key === 'message'">
            {{ record.message }}
          </template>
          <template v-else-if="column.key === 'operatorAction'">
            {{ record.operatorAction }}
          </template>
        </template>
      </a-table>
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
                v-if="canRefill"
                size="small"
                @click="openRefill(record.inventory)"
              >
                补货
              </a-button>
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
      v-model:open="refillModalOpen"
      title="单机补货"
      :confirm-loading="refillSaving"
      @ok="saveRefill"
    >
      <a-form layout="vertical">
        <a-form-item label="商品">
          {{ refillInventoryRow?.productName ?? refillInventoryRow?.sku }}
        </a-form-item>
        <a-form-item label="货道">
          {{ inventorySlotCoordinateLabel(refillInventoryRow) }}
        </a-form-item>
        <a-form-item label="补货数量">
          <a-input-number
            v-model:value="refillForm.quantity"
            :min="1"
            class="w-full"
          />
        </a-form-item>
        <a-form-item label="备注">
          <a-input v-model:value="refillForm.note" />
        </a-form-item>
      </a-form>
    </a-modal>

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
            @click="saveReconciliation('accept_machine_stock')"
          >
            接受
          </a-button>
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
