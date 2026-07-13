<script setup lang="ts">
import { ref } from "vue";

import { useAuthStore } from "@/stores/auth";
import AdminUsersView from "@/views/admin-users/AdminUsersView.vue";
import RolesView from "@/views/roles/RolesView.vue";
import QweatherTab from "@/views/system-settings/QweatherTab.vue";

const authStore = useAuthStore();
const canViewWeather = authStore.hasPermission("machines.read");
const canViewUsers = authStore.hasPermission("adminUsers.read");
const canViewRoles = authStore.hasPermission("roles.write");
const activeTab = ref(
  canViewWeather ? "weather" : canViewUsers ? "users" : "roles",
);
</script>

<template>
  <section>
    <header class="mb-4">
      <h1 class="m-0 text-xl font-semibold text-slate-900">系统配置</h1>
      <p class="mt-2 mb-0 text-sm text-slate-500">
        管理平台服务、后台用户和角色权限。
      </p>
    </header>

    <a-card :body-style="{ paddingTop: '8px' }">
      <a-tabs v-model:active-key="activeTab">
        <a-tab-pane v-if="canViewWeather" key="weather" tab="天气服务">
          <QweatherTab />
        </a-tab-pane>
        <a-tab-pane v-if="canViewUsers" key="users" tab="用户管理">
          <AdminUsersView />
        </a-tab-pane>
        <a-tab-pane v-if="canViewRoles" key="roles" tab="角色权限">
          <RolesView />
        </a-tab-pane>
      </a-tabs>
    </a-card>
  </section>
</template>
