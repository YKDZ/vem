<script setup lang="ts">
import { computed, ref } from "vue";

import {
  createOrderRecoveryAction,
  getOrderInvestigation,
  type OrderInvestigation,
  type OrderRecoveryAction,
} from "@/api/orders";
import { createPaymentIncidentAction } from "@/api/payments";
import { useAuthStore } from "@/stores/auth";
import { formatCents, formatDateTime } from "@/utils/format";

const authStore = useAuthStore();
const open = ref(false);
const loading = ref(false);
const recoveryLoading = ref(false);
const incidentActionLoading = ref(false);
const orderDetail = ref<OrderInvestigation | null>(null);
const errorMessage = ref<string | null>(null);
const recoveryNote = ref("");
const incidentActionReason = ref("");

const canReadPayments = computed(() =>
  authStore.hasPermission("payments.read"),
);
const canConfigurePayments = computed(() =>
  authStore.hasPermission("payments.configure"),
);
const canReadInventory = computed(() =>
  authStore.hasPermission("inventory.read"),
);
const canReadMaintenance = computed(() =>
  authStore.hasPermission("maintenanceWorkOrders.read"),
);
const canReadAudit = computed(() => authStore.hasPermission("audit.read"));
const canReadPaymentDiagnostics = computed(
  () => canConfigurePayments.value || canReadAudit.value,
);
const canRecover = computed(() => authStore.hasPermission("orders.recover"));
const canSubmitRecovery = computed(() => recoveryNote.value.trim().length > 0);
const canSubmitIncidentAction = computed(
  () => incidentActionReason.value.trim().length > 0,
);
const incidentPayment = computed(() => orderDetail.value?.payments[0] ?? null);
const incidentRefund = computed(
  () =>
    orderDetail.value?.refunds.find((refund) =>
      ["created", "processing", "failed"].includes(refund.status),
    ) ?? null,
);
const availableRecoveryActions = computed<OrderRecoveryAction[]>(() => {
  return (
    orderDetail.value?.fulfillmentProjection.availableRecoveryActions ?? []
  );
});
const diagnosticRefundAttempts = computed(() =>
  (orderDetail.value?.refunds ?? []).flatMap((refund) =>
    (refund.reconciliationAttempts ?? []).map((attempt) => ({
      ...attempt,
      refundNo: refund.refundNo,
    })),
  ),
);

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

const paymentWebhookColumns = [
  { title: "事件", dataIndex: "eventType", key: "eventType" },
  { title: "支付单号", dataIndex: "paymentNo", key: "paymentNo" },
  { title: "处理", dataIndex: "handled", key: "handled" },
  { title: "时间", dataIndex: "createdAt", key: "createdAt" },
];

const paymentEventColumns = [
  { title: "事件", dataIndex: "eventType", key: "eventType" },
  { title: "签名", dataIndex: "signatureValid", key: "signatureValid" },
  { title: "时间", dataIndex: "createdAt", key: "createdAt" },
];

const paymentReconciliationColumns = [
  { title: "触发", dataIndex: "trigger", key: "trigger" },
  { title: "次数", dataIndex: "attemptNo", key: "attemptNo" },
  { title: "状态", dataIndex: "status", key: "status" },
  { title: "错误", dataIndex: "errorMessage", key: "errorMessage" },
];

const paymentCodeAttemptColumns = [
  { title: "次数", dataIndex: "attemptNo", key: "attemptNo" },
  { title: "状态", dataIndex: "status", key: "status" },
  { title: "付款码", dataIndex: "authCodeMasked", key: "authCodeMasked" },
  { title: "摘要", key: "summary" },
  { title: "处理原因", dataIndex: "manualReason", key: "manualReason" },
  { title: "查询时间", dataIndex: "lastCheckedAt", key: "lastCheckedAt" },
  { title: "撤销时间", dataIndex: "reversedAt", key: "reversedAt" },
  { title: "来源", dataIndex: "source", key: "source" },
];

const vendingCommandColumns = [
  { title: "命令号", dataIndex: "commandNo", key: "commandNo" },
  { title: "状态", dataIndex: "status", key: "status" },
  { title: "机器", dataIndex: "machineCode", key: "machineCode" },
  { title: "货道", dataIndex: "slotDisplayLabel", key: "slotDisplayLabel" },
  { title: "错误", dataIndex: "lastError", key: "lastError" },
];

function formatVendingCommandStatus(status: unknown): string {
  if (status === "result_unknown") return "待物理结果确认";
  return typeof status === "string" ? status : "-";
}

function formatOrderStatus(status: unknown): string {
  const labels: Record<string, string> = {
    pending_payment: "待支付",
    payment_expired: "支付已过期",
    canceled: "已取消",
    paid: "已支付",
    dispensing: "出货中",
    fulfilled: "已完成",
    dispense_failed: "出货失败",
    manual_handling: "人工处理",
    refund_pending: "退款待处理",
    refunded: "已退款",
    closed: "已关闭",
  };
  return typeof status === "string" ? (labels[status] ?? status) : "-";
}

function formatPaymentState(status: unknown): string {
  const labels: Record<string, string> = {
    awaiting_payment: "待支付",
    paid: "已支付",
    payment_failed: "支付失败",
    payment_expired: "支付已过期",
    payment_unknown: "支付结果未知",
    canceled: "已取消",
    refund_pending: "退款待处理",
    partial_refund_pending: "部分退款待处理",
    manual_handling: "人工处理",
    refunded: "已退款",
    partial_refunded: "部分退款完成",
  };
  return typeof status === "string" ? (labels[status] ?? status) : "-";
}

function formatFulfillmentState(status: unknown): string {
  const labels: Record<string, string> = {
    awaiting_fulfillment: "待出货",
    dispensing: "出货中",
    dispensed: "已出货",
    partial_dispensed: "部分出货",
    dispense_failed: "出货失败",
    manual_handling: "人工处理",
    canceled: "已取消",
  };
  return typeof status === "string" ? (labels[status] ?? status) : "-";
}

function formatPaymentStatus(status: unknown): string {
  const labels: Record<string, string> = {
    created: "已创建",
    pending: "待支付",
    processing: "支付确认中",
    succeeded: "支付成功",
    failed: "支付失败",
    expired: "支付已过期",
    canceled: "已关闭",
    unknown: "支付结果未知",
    refund_pending: "退款待处理",
    partial_refund_pending: "部分退款待处理",
    manual_handling: "人工处理",
    refunded: "已退款",
    partial_refunded: "部分退款完成",
  };
  return typeof status === "string" ? (labels[status] ?? status) : "-";
}

function formatPaymentEventType(eventType: unknown): string {
  const labels: Record<string, string> = {
    "payment.succeeded": "支付成功通知",
    "payment.failed": "支付失败通知",
    "payment.unknown": "支付结果未知",
    "payment.manual_handling": "人工处理标记",
    "payment.canceled": "支付关闭",
    "payment.expired": "支付过期",
    "payment_code.succeeded": "付款码支付成功",
    "payment_code.query_succeeded": "付款码查询成功",
    "payment_code.manual_query_succeeded": "付款码人工查询成功",
    "refund.created": "退款已创建",
    "refund.processing": "退款处理中",
    "refund.succeeded": "退款成功",
    "refund.failed": "退款失败",
  };
  return typeof eventType === "string"
    ? (labels[eventType] ?? "渠道事件")
    : "-";
}

function formatPaymentCodeAttemptStatus(status: unknown): string {
  const labels: Record<string, string> = {
    created: "已创建",
    submitting: "提交中",
    user_confirming: "用户确认中",
    querying: "查询中",
    succeeded: "支付成功",
    failed: "支付失败",
    reversing: "撤销中",
    reversed: "已撤销",
    unknown: "支付结果未知",
    reversal_unknown: "撤销结果未知",
    manual_handling: "人工处理",
    canceled: "已取消",
  };
  return typeof status === "string" ? (labels[status] ?? status) : "-";
}

function formatRefundStatus(status: unknown): string {
  const labels: Record<string, string> = {
    created: "已创建",
    processing: "退款处理中",
    succeeded: "退款成功",
    failed: "退款失败",
    canceled: "已取消",
  };
  return typeof status === "string" ? (labels[status] ?? status) : "-";
}

function formatPaymentCodeAttemptSummary(
  record: Record<string, unknown>,
): string {
  if (record.status === "reversal_unknown") return "撤销结果未知，需人工核验";
  if (record.status === "unknown") return "支付结果未知，需继续查询或撤销";
  if (record.status === "manual_handling") return "已转人工处理";
  if (record.status === "failed") return "付款码支付失败";
  if (record.status === "succeeded") return "付款码支付成功";
  if (record.status === "user_confirming") return "等待用户确认";
  if (record.status === "querying") return "正在查询支付结果";
  return "等待处理";
}

function formatRefundReconciliationSummary(
  record: Record<string, unknown>,
): string {
  const attempts = Array.isArray(record.reconciliationAttempts)
    ? record.reconciliationAttempts
    : [];
  const latest = attempts[0] as Record<string, unknown> | undefined;
  if (!latest) return "暂无查询记录";
  const status = typeof latest.status === "string" ? latest.status : "";
  if (status === "network_error") return "最近查询失败";
  if (status === "processing") return "最近查询仍在处理";
  if (status === "failed") return "最近查询为退款失败";
  if (status === "succeeded") return "最近查询为退款成功";
  if (status === "max_attempts_exceeded") return "查询次数已达上限";
  return "已有查询记录";
}

function refundAttemptRowKey(record: Record<string, unknown>): string {
  return `${record.refundNo ?? "refund"}-${record.attemptNo ?? "attempt"}-${record.createdAt ?? ""}`;
}

const inventoryMovementColumns = [
  { title: "库存", dataIndex: "inventoryId", key: "inventoryId" },
  { title: "变化", dataIndex: "deltaQty", key: "deltaQty" },
  { title: "原因", dataIndex: "reason", key: "reason" },
  { title: "备注", dataIndex: "note", key: "note" },
];

const stockReconciliationColumns = [
  { title: "移动ID", dataIndex: "movementId", key: "movementId" },
  { title: "状态", dataIndex: "status", key: "status" },
  { title: "原因", dataIndex: "reconciliationReason", key: "reason" },
  { title: "复核", dataIndex: "platformReviewStatus", key: "review" },
];

const refundColumns = [
  { title: "退款单号", dataIndex: "refundNo", key: "refundNo" },
  { title: "状态", dataIndex: "status", key: "status" },
  { title: "金额", dataIndex: "amountCents", key: "amountCents" },
  { title: "原因", dataIndex: "reason", key: "reason" },
  { title: "查询摘要", key: "reconciliationSummary" },
];

const diagnosticPaymentEventColumns = [
  { title: "事件", dataIndex: "eventType", key: "eventType" },
  { title: "渠道事件号", dataIndex: "providerEventId", key: "providerEventId" },
  { title: "时间", dataIndex: "createdAt", key: "createdAt" },
];

const diagnosticPaymentCodeAttemptColumns = [
  { title: "次数", dataIndex: "attemptNo", key: "attemptNo" },
  {
    title: "付款尝试号",
    dataIndex: "providerPaymentNo",
    key: "providerPaymentNo",
  },
  { title: "渠道交易号", dataIndex: "providerTradeNo", key: "providerTradeNo" },
  { title: "渠道状态", dataIndex: "providerStatus", key: "providerStatus" },
  { title: "错误码", dataIndex: "failureCode", key: "failureCode" },
];

const diagnosticRefundAttemptColumns = [
  { title: "退款单号", dataIndex: "refundNo", key: "refundNo" },
  { title: "触发", dataIndex: "trigger", key: "trigger" },
  { title: "次数", dataIndex: "attemptNo", key: "attemptNo" },
  { title: "状态", dataIndex: "status", key: "status" },
  {
    title: "渠道退款状态",
    dataIndex: "providerRefundStatus",
    key: "providerRefundStatus",
  },
  {
    title: "渠道退款号",
    dataIndex: "providerRefundNo",
    key: "providerRefundNo",
  },
  { title: "错误码", dataIndex: "errorCode", key: "errorCode" },
  { title: "错误", dataIndex: "errorMessage", key: "errorMessage" },
  { title: "时间", dataIndex: "createdAt", key: "createdAt" },
];

const workOrderColumns = [
  { title: "工单号", dataIndex: "workOrderNo", key: "workOrderNo" },
  { title: "状态", dataIndex: "status", key: "status" },
  { title: "标题", dataIndex: "title", key: "title" },
];

const auditColumns = [
  { title: "动作", dataIndex: "action", key: "action" },
  { title: "资源", dataIndex: "resourceType", key: "resourceType" },
  { title: "时间", dataIndex: "createdAt", key: "createdAt" },
];

function textFromSnapshot(
  snapshot: Record<string, unknown>,
  key: string,
): string | null {
  const value = snapshot[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function diagnosticValue(
  record: Record<string, unknown>,
  key: string,
): unknown {
  const diagnostics = record.protectedDiagnostics;
  if (!diagnostics || typeof diagnostics !== "object") return "";
  return (diagnostics as Record<string, unknown>)[key] ?? "";
}

async function show(orderId: string): Promise<void> {
  open.value = true;
  loading.value = true;
  orderDetail.value = null;
  errorMessage.value = null;
  try {
    orderDetail.value = await getOrderInvestigation(orderId);
    recoveryNote.value = "";
    incidentActionReason.value = "";
  } catch (error) {
    errorMessage.value =
      error instanceof Error && error.message.trim()
        ? error.message
        : "订单调查加载失败";
  } finally {
    loading.value = false;
  }
}

async function submitRecoveryAction(
  action: OrderRecoveryAction,
): Promise<void> {
  if (!orderDetail.value || !canSubmitRecovery.value) return;
  recoveryLoading.value = true;
  try {
    await createOrderRecoveryAction(orderDetail.value.order.id, {
      action,
      note: recoveryNote.value.trim(),
    });
    orderDetail.value = await getOrderInvestigation(orderDetail.value.order.id);
    recoveryNote.value = "";
  } finally {
    recoveryLoading.value = false;
  }
}

async function submitPaymentIncidentAction(
  action:
    | "query_payment"
    | "close_or_reverse_uncertain_payment"
    | "query_refund"
    | "request_refund_handling"
    | "mark_manual_handling",
): Promise<void> {
  if (
    !orderDetail.value ||
    !incidentPayment.value ||
    !canSubmitIncidentAction.value
  ) {
    return;
  }
  const reason = incidentActionReason.value.trim();
  incidentActionLoading.value = true;
  try {
    if (action === "query_refund") {
      if (!incidentRefund.value) return;
      await createPaymentIncidentAction(incidentPayment.value.id, {
        action,
        reason,
        refundId: incidentRefund.value.id,
      });
    } else {
      await createPaymentIncidentAction(incidentPayment.value.id, {
        action,
        reason,
      });
    }
    orderDetail.value = await getOrderInvestigation(orderDetail.value.order.id);
    incidentActionReason.value = "";
  } finally {
    incidentActionLoading.value = false;
  }
}

defineExpose({ show });
</script>

<template>
  <a-drawer
    v-model:open="open"
    title="订单调查"
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
            {{ formatOrderStatus(orderDetail.order.status) }}
          </a-descriptions-item>
          <a-descriptions-item label="支付状态">
            {{ formatPaymentState(orderDetail.order.paymentState) }}
          </a-descriptions-item>
          <a-descriptions-item label="履约状态">
            {{ formatFulfillmentState(orderDetail.order.fulfillmentState) }}
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
                textFromSnapshot(record.productSnapshot, "slotDisplayLabel") ??
                textFromSnapshot(record.productSnapshot, "slotId") ??
                "-"
              }}
            </template>
            <template v-else-if="column.key === 'unitPriceCents'">
              {{ formatCents(record.unitPriceCents) }}
            </template>
          </template>
        </a-table>

        <template v-if="canReadPayments">
          <a-divider>支付证据</a-divider>
          <a-empty
            v-if="orderDetail.payments.length === 0"
            description="暂无支付流水"
          />
          <a-table
            v-else
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
              <template v-else-if="column.key === 'status'">
                {{ formatPaymentStatus(record.status) }}
              </template>
              <template v-else-if="column.key === 'paidAt'">
                {{ formatDateTime(record.paidAt) }}
              </template>
            </template>
          </a-table>

          <div
            v-if="canConfigurePayments && incidentPayment"
            class="mt-3 space-y-2"
          >
            <textarea
              v-model="incidentActionReason"
              class="w-full rounded border border-slate-300 px-3 py-2 text-sm"
              rows="3"
              placeholder="填写支付处理备注"
            />
            <div class="flex flex-wrap gap-2">
              <button
                type="button"
                :disabled="!canSubmitIncidentAction || incidentActionLoading"
                @click="submitPaymentIncidentAction('query_payment')"
              >
                查询支付
              </button>
              <button
                type="button"
                :disabled="!canSubmitIncidentAction || incidentActionLoading"
                @click="
                  submitPaymentIncidentAction(
                    'close_or_reverse_uncertain_payment',
                  )
                "
              >
                关闭/撤销不确定支付
              </button>
              <button
                v-if="incidentRefund"
                type="button"
                :disabled="!canSubmitIncidentAction || incidentActionLoading"
                @click="submitPaymentIncidentAction('query_refund')"
              >
                查询退款
              </button>
              <button
                type="button"
                :disabled="!canSubmitIncidentAction || incidentActionLoading"
                @click="submitPaymentIncidentAction('request_refund_handling')"
              >
                申请退款处理
              </button>
              <button
                type="button"
                :disabled="!canSubmitIncidentAction || incidentActionLoading"
                @click="submitPaymentIncidentAction('mark_manual_handling')"
              >
                标记人工处理
              </button>
            </div>
          </div>

          <a-divider>支付事件</a-divider>
          <a-empty
            v-if="orderDetail.paymentEvents.length === 0"
            description="暂无支付事件"
          />
          <a-table
            v-else
            :columns="paymentEventColumns"
            :data-source="orderDetail.paymentEvents"
            row-key="id"
            :pagination="false"
            size="small"
          >
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'eventType'">
                {{ formatPaymentEventType(record.eventType) }}
              </template>
              <template v-else-if="column.key === 'signatureValid'">
                {{
                  record.signatureValid === null ||
                  record.signatureValid === undefined
                    ? "-"
                    : record.signatureValid
                      ? "有效"
                      : "无效"
                }}
              </template>
              <template v-else-if="column.key === 'createdAt'">
                {{ formatDateTime(record.createdAt) }}
              </template>
              <template v-else-if="column.dataIndex">
                {{ record[column.dataIndex] ?? "" }}
              </template>
            </template>
          </a-table>

          <a-divider>回调尝试</a-divider>
          <a-empty
            v-if="orderDetail.paymentWebhookAttempts.length === 0"
            description="暂无回调尝试"
          />
          <a-table
            v-else
            :columns="paymentWebhookColumns"
            :data-source="orderDetail.paymentWebhookAttempts"
            row-key="id"
            :pagination="false"
            size="small"
          />

          <a-divider>支付对账尝试</a-divider>
          <a-empty
            v-if="orderDetail.paymentReconciliationAttempts.length === 0"
            description="暂无支付对账尝试"
          />
          <a-table
            v-else
            :columns="paymentReconciliationColumns"
            :data-source="orderDetail.paymentReconciliationAttempts"
            row-key="id"
            :pagination="false"
            size="small"
          />

          <a-divider>付款码尝试</a-divider>
          <a-empty
            v-if="orderDetail.paymentCodeAttempts.length === 0"
            description="暂无付款码尝试"
          />
          <a-table
            v-else
            :columns="paymentCodeAttemptColumns"
            :data-source="orderDetail.paymentCodeAttempts"
            row-key="id"
            :pagination="false"
            size="small"
          >
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'status'">
                {{ formatPaymentCodeAttemptStatus(record.status) }}
              </template>
              <template v-else-if="column.key === 'summary'">
                {{ formatPaymentCodeAttemptSummary(record) }}
              </template>
              <template v-else-if="column.dataIndex">
                {{ record[column.dataIndex] ?? "" }}
              </template>
            </template>
          </a-table>

          <a-divider>退款记录</a-divider>
          <a-empty
            v-if="orderDetail.refunds.length === 0"
            description="暂无退款记录"
          />
          <a-table
            v-else
            :columns="refundColumns"
            :data-source="orderDetail.refunds"
            row-key="id"
            :pagination="false"
            size="small"
          >
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'amountCents'">
                {{ formatCents(record.amountCents) }}
              </template>
              <template v-else-if="column.key === 'status'">
                {{ formatRefundStatus(record.status) }}
              </template>
              <template v-else-if="column.key === 'reconciliationSummary'">
                {{ formatRefundReconciliationSummary(record) }}
              </template>
            </template>
          </a-table>

          <a-collapse v-if="canReadPaymentDiagnostics" class="mt-3" ghost>
            <a-collapse-panel key="payment-diagnostics" header="支付诊断">
              <a-divider>渠道事件诊断</a-divider>
              <a-empty
                v-if="orderDetail.paymentEvents.length === 0"
                description="暂无渠道事件诊断"
              />
              <a-table
                v-else
                :columns="diagnosticPaymentEventColumns"
                :data-source="orderDetail.paymentEvents"
                row-key="id"
                :pagination="false"
                size="small"
              >
                <template #bodyCell="{ column, record }">
                  <template v-if="column.key === 'eventType'">
                    {{ formatPaymentEventType(record.eventType) }}
                  </template>
                  <template v-else-if="column.key === 'createdAt'">
                    {{ formatDateTime(record.createdAt) }}
                  </template>
                  <template v-else-if="column.key === 'providerEventId'">
                    {{ diagnosticValue(record, "providerEventId") }}
                  </template>
                  <template v-else-if="column.dataIndex">
                    {{ record[column.dataIndex] ?? "" }}
                  </template>
                </template>
              </a-table>

              <a-divider>付款码诊断</a-divider>
              <a-empty
                v-if="orderDetail.paymentCodeAttempts.length === 0"
                description="暂无付款码诊断"
              />
              <a-table
                v-else
                :columns="diagnosticPaymentCodeAttemptColumns"
                :data-source="orderDetail.paymentCodeAttempts"
                row-key="id"
                :pagination="false"
                size="small"
              >
                <template #bodyCell="{ column, record }">
                  <template v-if="column.key === 'attemptNo'">
                    {{ record.attemptNo }}
                  </template>
                  <template v-else-if="column.dataIndex">
                    {{ diagnosticValue(record, column.dataIndex) }}
                  </template>
                </template>
              </a-table>

              <a-divider>退款查询诊断</a-divider>
              <a-empty
                v-if="diagnosticRefundAttempts.length === 0"
                description="暂无退款查询诊断"
              />
              <a-table
                v-else
                :columns="diagnosticRefundAttemptColumns"
                :data-source="diagnosticRefundAttempts"
                :row-key="refundAttemptRowKey"
                :pagination="false"
                size="small"
              >
                <template #bodyCell="{ column, record }">
                  <template v-if="column.key === 'createdAt'">
                    {{ formatDateTime(record.createdAt) }}
                  </template>
                  <template
                    v-else-if="
                      [
                        'providerRefundStatus',
                        'providerRefundNo',
                        'errorCode',
                        'errorMessage',
                      ].includes(String(column.key))
                    "
                  >
                    {{ diagnosticValue(record, String(column.key)) }}
                  </template>
                  <template v-else-if="column.dataIndex">
                    {{ record[column.dataIndex] ?? "" }}
                  </template>
                </template>
              </a-table>
            </a-collapse-panel>
          </a-collapse>
        </template>

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
        <a-descriptions :column="2" bordered size="small">
          <a-descriptions-item label="履约投影">
            {{
              formatFulfillmentState(orderDetail.fulfillmentProjection.state)
            }}
          </a-descriptions-item>
          <a-descriptions-item label="最近命令">
            {{
              orderDetail.fulfillmentProjection.latestCommand?.commandNo ?? "-"
            }}
          </a-descriptions-item>
          <a-descriptions-item label="物理结果确认">
            {{
              orderDetail.fulfillmentProjection
                .requiresPhysicalOutcomeConfirmation
                ? "需要确认"
                : "无需确认"
            }}
          </a-descriptions-item>
        </a-descriptions>
        <div
          v-if="canRecover && availableRecoveryActions.length > 0"
          class="mt-3 space-y-2"
        >
          <textarea
            v-model="recoveryNote"
            class="w-full rounded border border-slate-300 px-3 py-2 text-sm"
            rows="3"
            placeholder="填写恢复动作备注"
          />
          <div class="flex flex-wrap gap-2">
            <button
              v-if="availableRecoveryActions.includes('confirm_dispensed')"
              type="button"
              :disabled="!canSubmitRecovery || recoveryLoading"
              @click="submitRecoveryAction('confirm_dispensed')"
            >
              确认已出
            </button>
            <button
              v-if="availableRecoveryActions.includes('confirm_not_dispensed')"
              type="button"
              :disabled="!canSubmitRecovery || recoveryLoading"
              @click="submitRecoveryAction('confirm_not_dispensed')"
            >
              确认未出
            </button>
            <button
              v-if="availableRecoveryActions.includes('request_refund')"
              type="button"
              :disabled="!canSubmitRecovery || recoveryLoading"
              @click="submitRecoveryAction('request_refund')"
            >
              申请退款
            </button>
            <button
              v-if="availableRecoveryActions.includes('compensation_dispense')"
              type="button"
              :disabled="!canSubmitRecovery || recoveryLoading"
              @click="submitRecoveryAction('compensation_dispense')"
            >
              补偿出货
            </button>
          </div>
        </div>
        <a-empty
          v-if="orderDetail.vendingCommands.length === 0"
          description="暂无出货命令"
        />
        <a-table
          v-else
          :columns="vendingCommandColumns"
          :data-source="orderDetail.vendingCommands"
          row-key="id"
          :pagination="false"
          size="small"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'status'">
              {{ formatVendingCommandStatus(record.status) }}
            </template>
            <template v-else-if="column.dataIndex">
              {{ record[column.dataIndex] ?? "" }}
            </template>
          </template>
        </a-table>

        <template v-if="canReadInventory">
          <a-divider>库存流水</a-divider>
          <a-empty
            v-if="orderDetail.inventoryMovements.length === 0"
            description="暂无库存流水"
          />
          <a-table
            v-else
            :columns="inventoryMovementColumns"
            :data-source="orderDetail.inventoryMovements"
            row-key="id"
            :pagination="false"
            size="small"
          />

          <a-divider>库存对账链接</a-divider>
          <a-empty
            v-if="orderDetail.stockReconciliationLinks.length === 0"
            description="暂无库存对账链接"
          />
          <a-table
            v-else
            :columns="stockReconciliationColumns"
            :data-source="orderDetail.stockReconciliationLinks"
            row-key="id"
            :pagination="false"
            size="small"
          />
        </template>

        <template v-if="canReadMaintenance">
          <a-divider>维修工单</a-divider>
          <a-empty
            v-if="orderDetail.maintenanceWorkOrders.length === 0"
            description="暂无维修工单"
          />
          <a-table
            v-else
            :columns="workOrderColumns"
            :data-source="orderDetail.maintenanceWorkOrders"
            row-key="id"
            :pagination="false"
            size="small"
          />
        </template>

        <template v-if="canReadAudit">
          <a-divider>审计记录</a-divider>
          <a-empty
            v-if="orderDetail.adminAuditEntries.length === 0"
            description="暂无审计记录"
          />
          <a-table
            v-else
            :columns="auditColumns"
            :data-source="orderDetail.adminAuditEntries"
            row-key="id"
            :pagination="false"
            size="small"
          />
        </template>
      </template>
      <a-empty v-else-if="errorMessage" :description="errorMessage" />
    </a-spin>
  </a-drawer>
</template>
