import {
  daemonIpcMachinePaymentProviderSchema,
  paymentMethodSchema,
} from "@vem/shared";

import type {
  BringUpSnapshot,
  CatalogSnapshot,
  ConfigSummary,
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
const UI_DEBUG_ADVANCED_MAINTENANCE_CONFIG_STORAGE_KEY =
  "vem.machine.uiDebug.advancedMaintenanceConfig";

let installed = false;
let currentTransaction: TransactionSnapshot | null = null;

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

function currentScenario() {
  return getActiveUiDebugScenario();
}

function uiDebugConnection(): DaemonConnectionInfo {
  return {
    ...connection,
    runtimeFlags: {
      advancedMaintenanceConfig:
        localStorageOrNull()?.getItem(
          UI_DEBUG_ADVANCED_MAINTENANCE_CONFIG_STORAGE_KEY,
        ) === "1",
    },
  };
}

function currentSaleView(): SaleViewSnapshot {
  return getSaleViewForScenario(getActiveUiDebugScenarioId());
}

function currentBringUp(): BringUpSnapshot {
  return {
    state: "topology_mismatch",
    blockingReasons: [
      {
        code: "HARDWARE_SLOT_TOPOLOGY_MISMATCH",
        component: "topology",
        message: "平台货道拓扑与本机下位机返回不一致",
      },
    ],
    diagnostics: [
      {
        code: "LOWER_CONTROLLER_SLOT_COUNT",
        component: "lower-controller",
        message: "下位机返回 4 个货道，平台档案期望 6 个货道",
      },
      {
        code: "RUNTIME_ACCEPTANCE_PENDING",
        component: "acceptance",
        message: "Runtime Acceptance 尚未完成",
      },
    ],
    readinessLevel: "not_ready",
    hardwareMode: "production",
    allowedActions: {
      configureNetwork: true,
      claimMachine: false,
      retryClaim: true,
      convergeMaintenanceTunnel: false,
      syncProfile: true,
      resolveTopology: true,
      runRuntimeAcceptance: true,
      runHardwareAcceptance: false,
      attestStock: false,
      startSales: false,
    },
    currentTask: null,
    progress: [],
    updatedAt: nowIso(),
  };
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
  const transaction: TransactionSnapshot = {
    orderId: "550e8400-e29b-41d4-a716-446655449901",
    orderNo: `UI-DEBUG-${Date.now()}`,
    productSummary: item
      ? {
          name: item.productName,
          sku: item.sku,
          size: item.size,
          color: item.color,
        }
      : null,
    paymentId: null,
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
  currentTransaction = transaction;
  persistTransaction(currentTransaction);
  return transaction;
}

function transitionMockPayment(succeed: boolean): TransactionSnapshot {
  const snapshot = currentTransactionOrScenario();
  currentTransaction = {
    ...snapshot,
    paymentStatus: succeed ? "succeeded" : "failed",
    orderStatus: succeed ? "dispensing" : "canceled",
    nextAction: succeed ? "dispensing" : "payment_failed",
    vending: succeed
      ? {
          commandId: null,
          commandNo: "UI-DEBUG-CMD",
          status: "sent",
          lastError: null,
        }
      : null,
    updatedAt: nowIso(),
  };
  persistTransaction(currentTransaction);
  return currentTransaction;
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
  client.connection = uiDebugConnection();

  client.initialize = async () => {
    const nextConnection = uiDebugConnection();
    client.connection = nextConnection;
    return nextConnection;
  };
  client.getHealth = async () => currentScenario().health;
  client.getReady = async () => currentScenario().ready;
  client.getBringUp = async () => currentBringUp();
  client.beginMaintenanceSession = async (
    pin: string,
    requestedScopes: string[] = [],
  ) => {
    if (pin !== "2468") {
      throw new Error("维护 PIN 验证失败");
    }
    return {
      sessionId: "ui-debug-maintenance-session",
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      scopes: Array.from(new Set(["maintenance.mutate", ...requestedScopes])),
    };
  };
  client.applyNetworkSettings = async () => applyUiDebugNetworkSettings();
  client.getConfig = async () => currentScenario().config;
  client.saveConfig = async (body: unknown) => ({
    ...currentScenario().config,
    ...(body as Partial<ConfigSummary>),
  });
  client.claimMachine = async (): Promise<ProvisioningClaimResponse> => ({
    status: "provisioned",
    machineCode: currentScenario().config.public.machineCode ?? "UI-DEBUG-001",
    restartRequested: false,
    config: currentScenario().config,
  });
  client.getCatalog = async () => catalogFromSaleView(currentSaleView());
  client.refreshCatalog = async () => catalogFromSaleView(currentSaleView());
  client.getSaleView = async () => currentSaleView();
  client.recordStockMovement = async () => currentSaleView();
  client.clearWholeMachineMaintenanceLock = async () => ({ ok: true });
  client.getSaleReadiness = async () => currentScenario().saleReadiness;
  client.getPaymentOptions = async () => currentScenario().paymentOptions;
  client.createOrder = async (body: unknown) =>
    createTransactionFromOrder(body);
  client.cancelOrder = async () => closedTransaction();
  client.submitDevPaymentCode = async () => transitionMockPayment(true);
  client.getCurrentTransaction = async () => currentTransactionOrScenario();
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
    transitionMockPayment(succeed);
  client.downloadLogExport = async () =>
    new Response("ui debug log export\n", {
      headers: { "Content-Type": "text/plain" },
    });
  client.subscribeEvents = () => ({ close: () => undefined });
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
