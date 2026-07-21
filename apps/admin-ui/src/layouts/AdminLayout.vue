<script setup lang="ts">
import type { PermissionCode } from "@vem/shared";
import type { Component } from "vue";

import {
  AuditOutlined,
  BellOutlined,
  DashboardOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  OrderedListOutlined,
  ProductOutlined,
  ShopOutlined,
  TransactionOutlined,
  SettingOutlined,
} from "@antdv-next/icons";
import { computed } from "vue";
import { RouterView, useRoute, useRouter } from "vue-router";

import { routes } from "@/router/routes";
import { useAppStore } from "@/stores/app";
import { useAuthStore } from "@/stores/auth";

const ROUTE_ICON_MAP: Record<string, Component> = {
  dashboard: DashboardOutlined,
  products: ProductOutlined,
  machines: ShopOutlined,
  inventory: OrderedListOutlined,
  orders: TransactionOutlined,
  payments: TransactionOutlined,
  "system-settings": SettingOutlined,
  notifications: BellOutlined,
  "audit-logs": AuditOutlined,
};

type MenuItem = {
  key: string;
  label: string;
  icon: Component;
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
      icon: ROUTE_ICON_MAP[String(item.name)] ?? DashboardOutlined,
      requiredPermissions: isPermissionArray(item.meta?.requiredPermissions)
        ? item.meta.requiredPermissions
        : [],
    }))
    .filter((item) => authStore.hasEveryPermission(item.requiredPermissions));
});

const selectedKeys = computed(() => [String(route.name ?? "dashboard")]);

async function handleMenuClick(info: { key: string }): Promise<void> {
  const target = menuItems.value.find((item) => item.key === info.key);
  if (target) await router.push({ name: target.key });
}

function logout(): void {
  authStore.logout();
  void router.replace("/login");
}
</script>

<template>
  <a-layout style="min-height: 100vh">
    <a-layout-sider
      :collapsed="appStore.sidebarCollapsed"
      collapsible
      breakpoint="lg"
      :trigger="null"
      class="border-r border-slate-100"
    >
      <div
        :class="[
          'flex h-16 items-center border-b border-slate-100',
          appStore.sidebarCollapsed ? 'justify-center' : 'justify-between px-3',
        ]"
      >
        <span
          v-show="!appStore.sidebarCollapsed"
          class="pl-2 text-base font-bold"
          style="color: #2563eb"
          >VEM</span
        >
        <a-button
          type="text"
          class="flex items-center justify-center"
          @click="appStore.setSidebarCollapsed(!appStore.sidebarCollapsed)"
        >
          <MenuFoldOutlined v-if="!appStore.sidebarCollapsed" />
          <MenuUnfoldOutlined v-else />
        </a-button>
      </div>
      <a-menu
        theme="light"
        mode="inline"
        :selected-keys="selectedKeys"
        @click="handleMenuClick"
      >
        <a-menu-item v-for="item in menuItems" :key="item.key">
          <template #icon><component :is="item.icon" /></template>
          {{ item.label }}
        </a-menu-item>
      </a-menu>
    </a-layout-sider>

    <a-layout>
      <a-layout-header
        class="flex items-center justify-end border-b border-slate-100 bg-white px-4"
      >
        <a-space>
          <span class="text-sm text-slate-600">
            {{
              authStore.currentAdmin?.displayName ??
              authStore.currentAdmin?.username
            }}
          </span>
          <a-button type="link" @click="logout"><LogoutOutlined /></a-button>
        </a-space>
      </a-layout-header>
      <a-layout-content class="p-6">
        <RouterView />
      </a-layout-content>
    </a-layout>
  </a-layout>
</template>
