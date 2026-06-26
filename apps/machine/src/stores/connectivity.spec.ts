import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getHealthMock, getReadyMock, getSaleReadinessMock } = vi.hoisted(
  () => ({
    getHealthMock: vi.fn(),
    getReadyMock: vi.fn(),
    getSaleReadinessMock: vi.fn(),
  }),
);

vi.mock("@/daemon/client", () => ({
  daemonClient: {
    getHealth: getHealthMock,
    getReady: getReadyMock,
    getSaleReadiness: getSaleReadinessMock,
  },
}));

import { useConnectivityStore } from "./connectivity";

function healthSnapshot() {
  return {
    status: "healthy",
    process: {
      component: "process",
      level: "ok",
      code: "PROCESS_READY",
      message: "ready",
      updatedAt: "2026-06-04T00:00:00Z",
    },
    components: [],
    configConfigured: true,
    databaseOnline: true,
    backendOnline: true,
    mqttConnected: true,
    outboxSize: 0,
    outboxMax: 1000,
    hardwareOnline: true,
    scannerOnline: true,
    visionOnline: false,
    remoteOpsActive: false,
    currentTransaction: null,
    operatorReason: "",
    updatedAt: "2026-06-04T00:00:00Z",
  };
}

function readySnapshot() {
  return {
    ready: true,
    canSell: true,
    mode: "catalog",
    blockingCodes: [],
    blockingReasons: [],
    degradedReasons: [],
    suggestedRoute: "catalog",
    updatedAt: "2026-06-04T00:00:00Z",
  };
}

function saleReadiness(canStartNetworkAuthorizedSale: boolean) {
  return {
    canStartNetworkAuthorizedSale,
    blockingCodes: canStartNetworkAuthorizedSale
      ? []
      : ["PLATFORM_UNREACHABLE"],
    components: {
      platformReachability: {
        ready: canStartNetworkAuthorizedSale,
        code: canStartNetworkAuthorizedSale
          ? "PLATFORM_REACHABLE"
          : "PLATFORM_UNREACHABLE",
        message: canStartNetworkAuthorizedSale
          ? "platform reachable"
          : "platform offline",
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
        ready: true,
        code: "WHOLE_MACHINE_READY",
        message: "hardware ready",
      },
    },
  };
}

function scannerUnavailableWithQrReadySaleReadiness() {
  return {
    canStartNetworkAuthorizedSale: true,
    blockingCodes: [],
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
        methods: [
          {
            method: "qr_code",
            optionKey: "qr",
            providerCode: "alipay",
            ready: true,
          },
          {
            method: "payment_code",
            optionKey: "payment-code",
            providerCode: "alipay",
            ready: false,
            disabledReason: "扫码器不可用：scanner usb not found",
          },
        ],
      },
      scannerCapability: {
        ready: false,
        code: "SCANNER_UNAVAILABLE",
        message: "scanner usb not found",
      },
      syncHealth: {
        ready: true,
        code: "SYNC_READY",
        message: "sync connected",
      },
      wholeMachineBlockers: {
        ready: true,
        code: "WHOLE_MACHINE_READY",
        message: "hardware ready",
      },
      slotSaleSafety: {
        ready: true,
        code: "SLOT_SALE_SAFETY_READY",
        message: "slot sale safety ready",
        blockedSlots: [],
      },
    },
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
});

describe("connectivity sale readiness", () => {
  it("uses machine sale readiness as the sale network gate", async () => {
    getHealthMock.mockResolvedValue(healthSnapshot());
    getReadyMock.mockResolvedValue(readySnapshot());
    getSaleReadinessMock.mockResolvedValue(saleReadiness(false));

    const store = useConnectivityStore();
    await store.refresh();

    expect(getSaleReadinessMock).toHaveBeenCalledOnce();
    expect(store.saleReadiness?.canStartNetworkAuthorizedSale).toBe(false);
    expect(store.isSaleNetworkReady).toBe(false);
    expect(store.saleReadinessBlockingMessages).toEqual(["platform offline"]);
  });

  it("treats scanner outage as a visible payment-code degradation when qr payment remains ready", async () => {
    getHealthMock.mockResolvedValue({
      ...healthSnapshot(),
      scannerOnline: false,
      operatorReason: "SCANNER_USB_NOT_FOUND",
    });
    getReadyMock.mockResolvedValue(readySnapshot());
    getSaleReadinessMock.mockResolvedValue(
      scannerUnavailableWithQrReadySaleReadiness(),
    );

    const store = useConnectivityStore();
    await store.refresh();

    expect(store.isSaleNetworkReady).toBe(true);
    expect(store.saleReadinessBlockingMessages).toEqual([]);
    expect(store.saleReadinessDegradedMessages).toEqual([
      "扫码器不可用：scanner usb not found；付款码支付不可用，二维码支付仍可用。",
    ]);
  });

  it("surfaces production dispense path blockers from sale readiness", () => {
    const store = useConnectivityStore();
    store.applySaleReadiness({
      ...saleReadiness(false),
      blockingCodes: ["PRODUCTION_DISPENSE_PATH_MOCK"],
      components: {
        ...saleReadiness(false).components,
        platformReachability: {
          ready: true,
          code: "PLATFORM_REACHABLE",
          message: "platform reachable",
        },
        paymentOptions: {
          ready: true,
          code: "PAYMENT_OPTIONS_READY",
          message: "payment option available",
          methods: [],
        },
        productionDispensePath: {
          ready: false,
          code: "PRODUCTION_DISPENSE_PATH_MOCK",
          message: "生产出货路径不能使用 mock hardwareAdapter",
        },
      },
    });

    expect(store.saleReadinessBlockingMessages).toEqual([
      "生产出货路径不能使用 mock hardwareAdapter",
    ]);
  });
});
