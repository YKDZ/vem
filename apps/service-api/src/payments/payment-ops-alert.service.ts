import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from "@nestjs/common";
import { type DrizzleClient } from "@vem/db";

import { DRIZZLE_CLIENT } from "../database/database.constants";
import { NotificationsService } from "../notifications/notifications.service";
import { PaymentOpsService } from "./payment-ops.service";

const ALERT_INTERVAL_MS = 60_000;

@Injectable()
export class PaymentOpsAlertService
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(PaymentOpsAlertService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient,
    private readonly ops: PaymentOpsService,
    private readonly notificationsService: NotificationsService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.scan().catch((error: unknown) => {
        this.logger.warn(
          `payment ops alert scan failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }, ALERT_INTERVAL_MS);
  }

  onApplicationShutdown(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async scan(): Promise<void> {
    const [readiness, metrics] = await Promise.all([
      this.ops.getReadiness(),
      this.ops.getMetrics(),
    ]);

    await this.db.transaction(async (tx) => {
      for (const check of readiness.checks) {
        if (check.severity !== "critical" || check.passed) continue;
        await this.notificationsService.createOperationalNotification(tx, {
          type: "payment_provider_unready",
          title: `支付上线门禁失败：${check.code}`,
          content: check.message,
          severity: "critical",
          resourceType: "payment_ops_check",
          dedupeKey: `payment_ops_check:${check.code}`,
        });
      }

      if (metrics.webhookSignatureInvalidCount > 0) {
        await this.notificationsService.createOperationalNotification(tx, {
          type: "payment_webhook_invalid",
          title: "支付 webhook 验签失败",
          content: `${metrics.windowMinutes} 分钟内验签失败 ${metrics.webhookSignatureInvalidCount} 次`,
          severity: "critical",
          resourceType: "payment_webhook_attempts",
          dedupeKey: `payment_webhook_invalid:${metrics.measuredAt.slice(0, 13)}`,
        });
      }

      if (metrics.reconciliationErrorCount > 0) {
        await this.notificationsService.createOperationalNotification(tx, {
          type: "payment_reconciliation_failed",
          title: "支付对账失败",
          content: `${metrics.windowMinutes} 分钟内对账失败 ${metrics.reconciliationErrorCount} 次`,
          severity: "critical",
          resourceType: "payment_reconciliation_attempts",
          dedupeKey: `payment_reconciliation_failed:${metrics.measuredAt.slice(0, 13)}`,
        });
      }

      if (metrics.refundFailedCount + metrics.refundProcessingOverdueCount > 0) {
        await this.notificationsService.createOperationalNotification(tx, {
          type: "payment_refund_failed",
          title: "退款异常",
          content: `失败退款 ${metrics.refundFailedCount} 笔，超时处理中退款 ${metrics.refundProcessingOverdueCount} 笔`,
          severity: "critical",
          resourceType: "refunds",
          dedupeKey: `payment_refund_failed:${metrics.measuredAt.slice(0, 13)}`,
        });
      }

      if (metrics.certificateExpiringCount > 0) {
        await this.notificationsService.createOperationalNotification(tx, {
          type: "payment_certificate_expiring",
          title: "支付证书临期或解析失败",
          content: `存在 ${metrics.certificateExpiringCount} 条启用配置的证书临期、过期或解析失败`,
          severity: "critical",
          resourceType: "payment_provider_config",
          dedupeKey: "payment_certificate_expiring",
        });
      }
    });
  }
}
