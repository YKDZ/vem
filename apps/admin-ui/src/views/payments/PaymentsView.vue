<script setup lang="ts">
import { onMounted, ref } from "vue";

import {
  listPaymentEvents,
  listPaymentProviders,
  listPayments,
  mockFail,
  mockSucceed,
  type PageResult,
  type Payment,
  type PaymentEvent,
  type PaymentProvider,
} from "@/api/payments";
import { useAuthStore } from "@/stores/auth";
import { formatCents, formatDateTime } from "@/utils/format";

const authStore = useAuthStore();
const canConfigure = authStore.hasPermission("payments.configure");

// Payments tab
const paymentsLoading = ref(false);
const payments = ref<PageResult<Payment>>({
  items: [],
  total: 0,
  page: 1,
  pageSize: 20,
});

async function loadPayments(page = 1): Promise<void> {
  paymentsLoading.value = true;
  try {
    payments.value = await listPayments({ page, pageSize: 20 });
  } finally {
    paymentsLoading.value = false;
  }
}

async function doMockSucceed(paymentNo: string): Promise<void> {
  await mockSucceed(paymentNo);
  await loadPayments();
}

async function doMockFail(paymentNo: string): Promise<void> {
  await mockFail(paymentNo);
  await loadPayments();
}

// Providers tab
const providersLoading = ref(false);
const providers = ref<PaymentProvider[]>([]);

async function loadProviders(): Promise<void> {
  providersLoading.value = true;
  try {
    providers.value = await listPaymentProviders();
  } finally {
    providersLoading.value = false;
  }
}

// Events tab
const eventsLoading = ref(false);
const events = ref<PageResult<PaymentEvent>>({
  items: [],
  total: 0,
  page: 1,
  pageSize: 20,
});

async function loadEvents(page = 1): Promise<void> {
  eventsLoading.value = true;
  try {
    events.value = await listPaymentEvents({ page, pageSize: 20 });
  } finally {
    eventsLoading.value = false;
  }
}

const paymentColumns = [
  { title: "支付单号", dataIndex: "paymentNo", key: "paymentNo" },
  { title: "订单", dataIndex: "orderId", key: "orderId" },
  { title: "Provider", dataIndex: "providerCode", key: "providerCode" },
  { title: "状态", dataIndex: "status", key: "status" },
  { title: "金额", dataIndex: "amountCents", key: "amountCents" },
  { title: "支付时间", dataIndex: "paidAt", key: "paidAt" },
  { title: "创建时间", dataIndex: "createdAt", key: "createdAt" },
  { title: "操作", key: "actions" },
];

const providerColumns = [
  { title: "Code", dataIndex: "code", key: "code" },
  { title: "名称", dataIndex: "name", key: "name" },
  { title: "类型", dataIndex: "type", key: "type" },
  { title: "状态", dataIndex: "status", key: "status" },
];

const eventColumns = [
  { title: "事件类型", dataIndex: "eventType", key: "eventType" },
  { title: "Provider", dataIndex: "providerCode", key: "providerCode" },
  { title: "支付单号", dataIndex: "paymentNo", key: "paymentNo" },
  { title: "验签", dataIndex: "signatureValid", key: "signatureValid" },
  { title: "处理时间", dataIndex: "handledAt", key: "handledAt" },
  { title: "创建时间", dataIndex: "createdAt", key: "createdAt" },
];

function onTabChange(key: string): void {
  if (key === "payments") void loadPayments();
  else if (key === "providers") void loadProviders();
  else if (key === "events") void loadEvents();
}

onMounted(() => {
  void loadPayments();
});
</script>

<template>
  <a-card>
    <a-tabs default-active-key="payments" @change="onTabChange">
      <a-tab-pane key="payments" tab="支付流水">
        <a-table
          :columns="paymentColumns"
          :data-source="payments.items"
          row-key="id"
          :loading="paymentsLoading"
          :pagination="{
            current: payments.page,
            pageSize: payments.pageSize,
            total: payments.total,
            onChange: loadPayments,
          }"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'amountCents'">
              {{ formatCents(record.amountCents) }}
            </template>
            <template
              v-else-if="column.key === 'paidAt' || column.key === 'createdAt'"
            >
              {{ formatDateTime(record[column.key]) }}
            </template>
            <template v-else-if="column.key === 'actions'">
              <a-space v-if="canConfigure && record.providerCode === 'mock'">
                <a-button size="small" @click="doMockSucceed(record.paymentNo)">
                  模拟成功
                </a-button>
                <a-button
                  size="small"
                  danger
                  @click="doMockFail(record.paymentNo)"
                >
                  模拟失败
                </a-button>
              </a-space>
            </template>
          </template>
        </a-table>
      </a-tab-pane>

      <a-tab-pane key="providers" tab="Provider">
        <a-table
          :columns="providerColumns"
          :data-source="providers"
          row-key="id"
          :loading="providersLoading"
          :pagination="false"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'status'">
              <a-tag
                :color="record.status === 'enabled' ? 'success' : 'default'"
              >
                {{ record.status }}
              </a-tag>
            </template>
          </template>
        </a-table>
      </a-tab-pane>

      <a-tab-pane key="events" tab="回调事件">
        <a-table
          :columns="eventColumns"
          :data-source="events.items"
          row-key="id"
          :loading="eventsLoading"
          :pagination="{
            current: events.page,
            pageSize: events.pageSize,
            total: events.total,
            onChange: loadEvents,
          }"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'signatureValid'">
              <a-tag :color="record.signatureValid ? 'success' : 'error'">
                {{ record.signatureValid ? "有效" : "无效" }}
              </a-tag>
            </template>
            <template
              v-else-if="
                column.key === 'handledAt' || column.key === 'createdAt'
              "
            >
              {{ formatDateTime(record[column.key]) }}
            </template>
          </template>
        </a-table>
      </a-tab-pane>
    </a-tabs>
  </a-card>
</template>
