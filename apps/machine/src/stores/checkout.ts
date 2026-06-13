import type { MachineOrderStatusNextAction } from "@vem/shared";

import { defineStore } from "pinia";

import type { TransactionSnapshot } from "@/daemon/schemas";
import type {
  CheckoutResultKind,
  CheckoutSelectedItem,
  CreateMachineOrderResponse,
  MachineOrderStatus,
  MachinePaymentOption,
  MachinePaymentOptionKey,
  MachinePaymentProviderCode,
} from "@/types/checkout";

import { daemonClient } from "@/daemon/client";
import { useCatalogStore } from "@/stores/catalog";
import { useConnectivityStore } from "@/stores/connectivity";
import { getRemainingSeconds } from "@/utils/format";

export type CheckoutFlowStep =
  | "idle"
  | "detail"
  | "checkout"
  | "payment"
  | "dispensing"
  | "result";

export function normalizeNextAction(
  nextAction: string | null | undefined,
): MachineOrderStatusNextAction {
  switch (nextAction) {
    case null:
    case undefined:
      return "wait_payment";
    case "wait_payment":
    case "dispensing":
    case "success":
    case "payment_failed":
    case "payment_expired":
    case "dispense_failed":
    case "refund_pending":
    case "refunded":
    case "manual_handling":
    case "closed":
      return nextAction;
    default:
      return "wait_payment";
  }
}

export function resultKindFromNextAction(
  nextAction: MachineOrderStatusNextAction,
): CheckoutResultKind | null {
  if (nextAction === "wait_payment") return null;
  if (nextAction === "dispensing") return null;
  return nextAction;
}

const DISMISSED_TERMINAL_ORDER_STORAGE_KEY =
  "vem.machine.dismissedTerminalOrderNos";
const DISMISSED_TERMINAL_ORDER_LIMIT = 50;

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

export function isTerminalResultNextAction(
  nextAction: string | null | undefined,
): boolean {
  return resultKindFromNextAction(normalizeNextAction(nextAction)) !== null;
}

function paymentMethodFromSnapshot(
  snapshot: TransactionSnapshot,
): MachineOrderStatus["payment"]["method"] {
  if (snapshot.paymentMethod === "payment_code") return "payment_code";
  if (snapshot.paymentMethod === "mock") return "mock";
  return "qr_code";
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

function orderStatusFromSnapshot(
  snapshot: TransactionSnapshot,
): MachineOrderStatus["orderStatus"] {
  switch (snapshot.orderStatus) {
    case null:
      return "pending_payment";
    case "pending_payment":
    case "payment_expired":
    case "canceled":
    case "paid":
    case "dispensing":
    case "fulfilled":
    case "dispense_failed":
    case "manual_handling":
    case "refund_pending":
    case "refunded":
    case "closed":
      return snapshot.orderStatus;
    default:
      return "pending_payment";
  }
}

function paymentStatusFromSnapshot(
  snapshot: TransactionSnapshot,
): MachineOrderStatus["payment"]["status"] {
  switch (snapshot.paymentStatus) {
    case null:
      return "pending";
    case "created":
    case "pending":
    case "processing":
    case "succeeded":
    case "failed":
    case "expired":
    case "canceled":
    case "refund_pending":
    case "refunded":
    case "partial_refunded":
      return snapshot.paymentStatus;
    default:
      return "pending";
  }
}

function paymentStateFromSnapshot(
  snapshot: TransactionSnapshot,
): MachineOrderStatus["paymentState"] {
  switch (snapshot.paymentStatus) {
    case "succeeded":
      return "paid";
    case "failed":
      return "payment_failed";
    case "expired":
      return "payment_expired";
    case "canceled":
      return "canceled";
    case "refund_pending":
    case "refunded":
    case "partial_refunded":
      return snapshot.paymentStatus;
  }

  switch (orderStatusFromSnapshot(snapshot)) {
    case "payment_expired":
      return "payment_expired";
    case "canceled":
    case "closed":
      return "canceled";
    case "paid":
    case "dispensing":
    case "fulfilled":
    case "dispense_failed":
    case "manual_handling":
      return "paid";
    case "refund_pending":
      return "refund_pending";
    case "refunded":
      return "refunded";
    default:
      return "awaiting_payment";
  }
}

function paymentCodeAttemptStatusFromSnapshot(
  status: string | null | undefined,
): NonNullable<MachineOrderStatus["paymentCodeAttempt"]>["status"] {
  switch (status) {
    case "created":
    case "submitting":
    case "user_confirming":
    case "querying":
    case "succeeded":
    case "failed":
    case "reversing":
    case "reversed":
    case "unknown":
    case "manual_handling":
    case "canceled":
      return status;
    default:
      return "querying";
  }
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

function fulfillmentStateFromSnapshot(
  snapshot: TransactionSnapshot,
): MachineOrderStatus["fulfillmentState"] {
  switch (orderStatusFromSnapshot(snapshot)) {
    case "dispensing":
      return "dispensing";
    case "fulfilled":
      return "dispensed";
    case "dispense_failed":
      return "dispense_failed";
    case "manual_handling":
    case "refund_pending":
    case "refunded":
      return "manual_handling";
    case "payment_expired":
    case "canceled":
    case "closed":
      return "canceled";
    default:
      return "awaiting_fulfillment";
  }
}

function latestSaleViewItem(
  selectedItem: CheckoutSelectedItem | null,
): CheckoutSelectedItem | null {
  if (!selectedItem) return null;
  const catalogStore = useCatalogStore();
  return (
    catalogStore.saleableItemFor(selectedItem) ??
    catalogStore.itemByCatalogKey(selectedItem.catalogKey) ??
    null
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

function vendingStatusFromSnapshot(
  snapshot: NonNullable<TransactionSnapshot["vending"]>,
): NonNullable<MachineOrderStatus["vending"]>["status"] {
  switch (snapshot.status) {
    case null:
      return "pending";
    case "pending":
    case "sent":
    case "acknowledged":
    case "succeeded":
    case "failed":
    case "timeout":
      return snapshot.status;
    default:
      return "pending";
  }
}

export const useCheckoutStore = defineStore("checkout", {
  state: () => ({
    selectedItem: null as CheckoutSelectedItem | null,
    currentOrder: null as CreateMachineOrderResponse | null,
    status: null as MachineOrderStatus | null,
    transaction: null as TransactionSnapshot | null,
    flowStep: "idle" as CheckoutFlowStep,
    nowMs: Date.now(),
    loading: false,
    error: null as string | null,
    paymentOptions: [] as MachinePaymentOption[],
    selectedPaymentOptionKey: null as MachinePaymentOptionKey | null,
    paymentCodeSubmitting: false,
    paymentCodeMessage: null as string | null,
    paymentCodeLastMasked: null as string | null,
    paymentOptionsLoaded: false,
    dismissedTerminalOrderNos: readDismissedTerminalOrderNos(),
  }),
  getters: {
    quantity: (): number => 1,
    remainingSeconds: (state): number =>
      getRemainingSeconds(state.currentOrder?.expiresAt, state.nowMs),
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
    resultKind: (state): CheckoutResultKind | null =>
      state.status ? resultKindFromNextAction(state.status.nextAction) : null,
    selectedPaymentOption: (state): MachinePaymentOption | null =>
      state.paymentOptions.find(
        (option) => option.optionKey === state.selectedPaymentOptionKey,
      ) ?? null,
    activePaymentProviderCode: (state): MachinePaymentProviderCode | null => {
      const statusCode = state.status?.payment.providerCode;
      if (statusCode) return statusCode;
      const orderCode = state.currentOrder?.paymentProviderCode;
      if (orderCode) return orderCode;
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
      this.currentOrder = null;
      this.status = null;
      this.transaction = null;
      this.flowStep = "detail";
      this.error = null;
      this.nowMs = Date.now();
    },
    reset(): void {
      this.selectedItem = null;
      this.currentOrder = null;
      this.status = null;
      this.transaction = null;
      this.flowStep = "idle";
      this.error = null;
      this.loading = false;
      this.paymentCodeSubmitting = false;
      this.paymentCodeMessage = null;
      this.paymentCodeLastMasked = null;
      this.nowMs = Date.now();
    },
    shouldIgnoreTransaction(snapshot: TransactionSnapshot | null): boolean {
      return Boolean(
        snapshot?.orderNo &&
        isTerminalResultNextAction(snapshot.nextAction) &&
        this.dismissedTerminalOrderNos.includes(snapshot.orderNo),
      );
    },
    dismissCurrentTerminalTransaction(): void {
      const orderNo = this.transaction?.orderNo ?? this.currentOrder?.orderNo;
      const nextAction =
        this.status?.nextAction ?? this.transaction?.nextAction ?? null;
      if (!orderNo || !isTerminalResultNextAction(nextAction)) return;
      this.dismissedTerminalOrderNos = rememberDismissedTerminalOrderNo(
        this.dismissedTerminalOrderNos,
        orderNo,
      );
      writeDismissedTerminalOrderNos(this.dismissedTerminalOrderNos);
    },
    applyTransaction(snapshot: TransactionSnapshot): void {
      if (this.shouldIgnoreTransaction(snapshot)) {
        if (
          this.transaction?.orderNo === snapshot.orderNo ||
          this.currentOrder?.orderNo === snapshot.orderNo
        ) {
          this.transaction = null;
          this.currentOrder = null;
          this.status = null;
          if (
            this.flowStep === "payment" ||
            this.flowStep === "dispensing" ||
            this.flowStep === "result"
          ) {
            this.flowStep = "idle";
          }
        }
        return;
      }

      this.transaction = snapshot;

      if (!snapshot.orderNo) {
        this.currentOrder = null;
        this.status = null;
        return;
      }

      const providerCode = providerCodeFromSnapshot(snapshot);
      this.currentOrder = {
        orderId: snapshot.orderId ?? snapshot.orderNo,
        orderNo: snapshot.orderNo,
        paymentNo: snapshot.paymentNo ?? "-",
        paymentUrl: snapshot.paymentUrl,
        expiresAt: snapshot.expiresAt ?? snapshot.updatedAt,
        totalAmountCents:
          snapshot.totalAmountCents ?? this.selectedItem?.priceCents ?? 0,
        paymentProviderCode: providerCode,
      };

      const nextAction = normalizeNextAction(snapshot.nextAction);
      const attempt = snapshot.paymentCodeAttempt;
      this.status = {
        orderId: snapshot.orderId ?? snapshot.orderNo,
        orderNo: snapshot.orderNo,
        machineCode: "daemon",
        orderStatus: orderStatusFromSnapshot(snapshot),
        paymentState: paymentStateFromSnapshot(snapshot),
        fulfillmentState: fulfillmentStateFromSnapshot(snapshot),
        totalAmountCents:
          snapshot.totalAmountCents ?? this.currentOrder.totalAmountCents,
        payment: {
          paymentNo: snapshot.paymentNo ?? "-",
          method: paymentMethodFromSnapshot(snapshot),
          status: paymentStatusFromSnapshot(snapshot),
          paymentUrl: snapshot.paymentUrl,
          expiresAt: snapshot.expiresAt,
          paidAt: null,
          failedReason: snapshot.errorMessage,
          providerCode,
        },
        paymentCodeAttempt: attempt
          ? {
              attemptNo: attempt.attemptNo ?? 1,
              status: paymentCodeAttemptStatusFromSnapshot(attempt.status),
              maskedAuthCode: attempt.maskedAuthCode,
              source:
                attempt.source === "serial_text" ||
                attempt.source === "tauri_scanner" ||
                attempt.source === "browser_test" ||
                attempt.source === "manual_dev"
                  ? attempt.source
                  : null,
              idempotencyKey: attempt.idempotencyKey,
              submittedAt: attempt.submittedAt,
              lastCheckedAt: attempt.lastCheckedAt,
              canRetry: attempt.canRetry,
              message: paymentCodeAttemptMessageFromSnapshot(
                attempt,
                snapshot.operatorHint,
              ),
            }
          : null,
        vending: snapshot.vending
          ? {
              commandNo: snapshot.vending.commandNo ?? "-",
              status: vendingStatusFromSnapshot(snapshot.vending),
              sentAt: null,
              ackAt: null,
              resultAt: null,
              lastError: snapshot.vending.lastError,
              pickupReminder: snapshot.vending.pickupReminder ?? null,
            }
          : null,
        refund: null,
        nextAction,
        serverTime: snapshot.updatedAt,
      };

      this.paymentCodeMessage =
        paymentCodeAttemptMessageFromSnapshot(attempt, snapshot.operatorHint) ??
        this.paymentCodeMessage;
      this.paymentCodeLastMasked =
        attempt?.maskedAuthCode ??
        snapshot.maskedAuthCode ??
        this.paymentCodeLastMasked;
      this.nowMs = Date.now();

      if (nextAction === "dispensing") {
        this.flowStep = "dispensing";
      } else if (resultKindFromNextAction(nextAction)) {
        this.flowStep = "result";
      } else if (this.currentOrder) {
        this.flowStep = "payment";
      }
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
        this.error = error instanceof Error ? error.message : String(error);
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
        });
        this.applyTransaction(snapshot);
        this.flowStep = "payment";
        return this.currentOrder;
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
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
        this.error = error instanceof Error ? error.message : String(error);
        return null;
      } finally {
        this.loading = false;
      }
    },
    async cancelCurrentOrder(): Promise<TransactionSnapshot | null> {
      const orderNo = this.currentOrder?.orderNo ?? this.transaction?.orderNo;
      if (!orderNo) {
        this.reset();
        return null;
      }

      this.loading = true;
      this.error = null;
      try {
        const snapshot = await daemonClient.cancelOrder(orderNo);
        this.applyTransaction(snapshot);
        this.dismissCurrentTerminalTransaction();
        this.reset();
        await useCatalogStore()
          .refresh()
          .catch((error: unknown) => {
            this.error = `订单已取消，但目录刷新失败：${
              error instanceof Error ? error.message : String(error)
            }`;
          });
        return snapshot;
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        this.loading = false;
      }
    },
    async submitDevPaymentCode(
      authCode: string,
    ): Promise<TransactionSnapshot | null> {
      if (!this.currentOrder) return null;
      if (this.paymentCodeSubmitting) return null;
      if (daemonClient.currentConnection?.mock !== true) {
        throw new Error("当前不是 mock daemon，禁止手动提交付款码");
      }

      this.paymentCodeSubmitting = true;
      this.paymentCodeMessage = "正在提交付款码";
      try {
        const snapshot = await daemonClient.submitDevPaymentCode({
          orderNo: this.currentOrder.orderNo,
          authCode,
          source: "browser_test",
        });
        this.applyTransaction(snapshot);
        return snapshot;
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
        return null;
      } finally {
        this.paymentCodeSubmitting = false;
      }
    },
    async markMockSucceeded(): Promise<void> {
      if (!this.currentOrder) return;
      this.applyTransaction(
        await daemonClient.markMockPayment(this.currentOrder.orderNo, true),
      );
    },
    async markMockFailed(): Promise<void> {
      if (!this.currentOrder) return;
      this.applyTransaction(
        await daemonClient.markMockPayment(this.currentOrder.orderNo, false),
      );
    },
  },
});
