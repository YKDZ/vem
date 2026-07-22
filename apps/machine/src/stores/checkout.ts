import { defineStore } from "pinia";

import type { TransactionSnapshot } from "@/daemon/schemas";
import type {
  CheckoutSelectedItem,
  CreateMachineOrderResponse,
  MachinePaymentOption,
  MachinePaymentOptionKey,
  MachinePaymentProviderCode,
} from "@/types/checkout";

import {
  projectCustomerCheckoutView,
  type CustomerCheckoutReadinessContext,
  type CustomerCheckoutReturnRoute,
  type CustomerCheckoutView,
} from "@/checkout/customer-checkout-view";
import {
  projectCustomerError,
  type CustomerErrorProjection,
  type CustomerErrorStage,
} from "@/customer-error-projection/customer-error-projection";
import { daemonClient } from "@/daemon/client";
import { recordCustomerErrorEvidence } from "@/runtime/customer-error-evidence";
import { useCatalogStore } from "@/stores/catalog";
import { useSaleCapabilityStore } from "@/stores/sale-capability";

export type ApplyTransactionOptions = {
  restored?: boolean;
};

export type CustomerErrorCorrelation = {
  checkoutAttemptIdempotencyKey: string | null;
  orderId: string | null;
  paymentId: string | null;
  orderNo: string | null;
};

export type TransactionRefreshOutcome =
  | {
      status: "refreshed";
      snapshot: TransactionSnapshot | null;
    }
  | {
      status: "failed";
      snapshot: null;
      error: unknown;
    };

const DISMISSED_TERMINAL_ORDER_STORAGE_KEY =
  "vem.machine.dismissedTerminalOrderNos";
const DISMISSED_TERMINAL_ORDER_LIMIT = 50;

type TransactionRefreshCoordinator = {
  running: Promise<TransactionRefreshOutcome> | null;
};

const transactionRefreshCoordinators = new WeakMap<
  object,
  TransactionRefreshCoordinator
>();

function transactionRefreshCoordinator(
  store: object,
): TransactionRefreshCoordinator {
  const existing = transactionRefreshCoordinators.get(store);
  if (existing) return existing;
  const created = { running: null };
  transactionRefreshCoordinators.set(store, created);
  return created;
}

function createCheckoutAttemptIdempotencyKey(): string {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  return `checkout:${randomUuid ?? `${Date.now()}:${Math.random().toString(36).slice(2)}`}`;
}

function browserLocalStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readDismissedTerminalOrderNos(): string[] {
  const storage = browserLocalStorage();
  if (!storage) return [];
  try {
    const parsed = JSON.parse(
      storage.getItem(DISMISSED_TERMINAL_ORDER_STORAGE_KEY) ?? "[]",
    );
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

function writeDismissedTerminalOrderNos(orderNos: string[]): void {
  const storage = browserLocalStorage();
  if (!storage) return;
  storage.setItem(
    DISMISSED_TERMINAL_ORDER_STORAGE_KEY,
    JSON.stringify(orderNos.slice(-DISMISSED_TERMINAL_ORDER_LIMIT)),
  );
}

function rememberDismissedTerminalOrderNo(
  current: string[],
  orderNo: string,
): string[] {
  return [...current.filter((value) => value !== orderNo), orderNo].slice(
    -DISMISSED_TERMINAL_ORDER_LIMIT,
  );
}

function providerCodeFromSnapshot(
  snapshot: TransactionSnapshot,
): MachinePaymentProviderCode | null {
  if (
    snapshot.paymentProvider === "mock" ||
    snapshot.paymentProvider === "wechat_pay" ||
    snapshot.paymentProvider === "alipay"
  ) {
    return snapshot.paymentProvider;
  }
  return null;
}

function stringField(error: unknown, key: string): string | null {
  if (typeof error !== "object" || error === null || !(key in error)) {
    return null;
  }
  const value = Object.fromEntries(Object.entries(error))[key];
  return typeof value === "string" ? value : null;
}

function customerErrorStageForCreateFailure(
  error: unknown,
): CustomerErrorStage {
  return stringField(error, "responseCode") === "create_order_blocked"
    ? "device"
    : "payment_creation";
}

function latestSaleViewItem(
  selectedItem: CheckoutSelectedItem | null,
): CheckoutSelectedItem | null {
  if (!selectedItem) return null;
  const catalogStore = useCatalogStore();
  const saleableItem = catalogStore.saleableItemFor(selectedItem);
  if (saleableItem) return saleableItem;
  return (
    catalogStore.items.find(
      (item) =>
        item.catalogKey === selectedItem.catalogKey &&
        item.variantId === selectedItem.variantId,
    ) ?? null
  );
}

function isSaleableItem(
  item: CheckoutSelectedItem | null,
): item is CheckoutSelectedItem {
  return Boolean(
    item && item.slotSalesState === "sale_ready" && item.saleableStock > 0,
  );
}

function activePlanogramVersion(): string | null {
  return useCatalogStore().planogramVersion;
}

function isMachineSaleReady(): boolean {
  return useSaleCapabilityStore().canStartSale;
}

function selectedPaymentOptionForCapability(
  selectedOptionKey: MachinePaymentOptionKey | null,
): MachinePaymentOption | null {
  const capabilityStore = useSaleCapabilityStore();
  const options = capabilityStore.paymentOptions;
  const enabledOption = (
    optionKey: string | null,
  ): MachinePaymentOption | null =>
    options.find(
      (option) => option.optionKey === optionKey && !option.disabled,
    ) ?? null;
  if (selectedOptionKey !== null) {
    return enabledOption(selectedOptionKey);
  }
  return (
    enabledOption(capabilityStore.defaultPaymentOptionKey) ??
    options.find((option) => !option.disabled) ??
    null
  );
}

function suggestedReturnRoute(): CustomerCheckoutReturnRoute {
  return "catalog";
}

function requiresMaintenanceReview(): boolean {
  const capabilityStore = useSaleCapabilityStore();
  return capabilityStore.blockerCodes.some(
    (code) =>
      code.startsWith("WHOLE_MACHINE_") ||
      code.startsWith("LOWER_CONTROLLER_") ||
      code.startsWith("PRODUCTION_DISPENSE_PATH_"),
  );
}

function customerCheckoutReadinessContext(): CustomerCheckoutReadinessContext {
  const capabilityStore = useSaleCapabilityStore();
  return {
    saleReady: capabilityStore.canStartSale,
    suggestedRoute: suggestedReturnRoute(),
    requiresMaintenanceReview: requiresMaintenanceReview(),
  };
}

function orderResponseFromSnapshot(
  snapshot: TransactionSnapshot,
  fallbackAmountCents: number,
): CreateMachineOrderResponse | null {
  if (!snapshot.orderNo || !snapshot.paymentId) return null;
  return {
    orderId: snapshot.orderId ?? snapshot.orderNo,
    orderNo: snapshot.orderNo,
    paymentId: snapshot.paymentId,
    paymentNo: snapshot.paymentNo ?? "-",
    paymentUrl: snapshot.paymentUrl,
    expiresAt: snapshot.expiresAt ?? snapshot.updatedAt,
    totalAmountCents: snapshot.totalAmountCents ?? fallbackAmountCents,
    paymentProviderCode: providerCodeFromSnapshot(snapshot),
  };
}

function checkoutProjectionRank(view: CustomerCheckoutView): number {
  switch (view.stage) {
    case "none":
      return 0;
    case "payment":
      return 1;
    case "dispensing":
      return 2;
    case "result":
      return 3;
  }
}

function transactionUpdatedAtMs(snapshot: TransactionSnapshot): number {
  const value = Date.parse(snapshot.updatedAt);
  return Number.isFinite(value) ? value : 0;
}

function canAdvanceTransactionProjection(input: {
  current: TransactionSnapshot;
  currentView: CustomerCheckoutView;
  incoming: TransactionSnapshot;
  incomingView: CustomerCheckoutView;
  requestNo: number;
  lastAcceptedRequestNo: number;
}): boolean {
  const currentRank = checkoutProjectionRank(input.currentView);
  const incomingRank = checkoutProjectionRank(input.incomingView);
  if (incomingRank !== currentRank) return incomingRank > currentRank;

  const currentUpdatedAt = transactionUpdatedAtMs(input.current);
  const incomingUpdatedAt = transactionUpdatedAtMs(input.incoming);
  if (incomingUpdatedAt !== currentUpdatedAt) {
    return incomingUpdatedAt > currentUpdatedAt;
  }
  return input.requestNo >= input.lastAcceptedRequestNo;
}

export const useCheckoutStore = defineStore("checkout", {
  state: () => ({
    selectedItem: null as CheckoutSelectedItem | null,
    transaction: null as TransactionSnapshot | null,
    nowMs: Date.now(),
    loading: false,
    customerError: null as CustomerErrorProjection | null,
    selectedPaymentOptionKey: null as MachinePaymentOptionKey | null,
    paymentCodeLastMasked: null as string | null,
    checkoutAttemptIdempotencyKey: null as string | null,
    paymentCreationAttemptActive: false,
    dismissedTerminalOrderNos: readDismissedTerminalOrderNos(),
    lastTransactionRestored: false,
    transactionRecoveryOrderNo: null as string | null,
    transactionRefreshGeneration: 0,
    transactionRefreshRequestNo: 0,
    transactionRefreshLastAcceptedRequestNo: 0,
    transactionRefreshInFlight: 0,
  }),
  getters: {
    quantity: (): number => 1,
    customerCheckoutView: (state): CustomerCheckoutView =>
      projectCustomerCheckoutView({
        transaction: state.transaction,
        nowMs: state.nowMs,
        dismissedTerminalOrderNos: state.dismissedTerminalOrderNos,
        restored: state.lastTransactionRestored,
        loading: state.loading,
        readiness: customerCheckoutReadinessContext(),
      }),
    customerCheckoutRecovery: (
      state,
    ): {
      active: boolean;
      orderCredential: string | null;
    } => ({
      active: state.transactionRecoveryOrderNo !== null,
      orderCredential: state.transactionRecoveryOrderNo,
    }),
    canCreateOrder: (state): boolean => {
      const selectedItem = latestSaleViewItem(state.selectedItem);
      return Boolean(
        isSaleableItem(selectedItem) &&
        activePlanogramVersion() &&
        isMachineSaleReady() &&
        selectedPaymentOptionForCapability(state.selectedPaymentOptionKey),
      );
    },
    paymentOptions: (): MachinePaymentOption[] =>
      useSaleCapabilityStore().paymentOptions,
    paymentOptionsLoaded: (): boolean =>
      useSaleCapabilityStore().hasAcceptedCapability,
    selectedPaymentOption: (state): MachinePaymentOption | null =>
      selectedPaymentOptionForCapability(state.selectedPaymentOptionKey),
    activePaymentProviderCode: (state): MachinePaymentProviderCode | null => {
      const transactionProviderCode = state.transaction
        ? providerCodeFromSnapshot(state.transaction)
        : null;
      if (transactionProviderCode) return transactionProviderCode;
      return (
        selectedPaymentOptionForCapability(state.selectedPaymentOptionKey)
          ?.providerCode ?? null
      );
    },
    customerErrorMessage: (state): string | null =>
      state.customerError?.message ?? null,
  },
  actions: {
    setCustomerError(
      stage: CustomerErrorStage,
      error: unknown,
      operation: string,
      correlation?: CustomerErrorCorrelation,
    ): void {
      const projection = projectCustomerError(stage, error);
      this.customerError = projection;
      recordCustomerErrorEvidence({
        stage: projection.stage,
        customerMessage: projection.message,
        technicalError: error,
        operation,
        checkoutAttemptIdempotencyKey:
          correlation?.checkoutAttemptIdempotencyKey ??
          this.checkoutAttemptIdempotencyKey,
        orderId: correlation?.orderId ?? this.transaction?.orderId ?? null,
        paymentId:
          correlation?.paymentId ?? this.transaction?.paymentId ?? null,
        orderNo: correlation?.orderNo ?? this.transaction?.orderNo ?? null,
      });
    },
    tick(nowMs = Date.now()): void {
      this.nowMs = nowMs;
    },
    selectItem(item: CheckoutSelectedItem): void {
      if (this.customerCheckoutView.stage !== "none") return;
      this.selectedItem = item;
      this.transaction = null;
      this.paymentCreationAttemptActive = false;
      this.transactionRecoveryOrderNo = null;
      this.customerError = null;
      this.checkoutAttemptIdempotencyKey =
        createCheckoutAttemptIdempotencyKey();
      this.nowMs = Date.now();
      this.syncPaymentOptions();
    },
    reset(): void {
      if (this.customerCheckoutRecovery.active) {
        this.setCustomerError(
          "order_reconciliation",
          new Error("transaction recovery mutation blocked"),
          "checkout.reset",
        );
        return;
      }
      this.selectedItem = null;
      this.transaction = null;
      this.customerError = null;
      this.loading = false;
      this.paymentCodeLastMasked = null;
      this.paymentCreationAttemptActive = false;
      this.checkoutAttemptIdempotencyKey = null;
      this.transactionRecoveryOrderNo = null;
      this.nowMs = Date.now();
    },
    shouldIgnoreTransaction(snapshot: TransactionSnapshot | null): boolean {
      if (!snapshot?.orderNo) return false;
      return (
        this.dismissedTerminalOrderNos.includes(snapshot.orderNo) &&
        projectCustomerCheckoutView({
          transaction: snapshot,
          nowMs: this.nowMs,
          dismissedTerminalOrderNos: this.dismissedTerminalOrderNos,
          restored: this.lastTransactionRestored,
          loading: this.loading,
          readiness: customerCheckoutReadinessContext(),
        }).stage === "none"
      );
    },
    dismissCurrentTerminalTransaction(): void {
      const view = this.customerCheckoutView;
      const orderNo = view.orderCredential;
      if (!orderNo || view.stage !== "result") return;
      this.dismissedTerminalOrderNos = rememberDismissedTerminalOrderNo(
        this.dismissedTerminalOrderNos,
        orderNo,
      );
      writeDismissedTerminalOrderNos(this.dismissedTerminalOrderNos);
      if (this.transaction?.orderNo === orderNo) {
        this.transaction = null;
      }
      if (this.transactionRecoveryOrderNo === orderNo) {
        this.transactionRecoveryOrderNo = null;
      }
    },
    applyTransaction(
      snapshot: TransactionSnapshot,
      options: ApplyTransactionOptions = {},
    ): void {
      const restored = options.restored === true;
      this.lastTransactionRestored = restored;
      if (this.shouldIgnoreTransaction(snapshot)) {
        if (this.transaction?.orderNo === snapshot.orderNo) {
          this.transaction = null;
        }
        return;
      }

      this.transaction = snapshot;
      this.paymentCreationAttemptActive = false;
      this.transactionRecoveryOrderNo = null;

      this.paymentCodeLastMasked =
        snapshot.paymentCodeAttempt?.maskedAuthCode ??
        snapshot.maskedAuthCode ??
        this.paymentCodeLastMasked;
      this.nowMs = Date.now();
    },
    syncPaymentOptions(): void {
      this.loading = true;
      this.customerError = null;
      try {
        if (!useSaleCapabilityStore().hasAcceptedCapability) return;
        this.selectedPaymentOptionKey =
          selectedPaymentOptionForCapability(this.selectedPaymentOptionKey)
            ?.optionKey ?? null;
        if (!this.selectedPaymentOptionKey) {
          this.setCustomerError(
            "device",
            new Error("no payment options"),
            "checkout.sync_payment_options",
          );
        }
      } catch (error) {
        this.setCustomerError("device", error, "checkout.sync_payment_options");
        this.selectedPaymentOptionKey = null;
      } finally {
        this.loading = false;
      }
    },
    selectPaymentOption(optionKey: MachinePaymentOptionKey): void {
      if (this.customerCheckoutRecovery.active) {
        this.setCustomerError(
          "order_reconciliation",
          new Error("transaction recovery mutation blocked"),
          "checkout.select_payment_option",
        );
        return;
      }
      if (
        useSaleCapabilityStore().paymentOptions.some(
          (option) => option.optionKey === optionKey && !option.disabled,
        )
      ) {
        this.selectedPaymentOptionKey = optionKey;
      }
    },
    async createOrder(): Promise<CreateMachineOrderResponse | null> {
      if (this.customerCheckoutRecovery.active) {
        const error = new Error("transaction recovery mutation blocked");
        this.setCustomerError(
          "order_reconciliation",
          error,
          "checkout.create_order",
        );
        throw error;
      }
      if (!this.selectedItem) throw new Error("No selected item");
      this.paymentCreationAttemptActive = true;
      this.transactionRefreshGeneration += 1;
      this.loading = true;
      this.customerError = null;
      const catalogStore = useCatalogStore();
      let selected: MachinePaymentOption | null = null;
      let failureStage: CustomerErrorStage = "payment_creation";
      try {
        await catalogStore.refresh().catch(() => {
          // Keep the existing cached sale view; the backend still performs the authoritative stock check.
        });
        const selectedItem = latestSaleViewItem(this.selectedItem);
        if (!selectedItem) {
          failureStage = "product_refresh";
          throw new Error("商品已更新，请重新选择");
        }
        if (!isSaleableItem(selectedItem)) {
          failureStage = "product_refresh";
          throw new Error("商品已售罄");
        }
        this.selectedItem = selectedItem;

        if (!isMachineSaleReady()) {
          failureStage = "device";
          throw new Error("当前机器暂不可创建订单");
        }
        selected = this.selectedPaymentOption;
        if (!selected || selected.disabled) {
          failureStage = "device";
          throw new Error("请选择支付方式");
        }
        const planogramVersion = activePlanogramVersion();
        if (!planogramVersion) {
          failureStage = "product_refresh";
          throw new Error("当前货道图暂不可创建订单");
        }
        const idempotencyKey =
          this.checkoutAttemptIdempotencyKey ??
          createCheckoutAttemptIdempotencyKey();
        this.checkoutAttemptIdempotencyKey = idempotencyKey;

        const snapshot = await daemonClient.createOrder({
          inventoryId: selectedItem.inventoryId,
          quantity: 1,
          planogramVersion,
          slotId: selectedItem.slotId,
          paymentMethod: selected.method,
          paymentProviderCode: selected.providerCode,
          profileSnapshot: null,
          idempotencyKey,
        });
        this.applyTransaction(snapshot);
        return orderResponseFromSnapshot(snapshot, selectedItem.priceCents);
      } catch (error) {
        this.setCustomerError(
          failureStage === "payment_creation"
            ? customerErrorStageForCreateFailure(error)
            : failureStage,
          error,
          "checkout.create_order",
        );
        await catalogStore.refresh().catch(() => {
          // The original failure remains projected while refresh detail stays technical.
        });
        throw error;
      } finally {
        this.paymentCreationAttemptActive = false;
        this.loading = false;
      }
    },
    async invalidateCurrentTransaction(input?: {
      restored?: boolean;
    }): Promise<TransactionRefreshOutcome> {
      this.transactionRefreshGeneration += 1;
      const coordinator = transactionRefreshCoordinator(this);
      if (coordinator.running) return coordinator.running;

      const refreshGeneration =
        async (): Promise<TransactionRefreshOutcome> => {
          const generation = this.transactionRefreshGeneration;
          this.transactionRefreshRequestNo = generation;
          this.transactionRefreshInFlight = 1;
          this.loading = true;
          this.customerError = null;
          try {
            const snapshot = await daemonClient.getCurrentTransaction();
            if (generation !== this.transactionRefreshGeneration) {
              return refreshGeneration();
            }

            const currentView = this.customerCheckoutView;
            if (
              currentView.stage !== "none" &&
              snapshot.orderNo !== currentView.orderCredential
            ) {
              this.transactionRecoveryOrderNo = currentView.orderCredential;
              this.setCustomerError(
                "order_reconciliation",
                new Error("transaction identity mismatch during recovery"),
                "checkout.refresh_current_transaction",
              );
              return { status: "refreshed", snapshot: null };
            }
            if (this.shouldIgnoreTransaction(snapshot)) {
              this.applyTransaction(snapshot);
              this.transactionRefreshLastAcceptedRequestNo = generation;
              return { status: "refreshed", snapshot: null };
            }
            const restored = input?.restored === true;
            const incomingView = projectCustomerCheckoutView({
              transaction: snapshot,
              nowMs: this.nowMs,
              dismissedTerminalOrderNos: this.dismissedTerminalOrderNos,
              restored,
              loading: this.loading,
              readiness: customerCheckoutReadinessContext(),
            });
            if (
              this.transaction &&
              !canAdvanceTransactionProjection({
                current: this.transaction,
                currentView,
                incoming: snapshot,
                incomingView,
                requestNo: generation,
                lastAcceptedRequestNo:
                  this.transactionRefreshLastAcceptedRequestNo,
              })
            ) {
              return { status: "refreshed", snapshot: this.transaction };
            }
            this.applyTransaction(snapshot, { restored });
            this.transactionRefreshLastAcceptedRequestNo = generation;
            return { status: "refreshed", snapshot };
          } catch (error) {
            if (generation !== this.transactionRefreshGeneration) {
              return refreshGeneration();
            }
            this.setCustomerError(
              "order_reconciliation",
              error,
              "checkout.refresh_current_transaction",
            );
            const view = this.customerCheckoutView;
            if (view.stage !== "none") {
              this.transactionRecoveryOrderNo = view.orderCredential;
            }
            return { status: "failed", snapshot: null, error };
          }
        };
      const running = refreshGeneration().finally(() => {
        this.transactionRefreshInFlight = 0;
        this.loading = false;
        coordinator.running = null;
      });
      coordinator.running = running;
      return running;
    },
    async refreshCurrentTransaction(input?: {
      restored?: boolean;
    }): Promise<TransactionRefreshOutcome> {
      return this.invalidateCurrentTransaction(input);
    },
    async cancelCurrentOrder(options?: {
      preserveSelectedItem?: boolean;
    }): Promise<TransactionSnapshot | null> {
      if (this.customerCheckoutRecovery.active) {
        const error = new Error("transaction recovery mutation blocked");
        this.setCustomerError(
          "order_reconciliation",
          error,
          "checkout.cancel_order",
        );
        throw error;
      }
      const orderNo =
        this.customerCheckoutView.orderCredential ?? this.transaction?.orderNo;
      if (!orderNo) {
        this.reset();
        return null;
      }
      const selectedItemBeforeCancel = this.selectedItem;

      this.loading = true;
      this.customerError = null;
      try {
        const snapshot = await daemonClient.cancelOrder(orderNo);
        this.applyTransaction(snapshot);
        this.dismissCurrentTerminalTransaction();
        this.reset();
        if (options?.preserveSelectedItem && selectedItemBeforeCancel) {
          this.selectedItem = selectedItemBeforeCancel;
        }
        await useCatalogStore()
          .refresh()
          .catch((error: unknown) => {
            this.setCustomerError(
              "product_refresh",
              error,
              "checkout.cancel_order_refresh_catalog",
            );
          });
        return snapshot;
      } catch (error) {
        this.setCustomerError(
          "order_reconciliation",
          error,
          "checkout.cancel_order",
        );
        throw error;
      } finally {
        this.loading = false;
      }
    },
  },
});
