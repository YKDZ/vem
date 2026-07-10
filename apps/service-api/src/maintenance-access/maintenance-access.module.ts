import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";

import { ConfigModule } from "../config/config.module";
import { DatabaseModule } from "../database/database.module";
import { MaintenanceAccessController } from "./maintenance-access.controller";
import { MaintenanceAccessService } from "./maintenance-access.service";
import { MaintenanceRelayAuthService } from "./maintenance-relay-auth.service";
import { MaintenanceRelayController } from "./maintenance-relay.controller";
import {
  MAINTENANCE_LIFECYCLE_CLOCK,
  MAINTENANCE_LIFECYCLE_INTERVAL,
  MaintenanceSessionLifecycleSweeper,
  systemMaintenanceLifecycleClock,
  systemMaintenanceLifecycleInterval,
} from "./maintenance-session-lifecycle.sweeper";

@Module({
  imports: [ConfigModule, DatabaseModule, JwtModule.register({})],
  controllers: [MaintenanceAccessController, MaintenanceRelayController],
  providers: [
    MaintenanceAccessService,
    MaintenanceRelayAuthService,
    MaintenanceSessionLifecycleSweeper,
    {
      provide: MAINTENANCE_LIFECYCLE_CLOCK,
      useValue: systemMaintenanceLifecycleClock,
    },
    {
      provide: MAINTENANCE_LIFECYCLE_INTERVAL,
      useValue: systemMaintenanceLifecycleInterval,
    },
  ],
  exports: [MaintenanceAccessService],
})
export class MaintenanceAccessModule {}
