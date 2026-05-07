import { Inject, Injectable } from "@nestjs/common";
import {
  and,
  count,
  eq,
  machines,
  paymentProviderConfigs,
  paymentProviders,
  paymentReconciliationAttempts,
  paymentWebhookAttempts,
  payments,
  refunds,
  sql,
  type DrizzleClient,
} from "@vem/db";
import type {
  PaymentMachinePreflight,
  PaymentOpsCheck,
  PaymentOpsMetrics,
  PaymentOpsReadiness,
} from "@vem/shared";

import { AppConfigService } from "../config/app-config.service";
import { isEncryptedJson } from "../crypto/encrypted-json.util";
import { DRIZZLE_CLIENT } from "../database/database.constants";
import { PaymentConfigSecretService } from "./payment-config-secret.service";
import { PaymentProviderConfigService } from "./payment-provider-config.service";

@Injectable()
export class PaymentOpsService {
  constructor(
    @Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient,
    private readonly config: AppConfigService,
    private readonly paymentConfigSecrets: PaymentConfigSecretService,
    private readonly providerConfigs: PaymentProviderConfigService,
  ) {}

  async getReadiness(): Promise<PaymentOpsReadiness> {
    const checks: PaymentOpsCheck[] = [
      await this.checkMockProviderDisabled(),
      await this.checkRealProviderConfigsPresent(),
      await this.checkNotifyUrls(),
      await this.checkCertificates(),
      await this.checkRecentWebhookFailures(),
      await this.checkRecentReconciliationFailures(),
      await this.checkRefundBacklog(),
    ];
    const criticalFailed = checks.some(
      (check) => check.severity === "critical" && !check.passed,
    );
    return {
      status: criticalFailed ? "blocked" : "ready",
      checkedAt: new Date().toISOString(),
      environment: this.config.nodeEnv,
      checks,
    };
  }

  async getMetrics(
    windowMinutes = this.config.paymentAlertWindowMinutes,
  ): Promise<PaymentOpsMetrics> {
    const measuredAt = new Date();
    const from = new Date(measuredAt.getTime() - windowMinutes * 60_000);

    const [paymentTotals] = await this.db
      .select({
        total: count(),
        failed: sql<number>`count(*) filter (where ${payments.status} = 'failed')`,
      })
      .from(payments)
      .where(sql`${payments.createdAt} >= ${from}`);

    const [webhookTotals] = await this.db
      .select({
        signatureInvalid: sql<number>`count(*) filter (where ${paymentWebhookAttempts.signatureValid} = false)`,
        businessInvalid: sql<number>`count(*) filter (where ${paymentWebhookAttempts.businessValid} = false)`,
      })
      .from(paymentWebhookAttempts)
      .where(sql`${paymentWebhookAttempts.createdAt} >= ${from}`);

    const [reconcileTotals] = await this.db
      .select({ total: count() })
      .from(paymentReconciliationAttempts)
      .where(
        and(
          sql`${paymentReconciliationAttempts.createdAt} >= ${from}`,
          sql`${paymentReconciliationAttempts.status} in ('network_error', 'config_error', 'max_attempts_exceeded')`,
        ),
      );

    const [refundTotals] = await this.db
      .select({
        failed: sql<number>`count(*) filter (where ${refunds.status} = 'failed')`,
        overdue: sql<number>`count(*) filter (where ${refunds.status} = 'processing' and ${refunds.updatedAt} < ${new Date(measuredAt.getTime() - 30 * 60_000)})`,
      })
      .from(refunds)
      .where(sql`${refunds.createdAt} >= ${from}`);

    const paymentTotalCount = Number(paymentTotals.total);
    const paymentFailedCount = Number(paymentTotals.failed);

    return {
      measuredAt: measuredAt.toISOString(),
      windowMinutes,
      paymentFailureRate:
        paymentTotalCount === 0 ? 0 : paymentFailedCount / paymentTotalCount,
      paymentFailedCount,
      paymentTotalCount,
      webhookSignatureInvalidCount: Number(webhookTotals.signatureInvalid),
      webhookBusinessInvalidCount: Number(webhookTotals.businessInvalid),
      reconciliationErrorCount: Number(reconcileTotals.total),
      refundFailedCount: Number(refundTotals.failed),
      refundProcessingOverdueCount: Number(refundTotals.overdue),
      certificateExpiringCount: await this.countExpiringCertificates(
        measuredAt,
      ),
    };
  }

  async getMachinePreflight(machineId: string): Promise<PaymentMachinePreflight> {
    const [machine] = await this.db
      .select({ id: machines.id, code: machines.code, status: machines.status })
      .from(machines)
      .where(eq(machines.id, machineId))
      .limit(1);

    if (!machine) {
      return {
        machineId,
        machineCode: "",
        status: "blocked",
        availableProviders: [],
        checks: [
          {
            code: "machine_not_found",
            severity: "critical",
            passed: false,
            message: "Machine does not exist",
            evidence: { machineId },
          },
        ],
        checkedAt: new Date().toISOString(),
      };
    }

    const options =
      await this.providerConfigs.listMachinePaymentOptionsForMachine(machine.id);

    const checks: PaymentOpsCheck[] = [
      {
        code: "machine_online",
        severity: "critical",
        passed: machine.status === "online",
        message:
          machine.status === "online"
            ? "Machine is online"
            : "Machine is not online",
        evidence: { machineStatus: machine.status },
      },
      {
        code: "machine_real_provider_available",
        severity: "critical",
        passed: options.options.some((item) => item.providerCode !== "mock"),
        message:
          "At least one real payment provider is available for this machine",
        evidence: {
          providerCodes: options.options.map((item) => item.providerCode),
        },
      },
    ];

    return {
      machineId: machine.id,
      machineCode: machine.code,
      status: checks.every((check) => check.passed) ? "ready" : "blocked",
      availableProviders: options.options,
      checks,
      checkedAt: new Date().toISOString(),
    };
  }

  private async checkMockProviderDisabled(): Promise<PaymentOpsCheck> {
    const [mockProvider] = await this.db
      .select({ status: paymentProviders.status })
      .from(paymentProviders)
      .where(eq(paymentProviders.code, "mock"))
      .limit(1);

    const passed =
      !this.config.paymentMockEnabled &&
      mockProvider?.status !== "enabled";

    return {
      code: "mock_provider_disabled",
      severity:
        this.config.nodeEnv === "production" ? "critical" : "warning",
      passed,
      message: passed
        ? "Mock payment is disabled"
        : "Mock payment is enabled",
      evidence: {
        envPaymentMockEnabled: this.config.paymentMockEnabled,
        mockProviderStatus: mockProvider?.status ?? null,
      },
    };
  }

  private async checkRealProviderConfigsPresent(): Promise<PaymentOpsCheck> {
    const rows = await this.db
      .select({
        providerCode: paymentProviders.code,
        status: paymentProviderConfigs.status,
        machineId: paymentProviderConfigs.machineId,
      })
      .from(paymentProviderConfigs)
      .innerJoin(
        paymentProviders,
        eq(paymentProviders.id, paymentProviderConfigs.providerId),
      )
      .where(
        sql`${paymentProviders.code} in ('wechat_pay', 'alipay')`,
      );

    const enabledRows = rows.filter((row) => row.status === "enabled");
    const enabledGlobal = enabledRows.filter((row) => row.machineId === null);
    const enabledMachineScoped = enabledRows.filter(
      (row) => row.machineId !== null,
    );

    return {
      code: "real_provider_config_present",
      severity: "critical",
      passed: enabledRows.length > 0,
      message:
        enabledRows.length > 0
          ? "At least one real provider config is enabled for global or machine-level rollout"
          : "No real provider config is enabled",
      evidence: {
        enabledGlobalProviders: enabledGlobal.map((row) => row.providerCode),
        enabledMachineScopedProviders: enabledMachineScoped.map((row) => ({
          providerCode: row.providerCode,
          machineId: row.machineId,
        })),
      },
    };
  }

  private async checkNotifyUrls(): Promise<PaymentOpsCheck> {
    const checks = await Promise.all(
      ["wechat_pay", "alipay"].map(async (providerCode) => {
        const staticCheck =
          this.config.getPaymentNotifyUrlStaticCheck(providerCode);
        return {
          providerCode,
          ok:
            staticCheck.pathMatchesWebhookRoute &&
            (this.config.nodeEnv !== "production" || staticCheck.usesHttps) &&
            (this.config.nodeEnv !== "production" || !staticCheck.isLocalhost),
          staticCheck,
        };
      }),
    );

    return {
      code: "notify_url_static_check",
      severity: "critical",
      passed: checks.every((item) => item.ok),
      message:
        "Notify URL path, protocol and host are valid for the environment",
      evidence: { checks },
    };
  }

  private async checkCertificates(): Promise<PaymentOpsCheck> {
    const total = await this.countExpiringCertificates(new Date());
    return {
      code: "payment_certificate_not_expiring",
      severity: "critical",
      passed: total === 0,
      message:
        total === 0
          ? "No configured payment certificate is expired or near expiry"
          : "At least one configured payment certificate is expired or near expiry",
      evidence: { certificateExpiringCount: total },
    };
  }

  private async checkRecentWebhookFailures(): Promise<PaymentOpsCheck> {
    const from = new Date(
      Date.now() - this.config.paymentAlertWindowMinutes * 60_000,
    );
    const [row] = await this.db
      .select({ total: count() })
      .from(paymentWebhookAttempts)
      .where(
        and(
          sql`${paymentWebhookAttempts.createdAt} >= ${from}`,
          sql`${paymentWebhookAttempts.signatureValid} = false or ${paymentWebhookAttempts.businessValid} = false`,
        ),
      );

    const total = Number(row.total);
    return {
      code: "recent_webhook_failures",
      severity: total === 0 ? "info" : "critical",
      passed: total === 0,
      message:
        total === 0
          ? "No recent webhook verification failures"
          : "Recent webhook failures exist",
      evidence: {
        count: total,
        windowMinutes: this.config.paymentAlertWindowMinutes,
      },
    };
  }

  private async checkRecentReconciliationFailures(): Promise<PaymentOpsCheck> {
    const from = new Date(
      Date.now() - this.config.paymentAlertWindowMinutes * 60_000,
    );
    const [row] = await this.db
      .select({ total: count() })
      .from(paymentReconciliationAttempts)
      .where(
        and(
          sql`${paymentReconciliationAttempts.createdAt} >= ${from}`,
          sql`${paymentReconciliationAttempts.status} in ('network_error', 'config_error', 'max_attempts_exceeded')`,
        ),
      );

    const total = Number(row.total);
    return {
      code: "recent_reconciliation_failures",
      severity: total === 0 ? "info" : "critical",
      passed: total === 0,
      message:
        total === 0
          ? "No recent reconciliation failures"
          : "Recent reconciliation failures exist",
      evidence: {
        count: total,
        windowMinutes: this.config.paymentAlertWindowMinutes,
      },
    };
  }

  private async checkRefundBacklog(): Promise<PaymentOpsCheck> {
    const overdueBefore = new Date(Date.now() - 30 * 60_000);
    const [row] = await this.db
      .select({ total: count() })
      .from(refunds)
      .where(
        sql`${refunds.status} = 'failed' or (${refunds.status} = 'processing' and ${refunds.updatedAt} < ${overdueBefore})`,
      );

    const total = Number(row.total);
    return {
      code: "refund_backlog_clear",
      severity: total === 0 ? "info" : "critical",
      passed: total === 0,
      message:
        total === 0
          ? "No failed or overdue processing refunds"
          : "Refund backlog requires handling",
      evidence: { count: total },
    };
  }

  private async countExpiringCertificates(now: Date): Promise<number> {
    const warningAfter = new Date(
      now.getTime() +
        this.config.paymentCertificateExpiryWarningDays * 24 * 60 * 60 * 1000,
    );

    const rows = await this.db
      .select({
        configEncryptedJson: paymentProviderConfigs.configEncryptedJson,
        updatedAt: paymentProviderConfigs.updatedAt,
      })
      .from(paymentProviderConfigs)
      .where(eq(paymentProviderConfigs.status, "enabled"));

    return rows.reduce((total, row) => {
      try {
        if (!isEncryptedJson(row.configEncryptedJson)) return total;
        const decrypted = this.paymentConfigSecrets.decrypt(
          row.configEncryptedJson,
        );
        const summary = this.paymentConfigSecrets.summarize(
          decrypted,
          row.updatedAt,
        );
        const hasExpiring = Object.values(summary).some((item) => {
          if (!item.certificateExpiresAt) return false;
          return (
            new Date(item.certificateExpiresAt).getTime() <=
            warningAfter.getTime()
          );
        });
        return total + (hasExpiring ? 1 : 0);
      } catch {
        return total + 1;
      }
    }, 0);
  }
}
