<script setup lang="ts">
import type {
  AuditLogResponse,
  MaintenanceAccessOverviewResponse,
  MaintenanceSessionStatus,
} from "@vem/shared";

import { computed, onMounted, reactive, ref, watch } from "vue";

import {
  createMaintenanceSession,
  getMaintenanceAudit,
  getMaintenanceAccessOverview,
  getMaintenanceSessions,
  revokeMaintenanceSession,
} from "@/api/maintenance-access";
import { useAuthStore } from "@/stores/auth";
import { formatDateTime } from "@/utils/format";

const authStore = useAuthStore();
const canWrite = computed(() =>
  authStore.hasPermission("maintenanceAccess.write"),
);
const loading = ref(false);
const submitting = ref(false);
const revokingSessionId = ref<string>();
const overview = ref<MaintenanceAccessOverviewResponse | null>(null);
const sessions = ref<MaintenanceAccessOverviewResponse["sessions"]>([]);
const auditEntries = ref<AuditLogResponse[]>([]);
const sessionFilter = ref<MaintenanceSessionStatus | undefined>();
const form = reactive({
  sourcePeerId: undefined as string | undefined,
  targetMachineId: undefined as string | undefined,
  reason: "",
  ttlMinutes: 30 as 30 | 60 | 120 | 180,
});

const ttlOptions = [30, 60, 120, 180] as const;
const sessionFilterOptions: {
  label: string;
  value: MaintenanceSessionStatus;
}[] = [
  { label: "活动", value: "active" },
  { label: "已到期", value: "expired" },
  { label: "失败", value: "failed" },
  { label: "已撤销", value: "revoked" },
];
const sessionColumns = [
  { title: "来源维护者", key: "source" },
  { title: "目标机器", key: "target" },
  { title: "协议", key: "protocol" },
  { title: "原因", dataIndex: "reason", key: "reason" },
  { title: "到期时间", dataIndex: "expiresAt", key: "expiresAt" },
  { title: "状态", dataIndex: "status", key: "status" },
  { title: "中继同步", key: "relay" },
  { title: "操作", key: "actions" },
];
const peerHealthColumns = [
  { title: "角色", dataIndex: "role", key: "role" },
  { title: "隧道地址", dataIndex: "tunnelAddress", key: "tunnelAddress" },
  { title: "中继状态", dataIndex: "relayApplied", key: "relayApplied" },
  { title: "最近握手", dataIndex: "lastHandshakeAt", key: "lastHandshakeAt" },
  { title: "健康", dataIndex: "health", key: "health" },
];
const auditColumns = [
  { title: "时间", dataIndex: "createdAt", key: "createdAt" },
  { title: "操作人", dataIndex: "adminUserId", key: "adminUserId" },
  { title: "动作", dataIndex: "action", key: "action" },
  { title: "资源", dataIndex: "resourceId", key: "resourceId" },
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
const peerHealth = computed(() =>
  (overview.value?.peerHealth ?? []).map((entry) => ({
    id: entry.peer.id,
    role: entry.peer.role,
    tunnelAddress: entry.peer.tunnelAddress,
    relayApplied: entry.relayApplied ? "已应用" : "等待应用",
    lastHandshakeAt: entry.lastHandshakeAt
      ? formatDateTime(entry.lastHandshakeAt)
      : "-",
    health:
      entry.health === "healthy"
        ? "健康"
        : entry.health === "stale"
          ? "已过期"
          : "未知",
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
  if (mode === "insecure-http") return "非加密 HTTP";
  return "未知";
});
const relayTransportHealthLabel = computed(() => {
  const health = overview.value?.observedState.transport.health;
  if (health === "healthy") return "健康";
  if (health === "degraded") return "降级";
  return "未上报";
});

function localizeMaintenanceText(value: string | null | undefined): string {
  if (!value) return "-";
  if (
    value.toLowerCase() ===
    "relay could not apply the maintenance firewall policy."
  ) {
    return "中继服务无法应用维护防火墙策略。";
  }
  if (
    value.toLowerCase() === "service api uses explicitly allowed insecure http"
  ) {
    return "服务接口使用已明确允许的非加密 HTTP";
  }
  if (value.toLowerCase() === "relay transport has not been reported") {
    return "中继服务传输状态尚未上报";
  }
  if (value.toLowerCase() === "private test transport exception") {
    return "专用测试传输例外";
  }
  return value
    .replaceAll(/relay/gi, "中继服务")
    .replaceAll(/peers?/gi, "节点")
    .replaceAll(/transport/gi, "传输")
    .replaceAll(/firewall policy/gi, "防火墙策略")
    .replaceAll(/could not apply/gi, "无法应用")
    .replaceAll(/maintenance/gi, "维护")
    .replaceAll(/\bthe\b/gi, "")
    .replaceAll(/has not been reported/gi, "尚未上报")
    .replaceAll(/not reported/gi, "未上报");
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    overview.value = await getMaintenanceAccessOverview();
    form.sourcePeerId ??= overview.value.sourcePeers[0]?.id;
    form.targetMachineId ??= overview.value.targetMachines[0]?.id;
    await Promise.all([loadSessions(), loadAudit()]);
  } finally {
    loading.value = false;
  }
}

async function loadAudit(): Promise<void> {
  auditEntries.value = await getMaintenanceAudit({ limit: 50 });
}

async function loadSessions(): Promise<void> {
  sessions.value = await getMaintenanceSessions(
    sessionFilter.value ? { status: sessionFilter.value } : {},
  );
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

async function revoke(sessionId: string): Promise<void> {
  revokingSessionId.value = sessionId;
  try {
    await revokeMaintenanceSession(sessionId);
    await load();
  } finally {
    revokingSessionId.value = undefined;
  }
}

function sessionStatusLabel(status: MaintenanceSessionStatus): string {
  if (status === "active") return "活动";
  if (status === "expired") return "已到期";
  if (status === "failed") return "失败";
  return "已撤销";
}

function relayConvergenceLabel(state: string): string {
  if (state === "applied") return "已应用";
  if (state === "removed") return "已移除";
  if (state === "failed") return "失败";
  if (state === "pending") return "等待";
  return "未上报";
}

watch(sessionFilter, () => {
  void loadSessions();
});

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
            <a-form-item label="来源维护者">
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

    <a-card title="维护会话">
      <a-form layout="inline" class="mb-4">
        <a-form-item label="状态筛选">
          <a-select
            v-model:value="sessionFilter"
            allow-clear
            data-testid="session-status-filter"
            :options="sessionFilterOptions"
            placeholder="全部"
          />
        </a-form-item>
      </a-form>
      <a-table
        :columns="sessionColumns"
        :data-source="sessions"
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
            <a-tag
              :color="
                record.status === 'active'
                  ? 'success'
                  : record.status === 'failed'
                    ? 'error'
                    : 'default'
              "
            >
              {{ sessionStatusLabel(record.status) }}
            </a-tag>
          </template>
          <template v-else-if="column.key === 'relay'">
            {{ relayConvergenceLabel(record.relayConvergence.state) }}
            {{ record.relayConvergence.appliedDesiredStateVersion }}/{{
              record.relayConvergence.desiredStateVersion
            }}
          </template>
          <template v-else-if="column.key === 'actions'">
            <a-button
              v-if="canWrite && record.status === 'active'"
              type="link"
              danger
              :loading="revokingSessionId === record.id"
              @click="revoke(record.id)"
            >
              提前撤销
            </a-button>
          </template>
        </template>
      </a-table>
    </a-card>

    <a-card title="维护审计">
      <a-table
        :columns="auditColumns"
        :data-source="auditEntries"
        row-key="id"
        :pagination="false"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'createdAt'">
            {{ formatDateTime(record.createdAt) }}
          </template>
          <template v-else-if="column.key === 'adminUserId'">
            {{ record.adminUserId ?? "系统" }}
          </template>
          <template v-else-if="column.key === 'action'">
            {{ record.action }}
          </template>
          <template v-else-if="column.key === 'resourceId'">
            {{ record.resourceId ?? "-" }}
          </template>
        </template>
      </a-table>
    </a-card>

    <a-card title="中继服务状态">
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
              <dt>节点数量</dt>
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
            <h3>节点健康</h3>
            <a-table
              :columns="peerHealthColumns"
              :data-source="peerHealth"
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
              <dt>期望/已应用</dt>
              <dd>
                {{ overview?.desiredState.desiredStateVersion ?? 0 }}/{{
                  overview?.observedState.appliedDesiredStateVersion ?? 0
                }}
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
              <dt>已应用节点</dt>
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
              <dd>
                {{
                  localizeMaintenanceText(
                    overview?.observedState.transport.reason,
                  )
                }}
              </dd>
              <dt>失败信息</dt>
              <dd data-testid="relay-failure">
                {{ localizeMaintenanceText(overview?.relayFailure?.summary) }}
              </dd>
            </dl>
          </section>
        </a-col>
      </a-row>
    </a-card>
  </a-space>
</template>
