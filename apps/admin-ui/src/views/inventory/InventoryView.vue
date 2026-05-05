<script setup lang="ts">
import { onMounted, ref } from "vue";

import {
  adjustInventory,
  createInventory,
  listInventories,
  listInventoryMovements,
  refillInventory,
  type Inventory,
  type InventoryMovement,
  type PageResult,
} from "@/api/inventory";
import { useAuthStore } from "@/stores/auth";
import { formatDateTime } from "@/utils/format";

const authStore = useAuthStore();
const canAdjust = authStore.hasPermission("inventory.adjust");
const canRefill = authStore.hasPermission("inventory.refill");

const loading = ref(false);
const inventories = ref<PageResult<Inventory>>({
  items: [],
  total: 0,
  page: 1,
  pageSize: 20,
});

async function loadInventories(page = 1): Promise<void> {
  loading.value = true;
  try {
    inventories.value = await listInventories({ page, pageSize: 20 });
  } finally {
    loading.value = false;
  }
}

// Movements
const movements = ref<PageResult<InventoryMovement>>({
  items: [],
  total: 0,
  page: 1,
  pageSize: 20,
});
const movementsLoading = ref(false);

async function loadMovements(page = 1): Promise<void> {
  movementsLoading.value = true;
  try {
    movements.value = await listInventoryMovements({ page, pageSize: 20 });
  } finally {
    movementsLoading.value = false;
  }
}

// Bind inventory
const bindFormOpen = ref(false);
const bindForm = ref({
  machineId: "",
  slotId: "",
  variantId: "",
  onHandQty: 0,
  reservedQty: 0,
  lowStockThreshold: 1,
  note: "",
});
const bindSaving = ref(false);

async function saveBind(): Promise<void> {
  bindSaving.value = true;
  try {
    await createInventory({
      machineId: bindForm.value.machineId,
      slotId: bindForm.value.slotId,
      variantId: bindForm.value.variantId,
      onHandQty: bindForm.value.onHandQty,
      reservedQty: bindForm.value.reservedQty,
      lowStockThreshold: bindForm.value.lowStockThreshold,
      note: bindForm.value.note || undefined,
    });
    bindFormOpen.value = false;
    await loadInventories();
    await loadMovements();
  } finally {
    bindSaving.value = false;
  }
}

// Refill
const refillFormOpen = ref(false);
const refillForm = ref({ inventoryId: "", quantity: 0, note: "" });
const refillSaving = ref(false);

function openRefill(inv: Inventory): void {
  refillForm.value = { inventoryId: inv.id, quantity: 0, note: "" };
  refillFormOpen.value = true;
}

async function saveRefill(): Promise<void> {
  refillSaving.value = true;
  try {
    await refillInventory({
      inventoryId: refillForm.value.inventoryId,
      quantity: refillForm.value.quantity,
      note: refillForm.value.note || undefined,
    });
    refillFormOpen.value = false;
    await loadInventories();
    await loadMovements();
  } finally {
    refillSaving.value = false;
  }
}

// Adjust
const adjustFormOpen = ref(false);
const adjustForm = ref({ inventoryId: "", deltaQty: 0, note: "" });
const adjustSaving = ref(false);

function openAdjust(inv: Inventory): void {
  adjustForm.value = { inventoryId: inv.id, deltaQty: 0, note: "" };
  adjustFormOpen.value = true;
}

async function saveAdjust(): Promise<void> {
  adjustSaving.value = true;
  try {
    await adjustInventory({
      inventoryId: adjustForm.value.inventoryId,
      deltaQty: adjustForm.value.deltaQty,
      note: adjustForm.value.note || undefined,
    });
    adjustFormOpen.value = false;
    await loadInventories();
    await loadMovements();
  } finally {
    adjustSaving.value = false;
  }
}

const inventoryColumns = [
  { title: "机器", dataIndex: "machineId", key: "machineId" },
  { title: "格口", dataIndex: "slotId", key: "slotId" },
  { title: "SKU", dataIndex: "variantId", key: "variantId" },
  { title: "在库", dataIndex: "onHandQty", key: "onHandQty" },
  { title: "预占", dataIndex: "reservedQty", key: "reservedQty" },
  { title: "可售", key: "availableQty" },
  {
    title: "低库存阈值",
    dataIndex: "lowStockThreshold",
    key: "lowStockThreshold",
  },
  { title: "操作", key: "actions" },
];

const movementColumns = [
  { title: "变更数量", dataIndex: "deltaQty", key: "deltaQty" },
  { title: "原因", dataIndex: "reason", key: "reason" },
  { title: "订单ID", dataIndex: "orderId", key: "orderId" },
  {
    title: "操作人",
    dataIndex: "operatorAdminUserId",
    key: "operatorAdminUserId",
  },
  { title: "备注", dataIndex: "note", key: "note" },
  { title: "时间", dataIndex: "createdAt", key: "createdAt" },
];

onMounted(() => {
  void loadInventories();
  void loadMovements();
});
</script>

<template>
  <section class="space-y-4">
    <a-card title="库存列表">
      <div class="mb-4 flex gap-3">
        <a-button v-if="canAdjust" type="primary" @click="bindFormOpen = true">
          绑定库存
        </a-button>
      </div>
      <a-table
        :columns="inventoryColumns"
        :data-source="inventories.items"
        row-key="id"
        :loading="loading"
        :pagination="{
          current: inventories.page,
          pageSize: inventories.pageSize,
          total: inventories.total,
          onChange: loadInventories,
        }"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'availableQty'">
            {{ record.onHandQty - record.reservedQty }}
            <a-tag
              v-if="
                record.onHandQty - record.reservedQty <=
                record.lowStockThreshold
              "
              color="warning"
              class="ml-1"
            >
              库存预警
            </a-tag>
          </template>
          <template v-else-if="column.key === 'actions'">
            <a-space>
              <a-button
                v-if="canRefill"
                size="small"
                @click="openRefill(record)"
                >补货</a-button
              >
              <a-button
                v-if="canAdjust"
                size="small"
                @click="openAdjust(record)"
                >调整</a-button
              >
            </a-space>
          </template>
        </template>
      </a-table>
    </a-card>

    <a-card title="库存流水">
      <a-table
        :columns="movementColumns"
        :data-source="movements.items"
        row-key="id"
        :loading="movementsLoading"
        :pagination="{
          current: movements.page,
          pageSize: movements.pageSize,
          total: movements.total,
          onChange: loadMovements,
        }"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'createdAt'">
            {{ formatDateTime(record.createdAt) }}
          </template>
        </template>
      </a-table>
    </a-card>

    <!-- Bind form -->
    <a-modal
      v-model:open="bindFormOpen"
      title="绑定库存"
      :confirm-loading="bindSaving"
      @ok="saveBind"
    >
      <a-form layout="vertical">
        <a-form-item label="机器ID"
          ><a-input v-model:value="bindForm.machineId"
        /></a-form-item>
        <a-form-item label="格口ID"
          ><a-input v-model:value="bindForm.slotId"
        /></a-form-item>
        <a-form-item label="SKU ID"
          ><a-input v-model:value="bindForm.variantId"
        /></a-form-item>
        <a-form-item label="在库数量">
          <a-input-number
            v-model:value="bindForm.onHandQty"
            :min="0"
            class="w-full"
          />
        </a-form-item>
        <a-form-item label="低库存阈值">
          <a-input-number
            v-model:value="bindForm.lowStockThreshold"
            :min="0"
            class="w-full"
          />
        </a-form-item>
        <a-form-item label="备注"
          ><a-input v-model:value="bindForm.note"
        /></a-form-item>
      </a-form>
    </a-modal>

    <!-- Refill form -->
    <a-modal
      v-model:open="refillFormOpen"
      title="补货"
      :confirm-loading="refillSaving"
      @ok="saveRefill"
    >
      <a-form layout="vertical">
        <a-form-item label="补货数量">
          <a-input-number
            v-model:value="refillForm.quantity"
            :min="1"
            class="w-full"
          />
        </a-form-item>
        <a-form-item label="备注"
          ><a-input v-model:value="refillForm.note"
        /></a-form-item>
      </a-form>
    </a-modal>

    <!-- Adjust form -->
    <a-modal
      v-model:open="adjustFormOpen"
      title="库存调整"
      :confirm-loading="adjustSaving"
      @ok="saveAdjust"
    >
      <a-form layout="vertical">
        <a-form-item label="调整数量（正数补充，负数扣减）">
          <a-input-number v-model:value="adjustForm.deltaQty" class="w-full" />
        </a-form-item>
        <a-form-item label="备注"
          ><a-input v-model:value="adjustForm.note"
        /></a-form-item>
      </a-form>
    </a-modal>
  </section>
</template>
