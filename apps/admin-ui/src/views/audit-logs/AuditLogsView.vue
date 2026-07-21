<script setup lang="ts">
import { onMounted, ref } from "vue";

import { listAuditLogs, type AuditLog, type PageResult } from "@/api/audit";
import { formatDateTime } from "@/utils/format";

const loading = ref(false);
const auditLogs = ref<PageResult<AuditLog>>({
  items: [],
  total: 0,
  page: 1,
  pageSize: 20,
});

const filterAdminUserId = ref("");
const filterAction = ref("");
const filterResourceType = ref("");

async function loadAuditLogs(page = 1): Promise<void> {
  loading.value = true;
  try {
    auditLogs.value = await listAuditLogs({
      adminUserId: filterAdminUserId.value || undefined,
      action: filterAction.value || undefined,
      resourceType: filterResourceType.value || undefined,
      page,
      pageSize: 20,
    });
  } finally {
    loading.value = false;
  }
}

// Detail modal
const detailOpen = ref(false);
const detailLog = ref<AuditLog | null>(null);

function openDetail(log: AuditLog): void {
  detailLog.value = log;
  detailOpen.value = true;
}

const columns = [
  { title: "操作人", dataIndex: "adminUserId", key: "adminUserId" },
  { title: "动作", dataIndex: "action", key: "action" },
  { title: "资源类型", dataIndex: "resourceType", key: "resourceType" },
  { title: "资源ID", dataIndex: "resourceId", key: "resourceId" },
  { title: "创建时间", dataIndex: "createdAt", key: "createdAt" },
  { title: "操作", key: "actions" },
];

onMounted(() => void loadAuditLogs());
</script>

<template>
  <section class="space-y-4">
    <a-card>
      <div class="mb-4 flex flex-wrap gap-3">
        <a-input
          v-model:value="filterAdminUserId"
          placeholder="操作人ID"
          class="max-w-48"
        />
        <a-input
          v-model:value="filterAction"
          placeholder="动作"
          class="max-w-48"
        />
        <a-input
          v-model:value="filterResourceType"
          placeholder="资源类型"
          class="max-w-48"
        />
        <a-button @click="loadAuditLogs()">查询</a-button>
      </div>
      <a-table
        :columns="columns"
        :data-source="auditLogs.items"
        row-key="id"
        :loading="loading"
        :pagination="{
          current: auditLogs.page,
          pageSize: auditLogs.pageSize,
          total: auditLogs.total,
          onChange: loadAuditLogs,
        }"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'createdAt'">
            {{ formatDateTime(record.createdAt) }}
          </template>
          <template v-else-if="column.key === 'resourceId'">
            {{
              record.resourceId ? record.resourceId.slice(0, 8) + "..." : "-"
            }}
          </template>
          <template v-else-if="column.key === 'actions'">
            <a-button size="small" @click="openDetail(record)">详情</a-button>
          </template>
        </template>
      </a-table>
    </a-card>

    <a-modal
      v-model:open="detailOpen"
      title="审计详情"
      :footer="null"
      size="700"
    >
      <template v-if="detailLog">
        <a-descriptions :column="1" bordered size="small">
          <a-descriptions-item label="操作人">{{
            detailLog.adminUserId
          }}</a-descriptions-item>
          <a-descriptions-item label="动作">{{
            detailLog.action
          }}</a-descriptions-item>
          <a-descriptions-item label="资源类型">{{
            detailLog.resourceType
          }}</a-descriptions-item>
          <a-descriptions-item label="资源ID">{{
            detailLog.resourceId
          }}</a-descriptions-item>
          <a-descriptions-item label="时间">
            {{ formatDateTime(detailLog.createdAt) }}
          </a-descriptions-item>
        </a-descriptions>
        <a-divider>变更前</a-divider>
        <pre class="max-h-48 overflow-auto rounded bg-slate-100 p-3 text-xs">{{
          JSON.stringify(detailLog.beforeJson, null, 2)
        }}</pre>
        <a-divider>变更后</a-divider>
        <pre class="max-h-48 overflow-auto rounded bg-slate-100 p-3 text-xs">{{
          JSON.stringify(detailLog.afterJson, null, 2)
        }}</pre>
      </template>
    </a-modal>
  </section>
</template>
