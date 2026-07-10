import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import {
  createHumanMaintenanceSessionRequestSchema,
  issueMaintenanceSshCertificateRequestSchema,
  maintenanceAccessAuditListQuerySchema,
  maintenanceSessionListQuerySchema,
} from "@vem/shared";

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

  @Get("audit")
  @RequirePermissions("maintenanceAccess.read")
  async listAudit(
    @Query(new ZodValidationPipe(maintenanceAccessAuditListQuerySchema))
    query: ReturnType<typeof maintenanceAccessAuditListQuerySchema.parse>,
  ) {
    return await this.service.listAudit(query);
  }

  @Get("sessions")
  @RequirePermissions("maintenanceAccess.read")
  async listSessions(
    @Query(new ZodValidationPipe(maintenanceSessionListQuerySchema))
    query: ReturnType<typeof maintenanceSessionListQuerySchema.parse>,
  ) {
    return await this.service.listSessions(query);
  }

  @Post("sessions")
  @RequirePermissions("maintenanceAccess.write")
  async createSession(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Body(new ZodValidationPipe(createHumanMaintenanceSessionRequestSchema))
    body: ReturnType<typeof createHumanMaintenanceSessionRequestSchema.parse>,
  ) {
    return await this.service.createHumanSession(admin.id, body);
  }

  @Post("sessions/:sessionId/revoke")
  @RequirePermissions("maintenanceAccess.write")
  async revokeSession(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param("sessionId") sessionId: string,
  ) {
    return await this.service.revokeSession(admin.id, sessionId);
  }

  @Post("sessions/:sessionId/ssh-certificate")
  @RequirePermissions("maintenanceAccess.write")
  async issueSshCertificate(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param("sessionId") sessionId: string,
    @Body(new ZodValidationPipe(issueMaintenanceSshCertificateRequestSchema))
    body: ReturnType<typeof issueMaintenanceSshCertificateRequestSchema.parse>,
  ) {
    return await this.service.issueSshCertificateForHumanSession(
      admin.id,
      sessionId,
      body,
    );
  }
}
