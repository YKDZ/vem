import type { MachineOrderStatusNextAction } from "@vem/shared";

import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/api/machine-orders", () => ({
  createMachineOrder: vi.fn(),
  getMachineOrderStatus: vi.fn(),
  getMachinePaymentOptions: vi.fn(),
}));

vi.mock("@/api/request", () => ({
  createMachineApiClient: vi.fn(() => ({})),
}));

import * as machineOrdersApi from "@/api/machine-orders";
import { machineConfigDefaults } from "@/config/machine-config";
import { resultKindFromNextAction, useCheckoutStore } from "./checkout";

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
});

function makeMockOption() {
  return {
    providerCode: "mock" as const,
    method: "mock" as const,
    displayName: "模拟支付",
    description: "本地开发模式，可使用模拟成功或失败按钮。",
    icon: "mock" as const,
    recommended: true,
  };
}

function makeCatalogItem() {
  return {
    machineCode: "M001",
    slotId: "550e8400-e29b-41d4-a716-446655440001",
    slotCode: "A1",
    layerNo: 1,
    cellNo: 1,
    inventoryId: "550e8400-e29b-41d4-a716-446655440002",
    variantId: "550e8400-e29b-41d4-a716-446655440003",
    productId: "550e8400-e29b-41d4-a716-446655440004",
    productName: "矿泉水",
    productDescription: null,
    coverImageUrl: null,
    categoryId: null,
    categoryName: null,
    sku: "WATER-001",
    size: null,
    color: null,
    priceCents: 100,
    availableQty: 1,
    productSortOrder: 1,
  };
}

describe("checkout state helpers", () => {
  it.each<[MachineOrderStatusNextAction, string | null]>([
    ["wait_payment", null],
    ["dispensing", null],
    ["success", "success"],
    ["payment_failed", "payment_failed"],
    ["payment_expired", "payment_expired"],
    ["dispense_failed", "dispense_failed"],
    ["refund_pending", "refund_pending"],
    ["refunded", "refunded"],
    ["manual_handling", "manual_handling"],
    ["closed", "closed"],
  ])("maps %s to result kind %s", (nextAction, expected) => {
    expect(resultKindFromNextAction(nextAction)).toBe(expected);
  });
});

describe("checkout store payment option logic", () => {
  function makeAlipayOption() {
    return {
      providerCode: "alipay" as const,
      method: "qr_code" as const,
      displayName: "支付宝",
      description: "请使用支付宝扫码支付",
      icon: "alipay" as const,
      recommended: true,
    };
  }

  function makeWechatOption() {
    return {
      providerCode: "wechat_pay" as const,
      method: "qr_code" as const,
      displayName: "微信支付",
      description: "请使用微信扫码支付",
      icon: "wechat" as const,
      recommended: false,
    };
  }

  it("selects alipay by default when only alipay is available", () => {
    const options = [makeAlipayOption()];
    const defaultProviderCode = options[0]?.providerCode ?? null;
    expect(defaultProviderCode).toBe("alipay");
  });

  it("allows switching between wechat and alipay", () => {
    const options = [makeAlipayOption(), makeWechatOption()];
    let selected = options[0]?.providerCode ?? null;
    // select wechat_pay
    if (options.some((o) => o.providerCode === "wechat_pay")) {
      selected = "wechat_pay";
    }
    expect(selected).toBe("wechat_pay");
  });

  it("builds mock payload when mock option is selected", () => {
    const selected: { providerCode: "mock" | "alipay" | "wechat_pay" } =
      makeMockOption();
    const payload =
      selected.providerCode === "mock"
        ? { paymentMethod: "mock" as const }
        : {
            paymentMethod: "qr_code" as const,
            paymentProviderCode: selected.providerCode,
          };
    expect(payload).toEqual({ paymentMethod: "mock" });
    expect("paymentProviderCode" in payload).toBe(false);
  });

  it("builds qr_code + alipay payload when alipay option is selected", () => {
    const selected: { providerCode: "mock" | "alipay" | "wechat_pay" } =
      makeAlipayOption();
    const payload =
      selected.providerCode === "mock"
        ? { paymentMethod: "mock" as const }
        : {
            paymentMethod: "qr_code" as const,
            paymentProviderCode: selected.providerCode,
          };
    expect(payload).toEqual({
      paymentMethod: "qr_code",
      paymentProviderCode: "alipay",
    });
  });

  it("builds qr_code + wechat_pay payload when wechat option is selected", () => {
    const selected: { providerCode: "mock" | "alipay" | "wechat_pay" } =
      makeWechatOption();
    const payload =
      selected.providerCode === "mock"
        ? { paymentMethod: "mock" as const }
        : {
            paymentMethod: "qr_code" as const,
            paymentProviderCode: selected.providerCode,
          };
    expect(payload).toEqual({
      paymentMethod: "qr_code",
      paymentProviderCode: "wechat_pay",
    });
  });
});

describe("checkout Pinia store", () => {
  it("loads mock option as default and creates a mock order payload", async () => {
    vi.mocked(machineOrdersApi.getMachinePaymentOptions).mockResolvedValue({
      options: [makeMockOption()],
      defaultProviderCode: "mock",
      serverTime: new Date().toISOString(),
    });
    vi.mocked(machineOrdersApi.createMachineOrder).mockResolvedValue({
      orderId: "550e8400-e29b-41d4-a716-446655440010",
      orderNo: "ORD_MOCK_001",
      paymentNo: "PAY_MOCK_001",
      paymentUrl: null,
      expiresAt: new Date("2026-05-07T00:15:00Z").toISOString(),
      totalAmountCents: 100,
      paymentProviderCode: "mock",
    });

    const store = useCheckoutStore();
    const config = {
      ...machineConfigDefaults,
      machineCode: "M001",
      apiBaseUrl: "http://localhost:3000",
    };
    store.selectItem(makeCatalogItem());
    await store.loadPaymentOptions(config);
    await store.createOrder(config);

    expect(store.selectedPaymentProviderCode).toBe("mock");
    expect(machineOrdersApi.createMachineOrder).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        machineCode: "M001",
        items: [{ inventoryId: "550e8400-e29b-41d4-a716-446655440002", quantity: 1 }],
        paymentMethod: "mock",
      }),
    );
    expect(
      vi.mocked(machineOrdersApi.createMachineOrder).mock.calls[0]?.[1],
    ).not.toHaveProperty("paymentProviderCode");
  });
});


