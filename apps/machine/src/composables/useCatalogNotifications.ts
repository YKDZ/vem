import { computed, type ComputedRef } from "vue";

import { useSaleCapabilityStore } from "@/stores/sale-capability";

type CatalogNotificationTone = "info" | "warning";

export type CatalogNotification = {
  id: string;
  message: string;
  tone: CatalogNotificationTone;
};

type CapabilityReason = {
  code: string;
  component: string;
  message: string;
};

function customerMessageForBlockingCode(code: string): string {
  if (code.startsWith("PLATFORM_") || code.startsWith("SYNC_")) {
    return "网络连接暂时不可用，请稍后再试。";
  }
  if (code.startsWith("PAYMENT_")) {
    return "当前暂无可用支付方式，请稍后再试。";
  }
  if (code.startsWith("PLANOGRAM_") || code.startsWith("SLOT_")) {
    return "当前暂无可售商品，请稍后再来或联系工作人员。";
  }
  if (
    code.startsWith("PRODUCTION_DISPENSE_PATH_") ||
    code.startsWith("WHOLE_MACHINE_") ||
    code.startsWith("LOWER_CONTROLLER_")
  ) {
    return "设备正在维护中，请联系工作人员。";
  }
  return "设备暂时不可购买，请稍后再试。";
}

function customerMessageForDegradedMessage(message: string): string {
  if (message.includes("付款码支付不可用")) {
    return message.includes("二维码支付仍可用")
      ? "付款码支付暂不可用，可继续使用二维码支付。"
      : "付款码支付暂不可用。";
  }
  return "部分支付或设备能力暂不可用。";
}

export function useCatalogNotifications(): {
  notifications: ComputedRef<CatalogNotification[]>;
  primaryNotification: ComputedRef<CatalogNotification | null>;
} {
  const saleCapabilityStore = useSaleCapabilityStore();

  const notifications = computed<CatalogNotification[]>(() => {
    if (!saleCapabilityStore.accepted) {
      return [
        {
          id: "sale-capability-updating",
          message: "正在确认当前购买状态，请稍候。",
          tone: "info",
        },
      ];
    }

    if (!saleCapabilityStore.canStartSale) {
      const blocker: CapabilityReason | null =
        saleCapabilityStore.accepted.blockers[0] ?? null;
      return [
        {
          id: blocker?.code ?? "sale-start-capability",
          message: customerMessageForBlockingCode(blocker?.code ?? ""),
          tone: "warning",
        },
      ];
    }

    const degradedMessage = saleCapabilityStore.degradationMessages[0] ?? null;
    if (degradedMessage) {
      return [
        {
          id: "sale-capability-degraded",
          message: customerMessageForDegradedMessage(degradedMessage),
          tone: "info",
        },
      ];
    }

    return [];
  });

  const primaryNotification = computed(() => notifications.value[0] ?? null);

  return {
    notifications,
    primaryNotification,
  };
}
