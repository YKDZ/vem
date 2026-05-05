<script setup lang="ts">
import type { MachineSlotStatus, MachineStatus } from "@vem/shared";

import { onMounted, ref } from "vue";

import {
  createMachine,
  createMachineSlot,
  listMachineSlots,
  listMachines,
  updateMachine,
  type Machine,
  type MachineSlot,
  type PageResult,
} from "@/api/machines";
import { useAuthStore } from "@/stores/auth";
import { formatDateTime } from "@/utils/format";

const authStore = useAuthStore();
const canWrite = authStore.hasPermission("machines.write");

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
          <template v-else-if="column.key === 'actions'">
            <a-space>
              <a-button size="small" @click="openSlots(record)">格口</a-button>
              <a-button
                v-if="canWrite"
                size="small"
                @click="openEditMachine(record)"
              >
                编辑
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
  </section>
</template>
