import type { MachineOrderStatusNextAction } from "@vem/shared";

import { defineStore } from "pinia";

import type { MachineConfig } from "@/config/machine-config";
import type {
  CheckoutResultKind,
  CheckoutSelectedItem,
  CreateMachineOrderResponse,
  MachineOrderStatus,
  MachinePaymentOption,
  MachinePaymentProviderCode,
} from "@/types/checkout";

import {
  createMachineOrder,
  getMachineOrderStatus,
  getMachinePaymentOptions,
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
    selectedPaymentProviderCode: null as MachinePaymentProviderCode | null,
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
        state.selectedPaymentProviderCode,
      ),
    resultKind: (state): CheckoutResultKind | null =>
      state.status ? resultKindFromNextAction(state.status.nextAction) : null,
    selectedPaymentOption: (state): MachinePaymentOption | null =>
      state.paymentOptions.find(
        (option) => option.providerCode === state.selectedPaymentProviderCode,
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
      return state.selectedPaymentProviderCode;
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
      this.nowMs = Date.now();
      // paymentOptions、selectedPaymentProviderCode、paymentOptionsLoaded 保留，减少重复请求。
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
        this.selectedPaymentProviderCode =
          response.defaultProviderCode ??
          response.options[0]?.providerCode ??
          null;
        if (!this.selectedPaymentProviderCode) {
          this.error = "当前机器暂无可用支付方式";
        }
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
        this.paymentOptions = [];
        this.paymentOptionsLoaded = false;
        this.selectedPaymentProviderCode = null;
        throw error;
      } finally {
        this.loading = false;
      }
    },
    selectPaymentProvider(providerCode: MachinePaymentProviderCode): void {
      if (
        this.paymentOptions.some(
          (option) => option.providerCode === providerCode,
        )
      ) {
        this.selectedPaymentProviderCode = providerCode;
      }
    },
    async createOrder(
      config: MachineConfig,
    ): Promise<CreateMachineOrderResponse> {
      if (!config.machineCode) throw new Error("machineCode missing");
      if (!this.selectedItem) throw new Error("No selected item");
      if (this.selectedItem.availableQty <= 0) throw new Error("商品已售罄");

      const selected = this.selectedPaymentOption;
      if (!selected) throw new Error("请选择支付方式");

      const paymentPayload =
        selected.providerCode === "mock"
          ? { paymentMethod: "mock" as const }
          : {
              paymentMethod: "qr_code" as const,
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
