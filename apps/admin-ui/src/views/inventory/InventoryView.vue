<script setup lang="ts">
import { App } from "antdv-next";
import { onMounted, ref } from "vue";

import type OrderDetailDrawer from "@/components/OrderDetailDrawer.vue";

import {
  adjustInventory,
  createInventory,
  listInventories,
  listInventoryMovements,
  type Inventory,
  type InventoryMovement,
  type PageResult,
} from "@/api/inventory";
import {
  listMachines,
  listMachineSlots,
  type Machine,
  type MachineSlot,
} from "@/api/machines";
import {
  listProducts,
  listProductVariants,
  type Product,
  type ProductVariant,
} from "@/api/products";
import OrderDetailDrawerComponent from "@/components/OrderDetailDrawer.vue";
import { useAuthStore } from "@/stores/auth";
import { formatDateTime } from "@/utils/format";

const authStore = useAuthStore();
const { message } = App.useApp();
const canAdjust = authStore.hasPermission("inventory.adjust");
const orderDetailDrawer = ref<InstanceType<typeof OrderDetailDrawer> | null>(
  null,
);

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
  productId: "",
  variantId: "",
  onHandQty: 0,
  reservedQty: 0,
  lowStockThreshold: 1,
  note: "",
});
const bindSaving = ref(false);
const bindOptionsLoading = ref(false);
const bindSlotsLoading = ref(false);
const bindVariantsLoading = ref(false);
const bindMachines = ref<Machine[]>([]);
const bindSlots = ref<MachineSlot[]>([]);
const bindProducts = ref<Product[]>([]);
const bindVariants = ref<ProductVariant[]>([]);
let bindSlotsRequestSequence = 0;
let bindVariantsRequestSequence = 0;

async function listAllMachinesForBinding(): Promise<Machine[]> {
  const pageSize = 100;
  const firstPage = await listMachines({ page: 1, pageSize });
  const items = [...firstPage.items];
  for (let page = 2; items.length < firstPage.total; page += 1) {
    const nextPage = await listMachines({ page, pageSize });
    if (nextPage.items.length === 0) break;
    items.push(...nextPage.items);
  }
  return items;
}

async function listAllProductsForBinding(): Promise<Product[]> {
  const pageSize = 100;
  const firstPage = await listProducts({ page: 1, pageSize });
  const items = [...firstPage.items];
  for (let page = 2; items.length < firstPage.total; page += 1) {
    const nextPage = await listProducts({ page, pageSize });
    if (nextPage.items.length === 0) break;
    items.push(...nextPage.items);
  }
  return items;
}

function resetBindForm(): void {
  bindForm.value = {
    machineId: "",
    slotId: "",
    productId: "",
    variantId: "",
    onHandQty: 0,
    reservedQty: 0,
    lowStockThreshold: 1,
    note: "",
  };
  bindSlots.value = [];
  bindVariants.value = [];
}

async function openBindForm(): Promise<void> {
  resetBindForm();
  bindFormOpen.value = true;
  bindOptionsLoading.value = true;
  try {
    const [machines, products] = await Promise.all([
      listAllMachinesForBinding(),
      listAllProductsForBinding(),
    ]);
    bindMachines.value = machines;
    bindProducts.value = products;
  } finally {
    bindOptionsLoading.value = false;
  }
}

async function onBindMachineChanged(machineId: string): Promise<void> {
  const requestSequence = ++bindSlotsRequestSequence;
  bindForm.value.slotId = "";
  bindSlots.value = [];
  if (!machineId) return;
  bindSlotsLoading.value = true;
  try {
    const slots = await listMachineSlots(machineId);
    if (
      requestSequence === bindSlotsRequestSequence &&
      bindForm.value.machineId === machineId
    ) {
      bindSlots.value = slots;
    }
  } finally {
    if (requestSequence === bindSlotsRequestSequence) {
      bindSlotsLoading.value = false;
    }
  }
}

async function onBindProductChanged(productId: string): Promise<void> {
  const requestSequence = ++bindVariantsRequestSequence;
  bindForm.value.variantId = "";
  bindVariants.value = [];
  if (!productId) return;
  bindVariantsLoading.value = true;
  try {
    const variants = (await listProductVariants(productId)).items;
    if (
      requestSequence === bindVariantsRequestSequence &&
      bindForm.value.productId === productId
    ) {
      bindVariants.value = variants;
    }
  } finally {
    if (requestSequence === bindVariantsRequestSequence) {
      bindVariantsLoading.value = false;
    }
  }
}

async function saveBind(): Promise<void> {
  if (
    !bindForm.value.machineId ||
    !bindForm.value.slotId ||
    !bindForm.value.variantId
  ) {
    void message.error("请先选择机器、货道和商品规格");
    return;
  }
  const selectedSlot = bindSlots.value.find(
    (slot) =>
      slot.id === bindForm.value.slotId &&
      slot.machineId === bindForm.value.machineId,
  );
  const selectedVariant = bindVariants.value.find(
    (variant) =>
      variant.id === bindForm.value.variantId &&
      variant.productId === bindForm.value.productId,
  );
  if (!selectedSlot || !selectedVariant) {
    void message.error("当前选择已变化，请重新选择货道和商品规格");
    return;
  }
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

function slotOptionLabel(slot: MachineSlot): string {
  return `第 ${slot.rowNo} 层 / 第 ${slot.cellNo} 格 · 容量 ${slot.capacity}`;
}

function variantOptionLabel(variant: ProductVariant): string {
  return [
    variant.sku,
    variant.color ? `颜色 ${variant.color}` : null,
    variant.size ? `尺码 ${variant.size}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
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
  if (
    !Number.isFinite(adjustForm.value.deltaQty) ||
    adjustForm.value.deltaQty === 0
  ) {
    void message.error("调整数量不能为 0");
    return;
  }
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
  { title: "机器", dataIndex: "machineCode", key: "machine" },
  { title: "格口", dataIndex: "slotDisplayLabel", key: "slot" },
  { title: "商品 / SKU", dataIndex: "sku", key: "sku" },
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
  { title: "订单", dataIndex: "orderNo", key: "order" },
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
        <a-button v-if="canAdjust" type="primary" @click="openBindForm">
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
          <template v-if="column.key === 'machine'">
            <RouterLink
              :to="{ name: 'machine-detail', params: { id: record.machineId } }"
            >
              {{ record.machineCode ?? record.machineId }}
            </RouterLink>
          </template>
          <template v-else-if="column.key === 'slot'">
            <div class="font-medium">
              {{ record.slotDisplayLabel ?? record.slotId }}
            </div>
            <div class="text-xs text-slate-500">{{ record.slotId }}</div>
          </template>
          <template v-else-if="column.key === 'sku'">
            <RouterLink
              :to="{
                name: 'products',
                query: {
                  q: record.sku ?? record.productName ?? record.variantId,
                },
              }"
              class="font-medium"
            >
              {{ record.productName ?? "未知商品" }}
            </RouterLink>
            <div class="text-xs text-slate-500">
              {{ record.sku ?? record.variantId }}
            </div>
          </template>
          <template v-else-if="column.key === 'availableQty'">
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
          <template v-if="column.key === 'order'">
            <a-button
              v-if="record.orderId"
              type="link"
              class="px-0"
              @click="orderDetailDrawer?.show(record.orderId)"
            >
              {{ record.orderNo ?? record.orderId }}
            </a-button>
            <span v-else>-</span>
          </template>
          <template v-else-if="column.key === 'createdAt'">
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
      :ok-button-props="{
        disabled:
          bindOptionsLoading ||
          !bindForm.machineId ||
          !bindForm.slotId ||
          !bindForm.variantId,
      }"
      @ok="saveBind"
    >
      <a-form layout="vertical">
        <a-form-item label="机器">
          <a-select
            v-model:value="bindForm.machineId"
            :loading="bindOptionsLoading"
            placeholder="选择机器"
            @change="onBindMachineChanged"
          >
            <a-select-option
              v-for="machine in bindMachines"
              :key="machine.id"
              :value="machine.id"
            >
              {{ machine.code }} · {{ machine.name }}
            </a-select-option>
          </a-select>
        </a-form-item>
        <a-form-item label="货道">
          <a-select
            v-model:value="bindForm.slotId"
            :disabled="!bindForm.machineId"
            :loading="bindSlotsLoading"
            placeholder="选择货道"
          >
            <a-select-option
              v-for="slot in bindSlots"
              :key="slot.id"
              :value="slot.id"
            >
              {{ slotOptionLabel(slot) }}
            </a-select-option>
          </a-select>
        </a-form-item>
        <a-form-item label="商品">
          <a-select
            v-model:value="bindForm.productId"
            :loading="bindOptionsLoading"
            placeholder="选择商品"
            @change="onBindProductChanged"
          >
            <a-select-option
              v-for="product in bindProducts"
              :key="product.id"
              :value="product.id"
            >
              {{ product.name }}
            </a-select-option>
          </a-select>
        </a-form-item>
        <a-form-item label="商品规格">
          <a-select
            v-model:value="bindForm.variantId"
            :disabled="!bindForm.productId"
            :loading="bindVariantsLoading"
            placeholder="选择规格"
          >
            <a-select-option
              v-for="variant in bindVariants"
              :key="variant.id"
              :value="variant.id"
            >
              {{ variantOptionLabel(variant) }}
            </a-select-option>
          </a-select>
        </a-form-item>
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

    <OrderDetailDrawerComponent ref="orderDetailDrawer" />
  </section>
</template>
