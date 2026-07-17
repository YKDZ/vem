import type { Router } from "vue-router";

import {
  type BrowserInstalledKioskSaleContractFacts,
  daemonIpcMachinePaymentProviderSchema,
  type InstalledKioskSaleDisturbance,
  type InstalledKioskSaleCustomerPaymentSurface,
  type InstalledKioskSaleCustomerTransactionSurface,
  paymentMethodSchema,
  type StockMaintenanceBatchResponse,
  type StockMaintenanceTask,
} from "@vem/shared";

import type {
  CatalogSnapshot,
  HardwareSelfCheck,
  NaturalContextSnapshot,
  NetworkSettingsResponse,
  ProvisioningClaimResponse,
  SaleViewSnapshot,
  TransactionSnapshot,
} from "@/daemon/schemas";
import type { DaemonConnectionInfo } from "@/native/daemon-connection";

import { daemonClient } from "@/daemon/client";
import { transactionSnapshotSchema } from "@/daemon/schemas";
import { useCatalogStore } from "@/stores/catalog";
import { useCheckoutStore } from "@/stores/checkout";
import { useVisionStore } from "@/stores/vision";

import {
  getActiveUiDebugScenario,
  getActiveUiDebugScenarioId,
  getSaleViewForScenario,
  isUiDebugModeEnabled,
} from "./ui-debug-fixtures";

const connection: DaemonConnectionInfo = {
  baseUrl: "http://ui-debug.local",
  token: "ui-debug-token",
  source: "browser_env",
  mock: true,
};

const UI_DEBUG_TRANSACTION_STORAGE_KEY = "vem.machine.uiDebug.transaction";
const UI_DEBUG_PAYMENT_RESULT_STORAGE_KEY = "vem.machine.uiDebug.paymentResult";
const UI_DEBUG_DISPENSE_RESULT_STORAGE_KEY =
  "vem.machine.uiDebug.dispenseResult";

let installed = false;
let currentTransaction: TransactionSnapshot | null = null;
let currentTransactionFailuresRemaining = 0;
let disturbanceInjectionSequence = 0;
let timelineObservationSequence = 0;
const handledPaymentStatusDeliveryIds = new Set<string>();
const vendingCommandLog: Array<{
  commandId: string;
  orderId: string;
  orderNo: string;
}> = [];
const stockMovementLog: Array<{
  movementId: string;
  commandId: string;
  orderId: string;
  orderNo: string;
}> = [];
let removeRouteObserver: (() => void) | null = null;
let captureCurrentRoute: (() => void) | null = null;

type UiDebugSaleEvidence = BrowserInstalledKioskSaleContractFacts;

function emptySaleEvidence(): UiDebugSaleEvidence {
  return {
    source: "browser_ui_contract",
    transactions: [],
    timeline: [],
    disturbanceInjections: [],
    observationWindow: {
      openedAt: nowIso(),
      closedAt: nowIso(),
    },
  };
}

let saleEvidence = emptySaleEvidence();

function nowIso(): string {
  return new Date().toISOString();
}

function localStorageOrNull(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readStoredTransaction(): TransactionSnapshot | null {
  const storage = localStorageOrNull();
  const raw = storage?.getItem(UI_DEBUG_TRANSACTION_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = transactionSnapshotSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {
    // Fall through to clear stale or malformed debug snapshots.
  }
  storage?.removeItem(UI_DEBUG_TRANSACTION_STORAGE_KEY);
  return null;
}

function persistTransaction(snapshot: TransactionSnapshot | null): void {
  const storage = localStorageOrNull();
  if (!storage) return;
  if (!snapshot) {
    storage.removeItem(UI_DEBUG_TRANSACTION_STORAGE_KEY);
    return;
  }
  storage.setItem(UI_DEBUG_TRANSACTION_STORAGE_KEY, JSON.stringify(snapshot));
}

function clearTransactionMarkers(): void {
  const storage = localStorageOrNull();
  if (!storage) return;
  storage.removeItem(UI_DEBUG_PAYMENT_RESULT_STORAGE_KEY);
  storage.removeItem(UI_DEBUG_DISPENSE_RESULT_STORAGE_KEY);
}

function resetSaleEvidence(): void {
  saleEvidence = emptySaleEvidence();
  currentTransactionFailuresRemaining = 0;
  disturbanceInjectionSequence = 0;
  timelineObservationSequence = 0;
  handledPaymentStatusDeliveryIds.clear();
  vendingCommandLog.length = 0;
  stockMovementLog.length = 0;
}

function currentScenario() {
  return getActiveUiDebugScenario();
}

function currentSaleView(): SaleViewSnapshot {
  return getSaleViewForScenario(getActiveUiDebugScenarioId());
}

function applyUiDebugNetworkSettings(): NetworkSettingsResponse {
  return {
    status: "connected",
    ssid: "UI-DEBUG-WIFI",
    hidden: false,
    diagnostics: [],
    operatorGuidance: "UI debug 现场网络已连通",
    updatedAt: nowIso(),
  };
}

function currentTransactionOrScenario(): TransactionSnapshot {
  currentTransaction = currentTransaction ?? readStoredTransaction();
  if (
    currentTransaction?.nextAction === "wait_payment" &&
    localStorageOrNull()?.getItem(UI_DEBUG_PAYMENT_RESULT_STORAGE_KEY) ===
      "success"
  ) {
    currentTransaction = {
      ...currentTransaction,
      paymentStatus: "succeeded",
      orderStatus: "dispensing",
      nextAction: "dispensing",
      vending: {
        commandId: null,
        commandNo: "UI-DEBUG-CMD",
        status: "sent",
        lastError: null,
        pickupReminder: null,
      },
      updatedAt: nowIso(),
    };
    localStorageOrNull()?.removeItem(UI_DEBUG_PAYMENT_RESULT_STORAGE_KEY);
    persistTransaction(currentTransaction);
  }
  if (
    currentTransaction?.nextAction === "dispensing" &&
    localStorageOrNull()?.getItem(UI_DEBUG_DISPENSE_RESULT_STORAGE_KEY) ===
      "success"
  ) {
    currentTransaction = {
      ...currentTransaction,
      paymentStatus: "succeeded",
      orderStatus: "fulfilled",
      nextAction: "success",
      vending: {
        commandId: null,
        commandNo: currentTransaction.vending?.commandNo ?? "UI-DEBUG-CMD",
        status: "succeeded",
        lastError: null,
        pickupReminder: null,
      },
      updatedAt: nowIso(),
    };
    localStorageOrNull()?.removeItem(UI_DEBUG_DISPENSE_RESULT_STORAGE_KEY);
    persistTransaction(currentTransaction);
  }
  return currentTransaction ?? currentScenario().transaction;
}

function catalogFromSaleView(saleView: SaleViewSnapshot): CatalogSnapshot {
  return {
    items: saleView.items.map((item) => ({
      machineCode: item.machineCode,
      slotId: item.slotId,
      slotCode: item.slotCode,
      layerNo: item.layerNo,
      cellNo: item.cellNo,
      inventoryId: item.inventoryId,
      variantId: item.variantId,
      productId: item.productId,
      productName: item.productName,
      productDescription: item.productDescription,
      coverImageUrl: item.coverImageUrl,
      categoryId: item.categoryId,
      categoryName: item.categoryName,
      sku: item.sku,
      size: item.size,
      color: item.color,
      priceCents: item.priceCents,
      availableQty: item.saleableStock,
      productSortOrder: item.productSortOrder,
      targetGender: item.targetGender,
    })),
    cached: false,
    lastUpdatedAt: saleView.lastUpdatedAt,
    source: saleView.source,
    lastError: null,
  };
}

function createTransactionFromOrder(body: unknown): TransactionSnapshot {
  const input = body as {
    inventoryId?: string;
    paymentMethod?: unknown;
    paymentProviderCode?: unknown;
    idempotencyKey?: unknown;
  };
  const item =
    currentSaleView().items.find(
      (candidate) => candidate.inventoryId === input.inventoryId,
    ) ?? currentSaleView().items[0];
  const paymentMethod = paymentMethodSchema
    .catch("mock")
    .parse(input.paymentMethod);
  const providerCode = daemonIpcMachinePaymentProviderSchema
    .catch("mock")
    .parse(input.paymentProviderCode);
  const paymentUrl =
    paymentMethod === "qr_code"
      ? "https://pay.example.test/ui-debug-created"
      : null;
  const idempotencyKey =
    typeof input.idempotencyKey === "string" && input.idempotencyKey.length > 0
      ? input.idempotencyKey
      : "missing-ui-idempotency-key";
  const orderId = "550e8400-e29b-41d4-a716-446655449901";
  const paymentId = "550e8400-e29b-41d4-a716-446655449902";
  const orderNo = `UI-DEBUG-${Date.now()}`;
  const reservationId = `UI-DEBUG-RES-${orderNo}`;
  const transaction: TransactionSnapshot = {
    orderId,
    orderNo,
    productSummary: item
      ? {
          name: item.productName,
          sku: item.sku,
          size: item.size,
          color: item.color,
        }
      : null,
    paymentId,
    paymentNo: "UI-DEBUG-PAY",
    paymentMethod,
    paymentProvider: providerCode,
    paymentUrl,
    paymentStatus: paymentMethod === "mock" ? "pending" : "processing",
    orderStatus: "pending_payment",
    totalAmountCents: item?.priceCents ?? 0,
    vending: null,
    nextAction: "wait_payment",
    maskedAuthCode: null,
    paymentCodeAttempt: null,
    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    errorCode: null,
    errorMessage: null,
    operatorHint:
      paymentMethod === "payment_code" ? "请出示付款码" : "等待用户支付",
    updatedAt: nowIso(),
  };
  if (paymentUrl) {
    saleEvidence.transactions.push({
      checkout: { idempotencyKey },
      order: {
        orderId,
        checkoutIdempotencyKey: idempotencyKey,
        status: "pending_payment",
      },
      reservation: {
        reservationId,
        orderId,
        status: "reserved",
      },
      payment: {
        paymentId,
        orderId,
        reservationId,
        paymentUrl,
        status: "processing",
        statusDeliveries: [],
      },
      transaction: {
        orderNo,
        orderId,
        paymentId,
        reservationId,
        status: "awaiting_payment",
      },
      vendingCommand: null,
      stockMovement: null,
      fulfillment: null,
    });
  }
  currentTransaction = transaction;
  persistTransaction(currentTransaction);
  return transaction;
}

function activeSaleRecord() {
  return (
    saleEvidence.transactions[saleEvidence.transactions.length - 1] ?? null
  );
}

function handleUiDebugPaymentStatus(succeed: boolean): TransactionSnapshot {
  const snapshot = currentTransactionOrScenario();
  const record = activeSaleRecord();
  const commandId =
    snapshot.vending?.commandId ??
    record?.vendingCommand?.commandId ??
    `UI-DEBUG-CMD-${snapshot.orderNo}`;
  if (record) {
    const deliveryId = `payment-status-${record.payment.paymentId}-${succeed ? "succeeded" : "failed"}`;
    record.payment.statusDeliveries.push({
      deliveryId,
      status: succeed ? "succeeded" : "failed",
      deliveredAt: nowIso(),
      payload: {
        orderId: record.order.orderId,
        paymentId: record.payment.paymentId,
        orderNo: record.transaction.orderNo,
        paymentStatus: succeed ? "succeeded" : "failed",
      },
    });
    if (!handledPaymentStatusDeliveryIds.has(deliveryId)) {
      handledPaymentStatusDeliveryIds.add(deliveryId);
      if (succeed) {
        vendingCommandLog.push({
          commandId,
          orderId: record.order.orderId,
          orderNo: record.transaction.orderNo,
        });
      }
    }
    record.payment.status = succeed ? "succeeded" : "failed";
    record.order.status = succeed ? "dispensing" : "failed";
    record.transaction.status = succeed ? "dispensing" : "failed";
    if (succeed) {
      record.vendingCommand = {
        commandId,
        orderId: record.order.orderId,
        orderNo: record.transaction.orderNo,
        status: "sent",
        creationCount: vendingCommandLog.filter(
          (command) => command.commandId === commandId,
        ).length,
      };
    }
  }
  currentTransaction = {
    ...snapshot,
    paymentStatus: succeed ? "succeeded" : "failed",
    orderStatus: succeed ? "dispensing" : "canceled",
    nextAction: succeed ? "dispensing" : "payment_failed",
    vending: succeed
      ? {
          commandId,
          commandNo: commandId,
          status: "sent",
          lastError: null,
        }
      : null,
    updatedAt: nowIso(),
  };
  persistTransaction(currentTransaction);
  return currentTransaction;
}

function completeSimulatedDispense(): TransactionSnapshot {
  const snapshot = currentTransactionOrScenario();
  const record = activeSaleRecord();
  const commandId =
    snapshot.vending?.commandId ??
    record?.vendingCommand?.commandId ??
    `UI-DEBUG-CMD-${snapshot.orderNo}`;
  if (record) {
    const movementId = `UI-DEBUG-STOCK-${snapshot.orderNo}`;
    record.order.status = "fulfilled";
    record.reservation.status = "consumed";
    record.payment.status = "succeeded";
    record.transaction.status = "succeeded";
    const commandCreationCount = vendingCommandLog.filter(
      (command) => command.commandId === commandId,
    ).length;
    if (commandCreationCount === 0) {
      throw new Error("UI debug dispense completed without a payment command");
    }
    if (
      !stockMovementLog.some((movement) => movement.movementId === movementId)
    ) {
      stockMovementLog.push({
        movementId,
        commandId,
        orderId: record.order.orderId,
        orderNo: record.transaction.orderNo,
      });
    }
    record.vendingCommand = {
      commandId,
      orderId: record.order.orderId,
      orderNo: record.transaction.orderNo,
      status: "succeeded",
      creationCount: commandCreationCount,
    };
    record.stockMovement = {
      movementId,
      orderId: record.order.orderId,
      orderNo: record.transaction.orderNo,
      commandId,
      quantity: -1,
      status: "accepted",
      creationCount: stockMovementLog.filter(
        (movement) => movement.movementId === movementId,
      ).length,
    };
    record.fulfillment = {
      status: "succeeded",
      orderId: record.order.orderId,
      orderNo: record.transaction.orderNo,
      commandId,
      stockMovementId: movementId,
    };
  }
  currentTransaction = {
    ...snapshot,
    paymentStatus: "succeeded",
    orderStatus: "fulfilled",
    nextAction: "success",
    vending: {
      commandId,
      commandNo: commandId,
      status: "succeeded",
      lastError: null,
      pickupReminder: null,
    },
    updatedAt: nowIso(),
  };
  persistTransaction(currentTransaction);
  return currentTransaction;
}

async function routeToTransactionProjection(): Promise<void> {
  const { router } = await import("@/router");
  const target = useCheckoutStore().customerCheckoutView.routeTarget;
  if ("path" in target) {
    await router.replace(target.path);
    return;
  }
  await router.replace(target);
}

function installedKioskSaleRoute(path: string) {
  if (path.startsWith("/catalog")) return "home" as const;
  if (path.startsWith("/products")) return "product" as const;
  if (path.startsWith("/checkout")) return "checkout" as const;
  if (path.startsWith("/payment")) return "payment" as const;
  if (path.startsWith("/dispensing")) return "fulfillment" as const;
  if (path.startsWith("/result")) return "result" as const;
  if (path.startsWith("/maintenance")) return "maintenance" as const;
  if (path.startsWith("/offline")) return "offline" as const;
  return "other" as const;
}

function nextTimelineObservationId(): string {
  timelineObservationSequence += 1;
  return `browser-observation-${timelineObservationSequence}`;
}

function recordInstalledKioskSaleRoute(path: string): void {
  const record = activeSaleRecord();
  if (!record) return;
  const route = installedKioskSaleRoute(path);
  if (["payment", "fulfillment", "result"].includes(route)) return;
  saleEvidence.timeline.push({
    observationId: nextTimelineObservationId(),
    observedAt: nowIso(),
    route,
    identitySource: "router_transaction_state",
    renderedQrSource: null,
    decodedQrPayload: null,
    commandId: currentTransaction?.vending?.commandId ?? null,
    orderId: record.order.orderId,
    paymentId: record.payment.paymentId,
    orderNo: record.transaction.orderNo,
    paymentUrl: record.payment.paymentUrl,
  });
}

function recordCustomerPaymentSurface(
  surface: InstalledKioskSaleCustomerPaymentSurface,
): void {
  const record = activeSaleRecord();
  if (!record) {
    throw new Error("Installed Kiosk Sale transaction evidence is unavailable");
  }
  const hasPaymentSurface = saleEvidence.timeline.some(
    (entry) => entry.route === "payment",
  );
  saleEvidence.timeline.push({
    observationId: nextTimelineObservationId(),
    observedAt: surface.observedAt,
    route: "payment",
    identitySource: "customer_payment_surface",
    orderId: surface.orderId,
    paymentId: surface.paymentId,
    orderNo: surface.orderNo,
    paymentUrl: surface.paymentUrl,
    renderedQrSource: surface.renderedQrSource,
    decodedQrPayload: surface.decodedQrPayload,
    commandId: null,
  });
  if (!hasPaymentSurface) {
    saleEvidence.observationWindow.openedAt = surface.observedAt;
  }
}

function recordCustomerTransactionSurface(
  surface: InstalledKioskSaleCustomerTransactionSurface,
): void {
  const route = surface.route;
  saleEvidence.timeline.push({
    observationId: nextTimelineObservationId(),
    observedAt: surface.observedAt,
    route,
    identitySource:
      route === "fulfillment"
        ? "customer_fulfillment_surface"
        : "customer_result_surface",
    orderId: surface.orderId,
    paymentId: surface.paymentId,
    orderNo: surface.orderNo,
    paymentUrl: surface.paymentUrl,
    renderedQrSource: null,
    decodedQrPayload: null,
    commandId: surface.commandId,
  });
}

export function installInstalledKioskSaleRouteObserver(router: Router): void {
  if (!shouldInstallUiDebugDaemon()) return;
  removeRouteObserver?.();
  removeRouteObserver = router.afterEach((to) => {
    recordInstalledKioskSaleRoute(to.path);
  });
  captureCurrentRoute = () => {
    recordInstalledKioskSaleRoute(router.currentRoute.value.path);
  };
}

async function injectInstalledKioskSaleDisturbance(
  disturbance: InstalledKioskSaleDisturbance,
): Promise<void> {
  let barrierObservation: UiDebugSaleEvidence["timeline"][number] | undefined;
  for (const entry of saleEvidence.timeline) {
    if (
      entry.route === "payment" &&
      entry.identitySource === "customer_payment_surface"
    ) {
      barrierObservation = entry;
    }
  }
  if (!barrierObservation) {
    throw new Error("Customer payment QR barrier has not been observed");
  }
  disturbanceInjectionSequence += 1;
  const injection = {
    injectionId: `browser-injection-${disturbanceInjectionSequence}`,
    kind: disturbance,
    injectedAt: nowIso(),
    barrier: "payment_qr_presented" as const,
    barrierObservationId: barrierObservation.observationId,
    count: 1,
    outcome: "failed" as "completed" | "failed",
    pressure:
      null as UiDebugSaleEvidence["disturbanceInjections"][number]["pressure"],
  };
  saleEvidence.disturbanceInjections.push(injection);
  try {
    switch (disturbance) {
      case "catalog_refresh":
        await Promise.all([
          useCatalogStore().refresh(),
          (async () => {
            const { router } = await import("@/router");
            await router.push("/catalog");
            injection.pressure = {
              refreshedState: "catalog",
              attemptedRoute: "/catalog",
              resolvedRoute: router.currentRoute.value.path,
              routeAuthorityWon: router.currentRoute.value.path === "/payment",
            };
          })(),
        ]);
        break;
      case "readiness_refresh":
        await Promise.all([
          useCheckoutStore().refreshSaleStartCapability(),
          (async () => {
            const { router } = await import("@/router");
            await router.push("/maintenance");
            injection.pressure = {
              refreshedState: "readiness",
              attemptedRoute: "/maintenance",
              resolvedRoute: router.currentRoute.value.path,
              routeAuthorityWon: router.currentRoute.value.path === "/payment",
            };
          })(),
        ]);
        break;
      case "presence_departure":
        useVisionStore().applyPersonDeparted({
          eventId: "ui-debug-presence-departure",
          detectedAt: nowIso(),
          lastSeenAt: nowIso(),
          reason: "left_frame",
        });
        break;
      case "duplicate_payment_status":
        useCheckoutStore().applyTransaction(handleUiDebugPaymentStatus(true));
        useCheckoutStore().applyTransaction(handleUiDebugPaymentStatus(true));
        await routeToTransactionProjection();
        break;
      case "ipc_interruption":
        currentTransactionFailuresRemaining = 1;
        await useCheckoutStore().refreshCurrentTransaction();
        await useCheckoutStore().refreshCurrentTransaction();
        break;
    }
    injection.outcome = "completed";
    captureCurrentRoute?.();
  } catch (error) {
    captureCurrentRoute?.();
    throw error;
  }
}

function installInstalledKioskSaleDebugControl(): void {
  if (typeof window === "undefined") return;
  Reflect.set(window, "__VEM_INSTALLED_KIOSK_SALE_DEBUG__", {
    inject: injectInstalledKioskSaleDisturbance,
    observePaymentSurface: recordCustomerPaymentSurface,
    observeTransactionSurface: recordCustomerTransactionSurface,
    readEvidence: (): UiDebugSaleEvidence => structuredClone(saleEvidence),
    recordRouteObservation: recordInstalledKioskSaleRoute,
    completePayment: async (): Promise<void> => {
      useCheckoutStore().applyTransaction(handleUiDebugPaymentStatus(true));
      await routeToTransactionProjection();
    },
    completeDispense: async (): Promise<void> => {
      useCheckoutStore().applyTransaction(completeSimulatedDispense());
      await routeToTransactionProjection();
    },
    closeObservationWindow: (): UiDebugSaleEvidence => {
      captureCurrentRoute?.();
      saleEvidence.observationWindow.closedAt = nowIso();
      return structuredClone(saleEvidence);
    },
  });
}

function closedTransaction(): TransactionSnapshot {
  const snapshot = currentTransactionOrScenario();
  currentTransaction = {
    ...snapshot,
    paymentStatus: "canceled",
    orderStatus: "canceled",
    nextAction: "closed",
    updatedAt: nowIso(),
  };
  persistTransaction(currentTransaction);
  return currentTransaction;
}

export function shouldInstallUiDebugDaemon(): boolean {
  return import.meta.env.DEV && isUiDebugModeEnabled();
}

export function resetUiDebugTransaction(): void {
  currentTransaction = null;
  persistTransaction(null);
  clearTransactionMarkers();
  resetSaleEvidence();
}

export function hasStoredUiDebugTransaction(): boolean {
  return readStoredTransaction() !== null;
}

export function setUiDebugTransaction(snapshot: TransactionSnapshot): void {
  currentTransaction = snapshot;
  persistTransaction(snapshot);
}

export function installUiDebugDaemon(): void {
  if (installed) return;
  installed = true;
  const client = daemonClient as unknown as Record<string, unknown>;
  client.connection = connection;

  client.initialize = async () => {
    client.connection = connection;
    return connection;
  };
  client.getHealth = async () => currentScenario().health;
  client.getReady = async () => currentScenario().ready;
  client.applyNetworkSettings = async () => applyUiDebugNetworkSettings();
  client.getEffectiveRuntimeConfiguration = async () =>
    currentScenario().runtimeConfiguration;
  client.claimMachine = async (): Promise<ProvisioningClaimResponse> => ({
    status: "provisioned",
    machineCode:
      currentScenario().runtimeConfiguration.machine?.code ?? "UI-DEBUG-001",
    restartRequested: false,
  });
  client.getCatalog = async () => catalogFromSaleView(currentSaleView());
  client.refreshCatalog = async () => catalogFromSaleView(currentSaleView());
  client.getSaleView = async () => currentSaleView();
  client.recordStockMovement = async () => currentSaleView();
  const currentStockMaintenanceTask = (): StockMaintenanceTask => {
    const saleView = currentSaleView();
    return {
      taskId: "ui-debug-stock-task",
      mode: "routine_refill",
      status: "ready",
      slots: saleView.items.map((item) => ({
        slotCode: item.slotCode,
        layerNo: item.layerNo,
        cellNo: item.cellNo,
        productName: item.productName,
        sku: item.sku,
        capacity: item.capacity,
        currentQuantity: item.physicalStock,
        submittedQuantity: null,
        submittedAddition: null,
        previewQuantity: null,
        syncStatus: "not_submitted",
        salesState: item.slotSalesState,
        reconciliationReason: null,
      })),
    };
  };
  client.getStockMaintenanceTask = async (): Promise<StockMaintenanceTask> =>
    currentStockMaintenanceTask();
  client.submitStockMaintenanceBatch =
    async (): Promise<StockMaintenanceBatchResponse> => ({
      task: {
        ...currentStockMaintenanceTask(),
        status: "pending",
      },
      duplicate: false,
    });
  client.clearWholeMachineMaintenanceLock = async () => ({ ok: true });
  client.getSaleStartCapability = async () => currentScenario().saleCapability;
  client.createOrder = async (body: unknown) =>
    createTransactionFromOrder(body);
  client.cancelOrder = async () => closedTransaction();
  client.submitDevPaymentCode = async () => handleUiDebugPaymentStatus(true);
  client.getCurrentTransaction = async () => {
    if (currentTransactionFailuresRemaining > 0) {
      currentTransactionFailuresRemaining -= 1;
      throw new Error("UI debug bounded IPC interruption");
    }
    return currentTransactionOrScenario();
  };
  client.getSyncStatus = async () => currentScenario().sync;
  client.getScannerStatus = async () => currentScenario().scanner;
  client.getVisionStatus = async () => currentScenario().vision;
  client.getRemoteOpsStatus = async () => currentScenario().remoteOps;
  client.runHardwareSelfCheck = async (): Promise<HardwareSelfCheck> => ({
    adapter: "ui_debug",
    online: currentScenario().health.hardwareOnline,
    message: currentScenario().health.operatorReason,
    portPath: null,
    resolutionSource: "ui_debug",
    boundUsbIdentity: null,
    candidates: [],
    configUpdated: false,
  });
  client.markMockPayment = async (_orderNo: string, succeed: boolean) =>
    handleUiDebugPaymentStatus(succeed);
  client.downloadLogExport = async () =>
    new Response("ui debug log export\n", {
      headers: { "Content-Type": "text/plain" },
    });
  client.subscribeEvents = () => ({ close: () => undefined });
  installInstalledKioskSaleDebugControl();
  client.getNaturalContext = async (): Promise<NaturalContextSnapshot> => {
    const now = new Date();
    return {
      status: "ready",
      degraded: false,
      customerFacingBlocked: false,
      checkedAt: now.toISOString(),
      externalEnvironment: {
        status: "ready",
        checkedAt: now.toISOString(),
        localTime: {
          status: "ready",
          timezone: "Asia/Shanghai",
          localDate: now.toISOString().split("T")[0],
          localClock: now.toTimeString().split(" ")[0],
        },
        weather: {
          status: "ready",
          temperatureCelsius: 25,
          conditionText: "晴",
          conditionCode: "sunny",
          observedAt: now.toISOString(),
          windScale: 2,
          windSpeedKph: 5,
          weatherConditionClasses: [],
          primaryWeatherConditionClass: null,
        },
        sun: {
          status: "ready",
          sunriseAt: "06:00:00",
          sunsetAt: "18:00:00",
        },
        calendar: {
          status: "ready",
          localDate: now.toISOString().split("T")[0],
          festivals: [],
          primaryFestival: null,
          solarTerm: null,
        },
      },
      localSiteSignals: {
        status: "ok",
        temperatureCelsius: 25,
        humidityRh: 50,
        sampledAt: now.toISOString(),
      },
    };
  };
}
