<script setup lang="ts">
import { ref } from "vue";

import { getOrderDetail, type OrderDetail } from "@/api/orders";
import { formatCents, formatDateTime } from "@/utils/format";

const open = ref(false);
const loading = ref(false);
const orderDetail = ref<OrderDetail | null>(null);

const itemColumns = [
  { title: "商品", key: "product" },
  { title: "SKU", key: "sku" },
  { title: "货道", key: "slot" },
  { title: "数量", dataIndex: "quantity", key: "quantity" },
  { title: "单价", dataIndex: "unitPriceCents", key: "unitPriceCents" },
];

const paymentColumns = [
  { title: "支付单号", dataIndex: "paymentNo", key: "paymentNo" },
  { title: "状态", dataIndex: "status", key: "status" },
  { title: "金额", dataIndex: "amountCents", key: "amountCents" },
  { title: "支付时间", dataIndex: "paidAt", key: "paidAt" },
];

function textFromSnapshot(
  snapshot: Record<string, unknown>,
  key: string,
): string | null {
  const value = snapshot[key];
  return typeof value === "string" && value.trim() ? value : null;
}

async function show(orderId: string): Promise<void> {
  open.value = true;
  loading.value = true;
  orderDetail.value = null;
  try {
    orderDetail.value = await getOrderDetail(orderId);
  } finally {
    loading.value = false;
  }
}

defineExpose({ show });
</script>

<template>
  <a-drawer
    v-model:open="open"
    title="订单详情"
    size="large"
    :destroy-on-hidden="true"
  >
    <a-spin :spinning="loading">
      <template v-if="orderDetail">
        <a-descriptions :column="2" bordered size="small">
          <a-descriptions-item label="订单号">
            {{ orderDetail.order.orderNo }}
          </a-descriptions-item>
          <a-descriptions-item label="机器">
            {{ orderDetail.order.machineCode ?? orderDetail.order.machineId }}
          </a-descriptions-item>
          <a-descriptions-item label="订单状态">
            {{ orderDetail.order.status }}
          </a-descriptions-item>
          <a-descriptions-item label="支付状态">
            {{ orderDetail.order.paymentState }}
          </a-descriptions-item>
          <a-descriptions-item label="履约状态">
            {{ orderDetail.order.fulfillmentState }}
          </a-descriptions-item>
          <a-descriptions-item label="金额">
            {{ formatCents(orderDetail.order.totalAmountCents) }}
          </a-descriptions-item>
          <a-descriptions-item label="支付时间">
            {{ formatDateTime(orderDetail.order.paidAt) }}
          </a-descriptions-item>
          <a-descriptions-item label="创建时间">
            {{ formatDateTime(orderDetail.order.createdAt) }}
          </a-descriptions-item>
        </a-descriptions>

        <a-divider>订单明细</a-divider>
        <a-table
          :columns="itemColumns"
          :data-source="orderDetail.items"
          row-key="id"
          :pagination="false"
          size="small"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'product'">
              <div class="font-medium">
                {{
                  textFromSnapshot(record.productSnapshot, "productName") ??
                  "未知商品"
                }}
              </div>
              <div class="text-xs text-slate-500">
                {{ textFromSnapshot(record.productSnapshot, "productId") }}
              </div>
            </template>
            <template v-else-if="column.key === 'sku'">
              <a-typography-text copyable>
                {{
                  textFromSnapshot(record.productSnapshot, "sku") ??
                  record.variantId
                }}
              </a-typography-text>
              <div class="text-xs text-slate-500">
                {{ textFromSnapshot(record.productSnapshot, "size") }}
                {{ textFromSnapshot(record.productSnapshot, "color") }}
              </div>
            </template>
            <template v-else-if="column.key === 'slot'">
              {{
                textFromSnapshot(record.productSnapshot, "slotCode") ??
                textFromSnapshot(record.productSnapshot, "slotId") ??
                "-"
              }}
            </template>
            <template v-else-if="column.key === 'unitPriceCents'">
              {{ formatCents(record.unitPriceCents) }}
            </template>
          </template>
        </a-table>

        <a-divider>支付流水</a-divider>
        <a-table
          :columns="paymentColumns"
          :data-source="orderDetail.payments"
          row-key="id"
          :pagination="false"
          size="small"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'amountCents'">
              {{ formatCents(record.amountCents) }}
            </template>
            <template v-else-if="column.key === 'paidAt'">
              {{ formatDateTime(record.paidAt) }}
            </template>
          </template>
        </a-table>

        <a-divider>状态时间线</a-divider>
        <a-timeline>
          <a-timeline-item
            v-for="event in orderDetail.orderStatusEvents"
            :key="event.id"
          >
            {{ event.fromStatus ?? "(起始)" }} -> {{ event.toStatus }}
            <span class="ml-2 text-xs text-slate-400">
              {{ formatDateTime(event.createdAt) }}
            </span>
          </a-timeline-item>
        </a-timeline>

        <a-divider>出货命令</a-divider>
        <a-table
          :data-source="orderDetail.vendingCommands"
          row-key="id"
          :pagination="false"
          size="small"
        />

        <a-divider>库存流水</a-divider>
        <a-table
          :data-source="orderDetail.inventoryMovements"
          row-key="id"
          :pagination="false"
          size="small"
        />
      </template>
    </a-spin>
  </a-drawer>
</template>
