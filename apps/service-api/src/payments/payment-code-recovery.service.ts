import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
  Optional,
} from "@nestjs/common";
import { paymentCodeAttempts } from "@vem/db";
import { randomUUID } from "node:crypto";

import type {
  PaymentProviderRuntimeConfig,
  ProviderPaymentCodeChargeResult,
  ProviderPaymentCodeQueryResult,
  ProviderPaymentCodeReverseResult,
} from "./payment-provider.interface";

import { AppConfigService } from "../config/app-config.service";
import {
  PaymentCodeAttemptsService,
  type PaymentCodeAttemptRow,
  type PaymentCodeRecoveryClaim,
} from "./payment-code-attempts.service";
import { PaymentProviderConfigService } from "./payment-provider-config.service";
import { PaymentProviderRegistry } from "./payment-provider.registry";
import { buildStoredEventPayload } from "./payment-redaction.util";
import { PaymentsService } from "./payments.service";

const RECOVERY_LEASE_MS = 30_000;
const RECOVERY_BATCH_SIZE = 20;
const RECOVERY_MAX_ATTEMPTS = 8;
const PROVIDER_CALL_TIMEOUT_MS = 15_000;

class PaymentCodeRecoveryLeaseLostError extends Error {
  constructor(attemptId: string, cause?: unknown) {
    super(`payment_code_recovery_lease_lost:${attemptId}`, { cause });
    this.name = "PaymentCodeRecoveryLeaseLostError";
  }
}

export const PAYMENT_CODE_WORKER_FAULTS = Symbol("PAYMENT_CODE_WORKER_FAULTS");
export const PAYMENT_CODE_WORKER_OPTIONS = Symbol(
  "PAYMENT_CODE_WORKER_OPTIONS",
);

export type PaymentCodeWorkerFaults = {
  beforeProviderCall?: (input: {
    operation: "charge" | "query" | "reverse";
    attemptId: string;
  }) => Promise<void>;
  afterProviderResponse?: (input: {
    operation: "charge" | "query" | "reverse";
    attemptId: string;
  }) => Promise<void>;
};

export type PaymentCodeWorkerOptions = {
  recoveryLeaseMs?: number;
  providerCallTimeoutMs?: number;
  recoveryBatchSize?: number;
  recoveryMaxAttempts?: number;
};

type RecoveryContext = Awaited<
  ReturnType<PaymentCodeAttemptsService["getRecoveryContextById"]>
>;
type PaymentCodeProviderResult =
  | ProviderPaymentCodeChargeResult
  | ProviderPaymentCodeReverseResult;

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
    @Optional()
    @Inject(PAYMENT_CODE_WORKER_FAULTS)
    private readonly faults: PaymentCodeWorkerFaults = {},
    @Optional()
    @Inject(PAYMENT_CODE_WORKER_OPTIONS)
    private readonly options: PaymentCodeWorkerOptions = {},
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

  /**
   * This is the only path that can submit a customer-presented code. The
   * caller supplies the raw code ephemerally; the durable attempt is admitted
   * and lease-fenced before the provider can observe it.
   */
  async submitAttempt(input: {
    attemptId: string;
    authCode: string;
    clientIp: string | null;
  }): Promise<PaymentCodeAttemptRow> {
    let context: RecoveryContext;
    let runtimeConfig: PaymentProviderRuntimeConfig;
    try {
      context = await this.attempts.getRecoveryContextById(input.attemptId);
      if (context.providerCode !== "mock") {
        await this.configService.assertMachinePaymentChannelAvailable({
          machineId: context.machineId,
          providerCode: context.providerCode,
          method: "payment_code",
        });
      }
      runtimeConfig = await this.resolveConfig(context);
    } catch (error) {
      await this.attempts.markStatusIfCurrentStatusIn(
        input.attemptId,
        "failed",
        ["created"],
        {
          failureCode: "PAYMENT_CODE_ADMISSION_FAILED",
          failureMessage: this.errorMessage(error),
          finishedAt: new Date(),
        },
      );
      throw error;
    }

    const claim = await this.attempts.claimSubmission({
      attemptId: input.attemptId,
      ownerToken: randomUUID(),
      leaseMs: this.recoveryLeaseMs,
    });
    if (!claim) return await this.attempts.getById(input.attemptId);

    const provider = this.registry.getPaymentCodeProvider(context.providerCode);
    await this.runFault("beforeProviderCall", "charge", claim.id);
    let result: ProviderPaymentCodeChargeResult;
    try {
      result = await this.callWithRenewedLease(
        claim,
        async () =>
          await provider.chargePaymentCode({
            paymentNo: claim.providerPaymentNo,
            // The provider payment number is the durable provider operation and
            // idempotency key. Alipay/WeChat map it to out_trade_no.
            idempotencyKey: claim.providerPaymentNo,
            orderNo: context.orderNo,
            amountCents: claim.amountCents,
            authCode: input.authCode,
            terminalId: this.readString(
              runtimeConfig.publicConfigJson,
              "terminalId",
            ),
            storeId: this.readString(runtimeConfig.publicConfigJson, "storeId"),
            clientIp: input.clientIp,
            config: runtimeConfig,
          }),
      );
    } catch (error) {
      await this.deferRecovery(claim, "querying", error);
      return await this.attempts.getById(claim.id);
    }

    // Tests may throw here to emulate an abrupt process death. Do not catch
    // this boundary: a replacement worker must recover the committed
    // submitting attempt by provider query, not a local catch handler.
    await this.runFault("afterProviderResponse", "charge", claim.id);
    return await this.applyChargeResult(claim, context, runtimeConfig, result);
  }

  async requestManualQuery(
    id: string,
    reason: string | null = null,
  ): Promise<PaymentCodeAttemptRow> {
    const requested = await this.attempts.requestRecoveryAction(
      id,
      "querying",
      reason,
    );
    if (!requested.isActive || this.isTerminal(requested)) return requested;
    return await this.processAttemptNow(id);
  }

  async requestManualReverse(
    id: string,
    reason: string,
  ): Promise<PaymentCodeAttemptRow> {
    const requested = await this.attempts.requestRecoveryAction(
      id,
      "reversing",
      reason,
    );
    if (!requested.isActive || this.isTerminal(requested)) return requested;
    return await this.processAttemptNow(id);
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
    if (claimed >= this.recoveryBatchSize) return claimed;
    const claim = await this.attempts.claimNextDueRecoveryAttempt({
      ownerToken: randomUUID(),
      leaseMs: this.recoveryLeaseMs,
    });
    if (!claim) return claimed;
    await this.recoverClaim(claim);
    return await this.reconcileBatch(claimed + 1);
  }

  private async processAttemptNow(id: string): Promise<PaymentCodeAttemptRow> {
    const claim = await this.attempts.claimRecoveryAttemptById({
      id,
      ownerToken: randomUUID(),
      leaseMs: this.recoveryLeaseMs,
    });
    if (!claim) return await this.attempts.getById(id);
    await this.recoverClaim(claim);
    return await this.attempts.getById(id);
  }

  private async recoverClaim(claim: PaymentCodeRecoveryClaim): Promise<void> {
    if (claim.status === "created") {
      await this.attempts.releaseRecoveryClaim(claim, {
        status: "failed",
        patch: {
          failureCode: "PAYMENT_CODE_SUBMISSION_NOT_ADMITTED",
          failureMessage: "付款码提交未送达支付机构，请重新扫码",
          finishedAt: new Date(),
        },
      });
      return;
    }
    if (claim.status === "manual_handling") {
      await this.markManualHandling(
        claim,
        claim.manualReason ?? "operator_requested_manual_handling",
      );
      return;
    }
    if (claim.recoveryAttemptCount >= this.recoveryMaxAttempts) {
      await this.markManualHandling(claim, "recovery_attempts_exhausted");
      return;
    }

    let context: RecoveryContext;
    let runtimeConfig: PaymentProviderRuntimeConfig;
    try {
      context = await this.attempts.getRecoveryContextById(claim.id);
      runtimeConfig = await this.resolveConfig(context);
    } catch (error) {
      await this.deferRecovery(claim, "querying", error);
      return;
    }

    if (context.paymentStatus === "succeeded") {
      await this.attempts.releaseRecoveryClaim(claim, { status: "succeeded" });
      return;
    }
    if (["failed", "expired", "canceled"].includes(context.paymentStatus)) {
      await this.attempts.releaseRecoveryClaim(claim, {
        status: "failed",
        patch: { finishedAt: new Date() },
      });
      return;
    }

    await this.queryAndResolve(claim, context, runtimeConfig);
  }

  private async applyChargeResult(
    claim: PaymentCodeRecoveryClaim,
    context: RecoveryContext,
    runtimeConfig: PaymentProviderRuntimeConfig,
    result: ProviderPaymentCodeChargeResult,
  ): Promise<PaymentCodeAttemptRow> {
    if (result.status === "succeeded") {
      await this.applyProviderTerminalResult(claim, context, result, {
        paymentStatus: "succeeded",
        attemptStatus: "succeeded",
        eventSuffix: "charge_succeeded",
      });
      return await this.attempts.getById(claim.id);
    }
    if (result.status === "reversed") {
      await this.applyProviderTerminalResult(claim, context, result, {
        paymentStatus: "failed",
        attemptStatus: "reversed",
        eventSuffix: "charge_reversed",
      });
      return await this.attempts.getById(claim.id);
    }
    if (result.status === "failed") {
      await this.attempts.releaseRecoveryClaim(claim, {
        status: "failed",
        patch: {
          providerTradeNo: result.providerTradeNo,
          providerStatus: result.providerStatus ?? "failed",
          failureCode: result.failureCode ?? "PAYMENT_CODE_FAILED",
          failureMessage: result.failureMessage ?? "付款码无效或支付失败",
          rawPayloadJson: buildStoredEventPayload(result.rawPayload ?? {}),
          lastCheckedAt: new Date(),
          finishedAt: new Date(),
        },
      });
      return await this.attempts.getById(claim.id);
    }

    await this.deferRecovery(
      claim,
      result.status === "user_confirming" ? "user_confirming" : "querying",
      undefined,
      {
        providerTradeNo: result.providerTradeNo,
        providerStatus: result.providerStatus ?? result.status,
        failureCode: result.failureCode ?? null,
        failureMessage: result.failureMessage ?? null,
        rawPayloadJson: buildStoredEventPayload(result.rawPayload ?? {}),
        lastCheckedAt: new Date(),
      },
      this.pollDelayMs(context.providerCode, runtimeConfig),
    );
    return await this.attempts.getById(claim.id);
  }

  private async queryAndResolve(
    claim: PaymentCodeRecoveryClaim,
    context: RecoveryContext,
    runtimeConfig: PaymentProviderRuntimeConfig,
  ): Promise<void> {
    const provider = this.registry.getPaymentCodeProvider(context.providerCode);
    await this.runFault("beforeProviderCall", "query", claim.id);
    let result: ProviderPaymentCodeQueryResult;
    try {
      result = await this.callWithRenewedLease(
        claim,
        async () =>
          await provider.queryPaymentCode({
            paymentNo: claim.providerPaymentNo,
            providerTradeNo: context.attempt.providerTradeNo,
            config: runtimeConfig,
          }),
      );
    } catch (error) {
      await this.deferRecovery(claim, "querying", error);
      return;
    }
    await this.runFault("afterProviderResponse", "query", claim.id);

    if (result.status === "succeeded") {
      await this.applyProviderTerminalResult(claim, context, result, {
        paymentStatus: "succeeded",
        attemptStatus: "succeeded",
        eventSuffix: "query_succeeded",
        allowIncidentLockedResolution: true,
      });
      return;
    }
    if (result.status === "failed" || result.status === "reversed") {
      await this.applyProviderTerminalResult(claim, context, result, {
        paymentStatus: "failed",
        attemptStatus: result.status === "reversed" ? "reversed" : "failed",
        eventSuffix: `query_${result.status}`,
        allowIncidentLockedResolution: true,
      });
      return;
    }

    const shouldReverse =
      claim.status === "reversing" ||
      (context.paymentExpiresAt !== null &&
        context.paymentExpiresAt.getTime() <= Date.now());
    if (shouldReverse) {
      await this.reverseAfterQuery(claim, context, runtimeConfig, result);
      return;
    }

    await this.deferRecovery(
      claim,
      result.status === "user_confirming" ? "user_confirming" : "querying",
      undefined,
      this.providerPatch(result),
      this.pollDelayMs(context.providerCode, runtimeConfig),
    );
  }

  private async reverseAfterQuery(
    claim: PaymentCodeRecoveryClaim,
    context: RecoveryContext,
    runtimeConfig: PaymentProviderRuntimeConfig,
    query: ProviderPaymentCodeQueryResult,
  ): Promise<void> {
    const reversalClaim = await this.attempts.beginReversal(
      claim,
      this.providerPatch(query),
    );
    if (!reversalClaim) return;

    const provider = this.registry.getPaymentCodeProvider(context.providerCode);
    await this.runFault("beforeProviderCall", "reverse", reversalClaim.id);
    let result: ProviderPaymentCodeReverseResult;
    try {
      result = await this.callWithRenewedLease(
        reversalClaim,
        async () =>
          await provider.reversePaymentCode({
            paymentNo: reversalClaim.providerPaymentNo,
            providerTradeNo:
              query.providerTradeNo ?? context.attempt.providerTradeNo,
            idempotencyKey: reversalClaim.providerPaymentNo,
            config: runtimeConfig,
          }),
      );
    } catch (error) {
      await this.deferRecovery(reversalClaim, "querying", error);
      return;
    }
    await this.runFault("afterProviderResponse", "reverse", reversalClaim.id);

    if (result.status === "reversed") {
      await this.applyProviderTerminalResult(reversalClaim, context, result, {
        paymentStatus: "failed",
        attemptStatus: "reversed",
        eventSuffix: "reverse_confirmed",
        allowIncidentLockedResolution: true,
      });
      return;
    }

    // A rejected, timed-out, or indeterminate reverse says nothing about the
    // original payment. Return to provider query and retain the reservation.
    await this.deferRecovery(
      reversalClaim,
      "querying",
      undefined,
      {
        ...this.providerPatch(result),
        failureCode: result.failureCode ?? "PAYMENT_CODE_REVERSE_UNKNOWN",
        failureMessage: result.failureMessage ?? "付款码撤销结果待支付机构确认",
      },
      this.pollDelayMs(context.providerCode, runtimeConfig),
    );
  }

  private async applyProviderTerminalResult(
    claim: PaymentCodeRecoveryClaim,
    context: RecoveryContext,
    result: PaymentCodeProviderResult,
    input: {
      paymentStatus: "succeeded" | "failed";
      attemptStatus: "succeeded" | "failed" | "reversed";
      eventSuffix: string;
      allowIncidentLockedResolution?: boolean;
    },
  ): Promise<void> {
    const now = new Date();
    await this.paymentsService.applyPaymentCodeAttemptProviderResult({
      attemptId: claim.id,
      paymentId: claim.paymentId,
      orderId: claim.orderId,
      providerId: claim.providerId,
      providerTradeNo:
        this.providerTradeNo(result) ?? context.attempt.providerTradeNo,
      paymentStatus: input.paymentStatus,
      attemptStatus: input.attemptStatus,
      ownerToken: claim.recoveryLeaseOwnerToken,
      fence: claim.recoveryLeaseFence,
      paidAt:
        input.paymentStatus === "succeeded"
          ? (("paidAt" in result ? result.paidAt : null) ?? now)
          : null,
      failedReason:
        input.paymentStatus === "failed"
          ? (result.failureCode ?? `payment_code_${input.eventSuffix}`)
          : null,
      eventType: `payment_code.${input.eventSuffix}`,
      providerEventId: `payment_code:${claim.providerPaymentNo}:${input.eventSuffix}`,
      rawPayload: result.rawPayload ?? {},
      attemptPatch: {
        ...this.providerPatch(result),
        failureCode:
          input.paymentStatus === "succeeded"
            ? null
            : (result.failureCode ?? `payment_code_${input.eventSuffix}`),
        failureMessage:
          input.paymentStatus === "succeeded"
            ? null
            : (result.failureMessage ?? null),
        manualReason: input.paymentStatus === "succeeded" ? null : undefined,
        reversedAt: input.attemptStatus === "reversed" ? now : null,
        finishedAt: now,
      },
      allowIncidentLockedResolution:
        input.allowIncidentLockedResolution ?? false,
    });
  }

  private async deferRecovery(
    claim: PaymentCodeRecoveryClaim,
    status: "user_confirming" | "querying" | "reversing",
    error?: unknown,
    patch: Partial<typeof paymentCodeAttempts.$inferInsert> = {},
    delayMs = this.backoffMs(claim.recoveryAttemptCount),
  ): Promise<void> {
    if (claim.recoveryAttemptCount >= this.recoveryMaxAttempts - 1) {
      await this.markManualHandling(claim, `${status}_retries_exhausted`);
      return;
    }
    const message = error ? this.errorMessage(error) : null;
    await this.attempts.releaseRecoveryClaim(claim, {
      status,
      nextRecoveryAt: new Date(Date.now() + delayMs),
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
    await this.paymentsService.markPaymentCodeAttemptManualHandling({
      attemptId: claim.id,
      ownerToken: claim.recoveryLeaseOwnerToken,
      fence: claim.recoveryLeaseFence,
      reason,
    });
  }

  private async callWithRenewedLease<T>(
    claim: PaymentCodeRecoveryClaim,
    call: () => Promise<T>,
  ): Promise<T> {
    await this.requireLeaseRenewal(claim);

    let renewing = false;
    let leaseLost = false;
    let rejectLeaseLost!: (error: Error) => void;
    const leaseLostPromise = new Promise<T>((_resolve, reject) => {
      rejectLeaseLost = reject;
    });
    const interval = setInterval(
      () => {
        if (renewing || leaseLost) return;
        renewing = true;
        void this.attempts
          .renewRecoveryClaim(claim, this.recoveryLeaseMs)
          .then((renewed) => {
            if (renewed) return;
            leaseLost = true;
            rejectLeaseLost(new PaymentCodeRecoveryLeaseLostError(claim.id));
          })
          .catch((error: unknown) => {
            leaseLost = true;
            this.logger.warn(
              `payment-code lease renewal failed for ${claim.id}: ${this.errorMessage(error)}`,
            );
            rejectLeaseLost(
              new PaymentCodeRecoveryLeaseLostError(claim.id, error),
            );
          })
          .finally(() => {
            renewing = false;
          });
      },
      Math.max(25, Math.floor(this.recoveryLeaseMs / 3)),
    );
    try {
      return await Promise.race([
        this.withTimeout(call(), this.providerCallTimeoutMs),
        leaseLostPromise,
      ]);
    } finally {
      clearInterval(interval);
    }
  }

  private async requireLeaseRenewal(
    claim: PaymentCodeRecoveryClaim,
  ): Promise<void> {
    try {
      if (await this.attempts.renewRecoveryClaim(claim, this.recoveryLeaseMs)) {
        return;
      }
    } catch (error) {
      throw new PaymentCodeRecoveryLeaseLostError(claim.id, error);
    }
    throw new PaymentCodeRecoveryLeaseLostError(claim.id);
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
  ): Promise<T> {
    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_resolve, reject) => {
          timeout = setTimeout(() => {
            reject(new Error("payment_code_provider_call_timed_out"));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async resolveConfig(
    context: Pick<
      RecoveryContext,
      | "providerCode"
      | "providerConfigId"
      | "machineId"
      | "providerConfigSnapshotJson"
    >,
  ): Promise<PaymentProviderRuntimeConfig> {
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

  private providerPatch(
    result: PaymentCodeProviderResult,
  ): Partial<typeof paymentCodeAttempts.$inferInsert> {
    return {
      providerTradeNo: this.providerTradeNo(result),
      providerStatus: result.providerStatus ?? result.status,
      failureCode: result.failureCode ?? null,
      failureMessage: result.failureMessage ?? null,
      rawPayloadJson: buildStoredEventPayload(result.rawPayload ?? {}),
      lastCheckedAt: new Date(),
    };
  }

  private providerTradeNo(result: PaymentCodeProviderResult): string | null {
    return "providerTradeNo" in result
      ? (result.providerTradeNo ?? null)
      : null;
  }

  private pollDelayMs(
    providerCode: RecoveryContext["providerCode"],
    runtimeConfig: PaymentProviderRuntimeConfig,
  ): number {
    const fallback = providerCode === "wechat_pay" ? 5_000 : 3_000;
    return (
      this.readNumber(
        runtimeConfig.publicConfigJson,
        "paymentCodePollIntervalSeconds",
        fallback / 1_000,
      ) * 1_000
    );
  }

  private backoffMs(attemptCount: number): number {
    return Math.min(60_000, 1_000 * 2 ** Math.min(attemptCount - 1, 6));
  }

  private get recoveryLeaseMs(): number {
    return this.options.recoveryLeaseMs ?? RECOVERY_LEASE_MS;
  }

  private get providerCallTimeoutMs(): number {
    return this.options.providerCallTimeoutMs ?? PROVIDER_CALL_TIMEOUT_MS;
  }

  private get recoveryBatchSize(): number {
    return this.options.recoveryBatchSize ?? RECOVERY_BATCH_SIZE;
  }

  private get recoveryMaxAttempts(): number {
    return this.options.recoveryMaxAttempts ?? RECOVERY_MAX_ATTEMPTS;
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

  private isTerminal(attempt: PaymentCodeAttemptRow): boolean {
    return ["succeeded", "failed", "reversed", "canceled"].includes(
      attempt.status,
    );
  }

  private async runFault(
    boundary: keyof PaymentCodeWorkerFaults,
    operation: "charge" | "query" | "reverse",
    attemptId: string,
  ): Promise<void> {
    const hook = this.faults[boundary];
    if (hook) await hook({ operation, attemptId });
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
