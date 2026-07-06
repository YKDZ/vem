<script setup lang="ts">
import type { OrderStatus } from "@vem/shared";

import { onMounted, ref } from "vue";

import {
  listOrders,
  requestRefund,
  type Order,
  type PageResult,
} from "@/api/orders";
import OrderDetailDrawer from "@/components/OrderDetailDrawer.vue";
import { useAuthStore } from "@/stores/auth";
import { formatCents, formatDateTime } from "@/utils/format";

const authStore = useAuthStore();
const canRefund = authStore.hasPermission("orders.refund");

const loading = ref(false);
const orders = ref<PageResult<Order>>({
  items: [],
  total: 0,
  page: 1,
  pageSize: 20,
});
const filterOrderNo = ref("");
const filterStatus = ref<OrderStatus | undefined>(undefined);

async function loadOrders(page = 1): Promise<void> {
  loading.value = true;
  try {
    orders.value = await listOrders({
      orderNo: filterOrderNo.value || undefined,
      status: filterStatus.value,
      page,
      pageSize: 20,
    });
  } finally {
    loading.value = false;
  }
}

const orderDetailDrawer = ref<InstanceType<typeof OrderDetailDrawer> | null>(
  null,
);

async function openDetail(order: Order): Promise<void> {
  await orderDetailDrawer.value?.show(order.id);
}

async function doRefund(id: string): Promise<void> {
  await requestRefund(id);
  await loadOrders();
}

const orderColumns = [
  { title: "订单号", dataIndex: "orderNo", key: "orderNo" },
  { title: "机器", dataIndex: "machineCode", key: "machine" },
  { title: "状态", dataIndex: "status", key: "status" },
  { title: "金额", dataIndex: "totalAmountCents", key: "totalAmountCents" },
  { title: "支付时间", dataIndex: "paidAt", key: "paidAt" },
  { title: "创建时间", dataIndex: "createdAt", key: "createdAt" },
  { title: "操作", key: "actions" },
];

onMounted(() => void loadOrders());
</script>

<template>
  <section class="space-y-4">
    <a-card>
      <div class="mb-4 flex gap-3">
        <a-input
          v-model:value="filterOrderNo"
          placeholder="订单号"
          class="max-w-48"
          @press-enter="loadOrders()"
        />
        <a-select
          v-model:value="filterStatus"
          placeholder="状态"
          allow-clear
          class="min-w-32"
          @change="loadOrders()"
        >
          <a-select-option value="pending_payment">待支付</a-select-option>
          <a-select-option value="payment_expired">支付超时</a-select-option>
          <a-select-option value="canceled">已取消</a-select-option>
          <a-select-option value="paid">已支付</a-select-option>
          <a-select-option value="dispensing">出货中</a-select-option>
          <a-select-option value="fulfilled">已完成</a-select-option>
          <a-select-option value="dispense_failed">出货失败</a-select-option>
          <a-select-option value="manual_handling">人工处理</a-select-option>
          <a-select-option value="refund_pending">待退款</a-select-option>
          <a-select-option value="refunded">已退款</a-select-option>
          <a-select-option value="closed">已关闭</a-select-option>
        </a-select>
        <a-button @click="loadOrders()">查询</a-button>
      </div>
      <a-table
        :columns="orderColumns"
        :data-source="orders.items"
        row-key="id"
        :loading="loading"
        :pagination="{
          current: orders.page,
          pageSize: orders.pageSize,
          total: orders.total,
          onChange: loadOrders,
        }"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'orderNo'">
            <a-button type="link" class="px-0" @click="openDetail(record)">
              {{ record.orderNo }}
            </a-button>
          </template>
          <template v-else-if="column.key === 'machine'">
            <RouterLink
              :to="{ name: 'machine-detail', params: { id: record.machineId } }"
            >
              {{ record.machineCode ?? record.machineId }}
            </RouterLink>
          </template>
          <template v-else-if="column.key === 'totalAmountCents'">
            {{ formatCents(record.totalAmountCents) }}
          </template>
          <template
            v-else-if="column.key === 'paidAt' || column.key === 'createdAt'"
          >
            {{ formatDateTime(record[column.key]) }}
          </template>
          <template v-else-if="column.key === 'actions'">
            <a-space>
              <a-button size="small" @click="openDetail(record)">详情</a-button>
              <a-button
                v-if="
                  canRefund &&
                  ['dispense_failed', 'manual_handling'].includes(record.status)
                "
                size="small"
                danger
                @click="doRefund(record.id)"
              >
                退款
              </a-button>
            </a-space>
          </template>
        </template>
      </a-table>
    </a-card>

    <OrderDetailDrawer ref="orderDetailDrawer" />
  </section>
</template>
