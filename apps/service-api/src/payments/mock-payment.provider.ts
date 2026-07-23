import { Inject, Injectable } from "@nestjs/common";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
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
import { PaymentProviderRequestNotSentError } from "./payment-provider.interface";

const DEFAULT_MOCK_CREATE_GATE_TIMEOUT_MS = 30_000;

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
    await this.waitForCreateGate(input.paymentNo);
    return {
      providerTradeNo: `MOCK-${input.paymentNo}`,
      paymentUrl: this.config.buildMockPaymentCompletionUrl(input.paymentNo),
    };
  }

  private async waitForCreateGate(paymentNo: string): Promise<void> {
    const gatePath = this.config.paymentMockProviderCreateGatePath;
    if (!gatePath) return;
    const state = await this.readCreateGateState(gatePath);
    if (state.state !== "hold") return;

    const pendingPath = `${gatePath}.pending.json`;
    await mkdir(dirname(gatePath), { recursive: true });
    await writeFile(
      pendingPath,
      `${JSON.stringify({
        paymentNo,
        state: "pending",
        observedAt: new Date().toISOString(),
      })}\n`,
      "utf8",
    );

    // This gate fails before the provider request is sent, so it must settle
    // before the OrdersService provider deadline can classify the outcome as
    // indeterminate.
    const deadline =
      Date.now() + (state.timeoutMs ?? DEFAULT_MOCK_CREATE_GATE_TIMEOUT_MS);
    try {
      while (Date.now() < deadline) {
        // oxlint-disable-next-line no-await-in-loop -- bounded gate polling is intentionally sequential
        const current = await this.readCreateGateState(gatePath);
        if (
          current.state === "release" &&
          (current.paymentNo === undefined || current.paymentNo === paymentNo)
        ) {
          return;
        }
        // oxlint-disable-next-line no-await-in-loop -- delay belongs to the sequential polling loop
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } finally {
      await rm(pendingPath, { force: true }).catch(() => undefined);
    }
    throw new PaymentProviderRequestNotSentError(
      `mock payment create gate timed out before release for ${paymentNo}`,
    );
  }

  private async readCreateGateState(gatePath: string): Promise<{
    state: "open" | "hold" | "release";
    paymentNo?: string;
    timeoutMs?: number;
  }> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(gatePath, "utf8"));
    } catch (error) {
      throw new Error(
        `mock payment create gate is unreadable at ${gatePath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const schema = z.strictObject({
      state: z.enum(["open", "hold", "release"]),
      paymentNo: z.string().min(1).optional(),
      timeoutMs: z.number().int().min(100).max(30_000).optional(),
    });
    const result = schema.safeParse(parsed);
    if (!result.success) {
      throw new Error(`mock payment create gate is invalid at ${gatePath}`);
    }
    return result.data;
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
    input: ProviderPaymentQueryInput,
  ): Promise<ProviderPaymentQueryResult> {
    await this.throwIfQueryFaultIsArmed(input.paymentNo);
    return { status: "pending", rawPayload: { provider: "mock" } };
  }

  private async throwIfQueryFaultIsArmed(paymentNo: string): Promise<void> {
    const faultPath = this.config.paymentMockProviderQueryFaultPath;
    if (!faultPath) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(faultPath, "utf8"));
    } catch (error) {
      throw new Error(
        `mock payment query fault is unreadable at ${faultPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const state = z
      .strictObject({
        state: z.enum(["open", "fail"]),
        paymentNo: z.string().min(1).optional(),
      })
      .safeParse(parsed);
    if (!state.success) {
      throw new Error(`mock payment query fault is invalid at ${faultPath}`);
    }
    if (
      state.data.state === "fail" &&
      (state.data.paymentNo === undefined || state.data.paymentNo === paymentNo)
    ) {
      throw new Error(`mock payment query fault injected for ${paymentNo}`);
    }
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
