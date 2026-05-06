<script setup lang="ts">
import { onMounted, ref } from "vue";

import {
  listNotifications,
  markNotificationRead,
  type Notification,
  type PageResult,
} from "@/api/notifications";
import {
  listWorkOrders,
  resolveWorkOrder,
  type WorkOrder,
} from "@/api/work-orders";
import { useAuthStore } from "@/stores/auth";
import { formatDateTime } from "@/utils/format";

const authStore = useAuthStore();
const canWrite = authStore.hasPermission("notifications.write");

const loading = ref(false);
const notifications = ref<PageResult<Notification>>({
  items: [],
  total: 0,
  page: 1,
  pageSize: 20,
});

async function loadNotifications(page = 1): Promise<void> {
  loading.value = true;
  try {
    notifications.value = await listNotifications({ page, pageSize: 20 });
  } finally {
    loading.value = false;
  }
}

async function markRead(id: string): Promise<void> {
  await markNotificationRead(id);
  await loadNotifications();
}

const severityColor: Record<string, string> = {
  info: "default",
  warning: "warning",
  critical: "error",
};

const notificationColumns = [
  { title: "类型", dataIndex: "type", key: "type" },
  { title: "标题", dataIndex: "title", key: "title" },
  { title: "严重级别", dataIndex: "severity", key: "severity" },
  { title: "资源", key: "resource" },
  { title: "状态", dataIndex: "status", key: "status" },
  { title: "创建时间", dataIndex: "createdAt", key: "createdAt" },
  { title: "操作", key: "actions" },
];

// Work orders tab
const workOrderLoading = ref(false);
const workOrders = ref<PageResult<WorkOrder>>({
  items: [],
  total: 0,
  page: 1,
  pageSize: 20,
});

async function loadWorkOrders(page = 1): Promise<void> {
  workOrderLoading.value = true;
  try {
    workOrders.value = await listWorkOrders({ page, pageSize: 20 });
  } finally {
    workOrderLoading.value = false;
  }
}

const resolveDialogVisible = ref(false);
const resolveNote = ref("");
const resolveTargetId = ref("");

function openResolveDialog(record: WorkOrder): void {
  resolveTargetId.value = record.id;
  resolveNote.value = "";
  resolveDialogVisible.value = true;
}

async function confirmResolveWorkOrder(): Promise<void> {
  await resolveWorkOrder(resolveTargetId.value, resolveNote.value);
  resolveDialogVisible.value = false;
  await loadWorkOrders();
}

const workOrderColumns = [
  { title: "工单号", dataIndex: "workOrderNo", key: "workOrderNo" },
  { title: "标题", dataIndex: "title", key: "title" },
  { title: "优先级", dataIndex: "priority", key: "priority" },
  { title: "状态", dataIndex: "status", key: "status" },
  { title: "创建时间", dataIndex: "createdAt", key: "createdAt" },
  { title: "操作", key: "actions" },
];

onMounted(() => {
  void loadNotifications();
  void loadWorkOrders();
});
</script>

<template>
  <a-card title="通知中心">
    <a-tabs default-active-key="notifications">
      <a-tab-pane key="notifications" tab="通知列表">
        <a-table
          :columns="notificationColumns"
          :data-source="notifications.items"
          row-key="id"
          :loading="loading"
          :pagination="{
            current: notifications.page,
            pageSize: notifications.pageSize,
            total: notifications.total,
            onChange: loadNotifications,
          }"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'severity'">
              <a-tag :color="severityColor[record.severity] ?? 'default'">
                {{ record.severity }}
              </a-tag>
            </template>
            <template v-else-if="column.key === 'resource'">
              {{ record.resourceType }}
              {{ record.resourceId ? `#${record.resourceId.slice(0, 8)}` : "" }}
            </template>
            <template v-else-if="column.key === 'status'">
              <a-tag
                :color="record.status === 'unread' ? 'warning' : 'default'"
              >
                {{ record.status === "unread" ? "未读" : "已读" }}
              </a-tag>
            </template>
            <template v-else-if="column.key === 'createdAt'">
              {{ formatDateTime(record.createdAt) }}
            </template>
            <template v-else-if="column.key === 'actions'">
              <a-button
                v-if="canWrite && record.status === 'unread'"
                size="small"
                @click="markRead(record.id)"
              >
                标记已读
              </a-button>
            </template>
          </template>
        </a-table>
      </a-tab-pane>
      <a-tab-pane key="work-orders" tab="维护工单">
        <a-table
          :columns="workOrderColumns"
          :data-source="workOrders.items"
          row-key="id"
          :loading="workOrderLoading"
          :pagination="{
            current: workOrders.page,
            pageSize: workOrders.pageSize,
            total: workOrders.total,
            onChange: loadWorkOrders,
          }"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'createdAt'">
              {{ formatDateTime(record.createdAt) }}
            </template>
            <template v-else-if="column.key === 'actions'">
              <a-button
                v-if="
                  canWrite && ['open', 'in_progress'].includes(record.status)
                "
                size="small"
                type="primary"
                @click="openResolveDialog(record)"
              >
                标记完成
              </a-button>
            </template>
          </template>
        </a-table>
      </a-tab-pane>
    </a-tabs>
  </a-card>

  <a-modal
    v-model:open="resolveDialogVisible"
    title="处理工单"
    @ok="confirmResolveWorkOrder"
  >
    <a-input
      v-model:value="resolveNote"
      placeholder="请输入处理说明"
      allow-clear
    />
  </a-modal>
</template>
