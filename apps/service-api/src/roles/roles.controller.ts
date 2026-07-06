import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import {
  createRoleSchema,
  roleListQuerySchema,
  type AdminCreateRoleRequest,
  type AdminRoleListQuery,
  type AdminUpdateRoleRequest,
  updateRoleSchema,
} from "@vem/shared";

import type { AuthenticatedAdmin } from "../common/request-user";

import {
  RequireAnyPermission,
  RequirePermissions,
} from "../access/permissions.decorator";
import { CurrentAdmin } from "../auth/current-admin.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { RolesService } from "./roles.service";

@ApiTags("roles")
@ApiBearerAuth()
@Controller()
export class RolesController {
  constructor(private readonly rolesService: RolesService) {}

  @RequireAnyPermission("roles.write", "adminUsers.write")
  @Get("roles")
  async list(
    @Query(new ZodValidationPipe(roleListQuerySchema))
    query: AdminRoleListQuery,
  ) {
    return await this.rolesService.list(query);
  }

  @RequirePermissions("roles.write")
  @Post("roles")
  async create(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Body(new ZodValidationPipe(createRoleSchema))
    body: AdminCreateRoleRequest,
  ) {
    return await this.rolesService.create(admin.id, body);
  }

  @RequirePermissions("roles.write")
  @Patch("roles/:id")
  async update(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateRoleSchema))
    body: AdminUpdateRoleRequest,
  ) {
    return await this.rolesService.update(admin.id, id, body);
  }

  @RequirePermissions("roles.write")
  @Get("permissions")
  getPermissions() {
    return this.rolesService.getPermissionCodes();
  }
}
