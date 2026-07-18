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
import {
  MockPaymentCodeTradeStore,
  type MockPaymentCodeTrade,
} from "./mock-payment-code-trade.store";

@Injectable()
export class MockPaymentProvider implements PaymentProvider {
  readonly code = "mock";
  readonly supportsPartialRefund = true;

  constructor(
    @Inject(AppConfigService) private readonly config: AppConfigService,
    private readonly paymentCodeTrades: MockPaymentCodeTradeStore,
  ) {}

  async createPaymentIntent(
    input: PaymentIntentInput,
  ): Promise<PaymentIntentResult> {
    if (!this.config.paymentMockEnabled) {
      throw new Error("mock payment provider is disabled");
    }
    return {
      providerTradeNo: `MOCK-${input.paymentNo}`,
      paymentUrl: this.config.buildMockPaymentCompletionUrl(input.paymentNo),
    };
  }

  async chargePaymentCode(
    input: ProviderPaymentCodeChargeInput,
  ): Promise<ProviderPaymentCodeChargeResult> {
    if (!this.config.paymentMockEnabled)
      throw new Error("mock payment code is disabled");
    const trade = await this.paymentCodeTrades.acceptCharge({
      providerPaymentNo: input.paymentNo,
      idempotencyKey: input.idempotencyKey ?? input.paymentNo,
      providerTradeNo: `MOCK-CODE-${input.paymentNo}`,
      amountCents: input.amountCents,
      authCodeLength: input.authCode.length,
    });
    await this.delayResponse();
    return this.paymentCodeResult(input.paymentNo, trade, trade.authCodeLength);
  }

  private paymentCodeResult(
    paymentNo: string,
    trade: MockPaymentCodeTrade,
    authCodeLength?: number,
  ): ProviderPaymentCodeChargeResult {
    if (trade.status === "reversed") {
      return {
        status: "reversed",
        providerTradeNo: trade.providerTradeNo,
        providerStatus: "TESTBED_SCANNER_REVERSED",
        rawPayload: { provider: "mock", source: "payment_code", paymentNo },
      };
    }
    return {
      status: "succeeded",
      providerTradeNo: trade.providerTradeNo,
      paidAt: trade.paidAt,
      providerStatus: "TESTBED_SCANNER_ACCEPTED",
      rawPayload: {
        provider: "mock",
        source: "payment_code",
        paymentNo,
        ...(authCodeLength === undefined ? {} : { authCodeLength }),
      },
    };
  }

  async queryPaymentCode(
    input: ProviderPaymentCodeQueryInput,
  ): Promise<ProviderPaymentCodeQueryResult> {
    const trade = await this.paymentCodeTrades.find(input.paymentNo);
    if (
      !trade ||
      (input.providerTradeNo !== null &&
        trade.providerTradeNo !== input.providerTradeNo)
    ) {
      return {
        status: "unknown",
        providerTradeNo: input.providerTradeNo,
        providerStatus: "TESTBED_SCANNER_TRADE_NOT_FOUND",
        rawPayload: {
          provider: "mock",
          source: "payment_code",
          paymentNo: input.paymentNo,
        },
      };
    }
    return this.paymentCodeResult(input.paymentNo, trade);
  }

  async reversePaymentCode(
    input: ProviderPaymentCodeReverseInput,
  ): Promise<ProviderPaymentCodeReverseResult> {
    if (!input.providerTradeNo) {
      return this.unknownReversal(input.paymentNo, "missing_provider_trade_no");
    }
    const trade = await this.paymentCodeTrades.acceptReversal({
      providerPaymentNo: input.paymentNo,
      providerTradeNo: input.providerTradeNo,
      idempotencyKey: input.idempotencyKey ?? input.paymentNo,
    });
    if (!trade) {
      return this.unknownReversal(input.paymentNo, "trade_not_found");
    }
    await this.delayResponse();
    return {
      status: "reversed",
      recall: true,
      providerStatus: "TESTBED_REVERSED",
      rawPayload: {
        provider: "mock",
        source: "payment_code",
        paymentNo: input.paymentNo,
      },
    };
  }

  private unknownReversal(
    paymentNo: string,
    reason: string,
  ): ProviderPaymentCodeReverseResult {
    return {
      status: "unknown",
      recall: false,
      providerStatus: "TESTBED_REVERSE_UNKNOWN",
      failureCode: "TESTBED_REVERSE_UNKNOWN",
      rawPayload: {
        provider: "mock",
        source: "payment_code",
        paymentNo,
        reason,
      },
    };
  }

  private async delayResponse(): Promise<void> {
    const delayMs = this.config.paymentMockProviderResponseDelayMs ?? 0;
    if (delayMs <= 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
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
    if (!this.config.paymentMockEnabled) {
      throw new Error("mock payment provider is disabled");
    }
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
