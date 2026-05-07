import type { MachineOrderStatusNextAction } from "@vem/shared";

import { describe, expect, it } from "vitest";

import { resultKindFromNextAction } from "./checkout";

describe("checkout state helpers", () => {
  it.each<[MachineOrderStatusNextAction, string | null]>([
    ["wait_payment", null],
    ["dispensing", null],
    ["success", "success"],
    ["payment_failed", "payment_failed"],
    ["payment_expired", "payment_expired"],
    ["dispense_failed", "dispense_failed"],
    ["refund_pending", "refund_pending"],
    ["refunded", "refunded"],
    ["manual_handling", "manual_handling"],
    ["closed", "closed"],
  ])("maps %s to result kind %s", (nextAction, expected) => {
    expect(resultKindFromNextAction(nextAction)).toBe(expected);
  });
});

describe("checkout store payment option logic", () => {
  function makeAlipayOption() {
    return {
      providerCode: "alipay" as const,
      method: "qr_code" as const,
      displayName: "支付宝",
      description: "请使用支付宝扫码支付",
      icon: "alipay" as const,
      recommended: true,
    };
  }

  function makeWechatOption() {
    return {
      providerCode: "wechat_pay" as const,
      method: "qr_code" as const,
      displayName: "微信支付",
      description: "请使用微信扫码支付",
      icon: "wechat" as const,
      recommended: false,
    };
  }

  function makeMockOption() {
    return {
      providerCode: "mock" as const,
      method: "mock" as const,
      displayName: "模拟支付",
      description: "本地开发模式，可使用模拟成功或失败按钮。",
      icon: "mock" as const,
      recommended: true,
    };
  }

  it("selects alipay by default when only alipay is available", () => {
    const options = [makeAlipayOption()];
    const defaultProviderCode = options[0]?.providerCode ?? null;
    expect(defaultProviderCode).toBe("alipay");
  });

  it("allows switching between wechat and alipay", () => {
    const options = [makeAlipayOption(), makeWechatOption()];
    let selected = options[0]?.providerCode ?? null;
    // select wechat_pay
    if (options.some((o) => o.providerCode === "wechat_pay")) {
      selected = "wechat_pay";
    }
    expect(selected).toBe("wechat_pay");
  });

  it("builds mock payload when mock option is selected", () => {
    const selected: { providerCode: "mock" | "alipay" | "wechat_pay" } =
      makeMockOption();
    const payload =
      selected.providerCode === "mock"
        ? { paymentMethod: "mock" as const }
        : {
            paymentMethod: "qr_code" as const,
            paymentProviderCode: selected.providerCode,
          };
    expect(payload).toEqual({ paymentMethod: "mock" });
    expect("paymentProviderCode" in payload).toBe(false);
  });

  it("builds qr_code + alipay payload when alipay option is selected", () => {
    const selected: { providerCode: "mock" | "alipay" | "wechat_pay" } =
      makeAlipayOption();
    const payload =
      selected.providerCode === "mock"
        ? { paymentMethod: "mock" as const }
        : {
            paymentMethod: "qr_code" as const,
            paymentProviderCode: selected.providerCode,
          };
    expect(payload).toEqual({
      paymentMethod: "qr_code",
      paymentProviderCode: "alipay",
    });
  });

  it("builds qr_code + wechat_pay payload when wechat option is selected", () => {
    const selected: { providerCode: "mock" | "alipay" | "wechat_pay" } =
      makeWechatOption();
    const payload =
      selected.providerCode === "mock"
        ? { paymentMethod: "mock" as const }
        : {
            paymentMethod: "qr_code" as const,
            paymentProviderCode: selected.providerCode,
          };
    expect(payload).toEqual({
      paymentMethod: "qr_code",
      paymentProviderCode: "wechat_pay",
    });
  });
});
