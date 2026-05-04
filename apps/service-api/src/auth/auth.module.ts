import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";

import { AccessModule } from "../access/access.module";
import { ConfigModule } from "../config/config.module";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { JwtAuthGuard } from "./jwt-auth.guard";
import { PasswordService } from "./password.service";

@Module({
  imports: [JwtModule.register({}), AccessModule, ConfigModule],
  controllers: [AuthController],
  providers: [AuthService, PasswordService, JwtAuthGuard],
  exports: [AuthService, PasswordService, JwtAuthGuard, JwtModule],
})
export class AuthModule {}
