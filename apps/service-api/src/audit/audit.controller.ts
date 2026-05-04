import { Controller, Get, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { auditLogQuerySchema, pageQuerySchema } from "@vem/shared";
import { z } from "zod";

import { RequirePermissions } from "../access/permissions.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { AuditService } from "./audit.service";

type AuditLogQuery = z.infer<typeof auditLogQuerySchema> &
  z.infer<typeof pageQuerySchema>;

const auditLogListQuerySchema = auditLogQuerySchema.extend(
  pageQuerySchema.shape,
);

@ApiTags("audit")
@ApiBearerAuth()
@Controller("audit-logs")
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @RequirePermissions("audit.read")
  @Get()
  async list(
    @Query(new ZodValidationPipe(auditLogListQuerySchema))
    query: AuditLogQuery,
  ) {
    return await this.auditService.list(query);
  }
}
