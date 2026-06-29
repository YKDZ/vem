<script setup lang="ts">
import { onMounted, ref } from "vue";

import {
  listPaymentEvents,
  listPaymentCodeAttempts,
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
  type WebhookAttempt,
  type ReconciliationAttempt,
  type Refund,
} from "@/api/payments";
import OrderDetailDrawer from "@/components/OrderDetailDrawer.vue";
import { useAuthStore } from "@/stores/auth";
import { formatCents, formatDateTime } from "@/utils/format";

import PaymentOpsPanel from "./PaymentOpsPanel.vue";
import PaymentProviderConfigPanel from "./PaymentProviderConfigPanel.vue";

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
  { title: "订单号", dataIndex: "orderNo", key: "order" },
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
  { title: "Provider", dataIndex: "providerCode", key: "providerCode" },
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
  { title: "Provider", dataIndex: "providerCode", key: "providerCode" },
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

const refundColumns = [
  { title: "退款单号", dataIndex: "refundNo", key: "refundNo" },
  { title: "支付单号", dataIndex: "paymentNo", key: "paymentNo" },
  { title: "订单号", dataIndex: "orderNo", key: "order" },
  { title: "Provider", dataIndex: "providerCode", key: "providerCode" },
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

      <a-tab-pane key="configs" tab="支付配置">
        <PaymentProviderConfigPanel />
      </a-tab-pane>

      <a-tab-pane key="webhook-attempts" tab="Webhook审计">
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
                  #{{ attempt.attemptNo }} {{ attempt.trigger }}:
                  {{ attempt.status }}
                  <template v-if="attempt.providerRefundStatus">
                    / provider {{ attempt.providerRefundStatus }}
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
