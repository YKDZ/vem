import { Module } from "@nestjs/common";

import { ConfigModule } from "../config/config.module";
import { InventoryModule } from "../inventory/inventory.module";
import { VendingModule } from "../vending/vending.module";
import { PaymentProvidersModule } from "./payment-providers.module";
import { PaymentsController } from "./payments.controller";
import { PaymentsService } from "./payments.service";

@Module({
  imports: [
    ConfigModule,
    InventoryModule,
    VendingModule,
    PaymentProvidersModule,
  ],
  controllers: [PaymentsController],
  providers: [PaymentsService],
  exports: [PaymentsService, PaymentProvidersModule],
})
export class PaymentsModule {}
