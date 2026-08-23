import { Body, Controller, Param, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import {
  adminCreateRoleContract,
  adminListPermissionCodesContract,
  adminListRolesContract,
  adminUpdateRoleContract,
  type AdminCreateRoleRequest,
  type AdminRoleListQuery,
  type AdminUpdateRoleRequest,
} from "@vem/shared";

import type { AuthenticatedAdmin } from "../common/request-user";

import {
  RequireAnyPermission,
  RequirePermissions,
} from "../access/permissions.decorator";
import { CurrentAdmin } from "../auth/current-admin.decorator";
import { AdminEndpointContract } from "../common/admin-endpoint-contract.decorator";
import { RolesService } from "./roles.service";

@ApiTags("roles")
@ApiBearerAuth()
@Controller()
export class RolesController {
  constructor(private readonly rolesService: RolesService) {}

  @RequireAnyPermission("roles.write", "adminUsers.write")
  @AdminEndpointContract(adminListRolesContract)
  async list(@Query() query: AdminRoleListQuery) {
    return await this.rolesService.list(query);
  }

  @RequirePermissions("roles.write")
  @AdminEndpointContract(adminCreateRoleContract)
  async create(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Body() body: AdminCreateRoleRequest,
  ) {
    return await this.rolesService.create(admin.id, body);
  }

  @RequirePermissions("roles.write")
  @AdminEndpointContract(adminUpdateRoleContract)
  async update(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param() params: { id: string },
    @Body() body: AdminUpdateRoleRequest,
  ) {
    return await this.rolesService.update(admin.id, params.id, body);
  }

  @RequirePermissions("roles.write")
  @AdminEndpointContract(adminListPermissionCodesContract)
  getPermissions() {
    return this.rolesService.getPermissionCodes();
  }
}
