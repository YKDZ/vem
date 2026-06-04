<script setup lang="ts">
import type {
  MachineCommandStatus,
  MachineEnvironmentControlRequest,
  MachineSlotStatus,
  MachineStatus,
} from "@vem/shared";

import { Modal } from "antdv-next";
import { computed, onMounted, ref } from "vue";

import { requestLogExport } from "@/api/machine-ops";
import {
  commandEnvironment,
  createMachine,
  createMachineSlot,
  getMachine,
  listMachineSlots,
  listMachines,
  rotateMachineCredentials,
  updateMachine,
  type Machine,
  type MachineSlot,
  type PageResult,
  type RotateCredentialsResult,
} from "@/api/machines";
import { useAuthStore } from "@/stores/auth";
import { formatDateTime } from "@/utils/format";

const authStore = useAuthStore();
const canWrite = authStore.hasPermission("machines.write");
const canCommand = authStore.hasPermission("machines.command");

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

// Machine form / drawer
const machineDrawerOpen = ref(false);
const editingMachine = ref<Machine | null>(null);
const machineForm = ref({
  code: "",
  name: "",
  locationText: "",
  status: "offline" as MachineStatus,
  mqttClientId: "",
});
const machineSaving = ref(false);

function openCreateMachine(): void {
  editingMachine.value = null;
  machineForm.value = {
    code: "",
    name: "",
    locationText: "",
    status: "offline",
    mqttClientId: "",
  };
  machineDrawerOpen.value = true;
}

function openEditMachine(m: Machine): void {
  editingMachine.value = m;
  machineForm.value = {
    code: m.code,
    name: m.name,
    locationText: m.locationText ?? "",
    status: m.status,
    mqttClientId: m.mqttClientId ?? "",
  };
  machineDrawerOpen.value = true;
}

async function saveMachine(): Promise<void> {
  machineSaving.value = true;
  try {
    const body = {
      code: machineForm.value.code,
      name: machineForm.value.name,
      locationText: machineForm.value.locationText || null,
      status: machineForm.value.status,
      mqttClientId: machineForm.value.mqttClientId || null,
    };
    if (editingMachine.value) {
      await updateMachine(editingMachine.value.id, body);
    } else {
      await createMachine(body);
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
  includeAirConditioner: false,
  airConditionerOn: false,
  includeTargetTemperature: false,
  targetTemperatureCelsius: 24,
});
const environmentSubmitting = ref(false);
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
const environmentDrawerTitle = computed(() =>
  environmentMachine.value ? `环境 - ${environmentMachine.value.code}` : "环境",
);

async function openEnvironment(m: Machine): Promise<void> {
  environmentMachine.value = m;
  environmentCommandStatus.value = null;
  environmentDrawerOpen.value = true;
  environmentLoading.value = true;
  try {
    environmentMachine.value = await getMachine(m.id);
    environmentCommandStatus.value =
      environmentMachine.value.latestEnvironmentCommand?.status ?? null;
    const latest = environmentMachine.value.latestEnvironment;
    environmentControlForm.value = {
      includeAirConditioner: false,
      airConditionerOn: latest?.airConditionerOn ?? false,
      includeTargetTemperature: false,
      targetTemperatureCelsius: latest?.targetTemperatureCelsius ?? 24,
    };
  } finally {
    environmentLoading.value = false;
  }
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

async function submitEnvironmentCommand(): Promise<void> {
  if (!environmentMachine.value || environmentCommandDisabled.value) return;
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
    const command = await commandEnvironment(environmentMachine.value.id, body);
    environmentCommandStatus.value = command.status;
  } finally {
    environmentSubmitting.value = false;
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
  slotSaving.value = true;
  try {
    await createMachineSlot(currentMachineId.value, {
      layerNo: slotForm.value.layerNo,
      cellNo: slotForm.value.cellNo,
      slotCode: slotForm.value.slotCode,
      capacity: slotForm.value.capacity,
      status: slotForm.value.status,
    });
    slotFormOpen.value = false;
    slots.value = await listMachineSlots(currentMachineId.value);
  } finally {
    slotSaving.value = false;
  }
}

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

const statusColor: Record<string, string> = {
  online: "success",
  offline: "default",
  maintenance: "warning",
  disabled: "error",
};

const machineColumns = [
  { title: "编码", dataIndex: "code", key: "code" },
  { title: "名称", dataIndex: "name", key: "name" },
  { title: "位置", dataIndex: "locationText", key: "locationText" },
  { title: "状态", dataIndex: "status", key: "status" },
  { title: "最近心跳", dataIndex: "lastSeenAt", key: "lastSeenAt" },
  { title: "环境", key: "environment" },
  { title: "操作", key: "actions" },
];

const slotColumns = [
  { title: "层号", dataIndex: "layerNo", key: "layerNo" },
  { title: "格号", dataIndex: "cellNo", key: "cellNo" },
  { title: "格口编码", dataIndex: "slotCode", key: "slotCode" },
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
                ·
                {{
                  airConditionerLabel(record.latestEnvironment.airConditionerOn)
                }}
                ·
                {{
                  targetTemperatureLabel(
                    record.latestEnvironment.targetTemperatureCelsius,
                  )
                }}
              </div>
            </div>
            <span v-else class="text-xs text-gray-400">环境未知</span>
          </template>
          <template v-else-if="column.key === 'actions'">
            <a-space>
              <a-button size="small" @click="openEnvironment(record)"
                >环境</a-button
              >
              <a-button size="small" @click="openSlots(record)">格口</a-button>
              <a-button
                v-if="canWrite"
                size="small"
                @click="openEditMachine(record)"
              >
                编辑
              </a-button>
              <a-button
                v-if="canWrite"
                size="small"
                danger
                :loading="rotatingId === record.id"
                @click="handleRotateCredentials(record)"
              >
                轮换凭证
              </a-button>
              <a-button
                v-if="canWrite"
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
          <a-input v-model:value="machineForm.code" />
        </a-form-item>
        <a-form-item label="名称">
          <a-input v-model:value="machineForm.name" />
        </a-form-item>
        <a-form-item label="位置描述">
          <a-input v-model:value="machineForm.locationText" />
        </a-form-item>
        <a-form-item label="状态">
          <a-select v-model:value="machineForm.status">
            <a-select-option value="offline">下线</a-select-option>
            <a-select-option value="online">在线</a-select-option>
            <a-select-option value="maintenance">维护</a-select-option>
            <a-select-option value="disabled">禁用</a-select-option>
          </a-select>
        </a-form-item>
        <a-form-item label="MQTT Client ID">
          <a-input v-model:value="machineForm.mqttClientId" />
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
      width="520"
      :destroy-on-hidden="true"
    >
      <div v-if="environmentLoading" class="text-sm text-gray-500">加载中</div>
      <template v-else-if="environmentMachine">
        <a-descriptions bordered :column="1" size="small">
          <template v-if="environmentMachine.latestEnvironment">
            <a-descriptions-item label="温度">{{
              formatEnvironmentNumber(
                environmentMachine.latestEnvironment.temperatureCelsius,
                "C",
              )
            }}</a-descriptions-item>
            <a-descriptions-item label="湿度">{{
              formatEnvironmentNumber(
                environmentMachine.latestEnvironment.humidityRh,
                "% RH",
              )
            }}</a-descriptions-item>
            <a-descriptions-item label="采样时间">{{
              formatDateTime(environmentMachine.latestEnvironment.sampledAt)
            }}</a-descriptions-item>
            <a-descriptions-item label="传感器状态">{{
              sensorStatusLabel(
                environmentMachine.latestEnvironment.sensorStatus,
              )
            }}</a-descriptions-item>
            <a-descriptions-item label="空调状态">{{
              airConditionerLabel(
                environmentMachine.latestEnvironment.airConditionerOn,
              )
            }}</a-descriptions-item>
            <a-descriptions-item label="目标温度">{{
              targetTemperatureLabel(
                environmentMachine.latestEnvironment.targetTemperatureCelsius,
              )
            }}</a-descriptions-item>
          </template>
          <template v-else>
            <a-descriptions-item label="最新读数">环境未知</a-descriptions-item>
          </template>
          <a-descriptions-item label="最新命令">{{
            commandStatusLabel(environmentCommandStatus)
          }}</a-descriptions-item>
        </a-descriptions>
        <a-form layout="vertical" class="mt-4">
          <a-form-item label="控制动作">
            <div class="space-y-2">
              <div class="flex items-center gap-3">
                <a-checkbox
                  v-model:checked="environmentControlForm.includeAirConditioner"
                  :disabled="!canCommand || environmentSubmitting"
                  >设置空调开关</a-checkbox
                >
                <a-switch
                  v-model:checked="environmentControlForm.airConditionerOn"
                  :disabled="
                    !canCommand ||
                    environmentSubmitting ||
                    !environmentControlForm.includeAirConditioner
                  "
                  >{{
                    environmentControlForm.airConditionerOn ? "开" : "关"
                  }}</a-switch
                >
              </div>
              <div class="flex items-center gap-3">
                <a-checkbox
                  v-model:checked="
                    environmentControlForm.includeTargetTemperature
                  "
                  :disabled="!canCommand || environmentSubmitting"
                  >设置目标温度</a-checkbox
                >
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
              <div v-if="targetTemperatureInvalid" class="text-xs text-red-600">
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
            >提交环境控制</a-button
          >
        </a-form>
      </template>
    </a-drawer>

    <!-- Slots drawer -->
    <a-drawer
      v-model:open="slotDrawerOpen"
      title="格口列表"
      width="600"
      :destroy-on-hidden="true"
    >
      <div class="mb-3">
        <a-button v-if="canWrite" type="primary" @click="openCreateSlot"
          >新增格口</a-button
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
          <template v-if="column.key === 'status'">
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
      title="新增格口"
      ok-text="确定"
      cancel-text="取消"
      :confirm-loading="slotSaving"
      @ok="saveSlot"
    >
      <a-form layout="vertical">
        <a-form-item label="层号">
          <a-input-number
            v-model:value="slotForm.layerNo"
            :min="1"
            class="w-full"
          />
        </a-form-item>
        <a-form-item label="格号">
          <a-input-number
            v-model:value="slotForm.cellNo"
            :min="1"
            class="w-full"
          />
        </a-form-item>
        <a-form-item label="格口编码">
          <a-input v-model:value="slotForm.slotCode" />
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
