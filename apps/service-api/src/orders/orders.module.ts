import { Module } from "@nestjs/common";

import { InventoryModule } from "../inventory/inventory.module";
import { PaymentsModule } from "../payments/payments.module";
import { MachineOrdersController } from "./machine-orders.controller";
import { OrdersController } from "./orders.controller";
import { OrdersService } from "./orders.service";

@Module({
  imports: [InventoryModule, PaymentsModule],
  controllers: [OrdersController, MachineOrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
