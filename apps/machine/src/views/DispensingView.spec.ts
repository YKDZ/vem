// @vitest-environment jsdom
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, type App } from "vue";

const { routerReplaceMock } = vi.hoisted(() => ({
  routerReplaceMock: vi.fn(),
}));

vi.mock("vue-router", () => ({
  useRouter: () => ({ replace: routerReplaceMock }),
}));

vi.mock("@/layouts/KioskLayout.vue", () => ({
  default: { template: "<main><slot /></main>" },
}));

import { useCheckoutStore } from "@/stores/checkout";

import DispensingView from "./DispensingView.vue";

let mountedApp: App<Element> | null = null;
let pinia: ReturnType<typeof createPinia>;

function mountDispensingView(): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  mountedApp = createApp(DispensingView);
  mountedApp.use(pinia);
  mountedApp.mount(host);
  return host;
}

describe("DispensingView", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    mountedApp?.unmount();
    mountedApp = null;
    routerReplaceMock.mockReset();
    pinia = createPinia();
    setActivePinia(pinia);
  });

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

    mountDispensingView();

    await vi.waitFor(() => {
      expect(routerReplaceMock).toHaveBeenCalledWith({
        name: "result",
        params: { kind: "manual_handling" },
      });
    });
  });
});
