import { Module } from "@nestjs/common";

import { DatabaseModule } from "../database/database.module";
import { MachineAuthModule } from "../machine-auth/machine-auth.module";
import { MachineOpsController } from "./machine-ops.controller";
import { MachineOpsService } from "./machine-ops.service";

@Module({
  imports: [DatabaseModule, MachineAuthModule],
  controllers: [MachineOpsController],
  providers: [MachineOpsService],
  exports: [MachineOpsService],
})
export class MachineOpsModule {}
