// @vitest-environment jsdom

import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";

import type { MachineSaleReadiness } from "@/daemon/schemas";

import { useConnectivityStore } from "@/stores/connectivity";

import { useCatalogNotifications } from "./useCatalogNotifications";

function component(ready: boolean, code: string, message: string) {
  return { ready, code, message };
}

function healthComponent(code: string, message: string) {
  return {
    component: "daemon",
    level: "ok",
    code,
    message,
    updatedAt: "2026-07-03T00:00:00.000Z",
  };
}

function saleReadiness(
  overrides: Partial<MachineSaleReadiness> = {},
): MachineSaleReadiness {
  return {
    canStartNetworkAuthorizedSale: true,
    blockingCodes: [],
    components: {
      platformReachability: component(true, "PLATFORM_REACHABLE", "online"),
      machineAuthentication: component(
        true,
        "MACHINE_AUTH_READY",
        "machine auth ready",
      ),
      activePlanogram: component(true, "PLANOGRAM_READY", "PLAN-1"),
      paymentOptions: {
        ...component(true, "PAYMENT_OPTIONS_READY", "payment ready"),
        methods: [
          {
            method: "qr_code",
            optionKey: "alipay_qr",
            providerCode: "alipay",
            ready: true,
          },
        ],
      },
      scannerCapability: component(true, "SCANNER_READY", "scanner ready"),
      syncHealth: component(true, "SYNC_READY", "sync ready"),
      wholeMachineBlockers: component(
        true,
        "WHOLE_MACHINE_READY",
        "whole machine ready",
      ),
      productionDispensePath: component(
        true,
        "PRODUCTION_DISPENSE_PATH_READY",
        "production path ready",
      ),
      slotSaleSafety: {
        ...component(true, "SLOT_SALE_SAFETY_READY", "slots ready"),
        blockedSlots: [],
      },
    },
    ...overrides,
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("useCatalogNotifications", () => {
  it("maps production dispense path diagnostics to a customer-safe notification", () => {
    const store = useConnectivityStore();
    store.applyReady({
      ready: true,
      canSell: true,
      mode: "sale",
      blockingCodes: [],
      blockingReasons: [],
      degradedReasons: [],
      suggestedRoute: "catalog",
      updatedAt: "2026-07-03T00:00:00.000Z",
    });
    store.applyHealth({
      status: "degraded",
      process: healthComponent("DAEMON_ALIVE", "daemon ready"),
      components: [],
      configConfigured: true,
      databaseOnline: true,
      backendOnline: true,
      mqttConnected: true,
      outboxSize: 0,
      outboxMax: 500,
      hardwareOnline: true,
      scannerOnline: false,
      visionOnline: true,
      remoteOpsActive: false,
      currentTransaction: null,
      operatorReason: "PRODUCTION_DISPENSE_PATH_MOCK",
      updatedAt: "2026-07-03T00:00:00.000Z",
    });
    store.applySaleReadiness(
      saleReadiness({
        canStartNetworkAuthorizedSale: false,
        blockingCodes: ["PRODUCTION_DISPENSE_PATH_MOCK"],
        components: {
          ...saleReadiness().components,
          productionDispensePath: component(
            false,
            "PRODUCTION_DISPENSE_PATH_MOCK",
            "生产出货路径不能使用 mock hardwareAdapter",
          ),
        },
      }),
    );

    const { primaryNotification } = useCatalogNotifications();

    expect(primaryNotification.value).toEqual({
      id: "PRODUCTION_DISPENSE_PATH_MOCK",
      message: "设备正在维护中，请联系工作人员。",
      tone: "warning",
    });
  });

  it("maps platform blockers to a network notification", () => {
    const store = useConnectivityStore();
    store.applySaleReadiness(
      saleReadiness({
        canStartNetworkAuthorizedSale: false,
        blockingCodes: ["PLATFORM_UNREACHABLE"],
        components: {
          ...saleReadiness().components,
          platformReachability: component(
            false,
            "PLATFORM_UNREACHABLE",
            "platform offline",
          ),
        },
      }),
    );

    const { primaryNotification } = useCatalogNotifications();

    expect(primaryNotification.value?.message).toBe(
      "网络连接暂时不可用，请稍后再试。",
    );
  });

  it("uses the same notification path for payment-code degradation", () => {
    const store = useConnectivityStore();
    store.applyReady({
      ready: true,
      canSell: true,
      mode: "sale",
      blockingCodes: [],
      blockingReasons: [],
      degradedReasons: [],
      suggestedRoute: "catalog",
      updatedAt: "2026-07-03T00:00:00.000Z",
    });
    store.applyHealth({
      status: "healthy",
      process: healthComponent("DAEMON_ALIVE", "daemon ready"),
      components: [],
      configConfigured: true,
      databaseOnline: true,
      backendOnline: true,
      mqttConnected: true,
      outboxSize: 0,
      outboxMax: 500,
      hardwareOnline: true,
      scannerOnline: false,
      visionOnline: true,
      remoteOpsActive: false,
      currentTransaction: null,
      operatorReason: "SCANNER_USB_NOT_FOUND",
      updatedAt: "2026-07-03T00:00:00.000Z",
    });
    store.applySaleReadiness(
      saleReadiness({
        components: {
          ...saleReadiness().components,
          paymentOptions: {
            ...component(true, "PAYMENT_OPTIONS_READY", "payment ready"),
            methods: [
              {
                method: "qr_code",
                optionKey: "alipay_qr",
                providerCode: "alipay",
                ready: true,
              },
              {
                method: "payment_code",
                optionKey: "alipay_code",
                providerCode: "alipay",
                ready: false,
                disabledReason: "scanner usb not found",
              },
            ],
          },
          scannerCapability: component(
            false,
            "SCANNER_USB_NOT_FOUND",
            "scanner usb not found",
          ),
        },
      }),
    );

    const { primaryNotification } = useCatalogNotifications();

    expect(primaryNotification.value).toEqual({
      id: "sale-readiness-degraded",
      message: "付款码支付暂不可用，可继续使用二维码支付。",
      tone: "info",
    });
  });
});
