import { Module } from "@nestjs/common";

import { HardwareErrorPoliciesModule } from "../hardware-error-policies/hardware-error-policies.module";
import { MachineAuthModule } from "../machine-auth/machine-auth.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { RefundsModule } from "../refunds/refunds.module";
import { InventoryController } from "./inventory.controller";
import { InventoryService } from "./inventory.service";
import { MachineStockMovementsController } from "./machine-stock-movements.controller";
import { MachineStockMovementsRepository } from "./machine-stock-movements.repository";
import { MachineStockMovementsService } from "./machine-stock-movements.service";

@Module({
  imports: [
    NotificationsModule,
    HardwareErrorPoliciesModule,
    MachineAuthModule,
    RefundsModule,
  ],
  controllers: [InventoryController, MachineStockMovementsController],
  providers: [
    InventoryService,
    MachineStockMovementsService,
    MachineStockMovementsRepository,
  ],
  exports: [InventoryService, MachineStockMovementsService],
})
export class InventoryModule {}
