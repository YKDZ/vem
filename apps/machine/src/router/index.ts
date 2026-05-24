import {
  createRouter,
  createWebHashHistory,
  type RouteRecordRaw,
} from "vue-router";

const routes: RouteRecordRaw[] = [
  {
    path: "/",
    redirect: "/boot",
  },
  {
    path: "/boot",
    name: "boot",
    component: async () => import("@/views/BootView.vue"),
  },
  {
    path: "/catalog",
    name: "catalog",
    component: async () => import("@/views/CatalogView.vue"),
  },
  {
    path: "/products/:inventoryId",
    name: "product-detail",
    component: async () => import("@/views/ProductDetailView.vue"),
  },
  {
    path: "/checkout",
    name: "checkout",
    component: async () => import("@/views/CheckoutView.vue"),
  },
  {
    path: "/payment",
    name: "payment",
    component: async () => import("@/views/PaymentView.vue"),
  },
  ...(import.meta.env.DEV
    ? [
        {
          path: "/dev/payment-code-scan",
          name: "payment-code-dev-scan",
          component: async () => import("@/views/PaymentCodeDevScanView.vue"),
        } satisfies RouteRecordRaw,
      ]
    : []),
  {
    path: "/dispensing",
    name: "dispensing",
    component: async () => import("@/views/DispensingView.vue"),
  },
  {
    path: "/result/:kind",
    name: "result",
    component: async () => import("@/views/ResultView.vue"),
  },
  {
    path: "/offline",
    name: "offline",
    component: async () => import("@/views/OfflineView.vue"),
  },
  {
    path: "/maintenance",
    name: "maintenance",
    component: async () => import("@/views/MaintenanceView.vue"),
  },
  {
    path: "/:pathMatch(.*)*",
    redirect: "/boot",
  },
];

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
});
