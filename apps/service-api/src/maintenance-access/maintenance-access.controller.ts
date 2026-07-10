import { Body, Controller, Get, Post } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { createMaintenanceSessionRequestSchema } from "@vem/shared";

import type { AuthenticatedAdmin } from "../common/request-user";

import { RequirePermissions } from "../access/permissions.decorator";
import { CurrentAdmin } from "../auth/current-admin.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { MaintenanceAccessService } from "./maintenance-access.service";

@ApiTags("maintenance-access")
@ApiBearerAuth()
@Controller("maintenance-access")
export class MaintenanceAccessController {
  constructor(private readonly service: MaintenanceAccessService) {}

  @Get()
  @RequirePermissions("maintenanceAccess.read")
  async getOverview() {
    return await this.service.getOverview();
  }

  @Post("sessions")
  @RequirePermissions("maintenanceAccess.write")
  async createSession(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Body(new ZodValidationPipe(createMaintenanceSessionRequestSchema))
    body: ReturnType<typeof createMaintenanceSessionRequestSchema.parse>,
  ) {
    return await this.service.createSession(admin.id, body);
  }
}
