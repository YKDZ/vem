// @vitest-environment jsdom
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";

import { useCheckoutStore } from "@/stores/checkout";
import { useSaleCapabilityStore } from "@/stores/sale-capability";
import { saleCapabilitySnapshot } from "@/test-support/sale-capability";

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
    await authority.submit({
      type: "presence.departed",
      eventId: "departure-event-1",
    });
    await authority.submit({
      type: "readiness.navigate",
      target: { name: "catalog" },
    });

    expect(router.currentRoute.value.name).toBe("product-detail");
    expect(
      authority.trace
        .snapshot()
        .filter((record) => record.intentType !== "browser.navigate")
        .map((record) => record.decision),
    ).toEqual(["accepted", "accepted", "rejected", "rejected"]);
    expect(
      authority.trace
        .snapshot()
        .find((record) => record.intentType === "presence.departed"),
    ).toMatchObject({
      intentType: "presence.departed",
      sourceEventId: "departure-event-1",
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
    await authority.submit({
      type: "presence.departed",
      eventId: "departure-event-2",
    });

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

  it("keeps the payment route when a field-observed departure arrives", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: "/catalog", name: "catalog", component: {} },
        { path: "/payment", name: "payment", component: {} },
      ],
    });
    const authority = createMachineNavigationAuthority(router, pinia);
    useCheckoutStore(pinia).applyTransaction(activePaymentTransaction());
    await router.push("/payment");

    await authority.submit({
      type: "presence.departed",
      eventId: "departure-event-3",
    });

    expect(router.currentRoute.value.name).toBe("payment");
    expect(authority.trace.snapshot().slice(-1)[0]).toMatchObject({
      intentType: "presence.departed",
      sourceEventId: "departure-event-3",
      reasonCode: "active_transaction_route",
      transactionOrderNo: "ORD-ROUTE-ACTIVE",
    });
    authority.dispose();
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
        { path: "/checkout", name: "checkout", component: {} },
        { path: "/payment", name: "payment", component: {} },
      ],
    });
    installTransactionRouteAuthority(router, pinia);
    await router.push("/products/product-1");

    useCheckoutStore(pinia).paymentCreationAttemptActive = true;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(router.currentRoute.value.name).toBe("checkout");
  });

  it("keeps a deferred payment creation attempt on checkout after inactivity", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: "/catalog", name: "catalog", component: {} },
        { path: "/checkout", name: "checkout", component: {} },
      ],
    });
    const authority = createMachineNavigationAuthority(router, pinia);
    await router.push("/checkout");
    useCheckoutStore(pinia).paymentCreationAttemptActive = true;

    await authority.submit({ type: "customer.touch", atMs: 1_000 });
    await authority.submit({ type: "customer.inactive", atMs: 1_000 });

    expect(router.currentRoute.value.name).toBe("checkout");
    expect(authority.trace.snapshot().slice(-1)[0]).toMatchObject({
      reasonCode: "active_transaction_route",
      intentType: "customer.inactive",
    });
    authority.dispose();
  });

  it("does not let customer inactivity exit Local Operations", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: "/catalog", name: "catalog", component: {} },
        { path: "/maintenance", name: "maintenance", component: {} },
      ],
    });
    const authority = createMachineNavigationAuthority(router, pinia);
    await router.push("/maintenance");
    await authority.submit({ type: "customer.inactive" });
    expect(router.currentRoute.value.name).toBe("maintenance");

    authority.dispose();
  });

  it("does not let readiness recovery leave an operator route", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: "/catalog", name: "catalog", component: {} },
        { path: "/maintenance", name: "maintenance", component: {} },
      ],
    });
    const authority = createMachineNavigationAuthority(router, pinia);
    useSaleCapabilityStore(pinia).acceptSnapshot(saleCapabilitySnapshot());
    await router.push("/maintenance");

    await authority.submit({ type: "readiness.recovered" });

    expect(router.currentRoute.value.name).toBe("maintenance");
    expect(authority.trace.snapshot().slice(-1)[0]).toMatchObject({
      intentType: "readiness.recovered",
      decision: "rejected",
      reasonCode: "route_not_offline",
    });
    authority.dispose();
  });

  it("recovers when startup enters offline after sale capability is already ready", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: "/catalog", name: "catalog", component: {} },
        { path: "/boot", name: "boot", component: {} },
        { path: "/offline", name: "offline", component: {} },
      ],
    });
    const authority = createMachineNavigationAuthority(router, pinia);
    useSaleCapabilityStore(pinia).acceptSnapshot(saleCapabilitySnapshot());
    await router.push("/boot");

    await authority.submit({
      type: "startup.navigate",
      target: { name: "offline" },
    });
    await vi.waitFor(() => {
      expect(router.currentRoute.value.name).toBe("catalog");
    });
    expect(authority.trace.snapshot()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          intentType: "readiness.recovered",
          decision: "accepted",
          reasonCode: "sale_capability_recovered",
        }),
      ]),
    );
    authority.dispose();
  });

  it("freezes immutable trace route decisions before guarding browser navigation", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: "/catalog", name: "catalog", component: {} },
        { path: "/payment", name: "payment", component: {} },
      ],
    });
    const authority = createMachineNavigationAuthority(router, pinia);
    useCheckoutStore(pinia).applyTransaction(activePaymentTransaction());

    await router.push("/catalog");

    const record = authority.trace
      .snapshot()
      .find((candidate) => candidate.requestedRoute === "/catalog");
    expect(record).toMatchObject({
      intentType: "browser.navigate",
      requestedRoute: "/catalog",
      decidedRoute: "/payment",
      finalRoute: "/payment",
    });
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(authority.trace.snapshot())).toBe(true);
    authority.dispose();
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
