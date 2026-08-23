import { Controller, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import {
  adminListAuditLogsContract,
  auditLogQuerySchema,
  pageQuerySchema,
} from "@vem/shared";
import { z } from "zod";

import { RequirePermissions } from "../access/permissions.decorator";
import { AdminEndpointContract } from "../common/admin-endpoint-contract.decorator";
import { AuditService } from "./audit.service";

type AuditLogQuery = z.infer<typeof auditLogQuerySchema> &
  z.infer<typeof pageQuerySchema>;

@ApiTags("audit")
@ApiBearerAuth()
@Controller()
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @RequirePermissions("audit.read")
  @AdminEndpointContract(adminListAuditLogsContract)
  async list(@Query() query: AuditLogQuery) {
    return await this.auditService.list(query);
  }
}
