<script setup lang="ts">
import { onMounted, ref } from "vue";

import {
  listPaymentEvents,
  listPaymentCodeAttempts,
  listPaymentProviderConfigs,
  listPaymentProviders,
  listPayments,
  listWebhookAttempts,
  listReconciliationAttempts,
  listRefunds,
  manualReconcile,
  mockFail,
  mockSucceed,
  queryPaymentCodeAttempt,
  queryRefund,
  reversePaymentCodeAttempt,
  type PageResult,
  type Payment,
  type PaymentCodeAttempt,
  type PaymentEvent,
  type PaymentProvider,
  type PaymentProviderConfig,
  type WebhookAttempt,
  type ReconciliationAttempt,
  type Refund,
} from "@/api/payments";
import OrderDetailDrawer from "@/components/OrderDetailDrawer.vue";
import { useAuthStore } from "@/stores/auth";
import { formatCents, formatDateTime } from "@/utils/format";

import type { RealPaymentProviderCode } from "./payment-config-model";

import PaymentChannelPolicyPanel from "./PaymentChannelPolicyPanel.vue";
import PaymentOpsPanel from "./PaymentOpsPanel.vue";
import PaymentProviderConfigDrawer from "./PaymentProviderConfigDrawer.vue";

const authStore = useAuthStore();
const canConfigure = authStore.hasPermission("payments.configure");
const orderDetailDrawer = ref<InstanceType<typeof OrderDetailDrawer> | null>(
  null,
);

function openOrderDetail(orderId?: string | null): void {
  if (orderId) {
    orderDetailDrawer.value?.show(orderId);
  }
}

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
const providerConfigs = ref<PaymentProviderConfig[]>([]);
const providerConfigDrawerOpen = ref(false);
const providerConfigDrawerCode = ref<RealPaymentProviderCode | null>(null);
const providerConfigDrawerName = ref("");

async function loadProviders(): Promise<void> {
  providersLoading.value = true;
  try {
    const [providerRows, configRows] = await Promise.all([
      listPaymentProviders(),
      listPaymentProviderConfigs(),
    ]);
    providers.value = providerRows;
    providerConfigs.value = configRows;
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
  { title: "订单号", dataIndex: "orderNo", key: "order" },
  { title: "支付机构", dataIndex: "providerCode", key: "providerCode" },
  { title: "状态", dataIndex: "status", key: "status" },
  { title: "金额", dataIndex: "amountCents", key: "amountCents" },
  { title: "支付时间", dataIndex: "paidAt", key: "paidAt" },
  { title: "创建时间", dataIndex: "createdAt", key: "createdAt" },
  { title: "操作", key: "actions" },
];

const providerColumns = [
  { title: "机构编码", dataIndex: "code", key: "code" },
  { title: "名称", dataIndex: "name", key: "name" },
  { title: "类型", dataIndex: "type", key: "type" },
  { title: "状态", dataIndex: "status", key: "status" },
  { title: "配置", key: "config" },
  { title: "更新时间", key: "updatedAt" },
  { title: "操作", key: "actions" },
];

const eventColumns = [
  { title: "事件类型", dataIndex: "eventType", key: "eventType" },
  { title: "支付机构", dataIndex: "providerCode", key: "providerCode" },
  { title: "支付单号", dataIndex: "paymentNo", key: "paymentNo" },
  { title: "订单号", dataIndex: "orderNo", key: "order" },
  { title: "验签", dataIndex: "signatureValid", key: "signatureValid" },
  { title: "处理时间", dataIndex: "handledAt", key: "handledAt" },
  { title: "创建时间", dataIndex: "createdAt", key: "createdAt" },
];

// Webhook attempts tab
const webhookAttemptsLoading = ref(false);
const webhookAttempts = ref<PageResult<WebhookAttempt>>({
  items: [],
  total: 0,
  page: 1,
  pageSize: 20,
});

async function loadWebhookAttempts(page = 1): Promise<void> {
  webhookAttemptsLoading.value = true;
  try {
    webhookAttempts.value = await listWebhookAttempts({ page, pageSize: 20 });
  } finally {
    webhookAttemptsLoading.value = false;
  }
}

const webhookAttemptColumns = [
  { title: "支付机构", dataIndex: "providerCode", key: "providerCode" },
  { title: "类型", dataIndex: "eventKind", key: "eventKind" },
  { title: "事件", dataIndex: "eventType", key: "eventType" },
  { title: "支付单号", dataIndex: "paymentNo", key: "paymentNo" },
  { title: "订单号", dataIndex: "orderNo", key: "order" },
  { title: "退款单号", dataIndex: "refundNo", key: "refundNo" },
  { title: "验签", dataIndex: "signatureValid", key: "signatureValid" },
  { title: "业务验证", dataIndex: "businessValid", key: "businessValid" },
  { title: "已处理", dataIndex: "handled", key: "handled" },
  { title: "失败原因", dataIndex: "failureReason", key: "failureReason" },
  { title: "客户端IP", dataIndex: "remoteIp", key: "remoteIp" },
  { title: "创建时间", dataIndex: "createdAt", key: "createdAt" },
];

// Reconciliation attempts tab
const reconciliationLoading = ref(false);
const reconciliationAttempts = ref<PageResult<ReconciliationAttempt>>({
  items: [],
  total: 0,
  page: 1,
  pageSize: 20,
});

async function loadReconciliationAttempts(page = 1): Promise<void> {
  reconciliationLoading.value = true;
  try {
    reconciliationAttempts.value = await listReconciliationAttempts({
      page,
      pageSize: 20,
    });
  } finally {
    reconciliationLoading.value = false;
  }
}

const reconciliationColumns = [
  { title: "支付单号", dataIndex: "paymentNo", key: "paymentNo" },
  { title: "订单号", dataIndex: "orderNo", key: "order" },
  { title: "支付机构", dataIndex: "providerCode", key: "providerCode" },
  { title: "触发方式", dataIndex: "trigger", key: "trigger" },
  { title: "第N次", dataIndex: "attemptNo", key: "attemptNo" },
  { title: "状态", dataIndex: "status", key: "status" },
  {
    title: "提供商状态",
    dataIndex: "providerPaymentStatus",
    key: "providerPaymentStatus",
  },
  { title: "错误码", dataIndex: "errorCode", key: "errorCode" },
  { title: "下次重试", dataIndex: "nextRetryAt", key: "nextRetryAt" },
  { title: "创建时间", dataIndex: "createdAt", key: "createdAt" },
];

// Refunds tab
const refundsLoading = ref(false);
const refundQueryingIds = ref<Set<string>>(new Set());
const reasonDialogOpen = ref(false);
const reasonDialogTitle = ref("");
const reasonDialogValue = ref("");
let resolveReasonDialog: ((reason: string | null) => void) | null = null;
const refundsList = ref<PageResult<Refund>>({
  items: [],
  total: 0,
  page: 1,
  pageSize: 20,
});

const paymentCodeAttemptsLoading = ref(false);
const paymentCodeAttemptsList = ref<PageResult<PaymentCodeAttempt>>({
  items: [],
  total: 0,
  page: 1,
  pageSize: 20,
});

async function loadRefunds(page = 1): Promise<void> {
  refundsLoading.value = true;
  try {
    refundsList.value = await listRefunds({ page, pageSize: 20 });
  } finally {
    refundsLoading.value = false;
  }
}

async function loadPaymentCodeAttempts(page = 1): Promise<void> {
  paymentCodeAttemptsLoading.value = true;
  try {
    paymentCodeAttemptsList.value = await listPaymentCodeAttempts({
      page,
      pageSize: 20,
    });
  } finally {
    paymentCodeAttemptsLoading.value = false;
  }
}

function requestOperationReason(title: string): Promise<string | null> {
  reasonDialogTitle.value = title;
  reasonDialogValue.value = "";
  reasonDialogOpen.value = true;
  return new Promise((resolve) => {
    resolveReasonDialog = resolve;
  });
}

function confirmReasonDialog(): void {
  const reason = reasonDialogValue.value.trim();
  if (!reason) return;
  reasonDialogOpen.value = false;
  resolveReasonDialog?.(reason);
  resolveReasonDialog = null;
}

function cancelReasonDialog(): void {
  reasonDialogOpen.value = false;
  resolveReasonDialog?.(null);
  resolveReasonDialog = null;
}

async function doQueryPaymentCodeAttempt(id: string): Promise<void> {
  const reason = await requestOperationReason("请输入付款码查询原因");
  if (!reason) return;
  await queryPaymentCodeAttempt(id, reason);
  await loadPaymentCodeAttempts(paymentCodeAttemptsList.value.page);
}

async function doReversePaymentCodeAttempt(id: string): Promise<void> {
  const reason = await requestOperationReason("请输入付款码撤销原因");
  if (!reason) return;
  await reversePaymentCodeAttempt(id, reason);
  await loadPaymentCodeAttempts(paymentCodeAttemptsList.value.page);
}

async function doManualReconcile(paymentId: string): Promise<void> {
  const reason = await requestOperationReason("请输入手动对账原因");
  if (!reason) return;
  await manualReconcile(paymentId, reason);
  await loadPayments();
}

async function doQueryRefund(refundId: string): Promise<void> {
  const reason = await requestOperationReason("请输入退款查询原因");
  if (!reason) return;
  if (refundQueryingIds.value.has(refundId)) return;
  refundQueryingIds.value = new Set([...refundQueryingIds.value, refundId]);
  try {
    await queryRefund(refundId, reason);
    await loadRefunds(refundsList.value.page);
  } finally {
    const next = new Set(refundQueryingIds.value);
    next.delete(refundId);
    refundQueryingIds.value = next;
  }
}

function refundReconciliationTriggerLabel(trigger: string): string {
  if (trigger === "manual") return "人工查询";
  if (trigger === "scheduled") return "自动查询";
  if (trigger === "provider_query") return "退款查询";
  return "退款查询";
}

function refundReconciliationStatusLabel(status: string): string {
  if (status === "succeeded" || status === "success") return "已确认";
  if (
    status === "processing" ||
    status === "pending" ||
    status === "querying"
  ) {
    return "处理中";
  }
  if (status === "unknown") return "结果待确认";
  if (
    status === "failed" ||
    status === "network_error" ||
    status === "config_error" ||
    status === "max_attempts_exceeded"
  ) {
    return "查询失败";
  }
  return "待复核";
}

function providerRefundStatusSummary(status: string | null): string | null {
  if (!status) return null;
  const normalized = status.toLowerCase();
  if (normalized.includes("success")) return "渠道已确认退款";
  if (normalized.includes("refund") || normalized.includes("process")) {
    return "渠道仍在处理";
  }
  if (normalized.includes("fail") || normalized.includes("closed")) {
    return "渠道退款异常";
  }
  if (normalized.includes("not_found") || normalized.includes("notfound")) {
    return "渠道暂未查到退款";
  }
  return "渠道结果待复核";
}

function isRealProviderCode(code: string): code is RealPaymentProviderCode {
  return code === "alipay" || code === "wechat_pay";
}

function getProviderConfigs(providerCode: string): PaymentProviderConfig[] {
  return providerConfigs.value.filter(
    (config) => config.providerCode === providerCode,
  );
}

function providerConfigLabel(providerCode: string): string {
  const rows = getProviderConfigs(providerCode);
  if (rows.length === 0) return "未配置";
  const enabledCount = rows.filter((row) => row.status === "enabled").length;
  if (enabledCount === 0) return "已配置，未启用";
  return rows.length === 1 ? "已配置" : `已配置 ${rows.length} 个范围`;
}

function providerConfigColor(providerCode: string): string {
  const rows = getProviderConfigs(providerCode);
  if (rows.length === 0) return "default";
  return rows.some((row) => row.status === "enabled") ? "success" : "warning";
}

function providerConfigUpdatedAt(providerCode: string): string | null {
  const latest = getProviderConfigs(providerCode)
    .map((row) => row.updatedAt)
    .sort()
    .at(-1);
  return latest ?? null;
}

function openProviderConfigDrawer(provider: PaymentProvider): void {
  if (!isRealProviderCode(provider.code) || !canConfigure) return;
  providerConfigDrawerCode.value = provider.code;
  providerConfigDrawerName.value = provider.name;
  providerConfigDrawerOpen.value = true;
}

async function handleProviderConfigSaved(): Promise<void> {
  await loadProviders();
}

const refundColumns = [
  { title: "退款单号", dataIndex: "refundNo", key: "refundNo" },
  { title: "支付单号", dataIndex: "paymentNo", key: "paymentNo" },
  { title: "订单号", dataIndex: "orderNo", key: "order" },
  { title: "支付机构", dataIndex: "providerCode", key: "providerCode" },
  { title: "状态", dataIndex: "status", key: "status" },
  { title: "金额", dataIndex: "amountCents", key: "amountCents" },
  { title: "原因", dataIndex: "reason", key: "reason" },
  {
    title: "最近查询",
    dataIndex: "latestReconciliationStatus",
    key: "latestReconciliation",
  },
  { title: "退款时间", dataIndex: "refundedAt", key: "refundedAt" },
  { title: "创建时间", dataIndex: "createdAt", key: "createdAt" },
  { title: "操作", key: "actions" },
];

const paymentCodeAttemptColumns = [
  { title: "订单号", dataIndex: "orderNo", key: "order" },
  { title: "支付单号", dataIndex: "paymentNo", key: "paymentNo" },
  { title: "渠道", dataIndex: "providerCode", key: "providerCode" },
  { title: "尝试", dataIndex: "attemptNo", key: "attemptNo" },
  { title: "付款码", dataIndex: "authCodeMasked", key: "authCodeMasked" },
  { title: "状态", dataIndex: "status", key: "status" },
  { title: "失败原因", dataIndex: "failureMessage", key: "failureMessage" },
  { title: "操作", key: "actions" },
];

function onTabChange(key: string): void {
  if (key === "payments") void loadPayments();
  else if (key === "providers") void loadProviders();
  else if (key === "events") void loadEvents();
  else if (key === "webhook-attempts") void loadWebhookAttempts();
  else if (key === "reconciliation") void loadReconciliationAttempts();
  else if (key === "refunds") void loadRefunds();
  else if (key === "payment-code-attempts") void loadPaymentCodeAttempts();
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
            <template v-else-if="column.key === 'order'">
              <a-button
                type="link"
                size="small"
                class="px-0"
                @click="openOrderDetail(record.orderId)"
              >
                {{ record.orderNo || record.orderId }}
              </a-button>
            </template>
            <template
              v-else-if="column.key === 'paidAt' || column.key === 'createdAt'"
            >
              {{ formatDateTime(record[column.key]) }}
            </template>
            <template v-else-if="column.key === 'actions'">
              <a-space>
                <template v-if="canConfigure && record.providerCode === 'mock'">
                  <a-button
                    size="small"
                    @click="doMockSucceed(record.paymentNo)"
                  >
                    模拟成功
                  </a-button>
                  <a-button
                    size="small"
                    danger
                    @click="doMockFail(record.paymentNo)"
                  >
                    模拟失败
                  </a-button>
                </template>
                <a-button
                  v-if="
                    canConfigure &&
                    (record.status === 'pending' ||
                      record.status === 'processing')
                  "
                  size="small"
                  type="dashed"
                  @click="doManualReconcile(record.id)"
                >
                  手动对账
                </a-button>
              </a-space>
            </template>
          </template>
        </a-table>
      </a-tab-pane>

      <a-tab-pane key="channels" tab="支付渠道">
        <PaymentChannelPolicyPanel />
      </a-tab-pane>

      <a-tab-pane key="providers" tab="支付机构">
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
                {{ record.status === "enabled" ? "启用" : "禁用" }}
              </a-tag>
            </template>
            <template v-else-if="column.key === 'config'">
              <a-tag :color="providerConfigColor(record.code)">
                {{ providerConfigLabel(record.code) }}
              </a-tag>
            </template>
            <template v-else-if="column.key === 'updatedAt'">
              {{ formatDateTime(providerConfigUpdatedAt(record.code)) }}
            </template>
            <template v-else-if="column.key === 'actions'">
              <a-button
                v-if="isRealProviderCode(record.code) && canConfigure"
                size="small"
                @click="openProviderConfigDrawer(record)"
              >
                编辑
              </a-button>
              <span v-else>-</span>
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
            <template v-else-if="column.key === 'order'">
              <a-button
                type="link"
                size="small"
                class="px-0"
                @click="openOrderDetail(record.orderId)"
              >
                {{ record.orderNo || record.orderId }}
              </a-button>
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

      <a-tab-pane key="webhook-attempts" tab="回调审计">
        <a-table
          :columns="webhookAttemptColumns"
          :data-source="webhookAttempts.items"
          row-key="id"
          :loading="webhookAttemptsLoading"
          :pagination="{
            current: webhookAttempts.page,
            pageSize: webhookAttempts.pageSize,
            total: webhookAttempts.total,
            onChange: loadWebhookAttempts,
          }"
        >
          <template #bodyCell="{ column, record }">
            <template
              v-if="
                column.key === 'signatureValid' ||
                column.key === 'businessValid' ||
                column.key === 'handled'
              "
            >
              <a-tag v-if="record[column.key] === true" color="success"
                >是</a-tag
              >
              <a-tag v-else-if="record[column.key] === false" color="error"
                >否</a-tag
              >
              <span v-else>-</span>
            </template>
            <template v-else-if="column.key === 'order'">
              <a-button
                v-if="record.orderId"
                type="link"
                size="small"
                class="px-0"
                @click="openOrderDetail(record.orderId)"
              >
                {{ record.orderNo || record.orderId }}
              </a-button>
              <span v-else>{{ record.orderNo || "-" }}</span>
            </template>
            <template v-else-if="column.key === 'createdAt'">
              {{ formatDateTime(record.createdAt) }}
            </template>
          </template>
        </a-table>
      </a-tab-pane>

      <a-tab-pane key="reconciliation" tab="对账记录">
        <a-table
          :columns="reconciliationColumns"
          :data-source="reconciliationAttempts.items"
          row-key="id"
          :loading="reconciliationLoading"
          :pagination="{
            current: reconciliationAttempts.page,
            pageSize: reconciliationAttempts.pageSize,
            total: reconciliationAttempts.total,
            onChange: loadReconciliationAttempts,
          }"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'order'">
              <a-button
                type="link"
                size="small"
                class="px-0"
                @click="openOrderDetail(record.orderId)"
              >
                {{ record.orderNo || record.orderId }}
              </a-button>
            </template>
            <template
              v-else-if="
                column.key === 'nextRetryAt' || column.key === 'createdAt'
              "
            >
              {{ formatDateTime(record[column.key]) }}
            </template>
          </template>
        </a-table>
      </a-tab-pane>

      <a-tab-pane key="refunds" tab="退款管理">
        <a-table
          :columns="refundColumns"
          :data-source="refundsList.items"
          row-key="id"
          :loading="refundsLoading"
          :pagination="{
            current: refundsList.page,
            pageSize: refundsList.pageSize,
            total: refundsList.total,
            onChange: loadRefunds,
          }"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'amountCents'">
              {{ formatCents(record.amountCents) }}
            </template>
            <template v-else-if="column.key === 'order'">
              <a-button
                type="link"
                size="small"
                class="px-0"
                @click="openOrderDetail(record.orderId)"
              >
                {{ record.orderNo || record.orderId }}
              </a-button>
            </template>
            <template
              v-else-if="
                column.key === 'refundedAt' || column.key === 'createdAt'
              "
            >
              {{ formatDateTime(record[column.key]) }}
            </template>
            <template v-else-if="column.key === 'latestReconciliation'">
              <a-space
                v-if="record.reconciliationAttempts.length > 0"
                direction="vertical"
                size="small"
              >
                <span
                  v-for="attempt in record.reconciliationAttempts"
                  :key="`${record.id}-${attempt.trigger}-${attempt.attemptNo}-${attempt.createdAt}`"
                >
                  第 {{ attempt.attemptNo }} 次
                  {{ refundReconciliationTriggerLabel(attempt.trigger) }}：{{
                    refundReconciliationStatusLabel(attempt.status)
                  }}
                  <template
                    v-if="
                      providerRefundStatusSummary(attempt.providerRefundStatus)
                    "
                  >
                    /
                    {{
                      providerRefundStatusSummary(attempt.providerRefundStatus)
                    }}
                  </template>
                  <template v-if="attempt.errorMessage">
                    / {{ attempt.errorMessage }}
                  </template>
                  <template v-if="attempt.finishedAt">
                    / {{ formatDateTime(attempt.finishedAt) }}
                  </template>
                </span>
              </a-space>
              <span v-else>-</span>
            </template>
            <template v-else-if="column.key === 'actions'">
              <a-button
                v-if="
                  canConfigure &&
                  (record.status === 'processing' ||
                    record.status === 'created')
                "
                size="small"
                type="dashed"
                :loading="refundQueryingIds.has(record.id)"
                :disabled="refundQueryingIds.has(record.id)"
                @click="doQueryRefund(record.id)"
              >
                查询
              </a-button>
            </template>
          </template>
        </a-table>
      </a-tab-pane>

      <a-tab-pane key="payment-code-attempts" tab="付款码尝试">
        <a-table
          :columns="paymentCodeAttemptColumns"
          :data-source="paymentCodeAttemptsList.items"
          row-key="id"
          :loading="paymentCodeAttemptsLoading"
          :pagination="{
            current: paymentCodeAttemptsList.page,
            pageSize: paymentCodeAttemptsList.pageSize,
            total: paymentCodeAttemptsList.total,
            onChange: loadPaymentCodeAttempts,
          }"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'order'">
              <a-button
                type="link"
                size="small"
                class="px-0"
                @click="openOrderDetail(record.orderId)"
              >
                {{ record.orderNo || record.orderId }}
              </a-button>
            </template>
            <template v-else-if="column.key === 'actions'">
              <a-space v-if="canConfigure">
                <a-button
                  size="small"
                  @click="doQueryPaymentCodeAttempt(record.id)"
                >
                  查询
                </a-button>
                <a-button
                  size="small"
                  danger
                  :disabled="
                    ![
                      'querying',
                      'unknown',
                      'manual_handling',
                      'reversing',
                    ].includes(record.status)
                  "
                  @click="doReversePaymentCodeAttempt(record.id)"
                >
                  撤销
                </a-button>
              </a-space>
            </template>
            <template v-else-if="column.key === 'createdAt'">
              {{ formatDateTime(record.createdAt) }}
            </template>
          </template>
        </a-table>
      </a-tab-pane>

      <a-tab-pane key="ops" tab="上线门禁">
        <PaymentOpsPanel />
      </a-tab-pane>
    </a-tabs>
    <PaymentProviderConfigDrawer
      v-model:open="providerConfigDrawerOpen"
      :provider-code="providerConfigDrawerCode"
      :provider-name="providerConfigDrawerName"
      @saved="handleProviderConfigSaved"
    />
    <OrderDetailDrawer ref="orderDetailDrawer" />
    <a-modal
      v-model:open="reasonDialogOpen"
      :title="reasonDialogTitle"
      ok-text="确认"
      cancel-text="取消"
      :ok-button-props="{ disabled: !reasonDialogValue.trim() }"
      @ok="confirmReasonDialog"
      @cancel="cancelReasonDialog"
    >
      <a-textarea
        v-model:value="reasonDialogValue"
        :rows="4"
        placeholder="请输入本次操作原因"
        autofocus
      />
    </a-modal>
  </a-card>
</template>
