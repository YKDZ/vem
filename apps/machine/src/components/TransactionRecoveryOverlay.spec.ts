// @vitest-environment jsdom
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, h, nextTick } from "vue";

const { getCurrentTransactionMock } = vi.hoisted(() => ({
  getCurrentTransactionMock: vi.fn(),
}));

vi.mock("@/daemon/client", () => ({
  daemonClient: {
    getCurrentTransaction: getCurrentTransactionMock,
  },
}));

import { useCheckoutStore } from "@/stores/checkout";

import TransactionRecoveryBoundary from "./TransactionRecoveryBoundary.vue";
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

    const dialog = host.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog?.textContent).toContain("正在恢复本次交易");
    expect(host.textContent).toContain("ORD-RECOVERY-OVERLAY");
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    expect(dialog?.getAttribute("aria-labelledby")).toBe(
      "transaction-recovery-title",
    );
    expect(document.activeElement).toBe(dialog);
    const tab = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });
    dialog?.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(dialog);
    app.unmount();
    host.remove();
  });

  it("makes the underlying transaction surface inert and hidden from assistive navigation", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const checkoutStore = useCheckoutStore(pinia);
    checkoutStore.applyTransaction(activePaymentTransaction());
    getCurrentTransactionMock.mockRejectedValue(
      new Error("daemon IPC disconnected"),
    );
    const host = document.createElement("div");
    document.body.appendChild(host);
    const app = createApp({
      render: () =>
        h(TransactionRecoveryBoundary, null, {
          default: () => h("button", { id: "underlying-action" }, "取消订单"),
        }),
    });
    app.use(pinia);
    app.mount(host);

    await checkoutStore.refreshCurrentTransaction();
    await nextTick();

    const surface = host.querySelector<HTMLElement>(
      '[data-test="transaction-surface"]',
    );
    expect(surface?.hasAttribute("inert")).toBe(true);
    expect(surface?.getAttribute("aria-hidden")).toBe("true");
    expect(document.activeElement).toBe(host.querySelector('[role="dialog"]'));

    getCurrentTransactionMock.mockResolvedValue(activePaymentTransaction());
    await checkoutStore.refreshCurrentTransaction();
    await nextTick();

    expect(surface?.hasAttribute("inert")).toBe(false);
    expect(surface?.hasAttribute("aria-hidden")).toBe(false);
    app.unmount();
    host.remove();
  });
});
