<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

import { listMachines, type Machine } from "@/api/machines";
import {
  getPaymentMachinePreflight,
  getPaymentOpsMetrics,
  getPaymentOpsReadiness,
  type PaymentMachinePreflight,
  type PaymentOpsMetrics,
  type PaymentOpsReadiness,
} from "@/api/payments";
import { formatDateTime } from "@/utils/format";

const loading = ref(false);
const readiness = ref<PaymentOpsReadiness | null>(null);
const metrics = ref<PaymentOpsMetrics | null>(null);
const machines = ref<Machine[]>([]);
const selectedMachineId = ref<string | null>(null);
const preflight = ref<PaymentMachinePreflight | null>(null);

const readinessColor = computed(() =>
  readiness.value?.status === "ready" ? "success" : "error",
);

async function load(): Promise<void> {
  loading.value = true;
  try {
    const [readinessRow, metricsRow, machineRows] = await Promise.all([
      getPaymentOpsReadiness(),
      getPaymentOpsMetrics(60),
      listMachines({ page: 1, pageSize: 100 }),
    ]);
    readiness.value = readinessRow;
    metrics.value = metricsRow;
    machines.value = machineRows.items;
  } finally {
    loading.value = false;
  }
}

async function runMachinePreflight(): Promise<void> {
  if (!selectedMachineId.value) return;
  preflight.value = await getPaymentMachinePreflight(selectedMachineId.value);
}

onMounted(() => {
  void load();
});
</script>

<template>
  <a-space direction="vertical" class="w-full" :size="16">
    <a-alert
      v-if="readiness"
      :type="readinessColor"
      show-icon
      :message="
        readiness.status === 'ready' ? '支付上线门禁通过' : '支付上线门禁阻塞'
      "
      :description="`环境：${readiness.environment}，检查时间：${formatDateTime(readiness.checkedAt)}`"
    />

    <a-row v-if="metrics" :gutter="16">
      <a-col :span="6">
        <a-statistic
          title="支付失败率"
          :value="metrics.paymentFailureRate * 100"
          suffix="%"
          :precision="2"
        />
      </a-col>
      <a-col :span="6">
        <a-statistic
          title="Webhook 验签失败"
          :value="metrics.webhookSignatureInvalidCount"
        />
      </a-col>
      <a-col :span="6">
        <a-statistic
          title="对账失败"
          :value="metrics.reconciliationErrorCount"
        />
      </a-col>
      <a-col :span="6">
        <a-statistic
          title="退款异常"
          :value="
            metrics.refundFailedCount + metrics.refundProcessingOverdueCount
          "
        />
      </a-col>
      <a-col :span="6">
        <a-statistic
          title="付款码未知结果"
          :value="metrics.paymentCodeUnknownCount"
        />
      </a-col>
      <a-col :span="6">
        <a-statistic
          title="付款码撤销失败"
          :value="metrics.paymentCodeReverseFailedCount"
        />
      </a-col>
      <a-col :span="6">
        <a-statistic
          title="重复扫码拒绝"
          :value="metrics.paymentCodeDuplicateRejectedCount"
        />
      </a-col>
      <a-col :span="6">
        <a-statistic
          title="扫码模块离线机器"
          :value="metrics.scannerOfflineMachineCount"
        />
      </a-col>
    </a-row>

    <a-table
      v-if="readiness"
      row-key="code"
      :pagination="false"
      :data-source="readiness.checks"
      :loading="loading"
      :columns="[
        { title: '检查项', dataIndex: 'code', key: 'code' },
        { title: '级别', dataIndex: 'severity', key: 'severity' },
        { title: '结果', dataIndex: 'passed', key: 'passed' },
        { title: '说明', dataIndex: 'message', key: 'message' },
      ]"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'passed'">
          <a-tag :color="record.passed ? 'success' : 'error'">
            {{ record.passed ? "通过" : "阻塞" }}
          </a-tag>
        </template>
        <template v-else-if="column.key === 'severity'">
          <a-tag
            :color="
              record.severity === 'critical'
                ? 'error'
                : record.severity === 'warning'
                  ? 'warning'
                  : 'default'
            "
          >
            {{ record.severity }}
          </a-tag>
        </template>
      </template>
    </a-table>

    <a-card title="灰度机器预检" size="small">
      <a-space>
        <a-select
          v-model:value="selectedMachineId"
          style="width: 320px"
          placeholder="选择灰度机器"
        >
          <a-select-option
            v-for="machine in machines"
            :key="machine.id"
            :value="machine.id"
          >
            {{ machine.code }} - {{ machine.name }}
          </a-select-option>
        </a-select>
        <a-button type="primary" @click="runMachinePreflight"
          >执行预检</a-button
        >
      </a-space>

      <a-alert
        v-if="preflight"
        class="mt-4"
        :type="preflight.status === 'ready' ? 'success' : 'error'"
        show-icon
        :message="
          preflight.status === 'ready'
            ? '灰度机器可启用真实支付'
            : '灰度机器预检阻塞'
        "
        :description="`机器：${preflight.machineCode}，可用渠道：${preflight.availableProviders.map((item) => `${item.method}/${item.providerCode}`).join(', ') || '无'}`"
      />
      <a-table
        v-if="preflight"
        class="mt-4"
        row-key="code"
        :pagination="false"
        :data-source="preflight.checks"
        :columns="[
          { title: '检查项', dataIndex: 'code', key: 'code' },
          { title: '级别', dataIndex: 'severity', key: 'severity' },
          { title: '结果', dataIndex: 'passed', key: 'passed' },
          { title: '说明', dataIndex: 'message', key: 'message' },
        ]"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'passed'">
            <a-tag :color="record.passed ? 'success' : 'error'">
              {{ record.passed ? "通过" : "阻塞" }}
            </a-tag>
          </template>
          <template v-else-if="column.key === 'severity'">
            <a-tag
              :color="
                record.severity === 'critical'
                  ? 'error'
                  : record.severity === 'warning'
                    ? 'warning'
                    : 'default'
              "
            >
              {{ record.severity }}
            </a-tag>
          </template>
        </template>
      </a-table>
    </a-card>
  </a-space>
</template>
