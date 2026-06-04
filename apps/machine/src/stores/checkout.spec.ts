import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getPaymentOptionsMock,
  createOrderMock,
  getCurrentTransactionMock,
  submitDevPaymentCodeMock,
  markMockPaymentMock,
} = vi.hoisted(() => ({
  getPaymentOptionsMock: vi.fn(),
  createOrderMock: vi.fn(),
  getCurrentTransactionMock: vi.fn(),
  submitDevPaymentCodeMock: vi.fn(),
  markMockPaymentMock: vi.fn(),
}));

vi.mock("@/daemon/client", () => ({
  daemonClient: {
    currentConnection: { mock: true },
    getPaymentOptions: getPaymentOptionsMock,
    createOrder: createOrderMock,
    getCurrentTransaction: getCurrentTransactionMock,
    submitDevPaymentCode: submitDevPaymentCodeMock,
    markMockPayment: markMockPaymentMock,
  },
}));

import type { MachineCatalogItem } from "@/types/catalog";

import { useCatalogStore } from "./catalog";
import {
  normalizeNextAction,
  resultKindFromNextAction,
  useCheckoutStore,
} from "./checkout";
import { useConnectivityStore } from "./connectivity";

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
});

function makeCatalogItem(
  overrides: Partial<MachineCatalogItem> = {},
): MachineCatalogItem {
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
    capacity: 8,
    parLevel: 6,
    physicalStock: 1,
    saleableStock: 1,
    slotSalesState: "sale_ready",
    productSortOrder: 1,
    targetGender: null,
    ...overrides,
  };
}

function makeTransactionSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    orderId: "550e8400-e29b-41d4-a716-446655440010",
    orderNo: "ORD-001",
    productSummary: null,
    paymentNo: "PAY-001",
    paymentMethod: "payment_code",
    paymentProvider: "alipay",
    paymentUrl: "https://pay.example/1",
    paymentStatus: "pending",
    orderStatus: "pending_payment",
    totalAmountCents: 100,
    vending: {
      commandNo: "CMD-001",
      status: "created",
      lastError: null,
    },
    nextAction: "wait_payment",
    maskedAuthCode: "6212****9012",
    paymentCodeAttempt: {
      attemptNo: 2,
      status: "failed",
      maskedAuthCode: "6212****9012",
      source: "serial_text",
      idempotencyKey: "ORD-001:attempt-2",
      submittedAt: null,
      lastCheckedAt: null,
      canRetry: true,
      message: "请刷新付款码后重试",
    },
    expiresAt: "2026-01-01T00:05:00Z",
    errorCode: null,
    errorMessage: null,
    operatorHint: "等待用户出示付款码",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("checkout helpers", () => {
  it("normalizes unknown next action to wait_payment", () => {
    expect(normalizeNextAction("weird")).toBe("wait_payment");
  });

  it("maps result next actions", () => {
    expect(resultKindFromNextAction("success")).toBe("success");
    expect(resultKindFromNextAction("wait_payment")).toBeNull();
  });
});

describe("checkout store", () => {
  it("loads payment options from daemon client", async () => {
    getPaymentOptionsMock.mockResolvedValue({
      options: [
        {
          optionKey: "payment_code:alipay",
          providerCode: "alipay",
          method: "payment_code",
          displayName: "支付宝付款码",
          description: "请出示付款码",
          icon: "alipay",
          disabled: false,
          disabledReason: null,
          recommended: true,
        },
      ],
      defaultOptionKey: "payment_code:alipay",
      defaultProviderCode: "alipay",
      serverTime: "2026-01-01T00:00:00Z",
    });

    const store = useCheckoutStore();
    await store.loadPaymentOptions();

    expect(store.selectedPaymentOptionKey).toBe("payment_code:alipay");
    expect(getPaymentOptionsMock).toHaveBeenCalledOnce();
  });

  it("reports no payment options without creating an order", async () => {
    getPaymentOptionsMock.mockResolvedValue({
      options: [],
      defaultOptionKey: null,
      defaultProviderCode: null,
      serverTime: "2026-01-01T00:00:00Z",
    });

    const store = useCheckoutStore();
    await store.loadPaymentOptions();

    expect(store.paymentOptionsLoaded).toBe(true);
    expect(store.selectedPaymentOptionKey).toBeNull();
    expect(store.canCreateOrder).toBe(false);
    expect(store.error).toBe("当前机器暂无可用支付方式");
    expect(createOrderMock).not.toHaveBeenCalled();
  });

  it("creates order without machineCode payload and applies transaction", async () => {
    createOrderMock.mockResolvedValue(makeTransactionSnapshot());

    const store = useCheckoutStore();
    store.paymentOptions = [
      {
        optionKey: "payment_code:alipay",
        providerCode: "alipay",
        method: "payment_code",
        displayName: "支付宝付款码",
        description: "请出示付款码",
        icon: "alipay",
        disabled: false,
        disabledReason: null,
        recommended: true,
      },
    ];
    store.selectedPaymentOptionKey = "payment_code:alipay";
    store.selectItem(makeCatalogItem());

    await store.createOrder();

    expect(createOrderMock).toHaveBeenCalledWith({
      inventoryId: "550e8400-e29b-41d4-a716-446655440002",
      quantity: 1,
      paymentMethod: "payment_code",
      paymentProviderCode: "alipay",
      profileSnapshot: null,
    });
    expect(store.currentOrder?.paymentUrl).toBe("https://pay.example/1");
    expect(store.status?.payment.method).toBe("payment_code");
    expect(store.status?.vending?.commandNo).toBe("CMD-001");
    expect(store.status?.paymentCodeAttempt?.source).toBe("serial_text");
    expect(store.paymentCodeMessage).toBe("请刷新付款码后重试");
  });

  it("blocks stale selected item when latest sale view is sold out", async () => {
    const store = useCheckoutStore();
    const catalogStore = useCatalogStore();
    store.paymentOptions = [
      {
        optionKey: "payment_code:alipay",
        providerCode: "alipay",
        method: "payment_code",
        displayName: "支付宝付款码",
        description: "请出示付款码",
        icon: "alipay",
        disabled: false,
        disabledReason: null,
        recommended: true,
      },
    ];
    store.selectedPaymentOptionKey = "payment_code:alipay";
    store.selectItem(
      makeCatalogItem({ saleableStock: 1, slotSalesState: "sale_ready" }),
    );
    catalogStore.applySnapshot({
      items: [
        makeCatalogItem({
          physicalStock: 0,
          saleableStock: 0,
          slotSalesState: "sold_out",
        }),
      ],
      source: "local_stock",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
    });

    expect(store.canCreateOrder).toBe(false);
    await expect(store.createOrder()).rejects.toThrow("商品已售罄");
    expect(createOrderMock).not.toHaveBeenCalled();
  });

  it("blocks order creation when machine sale readiness is not ready", async () => {
    const store = useCheckoutStore();
    const connectivityStore = useConnectivityStore();
    connectivityStore.applySaleReadiness({
      canStartNetworkAuthorizedSale: false,
      blockingCodes: ["PLATFORM_UNREACHABLE"],
      components: {
        platformReachability: {
          ready: false,
          code: "PLATFORM_UNREACHABLE",
          message: "platform offline",
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
    });
    store.paymentOptions = [
      {
        optionKey: "mock:mock",
        providerCode: "mock",
        method: "mock",
        displayName: "模拟支付",
        description: "本地模拟",
        icon: "mock",
        disabled: false,
        disabledReason: null,
        recommended: true,
      },
    ];
    store.selectedPaymentOptionKey = "mock:mock";
    store.selectItem(makeCatalogItem());

    expect(store.canCreateOrder).toBe(false);
    await expect(store.createOrder()).rejects.toThrow("当前机器暂不可创建订单");
    expect(createOrderMock).not.toHaveBeenCalled();
  });

  it("blocks order creation for sold-out sale-view item", async () => {
    const store = useCheckoutStore();
    store.paymentOptions = [
      {
        optionKey: "payment_code:alipay",
        providerCode: "alipay",
        method: "payment_code",
        displayName: "支付宝付款码",
        description: "请出示付款码",
        icon: "alipay",
        disabled: false,
        disabledReason: null,
        recommended: true,
      },
    ];
    store.selectedPaymentOptionKey = "payment_code:alipay";
    store.selectItem(
      makeCatalogItem({
        physicalStock: 0,
        saleableStock: 0,
        slotSalesState: "sold_out",
      }),
    );

    expect(store.canCreateOrder).toBe(false);
    await expect(store.createOrder()).rejects.toThrow("商品已售罄");
    expect(createOrderMock).not.toHaveBeenCalled();
  });

  it("refreshes current transaction from daemon", async () => {
    getCurrentTransactionMock.mockResolvedValue(
      makeTransactionSnapshot({ nextAction: "dispensing" }),
    );

    const store = useCheckoutStore();
    await store.refreshCurrentTransaction();

    expect(store.flowStep).toBe("dispensing");
  });

  it("drops concurrent dev payment submissions", async () => {
    let resolveSubmit!: (
      value: ReturnType<typeof makeTransactionSnapshot>,
    ) => void;
    submitDevPaymentCodeMock.mockImplementation(async () => {
      return await new Promise<ReturnType<typeof makeTransactionSnapshot>>(
        (resolve) => {
          resolveSubmit = resolve;
        },
      );
    });

    const store = useCheckoutStore();
    store.currentOrder = {
      orderId: "550e8400-e29b-41d4-a716-446655440010",
      orderNo: "ORD-001",
      paymentNo: "PAY-001",
      paymentUrl: null,
      expiresAt: "2026-01-01T00:05:00Z",
      totalAmountCents: 100,
      paymentProviderCode: "alipay",
    };

    const first = store.submitDevPaymentCode("28763443825664394");
    const second = await store.submitDevPaymentCode("28763443825664395");

    resolveSubmit(makeTransactionSnapshot());
    await first;

    expect(second).toBeNull();
    expect(submitDevPaymentCodeMock).toHaveBeenCalledTimes(1);
  });
});
