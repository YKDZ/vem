import type { EffectiveMachineRuntimeConfiguration } from "@vem/shared";

// @vitest-environment jsdom
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";

const {
  routerPushMock,
  routerBackMock,
  routerReplaceMock,
  initializeMock,
  getHealthMock,
  getReadyMock,
  getEffectiveRuntimeConfigurationMock,
  getSaleStartCapabilityMock,
  getCurrentTransactionMock,
  getSaleViewMock,
  createOrderMock,
  subscribeVisionProfilesMock,
  submitMachineNavigationIntentMock,
  routeParams,
  routeQuery,
  routeName,
} = vi.hoisted(() => ({
  routerPushMock: vi.fn(),
  routerBackMock: vi.fn(),
  routerReplaceMock: vi.fn(),
  initializeMock: vi.fn(),
  getHealthMock: vi.fn(),
  getReadyMock: vi.fn(),
  getEffectiveRuntimeConfigurationMock: vi.fn(),
  getSaleStartCapabilityMock: vi.fn(),
  getCurrentTransactionMock: vi.fn(),
  getSaleViewMock: vi.fn(),
  createOrderMock: vi.fn(),
  subscribeVisionProfilesMock: vi.fn(),
  submitMachineNavigationIntentMock: vi.fn(),
  routeParams: {} as Record<string, string>,
  routeQuery: {} as Record<string, string>,
  routeName: { value: "catalog" },
}));

vi.mock("@/router/transaction-route-authority", () => ({
  installedMachineRuntimeTrace: () => null,
  submitMachineNavigationIntent: submitMachineNavigationIntentMock,
}));

vi.mock("vue-router", () => ({
  useRouter: () => ({
    push: routerPushMock,
    back: routerBackMock,
    replace: routerReplaceMock,
  }),
  useRoute: () => ({
    get name() {
      return routeName.value;
    },
    params: routeParams,
    query: routeQuery,
  }),
}));

vi.mock("@/daemon/client", () => ({
  daemonClient: {
    initialize: initializeMock,
    getHealth: getHealthMock,
    getReady: getReadyMock,
    getEffectiveRuntimeConfiguration: getEffectiveRuntimeConfigurationMock,
    getSaleStartCapability: getSaleStartCapabilityMock,
    getCurrentTransaction: getCurrentTransactionMock,
    getSaleView: getSaleViewMock,
    createOrder: createOrderMock,
  },
}));

vi.mock("@/native/vision", () => ({
  subscribeVisionProfiles: subscribeVisionProfilesMock,
  isVisionTryOnCapabilityDegraded: (error: unknown) =>
    error instanceof Error &&
    error.message.startsWith("vision try_on_unavailable:"),
}));

import type { TransactionSnapshot } from "@/daemon/schemas";
import type { VisionProfileSubscriptionHandlers } from "@/native/vision";
import type {
  MachineCatalogItem,
  MachineCatalogSlotCandidate,
} from "@/types/catalog";

import { resetCustomerInteractionSessionForTests } from "@/composables/customer-interaction-session";
import { resetStableVisionPresenceSessionForTests } from "@/composables/stable-vision-presence-session";
import {
  installVisionRecommendationCoordinator,
  type VisionRecommendationCoordinator,
} from "@/runtime/vision-recommendation-coordinator";
import { useCatalogStore } from "@/stores/catalog";
import { useCheckoutStore } from "@/stores/checkout";
import { useConnectivityStore } from "@/stores/connectivity";
import { useMachineStore } from "@/stores/machine";
import { useSaleCapabilityStore } from "@/stores/sale-capability";
import { useVisionStore } from "@/stores/vision";
import { saleCapabilitySnapshot } from "@/test-support/sale-capability";

import BootView from "./BootView.vue";
import CatalogView from "./CatalogView.vue";
import CheckoutView from "./CheckoutView.vue";
import PaymentView from "./PaymentView.vue";
import ProductDetailView from "./ProductDetailView.vue";

let mountedApp: App<Element> | null = null;
let pinia: ReturnType<typeof createPinia>;
let latestVisionHandlers: VisionProfileSubscriptionHandlers | null = null;
let propertyRestorers: Array<() => void> = [];
let capabilityRevision = 0;
let visionRecommendationCoordinator: VisionRecommendationCoordinator | null =
  null;

beforeEach(() => {
  resetCustomerInteractionSessionForTests();
  resetStableVisionPresenceSessionForTests();
  pinia = createPinia();
  setActivePinia(pinia);
  window.localStorage.clear();
  vi.clearAllMocks();
  capabilityRevision = 0;
  submitMachineNavigationIntentMock.mockImplementation(async (intent) => {
    if (intent.type === "customer.navigate") {
      routerPushMock(intent.target);
      return;
    }
    if (intent.type === "transaction.projection") {
      const target = useCheckoutStore().customerCheckoutView.routeTarget;
      routerReplaceMock("path" in target ? target.path : target);
      return;
    }
    if ("target" in intent) routerReplaceMock(intent.target);
  });
  for (const key of Object.keys(routeParams)) {
    delete routeParams[key];
  }
  for (const key of Object.keys(routeQuery)) {
    delete routeQuery[key];
  }
  routeName.value = "catalog";
  latestVisionHandlers = null;
  subscribeVisionProfilesMock.mockImplementation(
    (_config: unknown, handlers: VisionProfileSubscriptionHandlers) => {
      latestVisionHandlers = handlers;
      return { close: vi.fn() };
    },
  );
  initializeMock.mockResolvedValue(undefined);
  getSaleViewMock.mockRejectedValue(new Error("sale view not mocked"));
  getCurrentTransactionMock.mockResolvedValue({
    orderId: null,
    orderNo: null,
    productSummary: null,
    paymentId: null,
    paymentNo: null,
    paymentMethod: null,
    paymentProvider: null,
    paymentUrl: null,
    paymentStatus: null,
    orderStatus: null,
    totalAmountCents: null,
    vending: null,
    nextAction: null,
    maskedAuthCode: null,
    paymentCodeAttempt: null,
    expiresAt: null,
    errorCode: null,
    errorMessage: null,
    operatorHint: null,
    updatedAt: "2026-06-04T00:00:00Z",
  });
  getEffectiveRuntimeConfigurationMock.mockResolvedValue(
    effectiveRuntimeConfigurationFixture(),
  );
  getSaleStartCapabilityMock.mockResolvedValue(saleCapability(true));
  createOrderMock.mockResolvedValue(transactionSnapshot());
});

afterEach(() => {
  visionRecommendationCoordinator?.close();
  visionRecommendationCoordinator = null;
  resetCustomerInteractionSessionForTests();
  resetStableVisionPresenceSessionForTests();
  unmountMountedView();
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const restore of propertyRestorers.splice(0).reverse()) {
    restore();
  }
});

function unmountMountedView(): void {
  const app = mountedApp;
  if (app) {
    app.unmount();
  }
  mountedApp = null;
  document.body.innerHTML = "";
}

function requireElement<T extends Element>(
  host: HTMLElement,
  selector: string,
): T {
  const element = host.querySelector<T>(selector);
  expect(element).toBeTruthy();
  return element!;
}

function requireButtonByText(
  host: HTMLElement,
  text: string,
  match: "includes" | "exact" = "includes",
): HTMLButtonElement {
  const button = Array.from(
    host.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) =>
    match === "exact"
      ? candidate.textContent?.trim() === text
      : candidate.textContent?.includes(text),
  );
  expect(button).toBeTruthy();
  return button!;
}

function makeCatalogItem(): MachineCatalogItem {
  const item = {
    machineCode: "M001",
    slotId: "550e8400-e29b-41d4-a716-446655440001",
    slotDisplayLabel: "A1",
    rowNo: 1,
    cellNo: 1,
    inventoryId: "550e8400-e29b-41d4-a716-446655440002",
    variantId: "550e8400-e29b-41d4-a716-446655440003",
    productId: "550e8400-e29b-41d4-a716-446655440004",
    productName: "基础短袖",
    productDescription: null,
    coverImageUrl: null,
    categoryId: null,
    categoryName: "T恤 / 基础短袖",
    sku: "TEE-BASIC-M-BLACK",
    size: "M",
    color: "黑色",
    priceCents: 100,
    capacity: 8,
    parLevel: 6,
    physicalStock: 2,
    saleableStock: 2,
    slotSalesState: "sale_ready",
    productSortOrder: 1,
    targetGender: null,
  } as Omit<
    MachineCatalogItem,
    | "catalogKey"
    | "aggregatedSlotCount"
    | "slotCandidates"
    | "variantCandidates"
  >;
  const slotCandidates: readonly MachineCatalogSlotCandidate[] = [
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
    catalogKey: `product:${item.productId}`,
    aggregatedSlotCount: 1,
    slotCandidates,
    variantCandidates: [
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

function effectiveRuntimeConfigurationFixture(
  claimed = true,
): EffectiveMachineRuntimeConfiguration {
  const configuration = {
    schemaVersion: 1,
    generation: 1,
    sourceRevisions: {
      bootstrapSchemaVersion: 1,
      profile: claimed
        ? {
            generation: 1,
            profileRevision: 1,
            acceptedAt: "2026-07-17T00:00:00.000Z",
          }
        : null,
      localSettingsRevision: 0,
    },
    sourceDocuments: {
      bootstrap: {
        schemaVersion: 1,
        provisioningApiBaseUrl: "http://localhost:3000",
        hardwareModel: "test",
        topology: { identity: "test", version: "1" },
      },
      profileCache: claimed ? {} : null,
    },
    machine: claimed ? { code: "MACHINE-001" } : null,
    platform: null,
    hardware: {
      model: "test",
      topology: { identity: "test", version: "1" },
      expectedProfile: null,
      lowerControllerBinding: {
        identity: {
          identityKey: "container:11111111-2222-3333-4444-555555555555",
          instanceId: "USB\\VID_1A86&PID_55D3\\CTRL-001",
          containerId: "11111111-2222-3333-4444-555555555555",
          hardwareIds: ["USB\\VID_1A86&PID_55D3"],
          serialNumber: "CTRL-001",
        },
        confirmedAt: "2026-07-17T00:00:00.000Z",
        confirmedBy: "test",
        testEvidenceCode: "LOWER_CONTROLLER_READY",
      },
      scannerBinding: {
        identity: {
          identityKey: "container:22222222-3333-4444-5555-666666666666",
          instanceId: "USB\\VID_1234&PID_5678\\SCAN-001",
          containerId: "22222222-3333-4444-5555-666666666666",
          hardwareIds: ["USB\\VID_1234&PID_5678"],
          serialNumber: "SCAN-001",
        },
        confirmedAt: "2026-07-17T00:00:00.000Z",
        confirmedBy: "test",
        testEvidenceCode: "SCANNER_READY",
      },
      scannerProtocol: { baudRate: 9600, frameSuffix: "cr" },
    },
    experience: {
      audio: {
        volume: 0.7,
        cuesEnabled: false,
        presenceCuesEnabled: false,
        transactionCuesEnabled: false,
      },
    },
    secretStatus: {
      machineSecretConfigured: true,
      mqttSigningSecretConfigured: true,
      mqttPasswordConfigured: false,
    },
    profileRefresh: {
      status: claimed ? "accepted" : "unclaimed",
      lastError: null,
    },
  };
  return configuration as unknown as EffectiveMachineRuntimeConfiguration;
}

function applyVisionTryOnConfig(): void {
  useMachineStore().applyEffectiveRuntimeConfiguration(
    effectiveRuntimeConfigurationFixture(),
  );
}

function transactionSnapshot(
  overrides: Partial<TransactionSnapshot> = {},
): TransactionSnapshot {
  return {
    orderId: "550e8400-e29b-41d4-a716-446655440010",
    orderNo: "ORD-PRIVACY-001",
    productSummary: null,
    paymentId: null,
    paymentNo: "PAY-PRIVACY-001",
    paymentMethod: "qr_code",
    paymentProvider: "alipay",
    paymentUrl: "https://pay.example/1",
    paymentStatus: "pending",
    orderStatus: "pending_payment",
    totalAmountCents: 100,
    vending: null,
    nextAction: "wait_payment",
    maskedAuthCode: null,
    paymentCodeAttempt: null,
    expiresAt: "2026-06-04T00:05:00Z",
    errorCode: null,
    errorMessage: null,
    operatorHint: null,
    updatedAt: "2026-06-04T00:00:00Z",
    ...overrides,
  } as TransactionSnapshot;
}

function applySensitiveVisionProfile(): void {
  useVisionStore().applyLatestProfileResult({
    source: "front",
    eventId: "vision-event-001",
    detectedAt: "2026-06-12T10:20:30.000Z",
    profile: {
      personPresent: true,
      heightCm: 172,
      bodyType: "regular",
      upperColor: "blue",
      confidence: 0.91,
    },
    quality: {
      overall: "good",
      warnings: ["light glare"],
      profileUsable: true,
    },
  });
}

function expectRecognitionDetailsHidden(host: HTMLElement): void {
  expect(host.textContent).not.toContain("vision-event-001");
  expect(host.textContent).not.toContain("172 cm");
  expect(host.textContent).not.toContain("light glare");
  expect(host.textContent).not.toContain('"heightCm": 172');
  expect(host.textContent).not.toContain('"confidence": 0.91');
}

function healthSnapshot() {
  return {
    status: "healthy" as const,
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
    updatedAt: "2026-06-04T00:00:00Z",
  };
}

function saleCapability(canStartSale: boolean) {
  return saleCapabilitySnapshot({
    canStartSale,
    revision: ++capabilityRevision,
    blockerCode: "PLATFORM_UNREACHABLE",
  });
}

function applyBlockedCapability(): void {
  const health = {
    status: "healthy" as const,
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
    backendOnline: false,
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
  const capability = saleCapability(false);
  getHealthMock.mockResolvedValue(health);
  getSaleStartCapabilityMock.mockResolvedValue(capability);
  useConnectivityStore().applyHealth(health);
  useSaleCapabilityStore().acceptSnapshot(capability);
}

async function mountView(component: object): Promise<HTMLElement> {
  visionRecommendationCoordinator ??=
    installVisionRecommendationCoordinator(pinia);
  const host = document.createElement("div");
  document.body.append(host);
  mountedApp = createApp(component);
  mountedApp.use(pinia);
  mountedApp.mount(host);
  await nextTick();
  await nextTick();
  return host;
}

describe("sale-start capability UI flow", () => {
  it("routes first boot machines without provisioning to Local Operations", async () => {
    getHealthMock.mockResolvedValue({
      ...healthSnapshot(),
      configConfigured: false,
    });
    getSaleStartCapabilityMock.mockResolvedValue(saleCapability(false));
    getEffectiveRuntimeConfigurationMock.mockResolvedValue(
      effectiveRuntimeConfigurationFixture(false),
    );

    await mountView(BootView);

    await vi.waitFor(() => {
      expect(routerReplaceMock).toHaveBeenCalledWith("/maintenance");
    });
    expect(getReadyMock).not.toHaveBeenCalled();
  });

  it("keeps an unknown startup config failure on the customer offline surface", async () => {
    getHealthMock.mockResolvedValue(healthSnapshot());
    getSaleStartCapabilityMock.mockResolvedValue(saleCapability(true));
    getEffectiveRuntimeConfigurationMock.mockRejectedValue(
      new Error("runtime configuration unavailable"),
    );

    await mountView(BootView);

    await vi.waitFor(() => {
      expect(routerReplaceMock).toHaveBeenCalledWith("/offline");
    });
    expect(routerReplaceMock).not.toHaveBeenCalledWith("/catalog");
  });

  it("keeps a fresh-store daemon outage on the customer offline surface", async () => {
    initializeMock.mockRejectedValue(new Error("daemon unavailable"));
    expect(useMachineStore().effectiveRuntimeConfiguration).toBeNull();

    await mountView(BootView);

    await vi.waitFor(() => {
      expect(routerReplaceMock).toHaveBeenCalledWith("/offline");
    });
    expect(routerReplaceMock).not.toHaveBeenCalledWith("/maintenance");
  });

  it("keeps a known claimed machine on the customer offline surface when daemon IPC is unavailable", async () => {
    useMachineStore().applyEffectiveRuntimeConfiguration(
      effectiveRuntimeConfigurationFixture(true),
    );
    getHealthMock.mockRejectedValue(new Error("daemon unavailable"));
    getEffectiveRuntimeConfigurationMock.mockRejectedValue(
      new Error("daemon unavailable"),
    );

    await mountView(BootView);

    await vi.waitFor(() => {
      expect(routerReplaceMock).toHaveBeenCalledWith("/offline");
    });
    expect(routerReplaceMock).not.toHaveBeenCalledWith("/maintenance");
  });

  it("keeps accepted effective configuration as startup authority when sale-start-capability decoding fails", async () => {
    getHealthMock.mockResolvedValue(healthSnapshot());
    getSaleStartCapabilityMock.mockRejectedValue(
      new Error(
        "sale-start capability decoder rejected a stale daemon projection",
      ),
    );
    getEffectiveRuntimeConfigurationMock.mockResolvedValue(
      effectiveRuntimeConfigurationFixture(true),
    );

    await mountView(BootView);

    await vi.waitFor(() => {
      expect(routerReplaceMock).toHaveBeenCalledWith("/catalog");
    });
    expect(
      useMachineStore().effectiveRuntimeConfiguration?.profileRefresh.status,
    ).toBe("accepted");
  });

  it("does not replace a submitted catalog startup decision with offline when navigation rejects", async () => {
    submitMachineNavigationIntentMock.mockImplementationOnce(async (intent) => {
      if ("target" in intent) routerReplaceMock(intent.target);
      throw new Error(
        "catalog component navigation rejected after route write",
      );
    });

    await mountView(BootView);

    await vi.waitFor(() => {
      expect(routerReplaceMock).toHaveBeenCalledWith("/catalog");
    });
    await nextTick();
    expect(submitMachineNavigationIntentMock).toHaveBeenCalledOnce();
    expect(routerReplaceMock).not.toHaveBeenCalledWith("/offline");
  });

  it("does not render raw current-transaction parse errors during boot", async () => {
    getHealthMock.mockResolvedValue(healthSnapshot());
    getSaleStartCapabilityMock.mockResolvedValue(saleCapability(true));
    getCurrentTransactionMock.mockRejectedValue(
      new Error("ZodError: Invalid enum value at nextAction"),
    );

    const host = await mountView(BootView);

    await vi.waitFor(() => {
      expect(routerReplaceMock).toHaveBeenCalledWith("/offline");
    });
    expect(host.textContent).toContain("本机运行服务不可用，进入离线页面");
    expect(host.textContent).not.toContain("ZodError");
    expect(host.textContent).not.toContain("Invalid enum value");
  });

  it("does not let delayed boot reads navigate after the boot component is gone", async () => {
    const pendingHealth: {
      resolve: ((value: ReturnType<typeof healthSnapshot>) => void) | null;
    } = { resolve: null };
    getHealthMock.mockReturnValue(
      new Promise<ReturnType<typeof healthSnapshot>>((resolve) => {
        pendingHealth.resolve = resolve;
      }),
    );

    await mountView(BootView);
    await vi.waitFor(() => {
      expect(getCurrentTransactionMock).toHaveBeenCalledOnce();
    });
    mountedApp?.unmount();
    mountedApp = null;
    pendingHealth.resolve?.(healthSnapshot());
    await nextTick();
    await nextTick();

    expect(routerReplaceMock).not.toHaveBeenCalled();
  });

  it("does not reopen a dismissed successful terminal transaction during boot after a fresh reload", async () => {
    const dismissedTransaction: TransactionSnapshot = {
      orderId: "550e8400-e29b-41d4-a716-446655440010",
      orderNo: "ORD-DISMISSED-001",
      productSummary: null,
      paymentId: null,
      paymentNo: "PAY-DISMISSED-001",
      paymentMethod: "payment_code",
      paymentProvider: "alipay",
      paymentUrl: null,
      paymentStatus: "succeeded",
      orderStatus: "fulfilled",
      totalAmountCents: 4900,
      vending: {
        commandId: null,
        commandNo: "CMD-DISMISSED",
        status: "succeeded",
        lastError: null,
      },
      nextAction: "success",
      maskedAuthCode: null,
      paymentCodeAttempt: null,
      expiresAt: "2026-06-04T00:05:00Z",
      errorCode: null,
      errorMessage: null,
      operatorHint: null,
      updatedAt: "2026-06-04T00:10:00Z",
    };
    getHealthMock.mockResolvedValue(healthSnapshot());
    getReadyMock.mockResolvedValue(readySnapshot());
    getSaleStartCapabilityMock.mockResolvedValue(saleCapability(true));
    getCurrentTransactionMock.mockResolvedValue(dismissedTransaction);
    getSaleViewMock.mockResolvedValue({
      items: [makeCatalogItem()],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
    });
    const checkoutStore = useCheckoutStore();
    checkoutStore.applyTransaction(dismissedTransaction);
    checkoutStore.dismissCurrentTerminalTransaction();
    checkoutStore.reset();

    pinia = createPinia();
    setActivePinia(pinia);
    const reloadedCheckoutStore = useCheckoutStore();
    expect(
      reloadedCheckoutStore.shouldIgnoreTransaction(dismissedTransaction),
    ).toBe(true);

    await mountView(BootView);

    await vi.waitFor(() => {
      expect(routerReplaceMock).toHaveBeenCalledWith("/catalog");
    });
    expect(routerReplaceMock).not.toHaveBeenCalledWith({
      name: "result",
      params: { kind: "success" },
    });
    expect(reloadedCheckoutStore.customerCheckoutView).toMatchObject({
      stage: "none",
      routeTarget: { name: "catalog" },
      orderCredential: null,
      result: null,
    });
  });

  it("keeps catalog products visible and navigable when readiness is blocked", async () => {
    const item = makeCatalogItem();
    useCatalogStore().applySnapshot({
      items: [item],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
    });
    applyBlockedCapability();

    const host = await mountView(CatalogView);

    expect(host.textContent).toContain("T恤");
    expect(host.textContent).toContain("网络连接暂时不可用，请稍后再试。");
    expect(host.textContent).not.toContain("platform offline");
    expect(host.querySelector(".catalog-notification-icon")).toBeTruthy();
    expect(
      Array.from(host.querySelectorAll("button")).some(
        (button) => button.textContent?.trim() === "刷新",
      ),
    ).toBe(false);
    const categoryButton = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("T恤"),
    );
    expect(categoryButton).toBeTruthy();
    expect(categoryButton?.disabled).toBe(false);

    categoryButton!.click();
    await nextTick();

    expect(host.textContent).toContain("基础短袖");
    expect(host.textContent).toContain("颜色");
    expect(host.textContent).toContain("尺码");
    expect(routerPushMock).not.toHaveBeenCalled();
  });

  it("keeps three sold-out category cards fixed and uses the single notice surface", async () => {
    const soldOut = (categoryName: string, productId: string) => ({
      ...makeCatalogItem(),
      productId,
      categoryName,
      physicalStock: 0,
      saleableStock: 0,
      slotSalesState: "sold_out" as const,
    });
    useCatalogStore().applySnapshot({
      items: [
        soldOut("袜子", "550e8400-e29b-41d4-a716-446655440041"),
        soldOut("内裤", "550e8400-e29b-41d4-a716-446655440042"),
        soldOut("T恤", "550e8400-e29b-41d4-a716-446655440043"),
      ],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
    });
    useConnectivityStore().applyHealth(healthSnapshot());
    useConnectivityStore().applyReady(readySnapshot());
    useSaleCapabilityStore().acceptSnapshot(saleCapability(true));
    getHealthMock.mockResolvedValue(healthSnapshot());
    getReadyMock.mockResolvedValue(readySnapshot());
    getSaleStartCapabilityMock.mockResolvedValue(saleCapability(true));

    const host = await mountView(CatalogView);

    expect(host.querySelectorAll(".home-category-card")).toHaveLength(3);
    expect(
      Array.from(
        host.querySelectorAll<HTMLButtonElement>(".home-category-card"),
      ).every((card) => card.disabled),
    ).toBe(true);
    expect(host.textContent).toContain("暂无可售商品");
    expect(host.querySelectorAll(".catalog-notification")).toHaveLength(1);
    expect(host.querySelector(".home-empty-message")).toBeNull();
  });

  it("keeps the catalog saleable when one managed product image fails", async () => {
    const item = {
      ...makeCatalogItem(),
      coverImageUrl:
        "/api/media-assets/550e8400-e29b-41d4-a716-446655440124/content",
    };
    useCatalogStore().applySnapshot({
      items: [item],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
    });
    getHealthMock.mockResolvedValue(healthSnapshot());
    getReadyMock.mockResolvedValue(readySnapshot());
    getSaleStartCapabilityMock.mockResolvedValue(saleCapability(true));

    const host = await mountView(CatalogView);
    requireButtonByText(host, "T恤").click();
    await nextTick();

    const productImage = requireElement<HTMLImageElement>(
      host,
      ".product-image-panel img",
    );
    productImage.dispatchEvent(new Event("error"));
    await nextTick();

    expect(productImage.getAttribute("src")).toContain("icon-tshirt");
    expect(host.textContent).toContain("基础短袖");
    expect(useCatalogStore().mediaDiagnostics).toEqual([
      expect.objectContaining({
        reference: item.coverImageUrl,
        message: "managed media is not ready",
      }),
    ]);
  });

  it("keeps one media diagnostic through invalid-client normalization and the catalog placeholder", async () => {
    const item = {
      ...makeCatalogItem(),
      coverImageUrl: null,
    };
    const locationKey = `media:${item.slotId}:coverImageUrl`;
    const invalidReference = "https://forged.example/product.png";
    useCatalogStore().applySnapshot({
      items: [item],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
      mediaDiagnostics: [
        {
          reference: invalidReference,
          diagnosticKey: `${locationKey}:invalid:${invalidReference}`,
          message:
            "daemon sale view contained an invalid coverImageUrl managed media reference",
        },
      ],
    });
    getHealthMock.mockResolvedValue(healthSnapshot());
    getReadyMock.mockResolvedValue(readySnapshot());
    getSaleStartCapabilityMock.mockResolvedValue(saleCapability(true));

    const host = await mountView(CatalogView);
    requireButtonByText(host, "T恤").click();
    await nextTick();

    expect(useCatalogStore().mediaDiagnostics).toEqual([
      expect.objectContaining({
        diagnosticKey: `${locationKey}:invalid:${invalidReference}`,
        reference: invalidReference,
      }),
    ]);
    expect(host.querySelector(".product-image-fallback")).toBeTruthy();
  });

  it("opens catalog product detail without selecting a checkout item", async () => {
    const item = makeCatalogItem();
    useCatalogStore().applySnapshot({
      items: [item],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
    });

    const host = await mountView(CatalogView);

    const categoryButton = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("T恤"),
    );
    expect(categoryButton).toBeTruthy();
    categoryButton!.click();
    await nextTick();

    const productButton = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("基础短袖"),
    );
    expect(productButton).toBeTruthy();
    productButton!.click();
    await nextTick();

    expect(routerPushMock).toHaveBeenCalledWith({
      name: "product-detail",
      params: { catalogKey: item.catalogKey },
    });
    expect(useCheckoutStore().selectedItem).toBeNull();
    expect(useCheckoutStore().customerCheckoutView.stage).toBe("none");
  });

  it("orders and selects catalog recommendations from a usable Vision profile with stable fallback", async () => {
    const mediumItem = makeCatalogItem();
    const largeBase = {
      ...mediumItem,
      slotId: "550e8400-e29b-41d4-a716-446655440031",
      slotDisplayLabel: "A2",
      inventoryId: "550e8400-e29b-41d4-a716-446655440032",
      variantId: "550e8400-e29b-41d4-a716-446655440033",
      productId: "550e8400-e29b-41d4-a716-446655440034",
      productName: "宽松短袖",
      sku: "TEE-RELAXED-L-BLUE",
      size: "L",
      color: "深蓝色",
      productSortOrder: 2,
    };
    const largeSlot = {
      ...mediumItem.slotCandidates[0],
      slotId: largeBase.slotId,
      slotDisplayLabel: largeBase.slotDisplayLabel,
      inventoryId: largeBase.inventoryId,
      variantId: largeBase.variantId,
      sku: largeBase.sku,
      size: largeBase.size,
      color: largeBase.color,
    };
    const largeItem: MachineCatalogItem = {
      ...largeBase,
      catalogKey: `product:${largeBase.productId}`,
      slotCandidates: [largeSlot],
      variantCandidates: [
        {
          ...mediumItem.variantCandidates[0],
          variantId: largeBase.variantId,
          sku: largeBase.sku,
          size: largeBase.size,
          color: largeBase.color,
          slotCandidates: [largeSlot],
        },
      ],
    };
    useCatalogStore().applySnapshot({
      items: [mediumItem, largeItem],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
    });
    applyVisionTryOnConfig();

    const host = await mountView(CatalogView);
    requireButtonByText(host, "T恤").click();
    await nextTick();
    expect(
      Array.from(host.querySelectorAll('[data-test="catalog-product"]')).map(
        (element) => element.getAttribute("data-catalog-key"),
      ),
    ).toEqual([mediumItem.catalogKey, largeItem.catalogKey]);

    await Promise.resolve(
      latestVisionHandlers?.onProfile({
        source: "front",
        eventId: "vision-recommendation-001",
        detectedAt: "2026-07-18T10:00:00.000Z",
        occupancy: { state: "single", confidence: 0.94 },
        profile: {
          personPresent: true,
          heightCm: 178,
          bodyType: "regular",
          upperColor: "蓝",
          confidence: 0.94,
        },
        quality: {
          overall: "good",
          warnings: [],
          profileUsable: true,
        },
      } as Parameters<
        NonNullable<typeof latestVisionHandlers>["onProfile"]
      >[0]),
    );
    await nextTick();

    const recommendedProducts = Array.from<HTMLButtonElement>(
      host.querySelectorAll('[data-test="catalog-product"]'),
    );
    expect(
      recommendedProducts.map((element) =>
        element.getAttribute("data-catalog-key"),
      ),
    ).toEqual([largeItem.catalogKey, mediumItem.catalogKey]);
    recommendedProducts[0].click();
    await nextTick();
    expect(routerPushMock).toHaveBeenLastCalledWith({
      name: "product-detail",
      params: { catalogKey: largeItem.catalogKey },
      query: { variantId: largeItem.variantId },
    });

    await Promise.resolve(
      latestVisionHandlers?.onProfile({
        source: "front",
        eventId: "vision-recommendation-low-confidence",
        detectedAt: "2026-07-18T10:00:01.000Z",
        occupancy: { state: "single", confidence: 0.3 },
        profile: {
          personPresent: true,
          heightCm: 178,
          bodyType: "regular",
          upperColor: "蓝",
          confidence: 0.3,
        },
        quality: { overall: "poor", warnings: [], profileUsable: false },
      } as Parameters<
        NonNullable<typeof latestVisionHandlers>["onProfile"]
      >[0]),
    );
    await nextTick();
    expect(
      Array.from(host.querySelectorAll('[data-test="catalog-product"]')).map(
        (element) => element.getAttribute("data-catalog-key"),
      ),
    ).toEqual([mediumItem.catalogKey, largeItem.catalogKey]);
  });

  it("keeps the fixed catalog home through repeated readiness changes", async () => {
    const item = makeCatalogItem();
    const blockedHealth = {
      ...healthSnapshot(),
      status: "degraded" as const,
      hardwareOnline: false,
      operatorReason: "LOWER_CONTROLLER_UNAVAILABLE",
    };
    useCatalogStore().applySnapshot({
      items: [item],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
    });
    getSaleViewMock.mockResolvedValue({
      items: [item],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
    });
    getHealthMock.mockResolvedValue(blockedHealth);
    const blockedCapability = saleCapability(false);
    getSaleStartCapabilityMock.mockResolvedValue(blockedCapability);
    useSaleCapabilityStore().acceptSnapshot(blockedCapability);
    applyVisionTryOnConfig();

    await mountView(CatalogView);

    expect(routerReplaceMock).not.toHaveBeenCalled();
    expect(document.querySelectorAll(".home-category-card")).toHaveLength(3);

    await Promise.resolve(
      latestVisionHandlers?.onProfile({
        source: "front",
        eventId: "presence-before-refresh",
        detectedAt: "2026-07-14T00:00:00.000Z",
        occupancy: { state: "single", confidence: 0.9 },
        profile: {
          personPresent: true,
          heightCm: 170,
          shoulderWidthCm: 42,
          ageRange: "adult",
          gender: "unknown",
          bodyType: "regular",
          upperColor: "black",
          confidence: 0.9,
        },
        quality: { overall: "good", warnings: [], profileUsable: true },
      } as Parameters<
        NonNullable<typeof latestVisionHandlers>["onProfile"]
      >[0]),
    );
    await nextTick();
    expect(document.querySelector(".presence-present")).toBeTruthy();

    useSaleCapabilityStore().acceptSnapshot(saleCapability(true));
    useSaleCapabilityStore().acceptSnapshot(saleCapability(false));
    await nextTick();

    expect(routerReplaceMock).not.toHaveBeenCalled();
    expect(document.querySelectorAll(".home-category-card")).toHaveLength(3);
    expect(document.querySelector(".presence-present")).toBeTruthy();
  });

  it("keeps vision recognition details silent in the catalog", async () => {
    const item = makeCatalogItem();
    useCatalogStore().applySnapshot({
      items: [{ ...item, size: "M", targetGender: "male" }],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
    });
    applyVisionTryOnConfig();

    const host = await mountView(CatalogView);

    expect(latestVisionHandlers).toBeTruthy();
    await Promise.resolve(
      latestVisionHandlers?.onProfile({
        source: "front",
        eventId: "vision-event-001",
        detectedAt: "2026-06-12T10:20:30.000Z",
        occupancy: { state: "single", confidence: 0.91 },
        profile: {
          personPresent: true,
          heightCm: 172,
          shoulderWidthCm: 43,
          ageRange: "adult",
          gender: "male",
          bodyType: "regular",
          upperColor: "blue",
          confidence: 0.91,
        },
        quality: {
          overall: "good",
          warnings: ["light glare"],
          profileUsable: true,
        },
      } as Parameters<
        NonNullable<typeof latestVisionHandlers>["onProfile"]
      >[0]),
    );
    await nextTick();

    expect(host.querySelector(".presence-present")).toBeTruthy();
    expect(host.textContent).not.toContain("视觉识别结果");
    expect(host.textContent).not.toContain("vision-event-001");
    expect(host.textContent).not.toContain("172 cm");
    expect(host.textContent).not.toContain("light glare");
    expect(host.textContent).not.toContain('"heightCm": 172');
    expect(host.textContent).toContain("T恤");
  });

  it("keeps vision recognition details silent in the product detail page", async () => {
    const item = makeCatalogItem();
    useCatalogStore().applySnapshot({
      items: [{ ...item, size: "M", targetGender: "male" }],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
    });
    routeParams.catalogKey = item.catalogKey;
    useSaleCapabilityStore().acceptSnapshot(saleCapability(true));
    useSaleCapabilityStore().acceptSnapshot(saleCapability(true));
    applySensitiveVisionProfile();

    const host = await mountView(ProductDetailView);

    expect(host.textContent).toContain("基础短袖");
    expectRecognitionDetailsHidden(host);
  });

  it("updates the visible product detail stock when sale-view stock changes", async () => {
    const item = makeCatalogItem();
    const catalogStore = useCatalogStore();
    catalogStore.applySnapshot({
      items: [{ ...item, saleableStock: 2, physicalStock: 2 }],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
    });
    routeParams.catalogKey = item.catalogKey;
    useSaleCapabilityStore().acceptSnapshot(saleCapability(true));

    const host = await mountView(ProductDetailView);

    const stock = requireElement<HTMLElement>(
      host,
      '[data-test="product-detail-stock"]',
    );
    expect(stock.getAttribute("data-saleable-stock")).toBe("2");
    expect(stock.textContent).toContain("2");

    catalogStore.applySnapshot({
      items: [{ ...item, saleableStock: 1, physicalStock: 1 }],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:01Z",
    });
    await nextTick();

    expect(stock.getAttribute("data-saleable-stock")).toBe("1");
    expect(stock.textContent).toContain("1");
  });

  it("presents only a matched automatic size recommendation until the customer chooses manually", async () => {
    const mediumItem = makeCatalogItem();
    const largeItem: MachineCatalogItem = {
      ...mediumItem,
      slotId: "550e8400-e29b-41d4-a716-446655440021",
      slotDisplayLabel: "A2",
      inventoryId: "550e8400-e29b-41d4-a716-446655440022",
      variantId: "550e8400-e29b-41d4-a716-446655440023",
      sku: "TEE-BASIC-L-BLUE",
      size: "L",
      color: "蓝色",
      slotCandidates: [
        {
          ...mediumItem.slotCandidates[0],
          slotId: "550e8400-e29b-41d4-a716-446655440021",
          slotDisplayLabel: "A2",
          inventoryId: "550e8400-e29b-41d4-a716-446655440022",
          variantId: "550e8400-e29b-41d4-a716-446655440023",
          sku: "TEE-BASIC-L-BLUE",
          size: "L",
          color: "蓝色",
        },
      ],
      variantCandidates: [],
    };
    useCatalogStore().applySnapshot({
      items: [mediumItem, largeItem],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
    });
    routeParams.catalogKey = mediumItem.catalogKey;
    routeQuery.variantId = largeItem.variantId;
    applyVisionTryOnConfig();

    const host = await mountView(ProductDetailView);
    await Promise.resolve(
      latestVisionHandlers?.onProfile({
        source: "front",
        eventId: "vision-recommendation-low-confidence-detail",
        detectedAt: "2026-07-18T09:59:59.000Z",
        occupancy: { state: "single", confidence: 0.3 },
        profile: {
          personPresent: true,
          heightCm: 178,
          bodyType: "regular",
          upperColor: "蓝",
          confidence: 0.3,
        },
        quality: { overall: "poor", warnings: [], profileUsable: false },
      } as Parameters<
        NonNullable<typeof latestVisionHandlers>["onProfile"]
      >[0]),
    );
    await nextTick();

    const page = requireElement<HTMLElement>(
      host,
      '[data-test="product-detail-page"]',
    );
    expect(page.getAttribute("data-vision-recommendation-active")).toBe(
      "false",
    );
    expect(page.getAttribute("data-variant-id")).toBe(mediumItem.variantId);

    await Promise.resolve(
      latestVisionHandlers?.onProfile({
        source: "front",
        eventId: "vision-recommendation-detail",
        detectedAt: "2026-07-18T10:00:00.000Z",
        occupancy: { state: "single", confidence: 0.94 },
        profile: {
          personPresent: true,
          heightCm: 178,
          bodyType: "regular",
          upperColor: "蓝",
          confidence: 0.94,
        },
        quality: { overall: "good", warnings: [], profileUsable: true },
      } as Parameters<
        NonNullable<typeof latestVisionHandlers>["onProfile"]
      >[0]),
    );
    await nextTick();

    const recommendedSize = requireElement<HTMLButtonElement>(
      host,
      '[data-test="product-size-option"][data-size="L"]',
    );
    expect(page.getAttribute("data-vision-recommendation-active")).toBe("true");
    expect(page.getAttribute("data-variant-id")).toBe(largeItem.variantId);
    expect(recommendedSize.classList).toContain("option-pill-recommended");

    requireElement<HTMLButtonElement>(
      host,
      '[data-test="product-size-option"][data-size="M"]',
    ).click();
    await nextTick();

    expect(page.getAttribute("data-vision-recommendation-active")).toBe(
      "false",
    );
    expect(
      requireElement<HTMLButtonElement>(
        host,
        '[data-test="product-size-option"][data-size="M"]',
      ).classList,
    ).toContain("option-pill-active");
    expect(recommendedSize.classList).not.toContain("option-pill-recommended");

    await Promise.resolve(
      latestVisionHandlers?.onProfile({
        source: "front",
        eventId: "vision-recommendation-low-confidence-detail",
        detectedAt: "2026-07-18T10:00:01.000Z",
        occupancy: { state: "single", confidence: 0.3 },
        profile: {
          personPresent: true,
          heightCm: 178,
          bodyType: "regular",
          upperColor: "蓝",
          confidence: 0.3,
        },
        quality: { overall: "poor", warnings: [], profileUsable: false },
      } as Parameters<
        NonNullable<typeof latestVisionHandlers>["onProfile"]
      >[0]),
    );
    await nextTick();

    expect(page.getAttribute("data-vision-recommendation-active")).toBe(
      "false",
    );
    expect(recommendedSize.classList).not.toContain("option-pill-recommended");
  });

  it("records a selected product when a sale-ready product is explicitly selected", async () => {
    const item = makeCatalogItem();
    useCatalogStore().applySnapshot({
      items: [item],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
    });
    routeParams.catalogKey = item.catalogKey;
    useSaleCapabilityStore().acceptSnapshot(saleCapability(true));

    const host = await mountView(ProductDetailView);

    const buyButton = requireButtonByText(host, "立即购买");
    expect(buyButton.disabled).toBe(false);
    buyButton.click();
    await nextTick();

    expect(routerPushMock).toHaveBeenCalledWith({ name: "checkout" });
    expect(useCheckoutStore().selectedItem?.catalogKey).toBe(item.catalogKey);
    expect(useCheckoutStore().checkoutAttemptIdempotencyKey).toEqual(
      expect.any(String),
    );
  });

  it("keeps a saleable manual variant through same-product catalog snapshots and reconnect refresh", async () => {
    const mediumItem = makeCatalogItem();
    const largeItem: MachineCatalogItem = {
      ...mediumItem,
      slotId: "550e8400-e29b-41d4-a716-446655440021",
      slotDisplayLabel: "A2",
      inventoryId: "550e8400-e29b-41d4-a716-446655440022",
      variantId: "550e8400-e29b-41d4-a716-446655440023",
      sku: "TEE-BASIC-L-WHITE",
      size: "L",
      color: "白色",
      slotCandidates: [
        {
          ...mediumItem.slotCandidates[0],
          slotId: "550e8400-e29b-41d4-a716-446655440021",
          slotDisplayLabel: "A2",
          inventoryId: "550e8400-e29b-41d4-a716-446655440022",
          variantId: "550e8400-e29b-41d4-a716-446655440023",
          sku: "TEE-BASIC-L-WHITE",
          size: "L",
          color: "白色",
        },
      ],
      variantCandidates: [],
    };
    const initialSnapshot = {
      items: [mediumItem, largeItem],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-07-22T10:00:00Z",
    };
    const refreshedSnapshot = {
      ...initialSnapshot,
      source: "daemon_reconnect",
      lastUpdatedAt: "2026-07-22T10:01:00Z",
    };
    useCatalogStore().applySnapshot(initialSnapshot);
    routeParams.catalogKey = mediumItem.catalogKey;

    const host = await mountView(ProductDetailView);
    requireButtonByText(host, "L", "exact").click();
    await nextTick();
    expect(
      requireElement<HTMLElement>(
        host,
        '[data-test="product-detail-page"]',
      ).getAttribute("data-variant-id"),
    ).toBe(largeItem.variantId);

    useCatalogStore().applySnapshot({
      ...initialSnapshot,
      lastUpdatedAt: "2026-07-22T10:00:30Z",
    });
    await nextTick();
    expect(
      requireElement<HTMLElement>(
        host,
        '[data-test="product-detail-page"]',
      ).getAttribute("data-variant-id"),
    ).toBe(largeItem.variantId);

    getSaleViewMock.mockResolvedValue(refreshedSnapshot);
    await useCatalogStore().refresh();
    await nextTick();
    expect(
      requireElement<HTMLElement>(
        host,
        '[data-test="product-detail-page"]',
      ).getAttribute("data-variant-id"),
    ).toBe(largeItem.variantId);
  });

  it("styles a recommendation only when Vision matches an available size", async () => {
    const mediumItem = makeCatalogItem();
    const largeItem: MachineCatalogItem = {
      ...mediumItem,
      slotId: "550e8400-e29b-41d4-a716-446655440021",
      slotDisplayLabel: "A2",
      inventoryId: "550e8400-e29b-41d4-a716-446655440022",
      variantId: "550e8400-e29b-41d4-a716-446655440023",
      sku: "TEE-BASIC-L-BLUE",
      size: "L",
      color: "蓝色",
      slotCandidates: [
        {
          ...mediumItem.slotCandidates[0],
          slotId: "550e8400-e29b-41d4-a716-446655440021",
          slotDisplayLabel: "A2",
          inventoryId: "550e8400-e29b-41d4-a716-446655440022",
          variantId: "550e8400-e29b-41d4-a716-446655440023",
          sku: "TEE-BASIC-L-BLUE",
          size: "L",
          color: "蓝色",
        },
      ],
      variantCandidates: [],
    };
    useCatalogStore().applySnapshot({
      items: [mediumItem, largeItem],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-07-22T10:00:00Z",
    });
    routeParams.catalogKey = mediumItem.catalogKey;
    applyVisionTryOnConfig();

    const host = await mountView(ProductDetailView);
    const page = requireElement<HTMLElement>(
      host,
      '[data-test="product-detail-page"]',
    );

    await Promise.resolve(
      latestVisionHandlers?.onProfile({
        source: "front",
        eventId: "vision-missing-height",
        detectedAt: "2026-07-22T10:00:01Z",
        profile: {
          personPresent: true,
          upperColor: "黑",
          confidence: 0.94,
        },
        quality: { overall: "good", warnings: [], profileUsable: true },
      } as Parameters<
        NonNullable<typeof latestVisionHandlers>["onProfile"]
      >[0]),
    );
    await nextTick();
    expect(page.getAttribute("data-vision-recommendation-active")).toBe(
      "false",
    );

    await Promise.resolve(
      latestVisionHandlers?.onProfile({
        source: "front",
        eventId: "vision-unavailable-size",
        detectedAt: "2026-07-22T10:00:02Z",
        profile: {
          personPresent: true,
          heightCm: 190,
          bodyType: "regular",
          upperColor: "黑",
          confidence: 0.94,
        },
        quality: { overall: "good", warnings: [], profileUsable: true },
      } as Parameters<
        NonNullable<typeof latestVisionHandlers>["onProfile"]
      >[0]),
    );
    await nextTick();
    expect(page.getAttribute("data-vision-recommendation-active")).toBe(
      "false",
    );

    await Promise.resolve(
      latestVisionHandlers?.onProfile({
        source: "front",
        eventId: "vision-size-match",
        detectedAt: "2026-07-22T10:00:03Z",
        profile: {
          personPresent: true,
          heightCm: 178,
          bodyType: "regular",
          upperColor: "蓝",
          confidence: 0.94,
        },
        quality: { overall: "good", warnings: [], profileUsable: true },
      } as Parameters<
        NonNullable<typeof latestVisionHandlers>["onProfile"]
      >[0]),
    );
    await nextTick();

    const recommendedSize = requireElement<HTMLButtonElement>(
      host,
      '[data-test="product-size-option"][data-size="L"]',
    );
    expect(page.getAttribute("data-vision-recommendation-active")).toBe("true");
    expect(page.getAttribute("data-variant-id")).toBe(largeItem.variantId);
    expect(recommendedSize.classList).toContain("option-pill-recommended");
  });

  it("routes frozen defaults to a sale-ready alternate and blocks the all-unavailable product detail", async () => {
    const frozenDefault = {
      ...makeCatalogItem(),
      saleableStock: 0,
      physicalStock: 3,
      slotSalesState: "frozen" as const,
    };
    const saleReadyAlternate: MachineCatalogItem = {
      ...frozenDefault,
      slotId: "550e8400-e29b-41d4-a716-446655440041",
      slotDisplayLabel: "B1",
      inventoryId: "550e8400-e29b-41d4-a716-446655440042",
      variantId: "550e8400-e29b-41d4-a716-446655440043",
      sku: "TEE-BASIC-L-BLUE",
      size: "L",
      color: "蓝色",
      saleableStock: 2,
      physicalStock: 2,
      slotSalesState: "sale_ready",
    };
    const snapshot = {
      source: "local_stock" as const,
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-07-22T00:00:00Z",
    };
    useCatalogStore().applySnapshot({
      ...snapshot,
      items: [frozenDefault, saleReadyAlternate],
    });
    useSaleCapabilityStore().acceptSnapshot(saleCapability(true));
    routeParams.catalogKey = frozenDefault.catalogKey;
    delete routeQuery.variantId;

    let host = await mountView(ProductDetailView);
    const selectedPage = requireElement<HTMLElement>(
      host,
      '[data-test="product-detail-page"]',
    );
    const selectedBuy = requireElement<HTMLButtonElement>(
      host,
      '[data-test="product-buy"]',
    );
    expect(selectedPage.dataset.variantId).toBe(saleReadyAlternate.variantId);
    expect(selectedBuy.dataset.variantId).toBe(saleReadyAlternate.variantId);
    expect(selectedBuy.disabled).toBe(false);
    selectedBuy.click();
    await nextTick();
    expect(useCheckoutStore().selectedItem?.variantId).toBe(
      saleReadyAlternate.variantId,
    );

    unmountMountedView();
    useCatalogStore().applySnapshot({
      ...snapshot,
      items: [
        frozenDefault,
        {
          ...saleReadyAlternate,
          saleableStock: 0,
          physicalStock: 2,
          slotSalesState: "frozen",
        },
      ],
    });
    useCheckoutStore().selectedItem = null;
    host = await mountView(ProductDetailView);
    const unavailableBuy = requireElement<HTMLButtonElement>(
      host,
      '[data-test="product-buy"]',
    );
    expect(unavailableBuy.disabled).toBe(true);
    expect(unavailableBuy.textContent).toContain("暂不可购买");
  });

  it("does not select a product for passive catalog navigation, restored detail routes, or variant adjustment", async () => {
    const item = makeCatalogItem();
    const secondVariant: MachineCatalogItem = {
      ...item,
      slotId: "550e8400-e29b-41d4-a716-446655440021",
      inventoryId: "550e8400-e29b-41d4-a716-446655440022",
      variantId: "550e8400-e29b-41d4-a716-446655440023",
      sku: "TEE-BASIC-L-WHITE",
      size: "L",
      color: "白色",
    };
    useCatalogStore().applySnapshot({
      items: [item, secondVariant],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
    });

    let host = await mountView(CatalogView);

    const carousel = requireElement<HTMLElement>(
      host,
      '[aria-roledescription="carousel"]',
    );
    carousel.dispatchEvent(
      new MouseEvent("pointerdown", {
        bubbles: true,
        clientX: 500,
      }),
    );
    carousel.dispatchEvent(
      new MouseEvent("pointerup", {
        bubbles: true,
        clientX: 100,
      }),
    );
    await nextTick();
    const categoryButton = requireButtonByText(host, "T恤");
    expect(categoryButton.disabled).toBe(false);
    categoryButton.click();
    await nextTick();
    const genderButton = requireButtonByText(host, "男款", "exact");
    expect(genderButton.disabled).toBe(false);
    genderButton.click();
    await nextTick();
    const allGenderButton = requireButtonByText(host, "全部", "exact");
    expect(allGenderButton.disabled).toBe(false);
    allGenderButton.click();
    await nextTick();
    requireElement<HTMLElement>(host, ".product-scroll").dispatchEvent(
      new Event("scroll"),
    );
    await nextTick();
    const productButton = requireButtonByText(host, "基础短袖");
    expect(productButton.disabled).toBe(false);
    productButton.click();
    await nextTick();

    expect(routerPushMock).toHaveBeenCalledWith({
      name: "product-detail",
      params: { catalogKey: item.catalogKey },
    });

    unmountMountedView();
    routeParams.catalogKey = item.catalogKey;
    host = await mountView(ProductDetailView);

    expect(host.textContent).toContain("基础短袖");

    const sizeLButton = requireButtonByText(host, "L", "exact");
    expect(sizeLButton.disabled).toBe(false);
    sizeLButton.click();
    await nextTick();
    const colorWhiteButton = requireButtonByText(host, "白色", "exact");
    expect(colorWhiteButton.disabled).toBe(false);
    colorWhiteButton.click();
    await nextTick();

    expect(useCheckoutStore().selectedItem).toBeNull();
  });

  it("does not select a non-sale-ready product", async () => {
    const item: MachineCatalogItem = {
      ...makeCatalogItem(),
      physicalStock: 0,
      saleableStock: 0,
      slotSalesState: "sold_out",
      slotCandidates: [],
      variantCandidates: [
        {
          ...makeCatalogItem().variantCandidates[0],
          physicalStock: 0,
          saleableStock: 0,
          slotSalesState: "sold_out",
          slotCandidates: [],
        },
      ],
    };
    useCatalogStore().applySnapshot({
      items: [item],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
    });
    routeParams.catalogKey = item.catalogKey;

    const host = await mountView(ProductDetailView);

    const buyButton = requireButtonByText(host, "暂不可购买");
    expect(buyButton.disabled).toBe(true);
    buyButton.click();
    await nextTick();

    expect(routerPushMock).not.toHaveBeenCalledWith("/checkout");
    expect(useCheckoutStore().selectedItem).toBeNull();
  });

  it("keeps vision recognition details silent in checkout", async () => {
    const item = makeCatalogItem();
    useCatalogStore().applySnapshot({
      items: [item],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
    });
    useCheckoutStore().selectItem(item);
    applyBlockedCapability();
    applySensitiveVisionProfile();

    const host = await mountView(CheckoutView);

    expect(host.textContent).toContain("确认购买");
    expectRecognitionDetailsHidden(host);
  });

  it("keeps vision recognition details silent during payment", async () => {
    const transaction = transactionSnapshot();
    useCheckoutStore().applyTransaction(transaction);
    getCurrentTransactionMock.mockResolvedValue(transaction);
    applySensitiveVisionProfile();

    const host = await mountView(PaymentView);

    expect(host.textContent).toContain("订单支付");
    expectRecognitionDetailsHidden(host);
  });

  it("keeps sale navigation available when vision presence is unavailable", async () => {
    const item = makeCatalogItem();
    useCatalogStore().applySnapshot({
      items: [item],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
    });

    const host = await mountView(CatalogView);
    latestVisionHandlers?.onError?.(
      new Error("vision camera_unavailable: camera unavailable"),
    );
    await nextTick();

    expect(host.querySelector(".presence-present")).toBeNull();
    expect(host.textContent).toContain("T恤");
    const categoryButton = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("T恤"),
    );
    expect(categoryButton).toBeTruthy();
    categoryButton!.click();
    await nextTick();

    expect(host.textContent).toContain("基础短袖");
    expect(routerPushMock).not.toHaveBeenCalled();
  });

  it("keeps checkout visible but disables order creation when readiness is blocked", async () => {
    const item = makeCatalogItem();
    useCatalogStore().applySnapshot({
      items: [item],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
    });
    useCheckoutStore().selectItem(item);
    applyBlockedCapability();

    const host = await mountView(CheckoutView);
    await nextTick();

    expect(host.textContent).toContain("确认购买");
    expect(host.textContent).toContain("基础短袖");
    expect(host.textContent).toContain("设备暂不可用，请联系工作人员");
    expect(host.textContent).not.toContain("platform unavailable");
    await vi.waitFor(() => {
      expect(useCheckoutStore().loading).toBe(false);
    });
    const submitButton = host.querySelector<HTMLButtonElement>(
      '[data-test="checkout-submit"]',
    );
    expect(submitButton).toBeTruthy();
    expect(submitButton?.disabled).toBe(true);
  });

  it("keeps payment option copy customer-safe in checkout", async () => {
    const item = makeCatalogItem();
    useCatalogStore().applySnapshot({
      items: [item],
      source: "local_stock",
      planogramVersion: "PLAN-1",
      lastUpdatedAt: "2026-06-04T00:00:00Z",
    });
    useCheckoutStore().selectItem(item);
    useSaleCapabilityStore().acceptSnapshot({
      ...saleCapability(true),
      paymentOptions: {
        ready: true,
        defaultOptionKey: "qr_code:alipay",
        defaultProviderCode: "alipay",
        options: [
          {
            optionKey: "qr_code:alipay",
            providerCode: "alipay",
            method: "qr_code",
            displayName: "支付宝",
            description:
              "Provider HTTP 502: scan endpoint unavailable, retry with fallback",
            icon: "alipay",
            recommended: true,
            ready: true,
            disabledReason: null,
          },
          {
            optionKey: "payment_code:alipay",
            providerCode: "alipay",
            method: "payment_code",
            displayName: "支付宝付款码",
            description: "serial COM3 scanner raw timeout",
            icon: "alipay",
            recommended: false,
            ready: true,
            disabledReason: null,
          },
        ],
      },
    });

    const host = await mountView(CheckoutView);

    expect(host.textContent).toContain("展示二维码支付界面");
    expect(host.textContent).toContain("展示付款码扫码界面");
    expect(host.textContent).not.toContain("Provider HTTP 502");
    expect(host.textContent).not.toContain("scan endpoint unavailable");
    expect(host.textContent).not.toContain("serial COM3");
  });
});
