import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import { ConfigModule } from "../config/config.module";
import { InventoryModule } from "../inventory/inventory.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { RefundsModule } from "../refunds/refunds.module";
import { VendingModule } from "../vending/vending.module";
import { PaymentChannelPolicyService } from "./payment-channel-policy.service";
import { PaymentCodeAttemptsService } from "./payment-code-attempts.service";
import { PaymentCodeOrchestratorService } from "./payment-code-orchestrator.service";
import { PaymentCodeController } from "./payment-code.controller";
import { PaymentDrillsController } from "./payment-drills.controller";
import {
  DrizzlePaymentDrillStore,
  PaymentDrillsService,
} from "./payment-drills.service";
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
  controllers: [
    PaymentsController,
    PaymentOpsController,
    PaymentCodeController,
    PaymentDrillsController,
  ],
  providers: [
    PaymentsService,
    DrizzlePaymentDrillStore,
    PaymentDrillsService,
    PaymentReconciliationService,
    PaymentWebhookAttemptRecorderService,
    PaymentOpsService,
    PaymentOpsAlertService,
    PaymentChannelPolicyService,
    PaymentReadinessStartupGateService,
    PaymentCodeAttemptsService,
    PaymentCodeOrchestratorService,
  ],
  exports: [
    PaymentsService,
    PaymentProvidersModule,
    PaymentWebhookAttemptRecorderService,
    PaymentOpsService,
    PaymentChannelPolicyService,
    PaymentCodeAttemptsService,
    PaymentCodeOrchestratorService,
  ],
})
export class PaymentsModule {}
