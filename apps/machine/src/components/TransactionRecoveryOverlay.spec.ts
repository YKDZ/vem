// @vitest-environment jsdom
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick } from "vue";

const { getCurrentTransactionMock } = vi.hoisted(() => ({
  getCurrentTransactionMock: vi.fn(),
}));

vi.mock("@/daemon/client", () => ({
  daemonClient: {
    getCurrentTransaction: getCurrentTransactionMock,
  },
}));

import { useCheckoutStore } from "@/stores/checkout";

import TransactionRecoveryOverlay from "./TransactionRecoveryOverlay.vue";

function activePaymentTransaction() {
  return {
    orderId: "550e8400-e29b-41d4-a716-446655440012",
    orderNo: "ORD-RECOVERY-OVERLAY",
    productSummary: null,
    paymentId: "550e8400-e29b-41d4-a716-446655440013",
    paymentNo: "PAY-RECOVERY-OVERLAY",
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

describe("TransactionRecoveryOverlay", () => {
  beforeEach(() => {
    window.localStorage.clear();
    getCurrentTransactionMock.mockReset();
  });

  it("covers the last transaction surface while daemon IPC is recovering", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const checkoutStore = useCheckoutStore(pinia);
    checkoutStore.applyTransaction(activePaymentTransaction());
    getCurrentTransactionMock.mockRejectedValue(
      new Error("daemon IPC disconnected"),
    );
    const host = document.createElement("div");
    document.body.appendChild(host);
    const app = createApp(TransactionRecoveryOverlay);
    app.use(pinia);
    app.mount(host);

    await checkoutStore.refreshCurrentTransaction();
    await nextTick();

    expect(host.querySelector('[role="status"]')?.textContent).toContain(
      "正在恢复本次交易",
    );
    expect(host.textContent).toContain("ORD-RECOVERY-OVERLAY");
    app.unmount();
    host.remove();
  });
});
