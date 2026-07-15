import type { MachinePaymentProviderCode } from "@vem/shared";

export type PaymentProviderCopy = {
  title: string;
  subtitle: string;
  qrAlt: string;
};

export function getPaymentProviderCopy(
  providerCode: MachinePaymentProviderCode | null | undefined,
): PaymentProviderCopy {
  if (providerCode === "alipay") {
    return {
      title: "支付宝扫码支付",
      subtitle: "请使用支付宝扫码完成支付。",
      qrAlt: "支付宝支付二维码",
    };
  }
  if (providerCode === "wechat_pay") {
    return {
      title: "微信扫码支付",
      subtitle: "请使用微信扫码完成支付。",
      qrAlt: "微信支付二维码",
    };
  }
  if (providerCode === "mock") {
    return {
      title: "模拟支付",
      subtitle: "本地开发模式，可使用模拟成功或失败按钮。",
      qrAlt: "模拟支付二维码",
    };
  }
  return {
    title: "扫码支付",
    subtitle: "请使用所选支付 App 扫码完成支付。",
    qrAlt: "支付二维码",
  };
}
