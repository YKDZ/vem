import { Module } from "@nestjs/common";

import { ConfigModule } from "../config/config.module";
import { InventoryModule } from "../inventory/inventory.module";
import { MachineAuthModule } from "../machine-auth/machine-auth.module";
import { PaymentProvidersModule } from "../payments/payment-providers.module";
import { PaymentsModule } from "../payments/payments.module";
import { RefundsModule } from "../refunds/refunds.module";
import { MachineOrdersController } from "./machine-orders.controller";
import { OrdersController } from "./orders.controller";
import { OrdersService } from "./orders.service";

@Module({
  imports: [
    ConfigModule,
    InventoryModule,
    PaymentsModule,
    PaymentProvidersModule,
    MachineAuthModule,
    RefundsModule,
  ],
  controllers: [OrdersController, MachineOrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
