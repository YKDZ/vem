<script setup lang="ts">
import type { PermissionCode } from "@vem/shared";

import { computed } from "vue";
import { RouterView, useRoute, useRouter } from "vue-router";

import { routes } from "@/router/routes";
import { useAppStore } from "@/stores/app";
import { useAuthStore } from "@/stores/auth";

type MenuItem = {
  key: string;
  label: string;
  path: string;
  requiredPermissions: PermissionCode[];
};

const route = useRoute();
const router = useRouter();
const appStore = useAppStore();
const authStore = useAuthStore();

function isPermissionArray(value: unknown): value is PermissionCode[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

const menuItems = computed<MenuItem[]>(() => {
  const adminRoot = routes.find((item) => item.path === "/");
  return (adminRoot?.children ?? [])
    .filter((item) => !item.meta?.hiddenInMenu)
    .map((item) => ({
      key: String(item.name),
      label: String(item.meta?.title ?? item.name),
      path: `/${String(item.path)}`,
      requiredPermissions: isPermissionArray(item.meta?.requiredPermissions)
        ? item.meta.requiredPermissions
        : [],
    }))
    .filter((item) => authStore.hasEveryPermission(item.requiredPermissions));
});

const selectedKeys = computed(() => [String(route.name ?? "dashboard")]);

async function handleMenuClick(info: { key: string }): Promise<void> {
  const target = menuItems.value.find((item) => item.key === info.key);
  if (target) await router.push(target.path);
}

function logout(): void {
  authStore.logout();
  void router.replace("/login");
}
</script>

<template>
  <a-layout class="min-h-screen">
    <a-layout-sider
      :collapsed="appStore.sidebarCollapsed"
      collapsible
      breakpoint="lg"
      :trigger="null"
      class="bg-slate-950"
    >
      <div class="flex h-16 items-center px-5 text-lg font-semibold text-white">
        VEM
      </div>
      <a-menu
        theme="dark"
        mode="inline"
        :selected-keys="selectedKeys"
        @click="handleMenuClick"
      >
        <a-menu-item v-for="item in menuItems" :key="item.key">
          {{ item.label }}
        </a-menu-item>
      </a-menu>
    </a-layout-sider>

    <a-layout>
      <a-layout-header
        class="flex items-center justify-between bg-white px-4 shadow-sm"
      >
        <a-button
          type="text"
          @click="appStore.setSidebarCollapsed(!appStore.sidebarCollapsed)"
        >
          {{ appStore.sidebarCollapsed ? "展开" : "收起" }}
        </a-button>
        <a-space>
          <span class="text-sm text-slate-600">
            {{
              authStore.currentAdmin?.displayName ??
              authStore.currentAdmin?.username
            }}
          </span>
          <a-button type="link" @click="logout">退出</a-button>
        </a-space>
      </a-layout-header>
      <a-layout-content class="bg-slate-50 p-6">
        <RouterView />
      </a-layout-content>
    </a-layout>
  </a-layout>
</template>
