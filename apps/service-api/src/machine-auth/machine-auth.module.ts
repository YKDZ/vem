import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";

import { ConfigModule } from "../config/config.module";
import { MachineAuthController } from "./machine-auth.controller";
import { MachineAuthGuard } from "./machine-auth.guard";
import { MachineAuthService } from "./machine-auth.service";
import { MachineCredentialService } from "./machine-credential.service";

@Module({
  imports: [ConfigModule, JwtModule.register({})],
  controllers: [MachineAuthController],
  providers: [MachineAuthService, MachineAuthGuard, MachineCredentialService],
  exports: [MachineAuthService, MachineAuthGuard, MachineCredentialService],
})
export class MachineAuthModule {}
