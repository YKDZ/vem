import { Injectable } from "@nestjs/common";
import { z } from "zod";

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
  ProviderRefundQueryInput,
  ProviderRefundQueryResult,
  ProviderWebhookInput,
  ProviderWebhookResult,
} from "./payment-provider.interface";

import { AppConfigService } from "../config/app-config.service";

@Injectable()
export class MockPaymentProvider implements PaymentProvider {
  readonly code = "mock";
  readonly supportsPartialRefund = true;

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
    const schema = z.object({
      providerEventId: z.string().optional(),
      eventType: z.string().optional(),
      paymentNo: z.string().optional(),
      providerTradeNo: z.string().optional(),
      paymentStatus: z.enum(["succeeded", "failed"]).optional(),
    });
    const parsed = schema.safeParse(input.body);
    const body = parsed.success ? parsed.data : {};
    return {
      eventKind: "payment",
      providerEventId: body.providerEventId ?? `mock:webhook:${Date.now()}`,
      eventType: body.eventType ?? "mock.webhook",
      paymentNo: body.paymentNo ?? null,
      providerTradeNo: body.providerTradeNo ?? null,
      paymentStatus: body.paymentStatus ?? null,
      signatureValid: true,
      rawPayload: body,
    };
  }

  async queryRefund(
    input: ProviderRefundQueryInput,
  ): Promise<ProviderRefundQueryResult> {
    return {
      providerRefundNo: input.providerRefundNo ?? `MOCK-${input.refundNo}`,
      status: "succeeded",
      refundedAt: new Date(),
      rawPayload: { provider: "mock" },
    };
  }
}
