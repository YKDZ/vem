import { Module } from "@nestjs/common";

import { InventoryModule } from "../inventory/inventory.module";
import { MaintenanceWorkOrdersModule } from "../maintenance-work-orders/maintenance-work-orders.module";
import { MqttModule } from "../mqtt/mqtt.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { RefundsModule } from "../refunds/refunds.module";
import { VendingController } from "./vending.controller";
import { VendingService } from "./vending.service";

@Module({
  imports: [
    MqttModule,
    NotificationsModule,
    InventoryModule,
    RefundsModule,
    MaintenanceWorkOrdersModule,
  ],
  controllers: [VendingController],
  providers: [VendingService],
  exports: [VendingService],
})
export class VendingModule {}
