import type { SaleStartCapabilitySnapshot } from "@/daemon/schemas";

import { useSaleCapabilityStore } from "@/stores/sale-capability";

type CapabilityFixtureOptions = {
  generation?: string;
  revision?: number;
  canStartSale?: boolean;
  blockerCode?: string;
  blockerMessage?: string;
  degradationCode?: string;
  degradationMessage?: string;
  paymentCodeReady?: boolean;
};

export function saleCapabilitySnapshot(
  options: CapabilityFixtureOptions = {},
): SaleStartCapabilitySnapshot {
  const canStartSale = options.canStartSale ?? true;
  const paymentCodeReady = options.paymentCodeReady ?? true;
  return {
    generation: options.generation ?? "machine-test-daemon",
    revision: options.revision ?? 1,
    observedAt: "2026-07-17T00:00:00.000Z",
    canStartSale,
    blockers: canStartSale
      ? []
      : [
          {
            code: options.blockerCode ?? "PLATFORM_UNREACHABLE",
            component: "sale_start",
            message: options.blockerMessage ?? "platform unavailable",
          },
        ],
    degradations: options.degradationCode
      ? [
          {
            code: options.degradationCode,
            component: "sale_start",
            message:
              options.degradationMessage ?? "optional capability unavailable",
          },
        ]
      : [],
    paymentOptions: {
      ready: true,
      defaultOptionKey: "qr_code:alipay",
      defaultProviderCode: "alipay",
      options: [
        {
          optionKey: "qr_code:alipay",
          providerCode: "alipay",
          method: "qr_code",
          displayName: "支付宝",
          description: "扫码支付",
          icon: "alipay",
          recommended: true,
          ready: true,
          disabledReason: null,
        },
        {
          optionKey: "payment_code:alipay",
          providerCode: "alipay",
          method: "payment_code",
          displayName: "支付宝付款码",
          description: "出示付款码",
          icon: "alipay",
          recommended: false,
          ready: paymentCodeReady,
          disabledReason: paymentCodeReady ? null : "扫码器暂不可用",
        },
      ],
    },
  };
}

export function applySaleCapability(
  options: CapabilityFixtureOptions = {},
): SaleStartCapabilitySnapshot {
  const snapshot = saleCapabilitySnapshot(options);
  useSaleCapabilityStore().acceptSnapshot(snapshot);
  return snapshot;
}
