// @vitest-environment jsdom
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";

const {
  cancelOrderMock,
  getCurrentTransactionMock,
  getSaleViewMock,
  getScannerStatusMock,
  routerReplaceMock,
} = vi.hoisted(() => ({
  cancelOrderMock: vi.fn(),
  getCurrentTransactionMock: vi.fn(),
  getSaleViewMock: vi.fn(),
  getScannerStatusMock: vi.fn(),
  routerReplaceMock: vi.fn(),
}));

vi.mock("vue-router", () => ({
  useRouter: () => ({ replace: routerReplaceMock }),
  RouterLink: { template: "<a><slot /></a>" },
}));

vi.mock("@/layouts/KioskLayout.vue", () => ({
  default: { template: "<main><slot /></main>" },
}));

vi.mock("@/components/PaymentQrCode.vue", () => ({
  default: {
    props: ["overlayText", "emptyText"],
    template:
      '<div><span v-if="overlayText">{{ overlayText }}</span><span v-else>{{ emptyText }}</span></div>',
  },
}));

vi.mock("@/daemon/client", () => ({
  daemonClient: {
    currentConnection: { mock: false },
    cancelOrder: cancelOrderMock,
    getCurrentTransaction: getCurrentTransactionMock,
    getSaleView: getSaleViewMock,
    getScannerStatus: getScannerStatusMock,
  },
}));

import type { CustomerCheckoutView } from "@/checkout/customer-checkout-view";
import { useCheckoutStore } from "@/stores/checkout";

import PaymentView from "./PaymentView.vue";

let mountedApp: App<Element> | null = null;
let pinia: ReturnType<typeof createPinia>;

function expiredQrConfirmingTransaction() {
  return {
    orderId: "550e8400-e29b-41d4-a716-446655440010",
    orderNo: "ORD-CONFIRM-001",
    productSummary: null,
    paymentNo: "PAY-CONFIRM-001",
    paymentMethod: "qr_code",
    paymentProvider: "alipay",
    paymentUrl: "https://pay.example/qr",
    paymentStatus: "pending",
    orderStatus: "pending_payment",
    totalAmountCents: 1200,
    vending: null,
    nextAction: "wait_payment",
    maskedAuthCode: null,
    paymentCodeAttempt: null,
    expiresAt: "2026-06-11T06:15:00.000Z",
    errorCode: null,
    errorMessage: null,
    operatorHint: null,
    updatedAt: "2026-06-11T06:16:32.320Z",
  };
}

function activeQrPaymentTransaction() {
  return {
    ...expiredQrConfirmingTransaction(),
    orderNo: "ORD-CANCEL-001",
    expiresAt: "2026-06-11T06:20:00.000Z",
    updatedAt: "2026-06-11T06:16:32.320Z",
  };
}

function inFlightPaymentCodeTransaction() {
  return {
    ...activeQrPaymentTransaction(),
    orderNo: "ORD-CODE-001",
    paymentMethod: "payment_code",
    paymentUrl: null,
    paymentCodeAttempt: {
      attemptNo: 1,
      status: "querying",
      maskedAuthCode: "2876****4394",
      source: "serial_text",
      idempotencyKey: "ORD-CODE-001:attempt-1",
      submittedAt: "2026-06-11T06:16:30.000Z",
      lastCheckedAt: null,
      canRetry: false,
      message: "正在确认支付结果",
    },
  };
}

function paymentCodeTransaction(overrides: Record<string, unknown> = {}) {
  return {
    ...inFlightPaymentCodeTransaction(),
    orderNo: "ORD-CODE-STATE",
    paymentCodeAttempt: null,
    ...overrides,
  };
}

async function mountView(): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  mountedApp = createApp(PaymentView);
  mountedApp.use(pinia);
  mountedApp.mount(host);
  await nextTick();
  await Promise.resolve();
  await nextTick();
  return host;
}

async function flushPromises(times = 20): Promise<void> {
  await flushMicrotasks(times);
  await nextTick();
}

async function flushMicrotasks(remaining: number): Promise<void> {
  if (remaining <= 0) return;
  await Promise.resolve();
  await flushMicrotasks(remaining - 1);
}

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-06-11T06:16:32.320Z"));
  vi.clearAllMocks();
  getCurrentTransactionMock.mockResolvedValue(expiredQrConfirmingTransaction());
  cancelOrderMock.mockResolvedValue({
    ...expiredQrConfirmingTransaction(),
    paymentStatus: "canceled",
    orderStatus: "canceled",
    nextAction: "closed",
  });
  getSaleViewMock.mockResolvedValue({
    items: [],
    source: "local_stock",
    planogramVersion: "PLAN-1",
    lastUpdatedAt: "2026-06-11T06:16:32.320Z",
  });
  getScannerStatusMock.mockResolvedValue({
    online: true,
    adapter: "serial_text",
    port: "COM3",
    level: "online",
    code: "SCANNER_READY",
    message: "scanner ready",
    updatedAt: "2026-06-11T06:16:32.320Z",
  });
});

afterEach(() => {
  mountedApp?.unmount();
  mountedApp = null;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("PaymentView", () => {
  it("shows customer order credential while expired QR payment is confirming", async () => {
    const checkoutStore = useCheckoutStore();
    checkoutStore.applyTransaction(expiredQrConfirmingTransaction());

    const host = await mountView();

    expect(host.textContent).toContain("正在确认支付结果");
    expect(host.textContent).toContain("订单凭证");
    expect(host.textContent).toContain("ORD-CONFIRM-001");
    expect(routerReplaceMock).not.toHaveBeenCalled();
  });

  it("disables cancel while expired QR payment is confirming", async () => {
    const checkoutStore = useCheckoutStore();
    checkoutStore.applyTransaction(expiredQrConfirmingTransaction());

    const host = await mountView();
    const cancelButton = host.querySelector("button.payment-cancel-button");

    expect(cancelButton).toBeInstanceOf(HTMLButtonElement);
    expect((cancelButton as HTMLButtonElement).disabled).toBe(true);
    expect(host.textContent).toContain("支付结果确认中，暂不可取消");
  });

  it("renders remaining time from the projected payment view", async () => {
    vi.setSystemTime(new Date("2026-06-11T06:19:55.000Z"));
    const transaction = activeQrPaymentTransaction();
    getCurrentTransactionMock.mockResolvedValue(transaction);
    const checkoutStore = useCheckoutStore();
    checkoutStore.applyTransaction(transaction);
    checkoutStore.tick(new Date("2026-06-11T06:19:55.000Z").getTime());
    const projectedView: CustomerCheckoutView = {
      stage: "payment",
      routeTarget: { name: "payment" },
      orderCredential: "ORD-CANCEL-001",
      restored: false,
      payment: {
        method: "qr_code",
        provider: "alipay",
        paymentUrl: "https://pay.example/qr",
        expiresAt: "2026-06-11T06:20:00.000Z",
        totalAmountCents: 1200,
        remainingSeconds: 83,
        canCancel: true,
        cancelDisabledReason: null,
        display: { kind: "qr", state: "pending" },
      },
      dispensing: null,
      result: null,
      customerEventObservation: {
        phase: "awaiting_payment",
        orderCredential: "ORD-CANCEL-001",
        journeyFact: "payment_requested",
        pickupCue: null,
        restored: false,
      },
    };
    vi.spyOn(checkoutStore, "customerCheckoutView", "get").mockReturnValue(
      projectedView,
    );

    const host = await mountView();

    expect(host.querySelector(".payment-countdown")?.textContent).toBe("01:23");
  });

  it("cancels an active payment and returns to product detail", async () => {
    getCurrentTransactionMock.mockResolvedValue(activeQrPaymentTransaction());
    const checkoutStore = useCheckoutStore();
    checkoutStore.selectedItem = {
      catalogKey: "product:SOCK-001",
    } as NonNullable<typeof checkoutStore.selectedItem>;
    checkoutStore.applyTransaction(activeQrPaymentTransaction());

    const host = await mountView();
    const cancelButton = host.querySelector("button.payment-cancel-button");
    expect(cancelButton).toBeInstanceOf(HTMLButtonElement);
    (cancelButton as HTMLButtonElement).click();
    await flushPromises();

    expect(cancelOrderMock).toHaveBeenCalledWith("ORD-CANCEL-001");
    expect(routerReplaceMock).toHaveBeenCalledWith({
      name: "product-detail",
      params: { catalogKey: "product:SOCK-001" },
    });
  });

  it("routes paid transactions to dispensing", async () => {
    const paidTransaction = {
      ...activeQrPaymentTransaction(),
      paymentStatus: "succeeded",
      orderStatus: "dispensing",
      nextAction: "dispensing",
      vending: {
        commandNo: "CMD-PAYMENT-SUCCESS-001",
        status: "sent",
        lastError: null,
      },
      updatedAt: "2026-06-11T06:16:33.000Z",
    };
    getCurrentTransactionMock.mockResolvedValue(paidTransaction);
    const checkoutStore = useCheckoutStore();
    checkoutStore.applyTransaction({
      ...activeQrPaymentTransaction(),
      paymentStatus: "processing",
      orderStatus: "pending_payment",
      nextAction: "wait_payment",
    });

    await mountView();
    await flushPromises();

    expect(routerReplaceMock).toHaveBeenCalledWith("/dispensing");
  });

  it("uses projected payment-code intent to block cancellation with Chinese copy", async () => {
    getCurrentTransactionMock.mockResolvedValue(
      inFlightPaymentCodeTransaction(),
    );
    const checkoutStore = useCheckoutStore();
    checkoutStore.applyTransaction(inFlightPaymentCodeTransaction());

    const host = await mountView();
    const cancelButton = host.querySelector("button.payment-cancel-button");

    expect(host.textContent).toContain("正在确认支付结果");
    expect(host.textContent).toContain("付款码支付处理中，暂不可取消");
    expect(cancelButton).toBeInstanceOf(HTMLButtonElement);
    expect((cancelButton as HTMLButtonElement).disabled).toBe(true);
    expect(host.textContent).not.toContain("payment_code_in_flight");
  });

  it("shows projected payment-code ready copy without scanner display state", async () => {
    const transaction = paymentCodeTransaction();
    getCurrentTransactionMock.mockResolvedValue(transaction);
    getScannerStatusMock.mockResolvedValue({
      online: false,
      adapter: "serial_text",
      port: "COM3",
      level: "offline",
      code: "SCANNER_OPEN_FAILED",
      message: "scanner open failed",
      updatedAt: "2026-06-11T06:16:32.320Z",
    });
    const checkoutStore = useCheckoutStore();
    checkoutStore.applyTransaction(transaction);

    const host = await mountView();

    expect(host.textContent).toContain("请出示付款码");
    expect(host.textContent).toContain("请打开支付宝或微信付款码");
    expect(host.textContent).not.toContain("扫码器暂不可用");
  });

  it("shows projected payment-code retryable copy without raw attempt messages", async () => {
    const transaction = paymentCodeTransaction({
      paymentCodeAttempt: {
        attemptNo: 1,
        status: "failed",
        maskedAuthCode: "2876****4394",
        source: "serial_text",
        idempotencyKey: "ORD-CODE-STATE:attempt-1",
        submittedAt: "2026-06-11T06:16:30.000Z",
        lastCheckedAt: null,
        canRetry: true,
        message: "Payment failed: retry with a fresh code",
      },
      operatorHint: "Operator hint: provider rejected the auth code",
    });
    getCurrentTransactionMock.mockResolvedValue(transaction);
    const checkoutStore = useCheckoutStore();
    checkoutStore.applyTransaction(transaction);

    const host = await mountView();

    expect(host.textContent).toContain("请重新出示付款码");
    expect(host.textContent).toContain("本次付款未完成");
    expect(host.textContent).not.toContain("Payment failed");
    expect(host.textContent).not.toContain("Operator hint");
  });

  it("shows projected payment-code blocked copy", async () => {
    const transaction = paymentCodeTransaction({
      paymentCodeAttempt: {
        attemptNo: 1,
        status: "failed",
        maskedAuthCode: "2876****4394",
        source: "serial_text",
        idempotencyKey: "ORD-CODE-STATE:attempt-1",
        submittedAt: "2026-06-11T06:16:30.000Z",
        lastCheckedAt: null,
        canRetry: false,
        message: "Provider returned a hard failure",
      },
    });
    getCurrentTransactionMock.mockResolvedValue(transaction);
    const checkoutStore = useCheckoutStore();
    checkoutStore.applyTransaction(transaction);

    const host = await mountView();

    expect(host.textContent).toContain("付款暂不可继续");
    expect(host.textContent).toContain("请返回商品列表后重新下单");
    expect(host.textContent).not.toContain("Provider returned");
  });

  it("does not render raw English sync errors to customers", async () => {
    getCurrentTransactionMock.mockRejectedValue(
      new Error("ZodError: Invalid option expected pending_payment"),
    );
    const checkoutStore = useCheckoutStore();
    checkoutStore.applyTransaction(activeQrPaymentTransaction());

    const host = await mountView();
    await flushPromises();

    expect(host.textContent).toContain("订单状态同步失败，请稍后重试");
    expect(host.textContent).not.toContain("ZodError");
    expect(host.textContent).not.toContain("Invalid option");
  });

  it("routes to catalog when the projected payment transaction is no longer active", async () => {
    getCurrentTransactionMock.mockResolvedValue({
      orderId: null,
      orderNo: null,
      productSummary: null,
      paymentNo: null,
      paymentMethod: null,
      paymentProvider: null,
      paymentUrl: null,
      paymentStatus: null,
      orderStatus: null,
      totalAmountCents: null,
      vending: null,
      nextAction: null,
      maskedAuthCode: null,
      paymentCodeAttempt: null,
      expiresAt: null,
      errorCode: null,
      errorMessage: null,
      operatorHint: null,
      updatedAt: "2026-06-11T06:16:33.000Z",
    });
    const checkoutStore = useCheckoutStore();
    checkoutStore.applyTransaction(activeQrPaymentTransaction());

    await mountView();
    await flushPromises();

    expect(routerReplaceMock).toHaveBeenCalledWith({ name: "catalog" });
  });
});
