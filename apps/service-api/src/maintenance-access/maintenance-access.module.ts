import { Module } from "@nestjs/common";

import { ConfigModule } from "../config/config.module";
import { DatabaseModule } from "../database/database.module";
import { MaintenanceAccessController } from "./maintenance-access.controller";
import { MaintenanceAccessService } from "./maintenance-access.service";

@Module({
  imports: [ConfigModule, DatabaseModule],
  controllers: [MaintenanceAccessController],
  providers: [MaintenanceAccessService],
  exports: [MaintenanceAccessService],
})
export class MaintenanceAccessModule {}
