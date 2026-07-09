<script setup lang="ts">
import type { PaymentChannelKey } from "@vem/shared";

import { computed, onMounted, ref } from "vue";

import {
  getPaymentChannelPolicy,
  updatePaymentChannelPolicy,
} from "@/api/payments";
import { useAuthStore } from "@/stores/auth";

import {
  buildPaymentChannelPolicyPayload,
  createPaymentChannelPolicyForm,
  movePaymentChannelPolicyRow,
  type PaymentChannelPolicyForm,
} from "./payment-channel-policy-model";

const authStore = useAuthStore();
const canConfigure = computed(() =>
  authStore.hasPermission("payments.configure"),
);
const loading = ref(false);
const saving = ref(false);
const form = ref<PaymentChannelPolicyForm | null>(null);
const errorMessage = ref("");

const columns = [
  { title: "渠道", dataIndex: "label", key: "label" },
  { title: "启用", key: "enabled" },
  { title: "顺序", key: "rank" },
  { title: "默认", key: "default" },
];

async function loadPolicy(): Promise<void> {
  loading.value = true;
  errorMessage.value = "";
  try {
    const policy = await getPaymentChannelPolicy();
    form.value = createPaymentChannelPolicyForm(policy);
  } finally {
    loading.value = false;
  }
}

async function savePolicy(): Promise<void> {
  if (!form.value || !canConfigure.value) return;
  saving.value = true;
  errorMessage.value = "";
  try {
    const policy = await updatePaymentChannelPolicy(
      buildPaymentChannelPolicyPayload(form.value),
    );
    form.value = createPaymentChannelPolicyForm(policy);
  } catch {
    errorMessage.value = "保存失败，请检查支付渠道顺序和默认选项";
  } finally {
    saving.value = false;
  }
}

function moveRow(
  channelKey: PaymentChannelKey,
  direction: "up" | "down",
): void {
  if (!form.value || !canConfigure.value) return;
  movePaymentChannelPolicyRow(form.value, channelKey, direction);
}

onMounted(() => {
  void loadPolicy();
});
</script>

<template>
  <section class="space-y-4">
    <div class="flex items-center justify-between gap-3">
      <div>
        <h2 class="text-base font-semibold text-slate-900">支付渠道管理</h2>
        <p class="mt-1 text-sm text-slate-500">
          全局控制客户可选支付渠道、展示顺序和默认选项
        </p>
      </div>
      <a-space>
        <a-button :loading="loading" @click="loadPolicy">刷新</a-button>
        <a-button
          v-if="canConfigure"
          type="primary"
          :loading="saving"
          :disabled="!form"
          @click="savePolicy"
        >
          保存
        </a-button>
      </a-space>
    </div>

    <a-alert
      v-if="!canConfigure"
      type="info"
      message="当前为只读模式，需要支付配置权限才能调整渠道"
      show-icon
    />
    <a-alert
      v-if="errorMessage"
      type="error"
      :message="errorMessage"
      show-icon
    />

    <a-table
      v-if="form"
      :columns="columns"
      :data-source="form.rows"
      row-key="channelKey"
      :loading="loading"
      :pagination="false"
      size="middle"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'label'">
          {{ record.label }}
        </template>
        <template v-else-if="column.key === 'enabled'">
          <a-switch
            v-model:checked="record.enabled"
            :disabled="!canConfigure"
          />
        </template>
        <template v-else-if="column.key === 'rank'">
          <a-space>
            <span class="text-slate-500">{{ record.rank }}</span>
            <a-button
              size="small"
              :disabled="!canConfigure || record.rank === 1"
              @click="moveRow(record.channelKey, 'up')"
            >
              上移
            </a-button>
            <a-button
              size="small"
              :disabled="!canConfigure || record.rank === form.rows.length"
              @click="moveRow(record.channelKey, 'down')"
            >
              下移
            </a-button>
          </a-space>
        </template>
        <template v-else-if="column.key === 'default'">
          <input
            v-model="form.defaultChannelKey"
            type="radio"
            name="payment-default-channel"
            :value="record.channelKey"
            :disabled="!canConfigure"
          />
        </template>
      </template>
    </a-table>

    <a-alert v-else type="info" message="正在加载支付渠道" show-icon />
  </section>
</template>
