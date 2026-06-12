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
  it("keeps a dispense failure result visible once the machine is sale-ready again", async () => {
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
    expect(host.textContent).not.toContain("返回首页");

    await vi.advanceTimersByTimeAsync(6000);

    expect(routerReplaceMock).not.toHaveBeenCalledWith("/catalog");
    expect(routerReplaceMock).not.toHaveBeenCalledWith("/maintenance");
    expect(getSaleViewMock).not.toHaveBeenCalled();
    expect(checkoutStore.shouldIgnoreTransaction(transaction)).toBe(false);
    expect(checkoutStore.currentOrder?.orderNo).toBe("ORD-FAILED-001");
    expect(checkoutStore.status?.nextAction).toBe("dispense_failed");
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
