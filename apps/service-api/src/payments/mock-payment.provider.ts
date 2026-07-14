import { Inject, Injectable } from "@nestjs/common";
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
  ProviderPaymentCodeChargeInput,
  ProviderPaymentCodeChargeResult,
  ProviderPaymentCodeQueryInput,
  ProviderPaymentCodeQueryResult,
  ProviderPaymentCodeReverseInput,
  ProviderPaymentCodeReverseResult,
} from "./payment-provider.interface";

import { AppConfigService } from "../config/app-config.service";

@Injectable()
export class MockPaymentProvider implements PaymentProvider {
  readonly code = "mock";
  readonly supportsPartialRefund = true;

  constructor(
    @Inject(AppConfigService) private readonly config: AppConfigService,
  ) {}

  async createPaymentIntent(
    input: PaymentIntentInput,
  ): Promise<PaymentIntentResult> {
    return {
      providerTradeNo: `MOCK-${input.paymentNo}`,
      paymentUrl: `${this.config.paymentWebhookBaseUrl.replace(/\/payments\/webhooks$/, "")}/payments/mock/${input.paymentNo}`,
    };
  }

  async chargePaymentCode(
    input: ProviderPaymentCodeChargeInput,
  ): Promise<ProviderPaymentCodeChargeResult> {
    if (!this.config.paymentMockEnabled)
      throw new Error("mock payment code is disabled");
    return {
      status: "succeeded",
      providerTradeNo: `MOCK-CODE-${input.paymentNo}`,
      paidAt: new Date(),
      providerStatus: "TESTBED_SCANNER_ACCEPTED",
      rawPayload: {
        provider: "mock",
        source: "payment_code",
        authCodeLength: input.authCode.length,
      },
    };
  }

  async queryPaymentCode(
    input: ProviderPaymentCodeQueryInput,
  ): Promise<ProviderPaymentCodeQueryResult> {
    return {
      status: "succeeded",
      providerTradeNo: input.providerTradeNo,
      paidAt: new Date(),
      providerStatus: "TESTBED_SCANNER_ACCEPTED",
      rawPayload: { provider: "mock", source: "payment_code" },
    };
  }

  async reversePaymentCode(
    _input: ProviderPaymentCodeReverseInput,
  ): Promise<ProviderPaymentCodeReverseResult> {
    return {
      status: "reversed",
      recall: true,
      providerStatus: "TESTBED_REVERSED",
      rawPayload: { provider: "mock", source: "payment_code" },
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
