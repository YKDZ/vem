// @vitest-environment jsdom
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";

const {
  getCurrentTransactionMock,
  routerReplaceMock,
  submitMachineNavigationIntentMock,
} = vi.hoisted(() => ({
  getCurrentTransactionMock: vi.fn(),
  routerReplaceMock: vi.fn(),
  submitMachineNavigationIntentMock: vi.fn(),
}));

vi.mock("@/router/transaction-route-authority", () => ({
  installedMachineRuntimeTrace: () => null,
  submitMachineNavigationIntent: submitMachineNavigationIntentMock,
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
    paymentId: null,
    paymentNo: "PAY-DISPENSING-CUE-001",
    paymentMethod: "payment_code",
    paymentProvider: "alipay",
    paymentUrl: null,
    paymentStatus: "succeeded",
    orderStatus: "dispensing",
    totalAmountCents: 4900,
    vending: {
      commandId: null,
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
    paymentId: null,
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
  submitMachineNavigationIntentMock.mockImplementation(async (intent) => {
    if (intent.type === "transaction.projection") {
      const target = useCheckoutStore().customerCheckoutView.routeTarget;
      routerReplaceMock("path" in target ? target.path : target);
      return;
    }
    if ("target" in intent) routerReplaceMock(intent.target);
  });
  getCurrentTransactionMock.mockResolvedValue(dispensingTransaction());
});

afterEach(() => {
  mountedApp?.unmount();
  mountedApp = null;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("DispensingView", () => {
  it("describes pickup closure as reset in progress until terminal F2", async () => {
    const checkoutStore = useCheckoutStore();
    checkoutStore.invalidateCurrentTransaction = vi
      .fn()
      .mockResolvedValue(undefined) as never;
    checkoutStore.applyTransaction(
      dispensingTransaction({
        vending: {
          commandId: null,
          commandNo: "CMD-DISPENSING-CUE-001",
          status: "acknowledged",
          lastError: null,
          pickupReminder: {
            stage: "pickup_completed",
            level: "info",
            message: "raw F1",
            warningNo: null,
            reportedAt: "2026-06-29T09:00:03.000Z",
          },
        },
      }),
    );

    const host = await mountView();

    expect(host.textContent).toContain("已完成取货");
    expect(host.textContent).toContain("正在复位");
    expect(host.querySelector(".pickup-notice")).toBeNull();
    expect(host.textContent).not.toContain("出货成功");
    expect(host.textContent).not.toContain("出货完成");
  });

  it("projects manual handling without a page-owned route write", async () => {
    const checkoutStore = useCheckoutStore();
    checkoutStore.invalidateCurrentTransaction = vi
      .fn()
      .mockResolvedValue(undefined) as never;
    checkoutStore.applyTransaction({
      orderId: "550e8400-e29b-41d4-a716-446655440010",
      orderNo: "ORD-UNKNOWN-001",
      productSummary: null,
      paymentId: null,
      paymentNo: "PAY-UNKNOWN-001",
      paymentMethod: "payment_code",
      paymentProvider: "alipay",
      paymentUrl: null,
      paymentStatus: "succeeded",
      orderStatus: "manual_handling",
      totalAmountCents: 5900,
      vending: {
        commandId: null,
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

    expect(checkoutStore.customerCheckoutView).toMatchObject({
      stage: "result",
      result: { kind: "manual_handling" },
    });
  });

  it("projects result state through the shared checkout view", async () => {
    const checkoutStore = useCheckoutStore();
    checkoutStore.invalidateCurrentTransaction = vi
      .fn()
      .mockResolvedValue(undefined) as never;
    checkoutStore.transaction = {
      ...dispensingTransaction(),
      orderStatus: "manual_handling",
      nextAction: "manual_handling",
      vending: {
        commandId: null,
        commandNo: "CMD-UNKNOWN",
        status: "result_unknown",
        lastError: "dispense result unknown after daemon restart",
        pickupReminder: null,
      },
    };

    await mountView();

    expect(checkoutStore.customerCheckoutView).toMatchObject({
      stage: "result",
      result: { kind: "manual_handling" },
    });
  });

  it("invalidates the transaction projection without a page-owned route write", async () => {
    getCurrentTransactionMock.mockResolvedValue(awaitingPaymentTransaction());

    await mountView();

    expect(useCheckoutStore().customerCheckoutView.stage).toBe("payment");
  });

  it("keeps dispensing transaction on the dispensing page", async () => {
    const transaction = dispensingTransaction();
    getCurrentTransactionMock.mockResolvedValue(transaction);
    useCheckoutStore().applyTransaction(transaction);

    const host = await mountView();

    expect(host.querySelector('[data-test="dispensing-page"]')).toBeInstanceOf(
      HTMLElement,
    );
    expect(host.textContent).toContain("正在出货");
    expect(routerReplaceMock).not.toHaveBeenCalled();
  });

  it("warns against manual door opening while the outlet is still closed", async () => {
    const transaction = dispensingTransaction();
    getCurrentTransactionMock.mockResolvedValue(transaction);
    useCheckoutStore().applyTransaction(transaction);

    const host = await mountView();

    expect(host.textContent).toContain("请勿手动开门");
    expect(host.textContent).toContain("请勿手动开门，避免夹手");
    expect(host.textContent).not.toContain("取货门正在打开");
  });

  it("switches to the door-opening prompt on the outlet_opened stage", async () => {
    const transaction = dispensingTransaction({
      vending: {
        commandId: null,
        commandNo: "CMD-OUTLET-OPENED-001",
        status: "acknowledged",
        lastError: null,
        pickupReminder: {
          stage: "outlet_opened",
          level: "info",
          message: "raw F0",
          warningNo: null,
          reportedAt: "2026-06-29T09:00:01.000Z",
        },
      },
    });
    getCurrentTransactionMock.mockResolvedValue(transaction);
    useCheckoutStore().applyTransaction(transaction);

    const host = await mountView();

    expect(host.textContent).toContain("取货门正在打开");
    expect(host.textContent).toContain("请勿手动开门，避免夹手");
    expect(host.textContent).not.toContain("商品正在送往取货口");
  });

  it("prompts pickup once the outlet is fully open", async () => {
    const transaction = dispensingTransaction({
      vending: {
        commandId: null,
        commandNo: "CMD-PICKUP-WAITING-001",
        status: "acknowledged",
        lastError: null,
        pickupReminder: {
          stage: "pickup_waiting",
          level: "info",
          message: "raw AC heartbeat",
          warningNo: null,
          reportedAt: "2026-06-29T09:00:02.000Z",
        },
      },
    });
    getCurrentTransactionMock.mockResolvedValue(transaction);
    useCheckoutStore().applyTransaction(transaction);

    const host = await mountView();

    expect(host.textContent).toContain("请取走商品");
    expect(host.textContent).toContain("商品已在取货口");
    expect(host.textContent).toContain("超过 30 秒未取货，取货口将自动关闭。");
    expect(host.textContent).not.toContain("商品正在送往取货口");
    expect(host.textContent).not.toContain("出货完成后请取货");
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
        commandId: null,
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
    expect(host.textContent).toContain("设备将在数秒后自动关闭取货口。");
    await vi.waitFor(() => {
      expect(host.textContent).toContain("00:12");
    });
    expect(host.textContent).not.toContain("Pick up now");
  });

  it("shows customer-visible dispensing error from projection without raw daemon error", async () => {
    const transaction = dispensingTransaction({
      vending: {
        commandId: null,
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
    expect(host.textContent).toContain("本次出货未完成");
    expect(host.textContent).toContain("系统将自动发起原路退款");
    expect(host.textContent).toContain("退款说明");
    expect(host.textContent).toContain("如长时间未到账请联系现场工作人员");
    expect(host.textContent).not.toContain("出货完成后请取货");
    expect(host.textContent).toContain("订单凭证 ORD-DISPENSING-CUE-001");
    expect(host.textContent).not.toContain("lower controller");
    expect(host.textContent).not.toContain("COM5");
  });

  it("does not promise a refund while the dispense result is still unknown", async () => {
    const transaction = dispensingTransaction({
      vending: {
        commandId: null,
        commandNo: "CMD-DISPENSE-UNKNOWN-001",
        status: "result_unknown",
        lastError: "dispense result unknown after daemon restart",
        pickupReminder: null,
      },
    });
    getCurrentTransactionMock.mockResolvedValue(transaction);
    useCheckoutStore().applyTransaction(transaction);

    const host = await mountView();

    expect(host.textContent).toContain("出货结果待确认");
    expect(host.textContent).toContain("请在取货口确认是否有商品");
    expect(host.textContent).toContain(
      "如未取到商品，请凭订单凭证联系现场工作人员核对退款。",
    );
    expect(host.textContent).not.toContain("原路退款");
  });
});
