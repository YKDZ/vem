import { Injectable } from "@nestjs/common";

import type {
  PaymentIntentInput,
  PaymentIntentResult,
  PaymentProvider,
  ProviderCancelPaymentInput,
  ProviderCancelPaymentResult,
  ProviderPaymentQueryInput,
  ProviderPaymentQueryResult,
  ProviderRefundPaymentInput,
  ProviderRefundPaymentResult,
  ProviderWebhookInput,
  ProviderWebhookResult,
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

  async queryPayment(
    _input: ProviderPaymentQueryInput,
  ): Promise<ProviderPaymentQueryResult> {
    return { status: "pending", rawPayload: { provider: "mock" } };
  }

  async cancelPayment(
    _input: ProviderCancelPaymentInput,
  ): Promise<ProviderCancelPaymentResult> {
    return { status: "canceled", rawPayload: { provider: "mock" } };
  }

  async refundPayment(
    input: ProviderRefundPaymentInput,
  ): Promise<ProviderRefundPaymentResult> {
    return {
      providerRefundNo: `MOCK-${input.refundNo}`,
      status: "succeeded",
      refundedAt: new Date(),
      rawPayload: {
        provider: "mock",
        paymentNo: input.paymentNo,
        amountCents: input.amountCents,
        reason: input.reason,
      },
    };
  }

  async handleWebhook(
    input: ProviderWebhookInput,
  ): Promise<ProviderWebhookResult> {
    const body =
      typeof input.body === "object" && input.body !== null ? input.body : {};
    const payload = body as Record<string, unknown>;
    return {
      providerEventId: String(
        payload.providerEventId ?? `mock:webhook:${Date.now()}`,
      ),
      eventType: String(payload.eventType ?? "mock.webhook"),
      paymentNo:
        typeof payload.paymentNo === "string" ? payload.paymentNo : null,
      providerTradeNo:
        typeof payload.providerTradeNo === "string"
          ? payload.providerTradeNo
          : null,
      paymentStatus:
        payload.paymentStatus === "succeeded" ||
        payload.paymentStatus === "failed"
          ? payload.paymentStatus
          : null,
      signatureValid: true,
      rawPayload: payload,
    };
  }
}
