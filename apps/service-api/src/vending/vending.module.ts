import { Module } from "@nestjs/common";

import { MqttModule } from "../mqtt/mqtt.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { VendingController } from "./vending.controller";
import { VendingService } from "./vending.service";

@Module({
  imports: [MqttModule, NotificationsModule],
  controllers: [VendingController],
  providers: [VendingService],
  exports: [VendingService],
})
export class VendingModule {}
