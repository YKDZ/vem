import { Module } from "@nestjs/common";

import { DatabaseModule } from "../database/database.module";
import { NotificationDeliveryService } from "./notification-delivery.service";
import { NotificationsController } from "./notifications.controller";
import { NotificationsService } from "./notifications.service";

@Module({
  imports: [DatabaseModule],
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationDeliveryService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
