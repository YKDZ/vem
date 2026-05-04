import { Module } from "@nestjs/common";

import { ConfigModule } from "../config/config.module";
import { InventoryModule } from "../inventory/inventory.module";
import { VendingModule } from "../vending/vending.module";
import { MockPaymentProvider } from "./mock-payment.provider";
import { PaymentsController } from "./payments.controller";
import { PaymentsService } from "./payments.service";

@Module({
  imports: [ConfigModule, InventoryModule, VendingModule],
  controllers: [PaymentsController],
  providers: [PaymentsService, MockPaymentProvider],
  exports: [PaymentsService, MockPaymentProvider],
})
export class PaymentsModule {}
