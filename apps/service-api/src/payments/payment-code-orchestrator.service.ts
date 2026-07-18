import type {
  PaymentCodeSubmitInput,
  PaymentCodeSubmitResponse,
} from "@vem/shared";

import { Injectable } from "@nestjs/common";

import { AppConfigService } from "../config/app-config.service";
import {
  PaymentCodeAttemptsService,
  type PaymentCodeAttemptRow,
} from "./payment-code-attempts.service";
import { PaymentCodeRecoveryService } from "./payment-code-recovery.service";

/**
 * HTTP/admin facade only. It persists the scan intent and delegates every
 * provider-facing state transition to PaymentCodeRecoveryService, the durable
 * lease-fenced worker.
 */
@Injectable()
export class PaymentCodeOrchestratorService {
  constructor(
    private readonly attempts: PaymentCodeAttemptsService,
    private readonly worker: PaymentCodeRecoveryService,
    private readonly appConfig: AppConfigService,
  ) {}

  async submit(
    input: PaymentCodeSubmitInput & {
      orderNo: string;
      clientIp: string | null;
    },
  ): Promise<PaymentCodeSubmitResponse> {
    const { payment, attempt } = await this.attempts.createOrReplay({
      orderNo: input.orderNo,
      machineCode: input.machineCode,
      authCode: input.authCode,
      idempotencyKey: input.idempotencyKey,
      source: input.source,
      scannerHealthJson: input.scannerHealth ?? null,
      mockPaymentEnabled: this.appConfig.paymentMockEnabled,
    });

    const current =
      attempt.status === "created" && attempt.isActive
        ? await this.worker.submitAttempt({
            attemptId: attempt.id,
            authCode: input.authCode,
            clientIp: input.clientIp,
          })
        : attempt;
    return this.toSubmitResponse(input.orderNo, payment.paymentNo, current);
  }

  async manualQuery(id: string): Promise<PaymentCodeAttemptRow> {
    return await this.worker.requestManualQuery(id);
  }

  async manualReverse(
    id: string,
    reason: string,
  ): Promise<PaymentCodeAttemptRow> {
    return await this.worker.requestManualReverse(id, reason);
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
      case "reversal_unknown":
        return "撤销结果待确认，请联系工作人员";
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
}
