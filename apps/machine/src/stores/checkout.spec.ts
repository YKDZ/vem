import type { MachinePaymentOption } from "@vem/shared";

import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  SaleStartCapabilitySnapshot,
  TransactionSnapshot,
} from "@/daemon/schemas";

import { saleCapabilitySnapshot } from "@/test-support/sale-capability";

const {
  createOrderMock,
  cancelOrderMock,
  getCurrentTransactionMock,
  getSaleViewMock,
} = vi.hoisted(() => ({
  createOrderMock: vi.fn(),
  cancelOrderMock: vi.fn(),
  getCurrentTransactionMock: vi.fn(),
  getSaleViewMock: vi.fn(),
}));

vi.mock("@/daemon/client", () => ({
  daemonClient: {
    createOrder: createOrderMock,
    cancelOrder: cancelOrderMock,
    getCurrentTransaction: getCurrentTransactionMock,
    getSaleView: getSaleViewMock,
  },
}));

import type {
  MachineCatalogItem,
  MachineCatalogSlotCandidate,
} from "@/types/catalog";

import { useCatalogStore } from "./catalog";
import { useCheckoutStore } from "./checkout";
import { useConnectivityStore } from "./connectivity";
import { useSaleCapabilityStore } from "./sale-capability";

let capabilityRevision = 0;

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  capabilityRevision = 0;
});

function capabilityResponse(input: {
  options: MachinePaymentOption[];
  defaultOptionKey: string | null;
  defaultProviderCode: string | null;
  canStartSale?: boolean;
}): SaleStartCapabilitySnapshot {
  const snapshot = saleCapabilitySnapshot({
    revision: ++capabilityRevision,
    canStartSale: input.canStartSale,
  });
  snapshot.paymentOptions = {
    ready: input.options.some((option) => !option.disabled),
    defaultOptionKey: input.defaultOptionKey,
    defaultProviderCode: input.defaultProviderCode,
    options: input.options.map(({ disabled, ...option }) => ({
      ...option,
      ready: !disabled,
    })),
  };
  return snapshot;
}

function applyPaymentOptions(
  options: MachinePaymentOption[],
  canStartSale = true,
): void {
  const firstEnabled = options.find((option) => !option.disabled) ?? null;
  useSaleCapabilityStore().acceptSnapshot(
    capabilityResponse({
      options,
      defaultOptionKey: firstEnabled?.optionKey ?? null,
      defaultProviderCode: firstEnabled?.providerCode ?? null,
      canStartSale,
    }),
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function makeCatalogItem(
  overrides: Partial<MachineCatalogItem> = {},
): MachineCatalogItem {
  const item = {
    machineCode: "M001",
    slotId: "550e8400-e29b-41d4-a716-446655440001",
    slotDisplayLabel: "A1",
    rowNo: 1,
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
  } as Omit<
    MachineCatalogItem,
    | "catalogKey"
    | "aggregatedSlotCount"
    | "slotCandidates"
    | "variantCandidates"
  >;
  const slotCandidates: readonly MachineCatalogSlotCandidate[] =
    overrides.slotCandidates ?? [
      {
        slotId: item.slotId,
        slotDisplayLabel: item.slotDisplayLabel,
        rowNo: item.rowNo,
        cellNo: item.cellNo,
        inventoryId: item.inventoryId,
        variantId: item.variantId,
        sku: item.sku,
        size: item.size,
        color: item.color,
        priceCents: item.priceCents,
        capacity: item.capacity,
        parLevel: item.parLevel,
        physicalStock: item.physicalStock,
        saleableStock: item.saleableStock,
        slotSalesState: item.slotSalesState,
      },
    ];
  return {
    ...item,
    catalogKey: overrides.catalogKey ?? `product:${item.productId}`,
    aggregatedSlotCount: overrides.aggregatedSlotCount ?? 1,
    slotCandidates,
    variantCandidates: overrides.variantCandidates ?? [
      {
        variantId: item.variantId,
        sku: item.sku,
        size: item.size,
        color: item.color,
        priceCents: item.priceCents,
        capacity: item.capacity,
        parLevel: item.parLevel,
        physicalStock: item.physicalStock,
        saleableStock: item.saleableStock,
        slotSalesState: item.slotSalesState,
        slotCandidates,
      },
    ],
  };
}

function makeTransactionSnapshot(
  overrides: Partial<TransactionSnapshot> = {},
): TransactionSnapshot {
  return {
    orderId: "550e8400-e29b-41d4-a716-446655440010",
    orderNo: "ORD-001",
    productSummary: null,
    paymentId: null,
    paymentNo: "PAY-001",
    paymentMethod: "payment_code",
    paymentProvider: "alipay",
    paymentUrl: "https://pay.example/1",
    paymentStatus: "pending",
    orderStatus: "pending_payment",
    totalAmountCents: 100,
    vending: {
      commandId: null,
      commandNo: "CMD-001",
      status: "pending",
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
  } as TransactionSnapshot;
}

function daemonRejectedRequestError(
  message: string,
  responseCode: string,
  responseMessage: string,
): Error {
  return Object.assign(new Error(message), {
    statusCode: 400,
    responseCode,
    responseMessage,
    responseBody: JSON.stringify({
      code: responseCode,
      message: responseMessage,
    }),
  });
}

function applyNetworkSaleReady(): void {
  const connectivityStore = useConnectivityStore();
  connectivityStore.applyHealth({
    status: "healthy",
    process: {
      component: "daemon",
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
    visionOnline: true,
    remoteOpsActive: false,
    currentTransaction: null,
    operatorReason: "",
    updatedAt: "2026-06-04T00:00:00Z",
  });
  connectivityStore.applyReady({
    ready: true,
    updatedAt: "2026-06-04T00:00:00Z",
  });
  if (!useSaleCapabilityStore().hasAcceptedCapability) {
    applyPaymentOptions([
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
    ]);
  }
}

describe("checkout store", () => {
  it("selects payment options from the accepted capability snapshot", () => {
    useSaleCapabilityStore().acceptSnapshot(
      capabilityResponse({
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
      }),
    );

    const store = useCheckoutStore();
    store.syncPaymentOptions();

    expect(store.selectedPaymentOptionKey).toBe("payment_code:alipay");
  });

  it("uses the shell-owned capability default when it arrives after item selection", () => {
    const item = makeCatalogItem();
    useCatalogStore().applySnapshot({
      items: [item],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
    });
    const store = useCheckoutStore();
    store.selectItem(item);

    expect(store.selectedPaymentOptionKey).toBeNull();
    applyPaymentOptions([
      {
        optionKey: "qr_code:alipay",
        providerCode: "alipay",
        method: "qr_code",
        displayName: "支付宝扫码",
        description: "请使用支付宝扫码",
        icon: "alipay",
        disabled: false,
        disabledReason: null,
        recommended: true,
      },
    ]);
    applyNetworkSaleReady();

    expect(store.selectedPaymentOption?.optionKey).toBe("qr_code:alipay");
    expect(store.canCreateOrder).toBe(true);
  });

  it("preserves capability option order while selecting the daemon default", () => {
    useSaleCapabilityStore().acceptSnapshot(
      capabilityResponse({
        options: [
          {
            optionKey: "qr_code:wechat_pay",
            providerCode: "wechat_pay",
            method: "qr_code",
            displayName: "微信扫码",
            description: "请使用微信扫描屏幕二维码",
            icon: "wechat",
            disabled: false,
            disabledReason: null,
            recommended: false,
          },
          {
            optionKey: "payment_code:alipay",
            providerCode: "alipay",
            method: "payment_code",
            displayName: "支付宝付款码",
            description: "请出示支付宝付款码",
            icon: "alipay",
            disabled: false,
            disabledReason: null,
            recommended: true,
          },
        ],
        defaultOptionKey: "payment_code:alipay",
        defaultProviderCode: "alipay",
      }),
    );

    const store = useCheckoutStore();
    store.syncPaymentOptions();

    expect(store.paymentOptions.map((option) => option.optionKey)).toEqual([
      "qr_code:wechat_pay",
      "payment_code:alipay",
    ]);
    expect(store.selectedPaymentOptionKey).toBe("payment_code:alipay");
  });

  it("selects the first enabled payment option when daemon default is disabled", () => {
    useSaleCapabilityStore().acceptSnapshot(
      capabilityResponse({
        options: [
          {
            optionKey: "payment_code:alipay",
            providerCode: "alipay",
            method: "payment_code",
            displayName: "支付宝付款码",
            description: "请出示付款码",
            icon: "alipay",
            disabled: true,
            disabledReason: "扫码器不可用：scanner open failed",
            recommended: true,
          },
          {
            optionKey: "qr_code:alipay",
            providerCode: "alipay",
            method: "qr_code",
            displayName: "支付宝扫码",
            description: "请使用支付宝扫描屏幕二维码",
            icon: "alipay",
            disabled: false,
            disabledReason: null,
            recommended: false,
          },
        ],
        defaultOptionKey: "payment_code:alipay",
        defaultProviderCode: "alipay",
      }),
    );

    const store = useCheckoutStore();
    store.syncPaymentOptions();

    expect(store.selectedPaymentOptionKey).toBe("qr_code:alipay");
  });

  it("does not select disabled payment options when no enabled option exists", () => {
    useSaleCapabilityStore().acceptSnapshot(
      capabilityResponse({
        options: [
          {
            optionKey: "payment_code:alipay",
            providerCode: "alipay",
            method: "payment_code",
            displayName: "支付宝付款码",
            description: "请出示付款码",
            icon: "alipay",
            disabled: true,
            disabledReason: "扫码器不可用：scanner open failed",
            recommended: true,
          },
        ],
        defaultOptionKey: null,
        defaultProviderCode: null,
      }),
    );

    const item = makeCatalogItem();
    useCatalogStore().applySnapshot({
      items: [item],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
    });
    applyNetworkSaleReady();

    const store = useCheckoutStore();
    store.selectItem(item);

    expect(store.selectedPaymentOptionKey).toBeNull();
    expect(store.canCreateOrder).toBe(false);
    expect(store.error).toBe("当前机器暂无可用支付方式");
    expect(createOrderMock).not.toHaveBeenCalled();
  });

  it("reports no payment options without creating an order", () => {
    useSaleCapabilityStore().acceptSnapshot(
      capabilityResponse({
        options: [],
        defaultOptionKey: null,
        defaultProviderCode: null,
      }),
    );

    const store = useCheckoutStore();
    store.syncPaymentOptions();

    expect(store.paymentOptionsLoaded).toBe(true);
    expect(store.selectedPaymentOptionKey).toBeNull();
    expect(store.canCreateOrder).toBe(false);
    expect(store.error).toBe("当前机器暂无可用支付方式");
    expect(createOrderMock).not.toHaveBeenCalled();
  });

  it("rejects a selected payment key removed by a newer capability snapshot", () => {
    const item = makeCatalogItem();
    useCatalogStore().applySnapshot({
      items: [item],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
    });
    applyPaymentOptions([
      {
        optionKey: "qr_code:alipay",
        providerCode: "alipay",
        method: "qr_code",
        displayName: "支付宝扫码",
        description: "请使用支付宝扫码",
        icon: "alipay",
        disabled: false,
        disabledReason: null,
        recommended: true,
      },
    ]);
    const store = useCheckoutStore();
    store.selectItem(item);
    store.selectedPaymentOptionKey = "mock:mock";

    expect(store.selectedPaymentOption).toBeNull();
    expect(store.canCreateOrder).toBe(false);
  });

  it("creates order without machineCode payload and applies transaction", async () => {
    createOrderMock.mockResolvedValue(makeTransactionSnapshot());

    const store = useCheckoutStore();
    applyPaymentOptions([
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
    ]);
    store.selectedPaymentOptionKey = "payment_code:alipay";
    useCatalogStore().applySnapshot({
      items: [makeCatalogItem()],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
    });
    applyNetworkSaleReady();
    store.selectItem(makeCatalogItem());

    await store.createOrder();

    expect(createOrderMock).toHaveBeenCalledWith({
      inventoryId: "550e8400-e29b-41d4-a716-446655440002",
      quantity: 1,
      planogramVersion: "PLAN-1",
      slotId: "550e8400-e29b-41d4-a716-446655440001",
      slotDisplayLabel: "A1",
      paymentMethod: "payment_code",
      paymentProviderCode: "alipay",
      profileSnapshot: null,
      idempotencyKey: expect.stringMatching(/^checkout:/),
    });
    expect(store.customerCheckoutView).toMatchObject({
      stage: "payment",
      orderCredential: "ORD-001",
      payment: {
        method: "payment_code",
        provider: "alipay",
        paymentUrl: "https://pay.example/1",
        expiresAt: "2026-01-01T00:05:00Z",
        totalAmountCents: 100,
        canCancel: true,
        display: {
          kind: "payment_code",
          state: "retryable",
          attemptStatus: "failed",
          maskedAuthCode: "6212****9012",
        },
      },
    });
    expect(store.paymentCodeMessage).toBe("请刷新付款码后重试");
  });

  it("reuses one checkout idempotency key when the customer retries a failed create", async () => {
    const item = makeCatalogItem();
    const store = useCheckoutStore();
    applyPaymentOptions([
      {
        optionKey: "qr_code:alipay",
        providerCode: "alipay",
        method: "qr_code",
        displayName: "支付宝扫码",
        description: "请扫码支付",
        icon: "alipay",
        disabled: false,
        disabledReason: null,
        recommended: true,
      },
    ]);
    store.selectedPaymentOptionKey = "qr_code:alipay";
    useCatalogStore().applySnapshot({
      items: [item],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
    });
    applyNetworkSaleReady();
    store.selectItem(item);
    createOrderMock
      .mockRejectedValueOnce(new Error("daemon timeout"))
      .mockResolvedValueOnce(
        makeTransactionSnapshot({ paymentMethod: "qr_code" }),
      );

    await expect(store.createOrder()).rejects.toThrow("daemon timeout");
    await store.createOrder();

    const [firstRequest, secondRequest] = createOrderMock.mock.calls;
    expect(firstRequest?.[0]).toEqual(
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(/^checkout:/),
      }),
    );
    expect(secondRequest?.[0]).toEqual(
      expect.objectContaining({
        idempotencyKey: firstRequest?.[0].idempotencyKey,
      }),
    );
  });

  it("shows customer-safe scanner copy when create-order local payment-code recheck fails", async () => {
    const technicalMessage =
      "selected payment option is not ready: open serial port COM3 failed: SCANNER_OPEN_FAILED (/v1/intents/create-order returned HTTP 400)";
    createOrderMock.mockRejectedValue(
      daemonRejectedRequestError(
        technicalMessage,
        "create_order_blocked",
        "selected payment option is not ready: open serial port COM3 failed: SCANNER_OPEN_FAILED",
      ),
    );

    const item = makeCatalogItem();
    const store = useCheckoutStore();
    applyPaymentOptions([
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
    ]);
    store.selectedPaymentOptionKey = "payment_code:alipay";
    useCatalogStore().applySnapshot({
      items: [item],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
    });
    applyNetworkSaleReady();
    store.selectItem(item);

    await expect(store.createOrder()).rejects.toThrow(technicalMessage);

    expect(store.error).toBe("扫码器暂不可用，请选择其他支付方式");
    expect(store.error).not.toContain("selected payment option");
    expect(store.error).not.toContain("/v1/intents/create-order");
    expect(store.error).not.toContain("HTTP");
    expect(store.error).not.toContain("SCANNER_OPEN_FAILED");
    expect(store.error).not.toContain("COM3");
  });

  it("fails closed when selected item is missing from the latest sale view", async () => {
    createOrderMock.mockResolvedValue(makeTransactionSnapshot());

    const store = useCheckoutStore();
    const catalogStore = useCatalogStore();
    applyPaymentOptions([
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
    ]);
    store.selectedPaymentOptionKey = "payment_code:alipay";
    applyNetworkSaleReady();
    store.selectItem(makeCatalogItem());
    catalogStore.applySnapshot({
      items: [
        makeCatalogItem({
          slotId: "550e8400-e29b-41d4-a716-446655440011",
          slotDisplayLabel: "B1",
          inventoryId: "550e8400-e29b-41d4-a716-446655440012",
          variantId: "550e8400-e29b-41d4-a716-446655440013",
          productId: "550e8400-e29b-41d4-a716-446655440014",
          sku: "WATER-NEW",
        }),
      ],
      source: "local_stock",
      planogramVersion: "PLAN-2",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
    });

    expect(store.canCreateOrder).toBe(false);
    await expect(store.createOrder()).rejects.toThrow("商品已更新，请重新选择");
    expect(createOrderMock).not.toHaveBeenCalled();
  });

  it("does not switch variants when another variant for the same product is saleable", async () => {
    const store = useCheckoutStore();
    const catalogStore = useCatalogStore();
    applyPaymentOptions([
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
    ]);
    store.selectedPaymentOptionKey = "payment_code:alipay";
    applyNetworkSaleReady();
    store.selectItem(
      makeCatalogItem({
        variantId: "550e8400-e29b-41d4-a716-446655440003",
        sku: "TSHIRT-M-BLACK",
        size: "M",
        color: "黑色",
        saleableStock: 1,
      }),
    );
    catalogStore.applySnapshot({
      items: [
        makeCatalogItem({
          variantId: "550e8400-e29b-41d4-a716-446655440003",
          sku: "TSHIRT-M-BLACK",
          size: "M",
          color: "黑色",
          physicalStock: 0,
          saleableStock: 0,
          slotSalesState: "sold_out",
        }),
        makeCatalogItem({
          slotId: "550e8400-e29b-41d4-a716-446655440011",
          slotDisplayLabel: "B1",
          rowNo: 2,
          cellNo: 1,
          inventoryId: "550e8400-e29b-41d4-a716-446655440012",
          variantId: "550e8400-e29b-41d4-a716-446655440013",
          sku: "TSHIRT-L-BLACK",
          size: "L",
          color: "黑色",
          physicalStock: 5,
          saleableStock: 5,
          slotSalesState: "sale_ready",
        }),
      ],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
    });

    expect(store.canCreateOrder).toBe(false);
    await expect(store.createOrder()).rejects.toThrow("商品已售罄");
    expect(createOrderMock).not.toHaveBeenCalled();
  });

  it("creates an order from another saleable slot for the same variant", async () => {
    createOrderMock.mockResolvedValue(makeTransactionSnapshot());

    const store = useCheckoutStore();
    const catalogStore = useCatalogStore();
    applyPaymentOptions([
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
    ]);
    store.selectedPaymentOptionKey = "payment_code:alipay";
    applyNetworkSaleReady();
    store.selectItem(makeCatalogItem({ saleableStock: 2 }));
    catalogStore.applySnapshot({
      items: [
        makeCatalogItem({
          physicalStock: 0,
          saleableStock: 0,
          slotSalesState: "sold_out",
        }),
        makeCatalogItem({
          slotId: "550e8400-e29b-41d4-a716-446655440011",
          slotDisplayLabel: "B1",
          rowNo: 2,
          cellNo: 1,
          inventoryId: "550e8400-e29b-41d4-a716-446655440012",
          physicalStock: 5,
          saleableStock: 5,
          slotSalesState: "sale_ready",
        }),
      ],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
    });

    expect(store.canCreateOrder).toBe(true);
    await store.createOrder();

    expect(createOrderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        inventoryId: "550e8400-e29b-41d4-a716-446655440012",
        slotId: "550e8400-e29b-41d4-a716-446655440011",
        slotDisplayLabel: "B1",
      }),
    );
  });

  it("blocks stale selected item when latest sale view is sold out", async () => {
    const store = useCheckoutStore();
    const catalogStore = useCatalogStore();
    applyPaymentOptions([
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
    ]);
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

  it("blocks order creation when sale-start capability is blocked", async () => {
    const store = useCheckoutStore();
    applyPaymentOptions(
      [
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
      ],
      false,
    );
    store.selectedPaymentOptionKey = "mock:mock";
    const item = makeCatalogItem();
    useCatalogStore().applySnapshot({
      items: [item],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
    });
    store.selectItem(item);

    expect(store.canCreateOrder).toBe(false);
    await expect(store.createOrder()).rejects.toThrow("当前机器暂不可创建订单");
    expect(createOrderMock).not.toHaveBeenCalled();
  });

  it("fails closed when sale-start capability is unknown", async () => {
    const store = useCheckoutStore();
    store.selectedPaymentOptionKey = "mock:mock";
    const item = makeCatalogItem();
    useCatalogStore().applySnapshot({
      items: [item],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
    });
    store.selectItem(item);

    expect(store.canCreateOrder).toBe(false);
    await expect(store.createOrder()).rejects.toThrow("当前机器暂不可创建订单");
    expect(createOrderMock).not.toHaveBeenCalled();
  });

  it("retains an accepted capability when refresh diagnostics become stale", () => {
    const store = useCheckoutStore();
    applyPaymentOptions([
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
    ]);
    store.selectedPaymentOptionKey = "mock:mock";
    useCatalogStore().applySnapshot({
      items: [makeCatalogItem()],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
    });
    store.selectItem(makeCatalogItem());

    expect(store.canCreateOrder).toBe(true);

    useSaleCapabilityStore().markStale("event stream disconnected");

    expect(useSaleCapabilityStore().stale).toBe(true);
    expect(store.canCreateOrder).toBe(true);
  });

  it("blocks order creation for sold-out sale-view item", async () => {
    const store = useCheckoutStore();
    applyPaymentOptions([
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
    ]);
    store.selectedPaymentOptionKey = "payment_code:alipay";
    const item = makeCatalogItem({
      physicalStock: 0,
      saleableStock: 0,
      slotSalesState: "sold_out",
    });
    useCatalogStore().applySnapshot({
      items: [item],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
    });
    store.selectItem(item);

    expect(store.canCreateOrder).toBe(false);
    await expect(store.createOrder()).rejects.toThrow("商品已售罄");
    expect(createOrderMock).not.toHaveBeenCalled();
  });

  it("refreshes current transaction from daemon", async () => {
    const snapshot = makeTransactionSnapshot({ nextAction: "dispensing" });
    getCurrentTransactionMock.mockResolvedValue(snapshot);

    const store = useCheckoutStore();
    await expect(store.refreshCurrentTransaction()).resolves.toEqual({
      status: "refreshed",
      snapshot,
    });

    expect(store.customerCheckoutView).toMatchObject({
      stage: "dispensing",
      routeTarget: { path: "/dispensing" },
    });
  });

  it("marks daemon refreshes as live after a boot-restored transaction", async () => {
    const restored = makeTransactionSnapshot({ nextAction: "wait_payment" });
    const live = makeTransactionSnapshot({
      nextAction: "dispensing",
      paymentStatus: "succeeded",
      orderStatus: "dispensing",
      updatedAt: "2026-07-18T08:35:00.000Z",
    });
    getCurrentTransactionMock.mockResolvedValue(live);
    const store = useCheckoutStore();
    store.applyTransaction(restored, { restored: true });

    await store.refreshCurrentTransaction();

    expect(store.lastTransactionRestored).toBe(false);
    expect(store.transaction?.nextAction).toBe("dispensing");
  });

  it("reports an explicit transaction refresh failure while retaining recovery state", async () => {
    const failure = new Error("daemon IPC disconnected");
    getCurrentTransactionMock.mockRejectedValueOnce(failure);
    const store = useCheckoutStore();
    store.applyTransaction(makeTransactionSnapshot());

    await expect(store.refreshCurrentTransaction()).resolves.toEqual({
      status: "failed",
      snapshot: null,
      error: failure,
    });

    expect(store.customerCheckoutRecovery.active).toBe(true);
  });

  it("treats a transaction identity mismatch as a refreshed read", async () => {
    getCurrentTransactionMock.mockResolvedValueOnce(
      makeTransactionSnapshot({ orderNo: null, nextAction: null }),
    );
    const store = useCheckoutStore();
    store.applyTransaction(makeTransactionSnapshot());

    await expect(store.refreshCurrentTransaction()).resolves.toEqual({
      status: "refreshed",
      snapshot: null,
    });

    expect(store.customerCheckoutRecovery.active).toBe(true);
  });

  it("coalesces overlapping invalidations and discards an older successful snapshot", async () => {
    const older = deferred<TransactionSnapshot>();
    const newer = deferred<TransactionSnapshot>();
    getCurrentTransactionMock
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    const store = useCheckoutStore();
    const dispensing = makeTransactionSnapshot({
      paymentStatus: "succeeded",
      orderStatus: "dispensing",
      nextAction: "dispensing",
      vending: {
        commandId: null,
        commandNo: "CMD-CONCURRENT",
        status: "sent",
        lastError: null,
      },
      updatedAt: "2026-07-15T01:00:02.000Z",
    });
    const olderRefresh = store.invalidateCurrentTransaction();
    const newerRefresh = store.invalidateCurrentTransaction();
    expect(getCurrentTransactionMock).toHaveBeenCalledOnce();
    older.resolve(
      makeTransactionSnapshot({ updatedAt: "2026-07-15T01:00:00.000Z" }),
    );
    await vi.waitFor(() => {
      expect(getCurrentTransactionMock).toHaveBeenCalledTimes(2);
    });
    newer.resolve(dispensing);
    await Promise.all([olderRefresh, newerRefresh]);

    expect(store.customerCheckoutView).toMatchObject({
      stage: "dispensing",
      orderCredential: "ORD-001",
    });
    expect(store.transaction?.updatedAt).toBe("2026-07-15T01:00:02.000Z");
  });

  it("discards an older refresh failure before applying the current generation", async () => {
    const older = deferred<TransactionSnapshot>();
    const newer = deferred<TransactionSnapshot>();
    getCurrentTransactionMock
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    const store = useCheckoutStore();
    store.applyTransaction(
      makeTransactionSnapshot({
        updatedAt: "2026-07-15T01:10:00.000Z",
      }),
    );
    const terminal = makeTransactionSnapshot({
      paymentStatus: "succeeded",
      orderStatus: "fulfilled",
      nextAction: "success",
      vending: {
        commandId: null,
        commandNo: "CMD-CONCURRENT-SUCCESS",
        status: "succeeded",
        lastError: null,
      },
      updatedAt: "2026-07-15T01:10:02.000Z",
    });

    const olderRefresh = store.invalidateCurrentTransaction();
    const newerRefresh = store.invalidateCurrentTransaction();
    expect(getCurrentTransactionMock).toHaveBeenCalledOnce();
    older.reject(new Error("older daemon IPC request failed"));
    await vi.waitFor(() => {
      expect(getCurrentTransactionMock).toHaveBeenCalledTimes(2);
    });
    newer.resolve(terminal);
    await Promise.all([olderRefresh, newerRefresh]);

    expect(store.customerCheckoutView).toMatchObject({
      stage: "result",
      result: { kind: "success" },
    });
    expect(store.customerCheckoutRecovery.active).toBe(false);
    expect(store.error).toBeNull();
  });

  it("blocks cancel at the store boundary while the active transaction is recovering", async () => {
    getCurrentTransactionMock.mockRejectedValue(
      new Error("daemon IPC disconnected"),
    );
    const store = useCheckoutStore();
    store.applyTransaction(makeTransactionSnapshot());
    await store.refreshCurrentTransaction();

    await expect(store.cancelCurrentOrder()).rejects.toThrow(
      "正在恢复当前交易",
    );

    expect(cancelOrderMock).not.toHaveBeenCalled();
    expect(store.customerCheckoutView).toMatchObject({
      stage: "payment",
      orderCredential: "ORD-001",
    });
  });

  it("blocks order creation before catalog or daemon mutation while recovering", async () => {
    const store = useCheckoutStore();
    store.selectItem(makeCatalogItem());
    store.applyTransaction(makeTransactionSnapshot());
    getCurrentTransactionMock.mockRejectedValue(
      new Error("daemon IPC disconnected"),
    );
    await store.refreshCurrentTransaction();
    getSaleViewMock.mockClear();

    await expect(store.createOrder()).rejects.toThrow("正在恢复当前交易");

    expect(getSaleViewMock).not.toHaveBeenCalled();
    expect(createOrderMock).not.toHaveBeenCalled();
    expect(store.customerCheckoutView.orderCredential).toBe("ORD-001");
  });

  it("blocks reset and customer selections from changing local transaction state while recovering", async () => {
    getCurrentTransactionMock.mockRejectedValue(
      new Error("daemon IPC disconnected"),
    );
    const store = useCheckoutStore();
    applyPaymentOptions([
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
      {
        optionKey: "qr_code:alipay",
        providerCode: "alipay",
        method: "qr_code",
        displayName: "支付宝",
        description: "扫码支付",
        icon: "alipay",
        disabled: false,
        disabledReason: null,
        recommended: false,
      },
    ]);
    store.selectedPaymentOptionKey = "mock:mock";
    store.applyTransaction(makeTransactionSnapshot());
    await store.refreshCurrentTransaction();

    store.selectPaymentOption("qr_code:alipay");
    store.selectItem(makeCatalogItem({ catalogKey: "product:OTHER" }));
    store.reset();

    expect(store.selectedPaymentOptionKey).toBe("mock:mock");
    expect(store.customerCheckoutRecovery.active).toBe(true);
    expect(store.customerCheckoutView).toMatchObject({
      stage: "payment",
      orderCredential: "ORD-001",
    });
  });

  it("does not let a new catalog selection clear a daemon-owned active transaction", () => {
    const store = useCheckoutStore();
    store.applyTransaction(makeTransactionSnapshot());

    store.selectItem(makeCatalogItem({ catalogKey: "product:OTHER" }));

    expect(store.customerCheckoutView).toMatchObject({
      stage: "payment",
      orderCredential: "ORD-001",
    });
  });

  it("keeps the last daemon transaction projection under recovery when IPC refresh fails", async () => {
    getCurrentTransactionMock.mockRejectedValue(
      new Error("daemon IPC disconnected"),
    );
    const store = useCheckoutStore();
    store.applyTransaction(makeTransactionSnapshot());

    await store.refreshCurrentTransaction();

    expect(store.customerCheckoutView).toMatchObject({
      stage: "payment",
      orderCredential: "ORD-001",
    });
    expect(store.customerCheckoutRecovery).toEqual({
      active: true,
      orderCredential: "ORD-001",
    });
  });

  it("does not abandon an active transaction when reconnect temporarily returns no current transaction", async () => {
    getCurrentTransactionMock.mockResolvedValue(
      makeTransactionSnapshot({
        orderId: null,
        orderNo: null,
        paymentId: null,
        paymentNo: null,
        paymentMethod: null,
        paymentProvider: null,
        paymentUrl: null,
        paymentStatus: null,
        orderStatus: null,
        totalAmountCents: null,
        nextAction: null,
        expiresAt: null,
      }),
    );
    const store = useCheckoutStore();
    store.applyTransaction(makeTransactionSnapshot());

    await store.refreshCurrentTransaction();

    expect(store.customerCheckoutView).toMatchObject({
      stage: "payment",
      orderCredential: "ORD-001",
    });
    expect(store.customerCheckoutRecovery.active).toBe(true);
  });

  it("rejects a different transaction identity while recovering the active one", async () => {
    getCurrentTransactionMock.mockResolvedValue(
      makeTransactionSnapshot({ orderNo: "ORD-UNRELATED" }),
    );
    const store = useCheckoutStore();
    store.applyTransaction(makeTransactionSnapshot());

    await store.refreshCurrentTransaction();

    expect(store.customerCheckoutView).toMatchObject({
      stage: "payment",
      orderCredential: "ORD-001",
    });
    expect(store.customerCheckoutRecovery).toEqual({
      active: true,
      orderCredential: "ORD-001",
    });
  });

  it("clears recovery only after the daemon restores the same transaction identity and advances it", async () => {
    getCurrentTransactionMock
      .mockRejectedValueOnce(new Error("daemon IPC disconnected"))
      .mockResolvedValueOnce(
        makeTransactionSnapshot({
          paymentStatus: "succeeded",
          orderStatus: "dispensing",
          nextAction: "dispensing",
          vending: {
            commandId: null,
            commandNo: "CMD-RECONNECTED",
            status: "sent",
            lastError: null,
          },
        }),
      );
    const store = useCheckoutStore();
    store.applyTransaction(makeTransactionSnapshot());

    await store.refreshCurrentTransaction();
    expect(store.customerCheckoutRecovery.active).toBe(true);
    await store.refreshCurrentTransaction();

    expect(store.customerCheckoutRecovery).toEqual({
      active: false,
      orderCredential: null,
    });
    expect(store.customerCheckoutView).toMatchObject({
      stage: "dispensing",
      orderCredential: "ORD-001",
    });
  });

  it("keeps a terminal projection until the customer explicitly dismisses it", async () => {
    const terminal = makeTransactionSnapshot({
      paymentStatus: "succeeded",
      orderStatus: "fulfilled",
      nextAction: "success",
      vending: {
        commandId: null,
        commandNo: "CMD-TERMINAL",
        status: "succeeded",
        lastError: null,
      },
    });
    getCurrentTransactionMock.mockResolvedValue(
      makeTransactionSnapshot({
        orderId: null,
        orderNo: null,
        paymentId: null,
        paymentNo: null,
        paymentMethod: null,
        paymentProvider: null,
        paymentUrl: null,
        paymentStatus: null,
        orderStatus: null,
        totalAmountCents: null,
        nextAction: null,
        expiresAt: null,
      }),
    );
    const store = useCheckoutStore();
    store.applyTransaction(terminal);

    await store.refreshCurrentTransaction();

    expect(store.customerCheckoutView).toMatchObject({
      stage: "result",
      orderCredential: "ORD-001",
      result: { kind: "success" },
    });
    store.dismissCurrentTerminalTransaction();
    expect(store.customerCheckoutView.stage).toBe("none");
  });

  it("preserves result_unknown vending status from daemon manual handling transaction", async () => {
    getCurrentTransactionMock.mockResolvedValue(
      makeTransactionSnapshot({
        paymentStatus: "succeeded",
        orderStatus: "manual_handling",
        nextAction: "manual_handling",
        vending: {
          commandId: null,
          commandNo: "CMD-UNKNOWN",
          status: "result_unknown",
          lastError: "dispense result unknown after daemon restart",
        },
      }),
    );

    const store = useCheckoutStore();
    await store.refreshCurrentTransaction();

    expect(store.customerCheckoutView).toMatchObject({
      stage: "result",
      routeTarget: { name: "result", params: { kind: "manual_handling" } },
      orderCredential: "ORD-001",
      result: {
        kind: "manual_handling",
        displayIntent: "manual_handling",
        detailIntent: "dispense_result_unknown",
        orderCredentialBehavior: "shown",
      },
    });
  });

  it("cancels the current order through daemon and refreshes sale view", async () => {
    cancelOrderMock.mockResolvedValue(
      makeTransactionSnapshot({
        paymentStatus: "canceled",
        orderStatus: "canceled",
        nextAction: "closed",
      }),
    );
    getSaleViewMock.mockResolvedValue({
      items: [makeCatalogItem({ saleableStock: 1 })],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
    });

    const store = useCheckoutStore();
    store.applyTransaction(makeTransactionSnapshot());
    const snapshot = await store.cancelCurrentOrder();

    expect(snapshot?.nextAction).toBe("closed");
    expect(cancelOrderMock).toHaveBeenCalledWith("ORD-001");
    expect(getSaleViewMock).toHaveBeenCalledOnce();
    expect(store.transaction).toBeNull();
    expect(store.customerCheckoutView.stage).toBe("none");
  });

  it("cancels using the current transaction credential over stale current order state", async () => {
    cancelOrderMock.mockResolvedValue(
      makeTransactionSnapshot({
        orderNo: "ORD-TX-ACTIVE",
        paymentStatus: "canceled",
        orderStatus: "canceled",
        nextAction: "closed",
      }),
    );
    getSaleViewMock.mockResolvedValue({
      items: [],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
    });

    const store = useCheckoutStore();
    store.applyTransaction(
      makeTransactionSnapshot({ orderNo: "ORD-TX-ACTIVE" }),
    );

    await store.cancelCurrentOrder();

    expect(cancelOrderMock).toHaveBeenCalledWith("ORD-TX-ACTIVE");
  });

  it("can preserve selected item after canceling from payment UI", async () => {
    cancelOrderMock.mockResolvedValue(
      makeTransactionSnapshot({
        paymentStatus: "canceled",
        orderStatus: "canceled",
        nextAction: "closed",
      }),
    );
    getSaleViewMock.mockResolvedValue({
      items: [makeCatalogItem({ saleableStock: 1 })],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
    });

    const item = makeCatalogItem({ catalogKey: "product:SOCK-001" });
    const store = useCheckoutStore();
    store.selectItem(item);
    store.applyTransaction(makeTransactionSnapshot());

    await store.cancelCurrentOrder({ preserveSelectedItem: true });

    expect(store.transaction).toBeNull();
    expect(store.selectedItem?.catalogKey).toBe("product:SOCK-001");
    expect(store.customerCheckoutView.stage).toBe("none");
  });

  it("ignores a dismissed terminal current transaction", async () => {
    const failedTransaction = makeTransactionSnapshot({
      paymentStatus: "failed",
      orderStatus: "canceled",
      nextAction: "payment_failed",
    });
    getCurrentTransactionMock.mockResolvedValue(failedTransaction);

    const store = useCheckoutStore();
    store.applyTransaction(failedTransaction);
    expect(store.customerCheckoutView.stage).toBe("result");

    store.transactionRecoveryOrderNo = failedTransaction.orderNo;
    store.dismissCurrentTerminalTransaction();
    expect(store.transaction).toBeNull();
    expect(store.transactionRecoveryOrderNo).toBeNull();
    store.reset();
    const refreshed = await store.refreshCurrentTransaction();

    expect(refreshed).toEqual({ status: "refreshed", snapshot: null });
    expect(store.shouldIgnoreTransaction(failedTransaction)).toBe(true);
    expect(store.customerCheckoutView).toMatchObject({
      stage: "none",
      routeTarget: { name: "catalog" },
      orderCredential: null,
      result: null,
    });
  });

  it("records successful terminal dismissal and suppresses the same success on refresh", async () => {
    const successTransaction = makeTransactionSnapshot({
      paymentStatus: "succeeded",
      orderStatus: "fulfilled",
      vending: {
        commandId: null,
        commandNo: "CMD-SUCCESS",
        status: "succeeded",
        lastError: null,
      },
      nextAction: "success",
    });
    getCurrentTransactionMock.mockResolvedValue(successTransaction);

    const store = useCheckoutStore();
    store.applyTransaction(successTransaction);
    expect(store.customerCheckoutView).toMatchObject({
      stage: "result",
      result: {
        kind: "success",
      },
    });

    store.dismissCurrentTerminalTransaction();
    store.reset();
    const refreshed = await store.refreshCurrentTransaction();

    expect(refreshed).toEqual({ status: "refreshed", snapshot: null });
    expect(store.shouldIgnoreTransaction(successTransaction)).toBe(true);
    expect(store.customerCheckoutView).toMatchObject({
      stage: "none",
      routeTarget: { name: "catalog" },
      orderCredential: null,
      result: null,
    });
  });

  it("preserves reversed payment-code attempt and shows retry message", async () => {
    getCurrentTransactionMock.mockResolvedValue(
      makeTransactionSnapshot({
        paymentCodeAttempt: {
          attemptNo: 1,
          status: "reversed",
          maskedAuthCode: "2876****4394",
          source: "serial_text",
          idempotencyKey: "ORD-001:attempt-1",
          submittedAt: "2026-01-01T00:00:05Z",
          lastCheckedAt: "2026-01-01T00:00:35Z",
          canRetry: true,
          message: null,
        },
        operatorHint: null,
      }),
    );

    const store = useCheckoutStore();
    await store.refreshCurrentTransaction();

    expect(store.customerCheckoutView.payment?.display).toMatchObject({
      kind: "payment_code",
      state: "retryable",
      attemptStatus: "reversed",
    });
    expect(store.paymentCodeMessage).toBe(
      "本次付款码交易已撤销，请刷新付款码后重试",
    );
    expect(store.customerCheckoutView.stage).toBe("payment");
  });

  it("keeps the current order after one failed payment-code scan attempt", async () => {
    const failedScan = makeTransactionSnapshot({
      paymentCodeAttempt: {
        attemptNo: 1,
        status: "failed",
        maskedAuthCode: "2876****4394",
        source: "serial_text",
        idempotencyKey: "ORD-001:attempt-1",
        submittedAt: "2026-01-01T00:00:05Z",
        lastCheckedAt: "2026-01-01T00:00:06Z",
        canRetry: true,
        message: "付款码已失效，请刷新付款码后重试",
      },
      nextAction: "wait_payment",
      paymentStatus: "pending",
      orderStatus: "pending_payment",
      operatorHint: null,
    });
    getCurrentTransactionMock.mockResolvedValue(failedScan);

    const store = useCheckoutStore();
    store.applyTransaction(
      makeTransactionSnapshot({ paymentCodeAttempt: null }),
    );
    await store.refreshCurrentTransaction();

    expect(store.customerCheckoutView).toMatchObject({
      stage: "payment",
      orderCredential: "ORD-001",
      payment: {
        display: {
          kind: "payment_code",
          state: "retryable",
          attemptStatus: "failed",
        },
      },
    });
    expect(store.paymentCodeLastMasked).toBe("2876****4394");
    expect(store.paymentCodeMessage).toBe("付款码已失效，请刷新付款码后重试");
  });

  it("keeps the current order while an unknown payment-code attempt is being queried", async () => {
    const unknownScan = makeTransactionSnapshot({
      paymentCodeAttempt: {
        attemptNo: 1,
        status: "querying",
        maskedAuthCode: "2876****4394",
        source: "serial_text",
        idempotencyKey: "ORD-001:attempt-1",
        submittedAt: "2026-01-01T00:00:05Z",
        lastCheckedAt: "2026-01-01T00:00:06Z",
        canRetry: false,
        message: "正在确认支付结果",
      },
      nextAction: "wait_payment",
      paymentStatus: "pending",
      orderStatus: "pending_payment",
      operatorHint: null,
    });
    getCurrentTransactionMock.mockResolvedValue(unknownScan);

    const store = useCheckoutStore();
    store.applyTransaction(
      makeTransactionSnapshot({ paymentCodeAttempt: null }),
    );
    await store.refreshCurrentTransaction();

    expect(store.customerCheckoutView).toMatchObject({
      stage: "payment",
      orderCredential: "ORD-001",
      payment: {
        display: {
          kind: "payment_code",
          state: "in_flight",
          attemptStatus: "querying",
        },
      },
    });
    expect(store.paymentCodeMessage).toBe("正在确认支付结果");
  });
});
