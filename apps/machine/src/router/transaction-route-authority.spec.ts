// @vitest-environment jsdom
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";

import { useCheckoutStore } from "@/stores/checkout";

import {
  createMachineNavigationAuthority,
  installTransactionRouteAuthority,
} from "./transaction-route-authority";

function activePaymentTransaction() {
  return {
    orderId: "550e8400-e29b-41d4-a716-446655440012",
    orderNo: "ORD-ROUTE-ACTIVE",
    productSummary: null,
    paymentId: "550e8400-e29b-41d4-a716-446655440013",
    paymentNo: "PAY-ROUTE-ACTIVE",
    paymentMethod: "qr_code" as const,
    paymentProvider: "alipay" as const,
    paymentUrl: "https://pay.example/active",
    paymentStatus: "pending" as const,
    orderStatus: "pending_payment" as const,
    totalAmountCents: 4900,
    vending: null,
    nextAction: "wait_payment" as const,
    maskedAuthCode: null,
    paymentCodeAttempt: null,
    expiresAt: "2099-06-30T08:15:00.000Z",
    errorCode: null,
    errorMessage: null,
    operatorHint: null,
    updatedAt: "2026-06-30T08:10:00.000Z",
  };
}

describe("transaction route authority", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("keeps a touched product journey ahead of vision departure and readiness refreshes", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: "/catalog", name: "catalog", component: {} },
        { path: "/products/:id", name: "product-detail", component: {} },
        { path: "/checkout", name: "checkout", component: {} },
      ],
    });
    const authority = createMachineNavigationAuthority(router, pinia, {
      now: () => 1_000,
    });

    await authority.submit({
      type: "customer.navigate",
      target: { name: "product-detail", params: { id: "product-1" } },
    });
    await authority.submit({ type: "customer.touch", atMs: 1_000 });
    await authority.submit({ type: "presence.departed" });
    await authority.submit({
      type: "readiness.navigate",
      target: { name: "catalog" },
    });

    expect(router.currentRoute.value.name).toBe("product-detail");
    expect(authority.trace.snapshot().map((record) => record.decision)).toEqual(
      ["accepted", "accepted", "rejected", "rejected"],
    );
    expect(authority.trace.snapshot()[2]).toMatchObject({
      intentType: "presence.departed",
      reasonCode: "touchscreen_session_active",
      transactionOrderNo: null,
      readinessRevision: null,
    });
    authority.dispose();
  });

  it("starts the touchscreen customer session from the first direct pointer interaction", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: "/catalog", name: "catalog", component: {} },
        { path: "/products/:id", name: "product-detail", component: {} },
      ],
    });
    const authority = createMachineNavigationAuthority(router, pinia);
    await authority.submit({
      type: "customer.navigate",
      target: { name: "product-detail", params: { id: "product-1" } },
    });

    window.dispatchEvent(new Event("pointerdown"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await authority.submit({ type: "presence.departed" });

    expect(router.currentRoute.value.name).toBe("product-detail");
    expect(authority.trace.snapshot()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          intentType: "customer.touch",
          reasonCode: "touchscreen_session_renewed",
        }),
      ]),
    );
    authority.dispose();
  });

  it("keeps an active daemon payment projection ahead of generic catalog navigation", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: "/catalog", name: "catalog", component: {} },
        { path: "/payment", name: "payment", component: {} },
      ],
    });
    installTransactionRouteAuthority(router, pinia);
    useCheckoutStore(pinia).applyTransaction(activePaymentTransaction());

    await router.push("/catalog");

    expect(router.currentRoute.value.name).toBe("payment");
  });

  it("requires explicit terminal dismissal before a completed transaction can leave its result route", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: "/catalog", name: "catalog", component: {} },
        { path: "/payment", name: "payment", component: {} },
        { path: "/result/:kind", name: "result", component: {} },
      ],
    });
    installTransactionRouteAuthority(router, pinia);
    const checkoutStore = useCheckoutStore(pinia);
    checkoutStore.applyTransaction({
      ...activePaymentTransaction(),
      paymentStatus: "succeeded",
      orderStatus: "fulfilled",
      nextAction: "success",
      vending: {
        commandId: null,
        commandNo: "CMD-ROUTE-SUCCESS",
        status: "succeeded",
        lastError: null,
      },
    });

    await router.push("/catalog");
    expect(router.currentRoute.value.fullPath).toBe("/result/success");

    checkoutStore.dismissCurrentTerminalTransaction();
    await router.push("/catalog");
    expect(router.currentRoute.value.name).toBe("catalog");
  });

  it("does not claim product navigation while order creation has no transaction", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: "/catalog", name: "catalog", component: {} },
        { path: "/products/:id", name: "product-detail", component: {} },
        { path: "/payment", name: "payment", component: {} },
      ],
    });
    installTransactionRouteAuthority(router, pinia);
    await router.push("/products/product-1");

    useCheckoutStore(pinia).loading = true;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(router.currentRoute.value.name).toBe("product-detail");
  });

  it("actively follows daemon transaction progress without waiting for page navigation", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: "/catalog", name: "catalog", component: {} },
        { path: "/payment", name: "payment", component: {} },
        { path: "/result/:kind", name: "result", component: {} },
      ],
    });
    installTransactionRouteAuthority(router, pinia);
    const checkoutStore = useCheckoutStore(pinia);
    await router.push("/catalog");
    checkoutStore.applyTransaction(activePaymentTransaction());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(router.currentRoute.value.name).toBe("payment");

    checkoutStore.applyTransaction({
      ...activePaymentTransaction(),
      paymentStatus: "succeeded",
      orderStatus: "fulfilled",
      nextAction: "success",
      vending: {
        commandId: null,
        commandNo: "CMD-ROUTE-AUTO-SUCCESS",
        status: "succeeded",
        lastError: null,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(router.currentRoute.value.fullPath).toBe("/result/success");
  });
});
