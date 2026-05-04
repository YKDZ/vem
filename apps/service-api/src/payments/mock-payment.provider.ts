import { Injectable } from "@nestjs/common";

import type {
  PaymentIntentInput,
  PaymentIntentResult,
  PaymentProvider,
} from "./payment-provider.interface";

import { AppConfigService } from "../config/app-config.service";

@Injectable()
export class MockPaymentProvider implements PaymentProvider {
  readonly code = "mock";

  constructor(private readonly config: AppConfigService) {}

  async createPaymentIntent(
    input: PaymentIntentInput,
  ): Promise<PaymentIntentResult> {
    return {
      providerTradeNo: `MOCK-${input.paymentNo}`,
      paymentUrl: `${this.config.paymentWebhookBaseUrl.replace(/\/payments\/webhooks$/, "")}/payments/mock/${input.paymentNo}`,
    };
  }
}
