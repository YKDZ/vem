// @vitest-environment jsdom

import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";

import { useSaleCapabilityStore } from "@/stores/sale-capability";
import { applySaleCapability } from "@/test-support/sale-capability";

import { useCatalogNotifications } from "./useCatalogNotifications";

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("useCatalogNotifications", () => {
  it("shows an updating diagnostic until a capability has been accepted", () => {
    const { primaryNotification } = useCatalogNotifications();

    expect(primaryNotification.value).toEqual({
      id: "sale-capability-updating",
      message: "正在确认当前购买状态，请稍候。",
      tone: "info",
    });
  });

  it("maps production dispense blockers to a customer-safe notification", () => {
    applySaleCapability({
      canStartSale: false,
      blockerCode: "PRODUCTION_DISPENSE_PATH_MOCK",
    });

    const { primaryNotification } = useCatalogNotifications();

    expect(primaryNotification.value).toEqual({
      id: "PRODUCTION_DISPENSE_PATH_MOCK",
      message: "设备正在维护中，请联系工作人员。",
      tone: "warning",
    });
  });

  it("maps platform blockers to a network notification", () => {
    applySaleCapability({
      canStartSale: false,
      blockerCode: "PLATFORM_UNREACHABLE",
    });

    const { primaryNotification } = useCatalogNotifications();

    expect(primaryNotification.value?.message).toBe(
      "网络连接暂时不可用，请稍后再试。",
    );
  });

  it("keeps an accepted capability available while refresh diagnostics are stale", () => {
    applySaleCapability();
    useSaleCapabilityStore().markStale(new Error("temporary disconnect"));

    const { primaryNotification } = useCatalogNotifications();

    expect(useSaleCapabilityStore().canStartSale).toBe(true);
    expect(primaryNotification.value).toEqual({
      id: "sale-capability-refreshing",
      message: "购买状态正在更新，仍可继续选购。",
      tone: "info",
    });
  });

  it("prioritizes refresh state over an accepted stale blocker", () => {
    applySaleCapability({
      canStartSale: false,
      blockerCode: "NO_SALEABLE_SLOTS",
    });
    useSaleCapabilityStore().markStale(new Error("daemon reconnecting"));

    const { primaryNotification } = useCatalogNotifications();

    expect(primaryNotification.value).toEqual({
      id: "sale-capability-refreshing",
      message: "购买状态正在更新，仍可继续选购。",
      tone: "info",
    });
  });

  it("uses the capability degradation path for payment-code diagnostics", () => {
    applySaleCapability({
      degradationCode: "SCANNER_USB_NOT_FOUND",
      degradationMessage: "付款码支付不可用，二维码支付仍可用",
      paymentCodeReady: false,
    });

    const { primaryNotification } = useCatalogNotifications();

    expect(primaryNotification.value).toEqual({
      id: "sale-capability-degraded",
      message: "付款码支付暂不可用，可继续使用二维码支付。",
      tone: "info",
    });
  });
});
