<script setup lang="ts">
import { onMounted, ref } from "vue";

import {
  listPaymentEvents,
  listPaymentProviderConfigs,
  listPaymentProviders,
  listPayments,
  mockFail,
  mockSucceed,
  upsertPaymentProviderConfig,
  type PageResult,
  type Payment,
  type PaymentEvent,
  type PaymentProvider,
  type PaymentProviderConfig,
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

// Config tab
const configsLoading = ref(false);
const providerConfigs = ref<PaymentProviderConfig[]>([]);
const upsertConfigLoading = ref(false);
const upsertForm = ref({
  providerCode: "",
  machineId: "" as string | null,
  merchantNo: "" as string | null,
  appId: "" as string | null,
  apiKey: "" as string,
  status: "enabled" as string,
});

async function loadConfigs(): Promise<void> {
  configsLoading.value = true;
  try {
    providerConfigs.value = await listPaymentProviderConfigs();
  } finally {
    configsLoading.value = false;
  }
}

async function doUpsertConfig(): Promise<void> {
  upsertConfigLoading.value = true;
  try {
    await upsertPaymentProviderConfig({
      providerCode: upsertForm.value.providerCode,
      machineId: upsertForm.value.machineId || null,
      merchantNo: upsertForm.value.merchantNo || null,
      appId: upsertForm.value.appId || null,
      sensitiveConfigJson: upsertForm.value.apiKey
        ? { apiKey: upsertForm.value.apiKey }
        : undefined,
      status: upsertForm.value.status,
    });
    await loadConfigs();
  } finally {
    upsertConfigLoading.value = false;
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

const configColumns = [
  {
    title: "Provider ID",
    dataIndex: "providerId",
    key: "providerId",
    ellipsis: true,
  },
  { title: "机器 ID", dataIndex: "machineId", key: "machineId" },
  { title: "商户号", dataIndex: "merchantNo", key: "merchantNo" },
  { title: "App ID", dataIndex: "appId", key: "appId" },
  { title: "状态", dataIndex: "status", key: "status" },
  { title: "密钥状态", dataIndex: "secretStatusJson", key: "secretStatusJson" },
];

function onTabChange(key: string): void {
  if (key === "payments") void loadPayments();
  else if (key === "providers") void loadProviders();
  else if (key === "events") void loadEvents();
  else if (key === "configs") void loadConfigs();
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

      <a-tab-pane key="configs" tab="支付配置">
        <a-table
          :columns="configColumns"
          :data-source="providerConfigs"
          row-key="id"
          :loading="configsLoading"
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
            <template v-else-if="column.key === 'secretStatusJson'">
              <a-space direction="vertical" :size="2">
                <span v-for="(val, key) in record.secretStatusJson" :key="key">
                  <a-tag :color="val.configured ? 'success' : 'default'">
                    {{ key }}: {{ val.configured ? "已配置" : "未配置" }}
                  </a-tag>
                </span>
                <span v-if="Object.keys(record.secretStatusJson).length === 0">
                  无密钥
                </span>
              </a-space>
            </template>
            <template v-else-if="column.key === 'machineId'">
              {{ record.machineId ?? "全局" }}
            </template>
          </template>
        </a-table>

        <a-divider />
        <a-form v-if="canConfigure" layout="inline" @finish="doUpsertConfig">
          <a-form-item label="Provider Code">
            <a-input
              v-model:value="upsertForm.providerCode"
              placeholder="wechat_pay"
            />
          </a-form-item>
          <a-form-item label="商户号">
            <a-input v-model:value="upsertForm.merchantNo" placeholder="可选" />
          </a-form-item>
          <a-form-item label="App ID">
            <a-input v-model:value="upsertForm.appId" placeholder="可选" />
          </a-form-item>
          <a-form-item label="API Key (敏感)">
            <a-input-password
              v-model:value="upsertForm.apiKey"
              placeholder="可选"
            />
          </a-form-item>
          <a-form-item label="状态">
            <a-select v-model:value="upsertForm.status" style="width: 100px">
              <a-select-option value="enabled">启用</a-select-option>
              <a-select-option value="disabled">禁用</a-select-option>
            </a-select>
          </a-form-item>
          <a-form-item>
            <a-button
              type="primary"
              html-type="submit"
              :loading="upsertConfigLoading"
            >
              保存配置
            </a-button>
          </a-form-item>
        </a-form>
      </a-tab-pane>
    </a-tabs>
  </a-card>
</template>
