// @vitest-environment jsdom
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";

import type { MachineSaleReadiness, ReadySnapshot } from "@/daemon/schemas";

const {
  getReadyMock,
  getSaleReadinessMock,
  getSaleViewMock,
  routeParams,
  routerReplaceMock,
} = vi.hoisted(() => ({
  getReadyMock: vi.fn(),
  getSaleReadinessMock: vi.fn(),
  getSaleViewMock: vi.fn(),
  routeParams: { kind: "dispense_failed" },
  routerReplaceMock: vi.fn(),
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
    getReady: getReadyMock,
    getSaleReadiness: getSaleReadinessMock,
    getSaleView: getSaleViewMock,
  },
}));

import { useCheckoutStore } from "@/stores/checkout";
import { useConnectivityStore } from "@/stores/connectivity";
import { useVisionStore } from "@/stores/vision";

import ResultView from "./ResultView.vue";

let mountedApp: App<Element> | null = null;
let pinia: ReturnType<typeof createPinia>;

function terminalDispenseFailedTransaction() {
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
  };
}

function terminalUnknownDispenseTransaction() {
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
  };
}

function refundPendingTransaction() {
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
  };
}

function refundedTransaction() {
  return {
    ...refundPendingTransaction(),
    orderNo: "ORD-REFUNDED-001",
    paymentNo: "PAY-REFUNDED-001",
    paymentStatus: "refunded",
    orderStatus: "refunded",
    nextAction: "refunded",
  };
}

function successfulTransaction() {
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
  };
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

function paymentFailedTransaction() {
  return {
    ...terminalDispenseFailedTransaction(),
    orderNo: "ORD-PAYMENT-FAILED-001",
    paymentNo: "PAY-PAYMENT-FAILED-001",
    paymentStatus: "failed",
    orderStatus: "canceled",
    vending: null,
    nextAction: "payment_failed",
  };
}

function paymentExpiredTransaction() {
  return {
    ...terminalDispenseFailedTransaction(),
    orderNo: "ORD-PAYMENT-EXPIRED-001",
    paymentNo: "PAY-PAYMENT-EXPIRED-001",
    paymentStatus: "expired",
    orderStatus: "payment_expired",
    vending: null,
    nextAction: "payment_expired",
  };
}

function closedTransaction() {
  return {
    ...terminalDispenseFailedTransaction(),
    orderNo: "ORD-CLOSED-001",
    paymentNo: "PAY-CLOSED-001",
    paymentStatus: "canceled",
    orderStatus: "closed",
    vending: null,
    nextAction: "closed",
  };
}

function awaitingPaymentTransaction() {
  return {
    ...terminalDispenseFailedTransaction(),
    orderNo: "ORD-PAYMENT-RECOVERY-001",
    paymentNo: "PAY-PAYMENT-RECOVERY-001",
    paymentStatus: "pending",
    orderStatus: "pending_payment",
    vending: null,
    nextAction: "wait_payment",
  };
}

function applySaleReadiness(
  canSell: boolean,
  blockedSlots: Array<{
    slotId: string;
    slotCode: string;
    slotSalesState: string;
  }> = [],
): void {
  const connectivityStore = useConnectivityStore();
  connectivityStore.applyHealth({
    status: canSell ? "healthy" : "degraded",
    process: {
      component: "daemon",
      level: "ok",
      code: "PROCESS_READY",
      message: "ready",
      updatedAt: "2026-06-11T06:16:32.320Z",
    },
    components: [],
    configConfigured: true,
    databaseOnline: true,
    backendOnline: true,
    mqttConnected: true,
    outboxSize: 0,
    outboxMax: 1000,
    hardwareOnline: canSell,
    scannerOnline: true,
    visionOnline: true,
    remoteOpsActive: false,
    currentTransaction: null,
    operatorReason: canSell ? "" : "LOWER_CONTROLLER_UNAVAILABLE",
    updatedAt: "2026-06-11T06:16:32.320Z",
  });
  connectivityStore.applyReady(readyFixture(canSell));
  connectivityStore.applySaleReadiness(
    saleReadinessFixture(canSell, blockedSlots),
  );
}

function readyFixture(
  canSell: boolean,
  code = "LOWER_CONTROLLER_UNAVAILABLE",
): ReadySnapshot {
  return {
    ready: true,
    canSell,
    mode: canSell ? "catalog" : "maintenance",
    blockingCodes: canSell ? [] : [code],
    blockingReasons: canSell
      ? []
      : [
          {
            code,
            component: "hardware",
            message: "hardware blocked",
          },
        ],
    degradedReasons: [],
    suggestedRoute: canSell ? "catalog" : "maintenance",
    updatedAt: "2026-06-11T06:16:32.320Z",
  };
}

function saleReadinessFixture(
  canSell: boolean,
  blockedSlots: Array<{
    slotId: string;
    slotCode: string;
    slotSalesState: string;
  }> = [],
  code = "LOWER_CONTROLLER_UNAVAILABLE",
): MachineSaleReadiness {
  return {
    canStartNetworkAuthorizedSale: canSell,
    blockingCodes: canSell ? [] : [code],
    components: {
      platformReachability: {
        ready: true,
        code: "PLATFORM_REACHABLE",
        message: "platform reachable",
      },
      machineAuthentication: {
        ready: true,
        code: "MACHINE_AUTH_READY",
        message: "machine code configured",
      },
      activePlanogram: {
        ready: true,
        code: "ACTIVE_PLANOGRAM_READY",
        message: "PLAN-1",
      },
      paymentOptions: {
        ready: true,
        code: "PAYMENT_OPTIONS_READY",
        message: "payment option available",
        methods: [],
      },
      scannerCapability: {
        ready: true,
        code: "SCANNER_READY",
        message: "scanner ready",
      },
      syncHealth: {
        ready: true,
        code: "SYNC_READY",
        message: "sync connected",
      },
      wholeMachineBlockers: {
        ready: canSell,
        code: canSell ? "WHOLE_MACHINE_READY" : code,
        message: canSell ? "hardware ready" : "hardware blocked",
      },
      slotSaleSafety: {
        ready: canSell,
        code: canSell ? "SLOT_SALE_SAFETY_READY" : "NO_SALEABLE_SLOTS",
        message: canSell ? "slot sale safety ready" : "no saleable slots",
        blockedSlots,
      },
    },
  };
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
  routeParams.kind = "dispense_failed";
  getSaleViewMock.mockResolvedValue({
    items: [],
    source: "local_stock",
    planogramVersion: "PLAN-1",
    lastUpdatedAt: "2026-06-11T06:16:32.320Z",
  });
  getReadyMock.mockResolvedValue(readyFixture(true));
  getSaleReadinessMock.mockResolvedValue(
    saleReadinessFixture(true, [
      {
        slotId: "550e8400-e29b-41d4-a716-446655440001",
        slotCode: "B1",
        slotSalesState: "frozen",
      },
    ]),
  );
});

afterEach(() => {
  mountedApp?.unmount();
  mountedApp = null;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("ResultView", () => {
  it("routes away through the projected route target when the current checkout is no longer a result", async () => {
    useCheckoutStore().applyTransaction(awaitingPaymentTransaction());
    applySaleReadiness(true);

    const host = await mountView();

    await vi.waitFor(() => {
      expect(routerReplaceMock).toHaveBeenCalledWith({ name: "payment" });
    });
    expect(host.textContent).not.toContain("支付失败");
  });

  it("derives successful result semantics and credential behavior from the customer checkout view", async () => {
    routeParams.kind = "manual_handling";
    useCheckoutStore().applyTransaction(successfulTransaction());
    applySaleReadiness(true);

    const host = await mountView();
    await vi.waitFor(() => {
      expect(getReadyMock).toHaveBeenCalledOnce();
    });

    expect(host.textContent).toContain("出货成功");
    expect(host.textContent).toContain("秒后自动返回首页");
    expect(host.textContent).not.toContain("订单凭证 ORD-SUCCESS-001");
    expect(host.textContent).not.toContain("等待人工处理");
  });

  it("shows projected successful auto-return policy without waiting for page-level readiness refresh", async () => {
    routeParams.kind = "success";
    useCheckoutStore().applyTransaction(successfulTransaction());
    applySaleReadiness(true);
    getReadyMock.mockReturnValue(new Promise<ReadySnapshot>(() => undefined));
    getSaleReadinessMock.mockReturnValue(
      new Promise<MachineSaleReadiness>(() => undefined),
    );

    const host = await mountView();

    expect(host.textContent).toContain("出货成功");
    expect(host.textContent).toContain("秒后自动返回首页");
  });

  it("keeps a successful terminal result visible when readiness is blocked and returns to maintenance", async () => {
    routeParams.kind = "success";
    useCheckoutStore().applyTransaction(successfulTransaction());
    applySaleReadiness(false);
    getReadyMock.mockResolvedValue(
      readyFixture(false, "WHOLE_MACHINE_HARDWARE_FAULT"),
    );
    getSaleReadinessMock.mockResolvedValue(
      saleReadinessFixture(false, [], "WHOLE_MACHINE_HARDWARE_FAULT"),
    );

    const host = await mountView();
    await vi.waitFor(() => {
      expect(getReadyMock).toHaveBeenCalledOnce();
    });

    expect(host.textContent).toContain("出货成功");
    expect(host.textContent).not.toContain("秒后自动返回首页");

    const returnButton = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("返回首页"),
    );
    returnButton?.click();
    await nextTick();

    await vi.waitFor(() => {
      expect(routerReplaceMock).toHaveBeenCalledWith("/maintenance");
    });
    expect(routerReplaceMock).not.toHaveBeenCalledWith("/catalog");
  });

  it("stops successful auto-return and shows readiness error when readiness refresh fails", async () => {
    routeParams.kind = "success";
    const transaction = successfulTransaction();
    const checkoutStore = useCheckoutStore();
    checkoutStore.applyTransaction(transaction);
    applySaleReadiness(true);
    getReadyMock.mockRejectedValue(new Error("daemon readiness unavailable"));

    const host = await mountView();
    await vi.waitFor(() => {
      expect(getReadyMock).toHaveBeenCalledOnce();
    });
    await vi.advanceTimersByTimeAsync(10000);

    expect(host.textContent).toContain("出货成功");
    expect(host.textContent).not.toContain("秒后自动返回首页");
    expect(host.textContent).toContain("无法确认设备恢复状态");
    expect(routerReplaceMock).not.toHaveBeenCalledWith("/catalog");
    expect(getSaleViewMock).not.toHaveBeenCalled();
    expect(checkoutStore.shouldIgnoreTransaction(transaction)).toBe(false);
  });

  it("allows a recovered dispense failure result to be dismissed back to catalog", async () => {
    const transaction = terminalDispenseFailedTransaction();
    const checkoutStore = useCheckoutStore();
    checkoutStore.applyTransaction(transaction);
    applySaleReadiness(true, [
      {
        slotId: "550e8400-e29b-41d4-a716-446655440001",
        slotCode: "B1",
        slotSalesState: "frozen",
      },
    ]);

    const host = await mountView();
    await vi.waitFor(() => {
      expect(getReadyMock).toHaveBeenCalledOnce();
    });

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

  it("refreshes readiness for the restored terminal result", async () => {
    const transaction = refundedTransaction();
    const checkoutStore = useCheckoutStore();
    routeParams.kind = "refunded";
    checkoutStore.applyTransaction(transaction);
    applySaleReadiness(true);

    await mountView();

    expect(getReadyMock).toHaveBeenCalledOnce();
  });

  it("routes dismissal to catalog when sale-view refresh fails after fresh readiness is ready", async () => {
    routeParams.kind = "payment_failed";
    const transaction = paymentFailedTransaction();
    const checkoutStore = useCheckoutStore();
    checkoutStore.applyTransaction(transaction);
    applySaleReadiness(true);
    getSaleViewMock.mockRejectedValue(new Error("sale view unavailable"));

    const host = await mountView();
    await vi.waitFor(() => {
      expect(getReadyMock).toHaveBeenCalledOnce();
    });

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
    applySaleReadiness(false);
    getReadyMock.mockResolvedValue(
      readyFixture(false, "WHOLE_MACHINE_HARDWARE_FAULT"),
    );
    getSaleReadinessMock.mockResolvedValue(
      saleReadinessFixture(false, [], "WHOLE_MACHINE_HARDWARE_FAULT"),
    );

    const host = await mountView();

    await vi.waitFor(() => {
      expect(getReadyMock).toHaveBeenCalledOnce();
    });

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
    applySaleReadiness(false);
    getReadyMock.mockResolvedValue(
      readyFixture(false, "WHOLE_MACHINE_HARDWARE_FAULT"),
    );
    getSaleReadinessMock.mockResolvedValue(
      saleReadinessFixture(false, [], "WHOLE_MACHINE_HARDWARE_FAULT"),
    );

    const host = await mountView();
    await vi.waitFor(() => {
      expect(getReadyMock).toHaveBeenCalledOnce();
    });

    expect(host.textContent).toContain("等待人工处理");
    expect(host.textContent).toContain("设备需要维护检查");
    expect(host.textContent).not.toContain("返回首页");
  });

  it("keeps dismissible exceptional results visible when sale readiness is unknown", async () => {
    routeParams.kind = "payment_failed";
    const transaction = paymentFailedTransaction();
    useCheckoutStore().applyTransaction(transaction);

    const host = await mountView();

    expect(host.textContent).toContain("支付失败");
    expect(host.textContent).not.toContain("返回首页");
    expect(host.textContent).not.toContain("payment_failed");
    expect(host.textContent).not.toContain("ZodError");
  });

  it("does not dismiss a high-risk result when refreshed readiness requires retention", async () => {
    const transaction = terminalDispenseFailedTransaction();
    const checkoutStore = useCheckoutStore();
    checkoutStore.applyTransaction(transaction);
    applySaleReadiness(true);
    getReadyMock
      .mockReturnValueOnce(new Promise<ReadySnapshot>(() => undefined))
      .mockResolvedValue(readyFixture(false, "WHOLE_MACHINE_HARDWARE_FAULT"));
    getSaleReadinessMock
      .mockReturnValueOnce(new Promise<MachineSaleReadiness>(() => undefined))
      .mockResolvedValue(
        saleReadinessFixture(false, [], "WHOLE_MACHINE_HARDWARE_FAULT"),
      );

    const host = await mountView();

    expect(host.textContent).toContain("出货失败");
    expect(host.textContent).toContain("返回首页");

    const returnButton = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("返回首页"),
    );
    returnButton?.click();
    await nextTick();

    await vi.waitFor(() => {
      expect(getReadyMock).toHaveBeenCalledTimes(2);
    });
    await nextTick();
    expect(checkoutStore.shouldIgnoreTransaction(transaction)).toBe(false);
    expect(checkoutStore.customerCheckoutView).toMatchObject({
      stage: "result",
      result: {
        kind: "dispense_failed",
        returnPolicy: {
          canManualReturn: false,
          targetRoute: "maintenance",
          requiresMaintenanceReview: true,
        },
      },
    });
    expect(host.textContent).toContain("设备需要维护检查");
    expect(routerReplaceMock).not.toHaveBeenCalled();
    expect(getSaleViewMock).not.toHaveBeenCalled();
  });

  it("routes dismissed terminal results to maintenance when severe blockers remain", async () => {
    routeParams.kind = "payment_failed";
    const transaction = paymentFailedTransaction();
    const checkoutStore = useCheckoutStore();
    checkoutStore.applyTransaction(transaction);
    applySaleReadiness(true);
    getReadyMock.mockResolvedValue(
      readyFixture(false, "WHOLE_MACHINE_HARDWARE_FAULT"),
    );
    getSaleReadinessMock.mockResolvedValue(
      saleReadinessFixture(false, [], "WHOLE_MACHINE_HARDWARE_FAULT"),
    );

    const host = await mountView();
    await vi.waitFor(() => {
      expect(getReadyMock).toHaveBeenCalledOnce();
    });

    const returnButton = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("返回首页"),
    );
    returnButton?.click();
    await nextTick();

    await vi.waitFor(() => {
      expect(routerReplaceMock).toHaveBeenCalledWith("/maintenance");
    });
    expect(routerReplaceMock).not.toHaveBeenCalledWith("/catalog");
    expect(getSaleViewMock).not.toHaveBeenCalled();
    expect(checkoutStore.shouldIgnoreTransaction(transaction)).toBe(true);
  });

  it("shows manual handling copy and customer order credential for result_unknown", async () => {
    routeParams.kind = "manual_handling";
    const transaction = terminalUnknownDispenseTransaction();
    const checkoutStore = useCheckoutStore();
    checkoutStore.applyTransaction(transaction);
    applySaleReadiness(true, [
      {
        slotId: "550e8400-e29b-41d4-a716-446655440001",
        slotCode: "B1",
        slotSalesState: "frozen",
      },
    ]);

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
    expect(host.textContent).not.toContain("返回首页");
  });

  it("does not render route-param result copy after the projected result is cleared", async () => {
    routeParams.kind = "manual_handling";
    const checkoutStore = useCheckoutStore();
    checkoutStore.applyTransaction(terminalUnknownDispenseTransaction());
    applySaleReadiness(true);

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
    await vi.waitFor(() => {
      expect(routerReplaceMock).toHaveBeenCalledWith({ name: "catalog" });
    });
  });

  it("shows refund processing credential and keeps the customer waiting", async () => {
    routeParams.kind = "refund_pending";
    const transaction = refundPendingTransaction();
    useCheckoutStore().applyTransaction(transaction);
    applySaleReadiness(true);

    const host = await mountView();

    expect(host.textContent).toContain("退款处理中");
    expect(host.textContent).toContain("订单凭证 ORD-REFUND-001");
    expect(host.textContent).not.toContain("返回首页");
  });

  it("shows refunded credential and allows dismissing after recovery", async () => {
    routeParams.kind = "refunded";
    const transaction = refundedTransaction();
    useCheckoutStore().applyTransaction(transaction);
    applySaleReadiness(true);

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
      applySaleReadiness(true);

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
    applySaleReadiness(true);
    applySensitiveVisionProfile();

    const host = await mountView();

    expect(host.textContent).toContain("已退款");
    expectRecognitionDetailsHidden(host);
  });

  it("refreshes stale ready state without routing a dispense failure away from the result page", async () => {
    const transaction = terminalDispenseFailedTransaction();
    useCheckoutStore().applyTransaction(transaction);
    applySaleReadiness(true);
    getReadyMock.mockResolvedValue(
      readyFixture(false, "WHOLE_MACHINE_HARDWARE_FAULT"),
    );
    getSaleReadinessMock.mockResolvedValue(
      saleReadinessFixture(false, [], "WHOLE_MACHINE_HARDWARE_FAULT"),
    );

    await mountView();
    await vi.advanceTimersByTimeAsync(10000);

    expect(getReadyMock).toHaveBeenCalledOnce();
    expect(routerReplaceMock).not.toHaveBeenCalledWith("/maintenance");
    expect(routerReplaceMock).not.toHaveBeenCalledWith("/catalog");
    expect(getSaleViewMock).not.toHaveBeenCalled();
  });
});
