import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import { HardwareErrorPoliciesModule } from "../hardware-error-policies/hardware-error-policies.module";
import { MachineAuthModule } from "../machine-auth/machine-auth.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { RefundsModule } from "../refunds/refunds.module";
import { InventoryController } from "./inventory.controller";
import { InventoryService } from "./inventory.service";
import { MachineStockMovementsController } from "./machine-stock-movements.controller";
import { MachineStockMovementsRepository } from "./machine-stock-movements.repository";
import { MachineStockMovementsService } from "./machine-stock-movements.service";
import { StockReconciliationController } from "./stock-reconciliation.controller";
import {
  DrizzleStockReconciliationRepository,
  StockReconciliationRepository,
} from "./stock-reconciliation.repository";
import { StockReconciliationService } from "./stock-reconciliation.service";

@Module({
  imports: [
    AuditModule,
    NotificationsModule,
    HardwareErrorPoliciesModule,
    MachineAuthModule,
    RefundsModule,
  ],
  controllers: [
    InventoryController,
    MachineStockMovementsController,
    StockReconciliationController,
  ],
  providers: [
    InventoryService,
    MachineStockMovementsService,
    MachineStockMovementsRepository,
    StockReconciliationService,
    {
      provide: StockReconciliationRepository,
      useClass: DrizzleStockReconciliationRepository,
    },
  ],
  exports: [
    InventoryService,
    MachineStockMovementsService,
    StockReconciliationService,
  ],
})
export class InventoryModule {}
