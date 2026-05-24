import type { MachineOrderStatusNextAction } from "@vem/shared";

import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/api/machine-orders", () => ({
  createMachineOrder: vi.fn(),
  getMachineOrderStatus: vi.fn(),
  getMachinePaymentOptions: vi.fn(),
  submitPaymentCode: vi.fn(),
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
    optionKey: "mock:mock" as const,
    providerCode: "mock" as const,
    method: "mock" as const,
    displayName: "模拟支付",
    description: "本地开发模式，可使用模拟成功或失败按钮。",
    icon: "mock" as const,
    disabled: false,
    disabledReason: null,
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
      optionKey: "qr_code:alipay" as const,
      providerCode: "alipay" as const,
      method: "qr_code" as const,
      displayName: "支付宝",
      description: "请使用支付宝扫码支付",
      icon: "alipay" as const,
      disabled: false,
      disabledReason: null,
      recommended: true,
    };
  }

  function makeAlipayPaymentCodeOption() {
    return {
      optionKey: "payment_code:alipay" as const,
      providerCode: "alipay" as const,
      method: "payment_code" as const,
      displayName: "支付宝付款码",
      description: "请出示支付宝付款码",
      icon: "alipay" as const,
      disabled: false,
      disabledReason: null,
      recommended: false,
    };
  }

  function makeWechatOption() {
    return {
      optionKey: "qr_code:wechat_pay" as const,
      providerCode: "wechat_pay" as const,
      method: "qr_code" as const,
      displayName: "微信支付",
      description: "请使用微信扫码支付",
      icon: "wechat" as const,
      disabled: false,
      disabledReason: null,
      recommended: false,
    };
  }

  it("selects alipay by default when only alipay is available", () => {
    const options = [makeAlipayOption()];
    const defaultOptionKey = options[0]?.optionKey ?? null;
    expect(defaultOptionKey).toBe("qr_code:alipay");
  });

  it("allows switching between qr_code and payment_code for the same provider", () => {
    const options = [makeAlipayOption(), makeAlipayPaymentCodeOption()];
    let selected = options[0]?.optionKey ?? null;
    if (options.some((o) => o.optionKey === "payment_code:alipay")) {
      selected = "payment_code:alipay";
    }
    expect(selected).toBe("payment_code:alipay");
  });

  it("builds mock payload when mock option is selected", () => {
    const selected: {
      providerCode: "mock" | "alipay" | "wechat_pay";
      method: "mock" | "qr_code" | "payment_code";
    } = makeMockOption();
    const payload =
      selected.method === "mock"
        ? {
            paymentMethod: "mock" as const,
            paymentProviderCode: "mock" as const,
          }
        : {
            paymentMethod: selected.method,
            paymentProviderCode: selected.providerCode,
          };
    expect(payload).toEqual({
      paymentMethod: "mock",
      paymentProviderCode: "mock",
    });
  });

  it("builds qr_code + alipay payload when qr option is selected", () => {
    const selected: {
      providerCode: "mock" | "alipay" | "wechat_pay";
      method: "mock" | "qr_code" | "payment_code";
    } = makeAlipayOption();
    const payload =
      selected.method === "mock"
        ? {
            paymentMethod: "mock" as const,
            paymentProviderCode: "mock" as const,
          }
        : {
            paymentMethod: selected.method,
            paymentProviderCode: selected.providerCode,
          };
    expect(payload).toEqual({
      paymentMethod: "qr_code",
      paymentProviderCode: "alipay",
    });
  });

  it("builds payment_code + alipay payload when payment_code option is selected", () => {
    const selected: {
      providerCode: "mock" | "alipay" | "wechat_pay";
      method: "mock" | "qr_code" | "payment_code";
    } = makeAlipayPaymentCodeOption();
    const payload =
      selected.method === "mock"
        ? {
            paymentMethod: "mock" as const,
            paymentProviderCode: "mock" as const,
          }
        : {
            paymentMethod: selected.method,
            paymentProviderCode: selected.providerCode,
          };
    expect(payload).toEqual({
      paymentMethod: "payment_code",
      paymentProviderCode: "alipay",
    });
  });

  it("builds qr_code + wechat_pay payload when wechat option is selected", () => {
    const selected = makeWechatOption();
    expect({
      paymentMethod: selected.method,
      paymentProviderCode: selected.providerCode,
    }).toEqual({
      paymentMethod: "qr_code",
      paymentProviderCode: "wechat_pay",
    });
  });
});

describe("checkout Pinia store", () => {
  it("loads mock option as default and creates a mock order payload", async () => {
    vi.mocked(machineOrdersApi.getMachinePaymentOptions).mockResolvedValue({
      options: [makeMockOption()],
      defaultOptionKey: "mock:mock",
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

    expect(store.selectedPaymentOptionKey).toBe("mock:mock");
    expect(machineOrdersApi.createMachineOrder).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        machineCode: "M001",
        items: [
          { inventoryId: "550e8400-e29b-41d4-a716-446655440002", quantity: 1 },
        ],
        paymentMethod: "mock",
        paymentProviderCode: "mock",
      }),
    );
  });

  it("creates a payment_code order when payment_code option is selected", async () => {
    const qrOption = {
      optionKey: "qr_code:alipay" as const,
      providerCode: "alipay" as const,
      method: "qr_code" as const,
      displayName: "支付宝",
      description: "请使用支付宝扫码支付",
      icon: "alipay" as const,
      disabled: false,
      disabledReason: null,
      recommended: true,
    };
    const paymentCodeOption = {
      optionKey: "payment_code:alipay" as const,
      providerCode: "alipay" as const,
      method: "payment_code" as const,
      displayName: "支付宝付款码",
      description: "请出示支付宝付款码",
      icon: "alipay" as const,
      disabled: false,
      disabledReason: null,
      recommended: false,
    };
    vi.mocked(machineOrdersApi.getMachinePaymentOptions).mockResolvedValue({
      options: [qrOption, paymentCodeOption],
      defaultOptionKey: qrOption.optionKey,
      defaultProviderCode: qrOption.providerCode,
      serverTime: new Date().toISOString(),
    });
    vi.mocked(machineOrdersApi.createMachineOrder).mockResolvedValue({
      orderId: "550e8400-e29b-41d4-a716-446655440011",
      orderNo: "ORD_PAYCODE_001",
      paymentNo: "PAY_PAYCODE_001",
      paymentUrl: null,
      expiresAt: new Date("2026-05-24T10:15:00Z").toISOString(),
      totalAmountCents: 100,
      paymentProviderCode: "alipay",
    });

    const store = useCheckoutStore();
    const config = {
      ...machineConfigDefaults,
      machineCode: "M001",
      apiBaseUrl: "http://localhost:3000",
    };
    store.selectItem(makeCatalogItem());
    await store.loadPaymentOptions(config);
    store.selectPaymentOption("payment_code:alipay");
    await store.createOrder(config);

    expect(machineOrdersApi.createMachineOrder).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        paymentMethod: "payment_code",
        paymentProviderCode: "alipay",
      }),
    );
  });

  it("drops concurrent scanned payment code submissions while one is in flight", async () => {
    let resolveSubmit!: (value: {
      orderNo: string;
      paymentNo: string;
      attemptNo: number;
      status: "querying";
      nextAction: "wait_payment";
      message: string;
      canRetry: false;
      serverTime: string;
    }) => void;
    vi.mocked(machineOrdersApi.submitPaymentCode).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSubmit = resolve;
        }) as never,
    );

    const store = useCheckoutStore();
    store.currentOrder = {
      orderId: "550e8400-e29b-41d4-a716-446655440012",
      orderNo: "ORD_PAYCODE_002",
      paymentNo: "PAY_PAYCODE_002",
      paymentUrl: null,
      expiresAt: new Date("2026-05-24T10:15:00Z").toISOString(),
      totalAmountCents: 100,
      paymentProviderCode: "alipay",
    };
    const config = {
      ...machineConfigDefaults,
      machineCode: "M001",
      apiBaseUrl: "http://localhost:3000",
    };

    const first = store.submitScannedPaymentCode(
      config,
      "28763443825664394",
      "tauri_scanner",
    );
    const second = await store.submitScannedPaymentCode(
      config,
      "28763443825664395",
      "tauri_scanner",
    );

    resolveSubmit({
      orderNo: "ORD_PAYCODE_002",
      paymentNo: "PAY_PAYCODE_002",
      attemptNo: 1,
      status: "querying",
      nextAction: "wait_payment",
      message: "正在确认支付结果",
      canRetry: false,
      serverTime: new Date().toISOString(),
    });
    await first;

    expect(second).toBeNull();
    expect(machineOrdersApi.submitPaymentCode).toHaveBeenCalledTimes(1);
  });
});
