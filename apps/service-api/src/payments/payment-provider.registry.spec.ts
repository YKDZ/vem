import { ConflictException, NotFoundException } from "@nestjs/common";
import { describe, expect, it } from "vitest";

import type {
  PaymentCodeCapableProvider,
  PaymentProvider,
} from "./payment-provider.interface";

import { PaymentProviderRegistry } from "./payment-provider.registry";

function makeProvider(code: string): PaymentProvider {
  return {
    code,
    createPaymentIntent: async () => ({
      providerTradeNo: "",
      paymentUrl: "",
    }),
    queryPayment: async () => ({ status: "pending" }),
    cancelPayment: async () => ({ status: "canceled" }),
    refundPayment: async () => ({
      providerRefundNo: "",
      status: "processing",
      refundedAt: null,
    }),
  };
}

function makePaymentCodeProvider(code: string): PaymentCodeCapableProvider {
  return {
    ...makeProvider(code),
    chargePaymentCode: async () => ({
      status: "user_confirming",
      providerTradeNo: null,
    }),
    queryPaymentCode: async () => ({
      status: "processing",
      providerTradeNo: null,
    }),
    reversePaymentCode: async () => ({
      status: "processing",
    }),
  };
}

describe("PaymentProviderRegistry", () => {
  it("has wechat_pay and alipay providers", () => {
    const wechat = makeProvider("wechat_pay");
    const alipay = makeProvider("alipay");
    const mock = makeProvider("mock");
    const registry = new PaymentProviderRegistry(
      mock as never,
      wechat as never,
      alipay as never,
    );

    expect(registry.has("wechat_pay")).toBe(true);
    expect(registry.has("alipay")).toBe(true);
    expect(registry.has("mock")).toBe(true);
  });

  it("throws NotFoundException for unknown provider", () => {
    const mock = makeProvider("mock");
    const wechat = makeProvider("wechat_pay");
    const alipay = makeProvider("alipay");
    const registry = new PaymentProviderRegistry(
      mock as never,
      wechat as never,
      alipay as never,
    );

    expect(() => registry.get("unknown")).toThrow(NotFoundException);
    expect(() => registry.get("unknown")).toThrow(
      "Payment provider unknown not found",
    );
  });

  it("returns the correct provider", () => {
    const mock = makeProvider("mock");
    const wechat = makeProvider("wechat_pay");
    const alipay = makeProvider("alipay");
    const registry = new PaymentProviderRegistry(
      mock as never,
      wechat as never,
      alipay as never,
    );

    expect(registry.get("mock")).toBe(mock);
    expect(registry.get("wechat_pay")).toBe(wechat);
    expect(registry.get("alipay")).toBe(alipay);
  });

  it("returns payment_code capable provider when supported", () => {
    const mock = makeProvider("mock");
    const wechat = makePaymentCodeProvider("wechat_pay");
    const alipay = makePaymentCodeProvider("alipay");
    const registry = new PaymentProviderRegistry(
      mock as never,
      wechat as never,
      alipay as never,
    );

    expect(registry.getPaymentCodeProvider("wechat_pay")).toBe(wechat);
    expect(registry.getPaymentCodeProvider("alipay")).toBe(alipay);
  });

  it("throws ConflictException when provider does not support payment_code", () => {
    const mock = makeProvider("mock");
    const wechat = makeProvider("wechat_pay");
    const alipay = makeProvider("alipay");
    const registry = new PaymentProviderRegistry(
      mock as never,
      wechat as never,
      alipay as never,
    );

    expect(() => registry.getPaymentCodeProvider("wechat_pay")).toThrow(
      ConflictException,
    );
    expect(() => registry.getPaymentCodeProvider("wechat_pay")).toThrow(
      "Payment provider wechat_pay does not support payment_code",
    );
  });
});
