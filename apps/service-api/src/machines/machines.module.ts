import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import { ConfigModule } from "../config/config.module";
import { MachineAuthModule } from "../machine-auth/machine-auth.module";
import { MqttModule } from "../mqtt/mqtt.module";
import { MachinesController } from "./machines.controller";
import { MachinesService } from "./machines.service";

@Module({
  imports: [MachineAuthModule, AuditModule, MqttModule, ConfigModule],
  controllers: [MachinesController],
  providers: [MachinesService],
  exports: [MachinesService],
})
export class MachinesModule {}
