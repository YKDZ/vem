<script setup lang="ts">
import { computed, ref } from "vue";

import { getOrderInvestigation, type OrderInvestigation } from "@/api/orders";
import { useAuthStore } from "@/stores/auth";
import { formatCents, formatDateTime } from "@/utils/format";

const authStore = useAuthStore();
const open = ref(false);
const loading = ref(false);
const orderDetail = ref<OrderInvestigation | null>(null);
const errorMessage = ref<string | null>(null);

const canReadPayments = computed(() =>
  authStore.hasPermission("payments.read"),
);
const canReadInventory = computed(() =>
  authStore.hasPermission("inventory.read"),
);
const canReadMaintenance = computed(() =>
  authStore.hasPermission("maintenanceWorkOrders.read"),
);
const canReadAudit = computed(() => authStore.hasPermission("audit.read"));

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
  {
    title: "付款尝试号",
    dataIndex: "providerPaymentNo",
    key: "providerPaymentNo",
  },
  { title: "渠道交易号", dataIndex: "providerTradeNo", key: "providerTradeNo" },
  { title: "渠道状态", dataIndex: "providerStatus", key: "providerStatus" },
  { title: "错误码", dataIndex: "failureCode", key: "failureCode" },
  { title: "失败消息", dataIndex: "failureMessage", key: "failureMessage" },
  { title: "处理原因", dataIndex: "manualReason", key: "manualReason" },
  { title: "查询时间", dataIndex: "lastCheckedAt", key: "lastCheckedAt" },
  { title: "撤销时间", dataIndex: "reversedAt", key: "reversedAt" },
  { title: "来源", dataIndex: "source", key: "source" },
];

const vendingCommandColumns = [
  { title: "命令号", dataIndex: "commandNo", key: "commandNo" },
  { title: "状态", dataIndex: "status", key: "status" },
  { title: "机器", dataIndex: "machineCode", key: "machineCode" },
  { title: "货道", dataIndex: "slotCode", key: "slotCode" },
  { title: "错误", dataIndex: "lastError", key: "lastError" },
];

function formatVendingCommandStatus(status: unknown): string {
  if (status === "result_unknown") return "待物理结果确认";
  return typeof status === "string" ? status : "-";
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

async function show(orderId: string): Promise<void> {
  open.value = true;
  loading.value = true;
  orderDetail.value = null;
  errorMessage.value = null;
  try {
    orderDetail.value = await getOrderInvestigation(orderId);
  } catch (error) {
    errorMessage.value =
      error instanceof Error && error.message.trim()
        ? error.message
        : "订单调查加载失败";
  } finally {
    loading.value = false;
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
              <template v-else-if="column.key === 'paidAt'">
                {{ formatDateTime(record.paidAt) }}
              </template>
            </template>
          </a-table>

          <a-divider>Webhook尝试</a-divider>
          <a-empty
            v-if="orderDetail.paymentWebhookAttempts.length === 0"
            description="暂无Webhook尝试"
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
          />

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
            </template>
          </a-table>
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
            {{ orderDetail.fulfillmentProjection.state }}
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
