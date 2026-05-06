import { Module } from "@nestjs/common";

import { DatabaseModule } from "../database/database.module";
import { HardwareErrorPoliciesController } from "./hardware-error-policies.controller";
import { HardwareErrorPoliciesService } from "./hardware-error-policies.service";

@Module({
  imports: [DatabaseModule],
  controllers: [HardwareErrorPoliciesController],
  providers: [HardwareErrorPoliciesService],
  exports: [HardwareErrorPoliciesService],
})
export class HardwareErrorPoliciesModule {}
