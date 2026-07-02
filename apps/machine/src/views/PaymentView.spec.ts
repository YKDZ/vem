// @vitest-environment jsdom
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";

const {
  cancelOrderMock,
  getCurrentTransactionMock,
  getSaleViewMock,
  routerReplaceMock,
} = vi.hoisted(() => ({
  cancelOrderMock: vi.fn(),
  getCurrentTransactionMock: vi.fn(),
  getSaleViewMock: vi.fn(),
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
  },
}));

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
});
