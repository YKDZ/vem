import type { RouteRecordRaw } from "vue-router";

import AdminLayout from "@/layouts/AdminLayout.vue";

export const routes: RouteRecordRaw[] = [
  {
    path: "/login",
    name: "login",
    component: async () => import("@/views/login/LoginView.vue"),
    meta: { title: "登录", hiddenInMenu: true },
  },
  {
    path: "/403",
    name: "forbidden",
    component: async () => import("@/views/errors/ForbiddenView.vue"),
    meta: { title: "无权限", hiddenInMenu: true },
  },
  {
    path: "/",
    component: AdminLayout,
    redirect: "/dashboard",
    meta: { requiresAuth: true },
    children: [
      {
        path: "dashboard",
        name: "dashboard",
        component: async () => import("@/views/dashboard/DashboardView.vue"),
        meta: { title: "仪表盘", requiredPermissions: ["dashboard.read"] },
      },
      {
        path: "products",
        name: "products",
        component: async () => import("@/views/products/ProductsView.vue"),
        meta: { title: "商品管理", requiredPermissions: ["products.read"] },
      },
      {
        path: "machines",
        name: "machines",
        component: async () => import("@/views/machines/MachinesView.vue"),
        meta: { title: "机器管理", requiredPermissions: ["machines.read"] },
      },
      {
        path: "machines/:id",
        name: "machine-detail",
        component: async () => import("@/views/machines/MachineDetailView.vue"),
        meta: {
          title: "机器详情",
          hiddenInMenu: true,
          requiredPermissions: ["machines.read"],
        },
      },
      {
        path: "inventory",
        name: "inventory",
        component: async () => import("@/views/inventory/InventoryView.vue"),
        meta: { title: "库存管理", requiredPermissions: ["inventory.read"] },
      },
      {
        path: "orders",
        name: "orders",
        component: async () => import("@/views/orders/OrdersView.vue"),
        meta: { title: "订单管理", requiredPermissions: ["orders.read"] },
      },
      {
        path: "payments",
        name: "payments",
        component: async () => import("@/views/payments/PaymentsView.vue"),
        meta: { title: "支付管理", requiredPermissions: ["payments.read"] },
      },
      {
        path: "system-settings",
        name: "system-settings",
        component: async () =>
          import("@/views/system-settings/SystemSettingsView.vue"),
        meta: { title: "系统配置" },
      },
      {
        path: "notifications",
        name: "notifications",
        component: async () =>
          import("@/views/notifications/NotificationsView.vue"),
        meta: {
          title: "通知中心",
          requiredPermissions: ["notifications.read"],
        },
      },
      {
        path: "audit-logs",
        name: "audit-logs",
        component: async () => import("@/views/audit-logs/AuditLogsView.vue"),
        meta: { title: "系统审计", requiredPermissions: ["audit.read"] },
      },
    ],
  },
  { path: "/:pathMatch(.*)*", redirect: "/dashboard" },
];
