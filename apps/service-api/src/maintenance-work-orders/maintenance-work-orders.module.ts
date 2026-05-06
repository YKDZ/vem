import { Module } from "@nestjs/common";

import { DatabaseModule } from "../database/database.module";
import { MaintenanceWorkOrdersController } from "./maintenance-work-orders.controller";
import { MaintenanceWorkOrdersService } from "./maintenance-work-orders.service";

@Module({
  imports: [DatabaseModule],
  controllers: [MaintenanceWorkOrdersController],
  providers: [MaintenanceWorkOrdersService],
  exports: [MaintenanceWorkOrdersService],
})
export class MaintenanceWorkOrdersModule {}
