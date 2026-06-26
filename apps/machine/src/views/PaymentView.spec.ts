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
    getCurrentTransaction: getCurrentTransactionMock,
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

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-06-11T06:16:32.320Z"));
  vi.clearAllMocks();
  getCurrentTransactionMock.mockResolvedValue(expiredQrConfirmingTransaction());
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
});
