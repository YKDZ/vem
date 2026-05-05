<script setup lang="ts">
import { onMounted, ref } from "vue";

import {
  getOrderDetail,
  listOrders,
  requestRefund,
  type Order,
  type OrderDetail,
  type PageResult,
} from "@/api/orders";
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
const filterStatus = ref<string | undefined>(undefined);

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

// Detail drawer
const detailDrawerOpen = ref(false);
const detailLoading = ref(false);
const orderDetail = ref<OrderDetail | null>(null);

async function openDetail(order: Order): Promise<void> {
  detailDrawerOpen.value = true;
  detailLoading.value = true;
  try {
    orderDetail.value = await getOrderDetail(order.id);
  } finally {
    detailLoading.value = false;
  }
}

async function doRefund(id: string): Promise<void> {
  await requestRefund(id);
  await loadOrders();
}

const orderColumns = [
  { title: "订单号", dataIndex: "orderNo", key: "orderNo" },
  { title: "机器", dataIndex: "machineId", key: "machineId" },
  { title: "状态", dataIndex: "status", key: "status" },
  { title: "金额", dataIndex: "totalAmountCents", key: "totalAmountCents" },
  { title: "支付时间", dataIndex: "paidAt", key: "paidAt" },
  { title: "创建时间", dataIndex: "createdAt", key: "createdAt" },
  { title: "操作", key: "actions" },
];

const itemColumns = [
  { title: "SKU ID", dataIndex: "variantId", key: "variantId" },
  { title: "数量", dataIndex: "quantity", key: "quantity" },
  { title: "单价(分)", dataIndex: "unitPriceCents", key: "unitPriceCents" },
];

const paymentColumns = [
  { title: "支付单号", dataIndex: "paymentNo", key: "paymentNo" },
  { title: "状态", dataIndex: "status", key: "status" },
  { title: "金额(分)", dataIndex: "amountCents", key: "amountCents" },
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
          <template v-if="column.key === 'totalAmountCents'">
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

    <!-- Order detail drawer -->
    <a-drawer
      v-model:open="detailDrawerOpen"
      title="订单详情"
      size="large"
      :destroy-on-hidden="true"
    >
      <a-spin :spinning="detailLoading">
        <template v-if="orderDetail">
          <a-descriptions :column="2" bordered>
            <a-descriptions-item label="订单号">{{
              orderDetail.order.orderNo
            }}</a-descriptions-item>
            <a-descriptions-item label="状态">{{
              orderDetail.order.status
            }}</a-descriptions-item>
            <a-descriptions-item label="金额">
              {{ formatCents(orderDetail.order.totalAmountCents) }}
            </a-descriptions-item>
            <a-descriptions-item label="创建时间">
              {{ formatDateTime(orderDetail.order.createdAt) }}
            </a-descriptions-item>
          </a-descriptions>

          <a-divider>状态时间线</a-divider>
          <a-timeline>
            <a-timeline-item
              v-for="event in orderDetail.orderStatusEvents"
              :key="event.id"
            >
              {{ event.fromStatus ?? "(起始)" }} → {{ event.toStatus }}
              <span class="ml-2 text-xs text-slate-400">
                {{ formatDateTime(event.createdAt) }}
              </span>
            </a-timeline-item>
          </a-timeline>

          <a-divider>订单明细</a-divider>
          <a-table
            :columns="itemColumns"
            :data-source="orderDetail.items"
            row-key="id"
            :pagination="false"
            size="small"
          />

          <a-divider>支付流水</a-divider>
          <a-table
            :columns="paymentColumns"
            :data-source="orderDetail.payments"
            row-key="id"
            :pagination="false"
            size="small"
          />

          <a-divider>支付事件</a-divider>
          <a-table
            :data-source="orderDetail.paymentEvents"
            row-key="id"
            :pagination="false"
            size="small"
          />

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
  </section>
</template>
