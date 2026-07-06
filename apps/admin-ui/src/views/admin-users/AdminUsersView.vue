<script setup lang="ts">
import type { AdminUserStatus } from "@vem/shared";

import { onMounted, ref } from "vue";

import {
  createAdminUser,
  listAdminUsers,
  updateAdminUser,
  type AdminUser,
  type PageResult,
} from "@/api/admin-users";
import { listRoles, type Role } from "@/api/roles";
import { useAuthStore } from "@/stores/auth";
import { formatDateTime } from "@/utils/format";

import {
  toCreateAdminUserContract,
  toUpdateAdminUserContract,
} from "./admin-user-contract-mappers";

const authStore = useAuthStore();
const canWrite = authStore.hasPermission("adminUsers.write");

const loading = ref(false);
const users = ref<PageResult<AdminUser>>({
  items: [],
  total: 0,
  page: 1,
  pageSize: 20,
});
const allRoles = ref<Role[]>([]);

async function loadUsers(page = 1): Promise<void> {
  loading.value = true;
  try {
    users.value = await listAdminUsers({ page, pageSize: 20 });
  } finally {
    loading.value = false;
  }
}

async function loadRoles(): Promise<void> {
  const result = await listRoles();
  allRoles.value = result.items;
}

// User form / drawer
const drawerOpen = ref(false);
const editingUser = ref<AdminUser | null>(null);
const userForm = ref({
  username: "",
  password: "",
  displayName: "",
  mobile: "",
  email: "",
  status: "active" as AdminUserStatus,
  roleIds: [] as string[],
});
const saving = ref(false);

function openCreate(): void {
  editingUser.value = null;
  userForm.value = {
    username: "",
    password: "",
    displayName: "",
    mobile: "",
    email: "",
    status: "active",
    roleIds: [],
  };
  drawerOpen.value = true;
}

function openEdit(u: AdminUser): void {
  editingUser.value = u;
  userForm.value = {
    username: u.username,
    password: "",
    displayName: u.displayName,
    mobile: u.mobile ?? "",
    email: u.email ?? "",
    status: u.status,
    roleIds: u.roles ?? [],
  };
  drawerOpen.value = true;
}

async function saveUser(): Promise<void> {
  saving.value = true;
  try {
    if (editingUser.value) {
      await updateAdminUser(
        editingUser.value.id,
        toUpdateAdminUserContract(userForm.value),
      );
    } else {
      await createAdminUser(toCreateAdminUserContract(userForm.value));
    }
    drawerOpen.value = false;
    await loadUsers();
  } finally {
    saving.value = false;
  }
}

const columns = [
  { title: "用户名", dataIndex: "username", key: "username" },
  { title: "展示名", dataIndex: "displayName", key: "displayName" },
  { title: "手机号", dataIndex: "mobile", key: "mobile" },
  { title: "邮箱", dataIndex: "email", key: "email" },
  { title: "状态", dataIndex: "status", key: "status" },
  { title: "最近登录", dataIndex: "lastLoginAt", key: "lastLoginAt" },
  ...(canWrite ? [{ title: "操作", key: "actions" }] : []),
];

onMounted(() => {
  void loadUsers();
  if (canWrite) {
    void loadRoles();
  }
});
</script>

<template>
  <section class="space-y-4">
    <a-card>
      <div class="mb-4 flex gap-3">
        <a-button v-if="canWrite" type="primary" @click="openCreate"
          >新增用户</a-button
        >
      </div>
      <a-table
        :columns="columns"
        :data-source="users.items"
        row-key="id"
        :loading="loading"
        :pagination="{
          current: users.page,
          pageSize: users.pageSize,
          total: users.total,
          onChange: loadUsers,
        }"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'status'">
            <a-tag :color="record.status === 'active' ? 'success' : 'default'">
              {{ record.status }}
            </a-tag>
          </template>
          <template v-else-if="column.key === 'lastLoginAt'">
            {{ formatDateTime(record.lastLoginAt) }}
          </template>
          <template v-else-if="column.key === 'actions'">
            <a-button size="small" @click="openEdit(record)">编辑</a-button>
          </template>
        </template>
      </a-table>
    </a-card>

    <a-drawer
      v-model:open="drawerOpen"
      :title="editingUser ? '编辑用户' : '新增用户'"
      :destroy-on-hidden="true"
    >
      <a-form layout="vertical" :preserve="false">
        <a-form-item label="用户名">
          <a-input v-model:value="userForm.username" />
        </a-form-item>
        <a-form-item
          label="密码"
          :extra="editingUser ? '留空则不修改密码' : ''"
        >
          <a-input-password v-model:value="userForm.password" />
        </a-form-item>
        <a-form-item label="展示名">
          <a-input v-model:value="userForm.displayName" />
        </a-form-item>
        <a-form-item label="手机号">
          <a-input v-model:value="userForm.mobile" />
        </a-form-item>
        <a-form-item label="邮箱">
          <a-input v-model:value="userForm.email" />
        </a-form-item>
        <a-form-item label="状态">
          <a-select v-model:value="userForm.status">
            <a-select-option value="active">启用</a-select-option>
            <a-select-option value="disabled">禁用</a-select-option>
          </a-select>
        </a-form-item>
        <a-form-item label="角色">
          <a-select v-model:value="userForm.roleIds" mode="multiple">
            <a-select-option
              v-for="role in allRoles"
              :key="role.id"
              :value="role.id"
            >
              {{ role.name }}
            </a-select-option>
          </a-select>
        </a-form-item>
        <a-button type="primary" :loading="saving" @click="saveUser"
          >保存</a-button
        >
      </a-form>
    </a-drawer>
  </section>
</template>
