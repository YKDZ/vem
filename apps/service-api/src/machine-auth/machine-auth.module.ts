import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";

import { ConfigModule } from "../config/config.module";
import { MachineAuthController } from "./machine-auth.controller";
import { MachineAuthGuard } from "./machine-auth.guard";
import { MachineAuthService } from "./machine-auth.service";

@Module({
  imports: [ConfigModule, JwtModule.register({})],
  controllers: [MachineAuthController],
  providers: [MachineAuthService, MachineAuthGuard],
  exports: [MachineAuthService, MachineAuthGuard],
})
export class MachineAuthModule {}
