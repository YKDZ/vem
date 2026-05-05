import { Module } from "@nestjs/common";

import { InventoryModule } from "../inventory/inventory.module";
import { MqttModule } from "../mqtt/mqtt.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { RefundsModule } from "../refunds/refunds.module";
import { VendingController } from "./vending.controller";
import { VendingService } from "./vending.service";

@Module({
  imports: [MqttModule, NotificationsModule, InventoryModule, RefundsModule],
  controllers: [VendingController],
  providers: [VendingService],
  exports: [VendingService],
})
export class VendingModule {}
