<script setup lang="ts">
import type { MaintenanceAccessOverviewResponse } from "@vem/shared";

import { computed, onMounted, reactive, ref } from "vue";

import {
  createMaintenanceSession,
  getMaintenanceAccessOverview,
} from "@/api/maintenance-access";
import { useAuthStore } from "@/stores/auth";
import { formatDateTime } from "@/utils/format";

const authStore = useAuthStore();
const canWrite = computed(() =>
  authStore.hasPermission("maintenanceAccess.write"),
);
const loading = ref(false);
const submitting = ref(false);
const overview = ref<MaintenanceAccessOverviewResponse | null>(null);
const form = reactive({
  sourcePeerId: undefined as string | undefined,
  targetMachineId: undefined as string | undefined,
  reason: "",
  ttlMinutes: 30 as 30 | 60 | 120 | 180,
});

const ttlOptions = [30, 60, 120, 180] as const;
const sessionColumns = [
  { title: "来源", key: "source" },
  { title: "目标机器", key: "target" },
  { title: "协议", key: "protocol" },
  { title: "原因", dataIndex: "reason", key: "reason" },
  { title: "到期时间", dataIndex: "expiresAt", key: "expiresAt" },
  { title: "状态", dataIndex: "status", key: "status" },
];
const desiredPeerColumns = [
  { title: "角色", dataIndex: "role", key: "role" },
  { title: "隧道地址", dataIndex: "tunnelAddress", key: "tunnelAddress" },
];
const desiredAuthorizationColumns = [
  { title: "来源地址", dataIndex: "source", key: "source" },
  { title: "目标地址", dataIndex: "target", key: "target" },
  { title: "协议", dataIndex: "protocol", key: "protocol" },
  { title: "到期时间", dataIndex: "expiresAt", key: "expiresAt" },
];
const desiredPeers = computed(() =>
  (overview.value?.desiredState.peers ?? []).map((peer) => ({
    id: peer.id,
    role: peer.role,
    tunnelAddress: peer.tunnelAddress,
  })),
);
const desiredAuthorizations = computed(() =>
  (overview.value?.desiredState.authorizations ?? []).map((authorization) => ({
    id: authorization.sessionId,
    source: authorization.sourceTunnelAddress,
    target: authorization.targetTunnelAddress,
    protocol: `${authorization.protocol.toUpperCase()}/${authorization.port}`,
    expiresAt: formatDateTime(authorization.expiresAt),
  })),
);
const relayOverallHealthLabel = computed(() => {
  const overall = overview.value?.relayHealth.overall;
  if (overall === "healthy") return "健康";
  if (overall === "degraded") return "降级";
  return "未知";
});
const relayObservationStatusLabel = computed(() => {
  const observation = overview.value?.relayHealth.observation;
  if (observation === "current") return "当前";
  if (observation === "stale") return "已过期";
  return "未上报";
});
const relayTransportModeLabel = computed(() => {
  const mode = overview.value?.observedState.transport.mode;
  if (mode === "https") return "HTTPS";
  if (mode === "insecure-http") return "Insecure HTTP";
  return "未知";
});
const relayTransportHealthLabel = computed(() => {
  const health = overview.value?.observedState.transport.health;
  if (health === "healthy") return "Healthy";
  if (health === "degraded") return "Degraded";
  return "Unreported";
});

async function load(): Promise<void> {
  loading.value = true;
  try {
    overview.value = await getMaintenanceAccessOverview();
    form.sourcePeerId ??= overview.value.sourcePeers[0]?.id;
    form.targetMachineId ??= overview.value.targetMachines[0]?.id;
  } finally {
    loading.value = false;
  }
}

async function submit(): Promise<void> {
  if (!form.sourcePeerId || !form.targetMachineId || !form.reason.trim())
    return;
  submitting.value = true;
  try {
    await createMaintenanceSession({
      sourcePeerId: form.sourcePeerId,
      targetMachineId: form.targetMachineId,
      reason: form.reason,
      ttlMinutes: form.ttlMinutes,
    });
    form.reason = "";
    await load();
  } finally {
    submitting.value = false;
  }
}

onMounted(() => {
  void load();
});
</script>

<template>
  <a-space direction="vertical" size="large" class="w-full">
    <a-card title="维护访问">
      <a-form layout="vertical">
        <a-row :gutter="16">
          <a-col :xs="24" :md="8">
            <a-form-item label="来源 Runner">
              <a-select
                v-model:value="form.sourcePeerId"
                :disabled="!canWrite"
                :loading="loading"
              >
                <a-select-option
                  v-for="peer in overview?.sourcePeers ?? []"
                  :key="peer.id"
                  :value="peer.id"
                >
                  {{ peer.tunnelAddress }}
                </a-select-option>
              </a-select>
            </a-form-item>
          </a-col>
          <a-col :xs="24" :md="8">
            <a-form-item label="目标机器">
              <a-select
                v-model:value="form.targetMachineId"
                :disabled="!canWrite"
                :loading="loading"
              >
                <a-select-option
                  v-for="machine in overview?.targetMachines ?? []"
                  :key="machine.id"
                  :value="machine.id"
                >
                  {{ machine.code }} · {{ machine.name }}
                </a-select-option>
              </a-select>
            </a-form-item>
          </a-col>
          <a-col :xs="24" :md="8">
            <a-form-item label="有效期">
              <a-select v-model:value="form.ttlMinutes" :disabled="!canWrite">
                <a-select-option
                  v-for="minutes in ttlOptions"
                  :key="minutes"
                  :value="minutes"
                >
                  {{ minutes }} 分钟
                </a-select-option>
              </a-select>
            </a-form-item>
          </a-col>
        </a-row>
        <a-form-item label="维护原因">
          <a-textarea
            v-model:value="form.reason"
            :disabled="!canWrite"
            :maxlength="500"
            :rows="2"
          />
        </a-form-item>
        <a-button
          type="primary"
          :disabled="!canWrite"
          :loading="submitting"
          @click="submit"
        >
          创建会话
        </a-button>
      </a-form>
    </a-card>

    <a-card title="活动会话">
      <a-table
        :columns="sessionColumns"
        :data-source="overview?.sessions ?? []"
        :loading="loading"
        row-key="id"
        :pagination="false"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'source'">
            {{ record.sourcePeer.tunnelAddress }}
          </template>
          <template v-else-if="column.key === 'target'">
            {{ record.targetMachine.code }} · {{ record.targetMachine.name }}
          </template>
          <template v-else-if="column.key === 'protocol'">
            {{ record.protocol.toUpperCase() }}/{{ record.port }}
          </template>
          <template v-else-if="column.key === 'expiresAt'">
            {{ formatDateTime(record.expiresAt) }}
          </template>
          <template v-else-if="column.key === 'status'">
            <a-tag color="success">活动</a-tag>
          </template>
        </template>
      </a-table>
    </a-card>

    <a-card title="Relay 状态投影">
      <a-row :gutter="24">
        <a-col :xs="24" :xl="12">
          <section data-testid="desired-state-projection">
            <h3>期望状态</h3>
            <dl>
              <dt>版本</dt>
              <dd>{{ overview?.desiredState.desiredStateVersion ?? 0 }}</dd>
              <dt>生成时间</dt>
              <dd>
                {{
                  overview
                    ? formatDateTime(overview.desiredState.generatedAt)
                    : "-"
                }}
              </dd>
              <dt>Peer 数量</dt>
              <dd>{{ desiredPeers.length }}</dd>
              <dt>授权数量</dt>
              <dd>{{ desiredAuthorizations.length }}</dd>
            </dl>
            <a-table
              :columns="desiredPeerColumns"
              :data-source="desiredPeers"
              row-key="id"
              :pagination="false"
              size="small"
            />
            <a-table
              :columns="desiredAuthorizationColumns"
              :data-source="desiredAuthorizations"
              row-key="id"
              :pagination="false"
              size="small"
            />
          </section>
        </a-col>
        <a-col :xs="24" :xl="12">
          <section data-testid="observed-state-projection">
            <h3>已观测状态</h3>
            <dl>
              <dt>总体健康</dt>
              <dd data-testid="relay-overall-health">
                {{ relayOverallHealthLabel }}
              </dd>
              <dt>观测状态</dt>
              <dd data-testid="relay-observation-status">
                {{ relayObservationStatusLabel }}
              </dd>
              <dt>已应用版本</dt>
              <dd>
                {{ overview?.observedState.appliedDesiredStateVersion ?? 0 }}
              </dd>
              <dt>观测时间</dt>
              <dd data-testid="relay-observed-at">
                {{
                  overview?.relayHealth.observedAt
                    ? formatDateTime(overview.relayHealth.observedAt)
                    : "-"
                }}
              </dd>
              <dt>数据过期</dt>
              <dd data-testid="relay-stale">
                {{ overview?.relayHealth.stale ? "是" : "否" }}
              </dd>
              <dt>已应用 Peer</dt>
              <dd>{{ overview?.observedState.appliedPeerIds.length ?? 0 }}</dd>
              <dt>已应用授权</dt>
              <dd>
                {{
                  overview?.observedState.appliedAuthorizationIds.length ?? 0
                }}
              </dd>
              <dt>传输模式</dt>
              <dd>{{ relayTransportModeLabel }}</dd>
              <dt>传输健康</dt>
              <dd>{{ relayTransportHealthLabel }}</dd>
              <dt>传输原因</dt>
              <dd>{{ overview?.observedState.transport.reason ?? "-" }}</dd>
              <dt>失败信息</dt>
              <dd data-testid="relay-failure">
                {{ overview?.observedState.failure ?? "-" }}
              </dd>
            </dl>
          </section>
        </a-col>
      </a-row>
    </a-card>
  </a-space>
</template>
