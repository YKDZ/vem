// @vitest-environment jsdom
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";

const { getCurrentTransactionMock, routerReplaceMock } = vi.hoisted(() => ({
  getCurrentTransactionMock: vi.fn(),
  routerReplaceMock: vi.fn(),
}));

vi.mock("vue-router", () => ({
  useRouter: () => ({ replace: routerReplaceMock }),
}));

vi.mock("@/layouts/KioskLayout.vue", () => ({
  default: { template: "<main><slot /></main>" },
}));

vi.mock("@/daemon/client", () => ({
  daemonClient: {
    getCurrentTransaction: getCurrentTransactionMock,
  },
}));

import type { TransactionSnapshot } from "@/daemon/schemas";

import { useCheckoutStore } from "@/stores/checkout";

import DispensingView from "./DispensingView.vue";

let mountedApp: App<Element> | null = null;
let pinia: ReturnType<typeof createPinia>;

function dispensingTransaction(
  overrides: Partial<TransactionSnapshot> = {},
): TransactionSnapshot {
  return {
    orderId: "550e8400-e29b-41d4-a716-446655440010",
    orderNo: "ORD-DISPENSING-CUE-001",
    productSummary: null,
    paymentNo: "PAY-DISPENSING-CUE-001",
    paymentMethod: "payment_code",
    paymentProvider: "alipay",
    paymentUrl: null,
    paymentStatus: "succeeded",
    orderStatus: "dispensing",
    totalAmountCents: 4900,
    vending: {
      commandNo: "CMD-DISPENSING-CUE-001",
      status: "sent",
      lastError: null,
    },
    nextAction: "dispensing",
    maskedAuthCode: null,
    paymentCodeAttempt: null,
    expiresAt: "2026-06-29T09:00:00.000Z",
    errorCode: null,
    errorMessage: null,
    operatorHint: null,
    updatedAt: "2026-06-29T09:00:02.000Z",
    ...overrides,
  } as TransactionSnapshot;
}

function awaitingPaymentTransaction(
  overrides: Partial<TransactionSnapshot> = {},
): TransactionSnapshot {
  return {
    orderId: "550e8400-e29b-41d4-a716-446655440020",
    orderNo: "ORD-PAYMENT-RECOVERY-001",
    productSummary: null,
    paymentNo: "PAY-PAYMENT-RECOVERY-001",
    paymentMethod: "payment_code",
    paymentProvider: "alipay",
    paymentUrl: null,
    paymentStatus: "pending",
    orderStatus: "pending_payment",
    totalAmountCents: 4900,
    vending: null,
    nextAction: "wait_payment",
    maskedAuthCode: null,
    paymentCodeAttempt: null,
    expiresAt: "2026-06-29T09:00:00.000Z",
    errorCode: null,
    errorMessage: null,
    operatorHint: null,
    updatedAt: "2026-06-29T09:00:02.000Z",
    ...overrides,
  } as TransactionSnapshot;
}

async function mountView(): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  mountedApp = createApp(DispensingView);
  mountedApp.use(pinia);
  mountedApp.mount(host);
  await nextTick();
  await Promise.resolve();
  await nextTick();
  return host;
}

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  vi.useFakeTimers();
  vi.clearAllMocks();
  getCurrentTransactionMock.mockResolvedValue(dispensingTransaction());
});

afterEach(() => {
  mountedApp?.unmount();
  mountedApp = null;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("DispensingView", () => {
  it("routes manual handling transaction status to ResultView", async () => {
    const checkoutStore = useCheckoutStore();
    checkoutStore.refreshCurrentTransaction = vi
      .fn()
      .mockResolvedValue(undefined) as never;
    checkoutStore.applyTransaction({
      orderId: "550e8400-e29b-41d4-a716-446655440010",
      orderNo: "ORD-UNKNOWN-001",
      productSummary: null,
      paymentNo: "PAY-UNKNOWN-001",
      paymentMethod: "payment_code",
      paymentProvider: "alipay",
      paymentUrl: null,
      paymentStatus: "succeeded",
      orderStatus: "manual_handling",
      totalAmountCents: 5900,
      vending: {
        commandNo: "CMD-UNKNOWN",
        status: "result_unknown",
        lastError: "dispense result unknown after daemon restart",
      },
      nextAction: "manual_handling",
      maskedAuthCode: null,
      paymentCodeAttempt: null,
      expiresAt: "2026-06-26T07:10:00.000Z",
      errorCode: null,
      errorMessage: null,
      operatorHint: null,
      updatedAt: "2026-06-26T07:05:00.000Z",
    });

    await mountView();

    await vi.waitFor(() => {
      expect(routerReplaceMock).toHaveBeenCalledWith({
        name: "result",
        params: { kind: "manual_handling" },
      });
    });
  });

  it("routes to result through the projected route target without legacy status", async () => {
    const checkoutStore = useCheckoutStore();
    checkoutStore.refreshCurrentTransaction = vi
      .fn()
      .mockResolvedValue(undefined) as never;
    checkoutStore.transaction = {
      ...dispensingTransaction(),
      orderStatus: "manual_handling",
      nextAction: "manual_handling",
      vending: {
        commandNo: "CMD-UNKNOWN",
        status: "result_unknown",
        lastError: "dispense result unknown after daemon restart",
        pickupReminder: null,
      },
    };

    await mountView();

    await vi.waitFor(() => {
      expect(routerReplaceMock).toHaveBeenCalledWith({
        name: "result",
        params: { kind: "manual_handling" },
      });
    });
  });

  it("routes back to payment through the projected route target", async () => {
    getCurrentTransactionMock.mockResolvedValue(awaitingPaymentTransaction());

    await mountView();

    await vi.waitFor(() => {
      expect(routerReplaceMock).toHaveBeenCalledWith({ name: "payment" });
    });
  });

  it("keeps dispensing transaction on the dispensing page", async () => {
    const transaction = dispensingTransaction();
    getCurrentTransactionMock.mockResolvedValue(transaction);
    useCheckoutStore().applyTransaction(transaction);

    const host = await mountView();

    expect(host.textContent).toContain("正在出货");
    expect(routerReplaceMock).not.toHaveBeenCalled();
  });

  it("shows dispensing state from the customer checkout view without legacy order state", async () => {
    const transaction = dispensingTransaction();
    getCurrentTransactionMock.mockResolvedValue(transaction);
    const checkoutStore = useCheckoutStore();
    checkoutStore.transaction = transaction;

    const host = await mountView();

    expect(host.textContent).toContain("正在出货");
    expect(host.textContent).toContain("订单凭证 ORD-DISPENSING-CUE-001");
    expect(host.textContent).not.toContain("取货状态已失效");
  });

  it("shows projected pickup reminder urgency and countdown without raw reminder message", async () => {
    const transaction = dispensingTransaction({
      vending: {
        commandNo: "CMD-PICKUP-WARNING-001",
        status: "succeeded",
        lastError: null,
        pickupReminder: {
          stage: "pickup_timeout_warning",
          level: "urgent",
          message: "Pick up now or the outlet closes",
          warningNo: 2,
          reportedAt: "2026-06-29T09:00:06.000Z",
          remainingSeconds: 12,
        },
      },
    });
    getCurrentTransactionMock.mockResolvedValue(transaction);
    const checkoutStore = useCheckoutStore();
    checkoutStore.transaction = transaction;

    const host = await mountView();

    expect(host.textContent).toContain("请立即取走商品");
    expect(host.textContent).toContain("取货口即将关闭");
    await vi.waitFor(() => {
      expect(host.textContent).toContain("00:12");
    });
    expect(host.textContent).not.toContain("Pick up now");
  });

  it("shows customer-visible dispensing error from projection without raw daemon error", async () => {
    const transaction = dispensingTransaction({
      vending: {
        commandNo: "CMD-DISPENSE-FAILED-001",
        status: "failed",
        lastError: "lower controller reported motor jam on COM5",
        pickupReminder: null,
      },
    });
    getCurrentTransactionMock.mockResolvedValue(transaction);
    const checkoutStore = useCheckoutStore();
    checkoutStore.transaction = transaction;

    const host = await mountView();

    expect(host.textContent).toContain("出货异常");
    expect(host.textContent).toContain("请联系工作人员处理");
    expect(host.textContent).toContain("订单凭证 ORD-DISPENSING-CUE-001");
    expect(host.textContent).not.toContain("lower controller");
    expect(host.textContent).not.toContain("COM5");
  });
});
