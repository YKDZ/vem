import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import { ConfigModule } from "../config/config.module";
import { InventoryModule } from "../inventory/inventory.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { RefundsModule } from "../refunds/refunds.module";
import { VendingModule } from "../vending/vending.module";
import { PaymentOpsAlertService } from "./payment-ops-alert.service";
import { PaymentOpsController } from "./payment-ops.controller";
import { PaymentOpsService } from "./payment-ops.service";
import { PaymentProvidersModule } from "./payment-providers.module";
import { PaymentReadinessStartupGateService } from "./payment-readiness-startup-gate.service";
import { PaymentReconciliationService } from "./payment-reconciliation.service";
import { PaymentWebhookAttemptRecorderService } from "./payment-webhook-attempt-recorder.service";
import { PaymentsController } from "./payments.controller";
import { PaymentsService } from "./payments.service";

@Module({
  imports: [
    AuditModule,
    ConfigModule,
    InventoryModule,
    VendingModule,
    PaymentProvidersModule,
    NotificationsModule,
    RefundsModule,
  ],
  controllers: [PaymentsController, PaymentOpsController],
  providers: [
    PaymentsService,
    PaymentReconciliationService,
    PaymentWebhookAttemptRecorderService,
    PaymentOpsService,
    PaymentOpsAlertService,
    PaymentReadinessStartupGateService,
  ],
  exports: [
    PaymentsService,
    PaymentProvidersModule,
    PaymentWebhookAttemptRecorderService,
    PaymentOpsService,
  ],
})
export class PaymentsModule {}


