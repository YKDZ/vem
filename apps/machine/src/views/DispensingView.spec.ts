// @vitest-environment jsdom
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";

const {
  getCurrentTransactionMock,
  requestDispensingStartedCueMock,
  routerReplaceMock,
} = vi.hoisted(() => ({
  getCurrentTransactionMock: vi.fn(),
  requestDispensingStartedCueMock: vi.fn(),
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

vi.mock("@/composables/useTransactionFeedbackCues", () => ({
  requestDispensingStartedCue: requestDispensingStartedCueMock,
}));

import { useCheckoutStore } from "@/stores/checkout";

import DispensingView from "./DispensingView.vue";

let mountedApp: App<Element> | null = null;
let pinia: ReturnType<typeof createPinia>;

function dispensingTransaction() {
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
  };
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

  it("requests dispensing-start transaction feedback for the active order", async () => {
    const transaction = dispensingTransaction();
    getCurrentTransactionMock.mockResolvedValue(transaction);
    useCheckoutStore().applyTransaction(transaction);

    const host = await mountView();

    expect(host.textContent).toContain("正在出货");
    expect(requestDispensingStartedCueMock).toHaveBeenCalledWith(transaction);
    expect(routerReplaceMock).not.toHaveBeenCalled();
  });
});
