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
import { daemonClient } from "@/daemon/client";
import { useCatalogStore } from "@/stores/catalog";
import { useConnectivityStore } from "@/stores/connectivity";

export type ApplyTransactionOptions = {
  restored?: boolean;
};

const DISMISSED_TERMINAL_ORDER_STORAGE_KEY =
  "vem.machine.dismissedTerminalOrderNos";
const DISMISSED_TERMINAL_ORDER_LIMIT = 50;
const PAYMENT_CODE_SCANNER_UNAVAILABLE_CUSTOMER_MESSAGE =
  "扫码器暂不可用，请选择其他支付方式";

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

function paymentCodeAttemptMessageFromSnapshot(
  attempt: TransactionSnapshot["paymentCodeAttempt"],
  operatorHint: string | null | undefined,
): string | null {
  if (!attempt) return operatorHint ?? null;
  if (attempt.message) return attempt.message;
  if (attempt.status === "failed") {
    return "付款码无效或支付失败，请刷新付款码后重试";
  }
  if (attempt.status === "reversed" || attempt.status === "canceled") {
    return "本次付款码交易已撤销，请刷新付款码后重试";
  }
  if (attempt.status === "unknown" || attempt.status === "manual_handling") {
    return "支付结果待确认，请联系工作人员处理";
  }
  return operatorHint ?? null;
}

function errorString(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stringField(error: unknown, key: string): string | null {
  if (typeof error !== "object" || error === null || !(key in error)) {
    return null;
  }
  const value = Object.fromEntries(Object.entries(error))[key];
  return typeof value === "string" ? value : null;
}

function selectedPaymentCodeLocalGateError(
  error: unknown,
  selected: MachinePaymentOption | null,
): boolean {
  if (selected?.method !== "payment_code") return false;
  const responseCode = stringField(error, "responseCode");
  const text = [
    errorString(error),
    stringField(error, "responseMessage"),
    stringField(error, "responseBody"),
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n");
  const lower = text.toLowerCase();

  return (
    responseCode === "create_order_blocked" &&
    (text.includes("扫码器") ||
      lower.includes("selected payment option is not ready") ||
      lower.includes("selected payment method payment_code is unavailable") ||
      lower.includes("scanner"))
  );
}

function paymentCodeSubmitLocalGateError(error: unknown): boolean {
  const text = [
    errorString(error),
    stringField(error, "responseMessage"),
    stringField(error, "responseBody"),
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n");
  const lower = text.toLowerCase();
  return (
    text.includes("扫码器") ||
    lower.includes("machine_not_ready_for_payment_code") ||
    lower.includes("scanner")
  );
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
  return useConnectivityStore().isSaleNetworkReady;
}

function suggestedReturnRoute(): CustomerCheckoutReturnRoute {
  const connectivityStore = useConnectivityStore();
  if (connectivityStore.isSaleNetworkReady) return "catalog";
  if (connectivityStore.ready?.suggestedRoute === "maintenance") {
    return "maintenance";
  }
  return "offline";
}

function requiresMaintenanceReview(): boolean {
  const connectivityStore = useConnectivityStore();
  return Boolean(
    connectivityStore.ready?.suggestedRoute === "maintenance" ||
    connectivityStore.ready?.blockingCodes.includes(
      "WHOLE_MACHINE_HARDWARE_FAULT",
    ) ||
    connectivityStore.saleReadiness?.blockingCodes.includes(
      "WHOLE_MACHINE_HARDWARE_FAULT",
    ) ||
    connectivityStore.saleReadiness?.components.wholeMachineBlockers.ready ===
      false,
  );
}

function customerCheckoutReadinessContext(): CustomerCheckoutReadinessContext {
  const connectivityStore = useConnectivityStore();
  return {
    saleReady: connectivityStore.isSaleNetworkReady,
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

export const useCheckoutStore = defineStore("checkout", {
  state: () => ({
    selectedItem: null as CheckoutSelectedItem | null,
    transaction: null as TransactionSnapshot | null,
    nowMs: Date.now(),
    loading: false,
    error: null as string | null,
    paymentOptions: [] as MachinePaymentOption[],
    selectedPaymentOptionKey: null as MachinePaymentOptionKey | null,
    paymentCodeSubmitting: false,
    paymentCodeMessage: null as string | null,
    paymentCodeLastMasked: null as string | null,
    paymentOptionsLoaded: false,
    checkoutAttemptIdempotencyKey: null as string | null,
    dismissedTerminalOrderNos: readDismissedTerminalOrderNos(),
    lastTransactionRestored: false,
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
    canCreateOrder: (state): boolean => {
      const selectedItem = latestSaleViewItem(state.selectedItem);
      return Boolean(
        isSaleableItem(selectedItem) &&
        activePlanogramVersion() &&
        isMachineSaleReady() &&
        state.selectedPaymentOptionKey &&
        state.paymentOptions.find(
          (option) => option.optionKey === state.selectedPaymentOptionKey,
        )?.disabled !== true,
      );
    },
    selectedPaymentOption: (state): MachinePaymentOption | null =>
      state.paymentOptions.find(
        (option) => option.optionKey === state.selectedPaymentOptionKey,
      ) ?? null,
    activePaymentProviderCode: (state): MachinePaymentProviderCode | null => {
      const transactionProviderCode = state.transaction
        ? providerCodeFromSnapshot(state.transaction)
        : null;
      if (transactionProviderCode) return transactionProviderCode;
      return (
        state.paymentOptions.find(
          (option) => option.optionKey === state.selectedPaymentOptionKey,
        )?.providerCode ?? null
      );
    },
  },
  actions: {
    tick(nowMs = Date.now()): void {
      this.nowMs = nowMs;
    },
    selectItem(item: CheckoutSelectedItem): void {
      this.selectedItem = item;
      this.transaction = null;
      this.error = null;
      this.checkoutAttemptIdempotencyKey =
        createCheckoutAttemptIdempotencyKey();
      this.nowMs = Date.now();
    },
    reset(): void {
      this.selectedItem = null;
      this.transaction = null;
      this.error = null;
      this.loading = false;
      this.paymentCodeSubmitting = false;
      this.paymentCodeMessage = null;
      this.paymentCodeLastMasked = null;
      this.checkoutAttemptIdempotencyKey = null;
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

      const attempt = snapshot.paymentCodeAttempt;
      this.paymentCodeMessage =
        paymentCodeAttemptMessageFromSnapshot(attempt, snapshot.operatorHint) ??
        this.paymentCodeMessage;
      this.paymentCodeLastMasked =
        attempt?.maskedAuthCode ??
        snapshot.maskedAuthCode ??
        this.paymentCodeLastMasked;
      this.nowMs = Date.now();
    },
    async loadPaymentOptions(): Promise<void> {
      this.loading = true;
      this.error = null;
      try {
        const response = await daemonClient.getPaymentOptions();
        this.paymentOptions = response.options;
        this.paymentOptionsLoaded = true;
        const enabledDefault = response.options.find(
          (option) =>
            option.optionKey === response.defaultOptionKey && !option.disabled,
        );
        this.selectedPaymentOptionKey =
          enabledDefault?.optionKey ??
          response.options.find((option) => !option.disabled)?.optionKey ??
          null;
        if (!this.selectedPaymentOptionKey) {
          this.error = "当前机器暂无可用支付方式";
        }
      } catch (error) {
        this.error = errorString(error);
        this.paymentOptions = [];
        this.paymentOptionsLoaded = false;
        this.selectedPaymentOptionKey = null;
        throw error;
      } finally {
        this.loading = false;
      }
    },
    selectPaymentOption(optionKey: MachinePaymentOptionKey): void {
      if (
        this.paymentOptions.some(
          (option) => option.optionKey === optionKey && !option.disabled,
        )
      ) {
        this.selectedPaymentOptionKey = optionKey;
      }
    },
    async createOrder(): Promise<CreateMachineOrderResponse | null> {
      if (!this.selectedItem) throw new Error("No selected item");
      const catalogStore = useCatalogStore();
      await catalogStore.refresh().catch(() => {
        // Keep the existing cached sale view; the backend still performs the authoritative stock check.
      });
      const selectedItem = latestSaleViewItem(this.selectedItem);
      if (!selectedItem) {
        throw new Error("商品已更新，请重新选择");
      }
      if (!isSaleableItem(selectedItem)) {
        throw new Error("商品已售罄");
      }
      this.selectedItem = selectedItem;

      const selected = this.selectedPaymentOption;
      if (!selected || selected.disabled) throw new Error("请选择支付方式");
      if (!isMachineSaleReady()) throw new Error("当前机器暂不可创建订单");
      const planogramVersion = activePlanogramVersion();
      if (!planogramVersion) throw new Error("当前货道图暂不可创建订单");
      const idempotencyKey =
        this.checkoutAttemptIdempotencyKey ??
        createCheckoutAttemptIdempotencyKey();
      this.checkoutAttemptIdempotencyKey = idempotencyKey;

      this.loading = true;
      this.error = null;
      try {
        const snapshot = await daemonClient.createOrder({
          inventoryId: selectedItem.inventoryId,
          quantity: 1,
          planogramVersion,
          slotId: selectedItem.slotId,
          slotCode: selectedItem.slotCode,
          paymentMethod: selected.method,
          paymentProviderCode: selected.providerCode,
          profileSnapshot: null,
          idempotencyKey,
        });
        this.applyTransaction(snapshot);
        return orderResponseFromSnapshot(snapshot, selectedItem.priceCents);
      } catch (error) {
        this.error = selectedPaymentCodeLocalGateError(error, selected)
          ? PAYMENT_CODE_SCANNER_UNAVAILABLE_CUSTOMER_MESSAGE
          : errorString(error);
        await catalogStore.refresh().catch(() => {
          // Preserve the original order error; catalog refresh is best-effort after a rejected checkout.
        });
        throw error;
      } finally {
        this.loading = false;
      }
    },
    async refreshCurrentTransaction(): Promise<TransactionSnapshot | null> {
      this.loading = true;
      this.error = null;
      try {
        const snapshot = await daemonClient.getCurrentTransaction();
        if (this.shouldIgnoreTransaction(snapshot)) {
          this.applyTransaction(snapshot);
          return null;
        }
        this.applyTransaction(snapshot);
        return snapshot;
      } catch (error) {
        this.error = errorString(error);
        return null;
      } finally {
        this.loading = false;
      }
    },
    async refreshCustomerCheckoutReadiness(): Promise<string | null> {
      try {
        const [ready, saleReadiness] = await Promise.all([
          daemonClient.getReady(),
          daemonClient.getSaleReadiness(),
        ]);
        const connectivityStore = useConnectivityStore();
        connectivityStore.applyReady(ready);
        connectivityStore.applySaleReadiness(saleReadiness);
        return null;
      } catch (error) {
        return errorString(error);
      }
    },
    async cancelCurrentOrder(options?: {
      preserveSelectedItem?: boolean;
    }): Promise<TransactionSnapshot | null> {
      const orderNo =
        this.customerCheckoutView.orderCredential ?? this.transaction?.orderNo;
      if (!orderNo) {
        this.reset();
        return null;
      }
      const selectedItemBeforeCancel = this.selectedItem;

      this.loading = true;
      this.error = null;
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
            this.error = `订单已取消，但目录刷新失败：${errorString(error)}`;
          });
        return snapshot;
      } catch (error) {
        this.error = errorString(error);
        throw error;
      } finally {
        this.loading = false;
      }
    },
    async submitDevPaymentCode(
      authCode: string,
    ): Promise<TransactionSnapshot | null> {
      const orderNo = this.customerCheckoutView.orderCredential;
      if (!orderNo) return null;
      if (this.paymentCodeSubmitting) return null;
      if (daemonClient.currentConnection?.mock !== true) {
        throw new Error("当前不是 mock daemon，禁止手动提交付款码");
      }

      this.paymentCodeSubmitting = true;
      this.paymentCodeMessage = "正在提交付款码";
      try {
        const snapshot = await daemonClient.submitDevPaymentCode({
          orderNo,
          authCode,
          source: "browser_test",
        });
        this.applyTransaction(snapshot);
        return snapshot;
      } catch (error) {
        this.error = paymentCodeSubmitLocalGateError(error)
          ? PAYMENT_CODE_SCANNER_UNAVAILABLE_CUSTOMER_MESSAGE
          : errorString(error);
        return null;
      } finally {
        this.paymentCodeSubmitting = false;
      }
    },
    async markMockSucceeded(): Promise<void> {
      const orderNo = this.customerCheckoutView.orderCredential;
      if (!orderNo) return;
      this.applyTransaction(await daemonClient.markMockPayment(orderNo, true));
    },
    async markMockFailed(): Promise<void> {
      const orderNo = this.customerCheckoutView.orderCredential;
      if (!orderNo) return;
      this.applyTransaction(await daemonClient.markMockPayment(orderNo, false));
    },
  },
});
