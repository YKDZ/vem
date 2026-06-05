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
});
