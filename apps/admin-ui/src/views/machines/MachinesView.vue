<script setup lang="ts">
import type {
  MachineClaimCodePurpose,
  MachineClaimCodeState,
  MachineCommandStatus,
  MachineSlotStatus,
} from "@vem/shared";

import {
  formatMachineSlotCoordinate,
  getMachineSlotMaxCellNo,
  MACHINE_SLOT_MAX_LAYER_NO,
  MACHINE_SLOT_MIN_LAYER_NO,
  machineSlotCoordinateErrorMessage,
} from "@vem/shared";
import { Modal } from "antdv-next";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";

import { requestLogExport } from "@/api/machine-ops";
import {
  commandEnvironment,
  createMachine,
  createMachineSlot,
  generateMachineClaimCode,
  getMachine,
  listMachineClaimCodes,
  listMachineSlots,
  listMachines,
  revokeMachineClaimCode,
  rotateMachineCredentials,
  updateMachine,
  type GenerateMachineClaimCodeResult,
  type Machine,
  type MachineGeoLocation,
  type MachineClaimCodeSnapshot,
  type MachineSlot,
  type PageResult,
  type RotateCredentialsResult,
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
  mapMachineFormToContract,
  mapSlotFormToContract,
} from "./machine-contract-mappers";
import {
  formatEnvironmentNumber,
  sensorStatusLabel,
} from "./machine-environment-display";
import MachineEnvironmentCard from "./MachineEnvironmentCard.vue";

const authStore = useAuthStore();
const router = useRouter();
const canWrite = authStore.hasPermission("machines.write");
const canCommand = authStore.hasPermission("machines.command");
const canManageCredentials = authStore.hasPermission(
  "machines.manage-credentials",
);
const canExportLogs = authStore.hasPermission("machineOps.write");

const loading = ref(false);
const machines = ref<PageResult<Machine>>({
  items: [],
  total: 0,
  page: 1,
  pageSize: 20,
});

async function loadMachines(page = 1): Promise<void> {
  loading.value = true;
  try {
    machines.value = await listMachines({ page, pageSize: 20 });
  } finally {
    loading.value = false;
  }
}

async function openMachineDetail(m: Machine): Promise<void> {
  await router.push({ name: "machine-detail", params: { id: m.id } });
}

function openMachineDetailWindow(m: Machine): void {
  const href = router.resolve({
    name: "machine-detail",
    params: { id: m.id },
  }).href;
  window.open(href, "_blank", "noopener,noreferrer");
}

// Machine form / drawer
const machineDrawerOpen = ref(false);
const editingMachine = ref<Machine | null>(null);
const machineForm = ref({
  code: "",
  name: "",
  locationLabel: "",
  includeGeoLocation: false,
  geoLatitude: null as number | null,
  geoLongitude: null as number | null,
  geoTimezone: "Asia/Shanghai",
});
const machineSaving = ref(false);

function openCreateMachine(): void {
  editingMachine.value = null;
  machineForm.value = {
    code: "",
    name: "",
    locationLabel: "",
    includeGeoLocation: false,
    geoLatitude: null,
    geoLongitude: null,
    geoTimezone: "Asia/Shanghai",
  };
  machineDrawerOpen.value = true;
}

function openEditMachine(m: Machine): void {
  editingMachine.value = m;
  machineForm.value = {
    code: m.code,
    name: m.name,
    locationLabel: m.locationLabel ?? "",
    includeGeoLocation: m.geoLocation !== null,
    geoLatitude: m.geoLocation?.latitude ?? null,
    geoLongitude: m.geoLocation?.longitude ?? null,
    geoTimezone: m.geoLocation?.timezone ?? "Asia/Shanghai",
  };
  machineDrawerOpen.value = true;
}

async function saveMachine(): Promise<void> {
  let body:
    | ReturnType<typeof mapMachineFormToContract>
    | ReturnType<typeof mapMachineBasicsFormToUpdateContract>;
  try {
    if (editingMachine.value) {
      const { code: _code, ...basicForm } = machineForm.value;
      body = mapMachineBasicsFormToUpdateContract(basicForm);
    } else {
      body = mapMachineFormToContract(machineForm.value);
    }
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
    if (editingMachine.value) {
      await updateMachine(
        editingMachine.value.id,
        body as ReturnType<typeof mapMachineBasicsFormToUpdateContract>,
      );
    } else {
      await createMachine(body as ReturnType<typeof mapMachineFormToContract>);
    }
    machineDrawerOpen.value = false;
    await loadMachines();
  } finally {
    machineSaving.value = false;
  }
}

// Environment drawer
const environmentDrawerOpen = ref(false);
const environmentMachine = ref<Machine | null>(null);
const environmentLoading = ref(false);
const environmentCommandStatus = ref<MachineCommandStatus | null>(null);
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
const environmentSubmittingAction = ref<EnvironmentControlAction | null>(null);
const environmentCommandActionStatus = ref<
  Record<EnvironmentControlAction, MachineCommandStatus | null>
>({
  airConditionerOn: null,
  targetTemperatureCelsius: null,
  ventSpeed: null,
});
const environmentCommandActionPayload = ref<
  Record<EnvironmentControlAction, Record<string, unknown> | null>
>({ airConditionerOn: null, targetTemperatureCelsius: null, ventSpeed: null });
const environmentCommandActionResult = ref<
  Record<EnvironmentControlAction, Record<string, unknown> | null>
>({ airConditionerOn: null, targetTemperatureCelsius: null, ventSpeed: null });
const environmentCommandActionError = ref<
  Record<EnvironmentControlAction, string | null>
>({ airConditionerOn: null, targetTemperatureCelsius: null, ventSpeed: null });
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
    setActionStatus: (action, status) => {
      environmentCommandActionStatus.value[action] = status;
    },
    setActionPayload: (action, payload) => {
      environmentCommandActionPayload.value[action] = payload;
    },
    setActionResult: (action, result) => {
      environmentCommandActionResult.value[action] = result;
    },
    setActionError: (action, error) => {
      environmentCommandActionError.value[action] = error;
    },
  });
}

function clearEnvironmentControlActionStatus(): void {
  environmentCommandActionStatus.value = {
    airConditionerOn: null,
    targetTemperatureCelsius: null,
    ventSpeed: null,
  };
  environmentCommandActionPayload.value = {
    airConditionerOn: null,
    targetTemperatureCelsius: null,
    ventSpeed: null,
  };
  environmentCommandActionResult.value = {
    airConditionerOn: null,
    targetTemperatureCelsius: null,
    ventSpeed: null,
  };
  environmentCommandActionError.value = {
    airConditionerOn: null,
    targetTemperatureCelsius: null,
    ventSpeed: null,
  };
}
const targetTemperatureInvalid = computed(() => {
  const value = environmentControlForm.value.targetTemperatureCelsius;
  return value < 18 || value > 30;
});
const environmentCommandDisabled = computed(
  () =>
    !canCommand ||
    environmentSubmittingAction.value !== null ||
    ["pending", "sent", "acknowledged"].includes(
      environmentCommandStatus.value ?? "",
    ),
);
const environmentDrawerTitle = computed(() =>
  environmentMachine.value ? `环境 - ${environmentMachine.value.code}` : "环境",
);

async function openEnvironment(m: Machine): Promise<void> {
  stopEnvironmentCommandPoller();
  environmentMachine.value = m;
  environmentCommandStatus.value = null;
  environmentDrawerOpen.value = true;
  environmentLoading.value = true;
  try {
    environmentMachine.value = await getMachine(m.id);
    environmentCommandStatus.value =
      environmentMachine.value.latestEnvironmentCommand?.status ?? null;
    clearEnvironmentControlActionStatus();
    syncEnvironmentCommandStateFromMachine(
      environmentMachine.value.latestEnvironmentCommand,
    );
    environmentControlForm.value = defaultEnvironmentControlForm();
  } finally {
    environmentLoading.value = false;
  }
}

async function submitEnvironmentCommand(
  action: EnvironmentControlAction,
  value: boolean | number,
): Promise<void> {
  if (!environmentMachine.value || environmentCommandDisabled.value) return;
  const body = mapEnvironmentControlFormToContract(
    environmentControlForm.value,
    action,
    value,
  );

  environmentSubmittingAction.value = action;
  try {
    const command = await commandEnvironment(environmentMachine.value.id, body);
    syncEnvironmentCommandStateFromMachine(command);
    if (
      command.commandNo &&
      !isEnvironmentCommandTerminalStatus(command.status)
    ) {
      const machineId = environmentMachine.value.id;
      const poller = startEnvironmentCommandPoller({
        commandNo: command.commandNo,
        fetchMachine: () => getMachine(machineId),
        isActive: () =>
          environmentDrawerOpen.value &&
          environmentSubmittingAction.value !== null &&
          machineId === environmentMachine.value?.id,
        onCommand: (commandSnapshot) => {
          syncEnvironmentCommandStateFromMachine(commandSnapshot);
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
  } finally {
    if (environmentCommandPoller.value === null) {
      environmentSubmittingAction.value = null;
    }
  }
}

// Slots
const slotDrawerOpen = ref(false);
const currentMachineId = ref<string | null>(null);
const slots = ref<MachineSlot[]>([]);
const slotsLoading = ref(false);
const slotFormOpen = ref(false);
const slotForm = ref({
  layerNo: 1,
  cellNo: 1,
  slotCode: "",
  capacity: 10,
  status: "enabled" as MachineSlotStatus,
});
const slotSaving = ref(false);
const slotMaxCellNo = computed(
  () => getMachineSlotMaxCellNo(slotForm.value.layerNo) ?? 5,
);
const slotCoordinateError = computed(() =>
  machineSlotCoordinateErrorMessage(slotForm.value),
);

async function openSlots(m: Machine): Promise<void> {
  currentMachineId.value = m.id;
  slotDrawerOpen.value = true;
  slotsLoading.value = true;
  try {
    slots.value = await listMachineSlots(m.id);
  } finally {
    slotsLoading.value = false;
  }
}

function openCreateSlot(): void {
  slotForm.value = {
    layerNo: 1,
    cellNo: 1,
    slotCode: "",
    capacity: 10,
    status: "enabled",
  };
  slotFormOpen.value = true;
}

async function saveSlot(): Promise<void> {
  if (!currentMachineId.value) return;
  if (slotCoordinateError.value) {
    Modal.error({
      title: "货道坐标无效",
      content: slotCoordinateError.value,
    });
    return;
  }
  slotSaving.value = true;
  try {
    await createMachineSlot(
      currentMachineId.value,
      mapSlotFormToContract(slotForm.value),
    );
    slotFormOpen.value = false;
    slots.value = await listMachineSlots(currentMachineId.value);
  } finally {
    slotSaving.value = false;
  }
}

function formatGeoLocation(geoLocation: MachineGeoLocation | null): string {
  if (!geoLocation) return "未配置";
  return `${geoLocation.latitude}, ${geoLocation.longitude} · ${geoLocation.timezone}`;
}

const statusColor: Record<string, string> = {
  online: "success",
  offline: "default",
  maintenance: "warning",
  disabled: "error",
};

const machineColumns = [
  { title: "编码", dataIndex: "code", key: "code" },
  { title: "名称", dataIndex: "name", key: "name" },
  {
    title: "位置标签",
    dataIndex: "locationLabel",
    key: "locationLabel",
  },
  { title: "固定地理坐标", key: "geoLocation" },
  { title: "状态", dataIndex: "status", key: "status" },
  { title: "最近心跳", dataIndex: "lastSeenAt", key: "lastSeenAt" },
  { title: "环境", key: "environment" },
  { title: "操作", key: "actions" },
];

const slotColumns = [
  { title: "货道坐标", key: "coordinate" },
  { title: "容量", dataIndex: "capacity", key: "capacity" },
  { title: "状态", dataIndex: "status", key: "status" },
];

const slotStatusColor: Record<MachineSlotStatus, string> = {
  enabled: "success",
  disabled: "default",
  faulted: "error",
};

onMounted(() => {
  void loadMachines();
});

watch(environmentDrawerOpen, (open) => {
  if (!open) {
    stopEnvironmentCommandPoller();
    environmentSubmittingAction.value = null;
  }
});

onBeforeUnmount(() => {
  stopEnvironmentCommandPoller();
});

// Machine Claim Codes
const claimCodeDrawerOpen = ref(false);
const claimCodeMachine = ref<Machine | null>(null);
const claimCodes = ref<MachineClaimCodeSnapshot[]>([]);
const claimCodesLoading = ref(false);
const generatedClaimCode = ref<GenerateMachineClaimCodeResult | null>(null);
const generatingClaimCode = ref(false);
const revokingClaimCodeId = ref<string | null>(null);
const claimCodeDrawerTitle = computed(() =>
  claimCodeMachine.value ? `领取码 - ${claimCodeMachine.value.code}` : "领取码",
);

const claimCodeColumns = [
  { title: "用途", dataIndex: "purpose", key: "purpose" },
  { title: "状态", dataIndex: "state", key: "state" },
  { title: "失败次数", key: "failedAttempts" },
  { title: "过期时间", dataIndex: "expiresAt", key: "expiresAt" },
  { title: "创建时间", dataIndex: "createdAt", key: "createdAt" },
  { title: "操作", key: "actions" },
];

const claimCodeStateColor: Record<MachineClaimCodeState, string> = {
  pending: "processing",
  consumed: "success",
  expired: "default",
  revoked: "warning",
  locked: "error",
};

function claimCodeStateLabel(state: MachineClaimCodeState): string {
  if (state === "pending") return "待领取";
  if (state === "consumed") return "已领取";
  if (state === "expired") return "已过期";
  if (state === "revoked") return "已撤销";
  return "已锁定";
}

function claimCodePurposeLabel(
  purpose: MachineClaimCodePurpose | undefined,
): string {
  return purpose === "reclaim" ? "重新领取" : "首次领取";
}

async function loadClaimCodes(machineId: string): Promise<void> {
  claimCodesLoading.value = true;
  try {
    claimCodes.value = (await listMachineClaimCodes(machineId)).items;
  } finally {
    claimCodesLoading.value = false;
  }
}

async function openClaimCodes(m: Machine): Promise<void> {
  claimCodeMachine.value = m;
  generatedClaimCode.value = null;
  claimCodeDrawerOpen.value = true;
  await loadClaimCodes(m.id);
}

async function handleGenerateClaimCode(
  purpose: MachineClaimCodePurpose = "first_claim",
): Promise<void> {
  if (!claimCodeMachine.value) return;
  generatingClaimCode.value = true;
  try {
    generatedClaimCode.value =
      purpose === "reclaim"
        ? await generateMachineClaimCode(claimCodeMachine.value.id, { purpose })
        : await generateMachineClaimCode(claimCodeMachine.value.id);
    await loadClaimCodes(claimCodeMachine.value.id);
  } finally {
    generatingClaimCode.value = false;
  }
}

async function handleRevokeClaimCode(
  claimCode: MachineClaimCodeSnapshot,
): Promise<void> {
  if (!claimCodeMachine.value || claimCode.state !== "pending") return;
  revokingClaimCodeId.value = claimCode.id;
  try {
    await revokeMachineClaimCode(claimCodeMachine.value.id, claimCode.id);
    await loadClaimCodes(claimCodeMachine.value.id);
  } finally {
    revokingClaimCodeId.value = null;
  }
}

// Rotate credentials
const rotatingId = ref<string | null>(null);
const rotatedCredentials = ref<RotateCredentialsResult | null>(null);
const rotateModalOpen = ref(false);

function handleRotateCredentials(m: Machine): void {
  Modal.confirm({
    title: "确认轮换凭证",
    content: `确认要轮换机器 ${m.code} 的凭证吗？旧凭证将立即失效，需重新配置机器。`,
    okType: "danger",
    okText: "确认轮换",
    cancelText: "取消",
    async onOk() {
      rotatingId.value = m.id;
      try {
        rotatedCredentials.value = await rotateMachineCredentials(m.id);
        rotateModalOpen.value = true;
      } finally {
        rotatingId.value = null;
      }
    },
  });
}

const exportingLogId = ref<string | null>(null);
async function handleRequestLogExport(m: Machine): Promise<void> {
  exportingLogId.value = m.id;
  try {
    const op = await requestLogExport(m.id);
    Modal.success({
      title: "日志导出请求已创建",
      content: `运维请求 ID：${op.id}`,
    });
  } catch (e) {
    Modal.error({ title: "请求失败", content: String(e) });
  } finally {
    exportingLogId.value = null;
  }
}
</script>

<template>
  <section class="space-y-4">
    <a-card>
      <div class="mb-4 flex gap-3">
        <a-button v-if="canWrite" type="primary" @click="openCreateMachine">
          新增机器
        </a-button>
      </div>
      <a-table
        :columns="machineColumns"
        :data-source="machines.items"
        row-key="id"
        :loading="loading"
        :pagination="{
          current: machines.page,
          pageSize: machines.pageSize,
          total: machines.total,
          onChange: loadMachines,
        }"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'status'">
            <a-tag :color="statusColor[record.status] ?? 'default'">{{
              record.status
            }}</a-tag>
          </template>
          <template v-else-if="column.key === 'lastSeenAt'">
            {{ formatDateTime(record.lastSeenAt) }}
          </template>
          <template v-else-if="column.key === 'geoLocation'">
            <span class="text-xs">
              {{ formatGeoLocation(record.geoLocation) }}
            </span>
          </template>
          <template v-else-if="column.key === 'environment'">
            <div v-if="record.latestEnvironment" class="text-xs leading-5">
              <div>
                {{
                  formatEnvironmentNumber(
                    record.latestEnvironment.temperatureCelsius,
                    "C",
                  )
                }}
                ·
                {{
                  formatEnvironmentNumber(
                    record.latestEnvironment.humidityRh,
                    "% RH",
                  )
                }}
              </div>
              <div class="text-gray-500">
                {{ sensorStatusLabel(record.latestEnvironment.sensorStatus) }}
              </div>
            </div>
            <span v-else class="text-xs text-gray-400">环境未知</span>
          </template>
          <template v-else-if="column.key === 'actions'">
            <a-space>
              <a-button
                size="small"
                type="primary"
                @click="openMachineDetail(record)"
              >
                详情
              </a-button>
              <a-button size="small" @click="openMachineDetailWindow(record)">
                新窗口
              </a-button>
              <a-button size="small" @click="openEnvironment(record)"
                >环境</a-button
              >
              <a-button size="small" @click="openSlots(record)">货道</a-button>
              <a-button
                v-if="canManageCredentials"
                size="small"
                @click="openClaimCodes(record)"
              >
                领取码
              </a-button>
              <a-button
                v-if="canWrite"
                size="small"
                @click="openEditMachine(record)"
              >
                编辑
              </a-button>
              <a-button
                v-if="canManageCredentials"
                size="small"
                danger
                :loading="rotatingId === record.id"
                @click="handleRotateCredentials(record)"
              >
                轮换凭证
              </a-button>
              <a-button
                v-if="canExportLogs"
                size="small"
                :loading="exportingLogId === record.id"
                @click="handleRequestLogExport(record)"
              >
                导出日志
              </a-button>
            </a-space>
          </template>
        </template>
      </a-table>
    </a-card>

    <!-- Machine drawer -->
    <a-drawer
      v-model:open="machineDrawerOpen"
      :title="editingMachine ? '编辑机器' : '新增机器'"
      :destroy-on-hidden="true"
    >
      <a-form layout="vertical" :preserve="false">
        <a-form-item label="编码">
          <a-input
            v-model:value="machineForm.code"
            :disabled="Boolean(editingMachine)"
          />
        </a-form-item>
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

    <!-- Environment drawer -->
    <a-drawer
      v-model:open="environmentDrawerOpen"
      :title="environmentDrawerTitle"
      size="520"
      :destroy-on-hidden="true"
    >
      <div v-if="environmentLoading" class="text-sm text-gray-500">加载中</div>
      <template v-else-if="environmentMachine">
        <MachineEnvironmentCard
          :environment="environmentMachine.latestEnvironment"
          :command-status="environmentCommandStatus"
          :action-statuses="environmentCommandActionStatus"
          :action-payloads="environmentCommandActionPayload"
          :action-results="environmentCommandActionResult"
          :action-errors="environmentCommandActionError"
          :form="environmentControlForm"
          :can-command="canCommand"
          :submitting-action="environmentSubmittingAction"
          :controls-disabled="environmentCommandDisabled"
          :target-temperature-invalid="targetTemperatureInvalid"
          :bordered="false"
          @command="submitEnvironmentCommand"
        />
      </template>
    </a-drawer>

    <!-- Slots drawer -->
    <a-drawer
      v-model:open="slotDrawerOpen"
      title="货道列表"
      size="600"
      :destroy-on-hidden="true"
    >
      <div class="mb-3">
        <a-button v-if="canWrite" type="primary" @click="openCreateSlot"
          >新增货道</a-button
        >
      </div>
      <a-table
        :columns="slotColumns"
        :data-source="slots"
        row-key="id"
        :loading="slotsLoading"
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
        </template>
      </a-table>
    </a-drawer>

    <!-- Slot form modal -->
    <a-modal
      v-model:open="slotFormOpen"
      title="新增货道"
      ok-text="确定"
      cancel-text="取消"
      :confirm-loading="slotSaving"
      :ok-button-props="{ disabled: Boolean(slotCoordinateError) }"
      @ok="saveSlot"
    >
      <a-form layout="vertical">
        <a-alert
          v-if="slotCoordinateError"
          class="mb-4"
          type="error"
          :message="slotCoordinateError"
          show-icon
        />
        <a-form-item label="行号">
          <a-input-number
            v-model:value="slotForm.layerNo"
            :min="MACHINE_SLOT_MIN_LAYER_NO"
            :max="MACHINE_SLOT_MAX_LAYER_NO"
            class="w-full"
          />
        </a-form-item>
        <a-form-item label="格号">
          <a-input-number
            v-model:value="slotForm.cellNo"
            :min="1"
            :max="slotMaxCellNo"
            class="w-full"
          />
        </a-form-item>
        <a-form-item label="货道坐标">
          {{ formatMachineSlotCoordinate(slotForm) }}
        </a-form-item>
        <a-form-item label="容量">
          <a-input-number
            v-model:value="slotForm.capacity"
            :min="1"
            class="w-full"
          />
        </a-form-item>
        <a-form-item label="状态">
          <a-select v-model:value="slotForm.status">
            <a-select-option value="enabled">启用</a-select-option>
            <a-select-option value="disabled">禁用</a-select-option>
            <a-select-option value="faulted">故障</a-select-option>
          </a-select>
        </a-form-item>
      </a-form>
    </a-modal>

    <!-- Machine Claim Codes drawer -->
    <a-drawer
      v-model:open="claimCodeDrawerOpen"
      :title="claimCodeDrawerTitle"
      size="720"
      :destroy-on-hidden="true"
    >
      <template v-if="claimCodeMachine">
        <div class="mb-4 flex items-center gap-3">
          <a-button
            type="primary"
            :loading="generatingClaimCode"
            @click="handleGenerateClaimCode('first_claim')"
          >
            生成领取码
          </a-button>
          <a-button
            danger
            :loading="generatingClaimCode"
            @click="handleGenerateClaimCode('reclaim')"
          >
            生成重新领取码
          </a-button>
        </div>
        <a-alert
          v-if="generatedClaimCode"
          type="warning"
          message="请立即保存领取码，关闭或重新生成后将无法再次查看。"
          class="mb-4"
        />
        <a-descriptions
          v-if="generatedClaimCode"
          bordered
          :column="1"
          class="mb-4"
        >
          <a-descriptions-item label="机器编码">{{
            generatedClaimCode.machineCode
          }}</a-descriptions-item>
          <a-descriptions-item label="用途">{{
            claimCodePurposeLabel(generatedClaimCode.purpose)
          }}</a-descriptions-item>
          <a-descriptions-item label="领取码">
            <a-typography-text code copyable>{{
              generatedClaimCode.claimCode
            }}</a-typography-text>
          </a-descriptions-item>
          <a-descriptions-item label="过期时间">{{
            formatDateTime(generatedClaimCode.expiresAt)
          }}</a-descriptions-item>
        </a-descriptions>
        <a-table
          :columns="claimCodeColumns"
          :data-source="claimCodes"
          row-key="id"
          :loading="claimCodesLoading"
          :pagination="false"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'purpose'">
              {{
                claimCodePurposeLabel(
                  record.purpose as MachineClaimCodePurpose | undefined,
                )
              }}
            </template>
            <template v-else-if="column.key === 'state'">
              <a-tag
                :color="
                  claimCodeStateColor[record.state as MachineClaimCodeState] ??
                  'default'
                "
              >
                {{ claimCodeStateLabel(record.state as MachineClaimCodeState) }}
              </a-tag>
            </template>
            <template v-else-if="column.key === 'failedAttempts'">
              {{ record.failedAttemptCount }}/{{ record.maxFailedAttempts }}
            </template>
            <template v-else-if="column.key === 'expiresAt'">
              {{ formatDateTime(record.expiresAt) }}
            </template>
            <template v-else-if="column.key === 'createdAt'">
              {{ formatDateTime(record.createdAt) }}
            </template>
            <template v-else-if="column.key === 'actions'">
              <a-button
                v-if="record.state === 'pending'"
                size="small"
                danger
                :loading="revokingClaimCodeId === record.id"
                @click="
                  handleRevokeClaimCode(record as MachineClaimCodeSnapshot)
                "
              >
                撤销
              </a-button>
            </template>
          </template>
        </a-table>
      </template>
    </a-drawer>

    <!-- Rotate credentials result modal -->
    <a-modal
      v-model:open="rotateModalOpen"
      title="凭证轮换成功"
      ok-text="已保存，关闭"
      :cancel-button-props="{ style: { display: 'none' } }"
      @ok="rotateModalOpen = false"
    >
      <a-alert
        type="warning"
        message="请立即保存以下凭证，关闭此窗口后将无法再次查看！"
        class="mb-4"
      />
      <template v-if="rotatedCredentials">
        <a-descriptions bordered :column="1">
          <a-descriptions-item label="机器编码">{{
            rotatedCredentials.machineCode
          }}</a-descriptions-item>
          <a-descriptions-item label="机器密钥 (machineSecret)">
            <a-typography-text code copyable>{{
              rotatedCredentials.machineSecret
            }}</a-typography-text>
          </a-descriptions-item>
          <a-descriptions-item label="MQTT 签名密钥 (mqttSigningSecret)">
            <a-typography-text code copyable>{{
              rotatedCredentials.mqttSigningSecret
            }}</a-typography-text>
          </a-descriptions-item>
          <a-descriptions-item label="凭证版本">{{
            rotatedCredentials.secretVersion
          }}</a-descriptions-item>
        </a-descriptions>
      </template>
    </a-modal>
  </section>
</template>
