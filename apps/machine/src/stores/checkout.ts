import type { MachineOrderStatusNextAction } from "@vem/shared";

import { defineStore } from "pinia";

import type { MachineConfig } from "@/config/machine-config";
import type {
  CheckoutResultKind,
  CheckoutSelectedItem,
  CreateMachineOrderResponse,
  MachineOrderStatus,
  MachinePaymentOption,
  MachinePaymentOptionKey,
  MachinePaymentProviderCode,
  PaymentCodeSubmitInput,
  PaymentCodeSubmitResponse,
} from "@/types/checkout";

import {
  createMachineOrder,
  getMachineOrderStatus,
  getMachinePaymentOptions,
  submitPaymentCode,
} from "@/api/machine-orders";
import {
  markMockPaymentFailed,
  markMockPaymentSucceeded,
} from "@/api/mock-payments";
import { createMachineApiClient } from "@/api/request";
import { getRemainingSeconds } from "@/utils/format";

export type CheckoutFlowStep =
  | "idle"
  | "detail"
  | "checkout"
  | "payment"
  | "dispensing"
  | "result";

export function resultKindFromNextAction(
  nextAction: MachineOrderStatusNextAction,
): CheckoutResultKind | null {
  if (nextAction === "success") return "success";
  if (nextAction === "payment_failed") return "payment_failed";
  if (nextAction === "payment_expired") return "payment_expired";
  if (nextAction === "dispense_failed") return "dispense_failed";
  if (nextAction === "refund_pending") return "refund_pending";
  if (nextAction === "refunded") return "refunded";
  if (nextAction === "manual_handling") return "manual_handling";
  if (nextAction === "closed") return "closed";
  return null;
}

export const useCheckoutStore = defineStore("checkout", {
  state: () => ({
    selectedItem: null as CheckoutSelectedItem | null,
    currentOrder: null as CreateMachineOrderResponse | null,
    status: null as MachineOrderStatus | null,
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
    canCreateOrder: (state): boolean =>
      Boolean(
        state.selectedItem &&
        state.selectedItem.availableQty > 0 &&
        state.selectedPaymentOptionKey &&
        state.paymentOptions.find(
          (option) => option.optionKey === state.selectedPaymentOptionKey,
        )?.disabled !== true,
      ),
    resultKind: (state): CheckoutResultKind | null =>
      state.status ? resultKindFromNextAction(state.status.nextAction) : null,
    selectedPaymentOption: (state): MachinePaymentOption | null =>
      state.paymentOptions.find(
        (option) => option.optionKey === state.selectedPaymentOptionKey,
      ) ?? null,
    activePaymentProviderCode: (state): MachinePaymentProviderCode | null => {
      const statusCode = state.status?.payment.providerCode;
      if (
        statusCode === "mock" ||
        statusCode === "wechat_pay" ||
        statusCode === "alipay"
      )
        return statusCode;
      const orderCode = state.currentOrder?.paymentProviderCode;
      if (
        orderCode === "mock" ||
        orderCode === "wechat_pay" ||
        orderCode === "alipay"
      )
        return orderCode;
      const selected = state.paymentOptions.find(
        (option) => option.optionKey === state.selectedPaymentOptionKey,
      );
      return selected?.providerCode ?? null;
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
      this.flowStep = "detail";
      this.error = null;
      this.nowMs = Date.now();
    },
    reset(): void {
      this.selectedItem = null;
      this.currentOrder = null;
      this.status = null;
      this.flowStep = "idle";
      this.error = null;
      this.loading = false;
      this.paymentCodeSubmitting = false;
      this.paymentCodeMessage = null;
      this.paymentCodeLastMasked = null;
      this.nowMs = Date.now();
      // paymentOptions、selectedPaymentOptionKey、paymentOptionsLoaded 保留，减少重复请求。
    },
    async loadPaymentOptions(config: MachineConfig): Promise<void> {
      if (!config.machineCode) throw new Error("machineCode missing");
      this.loading = true;
      this.error = null;
      try {
        const client = createMachineApiClient(config.apiBaseUrl);
        const response = await getMachinePaymentOptions(client);
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
    async createOrder(
      config: MachineConfig,
    ): Promise<CreateMachineOrderResponse> {
      if (!config.machineCode) throw new Error("machineCode missing");
      if (!this.selectedItem) throw new Error("No selected item");
      if (this.selectedItem.availableQty <= 0) throw new Error("商品已售罄");

      const selected = this.selectedPaymentOption;
      if (!selected || selected.disabled) throw new Error("请选择支付方式");

      const paymentPayload =
        selected.method === "mock"
          ? {
              paymentMethod: "mock" as const,
              paymentProviderCode: "mock" as const,
            }
          : {
              paymentMethod: selected.method,
              paymentProviderCode: selected.providerCode,
            };

      this.loading = true;
      this.error = null;
      try {
        const client = createMachineApiClient(config.apiBaseUrl);
        const order = await createMachineOrder(client, {
          machineCode: config.machineCode,
          items: [{ inventoryId: this.selectedItem.inventoryId, quantity: 1 }],
          ...paymentPayload,
        });
        this.currentOrder = order;
        this.flowStep = "payment";
        this.nowMs = Date.now();
        return order;
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        this.loading = false;
      }
    },
    async refreshStatus(
      config: MachineConfig,
    ): Promise<MachineOrderStatus | null> {
      if (!config.machineCode || !this.currentOrder) return null;

      this.loading = true;
      this.error = null;
      try {
        const client = createMachineApiClient(config.apiBaseUrl);
        const status = await getMachineOrderStatus(client, {
          orderNo: this.currentOrder.orderNo,
          machineCode: config.machineCode,
        });
        this.status = status;
        this.nowMs = Date.now();
        if (status.nextAction === "dispensing") this.flowStep = "dispensing";
        if (resultKindFromNextAction(status.nextAction))
          this.flowStep = "result";
        return status;
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
        return null;
      } finally {
        this.loading = false;
      }
    },
    async submitScannedPaymentCode(
      config: MachineConfig,
      authCode: string,
      source: PaymentCodeSubmitInput["source"],
      scannerHealth?: PaymentCodeSubmitInput["scannerHealth"],
    ): Promise<PaymentCodeSubmitResponse | null> {
      if (!config.machineCode || !this.currentOrder) return null;
      if (this.paymentCodeSubmitting) return null;
      const idempotencyKey = `${this.currentOrder.orderNo}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
      this.paymentCodeSubmitting = true;
      this.paymentCodeMessage = "正在提交付款码";
      try {
        const client = createMachineApiClient(config.apiBaseUrl);
        const result = await submitPaymentCode(
          client,
          this.currentOrder.orderNo,
          {
            machineCode: config.machineCode,
            authCode,
            idempotencyKey,
            source,
            scannerHealth,
          },
        );
        this.paymentCodeMessage = result.message;
        await this.refreshStatus(config);
        return result;
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
        return null;
      } finally {
        this.paymentCodeSubmitting = false;
      }
    },
    async markMockSucceeded(config: MachineConfig): Promise<void> {
      if (!this.currentOrder) return;
      await markMockPaymentSucceeded(config, this.currentOrder.orderNo);
      await this.refreshStatus(config);
    },
    async markMockFailed(config: MachineConfig): Promise<void> {
      if (!this.currentOrder) return;
      await markMockPaymentFailed(config, this.currentOrder.orderNo);
      await this.refreshStatus(config);
    },
  },
});
