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

function latestSaleViewItem(
  selectedItem: CheckoutSelectedItem | null,
): CheckoutSelectedItem | null {
  if (!selectedItem) return null;
  return (
    useCatalogStore().itemByInventoryId(selectedItem.inventoryId) ??
    selectedItem
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
    applyTransaction(snapshot: TransactionSnapshot): void {
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
              status:
                attempt.status === "failed" ||
                attempt.status === "succeeded" ||
                attempt.status === "user_confirming" ||
                attempt.status === "querying"
                  ? attempt.status
                  : "querying",
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
              message: attempt.message ?? snapshot.operatorHint,
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
            }
          : null,
        refund: null,
        nextAction,
        serverTime: snapshot.updatedAt,
      };

      this.paymentCodeMessage =
        attempt?.message ?? snapshot.operatorHint ?? this.paymentCodeMessage;
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
        this.selectedPaymentOptionKey =
          response.defaultOptionKey ??
          response.options.find((option) => !option.disabled)?.optionKey ??
          response.options[0]?.optionKey ??
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
      const selectedItem = latestSaleViewItem(this.selectedItem);
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
        this.applyTransaction(snapshot);
        return snapshot;
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
        return null;
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
