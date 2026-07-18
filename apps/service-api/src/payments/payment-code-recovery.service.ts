import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";

import type { PaymentProviderRuntimeConfig } from "./payment-provider.interface";

import { AppConfigService } from "../config/app-config.service";
import {
  PaymentCodeAttemptsService,
  type PaymentCodeRecoveryClaim,
} from "./payment-code-attempts.service";
import { PaymentProviderConfigService } from "./payment-provider-config.service";
import { PaymentProviderRegistry } from "./payment-provider.registry";
import { buildStoredEventPayload } from "./payment-redaction.util";
import { PaymentsService } from "./payments.service";

const RECOVERY_LEASE_MS = 30_000;
const RECOVERY_BATCH_SIZE = 20;
const RECOVERY_MAX_ATTEMPTS = 8;

@Injectable()
export class PaymentCodeRecoveryService
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(PaymentCodeRecoveryService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly attempts: PaymentCodeAttemptsService,
    private readonly registry: PaymentProviderRegistry,
    private readonly configService: PaymentProviderConfigService,
    private readonly paymentsService: PaymentsService,
    private readonly config: AppConfigService,
  ) {}

  onModuleInit(): void {
    void this.reconcileDueAttempts().catch((error: unknown) => {
      this.logger.warn(
        `payment-code recovery failed: ${this.errorMessage(error)}`,
      );
    });
    this.timer = setInterval(() => {
      void this.reconcileDueAttempts().catch((error: unknown) => {
        this.logger.warn(
          `payment-code recovery failed: ${this.errorMessage(error)}`,
        );
      });
    }, this.config.paymentReconcileIntervalSeconds * 1000);
  }

  onApplicationShutdown(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async reconcileDueAttempts(): Promise<{ claimed: number }> {
    if (this.running) return { claimed: 0 };
    this.running = true;
    try {
      return { claimed: await this.reconcileBatch() };
    } finally {
      this.running = false;
    }
  }

  private async reconcileBatch(claimed = 0): Promise<number> {
    if (claimed >= RECOVERY_BATCH_SIZE) return claimed;
    const attempt = await this.attempts.claimNextDueRecoveryAttempt({
      ownerToken: randomUUID(),
      leaseMs: RECOVERY_LEASE_MS,
    });
    if (!attempt) return claimed;
    await this.recoverClaim(attempt);
    return this.reconcileBatch(claimed + 1);
  }

  private async recoverClaim(claim: PaymentCodeRecoveryClaim): Promise<void> {
    if (claim.recoveryAttemptCount >= RECOVERY_MAX_ATTEMPTS) {
      await this.markManualHandling(claim, "recovery_attempts_exhausted");
      return;
    }

    let context: Awaited<
      ReturnType<PaymentCodeAttemptsService["getRecoveryContextById"]>
    >;
    let runtimeConfig: PaymentProviderRuntimeConfig;
    try {
      context = await this.attempts.getRecoveryContextById(claim.id);
      runtimeConfig = await this.resolveConfig(context);
    } catch (error) {
      await this.deferRecovery(claim, "querying", error);
      return;
    }

    if (claim.status === "reversing") {
      await this.reverseAttempt(claim, context, runtimeConfig);
      return;
    }

    const provider = this.registry.getPaymentCodeProvider(context.providerCode);
    let result: Awaited<ReturnType<typeof provider.queryPaymentCode>>;
    try {
      result = await provider.queryPaymentCode({
        paymentNo: context.attempt.providerPaymentNo,
        providerTradeNo: context.attempt.providerTradeNo,
        config: runtimeConfig,
      });
    } catch (error) {
      await this.deferRecovery(claim, "querying", error);
      return;
    }

    if (result.status === "succeeded") {
      const applied = await this.paymentsService.applyProviderPaymentResult({
        paymentId: context.attempt.paymentId,
        providerTradeNo:
          result.providerTradeNo ?? context.attempt.providerTradeNo,
        status: "succeeded",
        paidAt: result.paidAt ?? new Date(),
        eventType: "payment_code.recovery_succeeded",
        providerEventId: `payment_code:${context.attempt.providerPaymentNo}:recovery_succeeded`,
        rawPayload: result.rawPayload ?? {},
      });
      if (applied || (await this.isPaymentSucceeded(claim.id))) {
        await this.attempts.releaseRecoveryClaim(claim, {
          status: "succeeded",
          patch: {
            providerTradeNo:
              result.providerTradeNo ?? context.attempt.providerTradeNo,
            providerStatus: result.providerStatus ?? "succeeded",
            failureCode: null,
            failureMessage: null,
            manualReason: null,
            rawPayloadJson: buildStoredEventPayload(result.rawPayload ?? {}),
            lastCheckedAt: new Date(),
            finishedAt: new Date(),
          },
        });
        return;
      }
      await this.markManualHandling(claim, "payment_result_not_applied");
      return;
    }

    if (result.status === "failed" || result.status === "reversed") {
      await this.applyDefinitiveFailure(
        claim,
        context,
        result,
        result.status === "reversed" ? "reversed" : "failed",
      );
      return;
    }

    const expired =
      context.paymentExpiresAt &&
      context.paymentExpiresAt.getTime() <= Date.now();
    if (expired) {
      await this.reverseAttempt(claim, context, runtimeConfig);
      return;
    }

    await this.deferRecovery(claim, "querying", undefined, {
      providerTradeNo:
        result.providerTradeNo ?? context.attempt.providerTradeNo,
      providerStatus: result.providerStatus ?? result.status,
      failureCode: result.failureCode ?? null,
      failureMessage: result.failureMessage ?? null,
      rawPayloadJson: buildStoredEventPayload(result.rawPayload ?? {}),
      lastCheckedAt: new Date(),
    });
  }

  private async reverseAttempt(
    claim: PaymentCodeRecoveryClaim,
    context: Awaited<
      ReturnType<PaymentCodeAttemptsService["getRecoveryContextById"]>
    >,
    config: PaymentProviderRuntimeConfig,
  ): Promise<void> {
    const provider = this.registry.getPaymentCodeProvider(context.providerCode);
    let result: Awaited<ReturnType<typeof provider.reversePaymentCode>>;
    try {
      result = await provider.reversePaymentCode({
        paymentNo: context.attempt.providerPaymentNo,
        providerTradeNo: context.attempt.providerTradeNo,
        config,
      });
    } catch (error) {
      await this.deferRecovery(claim, "reversing", error);
      return;
    }
    if (result.status === "reversed" || result.status === "failed") {
      await this.applyDefinitiveFailure(
        claim,
        context,
        result,
        result.status === "reversed" ? "reversed" : "failed",
      );
      return;
    }
    await this.deferRecovery(claim, "reversing", undefined, {
      providerStatus: result.providerStatus ?? result.status,
      failureCode: result.failureCode ?? null,
      failureMessage: result.failureMessage ?? null,
      rawPayloadJson: buildStoredEventPayload(result.rawPayload ?? {}),
      lastCheckedAt: new Date(),
    });
  }

  private async applyDefinitiveFailure(
    claim: PaymentCodeRecoveryClaim,
    context: Awaited<
      ReturnType<PaymentCodeAttemptsService["getRecoveryContextById"]>
    >,
    result: {
      providerTradeNo?: string | null;
      providerStatus?: string | null;
      failureCode?: string | null;
      failureMessage?: string | null;
      rawPayload?: Record<string, unknown>;
    },
    status: "failed" | "reversed",
  ): Promise<void> {
    const applied = await this.paymentsService.applyProviderPaymentResult({
      paymentId: context.attempt.paymentId,
      providerTradeNo:
        result.providerTradeNo ?? context.attempt.providerTradeNo,
      status: "failed",
      eventType: `payment_code.recovery_${status}`,
      providerEventId: `payment_code:${context.attempt.providerPaymentNo}:recovery_${status}`,
      failedReason: result.failureCode ?? `payment_code_${status}`,
      rawPayload: result.rawPayload ?? {},
    });
    if (!applied && !(await this.isPaymentTerminallyClosed(claim.id))) {
      await this.markManualHandling(claim, "definitive_result_not_applied");
      return;
    }
    await this.attempts.releaseRecoveryClaim(claim, {
      status,
      patch: {
        providerTradeNo:
          result.providerTradeNo ?? context.attempt.providerTradeNo,
        providerStatus: result.providerStatus ?? status,
        failureCode: result.failureCode ?? null,
        failureMessage: result.failureMessage ?? null,
        rawPayloadJson: buildStoredEventPayload(result.rawPayload ?? {}),
        lastCheckedAt: new Date(),
        reversedAt: status === "reversed" ? new Date() : null,
        finishedAt: new Date(),
      },
    });
  }

  private async deferRecovery(
    claim: PaymentCodeRecoveryClaim,
    status: "querying" | "reversing",
    error?: unknown,
    patch: Parameters<
      PaymentCodeAttemptsService["releaseRecoveryClaim"]
    >[1]["patch"] = {},
  ): Promise<void> {
    if (claim.recoveryAttemptCount >= RECOVERY_MAX_ATTEMPTS - 1) {
      await this.markManualHandling(claim, `${status}_retries_exhausted`);
      return;
    }
    const message = error ? this.errorMessage(error) : undefined;
    await this.attempts.releaseRecoveryClaim(claim, {
      status,
      nextRecoveryAt: new Date(
        Date.now() + this.backoffMs(claim.recoveryAttemptCount),
      ),
      patch: {
        ...patch,
        ...(message
          ? {
              providerStatus:
                status === "reversing"
                  ? "PAYMENT_CODE_REVERSE_UNKNOWN"
                  : "PAYMENT_CODE_QUERY_UNKNOWN",
              failureCode:
                status === "reversing"
                  ? "PAYMENT_CODE_REVERSE_UNKNOWN"
                  : "PAYMENT_CODE_QUERY_UNKNOWN",
              failureMessage: message,
              rawPayloadJson: buildStoredEventPayload({ error: message }),
              lastCheckedAt: new Date(),
            }
          : {}),
      },
    });
  }

  private async markManualHandling(
    claim: PaymentCodeRecoveryClaim,
    reason: string,
  ): Promise<void> {
    const marked =
      await this.paymentsService.markPaymentCodeRecoveryManualHandling({
        attemptId: claim.id,
        ownerToken: claim.recoveryLeaseOwnerToken,
        fence: claim.recoveryLeaseFence,
        reason,
      });
    if (marked) return;

    const context = await this.attempts.getRecoveryContextById(claim.id);
    if (context.paymentStatus === "succeeded") {
      await this.attempts.releaseRecoveryClaim(claim, { status: "succeeded" });
      return;
    }
    if (
      ["failed", "expired", "canceled", "unknown", "manual_handling"].includes(
        context.paymentStatus,
      )
    ) {
      await this.attempts.releaseRecoveryClaim(claim, {
        status: "manual_handling",
        patch: { manualReason: reason, finishedAt: new Date() },
      });
    }
  }

  private async isPaymentSucceeded(attemptId: string): Promise<boolean> {
    return (
      (await this.attempts.getRecoveryContextById(attemptId)).paymentStatus ===
      "succeeded"
    );
  }

  private async isPaymentTerminallyClosed(attemptId: string): Promise<boolean> {
    return ["failed", "expired", "canceled"].includes(
      (await this.attempts.getRecoveryContextById(attemptId)).paymentStatus,
    );
  }

  private async resolveConfig(context: {
    providerCode: "wechat_pay" | "alipay" | "mock";
    providerConfigId: string | null;
    machineId: string;
    providerConfigSnapshotJson: unknown;
  }): Promise<PaymentProviderRuntimeConfig> {
    if (context.providerCode === "mock") {
      return {
        providerCode: "mock",
        merchantNo: null,
        appId: null,
        publicConfigJson: {},
        sensitiveConfigJson: {},
      };
    }
    return await this.configService.resolveForExistingPayment({
      providerCode: context.providerCode,
      providerConfigId: context.providerConfigId,
      machineId: context.machineId,
      providerConfigSnapshotJson: context.providerConfigSnapshotJson,
    });
  }

  private backoffMs(attemptCount: number): number {
    return Math.min(60_000, 1_000 * 2 ** Math.min(attemptCount - 1, 6));
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
}
