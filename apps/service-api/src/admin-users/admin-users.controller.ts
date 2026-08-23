import { Body, Controller, Param, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import {
  adminCreateAdminUserContract,
  adminListAdminUsersContract,
  adminUpdateAdminUserContract,
  type AdminCreateUserRequest,
  type AdminUpdateUserRequest,
  type AdminUserListQuery,
} from "@vem/shared";

import type { AuthenticatedAdmin } from "../common/request-user";

import { RequirePermissions } from "../access/permissions.decorator";
import { CurrentAdmin } from "../auth/current-admin.decorator";
import { AdminEndpointContract } from "../common/admin-endpoint-contract.decorator";
import { AdminUsersService } from "./admin-users.service";

@ApiTags("admin-users")
@ApiBearerAuth()
@Controller()
export class AdminUsersController {
  constructor(private readonly adminUsersService: AdminUsersService) {}

  @RequirePermissions("adminUsers.read")
  @AdminEndpointContract(adminListAdminUsersContract)
  async list(@Query() query: AdminUserListQuery) {
    return await this.adminUsersService.list(query);
  }

  @RequirePermissions("adminUsers.write")
  @AdminEndpointContract(adminCreateAdminUserContract)
  async create(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Body() body: AdminCreateUserRequest,
  ) {
    return await this.adminUsersService.create(admin.id, body);
  }

  @RequirePermissions("adminUsers.write")
  @AdminEndpointContract(adminUpdateAdminUserContract)
  async update(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param() params: { id: string },
    @Body() body: AdminUpdateUserRequest,
  ) {
    return await this.adminUsersService.update(admin.id, params.id, body);
  }
}
