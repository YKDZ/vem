import { Injectable, NotFoundException } from "@nestjs/common";

import type { PaymentProvider } from "./payment-provider.interface";

import { MockPaymentProvider } from "./mock-payment.provider";

@Injectable()
export class PaymentProviderRegistry {
  private readonly providers: Map<string, PaymentProvider>;

  constructor(mockPaymentProvider: MockPaymentProvider) {
    this.providers = new Map([[mockPaymentProvider.code, mockPaymentProvider]]);
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
