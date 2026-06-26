import type {
  PaymentCodeSubmitInput,
  PaymentCodeSubmitResponse,
} from "@vem/shared";

import { Injectable, Logger } from "@nestjs/common";

import type {
  PaymentCodeCapableProvider,
  PaymentProviderRuntimeConfig,
} from "./payment-provider.interface";

import {
  PaymentCodeAttemptsService,
  type PaymentCodeAttemptRow,
} from "./payment-code-attempts.service";
import { PaymentProviderConfigService } from "./payment-provider-config.service";
import { PaymentProviderRegistry } from "./payment-provider.registry";
import { buildStoredEventPayload } from "./payment-redaction.util";
import { PaymentsService } from "./payments.service";

@Injectable()
export class PaymentCodeOrchestratorService {
  private readonly logger = new Logger(PaymentCodeOrchestratorService.name);
  private static readonly terminalStatuses = [
    "succeeded",
    "failed",
    "reversed",
    "canceled",
  ] as const;
  private static readonly mutableStatuses = [
    "created",
    "submitting",
    "user_confirming",
    "querying",
    "reversing",
    "unknown",
    "manual_handling",
  ] as const;
  private static readonly reversibleStatuses = [
    "user_confirming",
    "querying",
    "reversing",
    "unknown",
    "manual_handling",
  ] as const;

  constructor(
    private readonly attempts: PaymentCodeAttemptsService,
    private readonly registry: PaymentProviderRegistry,
    private readonly configService: PaymentProviderConfigService,
    private readonly paymentsService: PaymentsService,
  ) {}

  async submit(
    input: PaymentCodeSubmitInput & {
      orderNo: string;
      clientIp: string | null;
    },
  ): Promise<PaymentCodeSubmitResponse> {
    const { payment, attempt, replayed } = await this.attempts.createOrReplay({
      orderNo: input.orderNo,
      machineCode: input.machineCode,
      authCode: input.authCode,
      idempotencyKey: input.idempotencyKey,
      source: input.source,
      scannerHealthJson: input.scannerHealth ?? null,
    });

    if (replayed) {
      return this.toSubmitResponse(input.orderNo, payment.paymentNo, attempt);
    }

    const provider = this.registry.getPaymentCodeProvider(payment.providerCode);
    const config = await this.configService.resolveForPayment({
      providerCode: payment.providerCode,
      machineId: payment.machineId,
    });

    await this.attempts.markStatus(attempt.id, "submitting", {
      submittedAt: new Date(),
    });

    let charge: Awaited<ReturnType<typeof provider.chargePaymentCode>>;
    try {
      charge = await provider.chargePaymentCode({
        paymentNo: attempt.providerPaymentNo,
        orderNo: input.orderNo,
        amountCents: payment.amountCents,
        authCode: input.authCode,
        terminalId: this.readString(config.publicConfigJson, "terminalId"),
        storeId: this.readString(config.publicConfigJson, "storeId"),
        clientIp: input.clientIp,
        config,
      });
    } catch (error) {
      await this.attempts.markStatus(attempt.id, "failed", {
        failureCode: "PROVIDER_EXCEPTION",
        failureMessage: error instanceof Error ? error.message : String(error),
        finishedAt: new Date(),
      });
      throw error;
    }

    if (charge.status === "succeeded") {
      await this.attempts.markStatus(attempt.id, "succeeded", {
        providerTradeNo: charge.providerTradeNo,
        providerStatus: charge.providerStatus ?? "succeeded",
        failureCode: null,
        failureMessage: null,
        manualReason: null,
        rawPayloadJson: buildStoredEventPayload(charge.rawPayload ?? {}),
        finishedAt: new Date(),
      });
      await this.paymentsService.applyProviderPaymentResult({
        paymentId: payment.id,
        providerTradeNo: charge.providerTradeNo,
        status: "succeeded",
        paidAt: charge.paidAt ?? new Date(),
        eventType: "payment_code.succeeded",
        providerEventId: `payment_code:${attempt.providerPaymentNo}:succeeded`,
        rawPayload: charge.rawPayload ?? {},
      });
      return {
        orderNo: input.orderNo,
        paymentNo: payment.paymentNo,
        attemptNo: attempt.attemptNo,
        status: "succeeded",
        nextAction: "dispensing",
        message: "支付成功，正在出货",
        canRetry: false,
        serverTime: new Date().toISOString(),
      };
    }

    if (
      charge.status === "user_confirming" ||
      charge.status === "processing" ||
      charge.status === "unknown"
    ) {
      const status =
        charge.status === "user_confirming" ? "user_confirming" : "querying";
      await this.attempts.markStatus(attempt.id, status, {
        providerTradeNo: charge.providerTradeNo,
        providerStatus: charge.providerStatus ?? charge.status,
        failureCode: charge.failureCode ?? null,
        failureMessage: charge.failureMessage ?? null,
        rawPayloadJson: buildStoredEventPayload(charge.rawPayload ?? {}),
        lastCheckedAt: new Date(),
      });
      void this.confirmLater(attempt.id, payment.providerCode, config).catch(
        (error: unknown) => {
          this.logger.warn(
            `payment_code confirm failed for attempt ${attempt.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        },
      );
      return {
        orderNo: input.orderNo,
        paymentNo: payment.paymentNo,
        attemptNo: attempt.attemptNo,
        status,
        nextAction: "wait_payment",
        message:
          status === "user_confirming"
            ? "请在手机上确认支付"
            : "正在确认支付结果",
        canRetry: false,
        serverTime: new Date().toISOString(),
      };
    }

    await this.attempts.markStatus(attempt.id, "failed", {
      failureCode: charge.failureCode ?? "PAYMENT_CODE_FAILED",
      failureMessage: charge.failureMessage ?? "付款码支付失败",
      rawPayloadJson: buildStoredEventPayload(charge.rawPayload ?? {}),
      finishedAt: new Date(),
    });
    return {
      orderNo: input.orderNo,
      paymentNo: payment.paymentNo,
      attemptNo: attempt.attemptNo,
      status: "failed",
      nextAction: "wait_payment",
      message: "付款码无效或支付失败，请刷新付款码后重试",
      canRetry: true,
      serverTime: new Date().toISOString(),
    };
  }

  private async confirmLater(
    attemptId: string,
    providerCode: string,
    config: PaymentProviderRuntimeConfig,
  ): Promise<void> {
    await this.confirmAttempt(attemptId, providerCode, config);
  }

  private async confirmAttempt(
    attemptId: string,
    providerCode: string,
    config: PaymentProviderRuntimeConfig,
  ): Promise<void> {
    const provider = this.registry.getPaymentCodeProvider(providerCode);
    const pollIntervalMs =
      this.readNumber(
        config.publicConfigJson,
        "paymentCodePollIntervalSeconds",
        providerCode === "wechat_pay" ? 5 : 3,
      ) * 1000;
    const maxConfirmMs =
      this.readNumber(
        config.publicConfigJson,
        "paymentCodeMaxConfirmSeconds",
        providerCode === "wechat_pay" ? 45 : 30,
      ) * 1000;
    const deadline = Date.now() + maxConfirmMs;
    const lastAttempt = await this.attempts.getById(attemptId);

    await this.pollAttemptUntilSettled(
      provider,
      attemptId,
      config,
      deadline,
      pollIntervalMs,
      lastAttempt,
    );
  }

  private async pollAttemptUntilSettled(
    provider: PaymentCodeCapableProvider,
    attemptId: string,
    config: PaymentProviderRuntimeConfig,
    deadline: number,
    pollIntervalMs: number,
    lastAttempt: PaymentCodeAttemptRow,
  ): Promise<void> {
    if (this.isTerminalAttempt(lastAttempt)) return;
    if (Date.now() > deadline) {
      await this.reverseUnknownAttempt(attemptId, provider.code, config);
      return;
    }

    await this.wait(pollIntervalMs);
    let query: Awaited<ReturnType<typeof provider.queryPaymentCode>>;
    try {
      query = await provider.queryPaymentCode({
        paymentNo: lastAttempt.providerPaymentNo,
        providerTradeNo: lastAttempt.providerTradeNo,
        config,
      });
    } catch (error) {
      const message = this.errorMessage(error);
      const nextAttempt = await this.markMutableStatus(attemptId, "querying", {
        providerTradeNo: lastAttempt.providerTradeNo,
        providerStatus: "PAYMENT_CODE_QUERY_UNKNOWN",
        failureCode: "PAYMENT_CODE_QUERY_UNKNOWN",
        failureMessage: message,
        rawPayloadJson: buildStoredEventPayload({ error: message }),
        lastCheckedAt: new Date(),
      });
      await this.pollAttemptUntilSettled(
        provider,
        attemptId,
        config,
        deadline,
        pollIntervalMs,
        nextAttempt,
      );
      return;
    }
    const { attempt: nextAttempt, changed } = await this.tryMarkMutableStatus(
      attemptId,
      query.status === "succeeded"
        ? "succeeded"
        : query.status === "user_confirming"
          ? "user_confirming"
          : "querying",
      {
        providerTradeNo: query.providerTradeNo ?? lastAttempt.providerTradeNo,
        providerStatus: query.providerStatus ?? query.status,
        failureCode: query.failureCode ?? null,
        failureMessage: query.failureMessage ?? null,
        rawPayloadJson: buildStoredEventPayload(query.rawPayload ?? {}),
        lastCheckedAt: new Date(),
        finishedAt: query.status === "succeeded" ? new Date() : undefined,
      },
    );
    if (query.status === "succeeded") {
      if (!changed) return;
      await this.paymentsService.applyProviderPaymentResult({
        paymentId: nextAttempt.paymentId,
        providerTradeNo: query.providerTradeNo ?? nextAttempt.providerTradeNo,
        status: "succeeded",
        paidAt: query.paidAt ?? new Date(),
        eventType: "payment_code.query_succeeded",
        providerEventId: `payment_code:${nextAttempt.providerPaymentNo}:query_succeeded`,
        rawPayload: query.rawPayload ?? {},
      });
      return;
    }
    if (query.status === "failed" || query.status === "reversed") {
      await this.markMutableStatus(
        attemptId,
        query.status === "reversed" ? "reversed" : "failed",
        {
          isActive: false,
          finishedAt: new Date(),
        },
      );
      return;
    }

    await this.pollAttemptUntilSettled(
      provider,
      attemptId,
      config,
      deadline,
      pollIntervalMs,
      nextAttempt,
    );
  }

  async reverseUnknownAttempt(
    attemptId: string,
    providerCode: string,
    config: PaymentProviderRuntimeConfig,
  ): Promise<void> {
    const provider = this.registry.getPaymentCodeProvider(providerCode);
    const { attempt, changed } = await this.tryMarkReversibleStatus(
      attemptId,
      "reversing",
    );
    if (!changed) return;

    await this.reverseAttemptWithRetry(
      provider,
      attemptId,
      config,
      attempt,
      this.reverseMaxAttempts(config),
    );
  }

  private async reverseAttemptWithRetry(
    provider: PaymentCodeCapableProvider,
    attemptId: string,
    config: PaymentProviderRuntimeConfig,
    attempt: PaymentCodeAttemptRow,
    remainingAttempts: number,
  ): Promise<void> {
    if (this.isTerminalAttempt(attempt)) return;
    if (remainingAttempts <= 0) {
      await this.markReversibleStatus(attemptId, "manual_handling", {
        isActive: true,
        manualReason: "reverse_result_unknown_after_retries",
        failureCode: attempt.failureCode ?? "PAYMENT_CODE_REVERSE_UNKNOWN",
        failureMessage:
          attempt.failureMessage ?? "付款码撤销结果未知，需要人工确认",
        finishedAt: new Date(),
      });
      return;
    }

    let reversed: Awaited<ReturnType<typeof provider.reversePaymentCode>>;
    try {
      reversed = await provider.reversePaymentCode({
        paymentNo: attempt.providerPaymentNo,
        providerTradeNo: attempt.providerTradeNo,
        config,
      });
    } catch (error) {
      const message = this.errorMessage(error);
      const nextAttempt = await this.markReversibleStatus(
        attemptId,
        "reversing",
        {
          providerStatus: "PAYMENT_CODE_REVERSE_UNKNOWN",
          failureCode: "PAYMENT_CODE_REVERSE_UNKNOWN",
          failureMessage: message,
          rawPayloadJson: buildStoredEventPayload({ error: message }),
          isActive: true,
        },
      );
      this.logger.warn(
        `payment_code reverse unknown for attempt ${attemptId}: ${message}`,
      );
      await this.wait(this.reverseRetryDelayMs(config));
      await this.reverseAttemptWithRetry(
        provider,
        attemptId,
        config,
        nextAttempt,
        remainingAttempts - 1,
      );
      return;
    }
    const nextAttempt = await this.markReversibleStatus(
      attemptId,
      reversed.status === "reversed" ? "reversed" : "reversing",
      {
        providerStatus: reversed.providerStatus ?? reversed.status,
        failureCode: reversed.failureCode ?? null,
        failureMessage:
          reversed.failureMessage ??
          (reversed.status === "reversed"
            ? "本次付款码交易已撤销，请刷新付款码后重试"
            : null),
        rawPayloadJson: buildStoredEventPayload(reversed.rawPayload ?? {}),
        reversedAt: reversed.status === "reversed" ? new Date() : null,
        finishedAt: reversed.status === "reversed" ? new Date() : null,
        isActive: reversed.status === "reversed" ? false : true,
      },
    );
    if (reversed.status === "reversed" && !reversed.recall) {
      return;
    }

    await this.wait(this.reverseRetryDelayMs(config));
    await this.reverseAttemptWithRetry(
      provider,
      attemptId,
      config,
      nextAttempt,
      remainingAttempts - 1,
    );
  }

  async manualQuery(id: string): Promise<PaymentCodeAttemptRow> {
    const ctx = await this.attempts.getContextById(id);
    if (this.isTerminalAttempt(ctx.attempt)) {
      return ctx.attempt;
    }
    const provider = this.registry.getPaymentCodeProvider(ctx.providerCode);
    const config = await this.configService.resolveForExistingPayment({
      providerCode: ctx.providerCode,
      providerConfigId: ctx.providerConfigId,
      machineId: ctx.machineId,
    });
    const result = await provider.queryPaymentCode({
      paymentNo: ctx.attempt.providerPaymentNo,
      providerTradeNo: ctx.attempt.providerTradeNo,
      config,
    });
    if (result.status === "succeeded") {
      const { attempt: updated, changed } = await this.tryMarkMutableStatus(
        id,
        "succeeded",
        {
          providerTradeNo:
            result.providerTradeNo ?? ctx.attempt.providerTradeNo,
          providerStatus: result.providerStatus ?? "succeeded",
          failureCode: null,
          failureMessage: null,
          manualReason: null,
          rawPayloadJson: buildStoredEventPayload(result.rawPayload ?? {}),
          lastCheckedAt: new Date(),
          finishedAt: new Date(),
        },
      );
      if (!changed) return updated;
      await this.paymentsService.applyProviderPaymentResult({
        paymentId: ctx.attempt.paymentId,
        providerTradeNo: result.providerTradeNo ?? ctx.attempt.providerTradeNo,
        status: "succeeded",
        paidAt: result.paidAt ?? new Date(),
        eventType: "payment_code.manual_query_succeeded",
        providerEventId: `payment_code:${ctx.attempt.providerPaymentNo}:manual_query_succeeded`,
        rawPayload: result.rawPayload ?? {},
      });
      return updated;
    }
    if (result.status === "reversed") {
      return await this.markMutableStatus(id, "reversed", {
        providerTradeNo: result.providerTradeNo ?? ctx.attempt.providerTradeNo,
        providerStatus: result.providerStatus ?? result.status,
        failureCode: result.failureCode ?? null,
        failureMessage: result.failureMessage ?? null,
        rawPayloadJson: buildStoredEventPayload(result.rawPayload ?? {}),
        lastCheckedAt: new Date(),
        reversedAt: new Date(),
        finishedAt: new Date(),
        isActive: false,
      });
    }
    return await this.markMutableStatus(
      id,
      result.status === "failed"
        ? "failed"
        : result.status === "user_confirming"
          ? "user_confirming"
          : "querying",
      {
        providerTradeNo: result.providerTradeNo ?? ctx.attempt.providerTradeNo,
        providerStatus: result.providerStatus ?? result.status,
        failureCode: result.failureCode ?? null,
        failureMessage: result.failureMessage ?? null,
        rawPayloadJson: buildStoredEventPayload(result.rawPayload ?? {}),
        lastCheckedAt: new Date(),
        isActive: result.status === "failed" ? false : true,
      },
    );
  }

  async manualReverse(
    id: string,
    reason: string,
  ): Promise<PaymentCodeAttemptRow> {
    const ctx = await this.attempts.getContextById(id);
    if (this.isTerminalAttempt(ctx.attempt)) {
      return ctx.attempt;
    }
    const { attempt, changed } = await this.tryMarkReversibleStatus(
      id,
      "reversing",
      { manualReason: reason },
    );
    if (!changed) return attempt;
    const provider = this.registry.getPaymentCodeProvider(ctx.providerCode);
    const config = await this.configService.resolveForExistingPayment({
      providerCode: ctx.providerCode,
      providerConfigId: ctx.providerConfigId,
      machineId: ctx.machineId,
    });
    const result = await provider.reversePaymentCode({
      paymentNo: attempt.providerPaymentNo,
      providerTradeNo: attempt.providerTradeNo,
      config,
    });
    return await this.markReversibleStatus(
      id,
      result.status === "reversed" ? "reversed" : "manual_handling",
      {
        providerStatus: result.providerStatus ?? result.status,
        failureCode: result.failureCode ?? null,
        failureMessage: result.failureMessage ?? null,
        rawPayloadJson: buildStoredEventPayload(result.rawPayload ?? {}),
        reversedAt: result.status === "reversed" ? new Date() : null,
        finishedAt: result.status === "reversed" ? new Date() : null,
        manualReason: reason,
        isActive: result.status === "reversed" ? false : true,
      },
    );
  }

  private toSubmitResponse(
    orderNo: string,
    paymentNo: string,
    attempt: PaymentCodeAttemptRow,
  ): PaymentCodeSubmitResponse {
    const canRetry =
      !attempt.isActive &&
      ["failed", "reversed", "canceled"].includes(attempt.status);
    const nextAction =
      attempt.status === "succeeded"
        ? "dispensing"
        : attempt.status === "manual_handling"
          ? "manual_handling"
          : "wait_payment";
    return {
      orderNo,
      paymentNo,
      attemptNo: attempt.attemptNo,
      status: attempt.status,
      nextAction,
      message: this.describeAttempt(attempt),
      canRetry,
      serverTime: new Date().toISOString(),
    };
  }

  private describeAttempt(attempt: PaymentCodeAttemptRow): string {
    switch (attempt.status) {
      case "succeeded":
        return "支付成功，正在出货";
      case "user_confirming":
        return "请在手机上确认支付";
      case "querying":
      case "submitting":
      case "unknown":
        return "正在确认支付结果";
      case "failed":
        return (
          attempt.failureMessage ?? "付款码无效或支付失败，请刷新付款码后重试"
        );
      case "reversed":
      case "canceled":
        return (
          attempt.failureMessage ?? "本次付款码交易已撤销，请刷新付款码后重试"
        );
      case "created":
        return "正在提交付款码";
      case "manual_handling":
        return (
          attempt.manualReason ?? attempt.failureMessage ?? "支付结果待人工处理"
        );
      case "reversing":
        return "正在撤销付款码交易";
      default:
        return attempt.failureMessage ?? "正在处理付款码支付";
    }
  }

  private readString(
    source: Record<string, unknown>,
    key: string,
  ): string | null {
    const value = source[key];
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }

  private readNumber(
    source: Record<string, unknown>,
    key: string,
    fallback: number,
  ): number {
    const value = source[key];
    return typeof value === "number" && Number.isFinite(value) && value > 0
      ? value
      : fallback;
  }

  private reverseRetryDelayMs(config: PaymentProviderRuntimeConfig): number {
    return (
      this.readNumber(
        config.publicConfigJson,
        "paymentCodeReverseRetryIntervalSeconds",
        3,
      ) * 1000
    );
  }

  private reverseMaxAttempts(config: PaymentProviderRuntimeConfig): number {
    const fallback = config.providerCode === "alipay" ? 20 : 3;
    return Math.max(
      1,
      Math.floor(
        this.readNumber(
          config.publicConfigJson,
          "paymentCodeReverseMaxAttempts",
          fallback,
        ),
      ),
    );
  }

  private errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === "string") return error;
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }

  private async wait(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private isTerminalAttempt(attempt: PaymentCodeAttemptRow): boolean {
    return PaymentCodeOrchestratorService.terminalStatuses.includes(
      attempt.status as (typeof PaymentCodeOrchestratorService.terminalStatuses)[number],
    );
  }

  private async markMutableStatus(
    id: string,
    status: PaymentCodeAttemptRow["status"],
    patch: Parameters<PaymentCodeAttemptsService["markStatus"]>[2] = {},
  ): Promise<PaymentCodeAttemptRow> {
    return (await this.tryMarkMutableStatus(id, status, patch)).attempt;
  }

  private async tryMarkMutableStatus(
    id: string,
    status: PaymentCodeAttemptRow["status"],
    patch: Parameters<PaymentCodeAttemptsService["markStatus"]>[2] = {},
  ): Promise<{ attempt: PaymentCodeAttemptRow; changed: boolean }> {
    const updated = await this.attempts.markStatusIfCurrentStatusIn(
      id,
      status,
      [...PaymentCodeOrchestratorService.mutableStatuses],
      patch,
    );
    if (updated) return { attempt: updated, changed: true };
    return { attempt: await this.attempts.getById(id), changed: false };
  }

  private async markReversibleStatus(
    id: string,
    status: PaymentCodeAttemptRow["status"],
    patch: Parameters<PaymentCodeAttemptsService["markStatus"]>[2] = {},
  ): Promise<PaymentCodeAttemptRow> {
    return (await this.tryMarkReversibleStatus(id, status, patch)).attempt;
  }

  private async tryMarkReversibleStatus(
    id: string,
    status: PaymentCodeAttemptRow["status"],
    patch: Parameters<PaymentCodeAttemptsService["markStatus"]>[2] = {},
  ): Promise<{ attempt: PaymentCodeAttemptRow; changed: boolean }> {
    const updated = await this.attempts.markStatusIfCurrentStatusIn(
      id,
      status,
      [...PaymentCodeOrchestratorService.reversibleStatuses],
      patch,
    );
    if (updated) return { attempt: updated, changed: true };
    return { attempt: await this.attempts.getById(id), changed: false };
  }
}
