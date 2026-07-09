import { Body, Controller, Get, Post } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import {
  upsertHardwareErrorPolicySchema,
  type AdminUpsertHardwareErrorPolicyRequest,
} from "@vem/shared";

import type { AuthenticatedAdmin } from "../common/request-user";

import { RequirePermissions } from "../access/permissions.decorator";
import { CurrentAdmin } from "../auth/current-admin.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { HardwareErrorPoliciesService } from "./hardware-error-policies.service";

@ApiTags("hardware-error-policies")
@ApiBearerAuth()
@Controller("hardware-error-policies")
export class HardwareErrorPoliciesController {
  constructor(
    private readonly hardwareErrorPoliciesService: HardwareErrorPoliciesService,
  ) {}

  @Get()
  @RequirePermissions("hardwareErrorPolicies.read")
  async listPolicies() {
    return this.hardwareErrorPoliciesService.listPolicies();
  }

  @Post()
  @RequirePermissions("hardwareErrorPolicies.write")
  async upsertPolicy(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Body(new ZodValidationPipe(upsertHardwareErrorPolicySchema))
    body: AdminUpsertHardwareErrorPolicyRequest,
  ) {
    return this.hardwareErrorPoliciesService.upsertPolicy(admin.id, body);
  }
}
