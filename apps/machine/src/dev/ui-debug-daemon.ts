import type {
  CatalogSnapshot,
  ConfigSummary,
  HardwareSelfCheck,
  ProvisioningClaimResponse,
  SaleViewSnapshot,
  TransactionSnapshot,
} from "@/daemon/schemas";
import type { DaemonConnectionInfo } from "@/native/daemon-connection";

import { daemonClient } from "@/daemon/client";

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

let installed = false;
let currentTransaction: TransactionSnapshot | null = null;

function nowIso(): string {
  return new Date().toISOString();
}

function currentScenario() {
  return getActiveUiDebugScenario();
}

function currentSaleView(): SaleViewSnapshot {
  return getSaleViewForScenario(getActiveUiDebugScenarioId());
}

function currentTransactionOrScenario(): TransactionSnapshot {
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
    paymentMethod?: string;
    paymentProviderCode?: string;
  };
  const item =
    currentSaleView().items.find(
      (candidate) => candidate.inventoryId === input.inventoryId,
    ) ?? currentSaleView().items[0];
  const paymentMethod = input.paymentMethod ?? "mock";
  const providerCode = input.paymentProviderCode ?? "mock";
  const paymentUrl =
    paymentMethod === "qr_code"
      ? "https://pay.example.test/ui-debug-created"
      : null;
  currentTransaction = {
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
  return currentTransaction;
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
          commandNo: "UI-DEBUG-CMD",
          status: "sent",
          lastError: null,
        }
      : null,
    updatedAt: nowIso(),
  };
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
  return currentTransaction;
}

export function shouldInstallUiDebugDaemon(): boolean {
  return import.meta.env.DEV && isUiDebugModeEnabled();
}

export function resetUiDebugTransaction(): void {
  currentTransaction = null;
}

export function setUiDebugTransaction(snapshot: TransactionSnapshot): void {
  currentTransaction = snapshot;
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
}
