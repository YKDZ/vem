import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import { TryOnGarmentsController } from "./try-on-garments.controller";
import { TryOnGarmentsService } from "./try-on-garments.service";

@Module({
  imports: [AuditModule],
  controllers: [TryOnGarmentsController],
  providers: [TryOnGarmentsService],
})
export class TryOnGarmentsModule {}
