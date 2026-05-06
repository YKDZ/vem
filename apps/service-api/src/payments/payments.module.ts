import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import { ConfigModule } from "../config/config.module";
import { InventoryModule } from "../inventory/inventory.module";
import { VendingModule } from "../vending/vending.module";
import { PaymentProvidersModule } from "./payment-providers.module";
import { PaymentReconciliationService } from "./payment-reconciliation.service";
import { PaymentsController } from "./payments.controller";
import { PaymentsService } from "./payments.service";

@Module({
  imports: [
    AuditModule,
    ConfigModule,
    InventoryModule,
    VendingModule,
    PaymentProvidersModule,
  ],
  controllers: [PaymentsController],
  providers: [PaymentsService, PaymentReconciliationService],
  exports: [PaymentsService, PaymentProvidersModule],
})
export class PaymentsModule {}
