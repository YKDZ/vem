// @vitest-environment jsdom
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";

import type { TransactionSnapshot } from "@/daemon/schemas";

import { saleCapabilitySnapshot } from "@/test-support/sale-capability";

const {
  getSaleViewMock,
  routeParams,
  routerReplaceMock,
  submitMachineNavigationIntentMock,
} = vi.hoisted(() => ({
  getSaleViewMock: vi.fn(),
  routeParams: { kind: "dispense_failed" },
  routerReplaceMock: vi.fn(),
  submitMachineNavigationIntentMock: vi.fn(),
}));

vi.mock("@/router/transaction-route-authority", () => ({
  submitMachineNavigationIntent: submitMachineNavigationIntentMock,
}));

vi.mock("vue-router", () => ({
  useRoute: () => ({ params: routeParams }),
  useRouter: () => ({ replace: routerReplaceMock }),
}));

vi.mock("@/layouts/KioskLayout.vue", () => ({
  default: { template: "<main><slot /></main>" },
}));

vi.mock("@/daemon/client", () => ({
  daemonClient: {
    getSaleView: getSaleViewMock,
  },
}));

import { useCheckoutStore } from "@/stores/checkout";
import { useSaleCapabilityStore } from "@/stores/sale-capability";
import { useVisionStore } from "@/stores/vision";

import ResultView from "./ResultView.vue";

let mountedApp: App<Element> | null = null;
let pinia: ReturnType<typeof createPinia>;
let capabilityRevision = 0;

function terminalDispenseFailedTransaction(): TransactionSnapshot {
  return {
    orderId: "550e8400-e29b-41d4-a716-446655440010",
    orderNo: "ORD-FAILED-001",
    productSummary: null,
    paymentNo: "PAY-001",
    paymentMethod: "payment_code",
    paymentProvider: "alipay",
    paymentUrl: null,
    paymentStatus: "succeeded",
    orderStatus: "dispense_failed",
    totalAmountCents: 4900,
    vending: {
      commandNo: "CMD-001",
      status: "failed",
      lastError: "lower controller reported pickup platform blocked",
    },
    nextAction: "dispense_failed",
    maskedAuthCode: "2834****7658",
    paymentCodeAttempt: null,
    expiresAt: "2026-06-11T06:16:26.929Z",
    errorCode: null,
    errorMessage: null,
    operatorHint: null,
    updatedAt: "2026-06-11T06:08:34.006Z",
  } as TransactionSnapshot;
}

function terminalUnknownDispenseTransaction(): TransactionSnapshot {
  return {
    ...terminalDispenseFailedTransaction(),
    orderNo: "ORD-UNKNOWN-001",
    paymentNo: "PAY-UNKNOWN-001",
    orderStatus: "manual_handling",
    vending: {
      commandNo: "CMD-UNKNOWN",
      status: "result_unknown",
      lastError: "dispense result unknown after daemon restart",
    },
    nextAction: "manual_handling",
  } as TransactionSnapshot;
}

function refundPendingTransaction(): TransactionSnapshot {
  return {
    ...terminalDispenseFailedTransaction(),
    orderNo: "ORD-REFUND-001",
    paymentNo: "PAY-REFUND-001",
    paymentStatus: "refund_pending",
    orderStatus: "refund_pending",
    vending: {
      commandNo: "CMD-REFUND",
      status: "failed",
      lastError: "refund requested after dispense failure",
    },
    nextAction: "refund_pending",
  } as TransactionSnapshot;
}

function refundedTransaction(): TransactionSnapshot {
  return {
    ...refundPendingTransaction(),
    orderNo: "ORD-REFUNDED-001",
    paymentNo: "PAY-REFUNDED-001",
    paymentStatus: "refunded",
    orderStatus: "refunded",
    nextAction: "refunded",
  } as TransactionSnapshot;
}

function successfulTransaction(): TransactionSnapshot {
  return {
    ...terminalDispenseFailedTransaction(),
    orderNo: "ORD-SUCCESS-001",
    paymentNo: "PAY-SUCCESS-001",
    paymentStatus: "succeeded",
    orderStatus: "fulfilled",
    vending: {
      commandNo: "CMD-SUCCESS",
      status: "succeeded",
      lastError: null,
    },
    nextAction: "success",
  } as TransactionSnapshot;
}

function applySensitiveVisionProfile(): void {
  useVisionStore().applyLatestProfileResult({
    eventId: "vision-event-001",
    detectedAt: "2026-06-12T10:20:30.000Z",
    profile: {
      personPresent: true,
      heightCm: 172,
      bodyType: "regular",
      upperColor: "blue",
      confidence: 0.91,
    },
    quality: {
      overall: "good",
      warnings: ["light glare"],
    },
  });
}

function expectRecognitionDetailsHidden(host: HTMLElement): void {
  expect(host.textContent).not.toContain("vision-event-001");
  expect(host.textContent).not.toContain("172 cm");
  expect(host.textContent).not.toContain("light glare");
  expect(host.textContent).not.toContain('"heightCm": 172');
  expect(host.textContent).not.toContain('"confidence": 0.91');
}

function paymentFailedTransaction(): TransactionSnapshot {
  return {
    ...terminalDispenseFailedTransaction(),
    orderNo: "ORD-PAYMENT-FAILED-001",
    paymentNo: "PAY-PAYMENT-FAILED-001",
    paymentStatus: "failed",
    orderStatus: "canceled",
    vending: null,
    nextAction: "payment_failed",
  } as TransactionSnapshot;
}

function paymentExpiredTransaction(): TransactionSnapshot {
  return {
    ...terminalDispenseFailedTransaction(),
    orderNo: "ORD-PAYMENT-EXPIRED-001",
    paymentNo: "PAY-PAYMENT-EXPIRED-001",
    paymentStatus: "expired",
    orderStatus: "payment_expired",
    vending: null,
    nextAction: "payment_expired",
  } as TransactionSnapshot;
}

function closedTransaction(): TransactionSnapshot {
  return {
    ...terminalDispenseFailedTransaction(),
    orderNo: "ORD-CLOSED-001",
    paymentNo: "PAY-CLOSED-001",
    paymentStatus: "canceled",
    orderStatus: "closed",
    vending: null,
    nextAction: "closed",
  } as TransactionSnapshot;
}

function awaitingPaymentTransaction(): TransactionSnapshot {
  return {
    ...terminalDispenseFailedTransaction(),
    orderNo: "ORD-PAYMENT-RECOVERY-001",
    paymentNo: "PAY-PAYMENT-RECOVERY-001",
    paymentStatus: "pending",
    orderStatus: "pending_payment",
    vending: null,
    nextAction: "wait_payment",
  } as TransactionSnapshot;
}

function applyCapability(
  canSell: boolean,
  blockerCode = "LOWER_CONTROLLER_UNAVAILABLE",
): void {
  useSaleCapabilityStore().acceptSnapshot(
    capabilityFixture(canSell, blockerCode),
  );
}

function capabilityFixture(canSell: boolean, blockerCode?: string) {
  return saleCapabilitySnapshot({
    canStartSale: canSell,
    blockerCode,
    revision: ++capabilityRevision,
  });
}

async function mountView(): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  mountedApp = createApp(ResultView);
  mountedApp.use(pinia);
  mountedApp.mount(host);
  await nextTick();
  return host;
}

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-06-11T06:16:32.320Z"));
  window.localStorage.clear();
  vi.clearAllMocks();
  capabilityRevision = 0;
  submitMachineNavigationIntentMock.mockImplementation(async (intent) => {
    if (intent.type === "transaction.dismiss") {
      useCheckoutStore().dismissCurrentTerminalTransaction();
    }
    if (intent.type === "transaction.projection") {
      if (useCheckoutStore().customerCheckoutView.stage === "none") return;
      const target = useCheckoutStore().customerCheckoutView.routeTarget;
      routerReplaceMock("path" in target ? target.path : target);
      return;
    }
    if ("target" in intent) {
      const target = intent.target;
      routerReplaceMock(
        "name" in target && Object.keys(target).length === 1
          ? `/${target.name}`
          : target,
      );
    }
  });
  routeParams.kind = "dispense_failed";
  getSaleViewMock.mockResolvedValue({
    items: [],
    source: "local_stock",
    planogramVersion: "PLAN-1",
    lastUpdatedAt: "2026-06-11T06:16:32.320Z",
  });
});

afterEach(() => {
  mountedApp?.unmount();
  mountedApp = null;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("ResultView", () => {
  it("leaves non-result projection routing to the navigation authority", async () => {
    useCheckoutStore().applyTransaction(awaitingPaymentTransaction());
    applyCapability(true);

    const host = await mountView();

    expect(submitMachineNavigationIntentMock).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("支付失败");
  });

  it("derives successful result semantics and credential behavior from the customer checkout view", async () => {
    routeParams.kind = "manual_handling";
    useCheckoutStore().applyTransaction(successfulTransaction());
    applyCapability(true);

    const host = await mountView();

    expect(host.textContent).toContain("出货成功");
    await vi.waitFor(() => {
      expect(host.textContent).toContain("8 秒后自动返回首页。");
    });
    expect(host.textContent).not.toContain("订单凭证 ORD-SUCCESS-001");
    expect(host.textContent).not.toContain("等待人工处理");
  });

  it("does not create an autonomous result dismissal while readiness is pending", async () => {
    routeParams.kind = "success";
    useCheckoutStore().applyTransaction(successfulTransaction());

    const host = await mountView();

    expect(host.textContent).toContain("出货成功");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(host.textContent).not.toContain("秒后自动返回首页");
    expect(submitMachineNavigationIntentMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "transaction.dismiss" }),
    );
  });

  it("keeps a successful terminal result visible when capability is blocked and returns to catalog", async () => {
    routeParams.kind = "success";
    useCheckoutStore().applyTransaction(successfulTransaction());
    applyCapability(false);

    const host = await mountView();

    expect(host.textContent).toContain("出货成功");
    expect(host.textContent).not.toContain("秒后自动返回首页");

    const returnButton = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("返回首页"),
    );
    returnButton?.click();
    await nextTick();

    await vi.waitFor(() => {
      expect(routerReplaceMock).toHaveBeenCalledWith("/catalog");
    });
  });

  it("retains successful auto-return when capability refresh becomes stale", async () => {
    routeParams.kind = "success";
    const transaction = successfulTransaction();
    const checkoutStore = useCheckoutStore();
    checkoutStore.applyTransaction(transaction);
    applyCapability(true);
    useSaleCapabilityStore().markStale(
      new Error("daemon readiness unavailable"),
    );

    await mountView();
    await vi.advanceTimersByTimeAsync(10000);

    expect(routerReplaceMock).toHaveBeenCalledWith("/catalog");
    expect(checkoutStore.shouldIgnoreTransaction(transaction)).toBe(true);
  });

  it("allows a recovered dispense failure result to be dismissed back to catalog", async () => {
    const transaction = terminalDispenseFailedTransaction();
    const checkoutStore = useCheckoutStore();
    checkoutStore.applyTransaction(transaction);
    applyCapability(true);

    const host = await mountView();

    expect(host.textContent).toContain("出货失败");
    expect(host.textContent).toContain("订单凭证 ORD-FAILED-001");
    expect(host.textContent).toContain("返回首页");

    const returnButton = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("返回首页"),
    );
    returnButton?.click();
    await nextTick();
    await vi.waitFor(() => {
      expect(routerReplaceMock).toHaveBeenCalledWith("/catalog");
    });

    expect(routerReplaceMock).not.toHaveBeenCalledWith("/maintenance");
    expect(getSaleViewMock).toHaveBeenCalledOnce();
    expect(checkoutStore.shouldIgnoreTransaction(transaction)).toBe(true);
    expect(checkoutStore.customerCheckoutView).toMatchObject({
      stage: "none",
      routeTarget: { name: "catalog" },
      result: null,
    });
  });

  it("uses the shell-owned capability selector for the restored terminal result", async () => {
    const transaction = refundedTransaction();
    const checkoutStore = useCheckoutStore();
    routeParams.kind = "refunded";
    checkoutStore.applyTransaction(transaction);
    applyCapability(true);

    await mountView();
    expect(useSaleCapabilityStore().hasAcceptedCapability).toBe(true);
  });

  it("routes dismissal to catalog when sale-view refresh fails after fresh readiness is ready", async () => {
    routeParams.kind = "payment_failed";
    const transaction = paymentFailedTransaction();
    const checkoutStore = useCheckoutStore();
    checkoutStore.applyTransaction(transaction);
    applyCapability(true);
    getSaleViewMock.mockRejectedValue(new Error("sale view unavailable"));

    const host = await mountView();

    const returnButton = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("返回首页"),
    );
    returnButton?.click();
    await nextTick();

    await vi.waitFor(() => {
      expect(routerReplaceMock).toHaveBeenCalledWith("/catalog");
    });
    expect(getSaleViewMock).toHaveBeenCalledOnce();
    expect(checkoutStore.shouldIgnoreTransaction(transaction)).toBe(true);
  });

  it("keeps dispense failures on the result page when the machine remains blocked", async () => {
    const transaction = terminalDispenseFailedTransaction();
    useCheckoutStore().applyTransaction(transaction);
    applyCapability(false);

    const host = await mountView();

    expect(host.textContent).toContain("出货失败");
    expect(host.textContent).not.toContain("返回首页");
    expect(routerReplaceMock).not.toHaveBeenCalledWith("/maintenance");
    expect(routerReplaceMock).not.toHaveBeenCalledWith("/catalog");
    expect(getSaleViewMock).not.toHaveBeenCalled();
  });

  it("uses projected maintenance-review visibility for manual-handling results", async () => {
    routeParams.kind = "manual_handling";
    const transaction = terminalUnknownDispenseTransaction();
    useCheckoutStore().applyTransaction(transaction);
    applyCapability(false);

    const host = await mountView();

    expect(host.textContent).toContain("等待人工处理");
    expect(host.textContent).toContain("设备需要维护检查");
    expect(host.textContent).not.toContain("返回首页");
  });

  it("keeps dismissible exceptional results visible when capability is unknown", async () => {
    routeParams.kind = "payment_failed";
    const transaction = paymentFailedTransaction();
    useCheckoutStore().applyTransaction(transaction);

    const host = await mountView();

    expect(host.textContent).toContain("支付失败");
    expect(host.textContent).not.toContain("返回首页");
    expect(host.textContent).not.toContain("payment_failed");
    expect(host.textContent).not.toContain("ZodError");
  });

  it("does not dismiss a high-risk result when refreshed capability requires retention", async () => {
    const transaction = terminalDispenseFailedTransaction();
    const checkoutStore = useCheckoutStore();
    checkoutStore.applyTransaction(transaction);
    applyCapability(true);

    const host = await mountView();

    expect(host.textContent).toContain("出货失败");
    expect(host.textContent).toContain("返回首页");

    const returnButton = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("返回首页"),
    );
    applyCapability(false);
    returnButton?.click();
    await nextTick();
    expect(checkoutStore.shouldIgnoreTransaction(transaction)).toBe(false);
    expect(checkoutStore.customerCheckoutView).toMatchObject({
      stage: "result",
      result: {
        kind: "dispense_failed",
        returnPolicy: {
          canManualReturn: false,
          targetRoute: "catalog",
          requiresMaintenanceReview: true,
        },
      },
    });
    expect(host.textContent).toContain("设备需要维护检查");
    expect(getSaleViewMock).not.toHaveBeenCalled();
  });

  it("keeps terminal results retained when severe blockers remain", async () => {
    routeParams.kind = "payment_failed";
    const transaction = paymentFailedTransaction();
    const checkoutStore = useCheckoutStore();
    checkoutStore.applyTransaction(transaction);
    applyCapability(true);
    applyCapability(false);

    const host = await mountView();

    const returnButton = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("返回首页"),
    );
    expect(returnButton).toBeUndefined();
    expect(routerReplaceMock).not.toHaveBeenCalled();
    expect(getSaleViewMock).not.toHaveBeenCalled();
    expect(checkoutStore.shouldIgnoreTransaction(transaction)).toBe(false);
  });

  it("shows manual handling copy and customer order credential for result_unknown", async () => {
    routeParams.kind = "manual_handling";
    const transaction = terminalUnknownDispenseTransaction();
    const checkoutStore = useCheckoutStore();
    checkoutStore.applyTransaction(transaction);
    applyCapability(true);

    const host = await mountView();

    expect(checkoutStore.customerCheckoutView).toMatchObject({
      stage: "result",
      result: {
        kind: "manual_handling",
        displayIntent: "manual_handling",
        detailIntent: "dispense_result_unknown",
      },
    });
    expect(host.textContent).toContain("等待人工处理");
    expect(host.textContent).toContain("订单凭证 ORD-UNKNOWN-001");
    expect(host.textContent).toContain("出货结果待确认");
    const page = host.querySelector('[data-test="result-page"]');
    expect(page?.getAttribute("data-result-kind")).toBe("manual_handling");
    expect(page?.getAttribute("data-result-display-intent")).toBe(
      "manual_handling",
    );
    expect(host.textContent).not.toContain("返回首页");
  });

  it("does not render route-param result copy after the projected result is cleared", async () => {
    routeParams.kind = "manual_handling";
    const checkoutStore = useCheckoutStore();
    checkoutStore.applyTransaction(terminalUnknownDispenseTransaction());
    applyCapability(true);

    const host = await mountView();

    expect(host.textContent).toContain("等待人工处理");
    expect(host.textContent).toContain("订单凭证 ORD-UNKNOWN-001");

    checkoutStore.reset();
    await nextTick();

    expect(checkoutStore.customerCheckoutView).toMatchObject({
      stage: "none",
      result: null,
    });
    expect(host.textContent).toContain("正在恢复页面");
    expect(host.textContent).not.toContain("等待人工处理");
    expect(host.textContent).not.toContain("订单凭证 ORD-UNKNOWN-001");
    expect(host.textContent).not.toContain("出货结果待确认");
    expect(submitMachineNavigationIntentMock).not.toHaveBeenCalled();
  });

  it("shows refund processing credential and keeps the customer waiting", async () => {
    routeParams.kind = "refund_pending";
    const transaction = refundPendingTransaction();
    useCheckoutStore().applyTransaction(transaction);
    applyCapability(true);

    const host = await mountView();

    expect(host.textContent).toContain("退款处理中");
    expect(host.textContent).toContain("订单凭证 ORD-REFUND-001");
    expect(host.textContent).not.toContain("返回首页");
  });

  it("shows refunded credential and allows dismissing after recovery", async () => {
    routeParams.kind = "refunded";
    const transaction = refundedTransaction();
    useCheckoutStore().applyTransaction(transaction);
    applyCapability(true);

    const host = await mountView();

    expect(host.textContent).toContain("已退款");
    expect(host.textContent).toContain("订单凭证 ORD-REFUNDED-001");
    expect(host.textContent).toContain("返回首页");
  });

  it("shows payment-expired and closed pages without raw result codes", async () => {
    const cases = [
      {
        kind: "payment_expired",
        transaction: paymentExpiredTransaction(),
        title: "支付超时",
        rawCode: "payment_expired",
      },
      {
        kind: "closed",
        transaction: closedTransaction(),
        title: "订单已关闭",
        rawCode: "closed",
      },
    ];

    await cases.reduce(async (previous, testCase) => {
      await previous;
      mountedApp?.unmount();
      mountedApp = null;
      document.body.innerHTML = "";
      routeParams.kind = testCase.kind;
      useCheckoutStore().applyTransaction(testCase.transaction);
      applyCapability(true);

      const host = await mountView();

      expect(host.textContent).toContain(testCase.title);
      expect(host.textContent).not.toContain(testCase.rawCode);
      expect(host.textContent).not.toContain("ZodError");
    }, Promise.resolve());
  });

  it("keeps vision recognition details silent on the customer result page", async () => {
    routeParams.kind = "refunded";
    const transaction = refundedTransaction();
    useCheckoutStore().applyTransaction(transaction);
    applyCapability(true);
    applySensitiveVisionProfile();

    const host = await mountView();

    expect(host.textContent).toContain("已退款");
    expectRecognitionDetailsHidden(host);
  });

  it("keeps a stale ready selector from routing a dispense failure away from the result page", async () => {
    const transaction = terminalDispenseFailedTransaction();
    useCheckoutStore().applyTransaction(transaction);
    applyCapability(true);
    useSaleCapabilityStore().markStale(new Error("daemon reconnecting"));

    await mountView();
    await vi.advanceTimersByTimeAsync(10000);

    expect(routerReplaceMock).not.toHaveBeenCalledWith("/maintenance");
    expect(routerReplaceMock).not.toHaveBeenCalledWith("/catalog");
    expect(getSaleViewMock).not.toHaveBeenCalled();
  });
});
