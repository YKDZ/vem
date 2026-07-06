import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getPaymentOptionsMock,
  createOrderMock,
  cancelOrderMock,
  getCurrentTransactionMock,
  submitDevPaymentCodeMock,
  markMockPaymentMock,
  getSaleViewMock,
} = vi.hoisted(() => ({
  getPaymentOptionsMock: vi.fn(),
  createOrderMock: vi.fn(),
  cancelOrderMock: vi.fn(),
  getCurrentTransactionMock: vi.fn(),
  submitDevPaymentCodeMock: vi.fn(),
  markMockPaymentMock: vi.fn(),
  getSaleViewMock: vi.fn(),
}));

vi.mock("@/daemon/client", () => ({
  daemonClient: {
    currentConnection: { mock: true },
    getPaymentOptions: getPaymentOptionsMock,
    createOrder: createOrderMock,
    cancelOrder: cancelOrderMock,
    getCurrentTransaction: getCurrentTransactionMock,
    submitDevPaymentCode: submitDevPaymentCodeMock,
    markMockPayment: markMockPaymentMock,
    getSaleView: getSaleViewMock,
  },
}));

import type {
  MachineCatalogItem,
  MachineCatalogSlotCandidate,
} from "@/types/catalog";

import { useCatalogStore } from "./catalog";
import {
  isTerminalResultNextAction,
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
  const item = {
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
        slotCode: item.slotCode,
        layerNo: item.layerNo,
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
    canSell: true,
    mode: "catalog",
    blockingCodes: [],
    blockingReasons: [],
    degradedReasons: [],
    suggestedRoute: "catalog",
    updatedAt: "2026-06-04T00:00:00Z",
  });
  connectivityStore.applySaleReadiness({
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
}

describe("checkout helpers", () => {
  it("normalizes unknown next action to wait_payment", () => {
    expect(normalizeNextAction("weird")).toBe("wait_payment");
  });

  it("maps result next actions", () => {
    expect(resultKindFromNextAction("success")).toBe("success");
    expect(resultKindFromNextAction("wait_payment")).toBeNull();
    expect(isTerminalResultNextAction("payment_failed")).toBe(true);
  });

  it("maps unknown dispense projections to manual handling", () => {
    expect(normalizeNextAction("result_unknown")).toBe("manual_handling");
    expect(
      resultKindFromNextAction(normalizeNextAction("result_unknown")),
    ).toBe("manual_handling");
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

  it("selects the first enabled payment option when daemon default is disabled", async () => {
    getPaymentOptionsMock.mockResolvedValue({
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
      serverTime: "2026-01-01T00:00:00Z",
    });

    const store = useCheckoutStore();
    await store.loadPaymentOptions();

    expect(store.selectedPaymentOptionKey).toBe("qr_code:alipay");
  });

  it("does not select disabled payment options when no enabled option exists", async () => {
    getPaymentOptionsMock.mockResolvedValue({
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
      serverTime: "2026-01-01T00:00:00Z",
    });

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
    await store.loadPaymentOptions();

    expect(store.selectedPaymentOptionKey).toBeNull();
    expect(store.canCreateOrder).toBe(false);
    expect(store.error).toBe("当前机器暂无可用支付方式");
    expect(createOrderMock).not.toHaveBeenCalled();
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
    useCatalogStore().applySnapshot({
      items: [makeCatalogItem()],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
    });
    useConnectivityStore().applyHealth({
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
    useConnectivityStore().applyReady({
      ready: true,
      canSell: true,
      mode: "catalog",
      blockingCodes: [],
      blockingReasons: [],
      degradedReasons: [],
      suggestedRoute: "catalog",
      updatedAt: "2026-06-04T00:00:00Z",
    });
    useConnectivityStore().applySaleReadiness({
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
    store.selectItem(makeCatalogItem());

    await store.createOrder();

    expect(createOrderMock).toHaveBeenCalledWith({
      inventoryId: "550e8400-e29b-41d4-a716-446655440002",
      quantity: 1,
      planogramVersion: "PLAN-1",
      slotId: "550e8400-e29b-41d4-a716-446655440001",
      slotCode: "A1",
      paymentMethod: "payment_code",
      paymentProviderCode: "alipay",
      profileSnapshot: null,
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

  it("fails closed when selected item is missing from the latest sale view", async () => {
    createOrderMock.mockResolvedValue(makeTransactionSnapshot());

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
    applyNetworkSaleReady();
    store.selectItem(makeCatalogItem());
    catalogStore.applySnapshot({
      items: [
        makeCatalogItem({
          slotId: "550e8400-e29b-41d4-a716-446655440011",
          slotCode: "B1",
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
          slotCode: "B1",
          layerNo: 2,
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
          slotCode: "B1",
          layerNo: 2,
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
        slotCode: "B1",
      }),
    );
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

  it("fails closed when machine sale readiness is unknown", async () => {
    const store = useCheckoutStore();
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

  it("fails closed when a previously ready machine becomes stale", async () => {
    const store = useCheckoutStore();
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
      canSell: true,
      mode: "catalog",
      blockingCodes: [],
      blockingReasons: [],
      degradedReasons: [],
      suggestedRoute: "catalog",
      updatedAt: "2026-06-04T00:00:00Z",
    });
    connectivityStore.applySaleReadiness({
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
    useCatalogStore().applySnapshot({
      items: [makeCatalogItem()],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
    });
    store.selectItem(makeCatalogItem());

    expect(store.canCreateOrder).toBe(true);

    connectivityStore.markStale("event stream disconnected");

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
    getCurrentTransactionMock.mockResolvedValue(
      makeTransactionSnapshot({ nextAction: "dispensing" }),
    );

    const store = useCheckoutStore();
    await store.refreshCurrentTransaction();

    expect(store.customerCheckoutView).toMatchObject({
      stage: "dispensing",
      routeTarget: { path: "/dispensing" },
    });
  });

  it("preserves result_unknown vending status from daemon manual handling transaction", async () => {
    getCurrentTransactionMock.mockResolvedValue(
      makeTransactionSnapshot({
        paymentStatus: "succeeded",
        orderStatus: "manual_handling",
        nextAction: "manual_handling",
        vending: {
          commandNo: "CMD-UNKNOWN",
          status: "result_unknown",
          lastError: "dispense result unknown after daemon restart",
        },
      }),
    );

    const store = useCheckoutStore();
    await store.refreshCurrentTransaction();

    expect(store.flowStep).toBe("result");
    expect(store.status?.nextAction).toBe("manual_handling");
    expect(store.status?.vending).toMatchObject({
      commandNo: "CMD-UNKNOWN",
      status: "result_unknown",
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
    expect(store.currentOrder).toBeNull();
    expect(store.status).toBeNull();
    expect(store.flowStep).toBe("idle");
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
    store.currentOrder = {
      orderId: "stale-order-id",
      orderNo: "ORD-STALE",
      paymentNo: "PAY-STALE",
      paymentUrl: null,
      expiresAt: "2026-01-01T00:05:00Z",
      totalAmountCents: 100,
      paymentProviderCode: "alipay",
    };

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

    expect(store.currentOrder).toBeNull();
    expect(store.status).toBeNull();
    expect(store.selectedItem?.catalogKey).toBe("product:SOCK-001");
    expect(store.flowStep).toBe("detail");
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
    expect(store.flowStep).toBe("result");

    store.dismissCurrentTerminalTransaction();
    store.reset();
    const refreshed = await store.refreshCurrentTransaction();

    expect(refreshed).toBeNull();
    expect(store.shouldIgnoreTransaction(failedTransaction)).toBe(true);
    expect(store.currentOrder).toBeNull();
    expect(store.status).toBeNull();
    expect(store.flowStep).toBe("idle");
  });

  it("records successful terminal dismissal and suppresses the same success on refresh", async () => {
    const successTransaction = makeTransactionSnapshot({
      paymentStatus: "succeeded",
      orderStatus: "fulfilled",
      vending: {
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

    expect(refreshed).toBeNull();
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

    expect(store.status?.paymentCodeAttempt).toMatchObject({
      status: "reversed",
      canRetry: true,
      message: "本次付款码交易已撤销，请刷新付款码后重试",
    });
    expect(store.paymentCodeMessage).toBe(
      "本次付款码交易已撤销，请刷新付款码后重试",
    );
    expect(store.flowStep).toBe("payment");
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

    expect(store.currentOrder?.orderNo).toBe("ORD-001");
    expect(store.status?.nextAction).toBe("wait_payment");
    expect(store.status?.paymentCodeAttempt).toMatchObject({
      status: "failed",
      canRetry: true,
      message: "付款码已失效，请刷新付款码后重试",
    });
    expect(store.paymentCodeLastMasked).toBe("2876****4394");
    expect(store.flowStep).toBe("payment");
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

    expect(store.currentOrder?.orderNo).toBe("ORD-001");
    expect(store.status?.nextAction).toBe("wait_payment");
    expect(store.status?.paymentCodeAttempt).toMatchObject({
      status: "querying",
      canRetry: false,
      message: "正在确认支付结果",
    });
    expect(store.flowStep).toBe("payment");
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
