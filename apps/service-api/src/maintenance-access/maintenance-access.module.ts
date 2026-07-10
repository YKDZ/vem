import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";

import { ConfigModule } from "../config/config.module";
import { DatabaseModule } from "../database/database.module";
import { MaintenanceAccessController } from "./maintenance-access.controller";
import { MaintenanceAccessService } from "./maintenance-access.service";
import { MaintenanceRelayAuthService } from "./maintenance-relay-auth.service";
import { MaintenanceRelayController } from "./maintenance-relay.controller";

@Module({
  imports: [ConfigModule, DatabaseModule, JwtModule.register({})],
  controllers: [MaintenanceAccessController, MaintenanceRelayController],
  providers: [MaintenanceAccessService, MaintenanceRelayAuthService],
  exports: [MaintenanceAccessService],
})
export class MaintenanceAccessModule {}
