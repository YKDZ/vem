import { describe, expect, it } from "vitest";

import { getPaymentProviderCopy } from "./payment-copy";

describe("getPaymentProviderCopy", () => {
  it("never exposes provider environment vocabulary in real-provider customer copy", () => {
    const copy = JSON.stringify([
      getPaymentProviderCopy("alipay"),
      getPaymentProviderCopy("wechat_pay"),
    ]);
    expect(copy).not.toMatch(/sandbox|沙箱|testbed|测试环境/i);
  });

  it("returns alipay copy for alipay providerCode", () => {
    const copy = getPaymentProviderCopy("alipay");
    expect(copy.title).toBe("支付宝扫码支付");
    expect(copy.qrAlt).toBe("支付宝支付二维码");
  });

  it("returns wechat copy for wechat_pay providerCode", () => {
    const copy = getPaymentProviderCopy("wechat_pay");
    expect(copy.title).toBe("微信扫码支付");
    expect(copy.qrAlt).toBe("微信支付二维码");
  });

  it("returns mock copy for mock providerCode", () => {
    const copy = getPaymentProviderCopy("mock");
    expect(copy.title).toBe("模拟支付");
    expect(copy.qrAlt).toBe("模拟支付二维码");
  });

  it("returns fallback copy for null providerCode", () => {
    const copy = getPaymentProviderCopy(null);
    expect(copy.title).toBe("扫码支付");
    expect(copy.qrAlt).toBe("支付二维码");
  });

  it("returns fallback copy for undefined providerCode", () => {
    const copy = getPaymentProviderCopy(undefined);
    expect(copy.title).toBe("扫码支付");
    expect(copy.qrAlt).toBe("支付二维码");
  });
});
