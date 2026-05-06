import { Injectable, NotFoundException } from "@nestjs/common";

import type { PaymentProvider } from "./payment-provider.interface";

import { AlipayProvider } from "./alipay.provider";
import { MockPaymentProvider } from "./mock-payment.provider";
import { WeChatPayProvider } from "./wechat-pay.provider";

@Injectable()
export class PaymentProviderRegistry {
  private readonly providers: Map<string, PaymentProvider>;

  constructor(
    mockPaymentProvider: MockPaymentProvider,
    weChatPayProvider: WeChatPayProvider,
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

  has(code: string): boolean {
    return this.providers.has(code);
  }
}
