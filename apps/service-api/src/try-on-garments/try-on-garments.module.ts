import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import { AdminContractRequestValidationInterceptor } from "../common/admin-endpoint-contract.decorator";
import { TryOnGarmentsController } from "./try-on-garments.controller";
import { TryOnGarmentsService } from "./try-on-garments.service";

@Module({
  imports: [AuditModule],
  controllers: [TryOnGarmentsController],
  providers: [TryOnGarmentsService, AdminContractRequestValidationInterceptor],
})
export class TryOnGarmentsModule {}
