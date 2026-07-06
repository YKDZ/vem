<script setup lang="ts">
import type { RoleStatus } from "@vem/shared";

import { onMounted, ref } from "vue";

import {
  createRole,
  listPermissions,
  listRoles,
  updateRole,
  type PageResult,
  type Role,
} from "@/api/roles";
import { useAuthStore } from "@/stores/auth";

import {
  toCreateRoleContract,
  toUpdateRoleContract,
} from "./role-contract-mappers";

const authStore = useAuthStore();
const canWrite = authStore.hasPermission("roles.write");

const loading = ref(false);
const roles = ref<PageResult<Role>>({
  items: [],
  total: 0,
  page: 1,
  pageSize: 50,
});
const allPermissions = ref<string[]>([]);

async function loadRoles(): Promise<void> {
  loading.value = true;
  try {
    roles.value = await listRoles({ pageSize: 50 });
  } finally {
    loading.value = false;
  }
}

async function loadPermissions(): Promise<void> {
  allPermissions.value = await listPermissions();
}

// Role form / drawer
const drawerOpen = ref(false);
const editingRole = ref<Role | null>(null);
const roleForm = ref({
  code: "",
  name: "",
  description: "",
  status: "active" as RoleStatus,
  permissionCodes: [] as string[],
});
const saving = ref(false);

function openCreate(): void {
  editingRole.value = null;
  roleForm.value = {
    code: "",
    name: "",
    description: "",
    status: "active",
    permissionCodes: [],
  };
  drawerOpen.value = true;
}

function openEdit(r: Role): void {
  editingRole.value = r;
  roleForm.value = {
    code: r.code,
    name: r.name,
    description: r.description ?? "",
    status: r.status,
    permissionCodes: r.permissionCodes ?? [],
  };
  drawerOpen.value = true;
}

async function saveRole(): Promise<void> {
  saving.value = true;
  try {
    if (editingRole.value) {
      await updateRole(
        editingRole.value.id,
        toUpdateRoleContract(roleForm.value),
      );
    } else {
      await createRole(toCreateRoleContract(roleForm.value));
    }
    drawerOpen.value = false;
    await loadRoles();
  } finally {
    saving.value = false;
  }
}

const columns = [
  { title: "Code", dataIndex: "code", key: "code" },
  { title: "名称", dataIndex: "name", key: "name" },
  { title: "描述", dataIndex: "description", key: "description" },
  { title: "内置", dataIndex: "isBuiltin", key: "isBuiltin" },
  { title: "状态", dataIndex: "status", key: "status" },
  { title: "权限数量", key: "permCount" },
  ...(canWrite ? [{ title: "操作", key: "actions" }] : []),
];

onMounted(() => {
  void loadRoles();
  void loadPermissions();
});
</script>

<template>
  <section class="space-y-4">
    <a-card>
      <div class="mb-4 flex gap-3">
        <a-button v-if="canWrite" type="primary" @click="openCreate"
          >新增角色</a-button
        >
      </div>
      <a-table
        :columns="columns"
        :data-source="roles.items"
        row-key="id"
        :loading="loading"
        :pagination="false"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'isBuiltin'">
            <a-tag v-if="record.isBuiltin" color="blue">内置</a-tag>
          </template>
          <template v-else-if="column.key === 'status'">
            <a-tag :color="record.status === 'active' ? 'success' : 'default'">
              {{ record.status }}
            </a-tag>
          </template>
          <template v-else-if="column.key === 'permCount'">
            {{ record.permissionCodes?.length ?? 0 }}
          </template>
          <template v-else-if="column.key === 'actions'">
            <a-button size="small" @click="openEdit(record)">编辑</a-button>
          </template>
        </template>
      </a-table>
    </a-card>

    <a-drawer
      v-model:open="drawerOpen"
      :title="editingRole ? '编辑角色' : '新增角色'"
      :destroy-on-hidden="true"
    >
      <a-form layout="vertical" :preserve="false">
        <a-form-item label="Code">
          <a-input
            v-model:value="roleForm.code"
            :disabled="editingRole?.isBuiltin"
          />
        </a-form-item>
        <a-form-item label="名称">
          <a-input v-model:value="roleForm.name" />
        </a-form-item>
        <a-form-item label="描述">
          <a-textarea v-model:value="roleForm.description" :rows="2" />
        </a-form-item>
        <a-form-item label="状态">
          <a-select v-model:value="roleForm.status">
            <a-select-option value="active">启用</a-select-option>
            <a-select-option value="disabled">禁用</a-select-option>
          </a-select>
        </a-form-item>
        <a-form-item label="权限">
          <a-checkbox-group
            v-model:value="roleForm.permissionCodes"
            class="flex flex-col gap-1"
          >
            <a-checkbox
              v-for="perm in allPermissions"
              :key="perm"
              :value="perm"
            >
              {{ perm }}
            </a-checkbox>
          </a-checkbox-group>
        </a-form-item>
        <a-button type="primary" :loading="saving" @click="saveRole"
          >保存</a-button
        >
      </a-form>
    </a-drawer>
  </section>
</template>
