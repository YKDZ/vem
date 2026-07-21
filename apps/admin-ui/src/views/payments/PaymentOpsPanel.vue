<script setup lang="ts">
import type { PaymentOpsCheck } from "@vem/shared";

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
const readinessRows = computed(() =>
  readiness.value ? readiness.value.checks.map(toDisplayCheck) : [],
);
const preflightRows = computed(() =>
  preflight.value ? preflight.value.checks.map(toDisplayCheck) : [],
);
const readyPaymentOptionsText = computed(() => {
  if (!preflight.value) return "";
  const names = preflight.value.availableProviders.map((item) =>
    item.displayName.trim(),
  );
  return names.length > 0 ? names.join("、") : "无";
});
const readinessEnvironmentLabel = computed(() =>
  readiness.value ? environmentLabel(readiness.value.environment) : "",
);

const checkColumns = [
  { title: "检查项", dataIndex: "checkName", key: "checkName" },
  { title: "级别", dataIndex: "severityLabel", key: "severity" },
  { title: "结果", dataIndex: "resultLabel", key: "passed" },
  { title: "说明", dataIndex: "displayMessage", key: "displayMessage" },
];

type DisplayCheck = PaymentOpsCheck & {
  checkName: string;
  severityLabel: string;
  resultLabel: string;
  displayMessage: string;
};

function toDisplayCheck(check: PaymentOpsCheck): DisplayCheck {
  return {
    ...check,
    checkName: checkName(check.code),
    severityLabel: severityLabel(check.severity),
    resultLabel: check.passed ? "通过" : "阻塞",
    displayMessage: checkMessage(check),
  };
}

function severityLabel(severity: PaymentOpsCheck["severity"]): string {
  if (severity === "critical") return "阻塞项";
  if (severity === "warning") return "提醒";
  return "信息";
}

function checkName(code: string): string {
  if (code === "mock_provider_disabled") return "模拟支付";
  if (code === "enabled_payment_channels_present") return "支付渠道";
  if (code === "enabled_channel_provider_setup") return "支付机构配置";
  if (code === "real_provider_config_present") return "真实支付配置";
  if (code === "provider_environment.production_ready") return "支付环境";
  if (code === "machine_real_provider_options_available") {
    return "机器支付选项";
  }
  if (code === "notify_url_static_check") return "回调地址";
  if (code === "payment_certificate_not_expiring") return "证书有效期";
  if (code === "recent_payment_failures") return "支付失败";
  if (code === "recent_webhook_failures") return "回调验签";
  if (code === "recent_reconciliation_failures") return "支付对账";
  if (code === "refund_backlog_clear") return "退款处理";
  if (code === "machine_online") return "机器在线";
  if (code === "machine_real_provider_available") return "真实支付选项";
  if (code === "machine_heartbeat.fresh") return "机器心跳";
  if (code.startsWith("production_dispense_path.")) return "生产出货路径";
  if (code.startsWith("payment_code.scanner")) return "付款码扫码模块";
  if (code === "machine_not_found") return "机器记录";
  return "支付检查";
}

function environmentLabel(
  environment: PaymentOpsReadiness["environment"],
): string {
  if (environment === "production") return "生产环境";
  if (environment === "test") return "测试环境";
  return "开发环境";
}

function providerLabel(providerCode: string): string {
  if (providerCode === "wechat_pay") return "微信";
  if (providerCode === "alipay") return "支付宝";
  return "支付";
}

function methodLabel(method: string): string {
  if (method === "payment_code") return "付款码";
  if (method === "qr_code") return "扫码";
  return "";
}

function missingProviderSetupLabel(keys: unknown): string {
  if (!Array.isArray(keys) || keys.length === 0) return "支付机构配置/证书";
  const values = keys.filter((key): key is string => typeof key === "string");
  if (values.includes("providerConfig")) return "支付机构配置/证书";
  if (
    values.some((key) => /cert|certificate|key|pem|secret|sensitive/i.test(key))
  ) {
    return "支付机构配置/证书";
  }
  return "支付机构配置";
}

function channelProviderSetupMessage(check: PaymentOpsCheck): string {
  if (check.passed) return "已启用支付渠道的支付机构配置可用";
  const blockedChannels = check.evidence["blockedChannels"];
  if (!Array.isArray(blockedChannels) || blockedChannels.length === 0) {
    return check.message;
  }
  return blockedChannels
    .map((channel) => {
      if (typeof channel !== "object" || channel === null) {
        return "已启用支付渠道存在支付机构配置阻塞";
      }
      const providerCode = Reflect.get(channel, "providerCode");
      const method = Reflect.get(channel, "method");
      const channelKey = Reflect.get(channel, "channelKey");
      const [methodFromKey, providerFromKey] =
        typeof channelKey === "string" ? channelKey.split(":") : ["", ""];
      const normalizedProvider =
        typeof providerCode === "string" ? providerCode : providerFromKey;
      const normalizedMethod =
        typeof method === "string" ? method : methodFromKey;
      return `${providerLabel(normalizedProvider)}${methodLabel(
        normalizedMethod,
      )}缺少${missingProviderSetupLabel(
        Reflect.get(channel, "missingCredentialKeys"),
      )}`;
    })
    .join("；");
}

function checkMessage(check: PaymentOpsCheck): string {
  if (check.code === "mock_provider_disabled") {
    return check.passed ? "模拟支付已关闭" : "模拟支付仍处于启用状态";
  }
  if (check.code === "enabled_payment_channels_present") {
    return check.passed
      ? "已启用支付渠道可用于上线评估"
      : "没有启用任何支付渠道";
  }
  if (check.code === "enabled_channel_provider_setup") {
    return channelProviderSetupMessage(check);
  }
  if (check.code === "real_provider_config_present") {
    return check.passed
      ? "至少有一个真实支付机构配置可用"
      : "没有可用的真实支付机构配置";
  }
  if (check.code === "provider_environment.production_ready") {
    return check.message;
  }
  if (check.code === "notify_url_static_check") {
    return check.passed
      ? "回调地址符合当前环境要求"
      : "回调地址不符合当前环境要求";
  }
  if (check.code === "payment_certificate_not_expiring") {
    return check.passed
      ? "支付证书未临近过期"
      : "存在已过期或即将过期的支付证书";
  }
  if (check.code === "recent_payment_failures") {
    return check.passed ? "近期没有支付失败" : "近期存在支付失败";
  }
  if (check.code === "recent_webhook_failures") {
    return check.passed ? "近期没有回调验签失败" : "近期存在回调验签失败";
  }
  if (check.code === "recent_reconciliation_failures") {
    return check.passed ? "近期没有支付对账失败" : "近期存在支付对账失败";
  }
  if (check.code === "refund_backlog_clear") {
    return check.passed ? "没有异常退款积压" : "存在需要处理的退款积压";
  }
  if (check.code === "machine_online") {
    return check.passed ? "机器在线" : "机器未在线";
  }
  if (check.code === "machine_real_provider_available") {
    return check.passed ? "机器有可用真实支付选项" : "机器没有可用真实支付选项";
  }
  if (check.code === "machine_heartbeat.fresh") {
    return check.passed ? "机器心跳新鲜" : "机器心跳缺失或超时";
  }
  if (check.code === "production_dispense_path.mock") {
    return "生产出货路径正在使用模拟硬件，不能上线";
  }
  if (check.code === "production_dispense_path.tcp_simulator") {
    return "生产出货路径正在使用下位机模拟连接，不能上线";
  }
  if (check.code === "production_dispense_path.evidence_missing") {
    return "生产出货路径缺少硬件心跳证据";
  }
  if (check.code === "production_dispense_path.ready") {
    return "生产出货路径证据可用";
  }
  if (check.code === "payment_code.scanner_runtime.ready") {
    return "付款码扫码模块健康证据已上报";
  }
  if (
    check.code === "payment_code.scanner_runtime.degraded" ||
    check.code === "payment_code.scanner_health_not_reported"
  ) {
    return check.message;
  }
  if (check.code === "machine_not_found") return "找不到所选机器";
  return check.message;
}

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
        readiness.status === 'ready'
          ? '支付运营诊断正常'
          : '支付运营诊断存在异常'
      "
      :description="`环境：${readinessEnvironmentLabel}，检查时间：${formatDateTime(readiness.checkedAt)}`"
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
          title="回调验签失败"
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
      :data-source="readinessRows"
      :loading="loading"
      :columns="checkColumns"
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
            {{ record.severityLabel }}
          </a-tag>
        </template>
      </template>
    </a-table>

    <a-card title="机器支付预检" size="small">
      <a-space>
        <a-select
          v-model:value="selectedMachineId"
          style="width: 320px"
          placeholder="选择机器"
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
          preflight.status === 'ready' ? '机器支付预检通过' : '机器支付预检阻塞'
        "
        :description="`机器：${preflight.machineCode}，可用支付方式：${readyPaymentOptionsText}`"
      />
      <a-table
        v-if="preflight"
        class="mt-4"
        row-key="code"
        :pagination="false"
        :data-source="preflightRows"
        :columns="checkColumns"
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
              {{ record.severityLabel }}
            </a-tag>
          </template>
        </template>
      </a-table>
    </a-card>
  </a-space>
</template>
