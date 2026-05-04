import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { ConfigModule } from "../config/config.module";
import { BootstrapService } from "./bootstrap.service";

@Module({
  imports: [AuthModule, ConfigModule],
  providers: [BootstrapService],
})
export class BootstrapModule {}
