import { Module } from "@nestjs/common";

import { MachineAuthModule } from "../machine-auth/machine-auth.module";
import { MachinesController } from "./machines.controller";
import { MachinesService } from "./machines.service";

@Module({
  imports: [MachineAuthModule],
  controllers: [MachinesController],
  providers: [MachinesService],
  exports: [MachinesService],
})
export class MachinesModule {}
