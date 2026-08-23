import { Body, Controller } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import {
  adminListHardwareErrorPoliciesContract,
  adminUpsertHardwareErrorPolicyContract,
  type AdminUpsertHardwareErrorPolicyRequest,
} from "@vem/shared";

import type { AuthenticatedAdmin } from "../common/request-user";

import { RequirePermissions } from "../access/permissions.decorator";
import { CurrentAdmin } from "../auth/current-admin.decorator";
import { AdminEndpointContract } from "../common/admin-endpoint-contract.decorator";
import { HardwareErrorPoliciesService } from "./hardware-error-policies.service";

@ApiTags("hardware-error-policies")
@ApiBearerAuth()
@Controller()
export class HardwareErrorPoliciesController {
  constructor(
    private readonly hardwareErrorPoliciesService: HardwareErrorPoliciesService,
  ) {}

  @RequirePermissions("hardwareErrorPolicies.read")
  @AdminEndpointContract(adminListHardwareErrorPoliciesContract)
  async listPolicies() {
    return this.hardwareErrorPoliciesService.listPolicies();
  }

  @RequirePermissions("hardwareErrorPolicies.write")
  @AdminEndpointContract(adminUpsertHardwareErrorPolicyContract)
  async upsertPolicy(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Body() body: AdminUpsertHardwareErrorPolicyRequest,
  ) {
    return this.hardwareErrorPoliciesService.upsertPolicy(admin.id, body);
  }
}
