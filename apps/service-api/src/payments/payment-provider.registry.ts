import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";

import type {
  PaymentCodeCapableProvider,
  PaymentProvider,
} from "./payment-provider.interface";

import { AlipayProvider } from "./alipay.provider";
import { MockPaymentProvider } from "./mock-payment.provider";
import { WeChatPayProvider } from "./wechat-pay.provider";

function isPaymentCodeCapableProvider(
  provider: PaymentProvider,
): provider is PaymentCodeCapableProvider {
  return (
    "chargePaymentCode" in provider &&
    typeof provider.chargePaymentCode === "function" &&
    "queryPaymentCode" in provider &&
    typeof provider.queryPaymentCode === "function" &&
    "reversePaymentCode" in provider &&
    typeof provider.reversePaymentCode === "function"
  );
}

@Injectable()
export class PaymentProviderRegistry {
  private readonly providers: Map<string, PaymentProvider>;

  constructor(
    @Inject(MockPaymentProvider)
    mockPaymentProvider: MockPaymentProvider,
    @Inject(WeChatPayProvider)
    weChatPayProvider: WeChatPayProvider,
    @Inject(AlipayProvider)
    alipayProvider: AlipayProvider,
  ) {
    this.providers = new Map(
      [mockPaymentProvider, weChatPayProvider, alipayProvider].map(
        (provider) => [provider.code, provider],
      ),
    );
  }

  get(code: string): PaymentProvider {
    const provider = this.providers.get(code);
    if (!provider) {
      throw new NotFoundException(`Payment provider ${code} not found`);
    }
    return provider;
  }

  getPaymentCodeProvider(code: string): PaymentCodeCapableProvider {
    const provider = this.get(code);
    if (!isPaymentCodeCapableProvider(provider)) {
      throw new ConflictException(
        `Payment provider ${code} does not support payment_code`,
      );
    }
    return provider;
  }

  has(code: string): boolean {
    return this.providers.has(code);
  }
}
