import { Module } from "@nestjs/common";

import { HardwareErrorPoliciesModule } from "../hardware-error-policies/hardware-error-policies.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { InventoryController } from "./inventory.controller";
import { InventoryService } from "./inventory.service";

@Module({
  imports: [NotificationsModule, HardwareErrorPoliciesModule],
  controllers: [InventoryController],
  providers: [InventoryService],
  exports: [InventoryService],
})
export class InventoryModule {}
